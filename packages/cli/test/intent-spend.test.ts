import { describe, expect, it } from "vitest";
import { PRICE_DATE, intentSpend, intentSpendDetail as coreDetail, intentSpendLine as coreLine } from "@fire_trident/core";
import type { IntentSpend } from "@fire_trident/core";
import { colors, formatIntentShow } from "../src/format.ts";
import { intentSpendDetail, intentSpendLine } from "../src/spend.ts";

/** Spend per intent in `ft intent show`: the row reads as core/pricing.ts writes it, and is absent when nothing was counted. */

const GEMMA = "@cf/google/gemma-4-26b-a4b-it";
const GPT = "@cf/openai/gpt-oss-120b";
const CLEF = "@cf/cloudflare/clef";

const COUNTED = intentSpend("int_7", [
  { layer: "agents", model: GEMMA, calls: 2, input: 900, output: 60 },
  { layer: "review", model: CLEF, calls: 1, input: 1_500, output: 0 },
  { layer: "review", model: GPT, calls: 1, input: 2_000, output: 100 },
  { layer: "judge", model: GPT, calls: 2, input: 3_000, output: 200 },
]);

const INTENT = { id: "int_7", colonyId: "web", title: "Expose the version", why: "So the CLI can print it.", source: "human" as const, footprint: ["src/version.ts"], priority: 1, status: "landed" as const, createdAt: 0, createdBy: "m" };

describe("the intent's spend line", () => {
  it("reads as core/pricing.ts writes it, so ft intent show and the web say the same", () => {
    const cases: IntentSpend[] = [
      COUNTED,
      intentSpend("int_8", [{ layer: "review", model: "@cf/x/unlisted", calls: 1, input: 5, output: 0 }, { layer: "agents", model: GEMMA, calls: 1, input: 10_000_000, output: 0 }]),
      intentSpend("int_9", [{ layer: "agents", model: GEMMA, calls: 1, input: 0, output: 0 }]),
      intentSpend("int_0", []),
    ];
    for (const s of cases) {
      expect(intentSpendLine(s)).toBe(coreLine(s));
      expect(intentSpendDetail(s)).toBe(coreDetail(s));
    }
    expect(intentSpendLine(COUNTED)).toBe("$0.0024 of model calls");
    expect(intentSpendLine(undefined)).toBeNull();
    expect(intentSpendLine({ usd: "1" } as unknown as IntentSpend)).toBeNull();
  });
});

describe("ft intent show", () => {
  const c = colors(false);

  it("prints what the intent's model calls cost, with the layers, calls, tokens and the prices' date", () => {
    const out = formatIntentShow({ intent: INTENT, spend: COUNTED }, c, 120_000);
    expect(out).toContain(
      `spend     $0.0024 of model calls (agents $0.0001 in 2 calls, review $0.0011 in 2 calls, contest judge $0.0012 in 2 calls; 7,400 input and 360 output tokens at Workers AI list prices on ${PRICE_DATE})`,
    );
  });

  it("prints no spend row for an intent nothing was counted for, or a server that sends none", () => {
    expect(formatIntentShow({ intent: INTENT, spend: intentSpend("int_7", []) }, c, 120_000)).not.toContain("spend ");
    expect(formatIntentShow({ intent: INTENT }, c, 120_000)).not.toContain("spend ");
  });
});
