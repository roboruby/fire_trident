import { describe, expect, it } from "vitest";
import type { TreeEntry } from "isomorphic-git";
import { applyTreeChanges, buildTree, ensureRepo, memoryFs, writeLocalBlob, type GitRepo, type PathChange } from "../../src/artifacts/git.ts";
import { BoundedMap, applyTreeChangesCached } from "../../src/trunk/surgery.ts";

const enc = new TextEncoder();

async function repo(): Promise<GitRepo> {
  const r: GitRepo = { fs: memoryFs(), dir: "/r", cache: {} };
  await ensureRepo(r, "https://example.invalid/git/ns/repo.git");
  return r;
}

describe("cached tree surgery", () => {
  it("builds the same trees as applyTreeChanges along a chain, re-reading nothing it wrote", async () => {
    const r = await repo();
    const blob = (s: string) => writeLocalBlob(r, enc.encode(s));
    const files = new Map<string, { blob: string; mode: string }>();
    for (let d = 0; d < 6; d++) for (let f = 0; f < 4; f++) files.set(`bench/r${d}/f${f}.txt`, { blob: await blob(`${d}-${f}`), mode: "100644" });
    files.set("README.md", { blob: await blob("readme"), mode: "100644" });
    const root = await buildTree(r, files);
    const trees = new Map<string, TreeEntry[]>();
    let plain = root;
    let cached = root;
    const steps: Array<Map<string, PathChange>> = [
      new Map([["bench/r1/new.txt", { blob: await blob("n1"), mode: "100644" }]]),
      new Map<string, PathChange>([["bench/r2/f0.txt", null], ["bench/r2/f1.txt", { blob: await blob("x"), mode: "100755" }]]),
      new Map<string, PathChange>([["bench/r3/f0.txt", null], ["bench/r3/f1.txt", null], ["bench/r3/f2.txt", null], ["bench/r3/f3.txt", null]]),
      new Map([["deep/a/b/c.txt", { blob: await blob("c"), mode: "100644" }]]),
    ];
    for (const changes of steps) {
      plain = await applyTreeChanges(r, plain, changes);
      cached = await applyTreeChangesCached(r, trees, cached, changes);
      expect(cached).toBe(plain);
      // The new root is cached, so the next step reads it from memory.
      expect(trees.has(cached)).toBe(true);
    }
    expect((trees.get(cached) ?? []).map((e) => e.path).sort()).toEqual(["README.md", "bench", "deep"]);
  });

  it("evicts the oldest entries beyond its bound", () => {
    const m = new BoundedMap<string, number>(3);
    for (const k of ["a", "b", "c", "d"]) m.set(k, 1);
    expect([...m.keys()]).toEqual(["b", "c", "d"]);
    m.set("b", 2); // re-setting refreshes its position
    m.set("e", 1);
    expect([...m.keys()]).toEqual(["d", "b", "e"]);
  });
});
