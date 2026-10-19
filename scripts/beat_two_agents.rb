#!/usr/bin/env ruby
# frozen_string_literal: true

# The live beat "two agents edit one file; text merge lands both", start to finish, on a colony it creates:
#
#   1. a fresh colony named beat-<time>, with review off, so the trunk writer alone decides and no model is asked
#   2. a seed agent lands src/values.ts, twelve lines, as an inline change
#   3. agents A and B each hold an intent on that file and take work from the same trunk
#   4. A changes line 2 and lands; B, still on the trunk before A's landing, changes line 11 and lands as a line-by-line
#      merge (text merge, FT_TEXT_MERGE)
#   5. it prints both landings, the merged file's lines, and the lineage `ft why` reads for each edited line, then
#      deletes the colony (--keep leaves it)
#
# With --conflict both agents change line 6: A lands, and B goes back with a reason naming the conflicting hunk. With
# --same both make the same change to line 6 from the same trunk (FT_ALREADY_ON_TRUNK): A lands, and B, which read the
# file before A landed, goes back stale (its edit may be its own to make, as two increments of one counter both writing
# the same value are); B redoes it on trunk as A left it, finds the edit there, and its redo lands no commit and is not
# sent back: it closes as already on trunk, naming A's landing, and B's intent closes with the cause already_on_trunk.
# With --dup both append the same function at the end of the file from the same trunk, and B a second function after
# it (FT_TEXT_MERGE and FT_MERGE_INSERTIONS): A lands, B goes back stale instead of being merged with A's function once
# (it read the file before A landed), and B's redo on trunk as A left it appends only its second function and lands:
# the shared function once, then B's second function, never the shared one twice.
#
# Every agent is this script over the HTTP API with inline changes (synthetic agents): no git, no model calls. Each step
# has a hard time limit; a step that runs out says what it was waiting for, and the script exits 3.
#
# Usage:
#   FT_TOKEN=<admin token> ruby scripts/beat_two_agents.rb --base https://staging.firetrident.com
#     [--conflict | --same | --dup] [--keep] [--name NAME] [--colony ID] [--review] [--step-timeout 90]
#
# --name names the new colony (default beat-<time>): with --keep, a name the deployment lists in FT_PUBLIC_GIT and
# FT_PUBLIC_MCP leaves a public colony with three landings for scripts/judge_path.rb. --colony runs the beat on an
# existing colony instead, on a new file beat/<time>/values.ts; that colony is never
# deleted and its review policy is left as it is (so review may ask a model). --review keeps review on in the new colony.
# Behind Cloudflare Access, set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET; they go with every request. FT_TOKEN
# comes from the environment, else from ~/.config/firetrident/env when that file's FT_URL is this deployment. Never
# prints a token. Exit codes: 0 the beat showed what it should, 1 it did not, 2 a setting is missing, 3 a step timed out.
require "optparse"
require_relative "stage"

module BeatTwoAgents
  # The file's length and the edits: lines 2 and 11 (far apart, as the round-5 text-merge check edited them), or both on
  # line 6 for --conflict, or the same edit of line 6 twice for --same, or appends for --dup (APPENDS).
  LINES = 12
  EDITS = {
    merge: [[2, "export const v2 = 20;"], [11, "export const v11 = 110;"]],
    conflict: [[6, "export const v6 = 60;"], [6, "export const v6 = 66;"]],
    same: [[6, "export const v6 = 60;"], [6, "export const v6 = 60;"]],
    dup: [[nil, "total"], [nil, "total and largest"]]
  }.freeze
  # --dup: the function both agents append (A alone, B with a second one after it), as whole texts appended to the seed.
  SHARED_FN = "\nexport function total(values: number[]): number {\n  return values.reduce((sum, v) => sum + v, 0);\n}\n"
  SECOND_FN = "\nexport function largest(values: number[]): number {\n  return Math.max(...values);\n}\n"
  APPENDS = { "total" => SHARED_FN, "total and largest" => SHARED_FN + SECOND_FN }.freeze
  # Proposal statuses the beat stops waiting at (escalated: waiting for a person, which this beat does not do;
  # already_on_trunk: FT_ALREADY_ON_TRUNK, nothing landed and nothing came back).
  SETTLED = %w[landed returned rejected escalated already_on_trunk].freeze
  BY = ENV.fetch("FT_USER", "stage-beat")

  # The beat could not show what it should; the message says what happened.
  class Failure < StandardError; end

  def self.seed_text = (1..LINES).map { |i| "export const v#{i} = #{i};\n" }.join

  # `text` with line `n` (1-based) replaced by `line`.
  def self.edit(text, n, line)
    lines = text.lines
    lines[n - 1] = "#{line}\n"
    lines.join
  end

  def self.short(sha) = sha.to_s[0, 7]

  # "Set v2 to 20 in src/values.ts" for the line "export const v2 = 20;"; "Append total() to src/values.ts" for an append.
  def self.title_for(line, path)
    return "Append #{line.split(' and ').map { |f| "#{f}()" }.join(' and ')} to #{path}" if APPENDS.key?(line)

    name, value = line.match(/const (\w+) = (\d+);/)&.captures
    name ? "Set #{name} to #{value} in #{path}" : "Change #{path}"
  end

  # The file after an agent's edit: line `n` replaced, or (--dup) the edit's functions appended.
  def self.edited(text, n, line) = APPENDS.key?(line) ? text + APPENDS.fetch(line) : edit(text, n, line)

  # The 1-based line of the file `text` where `fn`'s signature is.
  def self.line_of(text, fn) = text.lines.index { |l| l.start_with?("export function #{fn}(") }&.+(1)

  # One run of the beat against one deployment.
  class Run
    def initialize(http:, clock:, secrets:, conflict:, keep:, colony:, review:, step_timeout:, name: nil, same: false, dup: false)
      @http = http
      @clock = clock
      @secrets = secrets
      @conflict = conflict
      @same = same
      @mode = dup ? :dup : same ? :same : conflict ? :conflict : :merge
      @keep = keep
      @existing = colony
      @review = review
      @step_timeout = step_timeout.to_f
      @tag = "beat-#{Time.now.utc.strftime('%m%d-%H%M%S')}"
      @name = name || @tag
      @path = colony ? "beat/#{@tag}/values.ts" : "src/values.ts"
      @deadline = Stage.now + @step_timeout
      @waiting = "the deployment"
    end

    # Run every step, then clean up. Returns the exit code.
    def call
      preflight
      create_colony
      seed
      take_both
      first = land_first
      second = propose_second
      { merge: -> { merge_verdict(first, second) }, conflict: -> { conflict_verdict(first, second) }, same: -> { same_verdict(first, second) },
        dup: -> { dup_verdict(first, second) } }.fetch(@mode).call
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
      what = { merge: "two agents edit one file; text merge lands both", conflict: "two agents change the same line of one file",
               same: "two agents make the same change to one file; the second goes back, and its redo is already on trunk",
               dup: "two agents append the same function to one file; it lands once" }.fetch(@mode)
      @clock.say("beat: #{what}, on #{@http.base}#{about&.dig('commit') ? " (build #{about['commit']})" : ''}")
      unless about
        @clock.say("/api/about did not answer (#{res.problem}); going on without the deployment's flags")
        return
      end
      @flags = Array(about["flags"])
      raise Failure, "inline changes are off on this deployment (FT_INLINE is not on in /api/about), and every agent here proposes inline" unless @flags.include?("FT_INLINE")
      return same_flags if @same
      raise Failure, "text merge is off on this deployment (FT_TEXT_MERGE is not on in /api/about), so this beat cannot show it" unless @flags.include?("FT_TEXT_MERGE")
      if @mode == :dup && !@flags.include?("FT_MERGE_INSERTIONS")
        raise Failure, "insertion merges are off on this deployment (FT_MERGE_INSERTIONS is not on in /api/about), so this beat cannot show them"
      end

      insertions = @mode == :dup ? ", insertion merges (FT_MERGE_INSERTIONS)" : ""
      @clock.say("text merge (FT_TEXT_MERGE)#{insertions} and inline changes (FT_INLINE) are on here")
    end

    # --same needs FT_ALREADY_ON_TRUNK; text merge may be on or off (B goes back stale either way, and its redo is
    # already on trunk either way).
    def same_flags
      raise Failure, "already on trunk is off on this deployment (FT_ALREADY_ON_TRUNK is not on in /api/about), so this beat cannot show it" unless @flags.include?("FT_ALREADY_ON_TRUNK")

      merge = @flags.include?("FT_TEXT_MERGE") ? "on" : "off"
      @clock.say("already on trunk (FT_ALREADY_ON_TRUNK) and inline changes (FT_INLINE) are on here; text merge is #{merge} (without the flag B's redo would land as a commit that changes nothing)")
    end

    def create_colony
      if @existing
        step("colony #{@existing} to answer") { api!(:get, "/colonies/#{@existing}") }
        @colony = @existing
        @clock.say("on colony #{@colony}, as it is (review as its policy says); the beat writes a new file, #{@path}")
        return
      end
      name = @name
      created, secs = step("the deployment to create colony #{name}") do
        res = api(:post, "/colonies", { name: name, pool: 3 })
        raise Failure, "colony #{name} already exists: pass another --name, or --colony #{name} to run the beat on it" if res.code == 409
        raise Failure, "creating colony #{name}: #{res.problem}" unless res.ok?

        res.json
      end
      @colony = created["id"]
      @created = true
      unless @review
        step("review to switch off on #{@colony}") { api!(:post, "/colonies/#{@colony}/decide/policy", { enabled: false }) }
      end
      off = @review ? "" : "; review is off, so the trunk writer alone decides and no model is asked"
      @clock.say("created colony #{@colony} (#{fmt(secs)})#{off}")
    end

    def seed
      @seed_text = BeatTwoAgents.seed_text
      took, secs = step("the seed agent to be handed its intent") do
        agent = register("beat-seed")
        intent = declare(agent, "Create #{@path}", "The file the two agents of the stage beat both edit.")
        [agent, take(agent, intent["id"], "the seed agent")]
      end
      landed, secs2 = step("the seed change to land") do
        settle(propose(took[0], took[1], nil, @seed_text, "create #{@path}"), "the seed agent")
      end
      raise Failure, "the seed change #{landed['id']} did not land: it is #{landed['status']}#{reason_of(landed)}" unless landed["status"] == "landed"

      @clock.say("seeded #{@path}, #{LINES} lines, in #{landed['landingId']} (#{fmt(secs + secs2)})")
    end

    def take_both
      (line_a, text_a), (line_b, text_b) = EDITS.fetch(@mode)
      @edit_a = [line_a, text_a]
      @edit_b = [line_b, text_b]
      _, secs = step("agents A and B to be handed their intents") do
        @agent_a = register("beat-agent-a")
        @agent_b = register("beat-agent-b")
        how = { merge: ", on different lines", conflict: ", on the same line", same: ", the same way", dup: ", both appending the same function" }.fetch(@mode)
        why = "Stage beat: agents A and B change #{@path} from the same trunk#{how}."
        @intent_a = declare(@agent_a, BeatTwoAgents.title_for(text_a, @path), why)
        @intent_b = declare(@agent_b, "#{BeatTwoAgents.title_for(text_b, @path)}#{{ merge: '', conflict: ' (the other way)', same: ' (the same edit)', dup: '' }.fetch(@mode)}", why)
        @took_a = take(@agent_a, @intent_a["id"], "agent A")
        @took_b = take(@agent_b, @intent_b["id"], "agent B")
      end
      base_a = @took_a.dig("lease", "baseSha")
      base_b = @took_b.dig("lease", "baseSha")
      raise Failure, "agents A and B took work on different trunks (#{short(base_a)} and #{short(base_b)}), so this is not the beat" unless base_a == base_b

      @base = base_a
      @clock.say("agents A (#{@agent_a}) and B (#{@agent_b}) each hold an intent on #{@path} and took work from the same trunk, #{short(@base)} (#{fmt(secs)})")
    end

    def land_first
      line, text = @edit_a
      @text_a = BeatTwoAgents.edited(@seed_text, line, text)
      p, secs = step("agent A's change to land") { settle(propose(@agent_a, @took_a, @seed_text, @text_a, summary(line, text)), "agent A") }
      raise Failure, "agent A's change #{p['id']} did not land: it is #{p['status']}#{reason_of(p)}" unless p["status"] == "landed"

      @clock.say("agent A #{did(line, text)}: landed in #{p['landingId']} (#{fmt(secs)})")
      p
    end

    def propose_second
      line, text = @edit_b
      @text_b = BeatTwoAgents.edited(@seed_text, line, text)
      p, secs = step("agent B's change to land or go back") { settle(propose(@agent_b, @took_b, @seed_text, @text_b, summary(line, text)), "agent B") }
      what = { "landed" => "landed in #{p['landingId']}", "returned" => "went back", "already_on_trunk" => "closed as already on trunk" }.fetch(p["status"], p["status"])
      @clock.say("agent B #{did(line, text)} on #{short(@base)}, the trunk before A landed: #{what} (#{fmt(secs)})")
      p
    end

    # B's redo after its change went back: it takes its intent again, on trunk as A's landing left it, reads the file
    # there (A's version) and writes `text` (the full file as B wants it now).
    def redo_second(text, what_it_does)
      took, secs = step("agent B to be handed its intent again") { take(@agent_b, @intent_b["id"], "agent B") }
      @took_b = took
      p, secs2 = step("agent B's redo to settle") { settle(propose(@agent_b, @took_b, @text_a, text, "#{what_it_does} (redo)"), "agent B") }
      what = { "landed" => "landed in #{p['landingId']}", "returned" => "went back", "already_on_trunk" => "closed as already on trunk" }.fetch(p["status"], p["status"])
      @clock.say("agent B redid it: took its intent again on #{short(took.dig('lease', 'baseSha'))}, read agent A's version and #{what_it_does}: #{what} (#{fmt(secs + secs2)})")
      p
    end

    # What an agent did, as the narration says it: "changed line 6", "appended total()".
    def did(line, text)
      return "appended #{text.split(' and ').map { |f| "#{f}()" }.join(' and ')}" if APPENDS.key?(text)

      "changed line #{line}"
    end

    # The proposal's summary: "line 6: export const v6 = 60;", or what an append added.
    def summary(line, text) = APPENDS.key?(text) ? did(line, text) : "line #{line}: #{text}"

    # B landed, its landing records the merge, the merge is the text with both edits, and `why` names each line's writer.
    def merge_verdict(first, second)
      raise Failure, "agent B's change went back (#{second['status']}#{reason_of(second)}) instead of landing as a merge" unless second["status"] == "landed"

      both = BeatTwoAgents.edit(@text_a, @edit_b[0], @edit_b[1])
      lineage = [[@edit_a[0], first], [@edit_b[0], second]].map { |line, p| [line, p, why(line)] }
      merged_entry = lineage.last[2].first
      note_b = note_of(merged_entry, second["id"])
      merged = Array(note_b&.dig("merged")).find { |m| m["path"] == @path }
      problems = []
      recorded = merged || Array(merged_entry&.dig("landing", "merged")).any? { |m| m["proposalId"] == second["id"] && m["path"] == @path }
      problems << "neither the landing of agent B's change nor its lineage note records a text merge of #{@path}" unless recorded
      problems << "the merge landed blob #{short(merged&.dig('result'))}, not the text with both edits (#{short(Stage.blob_id(both))})" if merged && merged["result"] != Stage.blob_id(both)
      lineage.each do |line, p, entries|
        owner = entries.first&.dig("landing", "id")
        problems << "ft why for line #{line} names #{owner || 'no landing'} first, not #{p['landingId']}" unless owner == p["landingId"]
      end

      landings_table([["agent A", first, @intent_a, "line #{@edit_a[0]}"], ["agent B", second, @intent_b, "line #{@edit_b[0]}, merged line by line onto #{first['landingId']}"]], lineage)
      file_lines(both, "after both landings (blob #{short(Stage.blob_id(both))}, the text with both edits)", { @edit_a[0] => "agent A, #{first['landingId']}", @edit_b[0] => "agent B, #{second['landingId']}" })
      lineage_lines(lineage, merged)
      raise Failure, problems.join("; ") unless problems.empty?

      @clock.say("PASS both changes landed; agent B's as a line-by-line merge that holds both edits")
      Stage::EXIT_PASS
    end

    # A landed and B went back, its reason (or its recorded conflict) naming the hunk on the line both changed.
    def conflict_verdict(first, second)
      line = @edit_b[0]
      lineage = [[line, first, why(line)]]
      landings_table([["agent A", first, @intent_a, "line #{line}"]], lineage)
      file_lines(@text_a, "after agent A's landing (blob #{short(Stage.blob_id(@text_a))})", { line => "agent A, #{first['landingId']}" })
      lineage_lines(lineage, nil)
      raise Failure, "agent B's change #{second['status']} instead of going back (#{reason_of(second).sub(/\A: /, '')})" unless second["status"] == "returned"

      recorded = Array(second["mergeConflicts"]).any? { |c| c["path"] == @path && Array(c["lines"]).include?(line) }
      named = second["reason"].to_s.match?(/conflicting hunk/) && second["reason"].to_s.match?(/\bline #{line}\b/)
      @clock.print("agent B's change #{second['id']} (line #{line}: #{@edit_b[1]}) went back: #{second['reason']}")
      if @flags&.include?("FT_RESOLVER")
        @clock.print("(the conflict resolver, FT_RESOLVER, is on here: it may now try one model merge of B's change; this beat does not wait for it)")
      end
      raise Failure, "agent B's change went back, but its reason does not name the conflicting hunk at line #{line}" unless recorded || named

      @clock.say("PASS one landing and one return naming the conflicting hunk at line #{line}")
      Stage::EXIT_PASS
    end

    # B read the file before A landed, so its identical change went back stale: its edit may be its own to make. Its redo,
    # on trunk as A left it, landed nothing and did not go back: it closed as already on trunk naming A's landing, trunk
    # did not move for it, and B's intent closed with the cause already_on_trunk.
    def same_verdict(first, second)
      line = @edit_b[0]
      lineage = [[line, first, why(line)]]
      landings_table([["agent A", first, @intent_a, "line #{line}"]], lineage)
      file_lines(@text_a, "after agent A's landing (blob #{short(Stage.blob_id(@text_a))}); agent B wrote the same text", { line => "agent A, #{first['landingId']}" })
      lineage_lines(lineage, nil)
      stale_back(second, "it read #{@path} before agent A's landing, so its edit may be its own to make")
      @clock.print("agent B's change #{second['id']} (line #{line}: #{@edit_b[1]}) went back: #{second['reason']}")
      again = redo_second(@text_b, "made the same change")
      unless again["status"] == "already_on_trunk"
        how = again["status"] == "landed" ? "landed in #{again['landingId']} (a commit that changes nothing)" : again["status"]
        raise Failure, "agent B's redo #{how} instead of closing as already on trunk#{reason_of(again)}; is FT_ALREADY_ON_TRUNK on for colony #{@colony}?"
      end

      @clock.print("agent B's redo #{again['id']} (line #{line}: #{@edit_b[1]}) closed as already on trunk: #{again['reason']}")
      problems = []
      from = again["onTrunk"] || {}
      problems << "its source names #{from['landingId'] || "trunk #{short(from['trunkSha'])}"}, not agent A's landing #{first['landingId']}" unless from["landingId"] == first["landingId"]
      problems << "it carries a landing (#{again['landingId']})" if again["landingId"]
      owner = lineage.first[2].first&.dig("landing", "id")
      problems << "ft why for line #{line} names #{owner || 'no landing'} first, not agent A's #{first['landingId']}" unless owner == first["landingId"]
      intent, = step("agent B's intent to show its closure") { api!(:get, "/colonies/#{@colony}/intents/#{@intent_b['id']}") }
      closure = intent.dig("intent", "closure") || {}
      @clock.print("agent B's intent #{@intent_b['id']}: #{intent.dig('intent', 'status')}, closure #{closure['cause'] || 'none'}#{closure.dig('onTrunk', 'landingId') ? " from #{closure.dig('onTrunk', 'landingId')}" : ''}")
      problems << "agent B's intent is #{intent.dig('intent', 'status')}, not landed" unless intent.dig("intent", "status") == "landed"
      problems << "agent B's intent closed with #{closure['cause'].inspect}, not already_on_trunk" unless closure["cause"] == "already_on_trunk"
      raise Failure, problems.join("; ") unless problems.empty?

      @clock.say("PASS one landing; agent B's identical change went back stale, and its redo closed as already on trunk from #{first['landingId']}, with no commit")
      Stage::EXIT_PASS
    end

    # B's first change must have gone back stale (`why` says why it should have); anything else fails the beat.
    def stale_back(second, why)
      return if second["status"] == "returned" && second["reason"].to_s.start_with?("stale")

      how = { "landed" => "landed in #{second['landingId']}", "already_on_trunk" => "closed as already on trunk", "returned" => "went back" }.fetch(second["status"], second["status"])
      raise Failure, "agent B's change #{how}#{reason_of(second)} instead of going back stale: #{why}"
    end

    # --dup: B's append, which repeats A's function, went back stale instead of being merged with it once (B read the file
    # before A landed); B's redo on trunk as A left it landed the file with the shared function once, then B's second
    # function; `why` names A for the shared function and B's redo for the second one.
    def dup_verdict(first, second)
      stale_back(second, "it read #{@path} before agent A's landing and repeats agent A's total(), which a merge would land once")
      @clock.print("agent B's change #{second['id']} (appended total() and largest()) went back: #{second['reason']}")
      once = @seed_text + SHARED_FN + SECOND_FN
      again = redo_second(once, "appended largest() after it")
      raise Failure, "agent B's redo went back (#{again['status']}#{reason_of(again)}) instead of landing" unless again["status"] == "landed"

      shared_at = BeatTwoAgents.line_of(once, "total")
      second_at = BeatTwoAgents.line_of(once, "largest")
      lineage = [[shared_at, first], [second_at, again]].map { |line, p| [line, p, why(line)] }
      wrote = Array(note_of(lineage.last[2].first, again["id"])&.dig("writeSet")).find { |w| w["path"] == @path }
      problems = []
      problems << "agent B's redo landed blob #{short(wrote&.dig('blob'))}, not the file with the shared function once and the second after it (#{short(Stage.blob_id(once))})" unless wrote&.dig("blob") == Stage.blob_id(once)
      lineage.each do |line, p, entries|
        owner = entries.first&.dig("landing", "id")
        problems << "ft why for line #{line} names #{owner || 'no landing'} first, not #{p['landingId']}" unless owner == p["landingId"]
      end

      landings_table([["agent A", first, @intent_a, "appended total()"], ["agent B", again, @intent_b, "appended largest() after it, on trunk as #{first['landingId']} left it"]], lineage)
      file_lines(once, "after both landings (blob #{short(Stage.blob_id(once))}: total() once, then largest())", { shared_at => "agent A, #{first['landingId']}", second_at => "agent B, #{again['landingId']}" })
      lineage_lines(lineage, nil)
      raise Failure, problems.join("; ") unless problems.empty?

      @clock.say("PASS agent B's repeat of the shared function went back stale, and its redo landed the second function after it: the shared function once")
      Stage::EXIT_PASS
    end

    def cleanup
      return unless @colony
      return @clock.say("left colony #{@colony} as it was: #{@http.base}/c/#{@colony}") unless @created
      return @clock.say("kept colony #{@colony}: #{@http.base}/c/#{@colony}") if @keep

      res = @http.request(:delete, "/api/colonies/#{@colony}", timeout: 600)
      @clock.say(res.ok? ? "deleted colony #{@colony}" : "could not delete colony #{@colony} (#{res.problem}): delete it with ft delete #{@colony}")
    end

    # --- output -------------------------------------------------------------------------------------------------------

    def landings_table(rows, lineage)
      @clock.print
      @clock.print("landings")
      rows.each do |who, p, intent, what|
        landing = lineage.flat_map { |_, _, entries| entries }.map { |e| e["landing"] || {} }.find { |l| l["id"] == p["landingId"] } || {}
        @clock.print(format("  %-20s trunk %-8s %-8s %-36s %s", p["landingId"], short(landing["trunkSha"]), who, "\"#{intent['title']}\"", what))
      end
    end

    def file_lines(text, label, marks)
      @clock.print
      @clock.print("#{@path} #{label}")
      text.lines.each_with_index do |l, i|
        line = format("  %3d  %s", i + 1, l.chomp)
        @clock.print(marks[i + 1] ? format("%-36s<- %s", line, marks[i + 1]) : line)
      end
    end

    def lineage_lines(lineage, merged)
      @clock.print
      @clock.print("lineage, as ft why reads it")
      lineage.each do |line, p, entries|
        @clock.print("  $ ft why #{@colony} #{@path}:#{line}")
        entry = entries.first
        unless entry
          @clock.print("    no landing (the why route answered none)")
          next
        end
        prop = note_of(entry, p["id"]) || Array(entry.dig("note", "proposals")).first || {}
        landing = entry["landing"] || {}
        @clock.print("    landing  #{landing['id']}  #{short(landing['trunkSha'])} <- #{short(landing['parentSha'])}")
        @clock.print("    proposal #{prop['id']} by #{prop['agentId']} (#{prop['agentKind']}#{prop['model'] ? " / #{prop['model']}" : ''})")
        @clock.print("    intent   #{prop.dig('intent', 'id')} \"#{prop.dig('intent', 'title')}\"")
        m = Array(prop["merged"]).find { |x| x["path"] == @path }
        next unless m && merged

        @clock.print("    merged   line by line: base #{short(m['base'])}, trunk #{short(m['trunk'])}, its own #{short(m['theirs'])} -> #{short(m['result'])}")
      end
      @clock.print
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

    def declare(agent, title, why)
      res = api(:post, "/colonies/#{@colony}/intents", { title: title, why: why, footprint: [@path], assignedTo: agent, createdBy: BY, force: true })
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

    # Propose `text` for the beat's file as an inline change on the lease's base (`base_text`: the file there, or nil).
    def propose(agent, took, base_text, text, summary)
      write = [{ path: @path, blob: Stage.blob_id(text) }]
      base = took.dig("lease", "baseSha")
      body = {
        intentId: took.dig("intent", "id"), agentId: agent, workspace: took.dig("lease", "repo"), baseSha: base,
        headSha: Stage.changeset_id(base, write), writeSet: write,
        readSet: base_text ? [{ path: @path, blob: Stage.blob_id(base_text) }] : [],
        contents: { write[0][:blob] => text }, intentRevision: took.dig("intent", "revision") || 1,
        declared: { footprint: [@path], summary: summary },
        evidence: { checks: [], notVerified: "A scripted stage beat: no tests were run." }
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

    # The lineage of one line of the beat's file (GET /why?path=&line=): its writer's landing first.
    def why(line)
      answer, = step("the lineage of #{@path}:#{line}") { api!(:get, "/colonies/#{@colony}/why?path=#{URI.encode_www_form_component(@path)}&line=#{line}") }
      Array(answer)
    rescue Failure => e
      @clock.say("ft why #{@path}:#{line} did not answer: #{e.message}")
      []
    end

    def note_of(entry, proposal_id) = Array(entry&.dig("note", "proposals")).find { |p| p["id"] == proposal_id }

    def reason_of(p) = p["reason"] ? ": #{p['reason']}" : ""

    def short(sha) = BeatTwoAgents.short(sha)

    def fmt(secs) = format("%.1f s", secs)
  end

  # Parse the command line and run the beat; returns the exit code.
  def self.main(argv)
    opts = { conflict: false, same: false, dup: false, keep: false, colony: nil, name: nil, review: false, step_timeout: 90.0, base: nil }
    OptionParser.new do |o|
      o.banner = "Usage: FT_TOKEN=... ruby scripts/beat_two_agents.rb --base <url> [options]"
      o.on("--base URL", "The deployment, e.g. https://staging.firetrident.com") { |v| opts[:base] = v }
      o.on("--conflict", "Both agents change the same line: one lands, one goes back naming the hunk") { opts[:conflict] = true }
      o.on("--same", "Both agents make the same change (FT_ALREADY_ON_TRUNK): one lands, the other goes back and its redo closes as already on trunk") { opts[:same] = true }
      o.on("--dup", "Both agents append the same function, B a second after it (FT_MERGE_INSERTIONS): B goes back, its redo lands; the function lands once") { opts[:dup] = true }
      o.on("--keep", "Keep the colony the beat creates (default: delete it at the end)") { opts[:keep] = true }
      o.on("--name NAME", "Name of the new colony (default beat-<time>)") { |v| opts[:name] = v }
      o.on("--colony ID", "Run on this existing colony instead (never deleted; its review policy is left as it is)") { |v| opts[:colony] = v }
      o.on("--review", "Leave review on in the new colony (it may then ask a model)") { opts[:review] = true }
      o.on("--step-timeout S", Float, "Hard time limit of each step, in seconds (default 90)") { |v| opts[:step_timeout] = v }
    end.parse!(argv)
    base = Stage.base_url(opts[:base])
    token = Stage.token(base)
    raise Stage::ConfigError, "pass --name or --colony, not both" if opts[:name] && opts[:colony]
    raise Stage::ConfigError, "pass --conflict or --same, not both" if opts[:conflict] && opts[:same]
    raise Stage::ConfigError, "pass --dup alone, not with --conflict or --same" if opts[:dup] && (opts[:conflict] || opts[:same])
    raise Stage::ConfigError, "FT_TOKEN is not set (the deployment's admin token: set it, or put it in ~/.config/firetrident/env with that deployment's FT_URL)" unless token

    access = Stage.access_headers
    secrets = [token, *access.values]
    clock = Stage::Clock.new(secrets: secrets)
    http = Stage::Http.new(base, token: token, access: access)
    Run.new(http: http, clock: clock, secrets: secrets, conflict: opts[:conflict], keep: opts[:keep], colony: opts[:colony],
            review: opts[:review], step_timeout: opts[:step_timeout], name: opts[:name], same: opts[:same], dup: opts[:dup]).call
  rescue Stage::ConfigError, OptionParser::ParseError => e
    warn("beat_two_agents: #{e.message}")
    Stage::EXIT_USAGE
  end
end

exit(BeatTwoAgents.main(ARGV)) if $PROGRAM_NAME == __FILE__
