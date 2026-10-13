import type { Id, Landing, Path, Sha } from "@fire_trident/core";

/**
 * Undoing a landing (`ft revert`). A revert is a person's decision, written as a new commit on
 * current main that puts every path the landing wrote back to the blob it had before. It is
 * guarded like any landing: a path that no longer holds the blob the landing produced has had work
 * land on top of it, and undoing would overwrite that work, so the revert is refused with the paths
 * and the landings that moved them. Pure: no I/O.
 */

/** One path of a landing as the trunk writer recorded it (null: absent). */
export interface LandedPath {
  path: Path;
  before: Sha | null;
  after: Sha | null;
}

/** A path that changed again after the landing: what trunk holds now, and the first landing that changed it. */
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

/** The answer of TrunkDO.revert. */
export type RevertResult =
  | { ok: true; landing: Landing; reverted: Landing }
  | { ok: false; status: 404 | 409 | 422; error: string; moved?: Moved[] };

/** Plan the revert of one landing's paths against current trunk (`later` names the first landing that changed a path since). */
export function planRevert(paths: readonly LandedPath[], current: (path: Path) => Sha | null, later: (path: Path) => Id | null): RevertPlan {
  const moved: Moved[] = [];
  for (const p of paths) {
    const now = current(p.path);
    if (now !== p.after) moved.push({ path: p.path, now, by: later(p.path) });
  }
  if (moved.length > 0) return { ok: false, moved };
  return { ok: true, restore: paths.filter((p) => p.before !== p.after).map((p) => ({ path: p.path, blob: p.before, expect: p.after })) };
}

/** The refused paths in one line, e.g. "src/a.ts changed since by lnd_x; src/b.ts deleted since". */
export function movedText(moved: readonly Moved[], max = 5): string {
  const parts = moved.slice(0, max).map((m) => `${m.path} ${m.now === null ? "deleted" : "changed"} since${m.by ? ` by ${m.by}` : ""}`);
  if (moved.length > max) parts.push(`and ${moved.length - max} more`);
  return parts.join("; ");
}
