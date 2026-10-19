import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../../src/index.ts";
import type { Env } from "../../src/env.ts";
import { ADMIN, ORIGIN } from "./deployment.ts";

/**
 * FT_ACCOUNTS off (absent, or anything but "on"), on the Worker itself: every route the accounts round added answers
 * 404 as an unknown route does, /api/about does not list the flag (so the web shows no account link), and the
 * deployment's admin and MCP tokens work as they always have.
 */

const NEW_ROUTES: Array<[string, string]> = [
  ["GET", "/auth/github/start"],
  ["GET", "/auth/github/callback?code=x&state=y"],
  ["GET", "/auth/github/pending"],
  ["POST", "/auth/github/invite"],
  ["POST", "/auth/logout"],
  ["GET", "/auth/cloudflare/start"],
  ["GET", "/auth/cloudflare/callback?code=x&state=y"],
  ["GET", "/api/me"],
  ["GET", "/api/me/cloudflare"],
  ["POST", "/api/me/cloudflare/account"],
  ["POST", "/api/me/cloudflare/disconnect"],
  ["POST", "/api/me/colonies"],
  ["DELETE", "/api/me/colonies/shop"],
  ["GET", "/api/me/colonies/shop/tokens"],
  ["POST", "/api/me/colonies/shop/tokens"],
  ["DELETE", "/api/me/colonies/shop/tokens/tok_1"],
  ["GET", "/api/accounts/invites"],
  ["POST", "/api/accounts/invites"],
  ["DELETE", "/api/accounts/invites/inv_1"],
];

/** A request to the Worker with FT_ACCOUNTS set to `flag` (undefined: absent). */
async function call(flag: string | undefined, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Response> {
  const ctx = createExecutionContext();
  const off = { ...(env as unknown as Env), FT_ACCOUNTS: flag } as Env;
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`, { method, headers: { origin: ORIGIN, ...headers }, ...(body !== undefined ? { body } : {}) }), off, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe("FT_ACCOUNTS off", () => {
  for (const flag of [undefined, "off", ""]) {
    it(`answers 404 on every new route, with the admin token too (FT_ACCOUNTS ${JSON.stringify(flag)})`, async () => {
      for (const [method, path] of NEW_ROUTES) {
        const callers: Array<Record<string, string>> = [{}, { authorization: `Bearer ${ADMIN}` }];
        for (const headers of callers) {
          const res = await call(flag, method, path, { ...headers, ...(method === "GET" ? {} : { "content-type": "application/json" }) }, method === "GET" ? undefined : "{}");
          expect(res.status, `${method} ${path}`).toBe(404);
          expect(res.headers.get("set-cookie"), `${method} ${path}`).toBeNull();
        }
      }
    });
  }

  it("does not list the flag in /api/about (the web's account link stays hidden), and lists it when on", async () => {
    const off = (await (await call(undefined, "GET", "/api/about")).json()) as { flags: string[] };
    expect(off.flags).not.toContain("FT_ACCOUNTS");
    const on = (await (await call("on", "GET", "/api/about")).json()) as { flags: string[] };
    expect(on.flags).toContain("FT_ACCOUNTS");
  });

  it("keeps the deployment's tokens as they were: a scoped-looking token opens nothing, the MCP token opens /mcp", async () => {
    const scoped = `ftt_${"a".repeat(32)}`;
    const init = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    const mcpHeaders = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    expect((await call(undefined, "POST", "/mcp", { ...mcpHeaders, authorization: `Bearer ${scoped}` }, init)).status).toBe(401);
    expect((await call(undefined, "POST", "/mcp", { ...mcpHeaders, authorization: "Bearer test-mcp" }, init)).status).toBe(200);
    expect((await call(undefined, "POST", "/api/colonies/shop/intents", { "content-type": "application/json", authorization: `Bearer ${scoped}` }, JSON.stringify({ title: "t", footprint: ["src/**"] }))).status).toBe(401);
  });
});
