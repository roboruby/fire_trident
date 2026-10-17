import { describe, expect, it } from "vitest";
import type { Landing, Recipe, RecipeRecord } from "@fire_trident/core";
import { createApi, type ApiDeps } from "../../src/api/app.ts";
import { declareRecipe, intentRecipe, migrateIntentRecipes, recipeNews, type RecipeColonyHost } from "../../src/colony/recipe.ts";
import type { Env } from "../../src/env.ts";

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

function record(over: Partial<RecipeRecord>): RecipeRecord {
  return {
    id: "rcp_1",
    colonyId: "web",
    intentId: "int_1",
    recipe: { kind: "rename-identifier", version: "1", args: { from: "a", to: "b" }, scope: ["src/**"] },
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

/** A colony's recipe door over an intents table in memory, recording what it asked of the trunk writer and itself. */
function colony(trunk: (p: { id: string; intentId: string; recipe: Recipe; why: string; by: string }) => Promise<RecipeRecord>) {
  const db = new DatabaseSync(":memory:");
  db.exec(INTENTS);
  const sql = {
    exec: (q: string, ...b: unknown[]) => {
      const rows = db.prepare(q).all(...b);
      return { toArray: () => rows };
    },
  };
  migrateIntentRecipes(sql);
  const asked: Array<{ id: string; intentId: string; recipe: Recipe; why: string; by: string }> = [];
  const withdrawn: Array<[string, string]> = [];
  const landed: Landing[] = [];
  const events: unknown[] = [];
  const host: RecipeColonyHost = {
    sql,
    colonyId: "web",
    now: () => 1_000,
    modules: false,
    trunk: () => ({
      recipe: async (p) => {
        asked.push(p);
        return trunk(p);
      },
    }),
    publish: (e) => events.push(...e),
    bump: () => undefined,
    onLanding: async (l) => {
      landed.push(l);
      sql.exec("UPDATE intents SET status = 'landed' WHERE id = ?", l.intentIds[0]);
    },
    withdraw: async (id, reason) => {
      withdrawn.push([id, reason]);
      sql.exec("UPDATE intents SET status = 'withdrawn' WHERE id = ?", id);
    },
    intentStatus: (id) => (sql.exec("SELECT status FROM intents WHERE id = ?", id).toArray()[0] as { status: string } | undefined)?.status ?? null,
  };
  const row = (id: string) => sql.exec("SELECT * FROM intents WHERE id = ?", id).toArray()[0] as Record<string, unknown> | undefined;
  return { host, asked, withdrawn, landed, events, row };
}

describe("declaring a recipe at the colony", () => {
  it("makes it an intent with recipe set that no agent takes, and hands the parsed, pinned recipe to the trunk writer", async () => {
    const c = colony(async (p) => record({ id: p.id, intentId: p.intentId, recipe: p.recipe }));
    const res = await declareRecipe(c.host, { kind: "rename-identifier", args: { from: "compose", to: "assemble" }, scope: "src/**", why: "One name for one idea.", by: "matt" });
    expect(c.asked).toEqual([{ id: expect.stringMatching(/^rcp_/), intentId: res.intent.id, recipe: { kind: "rename-identifier", version: "1", args: { from: "compose", to: "assemble" }, scope: ["src/**"] }, why: "One name for one idea.", by: "matt" }]);
    expect(res.intent).toMatchObject({ title: "Recipe: rename-identifier compose to assemble", status: "proposed", source: "human", footprint: ["src"], createdBy: "matt", recipe: { id: c.asked[0]!.id, kind: "rename-identifier" } });
    const row = c.row(res.intent.id)!;
    expect(row.status).toBe("proposed");
    expect(row.assigned_to).toBeNull();
    expect(intentRecipe(row.recipe)).toEqual(res.intent.recipe);
    expect(c.events).toEqual([expect.objectContaining({ t: "intent", status: "proposed", intentId: res.intent.id })]);
  });

  it("refuses a recipe it cannot run, or one without a why, before anything is created", async () => {
    const c = colony(async () => record({}));
    await expect(declareRecipe(c.host, { kind: "rename-identifier", version: "9", args: { from: "a", to: "b" }, scope: ["src/**"], why: "w" })).rejects.toThrow(/pinned to version 9 is refused/);
    await expect(declareRecipe(c.host, { kind: "rename-identifier", args: { from: "a", to: "b" }, scope: ["src/**"], why: " " })).rejects.toThrow(/needs a why/);
    expect(c.asked).toEqual([]);
  });

  it("withdraws the intent when the trunk writer does not take the recipe", async () => {
    const c = colony(async () => {
      throw new Error("trunk is not initialized");
    });
    await expect(declareRecipe(c.host, { kind: "rename-identifier", args: { from: "a", to: "b" }, scope: ["src/**"], why: "w" })).rejects.toThrow(/not initialized/);
    expect(c.withdrawn).toEqual([[expect.stringMatching(/^int_/), "the trunk writer did not take the recipe: trunk is not initialized"]]);
  });
});

describe("what the trunk writer tells the colony", () => {
  it("settles a batch's landing (its intent lands with it), and withdraws the intent of a recipe that landed nothing", async () => {
    const c = colony(async (p) => record({ id: p.id, intentId: p.intentId }));
    const a = await declareRecipe(c.host, { kind: "rename-identifier", args: { from: "a", to: "b" }, scope: ["src/**"], why: "w" });
    const landing: Landing = { id: "lnd_1", colonyId: "web", trunkSha: "1".repeat(40), parentSha: "0".repeat(40), proposalIds: [], intentIds: [a.intent.id], paths: ["src/a.ts"], regions: ["src"], at: 5 };
    await recipeNews(c.host, { record: record({ intentId: a.intent.id, batches: [{ landingId: "lnd_1", trunkSha: landing.trunkSha, from: null, through: "src/a.ts", files: 1, changed: 1, at: 5 }] }), landing });
    expect(c.landed).toEqual([landing]);
    expect(c.withdrawn).toEqual([]);

    const b = await declareRecipe(c.host, { kind: "rename-identifier", args: { from: "x", to: "y" }, scope: ["src/**"], why: "w" });
    await recipeNews(c.host, { record: record({ id: "rcp_2", intentId: b.intent.id, state: "landed" }) });
    expect(c.withdrawn).toEqual([[b.intent.id, "recipe rcp_2 ran over its scope and changed no file, so there is nothing to land"]]);
    // Told again: nothing more happens.
    await recipeNews(c.host, { record: record({ id: "rcp_2", intentId: b.intent.id, state: "landed" }) });
    expect(c.withdrawn).toHaveLength(1);

    const d = await declareRecipe(c.host, { kind: "rename-identifier", args: { from: "p", to: "q" }, scope: ["src/**"], why: "w" });
    await recipeNews(c.host, { record: record({ id: "rcp_3", intentId: d.intent.id, state: "failed", reason: "not deterministic" }) });
    expect(c.withdrawn.at(-1)).toEqual([d.intent.id, "recipe rcp_3 stopped: not deterministic"]);
  });
});

describe("the recipe routes", () => {
  const deps: ApiDeps = {
    provisionTrunk: async () => {
      throw new Error("not used");
    },
    spawnSwarm: async () => undefined,
  };
  const bearer = { Authorization: "Bearer s3cret", "content-type": "application/json" };

  function env() {
    const declared: unknown[] = [];
    const approved: unknown[] = [];
    const COLONY = {
      idFromName: (n: string) => n,
      get: () => ({
        getColony: async () => ({ id: "web" }),
        declareRecipe: async (p: unknown) => {
          declared.push(p);
          return { intent: { id: "int_1" }, recipe: record({}) };
        },
      }),
    };
    const TRUNK = {
      idFromName: (n: string) => n,
      get: () => ({
        recipes: async () => [record({ recipe: { kind: "text-replace", version: "1", args: { find: "API_KEY=sk_live_abcdefghijklmnop1234", replace: "x" }, scope: ["**"] } })],
        recipeResidue: async (id: string) => (id === "rcp_1" ? { record: record({}), residue: { examined: 3, rewrite: [], untransformed: [], truncated: false } } : null),
        recipeApprove: async (id: string, by: string) => {
          approved.push([id, by]);
          return record({ state: "running" });
        },
      }),
    };
    return { env: { COLONY, TRUNK, FT_ADMIN_TOKEN: "s3cret" } as unknown as Env, declared, approved };
  }

  it("declares with the admin token only, and checks the body", async () => {
    const w = env();
    const api = createApi(deps);
    const body = JSON.stringify({ kind: "rename-identifier", args: { from: "a", to: "b" }, scope: ["src/**"], why: "w" });
    expect((await api.request("/colonies/web/recipes", { method: "POST", body, headers: { "content-type": "application/json" } }, w.env)).status).toBe(401);
    const res = await api.request("/colonies/web/recipes", { method: "POST", body, headers: bearer }, w.env);
    expect(res.status).toBe(201);
    expect(w.declared).toEqual([{ kind: "rename-identifier", args: { from: "a", to: "b" }, scope: ["src/**"], why: "w", by: "api" }]);
    const bad = await api.request("/colonies/web/recipes", { method: "POST", body: JSON.stringify({ kind: "rename-identifier", scope: ["src/**"] }), headers: bearer }, w.env);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: expect.stringMatching(/^invalid request: why/) });
  });

  it("lists recipes with secret-looking text masked, shows one with its residue, and approves a held one", async () => {
    const w = env();
    const api = createApi(deps);
    const list = (await (await api.request("/colonies/web/recipes", {}, w.env)).json()) as RecipeRecord[];
    expect(JSON.stringify(list)).not.toContain("sk_live_abcdefghijklmnop1234");
    // The residue reads the scope's files: only with the admin token.
    expect(await (await api.request("/colonies/web/recipes/rcp_1", {}, w.env)).json()).toMatchObject({ record: { id: "rcp_1" }, residue: null });
    expect(await (await api.request("/colonies/web/recipes/rcp_1", { headers: bearer }, w.env)).json()).toMatchObject({ residue: { examined: 3, rewrite: [] } });
    expect((await api.request("/colonies/web/recipes/rcp_2", {}, w.env)).status).toBe(404);
    expect((await api.request("/colonies/web/recipes/rcp_2", { headers: bearer }, w.env)).status).toBe(404);
    expect((await api.request("/colonies/web/recipes/not-a-recipe", {}, w.env)).status).toBe(404);
    const ok = await api.request("/colonies/web/recipes/rcp_1/approve", { method: "POST", headers: bearer }, w.env);
    expect(ok.status).toBe(200);
    expect(w.approved).toEqual([["rcp_1", "api"]]);
  });
});
