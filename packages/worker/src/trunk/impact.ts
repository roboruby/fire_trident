import { footprintCovers } from "@fire_trident/core";
import type { Path, Sha } from "@fire_trident/core";
import { indexRange, isLiteralEntry } from "../agents/landed.ts";
import type { ImportIndex, ImportSource } from "./imports.ts";

/**
 * What a change to some trunk paths reaches through imports: the trunk script files that import them, then the files
 * that import those, up to IMPACT_DEPTH levels and IMPACT_FILES files in all (the paths asked about count), nearest
 * first, each with the file it imports on the way (`via`). TrunkDO.importerWalk serves it from the import index
 * (trunk/imports.ts); the colony joins it with the live claims on those files and the latest landings on them
 * (colony/impact.ts).
 *
 * A read never waits long for the index: it brings the index up to date (building it on first use) for at most
 * IMPACT_SYNC_MS, then answers from the index as it stands and says whether it was current. A sync still running goes on
 * in the background, so the next read finds it done. Imports resolve as the index resolves them (relative specifiers
 * between script files; path aliases and packages are not followed).
 */

/** Levels of importers walked at most, files reached at most (the files asked about count), and entries asked about at most. */
export const IMPACT_DEPTH = 3;
export const IMPACT_FILES = 200;
export const IMPACT_ENTRIES = 20;
/** How long a read waits for the import index's sync (ms). */
export const IMPACT_SYNC_MS = 3_000;
/** Trunk paths the directory and glob entries of one walk scan at most, together, to find the files they cover. */
const SCAN_PATHS = 20_000;

/** How far a walk goes: levels (1 to IMPACT_DEPTH), files in all (1 to IMPACT_FILES), and the wait for the index's sync. */
export interface ImporterWalkOptions {
  depth?: number;
  max?: number;
  waitMs?: number;
}

/** One importer the walk reached: its level, and the file it imports on the way to a file asked about. */
export interface WalkedFile {
  path: Path;
  depth: number;
  via: Path;
}

/** What a walk found (TrunkDO.importerWalk). */
export interface ImporterWalk {
  /** Trunk's head when the walk ran (null before trunk has one). */
  trunkSha: Sha | null;
  /** The import index described that head with nothing left to read or resolve; `note` says why not. */
  current: boolean;
  note?: string;
  /** The trunk files the entries name (directories and globs expanded), in the order asked. */
  roots: Path[];
  /** Entries that name no trunk file. */
  missing: Path[];
  /** Importers, nearest first: depth 1 imports a root, depth 2 imports a depth-1 file, and so on. */
  files: WalkedFile[];
  /** A cap stopped the walk (files, levels, or the files an entry covers): there is more than it shows. */
  truncated: boolean;
}

/** The trunk files a walk can name: whether a path is a file, and the files in a range of paths. */
export interface TrunkFiles {
  has(path: Path): boolean;
  /** Paths p with from <= p < to, sorted, at most `limit`. */
  range(from: Path, to: Path, limit: number): Path[];
}

/** One level of importers (ImportIndex.importersOf). */
export type ImportersOf = (paths: Path[], exclude: Path[], limit: number) => Array<{ path: Path; via: Path }>;

/** A whole number from `raw` within [min, max], else `fallback`. */
function bounded(raw: unknown, min: number, max: number, fallback: number): number {
  const n = typeof raw === "number" ? raw : Number.NaN;
  return Number.isInteger(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

/** `p`'s value, or `late` when it takes longer than `ms`. The timer is cleared either way. */
async function within<T, U>(p: Promise<T>, ms: number, late: U): Promise<T | U> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<U>((resolve) => {
        timer = setTimeout(() => resolve(late), Math.max(0, ms));
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The trunk files a list of entries names: a file as itself; a directory (a trailing slash, or a path trunk has files
 * under) or a glob as the trunk files it covers, sorted. At most `max` files in all, and SCAN_PATHS trunk paths scanned
 * for the directories and globs together; entries that name nothing are `missing`. `truncated` when a cap stopped short.
 */
export function expandEntries(trunk: TrunkFiles, entries: readonly Path[], max: number): { roots: Path[]; missing: Path[]; truncated: boolean } {
  const roots: Path[] = [];
  const seen = new Set<Path>();
  const missing: Path[] = [];
  let truncated = false;
  let budget = SCAN_PATHS;
  const add = (path: Path): boolean => {
    if (seen.has(path)) return true;
    if (roots.length >= max) {
      truncated = true;
      return false;
    }
    seen.add(path);
    roots.push(path);
    return true;
  };
  for (const entry of entries.slice(0, IMPACT_ENTRIES)) {
    if (typeof entry !== "string" || entry === "") continue;
    if (isLiteralEntry(entry) && trunk.has(entry)) {
      add(entry);
      continue;
    }
    if (budget <= 0) {
      // The scan budget is spent: this entry was not looked at.
      truncated = true;
      continue;
    }
    // A directory named without its slash is a directory too.
    const pattern = isLiteralEntry(entry) ? `${entry}/` : entry;
    const range = indexRange(pattern) ?? { from: "", to: "\u{10FFFF}" };
    const scan = "eq" in range ? [] : trunk.range(range.from, range.to, budget);
    budget -= scan.length;
    let found = false;
    for (const path of scan) {
      if (!footprintCovers(pattern, path)) continue;
      found = true;
      if (!add(path)) break;
    }
    if (budget <= 0) truncated = true;
    else if (!found) missing.push(entry);
  }
  if (entries.length > IMPACT_ENTRIES) truncated = true;
  return { roots, missing, truncated };
}

/**
 * Walk importers breadth first from `roots`: level d holds the files that import a file of level d - 1, each once (a
 * file is kept at the first level that reaches it), with the file it imports there. At most `max` files in all (roots
 * included) and `depth` levels. `truncated` when either cap left importers out.
 */
export function walkImporters(roots: readonly Path[], importersOf: ImportersOf, depth: number, max: number): { files: WalkedFile[]; truncated: boolean } {
  const seen = new Set<Path>(roots);
  const files: WalkedFile[] = [];
  let frontier = [...seen];
  let truncated = false;
  for (let level = 1; level <= depth && frontier.length > 0; level++) {
    const room = max - seen.size;
    if (room <= 0) {
      // The cap is reached: truncated when the level it stops short of has importers.
      return { files, truncated: truncated || importersOf(frontier, [...seen], 1).length > 0 };
    }
    const found = importersOf(frontier, [...seen], room + 1);
    const next: Path[] = [];
    for (const f of found) {
      if (seen.has(f.path)) continue;
      if (next.length >= room) {
        truncated = true;
        break;
      }
      seen.add(f.path);
      next.push(f.path);
      files.push({ path: f.path, depth: level, via: f.via });
    }
    frontier = next;
  }
  // The level past the last one walked: say so when it has importers.
  if (!truncated && frontier.length > 0) truncated = importersOf(frontier, [...seen], 1).length > 0;
  return { files, truncated };
}

/**
 * The importer walk from the trunk writer's import index (TrunkDO.importerWalk): the index is brought up to date first
 * (built on first use) for `waitMs` at most, then the entries are expanded against trunk and their importers walked.
 * A sync that fails or runs past the wait leaves the answer to the index as it stands, `current` false with a note.
 */
export async function importerWalk(index: ImportIndex, source: ImportSource, trunk: TrunkFiles, entries: readonly Path[], opts: ImporterWalkOptions = {}): Promise<ImporterWalk> {
  const depth = bounded(opts.depth, 1, IMPACT_DEPTH, IMPACT_DEPTH);
  const max = bounded(opts.max, 1, IMPACT_FILES, IMPACT_FILES);
  const waitMs = bounded(opts.waitMs, 0, 30_000, IMPACT_SYNC_MS);
  const synced = await within(
    index.sync(source).then(
      () => null,
      (e: unknown) => `the import index could not be brought up to date (${e instanceof Error ? e.message : String(e)})`,
    ),
    waitMs,
    `the import index was still being brought up to date after ${Math.round(waitMs / 100) / 10} s (it is built the first time it is read)`,
  );
  const head = source.head();
  const current = head !== null && index.current(head);
  const note = current ? undefined : `${synced ?? "the import index has files left to read (a budget ran out or a read failed)"}: importers may be missing; ask again in a few seconds`;
  const expanded = expandEntries(trunk, entries, max);
  const walk = walkImporters(expanded.roots, (paths, exclude, limit) => index.importersOf(paths, exclude, limit), depth, max);
  return {
    trunkSha: head,
    current,
    ...(note ? { note } : {}),
    roots: expanded.roots,
    missing: expanded.missing,
    files: walk.files,
    truncated: expanded.truncated || walk.truncated,
  };
}
