#!/usr/bin/env ruby
# frozen_string_literal: true

# A judge's first five minutes, rehearsed from nothing, read only: what someone with stock git, Node and an MCP client
# (and no token) can check about a public colony. One PASS, FAIL or SKIP line per step, then the total:
#
#   clone        git clone <base>/git/<colony>.git into a new temporary directory, then fetch refs/notes/firetrident
#   note (git)   the newest landing's lineage note, checked in that clone with scripts/verify_note.mjs (and against the
#                deployment's published key when it publishes one: signed, or unsigned because it landed before signing)
#   note (api)   the same landing's note through GET /api/colonies/<colony>/notes/verify?landing=<commit>
#   mcp          the public MCP endpoint through the MCP SDK's client (scripts/mcp_ask.ts): initialize, list the tools,
#                call status on the colony and why on a file the newest landing changed
#   replay page  GET /c/<colony>?replay=1
#   recording    GET /recordings/<colony>.json.gz, a recorded run for offline playback (SKIP when there is none)
#   events       GET /api/colonies/<colony>/events?limit=1
#   about        GET /api/about names the commit given with --expect
#
# Usage:
#   ruby scripts/judge_path.rb --base https://staging.firetrident.com [--colony hono] [--expect <commit>]
#     [--timeout 60] [--clone-timeout 600] [--keep-clone]
#
# Behind Cloudflare Access, set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET: they go with every request, git's
# included (as http.extraHeader entries passed through git's environment, the same as `git -c`, so the secret is never
# on a command line), and are never printed. No admin token is sent: this is the public path. Each step has a hard time
# limit (--timeout; the clone has its own). Exit codes: 0 every step passed or was skipped, 1 a step failed, 2 a setting
# is missing.
require "fileutils"
require "optparse"
require "tmpdir"
require "zlib"
require_relative "stage"

module JudgePath
  VERIFY_NOTE = File.expand_path("verify_note.mjs", __dir__)
  # First-parent commits searched for the newest landing.
  SEARCH = 500

  # One step's outcome.
  Result = Struct.new(:name, :status, :detail, :secs)

  # One rehearsal against one deployment.
  class Run
    def initialize(http:, clock:, colony:, expect:, timeout:, clone_timeout:, access:, keep_clone:)
      @http = http
      @clock = clock
      @colony = colony
      @expect = expect
      @timeout = timeout.to_f
      @clone_timeout = clone_timeout.to_f
      @access = access
      @keep_clone = keep_clone
      @results = []
    end

    # Every step in order, then the total; returns the exit code.
    def call
      dir = Dir.mktmpdir("ft-judge-")
      url = "#{@http.base}/git/#{@colony}.git"
      @clock.print("judge path on #{@http.base}, colony #{@colony}, from a fresh clone in a new temporary directory")
      @clock.print("a judge types: #{Stage.judge_clone_command(url, @access)}")
      @clock.print
      step("clone") { clone(url, dir) }
      step("note (git)") { note_git }
      step("note (api)") { note_api }
      step("mcp") { mcp }
      step("replay page") { replay_page }
      step("recording") { recording }
      step("events") { events }
      step("about") { about }
      total
    ensure
      if dir && @keep_clone
        @clock.print("kept the clone: #{File.join(dir, @colony)}")
      elsif dir
        FileUtils.remove_entry(dir, true)
      end
    end

    private

    def step(name)
      t = Stage.now
      status, detail = begin
        yield
      rescue StandardError => e
        ["FAIL", "#{e.class.name}: #{e.message}"]
      end
      r = Result.new(name, status, detail, Stage.now - t)
      @results << r
      @clock.print(format("%-4s  %-12s %s (%.1f s)", r.status, r.name, r.detail, r.secs))
    end

    def total
      failed = @results.select { |r| r.status == "FAIL" }
      skipped = @results.count { |r| r.status == "SKIP" }
      @clock.print
      counts = "#{@results.size - failed.size - skipped} passed, #{failed.size} failed, #{skipped} skipped, of #{@results.size} steps"
      if failed.empty?
        @clock.print("PASS judge path: #{counts}")
        Stage::EXIT_PASS
      else
        @clock.print("FAIL judge path: #{counts} (#{failed.map(&:name).join(', ')})")
        Stage::EXIT_FAIL
      end
    end

    # --- steps --------------------------------------------------------------------------------------------------------

    def clone(url, dir)
      dest = File.join(dir, @colony)
      ok, _out, err, timed_out = Stage.run(["git", "clone", "--quiet", url, dest], env: git_env, chdir: dir, timeout: @clone_timeout)
      return ["FAIL", "git clone of #{url} did not finish within #{Stage.seconds(@clone_timeout)} s"] if timed_out
      return ["FAIL", "git clone of #{url} failed: #{last_line(err)}"] unless ok

      @clone = dest
      ok, _out, err, timed_out = git("fetch", "--quiet", "origin", "refs/notes/firetrident:refs/notes/firetrident")
      notes = if timed_out then "fetching the lineage notes did not finish within #{Stage.seconds(@timeout)} s"
              elsif ok then "lineage notes fetched"
              else "no lineage notes (#{last_line(err)})"
              end
      @head = git("rev-parse", "HEAD")[1].strip
      count = git("rev-list", "--count", "HEAD")[1].strip
      ["PASS", "#{url}: #{count} commits, HEAD #{short(@head)}, #{notes}"]
    end

    def note_git
      return ["FAIL", "not run: there is no clone"] unless @clone

      @landing = newest_landing
      return ["FAIL", "none of the newest #{SEARCH} commits on the clone's main carries an FT-Note trailer"] unless @landing

      verdict, problem = verify_note(@landing)
      return ["FAIL", problem] if problem
      return ["FAIL", "newest landing #{short(@landing)}: verify_note.mjs says #{verdict}"] unless verdict == "intact"

      signed = signature_check
      return ["FAIL", signed] if signed&.start_with?("FAIL ")

      ["PASS", "newest landing #{short(@landing)}: verify_note.mjs says intact#{signed ? "; #{signed}" : ''}"]
    end

    def note_api
      path = "/api/colonies/#{@colony}/notes/verify?#{@landing ? "landing=#{@landing}" : 'limit=1'}"
      res = get(path)
      return ["FAIL", "#{path}: #{res.problem}"] unless res.ok? && res.json.is_a?(Hash)

      n = Array(res.json["notes"]).first
      return ["FAIL", "#{path} answered no note"] unless n.is_a?(Hash)
      return ["FAIL", "#{path} checked #{short(n['trunkSha'])}, not #{short(@landing)}"] if @landing && n["trunkSha"] != @landing

      sig = n.dig("signature", "status")
      unless n["status"] == "intact" && sig != "bad-signature"
        why = [n["status"], n["detail"], (sig == "bad-signature" ? "bad signature: #{n.dig('signature', 'detail')}" : nil)].compact.join(": ")
        return ["FAIL", "#{path} says #{why}"]
      end

      ["PASS", "the API says intact for #{short(n['trunkSha'])} (#{n['landingId']})#{sig ? ", signature #{sig}" : ''}"]
    end

    def mcp
      path = why_path
      calls = [["status", { colony: @colony }]]
      calls << ["why", { colony: @colony, path: path }] if path
      a = Stage.mcp_ask(@http.base, calls: calls, timeout: @timeout, access: @access)
      server = a["server"]
      return ["FAIL", "/public/mcp: #{a['error'] || 'no answer'}"] unless server

      missing = %w[status why] - Array(a["tools"])
      return ["FAIL", "#{server['name']} lists #{Array(a['tools']).join(', ')}, without #{missing.join(' and ')}"] unless missing.empty?

      failed = Array(a["calls"]).reject { |c| c["ok"] }
      return ["FAIL", failed.map { |c| "#{c['tool']}: #{c['error']}" }.join("; ")] unless failed.empty?
      return ["FAIL", "/public/mcp: #{a['error'] || 'a step did not answer'}"] unless a["ok"]

      status, why = a["calls"]
      return ["FAIL", "status answered colony #{status.dig('facts', 'colony')}, not #{@colony}"] unless status.dig("facts", "colony") == @colony
      return ["FAIL", "why #{path} answered no landing"] if why && why.dig("facts", "landings").to_i < 1

      head = status.dig("facts", "head")
      same = if !@head then ""
             elsif head == @head then " (the clone's HEAD)"
             else " (the clone has #{short(@head)}: trunk moved since?)"
             end
      parts = ["#{server['name']} #{server['version']}, protocol #{a['protocolVersion']}: #{a['tools'].size} tools", "status: #{status['summary']}#{same}"]
      parts << "why: #{why['summary']}" if why
      ["PASS", parts.join("; ")]
    end

    def replay_page
      path = "/c/#{@colony}?replay=1"
      res = get(path, headers: { "Accept" => "text/html" })
      return ["FAIL", "#{path}: #{res.problem}"] unless res.ok?
      return ["FAIL", "#{path} answered #{res.content_type}, not a page"] unless res.content_type.include?("text/html") && res.body.include?("<")

      ["PASS", "#{path}: #{res.code} #{res.content_type.split(';').first}, #{res.body.bytesize} bytes"]
    end

    def recording
      path = "/recordings/#{@colony}.json.gz"
      res = get(path, headers: { "Accept" => "*/*" })
      # A missing asset falls back to the single-page app's index.html, so a page here means there is no recording.
      return ["SKIP", "#{path}: no recording of #{@colony} on this deployment"] if res.code == 404 || (res.ok? && res.content_type.include?("text/html"))
      return ["FAIL", "#{path}: #{res.problem}"] unless res.ok?

      bytes = res.body.b
      text = bytes.start_with?("\x1f\x8b".b) ? Zlib.gunzip(bytes) : bytes
      doc = JSON.parse(text)
      return ["FAIL", "#{path} is not a FireTrident recording"] unless doc.is_a?(Hash) && doc["format"] == "firetrident-recording"
      return ["FAIL", "#{path} records colony #{doc['colonyId']}, not #{@colony}"] unless doc["colonyId"] == @colony

      events = Array(doc.dig("record", "events")).size
      ["PASS", "#{path}: #{bytes.bytesize} bytes, #{events} events of #{doc['colonyId']}, recorded #{doc['recordedAt']}"]
    rescue JSON::ParserError, Zlib::Error => e
      ["FAIL", "#{path} does not read as a recording: #{e.message[0, 120]}"]
    end

    def events
      path = "/api/colonies/#{@colony}/events?limit=1"
      res = get(path)
      return ["FAIL", "#{path}: #{res.problem}"] unless res.ok? && res.json.is_a?(Hash) && res.json["events"].is_a?(Array)

      j = res.json
      ["PASS", "#{path}: #{j['events'].size} of #{j['total'] || '?'} events (#{j['source'] || 'record'})"]
    end

    def about
      res = get("/api/about")
      return ["FAIL", "/api/about: #{res.problem}"] unless res.ok? && res.json.is_a?(Hash)
      return ["FAIL", "/api/about does not say it is firetrident"] unless res.json["service"] == "firetrident"

      commit = res.json["commit"]
      deployed = res.json["deployedAt"] ? ", deployed #{res.json['deployedAt']}" : ""
      return ["PASS", "/api/about names commit #{commit || 'none'}#{deployed} (pass --expect <commit> to check it)"] unless @expect
      return ["PASS", "/api/about names commit #{commit}, as expected#{deployed}"] if same_commit?(commit, @expect)

      ["FAIL", "/api/about names commit #{commit || 'none'}, expected #{@expect}#{deployed}"]
    end

    # --- helpers ------------------------------------------------------------------------------------------------------

    def get(path, headers: {}) = @http.get(path, headers: headers, timeout: @timeout, auth: false)

    def git_env = Stage.git_env(@access)

    def git(*args)
      ok, out, err, timed_out = Stage.run(["git", *args], env: git_env, chdir: @clone, timeout: @timeout)
      [ok, out, err, timed_out]
    end

    # The newest first-parent commit whose message ends with an FT-Note trailer: a landing with a lineage note.
    def newest_landing
      _, out, = git("log", "--first-parent", "-n", SEARCH.to_s, "--format=%H%x1f%B%x1e", "HEAD")
      out.split("\x1e").each do |rec|
        sha, body = rec.strip.split("\x1f", 2)
        return sha if body.to_s.rstrip.lines.last.to_s.strip.match?(/\AFT-Note: sha256:\h{64}\z/)
      end
      nil
    end

    # The first file the newest landing changed that trunk still has (why's subject), or nil.
    def why_path
      return nil unless @clone && @landing

      _, out, = git("diff-tree", "--no-commit-id", "--name-only", "-r", "--root", @landing)
      out.lines.map(&:strip).find { |p| !p.empty? && !p.start_with?(".firetrident/") && git("cat-file", "-e", "HEAD:#{p}")[0] }
    end

    # verify_note.mjs's verdict on `commit` in the clone, or [nil, the problem].
    def verify_note(commit, keys = nil)
      cmd = ["node", VERIFY_NOTE, commit, *(keys ? ["--keys", keys] : [])]
      _, out, err, timed_out = Stage.run(cmd, env: git_env, chdir: @clone, timeout: @timeout)
      return [nil, "verify_note.mjs did not finish within #{Stage.seconds(@timeout)} s"] if timed_out

      verdict = out.strip
      verdict.empty? ? [nil, "verify_note.mjs printed nothing: #{last_line(err)}"] : [verdict]
    end

    # The newest landing's signature against the key the deployment publishes: nil when it publishes none, a few words
    # when the check passes ("signed by <key>", or "unsigned (landed before signing)"), "FAIL ..." when it does not.
    def signature_check
      res = get("/.well-known/firetrident-keys.json")
      return nil if res.code == 404
      return "FAIL /.well-known/firetrident-keys.json: #{res.problem}" unless res.ok? && res.json.is_a?(Hash)
      return nil if Array(res.json["keys"]).empty?

      file = File.join(File.dirname(@clone), "firetrident-keys.json")
      File.write(file, res.body)
      verdict, problem = verify_note(@landing, file)
      return "FAIL #{problem}" if problem
      return verdict.sub(/\Aintact, /, "") if verdict.start_with?("intact, signed by ")
      return verdict if verdict == "unsigned (landed before signing)"

      "FAIL newest landing #{short(@landing)}: verify_note.mjs --keys says #{verdict}"
    end

    def same_commit?(got, want)
      a = got.to_s.downcase
      b = want.to_s.strip.downcase
      [a.size, b.size].min >= 7 && (a.start_with?(b) || b.start_with?(a))
    end

    def last_line(text) = text.to_s.strip.lines.last.to_s.strip[0, 200]

    def short(sha) = sha.to_s[0, 7]
  end

  # Parse the command line and run the rehearsal; returns the exit code.
  def self.main(argv)
    opts = { base: nil, colony: "hono", expect: nil, timeout: 60.0, clone_timeout: 600.0, keep_clone: false }
    OptionParser.new do |o|
      o.banner = "Usage: ruby scripts/judge_path.rb --base <url> [options]"
      o.on("--base URL", "The deployment, e.g. https://staging.firetrident.com") { |v| opts[:base] = v }
      o.on("--colony ID", "A public colony (default hono)") { |v| opts[:colony] = v }
      o.on("--expect COMMIT", "The commit /api/about must name (7 or more hex digits)") { |v| opts[:expect] = v }
      o.on("--timeout S", Float, "Hard time limit of each step but the clone, in seconds (default 60)") { |v| opts[:timeout] = v }
      o.on("--clone-timeout S", Float, "Hard time limit of the clone, in seconds (default 600)") { |v| opts[:clone_timeout] = v }
      o.on("--keep-clone", "Keep the clone and say where it is") { opts[:keep_clone] = true }
    end.parse!(argv)
    base = Stage.base_url(opts[:base])
    raise Stage::ConfigError, "--colony must be a colony id (lowercase letters, digits and hyphens)" unless opts[:colony].match?(/\A[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?\z/)

    access = Stage.access_headers
    clock = Stage::Clock.new(secrets: access.values)
    http = Stage::Http.new(base, access: access)
    Run.new(http: http, clock: clock, colony: opts[:colony], expect: opts[:expect], timeout: opts[:timeout],
            clone_timeout: opts[:clone_timeout], access: access, keep_clone: opts[:keep_clone]).call
  rescue Stage::ConfigError, OptionParser::ParseError => e
    warn("judge_path: #{e.message}")
    Stage::EXIT_USAGE
  end
end

exit(JudgePath.main(ARGV)) if $PROGRAM_NAME == __FILE__
