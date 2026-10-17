import { describe, expect, it } from "vitest";
import { colonySpend, spendLine as coreSpendLine, usdText as coreUsdText } from "@fire_trident/core";
import type { ColonySpend } from "@fire_trident/core";
import { colors, formatStatus, type SnapshotLike } from "../src/format.ts";
import { spendLine, usdText } from "../src/spend.ts";

const GEMMA = "@cf/google/gemma-4-26b-a4b-it";
const KIMI = "@cf/moonshotai/kimi-k2.7-code";
const NOW = 1_800_000_000_000;

/** The round-7 Hono run's agents (packages/bench/results/2026-10-14-round7/checks/p21-hono.log), 283 intents landed. */
const HONO = colonySpend(
  [
    { layer: "agents", model: GEMMA, input: 227_842, output: 15_467 },
    { layer: "agents", model: KIMI, input: 9_230, output: 1_422 },
  ],
  283,
);

function snapshot(spend?: ColonySpend): SnapshotLike {
  return { colony: { id: "hono", name: "hono", trunk: { namespace: "ft-trunk", name: "hono--trunk" }, trunkSha: "588ec13fa6", createdAt: NOW - 1_000, regionDepth: 3 } as SnapshotLike["colony"], ...(spend ? { spend } : {}) };
}

describe("the spend line", () => {
  it("reads as core/pricing.ts writes it, so ft status and the web say the same", () => {
    const cases: ColonySpend[] = [
      HONO,
      { ...HONO, perLandedIntent: null },
      colonySpend([{ layer: "review", model: "@cf/x/unlisted", input: 5, output: 0 }, { layer: "agents", model: GEMMA, input: 10_000_000, output: 0 }], 2),
      colonySpend([{ layer: "agents", model: KIMI, input: 1_000_000, output: 1_000_000 }], 1),
    ];
    for (const s of cases) expect(spendLine(s)).toBe(coreSpendLine(s));
    for (const v of [0, 0.00002, 0.0099, 0.042, 0.5, 1, 12.345, Number.NaN]) expect(usdText(v)).toBe(coreUsdText(v));
    expect(spendLine(HONO)).toBe("$0.042 of model calls this platform made · $0.0001 a landed intent");
  });

  it("is absent when the colony made no model call or the server sends no spend", () => {
    expect(spendLine(colonySpend([], 0))).toBeNull();
    expect(spendLine(undefined)).toBeNull();
    expect(spendLine({ usd: "1" } as unknown as ColonySpend)).toBeNull();
  });
});

describe("ft status", () => {
  it("prints the colony's model spend and the prices' date", () => {
    const out = formatStatus(snapshot(HONO), colors(false), NOW);
    expect(out).toContain("spend      $0.042 of model calls this platform made · $0.0001 a landed intent (Workers AI list prices on 2026-10-12)");
  });

  it("prints no spend row for a colony with no model calls, or a server that sends none", () => {
    expect(formatStatus(snapshot(colonySpend([], 0)), colors(false), NOW)).not.toContain("spend ");
    expect(formatStatus(snapshot(), colors(false), NOW)).not.toContain("spend ");
  });
});
