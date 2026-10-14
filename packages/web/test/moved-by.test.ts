import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ColonyEvent, ColonySnapshot, MovedBy } from "@fire_trident/core";
import { MovedBadge, MovedByList } from "../src/components/MovedBy.tsx";
import { cleanMoved, movedLabel, movedLines } from "../src/moved.ts";
import { ColonyStore } from "../src/store.ts";

/** What beat a returned change (movedBy) in the UI: the store keeps it from proposal events, and the cards show it. */

const MOVED: MovedBy[] = [
  { landingId: "lnd_a", paths: ["src/values.ts"], trunkSha: "2".repeat(40), at: 5, intentId: "int_a", title: "Cache lookups", why: "Lookups repeat.", agentId: "agt_a", model: "@cf/vendor/model" },
];

function loaded(): ColonyStore {
  const s = new ColonyStore("web");
  s.now = () => 1_000_000;
  s.applySnapshot({
    colony: { id: "web", name: "web", trunk: { namespace: "n", name: "t", remote: "r" }, trunkSha: "a".repeat(40), createdAt: 0, regionDepth: 1 },
    files: [{ path: "src/values.ts", size: 10 }],
    intents: [{ id: "int_b", colonyId: "web", title: "Rename the flag", why: "w", source: "human", footprint: ["src/values.ts"], priority: 1, status: "claimed", createdAt: 0, createdBy: "t" }],
    rules: [],
    agents: [{ id: "agt_a", colonyId: "web", kind: "internal", name: "ant-7", thresholds: {}, state: "idle", lastSeen: 0 }],
    recentLandings: [],
    violations: { total: 0, byRule: {} },
    funnel: { reflex: 0, llm: 0, human: 0 },
    metrics: {},
  } as unknown as ColonySnapshot);
  return s;
}

const returned = (proposalId: string, at: number, extra: Record<string, unknown> = {}): ColonyEvent =>
  ({ t: "proposal", at, proposalId, intentId: "int_b", agentId: "agt_b", status: "returned", reason: "stale: src/values.ts", ...extra }) as ColonyEvent;

describe("movedBy in the UI store", () => {
  it("keeps the landings that beat a returned change, on the proposal and as its intent's latest return", () => {
    const s = loaded();
    const v0 = s.intentsVersion;
    s.applyEvents([returned("prp_1", 10, { movedBy: MOVED })]);
    expect(s.proposals.get("prp_1")?.movedBy).toEqual(MOVED);
    expect(s.returns.get("int_b")).toMatchObject({ n: 1, movedBy: MOVED });
    expect(s.intentsVersion).toBeGreaterThan(v0);
    // The next return without one (a review return) is the latest: nothing beat it.
    s.applyEvents([returned("prp_2", 20, { reason: "llm: the flag is still read" })]);
    expect(s.returns.get("int_b")).toMatchObject({ n: 2, reason: "llm: the flag is still read" });
    expect(s.returns.get("int_b")?.movedBy).toBeUndefined();
  });

  it("drops what it cannot use", () => {
    expect(cleanMoved("lnd_a")).toBeUndefined();
    expect(cleanMoved([{ landingId: "lnd_a", paths: [] }, { paths: ["a"] }, null])).toBeUndefined();
    expect(cleanMoved([{ ...MOVED[0], title: 7, at: "soon" }])).toEqual([{ landingId: "lnd_a", paths: ["src/values.ts"], trunkSha: "2".repeat(40), intentId: "int_a", why: "Lookups repeat.", agentId: "agt_a", model: "@cf/vendor/model" }]);
  });
});

describe("movedBy on the cards", () => {
  it("says what beat a change in one line per landing, and labels it by its intent", () => {
    expect(movedLines(MOVED, (id) => (id === "agt_a" ? "ant-7" : id))).toEqual(['src/values.ts moved by "Cache lookups", ant-7 · @cf/vendor/model (2222222): Lookups repeat.']);
    expect(movedLabel(MOVED)).toBe("Cache lookups");
    expect(movedLabel([...MOVED, { landingId: "lnd_b", paths: ["x"] }])).toBe("Cache lookups +1");
    expect(movedLabel([{ landingId: "lnd_b", paths: ["x"] }])).toBe("lnd_b");
  });

  it("an intent whose latest change came back wears a badge naming what beat it (the intent card's, from the store)", () => {
    const s = loaded();
    s.applyEvents([returned("prp_1", 10, { movedBy: MOVED })]);
    const html = renderToStaticMarkup(createElement(MovedBadge, { moved: s.returns.get("int_b")!.movedBy!, agentName: (id: string) => s.agentName(id) }));
    expect(html).toContain(">lost to Cache lookups</span>");
    expect(html).toContain("ibadge-moved");
    expect(html).toContain("Keep what these landings did unless the intent says otherwise:\nsrc/values.ts moved by &quot;Cache lookups&quot;");
    expect(renderToStaticMarkup(createElement(MovedBadge, { moved: [] }))).toBe("");
  });

  it("a review card lists the landings its change was redone on, as text", () => {
    const html = renderToStaticMarkup(createElement(MovedByList, { moved: [{ ...MOVED[0]!, title: "<b>bold</b>" }] }));
    expect(html).toContain("Its intent&#x27;s last change came back: trunk moved its files.");
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt;");
    expect(html).not.toContain("<b>bold</b>");
  });
});
