# frozen_string_literal: true

# Tests for scripts/coordination.rb. Most run on a synthetic colony built in a temporary directory: a git repository
# with imported history, six landings with FT-* trailers and lineage notes (one landing holds two proposals that
# wrote one file, whose steps can be rebuilt; another holds two whose first step is not in the clone; the last has
# no note), an antibody and a revert, and a fake public API holding the colony's event record.
#
#   ruby scripts/test/coordination_test.rb
require "minitest/autorun"
require "fileutils"
require "json"
require "open3"
require "socket"
require "tmpdir"
require_relative "../coordination"

# The fixture's git, and the script's, ignore the user's and the system's git configuration.
ENV["GIT_CONFIG_GLOBAL"] = File::NULL
ENV["GIT_CONFIG_NOSYSTEM"] = "1"

# The synthetic colony "fx": its trunk repository and its public record.
module Fixture
  T = 1_800_000_000 # the commits' clock, in seconds
  T0 = T * 1000 # the events' clock, in ms
  SCRIPT = File.expand_path("../coordination.rb", __dir__)

  def self.lines(*list) = list.map { |l| "#{l}\n" }.join

  A1 = "export const a1 = 1;"
  A2 = "export const a2 = 2;"
  A2_P1 = "export const a2 = 22; // P1"
  A3 = "export const a3 = 3;"
  A4 = "export const a4 = 4;"
  A5_P5 = "export const a5 = 5; // P5"
  A0_P6 = "export const a0 = 0; // P6"
  B = ["export const b1 = 1;", "export const b2 = 2;", "export const b3 = 3;"].freeze
  U = ["export const u1 = 1;", "export const u2 = 2;", "export const u3 = 3;"].freeze
  U4_P3 = "export const u4 = 4; // P3"
  U5_P7 = "export const u5 = 5; // P7"
  U6_P8 = "export const u6 = 6; // P8"

  def self.git(dir, *args, input: nil, env: {})
    out, err, status = Open3.capture3(env, "git", *args, stdin_data: input.to_s, chdir: dir)
    raise "git #{args.join(' ')}: #{err}" unless status.success?

    out
  end

  def self.blob(dir, text, write: true) = git(dir, "hash-object", *(write ? ["-w"] : []), "--stdin", input: text).strip

  # Write `files` (nil deletes), commit them at T + at seconds, and add `note` under refs/notes/firetrident.
  def self.commit(dir, at:, message:, files:, author: "FireTrident <lanes@firetrident.dev>", note: nil)
    files.each do |path, text|
      full = File.join(dir, path)
      next FileUtils.rm_f(full) if text.nil?

      FileUtils.mkdir_p(File.dirname(full))
      File.write(full, text)
    end
    git(dir, "add", "-A")
    name, email = author.match(/\A(.*) <(.*)>\z/).captures
    date = "#{T + at} +0000"
    env = { "GIT_AUTHOR_NAME" => name, "GIT_AUTHOR_EMAIL" => email, "GIT_AUTHOR_DATE" => date,
            "GIT_COMMITTER_NAME" => name, "GIT_COMMITTER_EMAIL" => email, "GIT_COMMITTER_DATE" => date }
    git(dir, "commit", "--quiet", "--no-verify", "-F", "-", input: message, env: env)
    sha = git(dir, "rev-parse", "HEAD").strip
    git(dir, "notes", "--ref=refs/notes/firetrident", "add", "-F", "-", sha, input: JSON.pretty_generate(note), env: env) if note
    sha
  end

  def self.prop(id, agent, intent, writes)
    { "id" => id, "agentId" => agent, "agentKind" => "internal", "model" => "model-#{agent}",
      "intent" => { "id" => intent, "title" => "#{intent} title", "why" => "Because #{intent} matters." },
      "writeSet" => writes.map { |path, blob| { "path" => path, "blob" => blob } }, "readSet" => [], "decisions" => [], "evidence" => { "checks" => [] } }
  end

  def self.note(landing, props, extra = {}) = { "schema" => "firetrident.lineage/v1", "landingId" => landing, "colonyId" => "fx", "proposals" => props }.merge(extra)

  def self.message(landing, props) = "Land #{props.size} change: #{props.first['intent']['title']}\n\n- #{props.first['intent']['title']}\n\n" +
                                     ["FT-Landing: #{landing}", *props.map { |p| "FT-Intent: #{p['intent']['id']}" },
                                      *props.map { |p| "FT-Proposal: #{p['id']}" }, *props.map { |p| "FT-Agent: #{p['agentId']}" }.uniq].join("\n")

  # A landing commit: `writes` maps each proposal to {path => text}; its note names the blobs (`blobs` overrides one).
  def self.landing(dir, at:, landing:, props:, files:, note: true)
    entries = props.map { |id, agent, intent, writes, blobs| prop(id, agent, intent, writes.to_h { |path, text| [path, (blobs || {})[path] || (text && blob(dir, text))] }) }
    commit(dir, at: at, message: message(landing, entries), files: files, note: note ? note(landing, entries) : nil)
  end

  # Build the trunk in `dir`; returns its head.
  def self.build(dir)
    git(dir, "init", "--quiet", "--initial-branch=main")
    commit(dir, at: 0, author: "Ada Human <ada@example.com>", message: "Import fx",
                files: { "README.md" => "# fx\nreadme line\n", "src/a.ts" => lines(A1, A2, A3, A4), "lib/util.ts" => lines(*U) })
    a1 = lines(A1, A2_P1, A3, A4)
    landing(dir, at: 60, landing: "lnd_1", props: [["prp_1", "agt_1", "int_1", { "src/a.ts" => a1, "src/b.ts" => lines(*B) }]],
                 files: { "src/a.ts" => a1, "src/b.ts" => lines(*B) })
    b2 = lines(B[0], B[1], "export const b3 = 33; // P2", "export const b4 = 4; // P2")
    landing(dir, at: 120, landing: "lnd_2", props: [["prp_2", "agt_2", "int_2", { "src/b.ts" => b2, "docs/guide.md" => "# Guide\nguide line\n" }]],
                  files: { "src/b.ts" => b2, "docs/guide.md" => "# Guide\nguide line\n" })
    u3 = lines(*U, U4_P3)
    c3 = lines("export const c1 = 1;", "export const c2 = 2;")
    landing(dir, at: 180, landing: "lnd_3", props: [["prp_3", "agt_1", "int_3", { "lib/util.ts" => u3 }], ["prp_4", "agt_3", "int_4", { "src/c.ts" => c3 }]],
                  files: { "lib/util.ts" => u3, "src/c.ts" => c3 })
    # Two proposals wrote src/a.ts: P5 appended a5 (its blob is stored, so the steps can be rebuilt), P6 put a0 on top.
    a_p5 = lines(A1, A2_P1, A3, A4, A5_P5)
    a_p6 = lines(A0_P6, A1, A2_P1, A3, A4, A5_P5)
    landing(dir, at: 240, landing: "lnd_4", props: [["prp_5", "agt_2", "int_5", { "src/a.ts" => a_p5 }], ["prp_6", "agt_3", "int_6", { "src/a.ts" => a_p6 }]],
                  files: { "src/a.ts" => a_p6 })
    # Two proposals wrote lib/util.ts and P7's version is not in the clone, so their two lines stay unattributed.
    u_p7 = lines(*U, U4_P3, U5_P7)
    u_p8 = lines(*U, U4_P3, U5_P7, U6_P8)
    landing(dir, at: 300, landing: "lnd_5",
                  props: [["prp_7", "agt_1", "int_7", { "lib/util.ts" => u_p7 }, { "lib/util.ts" => blob(dir, u_p7, write: false) }], ["prp_8", "agt_2", "int_8", { "lib/util.ts" => u_p8 }]],
                  files: { "lib/util.ts" => u_p8 })
    rejected = prop("prp_9", "agt_3", "int_9", { "src/x.ts" => nil })
    commit(dir, at: 330, message: "Antibody ab_1: is src/x.ts wanted?\n\nFT-Antibody: ab_1\nFT-Rejected-Proposal: prp_9\nFT-Intent: int_9\nFT-Landing: lnd_s1",
                files: { ".firetrident/antibodies/ab_1.json" => "{\n  \"id\": \"ab_1\"\n}\n" },
                note: note("lnd_s1", [rejected], "system" => { "kind" => "antibody", "antibody" => "ab_1" }))
    commit(dir, at: 360, message: "Revert prp_2 (abc1234)\n\nFT-Revert-Of: lnd_2\nFT-Revert-Proposal: prp_2\nFT-Landing: lnd_s2",
                files: { "src/b.ts" => lines(*B) }, note: note("lnd_s2", [], "revert" => { "of" => "lnd_2", "proposal" => "prp_2" }))
    d6 = lines("export const d1 = 1;", "export const d2 = 2;", "export const d3 = 3;")
    landing(dir, at: 420, landing: "lnd_6", props: [["prp_10", "agt_3", "int_10", { "src/d.ts" => d6 }]], files: { "src/d.ts" => d6 }, note: false)
  end

  # The colony's event record (vaccine included, as the API serves it).
  def self.events
    list = []
    add = ->(at, e) { list << e.merge("at" => T0 + (at * 1000)) }
    prop = ->(at, pid, intent, agent, status, reason = nil) do
      add.(at, { "t" => "proposal", "proposalId" => pid, "intentId" => intent, "agentId" => agent, "status" => status }.merge(reason ? { "reason" => reason } : {}))
    end
    intent = ->(at, id, status) { add.(at, { "t" => "intent", "intentId" => id, "status" => status, "title" => "#{id} title", "footprint" => [] }) }
    landed = lambda do |at, lnd, *props|
      props.each do |pid, iid, agent|
        prop.(at - 2, pid, iid, agent, "checking")
        prop.(at, pid, iid, agent, "landed")
        intent.(at, iid, "landed")
      end
      add.(at, { "t" => "landing", "landingId" => lnd, "trunkSha" => "", "proposalIds" => props.map(&:first), "paths" => [] })
    end
    %w[int_1 int_2 int_3 int_4 int_5 int_6 int_7 int_8 int_9 int_10 int_12 int_13 int_14 int_15 int_16 int_17 int_18 int_19 int_21].each { |i| intent.(1, i, "open") }
    # Definition 12: the agents join, three takes (an agent set working on an intent with its footprint), and agt_4 is reaped.
    agent = ->(at, id, state, intent_id = nil, paths = nil) { add.(at, { "t" => "agent", "agentId" => id, "kind" => "internal", "state" => state }.merge(intent_id ? { "intentId" => intent_id, "paths" => paths } : {})) }
    %w[agt_1 agt_2 agt_3 agt_4 agt_v].each { |id| agent.(1, id, "idle") }
    agent.(5, "agt_4", "working", "int_5", ["src/a.ts"])
    agent.(205, "agt_2", "working", "int_5", ["src/a.ts"])
    agent.(250, "agt_4", "dead")
    agent.(295, "agt_3", "working", "int_10", ["src/"])
    prop.(10, "prp_11", "int_5", "agt_4", "checking")
    prop.(30, "prp_11", "int_5", "agt_4", "returned", "stale: 1 path changed on trunk since read: src/a.ts (expected 1111111111, trunk 2222222222)")
    prop.(15, "prp_9", "int_9", "agt_3", "checking")
    prop.(16, "prp_9", "int_9", "agt_3", "escalated", "escalated by deterministic: danger patterns need a human")
    prop.(20, "prp_9", "int_9", "agt_3", "rejected", "rejected by a reviewer")
    landed.(42, "lnd_1", %w[prp_1 int_1 agt_1])
    prop.(50, "prp_12", "int_12", "agt_1", "checking")
    prop.(70, "prp_12", "int_12", "agt_1", "returned", "stale: src/a.ts (expected aaa, trunk has bbb); text merge of src/a.ts: 1 conflicting hunk, at line 2 of its base")
    prop.(80, "prp_20", "int_20", "agt_v", "checking")
    prop.(100, "prp_20", "int_20", "agt_v", "rejected", "vaccine: returned by the second opinion")
    intent.(100, "int_20", "abandoned")
    landed.(92, "lnd_2", %w[prp_2 int_2 agt_2])
    prop.(120, "prp_13", "int_13", "agt_2", "checking")
    prop.(130, "prp_13", "int_13", "agt_2", "returned", "llm: the change does not do what the intent asks")
    prop.(140, "prp_14", "int_14", "agt_3", "checking")
    prop.(150, "prp_14", "int_14", "agt_3", "returned", "deterministic: innate: src/a.ts adds 1 violation of rule rul_1 (Relative imports name their file)")
    landed.(160, "lnd_3", %w[prp_3 int_3 agt_1], %w[prp_4 int_4 agt_3])
    prop.(190, "prp_15", "int_15", "agt_4", "checking")
    prop.(200, "prp_15", "int_15", "agt_4", "returned", "deleting src/b.ts breaks the imports of src/a.ts: change them in the same change, or first")
    landed.(210, "lnd_4", %w[prp_5 int_5 agt_2], %w[prp_6 int_6 agt_3])
    prop.(215, "prp_16", "int_16", "agt_2", "checking")
    prop.(220, "prp_16", "int_16", "agt_2", "escalated")
    prop.(230, "prp_16", "int_16", "agt_2", "returned", "please split this change")
    add.(230, { "t" => "decision", "decisionId" => "dec_1", "kind" => "triage", "layer" => "human", "p" => 1, "action" => "return", "subject" => "prp_16" })
    prop.(235, "prp_17", "int_17", "agt_1", "checking")
    prop.(240, "prp_17", "int_17", "agt_1", "returned", "withdrawn: no longer needed")
    intent.(240, "int_17", "withdrawn")
    prop.(245, "prp_18", "int_18", "agt_3", "checking")
    prop.(250, "prp_18", "int_18", "agt_3", "rejected", "not wanted")
    prop.(255, "prp_19", "int_19", "agt_4", "checking")
    prop.(260, "prp_19", "int_19", "agt_4", "ready")
    intent.(260, "int_19", "proposed")
    landed.(270, "lnd_5", %w[prp_7 int_7 agt_1], %w[prp_8 int_8 agt_2])
    add.(275, { "t" => "landing", "landingId" => "lnd_s1", "trunkSha" => "", "proposalIds" => [], "paths" => [] })
    add.(280, { "t" => "landing", "landingId" => "lnd_s2", "trunkSha" => "", "proposalIds" => [], "paths" => [] })
    landed.(300, "lnd_6", %w[prp_10 int_10 agt_3])
    list.each_with_index.sort_by { |e, i| [e["at"], i] }.map(&:first).each_with_index.map { |e, i| e.merge("seq" => i + 1) }
  end

  AGENTS = [
    { "id" => "agt_1", "kind" => "internal", "name" => "internal-1", "model" => "m1" },
    { "id" => "agt_2", "kind" => "internal", "name" => "internal-2", "model" => "m2" },
    { "id" => "agt_3", "kind" => "external", "name" => "byo-3", "model" => "declared-3" },
    { "id" => "agt_4", "kind" => "external", "name" => "byo-4", "model" => "declared-4" },
    { "id" => "agt_v", "kind" => "synthetic", "name" => "vaccine", "model" => "vaccine" }
  ].freeze

  # The API's copies of the proposals the notes do not hold.
  def self.proposals(dir)
    writes = { "prp_9" => ["src/x.ts"], "prp_11" => ["src/a.ts"], "prp_12" => ["src/a.ts"], "prp_13" => ["src/b.ts"], "prp_14" => ["src/a.ts"],
               "prp_15" => ["src/b.ts"], "prp_16" => ["lib/util.ts"], "prp_17" => ["src/e.ts"], "prp_18" => ["src/f.ts"], "prp_19" => ["src/a.ts"] }
    agents = { "prp_9" => "agt_3", "prp_11" => "agt_4", "prp_12" => "agt_1", "prp_13" => "agt_2", "prp_14" => "agt_3", "prp_15" => "agt_4",
               "prp_16" => "agt_2", "prp_17" => "agt_1", "prp_18" => "agt_3", "prp_19" => "agt_4" }
    out = writes.to_h do |id, paths|
      [id, { "id" => id, "agentId" => agents[id], "intentId" => "int_#{id[4..]}", "status" => "returned",
             "writeSet" => paths.map { |p| { "path" => p, "blob" => "0" * 40 } }, "readSet" => [{ "path" => "README.md", "blob" => "1" * 40 }] }]
    end
    out["prp_11"]["intentId"] = "int_5"
    d6 = git(dir, "rev-parse", "HEAD:src/d.ts").strip
    out.merge("prp_10" => { "id" => "prp_10", "agentId" => "agt_3", "intentId" => "int_10", "status" => "landed", "landingId" => "lnd_6",
                            "writeSet" => [{ "path" => "src/d.ts", "blob" => d6 }], "readSet" => [] })
  end

  def self.snapshot(head) = { "colony" => { "id" => "fx", "regionDepth" => 1, "trunkSha" => head }, "metrics" => { "proposals" => 20, "landedProposals" => 9 },
                               "spend" => { "usd" => 0.0012, "byModel" => { "model-agt_1" => { "input" => 100, "output" => 50, "usd" => 0.0012 }, "llm-review" => { "input" => 40, "output" => 4, "usd" => 0.0004 } } } }

  # Certification results, newest first (definition 15): a first red at rank 2 whose isolated proposal a suspect names,
  # one outside the import trace, one cut by a limit, one with no suspects (copied from an earlier search), and three
  # that do not count (inconclusive, green, red with no search).
  def self.certifications
    found = ->(landing, proposals, extra = {}) { { "status" => "found", "landingId" => landing, "proposals" => proposals, "probes" => 3, "ms" => 900 }.merge(extra) }
    suspect = ->(landing, extra = {}) { { "landingId" => landing, "paths" => ["src/a.ts"], "files" => ["test/a.test.ts"], "at" => T0 }.merge(extra) }
    [
      { "trunkSha" => "a" * 40, "status" => "red", "startedAt" => T0, "suspects" => [suspect.("lnd_5"), suspect.("lnd_4", "proposalId" => "prp_6")],
        "firstRed" => found.("lnd_4", [{ "id" => "prp_6", "paths" => ["src/a.ts"] }], "isolated" => { "status" => "isolated", "reason" => "x", "culprit" => { "id" => "prp_6", "paths" => [] }, "runs" => [], "candidates" => 2, "probes" => 2, "ms" => 1 }) },
      { "trunkSha" => "b" * 40, "status" => "red", "startedAt" => T0, "suspects" => [suspect.("lnd_3")], "firstRed" => found.("lnd_2", []) },
      { "trunkSha" => "c" * 40, "status" => "red", "startedAt" => T0, "suspects" => [suspect.("lnd_3")], "firstRed" => found.("lnd_1", [{ "id" => "prp_1", "paths" => ["src/a.ts"] }]) },
      { "trunkSha" => "d" * 40, "status" => "red", "startedAt" => T0, "firstRed" => found.("lnd_1", [{ "id" => "prp_1", "paths" => ["src/a.ts"] }], "reusedFrom" => "c" * 40) },
      { "trunkSha" => "e" * 40, "status" => "red", "startedAt" => T0, "suspects" => [suspect.("lnd_3")], "firstRed" => { "status" => "inconclusive", "reason" => "flaky", "probes" => 1, "ms" => 1 } },
      { "trunkSha" => "f" * 40, "status" => "green", "startedAt" => T0 },
      { "trunkSha" => "0" * 40, "status" => "red", "startedAt" => T0, "suspects" => [suspect.("lnd_3")] }
    ]
  end

  # The public API, in process: what Report asks of Coordination::Api.
  class FakeApi
    attr_reader :asked

    def initialize(dir)
      @snapshot = Fixture.snapshot(Fixture.git(dir, "rev-parse", "HEAD").strip)
      @events = Fixture.events
      @proposals = Fixture.proposals(dir)
      @asked = Queue.new
    end

    def base = "http://fake"
    def colony(_id) = @snapshot
    def events(_id) = { "source" => "recorded", "total" => @events.size, "events" => @events }
    def agents(_id) = AGENTS
    def certifications(_id) = Fixture.certifications
    def certifications_page(_id) = { "colonyId" => "fx", "deployment" => true, "runner" => true, "policy" => { "enabled" => true }, "results" => Fixture.certifications }
    def metrics(_id) = nil
    def intent_spend(_id, _iid) = nil

    def proposal(_id, pid)
      @asked << pid
      @proposals[pid]
    end
  end

  # The same API over HTTP on 127.0.0.1, serving the event record in two pages and 404 for everything else.
  def self.serve(dir)
    snapshot = snapshot(git(dir, "rev-parse", "HEAD").strip)
    events = self.events
    proposals = self.proposals(dir)
    half = events.size / 2
    server = TCPServer.new("127.0.0.1", 0)
    route = lambda do |target|
      path, query = target.split("?", 2)
      params = URI.decode_www_form(query.to_s).to_h
      case path
      when "/api/colonies/fx" then [200, snapshot]
      when "/api/colonies/fx/agents" then [200, { "agents" => AGENTS }]
      when "/api/colonies/fx/certifications" then [200, { "colonyId" => "fx", "results" => certifications }]
      when "/api/colonies/fx/events"
        after = params["after"].to_i
        page = after.zero? ? events.first(half) : events.drop(half)
        [200, { "colonyId" => "fx", "source" => "recorded", "events" => page, "next" => after.zero? ? half : nil, "total" => events.size }]
      when %r{\A/api/colonies/fx/proposals/(.+)\z} then proposals[Regexp.last_match(1)] ? [200, proposals[Regexp.last_match(1)]] : [404, { "error" => "proposal not found" }]
      else [404, { "error" => "no route" }]
      end
    end
    thread = Thread.new do
      loop do
        client = server.accept
        request = client.gets.to_s
        while (line = client.gets) && line != "\r\n"; end
        code, body = route.call(request.split[1].to_s)
        text = JSON.generate(body)
        client.write("HTTP/1.1 #{code} OK\r\nContent-Type: application/json\r\nContent-Length: #{text.bytesize}\r\nConnection: close\r\n\r\n#{text}")
        client.close
      end
    rescue IOError, SystemCallError
      nil
    end
    [server, thread, "http://127.0.0.1:#{server.addr[1]}"]
  end
end

class CoordinationTest < Minitest::Test
  # One fixture repository for the whole file (building it runs about thirty git commands).
  def self.fixture
    @fixture ||= begin
      dir = Dir.mktmpdir("coordination-fixture")
      Minitest.after_run { FileUtils.remove_entry(dir) }
      Fixture.build(dir)
      dir
    end
  end

  def self.report
    @report ||= begin
      api = Fixture::FakeApi.new(fixture)
      [Coordination::Report.new(colony: "fx", git: Coordination::Git.new(fixture), api: api, url: "http://fake").build, api]
    end
  end

  def report = self.class.report.first

  def test_trunk_tells_landings_system_commits_and_how_each_is_known
    t = report[:trunk]
    assert_equal 9, t[:firstParentCommits]
    assert_equal 8, t[:firetridentCommits]
    assert_equal 6, t[:landingCommits]
    assert_equal 2, t[:systemCommits]
    assert_equal({ found: 7, foreign: 0, unreadable: 0 }, t[:notes])
    assert_equal({ note: 7, apiAndTrailers: 1, trailersOnly: 0, unverified: 0 }, t[:knownFrom])
    assert_equal Fixture.git(self.class.fixture, "rev-parse", "HEAD~8").strip, t[:base]
    refute t[:shallow]
  end

  def test_merged_fraction_counts_in_flight_as_not_merged_and_redirects_apart
    m = report[:mergedFraction]
    assert_equal({ made: 19, landed: 9, returned: 6, redirected: 1, rejected: 2, inFlight: 1, other: 0 }, m[:proposals])
    assert_in_delta 9 / 19.0, m[:merged], 1e-4
    assert_in_delta 0.5, m[:mergedOfSettled], 1e-4
    assert_equal({ total: 19, withProposal: 18, landed: 9, byStatus: { "landed" => 9, "open" => 8, "proposed" => 1, "withdrawn" => 1 } }, m[:intents])
    assert_in_delta 9 / 19.0, m[:intentsMerged], 1e-4
    assert_in_delta 0.5, m[:intentsMergedWithProposal], 1e-4
    assert_equal 1, report[:record][:vaccineProposalsLeftOut]
    assert(report[:warnings].any? { |w| w.include?("the record holds 19 proposals and the colony counts 20") })
  end

  def test_code_sharing_attributes_lines_through_notes_splits_and_the_api
    cs = report[:codeSharing]
    files = cs[:perFile].to_h { |f| [f[:path], f] }
    assert_equal %w[docs/guide.md lib/util.ts src/a.ts src/b.ts src/c.ts src/d.ts], files.keys
    # src/a.ts: a0 by P6 and a5 by P5 (one landing, split step by step), a2 by P1, the rest imported.
    assert_equal({ "agt_1" => 1, "agt_2" => 1, "agt_3" => 1 }, files["src/a.ts"][:byAgent])
    assert_equal 3, files["src/a.ts"][:imported]
    # src/b.ts: b3 came back with the revert, a system commit.
    assert_equal({ "agt_1" => 2 }, files["src/b.ts"][:byAgent])
    assert_equal 1, files["src/b.ts"][:system]
    # lib/util.ts: u5 and u6 are from a landing whose first step is not in the clone.
    assert_equal({ "agt_1" => 1 }, files["lib/util.ts"][:byAgent])
    assert_equal 2, files["lib/util.ts"][:unattributed]
    # src/d.ts landed with no note; the API vouched for its proposal.
    assert_equal({ "agt_3" => 3 }, files["src/d.ts"][:byAgent])
    assert_equal({ lines: 22, agentWritten: 13, imported: 6, system: 1, unattributed: 2 }, cs[:lines])
    scores = cs[:agents].to_h { |a| [a[:agent], [a[:wholeFile], a[:agentLines]]] }
    assert_equal({ "agt_1" => [(1 / 18.0).round(4), (2 / 21.0).round(4)], "agt_2" => [(1 / 21.0).round(4), (1 / 6.0).round(4)],
                   "agt_3" => [(1 / 39.0).round(4), (2 / 21.0).round(4)] }, scores)
    assert_equal (1 / 21.0).round(4), cs[:wholeFile][:median]
    assert_equal (2 / 21.0).round(4), cs[:agentLines][:median]
    assert_equal 3, cs[:wholeFile][:histogram]["0.0-0.1"]
  end

  def test_specialization_against_the_shuffled_baseline
    s = report[:specialization]
    assert_equal 1, s[:regionDepth]
    assert_equal 9, s[:landedProposals]
    assert_equal 3, s[:agents]
    assert_in_delta 2 / 3.0, s[:observed], 1e-4
    assert_includes [(2 / 3.0).round(4), 1.0], s[:baseline]
    assert_in_delta s[:observed] - s[:baseline], s[:difference], 1e-4
    assert_equal([["agt_3", "src", 1.0], ["agt_1", "lib", 0.6667], ["agt_2", "src", 0.6667]], s[:perAgent].map { |a| [a[:agent], a[:topRegion], a[:topShare]] })
  end

  def test_conflicts_over_time_by_class
    c = report[:conflicts]
    assert_equal 6, c[:returns]
    assert_equal({ "stale" => 1, "text_merge" => 1, "review" => 2, "rule" => 1, "other" => 1 }, c[:byClass])
    assert_equal 5, c[:minutes]
    assert_equal Fixture::T0 + 10_000, c[:firstProposalAt]
    assert_equal({ "stale" => [1, 1, 1, 1, 1], "text_merge" => [0, 1, 1, 1, 1], "review" => [0, 0, 1, 2, 2], "rule" => [0, 0, 1, 1, 1],
                   "other" => [0, 0, 0, 1, 1], "total" => [1, 2, 4, 6, 6] }, c[:cumulative])
    assert_equal(%w[prp_11 prp_12 prp_13 prp_14 prp_15 prp_16], c[:list].map { |r| r[:proposal] })
  end

  def test_hottest_file_from_reasons_or_write_sets
    h = report[:hottestFile]
    assert_equal "src/a.ts", h[:path]
    assert_equal 4, h[:returns]
    assert_equal [], h[:tiedWith]
    assert_equal 4, h[:agentsProposed]
    assert_equal([4, 4, 6], h[:sizes].map { |x| x[:lines] })
    assert_equal [{ path: "src/a.ts", returns: 4 }, { path: "src/b.ts", returns: 2 }, { path: "lib/util.ts", returns: 1 }], h[:top]
  end

  def test_sprawl_over_firetrident_commits
    s = report[:sprawl]
    assert_equal([[2, 3], [2, 3], [3, 4], [3, 4], [3, 4], [3, 4], [4, 5], [4, 5], [4, 5]], s[:points].map { |p| [p[:topDirs], p[:regions]] })
    assert_equal({ topDirs: 4, regions: 5, files: 8 }, s[:end])
    assert_equal(%w[base landing landing landing landing landing system system landing], s[:points].map { |p| p[:kind] })
  end

  def test_lines_per_landed_intent
    l = report[:linesPerIntent]
    assert_equal [18, 2, 16, 9], [l[:added], l[:removed], l[:net], l[:landedIntents]]
    assert_in_delta 16 / 9.0, l[:netPerIntent], 0.005
    assert_equal({ added: 4, removed: 2, binary: 0 }, l[:system])
    assert_equal [6, 22, 15, 13], [l[:agentTouchedFiles], l[:linesInAgentTouchedFiles], l[:agentWrittenLinesAtHead], l[:attributedLinesAtHead]]
  end

  # The fixture's notes predate the record of who declared each intent: every landing read from a note is unknown.
  def test_who_answers_for_the_landings_read_from_notes
    assert_equal({ landings: 5, person: 0, none: 0, unknown: 5, noneShare: 0.0 }, report[:answerable])
    assert_includes Coordination.markdown(report), "| No person answerable | 0 of 5 landings read from notes (0.000); 0 a person answers for, 5 unknown"
  end

  def test_reads_only_the_proposals_the_notes_do_not_hold
    asked = []
    api = self.class.report.last
    asked << api.asked.pop until api.asked.empty?
    assert_equal %w[prp_10 prp_11 prp_12 prp_13 prp_14 prp_15 prp_16 prp_17 prp_18 prp_19 prp_9], asked.sort
  end

  def test_agents_table
    rows = report[:agents].to_h { |a| [a[:id], a] }
    assert_equal %w[agt_1 agt_2 agt_3 agt_4], rows.keys
    assert_equal [5, 3, 4], rows["agt_1"].values_at(:proposals, :landed, :linesAtHead)
    assert_equal "declared-3", rows["agt_3"][:model]
  end

  def test_markdown_table
    md = Coordination.markdown(report)
    assert_includes md, "| Proposals merged | 9 of 19 (0.474); 6 returned, 1 redirected, 2 rejected, 1 in flight |"
    assert_includes md, "| Hottest file | `src/a.ts`: named by 4 returns, 4 agents proposed to it, 4 → 6 lines |"
    assert_includes md, "| Returns, cumulative over 5 min | 6: stale 1, text merge 1, review 2, rule 1, other 1 |"
    assert_includes md, "| Sprawl | top-level directories 2 → 4, regions 3 → 5 over 8 commits |"
    assert_includes md, "| Where the time went | 216.0 agent-seconds over 9 landed intents, from claim to landing:"
    assert_includes md, "| Critical path to the last landing | `int_10` (int_10 title) landed at +299.0 s in lnd_6 (1 change): no claim in the record"
  end

  # The fixture's record predates the closure ledger: no intent event carries a cause.
  def test_closures_of_a_record_before_the_ledger
    assert_equal({ closures: 0, byKind: {}, reaped: { count: 0, medianGapMs: nil, maxGapMs: nil }, beforeLedger: 0 }, report[:closures])
    assert_includes Coordination.markdown(report), "| Closures | none recorded |"
  end

  # Definition 12 rebuilt: the fixture's colony has no take counters, so its three takes are rebuilt from the record and
  # notes. The first comes before any landing; the second gets lnd_1's why and the stale return of prp_11; the third's
  # footprint is a directory, whose newest three landing groups are both of lnd_4 and lnd_3's.
  def test_coordination_tokens_rebuilt_from_the_record_and_notes
    t = report[:takeTokens]
    assert_equal ["rebuilt", nil], t.values_at(:source, :counted)
    why = lambda do |lnd, at, intent, paths|
      { landingId: lnd, at: Fixture::T0 + (at * 1000), title: "#{intent} title", why: "Because #{intent} matters.", paths: paths, trunkSha: "0" * 40, intentId: intent }
    end
    stale = "stale: 1 path changed on trunk since read: src/a.ts (expected 1111111111, trunk 2222222222)"
    second = JSON.generate([why.("lnd_1", 42, "int_1", ["src/a.ts"])]).length +
             JSON.generate({ proposalId: "prp_11", status: "returned", at: Fixture::T0 + 30_000, reason: stale, paths: ["src/a.ts"] }).length
    third = JSON.generate([why.("lnd_4", 210, "int_5", ["src/a.ts"]), why.("lnd_4", 210, "int_6", ["src/a.ts"]), why.("lnd_3", 160, "int_4", ["src/c.ts"])]).length
    r = t[:rebuilt]
    assert_equal 3, r[:takes]
    assert_equal ((second + third) / 12.0).round(1), r[:tokensPerTake]
    # Read everything: no landed why at the first take, four (88 characters) at the second, eight (176) at the third.
    assert_equal 22.0, r[:readEverythingTokensPerTake]
    assert_equal 3.7, r[:agentsPerTake]
    assert_equal [{ agents: "2-3", from: 2, takes: 1, tokensPerTake: (third / 4.0).round(1), readEverythingTokensPerTake: 44.0 },
                  { agents: "4-7", from: 4, takes: 2, tokensPerTake: (second / 8.0).round(1), readEverythingTokensPerTake: 11.0 }], r[:byAgents]
    assert_match(/lower bound/, r[:leftOut])
    assert_includes Coordination.markdown(report), "| Coordination tokens per take (ESTIMATE, rebuilt) | #{format('%.1f', r[:tokensPerTake])} (why-context"
  end

  # Definition 15 from the certification results the fake API serves.
  def test_culprit_precision_against_first_red
    c = report[:culpritPrecision]
    assert_equal "certifications", c[:source]
    assert_equal [4, 1, 1, 1, 1, 0], c.values_at(:answers, :suspect, :outsideImportTrace, :cutByLimit, :notLookedFor, :closureNotRecorded)
    assert_equal [0.25, 0.0, { 2 => 1 }, 2.0, 1], c.values_at(:precision, :rank1, :ranks, :meanRank, :reused)
    assert_equal({ answers: 1, suspect: 1 }, c[:isolated])
    assert_equal [["lnd_4", "suspect", 2], ["lnd_2", "outside the import trace", nil], ["lnd_1", "cut by a limit", nil], ["lnd_1", "not looked for", nil]],
                 c[:list].map { |r| r.values_at(:landing, :verdict, :rank) }
    assert_includes Coordination.markdown(report), "| Culprit precision against first red | 1 of 4 first-red answers among the suspects (25.0%; rank 2: 1), " \
                                                   "1 outside the import trace, 1 in the closure but cut by a limit, 1 with no suspects (certifications) |"
  end

  # Definition 17: lnd_4's two writers of src/a.ts split by their steps (one line each); lnd_5's cannot be split, so
  # its two lines are unattributed; lnd_6 (no note) is vouched for by the API. Kinds and models come from the notes.
  def test_lines_alive_on_trunk_by_model_and_kind
    l = report[:linesByModel]
    assert_equal({ landed: 3, added: 5, alive: 4, returns: 1, reverted: 0, aliveShare: 0.8, spend: { usd: 0.0012, input: 100, output: 50 } }, l[:byModel]["model-agt_1"])
    assert_equal({ landed: 3, added: 5, alive: 3, returns: 2, reverted: 1, aliveShare: 0.6, spend: nil }, l[:byModel]["model-agt_2"])
    assert_equal({ landed: 3, added: 6, alive: 6, returns: 1, reverted: 0, aliveShare: 1.0, spend: nil }, l[:byModel]["model-agt_3"])
    assert_equal({ landed: 0, added: 0, alive: 0, returns: 2, reverted: 0, aliveShare: nil, spend: nil }, l[:byModel]["declared-4"])
    assert_equal 2, l[:unattributedAdded]
    assert_equal({ "llm-review" => 0.0004 }, l[:spendNotMatched])
    assert_equal({ landed: 9, added: 16, alive: 13, returns: 4, reverted: 1, aliveShare: 0.8125 }, l[:byKind]["platform"])
    assert_equal({ landed: 0, added: 0, alive: 0, returns: 2, reverted: 0, aliveShare: nil }, l[:byKind]["external"])
    assert_includes Coordination.markdown(report), "| Lines alive on trunk by model | model-agt_3 6 of 6 added lines alive (100.0%), 3 landings, 1 return, 0 reverted · " \
                                                   "model-agt_1 4 of 5 added lines alive (80.0%), 3 landings, 1 return, 0 reverted, $0.0012 ·"
  end

  # Definitions 13, 14 and 16 on the fixture's record: one row each in the table.
  def test_markdown_rows_of_access_relands_and_residue
    md = Coordination.markdown(report)
    assert_includes md, "| Access by agent kind | external 50.0% of agents, 33.3% of landings,"
    assert_includes md, "| Access by model | declared-3 25.0% of agents, 33.3% of landings,"
    assert_includes md, "| Return to reland | 1 of 6 returns relanded (16.7%, 0 by the same agent), p50 180.0 s, p90 180.0 s;"
    assert_includes md, "| Residue and review rounds | 9 landed intents: 1.11 proposals to land (p90 1.2), 0.00 review rounds;"
  end

  # This record has no claim events, so every landed intent's clock starts at its first proposal.
  def test_where_the_time_went_from_the_colony_record
    t = report[:timeSplit]
    assert_equal [9, 9], t.values_at(:landedIntents, :noClaim)
    t[:perIntent].each { |r| assert_in_delta r[:total], %i[agentWork review waitingToLand rework].sum { |k| r[k] }, 1e-6, r[:intent] }
    # int_5: its first change came back stale at 30 s, and the change that landed was proposed at 208 s.
    int5 = t[:perIntent].find { |r| r[:intent] == "int_5" }
    assert_equal [0.0, 2.0, 0.0, 198.0], int5.values_at(:agentWork, :review, :waitingToLand, :rework)
    assert_equal({ givenBack: 0.0, cameBack: 20.0, toNextProposal: 178.0 }, int5[:reworkParts])
    assert_equal "int_10", t[:criticalPath][:intent]
  end

  # Through the command line: the API over HTTP (the record in two pages), the clone given with --clone.
  def test_command_line_over_http
    server, thread, url = Fixture.serve(self.class.fixture)
    Dir.mktmpdir("coordination-out") do |out|
      json = File.join(out, "report.json")
      stdout, stderr, status = Open3.capture3("ruby", Fixture::SCRIPT, "--url", url, "--colony", "fx", "--clone", self.class.fixture, "--json", json)
      assert status.success?, stderr
      assert_includes stdout, "| Proposals merged | 9 of 19 (0.474)"
      assert_includes stderr, "no lineage notes from #{url}/git/fx.git"
      r = JSON.parse(File.read(json), symbolize_names: true)
      %i[mergedFraction conflicts specialization sprawl linesPerIntent timeSplit takeTokens access relands culpritPrecision residue linesByModel].each { |k| assert_equal JSON.parse(JSON.generate(report[k]), symbolize_names: true), r[k], k }
      assert_equal report[:codeSharing][:lines], r[:codeSharing][:lines]
      assert_equal "src/a.ts", r[:hottestFile][:path]
    end
  ensure
    server&.close
    thread&.join(1)
  end

  # Through the command line with no API: the clone comes from <url>/git/<colony>.git (here a file URL) with its
  # notes, and what needs the record is reported as not computed.
  def test_command_line_without_an_api_clones_and_reports_what_it_cannot_compute
    Dir.mktmpdir("coordination-remote") do |root|
      FileUtils.mkdir_p(File.join(root, "srv/git"))
      Fixture.git(root, "clone", "--quiet", "--mirror", self.class.fixture, "srv/git/fx.git")
      clone = File.join(root, "kept")
      json = File.join(root, "report.json")
      stdout, stderr, status = Open3.capture3("ruby", Fixture::SCRIPT, "--url", "file://#{root}/srv", "--colony", "fx", "--clone", clone, "--json", json)
      assert status.success?, stderr
      assert File.directory?(File.join(clone, ".git")), "a --clone that did not exist is cloned into and kept"
      r = JSON.parse(File.read(json), symbolize_names: true)
      assert_nil r[:mergedFraction]
      assert_equal 7, r[:trunk][:notes][:found]
      assert_equal 1, r[:trunk][:knownFrom][:trailersOnly]
      # The note-less landing cannot be checked without the API, so its three lines join the two unsplittable ones;
      # and a clone never receives P5's step (a blob no commit reaches), so src/a.ts's two split lines join them too.
      assert_equal 7, r[:codeSharing][:lines][:unattributed]
      assert_equal 2, r[:regionDepth][:value]
      assert_includes stdout, "| Proposals merged | not computed: no event record |"
      assert_includes stdout, "- merged fraction: not computed, the event record could not be read (file://#{root}/srv is not an http(s) URL)"
      assert_nil r[:timeSplit]
      assert_includes stdout, "| Where the time went | not computed: no event record |"
      assert_includes stdout, "- where the time went: not computed, the event record could not be read"
      # Definitions 12 to 17: what needs the record or the API is not computed; lines by model come from git alone, with the
      # same seven unattributed lines (and no returns or spend).
      assert_nil r[:takeTokens][:source]
      assert_nil r[:culpritPrecision]
      %i[access relands residue].each { |k| assert_nil r[k], k }
      assert_includes stdout, "- coordination tokens per take: not computed"
      assert_includes stdout, "- culprit precision: not computed"
      assert_equal 7, r[:linesByModel][:unattributedAdded]
      assert_equal 0, r[:linesByModel][:byModel].values.sum { |x| x[:returns] }
    end
  end
end

# Definition 8 on a record with known phase times (seconds from T0). Events keep the order they are written in, which
# is the order of each intent's story; H's landed event carries a time a tenth of a second before its ready (clock skew).
module TimeFixture
  T0 = 1_800_000_000_000
  STALE = "stale: 1 path changed on trunk since read: src/b.ts (expected 1111111111, trunk 2222222222)"

  # The record's events for the named intents (all of them by default), as GET /events pages them.
  def self.page(only: nil, source: "recorded")
    list = []
    keep = ->(id) { only.nil? || only.include?(id) }
    add = ->(sec, e) { list << e.merge("at" => T0 + (sec * 1000).round) if keep.(e["intentId"] || e["for"]) }
    intent = ->(sec, id, status) { add.(sec, { "t" => "intent", "intentId" => id, "status" => status, "title" => "#{id} title", "footprint" => [] }) }
    prop = ->(sec, pid, iid, aid, status, reason = nil) { add.(sec, { "t" => "proposal", "proposalId" => pid, "intentId" => iid, "agentId" => aid, "status" => status }.merge(reason ? { "reason" => reason } : {})) }
    landing = ->(sec, id, iid, *pids) { add.(sec, { "t" => "landing", "landingId" => id, "trunkSha" => "", "proposalIds" => pids, "paths" => [], "for" => iid }) }
    %w[A B C D E F H X].each { |i| intent.(0, i, "open") }
    # A: claimed at 1, proposed at 11, ready at 13, landed at 16.
    intent.(1, "A", "claimed")
    prop.(11, "pa1", "A", "a1", "checking")
    prop.(13, "pa1", "A", "a1", "ready")
    prop.(16, "pa1", "A", "a1", "landed")
    landing.(16, "L1", "A", "pa1")
    # B: claimed at 2, proposed at 6, back stale at 9, claimed again at 10, proposed at 21, escalated at 22, a person
    # approved it at 40, landed at 41.
    intent.(2, "B", "claimed")
    prop.(6, "pb1", "B", "a2", "checking")
    prop.(9, "pb1", "B", "a2", "returned", STALE)
    intent.(9, "B", "open")
    intent.(10, "B", "claimed")
    prop.(21, "pb2", "B", "a2", "checking")
    prop.(22, "pb2", "B", "a2", "escalated")
    add.(40, { "t" => "decision", "decisionId" => "d1", "kind" => "triage", "layer" => "human", "p" => 1, "action" => "approve", "subject" => "pb2", "for" => "B" })
    prop.(40, "pb2", "B", "a2", "ready")
    prop.(41, "pb2", "B", "a2", "landed")
    landing.(41, "L3", "B", "pb2")
    # C: claimed at 3 and given back at 20, claimed again at 25, proposed straight to ready at 30 (review off), landed at 45.
    intent.(3, "C", "claimed")
    intent.(20, "C", "open")
    intent.(25, "C", "claimed")
    prop.(30, "pc1", "C", "a3", "ready")
    # D: no claim in the record; proposed at 5, ready at 6, landed at 8.
    prop.(5, "pd1", "D", "a4", "checking")
    prop.(6, "pd1", "D", "a4", "ready")
    prop.(8, "pd1", "D", "a4", "landed")
    landing.(8, "L2", "D", "pd1")
    # E: claimed at 1, proposed at 4, back at 7, never lands.
    intent.(1, "E", "claimed")
    prop.(4, "pe1", "E", "a5", "checking")
    prop.(7, "pe1", "E", "a5", "returned", "llm: the change does not do what the intent asks")
    # F, a contest: claimed at 9, changes proposed at 10 and 12, the first superseded at 16, the second ready at 18, landed at 20.
    intent.(9, "F", "claimed")
    prop.(10, "pf1", "F", "a1", "checking")
    prop.(12, "pf2", "F", "a6", "checking")
    prop.(16, "pf1", "F", "a1", "returned", "superseded: contest for F won by pf2 (smaller diff)")
    prop.(18, "pf2", "F", "a6", "ready")
    prop.(20, "pf2", "F", "a6", "landed")
    landing.(20, "L5", "F", "pf2")
    # H: claimed at 27, proposed at 28, ready at 29, landed at 28.9 by another object's clock.
    intent.(27, "H", "claimed")
    prop.(28, "ph1", "H", "a7", "checking")
    prop.(29, "ph1", "H", "a7", "ready")
    prop.(28.9, "ph1", "H", "a7", "landed")
    landing.(28.9, "L6", "H", "ph1")
    # X: claimed at 26, proposed at 35, ready at 36; X and C land together at 45, the run's last landing, X ready last.
    intent.(26, "X", "claimed")
    prop.(35, "px1", "X", "a8", "checking")
    prop.(36, "px1", "X", "a8", "ready")
    prop.(45, "pc1", "C", "a3", "landed")
    prop.(45, "px1", "X", "a8", "landed")
    landing.(45, "L4", "C", "pc1", "px1")
    # A vaccine change, left out.
    prop.(3, "pv1", "V", "agt_v", "checking")
    prop.(5, "pv1", "V", "agt_v", "rejected")
    events = list.each_with_index.map { |e, i| e.except("for").merge("seq" => i + 1) }
    { "source" => source, "total" => events.size, "events" => events }
  end

  def self.record(**kw) = Coordination::Record.new(page(**kw), vaccine_agents: Set["agt_v"])
end

class TimeSplitTest < Minitest::Test
  PHASES = %i[agentWork review waitingToLand rework].freeze

  def split(**kw) = Coordination.time_split(TimeFixture.record(**kw))

  def test_each_landed_intents_phases_add_up_to_its_claim_to_landing_time
    rows = split[:perIntent].to_h { |r| [r[:intent], r] }
    assert_equal %w[A B C D F H X], rows.keys.sort
    {
      "A" => [10, 2, 3, 0, 15], "B" => [4, 19, 1, 15, 39], "C" => [5, 0, 15, 22, 42], "D" => [0, 1, 2, 0, 3],
      "F" => [1, 6, 2, 2, 11], "H" => [1, 0.9, 0, 0, 1.9], "X" => [9, 1, 9, 0, 19]
    }.each do |id, (work, review, wait, rework, total)|
      r = rows[id]
      assert_equal [work, review, wait, rework, total], [*r.values_at(*PHASES), r[:total]], id
      assert_in_delta r[:total], PHASES.sum { |k| r[k] }, 1e-9, "#{id}: the phases add up to its time"
      assert_in_delta (r[:landedAt] - r[:claimedAt]) / 1000.0, r[:total], 1e-9, "#{id}: claimed to landed"
    end
    assert_equal({ givenBack: 0.0, cameBack: 3.0, toNextProposal: 12.0 }, rows["B"][:reworkParts])
    assert_equal({ givenBack: 22.0, cameBack: 0.0, toNextProposal: 0.0 }, rows["C"][:reworkParts])
    assert_equal({ givenBack: 0.0, cameBack: 2.0, toNextProposal: 0.0 }, rows["F"][:reworkParts])
    assert_equal [2, 1, 2], rows.values_at("B", "D", "F").map { |r| r[:proposals] }
    refute rows["D"][:claimed]
  end

  def test_totals_medians_and_the_share_spent_waiting_to_land
    t = split
    assert_equal 7, t[:landedIntents]
    assert_equal 1, t[:noClaim]
    assert_equal({ agentWork: 30.0, review: 29.9, waitingToLand: 32.0, rework: 39.0, total: 130.9 }, t[:agentSeconds])
    assert_equal({ agentWork: 4.0, review: 1.0, waitingToLand: 2.0, rework: 0.0 }, t[:median])
    assert_in_delta 32 / 130.9, t[:waitingShare], 1e-4
    assert_in_delta 1.0, t[:share].values.sum, 1e-3
    refute t[:estimatedClaims]
    assert_nil t[:note]
  end

  def test_the_critical_path_behind_the_last_landing_follows_the_change_ready_last
    c = split[:criticalPath]
    assert_equal ["L4", 45.0, 2, "X", "px1"], c.values_at(:landing, :at, :changesInLanding, :intent, :proposal)
    assert_equal({ agentWork: 9.0, review: 1.0, waitingToLand: 9.0, rework: 0.0 }, c[:phases])
    assert_equal 19.0, c[:total]
    assert_equal [["declared", 0.0], ["claimed", 26.0], ["proposal", 35.0], ["lane and trunk writer", 36.0]], c[:steps].map { |s| [s[:step], s[:at]] }
    assert_equal 9.0, c[:steps].last[:seconds]
    # When the last landing's change came back first, the path shows each proposal and why it went back.
    b = split(only: %w[B])[:criticalPath]
    assert_equal [["claimed", 2.0], ["claimed", 10.0]], b[:steps].select { |s| s[:step] == "claimed" }.map { |s| [s[:step], s[:at]] }
    assert_equal([["pb1", "returned", "stale"], ["pb2", "ready", nil]], b[:steps].select { |s| s[:step] == "proposal" }.map { |s| s.values_at(:proposal, :outcome, :class) })
    # A contest's other change that lost is a change of direction, not a failure.
    f = split(only: %w[F])
    assert_equal [%w[pf1 redirected], ["pf2", nil]], f[:criticalPath][:steps].select { |s| s[:step] == "proposal" }.map { |s| s.values_at(:proposal, :class) }
    assert_includes Coordination.time_rows(f)[1], "2 proposals, 1 came back (redirected); agent work 1.0 s, rework 2.0 s, review 6.0 s"
  end

  def test_markdown_rows
    rows = Coordination.time_rows(split)
    assert_equal "| Where the time went | 130.9 agent-seconds over 7 landed intents, from claim to landing: agent work 30.0 (22.9%, median 4.0 s), " \
                 "review 29.9 (22.8%, median 1.0 s), waiting to land 32.0 (24.4%, median 2.0 s), rework 39.0 (29.8%, median 0.0 s); " \
                 "24.4% of agent time waiting to land; 1 intent with no claim in the record |", rows[0]
    assert_equal "| Critical path to the last landing | `X` (X title) landed at +45.0 s in L4 (2 changes): claimed at +26.0 s, 1 proposal; " \
                 "agent work 9.0 s, rework 0.0 s, review 1.0 s, ready to landed 9.0 s (the lane and the trunk writer together); " \
                 "19.0 s from claim to landing |", rows[1]
    b = Coordination.time_rows(split(only: %w[B]))
    assert_includes b[1], "claimed at +2.0 s, 2 proposals, 1 came back (stale); agent work 4.0 s, rework 15.0 s, review 19.0 s"
  end

  def test_a_reconstructed_record_labels_its_estimated_claim_times
    t = split(source: "reconstructed")
    assert t[:estimatedClaims]
    assert_match(/claim times are estimated/, t[:note])
    rows = Coordination.time_rows(t)
    assert_includes rows[0], "; claim times estimated (reconstructed record); 1 intent with no claim in the record |"
    assert_includes rows[1], "claimed at +26.0 s (estimated)"
  end

  def test_a_record_with_nothing_landed
    t = split(only: %w[E])
    assert_equal 0, t[:landedIntents]
    assert_nil t[:criticalPath]
    assert_equal ["| Where the time went | no landed intent in the record |"], Coordination.time_rows(t)
  end

  def test_covered_counts_overlapping_spans_once
    assert_equal 6, Coordination.covered([[0, 4], [2, 6], [8, 9]], 0, 7)
    assert_equal 0, Coordination.covered([], 0, 10)
    assert_equal 3, Coordination.covered([[5, 20]], 0, 8)
  end
end

# Definition 10 on a small record: the closure ledger's causes per agent kind, the reaped agents' gaps, and the closes
# recorded before the ledger.
class ClosuresTest < Minitest::Test
  AGENTS = [
    { "id" => "agt_walk", "kind" => "external" }, { "id" => "agt_mcp", "kind" => "external" }, { "id" => "agt_in", "kind" => "internal" },
    { "id" => "agt_syn", "kind" => "synthetic" }, { "id" => "agt_v", "kind" => "synthetic", "name" => "vaccine", "model" => "vaccine" }
  ].freeze

  def record
    events = []
    intent = lambda do |at, id, status, extra = {}|
      events << { "t" => "intent", "at" => at, "intentId" => id, "status" => status, "title" => id, "footprint" => [] }.merge(extra)
    end
    intent.(1, "int_a", "open")
    intent.(2, "int_a", "claimed")
    intent.(100, "int_a", "open", "cause" => "reaped_silent", "agentId" => "agt_walk", "agentKind" => "external", "gapMs" => 97_000)
    intent.(110, "int_a", "claimed")
    intent.(120, "int_a", "landed", "cause" => "landed", "agentId" => "agt_syn", "agentKind" => "synthetic", "gapMs" => 1_000)
    intent.(130, "int_b", "claimed")
    intent.(140, "int_b", "open", "cause" => "released", "agentId" => "agt_mcp", "gapMs" => 0)
    intent.(150, "int_c", "claimed")
    intent.(160, "int_c", "open", "cause" => "reaped_silent", "agentId" => "agt_mcp", "agentKind" => "external", "gapMs" => 125_000)
    intent.(170, "int_d", "claimed")
    intent.(180, "int_d", "open", "cause" => "gave_up", "agentId" => "agt_in", "agentKind" => "internal", "gapMs" => 0)
    # Before the ledger: a held intent reopened with no cause, and one that landed.
    intent.(190, "int_e", "proposed")
    intent.(200, "int_e", "open")
    intent.(210, "int_f", "claimed")
    intent.(220, "int_f", "landed")
    # A vaccine's closure, and a cause the ledger does not know, are left out.
    intent.(230, "int_v", "landed", "cause" => "landed", "agentId" => "agt_v", "agentKind" => "synthetic")
    intent.(240, "int_g", "open", "cause" => "vanished", "agentId" => "agt_in")
    Coordination::Record.new({ "source" => "recorded", "total" => events.size, "events" => events }, vaccine_agents: Set["agt_v"])
  end

  def test_shares_per_agent_kind_and_the_reaped_gaps
    c = Coordination.closures(record, AGENTS)
    assert_equal 5, c[:closures]
    assert_equal 2, c[:beforeLedger]
    assert_equal({ total: 3, counts: { "released" => 1, "reaped_silent" => 2 }, shares: { "released" => 0.3333, "reaped_silent" => 0.6667 } }, c[:byKind]["external"])
    assert_equal({ total: 1, counts: { "gave_up" => 1 }, shares: { "gave_up" => 1.0 } }, c[:byKind]["internal"])
    assert_equal({ total: 1, counts: { "landed" => 1 }, shares: { "landed" => 1.0 } }, c[:byKind]["synthetic"])
    assert_equal({ count: 2, medianGapMs: 111_000.0, maxGapMs: 125_000 }, c[:reaped])
  end

  def test_markdown_row
    row = Coordination.closure_row(Coordination.closures(record, AGENTS))
    assert_equal "| Closures | 5 recorded: external 3 (released 1, 33.3%; reaped silent 2, 66.7%) · in-platform 1 (gave up 1, 100.0%) · " \
                 "synthetic 1 (landed 1, 100.0%); 2 intents taken back from silent agents, median gap 1 min 51 s (largest 2 min 5 s); " \
                 "2 closes recorded before the ledger, in no share |", row
    assert_equal "| Closures | none recorded; 1 close recorded before the ledger, in no share |",
                 Coordination.closure_row({ closures: 0, byKind: {}, reaped: { count: 0 }, beforeLedger: 1 })
  end
end

# Definition 11 on a small record: returns by the heads-up's sentence at the end of their reason.
class HeadsUpTest < Minitest::Test
  MOVED = "stale: 1 path changed on trunk since read: src/a.ts. Landing lnd_x moved it. Keep what that landing did unless your intent says otherwise, and escalate if both cannot hold."

  def record
    events = []
    back = ->(id, at, reason) { events << { "t" => "proposal", "at" => at, "proposalId" => id, "intentId" => "int_#{id}", "agentId" => "agt_1", "status" => "returned", "reason" => reason } }
    back.("prp_w", 10, "#{MOVED} You were told of lnd_x at 12:03:10 UTC, 40 s before you proposed.")
    back.("prp_a", 20, "#{MOVED} Landing lnd_x came after your last reply, so you could not have known.")
    back.("prp_n", 30, "#{MOVED} No reply named landing lnd_x before you proposed, so you could not have known.")
    back.("prp_o", 40, MOVED)
    back.("prp_r", 50, "withdrawn: the intent was called off")
    events << { "t" => "proposal", "at" => 60, "proposalId" => "prp_l", "intentId" => "int_l", "agentId" => "agt_1", "status" => "landed" }
    Coordination::Record.new({ "source" => "recorded", "total" => events.size, "events" => events })
  end

  def test_returns_by_what_the_heads_up_had_told_their_agent
    h = Coordination.heads_up(record, { "metrics" => { "headsUp.warned" => 1, "headsUp.unwarned" => 2 } })
    assert_equal({ returns: 4, warned: 1, unwarned: 2, none: 1, colonyCounters: { warned: 1, unwarned: 2 } }, h)
    assert_equal "| Heads-up before returns | 1 warned and proposed anyway, 2 could not have known (of 4 returns; 1 with no heads-up) |", Coordination.heads_up_row(h)
  end

  def test_no_row_without_a_heads_up
    assert_nil Coordination.heads_up_row({ returns: 3, warned: 0, unwarned: 0, none: 3, colonyCounters: {} })
    assert_nil Coordination.heads_up_row(nil)
  end
end

# Small event records for definitions 13 to 16, times in seconds; events keep the order they are written in.
module Small
  def self.record(&block)
    events = []
    Builder.new(events).instance_eval(&block)
    page = { "source" => "recorded", "total" => events.size, "events" => events.each_with_index.map { |e, i| e.merge("seq" => i + 1) } }
    Coordination::Record.new(page, vaccine_agents: Set["v"])
  end

  # What a test writes into a record.
  class Builder
    def initialize(events)
      @events = events
    end

    def intent(at, id, status) = add(at, "t" => "intent", "intentId" => id, "status" => status, "title" => "#{id} title", "footprint" => [])
    def landing(at, id, *proposals) = add(at, "t" => "landing", "landingId" => id, "trunkSha" => "", "proposalIds" => proposals, "paths" => [])
    def decision(at, subject, layer, action) = add(at, "t" => "decision", "decisionId" => "dec_#{@events.size}", "kind" => "triage", "layer" => layer, "p" => 1, "action" => action, "subject" => subject)
    def certify(at, sha, status, suspects = nil) = add(at, { "t" => "certify", "trunkSha" => sha, "status" => status }.merge(suspects ? { "suspects" => suspects } : {}))
    def bisect(at, sha, first_red) = add(at, "t" => "bisect", "trunkSha" => sha, "firstRed" => first_red)

    def prop(at, id, intent, agent, status, reason = nil)
      add(at, { "t" => "proposal", "proposalId" => id, "intentId" => intent, "agentId" => agent, "status" => status }.merge(reason ? { "reason" => reason } : {}))
    end

    private

    def add(at, event) = @events << event.merge("at" => at * 1000)
  end
end

# Definition 12 from the colony's counters, and the landing index a rebuilt take reads.
class TakeTokensTest < Minitest::Test
  # The counters of three takes (colony/coordtokens.ts): two with 2 or 3 agents active, one with 8 to 15, and one heads-up.
  COUNTERS = {
    "coord.takes" => 3, "coord.chars.context" => 1_000, "coord.chars.guide" => 800, "coord.chars.lastReturn" => 200, "coord.chars.headsUp" => 1_200,
    "coord.headsUps" => 1, "coord.agents" => 14, "coord.everything" => 50_000, "coord.byAgents.2.takes" => 2, "coord.byAgents.2.chars" => 800,
    "coord.byAgents.2.everything" => 10_000, "coord.byAgents.8.takes" => 1, "coord.byAgents.8.chars" => 1_200, "coord.byAgents.8.everything" => 40_000, "takes" => 3
  }.freeze

  def test_tokens_per_take_from_the_colony_counters
    t = Coordination.take_tokens(COUNTERS, { takes: 5 })
    assert_equal "counters", t[:source]
    assert_match(/ESTIMATE/, t[:estimate])
    c = t[:counted]
    assert_equal({ "context" => 83.3, "guide" => 66.7, "lastReturn" => 16.7, "review" => 0.0, "headsUp" => 100.0 }, c[:perTake])
    assert_equal [3, 166.7, 266.7, 4_166.7, 4.7, 1], c.values_at(:takes, :atTakeTokensPerTake, :tokensPerTake, :readEverythingTokensPerTake, :agentsPerTake, :headsUps)
    assert_equal [{ agents: "2-3", from: 2, takes: 2, tokensPerTake: 100.0, readEverythingTokensPerTake: 1_250.0 },
                  { agents: "8-15", from: 8, takes: 1, tokensPerTake: 300.0, readEverythingTokensPerTake: 10_000.0 }], c[:byAgents]
    assert_equal({ from: "2-3", to: "8-15", takes: 3.0, readEverything: 8.0 }, c[:flat])
    assert_equal "| Coordination tokens per take (ESTIMATE, chars / 4) | 166.7 at take (why-context 83.3, guide 66.7, last return 16.7, review 0.0) " \
                 "and 100.0 of heads-up, over 3 takes with 4.7 agents active on average; reading everything 4,166.7; by active agents 2-3: 100.0, " \
                 "8-15: 300.0; largest bucket over smallest: ×3.00 at take, ×8.00 to read everything |", Coordination.take_tokens_row(t)
  end

  def test_no_counters_and_no_takes
    t = Coordination.take_tokens({ "takes" => 9 }, { takes: 0 })
    assert_nil t[:source]
    assert_equal "| Coordination tokens per take (ESTIMATE) | not computed: no take counted or in the record |", Coordination.take_tokens_row(t)
    assert_nil Coordination.take_tokens(nil, nil)[:source]
    assert_equal [1, 1, 2, 2, 4, 64], [0, 1, 2, 3, 7, 80].map { |n| Coordination.agent_bucket(n) }
  end

  def test_the_landing_index_picks_the_newest_three_groups_of_the_paths_a_footprint_covers
    row = ->(path, at, landing, intent, sha = landing[-1] * 40) { { path: path, at: at, landing: landing, intent: intent, sha: sha } }
    index = Coordination::LandedIndex.new([
                                            row.("src/a.ts", 10, "L1", "i1"), row.("src/a.ts", 20, "L2", "i2"), row.("src/a.ts", 30, "L3", "i3"),
                                            row.("src/a.ts", 40, "L4", "i4"), row.("src/lib/b.ts", 35, "L4", "i4"), row.("src/lib/b.ts", 50, "L5", "i5", nil),
                                            row.("srcx/c.ts", 45, "L6", "i6"), row.("docs/x.md", 5, "L0", nil)
                                          ])
    texts = { "i4" => { title: "T" * 250, why: "line one\n  line two" } }
    # A directory at 45: lnd L4 joins its two paths and keeps its newest time; srcx/ is not under src/.
    got = index.context(["src/"], 45, texts)
    assert_equal [["L4", 40, %w[src/a.ts src/lib/b.ts]], ["L3", 30, ["src/a.ts"]], ["L2", 20, ["src/a.ts"]]], got.map { |g| g.values_at(:landingId, :at, :paths) }
    assert_equal ["#{'T' * 199}…", "line one line two", "4" * 40, "i4"], got.first.values_at(:title, :why, :trunkSha, :intentId)
    # A glob: L5 (no commit known) is newest; each path keeps its newest three landings.
    assert_equal %w[L5 L4 L3], index.context(["src/**/*.ts"], 100, texts).map { |g| g[:landingId] }
    refute index.context(["src/**/*.ts"], 100, texts).first.key?(:trunkSha)
    # A literal path; a landing outside an intent has no intentId; "**" has no directory to search.
    assert_equal [{ landingId: "L0", at: 5, title: "", why: "", paths: ["docs/x.md"], trunkSha: "0" * 40 }], index.context(["**", "docs/x.md"], 100, texts)
    assert_equal ["L1"], index.context(["./src/a.ts"], 15, texts).map { |g| g[:landingId] }
    assert_nil index.context(["src/a.ts"], 5, texts)
    # A directory reads the first 300 index rows under it in path order, as the colony's range query does: of 150 paths
    # with three landings each, the first 100, so the newest groups it finds are those of big/p099.
    rows = (0...150).flat_map { |i| (0...3).map { |k| row.(format("big/p%03d.ts", i), (i * 10) + k, format("B%03d-%d", i, k), "i") } }
    assert_equal %w[B099-2 B099-1 B099-0], Coordination::LandedIndex.new(rows).context(["big/"], 10_000, {}).map { |g| g[:landingId] }
    assert_equal %w[B149-2 B149-1 B149-0], Coordination::LandedIndex.new(rows).context(["big/p149.ts"], 10_000, {}).map { |g| g[:landingId] }
  end
end

# Definition 13 on a small record: two in-platform agents, two external ones (one never proposed), and one known only
# from its notes; a1 lands in two cycles running.
class AccessTest < Minitest::Test
  AGENTS = [
    { "id" => "a1", "kind" => "internal", "model" => "m-fast" }, { "id" => "a2", "kind" => "internal", "model" => "m-fast" },
    { "id" => "a3", "kind" => "external", "model" => "m-ext" }, { "id" => "a4", "kind" => "external", "model" => "m-ext" },
    { "id" => "v", "kind" => "synthetic", "name" => "vaccine", "model" => "vaccine" }
  ].freeze

  def record
    Small.record do
      intent(0, "i1", "claimed")
      prop(10, "p1", "i1", "a1", "checking")
      prop(12, "p1", "i1", "a1", "escalated")
      prop(30, "p1", "i1", "a1", "landed")
      landing(30, "L1", "p1")
      intent(5, "i2", "claimed")
      prop(15, "p2", "i2", "a3", "checking")
      prop(20, "p2", "i2", "a3", "returned", "stale: src/a.ts (expected a, trunk has b)")
      intent(21, "i2", "claimed")
      prop(25, "p3", "i2", "a3", "checking")
      intent(31, "i4", "claimed")
      prop(32, "p5", "i4", "a1", "checking")
      prop(40, "p5", "i4", "a1", "landed")
      landing(40, "L2", "p5")
      prop(35, "p4", "i3", "a2", "checking")
      prop(50, "p3", "i2", "a3", "landed")
      landing(50, "L3", "p3")
      prop(60, "p4", "i3", "a2", "landed")
      landing(60, "L4", "p4")
      prop(61, "p6", "i5", "a1", "checking")
      prop(62, "p6", "i5", "a1", "returned", "withdrawn: no longer needed")
      prop(63, "p7", "i6", "a5", "checking")
      prop(3, "pv", "iv", "v", "checking")
      prop(4, "pv", "iv", "v", "rejected")
    end
  end

  def test_shares_waits_returns_and_the_next_cycle_per_kind_and_model
    a = Coordination.access(record, AGENTS, { "a5" => { kind: "synthetic", model: "m-syn" } })
    assert_equal [5, 4, 4], a.values_at(:agents, :landed, :cycles)
    platform = { agents: 2, agentShare: 0.4, landed: 3, landingShare: 0.75, claimToLanding: { p50: 25.0, p90: 29.0 }, proposals: 4, returnsPerProposal: 0.0,
                 toPerson: 0.25, topAgent: { agent: "a1", landed: 2, share: 0.6667 }, nextCycle: { landed: 2, again: 1, share: 0.5 } }
    external = { agents: 2, agentShare: 0.4, landed: 1, landingShare: 0.25, claimToLanding: { p50: 29.0, p90: 29.0 }, proposals: 2, returnsPerProposal: 0.5,
                 toPerson: 0.0, topAgent: { agent: "a3", landed: 1, share: 1.0 }, nextCycle: { landed: 1, again: 0, share: 0.0 } }
    synthetic = { agents: 1, agentShare: 0.2, landed: 0, landingShare: 0.0, claimToLanding: { p50: nil, p90: nil }, proposals: 1, returnsPerProposal: 0.0,
                  toPerson: 0.0, topAgent: nil, nextCycle: { landed: 0, again: 0, share: nil } }
    assert_equal({ "external" => external, "platform" => platform, "synthetic" => synthetic }, a[:byKind])
    assert_equal({ "m-ext" => external, "m-fast" => platform, "m-syn" => synthetic }, a[:byModel])
    assert_equal({ landed: 3, again: 1, share: 0.3333 }, a[:all][:nextCycle])
    assert_equal({ agent: "a1", landed: 2, share: 0.5 }, a[:all][:topAgent])
    rows = Coordination.access_rows(a)
    assert_includes rows[0], "platform 40.0% of agents, 75.0% of landings, claim to landing p50 25.0 s p90 29.0 s, 0.00 returns a proposal, 25.0% to a person, " \
                             "top agent 66.7%, next cycle 50.0%"
    assert rows[1].start_with?("| Access by model | m-fast 40.0% of agents")
  end
end

# Definition 14 on a small record: two returns that relanded (one by the same agent), two that did not, and a redirect.
class RelandsTest < Minitest::Test
  AGENTS = [{ "id" => "a1", "kind" => "internal" }, { "id" => "a2", "kind" => "external" }, { "id" => "a3", "kind" => "external" }].freeze

  def record
    Small.record do
      prop(5, "p1", "i1", "a1", "checking")
      prop(10, "p1", "i1", "a1", "returned", "stale: src/a.ts (expected a, trunk has b)")
      prop(30, "p2", "i1", "a1", "checking")
      prop(40, "p2", "i1", "a1", "landed")
      prop(15, "p3", "i2", "a2", "checking")
      prop(20, "p3", "i2", "a2", "returned", "llm: the change does not do what the intent asks")
      prop(25, "p4", "i2", "a3", "checking")
      prop(30, "p4", "i2", "a3", "landed")
      prop(45, "p5", "i3", "a2", "checking")
      prop(50, "p5", "i3", "a2", "returned", "stale: src/b.ts (expected c, trunk has d)")
      prop(52, "p6", "i4", "a1", "checking")
      prop(55, "p6", "i4", "a1", "returned", "superseded: contest for i4 won by p9 (smaller diff)")
      prop(57, "p7", "i5", "a1", "checking")
      prop(60, "p7", "i5", "a1", "returned", "please split this change")
      decision(60, "p7", "human", "return")
    end
  end

  def test_reland_rate_and_time_per_kind_and_cause
    r = Coordination.relands(record, AGENTS)
    assert_equal({ returns: 4, relanded: 2, rate: 0.5, sameAgent: 1, p50: 20.0, p90: 28.0 }, r[:all])
    assert_equal({ "external" => { returns: 2, relanded: 1, rate: 0.5, sameAgent: 0, p50: 10.0, p90: 10.0 },
                   "platform" => { returns: 2, relanded: 1, rate: 0.5, sameAgent: 1, p50: 30.0, p90: 30.0 } }, r[:byKind])
    assert_equal({ "review" => { returns: 2, relanded: 1, rate: 0.5, sameAgent: 0, p50: 10.0, p90: 10.0 },
                   "stale" => { returns: 2, relanded: 1, rate: 0.5, sameAgent: 1, p50: 30.0, p90: 30.0 } }, r[:byClass])
    assert_equal({ returns: 1, relanded: 0, rate: 0.0, sameAgent: 0, p50: nil, p90: nil }, r[:byKindAndClass]["platform review"])
    assert_equal %w[external\ review external\ stale platform\ review platform\ stale], r[:byKindAndClass].keys
    assert_equal "| Return to reland | 2 of 4 returns relanded (50.0%, 1 by the same agent), p50 20.0 s, p90 28.0 s; by kind external 1/2, platform 1/2; " \
                 "by cause review 1/2, stale 1/2 |", Coordination.relands_row(r)
  end
end

# Definition 15: each verdict, and the record's certify and bisect events when the certifications cannot be read.
class CulpritPrecisionTest < Minitest::Test
  def test_a_first_red_answer_with_no_closure_recorded
    certs = [{ "status" => "red", "trunkSha" => "a" * 40, "suspects" => [{ "landingId" => "lnd_9" }], "firstRed" => { "status" => "found", "landingId" => "lnd_1" } }]
    c = Coordination.culprit_precision(certs)
    assert_equal [1, 0, 1], c.values_at(:answers, :suspect, :closureNotRecorded)
    assert_includes Coordination.culprit_row(c.merge(source: "certifications")), ", 1 closure not recorded (certifications) |"
    assert_equal "| Culprit precision against first red | no first-red answer found a commit (events: suspects stop at 5) |",
                 Coordination.culprit_row(Coordination.culprit_precision([]).merge(source: "events: suspects stop at 5"))
  end

  def test_from_the_record_events
    record = Small.record do
      certify(10, "a" * 40, "running")
      certify(20, "a" * 40, "red", [{ "landingId" => "lnd_2" }, { "landingId" => "lnd_1" }])
      certify(25, "b" * 40, "red")
      bisect(30, "a" * 40, { "status" => "found", "landingId" => "lnd_1", "proposals" => [{ "id" => "prp_1", "paths" => ["a.ts"] }] })
      bisect(31, "b" * 40, { "status" => "found", "landingId" => "lnd_3", "proposals" => [] })
    end
    c = Coordination.culprit_precision(Coordination.certifications_from(record))
    assert_equal [2, 1, 1, { 2 => 1 }], c.values_at(:answers, :suspect, :outsideImportTrace, :ranks)
  end
end

# Definition 18 on the fixtures the colony's own tests use (packages/worker/test/certify/health.test.ts): the same numbers
# and the same line. Landing i lands at minute i; a result names its landing's commit.
class TrunkHealthTest < Minitest::Test
  T = 1_800_000_000_000
  def m(x) = T + (x * 60_000).round
  def landing(i, intents = []) = { id: "lnd_#{i}", sha: "sha#{i}", at: m(i), intents: intents }

  def result(i, status, start, finish, extra = {})
    { "trunkSha" => "sha#{i}", "landingId" => "lnd_#{i}", "status" => status, "startedAt" => m(start), "finishedAt" => m(finish) }.merge(extra)
  end

  def health(certs, landings, now:, **opts) = Coordination.trunk_health(certs.reverse, landings: landings, now: now, **opts)

  def test_no_red
    h = health([result(2, "green", 2.2, 2.5), result(5, "skipped", 5.2, 5.3, "detail" => "the run judged nothing"), result(9, "green", 9.2, 9.6)], (0..9).map { |i| landing(i) }, now: m(20))
    assert_equal({ from: m(2), to: m(20), landings: 8, results: 2 }, h[:window])
    assert_equal({ count: 0, open: 0, per100Landings: 0.0 }, h[:episodes])
    assert_equal [0, 0.0, 0], [h[:red][:ms], h[:red][:share], h[:red][:toGreen][:episodes]]
    assert_equal({ landings: 0, afterRedKnown: 0, repairs: 0 }, h[:builtOnRed])
    assert_equal [{ minutes: 5, landings: 8, certified: 6, share: 0.75 }, { minutes: 15, landings: 8, certified: 8, share: 1.0 }, { minutes: 60, landings: 8, certified: 8, share: 1.0 }], h[:certifiedWithin]
    assert_equal "red 0 times in 8 landings, 0 landings built on red", h[:text]
  end

  def test_one_episode_fixed_by_a_repair
    landings = (0..4).map { |i| landing(i) } + [landing(5, ["int_r"]), landing(6)]
    certs = [result(1, "green", 1.2, 1.5), result(3, "red", 3.2, 3.5, "repairIntentId" => "int_r", "firstRed" => { "status" => "found", "trunkSha" => "sha2", "landingId" => "lnd_2" }),
             { "trunkSha" => "shaX", "status" => "error", "startedAt" => m(4.1), "finishedAt" => m(4.2), "detail" => "out of time" },
             result(4, "red", 4.3, 4.5), result(5, "green", 5.2, 5.5)]
    asked = []
    spend = lambda do |ids|
      asked << ids
      { usd: 0.0123, calls: 3, intents: 1 }
    end
    h = health(certs, landings, now: m(10), holds: { "int_r" => { closed_ms: 90_000, since: nil } }, spend: spend)
    assert_equal({ count: 1, open: 0, per100Landings: 16.67 }, h[:episodes])
    assert_equal 120_000, h[:red][:ms]
    assert_equal({ episodes: 1, p50Ms: 120_000, p90Ms: 120_000, maxMs: 120_000 }, h[:red][:toGreen])
    assert_nil h[:red][:since]
    assert_equal({ landings: 2, afterRedKnown: 1, repairs: 1 }, h[:builtOnRed])
    assert_equal({ intents: 1, agentMs: 90_000, held: 0, spend: { usd: 0.0123, calls: 3, intents: 1 } }, h[:repair])
    assert_equal [["int_r"]], asked
    assert_equal "red 1 time in 6 landings, 2.0 min to green at p50, 2 landings built on red", h[:text]
  end

  def test_red_over_several_landings_with_landings_built_on_red
    landings = (0..3).map { |i| landing(i) } + [landing(4, ["int_r1"]), landing(5), landing(6), landing(7, ["int_r2"])] + (8..12).map { |i| landing(i) }
    certs = [result(1, "green", 1.2, 1.5), result(3, "red", 3.2, 3.5, "repairIntentId" => "int_r1", "firstRed" => { "status" => "found", "trunkSha" => "sha2", "landingId" => "lnd_2" }),
             result(5, "red", 5.2, 5.5, "repairIntentId" => "int_r2"), result(8, "green", 8.2, 9.5), result(10, "red", 10.2, 10.5), result(12, "green", 12.2, 14.5)]
    h = health(certs, landings, now: m(20))
    assert_equal [2, 16.67, 600_000], [h[:episodes][:count], h[:episodes][:per100Landings], h[:red][:ms]]
    g = h[:red][:toGreen]
    assert_equal [2, 300_000, 360_000], g.values_at(:episodes, :p50Ms, :maxMs)
    assert_in_delta 348_000, g[:p90Ms], 1e-6
    assert_equal({ landings: 4, afterRedKnown: 3, repairs: 3 }, h[:builtOnRed])
    assert_equal 2, h[:repair][:intents]
    assert_equal "red 2 times in 12 landings, 5.0 min to green at p50, 4 landings built on red", h[:text]
  end

  def test_still_red_at_the_end_of_the_window
    landings = (0..5).map { |i| landing(i) } + [landing(6, ["int_r"]), landing(7)]
    holds = Coordination.holds({ "int_r" => [[m(3.5), "open"], [m(4), "claimed"], [m(5), "open"], [m(5.5), "claimed"], [m(6), "proposed"]] })
    assert_equal({ "int_r" => { closed_ms: 60_000, since: m(5.5) } }, holds)
    h = health([result(1, "green", 1.2, 1.5), result(3, "red", 3.2, 3.5, "repairIntentId" => "int_r")], landings, now: m(10), holds: holds)
    assert_equal({ count: 1, open: 1, per100Landings: 14.29 }, h[:episodes])
    assert_equal [m(3.5), 390_000, 0.7222], [h[:red][:since], h[:red][:ms], h[:red][:share]]
    assert_equal({ landings: 2, afterRedKnown: 2, repairs: 1 }, h[:builtOnRed])
    assert_equal({ intents: 1, agentMs: 330_000, held: 1 }, h[:repair])
    assert_equal [{ minutes: 5, landings: 4, certified: 1, share: 0.25 }, { minutes: 15, landings: 1, certified: 1, share: 1.0 }], h[:certifiedWithin].first(2)
    assert_equal "red 1 time in 7 landings, red now for 6.5 min, 2 landings built on red", h[:text]
  end

  def test_no_tests_off_and_no_verdict_say_why
    assert_equal({ status: "no-tests", reason: "no test files (*.test.ts or *.test.js)", text: "trunk health not measured: certification found no test this platform can run" },
                 health([result(0, "skipped", 0.2, 0.3, "detail" => "no test files (*.test.ts or *.test.js)")], [landing(0)], now: m(1)))
    off = { "deployment" => true, "runner" => true, "policy" => { "enabled" => false } }
    assert_equal({ status: "off", reason: "trunk certification is off for this colony", text: "trunk health not measured: trunk certification is off for this colony" },
                 health([], [], now: m(1), state: off))
    assert_equal "trunk health not measured yet: no certification has judged trunk", health([], [], now: m(1))[:text]
    assert_equal "the last certification could not run (out of time)", health([result(0, "error", 0.2, 0.3, "detail" => "out of time.")], [], now: m(1))[:reason]
    assert_equal "| Trunk health | trunk health not measured: trunk certification is off for this colony (trunk certification is off for this colony) |",
                 Coordination.trunk_health_row(health([], [], now: m(1), state: off))
  end

  def test_words_and_the_row
    assert_equal ["30 s", "3.4 min", "12 min", "2.5 h", "3.5 d"], [30_000, 204_000, 720_000, 9_000_000, 300_000_000].map { |ms| Coordination.span(ms) }
    landings = (0..4).map { |i| landing(i) } + [landing(5, ["int_r"]), landing(6)]
    h = health([result(1, "green", 1.2, 1.5), result(3, "red", 3.2, 3.5, "repairIntentId" => "int_r"), result(5, "green", 5.2, 5.5)], landings, now: m(10),
               holds: { "int_r" => { closed_ms: 90_000, since: nil } }, spend: ->(_) { { usd: 0.0123, calls: 3, intents: 1 } })
    assert_equal "| Trunk health | red 1 time in 6 landings, 2.0 min to green at p50, 1 landing built on red; red 22.2% of the 9.0 min measured; " \
                 "to green p90 2.0 min, longest 2.0 min; 1 built on known red, 1 fix; 1 repair intent held 1.5 min by agents, $0.0123; " \
                 "certified within 5 min 100.0%, 15 min 100.0%, 60 min 100.0%; the colony says: red 9 times |",
                 Coordination.trunk_health_row(h.merge(colonySays: "red 9 times"))
  end

  # Through the report: the fixture's landing commits with the record's landing times, results naming landings, the
  # repair's spend from the API, and the colony's own line beside it.
  class Api < Fixture::FakeApi
    def certifications_page(_id)
      found = { "status" => "found", "landingId" => "lnd_2", "proposals" => [{ "id" => "prp_2", "paths" => ["src/b.ts"] }] }
      at = ->(s) { Fixture::T0 + (s * 1000) }
      { "deployment" => true, "runner" => true, "policy" => { "enabled" => true }, "results" => [
        { "trunkSha" => "e" * 40, "landingId" => "lnd_5", "status" => "green", "startedAt" => at.(275), "finishedAt" => at.(280) },
        { "trunkSha" => "d" * 40, "landingId" => "lnd_3", "status" => "red", "startedAt" => at.(165), "finishedAt" => at.(170), "repairIntentId" => "int_5",
          "suspects" => [{ "landingId" => "lnd_2" }], "firstRed" => found },
        { "trunkSha" => "c" * 40, "landingId" => "lnd_1", "status" => "green", "startedAt" => at.(45), "finishedAt" => at.(50) }
      ] }
    end

    def metrics(_id) = { "trunkHealth" => { "status" => "measured", "text" => "red 1 time in 6 landings, 1.8 min to green at p50, 1 landing built on red" } }
    def intent_spend(_id, iid) = iid == "int_5" ? { "usd" => 0.002, "tokens" => { "input" => 10, "output" => 5 }, "calls" => { "agent" => 2, "review" => 1 } } : nil
  end

  def test_through_the_report
    r = Coordination::Report.new(colony: "fx", git: Coordination::Git.new(CoordinationTest.fixture), api: Api.new(CoordinationTest.fixture), url: "http://fake",
                                 now: Fixture::T0 + 400_000).build
    h = r[:trunkHealth]
    assert_equal "red 1 time in 6 landings, 1.8 min to green at p50, 1 landing built on red", h[:text]
    assert_equal({ landings: 1, afterRedKnown: 0, repairs: 1 }, h[:builtOnRed])
    assert_equal({ intents: 1, agentMs: 0, held: 0, spend: { usd: 0.002, calls: 3, intents: 1 } }, h[:repair])
    assert_equal({ answers: 1, suspect: 1, precision: 1.0, rank1: 1.0 }, h[:culprits])
    assert_equal [5, 5], h[:certifiedWithin].first.values_at(:certified, :landings)
    assert_includes Coordination.markdown(r), "| Trunk health | red 1 time in 6 landings, 1.8 min to green at p50, 1 landing built on red; red 30.7% of the 6.0 min measured"
    assert_includes Coordination.markdown(r), "; the colony says the same |"
  end
end

# Definition 16 on a small record: i1 landed on its second proposal after three decisions, i2 on its first with none;
# i3 (claimed) and i4 (open) are left at the record's last event.
class ResidueTest < Minitest::Test
  def record
    Small.record do
      intent(0, "i1", "open")
      intent(1, "i4", "open")
      intent(2, "i2", "open")
      intent(4, "i3", "open")
      prop(5, "p1", "i1", "a1", "checking")
      decision(7, "p1", "llm", "return")
      prop(8, "p1", "i1", "a1", "returned", "llm: no")
      prop(3, "p3", "i2", "a2", "checking")
      prop(9, "p3", "i2", "a2", "landed")
      intent(9, "i2", "landed")
      intent(6, "i3", "claimed")
      prop(10, "p2", "i1", "a1", "checking")
      decision(11, "p2", "reflex", "escalate")
      decision(12, "p2", "human", "approve")
      prop(12, "p2", "i1", "a1", "ready")
      prop(20, "p2", "i1", "a1", "landed")
      intent(20, "i1", "landed")
      prop(30, "p4", "i5", "a1", "checking")
    end
  end

  def test_proposals_and_review_rounds_to_land_and_the_intents_left_open
    r = Coordination.residue(record)
    assert_equal 2, r[:landedIntents]
    assert_equal({ n: 2, mean: 1.5, p50: 1.5, p90: 1.9, max: 2, histogram: { "1" => 1, "2" => 1 } }, r[:proposalsToLand])
    assert_equal({ n: 2, mean: 1.5, p50: 1.5, p90: 2.7, max: 3, histogram: { "0" => 1, "3" => 1 } }, r[:reviewRoundsPerIntent])
    assert_equal({ p50: 13.5, p90: 18.7 }, r[:declaredToLanded])
    assert_equal({ n: 4, mean: 0.75, p50: 0.5, p90: 1.7, max: 2, histogram: { "0" => 2, "1" => 1, "2" => 1 } }, r[:reviewRoundsPerChange][:all])
    assert_equal({ n: 2, mean: 1.0, p50: 1.0, p90: 1.8, max: 2, histogram: { "0" => 1, "2" => 1 } }, r[:reviewRoundsPerChange][:landed])
    assert_equal({ intents: 2, byStatus: { "claimed" => 1, "open" => 1 }, p50AgeSeconds: 27.5, maxAgeSeconds: 29.0,
                   oldest: [{ intent: "i4", title: "i4 title", status: "open", ageSeconds: 29.0 }, { intent: "i3", title: "i3 title", status: "claimed", ageSeconds: 26.0 }] }, r[:open])
    assert_equal "| Residue and review rounds | 2 landed intents: 1.50 proposals to land (p90 1.9), 1.50 review rounds; declared to landed p50 13.5 s, " \
                 "p90 18.7 s; 0.75 review rounds a change; 2 intents still open, the oldest 29.0 s old |", Coordination.residue_row(r)
  end
end

class CoordinationPartsTest < Minitest::Test
  def test_region_of_matches_the_colony
    assert_equal "src/adapter/bun", Coordination.region_of("src/adapter/bun/server.ts", 3)
    assert_equal "src", Coordination.region_of("src/index.ts", 3)
    assert_equal ".", Coordination.region_of("README.md", 2)
    assert_equal "src", Coordination.region_of("src/**/*.ts", 3)
    assert_equal "src", Coordination.primary_region(["src/b.ts", "docs/guide.md"], 1)
    assert_equal "docs", Coordination.primary_region(["src/b.ts", "docs/a.md", "docs/b.md"], 1)
    assert_equal ".", Coordination.primary_region([], 1)
  end

  # Definition 9, the rules of packages/core/src/answerable.ts.
  def test_who_answers_for_a_change_and_a_landing
    proof = { "name" => "gate", "ok" => true, "detail" => "D3 innate+proof → land by deterministic at head f (confirmations: innate + deterministic): proven" }
    model = { "name" => "gate", "ok" => true, "detail" => "L1 innate+llm → land by llm at head f (confirmations: innate + llm): approved" }
    change = lambda do |intent, decisions: [], checks: []|
      { "id" => "p", "intent" => { "id" => "i" }.merge(intent), "decisions" => decisions, "evidence" => { "checks" => checks } }
    end
    approve = { "layer" => "human", "action" => "approve", "by" => "Matt" }
    assert_equal "approved", Coordination.change_answer(change.call({ "source" => "agent" }, decisions: [approve]))
    assert_equal "rule", Coordination.change_answer(change.call({ "source" => "rule", "ruleId" => "rul_1", "ruleApprovedBy" => "Ana" }, checks: [proof]))
    assert_equal "unknown", Coordination.change_answer(change.call({ "ruleId" => "rul_1" }, checks: [proof]))
    assert_equal "asked", Coordination.change_answer(change.call({ "source" => "human", "createdBy" => "Lee" }, checks: [model]))
    assert_equal "none", Coordination.change_answer(change.call({ "source" => "agent", "createdBy" => "agt_1" }, checks: [model]))
    # A rule's intent a model approved, and a gate check the agent sent: no person.
    assert_equal "none", Coordination.change_answer(change.call({ "source" => "rule", "ruleId" => "rul_1", "ruleApprovedBy" => "Ana" }, checks: [model]))
    assert_equal "none", Coordination.change_answer(change.call({ "source" => "rule", "ruleId" => "rul_1", "ruleApprovedBy" => "Ana" }, checks: [proof.merge("by" => "agent")]))
    assert_equal "unknown", Coordination.change_answer(change.call({}, checks: [model]))
    note = ->(*ps) { { "proposals" => ps } }
    assert_equal "none", Coordination.landing_answer(note.call(change.call({ "source" => "human" }), change.call({ "source" => "agent" })))
    assert_equal "unknown", Coordination.landing_answer(note.call(change.call({ "source" => "human" }), change.call({})))
    assert_equal "person", Coordination.landing_answer(note.call(change.call({ "source" => "human" })))
    assert_equal "person", Coordination.landing_answer({ "proposals" => [], "revert" => { "by" => "Matt" } })
    assert_equal "unknown", Coordination.landing_answer({ "proposals" => [] })
  end

  def test_classify_return_reasons
    {
      "stale: 1 path changed on trunk since read: src/a.ts (expected 6a93106ff6, trunk 59756a80e1)" => "stale",
      "stale: src/a.ts (expected a, trunk has b, landing ahead in this cycle from prp_x)" => "stale",
      "conflicts with another proposal in this landing on src/a.ts" => "stale",
      "conflicts with prp_x, landing ahead in this cycle: this change deletes src/b.ts, which prp_x's imports resolve to" => "stale",
      "stale: merge/values.ts (expected e, trunk has d); text merge of merge/values.ts: 1 conflicting hunk, at line 6 of its base" => "text_merge",
      "text merge of a b.ts: 2 conflicting hunks, at lines 1, 9 of its base" => "text_merge",
      "llm: the change edits files outside its intent" => "review",
      "reflex: a reviewer rejected similar changes: antibody ab_1 0.9 ≥ 0.8" => "review",
      "deterministic: deterministic: src/a.ts ./x: ./y.ts does not exist in the trunk tree" => "review",
      "returned for review: security (auth); details are with the reviewers, and a person reviews this intent's next proposal" => "review",
      "deterministic: innate: src/a.ts still has 2 violations of rule rul_1 (Relative imports name their file)" => "rule",
      "llm: innate: src/a.ts adds 1 violation of rule rul_2 (Node built-ins use node:)" => "rule",
      "deleting src/b.ts breaks the imports of src/a.ts: change them in the same change, or first" => "other",
      "trunk kept moving during landing (push refused); propose again" => "other",
      "a person wrote this" => "other",
      "" => "other"
    }.each { |reason, want| assert_equal want, Coordination.classify(reason), reason }
    assert_equal "review", Coordination.classify("a person wrote this", human: true)
    assert Coordination.redirect?("superseded: contest for int_1 won by prp_2 (smaller diff)")
    refute Coordination.redirect?("stale: withdrawn: x")
  end

  def test_reason_paths_keeps_known_paths_once
    known = Set["src/a.ts", "src/b.ts", "merge/v.ts"]
    assert_equal ["src/b.ts", "src/a.ts"], Coordination.reason_paths("deleting src/b.ts breaks the imports of src/a.ts: change them", known)
    assert_equal ["merge/v.ts"], Coordination.reason_paths("stale: merge/v.ts (expected e); text merge of merge/v.ts: 1 conflicting hunk", known)
    assert_equal [], Coordination.reason_paths("llm: src/c.ts is new", known)
  end

  def test_split_mix_64_reference_values_and_shuffle
    rng = Coordination::SplitMix64.new(1_234_567)
    assert_equal [6_457_827_717_110_365_317, 3_203_168_211_198_807_973, 9_817_491_932_198_370_423], Array.new(3) { rng.next_u64 }
    a = (1..20).to_a
    shuffled = Coordination::SplitMix64.new(7).shuffle!(a.dup)
    assert_equal a, shuffled.sort
    refute_equal a, shuffled
    assert_equal shuffled, Coordination::SplitMix64.new(7).shuffle!(a.dup)
  end

  def test_specialization_of_a_specialized_swarm
    landed = []
    5.times { |round| %w[r1 r2 r3 r4].each_with_index { |region, i| landed << ["agt_#{i}", round.zero? && i.zero? ? "r2" : region] } }
    s = Coordination.specialization(landed)
    assert_equal 4, s[:agents]
    assert_in_delta 1.0, s[:observed], 1e-9
    assert_operator s[:baseline], :<, 0.7
    assert_operator s[:p], :<, 0.01
    assert_equal s, Coordination.specialization(landed)
    assert_nil Coordination.specialization([["a", "r"], ["a", "r"]])[:observed]
  end

  def test_line_map_follows_lines_through_a_diff
    assert_equal [1, nil, 3], Coordination::Git.line_map("x\ny\nz\n", "x\nY\nz\n")
    assert_equal [1, nil, 2], Coordination::Git.line_map("x\nz\n", "x\ny\nz\n")
    assert_equal [1, 3], Coordination::Git.line_map("x\ny\nz\n", "x\nz\n")
    assert_equal [nil, 1], Coordination::Git.line_map("y\n", "x\ny\n")
    assert_equal [2], Coordination::Git.line_map("x\ny\n", "y\n")
    assert_equal [nil, nil], Coordination::Git.line_map("", "a\nb\n")
    assert_equal [1, nil], Coordination::Git.line_map("a\n", "a\nb")
  end

  def test_numbers
    assert_equal 2.5, Coordination.median([4, 1, 3, 2])
    assert_equal 3, Coordination.median([5, 3, 1])
    assert_nil Coordination.median([])
    assert_in_delta 1.75, Coordination.quantile([1, 2, 3, 4], 0.25), 1e-9
    assert_equal 2, Coordination.line_count("a\nb")
    assert_equal 0, Coordination.line_count("")
    assert Coordination.binary?("a\0b")
    assert_equal "remote <redacted> and https://<redacted>@host/x", Coordination.redact("remote art_v1_abc.def and https://user:pw@host/x")
  end
end
