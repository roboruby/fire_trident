import type { CheckResult, DecisionKind, DecisionLayer } from "@fire_trident/core";

/** One step of a decision path; `p` is NaN when the layer reported no probability. */
export interface DecisionStep {
  kind: DecisionKind;
  layer: DecisionLayer;
  p: number;
  action: string;
  at: number;
}

/**
 * The decision chain the reflex and LLM layers wrote into a proposal's evidence, as checks named
 * "reflex: <model>" (detail ends with "confidence 0.93") and "llm: <model>" (detail starts with
 * the verdict). Used when no decision events or recorded decisions are at hand.
 */
export function decisionsFromChecks(checks: readonly CheckResult[] | undefined): DecisionStep[] {
  const out: DecisionStep[] = [];
  for (const c of checks ?? []) {
    const m = /^(reflex|llm):/i.exec(c.name);
    if (!m) continue;
    const detail = c.detail ?? "";
    if (m[1]?.toLowerCase() === "reflex") {
      const conf = /confidence\s+([0-9.]+)/.exec(detail);
      out.push({ kind: "triage", layer: "reflex", p: conf ? Number(conf[1]) : Number.NaN, action: c.ok ? "pass" : "escalate", at: 0 });
    } else {
      const verdict = /^(approve|return|escalate)/i.exec(detail)?.[1]?.toLowerCase() ?? (c.ok ? "approve" : "escalate");
      out.push({ kind: "triage", layer: "llm", p: Number.NaN, action: verdict, at: 0 });
    }
  }
  return out;
}
