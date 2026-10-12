import { describe, expect, it } from "vitest";
import type { ColonySnapshot } from "@fire_trident/core";
import { ColonyStore } from "../src/store.ts";

function snapshot(extra: Partial<ColonySnapshot> = {}): ColonySnapshot {
  return {
    colony: { id: "c", name: "c", trunk: { namespace: "n", name: "t", remote: "r" }, trunkSha: "a".repeat(40), createdAt: 0, regionDepth: 1 },
    files: [{ path: "src/a.ts", size: 10 }],
    intents: [],
    rules: [{ id: "r1", colonyId: "c", kind: "forbid-pattern", spec: {}, description: "No console", approvedBy: "m", createdAt: 1_000 }],
    agents: [],
    recentLandings: [],
    violations: { total: 0, byRule: { r1: 0 } },
    funnel: { proof: 282, reflex: 0, llm: 2, human: 0 },
    metrics: {},
    ...extra,
  };
}

describe("the hero counter", () => {
  it("shows a converged colony's stat from the server's baseline, not the per-minute window", () => {
    const s = new ColonyStore("c");
    s.applySnapshot(
      snapshot({
        convergence: { since: 1_000, initial: 958, fixed: 958, convergedAt: 62_900 },
        series: { bucketMs: 60_000, start: 0, landings: [], violations: [223, 0], proposals: [], returned: [], landedIntents: [] },
      }),
    );
    expect(s.violationsFixed()).toBe(958);
    expect(s.convergedIn()).toEqual({ fixed: 958, ms: 61_900 });
  });

  it("restarts at a new rule, keeps counting fixes, and never counts a retraction as fixed", () => {
    const s = new ColonyStore("c");
    s.applySnapshot(snapshot({ convergence: { since: 1_000, initial: 958, fixed: 958, convergedAt: 62_900 } }));
    s.applyEvents([{ t: "violations", at: 100_000, total: 40, byRule: { r1: 0, r2: 40 } }]);
    expect(s.violationsFixed()).toBe(0);
    expect(s.convergedIn()).toBeNull();
    s.applyEvents([{ t: "violations", at: 101_000, total: 31, byRule: { r1: 0, r2: 31 } }]);
    expect(s.violationsFixed()).toBe(9);
    s.applyEvents([
      { t: "retracted", at: 102_000, ruleId: "r2", reason: "wrong", by: "m", withdrawn: 20 },
      { t: "violations", at: 102_000, total: 0, byRule: { r1: 0, r2: 0 } },
    ]);
    expect(s.violationsFixed()).toBe(0);
    expect(s.convergedIn()).toBeNull();
    expect(s.direction.retracted).toBe(1);
  });

  it("converges live when the last violation is fixed", () => {
    const s = new ColonyStore("c");
    s.applySnapshot(snapshot({ violations: { total: 0, byRule: {} } }));
    s.applyEvents([{ t: "violations", at: 10_000, total: 5, byRule: { r1: 5 } }]);
    s.applyEvents([{ t: "violations", at: 12_000, total: 2, byRule: { r1: 2 } }]);
    s.applyEvents([{ t: "violations", at: 15_500, total: 0, byRule: { r1: 0 } }]);
    expect(s.convergedIn()).toEqual({ fixed: 5, ms: 5_500 });
  });
});

describe("the funnel", () => {
  it("counts settled proposals per stage when the server reports them", () => {
    const s = new ColonyStore("c");
    s.applySnapshot(snapshot());
    expect(s.settledFunnel).toBe(true);
    expect(s.funnel).toEqual({ proof: 282, reflex: 0, llm: 2, human: 0 });
    // A proposal the reflex sent on to the LLM takes two decisions but settles once, at the LLM.
    s.applyEvents([
      { t: "decision", at: 1, decisionId: "d1", kind: "triage", layer: "reflex", p: 0.6, action: "consult", subject: "p1" },
      { t: "decision", at: 2, decisionId: "d2", kind: "triage", layer: "llm", p: 0.9, action: "land", subject: "p1" },
      { t: "metric", at: 3, name: "funnel.llm", value: 3 },
    ]);
    expect(s.funnel).toEqual({ proof: 282, reflex: 0, llm: 3, human: 0 });
    expect(s.decisions.get("p1")).toHaveLength(2);
  });

  it("counts decisions per layer for servers without the proof stage (and the simulator)", () => {
    const s = new ColonyStore("c");
    s.applySnapshot(snapshot({ funnel: { reflex: 4, llm: 1, human: 0 } }));
    expect(s.settledFunnel).toBe(false);
    s.applyEvents([{ t: "decision", at: 1, decisionId: "d1", kind: "triage", layer: "reflex", p: 0.9, action: "land", subject: "p1" }]);
    expect(s.funnel).toEqual({ proof: 0, reflex: 5, llm: 1, human: 0 });
  });
});

describe("direction and outside agents", () => {
  it("counts amendments, withdrawals and directives, and remembers outside agents' landings", () => {
    const s = new ColonyStore("c");
    s.applySnapshot(
      snapshot({
        intents: [{ id: "i1", colonyId: "c", title: "x", why: "", source: "human", footprint: ["src/a.ts"], priority: 1, status: "claimed", createdAt: 0, createdBy: "m", revision: 2 }],
      }),
    );
    expect(s.direction).toEqual({ amended: 1, withdrawn: 0, retracted: 0, directives: 0 });
    s.applyEvents([
      { t: "directive", at: 1, directiveId: "d", agentId: "a1", message: "short", by: "m" },
      { t: "agent", at: 2, agentId: "x1", kind: "external", state: "working", intentId: "i1" },
      { t: "proposal", at: 3, proposalId: "p1", intentId: "i1", agentId: "x1", status: "ready" },
      { t: "landing", at: 4, landingId: "l1", trunkSha: "b".repeat(40), proposalIds: ["p1"], paths: ["src/a.ts"] },
      { t: "agent", at: 5, agentId: "x1", kind: "external", state: "dead" },
    ]);
    expect(s.direction.directives).toBe(1);
    expect(s.outside).toEqual([{ agentId: "x1", landingId: "l1", paths: ["src/a.ts"], at: 4 }]);
    expect(s.agentKinds.get("x1")).toBe("external");
  });
});
