#!/usr/bin/env ruby
# frozen_string_literal: true

# The contention smoke test: real-model agents in the platform on one small repository whose sixteen intents all change
# the same module (demo/contention/spec.md), with review on and the project's node:test tests certified on trunk. For
# each run, on a throwaway colony:
#
#   1. create colony contention-<time>-<agents> with review off, and land the seed (demo/contention/seed/, 20 files, in
#      path order) as one inline change by a scripted seed agent: no model is asked
#   2. wait until certification passes the seed's 23 tests on that commit (the baseline green)
#   3. switch review on, add the spec's rule, set the colony's spend cap to --max-usd, and declare the sixteen intents
#      (source human, equal priority), each with its acceptance lines and the spec's conventions as context
#   4. release N agents (POST /swarm, --model mix) and follow every --poll seconds until every intent landed and trunk
#      is certified green (or --settle runs out), or --timeout, or nothing lands for --stall, or the spend stop
#   5. stop the agents, let the changes in flight settle (at most 120 s), read the colony's record and compute the
#      report (scripts/contention_report.rb): intents landed; returns by cause and the cause-repeat rate; rounds and
#      model calls to land, per intent and by cause; semantic-conflict pairs that landed; red-trunk episodes and time
#      to green; the human queue; spend by model and per landed intent; wall time
#   6. grade: land the hidden acceptance tests (demo/contention/accept/, which no agent saw) as test/accept/ with
#      review and repairs off, and read which of them the colony's certification passes
#   7. delete the colony (--keep leaves it, with its agents stopped)
#
# --sweep 8,16 runs each count on its own fresh colony with the same intents, one after the other; --solo adds a run
# with one agent (--solo-model) for the paired solo-against-concurrent transitions. The results go to
# packages/bench/results/<date>-contention-<counts>/ (README.md labeled MEASURED, contention.json, one run-<n>.json per
# run with its record, and run.log), every file through the bench evidence redaction (packages/bench/src/evidence.ts).
#
# The spend stop: the colony's own spend cap (POST /spend-cap, --max-usd with a 10% review reserve) pauses its agents
# at the cap; and when this script reads a spend at or over --max-usd, or sees the cap's state leave "open", it trips
# the colony's pause switch (POST /pause), stops the swarm, reports, and starts no further run.
#
# Usage:
#   FT_TOKEN=<admin token> ruby scripts/contention.rb --base https://staging.firetrident.com [--agents 8 | --sweep 8,16]
#     [--solo] [--solo-model M] [--model SPEC] [--max-usd 15] [--timeout 2400] [--settle 600] [--stall 900] [--poll 5]
#     [--step-timeout 180] [--approve] [--no-grade] [--keep] [--name PREFIX] [--out DIR] [--note TEXT] [--dry-run]
#
# --model takes one model id or a mix as `ft swarm` does ("a=1,b=2,c": a and b pinned, the rest on c). --approve answers
# escalated changes as the human reviewer (off: they wait, and their time in the queue runs to the end). Behind
# Cloudflare Access, set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET. FT_TOKEN comes from the environment, else from
# ~/.config/firetrident/env when that file's FT_URL is this deployment. Never prints a token. Exit codes: 0 every run
# landed every intent and the results were written, 1 a run did not (the results are still written), 2 a setting is
# missing, 3 a step timed out before a run could report.
require "digest"
require "fileutils"
require "json"
require "optparse"
require "set"
require "stringio"
require "time"
require "tmpdir"
require "uri"
require_relative "stage"
require_relative "contention_report"

module Contention
  ROOT = File.expand_path("..", __dir__)
  DIR = File.join(ROOT, "demo", "contention")
  SPEC = File.join(DIR, "spec.md")
  SEED = File.join(DIR, "seed")
  ACCEPT = File.join(DIR, "accept")
  REFERENCE = File.join(DIR, "reference")
  # Where the hidden tests land in the colony to be graded, after the agents stop.
  ACCEPT_DIR = "test/accept"
  BY = ENV.fetch("FT_USER", "contention")
  # The demo's mix (scripts/demo_hono.rb), weighted to Gemma: two models limited to 20 requests a minute get one agent
  # each, gpt-oss-120b two, and Gemma (300 a minute) every other agent.
  DEFAULT_MODEL = "@cf/moonshotai/kimi-k2.7-code=1,@cf/zai-org/glm-5.3-flash=1,@cf/openai/gpt-oss-120b=2,@cf/google/gemma-4-26b-a4b-it"
  SOLO_MODEL = "@cf/google/gemma-4-26b-a4b-it"
  # Flags a run needs (GET /api/about), and flags whose absence leaves part of the report empty.
  REQUIRED_FLAGS = {
    "FT_INLINE" => "inline changes are off, and the seed and the grading land inline",
    "FT_TRUNK_TESTS" => "trunk certification is off, and the smoke test runs with certification on"
  }.freeze
  WANTED_FLAGS = {
    "FT_BISECT" => "no first red search: semantic-conflict culprits come from suspects or the red commit only",
    "FT_CULPRITS" => "no culprit suspects on red certifications",
    "FT_INTENT_SPEND" => "no model calls per intent: rounds are counted, calls to land are not"
  }.freeze
  SETTLED = %w[landed returned rejected escalated].freeze
  OPEN = %w[open claimed proposed].freeze
  # Consecutive failed polls before a run gives up following (with its agents stopped).
  POLL_FAILURES = 12
  # How long a finished run waits for the changes in flight to settle before reading its record.
  DRAIN_S = 120
  # What a run's results keep of each proposal (not the file texts an inline change carries).
  RAW_PROPOSAL_KEYS = %w[id intentId agentId status reason baseSha headSha writeSet readSet landingId movedBy createdAt].freeze
  # USD per model call, ESTIMATE: Gemma and Kimi as measured on the demo's whole-file writes (the shortlinks spec run,
  # 2026-10-12: 6 Gemma calls $0.0034, 20 Kimi calls $0.2294); the others priced at list prices on the same tokens a
  # call (about 4,250 in and 1,160 out). Review, as measured there: $0.0194 over 13 changes.
  CALL_USD = {
    "@cf/google/gemma-4-26b-a4b-it" => 0.00058,
    "@cf/moonshotai/kimi-k2.7-code" => 0.0115,
    "@cf/openai/gpt-oss-120b" => 0.0024,
    "@cf/zai-org/glm-5.3-flash" => 0.0012
  }.freeze
  REVIEW_USD = 0.0015
  # Rounds per intent the estimate assumes (proposals to land), and model calls per file written (retries).
  ROUNDS = { 1 => 1.0, 8 => 1.5, 16 => 2.0 }.freeze
  RETRY = 1.2

  # A run could not do what it should; the message says what happened.
  class Failure < StandardError; end

  # --- the spec and the seed ----------------------------------------------------------------------------------------

  # The spec's JSON block, with `context_text`: the markdown sections it names, as every intent carries them.
  def self.spec(path = SPEC)
    text = File.read(path, encoding: "UTF-8")
    block = text[/^```json firetrident-contention\n(.*?)\n```$/m, 1]
    raise Failure, "#{path} has no ```json firetrident-contention block" unless block

    data = JSON.parse(block)
    data["context_text"] = Array(data["context"]).filter_map { |name| section(text, name) }.join("\n\n")
    data
  end

  # One "## name" section of a markdown text, heading included, or nil.
  def self.section(markdown, name)
    m = markdown.match(/^## #{Regexp.escape(name)}\n(.*?)(?=^## |\z)/m)
    m && "## #{name}\n#{m[1].strip}"
  end

  # Every regular file under `dir`, relative and sorted by path (bytes), so the seed is the same on every machine.
  def self.files_under(dir)
    Dir.glob("**/*", File::FNM_DOTMATCH, base: dir).select { |p| File.file?(File.join(dir, p)) }.reject { |p| p.split("/").include?(".DS_Store") }.sort_by(&:b)
  end

  # The seed as [path, text] pairs in path order.
  def self.seed_files(dir = SEED) = files_under(dir).map { |p| [p, File.read(File.join(dir, p), encoding: "UTF-8")] }

  # The hidden acceptance tests as [path in the colony, text] pairs.
  def self.accept_files(dir = ACCEPT) = files_under(dir).map { |p| ["#{ACCEPT_DIR}/#{p}", File.read(File.join(dir, p), encoding: "UTF-8")] }

  # SHA-256 over the paths and texts, in order: one line that names the seed a run started from.
  def self.digest(files) = Digest::SHA256.hexdigest(files.map { |p, t| "#{p}\0#{t}\0" }.join)

  # An intent's why in the layout in-platform agents read (worker agents/create.ts): its own why, the scope, the files
  # it builds on, then the spec's conventions as spec context.
  def self.why(spec, intent)
    n = spec["intents"].size
    out = +"#{intent['why'].strip}\n\nScope: this intent writes #{intent['footprint'].join(', ')}. It is one of #{n} intents a person declared on this project at the same time."
    out << "\nBuilds on: #{intent['uses'].join(', ')}" unless Array(intent["uses"]).empty?
    context = spec["context_text"].to_s.strip
    out << "\n\nSpec context (demo/contention/spec.md):\n#{context}" unless context.empty?
    out
  end

  # POST /intents for one spec intent: a person's intent, at the spec's priority, never caught as a twin.
  def self.intent_body(spec, intent)
    { title: intent["title"], why: why(spec, intent), footprint: intent["footprint"], acceptance: intent["acceptance"],
      priority: spec["priority"] || 3, source: "human", createdBy: BY, force: true }
  end

  # The model of each of `n` agents for a swarm model spec, counted by model, as the swarm assigns them
  # (worker agents/swarm.ts assignModels): "=k" entries pinned in order, the rest split over the others.
  def self.assign_models(spec, n)
    entries = spec.to_s.split(",").map(&:strip).reject(&:empty?)
    return { (entries.first || "bulk") => n } if entries.size <= 1

    counted = []
    open = []
    entries.each { |e| (m = e.match(/\A(.*?)=(\d+)\z/)) ? counted << [m[1].strip, m[2].to_i] : open << e }
    groups = Hash.new(0)
    left = n
    counted.each do |model, k|
      take = [k, left].min
      groups[model] += take
      left -= take
    end
    spread = open.empty? ? counted.map(&:first) : open
    i = 0
    while left.positive?
      groups[spread[i % spread.size]] += 1
      i += 1
      left -= 1
    end
    groups.select { |_, k| k.positive? }
  end

  # ESTIMATE of one run's model spend: the spec's files written per round, the rounds the estimate assumes at this
  # agent count, retries, at the per-call figures above for the mix, plus review per change. Returns { calls:, usd: }.
  def self.estimate(spec, n, model)
    files = spec["intents"].sum { |i| i["footprint"].size }
    rounds = ROUNDS[n] || (n <= 1 ? 1.0 : n <= 8 ? 1.5 : 2.0)
    calls = files * rounds * RETRY
    mix = assign_models(model, n)
    per_call = mix.sum { |m, k| CALL_USD.fetch(m, CALL_USD.values.max) * k } / mix.values.sum.to_f
    proposals = spec["intents"].size * rounds
    { calls: calls.round, proposals: proposals.round, usd: ((calls * per_call) + (proposals * REVIEW_USD)).round(2) }
  end

  # Every line printed goes to the terminal and into the run log, both redacted by the clock.
  class Tee
    def initialize(*outs) = @outs = outs
    def puts(*args) = @outs.each { |o| o.puts(*args) }
    def flush = @outs.each { |o| o.flush if o.respond_to?(:flush) }
  end

  # --- one run on one colony ----------------------------------------------------------------------------------------

  # One run: a fresh colony, the seed, the intents, N agents, the report, the grade, cleanup. `call` returns the run's
  # result (a Hash) and never raises for a run that went wrong: the result says why it stopped. Interrupts are re-raised
  # after the colony is paused and cleaned up.
  class Run
    attr_reader :result

    def initialize(http:, clock:, secrets:, spec:, seed:, accept:, agents:, model:, label:, opts:)
      @http = http
      @clock = clock
      @secrets = secrets
      @spec = spec
      @seed = seed
      @accept = accept
      @n = agents
      @model = model
      @label = label
      @opts = opts
      @name = "#{opts[:name]}-#{label}".downcase.gsub(/[^a-z0-9-]+/, "-")[0, 48].sub(/-+\z/, "")
      @step_timeout = opts[:step_timeout].to_f
      @deadline = Stage.now + @step_timeout
      @waiting = "the deployment"
      @colony = nil
      @released = false
      @stopped = false
      @stop = nil
      @detail = nil
      @result = { label: label, agents: agents, model: model, colony: @name }
    end

    def call
      @t0 = Stage.now
      preflight
      create_colony
      seed_trunk
      baseline
      prepare
      declare_intents
      release
      follow
      @result
    rescue Stage::StepTimeout => e
      @stop ||= "step timeout"
      @detail ||= e.message
      @clock.say("TIMEOUT #{e.message}")
      @result
    rescue Failure => e
      @stop ||= "failed"
      @detail ||= e.message
      @clock.say("FAIL #{e.message}")
      @result
    rescue Interrupt
      @stop = "interrupt"
      @detail = "stopped by an interrupt"
      @clock.say("stopped by an interrupt")
      pause_colony("interrupted by the operator") if @released
      raise
    rescue StandardError => e
      # A fault of this script: the agents still stop and the colony is still cleaned up, and the results say why.
      @stop ||= "failed"
      @detail ||= "#{e.class}: #{e.message}"
      @clock.say("FAIL #{e.class}: #{e.message[0, 300]}")
      @result
    ensure
      finish
    end

    private

    # --- setup -------------------------------------------------------------------------------------------------------

    # What runs where, and the flags the run needs (refused without them) or reports without.
    def preflight
      res = @http.request(:get, "/api/about", timeout: [@step_timeout, 15].min, auth: false)
      about = res.ok? && res.json.is_a?(Hash) ? res.json : nil
      raise Failure, "GET /api/about did not answer (#{res.problem}), so the run cannot check its flags" unless about

      flags = Array(about["flags"])
      @result[:build] = about["commit"]
      @result[:flags] = flags.sort
      missing = REQUIRED_FLAGS.reject { |f, _| flags.include?(f) }
      raise Failure, missing.map { |f, why| "#{why} (#{f} is not on in /api/about)" }.join("; ") unless missing.empty?

      WANTED_FLAGS.each { |f, why| @clock.say("note: #{f} is off: #{why}") unless flags.include?(f) }
      @clock.say("run #{@label}: #{@n} agent#{@n == 1 ? '' : 's'} on #{@model} at #{@http.base} (build #{about['commit'] || 'unknown'})")
    end

    # A new colony with review off (the seed lands with no model asked) and a pool for the agents.
    def create_colony
      created, secs = step("the deployment to create colony #{@name}") do
        res = api(:post, "/colonies", { name: @name, pool: [@n + 6, 256].min })
        raise Failure, "colony #{@name} already exists: pass another --name" if res.code == 409
        raise Failure, "creating colony #{@name}: #{res.problem}" unless res.ok? && res.json

        res.json
      end
      @colony = created["id"] || @name
      @result[:colony] = @colony
      step("review to switch off for the seed") { api!(:post, "/colonies/#{@colony}/decide/policy", { enabled: false }) }
      state = step("the colony's certification state") { api!(:get, "/colonies/#{@colony}/certifications?limit=1") }.first
      unless state["on"] == true
        raise Failure, "certification is not on for #{@colony} (deployment #{state['deployment'].inspect}, runner #{state['runner'].inspect}): the smoke test needs it"
      end

      @clock.say("created colony #{@colony} (#{fmt(secs)}); certification is on, review is off until the seed lands")
    end

    # Land the seed as one inline change, by a scripted agent holding a person's intent assigned to it.
    def seed_trunk
      paths = @seed.map(&:first)
      landed, secs = step("the seed's #{paths.size} files to land") do
        agent = register("seed")
        intent = declare(agent, "Seed the project: #{@spec['name']}", paths, "The project every run of the contention smoke test starts from.")
        took = take(agent, intent["id"], "the seed agent")
        settle(propose_inline(agent, took, {}, @seed.to_h, "The #{@spec['name']} seed, #{paths.size} files"), "the seed")
      end
      raise Failure, "the seed did not land: #{landed['status']}#{reason_of(landed)}" unless landed["status"] == "landed"

      @seed_landing = landed["landingId"]
      @result[:seed] = { files: paths.size, digest: Contention.digest(@seed), landing: @seed_landing }
      @clock.say("seeded #{paths.size} files in one landing (#{fmt(secs)}), digest #{Contention.digest(@seed)[0, 12]}")
    end

    # Certification of the seed's commit must be green: the baseline every red episode is measured from.
    def baseline
      cert, secs = step("certification to pass the seed's tests") do
        loop do
          snap = api!(:get, "/colonies/#{@colony}")
          c = snap.dig("colony", "certification")
          head = snap.dig("colony", "trunkSha")
          break c if c.is_a?(Hash) && c["trunkSha"] == head && %w[green red error skipped].include?(c["status"])

          @waiting = "certification of the seed's commit #{short(head)} (it is #{c.is_a?(Hash) ? "#{c['status']} at #{short(c['trunkSha'])}" : 'not started'})"
          pause(2)
        end
      end
      k = cert["counts"] || {}
      raise Failure, "certification of the seed is #{cert['status']} (#{k['pass'].to_i}/#{k['tests'].to_i} pass): #{cert['detail'] || failing_text(cert)}" unless cert["status"] == "green"

      @result[:seed][:tests] = k["tests"]
      @clock.say("the seed is certified green: #{k['pass']}/#{k['tests']} tests at #{short(cert['trunkSha'])} (#{fmt(secs)})")
    end

    # Review on, the spec's rules, and the colony's spend cap.
    def prepare
      policy, = step("review to switch on") { api!(:post, "/colonies/#{@colony}/decide/policy", { enabled: true }) }
      @result[:review] = { enabled: policy["enabled"], reflexModel: policy["reflexModel"], secondOpinionModels: policy["secondOpinionModels"] }
      Array(@spec["rules"]).each do |rule|
        step("rule \"#{rule['description']}\"") { api!(:post, "/colonies/#{@colony}/rules", rule.merge("approvedBy" => BY)) }
      end
      reserve = (@opts[:max_usd] * 0.1).round(2)
      res = step("the spend cap") { api(:post, "/colonies/#{@colony}/spend-cap", { usd: @opts[:max_usd], reviewReserveUsd: reserve, by: BY }) }.first
      @result[:cap_set] = res.ok?
      @clock.say(res.ok? ? "review is on (reflex #{policy['reflexModel']}); spend cap $#{format('%.2f', @opts[:max_usd])} with $#{format('%.2f', reserve)} kept for review" : "review is on; the spend cap was not set (#{res.problem}): this script's own stop still applies")
    end

    def declare_intents
      @intents = {}
      _, secs = step("the #{@spec['intents'].size} intents to be declared") do
        @spec["intents"].each do |i|
          res = api(:post, "/colonies/#{@colony}/intents", Contention.intent_body(@spec, i))
          raise Failure, "declaring #{i['id']}: #{res.problem}" unless res.ok? && res.json && res.json["id"]
          raise Failure, "declaring #{i['id']} answered the colony's intent #{res.json['duplicateOf']}" if res.json["duplicateOf"]

          @intents[res.json["id"]] = { id: i["id"], title: i["title"], change: i["change"] || "adds", footprint: i["footprint"] }
        end
      end
      @clock.say("declared #{@intents.size} intents, source human, priority #{@spec['priority']}, every one writing #{@spec['shared']} (#{fmt(secs)})")
    end

    def release
      swarm, = step("the swarm to start") { api!(:post, "/colonies/#{@colony}/swarm", { count: @n, model: @model }) }
      @released = true
      @released_mono = Stage.now
      @release_at = server_now || (Time.now.to_f * 1000).round
      @result[:models] = swarm["models"] || Contention.assign_models(@model, @n)
      @result[:started] = swarm["started"]
      @result[:released_at] = Time.at(@release_at / 1000.0).utc.iso8601
      @clock.say("released #{swarm['started'] || @n} agents: #{(@result[:models] || {}).map { |m, k| "#{m}×#{k}" }.join(', ')}")
    end

    # --- following ---------------------------------------------------------------------------------------------------

    def follow
      total = @intents.size
      last_landed = -1
      last_progress = Stage.now
      done_at = nil
      failures = 0
      @approved = Set.new
      loop do
        sleep(@opts[:poll])
        snap, metrics = begin
          step("the colony's state") { [api!(:get, "/colonies/#{@colony}"), api!(:get, "/colonies/#{@colony}/metrics")] }.first
        rescue Failure, Stage::StepTimeout => e
          failures += 1
          @clock.say("could not read the colony (#{failures} in a row): #{e.message[0, 160]}")
          if failures >= POLL_FAILURES
            @stop = "failed"
            @detail = "the colony did not answer #{POLL_FAILURES} polls in a row"
            break
          end
          next
        end
        failures = 0
        @last_metrics = metrics
        statuses = Array(snap["intents"]).select { |i| @intents.key?(i["id"]) }.map { |i| i["status"] }.tally
        landed = statuses["landed"].to_i
        spent = spent_usd(metrics)
        narrate(snap, metrics, statuses, landed, total, spent)
        cap = metrics.dig("spend", "cap", "state")
        break spend_stop(format("the spend read $%.4f, at or over --max-usd $%.2f", spent, @opts[:max_usd])) if spent >= @opts[:max_usd]
        break spend_stop("the colony's spend cap tripped (state #{cap}) at $#{format('%.4f', spent)}") if cap && cap != "open"

        if landed > last_landed
          last_landed = landed
          last_progress = Stage.now
        end
        approve_escalations if @opts[:approve] && metrics.dig("metrics", "reviewQueue").to_i.positive?
        if landed >= total
          done_at ||= Stage.now
          if @opts[:settle].zero? || certified_green?(snap)
            @stop = "landed"
            break
          end
          if Stage.now - done_at > @opts[:settle]
            @stop = "landed"
            @detail = "trunk was not certified green #{Stage.seconds(@opts[:settle])} s after the last intent landed"
            break
          end
          last_progress = Stage.now
        end
        elapsed = Stage.now - @released_mono
        if elapsed > @opts[:timeout]
          @stop = "timeout"
          @detail = "#{landed}/#{total} intents landed after #{Stage.seconds(@opts[:timeout])} s"
          break
        end
        next unless Stage.now - last_progress > @opts[:stall]

        @stop = "stall"
        @detail = "nothing landed for #{Stage.seconds(@opts[:stall])} s (#{landed}/#{total} landed)"
        break
      end
    end

    def narrate(snap, metrics, statuses, landed, total, spent)
      m = metrics["metrics"] || {}
      c = snap.dig("colony", "certification")
      head = snap.dig("colony", "trunkSha")
      cert = c.is_a?(Hash) ? "#{c['status']}#{c['trunkSha'] == head ? '' : " at #{short(c['trunkSha'])}"}" : "none"
      @clock.say(format("landed %2d/%d  claimed %d  proposed %d  open %d | landings %d, returned %d, review queue %d | trunk %s %s | $%.4f",
                        landed, total, statuses["claimed"].to_i, statuses["proposed"].to_i, statuses["open"].to_i,
                        m["landings"].to_i, m["returned"].to_i, m["reviewQueue"].to_i, short(head), cert, spent))
    end

    # What the colony counts as spent: its spend, or the cap's count when that is ahead (it settles every call).
    def spent_usd(metrics)
      s = metrics["spend"].is_a?(Hash) ? metrics["spend"] : {}
      [s["usd"].to_f, s.dig("cap", "spentUsd").to_f].max
    end

    # Trunk is certified green at its head with no repair open (or certification has nothing to run).
    def certified_green?(snap)
      c = snap.dig("colony", "certification")
      return true unless c.is_a?(Hash)
      return false if Array(snap["intents"]).any? { |i| i["source"] == "certify" && OPEN.include?(i["status"]) }
      return true if %w[skipped error].include?(c["status"])

      c["status"] == "green" && c["trunkSha"] == snap.dig("colony", "trunkSha")
    end

    # The hard spend stop: the pause switch, then the swarm. Returns nil (ends the follow loop).
    def spend_stop(why)
      @stop = "spend"
      @detail = why
      @clock.say("SPEND STOP: #{why}; pausing the colony and stopping its agents")
      pause_colony("contention smoke test spend stop: #{why}")
      stop_swarm("spend stop")
      nil
    end

    def pause_colony(reason)
      return unless @colony

      res = @http.request(:post, "/api/colonies/#{@colony}/pause", body: { reason: reason[0, 300], by: BY }, timeout: 30)
      @result[:paused] = res.ok?
      @clock.say(res.ok? ? "paused colony #{@colony}" : "pausing #{@colony} answered #{res.problem}")
    end

    def stop_swarm(reason)
      return if @stopped || !@released

      res = @http.request(:post, "/api/colonies/#{@colony}/swarm/stop", body: { reason: reason }, timeout: 60)
      @stopped = res.ok?
      @clock.say(res.ok? ? "stopped the agents (#{reason})" : "stopping the agents answered #{res.problem}")
    end

    # Answer escalated changes as the human reviewer (--approve).
    def approve_escalations
      queue, = step("the review queue") { api!(:get, "/colonies/#{@colony}/review") }
      Array(queue.is_a?(Hash) ? queue["proposals"] : queue).each do |p|
        next if @approved.include?(p["id"]) || !@intents.key?(p["intentId"])

        @clock.say("approving escalated change #{p['id']} of #{@intents.dig(p['intentId'], :id)}#{reason_of(p)[0, 200]}")
        step("approving #{p['id']}") { api!(:post, "/colonies/#{@colony}/review/#{p['id']}", { decision: "approve", reason: "approved by the contention script (--approve)", by: BY }) }
        @approved << p["id"]
      end
    rescue Failure => e
      @clock.say("the review queue could not be answered: #{e.message[0, 160]}")
    end

    # --- the end of a run --------------------------------------------------------------------------------------------

    # Stop the agents, read the record and report, grade, clean up. Never raises.
    def finish
      @result[:stop] = @stop || "failed"
      @result[:stop_detail] = @detail
      return cleanup unless @released

      # The run ends where following ended: what happens while the changes in flight settle is still recorded.
      @end_at = @last_metrics && @last_metrics["at"]
      stop_swarm("run finished")
      begin
        drain unless %w[spend interrupt].include?(@stop)
        record = collect
        @result[:report] = ContentionReport.build(record.merge(spec_intents: @intents, pairs: @spec["pairs"], grade: nil))
        @result[:raw] = record.slice(:events, :certifications).merge(
          proposals: record[:proposals].transform_values { |p| p.is_a?(Hash) ? p.slice(*RAW_PROPOSAL_KEYS) : p },
          agents: record[:agents].map { |a| a.slice("id", "name", "kind", "model", "state", "counters") }
        )
        @result[:end_at] = record[:end_at]
        @result[:release_at] = @release_at
        grade_run
        @result[:report] = ContentionReport.build(record.merge(spec_intents: @intents, pairs: @spec["pairs"], grade: @result[:grade])) if @result[:grade]
        summary
      rescue StandardError => e
        @result[:report_error] = "#{e.class}: #{e.message}"
        @clock.say("the run's record could not be read or reported: #{e.message[0, 200]}")
      end
      cleanup
    end

    # With the agents stopped, let the changes already proposed settle (escalated ones wait for a person and are left
    # waiting) and the colony read the agents' journals into its spend, for at most DRAIN_S seconds, so the record read
    # next is final. Skipped after the spend stop and an interrupt: a paused colony holds its changes.
    def drain
      t = Stage.now
      loop do
        m, = step("the changes in flight to settle") { api!(:get, "/colonies/#{@colony}/metrics") }
        moving = m.dig("metrics", "proposalsInFlight").to_i - m.dig("metrics", "reviewQueue").to_i
        unread = m.dig("spend", "agentsUnread").to_i
        break if moving <= 0 && unread <= 0
        break @clock.say("#{moving} change#{moving == 1 ? '' : 's'} still in flight and #{unread} agent journal#{unread == 1 ? '' : 's'} unread after #{DRAIN_S} s; reading the record as it stands") if Stage.now - t > DRAIN_S

        sleep([@opts[:poll], 2].min)
      end
    end

    def collect
      step("the colony's record") do
        events = []
        after = 0
        loop do
          page = api!(:get, "/colonies/#{@colony}/events?after=#{after}&limit=5000")
          events.concat(Array(page["events"]))
          break if page["next"].nil?

          after = page["next"]
        end
        metrics = api!(:get, "/colonies/#{@colony}/metrics")
        snapshot = api!(:get, "/colonies/#{@colony}")
        agents = Array(api!(:get, "/colonies/#{@colony}/agents?all=1&journal=1")["agents"])
        certs = Array(api!(:get, "/colonies/#{@colony}/certifications?limit=500")["results"])
        pids = events.select { |e| e["t"] == "proposal" && @intents.key?(e["intentId"]) }.map { |e| e["proposalId"] }.uniq
        proposals = pids.to_h { |pid| [pid, api!(:get, "/colonies/#{@colony}/proposals/#{URI.encode_www_form_component(pid)}")] }
        { events: events, metrics: metrics, snapshot: snapshot, agents: agents, certifications: certs, proposals: proposals,
          release_at: @release_at, end_at: @end_at || metrics["at"] || (Time.now.to_f * 1000).round }
      end.first
    end

    # Land the hidden acceptance tests and read which of them the colony's certification passes (review and repairs
    # off: the agents are stopped, and this change is the grader's, not part of the measurement).
    def grade_run
      skip = if @opts[:no_grade] then "--no-grade"
             elsif %w[spend interrupt].include?(@stop) then "the run ended by #{@stop == 'spend' ? 'the spend stop' : 'an interrupt'}"
             elsif @result.dig(:report, :intents, :landed).to_i.zero? then "no intent landed"
             end
      return @result[:grade_skipped] = skip if skip

      files = @accept
      cert, secs = step("the hidden acceptance tests to land and be certified") do
        api!(:post, "/colonies/#{@colony}/certify/policy", { repair: false })
        api!(:post, "/colonies/#{@colony}/decide/policy", { enabled: false })
        agent = register("grader")
        intent = declare(agent, "Grade the run: the hidden acceptance tests", files.map(&:first), "Lands the tests a person wrote for each intent, after every agent stopped.")
        took = take(agent, intent["id"], "the grader")
        landed = settle(propose_inline(agent, took, {}, files.to_h, "The hidden acceptance tests"), "the grading change")
        raise Failure, "the grading change did not land: #{landed['status']}#{reason_of(landed)}" unless landed["status"] == "landed"

        loop do
          snap = api!(:get, "/colonies/#{@colony}")
          c = snap.dig("colony", "certification")
          head = snap.dig("colony", "trunkSha")
          if c.is_a?(Hash) && c["trunkSha"] == head && %w[green red error skipped].include?(c["status"])
            full = api(:get, "/colonies/#{@colony}/certifications/#{head}")
            break full.ok? && full.json.is_a?(Hash) ? full.json : c
          end
          @waiting = "certification of the graded trunk #{short(head)}"
          pause(2)
        end
      end
      @result[:grade] = Contention.grade(cert, @spec["intents"].map { |i| i["id"] })
      g = @result[:grade]
      @clock.say("graded at #{short(cert['trunkSha'])} (#{fmt(secs)}): hidden tests pass for #{g[:passed]} of #{g[:files].size} intents#{g[:failed].positive? ? ", fail for #{g[:failed]}" : ''}#{g[:other].positive? ? ", #{g[:other]} not known" : ''}")
    rescue Failure, Stage::StepTimeout => e
      @result[:grade_skipped] = "grading failed: #{e.message}"
      @clock.say("grading failed: #{e.message[0, 200]}")
    end

    def summary
      r = @result[:report]
      i = r[:intents]
      ret = r[:returns]
      @clock.print
      @clock.print("run #{@label}: #{i[:landed]}/#{i[:total]} intents landed (#{@result[:stop]}#{@detail ? ": #{@detail}" : ''}); intents held at once: peak #{r[:concurrency][:peak_in_flight]}, mean #{r[:concurrency][:mean_in_flight] || 'n/a'}")
      @clock.print("  returns #{ret[:returned]} of #{ret[:proposals]} proposals: #{ret[:by_cause].map { |c, n| "#{ContentionReport::CAUSE_LABELS[c]} #{n}" }.join(', ')}; cause repeats #{r[:cause_repeat][:repeats]}/#{r[:cause_repeat][:eligible]}")
      @clock.print("  rounds to land: median #{r[:rounds][:median_rounds] || 'n/a'}, max #{r[:rounds][:max_rounds] || 'n/a'}; model calls to land: median #{r[:rounds][:median_calls] || 'n/a'}")
      @clock.print("  semantic-conflict pairs landed: #{r[:semantic][:pairs_landed]}; red episodes #{r[:red][:episodes]} (#{r[:red][:open_at_end]} open at the end), median time to green #{r[:red][:median_time_to_green_s] || 'n/a'} s")
      @clock.print("  human queue: #{r[:human_queue][:escalations]} escalations, #{r[:human_queue][:held_merges]} held merges, #{r[:human_queue][:agent_reports]} agent reports")
      @clock.print(format("  spend $%.4f, $%s per landed intent; wall %s s to the last landing", r[:spend][:usd].to_f, r[:spend][:per_landed_intent] ? format('%.4f', r[:spend][:per_landed_intent]) : "n/a", r[:wall][:release_to_last_landing_s] || "n/a"))
      @clock.print
    end

    def cleanup
      return unless @colony

      stop_swarm("run finished") if @released
      return @clock.say("kept colony #{@colony}: #{@http.base}/c/#{@colony}") if @opts[:keep]

      res = @http.request(:delete, "/api/colonies/#{@colony}", timeout: 600)
      @result[:deleted] = res.ok?
      @clock.say(res.ok? ? "deleted colony #{@colony}" : "could not delete colony #{@colony} (#{res.problem}): delete it with ft delete #{@colony} --yes")
    end

    # --- the API -----------------------------------------------------------------------------------------------------

    # Run one step under its own time limit; returns [its value, seconds taken].
    def step(waiting)
      @deadline = Stage.now + @step_timeout
      @waiting = waiting
      t = Stage.now
      [yield, Stage.now - t]
    end

    def left = @deadline - Stage.now

    def api(method, path, body = nil)
      raise Stage::StepTimeout.new(@waiting, @step_timeout) if left <= 0

      res = @http.request(method, "/api#{path}", body: body, timeout: [left, 60].min)
      raise Stage::StepTimeout.new(@waiting, @step_timeout) if res.code.zero? && left <= 0.05

      res
    end

    def api!(method, path, body = nil)
      res = api(method, path, body)
      raise Failure, "#{method.to_s.upcase} /api#{path.split('?').first}: #{res.problem}" unless res.ok? && !res.json.nil?

      res.json
    end

    def pause(seconds)
      raise Stage::StepTimeout.new(@waiting, @step_timeout) if left <= 0

      sleep([seconds, left].min)
    end

    # The colony's clock, from its metrics, so the report's times share one clock.
    def server_now
      res = api(:get, "/colonies/#{@colony}/metrics")
      res.ok? && res.json.is_a?(Hash) && res.json["at"].is_a?(Numeric) ? res.json["at"] : nil
    rescue Stage::StepTimeout
      nil
    end

    def register(name)
      api!(:post, "/colonies/#{@colony}/agents", { name: "#{name}-#{@label}", kind: "synthetic", model: "scripted" })["id"]
    end

    # An intent assigned to `agent`, declared even when it matches another (force).
    def declare(agent, title, footprint, why)
      res = api(:post, "/colonies/#{@colony}/intents", { title: title, why: why, footprint: footprint, assignedTo: agent, createdBy: BY, force: true })
      raise Failure, "declaring \"#{title}\": #{res.problem}" unless res.ok? && res.json && res.json["id"]

      res.json
    end

    # Take until the agent holds `intent_id` (a new colony's pool may still be forking); its lease tokens are redacted.
    def take(agent, intent_id, who)
      loop do
        t = api!(:post, "/colonies/#{@colony}/agents/#{agent}/take", {})
        if t["intent"]
          raise Failure, "#{who} was handed #{t.dig('intent', 'id')}, not its own intent #{intent_id}" unless t.dig("intent", "id") == intent_id

          [t.dig("lease", "token"), t.dig("lease", "trunk", "token")].each { |s| @secrets << s if s.is_a?(String) && !@secrets.include?(s) }
          return t
        end
        @waiting = "#{who} to be handed its intent (the colony said: #{t['reason'] || 'wait'})"
        pause([(t["retryInMs"] || 1000).to_f / 1000, 2].min)
      end
    end

    # Propose `files` (path => text) as an inline change on the lease's base.
    def propose_inline(agent, took, read, files, summary)
      write = files.map { |path, text| { path: path, blob: Stage.blob_id(text) } }
      base = took.dig("lease", "baseSha")
      body = {
        intentId: took.dig("intent", "id"), agentId: agent, workspace: took.dig("lease", "repo"), baseSha: base,
        headSha: Stage.changeset_id(base, write), writeSet: write,
        readSet: read.map { |path, text| { path: path, blob: Stage.blob_id(text) } },
        contents: files.to_h { |_, text| [Stage.blob_id(text), text] }, intentRevision: took.dig("intent", "revision") || 1,
        declared: { footprint: files.keys, summary: summary },
        evidence: { checks: [], notVerified: "A scripted agent of the contention smoke test: no tests were run." }
      }
      api!(:post, "/colonies/#{@colony}/proposals", body)
    end

    # Poll a proposal until it lands, goes back, is rejected or waits for a person.
    def settle(proposal, who)
      loop do
        p = api!(:get, "/colonies/#{@colony}/proposals/#{proposal['id']}")
        return p if SETTLED.include?(p["status"])

        @waiting = "#{who}'s change #{proposal['id']} to land or go back (it is #{p['status']})"
        pause(0.5)
      end
    end

    def failing_text(c) = Array(c["failing"]).first(3).map { |f| "#{f['file']}: #{f['name']}" }.join("; ")

    def reason_of(p) = p["reason"] ? ": #{p['reason']}" : ""

    def short(sha) = sha.to_s[0, 7]

    def fmt(secs) = format("%.1f s", secs)
  end

  # Each intent's hidden test file, from the certification of the graded trunk: pass, fail, "not run" (left out by
  # the runner) or "unknown" (the result names only some failing tests, or says nothing about the code).
  def self.grade(cert, ids)
    status = cert["status"]
    failing = Array(cert["failing"]).filter_map { |f| f["file"] }.to_set
    unsupported = Array(cert["unsupported"]).filter_map { |u| u["path"] }.to_set
    counts = cert["counts"] || {}
    truncated = Array(cert["failing"]).size < counts["fail"].to_i + counts["cancelled"].to_i
    files = ids.to_h do |id|
      path = "#{ACCEPT_DIR}/#{id}.test.ts"
      verdict = if unsupported.include?(path) then "not run"
                elsif status == "green" then "pass"
                elsif status != "red" then "unknown"
                elsif failing.include?(path) then "fail"
                elsif truncated then "unknown"
                else "pass"
                end
      [id, verdict]
    end
    failures = Array(cert["failing"]).select { |f| f["file"].to_s.start_with?("#{ACCEPT_DIR}/") }.first(40).map { |f| { file: f["file"], name: f["name"], error: f["error"].to_s[0, 200] } }
    { status: status, trunk_sha: cert["trunkSha"], counts: counts, files: files, passed: files.count { |_, v| v == "pass" },
      failed: files.count { |_, v| v == "fail" }, other: files.count { |_, v| !%w[pass fail].include?(v) }, failing: failures }
  end

  # --- the results folder ---------------------------------------------------------------------------------------------

  # The results folder's files: README.md, contention.json and run-<label>.json for each run.
  module Results
    module_function

    def label_of(runs) = runs.map { |r| r[:label] }.join("-")

    # The default folder: packages/bench/results/<date>-contention-<labels>, with -2, -3 ... when it exists.
    def default_dir(date, runs)
      base = File.join(ROOT, "packages", "bench", "results", "#{date}-contention-#{label_of(runs)}")
      dir = base
      n = 1
      dir = "#{base}-#{n += 1}" while File.exist?(dir)
      dir
    end

    def files(sweep)
      runs = sweep[:runs]
      out = { "README.md" => readme(sweep), "contention.json" => "#{JSON.pretty_generate(summary(sweep))}\n" }
      runs.each { |r| out["run-#{r[:label]}.json"] = "#{JSON.pretty_generate(r)}\n" }
      out["run.log"] = sweep[:log].to_s
      out
    end

    def summary(sweep)
      { kind: "contention-smoke-test", label: "MEASURED", command: sweep[:command], base: sweep[:base], note: sweep[:note], spec: sweep[:spec_summary],
        runs: sweep[:runs].map { |r| r.except(:raw) }, transitions: sweep[:transitions] }
    end

    # Write the files through the bench evidence redaction (node packages/bench/src/evidence.ts redact): each file is
    # written to a temporary directory, redacted into `dir`, and the temporary copy removed. Nothing is written unredacted.
    def write(dir, files, secrets)
      FileUtils.mkdir_p(dir)
      Dir.mktmpdir("ft-contention-") do |tmp|
        files.each do |name, text|
          src = File.join(tmp, name)
          File.write(src, Stage.redact(text, secrets))
          ok, _out, err, timed_out = Stage.run([Stage::NODE, File.join(ROOT, "packages/bench/src/evidence.ts"), "redact", src, File.join(dir, name)], chdir: ROOT, timeout: 120)
          raise Failure, "the evidence redaction of #{name} #{timed_out ? 'did not finish' : "failed: #{err.strip.lines.last.to_s.strip[0, 200]}"}" unless ok
        end
      end
      dir
    end

    def n(x, digits = 1)
      return "n/a" if x.nil?
      return x ? "yes" : "no" if [true, false].include?(x)

      x.is_a?(Float) ? format("%.#{digits}f", x) : x.to_s
    end

    # Seconds, or n/a.
    def s(x) = x.nil? ? "n/a" : "#{n(x)} s"

    def usd(x) = x.nil? ? "n/a" : format("$%.4f", x)

    def pct(x) = x.nil? ? "n/a" : format("%.0f%%", x * 100)

    def readme(sweep)
      runs = sweep[:runs]
      lines = []
      lines << "# Contention smoke test: #{runs.map { |r| "#{r[:agents]} agent#{r[:agents] == 1 ? '' : 's'}" }.join(', ')} on one shared module"
      lines << ""
      lines << "MEASURED on #{sweep[:base]}#{runs.first&.dig(:build) ? " (build #{runs.first[:build]})" : ''}, #{sweep[:date]}: in-platform agents calling real models, review on, the project's node:test tests certified on trunk. " \
               "The workload is `demo/contention/spec.md`: a 20-file TypeScript seed whose sixteen intents (source human, equal priority) all change `src/core/money.ts` as well as their own module, " \
               "three of them change a signature in it, and four intents are built on the old signatures (the designed semantic-conflict pairs). Each run started on its own fresh colony from the same seed and intents."
      lines << ""
      lines << "Operator's note: #{sweep[:note]}" if sweep[:note]
      lines << "" if sweep[:note]
      lines << "```sh"
      lines << sweep[:command]
      lines << "```"
      lines << ""
      lines << "Every intent writes the shared module, and the take path keeps an agent off an intent whose files another agent holds (lateral inhibition, on unless the deployment sets `FT_LATERAL_INHIBITION=off`, which `/api/about` does not show). " \
               "The row \"Intents held at once\" says whether the agents contended: a peak of 1 with many agents means they were held to one intent at a time."
      lines << ""
      lines << "Written by `scripts/contention.rb` (numbers: `scripts/contention_report.rb`, whose header defines each one) and copied through `packages/bench/src/evidence.ts redact`. Files: `contention.json` (every number), `run-<n>.json` (each run's record: events, certifications, proposals, agents), `run.log`."
      lines << ""
      lines << "## Runs side by side"
      lines << ""
      lines << "| Measure | #{runs.map { |r| "#{r[:agents]} agent#{r[:agents] == 1 ? '' : 's'}" }.join(' | ')} |"
      lines << "| --- |#{' --- |' * runs.size}"
      row = ->(label, &f) { lines << "| #{label} | #{runs.map { |r| r[:report] ? f.call(r[:report], r) : 'n/a' }.join(' | ')} |" }
      lines << "| Models | #{runs.map { |r| (r[:models] || {}).map { |m, k| "#{m.split('/').last}×#{k}" }.join(', ') }.join(' | ')} |"
      lines << "| Review | #{runs.map { |r| r.dig(:review, :enabled) ? "on (reflex #{r.dig(:review, :reflexModel).to_s.split('/').last})" : 'n/a' }.join(' | ')} |"
      lines << "| How the run ended | #{runs.map { |r| [r[:stop], r[:stop_detail]].compact.join(': ').gsub('|', '/') }.join(' | ')} |"
      row.call("Intents landed") { |x| "#{x[:intents][:landed]} of #{x[:intents][:total]}" }
      row.call("Intents held at once, peak (mean)") { |x| "#{x[:concurrency][:peak_in_flight]} (#{n(x[:concurrency][:mean_in_flight], 2)})" }
      row.call("Intents the colony or agents declared") { |x| x[:concurrency][:colony_intents].empty? ? "none" : x[:concurrency][:colony_intents].map { |src, st| "#{src}: #{st.map { |k, v| "#{v} #{k}" }.join(', ')}" }.join("; ") }
      row.call("Wall time, release to the last landing") { |x| x[:wall][:release_to_last_landing_s] ? "#{n(x[:wall][:release_to_last_landing_s])} s" : "not all landed (last at #{n(x[:wall][:last_landing_so_far_s])} s)" }
      row.call("Release to green after the last landing") { |x| s(x[:wall][:release_to_green_s]) }
      row.call("Proposals (landed)") { |x| "#{x[:returns][:proposals]} (#{x[:returns][:landed]})" }
      ContentionReport::CAUSES.each { |c| row.call("Returned: #{ContentionReport::CAUSE_LABELS[c]}") { |x| x[:returns][:by_cause][c].to_s } }
      row.call("Cause-repeat rate") { |x| "#{pct(x[:cause_repeat][:rate])} (#{x[:cause_repeat][:repeats]}/#{x[:cause_repeat][:eligible]})" }
      row.call("Rounds to land, median (max)") { |x| "#{n(x[:rounds][:median_rounds])} (#{n(x[:rounds][:max_rounds])})" }
      row.call("Model calls to land, median") { |x| n(x[:rounds][:median_calls]) }
      row.call("Semantic-conflict pairs landed") { |x| x[:semantic][:pairs_landed].to_s }
      row.call("Designed pairs found red") { |x| "#{x[:semantic][:designed].count { |d| d[:found_as_pair] }} of #{x[:semantic][:designed].size}" }
      row.call("Red-trunk episodes (open at the end)") { |x| "#{x[:red][:episodes]} (#{x[:red][:open_at_end]})" }
      row.call("Time to green, median (max)") { |x| "#{s(x[:red][:median_time_to_green_s])} (#{s(x[:red][:max_time_to_green_s])})" }
      row.call("Repair intents declared (landed)") { |x| "#{x[:red][:repair_intents][:declared]} (#{x[:red][:repair_intents][:landed]})" }
      row.call("Human queue: escalations, held merges, agent reports") { |x| "#{x[:human_queue][:escalations]}, #{x[:human_queue][:held_merges]}, #{x[:human_queue][:agent_reports]}" }
      row.call("Time in the human queue, median (max)") { |x| "#{s(x[:human_queue][:median_time_in_queue_s])} (#{s(x[:human_queue][:max_time_in_queue_s])})" }
      row.call("Model calls: agents (review)") { |x| "#{x[:spend][:agent_calls]} (#{n(x[:spend][:review_calls])})" }
      row.call("Model spend this platform made") { |x| usd(x[:spend][:usd]) }
      row.call("Spend per landed intent") { |x| usd(x[:spend][:per_landed_intent]) }
      lines << "| Hidden acceptance tests passed | #{runs.map { |r| r[:grade] ? "#{r[:grade][:passed]} of #{r[:grade][:files].size} intents" : "not graded (#{r[:grade_skipped]})" }.join(' | ')} |"
      lines << ""
      runs.each { |r| lines.concat(run_section(r)) }
      sweep[:transitions].to_a.each { |t| lines.concat(transition_section(t)) }
      lines << "## What this does not measure"
      lines << ""
      lines << "- One small repository and one workload; the numbers are a first contended point, not a curve."
      lines << "- Model calls are what this platform counted for the colony (agents, review, the resolver, the judge); the hidden-test grade is from the colony's own certification of the graded trunk."
      lines << "- Models answer differently between runs: a second run of the same command will not give the same numbers."
      lines << ""
      lines.join("\n")
    end

    def run_section(r)
      x = r[:report]
      out = ["## #{r[:agents]} agent#{r[:agents] == 1 ? '' : 's'} (colony #{r[:colony]})", ""]
      out << "Model mix `#{r[:model]}`; flags on: #{Array(r[:flags]).join(', ')}; seed #{r.dig(:seed, :files)} files, #{r.dig(:seed, :tests)} tests, digest #{r.dig(:seed, :digest).to_s[0, 12]}; spend cap #{r[:cap_set] ? 'set' : 'not set'}."
      out << ""
      unless x
        out << "No report: #{r[:report_error] || r[:stop_detail] || r[:stop]}."
        out << ""
        return out
      end
      other = x[:returns][:other]
      out << "Returns: #{x[:returns][:returned]} (and #{x[:returns][:redirects]} redirects)#{other.empty? ? '' : "; other: #{other.map { |k, v| "#{k} #{v}" }.join(', ')}"}. " \
             "Cause repeats by cause: #{x[:cause_repeat][:by_cause].map { |c, v| "#{ContentionReport::CAUSE_LABELS[c]} #{v[:repeats]}/#{v[:eligible]}" }.join(', ')}."
      out << ""
      out << "| Rounds and calls to land, by cause | Intents | Median rounds | Median calls |"
      out << "| --- | --- | --- | --- |"
      x[:rounds][:by_cause].each { |c, v| out << "| #{ContentionReport::CAUSE_LABELS.fetch(c, c)} | #{v[:intents]} | #{n(v[:median_rounds])} | #{n(v[:median_calls])} |" }
      out << ""
      out << "| Intent | Change | Status | Proposals | Rounds | Returns | Model calls | Spend | Hidden test |"
      out << "| --- | --- | --- | --- | --- | --- | --- | --- | --- |"
      x[:intents][:per_intent].each do |i|
        out << "| #{i[:id]} | #{i[:change]} | #{i[:status]} | #{i[:proposals]} | #{n(i[:rounds])} | #{i[:returns].map { |c, k| "#{ContentionReport::CAUSE_LABELS[c]} #{k}" }.join(', ')} | #{n(i[:model_calls])} | #{usd(i[:usd])} | #{i[:hidden] || 'n/a'} |"
      end
      out << ""
      out << "| Designed pair | Landed second | Second built before the first landed | Next certification | Found as a pair | Hidden tests (first, second) |"
      out << "| --- | --- | --- | --- | --- | --- |"
      x[:semantic][:designed].each do |d|
        out << "| #{d[:first]} → #{d[:second]} | #{d[:landed_second] || "#{d[:first_landed] ? '' : "#{d[:first]} did not land "}#{d[:second_landed] ? '' : "#{d[:second]} did not land"}".strip} | #{n(d[:second_built_before_first_landed])} | #{n(d[:next_certification])} | #{n(d[:found_as_pair])} | #{n(d[:hidden_first])}, #{n(d[:hidden_second])} |"
      end
      out << ""
      unless x[:semantic][:observed].empty?
        out << "Semantic-conflict pairs that landed (both landed, tests red after the second): #{x[:semantic][:observed].map { |o| "#{o[:first].join(' or ')}, then #{o[:second]} (#{o[:how]}, culprit by #{o[:culprit_by]}#{o[:designed] ? ", the designed pair with #{o[:designed]}" : ''})" }.join('; ')}."
        out << ""
      end
      unless x[:red][:list].empty?
        out << "| Red episode | Red at | Failing files | Culprit | Time to green | Landings during |"
        out << "| --- | --- | --- | --- | --- | --- |"
        x[:red][:list].each_with_index do |e, i|
          culprit = e[:culprit] ? "#{e[:culprit][:proposals].map { |p| p[:intent] }.join(', ')} (#{e[:culprit][:by]})" : "n/a"
          out << "| #{i + 1} | #{n(e[:red_at_s])} s | #{e[:failing].first(4).join(', ')} | #{culprit} | #{e[:time_to_green_s] ? "#{n(e[:time_to_green_s])} s" : 'still red'} | #{e[:landings_during]} |"
        end
        out << ""
      end
      out << "Spend by model, with the in-platform agents on it and their calls: #{x[:spend][:by_model].map { |m, v| "#{m} #{usd(v[:usd])} (#{v[:agents]}, #{v[:agent_calls]})" }.join('; ')}. " \
             "By layer: #{(x[:spend][:by_layer] || {}).map { |l, v| "#{l} #{usd(v)}" }.join(', ')}."
      out << ""
      out
    end

    def transition_section(t)
      out = ["## Solo against #{t[:agents]} agents: transitions per intent", ""]
      out << "Each intent's outcome alone (1 agent) and among #{t[:agents]}: first try, after returns, or not landed. Median change in rounds #{n(t[:median_rounds_delta])}, in model calls #{n(t[:median_calls_delta])}."
      out << ""
      out << "| Solo → concurrent | Intents |"
      out << "| --- | --- |"
      t[:matrix].each { |k, v| out << "| #{k} | #{v} |" }
      out << ""
      unless t[:hidden].empty?
        out << "Hidden tests, solo → concurrent: #{t[:hidden].map { |k, v| "#{k} #{v}" }.join(', ')}."
        out << ""
      end
      out
    end
  end

  # --- the command line -----------------------------------------------------------------------------------------------

  def self.parse(argv)
    opts = { base: nil, agents: 8, sweep: nil, solo: false, solo_model: SOLO_MODEL, model: DEFAULT_MODEL, max_usd: 15.0,
             timeout: 2400.0, settle: 600.0, stall: 900.0, poll: 5.0, step_timeout: 180.0, approve: false, no_grade: false,
             keep: false, name: "contention-#{Time.now.utc.strftime('%m%d-%H%M%S')}", out: nil, dry: false }
    OptionParser.new do |o|
      o.banner = "Usage: FT_TOKEN=... ruby scripts/contention.rb --base <url> [options]"
      o.on("--base URL", "The deployment, e.g. https://staging.firetrident.com") { |v| opts[:base] = v }
      o.on("--agents N", Integer, "Agents in a single run (default 8)") { |v| opts[:agents] = v }
      o.on("--sweep LIST", "Agent counts, one fresh colony each, e.g. 8,16") { |v| opts[:sweep] = v.split(",").map { |x| Integer(x.strip, 10) } }
      o.on("--solo", "Add a run with 1 agent on the same intents (paired transitions)") { opts[:solo] = true }
      o.on("--solo-model MODEL", "The solo agent's model (default #{SOLO_MODEL})") { |v| opts[:solo_model] = v }
      o.on("--model SPEC", "Model id or mix (default #{DEFAULT_MODEL})") { |v| opts[:model] = v }
      o.on("--max-usd USD", Float, "Hard spend stop per run (default 15)") { |v| opts[:max_usd] = v }
      o.on("--timeout S", Float, "Stop following a run after S seconds from its release (default 2400)") { |v| opts[:timeout] = v }
      o.on("--settle S", Float, "After every intent landed, wait up to S seconds for trunk to be certified green (default 600; 0 skips)") { |v| opts[:settle] = v }
      o.on("--stall S", Float, "Stop when nothing lands for S seconds (default 900)") { |v| opts[:stall] = v }
      o.on("--poll S", Float, "Seconds between polls (default 5)") { |v| opts[:poll] = v }
      o.on("--step-timeout S", Float, "Hard time limit of each setup step and read (default 180)") { |v| opts[:step_timeout] = v }
      o.on("--approve", "Approve escalated changes as the human reviewer (default: they wait)") { opts[:approve] = true }
      o.on("--no-grade", "Do not land and certify the hidden acceptance tests at the end") { opts[:no_grade] = true }
      o.on("--keep", "Keep each colony (its agents stopped)") { opts[:keep] = true }
      o.on("--name PREFIX", "Colony name prefix; each run adds its agent count (default contention-<time>)") { |v| opts[:name] = v }
      o.on("--out DIR", "Results folder (default packages/bench/results/<date>-contention-<counts>)") { |v| opts[:out] = File.expand_path(v) }
      o.on("--note TEXT", "A line for the results' README, e.g. what the deployment sets that /api/about does not show") { |v| opts[:note] = v }
      o.on("--dry-run", "Print the plan and the cost ESTIMATE; send nothing") { opts[:dry] = true }
    end.parse!(argv)
    counts = opts[:sweep] || [opts[:agents]]
    raise Stage::ConfigError, "agent counts must be 1 to 64: #{counts.join(',')}" unless counts.all? { |c| c.between?(1, 64) }
    raise Stage::ConfigError, "--max-usd must be above 0" unless opts[:max_usd].positive?
    raise Stage::ConfigError, "--poll must be above 0" unless opts[:poll].positive?

    opts[:plan] = counts.map { |c| { label: c.to_s, agents: c, model: opts[:model] } }
    opts[:plan] << { label: "solo", agents: 1, model: opts[:solo_model] } if opts[:solo]
    opts
  end

  # The command as typed, with no secret (none is ever an argument).
  def self.command(argv) = (["ruby scripts/contention.rb"] + argv.map { |a| a.match?(/[\s'"$\\*?(){}|<>;&]/) ? "'#{a.gsub("'", "'\\\\''")}'" : a }).join(" ")

  def self.plan_lines(spec, opts)
    lines = ["plan: #{opts[:plan].size} run#{opts[:plan].size == 1 ? '' : 's'} of #{spec['intents'].size} intents on #{spec['shared']} (demo/contention/spec.md), each on a fresh colony"]
    total = 0.0
    opts[:plan].each do |p|
      e = estimate(spec, p[:agents], p[:model])
      total += e[:usd]
      lines << format("  run %-5s %2d agent%s: %s; ESTIMATE about %d model calls and %d changes reviewed, $%.2f (stop at $%.2f)",
                      p[:label], p[:agents], p[:agents] == 1 ? " " : "s", assign_models(p[:model], p[:agents]).map { |m, k| "#{m}×#{k}" }.join(", "), e[:calls], e[:proposals], e[:usd], opts[:max_usd])
    end
    lines << format("  ESTIMATE for all runs: $%.2f (at most $%.2f with every run at its stop)", total, opts[:max_usd] * opts[:plan].size)
    lines
  end

  def self.main(argv)
    original = argv.dup
    opts = parse(argv)
    spec = self.spec
    if opts[:dry]
      plan_lines(spec, opts).each { |l| puts l }
      return Stage::EXIT_PASS
    end

    base = Stage.base_url(opts[:base])
    token = Stage.token(base)
    raise Stage::ConfigError, "FT_TOKEN is not set (the deployment's admin token: set it, or put it in ~/.config/firetrident/env with that deployment's FT_URL)" unless token

    access = Stage.access_headers
    secrets = [token, *access.values]
    log = StringIO.new
    clock = Stage::Clock.new(out: Tee.new($stdout, log), secrets: secrets)
    http = Stage::Http.new(base, token: token, access: access)
    seed = seed_files
    accept = accept_files
    plan_lines(spec, opts).each { |l| clock.say(l) }
    date = Time.now.utc.strftime("%Y-%m-%d")
    runs = []
    interrupted = false
    opts[:plan].each do |p|
      run = Run.new(http: http, clock: clock, secrets: secrets, spec: spec, seed: seed, accept: accept, agents: p[:agents], model: p[:model], label: p[:label], opts: opts)
      begin
        runs << run.call
      rescue Interrupt
        runs << run.result
        interrupted = true
      end
      break if interrupted
      next unless runs.last[:stop] == "spend"

      clock.say("the spend stop ended run #{p[:label]}: no further run starts")
      break
    end
    solo = runs.find { |r| r[:label] == "solo" && r[:report] }
    transitions = solo ? runs.reject { |r| r.equal?(solo) || r[:report].nil? }.map { |r| ContentionReport.transitions(solo[:report], r[:report]).merge(agents: r[:agents]) } : []
    reported = runs.select { |r| r[:report] || r[:stop] }
    if reported.empty?
      clock.say("no run reported: nothing written")
      return Stage::EXIT_TIMEOUT
    end
    sweep = { command: command(original), base: base, date: date, runs: runs, transitions: transitions, note: opts[:note],
              spec_summary: { name: spec["name"], shared: spec["shared"], intents: spec["intents"].map { |i| i["id"] }, pairs: spec["pairs"].map { |pr| "#{pr['first']} -> #{pr['second']}" } } }
    dir = opts[:out] || Results.default_dir(date, runs)
    sweep[:log] = log.string
    Results.write(dir, Results.files(sweep), secrets)
    clock.say("wrote #{dir.delete_prefix("#{ROOT}/")} (README.md, contention.json, #{runs.map { |r| "run-#{r[:label]}.json" }.join(', ')}, run.log)")
    return Stage::EXIT_FAIL if interrupted
    return Stage::EXIT_TIMEOUT if runs.all? { |r| r[:report].nil? && r[:stop] == "step timeout" }

    runs.all? { |r| r[:stop] == "landed" && r.dig(:report, :intents, :landed) == r.dig(:report, :intents, :total) } ? Stage::EXIT_PASS : Stage::EXIT_FAIL
  rescue Stage::ConfigError, OptionParser::ParseError, ArgumentError => e
    warn("contention: #{e.message}")
    Stage::EXIT_USAGE
  rescue Failure => e
    warn("contention: #{e.message}")
    Stage::EXIT_FAIL
  end
end

exit(Contention.main(ARGV)) if $PROGRAM_NAME == __FILE__
