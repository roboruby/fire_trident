# frozen_string_literal: true

# Tests for the Hono replay's harness (scripts/hono_replay.rb): the scripted person's rule, the grade's arithmetic from
# recorded vitest reports, the seed and its inline changes, the intents' layout, the estimate, and the whole harness
# against recorded fixtures (scripts/test/fake_hono.rb: a fake colony on 127.0.0.1 behind a fake Cloudflare Access,
# its trunk served by stock git's smart HTTP) as `--dry-run` runs it, with trunk read by public git and through a
# grader's lease.
#
#   ruby scripts/test/hono_replay_test.rb
require "minitest/autorun"
require "json"
require "open3"
require "stringio"
require "tmpdir"
require_relative "fake_hono"
require_relative "../hono_replay"

class HonoReplayTest < Minitest::Test
  SCRIPT = File.expand_path("../hono_replay.rb", __dir__)
  P = HonoReplay::ScriptedPerson
  OPTS = { wait: 120, retest_s: 600, max_approvals: 3 }.freeze
  FOOT = %w[src/request.ts src/request.test.ts].freeze

  def item(run = nil, status: "escalated", writes: FOOT, **extra)
    { "id" => "prop_1", "intentId" => "int_1", "status" => status, "writeSet" => writes.map { |p| { "path" => p, "blob" => "b" } }, "reviewTests" => run }.merge(extra.transform_keys(&:to_s))
  end

  def ran(failed: 0, tests: 10, failing: [], on_trunk: nil, id: "rtr_1", at: 1_000)
    { "id" => id, "status" => "ran", "by" => "scripted person", "at" => at, "tests" => tests, "passed" => tests - failed, "failed" => failed, "failing" => failing, "onTrunk" => on_trunk }.compact
  end

  # --- the scripted person --------------------------------------------------------------------------------------------

  def test_the_person_waits_two_minutes_then_asks_for_a_test_run
    assert_equal :wait, P.decide(item, { first_seen: 100 }, 219, footprint: FOOT, opts: OPTS)[:act]
    assert_equal :retest, P.decide(item, { first_seen: 100 }, 220, footprint: FOOT, opts: OPTS)[:act]
    memo = { first_seen: 100, asked: "rtr_1", asked_at: 220, asked_ms: 1_000 }
    assert_equal :wait, P.decide(item({ "id" => "rtr_1", "status" => "running", "at" => 1_000 }), memo, 230, footprint: FOOT, opts: OPTS)[:act]
    assert_equal :wait, P.decide(item({ "id" => "rtr_0", "status" => "ran", "tests" => 3, "failed" => 0, "at" => 10 }), memo, 230, footprint: FOOT, opts: OPTS)[:act], "an older run is not the one asked for"
  end

  def test_passing_tests_approve_and_failing_ones_return_naming_them
    memo = { first_seen: 0, asked: "rtr_1", asked_at: 130, asked_ms: 1_000 }
    a = P.decide(item(ran), memo, 200, footprint: FOOT, opts: OPTS)
    assert_equal [:approve, "tests pass", "scripted person: the visible tests pass"], a.values_at(:act, :rule, :reason)
    assert_equal({ "status" => "ran", "tests" => 10, "passed" => 10, "failed" => 0 }, a[:tests])
    failing = [{ "file" => "src/request.test.ts", "name" => "req > keeps the body", "onTrunk" => "passes" },
               { "file" => "src/hono.test.ts", "name" => "app > routes", "onTrunk" => "fails" }]
    r = P.decide(item(ran(failed: 2, failing: failing, on_trunk: { "passes" => 1, "fails" => 1 })), memo, 200, footprint: FOOT, opts: OPTS)
    assert_equal [:return, "tests fail"], r.values_at(:act, :rule)
    assert_includes r[:reason], "src/request.test.ts: req > keeps the body"
    refute_includes r[:reason], "app > routes", "a test that fails on its base too is not named against it"
    assert_includes r[:reason], "(2 failing in all)"
    t = P.decide(item(ran(failed: 1, failing: [failing[1]], on_trunk: { "fails" => 1 })), memo, 200, footprint: FOOT, opts: OPTS)
    assert_equal [:approve, "fail on trunk too"], t.values_at(:act, :rule)
    assert_equal "scripted person: the visible tests pass but for 1 that fail on trunk too", t[:reason]
  end

  def test_when_no_test_can_run_the_footprint_decides
    memo = { first_seen: 0, asked: "rtr_1", asked_at: 130, asked_ms: 1_000 }
    notrun = { "id" => "rtr_1", "status" => "notrun", "at" => 1_000, "reason" => "no node:test tests in the colony." }
    a = P.decide(item(notrun), memo, 200, footprint: FOOT, opts: OPTS)
    assert_equal [:approve, "no tests, in scope"], a.values_at(:act, :rule)
    assert_equal "scripted person: the visible tests could not run on this change (no node:test tests in the colony); it writes only files its intent names", a[:reason]
    r = P.decide(item(notrun, writes: FOOT + ["src/hono-base.ts"]), memo, 200, footprint: FOOT, opts: OPTS)
    assert_equal [:return, "no tests, out of scope"], r.values_at(:act, :rule)
    assert_includes r[:reason], "it writes files its intent does not name: src/hono-base.ts"
    assert_equal "no tests, in scope", P.decide(item(ran(tests: 0)), memo, 200, footprint: FOOT, opts: OPTS)[:rule], "no test ran on it"
    late = P.decide(item({ "id" => "rtr_1", "status" => "queued", "at" => 1_000 }), memo, 130 + 600, footprint: FOOT, opts: OPTS)
    assert_equal [:approve, "no tests, in scope"], late.values_at(:act, :rule)
    assert_includes late[:reason], "did not report within 600 s"
    refused = P.decide(item, { first_seen: 0, no_tests: "Tests cannot run in this colony: certification is off." }, 200, footprint: FOOT, opts: OPTS)
    assert_includes refused[:reason], "(Tests cannot run in this colony: certification is off)"
  end

  def test_what_is_not_the_runs_or_not_waiting_is_left_alone_and_repeat_approvals_end
    assert_equal :skip, P.decide(item(nil, audit: { "kind" => "audit" }), {}, 999, footprint: FOOT, opts: OPTS)[:act]
    assert_equal :skip, P.decide(item(nil, status: "landed"), {}, 999, footprint: FOOT, opts: OPTS)[:act]
    assert_equal :skip, P.decide(item, {}, 999, footprint: nil, opts: OPTS)[:act], "a canary or another intent's change"
    back = P.decide(item(ran), { first_seen: 0, approvals: 3, asked: "rtr_1", asked_at: 0, asked_ms: 0 }, 999, footprint: FOOT, opts: OPTS)
    assert_equal [:return, "approved too often"], back.values_at(:act, :rule)
    assert_includes back[:reason], "after 3 approvals"
    assert_equal :wait, P.report({ first_seen: 0 }, 60, OPTS)[:act]
    d = P.report({ first_seen: 0 }, 120, OPTS)
    assert_equal [:dismiss, "report"], d.values_at(:act, :rule)
    assert d[:reason].start_with?("scripted person: ")
    assert_equal P::RULES.keys.sort, ["approved too often", "fail on trunk too", "no tests, in scope", "no tests, out of scope", "report", "tests fail", "tests pass"]
  end

  # --- the grade ------------------------------------------------------------------------------------------------------

  def report(name) = HonoTree::Vitest.parse(File.read(File.expand_path("fixtures/hono-replay/vitest/#{name}.json", __dir__)), "/fixture/grade").merge(seconds: 0.1)

  def test_an_intent_passes_when_its_own_tests_pass
    pr = { "target_tests" => ["src/request.test.ts: header > trims"] }
    row = HonoReplay::Grade.row(pr, report("9001"))
    assert_equal({ verdict: "pass", files_pass: true, tests: 2, passed: 2, failed: 0, target_tests: 1, target_passed: 1, failing: [], seconds: 0.1 }, row)
    fail = HonoReplay::Grade.row({ "target_tests" => ["src/utils/url.test.ts: path > drops the fragment"] }, report("9002"))
    assert_equal ["fail", false, 0], fail.values_at(:verdict, :files_pass, :target_passed)
    assert_equal ["src/utils/url.test.ts: path > drops the fragment"], fail[:failing]
    # Its own tests pass while an earlier one's test in the same file fails: it passes, the file does not.
    mixed = HonoReplay::Grade.row({ "target_tests" => ["src/router/node.test.ts: match > matches equal paths"] }, report("suite"))
    assert_equal ["pass", false], mixed.values_at(:verdict, :files_pass)
    loaded = HonoReplay::Grade.row({ "target_tests" => ["src/broken.test.ts: did not load (x)"] }, report("suite"))
    assert_equal 0, loaded[:target_passed], "a file that still does not load does not count"
    assert_equal "not run", HonoReplay::Grade.row(pr, nil)[:verdict]
    assert_equal "error", HonoReplay::Grade.row(pr, { error: "vitest wrote no report" })[:verdict]
  end

  def test_the_grade_sums_verdicts_and_keeps_the_suite_and_the_delta
    per = { "#1" => { verdict: "pass", target_tests: 2, target_passed: 2 }, "#2" => { verdict: "fail", target_tests: 1, target_passed: 0 }, "#3" => { verdict: "not run", target_tests: 1, target_passed: 0 } }
    g = HonoReplay::Grade.summary(per, report("suite"), { "src/a.ts" => "x", "src/b.ts" => nil })
    assert_equal({ "#1" => "pass", "#2" => "fail", "#3" => "not run" }, g[:files])
    assert_equal [1, 1, 1, 4, 2], g.values_at(:passed, :failed, :other, :target_tests, :target_passed)
    assert_equal({ tests: 4, passed: 3, failed: 2 }, g[:suite].slice(:tests, :passed, :failed))
    assert_equal({ files: 2, added_or_changed: 1, deleted: 1, paths: %w[src/a.ts src/b.ts] }, g[:delta])
    assert_equal [%w[M src/a.ts], %w[D src/b.ts], ["A", "src/c d.ts"]], HonoReplay::Grade.name_status("M\0src/a.ts\0D\0src/b.ts\0A\0src/c d.ts\0")
  end

  # --- the seed, the intents, the estimate ----------------------------------------------------------------------------

  def test_the_seed_is_bs_tree_but_what_the_workload_leaves_out_in_inline_sized_changes
    Dir.mktmpdir do |dir|
      repo, workload = FakeHono.build(dir)
      files, left = HonoReplay.seed_from(repo, workload)
      assert_equal %w[package.json src/request.test.ts src/request.ts src/router/node.test.ts src/router/node.ts src/utils/url.test.ts src/utils/url.ts], files.map(&:first)
      assert_equal [{ path: "docs/images/logo.png", why: "under docs/images/" }, { path: "runtime-tests/bun/index.test.ts", why: "under runtime-tests/" }], left
      assert_equal repo.show(workload.dig("base", "commit"), "src/request.ts"), files.to_h["src/request.ts"]
    end
    files = (1..130).map { |i| [format("src/f%03d.ts", i), "x" * 1_000] }
    assert_equal [64, 64, 2], HonoReplay.chunks(files).map(&:size), "at most 64 files a change"
    big = (1..6).map { |i| ["src/b#{i}.ts", "y" * 200_000] }
    assert_equal [2, 2, 2], HonoReplay.chunks(big).map(&:size), "at most 500 KB a change"
    assert_equal big.map(&:first), HonoReplay.chunks(big).flatten, "in path order"
  end

  def test_an_intent_carries_the_description_its_scope_and_the_projects_context
    Dir.mktmpdir do |dir|
      _repo, workload = FakeHono.build(dir)
      body = HonoReplay.intent_body(workload, workload["prs"][1])
      assert_equal "fix(url): keep the fragment out of the path", body[:title]
      assert_equal ["src/request.ts", "src/utils/url.test.ts", "src/utils/url.ts"], body[:footprint]
      assert_equal [[], 3, "human", true], body.values_at(:acceptance, :priority, :source, :force)
      assert body[:why].start_with?("A fragment stayed in the path, so routes did not match.\n\nScope: this intent writes src/request.ts, src/utils/url.test.ts, src/utils/url.ts. It is one of 3 intents")
      assert_includes body[:why], "Project context: this is Hono (honojs/hono)"
      empty = HonoReplay.why(workload, workload["prs"][2])
      assert empty.start_with?("The pull request this intent comes from gave no description beyond its title.")
      spec = HonoReplay.spec(workload)
      assert_equal %w[#9001 #9002 #9003], spec["intents"].map { |i| i["id"] }
      assert_equal %w[fix fix fix], spec["intents"].map { |i| i["change"] }
      assert_equal [], spec["pairs"]
    end
  end

  def test_the_estimate_scales_with_file_size_and_the_command_names_no_local_path
    workload = { "prs" => [{ "footprint" => %w[a b] }, { "footprint" => %w[c] }] }
    small = HonoReplay.estimate(workload, 8, HonoReplay::DEFAULT_MODEL)
    large = HonoReplay.estimate(workload, 8, HonoReplay::DEFAULT_MODEL, hono_bytes: 20_000)
    assert_equal 1.0, small[:scale]
    assert_equal small[:calls], large[:calls], "the calls are the contention estimate's"
    assert_in_delta 4.5, large[:scale], 0.3, "a 20 KB file costs a whole-file write about four and a half times a 1.2 KB one"
    assert_in_delta small[:usd] * large[:scale], large[:usd], 0.02
    assert_operator HonoReplay.call_cost(1_183) * 1.0, :<, HonoReplay.call_cost(20_000)
    cmd = HonoReplay.command(["--base", "https://staging.firetrident.com", "--clone", "/Users/x/hono", "--modules", "/Users/x/base/node_modules", "--sweep", "8,16", "--solo"])
    assert_equal "ruby scripts/hono_replay.rb --base https://staging.firetrident.com --clone <clone> --modules <modules> --sweep 8,16 --solo", cmd
  end

  # --- the whole harness on recorded fixtures -------------------------------------------------------------------------

  FAST = %w[--poll 0.05 --step-timeout 20 --seed-timeout 20 --baseline-timeout 20 --grade-timeout 60 --timeout 30 --stall 20 --settle 5
            --person-wait 0.2 --person-every 0.1 --person-retest 5].freeze

  # Run the harness in this process against the fixtures; yields the results folder, the run's record, the fake and
  # the requests the fake deployment saw.
  def harness(public_git: true, args: [])
    FakeHono.dry_run(public_git: public_git) do |fx|
      out = File.join(fx[:dir], "results")
      opts = HonoReplay.parse(FAST + ["--name", "hono-test", "--out", out] + args)
      grader = HonoReplay::Grader.new(repo: fx[:repo], worktree: HonoTree::Worktree.new(fx[:repo], File.join(fx[:dir], "grade")), workload: fx[:workload], runner: fx[:runner], label: "recorded vitest reports")
      seed, left = HonoReplay.seed_from(fx[:repo], fx[:workload])
      code = nil
      log = StringIO.new
      saved = $stdout
      $stdout = log
      begin
        code = HonoReplay.sweep(opts, %w[--dry-run], fx[:workload], seed, left, grader, base: fx[:url], token: fx[:token], access: fx[:access])
      ensure
        $stdout = saved
      end
      yield(code, out, JSON.parse(File.read(File.join(out, "run-8.json"))), fx, log.string)
    end
  end

  def test_a_run_seeds_follows_with_the_scripted_person_grades_by_vitest_and_cleans_up
    harness do |code, out, run, fx, log|
      assert_equal Stage::EXIT_PASS, code, log
      assert_equal %w[README.md hono-replay.json run-8.json run.log], Dir.children(out).sort
      answers = fx[:fake].answers
      assert_equal [{ kind: "retest", proposal: answers[0][:proposal], by: "scripted person" }], answers.first(1)
      decided = answers.reject { |a| a[:kind] == "retest" }
      assert_equal %w[dismiss approve return], decided.map { |a| a[:kind] }
      assert_equal "scripted person: the visible tests pass", decided[1][:reason]
      assert_includes decided[2][:reason], "src/router/node.test.ts: match > matches a trailing slash"
      assert decided.all? { |a| a[:by] == "scripted person" }
      refute(answers.any? { |a| %w[prop_audit prop_canary].include?(a[:proposal]) }, "the audit item and the other intent's change are left alone")
      person = run["person"]
      assert_equal [["approve", "tests pass"], ["return", "tests fail"]], person["decisions"].map { |d| [d["decision"], d["rule"]] }
      assert_equal 2, person["retests"]
      assert_equal 1, person["reports"].size
      g = run["grade"]
      assert_equal({ "#9001" => "pass", "#9002" => "fail", "#9003" => "pass" }, g["files"])
      assert_equal "public git", g["read_by"]
      assert_equal 6, g.dig("delta", "files"), "the three intents' landings changed the six files of their footprints"
      assert_equal 0, run.dig("seed", "check", "differ_count"), "trunk held the seed exactly"
      assert_equal 3, run.dig("report", "intents", "landed")
      assert_equal "landed", run["stop"]
      assert run["deleted"]
      readme = File.read(File.join(out, "README.md"))
      assert_includes readme, "| Scripted person: approved, returned (by the no-tests rule) | 1, 1 (0) |"
      assert_includes readme, "| Hidden tests (recorded vitest reports): intents passing | 2 of 3 |"
      assert_includes readme, "| #9003 | fix(router): match a trailing slash | landed | 2 | 2 | review 1 |"
      reqs = fx[:server].requests
      assert reqs.all? { |r| FakeDeployment.accessed?(r) }, "every request, git's too, carries the Access headers"
      assert(reqs.any? { |r| r.path == "/git/hono-test-8.git/info/refs" })
      [FakeDeployment::TOKEN, FakeDeployment::ACCESS_SECRET].each do |secret|
        Dir.children(out).each { |f| refute_includes File.read(File.join(out, f)), secret, f }
        refute_includes log, secret
      end
    end
  end

  def test_without_public_git_the_grade_reads_trunk_through_a_graders_lease
    harness(public_git: false) do |code, _out, run, fx, log|
      assert_equal Stage::EXIT_PASS, code, log
      assert_equal "a grader's read lease", run.dig("grade", "read_by")
      assert_equal 2, run.dig("grade", "passed")
      assert_includes log, "public git did not serve hono-test-8"
      assert(fx[:server].requests.any? { |r| r.method == "POST" && r.path.match?(%r{/agents/[^/]+/stop\z}) }, "the grader stops once it has read trunk")
      refute_includes log, "trunk-token-"
    end
  end

  def test_with_no_person_what_waits_for_a_person_waits
    harness(args: %w[--no-person --stall 3 --timeout 4]) do |code, _out, run, fx, log|
      assert_equal Stage::EXIT_FAIL, code, log
      assert_empty fx[:fake].answers
      assert_equal 1, run.dig("report", "intents", "landed")
      assert_equal 2, run.dig("report", "human_queue", "waiting_at_end")
    end
  end

  def test_the_dry_run_command_runs_the_harness_on_the_fixtures
    Dir.mktmpdir do |dir|
      out, status = Open3.capture2e({ "FT_TOKEN" => nil, "CF_ACCESS_CLIENT_ID" => nil, "CF_ACCESS_CLIENT_SECRET" => nil }, "ruby", SCRIPT, "--dry-run", "--out", File.join(dir, "r"))
      assert_equal 0, status.exitstatus, out
      assert_includes out, "graded "
      assert_includes out, "by recorded vitest reports"
      readme = File.read(File.join(dir, "r", "README.md"))
      assert readme.start_with?("# Hono replay: 8 agents on honojs/hono's own pull requests\n\nDRY RUN (recorded fixtures, no deployment)")
    end
  end

  def test_the_plan_prints_the_estimate_and_the_colonies_for_public_git
    out, status = Open3.capture2e("ruby", SCRIPT, "--plan", "--sweep", "8,16", "--solo", "--name", "hono-replay")
    assert_equal 0, status.exitstatus, out
    assert_includes out, "colonies for FT_PUBLIC_GIT (grading clones each with stock git): hono-replay-8,hono-replay-16,hono-replay-solo"
    assert_match(/run 16 +16 agents: .*ESTIMATE about \d+ model calls/, out)
  end

  def test_settings_that_are_missing_stop_before_anything_is_sent
    out, status = Open3.capture2e({ "FT_TOKEN" => nil, "XDG_CONFIG_HOME" => Dir.tmpdir }, "ruby", SCRIPT, "--base", "http://127.0.0.1:9")
    assert_equal Stage::EXIT_USAGE, status.exitstatus
    assert_includes out, "pass --clone"
    out, status = Open3.capture2e("ruby", SCRIPT, "--name", "Bad_Name", "--plan")
    assert_equal Stage::EXIT_USAGE, status.exitstatus
    assert_includes out, "--name must be a colony name prefix"
  end
end
