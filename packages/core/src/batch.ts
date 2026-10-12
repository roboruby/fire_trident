import type { Proposal } from "./types.ts";

/**
 * Lateral-inhibition batching: choose a maximal set of proposals whose write sets are
 * pairwise disjoint, and none of whose write sets intersect another chosen proposal's
 * read set. Greedy in the given order (caller sorts by priority, then age).
 */
export function selectBatch<P extends Pick<Proposal, "id" | "writeSet" | "readSet">>(ordered: P[], maxSize?: number): { batch: P[]; deferred: P[] } {
  throw new Error("not implemented");
}

/** Physarum cadence: lane tick interval clamp(k / flux, minMs, maxMs). flux = proposals per minute. */
export function laneIntervalMs(flux: number, k?: number, minMs?: number, maxMs?: number): number {
  throw new Error("not implemented");
}
