/** How a fractional number of cents becomes whole. */
export type Rounding = "half-away" | "half-even" | "down" | "up";

/** x rounded to a whole number: halves away from zero, halves to the even neighbor, toward zero, or away from zero. */
export function round(x: number, mode: Rounding): number {
  if (mode === "half-away") return x < 0 ? -Math.round(-x) : Math.round(x);
  if (mode === "down") return Math.trunc(x);
  if (mode === "up") return x < 0 ? -Math.ceil(-x) : Math.ceil(x);
  if (mode === "half-even") {
    const f = Math.floor(x);
    const d = x - f;
    if (d !== 0.5) return d < 0.5 ? f : f + 1;
    return f % 2 === 0 ? f : f + 1;
  }
  throw new RangeError(`round: unknown mode ${String(mode)}`);
}
