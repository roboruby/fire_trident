import { describe, expect, it } from "vitest";
import { onlyGrew } from "@fire_trident/core";
import { MAX_STATEMENTS, topStatements } from "../../src/decide/statements.ts";

/** The hashes of a source's top-level statements (the test fails if it cannot be read). */
function hashes(src: string, path = "src/a.ts"): string[] {
  const s = topStatements(path, src);
  if (s === null) throw new Error(`unreadable: ${src.slice(0, 40)}`);
  return [...s.hashes];
}

/** A module in the style of a semicolon-free codebase: imports, a doc comment, one class. */
const HONO = [
  "import { Base } from './base'",
  "import type { Options } from './base'",
  "import { Router } from './router'",
  "",
  "/**",
  " * The main class.",
  " */",
  "export class Main<E extends string = '/'> extends Base<E> {",
  "  constructor(options: Options<E> = {}) {",
  "    super(options)",
  "    this.router = options.router ?? new Router({ routers: [] })",
  "  }",
  "}",
  "",
].join("\n");

describe("topStatements: cutting a script into top-level statements", () => {
  it("cuts a semicolon-free module at the line breaks where a statement must start, with each statement's line", () => {
    const s = topStatements("src/main.ts", HONO)!;
    expect(s.mode).toBe("ts");
    expect(s.hashes).toHaveLength(4);
    expect(s.lines).toEqual([1, 2, 3, 8]);
    expect(s.declares).toEqual([true, true, true, true]);
    expect(s.prologue).toBe(0);
  });

  it("cuts after a semicolon, and keeps a hashbang and the directives after it as the prologue", () => {
    const s = topStatements("bin/run.js", "#!/usr/bin/env node\n'use strict';\nconst a = 1; const b = 2;\nfunction f() { return a + b }\nf();\n")!;
    expect(s.mode).toBe("js");
    expect(s.lines).toEqual([1, 2, 3, 3, 4, 5]);
    expect(s.declares).toEqual([false, false, true, true, true, false]);
    expect(s.prologue).toBe(2);
  });

  it("keeps a statement that continues on the next line in one piece, and cuts only before a word that must start one", () => {
    expect(hashes("const a = 1\nconst b = a\n  + 2\nexport { a, b }\n")).toHaveLength(3);
    expect(hashes("const t = foo\n  .bar()\n  .baz\ntype X = 1\n")).toHaveLength(2);
    // Where the next line could continue the statement, cutting too little only makes the check stricter.
    expect(hashes("foo()\n(bar)()\n")).toHaveLength(1);
    // After a "}" a name starts a statement unless it can continue the one before (else, catch, in, as, from and the like).
    expect(hashes("export function f() {}\nf()\nexport const g = 1\n")).toHaveLength(3);
    expect(hashes("const o = {\n}\nas const\n")).toHaveLength(1);
    expect(hashes("export { a }\nfrom './a'\ntry {\n} catch {\n}\nfinally {}\n")).toHaveLength(2);
    expect(hashes("a\n++b\n")).toHaveLength(1);
    expect(hashes("const x = async\nfunction f() {}\n")).toHaveLength(1);
    // A line break inside brackets never cuts, nor one inside a template substitution.
    expect(hashes("const o = {\n  a: 1,\n}\nexport const s = `a ${\n  typeof o\n}`\nexport const y = 1\n")).toHaveLength(3);
  });

  it("refuses what it cannot cut for sure: a bare-bodied header, a label, a decorator with no class, what the reader refuses", () => {
    expect(topStatements("src/a.ts", "if (x) {\n  y()\n}\n")).toBeNull();
    expect(topStatements("src/a.ts", "for (const x of xs) x()\n")).toBeNull();
    expect(topStatements("src/a.ts", "do {} while (x)\n")).toBeNull();
    expect(topStatements("src/a.ts", "loop: for (;;) {}\n")).toBeNull();
    expect(topStatements("src/a.ts", "@dec\nexport const x = 1\n")).toBeNull();
    expect(topStatements("src/a.tsx", "export const el = <div />;\n")).toBeNull();
    expect(topStatements("src/a.ts", "function f() {}\n/re/.test(s);\n")).toBeNull();
    expect(topStatements("src/a.ts", "const a = (1;\n")).toBeNull();
    expect(topStatements("README.md", "# not a script\n")).toBeNull();
    expect(topStatements("src/a.ts", Array.from({ length: MAX_STATEMENTS + 1 }, (_, i) => `const a${i} = ${i};\n`).join(""))).toBeNull();
  });

  it("reads a decorated class as one declaration, and the next statement after it", () => {
    const s = topStatements("src/a.ts", "@dec()\nexport class X {}\nexport const y = 1\n")!;
    expect(s.lines).toEqual([1, 3]);
    expect(s.declares).toEqual([true, true]);
  });

  it("marks declarations by what the statement starts with", () => {
    const declares = (src: string): boolean => topStatements("src/a.ts", src)!.declares[0]!;
    for (const yes of ["import x from './x'", "import { x } from './x'", "import * as ns from './x'", "import type { T } from './x'", "export default foo()", "export { a }", "export const a = 1", "const a = 1", "let a = 1", "var a = 1", "function f() {}", "class A {}", "interface I {}", "enum E {}", "type X = 1", "declare const x: number", "namespace N {}", "module M {}", "abstract class A {}", "async function f() {}", ";"]) {
      expect(declares(`${yes}\n`), yes).toBe(true);
    }
    for (const no of ["import('./x')", "import './side'", "import.meta.url", "type = 1", "declare(1)", "module.exports = 1", "namespace = 2", "async()", "foo()", "'use strict'", "a = 1", "new X()"]) {
      expect(declares(`${no}\n`), no).toBe(false);
    }
  });

  it("hashes code only: comments and white space do not count, line breaks between tokens and template text do", () => {
    expect(hashes("const a = 1 // one\n")).toEqual(hashes("/* one */ const   a=1\n"));
    expect(hashes("function f() {\n  return\n  1\n}\n")).not.toEqual(hashes("function f() {\n  return 1\n}\n"));
    expect(hashes("const s = `a ${x} b`\n")).not.toEqual(hashes("const s = `a ${x} c`\n"));
    expect(hashes("const s = 'a'\n")).not.toEqual(hashes("const s = \"a\"\n"));
  });
});

describe("the growth check over two versions of a file (topStatements, then core onlyGrew)", () => {
  const grew = (was: string, now: string, path = "src/a.ts") => {
    const a = topStatements(path, was);
    const b = topStatements(path, now);
    return a && b ? onlyGrew(a, b) : null;
  };
  const MODULE = ["import { x } from './x'", "", "export function f(a: number) {", "  return a + x", "}", "", "export const g = f(1)", ""].join("\n");

  it("passes a statement added in the middle of the file, or at either end", () => {
    expect(grew(MODULE, MODULE.replace("export const g", "export interface Added {}\nexport const g"))).toEqual({ grew: true });
    expect(grew(MODULE, `${MODULE}export const h = 2\n`)).toEqual({ grew: true });
    expect(grew(MODULE, `import { y } from './y'\n${MODULE}`)).toEqual({ grew: true });
    expect(grew(HONO, `${HONO}export const added = 'now'\n`, "src/main.ts")).toEqual({ grew: true });
  });

  it("sends back a changed function body, naming the statement's line in the version read", () => {
    expect(grew(MODULE, MODULE.replace("return a + x", "return a - x"))).toEqual({ grew: false, line: 3, why: "edited" });
    expect(grew(HONO, HONO.replace("super(options)", "super({ ...options })"), "src/main.ts")).toEqual({ grew: false, line: 8, why: "edited" });
  });

  it("sends back a changed import line, a removed statement and a re-ordered file", () => {
    expect(grew(MODULE, MODULE.replace("from './x'", "from './x2'"))).toEqual({ grew: false, line: 1, why: "edited" });
    expect(grew(MODULE, MODULE.replace("export const g = f(1)\n", ""))).toEqual({ grew: false, line: 7, why: "edited" });
    const reordered = ["import { x } from './x'", "", "export const g = f(1)", "", "export function f(a: number) {", "  return a + x", "}", ""].join("\n");
    // The import and then f are found in order; g, now before f, is the first statement not there in order.
    expect(grew(MODULE, reordered)).toEqual({ grew: false, line: 7, why: "edited" });
  });

  it("sends back a new statement that runs something, naming its line in the version it would land on", () => {
    expect(grew(MODULE, MODULE.replace("export const g", "f(2)\nexport const g"))).toEqual({ grew: false, line: 7, why: "added" });
    expect(grew("const a = 1;\nconst b = 2;\n", "const a = 1;\nconsole.log(a);\nconst b = 2;\n")).toEqual({ grew: false, line: 2, why: "added" });
  });

  it("cannot decide when either version cannot be cut for sure", () => {
    expect(grew(MODULE, `${MODULE}if (g) {\n  f(2)\n}\n`)).toBeNull();
    expect(grew(`if (x) {\n}\n${MODULE}`, MODULE)).toBeNull();
    expect(grew(MODULE, `${MODULE}export const el = <div />\n`, "src/a.tsx")).toBeNull();
  });
});
