import type { Antibody, Id, Path } from "@fire_trident/core";
import { antibodyAllows, antibodyMatches } from "./antibodies.ts";
import type { DangerClass } from "./danger.ts";
import type { DecidePolicy, DetectorState } from "./policy.ts";
import { DEFAULT_POLICY, mergePolicy, probationState } from "./policy.ts";
import { parseReviewView, type ReviewView } from "./review.ts";
import type { VaccineOutcome } from "./vaccine.ts";

/**
 * The Decide prong's tables in the colony's SQLite: policy, per-proposal outcomes (for the alert
 * budget, earned autonomy and the review order), antibodies (with the recurrences they caught),
 * detector probation, autonomy revocations, the vaccine registry, what a person sees of each
 * escalated proposal, and the intents a security finding put on probation. Synchronous; created
 * on first use, and only ever extended additively.
 */

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS decide_policy (k TEXT PRIMARY KEY, v TEXT NOT NULL)",
  `CREATE TABLE IF NOT EXISTS decide_outcomes (
    proposal_id TEXT PRIMARY KEY, region TEXT NOT NULL, head TEXT NOT NULL, layer TEXT NOT NULL, action TEXT NOT NULL,
    risk REAL NOT NULL DEFAULT 0, detectors TEXT NOT NULL DEFAULT '[]', vaccine INTEGER NOT NULL DEFAULT 0, state TEXT, at INTEGER NOT NULL,
    human TEXT, human_at INTEGER)`,
  "CREATE INDEX IF NOT EXISTS decide_outcomes_by_action ON decide_outcomes(action, at)",
  "CREATE INDEX IF NOT EXISTS decide_outcomes_by_region ON decide_outcomes(region, at)",
  `CREATE TABLE IF NOT EXISTS antibodies (
    id TEXT PRIMARY KEY, data TEXT NOT NULL, state TEXT NOT NULL, minted_state TEXT NOT NULL DEFAULT 'active', path TEXT, landing_id TEXT,
    created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS detectors (
    id TEXT PRIMARY KEY, fires INTEGER NOT NULL DEFAULT 0, useful INTEGER NOT NULL DEFAULT 0, not_useful INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'active', updated_at INTEGER NOT NULL)`,
  "CREATE TABLE IF NOT EXISTS autonomy_revocations (region TEXT PRIMARY KEY, at INTEGER NOT NULL, reason TEXT NOT NULL)",
  `CREATE TABLE IF NOT EXISTS vaccines (
    intent_id TEXT PRIMARY KEY, proposal_id TEXT, cls TEXT NOT NULL, batch TEXT NOT NULL, created_at INTEGER NOT NULL,
    outcome TEXT NOT NULL DEFAULT 'pending', layer TEXT, reason TEXT, decided_at INTEGER)`,
  "CREATE INDEX IF NOT EXISTS vaccines_by_proposal ON vaccines(proposal_id)",
  "CREATE TABLE IF NOT EXISTS decide_review (proposal_id TEXT PRIMARY KEY, view TEXT NOT NULL, at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS decide_intents (intent_id TEXT PRIMARY KEY, security_findings INTEGER NOT NULL DEFAULT 0, classes TEXT NOT NULL DEFAULT '[]', at INTEGER NOT NULL)",
];

/** Columns added to tables that already exist in production (added only when missing). */
const COLUMNS: ReadonlyArray<readonly [table: string, column: string, decl: string]> = [
  ["antibodies", "recurrences", "INTEGER NOT NULL DEFAULT 0"],
  ["antibodies", "last_recurrence", "TEXT"],
];

/** Outcome rows kept with their compact reflex state (older ones drop the state). */
const KEEP_STATES = 2_000;
/** Review views kept for proposals a person already decided (waiting ones are always kept). */
const KEEP_REVIEWS = 500;

/** The standard Clef detectors. */
export const CLEF_DETECTORS = ["clef:needs_human", "clef:touches_sensitive", "clef:off_intent"] as const;

/** One detector's probation record. */
export interface DetectorStats {
  id: string;
  fires: number;
  useful: number;
  notUseful: number;
  state: DetectorState;
}

/** An antibody with its lifecycle state, where it lives in trunk, and the rejections it caught again. */
export interface StoredAntibody {
  antibody: Antibody;
  state: DetectorState;
  path: string | null;
  landingId: string | null;
  /** Rejected proposals it had already caught (counted instead of minting a near-copy). */
  recurrences: number;
  /** The latest of those proposals. */
  lastRecurrence: string | null;
}

/** Why an intent is on probation: its security findings (returns and escalations) and their classes. */
export interface SecurityProbation {
  findings: number;
  classes: string[];
  at: number;
}

type AntibodyDbRow = { data: string; state: string; path: string | null; landing_id: string | null; recurrences: number | null; last_recurrence: string | null };

function toStored(r: AntibodyDbRow): StoredAntibody {
  return {
    antibody: JSON.parse(r.data) as Antibody,
    state: asState(r.state),
    path: r.path,
    landingId: r.landing_id,
    recurrences: typeof r.recurrences === "number" ? r.recurrences : 0,
    lastRecurrence: r.last_recurrence ?? null,
  };
}

/** One vaccine registry row. */
export interface VaccineRow {
  intentId: Id;
  proposalId: Id | null;
  cls: string;
  batch: string;
  createdAt: number;
  outcome: VaccineOutcome;
  layer: string | null;
  reason: string | null;
  decidedAt: number | null;
}

/** What the decide pipeline recorded about one proposal. */
export interface OutcomeRow {
  proposalId: Id;
  region: string;
  head: string;
  layer: string;
  action: string;
  risk: number;
  detectors: string[];
  vaccine: boolean;
  state: string | null;
  at: number;
}

/** The decide tables of one colony. */
export class DecideStore {
  constructor(private readonly sql: SqlStorage) {
    for (const stmt of SCHEMA) sql.exec(stmt);
    for (const [table, column, decl] of COLUMNS) {
      const has = sql.exec<{ name: string }>(`PRAGMA table_info(${table})`).toArray().some((c) => c.name === column);
      if (!has) sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
    }
  }

  // -- policy ---------------------------------------------------------------

  /** The colony's policy (defaults merged with what was set). */
  policy(): DecidePolicy {
    const row = this.sql.exec<{ v: string }>("SELECT v FROM decide_policy WHERE k = 'policy'").toArray()[0];
    if (!row) return DEFAULT_POLICY;
    try {
      return mergePolicy(DEFAULT_POLICY, JSON.parse(row.v));
    } catch {
      return DEFAULT_POLICY;
    }
  }

  /**
   * Apply a partial policy; returns the result. Only the keys ever set are stored, so a colony
   * keeps following the defaults for everything it did not override.
   */
  setPolicy(patch: unknown): DecidePolicy {
    const row = this.sql.exec<{ v: string }>("SELECT v FROM decide_policy WHERE k = 'policy'").toArray()[0];
    let stored: Record<string, unknown> = {};
    try {
      stored = row ? (JSON.parse(row.v) as Record<string, unknown>) : {};
    } catch {
      stored = {};
    }
    const next: Record<string, unknown> = { ...stored };
    if (patch && typeof patch === "object") {
      const known = new Set(Object.keys(DEFAULT_POLICY));
      for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
        if (!known.has(k)) continue;
        next[k] = k === "probation" && v && typeof v === "object" ? { ...((stored.probation as object | undefined) ?? {}), ...(v as object) } : v;
      }
    }
    this.sql.exec("INSERT INTO decide_policy (k, v) VALUES ('policy', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", JSON.stringify(next));
    return mergePolicy(DEFAULT_POLICY, next);
  }

  /** A small key-value slot (vaccine agent id, sync markers). */
  meta(key: string): string | null {
    return this.sql.exec<{ v: string }>("SELECT v FROM decide_policy WHERE k = ?", `meta:${key}`).toArray()[0]?.v ?? null;
  }

  /** Set a key-value slot. */
  setMeta(key: string, value: string): void {
    this.sql.exec("INSERT INTO decide_policy (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", `meta:${key}`, value);
  }

  // -- outcomes ---------------------------------------------------------------

  /** Record (or replace) what the pipeline or a human decided for a proposal. */
  recordOutcome(o: OutcomeRow): void {
    this.sql.exec(
      `INSERT INTO decide_outcomes (proposal_id, region, head, layer, action, risk, detectors, vaccine, state, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(proposal_id) DO UPDATE SET region = excluded.region, head = excluded.head, layer = excluded.layer, action = excluded.action,
         risk = excluded.risk, detectors = excluded.detectors, vaccine = excluded.vaccine, state = COALESCE(excluded.state, decide_outcomes.state), at = excluded.at`,
      o.proposalId,
      o.region,
      o.head,
      o.layer,
      o.action,
      Number.isFinite(o.risk) ? o.risk : 0,
      JSON.stringify(o.detectors),
      o.vaccine ? 1 : 0,
      o.state,
      o.at,
    );
    this.sql.exec(
      "UPDATE decide_outcomes SET state = NULL WHERE state IS NOT NULL AND proposal_id IN (SELECT proposal_id FROM decide_outcomes WHERE state IS NOT NULL ORDER BY at DESC LIMIT -1 OFFSET ?)",
      KEEP_STATES,
    );
  }

  /** The recorded outcome of a proposal. */
  outcome(proposalId: Id): OutcomeRow | null {
    const r = this.sql
      .exec<{ proposal_id: string; region: string; head: string; layer: string; action: string; risk: number; detectors: string; vaccine: number; state: string | null; at: number }>(
        "SELECT * FROM decide_outcomes WHERE proposal_id = ?",
        proposalId,
      )
      .toArray()[0];
    if (!r) return null;
    return { proposalId: r.proposal_id, region: r.region, head: r.head, layer: r.layer, action: r.action, risk: r.risk, detectors: parseList(r.detectors), vaccine: r.vaccine === 1, state: r.state, at: r.at };
  }

  /** A human decision on a proposal (kept beside what the pipeline decided). */
  recordHuman(proposalId: Id, region: string, head: string, action: "approve" | "reject" | "return", at: number): void {
    this.sql.exec(
      `INSERT INTO decide_outcomes (proposal_id, region, head, layer, action, risk, detectors, vaccine, state, at, human, human_at) VALUES (?, ?, ?, 'human', 'none', 0, '[]', 0, NULL, ?, ?, ?)
       ON CONFLICT(proposal_id) DO UPDATE SET human = excluded.human, human_at = excluded.human_at`,
      proposalId,
      region,
      head,
      at,
      action,
      at,
    );
  }

  /** Human escalations (vaccines excluded) since `since`. */
  escalationsSince(since: number): number {
    return this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM decide_outcomes WHERE action = 'escalate' AND vaccine = 0 AND at > ?", since).one().n;
  }

  /** Decisions per layer and action (vaccines included), for metrics. */
  tally(): Array<{ layer: string; action: string; n: number }> {
    return this.sql.exec<{ layer: string; action: string; n: number }>("SELECT layer, action, COUNT(*) AS n FROM decide_outcomes GROUP BY layer, action").toArray();
  }

  // -- autonomy -----------------------------------------------------------------

  /** Revoke a region's earned autonomy (a rejection or an escalation there). */
  revokeAutonomy(region: string, reason: string, at: number): void {
    this.sql.exec("INSERT INTO autonomy_revocations (region, at, reason) VALUES (?, ?, ?) ON CONFLICT(region) DO UPDATE SET at = excluded.at, reason = excluded.reason", region, at, reason);
  }

  /**
   * Approved landings in a region since its last revocation: proposals a deterministic proof,
   * System 2 or a human approved that then landed. Reads the colony's proposals table.
   */
  approvedLandings(region: string): number {
    const since = this.sql.exec<{ at: number }>("SELECT at FROM autonomy_revocations WHERE region = ?", region).toArray()[0]?.at ?? 0;
    return this.sql
      .exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM decide_outcomes d JOIN proposals p ON p.id = d.proposal_id
         WHERE d.region = ? AND d.vaccine = 0 AND p.status = 'landed' AND COALESCE(d.human_at, d.at) > ?
           AND ((d.layer IN ('llm', 'deterministic') AND d.action = 'land') OR d.human = 'approve')`,
        region,
        since,
      )
      .one().n;
  }

  /**
   * Regions with their approved landings and last revocation, and when each last moved (its latest decision, a
   * person's included, or its revocation), so readers can list the latest first.
   */
  autonomyTable(threshold: number): Array<{ region: string; approved: number; earned: boolean; revokedAt: number | null; reason: string | null; lastAt: number | null }> {
    const regions = this.sql
      .exec<{ region: string }>("SELECT DISTINCT region FROM decide_outcomes WHERE vaccine = 0 UNION SELECT region FROM autonomy_revocations")
      .toArray()
      .map((r) => r.region);
    // Every region's latest decision in one read (vaccines left out, as above).
    const latest = new Map(
      this.sql
        .exec<{ region: string; at: number | null }>("SELECT region, MAX(MAX(at, COALESCE(human_at, 0))) AS at FROM decide_outcomes WHERE vaccine = 0 GROUP BY region")
        .toArray()
        .map((r) => [r.region, r.at ?? 0]),
    );
    return regions
      .map((region) => {
        const rev = this.sql.exec<{ at: number; reason: string }>("SELECT at, reason FROM autonomy_revocations WHERE region = ?", region).toArray()[0];
        const approved = this.approvedLandings(region);
        const lastAt = Math.max(latest.get(region) ?? 0, rev?.at ?? 0);
        return { region, approved, earned: approved >= threshold, revokedAt: rev?.at ?? null, reason: rev?.reason ?? null, lastAt: lastAt > 0 ? lastAt : null };
      })
      .sort((a, b) => b.approved - a.approved || a.region.localeCompare(b.region));
  }

  // -- detectors ------------------------------------------------------------------

  /** Probation records (all, or the given ids). */
  detectors(ids?: readonly string[]): DetectorStats[] {
    const rows = this.sql.exec<{ id: string; fires: number; useful: number; not_useful: number; state: string }>("SELECT * FROM detectors ORDER BY id").toArray();
    const out = rows.map((r) => ({ id: r.id, fires: r.fires, useful: r.useful, notUseful: r.not_useful, state: asState(r.state) }));
    return ids ? out.filter((d) => ids.includes(d.id)) : out;
  }

  /** State of each standard Clef detector. */
  clefStates(): Record<string, DetectorState> {
    const out: Record<string, DetectorState> = {};
    for (const d of this.detectors(CLEF_DETECTORS)) out[d.id] = d.state;
    return out;
  }

  /** Count fires and human verdicts, then re-apply probation. Returns the new state. */
  markDetector(id: string, delta: { fires?: number; useful?: number; notUseful?: number }, probation: DecidePolicy["probation"], now: number): DetectorState {
    this.sql.exec(
      `INSERT INTO detectors (id, fires, useful, not_useful, state, updated_at) VALUES (?, ?, ?, ?, 'active', ?)
       ON CONFLICT(id) DO UPDATE SET fires = fires + excluded.fires, useful = useful + excluded.useful, not_useful = not_useful + excluded.not_useful, updated_at = excluded.updated_at`,
      id,
      delta.fires ?? 0,
      delta.useful ?? 0,
      delta.notUseful ?? 0,
      now,
    );
    const r = this.sql.exec<{ fires: number; not_useful: number }>("SELECT fires, not_useful FROM detectors WHERE id = ?", id).one();
    const state = probationState(r.fires, r.not_useful, probation);
    this.sql.exec("UPDATE detectors SET state = ? WHERE id = ?", state, id);
    if (!id.startsWith("antibody:")) return state;
    const abId = id.slice("antibody:".length);
    const row = this.sql.exec<{ data: string; minted_state: string }>("SELECT data, minted_state FROM antibodies WHERE id = ?", abId).toArray()[0];
    if (!row) return state;
    const stored = JSON.parse(row.data) as Antibody;
    const ab = { ...stored, hits: stored.hits + (delta.fires ?? 0), falsePositives: stored.falsePositives + (delta.notUseful ?? 0) };
    // Probation can only make an antibody quieter than it was minted.
    const final = worse(asState(row.minted_state), state);
    this.sql.exec("UPDATE antibodies SET data = ?, state = ? WHERE id = ?", JSON.stringify(ab), final, abId);
    return final;
  }

  // -- antibodies -------------------------------------------------------------------

  /** Store a new antibody (or replace one with the same id). */
  putAntibody(ab: Antibody, state: DetectorState, where: { path?: string | null; landingId?: string | null } = {}): void {
    this.sql.exec(
      `INSERT INTO antibodies (id, data, state, minted_state, path, landing_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET data = excluded.data, state = excluded.state, minted_state = excluded.minted_state,
         path = COALESCE(excluded.path, antibodies.path), landing_id = COALESCE(excluded.landing_id, antibodies.landing_id)`,
      ab.id,
      JSON.stringify(ab),
      state,
      state,
      where.path ?? null,
      where.landingId ?? null,
      ab.createdAt,
    );
    this.sql.exec("INSERT OR IGNORE INTO detectors (id, fires, useful, not_useful, state, updated_at) VALUES (?, 0, 0, 0, ?, ?)", `antibody:${ab.id}`, state, ab.createdAt);
  }

  /** Where an antibody landed in trunk. */
  setAntibodyLanding(id: string, path: string, landingId: string): void {
    this.sql.exec("UPDATE antibodies SET path = ?, landing_id = ? WHERE id = ?", path, landingId, id);
  }

  /** One antibody. */
  antibody(id: string): StoredAntibody | null {
    const r = this.sql.exec<AntibodyDbRow>("SELECT data, state, path, landing_id, recurrences, last_recurrence FROM antibodies WHERE id = ?", id).toArray()[0];
    return r ? toStored(r) : null;
  }

  /** Every antibody, newest first. */
  antibodies(): StoredAntibody[] {
    return this.sql.exec<AntibodyDbRow>("SELECT data, state, path, landing_id, recurrences, last_recurrence FROM antibodies ORDER BY created_at DESC").toArray().map(toStored);
  }

  /** A person rejected a proposal this antibody had already caught: count the recurrence on it. */
  recordRecurrence(id: string, proposalId: Id): void {
    this.sql.exec("UPDATE antibodies SET recurrences = COALESCE(recurrences, 0) + 1, last_recurrence = ? WHERE id = ?", proposalId, id);
  }

  /** Antibodies (not off) whose matcher applies to this change, newest first, at most `limit`. */
  matchingAntibodies(paths: readonly Path[], addedLines: readonly string[], limit: number): Array<StoredAntibody & { state: Exclude<DetectorState, "off"> }> {
    if (limit <= 0) return [];
    const out: Array<StoredAntibody & { state: Exclude<DetectorState, "off"> }> = [];
    for (const s of this.antibodies()) {
      if (s.state === "off" || antibodyAllows(s.antibody).length > 0) continue;
      if (!antibodyMatches(s.antibody, paths, addedLines)) continue;
      out.push(s as StoredAntibody & { state: Exclude<DetectorState, "off"> });
      if (out.length >= limit) break;
    }
    return out;
  }

  /** Tolerating antibodies (`allows`) whose matcher applies to this change. */
  allowingAntibodies(paths: readonly Path[], addedLines: readonly string[]): Array<{ id: string; allows: DangerClass[]; paths: string[] }> {
    const out: Array<{ id: string; allows: DangerClass[]; paths: string[] }> = [];
    for (const s of this.antibodies()) {
      const allows = antibodyAllows(s.antibody);
      if (s.state === "off" || allows.length === 0 || !antibodyMatches(s.antibody, paths, addedLines)) continue;
      out.push({ id: s.antibody.id, allows, paths: s.antibody.matcher.paths });
    }
    return out;
  }

  // -- vaccines ---------------------------------------------------------------------

  /** Register a sealed vaccine before it is proposed. */
  registerVaccine(intentId: Id, cls: string, batch: string, now: number): void {
    this.sql.exec("INSERT OR REPLACE INTO vaccines (intent_id, proposal_id, cls, batch, created_at, outcome) VALUES (?, NULL, ?, ?, ?, 'pending')", intentId, cls, batch, now);
  }

  /** Link a vaccine to its proposal. */
  linkVaccine(intentId: Id, proposalId: Id): void {
    this.sql.exec("UPDATE vaccines SET proposal_id = ? WHERE intent_id = ?", proposalId, intentId);
  }

  /** The vaccine registered for an intent, if any. */
  vaccineByIntent(intentId: Id): VaccineRow | null {
    const r = this.sql.exec<VaccineDbRow>("SELECT * FROM vaccines WHERE intent_id = ?", intentId).toArray()[0];
    return r ? toVaccine(r) : null;
  }

  /** The vaccine behind a proposal, if any. */
  vaccineByProposal(proposalId: Id): VaccineRow | null {
    const r = this.sql.exec<VaccineDbRow>("SELECT * FROM vaccines WHERE proposal_id = ?", proposalId).toArray()[0];
    return r ? toVaccine(r) : null;
  }

  /** Settle a vaccine's outcome. */
  settleVaccine(intentId: Id, outcome: VaccineOutcome, layer: string | null, reason: string, now: number): void {
    this.sql.exec("UPDATE vaccines SET outcome = ?, layer = ?, reason = ?, decided_at = ? WHERE intent_id = ?", outcome, layer, reason.slice(0, 1_000), now, intentId);
  }

  /** Every vaccine, newest first (at most `limit`). */
  vaccines(limit = 5_000): VaccineRow[] {
    return this.sql.exec<VaccineDbRow>("SELECT * FROM vaccines ORDER BY created_at DESC LIMIT ?", limit).toArray().map(toVaccine);
  }

  // -- review views ---------------------------------------------------------------------

  /**
   * Store what a person sees of an escalated proposal (decide/review.ts). Views of proposals no
   * longer waiting for a person are pruned past the newest KEEP_REVIEWS; waiting ones are kept.
   */
  putReview(proposalId: Id, view: ReviewView, at: number): void {
    this.sql.exec(
      "INSERT INTO decide_review (proposal_id, view, at) VALUES (?, ?, ?) ON CONFLICT(proposal_id) DO UPDATE SET view = excluded.view, at = excluded.at",
      proposalId,
      JSON.stringify(view),
      at,
    );
    try {
      this.sql.exec(
        `DELETE FROM decide_review WHERE proposal_id IN (
           SELECT r.proposal_id FROM decide_review r
           WHERE NOT EXISTS (SELECT 1 FROM proposals p WHERE p.id = r.proposal_id AND p.status = 'escalated')
           ORDER BY r.at DESC LIMIT -1 OFFSET ?)`,
        KEEP_REVIEWS,
      );
    } catch (err) {
      // Without the colony's proposals table nothing is pruned; the view is stored all the same.
      console.warn(`decide_review prune skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** What a person sees of an escalated proposal; null when none was stored (or it cannot be read). */
  reviewView(proposalId: Id): ReviewView | null {
    const r = this.sql.exec<{ view: string }>("SELECT view FROM decide_review WHERE proposal_id = ?", proposalId).toArray()[0];
    return r ? parseReviewView(r.view) : null;
  }

  // -- intents on probation -------------------------------------------------------------

  /** An intent's security findings, or null when it has none (then its proposals take the normal path). */
  securityProbation(intentId: Id): SecurityProbation | null {
    const r = this.sql.exec<{ security_findings: number; classes: string; at: number }>("SELECT security_findings, classes, at FROM decide_intents WHERE intent_id = ?", intentId).toArray()[0];
    if (!r || !(r.security_findings > 0)) return null;
    return { findings: r.security_findings, classes: parseList(r.classes), at: r.at };
  }

  /** A security finding sent a proposal for this intent back or to a person: its next proposals go to a person instead of a model. */
  markSecurityFinding(intentId: Id, classes: readonly string[], at: number): void {
    const was = this.securityProbation(intentId);
    const merged = [...new Set([...(was?.classes ?? []), ...classes])].sort().slice(0, 20);
    this.sql.exec(
      `INSERT INTO decide_intents (intent_id, security_findings, classes, at) VALUES (?, 1, ?, ?)
       ON CONFLICT(intent_id) DO UPDATE SET security_findings = decide_intents.security_findings + 1, classes = excluded.classes, at = excluded.at`,
      intentId,
      JSON.stringify(merged),
      at,
    );
  }
}

type VaccineDbRow = {
  intent_id: string;
  proposal_id: string | null;
  cls: string;
  batch: string;
  created_at: number;
  outcome: string;
  layer: string | null;
  reason: string | null;
  decided_at: number | null;
};

function toVaccine(r: VaccineDbRow): VaccineRow {
  return {
    intentId: r.intent_id,
    proposalId: r.proposal_id,
    cls: r.cls,
    batch: r.batch,
    createdAt: r.created_at,
    outcome: r.outcome as VaccineOutcome,
    layer: r.layer,
    reason: r.reason,
    decidedAt: r.decided_at,
  };
}

const RANK: Record<DetectorState, number> = { active: 0, advisory: 1, off: 2 };

/** The quieter of two detector states. */
export function worse(a: DetectorState, b: DetectorState): DetectorState {
  return RANK[a] >= RANK[b] ? a : b;
}

function asState(s: string): DetectorState {
  return s === "advisory" || s === "off" ? s : "active";
}

function parseList(text: string): string[] {
  try {
    const v = JSON.parse(text) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
