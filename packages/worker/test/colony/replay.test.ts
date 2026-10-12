import { describe, expect, it } from "vitest";
import type { ColonyEvent } from "@fire_trident/core";
import { reconstruct, settledStage, type ReconInput } from "../../src/colony/replay.ts";

/** A small run: one rule (3 violations in two files), two agents, one human intent, one return, one withdrawal. */
function run(): ReconInput {
  return {
    rules: [{ id: "r1", createdAt: 1_000, retractedAt: null, retractedBy: null, retractReason: null }],
    intents: [
      { id: "i1", title: "Fix a.ts", footprint: ["src/a.ts"], status: "landed", ruleId: "r1", violations: 2, createdAt: 1_001, updatedAt: 9_000, withdrawnReason: null },
      { id: "i2", title: "Fix b.ts", footprint: ["src/b.ts"], status: "landed", ruleId: "r1", violations: 1, createdAt: 1_001, updatedAt: 12_000, withdrawnReason: null },
      { id: "i3", title: "Docs", footprint: ["docs/x.md"], status: "withdrawn", ruleId: null, violations: 0, createdAt: 1_500, updatedAt: 6_000, withdrawnReason: "not needed" },
    ],
    agents: [
      { id: "a1", kind: "internal", state: "dead", createdAt: 2_000, lastSeen: 13_000, stoppedAt: 14_000 },
      { id: "a2", kind: "external", state: "dead", createdAt: 2_500, lastSeen: 12_500, stoppedAt: null },
    ],
    proposals: [
      { id: "p1", intentId: "i1", agentId: "a1", status: "landed", createdAt: 5_000, updatedAt: 9_000, reason: null, landingId: "l1", paths: ["src/a.ts"] },
      { id: "p2", intentId: "i2", agentId: "a2", status: "returned", createdAt: 4_000, updatedAt: 7_000, reason: "stale read: src/b.ts", landingId: null, paths: ["src/b.ts"] },
      { id: "p3", intentId: "i2", agentId: "a2", status: "landed", createdAt: 10_000, updatedAt: 12_000, reason: null, landingId: "l2", paths: ["src/b.ts"] },
    ],
    decisions: [{ id: "d1", kind: "triage", subject: "p3", layer: "reflex", p: 0.6, action: "consult", at: 10_500 }],
    outcomes: [
      { proposalId: "p1", layer: "deterministic", action: "land", at: 5_500, human: null, humanAt: null },
      { proposalId: "p3", layer: "llm", action: "land", at: 11_000, human: null, humanAt: null },
    ],
    landings: [
      { id: "l1", at: 9_000, trunkSha: "1".repeat(40), proposalIds: ["p1"], intentIds: ["i1"], paths: ["src/a.ts"] },
      { id: "l2", at: 12_000, trunkSha: "2".repeat(40), proposalIds: ["p3"], intentIds: ["i2"], paths: ["src/b.ts"] },
    ],
    revisions: [{ intentId: "i3", revision: 2, at: 3_000, by: "matt", reason: "smaller", changed: ["why"], title: null }],
    directives: [{ id: "dir1", agentId: "a1", intentId: "i1", message: "keep it small", by: "matt", at: 4_500, via: "push" }],
    withdrawnBy: { i3: "matt" },
  };
}

const only = <T extends ColonyEvent["t"]>(events: ColonyEvent[], t: T) => events.filter((e): e is Extract<ColonyEvent, { t: T }> => e.t === t);

describe("reconstructed replay", () => {
  it("orders the run by time", () => {
    const events = reconstruct(run());
    for (let i = 1; i < events.length; i++) expect(events[i]!.at).toBeGreaterThanOrEqual(events[i - 1]!.at);
    expect(events[0]).toMatchObject({ t: "intent", intentId: "i1", status: "open" });
  });

  it("counts violations up when the rule arrives and down as its fixes land", () => {
    const v = only(reconstruct(run()), "violations");
    expect(v.map((e) => [e.at, e.total])).toEqual([
      [1_001, 3],
      [9_000, 1],
      [12_000, 0],
    ]);
    expect(v[0]?.byRule).toEqual({ r1: 3 });
  });

  it("shows each job: a claim before the proposal, the outcome, and the agent going idle", () => {
    const events = reconstruct(run());
    const a1 = events.filter((e) => (e.t === "agent" && e.agentId === "a1") || ((e.t === "intent" || e.t === "proposal") && e.intentId === "i1"));
    const seq = a1.map((e) => `${e.t}:${e.t === "agent" ? e.state : e.t === "intent" || e.t === "proposal" ? e.status : ""}`);
    expect(seq).toEqual([
      "intent:open",
      "agent:idle",
      "intent:claimed",
      "agent:working",
      "proposal:checking",
      "intent:proposed",
      "agent:proposing",
      "proposal:ready",
      "proposal:landed",
      "agent:idle",
      "intent:landed",
      "agent:dead",
    ]);
    const claim = events.find((e) => e.t === "agent" && e.agentId === "a1" && e.state === "working");
    expect(claim).toMatchObject({ at: 2_300, intentId: "i1", paths: ["src/a.ts"] });
    // The second job of a2 is claimed after its first one came back.
    const claims = events.filter((e) => e.t === "agent" && e.agentId === "a2" && e.state === "working").map((e) => e.at);
    expect(claims).toEqual([2_800, 7_300]);
    expect(events.find((e) => e.t === "proposal" && e.status === "returned")).toMatchObject({ reason: "stale read: src/b.ts", at: 7_000 });
    expect(events.find((e) => e.t === "agent" && e.agentId === "a2" && e.state === "dead")).toMatchObject({ kind: "external", at: 12_500 });
  });

  it("lands commits with their files", () => {
    const landings = only(reconstruct(run()), "landing");
    expect(landings.map((l) => [l.landingId, l.paths, l.proposalIds])).toEqual([
      ["l1", ["src/a.ts"], ["p1"]],
      ["l2", ["src/b.ts"], ["p3"]],
    ]);
  });

  it("moves the funnel once per proposal, at the stage that settled it", () => {
    const f = only(reconstruct(run()), "metric").filter((m) => m.name.startsWith("funnel."));
    expect(f.map((m) => [m.name, m.value])).toEqual([
      ["funnel.proof", 1],
      ["funnel.llm", 1],
    ]);
    const decisions = only(reconstruct(run()), "decision");
    expect(decisions).toEqual([{ t: "decision", at: 10_500, decisionId: "d1", kind: "triage", layer: "reflex", p: 0.6, action: "consult", subject: "p3" }]);
    expect(settledStage({ layer: "reflex", action: "escalate", human: null })).toBe("human");
    expect(settledStage({ layer: "deterministic", action: "return", human: null })).toBe("proof");
    expect(settledStage({ layer: "llm", action: "land", human: "approve" })).toBe("human");
  });

  it("keeps changes of direction", () => {
    const events = reconstruct(run());
    expect(only(events, "amended")).toEqual([{ t: "amended", at: 3_000, intentId: "i3", revision: 2, changed: ["why"], reason: "smaller", by: "matt", title: "Docs", returned: 0 }]);
    expect(only(events, "withdrawn")).toEqual([{ t: "withdrawn", at: 6_000, intentId: "i3", reason: "not needed", by: "matt", title: "Docs", returned: 0 }]);
    expect(only(events, "directive")).toEqual([{ t: "directive", at: 4_500, directiveId: "dir1", agentId: "a1", intentId: "i1", message: "keep it small", by: "matt", via: "push" }]);
  });

  it("retracting a rule takes its open violations away without counting them as fixed", () => {
    const input = run();
    input.rules[0]!.retractedAt = 10_000;
    input.rules[0]!.retractReason = "wrong rule";
    input.intents[1]!.status = "withdrawn";
    input.proposals = input.proposals.filter((p) => p.id !== "p3");
    input.landings = input.landings.filter((l) => l.id !== "l2");
    const events = reconstruct(input);
    expect(only(events, "violations").map((e) => e.total)).toEqual([3, 1, 0]);
    expect(only(events, "retracted")).toEqual([{ t: "retracted", at: 10_000, ruleId: "r1", reason: "wrong rule", by: "unknown", withdrawn: 1 }]);
  });

  it("rebuilds a landing the log no longer keeps from its proposal", () => {
    const input = run();
    input.landings = [];
    const landings = only(reconstruct(input), "landing");
    expect(landings.map((l) => [l.landingId, l.at, l.paths])).toEqual([
      ["l1", 9_000, ["src/a.ts"]],
      ["l2", 12_000, ["src/b.ts"]],
    ]);
  });
});
