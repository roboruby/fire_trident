#!/usr/bin/env ruby
# frozen_string_literal: true

# Grow a project from a spec, start to finish, and check the result from a plain clone:
#
#   1. ft new --spec demo/new-project-spec.md: an empty trunk, the spec's rules, then its intents
#      in dependency order, each carrying the spec's contracts
#   2. ft swarm: in-platform agents self-assign by priority; an agent whose intent builds on other
#      intents' files waits for them to land, reads them, then writes its files with a model
#   3. follow the colony until every intent has landed (optionally approving escalations as the
#      human reviewer, each one printed with its reason)
#   4. when the server certifies trunk (it runs the colony's own tests after landings), keep
#      following until trunk is certified green with no repair intent open (--certify-wait)
#   5. clone trunk with plain git (a read token from wrangler), run `node --test` and compare it with
#      the certification of the same commit, run the reference acceptance suite against the colony's
#      code, and check the spec's rules on every file
#   5. print the numbers: time from `ft new` to the last landing, landings, returns, tokens, cost
#
# Usage:
#   ruby demo/run_new_project.rb [--spec FILE] [--name NAME] [--agents 6] [--model SPEC]
#                                [--approve] [--timeout 2400] [--stall 600] [--attach] [--certify-wait 900]
#                                [--reference DIR] [--out DIR] [--keep-running]
#
# --model takes a model id or a mix such as "default=3,bulk" ("default" and "bulk" are the
# server's FT_DEFAULT_MODEL and FT_BULK_MODEL). --attach skips `ft new` and `ft swarm` and follows
# an existing colony. Reads FT_URL (and FT_TOKEN when the server needs one) from the environment;
# a token in ~/.config/firetrident/env is only used for the server named there. Never prints tokens.
# The clone goes to a temporary directory outside any notes folder unless --out names one.
require "json"
require "net/http"
require "open3"
require "optparse"
require "tmpdir"
require "uri"
require "fileutils"

ROOT = File.expand_path("..", __dir__)
FT = ["node", File.join(ROOT, "packages/cli/src/ft.ts")].freeze
WORKER = File.join(ROOT, "packages/worker")

# USD per million tokens (input, output), Workers AI list prices on 2026-10-12.
PRICES = {
  "@cf/moonshotai/kimi-k2.7-code" => [0.95, 4.0],
  "@cf/zai-org/glm-5.3-flash" => [0.15, 0.5],
  "@cf/openai/gpt-oss-120b" => [0.35, 0.75],
  "@cf/openai/gpt-oss-20b" => [0.2, 0.3],
  "@cf/google/gemma-4-26b-a4b-it" => [0.1, 0.3],
  "@cf/zai-org/glm-4.7-flash" => [0.0605, 0.4]
}.freeze
CLEF_PER_M = 0.24 # @cf/cloudflare/clef, input tokens only
# Second opinions run on gemma or gpt-oss-120b (whichever family differs from the author); price them at the higher.
SECOND_OPINION = [0.35, 0.75].freeze

opts = { spec: "demo/new-project-spec.md", name: nil, agents: 6, model: "default=3,bulk", approve: false, timeout: 2400, stall: 600, certify_wait: 900,
         attach: false, keep: false, out: nil, reference: File.expand_path("shortlinks-reference", __dir__) }
OptionParser.new do |o|
  o.banner = "Usage: ruby demo/run_new_project.rb [options]"
  o.on("--spec FILE", "Spec (default demo/new-project-spec.md)") { |v| opts[:spec] = v }
  o.on("--name NAME", "Colony name (default: the spec's name)") { |v| opts[:name] = v }
  o.on("--agents N", Integer, "Swarm size (default 6)") { |v| opts[:agents] = v }
  o.on("--model SPEC", "Model id or mix (default default=3,bulk)") { |v| opts[:model] = v }
  o.on("--approve", "Approve escalated proposals as the human reviewer") { opts[:approve] = true }
  o.on("--timeout S", Integer, "Give up after S seconds (default 2400)") { |v| opts[:timeout] = v }
  o.on("--stall S", Integer, "Give up when nothing lands for S seconds (default 600)") { |v| opts[:stall] = v }
  o.on("--attach", "Follow an existing colony (no ft new, no swarm)") { opts[:attach] = true }
  o.on("--reference DIR", "Directory whose test/acceptance.test.ts judges the result (default demo/shortlinks-reference)") { |v| opts[:reference] = File.expand_path(v) }
  o.on("--out DIR", "Where to clone trunk (default: a temporary directory)") { |v| opts[:out] = File.expand_path(v) }
  o.on("--keep-running", "Leave the swarm running at the end") { opts[:keep] = true }
  o.on("--certify-wait S", Integer, "After every intent landed, wait up to S seconds for trunk to be certified green (default 900; 0 skips)") { |v| opts[:certify_wait] = v }
end.parse!

def load_env
  url = ENV["FT_URL"].to_s.strip
  token = ENV["FT_TOKEN"].to_s.strip
  file = File.expand_path("~/.config/firetrident/env")
  if (url.empty? || token.empty?) && File.exist?(file)
    conf = File.readlines(file).filter_map { |l| l.strip.split("=", 2) if l.include?("=") }.to_h
    url = conf["FT_URL"].to_s if url.empty?
    # The file's token belongs to the server the file names.
    token = conf["FT_TOKEN"].to_s if token.empty? && conf["FT_URL"].to_s.sub(%r{/+\z}, "") == url.sub(%r{/+\z}, "")
  end
  abort("FT_URL is not set") if url.empty?
  [url.sub(%r{/+\z}, ""), token]
end

BASE, TOKEN = load_env
T0 = Time.now

def redact(text)
  out = text.to_s.gsub(/art_v\d+_[A-Za-z0-9._~+\/=-]+/, "<redacted>")
  TOKEN.empty? ? out : out.gsub(TOKEN, "<redacted>")
end

def say(line)
  puts format("[%7.1fs] %s", Time.now - T0, line)
  $stdout.flush
end

def scene(title)
  puts
  say("== #{title}")
end

def api(method, path, body = nil, timeout: 120)
  uri = URI("#{BASE}/api#{path}")
  klass = { get: Net::HTTP::Get, post: Net::HTTP::Post, delete: Net::HTTP::Delete }.fetch(method)
  req = klass.new(uri)
  req["Authorization"] = "Bearer #{TOKEN}" unless TOKEN.empty?
  req["Content-Type"] = "application/json"
  req.body = JSON.generate(body) if body
  res = Net::HTTP.start(uri.host, uri.port, use_ssl: uri.scheme == "https", read_timeout: timeout, open_timeout: 30) { |h| h.request(req) }
  data = begin
    JSON.parse(res.body)
  rescue StandardError
    { "raw" => res.body.to_s[0, 300] }
  end
  [res.code.to_i, data]
end

def api!(method, path, body = nil, **kw)
  code, data = api(method, path, body, **kw)
  raise "#{method.upcase} #{path} -> #{code}: #{redact(data.inspect)[0, 400]}" unless code.between?(200, 299)

  data
end

def ft(*args, quiet: false)
  shown = args.map { |a| a.match?(/[\s'"$\\*?(){}|<>]/) ? "'#{a.gsub("'", "'\\\\''")}'" : a }.join(" ")
  puts "$ ft #{shown}"
  env = { "FT_URL" => BASE }
  env["FT_TOKEN"] = TOKEN unless TOKEN.empty?
  out, st = Open3.capture2e(env, *FT, *args, chdir: ROOT)
  puts redact(out).lines.map { |l| "  #{l}" }.join unless quiet
  raise "ft #{args.first} failed: #{redact(out)[0, 400]}" unless st.success?

  out
end

def run(cmd, chdir:, env: {})
  out, st = Open3.capture2e(env, *cmd, chdir: chdir)
  [redact(out), st.success?]
end

# The node binary itself, resolved with this shell's environment: a version manager's shim needs
# variables that the colony's code is not given.
NODE = begin
  path, st = Open3.capture2("node", "-p", "process.execPath")
  st.success? && File.executable?(path.strip) ? path.strip : "node"
rescue StandardError
  "node"
end

# Run the colony's code (agents wrote it) with PATH and an empty temporary HOME and nothing else: this
# shell's environment holds FT_TOKEN, the admin token, and whatever other secrets the operator keeps there.
def run_untrusted(cmd, chdir:)
  Dir.mktmpdir("ft-home-") do |home|
    out, st = Open3.capture2e({ "PATH" => ENV.fetch("PATH", "/usr/bin:/bin"), "HOME" => home }, *cmd, chdir: chdir, unsetenv_others: true)
    [redact(out), st.success?]
  end
end

spec_text = File.read(File.expand_path(opts[:spec], ROOT))
spec = JSON.parse(spec_text[/^```json firetrident\n(.*?)\n```$/m, 1])
colony = (opts[:name] || spec["name"]).downcase.gsub(/[^a-z0-9-]+/, "-").gsub(/\A-+|-+\z/, "")
say("FireTrident: grow #{colony} from #{opts[:spec]} at #{BASE}")
say("plan: #{spec["rules"].size} rule(s), #{spec["intents"].size} intents; #{opts[:agents]} agents on #{opts[:model]}; escalations #{opts[:approve] ? "approved by this script as the human" : "left for a human"}")

# --- 1. ft new ---------------------------------------------------------------
t_new = Time.now
unless opts[:attach]
  code, = api(:get, "/colonies/#{colony}")
  abort("colony #{colony} exists; pick another --name, or --attach to follow it") if code == 200
  scene("ft new")
  ft("new", "--spec", opts[:spec], "--name", colony)
  say("colony declared in #{(Time.now - t_new).round(1)} s")
end

# Record proposal, landing and decision events for the breakdown at the end.
watch_log = File.join(Dir.tmpdir, "ft-watch-#{colony}-#{Time.now.to_i}.jsonl")
watch_env = { "FT_URL" => BASE }
watch_env["FT_TOKEN"] = TOKEN unless TOKEN.empty?
watch_pid = spawn(watch_env, *FT, "watch", colony, "--json", "--only", "proposal,landing,intent", out: watch_log, err: File::NULL, chdir: ROOT)

# --- 2. the swarm --------------------------------------------------------------
unless opts[:attach]
  scene("ft swarm")
  ft("swarm", colony, "--agents", opts[:agents].to_s, "--model", opts[:model])
end

# --- 3. follow until every intent has landed --------------------------------------
scene("Growing")
total = spec["intents"].size
last_landed = -1
last_progress = Time.now
approved = []
done_at = nil
last_cert = nil

# One line for the colony's latest certification, or nil when the server does not certify.
def certification_line(snap)
  c = snap.dig("colony", "certification")
  return nil unless c
  k = c["counts"] || {}
  repairs = snap["intents"].select { |i| i["source"] == "certify" }
  open = repairs.count { |i| %w[open claimed proposed].include?(i["status"]) }
  counts = k.empty? ? "" : " #{k['pass']}/#{k['tests']} pass, #{k['fail'].to_i + k['cancelled'].to_i} failing"
  failing = (c["failing"] || []).map { |f| f["name"] }.first(3)
  format("%s %s%s%s | repair intents: %d declared, %d open%s", c["trunkSha"].to_s[0, 7], c["status"], counts, failing.empty? ? "" : " (#{failing.join('; ')})",
         repairs.size, open, c["trunkSha"] == snap.dig("colony", "trunkSha") ? "" : " | head #{snap.dig('colony', 'trunkSha').to_s[0, 7]} not certified yet")
end

# Trunk is certified green at its head and no repair intent is open. True when the server does not certify,
# and when certification has nothing to run (no node:test files) or cannot run: there is no green to wait for.
def certified_green?(snap)
  c = snap.dig("colony", "certification")
  return true unless c
  return false if snap["intents"].any? { |i| i["source"] == "certify" && %w[open claimed proposed].include?(i["status"]) }
  return true if %w[skipped error].include?(c["status"])

  c["status"] == "green" && c["trunkSha"] == snap.dig("colony", "trunkSha")
end

loop do
  sleep 5
  snap = begin
    api!(:get, "/colonies/#{colony}", timeout: 60)
  rescue StandardError => e
    say("snapshot unavailable: #{redact(e.message)[0, 120]}")
    next
  end
  m = (api(:get, "/colonies/#{colony}/metrics", timeout: 60)[1] || {})["metrics"] || {}
  spec_intents = snap["intents"].reject { |i| i["source"] == "certify" }
  by = spec_intents.group_by { |i| i["status"] }.transform_values(&:size)
  landed = by["landed"].to_i
  say(format("intents landed %2d/%d  claimed %d  proposed %d  open %d | landings %d, returned %d, review %d, files %d",
             landed, total, by["claimed"].to_i, by["proposed"].to_i, by["open"].to_i, m["landings"].to_i, m["returned"].to_i, m["reviewQueue"].to_i, snap["files"].size))
  if landed > last_landed
    last_landed = landed
    last_progress = Time.now
  end
  if m["reviewQueue"].to_i.positive?
    review = api!(:get, "/colonies/#{colony}/review")
    Array(review.is_a?(Hash) ? review["proposals"] : review).each do |p|
      next if approved.include?(p["id"])

      title = snap["intents"].find { |i| i["id"] == p["intentId"] }&.dig("title")
      say("escalated: #{p["id"]} \"#{title}\" (#{p["writeSet"].map { |w| w["path"] }.join(", ")}): #{p["reason"].to_s[0, 300]}")
      next unless opts[:approve]

      ft("review", colony, p["id"], "approve", "--by", "human-reviewer")
      approved << p["id"]
    end
  end
  cert_line = certification_line(snap)
  if cert_line != last_cert
    say("certification: #{cert_line}") if cert_line
    last_cert = cert_line
  end
  if landed >= total
    done_at ||= Time.now
    # Trunk certification: the colony runs its own tests after landings and repairs a red trunk. Keep the
    # swarm until trunk is certified green with no repair intent open (or --certify-wait runs out).
    break if opts[:certify_wait].zero? || certified_green?(snap)
    break say("trunk not certified green #{opts[:certify_wait]} s after the last intent landed") if Time.now - done_at > opts[:certify_wait]
    last_progress = Time.now
  end
  break say("timeout after #{opts[:timeout]} s") if Time.now - t_new > opts[:timeout]
  break say("nothing landed for #{opts[:stall]} s") if Time.now - last_progress > opts[:stall]
end

# --- numbers --------------------------------------------------------------------
scene("Result")
wall = (done_at || Time.now) - t_new
snap = api!(:get, "/colonies/#{colony}", timeout: 60)
m = api!(:get, "/colonies/#{colony}/metrics", timeout: 60)["metrics"]
agents = api!(:get, "/colonies/#{colony}/agents?all=1&journal=1", timeout: 120)["agents"] || []
unless opts[:keep] || opts[:attach]
  code, data = api(:post, "/colonies/#{colony}/swarm/stop", { reason: "spec done" })
  say(code.between?(200, 299) ? "swarm stopped" : "swarm stop answered #{code}: #{redact(data.inspect)[0, 120]}")
end
begin
  Process.kill("INT", watch_pid)
  Process.wait(watch_pid)
rescue StandardError
  nil
end

per_model = Hash.new { |h, k| h[k] = { agents: 0, calls: 0, in: 0, out: 0, landed: 0, returned: 0, abandoned: 0, throttled: 0 } }
agents.each do |a|
  x = per_model[a["model"] || "?"]
  c = a["counters"] || {}
  x[:agents] += 1
  x[:calls] += c["llmCalls"].to_i
  x[:in] += c["tokensIn"].to_i
  x[:out] += c["tokensOut"].to_i
  x[:landed] += c["landed"].to_i
  x[:returned] += c["returned"].to_i
  x[:abandoned] += c["abandoned"].to_i
  x[:throttled] += c["throttled"].to_i
  # Calls an intent routed to another model ("model": "default") are counted under that model too: move them.
  c.each do |key, value|
    other = key[/\AllmCalls:(.+)\z/, 1] || key[/\AtokensIn:(.+)\z/, 1] || key[/\AtokensOut:(.+)\z/, 1]
    next unless other

    field = { "llmCalls" => :calls, "tokensIn" => :in, "tokensOut" => :out }.fetch(key.split(":").first)
    x[field] -= value.to_i
    per_model[other][field] += value.to_i
  end
end
agent_usd = per_model.sum do |model, x|
  pin, pout = PRICES.fetch(model, [1.0, 4.0])
  x[:usd] = (x[:in] * pin + x[:out] * pout) / 1_000_000.0
end
clef_usd = m["decide.clef.tokens"].to_i * CLEF_PER_M / 1_000_000.0
s2_usd = (m["decide.llm.tokensIn"].to_i * SECOND_OPINION[0] + m["decide.llm.tokensOut"].to_i * SECOND_OPINION[1]) / 1_000_000.0
events = File.exist?(watch_log) ? File.readlines(watch_log).filter_map { |l| JSON.parse(l) rescue nil } : []
returns = events.select { |e| e["t"] == "proposal" && e["status"] == "returned" }

landed = snap["intents"].count { |i| i["status"] == "landed" && i["source"] != "certify" }
since = opts[:attach] ? "attaching" : "ft new"
say(done_at ? "all #{total} intents landed #{wall.round(1)} s after #{since}" : "#{landed}/#{total} intents landed after #{wall.round(1)} s")
say(format("landings %d, proposals %d, returned %d, rejected %d, escalated %d (approved by the script: %d), abandons %d",
           m["landings"].to_i, m["proposals"].to_i, m["returned"].to_i, m["rejected"].to_i, m["escalated"].to_i, approved.size, per_model.values.sum { |x| x[:abandoned] }))
returns.group_by { |e| e["reason"].to_s.split(/[:;(]/).first.to_s.strip[0, 60] }.sort_by { |_, v| -v.size }.each { |k, v| say("  #{v.size} x returned: #{k}") }
per_model.each do |model, x|
  say(format("%-36s %d agents, %3d calls, %7d in / %6d out tokens, %d throttled, landed %d, $%.4f", model, x[:agents], x[:calls], x[:in], x[:out], x[:throttled], x[:landed], x[:usd]))
end
say(format("decide: Clef %d tokens ($%.4f), second opinions and contest judges %d in / %d out ($%.4f)", m["decide.clef.tokens"].to_i, clef_usd, m["decide.llm.tokensIn"].to_i, m["decide.llm.tokensOut"].to_i, s2_usd))
spend = agent_usd + clef_usd + s2_usd
say(format("model spend: $%.4f (agents $%.4f + decide $%.4f)", spend, agent_usd, clef_usd + s2_usd))
# Cost per change: the whole spend (repairs included) over the intents that landed, spec and repair intents alike,
# counted in the same snapshot as the certification below.
landed_all = (snap.dig("metrics", "intentsLanded") || m["landedIntents"]).to_i
repairs_landed = snap["intents"].count { |i| i["status"] == "landed" && i["source"] == "certify" }
if landed_all.positive?
  say(format("cost per landed intent: $%.4f (%d intent%s landed, %d of them repair%s)", spend / landed_all, landed_all, landed_all == 1 ? "" : "s", repairs_landed, repairs_landed == 1 ? "" : "s"))
  cert = snap.dig("colony", "certification")
  head = snap.dig("colony", "trunkSha").to_s
  if cert && cert["status"] == "green" && cert["trunkSha"] == head
    # Trunk is one line of commits, so every landing is in its head: when the head is certified green, every landed intent is.
    k = cert["counts"] || {}
    say(format("cost per certified intent: $%.4f (trunk %s certified green, %d/%d tests pass; all %d landed intents are in it)", spend / landed_all, head[0, 7], k["pass"].to_i, k["tests"].to_i, landed_all))
  elsif cert
    why = cert["trunkSha"] == head ? "certification #{cert['status']}" : "no certification of it yet"
    say("cost per certified intent: none, the head #{head[0, 7]} is not certified green (#{why})")
  else
    say("cost per certified intent: none, this server does not certify trunk")
  end
end

# --- 4. a plain clone -------------------------------------------------------------
scene("Plain git clone of trunk")
# With asynchronous publishing (FT_ASYNC_PUBLISH) a landing counts once the trunk writer records it; wait until the
# trunk repository has every recorded commit, so the clone is the trunk the colony reports.
60.times do
  pub = snap.dig("colony", "publish")
  break unless pub.is_a?(Hash) && pub["unpublished"].to_i.positive?

  say("waiting for #{pub["unpublished"]} recorded landing(s) to be published")
  sleep 2
  _, snap = api(:get, "/colonies/#{colony}")
end
trunk = snap.dig("colony", "trunk") || {}
# A short-lived read token from wrangler (your Cloudflare login); it is never printed.
raw, st = Open3.capture2e("npx", "wrangler", "artifacts", "repos", "issue-token", trunk["name"].to_s, "--namespace", trunk["namespace"].to_s, "--scope", "read", "--ttl", "900", "--json", chdir: WORKER)
parsed = (JSON.parse(raw[/\{.*\}/m] || "{}") rescue {})
read_token = %w[plaintext token secret].filter_map { |k| parsed[k] || parsed.dig("result", k) }.find { |v| v.is_a?(String) && !v.empty? }
abort("could not issue a read token for #{trunk["name"]} (keys: #{parsed.keys.join(", ")}): #{raw.gsub(/"[^"]{40,}"/, '"<redacted>"')[0, 300]}") unless st.success? && read_token

dir = opts[:out] || Dir.mktmpdir("ft-#{colony}-")
FileUtils.mkdir_p(dir)
FileUtils.rm_rf(File.join(dir, colony))
clone = File.join(dir, colony)
_, ok = run(["git", "-c", "http.extraHeader=Authorization: Bearer #{read_token}", "clone", "--quiet", "--branch", "main", trunk["remote"], clone], chdir: dir)
abort("git clone failed") unless ok
files = `git -C #{clone} ls-files`.lines.map(&:strip)
say("cloned #{files.size} files to #{clone} (trunk #{`git -C #{clone} rev-parse --short HEAD`.strip}, #{`git -C #{clone} rev-list --count HEAD`.strip} commits)")
say("files: #{files.join(", ")}")

def tap_summary(out)
  counts = %w[tests pass fail].to_h { |k| [k, out[/^ℹ #{k} (\d+)/, 1].to_i] }
  ms = out[/^ℹ duration_ms ([\d.]+)/, 1].to_f
  [counts, ms]
end

scene("node --test (the colony's own suite, nothing installed, none of this shell's environment)")
out, = run_untrusted([NODE, "--test"], chdir: clone)
counts, ms = tap_summary(out)
say(format("node --test: %d tests, %d pass, %d fail in %.0f ms", counts["tests"], counts["pass"], counts["fail"], ms))
head_sha = `git -C #{clone} rev-parse HEAD`.strip
code, cert = api(:get, "/colonies/#{colony}/certifications/#{head_sha}")
if code == 200 && cert["counts"]
  k = cert["counts"]
  same = k["tests"] == counts["tests"] && k["pass"] == counts["pass"] && k["fail"] + k["cancelled"] == counts["fail"]
  say(format("certification of %s: %s, %d tests, %d pass, %d fail in %d ms%s: %s node --test", head_sha[0, 7], cert["status"], k["tests"], k["pass"], k["fail"] + k["cancelled"],
             cert["durationMs"].to_i, cert["reusedFrom"] ? " (reused from #{cert['reusedFrom'][0, 7]})" : "", same ? "matches" : "DIFFERS from"))
  repairs = snap["intents"].select { |i| i["source"] == "certify" }
  repairs.each { |i| say("repair intent #{i['id']} #{i['status']}: #{i['title'][0, 110]}") }
else
  say("no certification recorded for #{head_sha[0, 7]} (HTTP #{code})")
end
out.lines.grep(/^not ok|^# Subtest|✖/).first(30).each { |l| puts "  #{l}" } if counts["fail"].positive? || counts["tests"].zero?

ref = File.join(opts[:reference], "test/acceptance.test.ts")
if File.exist?(ref)
  scene("Reference acceptance suite A1-A7 against the colony's code")
  FileUtils.cp(ref, File.join(clone, "test/reference-acceptance.test.ts"))
  out, = run_untrusted([NODE, "--test", "test/reference-acceptance.test.ts"], chdir: clone)
  counts, ms = tap_summary(out)
  say(format("reference acceptance: %d/%d pass in %.0f ms", counts["pass"], counts["tests"], ms))
  out.lines.grep(/^not ok|✖|AssertionError|expected|actual/).first(40).each { |l| puts "  #{l}" } if counts["fail"].positive?
  FileUtils.rm_f(File.join(clone, "test/reference-acceptance.test.ts"))
end

scene("The spec's rules on every file of trunk")
IMPORT = /(?:^|[;\s])(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|(?:^|[;\s])import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/
glob = ->(g, path) { File.fnmatch(g, path, File::FNM_DOTMATCH | File::FNM_EXTGLOB) }
spec["rules"].each_with_index do |rule, idx|
  s = rule["spec"]
  hits = []
  if rule["kind"] == "forbid-pattern"
    re = Regexp.new(s["pattern"])
    scope = files.select { |f| Array(s["include"] || ["**"]).any? { |g| glob.(g, f) } && Array(s["exclude"]).none? { |g| glob.(g, f) } }
    scope.each { |f| File.readlines(File.join(clone, f)).each_with_index { |l, n| hits << "#{f}:#{n + 1}" if re.match?(l) } }
  else
    re = Regexp.new(s["module"])
    scope = files.select { |f| f.match?(/\.[cm]?[jt]sx?\z/) && Array(s["from"]).any? { |g| glob.(g, f) } }
    scope.each do |f|
      File.read(File.join(clone, f)).scan(IMPORT).flatten.compact.each { |spec_| hits << "#{f}: #{spec_}" if re.match?(spec_) }
    end
  end
  say(format("rule %d %-58s %d file(s) checked, %d violation(s)%s", idx + 1, rule["description"][0, 58], scope.size, hits.size, hits.empty? ? "" : ": #{hits.first(5).join(", ")}"))
end
say("done in #{(Time.now - T0).round(1)} s; clone kept at #{clone}")
