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
#   GET /api/colonies/<id>                  region depth, trunk head, the colony's own counters (a cross-check, and the
#                                           take counters of 12) and its model spend by model (17)
#   GET /api/colonies/<id>/certifications   the newest certification results, with culprit suspects and first red (15)
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
#
# 8. Where the time went. Each landed intent's time from its first claim to its landing, split into four phases that
#    add up to it, from the record's intent, proposal and decision events. Its landing proposal is its first proposal
#    that landed; its other proposals that started before that one are the ones that came back. Claimed: its first
#    claim at or before its first proposal (when the record holds none, its first proposal, and the intent counts as
#    having no claim). Agent work: from its latest claim before its first proposal to that proposal. Rework: from its
#    first claim to that latest claim (holders that gave it back), plus from its first proposal to its landing proposal
#    (time on proposals that came back, and each return to the next proposal). Review: from the landing proposal to its
#    first ready event, or when it was escalated, to a person's decision on it (else its first ready after the
#    escalation); to its landing when the record holds neither. Waiting to land: from there to its landed event. A
#    point that clock skew between the colony's objects puts before the one ahead of it moves up to that one, so no
#    phase is negative. Reported: each phase's total in agent-seconds (intents run side by side, so the totals exceed
#    the run's wall time) and share of the whole, its median over the landed intents, the share of agent time spent
#    waiting to land, and the critical path behind the run's last landing: of the changes in the last landing commit
#    that carries any, the one that was ready last, with its intent's declaration, claims, proposals, review, and the
#    span from ready to landed (the lane's wait and the trunk writer's cycle together: the record does not split them).
#    In a reconstructed record claim times are estimates, so agent work, rework and the totals are too: it says so.
#
# 9. Who answers for each landing (packages/core/src/answerable.ts, the same rules). For each change of a landing
#    commit's note, first match wins: a person approved it (a decision of layer human and action approve); the person who
#    approved the rule, when the note's last gate check that the agent did not send says "→ land by deterministic" for a
#    rule's intent and the note records the rule's approver (else unknown); the person who asked for the intent (source
#    human); unknown when the note does not record the intent's source (notes written before 2026-10-16); else none. A
#    landing is none when a change of it is none, else unknown when one is unknown, else person. Reported over the
#    landing commits read from notes: how many, and how many of each, with the share no person answers for.
#
# 10. Closures (the closure ledger, packages/worker/src/colony/closure.ts). Every intent event that carries a cause: why
#    an intent an agent held closed or reopened (landed, released, escalated, withdrawn, gave_up, reaped_silent, returned,
#    stopped), with the agent and the gap since its last sign of life. Per agent kind (the event's agentKind, else the
#    agent's kind from the agents list): the closures, each cause's count and its share of the kind's closures. With it:
#    the intents taken back from silent agents (reaped_silent), with the median and largest gap; and the closes recorded
#    before the ledger (an intent event that moves an intent from claimed or proposed to open, landed or withdrawn with
#    no cause), counted apart and in no share. Vaccine agents are left out.
#
# 11. Heads-up before returns (FT_HEADS_UP, packages/worker/src/colony/headsup.ts). Returns (as in 1: redirects apart)
#    whose reason ends with the heads-up's sentence: warned and proposed anyway ("You were told of <landing> at
#    <hh:mm:ss> UTC, <gap> before you proposed.") or could not have known (a sentence ending "you could not have
#    known."); the other returns carry none (another kind of return, or an agent the heads-up never served). With them,
#    the colony's own counters headsUp.warned and headsUp.unwarned from GET /api/colonies/<id> (a cross-check).
#
# 12. Coordination tokens per take, an ESTIMATE: tokens = characters / 4. What a take hands an agent beyond its intent and
#    lease, as the colony counts it when it hands the take (packages/worker/src/colony/coordtokens.ts, the coord.*
#    counters in GET /api/colonies/<id>): the characters of the JSON of its why-context, field guide lessons, last return
#    and review preview (antibody questions and rules), and apart, the heads-ups with something to say the colony computed
#    while agents held intents (they come on later replies, so they are spread over all takes and kept out of the
#    buckets). A take hands no field reading (sense is a separate call the region objects answer): none is counted. Per
#    take = characters / takes. Read everything, the counterfactual: at each take, the characters of every landed intent's
#    why and every active lesson the colony holds; per take likewise. Against agent count: the same per bucket of the
#    agents active at the take (1, 2-3, 4-7, ...); flat = tokens per take in the largest bucket / in the smallest, beside
#    the same ratio for read everything. Rebuilt from the record and notes for every record (and the only numbers for runs
#    before the counters): each take in the record (an agent event that sets an agent working on an intent, with its
#    footprint) with the why-context the colony would pick (agents/landed.ts: of the landings at or before the take, the
#    newest 3 per path, an exact footprint path reading its own and a directory or glob the first 300 of them under it in
#    path order; of those its footprint covers, grouped by landing and intent, the newest 3 groups, each with its
#    intent's title cut to 200 characters and why cut to 300, one line each, from the notes, and up to 10 paths) and its
#    last return (the newest earlier proposal of the intent, as its status stood at the take, that came back for a reason
#    other than a change of direction, unless one landed after it: its reason and up to 20 written paths from the API's
#    copy). Guide, review preview and heads-up cannot be rebuilt, so the rebuilt numbers are a lower bound; read
#    everything rebuilt is the whys of the intents landed at or before the take. Agents active at a rebuilt take: agents
#    whose last agent event before it is not dead. In a reconstructed record the take times are estimates: it says so.
#
# 13. Access by model and by agent kind (platform = in-platform, external, synthetic). Agents: the agents list (vaccine
#    apart) and any agent the record or notes name, each with the model and kind the list gives (else its notes'). Per
#    group: share of agents = its agents / all agents; share of landings = its landed proposals / all landed proposals;
#    claim to landing, p50 and p90 over its landed proposals, from the intent's latest claim at or before the proposal was
#    made (the proposal itself when the record holds none) to its landed event; returns per proposal (returns as in 1,
#    over proposals made); routed to a person = proposals with an escalated event / proposals made; top agent = the
#    agent with the most landed proposals in the group, and its share of the group's; next cycle = over consecutive
#    landing cycles (the record's landing events that carry a proposal it holds, in time order), the share of the group's
#    agents landing in one cycle that land in the next.
#
# 14. Return to reland. For each return (as in 1: redirects apart): whether its intent landed afterwards (a proposal of
#    the intent landed at or after the return), how long after, and whether the same agent landed it. Per agent kind, per
#    return class (as in 4), and per kind and class: returns, the share relanded, p50 and p90 seconds to reland.
#
# 15. Culprit precision against first red. Every red certification whose first-red search (FT_BISECT) found a commit,
#    from GET /api/colonies/<id>/certifications (the newest 500 results; else the record's certify and bisect events,
#    whose suspects stop at 5). The landing found is, first match wins: a suspect at rank r (its place in the result's
#    suspect list, newest first, from 1); outside the import trace (none of its proposals wrote what the failing tests
#    load: the answer's proposals are empty); not looked for (the result has no suspects: culprit finding off or out of
#    time); closure not recorded (an answer from before the search listed the landing's proposals); in the closure but
#    cut by a limit (it wrote what they load and is not a suspect: the newest-landings limits).
#    With them: the rank 1 share, and for an answer that isolated one proposal, whether a suspect names that proposal.
#    Answers copied from an earlier result's search (reusedFrom) count, and are counted apart too.
#
# 16. Residue and review rounds. Per landed intent: the proposals it took to land (its proposals made up to the one that
#    landed, that one included, as in 8), its review rounds (decision events of any layer whose subject is one of those
#    proposals), and declared to landed (its first intent event to its landing). Per change: decision events per
#    proposal, over every proposal and over the landed ones. Residue: the intents open, claimed or proposed at the
#    record's last event, with their ages then and the five oldest.
#
# 17. Lines alive on trunk, by model and by agent kind. Added: the lines each landed proposal added on trunk (`git log
#    --numstat` of its landing commit, per file: a file one proposal wrote goes to it; a file several wrote, by the steps
#    of 2; else unattributed). Alive: the lines at HEAD given to each agent in 2. An agent's model and kind: those of its
#    landed proposals' notes (the most frequent), else the agents list. Per model and per kind: landed proposals, lines
#    added, lines alive and alive / added, returns (as in 1), reverted proposals (revert notes: the proposal named, else
#    every proposal of the landing undone), and per model what this platform's model calls with it cost (spend.byModel in
#    GET /api/colonies/<id>: in-platform agents and review; external agents' own models are not in it). Spend under a
#    model no agent names (a review model, or an agent listed by its model class) is listed apart, never guessed.
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
  # Definition 11: the heads-up's sentences at the end of a return's reason.
  WARNED = /You were told of \S+ at \d\d:\d\d:\d\d UTC, [^.]{1,40} before you proposed\.\s*\z/
  UNWARNED = /\byou could not have known\.\s*\z/
  IN_FLIGHT = %w[pending checking ready escalated].freeze
  # Definition 10: the closure ledger's causes, and the moves an intent event makes that close or reopen a held intent.
  CLOSURE_CAUSES = %w[landed released escalated withdrawn gave_up reaped_silent returned stopped].freeze
  HELD = %w[claimed proposed].freeze
  CLOSED = %w[open landed withdrawn].freeze
  PHASES = %i[agentWork review waitingToLand rework].freeze
  EVENTS_PAGE = 5_000
  FETCH_CAP = 10_000
  THREADS = 8
  # Definition 12: the estimate, the parts a take hands (as the colony's counters name them), and the why-context and
  # last return as the colony builds them (agents/landed.ts, agents/prompt.ts).
  CHARS_PER_TOKEN = 4
  TAKE_PARTS = %w[context guide lastReturn review].freeze
  WHY_LANDINGS = 3
  WHY_PER_PATH = 3
  WHY_FOOTPRINT = 20
  WHY_RANGE_ROWS = 300
  WHY_CHARS = 300
  WHY_PATHS = 10
  TITLE_CHARS = 200
  RETURN_PATHS = 20
  RETURN_REASON_CHARS = 2_000
  GLOB = /[*?{]/
  # Definitions 13, 14 and 17: agent kinds as the report names them. Definition 15: certification results the colony keeps.
  KIND_LABELS = { "internal" => "platform", "external" => "external", "synthetic" => "synthetic" }.freeze
  CERTIFICATIONS_KEPT = 500

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

  # Who answers for one change of a note (definition 9): approved, rule, asked, none or unknown.
  def change_answer(p)
    decisions = p["decisions"].is_a?(Array) ? p["decisions"] : []
    return "approved" if decisions.any? { |d| d.is_a?(Hash) && d["layer"] == "human" && d["action"] == "approve" }

    checks = p["evidence"].is_a?(Hash) && p["evidence"]["checks"].is_a?(Array) ? p["evidence"]["checks"] : []
    intent = p["intent"].is_a?(Hash) ? p["intent"] : {}
    gate = checks.reverse.find { |c| c.is_a?(Hash) && c["name"] == "gate" && c["by"] != "agent" && c["detail"].is_a?(String) }
    landed = gate && gate["detail"].match(/→ (\S+) by (\S+)/)
    rule = intent["ruleId"].to_s.strip
    return intent["ruleApprovedBy"].is_a?(String) ? "rule" : "unknown" if !rule.empty? && landed && landed[2] == "deterministic" && landed[1] == "land"
    return "unknown" unless intent["source"].is_a?(String) && !intent["source"].empty?

    intent["source"].gsub(/\s+/, " ").strip == "human" ? "asked" : "none"
  end

  # Who answers for a landing commit's note (definition 9): person, none or unknown.
  def landing_answer(note)
    return "person" if note["revert"].is_a?(Hash) || (note["system"].is_a?(Hash) && note["system"]["kind"] == "antibody")
    return "none" if note["system"].is_a?(Hash)

    answers = (note["proposals"].is_a?(Array) ? note["proposals"] : []).select { |p| p.is_a?(Hash) }.map { |p| change_answer(p) }
    return "unknown" if answers.empty?
    return "none" if answers.include?("none")

    answers.include?("unknown") ? "unknown" : "person"
  end

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

    # Lines each first-parent commit in `range` added per text file: sha => {path => added} (definition 17).
    def numstat_files(range)
      out = {}
      current = nil
      text("log", "--first-parent", "--no-renames", "--numstat", "--format=%x01%H", range).each_line(chomp: true) do |line|
        if line.start_with?("\x01")
          current = out[line[1..]] = {}
        elsif current && (m = /\A(\d+)\t\d+\t(.+)\z/.match(line))
          current[m[2]] = current.fetch(m[2], 0) + m[1].to_i
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

    # The newest certification results, as many as the colony keeps (definition 15).
    def certifications(id) = get!("/colonies/#{id}/certifications", { limit: CERTIFICATIONS_KEPT })["results"] || []

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
    attr_reader :proposals, :intents, :landing_ids, :human_returns, :t0, :t_last, :source, :total, :vaccine_proposals,
                :claims, :declared, :human_decisions, :landings, :first_at, :closures, :uncaused_closures,
                :takes, :decisions, :certify, :bisects, :last_at

    def initialize(page, vaccine_agents: Set.new)
      # Definition 12: takes (agent events that set an agent working on an intent, with its footprint) and the agents
      # whose last agent event is not dead. Definition 16: decisions of any layer per subject. Definition 15: each
      # commit's certification result and first-red answer.
      @takes = []
      @states = {}
      @alive = 0
      @decisions = Hash.new(0)
      @certify = {}
      @bisects = {}
      @source = page["source"]
      @total = page["total"]
      @proposals = {}
      @intents = {}
      @landing_ids = Set.new
      @human_returns = Set.new
      # Definition 8: each intent's claim times and first event, people's decisions by proposal, and the landings.
      @claims = Hash.new { |h, k| h[k] = [] }
      @declared = {}
      @human_decisions = Hash.new { |h, k| h[k] = [] }
      @landings = []
      # Definition 10: intent events with a cause, and closes of held intents recorded before the ledger.
      @closures = []
      @uncaused_closures = 0
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
          p = @proposals[e["proposalId"]] ||= { id: e["proposalId"], intent: e["intentId"], agent: e["agentId"], first_at: e["at"], events: [] }
          p[:status] = e["status"]
          p[:at] = e["at"]
          p[:reason] = e["reason"]
          p[:events] << [e["at"], e["status"]]
          p[:landed_at] ||= e["at"] if e["status"] == "landed"
          if e["status"] == "returned"
            p[:returned_at] = e["at"]
            p[:return_reason] = e["reason"]
          end
        when "intent"
          prev = @intents.dig(e["intentId"], :status)
          (@intents[e["intentId"]] ||= { id: e["intentId"], title: e["title"] })[:status] = e["status"]
          if CLOSURE_CAUSES.include?(e["cause"])
            unless vaccine_agents.include?(e["agentId"])
              @closures << { intent: e["intentId"], at: e["at"], status: e["status"], cause: e["cause"], agent: e["agentId"], kind: e["agentKind"],
                             gap_ms: e["gapMs"].is_a?(Numeric) ? e["gapMs"] : nil }
            end
          elsif HELD.include?(prev) && CLOSED.include?(e["status"])
            @uncaused_closures += 1
          end
          @declared[e["intentId"]] ||= e["at"]
          @claims[e["intentId"]] << e["at"] if e["status"] == "claimed" && e["at"].is_a?(Numeric)
        when "landing"
          @landing_ids << e["landingId"] if e["landingId"]
          @landings << { id: e["landingId"], at: e["at"], proposals: e["proposalIds"] || [] } if e["at"].is_a?(Numeric)
        when "decision"
          @human_returns << e["subject"] if e["layer"] == "human" && e["action"] == "return"
          @human_decisions[e["subject"]] << e["at"] if e["layer"] == "human" && e["at"].is_a?(Numeric)
          @decisions[e["subject"]] += 1 if e["subject"]
        when "agent"
          agent_event(e) unless vaccine_agents.include?(e["agentId"])
        when "certify"
          @certify[e["trunkSha"]] = e if e["trunkSha"].is_a?(String) && e["status"].is_a?(String)
        when "bisect"
          @bisects[e["trunkSha"]] = e["firstRed"] if e["trunkSha"].is_a?(String) && e["firstRed"].is_a?(Hash)
        end
      end
      @first_at = events.filter_map { |e| e["at"] if e["at"].is_a?(Numeric) }.min
      @last_at = events.filter_map { |e| e["at"] if e["at"].is_a?(Numeric) }.max
      @vaccine_proposals = vaccine_ids.size
      ours = @proposals.values.to_set { |p| p[:intent] }
      (vaccine_intents - ours).each { |id| @intents.delete(id) }
      @proposals.each_value { |p| @intents[p[:intent]] ||= { id: p[:intent] } }
      times = @proposals.values.flat_map { |p| [p[:first_at], p[:at]] }.compact
      @t0 = times.min
      @t_last = times.max
    end

    private

    # One agent event: the agent's state, and a take when it sets the agent working on an intent with its footprint.
    def agent_event(e)
      id = e["agentId"]
      was = @states[id]
      now = e["state"]
      @alive += 1 if (was.nil? || was == "dead") && now != "dead"
      @alive -= 1 if !was.nil? && was != "dead" && now == "dead"
      @states[id] = now
      return unless now == "working" && e["intentId"] && e["paths"].is_a?(Array) && e["at"].is_a?(Numeric)

      @takes << { at: e["at"], agent: id, kind: e["kind"], intent: e["intentId"], footprint: e["paths"].grep(String), active: @alive }
    end
  end

  # The trunk as git shows it: FireTrident commits, the proposals each landed, and how each is known.
  class Lineage
    Prop = Struct.new(:id, :agent, :kind, :model, :intent, :paths, :blobs, :title, :why, keyword_init: true)
    Commit = Struct.new(:sha, :parent, :at, :landing, :kind, :source, :props, :intents, :changes, :answer, :revert, keyword_init: true)

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
                 kind: system ? "system" : "landing", source: "note", props: props, intents: props.map(&:intent).compact.uniq,
                 answer: Coordination.landing_answer(note), revert: note["revert"].is_a?(Hash) ? note["revert"] : nil)
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
      about = p["intent"].is_a?(Hash) ? p["intent"] : {}
      Prop.new(id: p["id"], agent: p["agentId"], kind: p["agentKind"], model: p["model"], intent: intent,
               paths: writes.map { |w| w["path"] }, blobs: writes.to_h { |w| [w["path"], w["blob"]] },
               title: about["title"].is_a?(String) ? about["title"] : nil, why: about["why"].is_a?(String) ? about["why"] : nil)
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

    # Definition 17: the lines of the commit's version of `path` each writer's step added, by proposal id; nil when the
    # steps cannot be rebuilt from the clone.
    def added_by(c, path, writers)
      key = [c.sha, path]
      @splits[key] = split(c, path, writers) unless @splits.key?(key)
      @splits[key]&.compact&.tally&.transform_keys { |i| writers[i].id }
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
    RECORD_METRICS = ["merged fraction", "conflicts over time", "hottest file", "where the time went", "access by model and kind",
                      "return to reland", "residue and review rounds"].freeze

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
        answerable: answerable(lineage),
        timeSplit: record && Coordination.time_split(record),
        closures: record && Coordination.closures(record, agents),
        headsUp: record && Coordination.heads_up(record, snapshot),
        takeTokens: take_tokens(snapshot, record, lineage, others),
        access: record && Coordination.access(record, agents, notes_agents(lineage)),
        relands: record && Coordination.relands(record, agents, notes_agents(lineage)),
        culpritPrecision: culprit_precision(record),
        residue: record && Coordination.residue(record),
        linesByModel: lines_by_model(lineage, attribution, record, agents, snapshot),
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
                                                                 "intents", "intentsLanded", "landings", "agents", "headsUp.warned", "headsUp.unwarned") }
    end

    # Definition 1.
    # Definition 9.
    def answerable(lineage)
      counted = lineage.landings.select { |c| c.source == "note" }
      by = counted.map(&:answer).tally
      none = by.fetch("none", 0)
      { landings: counted.size, person: by.fetch("person", 0), none: none, unknown: by.fetch("unknown", 0),
        noneShare: Coordination.rounded(Coordination.ratio(none, counted.size)) }
    end

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

    # Definition 12: the colony's counters, and the takes rebuilt from the record and notes.
    def take_tokens(snapshot, record, lineage, others)
      rebuilt = record && Coordination.rebuild_takes(record, **take_inputs(record, lineage, others))
      result = Coordination.take_tokens(snapshot&.dig("metrics"), rebuilt)
      missing("coordination tokens per take", "the colony has no take counters and no record of takes could be read") if result[:source].nil?
      result
    end

    # What a rebuilt take reads: each landed path with its landing and intent, the landed intents' titles and whys, and
    # the paths each proposal that did not land wrote (the API's copies).
    def take_inputs(record, lineage, others)
      at_of = record.landings.to_h { |l| [l[:id], l[:at]] }
      rows = []
      texts = {}
      whys = {}
      lineage.landings.each do |c|
        at = at_of[c.landing] || c.at
        c.props.each do |p|
          if p.intent
            texts[p.intent] ||= { title: p.title.to_s, why: p.why.to_s }
            whys[p.intent] ||= [at, p.why.to_s.length]
          end
          p.paths.each { |path| rows << { path: path, at: at, landing: c.landing, intent: p.intent, sha: c.sha } }
        end
      end
      writes = others.transform_values { |p| p.is_a?(Hash) ? (p["writeSet"] || []).filter_map { |w| w["path"] if w.is_a?(Hash) && w["path"].is_a?(String) } : [] }
      { rows: rows, texts: texts, whys: whys.values, writes: writes }
    end

    # Each agent's kind and model from its landed proposals' notes (the most frequent).
    def notes_agents(lineage)
      lineage.landed.group_by(&:agent).transform_values { |props| { kind: Coordination.most(props.map(&:kind)), model: Coordination.most(props.map(&:model)) } }
    end

    # Definition 15: the certification results, else the record's certify and bisect events.
    def culprit_precision(record)
      certs = @api ? attempt("certifications not read, so culprit precision comes from the record's events") { @api.certifications(@colony) } : nil
      source = "certifications"
      if certs.nil?
        return missing("culprit precision", "neither the certifications nor the event record could be read") unless record

        certs = Coordination.certifications_from(record)
        source = "events: suspects stop at 5"
      end
      Coordination.culprit_precision(certs).merge(source: source)
    end

    # Definition 17: lines each landed proposal added (numstat per file, split by the steps of 2 where several wrote a
    # file), the lines alive at HEAD per agent, returns, reverted proposals and the platform's spend by model.
    def lines_by_model(lineage, attribution, record, agents, snapshot)
      return missing("lines alive by model", "the trunk has no landing commits") if lineage.landings.empty?

      stats = @git.numstat_files(lineage.base ? "#{lineage.base}..#{lineage.head}" : lineage.head)
      added = Hash.new(0)
      unattributed = 0
      lineage.landings.each do |c|
        (stats[c.sha] || {}).each do |path, n|
          writers = c.props.select { |p| p.paths.include?(path) }
          split = writers.size > 1 ? attribution.added_by(c, path, writers) : nil
          if writers.size == 1
            added[writers.first.id] += n
          elsif split
            split.each { |id, k| added[id] += k }
            unattributed += [n - split.values.sum, 0].max
          else
            unattributed += n
          end
        end
      end
      alive = Hash.new(0)
      attribution.files.each { |f| f[:byAgent].each { |agent, n| alive[agent] += n } }
      returns = record ? record.proposals.values.select { |p| p[:status] == "returned" && !Coordination.redirect?(p[:reason]) }.map { |p| p[:agent] }.tally : {}
      by_landing = lineage.landings.to_h { |c| [c.landing, c] }
      reverted = lineage.ft_commits.filter_map(&:revert).flat_map do |r|
        r["proposal"].is_a?(String) ? [r["proposal"]] : (by_landing[r["of"]]&.props || []).map(&:id)
      end.uniq
      Coordination.lines_by_model(landed: lineage.landed, added: added, alive: alive, returns: returns, reverted: reverted, agents: agents,
                                  spend: snapshot&.dig("spend", "byModel"), unattributed: unattributed)
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
  # Definition 10: closures per agent kind and cause, the reaped agents' gaps, and the closes that predate the ledger.
  def closures(record, agents)
    kinds = agents.to_h { |a| [a["id"], a["kind"]] }
    counts = Hash.new { |h, k| h[k] = Hash.new(0) }
    gaps = []
    reaped = 0
    record.closures.each do |c|
      counts[c[:kind] || kinds[c[:agent]] || "unknown"][c[:cause]] += 1
      next unless c[:cause] == "reaped_silent"

      reaped += 1
      gaps << c[:gap_ms] if c[:gap_ms]
    end
    by_kind = counts.sort.to_h do |kind, by|
      total = by.values.sum
      shown = CLOSURE_CAUSES.select { |cause| by[cause].positive? }
      [kind, { total: total, counts: shown.to_h { |cause| [cause, by[cause]] }, shares: shown.to_h { |cause| [cause, rounded(ratio(by[cause], total))] } }]
    end
    { closures: record.closures.size, byKind: by_kind, reaped: { count: reaped, medianGapMs: median(gaps), maxGapMs: gaps.max },
      beforeLedger: record.uncaused_closures }
  end

  # Definition 11: returns by what the heads-up had told their agent, from the sentence their reason ends with.
  def heads_up(record, snapshot = nil)
    returns = record.proposals.values.select { |p| p[:status] == "returned" && !redirect?(p[:reason]) }
    verdicts = returns.map do |p|
      reason = p[:return_reason].to_s
      if WARNED.match?(reason) then "warned"
      elsif UNWARNED.match?(reason) then "unwarned"
      else "none"
      end
    end.tally
    counters = snapshot&.dig("metrics") || {}
    { returns: returns.size, warned: verdicts.fetch("warned", 0), unwarned: verdicts.fetch("unwarned", 0), none: verdicts.fetch("none", 0),
      colonyCounters: { warned: counters["headsUp.warned"], unwarned: counters["headsUp.unwarned"] } }
  end

  # The markdown row of definition 11, or nil when no return carries the heads-up's sentence.
  def heads_up_row(h)
    return nil if h.nil? || (h[:warned] + h[:unwarned]).zero?

    "| Heads-up before returns | #{num(h[:warned])} warned and proposed anyway, #{num(h[:unwarned])} could not have known " \
      "(of #{many(h[:returns], 'return')}; #{num(h[:none])} with no heads-up) |"
  end

  # Estimated tokens: characters / CHARS_PER_TOKEN, to one decimal.
  def tokens(chars) = chars.nil? ? nil : (chars.to_f / CHARS_PER_TOKEN).round(1)

  # An agent kind as the report names it (in-platform agents are "platform").
  def kind_label(kind) = kind.nil? ? "unknown" : KIND_LABELS.fetch(kind.to_s, kind.to_s)

  def vaccine?(agent) = agent["name"] == "vaccine" && agent["model"] == "vaccine"

  # The most frequent value (ties to the larger), nil for none.
  def most(values) = values.compact.tally.max_by { |v, n| [n, v.to_s] }&.first

  # The bucket of a count of active agents: the largest power of two at or below it, 1 below 2 (colony/coordtokens.ts).
  def agent_bucket(n)
    b = 1
    b *= 2 while b * 2 <= n.to_i
    b
  end

  def bucket_label(from) = from == 1 ? "1" : "#{from}-#{(from * 2) - 1}"

  # Characters of a value's JSON (0 for nil), as the colony measures a take's parts.
  def json_chars(value) = value.nil? ? 0 : JSON.generate(value).length

  # Text on one line, cut to `max` characters with an ellipsis (agents/landed.ts shortTitle and shortWhy).
  def cut(text, max)
    t = text.to_s.gsub(/\s+/, " ").strip
    t.length > max ? "#{t[0, max - 1]}…" : t
  end

  # Whether a footprint entry covers a path (core footprintCovers): the path itself, a directory, or a glob.
  def covers?(entry, path)
    e = entry.delete_prefix("./")
    return false if e.empty?
    return true if e == path
    return path.start_with?(e) if e.end_with?("/")

    File.fnmatch?(e, path, File::FNM_PATHNAME | File::FNM_EXTGLOB | File::FNM_DOTMATCH)
  end

  # Each agent's kind and model: the agents list's first (`prefer: :list`) or the notes' first (`prefer: :notes`).
  def profiles(agents, notes, prefer: :list)
    list = agents.to_h { |a| [a["id"], { kind: a["kind"], model: a["model"] }] }
    (list.keys + notes.keys).uniq.to_h do |id|
      first, second = prefer == :list ? [list[id] || {}, notes[id] || {}] : [notes[id] || {}, list[id] || {}]
      [id, { kind: first[:kind] || second[:kind], model: first[:model] || second[:model] }]
    end
  end

  # The colony's per-path landing index as a take reads it (agents/landed.ts), rebuilt from the notes (definition 12).
  class LandedIndex
    # `rows`: {path:, at:, landing:, intent:, sha:}, one per path a landed proposal wrote.
    def initialize(rows)
      @by_path = rows.group_by { |r| r[:path] }.transform_values { |list| list.sort_by { |r| [r[:at], r[:landing].to_s] } }
      @paths = @by_path.keys.sort
    end

    # The why-context of a take at `at` for `footprint`, or nil. The index holds the newest WHY_PER_PATH landings of each
    # path at or before `at`; an exact path reads its own, a directory or glob the first WHY_RANGE_ROWS rows under its
    # literal head in path order (as the colony's range query returns them). Of the rows a footprint entry covers, the
    # newest WHY_LANDINGS groups of landing and intent, each with its intent's title and why (`texts`) and its paths.
    def context(footprint, at, texts)
      entries = footprint.first(WHY_FOOTPRINT)
      groups = {}
      entries.flat_map { |entry| rows_for(entry, at) }.each do |r|
        next unless entries.any? { |e| Coordination.covers?(e, r[:path]) }

        g = groups[[r[:landing], r[:intent]]] ||= { landingId: r[:landing], at: r[:at], sha: r[:sha], intentId: r[:intent], paths: Set.new }
        g[:at] = [g[:at], r[:at]].max
        g[:paths] << r[:path]
      end
      # Newest first, then the larger landing id, then the order found (the colony's sort is stable).
      ranked = groups.values.each_with_index.sort { |(a, i), (b, j)| ([b[:at], b[:landingId].to_s] <=> [a[:at], a[:landingId].to_s]).nonzero? || (i <=> j) }
      picked = ranked.map(&:first).first(WHY_LANDINGS)
      return nil if picked.empty?

      picked.map do |g|
        t = texts[g[:intentId]] || {}
        out = { landingId: g[:landingId], at: g[:at], title: Coordination.cut(t[:title], TITLE_CHARS), why: Coordination.cut(t[:why], WHY_CHARS),
                paths: g[:paths].to_a.sort.first(WHY_PATHS) }
        out[:trunkSha] = g[:sha] if g[:sha]
        out[:intentId] = g[:intentId] if g[:intentId]
        out
      end
    end

    private

    # The index rows one footprint entry reads at `at` (agents/landed.ts indexRange): an exact path's own, or the first
    # WHY_RANGE_ROWS rows under a directory's or a glob's literal head, in path order; none for an entry with no head.
    def rows_for(entry, at)
      e = entry.delete_prefix("./")
      return [] if e.empty?
      return held(e, at) unless e.match?(GLOB) || e.end_with?("/")

      head = e.match?(GLOB) ? e[0...(e =~ GLOB)] : e
      return [] unless head.include?("/")

      prefix = head[0..head.rindex("/")]
      out = []
      i = @paths.bsearch_index { |p| p >= prefix } || @paths.size
      while out.size < WHY_RANGE_ROWS && i < @paths.size && @paths[i].start_with?(prefix)
        out.concat(held(@paths[i], at))
        i += 1
      end
      out.first(WHY_RANGE_ROWS)
    end

    # The rows the index held for a path at `at`: its newest WHY_PER_PATH landings at or before it, oldest first.
    def held(path, at)
      list = @by_path[path] or return []
      upto = list.bsearch_index { |r| r[:at] > at } || list.size
      list[[upto - WHY_PER_PATH, 0].max...upto]
    end
  end

  # Definition 12: coordination tokens per take from the colony's counters (`metrics`, nil when not read) and as rebuilt.
  def take_tokens(metrics, rebuilt)
    counted = counted_takes(metrics || {})
    source = if counted then "counters"
             elsif rebuilt && rebuilt[:takes].positive? then "rebuilt"
             end
    { estimate: "tokens = characters / #{CHARS_PER_TOKEN}, an ESTIMATE", source: source, counted: counted, rebuilt: rebuilt }
  end

  # Definition 12 from the coord.* counters (colony/coordtokens.ts), or nil before the first counted take.
  def counted_takes(m)
    n = ->(name) { m[name].is_a?(Numeric) ? m[name].to_f : 0.0 }
    takes = n.("coord.takes")
    return nil unless takes.positive?

    chars = TAKE_PARTS.to_h { |part| [part, n.("coord.chars.#{part}")] }
    heads_up = n.("coord.chars.headsUp")
    at_take = chars.values.sum
    froms = m.keys.filter_map { |k| k[/\Acoord\.byAgents\.(\d+)\.takes\z/, 1]&.to_i }.uniq.sort
    buckets = froms.filter_map do |from|
      t = n.("coord.byAgents.#{from}.takes")
      next unless t.positive?

      { agents: bucket_label(from), from: from, takes: t.to_i, tokensPerTake: tokens(n.("coord.byAgents.#{from}.chars") / t),
        readEverythingTokensPerTake: tokens(n.("coord.byAgents.#{from}.everything") / t) }
    end
    { takes: takes.to_i, perTake: chars.transform_values { |c| tokens(c / takes) }.merge("headsUp" => tokens(heads_up / takes)),
      tokensPerTake: tokens((at_take + heads_up) / takes), atTakeTokensPerTake: tokens(at_take / takes),
      readEverythingTokensPerTake: tokens(n.("coord.everything") / takes), agentsPerTake: rounded(n.("coord.agents") / takes, 1),
      headsUps: n.("coord.headsUps").to_i, byAgents: buckets, flat: flatness(buckets) }
  end

  # Tokens per take in the largest bucket of active agents over the smallest, for what takes hand and for reading everything.
  def flatness(buckets)
    return nil if buckets.size < 2

    a = buckets.first
    b = buckets.last
    { from: a[:agents], to: b[:agents], takes: rounded(ratio(b[:tokensPerTake], a[:tokensPerTake]), 2),
      readEverything: rounded(ratio(b[:readEverythingTokensPerTake], a[:readEverythingTokensPerTake]), 2) }
  end

  # Definition 12 rebuilt: each take in the record with the why-context and last return the colony would have handed it.
  # `rows`: {path:, at:, landing:, intent:, sha:} per landed path; `texts`: intent => {title:, why:}; `whys`: [at, chars]
  # per landed intent; `writes`: proposal id => the paths it wrote.
  def rebuild_takes(record, rows:, texts:, whys:, writes:)
    index = LandedIndex.new(rows)
    landed = whys.sort
    sums = landed.each_with_object([0]) { |(_at, n), acc| acc << (acc.last + n) }
    by_intent = record.proposals.values.group_by { |p| p[:intent] }
    list = record.takes.map do |t|
      upto = landed.bsearch_index { |(at, _n)| at > t[:at] } || landed.size
      { at: t[:at], agent: t[:agent], intent: t[:intent], active: t[:active], context: json_chars(index.context(t[:footprint], t[:at], texts)),
        lastReturn: json_chars(last_return_at(by_intent[t[:intent]] || [], t[:at], writes)), everything: sums[upto] }
    end
    summarize_takes(list).merge(estimatedTimes: record.source == "reconstructed")
  end

  # The last return a take at `at` would have carried for an intent with these proposals (ColonyDO.lastReturn), or nil.
  def last_return_at(props, at, writes)
    props.select { |p| p[:first_at].is_a?(Numeric) && p[:first_at] < at }.sort_by { |p| [-p[:first_at], p[:id].to_s] }.each do |p|
      ev = p[:events].select { |t, _s| t.is_a?(Numeric) && t <= at }.last
      next unless ev
      return nil if ev[1] == "landed"
      next unless %w[returned rejected].include?(ev[1])

      reason = (ev[1] == "returned" ? p[:return_reason] : p[:reason]).to_s.strip
      next if reason.empty? || redirect?(reason)

      paths = writes[p[:id]] || []
      out = { proposalId: p[:id], status: ev[1], at: ev[0], reason: reason.length > RETURN_REASON_CHARS ? "#{reason[0, RETURN_REASON_CHARS - 1]}…" : reason,
              paths: paths.first(RETURN_PATHS) }
      out[:morePaths] = paths.size - RETURN_PATHS if paths.size > RETURN_PATHS
      return out
    end
    nil
  end

  # The rebuilt takes summed: tokens per take, by bucket of active agents, and the counterfactual.
  def summarize_takes(list)
    left_out = "guide lessons, review preview and heads-up cannot be rebuilt from the record, so this is a lower bound"
    return { takes: 0, leftOut: left_out } if list.empty?

    n = list.size.to_f
    per = list.map { |t| t[:context] + t[:lastReturn] }.sort
    buckets = list.group_by { |t| agent_bucket(t[:active]) }.sort.map do |from, ts|
      { agents: bucket_label(from), from: from, takes: ts.size, tokensPerTake: tokens(ts.sum { |t| t[:context] + t[:lastReturn] } / ts.size.to_f),
        readEverythingTokensPerTake: tokens(ts.sum { |t| t[:everything] } / ts.size.to_f) }
    end
    { takes: list.size, perTake: { "context" => tokens(list.sum { |t| t[:context] } / n), "lastReturn" => tokens(list.sum { |t| t[:lastReturn] } / n) },
      tokensPerTake: tokens(per.sum / n), p50: tokens(quantile(per, 0.5)), p90: tokens(quantile(per, 0.9)), max: tokens(per.last),
      readEverythingTokensPerTake: tokens(list.sum { |t| t[:everything] } / n), agentsPerTake: rounded(list.sum { |t| t[:active] } / n, 1),
      byAgents: buckets, flat: flatness(buckets), leftOut: left_out }
  end

  # Definition 13: access by agent kind and by model. `notes`: agent => {kind:, model:} from its notes.
  def access(record, agents, notes = {})
    agents = agents.reject { |a| vaccine?(a) }
    profile = profiles(agents, notes)
    per = Hash.new { |h, k| h[k] = { proposals: 0, landed: 0, returns: 0, escalated: 0, waits: [] } }
    agents.each { |a| per[a["id"]] }
    record.proposals.each_value do |p|
      x = per[p[:agent]]
      x[:proposals] += 1
      x[:returns] += 1 if p[:status] == "returned" && !redirect?(p[:reason])
      x[:escalated] += 1 if p[:events].any? { |_t, s| s == "escalated" }
      next unless p[:status] == "landed" && p[:landed_at].is_a?(Numeric)

      x[:landed] += 1
      made = p[:first_at].is_a?(Numeric) ? p[:first_at] : p[:landed_at]
      claim = record.claims[p[:intent]].select { |t| t <= made }.max || made
      x[:waits] << [(p[:landed_at] - claim) / 1000.0, 0].max
    end
    agent_of = record.proposals.transform_values { |p| p[:agent] }
    cycles = record.landings.sort_by { |l| [l[:at], l[:id].to_s] }.map { |l| l[:proposals].filter_map { |id| agent_of[id] }.to_set }.reject(&:empty?)
    total_landed = per.values.sum { |x| x[:landed] }
    group = lambda do |key|
      per.group_by { |id, _x| key.call(id) }.sort_by { |k, _| k.to_s }.to_h do |name, members|
        ids = members.to_set(&:first)
        xs = members.map(&:last)
        made = xs.sum { |x| x[:proposals] }
        landed = xs.sum { |x| x[:landed] }
        waits = xs.flat_map { |x| x[:waits] }.sort
        top_id, top = members.min_by { |id, x| [-x[:landed], id.to_s] }
        [name, { agents: ids.size, agentShare: rounded(ratio(ids.size, per.size)), landed: landed, landingShare: rounded(ratio(landed, total_landed)),
                 claimToLanding: { p50: rounded(quantile(waits, 0.5), 3), p90: rounded(quantile(waits, 0.9), 3) },
                 proposals: made, returnsPerProposal: rounded(ratio(xs.sum { |x| x[:returns] }, made)), toPerson: rounded(ratio(xs.sum { |x| x[:escalated] }, made)),
                 topAgent: landed.positive? ? { agent: top_id, landed: top[:landed], share: rounded(ratio(top[:landed], landed)) } : nil,
                 nextCycle: next_cycle(cycles, ids) }]
      end
    end
    { agents: per.size, landed: total_landed, cycles: cycles.size,
      all: group.call(->(_id) { "all" })["all"],
      byKind: group.call(->(id) { kind_label(profile.dig(id, :kind)) }),
      byModel: group.call(->(id) { profile.dig(id, :model) || "unknown" }) }
  end

  # Of the landings by agents in `ids` in one cycle, the share whose agent lands again in the next cycle (definition 13).
  def next_cycle(cycles, ids)
    landed = 0
    again = 0
    cycles.each_cons(2) do |a, b|
      mine = a & ids
      landed += mine.size
      again += (mine & b).size
    end
    { landed: landed, again: again, share: rounded(ratio(again, landed)) }
  end

  # Definition 14: each return's reland, per agent kind and return class.
  def relands(record, agents, notes = {})
    profile = profiles(agents.reject { |a| vaccine?(a) }, notes)
    landed = record.proposals.values.select { |p| p[:status] == "landed" && p[:landed_at].is_a?(Numeric) }.group_by { |p| p[:intent] }
    landed.each_value { |list| list.sort_by! { |p| [p[:landed_at], p[:id].to_s] } }
    returns = record.proposals.values.select { |p| p[:status] == "returned" && !redirect?(p[:reason]) && p[:returned_at].is_a?(Numeric) }
    rows = returns.sort_by { |p| [p[:returned_at], p[:id].to_s] }.map do |p|
      after = (landed[p[:intent]] || []).find { |l| l[:landed_at] >= p[:returned_at] }
      { proposal: p[:id], kind: kind_label(profile.dig(p[:agent], :kind)), class: classify(p[:return_reason], human: record.human_returns.include?(p[:id])),
        relanded: !after.nil?, seconds: after && ((after[:landed_at] - p[:returned_at]) / 1000.0), sameAgent: !after.nil? && after[:agent] == p[:agent] }
    end
    summary = lambda do |list|
      secs = list.filter_map { |r| r[:seconds] }.sort
      relanded = list.count { |r| r[:relanded] }
      { returns: list.size, relanded: relanded, rate: rounded(ratio(relanded, list.size)), sameAgent: list.count { |r| r[:sameAgent] },
        p50: rounded(quantile(secs, 0.5), 3), p90: rounded(quantile(secs, 0.9), 3) }
    end
    by = ->(f) { rows.group_by(&f).sort.to_h { |k, list| [k, summary.call(list)] } }
    { all: summary.call(rows), byKind: by.call(->(r) { r[:kind] }), byClass: by.call(->(r) { r[:class] }),
      byKindAndClass: by.call(->(r) { "#{r[:kind]} #{r[:class]}" }) }
  end

  # Definition 15 from the record alone: each certify event's result with its bisect event's first-red answer.
  def certifications_from(record) = record.certify.map { |sha, c| record.bisects[sha] ? c.merge("firstRed" => record.bisects[sha]) : c }

  # Definition 15: where each first-red answer's landing stood among the result's culprit suspects.
  def culprit_precision(certs)
    found = certs.select do |c|
      c.is_a?(Hash) && c["status"] == "red" && c["firstRed"].is_a?(Hash) && c["firstRed"]["status"] == "found" && c["firstRed"]["landingId"]
    end
    rows = found.map do |c|
      fr = c["firstRed"]
      suspects = c["suspects"].is_a?(Array) ? c["suspects"].select { |s| s.is_a?(Hash) } : []
      at = suspects.index { |s| s["landingId"] == fr["landingId"] }
      verdict = if at then "suspect"
                elsif fr["proposals"].is_a?(Array) && fr["proposals"].empty? then "outside the import trace"
                elsif suspects.empty? then "not looked for"
                elsif !fr["proposals"].is_a?(Array) then "closure not recorded"
                else "cut by a limit"
                end
      isolated = fr.dig("isolated", "status") == "isolated" ? fr.dig("isolated", "culprit", "id") : nil
      { trunkSha: c["trunkSha"], landing: fr["landingId"], verdict: verdict, rank: at && (at + 1), suspects: suspects.size, reused: !fr["reusedFrom"].nil?,
        isolated: isolated, isolatedIsSuspect: isolated ? suspects.any? { |s| s["proposalId"] == isolated } : nil }
    end
    counts = rows.map { |r| r[:verdict] }.tally
    ranks = rows.filter_map { |r| r[:rank] }
    isolated = rows.select { |r| r[:isolated] }
    { answers: rows.size, suspect: counts.fetch("suspect", 0), outsideImportTrace: counts.fetch("outside the import trace", 0),
      notLookedFor: counts.fetch("not looked for", 0), cutByLimit: counts.fetch("cut by a limit", 0), closureNotRecorded: counts.fetch("closure not recorded", 0),
      precision: rounded(ratio(counts.fetch("suspect", 0), rows.size)), rank1: rounded(ratio(ranks.count(1), rows.size)),
      ranks: ranks.tally.sort.to_h, meanRank: rounded(ratio(ranks.sum, ranks.size), 2), reused: rows.count { |r| r[:reused] },
      isolated: { answers: isolated.size, suspect: isolated.count { |r| r[:isolatedIsSuspect] } }, list: rows }
  end

  # A count's distribution: mean, p50, p90, max, and how many of each value (4 and more together).
  def count_dist(values)
    s = values.sort
    { n: s.size, mean: rounded(ratio(s.sum, s.size), 2), p50: rounded(quantile(s, 0.5), 3), p90: rounded(quantile(s, 0.9), 3), max: s.last,
      histogram: s.group_by { |v| v >= 4 ? "4+" : v.to_s }.transform_values(&:size).sort.to_h }
  end

  # Definition 16: proposals and review rounds per landed intent, decisions per change, and the intents left open.
  def residue(record)
    rows = record.proposals.values.group_by { |p| p[:intent] }.filter_map do |intent, props|
      l = props.select { |p| p[:landed_at].is_a?(Numeric) }.min_by { |p| [p[:landed_at], p[:id].to_s] }
      next unless l

      tried = props.select { |p| p.equal?(l) || (p[:first_at].is_a?(Numeric) && l[:first_at].is_a?(Numeric) && p[:first_at] < l[:first_at]) }
      declared = record.declared[intent]
      { intent: intent, proposals: tried.size, rounds: tried.sum { |p| record.decisions[p[:id]] },
        declaredToLanded: declared.is_a?(Numeric) ? [(l[:landed_at] - declared) / 1000.0, 0].max : nil }
    end
    waits = rows.filter_map { |r| r[:declaredToLanded] }.sort
    open = record.intents.filter_map do |id, i|
      next unless %w[open claimed proposed].include?(i[:status])

      declared = record.declared[id]
      { intent: id, title: i[:title], status: i[:status], ageSeconds: declared.is_a?(Numeric) && record.last_at ? ((record.last_at - declared) / 1000.0).round(3) : nil }
    end
    ages = open.filter_map { |o| o[:ageSeconds] }.sort
    {
      landedIntents: rows.size, proposalsToLand: count_dist(rows.map { |r| r[:proposals] }), reviewRoundsPerIntent: count_dist(rows.map { |r| r[:rounds] }),
      declaredToLanded: { p50: rounded(quantile(waits, 0.5), 3), p90: rounded(quantile(waits, 0.9), 3) },
      reviewRoundsPerChange: { all: count_dist(record.proposals.keys.map { |id| record.decisions[id] }),
                               landed: count_dist(record.proposals.values.select { |p| p[:status] == "landed" }.map { |p| record.decisions[p[:id]] }) },
      open: { intents: open.size, byStatus: open.map { |o| o[:status] }.tally.sort.to_h, p50AgeSeconds: rounded(quantile(ages, 0.5), 3), maxAgeSeconds: ages.last,
              oldest: open.sort_by { |o| [-(o[:ageSeconds] || 0), o[:intent].to_s] }.first(5) }
    }
  end

  # Definition 17: per model and per agent kind, lines added through landings and alive at HEAD, beside landings,
  # returns, reverts and spend. `landed`: the trunk's landed proposals; `added`: proposal id => lines added; `alive`:
  # agent => lines at HEAD; `returns`: agent => returns; `reverted`: reverted proposal ids; `spend`: model => spend.
  def lines_by_model(landed:, added:, alive:, returns:, reverted:, agents:, spend:, unattributed:)
    notes = landed.group_by(&:agent).transform_values { |ps| { kind: most(ps.map(&:kind)), model: most(ps.map(&:model)) } }
    profile = profiles(agents.reject { |a| vaccine?(a) }, notes, prefer: :notes)
    agent_of = landed.to_h { |p| [p.id, p.agent] }
    group = lambda do |key|
      out = Hash.new { |h, k| h[k] = { landed: 0, added: 0, alive: 0, returns: 0, reverted: 0 } }
      landed.each do |p|
        out[key.call(p.agent)][:landed] += 1
        out[key.call(p.agent)][:added] += added.fetch(p.id, 0)
      end
      alive.each { |agent, n| out[key.call(agent)][:alive] += n }
      returns.each { |agent, n| out[key.call(agent)][:returns] += n }
      reverted.each { |id| out[key.call(agent_of[id])][:reverted] += 1 }
      out.sort_by { |k, _| k.to_s }.to_h { |k, x| [k, x.merge(aliveShare: rounded(ratio(x[:alive], x[:added])))] }
    end
    by_model = group.call(->(agent) { (agent && profile.dig(agent, :model)) || "unknown" })
    by_model.each do |model, x|
      s = spend.is_a?(Hash) ? spend[model] : nil
      x[:spend] = s.is_a?(Hash) ? { usd: s["usd"], input: s["input"], output: s["output"] } : nil
    end
    # Spend under a model no agent names (review models, or an agent listed by its model class): shown apart, never guessed.
    unmatched = spend.is_a?(Hash) ? spend.reject { |m, _x| by_model.key?(m) }.transform_values { |x| x.is_a?(Hash) ? x["usd"] : nil }.sort.to_h : {}
    { byModel: by_model, byKind: group.call(->(agent) { kind_label(agent && profile.dig(agent, :kind)) }), unattributedAdded: unattributed, spendNotMatched: unmatched,
      spendNote: "spend: the model calls this platform made with the model (in-platform agents and review); external agents' own models are not in it" }
  end

  # The markdown row of definition 12.
  def take_tokens_row(t)
    c = t[:source] == "counters" ? t[:counted] : t[:rebuilt]
    return "| Coordination tokens per take (ESTIMATE) | not computed: no take counted or in the record |" if c.nil? || t[:source].nil?

    by = c[:byAgents].map { |b| "#{b[:agents]}: #{dec(b[:tokensPerTake])}" }.join(", ")
    flat = c[:flat] ? "; largest bucket over smallest: ×#{fmt(c[:flat][:takes], 2)} at take, ×#{fmt(c[:flat][:readEverything], 2)} to read everything" : ""
    p = c[:perTake]
    if t[:source] == "counters"
      "| Coordination tokens per take (ESTIMATE, chars / #{CHARS_PER_TOKEN}) | #{dec(c[:atTakeTokensPerTake])} at take (why-context #{dec(p['context'])}, " \
        "guide #{dec(p['guide'])}, last return #{dec(p['lastReturn'])}, review #{dec(p['review'])}) and #{dec(p['headsUp'])} of heads-up, over " \
        "#{many(c[:takes], 'take')} with #{dec(c[:agentsPerTake])} agents active on average; reading everything #{dec(c[:readEverythingTokensPerTake])}; " \
        "by active agents #{by}#{flat} |"
    else
      "| Coordination tokens per take (ESTIMATE, rebuilt) | #{dec(c[:tokensPerTake])} (why-context #{dec(p['context'])}, last return " \
        "#{dec(p['lastReturn'])}; p90 #{dec(c[:p90])}) over #{many(c[:takes], 'take')} in the record, a lower bound (no guide, review or heads-up); " \
        "reading everything #{dec(c[:readEverythingTokensPerTake])}; by active agents #{by}#{flat} |"
    end
  end

  # The markdown rows of definition 13: by kind, and by model (the six with the most landings).
  def access_rows(a)
    cell = lambda do |name, g|
      top = g[:topAgent] ? ", top agent #{pct(g[:topAgent][:share])}" : ""
      "#{name} #{pct(g[:agentShare])} of agents, #{pct(g[:landingShare])} of landings, claim to landing p50 #{dec(g[:claimToLanding][:p50])} s " \
        "p90 #{dec(g[:claimToLanding][:p90])} s, #{fmt(g[:returnsPerProposal], 2)} returns a proposal, #{pct(g[:toPerson])} to a person#{top}, " \
        "next cycle #{pct(g[:nextCycle][:share])}"
    end
    models = a[:byModel].sort_by { |m, g| [-g[:landed], m.to_s] }.first(6)
    more = a[:byModel].size > 6 ? " · #{a[:byModel].size - 6} more models in the JSON" : ""
    ["| Access by agent kind | #{a[:byKind].map { |k, g| cell.call(k, g) }.join(' · ')} |",
     "| Access by model | #{models.map { |m, g| cell.call(m, g) }.join(' · ')}#{more} |"]
  end

  # The markdown row of definition 14.
  def relands_row(r)
    a = r[:all]
    return "| Return to reland | no returns |" if a[:returns].zero?

    part = ->(h) { h.map { |k, s| "#{k.tr('_', ' ')} #{num(s[:relanded])}/#{num(s[:returns])}" }.join(", ") }
    "| Return to reland | #{num(a[:relanded])} of #{many(a[:returns], 'return')} relanded (#{pct(a[:rate])}, #{num(a[:sameAgent])} by the same agent), " \
      "p50 #{dec(a[:p50])} s, p90 #{dec(a[:p90])} s; by kind #{part.call(r[:byKind])}; by cause #{part.call(r[:byClass])} |"
  end

  # The markdown row of definition 15.
  def culprit_row(c)
    return "| Culprit precision against first red | no first-red answer found a commit (#{c[:source]}) |" if c[:answers].zero?

    ranks = c[:ranks].map { |r, n| "rank #{r}: #{n}" }.join(", ")
    "| Culprit precision against first red | #{num(c[:suspect])} of #{many(c[:answers], 'first-red answer')} among the suspects " \
      "(#{pct(c[:precision])}#{ranks.empty? ? '' : "; #{ranks}"}), #{num(c[:outsideImportTrace])} outside the import trace, " \
      "#{num(c[:cutByLimit])} in the closure but cut by a limit, #{num(c[:notLookedFor])} with no suspects#{c[:closureNotRecorded].positive? ? ", #{num(c[:closureNotRecorded])} closure not recorded" : ''} (#{c[:source]}) |"
  end

  # The markdown row of definition 16.
  def residue_row(r)
    o = r[:open]
    oldest = o[:maxAgeSeconds] ? ", the oldest #{dec(o[:maxAgeSeconds])} s old" : ""
    "| Residue and review rounds | #{many(r[:landedIntents], 'landed intent')}: #{fmt(r[:proposalsToLand][:mean], 2)} proposals to land " \
      "(p90 #{dec(r[:proposalsToLand][:p90])}), #{fmt(r[:reviewRoundsPerIntent][:mean], 2)} review rounds; declared to landed p50 " \
      "#{dec(r[:declaredToLanded][:p50])} s, p90 #{dec(r[:declaredToLanded][:p90])} s; #{fmt(r[:reviewRoundsPerChange][:all][:mean], 2)} review rounds a change; " \
      "#{many(o[:intents], 'intent')} still open#{oldest} |"
  end

  # The markdown row of definition 17 (the six models with the most lines added).
  def lines_row(l)
    models = l[:byModel].sort_by { |m, x| [-x[:added], m.to_s] }.first(6).map do |m, x|
      usd = x[:spend] && x[:spend][:usd] ? format(", $%.4f", x[:spend][:usd]) : ""
      "#{m} #{num(x[:alive])} of #{num(x[:added])} added lines alive (#{pct(x[:aliveShare])}), #{many(x[:landed], 'landing')}, " \
        "#{many(x[:returns], 'return')}, #{num(x[:reverted])} reverted#{usd}"
    end
    "| Lines alive on trunk by model | #{models.join(' · ')}#{l[:unattributedAdded].positive? ? "; #{num(l[:unattributedAdded])} added lines unattributed" : ''} |"
  end

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

  # Definition 8: where each landed intent's time went, the totals and medians per phase, and the critical path behind
  # the run's last landing.
  def time_split(record)
    rows = record.proposals.values.group_by { |p| p[:intent] }.filter_map { |intent, props| intent_time(intent, props, record) }
    rows.sort_by! { |r| [r[:landedAt], r[:intent].to_s] }
    totals = PHASES.to_h { |k| [k, rows.sum { |r| r[k] }] }
    all = totals.values.sum
    {
      landedIntents: rows.size,
      estimatedClaims: record.source == "reconstructed",
      note: record.source == "reconstructed" ? "claim times are estimated (a reconstructed record), so agent work, rework and the totals are too" : nil,
      noClaim: rows.count { |r| !r[:claimed] },
      agentSeconds: totals.transform_values { |v| rounded(v, 3) }.merge(total: rounded(all, 3)),
      share: totals.transform_values { |v| rounded(ratio(v, all)) },
      median: PHASES.to_h { |k| [k, rounded(median(rows.map { |r| r[k] }), 3)] },
      waitingShare: rounded(ratio(totals[:waitingToLand], all)),
      criticalPath: critical_path(rows, record),
      perIntent: rows.map do |r|
        r.merge(PHASES.to_h { |k| [k, rounded(r[k], 3)] }).merge(total: rounded(r[:total], 3), reworkParts: r[:reworkParts].transform_values { |v| rounded(v, 3) })
      end
    }
  end

  # One landed intent's phases (definition 8), or nil when none of its proposals landed.
  def intent_time(intent, props, record)
    landed = props.select { |p| p[:landed_at].is_a?(Numeric) && p[:first_at].is_a?(Numeric) }.min_by { |p| [p[:landed_at], p[:id].to_s] }
    return nil unless landed

    earlier = props.select { |p| !p.equal?(landed) && p[:first_at].is_a?(Numeric) && p[:first_at] < landed[:first_at] }
    first_proposal = ([landed[:first_at]] + earlier.map { |p| p[:first_at] }).min
    claims = record.claims[intent].select { |t| t <= first_proposal }.sort
    # The points the phases run between, in order: a point clock skew put earlier than the one before moves up to it.
    claimed = claims.first || first_proposal
    last_claim = [claims.last || first_proposal, claimed].max
    first = [first_proposal, last_claim].max
    start = [landed[:first_at], first].max
    landed_at = [landed[:landed_at], start].max
    ready = review_end(landed, record).clamp(start, landed_at)
    came_back = covered(earlier.map { |p| [p[:first_at], [p[:at], p[:first_at]].max] }, first, start)
    {
      intent: intent, title: record.intents.dig(intent, :title), proposal: landed[:id], agent: landed[:agent], claimed: !claims.empty?,
      proposals: earlier.size + 1, claimedAt: claimed, firstProposalAt: first, landingProposalAt: start, readyAt: ready, landedAt: landed_at,
      agentWork: (first - last_claim) / 1000.0, review: (ready - start) / 1000.0, waitingToLand: (landed_at - ready) / 1000.0,
      rework: ((last_claim - claimed) + (start - first)) / 1000.0,
      reworkParts: { givenBack: (last_claim - claimed) / 1000.0, cameBack: came_back / 1000.0, toNextProposal: (start - first - came_back) / 1000.0 },
      total: (landed_at - claimed) / 1000.0
    }
  end

  # When review let a landing proposal go: a person's decision when it was escalated (else its first ready after the
  # escalation), otherwise its first ready event; its landing when the record holds neither.
  def review_end(p, record)
    events = p[:events].select { |at, _s| at.is_a?(Numeric) }
    escalated = events.filter_map { |at, s| at if s == "escalated" }.max
    if escalated
      decided = record.human_decisions[p[:id]].select { |t| t >= escalated }.min
      return decided if decided
    end
    from = escalated || p[:first_at]
    events.find { |at, s| s == "ready" && at >= from }&.first || p[:landed_at]
  end

  # Milliseconds of [from, to] that the intervals cover, each counted once.
  def covered(intervals, from, to)
    spans = intervals.map { |a, b| [[a, from].max, [b, to].min] }.select { |a, b| b > a }.sort
    total = 0
    reach = from
    spans.each do |a, b|
      total += b - [a, reach].max if b > reach
      reach = [reach, b].max
    end
    total
  end

  # The critical path behind the run's last landing (definition 8), or nil when no landing carried a landed intent.
  def critical_path(rows, record)
    by_proposal = rows.to_h { |r| [r[:proposal], r] }
    last = record.landings.select { |l| l[:proposals].any? { |id| by_proposal.key?(id) } }.max_by { |l| [l[:at], l[:id].to_s] }
    return nil unless last

    pick = last[:proposals].filter_map { |id| by_proposal[id] }.max_by { |r| [r[:readyAt], -r[:claimedAt], r[:intent].to_s] }
    since = ->(t) { t && record.first_at ? rounded((t - record.first_at) / 1000.0, 3) : nil }
    proposals = record.proposals.values.select { |p| p[:intent] == pick[:intent] && p[:first_at].is_a?(Numeric) && p[:first_at] <= pick[:landingProposalAt] }
    steps = []
    steps << { step: "declared", at: since.(record.declared[pick[:intent]]) } if record.declared[pick[:intent]].is_a?(Numeric)
    record.claims[pick[:intent]].select { |t| t <= pick[:landedAt] }.sort.each { |t| steps << { step: "claimed", at: since.(t) } }
    proposals.sort_by { |p| [p[:first_at], p[:id].to_s] }.each do |p|
      mine = p[:id] == pick[:proposal]
      step = { step: "proposal", proposal: p[:id], agent: p[:agent], at: since.(p[:first_at]), until: since.(mine ? pick[:readyAt] : p[:at]),
               outcome: mine ? "ready" : p[:status], landed: mine }
      if !mine && p[:status] == "returned"
        step[:class] = redirect?(p[:return_reason]) ? "redirected" : classify(p[:return_reason], human: record.human_returns.include?(p[:id]))
      end
      steps << step
    end
    steps << { step: "lane and trunk writer", at: since.(pick[:readyAt]), until: since.(pick[:landedAt]), seconds: rounded(pick[:waitingToLand], 3),
               note: "from ready to landed: the record does not split the lane's wait from the trunk writer's cycle" }
    {
      landing: last[:id], at: since.(last[:at]), changesInLanding: last[:proposals].size, intent: pick[:intent], title: pick[:title],
      proposal: pick[:proposal], agent: pick[:agent], proposals: pick[:proposals], estimatedClaims: record.source == "reconstructed",
      phases: PHASES.to_h { |k| [k, rounded(pick[k], 3)] }, total: rounded(pick[:total], 3), steps: steps
    }
  end

  def fmt(x, digits = 3) = x.nil? ? "n/a" : format("%.#{digits}f", x)

  def num(n) = n.to_i.to_s.reverse.scan(/\d{1,3}/).join(",").reverse

  # "1 return", "2 returns".
  def many(n, word) = "#{num(n)} #{word}#{n == 1 ? "" : "s"}"

  # 1234.56 as "1,234.6".
  def dec(x, digits = 1)
    return "n/a" if x.nil?

    whole, frac = format("%.#{digits}f", x).split(".")
    frac ? "#{num(whole.to_i)}.#{frac}" : num(whole.to_i)
  end

  def pct(x) = x.nil? ? "n/a" : format("%.1f%%", x * 100)

  # The markdown rows of definition 8.
  def time_rows(t)
    return ["| Where the time went | no landed intent in the record |"] if t[:landedIntents].zero?

    a = t[:agentSeconds]
    labels = { agentWork: "agent work", review: "review", waitingToLand: "waiting to land", rework: "rework" }
    parts = labels.map { |k, label| "#{label} #{dec(a[k])} (#{pct(t[:share][k])}, median #{dec(t[:median][k])} s)" }
    estimated = t[:estimatedClaims] ? "; claim times estimated (reconstructed record)" : ""
    no_claim = t[:noClaim].positive? ? "; #{many(t[:noClaim], 'intent')} with no claim in the record" : ""
    rows = ["| Where the time went | #{dec(a[:total])} agent-seconds over #{many(t[:landedIntents], 'landed intent')}, from claim to landing: " \
            "#{parts.join(', ')}; #{pct(t[:waitingShare])} of agent time waiting to land#{estimated}#{no_claim} |"]
    c = t[:criticalPath]
    return rows unless c

    claimed = c[:steps].find { |s| s[:step] == "claimed" }
    back = c[:steps].select { |s| s[:step] == "proposal" && !s[:landed] }
    back_text = back.empty? ? "" : ", #{num(back.size)} came back (#{back.map { |s| (s[:class] || s[:outcome]).to_s.tr('_', ' ') }.join(', ')})"
    title = c[:title] ? " (#{c[:title].to_s.gsub(/[|\r\n]+/, ' ')[0, 80]})" : ""
    claim_text = claimed ? "claimed at +#{dec(claimed[:at])} s#{c[:estimatedClaims] ? ' (estimated)' : ''}" : "no claim in the record"
    p = c[:phases]
    rows << "| Critical path to the last landing | `#{c[:intent]}`#{title} landed at +#{dec(c[:at])} s in #{c[:landing]} " \
            "(#{many(c[:changesInLanding], 'change')}): #{claim_text}, #{many(c[:proposals], 'proposal')}#{back_text}; agent work #{dec(p[:agentWork])} s, " \
            "rework #{dec(p[:rework])} s, review #{dec(p[:review])} s, ready to landed #{dec(p[:waitingToLand])} s (the lane and the trunk " \
            "writer together); #{dec(c[:total])} s from claim to landing |"
    rows
  end

  # "1 min 37 s": a gap as a person reads it.
  def gap_text(ms)
    s = (ms / 1000.0).round
    return "#{s} s" if s < 60

    m, rest = s.divmod(60)
    return rest.zero? ? "#{m} min" : "#{m} min #{rest} s" if m < 60

    h, m = m.divmod(60)
    m.zero? ? "#{h} h" : "#{h} h #{m} min"
  end

  # The markdown row of definition 10.
  def closure_row(c)
    before = c[:beforeLedger].positive? ? "; #{many(c[:beforeLedger], 'close')} recorded before the ledger, in no share" : ""
    return "| Closures | none recorded#{before} |" if c[:closures].zero?

    kinds = c[:byKind].map do |kind, k|
      label = { "internal" => "in-platform", "external" => "external", "synthetic" => "synthetic" }.fetch(kind, kind)
      "#{label} #{num(k[:total])} (#{k[:counts].map { |cause, n| "#{cause.tr('_', ' ')} #{num(n)}, #{pct(k[:shares][cause])}" }.join('; ')})"
    end
    rp = c[:reaped]
    reaped = if rp[:count].zero? then "none taken back from a silent agent"
             elsif rp[:medianGapMs] then "#{many(rp[:count], 'intent')} taken back from silent agents, median gap #{gap_text(rp[:medianGapMs])} (largest #{gap_text(rp[:maxGapMs])})"
             else "#{many(rp[:count], 'intent')} taken back from silent agents"
             end
    "| Closures | #{num(c[:closures])} recorded: #{kinds.join(' · ')}; #{reaped}#{before} |"
  end

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
    if (a = r[:answerable]) && a[:landings].positive?
      out << "| No person answerable | #{num(a[:none])} of #{many(a[:landings], "landing")} read from notes (#{fmt(a[:noneShare])}); " \
             "#{num(a[:person])} a person answers for, #{num(a[:unknown])} unknown (notes from before who asked was recorded) |"
    end
    out.concat(r[:timeSplit] ? time_rows(r[:timeSplit]) : ["| Where the time went | not computed: no event record |"])
    out << closure_row(r[:closures]) if r[:closures]
    heads_up = heads_up_row(r[:headsUp])
    out << heads_up if heads_up
    out << take_tokens_row(r[:takeTokens]) if r[:takeTokens]
    out.concat(access_rows(r[:access])) if r[:access]
    out << relands_row(r[:relands]) if r[:relands]
    out << culprit_row(r[:culpritPrecision]) if r[:culpritPrecision]
    out << residue_row(r[:residue]) if r[:residue]
    out << lines_row(r[:linesByModel]) if r[:linesByModel]
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
