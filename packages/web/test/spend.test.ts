import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PRICE_DATE, colonySpend, spendDetail, spendLine } from "@fire_trident/core";
import type { ColonySnapshot } from "@fire_trident/core";
import { SpendNote } from "../src/components/Spend.tsx";
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
    expect(spendLine(s)).toBe("$0.042 of model calls this platform made · $0.0001 a landed intent");
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
    expect(spendLine(store.spend)).toBe("$0.042 of model calls this platform made · $0.0001 a landed intent");
    store.applySpend({ ...HONO, usd: 1.5, perLandedIntent: 0.25 });
    expect(spendLine(store.spend)).toBe("$1.50 of model calls this platform made · $0.250 a landed intent");
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

describe("the spend cap in the top bar", () => {
  const cap = { usd: 5, reviewReserveUsd: 0.5, spentUsd: 4.6, inFlightUsd: 0, state: "review-only", setBy: "maya", setAt: 1 };

  it("is read with the spend, defensively, and absent when the server sends none", () => {
    expect(parseSpend({ ...JSON.parse(JSON.stringify(HONO)), cap })?.cap).toEqual(cap);
    expect(parseSpend({ ...JSON.parse(JSON.stringify(HONO)), cap: { usd: "5" } })?.cap).toBeUndefined();
    expect(parseSpend({ ...JSON.parse(JSON.stringify(HONO)), cap: { usd: 5, state: "<b>", setBy: 3 } })?.cap).toEqual({ usd: 5, reviewReserveUsd: 0, spentUsd: 0, inFlightUsd: 0, state: "open", setBy: "", setAt: 0 });
    expect(parseSpend(JSON.parse(JSON.stringify(HONO)))?.cap).toBeUndefined();
  });

  it("shows under the spend as a short line, colored once agents stopped at it, its sentence in the title, and alone before any model call", () => {
    const html = renderToStaticMarkup(createElement(SpendNote, { spend: parseSpend({ ...JSON.parse(JSON.stringify(HONO)), cap }) }));
    expect(html).toContain('<div class="spend has-cap spend-cap-review-only"');
    // The figure, then the words narrow top bars leave to the title (styles.css).
    expect(html).toContain('<div class="spend-line spend-total">$0.042<span class="spend-scope"> of model calls this platform made</span></div>');
    expect(html).toContain('<div class="stat-sub spend-cap">$4.60 of $5.00 cap</div>');
    expect(html).toContain("Spend cap: cap $5.00: $4.60 spent, agents stopped at $4.50; review spends its $0.500 reserve.");
    expect(html).toContain("Only the model calls this platform made count: what external agents spend on their own models is not seen here.");
    const none = parseSpend({ ...JSON.parse(JSON.stringify(colonySpend([], 0))), cap: { ...cap, spentUsd: 0, state: "open" } });
    const alone = renderToStaticMarkup(createElement(SpendNote, { spend: none }));
    expect(alone).toContain("no model calls yet");
    expect(alone).toContain('<div class="stat-sub spend-cap">$0.0000 of $5.00 cap</div>');
    expect(alone).toContain('title="Spend cap: cap $5.00: $0.0000 spent, agents stop at $4.50 and review keeps $0.500."');
    expect(renderToStaticMarkup(createElement(SpendNote, { spend: parseSpend(JSON.parse(JSON.stringify(colonySpend([], 0)))) }))).toBe("");
    // With no cap there is no cap line and no has-cap class: below 1460 px the spend stays hidden as before.
    const plain = renderToStaticMarkup(createElement(SpendNote, { spend: HONO }));
    expect(plain).not.toContain("spend-cap");
    expect(plain).toContain('<div class="spend"');
  });
});
