import { describe, expect, it } from "vitest";
import type { ColonyEvent } from "@fire_trident/core";
import type { SqlRunner } from "../../src/colony/inline.ts";
import { DIRECTION_TABLE } from "../../src/trunk/direction.ts";
import { FENCE_HELD_EVENT, FENCE_HELD_METRIC, PROTECT_HELD_EVENT, PROTECT_HELD_METRIC, fenceCheck, fenceHeldBumps, fenceHeldIds, fenceHeldReason, isFenceHeld, protectHeldReason } from "../../src/trunk/fencecheck.ts";

/**
 * The direction fence's per-cycle check fails closed (trunk/fencecheck.ts): a change whose direction record cannot be
 * read is held for the next cycle, never landed unchecked and never sent back.
 */

interface DatabaseSync {
  prepare(sql: string): { all(...params: unknown[]): unknown[]; run(...params: unknown[]): unknown };
  exec(sql: string): void;
}
const SQLITE = "node:sqlite";
const { DatabaseSync } = (await import(SQLITE)) as { DatabaseSync: new (path: string) => DatabaseSync };

function writer() {
  const db = new DatabaseSync(":memory:");
  db.exec(DIRECTION_TABLE);
  const sql: SqlRunner = { exec: (q, ...b) => ({ toArray: () => db.prepare(q).all(...b) }) };
  const record = (intentId: string, info: unknown): void => void db.prepare("INSERT OR REPLACE INTO ft_direction (intent_id, info, at) VALUES (?, ?, 1)").run(intentId, typeof info === "string" ? info : JSON.stringify(info));
  return { db, sql, record };
}

const change = (id: string, intentId: string, intentRevision = 1) => ({ id, intentId, intentRevision, createdAt: 0 });

describe("the direction fence's check (fails closed)", () => {
  it("sends back a withdrawn intent's change and lets the rest through when the record reads", () => {
    const w = writer();
    w.record("int_w", { status: "withdrawn", revision: 1, withdrawnReason: "not needed" });
    const out = fenceCheck(w.sql, [change("p1", "int_w"), change("p2", "int_ok")]);
    expect(out).toEqual({ returned: new Map([["p1", "withdrawn: not needed"]]), held: new Map(), problem: null });
  });

  it("holds every change it could not judge when the record cannot be read: none lands, none goes back", () => {
    const w = writer();
    w.db.exec("DROP TABLE ft_direction");
    const out = fenceCheck(w.sql, [change("p1", "int_a"), change("p2", "int_b"), change("p3", "int_c")], new Set(["p3"]));
    expect(out.returned.size).toBe(0);
    expect([...out.held.keys()]).toEqual(["p1", "p2"]);
    expect(out.problem).toMatch(/^the record could not be read: no such table: ft_direction/);
    const reason = out.held.get("p1")!;
    expect(reason).toBe(fenceHeldReason("no such table: ft_direction"));
    expect(reason).toBe(
      "waiting for the next landing cycle: the direction check could not read whether this change's intent was withdrawn or amended (no such table: ft_direction), so the change was neither landed nor sent back; it lands once the check can run",
    );
    expect(isFenceHeld(reason)).toBe(true);
    // The next cycle whose read succeeds judges them as usual.
    w.db.exec(DIRECTION_TABLE);
    expect(fenceCheck(w.sql, [change("p1", "int_a"), change("p2", "int_b")])).toEqual({ returned: new Map(), held: new Map(), problem: null });
  });

  it("holds only the changes of an intent whose row cannot be parsed", () => {
    const w = writer();
    w.record("int_bad", "{not json");
    w.record("int_w", { status: "withdrawn", revision: 1, withdrawnReason: "dropped" });
    const out = fenceCheck(w.sql, [change("p1", "int_bad"), change("p2", "int_ok"), change("p3", "int_w")]);
    expect(out.returned).toEqual(new Map([["p3", "withdrawn: dropped"]]));
    expect(out.held).toEqual(new Map([["p1", fenceHeldReason("the record of intent int_bad cannot be parsed")]]));
    expect(out.problem).toBe("the record of 1 intent cannot be parsed");
  });

  it("reads nothing for an empty cycle or one whose changes all landed", () => {
    const w = writer();
    w.db.exec("DROP TABLE ft_direction");
    expect(fenceCheck(w.sql, [])).toEqual({ returned: new Map(), held: new Map(), problem: null });
    expect(fenceCheck(w.sql, [change("p1", "int_a")], new Set(["p1"]))).toEqual({ returned: new Map(), held: new Map(), problem: null });
  });

  it("names the held changes of a landing answer, and only those", () => {
    const held = fenceHeldReason("disk I/O error");
    expect(fenceHeldIds({ deferred: [{ proposalId: "p1", reason: held }, { proposalId: "p2", reason: "blob pull failed: timeout" }, { proposalId: "p3", reason: protectHeldReason("x") }] })).toEqual(new Set(["p1", "p3"]));
    expect(fenceHeldIds(null)).toEqual(new Set());
    expect(fenceHeldIds({})).toEqual(new Set());
    expect(isFenceHeld("paused by maya")).toBe(false);
  });

  it("counts the held changes a trunk writer's events report, for the colony's metrics", () => {
    const at = 1;
    const events: ColonyEvent[] = [
      { t: "metric", at, name: FENCE_HELD_EVENT, value: 3 },
      { t: "metric", at, name: "trunk.landed", value: 4 },
      { t: "metric", at, name: FENCE_HELD_EVENT, value: 2 },
    ];
    expect(fenceHeldBumps(events)).toEqual([[FENCE_HELD_METRIC, 5]]);
    expect(fenceHeldBumps([...events, { t: "metric", at, name: PROTECT_HELD_EVENT, value: 2 }])).toEqual([
      [FENCE_HELD_METRIC, 5],
      [PROTECT_HELD_METRIC, 2],
    ]);
    expect(fenceHeldBumps([{ t: "metric", at, name: "trunk.landed", value: 4 }])).toEqual([]);
    expect(fenceHeldBumps([{ t: "metric", at, name: FENCE_HELD_EVENT, value: Number.NaN }])).toEqual([]);
  });
});
