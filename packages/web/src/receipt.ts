import type { NoteDecision } from "@fire_trident/core";

/**
 * The review receipt in the web app (packages/worker/src/decide/receipt.ts): the head a decision was made on, the digest of
 * the view of the change its decider was shown (clipped when it left changed lines out) and, for a person, whether the
 * name was verified by Access or only stated. The review card shows the head and digest its decision will record, the
 * Why tab shows each recorded decision's, and the decision's toast says how the person was recorded. The words follow
 * `ft why` and `ft verify` (packages/cli/src/receipt.ts). Pure.
 */

/** A receipt as the page shows it: short forms for the line, full values for the tooltip. */
export interface ReceiptView {
  head: string | null;
  headFull: string | null;
  /** "sha256:" and the first 16 hex digits, or null when no view was kept. */
  digest: string | null;
  digestFull: string | null;
  /** Which view the decider was shown, in words. */
  view: string;
  clipped: boolean;
  seen: string;
  /** A person's decision: "verified by Access", "stated, not verified", or "" when the note does not say. */
  identity: string;
}

const VIEW_WORDS: Record<string, string> = { "reflex-state": "the reflex's diff", "prompt-diff": "the prompt's diff", "review-card": "the review card" };

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const line = (v: unknown, max = 200): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

/** A receipt from a head and a `shown` record, or null when there is neither. */
function viewOf(head: unknown, shown: unknown, identity: unknown): ReceiptView | null {
  const h = typeof head === "string" && /^[0-9a-f]{40,64}$/.test(head) ? head : null;
  const s = isRecord(shown) ? shown : null;
  const id = identity === "verified" ? "verified by Access" : identity === "stated" ? "stated, not verified" : "";
  if (!h && !s && !id) return null;
  const digest = s && typeof s.digest === "string" && /^sha256:[0-9a-f]{64}$/.test(s.digest) ? s.digest : null;
  return {
    head: h ? h.slice(0, 12) : null,
    headFull: h,
    digest: digest ? digest.slice(0, 23) : null,
    digestFull: digest,
    view: s ? (VIEW_WORDS[line(s.view)] ?? (line(s.view, 40) || "a view")) : "",
    clipped: s?.clipped === true,
    seen: s ? line(s.seen, 300) : "",
    identity: id,
  };
}

/** One recorded decision's receipt (the Why tab), or null for a note written before receipts. */
export function decisionReceipt(d: NoteDecision | null | undefined): ReceiptView | null {
  if (!d) return null;
  return viewOf(d.head, d.shown, d.layer === "human" ? d.identity : undefined);
}

/** The receipt a review card serves (`reviewReceipt` on a queue item), or null from an older server. */
export function cardReceipt(item: unknown): ReceiptView | null {
  const r = isRecord(item) && isRecord(item.reviewReceipt) ? item.reviewReceipt : null;
  return r ? viewOf(r.head, r.shown, undefined) : null;
}

/** A receipt in one line: "at head 1a2b3c4d5e6f · shown the review card sha256:… · clipped: saw 3 of 5 files". */
export function receiptText(r: ReceiptView): string {
  const parts = [
    r.identity,
    r.head ? `at head ${r.head}` : "",
    r.view ? `shown ${r.view}${r.digest ? ` ${r.digest}` : ": no view was kept"}` : "",
    r.clipped ? `clipped${r.seen ? `: ${r.seen}` : ""}` : "",
  ];
  return parts.filter(Boolean).join(" · ");
}

/** "8 of 11 decisions kept (the 3 earliest left out by the note's cap)", from the oldest kept decision; null when none were left out. */
export function earlierText(decisions: readonly unknown[]): string | null {
  const first = decisions[0];
  const earlier = isRecord(first) && typeof first.earlier === "number" && Number.isInteger(first.earlier) && first.earlier > 0 ? first.earlier : 0;
  return earlier ? `${decisions.length} of ${decisions.length + earlier} decisions kept (the ${earlier} earliest left out by the note's cap)` : null;
}

/** What a decision's answer says about the name the server recorded, as a sentence for the toast; null when it says nothing. */
export function recordedText(res: unknown): string | null {
  const r = isRecord(res) && isRecord(res.recorded) ? res.recorded : null;
  if (!r || typeof r.by !== "string") return null;
  const who = line(r.by);
  if (r.identity === "verified") return `Recorded as ${who}, verified by Access.`;
  const why = line(r.why);
  return `Recorded as ${who}, stated and not verified${why ? `: ${why}` : ""}.`;
}
