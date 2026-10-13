import { describe, expect, it } from "vitest";
import { neighborRepulsion } from "@fire_trident/core";
import { resolutionCandidates, resolveModule, specifierTarget } from "../../src/decide/mechanical.ts";
import {
  IMPORT_PATHS_MAX,
  ImportIndex,
  dependentTargets,
  importNeighbors,
  importTargets,
  markLanded,
  type ImportCaps,
  type ImportSource,
} from "../../src/trunk/imports.ts";

/** The part of node:sqlite these tests use (the worker compiles against workers types, not Node's). */
interface DatabaseSync {
  prepare(sql: string): { all(...params: unknown[]): unknown[]; run(...params: unknown[]): unknown };
  exec(sql: string): void;
}
const SQLITE = "node:sqlite";
const { DatabaseSync } = (await import(SQLITE)) as { DatabaseSync: new (path: string) => DatabaseSync };

/** SqlStorage over node:sqlite (the subset the index uses), plus a transaction runner. */
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
  // TrunkDO's trunk index, which the import index reads.
  db.exec("CREATE TABLE ft_files (path TEXT PRIMARY KEY, blob TEXT NOT NULL, size INTEGER NOT NULL, mode TEXT NOT NULL)");
  return { sql, txn, db };
}

const hex = (n: number): string => n.toString(16).padStart(40, "0");

/**
 * Trunk as TrunkDO keeps it for the index: the ft_files table, blob contents, the head commit, and
 * landings that mark the index the way finalizeRows does (or pushes that do not).
 */
class Trunk {
  readonly sql: SqlStorage;
  readonly txn: (fn: () => void) => void;
  readonly db: DatabaseSync;
  readonly index: ImportIndex;
  head: string;
  /** Blob ids read, in order. */
  reads: string[] = [];
  private readonly texts = new Map<string, string>();
  private readonly ids = new Map<string, string>();
  private n = 0;

  constructor(files: Record<string, string>, caps: Partial<ImportCaps> = {}) {
    ({ sql: this.sql, txn: this.txn, db: this.db } = storage());
    this.index = new ImportIndex(this.sql, this.txn, caps);
    for (const [path, text] of Object.entries(files)) this.put(path, text);
    this.head = this.commit();
  }

  /** The blob id of `path` on trunk now. */
  blob(path: string): string {
    return (this.sql.exec<{ blob: string }>("SELECT blob FROM ft_files WHERE path = ?", path).toArray()[0] ?? { blob: "" }).blob;
  }

  /** A landing: trunk changes and the index is marked, in one transaction (content null deletes). */
  land(changes: Record<string, string | null>): void {
    const parent = this.head;
    const head = this.commit();
    this.txn(() => {
      const staged = Object.entries(changes).map(([path, text]) => {
        const before = this.blob(path) || null;
        const blob = text === null ? null : this.put(path, text);
        if (text === null) this.sql.exec("DELETE FROM ft_files WHERE path = ?", path);
        return [path, { blob, before }] as const;
      });
      markLanded(this.sql, parent, head, staged);
    });
    this.head = head;
  }

  /** A push outside the landing path: trunk changes and nobody tells the index. */
  push(changes: Record<string, string | null>): void {
    for (const [path, text] of Object.entries(changes)) {
      if (text === null) this.sql.exec("DELETE FROM ft_files WHERE path = ?", path);
      else this.put(path, text);
    }
    this.head = this.commit();
  }

  source(): ImportSource {
    return {
      head: () => this.head,
      read: async (blob) => {
        this.reads.push(blob);
        const text = this.texts.get(blob);
        return text === undefined ? null : new TextEncoder().encode(text);
      },
    };
  }

  sync() {
    return this.index.sync(this.source());
  }

  links(paths: string[], max?: number) {
    return this.index.links(paths, max);
  }

  /** Forget a blob's content (it becomes unreadable). */
  lose(path: string): void {
    this.texts.delete(this.blob(path));
  }

  private put(path: string, text: string): string {
    let id = this.ids.get(text);
    if (id === undefined) {
      id = hex(++this.n);
      this.ids.set(text, id);
      this.texts.set(id, text);
    }
    this.sql.exec("INSERT OR REPLACE INTO ft_files (path, blob, size, mode) VALUES (?, ?, ?, '100644')", path, id, new TextEncoder().encode(text).length);
    return id;
  }

  private commit(): string {
    return `c${++this.n}`;
  }
}

const imports = (...specs: string[]): string => specs.map((s) => `import "${s}";`).join("\n") + "\n";

describe("import targets and resolution", () => {
  it("keeps the targets of relative specifiers only, once each", () => {
    const text = 'import a from "./x";\nimport type { B } from "../lib/b.js";\nexport * from "./x";\nconst c = require("./c");\nimport("pkg");\nimport d from "node:fs";\n';
    expect(importTargets("src/app/main.ts", text)).toEqual(["src/app/x", "src/lib/b.js", "src/app/c"]);
    expect(importTargets("src/a.ts", 'import x from "../../../up";\n')).toEqual([]);
  });

  it("lists every target a path takes part in resolving (the inverse of resolutionCandidates)", () => {
    const targets = ["src/x", "src/x.js", "src/x.ts", "src/x.jsx", "src/x.mjs", "src/x.cjs", "src/dir", "", "src/x.d", "src/x.d.ts", "lib/w.tsx"];
    for (const t of targets) for (const p of resolutionCandidates(t)) expect(dependentTargets(p), `${p} for ${t}`).toContain(t);
    for (const p of ["src/x.ts", "src/dir/index.ts", "index.mjs", "src/x.d.ts", "src/data.json", "README"]) {
      for (const t of dependentTargets(p)) expect(resolutionCandidates(t)).toContain(p);
    }
    expect(dependentTargets("src/dir/index.ts")).toContain("src/dir");
    expect(dependentTargets("src/x.ts")).toEqual(expect.arrayContaining(["src/x", "src/x.ts", "src/x.js"]));
  });
});

describe("ImportIndex", () => {
  it("builds lazily from the trunk index, parsing script files only", async () => {
    const t = new Trunk({
      "src/a.ts": imports("./x", "./dir"),
      "src/x.ts": "export const x = 1;\n",
      "src/dir/index.ts": 'export * from "../x.js";\n',
      "README.md": imports("./src/a"),
      "src/data.json": "{}",
    });
    expect(t.index.stats()).toMatchObject({ sha: null, files: 0, edges: 0 });
    const r = await t.sync();
    expect(r).toMatchObject({ read: 3, removed: 0, skipped: 0, pending: 0 });
    expect(t.reads).toHaveLength(3);
    expect(t.links(["src/a.ts", "src/x.ts", "src/dir/index.ts", "README.md", "src/data.json"])).toEqual({
      "src/a.ts": { imports: ["src/dir/index.ts", "src/x.ts"], importers: [] },
      "src/x.ts": { imports: [], importers: ["src/a.ts", "src/dir/index.ts"] },
      "src/dir/index.ts": { imports: ["src/x.ts"], importers: ["src/a.ts"] },
    });
    expect(t.index.stats()).toMatchObject({ sha: t.head, files: 3, edges: 3, pending: 0, resolving: false });
  });

  it("resolves ./x, ./x.ts, ./x.js and ./dir exactly as the decide stage does", async () => {
    const specs = ["./x", "./y.ts", "./z.js", "./dir", "./both", "../lib/w", "./data", "pkg", "../../../above", "./missing", "./main"];
    const files: Record<string, string> = {
      "src/main.ts": imports(...specs),
      "src/x.ts": "",
      "src/y.ts": "",
      "src/z.ts": "",
      "src/dir/index.ts": "",
      "src/both.ts": "",
      "src/both/index.ts": "",
      "lib/w.tsx": "",
      "src/data.json": "{}",
    };
    const t = new Trunk(files);
    await t.sync();
    const got = t.links(["src/main.ts"])["src/main.ts"]!;
    // A file beside a same-named directory wins; .js names its TypeScript twin; data files and the file itself are not edges.
    expect(got.imports).toEqual(["lib/w.tsx", "src/both.ts", "src/dir/index.ts", "src/x.ts", "src/y.ts", "src/z.ts"]);
    const exists = (p: string): boolean => Object.hasOwn(files, p);
    const decide = specs
      .map((s) => resolveModule(specifierTarget("src/main.ts", s), exists))
      .filter((p): p is string => p !== null && /\.[cm]?[jt]sx?$/.test(p) && p !== "src/main.ts");
    expect(got.imports).toEqual([...new Set(decide)].sort());
  });

  it("re-reads only the script files a landing changed", async () => {
    const t = new Trunk({ "src/a.ts": imports("./x", "./y"), "src/x.ts": "", "src/y.ts": "", "docs/guide.md": "guide\n" });
    await t.sync();
    t.reads = [];
    t.land({ "src/a.ts": imports("./y"), "docs/guide.md": "more\n" });
    expect(t.index.stats()).toMatchObject({ sha: t.head, pending: 1 });
    const r = await t.sync();
    expect(r).toMatchObject({ read: 1, pending: 0 });
    expect(t.reads).toEqual([t.blob("src/a.ts")]);
    expect(t.links(["src/a.ts", "src/x.ts", "src/y.ts"])).toEqual({
      "src/a.ts": { imports: ["src/y.ts"], importers: [] },
      "src/y.ts": { imports: [], importers: ["src/a.ts"] },
    });
    t.reads = [];
    expect(await t.sync()).toMatchObject({ read: 0, resolved: 0, pending: 0 });
    expect(t.reads).toEqual([]);
  });

  it("resolves again when a file appears or disappears, without re-reading its importers", async () => {
    const t = new Trunk({ "src/c.ts": imports("./n"), "src/n/index.ts": "", "src/d.ts": imports("./q"), "src/q/index.ts": "" });
    await t.sync();
    expect(t.links(["src/c.ts"])["src/c.ts"]!.imports).toEqual(["src/n/index.ts"]);
    t.reads = [];
    // src/n.ts now wins over the directory's index file.
    t.land({ "src/n.ts": "" });
    await t.sync();
    expect(t.reads).toEqual([t.blob("src/n.ts")]);
    expect(t.links(["src/c.ts", "src/n.ts", "src/n/index.ts"])).toEqual({
      "src/c.ts": { imports: ["src/n.ts"], importers: [] },
      "src/n.ts": { imports: [], importers: ["src/c.ts"] },
    });
    t.land({ "src/n.ts": null });
    expect((await t.sync()).read).toBe(0);
    expect(t.links(["src/c.ts"])["src/c.ts"]!.imports).toEqual(["src/n/index.ts"]);
    t.land({ "src/n/index.ts": null });
    await t.sync();
    expect(t.links(["src/c.ts"])).toEqual({});
    // A data file that appears can win too: src/q.json comes before src/q/index.ts, and is not a script.
    expect(t.links(["src/d.ts"])["src/d.ts"]!.imports).toEqual(["src/q/index.ts"]);
    t.land({ "src/q.json": "{}" });
    await t.sync();
    expect(t.links(["src/d.ts", "src/q/index.ts"])).toEqual({});
  });

  it("ignores landings before the first build, and landings that do not continue the trunk it describes", async () => {
    const t = new Trunk({ "src/a.ts": imports("./x"), "src/x.ts": "", "src/y.ts": "" });
    t.land({ "src/a.ts": imports("./y") });
    expect(t.index.stats()).toMatchObject({ sha: null, pending: 0 });
    await t.sync();
    expect(t.links(["src/a.ts"])["src/a.ts"]!.imports).toEqual(["src/y.ts"]);
    // A push outside the landing path, then a landing on top of it: nothing is marked, the next sync compares everything.
    t.push({ "src/a.ts": imports("./x") });
    t.land({ "src/b.ts": imports("./a") });
    expect(t.index.stats().pending).toBe(0);
    t.reads = [];
    const r = await t.sync();
    expect(r).toMatchObject({ read: 2, pending: 0 });
    expect(r.resolved).toBeGreaterThan(0);
    expect(t.links(["src/a.ts", "src/b.ts"])).toEqual({
      "src/a.ts": { imports: ["src/x.ts"], importers: ["src/b.ts"] },
      "src/b.ts": { imports: ["src/a.ts"], importers: [] },
    });
  });

  it("compares the whole index after a push outside the landing path, reading only what differs", async () => {
    const t = new Trunk({ "src/a.ts": imports("./x", "./dir"), "src/x.ts": "", "src/dir/index.ts": imports("../x"), "src/k.ts": imports("./m"), "src/m/index.ts": "" });
    await t.sync();
    t.reads = [];
    // src/m.ts is not a script the index tracked before: only resolving every edge again finds it.
    t.push({ "src/new.ts": imports("./a"), "src/dir/index.ts": null, "src/m.ts": "" });
    const r = await t.sync();
    expect(r).toMatchObject({ read: 2, removed: 1, pending: 0 });
    expect(t.reads.sort()).toEqual([t.blob("src/new.ts"), t.blob("src/m.ts")].sort());
    expect(t.links(["src/a.ts", "src/x.ts", "src/k.ts"])).toEqual({
      "src/a.ts": { imports: ["src/x.ts"], importers: ["src/new.ts"] },
      "src/x.ts": { imports: [], importers: ["src/a.ts"] },
      "src/k.ts": { imports: ["src/m.ts"], importers: [] },
    });
    expect(t.index.stats()).toMatchObject({ resolving: false, sha: t.head });
  });

  it("survives a restart without rebuilding", async () => {
    const t = new Trunk({ "src/a.ts": imports("./x"), "src/x.ts": "" });
    await t.sync();
    const before = t.links(["src/a.ts", "src/x.ts"]);
    t.reads = [];
    const again = new ImportIndex(t.sql, t.txn);
    expect(await again.sync(t.source())).toMatchObject({ read: 0, removed: 0, skipped: 0, resolved: 0, pending: 0 });
    expect(t.reads).toEqual([]);
    expect(again.links(["src/a.ts", "src/x.ts"])).toEqual(before);
    // Landings recorded while it was down are caught up from their marks alone.
    t.land({ "src/a.ts": "" });
    expect((await new ImportIndex(t.sql, t.txn).sync(t.source())).read).toBe(1);
  });

  it("skips files over the size and file caps, and unreadable ones, but keeps them as import targets", async () => {
    const big = new Trunk({ "src/big.ts": imports("./x") + "// padding\n".repeat(20), "src/x.ts": "", "src/a.ts": imports("./big") }, { fileBytes: 100 });
    const r = await big.sync();
    expect(r).toMatchObject({ read: 2, skipped: 1 });
    expect(big.reads).not.toContain(big.blob("src/big.ts"));
    expect(big.links(["src/big.ts", "src/x.ts"])).toEqual({ "src/big.ts": { imports: [], importers: ["src/a.ts"] } });
    expect(big.index.stats()).toMatchObject({ files: 2, skipped: 1 });

    const capped = new Trunk({ "src/a.ts": imports("./c"), "src/b.ts": imports("./c"), "src/c.ts": imports("./a") }, { files: 2 });
    expect(await capped.sync()).toMatchObject({ read: 2, skipped: 1 });
    expect(capped.links(["src/c.ts"])).toEqual({ "src/c.ts": { imports: [], importers: ["src/a.ts", "src/b.ts"] } });

    const lost = new Trunk({ "src/a.ts": imports("./x"), "src/x.ts": "" });
    lost.lose("src/a.ts");
    expect(await lost.sync()).toMatchObject({ read: 1, skipped: 1, pending: 0 });
    // Not read again until it changes.
    lost.reads = [];
    await lost.sync();
    expect(lost.reads).toEqual([]);
    lost.land({ "src/a.ts": imports("./x") + "\n" });
    await lost.sync();
    expect(lost.links(["src/a.ts"])["src/a.ts"]!.imports).toEqual(["src/x.ts"]);
  });

  it("keeps a file whose read fails marked for the next sync", async () => {
    const t = new Trunk({ "src/a.ts": imports("./x"), "src/x.ts": "" });
    const failing: ImportSource = {
      head: () => t.head,
      read: async (blob) => {
        if (blob === t.blob("src/a.ts")) throw new Error("transient");
        return t.source().read(blob);
      },
    };
    expect(await t.index.sync(failing)).toMatchObject({ read: 1, pending: 1 });
    expect(t.links(["src/x.ts"])).toEqual({});
    expect(await t.sync()).toMatchObject({ read: 1, pending: 0 });
    expect(t.links(["src/x.ts"])).toEqual({ "src/x.ts": { imports: [], importers: ["src/a.ts"] } });
  });

  it("reads a file again when a landing changes it while it is being read", async () => {
    const t = new Trunk({ "src/a.ts": imports("./x"), "src/x.ts": "", "src/y.ts": "" });
    const first = t.blob("src/a.ts");
    let landed = false;
    const racing: ImportSource = {
      head: () => t.head,
      read: async (blob) => {
        const data = await t.source().read(blob);
        if (blob === first && !landed) {
          landed = true;
          t.land({ "src/a.ts": imports("./y") });
        }
        return data;
      },
    };
    expect(await t.index.sync(racing)).toMatchObject({ pending: 0 });
    expect(t.links(["src/a.ts"])["src/a.ts"]!.imports).toEqual(["src/y.ts"]);
    expect(t.reads.filter((b) => b === t.blob("src/a.ts"))).toHaveLength(1);
  });

  it("stops at the byte budget and finishes on the next sync", async () => {
    const files = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`src/f${i}.ts`, imports(`./f${(i + 1) % 6}`)]));
    const t = new Trunk(files, { budgetBytes: 40 });
    const first = await t.sync();
    expect(first.pending).toBeGreaterThan(0);
    expect(first.read).toBeLessThan(6);
    let rounds = 0;
    while ((await t.sync()).pending > 0 && rounds < 10) rounds++;
    expect(t.index.stats()).toMatchObject({ files: 6, edges: 6, pending: 0 });
  });

  it("shares one sync between concurrent callers", async () => {
    const t = new Trunk({ "src/a.ts": imports("./x"), "src/x.ts": "" });
    const p1 = t.sync();
    const p2 = t.sync();
    expect(p2).toBe(p1);
    await p1;
    expect(t.reads).toHaveLength(2);
  });

  it("stops when trunk is gone (erased while syncing)", async () => {
    const t = new Trunk({ "src/a.ts": imports("./x"), "src/x.ts": "" });
    expect(await t.index.sync({ head: () => null, read: async () => null })).toMatchObject({ read: 0, pending: 0 });
    expect(t.index.stats().sha).toBeNull();
  });

  it("answers bounded links: at most max per direction, known paths only, files only", async () => {
    const files: Record<string, string> = { "src/hub.ts": imports("./self", "./hub") };
    for (let i = 0; i < 5; i++) files[`src/u${i}.ts`] = imports("./hub");
    const t = new Trunk(files);
    await t.sync();
    expect(t.links(["src/hub.ts"], 3)).toEqual({ "src/hub.ts": { imports: [], importers: ["src/u0.ts", "src/u1.ts", "src/u2.ts"] } });
    expect(Object.keys(t.links(["src/hub.ts", "src/hub.ts", "src/", "src/*.ts", "", "nobody.ts"]))).toEqual(["src/hub.ts"]);
    const many = Array.from({ length: IMPORT_PATHS_MAX }, (_, i) => `x${i}.ts`);
    expect(t.links([...many, "src/hub.ts"])).toEqual({});
  });
});

describe("markLanded", () => {
  it("marks script files, created and deleted paths, and never fails a landing", async () => {
    const t = new Trunk({ "src/a.ts": "", "docs/x.md": "" });
    await t.sync();
    const parent = t.head;
    markLanded(t.sql, parent, "c-next", [
      ["src/a.ts", { blob: hex(90), before: t.blob("src/a.ts") }],
      ["docs/x.md", { blob: hex(91), before: t.blob("docs/x.md") }],
      ["docs/new.json", { blob: hex(92), before: null }],
      ["src/gone.ts", { blob: null, before: hex(93) }],
    ]);
    const rows = t.db.prepare("SELECT path, moved FROM ft_imp_dirty ORDER BY path").all();
    expect(rows).toEqual([
      { path: "docs/new.json", moved: 1 },
      { path: "src/a.ts", moved: 0 },
      { path: "src/gone.ts", moved: 1 },
    ]);
    expect(t.index.stats().sha).toBe("c-next");
    // A later mark keeps "moved".
    markLanded(t.sql, "c-next", "c-after", [["src/gone.ts", { blob: hex(94), before: null }]]);
    expect(t.db.prepare("SELECT moved FROM ft_imp_dirty WHERE path = 'src/gone.ts'").all()).toEqual([{ moved: 1 }]);
    // Without the index's tables (never built in this object), nothing happens and nothing throws.
    const bare = storage();
    expect(() => markLanded(bare.sql, "a", "b", [["src/x.ts", { blob: hex(1), before: null }]])).not.toThrow();
  });
});

describe("import repulsion (the caller's side)", () => {
  it("turns links into weight-1 neighbors: each import or importer once, never the path itself", () => {
    expect(importNeighbors({ "a.ts": { imports: ["b.ts", "c.ts"], importers: ["c.ts", "d.ts", "a.ts"] } })).toEqual({
      "a.ts": [
        { path: "b.ts", weight: 1 },
        { path: "c.ts", weight: 1 },
        { path: "d.ts", weight: 1 },
      ],
    });
    expect(importNeighbors({ "x.ts": { imports: [], importers: [] } })).toEqual({});
    expect(importNeighbors(null)).toEqual({});
    expect(importNeighbors({ "y.ts": { imports: "nope", importers: [1, null, "z.ts"] } } as never)).toEqual({ "y.ts": [{ path: "z.ts", weight: 1 }] });
  });

  it("adds weight times the claims on distinct imports and importers outside the footprint (0 at weight 0)", () => {
    const nb = importNeighbors({
      "src/a.ts": { imports: ["src/hub.ts"], importers: ["src/c.ts"] },
      "src/b.ts": { imports: ["src/hub.ts", "src/a.ts"], importers: [] },
    });
    const claims: Record<string, number> = { "src/hub.ts": 1, "src/c.ts": 0.5, "src/a.ts": 1 };
    const term = (weight: number): number => weight * neighborRepulsion(["src/a.ts", "src/b.ts"], (p) => nb[p], (p) => claims[p] ?? 0);
    expect(term(0)).toBe(0);
    // hub.ts once (both files import it) plus c.ts; a.ts is in the footprint, so its claim repels directly instead.
    expect(term(1)).toBeCloseTo(1.5, 12);
    expect(term(2)).toBeCloseTo(3, 12);
  });
});
