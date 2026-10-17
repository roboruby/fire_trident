import { describe, expect, it } from "vitest";
import { codeTokens, movedFrom, reformattedFrom } from "../src/index.ts";

/** The token comparison `why` walks a line with: formatting-only landings, and blocks moved from another file. */

const lines = (...l: string[]): string => `${l.join("\n")}\n`;

describe("codeTokens", () => {
  it("ignores whitespace, reads both quote styles alike and drops trailing commas and statement semicolons", () => {
    const keys = (t: string) => codeTokens(t).map((k) => k.key);
    expect(keys("const a = 'x';")).toEqual(keys('const   a="x"'));
    expect(keys("f(a, b,)")).toEqual(keys("f(a, b)"));
    expect(keys("const o = { a: 1, };")).toEqual(keys("const o = { a: 1 }"));
    expect(keys("for (let i = 0; i < n; i++) x();")).toContain(";");
    expect(keys("const s = 'it\\'s';")).toEqual(keys('const s = "it\'s";'));
    expect(keys("a === b")).toEqual(["a", "===", "b"]);
    expect(keys("x = `a ${b}  c`")).toEqual(["x", "=", "t:`a ${b}  c`"]);
  });

  it("keeps each token on the line it starts on", () => {
    const t = codeTokens("a\n/* one\ntwo */\n'str'\nb");
    expect(t.map((k) => `${k.line}:${k.key}`)).toEqual(["0:a", "1:/*", "1:c:one", "2:c:two", "2:*/", "3:s:str", "4:b"]);
  });
});

describe("reformattedFrom", () => {
  it("skips a whitespace-only change, naming the line it came from", () => {
    const before = lines("function f() {", "return  a+b;", "}");
    const after = lines("function f() {", "  return a + b;", "}");
    expect(reformattedFrom("src/f.ts", before, after, 1)).toBe(1);
  });

  it("skips a change of quote style", () => {
    const before = lines("import { x } from 'y';", "export const z = 'z';");
    const after = lines('import { x } from "y";', 'export const z = "z";');
    expect(reformattedFrom("src/z.js", before, after, 1)).toBe(1);
  });

  it("skips trailing commas added or dropped", () => {
    const before = lines("const o = {", "  a: 1,", "  b: 2", "};");
    const after = lines("const o = {", "  a: 1,", "  b: 2,", "};");
    expect(reformattedFrom("src/o.ts", before, after, 2)).toBe(2);
    expect(reformattedFrom("src/o.ts", after, before, 2)).toBe(2);
  });

  it("skips semicolons added or dropped", () => {
    const before = lines("const a = 1", "export default a");
    const after = lines("const a = 1;", "export default a;");
    expect(reformattedFrom("src/a.mjs", before, after, 0)).toBe(0);
    expect(reformattedFrom("src/a.mjs", before, after, 1)).toBe(1);
  });

  it("skips a wrap that joins or splits the same tokens, naming the first line they came from", () => {
    const split = lines("const r = call(", "  first,", "  second,", ");");
    const joined = lines("const r = call(first, second);");
    expect(reformattedFrom("src/r.ts", split, joined, 0)).toBe(0);
    expect(reformattedFrom("src/r.ts", joined, split, 2)).toBe(0);
  });

  it("does not skip a change of meaning, or a token removed from the middle of the line", () => {
    expect(reformattedFrom("src/a.ts", lines("const a = 1;"), lines("const a = 2;"), 0)).toBeNull();
    expect(reformattedFrom("src/a.ts", lines("f(a, c, b);"), lines("f(a, b);"), 0)).toBeNull();
    expect(reformattedFrom("src/a.ts", lines("x"), lines("x", ""), 1)).toBeNull();
  });

  it("compares JSON too, and nothing in other files", () => {
    expect(reformattedFrom("package.json", lines('{"a": 1}'), lines("{", '  "a": 1', "}"), 1)).toBe(0);
    expect(reformattedFrom("app.py", lines("x = 'a'"), lines('x = "a"'), 0)).toBeNull();
  });
});

describe("movedFrom", () => {
  const helper = lines("export function total(items) {", "  let sum = 0;", "  for (const i of items) sum += i.price;", "  return sum;", "}");
  const b = lines("import { x } from './x';", "", helper.trimEnd(), "export const y = x;");
  const bAfter = lines("import { x } from './x';", "", "export const y = x;");

  it("finds a block another file of the landing lost, reformatted on the way, and the line it held there", () => {
    const moved = lines('// totals', "export function total(items) {", "  let sum = 0", '  for (const i of items) sum += i.price', "  return sum", "}");
    expect(movedFrom("src/total.ts", null, moved, 3, [{ path: "src/b.ts", before: b, after: bAfter }])).toEqual({ path: "src/b.ts", line: 4 });
  });

  it("is no move when the other file kept the block, the block is short, or it is only closing brackets", () => {
    const moved = lines("export function total(items) {", "  let sum = 0;", "  for (const i of items) sum += i.price;", "  return sum;", "}");
    expect(movedFrom("src/total.ts", null, moved, 2, [{ path: "src/b.ts", before: b, after: b }])).toBeNull();
    const two = lines("  return sum;", "}");
    const lost = lines("a();", "  return sum;", "}", "b();");
    expect(movedFrom("src/t.ts", null, two, 0, [{ path: "src/b.ts", before: lost, after: lines("a();", "b();") }])).toBeNull();
    const braces = lines("    }", "  }", "}");
    expect(movedFrom("src/t.ts", null, braces, 1, [{ path: "src/b.ts", before: lines("go();", "    }", "  }", "}"), after: lines("go();") }])).toBeNull();
  });

  it("is no move when the line was only partly new in its file", () => {
    const before = lines("export function total(items) {", "  return 0;", "}");
    const after = lines("export function total(items) {", "  let sum = 0;", "  for (const i of items) sum += i.price;", "  return sum;", "}");
    expect(movedFrom("src/total.ts", before, after, 0, [{ path: "src/b.ts", before: b, after: bAfter }])).toBeNull();
  });
});
