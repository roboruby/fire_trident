# frozen_string_literal: true

# Tests for scripts/mosaic.rb, run as a command against a fake colony API on 127.0.0.1 that keeps a trunk of texts, takes
# inline changes, merges a stale one as text merge does (a line edited on one side only lands; edits on the same or
# touching lines conflict; lines both sides added at the end land together where the insertion rule is on), records
# landings with their lineage notes, and serves a landing's files through the preview route when the colony is public.
#
#   ruby scripts/test/mosaic_test.rb
require "minitest/autorun"
require "digest"
require "tmpdir"
require "zlib"
require_relative "fake_deployment"
require_relative "../stage"
require_relative "../mosaic"

# The colony API the beat calls, in memory.
class FakeMosaicColony
  attr_reader :proposals, :intents, :agents, :deleted

  def initialize(flags: %w[FT_INLINE FT_TEXT_MERGE FT_MERGE_INSERTIONS], public: true, insertions: true, bounce: 0, give_back: 0, settle_after: 0)
    @flags = flags
    @public = public
    @insertions = insertions
    @bounce = bounce
    @give_back = give_back
    @settle_after = settle_after
    @polls = Hash.new(0)
    @n = 0
    @lock = Mutex.new
    @created = []
    @agents = {}
    @intents = {}
    @proposals = {}
    @took = Hash.new(0)
    @landings = []
    @notes = {}
    @events = []
    @deleted = []
    root = Digest::SHA1.hexdigest("root")
    @head = root
    @trees = { root => {} }
  end

  def call(req) = @lock.synchronize { route(req) }

  def head_tree = @lock.synchronize { @trees[@head].dup }

  private

  def id(prefix) = "#{prefix}_#{@n += 1}"

  # One event of the colony's record, at the wall clock's time, as the replay reads it.
  def event(fields) = @events << { "seq" => @events.size + 1, "at" => (Time.now.to_f * 1000).round }.merge(fields)
  def json(status, body) = FakeDeployment.json(status, body)

  def route(req)
    return json(200, { service: "firetrident", commit: "abc1234", flags: @flags, noteKey: nil }) if req.path == "/api/about"
    return create(req) if req.method == "POST" && req.path == "/api/colonies"

    m = req.path.match(%r{\A/api/colonies/([^/]+)(/.*)?\z})
    colony = m && m[1]
    rest = m && m[2].to_s
    return json(404, { error: "no route for #{req.method} #{req.path}" }) unless colony && @created.include?(colony)

    case [req.method, rest]
    in ["GET", ""]
      json(200, { colony: { id: colony, name: colony, trunkSha: @head, regionDepth: 1, createdAt: 0 }, files: @trees[@head].map { |p, t| { path: p, size: t.bytesize } },
                  intents: [], rules: [], agents: [], recentLandings: [], violations: { total: 0, byRule: {} }, funnel: { proof: 0, reflex: 0, llm: 0, human: 0 }, metrics: {} })
    in ["DELETE", ""]
      @deleted << colony
      json(200, { ok: true })
    in ["POST", "/decide/policy"] then json(200, { enabled: req.json["enabled"] })
    in ["POST", "/agents"]
      a = { "id" => id("agt"), "name" => req.json["name"], "kind" => req.json["kind"], "model" => req.json["model"] }
      @agents[a["id"]] = a
      event("t" => "agent", "agentId" => a["id"], "kind" => a["kind"], "state" => "idle")
      json(201, a)
    in ["GET", "/agents"] then json(200, { colonyId: colony, total: @agents.size, agents: @agents.values })
    in ["POST", "/intents"]
      b = req.json
      i = { "id" => id("int"), "title" => b["title"], "why" => b["why"], "footprint" => b["footprint"], "assignedTo" => b["assignedTo"], "revision" => 1,
            "status" => b["assignedTo"] ? "claimed" : "open" }
      @intents[i["id"]] = i
      event("t" => "intent", "intentId" => i["id"], "status" => i["status"], "title" => i["title"], "footprint" => i["footprint"])
      json(201, i)
    in ["GET", %r{\A/intents/([^/]+)\z}]
      i = @intents[Regexp.last_match(1)]
      i ? json(200, { intent: i, revisions: [], directives: [], escalations: [] }) : json(404, { error: "unknown intent" })
    in ["POST", %r{\A/agents/([^/]+)/take\z}] then take(Regexp.last_match(1))
    in ["POST", "/proposals"] then propose(req.json)
    in ["GET", %r{\A/proposals/([^/]+)\z}] then poll(Regexp.last_match(1))
    in ["GET", "/why"] then json(200, @landings.reverse.select { |l| l["paths"].include?(req.params["path"]) }.map { |l| { landing: l, note: @notes[l["id"]] } })
    in ["GET", "/events"] then json(200, { colonyId: colony, source: "recorded", events: @events, next: nil, total: @events.size, first: 1, last: @events.size })
    in ["GET", %r{\A/preview/([0-9a-f]{40})/(.+)\z}] then preview(colony, Regexp.last_match(1), Regexp.last_match(2))
    else json(404, { error: "no route for #{req.method} #{req.path}" })
    end
  end

  def create(req)
    name = req.json["name"]
    return json(409, { error: "colony #{name} already exists" }) if @created.include?(name)

    @created << name
    json(201, { id: name, name: name, trunkSha: @head })
  end

  def lease(agent)
    { repo: { namespace: "ft-ws-0", name: "ws-#{agent}", remote: "https://example.invalid/git/ws.git" }, token: "art_v1_leasetoken#{agent}",
      tokenExpiresAt: 0, baseSha: @head, leasedAt: 0, trunk: { remote: "https://example.invalid/git/trunk.git", token: "art_v1_trunktoken", sha: @head } }
  end

  # An agent's assignment, else an intent that went back; each agent's first take waits, as a new pool does while it forks.
  def take(agent)
    @took[agent] += 1
    return json(200, { wait: true, retryInMs: 20, reason: "the workspace pool is forking" }) if @took[agent] == 1

    held = @intents.values.find { |i| i["assignedTo"] == agent && i["status"] == "claimed" }
    if held && @give_back.positive? && @landings.any?
      # As the colony does when it cannot lease a workspace: the held intent goes back to the colony.
      @give_back -= 1
      held["status"] = "open"
      held["assignedTo"] = nil
      return json(200, { wait: true, retryInMs: 20, reason: "pool empty" })
    end
    intent = held || @intents.values.find { |i| i["status"] == "open" }
    return json(200, { wait: true, retryInMs: 20, reason: "no open intents" }) unless intent

    intent["status"] = "claimed"
    intent["assignedTo"] = agent
    json(200, { intent: intent, lease: lease(agent) })
  end

  def propose(b)
    writes = b["writeSet"].map do |w|
      text = b.dig("contents", w["blob"])
      return json(400, { error: "contents do not hash to the write set's blob" }) unless text && Stage.blob_id(text) == w["blob"]

      [w["path"], text]
    end
    return json(400, { error: "headSha is not the changeset id" }) unless b["headSha"] == Stage.changeset_id(b["baseSha"], b["writeSet"].map { |w| { path: w["path"], blob: w["blob"] } })

    intent = @intents[b["intentId"]]
    return json(409, { error: "intent #{b['intentId']} is not held by #{b['agentId']}" }) unless intent && intent["assignedTo"] == b["agentId"] && intent["status"] == "claimed"

    intent["status"] = "proposed"
    p = { "id" => id("prp"), "intentId" => b["intentId"], "agentId" => b["agentId"], "status" => "ready", "baseSha" => b["baseSha"], "writes" => writes.to_h,
          "readSet" => b["readSet"], "footprint" => b.dig("declared", "footprint") }
    @proposals[p["id"]] = p
    event("t" => "proposal", "proposalId" => p["id"], "intentId" => p["intentId"], "agentId" => p["agentId"], "status" => "ready")
    json(201, view(p))
  end

  def view(p) = p.except("writes", "baseSha", "readSet", "footprint")

  def poll(pid)
    p = @proposals[pid]
    return json(404, { error: "proposal not found" }) unless p

    @polls[pid] += 1
    settle(p) if p["status"] == "ready" && @polls[pid] > @settle_after
    json(200, view(p))
  end

  def settle(p)
    if @bounce.positive? && p["writes"].key?(Mosaic::MOSAIC) && @landings.any?
      @bounce -= 1
      return back(p, "stale: #{Mosaic::MOSAIC} changed under it, and this fake sends the change back once")
    end
    merged = {}
    p["writes"].each do |path, theirs|
      base = @trees.fetch(p["baseSha"], {})[path]
      result = merge(base, @trees[@head][path], theirs)
      return back(p, "stale: #{path}; text merge of #{path}: 1 conflicting hunk") if result == :conflict

      merged[path] = result
    end
    land(p, merged)
  end

  # Text merge as the colony runs it, for this beat's two shapes of change: lines edited in place, and lines added at the end.
  def merge(base, trunk, theirs)
    return theirs if base == trunk
    return trunk if theirs == base || theirs == trunk

    b, t, o = [base, trunk, theirs].map { |x| x.to_s.lines }
    if b.size == t.size && b.size == o.size
      changed = ->(side, i) { i >= 0 && i < b.size && side[i] != b[i] }
      return o.each_index.map { |i| changed.(o, i) ? o[i] : t[i] }.join if o.each_index.none? { |i| changed.(o, i) && (changed.(t, i - 1) || (changed.(t, i) && t[i] != o[i]) || changed.(t, i + 1)) }

      return :conflict
    end
    return (t + o[b.size..]).join if @insertions && o.first(b.size) == b && t.first(b.size) == b

    :conflict
  end

  def back(p, reason)
    p["status"] = "returned"
    p["reason"] = reason
    intent = @intents[p["intentId"]]
    intent["status"] = "open"
    intent["assignedTo"] = nil
    event("t" => "proposal", "proposalId" => p["id"], "intentId" => p["intentId"], "agentId" => p["agentId"], "status" => "returned", "reason" => reason)
    event("t" => "intent", "intentId" => intent["id"], "status" => "open", "title" => intent["title"], "footprint" => intent["footprint"])
  end

  def land(p, merged)
    parent = @head
    @head = Digest::SHA1.hexdigest("#{parent}#{p['id']}")
    @trees[@head] = @trees[parent].merge(merged)
    landing = { "id" => id("lnd"), "trunkSha" => @head, "parentSha" => parent, "proposalIds" => [p["id"]], "paths" => merged.keys, "at" => @landings.size }
    @landings << landing
    @notes[landing["id"]] = { "schema" => "firetrident.lineage/v1", "landingId" => landing["id"],
                              "proposals" => [{ "id" => p["id"], "agentId" => p["agentId"], "writeSet" => merged.map { |path, text| { "path" => path, "blob" => Stage.blob_id(text) } } }] }
    intent = @intents[p["intentId"]]
    event("t" => "proposal", "proposalId" => p["id"], "intentId" => p["intentId"], "agentId" => p["agentId"], "status" => "landed")
    event("t" => "intent", "intentId" => intent["id"], "status" => "landed", "title" => intent["title"], "footprint" => intent["footprint"])
    event("t" => "landing", "landingId" => landing["id"], "trunkSha" => @head, "proposalIds" => [p["id"]], "paths" => merged.keys)
    p["status"] = "landed"
    p["landingId"] = landing["id"]
    intent["status"] = "landed"
  end

  def preview(colony, commit, path)
    unless @public
      return json(404, { error: "colony #{colony} does not show file contents here: only colonies listed in FT_PUBLIC_GIT or FT_PUBLIC_MCP do; list it there on the deployment to preview its files" })
    end
    text = @landings.any? { |l| l["trunkSha"] == commit } ? @trees[commit][path] : nil
    return json(404, { error: "there is no file #{path} at commit #{commit[0, 7]}" }) unless text

    type = path.end_with?(".json") ? "application/json; charset=utf-8" : "text/plain; charset=utf-8"
    [200, { "Content-Type" => type, "Content-Security-Policy" => "sandbox; default-src 'none'", "X-Content-Type-Options" => "nosniff", "Cache-Control" => "public, max-age=31536000, immutable" }, text]
  end
end

class MosaicTest < Minitest::Test
  SCRIPT = File.expand_path("../mosaic.rb", __dir__)
  FAST = ["--step-timeout", "20", "--timeout", "120"].freeze

  def run_mosaic(colony, *args, token: true, access: true)
    server = FakeDeployment.new { |req| colony.call(req) }
    Dir.mktmpdir("mosaic-config") do |config|
      out, err, status = Open3.capture3(FakeDeployment.env(config, token: token, access: access), "ruby", SCRIPT, "--base", server.url, *args)
      [out, err, status.exitstatus, server.requests]
    end
  ensure
    server&.stop
  end

  def assert_in_order(out, pieces)
    at = 0
    pieces.each do |piece|
      found = out.index(piece, at)
      assert found, "expected #{piece.inspect} after position #{at} in:\n#{out}"
      at = found
    end
  end

  def assert_no_secrets(text)
    [FakeDeployment::TOKEN, FakeDeployment::ACCESS_SECRET, FakeDeployment::ACCESS_ID, "art_v1_"].each { |s| refute_includes text, s }
  end

  def tile_proposals(colony) = colony.proposals.values.reject { |p| p["writes"].key?(Mosaic::PAGE) }

  def test_the_picture_its_order_and_the_seed
    tiles = Mosaic.tiles
    assert_equal 100, tiles.map { |t| [t.r, t.c] }.uniq.size
    assert_equal 10, tiles.count(&:roll_call)
    assert_equal [9, 19, 29, 39, 49, 59, 69, 79, 89, 99], tiles.select(&:roll_call).map(&:order)
    assert_equal "Fill tile (0, 0) with night", tiles.first.title
    assert_equal [3, 7], [tiles[1].r, tiles[1].c]
    seed = Mosaic.seed
    tile = tiles.find { |t| t.r == 3 && t.c == 4 }
    filled = Mosaic.fill(seed[Mosaic::MOSAIC], tile)
    diff = seed[Mosaic::MOSAIC].lines.zip(filled.lines).reject { |a, b| a == b }
    assert_equal [[%(    {"r": 3, "c": 4, "color": null},\n), %(    {"r": 3, "c": 4, "color": "#f3a712"},\n)]], diff
    assert_equal({ [3, 4] => "#f3a712" }, Mosaic.grid(filled).compact)
    # Every tile's line has a line between it and the next, so no two tile edits touch.
    lines = seed[Mosaic::MOSAIC].lines.each_index.select { |i| seed[Mosaic::MOSAIC].lines[i].include?('"color": null') }
    assert_equal [2], lines.each_cons(2).map { |a, b| b - a }.uniq
    assert seed[Mosaic::ROLL_CALL].end_with?("\n")
    refute_includes seed[Mosaic::PAGE], "<script"
  end

  def test_twenty_agents_lay_the_picture_and_every_change_lands_by_merge
    colony = FakeMosaicColony.new
    out, err, code, reqs = run_mosaic(colony, *FAST)
    assert_equal 0, code, out + err
    assert_in_order(out, [
      "mosaic: 20 agents lay a 10 by 10 picture", "(build abc1234)", "inline changes, text merge and its insertion rule are on here",
      "created colony mosaic-", "review is off", "seeded index.html, mosaic.json, roll-call.md in lnd_", "every tile change is written against this commit",
      "the colony is public here: its files read at any landing through GET /api/colonies/mosaic-", "/preview/<commit>/<path>, sandboxed (sandbox, nosniff, cached as immutable)",
      "20 agents start laying 100 tiles", "1 of 100 tiles landed", "and signed the roll call: landed in lnd_", "every tile was handed out: 100 of 100 landed, 0 went back to the colony (",
      "mosaic.json at ", "read through the preview route: 100 of 100 tiles filled", "      0 1 2 3 4 5 6 7 8 9", "   0  N E N N E E N N E N", "   9  S S S F S S S S S F",
      "N night #22335c", "roll-call.md at ", "read through the preview route: 10 of 10 names", "- mosaic-", "returns: 0 (0 tile(s)); relanded: 0 of 0",
      "PASS 100 of 100 tiles filled, 10 of 10 names on the roll call, 0 returns; 100 tile changes landed in", "by 20 agents", "deleted colony mosaic-"
    ])
    assert_match(/^\[\s*\d+\.\ds\] /, out)
    tiles = tile_proposals(colony)
    assert_equal 100, tiles.size
    seed = Mosaic.seed
    # Every tile change is written against the seed and changes one line of mosaic.json; every tenth adds one line to the roll call.
    assert_equal 1, tiles.map { |p| p["baseSha"] }.uniq.size
    tiles.each do |p|
      changed = seed[Mosaic::MOSAIC].lines.zip(p["writes"][Mosaic::MOSAIC].lines).count { |a, b| a != b }
      assert_equal 1, changed, p["writes"][Mosaic::MOSAIC]
      assert_equal p["writes"].keys.sort, p["footprint"].sort
      assert_equal p["writes"].keys.map { |path| { "path" => path, "blob" => Stage.blob_id(seed[path]) } }, p["readSet"]
    end
    signers = tiles.select { |p| p["writes"].key?(Mosaic::ROLL_CALL) }
    assert_equal 10, signers.size
    assert_equal 20, tiles.map { |p| p["agentId"] }.uniq.size
    trunk = colony.head_tree
    assert_equal 100, Mosaic.grid(trunk[Mosaic::MOSAIC]).values.compact.size
    assert_equal 10, trunk[Mosaic::ROLL_CALL].lines.count { |l| l.start_with?("- mosaic-") }
    # Every intent was declared for its agent, and the colony was told who declared it.
    assert_equal 101, colony.intents.size
    assert(colony.intents.values.all? { |i| i["status"] == "landed" })
    # Every request carries the Access headers; the files are read back as the public reads them, with no token.
    assert reqs.all? { |r| FakeDeployment.accessed?(r) }
    previews = reqs.select { |r| r.path.include?("/preview/") }
    assert_equal 3, previews.size
    assert previews.none? { |r| r.headers.key?("authorization") }
    assert reqs.reject { |r| r.path == "/api/about" || r.path.include?("/preview/") }.all? { |r| r.headers["authorization"] == "Bearer #{FakeDeployment::TOKEN}" }
    assert_equal 1, colony.deleted.size
    assert_no_secrets(out + err)
  end

  def test_changes_that_go_back_are_relanded_by_fresh_agents
    colony = FakeMosaicColony.new(bounce: 3)
    out, err, code, = run_mosaic(colony, "--agents", "5", *FAST)
    assert_equal 0, code, out + err
    assert_in_order(out, [
      "5 agents start laying 100 tiles", "went back (mosaic-", "every tile was handed out: 97 of 100 landed, 3 went back to the colony (",
      "3 tile(s) wait in the colony (3 went back, 0 given back before their agent started); fresh agents take them and propose them",
      "mosaic-again-0", ", taken again from the colony: lnd_", "relanded: 100 of 100 tiles landed",
      "returns: 3 (3 tile(s)); relanded: 3 of 3", "this fake sends the change back once",
      "PASS 100 of 100 tiles filled, 10 of 10 names on the roll call, 3 return(s), every one relanded"
    ])
    assert(colony.agents.values.any? { |a| a["name"] == "mosaic-again-01" })
    assert_equal 103, tile_proposals(colony).size
  end

  def test_tiles_the_colony_gives_back_before_their_agent_starts_are_taken_again
    colony = FakeMosaicColony.new(give_back: 4)
    out, err, code, = run_mosaic(colony, "--agents", "5", *FAST)
    assert_equal 0, code, out + err
    assert_in_order(out, [
      "went back to the colony before mosaic-0", "(the colony said: pool empty); it waits for the relanders",
      "every tile was handed out: 96 of 100 landed, 0 went back to the colony, 4 given back before their agent started", "4 tile(s) wait in the colony (0 went back, 4 given back before their agent started)",
      "relanded: 100 of 100 tiles landed", "returns: 0 (0 tile(s)); relanded: 0 of 0; 4 tile(s) given back by the colony before their agent started, taken again by fresh agents",
      "PASS 100 of 100 tiles filled, 10 of 10 names on the roll call, 0 returns"
    ])
    assert_equal 100, tile_proposals(colony).size
    assert_equal 101, colony.intents.size
  end

  def test_without_the_insertion_rule_the_roll_call_goes_back_until_the_run_gives_up
    colony = FakeMosaicColony.new(insertions: false)
    out, err, code, = run_mosaic(colony, "--agents", "5", *FAST)
    assert_equal 1, code, out + err
    assert_includes out, "text merge of roll-call.md: 1 conflicting hunk"
    assert_match(/FAIL tile \(\d, \d\) went back 3 times; the last time: stale: roll-call.md/, out)
    assert_equal 1, colony.deleted.size
  end

  def test_a_colony_the_deployment_does_not_list_is_checked_from_its_lineage
    colony = FakeMosaicColony.new(public: false)
    out, err, code, = run_mosaic(colony, "--agents", "10", *FAST)
    assert_equal 0, code, out + err
    assert_in_order(out, [
      "the preview route does not serve colony mosaic-", "only colonies listed in FT_PUBLIC_GIT", "the picture is checked from its lineage instead",
      "checked by the blob its last landing wrote: 100 of 100 tiles filled", "   0  N E N N E E N N E N",
      "roll-call.md, checked by its size on trunk: 10 of 10 names", "PASS 100 of 100 tiles filled, 10 of 10 names"
    ])
  end

  def test_record_refuses_a_colony_whose_picture_it_cannot_read
    Dir.mktmpdir("mosaic-record") do |dir|
      colony = FakeMosaicColony.new(public: false)
      out, err, code, = run_mosaic(colony, *FAST, "--record-out", File.join(dir, "mosaic.json.gz"))
      assert_equal 1, code, out + err
      assert_includes out, "FAIL the recording would hold no picture: the preview route does not serve colony mosaic-"
      assert_includes out, "list the colony in FT_PUBLIC_GIT on the deployment, or pass --name with a colony name it lists"
      assert_equal 1, colony.intents.size
      assert_equal 1, colony.deleted.size
      refute File.exist?(File.join(dir, "mosaic.json.gz"))
    end
  end

  def test_record_writes_a_recording_with_the_picture_at_each_landing
    Dir.mktmpdir("mosaic-record") do |dir|
      file = File.join(dir, "mosaic.json.gz")
      out, err, code, = run_mosaic(FakeMosaicColony.new, "--agents", "5", "--name", "mosaic", *FAST, "--record-out", file)
      assert_equal 0, code, out + err
      assert_in_order(out, ["PASS 100 of 100 tiles filled", "recording mosaic for playback with no network", "recorded mosaic:",
                            "recorded: #{file}; once bundled, /c/mosaic?replay=1&recording=mosaic plays it with the picture", "deleted colony mosaic"])
      rec = JSON.parse(Zlib.gunzip(File.binread(file)))
      reads = rec["reads"].select { |k, _| k.include?("/preview/") }
      assert_equal 101, reads.size
      newest = rec.dig("record", "events").select { |e| e["t"] == "landing" && e["paths"].include?(Mosaic::MOSAIC) }.last
      grid = reads.fetch("/api/colonies/mosaic/preview/#{newest['trunkSha']}/mosaic.json")
      assert_equal 100, grid["tiles"].count { |t| t["color"] }
      assert_no_secrets(out + err + File.binread(file))
    end
  end

  def test_a_change_that_never_settles_times_out_saying_what_it_waited_for
    colony = FakeMosaicColony.new(settle_after: 1_000_000)
    out, err, code, = run_mosaic(colony, "--agents", "2", "--step-timeout", "1.5")
    assert_equal 3, code, out + err
    assert_match(/TIMEOUT timed out after 1\.5 s waiting for the seed agent's change prp_\d+ to land or go back \(it is ready\)/, out)
    assert_equal 1, colony.deleted.size
  end

  def test_a_deployment_without_the_insertion_rule_fails_before_creating_anything
    out, err, code, reqs = run_mosaic(FakeMosaicColony.new(flags: %w[FT_INLINE FT_TEXT_MERGE]))
    assert_equal 1, code, out + err
    assert_includes out, "FAIL FT_MERGE_INSERTIONS is off on this deployment (not in /api/about), and the roll call's added lines land together by the insertion rule"
    refute(reqs.any? { |r| r.method == "POST" })
  end

  def test_settings_problems_exit_2_before_any_request
    _, err, code, reqs = run_mosaic(FakeMosaicColony.new, token: false)
    assert_equal 2, code
    assert_includes err, "FT_TOKEN is not set"
    assert_empty reqs
    _, err, code, = run_mosaic(FakeMosaicColony.new, "--agents", "0")
    assert_equal 2, code
    assert_includes err, "--agents must be from 1 to 64"
  end
end
