import { describe, expect, it } from "vitest";
import { colonySpend, spendCapLine as coreSpendCapLine } from "@fire_trident/core";
import type { SpendCap } from "@fire_trident/core";
import { parseCommand } from "../src/args.ts";
import { planRequest } from "../src/api.ts";
import { colors, formatStatus, type SnapshotLike } from "../src/format.ts";
import { formatPause } from "../src/pause.ts";
import { formatSpendCap, spendCapLine } from "../src/spendcap.ts";

/** `ft spend-cap` (the spend cap, packages/worker/src/colony/spendcap.ts) and the cap in `ft status`. */

const NOW = 1_800_000_000_000;
const c = colors(false);
const CAP: SpendCap = { usd: 5, reviewReserveUsd: 0.5, spentUsd: 1.2, inFlightUsd: 0.01, state: "open", setBy: "maya", setAt: NOW - 1_000 };

function parsed(argv: string[]) {
  const r = parseCommand(argv);
  if (!r.ok) throw new Error(r.error);
  return r.command;
}

describe("ft spend-cap", () => {
  it("sets the cap, with or without a review reserve, removes it with off, and shows it with no amount", () => {
    expect(parsed(["spend-cap", "web", "5"])).toEqual({ name: "spend-cap", colony: "web", usd: 5 });
    expect(parsed(["spend-cap", "web", "$20", "--review-reserve", "2", "--by", "lee"])).toEqual({ name: "spend-cap", colony: "web", usd: 20, reviewReserveUsd: 2, by: "lee" });
    expect(parsed(["spend-cap", "web", "off"])).toEqual({ name: "spend-cap", colony: "web", usd: null });
    expect(parsed(["spend-cap", "web"])).toEqual({ name: "spend-cap", colony: "web" });
    expect(planRequest(parsed(["spend-cap", "web", "12.50", "--review-reserve", "0"]), "maya")).toEqual({
      method: "POST",
      path: "/api/colonies/web/spend-cap",
      body: { usd: 12.5, reviewReserveUsd: 0, by: "maya" },
    });
    expect(planRequest(parsed(["spend-cap", "web", "off"]), "maya")).toEqual({ method: "POST", path: "/api/colonies/web/spend-cap", body: { usd: null, by: "maya" } });
    expect(planRequest(parsed(["spend-cap", "web"]), "maya")).toEqual({ method: "GET", path: "/api/colonies/web/spend-cap" });
  });

  it("says what is wrong with an amount", () => {
    for (const [argv, error] of [
      [["spend-cap"], "missing <colony>"],
      [["spend-cap", "web", "0"], "the cap must be a dollar amount above 0"],
      [["spend-cap", "web", "five"], 'got "five"'],
      [["spend-cap", "web", "5", "--review-reserve", "5"], "--review-reserve must be a dollar amount of at least 0 and below the cap of $5.00"],
      [["spend-cap", "web", "off", "--review-reserve", "1"], "--review-reserve does not apply when removing the cap"],
      [["spend-cap", "web", "--review-reserve", "1"], "name the cap in dollars"],
      [["spend-cap", "web", "5", "6"], 'unexpected argument "6"'],
    ] as const) {
      const r = parseCommand([...argv]);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain(error);
    }
  });

  it("answers in words: the server's note, and that only the platform's own calls count", () => {
    const set = formatSpendCap({ name: "spend-cap", colony: "web", usd: 5 }, { cap: CAP, lifted: false, tripped: false, note: "Model calls this platform makes for the colony stop at $5.00." }, c);
    expect(set).toBe(
      ["Capped web.", "  Model calls this platform makes for the colony stop at $5.00.", "  It counts the model calls this platform makes for the colony, not what external agents spend on their own models."].join("\n"),
    );
    expect(formatSpendCap({ name: "spend-cap", colony: "web", usd: 1 }, { cap: { ...CAP, state: "spent" }, tripped: true, note: "x" }, c)).toMatch(/^Capped web: the cap is already reached\./);
    expect(formatSpendCap({ name: "spend-cap", colony: "web", usd: null }, { cap: null, lifted: true, note: "No spend cap: model calls go on with no limit." }, c)).toBe(
      "Removed the spend cap on web.\n  No spend cap: model calls go on with no limit.",
    );
    expect(formatSpendCap({ name: "spend-cap", colony: "web" }, { cap: CAP }, c)).toContain("Spend cap on web: cap $5.00: $1.20 spent, agents stop at $4.50 and review keeps $0.500");
    expect(formatSpendCap({ name: "spend-cap", colony: "web" }, { cap: null }, c)).toContain("No spend cap on web");
  });

  it("writes the cap's line as core/pricing.ts does, so ft status and the web say the same", () => {
    for (const cap of [CAP, { ...CAP, state: "review-only" as const, spentUsd: 4.6 }, { ...CAP, state: "spent" as const, spentUsd: 5.01 }, { ...CAP, reviewReserveUsd: 0 }]) expect(spendCapLine(cap)).toBe(coreSpendCapLine(cap));
    expect(spendCapLine(null)).toBeNull();
  });
});

describe("the cap in ft status and in a resume", () => {
  it("prints the cap's row beside the spend, and none without a cap", () => {
    const spend = { ...colonySpend([{ layer: "agents", model: "@cf/openai/gpt-oss-120b", input: 1_000_000, output: 0 }], 1), cap: { ...CAP, state: "review-only" as const, spentUsd: 4.6 } };
    const snap = { colony: { id: "web", name: "web", trunk: { namespace: "ft-trunk", name: "web--trunk" }, trunkSha: "588ec13fa6", createdAt: NOW - 1_000, regionDepth: 1 } as SnapshotLike["colony"] };
    const out = formatStatus({ ...snap, spend }, c, NOW);
    expect(out).toContain("spend      $0.350 of model calls this platform made · $0.350 a landed intent");
    expect(out).toContain("spend cap  cap $5.00: $4.60 spent, agents stopped at $4.50; review spends its $0.500 reserve");
    expect(formatStatus({ ...snap, spend: { ...spend, cap: undefined } }, c, NOW)).not.toContain("spend cap");
  });

  it("tells a person who resumed while the spend is still at the cap that the next call pauses again", () => {
    const note = "The spend cap still leaves $0.015, less than the next model call may need (up to $0.068 for @cf/moonshotai/kimi-k2.7-code with up to 16,000 output tokens): it will pause again at the next call. Raise the cap or remove it: ft spend-cap web <usd> (or off).";
    const out = formatPause({ name: "resume", colony: "web" }, { resumed: { by: "lee" }, pauses: [], spendCap: note }, c);
    expect(out.split("\n")).toEqual(["Resumed the colony web: agents may work again, and the lanes land what waited in them.", `  ${note}`]);
  });
});
