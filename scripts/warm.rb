#!/usr/bin/env ruby
# frozen_string_literal: true

# Before going on stage: open everything the demo opens, once, so no first request on stage is cold; then again, to show
# the warm times. Read only, and no token is sent. Each read prints its HTTP status and time; the second pass shows the
# first pass's time beside its own.
#
#   the deployment  /, /api/about, /api/colonies (the front page's list), /.well-known/firetrident-keys.json (the key
#                   that signs lineage notes), and the public MCP's initialize and tool list (through the MCP SDK's
#                   client, scripts/mcp_ask.ts)
#   each colony     /c/<colony> and /c/<colony>?replay=1, the reads the replay page makes first (its snapshot, its
#                   agents and the first page of its event record), its metrics, its recording
#                   /recordings/<colony>.json.gz ("none" when there is none), and the why of one file (the newest
#                   landing's first file, or the one --why names)
#
# Usage:
#   ruby scripts/warm.rb --base https://staging.firetrident.com [--colonies hono,shortlinks] [--why hono=src/index.ts]
#     [--passes 2] [--timeout 30]
#
# Behind Cloudflare Access, set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET; they go with every request and are never
# printed. Each read has a hard time limit (--timeout). Exit codes: 0 every read answered, 1 one did not (the list says
# which), 2 a setting is missing.
require "optparse"
require_relative "stage"

module Warm
  # One read: what it is called in the listing, and how it is made.
  Read = Struct.new(:label, :path, :kind, :colony)

  # One warm-up against one deployment.
  class Run
    def initialize(http:, clock:, colonies:, why:, passes:, timeout:, access:)
      @http = http
      @clock = clock
      @colonies = colonies
      @why = why.dup
      @passes = passes
      @timeout = timeout.to_f
      @access = access
      @seen = {}
      @failed = []
    end

    # Every pass, then the verdict; returns the exit code.
    def call
      @clock.print("warming #{@http.base}: #{@colonies.join(', ')}, #{@passes} pass#{@passes == 1 ? '' : 'es'}")
      times = (1..@passes).map do |n|
        @clock.print
        @clock.print("pass #{n}#{n == 1 ? ' (cold)' : ''}")
        t = Stage.now
        reads.each { |r| show(n, r) }
        Stage.now - t
      end
      @clock.print
      @clock.print("passes took #{times.map { |t| format('%.1f s', t) }.join(', then ')}")
      if @failed.empty?
        @clock.print("PASS warm: every read answered")
        Stage::EXIT_PASS
      else
        @clock.print("FAIL warm: #{@failed.uniq.size} read#{@failed.uniq.size == 1 ? '' : 's'} did not answer: #{@failed.uniq.join(', ')}")
        Stage::EXIT_FAIL
      end
    end

    private

    def reads
      list = [Read.new("/", "/", :page), Read.new("/api/about", "/api/about", :json), Read.new("/api/colonies", "/api/colonies", :json),
              Read.new("/.well-known/firetrident-keys.json", "/.well-known/firetrident-keys.json", :json), Read.new("/public/mcp", nil, :mcp)]
      @colonies.each do |c|
        api = "/api/colonies/#{c}"
        list += [Read.new("/c/#{c}", "/c/#{c}", :page), Read.new("/c/#{c}?replay=1", "/c/#{c}?replay=1", :page),
                 Read.new(api, api, :snapshot, c), Read.new("#{api}/agents?all=1&journal=0&limit=10000", nil, :json),
                 Read.new("#{api}/events?after=0&limit=5000", nil, :json), Read.new("#{api}/metrics", nil, :json),
                 Read.new("/recordings/#{c}.json.gz", nil, :recording), Read.new("#{api}/why", nil, :why, c)]
      end
      list
    end

    # Make one read in pass `n` and print it (pass 2 on shows pass 1's time beside its own).
    def show(n, read)
      return mcp(n) if read.kind == :mcp

      label, path = read.label, read.path || read.label
      if read.kind == :why
        file = @why[read.colony]
        return line(n, "skip", nil, "#{label}: no landing to ask about (pass --why #{read.colony}=<path>)") unless file

        path = "#{label}?path=#{URI.encode_www_form_component(file)}"
        label = path
      end
      accept = { page: "text/html", recording: "*/*" }.fetch(read.kind, "application/json")
      res = @http.get(path, headers: { "Accept" => accept }, timeout: @timeout, auth: false)
      status = if read.kind == :recording && (res.code == 404 || (res.ok? && res.content_type.include?("text/html"))) then "none"
               elsif res.ok? then res.code.to_s
               else
                 @failed << label
                 res.code.zero? ? "fail" : res.code.to_s
               end
      remember_why(read.colony, res) if read.kind == :snapshot && res.ok?
      line(n, status, res.ms, "#{label}#{res.ok? || status == 'none' ? '' : " (#{res.problem})"}", key: label)
    end

    # The public MCP: one client session per pass, its initialize and its tool list timed apart.
    def mcp(n)
      a = Stage.mcp_ask(@http.base, timeout: @timeout, access: @access)
      init = a.dig("ms", "initialize")
      list = a.dig("ms", "listTools")
      @failed << "/public/mcp" unless a["ok"]
      line(n, init ? "ok" : "fail", init, "/public/mcp initialize#{init ? '' : " (#{a['error']})"}", key: "/public/mcp initialize")
      return unless init

      line(n, list ? "ok" : "fail", list, "/public/mcp tools/list#{list ? " (#{Array(a['tools']).size} tools)" : " (#{a['error']})"}", key: "/public/mcp tools/list")
    end

    def line(n, status, ms, label, key: label)
      was = @seen[key]
      @seen[key] ||= ms
      tail = n > 1 && was ? "   (pass 1: #{was} ms)" : ""
      @clock.print(format("  %-4s %8s  %s%s", status, ms ? "#{ms} ms" : "-", label, tail))
    end

    # The file the colony's newest landing changed first, for its why read (unless --why named one).
    def remember_why(colony, res)
      return if @why[colony] || !res.json.is_a?(Hash)

      landing = Array(res.json["recentLandings"]).select { |l| l.is_a?(Hash) && Array(l["paths"]).any? }.max_by { |l| l["at"].to_f }
      @why[colony] = Array(landing&.dig("paths")).first
    end
  end

  # Parse the command line and warm the deployment; returns the exit code.
  def self.main(argv)
    opts = { base: nil, colonies: ["hono"], why: {}, passes: 2, timeout: 30.0 }
    OptionParser.new do |o|
      o.banner = "Usage: ruby scripts/warm.rb --base <url> [options]"
      o.on("--base URL", "The deployment, e.g. https://staging.firetrident.com") { |v| opts[:base] = v }
      o.on("--colonies LIST", "Showcase colonies, comma-separated (default hono)") { |v| opts[:colonies] = v.split(",").map(&:strip).reject(&:empty?) }
      o.on("--why COLONY=PATH", "The file whose why is read for a colony (default: its newest landing's first file); repeatable") do |v|
        colony, path = v.split("=", 2)
        raise OptionParser::InvalidArgument, "--why takes <colony>=<path>" if colony.to_s.empty? || path.to_s.empty?

        opts[:why][colony] = path
      end
      o.on("--passes N", Integer, "How many times to read everything (default 2)") { |v| opts[:passes] = v }
      o.on("--timeout S", Float, "Hard time limit of each read, in seconds (default 30)") { |v| opts[:timeout] = v }
    end.parse!(argv)
    base = Stage.base_url(opts[:base])
    raise Stage::ConfigError, "--passes must be at least 1" unless opts[:passes].positive?
    raise Stage::ConfigError, "--colonies needs at least one colony id" if opts[:colonies].empty?

    bad = opts[:colonies].reject { |c| c.match?(/\A[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?\z/) }
    raise Stage::ConfigError, "not colony ids: #{bad.join(', ')}" unless bad.empty?

    access = Stage.access_headers
    clock = Stage::Clock.new(secrets: access.values)
    Run.new(http: Stage::Http.new(base, access: access), clock: clock, colonies: opts[:colonies], why: opts[:why],
            passes: opts[:passes], timeout: opts[:timeout], access: access).call
  rescue Stage::ConfigError, OptionParser::ParseError => e
    warn("warm: #{e.message}")
    Stage::EXIT_USAGE
  end
end

exit(Warm.main(ARGV)) if $PROGRAM_NAME == __FILE__
