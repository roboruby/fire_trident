import { describe, expect, it } from "vitest";
import { createApi, type ApiDeps } from "../../src/api/app.ts";
import { ftError } from "../../src/colony/errors.ts";
import type { Env } from "../../src/env.ts";

/** GET and POST /api/colonies/:id/commit-author (api/commitauthor.ts): who authors a colony's landing commits. */

const deps: ApiDeps = {
  provisionTrunk: async () => {
    throw new Error("not used");
  },
  spawnSwarm: async () => undefined,
};
const TOKEN = "s3cret";
const DANA = { name: "Dana Reviewer", email: "dana@example.com", by: "matt", at: 5 };

function env(): { env: Env; asked: unknown[] } {
  const asked: unknown[] = [];
  let current: typeof DANA | null = null;
  const stub = {
    commitAuthor: async () => current,
    setCommitAuthor: async (p: { name: string | null; email?: string; by?: string }) => {
      asked.push(p);
      if (p.name === null) {
        const cleared = current !== null;
        current = null;
        return { author: null, cleared };
      }
      if (!p.email?.includes("@")) throw ftError(400, "give the person's email address: git names the author by it");
      current = { name: p.name, email: p.email, by: p.by ?? "api", at: 5 };
      return { author: current };
    },
  };
  return { env: { COLONY: { idFromName: (n: string) => n, get: () => stub }, FT_ADMIN_TOKEN: TOKEN } as unknown as Env, asked };
}

const call = async (e: Env, method: string, body?: unknown, token: string | null = TOKEN) => {
  const headers: Record<string, string> = { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
  const res = await createApi(deps).request("/colonies/web/commit-author", { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }, e);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
};

describe("commit author routes", () => {
  it("names a person with the admin token, and shows the address only to the operator", async () => {
    const { env: e, asked } = env();
    expect((await call(e, "GET", undefined, null)).json).toEqual({ colonyId: "web", author: null });
    expect(await call(e, "POST", { name: "Dana Reviewer", email: "dana@example.com", by: "matt" })).toEqual({ status: 200, json: { colonyId: "web", author: DANA } });
    expect(asked).toEqual([{ name: "Dana Reviewer", email: "dana@example.com", by: "matt" }]);
    expect((await call(e, "GET", undefined, null)).json).toEqual({ colonyId: "web", author: { name: "Dana Reviewer", by: "matt", at: 5 } });
    expect((await call(e, "GET")).json).toEqual({ colonyId: "web", author: DANA });
  });

  it("goes back to FireTrident with name null", async () => {
    const { env: e } = env();
    await call(e, "POST", { name: "Dana Reviewer", email: "dana@example.com" });
    expect((await call(e, "POST", { name: null })).json).toEqual({ colonyId: "web", author: null, cleared: true });
  });

  it("needs the admin token to write, and says what to send for a bad body", async () => {
    const { env: e, asked } = env();
    expect((await call(e, "POST", { name: "Dana", email: "dana@example.com" }, null)).status).toBe(401);
    expect((await call(e, "POST", { name: "Dana", email: "dana@example.com" }, "wrong")).status).toBe(401);
    const bad = await call(e, "POST", { email: "dana@example.com" });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toMatch(/Send \{ "name": "Dana Reviewer"/);
    const noMail = await call(e, "POST", { name: "Dana" });
    expect(noMail.status).toBe(400);
    expect(noMail.json.error).toMatch(/email address/);
    expect(asked).toHaveLength(1);
  });
});
