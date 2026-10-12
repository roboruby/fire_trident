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

/**
 * Estimate sigma from events in [now - windowMs, now - settleMs]. Returns 0 with no parents.
 * Parents are the events inside that window (both ends inclusive); children are all events, at any
 * time, whose causeId names a parent. windowMs defaults to 60 s and settleMs to 5 s. Event ids are
 * assumed unique.
 */
export function branchingRatio(events: CausalEvent[], now: number, windowMs = 60_000, settleMs = 5_000): number {
  const from = now - windowMs;
  const to = now - settleMs;
  const parents = events.filter((e) => e.at >= from && e.at <= to);
  if (parents.length === 0) return 0;
  const parentIds = new Set(parents.map((e) => e.id));
  let children = 0;
  for (const e of events) if (e.causeId !== undefined && parentIds.has(e.causeId)) children++;
  return children / parents.length;
}

/**
 * Inhibition gain for a region: 1 when sigma <= 1, rising with sigma (used to slow lanes and stagger rebases).
 * Above 1 it is sigma^2, capped at 8.
 */
export function inhibitionFactor(sigma: number): number {
  return sigma > 1 ? Math.min(8, sigma * sigma) : 1;
}
