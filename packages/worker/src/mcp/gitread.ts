import type { FileVersion, Path, Sha } from "@fire_trident/core";

/**
 * Server-side git reads over the Artifacts binding (readCommit / readTree /
 * readBlob, ~13 ms each). Functions are injected so the logic is testable and the
 * same code serves trunk and workspace repos.
 */

/** A tree entry as the binding returns it (`mode` "40000" for trees). */
export interface TreeEntryLike {
  name: string;
  mode: string;
  hash: string;
  type: string;
}

export type ReadTree = (hash: Sha) => Promise<TreeEntryLike[] | null>;
export type ReadCommit = (hash: Sha) => Promise<{ hash: Sha; treeHash: Sha; parents: Sha[] } | null>;
export type ReadBlob = (hash: Sha) => Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;

/** Ceilings that keep one diff bounded. */
export interface DiffLimits {
  /** Most changed paths reported before giving up. */
  maxChanges: number;
  /** Most tree objects read. */
  maxTreeReads: number;
}

export const DEFAULT_DIFF_LIMITS: DiffLimits = { maxChanges: 2_000, maxTreeReads: 4_000 };

const isTree = (e: TreeEntryLike | undefined): e is TreeEntryLike => e?.type === "tree";
/** Regular files, executables and symlinks are blobs; submodule links are skipped. */
const isBlob = (e: TreeEntryLike | undefined): e is TreeEntryLike => e !== undefined && e.type !== "tree" && e.type !== "gitlink" && e.type !== "commit";

/**
 * Every path whose blob differs between two root trees, with the head side's blob
 * id (null when the head deleted it), sorted by path. Identical subtrees are
 * skipped by hash, so the cost is proportional to what changed. A mode-only change
 * is reported with its unchanged blob id. Throws past the limits.
 */
export async function diffTrees(readTree: ReadTree, baseTree: Sha, headTree: Sha, limits: DiffLimits = DEFAULT_DIFF_LIMITS): Promise<FileVersion[]> {
  const out: FileVersion[] = [];
  let reads = 0;
  const read = async (hash: Sha): Promise<TreeEntryLike[]> => {
    if (++reads > limits.maxTreeReads) throw new Error(`the change touches more than ${limits.maxTreeReads} directories`);
    const entries = await readTree(hash);
    if (!entries) throw new Error(`tree ${hash} is missing`);
    return entries;
  };
  const push = (f: FileVersion): void => {
    if (out.length >= limits.maxChanges) throw new Error(`the change touches more than ${limits.maxChanges} files`);
    out.push(f);
  };
  const walk = async (prefix: string, a: Sha | null, b: Sha | null): Promise<void> => {
    if (a === b) return;
    const [ea, eb] = await Promise.all([a ? read(a) : Promise.resolve([]), b ? read(b) : Promise.resolve([])]);
    const ma = new Map(ea.map((e) => [e.name, e]));
    const mb = new Map(eb.map((e) => [e.name, e]));
    const names = [...new Set([...ma.keys(), ...mb.keys()])].sort();
    for (const name of names) {
      const x = ma.get(name);
      const y = mb.get(name);
      if (x && y && x.hash === y.hash && x.mode === y.mode) continue;
      const path = prefix === "" ? name : `${prefix}/${name}`;
      if (isTree(x) || isTree(y)) await walk(path, isTree(x) ? x.hash : null, isTree(y) ? y.hash : null);
      const xb = isBlob(x) ? x : undefined;
      const yb = isBlob(y) ? y : undefined;
      if (yb && (!xb || xb.hash !== yb.hash || xb.mode !== yb.mode)) push({ path, blob: yb.hash });
      else if (xb && !yb) push({ path, blob: null });
    }
  };
  await walk("", baseTree, headTree);
  return out.sort((p, q) => (p.path < q.path ? -1 : p.path > q.path ? 1 : 0));
}

/**
 * Does `ancestor` appear on the first-parent chain of `head`, within `maxDepth`
 * commits (head itself counts)? Missing commits end the walk.
 */
export async function onFirstParentChain(readCommit: ReadCommit, head: Sha, ancestor: Sha, maxDepth = 64): Promise<boolean> {
  let cur: Sha | undefined = head;
  for (let i = 0; i < maxDepth && cur; i++) {
    if (cur === ancestor) return true;
    const c = await readCommit(cur);
    if (!c) return false;
    cur = c.parents[0];
  }
  return false;
}

/** The blob at `path` in `rootTree`: its entry, or null when absent or not a file. */
export async function entryAtPath(readTree: ReadTree, rootTree: Sha, path: Path): Promise<TreeEntryLike | null> {
  const parts = path.split("/").filter((s) => s !== "");
  if (parts.length === 0) return null;
  let tree: Sha = rootTree;
  for (let i = 0; i < parts.length; i++) {
    const entries = await readTree(tree);
    if (!entries) return null;
    const e = entries.find((x) => x.name === parts[i]);
    if (!e) return null;
    if (i === parts.length - 1) return isBlob(e) ? e : null;
    if (!isTree(e)) return null;
    tree = e.hash;
  }
  return null;
}

/** A file read at a commit. */
export interface FileAt {
  path: Path;
  /** Blob id, or null when the path does not exist at the commit. */
  blob: Sha | null;
  mode?: string;
  size: number;
  /** UTF-8 text; absent for binary files and files over the size cap. */
  content?: string;
  binary?: boolean;
  tooLarge?: boolean;
}

/** Read one file at a commit through the binding: tree walk for the blob id, then the bytes. */
export async function readFileAt(
  io: { readCommit: ReadCommit; readTree: ReadTree; readBlob: ReadBlob },
  commit: Sha,
  path: Path,
  maxBytes = 1_000_000,
): Promise<FileAt> {
  const c = await io.readCommit(commit);
  if (!c) throw new Error(`commit ${commit} is not in the repository`);
  const entry = await entryAtPath(io.readTree, c.treeHash, path);
  if (!entry) return { path, blob: null, size: 0 };
  const blob = await io.readBlob(entry.hash);
  if (!blob) throw new Error(`blob ${entry.hash} for ${path} is missing`);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const out: FileAt = { path, blob: entry.hash, mode: entry.mode, size: bytes.length };
  if (bytes.length > maxBytes) {
    out.tooLarge = true;
    return out;
  }
  if (bytes.subarray(0, 8192).includes(0)) {
    out.binary = true;
    return out;
  }
  try {
    out.content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    out.binary = true;
  }
  return out;
}
