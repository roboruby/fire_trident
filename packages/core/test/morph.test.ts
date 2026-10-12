import { describe, expect, it } from "vitest";
import { checkFile, globMatch, importsOf, ruleApplies, validateRule } from "../src/morph.ts";
import type { Rule, RuleKind } from "../src/types.ts";

const rule = (kind: RuleKind, spec: Record<string, unknown>, over: Partial<Rule> = {}): Rule => ({
  id: "r1",
  colonyId: "col",
  kind,
  spec,
  description: "No console.log in source",
  approvedBy: "user",
  createdAt: 0,
  ...over,
});

const lines = (...text: string[]): string => text.join("\n");

describe("globMatch", () => {
  it.each([
    // literals
    ["src/a.ts", "src/a.ts", true],
    ["src/a.ts", "src/b.ts", false],
    // * stays inside one segment
    ["*.ts", "a.ts", true],
    ["*.ts", "src/a.ts", false],
    ["src/*", "src/a.ts", true],
    ["src/*", "src/a/b.ts", false],
    ["src/*.ts", "src/.ts", true],
    ["src/*/index.ts", "src/a/index.ts", true],
    ["*a*b", "xaxxb", true],
    ["*a*b", "xaxxbx", false],
    ["*", ".env", true],
    // ? is one character, never "/"
    ["a?c", "abc", true],
    ["a?c", "ac", false],
    ["a?c", "a/c", false],
    // ** is zero or more directories
    ["**", "a", true],
    ["**", "a/b/c.ts", true],
    ["**/*", ".github/workflows/ci.yml", true],
    ["**/*.ts", "a.ts", true],
    ["**/*.ts", "a/b/c.ts", true],
    ["**/*.ts", "a/b/c.js", false],
    ["src/**/*.ts", "src/a.ts", true],
    ["src/**/*.ts", "src/a/b/c.ts", true],
    ["src/**/*.ts", "lib/src/a.ts", false],
    ["src/**/test/*.ts", "src/test/a.ts", true],
    ["src/**/test/*.ts", "src/x/y/test/a.ts", true],
    ["src/**/test/*.ts", "src/x/test/y/a.ts", false],
    ["src/**", "src/a/b.ts", true],
    ["src/**", "src", true],
    ["src/**", "srcx/a.ts", false],
    ["a/**/b", "a/b", true],
    ["a/**/b", "a/x/y/b", true],
    ["a/**/b", "a/xb", false],
    // ** inside a segment acts like *
    ["**.ts", "a.ts", true],
    ["**.ts", "a/b.ts", false],
    // braces
    ["*.{ts,tsx}", "a.tsx", true],
    ["*.{ts,tsx}", "a.ts", true],
    ["*.{ts,tsx}", "a.js", false],
    ["{src,lib}/**/*.ts", "lib/x/y.ts", true],
    ["{src,lib}/**/*.ts", "test/x.ts", false],
    ["{a,b,c}.ts", "c.ts", true],
    ["{a,{b,c}}.ts", "c.ts", true],
    ["{a,{b,c}}.ts", "d.ts", false],
    ["{src/**/*.ts,docs/*.md}", "src/a/b.ts", true],
    ["{src/**/*.ts,docs/*.md}", "docs/x.md", true],
    ["{src/**/*.ts,docs/*.md}", "docs/a/x.md", false],
    ["a{,.d}.ts", "a.ts", true],
    ["a{,.d}.ts", "a.d.ts", true],
    ["{a}.ts", "{a}.ts", true],
    ["{a}.ts", "a.ts", false],
    ["{a,b.ts", "{a,b.ts", true],
    ["{a}{b,c}.ts", "{a}c.ts", true],
    // everything else is literal
    ["a+b(1).ts", "a+b(1).ts", true],
    ["[x].ts", "[x].ts", true],
    ["[x].ts", "x.ts", false],
    ["*.ts", "ats", false],
    ["$^.ts", "$^.ts", true],
    // root prefixes on the glob are ignored
    ["./src/*.ts", "src/a.ts", true],
    ["/src/*.ts", "src/a.ts", true],
  ] as const)("globMatch(%j, %j) = %s", (glob, path, expected) => {
    expect(globMatch(glob, path)).toBe(expected);
  });

  it("handles patterns that defeat backtracking matchers", () => {
    expect(globMatch("*a*a*a*a*a*a*a*a*a*a*a*a*b", "a".repeat(5_000))).toBe(false);
    expect(globMatch("**/**/**/**/**/**/**/x", Array.from({ length: 80 }, () => "a").join("/"))).toBe(false);
    expect(globMatch("**/**/**/**/**/**/**/x", `${Array.from({ length: 80 }, () => "a").join("/")}/x`)).toBe(true);
  });

  it("expands up to 256 brace alternatives and matches nothing past that", () => {
    expect(globMatch("{a,b}".repeat(8), "abababab")).toBe(true);
    expect(globMatch("{a,b}".repeat(9), "aaaaaaaaa")).toBe(false);
    expect(globMatch(`${"{a,b}".repeat(30)}.ts`, `${"a".repeat(30)}.ts`)).toBe(false);
  });

  it("gives the same answer on repeated calls (memoized compile)", () => {
    for (let i = 0; i < 3; i++) {
      expect(globMatch("src/**/*.{ts,tsx}", "src/a/b.tsx")).toBe(true);
      expect(globMatch("src/**/*.{ts,tsx}", "src/a/b.js")).toBe(false);
    }
  });
});

describe("ruleApplies", () => {
  it("applies a forbid-pattern rule everywhere by default", () => {
    const r = rule("forbid-pattern", { pattern: "x" });
    expect(ruleApplies(r, "README.md")).toBe(true);
    expect(ruleApplies(r, "src/deep/a.ts")).toBe(true);
  });

  it("scopes forbid-pattern with include and exclude", () => {
    const r = rule("forbid-pattern", { pattern: "x", include: ["src/**/*.ts"], exclude: ["**/*.test.ts"] });
    expect(ruleApplies(r, "src/a.ts")).toBe(true);
    expect(ruleApplies(r, "lib/a.ts")).toBe(false);
    expect(ruleApplies(r, "src/a.test.ts")).toBe(false);
  });

  it("scopes forbid-import with from and exclude, not include", () => {
    const r = rule("forbid-import", { module: "db", from: ["web/**"], include: ["lib/**"], exclude: ["web/legacy/**"] });
    expect(ruleApplies(r, "web/a.ts")).toBe(true);
    expect(ruleApplies(r, "lib/a.ts")).toBe(false);
    expect(ruleApplies(r, "web/legacy/a.ts")).toBe(false);
  });

  it("applies a forbid-import rule everywhere by default, and forbid-pattern ignores from", () => {
    expect(ruleApplies(rule("forbid-import", { module: "db" }), "any/where.ts")).toBe(true);
    expect(ruleApplies(rule("forbid-pattern", { pattern: "x", from: ["web/**"] }), "lib/a.ts")).toBe(true);
  });

  it("accepts a single glob string", () => {
    const r = rule("forbid-pattern", { pattern: "x", include: "src/**", exclude: "src/gen/**" });
    expect(ruleApplies(r, "src/a.ts")).toBe(true);
    expect(ruleApplies(r, "src/gen/a.ts")).toBe(false);
    expect(ruleApplies(r, "lib/a.ts")).toBe(false);
  });

  it("falls back to every file for an empty or non-string include", () => {
    expect(ruleApplies(rule("forbid-pattern", { pattern: "x", include: [] }), "a.ts")).toBe(true);
    expect(ruleApplies(rule("forbid-pattern", { pattern: "x", include: [42] }), "a.ts")).toBe(true);
    expect(ruleApplies(rule("forbid-pattern", { pattern: "x", include: [42, "src/**"] }), "a.ts")).toBe(false);
  });

  it("never applies an unknown rule kind", () => {
    expect(ruleApplies(rule("forbid-everything" as RuleKind, {}), "a.ts")).toBe(false);
  });
});

describe("importsOf", () => {
  it("finds every import form with its line", () => {
    const src = lines(
      'import a from "./a";',
      "import { b, c as d } from './b';",
      'import * as ns from "ns";',
      'import type { T } from "./types";',
      'import "./side-effect.css";',
      'export * from "./re-export";',
      'export { x, y as z } from "./named";',
      'export * as all from "./all";',
      'export type { U } from "./u";',
      'const fs = require("pkg/fs");',
      'const lazy = await import("./lazy");',
      'const json = import(`./data.json`, { with: { type: "json" } });',
      'import def, { named } from "mixed";',
      'type L = typeof import("./lazy-type");',
      'import { type V, W } from "@scope/pkg";',
    );
    expect(importsOf(src)).toEqual([
      { specifier: "./a", line: 1 },
      { specifier: "./b", line: 2 },
      { specifier: "ns", line: 3 },
      { specifier: "./types", line: 4 },
      { specifier: "./side-effect.css", line: 5 },
      { specifier: "./re-export", line: 6 },
      { specifier: "./named", line: 7 },
      { specifier: "./all", line: 8 },
      { specifier: "./u", line: 9 },
      { specifier: "pkg/fs", line: 10 },
      { specifier: "./lazy", line: 11 },
      { specifier: "./data.json", line: 12 },
      { specifier: "mixed", line: 13 },
      { specifier: "./lazy-type", line: 14 },
      { specifier: "@scope/pkg", line: 15 },
    ]);
  });

  it("reports the specifier line of a multi-line statement", () => {
    const src = lines(
      "import {",
      "  alpha,",
      "  beta,",
      '} from "./greek";',
      "export {",
      "  gamma",
      "}",
      '  from "./more";',
      "import type {",
      "  Delta",
      "} from",
      '  "./split";',
    );
    expect(importsOf(src)).toEqual([
      { specifier: "./greek", line: 4 },
      { specifier: "./more", line: 8 },
      { specifier: "./split", line: 12 },
    ]);
  });

  it("ignores imports inside line and block comments", () => {
    const src = lines(
      '// import a from "./line-comment";',
      '/* import b from "./block";',
      '   require("./still-block"); */',
      'import c from "./real"; // import d from "./trailing"',
      'const s = 1; /* import("./inline") */ import e from "./after-block";',
      "/**",
      ' * @example import f from "./doc"',
      " */",
      'export { g } from "./last";',
    );
    expect(importsOf(src)).toEqual([
      { specifier: "./real", line: 4 },
      { specifier: "./after-block", line: 5 },
      { specifier: "./last", line: 9 },
    ]);
  });

  it("ignores import-like text inside strings and templates", () => {
    const src = lines(
      `const a = "import x from './in-double'";`,
      `const b = 'require("./in-single")';`,
      "const c = `import y from './in-template'`;",
      'const url = "http://example.com/a"; import real from "./real";',
      'const t = `${require("./in-substitution")}`;',
      "const u = `line one",
      "import z from './in-multiline-template'",
      "`;",
      'import after from "./after-template";',
    );
    expect(importsOf(src)).toEqual([
      { specifier: "./real", line: 4 },
      { specifier: "./in-substitution", line: 5 },
      { specifier: "./after-template", line: 9 },
    ]);
  });

  it("tells regex literals from division", () => {
    const src = lines(
      String.raw`const re = /["']\/\//g;`,
      'import a from "./after-regex";',
      "const half = total / 2; const r = /import b from 'nope'/;",
      "const q = x / y / z;",
      'import c from "./after-division";',
      String.raw`if (ok) { return /\/*not a comment/.test(s); }`,
      'import d from "./after-return-regex";',
      "const k = [1, 2].map((n) => n / 2)[0] / 3; const cls = /[/]/;",
      'import e from "./after-class";',
    );
    expect(importsOf(src)).toEqual([
      { specifier: "./after-regex", line: 2 },
      { specifier: "./after-division", line: 5 },
      { specifier: "./after-return-regex", line: 7 },
      { specifier: "./after-class", line: 9 },
    ]);
  });

  it("ignores lookalikes that are not module specifiers", () => {
    const src = lines(
      "const meta = import.meta.url;",
      'obj.require("./method");',
      'obj.import("./method2");',
      'const p = require.resolve("./resolved");',
      "const dyn = import(name);",
      'const cat = require("./a" + suffix);',
      "const tpl = import(`./${name}.ts`);",
      "export const value = 1;",
      "export { local };",
      "export default function from() {}",
      "const o = { import: 'x', from: 'y' };",
      'import x = require("./ts-import-equals");',
    );
    expect(importsOf(src)).toEqual([{ specifier: "./ts-import-equals", line: 12 }]);
  });

  it("does not run an export declaration into the next statement", () => {
    const src = lines("export class A {}", 'import b from "./b";', "export enum E { X, Y }", 'export * from "./c";');
    expect(importsOf(src)).toEqual([
      { specifier: "./b", line: 2 },
      { specifier: "./c", line: 4 },
    ]);
  });

  it("handles CRLF and CR line endings, a byte order mark, and a shebang", () => {
    const src = '﻿#!/usr/bin/env tool\r\nimport a from "./a";\r\n\r\nimport b from \'./b\';\rimport c from "./c";';
    expect(importsOf(src)).toEqual([
      { specifier: "./a", line: 2 },
      { specifier: "./b", line: 4 },
      { specifier: "./c", line: 5 },
    ]);
  });

  it("survives JSX text with apostrophes", () => {
    const src = lines(
      'import { Button } from "./ui";',
      "export function App() {",
      "  return <p>Don't import anything from 'here'</p>;",
      "}",
      'import late from "./late";',
    );
    expect(importsOf(src)).toEqual([
      { specifier: "./ui", line: 1 },
      { specifier: "./late", line: 5 },
    ]);
  });

  it("tracks nested template substitutions", () => {
    const src = lines("const s = `a ${ `b ${ c ? '}' : \"{\" } d` } e ${ { k: 1 }.k }`;", 'import ok from "./ok";');
    expect(importsOf(src)).toEqual([{ specifier: "./ok", line: 2 }]);
  });

  it("counts lines inside multi-line strings, comments, and templates", () => {
    const src = lines("/*", "", "*/", "const t = `", "", "`;", 'const s = "a\\', 'b";', 'import x from "./x";');
    expect(importsOf(src)).toEqual([{ specifier: "./x", line: 9 }]);
  });

  it("never throws on malformed input", () => {
    for (const src of ['import "unterminated', "const t = `open", "/* open", "a = /open", "}}}", "export {", "import", "require("]) {
      expect(() => importsOf(src)).not.toThrow();
    }
    expect(importsOf('const s = "open\nimport x from "./x";')).toEqual([{ specifier: "./x", line: 2 }]);
  });

  it("returns nothing for an empty file", () => {
    expect(importsOf("")).toEqual([]);
  });
});

describe("checkFile: forbid-pattern", () => {
  const noConsole = rule("forbid-pattern", { pattern: "console\\.log\\(", include: ["src/**"], hint: "Use the logger." });

  it("reports one violation per matching line with a trimmed excerpt", () => {
    const content = lines("const a = 1;", "   console.log(a);   ", "console.warn(a);", "\tconsole.log('again'); console.log(2)");
    expect(checkFile(noConsole, "src/a.ts", content)).toEqual([
      { ruleId: "r1", path: "src/a.ts", line: 2, excerpt: "console.log(a);", message: "No console.log in source. Use the logger." },
      { ruleId: "r1", path: "src/a.ts", line: 4, excerpt: "console.log('again'); console.log(2)", message: "No console.log in source. Use the logger." },
    ]);
  });

  it("returns nothing for a path the rule does not apply to", () => {
    expect(checkFile(noConsole, "scripts/a.ts", "console.log(1)")).toEqual([]);
  });

  it("returns nothing for clean content", () => {
    expect(checkFile(noConsole, "src/a.ts", "const a = 1;\n")).toEqual([]);
  });

  it("honors flags", () => {
    const todo = rule("forbid-pattern", { pattern: "\\btodo\\b", flags: "i", hint: "File an intent instead." });
    expect(checkFile(todo, "a.ts", lines("// TODO: fix", "// todo later", "// todos"))).toHaveLength(2);
  });

  it("drops the global flag so every matching line is reported", () => {
    const r = rule("forbid-pattern", { pattern: "x", flags: "gy" });
    expect(checkFile(r, "a.ts", lines("x", "x", "x")).map((v) => v.line)).toEqual([1, 2, 3]);
  });

  it("caps the excerpt at 160 characters", () => {
    const r = rule("forbid-pattern", { pattern: "x" });
    const [v] = checkFile(r, "a.ts", `   ${"x".repeat(300)}`);
    expect(v?.excerpt).toHaveLength(160);
    expect(v?.excerpt.endsWith("…")).toBe(true);
  });

  it("builds the message from description and hint", () => {
    const content = "x";
    const message = (description: string, hint?: string) =>
      checkFile(rule("forbid-pattern", hint === undefined ? { pattern: "x" } : { pattern: "x", hint }, { description }), "a.ts", content)[0]?.message;
    expect(message("No x", "Use y.")).toBe("No x. Use y.");
    expect(message("No x!", "Use y.")).toBe("No x! Use y.");
    expect(message("No x")).toBe("No x");
    expect(message("", "Use y.")).toBe("Use y.");
    expect(message("No\nx", " Use\ny. ")).toBe("No x. Use y.");
    expect(message("")).toBe("Violates rule r1");
  });

  it("numbers lines 1-based with CRLF and does not invent a line after a final newline", () => {
    const empty = rule("forbid-pattern", { pattern: "^$" });
    expect(checkFile(empty, "a.ts", "a\n")).toEqual([]);
    expect(checkFile(empty, "a.ts", "")).toEqual([]);
    expect(checkFile(empty, "a.ts", "a\n\nb").map((v) => v.line)).toEqual([2]);
    const [v] = checkFile(noConsole, "src/a.ts", "a\r\nconsole.log(1)\r\n");
    expect(v?.line).toBe(2);
    expect(v?.excerpt).toBe("console.log(1)");
  });

  it("throws on an invalid rule, naming it", () => {
    expect(() => checkFile(rule("forbid-pattern", { pattern: "(" }), "a.ts", "x")).toThrow(/rule r1/);
    expect(() => checkFile(rule("forbid-pattern", {}), "a.ts", "x")).toThrow(/spec\.pattern/);
  });
});

describe("checkFile: forbid-import", () => {
  const noDb = rule(
    "forbid-import",
    { from: ["web/**"], exclude: ["web/**/*.test.ts"], module: "^(\\.\\./)+db(/|$)|^@app/db$", hint: "Go through the API client." },
    { description: "UI must not import the database layer" },
  );
  const content = lines(
    'import { api } from "../api";',
    'import { query } from "../../db/query";',
    '// import { raw } from "../db";',
    "import {",
    "  pool,",
    '} from "@app/db";',
    'const lazy = () => import("../db");',
    'const s = "import x from \'../db\'";',
  );
  const message = "UI must not import the database layer. Go through the API client.";

  it("reports each forbidden import at its specifier line", () => {
    expect(checkFile(noDb, "web/page.tsx", content)).toEqual([
      { ruleId: "r1", path: "web/page.tsx", line: 2, excerpt: 'import { query } from "../../db/query";', message },
      { ruleId: "r1", path: "web/page.tsx", line: 6, excerpt: '} from "@app/db";', message },
      { ruleId: "r1", path: "web/page.tsx", line: 7, excerpt: 'const lazy = () => import("../db");', message },
    ]);
  });

  it("skips files outside from or inside exclude", () => {
    expect(checkFile(noDb, "api/server.ts", content)).toEqual([]);
    expect(checkFile(noDb, "web/page.test.ts", content)).toEqual([]);
  });

  it("only scans JS/TS-family files", () => {
    expect(checkFile(noDb, "web/README.md", content)).toEqual([]);
    expect(checkFile(noDb, "web/data.json", content)).toEqual([]);
    expect(checkFile(noDb, "web/a.mjs", 'import "../db";')).toHaveLength(1);
    expect(checkFile(noDb, "web/App.JSX", 'import { pool } from "@app/db";')).toHaveLength(1);
    expect(checkFile(noDb, "web/a.cts", 'const db = require("../db");')).toHaveLength(1);
  });

  it("throws when module is missing", () => {
    expect(() => checkFile(rule("forbid-import", { from: ["web/**"] }), "web/a.ts", 'import "x";')).toThrow(/spec\.module/);
  });
});

describe("validateRule", () => {
  it("accepts well-formed rules", () => {
    expect(validateRule(rule("forbid-pattern", { pattern: "x", flags: "i", include: ["src/**"], exclude: "gen/**", hint: "h", replacement: "y" }))).toEqual([]);
    expect(validateRule(rule("forbid-import", { from: ["web/**"], module: "^db$", hint: "h" }))).toEqual([]);
  });

  it("reports an unknown kind", () => {
    expect(validateRule(rule("forbid-x" as RuleKind, { pattern: "x" }))).toEqual(["unknown rule kind: forbid-x"]);
  });

  it("reports a missing, empty, or invalid RegExp", () => {
    expect(validateRule(rule("forbid-pattern", {}))).toEqual(["spec.pattern must be a non-empty string"]);
    expect(validateRule(rule("forbid-pattern", { pattern: "" }))).toEqual(["spec.pattern must be a non-empty string"]);
    expect(validateRule(rule("forbid-import", { module: 5 }))).toEqual(["spec.module must be a non-empty string"]);
    const [problem] = validateRule(rule("forbid-pattern", { pattern: "(" }));
    expect(problem).toMatch(/^spec\.pattern is not a valid RegExp/);
    expect(validateRule(rule("forbid-pattern", { pattern: "x", flags: "q" }))[0]).toMatch(/not a valid RegExp/);
    expect(validateRule(rule("forbid-pattern", { pattern: "x", flags: 1 }))).toEqual(["spec.flags must be a string"]);
  });

  it("reports malformed globs, hint, and replacement", () => {
    expect(validateRule(rule("forbid-pattern", { pattern: "x", include: 5, exclude: [1], hint: 2, replacement: 3 }))).toEqual([
      "spec.include must be a glob or a list of globs",
      "spec.exclude must be a glob or a list of globs",
      "spec.hint must be a string",
      "spec.replacement must be a string",
    ]);
    expect(validateRule(rule("forbid-import", { module: "x", from: {} }))).toEqual(["spec.from must be a glob or a list of globs"]);
  });
});
