#!/usr/bin/env node
/**
 * Co-change repulsion: calibrate the co-change map on a real history, then measure self-assignment
 * with and without it in the simulator.
 *
 *   node packages/bench/src/sim/cochange.ts --repo /tmp/ft-w2/hono --out packages/bench/results/2026-10-12-cochange
 *
 * Steps:
 *  1. History: the first-parent chain of --repo, oldest first, merges skipped, renames as delete + add
 *     (what TrunkDO mines from trunk through tree diffs), with author emails for STDP follow-ups.
 *  2. Link prediction (MEASURED on the real history): train the map on 200 commits (TrunkDO's import
 *     depth), then for every file of each of the next 100 commits predict its co-changed files from
 *     its top-k neighbors. Precision and recall at k, against a "most changed files" predictor.
 *  3. Neighbor tables: the map mined from the last 200 commits (what TrunkDO.init mines on import)
 *     and from the whole chain.
 *  4. Steady state (SIMULATED): the hono workload of the 2026-10-12 benchmark, FireTrident with and
 *     without co-change repulsion (ColonyDO.take adds weight * core neighborRepulsion to the claim
 *     overlap), against the locks + merge queue baseline.
 *  5. Time to zero (SIMULATED): a fixed set of tasks, all open at t = 0, until the last one lands.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
// Direct import until packages/core/src/index.ts re-exports cochange.ts (orchestrator-owned).
import { CoChangeGraph, changeFiles, followUps, neighborRepulsion } from "@fire_trident/core";
import type { CoChangeParams, Neighbor } from "@fire_trident/core";
import type { WorkloadModel } from "../workload.ts";
import { BaselineSim } from "./baseline.ts";
import type { SimParams, SimResult, Timings } from "./common.ts";
import { FireSim, type ExtraRepulsion } from "./fire.ts";
import { params as simParams, type Calibration } from "./sweep.ts";
import { HistoryWorkload, type SimTask, type TaskSource } from "./workloads.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

/** One commit of the history. */
export interface Commit {
  hash: string;
  at: number;
  author: string;
  paths: string[];
}

/** The first-parent chain of `repo` at HEAD, oldest first, merges skipped (read-only). */
export function loadHistory(repo: string): Commit[] {
  const text = execFileSync("git", ["-C", repo, "log", "--first-parent", "--no-merges", "--no-renames", "--format=@@%H%x09%ct%x09%ae", "--name-only", "HEAD"], {
    maxBuffer: 256 * 1024 * 1024,
  }).toString();
  const out: Commit[] = [];
  let cur: Commit | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("@@")) {
      const [hash = "", at = "0", author = ""] = line.slice(2).split("\t");
      cur = { hash, at: Number(at) * 1000, author, paths: [] };
      out.push(cur);
    } else if (line.trim() && cur) {
      cur.paths.push(line.trim());
    }
  }
  return out.reverse();
}

/** Learn `commits` (oldest first) into a fresh map; STDP from same-author follow-ups when `stdp`. */
export function mine(commits: Commit[], params: Partial<CoChangeParams>, stdp: boolean): CoChangeGraph {
  const g = new CoChangeGraph(params);
  const preds = stdp ? followUps(commits) : [];
  commits.forEach((c, i) => g.learn(c.paths, preds[i] ?? []));
  return g;
}

/** Link prediction scores at each k. */
export interface LinkScores {
  queries: number;
  covered: number;
  precision: Record<string, number>;
  recall: Record<string, number>;
  popularity: { precision: Record<string, number>; recall: Record<string, number> };
  /** Direction: queries are files of a commit that follows the same author's previous commit; truth is that commit's other files. */
  upstream: { queries: number; precision: Record<string, number>; recall: Record<string, number> };
}

/** Test commits are filtered the same way whatever the training parameters. */
const TEST_MAX_FILES = 30;

/**
 * Train on `train` commits, test on the next `test`, sliding by `step`. A query is one file of a
 * test commit with 2..30 files; its truth is the commit's other files. Precision averages over
 * queries with at least one prediction; recall over all queries. The upstream score asks the same
 * ranking for the files of the author's previous commit (within 2 days) that the new commit did not
 * touch: the direction STDP learns.
 */
export function linkPrediction(history: Commit[], opts: { train: number; test: number; step: number; ks: number[]; params: Partial<CoChangeParams>; stdp: boolean }): LinkScores {
  const maxK = Math.max(...opts.ks);
  const zero = () => Object.fromEntries(opts.ks.map((k) => [k, 0])) as Record<number, number>;
  const p = zero();
  const r = zero();
  const pp = zero();
  const pr = zero();
  const pn = zero();
  const up = zero();
  const ur = zero();
  const un = zero();
  let queries = 0;
  let covered = 0;
  let upQueries = 0;
  const preds = followUps(history);
  for (let t = opts.train; t + opts.test <= history.length; t += opts.step) {
    const window = history.slice(t - opts.train, t);
    const g = mine(window, opts.params, opts.stdp);
    const counts = new Map<string, number>();
    for (const c of window) for (const f of changeFiles(c.paths, TEST_MAX_FILES) ?? []) counts.set(f, (counts.get(f) ?? 0) + 1);
    const popular = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([f]) => f);
    const cache = new Map<string, Neighbor[]>();
    const nbOf = (f: string): Neighbor[] => {
      let nb = cache.get(f);
      if (!nb) {
        nb = g.neighbors(f, maxK);
        cache.set(f, nb);
      }
      return nb;
    };
    for (let i = t; i < t + opts.test; i++) {
      const files = changeFiles(history[i]!.paths, TEST_MAX_FILES);
      if (!files) continue;
      if (files.length >= 2) {
        for (const f of files) {
          const truth = new Set(files.filter((x) => x !== f));
          queries++;
          const nb = nbOf(f);
          if (nb.length > 0) covered++;
          const pop = popular.filter((x) => x !== f).slice(0, maxK);
          for (const k of opts.ks) {
            const top = nb.slice(0, k);
            const hits = top.filter((n) => truth.has(n.path)).length;
            if (top.length > 0) p[k]! += hits / top.length;
            r[k]! += hits / truth.size;
            const ptop = pop.slice(0, k);
            const phits = ptop.filter((x) => truth.has(x)).length;
            if (ptop.length > 0) {
              pp[k]! += phits / ptop.length;
              pn[k]!++;
            }
            pr[k]! += phits / truth.size;
          }
        }
      }
      const prev = (preds[i] ?? []).find((x) => x.lag === 1);
      const before = prev ? changeFiles(prev.paths, TEST_MAX_FILES) : null;
      if (!before) continue;
      const now = new Set(files);
      const truth = new Set(before.filter((x) => !now.has(x)));
      if (truth.size === 0) continue;
      for (const f of files) {
        if (before.includes(f)) continue;
        upQueries++;
        const nb = nbOf(f).filter((n) => !now.has(n.path));
        for (const k of opts.ks) {
          const top = nb.slice(0, k);
          const hits = top.filter((n) => truth.has(n.path)).length;
          if (top.length > 0) {
            up[k]! += hits / top.length;
            un[k]!++;
          }
          ur[k]! += hits / truth.size;
        }
      }
    }
  }
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  const out: LinkScores = { queries, covered, precision: {}, recall: {}, popularity: { precision: {}, recall: {} }, upstream: { queries: upQueries, precision: {}, recall: {} } };
  for (const k of opts.ks) {
    out.precision[k] = r3(covered > 0 ? p[k]! / covered : 0);
    out.recall[k] = r3(queries > 0 ? r[k]! / queries : 0);
    out.popularity.precision[k] = r3(pn[k]! > 0 ? pp[k]! / pn[k]! : 0);
    out.popularity.recall[k] = r3(queries > 0 ? pr[k]! / queries : 0);
    out.upstream.precision[k] = r3(un[k]! > 0 ? up[k]! / un[k]! : 0);
    out.upstream.recall[k] = r3(upQueries > 0 ? ur[k]! / upQueries : 0);
  }
  return out;
}

/** Neighbor table (top k, weight >= minWeight) for every file the map knows. */
export function neighborTable(g: CoChangeGraph, k: number, minWeight: number): Record<string, Neighbor[]> {
  const out: Record<string, Neighbor[]> = {};
  for (const f of g.paths()) {
    const nb = g.neighbors(f, k, minWeight);
    if (nb.length > 0) out[f] = nb.map((n) => ({ path: n.path, weight: Math.round(n.weight * 1e4) / 1e4 }));
  }
  return out;
}

/**
 * Neighbors of monorepo paths `p<k>/<file>`: the history's neighbors of `<file>` inside the same
 * package copy (every copy shares hono's history). Cached per path.
 */
export function monorepoNeighbors(table: Record<string, Neighbor[]>): (path: string) => Neighbor[] | undefined {
  const cache = new Map<string, Neighbor[] | undefined>();
  return (path) => {
    if (cache.has(path)) return cache.get(path);
    const slash = path.indexOf("/");
    let out: Neighbor[] | undefined;
    if (slash > 0) {
      const prefix = path.slice(0, slash + 1);
      const nb = Object.hasOwn(table, path.slice(slash + 1)) ? table[path.slice(slash + 1)] : undefined;
      out = nb?.map((n) => ({ path: prefix + n.path, weight: n.weight }));
    }
    cache.set(path, out);
    return out;
  };
}

/**
 * The extra repulsion ColonyDO.take adds: weight * neighborRepulsion over the task's footprint (its
 * writes); `relative` subtracts the least exposed admitted candidate's value (see ExtraRepulsion).
 */
export function cochangeRepulsion(neighbors: (path: string) => Neighbor[] | undefined, weight: number, relative = false): ExtraRepulsion {
  const fn: ExtraRepulsion = (t: SimTask, claimOn) => weight * neighborRepulsion(t.writes, neighbors, claimOn);
  fn.relative = relative;
  return fn;
}

/** A run of a fixed set of tasks: no refill beyond `total`; stops once every task has landed. */
function finite<T extends FireSim | BaselineSim>(sim: T, total: number): T & { made: number } {
  const s = sim as T & { made: number };
  s.made = 0;
  s.refill = function (this: T & { made: number }) {
    while (this.made < total && this.open.size < this.p.backlog) this.open.add(this.source.make(this.made++, this.q.now, this.rng));
  };
  return s;
}

/** Time-to-zero result. */
export interface TtzResult {
  variant: string;
  agents: number;
  seed: number;
  tasks: number;
  landed: number;
  timeToZeroS: number | null;
  /** Seconds until 50%, 90% and 95% of the tasks had landed (the last few are a noisy tail). */
  timeTo50S: number | null;
  timeTo90S: number | null;
  timeTo95S: number | null;
  reworkPct: number;
  conflictsPer1000: number;
  writeWritePer1000: number;
  submitted: number;
}

/** Run a finite workload until every task lands (or `capMs`), stepping 1 s. */
export function runToZero(variant: string, sim: FireSim | BaselineSim, total: number, capMs: number): TtzResult {
  const s = finite(sim, total);
  s.refill();
  (s as unknown as { start(): void }).start();
  let t = 0;
  const marks: Record<number, number | null> = { 50: null, 90: null, 95: null };
  while (t < capMs && s.m.landed < total) {
    t += 1_000;
    s.q.run(t);
    for (const f of [50, 90, 95]) if (marks[f] === null && s.m.landed >= Math.ceil((f / 100) * total)) marks[f] = t / 1000;
  }
  const m = s.m;
  return {
    variant,
    agents: s.p.agents,
    seed: s.p.seed,
    tasks: total,
    landed: m.landed,
    timeToZeroS: m.landed >= total ? t / 1000 : null,
    timeTo50S: marks[50] ?? null,
    timeTo90S: marks[90] ?? null,
    timeTo95S: marks[95] ?? null,
    reworkPct: Math.round((m.workMs > 0 ? (100 * m.reworkMs) / m.workMs : 0) * 100) / 100,
    conflictsPer1000: Math.round((m.submitted > 0 ? (1000 * m.invalidated) / m.submitted : 0) * 10) / 10,
    writeWritePer1000: Math.round((m.submitted > 0 ? (1000 * m.invalidatedWriteWrite) / m.submitted : 0) * 10) / 10,
    submitted: m.submitted,
  };
}

/** A simulated variant: which model, and which co-change table (if any) at which weight. */
export interface Variant {
  name: string;
  model: SimParams["model"];
  table?: string;
  weight?: number;
}

function list(v: string | undefined, fallback: number[]): number[] {
  return v ? v.split(",").map((x) => Number(x.trim())).filter((x) => Number.isFinite(x) && x > 0) : fallback;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      repo: { type: "string" },
      out: { type: "string" },
      steps: { type: "string" },
      agents: { type: "string" },
      seeds: { type: "string" },
      duration: { type: "string" },
      warmup: { type: "string" },
      "ttz-agents": { type: "string" },
      "ttz-tasks": { type: "string" },
      "ttz-seeds": { type: "string" },
      k: { type: "string" },
      "min-weight": { type: "string" },
      weight: { type: "string" },
      variants: { type: "string" },
      model: { type: "string" },
      calibration: { type: "string" },
    },
    strict: true,
  });
  const repo = values.repo ?? "/tmp/ft-w2/hono";
  const out = values.out ?? join(HERE, "..", "..", "results", "2026-10-12-cochange");
  const steps = new Set((values.steps ?? "linkpred,tables,sim,ttz,weights,analysis,report").split(",").map((s) => s.trim()));
  const k = Number(values.k ?? 8);
  const minWeight = Number(values["min-weight"] ?? 0.1);
  const weight = Number(values.weight ?? 2);
  const log = (s: string) => console.error(`[${new Date().toISOString().slice(11, 19)}] ${s}`);
  mkdirSync(out, { recursive: true });

  if (steps.size === 1 && steps.has("report")) {
    writeReport(out);
    return;
  }
  const history = loadHistory(repo);
  log(`history: ${history.length} first-parent commits (merges skipped), ${new Date(history[0]!.at).toISOString().slice(0, 10)} to ${new Date(history.at(-1)!.at).toISOString().slice(0, 10)}`);
  const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"]).toString().trim();

  if (steps.has("linkpred")) {
    const ks = [1, 3, 5, 8];
    const grid: Array<{ name: string; params: Partial<CoChangeParams>; stdp: boolean }> = [
      { name: "default (retain 0.98, prior 1, maxFiles 30, STDP 0.25, follow-ups within 6 h)", params: {}, stdp: true },
      { name: "no STDP", params: {}, stdp: false },
      { name: "prior 0.5", params: { prior: 0.5 }, stdp: true },
      { name: "prior 2", params: { prior: 2 }, stdp: true },
      { name: "retain 0.9", params: { retain: 0.9 }, stdp: true },
      { name: "retain 1 (no decay)", params: { retain: 1 }, stdp: true },
      { name: "maxFiles 10", params: { maxFiles: 10 }, stdp: true },
      { name: "maxFiles 15", params: { maxFiles: 15 }, stdp: true },
      { name: "prior 2, maxFiles 15", params: { prior: 2, maxFiles: 15 }, stdp: true },
      { name: "STDP 0.5", params: { stdpPlus: 0.5, stdpMinus: 0.5 }, stdp: true },
    ];
    const rows = grid.map((gv) => {
      const t0 = performance.now();
      const scores = linkPrediction(history, { train: 200, test: 100, step: 100, ks, params: gv.params, stdp: gv.stdp });
      log(`linkpred ${gv.name}: P@1 ${scores.precision[1]} P@3 ${scores.precision[3]} R@8 ${scores.recall[8]} coverage ${(scores.covered / Math.max(1, scores.queries)).toFixed(3)} (popularity P@3 ${scores.popularity.precision[3]}); upstream P@3 ${scores.upstream.precision[3]} R@8 ${scores.upstream.recall[8]} (${scores.upstream.queries} q) in ${Math.round(performance.now() - t0)} ms`);
      return { name: gv.name, params: gv.params, stdp: gv.stdp, ...scores };
    });
    writeFileSync(
      join(out, "linkpred.json"),
      `${JSON.stringify({ kind: "linkpred", label: "MEASURED", generatedAt: new Date().toISOString(), repo: "https://github.com/honojs/hono", head, commits: history.length, method: "train on 200 first-parent commits, predict each file's co-changed files in the next 100, slide by 100", rows }, null, 2)}\n`,
    );
  }

  const tables: Record<string, Record<string, Neighbor[]>> = {};
  if (["tables", "sim", "ttz", "weights", "analysis"].some((s) => steps.has(s))) {
    const last200 = mine(history.slice(-200), {}, true);
    const full = mine(history, {}, true);
    tables["h200"] = neighborTable(last200, k, minWeight);
    tables["full"] = neighborTable(full, k, minWeight);
    const describe = (name: string, g: CoChangeGraph) => {
      const t = tables[name]!;
      const n = Object.values(t).map((x) => x.length);
      return { ...g.stats(), filesWithNeighbors: n.length, meanNeighbors: Math.round((n.reduce((a, b) => a + b, 0) / Math.max(1, n.length)) * 100) / 100 };
    };
    const meta = { h200: describe("h200", last200), full: describe("full", full) };
    log(`tables: h200 ${JSON.stringify(meta.h200)}; full ${JSON.stringify(meta.full)}`);
    if (steps.has("tables")) {
      writeFileSync(
        join(out, "neighbors.json"),
        `${JSON.stringify({ kind: "cochange-neighbors", generatedAt: new Date().toISOString(), repo: "https://github.com/honojs/hono", head, k, minWeight, meta, tables })}\n`,
      );
    }
  }

  const model = JSON.parse(readFileSync(values.model ?? join(HERE, "..", "..", "data", "hono-workload.json"), "utf8")) as WorkloadModel;
  const cal = JSON.parse(readFileSync(values.calibration ?? join(HERE, "..", "..", "data", "calibration.json"), "utf8")) as Calibration;
  const timings: Timings = { ...cal.inPlatform, testMs: 0 };
  const work = { medianMs: 60_000, sigma: 0.8 };
  const mk = (): TaskSource => new HistoryWorkload(model, { packages: 100, regionDepth: 3, maxReads: 8, work });
  const allVariants: Variant[] = [
    { name: "baseline", model: "baseline" },
    { name: "firetrident", model: "firetrident" },
    { name: "firetrident+cochange", model: "firetrident", table: "h200", weight },
    { name: "firetrident+cochange(full history)", model: "firetrident", table: "full", weight },
    { name: "firetrident-group", model: "firetrident-group" },
    { name: "firetrident-group+cochange", model: "firetrident-group", table: "h200", weight },
  ];
  const wanted = values.variants ? new Set(values.variants.split(",").map((s) => s.trim())) : null;
  const variants = allVariants.filter((v) => !wanted || wanted.has(v.name));
  const build = (v: Variant, p: SimParams, source: TaskSource): FireSim | BaselineSim => {
    if (v.model === "baseline") return new BaselineSim(p, source, () => "v0");
    const extra = v.table ? cochangeRepulsion(monorepoNeighbors(tables[v.table]!), v.weight ?? 1) : undefined;
    return new FireSim(p, source, () => "v0", extra);
  };

  if (steps.has("sim")) {
    const agentsList = list(values.agents, [100, 1_000, 10_000]);
    const seeds = list(values.seeds, [1, 2, 3]);
    const durationMs = Number(values.duration ?? 1_200) * 1000;
    const warmupMs = Number(values.warmup ?? 300) * 1000;
    const results: Array<SimResult & { variant: string }> = [];
    for (const agents of agentsList) {
      for (const v of variants) {
        for (const seed of seeds) {
          const p = simParams(v.model, agents, { durationMs, warmupMs, seed, timings, backlog: 1_000, rampMs: Math.min(60_000, agents * 5) });
          const r = build(v, p, mk()).run();
          results.push({ variant: v.name, ...r });
          log(`${v.name} N=${agents} seed=${seed}: ${r.landingsPerMin}/min, rework ${r.reworkPct}%, conflicts ${r.conflictsPer1000}/1000 (ww ${r.writeWritePer1000}), e2e p50 ${r.e2eP50S}s, ${r.wallMs} ms`);
        }
      }
    }
    writeFileSync(
      join(out, "sim-steady.json"),
      `${JSON.stringify({ kind: "sim", label: "SIMULATED", generatedAt: new Date().toISOString(), workload: mk().describe(), cochange: { k, minWeight, weight, tables: "h200 = last 200 first-parent commits (TrunkDO import depth); full = whole chain" }, durationMs, warmupMs, results }, null, 2)}\n`,
    );
  }

  if (steps.has("ttz")) {
    const agentsList = list(values["ttz-agents"], [100, 1_000]);
    const seeds = list(values["ttz-seeds"], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const tasks = Number(values["ttz-tasks"] ?? 1_500);
    const results: TtzResult[] = [];
    for (const agents of agentsList) {
      for (const v of variants) {
        for (const seed of seeds) {
          const p = simParams(v.model, agents, { durationMs: 4 * 3_600_000, warmupMs: 0, seed, timings, backlog: tasks, rampMs: Math.min(60_000, agents * 5) });
          const r = runToZero(v.name, build(v, p, mk()), tasks, p.durationMs);
          results.push(r);
          log(`ttz ${v.name} N=${agents} seed=${seed}: ${r.timeToZeroS ?? "not done"} s (90% ${r.timeTo90S} s), rework ${r.reworkPct}%, conflicts ${r.conflictsPer1000}/1000`);
        }
      }
    }
    writeFileSync(
      join(out, "sim-ttz.json"),
      `${JSON.stringify({ kind: "sim-ttz", label: "SIMULATED", generatedAt: new Date().toISOString(), workload: mk().describe(), tasks, cochange: { k, minWeight, weight }, results }, null, 2)}\n`,
    );
  }

  const steady = (model: SimParams["model"], agents: number, seed: number, extra?: ExtraRepulsion): SimResult => {
    const p = simParams(model, agents, { durationMs: 1_200_000, warmupMs: 300_000, seed, timings, backlog: 1_000, rampMs: Math.min(60_000, agents * 5) });
    return new FireSim(p, mk(), () => "v0", extra).run();
  };

  if (steps.has("weights")) {
    // Dose-response: the co-change weight ColonyDO.take applies, 0 = off.
    const seeds = list(values.seeds, [1, 2, 3]);
    const nb = monorepoNeighbors(tables["h200"]!);
    const results: Array<SimResult & { weight: number }> = [];
    for (const agents of [1_000, 10_000]) {
      for (const model of ["firetrident", "firetrident-group"] as const) {
        for (const w of [0, 1, 2, 3, 10]) {
          for (const seed of seeds) {
            const r = steady(model, agents, seed, w > 0 ? cochangeRepulsion(nb, w) : undefined);
            results.push({ weight: w, ...r });
            log(`weights ${model} N=${agents} w=${w} seed=${seed}: ${r.landingsPerMin}/min, rework ${r.reworkPct}%`);
          }
        }
      }
    }
    writeFileSync(join(out, "sim-weights.json"), `${JSON.stringify({ kind: "sim-weights", label: "SIMULATED", generatedAt: new Date().toISOString(), workload: mk().describe(), cochange: { k, minWeight, table: "h200" }, results }, null, 2)}\n`);
  }

  if (steps.has("analysis")) {
    // Where the rest of the gap to locks comes from: direct overlap is only soft repulsion (the age
    // term and reinforced thresholds let agents take claimed files). ANALYSIS ONLY, not built:
    // a candidate whose footprint holds another agent's claim is excluded outright.
    const seeds = list(values.seeds, [1, 2, 3]);
    const nb = monorepoNeighbors(tables["h200"]!);
    const exclude: ExtraRepulsion = (t, claimOn) => {
      let n = 0;
      for (const w of t.writes) n += claimOn(w);
      return 1_000 * n;
    };
    const both = (w: number): ExtraRepulsion => {
      const cc = cochangeRepulsion(nb, w);
      return (t, claimOn) => exclude(t, claimOn) + cc(t, claimOn);
    };
    const rows: Array<{ name: string; model: SimParams["model"]; extra?: ExtraRepulsion }> = [
      { name: "firetrident", model: "firetrident" },
      { name: `firetrident+cochange(w${weight})`, model: "firetrident", extra: cochangeRepulsion(nb, weight) },
      { name: "direct overlap excluded", model: "firetrident", extra: exclude },
      { name: `direct overlap excluded+cochange(w${weight})`, model: "firetrident", extra: both(weight) },
      { name: "direct overlap excluded+cochange(w10)", model: "firetrident", extra: both(10) },
      { name: `group, direct overlap excluded+cochange(w${weight})`, model: "firetrident-group", extra: both(weight) },
    ];
    const results: Array<SimResult & { variant: string }> = [];
    for (const row of rows) {
      for (const seed of seeds) {
        const r = steady(row.model, 1_000, seed, row.extra);
        results.push({ variant: row.name, ...r });
        log(`analysis ${row.name} seed=${seed}: ${r.landingsPerMin}/min, rework ${r.reworkPct}%`);
      }
    }
    writeFileSync(join(out, "sim-analysis.json"), `${JSON.stringify({ kind: "sim-analysis", label: "SIMULATED (analysis of variants that are not built)", generatedAt: new Date().toISOString(), workload: mk().describe(), agents: 1_000, results }, null, 2)}\n`);
  }

  if (steps.has("report")) writeReport(out);
}

// ---------------------------------------------------------------------------
// Report: summary.json and a section for the chart page
// ---------------------------------------------------------------------------

type Row = SimResult & { variant?: string; weight?: number };

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

const mean = (xs: number[]): number | null => (xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};
const r1 = (x: number | null): number | null => (x === null ? null : Math.round(x * 10) / 10);

/** Mean of a metric per key over seeds. */
function byKey<T>(rows: T[], key: (r: T) => string, metrics: Record<string, (r: T) => number | null>): Map<string, Record<string, number | null> & { n: number }> {
  const groups = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const g = groups.get(k);
    if (g) g.push(r);
    else groups.set(k, [r]);
  }
  const out = new Map<string, Record<string, number | null> & { n: number }>();
  for (const [k, g] of groups) {
    const row: Record<string, number | null> & { n: number } = { n: g.length };
    for (const [name, f] of Object.entries(metrics)) row[name] = r1(mean(g.map(f).filter((x): x is number => x !== null && Number.isFinite(x))));
    out.set(k, row);
  }
  return out;
}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const cell = (x: number | null | undefined, digits = 1): string => (x === null || x === undefined ? "-" : Math.abs(x) >= 100 ? Math.round(x).toLocaleString("en-US") : x.toFixed(digits));

/** Two-sided Fisher exact p for took Y / took Z in the first two live arms, formatted. */
function fisher(arms: Array<{ tookY: number; tookZ: number }>): string {
  const [u, v] = arms;
  if (!u || !v) return "-";
  const lf = (n: number): number => {
    let s = 0;
    for (let i = 2; i <= n; i++) s += Math.log(i);
    return s;
  };
  const [a, b, c, d] = [u.tookY, u.tookZ, v.tookY, v.tookZ];
  const n = a + b + c + d;
  const pt = (x: number, y: number, z: number, w: number): number => Math.exp(lf(a + b) + lf(c + d) + lf(a + c) + lf(b + d) - lf(x) - lf(y) - lf(z) - lf(w) - lf(n));
  const p0 = pt(a, b, c, d);
  let p = 0;
  for (let x = Math.max(0, a + b + a + c - n); x <= Math.min(a + b, a + c); x++) {
    const q = pt(x, a + b - x, a + c - x, n - (a + b) - (a + c) + x);
    if (q <= p0 * (1 + 1e-9)) p += q;
  }
  return p.toExponential(1);
}

/** Write summary.json and section.html from the JSON files in `out`. */
export function writeReport(out: string): void {
  const link = readJson<{ rows: Array<LinkScores & { name: string }> }>(join(out, "linkpred.json"));
  const steady = readJson<{ results: Row[] }>(join(out, "sim-steady.json"));
  const ttz = readJson<{ tasks: number; results: TtzResult[] }>(join(out, "sim-ttz.json"));
  const weights = readJson<{ results: Row[] }>(join(out, "sim-weights.json"));
  const analysis = readJson<{ results: Row[] }>(join(out, "sim-analysis.json"));
  const live = readJson<{ arms: Array<{ arm: string; y: string; rounds: number; tookY: number; tookZ: number; other: string[]; createMs: number; takeMsB: { p50: number | null; p90: number | null } }> }>(join(out, "live-steer.json"));

  const steadyAgg = steady ? byKey(steady.results, (r) => `${r.agents}|${r.variant}`, { landingsPerMin: (r) => r.landingsPerMin, reworkPct: (r) => r.reworkPct, conflictsPer1000: (r) => r.conflictsPer1000, e2eP50S: (r) => r.e2eP50S }) : new Map();
  const weightAgg = weights ? byKey(weights.results, (r) => `${r.agents}|${r.model}|${r.weight}`, { landingsPerMin: (r) => r.landingsPerMin, reworkPct: (r) => r.reworkPct }) : new Map();
  const analysisAgg = analysis ? byKey(analysis.results, (r) => `${r.variant}`, { landingsPerMin: (r) => r.landingsPerMin, reworkPct: (r) => r.reworkPct }) : new Map();
  const ttzGroups = new Map<string, TtzResult[]>();
  for (const r of ttz?.results ?? []) {
    const k = `${r.agents}|${r.variant}`;
    ttzGroups.set(k, [...(ttzGroups.get(k) ?? []), r]);
  }
  const ttzAgg = new Map(
    [...ttzGroups].map(([k, g]) => {
      const vals = (f: (r: TtzResult) => number | null) => g.map(f).filter((x): x is number => x !== null);
      return [k, { n: g.length, t50: r1(mean(vals((r) => r.timeTo50S))), t90: r1(mean(vals((r) => r.timeTo90S))), t95: r1(mean(vals((r) => r.timeTo95S))), ttzMedian: r1(median(vals((r) => r.timeToZeroS))), ttzMean: r1(mean(vals((r) => r.timeToZeroS))), reworkPct: r1(mean(vals((r) => r.reworkPct))) }] as const;
    }),
  );
  const summary = {
    generatedAt: new Date().toISOString(),
    labels: { linkpred: "MEASURED (real hono history)", live: "MEASURED (preview deployment)", sim: "SIMULATED" },
    linkpred: link?.rows.map((r) => ({ name: r.name, precision: r.precision, recall: r.recall, coverage: r.queries > 0 ? r1((100 * r.covered) / r.queries) : null, popularity: r.popularity, upstream: r.upstream })) ?? null,
    steady: Object.fromEntries(steadyAgg),
    weights: Object.fromEntries(weightAgg),
    timeToZero: { tasks: ttz?.tasks ?? null, byVariant: Object.fromEntries(ttzAgg) },
    analysis: Object.fromEntries(analysisAgg),
    live: live?.arms ?? null,
  };
  writeFileSync(join(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);

  const variants: Array<[string, string]> = [
    ["baseline", "Baseline: locks + one merge queue"],
    ["firetrident", "FireTrident as built"],
    ["firetrident+cochange", "FireTrident + co-change"],
    ["firetrident-group", "FireTrident + group commit"],
    ["firetrident-group+cochange", "FireTrident + group commit + co-change"],
  ];
  const steadyRows = [100, 1_000, 10_000]
    .flatMap((n) =>
      variants.map(([v, label]) => {
        const r = steadyAgg.get(`${n}|${v}`);
        return r ? `<tr><td>${n.toLocaleString("en-US")}</td><td class="l">${esc(label)}</td><td>${cell(r.landingsPerMin)}</td><td>${cell(r.reworkPct)}</td><td>${cell(r.conflictsPer1000, 0)}</td><td>${cell(r.e2eP50S, 0)}</td></tr>` : "";
      }),
    )
    .join("");
  const ttzRows = [100, 1_000]
    .flatMap((n) =>
      variants.map(([v, label]) => {
        const r = ttzAgg.get(`${n}|${v}`);
        return r ? `<tr><td>${n.toLocaleString("en-US")}</td><td class="l">${esc(label)}</td><td>${cell(r.t50, 0)}</td><td>${cell(r.t90, 0)}</td><td>${cell(r.t95, 0)}</td><td>${cell(r.ttzMedian, 0)}</td><td>${cell(r.reworkPct)}</td></tr>` : "";
      }),
    )
    .join("");
  const weightRows = [1_000, 10_000]
    .flatMap((n) =>
      (["firetrident", "firetrident-group"] as const).map((m) => {
        const cells = [0, 1, 2, 3, 10].map((w) => {
          const r = weightAgg.get(`${n}|${m}|${w}`);
          return `<td>${r ? `${cell(r.reworkPct)}% @ ${cell(r.landingsPerMin, 0)}` : "-"}</td>`;
        });
        return `<tr><td>${n.toLocaleString("en-US")}</td><td class="l">${m === "firetrident" ? "as built" : "group commit"}</td>${cells.join("")}</tr>`;
      }),
    )
    .join("");
  const def = link?.rows[0];
  const noStdp = link?.rows.find((r) => r.name === "no STDP");
  const liveRows = (live?.arms ?? [])
    .map((a) => `<tr><td class="l">${esc(a.arm)}</td><td class="l"><code>${esc(a.y)}</code></td><td>${a.tookY}/${a.rounds}</td><td>${a.tookZ}/${a.rounds}</td><td>${a.other.length}</td><td>${cell(a.takeMsB.p50, 0)}</td></tr>`)
    .join("");
  const ana = (name: string) => analysisAgg.get(name);
  const html = `<!-- Co-change repulsion section for the chart page (generated by packages/bench/src/sim/cochange.ts --steps report) -->
<h2>Co-change repulsion: files that change together wire together<span class="tag s">SIMULATED</span><span class="tag m">MEASURED</span></h2>
<p>On hono's history FireTrident redid more work than locks. Part of it: agents took intents whose files are coupled to files other agents were changing, and read-set validation sent them back. TrunkDO now mines the trunk's history at import into a co-change map (Hebbian: a file's weight to a partner estimates P(partner changes | file changes) and decays only as that file changes again; STDP: an author's follow-up commit, or a follow-up intent, potentiates earlier-file → later-file edges). It learns every landing after that. <code>ColonyDO.take</code> adds 2 × coupling × claim for each claimed neighbor of a candidate's files, so a claim repels work on the files that change with it.</p>
${
  def
    ? `<div class="card table-wrap"><h3>Does the map predict co-change? MEASURED on hono's real history (train on 200 commits, predict the next 100, sliding)</h3>
<table><thead><tr><th class="l">predictor</th><th>precision@1</th><th>precision@3</th><th>recall@8</th><th>files with neighbors</th></tr></thead><tbody>
<tr><td class="l">co-change map (as deployed)</td><td>${cell(def.precision[1] ?? null, 2)}</td><td>${cell(def.precision[3] ?? null, 2)}</td><td>${cell(def.recall[8] ?? null, 2)}</td><td>${cell(def.queries > 0 ? (100 * def.covered) / def.queries : null, 0)}%</td></tr>
<tr><td class="l">most changed files</td><td>${cell(def.popularity.precision[1] ?? null, 2)}</td><td>${cell(def.popularity.precision[3] ?? null, 2)}</td><td>${cell(def.popularity.recall[8] ?? null, 2)}</td><td>-</td></tr>
</tbody></table>
<p>Direction: ranking the files of the author's previous commit (the upstream change), recall@8 is ${cell(def.upstream.recall[8] ?? null, 3)} with STDP and ${cell(noStdp?.upstream.recall[8] ?? null, 3)} without. In hono the follow-up signal is weak (squash-merged PRs from many authors), so STDP mostly orders downstream work after upstream work rather than adding coupling.</p></div>`
    : ""
}
<div class="card table-wrap"><h3>hono workload, 20 simulated minutes, mean of 3 seeds (SIMULATED)</h3>
<table><thead><tr><th>agents</th><th class="l">model</th><th>landed/min</th><th>rework %</th><th>conflicts/1k</th><th>claim to land p50 s</th></tr></thead><tbody>${steadyRows}</tbody></table></div>
<div class="card table-wrap"><h3>Co-change weight: rework % @ landed/min, mean of 3 seeds (SIMULATED; 0 = off, 2 = deployed)</h3>
<table><thead><tr><th>agents</th><th class="l">model</th><th>0</th><th>1</th><th>2</th><th>3</th><th>10</th></tr></thead><tbody>${weightRows}</tbody></table></div>
<div class="card table-wrap"><h3>Draining ${ttz?.tasks ?? "-"} tasks to zero, seconds, mean of 10 seeds (median for the last task) (SIMULATED)</h3>
<table><thead><tr><th>agents</th><th class="l">model</th><th>50% landed</th><th>90%</th><th>95%</th><th>all (median)</th><th>rework %</th></tr></thead><tbody>${ttzRows}</tbody></table></div>
${
  liveRows
    ? `<div class="card table-wrap"><h3>Live steering on a preview deployment (MEASURED: real import of hono, real mining, real takes)</h3>
<p>Each round a fresh agent claims <code>src/jsx/components.ts</code> (priority 5), then a fresh agent chooses between Y (priority 2.5) and <code>src/utils/body.ts</code> (priority 2). In the coupled colony Y co-changes with the claimed file in hono's last 200 commits; in the control colony it never did.</p>
<table><thead><tr><th class="l">colony</th><th class="l">Y</th><th>took Y</th><th>took Z</th><th>other</th><th>take p50 ms</th></tr></thead><tbody>${liveRows}</tbody></table>
<p>Two-sided Fisher exact test on took Y / took Z, coupled vs control: p = ${fisher(live?.arms ?? [])}. "Other" rounds are B declining both (the response-threshold rule) or A not taking X first.</p></div>`
    : ""
}
<ul>
<li><b>Rework falls, throughput holds on per-lane landing.</b> At 1,000 agents rework drops from ${cell(steadyAgg.get("1000|firetrident")?.reworkPct)}% to ${cell(steadyAgg.get("1000|firetrident+cochange")?.reworkPct)}% at the same ${cell(steadyAgg.get("1000|firetrident+cochange")?.landingsPerMin)} landings/min; at 100 agents from ${cell(steadyAgg.get("100|firetrident")?.reworkPct)}% to ${cell(steadyAgg.get("100|firetrident+cochange")?.reworkPct)}% with slightly more landings. Locks stay at ${cell(steadyAgg.get("1000|baseline")?.reworkPct)}%.</li>
<li><b>With group commit it is a trade.</b> Rework ${cell(steadyAgg.get("1000|firetrident-group")?.reworkPct)}% → ${cell(steadyAgg.get("1000|firetrident-group+cochange")?.reworkPct)}%, landings ${cell(steadyAgg.get("1000|firetrident-group")?.landingsPerMin, 0)} → ${cell(steadyAgg.get("1000|firetrident-group+cochange")?.landingsPerMin, 0)}/min at 1,000 agents, and draining a fixed backlog slows a little: repelled intents sit in the 200-oldest candidate window until their neighbors land. FT_COCHANGE_WEIGHT tunes it (0 turns it off).</li>
<li><b>What is left of the gap to locks</b> (SIMULATED analysis, not built): direct overlap is only soft repulsion, so the age term and reinforced thresholds let agents take claimed files anyway. Treating a direct overlap as exclusion takes rework to ${cell(ana("direct overlap excluded")?.reworkPct ?? null)}%, and adding co-change to ${cell(ana("direct overlap excluded+cochange(w2)")?.reworkPct ?? null)}% (weight 2) or ${cell(ana("direct overlap excluded+cochange(w10)")?.reworkPct ?? null)}% (weight 10), at ${cell(ana("direct overlap excluded+cochange(w10)")?.landingsPerMin ?? null, 0)} landings/min, against locks' ${cell(steadyAgg.get("1000|baseline")?.reworkPct)}% at ${cell(steadyAgg.get("1000|baseline")?.landingsPerMin, 0)}.</li>
<li><b>Method.</b> The simulator's take adds the same core <code>neighborRepulsion</code> ColonyDO uses, with neighbors mined from hono's last 200 first-parent commits (TrunkDO's import depth), top 8 per file, coupling ≥ 0.1. Tasks are drawn from the co-change graph of hono's whole history, while the colony's map knows only the last 200 commits, as a fresh import does. The simulated colony does not learn from its own landings (the deployed TrunkDO does).</li>
</ul>
`;
  writeFileSync(join(out, "section.html"), html);
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
