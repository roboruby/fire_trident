import { describe, expect, it } from "vitest";
import type { Landing, LineageNote, RecipeRecord } from "@fire_trident/core";
import { helpText, parseCommand } from "../src/args.ts";
import { planRequest } from "../src/api.ts";
import { colors, formatWhy } from "../src/format.ts";
import { formatRecipe } from "../src/recipe.ts";

/** `ft recipe` (recipes, packages/worker/src/trunk/recipes.ts): declare, list, show, approve. */

const c = colors(false);

function parsed(argv: string[]) {
  const r = parseCommand(argv);
  if (!r.ok) throw new Error(r.error);
  return r.command;
}

function error(argv: string[]): string {
  const r = parseCommand(argv);
  if (r.ok) throw new Error(`parsed: ${JSON.stringify(r.command)}`);
  return r.error;
}

const RECORD: RecipeRecord = {
  id: "rcp_1",
  colonyId: "web",
  intentId: "int_1",
  recipe: { kind: "rename-identifier", version: "1", args: { from: "compose", to: "assemble" }, scope: ["src/**"] },
  why: "w",
  by: "matt",
  state: "landed",
  at: 1,
  updatedAt: 2,
  cursor: "src/z.ts",
  batches: [{ landingId: "lnd_1", trunkSha: "abcdef0123".padEnd(40, "0"), from: null, through: "src/z.ts", files: 40, changed: 12, at: 2 }],
  examined: 40,
  changed: 12,
  untransformed: [{ path: "src/app.tsx", reason: "out-of-language", detail: "JSX" }],
};

describe("ft recipe", () => {
  it("declares a rename over a scope, with a why of its own when none is given", () => {
    const cmd = parsed(["recipe", "web", "rename", "compose", "assemble", "--scope", "src/**"]);
    expect(cmd).toEqual({ name: "recipe", colony: "web", action: "declare", kind: "rename-identifier", args: { from: "compose", to: "assemble" }, scope: ["src/**"] });
    expect(planRequest(cmd, "maya")).toEqual({
      method: "POST",
      path: "/api/colonies/web/recipes",
      body: { kind: "rename-identifier", args: { from: "compose", to: "assemble" }, scope: ["src/**"], why: "rename-identifier compose to assemble across src/**, declared from the CLI", by: "maya" },
    });
    const why = parsed(["recipe", "web", "rename", "a", "b", "--scope", "src/**", "--scope", "test/**", "--why", "One name.", "--by", "lee"]);
    expect(planRequest(why, "maya")).toMatchObject({ body: { scope: ["src/**", "test/**"], why: "One name.", by: "lee" } });
  });

  it("declares replace-import and text-replace recipes", () => {
    expect(parsed(["recipe", "web", "replace-import", "./old/", "./new/", "--prefix", "--scope", "src/**"])).toMatchObject({ kind: "replace-import", args: { from: "./old/", to: "./new/", prefix: true } });
    expect(parsed(["recipe", "web", "text-replace", "--find", "v1", "--replace", "v2", "--scope", "*.json"])).toMatchObject({ kind: "text-replace", args: { find: "v1", replace: "v2" } });
    expect(parsed(["recipe", "web", "text-replace", "--pattern", "^a$", "--replace", "b", "--ignore-case", "--scope", "*.yml"])).toMatchObject({ args: { pattern: "^a$", replace: "b", flags: "i" } });
  });

  it("lists, shows and approves", () => {
    expect(planRequest(parsed(["recipe", "web"]), "maya")).toEqual({ method: "GET", path: "/api/colonies/web/recipes" });
    expect(planRequest(parsed(["recipe", "web", "rcp_1"]), "maya")).toEqual({ method: "GET", path: "/api/colonies/web/recipes/rcp_1" });
    expect(planRequest(parsed(["recipe", "web", "approve", "rcp_1"]), "maya")).toEqual({ method: "POST", path: "/api/colonies/web/recipes/rcp_1/approve", body: { by: "maya" } });
  });

  it("says what is missing", () => {
    expect(error(["recipe"])).toMatch(/missing <colony>/);
    expect(error(["recipe", "web", "rename", "a", "b"])).toMatch(/--scope/);
    expect(error(["recipe", "web", "rename", "a", "--scope", "src/**"])).toMatch(/rename takes the old name and the new one/);
    expect(error(["recipe", "web", "text-replace", "--replace", "x", "--scope", "x"])).toMatch(/--find .* or --pattern/);
    expect(error(["recipe", "web", "rename", "a", "b", "--scope", "x", "--prefix"])).toMatch(/--prefix does not apply to rename/);
    expect(error(["recipe", "web", "fold"])).toMatch(/unknown recipe action "fold"/);
    expect(error(["recipe", "web", "approve"])).toMatch(/name the recipe to approve/);
  });

  it("shows where a recipe stands, what it left, and what it would still change on trunk", () => {
    const shown = formatRecipe(parsed(["recipe", "web", "rcp_1"]) as never, { record: RECORD, residue: { examined: 40, rewrite: [], untransformed: [{ path: "src/app.tsx", reason: "out-of-language" }] } }, c);
    expect(shown).toContain("rcp_1  landed  rename-identifier compose to assemble over src/**  (intent int_1)");
    expect(shown).toContain("1 batch landed: 12 files rewritten of 40 read");
    expect(shown).toContain("left as they were: src/app.tsx (out-of-language)");
    expect(shown).toContain("on trunk now: nothing left to rewrite in 40 scope files read, 1 it leaves as they are");
    const held = formatRecipe(parsed(["recipe", "web"]) as never, [{ ...RECORD, state: "held" }], c);
    expect(held).toMatch(/^rcp_1\s+held for a person\s+rename-identifier compose to assemble/);
    const declared = formatRecipe(parsed(["recipe", "web", "rename", "a", "b", "--scope", "x"]) as never, { intent: { id: "int_1", title: "Recipe: rename-identifier a to b" }, recipe: { ...RECORD, state: "held", reason: "a danger pattern", held: { hits: ["capability (process) at src/a.ts:1: x"], paths: ["src/a.ts"] } } }, c);
    expect(declared).toContain("approve exactly this output: ft recipe web approve rcp_1");
    expect(helpText("recipe")).toContain("ft recipe <colony> rename <old> <new> --scope <glob>...");
  });

  it("names the recipe in ft why: on its own batch, and on a change that landed with it applied", () => {
    const landing = (id: string): Landing => ({ id, colonyId: "web", trunkSha: "1".repeat(40), parentSha: "0".repeat(40), proposalIds: [], intentIds: ["int_1"], paths: ["src/a.ts"], regions: ["src"], at: 0 });
    const batch: LineageNote = {
      schema: "firetrident.lineage/v1",
      landingId: "lnd_r",
      colonyId: "web",
      proposals: [],
      recipe: { id: "rcp_1", intentId: "int_1", kind: "rename-identifier", version: "1", args: { from: "compose", to: "assemble" }, scope: ["src/**"], why: "One name.", by: "matt", batch: 1, from: null, through: "src/z.ts", outputs: [{ path: "src/a.ts", before: "a".repeat(40), after: "b".repeat(40) }], untransformed: [] },
    };
    const text = formatWhy({ path: "src/a.ts" }, [{ landing: landing("lnd_r"), note: batch }], {}, c, 0);
    expect(text).toContain("recipe   rcp_1 rename-identifier compose to assemble, declared by matt");
    expect(text).toContain("batch    1: 1 file rewritten through src/z.ts");
    expect(text).toContain("Matt declared recipe rcp_1, which the trunk writer ran.");
    const change: LineageNote = {
      schema: "firetrident.lineage/v1",
      landingId: "lnd_2",
      colonyId: "web",
      proposals: [{ id: "prp_1", agentId: "agt_1", agentKind: "synthetic", intent: { id: "int_2", title: "Add a value", why: "" }, writeSet: [{ path: "src/a.ts", blob: "c".repeat(40) }], readSet: [], decisions: [], evidence: { checks: [] }, recipes: [{ recipe: "rcp_1", landing: "lnd_r", paths: ["src/a.ts"] }] }],
    };
    expect(formatWhy({ path: "src/a.ts" }, [{ landing: landing("lnd_2"), note: change }], {}, c, 0)).toContain("recipe   rcp_1 (landing lnd_r) rewrote src/a.ts as it landed: built before the recipe, it landed with it applied");
  });
});
