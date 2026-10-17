import type { DecisionLayer, Id, NoteAcceptance } from "@fire_trident/core";
import type { WhyAuthor } from "./danger.ts";
import { autonomyRefusal, proofRefusal, type DestructiveFact } from "./destructive.ts";
import type { DecidePolicy, DetectorState } from "./policy.ts";
import { acceptanceGate, type AcceptanceAnswer } from "./quotes.ts";
import type { DamageSignals, ProtectedHit } from "./signals.ts";
import { damageLabels } from "./signals.ts";

/**
 * The two-signal gate: every rule that decides what happens to a proposal, in one pure function.
 *
 * Signals
 * - Confirmations, bound to the proposal's head commit: innate checks pass (deterministic), plus
 *   a second one: a mechanical proof (deterministic: only import specifiers changed, each still
 *   resolving to the same file, or exactly the rule's replacement; or only comments and whitespace
 *   changed), earned autonomy, or System 2 approval. Model opinions never override deterministic facts.
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
 * - P3 the change writes, deletes or renames a path the colony's policy protects → escalate
 *      (deterministic; in every phase; no intent text, antibody, proof or policy entry waives it, and
 *      the alert budget cannot bounce it), or return a change failing its checks first
 * - P4 the change would undo lines a recent landing wrote for another intent (decide/goalconflict.ts,
 *      FT_GOAL_CONFLICT) → escalate (deterministic; in every phase; no proof or approval lands it, and the
 *      alert budget cannot bounce it), or return a change failing its checks first
 * - D2 innate checks fail and there is no damage               → return (deterministic)
 * - D3 mechanical proof, no antibody to screen, not destructive → land (deterministic)
 * - P2 an earlier proposal for this intent had a security finding → a person instead of a model:
 *      escalate (deterministic; the alert budget cannot bounce it), or return a change failing its checks
 * - D4 anything else                                            → screen with System 1
 * - M1 mechanical proof, not destructive: an antibody hit returns it (reflex); otherwise it lands (deterministic)
 * - R1 confident detector hit + damage          → escalate to a human (reflex)
 * - R2 innate checks fail                       → return to the agent (reflex)
 * - R3 confidently clear + no damage + earned autonomy + p(needs_human) < threshold, for an intent
 *      a person or a rule wrote, with every changed line in the reflex's view, and a destructive fact
 *      computed that names nothing → land (reflex)
 * - R4 anything else                            → consult System 2 (only reached when the
 *                                                 deterministic stage is inconclusive)
 * - L1 detector hit + damage                    → escalate to a human (llm)
 * - L2 innate checks fail                       → return (llm)
 * - L3 System 2 approves, no detector, p(needs_human) < threshold, every changed line in its view → land (llm)
 * - L5 that approval on a view that was cut     → escalate: too large for model review (llm; the
 *                                                 alert budget cannot bounce it)
 * - L6 that approval with an acceptance line (or a keep line) answered not met (FT_QUOTED_ACCEPTANCE)
 *                                               → return, naming the line (llm)
 * - L7 that approval with a line of the intent not met with a quote found in the diff (answered
 *      unclear, or a quote the platform could not find) → escalate (llm; the alert budget cannot bounce it)
 * - L4 anything else (one signal only)          → return to the agent with the reason
 * An escalation over the hourly alert budget goes back to its agent unless its risk is at or
 * above the budget's risk floor.
 * A destructive change (decide/destructive.ts: a file deleted or renamed, an export removed, a large
 * removal) never lands without the second opinion or a person: D3, M1 and R3 leave it to the rules after them.
 * A verdict driven by a security finding carries `security` (its classes): P0 and P1's danger
 * patterns, a security antibody, Clef's touches_sensitive, System 2's sensitive or escalate, or an
 * escalation with security damage. A returned change's agent reads only those classes
 * (agentReason), and either way the intent's next proposal goes to a person (P2).
 */

/** System 1 (Clef) answers for one proposal. */
export interface ReflexSignals {
  needsHuman: number;
  sensitive: number;
  offIntent: number;
  /** Probability-weighted risk level: 0 none, 1 low, 2 medium, 3 high. */
  risk: number;
  /** Matching antibodies' answers, with the question each asks; `security` marks one learned from a security finding. */
  antibodies: Array<{ id: Id; p: number; threshold: number; state: DetectorState; question?: string; security?: boolean }>;
}

/** What one model layer saw of a change (decide/reflex.ts coverage). */
export interface LayerView {
  /** Every changed line was in its view. */
  complete: boolean;
  /** Plain words for reasons, e.g. "the second opinion saw 20 of 26 files, 1 only in part (src/big.ts)". */
  seen: string;
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
  /** Quoted acceptance (FT_QUOTED_ACCEPTANCE): its answer for each numbered acceptance line, as it gave them (decide/quotes.ts). */
  acceptance?: AcceptanceAnswer[];
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
  /** Paths the change writes, deletes or renames that the colony's policy protects (signals.ts protectedHits): a person decides. */
  protected?: ProtectedHit[];
  /** The change would undo lines a recent landing wrote for another intent (decide/goalconflict.ts): a person decides which goal stands. */
  goalConflict?: { reason: string } | null;
  /** Matching antibodies that only System 1 can answer. */
  antibodies?: number;
  /** System 1 answers: undefined before it is asked (deterministic stage), null when Clef was unavailable. */
  reflex?: ReflexSignals | null;
  /** System 2: undefined before it is consulted, null when it failed. */
  llm?: SecondOpinion | null;
  /** The region earned autonomy (enough approved landings, no rejection since). */
  autonomy: boolean;
  /** Who wrote the intent's why. Earned autonomy covers only an intent a person or a rule wrote; absent counts as unknown (no R3). */
  whyBy?: WhyAuthor;
  /**
   * What the change takes away (decide/destructive.ts): files deleted or renamed, exports removed, large removals, and
   * what could not be read to tell. R3 lands only when it is computed and names nothing; D3 and M1 do not land a change it
   * names something for. Either way the change goes on to the second opinion. Absent: not computed, so no R3.
   */
  destructive?: DestructiveFact | null;
  /** What each model layer saw: an approval counts only when its layer saw every changed line. Absent: all of it. */
  coverage?: { reflex?: LayerView; llm?: LayerView };
  /**
   * Quoted acceptance (FT_QUOTED_ACCEPTANCE, decide/quotes.ts): the intent's acceptance lines and the keep lines as the
   * second opinion answered them, each "met" counted only with a quote found in the diff it was shown (L6, L7). Absent:
   * no acceptance list, or the flag is off, and the approval counts as it always has.
   */
  acceptance?: NoteAcceptance[];
  /** An earlier proposal for this intent had a security finding (these classes): this one goes to a person, not a model. */
  probation?: { classes: string[] } | null;
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
  /**
   * Set when a security finding drives a return or an escalation: its classes (danger classes,
   * "sensitive", "damage", "antibody"). A returned change's agent reads only these (agentReason);
   * people read `reasons`. Either way the intent's next proposal goes to a person (P2).
   */
  security?: string[];
  /** What a security return's agent may still read: the failing checks it must fix. */
  fix?: string[];
}

/** Classes of sensitive paths (signals.ts reasons), as a security return names them. */
const SENSITIVE_CLASS: Record<string, string> = {
  "FireTrident colony memory (antibodies)": "governance",
  "secrets file": "secret",
  secrets: "secret",
  authentication: "auth",
  "CI configuration": "ci",
  "dependency manifest": "dependency",
  "build or platform configuration": "build",
};

/** Classes of added capabilities (signals.ts ids). */
const CAPABILITY_CLASS: Record<string, string> = {
  env: "secret",
  "secret-log": "secret",
  process: "capability",
  network: "capability",
  eval: "capability",
  import: "capability",
  "test-skip": "test-weakening",
  assertions: "test-weakening",
};

/** The entry a capped list of danger labels ends with ("and 4 more"): no class of its own. */
const MORE = /^and \d+ more$/;

/** The class a danger label starts with ("capability (network) at src/a.ts:3: …" → "capability"); "" for "and N more". */
function labelClass(label: string): string {
  return MORE.test(label) ? "" : label.split(" ")[0] || "danger";
}

/**
 * What a returned change's agent reads. A security return names only its classes (details stay
 * with the reviewers) plus any failing checks to fix; any other return gives the reasons, with
 * each danger pattern's location and excerpt reduced to its class.
 */
export function agentReason(v: GateVerdict, danger?: GateInput["danger"]): string {
  if (v.security && v.security.length > 0) {
    const head = `returned for review: security (${v.security.join(", ")}); details are with the reviewers, and a person reviews this intent's next proposal`;
    return (v.fix && v.fix.length > 0 ? `${head}. Fix these checks first: ${v.fix.join("; ")}` : head).slice(0, 1_500);
  }
  let text = v.reasons.join("; ");
  for (const label of [...(danger?.mustHuman ?? []), ...(danger?.signals ?? [])]) if (!MORE.test(label)) text = text.split(label).join(labelClass(label));
  return `${v.layer}: ${text.slice(0, 1_500)}`;
}

/** Confidence of a yes/no answer: 0 at p = 0.5, 1 at p = 0 or 1. */
export function noulConfidence(p: number): number {
  return Number.isFinite(p) ? Math.min(1, Math.abs(2 * p - 1)) : 0;
}

const r2 = (x: number): number => Math.round(x * 100) / 100;

function active(detectors: Record<string, DetectorState>, id: string): boolean {
  return (detectors[id] ?? "active") === "active";
}

/** One System 1 detector hit; `security` marks Clef's touches_sensitive and antibodies learned from a security finding. */
interface ReflexHit {
  id: string;
  p: number;
  confidence: number;
  label: string;
  antibody: boolean;
  security: boolean;
}

/** The reflex's detector hits, each with its probability and confidence. */
function reflexHits(input: GateInput): ReflexHit[] {
  const r = input.reflex;
  if (!r) return [];
  const hits: ReflexHit[] = [];
  const t = input.policy.hit;
  if (active(input.detectors, "clef:needs_human") && r.needsHuman >= t) hits.push({ id: "clef:needs_human", p: r.needsHuman, confidence: noulConfidence(r.needsHuman), label: `needs_human ${r2(r.needsHuman)}`, antibody: false, security: false });
  if (active(input.detectors, "clef:touches_sensitive") && r.sensitive >= t) hits.push({ id: "clef:touches_sensitive", p: r.sensitive, confidence: noulConfidence(r.sensitive), label: `touches_sensitive ${r2(r.sensitive)}`, antibody: false, security: true });
  for (const a of r.antibodies) {
    // Antibodies are calibrated on the rejection they came from: a hit at their threshold is decisive.
    // The label carries the antibody's question, so a returned change says which check it failed.
    const asks = a.question ? ` ("${a.question.replace(/\s+/g, " ").trim().slice(0, 300)}")` : "";
    if (a.state === "active" && a.p >= a.threshold) hits.push({ id: `antibody:${a.id}`, p: a.p, confidence: 1, label: `antibody ${a.id} ${r2(a.p)} ≥ ${r2(a.threshold)}${asks}`, antibody: true, security: a.security === true });
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

  // Security findings, by class: what a security return's agent is told, and what puts its intent on probation.
  const securityHits = new Set(s1.filter((h) => h.security).map((h) => h.id));
  const detectorClasses = (ids: readonly string[]): string[] =>
    ids.flatMap((id) => (id === "clef:touches_sensitive" ? ["sensitive"] : id === "llm:escalate" ? ["damage"] : securityHits.has(id) ? ["antibody"] : []));
  const modelClasses = [...(llm?.sensitive ? ["sensitive"] : []), ...(llm?.verdict === "escalate" ? ["damage"] : [])];
  const damageClasses = [
    ...(input.danger?.signals ?? []).map(labelClass),
    ...input.damage.sensitivePaths.map((s) => SENSITIVE_CLASS[s.why] ?? "sensitive"),
    ...input.damage.capabilities.map((c) => CAPABILITY_CLASS[c.id] ?? "capability"),
  ];
  const classes = (xs: readonly string[]): string[] => [...new Set(xs.filter(Boolean))].sort();

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
  // `security`: the classes of the security finding behind it, if any (sent back, it is a security return).
  const escalate = (layer: GateLayer, rule: string, p: number, reasons: string[], detectors: string[], security: string[]): GateVerdict => {
    const v =
      input.alerts.used >= input.alerts.max && risk < policy.budgetRiskFloor
        ? verdict("return", layer, `${rule}+budget`, p, [...reasons, `alert budget spent (${input.alerts.used}/${input.alerts.max} this hour); risk ${r2(risk)} is below ${policy.budgetRiskFloor}, so it goes back to its agent`], detectors)
        : verdict("escalate", layer, rule, p, reasons, detectors);
    if (security.length > 0) v.security = security;
    return v;
  };
  const proof = (input.mechanical?.reasons ?? []).join("; ");
  // Protected paths, each named with the glob of the colony's policy that protects it.
  const guarded = input.protected ?? [];
  const guardedText =
    guarded.length === 0 ? "" : `protected paths need a person: ${guarded.slice(0, 5).map((h) => `${h.path} (protected by ${h.glob})`).join(", ")}${guarded.length > 5 ? ` and ${guarded.length - 5} more` : ""}`;
  // A goal conflict is named wherever a person is asked (P1 and P3 escalations name it too).
  const conflictReasons = input.goalConflict?.reason ? [input.goalConflict.reason] : [];
  // Destructive changes (decide/destructive.ts): no rung that lands without the second opinion or a person lands one.
  const unproven = proofRefusal(input.destructive);
  const unearned = autonomyRefusal(input.destructive);

  /**
   * P0/P1: a recognized danger pattern (auth, secret, unrequested capability, governance, a repair's
   * test change) always reaches a human: no confirmation can land it. A change that also fails its
   * checks goes back first, so the reviewer only ever sees a version that passes them; its agent
   * learns only the danger classes.
   */
  const danger = (): GateVerdict | null => {
    if (mustHuman.length === 0) return null;
    if (!input.innate.ok) {
      const back = verdict("return", "deterministic", "P0 danger+innate", 1, [...input.innate.failures.map((f) => `innate: ${f}`), `danger patterns need a human once the checks pass: ${mustHuman.join("; ")}`], []);
      back.security = classes(mustHuman.map(labelClass));
      back.fix = input.innate.failures.map((f) => `innate: ${f}`);
      return back;
    }
    risk = 3;
    return escalate("deterministic", "P1 danger pattern", 1, [`danger patterns need a human: ${mustHuman.join("; ")}`, ...(guardedText ? [guardedText] : []), ...conflictReasons], mustHuman.map((m) => `danger:${m.split(" ")[0]}`), classes(mustHuman.map(labelClass)));
  };

  /**
   * P3: a change that writes, deletes or renames a path the colony's policy protects reaches a person,
   * whatever proves or approves it. Like P0, a change failing its checks goes back first, told which
   * paths are protected and by which globs.
   */
  const guard = (): GateVerdict | null => {
    if (guarded.length === 0) return null;
    if (!input.innate.ok) return verdict("return", "deterministic", "P3 protected+innate", 1, [...input.innate.failures.map((f) => `innate: ${f}`), `${guardedText}; a person reviews it once its checks pass`], []);
    risk = 3;
    return escalate("deterministic", "P3 protected path", 1, [guardedText, ...conflictReasons], ["policy:protected-path"], []);
  };

  /**
   * P4: a change that would undo lines a recent landing wrote for another intent reaches a person, whatever proves or
   * approves it: no merge settles a disagreement between goals, so a person decides which goal stands. Like P3, a
   * change failing its checks goes back first, told what it would undo.
   */
  const conflict = (): GateVerdict | null => {
    const reason = input.goalConflict?.reason;
    if (!reason) return null;
    if (!input.innate.ok) return verdict("return", "deterministic", "P4 goal conflict+innate", 1, [...input.innate.failures.map((f) => `innate: ${f}`), `${reason} once its checks pass`], []);
    risk = Math.max(risk, policy.budgetRiskFloor);
    return escalate("deterministic", "P4 goal conflict", 1, [reason], ["policy:goal-conflict"], []);
  };

  // Deterministic stage: facts first, no model.
  if (!asked) {
    if (mech === "fail") return verdict("return", "deterministic", "D1 resolution", 1, (input.mechanical?.reasons ?? []).map((x) => `deterministic: ${x}`), []);
    const gated = danger() ?? guard() ?? conflict();
    if (gated) return gated;
    if (!input.innate.ok && facts.length === 0) return verdict("return", "deterministic", "D2 innate", 1, input.innate.failures.map((f) => `innate: ${f}`), []);
    if (mech === "pass" && facts.length === 0 && (input.antibodies ?? 0) === 0 && !unproven) return verdict("land", "deterministic", "D3 innate+proof", 1, [`deterministic proof: ${proof}`], [], ["innate", "deterministic"]);
    // P2: after a security return, this intent's proposals go to a person instead of a model (a proof needs neither).
    if (input.probation) {
      const was = `an earlier proposal for this intent had a security finding${input.probation.classes.length > 0 ? ` (${input.probation.classes.join(", ")})` : ""}`;
      if (!input.innate.ok) return verdict("return", "deterministic", "P2 probation+innate", 1, [...input.innate.failures.map((f) => `innate: ${f}`), `${was}: a person reviews the next version once its checks pass`], []);
      risk = 3;
      return escalate("deterministic", "P2 security finding", 1, [`${was}: a person reviews this one instead of a model`], ["intent:security-finding"], []);
    }
    return verdict("screen", "deterministic", "D4 screen", 1, [mech === "pass" ? (unproven ?? "proof holds; matching antibodies need System 1") : `deterministic stage inconclusive: ${proof || "no proof attempted"}`], []);
  }

  if (!consulted) {
    if (mech !== "fail") {
      const gated = danger() ?? guard() ?? conflict();
      if (gated) return gated;
    }
    // M1: a proven change only answers to antibodies (learned from humans); Clef's other alarms are advisory.
    if (mech === "pass" && facts.length === 0 && !unproven) {
      const ab = s1.filter((h) => h.antibody);
      if (ab.length > 0) {
        const back = verdict("return", "reflex", "M1 proof+antibody", Math.max(...ab.map((h) => h.p)), [`a reviewer rejected similar changes: ${ab.map((h) => h.label).join(", ")}`], ab.map((h) => h.id));
        if (ab.some((h) => h.security)) back.security = ["antibody"];
        return back;
      }
      const advisory = [...s1.map((h) => h.label), ...(r === null && (input.antibodies ?? 0) > 0 ? ["antibodies not screened (System 1 unavailable)"] : [])];
      const landed = verdict("land", "deterministic", "M1 innate+proof", 1, [`deterministic proof: ${proof}`, ...(advisory.length > 0 ? [`advisory only (facts win over model opinions): ${advisory.join(", ")}`] : [])], [], ["innate", "deterministic"]);
      if (s1.length > 0) landed.overruled = s1.map((h) => h.id);
      return landed;
    }
    // R1: a confident detector hit with damage pages a human without waiting for System 2.
    if (s1.length > 0 && damage.length > 0 && sure) {
      const ids = s1.map((h) => h.id);
      return escalate("reflex", "R1 detector+damage", Math.max(...s1.map((h) => h.p)), [`reflex: ${s1.map((h) => h.label).join(", ")}`, `damage: ${damage.join("; ")}`], ids, classes([...damageClasses, ...detectorClasses(ids)]));
    }
    // R2: deterministic failures go straight back (a refuted import outranks any model opinion).
    if (mech === "fail") return verdict("return", "deterministic", "D1 resolution", 1, (input.mechanical?.reasons ?? []).map((x) => `deterministic: ${x}`), []);
    if (!input.innate.ok) return verdict("return", "reflex", "R2 innate", 1, input.innate.failures.map((f) => `innate: ${f}`), s1.map((h) => h.id));
    // R3: earned autonomy lets a confident, quiet reflex land a change with no damage at all, for an
    // intent a person or a rule wrote (never an agent's own or a repair), when the reflex saw every changed line.
    const trusted = input.whyBy === "person" || input.whyBy === "rule";
    const reflexView = input.coverage?.reflex;
    const sawAll = reflexView?.complete ?? true;
    if (s1.length === 0 && damage.length === 0 && sure && input.autonomy && trusted && sawAll && needsHuman < policy.needsHuman && !unearned) {
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
            : input.autonomy && !trusted
              ? `earned autonomy does not cover an intent written by ${input.whyBy === "certification" ? "trunk certification (a repair)" : "an agent"}: a second confirmation is required`
              : input.autonomy && !sawAll
                ? `${reflexView?.seen ?? "the reflex saw only part of the change"}: its clear answer does not count alone, a second confirmation is required`
                : mech === "pass" && unproven
                  ? unproven
                  : input.autonomy && unearned
                    ? unearned
                    : "no earned autonomy and no deterministic proof: a second confirmation is required";
    return verdict("consult", "reflex", "R4 consult", 1 - confidence, [why], s1.map((h) => h.id));
  }

  // After System 2: a danger pattern or a protected path still needs a human, whatever the second opinion said.
  if (mech !== "fail") {
    const gated = danger() ?? guard() ?? conflict();
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
    return escalate("llm", "L1 detector+damage", p, [`detectors: ${labels.join(", ")}`, `damage: ${damage.join("; ")}`], detectors, classes([...damageClasses, ...modelClasses, ...detectorClasses(detectors)]));
  }
  if (mech === "fail") return verdict("return", "deterministic", "D1 resolution", 1, (input.mechanical?.reasons ?? []).map((x) => `deterministic: ${x}`), []);
  if (!input.innate.ok) return verdict("return", "llm", "L2 innate", 1, input.innate.failures.map((f) => `innate: ${f}`), detectors);
  if (llm && llm.verdict === "approve" && detectors.length === 0 && needsHuman < policy.needsHuman) {
    // L5: an approval counts only when System 2 saw every changed line; otherwise a person decides.
    const view = input.coverage?.llm;
    if (view && !view.complete) {
      risk = Math.max(risk, policy.budgetRiskFloor);
      return escalate("llm", "L5 too large", 1, [`too large for model review: ${view.seen}, so its approval does not count and a person decides`], ["review:too-large"], []);
    }
    // L6, L7 (FT_QUOTED_ACCEPTANCE): the approval counts only when every acceptance line is met, with a quote found in the diff or, for a line stating an absence, on the model's word.
    const accepted = acceptanceGate(input.acceptance);
    if (accepted?.notMet) return verdict("return", "llm", "L6 acceptance not met", llm.confidence, [accepted.notMet, `${llm.model} approves otherwise: ${llm.reason}`], ["acceptance:not-met"]);
    if (accepted?.unclear) {
      risk = Math.max(risk, policy.budgetRiskFloor);
      return escalate("llm", "L7 acceptance unclear", 1, [accepted.unclear, `${llm.model} approves: ${llm.reason}`], ["acceptance:unclear"], []);
    }
    return verdict("land", "llm", "L3 innate+llm", 1 - needsHuman, [`${llm.model} approves: ${llm.reason}`, ...(accepted?.met ? [accepted.met] : [])], [], ["innate", "llm"]);
  }
  const reasons: string[] = [];
  if (!llm) reasons.push("second opinion unavailable; one confirmation only");
  else if (llm.verdict === "approve" && detectors.length > 0) reasons.push(`reviewers disagree: ${labels.join(", ")} vs ${llm.model} approve`);
  else if (llm.verdict === "approve") reasons.push(`${llm.model} approves but p(needs_human) ${r2(needsHuman)} ≥ ${policy.needsHuman}`);
  else reasons.push(`${llm.model}: ${llm.verdict} (${llm.reason})`);
  // Quoted acceptance: a change going back names the acceptance lines the second opinion found not met.
  const unmet = llm ? acceptanceGate(input.acceptance)?.notMet : undefined;
  if (unmet) reasons.push(unmet);
  if (detectors.length > 0 && damage.length === 0) reasons.push("detector without damage: one signal only, no human paged");
  if (detectors.length === 0 && damage.length > 0) reasons.push(`damage without a detector: ${damage.join("; ")}`);
  const p = llm ? (llm.verdict === "approve" ? needsHuman : Math.max(needsHuman, llm.confidence)) : 1;
  const back = verdict("return", "llm", "L4 one signal", p, reasons, detectors);
  // A security finding by a model that answered (an unavailable one only defers the change).
  if (llm) {
    const security = classes([...modelClasses, ...detectorClasses(detectors)]);
    if (security.length > 0) back.security = security;
  }
  return back;
}
