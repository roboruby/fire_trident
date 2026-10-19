#!/usr/bin/env ruby
# frozen_string_literal: true

# The Hono replay: real-model agents in the platform redo a stretch of honojs/hono's own pull request history, from a
# base commit B, with the same model mix as the contention smoke test (scripts/contention.rb) and a scripted person
# answering what waits for one; graded afterwards by Hono's own tests under real vitest. The workload is
# demo/hono-replay/workload.json (scripts/hono_replay_select.rb): B, the pull requests merged after it that overlap on
# source files, each with its hidden test files (its test files as the selected pull requests laid on B in merge order
# leave them right after it), the vitest targets that run them, and its own tests (the ones that fail right before it
# and pass right after it). For each run, on a throwaway colony:
#
#   1. create colony <name>-<agents> at region depth 3 (--region-depth) with review off, and land the seed: B's tree
#      from a local clone, but for the paths the workload leaves out (runtime tests, benchmarks, binary images) and files
#      the inline path cannot carry, as inline changes of at most 64 files and 500 KB each (core INLINE_LIMITS), one
#      scripted seed agent per change, all proposed at once
#   2. wait for certification of the seed's commit (green is the baseline; red or an error stops the run unless
#      --red-baseline; skipped means trunk certification had nothing it could run, and red episodes are not measured)
#   3. switch review on, set the colony's spend cap, and declare one intent per pull request (source human, equal
#      priority): its title, its description as the why (cleaned at selection), its footprint (the files it changed
#      under src/), no acceptance lines
#   4. release N agents with the contention run's model mix and follow as scripts/contention.rb follows (stop on every
#      intent landed and trunk green, a stall, the timeout or the spend stop), while the scripted person answers the
#      queue every --person-every seconds (below)
#   5. stop the agents, let what is in flight settle, read the colony's record and compute the report
#      (scripts/contention_report.rb, the same numbers as the contention runs)
#   6. grade with real vitest, never with the colony's own certification: clone the final trunk with stock git (the
#      deployment's public git when FT_PUBLIC_GIT names the colony, sent with the Access headers; else a read lease a
#      scripted grader takes with the admin token), lay what the run changed since the seed over B in a scratch
#      worktree of the local clone, and for each intent copy its hidden test files in and run its vitest targets there
#      (B's node_modules): pass when every one of its own tests passes (whether every test in its hidden files passed
#      is kept too). The worktree's visible suite is run once as well.
#   7. delete the colony (--keep leaves it, with its agents stopped)
#
# The scripted person (ScriptedPerson below; its rule is written there and in the results' README). Every
# --person-every seconds (30), for each change waiting in the review queue for at least --person-wait seconds (120)
# whose intent is one of the run's or a repair of trunk: it asks the platform to run the colony's tests on the change
# again (POST /api/colonies/:id/proposals/:pid/tests), then approves with "scripted person: the visible tests pass"
# when they pass, returns it naming the failing tests when any fails that does not fail on its base too, and approves
# when every failing test fails on its base as well. When tests cannot run for it (certification off or not able to
# run them, no test ran, the run did not report within --person-retest seconds) it approves when every file the
# change writes is in its intent's footprint, and returns it naming the files outside otherwise. A change it already
# approved --person-max-approvals times (a held merge comes back when trunk moves) is returned to be redone on the
# current trunk. An agent's report waiting as long is dismissed with a note to do the intent as written. Every
# decision is counted and kept in the results.
#
# --sweep 8,16 runs each count on its own fresh colony; --solo adds one with one agent. The results go to
# packages/bench/results/<date>-hono-replay/ (README.md labeled MEASURED, hono-replay.json, run-<label>.json, run.log),
# every file through the bench evidence redaction (packages/bench/src/evidence.ts).
#
# Usage:
#   FT_TOKEN=<admin token> ruby scripts/hono_replay.rb --base https://staging.firetrident.com --clone <hono clone>
#     --modules <node_modules> [--sweep 8,16 --solo | --agents 8] [--name hono-replay] [--workload FILE]
#     [--region-depth 3] [--max-usd 15] [--timeout 2400] [--settle 600] [--stall 900] [--stall-report 300] [--poll 5] [--step-timeout 180]
#     [--seed-timeout 900] [--baseline-timeout 1800] [--red-baseline] [--person-wait 120] [--person-every 30]
#     [--person-retest 600] [--person-max-approvals 3] [--no-person] [--no-grade] [--keep] [--out DIR] [--note TEXT]
#   ruby scripts/hono_replay.rb --plan [--sweep 8,16 --solo] [--clone DIR]   the plan and the cost ESTIMATE; sends nothing
#   ruby scripts/hono_replay.rb --dry-run [--out DIR]   the whole harness against recorded fixtures (scripts/test/fake_hono.rb)
#   ruby scripts/hono_replay.rb --check-grade --clone DIR --modules DIR   the grader on B (no intent passes) and on the
#     target (every intent passes) with real vitest; sends nothing
#
# --clone is a local clone of honojs/hono holding B and the pull requests' commits; --modules a node_modules installed
# in a Hono checkout at B (npm install --ignore-scripts), linked into the grading worktree (--grade-worktree, default
# <clone>/../hono-replay-grade). Behind Cloudflare Access, set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET. FT_TOKEN
# comes from the environment, else from ~/.config/firetrident/env when that file's FT_URL is this deployment. Never
# prints a token. Exit codes as scripts/contention.rb: 0 every run landed every intent and the results were written,
# 1 a run did not, 2 a setting is missing, 3 a step timed out before a run could report.
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
require_relative "contention"
require_relative "contention_report"
require_relative "hono_tree"

module HonoReplay
  ROOT = File.expand_path("..", __dir__)
  WORKLOAD = File.join(ROOT, "demo", "hono-replay", "workload.json")
  BY = ENV.fetch("FT_USER", "hono-replay")
  PERSON = "scripted person"
  # The 2026-10-17 contention runs' mix and solo model (scripts/contention.rb).
  DEFAULT_MODEL = Contention::DEFAULT_MODEL
  SOLO_MODEL = Contention::SOLO_MODEL
  # core INLINE_LIMITS (64 files, 256 KiB a file, 512 KiB a change), the total kept under its limit.
  INLINE = { files: 64, file_bytes: 256 * 1024, total_bytes: 500 * 1024 }.freeze
  # The region depth each colony is created with. Every file of the workload lives under src/: at the default depth 1
  # the whole workload is one region, `src`, and admission (each region admits while its working agents are fewer than
  # max(3, 2 x its landings in the last minute)) holds a run at about three working agents whatever its agent count. At
  # depth 3 the footprints spread over src, src/utils, src/client and src/router/trie-router, each with its own slots.
  REGION_DEPTH = 3
  # The priority every intent is declared with (as the contention spec's).
  PRIORITY = 3
  # How long a grading vitest run may take.
  VITEST_S = 900
  # The tests-before-landing path glob the colony holds while the seed lands: it matches no file.
  SEED_NO_PRELAND = "-seed-lands-without-tests-before-landing-/**"
  # Left out of each colony's trunk certification (CertifyPolicy.excludeTests), never out of the grade: the two tests in
  # Hono's suite at B that pass under Node and fail in workerd (a Request has no mode there; an abort's reason does not
  # cross the proxy), measured by the vitest shim's agreement check. Without them the seed's certification reads red.
  CERTIFY_EXCLUDE = ["src/helper/proxy/index.test.ts > Proxy Middleware > proxy > client disconnect",
                     "src/request.test.ts > cloneRawRequest > clones consumed request object"].freeze

  # A run could not do what it should; the message says what happened.
  Failure = Contention::Failure

  # --- the workload ---------------------------------------------------------------------------------------------------

  def self.load(path = WORKLOAD)
    raise Stage::ConfigError, "#{path.delete_prefix("#{ROOT}/")} is missing: write it with scripts/hono_replay_select.rb" unless File.file?(path)

    data = JSON.parse(File.read(path, encoding: "UTF-8"))
    raise Failure, "#{path} is not a Hono replay workload (schema #{data['schema'].inspect})" unless data["schema"] == "firetrident.hono-replay/v1"
    raise Failure, "#{path} lists no pull requests" if Array(data["prs"]).empty?

    data
  end

  # The selected pull requests laid on B in merge order as the selection laid them: each commit's message names its
  # pull request ("replay #<n>"), and with git's fixed identity and dates the commit ids are the workload's.
  def self.chain(repo, base, prs)
    numbers = prs.to_h { |pr| [pr["commit"], pr["number"]] }
    repo.replay(base, prs.map { |pr| pr["commit"] }, label: ->(sha) { "##{numbers.fetch(sha)}" })
  end

  # The git blob id of bytes as stored.
  def self.git_blob(bytes) = Digest::SHA1.hexdigest("blob #{bytes.bytesize}\0".b + bytes.b)

  # The intent id of a pull request in the report: its number.
  def self.intent_id(pr) = "##{pr['number']}"

  # What a pull request did, from its title's conventional prefix (fix, feat, perf, refactor ...).
  def self.change_of(pr) = pr["title"].to_s[/\A([a-z]+)(?:\([^)]*\))?!?:/, 1] || "change"

  # The intent's why in the layout in-platform agents read: the description, the scope, then the project's context.
  def self.why(workload, pr)
    n = workload["prs"].size
    base = workload["base"]
    desc = pr["why"].to_s.strip
    out = +(desc.empty? ? "The pull request this intent comes from gave no description beyond its title." : desc)
    out << "\n\nScope: this intent writes #{pr['footprint'].join(', ')}. It is one of #{n} intents a person declared on this project at the same time."
    out << "\n\nProject context: this is Hono (honojs/hono), a web framework built on Web Standards, at commit #{base['commit'][0, 12]} (#{base['date'].to_s[0, 10]}). " \
           "Its tests are vitest files next to the code (src/**/*.test.ts) that use vitest's globals (describe, it, expect, vi). " \
           "Keep every existing test passing, and add tests for what this intent changes."
    out
  end

  # POST /intents for one pull request: a person's intent at equal priority, never caught as a twin.
  def self.intent_body(workload, pr)
    { title: pr["title"], why: why(workload, pr), footprint: pr["footprint"], acceptance: Array(pr["acceptance"]),
      priority: PRIORITY, source: "human", createdBy: BY, force: true }
  end

  # The spec Contention::Run reads: name, intents (id, title, footprint, change), priority, no rules and no designed pairs.
  def self.spec(workload)
    shared = workload.dig("overlap", "by_file").to_h.sort_by { |f, ns| [-ns.size, f] }.first(3).map(&:first)
    { "name" => "hono-replay", "priority" => PRIORITY, "rules" => [], "pairs" => [], "shared" => shared.join(", "),
      "intents" => workload["prs"].map { |pr| { "id" => intent_id(pr), "title" => pr["title"], "footprint" => pr["footprint"], "change" => change_of(pr), "acceptance" => Array(pr["acceptance"]) } } }
  end

  # --- the seed -------------------------------------------------------------------------------------------------------

  # B's tree as [path, text] pairs in path order, and what was left out with why: the workload's excluded prefixes,
  # symlinks and submodules, binary files, and files over the inline limit.
  def self.seed_from(repo, workload)
    excluded = Array(workload.dig("seed", "exclude")).map { |e| e["prefix"] }
    files = []
    left = []
    repo.tree(workload.dig("base", "commit")).sort_by { |p, _| p.b }.each do |path, meta|
      why = if (pre = excluded.find { |x| path.start_with?(x) }) then "under #{pre}"
            elsif meta[:mode] != "100644" && meta[:mode] != "100755" then "not a regular file"
            elsif meta[:size] > INLINE[:file_bytes] then "over the #{INLINE[:file_bytes] / 1024} KiB inline limit"
            end
      if why.nil?
        bytes = repo.blob(meta[:blob])
        text = bytes.dup.force_encoding(Encoding::UTF_8)
        why = "binary" if bytes.include?("\0") || !text.valid_encoding?
        files << [path, text] unless why
      end
      left << { path: path, why: why } if why
    end
    [files, left]
  end

  # The seed in inline changes, in path order: at most INLINE[:files] files and INLINE[:total_bytes] bytes each.
  def self.chunks(files, limits = INLINE)
    out = []
    cur = []
    bytes = 0
    files.each do |path, text|
      size = text.bytesize
      if !cur.empty? && (cur.size >= limits[:files] || bytes + size > limits[:total_bytes])
        out << cur
        cur = []
        bytes = 0
      end
      cur << path
      bytes += size
    end
    out << cur unless cur.empty?
    out
  end

  # --- the scripted person --------------------------------------------------------------------------------------------

  # The scripted person's rule, as a pure function of what the review queue shows, what it remembers of the change, and
  # the time. ScriptedPerson.decide answers one change: :skip (not ours to answer), :wait, :retest (ask for a test run),
  # :approve or :return with the reason sent and the rule that chose it.
  module ScriptedPerson
    APPROVE = "scripted person: the visible tests pass"
    RULES = {
      "tests pass" => "the colony's tests ran on the change and every one passed: approve",
      "fail on trunk too" => "every failing test fails on the change's base as well: approve",
      "tests fail" => "a test fails on the change that does not fail on its base: return it naming the failing tests",
      "no tests, in scope" => "no test could run on it, and every file it writes is in its intent's footprint: approve",
      "no tests, out of scope" => "no test could run on it, and it writes files its intent does not name: return it naming them",
      "approved too often" => "approved the most times allowed and back again (trunk kept moving under it): return it to be redone on the current trunk",
      "report" => "an agent's report waited: dismiss it with a note to do the intent as written"
    }.freeze
    DISMISS = "scripted person: no answer beyond the intent as written. Do what its why says within its footprint, keep every existing test passing, and propose."

    module_function

    # `item`: a review queue entry (GET /review); `memo`: what the person remembers of it ({ first_seen:, asked:,
    # asked_at:, no_tests:, approvals: }); `now`: seconds; `footprint`: its intent's paths, or nil when the intent is
    # not one the person answers; `opts`: :wait, :retest_s, :max_approvals.
    def decide(item, memo, now, footprint:, opts:)
      return skip("an audit item, not a change waiting") if item["audit"]
      return skip("not waiting for a person (#{item['status']})") unless item["status"] == "escalated"
      return skip("its intent is not one of the run's") if footprint.nil?

      waited = now - (memo[:first_seen] || now)
      return { act: :wait, why: "waiting #{waited.round} s of #{opts[:wait]}" } if waited < opts[:wait]
      if memo[:approvals].to_i >= opts[:max_approvals]
        return verdict(:return, "approved too often", "scripted person: this change came back to the review queue after #{memo[:approvals]} approvals, because trunk kept moving under it. Redo it on the current trunk and propose again.")
      end
      return cannot_run(item, footprint, memo[:no_tests]) if memo[:no_tests]
      return { act: :retest } if memo[:asked].nil?

      run = item["reviewTests"]
      ours = run.is_a?(Hash) && (run["id"] == memo[:asked] || (memo[:asked_ms] && run["at"].to_i >= memo[:asked_ms]))
      late = now - memo[:asked_at].to_f >= opts[:retest_s]
      unless ours && %w[ran notrun].include?(run["status"])
        return cannot_run(item, footprint, "the test run asked for did not report within #{opts[:retest_s].round} s") if late

        return { act: :wait, why: "its tests are #{ours ? run['status'] : 'asked for'}" }
      end
      return cannot_run(item, footprint, run["reason"] || "the test run did not run") if run["status"] == "notrun"
      return cannot_run(item, footprint, "no test ran on it") if run["tests"].to_i.zero?
      return verdict(:approve, "tests pass", APPROVE, run) if run["failed"].to_i.zero?

      failed = run["failed"].to_i
      on_trunk = run["onTrunk"].is_a?(Hash) ? run["onTrunk"] : {}
      if failed <= 50 && on_trunk["fails"].to_i == failed && on_trunk.except("fails").values.sum(&:to_i).zero?
        return verdict(:approve, "fail on trunk too", "scripted person: the visible tests pass but for #{failed} that fail on trunk too", run)
      end

      names = Array(run["failing"]).reject { |f| f["onTrunk"] == "fails" }.first(5).map { |f| "#{f['file']}: #{f['name']}" }
      names = Array(run["failing"]).first(5).map { |f| "#{f['file']}: #{f['name']}" } if names.empty?
      more = failed > names.size ? " (#{failed} failing in all)" : ""
      verdict(:return, "tests fail", "scripted person: the visible tests fail on this change: #{names.join('; ')}#{more}. Make them pass and propose again.", run)
    end

    # Tests could not run for it: in scope approves, out of scope returns naming the files.
    def cannot_run(item, footprint, why)
      writes = Array(item["writeSet"]).filter_map { |w| w["path"] }
      outside = writes - Array(footprint)
      if outside.empty?
        verdict(:approve, "no tests, in scope", "scripted person: the visible tests could not run on this change (#{clause(why)}); it writes only files its intent names")
      else
        verdict(:return, "no tests, out of scope", "scripted person: the visible tests could not run on this change (#{clause(why)}), and it writes files its intent does not name: #{outside.first(8).join(', ')}. Keep to the intent's files, or say why in the next proposal.")
      end
    end

    # An agent's report on an intent: wait, then dismiss with the note.
    def report(memo, now, opts)
      waited = now - (memo[:first_seen] || now)
      waited < opts[:wait] ? { act: :wait, why: "waiting #{waited.round} s of #{opts[:wait]}" } : { act: :dismiss, rule: "report", reason: DISMISS }
    end

    def skip(why) = { act: :skip, why: why }

    def verdict(act, rule, reason, run = nil)
      { act: act, rule: rule, reason: reason[0, 4_900], tests: run && run.slice("status", "tests", "passed", "failed", "onTrunk").compact }
    end

    def clause(text) = text.to_s.strip.sub(/[.\s]+\z/, "")[0, 300]
  end

  # --- grading with real vitest ---------------------------------------------------------------------------------------

  # Grades a final trunk: B with the run's changes laid over it, each intent's hidden tests copied in, real vitest.
  class Grader
    attr_reader :label

    # `runner`: what runs vitest, (files, all) -> HonoTree::Vitest result; by default the worktree's real vitest.
    def initialize(repo:, worktree:, workload:, runner: nil, label: "real vitest")
      @repo = repo
      @wt = worktree
      @workload = workload
      @base = workload.dig("base", "commit")
      @runner = runner || ->(files, all) { @wt.vitest(files, all: all, timeout: VITEST_S) }
      @label = label
    end

    # Each pull request's hidden test files: the selected pull requests laid on B again in merge order, as the
    # selection laid them (the same commits, by their fixed identity and dates), and each one's test files right after
    # it, checked against the workload's blob ids: { number => { path => bytes } }.
    def hidden
      @hidden ||= begin
        prs = @workload["prs"]
        chain = HonoReplay.chain(@repo, @base, prs)
        raise Failure, "the pull requests no longer lay on B in the clone (#{chain[:conflicts].keys.map { |c| c[0, 8] }.join(', ')})" unless chain[:conflicts].empty?

        target = @workload.dig("target", "commit")
        raise Failure, "laying the pull requests on B made #{chain[:head][0, 12]}, not the workload's target #{target.to_s[0, 12]}" if target && chain[:head] != target

        prs.each_with_index.to_h do |pr, i|
          after = chain[:steps][i][:after]
          files = pr["hidden"].to_h do |h|
            text = @repo.show(after, h["path"])
            raise Failure, "the hidden file #{h['path']} of ##{pr['number']} is not what the workload recorded" unless text && HonoReplay.git_blob(text) == h["blob"]

            [h["path"], text]
          end
          [pr["number"], files]
        end
      end
    end

    # Grade the trunk whose changes since the seed are `delta` (path => bytes, nil for a deleted file).
    def grade(delta)
      hidden
      @wt.checkout(@base)
      @wt.write(delta)
      state = ->(path) { delta.key?(path) ? delta[path] : @repo.show(@base, path) }
      per = @workload["prs"].to_h do |pr|
        files = hidden[pr["number"]]
        targets = pr["run"].select { |p| files.key?(p) || !state.call(p).nil? }
        result = if targets.empty?
                   nil
                 else
                   @wt.write(files)
                   begin
                     @runner.call(targets, false)
                   ensure
                     @wt.write(files.keys.to_h { |p| [p, state.call(p)] })
                   end
                 end
        [HonoReplay.intent_id(pr), Grade.row(pr, result)]
      end
      suite = @runner.call([], true)
      Grade.summary(per, suite, delta)
    end
  end

  # The grade's arithmetic: pure, so the tests feed it recorded vitest reports.
  module Grade
    module_function

    # One intent's grade from its vitest result (nil: none of its targets exist): pass when every one of its own tests
    # (its target tests: they fail right before it in the chain and pass right after it) passes, fail when any does not,
    # error when vitest itself did not report. `files_pass` says whether every test in its hidden files passed and every
    # file loaded (the earlier pull requests' tests and B's in the same files too).
    def row(pr, result)
      targets = Array(pr["target_tests"])
      return { verdict: "not run", why: "none of its test files is on the graded trunk", target_tests: targets.size, target_passed: 0 } if result.nil?
      return { verdict: "error", why: result[:error], target_tests: targets.size, target_passed: 0 } if result[:error]

      passing = result[:files].flat_map { |path, f| f[:tests].select { |t| t[:status] == "passed" }.map { |t| "#{path}: #{t[:name]}" } }.to_set
      loaded = result[:files].reject { |_, f| f[:status] == "failed" && f[:tests].none? { |t| t[:status] == "failed" } }.keys.to_set
      passed_targets = targets.count do |t|
        path, name = t.split(": ", 2)
        name.to_s.start_with?("did not load") ? loaded.include?(path) && result[:files].dig(path, :status) == "passed" : passing.include?(t)
      end
      failing = HonoTree::Vitest.failing(result)
      verdict = targets.empty? ? result[:success] : passed_targets == targets.size
      { verdict: verdict ? "pass" : "fail", files_pass: result[:success], tests: result[:counts][:tests], passed: result[:counts][:passed], failed: result[:counts][:failed],
        target_tests: targets.size, target_passed: passed_targets, failing: failing.first(10), seconds: result[:seconds] }
    end

    # The run's grade: per intent, the verdicts as ContentionReport reads them (`files`), and the visible suite.
    def summary(per, suite, delta)
      files = per.transform_values { |r| r[:verdict] }
      {
        method: "vitest (Hono's main project) on B with the run's changes laid over it and each intent's hidden test files copied in; an intent passes when every one of its own tests passes",
        files: files, passed: files.count { |_, v| v == "pass" }, failed: files.count { |_, v| v == "fail" },
        other: files.count { |_, v| !%w[pass fail].include?(v) }, per_intent: per,
        target_tests: per.values.sum { |r| r[:target_tests].to_i }, target_passed: per.values.sum { |r| r[:target_passed].to_i },
        suite: suite[:error] ? { error: suite[:error] } : suite[:counts].merge(success: suite[:success], failing: HonoTree::Vitest.failing(suite).first(20)),
        delta: { files: delta.size, added_or_changed: delta.count { |_, v| v }, deleted: delta.count { |_, v| v.nil? }, paths: delta.keys.sort.first(200) }
      }
    end

    # `git diff --name-status -z` output as [[status, path]].
    def name_status(z)
      parts = z.split("\0")
      out = []
      out << [parts.shift, parts.shift] until parts.size < 2
      out
    end
  end

  # --- one run --------------------------------------------------------------------------------------------------------

  # One run on one colony: Contention::Run's steps, with the Hono seed, the workload's intents, the scripted person in
  # the follow loop, and grading by real vitest.
  class Run < Contention::Run
    def initialize(workload:, grader:, access:, **rest)
      super(**rest)
      @workload = workload
      @grader = grader
      @access = access
      @chunks = HonoReplay.chunks(@seed)
      @person = { decisions: [], retests: 0, retests_refused: 0, reports: [], errors: [] }
      @memo = Hash.new { |h, k| h[k] = {} }
      @report_memo = Hash.new { |h, k| h[k] = {} }
      @person_at = nil
      @result[:person] = @person
    end

    private

    # The pool: every seed agent at once, then the swarm with room to spare.
    def create_colony
      pool = [[@n + 6, @chunks.size + 2].max, 256].min
      created, secs = step("the deployment to create colony #{@name}") do
        res = api(:post, "/colonies", { name: @name, pool: pool, regionDepth: @opts[:region_depth] })
        raise Failure, "colony #{@name} already exists: pass another --name" if res.code == 409
        raise Failure, "creating colony #{@name}: #{res.problem}" unless res.ok? && res.json

        res.json
      end
      @colony = created["id"] || @name
      @result[:colony] = @colony
      # The depth the colony reports, else the one asked for (the deployment answers with the colony it made).
      @result[:region_depth] = created["regionDepth"] || @opts[:region_depth]
      step("review to switch off for the seed") { api!(:post, "/colonies/#{@colony}/decide/policy", { enabled: false }) }
      unless @opts[:certify_exclude].empty?
        step("certification to leave out #{@opts[:certify_exclude].size} tests") { api!(:post, "/colonies/#{@colony}/certify/policy", { excludeTests: @opts[:certify_exclude] }) }
        @result[:certify_exclude] = @opts[:certify_exclude]
      end
      # Tests before landing (FT_PRELAND) would judge each seed change's test files without the source files the other
      # seed changes carry; the seed is B's own tree, so the colony's tests-before-landing cover no path until it lands.
      step("tests before landing to skip the seed") { api!(:post, "/colonies/#{@colony}/certify/policy", { prelandPaths: [SEED_NO_PRELAND] }) }
      state = step("the colony's certification state") { api!(:get, "/colonies/#{@colony}/certifications?limit=1") }.first
      @result[:certification_on] = state["on"] == true
      @clock.say("created colony #{@colony} (#{fmt(secs)}), pool #{pool}, region depth #{@result[:region_depth]}; certification is #{state['on'] == true ? 'on' : "off (deployment #{state['deployment'].inspect}, runner #{state['runner'].inspect})"}; review is off until the seed lands")
    end

    # B's tree as inline changes, one scripted seed agent each, all proposed before any is waited on.
    def seed_trunk
      files = @seed.to_h
      landed, secs = long_step("the seed's #{@chunks.size} changes to land", @opts[:seed_timeout]) do
        took = @chunks.each_with_index.map do |paths, i|
          agent = register("seed-#{i + 1}")
          intent = declare(agent, "Seed Hono at #{@workload.dig('base', 'commit')[0, 12]}, part #{i + 1} of #{@chunks.size}", paths, "The project every run of the Hono replay starts from.")
          [agent, paths, take(agent, intent["id"], "seed agent #{i + 1}")]
        end
        proposed = took.map { |agent, paths, t| propose_inline(agent, t, {}, paths.to_h { |p| [p, files.fetch(p)] }, "Hono at B: #{paths.size} files") }
        proposed.each_with_index.map { |p, i| settle(p, "seed agent #{i + 1}") }
      end
      bad = landed.reject { |p| p["status"] == "landed" }
      raise Failure, "#{bad.size} seed change#{bad.size == 1 ? '' : 's'} did not land: #{bad.map { |p| "#{p['id']} #{p['status']}#{reason_of(p)}" }.join('; ')[0, 600]}" unless bad.empty?

      @result[:seed] = { files: @seed.size, bytes: @seed.sum { |_, t| t.bytesize }, changes: @chunks.size, digest: Contention.digest(@seed),
                         landings: landed.map { |p| p["landingId"] }.uniq.size, base: @workload.dig("base", "commit") }
      @clock.say("seeded Hono at #{@workload.dig('base', 'commit')[0, 12]}: #{@seed.size} files in #{@chunks.size} inline changes (#{fmt(secs)}), digest #{Contention.digest(@seed)[0, 12]}")
    end

    # Certification of the seed's commit: green is the baseline; skipped (nothing it can run) goes on unmeasured; red
    # or an error stops the run unless --red-baseline.
    def baseline
      cert, secs = long_step("certification of the seed's commit", @opts[:baseline_timeout]) do
        loop do
          snap = api!(:get, "/colonies/#{@colony}")
          c = snap.dig("colony", "certification")
          head = snap.dig("colony", "trunkSha")
          @seed_head = head
          break c if c.is_a?(Hash) && c["trunkSha"] == head && %w[green red error skipped].include?(c["status"])
          break({ "status" => "off", "trunkSha" => head }) unless @result[:certification_on]

          @waiting = "certification of the seed's commit #{short(head)} (it is #{c.is_a?(Hash) ? "#{c['status']} at #{short(c['trunkSha'])}" : 'not started'})"
          pause(3)
        end
      end
      k = cert["counts"] || {}
      @result[:seed][:head] = @seed_head
      @result[:seed][:tests] = k["tests"]
      @result[:seed][:certification] = { status: cert["status"], counts: k, failing: Array(cert["failing"]).size, unsupported: Array(cert["unsupported"]).size, detail: cert["detail"].to_s[0, 300] }
      if %w[red error].include?(cert["status"]) && !@opts[:red_baseline]
        raise Failure, "certification of the seed is #{cert['status']} (#{k['pass'].to_i}/#{k['tests'].to_i} pass): #{cert['detail'] || failing_text(cert)}; pass --red-baseline to run on it anyway"
      end

      step("tests before landing to cover every change again") { api!(:post, "/colonies/#{@colony}/certify/policy", { prelandPaths: [] }) }
      @clock.say("the seed's certification at #{short(@seed_head)}: #{cert['status']}#{k['tests'] ? " (#{k['pass']}/#{k['tests']} tests)" : ''}#{Array(cert['unsupported']).empty? ? '' : ", #{Array(cert['unsupported']).size} test files it could not run"} (#{fmt(secs)})")
    end

    def declare_intents
      @intents = {}
      @footprints = {}
      _, secs = step("the #{@workload['prs'].size} intents to be declared") do
        @workload["prs"].each do |pr|
          res = api(:post, "/colonies/#{@colony}/intents", HonoReplay.intent_body(@workload, pr))
          raise Failure, "declaring ##{pr['number']}: #{res.problem}" unless res.ok? && res.json && res.json["id"]
          raise Failure, "declaring ##{pr['number']} answered the colony's intent #{res.json['duplicateOf']}" if res.json["duplicateOf"]

          @intents[res.json["id"]] = { id: HonoReplay.intent_id(pr), title: pr["title"], change: HonoReplay.change_of(pr), footprint: pr["footprint"] }
          @footprints[res.json["id"]] = pr["footprint"]
        end
      end
      @clock.say("declared #{@intents.size} intents from honojs/hono pull requests, source human, priority #{PRIORITY} (#{fmt(secs)})")
    end

    # --- the scripted person ---------------------------------------------------------------------------------------

    # Once a poll (contention.rb's follow loop): every --person-every seconds, answer the queue.
    def answer_queue(snap, _metrics)
      return if @opts[:no_person]
      return if @person_at && Stage.now - @person_at < @opts[:person_every]

      @person_at = Stage.now
      repairs = Array(snap["intents"]).select { |i| i["source"] == "certify" }.to_h { |i| [i["id"], Array(i["footprint"])] }
      person_changes(repairs)
      person_reports
    rescue StandardError => e
      # The person is the harness's, not the measurement: what goes wrong in it is recorded and the run goes on.
      @person[:errors] << { at_s: since_release_s, error: "#{e.class.name.split('::').last}: #{e.message[0, 300]}" }
      @clock.say("the scripted person could not answer the queue: #{e.message[0, 160]}")
    end

    def person_changes(repairs)
      queue, = step("the review queue") { api!(:get, "/colonies/#{@colony}/review") }
      items = queue.is_a?(Hash) ? Array(queue["proposals"]) : Array(queue)
      now = Stage.now
      items.each do |item|
        pid = item["id"]
        footprint = @footprints[item["intentId"]] || repairs[item["intentId"]]
        memo = @memo[pid]
        memo[:first_seen] ||= now if item["status"] == "escalated" && !item["audit"] && footprint
        action = ScriptedPerson.decide(item, memo, now, footprint: footprint, opts: person_opts)
        case action[:act]
        when :retest then person_retest(item, memo, now)
        when :approve, :return then person_decide(item, memo, action)
        end
      end
    end

    def person_opts = { wait: @opts[:person_wait], retest_s: @opts[:person_retest], max_approvals: @opts[:person_max_approvals] }

    def person_retest(item, memo, now)
      res, = step("a test run on #{item['id']}") { api(:post, "/colonies/#{@colony}/proposals/#{item['id']}/tests", { by: PERSON }) }
      memo[:asked_at] = now
      if res.ok? && res.json.is_a?(Hash) && res.json["run"].is_a?(Hash)
        memo[:asked] = res.json.dig("run", "id")
        memo[:asked_ms] = res.json.dig("run", "at")
        @person[:retests] += 1
        @clock.say("scripted person: asked for the tests of #{item['id']} (#{intent_label(item)}) to run again")
      else
        @person[:retests_refused] += 1
        why = res.json.is_a?(Hash) ? res.json["error"].to_s : res.problem
        if res.code == 409 && why.include?("already waiting or running")
          memo[:asked] = :any
          memo[:asked_ms] = 0
        elsif res.code == 409 && why.match?(/no longer waits|not waiting for a person/)
          memo[:gone] = true
        else
          memo[:no_tests] = why.empty? ? res.problem : why
        end
        @clock.say("scripted person: the test run on #{item['id']} was refused (#{res.problem[0, 160]})")
      end
    end

    def person_decide(item, memo, action)
      decision = action[:act] == :approve ? "approve" : "return"
      res, = step("the scripted person's answer on #{item['id']}") { api(:post, "/colonies/#{@colony}/review/#{item['id']}", { decision: decision, reason: action[:reason], by: PERSON }) }
      row = { at_s: since_release_s, proposal: item["id"], intent: intent_label(item), decision: decision, rule: action[:rule], reason: action[:reason],
              tests: action[:tests], waited_s: (Stage.now - memo[:first_seen].to_f).round(1), ok: res.ok?, error: res.ok? ? nil : res.problem[0, 200] }.compact
      @person[:decisions] << row
      @clock.say("scripted person: #{decision} #{item['id']} (#{intent_label(item)}) by the rule \"#{action[:rule]}\"#{res.ok? ? '' : ": #{res.problem[0, 120]}"}")
      memo[:approvals] = memo[:approvals].to_i + 1 if decision == "approve" && res.ok?
      # If it comes back (a held merge), it waits again and needs a fresh test run.
      memo.delete(:first_seen)
      memo.delete(:asked)
      memo.delete(:asked_ms)
      memo.delete(:no_tests)
    end

    def person_reports
      res, = step("the agents' reports") { api(:get, "/colonies/#{@colony}/escalations") }
      return unless res.ok? && res.json.is_a?(Hash)

      now = Stage.now
      Array(res.json["intents"]).each do |intent|
        next unless @intents.key?(intent["id"]) || intent["source"] == "certify"

        memo = @report_memo["#{intent['id']}@#{intent.dig('escalation', 'at')}"]
        memo[:first_seen] ||= now
        action = ScriptedPerson.report(memo, now, person_opts)
        next unless action[:act] == :dismiss && !memo[:done]

        ans, = step("the scripted person's answer to the report on #{intent['id']}") do
          api(:post, "/colonies/#{@colony}/intents/#{intent['id']}/escalation", { decision: "dismiss", note: action[:reason], by: PERSON })
        end
        memo[:done] = true
        @person[:reports] << { at_s: since_release_s, intent: @intents.dig(intent["id"], :id) || intent["id"], kind: intent.dig("escalation", "kind"),
                               waited_s: (now - memo[:first_seen]).round(1), ok: ans.ok?, error: ans.ok? ? nil : ans.problem[0, 200] }.compact
        @clock.say("scripted person: dismissed the report on #{@intents.dig(intent['id'], :id) || intent['id']}#{ans.ok? ? '' : ": #{ans.problem[0, 120]}"}")
      end
    end

    def intent_label(item) = @intents.dig(item["intentId"], :id) || "repair #{item['intentId']}"

    def since_release_s = @released_mono ? (Stage.now - @released_mono).round(1) : nil

    # --- grading ---------------------------------------------------------------------------------------------------

    def grade_run
      skip = if @opts[:no_grade] then "--no-grade"
             elsif %w[spend interrupt].include?(@stop) then "the run ended by #{@stop == 'spend' ? 'the spend stop' : 'an interrupt'}"
             elsif @result.dig(:report, :intents, :landed).to_i.zero? then "no intent landed"
             elsif @seed_head.nil? then "the seed's commit is not known"
             end
      return @result[:grade_skipped] = skip if skip

      (grade, how, head), secs = long_step("the final trunk to be read and graded with real vitest", @opts[:grade_timeout]) do
        Dir.mktmpdir("hono-replay-trunk-") do |dir|
          how = clone_trunk(dir)
          head = git_in(dir, "rev-parse", "HEAD").strip
          delta = trunk_delta(dir)
          @result[:seed][:check] = seed_check(dir)
          [@grader.grade(delta), how, head]
        end
      end
      @result[:grade] = grade.merge(trunk_sha: head, read_by: how, by: @grader.label)
      g = @result[:grade]
      @clock.say("graded #{short(head)} by #{@grader.label} (#{fmt(secs)}, trunk read by #{how}): hidden tests pass for #{g[:passed]} of #{g[:files].size} intents#{g[:failed].positive? ? ", fail for #{g[:failed]}" : ''}#{g[:other].positive? ? ", #{g[:other]} not graded" : ''}; #{g[:target_passed]}/#{g[:target_tests]} of their own tests pass")
    rescue Failure, Stage::StepTimeout, HonoTree::Error => e
      @result[:grade_skipped] = "grading failed: #{e.message}"
      @clock.say("grading failed: #{e.message[0, 200]}")
    end

    # Clone trunk into `dir`: the deployment's public git first (FT_PUBLIC_GIT, with the Access headers), else a read
    # lease a scripted grader takes. Returns how it was read.
    def clone_trunk(dir)
      url = "#{@http.base}/git/#{@colony}.git"
      ok, err = git_clone(url, File.join(dir, "t"), @access)
      return "public git" if ok

      @clock.say("public git did not serve #{@colony} (#{err}); reading trunk through a grader's lease")
      agent = register("grader")
      intent = declare(agent, "Read trunk to grade the run", ["package.json"], "Reads trunk for grading with the hidden tests, after every agent stopped. Proposes nothing.")
      took = take(agent, intent["id"], "the grader")
      remote = took.dig("lease", "trunk", "remote")
      token = took.dig("lease", "trunk", "token")
      raise Failure, "the grader's lease names no trunk remote and token" unless remote.is_a?(String) && token.is_a?(String)

      same = Stage.origin(remote) && Stage.origin(remote) == Stage.origin(@http.base)
      ok, err = git_clone(remote, File.join(dir, "t"), { "Authorization" => "Bearer #{token}" }.merge(same ? @access : {}))
      api(:post, "/colonies/#{@colony}/agents/#{agent}/stop", {})
      raise Failure, "trunk could not be cloned through the grader's lease either: #{err}" unless ok

      "a grader's read lease"
    end

    def git_clone(url, dest, headers)
      FileUtils.rm_rf(dest)
      ok, _out, err, timed_out = Stage.run(["git", "clone", "-q", "--no-tags", url, dest], env: Stage.git_env(headers), timeout: [left, 30].max)
      [ok && !timed_out, timed_out ? "no answer in time" : Stage.redact(err.strip.lines.last.to_s.strip, @secrets)[0, 200]]
    end

    def git_in(dir, *args)
      ok, out, err, = Stage.run(["git", "-C", File.join(dir, "t"), *args], env: HonoTree::GIT_ENV, timeout: 300)
      raise Failure, "git #{args.first} in the trunk clone failed: #{err.strip.lines.last.to_s.strip[0, 200]}" unless ok

      out
    end

    # What the run changed since the seed: path => bytes at trunk's head, nil for a file it deleted.
    def trunk_delta(dir)
      changes = Grade.name_status(git_in(dir, "diff", "--name-status", "--no-renames", "-z", @seed_head, "HEAD"))
      changes.to_h do |status, path|
        [path, status == "D" ? nil : git_in(dir, "show", "HEAD:#{path}").b]
      end
    end

    # The seed as trunk holds it at the seed's commit against the seed sent: files that differ or are missing.
    def seed_check(dir)
      held = git_in(dir, "ls-tree", "-r", "-z", @seed_head).split("\0").to_h { |e| meta, path = e.split("\t", 2); [path, meta.split(/\s+/)[2]] }
      differ = @seed.reject { |path, text| held[path] == Stage.blob_id(text) }.map(&:first)
      extra = held.keys - @seed.map(&:first)
      { files: held.size, differ: differ.first(20), differ_count: differ.size, extra: extra.first(20) }
    end

    # A step with its own time limit (the seed, the baseline and grading take longer than one request).
    def long_step(waiting, seconds)
      saved = @step_timeout
      @step_timeout = seconds.to_f
      step(waiting) { yield }
    ensure
      @step_timeout = saved
    end

    def summary
      super
      p = @person
      decided = p[:decisions].select { |d| d[:ok] }.group_by { |d| d[:decision] }.transform_values(&:size)
      @clock.print("  scripted person: #{decided['approve'].to_i} approvals, #{decided['return'].to_i} returns, #{p[:retests]} test runs asked (#{p[:retests_refused]} refused), #{p[:reports].size} reports dismissed")
      g = @result[:grade]
      @clock.print("  hidden tests by #{@grader.label}: #{g ? "#{g[:passed]} of #{g[:files].size} intents pass, #{g[:target_passed]}/#{g[:target_tests]} of their own tests" : "not graded (#{@result[:grade_skipped]})"}")
      @clock.print
    end
  end

  # --- the results folder ---------------------------------------------------------------------------------------------

  # README.md, hono-replay.json, run-<label>.json and run.log, written through the evidence redaction as the contention
  # results are (Contention::Results.write).
  module Results
    module_function

    C = Contention::Results

    def default_dir(date)
      base = File.join(ROOT, "packages", "bench", "results", "#{date}-hono-replay")
      dir = base
      n = 1
      dir = "#{base}-#{n += 1}" while File.exist?(dir)
      dir
    end

    def files(sweep)
      out = { "README.md" => readme(sweep), "hono-replay.json" => "#{JSON.pretty_generate(summary(sweep))}\n" }
      sweep[:runs].each { |r| out["run-#{r[:label]}.json"] = "#{JSON.pretty_generate(r)}\n" }
      out["run.log"] = sweep[:log].to_s
      out
    end

    def summary(sweep)
      { kind: "hono-replay", label: sweep[:label] || "MEASURED", command: sweep[:command], base: sweep[:base], note: sweep[:note], workload: sweep[:workload_summary],
        runs: sweep[:runs].map { |r| r.except(:raw) }, transitions: sweep[:transitions] }
    end

    def agents(r) = "#{r[:agents]} agent#{r[:agents] == 1 ? '' : 's'}"

    def person_counts(r)
      p = r[:person] || {}
      ok = Array(p[:decisions]).select { |d| d[:ok] }
      by = ok.group_by { |d| d[:decision] }.transform_values(&:size)
      cant = ok.count { |d| d[:rule].to_s.start_with?("no tests") }
      { approve: by["approve"].to_i, return: by["return"].to_i, cannot_run: cant, retests: p[:retests].to_i, refused: p[:retests_refused].to_i,
        reports: Array(p[:reports]).count { |x| x[:ok] }, failed: Array(p[:decisions]).count { |d| !d[:ok] }, errors: Array(p[:errors]).size }
    end

    def readme(sweep)
      runs = sweep[:runs]
      w = sweep[:workload_summary]
      lines = []
      lines << "# Hono replay: #{runs.map { |r| agents(r) }.join(', ')} on honojs/hono's own pull requests"
      lines << ""
      lines << "#{sweep[:label] || 'MEASURED'} on #{sweep[:base]}#{runs.first&.dig(:build) ? " (build #{runs.first[:build]})" : ''}, #{sweep[:date]}: in-platform agents calling real models, review on, " \
               "a scripted person answering the review queue, graded by Hono's own tests under real vitest. The workload is `demo/hono-replay/workload.json` (`scripts/hono_replay_select.rb`): " \
               "honojs/hono at #{w[:base][0, 12]} (#{w[:base_date].to_s[0, 10]}) and #{w[:prs].size} pull requests merged into main after it, each redone as one intent (source human, equal priority) " \
               "with its title, its description as the why and the files it changed under src/ as its footprint. Each pull request changes source that another one also changes; " \
               "most shared: #{w[:shared].map { |f, ns| "`#{f}` (#{ns.size})" }.join(', ')}. Each run started on its own fresh colony from the same seed (B's tree, #{w[:seed_files] || 'n/a'} files) and intents."
      lines << ""
      lines << "Operator's note: #{sweep[:note]}" if sweep[:note]
      lines << "" if sweep[:note]
      depths = runs.map { |r| r[:region_depth] }.compact.uniq
      unless depths.empty?
        lines << "Each colony was created at region depth #{depths.join(', ')} (`--region-depth`, default #{REGION_DEPTH}). Admission is decided per region (a region admits while its working agents are fewer than max(3, 2 x its landings in the last minute)), " \
                 "and every file of this workload is under src/: at depth 1 the whole workload is one region and a run holds about three working agents whatever its agent count."
        lines << ""
      end
      excluded = runs.flat_map { |r| Array(r[:certify_exclude]) }.uniq
      lines << "Left out of each colony's trunk certification, not of the grade (they pass under Node and fail in workerd): #{excluded.map { |t| "`#{t}`" }.join(', ')}." unless excluded.empty?
      lines << "" unless excluded.empty?
      lines << "```sh"
      lines << sweep[:command]
      lines << "```"
      lines << ""
      lines << "The grade never reads FireTrident's certification: after a run, the final trunk is cloned with stock git, what the run changed since the seed is laid over B in a scratch Hono worktree, " \
               "and for each intent the pull request's test files are copied in and run with real vitest (Hono's main project, B's dependencies). Those hidden test files, which no agent saw, are the pull request's test files " \
               "as its history left them right after it, with the selected pull requests laid on B in merge order. An intent passes when every one of its own tests passes: the tests in those files that fail right before it and pass right after it. " \
               "\"Hidden test files pass whole\" says whether every test in them passed (B's tests and the earlier pull requests' tests in the same files as well)."
      lines << ""
      lines << "The scripted person answers the review queue every #{C.n(sweep.dig(:person, :every))} s: a change waiting at least #{C.n(sweep.dig(:person, :wait))} s gets its tests run again on the platform (the review card's \"Run again\"); " \
               "it is approved with \"scripted person: the visible tests pass\" when they pass (or when every failing test fails on its base too), and returned naming the failing tests otherwise. " \
               "When no test can run on it, it is approved when every file it writes is in its intent's footprint and returned naming the files outside otherwise. " \
               "A change approved #{sweep.dig(:person, :max_approvals)} times that comes back again is returned to be redone on the current trunk, and an agent's report waiting as long is dismissed with a note to do the intent as written. " \
               "#{sweep.dig(:person, :off) ? 'In these runs the scripted person was off (--no-person). ' : ''}Every decision is in `run-<n>.json` under `person`."
      lines << ""
      lines << "Written by `scripts/hono_replay.rb` (numbers: `scripts/contention_report.rb`, whose header defines each one) and copied through `packages/bench/src/evidence.ts redact`. Files: `hono-replay.json` (every number), `run-<n>.json` (each run's record: events, certifications, proposals, agents, the scripted person's decisions, the grade), `run.log`."
      lines << ""
      lines << "## Runs side by side"
      lines << ""
      lines << "| Measure | #{runs.map { |r| agents(r) }.join(' | ')} |"
      lines << "| --- |#{' --- |' * runs.size}"
      row = ->(label, &f) { lines << "| #{label} | #{runs.map { |r| r[:report] ? f.call(r[:report], r) : 'n/a' }.join(' | ')} |" }
      lines << "| Models | #{runs.map { |r| (r[:models] || {}).map { |m, k| "#{m.split('/').last}×#{k}" }.join(', ') }.join(' | ')} |"
      lines << "| Review | #{runs.map { |r| r.dig(:review, :enabled) ? "on (reflex #{r.dig(:review, :reflexModel).to_s.split('/').last})" : 'n/a' }.join(' | ')} |"
      lines << "| Seed's certification (the baseline) | #{runs.map { |r| baseline_cell(r) }.join(' | ')} |"
      lines << "| How the run ended | #{runs.map { |r| [r[:stop], r[:stop_detail]].compact.join(': ').gsub('|', '/') }.join(' | ')} |"
      lines << "| Stalled (no intent moved, intents open) | #{runs.map { |r| C.stalls_cell(r[:stalls]) }.join(' | ')} |"
      row.call("Intents landed") { |x| "#{x[:intents][:landed]} of #{x[:intents][:total]}#{x[:intents][:already_on_trunk].to_i.positive? ? " (#{x[:intents][:already_on_trunk]} closed as already on trunk)" : ''}" }
      row.call("Intents held at once, peak (mean)") { |x| "#{x[:concurrency][:peak_in_flight]} (#{C.n(x[:concurrency][:mean_in_flight], 2)})" }
      row.call("Intents the colony or agents declared") { |x| x[:concurrency][:colony_intents].empty? ? "none" : x[:concurrency][:colony_intents].map { |src, st| "#{src}: #{st.map { |k, v| "#{v} #{k}" }.join(', ')}" }.join("; ") }
      row.call("Wall time, release to the last landing") { |x| x[:wall][:release_to_last_landing_s] ? "#{C.n(x[:wall][:release_to_last_landing_s])} s" : "not all landed (last at #{C.n(x[:wall][:last_landing_so_far_s])} s)" }
      row.call("Release to green after the last landing") { |x| C.s(x[:wall][:release_to_green_s]) }
      row.call("Proposals (landed)") { |x| "#{x[:returns][:proposals]} (#{x[:returns][:landed]}#{x[:returns][:already_on_trunk].to_i.positive? ? "; #{x[:returns][:already_on_trunk]} already on trunk" : ''})" }
      ContentionReport::CAUSES.each { |c| row.call("Returned: #{ContentionReport::CAUSE_LABELS[c]}") { |x| x[:returns][:by_cause][c].to_s } }
      row.call("Cause-repeat rate") { |x| "#{C.pct(x[:cause_repeat][:rate])} (#{x[:cause_repeat][:repeats]}/#{x[:cause_repeat][:eligible]})" }
      row.call("Rounds to land, median (max)") { |x| "#{C.n(x[:rounds][:median_rounds])} (#{C.n(x[:rounds][:max_rounds])})" }
      row.call("Model calls to land, median") { |x| C.n(x[:rounds][:median_calls]) }
      row.call("Red-trunk episodes (open at the end)") { |x| "#{x[:red][:episodes]} (#{x[:red][:open_at_end]})" }
      row.call("Time to green, median (max)") { |x| "#{C.s(x[:red][:median_time_to_green_s])} (#{C.s(x[:red][:max_time_to_green_s])})" }
      row.call("Repair intents declared (landed)") { |x| "#{x[:red][:repair_intents][:declared]} (#{x[:red][:repair_intents][:landed]})" }
      row.call("Human queue: escalations, held merges, agent reports") { |x| "#{x[:human_queue][:escalations]}, #{x[:human_queue][:held_merges]}, #{x[:human_queue][:agent_reports]}" }
      row.call("Time in the human queue, median (max)") { |x| "#{C.s(x[:human_queue][:median_time_in_queue_s])} (#{C.s(x[:human_queue][:max_time_in_queue_s])})" }
      lines << "| Scripted person: approved, returned (by the no-tests rule) | #{runs.map { |r| k = person_counts(r); "#{k[:approve]}, #{k[:return]} (#{k[:cannot_run]})" }.join(' | ')} |"
      lines << "| Scripted person: test runs asked (refused), reports dismissed | #{runs.map { |r| k = person_counts(r); "#{k[:retests]} (#{k[:refused]}), #{k[:reports]}" }.join(' | ')} |"
      row.call("Model calls: agents (review)") { |x| "#{x[:spend][:agent_calls]} (#{C.n(x[:spend][:review_calls])})" }
      row.call("Model spend this platform made") { |x| C.usd(x[:spend][:usd]) }
      row.call("Spend per landed intent") { |x| C.usd(x[:spend][:per_landed_intent]) }
      lines << "| Hidden tests (#{runs.find { |r| r[:grade] }&.dig(:grade, :by) || 'real vitest'}): intents passing | #{runs.map { |r| r[:grade] ? "#{r[:grade][:passed]} of #{r[:grade][:files].size}" : "not graded (#{r[:grade_skipped]})" }.join(' | ')} |"
      lines << "| Their own tests passing at the end | #{runs.map { |r| r[:grade] ? "#{r[:grade][:target_passed]} of #{r[:grade][:target_tests]}" : 'n/a' }.join(' | ')} |"
      lines << "| Intents whose hidden test files pass whole | #{runs.map { |r| r[:grade] ? "#{r[:grade][:per_intent].count { |_, g| g[:files_pass] }} of #{r[:grade][:files].size}" : 'n/a' }.join(' | ')} |"
      lines << "| Visible suite at the end (same vitest) | #{runs.map { |r| suite_cell(r) }.join(' | ')} |"
      lines << ""
      runs.each { |r| lines.concat(run_section(r)) }
      sweep[:transitions].to_a.each { |t| lines.concat(C.transition_section(t)) }
      lines.concat(workload_section(w))
      lines << "## What this does not measure"
      lines << ""
      lines << "- One repository and one stretch of its history; the numbers are one contended point on real code, not a curve."
      lines << "- The person is a script: it approves what passes the visible tests and returns what fails them, which a careful reviewer would not always do."
      lines << "- Model calls are what this platform counted for the colony (agents, review, the resolver, the judge). The grade is real vitest on Node with B's dependencies, outside the platform."
      lines << "- The pull requests were merged upstream; their descriptions are what each intent says, and a description can say less than the change did."
      lines << "- Models answer differently between runs: a second run of the same command will not give the same numbers."
      lines << ""
      lines.join("\n")
    end

    def baseline_cell(r)
      c = r.dig(:seed, :certification)
      return "n/a" unless c

      k = c[:counts] || {}
      "#{c[:status]}#{k['tests'] || k[:tests] ? " (#{k['pass'] || k[:pass]}/#{k['tests'] || k[:tests]})" : ''}#{c[:unsupported].to_i.positive? ? ", #{c[:unsupported]} files not run" : ''}"
    end

    def suite_cell(r)
      s = r.dig(:grade, :suite)
      return "n/a" unless s
      return "error: #{s[:error].to_s[0, 80]}" if s[:error]

      "#{s[:passed]} of #{s[:tests]} tests pass, #{s[:failed]} failing#{s[:load_failures].to_i.positive? ? " (#{s[:load_failures]} file#{s[:load_failures] == 1 ? '' : 's'} did not load)" : ''}"
    end

    def run_section(r)
      x = r[:report]
      out = ["## #{agents(r)} (colony #{r[:colony]})", ""]
      seed = r[:seed] || {}
      check = seed[:check]
      out << "Model mix `#{r[:model]}`; region depth #{r[:region_depth] || 'n/a'}; flags on: #{Array(r[:flags]).join(', ')}; seed #{seed[:files]} files in #{seed[:changes]} inline changes, digest #{seed[:digest].to_s[0, 12]}" \
             "#{check ? ", #{check[:differ_count].zero? && check[:extra].empty? ? 'trunk held it exactly' : "trunk differed on #{check[:differ_count]} files"}" : ''}; spend cap #{r[:cap_set] ? 'set' : 'not set'}."
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
      x[:rounds][:by_cause].each { |c, v| out << "| #{ContentionReport::CAUSE_LABELS.fetch(c, c)} | #{v[:intents]} | #{C.n(v[:median_rounds])} | #{C.n(v[:median_calls])} |" }
      out << ""
      per = r.dig(:grade, :per_intent) || {}
      out << "| Intent | Pull request | Status | Proposals | Rounds | Returns | Model calls | Spend | Hidden tests | Its own tests passing | Hidden files whole |"
      out << "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"
      x[:intents][:per_intent].each do |i|
        g = per[i[:id]] || per[i[:id].to_sym] || {}
        whole = g.key?(:files_pass) ? "#{g[:files_pass] ? 'pass' : 'fail'} (#{g[:passed]}/#{g[:tests]})" : "n/a"
        out << "| #{i[:id]} | #{i[:title].to_s.gsub('|', '/')[0, 80]} | #{i[:status]} | #{i[:proposals]} | #{C.n(i[:rounds])} | #{i[:returns].map { |c, k| "#{ContentionReport::CAUSE_LABELS[c]} #{k}" }.join(', ')} | #{C.n(i[:model_calls])} | #{C.usd(i[:usd])} | #{g[:verdict] || i[:hidden] || 'n/a'} | #{g[:target_tests] ? "#{g[:target_passed]} of #{g[:target_tests]}" : 'n/a'} | #{whole} |"
      end
      out << ""
      unless x[:red][:list].empty?
        out << "| Red episode | Red at | Failing files | Culprit | Time to green | Landings during |"
        out << "| --- | --- | --- | --- | --- | --- |"
        x[:red][:list].each_with_index do |e, i|
          culprit = e[:culprit] ? "#{e[:culprit][:proposals].map { |p| p[:intent] }.join(', ')} (#{e[:culprit][:by]})" : "n/a"
          out << "| #{i + 1} | #{C.n(e[:red_at_s])} s | #{e[:failing].first(4).join(', ')} | #{culprit} | #{e[:time_to_green_s] ? "#{C.n(e[:time_to_green_s])} s" : 'still red'} | #{e[:landings_during]} |"
        end
        out << ""
      end
      decisions = Array(r.dig(:person, :decisions))
      k = person_counts(r)
      out << "Human queue: #{x[:human_queue][:escalations]} escalations, #{x[:human_queue][:held_merges]} held merges, #{x[:human_queue][:agent_reports]} agent reports; #{x[:human_queue][:waiting_at_end]} waiting at the end. " \
             "The scripted person approved #{k[:approve]} and returned #{k[:return]} (#{k[:cannot_run]} of them by the no-tests rule), asked for #{k[:retests]} test runs (#{k[:refused]} refused) and dismissed #{k[:reports]} reports#{k[:failed].positive? ? "; #{k[:failed]} answers were refused" : ''}#{k[:errors].positive? ? "; #{k[:errors]} of its passes could not read or answer the queue (in `run-<n>.json`)" : ''}."
      out << ""
      unless decisions.empty?
        out << "| At | Change | Intent | Decision | Rule | Tests run on it | Waited |"
        out << "| --- | --- | --- | --- | --- | --- | --- |"
        decisions.each do |d|
          t = d[:tests]
          tests = t ? "#{t['status'] || t[:status]}#{(t['tests'] || t[:tests]) ? " #{t['passed'] || t[:passed]}/#{t['tests'] || t[:tests]}" : ''}" : "none"
          out << "| #{C.n(d[:at_s])} s | #{d[:proposal]} | #{d[:intent]} | #{d[:decision]}#{d[:ok] ? '' : ' (refused)'} | #{d[:rule]} | #{tests} | #{C.n(d[:waited_s])} s |"
        end
        out << ""
      end
      out << "Spend by model, with the in-platform agents on it and their calls: #{x[:spend][:by_model].map { |m, v| "#{m} #{C.usd(v[:usd])} (#{v[:agents]}, #{v[:agent_calls]})" }.join('; ')}. " \
             "By layer: #{(x[:spend][:by_layer] || {}).map { |l, v| "#{l} #{C.usd(v)}" }.join(', ')}."
      out << ""
      out
    end

    def workload_section(w)
      out = ["## The workload", ""]
      out << "Base #{w[:base][0, 12]} (#{w[:base_date]}): #{w[:base_subject]}. The pull requests, in merge order, with the source files each changed, its hidden test files and how many of its own tests they hold:"
      out << ""
      out << "| Pull request | Merged | Title | Source files | Hidden test files | Its own tests |"
      out << "| --- | --- | --- | --- | --- | --- |"
      w[:prs].each do |p|
        out << "| ##{p[:number]} | #{p[:merged_at].to_s[0, 10]} | #{p[:title].to_s.gsub('|', '/')[0, 90]} | #{p[:src].map { |f| "`#{f}`" }.join(', ')} | #{p[:hidden].map { |f| "`#{f}`" }.join(', ')} | #{p[:target_tests]} |"
      end
      out << ""
      out << "Shared source files: #{w[:by_file].map { |f, ns| "`#{f}` (#{ns.map { |n| "##{n}" }.join(', ')})" }.join('; ')}."
      out << ""
      Array(w[:dropped]).each { |d| out << "Dropped from the workload after selection: ##{d['number'] || d[:number]}: #{(d['reason'] || d[:reason]).to_s.sub(/\.?\z/, '.')}" }
      out << "" unless Array(w[:dropped]).empty?
      Array(w[:notes]).each { |n| out << "Workload note: #{n}" }
      out << "" unless Array(w[:notes]).empty?
      out << "The seed is B's tree, #{w[:seed_files]} files, but for #{w[:seed_left].to_h.map { |why, k| "#{k} #{why}" }.join(', ')}: those stay in the scratch worktree the grade runs in." unless w[:seed_left].to_h.empty?
      out << "" unless w[:seed_left].to_h.empty?
      out
    end
  end

  # --- the plan and the cost ESTIMATE ---------------------------------------------------------------------------------

  # ESTIMATE of one run: the contention estimate's calls (files written per round, rounds at this agent count,
  # retries) at its per-call prices, scaled by how much more a call costs on these files than on the contention seed's
  # (call_cost of the mean bytes of the files the intents write), plus review per change at the same scale. Returns
  # { calls:, proposals:, usd:, scale: }.
  def self.estimate(workload, n, model, hono_bytes: nil)
    files = workload["prs"].sum { |p| p["footprint"].size }
    rounds = Contention::ROUNDS[n] || (n <= 1 ? 1.0 : n <= 8 ? 1.5 : 2.0)
    calls = files * rounds * Contention::RETRY
    mix = Contention.assign_models(model, n)
    per_call = mix.sum { |m, k| Contention::CALL_USD.fetch(m, Contention::CALL_USD.values.max) * k } / mix.values.sum.to_f
    scale = hono_bytes && contention_bytes.positive? ? [call_cost(hono_bytes) / call_cost(contention_bytes), 1.0].max : 1.0
    proposals = workload["prs"].size * rounds
    { calls: calls.round, proposals: proposals.round, usd: (((calls * per_call) + (proposals * Contention::REVIEW_USD)) * scale).round(2), scale: scale.round(1) }
  end

  # The relative cost of one whole-file write call on a file of `bytes`: in-platform agents read the file and about as
  # much context and write the whole file back (agents/loop.ts). Fitted to the contention calls (about 4,250 tokens in
  # and 1,160 out on files of 1.2 KB, scripts/contention.rb CALL_USD): a fixed prompt plus the file, at 3.5 bytes a
  # token, output priced at four times input (the mix's spend is mostly its largest model).
  def self.call_cost(bytes)
    file = bytes / 3.5
    (3_900 + (2 * file)) + (4 * (800 + file))
  end

  # Mean bytes of the files the contention intents write (their solved versions, else the seed's).
  def self.contention_bytes
    @contention_bytes ||= begin
      spec = Contention.spec
      sizes = spec["intents"].flat_map { |i| i["footprint"] }.uniq.filter_map do |p|
        [File.join(Contention::REFERENCE, p), File.join(Contention::SEED, p)].find { |f| File.file?(f) }&.then { |f| File.size(f) }
      end
      sizes.empty? ? 0.0 : sizes.sum.to_f / sizes.size
    end
  end

  # Mean bytes at B of the files the intents write (new files count as their hidden size when they are tests).
  def self.hono_bytes(workload, repo)
    sizes = workload["prs"].flat_map { |p| p["footprint"] }.uniq.filter_map { |p| repo.show(workload.dig("base", "commit"), p)&.bytesize }
    sizes.empty? ? nil : sizes.sum.to_f / sizes.size
  end

  def self.plan_lines(workload, opts, hono_bytes: nil)
    lines = ["plan: #{opts[:plan].size} run#{opts[:plan].size == 1 ? '' : 's'} of #{workload['prs'].size} intents (honojs/hono pull requests after #{workload.dig('base', 'commit')[0, 12]}), each on a fresh colony named #{opts[:name]}-<label> at region depth #{opts[:region_depth]}"]
    total = 0.0
    opts[:plan].each do |p|
      e = estimate(workload, p[:agents], p[:model], hono_bytes: hono_bytes)
      total += e[:usd]
      lines << format("  run %-5s %2d agent%s: %s; ESTIMATE about %d model calls and %d changes reviewed, a call %.1fx the contention run's, $%.2f (stop at $%.2f)",
                      p[:label], p[:agents], p[:agents] == 1 ? " " : "s", Contention.assign_models(p[:model], p[:agents]).map { |m, k| "#{m}×#{k}" }.join(", "), e[:calls], e[:proposals], e[:scale], e[:usd], opts[:max_usd])
    end
    lines << format("  ESTIMATE for all runs: $%.2f (at most $%.2f with every run at its stop)", total, opts[:max_usd] * opts[:plan].size)
    lines << "  colonies for FT_PUBLIC_GIT (grading clones each with stock git): #{opts[:plan].map { |p| "#{opts[:name]}-#{p[:label]}" }.join(',')}"
    lines
  end

  # --- the command line -----------------------------------------------------------------------------------------------

  def self.parse(argv)
    opts = { base: nil, agents: 8, sweep: nil, solo: false, solo_model: SOLO_MODEL, model: DEFAULT_MODEL, max_usd: 15.0,
             timeout: 2400.0, settle: 600.0, stall: 900.0, stall_report: 300.0, poll: 5.0, step_timeout: 180.0, seed_timeout: 900.0,
             baseline_timeout: 1800.0, grade_timeout: 3600.0, red_baseline: false, certify_exclude: CERTIFY_EXCLUDE, person_wait: 120.0, person_every: 30.0, person_retest: 600.0,
             person_max_approvals: 3, region_depth: REGION_DEPTH, no_person: false, approve: false, no_grade: false, keep: false, name: "hono-replay-#{Time.now.utc.strftime('%m%d-%H%M')}",
             out: nil, workload: WORKLOAD, clone: nil, modules: nil, grade_worktree: nil, plan_only: false, dry: false }
    OptionParser.new do |o|
      o.banner = "Usage: FT_TOKEN=... ruby scripts/hono_replay.rb --base <url> --clone <hono clone> --modules <node_modules> [options]"
      o.on("--base URL", "The deployment, e.g. https://staging.firetrident.com") { |v| opts[:base] = v }
      o.on("--clone DIR", "A local clone of honojs/hono holding B and the pull requests") { |v| opts[:clone] = File.expand_path(v) }
      o.on("--modules DIR", "node_modules installed in a Hono checkout at B") { |v| opts[:modules] = File.expand_path(v) }
      o.on("--grade-worktree DIR", "Scratch worktree for grading (default <clone>/../hono-replay-grade)") { |v| opts[:grade_worktree] = File.expand_path(v) }
      o.on("--workload FILE", "The workload (default demo/hono-replay/workload.json)") { |v| opts[:workload] = File.expand_path(v) }
      o.on("--agents N", Integer, "Agents in a single run (default 8)") { |v| opts[:agents] = v }
      o.on("--sweep LIST", "Agent counts, one fresh colony each, e.g. 8,16") { |v| opts[:sweep] = v.split(",").map { |x| Integer(x.strip, 10) } }
      o.on("--solo", "Add a run with 1 agent on the same intents") { opts[:solo] = true }
      o.on("--solo-model MODEL", "The solo agent's model (default #{SOLO_MODEL})") { |v| opts[:solo_model] = v }
      o.on("--model SPEC", "Model id or mix (default the contention run's)") { |v| opts[:model] = v }
      o.on("--region-depth N", Integer, "Path segments that make a region in each colony, 1 to 8 (default #{REGION_DEPTH})") { |v| opts[:region_depth] = v }
      o.on("--max-usd USD", Float, "Hard spend stop per run (default 15)") { |v| opts[:max_usd] = v }
      o.on("--timeout S", Float, "Stop following a run S seconds after its release (default 2400)") { |v| opts[:timeout] = v }
      o.on("--settle S", Float, "After every intent landed, wait up to S seconds for green (default 600)") { |v| opts[:settle] = v }
      o.on("--stall S", Float, "Stop when nothing lands for S seconds (default 900)") { |v| opts[:stall] = v }
      o.on("--stall-report S", Float, "Say STALLED when no intent moves for S seconds (default 300)") { |v| opts[:stall_report] = v }
      o.on("--poll S", Float, "Seconds between polls (default 5)") { |v| opts[:poll] = v }
      o.on("--step-timeout S", Float, "Time limit of each setup step and read (default 180)") { |v| opts[:step_timeout] = v }
      o.on("--seed-timeout S", Float, "Time limit for the seed to land (default 900)") { |v| opts[:seed_timeout] = v }
      o.on("--baseline-timeout S", Float, "Time limit for the seed's certification (default 1800)") { |v| opts[:baseline_timeout] = v }
      o.on("--grade-timeout S", Float, "Time limit for reading trunk and grading (default 3600)") { |v| opts[:grade_timeout] = v }
      o.on("--red-baseline", "Run even when the seed's certification is red or an error") { opts[:red_baseline] = true }
      o.on("--[no-]certify-exclude", "Leave the two tests that differ in workerd out of certification (default on)") { |v| opts[:certify_exclude] = v ? CERTIFY_EXCLUDE : [] }
      o.on("--person-wait S", Float, "Seconds a change waits before the scripted person answers it (default 120)") { |v| opts[:person_wait] = v }
      o.on("--person-every S", Float, "Seconds between the scripted person's passes (default 30)") { |v| opts[:person_every] = v }
      o.on("--person-retest S", Float, "Seconds a test run it asked for may take before the no-tests rule (default 600)") { |v| opts[:person_retest] = v }
      o.on("--person-max-approvals N", Integer, "Approvals of one change before it is returned instead (default 3)") { |v| opts[:person_max_approvals] = v }
      o.on("--no-person", "No scripted person: what waits for a person waits") { opts[:no_person] = true }
      o.on("--no-grade", "Do not grade with vitest at the end") { opts[:no_grade] = true }
      o.on("--keep", "Keep each colony (its agents stopped)") { opts[:keep] = true }
      o.on("--name PREFIX", "Colony name prefix; each run adds its label (default hono-replay-<time>)") { |v| opts[:name] = v }
      o.on("--out DIR", "Results folder (default packages/bench/results/<date>-hono-replay)") { |v| opts[:out] = File.expand_path(v) }
      o.on("--note TEXT", "A line for the results' README") { |v| opts[:note] = v }
      o.on("--plan", "Print the plan and the cost ESTIMATE; send nothing") { opts[:plan_only] = true }
      o.on("--check-grade", "Grade B and the target locally with real vitest (B passes no intent, the target every one); send nothing") { opts[:check_grade] = true }
      o.on("--dry-run", "Run the whole harness against recorded fixtures, with no deployment") { opts[:dry] = true }
    end.parse!(argv)
    counts = opts[:sweep] || [opts[:agents]]
    raise Stage::ConfigError, "agent counts must be 1 to 64: #{counts.join(',')}" unless counts.all? { |c| c.between?(1, 64) }
    raise Stage::ConfigError, "--region-depth must be 1 to 8 (as POST /api/colonies takes it): #{opts[:region_depth]}" unless opts[:region_depth].between?(1, 8)
    raise Stage::ConfigError, "--max-usd must be above 0" unless opts[:max_usd].positive?
    raise Stage::ConfigError, "--poll must be above 0" unless opts[:poll].positive?
    raise Stage::ConfigError, "--name must be a colony name prefix: lowercase letters, digits and hyphens" unless opts[:name].match?(/\A[a-z0-9][a-z0-9-]{0,38}\z/)

    opts[:plan] = counts.map { |c| { label: c.to_s, agents: c, model: opts[:model] } }
    opts[:plan] << { label: "solo", agents: 1, model: opts[:solo_model] } if opts[:solo]
    opts
  end

  def self.command(argv) = Contention.command(argv).sub("ruby scripts/contention.rb", "ruby scripts/hono_replay.rb").then { |c| redact_paths(c) }

  # Local paths in a command line replaced by what they stand for.
  def self.redact_paths(cmd)
    cmd.gsub(/(--(?:clone|modules|grade-worktree|out|workload)) (?:'[^']*'|\S+)/) { "#{Regexp.last_match(1)} <#{Regexp.last_match(1).delete_prefix('--')}>" }
  end

  def self.main(argv)
    original = argv.dup
    opts = parse(argv)
    return dry_run(opts, original) if opts[:dry]

    workload = load(opts[:workload])
    repo = opts[:clone] && HonoTree::Repo.new(opts[:clone])
    if opts[:plan_only]
      plan_lines(workload, opts, hono_bytes: repo && hono_bytes(workload, repo)).each { |l| puts l }
      return Stage::EXIT_PASS
    end
    raise Stage::ConfigError, "pass --clone <a local clone of honojs/hono> (the seed and the grade read it)" unless repo
    raise Stage::ConfigError, "pass --modules <node_modules installed at B> (grading runs vitest with it)" unless opts[:modules] || opts[:no_grade]
    raise Stage::ConfigError, "the clone has no commit #{workload.dig('base', 'commit')}: fetch honojs/hono into it" unless repo.commit(workload.dig("base", "commit"))
    return check_grade(opts, workload, repo) if opts[:check_grade]

    base = Stage.base_url(opts[:base])
    token = Stage.token(base)
    raise Stage::ConfigError, "FT_TOKEN is not set (the deployment's admin token: set it, or put it in ~/.config/firetrident/env with that deployment's FT_URL)" unless token

    access = Stage.access_headers
    worktree = HonoTree::Worktree.new(repo, opts[:grade_worktree] || File.join(File.dirname(opts[:clone]), "hono-replay-grade"), node_modules: opts[:modules])
    grader = Grader.new(repo: repo, worktree: worktree, workload: workload)
    grader.hidden unless opts[:no_grade]
    seed, left = seed_from(repo, workload)
    sweep(opts, original, workload, seed, left, grader, base: base, token: token, access: access, hono_bytes: hono_bytes(workload, repo))
  rescue Stage::ConfigError, OptionParser::ParseError, ArgumentError => e
    warn("hono_replay: #{e.message}")
    Stage::EXIT_USAGE
  rescue Failure, HonoTree::Error => e
    warn("hono_replay: #{e.message}")
    Stage::EXIT_FAIL
  end

  # The grader on two trunks with no deployment: B itself (no intent may pass) and the target, B with every pull
  # request laid on it (every intent must pass). It proves the clone, the node_modules and the hidden files before a run.
  def self.check_grade(opts, workload, repo)
    worktree = HonoTree::Worktree.new(repo, opts[:grade_worktree] || File.join(File.dirname(opts[:clone]), "hono-replay-grade"), node_modules: opts[:modules])
    grader = Grader.new(repo: repo, worktree: worktree, workload: workload)
    base = workload.dig("base", "commit")
    target = grader.hidden && workload.dig("target", "commit")
    results = { "B" => {}, "the target" => delta_between(repo, base, target) }.to_h do |name, delta|
      t = Stage.now
      g = grader.grade(delta)
      puts format("%-10s %2d of %d intents pass, %d of %d of their own tests; visible suite %s (%.0f s)", name, g[:passed], g[:files].size, g[:target_passed], g[:target_tests],
                  g[:suite][:error] ? "error: #{g[:suite][:error][0, 80]}" : "#{g[:suite][:passed]}/#{g[:suite][:tests]}", Stage.now - t)
      g[:per_intent].each { |id, r| puts "  #{id}: #{r[:verdict]}#{r[:failing].to_a.empty? ? '' : " (#{r[:failing].first(2).join('; ')[0, 160]})"}" } if name == "the target" && g[:passed] < g[:files].size
      [name, g]
    end
    ok = results["B"][:passed].zero? && results["the target"][:passed] == results["the target"][:files].size
    puts(ok ? "the grader holds: B passes no intent and the target passes all #{workload['prs'].size}" : "the grader does not hold: see above")
    ok ? Stage::EXIT_PASS : Stage::EXIT_FAIL
  end

  # What `to` changed against `from` in the clone, as the grader takes a trunk's changes: path => bytes, nil deleted.
  def self.delta_between(repo, from, to)
    Grade.name_status(repo.git("diff", "--name-status", "--no-renames", "-z", from, to)).to_h { |st, path| [path, st == "D" ? nil : repo.show(to, path)] }
  end

  # Every run of the plan, one after the other, and the results folder.
  def self.sweep(opts, original, workload, seed, left, grader, base:, token:, access:, hono_bytes: nil, label: "MEASURED")
    secrets = [token, *access.values]
    log = StringIO.new
    clock = Stage::Clock.new(out: Contention::Tee.new($stdout, log), secrets: secrets)
    http = Stage::Http.new(base, token: token, access: access)
    spec = spec(workload)
    plan_lines(workload, opts, hono_bytes: hono_bytes).each { |l| clock.say(l) }
    clock.say("seed: #{seed.size} files of B (#{left.size} left out: #{left.map { |l| l[:why] }.tally.map { |k, v| "#{v} #{k}" }.join(', ')}), #{chunks(seed).size} inline changes")
    date = Time.now.utc.strftime("%Y-%m-%d")
    runs = []
    interrupted = false
    opts[:plan].each do |p|
      run = Run.new(workload: workload, grader: grader, access: access, http: http, clock: clock, secrets: secrets, spec: spec, seed: seed, accept: [],
                    agents: p[:agents], model: p[:model], label: p[:label], opts: opts)
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
    if runs.none? { |r| r[:report] || r[:stop] }
      clock.say("no run reported: nothing written")
      return Stage::EXIT_TIMEOUT
    end
    sweep = { command: command(original), base: base, date: date, runs: runs, transitions: transitions, note: opts[:note], label: label,
              person: { every: opts[:person_every], wait: opts[:person_wait], max_approvals: opts[:person_max_approvals], off: opts[:no_person] },
              workload_summary: workload_summary(workload, seed).merge(seed_left: left.map { |l| l[:why] }.tally) }
    dir = opts[:out] || Results.default_dir(date)
    sweep[:log] = log.string
    Contention::Results.write(dir, Results.files(sweep), secrets)
    clock.say("wrote #{dir.delete_prefix("#{ROOT}/")} (README.md, hono-replay.json, #{runs.map { |r| "run-#{r[:label]}.json" }.join(', ')}, run.log)")
    return Stage::EXIT_FAIL if interrupted
    return Stage::EXIT_TIMEOUT if runs.all? { |r| r[:report].nil? && r[:stop] == "step timeout" }

    runs.all? { |r| r[:stop] == "landed" && r.dig(:report, :intents, :landed) == r.dig(:report, :intents, :total) } ? Stage::EXIT_PASS : Stage::EXIT_FAIL
  end

  def self.workload_summary(workload, seed)
    {
      base: workload.dig("base", "commit"), base_date: workload.dig("base", "date"), base_subject: workload.dig("base", "subject"), seed_files: seed.size,
      shared: workload.dig("overlap", "by_file").to_h.sort_by { |f, ns| [-ns.size, f] }.first(4),
      by_file: workload.dig("overlap", "by_file").to_h,
      dropped: Array(workload.dig("considered", "dropped")), notes: Array(workload["notes"]),
      prs: workload["prs"].map do |p|
        { number: p["number"], title: p["title"], merged_at: p["merged_at"], src: p["src"], hidden: p["hidden"].map { |h| h["path"] }, target_tests: Array(p["target_tests"]).size }
      end
    }
  end

  # The whole harness against recorded fixtures (scripts/test/fake_hono.rb): a fake deployment on 127.0.0.1 that
  # replays a small colony's behavior, a fixture clone with a base and three pull requests, and recorded vitest reports
  # in place of vitest. Nothing leaves this machine.
  def self.dry_run(opts, original)
    require_relative "test/fake_hono"
    FakeHono.dry_run do |fx|
      opts[:poll] = 0.05
      opts[:step_timeout] = 20.0
      opts[:seed_timeout] = 20.0
      opts[:baseline_timeout] = 20.0
      opts[:grade_timeout] = 60.0
      opts[:timeout] = 30.0
      opts[:stall] = 20.0
      opts[:settle] = 5.0
      opts[:person_wait] = 0.2
      opts[:person_every] = 0.1
      opts[:person_retest] = 5.0
      opts[:out] ||= File.join(fx[:dir], "results")
      opts[:name] = "hono-replay-dry"
      grader = Grader.new(repo: fx[:repo], worktree: HonoTree::Worktree.new(fx[:repo], File.join(fx[:dir], "grade")), workload: fx[:workload], runner: fx[:runner], label: "recorded vitest reports")
      seed, left = seed_from(fx[:repo], fx[:workload])
      code = sweep(opts, original, fx[:workload], seed, left, grader, base: fx[:url], token: fx[:token], access: fx[:access], label: "DRY RUN (recorded fixtures, no deployment)")
      puts "dry run: results in #{opts[:out]}"
      code
    end
  end
end

exit(HonoReplay.main(ARGV)) if $PROGRAM_NAME == __FILE__
