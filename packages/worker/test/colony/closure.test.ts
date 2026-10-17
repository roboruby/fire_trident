import { describe, expect, it } from "vitest";
import {
  ClosureLedger,
  DEFAULT_SILENT_TTL_MS,
  LEDGER_KEEP,
  abandonCause,
  closureOf,
  durationText,
  eventFields,
  gapOf,
  migrateClosure,
  reapCutoffs,
  silentTtlMs,
  type SqlRunner,
} from "../../src/colony/closure.ts";

/** The part of node:sqlite these tests use (the worker compiles against workers types, not Node's). */
interface DatabaseSync {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
}
const SQLITE = "node:sqlite";
const { DatabaseSync } = (await import(SQLITE)) as { DatabaseSync: new (path: string) => DatabaseSync };

function sqlite(): SqlRunner {
  const db = new DatabaseSync(":memory:");
  return {
    exec: (q, ...b) => {
      const rows = db.prepare(q).all(...(b as never[]));
      return { toArray: () => rows };
    },
  };
}

/** A storage with the colony's intents table as it was before the ledger, holding one intent. */
function colonyTables(): SqlRunner {
  const sql = sqlite();
  sql.exec("CREATE TABLE intents (id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL)");
  sql.exec("INSERT INTO intents (id, title, status) VALUES ('int_1', 'Old intent', 'claimed')");
  return sql;
}

const agent = (id: string, kind: string | null, lastSeen: number | null) => ({ id, kind, lastSeen });

describe("closure causes and gaps", () => {
  it("an abandon's cause is the one named, else what the agent's kind implies", () => {
    expect(abandonCause("released", "internal")).toBe("released");
    expect(abandonCause("stopped", "external")).toBe("stopped");
    expect(abandonCause(undefined, "external")).toBe("released");
    expect(abandonCause(undefined, "internal")).toBe("gave_up");
    expect(abandonCause("landed", "synthetic")).toBe("gave_up");
  });

  it("the gap runs from the last sign of life, and is 0 when the agent's own call closed it", () => {
    expect(gapOf("reaped_silent", 1_000, 91_500)).toBe(90_500);
    expect(gapOf("landed", 5_000, 4_000)).toBe(0);
    expect(gapOf("released", 1_000, 900_000)).toBe(0);
    expect(gapOf("gave_up", null, 900_000)).toBe(0);
    expect(gapOf("withdrawn", null, 900_000)).toBeUndefined();
  });

  it("a stored closure is read field by field; anything else reads as none", () => {
    const c = { cause: "reaped_silent", at: 5, status: "open", agentId: "agt_1", agentKind: "external", gapMs: 91_000 };
    expect(closureOf(JSON.stringify(c))).toEqual(c);
    expect(closureOf({ ...c, agentKind: "robot", gapMs: -1 })).toEqual({ cause: "reaped_silent", at: 5, status: "open", agentId: "agt_1" });
    for (const bad of [null, undefined, "", "{", "[]", { ...c, cause: "vanished" }, { ...c, at: "now" }]) expect(closureOf(bad)).toBeNull();
    expect(eventFields(closureOf(c))).toEqual({ cause: "reaped_silent", agentId: "agt_1", agentKind: "external", gapMs: 91_000 });
    expect(eventFields(null)).toEqual({});
  });
});

describe("the silent-agent limit", () => {
  it("the default cuts every agent at ten minutes, as before; a shorter one only outside agents", () => {
    expect(reapCutoffs(DEFAULT_SILENT_TTL_MS, 1_000_000_000)).toEqual({ external: 1_000_000_000 - 600_000, inPlatform: 1_000_000_000 - 600_000 });
    expect(reapCutoffs(90_000, 1_000_000_000)).toEqual({ external: 1_000_000_000 - 90_000, inPlatform: 1_000_000_000 - 600_000 });
    expect(reapCutoffs(3_600_000, 1_000_000_000)).toEqual({ external: 1_000_000_000 - 3_600_000, inPlatform: 1_000_000_000 - 3_600_000 });
  });

  it("a person's setting is checked against the bounds", () => {
    expect(silentTtlMs(90)).toBe(90_000);
    expect(silentTtlMs(null)).toBeNull();
    for (const bad of [59, 86_401, Number.NaN, "90", undefined]) expect(() => silentTtlMs(bad)).toThrow(/seconds must be a number from 60 to 86400/);
    expect([90_000, 60_000, 600_000, 3_600_000, 5_400_000].map(durationText)).toEqual(["90 s", "1 min", "10 min", "1 h", "1 h 30 min"]);
  });

  it("is kept per colony, read back, and reset to the default", () => {
    const sql = colonyTables();
    const ledger = new ClosureLedger(sql);
    expect(ledger.ttl()).toMatchObject({ ms: 600_000, default: true, inPlatformMs: 600_000 });
    expect(ledger.setTtl(90_000, "matt", 7)).toMatchObject({ ms: 90_000, seconds: 90, default: false, inPlatformMs: 600_000, setBy: "matt", setAt: 7 });
    // A new ledger on the same storage (the object woke again) reads it back.
    expect(new ClosureLedger(sql).ttl()).toMatchObject({ ms: 90_000, setBy: "matt" });
    expect(ledger.setTtl(null, "matt", 8)).toMatchObject({ ms: 600_000, default: true });
    expect(new ClosureLedger(sql).ttl().default).toBe(true);
  });
});

describe("the ledger", () => {
  it("adds the intent column only when it is missing; an old intent reads as having no closure", () => {
    const sql = colonyTables();
    migrateClosure(sql);
    migrateClosure(sql);
    const row = sql.exec("SELECT * FROM intents WHERE id = 'int_1'").toArray()[0] as Record<string, unknown>;
    expect(row).toMatchObject({ id: "int_1", status: "claimed", closure: null });
    expect(closureOf(row.closure)).toBeNull();
  });

  it("records a closure on the intent, in its history and in the counts per agent kind", () => {
    const sql = colonyTables();
    const ledger = new ClosureLedger(sql);
    const c = ledger.record({ intentId: "int_1", cause: "reaped_silent", status: "open", at: 200_000, agent: agent("agt_x", "external", 100_000) });
    expect(c).toEqual({ cause: "reaped_silent", at: 200_000, status: "open", agentId: "agt_x", agentKind: "external", gapMs: 100_000 });
    expect(closureOf((sql.exec("SELECT closure FROM intents WHERE id = 'int_1'").toArray()[0] as { closure: string }).closure)).toEqual(c);
    ledger.record({ intentId: "int_1", cause: "landed", status: "landed", at: 300_000, agent: agent("agt_s", "synthetic", 290_000) });
    ledger.record({ intentId: "int_2", cause: "released", status: "open", at: 310_000, agent: agent("agt_x", "external", 1) });
    ledger.record({ intentId: "int_3", cause: "gave_up", status: "open", at: 320_000, agent: agent("agt_i", "internal", null), detail: "gave up at edit after 4 attempts" });
    ledger.record({ intentId: "int_4", cause: "reaped_silent", status: "open", at: 400_000, agent: agent("agt_y", "external", 300_000) });
    ledger.record({ intentId: "int_5", cause: "returned", status: "open", at: 410_000, agent: agent("agt_gone", null, null) });
    expect(ledger.history("int_1").map((x) => x.cause)).toEqual(["landed", "reaped_silent"]);
    expect(ledger.history("int_9")).toEqual([]);
    const r = ledger.report();
    expect(r.total).toBe(5);
    expect(r.byKind.external).toEqual({ total: 3, counts: { released: 1, reaped_silent: 2 }, shares: { released: 0.3333, reaped_silent: 0.6667 } });
    expect(r.byKind.synthetic).toEqual({ total: 1, counts: { landed: 1 }, shares: { landed: 1 } });
    expect(r.byKind.internal).toEqual({ total: 1, counts: { gave_up: 1 }, shares: { gave_up: 1 } });
    expect(r.reaped).toEqual({ count: 2, medianGapMs: 100_000, maxGapMs: 100_000 });
    expect(r).toMatchObject({ silentTtlMs: 600_000, silentTtlDefault: true });
  });

  it("keeps the newest rows for histories and every count", () => {
    const sql = sqlite();
    const ledger = new ClosureLedger(sql);
    const n = LEDGER_KEEP + 600;
    for (let i = 0; i < n; i++) ledger.record({ intentId: `int_${i}`, cause: "landed", status: "landed", at: i, agent: agent(`agt_${i}`, "internal", i) });
    const kept = (sql.exec("SELECT COUNT(*) AS n FROM intent_closures").toArray()[0] as { n: number }).n;
    expect(kept).toBeLessThanOrEqual(LEDGER_KEEP + 500);
    expect(kept).toBeGreaterThanOrEqual(LEDGER_KEEP);
    expect(ledger.history(`int_${n - 1}`)).toHaveLength(1);
    expect(ledger.history("int_0")).toEqual([]);
    expect(ledger.report().byKind.internal?.counts.landed).toBe(n);
  });
});
