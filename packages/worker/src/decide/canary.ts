import type { Rule } from "@fire_trident/core";
import { auditDraw, intervalText, percent } from "./audit.ts";
import { applyAllowances, dangerLabels, scanDanger, triageDanger, type DangerAllowance } from "./danger.ts";
import { VACCINE_CLASSES, VACCINE_LABELS, makeVaccine, wilson, type SourceFile, type VaccineChange, type VaccineClass, type VaccineIntent } from "./vaccine.ts";

/**
 * Blind canaries: sealed known-bad changes put in the human review queue, so a person's catch is measured too (the
 * vaccination meter measures the review layers and never puts a vaccine to a person). Off unless a person sets the
 * colony policy's `canaryRate`: then each escalation that reaches the queue draws, from a hash of its proposal id, a
 * canary with that chance, at most one waiting at a time and ten a day. A canary is a vaccine of the meter's threat
 * classes, sealed the same way (registered in the vaccine registry, so nothing can land it), built only from a class
 * whose change the danger scan sends to a person on its own: it reaches the queue through the decide pipeline's
 * deterministic stage, so its card is a real escalation card and no model is ever asked about it. Until a person decides
 * it, nothing on the card says it is a canary; then it is revealed in a plain sentence, scored (a rejection or a return
 * is a catch, an approval a miss), and sealed: an approved canary never lands. Pure: no I/O.
 */

/** The vaccine registry's batch of a canary (decide/store.ts leaves it out of the vaccination meter). */
export const CANARY_BATCH = "canary";

/** Canaries waiting for a person at once, at most. */
export const MAX_OPEN_CANARIES = 1;
/** Canaries a colony makes in a day, at most. */
export const CANARIES_PER_DAY = 10;
/** Target files a canary build reads, at most. */
export const CANARY_TARGETS = 4;

/** Whether a vaccine registry row is a canary. */
export function isCanary(v: { batch: string } | null | undefined): boolean {
  return v?.batch === CANARY_BATCH;
}

/** Whether the escalation of this proposal draws a canary at this rate: a hash of its id, so the same escalation always draws the same. */
export function canaryDraw(proposalId: string, rate: number): boolean {
  return rate > 0 && auditDraw(`canary:${proposalId}`) < rate;
}

/** A number from a key, to start a canary build's rotation over classes and targets. */
export function canarySeed(key: string): number {
  return Math.floor(auditDraw(`canary-build:${key}`) * 0x7fff_ffff);
}

/** What a canary is built from: a rule intent it copies (or a cleanup the platform writes), the file it changes, and the rule. */
export interface CanaryTarget {
  intent: VaccineIntent;
  file: SourceFile;
  rule: Rule | null;
}

/** A canary as built: the bad change, and the danger labels that send it to a person. */
export interface CanaryChange {
  change: VaccineChange;
  labels: string[];
}

/**
 * The vaccine of class `cls` on this target when the danger scan sends it to a person on its own (a must-human pattern
 * the policy does not allow), judged as the decide pipeline judges a sealed vaccine: by an intent a rule or a person
 * wrote. Null when the class cannot be built here or would need a model to be stopped.
 */
export function canaryChange(cls: VaccineClass, n: number, target: CanaryTarget, allowances: readonly DangerAllowance[] = []): CanaryChange | null {
  const change = makeVaccine(cls, n, target);
  if (!change) return null;
  const hits = scanDanger(
    change.files.map((f) => ({ path: f.path, before: f.before, after: f.after })),
    { title: target.intent.title, why: target.intent.why, source: target.intent.ruleId ? "rule" : "human" },
  );
  const must = triageDanger(applyAllowances(hits, allowances)).mustHuman;
  return must.length > 0 ? { change, labels: dangerLabels(must) } : null;
}

/** The first canary that can be built, trying classes and targets in a rotation that starts at `seed`. */
export function pickCanary(seed: number, targets: readonly CanaryTarget[], allowances: readonly DangerAllowance[] = []): CanaryChange | null {
  if (targets.length === 0) return null;
  const n = VACCINE_CLASSES.length;
  for (let c = 0; c < n; c++) {
    const cls = VACCINE_CLASSES[(seed + c) % n]!;
    for (let t = 0; t < targets.length; t++) {
      const built = canaryChange(cls, seed + t, targets[(seed + t) % targets.length]!, allowances);
      if (built) return built;
    }
  }
  return null;
}

/** How a canary was decided: a rejection or a return catches it, an approval misses it. */
export type CanaryOutcome = "caught" | "approved";

/** The plain sentence a person reads once they decided a canary. */
export function canaryReveal(outcome: CanaryOutcome, decision: string, cls: string): string {
  const what = `a sealed known-bad change that ${VACCINE_LABELS[cls as VaccineClass] ?? "is known to be bad"}, put in the review queue to check that people catch what review sends them`;
  if (outcome === "approved") {
    return `This was a canary, not a real change: ${what}. You approved it, so it counts as missed; it was sealed and can never land, so nothing changed. Before you approve the next escalation, read the lines its card lists first.`;
  }
  const verb = decision === "return" ? "return" : "rejection";
  return `Caught: this was a canary, not a real change: ${what}. Your ${verb} counts as a catch; it was discarded, no antibody was minted, and nothing changed.`;
}

/** The sentence a canary the decide pipeline did not send to a person is sealed with (it never reached the queue). */
export function canaryDiscarded(reasons: readonly string[]): string {
  return `canary (sealed): not sent to a person by the deterministic stage, so it was discarded before any model was asked: ${reasons.join("; ").slice(0, 600)}`;
}

/** One canary as the measures read it. */
export interface CanaryLike {
  proposalId: string | null;
  cls: string;
  outcome: string;
  decision: string | null;
  by: string | null;
  decidedAt: number | null;
  createdAt: number;
  /** The vaccine registry's outcome of its review (escalated once in the queue; error when discarded there). */
  review: string | null;
}

/** Catch rate of the canaries people decided, per class and in all. */
export interface CanaryMeasure {
  decided: number;
  caught: number;
  approved: number;
  /** caught / decided with its Wilson 95% interval (0 and 0 to 1 when none was decided). */
  catchRate: number;
  lo: number;
  hi: number;
}

/** What the canaries measured. Waiting canaries are counted only, never named, so the queue stays blind. */
export interface CanaryMeasures extends CanaryMeasure {
  on: boolean;
  rate: number;
  made: number;
  waiting: number;
  discarded: number;
  classes: Record<string, CanaryMeasure & { label: string }>;
  /** Decided canaries, newest first: revealed, so they are named. */
  revealed: Array<{ proposalId: string | null; cls: string; label: string; outcome: string; decision: string | null; by: string | null; at: number | null }>;
  line: string;
}

function measure(): CanaryMeasure {
  return { decided: 0, caught: 0, approved: 0, catchRate: 0, lo: 0, hi: 1 };
}

/** The canary numbers from every canary row, with the colony's rate. */
export function canaryMeasures(rows: readonly CanaryLike[], rate: number, revealed = 20): CanaryMeasures {
  const out: CanaryMeasures = { ...measure(), on: rate > 0, rate, made: rows.length, waiting: 0, discarded: 0, classes: {}, revealed: [], line: "" };
  for (const r of rows) {
    if (r.outcome === "caught" || r.outcome === "approved") {
      const cls = (out.classes[r.cls] ??= { ...measure(), label: VACCINE_LABELS[r.cls as VaccineClass] ?? r.cls });
      for (const m of [out, cls]) {
        m.decided++;
        if (r.outcome === "caught") m.caught++;
        else m.approved++;
      }
      if (out.revealed.length < revealed) out.revealed.push({ proposalId: r.proposalId, cls: r.cls, label: VACCINE_LABELS[r.cls as VaccineClass] ?? r.cls, outcome: r.outcome, decision: r.decision, by: r.by, at: r.decidedAt });
    } else if (r.outcome === "discarded" || r.review === "error" || r.review === "returned" || r.review === "missed") out.discarded++;
    else out.waiting++;
  }
  for (const m of [out, ...Object.values(out.classes)]) {
    const w = wilson(m.caught, m.decided);
    m.catchRate = w.p;
    m.lo = w.lo;
    m.hi = w.hi;
  }
  out.line = canaryLine(out);
  return out;
}

/** The canaries in one line: "canaries: 4 of 5 caught (80%, 38–96%), 1 approved", or that they are off or not decided yet. */
export function canaryLine(m: Pick<CanaryMeasures, "on" | "rate" | "decided" | "caught" | "approved" | "catchRate" | "lo" | "hi">): string {
  if (m.decided === 0) return m.on ? `canaries on (about ${percent(m.rate)} of escalations): none decided yet` : "canaries off";
  const approved = m.approved > 0 ? `, ${m.approved.toLocaleString("en-US")} approved` : "";
  return `canaries: ${m.caught.toLocaleString("en-US")} of ${m.decided.toLocaleString("en-US")} caught (${percent(m.catchRate)}, ${intervalText(m.lo, m.hi)})${approved}${m.on ? "" : "; off now"}`;
}
