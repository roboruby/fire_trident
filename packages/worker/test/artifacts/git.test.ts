import { describe, expect, it } from "vitest";
import {
  applyTreeChanges,
  authenticatedRemote,
  blobAt,
  blobSha,
  buildTree,
  diffTrees,
  ensureRepo,
  isSha,
  listTreeFiles,
  memoryFs,
  readLocalBlob,
  tokenExpiresAt,
  tokenSecret,
  writeLocalBlob,
  type GitRepo,
  type PathChange,
} from "../../src/artifacts/git.ts";

const enc = new TextEncoder();

async function repo(): Promise<GitRepo> {
  const r: GitRepo = { fs: memoryFs(), dir: "/r", cache: {} };
  await ensureRepo(r, "https://example.invalid/git/ns/repo.git");
  return r;
}

async function tree(r: GitRepo, files: Record<string, string>): Promise<{ oid: string; blobs: Record<string, string> }> {
  const blobs: Record<string, string> = {};
  const map = new Map<string, { blob: string; mode: string }>();
  for (const [path, text] of Object.entries(files)) {
    blobs[path] = await writeLocalBlob(r, enc.encode(text));
    map.set(path, { blob: blobs[path]!, mode: "100644" });
  }
  return { oid: await buildTree(r, map), blobs };
}

describe("tokens", () => {
  it("strips the expiry suffix and reads the expiry for v1 and v2 tokens", () => {
    for (const t of ["art_v1_0123abcd?expires=1760000000", "art_v2_x_89abcdef?expires=1760000000"]) {
      expect(tokenSecret(t)).toBe(t.split("?")[0]);
      expect(tokenExpiresAt(t, 0)).toBe(1_760_000_000_000);
    }
    expect(tokenExpiresAt("art_v2_x_00", 42)).toBe(42);
    expect(tokenSecret("art_v2_x_00")).toBe("art_v2_x_00");
  });

  it("embeds only the secret in a Basic-auth remote", () => {
    const url = authenticatedRemote("https://acct.artifacts.cloudflare.net/git/ns/r.git", "art_v2_x_ab12?expires=1");
    expect(url).toBe("https://x:art_v2_x_ab12@acct.artifacts.cloudflare.net/git/ns/r.git");
  });
});

describe("tree surgery", () => {
  it("hashes blobs like git", async () => {
    expect(await blobSha(enc.encode("hello\n"))).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
    expect(isSha("ce013625030ba8dba906f756967f9e9ca394464a")).toBe(true);
    expect(isSha("CE013625030BA8DBA906F756967F9E9CA394464A")).toBe(false);
  });

  it("replaces, adds and deletes nested paths, pruning empty directories, canonically", async () => {
    const r = await repo();
    const base = await tree(r, { "a.txt": "a\n", "dir/b.txt": "b\n", "dir/sub/c.txt": "c\n", "other/d.txt": "d\n" });
    const b2 = await writeLocalBlob(r, enc.encode("b2\n"));
    const e = await writeLocalBlob(r, enc.encode("e\n"));
    const changes = new Map<string, PathChange>([
      ["dir/b.txt", { blob: b2, mode: "100644" }],
      ["dir/sub/c.txt", null],
      ["new/deep/e.txt", { blob: e, mode: "100644" }],
      ["other/d.txt", null],
    ]);
    const next = await applyTreeChanges(r, base.oid, changes);
    const expected = await tree(r, { "a.txt": "a\n", "dir/b.txt": "b2\n", "new/deep/e.txt": "e\n" });
    expect(next).toBe(expected.oid);
    expect((await listTreeFiles(r, next)).map((f) => f.path)).toEqual(["a.txt", "dir/b.txt", "new/deep/e.txt"]);
    expect(await blobAt(r, next, "dir/b.txt")).toEqual({ blob: b2, mode: "100644" });
    expect(await blobAt(r, next, "dir")).toBeNull();
    expect(await blobAt(r, next, "dir/sub/c.txt")).toBeNull();
    expect(new TextDecoder().decode(await readLocalBlob(r, e))).toBe("e\n");
  });

  it("sorts a directory after a same-prefix file the way git does", async () => {
    const r = await repo();
    const a = await tree(r, { "foo.txt": "1", "foo/x": "2", "foo-bar": "3" });
    const b = await applyTreeChanges(r, (await tree(r, { "foo.txt": "1" })).oid, new Map<string, PathChange>([
      ["foo/x", { blob: a.blobs["foo/x"]!, mode: "100644" }],
      ["foo-bar", { blob: a.blobs["foo-bar"]!, mode: "100644" }],
    ]));
    expect(b).toBe(a.oid);
  });

  it("diffs only what changed", async () => {
    const r = await repo();
    const x = await tree(r, { "a.txt": "a", "dir/b.txt": "b", "dir/c.txt": "c", "gone/z.txt": "z" });
    const y = await tree(r, { "a.txt": "a", "dir/b.txt": "B", "dir/c.txt": "c", "fresh/n.txt": "n" });
    const d = await diffTrees(r, x.oid, y.oid);
    const byPath = Object.fromEntries(d.map((t) => [t.path, t]));
    expect(Object.keys(byPath).sort()).toEqual(["dir/b.txt", "fresh/n.txt", "gone/z.txt"]);
    expect(byPath["dir/b.txt"]!.before?.blob).toBe(x.blobs["dir/b.txt"]);
    expect(byPath["dir/b.txt"]!.after?.blob).toBe(y.blobs["dir/b.txt"]);
    expect(byPath["gone/z.txt"]!.after).toBeNull();
    expect(byPath["fresh/n.txt"]!.before).toBeNull();
    expect(await diffTrees(r, x.oid, x.oid)).toEqual([]);
  });

  it("turns a file into a directory and back", async () => {
    const r = await repo();
    const x = await tree(r, { "p": "file" });
    const y = await tree(r, { "p/q": "nested" });
    const d = await diffTrees(r, x.oid, y.oid);
    expect(d.map((t) => [t.path, t.before !== null, t.after !== null])).toEqual(expect.arrayContaining([["p", true, false], ["p/q", false, true]]));
  });
});
