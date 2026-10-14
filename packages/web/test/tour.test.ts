import { describe, expect, it } from "vitest";
import type { ColonyEvent, ColonySnapshot, RecordedEvent } from "@fire_trident/core";
import { FieldSynth, ReplayBackend, ReplayEngine, Timeline, findMoment, startingPoint } from "../src/replay.ts";
import { colonyHref, parseRoute } from "../src/route.ts";
import { ColonyStore } from "../src/store.ts";
import { checkTour, fillTour, loadTourSteps, planTour, tourNumbers, tourValues, travelSpeed, type TourPlan } from "../src/tour/tour.ts";
import raw from "../src/tour/tour.json";

const T = 1_791_797_000_000;
const RULE_AT = T + 1_000;
const sha = (c: string) => c.repeat(40);
const STALE = "stale: 1 path changed on trunk since read: src/a.ts (expected aaaaaaaaaa, trunk bbbbbbbbbb)";

/**
 * A run with a prerequisite landed before the rule (on a second model's approval), then a rule (declared at +1 s, its
 * 4 violations in 3 files published at +1.6 s), three agents, a first landing on a model's approval, a stale return
 * that names src/a.ts, a landing notice, and a last commit of two changes settled by the proof.
 */
function contended(): RecordedEvent[] {
  const fp = { i0: ["tsconfig.json"], i1: ["src/a.ts"], i2: ["src/b.ts"], i3: ["src/c.ts"] } as const;
  const intent = (at: number, id: keyof typeof fp, status: "open" | "claimed" | "proposed" | "landed"): ColonyEvent => ({ t: "intent", at: T + at, intentId: id, status, title: `Fix ${id}`, footprint: [...fp[id]] });
  const agent = (at: number, id: string, state: "idle" | "working" | "proposing" | "dead", intentId?: string): ColonyEvent => ({ t: "agent", at: T + at, agentId: id, kind: "internal", state, ...(intentId ? { intentId } : {}) });
  const prop = (at: number, id: string, intentId: string, agentId: string, status: "checking" | "ready" | "landed" | "returned", reason?: string): ColonyEvent => ({ t: "proposal", at: T + at, proposalId: id, intentId, agentId, status, ...(reason ? { reason } : {}) });
  const funnel = (at: number, stage: string, value: number): ColonyEvent => ({ t: "metric", at: T + at, name: `funnel.${stage}`, value });
  const events: ColonyEvent[] = [
    intent(0, "i0", "open"),
    agent(50, "a0", "idle"),
    intent(100, "i0", "claimed"),
    agent(100, "a0", "working", "i0"),
    prop(200, "p0", "i0", "a0", "checking"),
    { t: "decision", at: T + 300, decisionId: "d0", kind: "triage", layer: "llm", p: 0.9, action: "land", subject: "p0" },
    funnel(400, "llm", 1),
    prop(400, "p0", "i0", "a0", "ready"),
    prop(500, "p0", "i0", "a0", "landed"),
    intent(500, "i0", "landed"),
    agent(500, "a0", "idle"),
    { t: "landing", at: T + 500, landingId: "l0", trunkSha: sha("0"), proposalIds: ["p0"], paths: ["tsconfig.json"] },
    intent(1_500, "i1", "open"),
    intent(1_500, "i2", "open"),
    intent(1_500, "i3", "open"),
    { t: "violations", at: T + 1_600, total: 4, byRule: { r1: 4 } },
    agent(1_800, "a1", "idle"),
    agent(1_800, "a2", "idle"),
    agent(1_800, "a3", "idle"),
    intent(2_000, "i1", "claimed"),
    agent(2_000, "a1", "working", "i1"),
    intent(2_100, "i2", "claimed"),
    agent(2_100, "a2", "working", "i2"),
    intent(2_200, "i3", "claimed"),
    agent(2_200, "a3", "working", "i3"),
    prop(3_000, "p1", "i1", "a1", "checking"),
    agent(3_000, "a1", "proposing", "i1"),
    { t: "decision", at: T + 3_050, decisionId: "d1", kind: "triage", layer: "llm", p: 0.95, action: "land", subject: "p1" },
    funnel(3_100, "llm", 2),
    prop(3_100, "p1", "i1", "a1", "ready"),
    prop(3_500, "p2", "i2", "a2", "checking"),
    agent(3_500, "a2", "proposing", "i2"),
    funnel(3_800, "proof", 1),
    prop(3_800, "p2", "i2", "a2", "ready"),
    prop(4_000, "p1", "i1", "a1", "landed"),
    intent(4_000, "i1", "landed"),
    agent(4_000, "a1", "idle"),
    { t: "violations", at: T + 4_000, total: 3, byRule: { r1: 3 } },
    { t: "landing", at: T + 4_000, landingId: "l1", trunkSha: sha("1"), proposalIds: ["p1"], paths: ["src/a.ts"] },
    { t: "directive", at: T + 4_050, directiveId: "n1", agentId: "a2", intentId: "i2", message: "src/a.ts changed on trunk", by: "colony", kind: "landing", landingId: "l1", paths: ["src/a.ts"] },
    prop(5_050, "p4", "i3", "a3", "checking"),
    agent(5_050, "a3", "proposing", "i3"),
    funnel(5_150, "proof", 2),
    prop(5_150, "p4", "i3", "a3", "ready"),
    prop(5_200, "p2", "i2", "a2", "returned", STALE),
    intent(5_200, "i2", "open"),
    agent(5_200, "a2", "idle"),
    intent(5_300, "i2", "claimed"),
    agent(5_300, "a2", "working", "i2"),
    prop(5_400, "p3", "i2", "a2", "checking"),
    agent(5_400, "a2", "proposing", "i2"),
    funnel(5_500, "proof", 3),
    prop(5_500, "p3", "i2", "a2", "ready"),
    prop(6_000, "p3", "i2", "a2", "landed"),
    prop(6_000, "p4", "i3", "a3", "landed"),
    intent(6_000, "i2", "landed"),
    intent(6_000, "i3", "landed"),
    { t: "violations", at: T + 6_000, total: 0, byRule: { r1: 0 } },
    { t: "landing", at: T + 6_000, landingId: "l2", trunkSha: sha("2"), proposalIds: ["p3", "p4"], paths: ["src/b.ts", "src/c.ts"] },
    agent(7_000, "a1", "dead"),
    agent(7_000, "a2", "dead"),
    agent(7_000, "a3", "dead"),
  ];
  return events.map((e, i) => ({ ...e, seq: i + 1 }));
}

/** A run where nothing came back: three changes in flight at once, and src/a.ts changed by two landings. */
function calm(): RecordedEvent[] {
  const events: ColonyEvent[] = [
    { t: "intent", at: T + 100, intentId: "i1", status: "open", title: "a", footprint: ["src/a.ts"] },
    { t: "intent", at: T + 100, intentId: "i2", status: "open", title: "b", footprint: ["src/b.ts"] },
    { t: "intent", at: T + 100, intentId: "i3", status: "open", title: "c", footprint: ["src/c.ts"] },
    { t: "violations", at: T + 200, total: 3, byRule: { r1: 3 } },
    { t: "intent", at: T + 300, intentId: "i1", status: "claimed", title: "a", footprint: ["src/a.ts"] },
    { t: "proposal", at: T + 1_000, proposalId: "p1", intentId: "i1", agentId: "a1", status: "checking" },
    { t: "proposal", at: T + 1_100, proposalId: "p2", intentId: "i2", agentId: "a2", status: "checking" },
    { t: "proposal", at: T + 1_200, proposalId: "p3", intentId: "i3", agentId: "a3", status: "ready" },
    { t: "proposal", at: T + 1_300, proposalId: "p1", intentId: "i1", agentId: "a1", status: "ready" },
    { t: "proposal", at: T + 2_000, proposalId: "p1", intentId: "i1", agentId: "a1", status: "landed" },
    { t: "landing", at: T + 2_000, landingId: "l1", trunkSha: sha("1"), proposalIds: ["p1"], paths: ["src/a.ts"] },
    { t: "proposal", at: T + 2_500, proposalId: "p2", intentId: "i2", agentId: "a2", status: "landed" },
    { t: "landing", at: T + 2_500, landingId: "l2", trunkSha: sha("2"), proposalIds: ["p2"], paths: ["src/a.ts", "src/b.ts"] },
    { t: "proposal", at: T + 3_000, proposalId: "p3", intentId: "i3", agentId: "a3", status: "landed" },
    { t: "landing", at: T + 3_000, landingId: "l3", trunkSha: sha("3"), proposalIds: ["p3"], paths: ["src/c.ts"] },
  ];
  return events.map((e, i) => ({ ...e, seq: i + 1 }));
}

function snapshot(): ColonySnapshot {
  return {
    colony: { id: "c", name: "c", trunk: { namespace: "n", name: "t", remote: "r" }, trunkSha: sha("2"), createdAt: T, regionDepth: 1, source: { url: "https://example.com/r.git", branch: "main" } },
    files: ["tsconfig.json", "src/a.ts", "src/b.ts", "src/c.ts", "README.md"].map((path) => ({ path, size: 100 })),
    intents: [],
    rules: [{ id: "r1", colonyId: "c", kind: "forbid-pattern", spec: {}, description: "No console", approvedBy: "m", createdAt: RULE_AT }],
    agents: [],
    recentLandings: [],
    violations: { total: 0, byRule: { r1: 0 } },
    funnel: { proof: 3, reflex: 0, llm: 2, human: 0 },
    metrics: {},
  };
}

/** The real tour script planned on `events`, and a replay engine to stand at each stop, as the Tour component does. */
function touring(events: RecordedEvent[] = contended(), source: "recorded" | "reconstructed" = "recorded") {
  const store = new ColonyStore("c");
  const timeline = new Timeline(events);
  const { snapshot: initial, newFiles } = startingPoint(snapshot(), timeline);
  const engine = new ReplayEngine(store, timeline, initial, newFiles, new FieldSynth());
  engine.begin();
  const plan = planTour(loadTourSteps(raw), timeline, { rules: [...store.rules.values()], known: new Set(store.files.map((f) => f.path)), source });
  /** Seek to stop `i` and fill its sentence, as the tour shows it. */
  const say = (i: number): string => {
    const stop = plan.stops[i];
    if (!stop) throw new Error(`no stop ${i}`);
    engine.seek(stop.at);
    return fillTour(stop.caption, tourValues(stop, store, plan));
  };
  return { store, timeline, engine, plan, say };
}

const ids = (plan: TourPlan) => plan.stops.map((s) => s.step.id);

describe("moments of a run", () => {
  it("finds each moment in the record, counting from the rule's declaration", () => {
    const tl = new Timeline(contended());
    const at = (name: string) => findMoment(tl, name, { since: RULE_AT });
    expect(findMoment(tl, "@rule")).toMatchObject({ at: T + 1_600, count: 4 });
    // The prerequisite's claim and landing came before the rule.
    expect(at("@first-claim")).toMatchObject({ at: T + 2_000, paths: ["src/a.ts"] });
    expect(findMoment(tl, "@first-claim")?.at).toBe(T + 100);
    expect(at("@first-landing")).toMatchObject({ at: T + 4_000, proposalIds: ["p1"], paths: ["src/a.ts"] });
    // p1 had a model's decision, so the first landing on the proof alone is the last commit.
    expect(at("@first-proof")).toMatchObject({ at: T + 6_000, proposalIds: ["p3", "p4"] });
    expect(at("@first-stale")).toMatchObject({ at: T + 5_200, paths: ["src/a.ts"], proposalIds: ["p2"], reason: STALE });
    expect(at("@first-return")?.at).toBe(T + 5_200);
    expect(at("@first-notice")).toMatchObject({ at: T + 4_050, count: 1, agents: 1, paths: ["src/a.ts"] });
    expect(at("@calm")).toBeNull();
    expect(at("@hot")).toMatchObject({ at: T + 5_200, paths: ["src/a.ts"], count: 1, agents: 1 });
    expect(at("@busiest")).toBeNull();
    expect(at("@batch")).toMatchObject({ at: T + 6_000, count: 2, paths: ["src/b.ts", "src/c.ts"] });
    expect(at("@converged")?.at).toBe(T + 6_000);
    expect(at("@last-landing")?.proposalIds).toEqual(["p3", "p4"]);
    expect(at("@end")?.at).toBe(T + 7_000);
    expect(findMoment(tl, "@nonsense")).toBeNull();
  });

  it("leaves out changes of direction, and tells a calm run by its busiest moment and file", () => {
    const withdrawn: RecordedEvent[] = calm().map((e) => e);
    withdrawn.push({ t: "proposal", at: T + 3_500, proposalId: "p9", intentId: "i3", agentId: "a3", status: "returned", reason: "withdrawn: not needed", seq: 99 });
    const tl = new Timeline(withdrawn);
    expect(findMoment(tl, "@first-return")).toBeNull();
    expect(findMoment(tl, "@first-stale")).toBeNull();
    expect(findMoment(tl, "@calm")).toMatchObject({ at: T + 1_200, count: 3 });
    expect(findMoment(tl, "@hot")).toBeNull();
    // Two agents' changes landed on src/a.ts, though only one intent's footprint holds it.
    expect(findMoment(tl, "@busiest")).toMatchObject({ at: T + 2_500, paths: ["src/a.ts"], count: 2, agents: 2 });
    expect(findMoment(tl, "@batch")).toBeNull();
    expect(findMoment(tl, "@first-proof")).toBeNull();
  });
});

describe("the tour's steps", () => {
  it("loads the script: seven steps, each with a known moment and a caption for it", () => {
    const steps = loadTourSteps(raw);
    expect(steps.map((s) => s.id)).toEqual(["rule", "claims", "land", "contention", "hot", "converge", "why"]);
    for (const s of steps) for (const m of s.at) expect(s.caption[m] ?? s.caption["*"], `${s.id} ${m}`).toBeTruthy();
    expect(loadTourSteps({ steps: [{ id: "x", at: "@nowhere", caption: "x" }, { at: "@end" }, null] })).toEqual([]);
  });

  it("follows the run: by moment, ties in script order, steps the record lacks left out", () => {
    const tl = new Timeline(contended());
    const steps = loadTourSteps({
      steps: [
        { id: "late", at: "@converged", caption: "c" },
        { id: "early", at: "@first-claim", caption: "a" },
        { id: "missing", at: "@calm", caption: "never" },
        { id: "tie-1", at: "@first-stale", caption: "s" },
        { id: "tie-2", at: ["@busiest", "@hot"], caption: { "@hot": "h", "@busiest": "b" } },
        { id: "offset", at: "@first-claim", offset: 30, caption: "o" },
        { id: "after", at: "@last-landing", offset: 30, caption: "e" },
      ],
    });
    const plan = planTour(steps, tl, { rules: snapshot().rules });
    expect(ids(plan)).toEqual(["early", "offset", "tie-1", "tie-2", "late", "after"]);
    expect(plan.stops.find((s) => s.step.id === "tie-2")?.caption).toBe("h");
    // An offset never carries a step past the next one's moment, nor past the end of the run.
    expect(plan.stops.map((s) => s.at - T)).toEqual([2_000, 5_200, 5_200, 5_200, 6_000, 7_000]);
    expect(plan.ruleAt).toBe(RULE_AT);
    expect(plan.rules).toBe(1);
  });

  it("measures from the violations when the colony lists no rule", () => {
    const plan = planTour(loadTourSteps(raw), new Timeline(contended()));
    expect(plan.ruleAt).toBe(T + 1_600);
    expect(planTour(loadTourSteps(raw), new Timeline(contended().filter((e) => e.t !== "violations"))).ruleAt).toBeNull();
  });

  it("tells each moment in one sentence filled from the record there", () => {
    const { plan, say } = touring();
    expect(ids(plan)).toEqual(["rule", "claims", "contention", "hot", "land", "converge", "why"]);
    const lines = plan.stops.map((_, i) => say(i));
    expect(lines).toEqual([
      "A person declared one rule that found 4 violations in 3 files: each became a need in the field, and no one assigns the work.",
      "2 agents were at work 4.0 s after the rule, each on an intent it chose from the field, and each claim keeps the other agents off its files.",
      "The first change came back 4.2 s after the rule, because src/a.ts had changed on trunk after its agent read it: it goes back to be redone rather than land stale.",
      "src/a.ts was the hottest file: 1 return named it, and 1 agent worked on intents that cover it.",
      "The first change settled by a deterministic proof landed 5.0 s after the rule, in src/b.ts: no model was consulted.",
      "4 violations fixed in 5.0 s: 3 intents landed in 2 commits after the rule, and a deterministic proof settled 3 of the 4 changes reviewed (75.0%), with no model consulted.",
      "src/b.ts remembers why it changed: its intent, agent, model and checks ride with the commit as a git note, which any git clone can read.",
    ]);
    for (const line of lines) expect(line).not.toMatch(/\{\w+\}/);
    const why = plan.stops.at(-1);
    expect(why && (why.step.commands ?? []).map((l) => fillTour(l, { ...tourValues(why, touring().store, plan), server: "https://x", repo: "https://r" }))).toContain("npx fire_trident why c src/b.ts");
  });

  it("tells a run where nothing came back by its busiest moment and file, and skips a convergence it never reached", () => {
    const { plan, say } = touring(calm());
    expect(ids(plan)).toEqual(["rule", "claims", "contention", "land", "hot", "why"]);
    expect(plan.stops.map((_, i) => say(i)).slice(2)).toEqual([
      "At the busiest moment, 1.0 s after the rule, 3 changes were in flight at once, and in the whole run not one change came back to its agent.",
      "The first change landed 1.8 s after the rule, in src/a.ts, settled by its innate checks, with review off.",
      "src/a.ts changed most often: 2 commits landed on it, from 2 agents.",
      "src/c.ts remembers why it changed: its intent, agent, model and checks ride with the commit as a git note, which any git clone can read.",
    ]);
  });

  it("says what settled the first landing when the proof did not", () => {
    const events = contended().filter((e) => !(e.t === "metric" && e.name === "funnel.proof"));
    const { plan, say } = touring(events);
    const i = plan.stops.findIndex((s) => s.step.id === "land");
    expect(plan.stops[i]?.moment.name).toBe("@first-landing");
    expect(say(i)).toBe("The first change landed 3.0 s after the rule, in src/a.ts, settled by a second model's approval.");
  });

  it("opens the Why tab on a line of a file the run landed on, else on the last landing's file", () => {
    const events = contended();
    const store = new ColonyStore("c");
    const timeline = new Timeline(events);
    const snap = snapshot();
    snap.files.push({ path: "src/index.ts", size: 10 });
    const { snapshot: initial, newFiles } = startingPoint(snap, timeline);
    const engine = new ReplayEngine(store, timeline, initial, newFiles, new FieldSynth());
    engine.begin();
    const plan = planTour(loadTourSteps(raw), timeline, { rules: snap.rules, known: new Set(store.files.map((f) => f.path)) });
    const why = plan.stops.at(-1)!;
    engine.seek(why.at);
    // src/index.ts is a file of the colony, but the run never landed on it.
    expect(tourValues(why, store, plan)).toMatchObject({ selWhere: "src/b.ts", selArg: "src/b.ts" });
    events.push({ t: "landing", at: T + 6_500, landingId: "l3", trunkSha: sha("3"), proposalIds: ["p9"], paths: ["src/index.ts"], seq: 200 });
    const t2 = new Timeline(events);
    const plan2 = planTour(loadTourSteps(raw), t2, { rules: snap.rules });
    expect(tourValues(plan2.stops.at(-1)!, store, plan2)).toMatchObject({ selWhere: "Line 17 of src/index.ts", selArg: "src/index.ts:17" });
  });
});

describe("checking the tour's numbers against the metrics endpoint", () => {
  const report = {
    metrics: { landings: 3, landedIntents: 4 },
    funnel: { proof: 3, reflex: 0, llm: 2, human: 0 },
    violations: { total: 0 },
    convergence: { since: RULE_AT, initial: 4, fixed: 4, convergedAt: T + 6_120 },
  };

  it("agrees when the record and the endpoint tell the same run", () => {
    const { plan, engine, store } = touring();
    const at = (id: string) => {
      const stop = plan.stops.find((s) => s.step.id === id)!;
      engine.seek(stop.at);
      return tourNumbers(stop, store, plan);
    };
    const rule = at("rule");
    const converged = at("converge");
    engine.seek(engine.end);
    const checks = checkTour(plan, rule, converged, store, report);
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    expect(checks.map((c) => c.name)).toEqual([
      "violations the rule found",
      "violations fixed",
      "time to zero",
      "violations at the end",
      "funnel proof at the end",
      "funnel reflex at the end",
      "funnel llm at the end",
      "funnel human at the end",
      "landings at the end",
      "intents landed at the end",
    ]);
    expect(checks.find((c) => c.name === "time to zero")).toMatchObject({ tour: "5.0 s", metrics: "5.1 s", note: "-120 ms apart" });
  });

  it("flags a number that differs, and does not compare against a later rule change", () => {
    const { plan, engine, store } = touring();
    engine.seek(engine.end);
    const off = checkTour(plan, null, null, store, { ...report, funnel: { ...report.funnel, proof: 2 } });
    expect(off.filter((c) => !c.ok).map((c) => c.name)).toEqual(["funnel proof at the end"]);
    const stop = plan.stops.find((s) => s.step.id === "converge")!;
    const later = checkTour(plan, null, tourNumbers(stop, store, plan), store, { ...report, convergence: { ...report.convergence, since: T + 50_000 } });
    expect(later.find((c) => c.name === "time to zero")).toMatchObject({ ok: true, metrics: "not comparable" });
  });
});

describe("travelling between moments", () => {
  it("picks the slowest speed that crosses a gap in a few seconds, and jumps across a long one", () => {
    expect(travelSpeed(3_000)).toBe(1);
    expect(travelSpeed(10_000)).toBe(2);
    expect(travelSpeed(40_000)).toBe(8);
    expect(travelSpeed(500_000)).toBeNull();
  });

  it("plays the replay to a time, stops exactly there, and a seek cancels it", () => {
    const store = new ColonyStore("c");
    const timeline = new Timeline(contended());
    const { snapshot: initial, newFiles } = startingPoint(snapshot(), timeline);
    const engine = new ReplayEngine(store, timeline, initial, newFiles, new FieldSynth());
    engine.begin();
    const backend = new ReplayBackend("c");
    const inner = backend as unknown as { engine: ReplayEngine; tick(wall: number): void };
    inner.engine = engine;
    backend.state = { ...backend.state, ready: true, playing: false, start: engine.start, end: engine.end, at: engine.vt };
    engine.seek(T + 2_000);
    let arrived = 0;
    backend.playTo(T + 4_000, 2, () => arrived++);
    expect(backend.state.playing).toBe(true);
    const wall = performance.now();
    inner.tick(wall + 500);
    expect(engine.vt).toBeCloseTo(T + 3_000, -1);
    inner.tick(wall + 1_000);
    inner.tick(wall + 1_500);
    expect(engine.vt).toBe(T + 4_000);
    expect(arrived).toBe(1);
    expect(backend.state.playing).toBe(false);
    expect(store.landingsTotal()).toBe(2);
    // A seek by anyone else ends the trip without calling back.
    backend.playTo(T + 6_500, 1, () => arrived++);
    backend.seek(T + 5_000);
    inner.tick(performance.now() + 5_000);
    expect(arrived).toBe(1);
    // A time already passed is a seek, and calls back at once.
    backend.playTo(T + 3_000, 1, () => arrived++);
    expect(arrived).toBe(2);
    expect(engine.vt).toBe(T + 3_000);
  });
});

describe("the tour's address", () => {
  it("is a replay with the tour on, never with the simulator or the director", () => {
    expect(parseRoute("/c/hono", "?tour=1")).toMatchObject({ kind: "colony", colonyId: "hono", tour: true, replay: { source: "auto", speed: 1 } });
    expect(parseRoute("/c/hono", "?replay=1")).toMatchObject({ tour: false });
    expect(parseRoute("/c/hono", "?tour=1&director=1")).toMatchObject({ tour: false, replay: null });
    expect(parseRoute("/c/hono", "?tour=1&mock=1")).toMatchObject({ tour: false, replay: null });
    expect(parseRoute("/c/hono", "?tour=0")).toMatchObject({ tour: false, replay: null });
    expect(colonyHref("hono", { tour: true })).toBe("/c/hono?tour=1");
  });
});
