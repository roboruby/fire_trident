import type { DecisionLayer, Id } from "@fire_trident/core";
import type { DecidePolicy, DetectorState } from "./policy.ts";
import type { DamageSignals } from "./signals.ts";
import { damageLabels } from "./signals.ts";

/**
 * The two-signal gate: every rule that decides what happens to a proposal, in one pure function.
 *
 * Signals
 * - Confirmations: innate checks pass (deterministic), and a second one: the System 2 model
 *   approves, or the region has earned autonomy. Both are bound to the proposal's head commit.
 * - Detectors (something looks wrong): Clef's needs_human and touches_sensitive answers, antibody
 *   hits, and a System 2 "escalate" verdict.
 * - Damage (it would matter): sensitive paths, writes outside the intent's footprint, capabilities
 *   the change adds, and off-intent judgments (Clef's off_intent, System 2's off_intent/sensitive).
 *
 * Rules, first match wins (R = System 1 phase, L = after the System 2 second opinion)
 * - R1 confident detector hit + damage          → escalate to a human (reflex)
 * - R2 innate checks fail                       → return to the agent (reflex, deterministic)
 * - R3 confidently clear + no damage + earned autonomy + p(needs_human) < threshold → land (reflex)
 * - R4 anything else                            → consult System 2
 * - L1 detector hit + damage                    → escalate to a human (llm)
 * - L2 innate checks fail                       → return (llm)
 * - L3 System 2 approves, no detector, p(needs_human) < threshold → land (llm)
 * - L4 anything else (one signal only)          → return to the agent with the reason
 * An escalation over the hourly alert budget goes back to its agent unless its risk is at or
 * above the budget's risk floor.
 */

/** System 1 (Clef) answers for one proposal. */
export interface ReflexSignals {
  needsHuman: number;
  sensitive: number;
  offIntent: number;
  /** Probability-weighted risk level: 0 none, 1 low, 2 medium, 3 high. */
  risk: number;
  antibodies: Array<{ id: Id; p: number; threshold: number; state: DetectorState }>;
}

/** System 2 (an LLM from another family) verdict. */
export interface SecondOpinion {
  verdict: "approve" | "return" | "escalate";
  needsHuman: number;
  offIntent: boolean;
  sensitive: boolean;
  confidence: number;
  reason: string;
  model: string;
}

/** Everything the gate looks at. */
export interface GateInput {
  innate: { ok: boolean; failures: string[] };
  damage: DamageSignals;
  /** System 1 answers; null when Clef was unavailable. */
  reflex: ReflexSignals | null;
  /** System 2: undefined before it is consulted, null when it failed. */
  llm?: SecondOpinion | null;
  /** The region earned autonomy (enough approved landings, no rejection since). */
  autonomy: boolean;
  /** Human escalations in the last hour, and the budget. */
  alerts: { used: number; max: number };
  /** Probation state of the standard Clef questions, by detector id ("clef:needs_human", ...). */
  detectors: Record<string, DetectorState>;
  policy: Pick<DecidePolicy, "confidence" | "hit" | "needsHuman" | "budgetRiskFloor">;
}

export type GateAction = "land" | "return" | "escalate" | "consult";

/** What the gate decided and why. */
export interface GateVerdict {
  action: GateAction;
  layer: Extract<DecisionLayer, "reflex" | "llm">;
  /** Probability of the chosen action. */
  p: number;
  rule: string;
  reasons: string[];
  /** Detector ids that fired (gating ones only). */
  detectors: string[];
  /** Damage signal labels. */
  damage: string[];
  /** Confirmations behind a landing ("innate", "llm", "autonomy"). */
  confirmations: string[];
  /** System 1 confidence in the answers that decide. */
  confidence: number;
  /** Risk 0..3 (review queue order and alert budget). */
  risk: number;
}

/** Confidence of a yes/no answer: 0 at p = 0.5, 1 at p = 0 or 1. */
export function noulConfidence(p: number): number {
  return Number.isFinite(p) ? Math.min(1, Math.abs(2 * p - 1)) : 0;
}

const r2 = (x: number): number => Math.round(x * 100) / 100;

function active(detectors: Record<string, DetectorState>, id: string): boolean {
  return (detectors[id] ?? "active") === "active";
}

/** The reflex's detector hits, each with its probability and confidence. */
function reflexHits(input: GateInput): Array<{ id: string; p: number; confidence: number; label: string }> {
  const r = input.reflex;
  if (!r) return [];
  const hits: Array<{ id: string; p: number; confidence: number; label: string }> = [];
  const t = input.policy.hit;
  if (active(input.detectors, "clef:needs_human") && r.needsHuman >= t) hits.push({ id: "clef:needs_human", p: r.needsHuman, confidence: noulConfidence(r.needsHuman), label: `needs_human ${r2(r.needsHuman)}` });
  if (active(input.detectors, "clef:touches_sensitive") && r.sensitive >= t) hits.push({ id: "clef:touches_sensitive", p: r.sensitive, confidence: noulConfidence(r.sensitive), label: `touches_sensitive ${r2(r.sensitive)}` });
  for (const a of r.antibodies) {
    // Antibodies are calibrated on the rejection they came from: a hit at their threshold is decisive.
    if (a.state === "active" && a.p >= a.threshold) hits.push({ id: `antibody:${a.id}`, p: a.p, confidence: 1, label: `antibody ${a.id} ${r2(a.p)} ≥ ${r2(a.threshold)}` });
  }
  return hits;
}

/** Confidence of a quiet reflex: every gating answer must be confidently "no". */
function clearConfidence(input: GateInput): number {
  const r = input.reflex;
  if (!r) return 0;
  const answers: number[] = [];
  if (active(input.detectors, "clef:needs_human")) answers.push(r.needsHuman);
  if (active(input.detectors, "clef:touches_sensitive")) answers.push(r.sensitive);
  if (active(input.detectors, "clef:off_intent")) answers.push(r.offIntent);
  return answers.length === 0 ? 0 : Math.min(...answers.map(noulConfidence));
}

/** Decide one proposal (see the rules above). Pure and deterministic. */
export function gate(input: GateInput): GateVerdict {
  const { policy } = input;
  const consulted = input.llm !== undefined;
  const llm = input.llm ?? null;
  const layer: GateVerdict["layer"] = consulted ? "llm" : "reflex";
  const r = input.reflex;

  // Damage: deterministic facts plus scope judgments.
  const damage = damageLabels(input.damage);
  if (r && active(input.detectors, "clef:off_intent") && r.offIntent >= policy.hit) damage.push(`off-intent (Clef ${r2(r.offIntent)})`);
  if (llm?.offIntent) damage.push(`off-intent (${llm.model})`);
  if (llm?.sensitive) damage.push(`touches sensitive code (${llm.model})`);

  // Detectors and the reflex's confidence in them.
  const s1 = reflexHits(input);
  const alarmConfidence = s1.length > 0 ? Math.max(...s1.map((h) => h.confidence)) : 0;
  const quietConfidence = clearConfidence(input);
  const confidence = s1.length > 0 ? alarmConfidence : quietConfidence;
  const sure = confidence >= policy.confidence;
  const needsHuman = llm ? llm.needsHuman : (r?.needsHuman ?? 1);
  let risk = r ? Math.max(0, Math.min(3, r.risk)) : Math.min(3, input.damage.sensitivePaths.length + input.damage.capabilities.length + (input.damage.residual.length > 0 ? 1 : 0));
  if (llm?.verdict === "escalate") risk = Math.max(risk, 2);

  const verdict = (action: GateAction, rule: string, p: number, reasons: string[], detectors: string[], confirmations: string[] = []): GateVerdict => ({
    action,
    layer,
    p: r2(Math.min(1, Math.max(0, p))),
    rule,
    reasons,
    detectors,
    damage,
    confirmations,
    confidence: r2(confidence),
    risk: r2(risk),
  });

  // Alert budget: an escalation beyond it goes back to its agent unless the risk is high enough.
  const escalate = (rule: string, p: number, reasons: string[], detectors: string[]): GateVerdict => {
    if (input.alerts.used >= input.alerts.max && risk < policy.budgetRiskFloor) {
      return verdict("return", `${rule}+budget`, p, [...reasons, `alert budget spent (${input.alerts.used}/${input.alerts.max} this hour); risk ${r2(risk)} is below ${policy.budgetRiskFloor}, so it goes back to its agent`], detectors);
    }
    return verdict("escalate", rule, p, reasons, detectors);
  };

  if (!consulted) {
    // R1: a confident detector hit with damage pages a human without waiting for System 2.
    if (s1.length > 0 && damage.length > 0 && sure) {
      return escalate("R1 detector+damage", Math.max(...s1.map((h) => h.p)), [`reflex: ${s1.map((h) => h.label).join(", ")}`, `damage: ${damage.join("; ")}`], s1.map((h) => h.id));
    }
    // R2: deterministic failures go straight back.
    if (!input.innate.ok) return verdict("return", "R2 innate", 1, input.innate.failures.map((f) => `innate: ${f}`), s1.map((h) => h.id));
    // R3: earned autonomy lets a confident, quiet reflex land a change with no damage at all.
    if (s1.length === 0 && damage.length === 0 && sure && input.autonomy && needsHuman < policy.needsHuman) {
      return verdict("land", "R3 innate+autonomy", 1 - needsHuman, [`reflex clear (confidence ${r2(confidence)}), region has earned autonomy`], [], ["innate", "autonomy"]);
    }
    // R4: everything else gets a second opinion.
    const why = !r
      ? "reflex unavailable"
      : !sure
        ? `reflex unsure (confidence ${r2(confidence)} < ${policy.confidence})`
        : s1.length > 0
          ? `reflex flagged ${s1.map((h) => h.label).join(", ")} without damage`
          : damage.length > 0
            ? `damage without a detector: ${damage.join("; ")}`
            : "no earned autonomy: a second confirmation is required";
    return verdict("consult", "R4 consult", 1 - confidence, [why], s1.map((h) => h.id));
  }

  // After System 2: unconfident System 1 alarms give way to the second opinion.
  const kept = s1.filter((h) => h.confidence >= policy.confidence);
  const detectors = kept.map((h) => h.id);
  const labels = kept.map((h) => h.label);
  if (llm?.verdict === "escalate") {
    detectors.push("llm:escalate");
    labels.push(`${llm.model}: escalate (${llm.reason})`);
  }
  if (detectors.length > 0 && damage.length > 0) {
    const p = Math.max(...kept.map((h) => h.p), llm?.verdict === "escalate" ? llm.needsHuman : 0);
    return escalate("L1 detector+damage", p, [`detectors: ${labels.join(", ")}`, `damage: ${damage.join("; ")}`], detectors);
  }
  if (!input.innate.ok) return verdict("return", "L2 innate", 1, input.innate.failures.map((f) => `innate: ${f}`), detectors);
  if (llm && llm.verdict === "approve" && detectors.length === 0 && needsHuman < policy.needsHuman) {
    return verdict("land", "L3 innate+llm", 1 - needsHuman, [`${llm.model} approves: ${llm.reason}`], [], ["innate", "llm"]);
  }
  const reasons: string[] = [];
  if (!llm) reasons.push("second opinion unavailable; one confirmation only");
  else if (llm.verdict === "approve" && detectors.length > 0) reasons.push(`reviewers disagree: ${labels.join(", ")} vs ${llm.model} approve`);
  else if (llm.verdict === "approve") reasons.push(`${llm.model} approves but p(needs_human) ${r2(needsHuman)} ≥ ${policy.needsHuman}`);
  else reasons.push(`${llm.model}: ${llm.verdict} (${llm.reason})`);
  if (detectors.length > 0 && damage.length === 0) reasons.push("detector without damage: one signal only, no human paged");
  if (detectors.length === 0 && damage.length > 0) reasons.push(`damage without a detector: ${damage.join("; ")}`);
  const p = llm ? (llm.verdict === "approve" ? needsHuman : Math.max(needsHuman, llm.confidence)) : 1;
  return verdict("return", "L4 one signal", p, reasons, detectors);
}
