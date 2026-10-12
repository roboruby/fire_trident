# A hand-driven FireTrident agent for end-to-end smoke tests: take → clone trunk (read token)
# → apply the rule's replacement → push to the workspace (write token) → propose → wait.
# Usage: ruby scripts/smoke_agent.rb <colony> [count]   (reads FT_URL/FT_TOKEN from ~/.config/firetrident/env)
# Never prints tokens.
require "json"
require "net/http"
require "uri"
require "open3"
require "tmpdir"

env = File.read(File.expand_path("~/.config/firetrident/env")).lines.to_h { |l| l.strip.split("=", 2) }
BASE = env.fetch("FT_URL")
TOKEN = env.fetch("FT_TOKEN")
colony = ARGV[0] or abort("usage: smoke_agent.rb <colony> [count]")
count = (ARGV[1] || "1").to_i

def api(method, path, body = nil)
  uri = URI("#{BASE}/api#{path}")
  req = (method == :get ? Net::HTTP::Get : Net::HTTP::Post).new(uri)
  req["Authorization"] = "Bearer #{TOKEN}"
  req["Content-Type"] = "application/json"
  req.body = JSON.generate(body) if body
  res = Net::HTTP.start(uri.host, uri.port, use_ssl: true, read_timeout: 120) { |h| h.request(req) }
  data = JSON.parse(res.body) rescue { "raw" => res.body[0, 300] }
  raise "#{method.upcase} #{path} -> #{res.code}: #{data.inspect[0, 400]}" unless res.code.to_i.between?(200, 299)
  data
end

def git(dir, *args, token: nil)
  cmd = ["git"]
  cmd += ["-c", "http.extraHeader=Authorization: Bearer #{token}"] if token
  cmd += ["-c", "protocol.version=2"]
  cmd += args
  out, err, st = Open3.capture3(*cmd, chdir: dir)
  raise "git #{args.first} failed: #{err.gsub(/art_v\d+_[A-Za-z0-9._~+\/=-]+/, '<redacted>')[0, 300]}" unless st.success?
  out.strip
end

def ruby_replacement(js)
  js.gsub(/\$(\d)/) { "\\#{Regexp.last_match(1)}" }
end

agent = api(:post, "/colonies/#{colony}/agents", { kind: "external", name: "manual-e2e", model: "rule-replacement" })
agent_id = agent["id"] || agent.dig("agent", "id")
puts "agent #{agent_id}"

count.times do |n|
  t0 = Time.now
  took = api(:post, "/colonies/#{colony}/agents/#{agent_id}/take")
  if took["wait"]
    puts "wait: #{took['reason']}"
    sleep((took["retryInMs"] || 2000) / 1000.0)
    next
  end
  intent, lease, rule = took.values_at("intent", "lease", "rule")
  puts "[#{n}] intent #{intent['id']} #{intent['title'][0, 70]} (take #{((Time.now - t0) * 1000).round} ms)"
  Dir.mktmpdir("ft-agent") do |dir|
    t1 = Time.now
    git(dir, "clone", "--quiet", "--branch", "main", "--depth", "1", lease.dig("trunk", "remote"), "w", token: lease.dig("trunk", "token"))
    w = File.join(dir, "w")
    head = git(w, "rev-parse", "HEAD")
    raise "clone head #{head} != lease base #{lease['baseSha']}" unless head == lease["baseSha"]
    spec = rule["spec"]
    re = Regexp.new(spec["pattern"])
    read_set = []
    write_set = []
    intent["footprint"].each do |path|
      old_blob = git(w, "rev-parse", "HEAD:#{path}")
      read_set << { path: path, blob: old_blob }
      src = File.read(File.join(w, path))
      fixed = src.gsub(re, ruby_replacement(spec["replacement"]))
      next if fixed == src
      File.write(File.join(w, path), fixed)
      write_set << { path: path }
    end
    git(w, "-c", "user.name=FireTrident manual agent", "-c", "user.email=manual@agents.firetrident.dev", "commit", "-qam", "#{intent['title']}\n\nFT-Intent: #{intent['id']}\nFT-Agent: #{agent_id}")
    head_sha = git(w, "rev-parse", "HEAD")
    write_set.each { |ws| ws[:blob] = git(w, "rev-parse", "HEAD:#{ws[:path]}") }
    git(w, "push", "--quiet", "--force", lease.dig("repo", "remote"), "HEAD:refs/heads/main", token: lease["token"])
    t2 = Time.now
    prop = api(:post, "/colonies/#{colony}/proposals", {
      intentId: intent["id"], agentId: agent_id, workspace: lease["repo"], baseSha: lease["baseSha"], headSha: head_sha,
      writeSet: write_set, readSet: read_set, declared: { footprint: intent["footprint"], summary: "Apply #{rule['description']}" },
      evidence: { notVerified: "Not verified: behavior beyond the rule check" }
    })
    pid = prop["id"]
    puts "    proposed #{pid} (git #{((t2 - t1) * 1000).round} ms)"
    status = prop["status"]
    40.times do
      break if %w[landed returned rejected escalated].include?(status)
      sleep 1
      status = api(:get, "/colonies/#{colony}/proposals/#{pid}")["status"]
    end
    p2 = api(:get, "/colonies/#{colony}/proposals/#{pid}")
    puts "    -> #{p2['status']} #{p2['landingId']} #{p2['reason'].to_s[0, 120]} (total #{((Time.now - t0) * 1000).round} ms)"
  end
end
