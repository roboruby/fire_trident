#!/usr/bin/env ruby
# frozen_string_literal: true

# Checks a colony's spend per intent (FT_INTENT_SPEND) against its spend in total, after a run:
#
#   1. GET /api/colonies/<id>: the colony's `spend` and its `intentSpend` map (the intents counted per intent)
#   2. sum the intents' dollars and hold the sum against the colony's total less the layers no intent carries
#      (the conflict resolver and antibody minting), within a tolerance
#   3. GET /api/colonies/<id>/intents/<intentId>/spend for one landed intent (the one asked for, else one with both
#      agent and review spend, else the most recently landed) and print what it cost, by layer and model
#
# Usage:
#   ruby scripts/intent_spend_check.rb <colony> [--url URL] [--intent ID] [--tolerance USD] [--from snapshot.json]
#
# Public reads only: no token is needed. Reads FT_URL from the environment or ~/.config/firetrident/env (--url wins).
# --from checks a saved snapshot instead of calling the server (no intent read then). Exits 1 when the sum is off or
# the intent shows no agent spend.
require "json"
require "net/http"
require "optparse"
require "uri"

DEFAULT_URL = "https://firetrident.mattsolt.workers.dev"
# Layers the colony counts but no intent carries: their dollars are the expected gap.
UNCOUNTED_LAYERS = %w[resolver other].freeze
LAYER_TEXT = { "agents" => "agents", "review" => "review", "judge" => "contest judge", "resolver" => "conflict resolver", "other" => "other" }.freeze

opts = { url: nil, intent: nil, tolerance: nil, from: nil }
parser = OptionParser.new do |o|
  o.banner = "Usage: ruby scripts/intent_spend_check.rb <colony> [options]"
  o.on("--url URL", "Server (default: FT_URL, or #{DEFAULT_URL})") { |v| opts[:url] = v }
  o.on("--intent ID", "The intent to read (default: one with agent and review spend, else the latest landed)") { |v| opts[:intent] = v }
  o.on("--tolerance USD", Float, "Allowed gap beyond the uncounted layers (default: 1e-5 plus 1% of the total)") { |v| opts[:tolerance] = v }
  o.on("--from FILE", "Check a saved GET /api/colonies/<id> answer instead of calling the server") { |v| opts[:from] = v }
end
parser.parse!
colony_id = ARGV[0]
abort(parser.banner) unless colony_id

def base_url(given)
  return given.sub(%r{/+\z}, "") if given
  file = File.expand_path("~/.config/firetrident/env")
  from_file = File.exist?(file) ? File.readlines(file).filter_map { |l| l.strip.split("=", 2) if l.include?("=") }.to_h : {}
  (ENV["FT_URL"] || from_file["FT_URL"] || DEFAULT_URL).sub(%r{/+\z}, "")
end

def get(base, path)
  uri = URI("#{base}/api#{path}")
  res = Net::HTTP.start(uri.host, uri.port, use_ssl: uri.scheme == "https", read_timeout: 60, open_timeout: 30) { |h| h.request(Net::HTTP::Get.new(uri)) }
  abort("GET #{path} answered #{res.code}: #{res.body.to_s[0, 300]}") unless res.code.to_i == 200
  JSON.parse(res.body)
end

# Dollars as FireTrident shows them: four decimals below one cent, three below a dollar, else two.
def usd(v)
  v = v.to_f
  v = 0.0 unless v.finite? && v.positive?
  format(v < 0.01 ? "$%.4f" : v < 1 ? "$%.3f" : "$%.2f", v)
end

def layer_line(by_layer)
  LAYER_TEXT.filter_map { |k, text| "#{text} #{usd(by_layer[k])}" if by_layer.is_a?(Hash) && by_layer[k].to_f.positive? }.join(", ")
end

# --- 1. the colony ----------------------------------------------------------------------------------------------
base = base_url(opts[:url])
snapshot = opts[:from] ? JSON.parse(File.read(opts[:from])) : get(base, "/colonies/#{colony_id}")
spend = snapshot["spend"]
abort("#{colony_id}: the colony reports no spend (no model calls counted, or a server before round 8)") unless spend.is_a?(Hash) && spend["usd"].is_a?(Numeric)
map = snapshot["intentSpend"]
map = {} unless map.is_a?(Hash)
intents = (snapshot["intents"] || []).select { |i| i.is_a?(Hash) }
landed = intents.select { |i| i["status"] == "landed" }
puts "colony #{colony_id}: #{usd(spend["usd"])} of model calls (#{layer_line(spend["byLayer"])}); #{spend["landedIntents"]} intents landed, " \
     "#{spend["tokens"]&.dig("input")} input / #{spend["tokens"]&.dig("output")} output tokens, prices of #{spend["priceDate"]}"
puts "  #{spend["agentsUnread"]} in-platform agents not read yet: their calls are in neither sum" if spend["agentsUnread"].to_i.positive?
abort("#{colony_id}: no intent was counted per intent (is FT_INTENT_SPEND on for this colony? it must be on before the run starts)") if map.empty?

# --- 2. the sum over intents -----------------------------------------------------------------------------------
sum = map.values.sum { |b| b.is_a?(Hash) ? b["usd"].to_f : 0.0 }
by_layer = Hash.new(0.0)
map.each_value do |b|
  next unless b.is_a?(Hash) && b["byLayer"].is_a?(Hash)
  b["byLayer"].each { |l, x| by_layer[l] += x.is_a?(Hash) ? x["usd"].to_f : 0.0 }
end
uncounted = UNCOUNTED_LAYERS.sum { |l| spend.dig("byLayer", l).to_f }
expected = spend["usd"].to_f - uncounted
tolerance = opts[:tolerance] || (1e-5 + 0.01 * spend["usd"].to_f)
gap = sum - expected
puts "intents counted per intent: #{map.size} (of #{intents.size} in the snapshot, #{landed.size} landed)"
puts "  sum over intents: #{usd(sum)} (#{layer_line(by_layer)})"
puts "  colony total less the uncounted layers (#{UNCOUNTED_LAYERS.map { |l| LAYER_TEXT[l] }.join(" and ")}, #{usd(uncounted)}): #{usd(expected)}"
puts format("  gap: %+.8f (tolerance %.8f)", gap, tolerance)
puts "  calls made before FT_INTENT_SPEND was on, and journals read since the map was built, also widen the gap" if gap.abs > tolerance
ok_sum = gap.abs <= tolerance
puts ok_sum ? "  OK: the intents add up to the colony's spend" : "  FAIL: the intents do not add up to the colony's spend"

# --- 3. one landed intent --------------------------------------------------------------------------------------
pick = opts[:intent]
pick ||= landed.map { |i| i["id"] }.find { |id| map[id].is_a?(Hash) && map[id]["byLayer"].is_a?(Hash) && map[id]["byLayer"]["agents"] && map[id]["byLayer"]["review"] }
pick ||= landed.max_by { |i| i["updatedAt"].to_i }&.dig("id")
abort("#{colony_id}: no landed intent to read") unless pick
if opts[:from]
  brief = map[pick]
  puts "intent #{pick} (from the saved snapshot): #{brief ? "#{usd(brief["usd"])} of model calls" : "nothing counted"}"
  exit(ok_sum && brief.is_a?(Hash) ? 0 : 1)
end
detail = get(base, "/colonies/#{colony_id}/intents/#{pick}/spend")
title = intents.find { |i| i["id"] == pick }&.dig("title")
puts "intent #{pick}#{title ? " \"#{title}\"" : ""}: #{usd(detail["usd"])} of model calls"
calls = detail["calls"] || {}
LAYER_TEXT.each do |k, text|
  next unless calls[k].to_i.positive? || detail.dig("byLayer", k).to_f.positive?
  puts "  #{text}: #{usd(detail.dig("byLayer", k))} in #{calls[k].to_i} call#{calls[k].to_i == 1 ? "" : "s"}"
end
(detail["byModel"] || {}).each { |m, t| puts "  #{m}: #{t["input"]} input / #{t["output"]} output tokens, #{t["usd"].nil? ? "no list price" : usd(t["usd"])}" }
puts "  note: #{detail["note"]}" if detail["note"]
puts "  the intent's changes landed on deterministic proof without a model call in review, so only its agents spent" if calls["agents"].to_i.positive? && calls["review"].to_i.zero?
ok_intent = calls["agents"].to_i.positive? && detail["tokens"].to_h.values.sum.to_i.positive?
puts ok_intent ? "  OK: the intent shows what its takes cost" : "  FAIL: the intent shows no agent spend"
exit(ok_sum && ok_intent ? 0 : 1)
