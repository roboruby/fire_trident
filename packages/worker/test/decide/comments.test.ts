import { describe, expect, it } from "vitest";
import { commentOnlyProof, directiveIn, readScript, sameCode, type ProofFile } from "../../src/decide/comments.ts";

const LS = String.fromCharCode(0x2028);
const RLO = String.fromCharCode(0x202e);

/** The proof for one modified file. */
function prove(before: string, after: string, path = "src/a.ts") {
  return commentOnlyProof([{ path, before, after }]);
}

/** Token texts of a source, a line break before a token written as "\n" in front of it. */
function tokens(src: string, path = "src/a.ts"): string[] {
  const r = readScript(path, src);
  if (!r.ok) throw new Error(r.why);
  return r.tokens.map((t, k) => `${k > 0 && t.nl ? "\n" : ""}${t.text}`);
}

const MODULE = [
  "// Adds two numbers.",
  "export function add(a: number, b: number): number {",
  "  /* the sum */",
  "  return a + b;",
  "}",
  "",
].join("\n");

describe("the comment-only proof", () => {
  it("proves comment edits: changed, added and removed comments", () => {
    expect(prove(MODULE, MODULE.replace("Adds two numbers.", "Returns the sum of a and b.")).verdict).toBe("pass");
    expect(prove(MODULE, MODULE.replace("/* the sum */", "/**\n   * The sum, never rounded.\n   */")).verdict).toBe("pass");
    expect(prove(MODULE, MODULE.replace("  return a + b;", "  // No overflow check: callers pass small numbers.\n  return a + b; // plain addition")).verdict).toBe("pass");
    expect(prove(MODULE, MODULE.replace("// Adds two numbers.\n", "")).verdict).toBe("pass");
    const r = prove(MODULE, MODULE.replace("the sum", "a sum"));
    expect(r).toEqual({ verdict: "pass", files: ["src/a.ts"], reasons: [expect.stringContaining("1 file proven comment-only (src/a.ts)")] });
  });

  it("proves whitespace-only changes that keep the line breaks between tokens", () => {
    expect(prove(MODULE, MODULE.replace("  return a + b;", "    return  a+b ;  ")).verdict).toBe("pass");
    expect(prove(MODULE, MODULE.replace("}\n", "}\n\n\n")).verdict).toBe("pass");
    expect(prove(MODULE, MODULE.replace(/\n/g, "\r\n")).verdict).toBe("pass");
    expect(prove(MODULE, MODULE.replace(/ {2}/g, "\t")).verdict).toBe("pass");
  });

  it("refuses a line break added or removed between tokens: it can end a statement", () => {
    const ret = "export function f(x: number) {\n  return x;\n}\n";
    expect(prove(ret, ret.replace("return x", "return\n    x")).verdict).toBe("no");
    expect(prove(ret, ret.replace("return x", "return /* why */ x")).verdict).toBe("pass");
    // A block comment holding a line break counts as one.
    expect(prove(ret, ret.replace("return x", "return /*\n */ x")).verdict).toBe("no");
    // Joining two lines is refused as well, whatever ASI would have done.
    expect(prove("const a = 1\nconst b = 2\n", "const a = 1 const b = 2\n").verdict).toBe("no");
    // A line separator ends a line comment, so the text after it is code that changed.
    expect(prove(`// note${LS}launch();\n`, `// note${LS}destroy();\n`).verdict).toBe("no");
  });

  it("refuses a changed string literal, even one that only changes quotes", () => {
    const src = 'export const greeting = "hello"; // greet\n';
    expect(prove(src, src.replace('"hello"', '"hullo"'))).toMatchObject({ verdict: "no", reasons: ["src/a.ts changes code, not only comments and whitespace"] });
    expect(prove(src, src.replace('"hello"', "'hello'")).verdict).toBe("no");
    // Text that looks like a comment inside a string is the string.
    const url = 'export const site = "https://example.com"; /* the site */\n';
    expect(prove(url, url.replace("example.com", "example.org")).verdict).toBe("no");
    expect(prove(url, url.replace("the site", "our site")).verdict).toBe("pass");
  });

  it("reads template literals and the code nested in their substitutions", () => {
    const src = "export const line = (n: number) => `${n /* count */} items // ${`of ${n > 1 ? 'many' : 'one'}`}`;\n";
    expect(prove(src, src.replace("/* count */", "/* how many */")).verdict).toBe("pass");
    // Template text is text: whitespace and "comments" inside it are part of the value.
    expect(prove(src, src.replace("} items", "}  items")).verdict).toBe("no");
    expect(prove(src, src.replace("// ${", "// x ${")).verdict).toBe("no");
    expect(prove(src, src.replace("'many'", "'lots'")).verdict).toBe("no");
  });

  it("reads regular expression literals, slashes and stars inside them included", () => {
    const src = "export const url = /^https?:\\/\\/[^/*]+\\/*$/i; // a URL\nexport const half = (a: number, b: number) => (a + b) / 2 / 1; // halve\n";
    expect(prove(src, src.replace("// a URL", "// an address")).verdict).toBe("pass");
    expect(prove(src, src.replace("// halve", "/* halve */")).verdict).toBe("pass");
    expect(prove(src, src.replace("https?", "https")).verdict).toBe("no");
    expect(prove(src, src.replace("/i;", "/g;")).verdict).toBe("no");
    expect(tokens("if (ok) /a/.test(s);\nconst q = f(x) / 2 / y;\n")).toEqual(["if", "(", "ok", ")", "/a/", ".", "test", "(", "s", ")", ";", "\nconst", "q", "=", "f", "(", "x", ")", "/", "2", "/", "y", ";"]);
  });

  it("refuses a directive comment that tools read, added, removed, changed or anywhere else in the file", () => {
    const added = prove(MODULE, MODULE.replace("  return a + b;", "  // eslint-disable-next-line no-magic-numbers\n  return a + b;"));
    expect(added).toMatchObject({ verdict: "blocked", files: ["src/a.ts"], reasons: ['src/a.ts holds a directive comment that tools read ("eslint")'] });
    expect(prove(MODULE, MODULE.replace("/* the sum */", "// @ts-expect-error: wrong on purpose")).verdict).toBe("blocked");
    expect(prove(MODULE.replace("/* the sum */", "/* istanbul ignore next */"), MODULE.replace("/* the sum */", "")).verdict).toBe("blocked");
    // An unchanged directive still blocks: line-based directives act on the lines around them.
    const kept = `/// <reference types="node" />\n${MODULE}`;
    expect(prove(kept, kept.replace("Adds two numbers.", "Adds.")).reasons[0]).toContain('("///")');
    const pure = "export const x = /*#__PURE__*/ make(); // made\n";
    expect(prove(pure, pure.replace("made", "built")).verdict).toBe("blocked");
    expect(prove("/* global window */\nexport {};\n", "/* global window, document */\nexport {};\n").verdict).toBe("blocked");
  });

  it("reads JSDoc types as directives in JavaScript files only", () => {
    const js = "/** @param {number} a */\nexport function twice(a) {\n  return a * 2;\n}\n";
    expect(prove(js, js.replace("@param {number} a", "@param {number} a the value"), "src/a.js").verdict).toBe("blocked");
    expect(prove(js, js.replace("@param {number} a", "@param {number} a the value"), "src/a.ts").verdict).toBe("pass");
    expect(directiveIn("src/a.ts", "/** @returns the sum */")).toBeNull();
    expect(directiveIn("src/a.mjs", "/** @returns the sum */")).toBe("@returns");
  });

  it("refuses a gained comment with a bidirectional control character or a credential", () => {
    expect(prove(MODULE, MODULE.replace("Adds two numbers.", `Adds two ${RLO}numbers.`))).toMatchObject({ verdict: "blocked", reasons: ["src/a.ts gains a comment with a bidirectional control character"] });
    expect(prove(MODULE, MODULE.replace("Adds two numbers.", "Adds two numbers. password: hunter22")).verdict).toBe("blocked");
    expect(prove(MODULE, MODULE.replace("Adds two numbers.", "Adds two numbers, given the session token.")).verdict).toBe("pass");
  });

  it("covers existing script files only: an added, deleted, renamed or other file is no proof", () => {
    expect(commentOnlyProof([{ path: "src/new.ts", before: null, after: MODULE }]).verdict).toBe("no");
    expect(commentOnlyProof([{ path: "src/a.ts", before: MODULE, after: null }]).verdict).toBe("no");
    const renamed: ProofFile[] = [
      { path: "src/a.ts", before: MODULE, after: null },
      { path: "src/b.ts", before: null, after: MODULE },
    ];
    expect(commentOnlyProof(renamed).verdict).toBe("no");
    expect(commentOnlyProof([{ path: "README.md", before: "# a\n", after: "# b\n" }]).reasons).toEqual(["README.md is not a JavaScript or TypeScript file"]);
    expect(commentOnlyProof([{ path: "src/a.mts", before: MODULE, after: MODULE.replace("two", "2") }]).verdict).toBe("no");
    expect(commentOnlyProof([{ path: "src/a.ts", before: MODULE, after: MODULE, binary: true }]).verdict).toBe("no");
    // Every file must hold: one code change among comment edits is no proof.
    const mixed: ProofFile[] = [
      { path: "src/a.ts", before: MODULE, after: MODULE.replace("two", "2") },
      { path: "src/b.ts", before: MODULE, after: MODULE.replace("a + b", "a - b") },
    ];
    expect(commentOnlyProof(mixed)).toMatchObject({ verdict: "no", reasons: ["src/b.ts changes code, not only comments and whitespace"] });
    // An unchanged file in the write set is skipped; a change that changes nothing proves nothing.
    expect(commentOnlyProof([{ path: "src/a.ts", before: MODULE, after: MODULE }]).verdict).toBe("no");
    expect(commentOnlyProof([{ path: "src/a.ts", before: MODULE, after: MODULE.replace("two", "2") }, { path: "docs/x.md", before: "same\n", after: "same\n" }]).verdict).toBe("pass");
  });

  it("refuses what it cannot read exactly instead of guessing", () => {
    const refusal = (src: string, path = "src/a.ts"): string => {
      const r = readScript(path, src);
      return r.ok ? "read" : r.why;
    };
    // A slash after "}" may divide an object or start a regular expression after a block.
    expect(refusal("function f() {}\n/re/.test(s);\n")).toBe("line 2: a slash that may divide or start a regular expression");
    // After a line break a value may have ended a statement or a type annotation.
    expect(refusal("const total = sum\n  / count;\n")).toContain("a slash that may divide");
    expect(refusal("function* g() { yield /x/; }\n")).toContain("a slash that may divide");
    expect(refusal("const el = <div>// not a comment</div>;\n", "src/a.tsx")).toBe("line 1: what may be JSX, which this proof does not read");
    expect(refusal("return <b>x</b>;\n", "src/a.js")).toContain("JSX");
    expect(refusal("const n = 1 < 2;\n", "src/a.jsx")).toBe("read");
    expect(refusal("const s = 'open\n';\n")).toBe("line 1: a string that never ends");
    expect(refusal("const t = `${a\n")).toContain("unbalanced brackets");
    expect(refusal("/* never closed\n")).toContain("a comment that never ends");
    expect(refusal("const \\u0061 = 1;\n")).toContain("a backslash");
    expect(refusal("x = y <!-- z\n", "src/a.js")).toContain("HTML-like comment");
    expect(refusal("while (n --> 0) step();\n")).toContain("HTML-like comment");
    expect(refusal("const n = 1.toString();\n")).toContain("a number that runs into a name");
    expect(refusal("f(]\n")).toContain("unbalanced brackets");
    // TypeScript's non-null assertion leaves a value, so the slash divides.
    expect(tokens("const w = this.size[i]! / 2;\n")).toContain("/");
    expect(tokens("const q = a?.5:1;\n")).toEqual(["const", "q", "=", "a", "?", ".5", ":", "1", ";"]);
  });

  it("treats a hashbang as code", () => {
    const src = "#!/usr/bin/env node\n// run it\nmain();\n";
    expect(prove(src, src.replace("run it", "start it"), "bin/a.js").verdict).toBe("pass");
    expect(prove(src, src.replace("env node", "env node --inspect"), "bin/a.js").verdict).toBe("no");
  });

  it("compares line breaks between tokens but not before the first", () => {
    expect(sameCode([{ text: "a", nl: true }], [{ text: "a", nl: false }])).toBe(true);
    expect(sameCode([{ text: "a", nl: false }, { text: "b", nl: true }], [{ text: "a", nl: false }, { text: "b", nl: false }])).toBe(false);
  });

  it("leaves a change larger than it reads to the other layers", () => {
    const big = `${"// filler\n".repeat(200)}export const x = 1;\n`;
    expect(commentOnlyProof([{ path: "src/a.ts", before: big, after: big.replace("filler", "padding") }], 1_000)).toMatchObject({ verdict: "no", reasons: ["the change is larger than this proof reads (1000 characters)"] });
  });
});
