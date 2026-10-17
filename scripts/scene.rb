# frozen_string_literal: true

# What the recipe scenes share (scripts/scene_rename.rb, scripts/scene_smuggle.rb): the shop project and its derived
# data from scripts/scene_data.ts, and the steps of one run on a throwaway colony, each under its own time limit as
# scripts/recipe_check.rb takes them: create the colony with review off, land the project with seed agents (one inline
# change per chunk, all in flight at once), register scripted agents that hold intents, propose and wait, record the
# colony for playback with no network (scripts/record_colony.ts), and delete it.
#
# Every agent is a script over the HTTP API (synthetic agents): no model calls. Nothing printed names a token: every line
# goes through Stage.redact with the admin token, the Access secret and each lease token.
require "json"
require "optparse"
require "uri"
require_relative "stage"

module Scene
  SETTLED = %w[landed returned rejected escalated].freeze
  BY = ENV.fetch("FT_USER", "stage-scene")

  # The scene could not show what it should; the message says what happened.
  class Failure < StandardError; end

  # The scenes' data (scripts/scene_data.ts): "recipe", "from", "to", "files", "users", "seed", "renamed", "edits" and
  # "smuggle". Raises Failure when the generator does not answer.
  def self.data(timeout: 120)
    script = File.expand_path("scene_data.ts", __dir__)
    ok, out, err, timed_out = Stage.run([Stage::NODE, script], chdir: File.expand_path("..", __dir__), timeout: timeout)
    raise Failure, "scripts/scene_data.ts did not finish within #{timeout} s" if timed_out
    raise Failure, "scripts/scene_data.ts failed: #{err.strip.lines.last.to_s.strip[0, 300]}" unless ok

    JSON.parse(out)
  rescue JSON::ParserError => e
    raise Failure, "scripts/scene_data.ts printed no JSON (#{e.message[0, 120]})"
  end

  # 1234 as "1,234".
  def self.n(x) = x.to_i.to_s.reverse.scan(/\d{1,3}/).join(",").reverse

  # "1 file", "212 files".
  def self.count(x, one, many = "#{one}s") = "#{n(x)} #{x.to_i == 1 ? one : many}"

  def self.short(sha) = sha.to_s[0, 7]

  # "a" or "an" before a number as it is read aloud: an 8, an 11, an 18, an 893, an 11,400; a 212.
  def self.article(x)
    lead = n(x).split(",").first.to_s
    lead.start_with?("8") || %w[11 18].include?(lead) ? "an" : "a"
  end

  # Lines of `text` that name `word` as a whole identifier.
  def self.naming(text, word) = text.to_s.lines.count { |l| l.match?(/(?<![\w$])#{Regexp.escape(word)}(?![\w$])/) }

  # One run of a scene on one deployment. A scene subclasses it, names its colony prefix and recording, and implements
  # `scene`, which returns the exit code; `call` runs it, records the colony when asked and the scene passed, and cleans up.
  class Run
    def initialize(http:, clock:, secrets:, data:, base:, access: {}, keep: false, name: nil, record: false, record_out: nil, step_timeout: 90)
      @http = http
      @clock = clock
      @secrets = secrets
      @data = data
      @base = base
      @access = access
      @keep = keep
      @name = name || "#{prefix}-#{Time.now.utc.strftime('%m%d-%H%M%S')}"
      @record = record
      @record_out = record_out
      @step_timeout = step_timeout.to_f
      @deadline = Stage.now + @step_timeout
      @waiting = "the deployment"
    end

    # Run the scene, record it when asked and it passed, then clean up. Returns the exit code.
    def call
      code = scene
      record_colony if @record && code == Stage::EXIT_PASS
      code
    rescue Stage::StepTimeout => e
      @clock.say("TIMEOUT #{e.message}")
      Stage::EXIT_TIMEOUT
    rescue Failure => e
      @clock.say("FAIL #{e.message}")
      Stage::EXIT_FAIL
    rescue Interrupt
      @clock.say("stopped by an interrupt")
      Stage::EXIT_FAIL
    ensure
      cleanup
    end

    private

    # The colony's name before its time stamp, and the recording's name (each scene says its own).
    def prefix = raise(NotImplementedError)
    def recording = raise(NotImplementedError)

    def from = @data["from"]
    def to = @data["to"]

    # --- shared steps -------------------------------------------------------------------------------------------------

    # Say what runs where; refuse a deployment without the flags the scene needs (FT_INLINE: the agents propose inline).
    def preflight(intro, flags)
      res = @http.request(:get, "/api/about", timeout: [@step_timeout, 15].min, auth: false)
      about = res.ok? && res.json.is_a?(Hash) ? res.json : nil
      @clock.say("#{intro}, on #{@http.base}#{about&.dig('commit') ? " (build #{about['commit']})" : ''}")
      return @clock.say("/api/about did not answer (#{res.problem}); going on without the deployment's flags") unless about

      missing = flags.keys.reject { |f| Array(about["flags"]).include?(f) }
      raise Failure, missing.map { |f| "#{flags[f]} (#{f} is not on in /api/about)" }.join("; ") unless missing.empty?
    end

    # A new colony with `pool` workspaces forked ahead, and review off so the seed lands with no model asked.
    def create_colony(pool)
      created, secs = step("the deployment to create colony #{@name}") do
        res = api(:post, "/colonies", { name: @name, pool: pool })
        raise Failure, "colony #{@name} already exists: pass another --name" if res.code == 409
        raise Failure, "creating colony #{@name}: #{res.problem}" unless res.ok?

        res.json
      end
      @colony = created["id"]
      review(false)
      @clock.say("created colony #{@colony} (#{fmt(secs)}); review is off, so the trunk writer alone decides and no model is asked")
    end

    # Switch the colony's review (the decide stage) on or off.
    def review(on)
      step("review to switch #{on ? 'on' : 'off'} on #{@colony}") { api!(:post, "/colonies/#{@colony}/decide/policy", { enabled: on }) }
    end

    # Land the project: one seed agent per chunk, every chunk proposed before any is waited on.
    def seed
      files = @data["files"]
      chunks = @data["seed"]
      settled, secs = step("the seed's #{chunks.size} changes to land") do
        took = chunks.each_with_index.map do |paths, i|
          agent = register("seed-#{i + 1}")
          intent = declare(agent, "Seed the shop, part #{i + 1} of #{chunks.size}", paths, "The project the scene runs on.")
          [agent, paths, take(agent, intent["id"], "seed agent #{i + 1}")]
        end
        proposed = took.map { |agent, paths, t| propose_inline(agent, t, {}, paths.to_h { |p| [p, files.fetch(p)] }, "Seed #{paths.size} files of the shop") }
        proposed.each_with_index.map { |p, i| settle(p, "seed agent #{i + 1}") }
      end
      bad = settled.reject { |p| p["status"] == "landed" }
      raise Failure, "#{Scene.count(bad.size, 'seed change')} did not land: #{bad.map { |p| "#{p['id']} #{p['status']}#{reason_of(p)}" }.join('; ')}" unless bad.empty?

      landings = settled.map { |p| p["landingId"] }.uniq
      @clock.say("seeded the shop: #{Scene.count(files.size, 'file')} (#{Scene.count(@data['users'].size, 'file')} name #{from}) in #{Scene.count(chunks.size, 'inline change')}, #{Scene.count(landings.size, 'landing')} (#{fmt(secs)})")
    end

    # Record the colony for playback with no network (scripts/record_colony.ts), into the web app's bundled recordings
    # under the scene's name, or into --record-out.
    def record_colony
      script = File.expand_path("record_colony.ts", __dir__)
      out_args = @record_out ? ["--out", @record_out] : ["--bundle"]
      @clock.say("recording #{@colony} for playback with no network (scripts/record_colony.ts)")
      env = { "CF_ACCESS_CLIENT_ID" => @access["CF-Access-Client-Id"], "CF_ACCESS_CLIENT_SECRET" => @access["CF-Access-Client-Secret"] }
      ok, out, err, timed_out = Stage.run([Stage::NODE, "--experimental-transform-types", script, "--base", @base, "--colony", @colony, "--name", recording, *out_args],
                                          env: env, chdir: File.expand_path("..", __dir__), timeout: 600)
      raise Failure, "the recorder did not finish within 600 s" if timed_out
      raise Failure, "the recorder failed: #{(err.strip.lines.last || out.strip.lines.last).to_s.strip[0, 300]}" unless ok

      out.lines.each { |l| @clock.print("  #{l.chomp}") }
      where = @record_out || "packages/web/public/recordings/#{recording}.json.gz"
      @clock.say("recorded: #{where}; once bundled, the director plays it at /c/#{recording}?director=1&replay=1&recording=#{recording}&scene=#{recording}")
    end

    def cleanup
      return unless @colony
      return @clock.say("kept colony #{@colony}: #{@http.base}/c/#{@colony}") if @keep

      res = @http.request(:delete, "/api/colonies/#{@colony}", timeout: 600)
      @clock.say(res.ok? ? "deleted colony #{@colony}" : "could not delete colony #{@colony} (#{res.problem}): delete it with ft delete #{@colony} --yes")
    end

    # --- the API ------------------------------------------------------------------------------------------------------

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
      raise Failure, "#{method.to_s.upcase} /api#{path}: #{res.problem}" unless res.ok? && res.json

      res.json
    end

    def pause(seconds)
      raise Stage::StepTimeout.new(@waiting, @step_timeout) if left <= 0

      sleep([seconds, left].min)
    end

    def register(name)
      api!(:post, "/colonies/#{@colony}/agents", { name: name, kind: "synthetic", model: "scripted" })["id"]
    end

    # An intent assigned to `agent` (claimed for it at once), declared even when it matches another (force: twin intents).
    def declare(agent, title, footprint, why)
      res = api(:post, "/colonies/#{@colony}/intents", { title: title, why: why, footprint: footprint, assignedTo: agent, createdBy: Scene::BY, force: true })
      raise Failure, "declaring \"#{title[0, 80]}\": #{res.problem}" unless res.ok? && res.json
      raise Failure, "declaring \"#{title[0, 80]}\" answered the colony's intent #{res.json['duplicateOf']} instead of a new one" if res.json["duplicateOf"]

      res.json
    end

    # Take until the agent holds `intent_id` (a new colony's workspace pool may still be forking). Its lease tokens join
    # the secrets every printed line is redacted of.
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

    # Propose `files` (path => text) as an inline change on the lease's base; `read` maps each file it read to its text at
    # the base. `recipe`: the recipe the change says made it (review by reproduction).
    def propose_inline(agent, took, read, files, summary, recipe: nil)
      write = files.map { |path, text| { path: path, blob: Stage.blob_id(text) } }
      base = took.dig("lease", "baseSha")
      body = {
        intentId: took.dig("intent", "id"), agentId: agent, workspace: took.dig("lease", "repo"), baseSha: base,
        headSha: Stage.changeset_id(base, write), writeSet: write,
        readSet: read.map { |path, text| { path: path, blob: Stage.blob_id(text) } },
        contents: files.to_h { |_, text| [Stage.blob_id(text), text] }, intentRevision: took.dig("intent", "revision") || 1,
        declared: { footprint: files.keys, summary: summary },
        evidence: { checks: [], notVerified: "A scripted scene agent: no tests were run." }
      }
      body[:recipe] = recipe if recipe
      api!(:post, "/colonies/#{@colony}/proposals", body)
    end

    # Poll a proposal until it lands, goes back, is rejected or waits for a person.
    def settle(proposal, who)
      loop do
        p = api!(:get, "/colonies/#{@colony}/proposals/#{proposal['id']}")
        return p if Scene::SETTLED.include?(p["status"])

        @waiting = "#{who}'s change #{proposal['id']} to land or go back (it is #{p['status']})"
        pause(0.5)
      end
    end

    # The gate check of a proposal's evidence: its rule and its line ("D5 reproduced by recipe → land by deterministic ...").
    def gate_of(p)
      check = Array(p.dig("evidence", "checks")).find { |c| c["name"] == "gate" }
      { rule: check&.dig("gate", "rule") || check&.dig("detail").to_s.split(" → ").first, line: check&.dig("detail") }
    end

    # Model calls counted against an intent (FT_INTENT_SPEND); nil when the deployment does not count them.
    def model_calls(intent_id)
      res = api(:get, "/colonies/#{@colony}/intents/#{intent_id}/spend")
      calls = res.ok? && res.json.is_a?(Hash) ? res.json["calls"] : nil
      calls.is_a?(Hash) ? calls.values.sum(&:to_i) : nil
    end

    def reason_of(p) = p["reason"] ? ": #{p['reason']}" : ""

    def fmt(secs) = format("%.1f s", secs)
  end

  # The command line every scene takes; returns [options, http, clock, secrets, base, access] or raises a usage error.
  def self.setup(argv, name, opts)
    OptionParser.new do |o|
      o.banner = "Usage: FT_TOKEN=... ruby scripts/#{name}.rb --base <url> [options]"
      o.on("--base URL", "The deployment, e.g. https://staging.firetrident.com") { |v| opts[:base] = v }
      o.on("--record", "Record the colony into packages/web/public/recordings/#{opts[:recording]}.json.gz when the scene passes") { opts[:record] = true }
      o.on("--record-out FILE", "Record to FILE instead (implies --record)") do |v|
        opts[:record] = true
        opts[:record_out] = File.expand_path(v)
      end
      o.on("--keep", "Keep the colony the scene creates (default: delete it at the end)") { opts[:keep] = true }
      o.on("--name NAME", "Name of the new colony (default #{opts[:recording]}-<time>)") { |v| opts[:name] = v }
      o.on("--step-timeout S", Float, "Hard time limit of each step, in seconds (default #{Stage.seconds(opts[:step_timeout])})") { |v| opts[:step_timeout] = v }
      yield o if block_given?
    end.parse!(argv)
    base = Stage.base_url(opts[:base])
    token = Stage.token(base)
    raise Stage::ConfigError, "FT_TOKEN is not set (the deployment's admin token: set it, or put it in ~/.config/firetrident/env with that deployment's FT_URL)" unless token

    access = Stage.access_headers
    secrets = [token, *access.values]
    clock = Stage::Clock.new(secrets: secrets)
    http = Stage::Http.new(base, token: token, access: access)
    { http: http, clock: clock, secrets: secrets, base: base, access: access }
  end
end
