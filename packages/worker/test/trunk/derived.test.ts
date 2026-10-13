import { describe, expect, it, vi } from "vitest";
import type { Landing } from "@fire_trident/core";
import { COCHANGE_INDEX, CoChangeStore } from "../../src/trunk/cochange.ts";
import { DerivedSet, recordedLanding, trunkLog, type Derived, type DerivedMode, type LandingLog, type LogEntry, type TrunkLanding } from "../../src/trunk/derived.ts";
import { IMPORTS_INDEX, ImportIndex, importsDerived, type ImportSource } from "../../src/trunk/imports.ts";

/** The part of node:sqlite these tests use (the worker compiles against workers types, not Node's). */
interface DatabaseSync {
  prepare(sql: string): { all(...params: unknown[]): unknown[]; run(...params: unknown[]): unknown };
  exec(sql: string): void;
}
const SQLITE = "node:sqlite";
const { DatabaseSync } = (await import(SQLITE)) as { DatabaseSync: new (path: string) => DatabaseSync };

/** SqlStorage over node:sqlite, a transaction runner, and how many transactions committed. */
function storage(): { sql: SqlStorage; txn: (fn: () => void) => void; db: DatabaseSync; commits: () => number } {
  const db = new DatabaseSync(":memory:");
  let commits = 0;
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
      commits++;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };
  return { sql, txn, db, commits: () => commits };
}

/** A landing log of strings (each landing is its value), with reads that can be made to fail. */
class Log implements LandingLog<string> {
  broken = false;
  constructor(private readonly sql: SqlStorage) {
    sql.exec("CREATE TABLE log (seq INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT NOT NULL)");
  }

  /** Record a landing (call inside the landing's transaction, as finalizeRows does). */
  add(value: string): LogEntry<string> {
    return { seq: this.sql.exec<{ seq: number }>("INSERT INTO log (value) VALUES (?) RETURNING seq", value).one().seq, landing: value };
  }

  after(seq: number, limit: number): Array<LogEntry<string>> {
    if (this.broken) throw new Error("log unreadable");
    return this.sql
      .exec<{ seq: number; value: string }>("SELECT seq, value FROM log WHERE seq > ? ORDER BY seq LIMIT ?", seq, limit)
      .toArray()
      .map((r) => ({ seq: r.seq, landing: r.value }));
  }

  head(): number {
    return this.sql.exec<{ n: number }>("SELECT COALESCE(MAX(seq), 0) AS n FROM log").one().n;
  }

  before(seq: number): number {
    return this.sql.exec<{ n: number }>("SELECT COALESCE(MAX(seq), 0) AS n FROM log WHERE seq < ?", seq).one().n;
  }

  count(after: number): number {
    return this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM log WHERE seq > ?", after).one().n;
  }
}

/**
 * A toy index: one row per landing it applied, counting applications (n > 1 would be a landing applied
 * twice). It throws on the values in `fail`, and returns each value's length as its work.
 */
function toy(sql: SqlStorage, opts: { mode: DerivedMode; name?: string; version?: number; fail?: Set<string>; resetToHead?: boolean; adopt?: boolean }) {
  const name = opts.name ?? `toy_${opts.mode}`;
  sql.exec(`CREATE TABLE IF NOT EXISTS ${name} (seq INTEGER PRIMARY KEY, n INTEGER NOT NULL)`);
  const calls = { resets: 0, settles: 0 };
  const def: Derived<string> = {
    name,
    version: opts.version ?? 1,
    mode: opts.mode,
    apply: (e) => {
      sql.exec(`INSERT INTO ${name} (seq, n) VALUES (?, 1) ON CONFLICT(seq) DO UPDATE SET n = n + 1`, e.seq);
      if (opts.fail?.has(e.landing)) throw new Error(`cannot apply ${e.landing}`);
      return e.landing.length;
    },
    reset: (head) => {
      calls.resets++;
      sql.exec(`DELETE FROM ${name}`);
      return opts.resetToHead ? head : 0;
    },
    ...(opts.adopt ? { adopt: (base: number) => base } : {}),
    settle: () => {
      calls.settles++;
    },
  };
  /** The landings applied, and how many times each. */
  const applied = (): Record<number, number> => Object.fromEntries(sql.exec<{ seq: number; n: number }>(`SELECT seq, n FROM ${name} ORDER BY seq`).toArray().map((r) => [r.seq, r.n]));
  return { def, calls, applied };
}

/** The cursor rows. */
function cursors(sql: SqlStorage): Record<string, { version: number; seq: number }> {
  return Object.fromEntries(sql.exec<{ name: string; version: number; seq: number }>("SELECT name, version, seq FROM ft_derived").toArray().map((r) => [r.name, { version: r.version, seq: r.seq }]));
}

/** Record landings the way TrunkDO does: each in its own transaction, with the hook inside it. */
function land(s: { txn: (fn: () => void) => void }, log: Log, set: DerivedSet<string>, ...values: string[]): Array<string[]> {
  return values.map((v) => {
    let behind: string[] = [];
    s.txn(() => {
      behind = set.landed(log.add(v));
    });
    return behind;
  });
}

describe("derived indexes (DerivedSet)", () => {
  it("applies an eager index in the landing hook, in order, and leaves a lazy one to its first read", () => {
    const s = storage();
    const log = new Log(s.sql);
    const eager = toy(s.sql, { mode: "eager" });
    const lazy = toy(s.sql, { mode: "lazy" });
    const set = new DerivedSet(s.sql, s.txn, log, [eager.def, lazy.def]);
    expect(land(s, log, set, "a", "bb", "ccc")).toEqual([[], [], []]);
    expect(eager.applied()).toEqual({ 1: 1, 2: 1, 3: 1 });
    expect(lazy.applied()).toEqual({});
    expect(cursors(s.sql)).toEqual({ toy_eager: { version: 1, seq: 3 } });
    expect(set.status()).toEqual([
      { name: "toy_eager", mode: "eager", version: 1, stored: 1, seq: 3, head: 3, behind: 0 },
      { name: "toy_lazy", mode: "lazy", version: 1, stored: null, seq: 0, head: 3, behind: 3 },
    ]);
    // The first read catches the lazy index up, oldest first; the work is what apply returned.
    expect(set.catchUp("toy_lazy")).toEqual({ applied: 3, work: 6, behind: 0, rebuilt: false });
    expect(lazy.applied()).toEqual({ 1: 1, 2: 1, 3: 1 });
    expect(cursors(s.sql).toy_lazy).toEqual({ version: 1, seq: 3 });
    expect(set.catchUp("toy_lazy")).toEqual({ applied: 0, work: 0, behind: 0, rebuilt: false });
    expect(set.catchUp("nothing")).toEqual({ applied: 0, work: 0, behind: 0, rebuilt: false });
  });

  it("catches up within its budget: landings, work (finishing the landing in progress) and time, a slice per transaction", () => {
    const s = storage();
    const log = new Log(s.sql);
    const lazy = toy(s.sql, { mode: "lazy" });
    const set = new DerivedSet(s.sql, s.txn, log, [lazy.def]);
    land(s, log, set, ...Array.from({ length: 10 }, (_, i) => "x".repeat(i + 1)));
    const before = s.commits();
    expect(set.catchUp("toy_lazy", { landings: 4, slice: 3 })).toMatchObject({ applied: 4, work: 10, behind: 6 });
    expect(s.commits() - before).toBe(2);
    expect(lazy.calls.settles).toBe(2);
    // 5 + 6 = 11 reaches 9 during landing 6, which finishes; landing 7 waits for the next call.
    expect(set.catchUp("toy_lazy", { work: 9 })).toMatchObject({ applied: 2, work: 11, behind: 4 });
    expect(cursors(s.sql).toy_lazy!.seq).toBe(6);
    // Time is checked between slices: a slow first slice ends the call.
    let clock = 0;
    const timed = new DerivedSet(s.sql, s.txn, log, [{ ...lazy.def, apply: (e) => ((clock += 10), lazy.def.apply(e)) }], { now: () => clock });
    expect(timed.catchUp("toy_lazy", { ms: 15, slice: 2 })).toMatchObject({ applied: 2, behind: 2 });
    expect(set.catchUp("toy_lazy")).toMatchObject({ applied: 2, behind: 0 });
    expect(lazy.applied()).toEqual(Object.fromEntries(Array.from({ length: 10 }, (_, i) => [i + 1, 1])));
  });

  it("applies each landing once: the hook twice, a catch-up after the hook, and the hook after a catch-up", () => {
    const s = storage();
    const log = new Log(s.sql);
    const eager = toy(s.sql, { mode: "eager" });
    const set = new DerivedSet(s.sql, s.txn, log, [eager.def]);
    let entry: LogEntry<string> | null = null;
    s.txn(() => {
      entry = log.add("a");
      set.landed(entry);
      set.landed(entry);
    });
    expect(set.catchUp("toy_eager")).toMatchObject({ applied: 0, behind: 0 });
    s.txn(() => set.landed(entry!));
    expect(eager.applied()).toEqual({ 1: 1 });
    // A lazy index caught up by a read is never applied again by a later read.
    const lazy = toy(s.sql, { mode: "lazy" });
    set.define(lazy.def);
    set.catchUp("toy_lazy");
    land(s, log, set, "b");
    set.catchUp("toy_lazy");
    set.catchUp("toy_lazy");
    expect(lazy.applied()).toEqual({ 1: 1, 2: 1 });
  });

  it("resumes every index from its cursor after a restart, and adopts an index kept before cursors existed", () => {
    const s = storage();
    const log = new Log(s.sql);
    const first = { eager: toy(s.sql, { mode: "eager" }), lazy: toy(s.sql, { mode: "lazy" }) };
    const set = new DerivedSet(s.sql, s.txn, log, [first.eager.def, first.lazy.def]);
    land(s, log, set, "a", "b");
    set.catchUp("toy_lazy");
    // A new object over the same storage: same tables, new definitions, nothing in memory.
    const again = { eager: toy(s.sql, { mode: "eager" }), lazy: toy(s.sql, { mode: "lazy" }) };
    const restarted = new DerivedSet(s.sql, s.txn, log, [again.eager.def, again.lazy.def]);
    land(s, log, restarted, "c");
    expect(restarted.catchUp("toy_lazy")).toMatchObject({ applied: 1, behind: 0 });
    expect(again.eager.applied()).toEqual({ 1: 1, 2: 1, 3: 1 });
    expect(again.lazy.applied()).toEqual({ 1: 1, 2: 1, 3: 1 });
    // An eager index that kept itself up to date before it had a cursor starts from the landing before the hook's...
    const old = toy(s.sql, { mode: "eager", name: "toy_old", adopt: true });
    restarted.define(old.def);
    land(s, log, restarted, "d");
    expect(old.applied()).toEqual({ 4: 1 });
    // ...and from the head when a read comes first; without adopt, an index is built from the whole log.
    const read = toy(s.sql, { mode: "eager", name: "toy_read", adopt: true });
    const fresh = toy(s.sql, { mode: "eager", name: "toy_fresh" });
    restarted.define(read.def);
    restarted.define(fresh.def);
    expect(restarted.catchUp("toy_read")).toMatchObject({ applied: 0, behind: 0 });
    expect(restarted.catchUp("toy_fresh")).toMatchObject({ applied: 4, behind: 0 });
    expect(cursors(s.sql)).toMatchObject({ toy_old: { seq: 4 }, toy_read: { seq: 4 }, toy_fresh: { seq: 4 } });
  });

  it("rebuilds an index whose version changed: the hook leaves it, a read forgets it, the next reads apply the log again", () => {
    const s = storage();
    const log = new Log(s.sql);
    const v1 = toy(s.sql, { mode: "eager" });
    land(s, log, new DerivedSet(s.sql, s.txn, log, [v1.def]), "a", "b", "c", "d", "e");
    const v2 = toy(s.sql, { mode: "eager", version: 2 });
    const set = new DerivedSet(s.sql, s.txn, log, [v2.def]);
    // The hook does not apply a landing to an index built by another version.
    expect(land(s, log, set, "f")).toEqual([["toy_eager"]]);
    expect(v2.applied()).toEqual({ 1: 1, 2: 1, 3: 1, 4: 1, 5: 1 });
    const log2 = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      expect(set.catchUp("toy_eager")).toEqual({ applied: 0, work: 0, behind: 6, rebuilt: true });
      expect(JSON.parse(String(log2.mock.calls[0]![0]))).toMatchObject({ ft: "derived", index: "toy_eager", rebuilt: true, behind: 6 });
    } finally {
      log2.mockRestore();
    }
    expect(v2.calls.resets).toBe(1);
    expect(v2.applied()).toEqual({});
    expect(cursors(s.sql).toy_eager).toEqual({ version: 2, seq: 0 });
    // While it is rebuilt, the hook leaves new landings to the catch-up, which applies them in order.
    expect(land(s, log, set, "g")).toEqual([["toy_eager"]]);
    expect(set.catchUp("toy_eager", { landings: 4 })).toMatchObject({ applied: 4, behind: 3, rebuilt: false });
    expect(set.catchUp("toy_eager")).toMatchObject({ applied: 3, behind: 0 });
    expect(land(s, log, set, "h")).toEqual([[]]);
    expect(v2.applied()).toEqual({ 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1, 8: 1 });
    // An index not built from history starts again at the head.
    const tree = toy(s.sql, { mode: "eager", name: "toy_tree", resetToHead: true });
    set.define(tree.def);
    set.catchUp("toy_tree");
    set.define({ ...tree.def, version: 2 });
    expect(set.catchUp("toy_tree")).toMatchObject({ rebuilt: true, behind: 0 });
    expect(cursors(s.sql).toy_tree).toEqual({ version: 2, seq: 8 });
  });

  it("forgets indexes on demand: one (rebuild) or all of them (reset, a new trunk)", () => {
    const s = storage();
    const log = new Log(s.sql);
    const a = toy(s.sql, { mode: "eager", name: "toy_a" });
    const b = toy(s.sql, { mode: "lazy", name: "toy_b", resetToHead: true });
    const set = new DerivedSet(s.sql, s.txn, log, [a.def, b.def]);
    land(s, log, set, "a", "b");
    set.catchUp("toy_b");
    set.rebuild("toy_a");
    expect([a.calls.resets, b.calls.resets]).toEqual([1, 0]);
    expect(cursors(s.sql)).toEqual({ toy_a: { version: 1, seq: 0 }, toy_b: { version: 1, seq: 2 } });
    expect(set.catchUp("toy_a")).toMatchObject({ applied: 2, behind: 0 });
    set.reset();
    expect([a.calls.resets, b.calls.resets]).toEqual([2, 1]);
    expect(cursors(s.sql)).toEqual({ toy_a: { version: 1, seq: 0 }, toy_b: { version: 1, seq: 2 } });
    expect([a.applied(), b.applied()]).toEqual([{}, {}]);
  });

  it("fails open: a landing an index cannot apply is skipped and logged, the hook never throws, a broken log stops the catch-up", () => {
    const s = storage();
    const log = new Log(s.sql);
    const lazy = toy(s.sql, { mode: "lazy", fail: new Set(["bad"]) });
    const set = new DerivedSet(s.sql, s.txn, log, [lazy.def], { label: () => "col_x" });
    land(s, log, set, "a", "bad", "c");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      // The slice rolls back and is applied one landing at a time; the bad one is skipped, the others applied once.
      expect(set.catchUp("toy_lazy")).toMatchObject({ applied: 3, behind: 0 });
      expect(lazy.applied()).toEqual({ 1: 1, 3: 1 });
      expect(JSON.parse(String(error.mock.calls[0]![0]))).toEqual({ ft: "derived", index: "toy_lazy", colonyId: "col_x", skipped: 2, error: "cannot apply bad" });

      // In the hook an eager index that throws is left behind; the landing is recorded all the same.
      const fail = new Set(["boom"]);
      const eager = toy(s.sql, { mode: "eager", fail, adopt: true });
      set.define(eager.def);
      expect(land(s, log, set, "d", "boom", "e")).toEqual([[], ["toy_eager"], ["toy_eager"]]);
      expect(log.head()).toBe(6);
      expect(cursors(s.sql).toy_eager!.seq).toBe(4);
      // Its catch-up applies them in order once it can. The failed attempt's write stayed (the hook cannot roll back one
      // index inside the landing's transaction), so landing 5 is applied twice: why apply must be idempotent per landing.
      fail.clear();
      expect(set.catchUp("toy_eager")).toMatchObject({ applied: 2, behind: 0 });
      expect(eager.applied()).toEqual({ 4: 1, 5: 2, 6: 1 });
      expect(cursors(s.sql).toy_eager!.seq).toBe(6);

      // A log that cannot be read ends the catch-up with the error; nothing throws.
      land(s, log, set, "f");
      log.broken = true;
      expect(set.catchUp("toy_lazy")).toMatchObject({ applied: 0, behind: 4, error: "log unreadable" });
      log.broken = false;
      expect(set.catchUp("toy_lazy")).toMatchObject({ applied: 4, behind: 0 });
    } finally {
      error.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// The trunk writer's log, and the indexes migrated onto the mechanism
// ---------------------------------------------------------------------------

const hex = (n: number): string => n.toString(16).padStart(40, "0");

/** TrunkDO's landing tables. */
function trunkTables(db: DatabaseSync): void {
  db.exec("CREATE TABLE ft_files (path TEXT PRIMARY KEY, blob TEXT NOT NULL, size INTEGER NOT NULL, mode TEXT NOT NULL)");
  db.exec("CREATE TABLE ft_landings (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, trunk_sha TEXT NOT NULL, parent_sha TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL)");
  db.exec("CREATE TABLE ft_notes (landing_id TEXT PRIMARY KEY, commit_sha TEXT NOT NULL, note TEXT NOT NULL)");
}

describe("the trunk writer's landing log (trunkLog)", () => {
  it("reads ft_landings in order with each note, and keeps a record it cannot parse as its row's fields", () => {
    const s = storage();
    trunkTables(s.db);
    const landing: Landing = { id: "lnd_1", colonyId: "c", trunkSha: hex(2), parentSha: hex(1), proposalIds: ["prp_1"], intentIds: ["int_1"], paths: ["a.ts"], regions: ["root"], at: 10 };
    s.db.prepare("INSERT INTO ft_landings (id, trunk_sha, parent_sha, at, data) VALUES (?, ?, ?, ?, ?)").run("lnd_1", hex(2), hex(1), 10, JSON.stringify(landing));
    s.db.prepare("INSERT INTO ft_notes (landing_id, commit_sha, note) VALUES (?, ?, ?)").run("lnd_1", hex(2), '{"proposals":[]}');
    s.db.prepare("INSERT INTO ft_landings (id, trunk_sha, parent_sha, at, data) VALUES (?, ?, ?, ?, ?)").run("lnd_2", hex(3), hex(2), 20, "not json");
    const log = trunkLog(s.sql);
    expect(log.after(0, 10)).toEqual([
      { seq: 1, landing: { landing, note: '{"proposals":[]}' } },
      { seq: 2, landing: { landing: { id: "lnd_2", colonyId: "", trunkSha: hex(3), parentSha: hex(2), proposalIds: [], intentIds: [], paths: [], regions: [], at: 20 }, note: null } },
    ]);
    expect(log.after(1, 10).map((e) => e.seq)).toEqual([2]);
    expect([log.head(), log.before(2), log.before(1), log.count(0), log.count(2)]).toEqual([2, 1, 0, 2, 0]);
    expect(recordedLanding({ id: "x", data: '{"paths":["a",3,""],"at":"soon"}', at: 5 })).toMatchObject({ id: "x", paths: ["a"], at: 5, trunkSha: "" });
  });
});

/**
 * Trunk as TrunkDO keeps it for the import index, with the landing hook: each landing changes ft_files,
 * is recorded in ft_landings and goes through DerivedSet.landed in one transaction, as in finalizeRows.
 */
class Trunk {
  readonly s = storage();
  readonly index = new ImportIndex(this.s.sql, this.s.txn);
  set: DerivedSet<TrunkLanding>;
  head = hex(1);
  reads: string[] = [];
  private readonly texts = new Map<string, string>();
  private n = 100;

  constructor(files: Record<string, string>) {
    trunkTables(this.s.db);
    this.set = new DerivedSet(this.s.sql, this.s.txn, trunkLog(this.s.sql), [importsDerived(this.s.sql)]);
    for (const [path, text] of Object.entries(files)) this.put(path, text);
  }

  blob(path: string): string | null {
    return this.s.sql.exec<{ blob: string }>("SELECT blob FROM ft_files WHERE path = ?", path).toArray()[0]?.blob ?? null;
  }

  /** A landing through the hook (content null deletes). */
  land(changes: Record<string, string | null>): void {
    const parent = this.head;
    this.head = hex(++this.n);
    this.s.txn(() => {
      const staged = Object.entries(changes).map(([path, text]) => {
        const before = this.blob(path);
        const blob = text === null ? null : this.put(path, text);
        if (text === null) this.s.sql.exec("DELETE FROM ft_files WHERE path = ?", path);
        return [path, { blob, before }] as const;
      });
      const landing: Landing = { id: `lnd_${this.n}`, colonyId: "c", trunkSha: this.head, parentSha: parent, proposalIds: [], intentIds: [], paths: Object.keys(changes).sort(), regions: [], at: this.n };
      const seq = this.s.sql.exec<{ seq: number }>("INSERT INTO ft_landings (id, trunk_sha, parent_sha, at, data) VALUES (?, ?, ?, ?, ?) RETURNING seq", landing.id, landing.trunkSha, landing.parentSha, landing.at, JSON.stringify(landing)).one().seq;
      this.set.landed({ seq, landing: { landing, note: null, changes: staged } });
    });
  }

  sync() {
    const source: ImportSource = {
      head: () => this.head,
      read: async (blob) => {
        this.reads.push(blob);
        const text = this.texts.get(blob);
        return text === undefined ? null : new TextEncoder().encode(text);
      },
    };
    return this.index.sync(source);
  }

  dirty(): Array<{ path: string; moved: number }> {
    return this.s.db.prepare("SELECT path, moved FROM ft_imp_dirty ORDER BY path").all() as Array<{ path: string; moved: number }>;
  }

  private put(path: string, text: string): string {
    const blob = hex(this.n++ * 1000);
    this.texts.set(blob, text);
    this.s.sql.exec("INSERT OR REPLACE INTO ft_files (path, blob, size, mode) VALUES (?, ?, ?, ?)", path, blob, text.length, "100644");
    return blob;
  }
}

const imports = (...specs: string[]): string => specs.map((s, i) => `import { x${i} } from "${s}";\n`).join("");

describe("the import index as a derived index (eager)", () => {
  it("marks each landing in the hook as markLanded did, and the next sync reads only those files", async () => {
    const t = new Trunk({ "src/a.ts": imports("./x"), "src/x.ts": "", "src/y.ts": "", "docs/r.md": "" });
    // Before the first build there is nothing to mark, but the cursor moves.
    t.land({ "src/a.ts": imports("./y") });
    expect(t.index.stats()).toMatchObject({ sha: null, pending: 0 });
    await t.sync();
    expect(t.index.links(["src/a.ts"])["src/a.ts"]!.imports).toEqual(["src/y.ts"]);
    t.land({ "src/a.ts": imports("./x"), "docs/r.md": "changed", "src/new.ts": imports("./a") });
    expect(t.dirty()).toEqual([
      { path: "src/a.ts", moved: 0 },
      { path: "src/new.ts", moved: 1 },
    ]);
    t.reads = [];
    expect(await t.sync()).toMatchObject({ read: 2, pending: 0 });
    expect(t.reads.sort()).toEqual([t.blob("src/a.ts"), t.blob("src/new.ts")].sort());
    expect(t.index.links(["src/a.ts"])["src/a.ts"]).toEqual({ imports: ["src/x.ts"], importers: ["src/new.ts"] });
    expect(t.set.status()).toEqual([{ name: IMPORTS_INDEX, mode: "eager", version: 1, stored: 1, seq: 2, head: 2, behind: 0 }]);
  });

  it("resumes at the newest landing when it kept no cursor, replays a landing the hook left behind without blobs, and forgets itself on a version change", async () => {
    const t = new Trunk({ "src/a.ts": imports("./x"), "src/x.ts": "", "src/y.ts": "" });
    await t.sync();
    // An index built before cursors existed (no row): the first landing adopts it and marks as before.
    t.land({ "src/a.ts": imports("./y") });
    expect(t.dirty()).toEqual([{ path: "src/a.ts", moved: 0 }]);
    await t.sync();
    // A landing the hook left behind (its cursor written back) is marked again from the log: every path as moved.
    t.s.sql.exec("UPDATE ft_derived SET seq = 0 WHERE name = ?", IMPORTS_INDEX);
    t.s.sql.exec("INSERT OR REPLACE INTO ft_imp_meta (key, value) VALUES ('sha', ?)", hex(1));
    expect(t.set.catchUp(IMPORTS_INDEX)).toMatchObject({ applied: 1, behind: 0 });
    expect(t.dirty()).toEqual([{ path: "src/a.ts", moved: 1 }]);
    expect(await t.sync()).toMatchObject({ pending: 0 });
    expect(t.index.links(["src/a.ts"])["src/a.ts"]!.imports).toEqual(["src/y.ts"]);
    // A new version forgets the index; nothing is replayed, and the next sync builds it from the trunk index.
    t.set.define({ ...importsDerived(t.s.sql), version: 2 });
    expect(t.set.catchUp(IMPORTS_INDEX)).toMatchObject({ rebuilt: true, behind: 0 });
    expect(t.index.stats()).toMatchObject({ files: 0, sha: null });
    t.reads = [];
    expect(await t.sync()).toMatchObject({ read: 3, pending: 0 });
    expect(t.index.links(["src/y.ts"])).toEqual({ "src/y.ts": { imports: [], importers: ["src/a.ts"] } });
  });
});

/** Record a landing with one proposal per write set, as finalizeRows does (cochange.test.ts's helper). */
function addLanding(db: DatabaseSync, id: string, proposals: Array<{ paths: string[]; intent: string }>): void {
  const note = {
    schema: "firetrident.lineage/v1",
    landingId: id,
    colonyId: "c",
    proposals: proposals.map((p, i) => ({ id: `${id}-p${i}`, agentId: "agt", agentKind: "internal", intent: { id: p.intent, title: "t", why: "w" }, writeSet: p.paths.map((path) => ({ path, blob: hex(7) })), readSet: [], decisions: [], evidence: { checks: [] } })),
  };
  db.prepare("INSERT INTO ft_landings (id, trunk_sha, parent_sha, at, data) VALUES (?, ?, ?, ?, ?)").run(id, hex(1), hex(2), 0, "{}");
  db.prepare("INSERT INTO ft_notes (landing_id, commit_sha, note) VALUES (?, ?, ?)").run(id, hex(1), JSON.stringify(note));
}

describe("the co-change map as a derived index (lazy)", () => {
  it("resumes from the watermark of a map kept before cursors existed, and learns each landing once", () => {
    const s = storage();
    trunkTables(s.db);
    const cc = new CoChangeStore(s.sql, s.txn);
    addLanding(s.db, "l1", [{ paths: ["a.ts", "b.ts"], intent: "int_1" }]);
    addLanding(s.db, "l2", [{ paths: ["c.ts", "d.ts"], intent: "int_2" }]);
    // The map learned l1 before cursors existed: only l2 is new.
    s.sql.exec("INSERT INTO ft_cc_meta (key, value) VALUES ('landing_seq', '1')");
    expect(cc.catchUp()).toBe(1);
    expect(cc.file("a.ts")).toBeUndefined();
    expect(cc.stats()).toMatchObject({ landingSeq: 2, proposalsLearned: 1 });
    expect(cursors(s.sql)[COCHANGE_INDEX]).toEqual({ version: 1, seq: 2 });
    // A cursor written back (a store on older code learned meanwhile) never learns a landing twice.
    const before = cc.edge("c.ts", "d.ts");
    s.sql.exec("UPDATE ft_derived SET seq = 0");
    expect(cc.catchUp()).toBe(0);
    expect(cc.edge("c.ts", "d.ts")).toEqual(before);
    // After a restart it goes on from its cursor.
    addLanding(s.db, "l3", [{ paths: ["e.ts", "f.ts"], intent: "int_3" }]);
    expect(new CoChangeStore(s.sql, s.txn).catchUp()).toBe(1);
    expect(cc.stats()).toMatchObject({ landingSeq: 3, proposalsLearned: 2 });
  });

  it("on a version change forgets the map, its mining included, and learns the landings again only on a later read", () => {
    const s = storage();
    trunkTables(s.db);
    const cc = new CoChangeStore(s.sql, s.txn);
    cc.learnHistory({ commits: [{ sha: hex(9), at: 0, author: "a", paths: ["x.ts", "y.ts"] }], listed: 1, skipped: 0, truncated: false, reads: 0 }, hex(9), 1);
    addLanding(s.db, "l1", [{ paths: ["a.ts", "b.ts"], intent: "int_1" }]);
    expect(cc.catchUp()).toBe(1);
    s.sql.exec("UPDATE ft_derived SET version = 0 WHERE name = ?", COCHANGE_INDEX);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      // TrunkDO mines again (shouldMine) before its next read learns landings (neighbors waits for mining).
      expect(cc.catchUp()).toBe(0);
    } finally {
      log.mockRestore();
    }
    expect(cc.stats()).toMatchObject({ files: 0, edges: 0, intents: 0, mined: { state: null }, landingSeq: 0 });
    expect(cc.shouldMine(0)).toBe(true);
    cc.learnHistory({ commits: [], listed: 0, skipped: 0, truncated: false, reads: 0 }, hex(9), 2);
    expect(cc.catchUp()).toBe(1);
    expect(cc.neighbors(["a.ts"], 8)["a.ts"]!.map((n) => n.path)).toEqual(["b.ts"]);
    // reset() forgets the cursor with the map.
    cc.reset();
    expect(cursors(s.sql)[COCHANGE_INDEX]).toEqual({ version: 1, seq: 0 });
  });
});
