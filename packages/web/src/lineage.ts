import type { LineageNote } from "@fire_trident/core";

/** What a lineage note says about contests and assumption revalidation, read defensively: notes written before either existed have neither. */

type NoteProposal = LineageNote["proposals"][number];

/** One attempt that lost an intent's contest to the landed change, and why. */
export interface Alternative {
  proposalId: string;
  agentId: string;
  model?: string;
  reason: string;
}

/** One file that changed after the change read it, the blobs before and after, and the imported names that still held. */
export interface Revalidation {
  path: string;
  read: string | null;
  landedOn: string | null;
  names: string[];
}

const objects = (v: unknown): Array<Record<string, unknown>> =>
  Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x)) : [];

/** The other attempts at the same intent a landed change was chosen over (contest mode); empty for most notes. */
export function alternativesOf(p: NoteProposal): Alternative[] {
  return objects((p as { alternatives?: unknown }).alternatives)
    .map((a) => ({
      proposalId: typeof a.proposalId === "string" ? a.proposalId : "",
      agentId: typeof a.agentId === "string" ? a.agentId : "",
      ...(typeof a.model === "string" && a.model ? { model: a.model } : {}),
      reason: typeof a.reason === "string" ? a.reason : "",
    }))
    .filter((a) => a.proposalId !== "" || a.agentId !== "");
}

/** The files that changed after a landed change read them and the names that still held (assumption revalidation); empty for most notes. */
export function revalidatedOf(p: NoteProposal): Revalidation[] {
  return objects((p as { revalidated?: unknown }).revalidated)
    .filter((r) => typeof r.path === "string" && r.path !== "")
    .map((r) => ({
      path: r.path as string,
      read: typeof r.read === "string" ? r.read : null,
      landedOn: typeof r.landedOn === "string" ? r.landedOn : null,
      names: Array.isArray(r.names) ? r.names.filter((n): n is string => typeof n === "string" && n !== "") : [],
    }));
}
