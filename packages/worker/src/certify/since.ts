import type { Id, Path } from "@fire_trident/core";
import { WHY_PATHS, shortTitle, shortWhy, type LandedWhy } from "../agents/landed.ts";
import { recordedLanding } from "../trunk/derived.ts";
import { GREEN_SLACK_MS, type SinceGreen } from "./culprit.ts";

/**
 * Culprit finding's first landing since green (culprit.ts). The colony's per-path landing index keeps
 * only the newest few landings of each path, so when several landings changed a failing test's files
 * since the last green commit, the first of them (often the one that broke it: every later one landed
 * on a trunk that may already have been red) is no longer there. It is read from the colony's landing
 * log instead (the `landings` table, which keeps the newest landings): the oldest landings at or after
 * the green commit's landing time that changed any of the paths, one entry per landing and intent, in
 * the shape the index's lookup answers (ColonyDO.suspectLandings adds the proposal and what it wrote).
 * Nothing when the log may no longer hold every landing since then. Read only, a few queries.
 */

/** Landings (one entry per landing and intent) answered at most: a few, since the oldest can still turn out to be the green commit's own or older. */
export const SINCE_LANDINGS = 4;
/** Paths asked about at most (culprit finding asks for one failing file's changed closure). */
const SINCE_PATHS = 256;

/**
 * Does the landing log still hold every landing since `since`? It does when it holds the green
 * commit's landing, when it holds one received before then (the log is trimmed oldest first), or when
 * it has fewer rows than it keeps (never trimmed).
 */
export function logHoldsSince(sql: SqlStorage, since: SinceGreen, keep: number): boolean {
  if (since.landingId && sql.exec("SELECT 1 AS x FROM landings WHERE id = ?", since.landingId).toArray().length > 0) return true;
  if (sql.exec("SELECT 1 AS x FROM landings WHERE received_at < ? LIMIT 1", since.at - GREEN_SLACK_MS).toArray().length > 0) return true;
  return sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM landings").one().n < keep;
}

/**
 * The oldest landings at or after `since.at` that changed any of `paths`, oldest first, at most
 * `limit` entries: one per landing and intent (the intent of the proposal that wrote each path, else
 * the landing's only intent), each with the paths it changed among those asked (sorted, at most
 * WHY_PATHS) and its intent's title and why. `keep` is how many landings the log keeps.
 */
export function landedSince(sql: SqlStorage, paths: readonly Path[], since: SinceGreen, keep: number, limit = SINCE_LANDINGS): LandedWhy[] {
  const want = [...new Set(paths.filter((p) => typeof p === "string" && p !== ""))].slice(0, SINCE_PATHS);
  if (want.length === 0 || !since || !Number.isFinite(since.at) || limit <= 0) return [];
  if (!logHoldsSince(sql, since, keep)) return [];
  const asked = JSON.stringify(want);
  // received_at is indexed and never much earlier than a landing's own time (taken before its push).
  const rows = sql
    .exec<{ id: string; at: number; trunk_sha: string; data: string }>(
      `SELECT id, at, trunk_sha, data FROM landings
        WHERE received_at >= ? AND at >= ?
          AND EXISTS (SELECT 1 FROM json_each(landings.data, '$.paths') j WHERE j.value IN (SELECT value FROM json_each(?)))
        ORDER BY at, rowid LIMIT ?`,
      since.at - GREEN_SLACK_MS,
      since.at,
      asked,
      limit,
    )
    .toArray();
  if (rows.length === 0) return [];
  // Who wrote each asked path in those landings: the intent of the landed proposal that wrote it.
  const writers = new Map<string, Id>();
  for (const w of sql
    .exec<{ landing_id: string; intent_id: string; path: string | null }>(
      `SELECT l.id AS landing_id, p.intent_id AS intent_id, json_extract(w.value, '$.path') AS path
         FROM landings l JOIN json_each(l.data, '$.proposalIds') j JOIN proposals p ON p.id = j.value JOIN json_each(p.data, '$.writeSet') w
        WHERE l.id IN (SELECT value FROM json_each(?)) AND json_extract(w.value, '$.path') IN (SELECT value FROM json_each(?))`,
      JSON.stringify(rows.map((r) => r.id)),
      asked,
    )
    .toArray()) {
    if (w.path) writers.set(`${w.landing_id}\u0000${w.path}`, w.intent_id);
  }
  const asks = new Set(want);
  const out: Array<Omit<LandedWhy, "title" | "why">> = [];
  for (const r of rows) {
    const l = recordedLanding({ id: r.id, data: r.data, at: r.at, trunk_sha: r.trunk_sha });
    // A commit whose proposals this colony does not know: its one intent, if it names one (as the path index does).
    const single = l.intentIds.length === 1 ? (l.intentIds[0] ?? null) : null;
    const groups = new Map<string, Path[]>();
    for (const path of l.paths) {
      if (!asks.has(path)) continue;
      const intent = writers.get(`${r.id}\u0000${path}`) ?? single ?? "";
      const g = groups.get(intent);
      if (g) g.push(path);
      else groups.set(intent, [path]);
    }
    for (const [intent, changed] of groups) {
      const e: Omit<LandedWhy, "title" | "why"> = { landingId: r.id, at: r.at, paths: [...new Set(changed)].sort().slice(0, WHY_PATHS) };
      if (r.trunk_sha) e.trunkSha = r.trunk_sha;
      if (intent) e.intentId = intent;
      out.push(e);
    }
  }
  const picked = out.slice(0, limit);
  const ids = [...new Set(picked.flatMap((e) => (e.intentId ? [e.intentId] : [])))];
  const texts = new Map(
    ids.length === 0
      ? []
      : sql
          .exec<{ id: string; title: string; why: string }>("SELECT id, title, why FROM intents WHERE id IN (SELECT value FROM json_each(?))", JSON.stringify(ids))
          .toArray()
          .map((t) => [t.id, t] as const),
  );
  return picked.map((e) => {
    const t = e.intentId ? texts.get(e.intentId) : undefined;
    return { ...e, title: shortTitle(t?.title), why: shortWhy(t?.why) };
  });
}
