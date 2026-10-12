import { describe, expect, it } from "vitest";
import git, { type TreeEntry } from "isomorphic-git";
import { applyTreeChanges, buildTree, ensureRepo, memoryFs, readTreeEntries, writeCommitObject, writeLocalBlob, LANDING_IDENTITY, type GitRepo, type PathChange } from "../../src/artifacts/git.ts";
import { commitContent, objectId, sha1Hex, treeContent } from "../../src/trunk/objects.ts";
import { applyTreeChangesDeferred, writePending, type PendingObject } from "../../src/trunk/surgery.ts";

const enc = new TextEncoder();

async function repo(): Promise<GitRepo> {
  const r: GitRepo = { fs: memoryFs(), dir: "/r", cache: {} };
  await ensureRepo(r, "https://example.invalid/git/ns/repo.git");
  return r;
}

describe("git objects in memory", () => {
  it("computes SHA-1 and blob ids like git", () => {
    expect(sha1Hex(new Uint8Array())).toBe("da39a3ee5e6b4b0d3255bfef95601890afd80709");
    expect(sha1Hex(enc.encode("abc"))).toBe("a9993e364706816aba3e25717850c26c9cd0d89d");
    expect(sha1Hex(enc.encode("a".repeat(1000)))).toBe("291e9a6c66994949b57ba5e650361e98fc36b1ba");
    expect(objectId("blob", enc.encode("hello\n"))).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });

  it("encodes trees exactly as isomorphic-git writes them, including git's directory ordering", async () => {
    const r = await repo();
    const b = await writeLocalBlob(r, enc.encode("x"));
    const sub = await git.writeTree({ fs: r.fs, dir: r.dir, tree: [{ mode: "100644", path: "f", oid: b, type: "blob" }] });
    // "a" (dir) sorts as "a/", after "a.b" and "a-b"; executable, symlink and unicode names too.
    const entries: TreeEntry[] = [
      { mode: "040000", path: "a", oid: sub, type: "tree" },
      { mode: "100644", path: "a.b", oid: b, type: "blob" },
      { mode: "100755", path: "a-b", oid: b, type: "blob" },
      { mode: "120000", path: "link", oid: b, type: "blob" },
      { mode: "100644", path: "ünïcode.md", oid: b, type: "blob" },
      { mode: "040000", path: "a0", oid: sub, type: "tree" },
      { mode: "100644", path: "Z", oid: b, type: "blob" },
    ];
    const written = await git.writeTree({ fs: r.fs, dir: r.dir, tree: entries });
    expect(objectId("tree", treeContent(entries))).toBe(written);
    expect(objectId("tree", treeContent([]))).toBe("4b825dc642cb6eb9a060e54bf8d69288fbee4904");
  });

  it("encodes commits exactly as writeCommitObject writes them", async () => {
    const r = await repo();
    const tree = await git.writeTree({ fs: r.fs, dir: r.dir, tree: [] });
    for (const [parents, message] of [[[], "Land 1 change: first\n\nFT-Landing: lnd_1"], [["c".repeat(40)], "\nmulti\r\nline\n\n\n"]] as const) {
      const at = 1_760_000_123_456;
      const written = await writeCommitObject(r, { tree, parents: [...parents], message, at });
      const content = commitContent({ tree, parents: [...parents], message, name: LANDING_IDENTITY.name, email: LANDING_IDENTITY.email, timestamp: Math.floor(at / 1000) });
      expect(objectId("commit", content)).toBe(written);
    }
  });

  it("builds a deferred chain with the same ids as written surgery, then writes it", async () => {
    const r = await repo();
    const blob = (s: string) => writeLocalBlob(r, enc.encode(s));
    const files = new Map<string, { blob: string; mode: string }>();
    for (let d = 0; d < 5; d++) for (let f = 0; f < 3; f++) files.set(`bench/r${d}/f${f}.txt`, { blob: await blob(`${d}${f}`), mode: "100644" });
    const root = await buildTree(r, files);
    const steps: Array<Map<string, PathChange>> = [
      new Map([["bench/r1/new.txt", { blob: await blob("n"), mode: "100644" }]]),
      new Map<string, PathChange>([["bench/r2/f0.txt", null], ["bench/r1/new.txt", { blob: await blob("m"), mode: "100755" }]]),
      new Map<string, PathChange>([["bench/r3/f0.txt", null], ["bench/r3/f1.txt", null], ["bench/r3/f2.txt", null]]),
      new Map([["top/new/deep.txt", { blob: await blob("d"), mode: "100644" }]]),
    ];
    const pending = new Map<string, PendingObject & { entries?: TreeEntry[] }>();
    const trees = new Map<string, TreeEntry[]>();
    let plain = root;
    let deferred = root;
    for (const changes of steps) {
      plain = await applyTreeChanges(r, plain, changes);
      deferred = await applyTreeChangesDeferred(r, trees, deferred, changes, pending);
      expect(deferred).toBe(plain);
    }
    // Writing the pending objects lands each under the id computed for it (writePending checks), readable back.
    await writePending(r, pending, 4);
    expect((await readTreeEntries(r, deferred)).map((e) => e.path).sort()).toEqual(["bench", "top"]);
  });
});
