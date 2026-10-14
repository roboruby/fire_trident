import { describe, expect, it } from "vitest";
import { insertionUnion, standaloneLines } from "../src/insertions.ts";

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
