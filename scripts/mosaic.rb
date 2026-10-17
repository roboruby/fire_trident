#!/usr/bin/env ruby
# frozen_string_literal: true

# The mosaic beat: a hundred small changes land on two shared files at once. On a colony it creates:
#
#   1. a fresh colony named mosaic-<time>, with review off, so the trunk writer alone decides and no model is asked
#   2. a seed agent lands the seed project in demo/mosaic as one inline change: index.html (a tiny static page),
#      mosaic.json (a 10 by 10 grid, one line per tile, every color empty, a blank line between tiles because a line
#      merge that follows git's rule calls edits on touching lines a conflict) and roll-call.md
#   3. N scripted agents (default 20) lay the picture: each declares its next tile intent, "Fill tile (r, c) with
#      <color>", takes it and proposes a change to that tile's line of mosaic.json alone; every tenth intent also adds
#      one line naming its agent at the end of roll-call.md. All of them run at once, and every change is written
#      against the seed, so the colony lands each one onto whatever trunk holds by then: line by line (text merge) for
#      the tiles, and as the union of the added lines (the insertion rule) for the roll call
#   4. a change that goes back, and a tile the colony gives back before its agent starts (it could not lease a
#      workspace), is taken again by a fresh agent once every tile is handed out (a change at most 3 times per tile)
#   5. it checks 100 of 100 tiles filled with the picture's colors, roll-call.md holding all 10 names, and 0 returns or
#      every return relanded; with --record it records the colony with scripts/record_colony.ts into
#      packages/web/public/recordings/mosaic.json.gz so the beat plays with no network; then it deletes the colony
#      (--keep leaves it)
#
# The files are read back through the sandboxed preview route (GET /api/colonies/<id>/preview/<commit>/<path>), which
# serves only colonies the deployment lists in FT_PUBLIC_GIT or FT_PUBLIC_MCP; the replay's picture panel reads it the
# same way. For a colony that is not listed, mosaic.json is checked by the blob its last landing wrote (from the
# lineage) and roll-call.md by its size, and --record refuses to run, since the recording would hold no picture: pass
# --name with a colony name the deployment lists.
#
# Every agent is this script over the HTTP API with inline changes (synthetic agents): no git, no model calls. Each
# agent works in its own thread with its own connection. Each step has a hard time limit, and the whole picture has one
# (--timeout); a step that runs out says what it was waiting for, and the script exits 3.
#
# Usage:
#   FT_TOKEN=<admin token> ruby scripts/mosaic.rb --base https://staging.firetrident.com
#     [--agents 20] [--name NAME] [--keep] [--record] [--record-out FILE] [--step-timeout 90] [--timeout 600]
#
# The deployment needs FT_INLINE, FT_TEXT_MERGE and FT_MERGE_INSERTIONS on for the colony. Behind Cloudflare Access,
# set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET; they go with every request, the recorder's included. FT_TOKEN
# comes from the environment, else from ~/.config/firetrident/env when that file's FT_URL is this deployment. Never
# prints a token. Exit codes: 0 the beat showed what it should, 1 it did not, 2 a setting is missing, 3 a step timed out.
require "optparse"
require "set"
require_relative "stage"

module Mosaic
  # The seed project, landed as the colony's first change.
  SEED_DIR = File.expand_path("../demo/mosaic", __dir__)
  PAGE = "index.html"
  MOSAIC = "mosaic.json"
  ROLL_CALL = "roll-call.md"
  SEED_FILES = [PAGE, MOSAIC, ROLL_CALL].freeze
  ROWS = 10
  COLS = 10
  # The picture the tiles lay, one letter per tile (PALETTE): a trident rising from the sea at night.
  PICTURE = %w[
    NENNEENNEN
    NGNNGGNNGN
    NGNNGGNNGN
    NGGGGGGGGN
    NNNNGGNNNN
    NNNNGGNNNN
    NNNNGGNNNN
    SSSSGGSSSS
    SFSSSSSFSS
    SSSFSSSSSF
  ].freeze
  PALETTE = {
    "N" => %w[night #22335c],
    "E" => %w[ember #e63946],
    "G" => %w[gold #f3a712],
    "S" => %w[sea #1d7874],
    "F" => %w[foam #a8dadc]
  }.freeze
  # Tiles are handed out with a stride of 37 through the 100, so the picture fills in scattered over the grid.
  STRIDE = 37
  # Every tenth intent in that order also signs the roll call.
  ROLL_EVERY = 10
  # Proposal statuses a change stops being waited for at (escalated: waiting for a person, which this beat does not do).
  SETTLED = %w[landed returned rejected escalated].freeze
  # How often one tile is proposed, the first time included, before the run gives up on it.
  MAX_ATTEMPTS = 3
  # Agents laying tiles at most, and relanding agents at once.
  MAX_AGENTS = 64
  RELANDERS = 4
  # Agents asking for their first workspace at once: a new agent's lease is a slow one, and the pool answers past 16
  # slow leases at once that it is empty, which gives the agent's intent back.
  FIRST_TAKES = 8
  # How often an agent asks whether its change has landed, in seconds.
  POLL_S = 1.0
  # The flags the beat needs on, and why.
  NEEDS = {
    "FT_INLINE" => "every agent here proposes inline",
    "FT_TEXT_MERGE" => "every tile change is written against the seed and lands by text merge",
    "FT_MERGE_INSERTIONS" => "the roll call's added lines land together by the insertion rule"
  }.freeze
  BY = ENV.fetch("FT_USER", "stage-mosaic")
  RECORDING = "mosaic"

  # The beat could not show what it should; the message says what happened.
  class Failure < StandardError; end

  # Another agent's thread failed: this one stops where it is.
  class Stopped < StandardError; end

  # One tile intent: where it is, its color, and whether it also signs the roll call.
  Tile = Struct.new(:order, :r, :c, :letter, :roll_call, keyword_init: true) do
    def color_name = PALETTE.fetch(letter)[0]
    def color = PALETTE.fetch(letter)[1]
    def at = "(#{r}, #{c})"
    def title = "Fill tile #{at} with #{color_name}#{roll_call ? ' and sign the roll call' : ''}"
    def footprint = roll_call ? [MOSAIC, ROLL_CALL] : [MOSAIC]

    def why
      text = "The mosaic's picture has #{color_name} (#{color}) at row #{r}, column #{c}: change only that tile's line of #{MOSAIC}."
      roll_call ? "#{text} Every tenth tile also signs #{ROLL_CALL}: add one line naming the agent at its end." : text
    end
  end

  # The 100 tiles in the order they are handed out.
  def self.tiles
    (0...(ROWS * COLS)).map do |k|
      i = (k * STRIDE) % (ROWS * COLS)
      r, c = i.divmod(COLS)
      Tile.new(order: k, r: r, c: c, letter: PICTURE.fetch(r)[c], roll_call: k % ROLL_EVERY == ROLL_EVERY - 1)
    end
  end

  # The seed project's files by path, read from demo/mosaic and checked: mosaic.json holds every tile empty, one per line.
  def self.seed
    files = SEED_FILES.to_h { |p| [p, File.read(File.join(SEED_DIR, p), encoding: "UTF-8")] }
    tiles.each do |t|
      raise Failure, "the seed's #{MOSAIC} has no empty line for tile #{t.at}" unless files[MOSAIC].lines.one? { |l| l.include?(empty_tile(t)) }
    end
    files
  end

  def self.empty_tile(tile) = %({"r": #{tile.r}, "c": #{tile.c}, "color": null})

  # `text` (a version of mosaic.json) with `tile`'s line filled with its color; nothing else changes.
  def self.fill(text, tile)
    text.lines.map { |l| l.include?(empty_tile(tile)) ? l.sub("\"color\": null", "\"color\": \"#{tile.color}\"") : l }.join
  end

  # The line `agent` adds to the roll call for `tile`.
  def self.roll_line(agent_name, tile) = "- #{agent_name} laid tile #{tile.at} in #{tile.color_name}\n"

  # The colors a version of mosaic.json gives each tile, [r, c] => color (nil: empty), or nil when it is not the grid.
  def self.grid(text)
    data = JSON.parse(text.to_s)
    return nil unless data.is_a?(Hash) && data["tiles"].is_a?(Array)

    data["tiles"].each_with_object({}) do |t, out|
      next unless t.is_a?(Hash) && t["r"].is_a?(Integer) && t["c"].is_a?(Integer)

      out[[t["r"], t["c"]]] = t["color"].is_a?(String) ? t["color"].downcase : nil
    end
  rescue JSON::ParserError
    nil
  end

  def self.short(sha) = sha.to_s[0, 7]

  # One agent's view of the API: its own connection, and the hard time limit of the step it is on.
  class Session
    attr_reader :http

    def initialize(http, step_timeout, stopped: -> { false })
      @http = http
      @step_timeout = step_timeout.to_f
      @stopped = stopped
      @limit = @step_timeout
      @deadline = Stage.now + @step_timeout
      @waiting = "the deployment"
    end

    attr_writer :waiting

    # Run one step under its own time limit (the step limit, or `limit` seconds); returns [its value, seconds taken].
    def step(waiting, limit = nil)
      @limit = limit || @step_timeout
      @deadline = Stage.now + @limit
      @waiting = waiting
      t = Stage.now
      [yield, Stage.now - t]
    end

    def left = @deadline - Stage.now

    def api(method, path, body = nil, auth: true)
      raise Stopped if @stopped.call
      raise Stage::StepTimeout.new(@waiting, @limit) if left <= 0

      res = @http.request(method, "/api#{path}", body: body, timeout: [left, 60].min, auth: auth)
      raise Stage::StepTimeout.new(@waiting, @limit) if res.code.zero? && left <= 0.05

      res
    end

    def api!(method, path, body = nil)
      res = api(method, path, body)
      raise Failure, "#{method.to_s.upcase} /api#{path}: #{res.problem}" unless res.ok? && !res.json.nil?

      res.json
    end

    def pause(seconds)
      raise Stopped if @stopped.call
      raise Stage::StepTimeout.new(@waiting, @limit) if left <= 0

      sleep([seconds, left].min)
    end
  end

  # One run of the beat against one deployment.
  class Run
    def initialize(http:, connect:, clock:, secrets:, base:, access:, agents:, keep:, name:, record:, record_out:, step_timeout:, timeout:)
      @http = http
      @connect = connect
      @clock = clock
      @secrets = secrets
      @base = base
      @access = access
      @agents = agents
      @keep = keep
      @name = name || "mosaic-#{Time.now.utc.strftime('%m%d-%H%M%S')}"
      @record = record
      @record_out = record_out
      @step_timeout = step_timeout.to_f
      @timeout = timeout.to_f
      @lock = Mutex.new
      @say = Mutex.new
      @tiles = Mosaic.tiles
      @queue = @tiles.dup
      @by_intent = {}
      @landed = {}
      @returns = []
      @reopened = {}
      @attempts = Hash.new(0)
      @errors = []
      @fresh = 0
      @given_back = 0
      @first_takes = Thread::SizedQueue.new(FIRST_TAKES)
      FIRST_TAKES.times { @first_takes.push(true) }
      @main = Session.new(http, @step_timeout)
    end

    # Run every step, then clean up. Returns the exit code.
    def call
      preflight
      create_colony
      seed
      check_preview
      lay
      reland
      verdict
      record_colony if @record
      Stage::EXIT_PASS
    rescue Stage::StepTimeout => e
      say("TIMEOUT #{e.message}")
      Stage::EXIT_TIMEOUT
    rescue Failure => e
      say("FAIL #{e.message}")
      Stage::EXIT_FAIL
    rescue Interrupt
      @stop = true
      say("stopped by an interrupt")
      Stage::EXIT_FAIL
    ensure
      cleanup
    end

    private

    # --- steps --------------------------------------------------------------------------------------------------------

    def preflight
      res = @http.request(:get, "/api/about", timeout: [@step_timeout, 15].min, auth: false)
      about = res.ok? && res.json.is_a?(Hash) ? res.json : nil
      say("mosaic: #{@agents} agents lay a 10 by 10 picture, 100 tile changes to one file and 10 lines added to another, all at once, on #{@http.base}#{about&.dig('commit') ? " (build #{about['commit']})" : ''}")
      unless about
        say("/api/about did not answer (#{res.problem}); going on without the deployment's flags")
        return
      end
      flags = Array(about["flags"])
      NEEDS.each { |flag, why| raise Failure, "#{flag} is off on this deployment (not in /api/about), and #{why}" unless flags.include?(flag) }
      say("inline changes, text merge and its insertion rule are on here (a flag that lists colonies must list this one too)")
    end

    def create_colony
      name = @name
      created, secs = @main.step("the deployment to create colony #{name}") do
        res = @main.api(:post, "/colonies", { name: name, pool: [@agents, 32].min })
        raise Failure, "colony #{name} already exists: pass another --name" if res.code == 409
        raise Failure, "creating colony #{name}: #{res.problem}" unless res.ok? && res.json

        res.json
      end
      @colony = created["id"]
      @created = true
      @main.step("review to switch off on #{@colony}") { @main.api!(:post, "/colonies/#{@colony}/decide/policy", { enabled: false }) }
      say("created colony #{@colony} (#{fmt(secs)}); review is off, so the trunk writer alone decides and no model is asked")
    end

    def seed
      @seed = Mosaic.seed
      took, secs = @main.step("the seed agent to be handed its intent") do
        agent = register(@main, "mosaic-seed")
        intent = declare_raw(@main, agent, "Create the mosaic project", "The seed: a tiny static page, the empty grid every tile intent fills, and the roll call.", SEED_FILES)
        [agent, take(@main, agent, intent["id"], "the seed agent")]
      end
      agent, assignment = took
      write = SEED_FILES.map { |p| { path: p, blob: Stage.blob_id(@seed[p]) } }
      base = assignment.dig("lease", "baseSha")
      landed, secs2 = @main.step("the seed change to land") do
        settle(@main, propose_raw(@main, agent, assignment, base, write, [], @seed.values, "create #{SEED_FILES.join(', ')}"), "the seed agent")
      end
      raise Failure, "the seed change #{landed['id']} did not land: it is #{landed['status']}#{reason_of(landed)}" unless landed["status"] == "landed"

      @seed_sha = landing_commit(landed["landingId"])
      say("seeded #{SEED_FILES.join(', ')} in #{landed['landingId']} at #{short(@seed_sha)} (#{fmt(secs + secs2)}); every tile change is written against this commit")
    end

    # Whether the preview route serves this colony (it does for public colonies only), and how it serves a file.
    def check_preview
      path = "/colonies/#{@colony}/preview/#{@seed_sha}/#{MOSAIC}"
      res, = @main.step("the preview of #{MOSAIC} at the seed") { @main.api(:get, path, auth: false) }
      if res.ok?
        csp = res.headers["content-security-policy"].to_s
        problems = []
        problems << "no sandbox policy (Content-Security-Policy: #{csp.empty? ? 'none' : csp})" unless csp.split(";").first.to_s.strip == "sandbox"
        problems << "no X-Content-Type-Options: nosniff" unless res.headers["x-content-type-options"].to_s.downcase == "nosniff"
        problems << "no immutable cache for a pinned commit" unless res.headers["cache-control"].to_s.include?("immutable")
        problems << "it is not the seed's #{MOSAIC}" unless res.body.to_s.b == @seed[MOSAIC].b
        raise Failure, "the preview route serves #{MOSAIC} at the seed with #{problems.join('; ')}" unless problems.empty?

        @public = true
        say("the colony is public here: its files read at any landing through GET /api#{path.sub(@seed_sha, '<commit>').sub(MOSAIC, '<path>')}, sandboxed (#{csp.split(';').first.strip}, nosniff, cached as immutable)")
        return
      end
      @public = false
      why = res.json.is_a?(Hash) && res.json["error"] ? res.json["error"] : res.problem
      if @record
        raise Failure, "the recording would hold no picture: the preview route does not serve colony #{@colony} (#{why}); list the colony in FT_PUBLIC_GIT on the deployment, or pass --name with a colony name it lists"
      end
      say("the preview route does not serve colony #{@colony} (#{why}): the picture is checked from its lineage instead, and a replay of it has no picture to draw")
    end

    # The agents lay every tile at once, each in its own thread, until the queue is empty.
    def lay
      @t0 = Stage.now
      @run_deadline = @t0 + @timeout
      say("#{@agents} agents start laying 100 tiles, handed out scattered over the grid; every tenth also signs the roll call")
      run_threads(@agents) { |i| lay_loop(i) }
      landed = @lock.synchronize { @landed.size }
      gone = @lock.synchronize { @reopened.size }
      back = @given_back.positive? ? ", #{@given_back} given back before their agent started" : ""
      say("every tile was handed out: #{landed} of 100 landed, #{gone} went back to the colony#{back} (#{fmt(Stage.now - @t0)})")
    end

    # Changes that went back are taken again by fresh agents, until every tile has landed.
    def reland
      waiting = @tiles.size - @landed.size
      return if waiting.zero?

      say("#{waiting} tile(s) wait in the colony (#{@reopened.size} went back, #{@given_back} given back before their agent started); fresh agents take them and propose them")
      run_threads(RELANDERS) { |_| reland_loop }
      say("relanded: #{@landed.size} of 100 tiles landed (#{fmt(Stage.now - @t0)})")
    end

    def verdict
      took = Stage.now - @t0
      problems = []
      missing = @tiles.reject { |t| @landed.key?(t) }
      problems << "#{missing.size} tile(s) never landed: #{missing.first(5).map(&:at).join(', ')}" unless missing.empty?
      picture, roll = @public ? read_back : check_by_lineage
      problems.concat(picture[:problems])
      problems.concat(roll[:problems])
      show_picture(picture)
      show_roll_call(roll)
      returned = @returns.map { |r| r[:tile] }.uniq
      relanded = returned.count { |t| @landed.key?(t) }
      @clock.print("returns: #{@returns.size} (#{returned.size} tile(s)); relanded: #{relanded} of #{returned.size}" \
                   "#{@given_back.positive? ? "; #{@given_back} tile(s) given back by the colony before their agent started, taken again by fresh agents" : ''}")
      @returns.first(10).each { |r| @clock.print("  tile #{r[:tile].at} by #{r[:agent]}: #{r[:reason].to_s[0, 240]}") }
      @clock.print
      problems << "#{returned.size - relanded} tile(s) went back and never landed again" if relanded < returned.size
      raise Failure, problems.join("; ") unless problems.empty?

      per_min = 100 / (took / 60.0)
      say("PASS 100 of 100 tiles filled, #{roll[:names]} of 10 names on the roll call, #{@returns.empty? ? '0 returns' : "#{@returns.size} return(s), every one relanded"}; " \
          "100 tile changes landed in #{fmt(took)} (#{format('%.0f', per_min)} a minute) by #{@agents} agents")
    end

    def record_colony
      script = File.expand_path("record_colony.ts", __dir__)
      out_args = @record_out ? ["--out", @record_out] : ["--bundle"]
      say("recording #{@colony} for playback with no network (scripts/record_colony.ts), the picture at each landing included")
      env = { "CF_ACCESS_CLIENT_ID" => @access["CF-Access-Client-Id"], "CF_ACCESS_CLIENT_SECRET" => @access["CF-Access-Client-Secret"] }
      ok, out, err, timed_out = Stage.run([Stage::NODE, "--experimental-transform-types", script, "--base", @base, "--colony", @colony, "--name", RECORDING, *out_args],
                                          env: env, chdir: File.expand_path("..", __dir__), timeout: 600)
      raise Failure, "the recorder did not finish within 600 s" if timed_out
      raise Failure, "the recorder failed: #{(err.strip.lines.last || out.strip.lines.last).to_s.strip[0, 300]}" unless ok

      out.lines.each { |l| @clock.print("  #{l.chomp}") }
      where = @record_out || "packages/web/public/recordings/#{RECORDING}.json.gz"
      say("recorded: #{where}; once bundled, /c/#{@colony}?replay=1&recording=#{RECORDING} plays it with the picture (director: &director=1)")
    end

    def cleanup
      @stop = true
      return unless @colony
      return say("kept colony #{@colony}: #{@http.base}/c/#{@colony}") if @keep

      res = @http.request(:delete, "/api/colonies/#{@colony}", timeout: 600)
      say(res.ok? ? "deleted colony #{@colony}" : "could not delete colony #{@colony} (#{res.problem}): delete it with ft delete #{@colony} --yes")
    end

    # --- the agents ---------------------------------------------------------------------------------------------------

    # Run `count` threads of `work`, each with its index; the first failure stops the others and is raised here.
    def run_threads(count, &work)
      threads = count.times.map do |i|
        Thread.new do
          work.call(i)
        rescue Stopped
          nil
        rescue StandardError => e
          @lock.synchronize { @errors << e }
          @stop = true
        end
      end
      threads.each(&:join)
      first = @errors.first
      raise first if first
    end

    def session = Session.new(@connect.call, @step_timeout, stopped: -> { @stop })

    def lay_loop(i)
      s = session
      name = format("mosaic-%02d", i + 1)
      agent, = s.step("agent #{name} to join") { register(s, name) }
      first = true
      loop do
        tile = @lock.synchronize { @queue.shift }
        break unless tile

        check_run_deadline
        intent, = s.step("#{name} to declare tile #{tile.at}") { declare(s, agent, tile) }
        # At most FIRST_TAKES agents ask for their first workspace at once, under the pool's cap on slow leases.
        @first_takes.pop if first
        begin
          held, = s.step("#{name} to be handed tile #{tile.at}") { take_own(s, agent, intent["id"], name) }
        ensure
          @first_takes.push(true) if first
          first = false
        end
        next unless held

        assignment, got = held
        attempt(s, agent, name, got, assignment.dig("intent", "id"), assignment)
      end
    ensure
      s&.http&.close
    end

    # A fresh agent each time takes a tile that went back (whichever the colony hands it) and proposes it again.
    def reland_loop
      loop do
        return if @lock.synchronize { @landed.size == @tiles.size }

        check_run_deadline
        s = session
        name = @lock.synchronize { format("mosaic-again-%02d", @fresh += 1) }
        begin
          agent, = s.step("agent #{name} to join") { register(s, name) }
          # Relanders take turns (each tile's claim holds the others off), so a turn may come only as the run ends.
          assignment, = s.step("#{name} to be handed a tile that went back", [@run_deadline - Stage.now, 1].max) { take_any(s, agent, name) }
          next unless assignment

          intent_id = assignment.dig("intent", "id")
          tile = @lock.synchronize { @by_intent[intent_id] }
          raise Failure, "#{name} was handed #{intent_id}, an intent this run did not declare" unless tile

          attempt(s, agent, name, tile, intent_id, assignment)
        ensure
          s.http.close
        end
      end
    end

    # Propose the tile's change, wait for it to land or go back, and record which.
    def attempt(s, agent, name, tile, intent_id, assignment)
      n = @lock.synchronize { @attempts[tile] += 1 }
      raise Failure, "tile #{tile.at} went back #{MAX_ATTEMPTS} times; the last time: #{@returns.reverse.find { |r| r[:tile] == tile }&.dig(:reason)}" if n > MAX_ATTEMPTS

      files = { MOSAIC => Mosaic.fill(@seed[MOSAIC], tile) }
      files[ROLL_CALL] = @seed[ROLL_CALL] + Mosaic.roll_line(name, tile) if tile.roll_call
      write = files.map { |p, text| { path: p, blob: Stage.blob_id(text) } }
      read = files.keys.map { |p| { path: p, blob: Stage.blob_id(@seed[p]) } }
      summary = "tile #{tile.at}: #{tile.color_name}#{tile.roll_call ? '; one line added to the roll call' : ''}"
      p, secs = s.step("#{name}'s change for tile #{tile.at} to land or go back") do
        settle(s, propose_raw(s, agent, assignment, @seed_sha, write, read, files.values, summary), name)
      end
      @lock.synchronize { record(tile, intent_id, name, p, secs) }
    end

    # Keep what happened to one tile's change and narrate it. Called holding @lock.
    def record(tile, intent_id, name, p, secs)
      if p["status"] == "landed"
        @landed[tile] = { agent: name, landing: p["landingId"], proposal: p["id"] }
        again = @reopened.delete(intent_id) || name.start_with?("mosaic-again-")
        count = @landed.size
        if again
          say("#{name} landed tile #{tile.at} in #{tile.color_name}#{tile.roll_call ? ' and signed the roll call' : ''}, taken again from the colony: #{p['landingId']} (#{fmt(secs)}); #{count} of 100")
        elsif tile.roll_call
          say("#{name} laid tile #{tile.at} in #{tile.color_name} and signed the roll call: landed in #{p['landingId']} (#{fmt(secs)}); #{count} of 100")
        elsif count == 1 || (count % 10).zero?
          say("#{count} of 100 tiles landed (#{name}: tile #{tile.at} in #{tile.color_name}, #{p['landingId']}, #{fmt(secs)})")
        end
        return
      end
      raise Failure, "#{name}'s change for tile #{tile.at} was #{p['status']}#{reason_of(p)}: this beat has review off and never waits for a person" if p["status"] == "escalated"

      @returns << { tile: tile, agent: name, reason: p["reason"].to_s, status: p["status"] }
      @reopened[intent_id] = tile
      say("tile #{tile.at} went back (#{name}, #{p['status']}): #{p['reason'].to_s[0, 200]}")
    end

    def check_run_deadline
      raise Stage::StepTimeout.new("all 100 tiles to land", @timeout) if @run_deadline && Stage.now > @run_deadline
    end

    # --- the API ------------------------------------------------------------------------------------------------------

    def register(s, name)
      s.api!(:post, "/colonies/#{@colony}/agents", { name: name, kind: "synthetic", model: "scripted" })["id"]
    end

    def declare(s, agent, tile)
      intent = declare_raw(s, agent, tile.title, tile.why, tile.footprint)
      @lock.synchronize { @by_intent[intent["id"]] = tile }
      intent
    end

    def declare_raw(s, agent, title, why, footprint)
      res = s.api(:post, "/colonies/#{@colony}/intents", { title: title, why: why, footprint: footprint, assignedTo: agent, createdBy: BY, force: true })
      raise Failure, "declaring \"#{title}\": #{res.problem}" unless res.ok? && res.json
      raise Failure, "declaring \"#{title}\" answered the colony's intent #{res.json['duplicateOf']} instead of a new one" if res.json["duplicateOf"]

      res.json
    end

    # Take until the agent holds `intent_id` (a new colony's workspace pool may still be forking).
    def take(s, agent, intent_id, who)
      loop do
        t = s.api!(:post, "/colonies/#{@colony}/agents/#{agent}/take", {})
        if t["intent"]
          raise Failure, "#{who} was handed #{t.dig('intent', 'id')}, not its own intent #{intent_id}" unless t.dig("intent", "id") == intent_id

          keep_secrets(t)
          return t
        end
        s.waiting = "#{who} to be handed its intent (the colony said: #{t['reason'] || 'wait'})"
        s.pause([(t["retryInMs"] || 1000).to_f / 1000, 2].min)
      end
    end

    # Take until the agent holds an intent of this run: its own, or one the colony hands it instead; returns
    # [assignment, tile]. Nil when its own intent is no longer its own: the colony gives a held intent back when it
    # cannot lease a workspace or admit the claim (its answer says why), and that tile waits for the relanders.
    def take_own(s, agent, intent_id, who)
      loop do
        t = s.api!(:post, "/colonies/#{@colony}/agents/#{agent}/take", {})
        if t["intent"]
          got = t.dig("intent", "id")
          tile = @lock.synchronize { @by_intent[got] }
          raise Failure, "#{who} was handed #{got}, an intent this run did not declare" unless tile

          keep_secrets(t)
          return [t, tile]
        end
        held = s.api!(:get, "/colonies/#{@colony}/intents/#{intent_id}")["intent"] || {}
        unless held["status"] == "claimed" && held["assignedTo"] == agent
          tile = @lock.synchronize do
            @given_back += 1
            @by_intent[intent_id]
          end
          say("tile #{tile.at} went back to the colony before #{who} started it (the colony said: #{t['reason'] || 'wait'}); it waits for the relanders")
          return nil
        end
        s.waiting = "#{who} to be handed its intent (the colony said: #{t['reason'] || 'wait'})"
        s.pause([(t["retryInMs"] || 1000).to_f / 1000, 2].min)
      end
    end

    # Take whatever open intent the colony hands the agent; nil once every tile has landed. While it waits, a tile that
    # went back and landed another way (the colony's conflict resolver, FT_RESOLVER, keeps its intent) is counted.
    def take_any(s, agent, who)
      checked = Stage.now
      loop do
        return nil if @lock.synchronize { @landed.size == @tiles.size }

        if Stage.now - checked > 5
          landed_elsewhere(s)
          checked = Stage.now
          next
        end

        t = s.api!(:post, "/colonies/#{@colony}/agents/#{agent}/take", {})
        if t["intent"]
          keep_secrets(t)
          return t
        end
        s.waiting = "#{who} to be handed a tile that went back (the colony said: #{t['reason'] || 'wait'})"
        s.pause([(t["retryInMs"] || 1000).to_f / 1000, 2].min)
      end
    end

    # Tiles that went back and whose intents landed since without this run (GET /intents/:iid).
    def landed_elsewhere(s)
      @lock.synchronize { @by_intent.reject { |_, t| @landed.key?(t) } }.each do |intent_id, tile|
        status = s.api!(:get, "/colonies/#{@colony}/intents/#{intent_id}").dig("intent", "status")
        next unless status == "landed"

        @lock.synchronize do
          @landed[tile] ||= { agent: "the colony", landing: nil, proposal: nil }
          @reopened.delete(intent_id)
        end
        say("tile #{tile.at} landed without this run: its intent #{intent_id} landed in the colony")
      end
    end

    def keep_secrets(t)
      @lock.synchronize do
        [t.dig("lease", "token"), t.dig("lease", "trunk", "token")].each { |x| @secrets << x if x.is_a?(String) && !@secrets.include?(x) }
      end
    end

    # Propose `texts` (in write-set order) as an inline change on `base` for the agent's assignment.
    def propose_raw(s, agent, assignment, base, write, read, texts, summary)
      body = {
        intentId: assignment.dig("intent", "id"), agentId: agent, workspace: assignment.dig("lease", "repo"), baseSha: base,
        headSha: Stage.changeset_id(base, write), writeSet: write, readSet: read,
        contents: write.zip(texts).to_h { |w, text| [w[:blob], text] }, intentRevision: assignment.dig("intent", "revision") || 1,
        declared: { footprint: write.map { |w| w[:path] }, summary: summary },
        evidence: { checks: [], notVerified: "A scripted tile of the mosaic beat: no tests were run." }
      }
      s.api!(:post, "/colonies/#{@colony}/proposals", body)
    end

    # Poll a proposal until it lands, goes back, is rejected or waits for a person.
    def settle(s, proposal, who)
      loop do
        p = s.api!(:get, "/colonies/#{@colony}/proposals/#{proposal['id']}")
        return p if SETTLED.include?(p["status"])

        s.waiting = "#{who}'s change #{proposal['id']} to land or go back (it is #{p['status']})"
        s.pause(POLL_S)
      end
    end

    # The trunk commit a landing made, from the lineage of mosaic.json (else the colony's head, right after it).
    def landing_commit(landing_id)
      sha = lineage(MOSAIC).map { |e| e["landing"] || {} }.find { |l| l["id"] == landing_id }&.dig("trunkSha")
      sha ||= @main.step("the colony's head") { @main.api!(:get, "/colonies/#{@colony}") }.first.dig("colony", "trunkSha")
      raise Failure, "no trunk commit is known for the seed's landing #{landing_id}" unless sha.to_s.match?(/\A[0-9a-f]{40}\z/)

      sha
    end

    # The landings that changed `path`, newest first, each with its lineage note (GET /why).
    def lineage(path)
      @main.step("the lineage of #{path}") { Array(@main.api!(:get, "/colonies/#{@colony}/why?path=#{URI.encode_www_form_component(path)}")) }.first
    end

    # --- the checks ---------------------------------------------------------------------------------------------------

    # Both files read back through the preview route at the newest landing that changed each.
    def read_back
      [MOSAIC, ROLL_CALL].map do |path|
        commit = lineage(path).first&.dig("landing", "trunkSha")
        raise Failure, "the lineage of #{path} names no landing" unless commit

        res, = @main.step("the preview of #{path} at #{short(commit)}") { @main.api(:get, "/colonies/#{@colony}/preview/#{commit}/#{path}", auth: false) }
        raise Failure, "reading #{path} at #{short(commit)} through the preview route: #{res.problem}" unless res.ok?

        text = res.body.to_s.dup.force_encoding(Encoding::UTF_8)
        path == MOSAIC ? picture_check(text, commit, "read through the preview route") : roll_check(text, commit)
      end
    end

    # mosaic.json's last blob, from the lineage, against the picture filled in; roll-call.md's size against its lines.
    def check_by_lineage
      expected = @tiles.reduce(@seed[MOSAIC]) { |text, t| Mosaic.fill(text, t) }
      entry = lineage(MOSAIC).first || {}
      blob = Array(entry.dig("note", "proposals")).flat_map { |p| Array(p["writeSet"]) }.reverse.find { |w| w["path"] == MOSAIC }&.dig("blob")
      commit = entry.dig("landing", "trunkSha")
      picture = picture_check(blob == Stage.blob_id(expected) ? expected : nil, commit, "checked by the blob its last landing wrote")
      picture[:problems] = ["#{MOSAIC}'s last landing wrote blob #{short(blob)}, not the picture filled in (#{short(Stage.blob_id(expected))})"] if blob != Stage.blob_id(expected)
      lines = @tiles.select(&:roll_call).filter_map { |t| @landed[t] && Mosaic.roll_line(@landed[t][:agent], t) }
      want = @seed[ROLL_CALL].bytesize + lines.sum(&:bytesize)
      snap, = @main.step("the colony's files") { @main.api!(:get, "/colonies/#{@colony}") }
      size = Array(snap["files"]).find { |f| f["path"] == ROLL_CALL }&.dig("size")
      problems = size == want ? [] : ["#{ROLL_CALL} is #{size.inspect} bytes on trunk, not the #{want} its seed and #{lines.size} names make"]
      [picture, { names: problems.empty? ? lines.size : 0, lines: lines.map(&:chomp), commit: nil, how: "checked by its size on trunk", problems: problems }]
    end

    def picture_check(text, commit, how)
      grid = text && Mosaic.grid(text)
      return { grid: {}, commit: commit, how: how, filled: 0, problems: ["#{MOSAIC} at #{short(commit)} is not the grid"] } unless grid

      wrong = @tiles.reject { |t| grid[[t.r, t.c]] == t.color.downcase }
      filled = @tiles.size - wrong.size
      problems = wrong.empty? ? [] : ["#{filled} of 100 tiles filled with the picture's colors; not: #{wrong.first(5).map { |t| "#{t.at} (#{grid[[t.r, t.c]] || 'empty'})" }.join(', ')}"]
      { grid: grid, commit: commit, how: how, filled: filled, problems: problems }
    end

    def roll_check(text, commit)
      lines = text.lines.map(&:chomp)
      problems = []
      names = @tiles.select(&:roll_call).count do |t|
        signed = lines.count { |l| l.end_with?("laid tile #{t.at} in #{t.color_name}") && l.start_with?("- mosaic-") }
        problems << "the roll call names tile #{t.at} #{signed} times" if signed > 1
        problems << "the roll call does not name tile #{t.at}" if signed.zero?
        signed == 1
      end
      { names: names, lines: lines.select { |l| l.start_with?("- ") }, commit: commit, how: "read through the preview route", problems: problems }
    end

    # --- output -------------------------------------------------------------------------------------------------------

    def show_picture(picture)
      letters = PALETTE.to_h { |k, (_, hex)| [hex.downcase, k] }
      @clock.print
      @clock.print("#{MOSAIC} at #{short(picture[:commit])}, #{picture[:how]}: #{picture[:filled]} of 100 tiles filled")
      @clock.print("      #{(0...COLS).map(&:to_s).join(' ')}")
      ROWS.times do |r|
        @clock.print(format("  %2d  %s", r, (0...COLS).map { |c| letters.fetch(picture[:grid][[r, c]], ".") }.join(" ")))
      end
      @clock.print("  #{PALETTE.map { |k, (name, hex)| "#{k} #{name} #{hex}" }.join(', ')}; . empty")
    end

    def show_roll_call(roll)
      @clock.print
      @clock.print("#{ROLL_CALL}#{roll[:commit] ? " at #{short(roll[:commit])}" : ''}, #{roll[:how]}: #{roll[:names]} of 10 names")
      roll[:lines].each { |l| @clock.print("  #{l}") }
      @clock.print
    end

    def say(line)
      @say.synchronize { @clock.say(line) }
    end

    def reason_of(p) = p["reason"] ? ": #{p['reason']}" : ""

    def short(sha) = Mosaic.short(sha)

    def fmt(secs) = format("%.1f s", secs)
  end

  # Parse the command line and run the beat; returns the exit code.
  def self.main(argv)
    opts = { agents: 20, keep: false, name: nil, record: false, record_out: nil, step_timeout: 90.0, timeout: 600.0, base: nil }
    OptionParser.new do |o|
      o.banner = "Usage: FT_TOKEN=... ruby scripts/mosaic.rb --base <url> [options]"
      o.on("--base URL", "The deployment, e.g. https://staging.firetrident.com") { |v| opts[:base] = v }
      o.on("--agents N", Integer, "Agents laying tiles at once (default 20, 1 to #{MAX_AGENTS})") { |v| opts[:agents] = v }
      o.on("--name NAME", "Name of the new colony (default mosaic-<time>); --record needs one FT_PUBLIC_GIT lists") { |v| opts[:name] = v }
      o.on("--keep", "Keep the colony (default: delete it at the end)") { opts[:keep] = true }
      o.on("--record", "Record the colony into packages/web/public/recordings/#{RECORDING}.json.gz before deleting it") { opts[:record] = true }
      o.on("--record-out FILE", "Record to FILE instead (implies --record)") do |v|
        opts[:record] = true
        opts[:record_out] = File.expand_path(v)
      end
      o.on("--step-timeout S", Float, "Hard time limit of each step, in seconds (default 90)") { |v| opts[:step_timeout] = v }
      o.on("--timeout S", Float, "Hard time limit for all 100 tiles to land, in seconds (default 600)") { |v| opts[:timeout] = v }
    end.parse!(argv)
    base = Stage.base_url(opts[:base])
    token = Stage.token(base)
    raise Stage::ConfigError, "FT_TOKEN is not set (the deployment's admin token: set it, or put it in ~/.config/firetrident/env with that deployment's FT_URL)" unless token
    raise Stage::ConfigError, "--agents must be from 1 to #{MAX_AGENTS}" unless opts[:agents].between?(1, MAX_AGENTS)

    access = Stage.access_headers
    secrets = [token, *access.values]
    clock = Stage::Clock.new(secrets: secrets)
    connect = -> { Stage::Http.new(base, token: token, access: access) }
    Run.new(http: connect.call, connect: connect, clock: clock, secrets: secrets, base: base, access: access, agents: opts[:agents], keep: opts[:keep], name: opts[:name],
            record: opts[:record], record_out: opts[:record_out], step_timeout: opts[:step_timeout], timeout: opts[:timeout]).call
  rescue Stage::ConfigError, OptionParser::ParseError => e
    warn("mosaic: #{e.message}")
    Stage::EXIT_USAGE
  end
end

exit(Mosaic.main(ARGV)) if $PROGRAM_NAME == __FILE__
