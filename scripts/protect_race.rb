#!/usr/bin/env ruby
# frozen_string_literal: true

# A live check that a newly protected path reaches changes already cleared to land (colony/protect.ts) on a preview:
# protect a path while a change to it is in the trunk writer's landing cycle, then check the policy answer against trunk.
#
#   1. create a fresh colony (empty trunk) and turn its review off, so changes go straight to their lanes
#   2. each round: declare an intent for one new file in a region of its own (so its lane ticks at once); one external
#      agent (this script) takes it, clones trunk with the lease's read token, writes the file, commits, pushes to its
#      workspace with the lease's write token, and proposes
#   3. once the proposal is ready in its lane, wait --after seconds (the lane hands it to the trunk writer; with
#      FT_TEST_PUSH_DELAY_MS set on the preview, the writer's cycle then sleeps before its push)
#   4. protect a glob covering the file (POST decide/policy with the colony's list plus it) and check the answer's
#      `protection` against trunk:
#        landed and named: the proposal is landed with the named landing, and trunk holds the file at its blob
#        stopped, then approved: the proposal waits for a person (escalated, naming the glob) and the file stays off
#          trunk for --watch s; a person's approval then lands it, and trunk holds the file
#      Anything else fails the round: a stopped change on trunk, a landing the answer did not name, an unconfirmed
#      answer. A change that landed before the protection was sent is reported as too late.
#   With --queued, one more round: change A's cycle is held open by the push delay, change B waits in the trunk writer
#   behind it, and only B's path is protected: B must be stopped (never on trunk) while A lands.
#
# Set up the preview with the push delay (a test hook; never set in production):
#   npx wrangler preview --name <x> --var FT_TEST_PUSH_DELAY_MS:6000
#
# Usage:
#   FT_URL=https://<preview host> FT_TOKEN=<admin token> ruby scripts/protect_race.rb
#     [--name NAME] [--rounds 3] [--after 0,2,4] [--watch 20] [--queued] [--keep] [--out FILE]
#
# Reads FT_URL and FT_TOKEN from the environment only. Never prints tokens (lease tokens included).
require "fileutils"
require "json"
require "net/http"
require "open3"
require "optparse"
require "tmpdir"
require "uri"

PRODUCTION_HOSTS = %w[firetrident.mattsolt.workers.dev firetrident.com www.firetrident.com].freeze
BY = ENV.fetch("FT_USER", "protect-race-script")

opts = { name: "protect-race-#{Time.now.utc.strftime('%m%d%H%M%S')}", rounds: 3, after: [0.0, 2.0, 4.0], watch: 20.0,
         queued: false, keep: false, out: nil }
OptionParser.new do |o|
  o.banner = "Usage: FT_URL=... FT_TOKEN=... ruby scripts/protect_race.rb [options]"
  o.on("--name NAME", "Colony name (default protect-race-<time>; must not be a production colony's)") { |v| opts[:name] = v }
  o.on("--rounds N", Integer, "Protections to race (default 3)") { |v| opts[:rounds] = v }
  o.on("--after LIST", "Seconds to wait after the proposal is ready, per round, cycled (default 0,2,4)") do |v|
    opts[:after] = v.split(",").map { |x| Float(x) }
  end
  o.on("--watch S", Float, "Seconds a stopped change is watched for a late landing (default 20)") { |v| opts[:watch] = v }
  o.on("--queued", "Also protect a change while it waits in the trunk writer behind another change's cycle (needs FT_TEST_PUSH_DELAY_MS of 8000 or more)") { opts[:queued] = true }
  o.on("--keep", "Keep the colony afterwards (default: delete it)") { opts[:keep] = true }
  o.on("--out FILE", "Write the summary JSON here") { |v| opts[:out] = File.expand_path(v) }
end.parse!
abort("--rounds must be at least 1") unless opts[:rounds].positive?
abort("--after needs at least one value") if opts[:after].empty?

BASE = ENV.fetch("FT_URL", "").sub(%r{/+\z}, "")
TOKEN = ENV.fetch("FT_TOKEN", "")
abort("FT_URL is not set (the preview's base URL)") if BASE.empty?
abort("FT_TOKEN is not set (the deployment's admin token)") if TOKEN.length < 8
abort("FT_URL is a production address; run this on a preview") if PRODUCTION_HOSTS.include?(URI(BASE).host)

T0 = Time.now
$secrets = [TOKEN]
$protected = []

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
  $trunk_read = [lease.dig("trunk", "remote"), lease.dig("trunk", "token")]
  Dir.mktmpdir("ft-protect") do |dir|
    git(dir, "clone", "--quiet", "--branch", "main", "--depth", "1", lease.dig("trunk", "remote"), "w", token: lease.dig("trunk", "token"))
    w = File.join(dir, "w")
    head = git(w, "rev-parse", "HEAD")
    raise "clone head #{head} is not the lease base #{lease['baseSha']}" unless head == lease["baseSha"]

    FileUtils.mkdir_p(File.dirname(File.join(w, path)))
    File.write(File.join(w, path), text)
    git(w, "add", path)
    git(w, "-c", "user.name=FireTrident protect check", "-c", "user.email=protect@agents.firetrident.dev", "commit", "-qm",
        "#{intent['title']}\n\nFT-Intent: #{intent['id']}\nFT-Agent: #{agent}")
    head_sha = git(w, "rev-parse", "HEAD")
    blob = git(w, "rev-parse", "HEAD:#{path}")
    git(w, "push", "--quiet", "--force", lease.dig("repo", "remote"), "HEAD:refs/heads/main", token: lease["token"])
    prop = api!(:post, "/colonies/#{colony}/proposals", {
      intentId: intent["id"], agentId: agent, workspace: lease["repo"], baseSha: lease["baseSha"], headSha: head_sha,
      writeSet: [{ path: path, blob: blob }], readSet: [], intentRevision: intent["revision"] || 1,
      declared: { footprint: intent["footprint"], summary: "Add #{path}" },
      evidence: { notVerified: "Not verified: nothing; this file exists to race a protected path against the trunk writer" }
    })
    [prop, blob]
  end
end

# The blob that trunk's main holds at `path`, read with git through the latest lease's trunk read token; nil when absent.
def trunk_blob(path)
  remote, token = $trunk_read
  raise "no lease seen yet: cannot read trunk" unless remote

  attempts = 0
  begin
    attempts += 1
    Dir.mktmpdir("ft-protect-check") do |dir|
      git(dir, "clone", "--quiet", "--branch", "main", "--depth", "1", remote, "c", token: token)
      line = git(File.join(dir, "c"), "ls-tree", "HEAD", "--", path)
      line.empty? ? nil : line.split(/\s+/)[2]
    end
  rescue RuntimeError => e
    raise e if attempts >= 3 || !e.message.include?("git clone failed")

    sleep 3
    retry
  end
end

def proposal(colony, id) = api!(:get, "/colonies/#{colony}/proposals/#{id}")

# Wait until a proposal leaves pending and checking (review is off, so it becomes ready in a lane).
def wait_ready(colony, pid)
  status = nil
  40.times do
    status = proposal(colony, pid)["status"]
    break unless %w[pending checking].include?(status)

    sleep 0.5
  end
  status
end

# Wait (at most `seconds`) until a proposal reaches `want`; returns it as last read.
def wait_status(colony, pid, want, seconds)
  p = nil
  deadline = Time.now + seconds
  loop do
    p = proposal(colony, pid)
    return p if p["status"] == want || Time.now > deadline

    sleep 1
  end
end

# Protect one more glob: the colony's list plus it, as `ft policy --protect` sends it. Returns the answer and how long it took.
def protect(colony, glob)
  $protected |= [glob]
  t = Time.now
  code, res = api(:post, "/colonies/#{colony}/decide/policy", { protectedPaths: $protected }, timeout: 90)
  raise "protect -> #{code}: #{redact(res.inspect)[0, 300]}" unless code == 200

  [res["protection"] || {}, ((Time.now - t) * 1000).round]
end

# A stopped change: waits for a person, naming the glob, and stays off trunk for `watch` s; a person's approval then lands it.
def check_stopped(colony, pid, path, glob, blob, watch)
  p = proposal(colony, pid)
  return "the stopped change is #{p['status']}, not escalated" unless p["status"] == "escalated"
  return "its reason does not name #{glob}: #{p['reason']}" unless p["reason"].to_s.start_with?("newly protected: ") && p["reason"].include?(glob)

  deadline = Time.now + watch
  while Time.now < deadline
    now = proposal(colony, pid)
    return "the stopped change became #{now['status']}#{now['landingId'] ? " in #{now['landingId']}" : ''} without a person" unless now["status"] == "escalated"

    sleep 2
  end
  return "trunk holds #{path} although the change was stopped" if trunk_blob(path)

  api!(:post, "/colonies/#{colony}/review/#{pid}", { decision: "approve", reason: "protect race check: a person approves the stopped change", by: BY })
  landed = wait_status(colony, pid, "landed", 60)
  return "approved by a person, it is #{landed['status']} (#{landed['reason']}), not landed" unless landed["status"] == "landed"
  return "approved and landed, but trunk does not hold its blob at #{path}" unless trunk_blob(path) == blob

  nil
end

# One round: propose, wait, protect the file's directory, and check the answer against trunk. Returns the round's record.
def race(colony, agent, n, after, watch)
  path = "guard-#{n}/secret.txt"
  glob = "guard-#{n}/**"
  intent = api!(:post, "/colonies/#{colony}/intents", {
    title: "Add #{path}", why: "A file for the protected-paths check (round #{n}); its directory is protected while its change lands.",
    footprint: [path], createdBy: BY
  })
  prop, blob = propose_file(colony, agent, take_intent(colony, agent, intent["id"]), path, "protected paths check, round #{n}\n")
  pid = prop["id"]
  rec = { round: n, path: path, glob: glob, proposal: pid, after_s: after }
  status = wait_ready(colony, pid)
  return rec.merge(outcome: "skipped", detail: "proposal #{status} before the protection (expected ready)") unless status == "ready"

  sleep after
  answer, ms = protect(colony, glob)
  rec[:protect_ms] = ms
  rec[:answer] = answer.slice("stopped", "landed", "confirmed", "unconfirmed")
  return rec.merge(outcome: "FAIL", detail: "unconfirmed: the trunk writer did not answer") unless answer["confirmed"] == true

  named = (answer["landed"] || []).find { |l| l["proposalId"] == pid }
  stopped = (answer["stopped"] || []).find { |s| s["proposalId"] == pid }
  if named
    p2 = proposal(colony, pid)
    problems = []
    problems << "proposal is #{p2['status']} (#{p2['landingId']}), not landed in #{named['landingId']}" unless p2["status"] == "landed" && p2["landingId"] == named["landingId"]
    problems << "trunk does not hold the proposal's blob at #{path}" unless trunk_blob(path) == blob
    return rec.merge(outcome: problems.empty? ? "landed and named" : "FAIL", detail: problems.empty? ? "#{named['landingId']} (#{named['trunkSha'][0, 7]}): #{p2['reason']}" : problems.join("; "))
  end
  if stopped
    problem = check_stopped(colony, pid, path, glob, blob, watch)
    return rec.merge(outcome: problem ? "FAIL" : "stopped, then approved", detail: problem || "waited for a person #{watch.round} s, landed on approval")
  end
  return rec.merge(outcome: "too late", detail: "the change landed before the protection was sent; lower --after or raise FT_TEST_PUSH_DELAY_MS") if proposal(colony, pid)["status"] == "landed"

  rec.merge(outcome: "FAIL", detail: "the answer neither named a landing for the change nor counted it stopped")
end

# The queued round: change A enters the trunk writer's cycle, which the push delay holds open; change B becomes ready
# behind it and the lane hands it to the writer, where it waits for the next cycle; B's directory is protected while it
# waits. The writer's protection check must stop B (never on trunk, never named as landed) while A lands.
def queued_race(colony, agent_a, agent_b, watch)
  rec = { round: "queued" }
  ia = api!(:post, "/colonies/#{colony}/intents", { title: "Add guard-qa/open.txt", why: "The change ahead in the queued round.", footprint: ["guard-qa/open.txt"], createdBy: BY })
  pa, blob_a = propose_file(colony, agent_a, take_intent(colony, agent_a, ia["id"]), "guard-qa/open.txt", "queued round: the change ahead\n")
  return rec.merge(outcome: "skipped", detail: "change A is not ready") unless wait_ready(colony, pa["id"]) == "ready"

  ib = api!(:post, "/colonies/#{colony}/intents", { title: "Add guard-qb/secret.txt", why: "The change whose directory is protected while it waits in the trunk writer.", footprint: ["guard-qb/secret.txt"], createdBy: BY })
  pb, blob_b = propose_file(colony, agent_b, take_intent(colony, agent_b, ib["id"]), "guard-qb/secret.txt", "queued round: the change protected while queued\n")
  return rec.merge(outcome: "skipped", detail: "change B is not ready") unless wait_ready(colony, pb["id"]) == "ready"

  sleep 2 # the lane hands B to the trunk writer, where it waits behind A's cycle
  return rec.merge(outcome: "inconclusive", detail: "change A had already landed, so B was not queued behind it; raise FT_TEST_PUSH_DELAY_MS") if proposal(colony, pa["id"])["status"] == "landed"

  answer, ms = protect(colony, "guard-qb/**")
  rec[:protect_ms] = ms
  rec[:answer] = answer.slice("stopped", "landed", "confirmed", "unconfirmed")
  problems = []
  problems << "unconfirmed: the trunk writer did not answer" unless answer["confirmed"] == true
  problems << "the answer named a landing for the protected change" if (answer["landed"] || []).any? { |l| l["proposalId"] == pb["id"] }
  problems << "the answer did not count the change stopped" unless (answer["stopped"] || []).any? { |s| s["proposalId"] == pb["id"] }
  problem = problems.empty? ? check_stopped(colony, pb["id"], "guard-qb/secret.txt", "guard-qb/**", blob_b, watch) : nil
  problems << problem if problem
  a_final = wait_status(colony, pa["id"], "landed", 30)
  problems << "change A is #{a_final['status']}, not landed" unless a_final["status"] == "landed"
  problems << "trunk does not hold change A's blob" unless trunk_blob("guard-qa/open.txt") == blob_a
  return rec.merge(outcome: "FAIL", detail: problems.uniq.join("; ")) unless problems.empty?

  rec.merge(outcome: "stopped while queued", detail: "B waited for a person and landed on approval; A landed in #{a_final['landingId']}")
end

colony = nil
records = []
begin
  say "creating colony #{opts[:name]} on #{BASE}"
  colony = api!(:post, "/colonies", { name: opts[:name], pool: 2 }, timeout: 180)["id"]
  api!(:post, "/colonies/#{colony}/decide/policy", { enabled: false })
  agent = api!(:post, "/colonies/#{colony}/agents", { kind: "external", name: "protect-check", model: "script" })["id"]
  say "colony #{colony}, review off, agent #{agent}"
  opts[:rounds].times do |i|
    after = opts[:after][i % opts[:after].size]
    rec = race(colony, agent, i + 1, after, opts[:watch])
    records << rec
    say "round #{rec[:round]} (protected #{after} s after ready, answered in #{rec[:protect_ms] || '-'} ms): #{rec[:outcome]}: #{rec[:detail]}"
  end
  if opts[:queued]
    agent_b = api!(:post, "/colonies/#{colony}/agents", { kind: "external", name: "protect-check-b", model: "script" })["id"]
    rec = queued_race(colony, agent, agent_b, opts[:watch])
    records << rec
    say "queued round (answered in #{rec[:protect_ms] || '-'} ms): #{rec[:outcome]}: #{rec[:detail]}"
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
decisive = records.count { |r| ["landed and named", "stopped, then approved", "stopped while queued"].include?(r[:outcome]) }
if counts.key?("FAIL")
  say "FAIL: an answer disagreed with trunk"
  exit 1
elsif decisive.zero?
  say "INCONCLUSIVE: no round raced the trunk writer (set FT_TEST_PUSH_DELAY_MS on the preview, or lower --after)"
  exit 2
else
  say "PASS: every answer matched trunk (#{counts.map { |k, v| "#{v} #{k}" }.join(', ')})"
end
