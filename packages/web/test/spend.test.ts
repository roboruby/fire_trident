import { describe, expect, it } from "vitest";
import { PRICE_DATE, colonySpend, spendDetail, spendLine } from "@fire_trident/core";
import type { ColonySnapshot } from "@fire_trident/core";
import { parseSpend } from "../src/spend.ts";
import { ColonyStore } from "../src/store.ts";

const GEMMA = "@cf/google/gemma-4-26b-a4b-it";
const KIMI = "@cf/moonshotai/kimi-k2.7-code";

/** The round-7 Hono run's agents (packages/bench/results/2026-10-14-round7/checks/p21-hono.log), 283 intents landed. */
const HONO = colonySpend(
  [
    { layer: "agents", model: GEMMA, input: 227_842, output: 15_467 },
    { layer: "agents", model: KIMI, input: 9_230, output: 1_422 },
  ],
  283,
);

function snapshot(extra: Record<string, unknown> = {}): ColonySnapshot {
  return {
    colony: { id: "hono", name: "hono", trunk: { namespace: "ft-trunk", name: "hono--trunk" }, trunkSha: "a".repeat(40), createdAt: 1, regionDepth: 3 },
    files: [],
    intents: [],
    rules: [],
    agents: [],
    recentLandings: [],
    violations: { total: 0, byRule: {} },
    funnel: { reflex: 0, llm: 0, human: 0, proof: 0 },
    metrics: {},
    ...extra,
  } as ColonySnapshot;
}

describe("parseSpend", () => {
  it("reads the server's report as it was sent", () => {
    const s = parseSpend(JSON.parse(JSON.stringify(HONO)));
    expect(s).toEqual(HONO);
    expect(spendLine(s)).toBe("$0.042 of model calls · $0.0001 a landed intent");
    expect(spendDetail(s)).toContain(`Workers AI list prices on ${PRICE_DATE}`);
  });

  it("is null for an older server, a mock or anything malformed, and drops what it cannot read", () => {
    expect(parseSpend(undefined)).toBeNull();
    expect(parseSpend({ usd: "0.04" })).toBeNull();
    expect(parseSpend({ usd: 0.04 })).toBeNull();
    const s = parseSpend({ usd: 0.5, tokens: { input: 10, output: "x" }, byLayer: { agents: 0.5, bogus: 9 }, byModel: { [GEMMA]: { input: 10, output: 0, usd: 0.5 }, junk: 3 }, priceDate: "<b>today</b>", perLandedIntent: "1" });
    expect(s).toEqual({
      usd: 0.5,
      byLayer: { agents: 0.5, review: 0, judge: 0, resolver: 0, other: 0 },
      perLandedIntent: null,
      landedIntents: 0,
      tokens: { input: 10, output: 0 },
      byModel: { [GEMMA]: { input: 10, output: 0, usd: 0.5 } },
      unpriced: {},
      priceDate: PRICE_DATE,
    });
  });
});

describe("the store's model spend", () => {
  it("comes with the snapshot and moves with each metrics refresh", () => {
    const store = new ColonyStore("hono");
    store.applySnapshot(snapshot({ spend: HONO }));
    expect(spendLine(store.spend)).toBe("$0.042 of model calls · $0.0001 a landed intent");
    store.applySpend({ ...HONO, usd: 1.5, perLandedIntent: 0.25 });
    expect(spendLine(store.spend)).toBe("$1.50 of model calls · $0.250 a landed intent");
    // A refresh from a server that sends none keeps what the page has.
    store.applySpend(undefined);
    expect(store.spend?.usd).toBe(1.5);
  });

  it("is none for a snapshot without it (the simulator, a replay, an older server)", () => {
    const store = new ColonyStore("hono");
    store.applySnapshot(snapshot());
    expect(store.spend).toBeNull();
    expect(spendLine(store.spend)).toBeNull();
  });
});
