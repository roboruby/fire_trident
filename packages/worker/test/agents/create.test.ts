import { describe, expect, it } from "vitest";
import type { Rule } from "@fire_trident/core";
import {
  bindingProblems,
  checkWrittenFile,
  erasableProblems,
  importProblems,
  moduleExports,
  parseIntentSpec,
  resolveImport,
  ruleProblems,
  scriptProblems,
  stripJsonc,
  syntaxProblems,
  wantsErasable,
  writeOrder,
} from "../../src/agents/create.ts";

const WHY = [
  "The core feature: turn a URL into a slug. (Goal: shortlinks)",
  "",
  "Builds on: src/types.ts, ./src/http.ts",
  "Planned files: package.json, src/types.ts, src/http.ts, src/routes/create.ts",
  "",
  "Spec context (demo/new-project-spec.md):",
  "## What it is",
  "",
  "Builds on: this line is spec text, not a fact",
  "- Erasable TypeScript only.",
].join("\n");

const rule = (over: Partial<Rule> & Pick<Rule, "kind" | "spec">): Rule => ({ id: "rul_x", colonyId: "c", description: "A rule", approvedBy: "t", createdAt: 0, ...over });

const RELATIVE_TS = rule({
  id: "rul_1",
  kind: "forbid-import",
  description: "Relative imports name the .ts file",
  spec: { from: ["src/**", "test/**"], module: "^\\.\\.?/(?!.*\\.ts$)", hint: "Write ./http.ts." },
});
const NO_RANDOM = rule({
  id: "rul_2",
  kind: "forbid-pattern",
  description: "Randomness and time are injected",
  spec: { pattern: "Math\\.random\\(|Date\\.now\\(", include: ["src/**"], exclude: ["src/index.ts"], hint: "Use deps.random and deps.now." },
});

describe("parseIntentSpec", () => {
  it("reads the facts ft new writes and keeps the spec context apart", () => {
    const s = parseIntentSpec(WHY);
    expect(s.why).toBe("The core feature: turn a URL into a slug. (Goal: shortlinks)");
    expect(s.buildsOn).toEqual(["src/types.ts", "src/http.ts"]);
    expect(s.planned).toEqual(["package.json", "src/types.ts", "src/http.ts", "src/routes/create.ts"]);
    expect(s.source).toBe("demo/new-project-spec.md");
    expect(s.model).toBeNull();
    const withModel = parseIntentSpec("Wire it.\n\nScope: this intent writes src/index.ts.\nBuilds on: src/a.ts\nModel: default\n\nSpec context (x):\nModel: not a fact");
    expect(withModel).toMatchObject({ model: "default", buildsOn: ["src/a.ts"], why: "Wire it.\n\nScope: this intent writes src/index.ts." });
    expect(withModel.spec).toBe("Model: not a fact");
    expect(s.spec).toMatch(/^## What it is/);
    // A "Builds on:" line inside the spec context is not a fact.
    expect(s.spec).toContain("Builds on: this line is spec text");
  });

  it("treats a plain why as all why", () => {
    expect(parseIntentSpec("Fix the bug.\nIt matters.")).toEqual({ why: "Fix the bug.\nIt matters.", buildsOn: [], planned: [], model: null, spec: null, source: null });
    expect(parseIntentSpec("").why).toBe("");
  });
});

describe("writeOrder", () => {
  it("writes sources and configuration before tests, keeping the order otherwise", () => {
    const files = ["test/http.test.ts", "src/http.ts", "README.md", "src/x.spec.ts", "tsconfig.json"].map((path) => ({ path }));
    expect(writeOrder(files).map((f) => f.path)).toEqual(["src/http.ts", "README.md", "tsconfig.json", "test/http.test.ts", "src/x.spec.ts"]);
  });
});

describe("scriptProblems", () => {
  it("accepts well-formed TypeScript with strings, templates, regexes and comments", () => {
    const src = [
      'import { json } from "./http.ts";',
      "// a comment with ( and {",
      "/* block ( */",
      "export const re = /[)}\\]]+/g;",
      "export function f(a: number, b: string): string {",
      "  const half = a / 2 / (b.length || 1);",
      "  const t = `x ${a > 1 ? `in ${b}` : '}'} y`;",
      '  return t + "})" + String(half) + (a ? \'(\' : "]");',
      "}",
      "const isOk = (s: string) => !/^\\d+$/.test(s) && s.replace(/\\//g, '') !== '';",
      "export default { f, isOk };",
    ].join("\n");
    expect(scriptProblems(src)).toEqual([]);
  });

  it("finds unbalanced brackets, unclosed strings, templates and comments", () => {
    expect(scriptProblems("function f() {\n  return [1, 2;\n}\n")).toEqual(['line 3: "}" closes the "[" opened on line 2', 'the "{" opened on line 1 is never closed']);
    expect(scriptProblems("const a = {\n  b: 1,\n")).toEqual(['the "{" opened on line 1 is never closed']);
    expect(scriptProblems("const s = 'abc;\nconst t = 1;\n")).toEqual(["a string opened on line 1 is not closed on that line"]);
    expect(scriptProblems("const t = `abc ${x}\n")).toEqual(["a template literal opened on line 1 never ends"]);
    expect(scriptProblems("/* unterminated\nconst x = 1;")).toEqual(["a block comment opened on line 1 never ends"]);
    expect(scriptProblems("f());")).toEqual(['line 1: ")" closes nothing']);
  });
});

describe("syntaxProblems", () => {
  it("parses JSON strictly and tsconfig-style files as JSONC", () => {
    expect(syntaxProblems("package.json", '{ "name": "x", "private": true }\n')).toEqual([]);
    expect(syntaxProblems("package.json", '{ "name": "x", }\n')[0]).toMatch(/not valid JSON/);
    expect(syntaxProblems("tsconfig.json", '{\n  // strict\n  "compilerOptions": { "strict": true, },\n}\n')).toEqual([]);
    expect(syntaxProblems("wrangler.jsonc", '{ "name": "x" /* note */, "main": "src/index.ts", }')).toEqual([]);
    expect(syntaxProblems("wrangler.jsonc", '{ "name": "x" ')[0]).toMatch(/not valid JSON/);
    expect(stripJsonc('{ "url": "https://x//y", /* c */ "a": [1, 2,], }')).toBe('{ "url": "https://x//y",  "a": [1, 2] }');
  });

  it("flags leftovers of the reply format and placeholders in new files", () => {
    expect(syntaxProblems("src/a.ts", "```ts\nexport const a = 1;\n```\n")[0]).toMatch(/markdown fence/);
    expect(syntaxProblems("src/a.ts", "export const a = 1;\n</file>\n")[0]).toMatch(/<file>/);
    expect(syntaxProblems("src/a.ts", "export const a = 1;\n// ... rest of the implementation\n")[0]).toMatch(/placeholder/);
    expect(syntaxProblems("src/a.ts", "")).toEqual(["the file is empty"]);
    expect(syntaxProblems("README.md", "# x\n\n```sh\nnode --test\n```\n")).toEqual([]);
    expect(syntaxProblems(".gitignore", "node_modules\n.wrangler\n")).toEqual([]);
  });
});

describe("erasableProblems", () => {
  it("flags TypeScript that type stripping cannot run", () => {
    expect(erasableProblems("src/a.ts", "export enum Color { Red }\n")[0]).toMatch(/line 1 declares an enum/);
    expect(erasableProblems("src/a.ts", "namespace N {\n  export const x = 1;\n}\n")[0]).toMatch(/namespace/);
    expect(erasableProblems("src/a.ts", "export class S {\n  constructor(private readonly kv: KVLike, n = () => 1) {}\n}\n")[0]).toMatch(/parameter property/);
    expect(erasableProblems("src/a.ts", "import fs = require('fs');\n")[0]).toMatch(/import = require/);
  });

  it("accepts erasable forms", () => {
    const ok = [
      "declare enum Ambient { A }",
      "declare namespace NodeJS { interface X {} }",
      "export class KvStore {",
      "  private readonly kv: KVLike;",
      "  constructor(kv: KVLike, opts: { readonly x: number } = { x: 1 }) {",
      "    this.kv = kv;",
      "  }",
      "}",
      "export type Mode = 'a' | 'b';",
    ].join("\n");
    expect(erasableProblems("src/a.ts", ok)).toEqual([]);
    expect(erasableProblems("src/a.js", "enum X {}")).toEqual([]);
  });

  it("is wanted when the intent or tsconfig asks for it", () => {
    expect(wantsErasable("Erasable TypeScript only", null)).toBe(true);
    expect(wantsErasable("plain", '{ "compilerOptions": { "erasableSyntaxOnly": true } }')).toBe(true);
    expect(wantsErasable("plain", '{ "compilerOptions": {} }')).toBe(false);
  });
});

describe("imports", () => {
  const tree = new Set(["src/types.ts", "src/http.ts", "src/store/index.ts"]);
  const exists = (p: string): boolean => tree.has(p);

  it("resolves like TypeScript", () => {
    expect(resolveImport("src/routes/create.ts", "../types.ts", exists)).toBe("src/types.ts");
    expect(resolveImport("src/routes/create.ts", "../http", exists)).toBe("src/http.ts");
    expect(resolveImport("src/routes/create.ts", "../http.js", exists)).toBe("src/http.ts");
    expect(resolveImport("src/a.ts", "./store", exists)).toBe("src/store/index.ts");
    expect(resolveImport("src/a.ts", "../../x.ts", exists)).toBeNull();
  });

  it("reports imports of files that are not in trunk or this change, naming planned ones", () => {
    const src = 'import type { Link } from "../types.ts";\nimport { slug } from "../slug.ts";\nimport { x } from "./nope.ts";\nimport { test } from "node:test";\n';
    expect(importProblems("src/routes/create.ts", src, exists, new Set(["src/slug.ts"]))).toEqual([
      'line 2: "../slug.ts" names a planned file that is not in trunk yet; import only files listed in the project tree or written by this change',
      'line 3: "./nope.ts" names no file in the project tree or in this change',
    ]);
    expect(importProblems("README.md", src, exists)).toEqual([]);
  });
});

describe("bindings", () => {
  const TYPES = [
    "/** Storage port. */",
    "export interface Store {",
    "  get(slug: string): Promise<Link | null>;",
    "}",
    "export interface Link { slug: string }",
    "export type Handler = (request: Request) => Promise<Response>;",
  ].join("\n");
  const HTTP = [
    'export const MAX_BODY_BYTES = 4096;',
    "export type ErrorCode = \"not_found\" | \"internal\";",
    "// export function commented(): void {}",
    "export function json(data: unknown): Response {",
    "  return new Response(JSON.stringify(data));",
    "}",
    "export async function readJson(r: Request) { return r.json(); }",
    "const worker = { fetch: json };",
    "export default worker;",
    "export { json as toJson };",
  ].join("\n");

  it("reads a module's exports by kind", () => {
    const t = moduleExports(TYPES);
    expect([...t.types].sort()).toEqual(["Handler", "Link", "Store"]);
    expect(t.values.size).toBe(0);
    const h = moduleExports(HTTP);
    expect([...h.values].sort()).toEqual(["MAX_BODY_BYTES", "json", "readJson", "toJson"]);
    expect([...h.types]).toEqual(["ErrorCode"]);
    expect(h.default).toBe(true);
    expect(moduleExports('export * from "./a.ts";\nexport { b } from "./b.ts";\n')).toMatchObject({ open: true, other: new Set(["b"]) });
  });

  it("finds imports that fail when Node strips the types", () => {
    const files: Record<string, string> = { "src/types.ts": TYPES, "src/http.ts": HTTP, "src/all.ts": 'export * from "./http.ts";\n' };
    const exists = (p: string): boolean => p in files;
    const source = (p: string): string | null => files[p] ?? null;
    const src = [
      'import { Link, type Store } from "./types.ts";',
      'import type { Handler } from "./types.ts";',
      'import { json, readJson, nope } from "./http.ts";',
      'import worker from "./http.ts";',
      'import types from "./types.ts";',
      'import { anything } from "./all.ts";',
      'import { test } from "node:test";',
    ].join("\n");
    expect(bindingProblems("src/a.ts", src, exists, source)).toEqual([
      'line 1 imports the type "Link" from "./types.ts" as a value; Node strips types, so this import fails when the file loads. Write import type { Link } (or { type Link })',
      'line 3 imports "nope" from "./http.ts", which src/http.ts does not export',
      'line 5 imports a default export from "./types.ts", but src/types.ts has none',
    ]);
  });
});

describe("ruleProblems", () => {
  it("lets a new file break no rule, and an existing file break none more often", () => {
    const bad = 'import { json } from "./http";\nexport const now = () => Date.now();\n';
    const problems = ruleProblems([RELATIVE_TS, NO_RANDOM], "src/a.ts", null, bad);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toBe('line 1 breaks the rule "Relative imports name the .ts file". Write ./http.ts.');
    expect(problems[1]).toContain("Use deps.random and deps.now.");
    // src/index.ts is excluded from the time rule.
    expect(ruleProblems([NO_RANDOM], "src/index.ts", null, bad)).toEqual([]);
    // Pre-existing violations are tolerated; added ones are not.
    expect(ruleProblems([NO_RANDOM], "src/b.ts", "Date.now();\n", "Date.now();\n// edit\n")).toEqual([]);
    expect(ruleProblems([NO_RANDOM], "src/b.ts", "Date.now();\n", "Date.now();\nMath.random();\n")).toHaveLength(1);
  });
});

describe("checkWrittenFile", () => {
  it("passes a good file and says what was checked", () => {
    const after = 'import type { Link } from "./types.ts";\nexport function title(l: Link): string {\n  return l.slug;\n}\n';
    const r = checkWrittenFile({ path: "src/title.ts", before: null, after, rules: [RELATIVE_TS, NO_RANDOM], exists: (p) => p === "src/types.ts", erasable: true });
    expect(r).toEqual({ problems: [], detail: "syntax ok, 2 rule(s), 0 violations, erasable TypeScript, 1 relative import(s) resolve" });
  });

  it("collects every problem for the model's next attempt", () => {
    const after = 'import { json } from "./http";\nexport enum E { A }\nexport const f = () => { return Math.random(;\n';
    const r = checkWrittenFile({ path: "src/bad.ts", before: null, after, rules: [RELATIVE_TS, NO_RANDOM], exists: () => false, erasable: true });
    expect(r.problems.length).toBeGreaterThanOrEqual(4);
    expect(r.problems.join("\n")).toMatch(/never closed/);
    expect(r.problems.join("\n")).toMatch(/Relative imports name the .ts file/);
    expect(r.problems.join("\n")).toMatch(/enum/);
    expect(r.problems.join("\n")).toMatch(/names no file/);
  });
});
