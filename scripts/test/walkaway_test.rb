# frozen_string_literal: true

# Tests for scripts/walkaway.rb, run as a command against a fake deployment on 127.0.0.1: a colony API that keeps a trunk
# of texts and takes inline changes, an MCP endpoint with sessions (answers as event streams, DELETE ends a session), and
# a reaper that takes the walker's intent back once its session is gone, with the closure ledger's cause, the gap and a
# failure mark.
#
#   ruby scripts/test/walkaway_test.rb
require "minitest/autorun"
require "digest"
require "fileutils"
require "tmpdir"
require "zlib"
require_relative "fake_deployment"
require_relative "../stage"
require_relative "../walkaway"

# The deployment the walk-away beat calls, in memory.
class FakeWalkColony
  MCP_TOKEN = "test-mcp-token-ghijkl"
  RESUME_KEY = "resume-key-secret-0123456789abcdef"

  attr_reader :calls, :created

  # `reap`: whether the reaper ever takes the intent back; `mark`: whether it leaves a failure mark; `ttl_route`: whether
  # the deployment has POST /silent-ttl; `mcp_refuses`: whether /mcp answers 401.
  def initialize(reap: true, mark: true, ttl_route: true, mcp_refuses: false)
    @reap = reap
    @mark = mark
    @ttl_route = ttl_route
    @mcp_refuses = mcp_refuses
    @n = 0
    @lock = Mutex.new
    @created = []
    @calls = []
    @agents = {}
    @intents = {}
    @closures = Hash.new { |h, k| h[k] = [] }
    @proposals = {}
    @events = []
    @sessions = {}
    @failure = 0
    @ttl = nil
    @killed = nil
    @takes_since_kill = 0
    @head = Digest::SHA1.hexdigest("root")
    @trees = { @head => {} }
  end

  def call(req) = @lock.synchronize { route(req) }

  private

  def id(prefix) = "#{prefix}_#{@n += 1}"
  def json(status, body, headers = {}) = FakeDeployment.json(status, body, headers)
  def now = 1_800_000_000_000 + (@n * 1000)

  def route(req)
    @calls << "#{req.method} #{req.path}"
    return mcp(req) if req.path == "/mcp"
    return json(200, { service: "firetrident", commit: "abc1234", flags: %w[FT_INLINE] }) if req.path == "/api/about"
    return create(req) if req.method == "POST" && req.path == "/api/colonies"

    m = req.path.match(%r{\A/api/colonies/([^/]+)(/.*)?\z})
    colony = m && m[1]
    rest = m && m[2].to_s
    return json(404, { error: "no route for #{req.method} #{req.path}" }) unless colony && @created.include?(colony)

    case [req.method, rest]
    in ["GET", ""] then json(200, { colony: { id: colony, name: colony, trunkSha: @head, regionDepth: 1, createdAt: 0 }, files: [{ path: Walkaway::PATH, size: 10 }], intents: @intents.values, agents: @agents.values })
    in ["DELETE", ""] then json(200, { ok: true })
    in ["POST", "/decide/policy"] then json(200, { enabled: req.json["enabled"] })
    in ["POST", "/silent-ttl"]
      return json(404, { error: "no route for POST #{req.path}" }) unless @ttl_route

      @ttl = req.json["seconds"]
      json(200, { colonyId: colony, ms: @ttl * 1000, seconds: @ttl, default: false, inPlatformMs: 600_000, setBy: req.json["by"], note: "An agent outside the platform silent for #{@ttl} s loses its claimed intents." })
    in ["POST", "/agents"] then json(201, register(req.json["name"], req.json["kind"]))
    in ["POST", "/intents"]
      b = req.json
      i = { "id" => id("int"), "title" => b["title"], "why" => b["why"], "footprint" => b["footprint"], "assignedTo" => b["assignedTo"], "revision" => 1, "status" => "claimed" }
      @intents[i["id"]] = i
      event(i, "claimed")
      json(201, i)
    in ["POST", %r{\A/agents/([^/]+)/take\z}] then json(200, take(Regexp.last_match(1)))
    in ["POST", "/proposals"] then propose(req.json)
    in ["GET", %r{\A/proposals/([^/]+)\z}] then poll(Regexp.last_match(1))
    in ["GET", %r{\A/intents/([^/]+)\z}]
      i = @intents[Regexp.last_match(1)]
      i ? json(200, { intent: i, revisions: [], directives: [], escalations: [], closures: @closures[i["id"]].reverse }) : json(404, { error: "unknown intent" })
    in ["GET", "/field"] then json(200, [{ region: req.params["region"], byPath: { Walkaway::PATH => { need: 1, failure: @failure }.reject { |_, v| v.zero? } } }])
    in ["GET", "/events"] then json(200, { colonyId: colony, source: "recorded", events: @events, next: nil, total: @events.size, first: 1, last: @events.size })
    in ["GET", "/metrics"] then json(200, { colonyId: colony, closures: shares })
    in ["GET", "/agents"] then json(200, { agents: @agents.values })
    else json(404, { error: "no route for #{req.method} #{req.path}" })
    end
  end

  def create(req)
    name = req.json["name"]
    return json(409, { error: "colony #{name} already exists" }) if @created.include?(name)

    @created << name
    json(201, { id: name, name: name, trunkSha: @head })
  end

  def register(name, kind)
    a = { "id" => id("agt"), "name" => name, "kind" => kind, "model" => "scripted" }
    @agents[a["id"]] = a
    a
  end

  def event(intent, status, closure = nil)
    @events << { "seq" => @events.size + 1, "t" => "intent", "at" => now, "intentId" => intent["id"], "status" => status, "title" => intent["title"], "footprint" => intent["footprint"] }.merge(closure ? closure.slice("cause", "agentId", "agentKind", "gapMs") : {})
  end

  def close(intent, cause, status, agent, gap)
    c = { "cause" => cause, "at" => now, "status" => status, "agentId" => agent, "agentKind" => @agents.dig(agent, "kind"), "gapMs" => gap }
    @closures[intent["id"]] << c
    intent["closure"] = c
    event(intent, status, c)
  end

  def lease(agent)
    { repo: { namespace: "ft-ws-0", name: "ws-#{agent}", remote: "https://example.invalid/git/ws.git" }, token: "art_v1_leasetoken#{agent}", tokenExpiresAt: 0,
      baseSha: @head, leasedAt: 0, trunk: { remote: "https://example.invalid/git/trunk.git", token: "art_v1_trunktoken", sha: @head } }
  end

  # An agent's take: its assigned intent; the second agent's takes drive the reaper once the walker's session is gone.
  def take(agent)
    held = @intents.values.find { |i| i["assignedTo"] == agent && i["status"] == "claimed" }
    return { intent: held, lease: lease(agent) } if held

    walker = @agents.values.find { |a| a["name"] == "walkaway-walker" }
    walked = walker && @intents.values.find { |i| i["assignedTo"] == walker["id"] && i["status"] == "claimed" }
    if walked && @reap && (@killed || walker["kind"] == "external" && @agents.values.any? { |a| a["name"] == "walkaway-second" })
      @takes_since_kill += 1
      if @takes_since_kill >= 3
        walked["status"] = "open"
        walked["assignedTo"] = nil
        close(walked, "reaped_silent", "open", walker["id"], (@ttl * 1000) + 4_000)
        @failure = 0.5 if @mark
      end
    end
    open = @intents.values.find { |i| i["status"] == "open" }
    return { wait: true, retryInMs: 50, reason: "no open intents" } unless open

    open["status"] = "claimed"
    open["assignedTo"] = agent
    event(open, "claimed")
    { intent: open, lease: lease(agent) }
  end

  def propose(b)
    blob = b["writeSet"][0]["blob"]
    text = b.dig("contents", blob)
    return json(400, { error: "contents do not hash to the write set's blob" }) unless text && Stage.blob_id(text) == blob

    p = { "id" => id("prp"), "intentId" => b["intentId"], "agentId" => b["agentId"], "status" => "checking", "text" => text }
    @proposals[p["id"]] = p
    json(201, p.except("text"))
  end

  def poll(pid)
    p = @proposals[pid]
    return json(404, { error: "proposal not found" }) unless p

    if p["status"] == "checking"
      parent = @head
      @head = Digest::SHA1.hexdigest("#{parent}#{p['text']}")
      @trees[@head] = @trees[parent].merge(Walkaway::PATH => p["text"])
      p["status"] = "landed"
      p["landingId"] = id("lnd")
      intent = @intents[p["intentId"]]
      intent["status"] = "landed"
      close(intent, "landed", "landed", p["agentId"], 1_000)
      @events << { "seq" => @events.size + 1, "t" => "landing", "at" => now, "landingId" => p["landingId"], "trunkSha" => @head, "proposalIds" => [p["id"]], "paths" => [Walkaway::PATH] }
    end
    json(200, p.except("text"))
  end

  def shares
    counts = Hash.new { |h, k| h[k] = Hash.new(0) }
    @closures.each_value { |list| list.each { |c| counts[c["agentKind"]][c["cause"]] += 1 } }
    by_kind = counts.to_h do |kind, by|
      total = by.values.sum
      [kind, { total: total, counts: by, shares: by.transform_values { |n| (n.to_f / total).round(4) } }]
    end
    gaps = @closures.values.flatten.select { |c| c["cause"] == "reaped_silent" }.map { |c| c["gapMs"] }
    { total: counts.values.sum { |by| by.values.sum }, byKind: by_kind, reaped: { count: gaps.size, medianGapMs: gaps.first, maxGapMs: gaps.max },
      silentTtlMs: (@ttl || 600) * 1000, silentTtlDefault: @ttl.nil? }
  end

  # The MCP endpoint with sessions: each answer as an event stream, a notification 202, DELETE the end of a session.
  def mcp(req)
    return json(401, { error: "unauthorized: send the MCP token" }) if @mcp_refuses || req.headers["authorization"] != "Bearer #{MCP_TOKEN}"
    return @sessions.key?(req.headers["mcp-session-id"]) ? end_session(req.headers["mcp-session-id"]) : json(404, { error: "no session" }) if req.method == "DELETE"

    m = req.json
    return [202, {}, ""] unless m.key?("id")

    sid = req.headers["mcp-session-id"]
    if m["method"] == "initialize"
      sid = "sess-#{@n += 1}"
      @sessions[sid] = {}
      return stream(m["id"], { protocolVersion: m.dig("params", "protocolVersion"), capabilities: { tools: {} }, serverInfo: { name: "firetrident", version: "0.0.1" } }, sid)
    end
    return json(404, { jsonrpc: "2.0", id: m["id"], error: { code: -32_001, message: "Session not found" } }) unless @sessions.key?(sid)

    args = m.dig("params", "arguments") || {}
    @calls << "MCP #{m.dig('params', 'name')}"
    case m.dig("params", "name")
    when "join"
      a = register(args["name"], "external")
      @sessions[sid][:agent] = a["id"]
      tool(m["id"], sid, { agentId: a["id"], resumeKey: RESUME_KEY, resumed: false, colony: { id: args["colony"] } })
    when "take"
      t = take(@sessions[sid][:agent])
      return tool(m["id"], sid, t) unless t[:intent]

      tool(m["id"], sid, { intent: t[:intent].slice("id", "title", "footprint"), lease: { baseSha: t[:lease][:baseSha] }, tokens: { trunkRead: "art_v1_mcptrunk", workspaceWrite: "art_v1_mcpwrite" } })
    else tool(m["id"], sid, { kind: "validation", message: "unknown tool" }, error: true)
    end
  end

  def end_session(sid)
    @sessions.delete(sid)
    @killed = true
    [200, {}, ""]
  end

  def tool(id, sid, data, error: false) = stream(id, { content: [{ type: "text", text: JSON.generate(data) }], **(error ? { isError: true } : {}) }, sid)

  def stream(id, result, sid)
    [200, { "Content-Type" => "text/event-stream", "Mcp-Session-Id" => sid }, "event: message\ndata: #{JSON.generate({ jsonrpc: '2.0', id: id, result: result })}\n\n"]
  end
end

class WalkawayTest < Minitest::Test
  SCRIPT = File.expand_path("../walkaway.rb", __dir__)
  FAST = ["--poll", "0.05", "--step-timeout", "10"].freeze

  def run_walk(colony, *args, token: true, access: true, mcp: true, env: {})
    server = FakeDeployment.new { |req| colony.call(req) }
    Dir.mktmpdir("walk-config") do |config|
      e = FakeDeployment.env(config, token: token, access: access).merge("FT_MCP_TOKEN" => mcp ? FakeWalkColony::MCP_TOKEN : nil).merge(env)
      out, err, status = Open3.capture3(e, "ruby", SCRIPT, "--base", server.url, *args)
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
    [FakeDeployment::TOKEN, FakeDeployment::ACCESS_SECRET, FakeDeployment::ACCESS_ID, FakeWalkColony::MCP_TOKEN, FakeWalkColony::RESUME_KEY, "art_v1_"].each { |s| refute_includes text, s }
  end

  def test_the_walker_dies_the_reaper_takes_its_intent_back_and_the_second_agent_lands_it
    colony = FakeWalkColony.new
    out, err, code, reqs = run_walk(colony, *FAST)
    assert_equal 0, code, out + err
    assert_in_order(out, [
      "walk-away: an outside agent takes work and dies without a word; the colony takes it back and another agent lands it, on http://127.0.0.1:",
      "(build abc1234)", "created colony walkaway-", "review is off, and an agent outside the platform silent for 90 s loses its intents",
      "seeded src/values.ts, 12 lines, in lnd_", "the walker joined walkaway-", "over MCP (server firetrident) as agt_",
      "the walker (agt_", ", an outside agent over MCP) took int_", " \"Set v2 to 20 in src/values.ts\" on trunk ",
      "killed the walker: its MCP session ended (HTTP 200), and it never called release",
      "the colony took int_", "back from the walker, silent 1 min 34 s (limit 90 s): cause reaped_silent, a failure mark of 0.50 on src/values.ts",
      "the second agent (agt_", "was handed int_", "and its take says why: reaped_silent, the walker silent 1 min 34 s",
      "the second agent changed line 2: landed in lnd_", "closures of int_", "newest first", "landed", "the second agent", "reaped_silent", "the walker", "external",
      "closure shares in walkaway-", "external", "reaped_silent 1 (100%)", "silent-agent limit 90 s; 1 taken back from silent agents, median gap 1 min 34 s",
      "PASS the walker's intent came back to the colony 1 min 34 s after its last call, with a failure mark, and the second agent landed it in lnd_",
      "deleted colony walkaway-"
    ])
    assert_match(/^\[\s*\d+\.\ds\] /, out)
    # The walker never released: its session ended, and nothing else.
    calls = colony.calls
    refute(calls.any? { |c| c.include?("release") || c.include?("abandon") })
    assert_includes calls, "MCP join"
    assert_includes calls, "MCP take"
    assert(reqs.any? { |r| r.method == "DELETE" && r.path == "/mcp" })
    ttl = reqs.find { |r| r.path.end_with?("/silent-ttl") }
    assert_equal({ "seconds" => 90, "by" => "stage-test" }, ttl.json)
    # Every request carries the Access headers; MCP its own token, the API the admin token.
    assert reqs.all? { |r| FakeDeployment.accessed?(r) }
    assert reqs.select { |r| r.path == "/mcp" }.all? { |r| r.headers["authorization"] == "Bearer #{FakeWalkColony::MCP_TOKEN}" }
    assert reqs.reject { |r| ["/api/about", "/mcp"].include?(r.path) }.all? { |r| r.headers["authorization"] == "Bearer #{FakeDeployment::TOKEN}" }
    assert(reqs.any? { |r| r.method == "DELETE" && r.path.start_with?("/api/colonies/walkaway-") })
    assert_no_secrets(out + err)
  end

  def test_record_writes_a_recording_that_holds_the_reapers_cause
    Dir.mktmpdir("walk-record") do |dir|
      file = File.join(dir, "walkaway.json.gz")
      out, err, code, = run_walk(FakeWalkColony.new, *FAST, "--record-out", file)
      assert_equal 0, code, out + err
      assert_in_order(out, ["PASS the walker's intent came back", "recording walkaway-", "recorded walkaway-", "recorded: #{file}; once bundled, /c/walkaway-", "?replay=1&recording=walkaway", "deleted colony walkaway-"])
      rec = JSON.parse(Zlib.gunzip(File.binread(file)))
      reaped = rec.dig("record", "events").find { |e| e["t"] == "intent" && e["cause"] == "reaped_silent" }
      assert_equal 94_000, reaped["gapMs"]
      assert_equal "external", reaped["agentKind"]
      assert_no_secrets(out + err + File.binread(file))
    end
  end

  def test_the_walker_over_rest_needs_no_mcp
    colony = FakeWalkColony.new
    out, err, code, reqs = run_walk(colony, *FAST, "--via", "rest", mcp: false)
    assert_equal 0, code, out + err
    assert_includes out, "an outside agent over the REST API) took int_"
    assert_includes out, "killed the walker: it stops calling, and it never called release"
    assert_includes out, "PASS the walker's intent came back"
    refute(reqs.any? { |r| r.path == "/mcp" })
  end

  def test_a_reaper_that_leaves_no_failure_mark_fails_the_beat_and_deletes_the_colony
    out, err, code, reqs = run_walk(FakeWalkColony.new(mark: false), *FAST)
    assert_equal 1, code, out + err
    assert_includes out, "FAIL no failure mark on src/values.ts after the reaper took the intent back"
    assert(reqs.any? { |r| r.method == "DELETE" && r.path.start_with?("/api/colonies/") })
  end

  def test_a_reaper_that_never_comes_times_out_saying_what_it_waited_for
    out, err, code, reqs = run_walk(FakeWalkColony.new(reap: false), *FAST, "--reap-timeout", "0.6")
    assert_equal 3, code, out + err
    assert_match(/TIMEOUT timed out after 0\.6 s waiting for the colony to take int_\d+ back from the silent walker \(limit 90 s\)/, out)
    assert(reqs.any? { |r| r.method == "DELETE" && r.path.start_with?("/api/colonies/") })
  end

  def test_an_mcp_endpoint_that_refuses_says_what_to_do
    out, err, code, reqs = run_walk(FakeWalkColony.new(mcp_refuses: true), *FAST)
    assert_equal 1, code, out + err
    assert_includes out, "FAIL the MCP endpoint refused the walker (the MCP endpoint answered HTTP 401 to initialize): set FT_MCP_TOKEN to the deployment's MCP token, or pass --via rest"
    assert(reqs.any? { |r| r.method == "DELETE" && r.path.start_with?("/api/colonies/") })
  end

  def test_a_deployment_without_the_silent_agent_limit_fails_before_any_agent
    out, err, code, reqs = run_walk(FakeWalkColony.new(ttl_route: false), *FAST)
    assert_equal 1, code, out + err
    assert_includes out, "FAIL this deployment has no silent-agent limit to set (POST /silent-ttl: HTTP 404"
    refute(reqs.any? { |r| r.path.end_with?("/agents") })
  end

  def test_settings_problems_exit_2_before_any_request
    _, err, code, reqs = run_walk(FakeWalkColony.new, token: false)
    assert_equal 2, code
    assert_includes err, "FT_TOKEN is not set"
    assert_empty reqs
    _, err, code, reqs = run_walk(FakeWalkColony.new, "--ttl", "30")
    assert_equal 2, code
    assert_includes err, "--ttl must be from 60 to 86400 seconds"
    assert_empty reqs
  end

  # The config file's MCP token goes only to the deployment the file names, as the admin token does.
  def test_the_mcp_token_from_the_config_file_is_used_only_for_its_own_deployment
    Dir.mktmpdir("walk-config") do |dir|
      FileUtils.mkdir_p(File.join(dir, "firetrident"))
      File.write(File.join(dir, "firetrident", "env"), "FT_URL=https://staging.example.invalid\nFT_MCP_TOKEN=from-file-mcp\n")
      env = { "XDG_CONFIG_HOME" => dir }
      assert_equal "from-file-mcp", Walkaway.mcp_token("https://staging.example.invalid", env)
      assert_nil Walkaway.mcp_token("https://firetrident.com", env)
      assert_equal "env-mcp", Walkaway.mcp_token("https://firetrident.com", env.merge("FT_MCP_TOKEN" => "env-mcp"))
    end
  end
end
