import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ColonySnapshot } from "@fire_trident/core";
import { createApi, type ApiDeps, type ApiEnv } from "../../src/api/app.ts";
import type { Env } from "../../src/env.ts";
import { AUTH, api, env, newColony } from "./helpers.ts";

/**
 * FT_ADMIN_TOKEN set with its trailing line break, against the real ColonyDO: POST /intents and the Agent2Agent door's
 * SendMessage take the token a client sends (api/token.ts drops the line break on the configured side) and still
 * refuse a wrong one. The routes are served by createApi, as the Worker serves them.
 */

/** The harness env with some Worker variables set, as a deployment's vars and secrets would set them. */
function withVars(vars: Record<string, string>): Env {
  return new Proxy(env, { get: (t, k) => (typeof k === "string" && k in vars ? vars[k] : Reflect.get(t, k)) }) as Env;
}

const deps: ApiDeps = {
  provisionTrunk: async () => {
    throw new Error("colonies are made through the harness worker");
  },
  spawnSwarm: async () => ({}),
};
const full = new Hono<ApiEnv>();
full.route("/api", createApi(deps));

async function post(path: string, body: unknown, headers: Record<string, string>, vars: Env): Promise<{ status: number; body: any }> {
  const res = await full.request(`https://ft.test/api${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }, vars);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe("an admin token configured with a trailing line break", () => {
  for (const [name, end] of [["LF", "\n"], ["CRLF", "\r\n"]] as const) {
    it(`takes writes and SendMessage with the token as sent (${name})`, async () => {
      const c = await newColony();
      const vars = withVars({ FT_ADMIN_TOKEN: `test-admin${end}`, FT_A2A: "on" });
      const intent = { title: "Tidy util", why: "A person asked.", footprint: ["src/lib/util.ts"] };
      expect((await post(`/colonies/${c.id}/intents`, intent, { authorization: "Bearer wrong" }, vars)).status).toBe(401);
      expect((await post(`/colonies/${c.id}/intents`, intent, AUTH, vars)).status).toBe(201);

      const message = { messageId: `m-${name}`, role: "ROLE_USER", parts: [{ text: "Tidy docs\nKeep the title." }, { data: { footprint: ["docs/index.md"] } }] };
      const rpc = (headers: Record<string, string>) => post(`/colonies/${c.id}/a2a`, { jsonrpc: "2.0", id: 1, method: "SendMessage", params: { message, configuration: { returnImmediately: true } } }, headers, vars);
      expect((await rpc({ authorization: "Bearer wrong" })).status).toBe(401);
      const sent = await rpc(AUTH);
      expect(sent.status, JSON.stringify(sent.body)).toBe(200);
      expect(sent.body.result.task.id).toMatch(/^int_/);

      const titles = (await api<ColonySnapshot>("GET", `/colonies/${c.id}`)).body.intents.map((i) => i.title).sort();
      expect(titles).toEqual(["Tidy docs", "Tidy util"]);
    });
  }
});
