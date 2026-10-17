#!/usr/bin/env ruby
# frozen_string_literal: true

# The recipe check: a rename lands while agents hold edits on the files it renames, and none of them goes back.
#
#   1. a fresh colony named recipe-<time>, with review off, so the trunk writer alone decides and no model is asked
#   2. a seed agent lands a small TypeScript project: src/core.ts exports function X, and src/use_1.ts .. src/use_N.ts
#      each import X and call it (one inline change)
#   3. N scripted agents each hold an intent on one use file and take work from the same trunk
#   4. the first half change their files (one more call of X each) and land
#   5. a person's recipe renames X to Y across src/** (POST /recipes, rename-identifier): the trunk writer lands it
#   6. the second half, still on the trunk before the rename, change their files with X and propose: each lands with the
#      recipe applied to what it wrote (its note records it), instead of going back stale
#   7. it prints how many agent changes landed and how many came back (should be 0), and greps trunk for X through the
#      recipe's residue (the files the rename would still change, and the files with X as a word: should be 0), then
#      deletes the colony (--keep leaves it)
#
# Every agent is this script over the HTTP API with inline changes (synthetic agents): no git, no model calls. Each step
# has a hard time limit; a step that runs out says what it was waiting for, and the script exits 3.
#
# Usage:
#   FT_TOKEN=<admin token> ruby scripts/recipe_check.rb --base https://staging.firetrident.com [--agents 8] [--keep]
#     [--name NAME] [--step-timeout 90]
#
# Behind Cloudflare Access, set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET; they go with every request. FT_TOKEN
# comes from the environment, else from ~/.config/firetrident/env when that file's FT_URL is this deployment. Never
# prints a token. Exit codes: 0 every change landed and no X is left, 1 not, 2 a setting is missing, 3 a step timed out.
require "optparse"
require_relative "stage"

module RecipeCheck
  OLD = "X"
  NEW = "Y"
  SETTLED = %w[landed returned rejected escalated].freeze
  BY = ENV.fetch("FT_USER", "stage-recipe")
  # Inline changes carry at most 64 files: the seed is core.ts and one file per agent.
  MAX_AGENTS = 40

  # The check could not show what it should; the message says what happened.
  class Failure < StandardError; end

  def self.core_text = "export function #{OLD}(n: number): number {\n  return n * 2;\n}\n"

  def self.use_path(i) = "src/use_#{i}.ts"

  def self.use_text(i) = "import { #{OLD} } from \"./core.ts\";\n\nexport const value#{i} = #{OLD}(#{i});\n"

  # Agent i's edit: one more call of the old name, as an agent that took work before the rename would write it.
  def self.edited_text(i) = "#{use_text(i)}export const extra#{i} = #{OLD}(#{i} + 1);\n"

  def self.short(sha) = sha.to_s[0, 7]

  # One run of the check against one deployment.
  class Run
    def initialize(http:, clock:, secrets:, agents:, keep:, name:, step_timeout:)
      @http = http
      @clock = clock
      @secrets = secrets
      @n = agents
      @keep = keep
      @name = name || "recipe-#{Time.now.utc.strftime('%m%d-%H%M%S')}"
      @step_timeout = step_timeout.to_f
      @deadline = Stage.now + @step_timeout
      @waiting = "the deployment"
    end

    # Run every step, then clean up. Returns the exit code.
    def call
      preflight
      create_colony
      seed
      take_all
      first, second = (1..@n).to_a.partition { |i| i <= @n / 2 }
      settled = propose_and_settle(first, "before the rename")
      recipe = declare_recipe
      settled += propose_and_settle(second, "on the trunk before the rename, after it landed")
      verdict(settled, recipe, second)
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

    # --- steps --------------------------------------------------------------------------------------------------------

    def preflight
      res = @http.request(:get, "/api/about", timeout: [@step_timeout, 15].min, auth: false)
      about = res.ok? && res.json.is_a?(Hash) ? res.json : nil
      @clock.say("recipe check: #{@n} agents edit files that use #{OLD} while a rename of #{OLD} to #{NEW} lands, on #{@http.base}#{about&.dig('commit') ? " (build #{about['commit']})" : ''}")
      return @clock.say("/api/about did not answer (#{res.problem}); going on") unless about
      raise Failure, "inline changes are off on this deployment (FT_INLINE is not on in /api/about), and every agent here proposes inline" unless Array(about["flags"]).include?("FT_INLINE")
    end

    def create_colony
      created, secs = step("the deployment to create colony #{@name}") do
        res = api(:post, "/colonies", { name: @name, pool: 3 })
        raise Failure, "colony #{@name} already exists: pass another --name" if res.code == 409
        raise Failure, "creating colony #{@name}: #{res.problem}" unless res.ok?

        res.json
      end
      @colony = created["id"]
      step("review to switch off on #{@colony}") { api!(:post, "/colonies/#{@colony}/decide/policy", { enabled: false }) }
      @clock.say("created colony #{@colony} (#{fmt(secs)}); review is off, so the trunk writer alone decides and no model is asked")
    end

    def seed
      files = { "src/core.ts" => RecipeCheck.core_text }
      (1..@n).each { |i| files[RecipeCheck.use_path(i)] = RecipeCheck.use_text(i) }
      landed, secs = step("the seed change to land") do
        agent = register("recipe-seed")
        intent = declare(agent, "Seed a small TypeScript project that uses #{OLD}", files.keys)
        took = take(agent, intent["id"], "the seed agent")
        settle(propose(agent, took, files.transform_values { nil }, files, "seed #{files.size} files"), "the seed agent")
      end
      raise Failure, "the seed change #{landed['id']} did not land: it is #{landed['status']}#{reason_of(landed)}" unless landed["status"] == "landed"

      @clock.say("seeded src/core.ts (exports #{OLD}) and #{@n} files that import and call it, in #{landed['landingId']} (#{fmt(secs)})")
    end

    def take_all
      @agents = {}
      _, secs = step("#{@n} agents to be handed their intents") do
        (1..@n).each do |i|
          agent = register("recipe-agent-#{i}")
          path = RecipeCheck.use_path(i)
          intent = declare(agent, "Add a second value to #{path}", [path])
          @agents[i] = { agent: agent, took: take(agent, intent["id"], "agent #{i}") }
        end
      end
      bases = @agents.values.map { |a| a[:took].dig("lease", "baseSha") }.uniq
      raise Failure, "the agents took work on different trunks (#{bases.map { |b| short(b) }.join(', ')}), so this is not the check" unless bases.size == 1

      @base = bases.first
      @clock.say("#{@n} agents each hold an intent on one file and took work from the same trunk, #{short(@base)} (#{fmt(secs)})")
    end

    # Propose each agent's edit (the file as it was at the lease base, plus one more call of X), all at once, then wait for each.
    def propose_and_settle(ids, when_text)
      return [] if ids.empty?

      settled, secs = step("#{ids.size} agent changes #{when_text} to land or go back") do
        proposed = ids.map do |i|
          a = @agents[i]
          path = RecipeCheck.use_path(i)
          [i, propose(a[:agent], a[:took], { path => RecipeCheck.use_text(i) }, { path => RecipeCheck.edited_text(i) }, "one more call of #{OLD} in #{path}")]
        end
        proposed.map { |i, p| [i, settle(p, "agent #{i}")] }
      end
      landed = settled.count { |_, p| p["status"] == "landed" }
      @clock.say("agents #{ids.first}..#{ids.last}, #{when_text}: #{landed} of #{ids.size} landed (#{fmt(secs)})")
      settled.each do |i, p|
        next if p["status"] == "landed"

        @clock.print("  agent #{i}'s change #{p['id']} #{p['status']}#{reason_of(p)}")
      end
      settled
    end

    def declare_recipe
      res, secs = step("the rename of #{OLD} to #{NEW} to land") do
        body = { kind: "rename-identifier", args: { from: OLD, to: NEW }, scope: ["src/**"], why: "Recipe check: rename #{OLD} to #{NEW} while agents hold edits on the files that use it.", by: BY }
        out = api(:post, "/colonies/#{@colony}/recipes", body)
        raise Failure, "declaring the recipe: #{out.problem}" unless out.ok? && out.json

        recipe = out.json["recipe"] || {}
        recipe = poll_recipe(recipe["id"]) unless %w[landed held failed].include?(recipe["state"])
        recipe
      end
      raise Failure, "the recipe #{res['id']} is #{res['state']}: #{res['reason'] || 'no reason given'}" unless res["state"] == "landed"

      batches = Array(res["batches"])
      @clock.say("a person's recipe #{res['id']} renamed #{OLD} to #{NEW} across src/**: #{res['changed']} of #{res['examined']} files rewritten in #{batches.size} commit#{batches.size == 1 ? '' : 's'} (#{batches.map { |b| b['landingId'] }.join(', ')}) (#{fmt(secs)})")
      res
    end

    def poll_recipe(id)
      loop do
        r = api!(:get, "/colonies/#{@colony}/recipes/#{id}")["record"]
        return r if %w[landed held failed].include?(r["state"])

        @waiting = "recipe #{id} to finish landing (it is #{r['state']})"
        pause(1)
      end
    end

    # Every change landed, none came back, the late ones carry the recipe in their notes, and trunk has no X left.
    def verdict(settled, recipe, late)
      landed = settled.count { |_, p| p["status"] == "landed" }
      back = settled.count { |_, p| p["status"] == "returned" }
      other = settled.size - landed - back
      shown, = step("the recipe's residue on trunk") { api!(:get, "/colonies/#{@colony}/recipes/#{recipe['id']}") }
      residue = shown["residue"] || {}
      rewrite = Array(residue["rewrite"])
      grep = Array(residue["grep"])
      late_landed = late.count { |i| settled.to_h[i]&.dig("status") == "landed" }
      applied = late.count { |i| recipes_in_note(i, settled.to_h[i]).any? { |r| r["recipe"] == recipe["id"] } }
      @clock.print
      @clock.print("agent changes landed:          #{landed} of #{@n}")
      @clock.print("agent changes came back:       #{back}#{other.positive? ? " (and #{other} waiting for a person or rejected)" : ''}")
      @clock.print("late changes with the recipe:  #{applied} of #{late.size} (their lineage notes record it)")
      @clock.print("trunk files #{OLD} would still be renamed in: #{rewrite.size}#{rewrite.empty? ? '' : " (#{rewrite.first(5).join(', ')})"}")
      @clock.print("trunk files naming #{OLD} (grep, as a word): #{grep.size}#{grep.empty? ? '' : " (#{grep.first(5).join(', ')})"}")
      @clock.print
      problems = []
      problems << "#{@n - landed} agent change#{@n - landed == 1 ? '' : 's'} did not land" unless landed == @n
      problems << "#{back} change#{back == 1 ? '' : 's'} came back" unless back.zero?
      problems << "#{late_landed - applied} late change#{late_landed - applied == 1 ? '' : 's'} landed without the recipe in its note" unless applied == late_landed
      problems << "trunk still names #{OLD} in #{(rewrite | grep).size} file#{(rewrite | grep).size == 1 ? '' : 's'}" unless rewrite.empty? && grep.empty?
      raise Failure, problems.join("; ") unless problems.empty?

      @clock.say("PASS #{landed} of #{@n} agent changes landed, 0 came back, and trunk names #{OLD} nowhere")
      Stage::EXIT_PASS
    end

    # The recipes the lineage note of agent i's landing records for its proposal (GET /why on its file).
    def recipes_in_note(i, proposal)
      return [] unless proposal && proposal["status"] == "landed"

      path = RecipeCheck.use_path(i)
      answer = api(:get, "/colonies/#{@colony}/why?path=#{URI.encode_www_form_component(path)}")
      entries = answer.ok? && answer.json.is_a?(Array) ? answer.json : []
      entry = entries.find { |e| e.dig("landing", "id") == proposal["landingId"] }
      prop = Array(entry&.dig("note", "proposals")).find { |x| x["id"] == proposal["id"] }
      Array(prop && prop["recipes"])
    end

    def cleanup
      return unless @colony
      return @clock.say("kept colony #{@colony}: #{@http.base}/c/#{@colony}") if @keep

      res = @http.request(:delete, "/api/colonies/#{@colony}", timeout: 600)
      @clock.say(res.ok? ? "deleted colony #{@colony}" : "could not delete colony #{@colony} (#{res.problem}): delete it with ft delete #{@colony}")
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

    def declare(agent, title, footprint)
      res = api(:post, "/colonies/#{@colony}/intents", { title: title, why: "The recipe check.", footprint: footprint, assignedTo: agent, createdBy: BY, force: true })
      raise Failure, "declaring \"#{title}\": #{res.problem}" unless res.ok? && res.json
      raise Failure, "declaring \"#{title}\" answered the colony's intent #{res.json['duplicateOf']} instead of a new one" if res.json["duplicateOf"]

      res.json
    end

    # Take until the agent holds `intent_id` (a new colony's workspace pool may still be forking).
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

    # Propose `files` (path => text) as an inline change on the lease's base; `read` maps each file it read to its text
    # at the base (nil: the file was not there).
    def propose(agent, took, read, files, summary)
      write = files.map { |path, text| { path: path, blob: Stage.blob_id(text) } }
      base = took.dig("lease", "baseSha")
      body = {
        intentId: took.dig("intent", "id"), agentId: agent, workspace: took.dig("lease", "repo"), baseSha: base,
        headSha: Stage.changeset_id(base, write), writeSet: write,
        readSet: read.compact.map { |path, text| { path: path, blob: Stage.blob_id(text) } },
        contents: files.to_h { |_, text| [Stage.blob_id(text), text] }, intentRevision: took.dig("intent", "revision") || 1,
        declared: { footprint: files.keys, summary: summary },
        evidence: { checks: [], notVerified: "A scripted recipe check: no tests were run." }
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

    def reason_of(p) = p["reason"] ? ": #{p['reason']}" : ""

    def short(sha) = RecipeCheck.short(sha)

    def fmt(secs) = format("%.1f s", secs)
  end

  # Parse the command line and run the check; returns the exit code.
  def self.main(argv)
    opts = { agents: 8, keep: false, name: nil, step_timeout: 90.0, base: nil }
    OptionParser.new do |o|
      o.banner = "Usage: FT_TOKEN=... ruby scripts/recipe_check.rb --base <url> [options]"
      o.on("--base URL", "The deployment, e.g. https://staging.firetrident.com") { |v| opts[:base] = v }
      o.on("--agents N", Integer, "Scripted agents, each on its own file (default 8, at most #{MAX_AGENTS})") { |v| opts[:agents] = v }
      o.on("--keep", "Keep the colony the check creates (default: delete it at the end)") { opts[:keep] = true }
      o.on("--name NAME", "Name of the new colony (default recipe-<time>)") { |v| opts[:name] = v }
      o.on("--step-timeout S", Float, "Hard time limit of each step, in seconds (default 90)") { |v| opts[:step_timeout] = v }
    end.parse!(argv)
    raise Stage::ConfigError, "--agents must be 2 to #{MAX_AGENTS}" unless opts[:agents].between?(2, MAX_AGENTS)

    base = Stage.base_url(opts[:base])
    token = Stage.token(base)
    raise Stage::ConfigError, "FT_TOKEN is not set (the deployment's admin token: set it, or put it in ~/.config/firetrident/env with that deployment's FT_URL)" unless token

    access = Stage.access_headers
    secrets = [token, *access.values]
    clock = Stage::Clock.new(secrets: secrets)
    http = Stage::Http.new(base, token: token, access: access)
    Run.new(http: http, clock: clock, secrets: secrets, agents: opts[:agents], keep: opts[:keep], name: opts[:name], step_timeout: opts[:step_timeout]).call
  rescue Stage::ConfigError, OptionParser::ParseError => e
    warn("recipe_check: #{e.message}")
    Stage::EXIT_USAGE
  end
end

exit(RecipeCheck.main(ARGV)) if $PROGRAM_NAME == __FILE__
