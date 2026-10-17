# frozen_string_literal: true

# Tests for scripts/warm.rb, run as a command against a fake deployment on 127.0.0.1 behind a fake Cloudflare Access
# (403 without the service-token headers) that answers the reads the stage opens, the public MCP endpoint included.
#
#   ruby scripts/test/warm_test.rb
require "minitest/autorun"
require "tmpdir"
require "zlib"
require_relative "fake_deployment"

class WarmTest < Minitest::Test
  SCRIPT = File.expand_path("../warm.rb", __dir__)
  PAGE = "<!doctype html><html><body><div id=\"root\"></div></body></html>"

  # `broken`: a path that answers 500; `slow`: one that answers after 3 s; `access`: whether Access is in front.
  def router(broken: nil, slow: nil, access: true)
    lambda do |req|
      next [403, { "Content-Type" => "text/html" }, "Forbidden"] if access && !FakeDeployment.accessed?(req)
      next FakeDeployment.json(500, { error: "the colony object failed" }) if broken && req.path == broken

      sleep(3) if slow && req.path == slow
      case req.path
      when "/public/mcp" then FakeDeployment.mcp(req) { |_tool, _args| [false, {}] }
      when "/api/about" then FakeDeployment.json(200, { service: "firetrident", commit: "ea41814", flags: [] })
      when "/api/colonies" then FakeDeployment.json(200, { total: 2, colonies: [{ id: "hono" }, { id: "shortlinks" }] })
      when "/.well-known/firetrident-keys.json" then FakeDeployment.json(200, { keys: [] })
      when %r{\A/api/colonies/([a-z-]+)\z}
        FakeDeployment.json(200, { colony: { id: Regexp.last_match(1) },
                                   recentLandings: [{ id: "lnd_1", at: 1, paths: ["src/old.ts"] }, { id: "lnd_2", at: 2, paths: ["src/new.ts", "src/b.ts"] }] })
      when %r{\A/api/colonies/[a-z-]+/(agents|metrics|events|why)\z} then FakeDeployment.json(200, { ok: true })
      when "/recordings/hono.json.gz" then [200, { "Content-Type" => "application/gzip" }, Zlib.gzip("{}")]
      else [200, { "Content-Type" => "text/html" }, PAGE]
      end
    end
  end

  def warm(*args, access: true, **opts)
    server = FakeDeployment.new(&router(access: access, **opts))
    Dir.mktmpdir("warm-config") do |config|
      out, err, status = Open3.capture3(FakeDeployment.env(config, access: access), "ruby", SCRIPT, "--base", server.url, *args)
      [out, err, status.exitstatus, server.requests]
    end
  ensure
    server&.stop
  end

  def rows(out, pass)
    section = out.split(/^pass \d.*$/)[pass]
    section.lines.map(&:strip).reject(&:empty?).take_while { |l| !l.start_with?("passes took") }
  end

  def test_two_passes_read_everything_in_the_same_order_and_the_second_shows_the_first_time
    out, err, code, reqs = warm("--colonies", "hono,shortlinks", "--why", "shortlinks=src/links.ts")
    assert_equal 0, code, out + err
    first = rows(out, 1)
    second = rows(out, 2)
    labels = first.map { |l| l.split(/\s{2,}/).last }
    assert_equal ["/", "/api/about", "/api/colonies", "/.well-known/firetrident-keys.json", "/public/mcp initialize", "/public/mcp tools/list (5 tools)",
                  "/c/hono", "/c/hono?replay=1", "/api/colonies/hono", "/api/colonies/hono/agents?all=1&journal=0&limit=10000",
                  "/api/colonies/hono/events?after=0&limit=5000", "/api/colonies/hono/metrics", "/recordings/hono.json.gz",
                  "/api/colonies/hono/why?path=src%2Fnew.ts", "/c/shortlinks", "/c/shortlinks?replay=1", "/api/colonies/shortlinks",
                  "/api/colonies/shortlinks/agents?all=1&journal=0&limit=10000", "/api/colonies/shortlinks/events?after=0&limit=5000",
                  "/api/colonies/shortlinks/metrics", "/recordings/shortlinks.json.gz", "/api/colonies/shortlinks/why?path=src%2Flinks.ts"], labels
    assert(first.all? { |l| l.match?(/\A(200|ok|none) +\d+ ms  /) }, first.join("\n"))
    assert_match(%r{\Anone +\d+ ms  /recordings/shortlinks\.json\.gz\z}, first[20])
    assert_equal first.size, second.size
    assert(second.all? { |l| l.match?(/\(pass 1: \d+ ms\)\z/) }, second.join("\n"))
    assert_match(/^passes took \d+\.\d s, then \d+\.\d s$/, out)
    assert_includes out, "PASS warm: every read answered"
    # Read only and no token: GETs, plus the MCP client's POSTs; every request through Access.
    assert(reqs.all? { |r| r.method == "GET" || r.path == "/public/mcp" })
    assert(reqs.none? { |r| r.headers.key?("authorization") })
    assert(reqs.all? { |r| FakeDeployment.accessed?(r) })
    gets = reqs.select { |r| r.method == "GET" && r.path != "/public/mcp" }.map { |r| r.path }
    assert_equal gets.size / 2, gets.first(gets.size / 2).size
    assert_equal gets.first(gets.size / 2), gets.last(gets.size / 2), "both passes read the same things in the same order"
    [FakeDeployment::ACCESS_SECRET, FakeDeployment::ACCESS_ID, FakeDeployment::TOKEN].each { |s| refute_includes out + err, s }
  end

  def test_a_failing_read_is_named_and_exits_1
    out, _err, code, = warm("--passes", "1", broken: "/api/colonies/hono/metrics")
    assert_equal 1, code
    assert_match(%r{^  500 +\d+ ms  /api/colonies/hono/metrics \(HTTP 500: the colony object failed\)$}, out)
    assert_includes out, "FAIL warm: 1 read did not answer: /api/colonies/hono/metrics"
  end

  def test_a_read_past_its_time_limit_fails_without_holding_up_the_rest
    out, _err, code, = warm("--passes", "1", "--timeout", "1", slow: "/api/about")
    assert_equal 1, code
    assert_match(%r{^  fail +1\d{3} ms  /api/about \(no answer within 1\.0 s\)$}, out)
    assert_includes out, "/api/colonies/hono/why?path=src%2Fnew.ts"
  end

  def test_without_access_variables_no_access_header_is_sent
    out, _err, code, reqs = warm("--passes", "1", access: false)
    assert_equal 0, code, out
    assert(reqs.none? { |r| r.headers.key?("cf-access-client-id") || r.headers.key?("cf-access-client-secret") })
  end

  def test_behind_access_without_the_headers_every_read_fails
    server = FakeDeployment.new(&router(access: true))
    Dir.mktmpdir("warm-config") do |config|
      out, _err, status = Open3.capture3(FakeDeployment.env(config, access: false), "ruby", SCRIPT, "--base", server.url, "--passes", "1")
      assert_equal 1, status.exitstatus
      assert_match(%r{^  403 +\d+ ms  /api/about \(HTTP 403\)$}, out)
      assert_match(%r{^  fail +- +/public/mcp initialize \(initialize failed: .*Forbidden}, out)
    end
  ensure
    server&.stop
  end

  def test_bad_settings_exit_2
    _out, err, code, reqs = warm("--colonies", "Not A Colony")
    assert_equal 2, code
    assert_includes err, "not colony ids: Not A Colony"
    assert_empty reqs
  end
end
