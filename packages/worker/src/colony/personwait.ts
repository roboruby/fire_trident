import { revalidationEnabled } from "@fire_trident/core";
import type { Id } from "@fire_trident/core";

/**
 * Changes waiting for a person hold no files (FT_PERSON_WAIT). A change escalated to a person, or held under a merge
 * lock for one (status escalated either way), can wait for hours, and nobody writes its files while it waits. Before,
 * its holder's claim on the intent's footprint stayed fresh (the agent waited on the outcome and its heartbeats re-dated
 * the claim), so the claim repelled, or with lateral inhibition held off, every open intent on those files: on staging,
 * two escalations on one shared module kept five intents untaken for ten minutes while their agents sat idle.
 *
 * Where the flag covers the colony:
 * - when a proposal starts waiting for a person, the colony clears its agent's claim marks on the intent's footprint,
 *   and no heartbeat brings them back: RegionDO.refreshClaims only re-dates claims that exist, and the colony's heartbeat
 *   and its estimate of a taker's own claims leave such intents out (waitingFor);
 * - an in-platform agent whose inline change waits for a person ends that job and takes other work (agents/loop.ts,
 *   outcome awaiting_person). Its outcome subscription stays with the colony, and when the person decides, the change
 *   lands, goes back, or is held again under the merge lock (trunk moved under it) by the ordinary rules. A change
 *   committed to a workspace keeps its agent waiting, as the workspace holds its commit.
 * Claims of work being written (claimed intents) and of changes in review or in a lane are unchanged.
 */

/** FT_PERSON_WAIT: whether it covers this colony ("on", or a comma-separated list of colony ids; off when absent). */
export function personWaitOn(setting: string | undefined, colonyId: Id): boolean {
  return revalidationEnabled(setting, colonyId);
}

/**
 * Of `intentIds`, those whose change by `agentId` waits for a person: the agent has an escalated proposal for the intent
 * and none still in review or in a lane. Their claims are not refreshed and do not count as the agent's own.
 */
export function waitingFor(sql: SqlStorage, agentId: Id, intentIds: readonly Id[]): Set<Id> {
  if (intentIds.length === 0) return new Set();
  const rows = sql
    .exec<{ intent_id: string }>(
      `SELECT intent_id FROM proposals WHERE agent_id = ? AND intent_id IN (SELECT value FROM json_each(?))
       GROUP BY intent_id HAVING SUM(status = 'escalated') > 0 AND SUM(status IN ('pending', 'checking', 'ready')) = 0`,
      agentId,
      JSON.stringify([...new Set(intentIds)]),
    )
    .toArray();
  return new Set(rows.map((r) => r.intent_id));
}

/** Remove from `held`, in place, the intents whose change by `agentId` waits for a person (see waitingFor). */
export function dropWaiting(sql: SqlStorage, agentId: Id, held: Array<{ id: Id }>): void {
  if (held.length === 0) return;
  const waiting = waitingFor(
    sql,
    agentId,
    held.map((h) => h.id),
  );
  for (let i = held.length - 1; i >= 0; i--) if (waiting.has(held[i]!.id)) held.splice(i, 1);
}
