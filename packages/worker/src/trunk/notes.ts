import git, { type TreeEntry } from "isomorphic-git";
import { LANDING_IDENTITY, type GitRepo } from "../artifacts/git.ts";

/** One lineage note: the annotated commit and the note text. */
export interface NoteInput {
  oid: string;
  note: string;
}

/**
 * Add or replace many notes under `ref` in ONE notes commit, in git's flat notes layout (one tree
 * entry per annotated commit, as isomorphic-git's addNote writes and stock git reads). The notes
 * tree is read and written once however many notes there are, so a trunk cycle that lands many
 * batches pays for one notes commit. Notes already present with the same text are skipped; with
 * nothing to change no commit is written. Returns the notes tip, how many notes changed, and the
 * objects written (note blobs, the tree, the commit): what a push of this notes commit carries.
 * `entriesByCommit` (optional) remembers the notes tree of each notes commit it sees or writes,
 * so the next call does not read the growing notes tree back from the store.
 */
export async function addNotes(
  repo: GitRepo,
  p: { ref: string; notes: NoteInput[]; at: number; entriesByCommit?: Map<string, TreeEntry[]> },
): Promise<{ tip: string | null; added: number; objects: string[] }> {
  const { fs, dir, cache } = repo;
  let parent: string | null;
  try {
    parent = await git.resolveRef({ fs, dir, ref: p.ref });
  } catch {
    parent = null;
  }
  const entries = new Map<string, TreeEntry>();
  if (parent !== null) {
    let tree = p.entriesByCommit?.get(parent);
    if (!tree) {
      tree = (await git.readTree({ fs, dir, oid: parent, cache })).tree;
      p.entriesByCommit?.set(parent, tree);
    }
    for (const e of tree) entries.set(e.path, e);
  }
  const enc = new TextEncoder();
  let added = 0;
  const objects: string[] = [];
  for (const n of p.notes) {
    const bytes = enc.encode(n.note);
    const { oid } = await git.hashBlob({ object: bytes });
    if (entries.get(n.oid)?.oid === oid) continue;
    await git.writeBlob({ fs, dir, blob: bytes });
    objects.push(oid);
    entries.set(n.oid, { mode: "100644", path: n.oid, oid, type: "blob" });
    added++;
  }
  if (added === 0) return { tip: parent, added, objects };
  const list = [...entries.values()];
  const tree = await git.writeTree({ fs, dir, tree: list });
  const who = { ...LANDING_IDENTITY, timestamp: Math.floor(p.at / 1000), timezoneOffset: 0 };
  const commit = await git.writeCommit({
    fs,
    dir,
    commit: { message: `Lineage notes for ${added} landing${added === 1 ? "" : "s"}\n`, tree, parent: parent === null ? [] : [parent], author: who, committer: who },
  });
  await git.writeRef({ fs, dir, ref: p.ref, value: commit, force: true });
  objects.push(tree, commit);
  p.entriesByCommit?.set(commit, list);
  return { tip: commit, added, objects };
}
