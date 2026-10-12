import { finite } from "./format.ts";

/** Per-minute history of one colony (sparklines, the violations burn-down). */
export interface Series {
  bucketMs: number;
  start: number;
  violations: number[];
  landings: number[];
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** Read a per-minute series object (the snapshot's or /metrics' `series`) if it looks like one. */
export function parseSeries(raw: unknown): Series | null {
  if (!isObj(raw)) return null;
  const arr = (x: unknown): number[] => (Array.isArray(x) ? x.map((v) => Math.max(0, finite(v))) : []);
  const violations = arr(raw.violations);
  const landings = arr(raw.landings);
  if (!violations.length && !landings.length) return null;
  const bucketMs = typeof raw.bucketMs === "number" && raw.bucketMs > 0 ? raw.bucketMs : 60_000;
  return { bucketMs, start: finite(raw.start), violations, landings };
}

/** SVG polyline points for `data` in a W×H box (top padding `pad`), scaled to its own maximum. */
export function sparkPoints(data: readonly number[], W: number, H: number, pad = 2): string {
  if (data.length < 2) return "";
  const max = Math.max(1, ...data);
  const step = W / (data.length - 1);
  return data.map((v, i) => `${(i * step).toFixed(1)},${(H - pad - (Math.max(0, v) / max) * (H - pad * 2)).toFixed(1)}`).join(" ");
}
