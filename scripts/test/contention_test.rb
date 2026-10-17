# frozen_string_literal: true

# Tests for the contention smoke test: its workload (demo/contention/: the seed, the hidden acceptance tests, the
# reference solution and the designed pairs, checked with stock node), its report (scripts/contention_report.rb) from
# a fixture event record, and scripts/contention.rb run as a command against a fake deployment on 127.0.0.1 behind a
# fake Cloudflare Access: the run's steps, the spend stop and the sweep.
#
#   ruby scripts/test/contention_test.rb
require "minitest/autorun"
require "json"
require "open3"
require "tmpdir"
require_relative "fake_contention"
require_relative "../contention"

class ContentionTest < Minitest::Test
  SCRIPT = File.expand_path("../contention.rb", __dir__)
  FIXTURE = File.expand_path("fixtures/contention-record.json", __dir__)
  FAST = %w[--poll 0.05 --step-timeout 20 --timeout 30 --stall 20 --settle 5].freeze

  # --- the workload -------------------------------------------------------------------------------------------------

  def spec = @spec ||= Contention.spec

  # Copy `files` ([path, text] pairs) into a new directory under `root` and run node --test there with nothing of this
  # shell's environment but PATH. Returns [counts, output].
  def node_test(root, files, *args)
    dir = File.join(root, "p#{rand(1_000_000)}")
    files.each do |path, text|
      FileUtils.mkdir_p(File.dirname(File.join(dir, path)))
      File.write(File.join(dir, path), text)
    end
    out, = Open3.capture2e({ "PATH" => ENV.fetch("PATH") }, Stage::NODE, "--test", *args, chdir: dir, unsetenv_others: true)
    [%w[tests pass fail].to_h { |k| [k, out[/^ℹ #{k} (\d+)/, 1].to_i] }, out]
  end

  def reference_files = Contention.files_under(Contention::REFERENCE).map { |p| [p, File.read(File.join(Contention::REFERENCE, p))] }

  # The seed with the reference laid over it.
  def solved = Contention.seed_files.to_h.merge(reference_files.to_h)

  def test_the_seed_is_deterministic_and_its_tests_pass_with_stock_node
    a = Contention.seed_files
    b = Contention.seed_files
    assert_equal a, b
    assert_equal Contention.digest(a), Contention.digest(b)
    assert_equal a.map(&:first), a.map(&:first).sort_by(&:b), "path order"
    assert_equal 20, a.size
    assert_includes a.map(&:first), "src/core/money.ts"
    Dir.mktmpdir("contention-seed") do |root|
      counts, out = node_test(root, a)
      assert_equal({ "tests" => 23, "pass" => 23, "fail" => 0 }, counts, out)
    end
  end

  def test_every_hidden_test_fails_on_the_bare_seed_and_the_reference_passes_them_all
    accept = Contention.accept_files
    ids = spec["intents"].map { |i| i["id"] }
    assert_equal (ids.map { |id| "test/accept/#{id}.test.ts" } + ["test/accept/fixtures.ts"]).sort, accept.map(&:first).sort
    Dir.mktmpdir("contention-accept") do |root|
      counts, out = node_test(root, solved.merge(accept.to_h))
      assert_equal 0, counts["fail"], out
      assert_equal 62, counts["tests"], out
      bare = Contention.seed_files.to_h.merge(accept.to_h)
      ids.each do |id|
        c, o = node_test(root, bare, "test/accept/#{id}.test.ts")
        assert_operator c["fail"], :>=, 1, "#{id}'s hidden test passes on the seed:\n#{o}"
      end
    end
  end

  def test_each_designed_pair_is_silently_wrong_on_the_new_signature
    Dir.mktmpdir("contention-pairs") do |root|
      spec["pairs"].each do |pair|
        files = solved.merge(Contention.accept_files.to_h)
        text = files.fetch(pair["file"])
        assert_includes text, pair["new"], "#{pair['file']} makes the new call"
        files[pair["file"]] = text.gsub(pair["new"], pair["old"])
        counts, out = node_test(root, files, "test/accept/#{pair['second']}.test.ts")
        assert_operator counts["fail"], :>=, 1, "#{pair['second']} with the old call still passes:\n#{out}"
        assert_match(/AssertionError/, out, "#{pair['second']} fails on a value, not on loading")
        refute_match(/SyntaxError|does not provide an export|ERR_MODULE_NOT_FOUND/, out)
      end
    end
  end

  def test_the_spec_holds_together
    ids = spec["intents"].map { |i| i["id"] }
    assert_equal 16, ids.size
    assert_equal ids.uniq, ids
    owned = []
    spec["intents"].each do |i|
      assert_equal spec["shared"], i["footprint"].first, "#{i['id']} writes the shared module first"
      assert_match(%r{\Atest/[a-z.-]+\.test\.ts\z}, i["footprint"].last, "#{i['id']} adds its own test")
      assert_operator i["acceptance"].size, :>=, 3
      Array(i["uses"]).each { |u| assert Contention.seed_files.to_h.key?(u), "#{i['id']} builds on #{u}, which the seed has" }
      owned.concat(i["footprint"])
    end
    tests = spec["intents"].map { |i| i["footprint"].last }
    assert_equal tests.uniq, tests, "each intent has a test file of its own"
    assert_empty tests & Contention.seed_files.map(&:first), "no intent rewrites a seed test file"
    assert_empty reference_files.map(&:first) - owned, "the reference changes only files some intent writes"
    assert_equal 3, spec["intents"].count { |i| i["change"] == "signature" }
    spec["pairs"].each do |p|
      assert_includes ids, p["first"]
      assert_includes ids, p["second"]
      assert_equal "signature", spec["intents"].find { |i| i["id"] == p["first"] }["change"]
    end
    assert_includes spec["context_text"], "## Conventions"
    assert_includes spec["context_text"], "Erasable TypeScript only"
  end

  def test_an_intent_carries_its_why_in_the_layout_agents_read
    i = spec["intents"].find { |x| x["id"] == "csv" }
    body = Contention.intent_body(spec, i)
    assert_equal "human", body[:source]
    assert_equal 3, body[:priority]
    assert body[:force]
    assert_equal i["acceptance"], body[:acceptance]
    why = body[:why]
    # The layout of worker agents/create.ts: the head, "Builds on:" in it, then "\n\nSpec context (...):\n".
    m = why.match(/\n\nSpec context(?: \(([^\n]*)\))?:\n/)
    assert m, why
    assert_equal "demo/contention/spec.md", m[1]
    head = why[0, m.begin(0)]
    assert_equal "src/invoice.ts", head[/^Builds on: (.+)$/, 1]
    assert_match(/\AAccounting imports invoices as CSV\.\n\nScope: this intent writes src\/core\/money\.ts, src\/csv\.ts, test\/csv\.test\.ts\. It is one of 16 intents/, head)
    assert_includes why[m.end(0)..], "Relative imports name the `.ts` file"
    refute_includes why, "format(m, false)", "the spec context does not show the shared module's contract"
    assert_nil Contention.intent_body(spec, spec["intents"].find { |x| x["id"] == "tips" })[:why][/^Builds on:/]
  end

  def test_models_are_assigned_as_the_swarm_assigns_them
    assert_equal({ "@cf/moonshotai/kimi-k2.7-code" => 1, "@cf/zai-org/glm-5.3-flash" => 1, "@cf/openai/gpt-oss-120b" => 2, "@cf/google/gemma-4-26b-a4b-it" => 4 },
                 Contention.assign_models(Contention::DEFAULT_MODEL, 8))
    assert_equal 12, Contention.assign_models(Contention::DEFAULT_MODEL, 16)["@cf/google/gemma-4-26b-a4b-it"]
    assert_equal({ "@cf/moonshotai/kimi-k2.7-code" => 1 }, Contention.assign_models(Contention::DEFAULT_MODEL, 1))
    assert_equal({ "x" => 3 }, Contention.assign_models("x", 3))
    e8 = Contention.estimate(spec, 8, Contention::DEFAULT_MODEL)
    e16 = Contention.estimate(spec, 16, Contention::DEFAULT_MODEL)
    assert_operator e16[:calls], :>, e8[:calls]
    assert e8[:usd].between?(0.05, 2.0), e8.inspect
  end

  # --- the report, from a fixture record ----------------------------------------------------------------------------

  def fixture_report(grade: nil)
    j = JSON.parse(File.read(FIXTURE))
    spec_intents = j["spec_intents"].to_h { |k, v| [k, v.transform_keys(&:to_sym)] }
    ContentionReport.build(spec_intents: spec_intents, pairs: j["pairs"], events: j["events"], proposals: j["proposals"], certifications: j["certifications"],
                           agents: j["agents"], metrics: j["metrics"], snapshot: j["snapshot"], release_at: j["release_at"], end_at: j["end_at"], grade: grade)
  end

  def test_returns_are_classed_by_cause_with_the_repeat_rate
    r = fixture_report
    ret = r[:returns]
    assert_equal 15, ret[:proposals]
    assert_equal 6, ret[:landed]
    assert_equal 8, ret[:returned]
    assert_equal({ "stale" => 2, "text_merge" => 1, "review" => 3, "rule" => 1, "other" => 1 }, ret[:by_cause])
    assert_equal({ "tests before landing" => 1 }, ret[:other])
    assert_equal 1, ret[:escalated_now]
    cr = r[:cause_repeat]
    # fx's review return was followed by another review return; every other return's next proposal landed or came back
    # for another cause; fx's last proposal is escalated, so its second return has no settled successor.
    assert_equal 6, cr[:eligible]
    assert_equal 1, cr[:repeats]
    assert_in_delta 0.1667, cr[:rate], 1e-4
    assert_equal({ repeats: 1, eligible: 2, rate: 0.5 }, cr[:by_cause]["review"])
    assert_equal({ repeats: 0, eligible: 1, rate: 0.0 }, cr[:by_cause]["text_merge"])
  end

  def test_rounds_and_model_calls_to_land_per_intent_and_by_cause
    r = fixture_report
    rows = r[:intents][:per_intent].to_h { |x| [x[:id], x] }
    assert_equal 6, r[:intents][:landed]
    assert_equal %w[fx gift-card], r[:intents][:not_landed]
    assert_equal [1, 2, 1, 2, 1, 3], %w[format-options split csv basis-points tips loyalty].map { |id| rows[id][:rounds] }
    assert_equal({ "rule" => 1, "other" => 1 }, rows["loyalty"][:returns])
    assert_equal 11, rows["loyalty"][:model_calls]
    assert_equal 70.0, rows["loyalty"][:landed_at_s]
    assert_nil rows["fx"][:rounds]
    rounds = r[:rounds]
    assert_equal 1.5, rounds[:median_rounds]
    assert_equal 3, rounds[:max_rounds]
    assert_equal 5.5, rounds[:median_calls]
    assert_equal({ intents: 1, median_rounds: 2, median_calls: 7, rounds: 2, calls: 7 }, rounds[:by_cause]["stale"])
    assert_equal({ intents: 1, median_rounds: 2, median_calls: 8, rounds: 2, calls: 8 }, rounds[:by_cause]["text_merge"])
    assert_equal 0, rounds[:by_cause]["review"][:intents]
    assert_equal 3, rounds[:by_cause]["first try"][:intents]
  end

  def test_concurrency_says_how_many_intents_were_held_at_once
    c = fixture_report[:concurrency]
    # format-options, split and csv were claimed within 0.2 s of each other; split went back and was claimed again.
    assert_equal 3, c[:peak_in_flight]
    # 55,200 intent-milliseconds held over the 80 s from the release to the end.
    assert_equal 0.69, c[:mean_in_flight]
    assert_equal({ "system" => { "open" => 1 } }, c[:colony_intents])
  end

  def test_red_episodes_and_time_to_green
    red = fixture_report[:red]
    assert_equal 2, red[:episodes]
    assert_equal 1, red[:open_at_end]
    assert_equal 10.0, red[:median_time_to_green_s]
    assert_equal 28.0, red[:time_red_s]
    assert_equal({ declared: 2, landed: 1 }, red[:repair_intents])
    first, second = red[:list]
    assert_equal ["a3", "a4", 10.0, 1], [first[:red_sha], first[:green_sha], first[:time_to_green_s], first[:landings_during]]
    assert_equal({ by: "first red", landing: "lnd_3", proposals: [{ id: "p_csv1", intent: "csv" }] }, first[:culprit])
    assert_nil second[:time_to_green_s]
    assert_equal 18.0, second[:time_red_s]
    assert_equal ["test/tip.test.ts"], second[:failing]
  end

  def test_semantic_conflict_pairs_that_landed
    sem = fixture_report[:semantic]
    assert_equal 2, sem[:pairs_landed]
    assert_equal 0, sem[:own_mistakes]
    csv, bp = sem[:observed]
    # csv was built on the seed and merged over format-options (and split) on the shared module: candidates.
    assert_equal ["csv", %w[format-options split], "merged over it", "format-options"], [csv[:second], csv[:first], csv[:how], csv[:designed]]
    # basis-points broke the test of tips, which had landed before it: named exactly.
    assert_equal ["basis-points", ["tips"], "broke its tests", "tips"], [bp[:second], bp[:first], bp[:how], bp[:designed]]
    d1, d2 = sem[:designed]
    assert_equal({ first: "format-options", second: "csv", first_landed: true, second_landed: true, landed_second: "csv",
                   second_built_before_first_landed: true, next_certification: "red", found_as_pair: true }, d1)
    assert_equal ["basis-points", false, "red", true], [d2[:landed_second], d2[:second_built_before_first_landed], d2[:next_certification], d2[:found_as_pair]]
  end

  def test_the_human_queue_with_time_in_queue
    q = fixture_report[:human_queue]
    assert_equal [1, 1, 1, 3, 1], [q[:escalations], q[:held_merges], q[:agent_reports], q[:total], q[:waiting_at_end]]
    assert_nil q[:audit_items]
    assert_equal({ "returns" => 1 }, q[:stuck])
    assert_equal 4.0, q[:median_time_in_queue_s]
    assert_equal 49.0, q[:max_time_in_queue_s]
    assert_equal [["review escalation", "fx", 49.0, nil], ["held merge", "gift-card", 4.0, "returned"], ["agent report", "gift-card", 3.0, "dismiss"]],
                 q[:items].map { |i| [i[:kind], i[:intent], i[:time_in_queue_s], i[:answer]] }
  end

  def test_spend_by_model_and_per_landed_intent
    s = fixture_report[:spend]
    assert_equal 0.5, s[:usd]
    assert_equal 30, s[:agent_calls]
    assert_equal 14, s[:review_calls]
    assert_equal 44, s[:model_calls]
    assert_in_delta 0.5 / 6, s[:per_landed_intent], 1e-6
    # An agent's calls routed to another model count under that model; the scripted seed agent is not counted.
    assert_equal [16, 14], [s[:by_model]["@cf/google/gemma-4-26b-a4b-it"][:agent_calls], s[:by_model]["@cf/moonshotai/kimi-k2.7-code"][:agent_calls]]
    assert_equal 0.4, s[:by_model]["@cf/moonshotai/kimi-k2.7-code"][:usd]
    w = fixture_report[:wall]
    assert_equal [nil, 70.0, 80.0], [w[:release_to_last_landing_s], w[:last_landing_so_far_s], w[:run_s]]
  end

  def test_the_hidden_grade_reaches_the_intents_and_the_designed_pairs
    grade = { files: { "csv" => "fail", "tips" => "fail", "format-options" => "pass", "basis-points" => "pass" } }
    r = fixture_report(grade: grade)
    assert_equal "fail", r[:intents][:per_intent].find { |x| x[:id] == "csv" }[:hidden]
    assert_equal %w[pass fail], r[:semantic][:designed][0].values_at(:hidden_first, :hidden_second)
    cert = { "status" => "red", "trunkSha" => "abc", "counts" => { "fail" => 2, "cancelled" => 0 },
             "failing" => [{ "file" => "test/accept/csv.test.ts", "name" => "csv rows" }, { "file" => "test/split.test.ts", "name" => "an agent's own test" }],
             "unsupported" => [{ "path" => "test/accept/fx.test.ts", "reason" => "imports a package" }] }
    g = Contention.grade(cert, %w[csv fx split])
    assert_equal({ "csv" => "fail", "fx" => "not run", "split" => "pass" }, g[:files])
    assert_equal [1, 1, 1], [g[:passed], g[:failed], g[:other]]
    assert_equal ["test/accept/csv.test.ts"], g[:failing].map { |f| f[:file] }
    truncated = Contention.grade(cert.merge("counts" => { "fail" => 60, "cancelled" => 0 }), %w[split])
    assert_equal({ "split" => "unknown" }, truncated[:files])
  end

  def test_solo_against_concurrent_transitions
    row = ->(id, status, rounds, calls, hidden = nil) { { id: id, status: status, rounds: rounds, model_calls: calls, hidden: hidden } }
    solo = { intents: { per_intent: [row.("a", "landed", 1, 3, "pass"), row.("b", "landed", 1, 3, "pass"), row.("c", "landed", 2, 6, "pass")] } }
    many = { intents: { per_intent: [row.("a", "landed", 1, 3, "pass"), row.("b", "landed", 3, 10, "fail"), row.("c", "open", nil, 4, "fail")] } }
    t = ContentionReport.transitions(solo, many)
    assert_equal({ "after returns -> not landed" => 1, "first try -> after returns" => 1, "first try -> first try" => 1 }, t[:matrix])
    assert_equal({ "pass -> fail" => 2, "pass -> pass" => 1 }, t[:hidden])
    assert_equal 1.0, t[:median_rounds_delta]
    assert_equal 0, t[:intents].first[:rounds_delta]
  end

  # --- the script against a fake deployment -------------------------------------------------------------------------

  def run_script(*args, fake: FakeContention.new, access: true, token: true)
    server = FakeDeployment.new { |req| FakeDeployment.accessed?(req) ? fake.call(req) : [403, { "Content-Type" => "text/html" }, "Forbidden"] }
    Dir.mktmpdir("contention-run") do |tmp|
      out_dir = File.join(tmp, "results")
      env = FakeDeployment.env(tmp, access: access, token: token)
      out, err, status = Open3.capture3(env, "ruby", SCRIPT, "--base", server.url, "--out", out_dir, "--name", "ct", *FAST, *args)
      files = Dir.exist?(out_dir) ? Dir.children(out_dir).sort.to_h { |f| [f, File.read(File.join(out_dir, f))] } : {}
      yield(out, err, status.exitstatus, server.requests, files, fake)
    end
  ensure
    server&.stop
  end

  def posts(reqs, suffix) = reqs.select { |r| r.method == "POST" && r.path.end_with?(suffix) }

  def test_a_run_seeds_declares_releases_follows_grades_and_cleans_up
    run_script("--agents", "8", "--note", "FT_LATERAL_INHIBITION=off on this deployment") do |out, err, code, reqs, files, fake|
      assert_equal 0, code, out + err
      colony = fake.colonies.fetch("ct-8")
      assert colony[:deleted]
      # The seed lands with review off; review is on for the agents; the spend cap and the rule are set.
      seed = posts(reqs, "/proposals").first.json
      assert_equal Contention.seed_files.map(&:first), seed["writeSet"].map { |w| w["path"] }
      policy = posts(reqs, "/decide/policy").map { |r| r.json["enabled"] }
      assert_equal [false, true, false], policy, "off for the seed, on for the run, off for grading"
      assert_equal({ "usd" => 15.0, "reviewReserveUsd" => 1.5, "by" => "contention" }, posts(reqs, "/spend-cap").first.json.slice("usd", "reviewReserveUsd", "by").merge("by" => "contention"))
      intents = posts(reqs, "/intents").map(&:json)
      spec_intents = intents.reject { |b| b["assignedTo"] }
      assert_equal 16, spec_intents.size
      assert(spec_intents.all? { |b| b["source"] == "human" && b["priority"] == 3 && b["footprint"].first == "src/core/money.ts" })
      swarm = posts(reqs, "/swarm").first.json
      assert_equal [8, Contention::DEFAULT_MODEL], [swarm["count"], swarm["model"]]
      assert_equal 1, posts(reqs, "/swarm/stop").size
      assert_equal 1, reqs.count { |r| r.method == "DELETE" }
      # Grading lands the hidden tests after the agents stopped.
      grading = posts(reqs, "/proposals").last.json
      assert_equal Contention.accept_files.map(&:first), grading["writeSet"].map { |w| w["path"] }
      assert_operator reqs.index { |r| r.method == "POST" && r.path.end_with?("/swarm/stop") }, :<, reqs.rindex { |r| r.method == "POST" && r.path.end_with?("/proposals") }
      assert_equal({ "repair" => false }, posts(reqs, "/certify/policy").first.json)
      assert_includes out, "hidden tests pass for 16 of 16 intents"
      # Every request went through Access; nothing printed or written names a secret.
      assert(reqs.all? { |r| FakeDeployment.accessed?(r) })
      secrets = [FakeDeployment::TOKEN, FakeDeployment::ACCESS_SECRET, FakeDeployment::ACCESS_ID, "lease-token-", "trunk-token-"]
      (secrets).each do |s|
        refute_includes out + err, s
        files.each { |name, text| refute_includes text, s, name }
      end
      assert_equal ["README.md", "contention.json", "run-8.json", "run.log"], files.keys
      summary = JSON.parse(files["contention.json"])
      assert_equal "MEASURED", summary["label"]
      run = summary["runs"].first
      assert_equal ["landed", 16, 16], [run["stop"], run.dig("report", "intents", "landed"), run.dig("report", "intents", "total")]
      # Every third intent's first proposal went back stale in the fake.
      assert_equal 6, run.dig("report", "returns", "by_cause", "stale")
      assert_equal 16, run.dig("grade", "passed")
      assert_match(/^MEASURED on /, files["README.md"].lines[2])
      assert_includes files["README.md"], "| Intents landed | 16 of 16 |"
      assert_includes files["README.md"], "ruby scripts/contention.rb --base http://127.0.0.1:"
      assert_includes files["README.md"], "| Review | on (reflex gemma-4-26b-a4b-it) |"
      assert_includes files["README.md"], "Operator's note: FT_LATERAL_INHIBITION=off on this deployment"
      assert_match(/^\| Intents held at once, peak \(mean\) \| \d+ \(\d+\.\d\d\) \|$/, files["README.md"])
      refute_match(%r{/Users/|/private/var/|/var/folders/}, files.values.join, "local paths are redacted")
      assert JSON.parse(files["run-8.json"])["raw"]["events"].size.positive?
    end
  end

  def test_the_spend_stop_pauses_the_colony_reports_and_starts_no_further_run
    fake = FakeContention.new(land_per_poll: 1, spend_per_poll: 1.0)
    run_script("--sweep", "8,16", "--max-usd", "2", fake: fake) do |out, err, code, reqs, files, fake2|
      assert_equal 1, code, out + err
      assert_equal ["ct-8"], fake2.colonies.keys, "the 16-agent run never started"
      pause = posts(reqs, "/pause")
      assert_equal 1, pause.size
      assert_match(/spend stop: the spend read \$2\.0000, at or over --max-usd \$2\.00/, pause.first.json["reason"])
      assert_equal 1, posts(reqs, "/swarm/stop").size
      assert_operator reqs.index { |r| r.path.end_with?("/pause") }, :<, reqs.index { |r| r.path.end_with?("/swarm/stop") }
      assert_includes out, "SPEND STOP"
      assert_includes out, "no further run starts"
      assert fake2.colonies["ct-8"][:deleted]
      run = JSON.parse(files.fetch("contention.json"))["runs"].first
      assert_equal "spend", run["stop"]
      assert_match(/not graded \(the run ended by the spend stop\)/, files["README.md"])
      assert_empty posts(reqs, "/certify/policy"), "no grading after a spend stop"
    end
  end

  def test_the_colonys_own_cap_tripping_is_a_spend_stop_too
    fake = FakeContention.new(land_per_poll: 1, spend_per_poll: 0.95)
    run_script("--agents", "8", "--max-usd", "2", fake: fake) do |out, _err, code, reqs, files, _|
      assert_equal 1, code
      assert_match(/SPEND STOP: the colony's spend cap tripped \(state review-only\)/, out)
      assert_equal 1, posts(reqs, "/pause").size
      assert_equal "spend", JSON.parse(files["contention.json"])["runs"].first["stop"]
    end
  end

  def test_a_sweep_runs_each_count_and_the_solo_run_on_fresh_colonies_side_by_side
    fake = FakeContention.new(land_per_poll: 16, return_every: 4)
    run_script("--sweep", "2,3", "--solo", fake: fake) do |out, err, code, reqs, files, fake2|
      assert_equal 0, code, out + err
      assert_equal %w[ct-2 ct-3 ct-solo], fake2.colonies.keys
      assert(fake2.colonies.values.all? { |c| c[:deleted] })
      swarms = posts(reqs, "/swarm").map(&:json)
      assert_equal [[2, Contention::DEFAULT_MODEL], [3, Contention::DEFAULT_MODEL], [1, Contention::SOLO_MODEL]], swarms.map { |s| [s["count"], s["model"]] }
      titles = fake2.colonies.values.map { |c| c[:intents].values.select { |i| i[:spec] }.map { |i| i[:title] } }
      assert_equal 1, titles.uniq.size, "the same intents in every run"
      assert_equal 16, titles.first.size
      assert_equal ["README.md", "contention.json", "run-2.json", "run-3.json", "run-solo.json", "run.log"], files.keys
      summary = JSON.parse(files["contention.json"])
      assert_equal %w[2 3 solo], summary["runs"].map { |r| r["label"] }
      assert_equal [2, 3], summary["transitions"].map { |t| t["agents"] }
      readme = files["README.md"]
      assert_includes readme, "| Measure | 2 agents | 3 agents | 1 agent |"
      assert_includes readme, "| Intents landed | 16 of 16 | 16 of 16 | 16 of 16 |"
      assert_includes readme, "## Solo against 2 agents: transitions per intent"
      assert_match(/\| first try -> first try \| \d+ \|/, readme)
    end
  end

  def test_a_missing_flag_stops_the_run_before_any_colony
    fake = FakeContention.new(flags: %w[FT_INLINE])
    run_script("--agents", "8", fake: fake) do |out, _err, code, reqs, files, fake2|
      assert_equal 1, code
      assert_includes out, "trunk certification is off, and the smoke test runs with certification on (FT_TRUNK_TESTS is not on in /api/about)"
      assert_empty fake2.colonies
      assert_equal ["/api/about"], reqs.map(&:path)
      assert_match(/No report: .*FT_TRUNK_TESTS/, files["README.md"])
    end
  end

  def test_without_base_or_token_nothing_is_sent
    Dir.mktmpdir("contention-config") do |config|
      _out, err, status = Open3.capture3(FakeDeployment.env(config), "ruby", SCRIPT)
      assert_equal 2, status.exitstatus
      assert_includes err, "pass --base <url>"
    end
    run_script("--agents", "8", token: false) do |_out, err, code, reqs, files, _|
      assert_equal 2, code
      assert_includes err, "FT_TOKEN is not set"
      assert_empty reqs
      assert_empty files
    end
  end

  def test_a_dry_run_prints_the_plan_and_the_estimate_and_sends_nothing
    out, status = Open3.capture2e("ruby", SCRIPT, "--dry-run", "--sweep", "8,16", "--solo")
    assert_equal 0, status.exitstatus, out
    assert_match(/run 8 +8 agents: .*ESTIMATE about \d+ model calls/, out)
    assert_match(/run solo +1 agent : @cf\/google\/gemma-4-26b-a4b-it×1/, out)
    assert_match(/ESTIMATE for all runs: \$\d+\.\d\d \(at most \$45\.00 with every run at its stop\)/, out)
  end
end
