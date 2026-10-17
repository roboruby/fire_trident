import { describe, expect, it } from "vitest";
import { blobId } from "@fire_trident/core";
import type { FileVersion, Id, Landing, LineageNote, Path, Proposal, Sha } from "@fire_trident/core";
import { planCycle, type PlanProposal } from "../../src/trunk/plan.ts";
import { RECIPE_BATCH_FILES, liveRecipes, migrateRecipes, recipeRecord, recipeStep, recipesFor, recordRecipe, type RecipeHost } from "../../src/trunk/recipes.ts";
import { FROM, RENAME, TO, agentEdits, renamedFiles, sceneData, sceneProject, seedChunks } from "../../../../scripts/scene_project.ts";

/**
 * The finals' rename scene (scripts/scene_rename.rb) at its full size, through the trunk writer's own code: the recipe's
 * landing steps over the shop's three hundred files, then one landing cycle (planCycle) of the thirty agents' changes
 * written on the trunk before the rename, with commutation. What staging is asked to show: every change lands with the
 * new name, none goes back, and no file names the old one. The project comes from scripts/scene_project.ts.
 */

/** The part of node:sqlite these tests use (the worker compiles against workers types, not Node's). */
interface DatabaseSync {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  exec(sql: string): void;
}
const SQLITE = "node:sqlite";
const { DatabaseSync } = (await import(SQLITE)) as { DatabaseSync: new (path: string) => DatabaseSync };

const enc = new TextEncoder();
const WORD = new RegExp(`(?<![\\w$])${FROM}(?![\\w$])`);

/** A trunk in memory for the recipe's landing steps: files by path, texts by blob, the landing log and the recipe tables. */
class Trunk implements RecipeHost {
  readonly sql: RecipeHost["sql"];
  readonly landings: Landing[] = [];
  readonly texts = new Map<Sha, string>();
  readonly index = new Map<Path, Sha>();
  head = "0".repeat(40);
  private n = 0;

  constructor(files: Record<Path, string>) {
    const db = new DatabaseSync(":memory:");
    this.sql = {
      exec(query: string, ...bindings: unknown[]) {
        const rows = db.prepare(query).all(...bindings);
        return { toArray: () => rows };
      },
    };
    db.exec("CREATE TABLE ft_landings (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, trunk_sha TEXT NOT NULL, parent_sha TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL)");
    migrateRecipes(this.sql);
    for (const [path, text] of Object.entries(files)) this.index.set(path, this.blob(text));
    this.record("lnd_seed", []);
  }

  blob(text: string): Sha {
    const id = blobId(text);
    this.texts.set(id, text);
    return id;
  }

  at = (path: Path): Sha | null => this.index.get(path) ?? null;

  text(path: Path): string {
    return this.texts.get(this.index.get(path)!)!;
  }

  now(): number {
    return 1_000 + this.n;
  }

  files(): Array<{ path: Path; blob: Sha; size: number }> {
    return [...this.index].map(([path, blob]) => ({ path, blob, size: enc.encode(this.texts.get(blob)!).length }));
  }

  async read(blob: Sha): Promise<Uint8Array | null> {
    const t = this.texts.get(blob);
    return t === undefined ? null : enc.encode(t);
  }

  private record(id: Id, paths: Path[]): Landing {
    const parent = this.head;
    this.head = (++this.n).toString(16).padStart(40, "a");
    const landing = { id, colonyId: "scene", trunkSha: this.head, parentSha: parent, proposalIds: [], intentIds: [], paths, regions: [], at: this.now() } as unknown as Landing;
    this.sql.exec("INSERT INTO ft_landings (id, trunk_sha, parent_sha, at, data) VALUES (?, ?, ?, ?, '{}')", id, this.head, parent, landing.at);
    this.landings.push(landing);
    return landing;
  }

  async commit(c: { files: Array<{ path: Path; content: string; expect: Sha }>; message: string; note: LineageNote & Record<string, unknown>; intentIds: Id[] }): Promise<{ landing: Landing } | { stale: string }> {
    for (const f of c.files) if (this.index.get(f.path) !== f.expect) return { stale: `${f.path} changed since` };
    for (const f of c.files) this.index.set(f.path, this.blob(f.content));
    return { landing: this.record(`lnd_r${this.landings.length}`, c.files.map((f) => f.path)) };
  }

  landingSeq(landingId: Id): number | null {
    return (this.sql.exec("SELECT seq FROM ft_landings WHERE id = ?", landingId).toArray()[0] as { seq: number } | undefined)?.seq ?? null;
  }

  headSeq(): number {
    return (this.sql.exec("SELECT MAX(seq) AS seq FROM ft_landings").toArray()[0] as { seq: number | null }).seq ?? 0;
  }
}

describe("the scene's project", () => {
  it("is the same on every call: three hundred files, 212 that name formatPrice, a seed in five inline-sized chunks", () => {
    const a = sceneData();
    const b = sceneData();
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(Object.keys(a.files)).toHaveLength(300);
    expect(a.users).toHaveLength(212);
    expect(Object.keys(a.renamed)).toEqual(a.users);
    expect(a.seed.map((c) => c.length)).toEqual([60, 60, 60, 60, 60]);
    expect(a.seed.flat()).toEqual(Object.keys(a.files));
    for (const chunk of a.seed) expect(enc.encode(chunk.map((p) => a.files[p]).join("")).length).toBeLessThan(400 * 1024);
    // The name is code only: no comment or string of the project names it, so the rename leaves no file naming it.
    for (const text of Object.values(a.renamed)) expect(text).not.toMatch(WORD);
    expect(a.edits).toHaveLength(30);
    expect(a.edits.flatMap((e) => e.files.map((f) => f.path))).toHaveLength(40);
    expect(new Set(a.edits.flatMap((e) => e.files.map((f) => f.path))).size).toBe(40);
    expect(seedChunks(sceneProject().files)).toEqual(a.seed);
  });

  it("gives every agent an edit that changes a line calling formatPrice, and lands as that edit with the new name", () => {
    const project = sceneProject();
    for (const e of agentEdits(project)) {
      for (const f of e.files) {
        const changed = f.after.split("\n").filter((l) => !f.before.split("\n").includes(l));
        expect(changed.some((l) => WORD.test(l))).toBe(true);
        expect(f.landed).not.toMatch(WORD);
        expect(f.landed).toBe(f.after.replace(new RegExp(WORD.source, "g"), TO));
      }
    }
  });
});

describe("the rename scene at its full size, through the trunk writer's code", () => {
  it("lands the rename in three batches of at most 100 files, then lands all thirty changes built before it with the new name", async () => {
    const data = sceneData();
    const trunk = new Trunk(data.files);
    const base = trunk.head;

    // The person's recipe: the trunk writer lands it a batch at a time (RECIPE_BATCH_FILES files read each).
    recordRecipe(trunk.sql, { id: "rcp_scene", colonyId: "scene", intentId: "int_recipe", recipe: RENAME, why: data.recipeWhy, by: "person" }, trunk.now());
    const kinds: string[] = [];
    for (let i = 0; i < 10; i++) {
      const step = await recipeStep(trunk);
      kinds.push(step.kind);
      if (step.kind === "done" || step.kind === "idle") break;
    }
    expect(kinds).toEqual(["landed", "landed", "landed", "done"]);
    const record = recipeRecord(trunk.sql, "rcp_scene")!;
    expect(record).toMatchObject({ state: "landed", examined: 297, changed: 212, untransformed: [] });
    expect(record.batches.map((b) => b.files)).toEqual([RECIPE_BATCH_FILES, RECIPE_BATCH_FILES, 97]);
    for (const path of Object.keys(data.files)) expect(trunk.text(path)).toBe(data.renamed[path] ?? data.files[path]);

    // The thirty agents propose the edits they held on the trunk before the rename: one cycle, commutation on.
    const entries: PlanProposal[] = data.edits.map((e) => {
      const p: Proposal = {
        id: `prp_${e.agent}`,
        colonyId: "scene",
        intentId: `int_${e.agent}`,
        agentId: `agt_${e.agent}`,
        workspace: { namespace: "ft-ws-0", name: `ws-${e.agent}`, remote: "https://example.invalid/ws.git" },
        baseSha: base,
        headSha: "f".repeat(40),
        writeSet: e.files.map((f) => ({ path: f.path, blob: trunk.blob(f.after) })),
        readSet: [...e.files.map((f) => ({ path: f.path, blob: trunk.blob(f.before) })), { path: "src/lib/price.ts", blob: trunk.blob(data.files["src/lib/price.ts"]!) }],
        declared: { footprint: e.files.map((f) => f.path), summary: e.title },
        evidence: { checks: [] },
        status: "ready",
        createdAt: 0,
      };
      const baseVersions: FileVersion[] = e.files.map((f) => ({ path: f.path, blob: blobId(f.before) }));
      return { p, base: baseVersions };
    });
    const live = recipesFor(trunk.sql, entries.map((x) => x.p), liveRecipes(trunk.sql));
    expect(live.size).toBe(30);
    const plan = planCycle([entries], trunk.at, undefined, undefined, undefined, undefined, { later: (p) => live.get(p.id), text: (b) => trunk.texts.get(b) ?? null, blobOf: (t) => trunk.blob(t) });
    expect(plan.returned).toEqual([[]]);
    expect(plan.accepted[0]).toHaveLength(30);
    for (const e of data.edits) {
      const landed = plan.accepted[0]!.find((p) => p.id === `prp_${e.agent}`)!;
      expect(landed.writeSet).toEqual(e.files.map((f) => ({ path: f.path, blob: blobId(f.landed) })));
      expect(plan.recipes?.get(landed.id)).toEqual([{ recipe: "rcp_scene", landing: expect.stringMatching(/^lnd_r/), paths: e.files.map((f) => f.path) }]);
      // The text it lands is the one the recipe made of its edit.
      for (const f of e.files) expect(plan.mergedTexts.get(blobId(f.landed))).toBe(f.landed);
    }

    // Trunk after both: no file names the old name.
    for (const w of plan.accepted[0]!.flatMap((p) => p.writeSet)) trunk.index.set(w.path, w.blob!);
    const naming = [...trunk.index].filter(([, blob]) => WORD.test(trunk.texts.get(blob) ?? plan.mergedTexts.get(blob) ?? ""));
    expect(naming).toEqual([]);
    expect(Object.keys(renamedFiles(sceneProject()))).toHaveLength(212);
  });
});
