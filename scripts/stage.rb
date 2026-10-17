# frozen_string_literal: true

# What the stage scripts share (scripts/beat_two_agents.rb, scripts/judge_path.rb, scripts/warm.rb, scripts/walkaway.rb):
# the deployment's base URL, the admin token, the Cloudflare Access service-token headers, HTTP with a hard time limit,
# child processes with one, a narration clock, and redaction. Every line a script prints goes through Stage.redact, so no
# token, lease token or Access secret is ever printed.
require "digest"
require "json"
require "net/http"
require "open3"
require "uri"
require "zlib"

module Stage
  # The ft CLI's default server (packages/cli/src/api.ts DEFAULT_URL): the server a config file without FT_URL is for.
  DEFAULT_URL = "https://firetrident.com"
  # The Node that runs these scripts, by absolute path, resolved once from the repository: inside a clone, a version manager
  # can switch to the version the cloned project pins (Hono pins one that may not be installed). NODE overrides it.
  NODE = ENV.fetch("NODE") do
    out, status = Open3.capture2("node", "-p", "process.execPath", chdir: File.expand_path("..", __dir__))
    status.success? && !out.strip.empty? ? out.strip : "node"
  rescue SystemCallError
    "node"
  end
  # Exit codes every stage script uses.
  EXIT_PASS = 0
  EXIT_FAIL = 1
  EXIT_USAGE = 2
  EXIT_TIMEOUT = 3

  # A setting is missing or wrong; the message says which and what to do.
  class ConfigError < StandardError; end

  # A step ran out of time; `waiting` says what it was still waiting for.
  class StepTimeout < StandardError
    attr_reader :waiting, :seconds

    def initialize(waiting, seconds)
      @waiting = waiting
      @seconds = seconds
      super("timed out after #{Stage.seconds(seconds)} s waiting for #{waiting}")
    end
  end

  def self.now = Process.clock_gettime(Process::CLOCK_MONOTONIC)

  # 90 for 90.0, 1.5 for 1.5: seconds as a person writes them.
  def self.seconds(s) = (s.to_f % 1).zero? ? s.to_i.to_s : s.to_f.round(1).to_s

  # The base URL from --base: http or https, trailing slashes dropped.
  def self.base_url(raw)
    text = raw.to_s.strip
    raise ConfigError, "pass --base <url>, for example --base https://staging.firetrident.com" if text.empty?

    uri = begin
      URI.parse(text)
    rescue URI::InvalidURIError
      nil
    end
    raise ConfigError, "--base is not an http(s) URL: #{text}" unless uri.is_a?(URI::HTTP) && !uri.host.to_s.empty?

    text.sub(%r{/+\z}, "")
  end

  # Scheme, host and port of a URL, or nil when it does not parse.
  def self.origin(url)
    uri = URI.parse(url.to_s.strip)
    return nil unless uri.is_a?(URI::HTTP) && !uri.host.to_s.empty?

    "#{uri.scheme}://#{uri.host.downcase}:#{uri.port}"
  rescue URI::InvalidURIError
    nil
  end

  # The ft config file: $XDG_CONFIG_HOME/firetrident/env, else ~/.config/firetrident/env (packages/cli/src/config.ts).
  def self.config_path(env = ENV)
    xdg = env["XDG_CONFIG_HOME"].to_s.strip
    return File.join(xdg.sub(%r{/+\z}, ""), "firetrident", "env") unless xdg.empty?

    home = env["HOME"].to_s.strip
    home.empty? ? nil : File.join(home, ".config", "firetrident", "env")
  end

  # KEY=value lines as the ft CLI reads them: blank lines and # comments skipped, `export ` and matching quotes allowed.
  def self.parse_env_file(text)
    text.to_s.each_line.with_object({}) do |raw, out|
      line = raw.strip
      next if line.empty? || line.start_with?("#")

      m = line.match(/\A(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\z/)
      next unless m

      value = m[2].strip
      quoted = value.length >= 2 && ['"', "'"].include?(value[0]) && value.end_with?(value[0])
      out[m[1]] = quoted ? value[1..-2] : value.sub(/\s+#.*\z/, "")
    end
  end

  # The admin token for `base`: FT_TOKEN from the environment, else the config file's FT_TOKEN when that file's FT_URL
  # (or the ft default) is this deployment, as the ft CLI decides: a token is never sent to a server it was not issued
  # for. Nil when there is none.
  def self.token(base, env = ENV)
    from_env = env["FT_TOKEN"].to_s.strip
    return from_env unless from_env.empty?

    path = config_path(env)
    return nil unless path && File.file?(path)

    file = parse_env_file(File.read(path))
    token = file["FT_TOKEN"].to_s.strip
    issued_for = file["FT_URL"].to_s.strip
    issued_for = DEFAULT_URL if issued_for.empty?
    !token.empty? && origin(issued_for) && origin(issued_for) == origin(base) ? token : nil
  end

  # The Cloudflare Access service-token headers from CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET (both or neither,
  # as the ft CLI's accessHeaders reads them); empty when neither is set.
  def self.access_headers(env = ENV)
    id = env["CF_ACCESS_CLIENT_ID"].to_s.strip
    secret = env["CF_ACCESS_CLIENT_SECRET"].to_s.strip
    return {} if id.empty? && secret.empty?
    if id.empty? || secret.empty?
      raise ConfigError, "set both CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET to reach a deployment behind Cloudflare Access, or neither"
    end

    { "CF-Access-Client-Id" => id, "CF-Access-Client-Secret" => secret }
  end

  # `text` with every secret, and anything shaped like an Artifacts token, replaced by <redacted>.
  def self.redact(text, secrets = [])
    out = text.to_s.gsub(/art_v\d+_[A-Za-z0-9._~+\/=-]+/, "<redacted>")
    secrets.each { |s| out = out.gsub(s, "<redacted>") if s.is_a?(String) && s.length >= 4 }
    out
  end

  # The git blob id of a text, as core's blobId computes it (packages/core/src/changeset.ts).
  def self.blob_id(text)
    bytes = text.to_s.encode(Encoding::UTF_8).scrub("\u{FFFD}").b
    Digest::SHA1.hexdigest("blob #{bytes.bytesize}\0".b + bytes)
  end

  # An inline change's head: SHA-1 of its base and its write set sorted by path, as core's changesetId computes it.
  def self.changeset_id(base_sha, write_set)
    lines = write_set.sort_by { |w| w[:path].b }.map { |w| "#{w[:path]}\0#{w[:blob] || ('0' * 40)}\n" }.join
    Digest::SHA1.hexdigest("changeset #{base_sha}\n#{lines}".b)
  end

  # Elapsed time and narration: each line starts with the seconds since the clock started.
  class Clock
    def initialize(out: $stdout, secrets: [])
      @out = out
      @secrets = secrets
      @t0 = Stage.now
    end

    def elapsed = Stage.now - @t0

    def say(line = "")
      @out.puts(line.empty? ? "" : format("[%6.1fs] %s", elapsed, Stage.redact(line, @secrets)))
      @out.flush
    end

    # A line without the clock (tables and listings).
    def print(line = "")
      @out.puts(Stage.redact(line, @secrets))
      @out.flush
    end
  end

  # One HTTP answer. `code` is 0 when nothing came back, with `error` saying why.
  Response = Struct.new(:code, :body, :headers, :ms, :error, keyword_init: true) do
    def ok? = error.nil? && code.between?(200, 299)

    def json
      return @json if defined?(@json)

      @json = begin
        JSON.parse(body.to_s)
      rescue JSON::ParserError
        nil
      end
    end

    def content_type = headers.fetch("content-type", "").to_s.downcase

    # What came back, in a few words: the HTTP status and the error the server named, or why nothing came back.
    def problem
      return error if error

      named = json.is_a?(Hash) ? json["error"] : nil
      "HTTP #{code}#{named ? ": #{named.to_s[0, 200]}" : ''}"
    end
  end

  # HTTP to one deployment: the Access headers on every request, the admin token where asked, a hard time limit on each
  # request, and one kept-alive connection (so a timing measures the request, not a new TLS handshake each time).
  class Http
    attr_reader :base

    METHODS = { get: Net::HTTP::Get, post: Net::HTTP::Post, delete: Net::HTTP::Delete, patch: Net::HTTP::Patch }.freeze

    def initialize(base, token: nil, access: {})
      @base = base
      @token = token
      @access = access
      @conns = {}
    end

    # One request to `path` (relative to the base, or a full URL). Never raises for a network failure or a timeout:
    # those come back with code 0 and an error. `auth: false` leaves the admin token off.
    def request(method, path, body: nil, headers: {}, timeout: 30, auth: true)
      uri = URI(path.start_with?("http://", "https://") ? path : "#{@base}#{path}")
      req = METHODS.fetch(method).new(uri)
      @access.each { |k, v| req[k] = v }
      req["Authorization"] = "Bearer #{@token}" if @token && auth
      req["Accept"] = "application/json"
      headers.each { |k, v| req[k] = v }
      unless body.nil?
        req["Content-Type"] = "application/json"
        req.body = body.is_a?(String) ? body : JSON.generate(body)
      end
      limit = [timeout.to_f, 0.1].max
      t = Stage.now
      begin
        conn = connection(uri, limit)
        conn.read_timeout = limit
        conn.write_timeout = limit
        res = conn.request(req)
      rescue Net::OpenTimeout, Net::ReadTimeout, Net::WriteTimeout
        drop(uri)
        return Response.new(code: 0, body: "", headers: {}, ms: ms_since(t), error: "no answer within #{format('%.1f', limit)} s")
      rescue SocketError, SystemCallError, IOError, EOFError, OpenSSL::SSL::SSLError, Net::HTTPBadResponse, Zlib::Error => e
        drop(uri)
        return Response.new(code: 0, body: "", headers: {}, ms: ms_since(t), error: "#{e.class.name.split('::').last}: #{e.message}")
      end
      Response.new(code: res.code.to_i, body: res.body.to_s, headers: res.each_header.to_h, ms: ms_since(t))
    end

    def get(path, **kw) = request(:get, path, **kw)

    def close
      @conns.each_value { |c| c.finish if c.started? }
      @conns.clear
    end

    private

    def ms_since(t) = ((Stage.now - t) * 1000).round

    def connection(uri, limit)
      key = "#{uri.scheme}://#{uri.host}:#{uri.port}"
      conn = @conns[key]
      return conn if conn&.started?

      conn = Net::HTTP.new(uri.host, uri.port)
      conn.use_ssl = uri.scheme == "https"
      conn.open_timeout = [limit, 10].min
      conn.keep_alive_timeout = 30
      # Net::HTTP sends an idempotent request again after a timeout; a hard limit means one attempt.
      conn.max_retries = 0
      conn.start
      @conns[key] = conn
    end

    def drop(uri)
      conn = @conns.delete("#{uri.scheme}://#{uri.host}:#{uri.port}")
      conn&.finish if conn&.started?
    rescue IOError
      nil
    end
  end

  # Run a command with a hard time limit, in its own process group (so a git clone's helpers stop with it). Returns
  # [success, stdout, stderr, timed_out]. Nothing it prints is shown here: the caller redacts what it shows.
  def self.run(cmd, env: {}, chdir: Dir.pwd, timeout: 60)
    out = +""
    err = +""
    Open3.popen3(env, *cmd, chdir: chdir, pgroup: true) do |stdin, stdout, stderr, wait|
      stdin.close
      readers = [Thread.new { out << stdout.read.to_s }, Thread.new { err << stderr.read.to_s }]
      if wait.join(timeout).nil?
        kill_group(wait.pid)
        readers.each { |r| r.join(2) }
        return [false, out, err, true]
      end
      readers.each(&:join)
      [wait.value.success?, out, err, false]
    end
  end

  def self.kill_group(pid)
    %w[TERM KILL].each do |sig|
      Process.kill(sig, -pid)
      sleep 0.5
    rescue Errno::ESRCH, Errno::EPERM
      break
    end
  end

  # Git's environment for a stock clone: no system or user configuration and no prompts, and the Access headers as
  # http.extraHeader entries passed through GIT_CONFIG_COUNT (git's documented equivalent of `git -c`), so the secret
  # never appears on a command line.
  def self.git_env(access)
    env = { "GIT_CONFIG_NOSYSTEM" => "1", "GIT_CONFIG_GLOBAL" => File::NULL, "GIT_TERMINAL_PROMPT" => "0", "GIT_ASKPASS" => "", "SSH_ASKPASS" => "" }
    env["GIT_CONFIG_COUNT"] = access.size.to_s
    access.each_with_index do |(name, value), i|
      env["GIT_CONFIG_KEY_#{i}"] = "http.extraHeader"
      env["GIT_CONFIG_VALUE_#{i}"] = "#{name}: #{value}"
    end
    env
  end

  # The command a judge types for the same clone, with the Access headers as shell variables, never their values.
  def self.judge_clone_command(url, access)
    return "git clone #{url}" if access.empty?

    "git -c http.extraHeader=\"CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID\" -c http.extraHeader=\"CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET\" clone #{url}"
  end

  # Ask the public MCP endpoint through the MCP SDK's client (scripts/mcp_ask.ts): `calls` are [tool, args] pairs, and
  # `access` the Access headers it sends (through its environment, never its arguments). Returns the helper's JSON
  # answer, or a Hash with ok: false and the error.
  def self.mcp_ask(base, calls: [], timeout: 30, access: {})
    script = File.expand_path("mcp_ask.ts", __dir__)
    cmd = [NODE, script, "--url", base, "--timeout", timeout.to_s]
    calls.each { |tool, args| cmd += ["--call", "#{tool}=#{JSON.generate(args)}"] }
    pass = { "CF_ACCESS_CLIENT_ID" => access["CF-Access-Client-Id"].to_s, "CF_ACCESS_CLIENT_SECRET" => access["CF-Access-Client-Secret"].to_s }
    ok, out, err, timed_out = run(cmd, env: pass, chdir: File.expand_path("..", __dir__), timeout: timeout + 10)
    return { "ok" => false, "error" => "the MCP client did not finish within #{timeout + 10} s" } if timed_out

    answer = begin
      JSON.parse(out.lines.last.to_s)
    rescue JSON::ParserError
      nil
    end
    return answer if answer.is_a?(Hash)

    { "ok" => false, "error" => "the MCP client failed#{ok ? '' : ' to start'}: #{err.strip.lines.last.to_s.strip[0, 300]}" }
  end
end
