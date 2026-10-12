import { describe, expect, it } from "vitest";
import git, { type TreeEntry } from "isomorphic-git";
import { ensureRepo, memoryFs, resolveLocal, type GitRepo } from "../../src/artifacts/git.ts";
import { addNotes, fanoutPath, readNote } from "../../src/trunk/notes.ts";

const REF = "refs/notes/firetrident";
const commit = (n: number): string => n.toString(16).padStart(40, "c");
/** Oids spread over many fanout directories. */
const spread = (n: number): string => `${(n % 256).toString(16).padStart(2, "0")}${n.toString(16).padStart(38, "0")}`;

async function repo(): Promise<GitRepo> {
  const r: GitRepo = { fs: memoryFs(), dir: "/r", cache: {} };
  await ensureRepo(r, "https://example.invalid/git/ns/repo.git");
  return r;
}

async function rootEntries(r: GitRepo): Promise<TreeEntry[]> {
  const tip = await resolveLocal(r, REF);
  return (await git.readTree({ fs: r.fs, dir: r.dir, oid: tip! })).tree;
}

describe("addNotes: one notes commit per trunk cycle", () => {
  it("adds many notes in one commit, under 2-character fanout directories", async () => {
    const r = await repo();
    const notes = Array.from({ length: 25 }, (_, i) => ({ oid: spread(i + 1), note: `{"landingId":"lnd_${i}"}\n` }));
    const res = await addNotes(r, { ref: REF, notes, at: 1_760_000_000_000 });
    expect(res.added).toBe(25);
    const log = await git.log({ fs: r.fs, dir: r.dir, ref: REF });
    expect(log).toHaveLength(1);
    for (const n of notes) expect(await readNote(r, REF, n.oid)).toBe(n.note);
    const root = await rootEntries(r);
    expect(root.every((e) => e.type === "tree" && /^[0-9a-f]{2}$/.test(e.path))).toBe(true);
    expect(root).toHaveLength(25);
    expect(fanoutPath(spread(3))).toEqual(["03", spread(3).slice(2)]);
  });

  it("writes nothing when every note is already there, and replaces a changed note", async () => {
    const r = await repo();
    await addNotes(r, { ref: REF, notes: [{ oid: commit(1), note: "one" }, { oid: commit(2), note: "two" }], at: 1 });
    const tip = await resolveLocal(r, REF);
    expect(await addNotes(r, { ref: REF, notes: [{ oid: commit(1), note: "one" }], at: 2 })).toEqual({ tip, added: 0, objects: [], migrated: 0 });
    const cache = new Map();
    const trees = new Map<string, TreeEntry[]>();
    const next = await addNotes(r, { ref: REF, notes: [{ oid: commit(2), note: "two, rebuilt" }, { oid: commit(3), note: "three" }], at: 3, entriesByCommit: cache, trees });
    expect(next.added).toBe(2);
    // Two note blobs, the one fanout subtree they share ("cc"), the root and the commit: what a push of this flush carries.
    expect(next.objects).toHaveLength(5);
    expect(next.objects[4]).toBe(next.tip);
    // The next flush reuses the remembered root and subtree instead of reading them back.
    expect(cache.has(next.tip)).toBe(true);
    expect(trees.has(next.objects[2]!)).toBe(true);
    const again = await addNotes(r, { ref: REF, notes: [{ oid: commit(4), note: "four" }], at: 4, entriesByCommit: cache, trees });
    expect(again.added).toBe(1);
    expect(await readNote(r, REF, commit(4))).toBe("four");
    expect(await readNote(r, REF, commit(1))).toBe("one");
    expect(await readNote(r, REF, commit(2))).toBe("two, rebuilt");
    expect(await readNote(r, REF, commit(3))).toBe("three");
    expect(await readNote(r, REF, commit(9))).toBeNull();
    const log = await git.log({ fs: r.fs, dir: r.dir, ref: REF });
    expect(log.map((c) => c.commit.parent.length)).toEqual([1, 1, 0]);
  });

  it("rewrites only the subtrees a flush touches", async () => {
    const r = await repo();
    await addNotes(r, { ref: REF, notes: Array.from({ length: 512 }, (_, i) => ({ oid: spread(i), note: `n${i}` })), at: 1 });
    const res = await addNotes(r, { ref: REF, notes: [{ oid: spread(1000), note: "late" }], at: 2 });
    // One blob, the one subtree it lands in, the root, the commit.
    expect(res.objects).toHaveLength(4);
    expect(await readNote(r, REF, spread(1000))).toBe("late");
    expect(await readNote(r, REF, spread(7))).toBe("n7");
  });

  it("keeps flat notes readable and migrates them into fanout lazily, never leaving a note in two places", async () => {
    const r = await repo();
    const who = { name: "t", email: "t@example.invalid", timestamp: 1, timezoneOffset: 0 };
    for (const n of [7, 8, 9, 10]) await git.addNote({ fs: r.fs, dir: r.dir, ref: REF, oid: commit(n), note: `flat ${n}`, author: who, committer: who, force: true });
    expect((await rootEntries(r)).map((e) => e.path).sort()).toEqual([commit(7), commit(8), commit(9), commit(10)]);
    // A rewritten flat note moves; two more migrate this flush; one stays flat until the next.
    const res = await addNotes(r, { ref: REF, notes: [{ oid: commit(8), note: "eight" }, { oid: commit(11), note: "eleven" }], at: 2, migrate: 2 });
    expect(res).toMatchObject({ added: 2, migrated: 2 });
    const root = await rootEntries(r);
    expect(root.filter((e) => e.type === "blob")).toHaveLength(1);
    expect(root.filter((e) => e.type === "tree").map((e) => e.path)).toEqual(["cc"]);
    for (const [n, text] of [[7, "flat 7"], [8, "eight"], [9, "flat 9"], [10, "flat 10"], [11, "eleven"]] as const) expect(await readNote(r, REF, commit(n))).toBe(text);
    // A flush with nothing new still migrates what is left, then stops writing.
    const tail = await addNotes(r, { ref: REF, notes: [{ oid: commit(11), note: "eleven" }], at: 3 });
    expect(tail).toMatchObject({ added: 0, migrated: 1 });
    expect((await rootEntries(r)).every((e) => e.type === "tree")).toBe(true);
    expect((await addNotes(r, { ref: REF, notes: [{ oid: commit(11), note: "eleven" }], at: 4 })).objects).toEqual([]);
    for (const [n, text] of [[7, "flat 7"], [10, "flat 10"]] as const) expect(await readNote(r, REF, commit(n))).toBe(text);
  });
});

/** Node built-ins for the stock-git check (the worker compiles against workers types, so they are typed here). */
interface NodeBits {
  execFileSync(cmd: string, args: string[], opts?: { env?: Record<string, string | undefined>; encoding?: "utf8"; stdio?: "ignore" }): string;
  fs: unknown;
  mkdtempSync(prefix: string): string;
  rmSync(path: string, opts: { recursive: boolean; force: boolean }): void;
  tmpdir(): string;
  join(...parts: string[]): string;
  env: Record<string, string | undefined>;
}
const NODE: NodeBits = await (async () => {
  const [cp, fs, os, path] = (await Promise.all(["node:child_process", "node:fs", "node:os", "node:path"].map((m) => import(m)))) as [
    { execFileSync: NodeBits["execFileSync"] },
    { mkdtempSync: NodeBits["mkdtempSync"]; rmSync: NodeBits["rmSync"] },
    { tmpdir: NodeBits["tmpdir"] },
    { join: NodeBits["join"] },
  ];
  return { execFileSync: cp.execFileSync, fs, mkdtempSync: fs.mkdtempSync, rmSync: fs.rmSync, tmpdir: os.tmpdir, join: path.join, env: (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env };
})();
const { execFileSync, mkdtempSync, rmSync, tmpdir, join } = NODE;

const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasGit)("fanout notes read by stock git", () => {
  it("git notes show finds every note, flat ones written before fanout included", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ft-notes-"));
    try {
      const r: GitRepo = { fs: NODE.fs as GitRepo["fs"], dir, cache: {} };
      await ensureRepo(r, "https://example.invalid/git/ns/repo.git");
      const who = { name: "t", email: "t@example.invalid", timestamp: 1, timezoneOffset: 0 };
      await git.addNote({ fs: r.fs, dir, ref: REF, oid: spread(1), note: "flat one\n", author: who, committer: who, force: true });
      await addNotes(r, { ref: REF, notes: Array.from({ length: 300 }, (_, i) => ({ oid: spread(i + 2), note: `{"n":${i + 2}}\n` })), at: 1_760_000_000_000, migrate: 0 });
      const env = { ...NODE.env, GIT_CONFIG_NOSYSTEM: "1", HOME: dir };
      const show = (oid: string): string => execFileSync("git", ["-C", dir, "notes", "--ref", "firetrident", "show", oid], { env, encoding: "utf8" });
      expect(show(spread(1))).toBe("flat one\n");
      expect(show(spread(2))).toBe('{"n":2}\n');
      expect(show(spread(301))).toBe('{"n":301}\n');
      const list = execFileSync("git", ["-C", dir, "notes", "--ref", "firetrident", "list"], { env, encoding: "utf8" }).trim().split("\n");
      expect(list).toHaveLength(301);
      // After migration the root holds only fanout directories, and git still reads every note.
      await addNotes(r, { ref: REF, notes: [{ oid: spread(400), note: "new\n" }], at: 1_760_000_001_000 });
      const top = execFileSync("git", ["-C", dir, "ls-tree", REF], { env, encoding: "utf8" }).trim().split("\n");
      expect(top.every((l: string) => / tree [0-9a-f]{40}\t[0-9a-f]{2}$/.test(l))).toBe(true);
      expect(show(spread(1))).toBe("flat one\n");
      expect(show(spread(400))).toBe("new\n");
      expect(execFileSync("git", ["-C", dir, "notes", "--ref", "firetrident", "list"], { env, encoding: "utf8" }).trim().split("\n")).toHaveLength(302);
      execFileSync("git", ["-C", dir, "fsck", "--no-dangling"], { env, stdio: "ignore" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
