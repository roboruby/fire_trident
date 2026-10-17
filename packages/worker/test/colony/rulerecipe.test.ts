import { describe, expect, it } from "vitest";
import { checkFile } from "@fire_trident/core";
import type { ColonyEvent, Landing, Recipe, RecipeRecord, Rule } from "@fire_trident/core";
import type { ViolationIntentDraft } from "../../src/colony/logic.ts";
import { migrateIntentRecipes, recipeNews, type RecipeColonyHost } from "../../src/colony/recipe.ts";
import { mechanicalShare, ruleRecipe, ruleRecipeNews, ruleRecipeState, ruleScope, splitViolations, startRuleRecipe, type RuleRecipeHost } from "../../src/colony/rulerecipe.ts";

/** The part of node:sqlite these tests use (the worker compiles against workers types, not Node's). */
interface DatabaseSync {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  exec(sql: string): void;
}
const SQLITE = "node:sqlite";
const { DatabaseSync } = (await import(SQLITE)) as { DatabaseSync: new (path: string) => DatabaseSync };

const INTENTS = `CREATE TABLE intents (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, why TEXT NOT NULL, source TEXT NOT NULL, rule_id TEXT, parent_id TEXT,
  footprint TEXT NOT NULL, acceptance TEXT, priority REAL NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL, assigned_to TEXT, violations INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)`;
const RULES = "CREATE TABLE rules (id TEXT PRIMARY KEY, open_violations INTEGER NOT NULL DEFAULT 0)";

const RULE: Rule = {
  id: "rul_1",
  colonyId: "web",
  kind: "forbid-pattern",
  spec: { pattern: "\\bcompose\\b", include: ["src/**"], hint: "call it assemble" },
  description: "No identifier compose in src",
  approvedBy: "matt",
  createdAt: 1,
};

/** Trunk: four files use compose; one keeps it in a comment after the rename, one already has assemble (the rename leaves it). */
const TRUNK: Record<string, string> = {
  "src/a.ts": "export function compose(x: number) {\n  return x;\n}\n",
  "src/b.ts": 'import { compose } from "./a.ts";\nexport const b = compose(1) + compose(2);\n',
  "src/c.ts": 'import { compose } from "./a.ts";\n// compose is the old name\nexport const c = compose(3);\n',
  "src/d.ts": 'import { compose } from "./a.ts";\nconst assemble = 1;\nexport const d = compose(assemble);\n',
  "lib/e.ts": "export const compose = 5;\n",
};

function record(over: Partial<RecipeRecord>): RecipeRecord {
  return {
    id: "rcp_x",
    colonyId: "web",
    intentId: "int_x",
    recipe: { kind: "rename-identifier", version: "1", args: { from: "compose", to: "assemble" }, scope: ["src/**"] },
    why: "w",
    by: "matt",
    state: "running",
    at: 1,
    updatedAt: 1,
    cursor: null,
    batches: [],
    examined: 0,
    changed: 0,
    untransformed: [],
    ...over,
  };
}

/** A colony around a rule's recipe: intents and rules tables in memory, a trunk of files, and what it declared and published. */
function colony(trunkTakes: boolean | "throws" = true) {
  const db = new DatabaseSync(":memory:");
  db.exec(INTENTS);
  db.exec(RULES);
  const sql = {
    exec: (q: string, ...b: unknown[]) => {
      const rows = db.prepare(q).all(...b);
      return { toArray: () => rows };
    },
  };
  migrateIntentRecipes(sql);
  const files: Record<string, string | null> = { ...TRUNK };
  const asked: Array<{ id: string; intentId: string; recipe: Recipe }> = [];
  const declared: ViolationIntentDraft[][] = [];
  const events: ColonyEvent[] = [];
  const bumps = new Map<string, number>();
  const metrics = (): Record<string, number> => Object.fromEntries(bumps);
  let recipeHost: RecipeColonyHost;
  const host: RuleRecipeHost = {
    sql,
    now: () => 1_000,
    recipes: () => recipeHost,
    rule: (id) => (id === RULE.id ? RULE : null),
    readFile: async (path) => files[path] ?? null,
    declareIntents: async (_rule, drafts) => {
      declared.push(drafts);
      return drafts.length;
    },
    publish: (e) => events.push(...e),
    violationsEvent: (at) => {
      const rows = sql.exec("SELECT id, open_violations FROM rules").toArray() as Array<{ id: string; open_violations: number }>;
      return { t: "violations", at, total: rows.reduce((n, r) => n + r.open_violations, 0), byRule: Object.fromEntries(rows.map((r) => [r.id, r.open_violations])) };
    },
    bump: (name, delta) => bumps.set(name, (bumps.get(name) ?? 0) + delta),
  };
  recipeHost = {
    sql,
    colonyId: "web",
    now: () => 1_000,
    modules: false,
    trunk: () => ({
      recipe: async (p) => {
        if (trunkTakes === "throws") throw new Error("trunk is not initialized");
        asked.push(p);
        // The rule's recipe is recorded as waiting before the trunk writer is asked, so batches it lands meanwhile count.
        expect(ruleRecipeState(sql, RULE.id)).toMatchObject({ recipeId: p.id, intentId: p.intentId, state: "running", waiting: 4 });
        return record({ id: p.id, intentId: p.intentId, recipe: p.recipe });
      },
    }),
    publish: () => undefined,
    bump: () => undefined,
    onLanding: async (l) => {
      for (const id of l.intentIds) sql.exec("UPDATE intents SET status = 'landed' WHERE id = ?", id);
    },
    withdraw: async (id) => {
      sql.exec("UPDATE intents SET status = 'withdrawn' WHERE id = ?", id);
    },
    intentStatus: (id) => (sql.exec("SELECT status FROM intents WHERE id = ?", id).toArray()[0] as { status: string } | undefined)?.status ?? null,
    afterNews: (r, l) => ruleRecipeNews(host, r, l),
  };
  const violations = Object.entries(TRUNK).flatMap(([path, content]) => checkFile(RULE, path, content));
  const total = violations.length;
  sql.exec("INSERT INTO rules (id, open_violations) VALUES (?, ?)", RULE.id, total);
  const open = () => (sql.exec("SELECT open_violations FROM rules WHERE id = ?", RULE.id).toArray()[0] as { open_violations: number }).open_violations;
  const intent = (id: string) => sql.exec("SELECT * FROM intents WHERE id = ?", id).toArray()[0] as Record<string, unknown> | undefined;
  return { host, recipeHost, sql, files, asked, declared, events, metrics, violations, open, intent };
}

/** A batch landing of the recipe that rewrote `paths` (trunk already holds their new text). */
function landing(id: string, intentId: string, paths: string[]): Landing {
  return { id, colonyId: "web", trunkSha: "1".repeat(40), parentSha: "0".repeat(40), proposalIds: [], intentIds: [intentId], paths, regions: ["src"], at: 5 };
}

describe("a rule's recipe", () => {
  it("is read with the rule's globs as its scope, and refused with a sentence when it cannot run", () => {
    expect(ruleScope(RULE)).toEqual(["src/**"]);
    expect(ruleScope({ kind: "forbid-import", spec: { from: "src/ui/**" } })).toEqual(["src/ui/**"]);
    expect(ruleScope({ kind: "forbid-pattern", spec: {} })).toEqual(["**"]);
    expect(ruleRecipe({ kind: "rename-identifier", args: { from: "compose", to: "assemble" } }, RULE, false)).toEqual({ kind: "rename-identifier", version: "1", args: { from: "compose", to: "assemble" }, scope: ["src/**"] });
    expect(ruleRecipe(undefined, RULE, false)).toBeNull();
    expect(() => ruleRecipe({ kind: "rename-identifier", args: { from: "compose", to: "compose" } }, RULE, false)).toThrow(/the rule's recipe is refused: from and to are the same name/);
    expect(() => ruleRecipe({ kind: "module", args: { source: "x" } }, RULE, false)).toThrow(/module recipes are off/);
  });

  it("takes the violations in its scope; the others become intents at once", () => {
    const c = colony();
    const recipe = ruleRecipe({ kind: "rename-identifier", args: { from: "compose", to: "assemble" } }, RULE, false)!;
    const split = splitViolations(recipe, c.violations);
    expect(split.now).toEqual([]);
    expect([...split.later.keys()].sort()).toEqual(["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]);
    const narrow = splitViolations({ ...recipe, scope: ["src/b.ts", "src/c.ts"] }, c.violations);
    expect([...new Set(narrow.now.map((v) => v.path))].sort()).toEqual(["src/a.ts", "src/d.ts"]);
  });

  it("lands directly as the rule's, counts violations off batch by batch, and declares intents only for the residue", async () => {
    const c = colony();
    const recipe = ruleRecipe({ kind: "rename-identifier", args: { from: "compose", to: "assemble" } }, RULE, false)!;
    const split = splitViolations(recipe, c.violations);
    const before = c.open();
    expect(before).toBe(8);
    const started = await startRuleRecipe(c.host, RULE, recipe, split.later);
    expect(started).toMatchObject({ id: c.asked[0]!.id, intentId: c.asked[0]!.intentId, files: 4, violations: 8, state: "running" });
    // Its intent is the rule's, declared by the rule's approver: it answers to them, and no agent takes it.
    expect(c.intent(started.intentId!)).toMatchObject({ source: "rule", rule_id: RULE.id, created_by: "matt", status: "proposed", violations: 0 });

    // Batch 1 rewrote a.ts and b.ts: every match gone from both.
    c.files["src/a.ts"] = TRUNK["src/a.ts"]!.replace("compose", "assemble");
    c.files["src/b.ts"] = TRUNK["src/b.ts"]!.replaceAll("compose", "assemble");
    await recipeNews(c.recipeHost, { record: record({ id: started.id!, intentId: started.intentId!, batches: [{ landingId: "lnd_1", trunkSha: "1".repeat(40), from: null, through: "src/b.ts", files: 2, changed: 2, at: 5 }] }), landing: landing("lnd_1", started.intentId!, ["src/a.ts", "src/b.ts"]) });
    expect(c.open()).toBe(before - 3);
    expect(c.events.at(-1)).toMatchObject({ t: "violations", total: 5, byRule: { rul_1: 5 } });
    // The same news again changes nothing (a batch counts once, a count is set, not subtracted twice).
    await recipeNews(c.recipeHost, { record: record({ id: started.id!, intentId: started.intentId!, batches: [] }), landing: landing("lnd_1", started.intentId!, ["src/a.ts", "src/b.ts"]) });
    expect(c.open()).toBe(5);

    // Batch 2 rewrote c.ts, whose comment still says compose; d.ts already used assemble, so the recipe left it.
    c.files["src/c.ts"] = 'import { assemble } from "./a.ts";\n// compose is the old name\nexport const c = assemble(3);\n';
    await recipeNews(c.recipeHost, { record: record({ id: started.id!, intentId: started.intentId!, batches: [] }), landing: landing("lnd_2", started.intentId!, ["src/c.ts"]) });
    expect(c.open()).toBe(3);
    expect(c.declared).toEqual([]);

    // The recipe ends: the residue (c.ts's comment, all of d.ts) becomes one intent per file, and only that.
    await recipeNews(c.recipeHost, { record: record({ id: started.id!, intentId: started.intentId!, state: "landed", batches: [{ landingId: "lnd_1", trunkSha: "1".repeat(40), from: null, through: "src/c.ts", files: 3, changed: 3, at: 5 }] }) });
    expect(c.declared).toHaveLength(1);
    expect(c.declared[0]!.map((d) => [d.path, d.violations])).toEqual([
      ["src/c.ts", 1],
      ["src/d.ts", 2],
    ]);
    expect(c.declared[0]![1]!.why).toBe("No identifier compose in src.\nHint: call it assemble\n2 violations on lines 1, 3.");
    expect(c.open()).toBe(3);
    expect(ruleRecipeState(c.sql, RULE.id)).toMatchObject({ state: "done", fixed: 5, waiting: 0, residue: 2 });
    // Told again of the end, it declares nothing more.
    await recipeNews(c.recipeHost, { record: record({ id: started.id!, intentId: started.intentId!, state: "landed" }) });
    expect(c.declared).toHaveLength(1);
    // The mechanical share: two batches, three files, five violations fixed, at no model call.
    expect(mechanicalShare(c.metrics())).toEqual({ landings: 2, files: 3, violations: 5, reproducedLines: 0 });
  });

  it("declares every waiting violation as an intent when the trunk writer does not take the recipe", async () => {
    const c = colony("throws");
    const recipe = ruleRecipe({ kind: "rename-identifier", args: { from: "compose", to: "assemble" } }, RULE, false)!;
    const started = await startRuleRecipe(c.host, RULE, recipe, splitViolations(recipe, c.violations).later);
    expect(started).toMatchObject({ files: 4, violations: 8, intents: 4, skipped: expect.stringMatching(/^the trunk writer did not take the recipe \(trunk is not initialized\), so every violation got an intent$/) });
    expect(c.declared[0]!.map((d) => d.path).sort()).toEqual(["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]);
    expect(ruleRecipeState(c.sql, RULE.id)).toBeNull();
  });

  it("does not run when nothing in its scope violates the rule", async () => {
    const c = colony();
    const recipe = ruleRecipe({ kind: "rename-identifier", args: { from: "compose", to: "assemble" }, scope: ["docs/**"] }, RULE, false)!;
    const started = await startRuleRecipe(c.host, RULE, recipe, splitViolations(recipe, c.violations).later);
    expect(started).toMatchObject({ files: 0, violations: 0, skipped: expect.stringMatching(/not run/) });
    expect(c.asked).toEqual([]);
    expect(mechanicalShare({})).toBeNull();
  });
});
