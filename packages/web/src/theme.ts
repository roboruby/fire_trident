import type { DecisionLayer, MarkKind } from "@fire_trident/core";

/**
 * Decay time constants (ms), mirrored from TAU_MS in packages/core/src/field.ts.
 * Kept as a local copy so the UI bundle depends on core for types only.
 * `null` means the mark does not decay (needs persist until met).
 */
export const TAU_MS: Readonly<Record<MarkKind, number | null>> = {
  claim: 5 * 60_000,
  need: null,
  trail: 60 * 60_000,
  failure: 30 * 60_000,
  danger: 30 * 60_000,
};

/** Mark kinds in a fixed order: the index used by per-cell typed arrays. */
export const KINDS: readonly MarkKind[] = ["need", "claim", "trail", "failure", "danger"];

/** Index of each kind inside KINDS. */
export const KIND_INDEX: Readonly<Record<MarkKind, number>> = { need: 0, claim: 1, trail: 2, failure: 3, danger: 4 };

/** Decay constant per kind index (Infinity = no decay). */
const TAU_BY_INDEX: readonly number[] = KINDS.map((k) => TAU_MS[k] ?? Infinity);

/** Field colors, one per mark kind. */
export const FIELD_COLOR: Readonly<Record<MarkKind, string>> = {
  need: "#ffb53d",
  claim: "#3d8bff",
  trail: "#1fe08e",
  failure: "#b0424c",
  danger: "#ff2e4f",
};

/** Field colors by kind index. */
export const FIELD_COLOR_BY_INDEX: readonly string[] = KINDS.map((k) => FIELD_COLOR[k]);

/** Colors of the three decision layers of the reflex arc. */
export const LAYER_COLOR: Readonly<Record<DecisionLayer, string>> = {
  reflex: "#5fd0ff",
  llm: "#a78bfa",
  human: "#f38020",
};

/** Brand accent. Used sparingly: the mark, the trunk head, sparks, the active tab. */
export const ACCENT = "#f38020";

/** Value of a mark of kind index `k` deposited as `value` at `at`, seen at `now` (exponential decay). */
export function decayed(value: number, at: number, k: number, now: number): number {
  if (value <= 0) return 0;
  const tau = TAU_BY_INDEX[k] ?? Infinity;
  if (tau === Infinity) return value;
  const dt = now - at;
  return dt <= 0 ? value : value * Math.exp(-dt / tau);
}

/** Field value to display intensity in [0, 1): saturating, per-kind scale. */
const INTENSITY_SCALE: readonly number[] = [1.6, 0.8, 0.6, 0.7, 0.6];

/** Display intensity of a field value for kind index `k`. */
export function intensity(value: number, k: number): number {
  return value <= 0 ? 0 : 1 - Math.exp(-value / (INTENSITY_SCALE[k] ?? 1));
}
