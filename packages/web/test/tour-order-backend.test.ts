import { describe, expect, it } from "vitest";
import type { ColonyEvent, ColonySnapshot, RecordedEvent } from "@fire_trident/core";
import { FieldSynth, ReplayEngine, Timeline, startingPoint } from "../src/replay.ts";
import { ColonyStore } from "../src/store.ts";
import { ORDER_BACKEND_TOUR, languageOf, quoteReason } from "../src/tour/orderBackend.ts";
import { runTourCheck, tourFor } from "../src/tour/tours.ts";

/**
 * The order-backend tour: six steps told from a record shaped like the order-backend colony's (scripts/goal_conflict.ts
 * --demo): the seed landing, three goals, the first landing, two changes held for a person naming it, and the queue;
 * checked against the public review queue, the snapshot and the metrics endpoint.
 */

const T = 1_792_100_000_000;
const FILE = "src/backend.ts";
const RUST = "Move the order backend to Rust";
const GO = "Move the order backend to Go";
const TS = "Move the order backend to TypeScript";
const WHY_RUST = "Ship the order backend as one static binary with no runtime to install, and keep its latency predictable under load.";
const reason = (age: string) => `escalated by deterministic: would undo 5 lines in ${FILE} that landing l1 wrote ${age} ago for intent "${RUST}" (${WHY_RUST}), a different intent; a person decides which goal stands`;
const NAMES: Record<string, string> = { s: "python-seed", aR: "rust-port", aG: "go-port", aT: "typescript-port" };

function record(opts: { decided?: boolean } = {}): RecordedEvent[] {
  const intent = (at: number, id: string, status: "open" | "claimed" | "landed", title: string): ColonyEvent => ({ t: "intent", at: T + at, intentId: id, status, title, footprint: [FILE] });
  const prop = (at: number, id: string, intentId: string, agentId: string, status: "checking" | "ready" | "landed" | "escalated" | "returned", why?: string): ColonyEvent => ({ t: "proposal", at: T + at, proposalId: id, intentId, agentId, status, ...(why ? { reason: why } : {}) });
  const events: ColonyEvent[] = [
    { t: "agent", at: T, agentId: "s", kind: "external", state: "idle" },
    intent(0, "i0", "open", "Start the order backend"),
    intent(100, "i0", "claimed", "Start the order backend"),
    prop(200, "p0", "i0", "s", "checking"),
    prop(300, "p0", "i0", "s", "ready"),
    prop(500, "p0", "i0", "s", "landed"),
    intent(500, "i0", "landed", "Start the order backend"),
    { t: "landing", at: T + 500, landingId: "l0", trunkSha: "0".repeat(40), proposalIds: ["p0"], paths: [FILE] },
    { t: "agent", at: T + 4_900, agentId: "aR", kind: "external", state: "idle" },
    { t: "agent", at: T + 4_900, agentId: "aG", kind: "external", state: "idle" },
    { t: "agent", at: T + 4_900, agentId: "aT", kind: "external", state: "idle" },
    intent(5_000, "iR", "open", RUST),
    intent(5_000, "iG", "open", GO),
    intent(5_000, "iT", "open", TS),
    intent(10_000, "iR", "claimed", RUST),
    prop(10_200, "pR", "iR", "aR", "checking"),
    { t: "decision", at: T + 10_300, decisionId: "d1", kind: "triage", layer: "reflex", p: 0.93, action: "land", subject: "pR" },
    { t: "metric", at: T + 10_300, name: "funnel.reflex", value: 1 },
    prop(10_400, "pR", "iR", "aR", "ready"),
    prop(10_500, "pR", "iR", "aR", "landed"),
    intent(10_500, "iR", "landed", RUST),
    { t: "landing", at: T + 10_500, landingId: "l1", trunkSha: "1".repeat(40), proposalIds: ["pR"], paths: [FILE] },
    intent(15_000, "iG", "claimed", GO),
    prop(15_200, "pG", "iG", "aG", "checking"),
    prop(15_500, "pG", "iG", "aG", "escalated", reason("5 seconds")),
    { t: "metric", at: T + 15_500, name: "funnel.human", value: 1 },
    intent(19_000, "iT", "claimed", TS),
    prop(19_200, "pT", "iT", "aT", "checking"),
    prop(19_500, "pT", "iT", "aT", "escalated", reason("9 seconds")),
    { t: "metric", at: T + 19_500, name: "funnel.human", value: 2 },
  ];
  if (opts.decided) {
    events.push(
      { t: "decision", at: T + 60_000, decisionId: "d2", kind: "review", layer: "human", p: 1, action: "approve", subject: "pG" },
      prop(60_000, "pG", "iG", "aG", "ready"),
      prop(60_500, "pG", "iG", "aG", "landed"),
      intent(60_500, "iG", "landed", GO),
      { t: "landing", at: T + 60_500, landingId: "l2", trunkSha: "2".repeat(40), proposalIds: ["pG"], paths: [FILE] },
      { t: "decision", at: T + 61_000, decisionId: "d3", kind: "review", layer: "human", p: 1, action: "return", subject: "pT" },
      prop(61_000, "pT", "iT", "aT", "returned", "returned by a person: the other goal stands"),
    );
  }
  return events.map((e, i) => ({ ...e, seq: i + 1 }));
}

const intents = () => [
  { id: "i0", title: "Start the order backend", why: "A small order backend, in Python to begin with.", footprint: [FILE], status: "landed", source: "human", priority: 5 },
  { id: "iR", title: RUST, why: WHY_RUST, footprint: [FILE], status: "landed", source: "human", priority: 5 },
  { id: "iG", title: GO, why: "The team that will own the order backend writes Go.", footprint: [FILE], status: "proposed", source: "human", priority: 5 },
  { id: "iT", title: TS, why: "Share the order types with the web client.", footprint: [FILE], status: "proposed", source: "human", priority: 5 },
];

function snapshot(): ColonySnapshot {
  return {
    colony: { id: "order-backend", name: "order-backend", trunk: { namespace: "n", name: "t", remote: "r" }, trunkSha: "1".repeat(40), createdAt: T, regionDepth: 1 },
    files: [{ path: FILE, size: 900 }],
    intents: intents(),
    rules: [],
    agents: [],
    recentLandings: [],
    violations: { total: 0, byRule: {} },
    funnel: { proof: 0, reflex: 1, llm: 0, human: 2 },
    metrics: {},
  } as unknown as ColonySnapshot;
}

const undoes = [{ landingId: "l1", intentId: "iR", path: FILE, lines: 5 }];
/** GET /review: the proposals waiting for a person. */
const review = () => [
  { id: "pG", intentId: "iG", agentId: "aG", status: "escalated", reason: reason("5 seconds"), undoes },
  { id: "pT", intentId: "iT", agentId: "aT", status: "escalated", reason: reason("9 seconds"), undoes },
];
const metrics = (queue = 2, landings = 2) => ({ metrics: { landings, landedIntents: landings, reviewQueue: queue }, funnel: { proof: 0, reflex: 1, llm: 0, human: 2 }, violations: { total: 0 } });

/** The tour told and checked on the record, as the page and scripts/tour_check.ts do it. */
function told(events = record(), data: Record<string, unknown> = { review: review(), snapshot: snapshot() }, report = metrics()) {
  const store = new ColonyStore("order-backend");
  for (const [id, name] of Object.entries(NAMES)) store.agentNames.set(id, name);
  const snap = snapshot();
  store.learnIntents(snap.intents);
  const timeline = new Timeline(events);
  const { snapshot: initial, newFiles } = startingPoint(snap, timeline);
  const engine = new ReplayEngine(store, timeline, initial, newFiles, new FieldSynth());
  return runTourCheck(ORDER_BACKEND_TOUR, engine, data, report, "recorded");
}

const QUOTE_GO = `would undo 5 lines in src/backend.ts that landing l1 wrote 5 seconds ago for intent "${RUST}"`;
const QUOTE_TS = `would undo 5 lines in src/backend.ts that landing l1 wrote 9 seconds ago for intent "${RUST}"`;
const LINES = [
  "python-seed landed src/backend.ts for “Start the order backend” (“A small order backend, in Python to begin with.”), settled by its innate checks, with review off: the order backend began in one language.",
  "3 goals were then declared for src/backend.ts, one per agent and each with its own why: move it to Rust, Go and TypeScript.",
  "rust-port's change landed first, 5.5 s after the goals: the Rust version of src/backend.ts, settled by the reflex models, with nothing recent of another intent to undo.",
  `go-port's change came 5.0 s later and waits for a person: it “${QUOTE_GO}”, says the deterministic goal-conflict check, and a person decides which goal stands.`,
  `typescript-port's change waits too, naming the same landing: it “${QUOTE_TS}”. Neither agent could quietly undo the Rust version, and no model decided this.`,
  "The review queue still holds both changes: a person decides which goal stands, in the Review tab or from the command line, and until then trunk keeps the Rust version.",
];

describe("the order-backend tour", () => {
  it("is the tour of the order-backend colony, with six steps on its own moments", () => {
    expect(tourFor("order-backend")).toBe(ORDER_BACKEND_TOUR);
    expect(ORDER_BACKEND_TOUR.steps.map((s) => s.id)).toEqual(["seed", "goals", "first", "held-1", "held-2", "queue"]);
    expect(ORDER_BACKEND_TOUR.reads).toEqual({ review: "/review", snapshot: "" });
  });

  it("tells each moment in one sentence filled from the record, quoting the reason each change was held", () => {
    const run = told();
    expect(run.plan.stops.map((s) => s.moment.name)).toEqual(["@seed", "@goals", "@first-port", "@held-1", "@held-2", "@end"]);
    expect(run.lines.map((l) => l.text)).toEqual(LINES);
    for (const l of run.lines) expect(l.text).not.toMatch(/\{\w+\}/);
    expect(run.plan.stops.map((s) => s.at - T)).toEqual([500, 5_000, 10_500, 15_500, 19_500, 19_500]);
    expect(run.plan.stops[3]?.moment).toMatchObject({ paths: [FILE], proposalIds: ["pG"], count: 5 });
  });

  it("agrees with the review queue, the snapshot and the metrics endpoint when they tell the same run", () => {
    const run = told();
    expect(run.checks.filter((c) => !c.ok)).toEqual([]);
    expect(run.checks.map((c) => c.name)).toEqual([
      "changes waiting for a person",
      "the landing go-port's change would undo",
      "lines go-port's change would undo",
      "the landing typescript-port's change would undo",
      "lines typescript-port's change would undo",
      "goals for the seeded file",
      "review queue at the end",
      "violations at the end",
      "funnel proof at the end",
      "funnel reflex at the end",
      "funnel llm at the end",
      "funnel human at the end",
      "landings at the end",
      "intents landed at the end",
    ]);
    expect(run.checks[0]).toMatchObject({ tour: "2", metrics: "2" });
    expect(run.checks[1]).toMatchObject({ tour: "l1", metrics: "l1" });
  });

  it("flags a queue that disagrees, and cannot compare a change the queue no longer holds", () => {
    const queue = review();
    (queue[0] as { undoes: typeof undoes }).undoes = [{ ...undoes[0]!, lines: 4 }];
    const off = told(record(), { review: [queue[0]], snapshot: snapshot() });
    expect(off.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.tour} vs ${c.metrics}`)).toEqual(["changes waiting for a person: 2 vs 1", "lines go-port's change would undo: 5 vs 4"]);
    expect(off.checks.find((c) => c.name === "the landing typescript-port's change would undo")).toMatchObject({ ok: true, metrics: "not comparable" });
    // The last step then says one change left the queue.
    expect(off.lines[5]?.text).toBe("The Go version still waits for a person, and the TypeScript version left the review queue.");
    // The reads failed (null): the record alone tells the run, and the queue cannot be checked.
    const none = told(record(), { review: null, snapshot: null });
    expect(none.lines.map((l) => l.text)).toEqual(LINES);
    expect(none.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(["changes waiting for a person", "the landing go-port's change would undo", "lines go-port's change would undo", "the landing typescript-port's change would undo", "lines typescript-port's change would undo"]);
  });

  it("says what a person decided once the record holds the decisions", () => {
    const run = told(record({ decided: true }), { review: [], snapshot: snapshot() }, metrics(0, 3));
    expect(run.lines[5]?.text).toBe("A person kept the Go version, and a person sent the TypeScript version back to its agent.");
    expect(run.checks.filter((c) => !c.ok)).toEqual([]);
    expect(run.checks[0]).toMatchObject({ name: "changes waiting for a person", tour: "0", metrics: "0" });
    expect(run.checks.find((c) => c.name === "review queue at the end")).toMatchObject({ tour: "0", metrics: "0" });
  });

  it("reads a language from a goal's title and quotes the heart of a reason", () => {
    expect(languageOf(GO)).toBe("Go");
    expect(languageOf(TS)).toBe("TypeScript");
    expect(languageOf("Cache the totals")).toBeNull();
    expect(quoteReason(reason("5 seconds"))).toBe(QUOTE_GO);
    expect(quoteReason("escalated by deterministic: danger: a secret-looking line in src/backend.ts")).toBe("danger: a secret-looking line in src/backend.ts");
    expect(quoteReason(`escalated by a model: ${"x".repeat(300)}`)).toHaveLength(200);
  });

  it("has only the seed to tour on a run where nothing was held", () => {
    const run = told(record().filter((e) => !(e.t === "proposal" && e.status === "escalated")), { review: [], snapshot: snapshot() }, metrics(0));
    expect(run.plan.stops.map((s) => s.step.id)).toEqual(["seed", "goals", "first", "queue"]);
    expect(run.lines[1]?.text).toBe("1 goal were then declared for src/backend.ts, one per agent and each with its own why: move it to Rust.");
    expect(run.lines[3]?.text).toBe("No change waited for a person in this run.");
  });
});
