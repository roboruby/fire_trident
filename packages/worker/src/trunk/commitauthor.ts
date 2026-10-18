import type { SqlRunner } from "../colony/inline.ts";
import { parseCommitAuthorRecord, type CommitAuthorRecord } from "../colony/commitauthor.ts";

/**
 * The trunk writer's copy of its colony's commit author (colony/commitauthor.ts), kept the way the pause is
 * (trunk/pause.ts): lanes pass the record they read with their lineage context (`author`), and the newest record is kept
 * in ft_meta, so it only moves forward and a batch whose lane could not read its context still lands with the setting in
 * force. Every landing cycle reads it once (cycleAuthor): with a person named, each landing commit of the cycle is
 * authored by that person and committed by FireTrident, and its credit lines name no agent (personCredits).
 */

/** The ft_meta key of the writer's record. */
export const AUTHOR_META = "commit_author";

/** The writer's stored record; undefined when it has none. */
export function storedAuthor(sql: SqlRunner): CommitAuthorRecord | undefined {
  const row = sql.exec("SELECT value FROM ft_meta WHERE key = ?", AUTHOR_META).toArray()[0] as { value?: unknown } | undefined;
  if (typeof row?.value !== "string") return undefined;
  try {
    return parseCommitAuthorRecord(JSON.parse(row.value));
  } catch {
    return undefined;
  }
}

/** Keep `incoming` when it is newer than the stored record; returns the record in force afterwards. */
export function keepAuthor(sql: SqlRunner, incoming: CommitAuthorRecord | undefined): CommitAuthorRecord | undefined {
  const prev = storedAuthor(sql);
  if (!incoming || (prev && prev.at >= incoming.at)) return prev;
  sql.exec("INSERT OR REPLACE INTO ft_meta (key, value) VALUES (?, ?)", AUTHOR_META, JSON.stringify(incoming));
  return incoming;
}

/**
 * One cycle's commit author: the newest of the stored record and those the cycle's lanes passed (each request's
 * `author`, read as data and checked again), kept; the person when one is named, else null (FireTrident authors).
 */
export function cycleAuthor(sql: SqlRunner, ctxs: ReadonlyArray<unknown>): { name: string; email: string } | null {
  let incoming: CommitAuthorRecord | undefined;
  for (const ctx of ctxs) {
    const raw = ctx && typeof ctx === "object" ? (ctx as { author?: unknown }).author : undefined;
    const r = parseCommitAuthorRecord(raw);
    if (r && (!incoming || r.at > incoming.at)) incoming = r;
  }
  const kept = keepAuthor(sql, incoming);
  return kept && kept.name !== null ? { name: kept.name, email: kept.email } : null;
}

/** A landing commit's credit lines (trunk/credits.ts) with a person as its author: no Co-authored-by for agents. */
export function personCredits(lines: readonly string[], author: { name: string; email: string } | null): string[] {
  return author ? lines.filter((l) => !l.startsWith("Co-authored-by:")) : [...lines];
}
