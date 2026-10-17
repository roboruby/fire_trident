import { describe, expect, it } from "vitest";
import { createApi, type ApiDeps } from "../../src/api/app.ts";
import { ftError } from "../../src/colony/errors.ts";
import type { BatchDecision } from "../../src/decide/batch.ts";
import type { Env } from "../../src/env.ts";

/** POST /api/colonies/:id/review/batches/decide: a person's answer for one batch of the review queue (FT_ESCALATION_BATCH). */

const deps: ApiDeps = {
  provisionTrunk: async () => {
    throw new Error("not used");
  },
  spawnSwarm: async () => undefined,
};

const TOKEN = "s3cret";

/** A colony stub that records what it was asked; `refuse` makes it answer as a colony without the flag. */
function env(opts: { exists?: boolean; refuse?: boolean } = {}): { env: Env; asked: BatchDecision[]; single: string[] } {
  const asked: BatchDecision[] = [];
  const single: string[] = [];
  const stub = {
    getColony: async () => (opts.exists === false ? null : { id: "col" }),
    decideBatch: async (d: BatchDecision) => {
      if (opts.refuse) throw ftError(409, "escalation batching is off for this colony (FT_ESCALATION_BATCH), so there is no batch to answer; decide each change on its own card");
      asked.push(d);
      return { key: d.key, decision: d.decision, decided: d.ids, skipped: [] };
    },
    decide: async (id: string) => void single.push(id),
  };
  const COLONY = { idFromName: (n: string) => n, get: () => stub };
  return { env: { COLONY, FT_ADMIN_TOKEN: TOKEN } as unknown as Env, asked, single };
}

const post = async (e: Env, body: unknown, token: string | null = TOKEN, path = "/colonies/col/review/batches/decide"): Promise<{ status: number; json: unknown }> => {
  const headers: Record<string, string> = { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
  const res = await createApi(deps).request(path, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) }, e);
  return { status: res.status, json: await res.json() };
};

const BODY = { key: "P1|capability (network)", ids: ["prp_1", "prp_2"], decision: "approve" };

describe("review batch route", () => {
  it("passes the person's answer for the listed changes to the colony, and is not read as one proposal's decision", async () => {
    const { env: e, asked, single } = env();
    expect(await post(e, BODY)).toEqual({ status: 200, json: { key: BODY.key, decision: "approve", decided: ["prp_1", "prp_2"], skipped: [] } });
    expect(asked).toEqual([{ key: BODY.key, ids: ["prp_1", "prp_2"], decision: "approve", reason: "", by: "human" }]);
    expect(single).toEqual([]);
  });

  it("needs the admin token", async () => {
    const { env: e, asked } = env();
    expect((await post(e, BODY, null)).status).toBe(401);
    expect((await post(e, BODY, "wrong")).status).toBe(401);
    expect(asked).toEqual([]);
  });

  it("refuses a rejection without a reason, a return, ids that are not proposal ids, and a body that is not JSON", async () => {
    const { env: e, asked } = env();
    const noReason = await post(e, { ...BODY, decision: "reject", reason: "  " });
    expect(noReason.status).toBe(400);
    expect((noReason.json as { error: string }).error).toContain("a rejection needs a reason");
    expect((await post(e, { ...BODY, decision: "return", reason: "redo it" })).status).toBe(400);
    expect((await post(e, { ...BODY, ids: ["../etc"] })).status).toBe(400);
    expect((await post(e, { ...BODY, ids: [] })).status).toBe(400);
    expect((await post(e, "not json")).status).toBe(400);
    expect(asked).toEqual([]);
    expect((await post(e, { ...BODY, decision: "reject", reason: "No new network calls.", by: "matt" })).status).toBe(200);
    expect(asked[0]).toMatchObject({ decision: "reject", reason: "No new network calls.", by: "matt" });
  });

  it("is 404 for an unknown colony and 409 where batching is off", async () => {
    expect((await post(env({ exists: false }).env, BODY)).status).toBe(404);
    const off = await post(env({ refuse: true }).env, BODY);
    expect(off.status).toBe(409);
    expect((off.json as { error: string }).error).toContain("decide each change on its own card");
  });
});
