import { describe, expect, it } from "vitest";
import { blobId, parseRecipe } from "@fire_trident/core";
import type { Id, Landing, LineageNote, NoteRecipe, Path, Recipe, Sha } from "@fire_trident/core";
import { applyTreeChanges, buildTree, commitTree, diffTrees, ensureRepo, memoryFs, readLocalBlob, writeCommitObject, writeLocalBlob, type GitRepo, type PathChange } from "../../src/artifacts/git.ts";
import {
  RECIPE_BATCH_FILES,
  approveRecipe,
  driveRecipes,
  liveRecipes,
  migrateRecipes,
  nextBatch,
  recipeRecord,
  recipeResidue,
  recipeReverted,
  recipeStep,
  recipesFor,
  recordRecipe,
  type RecipeHost,
  type RecipeRunner,
  type RecipeStep,
} from "../../src/trunk/recipes.ts";
import { sandboxOutputs } from "../../src/trunk/reciperunner.ts";

/** The part of node:sqlite these tests use (the worker compiles against workers types, not Node's). */
interface DatabaseSync {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  exec(sql: string): void;
}
const SQLITE = "node:sqlite";
const { DatabaseSync } = (await import(SQLITE)) as { DatabaseSync: new (path: string) => DatabaseSync };

const enc = new TextEncoder();
const dec = new TextDecoder();

function recipe(input: Record<string, unknown>, modules = false): Recipe {
  const r = parseRecipe(input, { modules });
  if (!r.ok) throw new Error(r.error);
  return r.recipe;
}

const RENAME = recipe({ kind: "rename-identifier", args: { from: "compose", to: "assemble" }, scope: ["src/**"] });

/**
 * A trunk in memory as the trunk writer keeps it for recipes: a git repository (real trees and commits), its index
 * (ft_files), the landing log (ft_landings) and the recipe tables, and a commit that refuses a stale file and records
 * the landing the way systemCommitNow does. Every commit's lineage note is kept.
 */
class Trunk implements RecipeHost {
  readonly sql: RecipeHost["sql"];
  readonly notes = new Map<Id, LineageNote & { recipe?: NoteRecipe }>();
  readonly landings: Landing[] = [];
  readonly repo: GitRepo = { fs: memoryFs(), dir: "/trunk", cache: {} };
  runner?: RecipeRunner;
  head = "";
  private tree = "";
  private n = 0;
  private readonly db: DatabaseSync;

  constructor() {
    this.db = new DatabaseSync(":memory:");
    const db = this.db;
    this.sql = {
      exec(query: string, ...bindings: unknown[]) {
        const rows = db.prepare(query).all(...bindings);
        return { toArray: () => rows };
      },
    };
    db.exec("CREATE TABLE ft_files (path TEXT PRIMARY KEY, blob TEXT NOT NULL, size INTEGER NOT NULL, mode TEXT NOT NULL)");
    db.exec("CREATE TABLE ft_landings (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, trunk_sha TEXT NOT NULL, parent_sha TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL)");
    migrateRecipes(this.sql);
  }

  /** Seed trunk with these files as its first commit. */
  async seed(files: Record<Path, string | Uint8Array>): Promise<void> {
    await ensureRepo(this.repo, "https://example.invalid/git/ns/trunk.git");
    const entries = new Map<string, { blob: string; mode: string }>();
    for (const [path, content] of Object.entries(files)) {
      const bytes = typeof content === "string" ? enc.encode(content) : content;
      const blob = await writeLocalBlob(this.repo, bytes);
      entries.set(path, { blob, mode: "100644" });
      this.sql.exec("INSERT OR REPLACE INTO ft_files (path, blob, size, mode) VALUES (?, ?, ?, '100644')", path, blob, bytes.length);
    }
    this.tree = await buildTree(this.repo, entries);
    this.head = await writeCommitObject(this.repo, { tree: this.tree, parents: [], message: "seed", at: 1_000 });
  }

  now(): number {
    return 10_000 + this.n;
  }

  files(): Array<{ path: Path; blob: Sha; size: number }> {
    return this.sql.exec("SELECT path, blob, size FROM ft_files").toArray() as Array<{ path: Path; blob: Sha; size: number }>;
  }

  async read(blob: Sha): Promise<Uint8Array | null> {
    return readLocalBlob(this.repo, blob).catch(() => null);
  }

  blobOf(path: Path): Sha | null {
    return (this.sql.exec("SELECT blob FROM ft_files WHERE path = ?", path).toArray()[0] as { blob: string } | undefined)?.blob ?? null;
  }

  async text(path: Path): Promise<string | null> {
    const blob = this.blobOf(path);
    return blob === null ? null : dec.decode(await readLocalBlob(this.repo, blob));
  }

  async commit(c: { files: Array<{ path: Path; content: string; expect: Sha }>; message: string; note: LineageNote & Record<string, unknown>; intentIds: Id[] }): Promise<{ landing: Landing } | { stale: string }> {
    for (const f of c.files) if (this.blobOf(f.path) !== f.expect) return { stale: `${f.path} changed since` };
    const changes = new Map<string, PathChange>();
    for (const f of c.files) {
      const bytes = enc.encode(f.content);
      const blob = await writeLocalBlob(this.repo, bytes);
      changes.set(f.path, { blob, mode: "100644" });
      this.sql.exec("INSERT OR REPLACE INTO ft_files (path, blob, size, mode) VALUES (?, ?, ?, '100644')", f.path, blob, bytes.length);
    }
    const parent = this.head;
    this.tree = await applyTreeChanges(this.repo, this.tree, changes);
    this.n++;
    this.head = await writeCommitObject(this.repo, { tree: this.tree, parents: [parent], message: c.message, at: this.now() });
    const id = `lnd_${this.n}`;
    const paths = [...changes.keys()].sort();
    const landing: Landing = { id, colonyId: "c", trunkSha: this.head, parentSha: parent, proposalIds: [], intentIds: c.intentIds, paths, regions: [], at: this.now() };
    this.sql.exec("INSERT INTO ft_landings (id, trunk_sha, parent_sha, at, data) VALUES (?, ?, ?, ?, ?)", id, this.head, parent, landing.at, JSON.stringify(landing));
    this.notes.set(id, { ...(c.note as LineageNote & { recipe?: NoteRecipe }), landingId: id, colonyId: "c" });
    this.landings.push(landing);
    return { landing };
  }

  landingSeq(landingId: Id): number | null {
    return (this.sql.exec("SELECT seq FROM ft_landings WHERE id = ?", landingId).toArray()[0] as { seq: number } | undefined)?.seq ?? null;
  }

  headSeq(): number {
    return (this.sql.exec("SELECT MAX(seq) AS seq FROM ft_landings").toArray()[0] as { seq: number | null } | undefined)?.seq ?? 0;
  }

  /** The files a commit changed against its parent, with their texts after. */
  async diff(landing: Landing): Promise<Record<Path, string | null>> {
    const before = await commitTree(this.repo, landing.parentSha);
    const after = await commitTree(this.repo, landing.trunkSha);
    const out: Record<Path, string | null> = {};
    for (const d of await diffTrees(this.repo, before, after)) out[d.path] = d.after ? dec.decode(await readLocalBlob(this.repo, d.after.blob)) : null;
    return out;
  }

  declare(id: Id, r: Recipe, why = "Rename compose to assemble: the old name reads as a verb on data."): void {
    recordRecipe(this.sql, { id, colonyId: "c", intentId: `int_${id}`, recipe: r, why, by: "matt" }, this.now());
  }

  /** Run steps until the recipe is no longer running; the steps in order. */
  async run(max = 20): Promise<RecipeStep[]> {
    const steps: RecipeStep[] = [];
    for (let i = 0; i < max; i++) {
      const s = await recipeStep(this);
      steps.push(s);
      if (s.kind === "idle" || s.kind === "done" || s.kind === "held" || s.kind === "failed") break;
    }
    return steps;
  }
}

const CORE = 'export function compose(f, g) {\n  return (x) => f(g(x));\n}\n// compose stays in this comment\n';
const USE = 'import { compose } from "./core.ts";\nexport const twice = (f) => compose(f, f);\nexport const label = "compose";\n';

describe("landing a recipe over a fixture trunk", () => {
  it("lands one tree-surgery commit whose diff is the rename, and a note with the recipe, the output blobs and the files it left", async () => {
    const t = new Trunk();
    await t.seed({ "src/core.ts": CORE, "src/use.ts": USE, "src/broken.ts": "const s = 'open;\ncompose();\n", "src/logo.png": new Uint8Array([137, 80, 78, 71, 0, 1]), "src/notes.md": "compose\n", "lib/other.ts": "compose();\n" });
    const before = { core: t.blobOf("src/core.ts")!, use: t.blobOf("src/use.ts")! };
    t.declare("rcp_1", RENAME);
    const steps = await t.run();
    expect(steps.map((s) => s.kind)).toEqual(["landed", "done"]);
    const landing = (steps[0] as Extract<RecipeStep, { kind: "landed" }>).landing;
    expect(landing.intentIds).toEqual(["int_rcp_1"]);
    // Stock git sees an ordinary diff: the two files the rename changed, and nothing else.
    expect(await t.diff(landing)).toEqual({
      "src/core.ts": CORE.replace("function compose", "function assemble"),
      "src/use.ts": USE.replace("{ compose }", "{ assemble }").replace("=> compose(f, f)", "=> assemble(f, f)"),
    });
    expect(await t.text("lib/other.ts")).toBe("compose();\n");
    const note = t.notes.get(landing.id)!;
    expect(note.proposals).toEqual([]);
    expect(note.recipe).toMatchObject({
      id: "rcp_1",
      intentId: "int_rcp_1",
      kind: "rename-identifier",
      version: "1",
      args: { from: "compose", to: "assemble" },
      scope: ["src/**"],
      by: "matt",
      batch: 1,
      from: null,
      through: "src/use.ts",
      outputs: [
        { path: "src/core.ts", before: before.core, after: t.blobOf("src/core.ts") },
        { path: "src/use.ts", before: before.use, after: t.blobOf("src/use.ts") },
      ],
    });
    expect(note.recipe!.untransformed).toEqual([
      { path: "src/broken.ts", reason: "unparsable", detail: "an unterminated string at line 1" },
      { path: "src/logo.png", reason: "binary", detail: "not UTF-8 text" },
      { path: "src/notes.md", reason: "out-of-language", detail: "not a JavaScript or TypeScript file" },
    ]);
    const record = recipeRecord(t.sql, "rcp_1")!;
    expect(record).toMatchObject({ state: "landed", examined: 5, changed: 2, cursor: "src/use.ts", batches: [{ landingId: landing.id, from: null, through: "src/use.ts", files: 5, changed: 2 }] });
    expect(record.untransformed.map((u) => u.path)).toEqual(["src/broken.ts", "src/logo.png", "src/notes.md"]);
    // What it would still change on trunk now: nothing; the files it cannot read stay listed.
    const residue = await recipeResidue(t, record);
    expect(residue).toMatchObject({ examined: 5, rewrite: [], truncated: false });
    // The plain grep still finds the old name where the rename leaves it: a comment, a string, a file it could not read.
    expect(residue.grep).toEqual(["src/broken.ts", "src/core.ts", "src/notes.md", "src/use.ts"]);
  });

  it("spans several commits when its scope is past one batch's read budget, landing cycles running between them", async () => {
    const t = new Trunk();
    const files: Record<Path, string> = {};
    const count = RECIPE_BATCH_FILES + 30;
    for (let i = 0; i < count; i++) files[`src/m${String(i).padStart(3, "0")}.ts`] = `export const v${i} = compose(${i});\n`;
    await t.seed(files);
    expect(nextBatch(t.files(), RENAME, null)).toHaveLength(RECIPE_BATCH_FILES);
    t.declare("rcp_big", RENAME);
    const steps = await t.run();
    expect(steps.map((s) => s.kind)).toEqual(["landed", "landed", "done"]);
    const record = recipeRecord(t.sql, "rcp_big")!;
    expect(record.batches.map((b) => [b.from, b.through, b.changed])).toEqual([
      [null, "src/m099.ts", RECIPE_BATCH_FILES],
      ["src/m099.ts", "src/m129.ts", 30],
    ]);
    expect(t.notes.get(record.batches[1]!.landingId)!.recipe).toMatchObject({ batch: 2, from: "src/m099.ts", through: "src/m129.ts" });
    for (const path of Object.keys(files)) expect(await t.text(path)).not.toMatch(/\bcompose\b/);
  });

  it("drives batches on the serial chain until done, telling the colony of each, and leaves the rest to the alarm past its time", async () => {
    const t = new Trunk();
    const files: Record<Path, string> = {};
    for (let i = 0; i < RECIPE_BATCH_FILES + 1; i++) files[`src/f${String(i).padStart(3, "0")}.ts`] = "compose();\n";
    await t.seed(files);
    t.declare("rcp_d", RENAME);
    const told: string[] = [];
    const later: number[] = [];
    let serial = 0;
    let clock = 0;
    const driver = {
      host: () => t,
      serial: async <T>(fn: () => Promise<T>) => {
        serial++;
        return fn();
      },
      landed: async () => undefined,
      tell: async (s: Exclude<RecipeStep, { kind: "idle" }>) => {
        told.push(s.kind);
      },
      later: async (ms: number) => {
        later.push(ms);
      },
      now: () => clock++,
      paused: () => null,
    };
    await driveRecipes(driver, 0);
    expect(told).toEqual(["landed"]);
    expect(later).toEqual([1_000]);
    await driveRecipes(driver, Number.MAX_SAFE_INTEGER);
    expect(told).toEqual(["landed", "landed", "done"]);
    expect(serial).toBe(4);
    // A pause holds recipes: nothing runs, and the alarm looks again later.
    t.declare("rcp_p", recipe({ kind: "text-replace", args: { find: "assemble", replace: "build" }, scope: ["src/**"] }));
    await driveRecipes({ ...driver, paused: () => "paused by matt" }, Number.MAX_SAFE_INTEGER);
    expect(recipeRecord(t.sql, "rcp_p")!.batches).toEqual([]);
    expect(later.at(-1)).toBe(30_000);
  });

  it("runs every batch twice and lands nothing when the two runs differ (the determinism check)", async () => {
    const t = new Trunk();
    await t.seed({ "src/a.ts": "compose();\n" });
    let calls = 0;
    t.runner = {
      run: async (_r, files) => files.map((f) => ({ ok: true as const, text: `${f.text ?? ""}// run ${++calls}\n` })),
    };
    t.declare("rcp_m", recipe({ kind: "module", args: { source: "export function transform(p, t) { return t + Math.random(); }" }, scope: ["src/**"] }, true));
    const steps = await t.run();
    expect(steps.map((s) => s.kind)).toEqual(["failed"]);
    expect(recipeRecord(t.sql, "rcp_m")!.reason).toMatch(/different outputs for the same files on two runs, so it is not deterministic/);
    expect(t.landings).toEqual([]);
    expect(calls).toBe(2);
  });

  it("lands a module recipe whose two sandbox runs agree, and names its source by blob id in the note", async () => {
    const t = new Trunk();
    await t.seed({ "src/a.ts": "compose();\n" });
    t.runner = { run: async (_r, files) => files.map((f) => ({ ok: true as const, text: (f.text ?? "").toUpperCase() })) };
    const source = "export function transform(p, t) { return t.toUpperCase(); }";
    t.declare("rcp_up", recipe({ kind: "module", args: { source }, scope: ["src/**"] }, true));
    const steps = await t.run();
    expect(steps.map((s) => s.kind)).toEqual(["landed", "done"]);
    expect(await t.text("src/a.ts")).toBe("COMPOSE();\n");
    expect(t.notes.get(t.landings[0]!.id)!.recipe!.args).toEqual({ source: blobId(source) });
  });

  it("holds a batch whose output has a danger pattern for a person, and lands exactly that output once they approve", async () => {
    const t = new Trunk();
    await t.seed({ "src/run.ts": 'import { run } from "./safe-shell";\nrun("ls");\n' });
    t.declare("rcp_x", recipe({ kind: "text-replace", args: { find: "./safe-shell", replace: "child_process" }, scope: ["src/**"] }));
    let steps = await t.run();
    expect(steps.map((s) => s.kind)).toEqual(["held"]);
    const held = recipeRecord(t.sql, "rcp_x")!;
    expect(held.state).toBe("held");
    expect(held.held!.paths).toEqual(["src/run.ts"]);
    expect(held.held!.hits.join(" ")).toMatch(/capability/);
    expect(held.reason).toMatch(/danger pattern.*approve the recipe to land exactly this output/);
    expect(t.landings).toEqual([]);
    expect(approveRecipe(t.sql, "rcp_x", "matt", 20_000)!.state).toBe("running");
    steps = await t.run();
    expect(steps.map((s) => s.kind)).toEqual(["landed", "done"]);
    expect(t.notes.get(t.landings[0]!.id)!.recipe!.approved).toMatchObject({ by: "matt", at: 20_000 });
    expect(await t.text("src/run.ts")).toContain('from "child_process"');
  });

  it("holds again when the output differs from the one a person approved", async () => {
    const t = new Trunk();
    await t.seed({ "src/run.ts": 'import { run } from "./safe-shell";\n' });
    t.declare("rcp_y", recipe({ kind: "text-replace", args: { find: "./safe-shell", replace: "child_process" }, scope: ["src/**"] }));
    await t.run();
    approveRecipe(t.sql, "rcp_y", "matt", 20_000);
    // Trunk moved before the approved batch ran: a different output is a new hold.
    await t.commit({ files: [{ path: "src/run.ts", content: 'import { run } from "./safe-shell";\nrun("rm");\n', expect: t.blobOf("src/run.ts")! }], message: "x", note: { schema: "firetrident.lineage/v1", landingId: "", colonyId: "", proposals: [] }, intentIds: [] });
    const steps = await t.run();
    expect(steps.map((s) => s.kind)).toEqual(["held"]);
  });

  it("stops a recipe a person reverted one batch of: it lands no more and is applied to no change", async () => {
    const t = new Trunk();
    await t.seed({ "src/a.ts": "compose();\n" });
    t.declare("rcp_r", RENAME);
    await t.run();
    expect(liveRecipes(t.sql).map((r) => r.id)).toEqual(["rcp_r"]);
    const landing = t.landings[0]!;
    expect(recipeReverted(t.sql, landing.id, 30_000)).toBe("rcp_r");
    expect(recipeReverted(t.sql, "lnd_other", 30_000)).toBeNull();
    const record = recipeRecord(t.sql, "rcp_r")!;
    expect(record).toMatchObject({ state: "failed", batches: [{ landingId: landing.id, reverted: true }] });
    expect(record.reason).toMatch(/a person reverted its landing/);
    expect(liveRecipes(t.sql)).toEqual([]);
  });
});

describe("which changes in flight get a recipe applied", () => {
  it("those whose base is older than the recipe's completion, and every one while it still lands", async () => {
    const t = new Trunk();
    await t.seed({ "src/a.ts": "compose();\n", "src/b.ts": "x();\n" });
    const seedSha = t.head;
    t.declare("rcp_w", RENAME);
    await t.run();
    const recipeSha = t.landings[0]!.trunkSha;
    // A landing after the recipe completed.
    await t.commit({ files: [{ path: "src/b.ts", content: "y();\n", expect: t.blobOf("src/b.ts")! }], message: "later", note: { schema: "firetrident.lineage/v1", landingId: "", colonyId: "", proposals: [] }, intentIds: [] });
    const laterSha = t.head;
    const change = (id: string, baseSha: string, path = "src/a.ts") => ({ id, baseSha, writeSet: [{ path, blob: "1".repeat(40) }], readSet: [] });
    const got = recipesFor(t.sql, [change("old", seedSha), change("unknown", "f".repeat(40)), change("same", recipeSha), change("newer", laterSha), change("outside", seedSha, "lib/a.ts")]);
    expect([...got.keys()].sort()).toEqual(["old", "unknown"]);
    expect(got.get("old")![0]).toMatchObject({ id: "rcp_w", landingId: t.landings[0]!.id, doneSeq: 1 });
    // A recipe still landing applies to every change in its scope.
    const running = liveRecipes(t.sql).map((r) => ({ ...r, doneSeq: null }));
    expect([...recipesFor(t.sql, [change("newer", laterSha)], running).keys()]).toEqual(["newer"]);
  });
});

describe("module recipes' sandbox answers", () => {
  it("takes one output per file, each a text or a known refusal, and nothing else", () => {
    expect(sandboxOutputs([{ ok: true, text: "a" }, { ok: false, reason: "unparsable", detail: "x" }], 2)).toEqual([
      { ok: true, text: "a" },
      { ok: false, reason: "unparsable", detail: "x" },
    ]);
    expect(sandboxOutputs([{ ok: true, text: "a" }], 2)).toBeNull();
    expect(sandboxOutputs([{ ok: false, reason: "made-up" }], 1)).toBeNull();
    expect(sandboxOutputs({ outputs: [] }, 0)).toBeNull();
  });
});
