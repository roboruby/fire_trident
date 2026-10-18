import { describe, expect, it } from "vitest";
import { insertionUnion, openingLines, sharedEnds, standaloneLines } from "../src/insertions.ts";

/** A block of lines, each ending with "\n". */
const block = (...lines: string[]): string[] => lines.map((l) => `${l}\n`);

describe("standaloneLines", () => {
  it("marks whole one-line statements and entries", () => {
    expect(standaloneLines(block(`import { a } from "./a.ts";`, `export * from "./b.ts";`, "export const c = 1; // a note"))).toEqual([true, true, true]);
    // Registry and list entries end with a comma.
    expect(standaloneLines(block("  'alpha',", "  'beta',"))).toEqual([true, true]);
    expect(standaloneLines(block("router.get('/a', a);", "app.use(cors());"))).toEqual([true, true]);
  });

  it("never marks a line of a multi-line construct, a blank line or punctuation", () => {
    // A function: its opening line opens a bracket, its body is inside it and indented, its brace has no name.
    expect(standaloneLines(block("", "export function a() {", "  return null;", "}"))).toEqual([false, false, false, false]);
    // A template literal spanning lines, a block comment, a triple-quoted string.
    expect(standaloneLines(block("const q = `", "SELECT 1", "`;"))).toEqual([false, false, false]);
    expect(standaloneLines(block("/*", "export const hidden = 1;", "*/"))).toEqual([false, false, false]);
    expect(standaloneLines(block('doc = """', "export const x = 1;", '"""'))).toEqual([false, false, false]);
    // A call whose arguments go on.
    expect(standaloneLines(block("register(", "  a,", ");"))).toEqual([false, false, false]);
    // A bracket closed that the block never opened: what follows is not at the top of the block either.
    expect(standaloneLines(block("x: 1,", "}", "const y = 2;"))).toEqual([true, false, false]);
  });

  it("leaves out lines that attach to the next one, lines whose statement goes on, and lines that open an indented block", () => {
    expect(standaloneLines(block("@staticmethod", "def a():", "    return None"))).toEqual([false, false, false]);
    expect(standaloneLines(block("// helpers", "# a comment", "[section]", "<item key='a' />", "-- note"))).toEqual([false, false, false, false, false]);
    expect(standaloneLines(block("const total = a +", "b;"))).toEqual([false, false]);
    expect(standaloneLines(block("items:", "  - a"))).toEqual([false, false]);
    // A line after a decorator or a comment belongs to it.
    expect(standaloneLines(block("@logged()", "export class A {}", "// b", "", "export const b = 1;", "export const c = 2;"))).toEqual([false, false, false, false, false, true]);
    // A sentence ends with a period: prose lines are never dropped.
    expect(standaloneLines(block("See the docs."))).toEqual([false]);
    // A line more indented than the block's least is inside something.
    expect(standaloneLines(block("a = 1", "  b = 2"))).toEqual([false, false]);
    // A one-line string left open (an apostrophe in prose) is out of shape.
    expect(standaloneLines(block("it's here"))).toEqual([false]);
  });
});

describe("insertionUnion", () => {
  it("keeps trunk's lines first, then the change's", () => {
    expect(insertionUnion(block("export const a = 1;"), block("export const b = 2;"), true)).toEqual(block("export const a = 1;", "export const b = 2;"));
  });

  it("drops a standalone line of the change that trunk already inserted, once for each of trunk's", () => {
    expect(insertionUnion(block(`import { z } from "./z.ts";`), block(`import { z } from "./z.ts";`, `import { y } from "./y.ts";`), false)).toEqual(
      block(`import { z } from "./z.ts";`, `import { y } from "./y.ts";`),
    );
    // Trunk inserted the entry once; the change inserted it twice: one of the change's stays.
    expect(insertionUnion(block("  'a',"), block("  'a',", "  'a',"), false)).toEqual(block("  'a',", "  'a',"));
    // Line endings are not compared.
    expect(insertionUnion(["export const a = 1;\r\n"], ["export const a = 1;\n", "export const b = 2;\n"], true)).toEqual(["export const a = 1;\r\n", "export const b = 2;\n"]);
  });

  it("keeps two functions whole although their braces, blank lines and bodies are the same", () => {
    const a = block("", "export function a() {", "  return null;", "}");
    const b = block("", "export function b() {", "  return null;", "}");
    expect(insertionUnion(a, b, true)).toEqual([...a, ...b]);
  });

  it("never drops a line trunk inserted inside a multi-line construct", () => {
    const ours = block("const q = `", "export const x = 1;", "`;");
    expect(insertionUnion(ours, block("export const x = 1;"), true)).toEqual([...ours, "export const x = 1;\n"]);
  });

  it("refuses a union that would join two lines into one", () => {
    // Trunk's insertion ends the file without a newline: the change's lines cannot follow it.
    expect(insertionUnion(["export const a = 1;"], block("export const b = 2;"), true)).toBeNull();
    // The change's insertion ends the file without one: fine as the last line, not before base lines.
    expect(insertionUnion(block("export const a = 1;"), ["export const b = 2;"], true)).toEqual(["export const a = 1;\n", "export const b = 2;"]);
    expect(insertionUnion(block("export const a = 1;"), ["export const b = 2;"], false)).toBeNull();
    // Nothing of the change is left: trunk's insertion as it is.
    expect(insertionUnion(["export const a = 1;"], ["export const a = 1;"], true)).toEqual(["export const a = 1;"]);
  });
});

/** Two functions, each with a blank line before it. */
const fnF = block("", "export function f(s: string): string {", "  return s.trim();", "}");
const fnG = block("", "export function g(n: number): number {", "  return n + 1;", "}");

describe("openingLines", () => {
  it("marks the line that opens a multi-line construct at the top of the block", () => {
    expect(openingLines(block("export function f() {", "  return 1;", "}"))).toEqual([true, false, false]);
    expect(openingLines(block("@Injectable()", "export class A {", "}"))).toEqual([false, true, false]);
    expect(openingLines(block("/** Docs. */", "export function f() {", "}"))).toEqual([false, true, false]);
    expect(openingLines(block("# Docs.", "def a():", "    return None"))).toEqual([false, true, false]);
    expect(openingLines(block("register(", "  a,", ");"))).toEqual([true, false, false]);
    expect(openingLines(block("const q = `", "SELECT 1", "`;"))).toEqual([true, false, false]);
  });

  it("leaves out whole one-line statements, lines inside a construct or going on from the line before, and openings that name nothing", () => {
    expect(openingLines(block(`import { a } from "./a.ts";`, "export const b = 1;"))).toEqual([false, false]);
    expect(openingLines(block("const total = a +", "  b;"))).toEqual([true, false]);
    expect(openingLines(block("import {", "  a,", `} from "./a.ts";`))).toEqual([false, false, false]);
    expect(openingLines(block("export default {", "  a: 1,", "};"))).toEqual([false, false, false]);
  });
});

describe("sharedEnds", () => {
  it("counts the whole statements both insertions start or end with", () => {
    expect(sharedEnds(fnF, [...fnF, ...fnG])).toEqual({ head: 4, tail: 0 });
    expect(sharedEnds([...fnG, ...fnF], fnF)).toEqual({ head: 0, tail: 4 });
    expect(sharedEnds(block("import a;", "import c;"), block("import a;", "import b;"))).toEqual({ head: 1, tail: 0 });
  });

  it("never cuts inside a construct, and never sets aside only blank lines and braces", () => {
    // The same signature and closing brace around different bodies: nothing is shared whole.
    expect(sharedEnds(block("function f() {", "}"), block("function f() {", "  x();", "}"))).toEqual({ head: 0, tail: 0 });
    // Two functions sharing the blank line before them and the last two lines of their bodies.
    const fa = block("", "export function fa() {", "  return null;", "}");
    const fb = block("", "export function fb() {", "  return null;", "}");
    expect(sharedEnds(fa, fb)).toEqual({ head: 0, tail: 0 });
    // A Python body line followed by another body line is no place to cut.
    expect(sharedEnds(block("def a():", "    x = 1", "    y = 2"), block("def a():", "    x = 1", "    z = 3"))).toEqual({ head: 0, tail: 0 });
  });
});

describe("insertionUnion: what both insertions hold lands once", () => {
  it("lands a function once when one side inserted it and the other inserted it with another after or before it", () => {
    // F against F+G, and F+G against F: F, then G.
    expect(insertionUnion(fnF, [...fnF, ...fnG], true)).toEqual([...fnF, ...fnG]);
    expect(insertionUnion([...fnF, ...fnG], fnF, true)).toEqual([...fnF, ...fnG]);
    // G+F against F, and F against G+F: G, then F.
    expect(insertionUnion([...fnG, ...fnF], fnF, true)).toEqual([...fnG, ...fnF]);
    expect(insertionUnion(fnF, [...fnG, ...fnF], true)).toEqual([...fnG, ...fnF]);
    // What both start with lands once, then trunk's rest, then the change's.
    const h = block("", "export const h = 1;");
    expect(insertionUnion([...fnF, ...fnG], [...fnF, ...h], true)).toEqual([...fnF, ...fnG, ...h]);
  });

  it("refuses a union that would land a function twice, or two bodies under one signature", () => {
    // The same function inside both insertions, not at their ends.
    expect(insertionUnion([...fnF, ...fnG], [...block("", "export const h = 1;"), ...fnF, ...block("// end")], true)).toBeNull();
    // The same function with the blank line before it on one side and after it on the other.
    expect(insertionUnion(fnF, [...fnF.slice(1), "\n"], true)).toBeNull();
    // One signature, two bodies.
    expect(insertionUnion(block("export function f() {", "  return 1;", "}"), block("export function f() {", "  return 2;", "}"), true)).toBeNull();
  });

  it("still lands two different constructs that open alike or share their last lines", () => {
    const ia = block("import {", "  a,", "} from './a.ts';");
    const ib = block("import {", "  b,", "} from './b.ts';");
    expect(insertionUnion(ia, ib, false)).toEqual([...ia, ...ib]);
    const ta = block('  it("a", () => {', "    const w = setup();", "    expect(w.a).toBe(1);", "  });");
    const tb = block('  it("b", () => {', "    const w = setup();", "    expect(w.b).toBe(2);", "  });");
    expect(insertionUnion(ta, tb, true)).toEqual([...ta, ...tb]);
  });

  it("keeps an import, or an export from another module, once when the two differ only in their quotes", () => {
    expect(insertionUnion(block(`import { z } from "./z.ts";`), block("import { z } from './z.ts';", "import { y } from './y.ts';"), false)).toEqual(
      block(`import { z } from "./z.ts";`, "import { y } from './y.ts';"),
    );
    expect(insertionUnion(block("export * from './a.ts';", "export const b = 1;"), block("export const c = 2;", `export * from "./a.ts";`), true)).toEqual(
      block("export * from './a.ts';", "export const b = 1;", "export const c = 2;"),
    );
    // Other lines that differ only in their quotes stay two lines.
    expect(insertionUnion(block(`log("a");`), block("log('a');"), true)).toEqual(block(`log("a");`, "log('a');"));
  });

  it("lands the shared lines as trunk has them, and still refuses to join two lines into one", () => {
    expect(insertionUnion(["export const a = 1;\r\n", "export const b = 2;\r\n"], block("export const a = 1;", "export const b = 2;", "export const c = 3;"), true)).toEqual([
      "export const a = 1;\r\n",
      "export const b = 2;\r\n",
      "export const c = 3;\n",
    ]);
    // Trunk ends the file without a newline: the change's rest cannot follow its last shared line.
    expect(insertionUnion(["export const a = 1;\n", "export const b = 2;"], block("export const a = 1;", "export const b = 2;", "export const c = 3;"), true)).toBeNull();
  });
});
