# frozen_string_literal: true

# A fake FireTrident deployment on 127.0.0.1 for the stage-script tests (beat_two_agents_test.rb, judge_path_test.rb,
# warm_test.rb, walkaway_test.rb): an HTTP server with no dependencies beyond Ruby (one thread per connection, every request recorded with
# its headers), stock git's smart HTTP through `git http-backend`, and a stateless JSON-RPC MCP endpoint answering as
# /public/mcp does.
require "json"
require "open3"
require "socket"
require "uri"

# Tests run git and the scripts without the user's or the system's git configuration.
ENV["GIT_CONFIG_GLOBAL"] = File::NULL
ENV["GIT_CONFIG_NOSYSTEM"] = "1"

class FakeDeployment
  Request = Struct.new(:method, :path, :query, :headers, :body, keyword_init: true) do
    def params = URI.decode_www_form(query.to_s).to_h
    def json = JSON.parse(body.to_s)
  end

  ACCESS_ID = "test-access-id-1234"
  ACCESS_SECRET = "test-access-secret-5678"
  TOKEN = "test-admin-token-abcdef"

  attr_reader :url

  # `router` takes a Request and answers [status, headers, body].
  def initialize(&router)
    @router = router
    @log = []
    @lock = Mutex.new
    @server = TCPServer.new("127.0.0.1", 0)
    @url = "http://127.0.0.1:#{@server.addr[1]}"
    @thread = Thread.new { accept_loop }
  end

  def requests = @lock.synchronize { @log.dup }

  def stop
    @server.close
  rescue IOError
    nil
  ensure
    @thread.join(2)
  end

  def self.json(status, body, headers = {}) = [status, { "Content-Type" => "application/json" }.merge(headers), JSON.generate(body)]

  # The environment a test runs a script with: no config file (XDG_CONFIG_HOME points at an empty directory), the
  # admin token when `token`, and the Access headers when `access`.
  def self.env(config_dir, token: true, access: true)
    env = { "XDG_CONFIG_HOME" => config_dir, "FT_TOKEN" => token ? TOKEN : nil, "FT_USER" => "stage-test",
            "CF_ACCESS_CLIENT_ID" => access ? ACCESS_ID : nil, "CF_ACCESS_CLIENT_SECRET" => access ? ACCESS_SECRET : nil }
    env
  end

  # Whether a request carried the Access headers with the test values.
  def self.accessed?(req) = req.headers["cf-access-client-id"] == ACCESS_ID && req.headers["cf-access-client-secret"] == ACCESS_SECRET

  # Serve a smart-HTTP git request for a repository under `root` (`/git/<name>.git/...`) through `git http-backend`.
  def self.git(root, req)
    env = {
      "GIT_PROJECT_ROOT" => root, "GIT_HTTP_EXPORT_ALL" => "1", "PATH_INFO" => req.path.delete_prefix("/git"),
      "QUERY_STRING" => req.query.to_s, "REQUEST_METHOD" => req.method, "CONTENT_TYPE" => req.headers["content-type"].to_s,
      "REMOTE_ADDR" => "127.0.0.1", "CONTENT_LENGTH" => req.body.to_s.bytesize.to_s
    }
    env["HTTP_CONTENT_ENCODING"] = req.headers["content-encoding"] if req.headers["content-encoding"]
    env["GIT_PROTOCOL"] = req.headers["git-protocol"] if req.headers["git-protocol"]
    out, _err, _status = Open3.capture3(env, "git", "http-backend", stdin_data: req.body.to_s, binmode: true)
    split = out.index("\r\n\r\n") ? "\r\n\r\n" : "\n\n"
    head, body = out.split(split, 2)
    headers = head.to_s.split(/\r?\n/).to_h { |l| l.split(":", 2).map(&:strip) }
    status = headers.delete("Status").to_s.to_i
    [status.zero? ? 200 : status, headers, body.to_s]
  end

  # Answer the public MCP endpoint statelessly: initialize, tools/list and tools/call (`call` takes the tool name and its
  # arguments and answers [error?, data]); a notification gets 202; a GET gets 405, as the real endpoint answers.
  def self.mcp(req, tools: %w[status why intent sense impact], &call)
    return [405, { "Allow" => "POST" }, JSON.generate({ jsonrpc: "2.0", error: { code: -32_000, message: "Method not allowed" }, id: nil })] unless req.method == "POST"

    body = req.json
    messages = body.is_a?(Array) ? body : [body]
    answers = messages.filter_map do |m|
      next unless m.key?("id")

      result = case m["method"]
               when "initialize"
                 { protocolVersion: m.dig("params", "protocolVersion"), capabilities: { tools: { listChanged: false } },
                   serverInfo: { name: "firetrident-public", version: "0.0.1" }, instructions: "A read-only view of public FireTrident colonies." }
               when "tools/list"
                 { tools: tools.map { |t| { name: t, description: "#{t} tool", inputSchema: { type: "object", properties: { colony: { type: "string" } }, required: ["colony"] } } } }
               when "tools/call"
                 error, data = call.call(m.dig("params", "name"), m.dig("params", "arguments") || {})
                 { content: [{ type: "text", text: JSON.generate(data) }], **(error ? { isError: true } : {}) }
               else
                 next({ jsonrpc: "2.0", id: m["id"], error: { code: -32_601, message: "Method not found" } })
               end
      { jsonrpc: "2.0", id: m["id"], result: result }
    end
    return [202, {}, ""] if answers.empty?

    json(200, body.is_a?(Array) ? answers : answers.first)
  end

  private

  def accept_loop
    loop do
      client = @server.accept
      Thread.new(client) { |c| handle(c) }
    end
  rescue IOError, SystemCallError
    nil
  end

  def handle(client)
    line = client.gets("\r\n").to_s
    method, target = line.split(" ", 3)
    return unless method && target

    headers = {}
    while (h = client.gets("\r\n")) && h != "\r\n"
      k, v = h.split(":", 2)
      headers[k.strip.downcase] = v.to_s.strip
    end
    body = read_body(client, headers)
    path, query = target.split("?", 2)
    req = Request.new(method: method, path: path, query: query, headers: headers, body: body)
    @lock.synchronize { @log << req }
    status, out_headers, out = @router.call(req)
    out = out.to_s.b
    head = ["HTTP/1.1 #{status} #{status == 200 ? 'OK' : 'X'}", "Content-Length: #{out.bytesize}", "Connection: close"]
    out_headers.each { |k, v| head << "#{k}: #{v}" unless %w[content-length connection].include?(k.downcase) }
    client.write("#{head.join("\r\n")}\r\n\r\n".b + out)
  rescue IOError, SystemCallError
    nil
  ensure
    client.close unless client.closed?
  end

  def read_body(client, headers)
    if headers["transfer-encoding"].to_s.downcase.include?("chunked")
      out = +"".b
      loop do
        size = client.gets("\r\n").to_s.strip.to_i(16)
        break if size.zero?

        out << client.read(size)
        client.read(2)
      end
      client.gets("\r\n")
      out
    elsif headers["content-length"].to_i.positive?
      client.read(headers["content-length"].to_i)
    else
      ""
    end
  end
end
