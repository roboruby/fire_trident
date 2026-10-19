# frozen_string_literal: true

# The Hono replay's recorded fixtures (scripts/hono_replay.rb --dry-run, and scripts/test/hono_replay_test.rb): a fake
# colony API on 127.0.0.1 (fake_contention.rb's, extended) whose trunk is a real git repository served over smart HTTP
# as FT_PUBLIC_GIT serves one, a small fixture clone built from fixtures/hono-replay/repo.json (a base commit and three
# pull requests on main), the workload for it with its commits and hidden files' blob ids filled in, and recorded
# vitest reports (fixtures/hono-replay/vitest/) that stand in for vitest. The colony replays a short run once the swarm
# starts: #9001 lands at once; #9002's change waits for a person (its tests run again on request and pass, so the
# scripted person approves it and it lands); #9003 has an agent's report waiting (dismissed), then a change that waits
# with a failing test (returned, naming it), then a change that lands. The review queue also holds an audit item and a
# change of an intent that is not the run's, which the scripted person must leave alone.
require "digest"
require "fileutils"
require "json"
require "tmpdir"
require_relative "fake_deployment"
require_relative "fake_contention"
require_relative "../hono_tree"

class FakeHono < FakeContention
  FIXTURES = File.expand_path("fixtures/hono-replay", __dir__)

  # Build the fixture clone in `dir`/clone: the base commit, then each pull request as a squash commit on main.
  # Returns [repo, workload] with the workload's commits, target and hidden blob ids filled in.
  def self.build(dir)
    spec = JSON.parse(File.read(File.join(FIXTURES, "repo.json")))
    clone = File.join(dir, "clone")
    git = ->(*args) { system(HonoTree::GIT_ENV, "git", "-C", clone, *args, out: File::NULL, err: File::NULL, exception: true) }
    FileUtils.mkdir_p(clone)
    git.call("init", "-q", "-b", "main")
    write = lambda do |files|
      files.each do |path, text|
        full = File.join(clone, path)
        FileUtils.mkdir_p(File.dirname(full))
        File.write(full, text)
      end
    end
    write.call(spec.dig("base", "files"))
    spec.dig("base", "binary").each do |path|
      FileUtils.mkdir_p(File.dirname(File.join(clone, path)))
      File.binwrite(File.join(clone, path), "\x89PNG\r\n\x1A\n\0\0\0\rIHDR".b)
    end
    git.call("add", "-A")
    git.call("commit", "-q", "-m", spec.dig("base", "subject"))
    spec["prs"].each do |pr|
      write.call(pr["files"])
      git.call("add", "-A")
      git.call("commit", "-q", "-m", pr["subject"])
    end
    repo = HonoTree::Repo.new(clone)
    base = repo.commit("HEAD~#{spec['prs'].size}")
    commits = spec["prs"].each_with_index.map { |_, i| repo.commit("HEAD~#{spec['prs'].size - 1 - i}") }
    chain = repo.replay(base, commits, label: ->(sha) { "##{spec['prs'][commits.index(sha)]['number']}" })
    workload = JSON.parse(File.read(File.join(FIXTURES, "workload.json")))
    workload["base"] = { "commit" => base, "date" => "2026-07-10T00:00:00Z", "subject" => spec.dig("base", "subject") }
    workload["target"] = { "commit" => chain[:head] }
    workload["prs"].each_with_index do |pr, i|
      pr["commit"] = commits[i]
      pr["hidden"] = pr["tests"].map do |p|
        text = repo.show(chain[:steps][i][:after], p)
        { "path" => p, "blob" => Digest::SHA1.hexdigest("blob #{text.bytesize}\0".b + text.b), "new" => repo.show(base, p).nil?, "bytes" => text.bytesize }
      end
    end
    [repo, workload]
  end

  # The recorded vitest reports in the order the grader asks for them (each intent in turn), then the suite.
  def self.runner
    reports = %w[9001 9002 9003].map { |n| File.read(File.join(FIXTURES, "vitest", "#{n}.json")) }
    suite = File.read(File.join(FIXTURES, "vitest", "suite.json"))
    calls = 0
    lambda do |_files, all|
      json = all ? suite : reports.fetch(calls).tap { calls += 1 }
      HonoTree::Vitest.parse(json, "/fixture/grade").merge(exit: 0, seconds: 0.1)
    end
  end

  # Build the fixtures, start the fake deployment, and yield { url:, token:, access:, repo:, workload:, runner:, dir:,
  # fake:, server: }; stop it afterwards.
  def self.dry_run(public_git: true)
    Dir.mktmpdir("hono-replay-dry-") do |dir|
      repo, workload = build(dir)
      fake = new(git_root: File.join(dir, "trunks"), public_git: public_git)
      server = FakeDeployment.new { |req| fake.call(req) }
      fake.url = server.url
      access = { "CF-Access-Client-Id" => FakeDeployment::ACCESS_ID, "CF-Access-Client-Secret" => FakeDeployment::ACCESS_SECRET }
      begin
        yield({ url: server.url, token: FakeDeployment::TOKEN, access: access, repo: repo, workload: workload, runner: runner, dir: dir, fake: fake, server: server })
      ensure
        server.stop
      end
    end
  end

  attr_reader :answers
  attr_accessor :url

  # `public_git`: whether /git/<colony>.git serves the trunk to anyone (FT_PUBLIC_GIT names the colony); when false it
  # serves only a request with a lease's trunk token, as the trunk remote does.
  def initialize(git_root:, public_git: true, **kw)
    super(flags: %w[FT_BISECT FT_CULPRITS FT_INLINE FT_INTENT_SPEND FT_TRUNK_TESTS FT_PUBLIC_GIT], land_per_poll: 1, return_every: 0, **kw)
    @git_root = git_root
    @public_git = public_git
    FileUtils.mkdir_p(@git_root)
    @answers = []
  end

  private

  def route(req)
    return git(req) if req.path.start_with?("/git/")

    m = req.path.match(%r{\A/api/colonies/([^/]+)(/.*)?\z})
    c = m && @colonies[m[1]]
    return super unless c && !c[:deleted]

    rest = m[2].to_s
    if req.method == "GET" && rest == "/review" then review(c)
    elsif req.method == "GET" && rest == "/escalations" then json(200, { colonyId: c[:id], total: open_reports(c).size, intents: open_reports(c) })
    elsif req.method == "POST" && (t = rest.match(%r{\A/proposals/([^/]+)/tests\z})) then retest(c, t[1], req.json)
    elsif req.method == "POST" && (d = rest.match(%r{\A/review/([^/]+)\z})) then decide(c, d[1], req.json)
    elsif req.method == "POST" && rest == "/certify/policy" then c[:certify_policy] = req.json; json(200, { colonyId: c[:id], policy: req.json })
    elsif req.method == "POST" && (e = rest.match(%r{\A/intents/([^/]+)/escalation\z})) then resolve(c, e[1], req.json)
    else super
    end
  end

  # Smart HTTP for the colony's trunk: reads only, as the deployment's public git; a push is refused.
  def git(req)
    name = req.path[%r{\A/git/([^/]+)\.git/}, 1]
    return [403, { "Content-Type" => "text/plain" }, "This is a read-only view of a FireTrident colony."] if req.path.end_with?("git-receive-pack") || req.query.to_s.include?("git-receive-pack")
    return [404, { "Content-Type" => "text/plain" }, "Repository not found."] unless name && @colonies[name] && File.directory?(File.join(@git_root, "#{name}.git"))
    return [404, { "Content-Type" => "text/plain" }, "Repository not found."] unless @public_git || req.headers["authorization"].to_s.match?(/\ABearer trunk-token-\S+-secret\z/)

    FakeDeployment.git(@git_root, req)
  end

  # A lease names the trunk remote too (here, the same smart HTTP with the lease's token).
  def take(c, aid)
    status, headers, body = super
    data = JSON.parse(body)
    data["lease"]["trunk"]["remote"] = "#{@url}/git/#{c[:id]}.git" if data["lease"] && @url
    [status, headers, JSON.generate(data)]
  end

  # A landing commits the colony's files to its trunk repository: the commit is the trunk sha.
  def land(c, intent_id, agent_id, paths, base: c[:head])
    i = c[:intents][intent_id]
    paths.each { |p| c[:files][p] = "#{c[:files][p]}// #{i ? i[:title] : 'change'}\n" } unless paths.all? { |p| c[:files].key?(p) && c[:fresh]&.include?(p) }
    c[:fresh] = nil
    super
  end

  # The trunk sha of a landing is a real commit of the colony's files.
  def certify(c, lid, paths)
    c[:head] = commit(c, "landing #{lid}")
    c[:landings].last[:trunkSha] = c[:head]
    ev = c[:events].reverse.find { |e| e[:t] == "landing" && e[:landingId] == lid }
    ev[:trunkSha] = c[:head] if ev
    super
  end

  def propose(c, b)
    c[:fresh] = b["writeSet"].map { |w| w["path"] }
    super
  end

  def commit(c, message)
    dir = File.join(@git_root, "#{c[:id]}.git")
    env = HonoTree::GIT_ENV.merge("GIT_DIR" => dir, "GIT_INDEX_FILE" => File.join(dir, "fixture-index"))
    run = lambda do |*args, input: nil|
      out, status = Open3.capture2(env, "git", *args, stdin_data: input.to_s)
      raise "git #{args.first} failed" unless status.success?

      out.strip
    end
    run.call("init", "-q", "--bare", "-b", "main", dir) unless File.directory?(dir)
    run.call("read-tree", "--empty")
    lines = c[:files].sort.map { |path, text| "100644 #{run.call('hash-object', '-w', '--stdin', input: text)}\t#{path}" }
    run.call("update-index", "--add", "--index-info", input: "#{lines.join("\n")}\n")
    tree = run.call("write-tree")
    parent = c[:git_head]
    sha = run.call("commit-tree", tree, *(parent ? ["-p", parent] : []), "-m", message)
    run.call("update-ref", "refs/heads/main", sha)
    run.call("symbolic-ref", "HEAD", "refs/heads/main")
    c[:git_head] = sha
  end

  # The scripted run, a step per snapshot read once the swarm is out.
  def advance(c)
    return unless c[:swarm] && !c[:swarm_stopped] && !c[:paused]

    c[:spend] += @spend_per_poll
    spec = c[:intents].values.select { |i| i[:spec] }
    agent = c[:agents].values.find { |a| a[:kind] == "internal" }
    return unless agent && spec.size >= 3

    a, b, d = spec
    c[:step] = (c[:step] || 0) + 1
    agent[:counters]["llmCalls"] += 2
    [a, b, d].each { |i| i[:calls] = i[:calls].to_i + (i[:status] == "landed" ? 0 : 1) }
    case c[:step]
    when 1
      land(c, a[:id], agent[:id], a[:footprint])
      c[:reports] = { d[:id] => { kind: "blocked", report: "Which helper should the router call for the path?", at: now, by: agent[:id] } }
      event(c, { t: "escalation", intentId: d[:id], agentId: agent[:id], kind: "blocked", report: c[:reports][d[:id]][:report], title: d[:title] })
      escalate(c, b, agent, "A model could not review this change, so a person must decide.")
      audit = { id: "prop_audit", intentId: a[:id], status: "landed", audit: { kind: "audit", layer: "reflex" } }
      c[:extra_queue] = [audit, { id: "prop_canary", intentId: "int_not_ours", status: "escalated", writeSet: [{ path: "src/x.ts" }] }]
    else
      if d[:status] != "landed" && !c[:reports]&.key?(d[:id]) && c[:queue].values.none? { |p| p[:intentId] == d[:id] }
        if c[:d_returned]
          land(c, d[:id], agent[:id], d[:footprint])
        else
          escalate(c, d, agent, "This change writes a protected path, so a person must decide.")
        end
      end
    end
  end

  def escalate(c, intent, agent, reason)
    pid = id("prop")
    event(c, { t: "proposal", proposalId: pid, intentId: intent[:id], agentId: agent[:id], status: "pending" })
    event(c, { t: "proposal", proposalId: pid, intentId: intent[:id], agentId: agent[:id], status: "escalated", reason: reason })
    p = { id: pid, intentId: intent[:id], agentId: agent[:id], baseSha: c[:head], status: "escalated", reason: reason,
          writeSet: intent[:footprint].map { |x| { path: x, blob: Digest::SHA1.hexdigest(x) } }, readSet: [], createdAt: now }
    c[:proposals][pid] = p
    (c[:queue] ||= {})[pid] = p
    intent[:status] = "proposed"
    event(c, { t: "intent", intentId: intent[:id], status: "proposed", title: intent[:title], footprint: intent[:footprint] })
  end

  def review(c)
    queue = (c[:queue] || {}).values.map do |p|
      run = p[:run]
      if run && run[:status] == "queued"
        failing = p[:intentId] == c[:intents].values.select { |i| i[:spec] }[2][:id]
        run.merge!(status: "ran", tests: 5, passed: failing ? 4 : 5, failed: failing ? 1 : 0, finishedAt: now)
        if failing
          run[:failing] = [{ file: "src/router/node.test.ts", name: "match > matches a trailing slash", error: "expected false to be true", onTrunk: "passes" }]
          run[:onTrunk] = { passes: 1 }
        end
      end
      p.merge(reviewTests: run || { id: "rtr_escalation", status: "notrun", by: "escalation", at: p[:createdAt], reason: "no vitest shim in the fixture" })
    end
    json(200, queue + Array(c[:extra_queue]))
  end

  def retest(c, pid, body)
    p = (c[:queue] || {})[pid]
    return json(409, { error: "#{pid} is not waiting for a person: tests before approval run only on a change in the review queue" }) unless p

    p[:run] = { id: "rtr_#{id('run')}", status: "queued", by: body["by"], at: now }
    @answers << { kind: "retest", proposal: pid, by: body["by"] }
    json(202, { started: true, run: p[:run] })
  end

  def decide(c, pid, body)
    p = (c[:queue] || {}).delete(pid)
    return json(409, { error: "#{pid} is not waiting for a person" }) unless p

    @answers << { kind: body["decision"], proposal: pid, reason: body["reason"], by: body["by"] }
    i = c[:intents][p[:intentId]]
    if body["decision"] == "approve"
      event(c, { t: "decision", layer: "human", action: "approve", subject: pid })
      land_escalated(c, p, i)
    else
      event(c, { t: "decision", layer: "human", action: "return", subject: pid })
      event(c, { t: "proposal", proposalId: pid, intentId: p[:intentId], agentId: p[:agentId], status: "returned", reason: "Returned by a person: #{body['reason']}" })
      c[:proposals][pid] = p.merge(status: "returned", reason: body["reason"])
      i[:status] = "open"
      c[:d_returned] = true
    end
    json(200, { ok: true })
  end

  # An approved change lands as itself: a landing, its proposal and intent landed, a certification.
  def land_escalated(c, p, intent)
    lid = id("lnd")
    parent = c[:head]
    c[:head] = Digest::SHA1.hexdigest("#{parent}-#{lid}")
    paths = intent[:footprint]
    paths.each { |x| c[:files][x] = "#{c[:files][x]}// #{intent[:title]}\n" }
    c[:landings] << { id: lid, trunkSha: c[:head], parentSha: parent, proposalIds: [p[:id]], paths: paths }
    event(c, { t: "landing", landingId: lid, trunkSha: c[:head], proposalIds: [p[:id]], paths: paths })
    event(c, { t: "proposal", proposalId: p[:id], intentId: intent[:id], agentId: p[:agentId], status: "landed" })
    c[:proposals][p[:id]] = p.merge(status: "landed", landingId: lid)
    intent[:status] = "landed"
    event(c, { t: "intent", intentId: intent[:id], status: "landed", title: intent[:title], footprint: intent[:footprint] })
    certify(c, lid, paths)
  end

  def open_reports(c)
    (c[:reports] || {}).map do |iid, r|
      i = c[:intents][iid]
      { id: iid, title: i[:title], status: i[:status], source: i[:source], footprint: i[:footprint], escalation: { kind: r[:kind], report: r[:report], at: r[:at], by: r[:by] } }
    end
  end

  def resolve(c, iid, body)
    r = (c[:reports] || {}).delete(iid)
    return json(409, { error: "intent #{iid} has no report waiting for a person" }) unless r

    @answers << { kind: body["decision"], intent: iid, note: body["note"], by: body["by"] }
    event(c, { t: "escalation", intentId: iid, agentId: r[:by], kind: r[:kind], report: r[:report], resolved: { by: body["by"], at: now, decision: body["decision"], note: body["note"] } })
    json(200, { intent: { id: iid } })
  end
end
