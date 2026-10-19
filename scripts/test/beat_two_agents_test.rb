# frozen_string_literal: true

# Tests for scripts/beat_two_agents.rb, run as a command against a fake colony API on 127.0.0.1 that keeps a trunk of
# texts, takes inline changes, merges a stale one line by line as text merge does (or sends it back naming the
# conflicting hunk, or, when it read the file before trunk moved, the edit it repeats from trunk), closes one whose text
# trunk already holds as already on trunk when asked to (FT_ALREADY_ON_TRUNK) and its read is current, lands two
# appends to the file as their union when insertion merges are on (FT_MERGE_INSERTIONS) and the change's repeats
# nothing of trunk's, reopens a returned change's intent for its agent's redo, and answers why per line with the line's
# writer first. `merge_repeats` stands in for a platform that merged a repeated edit from a stale read once.
#
#   ruby scripts/test/beat_two_agents_test.rb
require "minitest/autorun"
require "digest"
require "fileutils"
require "tmpdir"
require_relative "fake_deployment"
require_relative "../stage"

# The colony API the beat calls, in memory.
class FakeColony
  attr_reader :created

  def initialize(flags: %w[FT_INLINE FT_RESOLVER FT_TEXT_MERGE], text_merge: true, settle_after: 0, settle_limit: nil, leak: false, on_trunk: false, merge_repeats: false)
    @flags = flags
    @merge_repeats = merge_repeats
    @text_merge = text_merge
    @on_trunk = on_trunk
    @settle_after = settle_after
    @settle_limit = settle_limit
    @leak = leak
    @n = 0
    @lock = Mutex.new
    @created = []
    @agents = {}
    @intents = {}
    @proposals = {}
    @polls = Hash.new(0)
    @took = Hash.new(0)
    @landings = []
    @notes = {}
    root = Digest::SHA1.hexdigest("root")
    @head = root
    @trees = { root => {} }
    @settled = 0
  end

  def call(req) = @lock.synchronize { route(req) }

  private

  def id(prefix) = "#{prefix}_#{@n += 1}"
  def json(status, body) = FakeDeployment.json(status, body)

  def route(req)
    m = req.path.match(%r{\A/api/colonies/([^/]+)(/.*)?\z})
    colony = m && m[1]
    rest = m && m[2].to_s
    return json(200, { service: "firetrident", commit: "abc1234", flags: @flags, noteKey: nil }) if req.path == "/api/about"
    return create(req) if req.method == "POST" && req.path == "/api/colonies"
    return json(404, { error: "no route for #{req.method} #{req.path}" }) unless colony && @created.include?(colony)

    case [req.method, rest]
    in ["GET", ""] then json(200, { colony: { id: colony, trunkSha: @head } })
    in ["DELETE", ""] then json(200, { ok: true })
    in ["POST", "/decide/policy"] then json(200, { enabled: req.json["enabled"] })
    in ["POST", "/agents"]
      a = { "id" => id("agt"), "name" => req.json["name"], "kind" => req.json["kind"], "model" => req.json["model"] }
      @agents[a["id"]] = a
      json(201, a)
    in ["POST", "/intents"]
      b = req.json
      i = { "id" => id("int"), "title" => b["title"], "why" => b["why"], "footprint" => b["footprint"], "assignedTo" => b["assignedTo"], "revision" => 1, "status" => "open" }
      @intents[i["id"]] = i
      json(201, i)
    in ["POST", %r{\A/agents/([^/]+)/take\z}] then take(Regexp.last_match(1))
    in ["POST", "/proposals"] then propose(req.json)
    in ["GET", %r{\A/proposals/([^/]+)\z}] then poll(Regexp.last_match(1))
    in ["GET", "/why"] then why(req.params["path"], req.params["line"].to_i)
    in ["GET", %r{\A/intents/([^/]+)\z}] then json(200, { intent: @intents[Regexp.last_match(1)] })
    else json(404, { error: "no route" })
    end
  end

  def create(req)
    name = req.json["name"]
    return json(409, { error: "colony #{name} already exists" }) if @created.include?(name)

    @created << name
    json(201, { id: name, name: name, trunkSha: @head })
  end

  # The first take of each agent waits, as a new colony's pool does while it forks.
  def take(agent)
    @took[agent] += 1
    reason = @leak ? "pool busy (lease art_v1_leakedtoken99 for #{FakeDeployment::ACCESS_SECRET})" : "the workspace pool is forking"
    return json(200, { wait: true, retryInMs: 50, reason: reason }) if @took[agent] == 1 || @leak

    intent = @intents.values.find { |i| i["assignedTo"] == agent && i["status"] == "open" }
    return json(200, { wait: true, retryInMs: 50, reason: "no open intents" }) unless intent

    intent["status"] = "claimed"
    lease = { repo: { namespace: "ft-ws-0", name: "ws-#{agent}", remote: "https://example.invalid/git/ws.git" }, token: "art_v1_leasetoken#{agent}",
              tokenExpiresAt: 0, baseSha: @head, leasedAt: 0, trunk: { remote: "https://example.invalid/git/trunk.git", token: "art_v1_trunktoken", sha: @head } }
    json(200, { intent: intent, lease: lease })
  end

  def propose(b)
    blob = b["writeSet"][0]["blob"]
    text = b.dig("contents", blob)
    return json(400, { error: "contents do not hash to the write set's blob" }) unless text && Stage.blob_id(text) == blob
    return json(400, { error: "headSha is not the changeset id" }) unless b["headSha"] == Stage.changeset_id(b["baseSha"], b["writeSet"].map { |w| { path: w["path"], blob: w["blob"] } })

    p = { "id" => id("prp"), "intentId" => b["intentId"], "agentId" => b["agentId"], "status" => "checking", "baseSha" => b["baseSha"],
          "path" => b["writeSet"][0]["path"], "text" => text, "readSet" => b["readSet"] }
    @proposals[p["id"]] = p
    json(201, view(p))
  end

  def view(p) = p.except("text", "path", "baseSha")

  def poll(pid)
    p = @proposals[pid]
    return json(404, { error: "proposal not found" }) unless p

    @polls[pid] += 1
    settle(p) if p["status"] == "checking" && @polls[pid] > @settle_after && (@settle_limit.nil? || @settled < @settle_limit)
    json(200, view(p))
  end

  def settle(p)
    @settled += 1
    path = p["path"]
    base = @trees.fetch(p["baseSha"])[path]
    trunk = @trees.fetch(@head)[path]
    blob = ->(t) { t ? Stage.blob_id(t) : "0" * 40 }
    # It read the file at a version trunk has moved past: an edit it repeats from trunk is never merged once.
    read = Array(p["readSet"]).find { |r| r["path"] == path }
    stale_read = !read.nil? && read["blob"] != blob.(trunk) && !@merge_repeats
    return already(p, path) if @on_trunk && p["text"] == trunk && !stale_read
    return land(p, p["text"], nil) if base == trunk

    stale = "stale: #{path} (expected #{blob.(base)}, trunk has #{blob.(trunk)})"
    repeat = ->(line) { back(p, "#{stale}; text merge stopped: this change repeats an edit trunk made after it read the file (#{path} at line #{line} of its base)") }
    return back(p, stale) unless @text_merge
    return union(p, base, trunk, stale_read ? repeat : nil) if @flags.include?("FT_MERGE_INSERTIONS") && appended?(base, trunk) && appended?(base, p["text"])

    b, t, o = [base, trunk, p["text"]].map(&:lines)
    conflict = nil
    repeated = nil
    merged = b.each_index.map do |i|
      if o[i] == b[i] then t[i]
      elsif t[i] == b[i] then o[i]
      elsif t[i] == o[i]
        repeated ||= i + 1
        o[i]
      else
        conflict ||= i + 1
        o[i]
      end
    end.join
    return repeat.(repeated) if repeated && stale_read
    return back(p, "#{stale}; text merge of #{path}: 1 conflicting hunk, at line #{conflict} of its base", [{ path: path, base: blob.(base), trunk: blob.(trunk), theirs: blob.(p["text"]), lines: [conflict] }]) if conflict

    land(p, merged, { "path" => path, "base" => blob.(base), "trunk" => blob.(trunk), "theirs" => blob.(p["text"]), "result" => blob.(merged) })
  end

  def appended?(base, text) = text.length > base.length && text.start_with?(base)

  # The insertion rule for two appends: trunk's append, then the change's past what trunk's already holds; a change that
  # read the file before trunk's append (`repeat`) goes back instead of having what trunk's holds left out.
  def union(p, base, trunk, repeat)
    ours = trunk[base.length..]
    theirs = p["text"][base.length..]
    return repeat.(base.lines.length + 1) if repeat && theirs.start_with?(ours)

    merged = base + ours + (theirs.start_with?(ours) ? theirs[ours.length..] : theirs)
    blob = ->(t) { Stage.blob_id(t) }
    land(p, merged, { "path" => p["path"], "base" => blob.(base), "trunk" => blob.(trunk), "theirs" => blob.(p["text"]), "result" => blob.(merged), "rule" => "insertions" })
  end

  # Already on trunk (FT_ALREADY_ON_TRUNK): no landing and no return; the source is the landing that last changed the file.
  def already(p, path)
    last = @landings.reverse.find { |l| l["paths"].include?(path) }
    writer = @notes[last["id"]]["proposals"].first
    p["status"] = "already_on_trunk"
    p["onTrunk"] = { "trunkSha" => last["trunkSha"], "landingId" => last["id"], "proposalId" => writer["id"], "agentId" => writer["agentId"] }
    p["reason"] = "Your change is already on trunk: what it writes is there already, landed by agent #{writer['agentId']} in #{last['id']} (commit #{last['trunkSha'][0, 7]}). " \
                  "Nothing landed for it and it was not sent back, so there is nothing to redo: take your next intent."
    intent = @intents[p["intentId"]]
    intent["status"] = "landed"
    intent["closure"] = { "cause" => "already_on_trunk", "status" => "landed", "agentId" => p["agentId"], "onTrunk" => p["onTrunk"] }
  end

  # A return: the proposal goes back, and its intent is open again for its agent to take and redo.
  def back(p, reason, conflicts = nil)
    p["status"] = "returned"
    p["reason"] = reason
    p["mergeConflicts"] = conflicts if conflicts
    @intents[p["intentId"]]["status"] = "open"
  end

  def land(p, text, merged)
    parent = @head
    @head = Digest::SHA1.hexdigest("#{parent}#{text}")
    @trees[@head] = @trees[parent].merge(p["path"] => text)
    landing = { "id" => id("lnd"), "trunkSha" => @head, "parentSha" => parent, "proposalIds" => [p["id"]], "paths" => [p["path"]], "at" => 0 }
    landing["merged"] = [{ "proposalId" => p["id"], "path" => p["path"], "blob" => merged["result"] }] if merged
    intent = @intents[p["intentId"]]
    prop = { "id" => p["id"], "agentId" => p["agentId"], "agentKind" => "synthetic", "model" => "scripted",
             "intent" => { "id" => intent["id"], "title" => intent["title"], "why" => intent["why"] },
             "writeSet" => [{ "path" => p["path"], "blob" => Stage.blob_id(text) }], "readSet" => p["readSet"], "decisions" => [], "evidence" => { "checks" => [] } }
    prop["merged"] = [merged] if merged
    @landings << landing
    @notes[landing["id"]] = { "schema" => "firetrident.lineage/v1", "landingId" => landing["id"], "proposals" => [prop] }
    p["status"] = "landed"
    p["landingId"] = landing["id"]
  end

  # The landings that changed `path`, newest first, with the one that last changed `line` moved to the front.
  def why(path, line)
    entries = @landings.reverse.select { |l| l["paths"].include?(path) }.map { |l| { landing: l, note: @notes[l["id"]] } }
    owner = entries.find do |e|
      after = @trees[e[:landing]["trunkSha"]][path].to_s.lines[line - 1]
      before = @trees[e[:landing]["parentSha"]][path].to_s.lines[line - 1]
      after != before
    end
    json(200, owner ? [owner, *(entries - [owner])] : entries)
  end
end

class BeatTwoAgentsTest < Minitest::Test
  SCRIPT = File.expand_path("../beat_two_agents.rb", __dir__)

  def run_beat(colony, *args, token: true, access: true, env: {})
    server = FakeDeployment.new { |req| colony.call(req) }
    Dir.mktmpdir("beat-config") do |config|
      out, err, status = Open3.capture3(FakeDeployment.env(config, token: token, access: access).merge(env), "ruby", SCRIPT, "--base", server.url, *args)
      [out, err, status.exitstatus, server.requests]
    end
  ensure
    server&.stop
  end

  def assert_no_secrets(text)
    [FakeDeployment::TOKEN, FakeDeployment::ACCESS_SECRET, FakeDeployment::ACCESS_ID, "art_v1_"].each { |s| refute_includes text, s }
  end

  def test_both_changes_land_the_second_as_a_line_by_line_merge
    out, err, code, reqs = run_beat(FakeColony.new)
    assert_equal 0, code, out + err
    order = ["beat: two agents edit one file; text merge lands both", "text merge (FT_TEXT_MERGE) and inline changes (FT_INLINE) are on here",
             "created colony beat-", "review is off", "seeded src/values.ts, 12 lines, in lnd_", "agents A (agt_", ") and B (agt_", ") each hold an intent on src/values.ts and took work from the same trunk",
             "agent A changed line 2: landed in lnd_", "agent B changed line 11 on ", ", the trunk before A landed: landed in lnd_", "landings", "src/values.ts after both landings",
             "    2  export const v2 = 20;", "<- agent A", "   11  export const v11 = 110;", "<- agent B", "$ ft why beat-", "src/values.ts:2", "src/values.ts:11",
             "merged   line by line: base ", "PASS both changes landed; agent B's as a line-by-line merge that holds both edits", "deleted colony beat-"]
    at = 0
    order.each do |piece|
      found = out.index(piece, at)
      assert found, "expected #{piece.inspect} after position #{at} in:\n#{out}"
      at = found
    end
    assert_match(/^\[\s*\d+\.\ds\] /, out)
    # Every request carries the Access headers; every API call but /api/about the admin token.
    assert reqs.all? { |r| FakeDeployment.accessed?(r) }
    assert reqs.reject { |r| r.path == "/api/about" }.all? { |r| r.headers["authorization"] == "Bearer #{FakeDeployment::TOKEN}" }
    assert_nil reqs.find { |r| r.path == "/api/about" }.headers["authorization"]
    calls = reqs.map { |r| "#{r.method} #{r.path.sub(%r{/(agt|int|prp)_\d+}, '/\1')}" }.reject { |c| c.include?("/proposals/prp") || c.end_with?("/take") }
    colony = reqs.find { |r| r.method == "POST" && r.path == "/api/colonies" }.json["name"]
    c = "/api/colonies/#{colony}"
    assert_equal ["GET /api/about", "POST /api/colonies", "POST #{c}/decide/policy", "POST #{c}/agents", "POST #{c}/intents", "POST #{c}/proposals",
                  "POST #{c}/agents", "POST #{c}/agents", "POST #{c}/intents", "POST #{c}/intents", "POST #{c}/proposals", "POST #{c}/proposals",
                  "GET #{c}/why", "GET #{c}/why", "DELETE #{c}"], calls
    assert_no_secrets(out + err)
  end

  def test_conflict_mode_shows_one_landing_and_one_return_naming_the_hunk
    out, err, code, = run_beat(FakeColony.new, "--conflict")
    assert_equal 0, code, out + err
    assert_includes out, "beat: two agents change the same line of one file"
    assert_includes out, "agent A changed line 6: landed in lnd_"
    assert_match(/agent B changed line 6 on \h{7}, the trunk before A landed: went back \(/, out)
    assert_match(/agent B's change prp_\d+ \(line 6: export const v6 = 66;\) went back: stale: src\/values.ts .*1 conflicting hunk, at line 6 of its base/, out)
    assert_includes out, "    6  export const v6 = 60;"
    assert_includes out, "FT_RESOLVER, is on here"
    assert_includes out, "PASS one landing and one return naming the conflicting hunk at line 6"
    assert_includes out, "deleted colony beat-"
  end

  def test_same_mode_shows_one_landing_the_second_change_back_stale_and_its_redo_closed_as_already_on_trunk
    out, err, code, reqs = run_beat(FakeColony.new(flags: %w[FT_INLINE FT_TEXT_MERGE FT_ALREADY_ON_TRUNK], on_trunk: true), "--same")
    assert_equal 0, code, out + err
    order = ["beat: two agents make the same change to one file; the second goes back, and its redo is already on trunk",
             "already on trunk (FT_ALREADY_ON_TRUNK) and inline changes (FT_INLINE) are on here; text merge is on",
             "agent A changed line 6: landed in lnd_", "agent B changed line 6 on ", ", the trunk before A landed: went back",
             "    6  export const v6 = 60;", "<- agent A",
             "(line 6: export const v6 = 60;) went back: stale: src/values.ts (expected ", "text merge stopped: this change repeats an edit trunk made after it read the file (src/values.ts at line 6 of its base)",
             "agent B redid it: took its intent again on ", "read agent A's version and made the same change: closed as already on trunk",
             "closed as already on trunk: Your change is already on trunk: what it writes is there already, landed by agent agt_",
             "agent B's intent int_", ": landed, closure already_on_trunk from lnd_",
             "PASS one landing; agent B's identical change went back stale, and its redo closed as already on trunk from lnd_", "deleted colony beat-"]
    at = 0
    order.each do |piece|
      found = out.index(piece, at)
      assert found, "expected #{piece.inspect} after position #{at} in:\n#{out}"
      at = found
    end
    assert(reqs.any? { |r| r.method == "GET" && r.path.match?(%r{/intents/int_\d+\z}) })
    assert_no_secrets(out + err)
  end

  def test_same_mode_fails_when_the_redo_lands_as_an_empty_commit
    out, err, code, reqs = run_beat(FakeColony.new(flags: %w[FT_INLINE FT_TEXT_MERGE FT_ALREADY_ON_TRUNK]), "--same")
    assert_equal 1, code, out + err
    assert_match(/FAIL agent B's redo landed in lnd_\d+ \(a commit that changes nothing\) instead of closing as already on trunk; is FT_ALREADY_ON_TRUNK on for colony beat-/, out)
    assert(reqs.any? { |r| r.method == "DELETE" })
  end

  def test_same_mode_fails_when_the_second_change_closes_though_it_read_the_file_before_the_first_landed
    out, err, code, reqs = run_beat(FakeColony.new(flags: %w[FT_INLINE FT_TEXT_MERGE FT_ALREADY_ON_TRUNK], on_trunk: true, merge_repeats: true), "--same")
    assert_equal 1, code, out + err
    assert_match(/FAIL agent B's change closed as already on trunk: Your change is already on trunk: .* instead of going back stale: it read src\/values.ts before agent A's landing, so its edit may be its own to make/, out)
    assert(reqs.any? { |r| r.method == "DELETE" })
  end

  def test_same_mode_needs_the_flag_and_not_conflict_too
    out, _err, code, reqs = run_beat(FakeColony.new, "--same")
    assert_equal 1, code
    assert_includes out, "FAIL already on trunk is off on this deployment (FT_ALREADY_ON_TRUNK is not on in /api/about)"
    assert_equal ["/api/about"], reqs.map(&:path)
    _out, err, code, reqs = run_beat(FakeColony.new, "--same", "--conflict")
    assert_equal 2, code
    assert_includes err, "pass --conflict or --same, not both"
    assert_empty reqs
  end

  def test_dup_mode_sends_the_repeat_back_and_its_redo_lands_the_shared_function_once
    out, err, code, = run_beat(FakeColony.new(flags: %w[FT_INLINE FT_TEXT_MERGE FT_MERGE_INSERTIONS]), "--dup")
    assert_equal 0, code, out + err
    order = ["beat: two agents append the same function to one file; it lands once",
             "text merge (FT_TEXT_MERGE), insertion merges (FT_MERGE_INSERTIONS) and inline changes (FT_INLINE) are on here",
             "agent A appended total(): landed in lnd_", "agent B appended total() and largest() on ", ", the trunk before A landed: went back",
             "(appended total() and largest()) went back: stale: src/values.ts", "this change repeats an edit trunk made after it read the file (src/values.ts at line 13 of its base)",
             "agent B redid it: took its intent again on ", "read agent A's version and appended largest() after it: landed in lnd_",
             "\"Append total() and largest() to src/values.ts\"", "appended largest() after it, on trunk as lnd_",
             "src/values.ts after both landings", "total() once, then largest()",
             "   14  export function total(values: number[]): number {", "<- agent A", "   18  export function largest(values: number[]): number {", "<- agent B",
             "src/values.ts:14", "src/values.ts:18", "PASS agent B's repeat of the shared function went back stale, and its redo landed the second function after it: the shared function once", "deleted colony beat-"]
    at = 0
    order.each do |piece|
      found = out.index(piece, at)
      assert found, "expected #{piece.inspect} after position #{at} in:\n#{out}"
      at = found
    end
    assert_equal 1, out.scan("   14  export function total(").length
  end

  def test_dup_mode_fails_when_the_repeat_is_merged_instead_of_going_back
    out, err, code, reqs = run_beat(FakeColony.new(flags: %w[FT_INLINE FT_TEXT_MERGE FT_MERGE_INSERTIONS], merge_repeats: true), "--dup")
    assert_equal 1, code, out + err
    assert_match(/FAIL agent B's change landed in lnd_\d+ instead of going back stale: it read src\/values.ts before agent A's landing and repeats agent A's total\(\)/, out)
    assert(reqs.any? { |r| r.method == "DELETE" })
  end

  def test_dup_mode_needs_insertion_merges_and_runs_alone
    out, _err, code, reqs = run_beat(FakeColony.new, "--dup")
    assert_equal 1, code
    assert_includes out, "FAIL insertion merges are off on this deployment (FT_MERGE_INSERTIONS is not on in /api/about)"
    assert_equal ["/api/about"], reqs.map(&:path)
    _out, err, code, reqs = run_beat(FakeColony.new, "--dup", "--same")
    assert_equal 2, code
    assert_includes err, "pass --dup alone, not with --conflict or --same"
    assert_empty reqs
  end

  def test_a_second_change_sent_back_stale_fails_the_beat_and_still_deletes_the_colony
    out, err, code, reqs = run_beat(FakeColony.new(text_merge: false))
    assert_equal 1, code, out + err
    assert_match(/FAIL agent B's change went back \(returned: stale: src\/values.ts/, out)
    assert(reqs.any? { |r| r.method == "DELETE" })
  end

  def test_a_deployment_without_text_merge_fails_before_creating_anything
    out, _err, code, reqs = run_beat(FakeColony.new(flags: %w[FT_INLINE]))
    assert_equal 1, code
    assert_includes out, "FAIL text merge is off on this deployment (FT_TEXT_MERGE is not on in /api/about)"
    assert_equal ["/api/about"], reqs.map(&:path)
  end

  def test_a_step_that_runs_out_of_time_says_what_it_waited_for_and_exits_3
    out, err, code, reqs = run_beat(FakeColony.new(settle_limit: 1), "--step-timeout", "1.5")
    assert_equal 3, code, out + err
    assert_match(/TIMEOUT timed out after 1.5 s waiting for agent A's change prp_\d+ to land or go back \(it is checking\)/, out)
    assert(reqs.any? { |r| r.method == "DELETE" }, "the colony is deleted after a timeout too")
  end

  def test_keep_leaves_the_colony_and_name_names_it
    out, _err, code, reqs = run_beat(FakeColony.new, "--keep", "--name", "signed-notes")
    assert_equal 0, code
    assert_includes out, "created colony signed-notes"
    assert_match(%r{kept colony signed-notes: http://127\.0\.0\.1:\d+/c/signed-notes}, out)
    refute(reqs.any? { |r| r.method == "DELETE" })
    out, _err, code, = run_beat(FakeColony.new.tap { |c| c.created << "signed-notes" }, "--name", "signed-notes")
    assert_equal 1, code
    assert_includes out, "FAIL colony signed-notes already exists: pass another --name, or --colony signed-notes to run the beat on it"
  end

  def test_an_existing_colony_gets_a_new_file_and_is_neither_reconfigured_nor_deleted
    colony = FakeColony.new.tap { |c| c.created << "hono" }
    out, err, code, reqs = run_beat(colony, "--colony", "hono")
    assert_equal 0, code, out + err
    assert_match(%r{on colony hono, as it is \(review as its policy says\); the beat writes a new file, beat/beat-\d{4}-\d{6}/values\.ts}, out)
    assert_includes out, "left colony hono as it was"
    refute(reqs.any? { |r| r.method == "DELETE" || r.path.end_with?("/decide/policy") || r.path == "/api/colonies" })
  end

  def test_no_access_headers_when_the_variables_are_unset
    out, _err, code, reqs = run_beat(FakeColony.new, access: false)
    assert_equal 0, code, out
    assert(reqs.none? { |r| r.headers.key?("cf-access-client-id") || r.headers.key?("cf-access-client-secret") })
  end

  def test_secrets_the_server_echoes_are_redacted
    out, err, code, = run_beat(FakeColony.new(leak: true), "--step-timeout", "0.5")
    assert_equal 3, code, out + err
    assert_includes out, "TIMEOUT timed out after 0.5 s waiting for the seed agent to be handed its intent (the colony said: pool busy (lease <redacted> for <redacted>))"
    assert_no_secrets(out + err)
  end

  def test_settings_problems_exit_2_before_any_request
    out, err, code, reqs = run_beat(FakeColony.new, token: false)
    assert_equal 2, code
    assert_includes err, "FT_TOKEN is not set"
    assert_empty reqs
    _, err, code, reqs = run_beat(FakeColony.new, env: { "CF_ACCESS_CLIENT_SECRET" => nil })
    assert_equal 2, code
    assert_includes err, "set both CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET"
    assert_empty reqs
    assert_no_secrets(out + err)
  end

  # The config file's token goes only to the deployment the file names, as the ft CLI decides.
  def test_the_config_file_token_is_used_only_for_its_own_deployment
    Dir.mktmpdir("beat-config") do |dir|
      FileUtils.mkdir_p(File.join(dir, "firetrident"))
      File.write(File.join(dir, "firetrident", "env"), "FT_URL=https://staging.example.invalid\nexport FT_TOKEN='from-file-token'\n")
      env = { "XDG_CONFIG_HOME" => dir }
      assert_equal "from-file-token", Stage.token("https://staging.example.invalid/", env)
      assert_nil Stage.token("https://firetrident.com", env)
      assert_equal "env-token", Stage.token("https://firetrident.com", env.merge("FT_TOKEN" => "env-token"))
      File.write(File.join(dir, "firetrident", "env"), "FT_TOKEN=default-token # the production token\n")
      assert_equal "default-token", Stage.token("https://firetrident.com", env)
      assert_nil Stage.token("https://staging.firetrident.com", env)
    end
  end

  # The script's ids are the ones core computes (packages/core/src/changeset.ts) and git computes.
  def test_blob_and_changeset_ids_match_core_and_git
    text = "export const v1 = 1;\nüñí €\n"
    write = [{ path: "src/b.ts", blob: Stage.blob_id(text) }, { path: "src/a.ts", blob: nil }]
    git, = Open3.capture2("git", "hash-object", "--stdin", stdin_data: text)
    assert_equal git.strip, Stage.blob_id(text)
    core = File.expand_path("../../packages/core/src/changeset.ts", __dir__)
    js = "import { blobId, changesetId } from #{JSON.generate(core)}; const [t, w] = JSON.parse(process.argv[1]); " \
         "console.log(blobId(t), changesetId(#{JSON.generate('f' * 40)}, w));"
    out, status = Open3.capture2("node", "--input-type=module", "-e", js, JSON.generate([text, write]))
    assert status.success?
    assert_equal [Stage.blob_id(text), Stage.changeset_id("f" * 40, write)], out.split
  end
end
