import { describe, expect, it } from "vitest";
import { footprintCovers, pathsOverlap, residualPaths } from "../src/residual.ts";
import type { FileVersion } from "../src/types.ts";

const writes = (...paths: string[]): FileVersion[] => paths.map((path) => ({ path, blob: "f".repeat(40) }));

describe("residualPaths", () => {
  it("is empty for an empty write set", () => {
    expect(residualPaths(["src/"], [])).toEqual([]);
  });

  it("is empty when every write was predicted (exact, directory, glob)", () => {
    const footprint = ["src/a.ts", "lib/", "docs/**/*.md"];
    expect(residualPaths(footprint, writes("src/a.ts", "lib/x/y.ts", "docs/a/b.md", "docs/c.md"))).toEqual([]);
  });

  it("returns unpredicted writes in write-set order", () => {
    expect(residualPaths(["src/a.ts"], writes("z.ts", "src/a.ts", "a.ts"))).toEqual(["z.ts", "a.ts"]);
  });

  it("treats every write as residual with an empty footprint", () => {
    expect(residualPaths([], writes("a.ts", "b/c.ts"))).toEqual(["a.ts", "b/c.ts"]);
  });

  it("reports a repeated write once", () => {
    expect(residualPaths([], writes("x.ts", "x.ts"))).toEqual(["x.ts"]);
  });

  it("requires a directory entry to match on a '/' boundary", () => {
    expect(residualPaths(["src/"], writes("src/deep/a.ts", "srcx/a.ts"))).toEqual(["srcx/a.ts"]);
  });

  it("treats an entry without a trailing slash as an exact path", () => {
    expect(residualPaths(["src"], writes("src/a.ts", "src"))).toEqual(["src/a.ts"]);
  });

  it("supports braces and keeps * inside one directory", () => {
    expect(residualPaths(["src/*.{ts,tsx}"], writes("src/a.tsx", "src/b.ts", "src/c.js", "src/d/e.ts"))).toEqual(["src/c.js", "src/d/e.ts"]);
  });

  it("counts deletions as writes", () => {
    expect(residualPaths([], [{ path: "old.ts", blob: null }])).toEqual(["old.ts"]);
    expect(residualPaths(["old.ts"], [{ path: "old.ts", blob: null }])).toEqual([]);
  });

  it("ignores a leading './' in footprint entries", () => {
    expect(residualPaths(["./src/a.ts", "./lib/"], writes("src/a.ts", "lib/x.ts"))).toEqual([]);
  });

  it("never lets an empty entry cover anything, while '**' covers everything", () => {
    expect(residualPaths([""], writes("a.ts"))).toEqual(["a.ts"]);
    expect(residualPaths(["**"], writes("a.ts", "deep/er/b.ts"))).toEqual([]);
  });
});

describe("footprintCovers", () => {
  it.each([
    ["src/a.ts", "src/a.ts", true],
    ["src/a.ts", "src/b.ts", false],
    ["src/", "src/a.ts", true],
    ["src/", "src/a/b/c.ts", true],
    ["src/", "src", false],
    ["src/", "srcx/a.ts", false],
    ["src/*/", "src/a/b/c.ts", true],
    ["src/*/", "src/a.ts", false],
    ["src/**/*.ts", "src/a/b.ts", true],
    ["src/**/*.ts", "src/a/b.js", false],
    ["./src/", "src/a.ts", true],
    ["", "a.ts", false],
  ] as const)("footprintCovers(%j, %j) = %s", (entry, path, covered) => {
    expect(footprintCovers(entry, path)).toBe(covered);
  });
});

describe("pathsOverlap", () => {
  it("is symmetric", () => {
    expect(pathsOverlap("src/", "src/a.ts")).toBe(true);
    expect(pathsOverlap("src/a.ts", "src/")).toBe(true);
    expect(pathsOverlap("src/", "src/a/")).toBe(true);
    expect(pathsOverlap("src/**/*.ts", "src/*.ts")).toBe(true);
  });

  it("is false for disjoint entries", () => {
    expect(pathsOverlap("src/a.ts", "src/b.ts")).toBe(false);
    expect(pathsOverlap("lib/", "src/a.ts")).toBe(false);
    expect(pathsOverlap("src/*.ts", "src/a/")).toBe(false);
  });
});
