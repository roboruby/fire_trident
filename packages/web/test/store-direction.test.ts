import { describe, expect, it } from "vitest";
import type { ColonySnapshot } from "@fire_trident/core";
import { ColonyStore } from "../src/store.ts";

/** The UI store applying changes of direction: amendments, withdrawals, retracted rules, status notes. */
function loaded(): ColonyStore {
  const s = new ColonyStore("web");
  const snap = {
    colony: { id: "web", name: "web", trunk: { namespace: "n", name: "t", remote: "r" }, trunkSha: "a".repeat(40), createdAt: 0, regionDepth: 1 },
    files: [{ path: "src/a.ts", size: 10 }],
    intents: [
      { id: "int_1", colonyId: "web", title: "Greet", why: "hello", source: "human", footprint: ["src/a.ts"], priority: 1, status: "claimed", createdAt: 0, createdBy: "t", assignedTo: "agt_1" },
      { id: "int_2", colonyId: "web", title: "Old", why: "x", source: "rule", ruleId: "rul_1", footprint: ["src/a.ts"], priority: 1, status: "withdrawn", createdAt: 0, createdBy: "t", revision: 3, withdrawnReason: "gone" },
    ],
    rules: [{ id: "rul_1", colonyId: "web", kind: "forbid-pattern", spec: {}, description: "No console", approvedBy: "t", createdAt: 0 }],
    agents: [{ id: "agt_1", colonyId: "web", kind: "internal", name: "a1", thresholds: {}, state: "working", intentId: "int_1", lastSeen: 0, note: "writing src/a.ts", noteAt: 5 }],
    recentLandings: [],
    violations: { total: 0, byRule: {} },
    funnel: { reflex: 0, llm: 0, human: 0 },
    metrics: {},
  } as unknown as ColonySnapshot;
  s.applySnapshot(snap);
  return s;
}

describe("changing direction in the UI store", () => {
  it("loads revisions, withdrawals and status notes from the snapshot", () => {
    const s = loaded();
    expect(s.intents.get("int_1")).toMatchObject({ revision: 1 });
    expect(s.intents.get("int_2")).toMatchObject({ revision: 3, status: "withdrawn", withdrawnReason: "gone" });
    expect(s.intentsByStatus).toMatchObject({ claimed: 1, withdrawn: 1 });
    expect(s.agents.get("agt_1")).toMatchObject({ note: "writing src/a.ts", noteAt: 5 });
  });

  it("applies amended, withdrawn, retracted and status events", () => {
    const s = loaded();
    s.applyEvents([
      { t: "amended", at: 10, intentId: "int_1", revision: 2, changed: ["why"], reason: "French", by: "matt", title: "Greet in French", returned: 1 },
      { t: "status", at: 11, agentId: "agt_1", intentId: "int_1", note: "restarting at r2" },
      { t: "directive", at: 12, directiveId: "dir_1", agentId: "agt_1", message: "short", by: "matt" },
      { t: "retracted", at: 13, ruleId: "rul_1", reason: "fine", by: "matt", withdrawn: 0 },
    ]);
    expect(s.intents.get("int_1")).toMatchObject({ revision: 2, title: "Greet in French" });
    expect(s.agents.get("agt_1")).toMatchObject({ note: "restarting at r2", noteAt: 11 });
    expect(s.rules.get("rul_1")).toMatchObject({ retractedAt: 13, retractedBy: "matt", retractReason: "fine" });
    s.applyEvents([{ t: "withdrawn", at: 14, intentId: "int_1", reason: "not needed", by: "matt", title: "Greet in French", returned: 0 }]);
    expect(s.intents.get("int_1")).toMatchObject({ status: "withdrawn", withdrawnReason: "not needed" });
    expect(s.intents.get("int_1")?.assignedTo).toBeUndefined();
    expect(s.intentsByStatus).toMatchObject({ claimed: 0, withdrawn: 2 });
    expect(s.typeCounts.get("directive")).toBe(1);
    expect(s.recentEvents((e) => e.t === "amended", 5)).toHaveLength(1);
  });
});
