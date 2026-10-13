import type { EscalationDecision, IntentAmend } from "./api.ts";

/** The answer form on an agent's report: what an "amend" changes, and whether an answer can be sent. */

/** The fields of the amend form as typed: the footprint is one path per line (commas also split). */
export interface AmendDraft {
  title: string;
  why: string;
  footprint: string;
}

/** Paths typed into the footprint field: one per line or comma, trimmed, no leading "./" or "/", no repeats. */
export function parseFootprint(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[\n,]+/)) {
    const path = raw.trim().replace(/^\.?\/+/, "");
    if (path && !out.includes(path)) out.push(path);
  }
  return out;
}

/** What an answer of "amend" changes: only the fields that differ from the intent now; null when none does. */
export function amendOf(current: { title: string; why?: string; footprint: readonly string[] }, draft: AmendDraft): IntentAmend | null {
  const out: IntentAmend = {};
  const title = draft.title.trim();
  if (title && title !== current.title.trim()) out.title = title;
  const why = draft.why.trim();
  if (why && why !== (current.why ?? "").trim()) out.why = why;
  const footprint = parseFootprint(draft.footprint);
  const same = footprint.length === current.footprint.length && footprint.every((p, i) => p === current.footprint[i]);
  if (footprint.length && !same) out.footprint = footprint;
  return Object.keys(out).length ? out : null;
}

/** Why an answer cannot be sent yet (the button's hint), or null when it can. */
export function blockedAnswer(decision: EscalationDecision, note: string, amend: IntentAmend | null): string | null {
  if (!note.trim()) return "Write a note first: it is recorded with your answer.";
  if (decision === "amend" && !amend) return "Change the title, the why or the footprint first.";
  return null;
}

/** What an answer did, said back to the person who sent it. */
export function answeredText(decision: EscalationDecision): string {
  if (decision === "amend") return "Amended. Agents can take the intent again at its new revision.";
  if (decision === "withdraw") return "Withdrawn. The intent is called off and stays in history with your note.";
  return "Dismissed. The intent stands as written, and agents can take it again.";
}
