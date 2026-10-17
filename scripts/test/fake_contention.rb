# frozen_string_literal: true

# A fake colony API for scripts/contention.rb's tests (contention_test.rb), in memory on top of fake_deployment.rb:
# colonies created and deleted, the decide and certify policies, the spend cap, agents, intents (assigned ones are
# claimed for their agent at once), takes with leases, inline proposals that land at once with a certification of each
# new trunk commit, and a swarm that works the spec intents a few per poll of the snapshot: some of their first
# proposals go back stale, every proposal adds model calls and spend, and the run's events, metrics, agents and
# certifications read back as the real routes answer them. The grading change (files under test/accept/) is certified
# red for the hidden test files named in `grade_fail`. With `stall_after`, the swarm stops once that many spec intents
# landed, the way a staging run stalled: two changes wait for a person, trunk certification is an error, claims sit on
# the shared module (GET /field), and the agents wait on their changes.
require "digest"
require "json"
require_relative "fake_deployment"

class FakeContention
  REFLEX = "@cf/google/gemma-4-26b-a4b-it"

  attr_reader :colonies

  # `flags`: what /api/about lists. `land_per_poll`: spec intents worked per snapshot read. `return_every`: the first
  # proposal of every k-th spec intent goes back stale (0: none). `spend_per_poll`: USD the swarm spends per snapshot
  # read. `cap_404`: the spend cap route is missing (an older build). `grade_fail`: intent ids whose hidden test fails.
  # `stall_after`: spec intents that land before the swarm stalls (nil: it never does).
  def initialize(flags: %w[FT_BISECT FT_CULPRITS FT_INLINE FT_INTENT_SPEND FT_TRUNK_TESTS], land_per_poll: 4, return_every: 3,
                 spend_per_poll: 0.002, cap_404: false, grade_fail: [], stall_after: nil)
    @stall_after = stall_after
    @flags = flags
    @land_per_poll = land_per_poll
    @return_every = return_every
    @spend_per_poll = spend_per_poll
    @cap_404 = cap_404
    @grade_fail = grade_fail
    @colonies = {}
    @n = 0
    @lock = Mutex.new
  end

  def call(req) = @lock.synchronize { route(req) }

  private

  def id(prefix) = "#{prefix}_#{@n += 1}"
  def json(status, body) = FakeDeployment.json(status, body)
  def now = (Time.now.to_f * 1000).round

  def route(req)
    return json(200, { service: "firetrident", commit: "abc1234", flags: @flags }) if req.path == "/api/about"
    return create(req) if req.method == "POST" && req.path == "/api/colonies"

    m = req.path.match(%r{\A/api/colonies/([^/]+)(/.*)?\z})
    c = m && @colonies[m[1]]
    return json(404, { error: "colony not found" }) unless c && !c[:deleted]

    rest = m[2].to_s
    q = req.params
    case [req.method, rest]
    in ["GET", ""]
      advance(c)
      json(200, snapshot(c))
    in ["DELETE", ""]
      c[:deleted] = true
      json(200, { ok: true })
    in ["GET", "/metrics"] then json(200, metrics(c))
    in ["GET", "/field"]
      claim = stalled?(c) ? { "src/core/money.ts" => { claim: 2.4, need: 31.0 } } : {}
      json(200, [{ region: "src", at: now, totals: {}, byPath: claim, agents: [], sigma: 0, admission: { open: true, landingsPerMin: 0, activeAgents: 0 } }])
    in ["GET", "/events"]
      after = q["after"].to_i
      limit = [q["limit"].to_i, 1].max
      page = c[:events].select { |e| e[:seq] > after }.first(limit)
      more = c[:events].any? { |e| e[:seq] > (page.last&.dig(:seq) || after) }
      json(200, { colonyId: c[:id], source: "recorded", events: page, next: more ? page.last[:seq] : nil, total: c[:events].size })
    in ["GET", "/agents"] then json(200, { agents: c[:agents].values.reject { |a| a[:kind] == "synthetic" } + c[:agents].values.select { |a| a[:kind] == "synthetic" } })
    in ["GET", "/review"] then json(200, [])
    in ["POST", "/decide/policy"]
      c[:review] = req.json["enabled"] != false
      json(200, { enabled: c[:review], reflexModel: REFLEX, secondOpinionModels: ["@cf/openai/gpt-oss-120b"] })
    in ["POST", "/certify/policy"]
      c[:certify_policy].merge!(req.json)
      json(200, c[:certify_policy])
    in ["GET", "/certifications"]
      json(200, { colonyId: c[:id], on: true, deployment: true, runner: true, policy: c[:certify_policy], results: c[:certs].reverse.first([q["limit"].to_i, 1].max) })
    in ["POST", "/rules"] then json(201, { id: id("rule") })
    in ["POST", "/spend-cap"]
      return json(404, { error: "no route for POST #{req.path}" }) if @cap_404

      c[:cap] = req.json
      json(200, { colonyId: c[:id], cap: c[:cap] })
    in ["POST", "/agents"]
      a = { id: id("agt"), name: req.json["name"], kind: req.json["kind"], model: req.json["model"], counters: {} }
      c[:agents][a[:id]] = a
      json(201, a)
    in ["POST", "/intents"] then declare(c, req.json)
    in ["POST", "/proposals"] then propose(c, req.json)
    in ["POST", "/swarm"]
      return json(409, { error: "Agents are paused in this colony" }) if c[:paused]

      start_swarm(c, req.json)
    in ["POST", "/swarm/stop"]
      c[:swarm_stopped] = true
      json(200, { stopped: c[:agents].values.count { |a| a[:kind] == "internal" } })
    in ["POST", "/pause"]
      c[:paused] = req.json
      json(201, { colonyId: c[:id], pause: { by: req.json["by"], reason: req.json["reason"] }, already: false })
    else
      if req.method == "POST" && (t = rest.match(%r{\A/agents/([^/]+)/take\z}))
        take(c, t[1])
      elsif req.method == "GET" && (p = rest.match(%r{\A/proposals/([^/]+)\z}))
        prop = c[:proposals][p[1]]
        prop ? json(200, prop) : json(404, { error: "no such proposal" })
      elsif req.method == "GET" && (s = rest.match(%r{\A/certifications/([0-9a-f]+)\z}))
        cert = c[:certs].find { |x| x[:trunkSha] == s[1] }
        cert ? json(200, cert) : json(404, { error: "no certification for that commit" })
      else
        json(404, { error: "no route for #{req.method} #{req.path}" })
      end
    end
  end

  def create(req)
    b = req.json
    cid = b["name"].to_s.downcase
    return json(409, { error: "colony #{cid} exists" }) if @colonies[cid] && !@colonies[cid][:deleted]

    @colonies[cid] = { id: cid, pool: b["pool"], review: true, certify_policy: { "enabled" => true, "repair" => true }, agents: {}, intents: {},
                       proposals: {}, events: [], seq: 0, landings: [], head: Digest::SHA1.hexdigest("root-#{cid}"), certs: [], spend: 0.0,
                       swarm: nil, swarm_stopped: false, paused: nil, deleted: false, cap: nil, files: {} }
    json(201, { id: cid, name: cid })
  end

  def event(c, e) = c[:events] << e.merge(seq: c[:seq] += 1, at: now)

  def declare(c, b)
    i = { id: id("int"), title: b["title"], why: b["why"], footprint: b["footprint"], acceptance: b["acceptance"], priority: b["priority"],
          source: b["source"] || "human", assignedTo: b["assignedTo"], status: b["assignedTo"] ? "claimed" : "open", revision: 1, taken: false, spec: b["assignedTo"].nil? }
    c[:intents][i[:id]] = i
    event(c, { t: "intent", intentId: i[:id], status: i[:status], title: i[:title], footprint: i[:footprint] })
    json(201, i.reject { |k, _| %i[taken spec].include?(k) })
  end

  def take(c, aid)
    i = c[:intents].values.find { |x| x[:assignedTo] == aid && !x[:taken] }
    return json(200, { intent: nil, reason: "no intent for this agent", retryInMs: 50 }) unless i

    i[:taken] = true
    json(200, { intent: { id: i[:id], revision: 1, footprint: i[:footprint] },
                lease: { baseSha: c[:head], token: "lease-token-#{aid}-secret", repo: { namespace: "ws", name: "ws-#{aid}", remote: "https://ws.example/#{aid}.git" },
                         trunk: { token: "trunk-token-#{aid}-secret", sha: c[:head] } } })
  end

  # An inline change lands at once: a new trunk commit, its landing, and its certification.
  def propose(c, b)
    return json(400, { error: "inline changes are off" }) unless b["contents"].is_a?(Hash) && !b["contents"].empty?

    paths = b["writeSet"].map { |w| w["path"] }
    b["writeSet"].each { |w| c[:files][w["path"]] = b["contents"][w["blob"]] }
    p = land(c, b["intentId"], b["agentId"], paths, base: b["baseSha"])
    json(201, p.merge(status: "pending"))
  end

  def land(c, intent_id, agent_id, paths, base: c[:head])
    pid = id("prop")
    event(c, { t: "proposal", proposalId: pid, intentId: intent_id, agentId: agent_id, status: "pending" })
    lid = id("lnd")
    parent = c[:head]
    c[:head] = Digest::SHA1.hexdigest("#{parent}-#{lid}")
    c[:landings] << { id: lid, trunkSha: c[:head], parentSha: parent, proposalIds: [pid], paths: paths }
    event(c, { t: "landing", landingId: lid, trunkSha: c[:head], proposalIds: [pid], paths: paths })
    event(c, { t: "proposal", proposalId: pid, intentId: intent_id, agentId: agent_id, status: "landed" })
    p = { id: pid, intentId: intent_id, agentId: agent_id, baseSha: base, status: "landed", landingId: lid,
          writeSet: paths.map { |x| { path: x, blob: Digest::SHA1.hexdigest(x) } }, readSet: [] }
    c[:proposals][pid] = p
    i = c[:intents][intent_id]
    if i
      i[:status] = "landed"
      event(c, { t: "intent", intentId: i[:id], status: "landed", title: i[:title], footprint: i[:footprint] })
    end
    certify(c, lid, paths)
    p
  end

  def certify(c, lid, paths)
    grading = paths.any? { |x| x.start_with?("test/accept/") }
    failing = grading ? @grade_fail.map { |g| { name: "#{g}: the hidden test", file: "test/accept/#{g}.test.ts", error: "AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal" } } : []
    status = failing.empty? ? "green" : "red"
    tests = grading ? 62 : 23
    cert = { trunkSha: c[:head], landingId: lid, status: status, counts: { tests: tests, pass: tests - failing.size, fail: failing.size, cancelled: 0, skipped: 0, todo: 0, suites: 0 },
             failing: failing, startedAt: now, finishedAt: now, durationMs: 300 }
    c[:certs] << cert
    event(c, { t: "certify", trunkSha: c[:head], status: status, landingId: lid, counts: cert[:counts], failing: failing })
  end

  def start_swarm(c, b)
    n = b["count"].to_i
    models = assign(b["model"], n)
    list = models.flat_map { |m, k| Array.new(k, m) }
    list.each_with_index do |m, i|
      a = { id: id("agt"), name: "internal-#{i + 1}", kind: "internal", model: m, state: "working", counters: { "llmCalls" => 0, "tokensIn" => 0, "tokensOut" => 0 } }
      c[:agents][a[:id]] = a
    end
    c[:swarm] = { count: n, model: b["model"] }
    json(202, { started: n, kind: "internal", model: b["model"], models: models, failed: 0, errors: [] })
  end

  def assign(spec, n)
    entries = spec.to_s.split(",").map(&:strip).reject(&:empty?)
    return { (entries.first || "bulk") => n } if entries.size <= 1

    groups = Hash.new(0)
    left = n
    open = []
    entries.each do |e|
      if (m = e.match(/\A(.*?)=(\d+)\z/))
        k = [m[2].to_i, left].min
        groups[m[1]] += k
        left -= k
      else
        open << e
      end
    end
    left.times { |i| groups[open[i % open.size]] += 1 } unless open.empty?
    groups.select { |_, k| k.positive? }
  end

  # The swarm stalled (stall_after): enough spec intents landed and nothing more moves.
  def stalled?(c) = !@stall_after.nil? && c[:swarm] && c[:intents].values.count { |i| i[:spec] && i[:status] == "landed" } >= @stall_after

  # The swarm works a few spec intents per snapshot read: the first proposal of every k-th intent goes back stale.
  def advance(c)
    return unless c[:swarm] && !c[:swarm_stopped] && !c[:paused]

    c[:spend] += @spend_per_poll
    return if stalled?(c)
    workers = c[:agents].values.select { |a| a[:kind] == "internal" }
    spec = c[:intents].values.select { |i| i[:spec] }
    spec.reject { |i| i[:status] == "landed" }.first(@land_per_poll).each_with_index do |i, k|
      agent = workers[k % workers.size]
      agent[:counters]["llmCalls"] += 3
      agent[:counters]["tokensIn"] += 12_000
      agent[:counters]["tokensOut"] += 1_500
      (i[:calls] ||= 0)
      i[:calls] += 3
      idx = spec.index(i)
      if @return_every.positive? && (idx % @return_every).zero? && !i[:returned]
        i[:returned] = true
        pid = id("prop")
        event(c, { t: "proposal", proposalId: pid, intentId: i[:id], agentId: agent[:id], status: "pending" })
        event(c, { t: "proposal", proposalId: pid, intentId: i[:id], agentId: agent[:id], status: "returned", reason: "stale: src/core/money.ts changed under it" })
        c[:proposals][pid] = { id: pid, intentId: i[:id], agentId: agent[:id], baseSha: c[:head], status: "returned", reason: "stale: src/core/money.ts changed under it",
                               writeSet: [{ path: "src/core/money.ts" }], readSet: [] }
      else
        land(c, i[:id], agent[:id], i[:footprint])
      end
    end
  end

  def snapshot(c)
    cert = c[:certs].last
    stall = stalled?(c)
    cert = { trunkSha: c[:head], status: "error", detail: "the test runner failed: Identifier 'assert' has already been declared" } if stall
    agents = c[:agents].values.select { |a| a[:kind] == "internal" }.each_with_index.map do |a, k|
      note = stall && k < 2 ? { note: "waiting on prop_#{k} (escalated) for a change" } : {}
      { id: a[:id], kind: "internal", name: a[:name], state: stall ? (k < 2 ? "proposing" : "waiting") : "working" }.merge(note)
    end
    { colony: { id: c[:id], trunkSha: c[:head], certification: cert }, intents: c[:intents].values.map { |i| i.reject { |k, _| %i[taken spec calls returned].include?(k) } },
      files: c[:files].keys.map { |p| { path: p, size: c[:files][p].to_s.bytesize } }, rules: [], agents: agents }
  end

  def metrics(c)
    landed = c[:intents].values.count { |i| i[:spec] && i[:status] == "landed" }
    returned = c[:events].count { |e| e[:t] == "proposal" && e[:status] == "returned" }
    cap = c[:cap] && { usd: c[:cap]["usd"], reviewReserveUsd: c[:cap]["reviewReserveUsd"], spentUsd: c[:spend], inFlightUsd: 0,
                       state: c[:spend] >= c[:cap]["usd"].to_f - c[:cap]["reviewReserveUsd"].to_f ? "review-only" : "open", setBy: "contention", setAt: now }
    gemma = "@cf/google/gemma-4-26b-a4b-it"
    spend = { usd: c[:spend].round(6), byLayer: { agents: c[:spend], review: 0, judge: 0, resolver: 0, other: 0 }, perLandedIntent: landed.positive? ? c[:spend] / landed : nil,
              landedIntents: landed, tokens: { input: 0, output: 0 }, byModel: { gemma => { input: 12_000, output: 1_500, usd: c[:spend].round(6) } }, unpriced: {}, priceDate: "2026-10-12" }
    spend[:cap] = cap if cap
    intent_spend = c[:intents].values.select { |i| i[:spec] }.to_h do |i|
      [i[:id], { usd: 0.001 * i[:calls].to_i, byLayer: { agents: { usd: 0.001 * i[:calls].to_i, calls: i[:calls].to_i }, review: { usd: 0, calls: i[:status] == "landed" ? 1 : 0 } } }]
    end
    { colonyId: c[:id], at: now, metrics: { landings: c[:landings].size, returned: returned, reviewQueue: stalled?(c) ? 2 : 0 }, spend: spend, intentSpend: intent_spend }
  end
end
