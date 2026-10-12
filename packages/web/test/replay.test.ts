import { describe, expect, it } from "vitest";
import type { ColonyEvent, ColonySnapshot, RecordedEvent } from "@fire_trident/core";
import { FieldSynth, ReplayEngine, Timeline, startingPoint } from "../src/replay.ts";
import { ColonyStore } from "../src/store.ts";

const T = 1_791_797_000_000;
const sha = (c: string) => c.repeat(40);

/** A finished run as the record holds it: a rule with 3 violations in two files, two agents, two landings. */
function record(): RecordedEvent[] {
  const events: ColonyEvent[] = [
    { t: "intent", at: T + 1_000, intentId: "i1", status: "open", title: "Fix a.ts", footprint: ["src/a.ts"] },
    { t: "intent", at: T + 1_000, intentId: "i2", status: "open", title: "Fix b.ts", footprint: ["src/b.ts"] },
    { t: "violations", at: T + 1_001, total: 3, byRule: { r1: 3 } },
    { t: "agent", at: T + 2_000, agentId: "a1", kind: "internal", state: "idle" },
    { t: "agent", at: T + 2_000, agentId: "a2", kind: "external", state: "idle" },
    { t: "intent", at: T + 2_500, intentId: "i1", status: "claimed", title: "Fix a.ts", footprint: ["src/a.ts"] },
    { t: "agent", at: T + 2_500, agentId: "a1", kind: "internal", state: "working", intentId: "i1", paths: ["src/a.ts"] },
    { t: "intent", at: T + 2_600, intentId: "i2", status: "claimed", title: "Fix b.ts", footprint: ["src/b.ts"] },
    { t: "agent", at: T + 2_600, agentId: "a2", kind: "external", state: "working", intentId: "i2", paths: ["src/b.ts"] },
    { t: "proposal", at: T + 4_000, proposalId: "p1", intentId: "i1", agentId: "a1", status: "checking" },
    { t: "proposal", at: T + 4_200, proposalId: "p1", intentId: "i1", agentId: "a1", status: "ready" },
    { t: "metric", at: T + 4_400, name: "funnel.proof", value: 1 },
    { t: "proposal", at: T + 5_000, proposalId: "p1", intentId: "i1", agentId: "a1", status: "landed" },
    { t: "agent", at: T + 5_000, agentId: "a1", kind: "internal", state: "idle" },
    { t: "intent", at: T + 5_000, intentId: "i1", status: "landed", title: "Fix a.ts", footprint: ["src/a.ts"] },
    { t: "violations", at: T + 5_000, total: 1, byRule: { r1: 1 } },
    { t: "landing", at: T + 5_000, landingId: "l1", trunkSha: sha("1"), proposalIds: ["p1"], paths: ["src/a.ts"] },
    { t: "proposal", at: T + 6_000, proposalId: "p2", intentId: "i2", agentId: "a2", status: "ready" },
    { t: "proposal", at: T + 6_500, proposalId: "p2", intentId: "i2", agentId: "a2", status: "returned", reason: "stale read: src/b.ts" },
    { t: "intent", at: T + 6_500, intentId: "i2", status: "open", title: "Fix b.ts", footprint: ["src/b.ts"] },
    { t: "intent", at: T + 7_000, intentId: "i2", status: "claimed", title: "Fix b.ts", footprint: ["src/b.ts"] },
    { t: "proposal", at: T + 8_000, proposalId: "p3", intentId: "i2", agentId: "a2", status: "ready" },
    { t: "metric", at: T + 8_100, name: "funnel.llm", value: 1 },
    { t: "proposal", at: T + 9_000, proposalId: "p3", intentId: "i2", agentId: "a2", status: "landed" },
    { t: "intent", at: T + 9_000, intentId: "i2", status: "landed", title: "Fix b.ts", footprint: ["src/b.ts"] },
    { t: "violations", at: T + 9_000, total: 0, byRule: { r1: 0 } },
    { t: "landing", at: T + 9_000, landingId: "l2", trunkSha: sha("2"), proposalIds: ["p3"], paths: ["src/b.ts", "src/new.ts"] },
    { t: "sigma", at: T + 9_100, region: "src", sigma: 1.4 },
    { t: "agent", at: T + 10_000, agentId: "a1", kind: "internal", state: "dead" },
    { t: "agent", at: T + 10_000, agentId: "a2", kind: "external", state: "dead" },
  ];
  return events.map((e, i) => ({ ...e, seq: i + 1 }));
}

function finished(source?: { url: string; branch: string }): ColonySnapshot {
  return {
    colony: { id: "c", name: "c", trunk: { namespace: "n", name: "t", remote: "r" }, trunkSha: sha("2"), createdAt: T, regionDepth: 1, ...(source ? { source } : {}) },
    files: [
      { path: "src/a.ts", size: 100 },
      { path: "src/b.ts", size: 200 },
      { path: "src/new.ts", size: 300 },
      { path: "README.md", size: 50 },
    ],
    intents: [],
    rules: [{ id: "r1", colonyId: "c", kind: "forbid-pattern", spec: {}, description: "No console", approvedBy: "m", createdAt: T + 1_000 }],
    agents: [],
    recentLandings: [],
    violations: { total: 0, byRule: { r1: 0 } },
    funnel: { proof: 1, reflex: 0, llm: 1, human: 0 },
    metrics: {},
  };
}

function engine(source?: { url: string; branch: string }) {
  const store = new ColonyStore("c");
  const timeline = new Timeline(record());
  const { snapshot, newFiles } = startingPoint(finished(source), timeline);
  const e = new ReplayEngine(store, timeline, snapshot, newFiles, new FieldSynth());
  e.begin();
  return { store, e, timeline };
}

describe("the field a replay derives", () => {
  it("needs on open intents, claims while claimed, failures on returns, nothing once landed", () => {
    const f = new FieldSynth((id) => (id === "i9" ? 2 : 1));
    const value = (marks: ColonyEvent[], kind: string, path: string) => (marks.find((m) => m.t === "mark" && m.kind === kind && m.path === path) as { value: number } | undefined)?.value;
    let m = f.derive({ t: "intent", at: 1, intentId: "i1", status: "open", title: "x", footprint: ["a", "b"] });
    expect(value(m, "need", "a")).toBe(1);
    expect(value(m, "claim", "a")).toBe(0);
    m = f.derive({ t: "intent", at: 2, intentId: "i9", status: "open", title: "y", footprint: ["a"] });
    expect(value(m, "need", "a")).toBe(3);
    m = f.derive({ t: "intent", at: 3, intentId: "i1", status: "claimed", title: "x", footprint: ["a", "b"] });
    expect(value(m, "claim", "b")).toBe(1);
    expect(value(m, "need", "b")).toBe(1);
    m = f.derive({ t: "proposal", at: 4, proposalId: "p", intentId: "i1", agentId: "x", status: "returned", reason: "stale read" });
    expect(value(m, "failure", "a")).toBe(0.5);
    expect(f.derive({ t: "proposal", at: 5, proposalId: "p", intentId: "i1", agentId: "x", status: "returned", reason: "withdrawn: not needed" })).toEqual([]);
    m = f.derive({ t: "intent", at: 6, intentId: "i1", status: "landed", title: "x", footprint: ["a", "b"] });
    expect(value(m, "need", "a")).toBe(2);
    expect(value(m, "need", "b")).toBe(0);
    expect(value(m, "claim", "a")).toBe(0);
    // An amended footprint leaves its old files.
    m = f.derive({ t: "intent", at: 7, intentId: "i9", status: "open", title: "y", footprint: ["c"] });
    expect(value(m, "need", "a")).toBe(0);
    expect(value(m, "need", "c")).toBe(2);
  });
});

describe("the timeline", () => {
  it("keeps record order and makes times monotone", () => {
    const tl = new Timeline([
      { t: "metric", at: 30, name: "x", value: 1, seq: 3 },
      { t: "metric", at: 10, name: "x", value: 1, seq: 1 },
      { t: "sigma", at: 5, region: "src", sigma: 1, seq: 2 },
    ]);
    expect(tl.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect([...tl.times]).toEqual([10, 10, 30]);
    expect(tl.upTo(9)).toBe(0);
    expect(tl.upTo(10)).toBe(2);
    expect(tl.upTo(100)).toBe(3);
  });

  it("starts a new project with only the files its run did not create", () => {
    const tl = new Timeline(record());
    const fromSpec = startingPoint(finished(), tl);
    expect(fromSpec.snapshot.files.map((f) => f.path)).toEqual(["README.md"]);
    expect([...fromSpec.newFiles.keys()].sort()).toEqual(["src/a.ts", "src/b.ts", "src/new.ts"]);
    const imported = startingPoint(finished({ url: "https://example.com/r.git", branch: "main" }), tl);
    expect(imported.snapshot.files).toHaveLength(4);
    expect(imported.newFiles.size).toBe(0);
    expect(imported.snapshot).toMatchObject({ intents: [], agents: [], violations: { total: 0 }, colony: { trunkSha: "" } });
  });
});

describe("replaying a run through the store", () => {
  it("moves the counters, funnel, trunk and field as the run did, on the run's clock", () => {
    const { store, e, timeline } = engine({ url: "https://example.com/r.git", branch: "main" });
    expect(store.now()).toBe(timeline.first - 1_500);
    expect(store.violations.total).toBe(0);

    e.advanceTo(T + 3_000);
    expect(store.now()).toBe(T + 3_000);
    expect(store.violations.total).toBe(3);
    expect(store.agentsActive()).toBe(2);
    expect(store.agentsWorking()).toBe(2);
    // Claims decay on the run's clock: half a second after the claim.
    expect(store.fieldValues("src/a.ts").need).toBe(1);
    expect(store.fieldValues("src/a.ts").claim).toBeCloseTo(Math.exp(-500 / 300_000), 6);
    expect(store.trunkSha).toBe("");

    e.advanceTo(T + 5_500);
    expect(store.violations.total).toBe(1);
    expect(store.violationsFixed()).toBe(2);
    expect(store.funnel).toEqual({ proof: 1, reflex: 0, llm: 0, human: 0 });
    expect(store.settledFunnel).toBe(true);
    expect(store.trunkSha).toBe(sha("1"));
    expect(store.landingsTotal()).toBe(1);
    expect(store.landingsPerMin()).toBeCloseTo(60_000 / 15_000);
    expect(store.fieldValues("src/a.ts")).toMatchObject({ need: 0, claim: 0 });
    expect(store.fieldValues("src/a.ts").trail).toBeGreaterThan(0.9);
    expect(store.landingFx).toHaveLength(1);

    e.advanceTo(T + 6_700);
    expect(store.fieldValues("src/b.ts").failure).toBeCloseTo(0.5, 3);
    expect(store.convergedIn()).toBeNull();

    e.advanceTo(e.end);
    expect(store.violations.total).toBe(0);
    expect(store.convergedIn()).toEqual({ fixed: 3, ms: 8_000 - 1 });
    expect(store.funnel).toEqual({ proof: 1, reflex: 0, llm: 1, human: 0 });
    expect(store.sigmaMax().value).toBe(1.4);
    expect(store.agentsActive()).toBe(0);
    expect(store.landingsTotal()).toBe(2);
    expect(store.outside).toEqual([{ agentId: "a2", landingId: "l2", paths: ["src/b.ts", "src/new.ts"], at: T + 9_000 }]);
    expect(store.recentEvents((x) => x.t === "landing", 10)).toHaveLength(2);
  });

  it("seeks back by starting over, and lands at the same state", () => {
    const { store, e } = engine({ url: "https://example.com/r.git", branch: "main" });
    e.advanceTo(T + 9_500);
    const at = { v: store.violations.total, f: { ...store.funnel }, sha: store.trunkSha, landings: store.landings.length };
    const gen = store.fxGen;
    e.seek(T + 3_000);
    expect(store.fxGen).toBeGreaterThan(gen);
    expect(store.violations.total).toBe(3);
    expect(store.trunkSha).toBe("");
    expect(store.landings).toHaveLength(0);
    expect(store.landingFx).toHaveLength(0);
    e.seek(T + 9_500);
    expect({ v: store.violations.total, f: store.funnel, sha: store.trunkSha, landings: store.landings.length }).toEqual(at);
    // A long jump forward is a seek: state, no animations.
    expect(store.landingFx).toHaveLength(0);
    expect(store.landings.every((l) => l.quiet)).toBe(true);
  });

  it("adds a new project's files as they land", () => {
    const { store, e } = engine();
    expect(store.files.map((f) => f.path)).toEqual(["README.md"]);
    e.advanceTo(T + 5_000);
    expect(store.files.map((f) => f.path).sort()).toEqual(["README.md", "src/a.ts"]);
    expect(store.files.find((f) => f.path === "src/a.ts")?.size).toBe(100);
    e.advanceTo(T + 9_000);
    expect(store.files.map((f) => f.path).sort()).toEqual(["README.md", "src/a.ts", "src/b.ts", "src/new.ts"]);
  });

  it("skips long idle stretches down to a moment", () => {
    const events: RecordedEvent[] = [
      { t: "intent", at: T, intentId: "i1", status: "open", title: "x", footprint: ["a"], seq: 1 },
      { t: "intent", at: T + 3 * 60 * 60_000, intentId: "i1", status: "landed", title: "x", footprint: ["a"], seq: 2 },
    ];
    const store = new ColonyStore("c");
    const tl = new Timeline(events);
    const { snapshot, newFiles } = startingPoint(finished(), tl);
    const e = new ReplayEngine(store, tl, snapshot, newFiles, new FieldSynth());
    e.begin();
    e.advanceTo(T + 100);
    expect(e.stepTarget(16)).toBe(T + 3 * 60 * 60_000 - 2_000);
    expect(e.stepTarget(10_000_000_000)).toBe(e.end);
  });
});
