/**
 * Shared output for the danger measurements (evaluate.ts, history.ts): rates with the Wilson 95%
 * interval the vaccination meter uses, markdown tables, and what may be published of an excerpt.
 * Pure: no I/O.
 */
import { wilson } from "../../../worker/src/decide/vaccine.ts";
import { redactEvidence } from "../evidence.ts";

/** k of n, the proportion and its Wilson 95% interval (decide/vaccine.ts wilson: three decimals). */
export interface Rate {
  k: number;
  n: number;
  p: number;
  lo: number;
  hi: number;
}

/** A rate of k in n. */
export function rate(k: number, n: number): Rate {
  return { k, n, ...wilson(k, n) };
}

/** A percentage with one decimal ("0.6%"). */
export function percent(x: number): string {
  return `${(Math.round(x * 1000) / 10).toFixed(1)}%`;
}

/** "12 of 300 (4.0%, 95% CI 2.3% to 6.9%)"; "none judged" for n = 0. */
export function rateText(r: Rate): string {
  if (r.n === 0) return "none judged";
  return `${r.k} of ${r.n} (${percent(r.p)}, 95% CI ${percent(r.lo)} to ${percent(r.hi)})`;
}

/** A markdown table; cells have their pipes escaped and line breaks flattened. */
export function mdTable(header: readonly string[], rows: ReadonlyArray<ReadonlyArray<string | number>>): string {
  const cell = (c: string | number): string => String(c).replace(/\r?\n|\r/g, " ").replace(/\|/g, "\\|");
  return [`| ${header.map(cell).join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`)].join("\n");
}

/** Text for inline code in markdown: backticks replaced, so the span cannot close early. */
export function codeSpan(s: string): string {
  return `\`${s.replace(/`/g, "'")}\``;
}

/**
 * What may be published of a detector's excerpt: the detector already masks secret-looking values;
 * this also removes tokens, emails and local paths (bench/src/evidence.ts redactEvidence) and any
 * bare 32-character hex id (the length of an account id; 40-character commit ids are kept).
 */
export function publishable(text: string): string {
  return redactEvidence(text).replace(/(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/gi, "<hex32>");
}

/** publishable applied to every string of a JSON value, keys included (so the JSON stays valid). */
export function publishableDeep<T>(value: T): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return publishable(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [publishable(k), walk(x)]));
    return v;
  };
  return walk(value) as T;
}
