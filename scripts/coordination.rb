#!/usr/bin/env ruby
# frozen_string_literal: true

# How well a colony's agents coordinated, computed only from what the colony publishes: its trunk read with stock
# git (commits, FT-* trailers and the lineage notes under refs/notes/firetrident) and its public read API (GET
# routes that need no token). Anyone can run it against a deployment and get the same numbers.
#
# Usage:
#   ruby scripts/coordination.rb --url https://<host> --colony <id> [--clone DIR] [--json FILE]
#
#   --url URL     the deployment. Git comes from <url>/git/<colony>.git, which serves only the colonies FT_PUBLIC_GIT
#                 lists; the record comes from <url>/api/colonies/<colony>/...
#   --colony ID   the colony.
#   --clone DIR   read this clone instead of cloning. Its notes are fetched from <url>/git/<colony>.git, else from its
#                 origin, else used as they are. A DIR that does not exist yet is cloned into and kept.
#   --json FILE   write every number as JSON. Stdout gets a short markdown table; progress goes to stderr.
#   FT_TOKEN      optional, sent as a bearer token on API reads (every route used here is public).
# It sends only GET requests and runs only git clone and fetch: nothing is written to the deployment. Without --url
# (given an existing --clone), the numbers that need the record are reported as not computed, with the reason.
#
# Where the numbers come from
#   GET /api/colonies/<id>                  region depth, trunk head, and the colony's own counters (a cross-check)
#   GET /api/colonies/<id>/events           the event record, every page: each proposal's status changes with their
#                                           times and reasons, each intent's, landings, and people's decisions
#   GET /api/colonies/<id>/agents?all=1     every agent's kind and model; the vaccine agent (name and model "vaccine")
#   GET /api/colonies/<id>/proposals/<pid>  the write sets the notes do not hold (every proposal that did not land)
#   git log --first-parent HEAD             FireTrident commits: from the first commit that carries this colony's note
#                                           or an FT-Landing trailer the record knows, every commit with a note or an
#                                           FT-Landing trailer. A commit's lineage note lists the proposals it landed
#                                           (id, agent, intent, write set); a note with `system` (an antibody) or
#                                           `revert` makes a system commit, which lands no proposal. A commit with no
#                                           note is read from its FT-Proposal trailers and the API's copy of each
#                                           proposal, which counts only when the API says it landed in that landing.
#   git blame, log --numstat, --name-status the lines and files below.
#
# Definitions (vaccine proposals and their intents are left out of every number)
#
# 1. Merged fraction. A proposal's status is the status of its last event in the record. Made: every proposal in the
#    record. Landed: status landed. Returned: status returned, except returns for a change of direction, whose reason
#    starts "withdrawn: ", "intent revised: " or "superseded: " (a person withdrew or amended the intent, or a contest
#    picked another change): the colony counts those as redirected, and so does this report. Rejected. In flight:
#    pending, checking, ready, or escalated to a person. Merged fraction = landed / made, so a proposal still in
#    flight counts as not merged; also landed / settled, where settled = made - in flight. Intents: every intent in
#    the record; an intent's status is that of its last intent event (landed when it has none and one of its
#    proposals landed). Intents merged = landed intents / intents; also over the intents that had a proposal.
#
# 2. Code sharing. The files: every text file at HEAD that a landed proposal wrote (and every path a landing commit
#    changed when not all of its proposals are known). Each of their lines at HEAD goes to the commit
#    `git blame --porcelain HEAD -- <path>` names (no move or copy detection), then to that commit's lineage note, the
#    proposal in it whose write set holds the path, and that proposal's agent. Lines from commits that are not
#    FireTrident commits (imported history, an empty trunk's first commit) and from system commits are not
#    agent-written. When several proposals of one commit wrote the path, the commit's version is rebuilt step by step
#    from the parent's version and each proposal's blob for the path, in note order (every blob must be in the clone,
#    which holds only blobs some commit reaches, and the last must be the commit's), and a line goes to the proposal
#    whose step added it. A line of a landing commit that no single proposal can be given (none of its known proposals
#    wrote the path, or the steps cannot be rebuilt) and a line a shallow clone's boundary commit holds are
#    unattributed: counted, never given to an agent.
#    For agent a and file f: own = a's lines, others = the lines of every other agent, and D is one of two
#    denominators, reported side by side: the whole file (every line of f at HEAD) or agent-written lines only (the
#    lines given to any agent). share(a, f) = others / D; weight(a, f) = own / D; score(a) = sum(weight * share) /
#    sum(weight) over the files where own > 0. Reported: every agent's score, the median over the agents with lines
#    (the mean of the two middle scores for an even count), quartiles by linear interpolation, a histogram in 0.1 steps.
#
# 3. Specialization. A landed proposal's region is the region holding most of its write set's paths, ties to the first
#    in write-set order (as the colony picks a proposal's lane). A path's region is its first <depth> directories ("."
#    for a root file) at the colony's region depth, or at depth 2 (its first two directories) when the API gives none.
#    For each agent with at least 3 landed proposals: top share = its landings in its most frequent region / its
#    landings. Observed = the median top share. Baseline: the region labels of all landed proposals, in landing order,
#    are shuffled 1,000 times (each position keeps its agent, so every agent keeps its count; Fisher-Yates driven by
#    SplitMix64 seeded 20261014, j = next % (i + 1)), the median top share is taken each time, and the baseline is the
#    median of those medians. Difference = observed - baseline; p = (1 + shuffles whose median >= observed) / 1,001.
#
# 4. Conflicts over time. Returns (as in 1: redirects apart), each at the time of its last returned event, in minute
#    floor((t - t0) / 60 s), where t0 is the record's first proposal event. Classes, from the reason text, first match
#    wins: text merge (it names "text merge of <path>: N conflicting hunk(s)"); stale (it starts "stale:" or
#    "conflicts with ": a file it read, wrote or imports from changed, or another change of the same cycle took it);
#    rule (a review return, below, that names a "violation of rule"); review (it starts "deterministic: ", "reflex: ",
#    "llm: " or "returned for review: ", as the review arc writes them, or a person returned it, known by a `decision`
#    event of layer human and action return); other (anything else: the deletion guard, platform failures, a person's
#    words without a decision event). Reported: the cumulative returns of each class at the end of every minute, from
#    minute 0 to the minute of the record's last proposal event.
#
# 5. Hottest file. A return names the known paths its reason mentions (a known path is on trunk, changed by a
#    FireTrident commit, or in a read or write set this report holds); a return whose reason names none names its write
#    set. The hottest file is the path the most returns name (ties to the first in path order; the tied paths are
#    listed). With it: the distinct agents with a proposal of any status whose write set holds it, and its size in lines
#    before the first FireTrident commit and at each FireTrident commit that changed it (0 when deleted).
#
# 6. Sprawl. Distinct top-level directories (the first segment of every path inside a directory) and distinct regions
#    (as in 3) in the trunk tree before the first FireTrident commit and after each one.
#
# 7. Lines per landed intent. Lines added minus lines removed by the commits that landed proposals (system commits
#    apart; `git log --numstat`, binary files left out), divided by the distinct intents those proposals carry. With
#    it: the lines at HEAD of the files of 2, and how many of them are agent-written (given to an agent, or
#    unattributed).
require "fileutils"
require "json"
require "net/http"
require "open3"
require "openssl"
require "optparse"
require "set"
require "tmpdir"
require "uri"

# The report and its parts. The command line is `Coordination.main`, so tests load this file and call the parts.
module Coordination
  NOTES_REF = "refs/notes/firetrident"
  SEED = 20_261_014
  SHUFFLES = 1_000
  MIN_LANDINGS = 3
  DEFAULT_DEPTH = 2
  CLASSES = %w[stale text_merge review rule other].freeze
  REDIRECT = /\A(?:withdrawn|intent revised|superseded): /
  REVIEW = /\A(?:(?:deterministic|reflex|llm): |returned for review: )/
  RULE = /\bviolations? of rule /
  TEXT_MERGE = /\btext merge of \S.*?: \d+ conflicting hunks?\b/
  STALE = /\A(?:stale:|conflicts with )/
  IN_FLIGHT = %w[pending checking ready escalated].freeze
  EVENTS_PAGE = 5_000
  FETCH_CAP = 10_000
  THREADS = 8

  module_function

  # A path's region: its first `depth` directories, "." for a root file (core/ids.ts regionOf).
  def region_of(path, depth)
    segments = path.split("/").reject { |s| s.empty? || s == "." }
    dirs = path.end_with?("/") ? segments : segments[0...-1]
    kept = []
    dirs.each do |dir|
      break if kept.size >= depth || dir.match?(/[*?{]/)

      kept << dir
    end
    kept.empty? ? "." : kept.join("/")
  end

  # The region holding most of these paths, ties to the first seen; "." when there are none (colony/logic.ts primaryRegion).
  def primary_region(paths, depth)
    counts = {}
    paths.uniq.each do |path|
      region = region_of(path, depth)
      counts[region] = counts.fetch(region, 0) + 1
    end
    best = "."
    best_count = 0
    counts.each do |region, n|
      next unless n > best_count

      best = region
      best_count = n
    end
    best
  end

  # The first segment of a path inside a directory; nil for a root file.
  def top_dir(path) = path.include?("/") ? path.split("/", 2).first : nil

  def median(values)
    return nil if values.empty?

    s = values.sort
    m = s.size / 2
    s.size.odd? ? s[m] : (s[m - 1] + s[m]) / 2.0
  end

  # The q quantile of sorted values, by linear interpolation between the closest ranks.
  def quantile(sorted, q)
    return nil if sorted.empty?

    pos = (sorted.size - 1) * q
    lo = pos.floor
    hi = pos.ceil
    sorted[lo] + ((sorted[hi] - sorted[lo]) * (pos - lo))
  end

  def ratio(num, den) = den.to_f.positive? ? num.to_f / den : nil

  def rounded(x, digits = 4) = x.nil? ? nil : x.round(digits)

  def redirect?(reason) = REDIRECT.match?(reason.to_s)

  # The class of a return from its reason text (definition 4); `human` when a person's decision returned it.
  def classify(reason, human: false)
    text = reason.to_s
    return "text_merge" if TEXT_MERGE.match?(text)
    return "stale" if STALE.match?(text)

    review = REVIEW.match?(text)
    return "rule" if review && RULE.match?(text)
    return "review" if review || human

    "other"
  end

  # The known paths a reason mentions, in the order it mentions them, each once.
  def reason_paths(reason, known)
    out = []
    reason.to_s.scan(/[^\s,;()"'`]+/) do |token|
      path = token.sub(/[:.]+\z/, "")
      out << path if known.include?(path) && !out.include?(path)
    end
    out
  end

  # Lines as git counts them: a last line without a newline still counts.
  def line_count(text)
    return 0 if text.nil? || text.empty?

    text.count("\n") + (text.end_with?("\n") ? 0 : 1)
  end

  # Git's own test for binary content: a NUL byte in the first 8,000 bytes.
  def binary?(text) = text.byteslice(0, 8_000).include?("\0")

  def utf8(bytes) = bytes.to_s.dup.force_encoding(Encoding::UTF_8).scrub

  # Artifacts tokens and credentials in URLs never reach the output.
  def redact(text) = text.to_s.gsub(/art_v\d+_[A-Za-z0-9._~+\/=-]+/, "<redacted>").gsub(%r{(://)[^/@\s]+@}, '\1<redacted>@')

  # `items` mapped on up to `threads` threads; the results keep the input order, and an error in a block is raised.
  def pmap(items, threads: THREADS)
    return [] if items.empty?

    queue = Queue.new
    items.each_with_index { |item, i| queue << [item, i] }
    queue.close
    out = Array.new(items.size)
    workers = Array.new([threads, items.size].min) do
      Thread.new do
        Thread.current.report_on_exception = false
        while (job = queue.pop)
          out[job[1]] = yield(job[0])
        end
      end
    end
    workers.each(&:join)
    out
  end

  # SplitMix64: a small, fully specified generator, so the shuffles come out the same in any language that redoes them.
  class SplitMix64
    MASK = (1 << 64) - 1

    def initialize(seed)
      @state = seed & MASK
    end

    def next_u64
      @state = (@state + 0x9E3779B97F4A7C15) & MASK
      z = @state
      z = ((z ^ (z >> 30)) * 0xBF58476D1CE4E5B9) & MASK
      z = ((z ^ (z >> 27)) * 0x94D049BB133111EB) & MASK
      z ^ (z >> 31)
    end

    # Fisher-Yates in place, from the last position down: j = next % (i + 1).
    def shuffle!(array)
      (array.size - 1).downto(1) do |i|
        j = next_u64 % (i + 1)
        array[i], array[j] = array[j], array[i]
      end
      array
    end
  end

  class GitError < StandardError; end

  # Plain git on one clone. It never prompts for credentials (a refused fetch fails at once) and uses no helper.
  class Git
    ENV_VARS = { "GIT_TERMINAL_PROMPT" => "0", "GCM_INTERACTIVE" => "never" }.freeze
    CONFIG = ["-c", "credential.helper=", "-c", "core.quotePath=false", "-c", "protocol.version=2",
              "-c", "http.lowSpeedLimit=1000", "-c", "http.lowSpeedTime=60"].freeze
    TRAILERS = %w[FT-Landing FT-Proposal FT-Intent FT-Agent].freeze

    attr_reader :dir

    def initialize(dir)
      @dir = dir
    end

    # Run git with `args` (in `dir` when given): stdout as bytes, or GitError on an exit status outside `ok`.
    def self.run(args, dir: nil, input: nil, ok: [0])
      opts = { stdin_data: input.to_s, binmode: true }
      opts[:chdir] = dir if dir
      out, err, status = Open3.capture3(ENV_VARS, "git", *CONFIG, *args, **opts)
      return out if ok.include?(status.exitstatus)

      raise GitError, "git #{args.first} failed: #{Coordination.redact(Coordination.utf8(err)).strip[0, 300]}"
    end

    def run(*args, input: nil, ok: [0]) = Git.run(args, dir: @dir, input: input, ok: ok)

    def text(*args, **kw) = Coordination.utf8(run(*args, **kw))

    def head = text("rev-parse", "--verify", "HEAD^{commit}").strip

    # Whether the clone holds an object (a commit a shallow clone cut off is not there).
    def has?(object)
      _out, _err, status = Open3.capture3(ENV_VARS, "git", *CONFIG, "cat-file", "-e", object, chdir: @dir)
      status.success?
    end

    # Commits whose parents a shallow clone lacks.
    def shallow
      file = text("rev-parse", "--git-path", "shallow").strip
      file = File.join(@dir, file) unless file.start_with?("/")
      File.exist?(file) ? File.readlines(file, chomp: true).reject(&:empty?).to_set : Set.new
    end

    # The blob id of `path` at `rev`, or nil when the path is not there.
    def blob_id(rev, path)
      out = text("rev-parse", "--verify", "--quiet", "#{rev}:#{path}", ok: [0, 1, 128]).strip
      out.match?(/\A\h{40,64}\z/) ? out : nil
    end

    # First-parent history of `rev`, oldest first, with the FT-* trailers each commit carries.
    def first_parent(rev = "HEAD")
      format = ["%H", "%P", "%ct", *TRAILERS.map { |k| "%(trailers:key=#{k},valueonly,separator=%x1d)" }].join("%x1f")
      list = ->(s) { s.split("\x1d").map(&:strip).reject(&:empty?) }
      text("log", "--first-parent", "--format=#{format}%x1e", rev).split("\x1e").filter_map do |record|
        fields = record.sub(/\A\n/, "").split("\x1f", -1)
        next if fields.size < 3 + TRAILERS.size

        sha, parents, at, landing, proposals, intents, agents = fields
        { sha: sha, parent: parents.split(" ").first, at: at.to_i * 1000, landing: list.(landing).first,
          proposals: list.(proposals), intents: list.(intents), agents: list.(agents) }
      end.reverse
    end

    # Every note under refs/notes/firetrident: commit => note text.
    def notes
      pairs = text("notes", "--ref=#{NOTES_REF}", "list", ok: [0, 1]).lines.filter_map do |line|
        blob, commit = line.split
        [commit, blob] if commit
      end
      texts = cat(pairs.map(&:last))
      pairs.to_h { |commit, blob| [commit, texts[blob]] }.compact
    end

    # Object contents by name (an id, or "<rev>:<path>"), read in one `cat-file --batch`; nil for a missing object.
    def cat(names)
      names = names.uniq
      return {} if names.empty?

      out = run("cat-file", "--batch", input: "#{names.join("\n")}\n")
      result = {}
      pos = 0
      names.each do |name|
        eol = out.index("\n", pos) or break
        header = out.byteslice(pos, eol - pos)
        pos = eol + 1
        if (m = /\A\h+ \w+ (\d+)\z/.match(header))
          size = m[1].to_i
          result[name] = out.byteslice(pos, size)
          pos += size + 1
        else
          result[name] = nil
        end
      end
      result
    end

    # Every path in the tree of `rev` ([] for nil).
    def tree_paths(rev)
      return [] if rev.nil?

      text("ls-tree", "-r", "-z", "--name-only", rev).split("\0").reject(&:empty?)
    end

    # What each first-parent commit in `range` changed against its first parent: sha => [[status, path], ...].
    def name_status(range)
      out = {}
      text("log", "--first-parent", "--no-renames", "--name-status", "-z", "--format=%x01%H", range).split("\x01").each do |chunk|
        sha, rest = chunk.split("\0", 2)
        next if sha.nil? || sha.empty?

        tokens = rest.to_s.sub(/\A\n/, "").split("\0").reject(&:empty?)
        out[sha] = tokens.each_slice(2).filter_map { |status, path| [status[0], path] if path }
      end
      out
    end

    # Lines each first-parent commit in `range` added and removed in text files, and its binary files.
    def numstat(range)
      out = {}
      current = nil
      text("log", "--first-parent", "--no-renames", "--numstat", "--format=%x01%H", range).each_line(chomp: true) do |line|
        if line.start_with?("\x01")
          current = out[line[1..]] = { added: 0, removed: 0, binary: 0 }
        elsif current && (m = /\A(\d+|-)\t(\d+|-)\t/.match(line))
          if m[1] == "-"
            current[:binary] += 1
          else
            current[:added] += m[1].to_i
            current[:removed] += m[2].to_i
          end
        end
      end
      out
    end

    # Every line of `path` at `rev`: [commit, line number in that commit's version], and the boundary commits.
    def blame(rev, path)
      lines = []
      boundary = Set.new
      current = nil
      text("blame", "--porcelain", rev, "--", path).each_line(chomp: true) do |line|
        if (m = /\A(\h{40,64}) (\d+) \d+(?: \d+)?\z/.match(line))
          current = m[1]
          lines << [current, m[2].to_i]
        elsif line == "boundary"
          boundary << current
        end
      end
      { lines: lines, boundary: boundary }
    end

    # For each line of `new_text` (index i is line i + 1), the 1-based line of `old_text` it continues, or nil for a
    # line the change added; read from `git diff --no-index -U0`.
    def self.line_map(old_text, new_text)
      Dir.mktmpdir("ft-coordination-diff") do |tmp|
        a = File.join(tmp, "a")
        b = File.join(tmp, "b")
        File.binwrite(a, old_text)
        File.binwrite(b, new_text)
        out = Coordination.utf8(run(["diff", "--no-index", "--no-color", "--no-ext-diff", "-U0", a, b], ok: [0, 1]))
        map = []
        old_i = 1
        new_i = 1
        out.each_line do |l|
          m = /\A@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.match(l) or next
          removed = (m[1] || "1").to_i
          added = (m[3] || "1").to_i
          first_new = added.zero? ? m[2].to_i + 1 : m[2].to_i
          while new_i < first_new
            map << old_i
            new_i += 1
            old_i += 1
          end
          added.times { map << nil }
          new_i += added
          old_i += removed
        end
        while new_i <= Coordination.line_count(new_text)
          map << old_i
          new_i += 1
          old_i += 1
        end
        map
      end
    end
  end

  class ApiError < StandardError; end

  # GET requests to the deployment's API, retrying 429, 5xx and network errors twice. It sends nothing else.
  class Api
    NETWORK = [Net::OpenTimeout, Net::ReadTimeout, SocketError, IOError, SystemCallError, OpenSSL::SSL::SSLError].freeze

    attr_reader :base

    def initialize(base, token: nil)
      @base = base.to_s.sub(%r{/+\z}, "")
      @token = token.to_s.empty? ? nil : token
      raise ApiError, "#{@base} is not an http(s) URL" unless %w[http https].include?(URI(@base).scheme)
    rescue URI::InvalidURIError => e
      raise ApiError, "#{base} is not a URL: #{e.message}"
    end

    # [status code, parsed body] of GET /api<path>.
    def get(path, query = {})
      uri = URI("#{@base}/api#{path}")
      uri.query = URI.encode_www_form(query) unless query.empty?
      attempts = 0
      begin
        attempts += 1
        req = Net::HTTP::Get.new(uri)
        req["Accept"] = "application/json"
        req["Authorization"] = "Bearer #{@token}" if @token
        res = Net::HTTP.start(uri.host, uri.port, use_ssl: uri.scheme == "https", open_timeout: 20, read_timeout: 120) { |h| h.request(req) }
        code = res.code.to_i
        raise ApiError, "HTTP #{code}" if (code == 429 || code >= 500) && attempts < 3

        body = begin
          JSON.parse(Coordination.utf8(res.body))
        rescue JSON::ParserError
          { "raw" => Coordination.utf8(res.body)[0, 200] }
        end
        [code, body]
      rescue ApiError, *NETWORK => e
        raise ApiError, "GET /api#{path}: #{e.message}" if attempts >= 3

        sleep(attempts)
        retry
      end
    end

    def get!(path, query = {})
      code, body = get(path, query)
      return body if code == 200

      raise ApiError, "GET /api#{path} answered #{code}: #{body.is_a?(Hash) ? body['error'] || body['raw'] : body}"
    end

    def colony(id) = get!("/colonies/#{id}")

    # The whole event record, page by page.
    def events(id)
      events = []
      after = 0
      first = nil
      loop do
        page = get!("/colonies/#{id}/events", { after: after, limit: EVENTS_PAGE })
        first ||= page
        events.concat(page["events"] || [])
        break if page["next"].nil?

        after = page["next"]
      end
      { "source" => first["source"], "total" => first["total"], "events" => events }
    end

    def agents(id) = get!("/colonies/#{id}/agents", { all: 1, journal: 0 })["agents"] || []

    # One proposal, or nil when the colony does not know it.
    def proposal(id, pid)
      code, body = get("/colonies/#{id}/proposals/#{URI.encode_www_form_component(pid)}")
      return nil if code == 404
      raise ApiError, "GET proposal #{pid} answered #{code}" unless code == 200

      body
    end
  end

  # The event record reduced to proposals and intents, vaccines left out.
  class Record
    attr_reader :proposals, :intents, :landing_ids, :human_returns, :t0, :t_last, :source, :total, :vaccine_proposals

    def initialize(page, vaccine_agents: Set.new)
      @source = page["source"]
      @total = page["total"]
      @proposals = {}
      @intents = {}
      @landing_ids = Set.new
      @human_returns = Set.new
      vaccine_ids = Set.new
      vaccine_intents = Set.new
      events = (page["events"] || []).each_with_index.sort_by { |e, i| [e["seq"] || i, i] }.map(&:first)
      events.each do |e|
        case e["t"]
        when "proposal"
          if vaccine_agents.include?(e["agentId"])
            vaccine_ids << e["proposalId"]
            vaccine_intents << e["intentId"]
            next
          end
          p = @proposals[e["proposalId"]] ||= { id: e["proposalId"], intent: e["intentId"], agent: e["agentId"], first_at: e["at"] }
          p[:status] = e["status"]
          p[:at] = e["at"]
          p[:reason] = e["reason"]
          if e["status"] == "returned"
            p[:returned_at] = e["at"]
            p[:return_reason] = e["reason"]
          end
        when "intent"
          (@intents[e["intentId"]] ||= { id: e["intentId"], title: e["title"] })[:status] = e["status"]
        when "landing"
          @landing_ids << e["landingId"] if e["landingId"]
        when "decision"
          @human_returns << e["subject"] if e["layer"] == "human" && e["action"] == "return"
        end
      end
      @vaccine_proposals = vaccine_ids.size
      ours = @proposals.values.to_set { |p| p[:intent] }
      (vaccine_intents - ours).each { |id| @intents.delete(id) }
      @proposals.each_value { |p| @intents[p[:intent]] ||= { id: p[:intent] } }
      times = @proposals.values.flat_map { |p| [p[:first_at], p[:at]] }.compact
      @t0 = times.min
      @t_last = times.max
    end
  end

  # The trunk as git shows it: FireTrident commits, the proposals each landed, and how each is known.
  class Lineage
    Prop = Struct.new(:id, :agent, :kind, :model, :intent, :paths, :blobs, keyword_init: true)
    Commit = Struct.new(:sha, :parent, :at, :landing, :kind, :source, :props, :intents, :changes, keyword_init: true)

    attr_reader :head, :commits, :ft, :base, :notes, :shallow, :changes, :warnings

    # `fetch` maps proposal ids to the API's copies ({id => proposal or nil}); `landing_ids` are the record's landings.
    def initialize(git, colony:, fetch: nil, landing_ids: nil)
      @head = git.head
      @shallow = git.shallow
      @warnings = []
      @commits = git.first_parent("HEAD")
      @notes = { found: 0, foreign: 0, unreadable: 0 }
      parsed = parse_notes(git.notes, colony)
      known = landing_ids && !landing_ids.empty? ? landing_ids : nil
      start = @commits.index { |c| parsed.key?(c[:sha]) || (c[:landing] && (known.nil? || known.include?(c[:landing]))) }
      ours = start ? @commits[start..].select { |c| parsed.key?(c[:sha]) || c[:landing] } : []
      @notes[:found] = ours.count { |c| parsed.key?(c[:sha]) }
      unnoted = ours.reject { |c| parsed.key?(c[:sha]) }
      api = fetch && !unnoted.empty? ? fetch.call(unnoted.flat_map { |c| c[:proposals] }) : {}
      @ft = ours.to_h { |c| [c[:sha], parsed.key?(c[:sha]) ? from_note(c, parsed[c[:sha]]) : from_trailers(c, api, fetch)] }
      first = ours.first
      @base = first && first[:parent] && git.has?(first[:parent]) ? first[:parent] : nil
      @changes = @ft.empty? ? {} : git.name_status(@base ? "#{@base}..#{@head}" : @head)
      @ft.each_value { |c| c.changes = @changes[c.sha] || [] }
    end

    # FireTrident commits in trunk order.
    def ft_commits = @commits.filter_map { |c| @ft[c[:sha]] }

    def landings = ft_commits.select { |c| c.kind == "landing" }

    # Every proposal the trunk landed, in landing order.
    def landed = landings.flat_map(&:props)

    private

    def parse_notes(notes, colony)
      notes.each_with_object({}) do |(sha, text), out|
        note = JSON.parse(Coordination.utf8(text))
        if !note.is_a?(Hash) || !note["proposals"].is_a?(Array)
          @notes[:unreadable] += 1
        elsif note["colonyId"].to_s != "" && note["colonyId"] != colony
          @notes[:foreign] += 1
        else
          out[sha] = note
        end
      rescue JSON::ParserError
        @notes[:unreadable] += 1
      end
    end

    def from_note(c, note)
      system = note.key?("system") || note.key?("revert") || note["proposals"].empty?
      props = system ? [] : note["proposals"].select { |p| p.is_a?(Hash) }.map { |p| prop(p, p.dig("intent", "id")) }
      unless system || c[:proposals].empty? || c[:proposals].sort == props.map(&:id).sort
        @warnings << "#{c[:sha][0, 7]}: its note lists #{props.map(&:id).join(', ')}, its trailers #{c[:proposals].join(', ')}"
      end
      Commit.new(sha: c[:sha], parent: c[:parent], at: c[:at], landing: note["landingId"] || c[:landing],
                 kind: system ? "system" : "landing", source: "note", props: props, intents: props.map(&:intent).compact.uniq)
    end

    # A FireTrident commit with no note: a system commit without FT-Proposal trailers, else a landing whose proposals
    # count when the API says they landed in this landing ("api"), some do ("api-partial"), or none can be checked.
    def from_trailers(c, api, fetch)
      if c[:proposals].empty?
        return Commit.new(sha: c[:sha], parent: c[:parent], at: c[:at], landing: c[:landing], kind: "system", source: "trailers", props: [], intents: [])
      end

      props = c[:proposals].filter_map do |pid|
        p = api[pid]
        prop(p, p["intentId"]) if p && p["status"] == "landed" && p["landingId"] == c[:landing]
      end
      source = if props.size == c[:proposals].size then "api"
               elsif !props.empty? then "api-partial"
               elsif fetch then "unverified"
               else "trailers"
               end
      Commit.new(sha: c[:sha], parent: c[:parent], at: c[:at], landing: c[:landing], kind: "landing", source: source,
                 props: props, intents: props.empty? ? c[:intents] : props.map(&:intent).compact.uniq)
    end

    def prop(p, intent)
      writes = (p["writeSet"] || []).select { |w| w.is_a?(Hash) && w["path"].is_a?(String) }
      Prop.new(id: p["id"], agent: p["agentId"], kind: p["agentKind"], model: p["model"], intent: intent,
               paths: writes.map { |w| w["path"] }, blobs: writes.to_h { |w| [w["path"], w["blob"]] })
    end
  end

  # Each line of each agent-touched file at HEAD, attributed as definition 2 says.
  class Attribution
    attr_reader :files, :skipped

    def initialize(git, lineage, log: ->(_m) {})
      @git = git
      @lineage = lineage
      @log = log
      @splits = {}
      @skipped = { absentAtHead: 0, binary: 0 }
      paths = touched_paths
      texts = git.cat(paths.map { |p| "#{lineage.head}:#{p}" })
      text_paths = paths.select do |p|
        t = texts["#{lineage.head}:#{p}"]
        @skipped[:absentAtHead] += 1 if t.nil?
        @skipped[:binary] += 1 if t && Coordination.binary?(t)
        t && !Coordination.binary?(t)
      end
      log.call("blaming #{text_paths.size} agent-touched files at #{lineage.head[0, 7]}") unless text_paths.empty?
      blames = Coordination.pmap(text_paths) { |p| git.blame(lineage.head, p) }
      @files = text_paths.zip(blames).map { |path, blame| attribute(path, blame) }
    end

    private

    # The paths landed proposals wrote, and every path a landing commit changed when its proposals are not all known.
    def touched_paths
      paths = Set.new
      @lineage.landings.each do |c|
        c.props.each { |p| paths.merge(p.paths) }
        c.changes.each { |_status, path| paths << path } unless %w[note api].include?(c.source)
      end
      paths.to_a.sort
    end

    def attribute(path, blame)
      file = { path: path, lines: blame[:lines].size, byAgent: Hash.new(0), imported: 0, system: 0, unattributed: 0 }
      blame[:lines].each do |commit, line|
        c = @lineage.ft[commit]
        # A shallow clone's boundary commit holds every line older than itself too, so none of its lines is given out.
        cut = blame[:boundary].include?(commit) && @lineage.shallow.include?(commit)
        if c.nil?
          file[:imported] += 1
        elsif c.kind == "system"
          file[:system] += 1
        elsif !cut && (agent = writer(c, path, line))
          file[:byAgent][agent] += 1
        else
          file[:unattributed] += 1
        end
      end
      file[:byAgent] = file[:byAgent].sort.to_h
      file
    end

    # The agent whose proposal wrote `line` of the commit's version of `path`, or nil.
    def writer(c, path, line)
      writers = c.props.select { |p| p.paths.include?(path) }
      return writers.first.agent if writers.size == 1
      return nil if writers.empty?

      key = [c.sha, path]
      @splits[key] = split(c, path, writers) unless @splits.key?(key)
      i = @splits[key]&.[](line - 1)
      i.nil? ? nil : writers[i].agent
    end

    # For each line of the commit's version of `path`, the index of the writer whose step added it (nil when the step
    # cannot be found); nil when the steps cannot be rebuilt from the clone.
    def split(c, path, writers)
      blobs = [c.parent && @git.blob_id(c.parent, path)] + writers.map { |w| w.blobs[path] }
      return nil unless blobs.last && blobs.last == @git.blob_id(c.sha, path)

      texts = @git.cat(blobs.compact)
      versions = blobs.map { |b| b.nil? ? "".b : texts[b] }
      return nil if versions.any?(&:nil?)

      maps = (1...versions.size).map { |k| Git.line_map(versions[k - 1], versions[k]) }
      # Walk each line back step by step: the step that added it wrote it; a line older than every step stays unknown.
      (1..Coordination.line_count(versions.last)).map do |line|
        k = maps.size
        idx = line
        found = nil
        while k.positive? && idx <= maps[k - 1].size
          prev = maps[k - 1][idx - 1]
          if prev.nil?
            found = k - 1
            break
          end
          idx = prev
          k -= 1
        end
        found
      end
    rescue GitError => e
      @log.call("could not split #{path} in #{c.sha[0, 7]}: #{e.message}")
      nil
    end
  end

  # The whole report: every number as a Hash (`build`); `Coordination.markdown` turns it into the short table.
  class Report
    RECORD_METRICS = ["merged fraction", "conflicts over time", "hottest file"].freeze

    def initialize(colony:, git:, api: nil, url: nil, api_note: nil, log: ->(_m) {})
      @colony = colony
      @git = git
      @api = api
      @url = url
      @log = log
      @api_note = api_note
      @missing = []
      @warnings = []
      @api_props = {}
      @lock = Mutex.new
    end

    def build
      snapshot, record, agents = load_record
      depth_value = snapshot&.dig("colony", "regionDepth")
      depth = depth_value.is_a?(Integer) && depth_value.positive? ? depth_value : DEFAULT_DEPTH
      @log.call("reading the trunk in #{@git.dir}")
      lineage = Lineage.new(@git, colony: @colony, fetch: (@api ? method(:fetch_proposals) : nil), landing_ids: record&.landing_ids)
      @warnings.concat(lineage.warnings)
      cross_check(snapshot, record, lineage)
      attribution = Attribution.new(@git, lineage, log: @log)
      others = record ? fetch_proposals(record.proposals.keys - lineage.landed.map(&:id)) : {}
      {
        schema: "firetrident.coordination/v1",
        colony: @colony,
        url: @url,
        trunk: trunk_summary(snapshot, lineage),
        record: record_summary(snapshot, record),
        regionDepth: { value: depth, source: depth_value ? "colony" : "default: the API gave no region depth" },
        mergedFraction: record && merged_fraction(record),
        codeSharing: code_sharing(attribution, lineage),
        specialization: specialization(lineage, depth),
        conflicts: record && conflicts(record),
        hottestFile: record && hottest_file(record, lineage, others),
        sprawl: sprawl(lineage, depth),
        linesPerIntent: lines_per_intent(lineage, attribution),
        agents: agent_table(agents, record, lineage, attribution),
        missing: @missing,
        warnings: @warnings
      }
    end

    private

    def missing(what, why)
      @missing << "#{what}: not computed, #{why}" unless @missing.any? { |m| m.start_with?("#{what}:") }
      nil
    end

    # The colony (its region depth and counters), its agents and its event record; each read on its own, so one that
    # fails costs only the numbers that need it.
    def load_record
      unless @api
        RECORD_METRICS.each { |w| missing(w, "the event record could not be read (#{@api_note || 'no --url'})") }
        return [nil, nil, []]
      end
      @log.call("reading the colony, its agents and its event record from #{@api.base}")
      snapshot = attempt("the colony not read") { @api.colony(@colony) }
      agents = attempt("agents not read, so vaccine proposals could not be left out") { @api.agents(@colony) } || []
      vaccine = agents.select { |a| a["name"] == "vaccine" && a["model"] == "vaccine" }.to_set { |a| a["id"] }
      page = @api.events(@colony)
      [snapshot, Record.new(page, vaccine_agents: vaccine), agents]
    rescue ApiError => e
      RECORD_METRICS.each { |w| missing(w, "the event record could not be read (#{e.message})") }
      [snapshot, nil, agents || []]
    end

    def attempt(what)
      yield
    rescue ApiError => e
      @warnings << "#{what} (#{e.message})"
      nil
    end

    # The API's copies of proposals, each read once, on up to THREADS requests at a time.
    def fetch_proposals(ids)
      ids = ids.uniq
      todo = @lock.synchronize { ids.reject { |id| @api_props.key?(id) } }
      if todo.size > FETCH_CAP
        @warnings << "#{todo.size} proposals to read; read the first #{FETCH_CAP}, the write sets of the others are unknown"
        todo = todo.first(FETCH_CAP)
      end
      unless todo.empty?
        @log.call("reading #{todo.size} proposals")
        got = Coordination.pmap(todo) do |id|
          @api.proposal(@colony, id)
        rescue ApiError => e
          @lock.synchronize { @warnings << "proposal #{id} not read: #{e.message}" }
          nil
        end
        @lock.synchronize { todo.zip(got).each { |id, p| @api_props[id] = p } }
      end
      ids.to_h { |id| [id, @api_props[id]] }
    end

    def cross_check(snapshot, record, lineage)
      trunk = snapshot&.dig("colony", "trunkSha")
      @warnings << "the clone's HEAD #{lineage.head[0, 7]} is not the colony's trunk #{trunk[0, 7]}: the git numbers are as of the clone" if trunk && trunk != lineage.head
      counted = snapshot&.dig("metrics", "proposals")
      return unless record && counted.is_a?(Integer) && counted != record.proposals.size

      @warnings << "the record holds #{record.proposals.size} proposals and the colony counts #{counted} (vaccines, or a record capped at its newest events)"
    end

    def trunk_summary(snapshot, lineage)
      ft = lineage.ft_commits
      sources = ft.map(&:source).tally
      {
        head: lineage.head,
        colonyTrunk: snapshot&.dig("colony", "trunkSha"),
        firstParentCommits: lineage.commits.size,
        shallow: !lineage.shallow.empty?,
        base: lineage.base,
        firetridentCommits: ft.size,
        landingCommits: ft.count { |c| c.kind == "landing" },
        systemCommits: ft.count { |c| c.kind == "system" },
        notes: lineage.notes,
        knownFrom: { note: sources.fetch("note", 0), apiAndTrailers: sources.fetch("api", 0) + sources.fetch("api-partial", 0),
                     trailersOnly: sources.fetch("trailers", 0), unverified: sources.fetch("unverified", 0) }
      }
    end

    def record_summary(snapshot, record)
      return nil unless record

      { source: record.source, events: record.total, proposals: record.proposals.size, intents: record.intents.size,
        vaccineProposalsLeftOut: record.vaccine_proposals,
        colonyCounters: (snapshot&.dig("metrics") || {}).slice("proposals", "landedProposals", "returned", "rejected", "escalated",
                                                                 "intents", "intentsLanded", "landings", "agents") }
    end

    # Definition 1.
    def merged_fraction(record)
      states = record.proposals.values.map { |p| state(p) }.tally
      made = record.proposals.size
      landed = states.fetch("landed", 0)
      in_flight = states.fetch("in flight", 0)
      landed_by_proposal = record.proposals.values.select { |p| p[:status] == "landed" }.to_set { |p| p[:intent] }
      status = record.intents.to_h { |id, i| [id, i[:status] || (landed_by_proposal.include?(id) ? "landed" : "unknown")] }
      with_proposal = record.proposals.values.to_set { |p| p[:intent] }
      landed_intents = status.count { |_, s| s == "landed" }
      {
        proposals: { made: made, landed: landed, returned: states.fetch("returned", 0), redirected: states.fetch("redirected", 0),
                     rejected: states.fetch("rejected", 0), inFlight: in_flight, other: states.fetch("other", 0) },
        merged: Coordination.rounded(Coordination.ratio(landed, made)),
        mergedOfSettled: Coordination.rounded(Coordination.ratio(landed, made - in_flight)),
        intents: { total: record.intents.size, withProposal: with_proposal.size, landed: landed_intents, byStatus: status.values.tally.sort.to_h },
        intentsMerged: Coordination.rounded(Coordination.ratio(landed_intents, record.intents.size)),
        intentsMergedWithProposal: Coordination.rounded(Coordination.ratio(status.count { |id, s| s == "landed" && with_proposal.include?(id) }, with_proposal.size))
      }
    end

    def state(p)
      case p[:status]
      when "landed", "rejected" then p[:status]
      when "returned" then Coordination.redirect?(p[:reason]) ? "redirected" : "returned"
      when *IN_FLIGHT then "in flight"
      else "other"
      end
    end

    # Definition 2.
    def code_sharing(attribution, lineage)
      files = attribution.files
      totals = { lines: 0, agentWritten: 0, imported: 0, system: 0, unattributed: 0 }
      per = {}
      files.each do |f|
        agent_lines = f[:byAgent].values.sum
        totals[:lines] += f[:lines]
        totals[:agentWritten] += agent_lines
        totals[:imported] += f[:imported]
        totals[:system] += f[:system]
        totals[:unattributed] += f[:unattributed]
        f[:byAgent].each do |agent, own|
          x = per[agent] ||= { files: 0, lines: 0, wholeFile: [0.0, 0.0], agentLines: [0.0, 0.0] }
          x[:files] += 1
          x[:lines] += own
          { wholeFile: f[:lines], agentLines: agent_lines }.each do |key, d|
            weight = own.to_f / d
            x[key][0] += weight * ((agent_lines - own).to_f / d)
            x[key][1] += weight
          end
        end
      end
      if per.empty?
        missing("code sharing", lineage.landings.empty? ? "the trunk has no landing commits" : "no line at HEAD could be given to an agent (no lineage notes, and no API copy of the landed proposals)")
      end
      agents = per.map do |agent, x|
        { agent: agent, files: x[:files], lines: x[:lines],
          wholeFile: Coordination.rounded(x[:wholeFile][0] / x[:wholeFile][1]), agentLines: Coordination.rounded(x[:agentLines][0] / x[:agentLines][1]) }
      end.sort_by { |a| [a[:wholeFile], a[:agent]] }
      {
        denominators: { wholeFile: "every line of the file at HEAD", agentLines: "the lines at HEAD given to an agent" },
        wholeFile: distribution(agents.map { |a| a[:wholeFile] }),
        agentLines: distribution(agents.map { |a| a[:agentLines] }),
        lines: totals,
        files: files.size,
        skipped: attribution.skipped,
        agents: agents,
        perFile: files
      }
    end

    def distribution(scores)
      return { agents: 0, median: nil } if scores.empty?

      s = scores.sort
      hist = Array.new(10, 0)
      s.each { |x| hist[[(x * 10).floor, 9].min] += 1 }
      { agents: s.size, median: Coordination.rounded(Coordination.median(s)), mean: Coordination.rounded(s.sum / s.size),
        min: s.first, p25: Coordination.rounded(Coordination.quantile(s, 0.25)), p75: Coordination.rounded(Coordination.quantile(s, 0.75)),
        max: s.last, histogram: hist.each_with_index.to_h { |n, i| [format("%.1f-%.1f", i / 10.0, (i + 1) / 10.0), n] } }
    end

    # Definition 3.
    def specialization(lineage, depth)
      landed = lineage.landed.map { |p| [p.agent, Coordination.primary_region(p.paths, depth)] }
      result = Coordination.specialization(landed)
      missing("specialization", "no agent has #{MIN_LANDINGS} or more landed proposals the trunk can attribute") if result[:observed].nil?
      result.merge(regionDepth: depth, landedProposals: landed.size)
    end

    # Definition 4.
    def conflicts(record)
      returns = returned(record)
      by_class = CLASSES.to_h { |c| [c, returns.count { |p| p[:class] == c }] }
      return { returns: 0, byClass: by_class, minutes: 0, cumulative: {}, list: [] } if record.t0.nil?

      last = minute(record.t_last, record.t0)
      cumulative = CLASSES.to_h { |c| [c, Array.new(last + 1, 0)] }
      returns.each { |p| (minute(p[:returned_at], record.t0)..last).each { |m| cumulative[p[:class]][m] += 1 } }
      total = (0..last).map { |m| CLASSES.sum { |c| cumulative[c][m] } }
      { returns: returns.size, byClass: by_class, firstProposalAt: record.t0, minutes: last + 1, cumulative: cumulative.merge("total" => total),
        list: returns.map { |p| { proposal: p[:id], agent: p[:agent], minute: minute(p[:returned_at], record.t0), class: p[:class], reason: p[:return_reason].to_s[0, 300] } } }
    end

    def minute(at, t0) = [((at - t0) / 60_000.0).floor, 0].max

    def returned(record)
      record.proposals.values.select { |p| p[:status] == "returned" && !Coordination.redirect?(p[:reason]) }.map do |p|
        p.merge(class: Coordination.classify(p[:return_reason], human: record.human_returns.include?(p[:id])))
      end.sort_by { |p| [p[:returned_at], p[:id]] }
    end

    # Definition 5.
    def hottest_file(record, lineage, others)
      returns = returned(record)
      return { path: nil, returns: 0, reason: "no returns" } if returns.empty?

      writes = {}
      known = Set.new(@git.tree_paths(lineage.head))
      lineage.landed.each { |p| writes[p.id] = [p.agent, p.paths] }
      others.each do |id, p|
        next unless p

        writes[id] ||= [p["agentId"], (p["writeSet"] || []).filter_map { |w| w["path"] }]
        (p["readSet"] || []).each { |r| known << r["path"] if r["path"] }
      end
      lineage.changes.each_value { |list| list.each { |_s, path| known << path } }
      writes.each_value { |_agent, paths| known.merge(paths) }
      named = Hash.new { |h, k| h[k] = [] }
      unknown = 0
      returns.each do |p|
        paths = Coordination.reason_paths(p[:return_reason], known)
        if paths.empty?
          unknown += 1 unless writes.key?(p[:id])
          paths = writes.dig(p[:id], 1) || []
        end
        paths.each { |path| named[path] << p[:id] }
      end
      return { path: nil, returns: 0, reason: "no return names a path", unknownWriteSets: unknown } if named.empty?

      ranked = named.sort_by { |path, ids| [-ids.size, path] }
      path, ids = ranked.first
      {
        path: path,
        returns: ids.size,
        tiedWith: ranked.drop(1).take_while { |_p, i| i.size == ids.size }.map(&:first),
        agentsProposed: writes.values.select { |_a, paths| paths.include?(path) }.to_set(&:first).size,
        sizes: sizes_of(path, lineage),
        top: ranked.first(10).map { |p, i| { path: p, returns: i.size } },
        unknownWriteSets: unknown
      }
    end

    def sizes_of(path, lineage)
      points = lineage.ft_commits.select { |c| c.changes.any? { |_s, p| p == path } }
      texts = @git.cat(([lineage.base] + points.map(&:sha)).compact.map { |sha| "#{sha}:#{path}" })
      before = lineage.base ? Coordination.line_count(texts["#{lineage.base}:#{path}"]) : 0
      [{ commit: lineage.base, kind: "base", lines: before }] +
        points.map { |c| { commit: c.sha, landing: c.landing, at: c.at, kind: c.kind, lines: Coordination.line_count(texts["#{c.sha}:#{path}"]) } }
    end

    # Definition 6.
    def sprawl(lineage, depth)
      return missing("sprawl", "the trunk has no FireTrident commits") if lineage.ft.empty?

      files = Set.new
      dirs = Hash.new(0)
      regions = Hash.new(0)
      bump = lambda do |path, by|
        dir = Coordination.top_dir(path)
        region = Coordination.region_of(path, depth)
        dirs[dir] += by if dir
        regions[region] += by
        dirs.delete(dir) if dir && dirs[dir].zero?
        regions.delete(region) if regions[region].zero?
      end
      @git.tree_paths(lineage.base).each { |p| bump.call(p, 1) if files.add?(p) }
      point = ->(c) { { commit: c&.sha || lineage.base, landing: c&.landing, at: c&.at, kind: c&.kind || "base", files: files.size, topDirs: dirs.size, regions: regions.size } }
      points = [point.call(nil)]
      started = lineage.base.nil?
      lineage.commits.each do |c|
        started ||= c[:parent] == lineage.base
        next unless started

        (lineage.changes[c[:sha]] || []).each do |status, path|
          if status == "D"
            bump.call(path, -1) if files.delete?(path)
          elsif files.add?(path)
            bump.call(path, 1)
          end
        end
        ft = lineage.ft[c[:sha]]
        points << point.call(ft) if ft
      end
      { regionDepth: depth, start: points.first.slice(:topDirs, :regions, :files), end: points.last.slice(:topDirs, :regions, :files),
        maxTopDirs: points.map { |p| p[:topDirs] }.max, maxRegions: points.map { |p| p[:regions] }.max, points: points }
    end

    # Definition 7.
    def lines_per_intent(lineage, attribution)
      return missing("lines per landed intent", "the trunk has no landing commits") if lineage.landings.empty?

      stats = @git.numstat(lineage.base ? "#{lineage.base}..#{lineage.head}" : lineage.head)
      sum = ->(commits) { commits.each_with_object({ added: 0, removed: 0, binary: 0 }) { |c, acc| (stats[c.sha] || {}).each { |k, v| acc[k] += v } } }
      landing = sum.call(lineage.landings)
      intents = lineage.landings.flat_map(&:intents).uniq
      files = attribution.files
      {
        added: landing[:added], removed: landing[:removed], net: landing[:added] - landing[:removed], binaryFiles: landing[:binary],
        landedIntents: intents.size,
        netPerIntent: Coordination.rounded(Coordination.ratio(landing[:added] - landing[:removed], intents.size), 2),
        system: sum.call(lineage.ft_commits.select { |c| c.kind == "system" }),
        agentTouchedFiles: files.size,
        linesInAgentTouchedFiles: files.sum { |f| f[:lines] },
        agentWrittenLinesAtHead: files.sum { |f| f[:byAgent].values.sum + f[:unattributed] },
        attributedLinesAtHead: files.sum { |f| f[:byAgent].values.sum }
      }
    end

    def agent_table(agents, record, lineage, attribution)
      info = agents.to_h { |a| [a["id"], a] }
      landed = lineage.landed.group_by(&:agent)
      made = record ? record.proposals.values.group_by { |p| p[:agent] } : {}
      lines = Hash.new(0)
      attribution.files.each { |f| f[:byAgent].each { |a, n| lines[a] += n } }
      (landed.keys + made.keys + lines.keys).compact.uniq.sort.map do |id|
        a = info[id] || {}
        props = landed[id] || []
        { id: id, name: a["name"], kind: a["kind"] || props.first&.kind, model: a["model"] || props.first&.model,
          proposals: made[id]&.size, returned: made[id]&.count { |p| state(p) == "returned" }, landed: props.size, linesAtHead: lines[id] }
      end
    end
  end

  # Specialization from landed proposals given as [agent, region] pairs in landing order (definition 3).
  def specialization(landed, shuffles: SHUFFLES, seed: SEED)
    agents = landed.map(&:first)
    labels = landed.map(&:last)
    qualifying = agents.tally.select { |_a, n| n >= MIN_LANDINGS }.keys.to_set
    stat = lambda do |regions|
      by = Hash.new { |h, k| h[k] = [] }
      agents.each_with_index { |a, i| by[a] << regions[i] if qualifying.include?(a) }
      median(by.values.map { |r| r.tally.values.max.to_f / r.size })
    end
    observed = stat.call(labels)
    return { minLandings: MIN_LANDINGS, agents: 0, observed: nil, baseline: nil, difference: nil, perAgent: [] } if observed.nil?

    per_agent = landed.group_by(&:first).filter_map do |a, list|
      next unless qualifying.include?(a)

      regions = list.map(&:last)
      top, n = regions.tally.max_by { |r, c| [c, -regions.index(r)] }
      { agent: a, landed: list.size, topRegion: top, topShare: rounded(n.to_f / list.size) }
    end
    rng = SplitMix64.new(seed)
    medians = Array.new(shuffles) { stat.call(rng.shuffle!(labels.dup)) }
    sorted = medians.sort
    baseline = median(medians)
    {
      minLandings: MIN_LANDINGS, agents: qualifying.size, observed: rounded(observed), baseline: rounded(baseline),
      difference: rounded(observed - baseline), p: rounded((1 + medians.count { |m| m >= observed - 1e-12 }).to_f / (shuffles + 1)),
      baselineP05: rounded(quantile(sorted, 0.05)), baselineP95: rounded(quantile(sorted, 0.95)),
      shuffles: shuffles, seed: seed, perAgent: per_agent.sort_by { |x| [-x[:topShare], x[:agent]] }
    }
  end

  def fmt(x, digits = 3) = x.nil? ? "n/a" : format("%.#{digits}f", x)

  def num(n) = n.to_i.to_s.reverse.scan(/\d{1,3}/).join(",").reverse

  # "1 return", "2 returns".
  def many(n, word) = "#{num(n)} #{word}#{n == 1 ? "" : "s"}"

  # The short markdown table for stdout.
  def markdown(r)
    t = r[:trunk]
    out = ["## Coordination: #{r[:colony]}", ""]
    intro = "Trunk #{t[:head][0, 7]}: #{num(t[:landingCommits])} landing commits and #{num(t[:systemCommits])} system commits, " \
            "#{num(t[:knownFrom][:note])} read from lineage notes and #{num(t[:knownFrom][:apiAndTrailers])} from trailers and the API"
    intro += r[:record] ? "; record #{r[:record][:source]}, #{num(r[:record][:events])} events" : "; no event record"
    out << "#{intro}; region depth #{r[:regionDepth][:value]}#{r[:regionDepth][:source] == 'colony' ? '' : ' (default)'}. Definitions: scripts/coordination.rb."
    out += ["", "| Measure | Value |", "| --- | --- |"]
    if (m = r[:mergedFraction])
      pr = m[:proposals]
      out << "| Proposals merged | #{num(pr[:landed])} of #{num(pr[:made])} (#{fmt(m[:merged])}); #{num(pr[:returned])} returned, " \
             "#{num(pr[:redirected])} redirected, #{num(pr[:rejected])} rejected, #{num(pr[:inFlight])} in flight |"
      out << "| Intents merged | #{num(m[:intents][:landed])} of #{num(m[:intents][:total])} (#{fmt(m[:intentsMerged])}) |"
    else
      out << "| Proposals merged | not computed: no event record |"
    end
    cs = r[:codeSharing]
    out << if cs[:wholeFile][:agents].positive?
             "| Code sharing, median agent | #{fmt(cs[:wholeFile][:median])} over whole files, #{fmt(cs[:agentLines][:median])} over agent-written lines " \
               "(#{many(cs[:wholeFile][:agents], "agent")}, #{many(cs[:files], "file")}; #{many(cs[:lines][:unattributed], "line")} unattributed) |"
           else
             "| Code sharing | not computed: no line at HEAD could be given to an agent |"
           end
    s = r[:specialization]
    out << if s[:observed]
             "| Specialization, median top-region share | #{fmt(s[:observed])} against #{fmt(s[:baseline])} shuffled " \
               "(#{s[:difference] >= 0 ? '+' : ''}#{fmt(s[:difference])}, p #{fmt(s[:p])}; #{many(s[:agents], "agent")} with #{MIN_LANDINGS}+ landings) |"
           else
             "| Specialization | not computed: no agent has #{MIN_LANDINGS}+ attributed landings |"
           end
    if (c = r[:conflicts])
      by = c[:byClass]
      out << "| Returns, cumulative over #{c[:minutes]} min | #{num(c[:returns])}: stale #{by['stale']}, text merge #{by['text_merge']}, " \
             "review #{by['review']}, rule #{by['rule']}, other #{by['other']} |"
    else
      out << "| Returns over time | not computed: no event record |"
    end
    h = r[:hottestFile]
    out << if h.nil? then "| Hottest file | not computed: no event record |"
           elsif h[:path].nil? then "| Hottest file | none: #{h[:reason]} |"
           else
             "| Hottest file | `#{h[:path]}`: named by #{many(h[:returns], "return")}, #{many(h[:agentsProposed], "agent")} proposed to it, " \
               "#{h[:sizes].first[:lines]} → #{h[:sizes].last[:lines]} lines |"
           end
    if (sp = r[:sprawl])
      out << "| Sprawl | top-level directories #{sp[:start][:topDirs]} → #{sp[:end][:topDirs]}, regions #{sp[:start][:regions]} → " \
             "#{sp[:end][:regions]} over #{many(sp[:points].size - 1, "commit")} |"
    end
    if (l = r[:linesPerIntent])
      out << "| Lines per landed intent | #{fmt(l[:netPerIntent], 2)} (+#{num(l[:added])} −#{num(l[:removed])} over #{many(l[:landedIntents], "intent")}); " \
             "#{num(l[:linesInAgentTouchedFiles])} lines in #{many(l[:agentTouchedFiles], "agent-touched file")}, #{num(l[:agentWrittenLinesAtHead])} agent-written |"
    end
    notes = r[:missing] + r[:warnings].first(5).map { |w| "warning: #{w}" }
    notes << "#{r[:warnings].size - 5} more warnings in the JSON" if r[:warnings].size > 5
    out += [""] + notes.map { |x| "- #{x}" } unless notes.empty?
    "#{out.join("\n")}\n"
  end

  # Fetch the notes into an existing clone, from the first remote that serves them; false when none does.
  def fetch_notes(dir, remotes, log)
    remotes.compact.uniq.each do |remote|
      Git.run(["fetch", "--quiet", remote, "+#{NOTES_REF}:#{NOTES_REF}"], dir: dir)
      log.call("fetched the lineage notes from #{redact(remote)}")
      return true
    rescue GitError => e
      log.call("no lineage notes from #{redact(remote)}: #{e.message}")
    end
    false
  end

  def main(argv)
    opts = { url: nil, colony: nil, clone: nil, json: nil }
    parser = OptionParser.new do |o|
      o.banner = "Usage: ruby scripts/coordination.rb --url https://<host> --colony <id> [--clone DIR] [--json FILE]"
      o.on("--url URL", "The deployment") { |v| opts[:url] = v.sub(%r{/+\z}, "") }
      o.on("--colony ID", "The colony") { |v| opts[:colony] = v }
      o.on("--clone DIR", "Read this clone (cloned into and kept when DIR does not exist)") { |v| opts[:clone] = File.expand_path(v) }
      o.on("--json FILE", "Write every number as JSON") { |v| opts[:json] = File.expand_path(v) }
    end
    parser.parse!(argv)
    abort(parser.banner) unless opts[:colony]
    existing = opts[:clone] && Dir.exist?(opts[:clone])
    abort("--url is needed (or --clone naming an existing clone)") unless opts[:url] || existing
    t0 = Time.now
    log = ->(msg) { warn(format("[%6.1fs] %s", Time.now - t0, redact(msg))) }
    api = nil
    api_note = nil
    if opts[:url]
      begin
        api = Api.new(opts[:url], token: ENV.fetch("FT_TOKEN", nil))
      rescue ApiError => e
        api_note = e.message
      end
    end
    public_git = opts[:url] && "#{opts[:url]}/git/#{opts[:colony]}.git"
    temp = nil
    dir = opts[:clone]
    if existing
      origin = begin
        utf8(Git.run(%w[remote get-url origin], dir: dir)).strip
      rescue GitError
        nil
      end
      fetch_notes(dir, [public_git, origin], log) || log.call("reading the notes the clone already has, if any")
    else
      dir ||= (temp = Dir.mktmpdir("ft-coordination"))
      log.call("cloning #{redact(public_git)}")
      Git.run(["clone", "--quiet", public_git, dir])
      fetch_notes(dir, ["origin"], log)
    end
    report = Report.new(colony: opts[:colony], git: Git.new(dir), api: api, url: opts[:url], api_note: api_note, log: log).build
    File.write(opts[:json], "#{JSON.pretty_generate(report)}\n") if opts[:json]
    print(markdown(report))
  rescue GitError, ApiError => e
    abort("coordination: #{redact(e.message)}")
  ensure
    FileUtils.remove_entry(temp) if temp && Dir.exist?(temp)
  end
end

Coordination.main(ARGV) if $PROGRAM_NAME == __FILE__
