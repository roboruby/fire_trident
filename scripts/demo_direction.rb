#!/usr/bin/env ruby
# frozen_string_literal: true

# Changing direction mid-flight, on a live deployment, in one command per scenario:
#
#   ruby scripts/demo_direction.rb steer    [--name direction-steer]
#     An empty colony with two small intents and two agents. While an agent is working on the
#     first intent, its why is amended (revision 2); while another works on the second, it gets a
#     directive. Prints how fast each agent re-planned and what landed, then reads the lineage.
#
#   ruby scripts/demo_direction.rb retract  [--name direction-retract] [--repo URL] [--agents 6]
#     Imports a repository, declares a rule, releases a swarm, and retracts the rule once work
#     on it is landing and in flight. Prints how many intents were withdrawn, how fast every agent
#     let go, and whether anything landed for the rule afterwards.
#
# Who acted: every amendment, directive, retraction and intent is recorded with `by` taken from
# FT_USER (default "operator-script"), so lineage never claims a person did what a script did.
# Escalated proposals are never approved here: they wait in the review tab for a person.
#
# Reads FT_URL and FT_TOKEN from the environment or ~/.config/firetrident/env. Never prints tokens.
require "json"
require "net/http"
require "open3"
require "optparse"
require "uri"

ROOT = File.expand_path("..", __dir__)
FT = ["node", File.join(ROOT, "packages/cli/src/ft.ts")].freeze
MODEL = "@cf/google/gemma-4-26b-a4b-it"
BY = ENV.fetch("FT_USER", "operator-script")
# Steer while the holder is producing or has produced work.
STEER_STEPS = %w[produce commit push propose await].freeze

mode = ARGV.shift
abort("usage: ruby scripts/demo_direction.rb steer|retract [options]") unless %w[steer retract].include?(mode)
opts = { name: "direction-#{mode}", repo: "https://github.com/hexojs/hexo", agents: 6, replace: false, out: nil }
OptionParser.new do |o|
  o.on("--name NAME", "Colony name (default direction-#{mode})") { |v| opts[:name] = v }
  o.on("--repo URL", "Repository to import for retract (default hexojs/hexo)") { |v| opts[:repo] = v }
  o.on("--agents N", Integer, "Swarm size for retract (default 6)") { |v| opts[:agents] = v }
  o.on("--replace", "Delete an existing colony with this name first") { opts[:replace] = true }
  o.on("--out FILE", "Write the summary JSON here") { |v| opts[:out] = File.expand_path(v) }
end.parse!

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
  text.to_s.gsub(/art_v\d+_[A-Za-z0-9._~+\/=-]+/, "<redacted>").gsub(TOKEN, "<redacted>")
end

def say(line)
  puts format("[%6.1fs] %s", Time.now - T0, redact(line))
  $stdout.flush
end

def api(method, path, body = nil, timeout: 120)
  uri = URI("#{BASE}/api#{path}")
  klass = { get: Net::HTTP::Get, post: Net::HTTP::Post, patch: Net::HTTP::Patch, delete: Net::HTTP::Delete }.fetch(method)
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

def ft(*args)
  out, = Open3.capture2e({ "NO_COLOR" => "1", "FT_URL" => BASE, "FT_TOKEN" => TOKEN }, *FT, *args, chdir: ROOT)
  redact(out)
end

def snapshot(colony) = api!(:get, "/colonies/#{colony}", timeout: 60)
def agents(colony) = api!(:get, "/colonies/#{colony}/agents")["agents"]

# Escalations wait for a person; say so once per proposal.
$escalated = {}
def report_escalations(colony)
  api!(:get, "/colonies/#{colony}/review").each do |p|
    next if $escalated[p["id"]]

    $escalated[p["id"]] = true
    say "  waiting for a person: #{p['id']} escalated (#{p['reason'].to_s[0, 120]}); review it at #{BASE}/c/#{colony}?tab=review"
  end
end

def fresh_colony(name, replace)
  code, = api(:get, "/colonies/#{name}")
  return unless code == 200
  abort("colony #{name} exists; pass --replace to delete it first, or --name to pick another") unless replace

  say "deleting the previous #{name} colony"
  api(:post, "/colonies/#{name}/swarm/stop", { reason: "demo reset" })
  api!(:delete, "/colonies/#{name}", timeout: 600)
end

def steer(opts)
  fresh_colony(opts[:name], opts[:replace])
  colony = api!(:post, "/colonies", { name: opts[:name], pool: 4 }, timeout: 180)["id"]
  say "colony #{colony} (empty trunk): #{BASE}/c/#{colony}"
  greet = api!(:post, "/colonies/#{colony}/intents", {
    title: "Create src/greeting.ts",
    why: "Export a function `greet(name: string): string` that returns the English greeting `Hello, ${name}!`. Keep the file small: one exported function with a one-line doc comment.",
    footprint: ["src/greeting.ts"], priority: 2, createdBy: BY
  })
  bye = api!(:post, "/colonies/#{colony}/intents", {
    title: "Create src/farewell.ts",
    why: "Export a function `farewell(name: string): string` that returns `Goodbye, ${name}.`. Keep the file small: one exported function with a one-line doc comment.",
    footprint: ["src/farewell.ts"], priority: 2, createdBy: BY
  })
  swarm = api!(:post, "/colonies/#{colony}/swarm", { count: 2, kind: "internal", model: MODEL }, timeout: 120)
  say "swarm: #{swarm['started']} agents (#{swarm['model']})"

  amended = directed = nil
  landed = {}
  deadline = Time.now + 900
  until Time.now > deadline || landed.size == 2
    snap = snapshot(colony)
    list = agents(colony)
    holder = ->(iid) { list.find { |a| a["intentId"] == iid } }
    if amended.nil? && (h = holder.(greet["id"])) && STEER_STEPS.include?(h["step"])
      t = Time.now
      res = api!(:patch, "/colonies/#{colony}/intents/#{greet['id']}", {
        why: "Export a function `greet(name: string): string` that returns the French greeting `Bonjour, ${name} !` (French typography: a space before the exclamation mark). Keep the file small: one exported function with a one-line doc comment.",
        reason: "the UI is French now", by: BY
      })
      amended = { at: t, agent: h["id"], step: h["step"], revision: res.dig("revision", "revision"), returned: res["returned"] }
      say "AMENDED #{greet['id']} while #{h['id']} was at #{h['step']}: now r#{amended[:revision]}"
    end
    if directed.nil? && (h = holder.(bye["id"])) && STEER_STEPS.include?(h["step"])
      t = Time.now
      res = api!(:post, "/colonies/#{colony}/agents/#{h['id']}/directive", { message: "Also export a constant FAREWELL_VERSION = 2 from this file, declared above the function.", by: BY })
      directed = { at: t, agent: h["id"], step: h["step"], delivery: res["delivery"] }
      say "DIRECTED #{h['id']} at #{h['step']} (delivery #{res['delivery']})"
    end
    report_escalations(colony)
    [greet, bye].each do |i|
      next if landed[i["id"]] || snap["intents"].find { |x| x["id"] == i["id"] }&.dig("status") != "landed"

      landed[i["id"]] = Time.now
      say "LANDED #{i['title']}"
    end
    sleep 0.25
  end
  api(:post, "/colonies/#{colony}/swarm/stop", { reason: "direction demo done" })
  say "lineage, src/greeting.ts:\n#{ft('why', colony, 'src/greeting.ts')}"
  say "lineage, src/farewell.ts:\n#{ft('why', colony, 'src/farewell.ts')}"
  {
    colony: colony, url: "#{BASE}/c/#{colony}", by: BY,
    amended: amended&.slice(:agent, :step, :revision, :returned),
    amend_to_land_s: amended && landed[greet["id"]] ? (landed[greet["id"]] - amended[:at]).round(1) : nil,
    directed: directed&.slice(:agent, :step, :delivery),
    direct_to_land_s: directed && landed[bye["id"]] ? (landed[bye["id"]] - directed[:at]).round(1) : nil,
    escalated: $escalated.keys
  }
end

def retract(opts)
  fresh_colony(opts[:name], opts[:replace])
  say "importing #{opts[:repo]} as #{opts[:name]}"
  colony = api!(:post, "/colonies", { name: opts[:name], source: { url: opts[:repo] }, regionDepth: 3, pool: opts[:agents] + 2 }, timeout: 300)["id"]
  60.times do
    break if (snapshot(colony)["files"] || []).size.positive?

    sleep 2
  end
  say "imported #{snapshot(colony)['files'].size} files: #{BASE}/c/#{colony}"
  rule = api!(:post, "/colonies/#{colony}/rules", {
    kind: "forbid-pattern",
    spec: {
      pattern: "(\\bfrom\\s*|\\bimport\\s*\\(\\s*|\\brequire\\(\\s*)([\"'])(path|fs/promises|fs|os|module|child_process|crypto|url|http|https|util|events|stream|readline|zlib|assert|buffer|net|tty|worker_threads|perf_hooks|timers|v8|vm|dns|querystring|string_decoder|async_hooks)\\2",
      flags: "g", include: ["lib/**/*.ts"],
      hint: "Import Node built-ins with the node: protocol ('fs' becomes 'node:fs'). Change nothing else."
    },
    description: "Node built-ins are imported with the node: protocol", approvedBy: BY
  }, timeout: 180)
  rid = rule.dig("rule", "id")
  say "rule #{rid}: #{rule['violations']} violations, #{rule['intents']} intents"
  swarm = api!(:post, "/colonies/#{colony}/swarm", { count: opts[:agents], kind: "internal", model: MODEL }, timeout: 120)
  say "swarm: #{swarm['started']} agents (#{swarm['model']})"
  ids = snapshot(colony)["intents"].select { |i| i["ruleId"] == rid }.map { |i| i["id"] }
  t_start = Time.now
  loop do
    snap = snapshot(colony)
    landed_n = snap["intents"].count { |i| i["ruleId"] == rid && i["status"] == "landed" }
    proposed = snap["intents"].count { |i| i["ruleId"] == rid && i["status"] == "proposed" }
    working = agents(colony).count { |a| ids.include?(a["intentId"]) }
    say "  landed #{landed_n}, proposed #{proposed}, agents holding #{working}"
    report_escalations(colony)
    break if (landed_n >= 1 && working >= 2 && proposed >= 1) || Time.now - t_start > 240

    sleep 3
  end
  landed_before = snapshot(colony)["intents"].count { |i| i["ruleId"] == rid && i["status"] == "landed" }
  say "RETRACTING the rule (#{landed_before} intents landed so far)"
  t0 = Time.now
  reason = URI.encode_www_form_component("the node: protocol is not wanted here after all")
  res = api!(:delete, "/colonies/#{colony}/rules/#{rid}?reason=#{reason}&by=#{URI.encode_www_form_component(BY)}", nil, timeout: 120)
  t_api = Time.now - t0
  say "retracted in #{t_api.round(2)} s: #{res['withdrawn']} intents withdrawn, #{res['returned']} in-flight change(s) returned"
  t_clear = nil
  while Time.now - t0 < 180
    if agents(colony).none? { |a| ids.include?(a["intentId"]) }
      t_clear = Time.now - t0
      break
    end
    sleep 0.25
  end
  say "no agent holds a rule intent after #{t_clear&.round(2)} s; watching 75 s for late landings"
  sleep 75
  final = snapshot(colony)
  landed_after = final["intents"].count { |i| i["ruleId"] == rid && i["status"] == "landed" } - landed_before
  api(:post, "/colonies/#{colony}/swarm/stop", { reason: "direction demo done" })
  {
    colony: colony, url: "#{BASE}/c/#{colony}", by: BY, rule: rid, violations: rule["violations"], intents: ids.size,
    landed_before: landed_before, withdrawn: res["withdrawn"], returned_in_flight: res["returned"],
    retract_api_s: t_api.round(2), agents_clear_s: t_clear&.round(2), rule_intents_landed_after: landed_after,
    escalated: $escalated.keys
  }
end

summary = mode == "steer" ? steer(opts) : retract(opts)
say "SUMMARY #{JSON.pretty_generate(summary)}"
File.write(opts[:out], "#{JSON.pretty_generate(summary)}\n") if opts[:out]
