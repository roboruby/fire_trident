import { describe, expect, it } from "vitest";
import { CoChangeGraph, followUps } from "@fire_trident/core";
import {
  CoChangeStore,
  NEIGHBOR_PATHS_MAX,
  NeighborCache,
  claimLookup,
  diffTreePaths,
  mineHistory,
  noteChanges,
  type MineResult,
  type Neighbor,
} from "../../src/trunk/cochange.ts";

/** The part of node:sqlite these tests use (the worker compiles against workers types, not Node's). */
interface DatabaseSync {
  prepare(sql: string): { all(...params: unknown[]): unknown[]; run(...params: unknown[]): unknown };
  exec(sql: string): void;
}
const SQLITE = "node:sqlite";
const { DatabaseSync } = (await import(SQLITE)) as { DatabaseSync: new (path: string) => DatabaseSync };

/** SqlStorage over node:sqlite (the subset CoChangeStore uses), plus a transaction runner. */
function storage(): { sql: SqlStorage; txn: (fn: () => void) => void; db: DatabaseSync } {
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
  // TrunkDO's own tables that the landing catch-up reads.
  db.exec("CREATE TABLE ft_landings (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, trunk_sha TEXT NOT NULL, parent_sha TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL)");
  db.exec("CREATE TABLE ft_notes (landing_id TEXT PRIMARY KEY, commit_sha TEXT NOT NULL, note TEXT NOT NULL)");
  return { sql, txn, db };
}

function store(): { cc: CoChangeStore; db: DatabaseSync } {
  const s = storage();
  return { cc: new CoChangeStore(s.sql, s.txn), db: s.db };
}

const SHA = (n: number): string => n.toString(16).padStart(40, "0");

function mined(commits: Array<{ paths: string[]; author?: string; at?: number }>, truncated = false): MineResult {
  return {
    commits: commits.map((c, i) => ({ sha: SHA(i + 1), at: c.at ?? i * 60_000, author: c.author ?? "dev@example.com", paths: c.paths })),
    listed: commits.length,
    skipped: 0,
    truncated,
    reads: 0,
  };
}

/** Record a landing with one proposal per write set, as TrunkDO's finalizeRows does. */
function addLanding(db: DatabaseSync, id: string, proposals: Array<{ paths: string[]; intent: string; parent?: string }>): void {
  const note = {
    schema: "firetrident.lineage/v1",
    landingId: id,
    colonyId: "c",
    proposals: proposals.map((p, i) => ({
      id: `${id}-p${i}`,
      agentId: "agt",
      agentKind: "internal",
      intent: { id: p.intent, title: "t", why: "w", ...(p.parent ? { parentId: p.parent } : {}) },
      writeSet: p.paths.map((path) => ({ path, blob: SHA(7) })),
      readSet: [],
      decisions: [],
      evidence: { checks: [] },
    })),
  };
  db.prepare("INSERT INTO ft_landings (id, trunk_sha, parent_sha, at, data) VALUES (?, ?, ?, ?, ?)").run(id, SHA(1), SHA(2), 0, "{}");
  db.prepare("INSERT INTO ft_notes (landing_id, commit_sha, note) VALUES (?, ?, ?)").run(id, SHA(1), JSON.stringify(note));
}

describe("CoChangeStore", () => {
  it("learns exactly what the in-memory graph learns", () => {
    const { cc } = store();
    const g = new CoChangeGraph();
    const history = Array.from({ length: 60 }, (_, i) => ({
      paths: [`src/f${i % 7}.ts`, `src/f${(i * 3) % 5}.ts`, ...(i % 4 === 0 ? [`test/t${i % 3}.ts`] : [])],
      author: i % 3 === 0 ? "a@x" : "b@x",
      at: i * 3_600_000,
    }));
    const preds = followUps(history);
    history.forEach((c, i) => {
      g.learn(c.paths, preds[i] ?? []);
    });
    cc.learnHistory(mined(history), SHA(99), 1);
    for (const f of g.paths()) {
      const want = g.neighbors(f, 8, 0.1);
      const got = cc.neighbors([f], 8, 0.1)[f] ?? [];
      expect(got.map((n) => n.path)).toEqual(want.map((n) => n.path));
      got.forEach((n, i) => expect(n.weight).toBeCloseTo(want[i]!.weight, 12));
    }
    expect(cc.stats()).toMatchObject({ files: g.stats().files, edges: g.stats().edges, mined: { state: "done", head: SHA(99), commits: 60, at: 1 } });
  });

  it("marks partial mining and reports when to mine again", () => {
    const { cc } = store();
    expect(cc.shouldMine(0)).toBe(true);
    cc.learnHistory(mined([{ paths: ["a", "b"] }], true), SHA(1), 5);
    expect(cc.minedState()).toBe("partial");
    expect(cc.shouldMine(10 ** 12)).toBe(false);
    const fresh = store().cc;
    fresh.markMined("failed: boom", 1_000);
    expect(fresh.shouldMine(1_000 + 60_000)).toBe(false);
    expect(fresh.shouldMine(1_000 + 11 * 60_000)).toBe(true);
  });

  it("learns landings one proposal at a time from their notes, with STDP from parent intents", () => {
    const { cc, db } = store();
    cc.learnHistory(mined([]), SHA(1), 0);
    addLanding(db, "l1", [
      { paths: ["src/a.ts", "src/b.ts"], intent: "int_1" },
      { paths: ["docs/x.md", ".firetrident/antibodies/x.json"], intent: "int_2" },
    ]);
    addLanding(db, "l2", [{ paths: ["src/c.ts"], intent: "int_3", parent: "int_1" }]);
    expect(cc.catchUp()).toBe(3);
    expect(cc.catchUp()).toBe(0);
    // Same proposal: wired. Same landing, different proposals: not wired. System paths: never learned.
    expect(cc.neighbors(["src/a.ts"], 8)["src/a.ts"]!.map((n) => n.path)).toContain("src/b.ts");
    expect(cc.edge("src/a.ts", "docs/x.md")).toBeUndefined();
    expect(cc.file(".firetrident/antibodies/x.json")).toBeUndefined();
    // The follow-up intent's change follows its parent's: a -> c and b -> c potentiated, c -> a depressed.
    expect(cc.edge("src/a.ts", "src/c.ts")!.stdp).toBeGreaterThan(0);
    expect(cc.edge("src/c.ts", "src/a.ts")!.stdp).toBeLessThan(0);
    // A claim on a.ts repels work on c.ts (c follows a); the reverse has no positive evidence.
    expect(cc.neighbors(["src/c.ts"], 8)["src/c.ts"]!.map((n) => n.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(cc.neighbors(["src/a.ts"], 8)["src/a.ts"]!.map((n) => n.path)).toEqual(["src/b.ts"]);
    expect(cc.stats()).toMatchObject({ landingSeq: 2, proposalsLearned: 3, intents: 3 });
  });

  it("catches up in steps of about 400 proposals, finishing the landing it is in", () => {
    const { cc, db } = store();
    for (let l = 0; l < 5; l++) {
      addLanding(
        db,
        `l${l}`,
        Array.from({ length: 150 }, (_, i) => ({ paths: [`p${l}/f${i}.ts`, `p${l}/g${i}.ts`], intent: `i${l}-${i}` })),
      );
    }
    expect(cc.catchUp()).toBe(450);
    expect(cc.stats().landingSeq).toBe(3);
    expect(cc.catchUp()).toBe(300);
    expect(cc.catchUp()).toBe(0);
  });

  it("answers at most k neighbors per path, skips unknown paths, and bounds the request", () => {
    const { cc } = store();
    cc.learnHistory(mined(Array.from({ length: 5 }, () => ({ paths: ["hub", "a", "b", "c", "d", "e"] }))), SHA(1), 0);
    const out = cc.neighbors(["hub", "nobody", "", "hub"], 3);
    expect(Object.keys(out)).toEqual(["hub"]);
    expect(out["hub"]).toHaveLength(3);
    const many = Array.from({ length: NEIGHBOR_PATHS_MAX + 10 }, (_, i) => `x${i}`);
    expect(cc.neighbors([...many, "hub"], 3)).toEqual({});
    expect(cc.neighbors(["hub"], 1000)["hub"]).toHaveLength(5);
  });

  it("forgets everything on reset", () => {
    const { cc } = store();
    cc.learnHistory(mined([{ paths: ["a", "b"] }]), SHA(1), 0);
    cc.reset();
    expect(cc.stats()).toMatchObject({ files: 0, edges: 0, intents: 0, mined: { state: null, head: null, commits: 0, at: null }, landingSeq: 0 });
    expect(cc.shouldMine(0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Mining through the binding
// ---------------------------------------------------------------------------

/** A tiny content-addressed tree store: identical subtrees share a hash, as in git. */
class Trees {
  readonly trees = new Map<string, ArtifactsTreeEntry[]>();
  private readonly ids = new Map<string, string>();
  reads = 0;

  /** Root tree hash for `files` (path -> blob hash). */
  build(files: Record<string, string>): string {
    const root: Record<string, unknown> = {};
    for (const [path, blob] of Object.entries(files)) {
      const parts = path.split("/");
      let node = root;
      for (const dir of parts.slice(0, -1)) node = (node[dir] ??= {}) as Record<string, unknown>;
      node[parts.at(-1)!] = blob;
    }
    return this.write(root);
  }

  private write(node: Record<string, unknown>): string {
    const entries: ArtifactsTreeEntry[] = Object.keys(node)
      .sort()
      .map((name) => {
        const v = node[name];
        return typeof v === "string" ? { name, mode: "100644", hash: v, type: "blob" as const } : { name, mode: "40000", hash: this.write(v as Record<string, unknown>), type: "tree" as const };
      });
    const key = JSON.stringify(entries);
    let id = this.ids.get(key);
    if (!id) {
      id = `t${String(this.ids.size).padStart(39, "0")}`;
      this.ids.set(key, id);
      this.trees.set(id, entries);
    }
    return id;
  }

  read = async (hash: string): Promise<ArtifactsTreeEntry[] | null> => {
    this.reads++;
    return this.trees.get(hash) ?? null;
  };
}

describe("diffTreePaths", () => {
  it("lists added, removed and changed files, descending only into changed subtrees", async () => {
    const t = new Trees();
    const a = t.build({ "src/a.ts": "1", "src/lib/b.ts": "2", "src/lib/c.ts": "3", "docs/x.md": "4", "keep/k.ts": "5" });
    const b = t.build({ "src/a.ts": "1x", "src/lib/b.ts": "2", "src/new/d.ts": "6", "docs/x.md": "4", "keep/k.ts": "5" });
    expect(await diffTreePaths(t.read, a, b, 30)).toEqual(["src/a.ts", "src/lib/c.ts", "src/new/d.ts"]);
    expect(await diffTreePaths(t.read, a, a, 30)).toEqual([]);
    expect(await diffTreePaths(t.read, null, t.build({ "x/y.ts": "1" }), 30)).toEqual(["x/y.ts"]);
  });

  it("is null for a mass edit or a missing tree", async () => {
    const t = new Trees();
    const files = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i}.ts`, String(i)]));
    const a = t.build(files);
    const b = t.build(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, `${v}x`])));
    expect(await diffTreePaths(t.read, a, b, 10)).toBeNull();
    expect(await diffTreePaths(t.read, a, b, 12)).toHaveLength(12);
    expect(await diffTreePaths(t.read, a, "f".repeat(40), 30)).toBeNull();
  });

  it("treats a file replaced by a directory as both", async () => {
    const t = new Trees();
    const a = t.build({ "x": "1" });
    const b = t.build({ "x/y.ts": "2" });
    expect(await diffTreePaths(t.read, a, b, 30)).toEqual(["x", "x/y.ts"]);
  });
});

describe("mineHistory", () => {
  /** A first-parent chain built from file snapshots, newest first like the binding's log. */
  function repoOf(snapshots: Array<{ files: Record<string, string>; email: string; at: number; message?: string; merge?: boolean }>, opts: { orphanParent?: boolean } = {}) {
    const t = new Trees();
    const commits = snapshots.map((s, i) => ({
      hash: SHA(1000 + i),
      treeHash: t.build(s.files),
      message: s.message ?? `change ${i}`,
      author: { name: "dev", email: s.email },
      committer: { name: "dev", email: s.email },
      parents: i === 0 ? (opts.orphanParent ? [SHA(5)] : []) : s.merge ? [SHA(1000 + i - 1), SHA(4242)] : [SHA(1000 + i - 1)],
      authoredAt: s.at,
      committedAt: s.at,
    }));
    const byHash = new Map(commits.map((c) => [c.hash, c]));
    const repo = {
      log: async (o: { ref?: string; limit?: number }) => [...commits].reverse().slice(0, o.limit ?? 50),
      readTree: (h: string) => t.read(h),
      readCommit: async (h: string) => (h === SHA(5) ? { ...commits[0]!, hash: SHA(5), treeHash: t.build({}) } : (byHash.get(h) ?? null)),
    } as unknown as ArtifactsRepo;
    return { repo, head: commits.at(-1)!.hash, trees: t };
  }

  it("returns the changed paths of each single-parent commit, oldest first", async () => {
    const { repo, head } = repoOf([
      { files: { "a.ts": "1", "b.ts": "1" }, email: "x@y", at: 100 },
      { files: { "a.ts": "2", "b.ts": "2" }, email: "x@y", at: 200 },
      { files: { "a.ts": "2", "b.ts": "2", "c.ts": "1" }, email: "z@y", at: 300 },
      { files: { "a.ts": "3", "b.ts": "2", "c.ts": "1" }, email: "z@y", at: 400, merge: true },
      { files: { "a.ts": "4", "b.ts": "2", "c.ts": "1" }, email: "z@y", at: 500, message: "Land 1 change: x\n\nFT-Landing: lnd_1" },
      { files: { "a.ts": "4", "b.ts": "3", "c.ts": "2" }, email: "x@y", at: 600 },
    ]);
    const res = await mineHistory(repo, head, { limit: 200 });
    expect(res.commits.map((c) => c.paths)).toEqual([["a.ts", "b.ts"], ["c.ts"], ["b.ts", "c.ts"]]);
    expect(res.commits.map((c) => [c.author, c.at])).toEqual([
      ["x@y", 200_000],
      ["z@y", 300_000],
      ["x@y", 600_000],
    ]);
    // The root, the merge and the FireTrident landing are skipped.
    expect(res).toMatchObject({ listed: 6, skipped: 3, truncated: false });
  });

  it("reads the parent of the oldest listed commit through readCommit", async () => {
    const { repo, head } = repoOf(
      [
        { files: { "a.ts": "1" }, email: "x@y", at: 1 },
        { files: { "a.ts": "2", "b.ts": "1" }, email: "x@y", at: 2 },
      ],
      { orphanParent: true },
    );
    const res = await mineHistory(repo, head, { limit: 200 });
    expect(res.commits.map((c) => c.paths)).toEqual([["a.ts"], ["a.ts", "b.ts"]]);
  });

  it("keeps what it read when the budget runs out", async () => {
    const snaps = Array.from({ length: 40 }, (_, i) => ({ files: { [`f${i}.ts`]: "1", "base.ts": String(i) }, email: "x@y", at: i }));
    const { repo, head } = repoOf(snaps);
    let clock = 0;
    const res = await mineHistory(repo, head, { limit: 200, budgetMs: 10, concurrency: 1, now: () => (clock += 1) });
    expect(res.truncated).toBe(true);
    expect(res.commits.length).toBeGreaterThan(0);
    expect(res.commits.length).toBeLessThan(39);
    // Newest commits are mined first, so what is kept is the most recent history, oldest first.
    expect(res.commits.at(-1)!.paths).toContain("f39.ts");
  });
});

describe("noteChanges", () => {
  it("lists each proposal's write paths with its intent and parent", () => {
    const note = JSON.stringify({
      proposals: [
        { writeSet: [{ path: "a.ts" }, { path: ".firetrident/x" }, { path: "" }, { path: 3 }], intent: { id: "i1", parentId: "i0" } },
        { writeSet: [{ path: ".firetrident/only" }], intent: { id: "i2" } },
        { writeSet: "nope", intent: {} },
        { writeSet: [{ path: "b.ts" }] },
      ],
    });
    expect(noteChanges(note)).toEqual([
      { intentId: "i1", parentId: "i0", paths: ["a.ts"] },
      { intentId: null, parentId: null, paths: ["b.ts"] },
    ]);
    expect(noteChanges("not json")).toEqual([]);
    expect(noteChanges("{}")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The caller's side
// ---------------------------------------------------------------------------

describe("NeighborCache", () => {
  const nb = (path: string, weight = 0.5): Neighbor[] => [{ path, weight }];

  it("fetches misses once, caches hits and misses, and skips directory and glob entries", async () => {
    const calls: string[][] = [];
    const cache = new NeighborCache(async (paths) => {
      calls.push(paths);
      return { "a.ts": nb("b.ts") };
    });
    const first = await cache.get(["a.ts", "c.ts", "src/", "src/*.ts", "a.ts"], 0, 1_000);
    expect([...first]).toEqual([["a.ts", nb("b.ts")]]);
    expect(calls).toEqual([["a.ts", "c.ts"]]);
    const second = await cache.get(["c.ts", "a.ts"], 1, 1_000);
    expect(second.get("a.ts")).toEqual(nb("b.ts"));
    expect(calls).toHaveLength(1);
    expect(cache.size).toBe(2);
  });

  it("shares an in-flight fetch between concurrent takes", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const cache = new NeighborCache(async () => {
      calls++;
      await gate;
      return { "a.ts": nb("b.ts") };
    });
    const p1 = cache.get(["a.ts"], 0, 1_000);
    const p2 = cache.get(["a.ts"], 0, 1_000);
    release();
    expect((await p1).get("a.ts")).toEqual(nb("b.ts"));
    expect((await p2).get("a.ts")).toEqual(nb("b.ts"));
    expect(calls).toBe(1);
  });

  it("waits at most waitMs, then answers from what has arrived (later takes see the rest)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const cache = new NeighborCache(async () => {
      await gate;
      return { "a.ts": nb("b.ts") };
    });
    const t0 = Date.now();
    const early = await cache.get(["a.ts"], t0, 30);
    expect(early.size).toBe(0);
    expect(Date.now() - t0).toBeLessThan(500);
    release();
    await new Promise((r) => setTimeout(r, 10));
    expect((await cache.get(["a.ts"], Date.now(), 0)).get("a.ts")).toEqual(nb("b.ts"));
  });

  it("asks again sooner for paths that had no neighbors", async () => {
    let fetches = 0;
    const cache = new NeighborCache(async (): Promise<Record<string, Neighbor[]>> => (++fetches === 1 ? {} : { "a.ts": nb("b.ts") }), { ttlMs: 60_000, emptyTtlMs: 20 });
    expect((await cache.get(["a.ts"], Date.now(), 1_000)).size).toBe(0);
    await new Promise((r) => setTimeout(r, 30));
    expect((await cache.get(["a.ts"], Date.now(), 1_000)).get("a.ts")).toEqual(nb("b.ts"));
    expect(fetches).toBe(2);
  });

  it("backs off after a failure and expires entries after the ttl", async () => {
    let fail = true;
    let calls = 0;
    const cache = new NeighborCache(
      async () => {
        calls++;
        if (fail) throw new Error("no such method");
        return { "a.ts": nb("b.ts") };
      },
      { ttlMs: 50, failMs: 60_000 },
    );
    expect((await cache.get(["a.ts"], Date.now(), 1_000)).size).toBe(0);
    fail = false;
    expect((await cache.get(["a.ts"], Date.now(), 1_000)).size).toBe(0);
    expect(calls).toBe(1);
    // Within the ttl the cached answer stands; after it the path is fetched again.
    let fetches = 0;
    const healthy = new NeighborCache(async (): Promise<Record<string, Neighbor[]>> => (++fetches === 1 ? { "a.ts": nb("b.ts") } : {}), { ttlMs: 50 });
    await healthy.get(["a.ts"], Date.now(), 1_000);
    expect((await healthy.get(["a.ts"], Date.now(), 1_000)).get("a.ts")).toEqual(nb("b.ts"));
    expect(fetches).toBe(1);
    await new Promise((r) => setTimeout(r, 60));
    expect((await healthy.get(["a.ts"], Date.now(), 1_000)).size).toBe(0);
    expect(fetches).toBe(2);
  });
});

describe("claimLookup", () => {
  it("sums reading claims and unseen claims on exact paths, and checks directory and glob claims by overlap", () => {
    const views = new Map([
      [
        "src",
        {
          byPath: { "src/a.ts": { claim: 0.9, danger: 2 }, "src/lib/": { claim: 0.5 }, "src/zero.ts": { claim: 0 } },
          unseen: [{ paths: new Set(["src/a.ts", "src/b.ts"]) }, { paths: new Set(["src/*.md"]) }],
        },
      ],
    ]);
    const claimOn = claimLookup(views, (p) => p.split("/")[0]!, 1);
    expect(claimOn("src/a.ts")).toBeCloseTo(1.9, 12);
    expect(claimOn("src/b.ts")).toBe(1);
    expect(claimOn("src/lib/x.ts")).toBeCloseTo(0.5, 12);
    expect(claimOn("src/readme.md")).toBe(1);
    expect(claimOn("src/zero.ts")).toBe(0);
    expect(claimOn("docs/x.md")).toBe(0);
  });
});
