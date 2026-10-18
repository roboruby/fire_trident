import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env.ts";
import { createApi, type ApiDeps } from "../../src/api/app.ts";
import { RETRY_AFTER_S, clientIp, mcpReads, publicReadRefusal } from "../../src/api/ratelimit.ts";
import { publicMcp, servePublicMcp, type PublicReads } from "../../src/mcp/public.ts";

/**
 * Public reads are counted by Workers Rate Limiting bindings, per client address and per colony, across the public MCP
 * endpoint and the API's GET routes; over a limit the caller gets 429 with Retry-After and a plain sentence.
 */

/** A rate limit binding that allows `limit` calls per key, and records every key it is asked about. */
function binding(limit: number): RateLimit & { keys: string[] } {
  const counts = new Map<string, number>();
  const keys: string[] = [];
  return {
    keys,
    async limit({ key }) {
      keys.push(key);
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return { success: n <= limit };
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe("publicReadRefusal", () => {
  it("counts the address once per call and each colony once per entry, and passes under both limits", async () => {
    const ip = binding(10);
    const colony = binding(10);
    expect(await publicReadRefusal({ PUBLIC_IP_LIMIT: ip, PUBLIC_COLONY_LIMIT: colony }, "203.0.113.7", 3, ["hono", "hono"])).toBeNull();
    expect(ip.keys).toEqual(["ip:203.0.113.7", "ip:203.0.113.7", "ip:203.0.113.7"]);
    expect(colony.keys).toEqual(["colony:hono", "colony:hono"]);
  });

  it("refuses over the address limit before a colony is counted, then over the colony limit, each with a sentence", async () => {
    const ip = binding(1);
    const colony = binding(1);
    const limits = { PUBLIC_IP_LIMIT: ip, PUBLIC_COLONY_LIMIT: colony };
    expect(await publicReadRefusal(limits, "a", 1, ["hono"])).toBeNull();
    expect(await publicReadRefusal(limits, "a", 1, ["hono"])).toEqual({ limit: "ip", message: `Too many public reads from this address in the last minute; wait ${RETRY_AFTER_S} seconds and try again.` });
    expect(colony.keys).toEqual(["colony:hono"]);
    expect(await publicReadRefusal(limits, "b", 1, ["hono"])).toEqual({ limit: "colony", message: `Too many public reads of colony hono in the last minute; wait ${RETRY_AFTER_S} seconds and try again.` });
  });

  it("limits nothing without bindings, and lets a read through when a binding fails (logged)", async () => {
    expect(await publicReadRefusal({}, "a", 100, ["hono"])).toBeNull();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const broken: RateLimit = { limit: async () => Promise.reject(new Error("limiter unavailable")) };
    expect(await publicReadRefusal({ PUBLIC_IP_LIMIT: broken, PUBLIC_COLONY_LIMIT: broken }, "a", 1, ["hono"])).toBeNull();
    expect(log).toHaveBeenCalledWith("public read limit: limiter unavailable");
  });

  it("reads the client address from CF-Connecting-IP", () => {
    expect(clientIp(new Request("https://ft.test/", { headers: { "cf-connecting-ip": " 198.51.100.4 " } }))).toBe("198.51.100.4");
    expect(clientIp(new Request("https://ft.test/"))).toBe("unknown");
  });
});

describe("the API's public reads", () => {
  const deps: ApiDeps = { provisionTrunk: async () => Promise.reject(new Error("unused")), spawnSwarm: async () => undefined };
  const TOKEN = "op-token-for-tests";
  function env(ip: RateLimit | undefined, colony: RateLimit | undefined): { env: Env; reads: string[] } {
    const reads: string[] = [];
    const stub = { metricsReport: async () => (reads.push("metrics"), { ok: true }), getColony: async () => ({ id: "hono" }) };
    const e = { COLONY: { idFromName: (n: string) => n, get: () => stub }, FT_ADMIN_TOKEN: TOKEN, PUBLIC_IP_LIMIT: ip, PUBLIC_COLONY_LIMIT: colony } as unknown as Env;
    return { env: e, reads };
  }
  const get = (e: Env, path: string, headers: Record<string, string> = {}) => createApi(deps).request(path, { headers: { "cf-connecting-ip": "203.0.113.7", ...headers } }, e);

  it("counts a GET under /colonies per address and per colony, and answers 429 with Retry-After past a limit", async () => {
    const ip = binding(100);
    const colony = binding(2);
    const { env: e, reads } = env(ip, colony);
    expect((await get(e, "/colonies/hono/metrics")).status).toBe(200);
    expect((await get(e, "/colonies/hono/metrics")).status).toBe(200);
    const refused = await get(e, "/colonies/hono/metrics");
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe(String(RETRY_AFTER_S));
    expect(await refused.json()).toEqual({ error: `Too many public reads of colony hono in the last minute; wait ${RETRY_AFTER_S} seconds and try again.` });
    expect(reads).toEqual(["metrics", "metrics"]);
    expect(colony.keys).toEqual(["colony:hono", "colony:hono", "colony:hono"]);
    expect(ip.keys.every((k) => k === "ip:203.0.113.7")).toBe(true);
  });

  it("does not count the operator's reads (admin token) or any write", async () => {
    const ip = binding(0);
    const colony = binding(0);
    const { env: e, reads } = env(ip, colony);
    expect((await get(e, "/colonies/hono/metrics", { authorization: `Bearer ${TOKEN}` })).status).toBe(200);
    expect(reads).toEqual(["metrics"]);
    const write = await createApi(deps).request("/colonies/hono/intents", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }, e);
    expect(write.status).toBe(401);
    expect(ip.keys).toEqual([]);
    expect(colony.keys).toEqual([]);
    // Without the token the same read is counted, and refused.
    expect((await get(e, "/colonies/hono/metrics", { authorization: "Bearer wrong" })).status).toBe(429);
  });

  it("counts the colony list per address only, and limits nothing without bindings", async () => {
    const ip = binding(0);
    const colony = binding(0);
    expect((await get(env(ip, colony).env, "/colonies")).status).toBe(429);
    expect(colony.keys).toEqual([]);
    const { env: open, reads } = env(undefined, undefined);
    for (let i = 0; i < 5; i++) expect((await get(open, "/colonies/hono/metrics")).status).toBe(200);
    expect(reads).toHaveLength(5);
  });
});

describe("the public MCP endpoint", () => {
  const ENDPOINT = "https://ft.test/public/mcp";
  const post = (body: unknown) =>
    new Request(ENDPOINT, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "cf-connecting-ip": "198.51.100.4" }, body: JSON.stringify(body) });
  const status = (id: number, colony: string) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "status", arguments: { colony } } });
  const list = { jsonrpc: "2.0", id: 1, method: "tools/list" };
  // Reads that fail: a refused call must never reach them, and an allowed one may fail as a tool error.
  const reads: PublicReads = {
    colony: () => ({ getColony: async () => null, snapshot: async () => Promise.reject(new Error("no")), intentHistory: async () => null, listRegions: async () => [], impact: async () => Promise.reject(new Error("no")) }),
    region: () => ({ reading: async () => Promise.reject(new Error("no")) }),
    trunk: () => ({ why: async () => [] }),
  };

  it("counts each message against the address and each tool call against its colony (listed colonies only)", async () => {
    const ip = binding(100);
    const colony = binding(100);
    const opts = { colonies: new Set(["hono"]), reads, limits: { PUBLIC_IP_LIMIT: ip, PUBLIC_COLONY_LIMIT: colony } };
    expect((await servePublicMcp(post([list, status(2, "hono"), status(3, "elsewhere")]), opts)).status).toBe(200);
    expect(ip.keys).toEqual(["ip:198.51.100.4", "ip:198.51.100.4", "ip:198.51.100.4"]);
    expect(colony.keys).toEqual(["colony:hono"]);
    expect(mcpReads(status(1, "hono"), new Set(["hono"]))).toEqual({ calls: 1, colonies: ["hono"] });
  });

  it("answers a JSON-RPC error with 429 and Retry-After past a limit, before any server is built", async () => {
    const colony = binding(1);
    const opts = { colonies: new Set(["hono"]), reads, limits: { PUBLIC_IP_LIMIT: binding(100), PUBLIC_COLONY_LIMIT: colony } };
    expect((await servePublicMcp(post(status(1, "hono")), opts)).status).toBe(200);
    const refused = await servePublicMcp(post(status(2, "hono")), opts);
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe(String(RETRY_AFTER_S));
    expect(await refused.json()).toEqual({ jsonrpc: "2.0", error: { code: -32000, message: `Too many public reads of colony hono in the last minute; wait ${RETRY_AFTER_S} seconds and try again.` }, id: null });
    // Other colonies and plain listing still go through.
    expect((await servePublicMcp(post(list), opts)).status).toBe(200);
  });

  it("keeps the per-isolate in-flight cap as a second guard, checked first", async () => {
    const ip = binding(100);
    const busy = await servePublicMcp(post(list), { colonies: new Set(["hono"]), reads, maxInFlight: 0, limits: { PUBLIC_IP_LIMIT: ip } });
    expect(busy.status).toBe(503);
    expect(ip.keys).toEqual([]);
  });

  it("takes the bindings from the deployment's env", async () => {
    const ip = binding(0);
    const env = { COLONY: {}, REGION: {}, TRUNK: {}, FT_PUBLIC_MCP: "hono", PUBLIC_IP_LIMIT: ip } as unknown as Env;
    const res = await publicMcp(post(list), env);
    expect(res.status).toBe(429);
    expect(ip.keys).toEqual(["ip:198.51.100.4"]);
  });
});
