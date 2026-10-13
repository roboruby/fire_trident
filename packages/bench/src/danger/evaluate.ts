#!/usr/bin/env node
/**
 * Offline evaluator of the decide stage's deterministic danger checks: runs a corpus of labeled
 * changes through the checks the decide engine applies before any model (checks.ts: danger
 * patterns, loosened guards, governance files), with no network and no colony, and writes the
 * results and a short summary.
 *
 *   node --experimental-transform-types packages/bench/src/danger/evaluate.ts <corpus.json> --out <dir> [--intent-from-description]
 *
 * (The flag is needed because decide/danger.ts uses TypeScript that type stripping alone cannot run.)
 *
 * A corpus is a JSON array of items, or an object with an `items` array:
 *   { "id": "x1", "label": "dangerous" | "harmless", "class": "optional", "description": "optional",
 *     "files": [{ "path": "any/repo/path.js", "before": "text" | null, "after": "text" | null }] }
 * `before` null: the change creates the file; `after` null: it deletes it. Any repository path
 * works; the loosened-guard detector reads .js .jsx .mjs .cjs .ts .tsx .mts .cts files. Other
 * fields are ignored. An item that does not fit the shape is listed as invalid and left out.
 *
 * By default no intent is given, so nothing is asked for (as for an intent an agent declared, the
 * strictest reading). With --intent-from-description each item's description is an intent a person
 * wrote, which may ask for a process, network, eval or crypto capability, as on a colony.
 *
 * Flagged means the deterministic stage would not let the change land on its own: a hit that sends
 * it to a person (must-human), or a danger signal that a second opinion or a person must clear.
 * Writes <dir>/results.json (every item, its tier, classes and hits) and <dir>/summary.md: per
 * label how many were flagged, the catch rate on dangerous items and the false-alarm rate on
 * harmless ones with Wilson 95% intervals, and each dangerous item flagged or missed with its classes.
 */
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { checkChange, hitRows, personIntent, type ChangeFile, type DangerTier, type HitRow } from "./checks.ts";
import { codeSpan, mdTable, publishable, publishableDeep, rate, rateText, type Rate } from "./output.ts";

/** A label: the change is dangerous, or harmless. */
export type Label = "dangerous" | "harmless";

/** One valid corpus item. */
export interface CorpusItem {
  id: string;
  label: Label;
  class?: string;
  description?: string;
  files: ChangeFile[];
}

/** An item left out, with why (its position in the corpus, from 0). */
export interface InvalidItem {
  index: number;
  id?: string;
  reason: string;
}

/** Read a parsed corpus: the valid items, and the ones left out with their reasons. Throws when the top level is not a corpus. */
export function parseCorpus(value: unknown): { items: CorpusItem[]; invalid: InvalidItem[] } {
  const list = Array.isArray(value) ? value : value && typeof value === "object" && Array.isArray((value as { items?: unknown }).items) ? ((value as { items: unknown[] }).items) : null;
  if (!list) throw new Error("a corpus is a JSON array of items, or an object with an items array");
  const items: CorpusItem[] = [];
  const invalid: InvalidItem[] = [];
  const seen = new Set<string>();
  list.forEach((raw, index) => {
    const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
    const id = o && (typeof o.id === "string" || typeof o.id === "number") ? String(o.id).trim() : "";
    const bad = (reason: string): void => void invalid.push({ index, ...(id ? { id } : {}), reason });
    if (!o) return bad("not an object");
    if (!id) return bad("id must be a non-empty string or a number");
    if (seen.has(id)) return bad(`duplicate id ${id}`);
    if (o.label !== "dangerous" && o.label !== "harmless") return bad('label must be "dangerous" or "harmless"');
    if (o.class !== undefined && typeof o.class !== "string") return bad("class must be a string");
    if (o.description !== undefined && typeof o.description !== "string") return bad("description must be a string");
    if (!Array.isArray(o.files) || o.files.length === 0) return bad("files must be a non-empty array");
    const files: ChangeFile[] = [];
    const paths = new Set<string>();
    for (const [j, f] of o.files.entries()) {
      const file = f && typeof f === "object" && !Array.isArray(f) ? (f as Record<string, unknown>) : null;
      if (!file || typeof file.path !== "string" || file.path.trim() === "") return bad(`files[${j}].path must be a non-empty string`);
      const path = file.path.trim().replace(/^\.?\/+/, "");
      if (paths.has(path)) return bad(`files[${j}]: ${path} appears twice`);
      const text = (k: "before" | "after"): string | null | undefined => (file[k] === null || typeof file[k] === "string" ? (file[k] as string | null) : undefined);
      const before = text("before");
      const after = text("after");
      if (before === undefined || after === undefined) return bad(`files[${j}] (${path}): before and after must each be a string or null`);
      if (before === null && after === null) return bad(`files[${j}] (${path}): before and after cannot both be null`);
      paths.add(path);
      files.push({ path, before, after });
    }
    seen.add(id);
    items.push({ id, label: o.label, ...(typeof o.class === "string" && o.class.trim() ? { class: o.class.trim() } : {}), ...(typeof o.description === "string" ? { description: o.description } : {}), files });
  });
  return { items, invalid };
}

/** One evaluated item. */
export interface ItemResult {
  id: string;
  label: Label;
  class?: string;
  /** Dangerous: flagged or missed; harmless: false-alarm or clear. */
  verdict: "flagged" | "missed" | "false-alarm" | "clear";
  tier: DangerTier;
  /** Danger classes of the hits that count. */
  classes: string[];
  hits: HitRow[];
  /** Hits the intent asked for (only with --intent-from-description): recorded, not counted. */
  requested: HitRow[];
}

/** Per-label counts and rates. */
export interface LabelSummary {
  n: number;
  /** Sent to a person or to a second opinion it cannot skip. */
  flagged: number;
  /** Sent to a person before any model. */
  toPerson: number;
  /** Danger signals only: a second opinion or a person must look. */
  secondOpinionOnly: number;
  /** Flagged over n: the catch rate for dangerous items, the false-alarm rate for harmless ones. */
  flaggedRate: Rate;
  /** Sent to a person over n. */
  toPersonRate: Rate;
}

/** Everything the evaluator writes to results.json (before redaction). */
export interface Evaluation {
  schema: "firetrident.danger-eval/v1";
  corpus: string;
  intent: "none" | "description, written by a person";
  checks: string;
  items: number;
  invalid: InvalidItem[];
  labels: Record<Label, LabelSummary>;
  catchRate: Rate;
  falseAlarmRate: Rate;
  /** Dangerous items by their declared class: how many, how many flagged, how many sent to a person. */
  byItemClass: Record<string, { n: number; flagged: number; toPerson: number }>;
  /** Items with at least one counting hit of each danger class, per label. */
  byDangerClass: Record<string, Record<Label, number>>;
  results: ItemResult[];
}

const CHECKS =
  "decide/danger.ts scanDanger (danger patterns, loosened guards, governance, CI and dependency paths), the default policy's allowances (none), then triageDanger; texts read under the decide stage's limits (512 KiB, a NUL in the first 8 KiB, invalid UTF-8)";

/** Run every valid item through the checks and summarize. */
export function evaluate(parsed: { items: CorpusItem[]; invalid: InvalidItem[] }, opts: { corpus: string; intentFromDescription?: boolean }): Evaluation {
  const results: ItemResult[] = parsed.items.map((item) => {
    const intent = opts.intentFromDescription && item.description?.trim() ? personIntent(item.description.trim()) : null;
    const o = checkChange(item.files, intent);
    const verdict = item.label === "dangerous" ? (o.flagged ? "flagged" : "missed") : o.flagged ? "false-alarm" : "clear";
    return {
      id: item.id,
      label: item.label,
      ...(item.class ? { class: item.class } : {}),
      verdict,
      tier: o.tier,
      classes: o.classes,
      hits: hitRows(o),
      requested: o.recorded.map((h) => ({ cls: h.cls, pattern: h.pattern, path: h.path, line: h.line, excerpt: h.excerpt })),
    };
  });
  const summary = (label: Label): LabelSummary => {
    const rows = results.filter((r) => r.label === label);
    const flagged = rows.filter((r) => r.tier !== "none").length;
    const toPerson = rows.filter((r) => r.tier === "person").length;
    return { n: rows.length, flagged, toPerson, secondOpinionOnly: flagged - toPerson, flaggedRate: rate(flagged, rows.length), toPersonRate: rate(toPerson, rows.length) };
  };
  const labels = { dangerous: summary("dangerous"), harmless: summary("harmless") };
  const byItemClass: Evaluation["byItemClass"] = {};
  for (const r of results.filter((x) => x.label === "dangerous")) {
    const row = (byItemClass[r.class ?? "(none)"] ??= { n: 0, flagged: 0, toPerson: 0 });
    row.n++;
    if (r.tier !== "none") row.flagged++;
    if (r.tier === "person") row.toPerson++;
  }
  const byDangerClass: Evaluation["byDangerClass"] = {};
  for (const r of results) for (const c of r.classes) (byDangerClass[c] ??= { dangerous: 0, harmless: 0 })[r.label]++;
  return {
    schema: "firetrident.danger-eval/v1",
    corpus: opts.corpus,
    intent: opts.intentFromDescription ? "description, written by a person" : "none",
    checks: CHECKS,
    items: parsed.items.length + parsed.invalid.length,
    invalid: parsed.invalid,
    labels,
    catchRate: labels.dangerous.flaggedRate,
    falseAlarmRate: labels.harmless.flaggedRate,
    byItemClass: sortKeys(byItemClass),
    byDangerClass: sortKeys(byDangerClass),
    results,
  };
}

function sortKeys<T>(o: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
}

/** The short markdown summary. */
export function summaryMarkdown(e: Evaluation): string {
  const d = e.labels.dangerous;
  const h = e.labels.harmless;
  const lines = [
    "# Deterministic danger checks on a labeled corpus",
    "",
    `Corpus ${codeSpan(e.corpus)}: ${e.items} item${e.items === 1 ? "" : "s"}, ${d.n} dangerous and ${h.n} harmless judged${e.invalid.length > 0 ? `, ${e.invalid.length} invalid and left out` : ""}. Intent: ${e.intent}. No network, no models: only the checks the decide stage applies before any model (${e.checks}).`,
    "",
    "Flagged: the deterministic stage would not let the change land on its own (sent to a person, or to a second opinion it cannot skip).",
    "",
    mdTable(
      ["Label", "Items", "Flagged", "To a person", "Second opinion only", "Not flagged"],
      [
        ["dangerous", d.n, d.flagged, d.toPerson, d.secondOpinionOnly, d.n - d.flagged],
        ["harmless", h.n, h.flagged, h.toPerson, h.secondOpinionOnly, h.n - h.flagged],
      ],
    ),
    "",
    `- Catch rate (dangerous flagged): ${rateText(e.catchRate)}`,
    `- Sent to a person (dangerous): ${rateText(d.toPersonRate)}`,
    `- False-alarm rate (harmless flagged): ${rateText(e.falseAlarmRate)}`,
    `- Sent to a person (harmless): ${rateText(h.toPersonRate)}`,
  ];
  const classes = Object.entries(e.byItemClass);
  if (classes.length > 0) {
    lines.push("", "## Dangerous items by declared class", "", mdTable(["Class", "Items", "Flagged", "To a person"], classes.map(([c, r]) => [c, r.n, r.flagged, r.toPerson])));
  }
  const dangerous = e.results.filter((r) => r.label === "dangerous");
  if (dangerous.length > 0) {
    lines.push(
      "",
      "## Each dangerous item",
      "",
      mdTable(
        ["Item", "Class", "Verdict", "Tier", "Danger classes"],
        dangerous.map((r) => [r.id, r.class ?? "", r.verdict, r.tier, r.classes.join(", ") || "none"]),
      ),
    );
  }
  const alarms = e.results.filter((r) => r.verdict === "false-alarm");
  if (alarms.length > 0) {
    lines.push("", "## False alarms", "", mdTable(["Item", "Tier", "First hit"], alarms.map((r) => [r.id, r.tier, r.hits[0] ? `${r.hits[0].pattern} at ${r.hits[0].path}:${r.hits[0].line}` : ""])));
  }
  if (e.invalid.length > 0) {
    lines.push("", "## Invalid items (left out)", "", mdTable(["Index", "Id", "Reason"], e.invalid.map((x) => [x.index, x.id ?? "", x.reason])));
  }
  return `${lines.join("\n")}\n`;
}

/** Parse arguments, evaluate the corpus, write results.json and summary.md. */
export function main(argv: string[]): { results: string; summary: string } {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { out: { type: "string" }, "intent-from-description": { type: "boolean" } },
  });
  const file = positionals[0];
  if (!file || positionals.length > 1) throw new Error("usage: evaluate.ts <corpus.json> --out <dir> [--intent-from-description]");
  const out = values.out ?? "danger-eval";
  const parsed = parseCorpus(JSON.parse(readFileSync(file, "utf8")) as unknown);
  // Everything written passes through publishableDeep: excerpts can quote secrets, emails or local paths.
  const e = publishableDeep(evaluate(parsed, { corpus: basename(file), intentFromDescription: values["intent-from-description"] === true }));
  mkdirSync(out, { recursive: true });
  const results = join(out, "results.json");
  const summary = join(out, "summary.md");
  writeFileSync(results, `${JSON.stringify(e, null, 2)}\n`);
  writeFileSync(summary, summaryMarkdown(e));
  console.log(`${e.labels.dangerous.n} dangerous: ${rateText(e.catchRate)} flagged; ${e.labels.harmless.n} harmless: ${rateText(e.falseAlarmRate)} flagged; wrote ${results} and ${summary}`);
  return { results, summary };
}

function isEntry(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntry()) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(publishable(e instanceof Error ? e.message : String(e)));
    process.exit(1);
  }
}
