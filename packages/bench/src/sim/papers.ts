#!/usr/bin/env node
/**
 * Re-checks of the simulator claims that the 2026-10-13 paper reviews questioned, on the hono
 * workload of the 2026-10-12 benchmark. The README's rework numbers come from
 * results/2026-10-12-inhibition; every run here uses its settings (20 simulated minutes, 5 of
 * warm-up, 100 package copies, co-change table h200, backlog 1,000). Every number is SIMULATED.
 *
 *   node packages/bench/src/sim/papers.ts --steps q1 --out packages/bench/results/2026-10-13-papers
 *   node packages/bench/src/sim/papers.ts --steps report --out packages/bench/results/2026-10-13-papers
 *
 * Steps (--steps, default q1,q2,q4,q5,report):
 *  - q1: equal retry costs. Locks and FireTrident with the same SimParams.rework, 1.0 and 0.5.
 *  - q2: lateral inhibition off and on, with per-lane commits (one commit per lane batch, the
 *    "firetrident" model) and with group commit (as deployed). Every return is classified, which
 *    is the q3 diagnosis.
 *  - q4: import-aware take() at weights 0, 1 and 2 (ANALYSIS, not built; see imports.ts).
 *  - q5: assumption revalidation (ANALYSIS, not built): a proposal stale only through files it read
 *    lands when its assumptions held, at the hold rates measured on hono's history.
 *  - report: summary.json, a check against the published runs, and the README tables on stdout.
 */
import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { LATERAL_INHIBITION } from "@fire_trident/core";
import type { Neighbor } from "@fire_trident/core";
import type { WorkloadModel } from "../workload.ts";
import { BaselineSim } from "./baseline.ts";
import { cochangeRepulsion, monorepoNeighbors } from "./cochange.ts";
import type { SimParams, SimResult, Timings } from "./common.ts";
import { FireSim, type ExtraRepulsion, type ReturnInfo } from "./fire.ts";
import { importRepulsion, importTable, monorepoImports, mostImported, sumRepulsion } from "./imports.ts";
import { params as simParams, type Calibration } from "./sweep.ts";
import { HistoryWorkload, type TaskSource } from "./workloads.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Assumption hold rates measured on 2,285 hono commits, weighted by importer touches: the signatures
 * of the names an importer uses held 68.7% of the time; 57.6% when test importers also need the
 * bodies unchanged.
 */
export const PROBE_HOLD = { signature: 0.687, mixed: 0.576 } as const;

/** One simulated configuration. */
export interface Variant {
  name: string;
  model: SimParams["model"];
  /** Co-change repulsion weight (absent = off). */
  cochange?: number;
  /** Lateral inhibition at LATERAL_INHIBITION. */
  inhibit?: boolean;
  /** Import-aware repulsion weight (absent or 0 = off). */
  imports?: number;
  /** Assumption revalidation: the chance a assumption holds through one change (absent = off). */
  assumptions?: number;
  /** SimParams.rework; absent keeps sweep.ts params() (0.5 for locks, 1.0 for FireTrident). */
  rework?: number;
}

/** What every run shares. */
export interface Context {
  timings: Timings;
  durationMs: number;
  warmupMs: number;
  workload: () => TaskSource;
  cochange: (path: string) => Neighbor[] | undefined;
  imports: (path: string) => Neighbor[] | undefined;
  /** The most-imported files (names without the package prefix) the diagnosis counts. */
  hubs: Set<string>;
}

/** Returns after warm-up, by what sent them back (see ReturnInfo). */
export interface ReturnTally {
  total: number;
  read: number;
  write: number;
  order: number;
  /** Returns found by the trunk writer, and how many of those were read-only. */
  trunk: number;
  trunkRead: number;
  /** Changed read paths of read-only returns, and how many of them are hub files. */
  readPaths: number;
  readPathsHub: number;
  /** Read-only returns with at least one changed hub read. */
  readHub: number;
}

/** One run's result. */
export type Row = SimResult & {
  step: string;
  variant: string;
  /** The SimParams.rework the run used. */
  rework: number;
  importWeight: number;
  assumptionHold: number | null;
  /** Landings that went past a changed read because their assumptions held, per 1,000 submitted. */
  keptPer1000: number | null;
  /** FireTrident only (locks lock every written file, so all their returns are read-only). */
  returns: ReturnTally | null;
};

const variant = (name: string, model: SimParams["model"], extra: Partial<Variant> = {}): Variant => ({ name, model, ...extra });
const LOCKS = variant("locks", "baseline");
const FT = variant("ft", "firetrident");
const FT_INH = variant("ft+inh", "firetrident", { inhibit: true });
const FT_CC = variant("ft+cc", "firetrident", { cochange: 2 });
const FT_CC_INH = variant("ft+cc+inh", "firetrident", { cochange: 2, inhibit: true });
const FT_CC5_INH = variant("ft+cc5+inh", "firetrident", { cochange: 5, inhibit: true });
const GROUP = variant("group", "firetrident-group");
const GROUP_INH = variant("group+inh", "firetrident-group", { inhibit: true });
const GROUP_CC = variant("group+cc", "firetrident-group", { cochange: 2 });
const GROUP_CC_INH = variant("group+cc+inh", "firetrident-group", { cochange: 2, inhibit: true });

/** What each step runs, and at which agent counts by default. */
export const STEPS: Record<string, { agents: number[]; variants: Variant[] }> = {
  q1: { agents: [100, 1_000, 10_000], variants: [LOCKS, FT, FT_CC_INH, FT_CC5_INH, GROUP, GROUP_CC_INH].flatMap((v) => [1, 0.5].map((rework) => ({ ...v, rework }))) },
  q2: { agents: [100, 1_000, 10_000], variants: [FT, FT_INH, FT_CC, FT_CC_INH, GROUP, GROUP_INH, GROUP_CC, GROUP_CC_INH] },
  q4: { agents: [100, 1_000, 10_000], variants: [FT_CC_INH, GROUP_CC_INH].flatMap((v) => [0, 1, 2].map((imports) => ({ ...v, imports }))) },
  q5: {
    agents: [100, 1_000, 10_000],
    variants: [LOCKS, FT, FT_CC_INH, GROUP_CC_INH].flatMap((v) => [v, ...[PROBE_HOLD.mixed, PROBE_HOLD.signature, 1].map((assumptions) => ({ ...v, assumptions }))]),
  },
};

/** Count one return (returns before warm-up are skipped, as the run's own counters skip them). */
export function tallyReturn(t: ReturnTally, r: ReturnInfo, hubs: Set<string>, warmupMs: number): void {
  if (r.at < warmupMs) return;
  t.total++;
  t[r.kind]++;
  if (r.where === "trunk") {
    t.trunk++;
    if (r.kind === "read") t.trunkRead++;
  }
  if (r.kind !== "read") return;
  let hub = false;
  for (const path of r.reads) {
    t.readPaths++;
    if (hubs.has(path.slice(path.indexOf("/") + 1))) {
      t.readPathsHub++;
      hub = true;
    }
  }
  if (hub) t.readHub++;
}

const perThousand = (n: number, of: number): number | null => (of > 0 ? Math.round((10_000 * n) / of) / 10 : null);

/** Run one variant once. */
export function runVariant(step: string, v: Variant, agents: number, seed: number, ctx: Context): Row {
  const defaults = simParams(v.model, agents, { durationMs: ctx.durationMs, warmupMs: ctx.warmupMs, seed, timings: ctx.timings, backlog: 1_000, rampMs: Math.min(60_000, agents * 5) });
  const p: SimParams = v.rework === undefined ? defaults : { ...defaults, rework: v.rework };
  const assumptions = v.assumptions === undefined ? undefined : { hold: v.assumptions };
  const tally: ReturnTally = { total: 0, read: 0, write: 0, order: 0, trunk: 0, trunkRead: 0, readPaths: 0, readPathsHub: 0, readHub: 0 };
  let sim: FireSim | BaselineSim;
  if (v.model === "baseline") {
    sim = new BaselineSim(p, ctx.workload(), () => "v0", assumptions ? { assumptions } : {});
  } else {
    const parts: ExtraRepulsion[] = [];
    if (v.cochange) parts.push(cochangeRepulsion(ctx.cochange, v.cochange));
    if (v.imports) parts.push(importRepulsion(ctx.imports, v.imports));
    sim = new FireSim(p, ctx.workload(), () => "v0", parts.length > 1 ? sumRepulsion(...parts) : parts[0], {
      ...(v.inhibit ? { inhibitAt: LATERAL_INHIBITION } : {}),
      ...(assumptions ? { assumptions } : {}),
      onReturn: (r) => tallyReturn(tally, r, ctx.hubs, ctx.warmupMs),
    });
  }
  const r = sim.run();
  return {
    step,
    variant: v.name,
    ...r,
    rework: p.rework,
    importWeight: v.imports ?? 0,
    assumptionHold: v.assumptions ?? null,
    keptPer1000: assumptions ? perThousand(sim.keptLandings, sim.m.submitted) : null,
    returns: v.model === "baseline" ? null : tally,
  };
}

/** The shared context from the workload model, the calibration and the co-change table. */
export function context(model: WorkloadModel, cal: Calibration, cochange: Record<string, Neighbor[]>, opts: { durationMs: number; warmupMs: number }): Context {
  const work = { medianMs: 60_000, sigma: 0.8 };
  return {
    timings: { ...cal.inPlatform, testMs: 0 },
    durationMs: opts.durationMs,
    warmupMs: opts.warmupMs,
    workload: () => new HistoryWorkload(model, { packages: 100, regionDepth: 3, maxReads: 8, work }),
    cochange: monorepoNeighbors(cochange),
    imports: monorepoImports(importTable(model)),
    hubs: new Set(mostImported(model, 3)),
  };
}

function list(v: string | undefined, fallback: number[]): number[] {
  return v ? v.split(",").map((x) => Number(x.trim())).filter((x) => Number.isFinite(x) && x > 0) : fallback;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      out: { type: "string" },
      steps: { type: "string" },
      agents: { type: "string" },
      seeds: { type: "string" },
      duration: { type: "string" },
      warmup: { type: "string" },
      tag: { type: "string" },
      neighbors: { type: "string" },
      model: { type: "string" },
      calibration: { type: "string" },
    },
    strict: true,
  });
  const out = values.out ?? join(HERE, "..", "..", "results", "2026-10-13-papers");
  const steps = (values.steps ?? "q1,q2,q4,q5,report").split(",").map((s) => s.trim());
  const log = (s: string) => console.error(`[${new Date().toISOString().slice(11, 19)}] ${s}`);
  mkdirSync(out, { recursive: true });
  const runs = steps.filter((s) => s !== "report");
  for (const s of runs) if (!STEPS[s]) throw new Error(`unknown step ${s} (q1, q2, q4, q5, report)`);

  if (runs.length > 0) {
    const nbFile = values.neighbors ?? join(HERE, "..", "..", "results", "2026-10-12-cochange", "neighbors.json");
    const nbDoc = JSON.parse(readFileSync(nbFile, "utf8")) as { k: number; minWeight: number; tables: Record<string, Record<string, Neighbor[]>> };
    const model = JSON.parse(readFileSync(values.model ?? join(HERE, "..", "..", "data", "hono-workload.json"), "utf8")) as WorkloadModel;
    const cal = JSON.parse(readFileSync(values.calibration ?? join(HERE, "..", "..", "data", "calibration.json"), "utf8")) as Calibration;
    const durationMs = Number(values.duration ?? 1_200) * 1000;
    const warmupMs = Number(values.warmup ?? 300) * 1000;
    const ctx = context(model, cal, nbDoc.tables["h200"]!, { durationMs, warmupMs });
    const seeds = list(values.seeds, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    for (const step of runs) {
      const spec = STEPS[step]!;
      const agentsList = list(values.agents, spec.agents);
      const results: Row[] = [];
      for (const agents of agentsList) {
        for (const v of spec.variants) {
          for (const seed of seeds) {
            const r = runVariant(step, v, agents, seed, ctx);
            results.push(r);
            const t = r.returns;
            log(
              `${step} ${v.name} rework=${r.rework} imports=${r.importWeight} assumptions=${r.assumptionHold ?? "-"} N=${agents} seed=${seed}: ${r.landingsPerMin}/min, rework ${r.reworkPct}%, conflicts ${r.conflictsPer1000}/1000` +
                `${t ? ` (read ${t.read}, write ${t.write}, order ${t.order})` : ""}${r.keptPer1000 !== null ? `, kept ${r.keptPer1000}/1000` : ""}, ${r.wallMs} ms`,
            );
          }
        }
      }
      const doc = {
        kind: "papers-sim",
        label: "SIMULATED",
        step,
        generatedAt: new Date().toISOString(),
        command: `node packages/bench/src/sim/papers.ts ${process.argv.slice(2).join(" ")}`,
        workload: ctx.workload().describe(),
        settings: { durationMs, warmupMs, backlog: 1_000, rampMs: "min(60 s, 5 ms x agents)", seeds, agents: agentsList, timings: ctx.timings },
        cochange: { k: nbDoc.k, minWeight: nbDoc.minWeight, table: "h200 (hono's last 200 first-parent commits)", source: "results/2026-10-12-cochange/neighbors.json" },
        inhibition: { inhibitAt: LATERAL_INHIBITION },
        hubs: [...ctx.hubs],
        assumptionHold: PROBE_HOLD,
        variants: spec.variants,
        results,
      };
      const file = join(out, `${step}${values.tag ? `-${values.tag}` : ""}.json`);
      writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
      log(`wrote ${file}`);
    }
  }

  if (steps.includes("report")) console.log(writeReport(out));
}

// ---------------------------------------------------------------------------
// Report: summary.json and the README tables
// ---------------------------------------------------------------------------

/** Two-sided 95% Student t quantiles for 1..30 degrees of freedom. */
const T95 = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042];
const t95 = (df: number): number => (df >= 1 ? (T95[Math.min(T95.length, Math.floor(df)) - 1] ?? 1.96) : Number.NaN);

/** Mean, sample standard deviation, 95% confidence half-width, min and max over seeds. */
export interface Stat {
  n: number;
  mean: number;
  sd: number;
  ci95: number;
  min: number;
  max: number;
}

/** Statistics of the finite values (null when there are none). */
export function stat(xs: Array<number | null | undefined>): Stat | null {
  const v = xs.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
  if (v.length === 0) return null;
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = v.length > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (v.length - 1)) : 0;
  return { n: v.length, mean, sd, ci95: v.length > 1 ? (t95(v.length - 1) * sd) / Math.sqrt(v.length) : Number.NaN, min: Math.min(...v), max: Math.max(...v) };
}

/** Difference of means b - a with a Welch 95% interval; `pct` is relative to a's mean. */
export function diff(a: Stat, b: Stat): { delta: number; lo: number; hi: number; pct: number; pctLo: number; pctHi: number } {
  const va = a.sd ** 2 / a.n;
  const vb = b.sd ** 2 / b.n;
  const se = Math.sqrt(va + vb);
  const df = se > 0 ? (va + vb) ** 2 / ((a.n > 1 ? va ** 2 / (a.n - 1) : 0) + (b.n > 1 ? vb ** 2 / (b.n - 1) : 0)) : Number.POSITIVE_INFINITY;
  const half = se > 0 ? t95(df) * se : 0;
  const delta = b.mean - a.mean;
  const rel = (x: number) => (a.mean !== 0 ? (100 * x) / a.mean : Number.NaN);
  return { delta, lo: delta - half, hi: delta + half, pct: rel(delta), pctLo: rel(delta - half), pctHi: rel(delta + half) };
}

/** Per-row metrics the report aggregates. */
const METRICS: Record<string, (r: Row) => number | null> = {
  landingsPerMin: (r) => r.landingsPerMin,
  reworkPct: (r) => r.reworkPct,
  conflictsPer1000: (r) => r.conflictsPer1000,
  writeWritePer1000: (r) => r.writeWritePer1000,
  e2eP50S: (r) => r.e2eP50S,
  e2eP99S: (r) => r.e2eP99S,
  keptPer1000: (r) => r.keptPer1000,
  readOnlyPct: (r) => (r.returns && r.returns.total > 0 ? (100 * r.returns.read) / r.returns.total : null),
  writePct: (r) => (r.returns && r.returns.total > 0 ? (100 * r.returns.write) / r.returns.total : null),
  orderPct: (r) => (r.returns && r.returns.total > 0 ? (100 * r.returns.order) / r.returns.total : null),
  trunkPct: (r) => (r.returns && r.returns.total > 0 ? (100 * r.returns.trunk) / r.returns.total : null),
  trunkReadPct: (r) => (r.returns && r.returns.trunk > 0 ? (100 * r.returns.trunkRead) / r.returns.trunk : null),
  hubReadPathPct: (r) => (r.returns && r.returns.readPaths > 0 ? (100 * r.returns.readPathsHub) / r.returns.readPaths : null),
  readsPerReturn: (r) => (r.returns && r.returns.read > 0 ? r.returns.readPaths / r.returns.read : null),
  hubReturnPct: (r) => (r.returns && r.returns.read > 0 ? (100 * r.returns.readHub) / r.returns.read : null),
  /** The published estimate of the read-only share: (conflicts - write-write) / conflicts with the existing counter. */
  publishedReadOnlyPct: (r) => (r.conflictsPer1000 > 0 ? (100 * (r.conflictsPer1000 - r.writeWritePer1000)) / r.conflictsPer1000 : null),
  /**
   * Assumption revalidation: the share of read-only-stale changes that went on to land, kept landings
   * over kept landings plus read-only returns (every read-only return failed its assumption check).
   */
  heldPct: (r) => {
    if (r.keptPer1000 === null) return null;
    const readOnly = r.returns ? (r.returns.total > 0 ? (r.conflictsPer1000 * r.returns.read) / r.returns.total : 0) : r.conflictsPer1000;
    return r.keptPer1000 + readOnly > 0 ? (100 * r.keptPer1000) / (r.keptPer1000 + readOnly) : null;
  },
};

type Agg = { n: number; seeds: number[] } & Record<string, Stat | null | number | number[]>;

const keyOf = (step: string, variant: string, agents: number, rework: number, importWeight: number, assumptionHold: number | null): string =>
  `${step}|${variant}|${agents}|${rework}|${importWeight}|${assumptionHold ?? "-"}`;
const rowKey = (r: Row): string => keyOf(r.step, r.variant, r.agents, r.rework, r.importWeight, r.assumptionHold);

/** Aggregate rows over seeds, by step, variant, agents, rework, import weight and assumption hold. */
export function aggregate(rows: Row[]): Map<string, Agg> {
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const g = groups.get(rowKey(r));
    if (g) g.push(r);
    else groups.set(rowKey(r), [r]);
  }
  return new Map(
    [...groups].map(([k, g]) => {
      const agg: Agg = { n: g.length, seeds: g.map((r) => r.seed).sort((a, b) => a - b) };
      for (const [name, f] of Object.entries(METRICS)) agg[name] = stat(g.map(f));
      return [k, agg];
    }),
  );
}

/** Every row of every step file in `out`, once per configuration and seed (runs are deterministic, so a repeat is the same row). */
function readRows(out: string): Row[] {
  const rows = new Map<string, Row>();
  for (const f of readdirSync(out).sort()) {
    if (!/^q\d.*\.json$/.test(f)) continue;
    const doc = JSON.parse(readFileSync(join(out, f), "utf8")) as { kind?: string; results?: Row[] };
    if (doc.kind === "papers-sim" && Array.isArray(doc.results)) for (const r of doc.results) rows.set(`${rowKey(r)}|${r.seed}`, r);
  }
  return [...rows.values()];
}

/**
 * Compare the rows that repeat a published configuration (default rework, no imports, no assumptions)
 * with results/2026-10-12-inhibition/sim-steady.json, seed by seed.
 */
function checkPublished(rows: Row[], published: string): { compared: number; identical: number; differ: string[] } {
  const doc = JSON.parse(readFileSync(published, "utf8")) as { results: SimResult[] & Array<{ variant: string }> };
  const mine = new Map<string, Row>();
  for (const r of rows) {
    if (r.importWeight !== 0 || r.assumptionHold !== null || r.rework !== (r.model === "baseline" ? 0.5 : 1)) continue;
    mine.set(`${r.variant === "locks" ? "baseline" : r.variant}|${r.agents}|${r.seed}`, r);
  }
  let compared = 0;
  let identical = 0;
  const differ: string[] = [];
  for (const p of doc.results as Array<SimResult & { variant: string }>) {
    const m = mine.get(`${p.variant}|${p.agents}|${p.seed}`);
    if (!m) continue;
    compared++;
    const same = (["landingsPerMin", "reworkPct", "conflictsPer1000", "writeWritePer1000", "e2eP50S", "submittedPerMin"] as const).every((k) => m[k] === p[k]);
    if (same) identical++;
    else differ.push(`${p.variant} N=${p.agents} seed=${p.seed}`);
  }
  return { compared, identical, differ };
}

const f1 = (x: number | null | undefined): string => (x === null || x === undefined || !Number.isFinite(x) ? "-" : x.toFixed(1));
const f0 = (x: number | null | undefined): string => (x === null || x === undefined || !Number.isFinite(x) ? "-" : Math.round(x).toLocaleString("en-US"));
const st = (a: Agg | undefined, m: string): Stat | null => (a ? ((a[m] as Stat | null) ?? null) : null);
const pm = (s: Stat | null, digits = 1): string => (s ? `${s.mean.toFixed(digits)} ± ${Number.isFinite(s.ci95) ? s.ci95.toFixed(digits) : "-"}` : "-");
const sign = (x: number, digits = 1): string => `${x >= 0 ? "+" : ""}${x.toFixed(digits)}`;
const n0 = (n: number) => n.toLocaleString("en-US");

/** Write summary.json in `out` and return the README tables as markdown. */
export function writeReport(out: string): string {
  const rows = readRows(out);
  const agg = aggregate(rows);
  const A = (step: string, v: string, agents: number, opts: { rework?: number; imports?: number; assumptions?: number | null } = {}) => {
    const rework = opts.rework ?? (v === "locks" ? 0.5 : 1);
    return agg.get(keyOf(step, v, agents, rework, opts.imports ?? 0, opts.assumptions ?? null));
  };
  const published = join(HERE, "..", "..", "results", "2026-10-12-inhibition", "sim-steady.json");
  const check = checkPublished(rows, published);
  writeFileSync(
    join(out, "summary.json"),
    `${JSON.stringify({ kind: "papers-summary", label: "SIMULATED", generatedAt: new Date().toISOString(), note: "mean, sd, ci95 (Student t over seeds), min, max per configuration; key = step|variant|agents|rework|importWeight|assumptionHold", checkAgainstPublished: check, configs: Object.fromEntries(agg) }, null, 2)}\n`,
  );
  const agentsOf = (step: string) => [...new Set(rows.filter((r) => r.step === step).map((r) => r.agents))].sort((a, b) => a - b);
  const seedsOf = (step: string) => [...new Set(rows.filter((r) => r.step === step).map((r) => r.seed))].sort((a, b) => a - b);
  const md: string[] = [];
  md.push(`Published-run check: ${check.identical} of ${check.compared} rows that repeat a configuration of results/2026-10-12-inhibition/sim-steady.json are identical seed by seed${check.differ.length ? ` (differ: ${check.differ.join(", ")})` : ""}.`, "");

  const LABEL: Record<string, string> = {
    locks: "Locks + one merge queue",
    ft: "Plain optimistic claims, per-lane commits",
    "ft+inh": "Per-lane commits + inhibition",
    "ft+cc": "Per-lane commits + co-change 2",
    "ft+cc+inh": "Per-lane commits + co-change 2 + inhibition",
    "ft+cc5+inh": "Per-lane commits + co-change 5 + inhibition",
    group: "Plain optimistic claims, group commit",
    "group+inh": "Group commit + inhibition",
    "group+cc": "Group commit + co-change 2",
    "group+cc+inh": "Group commit + co-change 2 + inhibition (deployed)",
  };

  // Q1: equal retry costs.
  if (rows.some((r) => r.step === "q1")) {
    md.push(`### Q1. Equal retry costs (SIMULATED, seeds ${seedsOf("q1").join(", ")}; mean ± 95% CI over seeds)`, "");
    for (const n of agentsOf("q1")) {
      md.push(`${n0(n)} agents:`, "", "| model | retry cost | rework % | landed/min | conflicts per 1,000 | retry cost | rework % | landed/min | conflicts per 1,000 |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
      for (const v of ["locks", "ft", "ft+cc+inh", "ft+cc5+inh", "group", "group+cc+inh"]) {
        const a = A("q1", v, n, { rework: 1 });
        const b = A("q1", v, n, { rework: 0.5 });
        if (!a && !b) continue;
        const cells = (x: Agg | undefined) => `${pm(st(x, "reworkPct"))} | ${f1(st(x, "landingsPerMin")?.mean)} | ${f0(st(x, "conflictsPer1000")?.mean)}`;
        md.push(`| ${LABEL[v]} | 1.0${v === "locks" ? "" : " (as published)"} | ${cells(a)} | 0.5${v === "locks" ? " (as published)" : ""} | ${cells(b)} |`);
      }
      md.push("");
    }
  }

  // Q2: inhibition's throughput cost.
  if (rows.some((r) => r.step === "q2")) {
    md.push(`### Q2. What lateral inhibition costs in throughput (SIMULATED, seeds ${seedsOf("q2").join(", ")}; change = difference of means with a Welch 95% CI)`, "");
    md.push("| agents | trunk writer | co-change | landed/min, off | landed/min, on | change | rework %, off → on | conflicts per 1,000, off → on |", "| --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const n of agentsOf("q2")) {
      for (const [off, on, writer, cc] of [
        ["ft", "ft+inh", "per-lane commits", "off"],
        ["ft+cc", "ft+cc+inh", "per-lane commits", "2"],
        ["group", "group+inh", "group commit", "off"],
        ["group+cc", "group+cc+inh", "group commit", "2 (deployed)"],
      ] as const) {
        const a = st(A("q2", off, n), "landingsPerMin");
        const b = st(A("q2", on, n), "landingsPerMin");
        if (!a || !b) continue;
        const d = diff(a, b);
        md.push(
          `| ${n0(n)} | ${writer} | ${cc} | ${pm(a)} | ${pm(b)} | ${sign(d.pct)}% (${sign(d.pctLo)} to ${sign(d.pctHi)}) | ${f1(st(A("q2", off, n), "reworkPct")?.mean)} → ${f1(st(A("q2", on, n), "reworkPct")?.mean)} | ${f0(st(A("q2", off, n), "conflictsPer1000")?.mean)} → ${f0(st(A("q2", on, n), "conflictsPer1000")?.mean)} |`,
        );
      }
    }
    md.push("");
  }

  // Q3: what the remaining returns are (from the q2 runs).
  if (rows.some((r) => r.step === "q2" && r.returns)) {
    md.push(`### Q3. What sends changes back (SIMULATED, the Q2 runs; shares of returns after warm-up, mean ± 95% CI over seeds)`, "");
    md.push(
      "| agents | model | conflicts per 1,000 | read-only, from the published counter | read-only, classified | write-write | write after a read in the same group commit | found by the trunk writer | trunk-writer returns that were read-only | changed reads on the top-3 files | read-only returns touching a top-3 file | changed reads per read-only return |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    );
    for (const n of agentsOf("q2")) {
      for (const v of ["ft", "ft+inh", "ft+cc+inh", "group", "group+inh", "group+cc+inh"]) {
        const a = A("q2", v, n);
        if (!a) continue;
        const p = (m: string) => `${pm(st(a, m))}%`;
        md.push(
          `| ${n0(n)} | ${LABEL[v]} | ${f0(st(a, "conflictsPer1000")?.mean)} | ${p("publishedReadOnlyPct")} | ${p("readOnlyPct")} | ${p("writePct")} | ${p("orderPct")} | ${p("trunkPct")} | ${p("trunkReadPct")} | ${p("hubReadPathPct")} | ${p("hubReturnPct")} | ${pm(st(a, "readsPerReturn"), 2)} |`,
        );
      }
    }
    md.push("");
  }

  // Q4: import-aware take().
  if (rows.some((r) => r.step === "q4")) {
    md.push(`### Q4. Import-aware take() (ANALYSIS, not built; SIMULATED, seeds ${seedsOf("q4").join(", ")}; mean ± 95% CI over seeds)`, "");
    md.push("| agents | model | import weight | rework % | landed/min | landed/min vs weight 0 | conflicts per 1,000 | claim to land p50 s | p99 s |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const n of agentsOf("q4")) {
      for (const v of ["ft+cc+inh", "group+cc+inh"]) {
        const base = st(A("q4", v, n, { imports: 0 }), "landingsPerMin");
        for (const w of [0, 1, 2]) {
          const a = A("q4", v, n, { imports: w });
          if (!a) continue;
          const l = st(a, "landingsPerMin");
          const d = base && l && w > 0 ? diff(base, l) : null;
          md.push(`| ${n0(n)} | ${LABEL[v]} | ${w} | ${pm(st(a, "reworkPct"))} | ${pm(l)} | ${d ? `${sign(d.pct)}% (${sign(d.pctLo)} to ${sign(d.pctHi)})` : "-"} | ${f0(st(a, "conflictsPer1000")?.mean)} | ${f0(st(a, "e2eP50S")?.mean)} | ${f0(st(a, "e2eP99S")?.mean)} |`);
        }
      }
    }
    md.push("");
  }

  // Q5: assumption revalidation.
  if (rows.some((r) => r.step === "q5")) {
    md.push(`### Q5. Assumption revalidation (ANALYSIS, not built; SIMULATED, seeds ${seedsOf("q5").join(", ")}; mean ± 95% CI over seeds)`, "");
    md.push(
      "| agents | model | assumption holds per change | rework % | landed/min | landed/min vs off | conflicts per 1,000 | kept landings per 1,000 submitted | read-only-stale changes that landed |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    );
    for (const n of agentsOf("q5")) {
      for (const v of ["locks", "ft", "ft+cc+inh", "group+cc+inh"]) {
        const base = st(A("q5", v, n), "landingsPerMin");
        for (const h of [null, PROBE_HOLD.mixed, PROBE_HOLD.signature, 1]) {
          const a = A("q5", v, n, { assumptions: h });
          if (!a) continue;
          const l = st(a, "landingsPerMin");
          const d = base && l && h !== null ? diff(base, l) : null;
          const label = h === null ? "off (as built)" : h === 1 ? "always (upper bound)" : `${(100 * h).toFixed(1)}%`;
          const held = st(a, "heldPct");
          md.push(
            `| ${n0(n)} | ${LABEL[v]} | ${label} | ${pm(st(a, "reworkPct"))} | ${pm(l)} | ${d ? `${sign(d.pct)}% (${sign(d.pctLo)} to ${sign(d.pctHi)})` : "-"} | ${f0(st(a, "conflictsPer1000")?.mean)} | ${f1(st(a, "keptPer1000")?.mean)} | ${held ? `${f1(held.mean)}%` : "-"} |`,
          );
        }
      }
    }
    md.push("");
  }
  return md.join("\n");
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
  main().catch((e) => {
    console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
    process.exit(1);
  });
}
