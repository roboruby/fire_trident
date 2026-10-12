#!/usr/bin/env ruby
# frozen_string_literal: true

# The FireTrident video run on Hono, start to finish, in one command:
#
#   1. import honojs/hono as a fresh colony (regions at depth 3, a warm workspace pool)
#   2. land the prerequisite as a human intent: tsconfig.base.json gains
#      "rewriteRelativeImportExtensions": true, so .ts specifiers typecheck and build
#   3. declare the rule "relative imports name their file" (forbid-import form)
#   4. release a swarm of real LLM agents and follow the violation counter to zero
#   5. print the numbers: wall time, landings/min, returns, abandons, tokens, cost
#   6. optionally (--payoff) land the human follow-up: drop "sloppy-imports" from jsr.json
#
# Usage:
#   ruby scripts/demo_hono.rb [--name hono] [--agents 80] [--model SPEC] [--pool N]
#                             [--replace] [--skip-prereq] [--payoff] [--timeout 1800]
#                             [--keep-running] [--dry-run]
#
# --model takes one Workers AI model id or a mix such as
#   "@cf/moonshotai/kimi-k2.7-code=4,@cf/zai-org/glm-5.3-flash=4,@cf/openai/gpt-oss-120b=12,@cf/google/gemma-4-26b-a4b-it"
# ("=N" pins N agents to a model; the rest are split over the others). Models that need
# Workers Paid (kimi-k2.7-code, glm-5.3-flash) are limited to 20 requests a minute per
# account, so a large swarm should lean on models with the 300 a minute default.
#
# Reads FT_URL and FT_TOKEN from the environment or ~/.config/firetrident/env. Never
# prints tokens. Needs Node 24 for the ft CLI (packages/cli/src/ft.ts).
require "json"
require "net/http"
require "optparse"
require "open3"
require "tmpdir"
require "uri"

ROOT = File.expand_path("..", __dir__)
FT = ["node", File.join(ROOT, "packages/cli/src/ft.ts")].freeze
HONO = "https://github.com/honojs/hono"
DEFAULT_MODEL = "@cf/moonshotai/kimi-k2.7-code=4,@cf/zai-org/glm-5.3-flash=4,@cf/openai/gpt-oss-120b=12,@cf/google/gemma-4-26b-a4b-it"
PREREQ_MODEL = "@cf/moonshotai/kimi-k2.7-code"

# USD per million tokens (input, output), Workers AI list prices on 2026-10-12.
PRICES = {
  "@cf/moonshotai/kimi-k2.7-code" => [0.95, 4.0],
  "@cf/zai-org/glm-5.3-flash" => [0.15, 0.5],
  "@cf/openai/gpt-oss-120b" => [0.35, 0.75],
  "@cf/openai/gpt-oss-20b" => [0.2, 0.3],
  "@cf/google/gemma-4-26b-a4b-it" => [0.1, 0.3],
  "@cf/qwen/qwen3.8-27b" => [0.45, 3.2],
  "@cf/zai-org/glm-4.7-flash" => [0.0605, 0.4]
}.freeze

RULE = {
  from: ["src/**/*.ts", "src/**/*.tsx"],
  module: '^\.\.?(?:/.*)?(?<!\.ts|\.tsx|\.json)$',
  hint: 'Name the file in every relative import: ./x becomes ./x.ts when x.ts exists; a directory ./d becomes ./d/index.ts ' \
        '(".", ".." and "../.." are directories). Check the tree. Change nothing else.',
  description: "Relative imports in src name their file, so Hono runs on Deno, JSR and Node built-in TypeScript " \
               "without the unstable sloppy-imports flag."
}.freeze

PREREQ = {
  title: "Let TypeScript accept .ts import specifiers",
  why: "The coming rule makes every relative import in src name its file (./x.ts). TypeScript rejects .ts specifiers " \
       "(TS5097) unless a compiler option allows them. rewriteRelativeImportExtensions is a real compilerOptions flag, " \
       "added in TypeScript 5.7 (November 2024): it accepts relative .ts specifiers and rewrites them to .js when emitting. " \
       "Hono builds with TypeScript 6.0.3, so the flag is available. This must land before the rule's intents.",
  footprint: ["tsconfig.base.json"],
  acceptance: [
    'compilerOptions in tsconfig.base.json contains "rewriteRelativeImportExtensions": true',
    "No other option, file or formatting changes"
  ],
  priority: 10
}.freeze

PAYOFF = {
  title: "Publish to JSR without sloppy imports",
  why: "Every relative import in src now names its file, so JSR no longer needs the unstable sloppy-imports flag.",
  footprint: ["jsr.json"],
  acceptance: ['jsr.json no longer contains the "unstable": ["sloppy-imports"] entry', "Everything else in jsr.json is unchanged"],
  priority: 10
}.freeze

opts = { name: "hono", agents: 80, model: DEFAULT_MODEL, pool: nil, replace: false, prereq: true, payoff: false,
         timeout: 1800, keep: false, dry: false, stall: 300 }
OptionParser.new do |o|
  o.banner = "Usage: ruby scripts/demo_hono.rb [options]"
  o.on("--name NAME", "Colony name (default hono)") { |v| opts[:name] = v }
  o.on("--agents N", Integer, "Swarm size (default 80)") { |v| opts[:agents] = v }
  o.on("--model SPEC", "Model id or mix (default: #{DEFAULT_MODEL})") { |v| opts[:model] = v }
  o.on("--pool N", Integer, "Warm workspace pool (default: agents + 4, at most 256)") { |v| opts[:pool] = v }
  o.on("--replace", "Delete an existing colony with this name first") { opts[:replace] = true }
  o.on("--skip-prereq", "Do not land the tsconfig prerequisite") { opts[:prereq] = false }
  o.on("--payoff", "After zero, land the jsr.json follow-up") { opts[:payoff] = true }
  o.on("--timeout S", Integer, "Give up on the swarm after S seconds (default 1800)") { |v| opts[:timeout] = v }
  o.on("--stall S", Integer, "Stop when nothing lands for S seconds (default 300)") { |v| opts[:stall] = v }
  o.on("--keep-running", "Leave the swarm running at the end") { opts[:keep] = true }
  o.on("--dry-run", "Print the plan and exit") { opts[:dry] = true }
end.parse!
opts[:pool] ||= [opts[:agents] + 4, 256].min

def load_env
  file = File.expand_path("~/.config/firetrident/env")
  from_file = File.exist?(file) ? File.readlines(file).filter_map { |l| l.strip.split("=", 2) if l.include?("=") }.to_h : {}
  url = ENV["FT_URL"] || from_file["FT_URL"] || "https://firetrident.mattsolt.workers.dev"
  token = ENV["FT_TOKEN"] || from_file["FT_TOKEN"]
  abort("FT_TOKEN is not set (environment or ~/.config/firetrident/env)") unless token && !token.empty?
  [url.sub(%r{/+\z}, ""), token]
end

BASE, TOKEN = load_env
T0 = Time.now

def redact(text)
  text.to_s.gsub(/art_v\d+_\S+/, "<redacted>").gsub(TOKEN, "<redacted>")
end

def say(line)
  puts format("[%6.1fs] %s", Time.now - T0, line)
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
  req["Authorization"] = "Bearer #{TOKEN}"
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

# Run the ft CLI and echo it like a terminal session, so the video shows the real commands.
def ft(*args)
  shown = args.map { |a| a.match?(/[\s'"$\\*?(){}|<>]/) ? "'#{a.gsub("'", "'\\\\''")}'" : a }.join(" ")
  puts "$ ft #{shown}"
  out, st = Open3.capture2e(*FT, *args, chdir: ROOT)
  puts redact(out).lines.map { |l| "  #{l}" }.join
  raise "ft #{args.first} failed" unless st.success?

  out
end

def snapshot(id) = api!(:get, "/colonies/#{id}", timeout: 60)
def metrics(id) = api!(:get, "/colonies/#{id}/metrics", timeout: 60)

def intent_status(id, intent_id)
  snapshot(id)["intents"].find { |i| i["id"] == intent_id }&.dig("status")
end

def wait_for_intent(id, intent_id, label, timeout: 300)
  t = Time.now
  loop do
    st = intent_status(id, intent_id)
    return Time.now - t if st == "landed"
    raise "#{label}: still #{st} after #{timeout} s" if Time.now - t > timeout

    sleep 3
  end
end

def human_intent(id, spec)
  api!(:post, "/colonies/#{id}/intents", { colonyId: id, source: "human", createdBy: ENV.fetch("FT_USER", "matt") }.merge(spec))
end

def stop_swarm(id, reason)
  code, data = api(:post, "/colonies/#{id}/swarm/stop", { reason: reason })
  say(code.between?(200, 299) ? "swarm stopped (#{data["stopped"] || data["considered"] || "ok"})" : "swarm stop answered #{code}")
end

def cost_of(agents)
  per_model = Hash.new { |h, k| h[k] = { agents: 0, calls: 0, in: 0, out: 0, throttled: 0, landed: 0, returned: 0, abandoned: 0 } }
  agents.each do |a|
    m = per_model[a["model"] || "?"]
    c = a["counters"] || {}
    m[:agents] += 1
    m[:calls] += c["llmCalls"].to_i
    m[:in] += c["tokensIn"].to_i
    m[:out] += c["tokensOut"].to_i
    m[:throttled] += c["throttled"].to_i
    m[:landed] += c["landed"].to_i
    m[:returned] += c["returned"].to_i
    m[:abandoned] += c["abandoned"].to_i
  end
  per_model.each_value { |m| m[:usd] = 0.0 }
  per_model.each do |model, m|
    pin, pout = PRICES.fetch(model, [1.0, 4.0])
    m[:usd] = (m[:in] * pin + m[:out] * pout) / 1_000_000.0
  end
  per_model
end

colony = opts[:name].downcase.gsub(/[^a-z0-9-]+/, "-").gsub(/\A-+|-+\z/, "")
say("FireTrident demo on #{HONO} -> colony #{colony} at #{BASE}")
say("plan: pool #{opts[:pool]}, #{opts[:agents]} agents on #{opts[:model]}, prerequisite #{opts[:prereq] ? "on" : "off"}, payoff #{opts[:payoff] ? "on" : "off"}")
exit 0 if opts[:dry]

# --- 0. a fresh colony ----------------------------------------------------
code, existing = api(:get, "/colonies/#{colony}")
if code == 200
  abort("colony #{colony} exists; pass --replace to delete it first, or --name to pick another") unless opts[:replace]
  scene("Deleting the previous #{colony} colony")
  stop_swarm(colony, "demo reset")
  report = api!(:delete, "/colonies/#{colony}", timeout: 600)
  say("deleted: #{redact(report.slice("ok", "repos", "agents").to_json)[0, 200]}")
end

# --- 1. import ------------------------------------------------------------
scene("Import honojs/hono")
ft("import", HONO, "--name", colony, "--branch", "main", "--region-depth", "3", "--pool", opts[:pool].to_s, "--timeout", "900")
snap = snapshot(colony)
say("trunk #{snap.dig("colony", "trunkSha").to_s[0, 10]}: #{snap["files"].size} files")
# Forks come in batches of 8 (about 2 s each); give the pool a head start so first takes do not fork on demand.
warm = [(opts[:pool] / 8.0 * 2.5).ceil, 60].min
say("letting the workspace pool warm up for #{warm} s")
sleep warm

# --- 2. the prerequisite (human intent, one agent) ---------------------------
if opts[:prereq]
  scene("Prerequisite: a human intent lands first")
  intent = human_intent(colony, PREREQ)
  say("intent #{intent["id"]}: #{PREREQ[:title]} (#{PREREQ[:footprint].join(", ")})")
  ft("swarm", colony, "--agents", "1", "--model", PREREQ_MODEL)
  secs = wait_for_intent(colony, intent["id"], "prerequisite", timeout: 300)
  say("prerequisite landed in #{secs.round(1)} s")
end

# --- 3. the rule ----------------------------------------------------------
scene("Declare the rule")
args = ["rule", "import-boundary", colony]
RULE[:from].each { |g| args += ["--from", g] }
args += ["--module", RULE[:module], "--hint", RULE[:hint], "--description", RULE[:description]]
ft(*args)
m0 = metrics(colony)["metrics"]
say("violations: #{m0["violations"]}, open intents: #{m0["intentsOpen"]}, regions: #{m0["regions"]}")

# --- 4. the swarm ---------------------------------------------------------
scene("Release the swarm")
# Record the colony's proposal and landing events, for the breakdown of returns at the end.
watch_log = File.join(Dir.tmpdir, "ft-watch-#{colony}-#{Time.now.to_i}.jsonl")
watch_pid = spawn(*FT, "watch", colony, "--json", "--only", "proposal,landing,violations", out: watch_log, err: File::NULL, chdir: ROOT)
swarm_t0 = Time.now
ft("swarm", colony, "--agents", opts[:agents].to_s, "--model", opts[:model])
start_landings = m0["landings"].to_i
last_progress = Time.now
last_landed = m0["landedIntents"].to_i
first_zero = nil
loop do
  sleep 5
  m = begin
    metrics(colony)["metrics"]
  rescue StandardError => e
    say("metrics unavailable: #{redact(e.message)[0, 120]}")
    next
  end
  elapsed = Time.now - swarm_t0
  landings = m["landings"].to_i - start_landings
  say(format("violations %4d | intents open %3d claimed %3d proposed %3d landed %3d | landings %3d (%.1f/min, now %s/min) | returned %d | agents working %d",
             m["violations"].to_i, m["intentsOpen"].to_i, m["intentsClaimed"].to_i, m["intentsProposed"].to_i, m["landedIntents"].to_i,
             landings, landings / (elapsed / 60.0), m["landingsPerMin"], m["returned"].to_i, m["agentsWorking"].to_i))
  if m["landedIntents"].to_i > last_landed
    last_landed = m["landedIntents"].to_i
    last_progress = Time.now
  end
  if m["violations"].to_i.zero?
    first_zero = Time.now
    break
  end
  break if elapsed > opts[:timeout]
  break if Time.now - last_progress > opts[:stall]
end

# --- 5. numbers -----------------------------------------------------------
scene("Result")
wall = (first_zero || Time.now) - swarm_t0
m = metrics(colony)["metrics"]
landings = m["landings"].to_i - start_landings
agents = api!(:get, "/colonies/#{colony}/agents?journal=1&all=1", timeout: 120)["agents"] || []
models = cost_of(agents)
abandons = models.values.sum { |x| x[:abandoned] }
say(first_zero ? "violations reached 0 in #{wall.round(1)} s" : "stopped at #{m["violations"]} violations after #{wall.round(1)} s")
say(format("landings %d (%.1f per minute), intents landed %d, proposals returned %d, abandons %d, review queue %d",
           landings, landings / (wall / 60.0), m["landedIntents"].to_i, m["returned"].to_i, abandons, m["reviewQueue"].to_i))
models.each do |model, x|
  say(format("%-40s %3d agents, %4d calls, %7d in / %6d out tokens, %4d throttled waits, $%.4f",
             model, x[:agents], x[:calls], x[:in], x[:out], x[:throttled], x[:usd]))
end
say(format("model cost estimate: $%.4f", models.values.sum { |x| x[:usd] }))
begin
  Process.kill("INT", watch_pid)
  Process.wait(watch_pid)
rescue StandardError
  nil
end
events = File.exist?(watch_log) ? File.readlines(watch_log).filter_map { |l| JSON.parse(l) rescue nil } : []
returns = events.select { |e| e["t"] == "proposal" && e["status"] == "returned" }
causes = returns.group_by do |e|
  r = e["reason"].to_s
  if r.match?(/\A(llm|reflex|gate|innate|escalated by)/) then "returned by the decide gate (review)"
  elsif r.include?("stale") then "stale (trunk moved under it)"
  else "other: #{r[0, 60]}"
  end
end
causes.sort_by { |_, v| -v.size }.each { |k, v| say("  #{v.size} x #{k}") }
zero = events.find { |e| e["t"] == "violations" && e["total"].to_i.zero? }
say("violations event reached 0 at +#{((zero["at"] / 1000.0) - swarm_t0.to_f).round(1)} s (from the colony's own clock)") if zero
say("event log: #{watch_log}")

# --- 6. the payoff ----------------------------------------------------------
if opts[:payoff] && first_zero
  scene("Payoff: JSR without sloppy imports")
  intent = human_intent(colony, PAYOFF)
  say("intent #{intent["id"]}: #{PAYOFF[:title]}")
  secs = wait_for_intent(colony, intent["id"], "payoff", timeout: 300)
  say("jsr.json landed in #{secs.round(1)} s")
end

stop_swarm(colony, "demo finished") unless opts[:keep]
say("open #{BASE}/c/#{colony} for the colony map; ft why #{colony} src/index.ts:17 for the lineage of one line")
