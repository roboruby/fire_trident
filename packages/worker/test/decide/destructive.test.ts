import { describe, expect, it } from "vitest";
import {
  HALF_FILE_MIN_LINES,
  NET_REMOVAL_LINES,
  autonomyRefusal,
  destructiveCheck,
  destructiveFact,
  destructiveRecord,
  proofRefusal,
  type DestructiveFile,
} from "../../src/decide/destructive.ts";

const MODULE = "export function add(a: number, b: number): number {\n  return a + b;\n}\n";
const TWO = `${MODULE}\nexport function sub(a: number, b: number): number {\n  return a - b;\n}\n`;

let seq = 0;
const sha = (): string => `${(++seq).toString(16).padStart(8, "0")}${"b".repeat(32)}`;

/** A modified file. */
function edit(path: string, before: string, after: string): DestructiveFile {
  return { path, beforeBlob: sha(), afterBlob: sha(), before, after };
}
/** A deleted file. */
function gone(path: string, before: string, beforeBlob = sha()): DestructiveFile {
  return { path, beforeBlob, afterBlob: null, before, after: null };
}
/** A created file. */
function made(path: string, after: string, afterBlob = sha()): DestructiveFile {
  return { path, beforeBlob: null, afterBlob, before: null, after };
}
/** `n` numbered statement lines inside one exported function. */
function body(n: number): string {
  return `export function sum(): number {\n  let total = 0;\n${Array.from({ length: n }, (_, i) => `  total += ${i};\n`).join("")}  return total;\n}\n`;
}

describe("destructiveFact: what a change takes away", () => {
  it("names a deleted file", () => {
    const f = destructiveFact([gone("src/old.ts", MODULE)]);
    expect(f).toEqual({ hits: [{ kind: "deleted", path: "src/old.ts", label: "deletes src/old.ts" }], unknown: [] });
  });

  it("names a rename: a deletion plus a created file with the same blob or mostly the same lines", () => {
    const blob = sha();
    expect(destructiveFact([gone("src/a.ts", MODULE, blob), made("src/b.ts", MODULE, blob)]).hits).toEqual([
      { kind: "renamed", path: "src/a.ts", to: "src/b.ts", label: "renames src/a.ts to src/b.ts" },
    ]);
    // Edited while it moved: still a rename when most of its lines came along.
    const moved = destructiveFact([gone("src/a.ts", TWO), made("lib/a.ts", TWO.replace("a - b", "b - a"))]);
    expect(moved.hits.map((h) => h.label)).toEqual(["renames src/a.ts to lib/a.ts"]);
    // A created file unlike the deleted one: a deletion and an addition.
    const unlike = destructiveFact([gone("src/a.ts", TWO), made("src/c.ts", "export const c = 3;\n")]);
    expect(unlike.hits.map((h) => h.label)).toEqual(["deletes src/a.ts"]);
  });

  it("names exports a module stops exporting, read the way the export guard reads them", () => {
    const f = destructiveFact([edit("src/math.ts", TWO, TWO.replace("export function sub", "function sub"))]);
    expect(f.hits).toEqual([{ kind: "export-removed", path: "src/math.ts", names: ["sub"], label: "removes the export sub from src/math.ts" }]);
    // The second declarator of an export list counts too.
    const list = destructiveFact([edit("src/k.ts", "export const a = 1, b = 2;\n", "export const a = 1;\n")]);
    expect(list.hits.map((h) => h.label)).toEqual(["removes the export b from src/k.ts"]);
    // A name moved into an export list is kept.
    const kept = destructiveFact([edit("src/math.ts", TWO, `${TWO.replace("export function sub", "function sub")}export { sub };\n`)]);
    expect(kept.hits).toEqual([]);
  });

  it(`names a file that loses ${NET_REMOVAL_LINES} lines or more net, or more than half of a file of ${HALF_FILE_MIN_LINES} lines or more`, () => {
    const big = destructiveFact([edit("src/sum.ts", body(400), body(400 - NET_REMOVAL_LINES))]);
    expect(big.hits).toEqual([{ kind: "net-removal", path: "src/sum.ts", lines: NET_REMOVAL_LINES, of: 404, label: `removes ${NET_REMOVAL_LINES} lines net from src/sum.ts, which had 404` }]);
    expect(destructiveFact([edit("src/sum.ts", body(400), body(400 - NET_REMOVAL_LINES + 1))]).hits).toEqual([]);
    // Half of a 60-line file.
    expect(destructiveFact([edit("src/sum.ts", body(56), body(25))]).hits.map((h) => h.label)).toEqual(["removes 31 lines net from src/sum.ts, which had 60"]);
    expect(destructiveFact([edit("src/sum.ts", body(56), body(26))]).hits).toEqual([]);
    // A short file rewritten is ordinary.
    expect(destructiveFact([edit("src/sum.ts", body(30), body(2))]).hits).toEqual([]);
  });

  it(`names modified files that lose ${NET_REMOVAL_LINES} lines or more together`, () => {
    const files = Array.from({ length: 5 }, (_, i) => edit(`src/f${i}.ts`, body(196), body(156)));
    expect(destructiveFact(files).hits).toEqual([{ kind: "net-removal", lines: NET_REMOVAL_LINES, label: `removes ${NET_REMOVAL_LINES} lines net across 5 files` }]);
  });

  it("finds nothing in an ordinary addition that only grows a file, nor in a new file", () => {
    const grown = destructiveFact([edit("src/math.ts", MODULE, TWO), made("src/new.ts", MODULE), edit("README.md", "# App\n", "# App\n\nUsage.\n")]);
    expect(grown).toEqual({ hits: [], unknown: [] });
    expect(destructiveCheck(grown)).toMatchObject({ name: "destructive changes", ok: true, detail: expect.stringContaining("takes nothing away") });
    expect(destructiveRecord(grown)).toEqual({});
    expect(autonomyRefusal(grown)).toBeNull();
    expect(proofRefusal(grown)).toBeNull();
  });

  it("fails closed: a file it cannot read to tell leaves the fact unknown", () => {
    const cjs = "module.exports = { add: (a, b) => a + b };\n";
    const f = destructiveFact([
      edit("src/legacy.js", cjs, `${cjs}// more\n`),
      edit("src/index.ts", "export * from './a.ts';\n", "export * from './a.ts';\nexport * from './b.ts';\n"),
      { path: "logo.png", beforeBlob: sha(), afterBlob: sha(), before: null, after: null, binary: true },
      { path: "src/lost.ts", beforeBlob: sha(), afterBlob: sha(), before: null, after: MODULE },
    ]);
    expect(f.hits).toEqual([]);
    expect(f.unknown).toEqual([
      "src/legacy.js: its exports cannot be read for sure",
      "src/index.ts: its exports cannot be read for sure",
      "logo.png: it is not text, so what it removes cannot be read",
      "src/lost.ts: its old text could not be read",
    ]);
    expect(autonomyRefusal(f)).toBe(
      "Earned autonomy needs to know whether a change is destructive, and this one could not be read to tell (src/legacy.js: its exports cannot be read for sure, src/index.ts: its exports cannot be read for sure, logo.png: it is not text, so what it removes cannot be read and src/lost.ts: its old text could not be read)",
    );
    expect(proofRefusal(f)).toBeNull();
    expect(destructiveCheck(f)).toMatchObject({ ok: false, detail: expect.stringContaining("earned autonomy does not apply") });
    expect(destructiveRecord(f)).toEqual({ destructive: f });
  });

  it("never throws: a failure of its own leaves the fact unknown", () => {
    const broken = [{ path: "src/a.ts", beforeBlob: sha(), afterBlob: sha(), get before(): string { throw new Error("boom"); }, after: MODULE }] as unknown as DestructiveFile[];
    expect(destructiveFact(broken)).toEqual({ hits: [], unknown: ["the destructive check could not run (boom)"] });
  });
});

describe("the sentences", () => {
  it("name what the change takes away, in the order found", () => {
    const f = destructiveFact([gone("src/x.ts", MODULE), edit("src/math.ts", TWO, TWO.replace("export function sub", "function sub"))]);
    expect(autonomyRefusal(f)).toBe("Earned autonomy does not land destructive changes: this change deletes src/x.ts and removes the export sub from src/math.ts");
    expect(proofRefusal(f)).toBe("A deterministic proof does not land destructive changes alone: this change deletes src/x.ts and removes the export sub from src/math.ts");
    expect(destructiveCheck(f)).toMatchObject({ ok: false, detail: expect.stringMatching(/^destructive: deletes src\/x\.ts; removes the export sub from src\/math\.ts; earned autonomy/) });
  });

  it("treat a fact that was never computed as unknown", () => {
    expect(autonomyRefusal(undefined)).toBe("Earned autonomy needs to know whether a change is destructive, and that was not computed for this one");
    expect(autonomyRefusal(null)).not.toBeNull();
    expect(proofRefusal(undefined)).toBeNull();
  });

  it("list five entries, then how many more", () => {
    const f = destructiveFact(Array.from({ length: 7 }, (_, i) => gone(`src/f${i}.ts`, MODULE)));
    expect(autonomyRefusal(f)).toBe("Earned autonomy does not land destructive changes: this change deletes src/f0.ts, deletes src/f1.ts, deletes src/f2.ts, deletes src/f3.ts, deletes src/f4.ts and 2 more");
  });
});
