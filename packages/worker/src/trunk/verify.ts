import git from "isomorphic-git";
import type { Id, Millis, NoteCheck, NoteCheckStatus, NotesVerification, Sha } from "@fire_trident/core";
import type { GitRepo } from "../artifacts/git.ts";
import { checkNote, trailerDigest } from "./digest.ts";

/**
 * `ft verify`: the newest landings' lineage notes on the trunk repository, checked against the FT-Note trailer of the
 * commit each one annotates (trunk/digest.ts). The trunk writer resolves refs/notes/firetrident on the repository and
 * reads each note under it from its local repository when it has the objects (notes commits it wrote itself), and
 * through the Artifacts binding otherwise (a notes commit someone else pushed). Read only.
 */

/** Landings checked by default, and at most. */
export const VERIFY_DEFAULT = 20;
export const VERIFY_MAX = 200;
/** Landings checked at once. */
const CONCURRENCY = 8;
const FAN = /^[0-9a-f]{2}$/;

/** One recorded landing as the check needs it: its commit, the trunk writer's own copy of its note, and whether a push of it is still due. */
export interface LandingRow {
  landingId: Id;
  trunkSha: Sha;
  at: Millis;
  note: string | null;
  waiting: boolean;
}

/** One entry of a git tree. */
export interface SourceEntry {
  name: string;
  oid: string;
  type: string;
}

/** Git objects by id from one place; null when that place does not have the object. */
export interface ObjectSource {
  commit(oid: string): Promise<{ tree: string; message: string } | null>;
  tree(oid: string): Promise<SourceEntry[] | null>;
  blob(oid: string): Promise<Uint8Array | null>;
}

/** How many landings to check for a requested `limit` (VERIFY_DEFAULT when it is not a number). */
export function verifyLimit(limit: unknown): number {
  const n = typeof limit === "number" && Number.isFinite(limit) ? Math.floor(limit) : VERIFY_DEFAULT;
  return Math.max(1, Math.min(VERIFY_MAX, n));
}

/** The local repository as a source (isomorphic-git; an object it does not have reads as null). */
export function localSource(repo: GitRepo): ObjectSource {
  const absent = (e: unknown): null => {
    if ((e as { code?: string } | null)?.code === "NotFoundError") return null;
    throw e;
  };
  const at = { fs: repo.fs, dir: repo.dir, cache: repo.cache };
  return {
    commit: (oid) => git.readCommit({ ...at, oid }).then((r) => ({ tree: r.commit.tree, message: r.commit.message }), absent),
    tree: (oid) => git.readTree({ ...at, oid }).then((r) => r.tree.map((e) => ({ name: e.path, oid: e.oid, type: e.type })), absent),
    blob: (oid) => git.readBlob({ ...at, oid }).then((r) => r.blob, absent),
  };
}

/** A repository read through the Artifacts binding (the handle is opened on first use by `open`). */
export function bindingSource(open: () => Promise<ArtifactsRepo>): ObjectSource {
  return {
    async commit(oid) {
      const c = await (await open()).readCommit(oid);
      return c ? { tree: c.treeHash, message: c.message } : null;
    },
    async tree(oid) {
      const t = await (await open()).readTree(oid);
      return t ? t.map((e) => ({ name: e.name, oid: e.hash, type: e.type === "exec" ? "blob" : e.type })) : null;
    },
    async blob(oid) {
      const b = await (await open()).readBlob(oid);
      return b ? new Uint8Array(await b.arrayBuffer()) : null;
    },
  };
}

/** `first`, then `second` for what `first` does not have or cannot read (objects are the same wherever they are read, by id). */
export function layered(first: ObjectSource, second: ObjectSource): ObjectSource {
  const either =
    <T>(a: (oid: string) => Promise<T | null>, b: (oid: string) => Promise<T | null>) =>
    async (oid: string): Promise<T | null> =>
      (await a(oid).catch(() => null)) ?? b(oid);
  return { commit: either(first.commit, second.commit), tree: either(first.tree, second.tree), blob: either(first.blob, second.blob) };
}

/**
 * The bytes of the note on commit `oid` under the notes tree `root`, in either layout git reads: flat (`<oid>`) or fanout
 * at any depth (`ab/<rest>`, `ab/cd/<rest>`). Null when there is none; throws when the note is listed but cannot be read.
 */
export async function noteAt(src: ObjectSource, root: string, oid: Sha, trees: Map<string, Promise<SourceEntry[] | null>> = new Map()): Promise<Uint8Array | null> {
  const read = (id: string): Promise<SourceEntry[] | null> => {
    let t = trees.get(id);
    if (!t) {
      t = src.tree(id);
      trees.set(id, t);
    }
    return t;
  };
  let entries = await read(root);
  let rest = oid;
  for (;;) {
    if (!entries) return null;
    const hit = entries.find((e) => e.name === rest && e.type === "blob");
    if (hit) {
      const bytes = await src.blob(hit.oid);
      if (!bytes) throw new Error(`note blob ${hit.oid} could not be read`);
      return bytes;
    }
    const fan = rest.slice(0, 2);
    const next = rest.length > 2 && FAN.test(fan) ? entries.find((e) => e.name === fan && e.type === "tree") : undefined;
    if (!next) return null;
    entries = await read(next.oid);
    rest = rest.slice(2);
  }
}

/** Each landing's note under notes commit `tip` (null: the repository has no notes) against its commit's trailer, in input order. */
export async function checkLandings(rows: LandingRow[], p: { src: ObjectSource; tip: Sha | null }): Promise<NoteCheck[]> {
  const trees = new Map<string, Promise<SourceEntry[] | null>>();
  let root: Promise<string | null> | null = null;
  const rootTree = (): Promise<string | null> =>
    (root ??= p.tip === null ? Promise.resolve(null) : p.src.commit(p.tip).then((c) => {
      if (!c) throw new Error(`the notes commit ${p.tip} could not be read`);
      return c.tree;
    }));
  return mapLimit(rows, CONCURRENCY, async (r): Promise<NoteCheck> => {
    const base = { landingId: r.landingId, trunkSha: r.trunkSha, at: r.at };
    let message: string | null;
    try {
      message = (await p.src.commit(r.trunkSha))?.message ?? null;
    } catch (e) {
      return { ...base, status: "unreadable", detail: `the commit could not be read: ${errorText(e)}` };
    }
    if (message === null) return { ...base, status: "unreadable", detail: "the commit could not be read" };
    const trailer = trailerDigest(message);
    if (trailer === null) return { ...base, status: "no-trailer", detail: "the commit carries no FT-Note trailer (it landed before notes were sealed)" };
    const ownCopy = r.note !== null && (await checkNote(r.note, trailer)).status === "intact";
    const sealed = { ...base, trailer, ownCopy };
    let bytes: Uint8Array | null;
    try {
      const tree = await rootTree();
      bytes = tree === null ? null : await noteAt(p.src, tree, r.trunkSha, trees);
    } catch (e) {
      return { ...sealed, status: "unreadable", detail: errorText(e) };
    }
    if (bytes === null) {
      return r.waiting
        ? { ...sealed, status: "pending", detail: "the note is not on the trunk repository yet (its push is due)" }
        : { ...sealed, status: "missing", detail: "the trunk repository has no note for this commit" };
    }
    const check = await checkNote(bytes, trailer);
    if (check.status === "intact") return { ...sealed, status: "intact" };
    return { ...sealed, status: "altered", ...(check.found ? { found: check.found } : {}), ...(check.detail ? { detail: check.detail } : {}) };
  });
}

/** The answer of a verification: the checks, newest first, with a count per status. */
export function summarize(colonyId: Id, tip: Sha | null, notes: NoteCheck[], at: Millis): NotesVerification {
  const counts: Partial<Record<NoteCheckStatus, number>> = {};
  for (const n of notes) counts[n.status] = (counts[n.status] ?? 0) + 1;
  return { colonyId, notesTip: tip, notes, counts, at };
}

function errorText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 300);
}

/** `fn` over `items` with at most `limit` in flight; results keep input order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
