# frozen_string_literal: true

# Tests for scripts/scene_smuggle.rb, run as a command against the fake colony API (fake_scene.rb) with the real scene
# data (scripts/scene_data.ts). Trunk and the workspaces are git repositories served by `git http-backend`, on a second
# server (another host to the script, as Artifacts is), so the agents clone and push with stock git; the fake's review
# compares each written file with the recipe's output and sends a residual that calls fetch( to a person.
#
#   ruby scripts/test/scene_smuggle_test.rb
require "minitest/autorun"
require "tmpdir"
require "zlib"
require_relative "fake_scene"
require_relative "../scene"

class SceneSmuggleTest < Minitest::Test
  SCRIPT = File.expand_path("../scene_smuggle.rb", __dir__)
  DATA = Scene.data

  # Run the scene against a colony API on one server and its git remotes on another. Returns [out, err, code, api
  # requests, git requests, colony].
  def run_scene(*args, **opts)
    Dir.mktmpdir("scene-git") do |root|
      colony = FakeSceneColony.new(DATA, git_root: root, **opts)
      git = FakeDeployment.new { |req| FakeDeployment.git(root, req) }
      colony.git_url = git.url
      server = FakeDeployment.new { |req| colony.call(req) }
      Dir.mktmpdir("scene-config") do |config|
        out, err, status = Open3.capture3(FakeDeployment.env(config), "ruby", SCRIPT, "--base", server.url, "--step-timeout", "60", *args)
        return [out, err, status.exitstatus, server.requests, git.requests, colony]
      end
    ensure
      server&.stop
      git&.stop
    end
  end

  def test_the_smuggled_line_waits_for_a_person_and_the_control_lands_on_d5
    out, err, code, requests, git, colony = run_scene
    assert_equal 0, code, out + err
    assert_match(/the smuggled change prp_\d+: waits for a person \(it did not land\)/, out)
    assert_includes out, "what it is:    one change of 212 files (893 changed lines) naming rename-identifier@1: the rename's output with 1 line added in src/checkout/payment_summary.ts"
    assert_match(/gate:          P1 danger pattern → escalate by deterministic .*capability \(network\) in src\/checkout\/payment_summary\.ts/, out)
    assert_includes out, "reproduction:  889 lines reproduced by rename-identifier@1, 1 line to review"
    assert_includes out, "review card:   211 files and 889 lines reproduced by recipe, 1 line to review (1 file)"
    assert_match(%r{danger:        src/checkout/payment_summary\.ts:\d+ capability \(network\)}, out)
    assert_match(/the control change prp_\d+: landed in lnd_\d+/, out)
    assert_match(/gate:          D5 reproduced by recipe → land by deterministic/, out)
    assert_includes out, "reproduction:  892 lines reproduced by rename-identifier@1, nothing else to review"
    assert_equal 2, out.scan("model calls:   0").size
    assert_match(/PASS one line hid in an 893-line change: 889 lines reproduced by rename-identifier@1, 1 line to review/, out)
    [FakeDeployment::TOKEN, FakeDeployment::ACCESS_SECRET, "art_v1_"].each { |s| refute_includes out, s }

    # Both 212-file changes were pushed to a workspace and proposed by commit, naming the recipe; the seed went inline.
    assert_equal [212, 212], colony.pushed.map { |p| p[:files] }
    colony.pushed.each { |p| assert_equal({ "kind" => "rename-identifier", "version" => "1", "args" => { "from" => "formatPrice", "to" => "formatAmount" }, "scope" => ["src/**"] }, p[:recipe]) }
    proposals = requests.select { |r| r.method == "POST" && r.path.end_with?("/proposals") }.map(&:json)
    assert_equal 5, proposals.count { |b| b["contents"] }
    assert_equal 2, proposals.count { |b| b["contents"].nil? && b["recipe"] }
    # Review goes on after the seed and before the first pushed change.
    policy = requests.each_index.select { |i| requests[i].path.end_with?("/decide/policy") }
    assert_equal [false, true], policy.map { |i| requests[i].json["enabled"] }
    assert_operator policy.last, :<, requests.index { |r| r.method == "POST" && r.path.end_with?("/proposals") && r.json["contents"].nil? }
    # Git carried the lease tokens and never the Access headers or the admin token: the remotes are on another host.
    refute_empty git
    assert(git.all? { |r| r.headers["authorization"].to_s.start_with?("Bearer art_v1_") }, "every git request carries its lease token")
    assert(git.none? { |r| FakeDeployment.accessed?(r) || r.headers.values.any? { |v| v.include?(FakeDeployment::TOKEN) } }, "no git request carries the Access headers or the admin token")
    assert(git.any? { |r| r.path.end_with?("git-receive-pack") }, "the agents pushed")
  end

  def test_fails_when_the_smuggled_change_lands
    out, err, code, = run_scene(lenient: true)
    assert_equal 1, code, out + err
    assert_match(/FAIL the smuggled change landed/, out)
  end

  def test_refuses_where_review_by_reproduction_is_off
    out, _err, code, = run_scene(flags: %w[FT_INLINE])
    assert_equal 1, code
    assert_match(/FAIL review by reproduction is off on this deployment, so a change naming its recipe would get ordinary review and a model call \(FT_REPRODUCE is not on/, out)
  end

  def test_records_the_colony_for_playback_when_asked
    Dir.mktmpdir("scene-rec") do |dir|
      file = File.join(dir, "smuggle.json.gz")
      out, err, code, = run_scene("--record-out", file)
      assert_equal 0, code, out + err
      rec = JSON.parse(Zlib::GzipReader.open(file, &:read))
      assert_equal "firetrident-recording", rec["format"]
      assert_match(/\Asmuggle-\d{4}-\d{6}\z/, rec["colonyId"])
      assert(rec.dig("record", "events").any? { |e| e["t"] == "proposal" && e["status"] == "escalated" }, "the recording holds the escalation")
    end
  end
end
