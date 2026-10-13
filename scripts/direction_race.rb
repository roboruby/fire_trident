#!/usr/bin/env ruby
# frozen_string_literal: true

# A live check of the trunk writer's direction fence (TrunkDO.direction) on a preview: withdraw an intent
# while its change is in the trunk writer's landing cycle, then check the answer against trunk.
#
#   1. create a fresh colony (empty trunk) and turn its review off: this checks the trunk writer, not review
#   2. each round: declare an intent for one new file in a region of its own (so its lane ticks at once);
#      one external agent (this script) takes it, clones trunk with the lease's read token, writes the
#      file, commits, pushes to its workspace with the lease's write token, and proposes
#   3. once the proposal is ready in its lane, wait --after seconds (the lane hands it to the trunk writer;
#      with FT_TEST_PUSH_DELAY_MS set on the preview, the writer's cycle then sleeps before its push)
#   4. withdraw the intent and check the answer against trunk:
#        landed and named: the proposal is landed with the named landing, trunk holds the file at the
#          proposal's blob, and `why` for the file names that landing and the proposal
#        stopped and absent: the proposal stays returned and the file never reaches trunk (watched --watch s)
#      Anything else fails the round: a stopped change on trunk, a landing the answer did not name, an
#      unconfirmed answer. A change that landed before the withdrawal was sent is reported as too late.
#
# Set up the preview with the push delay (a test hook; never set in production):
#   npx wrangler preview --name <x> --var FT_TEST_PUSH_DELAY_MS:6000
#
# Usage:
#   FT_URL=https://<preview host> FT_TOKEN=<admin token> ruby scripts/direction_race.rb
#     [--name NAME] [--rounds 3] [--after 0,2,4] [--watch 20] [--keep] [--out FILE]
#
# Reads FT_URL and FT_TOKEN from the environment only. Never prints tokens (lease tokens included).
require "fileutils"
require "json"
require "net/http"
require "open3"
require "optparse"
require "tmpdir"
require "uri"

PRODUCTION_HOST = "firetrident.mattsolt.workers.dev"
BY = ENV.fetch("FT_USER", "direction-race-script")

opts = { name: "direction-race-#{Time.now.utc.strftime('%m%d%H%M%S')}", rounds: 3, after: [0.0, 2.0, 4.0], watch: 20.0,
         keep: false, out: nil, production: false }
OptionParser.new do |o|
  o.banner = "Usage: FT_URL=... FT_TOKEN=... ruby scripts/direction_race.rb [options]"
  o.on("--name NAME", "Colony name (default direction-race-<time>; must not be a production colony's)") { |v| opts[:name] = v }
  o.on("--rounds N", Integer, "Withdrawals to race (default 3)") { |v| opts[:rounds] = v }
  o.on("--after LIST", "Seconds to wait after the proposal is ready, per round, cycled (default 0,2,4)") do |v|
    opts[:after] = v.split(",").map { |x| Float(x) }
  end
  o.on("--watch S", Float, "Seconds a stopped change is watched for a late landing (default 20)") { |v| opts[:watch] = v }
  o.on("--keep", "Keep the colony afterwards (default: delete it)") { opts[:keep] = true }
  o.on("--out FILE", "Write the summary JSON here") { |v| opts[:out] = File.expand_path(v) }
  o.on("--production", "Allow the production deployment (it has no push delay; meant for previews)") { opts[:production] = true }
end.parse!
abort("--rounds must be at least 1") unless opts[:rounds].positive?
abort("--after needs at least one value") if opts[:after].empty?

BASE = ENV.fetch("FT_URL", "").sub(%r{/+\z}, "")
TOKEN = ENV.fetch("FT_TOKEN", "")
abort("FT_URL is not set (the preview's base URL)") if BASE.empty?
abort("FT_TOKEN is not set (the deployment's admin token)") if TOKEN.length < 8
abort("FT_URL is the production deployment; run this on a preview, or pass --production") if URI(BASE).host == PRODUCTION_HOST && !opts[:production]

T0 = Time.now
$secrets = [TOKEN]

def redact(text)
  out = text.to_s.gsub(/art_v\d+_[A-Za-z0-9._~+\/=-]+/, "<redacted>")
  $secrets.each { |s| out = out.gsub(s, "<redacted>") if s && s.length >= 8 }
  out
end

def say(line)
  puts format("[%6.1fs] %s", Time.now - T0, redact(line))
  $stdout.flush
end

def api(method, path, body = nil, timeout: 120)
  uri = URI("#{BASE}/api#{path}")
  klass = { get: Net::HTTP::Get, post: Net::HTTP::Post, delete: Net::HTTP::Delete }.fetch(method)
  req = klass.new(uri)
  req["Authorization"] = "Bearer #{TOKEN}"
  req["Content-Type"] = "application/json"
  req.body = JSON.generate(body) if body
  res = Net::HTTP.start(uri.host, uri.port, use_ssl: uri.scheme == "https", read_timeout: timeout, open_timeout: 30) { |h| h.request(req) }
  data = begin
    JSON.parse(res.body.to_s)
  rescue JSON::ParserError
    { "raw" => res.body.to_s[0, 300] }
  end
  [res.code.to_i, data]
end

def api!(method, path, body = nil, **kw)
  code, data = api(method, path, body, **kw)
  raise "#{method.upcase} #{path} -> #{code}: #{redact(data.inspect)[0, 400]}" unless code.between?(200, 299)

  data
end

def git(dir, *args, token: nil)
  cmd = ["git"]
  cmd += ["-c", "http.extraHeader=Authorization: Bearer #{token}"] if token
  cmd += ["-c", "protocol.version=2", *args]
  out, err, st = Open3.capture3(*cmd, chdir: dir)
  raise "git #{args.first} failed: #{redact(err)[0, 300]}" unless st.success?

  out.strip
end

# Take work until this agent holds `intent_id` (the pool may still be forking workspaces).
def take_intent(colony, agent, intent_id)
  deadline = Time.now + 180
  loop do
    took = api!(:post, "/colonies/#{colony}/agents/#{agent}/take")
    if took["intent"]
      return took if took.dig("intent", "id") == intent_id

      raise "took #{took.dig('intent', 'id')}, expected #{intent_id}"
    end
    raise "no assignment in 180 s: #{took['reason']}" if Time.now > deadline

    sleep([(took["retryInMs"] || 2_000) / 1000.0, 5].min)
  end
end

# Write `path` in a clone of trunk at the lease's base, push it to the workspace, and propose it. Returns the proposal and the blob.
def propose_file(colony, agent, took, path, text)
  intent, lease = took.values_at("intent", "lease")
  $secrets |= [lease["token"], lease.dig("trunk", "token")].compact
  Dir.mktmpdir("ft-race") do |dir|
    git(dir, "clone", "--quiet", "--branch", "main", "--depth", "1", lease.dig("trunk", "remote"), "w", token: lease.dig("trunk", "token"))
    w = File.join(dir, "w")
    head = git(w, "rev-parse", "HEAD")
    raise "clone head #{head} is not the lease base #{lease['baseSha']}" unless head == lease["baseSha"]

    FileUtils.mkdir_p(File.dirname(File.join(w, path)))
    File.write(File.join(w, path), text)
    git(w, "add", path)
    git(w, "-c", "user.name=FireTrident race check", "-c", "user.email=race@agents.firetrident.dev", "commit", "-qm",
        "#{intent['title']}\n\nFT-Intent: #{intent['id']}\nFT-Agent: #{agent}")
    head_sha = git(w, "rev-parse", "HEAD")
    blob = git(w, "rev-parse", "HEAD:#{path}")
    git(w, "push", "--quiet", "--force", lease.dig("repo", "remote"), "HEAD:refs/heads/main", token: lease["token"])
    prop = api!(:post, "/colonies/#{colony}/proposals", {
      intentId: intent["id"], agentId: agent, workspace: lease["repo"], baseSha: lease["baseSha"], headSha: head_sha,
      writeSet: [{ path: path, blob: blob }], readSet: [], intentRevision: intent["revision"] || 1,
      declared: { footprint: intent["footprint"], summary: "Add #{path}" },
      evidence: { notVerified: "Not verified: nothing; this file exists to race a withdrawal against the trunk writer" }
    })
    [prop, blob]
  end
end

def trunk_blob(colony, path)
  (api!(:get, "/colonies/#{colony}", timeout: 60)["files"] || []).find { |f| f["path"] == path }&.dig("blob")
end

def why(colony, path)
  api!(:get, "/colonies/#{colony}/why?path=#{URI.encode_www_form_component(path)}")
end

def proposal(colony, id) = api!(:get, "/colonies/#{colony}/proposals/#{id}")

# One round: propose, wait, withdraw, and check the answer against trunk. Returns the round's record.
def race(colony, agent, n, after, watch)
  path = "race-#{n}/fence.txt"
  intent = api!(:post, "/colonies/#{colony}/intents", {
    title: "Add #{path}", why: "A file for the direction fence check (round #{n}); it is withdrawn while its change lands.",
    footprint: [path], createdBy: BY
  })
  took = take_intent(colony, agent, intent["id"])
  prop, blob = propose_file(colony, agent, took, path, "direction fence check, round #{n}\n")
  pid = prop["id"]
  status = prop["status"]
  20.times do
    break unless %w[pending checking].include?(status)

    sleep 0.5
    status = proposal(colony, pid)["status"]
  end
  rec = { round: n, path: path, intent: intent["id"], proposal: pid, after_s: after }
  return rec.merge(outcome: "skipped", detail: "proposal #{status} before the withdrawal (expected ready)") unless status == "ready"

  sleep after
  t = Time.now
  code, res = api(:post, "/colonies/#{colony}/intents/#{intent['id']}/withdraw", { reason: "direction fence check, round #{n}", by: BY }, timeout: 90)
  rec[:withdraw_ms] = ((Time.now - t) * 1000).round
  if code == 409 && res["error"].to_s.include?("already landed")
    return rec.merge(outcome: "too late", detail: "the change landed before the withdrawal was sent; lower --after or raise FT_TEST_PUSH_DELAY_MS")
  end
  raise "withdraw -> #{code}: #{redact(res.inspect)[0, 300]}" unless code == 200

  rec[:answer] = res.slice("returned", "landed", "confirmed", "unconfirmed")
  return rec.merge(outcome: "FAIL", detail: "unconfirmed: the trunk writer did not answer") unless res["confirmed"] == true

  named = (res["landed"] || []).find { |l| l["proposalId"] == pid }
  if named
    p2 = proposal(colony, pid)
    on_trunk = trunk_blob(colony, path)
    entry = why(colony, path).find { |e| e.dig("landing", "id") == named["landingId"] }
    problems = []
    problems << "proposal is #{p2['status']} (#{p2['landingId']}), not landed in #{named['landingId']}" unless p2["status"] == "landed" && p2["landingId"] == named["landingId"]
    problems << "trunk holds #{on_trunk || 'nothing'} at #{path}, not the proposal's #{blob}" unless on_trunk == blob
    problems << "why #{path} does not name #{named['landingId']} with #{pid}" unless entry && (entry.dig("note", "proposals") || []).any? { |x| x["id"] == pid }
    problems << "intent shows #{res.dig('intent', 'status')}, not landed" unless res.dig("intent", "status") == "landed"
    return rec.merge(outcome: problems.empty? ? "landed and named" : "FAIL", landing: named["landingId"], trunk: named["trunkSha"],
                     detail: problems.empty? ? "#{named['landingId']} (#{named['trunkSha'][0, 7]})" : problems.join("; "))
  end

  return rec.merge(outcome: "FAIL", detail: "the answer neither named a landing nor counted the change stopped") unless res["returned"].to_i >= 1

  deadline = Time.now + watch
  loop do
    p2 = proposal(colony, pid)
    on_trunk = trunk_blob(colony, path)
    landed = why(colony, path)
    if p2["status"] != "returned" || on_trunk || !landed.empty?
      return rec.merge(outcome: "FAIL", detail: "reported stopped, but the proposal is #{p2['status']}#{p2['landingId'] ? " in #{p2['landingId']}" : ''}, trunk holds #{on_trunk || 'nothing'}, why lists #{landed.size}")
    end
    break if Time.now > deadline

    sleep 1
  end
  rec.merge(outcome: "stopped and absent", detail: "watched #{watch.round} s: #{proposal(colony, pid)['reason']}")
end

colony = nil
records = []
begin
  say "creating colony #{opts[:name]} on #{BASE}"
  colony = api!(:post, "/colonies", { name: opts[:name], pool: 2 }, timeout: 180)["id"]
  api!(:post, "/colonies/#{colony}/decide/policy", { enabled: false })
  agent = api!(:post, "/colonies/#{colony}/agents", { kind: "external", name: "race-check", model: "script" })["id"]
  say "colony #{colony}, review off, agent #{agent}"
  opts[:rounds].times do |i|
    after = opts[:after][i % opts[:after].size]
    rec = race(colony, agent, i + 1, after, opts[:watch])
    records << rec
    say "round #{rec[:round]} (withdrawn #{after} s after ready, answered in #{rec[:withdraw_ms] || '-'} ms): #{rec[:outcome]}: #{rec[:detail]}"
  end
rescue StandardError => e
  say "ERROR #{e.message}"
  records << { outcome: "FAIL", detail: "error: #{redact(e.message)}" }
ensure
  if colony && !opts[:keep]
    code, = api(:delete, "/colonies/#{colony}", nil, timeout: 600)
    say "deleted colony #{colony} (#{code})"
  elsif colony
    say "kept colony #{colony}: #{BASE}/c/#{colony}"
  end
end

counts = records.group_by { |r| r[:outcome] }.transform_values(&:size)
summary = { url: BASE, colony: colony, kept: opts[:keep], rounds: records, counts: counts }
say "SUMMARY #{JSON.pretty_generate(summary)}"
File.write(opts[:out], "#{redact(JSON.pretty_generate(summary))}\n") if opts[:out]
decisive = records.count { |r| ["landed and named", "stopped and absent"].include?(r[:outcome]) }
if counts.key?("FAIL")
  say "FAIL: an answer disagreed with trunk"
  exit 1
elsif decisive.zero?
  say "INCONCLUSIVE: no round raced the trunk writer (set FT_TEST_PUSH_DELAY_MS on the preview, or lower --after)"
  exit 2
else
  say "PASS: every answer matched trunk (#{counts.map { |k, v| "#{v} #{k}" }.join(', ')})"
end
