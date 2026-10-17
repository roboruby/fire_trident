import type { GateRecord, GateValue } from "@fire_trident/core";
import type { GateInput, GateVerdict } from "./gate.ts";
import type { DecidePolicy } from "./policy.ts";
import { presetOf } from "./presets.ts";

/**
 * What the gate check keeps of a decision (CheckResult.gate), so every landing card can say which rule confirmed a change
 * and with what values: "R3: confidence 0.93 ≥ 0.85, p(needs_human) 0.04 < 0.2, approved landings 23 ≥ 20". The gate
 * (decide/gate.ts) decides; this reads the same input it read and names the values its rule compared, each with the policy
 * bound it met, plus the preset the colony's policy equalled then (decide/presets.ts). core/decides.ts writes the line.
 * Pure: the region's approved landings (as the engine read them for earned autonomy) are asked for only when the rule is R3.
 */

/** What the record reads besides the verdict: the gate's input (with the reflex and second opinion as asked), the policy, and the region's approved landings. */
export interface RuleContext {
  input: Pick<GateInput, "mechanical" | "antibodies" | "reflex" | "llm" | "whyBy" | "alerts" | "protected">;
  policy: DecidePolicy;
  /** The region's approved landings since its last revocation, as the gate's earned autonomy read them; asked only for R3. */
  approvals: () => number;
}

/** Values kept to three decimals, so a note stays compact and the line reads the same everywhere. */
const r3 = (x: number): number => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : 0);
/** A string value at most this long (a proof's first clause, a list of detectors). */
const MAX_TEXT = 160;
const clip = (s: string): string => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1).trimEnd()}…` : s);

const WHY_BY: Record<string, string> = { person: "a person", rule: "a rule", certification: "trunk certification", agent: "an agent" };

/** The proof's first clause ("1 file proven: only import specifiers changed, …"): what was proven, without the checks after it. */
function proofClause(input: RuleContext["input"]): string {
  const reasons = (input.mechanical?.reasons ?? []).join("; ");
  return clip(reasons.split(";")[0]?.trim() || "passed");
}

/** The values a landing rule compared, with the bounds from the policy. */
function landingValues(code: string, v: GateVerdict, ctx: RuleContext): GateValue[] {
  const { input, policy } = ctx;
  if (code === "D3") {
    return [
      { name: "proof", value: proofClause(input) },
      { name: "antibodies to screen", value: input.antibodies ?? 0 },
      { name: "destructive change", value: false },
    ];
  }
  if (code === "M1") {
    const out: GateValue[] = [
      { name: "proof", value: proofClause(input) },
      { name: "matching antibodies", value: input.antibodies ?? 0 },
      { name: "antibody hits", value: 0 },
    ];
    if (v.overruled && v.overruled.length > 0) out.push({ name: "model flags overruled by the proof", value: v.overruled.length });
    return out;
  }
  if (code === "R3") {
    const r = input.reflex;
    return [
      { name: "model", value: policy.reflexModel },
      { name: "confidence", value: r3(v.confidence), op: "≥", bound: policy.confidence },
      { name: "p(needs_human)", value: r3(r?.needsHuman ?? 1), op: "<", bound: policy.needsHuman },
      { name: "approved landings", value: ctx.approvals(), op: "≥", bound: policy.autonomyAfter },
      { name: "intent by", value: WHY_BY[input.whyBy ?? ""] ?? "unknown" },
    ];
  }
  if (code === "L3") {
    const llm = input.llm;
    return [
      { name: "model", value: llm?.model ?? "unknown" },
      { name: "p(needs_human)", value: r3(llm?.needsHuman ?? 1), op: "<", bound: policy.needsHuman },
      { name: "model confidence", value: r3(llm?.confidence ?? 0) },
      { name: "saw every changed line", value: true },
    ];
  }
  return [];
}

/**
 * The values of a rule that did not land the change: for an escalation, its risk and why it reached a person rather than
 * going back (the alert budget had room, or the risk met the floor); the model and antibody detectors that fired; protected
 * paths it wrote.
 */
function otherValues(v: GateVerdict, ctx: RuleContext): GateValue[] {
  const { input, policy } = ctx;
  const out: GateValue[] = [];
  if (v.action === "escalate") {
    const { used, max } = input.alerts ?? { used: 0, max: policy.alertsPerHour };
    out.push(used < max ? { name: "escalations this hour", value: used, op: "<", bound: max } : { name: "risk", value: r3(v.risk), op: "≥", bound: policy.budgetRiskFloor });
    if (used < max) out.push({ name: "risk", value: r3(v.risk) });
  }
  // The model and antibody detectors that fired (the platform's own ids, such as review:too-large, only repeat the rule).
  const fired = v.detectors.filter((d) => /^(clef|antibody|llm|danger):/.test(d));
  if (fired.length > 0) out.push({ name: "detectors", value: clip(fired.join(", ")) });
  const guarded = input.protected ?? [];
  if (guarded.length > 0) out.push({ name: "protected paths", value: guarded.length });
  return out;
}

/** The gate check's record of a verdict: its rule, the colony's preset then, and the values the rule compared. */
export function gateRecord(v: GateVerdict, ctx: RuleContext): GateRecord {
  const code = v.rule.split(" ")[0] ?? "";
  const values = v.action === "land" ? landingValues(code, v, ctx) : otherValues(v, ctx);
  return { rule: v.rule, preset: presetOf(ctx.policy).preset, values };
}
