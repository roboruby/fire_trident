import { describe, expect, it } from "vitest";
import git from "isomorphic-git";
import { ensureRepo, memoryFs, readNoteText, resolveLocal, type GitRepo } from "../../src/artifacts/git.ts";
import { addNotes } from "../../src/trunk/notes.ts";

const REF = "refs/notes/firetrident";
const commit = (n: number): string => n.toString(16).padStart(40, "c");

async function repo(): Promise<GitRepo> {
  const r: GitRepo = { fs: memoryFs(), dir: "/r", cache: {} };
  await ensureRepo(r, "https://example.invalid/git/ns/repo.git");
  return r;
}

describe("addNotes: one notes commit per trunk cycle", () => {
  it("adds many notes in one commit, readable like addNote's", async () => {
    const r = await repo();
    const notes = Array.from({ length: 25 }, (_, i) => ({ oid: commit(i + 1), note: `{"landingId":"lnd_${i}"}\n` }));
    const res = await addNotes(r, { ref: REF, notes, at: 1_760_000_000_000 });
    expect(res.added).toBe(25);
    const log = await git.log({ fs: r.fs, dir: r.dir, ref: REF });
    expect(log).toHaveLength(1);
    for (const n of notes) expect(await readNoteText(r, REF, n.oid)).toBe(n.note);
  });

  it("writes nothing when every note is already there, and replaces a changed note", async () => {
    const r = await repo();
    await addNotes(r, { ref: REF, notes: [{ oid: commit(1), note: "one" }, { oid: commit(2), note: "two" }], at: 1 });
    const tip = await resolveLocal(r, REF);
    expect(await addNotes(r, { ref: REF, notes: [{ oid: commit(1), note: "one" }], at: 2 })).toEqual({ tip, added: 0, objects: [] });
    const cache = new Map();
    const next = await addNotes(r, { ref: REF, notes: [{ oid: commit(2), note: "two, rebuilt" }, { oid: commit(3), note: "three" }], at: 3, entriesByCommit: cache });
    expect(next.added).toBe(2);
    // Two note blobs, the notes tree and the notes commit: exactly what a push of this flush carries.
    expect(next.objects).toHaveLength(4);
    expect(next.objects[3]).toBe(next.tip);
    // The next flush reuses the remembered notes tree instead of reading it back.
    expect(cache.has(next.tip)).toBe(true);
    const again = await addNotes(r, { ref: REF, notes: [{ oid: commit(4), note: "four" }], at: 4, entriesByCommit: cache });
    expect(again.added).toBe(1);
    expect(await readNoteText(r, REF, commit(4))).toBe("four");
    expect(await readNoteText(r, REF, commit(1))).toBe("one");
    expect(await readNoteText(r, REF, commit(2))).toBe("two, rebuilt");
    expect(await readNoteText(r, REF, commit(3))).toBe("three");
    const log = await git.log({ fs: r.fs, dir: r.dir, ref: REF });
    expect(log.map((c) => c.commit.parent.length)).toEqual([1, 1, 0]);
  });

  it("builds on notes written one at a time by addNote", async () => {
    const r = await repo();
    const who = { name: "t", email: "t@example.invalid", timestamp: 1, timezoneOffset: 0 };
    await git.addNote({ fs: r.fs, dir: r.dir, ref: REF, oid: commit(7), note: "seven", author: who, committer: who });
    await addNotes(r, { ref: REF, notes: [{ oid: commit(8), note: "eight" }], at: 2 });
    expect(await readNoteText(r, REF, commit(7))).toBe("seven");
    expect(await readNoteText(r, REF, commit(8))).toBe("eight");
  });
});
