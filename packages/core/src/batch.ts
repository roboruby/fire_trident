import type { Path, Proposal } from "./types.ts";

/**
 * Lateral-inhibition batching: choose a maximal set of proposals whose write sets are
 * pairwise disjoint, and none of whose write sets intersect another chosen proposal's
 * read set. Greedy in the given order (caller sorts by priority, then age).
 *
 * A proposal joins the batch only if its writes miss every chosen write and read, and its reads
 * miss every chosen write. At most `maxSize` (default unlimited) are chosen; a repeated id is
 * deferred. Both lists keep the input's relative order.
 */
export function selectBatch<P extends Pick<Proposal, "id" | "writeSet" | "readSet">>(ordered: P[], maxSize = Infinity): { batch: P[]; deferred: P[] } {
  const cap = Number.isNaN(maxSize) ? Infinity : Math.max(0, Math.floor(maxSize));
  const writes = new Set<Path>();
  const reads = new Set<Path>();
  const ids = new Set<string>();
  const batch: P[] = [];
  const deferred: P[] = [];
  for (const p of ordered) {
    const w = p.writeSet.map((f) => f.path);
    const r = p.readSet.map((f) => f.path);
    const fits =
      batch.length < cap &&
      !ids.has(p.id) &&
      w.every((path) => !writes.has(path) && !reads.has(path)) &&
      r.every((path) => !writes.has(path));
    if (!fits) {
      deferred.push(p);
      continue;
    }
    batch.push(p);
    ids.add(p.id);
    for (const path of w) writes.add(path);
    for (const path of r) reads.add(path);
  }
  return { batch, deferred };
}

/**
 * Physarum cadence: lane tick interval clamp(k / flux, minMs, maxMs). flux = proposals per minute.
 * Defaults: k = 30000, minMs = 1000, maxMs = 30000. Flux below 1e-9 (or NaN) counts as 1e-9.
 */
export function laneIntervalMs(flux: number, k = 30_000, minMs = 1_000, maxMs = 30_000): number {
  const f = flux > 1e-9 ? flux : 1e-9;
  return Math.min(maxMs, Math.max(minMs, k / f));
}
