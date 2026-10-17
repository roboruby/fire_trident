import type { FileVersion, Id, Path, Sha } from "@fire_trident/core";
import { foldPath } from "../decide/pathfold.ts";

/**
 * Three things a landing must not write into trunk, checked by the trunk writer against trunk as it is when the change
 * lands (TrunkDO.structuralProblem, with the file-where-a-directory-is checks, and TrunkDO.submoduleProblems), so they
 * hold whatever review decided, with review off, and after a person's approval:
 * - A symbolic link's target. A change carries no file modes (a write set is paths and blob ids), so the writer keeps
 *   the mode trunk has at a path: writing new text where trunk holds a link (mode 120000) would keep the link and make
 *   the text its new target, pointing every checkout at another file. Refused; deleting a link is still allowed.
 * - A second spelling of one file. Two paths that fold to the same form (decide/pathfold.ts: NFC, case-folded) are one
 *   file on a case-insensitive file system, so a checkout there gets only one of them, and which one is up to the
 *   order git writes them. A change may not add a path whose folded form is another trunk path's (a rename that
 *   deletes that path in the same change is fine), nor two such paths of its own; of two changes in one landing cycle
 *   that add them, the later waits for the next cycle (cycleCollisions), where the first is trunk.
 * - A submodule. Trunk's index (ft_files) lists files and links only, never submodules (gitlinks, mode 160000), so
 *   the checks above cannot see one: writing its path would replace it with a file, writing under it would replace it
 *   with a directory, and deleting it would land as nothing. submoduleProblems reads trunk's tree along each path a
 *   change writes or deletes and refuses all three.
 * Pure, apart from the folded index's cache.
 */

/** Trunk's mode for a symbolic link. */
export const SYMLINK_MODE = "120000";
/** Trunk's mode for a submodule (a gitlink: a commit of another repository). */
export const GITLINK_MODE = "160000";

/** What the checks read of trunk. */
export interface StructureTrunk {
  /** The blob and mode trunk holds at `path`, or null when it holds no file there. */
  file(path: Path): { blob: Sha; mode: string } | null;
  /** Every trunk path by its folded form (FoldedIndex); read only when the change adds a path. */
  folded(): ReadonlyMap<string, readonly Path[]>;
}

/** Why `writeSet` cannot land on trunk as it is (a link retargeted, a second spelling of a file), or null. */
export function structureProblem(writeSet: readonly FileVersion[], trunk: StructureTrunk): string | null {
  const deleting = new Set(writeSet.filter((w) => w.blob === null).map((w) => w.path));
  const mine = new Map<string, Path>();
  for (const w of writeSet) {
    if (w.blob === null) continue;
    const at = trunk.file(w.path);
    if (at?.mode === SYMLINK_MODE && at.blob !== w.blob) {
      return `${w.path} is a symbolic link in trunk, and a change cannot change where it points (its new text would become the link's target): leave it out of the change, or replace the link with a regular file by deleting it in one change and writing the file in the next`;
    }
    const key = foldPath(w.path);
    const twin = mine.get(key);
    if (twin !== undefined && twin !== w.path) return `${twin} and ${w.path} differ only in letter case or Unicode form, so they are one file on case-insensitive file systems: write only one of them`;
    mine.set(key, w.path);
    if (at !== null) continue;
    const other = (trunk.folded().get(key) ?? []).find((p) => p !== w.path && !deleting.has(p));
    if (other !== undefined) {
      return `${w.path} differs from the trunk file ${other} only in letter case or Unicode form, so they are one file on case-insensitive file systems: write ${other} instead, or rename it in the same change (delete ${other} and write ${w.path})`;
    }
  }
  return null;
}

/**
 * The changes of one landing cycle, in order, that add a path whose folded form another, earlier change of the cycle
 * adds with a different spelling: each with the reason it waits for the next cycle (by then the earlier change is
 * trunk, and structureProblem answers for it). `inTrunk` says whether trunk already has a path exactly as written.
 */
export function cycleCollisions(changes: ReadonlyArray<{ id: Id; writeSet: readonly FileVersion[] }>, inTrunk: (path: Path) => boolean): Map<Id, string> {
  const claimed = new Map<string, Path>();
  const out = new Map<Id, string>();
  for (const c of changes) {
    const adds = c.writeSet.filter((w) => w.blob !== null && !inTrunk(w.path)).map((w) => w.path);
    const clash = adds.map((path) => ({ path, other: claimed.get(foldPath(path)) })).find((x) => x.other !== undefined && x.other !== x.path);
    if (clash) {
      out.set(c.id, `${clash.path} differs only in letter case or Unicode form from ${clash.other}, which another change in this landing cycle adds; it waits for the next cycle`);
      continue;
    }
    for (const path of adds) if (!claimed.has(foldPath(path))) claimed.set(foldPath(path), path);
  }
  return out;
}

/** One entry of a trunk tree as a tree read returns it. */
export interface TreeItem {
  path: string;
  mode: string;
  oid: string;
  type: string;
}

/** What submoduleProblems does with a change: send it back with the reason, or let it wait when trunk's tree could not be read. */
export type SubmoduleOutcome = { kind: "returned" | "deferred"; reason: string };

const SUBMODULES_UNCHANGED = "FireTrident does not change submodules. Leave it out of the change.";

/**
 * The changes that write or delete a path that is a submodule in trunk, or a path inside one, each with its outcome:
 * returned naming the path and the submodule, or deferred when trunk's tree could not be read (the check fails
 * closed). `root` is trunk's root tree; only the trees on the paths the changes touch are read, each once.
 */
export async function submoduleProblems(
  changes: ReadonlyArray<{ id: Id; writeSet: readonly FileVersion[] }>,
  root: string,
  entries: (oid: string) => Promise<readonly TreeItem[]>,
): Promise<Map<Id, SubmoduleOutcome>> {
  // A directory's entries by name (null: not a directory in trunk), by directory path ("" for the root).
  const dirs = new Map<string, Promise<ReadonlyMap<string, TreeItem> | null>>();
  const dirAt = (dir: string): Promise<ReadonlyMap<string, TreeItem> | null> => {
    let known = dirs.get(dir);
    if (!known) {
      known = (async () => {
        if (dir === "") return new Map((await entries(root)).map((e) => [e.path, e]));
        const cut = dir.lastIndexOf("/");
        const e = (await dirAt(cut === -1 ? "" : dir.slice(0, cut)))?.get(dir.slice(cut + 1));
        return e?.type === "tree" ? new Map((await entries(e.oid)).map((x) => [x.path, x])) : null;
      })();
      dirs.set(dir, known);
    }
    return known;
  };
  const out = new Map<Id, SubmoduleOutcome>();
  for (const c of changes) {
    try {
      for (const w of c.writeSet) {
        const parts = w.path.split("/");
        const did = w.blob === null ? "deletes" : "writes";
        let found: string | null = null;
        for (let i = 0; i < parts.length && found === null; i++) {
          const e = (await dirAt(parts.slice(0, i).join("/")))?.get(parts[i]!);
          if (!e) break;
          if (e.mode === GITLINK_MODE || e.type === "commit") found = parts.slice(0, i + 1).join("/");
          else if (e.type !== "tree") break;
        }
        if (found === null) continue;
        const what = found === w.path ? "which is a submodule in trunk" : `which is inside the submodule ${found} in trunk`;
        out.set(c.id, { kind: "returned", reason: `This change ${did} ${w.path}, ${what}; ${SUBMODULES_UNCHANGED}` });
        break;
      }
    } catch (err) {
      out.set(c.id, { kind: "deferred", reason: `trunk's tree could not be read to check for submodules: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  return out;
}

/** Trunk's paths by folded form, rebuilt only when trunk moves (keyed by the trunk commit the index describes). */
export class FoldedIndex {
  private at: string | null = null;
  private map = new Map<string, Path[]>();

  /** The folded index of trunk at `version`, read with `paths` when trunk moved since the last call. */
  get(version: string, paths: () => Iterable<Path>): ReadonlyMap<string, readonly Path[]> {
    if (this.at !== version) {
      const map = new Map<string, Path[]>();
      for (const path of paths()) {
        const key = foldPath(path);
        const list = map.get(key);
        if (list) list.push(path);
        else map.set(key, [path]);
      }
      this.map = map;
      this.at = version;
    }
    return this.map;
  }
}
