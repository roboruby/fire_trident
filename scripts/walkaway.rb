#!/usr/bin/env ruby
# frozen_string_literal: true

# The live beat "walk away": an outside agent takes work and dies without a word; the colony notices it went silent,
# takes the work back with a failure mark, and a second agent lands it. On a colony it creates:
#
#   1. a fresh colony named walkaway-<time>, with review off (no model is asked) and a 90 s silent-agent limit
#      (POST /silent-ttl), so an agent outside the platform that goes quiet for 90 s loses its claimed intents
#   2. a seed agent lands src/values.ts, twelve lines, as an inline change
#   3. the walker, an outside agent, joins over MCP (/mcp, as any MCP client does), is handed "Set v2 to 20 in
#      src/values.ts" and takes it
#   4. the walker is killed: its MCP session ends (DELETE /mcp) and it never calls release
#   5. a second agent asks for work every few seconds; the colony has none for it until its reaper finds the walker
#      silent past the limit and takes the intent back: cause reaped_silent, the gap since the walker's last call, and a
#      failure mark on src/values.ts
#   6. the second agent is handed the intent (its take says why it came back) and its change lands
#   7. it prints the intent's closures and the colony's closure shares; with --record it records the colony with
#      scripts/record_colony.ts into packages/web/public/recordings/walkaway.json.gz so the beat plays with no network;
#      then it deletes the colony (--keep leaves it)
#
# Every agent is this script with inline changes: no git, no model calls. Each step has a hard time limit; a step that
# runs out says what it was waiting for, and the script exits 3. Waiting for the reaper has its own limit (--reap-timeout,
# default the silent-agent limit plus 60 s: the reaper looks at most every 30 s).
#
# Usage:
#   FT_TOKEN=<admin token> FT_MCP_TOKEN=<MCP token> ruby scripts/walkaway.rb --base https://staging.firetrident.com
#     [--ttl 90] [--record] [--keep] [--name NAME] [--via mcp|rest] [--step-timeout 90] [--reap-timeout S] [--poll 5]
#
# --via rest makes the walker an outside agent over the REST API instead of MCP (for a deployment without an MCP token):
# the colony treats both alike. --record-out FILE records to FILE instead of the bundled path. Behind Cloudflare Access,
# set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET; they go with every request, the recorder's included. FT_TOKEN and
# FT_MCP_TOKEN come from the environment, else from ~/.config/firetrident/env when that file's FT_URL is this deployment.
# Never prints a token. Exit codes: 0 the beat showed what it should, 1 it did not, 2 a setting is missing, 3 a step timed
# out.
require "optparse"
require_relative "stage"

module Walkaway
  PATH = "src/values.ts"
  LINES = 12
  EDIT = [2, "export const v2 = 20;"].freeze
  SETTLED = %w[landed returned rejected escalated].freeze
  BY = ENV.fetch("FT_USER", "stage-walkaway")
  RECORDING = "walkaway"
  # The reaper looks at most this often (colony REAP_EVERY_MS).
  REAP_EVERY_S = 30
  # How often the second agent's waiting is narrated.
  SAY_EVERY_S = 15

  # The beat could not show what it should; the message says what happened.
  class Failure < StandardError; end

  def self.seed_text = (1..LINES).map { |i| "export const v#{i} = #{i};\n" }.join

  def self.edit(text, n, line)
    lines = text.lines
    lines[n - 1] = "#{line}\n"
    lines.join
  end

  def self.short(sha) = sha.to_s[0, 7]

  # "1 min 37 s": a gap as a person reads it.
  def self.duration(ms)
    s = (ms.to_f / 1000).round
    return "#{s} s" if s < 60

    m, rest = s.divmod(60)
    rest.zero? ? "#{m} min" : "#{m} min #{rest} s"
  end

  # The MCP token for `base`: FT_MCP_TOKEN from the environment, else the config file's when its FT_URL is this
  # deployment (as Stage.token decides for the admin token). Nil when there is none.
  def self.mcp_token(base, env = ENV)
    from_env = env["FT_MCP_TOKEN"].to_s.strip
    return from_env unless from_env.empty?

    path = Stage.config_path(env)
    return nil unless path && File.file?(path)

    file = Stage.parse_env_file(File.read(path))
    token = file["FT_MCP_TOKEN"].to_s.strip
    issued_for = file["FT_URL"].to_s.strip
    issued_for = Stage::DEFAULT_URL if issued_for.empty?
    !token.empty? && Stage.origin(issued_for) && Stage.origin(issued_for) == Stage.origin(base) ? token : nil
  end

  # An MCP client over Streamable HTTP, as any agent's client speaks it: initialize (the server names the session),
  # tools/call, and DELETE to end the session. An answer may come as JSON or as an event stream; the stream is read only
  # until the answer arrives.
  class Mcp
    PROTOCOL = "2025-06-18"

    # The MCP endpoint refused or failed a call; the message says how.
    class Error < StandardError
      attr_reader :code

      def initialize(message, code = nil)
        @code = code
        super(message)
      end
    end

    attr_reader :session

    def initialize(base, token:, access:)
      @uri = URI("#{base}/mcp")
      @token = token
      @access = access
      @id = 0
      @session = nil
    end

    # Open the session; returns the server's name.
    def open!(timeout:)
      result = rpc("initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "walkaway", version: "1" } }, timeout)
      raise Error, "the server named no MCP session (no Mcp-Session-Id header)" unless @session

      post({ jsonrpc: "2.0", method: "notifications/initialized" }, nil, timeout)
      result.dig("serverInfo", "name")
    end

    # Call a tool; returns its JSON answer, or raises with the tool's own error message.
    def tool(name, args, timeout:)
      result = rpc("tools/call", { name: name, arguments: args }, timeout)
      text = Array(result["content"]).find { |c| c.is_a?(Hash) && c["type"] == "text" }&.dig("text").to_s
      data = begin
        JSON.parse(text)
      rescue JSON::ParserError
        nil
      end
      if result["isError"]
        message = data.is_a?(Hash) ? (data["message"] || data.dig("error", "message") || data["error"]) : nil
        raise Error, "#{name}: #{message || text[0, 300]}"
      end
      raise Error, "#{name} answered no JSON" unless data.is_a?(Hash)

      data
    end

    # End the session (DELETE /mcp); returns the HTTP status, or 0 when nothing answered.
    def close(timeout: 10)
      return nil unless @session

      code = exchange(Net::HTTP::Delete.new(@uri), nil, timeout).first
      @session = nil
      code
    rescue Error
      0
    end

    private

    def rpc(method, params, timeout)
      id = (@id += 1)
      code, message = post({ jsonrpc: "2.0", id: id, method: method, params: params }, id, timeout)
      unless message
        raise Error.new("the MCP endpoint answered HTTP #{code} to #{method}", code) unless code.between?(200, 299)

        raise Error, "the MCP endpoint sent no answer to #{method}"
      end
      raise Error.new("#{method}: #{message.dig('error', 'message') || message['error']}", code) if message["error"]

      message["result"] || {}
    end

    def post(body, want, timeout)
      req = Net::HTTP::Post.new(@uri)
      req["Content-Type"] = "application/json"
      req.body = JSON.generate(body)
      exchange(req, want, timeout)
    end

    # Send one request on its own connection; returns [status, the JSON-RPC message with id `want` or nil].
    def exchange(req, want, timeout)
      @access.each { |k, v| req[k] = v }
      req["Authorization"] = "Bearer #{@token}" if @token
      req["Accept"] = "application/json, text/event-stream"
      req["Mcp-Session-Id"] = @session if @session
      req["MCP-Protocol-Version"] = PROTOCOL if @session
      http = Net::HTTP.new(@uri.host, @uri.port)
      http.use_ssl = @uri.scheme == "https"
      http.open_timeout = [timeout, 10].min
      http.read_timeout = timeout
      http.write_timeout = timeout
      http.max_retries = 0
      code = 0
      found = catch(:answered) do
        http.start do |h|
          h.request(req) do |res|
            code = res.code.to_i
            @session ||= res["mcp-session-id"]
            stream = res["content-type"].to_s.include?("text/event-stream")
            buf = +""
            res.read_body do |chunk|
              buf << chunk
              next unless stream && want

              message = from_stream(buf, want)
              throw :answered, message if message
            end
            throw :answered, nil if want.nil? || buf.strip.empty?
            throw :answered, stream ? from_stream("#{buf}\n\n", want) : from_json(buf, want)
          end
        end
      end
      [code, found]
    rescue Net::OpenTimeout, Net::ReadTimeout, Net::WriteTimeout
      raise Error, "the MCP endpoint did not answer within #{Stage.seconds(timeout)} s"
    rescue SocketError, SystemCallError, IOError, EOFError, OpenSSL::SSL::SSLError, Net::HTTPBadResponse => e
      raise Error, "the MCP endpoint could not be reached: #{e.class.name.split('::').last}: #{e.message}"
    end

    # The message with id `want` among the complete events of an event stream so far.
    def from_stream(buf, want)
      # Only complete events: the text after the last blank line may still be arriving.
      buf.split(/\r?\n\r?\n/, -1)[0...-1].each do |event|
        data = event.lines.filter_map { |l| l.chomp.delete_prefix("data:").strip if l.start_with?("data:") }.join("\n")
        next if data.empty?

        found = from_json(data, want)
        return found if found
      end
      nil
    end

    def from_json(text, want)
      parsed = JSON.parse(text)
      Array(parsed.is_a?(Array) ? parsed : [parsed]).find { |m| m.is_a?(Hash) && m["id"] == want }
    rescue JSON::ParserError
      nil
    end
  end

  # One run of the beat against one deployment.
  class Run
    def initialize(http:, clock:, secrets:, base:, access:, mcp_token:, ttl:, keep:, name:, via:, record:, record_out:, step_timeout:, reap_timeout:, poll:)
      @http = http
      @clock = clock
      @secrets = secrets
      @base = base
      @access = access
      @mcp_token = mcp_token
      @ttl = ttl
      @keep = keep
      @name = name || "walkaway-#{Time.now.utc.strftime('%m%d-%H%M%S')}"
      @via = via
      @record = record
      @record_out = record_out
      @step_timeout = step_timeout.to_f
      @reap_timeout = (reap_timeout || (ttl + 60)).to_f
      @poll = poll.to_f
      @deadline = Stage.now + @step_timeout
      @limit = @step_timeout
      @waiting = "the deployment"
    end

    # Run every step, then clean up. Returns the exit code.
    def call
      preflight
      create_colony
      seed
      walker_takes
      kill_walker
      reaped = wait_for_reaper
      landed = second_lands(reaped)
      verdict(reaped, landed)
      record_colony if @record
      Stage::EXIT_PASS
    rescue Stage::StepTimeout => e
      @clock.say("TIMEOUT #{e.message}")
      Stage::EXIT_TIMEOUT
    rescue Failure => e
      @clock.say("FAIL #{e.message}")
      Stage::EXIT_FAIL
    rescue Interrupt
      @clock.say("stopped by an interrupt")
      Stage::EXIT_FAIL
    ensure
      cleanup
    end

    private

    # --- steps --------------------------------------------------------------------------------------------------------

    def preflight
      res = @http.request(:get, "/api/about", timeout: [@step_timeout, 15].min, auth: false)
      about = res.ok? && res.json.is_a?(Hash) ? res.json : nil
      @clock.say("walk-away: an outside agent takes work and dies without a word; the colony takes it back and another agent lands it, on #{@http.base}#{about&.dig('commit') ? " (build #{about['commit']})" : ''}")
      unless about
        @clock.say("/api/about did not answer (#{res.problem}); going on without the deployment's flags")
        return
      end
      raise Failure, "inline changes are off on this deployment (FT_INLINE is not on in /api/about), and every agent here proposes inline" unless Array(about["flags"]).include?("FT_INLINE")
    end

    def create_colony
      name = @name
      created, secs = step("the deployment to create colony #{name}") do
        res = api(:post, "/colonies", { name: name, pool: 3 })
        raise Failure, "colony #{name} already exists: pass another --name" if res.code == 409
        raise Failure, "creating colony #{name}: #{res.problem}" unless res.ok? && res.json

        res.json
      end
      @colony = created["id"]
      @created = true
      step("review to switch off on #{@colony}") { api!(:post, "/colonies/#{@colony}/decide/policy", { enabled: false }) }
      limit, = step("the colony to take the silent-agent limit") do
        res = api(:post, "/colonies/#{@colony}/silent-ttl", { seconds: @ttl, by: BY })
        raise Failure, "this deployment has no silent-agent limit to set (POST /silent-ttl: #{res.problem}): it predates the closure ledger" unless res.ok? && res.json

        res.json
      end
      raise Failure, "the colony kept a silent-agent limit of #{limit['seconds'].inspect} s, not #{@ttl} s" unless limit["ms"] == (@ttl * 1000).round

      @clock.say("created colony #{@colony} (#{fmt(secs)}); review is off, and an agent outside the platform silent for #{Stage.seconds(@ttl)} s loses its intents")
    end

    def seed
      @seed_text = Walkaway.seed_text
      took, secs = step("the seed agent to be handed its intent") do
        agent = register("walkaway-seed", "synthetic")
        intent = declare(agent, "Create #{PATH}", "The file the walk-away beat changes.")
        [agent, take(agent, intent["id"], "the seed agent")]
      end
      landed, secs2 = step("the seed change to land") { settle(propose(took[0], took[1], nil, @seed_text, "create #{PATH}"), "the seed agent") }
      raise Failure, "the seed change #{landed['id']} did not land: it is #{landed['status']}#{reason_of(landed)}" unless landed["status"] == "landed"

      @clock.say("seeded #{PATH}, #{LINES} lines, in #{landed['landingId']} (#{fmt(secs + secs2)})")
    end

    def walker_takes
      title = "Set v2 to 20 in #{PATH}"
      why = "Walk-away beat: the agent that takes this is killed before it proposes, and another agent lands it."
      (@via == "mcp" ? method(:walker_over_mcp) : method(:walker_over_rest)).call(title, why)
      @walker_took_at = Stage.now
      @base_sha = @walker_take.dig("lease", "baseSha")
      how = @via == "mcp" ? "an outside agent over MCP" : "an outside agent over the REST API"
      @clock.say("the walker (#{@walker}, #{how}) took #{@intent['id']} \"#{@intent['title']}\" on trunk #{Walkaway.short(@base_sha)}")
    end

    def walker_over_mcp(title, why)
      step("the walker to join over MCP and take its intent") do
        @mcp = Mcp.new(@base, token: @mcp_token, access: @access)
        @clock.say("no FT_MCP_TOKEN: trying /mcp without one (only a deployment with FT_OPEN_WRITES=1 takes that)") unless @mcp_token
        begin
          server = @mcp.open!(timeout: [left, 30].min)
          joined = @mcp.tool("join", { colony: @colony, name: "walkaway-walker", model: "scripted" }, timeout: [left, 30].min)
          @secrets << joined["resumeKey"] if joined["resumeKey"].is_a?(String)
          @walker = joined["agentId"]
          raise Failure, "join over MCP answered no agent id" unless @walker.is_a?(String)

          @intent = declare(@walker, title, why)
          @walker_take = mcp_take
          @clock.say("the walker joined #{@colony} over MCP#{server ? " (server #{server})" : ''} as #{@walker}")
        rescue Mcp::Error => e
          refused = [401, 403].include?(e.code)
          hint = refused ? ": set FT_MCP_TOKEN to the deployment's MCP token, or pass --via rest to make the walker an outside agent over the REST API" : ""
          raise Failure, "the MCP endpoint #{refused ? 'refused' : 'failed'} the walker (#{e.message})#{hint}"
        end
      end
    end

    # Take over MCP until the walker holds its intent (a new colony's pool may still be forking).
    def mcp_take
      loop do
        t = @mcp.tool("take", {}, timeout: [left, 30].min)
        if t["intent"]
          raise Failure, "the walker was handed #{t.dig('intent', 'id')}, not its own intent #{@intent['id']}" unless t.dig("intent", "id") == @intent["id"]

          (t["tokens"] || {}).each_value { |s| @secrets << s if s.is_a?(String) && !@secrets.include?(s) }
          return t
        end
        @waiting = "the walker to be handed its intent over MCP (the colony said: #{t['reason'] || 'wait'})"
        pause([(t["retryInMs"] || 1000).to_f / 1000, 2].min)
      end
    end

    def walker_over_rest(title, why)
      step("the walker to take its intent") do
        @walker = register("walkaway-walker", "external")
        @intent = declare(@walker, title, why)
        @walker_take = take(@walker, @intent["id"], "the walker")
      end
    end

    def kill_walker
      if @mcp
        code = @mcp.close(timeout: [@step_timeout, 15].min)
        what = code&.between?(200, 299) ? "its MCP session ended (HTTP #{code})" : "it dropped its MCP session (the server answered the end of it with #{code&.positive? ? "HTTP #{code}" : 'nothing'})"
        @clock.say("killed the walker: #{what}, and it never called release")
      else
        @clock.say("killed the walker: it stops calling, and it never called release")
      end
      @killed_at = Stage.now
    end

    # The second agent asks for work until the reaper has taken the intent back from the silent walker.
    def wait_for_reaper
      @second = step("the second agent to register") { register("walkaway-second", "synthetic") }.first
      @deadline = Stage.now + @reap_timeout
      @limit = @reap_timeout
      @waiting = "the colony to take #{@intent['id']} back from the silent walker (limit #{Stage.seconds(@ttl)} s)"
      said = Stage.now
      took = nil
      loop do
        raise Stage::StepTimeout.new(@waiting, @limit) if left <= 0

        t = api!(:post, "/colonies/#{@colony}/agents/#{@second}/take", {})
        if t["intent"]
          raise Failure, "the second agent was handed #{t.dig('intent', 'id')}, not the walker's intent #{@intent['id']}" unless t.dig("intent", "id") == @intent["id"]

          [t.dig("lease", "token"), t.dig("lease", "trunk", "token")].each { |s| @secrets << s if s.is_a?(String) && !@secrets.include?(s) }
          took = t
          break
        end
        if Stage.now - said >= SAY_EVERY_S
          said = Stage.now
          @clock.say("the second agent (#{@second}) asks for work: none yet (the walker has been silent #{Stage.seconds((Stage.now - @walker_took_at).round)} s of the #{Stage.seconds(@ttl)} s limit; the colony said: #{t['reason'] || 'wait'})")
        end
        pause(@poll)
      end
      @second_take = took
      check_reaped(took)
    end

    # What the reaper left: the cause, the gap, the walker named, a failure mark on the file and the cause on the record.
    def check_reaped(took)
      closure = took.dig("intent", "closure")
      history, = step("the intent's history") { api!(:get, "/colonies/#{@colony}/intents/#{@intent['id']}") }
      reaped = Array(history["closures"]).find { |c| c["cause"] == "reaped_silent" } || (closure if closure&.dig("cause") == "reaped_silent")
      raise Failure, "the intent came back with no reaped_silent closure (its history: #{Array(history['closures']).map { |c| c['cause'] }.join(', ').then { |s| s.empty? ? 'none' : s }})" unless reaped
      raise Failure, "the reaped_silent closure names #{reaped['agentId'].inspect}, not the walker #{@walker}" unless reaped["agentId"] == @walker
      raise Failure, "the reaped_silent closure says the walker was a #{reaped['agentKind'].inspect} agent, not an outside (external) one" unless reaped["agentKind"] == "external"

      gap = reaped["gapMs"]
      raise Failure, "the reaped_silent closure has no gap" unless gap.is_a?(Numeric)
      raise Failure, "the walker was taken back after #{Walkaway.duration(gap)} of silence, under the #{Stage.seconds(@ttl)} s limit" if gap < (@ttl * 1000) - 1000

      field, = step("the field of #{PATH}") { api!(:get, "/colonies/#{@colony}/field?region=#{URI.encode_www_form_component(region_of(PATH))}") }
      mark = Array(field).flat_map { |r| [r.dig("byPath", PATH, "failure")] }.compact.max
      raise Failure, "no failure mark on #{PATH} after the reaper took the intent back" unless mark.is_a?(Numeric) && mark.positive?

      # The record is written in batches (every half second): ask again until the event is in it.
      recorded, = step("the reaper's intent event in the colony's record (GET /events)") do
        loop do
          events = api!(:get, "/colonies/#{@colony}/events?after=0&limit=5000")
          found = Array(events["events"]).find { |e| e["t"] == "intent" && e["intentId"] == @intent["id"] && e["cause"] == "reaped_silent" }
          break found if found
          raise Failure, "the colony's record has no intent event with the cause reaped_silent for #{@intent['id']}" if left < 1

          pause(0.5)
        end
      end

      @clock.say("the colony took #{@intent['id']} back from the walker, silent #{Walkaway.duration(gap)} (limit #{Stage.seconds(@ttl)} s): " \
                 "cause reaped_silent, a failure mark of #{format('%.2f', mark)} on #{PATH}")
      seen = closure&.dig("cause") == "reaped_silent" ? "and its take says why: reaped_silent, the walker silent #{Walkaway.duration(closure['gapMs'] || gap)}" : "(its take did not say why)"
      @clock.say("the second agent (#{@second}) was handed #{@intent['id']} #{seen}")
      reaped
    end

    def second_lands(_reaped)
      text = Walkaway.edit(@seed_text, EDIT[0], EDIT[1])
      p, secs = step("the second agent's change to land") { settle(propose(@second, @second_take, @seed_text, text, "line #{EDIT[0]}: #{EDIT[1]}"), "the second agent") }
      raise Failure, "the second agent's change #{p['id']} did not land: it is #{p['status']}#{reason_of(p)}" unless p["status"] == "landed"

      @clock.say("the second agent changed line #{EDIT[0]}: landed in #{p['landingId']} (#{fmt(secs)})")
      p
    end

    def verdict(reaped, landed)
      history, = step("the intent's history") { api!(:get, "/colonies/#{@colony}/intents/#{@intent['id']}") }
      closures = Array(history["closures"])
      metrics, = step("the colony's metrics") { api!(:get, "/colonies/#{@colony}/metrics") }
      shares = metrics["closures"]
      closure_table(closures)
      shares_table(shares)
      problems = []
      problems << "the intent did not land (it is #{history.dig('intent', 'status')})" unless history.dig("intent", "status") == "landed"
      last = closures.first
      problems << "its newest closure is #{last&.dig('cause').inspect}, not landed by the second agent" unless last && last["cause"] == "landed" && last["agentId"] == @second
      problems << "the colony's metrics carry no closure shares" unless shares.is_a?(Hash)
      problems << "the metrics count no reaped_silent closure for outside agents" if shares.is_a?(Hash) && shares.dig("byKind", "external", "counts", "reaped_silent").to_i < 1
      raise Failure, problems.join("; ") unless problems.empty?

      @clock.say("PASS the walker's intent came back to the colony #{Walkaway.duration(reaped['gapMs'])} after its last call, with a failure mark, and the second agent landed it in #{landed['landingId']}")
    end

    def record_colony
      script = File.expand_path("record_colony.ts", __dir__)
      out_args = @record_out ? ["--out", @record_out] : ["--bundle"]
      @clock.say("recording #{@colony} for playback with no network (scripts/record_colony.ts)")
      env = { "CF_ACCESS_CLIENT_ID" => @access["CF-Access-Client-Id"], "CF_ACCESS_CLIENT_SECRET" => @access["CF-Access-Client-Secret"] }
      ok, out, err, timed_out = Stage.run([Stage::NODE, "--experimental-transform-types", script, "--base", @base, "--colony", @colony, "--name", RECORDING, *out_args],
                                          env: env, chdir: File.expand_path("..", __dir__), timeout: 600)
      raise Failure, "the recorder did not finish within 600 s" if timed_out
      raise Failure, "the recorder failed: #{(err.strip.lines.last || out.strip.lines.last).to_s.strip[0, 300]}" unless ok

      out.lines.each { |l| @clock.print("  #{l.chomp}") }
      where = @record_out || "packages/web/public/recordings/#{RECORDING}.json.gz"
      @clock.say("recorded: #{where}; once bundled, /c/#{@colony}?replay=1&recording=#{RECORDING} plays it (director: &director=1)")
    end

    def cleanup
      @mcp&.close(timeout: 5)
      return unless @colony
      return @clock.say("left colony #{@colony} as it was: #{@http.base}/c/#{@colony}") unless @created
      return @clock.say("kept colony #{@colony}: #{@http.base}/c/#{@colony}") if @keep

      res = @http.request(:delete, "/api/colonies/#{@colony}", timeout: 600)
      @clock.say(res.ok? ? "deleted colony #{@colony}" : "could not delete colony #{@colony} (#{res.problem}): delete it with ft delete #{@colony} --yes")
    end

    # --- output -------------------------------------------------------------------------------------------------------

    def closure_table(closures)
      @clock.print
      @clock.print("closures of #{@intent['id']} \"#{@intent['title']}\", newest first (GET /intents/#{@intent['id']})")
      closures.each do |c|
        who = c["agentId"] == @walker ? "the walker" : c["agentId"] == @second ? "the second agent" : c["agentId"].to_s
        gap = c["gapMs"].is_a?(Numeric) ? Walkaway.duration(c["gapMs"]) : "-"
        @clock.print(format("  %-14s %-18s %-10s silent %-12s -> %s", c["cause"], who, c["agentKind"], gap, c["status"]))
      end
    end

    def shares_table(shares)
      return unless shares.is_a?(Hash)

      @clock.print
      @clock.print("closure shares in #{@colony} (GET /metrics)")
      (shares["byKind"] || {}).each do |kind, k|
        parts = (k["counts"] || {}).map { |cause, n| "#{cause} #{n} (#{format('%.0f%%', (k.dig('shares', cause) || 0) * 100)})" }
        @clock.print(format("  %-10s %3d  %s", kind, k["total"].to_i, parts.join(", ")))
      end
      r = shares["reaped"] || {}
      @clock.print("  silent-agent limit #{Stage.seconds(shares['silentTtlMs'].to_i / 1000.0)} s; #{r['count'].to_i} taken back from silent agents" \
                   "#{r['medianGapMs'] ? ", median gap #{Walkaway.duration(r['medianGapMs'])}" : ''}")
      @clock.print
    end

    # --- the API ------------------------------------------------------------------------------------------------------

    def step(waiting)
      @deadline = Stage.now + @step_timeout
      @limit = @step_timeout
      @waiting = waiting
      t = Stage.now
      [yield, Stage.now - t]
    end

    def left = @deadline - Stage.now

    def api(method, path, body = nil)
      raise Stage::StepTimeout.new(@waiting, @limit) if left <= 0

      res = @http.request(method, "/api#{path}", body: body, timeout: [left, 60].min)
      raise Stage::StepTimeout.new(@waiting, @limit) if res.code.zero? && left <= 0.05

      res
    end

    def api!(method, path, body = nil)
      res = api(method, path, body)
      raise Failure, "#{method.to_s.upcase} /api#{path}: #{res.problem}" unless res.ok? && !res.json.nil?

      res.json
    end

    def pause(seconds)
      raise Stage::StepTimeout.new(@waiting, @limit) if left <= 0

      sleep([seconds, left].min)
    end

    def register(name, kind)
      api!(:post, "/colonies/#{@colony}/agents", { name: name, kind: kind, model: "scripted" })["id"]
    end

    def declare(agent, title, why)
      res = api(:post, "/colonies/#{@colony}/intents", { title: title, why: why, footprint: [PATH], assignedTo: agent, createdBy: BY, force: true })
      raise Failure, "declaring \"#{title}\": #{res.problem}" unless res.ok? && res.json

      res.json
    end

    # Take until the agent holds `intent_id` (a new colony's workspace pool may still be forking).
    def take(agent, intent_id, who)
      loop do
        t = api!(:post, "/colonies/#{@colony}/agents/#{agent}/take", {})
        if t["intent"]
          raise Failure, "#{who} was handed #{t.dig('intent', 'id')}, not its own intent #{intent_id}" unless t.dig("intent", "id") == intent_id

          [t.dig("lease", "token"), t.dig("lease", "trunk", "token")].each { |s| @secrets << s if s.is_a?(String) && !@secrets.include?(s) }
          return t
        end
        @waiting = "#{who} to be handed its intent (the colony said: #{t['reason'] || 'wait'})"
        pause([(t["retryInMs"] || 1000).to_f / 1000, 2].min)
      end
    end

    # Propose `text` for the beat's file as an inline change on the lease's base (`base_text`: the file there, or nil).
    def propose(agent, took, base_text, text, summary)
      write = [{ path: PATH, blob: Stage.blob_id(text) }]
      base = took.dig("lease", "baseSha")
      body = {
        intentId: took.dig("intent", "id"), agentId: agent, workspace: took.dig("lease", "repo"), baseSha: base,
        headSha: Stage.changeset_id(base, write), writeSet: write,
        readSet: base_text ? [{ path: PATH, blob: Stage.blob_id(base_text) }] : [],
        contents: { write[0][:blob] => text }, intentRevision: took.dig("intent", "revision") || 1,
        declared: { footprint: [PATH], summary: summary },
        evidence: { checks: [], notVerified: "A scripted stage beat: no tests were run." }
      }
      api!(:post, "/colonies/#{@colony}/proposals", body)
    end

    def settle(proposal, who)
      loop do
        p = api!(:get, "/colonies/#{@colony}/proposals/#{proposal['id']}")
        return p if SETTLED.include?(p["status"])

        @waiting = "#{who}'s change #{proposal['id']} to land or go back (it is #{p['status']})"
        pause(0.5)
      end
    end

    # The colony's region of a path at depth 1 ("src" for src/values.ts).
    def region_of(path) = path.include?("/") ? path.split("/").first : "."

    def reason_of(p) = p["reason"] ? ": #{p['reason']}" : ""

    def fmt(secs) = format("%.1f s", secs)
  end

  # Parse the command line and run the beat; returns the exit code.
  def self.main(argv)
    opts = { ttl: 90, keep: false, name: nil, via: "mcp", record: false, record_out: nil, step_timeout: 90.0, reap_timeout: nil, poll: 5.0, base: nil }
    OptionParser.new do |o|
      o.banner = "Usage: FT_TOKEN=... FT_MCP_TOKEN=... ruby scripts/walkaway.rb --base <url> [options]"
      o.on("--base URL", "The deployment, e.g. https://staging.firetrident.com") { |v| opts[:base] = v }
      o.on("--ttl S", Integer, "The colony's silent-agent limit, in seconds (default 90; 60 to 86400)") { |v| opts[:ttl] = v }
      o.on("--record", "Record the colony into packages/web/public/recordings/walkaway.json.gz before deleting it") { opts[:record] = true }
      o.on("--record-out FILE", "Record to FILE instead (implies --record)") do |v|
        opts[:record] = true
        opts[:record_out] = File.expand_path(v)
      end
      o.on("--keep", "Keep the colony (default: delete it at the end)") { opts[:keep] = true }
      o.on("--name NAME", "Name of the new colony (default walkaway-<time>)") { |v| opts[:name] = v }
      o.on("--via WAY", %w[mcp rest], "How the walker talks to the colony: mcp (default) or rest") { |v| opts[:via] = v }
      o.on("--step-timeout S", Float, "Hard time limit of each step, in seconds (default 90)") { |v| opts[:step_timeout] = v }
      o.on("--reap-timeout S", Float, "How long to wait for the reaper (default the limit plus 60 s)") { |v| opts[:reap_timeout] = v }
      o.on("--poll S", Float, "How often the second agent asks for work while it waits (default 5 s)") { |v| opts[:poll] = v }
    end.parse!(argv)
    base = Stage.base_url(opts[:base])
    token = Stage.token(base)
    raise Stage::ConfigError, "FT_TOKEN is not set (the deployment's admin token: set it, or put it in ~/.config/firetrident/env with that deployment's FT_URL)" unless token
    raise Stage::ConfigError, "--ttl must be from 60 to 86400 seconds" unless opts[:ttl].between?(60, 86_400)

    access = Stage.access_headers
    mcp_token = opts[:via] == "mcp" ? mcp_token(base) : nil
    secrets = [token, mcp_token, *access.values].compact
    clock = Stage::Clock.new(secrets: secrets)
    http = Stage::Http.new(base, token: token, access: access)
    Run.new(http: http, clock: clock, secrets: secrets, base: base, access: access, mcp_token: mcp_token, ttl: opts[:ttl], keep: opts[:keep], name: opts[:name],
            via: opts[:via], record: opts[:record], record_out: opts[:record_out], step_timeout: opts[:step_timeout], reap_timeout: opts[:reap_timeout],
            poll: opts[:poll]).call
  rescue Stage::ConfigError, OptionParser::ParseError => e
    warn("walkaway: #{e.message}")
    Stage::EXIT_USAGE
  end
end

exit(Walkaway.main(ARGV)) if $PROGRAM_NAME == __FILE__
