import { describe, expect, it } from "vitest";
import { STEPUP_CHECK, STEPUP_RETURNS, cleanModelHint, modelHintFor, stepupAdvice, stepupCheck, stepupEnabled, stepupHint } from "../../src/colony/stepup.ts";
import { RETURNS_MIN, returnsSinceCourse } from "../../src/colony/stuck.ts";

/**
 * Model step-up (FT_MODEL_STEPUP, colony/stepup.ts): two returns since an intent last changed course, counted as the stuck
 * detector counts them, move its next attempt to the stronger model class, with the reason; the hint is checked when
 * received, and an in-platform agent's evidence says why its model changed.
 */

/** The part of node:sqlite these tests use (the worker compiles against workers types, not Node's). */
interface DatabaseSync {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  exec(sql: string): void;
}
const SQLITE = "node:sqlite";
const { DatabaseSync } = (await import(SQLITE)) as { DatabaseSync: new (path: string) => DatabaseSync };

/** The colony's proposals and intent_revisions tables over node:sqlite, with helpers to add rows. */
function tables() {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE proposals (id TEXT PRIMARY KEY, intent_id TEXT NOT NULL, agent_id TEXT NOT NULL, status TEXT NOT NULL, region TEXT NOT NULL, priority REAL NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, data TEXT NOT NULL)",
  );
  db.exec(
    "CREATE TABLE intent_revisions (intent_id TEXT NOT NULL, revision INTEGER NOT NULL, at INTEGER NOT NULL, by TEXT NOT NULL, reason TEXT NOT NULL, changed TEXT NOT NULL, before TEXT NOT NULL, after TEXT NOT NULL, substantive INTEGER NOT NULL, PRIMARY KEY (intent_id, revision))",
  );
  const sql = {
    exec(query: string, ...bindings: unknown[]) {
      const rows = db.prepare(query).all(...bindings);
      return { toArray: () => rows, one: () => rows[0], [Symbol.iterator]: () => rows[Symbol.iterator]() };
    },
  } as unknown as SqlStorage;
  let n = 0;
  const proposal = (status: string, at: number, extra: { reason?: string; supersededBy?: string; intentId?: string } = {}): void => {
    const data = { reason: extra.reason, supersededBy: extra.supersededBy };
    sql.exec("INSERT INTO proposals (id, intent_id, agent_id, status, region, created_at, updated_at, data) VALUES (?, ?, 'agt_1', ?, 'src', ?, ?, ?)", `prp_${++n}`, extra.intentId ?? "int_1", status, at, at + 10, JSON.stringify(data));
  };
  const revision = (at: number, substantive: boolean): void => {
    sql.exec("INSERT INTO intent_revisions (intent_id, revision, at, by, reason, changed, before, after, substantive) VALUES ('int_1', ?, ?, 'matt', 'r', '[]', '{}', '{}', ?)", ++n, at, substantive ? 1 : 0);
  };
  return { sql, proposal, revision };
}

describe("model step-up", () => {
  it("is off unless FT_MODEL_STEPUP is on or lists the colony", () => {
    expect(stepupEnabled(undefined, "col")).toBe(false);
    expect(stepupEnabled("", "col")).toBe(false);
    expect(stepupEnabled("off", "col")).toBe(false);
    expect(stepupEnabled("on", "col")).toBe(true);
    expect(stepupEnabled("other, col", "col")).toBe(true);
    expect(stepupEnabled("other", "col")).toBe(false);
  });

  it("asks for the stronger model class from the second return, and says why", () => {
    expect(STEPUP_RETURNS).toBe(2);
    expect(STEPUP_RETURNS).toBeLessThan(RETURNS_MIN);
    expect(stepupHint(0)).toBeUndefined();
    expect(stepupHint(1)).toBeUndefined();
    expect(stepupHint(2)).toEqual({ model: "default", returns: 2, reason: "Changes for this intent came back 2 times since it last changed course, so this attempt asks for the stronger model class (default)." });
    expect(stepupHint(3)?.returns).toBe(3);
  });

  it("counts the intent's returns and rejections since it last changed course, as the stuck detector counts them", () => {
    const t = tables();
    t.proposal("returned", 1_000, { reason: "stale: src/a.ts changed on trunk" });
    expect(modelHintFor(t.sql, "int_1")).toBeUndefined();
    t.proposal("rejected", 2_000, { reason: "a person: this rewrites the session cookie" });
    expect(modelHintFor(t.sql, "int_1")).toMatchObject({ model: "default", returns: 2 });
    // Other intents' proposals do not count.
    expect(modelHintFor(t.sql, "int_2")).toBeUndefined();
    // Changes of direction and lost contests are not returns of the work.
    t.proposal("returned", 3_000, { reason: "withdrawn: no longer needed" });
    t.proposal("returned", 4_000, { reason: "intent revised: r1 → r2" });
    t.proposal("returned", 5_000, { reason: "superseded: recalled by its agent" });
    t.proposal("returned", 6_000, { reason: "superseded: contest won by prp_9", supersededBy: "prp_9" });
    expect(modelHintFor(t.sql, "int_1")?.returns).toBe(2);
    t.proposal("returned", 7_000, { reason: "llm: the change does not handle an empty slug" });
    expect(modelHintFor(t.sql, "int_1")?.returns).toBe(3);
  });

  it("starts again after a landing or a substantive amendment, not after a priority change", () => {
    const landed = tables();
    landed.proposal("returned", 1_000, { reason: "stale" });
    landed.proposal("returned", 2_000, { reason: "stale" });
    landed.proposal("landed", 3_000);
    expect(modelHintFor(landed.sql, "int_1")).toBeUndefined();
    landed.proposal("returned", 4_000, { reason: "stale" });
    landed.proposal("returned", 5_000, { reason: "stale" });
    expect(modelHintFor(landed.sql, "int_1")?.returns).toBe(2);

    const amended = tables();
    amended.proposal("returned", 1_000, { reason: "stale" });
    amended.proposal("returned", 2_000, { reason: "stale" });
    amended.revision(2_500, false);
    expect(modelHintFor(amended.sql, "int_1")?.returns).toBe(2);
    amended.revision(3_000, true);
    expect(modelHintFor(amended.sql, "int_1")).toBeUndefined();
    amended.proposal("returned", 4_000, { reason: "stale" });
    expect(modelHintFor(amended.sql, "int_1")).toBeUndefined();
  });

  it("shares its count with the stuck detector's returns check", () => {
    const rows = [
      { status: "returned", createdAt: 3, updatedAt: 3, reason: "stale", supersededBy: null },
      { status: "returned", createdAt: 2, updatedAt: 2, reason: "withdrawn: x", supersededBy: null },
      { status: "rejected", createdAt: 1, updatedAt: 1, reason: "no", supersededBy: null },
      { status: "landed", createdAt: 0, updatedAt: 0, reason: null, supersededBy: null },
      { status: "returned", createdAt: -1, updatedAt: -1, reason: "stale", supersededBy: null },
    ];
    expect(returnsSinceCourse({ proposals: rows, revisedAt: null }).map((p) => p.createdAt)).toEqual([3, 1]);
    expect(returnsSinceCourse({ proposals: rows, revisedAt: 2 }).map((p) => p.createdAt)).toEqual([3]);
  });

  it("takes a received hint only in its exact form", () => {
    const good = stepupHint(2)!;
    expect(cleanModelHint(good)).toEqual(good);
    expect(cleanModelHint({ ...good, reason: "  two\n returns  " })).toEqual({ ...good, reason: "two returns" });
    expect(cleanModelHint({ ...good, reason: "x".repeat(400) })?.reason).toHaveLength(300);
    for (const bad of [undefined, null, "default", { ...good, model: "@cf/big/model" }, { ...good, returns: 1 }, { ...good, returns: 2.5 }, { ...good, reason: "" }, { ...good, reason: 7 }]) {
      expect(cleanModelHint(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });

  it("records why a change's model is not its agent's own, and tells an outside agent it is advice only", () => {
    const hint = stepupHint(2)!;
    expect(stepupCheck(hint, "@cf/big/model", "@cf/small/model")).toEqual({
      name: STEPUP_CHECK,
      ok: true,
      ms: 0,
      detail: `${hint.reason} The change was written with @cf/big/model instead of the agent's own @cf/small/model.`,
    });
    expect(stepupCheck(hint, "@cf/big/model", "@cf/big/model").detail).toContain("which is already the agent's own model");
    const advice = stepupAdvice(hint);
    expect(advice).toMatchObject({ class: "default", returns: 2, reason: hint.reason });
    expect(advice.advice).toContain("advice only");
  });
});
