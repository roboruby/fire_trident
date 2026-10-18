import type { NoteAcceptance, NoteDecision } from "@fire_trident/core";
import type { Colors } from "./format.ts";

/**
 * Quoted acceptance in `ft why` (FT_QUOTED_ACCEPTANCE): which changed line the second opinion quoted for each acceptance
 * line, and what the platform counted. Notes written before it, or by a colony without the flag, have none.
 */

/** One line of text, cut to `max` characters. */
function one(s: unknown, max: number): string {
  const t = typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "";
  const chars = [...t];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : t;
}

/** The acceptance entries of a note's decisions (the latest decision that has them), the malformed ones left out. */
function entries(decisions: readonly NoteDecision[] | undefined): NoteAcceptance[] {
  const list = Array.isArray(decisions) ? decisions : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const a = (list[i] as { acceptance?: unknown } | undefined)?.acceptance;
    if (Array.isArray(a) && a.length > 0) {
      return a.filter((x): x is NoteAcceptance => !!x && typeof x === "object" && typeof (x as NoteAcceptance).line === "string" && typeof (x as NoteAcceptance).verdict === "string");
    }
  }
  return [];
}

/**
 * The rows `ft why` prints under a proposal's decisions: one per acceptance line, its mark (met, not met, unclear), its
 * place ("line 2", "keep line 1"), the line itself, and the file and changed line quoted for it, that it rests on the
 * model's word (a line stating an absence), that FireTrident checked it itself in the files (the review view, with what it
 * found), what the model saw for a line not met, or why a "met" did not count. Empty when the note keeps no acceptance lines.
 */
export function acceptanceRows(decisions: readonly NoteDecision[] | undefined, c: Colors): Array<{ k: string; v: string }> {
  const lines = entries(decisions);
  const seen = { intent: 0, keep: 0 };
  return lines.map((l, i) => {
    const kind = l.kind === "keep" ? "keep" : "intent";
    seen[kind]++;
    const mark = l.verdict === "met" ? c.green("✓") : l.verdict === "not met" ? c.red("✗") : c.yellow("?");
    const where = `${kind === "keep" ? "keep line" : "line"} ${seen[kind]}`;
    const what = `${mark} ${where} "${one(l.line, 80)}"`;
    const evidence =
      l.basis === "checked"
        ? l.verdict === "met"
          ? `${c.dim("checked by FireTrident:")} ${one(l.path, 60)}${l.quote ? ` ${one(l.quote, 90)}` : ""}`
          : (l.verdict === "not met" ? c.red : c.yellow)(`${l.verdict}: checked by FireTrident${l.problem ? `: ${one(l.problem, 140)}` : ""}`)
        : l.verdict === "met"
          ? l.basis === "absence"
            ? c.dim("model's word (it states an absence, so there is no changed line to quote)")
            : `${c.dim(`${one(l.path, 60)}:`)} "${one(l.quote, 90)}"`
          : l.verdict === "not met"
            ? `${c.red("not met")}${l.quote ? c.dim(` (it saw ${l.path ? `${one(l.path, 60)}: ` : ""}"${one(l.quote, 90)}")`) : ""}`
            : c.yellow(`unclear${l.problem ? `: ${l.said ? `answered ${l.said} but ` : ""}${one(l.problem, 100)}` : ""}`);
    const from = kind === "keep" && typeof l.landingId === "string" ? c.dim(` (from ${l.landingId})`) : "";
    return { k: i === 0 ? "accept" : "", v: `${what}${from}  ${evidence}` };
  });
}
