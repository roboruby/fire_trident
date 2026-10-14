import type { LineageNote } from "@fire_trident/core";
import { fmtInt, plural } from "./format.ts";

/** What a lineage note says about contests, assumption revalidation and provenance, read defensively: notes written before each existed lack it. */

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

/** How the Why panel words a landed change's provenance: who ran its agent and how its model is known. */
export interface ProvenanceView {
  /** Who ran the agent and what authenticated it: "Run by FireTrident", "External agent: the MCP token and its resume key". */
  author: string;
  /** observed: FireTrident made the model calls; declared: the agent named its model; unknown: neither, or a value this page does not know. */
  level: "observed" | "declared" | "unknown";
  /** "Model observed by FireTrident", "Model declared by the agent", "Model not known". */
  label: string;
  /** What FireTrident counted ("3 calls · 4,120 in / 812 out tokens"), or a model name the agent line does not show. */
  detail?: string;
}

const line = (v: unknown): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");
const amount = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

/** How a landed change's author and model are known (the note's provenance); null for notes written before it was kept. */
export function provenanceOf(p: NoteProposal): ProvenanceView | null {
  const raw = (p as { provenance?: unknown }).provenance;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const v = raw as { author?: unknown; auth?: unknown; model?: unknown };
  const auth = line(v.auth);
  const via = auth === "mcp" ? "the MCP token and its resume key" : auth === "token" ? "a deployment token, not bound to it" : auth === "" ? "the MCP or API token" : auth;
  const who = line(v.author);
  const author = who === "platform" ? "Run by FireTrident" : who === "external" ? `External agent: ${via}` : who === "synthetic" ? "Bench agent" : who ? `Author: ${who}` : "Author not known";
  const m = v.model && typeof v.model === "object" && !Array.isArray(v.model) ? (v.model as { evidence?: unknown; name?: unknown; observed?: unknown }) : null;
  const evidence = line(m?.evidence);
  const name = line(m?.name);
  const other = name && name !== line(p.model) ? name : "";
  if (evidence === "observed") {
    const counted = objects(m?.observed)
      .map((o) => {
        const id = line(o.model);
        const calls = amount(o.calls);
        const [input, output] = [amount(o.inputTokens), amount(o.outputTokens)];
        const parts = [id && id !== line(p.model) ? id : "", calls === null ? "" : plural(calls, "call"), input === null || output === null ? "" : `${fmtInt(input)} in / ${fmtInt(output)} out tokens`].filter(Boolean);
        return parts.join(" · ");
      })
      .filter(Boolean);
    return { author, level: "observed", label: "Model observed by FireTrident", detail: counted.length ? counted.join("; ") : other || "No model call recorded for this change" };
  }
  if (evidence === "declared") return { author, level: "declared", label: "Model declared by the agent", ...(other ? { detail: other } : {}) };
  return { author, level: "unknown", label: evidence ? `Model ${evidence}` : "Model not known", ...(other ? { detail: other } : {}) };
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
