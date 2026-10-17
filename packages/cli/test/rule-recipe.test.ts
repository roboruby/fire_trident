import { describe, expect, it } from "vitest";
import { helpText, parseCommand } from "../src/args.ts";
import { planRequest } from "../src/api.ts";
import { colors } from "../src/format.ts";
import { parseRuleRecipe, ruleRecipeLines } from "../src/recipe.ts";

/** `ft rule ... --recipe` (target items that carry recipes, packages/worker/src/colony/rulerecipe.ts). */

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

const ADD = ["rule", "add", "web", "--pattern", "\\bcompose\\b", "--include", "src/**", "--hint", "call it assemble", "--description", "No identifier compose in src"];

describe("ft rule --recipe", () => {
  it("sends the rule's recipe with the rule, its scope the rule's globs unless --recipe-scope names others", () => {
    const cmd = parsed([...ADD, "--recipe", "rename compose assemble"]);
    expect(cmd).toMatchObject({ name: "rule-add", recipe: { kind: "rename-identifier", args: { from: "compose", to: "assemble" } } });
    expect(planRequest(cmd, "maya")).toMatchObject({
      method: "POST",
      path: "/api/colonies/web/rules",
      body: { kind: "forbid-pattern", description: "No identifier compose in src", approvedBy: "maya", recipe: { kind: "rename-identifier", args: { from: "compose", to: "assemble" } } },
    });
    expect((planRequest(cmd, "maya")!.body as { recipe: { scope?: string[] } }).recipe.scope).toBeUndefined();
    const scoped = parsed([...ADD, "--recipe", "rename-identifier compose assemble", "--recipe-scope", "src/**", "--recipe-scope", "test/**"]);
    expect(planRequest(scoped, "maya")).toMatchObject({ body: { recipe: { scope: ["src/**", "test/**"] } } });
    const boundary = parsed(["rule", "import-boundary", "web", "--from", "src/**", "--module", "^lodash$", "--hint", "use lodash-es", "--description", "No lodash", "--recipe", "replace-import lodash lodash-es"]);
    expect(planRequest(boundary, "maya")).toMatchObject({ body: { kind: "forbid-import", recipe: { kind: "replace-import", args: { from: "lodash", to: "lodash-es" } } } });
    expect(planRequest(parsed(ADD), "maya")!.body).not.toHaveProperty("recipe");
  });

  it("says how to write --recipe when it cannot be read", () => {
    expect(error([...ADD, "--recipe", "rename compose"])).toMatch(/--recipe rename takes the old name and the new one/);
    expect(error([...ADD, "--recipe", "prettier"])).toMatch(/^unknown recipe "prettier": --recipe 'rename <old> <new>'/);
    expect(error([...ADD, "--recipe-scope", "src/**"])).toMatch(/--recipe-scope goes with --recipe/);
    expect(parseRuleRecipe("replace-import @a/x @b/x prefix", [])).toEqual({ kind: "replace-import", args: { from: "@a/x", to: "@b/x", prefix: true } });
    expect(parseRuleRecipe("text-replace foo bar", ["cfg/**"])).toEqual({ kind: "text-replace", args: { find: "foo", replace: "bar" }, scope: ["cfg/**"] });
    expect(helpText("rule")).toContain("--recipe '<kind> <args>'");
  });

  it("prints what the recipe took on, or why it did not run", () => {
    expect(ruleRecipeLines({ recipe: { id: "rcp_1", recipe: { kind: "rename-identifier", args: { from: "compose", to: "assemble" } }, files: 12, violations: 40, state: "running" } }, "web", c)).toEqual([
      "  recipe rcp_1 rename-identifier compose to assemble takes 40 violations in 12 files: no agent intent for those, only for what it leaves",
      "  Follow it: ft recipe web rcp_1",
    ]);
    expect(ruleRecipeLines({ recipe: { recipe: { kind: "rename-identifier", args: { from: "a", to: "b" } }, skipped: "no file the rule finds lies in the recipe's scope, so the recipe was not run" } }, "web", c)).toEqual([
      "  recipe rename-identifier a to b: no file the rule finds lies in the recipe's scope, so the recipe was not run",
    ]);
    expect(ruleRecipeLines({ rule: {} }, "web", c)).toEqual([]);
  });
});
