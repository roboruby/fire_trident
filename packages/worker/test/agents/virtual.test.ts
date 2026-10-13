import { describe, expect, it } from "vitest";
import { INLINE_LIMITS, blobId, changesetId, inlineProblem } from "@fire_trident/core";
import type { Path } from "@fire_trident/core";
import { expandFootprint, inlineChange } from "../../src/agents/change.ts";
import { TreeIndex, candidateFiles, specifierFacts } from "../../src/agents/context.ts";
import { ObjectCache, VirtualReads, footprintPrefix, trunkObjects, virtualCheckoutEnabled } from "../../src/agents/virtual.ts";
import { FakeTrunkRepo } from "./trunk-repo.ts";

/**
 * Virtual checkouts (agents/virtual.ts): trunk read object by object at a commit, from the root tree down to the
 * blobs a path needs, cached by id; a tree view that loads directories on demand and answers like a clone's
 * TreeIndex; and the inline form of a change (change.ts inlineChange).
 */

const text = (b: Uint8Array): string => new TextDecoder().decode(b);

function hono(): { repo: FakeTrunkRepo; c1: string } {
  const repo = new FakeTrunkRepo();
  const c1 = repo.commit({
    "README.md": "# app\n",
    "docs/guide.md": "guide\n",
    "src/index.ts": "export * from './lib';\n",
    "src/lib/b.ts": "export const b = 1;\n",
    "src/lib/c.ts": "export const c = 2;\n",
    "src/lib/index.ts": "export * from './b';\n",
    "test/b.test.ts": "import { b } from '../src/lib/b';\n",
  });
  return { repo, c1 };
}

describe("the fake trunk repo hashes like git", () => {
  it("gives git's ids for blobs, trees and an executable", () => {
    const repo = new FakeTrunkRepo();
    const c = repo.commit({ "hello.txt": { content: "hello\n", mode: "100755" }, "src/a.ts": "export const a = 1;\n" });
    // Reference ids from `git ls-tree` of the same files.
    expect(repo.treeAt(c, "")).toBe("63d66672fb978cc580f657b7e044ad416bb164ee");
    expect(repo.treeAt(c, "src")).toBe("a0b17eb7f8eba95c76ff14a4d2cce51b601e76f2");
    expect(blobId("hello\n")).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });
});

describe("virtual reads", () => {
  it("resolves a path through the commit, the root tree and each subtree, then reads the blob, caching every object by id", async () => {
    const { repo, c1 } = hono();
    const reads = new VirtualReads(repo, new ObjectCache());
    const f = await reads.readFile(c1, "src/lib/b.ts");
    expect(f).toMatchObject({ blob: blobId("export const b = 1;\n"), mode: "100644" });
    expect(text(f!.bytes)).toBe("export const b = 1;\n");
    expect(repo.takeCalls()).toEqual({ commit: 1, tree: 3, blob: 1, tip: 0 });
    expect(repo.treeReads).toEqual([repo.treeAt(c1, ""), repo.treeAt(c1, "src"), repo.treeAt(c1, "src/lib")]);

    // A sibling needs only its blob; the same file again needs nothing.
    await reads.readFile(c1, "src/lib/c.ts");
    await reads.readFile(c1, "src/lib/b.ts");
    expect(repo.takeCalls()).toEqual({ commit: 0, tree: 0, blob: 1, tip: 0 });
    // Three reads asked for five objects each (commit, three trees, blob): six calls, nine answered by the cache.
    expect(reads.takeNetStats()).toMatchObject({ requests: 6, hits: 9 });

    // A later commit that changed only src/index.ts shares src/lib by id: it is not read again.
    const c2 = repo.commit({
      "README.md": "# app\n",
      "docs/guide.md": "guide\n",
      "src/index.ts": "export * from './lib/index.ts';\n",
      "src/lib/b.ts": "export const b = 1;\n",
      "src/lib/c.ts": "export const c = 2;\n",
      "src/lib/index.ts": "export * from './b';\n",
      "test/b.test.ts": "import { b } from '../src/lib/b';\n",
    });
    expect(repo.treeAt(c2, "src/lib")).toBe(repo.treeAt(c1, "src/lib"));
    expect((await reads.readFile(c2, "src/lib/c.ts"))!.blob).toBe(blobId("export const c = 2;\n"));
    expect(repo.takeCalls()).toEqual({ commit: 1, tree: 2, blob: 0, tip: 0 }); // the new root and src trees only
  });

  it("answers null for a missing path, a path through a file, a directory and a submodule, reading no blob", async () => {
    const repo = new FakeTrunkRepo();
    const c = repo.commit({ "src/a.ts": "a\n", "vendor/lib": { gitlink: "9".repeat(40) }, "bin/run": { content: "#!/bin/sh\n", mode: "100755" } });
    const reads = new VirtualReads(repo, new ObjectCache());
    expect(await reads.readFile(c, "src/nope.ts")).toBeNull();
    expect(await reads.readFile(c, "nope/a.ts")).toBeNull();
    expect(await reads.readFile(c, "src/a.ts/x")).toBeNull();
    expect(await reads.readFile(c, "src")).toBeNull();
    expect(await reads.readFile(c, "vendor/lib")).toBeNull();
    expect(repo.calls.blob).toBe(0);
    expect(await reads.readFile(c, "bin/run")).toMatchObject({ mode: "100755", blob: blobId("#!/bin/sh\n") });
    expect(await reads.blobsAt(c, ["src/a.ts", "src", "vendor/lib", "gone.ts"])).toEqual(
      new Map([
        ["src/a.ts", blobId("a\n")],
        ["src", null],
        ["vendor/lib", null],
        ["gone.ts", null],
      ]),
    );
  });

  it("asks once for an object many reads want at the same time", async () => {
    const { repo, c1 } = hono();
    repo.latencyMs = 5;
    const reads = new VirtualReads(repo, new ObjectCache());
    const [a, b] = await Promise.all([reads.readFile(c1, "src/lib/b.ts"), reads.readFile(c1, "src/lib/b.ts")]);
    expect(a!.blob).toBe(b!.blob);
    expect(repo.takeCalls()).toEqual({ commit: 1, tree: 3, blob: 1, tip: 0 });
  });

  it("uses the base commit when trunk has it, and trunk's tip otherwise, as a clone does", async () => {
    const { repo, c1 } = hono();
    const reads = new VirtualReads(repo, new ObjectCache());
    expect(await reads.ensureBase({ baseSha: c1 })).toEqual({ baseSha: c1, fallback: false });
    expect(await reads.ensureBase({ baseSha: "e".repeat(40) })).toEqual({ baseSha: c1, fallback: true });
    expect(await reads.fetchTip()).toBe(c1);
    await expect(reads.tree("e".repeat(40))).rejects.toThrow(/is not in the trunk repository/);
    await expect(new VirtualReads(new FakeTrunkRepo(), new ObjectCache()).ensureBase({ baseSha: c1 })).rejects.toThrow(/no main branch/);
  });

  it("keeps at most its byte budget, dropping the least recently used, and never keeps a large blob", async () => {
    const cache = new ObjectCache(100);
    const read = (v: string) => async () => v;
    await cache.get("a", read("a"), () => 40);
    await cache.get("b", read("b"), () => 40);
    await cache.get("a", read("x"), () => 40); // a is used again: b is now the oldest
    await cache.get("c", read("c"), () => 40);
    expect(cache.size()).toEqual({ objects: 2, bytes: 80 });
    expect(await cache.get("b", read("b2"), () => 40)).toBe("b2"); // b was dropped
    expect(await cache.get("a", read("a2"), () => 40)).toBe("a2"); // and then a
    await cache.get("big", read("big"), () => 30, 20);
    expect(await cache.get("big", read("big2"), () => 30, 20)).toBe("big2");
    expect(await cache.get("none", async () => null, () => 1)).toBeNull();
    expect(await cache.get("none", read("now"), () => 1)).toBe("now"); // absence is never kept
  });
});

describe("the tree view of a virtual checkout", () => {
  it("answers only for loaded directories, and settle loads what a question touched, nothing else", async () => {
    const { repo, c1 } = hono();
    const reads = new VirtualReads(repo, new ObjectCache());
    const tree = await reads.tree(c1);
    repo.takeCalls();
    const answer = await tree.settle(() => [tree.isFile("src/lib/b.ts"), tree.isDir("src/lib"), tree.list("src/lib"), tree.isFile("src/nope.ts"), tree.isDir("nope")]);
    expect(answer).toEqual([true, true, ["b.ts", "c.ts", "index.ts"], false, false]);
    expect(repo.takeCalls().tree).toBe(3); // root, src, src/lib: never docs or test
    expect(new Set(repo.treeReads)).not.toContain(repo.treeAt(c1, "docs"));
    // Asked again, the loaded directories answer at once.
    expect(await tree.settle(() => tree.list(""))).toEqual(["README.md", "docs/", "src/", "test/"]);
    expect(repo.takeCalls().tree).toBe(0);
  });

  it("gives the same answers as a clone's index for every question context.ts asks", async () => {
    const { repo, c1 } = hono();
    const reads = new VirtualReads(repo, new ObjectCache());
    const clone = new TreeIndex(await reads.listFiles(c1));
    const tree = await reads.tree(c1);
    const asked: Path[] = ["", "src", "src/lib", "src/lib/b", "src/lib/b.ts", "src/index.ts", "src/lib/index", "docs", "docs/guide.md", "test", "nope", "src/nope/x.ts", "README.md/x"];
    for (const p of asked) {
      expect(await tree.settle(() => tree.isFile(p))).toBe(clone.isFile(p));
      expect(await tree.settle(() => tree.isDir(p))).toBe(clone.isDir(p));
      expect(await tree.settle(() => tree.list(p))).toEqual(clone.list(p));
      expect(await tree.settle(() => candidateFiles(p, tree))).toEqual(candidateFiles(p, clone));
    }
    const rule = { id: "r", colonyId: "c", kind: "forbid-import" as const, spec: { module: "^\\.\\.?/(?!.*\\.ts$)" }, description: "d", approvedBy: "t", createdAt: 0 };
    const src = "import { b } from './lib';\nimport { c } from './lib/c';\nimport x from '../docs';\n";
    expect(await tree.settle(() => specifierFacts(rule, "src/index.ts", src, tree))).toEqual(specifierFacts(rule, "src/index.ts", src, clone));
  });

  it("lists the first files in path order, reading only the directories they are in", async () => {
    const repo = new FakeTrunkRepo();
    const files: Record<Path, string> = { "a.ts": "1", "a-b/x.ts": "2", "a/x.ts": "3", "b.ts": "4" };
    for (let i = 0; i < 30; i++) files[`z/d${String(i).padStart(2, "0")}/f.ts`] = String(i);
    const c = repo.commit(files);
    const reads = new VirtualReads(repo, new ObjectCache());
    const sorted = Object.keys(files).sort();
    expect(sorted.slice(0, 3)).toEqual(["a-b/x.ts", "a.ts", "a/x.ts"]);

    const tree = await reads.tree(c);
    repo.takeCalls();
    repo.treeReads = [];
    expect(await tree.paths(4)).toEqual({ paths: sorted.slice(0, 4), complete: false });
    // The root, a-b and a, plus z read ahead with its first subdirectory: never the other 29 of z's subdirectories.
    await new Promise((r) => setTimeout(r, 0));
    expect(repo.takeCalls().tree).toBe(5);
    const zSubdirs = Array.from({ length: 30 }, (_, i) => repo.treeAt(c, `z/d${String(i).padStart(2, "0")}`));
    expect(repo.treeReads.filter((id) => zSubdirs.includes(id))).toEqual([zSubdirs[0]]);
    expect(await (await reads.tree(c)).paths(1000)).toEqual({ paths: sorted, complete: true });
    expect(await (await reads.tree(c)).paths(sorted.length)).toEqual({ paths: sorted, complete: true });
  });

  it("lists only where a footprint's globs and directories can match, with what a full listing would give", async () => {
    const { repo, c1 } = hono();
    const reads = new VirtualReads(repo, new ObjectCache());
    const all = await reads.listFiles(c1);
    expect(all).toEqual([...all].sort());
    for (const footprint of [["src/lib/"], ["src/**/*.ts"], ["./src/lib/*.ts", "README.md"], ["**/*.md"], ["{src,test}/**"]]) {
      repo.takeCalls();
      repo.treeReads = [];
      const scoped = await reads.listFiles(c1, footprint);
      expect(expandFootprint(footprint, scoped, 80)).toEqual(expandFootprint(footprint, all, 80));
      if (footprint[0] === "src/lib/") {
        expect(scoped).toEqual(["src/lib/b.ts", "src/lib/c.ts", "src/lib/index.ts"]);
        expect(repo.treeReads).not.toContain(repo.treeAt(c1, "docs"));
        expect(repo.treeReads).not.toContain(repo.treeAt(c1, "test"));
      }
    }
  });

  it("finds the directory a footprint entry can match under", () => {
    expect(footprintPrefix("src/middleware/")).toBe("src/middleware");
    expect(footprintPrefix("src/**/*.ts")).toBe("src");
    expect(footprintPrefix("./src/lib/*.ts")).toBe("src/lib");
    expect(footprintPrefix("/src/")).toBe("src");
    expect(footprintPrefix("**/*.ts")).toBe("");
    expect(footprintPrefix("{src,lib}/x/*")).toBe("");
    expect(footprintPrefix("src/a?/b/*")).toBe("src");
    expect(footprintPrefix("src//x/*")).toBe("");
    expect(footprintPrefix("*.md")).toBe("");
  });
});

describe("inline changes", () => {
  const BASE = "b".repeat(40);

  it("builds the payload of the contract: blob ids, the changeset id and the contents by blob id", () => {
    const changes = [
      { path: "src/a.ts", content: "export const a = 2;\n" },
      { path: "src/b.ts", content: "export const b = 'é';\n" },
    ];
    const r = inlineChange(BASE, changes);
    if (!r.ok) throw new Error(r.reason);
    expect(r.writeSet).toEqual(changes.map((c) => ({ path: c.path, blob: blobId(c.content) })));
    expect(r.headSha).toBe(changesetId(BASE, r.writeSet));
    expect(r.contents).toEqual(Object.fromEntries(changes.map((c) => [blobId(c.content), c.content])));
    expect(inlineProblem(r.writeSet, r.contents)).toBeNull();
  });

  it("refuses binary content and changes over the inline limits, saying why", () => {
    expect(inlineChange(BASE, [{ path: "a.bin", content: "x\0y" }])).toEqual({ ok: false, reason: expect.stringContaining("a.bin is not text") });
    const many = Array.from({ length: INLINE_LIMITS.files + 1 }, (_, i) => ({ path: `f${i}.ts`, content: `export const v = ${i};\n` }));
    expect(inlineChange(BASE, many)).toMatchObject({ ok: false, reason: expect.stringContaining(`at most ${INLINE_LIMITS.files} files`) });
    const big = "x".repeat(INLINE_LIMITS.fileBytes + 1);
    expect(inlineChange(BASE, [{ path: "big.ts", content: big }])).toMatchObject({ ok: false, reason: expect.stringContaining("big.ts is") });
    const third = "y".repeat(Math.floor(INLINE_LIMITS.totalBytes / 3) + 10);
    const parts = [0, 1, 2].map((i) => ({ path: `p${i}.ts`, content: `${i}${third}` }));
    expect(inlineChange(BASE, parts)).toMatchObject({ ok: false, reason: expect.stringContaining(`${INLINE_LIMITS.totalBytes}-byte limit`) });
  });
});

describe("the flag and the binding", () => {
  it("reads FT_VIRTUAL_CHECKOUT like the other colony flags", () => {
    expect(virtualCheckoutEnabled(undefined, "hono")).toBe(false);
    expect(virtualCheckoutEnabled("", "hono")).toBe(false);
    expect(virtualCheckoutEnabled("off", "hono")).toBe(false);
    expect(virtualCheckoutEnabled("on", "hono")).toBe(true);
    expect(virtualCheckoutEnabled("shortlinks, hono", "hono")).toBe(true);
    expect(virtualCheckoutEnabled("shortlinks", "hono")).toBe(false);
  });

  it("reads trunk objects through one repo handle, and releases it once", async () => {
    const { repo, c1 } = hono();
    let opened = 0;
    let disposed = 0;
    const handle = {
      readCommit: async (id: string) => {
        const c = await repo.readCommit(id);
        return c ? { hash: id, treeHash: c.treeHash, parents: [] } : null;
      },
      readTree: (id: string) => repo.readTree(id),
      readBlob: async (id: string) => {
        const b = await repo.readBlob(id);
        return b ? new Blob([b]) : null;
      },
      log: async (o: { ref?: string; limit?: number }) => (o.ref === "main" && repo.main ? [{ hash: repo.main }] : []),
      [(Symbol as unknown as { dispose: symbol }).dispose]: () => disposed++,
    };
    const binding = { get: async (name: string) => (opened++, expect(name).toBe("col--trunk"), handle as unknown as ArtifactsRepo) };
    const objects = trunkObjects(binding as unknown as Artifacts, "col--trunk");
    const reads = new VirtualReads(objects, new ObjectCache());
    expect(await reads.fetchTip()).toBe(c1);
    expect(text((await reads.readFile(c1, "src/lib/b.ts"))!.bytes)).toBe("export const b = 1;\n");
    expect(opened).toBe(1);
    objects.release();
    objects.release();
    await new Promise((r) => setTimeout(r, 0));
    expect(disposed).toBe(1);
  });
});
