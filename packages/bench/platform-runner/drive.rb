#!/usr/bin/env ruby
# Drives the deployed bench runner (src/worker.ts) over HTTPS. The Worker URL comes from .runner-url and the bearer
# key from .runner-key (both gitignored, next to this script); neither is printed.
#   ruby drive.rb get /health | /trace | /about | /status | /_edge
#   ruby drive.rb start <agents> <intents> <tag> [extra scenario flags...]
#       CONN=<n> caps the run's connection pool (container/dispatcher.mjs), THREADS=<n> sets UV_THREADPOOL_SIZE
#   ruby drive.rb watch <tag> [from] [dir]   prints new log lines every 30 s until the run ends; exits with its exit code
#                                        (from: byte offset to start at, "tail" = the log's current size, "0" = start;
#                                        dir: fetch the run's result files there the moment it ends, before anything
#                                        can replace the container). Run it detached (nohup ... &) so it outlives the shell.
#   ruby drive.rb fetch <tag> <dir>      copies the run's result files (README.md, *.json, *.log) verbatim into <dir>
#   ruby drive.rb stop
require "json"
require "net/http"
require "uri"
require "fileutils"

HERE = __dir__
URL = File.read(File.join(HERE, ".runner-url")).strip
KEY = File.read(File.join(HERE, ".runner-key")).strip
POLL_S = 30

def request(method, path, query = {})
  uri = URI.join(URL, path)
  uri.query = URI.encode_www_form(query) unless query.empty?
  http = Net::HTTP.new(uri.host, uri.port)
  http.use_ssl = true
  http.open_timeout = 30
  http.read_timeout = 180
  req = (method == :post ? Net::HTTP::Post : Net::HTTP::Get).new(uri)
  req["authorization"] = "Bearer #{KEY}"
  http.request(req)
end

def must(res, what)
  abort "#{what}: HTTP #{res.code} #{res.body.to_s[0, 300]}" unless res.code.to_i.between?(200, 299)
  res
end

def status
  JSON.parse(must(request(:get, "/status"), "status").body)
end

cmd, *rest = ARGV
case cmd
when "get"
  res = request(:get, rest.fetch(0))
  puts "HTTP #{res.code} edge=#{res["x-edge-colo"]}"
  puts res.body
when "start"
  agents, intents, tag, *extra = rest
  abort "usage: start <agents> <intents> <tag> [extra...]" unless agents && intents && tag
  query = { tag: tag, agents: agents, intents: intents }
  query[:extra] = extra.join(" ") unless extra.empty?
  query[:conn] = ENV["CONN"] if ENV["CONN"]
  query[:threads] = ENV["THREADS"] if ENV["THREADS"]
  res = request(:post, "/start", query)
  puts "HTTP #{res.code} edge=#{res["x-edge-colo"]}"
  puts res.body
  exit(res.code.to_i == 202 ? 0 : 1)
when "watch"
  tag = rest.fetch(0)
  from = rest[1] == "tail" ? (status.dig("current", "logBytes") || 0) : rest.fetch(1, 0).to_i
  fetch_dir = rest[2]
  loop do
    res = request(:get, "/log", { tag: tag, from: from })
    if res.code.to_i == 200
      body = res.body.to_s
      unless body.empty?
        $stdout.write(body)
        $stdout.flush
        from += body.bytesize
      end
    end
    s = status
    cur = s["current"]
    if cur && cur["tag"] == tag && (cur["exitCode"] || cur["signal"])
      # one last read for anything written at exit
      res = request(:get, "/log", { tag: tag, from: from })
      $stdout.write(res.body.to_s) if res.code.to_i == 200
      puts "[watch] run #{tag} ended at #{cur["endedAt"]}: exit code #{cur["exitCode"].inspect} signal #{cur["signal"].inspect}"
      if fetch_dir
        out = `ruby #{__FILE__} fetch #{tag} #{fetch_dir} 2>&1`
        puts "[watch] fetch to #{fetch_dir}: #{$?.success? ? "ok" : "FAILED"}\n#{out}"
      end
      exit(cur["exitCode"].to_i)
    end
    sleep POLL_S
  end
when "fetch"
  tag, dir = rest
  abort "usage: fetch <tag> <dir>" unless tag && dir
  FileUtils.mkdir_p(dir)
  files = JSON.parse(must(request(:get, "/ls", { tag: tag }), "ls").body).fetch("files")
  abort "no result files for #{tag}" if files.empty?
  files.each do |f|
    name = f["path"].delete_prefix("#{tag}/")
    abort "unexpected nested path #{f["path"]}" if name.include?("/")
    data = +""
    from = 0
    loop do
      res = must(request(:get, "/file", { tag: tag, name: name, from: from }), "file #{name}")
      chunk = res.body.to_s.b
      data << chunk
      from += chunk.bytesize
      break if chunk.empty? || from >= res["x-file-size"].to_i
    end
    abort "#{name}: got #{data.bytesize} bytes, expected #{f["bytes"]}" unless data.bytesize == f["bytes"]
    File.binwrite(File.join(dir, name), data)
    puts "#{name}: #{data.bytesize} bytes"
  end
when "stop"
  res = request(:post, "/stop")
  puts "HTTP #{res.code}"
  puts res.body
else
  abort "usage: drive.rb get|start|watch|fetch|stop ..."
end
