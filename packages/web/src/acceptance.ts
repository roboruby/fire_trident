import type { NoteDecision } from "@fire_trident/core";

/**
 * Quoted acceptance in the Why panel (FT_QUOTED_ACCEPTANCE): each acceptance line a second opinion answered, the changed
 * line it quoted, and what the platform counted. Read defensively: notes written before it, or by a colony without the
 * flag, have none, and odd entries are left out.
 */

/** One acceptance line as the Why panel shows it. */
export interface AcceptanceRow {
  /** "line 2" (the intent's own list) or "keep line 1" (the list of the newest landing by another intent on its files). */
  place: string;
  line: string;
  verdict: "met" | "not met" | "unclear";
  /** What a met rests on: a quote the platform found, or the model's word for a line stating an absence (absent on older notes). */
  basis?: "quote" | "absence";
  /** The file and the changed line quoted for it, when it was counted met. */
  path?: string;
  quote?: string;
  /** Why it is unclear, in words (the model's own answer and the platform's problem with its quote), or what the model saw for a line not met. */
  why?: string;
  /** Keep lines: the landing whose intent's list it comes from. */
  landingId?: string;
}

const str = (v: unknown): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");

/** The acceptance rows of one decision; empty when it has none. */
export function acceptanceOf(d: NoteDecision | null | undefined): AcceptanceRow[] {
  const raw = (d as { acceptance?: unknown } | null | undefined)?.acceptance;
  if (!Array.isArray(raw)) return [];
  const seen = { intent: 0, keep: 0 };
  const rows: AcceptanceRow[] = [];
  for (const x of raw) {
    if (!x || typeof x !== "object" || Array.isArray(x)) continue;
    const r = x as Record<string, unknown>;
    const line = str(r.line);
    const verdict = r.verdict === "met" || r.verdict === "not met" || r.verdict === "unclear" ? r.verdict : null;
    if (!line || !verdict) continue;
    const kind = r.kind === "keep" ? "keep" : "intent";
    seen[kind]++;
    const row: AcceptanceRow = { place: `${kind === "keep" ? "keep line" : "line"} ${seen[kind]}`, line, verdict };
    if (verdict === "met") {
      if (r.basis === "quote" || r.basis === "absence") row.basis = r.basis;
      if (str(r.path)) row.path = str(r.path);
      if (str(r.quote)) row.quote = str(r.quote);
    }
    const problem = str(r.problem);
    if (verdict === "unclear") row.why = problem ? `${str(r.said) ? `answered ${str(r.said)} but ` : ""}${problem}` : "the second opinion answered unclear";
    if (verdict === "not met" && str(r.quote)) row.why = `it saw ${str(r.path) ? `${str(r.path)}: ` : ""}"${str(r.quote)}"`;
    if (kind === "keep" && str(r.landingId)) row.landingId = str(r.landingId);
    rows.push(row);
  }
  return rows;
}
