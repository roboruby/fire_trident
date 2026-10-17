import { changeAnswerable, revalidationEnabled, type Id, type LineageNote } from "@fire_trident/core";
import { maskSecrets } from "./mask.ts";

/**
 * Credit trailers on landing commits (FT_CREDIT_TRAILERS). Above the FT trailers of a landing commit's last paragraph,
 *
 *   Co-authored-by: <agent name> <<agent id>@<colony id>.noreply.firetrident.dev>
 *   Approved-by: <person>
 *
 * one Co-authored-by for each agent whose change the commit lands (in the note's order), so git hosts list the agents as
 * co-authors, and one Approved-by for each person who approved one of its changes (a human `approve` decision in its
 * note, core/answerable.ts), when the note names them. The address is made from the agent id and the colony under a
 * no-reply domain: it is never a mailbox anyone reads, and never an address the agent gave. Names are text agents and
 * people wrote: they are put on one line, without angle brackets or control characters, at most NAME_CHARS long, and
 * masked where they look like a secret (trunk/mask.ts). The note's digest and signature trailers are added after these
 * (trunk/signature.ts, trunk/digest.ts), so FT-Note-Signature and FT-Note stay the last two lines.
 */

/** The no-reply domain agent addresses sit under, one subdomain per colony. */
export const COAUTHOR_DOMAIN = "noreply.firetrident.dev";
const NAME_CHARS = 80;

/** Whether FT_CREDIT_TRAILERS (`setting`: "on", or a comma-separated list of colony ids) covers the colony. */
export function creditsEnabled(setting: string | undefined, colonyId: Id): boolean {
  return revalidationEnabled(setting, colonyId);
}

/** A name on one line, without angle brackets or control characters, masked, at most NAME_CHARS; "" when nothing is left. */
function cleanName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const one = raw.replace(/[\u0000-\u001f\u007f-\u009f<>]+/g, " ").replace(/\s+/g, " ").trim();
  return maskSecrets(one).slice(0, NAME_CHARS).trim();
}

/** The no-reply address of an agent in a colony: its id as the local part, the colony as a subdomain of COAUTHOR_DOMAIN. */
export function agentAddress(agentId: Id, colonyId: Id): string {
  const local = String(agentId).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+|[.-]+$/g, "").slice(0, 64) || "agent";
  const label = String(colonyId).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63).replace(/-+$/, "") || "colony";
  return `${local}@${label}.${COAUTHOR_DOMAIN}`;
}

/**
 * The credit lines of a landing commit, from its lineage note: a Co-authored-by for each agent of its changes (named by
 * `nameOf`, else by its id), then an Approved-by for each named person who approved one of them, each once.
 */
export function creditLines(note: Pick<LineageNote, "colonyId" | "proposals">, nameOf: (agentId: Id) => string | undefined): string[] {
  const proposals = Array.isArray(note.proposals) ? note.proposals : [];
  const lines: string[] = [];
  const seen = new Set<string>();
  const add = (line: string): void => {
    if (seen.has(line)) return;
    seen.add(line);
    lines.push(line);
  };
  for (const p of proposals) {
    if (typeof p?.agentId !== "string" || p.agentId === "") continue;
    const name = cleanName(nameOf(p.agentId)) || cleanName(p.agentId) || "agent";
    add(`Co-authored-by: ${name} <${agentAddress(p.agentId, note.colonyId)}>`);
  }
  for (const p of proposals) {
    const a = changeAnswerable(p);
    const person = a.basis === "approved" ? cleanName(a.person) : "";
    if (person !== "") add(`Approved-by: ${person}`);
  }
  return lines;
}

/**
 * `message` (a landing message, whose last paragraph is its FT trailers) with `lines` put at the top of that paragraph,
 * above the FT trailers; in a new last paragraph when the message has no FT trailers. Unchanged when there are no lines.
 */
export function withCredits(message: string, lines: readonly string[]): string {
  if (lines.length === 0) return message;
  const body = message.replace(/\s+$/, "");
  const at = body.lastIndexOf("\n\n");
  const last = at < 0 ? body : body.slice(at + 2);
  if (at >= 0 && last.startsWith("FT-")) return `${body.slice(0, at + 2)}${lines.join("\n")}\n${last}`;
  return `${body}\n\n${lines.join("\n")}`;
}
