#!/usr/bin/env ruby
# frozen_string_literal: true

# The finals' rename scene: a person's recipe renames formatPrice to formatAmount across a shop of three hundred files
# while thirty agents hold edits on forty of the files that call it, and none of their changes goes back.
#
#   1. a throwaway colony named rename-<time>, with review off, so the trunk writer alone decides and no model is asked
#   2. five seed agents land the shop (scripts/scene_project.ts: 300 files, 212 naming formatPrice) as inline changes
#   3. 30 scripted agents each hold an intent on one or two of 40 files that call formatPrice, all on that trunk
#   4. a person's recipe renames formatPrice to formatAmount across src/** (POST /recipes, rename-identifier); the trunk
#      writer lands it in batches of at most 100 files, one commit each
#   5. the 30 agents propose the edits they held, written on the trunk before the rename (each changes a line that calls
#      formatPrice; inline changes): each lands with the recipe applied to what it wrote, instead of going back
#   6. it prints the files the recipe rewrote and its commits, the agent changes that landed and that came back, the
#      landings carrying the new name (each landed file is its agent's edit with formatAmount for formatPrice, and the
#      lineage note records the recipe), trunk naming formatPrice nowhere (the recipe's residue), and what stock git makes
#      of the same base, rename and edits (scripts/scene_git.rb: "git: N of 30 conflict")
#   7. with --record it records the colony into packages/web/public/recordings/rename.json.gz (scripts/record_colony.ts)
#      for the director's rename scene; then it deletes the colony (--keep leaves it)
#
# Every agent is this script over the HTTP API with inline changes (synthetic agents): no model calls. Each step has a
# hard time limit; a step that runs out says what it was waiting for, and the script exits 3.
#
# Usage:
#   FT_TOKEN=<admin token> ruby scripts/scene_rename.rb --base https://staging.firetrident.com [--record]
#     [--record-out FILE] [--keep] [--name NAME] [--step-timeout 90]
#
# Behind Cloudflare Access, set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET; they go with every request, the
# recorder's included. FT_TOKEN comes from the environment, else from ~/.config/firetrident/env when that file's FT_URL
# is this deployment. Never prints a token. Needs git and a Node that runs TypeScript files. Exit codes: 0 every change
# landed with the new name and trunk names formatPrice nowhere, 1 not, 2 a setting is missing, 3 a step timed out.
require_relative "scene"
require_relative "scene_git"

module SceneRename
  RECORDING = "rename"
  # Workspaces forked ahead: the 30 agents and the five seed agents, with room to spare.
  POOL = 40

  # One run of the rename scene on one deployment.
  class Run < Scene::Run
    private

    def prefix = RECORDING
    def recording = RECORDING

    def edits = @data["edits"]

    def scene
      t0 = Stage.now
      preflight("rename scene: #{edits.size} agents hold edits on #{edits.sum { |e| e['files'].size }} files that call #{from} while a person's recipe renames it to #{to} across src/**",
                { "FT_INLINE" => "inline changes are off on this deployment, and every agent here proposes inline" })
      create_colony(POOL)
      seed
      take_all
      recipe = declare_recipe
      settled = propose_all
      named = landed_with_new_name(settled, recipe)
      residue = residue_of(recipe)
      git = git_comparison
      verdict(settled, recipe, named, residue, git, Stage.now - t0)
    end

    # --- steps --------------------------------------------------------------------------------------------------------

    # Each agent registers, is assigned an intent on its files, and takes it; all must hold the same trunk.
    def take_all
      @agents = {}
      _, secs = step("#{edits.size} agents to be handed their intents") do
        edits.each do |e|
          i = e["agent"]
          agent = register("scene-agent-#{i}")
          intent = declare(agent, e["title"], e["files"].map { |f| f["path"] }, e["why"])
          @agents[i] = { agent: agent, edit: e, took: take(agent, intent["id"], "agent #{i}") }
        end
      end
      bases = @agents.values.map { |a| a[:took].dig("lease", "baseSha") }.uniq
      raise Scene::Failure, "the agents took work on different trunks (#{bases.map { |b| Scene.short(b) }.join(', ')}), so this is not the scene" unless bases.size == 1

      @base_sha = bases.first
      @clock.say("#{edits.size} agents each hold an intent on 1 or 2 of #{edits.sum { |e| e['files'].size }} files that call #{from}, all on trunk #{Scene.short(@base_sha)} (#{fmt(secs)})")
    end

    # The person's recipe: rename-identifier from to, over src/**. Waits until the trunk writer has landed all of it.
    def declare_recipe
      r = @data["recipe"]
      res, secs = step("the rename of #{from} to #{to} to land") do
        body = { kind: r["kind"], version: r["version"], args: r["args"], scope: r["scope"], by: Scene::BY, why: @data["recipeWhy"] }
        out = api(:post, "/colonies/#{@colony}/recipes", body)
        raise Scene::Failure, "declaring the recipe: #{out.problem}" unless out.ok? && out.json

        recipe = out.json["recipe"] || {}
        %w[landed held failed].include?(recipe["state"]) ? recipe : poll_recipe(recipe["id"])
      end
      raise Scene::Failure, "the recipe #{res['id']} is #{res['state']}: #{res['reason'] || 'no reason given'}" unless res["state"] == "landed"

      batches = Array(res["batches"])
      @clock.say("a person's recipe #{res['id']} renamed #{from} to #{to} across src/**: #{Scene.n(res['changed'])} of #{Scene.n(res['examined'])} files rewritten in #{Scene.count(batches.size, 'commit')} (#{batches.map { |b| b['landingId'] }.join(', ')}) (#{fmt(secs)})")
      res
    end

    def poll_recipe(id)
      loop do
        r = api!(:get, "/colonies/#{@colony}/recipes/#{id}")["record"]
        return r if %w[landed held failed].include?(r["state"])

        @waiting = "recipe #{id} to finish landing (it is #{r['state']}, #{Scene.n(r['changed'])} files rewritten so far)"
        pause(1)
      end
    end

    # Every agent proposes the edit it held (written on the trunk before the rename), all before any is waited on. Each
    # read its files and src/lib/price.ts, the module that defines the name, as they were on that trunk.
    def propose_all
      files = @data["files"]
      settled, secs = step("#{edits.size} agent changes built before the rename to land or go back") do
        proposed = @agents.map do |i, a|
          read = a[:edit]["files"].to_h { |f| [f["path"], f["before"]] }.merge("src/lib/price.ts" => files.fetch("src/lib/price.ts"))
          written = a[:edit]["files"].to_h { |f| [f["path"], f["after"]] }
          [i, propose_inline(a[:agent], a[:took], read, written, a[:edit]["title"])]
        end
        proposed.map { |i, p| [i, settle(p, "agent #{i}")] }
      end
      landed = settled.count { |_, p| p["status"] == "landed" }
      @clock.say("the #{edits.size} agents proposed the edits they held, written before the rename: #{landed} landed, #{settled.count { |_, p| p['status'] == 'returned' }} came back (#{fmt(secs)})")
      settled.each { |i, p| @clock.print("  agent #{i}'s change #{p['id']} #{p['status']}#{reason_of(p)}") unless p["status"] == "landed" }
      settled
    end

    # The agents whose every file landed as their edit with the new name (the landed blob is the edit through the
    # recipe, and the landing's lineage note records the recipe for the change). Returns { landed:, named:, files: }.
    def landed_with_new_name(settled, recipe)
      why = {}
      named = 0
      files = 0
      landed = settled.select { |_, p| p["status"] == "landed" }
      _, secs = step("the lineage of the agents' landings") do
        landed.each do |i, p|
          ok = @agents[i][:edit]["files"].all? do |f|
            entries = (why[f["path"]] ||= lineage(f["path"]))
            entry = entries.find { |e| e.dig("landing", "id") == p["landingId"] }
            prop = Array(entry&.dig("note", "proposals")).find { |x| x["id"] == p["id"] }
            blob = Array(prop&.dig("writeSet")).find { |w| w["path"] == f["path"] }&.dig("blob")
            good = blob == Stage.blob_id(f["landed"]) && Array(prop&.dig("recipes")).any? { |r| r["recipe"] == recipe["id"] }
            files += 1 if good
            good
          end
          named += 1 if ok
        end
      end
      @clock.say("read the lineage of #{Scene.count(why.size, 'file')} the agents landed (#{fmt(secs)})")
      { landed: landed.size, named: named, files: files }
    end

    def lineage(path)
      res = api(:get, "/colonies/#{@colony}/why?path=#{URI.encode_www_form_component(path)}")
      res.ok? && res.json.is_a?(Array) ? res.json : []
    end

    # What the rename would still change on trunk (GET /recipes/:rid with the admin token): files to rewrite, and files
    # naming the old name as a word (the plain grep, comments and strings included).
    def residue_of(recipe)
      shown, = step("the recipe's residue on trunk") { api!(:get, "/colonies/#{@colony}/recipes/#{recipe['id']}") }
      r = shown["residue"] || {}
      { rewrite: Array(r["rewrite"]), grep: Array(r["grep"]), examined: r["examined"] }
    end

    # Stock git on the same base, rename and edits (scripts/scene_git.rb).
    def git_comparison
      branches = edits.map { |e| ["agent-#{e['agent']}", e["files"].to_h { |f| [f["path"], f["after"]] }] }
      t = Stage.now
      out = SceneGit.compare(base: @data["files"], rename: @data["renamed"], branches: branches, from: from)
      @clock.say("stock git merged each agent's edit into the rename on its own: #{out.line(from)} (#{fmt(Stage.now - t)})")
      out
    rescue SceneGit::Error => e
      raise Scene::Failure, "the git comparison could not run: #{e.message}"
    end

    def verdict(settled, recipe, named, residue, git, secs)
      n = edits.size
      landed = settled.count { |_, p| p["status"] == "landed" }
      back = settled.count { |_, p| p["status"] == "returned" }
      other = settled.size - landed - back
      batches = Array(recipe["batches"])
      agent_commits = settled.map { |_, p| p["landingId"] }.compact.uniq.size
      left = residue[:rewrite] | residue[:grep]
      held_files = edits.sum { |e| e["files"].size }
      @clock.print
      row = ->(label, value) { @clock.print("#{"#{label}:".ljust(33)}#{value}") }
      row.call("files the recipe rewrote", "#{Scene.n(recipe['changed'])} of #{Scene.n(recipe['examined'])} in src/**")
      row.call("commits", "#{batches.size} by the recipe (at most 100 files read each), #{agent_commits} for the agents' changes")
      row.call("agent changes landed", "#{landed} of #{n}")
      row.call("agent changes that came back", "#{back}#{other.positive? ? " (and #{other} waiting for a person or rejected)" : ''}")
      row.call("landings carrying the new name", "#{named[:named]} of #{landed} (#{named[:files]} of #{held_files} files landed as their agent wrote them, with #{to} for #{from})")
      row.call("trunk files naming #{from}", "#{left.size}#{left.empty? ? '' : " (#{left.first(5).join(', ')})"} (the recipe's residue: #{residue[:rewrite].size} to rewrite, #{residue[:grep].size} by grep)")
      row.call("stock git, same base and edits", git.line(from))
      row.call("the run took", fmt(secs))
      @clock.print
      problems = []
      problems << "#{n - landed} agent change#{n - landed == 1 ? '' : 's'} did not land" unless landed == n
      problems << "#{back} change#{back == 1 ? '' : 's'} came back" unless back.zero?
      problems << "#{landed - named[:named]} landed change#{landed - named[:named] == 1 ? '' : 's'} did not carry the new name as the recipe writes it" unless named[:named] == landed
      problems << "trunk still names #{from} in #{Scene.count(left.size, 'file')}" unless left.empty?
      raise Scene::Failure, problems.join("; ") unless problems.empty?

      @clock.say("PASS a rename across #{Scene.n(recipe['changed'])} files landed while #{n} agents held edits: all #{landed} of their changes landed with #{to}, none came back, and trunk names #{from} nowhere (#{git.line(from)})")
      Stage::EXIT_PASS
    end
  end

  # Parse the command line and run the scene; returns the exit code.
  def self.main(argv)
    opts = { keep: false, name: nil, record: false, record_out: nil, step_timeout: 90.0, base: nil, recording: RECORDING }
    env = Scene.setup(argv, "scene_rename", opts)
    data = Scene.data
    Run.new(**env, data: data, keep: opts[:keep], name: opts[:name], record: opts[:record], record_out: opts[:record_out], step_timeout: opts[:step_timeout]).call
  rescue Stage::ConfigError, OptionParser::ParseError => e
    warn("scene_rename: #{e.message}")
    Stage::EXIT_USAGE
  rescue Scene::Failure => e
    warn("scene_rename: #{e.message}")
    Stage::EXIT_FAIL
  end
end

exit(SceneRename.main(ARGV)) if $PROGRAM_NAME == __FILE__
