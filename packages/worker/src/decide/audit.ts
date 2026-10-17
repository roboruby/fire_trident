import type { Proposal } from "@fire_trident/core";
import { wilson } from "./vaccine.ts";

/**
 * The audit sample and the baseline stream: people keep seeing ordinary landings, not only the exceptions review sends
 * them. A deterministic share of the changes that landed without a person (a deterministic proof, reproduction by a
 * recipe, a model's approval, earned autonomy) is put in an audit queue after landing, never before it; the review
 * queue shows one of them after every few escalations, and when nothing else waits. A person answers fine or should not
 * have landed, and the answers are measured per confirming layer, with Wilson 95% intervals.
 *
 * Sampling is stratified by confirming layer and reproducible: within each layer the count audited stays between
 * floor(rate × n) and ceil(rate × n) of the n landings seen (and at least one, so every layer is looked at), and where it
 * may go either way a hash of the landing id and the proposal id decides. The same landings in the same order are always
 * sampled the same way, and an agent cannot tell which of its landings a person will read. Pure: no I/O.
 */

/** What confirmed a change that landed without a person: the strata of the audit sample. */
export type AuditLayer = "deterministic" | "reproduction" | "model" | "autonomy";

/** Every layer, in the order reports list them. */
export const AUDIT_LAYERS: readonly AuditLayer[] = ["deterministic", "reproduction", "model", "autonomy"];

/** How a card and a report name each layer ("already landed by <rule> (<label>)"). */
export const AUDIT_LAYER_LABEL: Record<AuditLayer, string> = {
  deterministic: "a deterministic proof",
  reproduction: "reproduction by its recipe",
  model: "a model's approval",
  autonomy: "earned autonomy",
};

/** A person's answer to an audit item. */
export type AuditVerdict = "fine" | "should-not-have-landed";

/** Every answer, as the API takes them. */
export const AUDIT_VERDICTS: readonly AuditVerdict[] = ["fine", "should-not-have-landed"];

/** The baseline stream: the review queue shows one audit item after every this many escalations. */
export const AUDIT_EVERY = 5;
/** Audit items the queue shows when no escalation waits. */
export const AUDIT_WHEN_EMPTY = 10;

/** A number of the form 0.03 as a whole percent ("3%"), one decimal below 1%. */
export function percent(share: number): string {
  if (!Number.isFinite(share)) return "?%";
  const p = share * 100;
  return `${p > 0 && p < 1 ? Math.round(p * 10) / 10 : Math.round(p)}%`;
}

/**
 * A uniform draw in [0, 1) from a key: FNV-1a over its UTF-8 bytes, then a 32-bit finalizer so keys that differ in a few
 * characters land far apart. The same key always draws the same number.
 */
export function auditDraw(key: string): number {
  let h = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(key)) {
    h ^= byte;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 0x1_0000_0000;
}

/** The key of one landed change: its landing and its proposal (a landing can carry several changes). */
export function auditKey(landingId: string, proposalId: string): string {
  return `${landingId}:${proposalId}`;
}

/** Why a landed change was or was not put in the audit queue. */
export type AuditPick = { pick: true; why: "first" | "owed" | "draw" } | { pick: false; why: "off" | "ahead" | "draw" };

/**
 * Whether one landed change of a layer goes to the audit queue, given what the layer saw before it (`seen` landings,
 * `picked` of them audited, since the rate was last set). The first of a layer always goes, so each layer is looked at;
 * after that the layer's count stays between floor(rate × n) and ceil(rate × n), and in between the key's draw
 * decides, with the rate as its chance.
 */
export function auditPick(key: string, rate: number, before: { seen: number; picked: number }): AuditPick {
  if (!(rate > 0)) return { pick: false, why: "off" };
  const seen = Math.max(0, Math.floor(before.seen)) + 1;
  const picked = Math.max(0, Math.floor(before.picked));
  const exact = rate * seen;
  const floor = Math.max(1, Math.floor(exact + 1e-9));
  const ceil = Math.max(1, Math.ceil(exact - 1e-9));
  if (picked < floor) return { pick: true, why: picked === 0 ? "first" : "owed" };
  if (picked >= ceil) return { pick: false, why: "ahead" };
  return auditDraw(key) < rate ? { pick: true, why: "draw" } : { pick: false, why: "draw" };
}

/** The platform's gate check of a proposal: the last check named "gate" that its agent did not send. */
function gateCheck(p: Pick<Proposal, "evidence">): { rule: string; detail: string } | null {
  const checks = Array.isArray(p.evidence?.checks) ? p.evidence.checks : [];
  for (let i = checks.length - 1; i >= 0; i--) {
    const c = checks[i];
    if (!c || c.name !== "gate" || c.by === "agent") continue;
    const recorded = typeof c.gate?.rule === "string" ? c.gate.rule : "";
    const detail = typeof c.detail === "string" ? c.detail : "";
    return { rule: recorded || (detail.split(" → ")[0] ?? "").trim(), detail };
  }
  return null;
}

/** What the decide pipeline recorded of a proposal (decide_outcomes): its last layer and action, and a person's decision. */
export interface OutcomeOf {
  layer: string | null;
  action: string | null;
  human: string | null;
}

/**
 * The layer that confirmed a landed change that no person approved, with its rule ("D3 innate+proof"), or null for a
 * change a person approved, one with no landing decision recorded (review off), and anything else. The gate check kept
 * in its evidence names the rule (D3 and M1 a proof, D5 a reproduction, R3 earned autonomy, L3 a model); a proposal
 * without one is read from its outcome row.
 */
export function confirmingLayer(p: Pick<Proposal, "evidence" | "approvedAt">, outcome: OutcomeOf | null): { layer: AuditLayer; rule: string } | null {
  if (typeof p.approvedAt === "number" || outcome?.human === "approve") return null;
  const gate = gateCheck(p);
  const code = gate?.rule.split(" ")[0] ?? "";
  if (gate && /→ land by /.test(gate.detail)) {
    if (code === "D3" || code === "M1") return { layer: "deterministic", rule: gate.rule };
    if (code === "D5") return { layer: "reproduction", rule: gate.rule };
    if (code === "R3") return { layer: "autonomy", rule: gate.rule };
    if (code === "L3") return { layer: "model", rule: gate.rule };
  }
  if (outcome?.action !== "land") return null;
  if (outcome.layer === "deterministic") return { layer: "deterministic", rule: gate?.rule || "deterministic proof" };
  if (outcome.layer === "reflex") return { layer: "autonomy", rule: gate?.rule || "R3 innate+autonomy" };
  if (outcome.layer === "llm") return { layer: "model", rule: gate?.rule || "L3 innate+llm" };
  return null;
}

/** The sentence an audit card leads with: "Already landed by D3 innate+proof (a deterministic proof)." */
export function landedByText(layer: AuditLayer, rule: string): string {
  return `Already landed by ${rule || "the gate"} (${AUDIT_LAYER_LABEL[layer]}).`;
}

/**
 * The baseline stream: the review queue with audit items among the escalations, one after every `every` escalations and
 * one more at the end when the escalations ran out before the next turn, so a short queue still shows an ordinary
 * landing; with no escalation waiting, up to `whenEmpty` audit items. Escalations keep their order.
 */
export function interleave<T>(escalations: readonly T[], audits: readonly T[], every = AUDIT_EVERY, whenEmpty = AUDIT_WHEN_EMPTY): T[] {
  if (audits.length === 0) return [...escalations];
  if (escalations.length === 0) return audits.slice(0, Math.max(0, whenEmpty));
  const n = Math.max(1, Math.floor(every));
  const out: T[] = [];
  let a = 0;
  escalations.forEach((e, i) => {
    out.push(e);
    if ((i + 1) % n === 0 && a < audits.length) out.push(audits[a++]!);
  });
  if (escalations.length % n !== 0 && a < audits.length) out.push(audits[a++]!);
  return out;
}

// ---------------------------------------------------------------------------
// Measures

/** Audit rows as the measures read them: a layer, an answer (null while it waits), and how many rows (1 when absent). */
export interface AuditRowLike {
  layer: string;
  verdict: string | null;
  n?: number;
}

/** One layer's (or every layer's) audit numbers. */
export interface AuditMeasure {
  /** Landings without a person this layer confirmed since sampling began. */
  landed: number;
  /** Of them, put in the audit queue. */
  queued: number;
  /** Waiting for a person's answer. */
  pending: number;
  /** Answered by a person. */
  audited: number;
  fine: number;
  /** Answered "should not have landed". */
  wrong: number;
  /** wrong / audited, with its Wilson 95% interval (0 and 0 to 1 when none was audited). */
  wrongRate: number;
  lo: number;
  hi: number;
}

/** The audit numbers per layer and in all. */
export interface AuditMeasures {
  layers: Record<AuditLayer, AuditMeasure & { label: string }>;
  overall: AuditMeasure;
}

function emptyMeasure(): AuditMeasure {
  return { landed: 0, queued: 0, pending: 0, audited: 0, fine: 0, wrong: 0, wrongRate: 0, lo: 0, hi: 1 };
}

/** Audit numbers from each layer's landings seen (strata counters) and the audit rows. */
export function auditMeasures(seen: Partial<Record<string, number>>, rows: readonly AuditRowLike[]): AuditMeasures {
  const layers = Object.fromEntries(AUDIT_LAYERS.map((l) => [l, { ...emptyMeasure(), label: AUDIT_LAYER_LABEL[l] }])) as AuditMeasures["layers"];
  const overall = emptyMeasure();
  for (const l of AUDIT_LAYERS) {
    const n = Math.max(0, Math.floor(seen[l] ?? 0));
    layers[l].landed = n;
    overall.landed += n;
  }
  for (const r of rows) {
    if (!(AUDIT_LAYERS as readonly string[]).includes(r.layer)) continue;
    const n = r.n === undefined ? 1 : Math.max(0, Math.floor(Number(r.n) || 0));
    for (const m of [layers[r.layer as AuditLayer], overall]) {
      m.queued += n;
      if (r.verdict === null) m.pending += n;
      else {
        m.audited += n;
        if (r.verdict === "should-not-have-landed") m.wrong += n;
        else m.fine += n;
      }
    }
  }
  for (const m of [...Object.values(layers), overall]) {
    // A landing put in the queue counts as landed even when it predates the counters.
    m.landed = Math.max(m.landed, m.queued);
    const w = wilson(m.wrong, m.audited);
    m.wrongRate = w.p;
    m.lo = w.lo;
    m.hi = w.hi;
  }
  return { layers, overall };
}

/** An interval as a line writes it: "0–24%". */
export function intervalText(lo: number, hi: number): string {
  return `${Math.round(lo * 100)}–${Math.round(hi * 100)}%`;
}

const count = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/**
 * The audit in one line: "audited 12 of 400 landings without a person: 0 should not have landed (0–24%)", with what
 * waits for a person, or that the sample is off.
 */
export function auditLine(m: AuditMeasure, rate: number): string {
  const off = !(rate > 0);
  if (off && m.queued === 0) return m.landed > 0 ? `audit sample off: ${count(m.landed, "landing")} without a person, none put in front of a person` : "audit sample off";
  const waiting = m.pending > 0 ? `; ${count(m.pending, "waits", "wait")} for a person` : "";
  const now = off ? "; the sample is off now" : "";
  const head = `audited ${m.audited.toLocaleString("en-US")} of ${count(m.landed, "landing")} without a person`;
  if (m.audited === 0) return `${head}${waiting || (m.landed === 0 ? "" : "; none answered yet")}${now}`;
  return `${head}: ${m.wrong.toLocaleString("en-US")} should not have landed (${intervalText(m.lo, m.hi)})${waiting}${now}`;
}

// ---------------------------------------------------------------------------
// Reviewer decisions over time

/** One person's decision on an escalation (decide_outcomes `human`, `human_at`). */
export interface HumanDecisionRow {
  human: string;
  at: number;
}

/** One week of a person's decisions on escalations. */
export interface ReviewerWeek {
  from: number;
  to: number;
  decisions: number;
  approved: number;
  rejected: number;
  returned: number;
  /** approved / decisions with its Wilson 95% interval (0 and 0 to 1 when there was none). */
  approvalRate: number;
  lo: number;
  hi: number;
}

/** A person's decisions over time and how the approval rate moved. */
export interface ReviewerDrift {
  weeks: ReviewerWeek[];
  /** The approval rate of the last two weeks and of the weeks before, and the change in points; null where too few decisions. */
  recent: { decisions: number; approved: number; rate: number } | null;
  earlier: { decisions: number; approved: number; rate: number } | null;
  change: number | null;
  line: string;
}

const WEEK_MS = 7 * 24 * 60 * 60_000;
/** Weeks the drift reads. */
export const DRIFT_WEEKS = 8;
/** Decisions a side of the comparison needs before a change is reported. */
const DRIFT_MIN = 5;

/**
 * People's decisions on escalations per week for the last `weeks` weeks (newest last), and the approval rate of the last
 * two weeks against the weeks before: a reviewer who approves more and more of what review sends may be reading less.
 */
export function reviewerDrift(rows: readonly HumanDecisionRow[], now: number, weeks = DRIFT_WEEKS): ReviewerDrift {
  const start = now - weeks * WEEK_MS;
  const out: ReviewerWeek[] = [];
  for (let i = 0; i < weeks; i++) out.push({ from: start + i * WEEK_MS, to: start + (i + 1) * WEEK_MS, decisions: 0, approved: 0, rejected: 0, returned: 0, approvalRate: 0, lo: 0, hi: 1 });
  for (const r of rows) {
    if (!(r.at > start) || r.at > now) continue;
    const w = out[Math.min(weeks - 1, Math.floor((r.at - start) / WEEK_MS))]!;
    w.decisions++;
    if (r.human === "approve") w.approved++;
    else if (r.human === "reject") w.rejected++;
    else w.returned++;
  }
  for (const w of out) {
    const s = wilson(w.approved, w.decisions);
    w.approvalRate = s.p;
    w.lo = s.lo;
    w.hi = s.hi;
  }
  const pool = (list: ReviewerWeek[]) => {
    const decisions = list.reduce((n, w) => n + w.decisions, 0);
    const approved = list.reduce((n, w) => n + w.approved, 0);
    return decisions >= DRIFT_MIN ? { decisions, approved, rate: Math.round((approved / decisions) * 1000) / 1000 } : null;
  };
  const recent = pool(out.slice(-2));
  const earlier = pool(out.slice(0, -2));
  const change = recent && earlier ? Math.round((recent.rate - earlier.rate) * 100) : null;
  const side = (s: { decisions: number; approved: number; rate: number }) => `${s.approved} of ${count(s.decisions, "escalation")} (${percent(s.rate)})`;
  const total = out.reduce((n, w) => n + w.decisions, 0);
  const line =
    total === 0
      ? `no decision on an escalation in the last ${weeks} weeks`
      : recent && earlier
        ? `approved ${side(recent)} in the last 2 weeks, ${side(earlier)} in the ${weeks - 2} before: ${change === 0 ? "no change" : `${change! > 0 ? "up" : "down"} ${Math.abs(change!)} points`}`
        : `${count(total, "decision")} on escalations in the last ${weeks} weeks: too few to compare the last 2 weeks with the weeks before`;
  return { weeks: out, recent, earlier, change, line };
}
