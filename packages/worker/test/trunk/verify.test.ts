import { describe, expect, it } from "vitest";
import git from "isomorphic-git";
import { serializeNote } from "@fire_trident/core";
import type { LineageNote, NoteCertification } from "@fire_trident/core";
import { buildTree, ensureRepo, memoryFs, resolveLocal, writeCommitObject, writeLocalBlob, type GitRepo } from "../../src/artifacts/git.ts";
import { sealNote, withNoteDigest } from "../../src/trunk/digest.ts";
import { addNotes } from "../../src/trunk/notes.ts";
import { bindingSource, checkLandings, layered, localSource, noteAt, summarize, verifyLimit, type LandingRow, type ObjectSource } from "../../src/trunk/verify.ts";

const REF = "refs/notes/firetrident";

async function repo(): Promise<GitRepo> {
  const r: GitRepo = { fs: memoryFs(), dir: "/r", cache: {} };
  await ensureRepo(r, "https://example.invalid/git/ns/repo.git");
  return r;
}

const noteFor = (id: string): LineageNote => ({ schema: "firetrident.lineage/v1", landingId: id, colonyId: "c", proposals: [] });

/** A landing commit as the trunk writer builds it: its note sealed into its message (or not, for one that predates the trailer). */
async function landing(r: GitRepo, id: string, opts: { sealed?: boolean } = {}): Promise<{ row: LandingRow; text: string }> {
  const { text, digest } = await sealNote(noteFor(id));
  const blob = await writeLocalBlob(r, new TextEncoder().encode(id));
  const tree = await buildTree(r, new Map([[`${id}.txt`, { blob, mode: "100644" }]]));
  const base = `Land 1 change: ${id}\n\nFT-Landing: ${id}`;
  const sha = await writeCommitObject(r, { tree, parents: [], message: opts.sealed === false ? base : withNoteDigest(base, digest), at: 1_760_000_000_000 });
  return { row: { landingId: id, trunkSha: sha, at: 1, note: text, waiting: false }, text };
}

async function push(r: GitRepo, notes: Array<{ oid: string; note: string }>, migrate = 0): Promise<string> {
  await addNotes(r, { ref: REF, notes, at: 1_760_000_000_000, migrate });
  return (await resolveLocal(r, REF))!;
}

/** A source that has nothing (as a binding that never saw these objects) and counts what it was asked. */
function emptySource(asked: string[] = []): ObjectSource {
  return {
    commit: async (oid) => (asked.push(`commit ${oid}`), null),
    tree: async (oid) => (asked.push(`tree ${oid}`), null),
    blob: async (oid) => (asked.push(`blob ${oid}`), null),
  };
}

describe("checkLandings", () => {
  it("passes notes that match their commits' trailers, and says the trunk writer's own copy matches", async () => {
    const r = await repo();
    const a = await landing(r, "lnd_a");
    const b = await landing(r, "lnd_b");
    const tip = await push(r, [a, b].map((x) => ({ oid: x.row.trunkSha, note: x.text })));
    const checks = await checkLandings([a.row, b.row], { src: localSource(r), tip });
    expect(checks.map((c) => [c.landingId, c.status, c.ownCopy])).toEqual([
      ["lnd_a", "intact", true],
      ["lnd_b", "intact", true],
    ]);
    expect(checks[0]?.trailer).toMatch(/^[0-9a-f]{64}$/);
  });

  it("finds a rewritten note and a note that is gone, and says whether the writer's copy can put it back", async () => {
    const r = await repo();
    const a = await landing(r, "lnd_a");
    const b = await landing(r, "lnd_b");
    const c = await landing(r, "lnd_c");
    await push(r, [a, b, c].map((x) => ({ oid: x.row.trunkSha, note: x.text })));
    // Someone with write access rewrites one note, then removes another.
    const forged = serializeNote({ ...noteFor("lnd_a"), colonyId: "elsewhere" });
    const tip = await push(r, [{ oid: a.row.trunkSha, note: forged }]);
    const checks = await checkLandings([a.row, { ...b.row, note: "{}" }, c.row], { src: localSource(r), tip });
    expect(checks[0]).toMatchObject({ status: "altered", ownCopy: true, detail: expect.stringMatching(/^the note hashes to/) });
    expect(checks[0]?.found).toMatch(/^[0-9a-f]{64}$/);
    // The git note is intact even when the writer's own copy is not.
    expect(checks[1]).toMatchObject({ status: "intact", ownCopy: false });
    expect(checks[2]).toMatchObject({ status: "intact" });
    const gone = await checkLandings([c.row], { src: localSource(r), tip: await removeNote(r, tip, c.row.trunkSha) });
    expect(gone[0]).toMatchObject({ status: "missing", ownCopy: true, detail: "the trunk repository has no note for this commit" });
  });

  it("tells a note whose push is due from a missing one, and a repository with no notes at all", async () => {
    const r = await repo();
    const a = await landing(r, "lnd_a");
    expect((await checkLandings([{ ...a.row, waiting: true }], { src: localSource(r), tip: null }))[0]).toMatchObject({ status: "pending" });
    expect((await checkLandings([a.row], { src: localSource(r), tip: null }))[0]).toMatchObject({ status: "missing" });
  });

  it("passes a note certified after landing", async () => {
    const r = await repo();
    const a = await landing(r, "lnd_a");
    const certified = serializeNote({ ...noteFor("lnd_a"), certification: { status: "green" } as NoteCertification });
    const tip = await push(r, [{ oid: a.row.trunkSha, note: certified }]);
    expect((await checkLandings([{ ...a.row, note: certified }], { src: localSource(r), tip }))[0]).toMatchObject({ status: "intact", ownCopy: true });
  });

  it("reports commits that predate the trailer, and commits or notes it cannot read", async () => {
    const r = await repo();
    const old = await landing(r, "lnd_old", { sealed: false });
    const a = await landing(r, "lnd_a");
    const tip = await push(r, [old, a].map((x) => ({ oid: x.row.trunkSha, note: x.text })));
    const gone = { ...a.row, trunkSha: "9".repeat(40) };
    const checks = await checkLandings([old.row, gone], { src: localSource(r), tip });
    expect(checks.map((c) => c.status)).toEqual(["no-trailer", "unreadable"]);
    expect(checks[0]).not.toHaveProperty("trailer");
    // A notes commit that cannot be read leaves every sealed note unreadable, not missing.
    expect((await checkLandings([a.row], { src: localSource(r), tip: "8".repeat(40) }))[0]).toMatchObject({ status: "unreadable", detail: expect.stringMatching(/notes commit/) });
  });

  it("reads flat notes written before fanout, and notes in fanout", async () => {
    const r = await repo();
    const a = await landing(r, "lnd_a");
    const b = await landing(r, "lnd_b");
    // A flat note, as the trunk writer wrote them before fanout: the note blob directly under the root tree.
    const blob = await git.writeBlob({ fs: r.fs, dir: r.dir, blob: new TextEncoder().encode(a.text) });
    const flatTree = await git.writeTree({ fs: r.fs, dir: r.dir, tree: [{ mode: "100644", path: a.row.trunkSha, oid: blob, type: "blob" }] });
    const flat = await git.writeCommit({ fs: r.fs, dir: r.dir, commit: { message: "notes\n", tree: flatTree, parent: [], author: { name: "t", email: "t@t", timestamp: 1, timezoneOffset: 0 }, committer: { name: "t", email: "t@t", timestamp: 1, timezoneOffset: 0 } } });
    await git.writeRef({ fs: r.fs, dir: r.dir, ref: REF, value: flat, force: true });
    const tip = await push(r, [{ oid: b.row.trunkSha, note: b.text }]);
    const root = (await git.readCommit({ fs: r.fs, dir: r.dir, oid: tip })).commit.tree;
    expect((await git.readTree({ fs: r.fs, dir: r.dir, oid: root })).tree.map((e) => e.type).sort()).toEqual(["blob", "tree"]);
    expect((await checkLandings([a.row, b.row], { src: localSource(r), tip })).map((c) => c.status)).toEqual(["intact", "intact"]);
  });

  it("reads through the binding what the local repository does not have", async () => {
    const local = await repo();
    const remote = await repo();
    const a = await landing(remote, "lnd_a");
    const tip = await push(remote, [{ oid: a.row.trunkSha, note: a.text }]);
    const asked: string[] = [];
    // The binding as the trunk repository answers it, here over another repository's objects.
    const binding = bindingSource(async () => fakeArtifactsRepo(remote, asked));
    const checks = await checkLandings([a.row], { src: layered(localSource(local), binding), tip });
    expect(checks[0]).toMatchObject({ status: "intact" });
    expect(asked.some((x) => x.startsWith("readBlob"))).toBe(true);
    // Objects the local repository has are never asked for.
    const none: string[] = [];
    await checkLandings([a.row], { src: layered(localSource(remote), emptySource(none)), tip });
    expect(none).toEqual([]);
  });
});

describe("noteAt", () => {
  it("is null for a commit with no note, and fails for a note it cannot read", async () => {
    const r = await repo();
    const a = await landing(r, "lnd_a");
    const tip = await push(r, [{ oid: a.row.trunkSha, note: a.text }]);
    const root = (await git.readCommit({ fs: r.fs, dir: r.dir, oid: tip })).commit.tree;
    expect(await noteAt(localSource(r), root, "7".repeat(40))).toBeNull();
    const noBlobs: ObjectSource = { ...localSource(r), blob: async () => null };
    await expect(noteAt(noBlobs, root, a.row.trunkSha)).rejects.toThrow(/could not be read/);
  });
});

describe("summaries and limits", () => {
  it("count each status", () => {
    const s = summarize("c", null, [{ landingId: "a", trunkSha: "x", at: 1, status: "intact" }, { landingId: "b", trunkSha: "y", at: 1, status: "intact" }, { landingId: "c", trunkSha: "z", at: 1, status: "missing" }], 7);
    expect(s).toMatchObject({ colonyId: "c", notesTip: null, counts: { intact: 2, missing: 1 }, at: 7 });
  });

  it("check 20 landings unless asked, between 1 and 200", () => {
    expect([undefined, "5", Number.NaN, 0, 1, 7.9, 500].map(verifyLimit)).toEqual([20, 20, 20, 1, 1, 7, 200]);
  });
});

/** The notes commit `tip` without the note on `oid` (the commit kept, as someone deleting one note would leave it). */
async function removeNote(r: GitRepo, tip: string, oid: string): Promise<string> {
  const fan = oid.slice(0, 2);
  const root = (await git.readTree({ fs: r.fs, dir: r.dir, oid: (await git.readCommit({ fs: r.fs, dir: r.dir, oid: tip })).commit.tree })).tree;
  const out = [];
  for (const e of root) {
    if (e.path !== fan) {
      out.push(e);
      continue;
    }
    const sub = (await git.readTree({ fs: r.fs, dir: r.dir, oid: e.oid })).tree.filter((x) => x.path !== oid.slice(2));
    if (sub.length > 0) out.push({ ...e, oid: await git.writeTree({ fs: r.fs, dir: r.dir, tree: sub }) });
  }
  const tree = await git.writeTree({ fs: r.fs, dir: r.dir, tree: out });
  const who = { name: "t", email: "t@t", timestamp: 2, timezoneOffset: 0 };
  return git.writeCommit({ fs: r.fs, dir: r.dir, commit: { message: "remove\n", tree, parent: [tip], author: who, committer: who } });
}

/** An Artifacts repository handle over a local repository's objects (readCommit, readTree, readBlob), recording the calls. */
function fakeArtifactsRepo(r: GitRepo, asked: string[]): ArtifactsRepo {
  const src = localSource(r);
  return {
    readCommit: async (hash: string) => {
      asked.push(`readCommit ${hash}`);
      const c = await src.commit(hash);
      return c ? { hash, treeHash: c.tree, message: c.message.replace(/\n$/, "") } : null;
    },
    readTree: async (hash: string) => {
      asked.push(`readTree ${hash}`);
      const t = await src.tree(hash);
      return t ? t.map((e) => ({ name: e.name, hash: e.oid, mode: e.type === "tree" ? "40000" : "100644", type: e.type })) : null;
    },
    readBlob: async (hash: string) => {
      asked.push(`readBlob ${hash}`);
      const b = await src.blob(hash);
      return b ? new Blob([b]) : null;
    },
  } as unknown as ArtifactsRepo;
}
