import { describe, expect, it } from "vitest";
import type { ColonyEvent, ColonySnapshot } from "@fire_trident/core";
import { ColonyStore, escalationOf, REPEATED_RETURNS } from "../src/store.ts";

/** The UI store applying escalations, contests, landing notices and assumption revalidation. */

const intent = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  colonyId: "web",
  title: `Intent ${id}`,
  why: `why ${id}`,
  source: "human",
  footprint: [`src/${id}.ts`],
  priority: 1,
  status: "open",
  createdAt: 0,
  createdBy: "t",
  ...extra,
});

function loaded(intents: unknown[] = [], agents: unknown[] = []): ColonyStore {
  const s = new ColonyStore("web");
  s.now = () => 1_000_000;
  s.applySnapshot({
    colony: { id: "web", name: "web", trunk: { namespace: "n", name: "t", remote: "r" }, trunkSha: "a".repeat(40), createdAt: 0, regionDepth: 1 },
    files: [{ path: "src/a.ts", size: 10 }],
    intents,
    rules: [],
    agents,
    recentLandings: [],
    violations: { total: 0, byRule: {} },
    funnel: { reflex: 0, llm: 0, human: 0 },
    metrics: {},
  } as unknown as ColonySnapshot);
  return s;
}

const report = (intentId: string, at: number, extra: Record<string, unknown> = {}): ColonyEvent =>
  ({ t: "escalation", at, intentId, agentId: "agt_1", kind: "broken-test", report: "the test asserts the old value", title: `Intent ${intentId}`, ...extra }) as ColonyEvent;

describe("escalations in the UI store", () => {
  it("loads open and answered reports from the snapshot, and only open ones wait for a person", () => {
    const s = loaded([
      intent("i1", { escalation: { kind: "contradictory-spec", report: "a and b conflict", by: "agt_1", at: 5 } }),
      intent("i2", { escalation: { kind: "impossible", report: "no caller", by: "agt_2", at: 6, resolved: { by: "matt", at: 7, decision: "dismiss", note: "it is fine" } } }),
      intent("i3"),
    ]);
    expect(s.openEscalations().map((e) => e.intentId)).toEqual(["i1"]);
    expect(s.escalations.get("i1")).toMatchObject({ kind: "contradictory-spec", report: "a and b conflict", agentId: "agt_1", at: 5, title: "Intent i1" });
    expect(s.escalations.get("i2")?.resolved).toEqual({ by: "matt", at: 7, decision: "dismiss", note: "it is fine" });
  });

  it("opens a card on an escalation event, then answers it when a person resolves it", () => {
    const s = loaded([intent("i1")]);
    const v0 = s.reviewVersion;
    s.applyEvents([report("i1", 10)]);
    expect(s.openEscalations()).toHaveLength(1);
    expect(s.openEscalations()[0]).toMatchObject({ intentId: "i1", kind: "broken-test", report: "the test asserts the old value", agentId: "agt_1", at: 10 });
    expect(s.reviewVersion).toBeGreaterThan(v0);
    // The answer may come without the report's own fields: the card keeps what the agent said.
    s.applyEvents([{ t: "escalation", at: 20, intentId: "i1", agentId: "agt_1", kind: "broken-test", report: "", title: "Intent i1", resolved: { by: "matt", at: 20, decision: "amend", note: "use the new value" } }]);
    expect(s.openEscalations()).toHaveLength(0);
    expect(s.escalations.get("i1")).toMatchObject({ report: "the test asserts the old value", resolved: { decision: "amend", by: "matt", note: "use the new value" } });
    expect(s.recentlyResolved(120_000, 30).map((e) => e.intentId)).toEqual(["i1"]);
    expect(s.recentlyResolved(120_000, 500_000)).toHaveLength(0);
    expect(s.typeCounts.get("escalation")).toBe(2);
  });

  it("treats a report on an intent that landed or was withdrawn as settled", () => {
    const s = loaded([intent("i1"), intent("i2")]);
    s.applyEvents([report("i1", 10), report("i2", 11)]);
    s.applyEvents([{ t: "withdrawn", at: 12, intentId: "i2", reason: "not needed", by: "matt", title: "Intent i2", returned: 0 }]);
    expect(s.openEscalations().map((e) => e.intentId)).toEqual(["i1"]);
  });

  it("keeps a report on an intent the snapshot does not hold, and survives malformed ones", () => {
    const s = loaded([]);
    s.applyEvents([report("i9", 10, { kind: "nonsense", report: 42 }), { t: "escalation", at: 11 } as unknown as ColonyEvent]);
    expect(s.openEscalations()).toEqual([expect.objectContaining({ intentId: "i9", kind: "other", report: "", title: "Intent i9" })]);
    expect(escalationOf("", { kind: "other" }, "t", 0)).toBeNull();
    expect(escalationOf("i1", null, "t", 0)).toBeNull();
    // An answer with a decision this UI does not know is not an answer.
    expect(escalationOf("i1", { kind: "other", resolved: { decision: "ignore" } }, "t", 0)?.resolved).toBeUndefined();
  });

  it("rebuilds reports from each snapshot (the snapshot holds every active intent)", () => {
    const s = loaded([intent("i1")]);
    s.applyEvents([report("i1", 10)]);
    s.applySnapshot({ colony: s.colony, files: [], intents: [intent("i1")], rules: [], agents: [], recentLandings: [], violations: { total: 0, byRule: {} }, funnel: { reflex: 0, llm: 0, human: 0 }, metrics: {} } as unknown as ColonySnapshot);
    expect(s.openEscalations()).toHaveLength(0);
  });
});

describe("contests in the UI store", () => {
  it("reads contest sizes from the snapshot and from intent events", () => {
    const s = loaded([intent("i1", { contest: 3 }), intent("i2", { contest: 1 }), intent("i3", { contest: 9 })]);
    expect(s.intents.get("i1")?.contest).toBe(3);
    expect(s.intents.get("i2")?.contest).toBeUndefined();
    expect(s.intents.get("i3")?.contest).toBe(4);
    s.applyEvents([{ t: "intent", at: 1, intentId: "i4", status: "open", title: "Four", footprint: ["src/a.ts"], contest: 2 } as unknown as ColonyEvent]);
    expect(s.intents.get("i4")?.contest).toBe(2);
  });

  it("marks the losers superseded, before or after their proposal events, and does not count them as returns", () => {
    const s = loaded([intent("i1")]);
    s.applyEvents([{ t: "proposal", at: 1, proposalId: "p1", intentId: "i1", agentId: "agt_1", status: "pending" }]);
    s.applyEvents([{ t: "contest", at: 2, intentId: "i1", title: "Intent i1", winner: "p3", losers: ["p1", "p2"], reason: "it passed first" }]);
    s.applyEvents([
      { t: "proposal", at: 3, proposalId: "p1", intentId: "i1", agentId: "agt_1", status: "returned", reason: "superseded by p3" },
      { t: "proposal", at: 3, proposalId: "p2", intentId: "i1", agentId: "agt_2", status: "returned" },
    ]);
    expect(s.proposals.get("p1")?.supersededBy).toBe("p3");
    expect(s.proposals.get("p2")?.supersededBy).toBe("p3");
    expect(s.superseded.get("p2")).toBe("p3");
    // A contest decided after the page opened tells the intent it was one.
    expect(s.intents.get("i1")?.contest).toBe(3);
    expect(s.returns.get("i1")).toBeUndefined();
  });
});

describe("returned intents in the UI store", () => {
  it("counts returns per intent, leaves out direction changes, and lists intents still in play", () => {
    const s = loaded([intent("i1"), intent("i2"), intent("i3")]);
    const ret = (pid: string, iid: string, reason: string): ColonyEvent => ({ t: "proposal", at: 1, proposalId: pid, intentId: iid, agentId: "agt_1", status: "returned", reason });
    for (let k = 0; k < REPEATED_RETURNS; k++) s.applyEvents([ret(`a${k}`, "i1", `stale: src/i1.ts (${k})`), ret(`b${k}`, "i2", "intent revised to r2")]);
    s.applyEvents([ret("c1", "i3", "stale"), ret("c2", "i3", "stale"), ret("c3", "i3", "stale")]);
    // The same proposal reported returned twice counts once.
    s.applyEvents([ret("c3", "i3", "stale")]);
    expect(s.returns.get("i1")).toMatchObject({ n: REPEATED_RETURNS, reason: `stale: src/i1.ts (${REPEATED_RETURNS - 1})` });
    expect(s.returns.get("i2")).toBeUndefined();
    expect(s.repeatedReturns().map((r) => [r.intent.id, r.returns])).toEqual([
      ["i1", 3],
      ["i3", 3],
    ]);
    s.applyEvents([{ t: "intent", at: 5, intentId: "i3", status: "landed", title: "Intent i3", footprint: ["src/i3.ts"] }]);
    expect(s.repeatedReturns().map((r) => r.intent.id)).toEqual(["i1"]);
    expect(s.repeatedReturns(4)).toEqual([]);
  });
});

describe("landing notices and revalidation in the UI store", () => {
  it("groups the notices sent after one landing into one line, and keeps them out of direction counts", () => {
    const s = loaded();
    const notice = (id: string, agent: string, at: number, extra: Record<string, unknown> = {}): ColonyEvent =>
      ({ t: "directive", at, directiveId: id, agentId: agent, message: "src/context.ts changed on trunk", by: "colony", kind: "landing", ...extra }) as ColonyEvent;
    s.applyEvents([{ t: "landing", at: 100, landingId: "l1", trunkSha: "b".repeat(40), proposalIds: [], paths: ["src/context.ts"] }]);
    s.applyEvents([notice("d1", "agt_1", 101), notice("d2", "agt_2", 102), notice("d3", "agt_1", 103)]);
    s.applyEvents([{ t: "landing", at: 200, landingId: "l2", trunkSha: "c".repeat(40), proposalIds: [], paths: ["src/app.ts"] }]);
    s.applyEvents([notice("d4", "agt_3", 201)]);
    const lines = s.recentEvents((e) => e.t === "directive", 10);
    expect(lines).toHaveLength(4);
    const first = lines.find((l) => (l.ev as { directiveId?: string }).directiveId === "d1")?.group;
    expect(first).toBeDefined();
    expect(lines.filter((l) => l.group === first)).toHaveLength(3);
    expect(first).toMatchObject({ agents: ["agt_1", "agt_2"], message: "src/context.ts changed on trunk", by: "colony", first: 101, last: 103 });
    expect(lines.find((l) => (l.ev as { directiveId?: string }).directiveId === "d4")?.group).not.toBe(first);
    expect(s.landingNotices).toBe(4);
    expect(s.direction.directives).toBe(0);
    // A human directive is direction, and is never grouped.
    s.applyEvents([{ t: "directive", at: 300, directiveId: "d5", agentId: "agt_1", message: "keep it short", by: "matt" }]);
    expect(s.direction.directives).toBe(1);
    expect(s.recentEvents((e) => e.t === "directive", 1)[0]?.group).toBeUndefined();
  });

  it("groups by the landing a notice names, and splits notices too far apart", () => {
    const s = loaded();
    const named = (id: string, agent: string, at: number, landingId: string): ColonyEvent =>
      ({ t: "directive", at, directiveId: id, agentId: agent, message: "changed", by: "colony", kind: "landing", landing: { landingId, paths: [{ path: "src/a.ts" }, { path: "src/b.ts" }] } }) as unknown as ColonyEvent;
    s.applyEvents([named("d1", "agt_1", 10, "l1"), named("d2", "agt_2", 11, "l2"), named("d3", "agt_3", 12, "l1")]);
    const groups = new Set(s.recentEvents((e) => e.t === "directive", 10).map((l) => l.group));
    expect(groups.size).toBe(2);
    const l1 = s.recentEvents((e) => (e as { directiveId?: string }).directiveId === "d3", 1)[0]?.group;
    expect(l1).toMatchObject({ key: "landing:l1", agents: ["agt_1", "agt_3"], paths: ["src/a.ts", "src/b.ts"] });
    const late = loaded();
    const plain = (id: string, at: number): ColonyEvent => ({ t: "directive", at, directiveId: id, agentId: id, message: "m", by: "colony", kind: "landing" }) as ColonyEvent;
    late.applyEvents([plain("x1", 1_000), plain("x2", 40_000)]);
    expect(new Set(late.recentEvents((e) => e.t === "directive", 10).map((l) => l.group)).size).toBe(2);
  });

  it("logs revalidated events and takes a waiting agent's reason when the event carries one", () => {
    const s = loaded([], [{ id: "agt_1", colonyId: "web", kind: "internal", name: "a1", thresholds: {}, state: "working", lastSeen: 0 }]);
    s.applyEvents([{ t: "revalidated", at: 5, proposalId: "p1", intentId: "i1", paths: ["src/app.ts"], names: ["Context", "Router"] }]);
    expect(s.typeCounts.get("revalidated")).toBe(1);
    s.applyEvents([{ t: "agent", at: 6, agentId: "agt_1", kind: "internal", state: "waiting", reason: "admission closed in every candidate region" } as unknown as ColonyEvent]);
    expect(s.agents.get("agt_1")?.waitReason).toBe("admission closed in every candidate region");
    s.applyEvents([{ t: "agent", at: 7, agentId: "agt_1", kind: "internal", state: "working", intentId: "i1" }]);
    expect(s.agents.get("agt_1")?.waitReason).toBeUndefined();
    // An agent that joins after the snapshot takes its name and model from its event when the event carries them.
    s.applyEvents([{ t: "agent", at: 8, agentId: "agt_9", kind: "external", state: "idle", name: "visitor-agent", model: "m-2" } as unknown as ColonyEvent]);
    expect(s.agents.get("agt_9")).toMatchObject({ name: "visitor-agent", model: "m-2" });
    expect(s.agentName("agt_9")).toBe("visitor-agent");
  });

  it("forgets reports, contests, returns and notices when a replay starts over", () => {
    const s = loaded([intent("i1")]);
    s.applyEvents([
      report("i1", 1),
      { t: "contest", at: 2, intentId: "i1", title: "t", winner: "p2", losers: ["p1"], reason: "r" },
      { t: "proposal", at: 3, proposalId: "p9", intentId: "i1", agentId: "a", status: "returned", reason: "stale" },
      { t: "directive", at: 4, directiveId: "d", agentId: "a", message: "m", by: "colony", kind: "landing" },
    ]);
    s.reset();
    expect([s.escalations.size, s.superseded.size, s.returns.size, s.landingNotices]).toEqual([0, 0, 0, 0]);
  });
});
