import git, { type TreeEntry } from "isomorphic-git";
import { LANDING_IDENTITY, type GitRepo } from "../artifacts/git.ts";

/** One lineage note: the annotated commit and the note text. */
export interface NoteInput {
  oid: string;
  note: string;
}

/**
 * Flat notes (written before fanout) moved into their fanout subtree per flush: the notes tree is
 * migrated a slice at a time, so no single flush pays for rewriting the whole history at once.
 */
export const MIGRATE_PER_FLUSH = 1_000;

const TREE_MODE = "040000";
const FULL_OID = /^[0-9a-f]{40}$/;
const FAN = /^[0-9a-f]{2}$/;

/** The 2-character fanout directory of an annotated object and the entry name inside it ("ab", "cdef..."). */
export function fanoutPath(oid: string): [string, string] {
  return [oid.slice(0, 2), oid.slice(2)];
}

/** Entries of tree `oid`, from `trees` when cached (trees are immutable by id). */
async function treeEntries(repo: GitRepo, oid: string, trees?: Map<string, TreeEntry[]>): Promise<TreeEntry[]> {
  const hit = trees?.get(oid);
  if (hit) return hit;
  const { tree } = await git.readTree({ fs: repo.fs, dir: repo.dir, oid, cache: repo.cache });
  trees?.set(oid, tree);
  return tree;
}

/**
 * Add or replace many notes under `ref` in ONE notes commit, in git's 2-character fanout layout:
 * the note of commit `abcd...` is `ab/cd...` (a subtree per first byte, as git itself writes notes
 * once there are many). A flush rewrites the root (at most 256 subtree entries plus any flat notes
 * not migrated yet) and only the subtrees it touches, where the flat layout rewrote one tree entry
 * per note ever written on every flush (5,062 entries in the last group-commit bench).
 *
 * Notes written flat before fanout stay readable (git reads both layouts in one tree) and migrate
 * lazily: a note that is rewritten moves to its subtree, and each flush moves up to `migrate`
 * more (default MIGRATE_PER_FLUSH). A note is only ever in one place, since git would join two
 * notes for the same object into one. Notes already present with the same text are skipped; with
 * nothing to change no commit is written. Returns the notes tip, how many notes changed, how many
 * flat notes moved, and the objects written (note blobs, the rewritten trees, the commit): what a
 * push of this notes commit carries. `entriesByCommit` remembers the root tree of each notes commit
 * it sees or writes and `trees` the subtrees (both optional caches), so the next call reads nothing back.
 */
export async function addNotes(
  repo: GitRepo,
  p: { ref: string; notes: NoteInput[]; at: number; entriesByCommit?: Map<string, TreeEntry[]>; trees?: Map<string, TreeEntry[]>; migrate?: number },
): Promise<{ tip: string | null; added: number; objects: string[]; migrated: number }> {
  const { fs, dir, cache } = repo;
  let parent: string | null;
  try {
    parent = await git.resolveRef({ fs, dir, ref: p.ref });
  } catch {
    parent = null;
  }
  const root = new Map<string, TreeEntry>();
  if (parent !== null) {
    let tree = p.entriesByCommit?.get(parent);
    if (!tree) {
      tree = (await git.readTree({ fs, dir, oid: parent, cache })).tree;
      p.entriesByCommit?.set(parent, tree);
    }
    for (const e of tree) root.set(e.path, e);
  }

  // Subtrees by fanout directory, loaded on first use; the ones that change are rewritten.
  const subs = new Map<string, Map<string, TreeEntry>>();
  const dirty = new Set<string>();
  const sub = async (fan: string): Promise<Map<string, TreeEntry>> => {
    let s = subs.get(fan);
    if (s) return s;
    s = new Map();
    const e = root.get(fan);
    if (e && e.type === "tree") for (const x of await treeEntries(repo, e.oid, p.trees)) s.set(x.path, x);
    subs.set(fan, s);
    return s;
  };

  const enc = new TextEncoder();
  let added = 0;
  const objects: string[] = [];
  for (const n of p.notes) {
    const bytes = enc.encode(n.note);
    const { oid } = await git.hashBlob({ object: bytes });
    const [fan, rest] = fanoutPath(n.oid);
    const flat = root.get(n.oid);
    const s = await sub(fan);
    const inFan = s.get(rest);
    if ((inFan?.oid === oid && !flat) || (flat?.oid === oid && !inFan)) continue;
    await git.writeBlob({ fs, dir, blob: bytes });
    objects.push(oid);
    s.set(rest, { mode: "100644", path: rest, oid, type: "blob" });
    dirty.add(fan);
    root.delete(n.oid);
    added++;
  }

  // Lazy migration: move a slice of the flat notes into their subtrees.
  let migrated = 0;
  const budget = Math.max(0, Math.floor(p.migrate ?? MIGRATE_PER_FLUSH));
  if (budget > 0) {
    for (const [name, e] of [...root]) {
      if (migrated >= budget) break;
      if (e.type !== "blob" || !FULL_OID.test(name)) continue;
      const [fan, rest] = fanoutPath(name);
      const s = await sub(fan);
      // The fanout copy wins if both exist (git would join them into one note).
      if (!s.has(rest)) s.set(rest, { mode: e.mode, path: rest, oid: e.oid, type: "blob" });
      root.delete(name);
      dirty.add(fan);
      migrated++;
    }
  }
  if (added === 0 && migrated === 0) return { tip: parent, added, objects, migrated };

  for (const fan of dirty) {
    const list = [...(subs.get(fan) ?? new Map<string, TreeEntry>()).values()];
    if (list.length === 0) {
      root.delete(fan);
      continue;
    }
    const oid = await git.writeTree({ fs, dir, tree: list });
    p.trees?.set(oid, list);
    root.set(fan, { mode: TREE_MODE, path: fan, oid, type: "tree" });
    objects.push(oid);
  }
  const list = [...root.values()];
  const tree = await git.writeTree({ fs, dir, tree: list });
  const who = { ...LANDING_IDENTITY, timestamp: Math.floor(p.at / 1000), timezoneOffset: 0 };
  const message = added > 0 ? `Lineage notes for ${added} landing${added === 1 ? "" : "s"}\n` : `Lineage notes: ${migrated} moved to fanout subtrees\n`;
  const commit = await git.writeCommit({
    fs,
    dir,
    commit: { message, tree, parent: parent === null ? [] : [parent], author: who, committer: who },
  });
  await git.writeRef({ fs, dir, ref: p.ref, value: commit, force: true });
  objects.push(tree, commit);
  p.entriesByCommit?.set(commit, list);
  return { tip: commit, added, objects, migrated };
}

/**
 * The note on `oid` under `ref`, in either layout: flat (`<oid>`), 2-character fanout
 * (`ab/<rest>`), or deeper fanout as git writes for very large notes trees (`ab/cd/<rest>`).
 * Null when there is none.
 */
export async function readNote(repo: GitRepo, ref: string, oid: string, trees?: Map<string, TreeEntry[]>): Promise<string | null> {
  let tip: string;
  try {
    tip = await git.resolveRef({ fs: repo.fs, dir: repo.dir, ref });
  } catch {
    return null;
  }
  const { tree: root } = await git.readTree({ fs: repo.fs, dir: repo.dir, oid: tip, cache: repo.cache });
  let entries = root;
  let rest = oid;
  for (;;) {
    const hit = entries.find((e) => e.path === rest && e.type === "blob");
    if (hit) {
      const { blob } = await git.readBlob({ fs: repo.fs, dir: repo.dir, oid: hit.oid, cache: repo.cache });
      return new TextDecoder().decode(blob);
    }
    const fan = rest.slice(0, 2);
    const next = rest.length > 2 && FAN.test(fan) ? entries.find((e) => e.path === fan && e.type === "tree") : undefined;
    if (!next) return null;
    entries = await treeEntries(repo, next.oid, trees);
    rest = rest.slice(2);
  }
}
