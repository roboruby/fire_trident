import type { Id } from "@fire_trident/core";
import type { AuditLayer, AuditVerdict, HumanDecisionRow } from "./audit.ts";
import { parseReviewView, type ReviewView } from "./review.ts";

/**
 * The audit sample's and the blind canaries' tables in the colony's SQLite (decide/audit.ts, decide/canary.ts): the
 * landings put in front of a person after they landed, with the answer each got; each confirming layer's counters for
 * the stratified sample; and the canaries put in the human queue, with how each was decided. Created on first use, only
 * ever extended additively; a colony that never landed without a person has empty tables.
 */

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS decide_audit (
    proposal_id TEXT PRIMARY KEY, landing_id TEXT NOT NULL, intent_id TEXT NOT NULL, region TEXT NOT NULL, layer TEXT NOT NULL,
    rule TEXT NOT NULL, why TEXT NOT NULL, landed_at INTEGER NOT NULL, queued_at INTEGER NOT NULL, view TEXT,
    verdict TEXT, reason TEXT, by TEXT, decided_at INTEGER, revert TEXT, revoked INTEGER NOT NULL DEFAULT 0)`,
  "CREATE INDEX IF NOT EXISTS decide_audit_by_verdict ON decide_audit(verdict, queued_at)",
  `CREATE TABLE IF NOT EXISTS decide_audit_strata (
    layer TEXT PRIMARY KEY, rate REAL NOT NULL, seen INTEGER NOT NULL DEFAULT 0, picked INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0, since INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS decide_canaries (
    intent_id TEXT PRIMARY KEY, proposal_id TEXT, cls TEXT NOT NULL, trigger TEXT, created_at INTEGER NOT NULL,
    outcome TEXT NOT NULL DEFAULT 'pending', decision TEXT, by TEXT, reason TEXT, decided_at INTEGER)`,
  "CREATE INDEX IF NOT EXISTS decide_canaries_by_proposal ON decide_canaries(proposal_id)",
];

/** One landed change in the audit queue, waiting for a person's answer or answered. */
export interface AuditRow {
  proposalId: Id;
  landingId: Id;
  intentId: Id;
  region: string;
  layer: AuditLayer;
  /** The gate's rule that landed it ("D3 innate+proof"). */
  rule: string;
  /** Why the sample took it: the first of its layer, owed to keep the layer's share, or the draw. */
  why: string;
  landedAt: number;
  queuedAt: number;
  verdict: AuditVerdict | null;
  reason: string | null;
  by: string | null;
  decidedAt: number | null;
  /** What became of the revert offered with "should not have landed": the revert's landing, or why it was refused. */
  revert: { landingId?: Id; error?: string } | null;
  /** The answer took the region's earned autonomy back. */
  revoked: boolean;
}

/** One canary put in the human queue. `outcome`: pending until a person decides it, then caught or approved; discarded when it never reached the queue. */
export interface CanaryRow {
  intentId: Id;
  proposalId: Id | null;
  cls: string;
  /** The escalation whose arrival drew it. */
  trigger: string | null;
  createdAt: number;
  outcome: "pending" | "caught" | "approved" | "discarded";
  decision: string | null;
  by: string | null;
  reason: string | null;
  decidedAt: number | null;
  /** The vaccine registry's outcome of its review: escalated once it reached the queue, error when it was discarded there. */
  review: string | null;
}

type AuditDbRow = {
  proposal_id: string;
  landing_id: string;
  intent_id: string;
  region: string;
  layer: string;
  rule: string;
  why: string;
  landed_at: number;
  queued_at: number;
  verdict: string | null;
  reason: string | null;
  by: string | null;
  decided_at: number | null;
  revert: string | null;
  revoked: number;
};

const COLUMNS = "proposal_id, landing_id, intent_id, region, layer, rule, why, landed_at, queued_at, verdict, reason, by, decided_at, revert, revoked";

function toAudit(r: AuditDbRow): AuditRow {
  let revert: AuditRow["revert"] = null;
  try {
    const v = r.revert ? (JSON.parse(r.revert) as unknown) : null;
    if (v && typeof v === "object" && !Array.isArray(v)) revert = v as AuditRow["revert"];
  } catch {
    revert = null;
  }
  return {
    proposalId: r.proposal_id,
    landingId: r.landing_id,
    intentId: r.intent_id,
    region: r.region,
    layer: r.layer as AuditLayer,
    rule: r.rule,
    why: r.why,
    landedAt: r.landed_at,
    queuedAt: r.queued_at,
    verdict: r.verdict === "fine" || r.verdict === "should-not-have-landed" ? r.verdict : null,
    reason: r.reason,
    by: r.by,
    decidedAt: r.decided_at,
    revert,
    revoked: r.revoked === 1,
  };
}

type CanaryDbRow = {
  intent_id: string;
  proposal_id: string | null;
  cls: string;
  trigger: string | null;
  created_at: number;
  outcome: string;
  decision: string | null;
  by: string | null;
  reason: string | null;
  decided_at: number | null;
  review: string | null;
};

function toCanary(r: CanaryDbRow): CanaryRow {
  const outcome = r.outcome === "caught" || r.outcome === "approved" || r.outcome === "discarded" ? r.outcome : "pending";
  return {
    intentId: r.intent_id,
    proposalId: r.proposal_id,
    cls: r.cls,
    trigger: r.trigger,
    createdAt: r.created_at,
    outcome,
    decision: r.decision,
    by: r.by,
    reason: r.reason,
    decidedAt: r.decided_at,
    review: r.review ?? null,
  };
}

/** The audit and canary tables of one colony. */
export class AuditStore {
  constructor(private readonly sql: SqlStorage) {
    for (const stmt of SCHEMA) sql.exec(stmt);
  }

  // -- the stratified sample's counters --------------------------------------------------

  /** A layer's landings and audits since its rate was set (zero when the rate changed since). */
  stratum(layer: AuditLayer, rate: number): { seen: number; picked: number } {
    const r = this.sql.exec<{ rate: number; seen: number; picked: number }>("SELECT rate, seen, picked FROM decide_audit_strata WHERE layer = ?", layer).toArray()[0];
    if (!r || Math.abs(r.rate - rate) > 1e-9) return { seen: 0, picked: 0 };
    return { seen: r.seen, picked: r.picked };
  }

  /** Count one landing of a layer (and whether it was audited); a new rate starts the layer's counts again, its total stays. */
  count(layer: AuditLayer, rate: number, picked: boolean, now: number): void {
    const was = this.stratum(layer, rate);
    this.sql.exec(
      `INSERT INTO decide_audit_strata (layer, rate, seen, picked, total, since) VALUES (?, ?, ?, ?, 1, ?)
       ON CONFLICT(layer) DO UPDATE SET rate = excluded.rate, seen = excluded.seen, picked = excluded.picked, total = decide_audit_strata.total + 1`,
      layer,
      rate,
      was.seen + 1,
      was.picked + (picked ? 1 : 0),
      now,
    );
  }

  /** Every layer's landings without a person since sampling began, and when the first was counted. */
  totals(): { seen: Record<string, number>; since: number | null } {
    const rows = this.sql.exec<{ layer: string; total: number; since: number }>("SELECT layer, total, since FROM decide_audit_strata").toArray();
    const since = rows.length > 0 ? Math.min(...rows.map((r) => r.since)) : null;
    return { seen: Object.fromEntries(rows.map((r) => [r.layer, r.total])), since };
  }

  // -- the audit queue ----------------------------------------------------------------------

  /** Put a landed change in the audit queue (once: a second call for the same proposal changes nothing). */
  add(row: Omit<AuditRow, "verdict" | "reason" | "by" | "decidedAt" | "revert" | "revoked">): boolean {
    return (
      this.sql
        .exec(
          `INSERT OR IGNORE INTO decide_audit (proposal_id, landing_id, intent_id, region, layer, rule, why, landed_at, queued_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING proposal_id`,
          row.proposalId,
          row.landingId,
          row.intentId,
          row.region,
          row.layer,
          row.rule.slice(0, 120),
          row.why,
          row.landedAt,
          row.queuedAt,
        )
        .toArray().length > 0
    );
  }

  /** One audit item. */
  get(proposalId: Id): AuditRow | null {
    const r = this.sql.exec<AuditDbRow>(`SELECT ${COLUMNS} FROM decide_audit WHERE proposal_id = ?`, proposalId).toArray()[0];
    return r ? toAudit(r) : null;
  }

  /** Items waiting for a person, oldest first. */
  pending(limit: number): AuditRow[] {
    return this.sql.exec<AuditDbRow>(`SELECT ${COLUMNS} FROM decide_audit WHERE verdict IS NULL ORDER BY queued_at ASC LIMIT ?`, limit).toArray().map(toAudit);
  }

  /** Answered items, newest first. */
  answered(limit: number): AuditRow[] {
    return this.sql.exec<AuditDbRow>(`SELECT ${COLUMNS} FROM decide_audit WHERE verdict IS NOT NULL ORDER BY decided_at DESC LIMIT ?`, limit).toArray().map(toAudit);
  }

  /** How many items each layer has with each answer (null: waiting), for the measures. */
  counts(): Array<{ layer: string; verdict: string | null; n: number }> {
    return this.sql.exec<{ layer: string; verdict: string | null; n: number }>("SELECT layer, verdict, COUNT(*) AS n FROM decide_audit GROUP BY layer, verdict").toArray();
  }

  /** The change kept for an item's card; null when none was kept (or it does not read). */
  view(proposalId: Id): ReviewView | null {
    const r = this.sql.exec<{ view: string | null }>("SELECT view FROM decide_audit WHERE proposal_id = ?", proposalId).toArray()[0];
    return parseReviewView(r?.view ?? null);
  }

  /** Whether the item still waits with no change kept for its card. */
  needsView(proposalId: Id): boolean {
    return this.sql.exec("SELECT 1 FROM decide_audit WHERE proposal_id = ? AND verdict IS NULL AND view IS NULL", proposalId).toArray().length > 0;
  }

  /** Keep the change for an item's card. */
  setView(proposalId: Id, view: ReviewView): void {
    this.sql.exec("UPDATE decide_audit SET view = ? WHERE proposal_id = ? AND verdict IS NULL", JSON.stringify(view), proposalId);
  }

  /** Record a person's answer (the card's change is dropped: the answer is kept, the diff lives in trunk). False when it was already answered. */
  answer(proposalId: Id, a: { verdict: AuditVerdict; reason: string; by: string; at: number; revoked: boolean }): boolean {
    return (
      this.sql
        .exec(
          "UPDATE decide_audit SET verdict = ?, reason = ?, by = ?, decided_at = ?, revoked = ?, view = NULL WHERE proposal_id = ? AND verdict IS NULL RETURNING proposal_id",
          a.verdict,
          a.reason.slice(0, 2_000),
          a.by.slice(0, 200),
          a.at,
          a.revoked ? 1 : 0,
          proposalId,
        )
        .toArray().length > 0
    );
  }

  /** What became of the revert an answer asked for. */
  setRevert(proposalId: Id, revert: { landingId?: Id; error?: string }): void {
    this.sql.exec("UPDATE decide_audit SET revert = ? WHERE proposal_id = ?", JSON.stringify(revert), proposalId);
  }

  // -- canaries -------------------------------------------------------------------------------

  /** Register a canary before it is proposed. */
  addCanary(intentId: Id, cls: string, trigger: string | null, now: number): void {
    this.sql.exec("INSERT OR REPLACE INTO decide_canaries (intent_id, proposal_id, cls, trigger, created_at, outcome) VALUES (?, NULL, ?, ?, ?, 'pending')", intentId, cls, trigger, now);
  }

  /** Link a canary to its proposal. */
  linkCanary(intentId: Id, proposalId: Id): void {
    this.sql.exec("UPDATE decide_canaries SET proposal_id = ? WHERE intent_id = ?", proposalId, intentId);
  }

  /** A canary that never reached the queue (it could not be proposed). */
  discardCanary(intentId: Id, reason: string): void {
    this.sql.exec("UPDATE decide_canaries SET outcome = 'discarded', reason = ? WHERE intent_id = ? AND outcome = 'pending'", reason.slice(0, 500), intentId);
  }

  /** The canary of an intent, if any. */
  canaryByIntent(intentId: Id): CanaryRow | null {
    const r = this.sql
      .exec<CanaryDbRow>("SELECT c.*, v.outcome AS review FROM decide_canaries c LEFT JOIN vaccines v ON v.intent_id = c.intent_id WHERE c.intent_id = ?", intentId)
      .toArray()[0];
    return r ? toCanary(r) : null;
  }

  /** A person decided a canary's proposal: caught (rejected or returned) or approved. False when it was already decided. */
  decideCanary(intentId: Id, d: { proposalId: Id; outcome: "caught" | "approved"; decision: string; by: string; reason: string; at: number }): boolean {
    return (
      this.sql
        .exec(
          "UPDATE decide_canaries SET outcome = ?, decision = ?, by = ?, reason = ?, decided_at = ?, proposal_id = COALESCE(proposal_id, ?) WHERE intent_id = ? AND outcome = 'pending' RETURNING intent_id",
          d.outcome,
          d.decision,
          d.by.slice(0, 200),
          d.reason.slice(0, 2_000),
          d.at,
          d.proposalId,
          intentId,
        )
        .toArray().length > 0
    );
  }

  /** Every canary, newest first (at most `limit`), with its review outcome from the vaccine registry. */
  canaries(limit = 2_000): CanaryRow[] {
    return this.sql
      .exec<CanaryDbRow>("SELECT c.*, v.outcome AS review FROM decide_canaries c LEFT JOIN vaccines v ON v.intent_id = c.intent_id ORDER BY c.created_at DESC LIMIT ?", limit)
      .toArray()
      .map(toCanary);
  }

  /** Canaries not yet decided and not discarded (being built, reviewed, or waiting in the queue). */
  openCanaries(): number {
    return this.sql
      .exec<{ n: number }>(
        "SELECT COUNT(*) AS n FROM decide_canaries c LEFT JOIN vaccines v ON v.intent_id = c.intent_id WHERE c.outcome = 'pending' AND COALESCE(v.outcome, 'pending') NOT IN ('error', 'returned', 'missed')",
      )
      .one().n;
  }

  /** Canaries created since `since`. */
  canariesSince(since: number): number {
    return this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM decide_canaries WHERE created_at > ?", since).one().n;
  }

  // -- people's decisions on escalations --------------------------------------------------------

  /** People's decisions on escalations (vaccines and canaries left out) since `since`, from the decide outcomes. */
  humanDecisions(since: number): HumanDecisionRow[] {
    return this.sql
      .exec<{ human: string; at: number }>("SELECT human, human_at AS at FROM decide_outcomes WHERE human IS NOT NULL AND human_at > ? AND vaccine = 0 ORDER BY human_at ASC LIMIT 20000", since)
      .toArray();
  }
}
