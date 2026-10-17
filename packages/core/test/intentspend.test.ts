import { describe, expect, it } from "vitest";
import { PRICE_DATE, intentSpend, intentSpendBrief, intentSpendDetail, intentSpendLine, spentOnIntent } from "../src/pricing.ts";
import type { IntentUsage } from "../src/pricing.ts";

/** Spend per intent: one intent's calls priced by layer and model, and how a listing and a card read it. */

const GEMMA = "@cf/google/gemma-4-26b-a4b-it";
const GPT = "@cf/openai/gpt-oss-120b";
const CLEF = "@cf/cloudflare/clef";

/** One intent as a Gemma agent took it twice, Clef and a second opinion reviewed it, and a contest judge compared it twice. */
const COUNTED: IntentUsage[] = [
  { layer: "agents", model: GEMMA, calls: 2, input: 900, output: 60 },
  { layer: "review", model: CLEF, calls: 1, input: 1_500, output: 0 },
  { layer: "review", model: GPT, calls: 1, input: 2_000, output: 100 },
  { layer: "judge", model: GPT, calls: 2, input: 3_000, output: 200 },
];

describe("intentSpend", () => {
  it("prices each layer's tokens by model and sums the calls by layer", () => {
    const s = intentSpend("int_7", COUNTED);
    expect(s.intentId).toBe("int_7");
    expect(s.usd).toBeCloseTo(0.002443, 10);
    expect(s.byLayer.agents).toBeCloseTo(0.000108, 10);
    expect(s.byLayer.review).toBeCloseTo(0.001135, 10);
    expect(s.byLayer.judge).toBeCloseTo(0.0012, 10);
    expect(s.byLayer.resolver).toBe(0);
    expect(s.calls).toEqual({ agents: 2, review: 2, judge: 2, resolver: 0, other: 0 });
    expect(s.tokens).toEqual({ input: 7_400, output: 360 });
    expect(s.byModel[GPT]).toEqual({ input: 5_000, output: 300, usd: 0.001975 });
    expect(s.byModel[CLEF]?.usd).toBeCloseTo(0.00036, 10);
    expect(s.unpriced).toEqual({});
    expect(s.priceDate).toBe(PRICE_DATE);
  });

  it("counts a call that reported no tokens as a call and prices it at nothing", () => {
    const s = intentSpend("int_8", [{ layer: "agents", model: GEMMA, calls: 1, input: 0, output: 0 }]);
    expect(s.calls.agents).toBe(1);
    expect(s.usd).toBe(0);
    expect(spentOnIntent(s)).toBe(false);
  });

  it("keeps the tokens of a model with no listed price out of every dollar sum", () => {
    const s = intentSpend("int_9", [...COUNTED, { layer: "agents", model: "@cf/x/unlisted", calls: 1, input: 50, output: 5 }]);
    expect(s.usd).toBeCloseTo(0.002443, 10);
    expect(s.unpriced).toEqual({ "@cf/x/unlisted": { input: 50, output: 5 } });
    expect(s.calls.agents).toBe(3);
    expect(intentSpendLine(s)).toBe("$0.0024 of model calls this platform made (some unpriced)");
  });
});

describe("how an intent's spend reads", () => {
  const full = intentSpend("int_7", COUNTED);

  it("is one line like the colony's, with the layers, calls, tokens and prices behind it", () => {
    expect(intentSpendLine(full)).toBe("$0.0024 of model calls this platform made");
    expect(intentSpendDetail(full)).toBe(
      `agents $0.0001 in 2 calls, review $0.0011 in 2 calls, contest judge $0.0012 in 2 calls; 7,400 input and 360 output tokens at Workers AI list prices on ${PRICE_DATE}.`,
    );
  });

  it("has a short form for a listing that reads the same", () => {
    const brief = intentSpendBrief(full);
    expect(brief).toEqual({
      usd: full.usd,
      byLayer: { agents: { usd: full.byLayer.agents, calls: 2 }, review: { usd: full.byLayer.review, calls: 2 }, judge: { usd: full.byLayer.judge, calls: 2 } },
      tokens: { input: 7_400, output: 360 },
    });
    expect(intentSpendLine(brief)).toBe(intentSpendLine(full));
    expect(intentSpendDetail(brief)).toBe(intentSpendDetail(full));
    expect(intentSpendDetail(brief, "2026-12-31")).toContain("on 2026-12-31.");
    expect(intentSpendBrief(intentSpend("int_9", [...COUNTED, { layer: "review", model: "@cf/x/unlisted", calls: 1, input: 50, output: 5 }]))?.unpriced).toBe(true);
  });

  it("shows nothing for an intent nothing was counted for, never a spend of zero", () => {
    const none = intentSpend("int_0", []);
    expect(spentOnIntent(none)).toBe(false);
    expect(intentSpendLine(none)).toBeNull();
    expect(intentSpendBrief(none)).toBeNull();
    expect(intentSpendDetail(none)).toBe("");
    expect(intentSpendLine(null)).toBeNull();
    expect(intentSpendLine(undefined)).toBeNull();
  });
});
