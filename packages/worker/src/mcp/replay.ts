import { blobId, changesetId } from "@fire_trident/core";
import type { FileVersion, Path, Proposal, Sha } from "@fire_trident/core";
import type { InlineFile, McpTrunkRpc, Session, ToolContext } from "./tools.ts";

/**
 * A propose retried after its reply was lost. The first call proposed the change and the session gave up its intent and
 * lease with it, so the retry would find no intent to propose for and fail. When the session's newest proposal is the
 * same change (the same head commit, or files that build the same changeset on that proposal's base), the retry gets
 * that proposal back as it stands now, and nothing is written: no second proposal, no event. A retry that reaches the
 * colony (the session still holds the intent) meets the colony's own rule, one proposal per agent, intent and head
 * commit (ColonyDO.propose). Pure but for the two reads.
 */

/** What a replayed propose says next to the proposal. */
export const PROPOSE_REPLAY_NOTE = "You proposed this change already and its answer did not reach you: this is that proposal as it stands now, and nothing new was proposed.";

/**
 * The session's newest proposal when `a` proposes the same change again from a session that no longer holds an
 * intent, or null (the call goes on as a new propose, which refuses it as before). Read on the colony, so its status
 * is the current one. A session that holds an intent is left to the colony, which answers a repeat itself.
 */
export async function replayedProposal(s: Session, a: { headSha?: string; files?: InlineFile[] }, ctx: Pick<ToolContext, "colony" | "trunk">): Promise<Proposal | null> {
  if (s.intent || s.lease || !s.colonyId || !s.agentId) return null;
  const last = Array.isArray(s.proposals) ? s.proposals.at(-1) : undefined;
  if (!last || typeof last.id !== "string" || typeof last.headSha !== "string") return null;
  // Called as a method (a detached stub function would name a remote property).
  const p = await ctx.colony(s.colonyId).getProposal(last.id);
  if (!p || p.agentId !== s.agentId || p.intentId !== last.intentId || p.headSha !== last.headSha) return null;
  return (await headOn(a, p.baseSha, ctx.trunk(s.colonyId))) === p.headSha ? p : null;
}

/** The answer of a replayed propose: the proposal as the first answer showed it, marked replayed. */
export function replayAnswer(p: Proposal): Record<string, unknown> {
  return {
    proposal: { id: p.id, status: p.status, reason: p.reason ?? null, residual: p.evidence?.residual ?? [] },
    writeSet: p.writeSet,
    readSet: p.readSet.length,
    replayed: true,
    note: PROPOSE_REPLAY_NOTE,
  };
}

/**
 * The head `a` proposes on `baseSha`: its commit id, or the changeset id its files build there as MCP propose builds an
 * inline change (a file sent unchanged from the base is dropped); null when the arguments cannot say.
 */
async function headOn(a: { headSha?: string; files?: InlineFile[] }, baseSha: Sha, trunk: Pick<McpTrunkRpc, "baseBlobs">): Promise<Sha | null> {
  const head = typeof a.headSha === "string" ? a.headSha.trim().toLowerCase() : "";
  if ((head !== "") === (a.files !== undefined)) return null;
  if (head !== "") return head;
  if (!Array.isArray(a.files) || a.files.length === 0 || !trunk.baseBlobs) return null;
  const sent = new Map<Path, string | null>();
  for (const f of a.files) {
    if (!f || typeof f.path !== "string" || sent.has(f.path) || (f.content !== null && typeof f.content !== "string")) return null;
    sent.set(f.path, f.content);
  }
  const base = new Map((await trunk.baseBlobs(baseSha, [...sent.keys()])).map((v) => [v.path, v.blob ?? null]));
  const writeSet: FileVersion[] = [];
  for (const [path, content] of sent) {
    const blob = content === null ? null : blobId(content);
    if (blob !== null && blob === (base.get(path) ?? null)) continue;
    writeSet.push({ path, blob });
  }
  return writeSet.length > 0 ? changesetId(baseSha, writeSet) : null;
}
