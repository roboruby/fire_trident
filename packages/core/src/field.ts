import type { FieldReading, Mark, MarkKind, Millis, Path } from "./types.ts";
import { pathsOverlap } from "./residual.ts";

/** Decay time constants (ms). `null` = no decay (needs persist until met). */
export const TAU_MS: Record<MarkKind, number | null> = {
  claim: 5 * 60_000,
  need: null,
  trail: 60 * 60_000,
  failure: 30 * 60_000,
  danger: 30 * 60_000,
};

/** Every mark kind, in display order. */
export const MARK_KINDS: readonly MarkKind[] = ["claim", "need", "trail", "failure", "danger"];

/**
 * Current value of one mark: strength * exp(-(now - at) / tau).
 * Kinds without a time constant, and reads at or before `at`, return the full strength.
 */
export function markValue(mark: Mark, now: Millis): number {
  const tau = TAU_MS[mark.kind];
  if (tau == null || now <= mark.at) return mark.strength;
  return mark.strength * Math.exp(-(now - mark.at) / tau);
}

/** Marks whose value has fallen below `epsilon` can be garbage-collected. `need` marks never expire. */
export function isExpired(mark: Mark, now: Millis, epsilon = 0.01): boolean {
  if (mark.kind === "need" || TAU_MS[mark.kind] == null) return false;
  return markValue(mark, now) < epsilon;
}

/**
 * Aggregate marks into per-path and total values (no agents/sigma/admission; the RegionDO fills those).
 * `totals` always carries all five kinds; a path lists only the kinds that have marks on it.
 */
export function aggregate(marks: Mark[], now: Millis): Pick<FieldReading, "totals" | "byPath"> {
  const totals: Record<MarkKind, number> = { claim: 0, need: 0, trail: 0, failure: 0, danger: 0 };
  const byPath = new Map<Path, Partial<Record<MarkKind, number>>>();
  for (const mark of marks) {
    if (!Object.hasOwn(totals, mark.kind)) continue;
    const value = markValue(mark, now);
    if (!Number.isFinite(value)) continue;
    totals[mark.kind] += value;
    let entry = byPath.get(mark.path);
    if (entry === undefined) {
      entry = {};
      byPath.set(mark.path, entry);
    }
    entry[mark.kind] = (entry[mark.kind] ?? 0) + value;
  }
  // fromEntries defines own properties, so paths such as "constructor" or "__proto__" stay ordinary keys.
  return { totals, byPath: Object.fromEntries(byPath) };
}

/**
 * Repulsion an agent feels toward a footprint: the summed claim (+ danger) value
 * on those paths from OTHER agents. Used by self-assignment and the collision reflex.
 *
 * Callers remove the requesting agent's own marks before aggregating, so an agent is never
 * repelled by its own claims. A field path counts once if it overlaps any footprint entry
 * (exact path, directory prefix ending in "/", or glob). Overlap is checked both ways because
 * claims are deposited on footprints, so field paths can themselves be directories or globs.
 */
export function repulsion(byPath: FieldReading["byPath"], footprint: Path[]): number {
  if (footprint.length === 0) return 0;
  let total = 0;
  for (const [path, values] of Object.entries(byPath)) {
    if (!footprint.some((entry) => pathsOverlap(entry, path))) continue;
    total += (values.claim ?? 0) + (values.danger ?? 0);
  }
  return total;
}
