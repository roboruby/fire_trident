import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ColonySnapshot, IntentSpend } from "@fire_trident/core";
import { NOT_COUNTING, countIntentCall, migrateIntentSpend, storeAgentIntents } from "../../src/colony/intentspend.ts";
import type { SqlRunner } from "../../src/colony/inline.ts";
import { addIntent, api, colony, newColony } from "./helpers.ts";

/**
 * Spend per intent on a real colony object: the route answers for a colony that counts nothing per intent (the
 * harness has no FT_INTENT_SPEND), and prices what its tables hold once rows are in them.
 */

const GEMMA = "@cf/google/gemma-4-26b-a4b-it";
const CLEF = "@cf/cloudflare/clef";

describe("GET /api/colonies/:id/intents/:iid/spend", () => {
  it("answers no spend and says the colony is not counting per intent, and 404 for an unknown intent", async () => {
    const c = await newColony();
    const intent = await addIntent(c.id, ["src/app/main.ts"]);
    const res = await api<IntentSpend & { note?: string }>("GET", `/colonies/${c.id}/intents/${intent.id}/spend`, undefined, {});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ intentId: intent.id, usd: 0, tokens: { input: 0, output: 0 }, note: NOT_COUNTING });
    expect(res.body.calls).toEqual({ agents: 0, review: 0, judge: 0, resolver: 0, other: 0 });
    expect((await api("GET", `/colonies/${c.id}/intents/int_nope/spend`, undefined, {})).status).toBe(404);
    // Nothing counted: the intent's history carries no spend, and the listings no map.
    expect((await api("GET", `/colonies/${c.id}/intents/${intent.id}`, undefined, {})).body.spend).toBeUndefined();
    expect((await api<ColonySnapshot>("GET", `/colonies/${c.id}`, undefined, {})).body.intentSpend).toBeUndefined();
    expect((await api("GET", `/colonies/${c.id}/metrics`, undefined, {})).body.intentSpend).toBeUndefined();
  });

  it("prices the rows its tables hold, by layer, and lists them with the snapshot and the metrics", async () => {
    const c = await newColony();
    const intent = await addIntent(c.id, ["src/app/main.ts"]);
    await runInDurableObject(colony(c.id), (instance) => {
      const sql = (instance as unknown as { sql: SqlRunner }).sql;
      migrateIntentSpend(sql);
      storeAgentIntents(sql, "agt_1", [{ intentId: intent.id, model: GEMMA, calls: 2, input: 900, output: 60, at: 1 }], (m) => m, 2);
      countIntentCall(sql, { intentId: intent.id, layer: "review", model: CLEF, usage: { input: 1_500 }, at: 3 });
    });
    const res = await api<IntentSpend & { note?: string }>("GET", `/colonies/${c.id}/intents/${intent.id}/spend`, undefined, {});
    expect(res.status).toBe(200);
    expect(res.body.note).toBeUndefined();
    expect(res.body.usd).toBeCloseTo(0.000468, 10);
    expect(res.body.byLayer.agents).toBeCloseTo(0.000108, 10);
    expect(res.body.byLayer.review).toBeCloseTo(0.00036, 10);
    expect(res.body.calls).toEqual({ agents: 2, review: 1, judge: 0, resolver: 0, other: 0 });
    expect(res.body.tokens).toEqual({ input: 2_400, output: 60 });
    const history = await api("GET", `/colonies/${c.id}/intents/${intent.id}`, undefined, {});
    expect(history.body.spend.usd).toBeCloseTo(0.000468, 10);
    const snap = await api<ColonySnapshot>("GET", `/colonies/${c.id}`, undefined, {});
    expect(snap.body.intentSpend?.[intent.id]).toMatchObject({ byLayer: { agents: { calls: 2 }, review: { calls: 1 } }, tokens: { input: 2_400, output: 60 } });
    const metrics = await api("GET", `/colonies/${c.id}/metrics`, undefined, {});
    expect(metrics.body.intentSpend?.[intent.id]?.usd).toBeCloseTo(0.000468, 10);
  });
});
