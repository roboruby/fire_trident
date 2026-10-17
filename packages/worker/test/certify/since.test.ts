import { describe, expect, it } from "vitest";
import type { Path } from "@fire_trident/core";
import { GREEN_SLACK_MS } from "../../src/certify/culprit.ts";
import { SINCE_LANDINGS, landedSince, logHoldsSince } from "../../src/certify/since.ts";

/** Culprit finding's first landing since green, read from the colony's landing log (its landings, proposals and intents tables). */

/** The part of node:sqlite these tests use (the worker compiles against workers types, not Node's). */
interface DatabaseSync {
  prepare(sql: string): { all(...params: unknown[]): unknown[]; run(...params: unknown[]): unknown };
  exec(sql: string): void;
}
const SQLITE = "node:sqlite";
const { DatabaseSync } = (await import(SQLITE)) as { DatabaseSync: new (path: string) => DatabaseSync };

/** A colony's landing log over an in-memory database: the tables as ColonyDO makes them, with the columns read here. */
function colonyLog() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE landings (id TEXT PRIMARY KEY, at INTEGER NOT NULL, received_at INTEGER NOT NULL, trunk_sha TEXT NOT NULL, data TEXT NOT NULL)");
  db.exec("CREATE INDEX landings_by_received ON landings(received_at)");
  db.exec("CREATE TABLE proposals (id TEXT PRIMARY KEY, intent_id TEXT NOT NULL, data TEXT NOT NULL)");
  db.exec("CREATE TABLE intents (id TEXT PRIMARY KEY, title TEXT NOT NULL, why TEXT NOT NULL)");
  const sql = {
    exec(query: string, ...bindings: unknown[]) {
      const rows = db.prepare(query).all(...bindings);
      return { toArray: () => rows, one: () => rows[0], [Symbol.iterator]: () => rows[Symbol.iterator]() };
    },
  } as unknown as SqlStorage;
  /** One landing of proposals (each writing its paths for its intent), received `late` ms after it landed. */
  const land = (id: string, at: number, proposals: Array<{ id: string; intent: string; paths: Path[] }>, extra: { intentIds?: string[]; paths?: Path[]; late?: number } = {}) => {
    const paths = extra.paths ?? [...new Set(proposals.flatMap((p) => p.paths))].sort();
    const intentIds = extra.intentIds ?? [...new Set(proposals.map((p) => p.intent))];
    for (const p of proposals) {
      db.prepare("INSERT INTO proposals (id, intent_id, data) VALUES (?, ?, ?)").run(p.id, p.intent, JSON.stringify({ writeSet: p.paths.map((path) => ({ path, blob: `${p.id}-${path}` })) }));
      db.prepare("INSERT OR IGNORE INTO intents (id, title, why) VALUES (?, ?, ?)").run(p.intent, `Title of ${p.intent}`, `Why of ${p.intent}.`);
    }
    const data = { id, colonyId: "web", trunkSha: `sha-${id}`, parentSha: "", proposalIds: proposals.map((p) => p.id), intentIds, paths, regions: [], at };
    db.prepare("INSERT INTO landings (id, at, received_at, trunk_sha, data) VALUES (?, ?, ?, ?, ?)").run(id, at, at + (extra.late ?? 1), `sha-${id}`, JSON.stringify(data));
  };
  return { sql, land };
}

describe("culprit finding: the landing log since green", () => {
  it("answers the oldest landings since green that changed the paths, oldest first, with intent, title and why", () => {
    const { sql, land } = colonyLog();
    land("lnd_old", 10, [{ id: "prp_old", intent: "int_old", paths: ["src/util.ts"] }]);
    land("lnd_0", 50, [{ id: "prp_0", intent: "int_0", paths: ["src/util.ts"] }]);
    for (const k of [1, 2, 3, 4, 5]) land(`lnd_${k}`, k * 100, [{ id: `prp_${k}`, intent: `int_${k}`, paths: ["src/util.ts"] }]);
    land("lnd_docs", 150, [{ id: "prp_docs", intent: "int_docs", paths: ["README.md"] }]);
    const found = landedSince(sql, ["src/util.ts"], { at: 50, landingId: "lnd_0" }, 1_000);
    // The green commit's own landing is there too: culprit finding (afterGreen) leaves it out.
    expect(found.map((l) => l.landingId)).toEqual(["lnd_0", "lnd_1", "lnd_2", "lnd_3"].slice(0, SINCE_LANDINGS));
    expect(found[1]).toEqual({ landingId: "lnd_1", at: 100, trunkSha: "sha-lnd_1", intentId: "int_1", title: "Title of int_1", why: "Why of int_1.", paths: ["src/util.ts"] });
    expect(landedSince(sql, ["src/util.ts"], { at: 50, landingId: "lnd_0" }, 1_000, 2).map((l) => l.landingId)).toEqual(["lnd_0", "lnd_1"]);
    // Nothing for nothing asked, or a path no landing changed.
    expect(landedSince(sql, [], { at: 50, landingId: "lnd_0" }, 1_000)).toEqual([]);
    expect(landedSince(sql, ["src/none.ts"], { at: 50, landingId: "lnd_0" }, 1_000)).toEqual([]);
  });

  it("gives a group commit one entry per intent, and a commit of unknown proposals its only intent", () => {
    const { sql, land } = colonyLog();
    land("lnd_g", 100, [
      { id: "prp_a", intent: "int_a", paths: ["src/a.ts"] },
      { id: "prp_b", intent: "int_b", paths: ["src/b.ts", "src/c.ts"] },
    ]);
    land("lnd_x", 200, [], { intentIds: ["int_x"], paths: ["src/a.ts", "src/z.ts"] });
    const found = landedSince(sql, ["src/a.ts", "src/b.ts"], { at: 50, landingId: null }, 1_000);
    expect(found.map((l) => [l.landingId, l.intentId ?? null, l.paths])).toEqual([
      ["lnd_g", "int_a", ["src/a.ts"]],
      ["lnd_g", "int_b", ["src/b.ts"]],
      ["lnd_x", "int_x", ["src/a.ts"]],
    ]);
    // Its title and why are unknown (no such intent row): empty, as the index answers them.
    expect(found[2]).toMatchObject({ title: "", why: "" });
  });

  it("answers nothing when the log may no longer hold every landing since green (trimmed past it)", () => {
    const { sql, land } = colonyLog();
    for (const k of [1, 2, 3]) land(`lnd_${k}`, 1_000_000 + k * 100, [{ id: `prp_${k}`, intent: `int_${k}`, paths: ["src/util.ts"] }]);
    const since = { at: 1_000_000, landingId: "lnd_gone" };
    // Fewer rows than it keeps: never trimmed, so it holds them all.
    expect(logHoldsSince(sql, since, 1_000)).toBe(true);
    // As many as it keeps, without the green landing or one received before it: some may be gone.
    expect(logHoldsSince(sql, since, 3)).toBe(false);
    expect(landedSince(sql, ["src/util.ts"], since, 3)).toEqual([]);
    // It holds the green commit's landing, or one received before then: everything since is there.
    land("lnd_gone", 1_000_000, [{ id: "prp_g", intent: "int_g", paths: ["src/other.ts"] }]);
    expect(logHoldsSince(sql, since, 3)).toBe(true);
    land("lnd_before", 1_000_000 - GREEN_SLACK_MS - 10, [], { paths: ["src/other.ts"], late: 0 });
    expect(logHoldsSince(sql, { at: 1_000_000, landingId: null }, 3)).toBe(true);
    expect(landedSince(sql, ["src/util.ts"], { at: 1_000_000, landingId: null }, 3).map((l) => l.landingId)).toEqual(["lnd_1", "lnd_2", "lnd_3"]);
  });
});
