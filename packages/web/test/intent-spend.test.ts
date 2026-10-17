import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PRICE_DATE, intentSpend, intentSpendBrief } from "@fire_trident/core";
import type { ColonySnapshot } from "@fire_trident/core";
import { IntentsTab } from "../src/components/IntentsTab.tsx";
import { parseIntentSpendBrief, parseIntentSpendMap } from "../src/spend.ts";
import { ColonyStore } from "../src/store.ts";

// The tab re-renders on a throttled store subscription; a static render needs none.
vi.mock("../src/useStore.ts", () => ({ useThrottledVersion: () => 0 }));

/** Spend per intent in the Intents tab: a row says what its model calls cost, where the colony counted them. */

const NOW = 50_000_000;
const A = "a".repeat(40);
const GEMMA = "@cf/google/gemma-4-26b-a4b-it";
const CLEF = "@cf/cloudflare/clef";

const ONE = intentSpendBrief(
  intentSpend("int_1", [
    { layer: "agents", model: GEMMA, calls: 2, input: 900, output: 60 },
    { layer: "review", model: CLEF, calls: 1, input: 1_500, output: 0 },
  ]),
)!;

const intent = (id: string) => ({ id, colonyId: "web", title: `Intent ${id}`, why: "w", source: "human", footprint: ["src/a.ts"], priority: 1, status: "landed", createdAt: NOW - 60_000, createdBy: "m" });

function loaded(extra: Record<string, unknown> = {}): ColonyStore {
  const s = new ColonyStore("web");
  s.now = () => NOW;
  s.applySnapshot({
    colony: { id: "web", name: "web", trunk: { namespace: "n", name: "t", remote: "r" }, trunkSha: A, createdAt: 0, regionDepth: 1 },
    files: [],
    intents: [intent("int_1"), intent("int_2")],
    rules: [],
    agents: [],
    recentLandings: [],
    violations: { total: 0, byRule: {} },
    funnel: { reflex: 0, llm: 0, human: 0 },
    metrics: {},
    ...extra,
  } as unknown as ColonySnapshot);
  return s;
}

describe("parseIntentSpendMap", () => {
  it("reads the server's map as it was sent, dropping entries that are not an intent's spend", () => {
    const map = parseIntentSpendMap(JSON.parse(JSON.stringify({ int_1: ONE, int_2: { usd: "x" }, int_3: 3 })));
    expect(map?.get("int_1")).toEqual(ONE);
    expect([...(map?.keys() ?? [])]).toEqual(["int_1"]);
    expect(parseIntentSpendBrief({ usd: 0.5, tokens: { input: 10 }, byLayer: { agents: { usd: 0.5, calls: 1 }, bogus: 9 }, unpriced: true })).toEqual({
      usd: 0.5,
      byLayer: { agents: { usd: 0.5, calls: 1 } },
      tokens: { input: 10, output: 0 },
      unpriced: true,
    });
  });

  it("is null for an older server, a mock or a replay", () => {
    expect(parseIntentSpendMap(undefined)).toBeNull();
    expect(parseIntentSpendMap("x")).toBeNull();
    expect(parseIntentSpendMap([])).toBeNull();
  });
});

describe("the store's spend per intent", () => {
  it("comes with the snapshot and moves with each metrics refresh", () => {
    const store = loaded({ intentSpend: { int_1: ONE } });
    expect(store.intentSpend.get("int_1")).toEqual(ONE);
    store.applyIntentSpend({ int_2: ONE });
    expect(store.intentSpend.has("int_1")).toBe(false);
    expect(store.intentSpend.get("int_2")).toEqual(ONE);
    // A refresh from a server that sends none keeps what the page has.
    store.applyIntentSpend(undefined);
    expect(store.intentSpend.get("int_2")).toEqual(ONE);
  });

  it("is empty for a snapshot without it", () => {
    expect(loaded().intentSpend.size).toBe(0);
  });
});

describe("the Intents tab", () => {
  it("shows what an intent's model calls cost on its row, with the layers and calls behind it", () => {
    const html = renderToStaticMarkup(createElement(IntentsTab, { store: loaded({ intentSpend: { int_1: ONE } }), onPick: () => undefined }));
    expect(html).toContain('<span class="intent-spend" title="agents $0.0001 in 2 calls, review $0.0004 in 1 call; 2,400 input and 60 output tokens at Workers AI list prices on ');
    expect(html).toContain(`${PRICE_DATE}.">$0.0005 of model calls this platform made</span>`);
    expect(html.split("of model calls").length - 1).toBe(1);
  });

  it("shows nothing for an intent nothing was counted for, rather than a spend of zero", () => {
    const html = renderToStaticMarkup(createElement(IntentsTab, { store: loaded(), onPick: () => undefined }));
    expect(html).toContain("Intent int_1");
    expect(html).not.toContain("of model calls");
    expect(html).not.toContain("intent-spend");
  });
});
