import { describe, expect, it } from "vitest";
import type { Landing } from "@fire_trident/core";
import { DerivedSet, trunkLog, type TrunkLanding } from "../../src/trunk/derived.ts";
import { HISTORY_MAX, PATH_HISTORY, pathHistory, pathHistoryDerived } from "../../src/trunk/history.ts";

/** The part of node:sqlite these tests use (the worker compiles against workers types, not Node's). */
interface DatabaseSync {
  prepare(sql: string): { all(...params: unknown[]): unknown[]; run(...params: unknown[]): unknown };
  exec(sql: string): void;
}
const SQLITE = "node:sqlite";
const { DatabaseSync } = (await import(SQLITE)) as { DatabaseSync: new (path: string) => DatabaseSync };

const hex = (n: number): string => n.toString(16).padStart(40, "0");

/** TrunkDO's landing tables over node:sqlite, with path history in a derived set over its log. */
function trunk() {
  const db = new DatabaseSync(":memory:");
  const sql = {
    exec(query: string, ...bindings: unknown[]) {
      const rows = db.prepare(query).all(...bindings);
      return {
        toArray: () => rows,
        one: () => {
          if (rows.length !== 1) throw new Error(`expected one row, got ${rows.length}`);
          return rows[0];
        },
        [Symbol.iterator]: () => rows[Symbol.iterator](),
      };
    },
  } as unknown as SqlStorage;
  const txn = (fn: () => void): void => {
    db.exec("BEGIN");
    try {
      fn();
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };
  db.exec("CREATE TABLE ft_landings (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, trunk_sha TEXT NOT NULL, parent_sha TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL)");
  db.exec("CREATE TABLE ft_landing_paths (path TEXT NOT NULL, seq INTEGER NOT NULL, landing_id TEXT NOT NULL, before_blob TEXT, after_blob TEXT, PRIMARY KEY (path, seq))");
  db.exec("CREATE TABLE ft_notes (landing_id TEXT PRIMARY KEY, commit_sha TEXT NOT NULL, note TEXT NOT NULL)");
  const set = new DerivedSet<TrunkLanding>(sql, txn, trunkLog(sql), [pathHistoryDerived(sql)]);
  let n = 0;
  /** Record a landing as finalizeRows does: its paths (blob null deletes), its note, and the hook. */
  const land = (paths: Record<string, string | null>, note: unknown): Landing => {
    n++;
    const landing: Landing = { id: `lnd_${n}`, colonyId: "c", trunkSha: hex(n + 1), parentSha: hex(n), proposalIds: [], intentIds: [], paths: Object.keys(paths).sort(), regions: [], at: 1_000 * n };
    txn(() => {
      const seq = sql.exec<{ seq: number }>("INSERT INTO ft_landings (id, trunk_sha, parent_sha, at, data) VALUES (?, ?, ?, ?, ?) RETURNING seq", landing.id, landing.trunkSha, landing.parentSha, landing.at, JSON.stringify(landing)).one().seq;
      for (const [path, blob] of Object.entries(paths)) sql.exec("INSERT INTO ft_landing_paths (path, seq, landing_id, before_blob, after_blob) VALUES (?, ?, ?, ?, ?)", path, seq, landing.id, null, blob);
      sql.exec("INSERT INTO ft_notes (landing_id, commit_sha, note) VALUES (?, ?, ?)", landing.id, landing.trunkSha, JSON.stringify(note));
      set.landed({ seq, landing: { landing, note: JSON.stringify(note) } });
    });
    return landing;
  };
  return { sql, db, set, land };
}

/** A lineage note's proposal: its id, agent, intent and the paths it wrote. */
const proposal = (id: string, intent: string, title: string, paths: string[]) => ({
  id,
  agentId: `agt_${id}`,
  agentKind: "internal",
  intent: { id: intent, title, why: "because" },
  writeSet: paths.map((path) => ({ path, blob: hex(9) })),
  readSet: [],
  decisions: [],
  evidence: { checks: [] },
});

describe("path history (a lazy derived index)", () => {
  it("costs the landing nothing, then answers who changed a path and for what, newest first, from one read", () => {
    const t = trunk();
    const l1 = t.land({ "src/a.ts": hex(11), "src/b.ts": hex(12) }, { proposals: [proposal("prp_1", "int_1", "Add a\nand b", ["src/a.ts"]), proposal("prp_2", "int_2", "Add b", ["src/b.ts"])] });
    const l2 = t.land({ "src/a.ts": null }, { proposals: [proposal("prp_3", "int_3", "Drop a", ["src/a.ts", "src/unchanged.ts"])] });
    expect(t.sql.exec("SELECT COUNT(*) AS n FROM ft_path_history").one()).toEqual({ n: 0 });
    expect(t.set.catchUp(PATH_HISTORY)).toMatchObject({ applied: 2, work: 3, behind: 0 });
    expect(pathHistory(t.sql, "src/a.ts")).toEqual([
      { landingId: l2.id, trunkSha: l2.trunkSha, at: l2.at, blob: null, proposalId: "prp_3", intentId: "int_3", agentId: "agt_prp_3", title: "Drop a" },
      { landingId: l1.id, trunkSha: l1.trunkSha, at: l1.at, blob: hex(11), proposalId: "prp_1", intentId: "int_1", agentId: "agt_prp_1", title: "Add a and b" },
    ]);
    expect(pathHistory(t.sql, "src/b.ts").map((e) => e.proposalId)).toEqual(["prp_2"]);
    // Only paths the landing changed: a proposal's write set entry that changed nothing is not history.
    expect(pathHistory(t.sql, "src/unchanged.ts")).toEqual([]);
    expect(pathHistory(t.sql, "nobody.ts")).toEqual([]);
  });

  it("labels commits no proposal wrote (reverts, antibodies), and reads a malformed note as one", () => {
    const t = trunk();
    t.land({ "src/a.ts": hex(1) }, { proposals: [proposal("prp_1", "int_1", "Add a", ["src/a.ts"])] });
    t.land({ "src/a.ts": hex(2) }, { proposals: [], revert: { of: "lnd_1", commit: hex(2), by: "matt", reason: "broke the router" } });
    // An antibody's note names the rejected proposal, which did not write the antibody file.
    t.land({ ".firetrident/antibodies/ab_1.json": hex(3) }, { proposals: [proposal("prp_9", "int_9", "Rejected", ["src/x.ts"])], system: { kind: "antibody", antibody: "ab_1" } });
    t.land({ "src/a.ts": hex(4) }, "not a note");
    t.set.catchUp(PATH_HISTORY);
    expect(pathHistory(t.sql, "src/a.ts").map((e) => [e.landingId, e.proposalId ?? null, e.title])).toEqual([
      ["lnd_4", null, ""],
      ["lnd_2", null, "Revert of lnd_1: broke the router"],
      ["lnd_1", "prp_1", "Add a"],
    ]);
    expect(pathHistory(t.sql, ".firetrident/antibodies/ab_1.json")).toEqual([expect.objectContaining({ landingId: "lnd_3", title: "Antibody ab_1" })]);
    expect(pathHistory(t.sql, "src/x.ts")).toEqual([]);
    const entry = pathHistory(t.sql, "src/a.ts")[0]!;
    expect(entry).not.toHaveProperty("proposalId");
    expect(entry).not.toHaveProperty("intentId");
  });

  it("is idempotent per landing, bounded per read, and rebuilt from the whole log", () => {
    const t = trunk();
    for (let i = 0; i < 5; i++) t.land({ "hot.ts": hex(i + 1) }, { proposals: [proposal(`prp_${i}`, `int_${i}`, `Change ${i}`, ["hot.ts"])] });
    expect(t.set.catchUp(PATH_HISTORY, { landings: 3 })).toMatchObject({ applied: 3, behind: 2 });
    expect(pathHistory(t.sql, "hot.ts").map((e) => e.proposalId)).toEqual(["prp_2", "prp_1", "prp_0"]);
    t.set.catchUp(PATH_HISTORY);
    expect(pathHistory(t.sql, "hot.ts", 2).map((e) => e.proposalId)).toEqual(["prp_4", "prp_3"]);
    expect(pathHistory(t.sql, "hot.ts", 0)).toHaveLength(1);
    expect(pathHistory(t.sql, "hot.ts", HISTORY_MAX * 10)).toHaveLength(5);
    // Applying the log again (a cursor written back) adds nothing.
    t.sql.exec("UPDATE ft_derived SET seq = 0");
    t.set.catchUp(PATH_HISTORY);
    expect(t.sql.exec("SELECT COUNT(*) AS n FROM ft_path_history").one()).toEqual({ n: 5 });
    // A rebuild forgets it; the next reads apply the whole log again.
    t.set.rebuild(PATH_HISTORY);
    expect(pathHistory(t.sql, "hot.ts")).toEqual([]);
    expect(t.set.catchUp(PATH_HISTORY)).toMatchObject({ applied: 5, behind: 0 });
    expect(pathHistory(t.sql, "hot.ts")).toHaveLength(5);
  });
});
