import type { Id } from "@fire_trident/core";

/**
 * Decision codes spent in a colony (the review endpoint, mcp/review/codes.ts): a person's click in the review view
 * carries a code that decides one change once. The colony keeps each spent code until it expires, in its own table,
 * created on first use (an older colony has none and loses nothing). Spending is one synchronous step in the colony's
 * Durable Object, so two requests with one code cannot both pass.
 */

/** The SQL this runs (a Durable Object's storage, or node:sqlite in unit tests). */
export interface ReviewCodeSql {
  exec(query: string, ...bindings: unknown[]): { toArray(): unknown[] };
}

/**
 * Spend one decision code for a change: true the first time, false when it was spent before, or when a code issued no
 * later for the same change was spent (a decision voids every older code for that change, so a code from a card opened
 * before the decision cannot decide the change again if it comes back to a person). Expired codes are dropped first;
 * a code that is still valid always outlives the record that voids it.
 */
export function spendReviewCode(sql: ReviewCodeSql, nonce: string, proposalId: Id, expiresAt: number, now: number): boolean {
  sql.exec("CREATE TABLE IF NOT EXISTS review_codes (nonce TEXT PRIMARY KEY, proposal_id TEXT NOT NULL, expires_at INTEGER NOT NULL)");
  sql.exec("DELETE FROM review_codes WHERE expires_at < ?", now);
  if (sql.exec("SELECT 1 AS x FROM review_codes WHERE nonce = ? OR (proposal_id = ? AND expires_at >= ?) LIMIT 1", nonce, proposalId, expiresAt).toArray().length > 0) return false;
  sql.exec("INSERT INTO review_codes (nonce, proposal_id, expires_at) VALUES (?, ?, ?)", nonce, proposalId, expiresAt);
  return true;
}
