/**
 * The trunk writer's copy of its colony's pauses (colony/pause.ts WriterPause), kept the way protected paths are
 * (trunk/protect.ts): the colony hands it over with TrunkDO.pause when a person pauses or resumes, and lanes pass the
 * record they read with their lineage context (`pause`); the newest record is kept, so it only moves forward. Every
 * landing cycle reads it once before it builds (cyclePause). That read is the commit point: while a pause is in force
 * every change the cycle was handed is deferred with the pause's sentence, so it stays in its lane and nothing lands
 * (lanes hold before they hand anything over; this catches a batch handed over just before the pause began).
 */
import type { SqlRunner } from "../colony/inline.ts";
import { cleanBy, cleanReason, pausedSentence, type WriterPause } from "../colony/pause.ts";

/** The ft_meta key of the writer's record. */
export const PAUSE_META = "pause";

/** A WriterPause read defensively; undefined when `raw` is not one. */
export function parseWriterPause(raw: unknown): WriterPause | undefined {
  let x: unknown = raw;
  if (typeof raw === "string") {
    try {
      x = JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  if (!x || typeof x !== "object") return undefined;
  const o = x as Record<string, unknown>;
  if (typeof o.paused !== "boolean" || typeof o.at !== "number" || !Number.isFinite(o.at)) return undefined;
  return o.paused ? { paused: true, by: cleanBy(o.by), reason: cleanReason(o.reason), at: o.at } : { paused: false, at: o.at };
}

/** The newer of two records (the later `at`; the incoming one on a tie). */
export function newerPause(prev: WriterPause | undefined, next: WriterPause | undefined): WriterPause | undefined {
  if (!next) return prev;
  if (!prev) return next;
  return next.at >= prev.at ? next : prev;
}

/** The writer's stored record; undefined when it has none. */
export function storedPause(sql: SqlRunner): WriterPause | undefined {
  const row = sql.exec("SELECT value FROM ft_meta WHERE key = ?", PAUSE_META).toArray()[0] as { value?: unknown } | undefined;
  return parseWriterPause(row?.value);
}

/**
 * Keep `record` when it is one and newer than the stored record. Returns the record in force afterwards. Storage is
 * written only when what the record says changes (a pause begins, ends, or names someone else), so the record keeps
 * the time of the latest change and an older record that a lane passes late never undoes it; a first record that
 * says nothing is paused is not stored (no record reads as no pause), so cycles of a colony never paused write nothing.
 */
export function keepPause(sql: SqlRunner, record: unknown): WriterPause | undefined {
  const prev = storedPause(sql);
  const kept = newerPause(prev, parseWriterPause(record));
  if (!kept || kept === prev) return prev;
  const same = prev ? prev.paused === kept.paused && prev.by === kept.by && prev.reason === kept.reason : !kept.paused;
  if (!same) sql.exec("INSERT OR REPLACE INTO ft_meta (key, value) VALUES (?, ?)", PAUSE_META, JSON.stringify(kept));
  return same ? (prev ?? kept) : kept;
}

/**
 * One cycle's pause check: keep the newest of the stored record and those the cycle's lanes passed (each request's
 * `pause`, read as data), and answer the sentence each change is deferred with while a pause is in force, else null.
 */
export function cyclePause(sql: SqlRunner, ctxs: ReadonlyArray<unknown>): string | null {
  let incoming: WriterPause | undefined;
  for (const ctx of ctxs) {
    const raw = ctx && typeof ctx === "object" ? (ctx as { pause?: unknown }).pause : undefined;
    incoming = newerPause(incoming, parseWriterPause(raw));
  }
  const kept = keepPause(sql, incoming);
  return kept?.paused ? pausedSentence({ by: kept.by ?? "unknown", reason: kept.reason ?? "" }) : null;
}
