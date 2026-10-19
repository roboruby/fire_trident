import { afterEach, describe, expect, it, vi } from "vitest";
import { scopedMcp } from "../../src/accounts/mcpscope.ts";
import type { Env } from "../../src/env.ts";
import { mcpRefusal } from "../../src/mcp/gate.ts";
import { MCP, ORIGIN } from "./fakes.ts";
import { world } from "./world.ts";

/**
 * Scoped tokens at /mcp: an agent or owner token opens the agents' MCP endpoint for its own colony only, its session is
 * bound to it, and every other request reaches the MCP gate as before.
 */

// The world fakes Date so every part shares one clock (accounts/scope.ts reads Date.now).
afterEach(() => {
  vi.useRealTimers();
});

const ada = { id: 101, login: "ada", name: "Ada" };
const bob = { id: 202, login: "bob" };

/** The MCP server behind the gate: answers an initialize with a new session id, records what reached it. */
function mcpServer() {
  const reached: Array<{ session: string | null; body: string; auth: string | null }> = [];
  let n = 0;
  const forward = async (req: Request) => {
    const session = req.headers.get("mcp-session-id");
    reached.push({ session, body: req.method === "POST" ? await req.text() : "", auth: req.headers.get("authorization") });
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (!session) headers["mcp-session-id"] = `session-${++n}`;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { headers });
  };
  return { reached, forward };
}

const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } };
const join = (colony: string, id = 2) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "join", arguments: { colony, name: "bot" } } });

function post(token: string, body: unknown, session?: string, path = "/mcp"): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream", ...(session ? { "mcp-session-id": session } : {}) },
    body: JSON.stringify(body),
  });
}

async function owned() {
  const w = world();
  const me = await w.person(ada);
  expect((await me.call("POST", "/api/me/colonies", { body: { name: "web" } })).status).toBe(201);
  const mint = async (role: string, colony = "web", who = me) => {
    const res = await who.call("POST", `/api/me/colonies/${colony}/tokens`, { body: { role, label: role } });
    expect(res.status).toBe(201);
    return (await res.json()) as { secret: string; token: { id: string } };
  };
  return { w, me, mint };
}

describe("a scoped token at /mcp", () => {
  it("opens a session bound to it and joins its own colony", async () => {
    const { w, mint } = await owned();
    const agent = await mint("agent");
    const s = mcpServer();
    const opened = await scopedMcp(post(agent.secret, initialize), w.env, s.forward);
    expect(opened?.status).toBe(200);
    const session = opened?.headers.get("mcp-session-id") ?? "";
    expect(session).toBe("session-1");
    const joined = await scopedMcp(post(agent.secret, join(" WEB "), session), w.env, s.forward);
    expect(joined?.status).toBe(200);
    expect(s.reached.map((r) => r.session)).toEqual([null, "session-1"]);
    // The body reaches the server as sent.
    expect(JSON.parse(s.reached[1]?.body ?? "{}")).toEqual(join(" WEB "));
    // An owner token works too.
    const owner = await mint("owner");
    expect((await scopedMcp(post(owner.secret, initialize), w.env, s.forward))?.status).toBe(200);
  });

  it("never joins another colony, an operator colony included, even inside a batch", async () => {
    const { w, mint } = await owned();
    await w.operatorColony("showcase");
    const agent = await mint("agent");
    const s = mcpServer();
    const session = (await scopedMcp(post(agent.secret, initialize), w.env, s.forward))?.headers.get("mcp-session-id") ?? "";
    for (const body of [join("showcase", 7), [join("web", 8), join("bobs", 9)], { ...join("web"), params: { name: "join", arguments: { colony: 42 } } }]) {
      const res = await scopedMcp(post(agent.secret, body, session), w.env, s.forward);
      expect(res?.status).toBe(403);
      const answer = (await res?.json()) as { jsonrpc: string; id: unknown; error: { message: string } };
      expect(answer.jsonrpc).toBe("2.0");
      expect(answer.error.message).toMatch(/^This token is for colony web only, so it cannot join colony /);
    }
    expect(s.reached).toHaveLength(1);
  });

  it("keeps its session to itself: another token, or the deployment's, cannot continue it, and it cannot continue another", async () => {
    const { w, mint } = await owned();
    const a = await mint("agent");
    const b = await mint("agent");
    const s = mcpServer();
    const mine = (await scopedMcp(post(a.secret, initialize), w.env, s.forward))?.headers.get("mcp-session-id") ?? "";
    expect((await scopedMcp(post(b.secret, join("web"), mine), w.env, s.forward))?.status).toBe(403);
    expect((await scopedMcp(post(a.secret, join("web"), "session-made-elsewhere"), w.env, s.forward))?.status).toBe(403);
    // GET and DELETE on the session are checked the same way.
    const get = new Request(`${ORIGIN}/mcp`, { headers: { authorization: `Bearer ${b.secret}`, "mcp-session-id": mine } });
    expect((await scopedMcp(get, w.env, s.forward))?.status).toBe(403);
    const del = new Request(`${ORIGIN}/mcp`, { method: "DELETE", headers: { authorization: `Bearer ${a.secret}`, "mcp-session-id": mine } });
    expect((await scopedMcp(del, w.env, s.forward))?.status).toBe(200);
    // The deployment's MCP token is not a scoped token: the gate decides it, as before.
    expect(await scopedMcp(post(MCP, join("anything"), mine), w.env, s.forward)).toBeNull();
    expect(await mcpRefusal(post(MCP, join("anything"), mine), w.env)).toBeNull();
  });

  it("is refused for a reviewer, once revoked or expired, on another person's colony, and at /sse", async () => {
    const { w, me, mint } = await owned();
    const s = mcpServer();
    const reviewer = await mint("reviewer");
    const r = await scopedMcp(post(reviewer.secret, initialize), w.env, s.forward);
    expect(r?.status).toBe(403);
    expect(((await r?.json()) as { error: string }).error).toMatch(/^This is a reviewer token/);

    const agent = await mint("agent");
    const sse = await scopedMcp(new Request(`${ORIGIN}/sse`, { headers: { authorization: `Bearer ${agent.secret}` } }), w.env, s.forward);
    expect(sse?.status).toBe(403);
    expect(((await sse?.json()) as { error: string }).error).toMatch(/works at \/mcp/);

    const session = (await scopedMcp(post(agent.secret, initialize), w.env, s.forward))?.headers.get("mcp-session-id") ?? "";
    await me.call("DELETE", `/api/me/colonies/web/tokens/${agent.token.id}`);
    expect((await scopedMcp(post(agent.secret, join("web"), session), w.env, s.forward))?.status).toBe(401);

    const late = await mint("agent");
    w.tick(31 * 24 * 60 * 60_000);
    expect((await scopedMcp(post(late.secret, initialize), w.env, s.forward))?.status).toBe(401);
    expect((await scopedMcp(post(`ftt_${"b".repeat(32)}`, initialize), w.env, s.forward))?.status).toBe(401);
  });

  it("stops working on a colony that is deleted (the colony is nobody's after)", async () => {
    const { w, mint } = await owned();
    const agent = await mint("agent");
    expect((await w.request("DELETE", "/api/colonies/web", { authorization: "Bearer test-admin" })).status).toBe(200);
    const res = await scopedMcp(post(agent.secret, initialize), w.env, mcpServer().forward);
    expect(res?.status).toBe(401);
  });

  it("leaves every other request to the gate, and does nothing with FT_ACCOUNTS off", async () => {
    const { w, mint } = await owned();
    const agent = await mint("agent");
    const s = mcpServer();
    expect(await scopedMcp(post("not-a-scoped-token", initialize), w.env, s.forward)).toBeNull();
    expect(await scopedMcp(new Request(`${ORIGIN}/mcp`, { method: "POST", body: "{}" }), w.env, s.forward)).toBeNull();
    // A token in the URL is the gate's to refuse.
    expect(await scopedMcp(post(agent.secret, initialize, undefined, "/mcp?token=x"), w.env, s.forward)).toBeNull();
    const off = { ...w.env, FT_ACCOUNTS: undefined } as Env;
    expect(await scopedMcp(post(agent.secret, initialize), off, s.forward)).toBeNull();
    // Off, the gate refuses the scoped token as it refuses any wrong token.
    expect((await mcpRefusal(post(agent.secret, initialize), off))?.status).toBe(401);
    expect(s.reached).toHaveLength(0);
  });

  it("a token minted for another person's colony works there and only there", async () => {
    const { w, mint } = await owned();
    const other = await w.person(bob);
    expect((await other.call("POST", "/api/me/colonies", { body: { name: "bobs" } })).status).toBe(201);
    const bobs = await mint("agent", "bobs", other);
    const s = mcpServer();
    const session = (await scopedMcp(post(bobs.secret, initialize), w.env, s.forward))?.headers.get("mcp-session-id") ?? "";
    expect((await scopedMcp(post(bobs.secret, join("bobs"), session), w.env, s.forward))?.status).toBe(200);
    expect((await scopedMcp(post(bobs.secret, join("web"), session), w.env, s.forward))?.status).toBe(403);
  });
});
