import { describe, expect, it } from "vitest";
import { diffTrees, entryAtPath, onFirstParentChain, readFileAt } from "../../src/mcp/gitread.ts";
import type { TreeEntryLike } from "../../src/mcp/gitread.ts";

/** A tiny content-addressed object store: trees by id, built from nested objects. */
class Store {
  trees = new Map<string, TreeEntryLike[]>();
  reads = 0;
  private n = 0;

  /** Build a tree from { name: blobId | subtree | ["100755", blobId] } and return its id. */
  tree(spec: Record<string, unknown>): string {
    const entries: TreeEntryLike[] = Object.entries(spec).map(([name, v]) => {
      if (typeof v === "string") return { name, mode: "100644", hash: v, type: "blob" };
      if (Array.isArray(v)) return { name, mode: String(v[0]), hash: String(v[1]), type: v[0] === "160000" ? "gitlink" : "blob" };
      return { name, mode: "40000", hash: this.tree(v as Record<string, unknown>), type: "tree" };
    });
    const key = JSON.stringify(entries);
    for (const [id, e] of this.trees) if (JSON.stringify(e) === key) return id;
    const id = `t${String(++this.n).padStart(39, "0")}`;
    this.trees.set(id, entries);
    return id;
  }

  readTree = async (hash: string): Promise<TreeEntryLike[] | null> => {
    this.reads++;
    return this.trees.get(hash) ?? null;
  };
}

describe("diffTrees", () => {
  it("reports added, modified and deleted files with head blob ids, sorted", async () => {
    const s = new Store();
    const base = s.tree({ "README.md": "b1", src: { "a.ts": "b2", "b.ts": "b3", lib: { "u.ts": "b4" } }, docs: { "g.md": "b5" } });
    const head = s.tree({ "README.md": "b1", src: { "a.ts": "b2x", lib: { "u.ts": "b4", "new.ts": "b6" } }, docs: { "g.md": "b5" } });
    expect(await diffTrees(s.readTree, base, head)).toEqual([
      { path: "src/a.ts", blob: "b2x" },
      { path: "src/b.ts", blob: null },
      { path: "src/lib/new.ts", blob: "b6" },
    ]);
  });

  it("skips identical subtrees by hash", async () => {
    const s = new Store();
    const big: Record<string, string> = {};
    for (let i = 0; i < 50; i++) big[`f${i}.ts`] = `blob${i}`;
    const base = s.tree({ vendor: big, src: { "a.ts": "x" } });
    const head = s.tree({ vendor: big, src: { "a.ts": "y" } });
    s.reads = 0;
    expect(await diffTrees(s.readTree, base, head)).toEqual([{ path: "src/a.ts", blob: "y" }]);
    expect(s.reads).toBe(4);
  });

  it("handles a file replaced by a directory and mode-only changes", async () => {
    const s = new Store();
    const base = s.tree({ x: "bx", run: "br" });
    const head = s.tree({ x: { "inner.ts": "bi" }, run: ["100755", "br"] });
    expect(await diffTrees(s.readTree, base, head)).toEqual([
      { path: "run", blob: "br" },
      { path: "x", blob: null },
      { path: "x/inner.ts", blob: "bi" },
    ]);
  });

  it("ignores submodule links and enforces limits", async () => {
    const s = new Store();
    const base = s.tree({ mod: ["160000", "c1"], a: "1" });
    const head = s.tree({ mod: ["160000", "c2"], a: "2" });
    expect(await diffTrees(s.readTree, base, head)).toEqual([{ path: "a", blob: "2" }]);
    const many = s.tree(Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`f${i}`, `n${i}`])));
    const none = s.tree({});
    await expect(diffTrees(s.readTree, none, many, { maxChanges: 3, maxTreeReads: 100 })).rejects.toThrow(/more than 3 files/);
    await expect(diffTrees(s.readTree, base, "missing".padEnd(40, "0"))).rejects.toThrow(/missing/);
  });
});

describe("ancestry and file reads", () => {
  const commits: Record<string, { hash: string; treeHash: string; parents: string[] }> = {
    c3: { hash: "c3", treeHash: "t3", parents: ["c2"] },
    c2: { hash: "c2", treeHash: "t2", parents: ["c1", "side"] },
    c1: { hash: "c1", treeHash: "t1", parents: [] },
    side: { hash: "side", treeHash: "ts", parents: [] },
  };
  const readCommit = async (h: string) => commits[h] ?? null;

  it("walks the first-parent chain only", async () => {
    expect(await onFirstParentChain(readCommit, "c3", "c1")).toBe(true);
    expect(await onFirstParentChain(readCommit, "c3", "c3")).toBe(true);
    expect(await onFirstParentChain(readCommit, "c3", "side")).toBe(false);
    expect(await onFirstParentChain(readCommit, "c3", "c1", 2)).toBe(false);
    expect(await onFirstParentChain(readCommit, "nope", "c1")).toBe(false);
  });

  it("reads a file with its blob id, and reports absent and binary files", async () => {
    const s = new Store();
    const root = s.tree({ src: { "a.ts": "blobA", "bin.dat": "blobB" } });
    const blobs: Record<string, Uint8Array> = { blobA: new TextEncoder().encode("export const a = 1;\n"), blobB: new Uint8Array([1, 0, 2]) };
    const io = {
      readCommit: async (h: string) => (h === "head" ? { hash: "head", treeHash: root, parents: [] } : null),
      readTree: s.readTree,
      readBlob: async (h: string) => {
        const b = blobs[h];
        return b ? { arrayBuffer: async () => b.slice().buffer } : null;
      },
    };
    expect(await readFileAt(io, "head", "src/a.ts")).toEqual({ path: "src/a.ts", blob: "blobA", mode: "100644", size: 20, content: "export const a = 1;\n" });
    expect(await readFileAt(io, "head", "src/missing.ts")).toEqual({ path: "src/missing.ts", blob: null, size: 0 });
    expect(await readFileAt(io, "head", "src/bin.dat")).toMatchObject({ blob: "blobB", binary: true });
    expect(await readFileAt(io, "head", "src/a.ts", 5)).toMatchObject({ blob: "blobA", tooLarge: true });
    expect(await entryAtPath(s.readTree, root, "src")).toBeNull();
    await expect(readFileAt(io, "other", "src/a.ts")).rejects.toThrow(/not in the repository/);
  });
});
