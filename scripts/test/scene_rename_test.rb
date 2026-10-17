# frozen_string_literal: true

# Tests for scripts/scene_rename.rb, run as a command against the fake colony API (fake_scene.rb) with the real scene
# data (scripts/scene_data.ts): the seed's inline changes, thirty agents on one trunk, the recipe's batches, commutation,
# the lineage of each landing, the residue, stock git's count, and the recording.
#
#   ruby scripts/test/scene_rename_test.rb
require "minitest/autorun"
require "tmpdir"
require "zlib"
require_relative "fake_scene"
require_relative "../scene"

class SceneRenameTest < Minitest::Test
  SCRIPT = File.expand_path("../scene_rename.rb", __dir__)
  DATA = Scene.data

  def run_scene(colony, *args)
    server = FakeDeployment.new { |req| colony.call(req) }
    Dir.mktmpdir("scene-config") do |config|
      out, err, status = Open3.capture3(FakeDeployment.env(config), "ruby", SCRIPT, "--base", server.url, "--step-timeout", "30", *args)
      [out, err, status.exitstatus, server.requests]
    end
  ensure
    server&.stop
  end

  def test_lands_every_change_built_before_the_rename_with_the_new_name
    out, err, code, requests = run_scene(FakeSceneColony.new(DATA))
    assert_equal 0, code, out + err
    assert_includes out, "seeded the shop: 300 files (212 files name formatPrice) in 5 inline changes"
    assert_includes out, "files the recipe rewrote:        212 of 297 in src/**"
    assert_includes out, "commits:                         3 by the recipe"
    assert_includes out, "agent changes landed:            30 of 30"
    assert_includes out, "agent changes that came back:    0\n"
    assert_includes out, "landings carrying the new name:  30 of 30 (40 of 40 files landed as their agent wrote them, with formatAmount for formatPrice)"
    assert_includes out, "trunk files naming formatPrice:  0 (the recipe's residue: 0 to rewrite, 0 by grep)"
    assert_includes out, "stock git, same base and edits:  git: 30 of 30 conflict"
    assert_match(/PASS a rename across 212 files landed while 30 agents held edits: all 30 of their changes landed with formatAmount, none came back/, out)
    [FakeDeployment::TOKEN, FakeDeployment::ACCESS_SECRET, "art_v1_"].each { |s| refute_includes out, s }

    proposals = requests.select { |r| r.method == "POST" && r.path.end_with?("/proposals") }.map(&:json)
    seeds, agents = proposals.partition { |b| b.dig("declared", "summary").start_with?("Seed ") }
    assert_equal [60, 60, 60, 60, 60], seeds.map { |b| b["contents"].size }
    assert_equal 30, agents.size
    # Each agent proposes on the trunk before the rename, inline, and read the module that defines the name.
    assert_equal 1, agents.map { |b| b["baseSha"] }.uniq.size
    agents.each { |b| assert_includes b["readSet"].map { |r| r["path"] }, "src/lib/price.ts" }
    assert agents.all? { |b| b["contents"].values.any? { |t| t.match?(/\bformatPrice\b/) } }, "every agent's edit is written with the old name"
    recipe = requests.find { |r| r.method == "POST" && r.path.end_with?("/recipes") }.json
    assert_equal({ "kind" => "rename-identifier", "version" => "1", "args" => { "from" => "formatPrice", "to" => "formatAmount" }, "scope" => ["src/**"] }, recipe.slice("kind", "version", "args", "scope"))
    # The recipe comes after every agent took its work, and before any agent proposed.
    order = requests.map { |r| [r.method, r.path] }
    last_take = order.rindex { |m, p| m == "POST" && p.end_with?("/take") }
    recipe_at = order.index { |m, p| m == "POST" && p.end_with?("/recipes") }
    first_agent = requests.index { |r| r.method == "POST" && r.path.end_with?("/proposals") && !r.json.dig("declared", "summary").start_with?("Seed ") }
    assert_operator last_take, :<, recipe_at
    assert_operator recipe_at, :<, first_agent
    assert(requests.all? { |r| FakeDeployment.accessed?(r) }, "every request carries the Access headers")
  end

  def test_fails_when_the_changes_built_before_the_rename_come_back
    out, err, code, = run_scene(FakeSceneColony.new(DATA, commute: false))
    assert_equal 1, code, out + err
    assert_includes out, "agent changes that came back:    30"
    assert_match(/FAIL 30 agent changes did not land; 30 changes came back/, out)
  end

  def test_records_the_colony_for_playback_when_asked
    Dir.mktmpdir("scene-rec") do |dir|
      file = File.join(dir, "rename.json.gz")
      out, err, code, = run_scene(FakeSceneColony.new(DATA), "--record-out", file)
      assert_equal 0, code, out + err
      assert_includes out, "recording rename-"
      rec = JSON.parse(Zlib::GzipReader.open(file, &:read))
      assert_equal "firetrident-recording", rec["format"]
      assert_match(/\Arename-\d{4}-\d{6}\z/, rec["colonyId"])
      assert_operator rec.dig("record", "events").count { |e| e["t"] == "landing" }, :>=, 3 + 5
      refute_includes JSON.generate(rec), FakeDeployment::ACCESS_SECRET
    end
  end

  def test_refuses_without_inline_changes
    out, _err, code, = run_scene(FakeSceneColony.new(DATA, flags: []))
    assert_equal 1, code
    assert_match(/FAIL inline changes are off on this deployment/, out)
  end

  def test_says_what_is_missing_without_a_token
    Dir.mktmpdir("scene-config") do |config|
      _out, err, status = Open3.capture3(FakeDeployment.env(config, token: false), "ruby", SCRIPT, "--base", "http://127.0.0.1:9")
      assert_equal 2, status.exitstatus
      assert_match(/FT_TOKEN is not set/, err)
    end
  end
end
