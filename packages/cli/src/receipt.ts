import type { NoteDecision } from "@fire_trident/core";
import type { Colors } from "./format.ts";

/**
 * The review receipt in the CLI (packages/worker/src/decide/receipt.ts): each decision a lineage note keeps records the
 * proposal head it was made on, a digest of the view of the change the decider was shown (clipped when it left changed
 * lines out) and, for a person, whether the name was verified by Access or only stated; the oldest kept decision says how
 * many earlier ones the note's cap left out. `ft verify --commit` prints one line a decision after the answerable line,
 * as scripts/verify_note.mjs does (test/receipt-git.test.ts holds them in step), and `ft why` shows the same under each
 * change. Notes written before receipts print nothing new. Pure.
 */

/** Receipt lines `ft verify` prints for one note at most; the rest are counted. */
export const MAX_RECEIPT_LINES = 50;

const VIEW_WORDS: Record<string, string> = { "reflex-state": "the reflex's diff", "prompt-diff": "the prompt's diff", "review-card": "the review card" };

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const line = (v: unknown, max = 200): string => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");

/** Whether a decision carries any part of a receipt. */
function hasReceipt(d: Record<string, unknown>): boolean {
  return typeof d.head === "string" || isRecord(d.shown) || d.identity === "verified" || d.identity === "stated";
}

/** How a person's decision names them: "(verified by Access)", "(stated, not verified)", or "" when the note does not say. */
export function identityWords(identity: unknown): string {
  return identity === "verified" ? "(verified by Access)" : identity === "stated" ? "(stated, not verified)" : "";
}

/** What the decider was shown, in words: "shown the review card sha256:<16 hex>", ", clipped: <how much>" when clipped. */
export function shownWords(shown: unknown): string {
  if (!isRecord(shown)) return "";
  const view = VIEW_WORDS[line(shown.view)] ?? (line(shown.view, 40) || "a view");
  const digest = typeof shown.digest === "string" && /^sha256:[0-9a-f]{64}$/.test(shown.digest) ? ` ${shown.digest.slice(0, 23)}` : ": no view was kept";
  const seen = line(shown.seen);
  return `shown ${view}${digest}${shown.clipped === true ? `, clipped${seen ? `: ${seen}` : ""}` : ""}`;
}

/** One decision's receipt after "<layer> <action> by <who>": the identity words, the head and what it was shown. */
export function receiptText(d: Record<string, unknown>): string {
  const by = line(d.by) || "unnamed";
  const who = d.layer === "human" ? [by, identityWords(d.identity)].filter(Boolean).join(" ") : by;
  const head = typeof d.head === "string" && /^[0-9a-f]{40,64}$/.test(d.head) ? ` at head ${d.head.slice(0, 12)}` : "";
  const shown = shownWords(d.shown);
  return `${line(d.layer, 20) || "?"} ${line(d.action, 20) || "?"} by ${who}${head}${shown ? `, ${shown}` : ""}`;
}

/** "8 of 11 decisions kept (the 3 earliest left out by the note's cap)", from the oldest kept decision; null when none were left out. */
export function earlierWords(decisions: readonly unknown[]): string | null {
  const first = decisions[0];
  const earlier = isRecord(first) && typeof first.earlier === "number" && Number.isInteger(first.earlier) && first.earlier > 0 ? first.earlier : 0;
  if (earlier === 0) return null;
  return `${decisions.length} of ${decisions.length + earlier} decisions kept (the ${earlier} earliest left out by the note's cap)`;
}

/** The receipt lines of a note (each "receipt: <proposal id> …"), at most `max` and then a count; none for a note before receipts. */
export function receiptLines(note: unknown, max = MAX_RECEIPT_LINES): string[] {
  if (!isRecord(note)) return [];
  const out: string[] = [];
  for (const p of Array.isArray(note.proposals) ? note.proposals : []) {
    if (!isRecord(p)) continue;
    const id = line(p.id, 100) || "?";
    const ds = (Array.isArray(p.decisions) ? p.decisions : []).filter(isRecord);
    const earlier = earlierWords(ds);
    if (earlier) out.push(`receipt: ${id} ${earlier}`);
    for (const d of ds) if (hasReceipt(d)) out.push(`receipt: ${id} ${receiptText(d)}`);
  }
  return out.length > max ? [...out.slice(0, max), `receipt: and ${out.length - max} more (ft why shows each change's)`] : out;
}

/** `ft why`'s receipt rows under one change: the cap's count, then one row a decision that carries a receipt. */
export function receiptRows(decisions: readonly NoteDecision[] | undefined, c: Colors): Array<{ k: string; v: string }> {
  const ds = (decisions ?? []).filter((d): d is NoteDecision => isRecord(d));
  const rows: Array<{ k: string; v: string }> = [];
  const earlier = earlierWords(ds);
  if (earlier) rows.push({ k: "receipt", v: c.dim(earlier) });
  for (const d of ds) if (hasReceipt(d as unknown as Record<string, unknown>)) rows.push({ k: "receipt", v: receiptText(d as unknown as Record<string, unknown>) });
  return rows;
}

/**
 * The receipt line of a review card (`ft review`): the head the decision will be bound to and the digest of the view the
 * card serves, as the person's decision records them; null for a queue item without one (an older server).
 */
export function cardReceiptLine(item: unknown, c: Colors): string | null {
  const r = isRecord(item) && isRecord(item.reviewReceipt) ? item.reviewReceipt : null;
  if (!r) return null;
  const head = typeof r.head === "string" && /^[0-9a-f]{40,64}$/.test(r.head) ? `head ${r.head.slice(0, 12)}` : "";
  const kept = isRecord(r.shown) && typeof r.shown.digest === "string";
  const shown = kept ? shownWords(r.shown).replace(/^shown the review card/, "view") : "no view kept";
  const text = [head, shown].filter(Boolean).join(" · ");
  return text ? `  ${c.dim("receipt ")} ${c.dim(text)}` : null;
}

/** What a decision answer says about the name it recorded (with Access verification configured), in one line; null when it says nothing. */
export function recordedLine(res: unknown, c: Colors): string | null {
  const r = isRecord(res) && isRecord(res.recorded) ? res.recorded : null;
  if (!r || typeof r.by !== "string") return null;
  const who = line(r.by);
  if (r.identity === "verified") return c.dim(`  Recorded as ${who}, verified by Access.`);
  const why = line(r.why);
  return c.dim(`  Recorded as ${who}, stated and not verified${why ? `: ${why}` : ""}.`);
}
