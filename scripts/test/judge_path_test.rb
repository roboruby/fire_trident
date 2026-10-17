# frozen_string_literal: true

# Tests for scripts/judge_path.rb, run as a command against a fake deployment on 127.0.0.1 that stands behind a fake
# Cloudflare Access (every request without the service-token headers gets 403): stock git's smart HTTP over a bare
# repository whose newest landing carries a lineage note (signed, unsigned or altered) and its FT-Note trailer, the
# public MCP endpoint answered statelessly for the MCP SDK's client, the replay page, a recording and the public reads.
#
#   ruby scripts/test/judge_path_test.rb
require "minitest/autorun"
require "base64"
require "digest"
require "fileutils"
require "openssl"
require "tmpdir"
require "zlib"
require_relative "fake_deployment"

# A colony's trunk repository with one imported commit and one landing, served from `root`/hono.git.
module JudgeFixture
  T = 1_800_000_000

  def self.git(dir, *args, input: nil, env: {})
    out, err, status = Open3.capture3(env, "git", *args, stdin_data: input.to_s, chdir: dir)
    raise "git #{args.join(' ')}: #{err}" unless status.success?

    out.strip
  end

  # The note as FireTrident writes it: keys sorted at every depth, two-space indent (scripts/verify_note.mjs canon).
  def self.canon(v, indent = "")
    inner = "#{indent}  "
    case v
    when Hash then v.empty? ? "{}" : "{\n#{inner}#{v.keys.sort.map { |k| "#{JSON.generate(k)}: #{canon(v[k], inner)}" }.join(",\n#{inner}")}\n#{indent}}"
    when Array then v.empty? ? "[]" : "[\n#{inner}#{v.map { |x| canon(x, inner) }.join(",\n#{inner}")}\n#{indent}]"
    else JSON.generate(v)
    end
  end

  def self.b64url(bytes) = Base64.urlsafe_encode64(bytes, padding: false)

  # Build root/hono.git; `mode` is :signed, :unsigned or :altered. Returns { head:, landing:, keys: }.
  def self.build(root, mode)
    key = OpenSSL::PKey.generate_key("ED25519")
    raw = key.public_to_der[-32..]
    kid = Digest::SHA256.hexdigest(raw)[0, 16]
    work = File.join(root, "work")
    FileUtils.mkdir_p(File.join(work, "src"))
    env = { "GIT_AUTHOR_NAME" => "Ada", "GIT_AUTHOR_EMAIL" => "ada@example.com", "GIT_COMMITTER_NAME" => "Ada",
            "GIT_COMMITTER_EMAIL" => "ada@example.com", "GIT_AUTHOR_DATE" => "#{T} +0000", "GIT_COMMITTER_DATE" => "#{T} +0000" }
    git(work, "init", "--quiet", "--initial-branch=main")
    File.write(File.join(work, "README.md"), "# hono\n")
    git(work, "add", "-A")
    git(work, "commit", "--quiet", "-m", "Import hono", env: env)
    File.write(File.join(work, "src", "a.ts"), "export const a = 1;\n")
    git(work, "add", "-A")
    tree = git(work, "write-tree")
    parent = git(work, "rev-parse", "HEAD")
    blob = git(work, "rev-parse", ":src/a.ts")
    note = { "schema" => "firetrident.lineage/v1", "landingId" => "lnd_1", "colonyId" => "hono",
             "proposals" => [{ "id" => "prp_1", "agentId" => "agt_1", "agentKind" => "internal", "intent" => { "id" => "int_1", "title" => "Add a", "why" => "" },
                               "writeSet" => [{ "path" => "src/a.ts", "blob" => blob }], "readSet" => [], "decisions" => [], "evidence" => { "checks" => [] } }] }
    text = "#{canon(note)}\n"
    digest = Digest::SHA256.hexdigest(text)
    signature = b64url(key.sign(nil, "firetrident-note-signature v1\n#{digest}\n#{tree}\n#{parent}\n"))
    lines = ["Land 1 change: Add a", "", "FT-Landing: lnd_1", "FT-Proposal: prp_1"]
    lines << "FT-Note-Signature: ed25519 #{kid} #{signature}" unless mode == :unsigned
    lines << "FT-Note: sha256:#{digest}"
    landing = git(work, "commit-tree", tree, "-p", parent, "-F", "-", input: "#{lines.join("\n")}\n", env: env)
    git(work, "update-ref", "refs/heads/main", landing)
    stored = mode == :altered ? text.sub('"Add a"', '"Add b"') : text
    note_blob = git(work, "hash-object", "-w", "--stdin", input: stored)
    git(work, "notes", "--ref=refs/notes/firetrident", "add", "-C", note_blob, landing, env: env)
    git(root, "init", "--quiet", "--bare", "--initial-branch=main", "hono.git")
    git(work, "push", "--quiet", File.join(root, "hono.git"), "main", "refs/notes/firetrident")
    { head: landing, landing: landing, keys: { "keys" => [{ "id" => kid, "alg" => "Ed25519", "publicKey" => b64url(raw) }] }, kid: kid }
  end

  RECORDING = Zlib.gzip(JSON.generate({ "format" => "firetrident-recording", "version" => 1, "colonyId" => "hono", "recordedAt" => "2026-10-16T23:00:00Z",
                                        "record" => { "source" => "recorded", "total" => 3, "events" => [{ "t" => "intent", "seq" => 1 }, { "t" => "landing", "seq" => 2 }, { "t" => "violations", "seq" => 3 }] },
                                        "reads" => {}, "refused" => {} }))
  PAGE = "<!doctype html><html><head><title>FireTrident</title></head><body><div id=\"root\"></div><script type=\"module\" src=\"/assets/main.js\"></script></body></html>"

  # The deployment: `opts` change one answer each (commit:, recording: false, slow:, access: false).
  def self.router(root, built, commit: "ea41814", recording: true, slow: nil, access: true)
    lambda do |req|
      next [403, { "Content-Type" => "text/html" }, "Forbidden: Cloudflare Access"] if access && !FakeDeployment.accessed?(req)

      sleep(3) if slow && req.path.start_with?(slow)
      case req.path
      when %r{\A/git/} then FakeDeployment.git(root, req)
      when "/public/mcp"
        FakeDeployment.mcp(req) do |tool, args|
          case tool
          when "status" then [false, { colony: { id: args["colony"] }, trunk: { head: built[:head] }, intents: { total: 3 }, landings: [{ id: "lnd_1" }] }]
          when "why" then [false, { path: args["path"], line: nil, entries: [{ landing: { id: "lnd_1" }, note: {} }] }]
          else [true, { error: "no tool" }]
          end
        end
      when "/api/about" then FakeDeployment.json(200, { service: "firetrident", commit: commit, deployedAt: "2026-10-17T03:00:00.000Z", flags: [], noteKey: built[:kid] })
      when "/api/colonies/hono/notes/verify"
        sha = req.params["landing"]
        FakeDeployment.json(200, { colonyId: "hono", notes: [{ landingId: "lnd_1", trunkSha: sha, at: 0, status: "intact", signature: { status: "signed", keyId: built[:kid] } }], counts: { intact: 1 } })
      when "/api/colonies/hono/events" then FakeDeployment.json(200, { colonyId: "hono", source: "recorded", events: [{ t: "intent", seq: 1 }], next: 1, total: 4874 })
      when "/.well-known/firetrident-keys.json" then FakeDeployment.json(200, built[:keys])
      when "/recordings/hono.json.gz" then recording ? [200, { "Content-Type" => "application/gzip" }, RECORDING] : [200, { "Content-Type" => "text/html" }, PAGE]
      else [200, { "Content-Type" => "text/html; charset=utf-8" }, PAGE]
      end
    end
  end
end

class JudgePathTest < Minitest::Test
  SCRIPT = File.expand_path("../judge_path.rb", __dir__)
  STEPS = ["clone", "note (git)", "note (api)", "mcp", "replay page", "recording", "events", "about"].freeze

  def judge(mode: :signed, args: [], access: true, **opts)
    Dir.mktmpdir("judge-root") do |root|
      built = JudgeFixture.build(root, mode)
      server = FakeDeployment.new(&JudgeFixture.router(root, built, access: access, **opts))
      begin
        out, err, status = Open3.capture3(FakeDeployment.env(root, token: true, access: access), "ruby", SCRIPT, "--base", server.url, *args)
        yield out, err, status.exitstatus, server.requests, built
      ensure
        server.stop
      end
    end
  end

  def lines_of(out) = out.lines.select { |l| l.match?(/\A(PASS|FAIL|SKIP)  /) }.map { |l| [l[0, 4], l[6, 12].strip] }

  def assert_no_secrets(text)
    [FakeDeployment::TOKEN, FakeDeployment::ACCESS_SECRET, FakeDeployment::ACCESS_ID].each { |s| refute_includes text, s }
  end

  def test_every_step_passes_in_order_behind_access_without_a_token
    judge(args: ["--expect", "ea41814abc"]) do |out, err, code, reqs, built|
      assert_equal 0, code, out + err
      assert_equal STEPS.map { |s| ["PASS", s] }, lines_of(out)
      assert_includes out, "a judge types: git -c http.extraHeader=\"CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID\" -c http.extraHeader=\"CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET\" clone http://127.0.0.1:"
      assert_match(/PASS  clone +http:\S+\/git\/hono\.git: 2 commits, HEAD #{built[:head][0, 7]}, lineage notes fetched/, out)
      assert_match(/PASS  note \(git\) +newest landing #{built[:landing][0, 7]}: verify_note\.mjs says intact; signed by #{built[:kid]}/, out)
      assert_match(/PASS  note \(api\) +the API says intact for #{built[:landing][0, 7]} \(lnd_1\), signature signed/, out)
      assert_match(/PASS  mcp +firetrident-public 0\.0\.1, protocol \S+: 5 tools; status: colony hono, head #{built[:head][0, 7]}, 3 intents, 1 recent landings \(the clone's HEAD\); why: src\/a\.ts: 1 landing, newest lnd_1/, out)
      assert_match(%r{PASS  recording +/recordings/hono\.json\.gz: \d+ bytes, 3 events of hono}, out)
      assert_includes out, "PASS  events       /api/colonies/hono/events?limit=1: 1 of 4874 events (recorded)"
      assert_includes out, "PASS  about        /api/about names commit ea41814, as expected"
      assert_includes out, "PASS judge path: 8 passed, 0 failed, 0 skipped, of 8 steps"
      # Git went through the proxy with the Access headers too; nothing carried a token; the MCP client sent JSON-RPC.
      assert(reqs.any? { |r| r.path == "/git/hono.git/info/refs" })
      assert(reqs.any? { |r| r.path == "/git/hono.git/git-upload-pack" && r.method == "POST" })
      assert(reqs.all? { |r| FakeDeployment.accessed?(r) })
      assert(reqs.none? { |r| r.headers.key?("authorization") })
      assert_equal %w[initialize notifications/initialized tools/list tools/call tools/call],
                   reqs.select { |r| r.path == "/public/mcp" && r.method == "POST" }.map { |r| r.json["method"] }
      assert(reqs.all? { |r| %w[GET POST].include?(r.method) })
      assert_no_secrets(out + err)
    end
  end

  def test_a_wrong_commit_fails_only_the_about_step_and_exits_1
    judge(args: ["--expect", "2bb30cb"]) do |out, _err, code, _reqs, _built|
      assert_equal 1, code
      assert_equal STEPS.map { |s| [s == "about" ? "FAIL" : "PASS", s] }, lines_of(out)
      assert_includes out, "FAIL  about        /api/about names commit ea41814, expected 2bb30cb"
      assert_includes out, "FAIL judge path: 7 passed, 1 failed, 0 skipped, of 8 steps (about)"
    end
  end

  def test_an_altered_note_fails_the_stock_git_check
    judge(mode: :altered) do |out, _err, code, _reqs, built|
      assert_equal 1, code
      assert_includes out, "FAIL  note (git)   newest landing #{built[:landing][0, 7]}: verify_note.mjs says altered"
    end
  end

  def test_an_unsigned_landing_passes_and_says_it_landed_before_signing
    judge(mode: :unsigned) do |out, _err, code, _reqs, _built|
      assert_equal 0, code, out
      assert_includes out, "verify_note.mjs says intact; unsigned (landed before signing)"
      assert_includes out, "names commit ea41814, deployed 2026-10-17T03:00:00.000Z (pass --expect <commit> to check it)"
    end
  end

  def test_a_missing_recording_is_skipped
    judge(recording: false) do |out, _err, code, _reqs, _built|
      assert_equal 0, code, out
      assert_includes out, "SKIP  recording    /recordings/hono.json.gz: no recording of hono on this deployment"
      assert_includes out, "PASS judge path: 7 passed, 0 failed, 1 skipped, of 8 steps"
    end
  end

  def test_a_step_that_does_not_answer_in_time_fails_naming_what_it_waited_for
    judge(slow: "/api/colonies/hono/events", args: ["--timeout", "1"]) do |out, _err, code, _reqs, _built|
      assert_equal 1, code
      assert_match(%r{FAIL  events +/api/colonies/hono/events\?limit=1: no answer within 1\.0 s \(1\.\d s\)}, out)
      assert_includes out, "PASS  about"
    end
  end

  def test_without_access_variables_no_access_header_is_sent
    judge(access: false) do |out, _err, code, reqs, _built|
      assert_equal 0, code, out
      assert_includes out, "a judge types: git clone http://127.0.0.1:"
      assert(reqs.none? { |r| r.headers.key?("cf-access-client-id") || r.headers.key?("cf-access-client-secret") })
    end
  end

  def test_access_refusing_the_clone_fails_it_and_the_steps_that_need_it
    Dir.mktmpdir("judge-root") do |root|
      built = JudgeFixture.build(root, :signed)
      server = FakeDeployment.new(&JudgeFixture.router(root, built, access: true))
      env = FakeDeployment.env(root, access: false)
      out, _err, status = Open3.capture3(env, "ruby", SCRIPT, "--base", server.url, "--timeout", "20")
      server.stop
      assert_equal 1, status.exitstatus
      assert_match(/FAIL  clone +git clone of \S+ failed: .*403/, out)
      assert_includes out, "FAIL  note (git)   not run: there is no clone"
      assert_match(/FAIL  note \(api\) +\S+: HTTP 403/, out)
    end
  end
end
