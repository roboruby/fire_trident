import type { FieldReading, Mark, MarkKind, Millis, Path } from "./types.ts";

/** Decay time constants (ms). `null` = no decay (needs persist until met). */
export const TAU_MS: Record<MarkKind, number | null> = {
  claim: 5 * 60_000,
  need: null,
  trail: 60 * 60_000,
  failure: 30 * 60_000,
  danger: 30 * 60_000,
};

/** Current value of one mark: strength * exp(-(now - at) / tau). */
export function markValue(mark: Mark, now: Millis): number {
  throw new Error("not implemented");
}

/** Marks whose value has fallen below `epsilon` can be garbage-collected. */
export function isExpired(mark: Mark, now: Millis, epsilon = 0.01): boolean {
  throw new Error("not implemented");
}

/** Aggregate marks into per-path and total values (no agents/sigma/admission; the RegionDO fills those). */
export function aggregate(marks: Mark[], now: Millis): Pick<FieldReading, "totals" | "byPath"> {
  throw new Error("not implemented");
}

/**
 * Repulsion an agent feels toward a footprint: the summed claim (+ danger) value
 * on those paths from OTHER agents. Used by self-assignment and the collision reflex.
 */
export function repulsion(byPath: FieldReading["byPath"], footprint: Path[]): number {
  throw new Error("not implemented");
}
