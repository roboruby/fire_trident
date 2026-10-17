import type { Intent, Proposal } from "@fire_trident/core";
import type { ApiRequest } from "./api.ts";
import type { Colors } from "./format.ts";

/**
 * The audit sample and blind canaries in the CLI (packages/worker/src/colony/audit.ts on the server). A share of the
 * changes that landed without a person (a proof, a reproduction, a model's approval, earned autonomy) is put in front of
 * a person after it landed: `ft review` lists them after the escalations, marked AUDIT, and `ft audit` shows the
 * measures, sets the rates, and answers an item. A decided blind canary is revealed in the decision's answer.
 */

/** One `ft audit` invocation. */
export type AuditCommand =
  | { name: "audit"; colony: string; action: "show" }
  | { name: "audit"; colony: string; action: "rates"; auditRate?: number; canaryRate?: number }
  | { name: "audit"; colony: string; action: "answer"; proposalId: string; verdict: "fine" | "should-not-have-landed"; reason: string; revert: boolean; by?: string };

/** The options `ft audit` takes. */
export const AUDIT_OPTIONS: Record<string, { type: "string" | "boolean" }> = {
  rate: { type: "string" },
  "canary-rate": { type: "string" },
  reason: { type: "string" },
  revert: { type: "boolean" },
  by: { type: "string" },
};

/** How `ft audit` is used. */
export const AUDIT_USAGE = "ft audit <colony> [--rate <percent>] [--canary-rate <percent>] | ft audit <colony> <proposalId> fine|wrong [--reason <text>] [--revert] [--by <name>]";

/** The most either rate may be, in percent. */
const MAX_PERCENT = 20;

const text = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** A rate in percent ("5", "5%", "0.5") as a share (0.05); a usage error as a string. */
export function percentArg(v: string, flag: string): number | string {
  const m = /^\s*(\d+(?:\.\d+)?)\s*%?\s*$/.exec(v);
  const n = m ? Number(m[1]) : NaN;
  if (!Number.isFinite(n) || n > MAX_PERCENT) return `--${flag} is a percent from 0 to ${MAX_PERCENT} (3 is 3%), got "${v}"`;
  return Math.round(n * 1000) / 100_000;
}

/** Flags given that the action does not take, as a usage error; null when there are none. */
function stray(v: Record<string, unknown>, allowed: readonly string[], context: string): string | null {
  const extra = Object.keys(v).filter((k) => !allowed.includes(k) && Object.hasOwn(AUDIT_OPTIONS, k) && v[k] !== undefined);
  return extra.length > 0 ? `--${extra[0]} does not apply to ${context}. Usage: ${AUDIT_USAGE}` : null;
}

/** `ft audit ...`, parsed; a usage error as a string. */
export function parseAuditCommand(v: Record<string, unknown>, p: string[]): AuditCommand | string {
  const colony = p[0];
  if (!colony) return `missing <colony>. Usage: ${AUDIT_USAGE}`;
  if (p.length === 1) {
    const rate = text(v.rate);
    const canary = text(v["canary-rate"]);
    if (rate === undefined && canary === undefined) return stray(v, [], "showing the audit") ?? { name: "audit", colony, action: "show" };
    const bad = stray(v, ["rate", "canary-rate"], "setting the rates");
    if (bad) return bad;
    const cmd: Extract<AuditCommand, { action: "rates" }> = { name: "audit", colony, action: "rates" };
    if (rate !== undefined) {
      const r = percentArg(rate, "rate");
      if (typeof r === "string") return r;
      cmd.auditRate = r;
    }
    if (canary !== undefined) {
      const r = percentArg(canary, "canary-rate");
      if (typeof r === "string") return r;
      cmd.canaryRate = r;
    }
    return cmd;
  }
  if (p.length > 3) return `unexpected argument "${p[3]}". Usage: ${AUDIT_USAGE}`;
  const proposalId = p[1]!.trim();
  const word = p[2];
  const verdict = word === "fine" ? "fine" : word === "wrong" || word === "should-not-have-landed" ? "should-not-have-landed" : null;
  if (!verdict) return word ? `answer fine or wrong (should not have landed), got "${word}". Usage: ${AUDIT_USAGE}` : `missing the answer: fine or wrong. Usage: ${AUDIT_USAGE}`;
  const bad = stray(v, ["reason", "revert", "by"], "answering an audit item");
  if (bad) return bad;
  const reason = text(v.reason)?.trim() ?? "";
  if (verdict === "should-not-have-landed" && !reason) return "--reason is required for wrong: say why it should not have landed (it goes with the answer and the revert)";
  if (verdict === "fine" && v.revert === true) return "--revert goes with wrong: a change that was fine to land stays";
  const by = text(v.by)?.trim();
  return { name: "audit", colony, action: "answer", proposalId, verdict, reason, revert: v.revert === true, ...(by ? { by } : {}) };
}

/** The HTTP call of an `ft audit` command. */
export function auditRequest(cmd: AuditCommand, by: string, colonyPath: (colony: string, suffix: string) => string): ApiRequest {
  if (cmd.action === "show") return { method: "GET", path: colonyPath(cmd.colony, "/audit") };
  if (cmd.action === "rates") {
    return { method: "POST", path: colonyPath(cmd.colony, "/decide/policy"), body: { ...(cmd.auditRate !== undefined ? { auditRate: cmd.auditRate } : {}), ...(cmd.canaryRate !== undefined ? { canaryRate: cmd.canaryRate } : {}) } };
  }
  return {
    method: "POST",
    path: colonyPath(cmd.colony, `/audit/${encodeURIComponent(cmd.proposalId)}`),
    body: { verdict: cmd.verdict, reason: cmd.reason, by: cmd.by ?? by, ...(cmd.revert ? { revert: true } : {}) },
  };
}

/** Server text on one terminal line: no control characters. */
function plain(s: unknown, max = 400): string {
  return typeof s === "string" ? s.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const pct = (share: number): string => `${Math.round(share * 1000) / 10}%`;
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** What `ft audit` prints. */
export function formatAudit(cmd: AuditCommand, res: unknown, c: Colors): string {
  const r = obj(res);
  if (cmd.action === "answer") return plain(r.sentence, 1_000) || `Recorded: ${cmd.proposalId} ${cmd.verdict === "fine" ? "was fine" : "should not have landed"}.`;
  if (cmd.action === "rates") {
    const parts = [
      `Audit sample: ${pct(num(r.auditRate))} of the changes that land without a person go to a person after they land`,
      num(r.canaryRate) > 0 ? `blind canaries: about ${pct(num(r.canaryRate))} of escalations bring one` : "blind canaries off",
    ];
    return `${c.bold(cmd.colony)} ${parts.join("; ")}.`;
  }
  const out = [`${c.bold(cmd.colony)} audit sample ${pct(num(r.rate))}, one item after every ${num(r.every) || 5} escalations in ft review`, `  ${plain(r.line) || "no audit report from this server"}`];
  const layers = obj(r.layers);
  for (const [layer, raw] of Object.entries(layers)) {
    const m = obj(raw);
    if (num(m.landed) === 0) continue;
    const wrong = num(m.audited) > 0 ? `, ${num(m.wrong)} should not have landed (${Math.round(num(m.lo) * 100)}–${Math.round(num(m.hi) * 100)}%)` : "";
    out.push(`  ${c.dim(`${plain(m.label) || layer}:`.padEnd(30))} ${num(m.audited)} of ${num(m.landed)} audited${wrong}${num(m.pending) > 0 ? `, ${num(m.pending)} waiting` : ""}`);
  }
  const canaries = obj(r.canaries);
  if (plain(canaries.line)) out.push(`  ${plain(canaries.line)}`);
  const reviewers = obj(r.reviewers);
  if (plain(reviewers.line)) out.push(`  ${c.dim("people:")} ${plain(reviewers.line)}`);
  const waiting = Array.isArray(r.waiting) ? r.waiting.map(obj) : [];
  if (waiting.length > 0) {
    out.push("", `${waiting.length} waiting for a person:`);
    for (const w of waiting.slice(0, 20)) out.push(`  ${c.magenta(plain(w.proposalId, 80))}  ${c.dim(`landed by ${plain(w.rule, 80)}`)}`);
    out.push(c.dim(`Answer with: ft audit ${cmd.colony} <proposalId> fine | wrong --reason <text> [--revert]`));
  }
  return out.join("\n");
}

/** The audit mark of a review queue item, or null for an escalation. */
export function auditMark(p: Proposal): { rule: string; label: string; landedBy: string; landingId: string } | null {
  const a = obj((p as Proposal & { audit?: unknown }).audit);
  if (a.kind !== "audit") return null;
  return { rule: plain(a.rule, 80), label: plain(a.label, 60), landedBy: plain(a.landedBy), landingId: plain(a.landingId, 80) };
}

/** The review queue's escalations and its audit items, apart. */
export function splitAudits(items: readonly Proposal[]): { escalations: Proposal[]; audits: Proposal[] } {
  const escalations: Proposal[] = [];
  const audits: Proposal[] = [];
  for (const p of items) (auditMark(p) ? audits : escalations).push(p);
  return { escalations, audits };
}

/** `ft review`'s lines for the audit items: after the escalations, each marked AUDIT with what landed it. */
export function auditLines(audits: readonly Proposal[], intents: Intent[] | undefined, c: Colors, colony: string): string[] {
  if (audits.length === 0) return [];
  const byId = new Map((intents ?? []).map((i) => [i.id, i]));
  const out = ["", `${c.bold(String(audits.length))} landed change${audits.length === 1 ? "" : "s"} from the audit sample: no person saw ${audits.length === 1 ? "it" : "them"} before ${audits.length === 1 ? "it" : "they"} landed`];
  for (const p of audits) {
    const m = auditMark(p)!;
    const title = byId.get(p.intentId)?.title ?? p.declared?.summary ?? p.intentId;
    out.push("", `${c.green("AUDIT")} ${c.magenta(p.id)}  ${plain(title, 60)}  ${c.dim(`${p.agentId} · ${p.writeSet.length} file(s) · ${m.landingId}`)}`);
    out.push(`  ${m.landedBy}`);
  }
  out.push("", c.dim(`Answer with: ft audit ${colony} <proposalId> fine | wrong --reason <text> [--revert]`));
  return out;
}

/** A decided blind canary in a decision's answer, as the lines `ft review` prints; empty for an ordinary decision. */
export function canaryLines(res: unknown, c: Colors): string[] {
  const k = obj(obj(res).canary);
  const sentence = plain(k.sentence, 1_000);
  if (!sentence || (k.outcome !== "caught" && k.outcome !== "approved")) return [];
  return [k.outcome === "caught" ? c.green(sentence) : c.yellow(sentence)];
}
