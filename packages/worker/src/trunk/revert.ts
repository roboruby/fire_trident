import type { Id, Landing, Path, Sha } from "@fire_trident/core";
import { importsOf } from "@fire_trident/core";
import { isRelative, resolveModule, specifierTarget } from "../decide/mechanical.ts";

/**
 * Undoing a landing (`ft revert`). A revert is a person's decision, written as a new commit on
 * current main that puts every path the landing wrote back to the blob it had before. It is
 * guarded like any landing: a path that no longer holds the blob the landing produced has had work
 * land on top of it, and undoing would overwrite that work, so the revert is refused with the paths
 * and the landings that moved them. A file the landing created is deleted by its revert, so the
 * revert is refused too while other trunk files import it (resolved as the decide stage resolves
 * relative imports). Pure: no I/O.
 */

/** One path of a landing as the trunk writer recorded it (null: absent). */
export interface LandedPath {
  path: Path;
  before: Sha | null;
  after: Sha | null;
}

/** A path that changed again after the landing: what trunk holds now, and the latest landing that changed it (undo that one first). */
export interface Moved {
  path: Path;
  now: Sha | null;
  by: Id | null;
}

/** What a revert writes for one path: its blob before the landing (null: delete it), if trunk still holds `expect`. */
export interface Restore {
  path: Path;
  blob: Sha | null;
  expect: Sha | null;
}

export type RevertPlan = { ok: true; restore: Restore[] } | { ok: false; moved: Moved[] };

/** A file the revert would delete that other trunk files import. */
export interface Imported {
  path: Path;
  /** The trunk files whose relative imports resolve to it, sorted. */
  by: Path[];
}

/** The answer of TrunkDO.revert. */
export type RevertResult =
  | { ok: true; landing: Landing; reverted: Landing }
  | { ok: false; status: 404 | 409 | 422; error: string; moved?: Moved[]; imported?: Imported[] };

/** Plan the revert of one landing's paths against current trunk (`later` names the latest landing that changed a path since). */
export function planRevert(paths: readonly LandedPath[], current: (path: Path) => Sha | null, later: (path: Path) => Id | null): RevertPlan {
  const moved: Moved[] = [];
  for (const p of paths) {
    const now = current(p.path);
    if (now !== p.after) moved.push({ path: p.path, now, by: later(p.path) });
  }
  if (moved.length > 0) return { ok: false, moved };
  return { ok: true, restore: paths.filter((p) => p.before !== p.after).map((p) => ({ path: p.path, blob: p.before, expect: p.after })) };
}

/** The refused paths in one line, e.g. "src/a.ts changed since, last by lnd_x; src/b.ts deleted since". */
export function movedText(moved: readonly Moved[], max = 5): string {
  const parts = moved.slice(0, max).map((m) => `${m.path} ${m.now === null ? "deleted" : "changed"} since${m.by ? `, last by ${m.by}` : ""}`);
  if (moved.length > max) parts.push(`and ${moved.length - max} more`);
  return parts.join("; ");
}

/** JS/TS files: the family whose relative imports the decide stage resolves. */
export const SCRIPT_FILE = /\.[cm]?[jt]sx?$/i;

/**
 * How much of trunk the import check of one revert reads at most: script files, and their bytes.
 * Past either limit the revert is refused (422) rather than done unchecked.
 */
export const IMPORT_SCAN = { files: 20_000, bytes: 64 * 1024 * 1024 } as const;

/** The relative import specifiers in a script's text. */
export function relativeSpecifiers(text: string): string[] {
  return importsOf(text)
    .map((i) => i.specifier)
    .filter(isRelative);
}

/**
 * The files a revert would delete that other trunk files import. Every relative specifier of every
 * script file is resolved against the current trunk tree (`exists`) with the decide stage's rules,
 * and one that resolves to a deleted path makes its file an importer of it. The caller leaves out
 * the files the revert itself writes: they go back to what they were before the landing.
 */
export function importedDeletions(deleted: readonly Path[], files: Iterable<{ path: Path; specifiers: readonly string[] }>, exists: (p: Path) => boolean): Imported[] {
  const gone = new Set(deleted);
  const by = new Map<Path, Set<Path>>();
  for (const f of files) {
    if (!SCRIPT_FILE.test(f.path) || gone.has(f.path)) continue;
    for (const spec of f.specifiers) {
      const target = resolveModule(specifierTarget(f.path, spec), exists);
      if (target === null || !gone.has(target)) continue;
      const set = by.get(target) ?? new Set<Path>();
      set.add(f.path);
      by.set(target, set);
    }
  }
  return deleted.filter((p) => by.has(p)).map((p) => ({ path: p, by: [...by.get(p)!].sort() }));
}

/**
 * The imported files in one line, each importer with the latest landing that changed it when known
 * (undo that one first), e.g. "src/new.ts is imported by src/a.ts (last changed by lnd_x), src/b.ts".
 */
export function importedText(list: readonly Imported[], lastBy: (path: Path) => Id | null = () => null, max = 5): string {
  const parts = list.slice(0, max).map((m) => {
    const names = m.by.slice(0, max).map((p) => {
      const l = lastBy(p);
      return l ? `${p} (last changed by ${l})` : p;
    });
    if (m.by.length > max) names.push(`${m.by.length - max} more`);
    return `${m.path} is imported by ${names.join(", ")}`;
  });
  if (list.length > max) parts.push(`and ${list.length - max} more`);
  return parts.join("; ");
}
