import { describe, expect, it } from "vitest";
import { landingAnswerable } from "../src/answerable.ts";
import { RECIPE_VERSIONS, applyRecipe, parseRecipe, recipeCovers, recipeNames, recipeText, sameOutputs, scopeFootprint, type RecipeOutput } from "../src/recipe.ts";
import type { Recipe } from "../src/types.ts";

function recipe(input: Record<string, unknown>): Recipe {
  const r = parseRecipe(input);
  if (!r.ok) throw new Error(r.error);
  return r.recipe;
}

const rename = recipe({ kind: "rename-identifier", args: { from: "compose", to: "assemble" }, scope: ["src/**"] });

function out(r: Recipe, path: string, text: string | null): string {
  const o = applyRecipe(r, path, text);
  if (!o.ok) throw new Error(`refused: ${o.reason}: ${o.detail}`);
  return o.text;
}

function refusal(r: Recipe, path: string, text: string | null): Extract<RecipeOutput, { ok: false }> {
  const o = applyRecipe(r, path, text);
  if (o.ok) throw new Error(`transformed: ${o.text}`);
  return o;
}

describe("parseRecipe", () => {
  it("pins a recipe declared without a version to its kind's version", () => {
    expect(rename).toEqual({ kind: "rename-identifier", version: RECIPE_VERSIONS["rename-identifier"], args: { from: "compose", to: "assemble" }, scope: ["src/**"] });
    expect(recipe({ kind: "text-replace", args: { find: "a", replace: "b" }, scope: "config/*.yml" }).scope).toEqual(["config/*.yml"]);
  });

  it("refuses another version than the one this build runs, saying which it runs", () => {
    const r = parseRecipe({ kind: "rename-identifier", version: "2", args: { from: "a", to: "b" }, scope: ["src/**"] });
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/at version 1 here, and a recipe pinned to version 2 is refused, never run/) });
  });

  it("refuses names that are not identifiers, reserved words, and a rename to the same name", () => {
    expect(parseRecipe({ kind: "rename-identifier", args: { from: "a-b", to: "c" }, scope: ["x"] }).ok).toBe(false);
    expect(parseRecipe({ kind: "rename-identifier", args: { from: "class", to: "c" }, scope: ["x"] })).toMatchObject({ error: expect.stringMatching(/reserved word/) });
    expect(parseRecipe({ kind: "rename-identifier", args: { from: "a", to: "a" }, scope: ["x"] })).toMatchObject({ error: "from and to are the same name" });
    expect(parseRecipe({ kind: "rename-identifier", args: { from: "a", to: "b", extra: "x" }, scope: ["x"] })).toMatchObject({ error: expect.stringMatching(/unknown argument extra/) });
  });

  it("refuses a scope that leaves the repository or names nothing", () => {
    expect(parseRecipe({ kind: "rename-identifier", args: { from: "a", to: "b" }, scope: [] }).ok).toBe(false);
    expect(parseRecipe({ kind: "rename-identifier", args: { from: "a", to: "b" }, scope: ["../x/**"] }).ok).toBe(false);
    expect(parseRecipe({ kind: "rename-identifier", args: { from: "a", to: "b" }, scope: ["/etc/**"] }).ok).toBe(false);
  });

  it("takes only patterns anchored to whole lines, without nested quantifiers", () => {
    const pattern = (p: string) => parseRecipe({ kind: "text-replace", args: { pattern: p, replace: "x" }, scope: ["x"] });
    expect(pattern("node: 18").ok).toBe(false);
    expect(pattern("^(a+)+$")).toMatchObject({ error: expect.stringMatching(/exponential time/) });
    expect(pattern("^([a-z]$")).toMatchObject({ error: expect.stringMatching(/not a valid regular expression/) });
    expect(pattern("^(\\s*)node: 18$").ok).toBe(true);
    expect(parseRecipe({ kind: "text-replace", args: { find: "a", pattern: "^a$", replace: "x" }, scope: ["x"] }).ok).toBe(false);
  });

  it("refuses module recipes unless they are on", () => {
    const module = { kind: "module", args: { source: "export function transform(p, t) { return t; }" }, scope: ["src/**"] };
    expect(parseRecipe(module)).toMatchObject({ ok: false, error: expect.stringMatching(/FT_RECIPE_MODULES/) });
    expect(parseRecipe(module, { modules: true }).ok).toBe(true);
  });
});

describe("rename-identifier", () => {
  const scoped = (scope: string[]) => recipe({ kind: "rename-identifier", args: { from: "compose", to: "assemble" }, scope });

  it("renames the export declaration, imports and every reference", () => {
    const src = [
      'import { compose } from "./compose.ts";',
      "export function compose(a: Fn, b: Fn): Fn {",
      "  return (x) => a(b(x));",
      "}",
      "export const twice = (f: Fn) => compose(f, f);",
      "export type Composer = typeof compose;",
      "export default compose;",
      "",
    ].join("\n");
    expect(out(rename, "src/index.ts", src)).toBe(src.replaceAll("compose(", "assemble(").replace("{ compose }", "{ assemble }").replace("typeof compose", "typeof assemble").replace("default compose", "default assemble"));
  });

  it("leaves strings, template text, comments, regular expressions and property reads", () => {
    const src = [
      "// compose is the old name",
      "/* compose */",
      "const s = 'compose' + \"compose\";",
      "const t = `compose ${compose(a)} compose`;",
      "const r = /compose/g;",
      "const p = obj.compose + obj?.compose + this.compose;",
      "class A { #compose = 1; }",
      "compose();",
    ].join("\n");
    const want = src.replace("${compose(a)}", "${assemble(a)}").replace(/^compose\(\);$/m, "assemble();");
    expect(out(rename, "src/a.ts", src)).toBe(want);
  });

  it("leaves object keys, methods, class members, interface and type members, and enum members", () => {
    const src = [
      "const o = { compose: 1, compose() {}, get compose() { return compose; }, [compose]: 2 };",
      "class C {\n  compose = compose;\n  static compose() {}\n}",
      "interface I { compose: string; other?: compose }",
      "type T = {\n  compose: number\n  value: compose\n};",
      "enum E { compose = 1, b }",
    ].join("\n");
    const want = [
      "const o = { compose: 1, compose() {}, get compose() { return assemble; }, [assemble]: 2 };",
      "class C {\n  compose = assemble;\n  static compose() {}\n}",
      "interface I { compose: string; other?: assemble }",
      "type T = {\n  compose: number\n  value: assemble\n};",
      "enum E { compose = 1, b }",
    ].join("\n");
    expect(out(rename, "src/a.ts", src)).toBe(want);
  });

  it("keeps a shorthand property's key, in literals and in destructuring", () => {
    expect(out(rename, "src/a.ts", "export const api = { compose, other };")).toBe("export const api = { compose: assemble, other };");
    expect(out(rename, "src/a.ts", "const { compose = id } = lib;")).toBe("const { compose: assemble = id } = lib;");
    expect(out(rename, "src/a.ts", "function f({ compose }: Opts) { return compose; }")).toBe("function f({ compose: assemble }: Opts) { return assemble; }");
  });

  it("keeps the imported name of a module outside the scope and renames the local one", () => {
    expect(out(rename, "src/a.ts", 'import { compose } from "fp-lib";\ncompose();')).toBe('import { compose as assemble } from "fp-lib";\nassemble();');
    expect(out(rename, "src/a.ts", 'import { compose as c } from "fp-lib";\nc();')).toBe('import { compose as c } from "fp-lib";\nc();');
    expect(out(rename, "src/a.ts", 'import { pipe as compose } from "fp-lib";\ncompose();')).toBe('import { pipe as assemble } from "fp-lib";\nassemble();');
    // A relative module the scope does not cover is outside too.
    expect(out(scoped(["src/app/**"]), "src/app/a.ts", 'import { compose } from "../lib/fp";')).toBe('import { compose as assemble } from "../lib/fp";');
    expect(out(rename, "src/a.ts", 'export { compose } from "fp-lib";')).toBe('export { compose as assemble } from "fp-lib";');
  });

  it("renames both sides of specifiers from a module in scope, and member reads through its namespace", () => {
    expect(out(rename, "src/a.ts", 'import { compose as c } from "./fp.js";')).toBe('import { assemble as c } from "./fp.js";');
    expect(out(rename, "src/a.ts", 'export { compose } from "./fp";\nexport { local as compose };')).toBe('export { assemble } from "./fp";\nexport { local as assemble };');
    expect(out(rename, "src/a.ts", 'import * as fp from "./fp";\nimport * as ext from "fp-lib";\nfp.compose(ext.compose);')).toBe(
      'import * as fp from "./fp";\nimport * as ext from "fp-lib";\nfp.assemble(ext.compose);',
    );
  });

  it("tells division from a regular expression", () => {
    expect(out(rename, "src/a.ts", "const x = compose / 2 / compose;\nif (a) {}\n/compose/.test(s);")).toBe("const x = assemble / 2 / assemble;\nif (a) {}\n/compose/.test(s);");
    expect(out(rename, "src/a.ts", "const x = { a: 1 } / compose;")).toBe("const x = { a: 1 } / assemble;");
  });

  it("leaves a file that already uses the new name as an identifier (name-taken), but not one that only has it as a property", () => {
    expect(refusal(rename, "src/a.ts", "const assemble = 1;\ncompose();")).toMatchObject({ reason: "name-taken" });
    expect(out(rename, "src/a.ts", "obj.assemble = compose;")).toBe("obj.assemble = assemble;");
  });

  it("says why it cannot read a file: unparsable (with the line), binary, out of language", () => {
    expect(refusal(rename, "src/a.ts", "const s = 'open;\ncompose();")).toEqual({ ok: false, reason: "unparsable", detail: "an unterminated string at line 1" });
    expect(refusal(rename, "src/a.ts", "function f() {\n  compose();\n")).toMatchObject({ reason: "unparsable", detail: expect.stringMatching(/unclosed \{ at line 1/) });
    expect(refusal(rename, "src/a.ts", "const a = `x ${compose}")).toMatchObject({ reason: "unparsable" });
    expect(refusal(rename, "src/a.ts", null)).toMatchObject({ reason: "binary" });
    expect(refusal(rename, "src/a.tsx", "compose();")).toMatchObject({ reason: "out-of-language", detail: expect.stringMatching(/JSX/) });
    expect(refusal(rename, "src/a.css", ".compose {}")).toMatchObject({ reason: "out-of-language" });
  });

  it("is a no-op on a file without the name, and applying it twice changes nothing more", () => {
    const src = "export const x = compose(a);\n";
    const once = out(rename, "src/a.ts", src);
    expect(out(rename, "src/a.ts", once)).toBe(once);
    expect(out(rename, "src/b.ts", "const y = 1;\n")).toBe("const y = 1;\n");
  });
});

describe("replace-import", () => {
  it("rewrites a module specifier where it names a module, and nowhere else", () => {
    const r = recipe({ kind: "replace-import", args: { from: "lodash", to: "lodash-es" }, scope: ["**"] });
    const src = "import x from 'lodash';\nimport('lodash');\nconst y = require(\"lodash\");\nexport * from \"lodash\";\nimport 'lodash';\nconst s = 'lodash';\nfoo.require('lodash');\n";
    const want = "import x from 'lodash-es';\nimport('lodash-es');\nconst y = require(\"lodash-es\");\nexport * from \"lodash-es\";\nimport 'lodash-es';\nconst s = 'lodash';\nfoo.require('lodash');\n";
    expect(out(r, "src/a.js", src)).toBe(want);
  });

  it("rewrites the start of every specifier that has it with prefix", () => {
    const r = recipe({ kind: "replace-import", args: { from: "./old/", to: "./new/", prefix: true }, scope: ["**"] });
    expect(out(r, "src/a.ts", "import a from './old/a';\nimport b from './older';")).toBe("import a from './new/a';\nimport b from './older';");
  });
});

describe("text-replace", () => {
  it("replaces every occurrence of an exact string in any text file", () => {
    const r = recipe({ kind: "text-replace", args: { find: "v1", replace: "v2" }, scope: ["**"] });
    expect(out(r, "config/a.json", '{"a":"v1","b":"v1"}')).toBe('{"a":"v2","b":"v2"}');
    expect(refusal(r, "img.png", null)).toMatchObject({ reason: "binary" });
  });

  it("applies an anchored pattern line by line, keeping line endings", () => {
    const r = recipe({ kind: "text-replace", args: { pattern: "^(\\s*)node: 18$", replace: "$1node: 20" }, scope: ["**"] });
    expect(out(r, "ci.yml", "a:\n  node: 18\r\n  node: 18 # pinned\n")).toBe("a:\n  node: 20\r\n  node: 18 # pinned\n");
  });
});

describe("recipe helpers", () => {
  it("compares two runs exactly (the determinism check)", () => {
    const files: Array<[string, string]> = [["src/a.ts", "compose();"], ["src/b.ts", "x = 'open"]];
    const run = () => files.map(([p, t]) => applyRecipe(rename, p, t));
    expect(sameOutputs(run(), run())).toBe(true);
    expect(sameOutputs(run(), [{ ok: true, text: "assemble();" }, { ok: true, text: "" }])).toBe(false);
  });

  it("renames imported names, covers paths by its scope, and names its footprint", () => {
    expect(recipeNames(rename, ["compose", "pipe"])).toEqual(["assemble", "pipe"]);
    expect(recipeCovers(rename, "src/deep/a.ts")).toBe(true);
    expect(recipeCovers(rename, "lib/a.ts")).toBe(false);
    expect(scopeFootprint(["src/**", "lib/*.ts", "**/*.md"])).toEqual(["src", "lib", "**/*.md"]);
    expect(recipeText(rename)).toBe("rename-identifier compose to assemble");
  });

  it("makes the person who declared a recipe answerable for its batches", () => {
    const note = { schema: "firetrident.lineage/v1", landingId: "lnd_r", colonyId: "c", proposals: [], recipe: { id: "rcp_1", by: "maya" } };
    expect(landingAnswerable(note)).toMatchObject({ answer: "person", who: "maya", why: "declared recipe rcp_1, which the trunk writer ran" });
  });
});
