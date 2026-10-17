# frozen_string_literal: true

# Tests for scripts/recipe_check.rb, run as a command against a fake colony API on 127.0.0.1 that keeps a trunk of
# texts, takes inline changes of several files, lands a rename recipe over its files, and (unless told not to) applies
# the recipe to a change built before it, as the trunk writer's commutation does.
#
#   ruby scripts/test/recipe_check_test.rb
require "minitest/autorun"
require "digest"
require "tmpdir"
require_relative "fake_deployment"
require_relative "../stage"

# The colony API the check calls, in memory.
class FakeRecipeColony
  def initialize(commute: true, flags: %w[FT_INLINE])
    @commute = commute
    @flags = flags
    @n = 0
    @lock = Mutex.new
    @created = []
    @agents = {}
    @intents = {}
    @proposals = {}
    @landings = []
    @notes = {}
    @head = Digest::SHA1.hexdigest("root")
    @trees = { @head => {} }
    @order = { @head => 0 }
    @recipe = nil
  end

  def call(req) = @lock.synchronize { route(req) }

  private

  def id(prefix) = "#{prefix}_#{@n += 1}"
  def json(status, body) = FakeDeployment.json(status, body)

  def route(req)
    m = req.path.match(%r{\A/api/colonies/([^/]+)(/.*)?\z})
    colony = m && m[1]
    rest = m && m[2].to_s
    return json(200, { service: "firetrident", commit: "abc1234", flags: @flags }) if req.path == "/api/about"
    return create(req) if req.method == "POST" && req.path == "/api/colonies"
    return json(404, { error: "no route" }) unless colony && @created.include?(colony)

    case [req.method, rest]
    in ["DELETE", ""] then json(200, { ok: true })
    in ["POST", "/decide/policy"] then json(200, { enabled: false })
    in ["POST", "/agents"]
      a = { "id" => id("agt"), "name" => req.json["name"] }
      @agents[a["id"]] = a
      json(201, a)
    in ["POST", "/intents"]
      b = req.json
      i = { "id" => id("int"), "title" => b["title"], "assignedTo" => b["assignedTo"], "revision" => 1, "status" => "open" }
      @intents[i["id"]] = i
      json(201, i)
    in ["POST", %r{\A/agents/([^/]+)/take\z}] then take(Regexp.last_match(1))
    in ["POST", "/proposals"] then propose(req.json)
    in ["GET", %r{\A/proposals/([^/]+)\z}] then poll(Regexp.last_match(1))
    in ["POST", "/recipes"] then declare(req.json)
    in ["GET", %r{\A/recipes/([^/]+)\z}] then show(Regexp.last_match(1))
    in ["GET", "/why"] then why(req.params["path"])
    else json(404, { error: "no route" })
    end
  end

  def create(req)
    @created << req.json["name"]
    json(201, { id: req.json["name"] })
  end

  def take(agent)
    intent = @intents.values.find { |i| i["assignedTo"] == agent && i["status"] == "open" }
    return json(200, { wait: true, retryInMs: 50, reason: "no open intents" }) unless intent

    intent["status"] = "claimed"
    lease = { repo: { namespace: "ft-ws-0", name: "ws-#{agent}", remote: "https://example.invalid/ws.git" }, token: "art_v1_lease#{agent}", baseSha: @head,
              trunk: { remote: "https://example.invalid/trunk.git", token: "art_v1_trunk", sha: @head } }
    json(200, { intent: intent, lease: lease })
  end

  def propose(b)
    files = b["writeSet"].to_h { |w| [w["path"], b.dig("contents", w["blob"])] }
    return json(400, { error: "contents do not hash to the write set" }) unless files.all? { |p, t| t && Stage.blob_id(t) == b["writeSet"].find { |w| w["path"] == p }["blob"] }

    p = { "id" => id("prp"), "intentId" => b["intentId"], "agentId" => b["agentId"], "status" => "checking", "baseSha" => b["baseSha"], "files" => files }
    @proposals[p["id"]] = p
    json(201, p.except("files", "baseSha"))
  end

  def poll(pid)
    p = @proposals[pid]
    settle(p) if p["status"] == "checking"
    json(200, p.except("files", "baseSha"))
  end

  def rename(text) = text.gsub(/\bX\b/, "Y")

  def settle(p)
    base = @trees.fetch(p["baseSha"])
    trunk = @trees.fetch(@head)
    stale = p["files"].keys.reject { |path| base[path] == trunk[path] }
    if stale.empty?
      land(p, p["files"], nil)
    elsif @commute && @recipe && @order[p["baseSha"]] < @recipe[:seq] && stale.all? { |path| rename(base[path].to_s) == trunk[path] }
      land(p, p["files"].transform_values { |t| rename(t) }, [{ "recipe" => @recipe[:id], "landing" => @recipe[:landing], "paths" => p["files"].keys }])
    else
      p["status"] = "returned"
      p["reason"] = "stale: #{stale.join(', ')}"
    end
  end

  def commit(files)
    parent = @head
    @head = Digest::SHA1.hexdigest("#{parent}#{files}")
    @trees[@head] = @trees[parent].merge(files)
    @order[@head] = @order.size
    { "id" => id("lnd"), "trunkSha" => @head, "parentSha" => parent, "paths" => files.keys }
  end

  def land(p, files, recipes)
    landing = commit(files)
    prop = { "id" => p["id"], "agentId" => p["agentId"], "writeSet" => files.map { |path, t| { "path" => path, "blob" => Stage.blob_id(t) } } }
    prop["recipes"] = recipes if recipes
    @landings << landing
    @notes[landing["id"]] = { "proposals" => [prop] }
    p["status"] = "landed"
    p["landingId"] = landing["id"]
  end

  def declare(b)
    renamed = @trees[@head].select { |path, t| path.start_with?("src/") && rename(t) != t }.to_h { |path, t| [path, rename(t)] }
    landing = commit(renamed)
    @landings << landing
    @notes[landing["id"]] = { "proposals" => [], "recipe" => { "id" => "rcp_1" } }
    @recipe = { id: "rcp_1", landing: landing["id"], seq: @order[@head] }
    record = { "id" => "rcp_1", "state" => "landed", "changed" => renamed.size, "examined" => @trees[@head].size, "batches" => [{ "landingId" => landing["id"] }], "args" => b["args"] }
    json(201, { intent: { id: id("int") }, recipe: record })
  end

  def show(rid)
    grep = @trees[@head].select { |_, t| t.match?(/\bX\b/) }.keys
    json(200, { record: { "id" => rid, "state" => "landed" }, residue: { examined: @trees[@head].size, rewrite: grep, untransformed: [], grep: grep } })
  end

  def why(path)
    json(200, @landings.reverse.select { |l| l["paths"].include?(path) }.map { |l| { landing: l, note: @notes[l["id"]] } })
  end
end

class RecipeCheckTest < Minitest::Test
  SCRIPT = File.expand_path("../recipe_check.rb", __dir__)

  def run_check(colony, *args)
    server = FakeDeployment.new { |req| colony.call(req) }
    Dir.mktmpdir("recipe-config") do |config|
      out, err, status = Open3.capture3(FakeDeployment.env(config), "ruby", SCRIPT, "--base", server.url, "--step-timeout", "20", *args)
      [out, err, status.exitstatus]
    end
  ensure
    server&.stop
  end

  def test_passes_when_every_change_lands_and_no_x_is_left
    out, err, code = run_check(FakeRecipeColony.new, "--agents", "6")
    assert_equal 0, code, out + err
    assert_includes out, "agent changes landed:          6 of 6"
    assert_includes out, "agent changes came back:       0"
    assert_includes out, "late changes with the recipe:  3 of 3"
    assert_includes out, "trunk files naming X (grep, as a word): 0"
    assert_includes out, "PASS 6 of 6 agent changes landed, 0 came back, and trunk names X nowhere"
    [FakeDeployment::TOKEN, FakeDeployment::ACCESS_SECRET, "art_v1_"].each { |s| refute_includes out, s }
  end

  def test_fails_when_changes_built_before_the_rename_come_back
    out, err, code = run_check(FakeRecipeColony.new(commute: false), "--agents", "4")
    assert_equal 1, code, out + err
    assert_includes out, "agent changes came back:       2"
    assert_match(/FAIL 2 agent changes did not land; 2 changes came back\n/, out)
    assert_includes out, "agent 3's change prp_19 returned: stale: src/use_3.ts"
  end

  def test_refuses_without_inline_changes
    out, _err, code = run_check(FakeRecipeColony.new(flags: []))
    assert_equal 1, code
    assert_match(/inline changes are off/, out)
  end
end
