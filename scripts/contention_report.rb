# frozen_string_literal: true

# The contention smoke test's numbers (scripts/contention.rb), computed only from what one run's colony recorded: its
# event record (GET /api/colonies/<id>/events), its proposals (GET .../proposals/<pid>: base commit, read and write
# sets), its certification results (GET .../certifications), its agents and their counters, and its metrics with the
# model spend. Pure: no I/O, so the tests feed it a fixture record.
#
# Definitions (the spec intents are the intents the script declared; the seed, repair and grading intents are not)
#
# Concurrency. Spec intents held at once (claimed or proposed, from the intent events): the peak, and the mean over
#   time from the release to the end. The take path keeps agents off files another agent holds (lateral inhibition,
#   unless FT_LATERAL_INHIBITION is off), and every intent here writes the shared module, so this says whether the
#   agents contended at all or were held to one intent at a time.
# Returns by cause. A proposal's status is the status of its last event. A returned proposal is classed by its reason
#   as scripts/coordination.rb classes it (definition 4, the same code): text-merge conflict, stale read (a file it
#   read, wrote or imports changed under it), rule (a review return naming a rule violation), review (the review arc
#   or a person returned it), other. Returns for a change of direction (withdrawn, revised, superseded) are redirects,
#   counted apart. "other" is broken down by the reason's first words (tests before landing, the guards, ...).
# Cause-repeat rate. For each return of a spec intent's proposal that the intent's next proposal followed and that next
#   one settled (landed, returned or rejected): a repeat when the next one came back for the same cause. Rate = repeats
#   over those returns, overall and per cause.
# Rounds and model calls to land. Rounds: the proposals a landed intent made up to and including the first that landed.
#   Model calls: the calls the colony counted for the intent (FT_INTENT_SPEND, every layer: its agents and review);
#   null without that flag. By cause: over the landed intents with at least one return of a cause before landing, and
#   over those with none ("first try").
# Red-trunk episodes. Certification results that are green or red, in the order they finished. An episode starts at a
#   red result after a green one (the seed's own green certification is the first) and ends at the next green result:
#   time to green is the time between the two results. Landings during it are the landings recorded between them.
# Semantic-conflict pairs that landed. For each episode whose first red search found the commit (FT_BISECT), the
#   culprit: the proposal isolation named, else the proposals of the first-red landing that touched what the failing
#   tests load; without a search, the newest suspect (FT_CULPRITS), else the red commit's own landing. A partner of
#   the culprit is (a) a spec intent that landed earlier and wrote a failing test file (the culprit broke another
#   intent's tests), or (b) a landing between the culprit's base commit and its own landing that wrote a file the
#   culprit read or wrote (the culprit was merged or revalidated over it), listed only when (a) finds none. The culprit
#   and its partners make one pair per episode: both landed, tests red after the second. The partners of (b) are
#   candidates (any of them may be the one), so a designed pair counts as found when its partner is among them. An
#   episode with no partner is the culprit's own mistake.
# Designed pairs. The spec's pairs (a signature change and an intent built on the old signature): whether both
#   landed, in which order, whether the second was built before the first landed, the first certification at or
#   after the second landing, whether an observed pair matched it, and the hidden tests' grade of both.
# Human queue. Proposals escalated to a person (a held merge when its reason is a merge lock's), agents' reports on
#   intents (escalation events), and stuck-work items, each with its time in the queue: from its opening event to the
#   next event that closes it, or to the end of the run while it still waits. This build keeps no audit queue.
# Spend. The model calls this platform made for the colony, as its metrics price them (Workers AI list prices): total,
#   by layer and by model; the in-platform agents' calls per model from their counters; review calls from the
#   per-intent counts (FT_INTENT_SPEND). Per landed intent: the total over the spec intents landed.
require "json"
require "set"
require_relative "coordination"

module ContentionReport
  CAUSES = %w[stale text_merge review rule other].freeze
  CAUSE_LABELS = { "stale" => "stale read", "text_merge" => "text-merge conflict", "review" => "review", "rule" => "rule", "other" => "other" }.freeze
  SETTLED = %w[landed returned rejected].freeze
  # An intent an agent holds.
  HELD = %w[claimed proposed].freeze
  # A held merge's reason starts with one of these (worker trunk/mergelock.ts OPENERS).
  HOLD = /\A(?:A person approved this change|This change has a danger pattern a person must see and was decided|This change writes a protected path and was decided) against an older trunk; trunk has since changed /
  # "other" returns by their reason's first words.
  OTHER_KINDS = [
    [/\ATests before landing:/, "tests before landing"],
    [/\Ahead commit changed while its tests ran/, "tests before landing (trunk moved)"],
    [/export|stops exporting/i, "export guard"],
    [/delet/i, "deletion guard"],
    [/rejected|reject/i, "rejected"]
  ].freeze

  module_function

  def median(values)
    v = values.compact.sort
    return nil if v.empty?

    v.size.odd? ? v[v.size / 2] : (v[(v.size / 2) - 1] + v[v.size / 2]) / 2.0
  end

  def ratio(num, den) = den.to_f.positive? ? (num.to_f / den).round(4) : nil

  def secs(ms) = ms.nil? ? nil : (ms / 1000.0).round(1)

  # The cause of a returned proposal (coordination.rb definition 4).
  def cause(reason, human: false) = Coordination.classify(reason, human: human)

  def redirect?(reason) = Coordination.redirect?(reason)

  # A label for an "other" return.
  def other_kind(reason)
    text = reason.to_s
    OTHER_KINDS.each { |re, label| return label if re.match?(text) }
    words = text.split(/[:;(.]/).first.to_s.strip
    words.empty? ? "no reason given" : words[0, 60]
  end

  # Build every number of one run. `input` keys: spec_intents ({colony intent id => {id:, title:, change:, footprint:}}),
  # pairs (the spec's pairs), events, proposals ({pid => proposal}), certifications, agents, metrics, snapshot,
  # release_at and end_at (colony ms), grade (or nil).
  def build(input)
    r = Run.new(input)
    {
      intents: r.intents,
      concurrency: r.concurrency,
      returns: r.returns,
      cause_repeat: r.cause_repeat,
      rounds: r.rounds,
      red: r.red,
      semantic: r.semantic,
      human_queue: r.human_queue,
      spend: r.spend,
      wall: r.wall
    }
  end

  # One run's record, indexed once.
  class Run
    def initialize(input)
      @spec = input.fetch(:spec_intents)
      @pairs = Array(input[:pairs])
      @details = input[:proposals] || {}
      @certs_in = Array(input[:certifications])
      @agents = Array(input[:agents])
      @metrics = input[:metrics] || {}
      @snapshot = input[:snapshot] || {}
      @release_at = input[:release_at]
      @end_at = input[:end_at]
      @grade = input[:grade]
      @events = Array(input[:events]).each_with_index.sort_by { |e, i| [e["seq"] || i, i] }.map(&:first)
      index
    end

    # --- intents ---------------------------------------------------------------------------------------------------

    def intents
      rows = @spec.map { |iid, s| intent_row(iid, s) }
      landed = rows.count { |r| r[:status] == "landed" }
      { total: rows.size, landed: landed, not_landed: rows.reject { |r| r[:status] == "landed" }.map { |r| r[:id] }, per_intent: rows }
    end

    def intent_row(iid, s)
      props = @by_intent[iid]
      first_landed = props.index { |p| p[:status] == "landed" }
      before = first_landed ? props[0...first_landed] : props
      returns = before.select { |p| returned?(p) }
      calls = intent_calls(iid)
      {
        id: s[:id], intent: iid, title: s[:title], change: s[:change] || "adds",
        status: intent_status(iid), proposals: props.size,
        rounds: first_landed && (first_landed + 1),
        returns: returns.map { |p| p[:cause] }.tally,
        model_calls: calls,
        usd: intent_usd(iid),
        landed_at_s: first_landed && since_release(props[first_landed][:landed_at]),
        hidden: @grade && @grade.dig(:files, s[:id])
      }
    end

    # --- concurrency -----------------------------------------------------------------------------------------------

    # How many spec intents were held at once (claimed or proposed), from the record's intent events: the peak and the
    # time-weighted mean from the release to the end. One at a time with many agents means the take path held them
    # apart (lateral inhibition on the shared file) rather than letting them contend. With the intents the colony or
    # its agents declared on their own (a megafile split, an agent's follow-up), by source and status.
    def concurrency
      state = {}
      count = 0
      peak = 0
      area = 0.0
      last = @release_at
      @events.each do |e|
        next unless e["t"] == "intent" && @spec.key?(e["intentId"]) && e["at"].is_a?(Numeric)

        if last && e["at"] > last
          area += count * (e["at"] - last)
          last = e["at"]
        end
        was = HELD.include?(state[e["intentId"]])
        now = HELD.include?(e["status"])
        count += 1 if now && !was
        count -= 1 if was && !now
        state[e["intentId"]] = e["status"]
        peak = count if count > peak
      end
      area += count * (@end_at - last) if last && @end_at && @end_at > last
      span = @release_at && @end_at ? @end_at - @release_at : nil
      own = Array(@snapshot["intents"]).select { |i| %w[system agent].include?(i["source"]) && !@spec.key?(i["id"]) }
      { peak_in_flight: peak, mean_in_flight: span&.positive? ? (area / span).round(2) : nil,
        colony_intents: own.group_by { |i| i["source"] }.transform_values { |l| l.map { |i| i["status"] }.tally } }
    end

    # --- returns ---------------------------------------------------------------------------------------------------

    def returns
      ours = spec_props
      back = ours.select { |p| p[:status] == "returned" }
      redirects = back.count { |p| redirect?(p[:reason]) }
      counted = back.reject { |p| redirect?(p[:reason]) }
      by = CAUSES.to_h { |c| [c, counted.count { |p| p[:cause] == c }] }
      other = counted.select { |p| p[:cause] == "other" }.map { |p| ContentionReport.other_kind(p[:reason]) }.tally
      {
        proposals: ours.size, landed: ours.count { |p| p[:status] == "landed" }, returned: counted.size, redirects: redirects,
        rejected: ours.count { |p| p[:status] == "rejected" }, escalated_now: ours.count { |p| p[:status] == "escalated" },
        in_flight: ours.count { |p| %w[pending checking ready].include?(p[:status]) },
        by_cause: by, labels: CAUSE_LABELS, other: other.sort_by { |k, v| [-v, k] }.to_h
      }
    end

    def cause_repeat
      eligible = Hash.new(0)
      repeats = Hash.new(0)
      @spec.each_key do |iid|
        props = @by_intent[iid]
        props.each_cons(2) do |p, n|
          next unless returned?(p) && SETTLED.include?(n[:status])

          eligible[p[:cause]] += 1
          repeats[p[:cause]] += 1 if returned?(n) && n[:cause] == p[:cause]
        end
      end
      total = eligible.values.sum
      {
        rate: ContentionReport.ratio(repeats.values.sum, total), repeats: repeats.values.sum, eligible: total,
        by_cause: CAUSES.to_h { |c| [c, { repeats: repeats[c], eligible: eligible[c], rate: ContentionReport.ratio(repeats[c], eligible[c]) }] }
      }
    end

    # --- rounds and calls ------------------------------------------------------------------------------------------

    def rounds
      landed = intents[:per_intent].select { |r| r[:status] == "landed" && r[:rounds] }
      group = lambda do |rows|
        { intents: rows.size, median_rounds: ContentionReport.median(rows.map { |r| r[:rounds] }), median_calls: ContentionReport.median(rows.map { |r| r[:model_calls] }),
          rounds: rows.sum { |r| r[:rounds] }, calls: rows.all? { |r| r[:model_calls] } ? rows.sum { |r| r[:model_calls] } : nil }
      end
      by = CAUSES.to_h { |c| [c, group.call(landed.select { |r| r[:returns][c].to_i.positive? })] }
      by["first try"] = group.call(landed.select { |r| r[:returns].empty? })
      {
        landed: landed.size, median_rounds: ContentionReport.median(landed.map { |r| r[:rounds] }), max_rounds: landed.map { |r| r[:rounds] }.max,
        median_calls: ContentionReport.median(landed.map { |r| r[:model_calls] }), calls_counted: landed.any? { |r| r[:model_calls] },
        by_cause: by
      }
    end

    # --- red trunk -------------------------------------------------------------------------------------------------

    def red
      episodes = []
      state = "green"
      @certs.each do |c|
        if c[:status] == "red" && state != "red"
          episodes << { start: c, end: nil }
          state = "red"
        elsif c[:status] == "green" && state == "red"
          episodes.last[:end] = c
          state = "green"
        end
      end
      rows = episodes.map { |e| episode_row(e) }
      repairs = Array(@snapshot["intents"]).select { |i| i["source"] == "certify" }
      closed = rows.select { |r| r[:time_to_green_s] }
      {
        certifications: @certs.size, red_results: @certs.count { |c| c[:status] == "red" }, errors: @certs_all.count { |c| %w[error skipped].include?(c[:status]) },
        episodes: rows.size, open_at_end: rows.count { |r| r[:time_to_green_s].nil? },
        median_time_to_green_s: ContentionReport.median(closed.map { |r| r[:time_to_green_s] }),
        max_time_to_green_s: closed.map { |r| r[:time_to_green_s] }.max,
        time_red_s: rows.sum { |r| r[:time_red_s].to_f }.round(1),
        repair_intents: { declared: repairs.size, landed: repairs.count { |i| i["status"] == "landed" } },
        list: rows
      }
    end

    def episode_row(e)
      s = e[:start]
      f = e[:end]
      till = f ? f[:at] : @end_at
      during = @landings.count { |l| l[:at] && l[:at] > s[:at] && (till.nil? || l[:at] <= till) }
      culprit = culprit_of(s)
      {
        red_sha: s[:sha], red_at_s: since_release(s[:at]), failing: failing_files(s),
        green_sha: f && f[:sha], time_to_green_s: f && ContentionReport.secs(f[:at] - s[:at]),
        time_red_s: till && ContentionReport.secs(till - s[:at]), landings_during: during,
        culprit: culprit && culprit.merge(proposals: culprit[:proposals].map { |pid| { id: pid, intent: spec_id(@prop_intent[pid]) || @prop_intent[pid] } })
      }
    end

    # --- semantic-conflict pairs -----------------------------------------------------------------------------------

    def semantic
      observed = []
      own = 0
      red[:list].each_with_index do |ep, i|
        start = @certs.select { |c| c[:status] == "red" }.find { |c| c[:sha] == ep[:red_sha] }
        culprit = start && culprit_of(start)
        next unless culprit

        found = false
        culprit[:proposals].each do |pid|
          second = @prop_intent[pid]
          next unless @spec.key?(second)

          partners = partners_of(pid, start)
          next if partners.empty?

          found = true
          firsts = partners.map { |pa| spec_id(pa[:intent]) }
          observed << { second: spec_id(second), first: firsts, how: partners.first[:how], episode: i + 1, red_sha: ep[:red_sha],
                        culprit_by: culprit[:by], failing: ep[:failing], designed: firsts.find { |f| designed?(f, spec_id(second)) } }
        end
        own += 1 unless found
      end
      observed.uniq! { |o| [o[:second], o[:episode]] }
      { pairs_landed: observed.size, observed: observed, own_mistakes: own, designed: designed_rows(observed) }
    end

    def designed_rows(observed)
      @pairs.map do |pair|
        f = intent_by_spec(pair["first"])
        s = intent_by_spec(pair["second"])
        fl = f && landing_of_intent(f)
        sl = s && landing_of_intent(s)
        row = { first: pair["first"], second: pair["second"], first_landed: !fl.nil?, second_landed: !sl.nil? }
        if fl && sl
          later, earlier = sl[:index] >= fl[:index] ? [sl, fl] : [fl, sl]
          row[:landed_second] = later.equal?(sl) ? pair["second"] : pair["first"]
          base = base_index(later[:proposal])
          row[:second_built_before_first_landed] = base.nil? ? nil : base < earlier[:index]
          cert = @certs.find { |c| (idx = landing_index(c)) && idx >= later[:index] }
          row[:next_certification] = cert && cert[:status]
          row[:found_as_pair] = observed.any? { |o| (o[:second] == pair["second"] && o[:first].include?(pair["first"])) || (o[:second] == pair["first"] && o[:first].include?(pair["second"])) }
        end
        if @grade
          row[:hidden_first] = @grade.dig(:files, pair["first"])
          row[:hidden_second] = @grade.dig(:files, pair["second"])
        end
        row
      end
    end

    # --- human queue -----------------------------------------------------------------------------------------------

    def human_queue
      items = []
      @prop_events.each do |pid, evs|
        next unless @spec.key?(@prop_intent[pid])

        evs.each_with_index do |e, i|
          next unless e["status"] == "escalated" && (i.zero? || evs[i - 1]["status"] != "escalated")

          closed = evs[(i + 1)..].find { |x| x["status"] != "escalated" }
          items << { kind: HOLD.match?(e["reason"].to_s) ? "held merge" : "review escalation", subject: pid, intent: spec_id(@prop_intent[pid]),
                     opened_at: e["at"], closed_at: closed && closed["at"], answer: closed && closed["status"] }
        end
      end
      open = {}
      @events.each do |e|
        next unless e["t"] == "escalation"

        if e["resolved"]
          o = open.delete(e["intentId"])
          o[:closed_at] = e["at"] if o
          o[:answer] = e.dig("resolved", "decision") if o
        else
          item = { kind: "agent report", subject: e["intentId"], intent: spec_id(e["intentId"]) || e["intentId"], report_kind: e["kind"], opened_at: e["at"], closed_at: nil }
          open[e["intentId"]] = item
          items << item
        end
      end
      stuck = @events.select { |e| e["t"] == "stuck" }.map { |e| e.dig("item", "kind") || "unknown" }.tally
      waits = items.map { |it| ((it[:closed_at] || @end_at || it[:opened_at]) - it[:opened_at]) / 1000.0 }
      {
        escalations: items.count { |it| it[:kind] == "review escalation" }, held_merges: items.count { |it| it[:kind] == "held merge" },
        agent_reports: items.count { |it| it[:kind] == "agent report" }, stuck: stuck,
        audit_items: nil, audit_note: "this build keeps no audit queue",
        total: items.size, waiting_at_end: items.count { |it| it[:closed_at].nil? },
        median_time_in_queue_s: ContentionReport.median(waits)&.round(1), max_time_in_queue_s: waits.max&.round(1),
        items: items.map { |it| it.merge(opened_at_s: since_release(it[:opened_at]), time_in_queue_s: (((it[:closed_at] || @end_at || it[:opened_at]) - it[:opened_at]) / 1000.0).round(1)).except(:opened_at, :closed_at) }
      }
    end

    # --- spend -----------------------------------------------------------------------------------------------------

    def spend
      s = @metrics["spend"].is_a?(Hash) ? @metrics["spend"] : {}
      calls = Hash.new(0)
      agents = Hash.new(0)
      @agents.each do |a|
        next unless a["kind"].nil? || a["kind"] == "internal"

        model = a["model"] || "?"
        c = a["counters"].is_a?(Hash) ? a["counters"] : {}
        agents[model] += 1
        calls[model] += c["llmCalls"].to_i
        c.each do |key, value|
          other = key[/\AllmCalls:(.+)\z/, 1]
          next unless other

          calls[model] -= value.to_i
          calls[other] += value.to_i
        end
      end
      by_model = (s["byModel"].is_a?(Hash) ? s["byModel"] : {}).to_h do |model, m|
        [model, { usd: m["usd"], input: m["input"], output: m["output"], agents: agents[model], agent_calls: calls[model] }]
      end
      calls.each { |model, n| by_model[model] ||= { usd: nil, input: nil, output: nil, agents: agents[model], agent_calls: n } }
      landed = intents[:landed]
      review_calls = intent_spend_counted? ? @spec.keys.sum { |iid| layer_calls(iid, "review") } : nil
      usd = s["usd"]
      {
        usd: usd, by_layer: s["byLayer"], by_model: by_model, unpriced: s["unpriced"],
        agent_calls: calls.values.sum, review_calls: review_calls,
        model_calls: review_calls.nil? ? nil : calls.values.sum + review_calls,
        per_landed_intent: usd && landed.positive? ? (usd / landed).round(6) : nil, colony_per_landed_intent: s["perLandedIntent"],
        cap: s["cap"] && s["cap"].slice("usd", "reviewReserveUsd", "spentUsd", "state")
      }
    end

    # --- wall time -------------------------------------------------------------------------------------------------

    def wall
      rows = intents[:per_intent]
      landed = rows.filter_map { |r| r[:landed_at_s] }
      all = rows.all? { |r| r[:status] == "landed" }
      times = @spec.keys.filter_map { |iid| @by_intent[iid].find { |p| p[:status] == "landed" }&.dig(:landed_at) }
      last_ms = all && !times.empty? ? times.max : nil
      green = last_ms && @certs.find { |c| c[:status] == "green" && c[:at] >= last_ms && (idx = landing_index(c)) && idx >= last_spec_landing_index }
      {
        release_to_last_landing_s: all ? landed.max : nil, last_landing_so_far_s: landed.max,
        release_to_green_s: green ? since_release(green[:at]) : nil,
        run_s: @end_at && @release_at ? ContentionReport.secs(@end_at - @release_at) : nil
      }
    end

    private

    # Proposals and their events, landings in order, certifications in the order they finished.
    def index
      @props = {}
      @prop_events = Hash.new { |h, k| h[k] = [] }
      @prop_intent = {}
      @human = Set.new
      @landings = []
      bisects = {}
      cert_events = {}
      @events.each do |e|
        case e["t"]
        when "proposal"
          pid = e["proposalId"]
          p = @props[pid] ||= { id: pid, intent: e["intentId"], agent: e["agentId"], first_at: e["at"] }
          p[:status] = e["status"]
          p[:reason] = e["reason"] if e["status"] == "returned" || e["status"] == "rejected" || e["status"] == "escalated"
          p[:landed_at] ||= e["at"] if e["status"] == "landed"
          @prop_events[pid] << e
          @prop_intent[pid] = e["intentId"]
        when "landing"
          @landings << { id: e["landingId"], sha: e["trunkSha"], at: e["at"], proposals: Array(e["proposalIds"]), paths: Array(e["paths"]) }
        when "decision"
          @human << e["subject"] if e["layer"] == "human" && e["action"] == "return"
        when "certify"
          cert_events[e["trunkSha"]] = e if e["trunkSha"] && %w[green red error skipped].include?(e["status"])
        when "bisect"
          bisects[e["trunkSha"]] = e["firstRed"] if e["trunkSha"] && e["firstRed"].is_a?(Hash)
        end
      end
      @details.each do |pid, d|
        next unless d.is_a?(Hash)

        @prop_intent[pid] ||= d["intentId"]
      end
      @props.each_value { |p| p[:cause] = ContentionReport.cause(p[:reason], human: @human.include?(p[:id])) if p[:status] == "returned" }
      @by_intent = Hash.new { |h, k| h[k] = [] }
      @props.values.sort_by { |p| [p[:first_at] || 0, p[:id].to_s] }.each { |p| @by_intent[p[:intent]] << p }
      @landing_by_sha = @landings.each_with_index.to_h { |l, i| [l[:sha], i] }
      @landing_by_id = @landings.each_with_index.to_h { |l, i| [l[:id], i] }
      @landing_of_prop = {}
      @landings.each_with_index { |l, i| l[:proposals].each { |pid| @landing_of_prop[pid] ||= i } }
      listed = @certs_in.filter_map { |c| normalize_cert(c, bisects) }
      by_sha = listed.to_h { |c| [c[:sha], c] }
      cert_events.each { |sha, e| by_sha[sha] ||= normalize_cert(e, bisects) }
      @certs_all = by_sha.values.compact.sort_by { |c| [c[:at] || 0, landing_index(c) || -1] }
      @certs = @certs_all.select { |c| %w[green red].include?(c[:status]) }
    end

    def normalize_cert(c, bisects)
      return nil unless c.is_a?(Hash) && c["trunkSha"]

      at = c["finishedAt"] || c["at"] || c["startedAt"]
      { sha: c["trunkSha"], status: c["status"], landing: c["landingId"], at: at, counts: c["counts"], failing: Array(c["failing"]),
        suspects: Array(c["suspects"]), first_red: c["firstRed"].is_a?(Hash) ? c["firstRed"] : bisects[c["trunkSha"]] }
    end

    def landing_index(c) = (c[:landing] && @landing_by_id[c[:landing]]) || @landing_by_sha[c[:sha]]

    def returned?(p) = p[:status] == "returned" && !redirect?(p[:reason])

    def redirect?(reason) = ContentionReport.redirect?(reason)

    def spec_props = @props.values.select { |p| @spec.key?(p[:intent]) }

    def spec_id(iid) = @spec.dig(iid, :id)

    def intent_by_spec(sid) = @spec.find { |_, s| s[:id] == sid }&.first

    def since_release(at) = at && @release_at ? ContentionReport.secs(at - @release_at) : nil

    def intent_status(iid)
      last = @events.reverse_each.find { |e| e["t"] == "intent" && e["intentId"] == iid }
      return "landed" if @by_intent[iid].any? { |p| p[:status] == "landed" }

      snap = Array(@snapshot["intents"]).find { |i| i["id"] == iid }
      snap&.dig("status") || last&.dig("status") || "open"
    end

    def intent_spend_counted? = @metrics["intentSpend"].is_a?(Hash)

    def layer_calls(iid, layer) = @metrics.dig("intentSpend", iid, "byLayer", layer, "calls").to_i

    def intent_calls(iid)
      return nil unless intent_spend_counted?

      layers = @metrics.dig("intentSpend", iid, "byLayer")
      layers.is_a?(Hash) ? layers.values.sum { |l| l.is_a?(Hash) ? l["calls"].to_i : 0 } : 0
    end

    def intent_usd(iid) = intent_spend_counted? ? @metrics.dig("intentSpend", iid, "usd") : nil

    # The landing (and its index) of an intent's first landed proposal.
    def landing_of_intent(iid)
      p = @by_intent[iid].find { |x| x[:status] == "landed" }
      return nil unless p

      i = @landing_of_prop[p[:id]]
      i && { index: i, proposal: p[:id], at: @landings[i][:at] }
    end

    # The landing index of a proposal's base commit (-1 for a commit before every recorded landing), or nil unknown.
    def base_index(pid)
      base = @details.dig(pid, "baseSha")
      return nil unless base

      @landing_by_sha.fetch(base, -1)
    end

    def failing_files(c) = c[:failing].filter_map { |f| f["file"] }.uniq

    # The change that turned trunk red at red result `c`, and how it was found.
    def culprit_of(c)
      fr = c[:first_red]
      if fr.is_a?(Hash) && fr["status"] == "found"
        iso = fr["isolated"]
        if iso.is_a?(Hash) && iso["status"] == "isolated" && iso.dig("culprit", "id")
          return { by: "isolated", landing: fr["landingId"], proposals: [iso.dig("culprit", "id")] }
        end

        ids = Array(fr["proposals"]).filter_map { |p| p["id"] }
        ids = @landings[@landing_by_id[fr["landingId"]] || -1]&.dig(:proposals) || [] if ids.empty? && @landing_by_id[fr["landingId"]]
        return { by: "first red", landing: fr["landingId"], proposals: ids }
      end
      suspect = c[:suspects].first
      return { by: "suspect", landing: suspect["landingId"], proposals: [suspect["proposalId"]].compact } if suspect && suspect["proposalId"]

      i = landing_index(c)
      i ? { by: "red commit", landing: @landings[i][:id], proposals: @landings[i][:proposals] } : nil
    end

    # The partners of culprit `pid` at red result `c`: (a) intents that landed before it and wrote a failing test file,
    # (b) landings between its base and its own landing that wrote a file it read or wrote. The first kind names the
    # partner exactly; when there is one, the landings it was merged over are not listed.
    def partners_of(pid, c)
      own = @prop_intent[pid]
      at = @landing_of_prop[pid]
      out = []
      failing = failing_files(c)
      @spec.each do |iid, s|
        next if iid == own

        l = landing_of_intent(iid)
        next unless l && at && l[:index] < at
        next unless failing.any? { |f| Array(s[:footprint]).include?(f) }

        out << { intent: iid, how: "broke its tests" }
      end
      base = base_index(pid)
      detail = @details[pid]
      if base && at && detail.is_a?(Hash)
        touched = (Array(detail["writeSet"]) + Array(detail["readSet"])).filter_map { |w| w["path"] }.to_set
        @landings[(base + 1)...at].to_a.each do |l|
          next unless l[:paths].any? { |p| touched.include?(p) }

          l[:proposals].each do |q|
            iid = @prop_intent[q]
            next if iid.nil? || iid == own || !@spec.key?(iid)

            out << { intent: iid, how: "merged over it" }
          end
        end
      end
      exact = out.select { |o| o[:how] == "broke its tests" }
      (exact.empty? ? out : exact).uniq { |o| o[:intent] }
    end

    def designed?(first, second) = @pairs.any? { |p| [p["first"], p["second"]].sort == [first, second].sort }

    def last_spec_landing_index
      @spec.keys.filter_map { |iid| landing_of_intent(iid)&.dig(:index) }.max || -1
    end
  end

  # Paired solo-against-concurrent transitions: each intent's outcome in the solo run and in a concurrent run, as
  # "first try" (landed on its first proposal), "after returns" (landed later) or "not landed", with the hidden tests'
  # grade when both runs were graded; the matrix of moves between them, and the paired change in rounds and calls.
  def transitions(solo, other)
    by = ->(report) { report[:intents][:per_intent].to_h { |r| [r[:id], r] } }
    a = by.call(solo)
    b = by.call(other)
    outcome = ->(r) { r.nil? || r[:status] != "landed" ? "not landed" : (r[:rounds] == 1 ? "first try" : "after returns") }
    matrix = Hash.new(0)
    rows = (a.keys | b.keys).sort.map do |id|
      from = outcome.call(a[id])
      to = outcome.call(b[id])
      matrix["#{from} -> #{to}"] += 1
      { id: id, solo: from, concurrent: to, solo_hidden: a.dig(id, :hidden), concurrent_hidden: b.dig(id, :hidden),
        rounds_delta: a.dig(id, :rounds) && b.dig(id, :rounds) ? b[id][:rounds] - a[id][:rounds] : nil,
        calls_delta: a.dig(id, :model_calls) && b.dig(id, :model_calls) ? b[id][:model_calls] - a[id][:model_calls] : nil }
    end
    hidden = rows.select { |r| r[:solo_hidden] && r[:concurrent_hidden] }.map { |r| "#{r[:solo_hidden]} -> #{r[:concurrent_hidden]}" }.tally
    { matrix: matrix.sort.to_h, hidden: hidden.sort.to_h, median_rounds_delta: median(rows.map { |r| r[:rounds_delta] }),
      median_calls_delta: median(rows.map { |r| r[:calls_delta] }), intents: rows }
  end
end
