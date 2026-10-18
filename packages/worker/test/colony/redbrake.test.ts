import { describe, expect, it } from "vitest";
import type { Certification, ColonyEvent, Id, Path, Proposal, TrunkHealth } from "@fire_trident/core";
import { migrateClosure } from "../../src/colony/closure.ts";
import { migrateDirection } from "../../src/colony/direction.ts";
import { CEILING_MS, CONE_MAX, FAILURES, RedBrake, brakeText, coneOf, holdMessage, meetsCone, redBrakeEnabled, releaseMessage, repairHint, summarize, withBrake, type RedBrakeHost } from "../../src/colony/redbrake.ts";
import { cleanModelHint } from "../../src/colony/stepup.ts";
import { StuckDetector } from "../../src/colony/stuck.ts";

/**
 * The red brake (colony/redbrake.ts) on a colony's own tables in node:sqlite: a red result with an open repair holds
 * changes that write what the failing tests load, puts the repair first and asks for the stronger model; green, the
 * ceiling, a report, two failures, a repair gone and the flag turned off each let held changes go; and with the flag
 * off nothing happens at all.
 */

/** The part of node:sqlite these tests use (the worker compiles against workers types, not Node's). */
interface DatabaseSync {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
}
const SQLITE = "node:sqlite";
const { DatabaseSync } = (await import(SQLITE)) as { DatabaseSync: new (path: string) => DatabaseSync };

function sqlStorage(): { sql: SqlStorage; db: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  const sql = {
    exec(query: string, ...bindings: unknown[]) {
      const rows = db.prepare(query).all(...bindings);
      return { toArray: () => rows, one: () => rows[0], [Symbol.iterator]: () => rows[Symbol.iterator]() };
    },
  } as unknown as SqlStorage;
  return { sql, db };
}

const T = 1_800_000_000_000;
const MIN = 60_000;
const RED = "a".repeat(40);
const GREEN = "b".repeat(40);

/** A colony's tables as ColonyDO makes them (the columns the brake reads), with the direction and closure migrations. */
function colonyTables(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE intents (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, why TEXT NOT NULL, source TEXT NOT NULL, rule_id TEXT, parent_id TEXT,
    footprint TEXT NOT NULL, acceptance TEXT, priority REAL NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL,
    created_by TEXT NOT NULL, assigned_to TEXT, violations INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)`);
  sql.exec(`CREATE TABLE proposals (
    id TEXT PRIMARY KEY, intent_id TEXT NOT NULL, agent_id TEXT NOT NULL, status TEXT NOT NULL, region TEXT NOT NULL,
    priority REAL NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, data TEXT NOT NULL)`);
  sql.exec("CREATE TABLE agents (id TEXT PRIMARY KEY)");
  sql.exec("CREATE TABLE rules (id TEXT PRIMARY KEY)");
  migrateDirection(sql);
  migrateClosure(sql);
}

interface World {
  brake: RedBrake;
  sql: SqlStorage;
  published: ColonyEvent[];
  notices: Array<{ agentId: Id; intentId: Id; message: string }>;
  enqueued: Array<{ id: Id; region: string; priority: number }>;
  bumps: Record<string, number>;
  forgot: Id[];
  woken: number[];
  clock: { now: number };
  flag: { on: boolean };
}

function world(on = true): World {
  const { sql } = sqlStorage();
  colonyTables(sql);
  const w: World = { brake: null as unknown as RedBrake, sql, published: [], notices: [], enqueued: [], bumps: {}, forgot: [], woken: [], clock: { now: T }, flag: { on } };
  const host: RedBrakeHost = {
    sql,
    enabled: () => w.flag.on,
    now: () => w.clock.now,
    enqueue: async (p, region, priority) => {
      w.enqueued.push({ id: p.id, region, priority });
    },
    notice: (agentId, intentId, message) => {
      w.notices.push({ agentId, intentId, message });
      return { t: "directive", at: w.clock.now, directiveId: `dir_${w.notices.length}`, agentId, intentId, message, by: "red brake", kind: "hold" };
    },
    publish: (events) => void w.published.push(...events),
    bump: (name, delta) => void (w.bumps[name] = (w.bumps[name] ?? 0) + delta),
    wake: (at) => void w.woken.push(at),
    forget: (id) => void w.forgot.push(id),
    waitUntil: () => undefined,
  };
  w.brake = new RedBrake(host);
  return w;
}

function intent(w: World, id: Id, source: string, status = "open", footprint: Path[] = ["src/math.ts"], at = T - MIN): void {
  w.sql.exec(
    "INSERT INTO intents (id, title, why, source, footprint, priority, status, created_at, created_by, updated_at) VALUES (?, ?, 'why', ?, ?, ?, ?, ?, ?, ?)",
    id,
    source === "certify" ? "Make the failing tests pass: subtracts" : `Change ${footprint.join(", ")}`,
    source,
    JSON.stringify(footprint),
    source === "certify" ? 10 : 1,
    status,
    at,
    source === "certify" ? "certify" : "person",
    at,
  );
}

function change(id: Id, intentId: Id, paths: Path[], agentId = "agt_b"): Proposal {
  return {
    id,
    colonyId: "col",
    intentId,
    agentId,
    status: "ready",
    createdAt: T,
    baseSha: GREEN,
    headSha: GREEN,
    workspace: { name: "ws", remote: "r" },
    writeSet: paths.map((path) => ({ path, blob: "c".repeat(40) })),
    readSet: [],
    declared: { footprint: paths, summary: "edit" },
    evidence: { checks: [], notVerified: "" },
  } as unknown as Proposal;
}

/** Store a change as ColonyDO keeps it. */
function stored(w: World, p: Proposal, status = p.status, at = T): void {
  w.sql.exec(
    "INSERT OR REPLACE INTO proposals (id, intent_id, agent_id, status, region, priority, created_at, updated_at, data) VALUES (?, ?, ?, ?, 'src', 1, ?, ?, ?)",
    p.id,
    p.intentId,
    p.agentId,
    status,
    at,
    at,
    JSON.stringify({ ...p, status }),
  );
}

/** A red result on `sha` whose failing test loads src/math.ts (and src/num.ts through it). */
function red(sha = RED, repairIntentId?: Id, at = T): Certification {
  return {
    trunkSha: sha,
    status: "red",
    startedAt: at - 100,
    finishedAt: at,
    failing: [{ file: "test/math.test.ts", name: "subtracts", error: "Expected values to be strictly equal: 8 !== 2" }],
    ...(repairIntentId ? { repairIntentId } : {}),
  };
}

const REACH = (file: Path): Path[] => (file === "test/math.test.ts" ? ["test/math.test.ts", "src/math.ts", "src/num.ts"] : [file]);

function brakeEvents(w: World, action?: string): Array<Extract<ColonyEvent, { t: "brake" }>> {
  return w.published.filter((e): e is Extract<ColonyEvent, { t: "brake" }> => e.t === "brake" && (action === undefined || e.action === action));
}

/** A red trunk with an open repair (int_r) and the brake holding. */
function holding(): World {
  const w = world();
  intent(w, "int_r", "certify");
  w.brake.verdict(red(RED, "int_r"), REACH);
  return w;
}

describe("the cone and the switch", () => {
  it("is every file the failing test files load, itself first, at most CONE_MAX", () => {
    expect(coneOf(["test/math.test.ts"], REACH)).toEqual(["test/math.test.ts", "src/math.ts", "src/num.ts"]);
    expect(coneOf(["test/a.test.ts", "test/b.test.ts"], null)).toEqual(["test/a.test.ts", "test/b.test.ts"]);
    const wide = (f: Path): Path[] => [f, ...Array.from({ length: CONE_MAX }, (_, i) => `src/m${i}.ts`)];
    expect(coneOf(["test/a.test.ts"], wide)).toHaveLength(CONE_MAX);
    expect(meetsCone(change("p", "i", ["src/math.ts", "README.md", "src/math.ts"]), new Set(["src/math.ts"]))).toEqual(["src/math.ts"]);
    expect(meetsCone(change("p", "i", ["README.md"]), new Set(["src/math.ts"]))).toEqual([]);
  });

  it("reads FT_RED_BRAKE like FT_REVALIDATE: on, or a list of colony ids; off when absent", () => {
    expect(redBrakeEnabled(undefined, "c1")).toBe(false);
    expect(redBrakeEnabled("off", "c1")).toBe(false);
    expect(redBrakeEnabled("on", "c1")).toBe(true);
    expect(redBrakeEnabled("c2, c1", "c1")).toBe(true);
    expect(redBrakeEnabled("c2", "c1")).toBe(false);
  });

  it("says what a held change waits for, and why it goes on, in plain sentences", () => {
    expect(holdMessage(["src/math.ts"], RED, { id: "int_r", title: "Make the failing tests pass: subtracts" }, CEILING_MS)).toBe(
      'Trunk is red in files your change touches (src/math.ts): the tests that load them fail at aaaaaaa. Your change waits for the repair, intent int_r "Make the failing tests pass: subtracts", and goes on to its lane when trunk is green again or within 15.0 min; there is nothing to do now.',
    );
    expect(releaseMessage("green", 90_000)).toBe("Trunk is green again: your change goes on to its lane now, after waiting 1.5 min.");
    expect(releaseMessage(null, 5_000)).toBe("No repair is open for the red trunk any more: your change goes on to its lane now, after waiting 5 s.");
  });
});

describe("with the flag off", () => {
  it("does nothing at all: no tables, no hold, no repair first, no model hint, no report", () => {
    const w = world(false);
    intent(w, "int_r", "certify");
    intent(w, "int_b", "human");
    w.brake.verdict(red(RED, "int_r"), REACH);
    w.brake.sweep(T + MIN);
    expect(w.brake.first(T + MIN)).toBeNull();
    expect(w.brake.hold(change("prp_b", "int_b", ["src/math.ts"]), { source: "human" }, T + MIN)).toBeNull();
    expect(w.brake.modelFor({ id: "int_r", source: "certify" })).toBeUndefined();
    expect(w.brake.report(T + MIN)).toBeUndefined();
    expect(w.brake.stuckItems(T + MIN)).toEqual([]);
    expect(w.sql.exec("SELECT name FROM sqlite_master WHERE name LIKE 'red_brake%'").toArray()).toEqual([]);
    expect(w.published).toEqual([]);
  });
});

describe("while trunk is red and its repair is open", () => {
  it("starts holding, offers the repair first and asks for the stronger model for it", () => {
    const w = holding();
    expect(brakeEvents(w, "on")).toEqual([{ t: "brake", at: T, action: "on", trunkSha: RED, repairId: "int_r", paths: ["test/math.test.ts"] }]);
    expect(w.woken).toEqual([T + 30_000]);
    expect(w.brake.first(T + MIN)).toBe("int_r");
    w.brake.reserved("int_r", "agt_d", T + MIN);
    expect(brakeEvents(w, "reserve")).toEqual([{ t: "brake", at: T + MIN, action: "reserve", repairId: "int_r", agentId: "agt_d", trunkSha: RED }]);
    // Taken: nothing more to offer first until it is open again.
    w.sql.exec("UPDATE intents SET status = 'claimed' WHERE id = 'int_r'");
    expect(w.brake.first(T + MIN)).toBeNull();
    // The repair's take carries the stronger model class from its first attempt, and agents keep the hint.
    const hint = w.brake.modelFor({ id: "int_r", source: "certify" });
    expect(hint).toEqual(repairHint(0));
    expect(cleanModelHint(hint)).toEqual({ model: "default", returns: 0, reason: hint!.reason, cause: "repair" });
    expect(cleanModelHint({ ...hint, cause: undefined })).toBeUndefined();
    expect(w.brake.modelFor({ id: "int_b", source: "human" })).toBeUndefined();
  });

  it("holds a change that writes what the failing tests load and tells its agent; the rest and the repair go on", () => {
    const w = holding();
    intent(w, "int_b", "human", "proposed");
    intent(w, "int_c", "human", "proposed", ["README.md"]);
    const b = change("prp_b", "int_b", ["src/num.ts", "src/extra.ts"]);
    const events = w.brake.hold(b, { source: "human" }, T + MIN);
    expect(events?.map((e) => (e.t === "brake" ? `brake ${e.action}` : e.t))).toEqual(["brake hold", "directive"]);
    expect(events?.[0]).toMatchObject({ proposalId: "prp_b", intentId: "int_b", agentId: "agt_b", paths: ["src/num.ts"], trunkSha: RED, repairId: "int_r" });
    expect(w.notices[0]?.message).toMatch(/^Trunk is red in files your change touches \(src\/num\.ts\): the tests that load them fail at aaaaaaa\. Your change waits for the repair, intent int_r/);
    expect(w.brake.hold(change("prp_c", "int_c", ["README.md"]), { source: "human" }, T + MIN)).toBeNull();
    expect(w.brake.hold(change("prp_r", "int_r", ["src/math.ts"], "agt_d"), { source: "certify" }, T + MIN)).toBeNull();
    expect(w.bumps["brake.held"]).toBe(1);
  });

  it("lets held changes go when trunk is green again: still waiting ones to their lanes, with the time to green", () => {
    const w = holding();
    intent(w, "int_b", "human", "proposed");
    intent(w, "int_e", "human", "proposed", ["src/math.ts"]);
    const b = change("prp_b", "int_b", ["src/math.ts"]);
    const e = change("prp_e", "int_e", ["src/math.ts"], "agt_e");
    stored(w, b);
    stored(w, e);
    w.brake.hold(b, { source: "human" }, T + MIN);
    w.brake.hold(e, { source: "human" }, T + 2 * MIN);
    // The agent of prp_e recalled it meanwhile: nothing goes to a lane for it.
    w.sql.exec("UPDATE proposals SET status = 'returned' WHERE id = 'prp_e'");
    expect(w.brake.report(T + 3 * MIN)?.held.holding).toBe(2);
    w.brake.sweep(T + 3 * MIN);
    expect(w.brake.report(T + 3 * MIN)?.held.holding).toBe(1);
    w.clock.now = T + 4 * MIN;
    w.brake.verdict({ trunkSha: GREEN, status: "green", startedAt: T + 4 * MIN - 50, finishedAt: T + 4 * MIN }, null);
    expect(w.enqueued).toEqual([{ id: "prp_b", region: "src", priority: 1 }]);
    expect(brakeEvents(w, "green")).toEqual([{ t: "brake", at: T + 4 * MIN, action: "green", trunkSha: GREEN, toGreenMs: 4 * MIN, repairId: "int_r" }]);
    expect(brakeEvents(w, "release").map((r) => [r.proposalId, r.heldMs, r.end, r.gone])).toEqual([
      ["prp_e", MIN, undefined, true],
      ["prp_b", 3 * MIN, "green", undefined],
    ]);
    expect(w.notices.at(-1)).toEqual({ agentId: "agt_b", intentId: "int_b", message: "Trunk is green again: your change goes on to its lane now, after waiting 3.0 min." });
    // Nothing is held after green, and nothing is offered first.
    expect(w.brake.hold(change("prp_f", "int_b", ["src/math.ts"]), { source: "human" }, T + 5 * MIN)).toBeNull();
    expect(w.brake.first(T + 5 * MIN)).toBeNull();
    const r = w.brake.report(T + 5 * MIN)!;
    expect(r).toMatchObject({
      on: true,
      episodes: { count: 1, green: 1, open: 0, ceiling: 0, escalated: 0, reported: 0 },
      held: { changes: 2, holding: 0, ms: 4 * MIN, p50Ms: MIN, maxMs: 3 * MIN },
      toGreen: { episodes: 1, p50Ms: 4 * MIN, maxMs: 4 * MIN },
      repairs: { reserved: 0, escalated: 0 },
    });
    expect(r.holding).toBeUndefined();
    expect(r.text).toBe("held 2 changes for 4.0 min in all over 1 red episode; 1 episode back to green in 4.0 min at p50");
  });

  it("stops holding at the ceiling: held changes go on, and the episode is stuck work", () => {
    const w = holding();
    intent(w, "int_b", "human", "proposed");
    const b = change("prp_b", "int_b", ["src/math.ts"]);
    stored(w, b);
    w.brake.hold(b, { source: "human" }, T + MIN);
    w.brake.sweep(T + CEILING_MS - 1);
    expect(w.enqueued).toEqual([]);
    w.brake.sweep(T + CEILING_MS);
    expect(w.enqueued.map((x) => x.id)).toEqual(["prp_b"]);
    expect(brakeEvents(w, "stop")).toEqual([{ t: "brake", at: T + CEILING_MS, action: "stop", end: "ceiling", trunkSha: RED, held: 1, repairId: "int_r" }]);
    expect(w.notices.at(-1)?.message).toMatch(/^Trunk is still red after 15\.0 min of holding: your change goes on to its lane now/);
    // For the rest of the episode nothing is held and the repair is not offered first; a later red result changes nothing.
    w.brake.verdict(red("d".repeat(40), undefined, T + CEILING_MS + MIN), REACH);
    expect(w.brake.hold(change("prp_g", "int_b", ["src/math.ts"]), { source: "human" }, T + CEILING_MS + MIN)).toBeNull();
    expect(w.brake.first(T + CEILING_MS + MIN)).toBeNull();
    const stuck = w.brake.stuckItems(T + CEILING_MS + MIN);
    expect(stuck).toEqual([
      {
        key: `brake:${RED}:ceiling`,
        kind: "red",
        since: T + CEILING_MS,
        text: "The red brake stopped holding after 15.0 min and let 1 held change go: repair “Make the failing tests pass: subtracts” has not made trunk green, and trunk is still red since aaaaaaa (1 failing)",
        action: "tests",
        trunkSha: RED,
        intentId: "int_r",
        title: "Make the failing tests pass: subtracts",
      },
    ]);
    // The stuck-work detector lists it with the red check's items.
    const detector = new StuckDetector(w.sql, 10 * MIN, (now) => w.brake.stuckItems(now));
    w.sql.exec("CREATE TABLE IF NOT EXISTS certifications (trunk_sha TEXT PRIMARY KEY, status TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER, data TEXT NOT NULL)");
    expect(detector.report(T + CEILING_MS + MIN).items.map((i) => i.key)).toContain(`brake:${RED}:ceiling`);
    expect(w.brake.report(T + CEILING_MS + MIN)?.episodes).toMatchObject({ count: 1, open: 1, ceiling: 1 });
  });

  it(`sends the repair to a person with the failing tests after it failed ${FAILURES} times, and stops holding`, () => {
    const w = holding();
    intent(w, "int_b", "human", "proposed");
    const b = change("prp_b", "int_b", ["src/math.ts"]);
    stored(w, b);
    w.brake.hold(b, { source: "human" }, T + MIN);
    // One change came back for review, one was redirected (does not count), one attempt was given back.
    stored(w, { ...change("prp_r1", "int_r", ["src/math.ts"], "agt_d"), reason: "llm: return (the change does not address the failing test)" } as Proposal, "returned", T + 2 * MIN);
    stored(w, { ...change("prp_r2", "int_r", ["src/math.ts"], "agt_d"), reason: "superseded: the intent was revised" } as Proposal, "returned", T + 3 * MIN);
    expect(w.brake.first(T + 3 * MIN)).toBe("int_r");
    w.sql.exec("INSERT INTO intent_closures (intent_id, at, cause, status, agent_id) VALUES ('int_r', ?, 'gave_up', 'open', 'agt_d')", T + 4 * MIN);
    expect(w.brake.first(T + 4 * MIN)).toBeNull();
    const row = w.sql.exec<{ escalation_open: number; escalation: string }>("SELECT escalation_open, escalation FROM intents WHERE id = 'int_r'").one();
    expect(row.escalation_open).toBe(1);
    const e = JSON.parse(row.escalation) as { kind: string; by: string; report: string };
    expect(e).toMatchObject({ kind: "other", by: "certify" });
    expect(e.report).toContain("The repair failed 2 times (its changes came back or were given back). The latest came back with: llm: return (the change does not address the failing test)");
    expect(e.report).toContain("Trunk is still red at aaaaaaa; failing tests: test/math.test.ts > subtracts: Expected values to be strictly equal: 8 !== 2.");
    expect(w.sql.exec("SELECT agent_id, kind FROM intent_escalations WHERE intent_id = 'int_r'").toArray()).toEqual([{ agent_id: "certify", kind: "other" }]);
    expect(w.forgot).toEqual(["int_r"]);
    expect(w.published.filter((x) => x.t === "escalation")).toHaveLength(1);
    expect(brakeEvents(w, "escalate")).toMatchObject([{ repairId: "int_r", failures: 2 }]);
    expect(brakeEvents(w, "stop")).toMatchObject([{ end: "escalated", held: 1, failures: 2 }]);
    expect(w.enqueued.map((x) => x.id)).toEqual(["prp_b"]);
    expect(w.brake.stuckItems(T + 5 * MIN)[0]).toMatchObject({ key: `brake:${RED}:escalated`, action: "answer", intentId: "int_r" });
    expect(w.brake.report(T + 5 * MIN)?.repairs).toEqual({ reserved: 0, escalated: 1 });
  });

  it("stops holding when the repair's agent reports it to a person", () => {
    const w = holding();
    intent(w, "int_b", "human", "proposed");
    const b = change("prp_b", "int_b", ["src/math.ts"]);
    stored(w, b);
    w.brake.hold(b, { source: "human" }, T + MIN);
    w.sql.exec("UPDATE intents SET escalation_open = 1 WHERE id = 'int_r'");
    w.brake.sweep(T + 2 * MIN);
    expect(brakeEvents(w, "stop")).toMatchObject([{ end: "reported", held: 1 }]);
    expect(w.enqueued.map((x) => x.id)).toEqual(["prp_b"]);
    expect(w.brake.first(T + 2 * MIN)).toBeNull();
  });

  it("lets held changes go while no repair is open, and holds again under a new repair until the ceiling", () => {
    const w = holding();
    intent(w, "int_b", "human", "proposed");
    const b = change("prp_b", "int_b", ["src/math.ts"]);
    stored(w, b);
    w.brake.hold(b, { source: "human" }, T + MIN);
    // The repair landed after the red result: its verdict is still to come, so the brake holds on.
    w.sql.exec("UPDATE intents SET status = 'landed', updated_at = ? WHERE id = 'int_r'", T + 2 * MIN);
    w.brake.sweep(T + 2 * MIN);
    expect(w.enqueued).toEqual([]);
    // Still red, and no new repair (the hourly cap): held changes go on, without stopping the episode.
    w.clock.now = T + 3 * MIN;
    w.brake.verdict(red("d".repeat(40), undefined, T + 3 * MIN), REACH);
    expect(w.enqueued.map((x) => x.id)).toEqual(["prp_b"]);
    expect(brakeEvents(w, "release")[0]).toMatchObject({ proposalId: "prp_b", heldMs: 2 * MIN });
    expect(brakeEvents(w, "release")[0]?.end).toBeUndefined();
    expect(brakeEvents(w, "stop")).toEqual([]);
    // A new repair at the next red result: holding again, within the same ceiling.
    intent(w, "int_r2", "certify", "open", ["src/math.ts"], T + 4 * MIN);
    w.clock.now = T + 4 * MIN;
    w.brake.verdict(red("e".repeat(40), "int_r2", T + 4 * MIN), REACH);
    expect(w.brake.first(T + 4 * MIN)).toBe("int_r2");
    expect(w.brake.hold(change("prp_h", "int_b", ["src/math.ts"]), { source: "human" }, T + 4 * MIN)).not.toBeNull();
    expect(w.brake.first(T + CEILING_MS)).toBeNull();
    expect(brakeEvents(w, "stop")).toMatchObject([{ end: "ceiling" }]);
  });

  it("lets everything go when the flag is turned off, and ends the episode", () => {
    const w = holding();
    intent(w, "int_b", "human", "proposed");
    const b = change("prp_b", "int_b", ["src/math.ts"]);
    stored(w, b);
    w.brake.hold(b, { source: "human" }, T + MIN);
    w.flag.on = false;
    expect(w.brake.first(T + 2 * MIN)).toBeNull();
    expect(w.enqueued.map((x) => x.id)).toEqual(["prp_b"]);
    expect(brakeEvents(w, "stop")).toMatchObject([{ end: "off", held: 1 }]);
    expect(w.notices.at(-1)?.message).toBe("The red brake was turned off for this colony: your change goes on to its lane now, after waiting 60 s.");
    w.brake.sweep(T + 3 * MIN);
    expect(brakeEvents(w, "stop")).toHaveLength(1);
    expect(w.brake.report(T + 3 * MIN)).toMatchObject({ on: false, episodes: { count: 1, open: 0 } });
  });

  it("holds nothing without a repair: repairs off for the colony, or none declared", () => {
    const w = world();
    intent(w, "int_b", "human", "proposed");
    w.brake.verdict(red(RED), REACH);
    expect(w.brake.hold(change("prp_b", "int_b", ["src/math.ts"]), { source: "human" }, T + MIN)).toBeNull();
    expect(w.brake.first(T + MIN)).toBeNull();
    expect(brakeEvents(w, "on")).toEqual([]);
    expect(w.brake.report(T + MIN)).toMatchObject({ episodes: { count: 1, open: 1 }, held: { changes: 0 } });
  });
});

describe("the report and trunk health", () => {
  it("says what the brake did in one line, and adds it to trunk health without changing the stored report", () => {
    expect(brakeText(summarize(true, [], [], T))).toBe("the red brake is on; trunk has not been red since");
    expect(brakeText(summarize(false, [], [], T))).toBe("the red brake is off for this colony");
    const w = holding();
    intent(w, "int_b", "human", "proposed");
    w.brake.hold(change("prp_b", "int_b", ["src/math.ts"]), { source: "human" }, T + MIN);
    const r = w.brake.report(T + 3 * MIN)!;
    expect(r.holding).toEqual({ since: T, until: T + CEILING_MS, trunkSha: RED, repairId: "int_r", failing: ["test/math.test.ts"], cone: 3 });
    expect(r.text).toBe("held 1 change for 2.0 min in all over 1 red episode; holding 1 now");
    const measured = { status: "measured", text: "red 1 time", detail: ["Time red: 3 min."] } as unknown as TrunkHealth;
    const h = withBrake(measured, r);
    expect(h).toMatchObject({ brake: { episodes: r.episodes, held: r.held, toGreen: r.toGreen, repairs: r.repairs }, detail: ["Time red: 3 min.", `Red brake: ${r.text}.`] });
    expect((measured as { detail: string[] }).detail).toEqual(["Time red: 3 min."]);
    const none = { status: "none", text: "x", reason: "y" } as TrunkHealth;
    expect(withBrake(none, r)).toBe(none);
    expect(withBrake(measured, undefined)).toBe(measured);
  });
});
