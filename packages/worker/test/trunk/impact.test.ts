import { describe, expect, it } from "vitest";
import { ImportIndex, type ImportSource } from "../../src/trunk/imports.ts";
import { IMPACT_FILES, expandEntries, importerWalk, walkImporters, type ImportersOf, type TrunkFiles } from "../../src/trunk/impact.ts";

/**
 * Impact through imports (trunk/impact.ts): the trunk files that import a path, level by level, from the trunk writer's
 * import index, bounded in levels and files, with the file each imports on the way; directories and globs name the
 * trunk files they cover; and a read that does not wait long for the index, saying when it was not current.
 */

/** The part of node:sqlite these tests use (the worker compiles against workers types, not Node's). */
interface DatabaseSync {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  exec(sql: string): void;
}
const SQLITE = "node:sqlite";
const { DatabaseSync } = (await import(SQLITE)) as { DatabaseSync: new (path: string) => DatabaseSync };

/** Trunk as TrunkDO keeps it for the index (the ft_files table and blob contents), with an import index over it. */
class Trunk {
  readonly sql: SqlStorage;
  readonly index: ImportIndex;
  head = "c1";
  /** A read that never answers, when set (a stuck or slow first build). */
  stall = false;
  private readonly texts = new Map<string, string>();
  private readonly db = new DatabaseSync(":memory:");
  private n = 0;

  constructor(files: Record<string, string>) {
    const db = this.db;
    this.sql = {
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
    db.exec("CREATE TABLE ft_files (path TEXT PRIMARY KEY, blob TEXT NOT NULL, size INTEGER NOT NULL, mode TEXT NOT NULL)");
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
    this.index = new ImportIndex(this.sql, txn);
    for (const [path, text] of Object.entries(files)) {
      const id = (++this.n).toString(16).padStart(40, "0");
      this.texts.set(id, text);
      this.sql.exec("INSERT INTO ft_files (path, blob, size, mode) VALUES (?, ?, ?, '100644')", path, id, text.length);
    }
  }

  source(): ImportSource {
    return {
      head: () => this.head,
      read: (blob) => (this.stall ? new Promise<Uint8Array | null>(() => undefined) : Promise.resolve(this.texts.has(blob) ? new TextEncoder().encode(this.texts.get(blob)) : null)),
    };
  }

  files(): TrunkFiles {
    return {
      has: (path) => this.sql.exec("SELECT 1 AS x FROM ft_files WHERE path = ?", path).toArray().length > 0,
      range: (from, to, limit) => (this.sql.exec("SELECT path FROM ft_files WHERE path >= ? AND path < ? ORDER BY path LIMIT ?", from, to, limit).toArray() as Array<{ path: string }>).map((r) => r.path),
    };
  }

  walk(entries: string[], opts: { depth?: number; max?: number; waitMs?: number } = {}) {
    return importerWalk(this.index, this.source(), this.files(), entries, opts);
  }
}

/** A chain util <- a <- b <- c <- d, a test of a, a sibling that imports util twice over, and files nothing imports. */
const CHAIN: Record<string, string> = {
  "src/util.ts": "export const one = 1;\n",
  "src/a.ts": 'import { one } from "./util.ts";\nexport const a = one;\n',
  "src/b.ts": 'import { a } from "./a.ts";\nexport const b = a;\n',
  "src/c.ts": 'import { b } from "./b";\nexport const c = b;\n',
  "src/d.ts": 'import { c } from "./c.js";\nexport const d = c;\n',
  "src/both.ts": 'import { one } from "./util.ts";\nimport { a } from "./a.ts";\nexport const both = one + a;\n',
  "test/a.test.ts": 'import { a } from "../src/a.ts";\nvoid a;\n',
  "lib/x/index.ts": 'export * from "../../src/util.ts";\n',
  "README.md": "# demo\n",
};

describe("walkImporters", () => {
  /** importersOf over a table of who imports whom (importer -> what it imports), as the index answers. */
  const table = (imports: Record<string, string[]>): ImportersOf => (paths, exclude, limit) =>
    Object.entries(imports)
      .filter(([src, dsts]) => !exclude.includes(src) && dsts.some((d) => paths.includes(d)))
      .map(([src, dsts]) => ({ path: src, via: dsts.filter((d) => paths.includes(d)).sort()[0]! }))
      .sort((x, y) => (x.path < y.path ? -1 : 1))
      .slice(0, limit);

  it("walks level by level, keeping each file at the first level that reaches it, with the file it imports there", () => {
    const of = table({ a: ["root"], b: ["a"], c: ["b", "root"], d: ["c"], e: ["d"] });
    expect(walkImporters(["root"], of, 3, 100)).toEqual({
      files: [
        { path: "a", depth: 1, via: "root" },
        { path: "c", depth: 1, via: "root" },
        { path: "b", depth: 2, via: "a" },
        { path: "d", depth: 2, via: "c" },
        { path: "e", depth: 3, via: "d" },
      ],
      truncated: false,
    });
  });

  it("says truncated when a level past the last one walked has importers, or when the file cap left some out", () => {
    const of = table({ a: ["root"], b: ["a"], c: ["b"] });
    expect(walkImporters(["root"], of, 2, 100)).toEqual({ files: [{ path: "a", depth: 1, via: "root" }, { path: "b", depth: 2, via: "a" }], truncated: true });
    expect(walkImporters(["root"], of, 3, 100).truncated).toBe(false);
    const wide = table({ a: ["root"], b: ["root"], c: ["root"], d: ["root"] });
    // The cap counts the files asked about: 3 in all leaves room for 2 importers.
    expect(walkImporters(["root"], wide, 3, 3)).toEqual({ files: [{ path: "a", depth: 1, via: "root" }, { path: "b", depth: 1, via: "root" }], truncated: true });
    // Roots that fill the cap leave no room: truncated only when there are importers to leave out.
    expect(walkImporters(["root", "x"], wide, 3, 2)).toEqual({ files: [], truncated: true });
    expect(walkImporters(["x", "y"], wide, 3, 2)).toEqual({ files: [], truncated: false });
  });

  it("survives import cycles and roots that import each other", () => {
    const of = table({ a: ["b"], b: ["a"], c: ["a"] });
    expect(walkImporters(["a"], of, 3, 100)).toEqual({ files: [{ path: "b", depth: 1, via: "a" }, { path: "c", depth: 1, via: "a" }], truncated: false });
    expect(walkImporters(["a", "b"], of, 3, 100)).toEqual({ files: [{ path: "c", depth: 1, via: "a" }], truncated: false });
  });
});

describe("expandEntries", () => {
  const t = new Trunk(CHAIN);

  it("keeps files as they are, expands directories (with or without a slash) and globs to trunk files, and names what trunk lacks", () => {
    expect(expandEntries(t.files(), ["src/util.ts", "src/nope.ts", "lib/", "src/*.ts", "test", "docs/"], 100)).toEqual({
      roots: ["src/util.ts", "lib/x/index.ts", "src/a.ts", "src/b.ts", "src/both.ts", "src/c.ts", "src/d.ts", "test/a.test.ts"],
      missing: ["src/nope.ts", "docs/"],
      truncated: false,
    });
    expect(expandEntries(t.files(), ["**/*.md"], 100).roots).toEqual(["README.md"]);
  });

  it("stops at the cap and says so", () => {
    expect(expandEntries(t.files(), ["src/"], 2)).toEqual({ roots: ["src/a.ts", "src/b.ts"], missing: [], truncated: true });
  });

  it("scans at most 20,000 trunk paths for all its directories and globs together", () => {
    const scans: number[] = [];
    const huge: TrunkFiles = {
      has: () => false,
      range: (_from, _to, limit) => {
        scans.push(limit);
        return Array.from({ length: Math.min(limit, 15_000) }, (_, i) => `a/f${String(i).padStart(5, "0")}.ts`);
      },
    };
    // The first glob scans 15,000 paths, the second the 5,000 left; the third is not looked at, and none counts as missing.
    expect(expandEntries(huge, ["**/*.md", "a/**/*.md", "b/"], 200)).toEqual({ roots: [], missing: ["**/*.md"], truncated: true });
    expect(scans).toEqual([20_000, 5_000]);
  });
});

describe("importerWalk over the import index", () => {
  it("builds the index on first use and walks three levels of importers, nearest first, each with its via", async () => {
    const t = new Trunk(CHAIN);
    const w = await t.walk(["src/util.ts"]);
    expect(w).toEqual({
      trunkSha: "c1",
      current: true,
      roots: ["src/util.ts"],
      missing: [],
      files: [
        { path: "lib/x/index.ts", depth: 1, via: "src/util.ts" },
        { path: "src/a.ts", depth: 1, via: "src/util.ts" },
        { path: "src/both.ts", depth: 1, via: "src/util.ts" },
        { path: "src/b.ts", depth: 2, via: "src/a.ts" },
        { path: "test/a.test.ts", depth: 2, via: "src/a.ts" },
        { path: "src/c.ts", depth: 3, via: "src/b.ts" },
      ],
      // src/d.ts imports src/c.ts, one level further.
      truncated: true,
    });
    expect((await t.walk(["src/util.ts"], { depth: 1 })).files.map((f) => f.path)).toEqual(["lib/x/index.ts", "src/a.ts", "src/both.ts"]);
    // A file nothing imports, and a file trunk does not have.
    expect(await t.walk(["README.md", "src/gone.ts"])).toMatchObject({ roots: ["README.md"], missing: ["src/gone.ts"], files: [], truncated: false });
  });

  it("walks from every file a footprint names, and never walks back into one", async () => {
    const t = new Trunk(CHAIN);
    const w = await t.walk(["src/a.ts", "src/b.ts"], { depth: 3 });
    expect(w.roots).toEqual(["src/a.ts", "src/b.ts"]);
    expect(w.files).toEqual([
      { path: "src/both.ts", depth: 1, via: "src/a.ts" },
      { path: "src/c.ts", depth: 1, via: "src/b.ts" },
      { path: "test/a.test.ts", depth: 1, via: "src/a.ts" },
      { path: "src/d.ts", depth: 2, via: "src/c.ts" },
    ]);
  });

  it("is bounded by the file cap (at most IMPACT_FILES), roots included", async () => {
    const files: Record<string, string> = { "src/hub.ts": "export const hub = 1;\n" };
    for (let i = 0; i < IMPACT_FILES + 50; i++) files[`src/users/u${String(i).padStart(3, "0")}.ts`] = 'import { hub } from "../hub.ts";\nexport const u = hub;\n';
    const t = new Trunk(files);
    const w = await t.walk(["src/hub.ts"], { max: 10_000 });
    expect(w.files).toHaveLength(IMPACT_FILES - 1);
    expect(w.truncated).toBe(true);
    expect((await t.walk(["src/hub.ts"], { max: 5 })).files.map((f) => f.path)).toEqual(["src/users/u000.ts", "src/users/u001.ts", "src/users/u002.ts", "src/users/u003.ts"]);
  });

  it("answers from the index as it stands when its build does not finish in time, and says so", async () => {
    const t = new Trunk(CHAIN);
    t.stall = true;
    const started = Date.now();
    const w = await t.walk(["src/util.ts"], { waitMs: 30 });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(w.current).toBe(false);
    expect(w.note).toMatch(/^the import index was still being brought up to date after 0 s \(it is built the first time it is read\): importers may be missing; ask again in a few seconds$/);
    expect(w.roots).toEqual(["src/util.ts"]);
  });

  it("says why when the index cannot be brought up to date", async () => {
    // The sync fails outright (trunk's head unreadable while it ran).
    let heads = 0;
    const flaky: ImportSource = {
      head: () => {
        if (heads++ === 0) throw new Error("trunk erased");
        return "c1";
      },
      read: async () => null,
    };
    const t = new Trunk(CHAIN);
    const broken = await importerWalk(t.index, flaky, t.files(), ["src/util.ts"]);
    expect(broken).toMatchObject({ trunkSha: "c1", current: false, files: [], roots: ["src/util.ts"] });
    expect(broken.note).toBe("the import index could not be brought up to date (trunk erased): importers may be missing; ask again in a few seconds");
    // Reads fail: the sync ends with files left to read.
    const failing: ImportSource = { head: () => "c1", read: async () => Promise.reject(new Error("read failed")) };
    const u = new Trunk(CHAIN);
    const w = await importerWalk(u.index, failing, u.files(), ["src/util.ts"]);
    expect(w).toMatchObject({ current: false, files: [], roots: ["src/util.ts"] });
    expect(w.note).toMatch(/^the import index has files left to read \(a budget ran out or a read failed\): importers may be missing/);
  });
});

describe("ImportIndex.importersOf", () => {
  it("answers one level: each importer once with the first file it imports, the excluded and the files asked about left out", async () => {
    const t = new Trunk(CHAIN);
    await t.index.sync(t.source());
    expect(t.index.importersOf(["src/util.ts", "src/a.ts"], [], 10)).toEqual([
      { path: "lib/x/index.ts", via: "src/util.ts" },
      { path: "src/b.ts", via: "src/a.ts" },
      { path: "src/both.ts", via: "src/a.ts" },
      { path: "test/a.test.ts", via: "src/a.ts" },
    ]);
    expect(t.index.importersOf(["src/util.ts"], ["src/both.ts"], 10).map((r) => r.path)).toEqual(["lib/x/index.ts", "src/a.ts"]);
    expect(t.index.importersOf(["src/util.ts"], [], 1)).toEqual([{ path: "lib/x/index.ts", via: "src/util.ts" }]);
    expect(t.index.importersOf([], [], 10)).toEqual([]);
    expect(t.index.importersOf(["src/util.ts"], [], 0)).toEqual([]);
  });
});
