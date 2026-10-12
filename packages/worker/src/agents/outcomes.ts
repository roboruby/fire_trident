import { regionKey, regionOf } from "@fire_trident/core";
import type { Id, ProposalStatus } from "@fire_trident/core";

/**
 * What an in-platform agent needs to stop polling: the outcomes the colony pushes to it
 * (AgentDO.outcome), and claim refreshes sent straight to the regions that hold its claims.
 */

/** An outcome the colony pushed for one proposal. */
export interface PushedOutcome {
  proposalId: Id;
  status: ProposalStatus;
  reason?: string;
  landingId?: Id;
}

/** Pushed outcomes are kept this long (the await step reads them within seconds; a stale one is useless). */
const KEEP_MS = 60 * 60_000;
/** Proposal states a push may carry. */
const STATUSES: ReadonlySet<string> = new Set<ProposalStatus>(["pending", "checking", "ready", "escalated", "landed", "returned", "rejected"]);

/**
 * Outcomes pushed to this agent, by proposal id, in the agent's SQLite (so one that arrives just
 * before an eviction is not lost). The await step reads them; rows older than an hour are dropped.
 */
export class OutcomeBox {
  constructor(private readonly sql: SqlStorage) {
    sql.exec("CREATE TABLE IF NOT EXISTS agent_outcomes (proposal_id TEXT PRIMARY KEY, status TEXT NOT NULL, reason TEXT, landing_id TEXT, at INTEGER NOT NULL)");
  }

  /** Keep a pushed outcome (a later push for the same proposal replaces it). False when it is malformed. */
  put(o: PushedOutcome, now: number): boolean {
    if (!o || typeof o.proposalId !== "string" || o.proposalId === "" || typeof o.status !== "string" || !STATUSES.has(o.status)) return false;
    this.sql.exec("DELETE FROM agent_outcomes WHERE at < ?", now - KEEP_MS);
    this.sql.exec(
      "INSERT OR REPLACE INTO agent_outcomes (proposal_id, status, reason, landing_id, at) VALUES (?, ?, ?, ?, ?)",
      o.proposalId,
      o.status,
      typeof o.reason === "string" ? o.reason.slice(0, 4_000) : null,
      typeof o.landingId === "string" ? o.landingId : null,
      now,
    );
    return true;
  }

  /** The pushed outcome of a proposal, or null. */
  get(proposalId: Id): { status: ProposalStatus; reason?: string } | null {
    const r = this.sql.exec<{ status: string; reason: string | null }>("SELECT status, reason FROM agent_outcomes WHERE proposal_id = ?", proposalId).toArray()[0];
    if (!r) return null;
    return r.reason !== null ? { status: r.status as ProposalStatus, reason: r.reason } : { status: r.status as ProposalStatus };
  }
}

/** The RegionDO surface a claim refresh needs. */
export interface ClaimRefresher {
  refreshClaims(p: { agentId: Id; intentIds?: Id[] }): Promise<number>;
}

/** The region names a footprint touches at the colony's region depth (each once). */
export function footprintRegions(footprint: string[], depth: number): string[] {
  return [...new Set(footprint.map((p) => regionOf(p, depth)))];
}

/** Durable Object name of each region of a footprint (`${colonyId}:${region}`). */
export function regionNames(colonyId: Id, footprint: string[], depth: number): string[] {
  return footprintRegions(footprint, depth).map((r) => regionKey(colonyId, r));
}
