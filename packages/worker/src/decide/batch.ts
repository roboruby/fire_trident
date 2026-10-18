import type { Id } from "@fire_trident/core";
import { revalidationEnabled } from "@fire_trident/core";
import { errorText } from "../colony/errors.ts";
import type { DangerHit } from "./danger.ts";
import { ESCALATION_BATCH_PER_HOUR } from "./policy.ts";
import type { ProtectedHit } from "./signals.ts";
import { isProtectStop } from "../colony/protect.ts";
import { isMergeHold } from "../trunk/mergelock.ts";

/**
 * Escalation batching (FT_ESCALATION_BATCH): a budget for the escalations the hourly alert budget cannot send back.
 *
 * The gate sends some changes to a person whatever the alert budget says (decide/gate.ts): a danger pattern that needs a
 * person (P1), the next proposal of an intent with a security finding (P2), a protected path (P3), a goal conflict (P4),
 * antibodies the reflex could not check (M2), a change too large for model review (L5), an acceptance line answered
 * unclear (L7), no second opinion under the spend cap (L8), and no second opinion because no reviewer model outside the
 * author's family is configured (L9). With many agents those alone can bury one person. Where
 * the flag covers the colony, each of them is counted, and past the decide policy's escalationBatchPerHour of them in the
 * hour before (60 by default), the next batchable ones are batched: each still waits for a person (never landed, never
 * sent back), and the review queue shows one card per batch, the changes that escalated for the same reason (the same
 * rule; for P1 the same danger patterns), with their count and each one listed. A person approves all, rejects all or
 * opens each; an answer for a batch is that person's decision on each change it lists, one by one.
 *
 * Batchable: P1 when every hit is capability (a new process, network or eval use, a capability module), M2, L5, L7, L8
 * and L9. Never batched, one card each even past the budget, though they count against it: a change with an auth, secret,
 * governance, handoff, repair test-change or loosened-guard hit (NEVER_BATCHED), one that writes a protected path, a
 * security finding's next proposal (P2), a goal conflict (P4), and a change a person already decided that came back (a
 * held merge: heldByPerson). Deterministic: a change's batch is a function of its rule and the facts behind it. The table
 * is created on first use and nothing else changes shape.
 */

/** Escalations an hour that the alert budget cannot send back, per colony, before the next ones are batched (decide/policy.ts). */
export { ESCALATION_BATCH_PER_HOUR };

/** Changes one answer for a batch may decide. */
export const MAX_BATCH_DECISION = 500;

const HOUR_MS = 60 * 60_000;

/** Batched rows kept this long; a person has decided them long before. */
const KEEP_BATCHED_MS = 30 * 24 * HOUR_MS;

/** A batch key longer than this keeps its start and a hash of the whole. */
const MAX_KEY = 400;

/** What the changes of a batch share, by gate rule: the rules whose escalations the alert budget cannot send back. */
const SHARED: Record<string, string> = {
  "P1 danger pattern": "hit a danger pattern that needs a person",
  "P2 security finding": "are the next proposals of intents with an earlier security finding",
  "P3 protected path": "write protected paths",
  "P4 goal conflict": "would undo lines a recent landing wrote for another intent",
  "M2 antibodies unscreened": "have matching antibodies the reflex model could not check",
  "L5 too large": "were too large for model review",
  "L7 acceptance unclear": "have an acceptance line the second opinion answered unclear",
  "L8 spend cap": "had no second opinion because the spend cap refused its model call",
  "L9 no independent reviewer": "had no second opinion because no reviewer model outside their author's model family is configured",
};

/**
 * Why the other rules the alert budget cannot send back are never batched: their escalations count against the budget
 * but always stay one card each. A security finding's next proposal (P2) goes to a person so its agent cannot probe the
 * reviewers; a protected path (P3) is one a colony chose to see change by change; a goal conflict (P4) undoes a
 * different landing's work each time, so there is nothing to approve together.
 */
const SOLO_RULES: Record<string, string> = {
  "P2 security finding": "an earlier proposal for its intent had a security finding",
  "P3 protected path": "it writes a protected path",
  "P4 goal conflict": "it would undo another intent's landing",
};

/**
 * Danger classes a person looks at change by change: a change with a hit of one of them, one that needs a person or
 * only a danger signal, is never batched, whatever its rule. Authentication is among them: auth code is read line by
 * line. Of P1's classes only capability is left to batch on (a new process, network or eval use, a capability module).
 */
export const NEVER_BATCHED: ReadonlySet<string> = new Set(["auth", "secret", "governance", "handoff", "test-change", "loosened-guard"]);

/** Is escalation batching on for this colony (FT_ESCALATION_BATCH: "on", or a comma-separated list of colony ids)? */
export function escalationBatchOn(setting: string | undefined, colonyId: Id): boolean {
  return revalidationEnabled(setting, colonyId);
}

/** The batch an escalation belongs to: its key, its gate rule, what its changes share in words, and whether it may batch. */
export interface EscalationBatchKey {
  key: string;
  rule: string;
  /** Completes "12 changes ...": "hit the danger pattern capability (network)". */
  label: string;
  /** False: it counts against the budget but always stays its own card. */
  batchable: boolean;
  /** Why it stays its own card ("it writes a protected path"); absent when it may be batched. */
  solo?: string;
}

/** The facts behind an escalation that tell its batch apart, and what keeps a change out of every batch. */
export interface BatchFacts {
  /** The danger hits that need a person. */
  danger?: ReadonlyArray<Pick<DangerHit, "cls" | "pattern">>;
  /** The danger signals (hits that count as damage); a loosened guard among them keeps the change on its own card. */
  signals?: ReadonlyArray<Pick<DangerHit, "cls">>;
  /** The protected paths the change writes. */
  protected?: ReadonlyArray<Pick<ProtectedHit, "glob">>;
  /** The intent's earlier security finding (P2). */
  probation?: { classes: readonly string[] } | null;
}

/** "a", "a and b", "a, b and c"; past four names, "and N more". */
function list(names: readonly string[]): string {
  const shown = names.length > 4 ? [...names.slice(0, 4), `${names.length - 4} more`] : [...names];
  return shown.length <= 1 ? (shown[0] ?? "") : `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
}

/** FNV-1a of a text, as 8 hex digits. */
function fnv(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0");
}

/** A key of bounded length: a long one keeps its start and a hash of the whole, so two keys stay apart. */
function bounded(key: string): string {
  return key.length <= MAX_KEY ? key : `${key.slice(0, MAX_KEY - 10)}#${fnv(key)}`;
}

/** A batch's short id, for a person to type (`ft review <colony> --approve-batch bat_1a2b3c4d`). */
export function batchId(key: string): string {
  return `bat_${fnv(key)}`;
}

/** Why an escalation by this rule with these facts stays its own card, or null when it may be batched. */
function soloReason(rule: string, facts: BatchFacts): string | null {
  const classes = new Set([...(facts.danger ?? []), ...(facts.signals ?? [])].map((h) => h.cls as string));
  const kept = [...NEVER_BATCHED].filter((cls) => classes.has(cls));
  if (kept.length > 0) return `it has a ${list(kept)} hit, which a person decides change by change`;
  if ((facts.protected ?? []).length > 0) return SOLO_RULES["P3 protected path"]!;
  const solo = SOLO_RULES[rule];
  if (solo) return solo;
  // A danger-pattern escalation whose hits are not known: nothing says it is only capability.
  if (rule === "P1 danger pattern" && (facts.danger ?? []).length === 0) return "its danger patterns are not known";
  return null;
}

/**
 * The batch of an escalation by this gate rule, or null when the alert budget can send the rule's escalations back (they
 * are never counted). P1 batches by the sorted set of danger patterns, so every change of a batch hit exactly the same
 * ones; the others by rule alone. A change soloReason names counts against the budget but is never batched.
 */
export function batchKeyOf(rule: string, facts: BatchFacts = {}): EscalationBatchKey | null {
  const shared = SHARED[rule];
  if (shared === undefined) return null;
  const solo = soloReason(rule, facts);
  const how = solo === null ? { batchable: true } : { batchable: false, solo };
  const code = rule.split(" ")[0] ?? rule;
  const sorted = (xs: readonly string[]): string[] => [...new Set(xs.filter((x) => x !== ""))].sort();
  if (code === "P1") {
    const patterns = sorted((facts.danger ?? []).map((h) => `${h.cls} (${h.pattern.split(":")[1] ?? h.pattern})`));
    if (patterns.length === 0) return { key: code, rule, label: shared, ...how };
    return { key: bounded(`${code}|${patterns.join(",")}`), rule, label: `hit the danger pattern${patterns.length === 1 ? "" : "s"} ${list(patterns)}`, ...how };
  }
  return { key: code, rule, label: shared, ...how };
}

/**
 * A change a person already decided that came back to the queue (a held merge, a path protected after it was cleared):
 * it is decided on its own card, never in a batch.
 */
export function heldByPerson(p: { approvedAt?: unknown; mergeHold?: unknown; reason?: unknown }): boolean {
  const reason = typeof p.reason === "string" ? p.reason : undefined;
  return typeof p.approvedAt === "number" || (Array.isArray(p.mergeHold) && p.mergeHold.length > 0) || isMergeHold(reason) || isProtectStop(reason);
}

/** One recorded escalation: its batch, and whether the budget was spent when it came. */
export interface BatchRow {
  proposalId: Id;
  key: string;
  rule: string;
  label: string;
  batched: boolean;
  at: number;
}

type BatchDbRow = { proposal_id: string; key: string; rule: string; label: string; batched: number; at: number };

const toRow = (r: BatchDbRow): BatchRow => ({ proposalId: r.proposal_id, key: r.key, rule: r.rule, label: r.label, batched: r.batched === 1, at: r.at });

/** The colony's record of the escalations the alert budget cannot send back (decide_batches), made on first use. */
export class EscalationBatches {
  constructor(private readonly sql: SqlStorage) {
    sql.exec(
      "CREATE TABLE IF NOT EXISTS decide_batches (proposal_id TEXT PRIMARY KEY, key TEXT NOT NULL, rule TEXT NOT NULL, label TEXT NOT NULL, batched INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL)",
    );
    sql.exec("CREATE INDEX IF NOT EXISTS decide_batches_by_at ON decide_batches(at)");
  }

  /**
   * Record an escalation in this batch at `now`. With `budget` or more others recorded in the hour before, it is
   * batched, unless it may never be (`batchable` false): it counts against the budget all the same. A proposal recorded
   * again keeps one row, its latest.
   */
  record(proposalId: Id, batch: EscalationBatchKey, now: number, budget = ESCALATION_BATCH_PER_HOUR): { batched: boolean; used: number } {
    this.sql.exec("DELETE FROM decide_batches WHERE (batched = 0 AND at <= ?) OR at <= ?", now - HOUR_MS, now - KEEP_BATCHED_MS);
    const used = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM decide_batches WHERE at > ? AND proposal_id != ?", now - HOUR_MS, proposalId).one().n;
    const batched = batch.batchable && used >= budget;
    this.sql.exec(
      `INSERT INTO decide_batches (proposal_id, key, rule, label, batched, at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(proposal_id) DO UPDATE SET key = excluded.key, rule = excluded.rule, label = excluded.label, batched = excluded.batched, at = excluded.at`,
      proposalId,
      batch.key,
      batch.rule,
      batch.label,
      batched ? 1 : 0,
      now,
    );
    return { batched, used };
  }

  /** The rows of these proposals that were batched. */
  batchedOf(ids: readonly Id[]): Map<Id, BatchRow> {
    const out = new Map<Id, BatchRow>();
    if (ids.length === 0) return out;
    const rows = this.sql
      .exec<BatchDbRow>("SELECT proposal_id, key, rule, label, batched, at FROM decide_batches WHERE batched = 1 AND proposal_id IN (SELECT value FROM json_each(?))", JSON.stringify(ids))
      .toArray();
    for (const r of rows) out.set(r.proposal_id, toRow(r));
    return out;
  }
}

/** A batch as each of its waiting changes carries it in the review queue (`batch` on GET /review items). */
export interface QueueBatch {
  /** Short id for a person to type (batchId). */
  id: string;
  key: string;
  rule: string;
  /** Completes "12 changes ...". */
  label: string;
  /** The hourly budget that was spent. */
  budget: number;
  /** Its waiting changes, in queue order. */
  ids: Id[];
}

/**
 * Mark the review queue's batched changes: each one that waits in a batch with at least one other waiting change
 * carries `batch` (its id and key, rule, what they share, the budget, and the ids in queue order). A batch down to one
 * waiting change shows as that change's own card, and so does a change a person already decided that came back
 * (heldByPerson: a held merge), an audit item (`audit`: a landing the audit sample put to a person) and any change `skip`
 * names (a blind canary). Returns the batches marked.
 */
export function markBatches<T extends { id: Id }>(queue: readonly T[], rows: ReadonlyMap<Id, BatchRow>, budget = ESCALATION_BATCH_PER_HOUR, skip: (p: T) => boolean = () => false): QueueBatch[] {
  const groups = new Map<string, QueueBatch>();
  for (const p of queue) {
    const row = rows.get(p.id);
    if (!row?.batched || "audit" in p || heldByPerson(p as { approvedAt?: unknown; mergeHold?: unknown; reason?: unknown }) || skip(p)) continue;
    const g = groups.get(row.key) ?? { id: batchId(row.key), key: row.key, rule: row.rule, label: row.label, budget, ids: [] };
    g.ids.push(p.id);
    groups.set(row.key, g);
  }
  const marked = [...groups.values()].filter((g) => g.ids.length >= 2);
  const byId = new Map(marked.flatMap((g) => g.ids.map((id) => [id, g] as const)));
  for (const p of queue) {
    const g = byId.get(p.id);
    if (g) Object.assign(p, { batch: g });
  }
  return marked;
}

/** Mark the queue from the colony's record (markBatches); a record that cannot be read marks nothing, so the queue reads as before. */
export function markQueueBatches<T extends { id: Id }>(sql: SqlStorage, queue: readonly T[], budget = ESCALATION_BATCH_PER_HOUR, skip: (p: T) => boolean = () => false): QueueBatch[] {
  try {
    return markBatches(queue, new EscalationBatches(sql).batchedOf(queue.map((p) => p.id)), budget, skip);
  } catch (err) {
    console.error(`review batches not read: ${errorText(err)}`);
    return [];
  }
}

/** A person's answer for a batch (POST /api/colonies/:id/review/batches/decide). */
export interface BatchDecision {
  key: string;
  /** The changes the person saw on the card: only these are decided. */
  ids: Id[];
  decision: "approve" | "reject";
  reason: string;
  by: string;
}

/** What an answer for a batch did. */
export interface BatchAnswer {
  key: string;
  decision: "approve" | "reject";
  decided: Id[];
  /** Changes it left alone, each with why. */
  skipped: Array<{ id: Id; why: string }>;
}

/** What answering a batch needs from its colony. */
export interface BatchHost {
  batches: EscalationBatches;
  /** A proposal's status and what says a person already decided it (heldByPerson), or null when there is none. */
  proposal(id: Id): { status: string; intentId: Id; approvedAt?: number; mergeHold?: unknown; reason?: string } | null;
  /** A change no batch may decide (a blind canary): it is left alone with the same words as a change outside the batch. */
  excluded?(p: { id: Id; intentId: Id }): boolean;
  /** The person's decision on one change, as on its own card; `mint` false keeps a rejection from minting an antibody. */
  decide(id: Id, decision: "approve" | "reject", reason: string, by: string, mint: boolean): Promise<void>;
}

/**
 * Answer a batch: the person's decision on each change the card listed, one by one, as if they had answered each card.
 * Only changes still waiting for a person in that batch are decided; the others are listed with why. A rejection mints
 * its antibody from the first change it decides only, so one reason makes one antibody.
 */
export async function answerBatch(host: BatchHost, d: BatchDecision): Promise<BatchAnswer> {
  const ids = [...new Set(d.ids)].slice(0, MAX_BATCH_DECISION);
  const rows = host.batches.batchedOf(ids);
  const decided: Id[] = [];
  const skipped: BatchAnswer["skipped"] = [];
  for (const id of ids) {
    const row = rows.get(id);
    const p = host.proposal(id);
    if (!row || row.key !== d.key || (p !== null && host.excluded?.({ id, intentId: p.intentId }) === true)) {
      skipped.push({ id, why: "not in this batch; decide it on its own card" });
      continue;
    }
    if (p?.status !== "escalated") {
      skipped.push({ id, why: p ? `it is ${p.status} and no longer waits for a person` : "no such proposal" });
      continue;
    }
    if (heldByPerson(p)) {
      skipped.push({ id, why: "a person already decided it once (a held merge); decide it on its own card" });
      continue;
    }
    try {
      await host.decide(id, d.decision, d.reason, d.by, d.decision !== "reject" || !decided.length);
      decided.push(id);
    } catch (err) {
      skipped.push({ id, why: errorText(err) });
    }
  }
  return { key: d.key, decision: d.decision, decided, skipped };
}

/** What counting an escalation needs from the decide engine's host. */
export interface BatchRecordHost {
  env: { FT_ESCALATION_BATCH?: string };
  sql: SqlStorage;
  colony(): { id: Id };
  bump(name: string, delta: number): void;
}

/**
 * Count an escalation by this gate rule where FT_ESCALATION_BATCH covers the colony (decide/engine.ts, as a change
 * escalates): past `budget` in the hour before (the decide policy's escalationBatchPerHour) it is batched, and
 * `decide.escalations.batched` counts it. Null where the flag is off, the rule's escalations are not counted, or the
 * record failed: the change then waits on its own card, as before.
 */
export function recordEscalation(host: BatchRecordHost, proposalId: Id, rule: string, facts: BatchFacts, now: number, budget = ESCALATION_BATCH_PER_HOUR): { batched: boolean; batch: EscalationBatchKey } | null {
  if (!escalationBatchOn(host.env.FT_ESCALATION_BATCH, host.colony().id)) return null;
  const batch = batchKeyOf(rule, facts);
  if (!batch) return null;
  try {
    const { batched } = new EscalationBatches(host.sql).record(proposalId, batch, now, budget);
    if (batched) host.bump("decide.escalations.batched", 1);
    return { batched, batch };
  } catch (err) {
    console.error(`escalation of ${proposalId} not counted for batching: ${errorText(err)}`);
    return null;
  }
}
