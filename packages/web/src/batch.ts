import type { Proposal } from "@fire_trident/core";
import { fmtInt, plural } from "./format.ts";
import type { ReviewView } from "./review.ts";

/**
 * Escalation batching on the review page (worker decide/batch.ts, FT_ESCALATION_BATCH). Past a colony's hourly budget for
 * the escalations the alert budget cannot send back, the queue marks the changes that escalated for the same reason
 * with one `batch`, and the page shows them as one card: their count, each change listed, and approve all, reject all
 * or open each. Each change still waits for a person: an answer for the card is the person's decision on each change it
 * lists. Everything is read defensively; a queue without batches reads as before.
 */

/** A batch as each of its waiting changes carries it (`batch` on a review queue item). */
export interface ReviewBatch {
  /** Short id, the one `ft review <colony> --approve-batch` takes; "" from a server that sends none. */
  id: string;
  key: string;
  rule: string;
  /** Completes "12 changes ...": "hit the danger pattern capability (network)". */
  label: string;
  /** The hourly budget that was spent. */
  budget: number;
  ids: string[];
}

/** The batch a queue item carries, checked field by field; null when it carries none. */
export function batchOf(item: Proposal): ReviewBatch | null {
  const v = (item as Proposal & { batch?: unknown }).batch;
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.key !== "string" || o.key === "" || typeof o.label !== "string" || o.label === "") return null;
  const ids = Array.isArray(o.ids) ? o.ids.filter((x): x is string => typeof x === "string" && x !== "") : [];
  const budget = typeof o.budget === "number" && Number.isFinite(o.budget) && o.budget > 0 ? Math.floor(o.budget) : 0;
  return { id: typeof o.id === "string" ? o.id : "", key: o.key, rule: typeof o.rule === "string" ? o.rule : "", label: o.label, budget, ids };
}

/** One batch card: the batch and its changes still in the queue, in queue order. */
export interface BatchGroup {
  batch: ReviewBatch;
  members: Proposal[];
}

/** The batch cards of a queue, in the order of each batch's first change: a batch with fewer than two changes left is none. */
export function groupBatches(items: readonly Proposal[]): BatchGroup[] {
  const groups = new Map<string, BatchGroup>();
  for (const p of items) {
    const b = batchOf(p);
    if (!b) continue;
    const g = groups.get(b.key) ?? { batch: b, members: [] };
    g.members.push(p);
    groups.set(b.key, g);
  }
  return [...groups.values()].filter((g) => g.members.length >= 2);
}

/** The card's title: "12 changes hit the danger pattern capability (network)". */
export function batchHeadline(g: BatchGroup): string {
  return `${plural(g.members.length, "change")} ${g.batch.label}`;
}

/** Why these changes share a card, and what an answer for it does. */
export function batchWhy(b: ReviewBatch): string {
  const budget = b.budget > 0 ? `its budget of ${fmtInt(b.budget)}` : "its budget";
  return `Past ${budget} an hour for escalations the alert budget cannot send back, this colony puts changes that escalate for the same reason on one card. A person still decides each change: approving or rejecting all records your decision on every change listed here.`;
}

/** The line a change shows in a batch card: its first danger pattern, else its reason. */
export function batchMemberLine(p: Proposal, view: ReviewView | null): string {
  const danger = view?.danger.find((d) => d.label !== "")?.label;
  if (danger) return danger;
  const reason = typeof p.reason === "string" ? p.reason.replace(/^escalated by \w+: /, "") : "";
  return reason.length > 160 ? `${reason.slice(0, 159)}…` : reason;
}

/** What an answer for a batch did, as the server sends it. */
export interface BatchAnswer {
  decided: string[];
  skipped: Array<{ id: string; why: string }>;
}

/** An answer as the server sent it, checked field by field. */
export function batchAnswerOf(raw: unknown): BatchAnswer {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const decided = Array.isArray(o.decided) ? o.decided.filter((x): x is string => typeof x === "string") : [];
  const skipped = Array.isArray(o.skipped)
    ? o.skipped
        .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
        .map((x) => ({ id: typeof x.id === "string" ? x.id : "", why: typeof x.why === "string" ? x.why : "" }))
        .filter((x) => x.id !== "")
    : [];
  return { decided, skipped };
}

/** What happened, said back to the reviewer. */
export function batchDoneText(decision: "approve" | "reject", a: BatchAnswer): string {
  const done =
    a.decided.length === 0
      ? "Nothing was decided: none of these changes still waits in this batch."
      : decision === "approve"
        ? `Approved ${plural(a.decided.length, "change")}. Each rejoins its lane and lands on the next cycle.`
        : `Rejected ${plural(a.decided.length, "change")}. Your reason is now one antibody, from the first of them.`;
  return a.skipped.length === 0 ? done : `${done} ${plural(a.skipped.length, "change")} left alone: ${a.skipped[0]!.why}.`;
}
