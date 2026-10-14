import { describe, expect, it } from "vitest";
import { MODEL_PRICES, PRICE_DATE, colonySpend, modelPrice, priceTokens, spendDetail, spendLine, spendParts, usdText } from "../src/pricing.ts";
import type { LayerUsage } from "../src/pricing.ts";

const GEMMA = "@cf/google/gemma-4-26b-a4b-it";
const KIMI = "@cf/moonshotai/kimi-k2.7-code";
const GPT = "@cf/openai/gpt-oss-120b";
const CLEF = "@cf/cloudflare/clef";

describe("priceTokens", () => {
  it("prices tokens at the model's list price per million", () => {
    expect(priceTokens(GEMMA, 1_000_000, 0)).toBeCloseTo(0.1, 10);
    expect(priceTokens(GEMMA, 0, 1_000_000)).toBeCloseTo(0.3, 10);
    expect(priceTokens(KIMI, 1_000_000, 1_000_000)).toBeCloseTo(4.95, 10);
    expect(priceTokens(CLEF, 1_000_000, 0)).toBeCloseTo(0.24, 10);
  });

  it("is null for a model with no listed price, and never guesses one", () => {
    expect(priceTokens("@cf/meta/llama-9-unlisted", 1_000, 1_000)).toBeNull();
    expect(priceTokens("claude-sonnet-9", 1_000, 1_000)).toBeNull();
    expect(modelPrice("")).toBeNull();
    expect(modelPrice("toString")).toBeNull();
  });

  it("reads bad counts as no tokens", () => {
    expect(priceTokens(GEMMA, -5, Number.NaN)).toBe(0);
  });

  it("has a price for the models the worker calls by default", () => {
    for (const m of [KIMI, GEMMA, GPT, CLEF, "@cf/zai-org/glm-4.7-flash"]) expect(MODEL_PRICES[m]).toBeDefined();
    expect(PRICE_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("colonySpend", () => {
  // The round-7 Hono run on a preview (packages/bench/results/2026-10-14-round7/checks/p21-hono.log): 20 Gemma agents
  // and the prerequisite's Kimi agent; the log's model cost estimate is $0.0419.
  const round7: LayerUsage[] = [
    { layer: "agents", model: GEMMA, input: 227_842, output: 15_467 },
    { layer: "agents", model: KIMI, input: 9_230, output: 1_422 },
  ];

  it("prices the round-7 Hono run's agents at the log's $0.0419", () => {
    const s = colonySpend(round7, 283);
    expect(s.byLayer.agents.toFixed(4)).toBe("0.0419");
    expect(s.byModel[GEMMA]?.usd?.toFixed(4)).toBe("0.0274");
    expect(s.byModel[KIMI]?.usd?.toFixed(4)).toBe("0.0145");
    expect(s.usd).toBeCloseTo(0.0418808, 8);
    expect(s.perLandedIntent).toBeCloseTo(0.0418808 / 283, 7);
    expect(s.tokens).toEqual({ input: 237_072, output: 16_889 });
    expect(s.unpriced).toEqual({});
    expect(s.priceDate).toBe(PRICE_DATE);
  });

  it("sums each layer apart and keeps unpriced tokens out of every dollar sum", () => {
    const s = colonySpend(
      [
        ...round7,
        { layer: "review", model: GPT, input: 1_000_000, output: 0 },
        { layer: "review", model: CLEF, input: 500_000, output: 0 },
        { layer: "judge", model: GPT, input: 0, output: 1_000_000 },
        { layer: "resolver", model: KIMI, input: 100_000, output: 10_000 },
        { layer: "other", model: "@cf/cloudflare/clef-flash", input: 4_000, output: 0 },
        { layer: "agents", model: "claude-unlisted", input: 10, output: 20 },
      ],
      0,
    );
    expect(s.byLayer.review).toBeCloseTo(0.35 + 0.12, 8);
    expect(s.byLayer.judge).toBeCloseTo(0.75, 8);
    expect(s.byLayer.resolver).toBeCloseTo(0.095 + 0.04, 8);
    expect(s.byLayer.other).toBe(0);
    expect(s.byLayer.agents).toBeCloseTo(0.0418808, 8);
    expect(s.usd).toBeCloseTo(0.0418808 + 0.47 + 0.75 + 0.135, 8);
    expect(s.perLandedIntent).toBeNull();
    expect(s.unpriced).toEqual({ "@cf/cloudflare/clef-flash": { input: 4_000, output: 0 }, "claude-unlisted": { input: 10, output: 20 } });
    expect(s.byModel["claude-unlisted"]).toEqual({ input: 10, output: 20, usd: null });
    expect(s.byModel[GPT]).toEqual({ input: 1_000_000, output: 1_000_000, usd: 1.1 });
  });

  it("is zero, with nothing to show, when nothing was counted", () => {
    const s = colonySpend([{ layer: "agents", model: GEMMA, input: 0, output: 0 }], 5);
    expect(s.usd).toBe(0);
    expect(s.tokens).toEqual({ input: 0, output: 0 });
    expect(s.byModel).toEqual({});
    expect(spendLine(s)).toBeNull();
    expect(spendDetail(s)).toBe("");
  });

  it("keeps a model id that names a prototype key as data", () => {
    const s = colonySpend([{ layer: "agents", model: "__proto__", input: 3, output: 4 }], 1);
    expect(Object.getPrototypeOf(s.unpriced)).toBe(Object.prototype);
    expect(Object.hasOwn(s.unpriced, "__proto__")).toBe(true);
  });
});

describe("usdText and the spend line", () => {
  it("shows four decimals below a cent, three below a dollar, else two", () => {
    expect(usdText(0.0002)).toBe("$0.0002");
    expect(usdText(0.0419)).toBe("$0.042");
    expect(usdText(0.42)).toBe("$0.420");
    expect(usdText(1.254)).toBe("$1.25");
    expect(usdText(0)).toBe("$0.0000");
    expect(usdText(Number.NaN)).toBe("$0.0000");
  });

  it("says what the model calls cost and what that is a landed intent", () => {
    const s = colonySpend([{ layer: "agents", model: GEMMA, input: 227_842, output: 15_467 }, { layer: "agents", model: KIMI, input: 9_230, output: 1_422 }], 283);
    expect(spendLine(s)).toBe("$0.042 of model calls · $0.0001 a landed intent");
    expect(spendParts(s)).toEqual({ total: "$0.042 of model calls", perIntent: "$0.0001 a landed intent" });
    expect(spendLine({ ...s, perLandedIntent: null })).toBe("$0.042 of model calls");
    expect(spendLine(null)).toBeNull();
    const detail = spendDetail(s).split("\n");
    expect(detail[0]).toBe("Model spend by layer: agents $0.042, review $0.0000, contest judge $0.0000, conflict resolver $0.0000, other $0.0000.");
    expect(detail.at(-1)).toBe(`Priced at Workers AI list prices on ${PRICE_DATE}, from the 237,072 input and 16,889 output tokens the colony counted.`);
  });

  it("says when some tokens are unpriced or some agents are not read yet", () => {
    const s = colonySpend([{ layer: "agents", model: GEMMA, input: 10_000, output: 0 }, { layer: "review", model: "@cf/x/unlisted", input: 7, output: 0 }], 1, { agentsUnread: 2 });
    expect(spendLine(s)).toBe("$0.0010 of model calls (some unpriced) · $0.0010 a landed intent");
    const detail = spendDetail(s);
    expect(detail).toContain("Not priced (no list price): @cf/x/unlisted 7 input / 0 output tokens.");
    expect(detail).toContain("2 in-platform agents not read yet");
  });
});
