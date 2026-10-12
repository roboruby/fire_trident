import git, { type TreeEntry } from "isomorphic-git";
import type { GitRepo, PathChange } from "../artifacts/git.ts";
import { objectId, treeContent } from "./objects.ts";

const TREE_MODE = "040000";

/**
 * A Map that keeps at most `max` entries, dropping the oldest insertions first. Tree and commit
 * objects are immutable by id, so the trunk writer can keep them in memory across cycles and
 * calls instead of reading them back from the git store each time.
 */
export class BoundedMap<K, V> extends Map<K, V> {
  constructor(private readonly max: number) {
    super();
  }

  override set(key: K, value: V): this {
    if (super.has(key)) super.delete(key);
    super.set(key, value);
    while (super.size > this.max) {
      const oldest = super.keys().next();
      if (oldest.done) break;
      super.delete(oldest.value);
    }
    return this;
  }
}

/** Entries of tree `oid`, from `trees` when cached. */
export async function readTreeCached(repo: GitRepo, trees: Map<string, TreeEntry[]>, oid: string): Promise<TreeEntry[]> {
  const hit = trees.get(oid);
  if (hit) return hit;
  const { tree } = await git.readTree({ fs: repo.fs, dir: repo.dir, oid, cache: repo.cache });
  trees.set(oid, tree);
  return tree;
}

interface ChangeNode {
  files: Map<string, PathChange>;
  dirs: Map<string, ChangeNode>;
}

function changeTree(changes: Map<string, PathChange>): ChangeNode {
  const root: ChangeNode = { files: new Map(), dirs: new Map() };
  for (const [path, change] of changes) {
    const parts = path.split("/");
    let node = root;
    for (const dir of parts.slice(0, -1)) {
      let next = node.dirs.get(dir);
      if (!next) {
        next = { files: new Map(), dirs: new Map() };
        node.dirs.set(dir, next);
      }
      node = next;
    }
    node.files.set(parts[parts.length - 1]!, change);
  }
  return root;
}

async function rewrite(repo: GitRepo, trees: Map<string, TreeEntry[]>, oid: string | null, node: ChangeNode, written?: Set<string>): Promise<string | null> {
  const entries = new Map<string, TreeEntry>();
  if (oid !== null) for (const e of await readTreeCached(repo, trees, oid)) entries.set(e.path, e);
  for (const [name, change] of node.files) {
    if (change === null) entries.delete(name);
    else entries.set(name, { mode: change.mode, path: name, oid: change.blob, type: "blob" });
  }
  for (const [name, child] of node.dirs) {
    const cur = entries.get(name);
    const next = await rewrite(repo, trees, cur?.type === "tree" ? cur.oid : null, child, written);
    if (next === null) entries.delete(name);
    else entries.set(name, { mode: TREE_MODE, path: name, oid: next, type: "tree" });
  }
  if (entries.size === 0) return null;
  const list = [...entries.values()];
  const id = await git.writeTree({ fs: repo.fs, dir: repo.dir, tree: list });
  trees.set(id, list);
  written?.add(id);
  return id;
}

/** A git object whose id is computed and whose bytes wait to be written (writePending). */
export interface PendingObject {
  type: "tree" | "commit";
  content: Uint8Array;
}

async function rewriteDeferred(
  repo: GitRepo,
  trees: Map<string, TreeEntry[]>,
  oid: string | null,
  node: ChangeNode,
  pending: Map<string, PendingObject & { entries?: TreeEntry[] }>,
): Promise<string | null> {
  const entries = new Map<string, TreeEntry>();
  if (oid !== null) {
    const known = pending.get(oid)?.entries ?? (await readTreeCached(repo, trees, oid));
    for (const e of known) entries.set(e.path, e);
  }
  for (const [name, change] of node.files) {
    if (change === null) entries.delete(name);
    else entries.set(name, { mode: change.mode, path: name, oid: change.blob, type: "blob" });
  }
  for (const [name, child] of node.dirs) {
    const cur = entries.get(name);
    const next = await rewriteDeferred(repo, trees, cur?.type === "tree" ? cur.oid : null, child, pending);
    if (next === null) entries.delete(name);
    else entries.set(name, { mode: TREE_MODE, path: name, oid: next, type: "tree" });
  }
  if (entries.size === 0) return null;
  const list = [...entries.values()];
  const content = treeContent(list);
  const id = objectId("tree", content);
  if (!pending.has(id)) pending.set(id, { type: "tree", content, entries: list });
  trees.set(id, list);
  return id;
}

/**
 * Tree surgery computed in memory: the same tree ids as applyTreeChangesCached, but no object is
 * written; each new tree goes to `pending` (with its entries, so later surgery in the same chain
 * reads it from there). A chain of landings is built this way without waiting on the git store,
 * then writePending writes every object of the chain at once.
 */
export async function applyTreeChangesDeferred(
  repo: GitRepo,
  trees: Map<string, TreeEntry[]>,
  root: string,
  changes: Map<string, PathChange>,
  pending: Map<string, PendingObject & { entries?: TreeEntry[] }>,
): Promise<string> {
  const out = await rewriteDeferred(repo, trees, root, changeTree(changes), pending);
  if (out !== null) return out;
  const content = treeContent([]);
  const id = objectId("tree", content);
  pending.set(id, { type: "tree", content, entries: [] });
  return id;
}

/** Write every pending object (`concurrency` at a time), checking that each lands under the id computed for it. */
export async function writePending(repo: GitRepo, pending: Map<string, PendingObject>, concurrency = 16): Promise<void> {
  const items = [...pending];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const [id, o] = items[next++]!;
      const written = await git.writeObject({ fs: repo.fs, dir: repo.dir, type: o.type, object: o.content, format: "content" });
      if (written !== id) throw new Error(`${o.type} written as ${written}, computed as ${id}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

/**
 * Tree surgery (same result as artifacts/git.ts applyTreeChanges): a new root tree equal to
 * `root` with `changes` applied, rewriting only trees on a changed path, each once; directories
 * left empty disappear. Reads go through `trees` and every tree written is added to it, so a
 * chain of landings built on each other re-reads nothing it just wrote. Every tree written is
 * added to `written` (when given): the objects a push of the result must carry.
 */
export async function applyTreeChangesCached(repo: GitRepo, trees: Map<string, TreeEntry[]>, root: string, changes: Map<string, PathChange>, written?: Set<string>): Promise<string> {
  const out = await rewrite(repo, trees, root, changeTree(changes), written);
  if (out !== null) return out;
  const empty = await git.writeTree({ fs: repo.fs, dir: repo.dir, tree: [] });
  trees.set(empty, []);
  written?.add(empty);
  return empty;
}
