import type { DecisionLayer, Id } from "@fire_trident/core";
import type { DecidePolicy, DetectorState } from "./policy.ts";
import type { DamageSignals } from "./signals.ts";
import { damageLabels } from "./signals.ts";

/**
 * The two-signal gate: every rule that decides what happens to a proposal, in one pure function.
 *
 * Signals
 * - Confirmations, bound to the proposal's head commit: innate checks pass (deterministic), plus
 *   a second one: a mechanical proof (deterministic: only import specifiers changed, each still
 *   resolving to the same file, or exactly the rule's replacement), earned autonomy, or System 2
 *   approval. Model opinions never override deterministic facts.
 * - Detectors (something looks wrong): Clef's needs_human and touches_sensitive answers, antibody
 *   hits, and a System 2 "escalate" verdict.
 * - Damage (it would matter): sensitive paths, writes outside the intent's footprint, capabilities
 *   the change adds, and off-intent judgments (Clef's off_intent, System 2's off_intent/sensitive).
 *
 * Rules, first match wins (D = deterministic stage, before any model; R = System 1; L = after System 2)
 * - D1 an import resolves to nothing or to a different module → return (deterministic)
 * - P0 a danger pattern that needs a human, in a change failing its checks → return (deterministic)
 * - P1 a danger pattern that needs a human (auth, secret, unrequested capability, not allowed by
 *      policy or an antibody)                                 → escalate (deterministic; in every phase)
 * - D2 innate checks fail and there is no damage               → return (deterministic)
 * - D3 mechanical proof and no antibody to screen               → land (deterministic)
 * - D4 anything else                                            → screen with System 1
 * - M1 mechanical proof: an antibody hit returns it (reflex); otherwise it lands (deterministic)
 * - R1 confident detector hit + damage          → escalate to a human (reflex)
 * - R2 innate checks fail                       → return to the agent (reflex)
 * - R3 confidently clear + no damage + earned autonomy + p(needs_human) < threshold → land (reflex)
 * - R4 anything else                            → consult System 2 (only reached when the
 *                                                 deterministic stage is inconclusive)
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

/** The deterministic stage's conclusion (decide/mechanical.ts). */
export interface MechanicalSignal {
  verdict: "pass" | "fail" | "inconclusive";
  reasons: string[];
}

/** Everything the gate looks at. */
export interface GateInput {
  innate: { ok: boolean; failures: string[] };
  damage: DamageSignals;
  /** Deterministic stage; absent counts as inconclusive. */
  mechanical?: MechanicalSignal;
  /**
   * Danger patterns (decide/danger.ts): `mustHuman` hits (auth, secrets, unrequested capabilities
   * not explicitly allowed) always go to a human; `signals` count as damage.
   */
  danger?: { mustHuman: string[]; signals: string[] };
  /** Matching antibodies that only System 1 can answer. */
  antibodies?: number;
  /** System 1 answers: undefined before it is asked (deterministic stage), null when Clef was unavailable. */
  reflex?: ReflexSignals | null;
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

export type GateAction = "land" | "return" | "escalate" | "screen" | "consult";

/** Which layer made a gate decision: deterministic facts, System 1 or System 2. */
export type GateLayer = "deterministic" | Extract<DecisionLayer, "reflex" | "llm">;

/** What the gate decided and why. */
export interface GateVerdict {
  action: GateAction;
  layer: GateLayer;
  /** Probability of the chosen action. */
  p: number;
  rule: string;
  reasons: string[];
  /** Detector ids that fired (gating ones only). */
  detectors: string[];
  /** Damage signal labels. */
  damage: string[];
  /** Confirmations behind a landing ("innate", "deterministic", "llm", "autonomy"). */
  confirmations: string[];
  /** System 1 detectors a deterministic proof overruled (they count as "not useful" in probation). */
  overruled?: string[];
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
function reflexHits(input: GateInput): Array<{ id: string; p: number; confidence: number; label: string; antibody: boolean }> {
  const r = input.reflex;
  if (!r) return [];
  const hits: Array<{ id: string; p: number; confidence: number; label: string; antibody: boolean }> = [];
  const t = input.policy.hit;
  if (active(input.detectors, "clef:needs_human") && r.needsHuman >= t) hits.push({ id: "clef:needs_human", p: r.needsHuman, confidence: noulConfidence(r.needsHuman), label: `needs_human ${r2(r.needsHuman)}`, antibody: false });
  if (active(input.detectors, "clef:touches_sensitive") && r.sensitive >= t) hits.push({ id: "clef:touches_sensitive", p: r.sensitive, confidence: noulConfidence(r.sensitive), label: `touches_sensitive ${r2(r.sensitive)}`, antibody: false });
  for (const a of r.antibodies) {
    // Antibodies are calibrated on the rejection they came from: a hit at their threshold is decisive.
    if (a.state === "active" && a.p >= a.threshold) hits.push({ id: `antibody:${a.id}`, p: a.p, confidence: 1, label: `antibody ${a.id} ${r2(a.p)} ≥ ${r2(a.threshold)}`, antibody: true });
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
  const mech = input.mechanical?.verdict ?? "inconclusive";
  const asked = input.reflex !== undefined;
  const consulted = input.llm !== undefined;
  const llm = input.llm ?? null;
  const r = input.reflex ?? null;

  // Damage: deterministic facts (danger signals among them) plus scope judgments.
  const facts = [...damageLabels(input.damage), ...(input.danger?.signals ?? []).map((s) => `danger: ${s}`)];
  const damage = [...facts];
  const mustHuman = input.danger?.mustHuman ?? [];
  if (r && active(input.detectors, "clef:off_intent") && r.offIntent >= policy.hit) damage.push(`off-intent (Clef ${r2(r.offIntent)})`);
  if (llm?.offIntent) damage.push(`off-intent (${llm.model})`);
  if (llm?.sensitive) damage.push(`touches sensitive code (${llm.model})`);

  // Detectors and the reflex's confidence in them.
  const s1 = reflexHits(input);
  const alarmConfidence = s1.length > 0 ? Math.max(...s1.map((h) => h.confidence)) : 0;
  const confidence = s1.length > 0 ? alarmConfidence : clearConfidence(input);
  const sure = confidence >= policy.confidence;
  const needsHuman = llm ? llm.needsHuman : (r?.needsHuman ?? 1);
  let risk = r ? Math.max(0, Math.min(3, r.risk)) : Math.min(3, input.damage.sensitivePaths.length + input.damage.capabilities.length + (input.damage.residual.length > 0 ? 1 : 0));
  if (llm?.verdict === "escalate") risk = Math.max(risk, 2);

  const verdict = (action: GateAction, layer: GateLayer, rule: string, p: number, reasons: string[], detectors: string[], confirmations: string[] = []): GateVerdict => ({
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
  const escalate = (layer: GateLayer, rule: string, p: number, reasons: string[], detectors: string[]): GateVerdict => {
    if (input.alerts.used >= input.alerts.max && risk < policy.budgetRiskFloor) {
      return verdict("return", layer, `${rule}+budget`, p, [...reasons, `alert budget spent (${input.alerts.used}/${input.alerts.max} this hour); risk ${r2(risk)} is below ${policy.budgetRiskFloor}, so it goes back to its agent`], detectors);
    }
    return verdict("escalate", layer, rule, p, reasons, detectors);
  };
  const proof = (input.mechanical?.reasons ?? []).join("; ");

  /**
   * P0/P1: a recognized danger pattern (auth, secret, unrequested capability, governance) always reaches a
   * human: no confirmation can land it. A change that also fails its checks goes back first, so
   * the reviewer only ever sees a version that passes them.
   */
  const danger = (): GateVerdict | null => {
    if (mustHuman.length === 0) return null;
    if (!input.innate.ok) {
      return verdict("return", "deterministic", "P0 danger+innate", 1, [...input.innate.failures.map((f) => `innate: ${f}`), `danger patterns need a human once the checks pass: ${mustHuman.join("; ")}`], []);
    }
    risk = 3;
    return escalate("deterministic", "P1 danger pattern", 1, [`danger patterns need a human: ${mustHuman.join("; ")}`], mustHuman.map((m) => `danger:${m.split(" ")[0]}`));
  };

  // Deterministic stage: facts first, no model.
  if (!asked) {
    if (mech === "fail") return verdict("return", "deterministic", "D1 resolution", 1, (input.mechanical?.reasons ?? []).map((x) => `deterministic: ${x}`), []);
    const gated = danger();
    if (gated) return gated;
    if (!input.innate.ok && facts.length === 0) return verdict("return", "deterministic", "D2 innate", 1, input.innate.failures.map((f) => `innate: ${f}`), []);
    if (mech === "pass" && facts.length === 0 && (input.antibodies ?? 0) === 0) return verdict("land", "deterministic", "D3 innate+proof", 1, [`deterministic proof: ${proof}`], [], ["innate", "deterministic"]);
    return verdict("screen", "deterministic", "D4 screen", 1, [mech === "pass" ? "proof holds; matching antibodies need System 1" : `deterministic stage inconclusive: ${proof || "no proof attempted"}`], []);
  }

  if (!consulted) {
    if (mech !== "fail") {
      const gated = danger();
      if (gated) return gated;
    }
    // M1: a proven change only answers to antibodies (learned from humans); Clef's other alarms are advisory.
    if (mech === "pass" && facts.length === 0) {
      const ab = s1.filter((h) => h.antibody);
      if (ab.length > 0) return verdict("return", "reflex", "M1 proof+antibody", Math.max(...ab.map((h) => h.p)), [`a reviewer rejected similar changes: ${ab.map((h) => h.label).join(", ")}`], ab.map((h) => h.id));
      const advisory = [...s1.map((h) => h.label), ...(r === null && (input.antibodies ?? 0) > 0 ? ["antibodies not screened (System 1 unavailable)"] : [])];
      const landed = verdict("land", "deterministic", "M1 innate+proof", 1, [`deterministic proof: ${proof}`, ...(advisory.length > 0 ? [`advisory only (facts win over model opinions): ${advisory.join(", ")}`] : [])], [], ["innate", "deterministic"]);
      if (s1.length > 0) landed.overruled = s1.map((h) => h.id);
      return landed;
    }
    // R1: a confident detector hit with damage pages a human without waiting for System 2.
    if (s1.length > 0 && damage.length > 0 && sure) {
      return escalate("reflex", "R1 detector+damage", Math.max(...s1.map((h) => h.p)), [`reflex: ${s1.map((h) => h.label).join(", ")}`, `damage: ${damage.join("; ")}`], s1.map((h) => h.id));
    }
    // R2: deterministic failures go straight back (a refuted import outranks any model opinion).
    if (mech === "fail") return verdict("return", "deterministic", "D1 resolution", 1, (input.mechanical?.reasons ?? []).map((x) => `deterministic: ${x}`), []);
    if (!input.innate.ok) return verdict("return", "reflex", "R2 innate", 1, input.innate.failures.map((f) => `innate: ${f}`), s1.map((h) => h.id));
    // R3: earned autonomy lets a confident, quiet reflex land a change with no damage at all.
    if (s1.length === 0 && damage.length === 0 && sure && input.autonomy && needsHuman < policy.needsHuman) {
      return verdict("land", "reflex", "R3 innate+autonomy", 1 - needsHuman, [`reflex clear (confidence ${r2(confidence)}), region has earned autonomy`], [], ["innate", "autonomy"]);
    }
    // R4: the deterministic stage was inconclusive and the reflex cannot act alone.
    const why = !r
      ? "reflex unavailable"
      : !sure
        ? `reflex unsure (confidence ${r2(confidence)} < ${policy.confidence})`
        : s1.length > 0
          ? `reflex flagged ${s1.map((h) => h.label).join(", ")} without damage`
          : damage.length > 0
            ? `damage without a detector: ${damage.join("; ")}`
            : "no earned autonomy and no deterministic proof: a second confirmation is required";
    return verdict("consult", "reflex", "R4 consult", 1 - confidence, [why], s1.map((h) => h.id));
  }

  // After System 2: a danger pattern still needs a human, whatever the second opinion said.
  if (mech !== "fail") {
    const gated = danger();
    if (gated) return gated;
  }
  // Unconfident System 1 alarms give way to the second opinion.
  const kept = s1.filter((h) => h.confidence >= policy.confidence);
  const detectors = kept.map((h) => h.id);
  const labels = kept.map((h) => h.label);
  if (llm?.verdict === "escalate") {
    detectors.push("llm:escalate");
    labels.push(`${llm.model}: escalate (${llm.reason})`);
  }
  if (detectors.length > 0 && damage.length > 0) {
    const p = Math.max(...kept.map((h) => h.p), llm?.verdict === "escalate" ? llm.needsHuman : 0);
    return escalate("llm", "L1 detector+damage", p, [`detectors: ${labels.join(", ")}`, `damage: ${damage.join("; ")}`], detectors);
  }
  if (mech === "fail") return verdict("return", "deterministic", "D1 resolution", 1, (input.mechanical?.reasons ?? []).map((x) => `deterministic: ${x}`), []);
  if (!input.innate.ok) return verdict("return", "llm", "L2 innate", 1, input.innate.failures.map((f) => `innate: ${f}`), detectors);
  if (llm && llm.verdict === "approve" && detectors.length === 0 && needsHuman < policy.needsHuman) {
    return verdict("land", "llm", "L3 innate+llm", 1 - needsHuman, [`${llm.model} approves: ${llm.reason}`], [], ["innate", "llm"]);
  }
  const reasons: string[] = [];
  if (!llm) reasons.push("second opinion unavailable; one confirmation only");
  else if (llm.verdict === "approve" && detectors.length > 0) reasons.push(`reviewers disagree: ${labels.join(", ")} vs ${llm.model} approve`);
  else if (llm.verdict === "approve") reasons.push(`${llm.model} approves but p(needs_human) ${r2(needsHuman)} ≥ ${policy.needsHuman}`);
  else reasons.push(`${llm.model}: ${llm.verdict} (${llm.reason})`);
  if (detectors.length > 0 && damage.length === 0) reasons.push("detector without damage: one signal only, no human paged");
  if (detectors.length === 0 && damage.length > 0) reasons.push(`damage without a detector: ${damage.join("; ")}`);
  const p = llm ? (llm.verdict === "approve" ? needsHuman : Math.max(needsHuman, llm.confidence)) : 1;
  return verdict("return", "llm", "L4 one signal", p, reasons, detectors);
}
