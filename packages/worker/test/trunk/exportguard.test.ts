import { describe, expect, it, vi } from "vitest";
import type { FileVersion, Path, Proposal, Sha } from "@fire_trident/core";
import { importBindings } from "../../src/decide/mechanical.ts";
import { ExportMemo, exportGuardEnabled, guardExports, removedNames } from "../../src/trunk/exportguard.ts";
import { ImportIndex, exportImports, markLanded, type ImportSource } from "../../src/trunk/imports.ts";
import { planCycle, type ExportImports, type PlanProposal } from "../../src/trunk/plan.ts";

/** The export guard (FT_EXPORT_GUARD): what a version exports for it, the plan's check, and its input from the import index. */

const hex = (n: number): Sha => n.toString(16).padStart(40, "0");

function prop(id: string, writes: Record<Path, Sha | null>): Proposal {
  return {
    id,
    colonyId: "c",
    intentId: `int_${id}`,
    agentId: `agt_${id}`,
    workspace: { namespace: "ft-ws-0", name: `c--ws-${id}`, remote: "https://example.invalid/ws.git" },
    baseSha: hex(0),
    headSha: hex(0),
    writeSet: Object.entries(writes).map(([path, blob]) => ({ path, blob })),
    readSet: [],
    declared: { footprint: Object.keys(writes), summary: id },
    evidence: { checks: [] },
    status: "ready",
    createdAt: 0,
  };
}

/** Texts by a made-up blob id each, and the guard's input over all of them. */
class Versions {
  readonly texts = new Map<Sha, string>();
  private n = 100;

  of(text: string): Sha {
    for (const [id, t] of this.texts) if (t === text) return id;
    const id = hex(++this.n);
    this.texts.set(id, text);
    return id;
  }

  input(importers: Record<Path, Path[]>): ExportImports {
    return {
      exports: new Map([...this.texts].map(([id, t]) => [id, guardExports(t)])),
      importers: new Map(Object.entries(importers)),
      bindings: new Map([...this.texts].map(([id, t]) => [id, importBindings(t)])),
    };
  }
}

describe("what a version exports for the export guard", () => {
  const before = guardExports("export function foo() {}\nexport const bar = 1;\nexport interface Shape {}\n")!;
  const gone = (text: string): string[] | null => {
    const after = guardExports(text);
    return after === null ? null : removedNames(before, after);
  };

  it("takes a name as removed when the new version deletes, renames or stops exporting it", () => {
    expect(gone("export const bar = 1;\nexport interface Shape {}\n")).toEqual(["foo"]);
    expect(gone("export function fooBar() {}\nexport const bar = 1;\nexport interface Shape {}\n")).toEqual(["foo"]);
    expect(gone("function foo() {}\nexport const bar = foo;\n")).toEqual(["Shape", "foo"]);
    // Without semicolons, a line break still ends a declaration: foo here is not exported.
    expect(gone("export const bar = 1\nconst foo = 2\nexport type Shape = {}\n")).toEqual(["foo"]);
  });

  it("never takes one as removed that the new version may still export where the export reader does not list it", () => {
    expect(gone("export const bar = 1, foo = 2;\nexport interface Shape {}\n")).toEqual([]);
    expect(gone("export const bar = 1,\n  foo = () => 2;\nexport interface Shape {}\n")).toEqual([]);
    expect(gone("export const { foo, bar } = make();\nexport interface Shape {}\n")).toEqual([]);
    expect(gone("export let [bar, { inner: foo }] = pair;\nexport interface Shape {}\n")).toEqual([]);
    expect(gone("@sealed export class foo {}\nexport const bar = 1;\nexport interface Shape {}\n")).toEqual([]);
    expect(gone("export declare const bar: number, foo: string;\nexport interface Shape {}\n")).toEqual([]);
  });

  it("cannot know a version's exports with export *, CommonJS, or a source the reader cannot parse", () => {
    expect(guardExports('export * from "./other";\nexport const bar = 1;\n')).toBeNull();
    expect(guardExports("module.exports = { foo };\n")).toBeNull();
    expect(guardExports("exports.foo = 1;\n")).toBeNull();
    expect(guardExports('export const bar = "unterminated;\n')).toBeNull();
    expect(guardExports("export = thing;\n")).toBeNull();
    // A namespace re-export is a name of its own.
    expect([...guardExports('export * as tools from "./tools";\n')!.names]).toEqual(["tools"]);
  });

  it("is on per colony, read like FT_REVALIDATE", () => {
    expect(exportGuardEnabled(undefined, "c1")).toBe(false);
    expect(exportGuardEnabled(" off ", "c1")).toBe(false);
    expect(exportGuardEnabled("on", "c1")).toBe(true);
    expect(exportGuardEnabled("c2, c1", "c1")).toBe(true);
    expect(exportGuardEnabled("c2", "c1")).toBe(false);
  });
});

describe("planCycle: export guard (FT_EXPORT_GUARD)", () => {
  const v = new Versions();
  const B0 = v.of("export function foo() {\n  return 1;\n}\nexport const bar = 2;\n");
  const B1 = v.of("export const bar = 2;\n"); // foo removed
  const A0 = v.of('import { foo } from "./b";\nconsole.log(foo());\n');
  const A1 = v.of('import { bar } from "./b";\nconsole.log(bar);\n'); // the import of foo dropped
  const A2 = v.of('import { foo, bar } from "./b";\nconsole.log(foo(), bar);\n'); // rewritten, still imports foo
  const trunk: Record<Path, Sha | null> = { "src/b.ts": B0, "src/a.ts": A0, "docs/x.md": hex(9) };
  const at = (path: Path): Sha | null => trunk[path] ?? null;
  const entry = (p: Proposal, files: Record<Path, Sha | null> = trunk): PlanProposal => ({
    p,
    base: p.writeSet.map((w): FileVersion => ({ path: w.path, blob: files[w.path] ?? null })),
  });
  const plan = (batches: Proposal[][], input: ExportImports | null | undefined, files: Record<Path, Sha | null> = trunk) =>
    planCycle(
      batches.map((b) => b.map((p) => entry(p, files))),
      (path) => files[path] ?? null,
      undefined,
      undefined,
      undefined,
      input,
    );
  /** On trunk, src/a.ts imports foo from src/b.ts. */
  const guarded = v.input({ "src/b.ts": ["src/a.ts"] });
  const REASON = "removing export foo from src/b.ts breaks the import in src/a.ts: change src/a.ts in the same change, or first";

  it("returns a change that removes an export a trunk file imports, naming the file, the name and the importer", () => {
    const d = prop("d", { "src/b.ts": B1 });
    const r = plan([[d]], guarded);
    expect(r.accepted).toEqual([[]]);
    expect(r.returned).toEqual([[{ proposalId: "d", reason: REASON }]]);
    expect(r.exportsUncovered).toBe(0);
  });

  it("lands it with the importer rewritten without the import in the same change", () => {
    const both = prop("both", { "src/b.ts": B1, "src/a.ts": A1 });
    expect(plan([[both]], guarded).accepted).toEqual([[both]]);
    // A rewrite that keeps the import does not count.
    const keeps = prop("keeps", { "src/b.ts": B1, "src/a.ts": A2 });
    expect(plan([[keeps]], guarded).returned[0]).toEqual([{ proposalId: "keeps", reason: REASON }]);
  });

  it("lands it with the importer rewritten by a change accepted ahead of it in the cycle, not by one after it", () => {
    const fix = prop("fix", { "src/a.ts": A1 });
    const d = prop("d", { "src/b.ts": B1 });
    expect(plan([[fix], [d]], guarded).accepted).toEqual([[fix], [d]]);
    expect(plan([[fix, d]], guarded).accepted).toEqual([[fix, d]]);
    const late = plan([[d], [fix]], guarded);
    expect(late.accepted).toEqual([[], [fix]]);
    expect(late.returned[0]).toEqual([{ proposalId: "d", reason: REASON }]);
    const kept = plan([[prop("k", { "src/a.ts": A2 })], [d]], guarded);
    expect(kept.returned[1]).toEqual([{ proposalId: "d", reason: REASON }]);
  });

  it("reads each kind of import: renamed, default, type-only and re-exported names, and .js specifiers", () => {
    const w = new Versions();
    const lib0 = w.of("export default function main() {}\nexport interface Shape {}\nexport const keep = 1;\n");
    const lib1 = w.of("export const keep = 1;\n");
    const files: Record<Path, Sha | null> = {
      "src/lib.ts": lib0,
      "src/x.ts": w.of('import main, { keep as k } from "./lib.js";\nmain(k);\n'),
      "src/y.ts": w.of('import type { Shape } from "./lib";\nexport const s: Shape = {};\n'),
      "src/z.ts": w.of('export { keep, default as entry } from "./lib.ts";\n'),
      "src/ok.ts": w.of('import { keep } from "./lib";\nkeep;\n'),
    };
    const d = prop("d", { "src/lib.ts": lib1 });
    const r = plan([[d]], w.input({ "src/lib.ts": ["src/ok.ts", "src/x.ts", "src/y.ts", "src/z.ts"] }), files);
    expect(r.returned).toEqual([
      [{ proposalId: "d", reason: "removing exports Shape and default from src/lib.ts breaks the imports in src/x.ts, src/y.ts and src/z.ts: change them in the same change, or first" }],
    ]);
  });

  it("skips what it cannot read for sure and counts it: an unparseable version, export *, a namespace or export * importer", () => {
    const w = new Versions();
    const b0 = w.of("export function foo() {}\nexport const bar = 2;\n");
    const files = (importer: string): Record<Path, Sha | null> => ({ "src/b.ts": b0, "src/a.ts": w.of(importer) });
    const named = files('import { foo } from "./b";\nfoo();\n');
    // The new version cannot be parsed, or re-exports another module whose names are not listed.
    for (const text of ['export const bar = "unterminated;\n', 'export * from "./c";\nexport const bar = 2;\n']) {
      const d = prop("d", { "src/b.ts": w.of(text) });
      const r = plan([[d]], w.input({ "src/b.ts": ["src/a.ts"] }), named);
      expect(r.accepted).toEqual([[d]]);
      expect(r.exportsUncovered).toBe(1);
    }
    // The importer takes the whole module: which names it uses is not known.
    for (const importer of ['import * as b from "./b";\nb.foo();\n', 'export * from "./b";\n']) {
      const d = prop("d", { "src/b.ts": w.of("export const bar = 2;\n") });
      const r = plan([[d]], w.input({ "src/b.ts": ["src/a.ts"] }), files(importer));
      expect(r.accepted).toEqual([[d]]);
      expect(r.exportsUncovered).toBe(1);
    }
    // Versions or importers the trunk writer did not read are skipped too.
    const unread: ExportImports = { exports: new Map(), importers: new Map(), bindings: new Map() };
    expect(plan([[prop("d", { "src/b.ts": B1 })]], unread).exportsUncovered).toBe(1);
    const noImporters = v.input({});
    expect(plan([[prop("d", { "src/b.ts": B1 })]], noImporters)).toMatchObject({ accepted: [[expect.anything()]], exportsUncovered: 1 });
  });

  it("fails open when its input could not be read (the import index not current): every changed script file is skipped", () => {
    const d = prop("d", { "src/b.ts": B1, "docs/x.md": hex(8) });
    const r = plan([[d]], null);
    expect(r.accepted).toEqual([[d]]);
    expect(r.exportsUncovered).toBe(1);
  });

  it("behaves exactly as today when off (no input)", () => {
    const d = prop("d", { "src/b.ts": B1 });
    const e = prop("e", { "src/a.ts": A2 });
    const batches = [[entry(d)], [entry(e)]];
    const off = planCycle(batches, at, undefined, undefined, undefined, undefined);
    expect(off).toEqual(planCycle(batches, at));
    expect(off.accepted).toEqual([[d], [e]]);
    expect(off).not.toHaveProperty("exportsUncovered");
  });

  it("lets only one of a removal and a new import of the name land in a cycle: the second goes back naming the first", () => {
    const C = v.of('import { foo } from "./b";\nexport const c = foo();\n');
    const d = prop("d", { "src/b.ts": B1 });
    const q = prop("q", { "src/c.ts": C });
    const free = v.input({ "src/b.ts": [] }); // nothing on trunk imports foo
    const first = plan([[d], [q]], free);
    expect(first.accepted).toEqual([[d], []]);
    expect(first.returned[1]).toEqual([
      {
        proposalId: "q",
        reason: "conflicts with d, landing ahead in this cycle: it removes export foo from src/b.ts, which src/c.ts imports in this change: read src/b.ts again once that change lands, and import what it exports then",
      },
    ]);
    const second = plan([[q], [d]], free);
    expect(second.accepted).toEqual([[q], []]);
    expect(second.returned[1]).toEqual([
      {
        proposalId: "d",
        reason: "conflicts with q, landing ahead in this cycle: its src/c.ts imports foo from src/b.ts, which this change stops exporting: keep the export, or change src/c.ts in this change once that change lands",
      },
    ]);
    // In one batch (one commit) the same holds, "in this landing".
    expect(plan([[q, d]], free).returned[0]![0]!.reason).toMatch(/^conflicts with q in this landing: its src\/c\.ts imports foo /);
    expect(plan([[d, q]], free).returned[0]![0]!.reason).toMatch(/^conflicts with d in this landing: it removes export foo /);
    // Each alone lands, and so does a removal next to a change importing other names.
    expect(plan([[d]], free).accepted).toEqual([[d]]);
    expect(plan([[q]], free).accepted).toEqual([[q]]);
    const other = prop("o", { "src/c.ts": v.of('import { bar } from "./b";\nexport const c = bar;\n') });
    expect(plan([[d], [other]], free).accepted).toEqual([[d], [other]]);
  });

  it("checks a version a text merge of the cycle made from its text", () => {
    // Two changes to b.ts from the same base: the second is stale and merges onto the first, and its merge removes foo.
    const base = "export function foo() {\n  return 1;\n}\n\n\n\nexport const bar = 2;\n";
    const w = new Versions();
    const b0 = w.of(base);
    const first = w.of(base.replace("bar = 2", "bar = 3"));
    const second = w.of("\n\n\n\n\n\nexport const bar = 2;\n");
    const files: Record<Path, Sha | null> = { "src/b.ts": b0, "src/a.ts": w.of('import { foo } from "./b";\nfoo();\n') };
    const texts = new Map(w.texts);
    const merge = {
      text: (blob: Sha) => texts.get(blob) ?? null,
      blobOf: (text: string) => {
        const id = w.of(text);
        texts.set(id, text);
        return id;
      },
    };
    const input = w.input({ "src/b.ts": ["src/a.ts"] });
    const r = planCycle(
      [[{ p: prop("one", { "src/b.ts": first }), base: [{ path: "src/b.ts", blob: b0 }] }], [{ p: prop("two", { "src/b.ts": second }), base: [{ path: "src/b.ts", blob: b0 }] }]],
      (path) => files[path] ?? null,
      undefined,
      undefined,
      merge,
      input,
    );
    expect(r.accepted.map((b) => b.map((p) => p.id))).toEqual([["one"], []]);
    expect(r.returned[1]).toEqual([{ proposalId: "two", reason: REASON }]);
  });
});

/** The part of node:sqlite these tests use. */
interface DatabaseSync {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  exec(sql: string): void;
}
const SQLITE = "node:sqlite";
const { DatabaseSync } = (await import(SQLITE)) as { DatabaseSync: new (path: string) => DatabaseSync };

/** Trunk as the trunk writer keeps it for the import index (ft_files, blob texts, the head), with landings that mark the index. */
class Trunk {
  readonly sql: SqlStorage;
  readonly index: ImportIndex;
  head = "c0";
  reads: Sha[] = [];
  private readonly db = new DatabaseSync(":memory:");
  private readonly texts = new Map<Sha, string>();
  private n = 0;

  constructor(files: Record<Path, string>, caps: { budgetBytes?: number } = {}) {
    const db = this.db;
    this.sql = {
      exec(query: string, ...bindings: unknown[]) {
        const rows = db.prepare(query).all(...bindings);
        return {
          toArray: () => rows,
          one: () => rows[0],
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
    this.index = new ImportIndex(this.sql, txn, caps);
    for (const [path, text] of Object.entries(files)) this.put(path, text);
  }

  blob(path: Path): Sha | null {
    return (this.sql.exec<{ blob: string }>("SELECT blob FROM ft_files WHERE path = ?", path).toArray()[0]?.blob as Sha | undefined) ?? null;
  }

  /** A blob with this text (a proposal's new version). */
  stage(text: string): Sha {
    for (const [id, t] of this.texts) if (t === text) return id;
    const id = hex(++this.n);
    this.texts.set(id, text);
    return id;
  }

  /** A landing: trunk changes and the index is marked. */
  land(changes: Record<Path, string>): void {
    const parent = this.head;
    this.head = `c${++this.n}`;
    const staged = Object.entries(changes).map(([path, text]) => [path, { before: this.blob(path), blob: this.put(path, text) }] as const);
    markLanded(this.sql, parent, this.head, staged);
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

  private put(path: Path, text: string): Sha {
    const id = this.stage(text);
    this.sql.exec("INSERT OR REPLACE INTO ft_files (path, blob, size, mode) VALUES (?, ?, ?, '100644')", path, id, text.length);
    return id;
  }
}

describe("exportImports (the export guard's input)", () => {
  const FILES = {
    "src/b.ts": "export function foo() {}\nexport const bar = 2;\n",
    "src/a.ts": 'import { foo } from "./b";\nfoo();\n',
    "src/c.ts": 'import { bar } from "./b.js";\nbar;\n',
    "README.md": "# r\n",
  };
  const trunkOf = (t: Trunk) => (path: Path) => t.blob(path);
  const read = (t: Trunk, ps: Proposal[], memo?: ExportMemo, waitMs?: number) => exportImports(() => t.index, t.source(), ps, trunkOf(t), memo, waitMs);
  const plan = (t: Trunk, ps: Proposal[], input: ExportImports | null | undefined) =>
    planCycle([ps.map((p) => ({ p, base: p.writeSet.map((w) => ({ path: w.path, blob: t.blob(w.path) })) }))], trunkOf(t), undefined, undefined, undefined, input);

  it("reads nothing in a cycle that changes no trunk script file", async () => {
    const t = new Trunk(FILES);
    expect(await read(t, [prop("p", { "README.md": t.stage("# s\n"), "src/new.ts": t.stage("export const n = 1;\n"), "src/a.ts": null })])).toBeUndefined();
    expect(t.reads).toEqual([]);
    expect(t.index.stats().sha).toBeNull();
  });

  it("reads only the changed file's versions while no name is removed, and keeps them by blob id", async () => {
    const t = new Trunk(FILES);
    const memo = new ExportMemo();
    const edit = prop("p", { "src/b.ts": t.stage("export function foo() {}\nexport const bar = 3;\nexport const baz = 4;\n") });
    const input = await read(t, [edit], memo);
    expect(input?.importers.size).toBe(0);
    expect(t.reads).toHaveLength(2);
    expect(t.index.stats().sha).toBeNull();
    expect(plan(t, [edit], input).accepted).toEqual([[edit]]);
    t.reads = [];
    await read(t, [edit], memo);
    expect(t.reads).toEqual([]);
  });

  it("finds the trunk importers of a removed name with the index and reads their imports, and the plan returns the change", async () => {
    const t = new Trunk(FILES);
    const removal = prop("d", { "src/b.ts": t.stage("export const bar = 2;\n") });
    const input = await read(t, [removal]);
    expect(t.index.stats()).toMatchObject({ sha: t.head, pending: 0 });
    expect(input?.importers).toEqual(new Map([["src/b.ts", ["src/a.ts", "src/c.ts"]]]));
    expect([...(input?.bindings.keys() ?? [])].sort()).toEqual([t.blob("src/a.ts"), t.blob("src/c.ts"), removal.writeSet[0]!.blob].sort());
    expect(plan(t, [removal], input).returned[0]).toEqual([
      { proposalId: "d", reason: "removing export foo from src/b.ts breaks the import in src/a.ts: change src/a.ts in the same change, or first" },
    ]);
    // With the importer rewritten in the same change, its new version is read and the change lands.
    const both = prop("both", { "src/b.ts": t.stage("export const bar = 2;\n"), "src/a.ts": t.stage("console.log(1);\n") });
    expect(plan(t, [both], await read(t, [both])).accepted).toEqual([[both]]);
  });

  it("finds an importer that landed after the index was built", async () => {
    const t = new Trunk({ ...FILES, "src/a.ts": "console.log(0);\n" });
    const removal = prop("d", { "src/b.ts": t.stage("export const bar = 2;\n") });
    expect(plan(t, [removal], await read(t, [removal])).accepted).toEqual([[removal]]);
    t.land({ "src/a.ts": FILES["src/a.ts"] });
    const again = prop("d2", { "src/b.ts": t.stage("export const bar = 2;\n") });
    expect(plan(t, [again], await read(t, [again])).returned[0]![0]!.reason).toBe(
      "removing export foo from src/b.ts breaks the import in src/a.ts: change src/a.ts in the same change, or first",
    );
  });

  it("sits the cycle out (null, logged) when the index is not current, and the plan lets the change land unchecked", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const t = new Trunk(FILES, { budgetBytes: 10 });
      const removal = prop("d", { "src/b.ts": t.stage("export const bar = 2;\n") });
      const input = await read(t, [removal]);
      expect(input).toBeNull();
      expect(warn.mock.calls.map((c) => JSON.parse(String(c[0])))).toEqual([
        expect.objectContaining({ ft: "export-guard-open", why: "import index not current (a budget ran out or a read failed)", files: 1 }),
      ]);
      const r = plan(t, [removal], input);
      expect(r.accepted).toEqual([[removal]]);
      expect(r.exportsUncovered).toBe(1);
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });

  it("gives up on a stalled read within its wait, then sits cycles out without reading until the pause ends", async () => {
    const t = new Trunk(FILES);
    const hanging: ImportSource = { head: () => t.head, read: () => new Promise(() => undefined) };
    const memo = new ExportMemo();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const removal = prop("d", { "src/b.ts": t.stage("export const bar = 2;\n") });
      const t0 = performance.now();
      expect(await exportImports(() => t.index, hanging, [removal], trunkOf(t), memo, 50)).toBeNull();
      expect(performance.now() - t0).toBeLessThan(1_000);
      t.reads = [];
      expect(await exportImports(() => t.index, t.source(), [removal], trunkOf(t), memo, 50)).toBeNull();
      expect(t.reads).toEqual([]);
      expect(warn.mock.calls.map((c) => (JSON.parse(String(c[0])) as { why: string }).why)).toEqual(["a blob read took longer than 50 ms", "blob reads stalled in an earlier cycle"]);
      memo.stalledUntil = 0;
      expect(await exportImports(() => t.index, t.source(), [removal], trunkOf(t), memo, 1_000)).not.toBeNull();
    } finally {
      warn.mockRestore();
    }
  });
});
