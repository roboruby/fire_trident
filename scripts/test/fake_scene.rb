# frozen_string_literal: true

# A fake colony API for the recipe scenes' tests (scene_rename_test.rb, scene_smuggle_test.rb), in memory on top of
# fake_deployment.rb: colonies, agents, intents assigned at declaration, takes with leases, inline changes and changes
# pushed to a workspace (a bare git repository served by `git http-backend`), a trunk kept as a real git repository when
# `git_root` is given, a rename recipe landed in batches of 100 scope files, commutation of changes built before it, the
# lineage notes /why reads, the review queue, model calls per intent, and the reads scripts/record_colony.ts makes.
#
# Review stands in for the decide stage's deterministic rules on a change that names its recipe: each written file is
# compared with the recipe's output on its base (the scene data's `renamed`); a residual line that calls fetch( waits
# for a person (P1), a change with no residual lands (D5). Options make it misbehave the ways the tests check.
require "digest"
require "fileutils"
require "json"
require "open3"
require_relative "fake_deployment"
require_relative "../stage"

class FakeSceneColony
  WORD = /(?<![\w$])formatPrice(?![\w$])/

  attr_reader :pushed

  # `data`: the scenes' data (scripts/scene_data.ts). `commute`: apply the recipe to changes built before it (else they
  # go back stale). `lenient`: land a change that names its recipe whatever its residual. `git_root`: keep trunk and the
  # workspaces as git repositories there, served at `git_url` + "/git/...".
  def initialize(data, flags: %w[FT_INLINE FT_REPRODUCE], commute: true, lenient: false, git_root: nil, git_url: nil)
    @data = data
    @flags = flags
    @commute = commute
    @lenient = lenient
    @git_root = git_root
    @git_url = git_url
    @n = 0
    @lock = Mutex.new
    @colony = nil
    @review = true
    @agents = {}
    @intents = {}
    @proposals = {}
    @landings = []
    @notes = {}
    @events = []
    @trunk = {}
    @head = Digest::SHA1.hexdigest("root")
    @order = { @head => 0 }
    @trees = { @head => {} }
    @recipe = nil
    @pushed = []
    init_git if @git_root
  end

  attr_writer :git_url

  def call(req) = @lock.synchronize { route(req) }

  private

  def id(prefix) = "#{prefix}_#{@n += 1}"
  def json(status, body) = FakeDeployment.json(status, body)
  def rename(text) = text.gsub(WORD, "formatAmount")

  def route(req)
    return json(200, { service: "firetrident", commit: "abc1234", flags: @flags }) if req.path == "/api/about"
    return create(req) if req.method == "POST" && req.path == "/api/colonies"

    m = req.path.match(%r{\A/api/colonies/([^/]+)(/.*)?\z})
    return json(404, { error: "no route" }) unless m && m[1] == @colony

    rest = m[2].to_s
    case [req.method, rest]
    in ["GET", ""] then snapshot
    in ["DELETE", ""] then json(200, { ok: true })
    in ["GET", "/events"] then json(200, { colonyId: @colony, source: "recorded", events: @events, next: nil, total: @events.size, first: @events.first&.dig(:seq), last: @events.last&.dig(:seq) })
    in ["POST", "/decide/policy"]
      @review = req.json["enabled"] != false
      json(200, { enabled: @review })
    in ["POST", "/agents"]
      a = { "id" => id("agt"), "name" => req.json["name"] }
      @agents[a["id"]] = a
      event(t: "agent", agentId: a["id"], kind: "synthetic", state: "idle")
      json(201, a)
    in ["POST", "/intents"] then declare(req.json)
    in ["POST", %r{\A/agents/([^/]+)/take\z}] then take(Regexp.last_match(1))
    in ["POST", "/proposals"] then propose(req.json)
    in ["GET", %r{\A/proposals/([^/]+)\z}] then poll(Regexp.last_match(1))
    in ["POST", "/recipes"] then recipe(req.json)
    in ["GET", %r{\A/recipes/([^/]+)\z}] then residue(Regexp.last_match(1))
    in ["GET", "/why"] then why(req.params["path"])
    in ["GET", "/review"] then json(200, @proposals.values.select { |p| p["status"] == "escalated" }.map { |p| public_of(p).merge("review" => p["review"]) })
    in ["GET", %r{\A/intents/([^/]+)/spend\z}] then json(200, { intentId: Regexp.last_match(1), usd: 0, calls: { review: 0, judge: 0 }, tokens: { input: 0, output: 0 } })
    else json(404, { error: "not in this fake" })
    end
  end

  def event(e)
    @events << e.merge(seq: @events.size + 1, at: 1_792_573_200_000 + @events.size)
  end

  def create(req)
    @colony = req.json["name"]
    event(t: "colony", colonyId: @colony)
    json(201, { id: @colony })
  end

  def snapshot
    json(200, { colony: { id: @colony, name: @colony, trunkSha: @head, createdAt: 0, regionDepth: 1 }, files: @trunk.keys.map { |p| { path: p, size: @trunk[p].bytesize } }, intents: [], agents: [], recentLandings: [], violations: { total: 0, byRule: {} }, funnel: { proof: 0, reflex: 0, llm: 0, human: 0 }, metrics: {} })
  end

  def declare(b)
    i = { "id" => id("int"), "title" => b["title"], "footprint" => b["footprint"], "assignedTo" => b["assignedTo"], "revision" => 1, "status" => b["assignedTo"] ? "claimed" : "open" }
    @intents[i["id"]] = i
    event(t: "intent", intentId: i["id"], status: i["status"], title: i["title"], footprint: i["footprint"])
    json(201, i)
  end

  def take(agent)
    intent = @intents.values.find { |i| i["assignedTo"] == agent && i["status"] == "claimed" && !i["taken"] }
    return json(200, { wait: true, retryInMs: 50, reason: "no open intents" }) unless intent

    intent["taken"] = true
    ws = "ws-#{agent}"
    init_workspace(ws) if @git_root
    remote = ->(name) { @git_root ? "#{@git_url}/git/#{name}.git" : "https://example.invalid/#{name}.git" }
    lease = { repo: { namespace: "ft-ws-0", name: ws, remote: remote.call(ws) }, token: "art_v1_lease#{agent}", baseSha: @head,
              trunk: { remote: remote.call("trunk"), token: "art_v1_trunk", sha: @head } }
    json(200, { intent: intent.except("taken"), lease: lease })
  end

  # --- proposals ------------------------------------------------------------------------------------------------------

  def propose(b)
    files = if b["contents"]
              b["writeSet"].to_h { |w| [w["path"], b.dig("contents", w["blob"])] }
            else
              b["writeSet"].to_h { |w| [w["path"], workspace_blob(b.dig("workspace", "name"), w["blob"])] }
            end
    return json(400, { error: "a written file's blob is not its text" }) unless files.all? { |p, t| t && Stage.blob_id(t) == b["writeSet"].find { |w| w["path"] == p }["blob"] }

    @pushed << { files: files.size, recipe: b["recipe"] } unless b["contents"]
    p = { "id" => id("prp"), "intentId" => b["intentId"], "agentId" => b["agentId"], "status" => "checking", "baseSha" => b["baseSha"],
          "files" => files, "reads" => b["readSet"].to_h { |r| [r["path"], r["blob"]] }, "recipe" => b["recipe"], "evidence" => { "checks" => [] } }
    @proposals[p["id"]] = p
    event(t: "proposal", proposalId: p["id"], intentId: p["intentId"], agentId: p["agentId"], status: "checking")
    json(201, public_of(p))
  end

  def public_of(p) = p.except("files", "baseSha", "reads", "recipe", "review")

  def poll(pid)
    p = @proposals[pid]
    return json(404, { error: "proposal not found" }) unless p

    settle(p) if p["status"] == "checking"
    json(200, public_of(p))
  end

  def settle(p)
    return review(p) if @review && p["recipe"] && !@lenient

    base = @trees.fetch(p["baseSha"])
    stale = (p["files"].keys + p["reads"].keys).uniq.select { |path| base[path] != @trunk[path] }
    if stale.empty?
      land(p, p["files"], nil)
    elsif @commute && @recipe && @order[p["baseSha"]] < @recipe[:seq] && stale.all? { |path| rename(base[path].to_s) == @trunk[path] }
      land(p, p["files"].transform_values { |t| rename(t) }, [{ "recipe" => @recipe[:id], "landing" => @recipe[:landing], "paths" => p["files"].keys }])
    else
      set(p, "returned", "stale: #{stale.first(3).join(', ')}")
    end
  end

  # The decide stage's deterministic rules for a change that names its recipe (see the class comment).
  def review(p)
    replay = @data["renamed"]
    base = @trees.fetch(p["baseSha"])
    reproduced = []
    residual = []
    p["files"].each do |path, text|
      if replay[path] == text then reproduced << [path, changed_lines(base[path], text)]
      else residual << [path, changed_lines(replay[path] || base[path], text), text.lines.find_index { |l| l.include?("fetch(") && !(replay[path] || "").include?(l) }]
      end
    end
    lines = reproduced.sum { |_, k| k }
    rest = residual.sum { |_, k, _| k }
    text = "#{lines} lines reproduced by rename-identifier@1, #{residual.empty? ? 'nothing else to review' : "#{rest} line#{rest == 1 ? '' : 's'} to review"}"
    repro = { "applied" => true, "reproduced" => { "files" => reproduced.size, "lines" => lines }, "residual" => { "files" => residual.size, "lines" => rest, "paths" => residual.map { |path, _, _| { "path" => path, "why" => "it differs from the recipe's output (shown against the replay)" } } }, "text" => text }
    danger = residual.select { |_, _, at| at }.map { |path, _, at| { "path" => path, "line" => at + 1, "cls" => "capability", "label" => "capability (network)" } }
    p["evidence"]["reproduction"] = repro
    p["evidence"]["checks"] << { "name" => "deterministic: reproduction", "ok" => true, "detail" => text }
    if residual.empty?
      gate(p, "D5 reproduced by recipe", "land", "reproduced by recipe: #{text}")
      land(p, p["files"], nil)
    elsif !danger.empty?
      reason = "danger patterns need a human: capability (network) in #{danger.first['path']}:#{danger.first['line']}"
      gate(p, "P1 danger pattern", "escalate", reason)
      p["review"] = { "files" => residual.map { |path, k, _| { "path" => path, "added" => k, "removed" => 0 } }, "danger" => danger, "residual" => [], "reproduction" => repro.slice("reproduced", "residual", "text").merge("recipe" => "rename-identifier@1") }
      set(p, "escalated", "escalated by deterministic: #{reason}")
    else
      gate(p, "D4 screen", "screen", "the residual goes to review")
      set(p, "returned", "returned by llm: the residual was not what the intent asks")
    end
  end

  def gate(p, rule, action, reason)
    p["evidence"]["checks"] << { "name" => "gate", "ok" => action == "land", "detail" => "#{rule} → #{action} by deterministic at head #{'e' * 12}: #{reason}", "gate" => { "rule" => rule, "preset" => "production", "values" => [] } }
  end

  def changed_lines(before, after)
    a = before.to_s.lines.tally
    b = after.to_s.lines.tally
    [b.sum { |l, k| [k - a.fetch(l, 0), 0].max }, a.sum { |l, k| [k - b.fetch(l, 0), 0].max }].max
  end

  def set(p, status, reason)
    p["status"] = status
    p["reason"] = reason
    event(t: "proposal", proposalId: p["id"], intentId: p["intentId"], agentId: p["agentId"], status: status, reason: reason)
  end

  def land(p, files, recipes)
    landing = commit(files, "#{p['id']}: its change")
    prop = { "id" => p["id"], "agentId" => p["agentId"], "writeSet" => files.map { |path, t| { "path" => path, "blob" => Stage.blob_id(t) } } }
    prop["recipes"] = recipes if recipes
    @notes[landing["id"]] = { "proposals" => [prop] }
    p["status"] = "landed"
    p["landingId"] = landing["id"]
    event(t: "proposal", proposalId: p["id"], intentId: p["intentId"], agentId: p["agentId"], status: "landed")
    event(t: "landing", landingId: landing["id"], trunkSha: landing["trunkSha"], proposalIds: [p["id"]], paths: files.keys)
  end

  # --- trunk ----------------------------------------------------------------------------------------------------------

  def commit(files, message)
    parent = @head
    @trunk = @trunk.merge(files)
    @head = @git_root ? git_commit(files, message) : Digest::SHA1.hexdigest("#{parent}#{files}")
    @trees[@head] = @trunk.dup
    @order[@head] = @order.size
    landing = { "id" => id("lnd"), "trunkSha" => @head, "parentSha" => parent, "paths" => files.keys }
    @landings << landing
    landing
  end

  def recipe(b)
    scope = @trunk.keys.select { |p| p.start_with?("src/") }.sort
    batches = scope.each_slice(100).filter_map do |slice|
      changed = slice.select { |p| @data["renamed"].key?(p) }
      next if changed.empty?

      landing = commit(changed.to_h { |p| [p, @data["renamed"][p]] }, "Recipe: rename-identifier")
      @notes[landing["id"]] = { "proposals" => [], "recipe" => { "id" => "rcp_1" } }
      event(t: "landing", landingId: landing["id"], trunkSha: landing["trunkSha"], proposalIds: [], paths: changed)
      { "landingId" => landing["id"], "files" => slice.size, "changed" => changed.size }
    end
    @recipe = { id: "rcp_1", landing: batches.last["landingId"], seq: @order[@head], args: b["args"] }
    record = { "id" => "rcp_1", "state" => "landed", "changed" => batches.sum { |x| x["changed"] }, "examined" => scope.size, "batches" => batches, "args" => b["args"], "recipe" => b.slice("kind", "args", "scope") }
    @record = record
    json(201, { intent: { id: id("int") }, recipe: record })
  end

  def residue(rid)
    grep = @trunk.select { |p, t| p.start_with?("src/") && t.match?(WORD) }.keys
    json(200, { record: @record.merge("id" => rid), residue: { examined: @trunk.size, rewrite: grep, untransformed: [], grep: grep } })
  end

  def why(path)
    json(200, @landings.reverse.select { |l| l["paths"].include?(path) }.map { |l| { landing: l, note: @notes[l["id"]] } })
  end

  # --- git ------------------------------------------------------------------------------------------------------------

  def git(*args, dir: @git_root)
    out, err, st = Open3.capture3({ "GIT_CONFIG_GLOBAL" => File::NULL, "GIT_CONFIG_NOSYSTEM" => "1", "GIT_AUTHOR_NAME" => "Trunk", "GIT_AUTHOR_EMAIL" => "trunk@example.com",
                                    "GIT_COMMITTER_NAME" => "Trunk", "GIT_COMMITTER_EMAIL" => "trunk@example.com" }, "git", *args, chdir: dir)
    raise "fake git #{args.first}: #{err}" unless st.success?

    out
  end

  def init_git
    FileUtils.mkdir_p(File.join(@git_root, "work"))
    git("init", "-q", "-b", "main", ".", dir: File.join(@git_root, "work"))
    git("commit", "-q", "--allow-empty", "-m", "root", dir: File.join(@git_root, "work"))
    git("clone", "-q", "--bare", "work", "trunk.git")
    @head = git("rev-parse", "HEAD", dir: File.join(@git_root, "work")).strip
    @order = { @head => 0 }
    @trees = { @head => {} }
  end

  def git_commit(files, message)
    work = File.join(@git_root, "work")
    files.each do |path, text|
      FileUtils.mkdir_p(File.dirname(File.join(work, path)))
      File.write(File.join(work, path), text)
    end
    git("add", "-A", dir: work)
    git("commit", "-q", "-m", message, dir: work)
    git("push", "-q", File.join(@git_root, "trunk.git"), "HEAD:refs/heads/main", dir: work)
    git("rev-parse", "HEAD", dir: work).strip
  end

  def init_workspace(name)
    dir = File.join(@git_root, "#{name}.git")
    return if Dir.exist?(dir)

    git("clone", "-q", "--bare", "trunk.git", "#{name}.git")
    git("config", "http.receivepack", "true", dir: dir)
  end

  def workspace_blob(name, blob)
    return nil unless @git_root

    out, _err, st = Open3.capture3({ "GIT_CONFIG_GLOBAL" => File::NULL, "GIT_CONFIG_NOSYSTEM" => "1" }, "git", "cat-file", "-p", blob.to_s, chdir: File.join(@git_root, "#{name}.git"))
    st.success? ? out : nil
  end
end
