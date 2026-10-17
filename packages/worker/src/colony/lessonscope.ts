import { SCOPE_LIMITS, footprintCovers, guideEntry, revalidationEnabled } from "@fire_trident/core";
import type { FileVersion, GuideEntry, GuideLesson, Id, Landing, LessonMove, LessonScope, Path } from "@fire_trident/core";
import { shortTitle } from "../agents/landed.ts";
import { errorText } from "./errors.ts";
import type { SqlRunner } from "./inline.ts";

/**
 * Lesson scopes for the field guide (FT_FIELD_GUIDE, colony/guide.ts). A lesson is one fact about some files, and files
 * change: so each lesson keeps the files its change read and wrote, each with the blob it held then (its proposal's read
 * set and write set; a text merge's own blob once it lands). Where FT_LESSON_SCOPE covers the colony too, each scoped
 * lesson's files are looked up at take in the colony's landing-paths index (`landing_paths`, which the why-context and
 * movedBy read; trunk is never asked):
 * - a file a landing other than the lesson's own changed after the lesson's blob (after its change landed, or after the
 *   lesson was recorded while its change has not landed) is named in `movedSince`, with that landing and its intent;
 * - a lesson whose every file changed since is left out of the take; one with some files still as it saw them is kept,
 *   marked, and its line in a prompt says it was written before those files changed;
 * - a lesson whose change read or wrote a file the take's intent covers ranks above the others (core takeLessons).
 * A lesson recorded before scopes has none: it is never marked or left out, and ranks as off the footprint.
 *
 * Read-only on the colony's tables (`landing_paths`, `intents`). Best effort: when they cannot be read, lessons are
 * carried unmarked, as before.
 */

/** FT_LESSON_SCOPE: whether takes use lesson scopes here: "on", or a comma-separated list of colony ids; off when absent. */
export function lessonScopesEnabled(setting: string | undefined, colonyId: Id): boolean {
  return revalidationEnabled(setting, colonyId);
}

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
/** Control and format characters never belong in a path a prompt shows. */
const HIDDEN = /[\p{Cc}\p{Cf}]/u;
/** Longest path a scope keeps. */
const MAX_PATH = 1_000;

/** One file version as a scope keeps it, or null when it is not one (a path a prompt could not show, or a blob that is not a git id). */
function version(x: unknown): FileVersion | null {
  if (!x || typeof x !== "object") return null;
  const v = x as { path?: unknown; blob?: unknown };
  if (typeof v.path !== "string" || v.path === "" || v.path.length > MAX_PATH || HIDDEN.test(v.path)) return null;
  if (v.blob !== null && (typeof v.blob !== "string" || !SHA.test(v.blob))) return null;
  return { path: v.path, blob: v.blob };
}

/**
 * A lesson's scope from its proposal's read set and write set: each file once (a file read and written counts as
 * written), written first, at most SCOPE_LIMITS.paths with `more` counting the rest. Undefined when they name no file.
 */
export function lessonScope(p: { readSet?: unknown; writeSet?: unknown }): LessonScope | undefined {
  const writes = new Map<Path, FileVersion>();
  const reads = new Map<Path, FileVersion>();
  for (const raw of Array.isArray(p?.writeSet) ? p.writeSet : []) {
    const v = version(raw);
    if (v) writes.set(v.path, v);
  }
  for (const raw of Array.isArray(p?.readSet) ? p.readSet : []) {
    const v = version(raw);
    if (v && !writes.has(v.path) && !reads.has(v.path)) reads.set(v.path, v);
  }
  const total = writes.size + reads.size;
  if (total === 0) return undefined;
  const w = [...writes.values()].slice(0, SCOPE_LIMITS.paths);
  const r = [...reads.values()].slice(0, SCOPE_LIMITS.paths - w.length);
  const more = total - w.length - r.length;
  return { reads: r, writes: w, ...(more > 0 ? { more } : {}) };
}

/** A scope once its change landed: a file a text merge landed carries the merge's blob in place of the one the proposal wrote. */
export function landedScope(scope: LessonScope, merged: Landing["merged"], proposalId: Id): LessonScope {
  const own = new Map((Array.isArray(merged) ? merged : []).filter((m) => m?.proposalId === proposalId && typeof m.blob === "string" && SHA.test(m.blob)).map((m) => [m.path, m.blob]));
  if (own.size === 0) return scope;
  return { ...scope, writes: scope.writes.map((w) => (own.has(w.path) ? { path: w.path, blob: own.get(w.path)! } : w)) };
}

/** Every file of a scope, written first (an older or malformed scope has none). */
export function scopePaths(scope: LessonScope | undefined): Path[] {
  if (!scope || typeof scope !== "object") return [];
  const list = [...(Array.isArray(scope.writes) ? scope.writes : []), ...(Array.isArray(scope.reads) ? scope.reads : [])];
  return [...new Set(list.flatMap((v) => (typeof v?.path === "string" && v.path !== "" ? [v.path] : [])))];
}

/** Whether a scope reads or writes a file one of these footprint entries covers (an exact path, a directory or a glob). */
export function scopeOnFootprint(scope: LessonScope | undefined, footprint: readonly string[]): boolean {
  const entries = (Array.isArray(footprint) ? footprint : []).filter((e): e is string => typeof e === "string" && e !== "");
  return entries.length > 0 && scopePaths(scope).some((p) => entries.some((e) => footprintCovers(e, p)));
}

/** When the lesson's blobs were trunk's: when its change landed, or when it was recorded while the change has not landed. */
function since(l: GuideLesson): number {
  return typeof l.landedAt === "number" && Number.isFinite(l.landedAt) ? l.landedAt : l.createdAt;
}

/**
 * For each scoped lesson, the files that changed after its blobs, newest first: for each file, the newest row of the
 * landing-paths index at or after `since` from a landing other than the lesson's own, with that landing's intent and
 * its title. One query for the files of all lessons, one for the titles. Lessons with nothing moved are absent.
 */
export function lessonMoves(sql: SqlRunner, lessons: readonly GuideLesson[]): Map<Id, LessonMove[]> {
  const out = new Map<Id, LessonMove[]>();
  const scoped = lessons.map((l) => ({ l, paths: scopePaths(l.scope) })).filter((x) => x.paths.length > 0);
  const wanted = [...new Set(scoped.flatMap((x) => x.paths))];
  if (wanted.length === 0) return out;
  const byPath = new Map<Path, Array<{ at: number; landingId: Id; intentId: Id | null }>>();
  try {
    const rows = sql
      .exec("SELECT path, at, landing_id, intent_id FROM landing_paths WHERE path IN (SELECT value FROM json_each(?)) ORDER BY at DESC, landing_id DESC", JSON.stringify(wanted))
      .toArray() as Array<{ path: string; at: number; landing_id: string; intent_id: string | null }>;
    for (const r of rows) {
      const list = byPath.get(r.path) ?? [];
      list.push({ at: r.at, landingId: r.landing_id, intentId: r.intent_id });
      byPath.set(r.path, list);
    }
  } catch (err) {
    console.warn(`field guide: landing paths not read for lesson scopes: ${errorText(err)}`);
    return out;
  }
  for (const { l, paths } of scoped) {
    const from = since(l);
    const moves: LessonMove[] = [];
    for (const path of paths) {
      const hit = (byPath.get(path) ?? []).find((r) => r.at >= from && r.landingId !== l.landingId);
      if (hit) moves.push({ path, landingId: hit.landingId, at: hit.at, ...(hit.intentId ? { intentId: hit.intentId } : {}) });
    }
    if (moves.length > 0) out.set(l.id, moves.sort((a, b) => b.at - a.at || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)));
  }
  const titles = intentTitles(sql, [...out.values()].flatMap((m) => m.flatMap((x) => (x.intentId ? [x.intentId] : []))));
  for (const moves of out.values()) {
    for (const m of moves) {
      const title = m.intentId ? titles.get(m.intentId) : undefined;
      if (title) m.title = title;
    }
  }
  return out;
}

/** The short titles of these intents (none when the table cannot be read). */
function intentTitles(sql: SqlRunner, ids: readonly Id[]): Map<Id, string> {
  const want = [...new Set(ids)];
  if (want.length === 0) return new Map();
  try {
    const rows = sql.exec("SELECT id, title FROM intents WHERE id IN (SELECT value FROM json_each(?))", JSON.stringify(want)).toArray() as Array<{ id: string; title: string | null }>;
    return new Map(rows.flatMap((r) => (shortTitle(r.title) ? [[r.id, shortTitle(r.title)] as const] : [])));
  } catch {
    return new Map();
  }
}

/**
 * The active lessons as a take for an intent with this footprint carries them, before the take's cap (core
 * takeLessons ranks and cuts them): each entry marked `onFootprint` when its change read or wrote a file the footprint
 * covers, and with `movedSince` when files of its scope changed after it was written; a lesson whose every file changed
 * since (its whole scope known) is left out. Lessons without a scope are carried as before.
 */
export function scopedEntries(sql: SqlRunner, lessons: readonly GuideLesson[], footprint: readonly string[]): GuideEntry[] {
  const moves = lessonMoves(sql, lessons);
  const out: GuideEntry[] = [];
  for (const l of lessons) {
    const entry = guideEntry(l);
    const moved = moves.get(l.id);
    if (moved) {
      const whole = !(typeof l.scope?.more === "number" && l.scope.more > 0);
      if (whole && moved.length >= scopePaths(l.scope).length) continue;
      entry.movedSince = moved;
    }
    if (scopeOnFootprint(l.scope, footprint)) entry.onFootprint = true;
    out.push(entry);
  }
  return out;
}
