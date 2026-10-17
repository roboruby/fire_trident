import type { Proposal } from "@fire_trident/core";

/**
 * The audit sample and blind canaries on the review tab (worker colony/audit.ts): the review queue carries a few
 * changes that landed without a person among the escalations, each marked `audit`, so a person keeps seeing ordinary
 * landings; and a decision on a blind canary answers with what it was. Read defensively: an older server sends neither.
 */

/** What makes a queue item an audit item: the layer and rule that landed it, and its landing. */
export interface AuditMark {
  layer: string;
  /** How the layer is named ("a deterministic proof", "earned autonomy"). */
  label: string;
  rule: string;
  /** "Already landed by D3 innate+proof (a deterministic proof)." */
  landedBy: string;
  landingId: string;
  landedAt: number;
}

/** A person's answer to an audit item. */
export type AuditVerdict = "fine" | "should-not-have-landed";

const text = (v: unknown, max = 300): string => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim().slice(0, max) : "");
const time = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** The audit mark of a queue item; null for an escalation (or an item that does not read as one). */
export function auditOf(p: Proposal): AuditMark | null {
  const a = (p as Proposal & { audit?: unknown }).audit;
  if (!a || typeof a !== "object" || Array.isArray(a)) return null;
  const o = a as Record<string, unknown>;
  if (o.kind !== "audit" || typeof o.layer !== "string") return null;
  const rule = text(o.rule, 80);
  return {
    layer: text(o.layer, 40),
    label: text(o.label, 60) || text(o.layer, 40),
    rule,
    landedBy: text(o.landedBy) || `Already landed by ${rule || "the gate"}.`,
    landingId: text(o.landingId, 80),
    landedAt: time(o.landedAt),
  };
}

/** The queue's escalations and its audit items, apart, each in the queue's order. */
export function splitQueue(items: readonly Proposal[]): { escalations: Proposal[]; audits: Proposal[] } {
  const escalations: Proposal[] = [];
  const audits: Proposal[] = [];
  for (const p of items) (auditOf(p) ? audits : escalations).push(p);
  return { escalations, audits };
}

/** A decided canary, as the decision's answer reveals it; null for an ordinary decision (or an older server). */
export function canaryOf(res: unknown): { outcome: "caught" | "approved"; sentence: string } | null {
  if (!res || typeof res !== "object") return null;
  const c = (res as { canary?: unknown }).canary;
  if (!c || typeof c !== "object") return null;
  const o = c as Record<string, unknown>;
  const sentence = text(o.sentence, 1_000);
  if (!sentence || (o.outcome !== "caught" && o.outcome !== "approved")) return null;
  return { outcome: o.outcome, sentence };
}

/** What an answer to an audit item did, said back: the server's sentence, else a plain one. */
export function auditDoneText(res: unknown, verdict: AuditVerdict): string {
  const sentence = res && typeof res === "object" ? text((res as { sentence?: unknown }).sentence, 1_000) : "";
  if (sentence) return sentence;
  return verdict === "fine" ? "Recorded as fine." : "Recorded: it should not have landed. Revert it with ft revert if it is still on trunk.";
}
