/**
 * Criticality governor. Each event may name a cause (parent event id). The branching
 * ratio sigma over a sliding window is the mean number of child events per parent
 * event whose children have had time to occur. sigma > 1 means a runaway cascade.
 */
export interface CausalEvent {
  id: string;
  causeId?: string;
  at: number;
}

/** Estimate sigma from events in [now - windowMs, now - settleMs]. Returns 0 with no parents. */
export function branchingRatio(events: CausalEvent[], now: number, windowMs?: number, settleMs?: number): number {
  throw new Error("not implemented");
}

/** Inhibition gain for a region: 1 when sigma <= 1, rising with sigma (used to slow lanes and stagger rebases). */
export function inhibitionFactor(sigma: number): number {
  throw new Error("not implemented");
}
