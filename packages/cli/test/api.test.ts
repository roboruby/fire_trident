import { describe, expect, it } from "vitest";
import { parseCommand } from "../src/args.ts";
import { ApiError, DEFAULT_URL, asArray, liveUrl, pickColony, planRequest, resolveBaseUrl, send } from "../src/api.ts";
import type { Command } from "../src/args.ts";

function cmd(argv: string[]): Command {
  const r = parseCommand(argv);
  if (!r.ok) throw new Error(r.error);
  return r.command;
}

describe("resolveBaseUrl", () => {
  it("prefers --url, then FT_URL, then the default, and strips trailing slashes", () => {
    expect(resolveBaseUrl("http://localhost:8787/", { FT_URL: "https://a.example" })).toBe("http://localhost:8787");
    expect(resolveBaseUrl(undefined, { FT_URL: "https://a.example//" })).toBe("https://a.example");
    expect(resolveBaseUrl(undefined, {})).toBe(DEFAULT_URL);
    expect(resolveBaseUrl(undefined, { FT_URL: "  " })).toBe(DEFAULT_URL);
  });

  it("rejects non-http URLs", () => {
    expect(() => resolveBaseUrl("ftp://x", {})).toThrow(/http/);
    expect(() => resolveBaseUrl("nope", {})).toThrow(/not a valid server URL/);
  });
});

describe("liveUrl", () => {
  it("switches the scheme to WebSocket and encodes the colony", () => {
    expect(liveUrl("https://ft.example", "web")).toBe("wss://ft.example/api/colonies/web/live");
    expect(liveUrl("http://localhost:8787", "a b")).toBe("ws://localhost:8787/api/colonies/a%20b/live");
  });
});

describe("planRequest", () => {
  it("imports with source, name, and pool", () => {
    expect(planRequest(cmd(["import", "org/repo", "--branch", "dev", "--pool", "64"]), "matt")).toEqual({
      method: "POST",
      path: "/api/colonies",
      body: { name: "repo", source: { url: "https://github.com/org/repo", branch: "dev" }, pool: 64 },
    });
  });

  it("adds a forbid-pattern rule with only the globs given", () => {
    expect(planRequest(cmd(["rule", "add", "web", "--pattern", "x", "--hint", "h", "--description", "d"]), "matt")).toEqual({
      method: "POST",
      path: "/api/colonies/web/rules",
      body: { colonyId: "web", kind: "forbid-pattern", spec: { pattern: "x", hint: "h" }, description: "d", approvedBy: "matt" },
    });
  });

  it("passes a deterministic replacement through to the rule spec", () => {
    const req = planRequest(cmd(["rule", "add", "web", "--pattern", "oldName\\(", "--replacement", "newName(", "--hint", "h", "--description", "d"]), "matt");
    expect((req?.body as { spec: Record<string, unknown> }).spec).toEqual({ pattern: "oldName\\(", hint: "h", replacement: "newName(" });
  });

  it("adds a forbid-import rule and honors --by", () => {
    expect(planRequest(cmd(["rule", "import-boundary", "web", "--from", "src/ui/**", "--module", "^db", "--hint", "h", "--description", "d", "--by", "ana"]), "matt")).toEqual({
      method: "POST",
      path: "/api/colonies/web/rules",
      body: { colonyId: "web", kind: "forbid-import", spec: { from: ["src/ui/**"], module: "^db", hint: "h" }, description: "d", approvedBy: "ana" },
    });
  });

  it("spawns a swarm", () => {
    expect(planRequest(cmd(["swarm", "web", "--agents", "3", "--kind", "internal"]), "matt")).toEqual({
      method: "POST",
      path: "/api/colonies/web/swarm",
      body: { agents: 3, kind: "internal" },
    });
  });

  it("asks why with path and line in the query", () => {
    expect(planRequest(cmd(["why", "web", "src/a b.ts:9"]), "matt")).toEqual({ method: "GET", path: "/api/colonies/web/why?path=src%2Fa+b.ts&line=9" });
    expect(planRequest(cmd(["why", "web", "src/a.ts"]), "matt")).toEqual({ method: "GET", path: "/api/colonies/web/why?path=src%2Fa.ts" });
  });

  it("lists and decides reviews", () => {
    expect(planRequest(cmd(["review", "web"]), "matt")).toEqual({ method: "GET", path: "/api/colonies/web/review" });
    expect(planRequest(cmd(["review", "web", "prp/1", "return", "--reason", "stale"]), "matt")).toEqual({
      method: "POST",
      path: "/api/colonies/web/review/prp%2F1",
      body: { decision: "return", reason: "stale", by: "matt" },
    });
  });

  it("returns null for commands that are not a single call", () => {
    expect(planRequest(cmd(["watch", "web"]), "matt")).toBeNull();
  });
});

describe("send", () => {
  it("sends JSON with the bearer token and parses the reply", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fake = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ ok: 1 }), { status: 200 });
    }) as unknown as typeof fetch;
    const res = await send({ baseUrl: "https://x", token: "t0k", fetch: fake }, { method: "POST", path: "/api/p", body: { a: 1 } });
    expect(res).toEqual({ ok: 1 });
    expect(seen?.url).toBe("https://x/api/p");
    const headers = seen?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer t0k");
    expect(headers["content-type"]).toBe("application/json");
    expect(seen?.init.body).toBe('{"a":1}');
  });

  it("turns HTTP errors into ApiError with the server's message", async () => {
    const fake = (async () => new Response(JSON.stringify({ error: "colony not found" }), { status: 404, statusText: "Not Found" })) as unknown as typeof fetch;
    await expect(send({ baseUrl: "https://x", fetch: fake }, { method: "GET", path: "/api/colonies/zz?x=1" })).rejects.toMatchObject({
      status: 404,
      message: "GET /api/colonies/zz failed: 404 Not Found: colony not found",
    });
  });

  it("hints at FT_TOKEN on 401", async () => {
    const fake = (async () => new Response("nope", { status: 401, statusText: "Unauthorized" })) as unknown as typeof fetch;
    await expect(send({ baseUrl: "https://x", fetch: fake }, { method: "POST", path: "/api/colonies" })).rejects.toThrow(/set FT_TOKEN/);
  });

  it("reports unreachable servers with status 0", async () => {
    const fake = (async () => {
      throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    }) as unknown as typeof fetch;
    const e = await send({ baseUrl: "http://127.0.0.1:9", fetch: fake }, { method: "GET", path: "/" }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).status).toBe(0);
    expect((e as ApiError).message).toMatch(/ECONNREFUSED/);
  });
});

describe("response helpers", () => {
  it("finds the colony in bare or wrapped responses", () => {
    expect(pickColony({ id: "c1", name: "a" })).toMatchObject({ id: "c1" });
    expect(pickColony({ colony: { id: "c2" } })).toMatchObject({ id: "c2" });
    expect(pickColony({ ok: true })).toBeNull();
    expect(pickColony(null)).toBeNull();
  });

  it("reads arrays bare or wrapped", () => {
    expect(asArray([1, 2], ["x"])).toEqual([1, 2]);
    expect(asArray({ proposals: [3] }, ["proposals"])).toEqual([3]);
    expect(asArray({ other: [3] }, ["proposals"])).toEqual([]);
  });
});
