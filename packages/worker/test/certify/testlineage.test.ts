import { describe, expect, it } from "vitest";
import { LINEAGE_PER_FILE, changeBy, commitOrder, testLineage } from "../../src/certify/testlineage.ts";

/** The trunk writer's half of a landing's test row, over an in-memory database laid out as the trunk writer's tables. */

/** The part of node:sqlite these tests use (the worker compiles against workers types, not Node's). */
interface DatabaseSync {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  exec(sql: string): void;
}
const SQLITE = "node:sqlite";
const { DatabaseSync } = (await import(SQLITE)) as { DatabaseSync: new (path: string) => DatabaseSync };

const GEMMA = "@cf/google/gemma-4-26b-a4b-it";
const hex = (n: number): string => n.toString(16).padStart(40, "0");

/** A trunk writer's landing log: each landing's commit (on the previous one), the paths it changed and its note. */
function log() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE ft_landings (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, trunk_sha TEXT NOT NULL, parent_sha TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL)");
  db.exec("CREATE TABLE ft_landing_paths (path TEXT NOT NULL, seq INTEGER NOT NULL, landing_id TEXT NOT NULL, before_blob TEXT, after_blob TEXT, PRIMARY KEY (path, seq))");
  db.exec("CREATE TABLE ft_notes (landing_id TEXT PRIMARY KEY, commit_sha TEXT NOT NULL, note TEXT NOT NULL)");
  const sql = {
    exec(query: string, ...bindings: unknown[]) {
      const rows = db.prepare(query).all(...bindings);
      return { toArray: () => rows, one: () => rows[0], [Symbol.iterator]: () => rows[Symbol.iterator]() };
    },
  } as unknown as SqlStorage;
  let n = 0;
  /** One landing writing `paths` (`added` ones are new files), with this note. */
  const land = (note: Record<string, unknown>, paths: string[], added: string[] = []): { id: string; sha: string } => {
    n++;
    const id = `lnd_${n}`;
    const sha = hex(n);
    const rows = db.prepare("INSERT INTO ft_landings (id, trunk_sha, parent_sha, at, data) VALUES (?, ?, ?, ?, ?) RETURNING seq").all(id, sha, hex(n - 1), n, "{}") as Array<{ seq: number }>;
    for (const path of paths) db.prepare("INSERT INTO ft_landing_paths (path, seq, landing_id, before_blob, after_blob) VALUES (?, ?, ?, ?, ?)").all(path, rows[0]!.seq, id, added.includes(path) ? null : "b".repeat(40), "c".repeat(40));
    db.prepare("INSERT INTO ft_notes (landing_id, commit_sha, note) VALUES (?, ?, ?)").all(id, sha, JSON.stringify({ landingId: id, ...note }));
    return { id, sha };
  };
  return { sql, land };
}

const wrote = (path: string, extra: Record<string, unknown> = {}) => ({ id: "prp_x", model: GEMMA, writeSet: [{ path, blob: "c".repeat(40) }], decisions: [], ...extra });
const approved = [{ kind: "triage", layer: "human", p: 1, action: "approve", by: "Lee" }];

describe("where commits sit on trunk", () => {
  it("answers each commit's sequence number, 0 for the commit the log starts from, and leaves unknown ones out", () => {
    const { sql, land } = log();
    const a = land({ proposals: [] }, ["src/a.ts"]);
    const b = land({ proposals: [] }, ["src/b.ts"]);
    expect(commitOrder(sql, [a.sha, b.sha, hex(0), "f".repeat(40), "not a sha"])).toEqual({ [a.sha]: 1, [b.sha]: 2, [hex(0)]: 0 });
    expect(commitOrder(sql, [])).toEqual({});
  });
});

describe("who changed each test file", () => {
  it("tells inherited files, agents' changes with the model, a person's approval and a person's revert", () => {
    const { sql, land } = log();
    land({ proposals: [wrote("test/agent.test.ts")] }, ["test/agent.test.ts"], ["test/agent.test.ts"]);
    land({ proposals: [wrote("test/approved.test.ts", { decisions: approved })] }, ["test/approved.test.ts"]);
    land({ revert: { by: "Matt", of: "lnd_1" }, proposals: [] }, ["test/reverted.test.ts"]);
    const top = land({ system: { kind: "protect" }, proposals: [] }, ["test/system.test.ts"]);
    const l = testLineage(sql, { paths: ["test/agent.test.ts", "test/approved.test.ts", "test/reverted.test.ts", "test/system.test.ts", "test/inherited.test.ts"], upTo: top.sha });
    expect(l["test/agent.test.ts"]).toEqual({ changes: [{ landingId: "lnd_1", by: "agent", name: GEMMA, added: true }], more: false });
    expect(l["test/approved.test.ts"]).toEqual({ changes: [{ landingId: "lnd_2", by: "person", name: "Lee" }], more: false });
    expect(l["test/reverted.test.ts"]).toEqual({ changes: [{ landingId: "lnd_3", by: "person", name: "Matt" }], more: false });
    expect(l["test/system.test.ts"]).toEqual({ changes: [{ landingId: "lnd_4", by: "system" }], more: false });
    expect(l["test/inherited.test.ts"]).toEqual({ changes: [], more: false });
  });

  it("stops at the commit asked for, and says when older changes were left out", () => {
    const { sql, land } = log();
    const first = land({ proposals: [wrote("test/a.test.ts")] }, ["test/a.test.ts"]);
    for (let i = 0; i < LINEAGE_PER_FILE + 1; i++) land({ proposals: [wrote("test/a.test.ts", { decisions: approved })] }, ["test/a.test.ts"]);
    expect(testLineage(sql, { paths: ["test/a.test.ts"], upTo: first.sha })["test/a.test.ts"]).toEqual({ changes: [{ landingId: "lnd_1", by: "agent", name: GEMMA }], more: false });
    const all = testLineage(sql, { paths: ["test/a.test.ts"], upTo: hex(LINEAGE_PER_FILE + 2) })["test/a.test.ts"]!;
    expect(all.changes).toHaveLength(LINEAGE_PER_FILE);
    expect(all.more).toBe(true);
    expect(all.changes.every((c) => c.by === "person")).toBe(true);
    // A commit the log does not hold (the import): nothing changed the file by then.
    expect(testLineage(sql, { paths: ["test/a.test.ts"], upTo: "e".repeat(40) })["test/a.test.ts"]).toEqual({ changes: [], more: false });
  });

  it("reads an agent's unapproved change first when several changes wrote the file in one landing", () => {
    expect(changeBy({ proposals: [wrote("a.test.ts", { decisions: approved }), wrote("a.test.ts", { model: "other" })] }, "a.test.ts")).toEqual({ by: "agent", name: "other" });
    expect(changeBy({ proposals: [wrote("b.test.ts")] }, "a.test.ts")).toEqual({ by: "unknown" });
    expect(changeBy(null, "a.test.ts")).toEqual({ by: "unknown" });
  });
});
