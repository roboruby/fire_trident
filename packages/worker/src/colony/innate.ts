import type { Colony, Proposal } from "@fire_trident/core";
import type { Env } from "../env.ts";

/**
 * HOOK: innate checks and triage.
 *
 * ColonyDO.propose calls this after computing the residual and before the
 * proposal enters a lane. The verification and triage stream fills it in.
 * Contract for implementers:
 * - Return the proposal, optionally with `evidence.checks` appended.
 * - Leave `status` as is (or "ready") to send it to its region's lane.
 * - Set `status: "escalated"` to park it in the human review queue.
 * - Set `status: "rejected"` or `"returned"` (with `reason`) to send it back;
 *   the intent is reopened and the agent's claims are cleared.
 * Keep it fast: it runs inside the ColonyDO request path.
 *
 * Today it returns the proposal unchanged.
 */
export async function runInnateChecks(p: Proposal, _ctx?: { env: Env; colony: Colony }): Promise<Proposal> {
  return p;
}
