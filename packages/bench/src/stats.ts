/** Latency statistics for the benchmark. Plain functions, no I/O. */

/** Value at quantile q (0..1) of an ascending array, nearest-rank. Null for no samples. */
export function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil(Math.min(1, Math.max(0, q)) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))] ?? null;
}

/** Summary of one operation's latencies (milliseconds). */
export interface Summary {
  n: number;
  min: number | null;
  p50: number | null;
  p90: number | null;
  p99: number | null;
  max: number | null;
  mean: number | null;
}

/** Summarize samples (any order). */
export function summarize(samples: number[]): Summary {
  const s = [...samples].sort((a, b) => a - b);
  const mean = s.length ? s.reduce((a, b) => a + b, 0) / s.length : null;
  return {
    n: s.length,
    min: s[0] ?? null,
    p50: quantile(s, 0.5),
    p90: quantile(s, 0.9),
    p99: quantile(s, 0.99),
    max: s[s.length - 1] ?? null,
    mean,
  };
}

/** Events per second (0 when no time passed). */
export function perSecond(count: number, seconds: number): number {
  return seconds > 0 ? count / seconds : 0;
}

/** Collects latencies and errors per operation. */
export class Recorder {
  private readonly latencies = new Map<string, number[]>();
  private readonly errorCounts = new Map<string, number>();
  /** First few distinct error messages, for the report. */
  readonly errorSamples: string[] = [];

  /** Record one successful call's latency. */
  record(op: string, ms: number): void {
    const list = this.latencies.get(op);
    if (list) list.push(ms);
    else this.latencies.set(op, [ms]);
  }

  /** Record one failed call (its latency still counts toward the op's samples). */
  error(op: string, ms: number, message: string): void {
    this.record(op, ms);
    this.errorCounts.set(op, (this.errorCounts.get(op) ?? 0) + 1);
    const line = `${op}: ${message}`;
    if (this.errorSamples.length < 8 && !this.errorSamples.includes(line)) this.errorSamples.push(line);
  }

  /** Operations seen, in first-seen order. */
  ops(): string[] {
    return [...new Set([...this.latencies.keys(), ...this.errorCounts.keys()])];
  }

  summary(op: string): Summary {
    return summarize(this.latencies.get(op) ?? []);
  }

  errors(op: string): number {
    return this.errorCounts.get(op) ?? 0;
  }
}

/** Format rows as text columns (first row is the header). Columns holding numbers align right, header included. */
export function table(rows: Array<Array<string | number | null>>): string {
  const cells = rows.map((r) => r.map((c) => (c === null ? "-" : typeof c === "number" ? fmt(c) : c)));
  const widths = cells[0]?.map((_, i) => Math.max(...cells.map((r) => (r[i] ?? "").length))) ?? [];
  const numeric = widths.map((_, i) => rows.slice(1).some((r) => typeof r[i] === "number"));
  return cells
    .map((r) =>
      r
        .map((c, i) => (numeric[i] ? c.padStart(widths[i] ?? 0) : c.padEnd(widths[i] ?? 0)))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

/** Compact number formatting: integers as is, others with one decimal (two below 10). */
export function fmt(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (Number.isInteger(n)) return String(n);
  return Math.abs(n) < 10 ? n.toFixed(2) : n.toFixed(1);
}
