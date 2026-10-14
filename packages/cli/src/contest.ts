import type { CheckResult, LineageNote } from "@fire_trident/core";
import type { Colors } from "./format.ts";

/**
 * Contest mode in `ft why`: how a landed change won its contest (the `contest` check the colony adds to its evidence:
 * the deterministic evidence, the judge's answer in both orders, or the jury's votes) and the other attempts at its
 * intent it was chosen over (the note's `alternatives`, each with why it lost). Notes of changes that won no contest
 * have neither, and print nothing here.
 */

/** The other attempts a winner's note keeps, as the note writes them. */
type Alternatives = LineageNote["proposals"][number]["alternatives"];

/** One line, collapsed whitespace, at most `max` characters. */
function oneLine(s: string, max: number): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * The `contest` and `also` lines of a landed change: the contest check's detail (how it won), then one line per
 * alternative (the proposal, its agent and model, why it lost). Empty when the change won no contest. Alternatives
 * are read defensively: an entry without a proposal id is skipped.
 */
export function contestLines(checks: CheckResult[] | undefined, alternatives: Alternatives | undefined, c: Colors): Array<{ k: string; v: string }> {
  const out: Array<{ k: string; v: string }> = [];
  const won = (checks ?? []).find((k) => k && k.name === "contest");
  if (won?.detail) out.push({ k: "contest", v: oneLine(won.detail, 400) });
  for (const a of Array.isArray(alternatives) ? alternatives : []) {
    if (!a || typeof a !== "object" || typeof a.proposalId !== "string" || a.proposalId === "") continue;
    const who = `${a.proposalId} ${c.dim("by")} ${typeof a.agentId === "string" ? a.agentId : "?"}${typeof a.model === "string" && a.model ? c.dim(` (${a.model})`) : ""}`;
    const why = typeof a.reason === "string" && a.reason.trim() !== "" ? `: ${oneLine(a.reason, 300)}` : "";
    out.push({ k: "also", v: `${who}${why}` });
  }
  return out;
}
