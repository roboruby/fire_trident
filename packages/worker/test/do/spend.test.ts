import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { PRICE_DATE, type ColonySpend } from "@fire_trident/core";
import { api, colony, newColony } from "./helpers.ts";

/**
 * Model spend through the API: GET /api/colonies/:id/metrics and GET /api/colonies/:id carry `spend`, priced from the
 * colony's own counters (colony/spend.ts). The harness has no agent binding, so only the colony's counters count here;
 * reading the agents' journals is covered by test/colony/spend.test.ts.
 */

const GPT = "@cf/openai/gpt-oss-120b";
const CLEF = "@cf/cloudflare/clef";

/** Add to the colony's counters as its decide stage would. */
async function bump(colonyId: string, counters: Record<string, number>): Promise<void> {
  await runInDurableObject(colony(colonyId), (instance) => {
    const self = instance as unknown as { bump(name: string, delta: number, now: number): number };
    for (const [name, delta] of Object.entries(counters)) self.bump(name, delta, Date.now());
  });
}

describe("model spend", () => {
  it("is in the metrics report and the colony's status, at zero before any model call", async () => {
    const c = await newColony();
    const m = await api<{ spend?: ColonySpend }>("GET", `/colonies/${c.id}/metrics`);
    expect(m.status).toBe(200);
    expect(m.body.spend).toMatchObject({ usd: 0, perLandedIntent: null, tokens: { input: 0, output: 0 }, unpriced: {}, priceDate: PRICE_DATE });
    const s = await api<{ colony?: { id: string }; spend?: ColonySpend }>("GET", `/colonies/${c.id}`);
    expect(s.status).toBe(200);
    expect(s.body.colony?.id).toBe(c.id);
    expect(s.body.spend).toMatchObject({ usd: 0, priceDate: PRICE_DATE });
  });

  it("prices the decide stage's per-model counters, and what the older aggregates hold beyond them at the configured models", async () => {
    const c = await newColony();
    await bump(c.id, {
      // One million second-opinion tokens in, per model; another half million from before per-model counting.
      "decide.llm.tokensIn": 1_500_000,
      [`decide.llm.tokensIn:${GPT}`]: 1_000_000,
      // Clef: one million in, none of it counted per model yet.
      "decide.clef.tokens": 1_000_000,
      [`contest.judge.tokensOut:${GPT}`]: 1_000_000,
      "decide.llm.tokensOut": 1_000_000,
    });
    const { body } = await api<{ spend: ColonySpend; metrics: Record<string, number> }>("GET", `/colonies/${c.id}/metrics`);
    // Review: 1M at gpt-oss-120b ($0.35), the older 0.5M at the dearest second-opinion model (gpt-oss-120b, $0.175), Clef's 1M ($0.24).
    expect(body.spend.byLayer.review).toBeCloseTo(0.35 + 0.175 + 0.24, 8);
    expect(body.spend.byLayer.judge).toBeCloseTo(0.75, 8);
    expect(body.spend.byLayer.agents).toBe(0);
    expect(body.spend.byModel[CLEF]).toEqual({ input: 1_000_000, output: 0, usd: 0.24 });
    expect(body.spend.usd).toBeCloseTo(1.515, 8);
    // The per-model counters are in the metrics too, so anyone can check the price.
    expect(body.metrics[`decide.llm.tokensIn:${GPT}`]).toBe(1_000_000);
  });
});
