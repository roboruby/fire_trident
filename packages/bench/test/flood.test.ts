import { describe, expect, it } from "vitest";
import { GreedyTally, HonestTally, McpSession, Reservoir, floodReport, greedyLoop, honestAgent, parseFloodOptions, parseSse, phaseStats } from "../src/scenarios/flood.ts";

/** The flood scenario's MCP client and loops against a fake MCP server behind an injected fetch (no network). */

const TOKEN = "test-mcp";

interface FakeOptions {
  /** Tool calls a greedy session may make (its join included) before every call answers rate_limit. */
  greedyCalls?: number;
  /** Every n-th tool call of an honest session answers rate_limit. */
  refuseHonestEvery?: number;
  retryAfterMs?: number;
  /** Answer with application/json instead of server-sent events. */
  json?: boolean;
  /** What propose answers instead of a proposal. */
  proposeError?: Record<string, unknown>;
}

/** A fake Streamable HTTP MCP server: sessions, a few tools, and an optional call budget per session. */
function fakeMcp(opts: FakeOptions = {}): { fetchImpl: typeof fetch; requests: Array<{ method: string; headers: Headers }> } {
  const sessions = new Map<string, { name: string; calls: number; proposals: number }>();
  const requests: Array<{ method: string; headers: Headers }> = [];
  let opened = 0;
  const answer = (id: number, result: unknown, headers: Record<string, string> = {}): Response => {
    const body = JSON.stringify({ jsonrpc: "2.0", id, result });
    if (opts.json) return new Response(body, { status: 200, headers: { "content-type": "application/json", ...headers } });
    // A keepalive comment first, as the server sends while a call waits.
    return new Response(`: keepalive\n\nevent: message\ndata: ${body}\n\n`, { status: 200, headers: { "content-type": "text/event-stream", ...headers } });
  };
  const tool = (data: unknown) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
  const toolError = (error: Record<string, unknown>) => ({ isError: true, structuredContent: { error }, content: [{ type: "text", text: JSON.stringify({ error }) }] });
  const limited = () => toolError({ kind: "rate_limit", message: "too many calls from this session", retryable: true, retryAfterMs: opts.retryAfterMs ?? 5, status: 429 });
  const fetchImpl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    await new Promise((r) => setImmediate(r)); // a request yields to the event loop, as real I/O does
    const headers = new Headers(init?.headers);
    if (headers.get("authorization") !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });
    if (init?.method === "DELETE") {
      sessions.delete(headers.get("mcp-session-id") ?? "");
      return new Response(null, { status: 204 });
    }
    const msg = JSON.parse(String(init?.body)) as { id: number; method: string; params?: { name: string; arguments: Record<string, unknown> } };
    requests.push({ method: msg.method, headers });
    if (msg.method === "initialize") {
      const id = `s${++opened}`;
      sessions.set(id, { name: "", calls: 0, proposals: 0 });
      return answer(msg.id, { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake", version: "0" } }, { "mcp-session-id": id });
    }
    const s = sessions.get(headers.get("mcp-session-id") ?? "");
    if (!s) return new Response("Session not found", { status: 404 });
    if (msg.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (msg.method === "tools/list") return answer(msg.id, { tools: [{ name: "propose", inputSchema: { type: "object", properties: { headSha: {}, files: {} } } }, { name: "join", inputSchema: {} }] });
    if (msg.method !== "tools/call" || !msg.params) return new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } }), { status: 200, headers: { "content-type": "application/json" } });
    const { name, arguments: args } = msg.params;
    s.calls++;
    if (name === "join") s.name = String(args.name ?? "");
    if (opts.greedyCalls !== undefined && s.name.startsWith("flood-greedy") && s.calls > opts.greedyCalls) return answer(msg.id, limited());
    if (opts.refuseHonestEvery !== undefined && s.name.startsWith("flood-honest") && s.calls % opts.refuseHonestEvery === 0) return answer(msg.id, limited());
    switch (name) {
      case "join":
        return answer(msg.id, tool({ agentId: `agt_${s.name}` }));
      case "take":
        return answer(msg.id, tool({ intent: { id: `int_${s.name}_${s.proposals}`, footprint: [`flood/r00/${s.name}-${s.proposals}.txt`] } }));
      case "read":
        return answer(msg.id, tool({ path: args.path, blob: null, size: 0 }));
      case "propose":
        if (opts.proposeError) return answer(msg.id, toolError(opts.proposeError));
        s.proposals++;
        return answer(msg.id, tool({ proposal: { id: `prp_${s.name}_${s.proposals}`, status: "checking" } }));
      case "inbox":
        return answer(msg.id, tool(args.proposalId ? { watching: { id: args.proposalId, status: "landed", final: true } } : { proposals: [] }));
      case "sense":
        return answer(msg.id, tool({ readings: [] }));
      case "release":
        return answer(msg.id, tool({ released: null }));
      default:
        return answer(msg.id, toolError({ kind: "not_found", message: `Tool ${name} not found`, retryable: false, status: 404 }));
    }
  };
  return { fetchImpl: fetchImpl as typeof fetch, requests };
}

async function joined(fetchImpl: typeof fetch, name: string): Promise<McpSession> {
  const s = new McpSession("https://ft.invalid", TOKEN, name, fetchImpl);
  await s.open();
  expect((await s.call("join", { colony: "c", name })).ok).toBe(true);
  return s;
}

describe("the scenario's MCP client", () => {
  it("reads the JSON messages of a server-sent event stream", () => {
    const text = ': keepalive\r\n\r\nevent: message\r\ndata: {"id":1,\r\ndata: "result":{}}\r\n\r\ndata: not json\n\nid: 3\ndata: {"id":2}\n\n';
    expect(parseSse(text)).toEqual([{ id: 1, result: {} }, { id: 2 }]);
    expect(parseSse("")).toEqual([]);
  });

  it("opens a session, sends its id and protocol version with every later request, and parses tool answers", async () => {
    for (const json of [false, true]) {
      const server = fakeMcp({ json });
      const s = new McpSession("https://ft.invalid", TOKEN, "flood-honest-1", server.fetchImpl);
      await s.open();
      expect(s.sessionId).toBe("s1");
      const j = await s.call<{ agentId: string }>("join", { colony: "c", name: "flood-honest-1" });
      expect(j).toMatchObject({ ok: true, data: { agentId: "agt_flood-honest-1" }, error: null });
      expect((await s.tools()).get("propose")).toEqual(["headSha", "files"]);
      const missing = await s.call("land");
      expect(missing).toMatchObject({ ok: false, data: null, error: { kind: "not_found", status: 404 } });
      const [init, ...later] = server.requests;
      expect(init?.method).toBe("initialize");
      expect(init?.headers.get("mcp-session-id")).toBeNull();
      for (const r of later) expect([r.headers.get("mcp-session-id"), r.headers.get("mcp-protocol-version")]).toEqual(["s1", "2025-06-18"]);
      await s.close();
      expect(s.sessionId).toBeNull();
    }
  });

  it("answers failures without throwing: an HTTP status, a JSON-RPC error, a network failure", async () => {
    const server = fakeMcp();
    await expect(new McpSession("https://ft.invalid", "wrong", "x", server.fetchImpl).open()).rejects.toThrow(/HTTP 401/);
    const s = await joined(server.fetchImpl, "flood-honest-1");
    const id = s.sessionId;
    await s.close();
    s.sessionId = id; // a session the server ended
    expect(await s.call("inbox")).toMatchObject({ ok: false, error: { kind: "transport", status: 404 } });
    const broken = new McpSession("https://ft.invalid", TOKEN, "x", (async () => {
      throw new Error("fetch failed: Bearer abcdefgh refused");
    }) as typeof fetch);
    const a = await broken.call("inbox");
    expect(a.error?.kind).toBe("transport");
    expect(a.error?.message).not.toContain("abcdefgh");
  });
});

describe("the flood", () => {
  it("counts greedy calls answered 429 apart from those that reached the server, while the honest agents land", async () => {
    const server = fakeMcp({ greedyCalls: 10 });
    const honest = await Promise.all([joined(server.fetchImpl, "flood-honest-1"), joined(server.fetchImpl, "flood-honest-2")]);
    const greedy = await Promise.all([joined(server.fetchImpl, "flood-greedy-1"), joined(server.fetchImpl, "flood-greedy-2")]);
    const h = new HonestTally();
    const g = new GreedyTally();
    const start = Date.now();
    await Promise.all([
      ...honest.map((s) => honestAgent(s, { until: start + 1_200, drainUntil: start + 5_000 }, h)),
      ...greedy.flatMap((s) => [greedyLoop(s, "inbox", start + 300, g), greedyLoop(s, "inbox", start + 300, g)]),
    ]);
    const end = Date.now();
    // Each greedy session's join took one of its ten calls: nine reached the server, and every other call was refused.
    expect(g.answered).toBe(18);
    expect(g.refused).toBe(g.calls - 18);
    expect(g.refused).toBeGreaterThan(0);
    expect(new Set(g.retryAfterMs.values)).toEqual(new Set([5]));
    expect(g.errors).toEqual({});
    // The honest agents were never refused, and every change they proposed landed.
    expect(h.refused).toBe(0);
    expect(h.landings.length).toBeGreaterThan(0);
    expect(h.outcomes).toEqual({ landed: h.landings.length });
    expect(h.rec.summary("propose").n).toBe(h.landings.length);

    const opts = parseFloodOptions(["--colony", "flood-test", "--greedy", "2", "--concurrency", "2", "--honest", "2", "--duration", "1", "--label", "on"]);
    const report = floodReport({ opts, url: "https://ft.invalid", createdColony: true, timeline: { start, floodAt: start, end }, honest: h, greedy: g, generatedAt: "2026-10-14T00:00:00.000Z" });
    expect(report).toMatchObject({
      kind: "flood",
      label: "MEASURED",
      run: "on",
      colony: "flood-test",
      budgetSeen: true,
      honest: { agents: 2, flood: { landed: h.landings.length }, refused429: 0, outcomes: { landed: h.landings.length } },
      greedy: { sessions: 2, loops: 4, tool: "inbox", calls: g.calls, answered429: g.refused, reachedColony: 18 },
      errors: [],
    });
    expect(report.honest).not.toHaveProperty("baseline");
  });

  it("has honest agents repeat a refused call after retryAfterMs, and stop when the colony refuses inline changes", async () => {
    const server = fakeMcp({ refuseHonestEvery: 3 });
    const h = new HonestTally();
    const start = Date.now();
    await honestAgent(await joined(server.fetchImpl, "flood-honest-1"), { until: start + 1_100, drainUntil: start + 5_000 }, h);
    expect(h.refused).toBeGreaterThan(0);
    expect(h.landings.length).toBeGreaterThan(0);
    expect(h.outcomes).toEqual({ landed: h.landings.length });

    const off = fakeMcp({ proposeError: { kind: "conflict", message: "inline changes are off for this colony: push a commit to your workspace and propose its headSha", retryable: false, status: 409 } });
    await expect(honestAgent(await joined(off.fetchImpl, "flood-honest-1"), { until: Date.now() + 1_500, drainUntil: Date.now() + 5_000 }, new HonestTally())).rejects.toThrow(/refuses inline changes/);
  });

  it("splits the honest agents' landings by phase: landings a minute, and propose to landed for changes proposed in it", () => {
    const landings = [
      { proposedAt: 0, landedAt: 2_000 },
      { proposedAt: 50_000, landedAt: 61_000 }, // proposed in the baseline, landed in the flood
      { proposedAt: 70_000, landedAt: 74_000 },
      { proposedAt: 100_000, landedAt: 106_000 },
      { proposedAt: 118_000, landedAt: 125_000 }, // landed while draining
    ];
    expect(phaseStats(landings, 0, 60_000)).toMatchObject({ seconds: 60, landed: 1, landingsPerMin: 1, proposeToLandedMs: { n: 2, p50: 2_000, max: 11_000 } });
    const flood = phaseStats(landings, 60_000, 120_000);
    expect(flood).toMatchObject({ seconds: 60, landed: 3, landingsPerMin: 3, proposeToLandedMs: { n: 3, p50: 6_000, max: 7_000 } });
    expect(phaseStats([], 0, 0)).toMatchObject({ landed: 0, landingsPerMin: 0, proposeToLandedMs: { n: 0, p50: null } });
  });

  it("keeps a uniform sample of a long stream", () => {
    let seed = 1;
    const r = new Reservoir(100, () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646);
    for (let i = 0; i < 100_000; i++) r.add(i);
    expect(r.values).toHaveLength(100);
    // Uniform over the stream, not its first hundred values.
    expect(r.values.filter((v) => v >= 50_000).length).toBeGreaterThan(30);
  });
});

describe("flood options", () => {
  it("default to 16 greedy sessions of 4 loops, 4 honest agents and two minutes, on a new colony", () => {
    const o = parseFloodOptions([], () => 36 ** 3);
    expect(o).toMatchObject({ colony: "flood-1000", reuse: false, keep: false, greedy: 16, concurrency: 4, honest: 4, durationS: 120, baselineS: 0, drainS: 60, tool: "inbox", regions: 4, label: null, out: "flood.json", allowProduction: false });
    // One intent per honest agent for every two seconds of the run.
    expect(o.intents).toBe(4 * 60);
    expect(parseFloodOptions(["--honest", "2", "--baseline", "60", "--duration", "60"]).intents).toBe(2 * 60);
    expect(parseFloodOptions(["--tool", "sense", "--greedy", "0", "--reuse", "--keep", "--colony", "bench-1"])).toMatchObject({ tool: "sense", greedy: 0, reuse: true, keep: true, colony: "bench-1" });
  });

  it("refuse values they cannot use", () => {
    expect(() => parseFloodOptions(["--tool", "take"])).toThrow(/--tool must be inbox or sense/);
    expect(() => parseFloodOptions(["--honest", "0"])).toThrow(/--honest must be a whole number of at least 1/);
    expect(() => parseFloodOptions(["--duration", "1.5"])).toThrow(/--duration/);
    expect(() => parseFloodOptions(["--colony", "Not A Slug"])).toThrow(/--colony must be a lowercase slug/);
    expect(() => parseFloodOptions(["--greedy"])).toThrow();
  });
});
