#!/usr/bin/env ruby
# frozen_string_literal: true

# Driver for the ft-spike Worker. Each phase writes spike/results/<phase>.json.
# Parallel fan-out uses one HTTP request (one Worker invocation) per fork, so the
# per-invocation connection limit never queues the forks being measured.
#
#   ruby spike/scripts/spike.rb <phase> [args]
#
# Reads SPIKE_KEY from spike/.dev.vars. Never prints it.
require "json"
require "net/http"
require "uri"
require "fileutils"
require "time"

BASE = ENV.fetch("SPIKE_URL", "https://ft-spike.mattsolt.workers.dev")
ROOT = File.expand_path("..", __dir__)
KEY = File.read(File.join(ROOT, ".dev.vars"))[/^SPIKE_KEY=(.+)$/, 1]
RESULTS = File.join(ROOT, "results")
FileUtils.mkdir_p(RESULTS)

def mono = Process.clock_gettime(Process::CLOCK_MONOTONIC, :millisecond)

def call(path, body = {}, timeout: 300)
  uri = URI.join(BASE, path)
  http = Net::HTTP.new(uri.host, uri.port)
  http.use_ssl = true
  http.read_timeout = timeout
  req = Net::HTTP::Post.new(uri)
  req["x-spike-key"] = KEY
  req["content-type"] = "application/json"
  req.body = JSON.generate(body)
  t0 = mono
  res = http.request(req)
  wall = mono - t0
  data = begin
    JSON.parse(res.body)
  rescue JSON::ParserError
    { "raw" => res.body[0, 500] }
  end
  data.merge("httpStatus" => res.code.to_i, "clientMs" => wall)
end

def save(name, obj)
  File.write(File.join(RESULTS, "#{name}.json"), JSON.pretty_generate(obj))
  warn "saved results/#{name}.json"
end

def pct(xs, p)
  s = xs.compact.sort
  return nil if s.empty?

  s[[(p * s.length).ceil - 1, 0].max]
end

def summary(xs)
  s = xs.compact
  { n: s.length, min: s.min, p50: pct(s, 0.5), p95: pct(s, 0.95), max: s.max }
end

def parallel(items)
  items.map { |it| Thread.new { yield(it) } }.map(&:value)
end

def fork_repo(source, name, extra = {})
  call("/fork", { ns: "a", source: source, name: name }.merge(extra))
end

phase = ARGV.shift
case phase
when "import"
  r = call("/import", { ns: "a", name: "base", url: "https://github.com/sindresorhus/is-plain-obj" })
  save("1-import", r)
  puts JSON.pretty_generate(r)

when "seq"
  rows = (1..8).map do |i|
    r = fork_repo("base", "seq-#{i}")
    warn "seq-#{i}: call=#{r['callMs']} ready=#{r.dig('ready', 'readyMs')} err=#{r.dig('err', 'code')}"
    r
  end
  out = {
    rows: rows,
    callMs: summary(rows.map { |r| r["callMs"] }),
    readyMs: summary(rows.map { |r| r.dig("ready", "readyMs") }),
    failures: rows.count { |r| r["err"] || r["getErr"] || r.dig("ready", "timeout") }
  }
  save("2a-seq-forks", out)
  puts JSON.pretty_generate(out.except(:rows))

when "burst"
  t0 = mono
  rows = parallel((1..8).to_a) { |i| fork_repo("base", "burst-#{i}") }
  wall = mono - t0
  out = {
    wallMs: wall,
    rows: rows,
    ok: rows.count { |r| r["err"].nil? && r["getErr"].nil? && r.dig("ready", "readyMs") },
    errors: rows.filter_map { |r| r["err"] || r["getErr"] }.map { |e| e.slice("code", "numericCode", "message") },
    callMs: summary(rows.map { |r| r["callMs"] }),
    readyMs: summary(rows.map { |r| r.dig("ready", "readyMs") })
  }
  save("2b-burst-forks", out)
  puts JSON.pretty_generate(out.except(:rows))

when "tree"
  existing = ["base"]
  rounds = []
  (1..4).each do |k|
    sources = existing.dup
    t0 = mono
    rows = parallel(sources.each_with_index.to_a) { |src, i| fork_repo(src, "tree-#{k}-#{i + 1}") }
    wall = mono - t0
    ok = rows.select { |r| r["err"].nil? && r["getErr"].nil? && r.dig("ready", "readyMs") }
    existing += ok.map { |r| r["name"] }
    round = {
      round: k, sources: sources.length, attempted: rows.length, ok: ok.length, wallMs: wall,
      callMs: summary(rows.map { |r| r["callMs"] }), readyMs: summary(rows.map { |r| r.dig("ready", "readyMs") }),
      errors: rows.filter_map { |r| r["err"] || r["getErr"] }.map { |e| e.slice("code", "numericCode", "message") },
      rows: rows
    }
    warn "round #{k}: #{ok.length}/#{rows.length} ok, wall=#{wall}ms ready p50=#{round[:readyMs][:p50]} max=#{round[:readyMs][:max]}"
    rounds << round
  end
  save("2c-fork-tree", { rounds: rounds, finalCount: existing.length })
  puts JSON.pretty_generate(rounds.map { |r| r.except(:rows) })

when "git"
  # Measurement 3: computer git clone/commit/push, tree surgery, notes, refs.
  out = {}
  out[:doPing] = 5.times.map { call("/do/ping", { obj: "git-1" })["clientMs"] }
  out[:forks] = parallel(%w[work-1 trunk]) { |n| fork_repo("base", n) }
  d = "/r/work-1"
  out[:clone] = call("/git/clone", { ns: "a", repo: "work-1", dir: d, obj: "git-1" })
  base_head = out[:clone]["head"]
  out[:writeCommit] = call("/git/write-commit", {
    obj: "git-1", dir: d, file: "spike.txt", content: "written by SpikeDO #{Time.now.utc}\n", message: "spike: add spike.txt"
  })
  out[:push] = call("/git/push", { ns: "a", repo: "work-1", dir: d, ref: "main", obj: "git-1" })
  # Parallel forks immediately after a push to the source.
  t0 = mono
  out[:postPushForks] = parallel((1..4).to_a) { |i| fork_repo("work-1", "pp-#{i}") }
  out[:postPushForksWallMs] = mono - t0
  # Tree surgery on the same fs: no working copy, low-level objects only.
  out[:surgery] = call("/git/surgery-build", {
    obj: "git-1", dir: d, baseRef: base_head, path: "readme.md",
    content: "# is-plain-obj\n\nRewritten by FireTrident tree surgery.\n", branch: "surgery",
    message: "trunk: replace readme.md via tree surgery"
  })
  surgery = out[:surgery]["commit"]
  out[:surgeryPush] = call("/git/iso-push", {
    ns: "a", repo: "trunk", dir: d, ref: "refs/heads/surgery", remoteRef: "refs/heads/main", obj: "git-1"
  })
  out[:noteAdd] = call("/git/note-add", {
    obj: "git-1", dir: d, oid: surgery, notesRef: "refs/notes/firetrident",
    note: JSON.generate({ ft: 1, decision: "merged", by: "spike", at: Time.now.utc.iso8601 })
  })
  out[:notePush] = call("/git/iso-push", {
    ns: "a", repo: "trunk", dir: d, ref: "refs/notes/firetrident", remoteRef: "refs/notes/firetrident", obj: "git-1"
  })
  out[:featurePush] = call("/git/iso-push", {
    ns: "a", repo: "trunk", dir: d, ref: "refs/heads/main", remoteRef: "refs/heads/feature-x", obj: "git-1"
  })
  out[:trunkInfo] = call("/info", { ns: "a", repo: "trunk" })
  out[:refForks] = [
    fork_repo("trunk", "fork-allrefs"),
    fork_repo("trunk", "fork-defonly", { defaultBranchOnly: true })
  ]
  save("3a-git", out)
  puts JSON.pretty_generate(out.transform_values { |v| v.is_a?(Hash) ? v.except("rows") : v })

when "race"
  # Measurement 3 (cont.): stale old-oid push, forced non-fast-forward push, readOnly fork push.
  out = {}
  out[:forks] = parallel([["race-1", {}], ["ro-1", { readOnly: true }]]) { |n, o| fork_repo("base", n, o) }
  out[:w1Fetch] = call("/git/init-fetch", { ns: "a", repo: "race-1", dir: "/race/w1", obj: "git-1" })
  out[:w2Fetch] = call("/git/init-fetch", { ns: "a", repo: "race-1", dir: "/race/w2", obj: "git-1" })
  advert = call("/git/advert", { ns: "a", repo: "race-1", obj: "git-1" })
  out[:staleAdvert] = advert.except("b64")
  c1 = call("/git/surgery-build", {
    obj: "git-1", dir: "/race/w1", baseRef: "main", path: "race.txt", content: "writer 1\n", branch: "w1",
    message: "writer 1"
  })
  out[:c1] = c1
  out[:w1Push] = call("/git/iso-push", { ns: "a", repo: "race-1", dir: "/race/w1", ref: "refs/heads/w1", remoteRef: "refs/heads/main", obj: "git-1" })
  out[:afterW1] = call("/info", { ns: "a", repo: "race-1", limit: 3 })
  c2 = call("/git/surgery-build", {
    obj: "git-1", dir: "/race/w2", baseRef: "main", path: "race.txt", content: "writer 2\n", branch: "w2",
    message: "writer 2 (stale base)"
  })
  out[:c2] = c2
  out[:w2StalePush] = call("/git/iso-push", {
    ns: "a", repo: "race-1", dir: "/race/w2", ref: "refs/heads/w2", remoteRef: "refs/heads/main",
    staleAdvertB64: advert["b64"], obj: "git-1"
  })
  out[:afterStale] = call("/info", { ns: "a", repo: "race-1", limit: 3 })
  out[:w2FreshNoForce] = call("/git/iso-push", {
    ns: "a", repo: "race-1", dir: "/race/w2", ref: "refs/heads/w2", remoteRef: "refs/heads/main", obj: "git-1"
  })
  c3 = call("/git/surgery-build", {
    obj: "git-1", dir: "/race/w2", baseRef: "main", path: "race.txt", content: "writer 2 forced\n", branch: "w2f",
    message: "writer 2 forced (non-ff)"
  })
  out[:c3] = c3
  out[:w2ForcePush] = call("/git/iso-push", {
    ns: "a", repo: "race-1", dir: "/race/w2", ref: "refs/heads/w2f", remoteRef: "refs/heads/main", force: true, obj: "git-1"
  })
  out[:afterForce] = call("/info", { ns: "a", repo: "race-1", limit: 3 })
  # readOnly fork: does a write token push succeed?
  out[:roPush] = call("/git/iso-push", { ns: "a", repo: "ro-1", dir: "/race/w1", ref: "refs/heads/w1", remoteRef: "refs/heads/main", obj: "git-1" })
  out[:roInfo] = call("/info", { ns: "a", repo: "ro-1", limit: 2 })
  out[:oids] = { c0: out[:w1Fetch]["fetchHead"], c1: c1["commit"], c2: c2["commit"], c3: c3["commit"] }
  save("3b-race", out)
  puts JSON.pretty_generate(out)

when "trigger"
  # Measurement 4: namespace push trigger -> Workflow start latency.
  out = { creates: parallel(%w[trig-1 trig-2 trig-3]) { |n| call("/create", { ns: "b", name: n }) } }
  out[:pushes] = (1..5).map do |i|
    repo = "trig-#{((i - 1) % 3) + 1}"
    r = call("/trigger/push", { repo: repo, dir: "/t/#{repo}", tag: "s#{i}" })
    warn "push #{i} -> #{repo}: #{r['pushMs']}ms ok=#{r['ok']} #{r.dig('error', 'message')}"
    sleep 4
    r
  end
  sleep 20
  out[:events] = call("/events")["events"]
  save("4-trigger", out)
  puts JSON.pretty_generate(out)

when "postpush"
  # Repeat: push to work-1, then immediately fork it N times in parallel.
  n = (ARGV.shift || "6").to_i
  tag = ARGV.shift || "b"
  out = {}
  out[:writeCommit] = call("/git/write-commit", {
    obj: "git-1", dir: "/r/work-1", file: "spike.txt", content: "post-push probe #{tag} #{Time.now.utc}\n", message: "spike: post-push probe #{tag}"
  })
  out[:push] = call("/git/push", { ns: "a", repo: "work-1", dir: "/r/work-1", ref: "main", obj: "git-1" })
  t0 = mono
  out[:forks] = parallel((1..n).to_a) { |i| fork_repo("work-1", "pp#{tag}-#{i}") }
  out[:wallMs] = mono - t0
  out[:ok] = out[:forks].count { |r| r["err"].nil? && r.dig("ready", "readyMs") }
  out[:errors] = out[:forks].filter_map { |r| r["err"] }.map { |e| e.slice("code", "numericCode", "message") }
  save("2d-postpush-forks-#{tag}", out)
  puts JSON.pretty_generate(out.except(:forks, :writeCommit).merge(callMs: summary(out[:forks].map { |r| r["callMs"] })))

when "forkn"
  # ruby spike.rb forkn <source> <prefix> <n> <result-name>: n parallel forks of source.
  source, prefix, n, name = ARGV
  t0 = mono
  rows = parallel((1..n.to_i).to_a) { |i| fork_repo(source, "#{prefix}-#{i}") }
  out = {
    source: source, wallMs: mono - t0, ok: rows.count { |r| r["err"].nil? && r.dig("ready", "readyMs") },
    errors: rows.filter_map { |r| r["err"] }.map { |e| e.slice("code", "numericCode", "message") },
    callMs: summary(rows.map { |r| r["callMs"] }), rows: rows
  }
  save(name, out)
  puts JSON.pretty_generate(out.except(:rows))

when "call"
  # ad-hoc: ruby spike.rb call /path '{"json":1}'
  path = ARGV.shift
  body = JSON.parse(ARGV.shift || "{}")
  puts JSON.pretty_generate(call(path, body))

else
  abort "unknown phase #{phase.inspect}"
end
