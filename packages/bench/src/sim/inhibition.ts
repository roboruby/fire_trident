#!/usr/bin/env node
/**
 * Lateral inhibition in the simulator: ColonyDO.take now skips an open intent whose own files
 * another agent holds a live claim on (core chooseIntent with LATERAL_INHIBITION, half a fresh
 * claim), where before such a claim only lowered the intent's stimulus. Co-change repulsion stays
 * soft. This measures it on the hono workload of the 2026-10-12 benchmark against locks.
 *
 *   node packages/bench/src/sim/inhibition.ts --out packages/bench/results/2026-10-12-inhibition
 *
 * Steps (--steps, default all):
 *  - sim: steady state, 20 simulated minutes (5 of warm-up), N = 100, 1,000, 10,000, seeds 1..3.
 *  - ttz: time to drain a fixed set of tasks (all open at t = 0) until the last one lands.
 *  - weights: co-change weight under lateral inhibition at 1,000 agents.
 *  - window: ANALYSIS of the candidate window (open intents a take considers) at 1,000 agents.
 *  - silent: COMPUTED with core's own functions, no simulation: how long a silent agent's claims on
 *    n of an intent's files keep it inhibited, summed (before) and by the strongest file (after).
 *  - agecap: the stimulus's age-multiplier cap (core AGE_FACTOR_CAP) swept at 1,000 agents in steady
 *    state and at 100 and 1,000 agents draining a fixed set, with co-change at the deployed weight (5)
 *    and with import repulsion added: rework, conflicts, and how long tasks wait before a first claim.
 *  - report: summary.json and section.html from the JSON files in --out; summary: summary.json only.
 *
 * The 2026-10-18 review fixes are the variants named "+max" (lateral inhibition reads the strongest
 * single file's claim, core directClaimOn) and "+fix" (that, and the capped age multiplier).
 *
 * Co-change repulsion is applied as deployed (weight 2, top 8 neighbors with coupling >= 0.1 mined
 * from hono's last 200 first-parent commits): the table comes from the co-change run's
 * neighbors.json, so no checkout of hono is needed. "firetrident-group" is the PROPOSED trunk
 * writer that folds every waiting batch into one commit (group commit).
 */
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { AGE_FACTOR_CAP, LATERAL_INHIBITION, TAU_MS, directClaimOn, inhibited, markValue } from "@fire_trident/core";
import type { ClaimCombine, FieldReading, Neighbor } from "@fire_trident/core";
import type { WorkloadModel } from "../workload.ts";
import { BaselineSim } from "./baseline.ts";
import { cochangeRepulsion, monorepoNeighbors, runToZero, type TtzResult } from "./cochange.ts";
import type { SimParams, SimResult, Timings } from "./common.ts";
import { FireSim, type ExtraRepulsion, type FireOptions } from "./fire.ts";
import { importRepulsion, importTable, monorepoImports, sumRepulsion } from "./imports.ts";
import { params as simParams, type Calibration } from "./sweep.ts";
import { HistoryWorkload, type TaskSource } from "./workloads.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

/** One simulated configuration. */
export interface Variant {
  name: string;
  label: string;
  model: SimParams["model"];
  /** Co-change repulsion weight (absent = off). */
  cochange?: number;
  /** Lateral inhibition on (at LATERAL_INHIBITION). */
  inhibit?: boolean;
  /** How lateral inhibition combines per-file claims (absent = "sum", as before 2026-10-18). */
  inhibitBy?: ClaimCombine;
  /** Cap on the stimulus's age multiplier (absent = uncapped, as before 2026-10-18). */
  ageCap?: number;
  /** Import-aware repulsion weight (absent or 0 = off; FT_IMPORT_WEIGHT is off as deployed). */
  imports?: number;
}

/** Every variant; "before" = as deployed before lateral inhibition, "after" = as deployed now. */
export const VARIANTS: Variant[] = [
  { name: "baseline", label: "Locks + one merge queue", model: "baseline" },
  { name: "ft", label: "FireTrident, claims repel softly only", model: "firetrident" },
  { name: "ft+inh", label: "FireTrident + lateral inhibition", model: "firetrident", inhibit: true },
  { name: "ft+cc", label: "FireTrident + co-change (before)", model: "firetrident", cochange: 2 },
  { name: "ft+cc+inh", label: "FireTrident + co-change + lateral inhibition (after)", model: "firetrident", cochange: 2, inhibit: true },
  { name: "group", label: "Group commit, claims repel softly only", model: "firetrident-group" },
  { name: "group+inh", label: "Group commit + lateral inhibition", model: "firetrident-group", inhibit: true },
  { name: "group+cc", label: "Group commit + co-change (before)", model: "firetrident-group", cochange: 2 },
  { name: "group+cc+inh", label: "Group commit + co-change + lateral inhibition (after)", model: "firetrident-group", cochange: 2, inhibit: true },
  // The 2026-10-18 review fixes: "+max" reads the strongest single file's claim, "+fix" also caps the age multiplier.
  { name: "ft+cc+inh+max", label: "FireTrident + co-change + inhibition by the strongest file", model: "firetrident", cochange: 2, inhibit: true, inhibitBy: "strongest" },
  { name: "ft+cc+inh+fix", label: "FireTrident + co-change + inhibition by the strongest file + age cap", model: "firetrident", cochange: 2, inhibit: true, inhibitBy: "strongest", ageCap: AGE_FACTOR_CAP },
  { name: "group+cc+inh+max", label: "Group commit + co-change + inhibition by the strongest file", model: "firetrident-group", cochange: 2, inhibit: true, inhibitBy: "strongest" },
  { name: "group+cc+inh+fix", label: "Group commit + co-change + inhibition by the strongest file + age cap", model: "firetrident-group", cochange: 2, inhibit: true, inhibitBy: "strongest", ageCap: AGE_FACTOR_CAP },
  // Co-change at the deployed weight (FT_COCHANGE_WEIGHT=5).
  { name: "ft+cc5+inh", label: "FireTrident + co-change 5 + lateral inhibition (deployed before the fixes)", model: "firetrident", cochange: 5, inhibit: true },
  { name: "ft+cc5+inh+fix", label: "FireTrident + co-change 5 + the review fixes", model: "firetrident", cochange: 5, inhibit: true, inhibitBy: "strongest", ageCap: AGE_FACTOR_CAP },
  { name: "group+cc5+inh", label: "Group commit + co-change 5 + lateral inhibition (deployed before the fixes)", model: "firetrident-group", cochange: 5, inhibit: true },
  { name: "group+cc5+inh+fix", label: "Group commit + co-change 5 + the review fixes", model: "firetrident-group", cochange: 5, inhibit: true, inhibitBy: "strongest", ageCap: AGE_FACTOR_CAP },
];

/** Variants the age-cap sweep runs: co-change at the deployed weight, alone and with import repulsion at weight 1. */
export const AGECAP_VARIANTS: Variant[] = [
  { name: "ft+cc5+inh+max", label: "FireTrident + co-change 5 + inhibition by the strongest file", model: "firetrident", cochange: 5, inhibit: true, inhibitBy: "strongest" },
  { name: "group+cc5+inh+max", label: "Group commit + co-change 5 + inhibition by the strongest file", model: "firetrident-group", cochange: 5, inhibit: true, inhibitBy: "strongest" },
  { name: "group+cc5+imp1+inh+max", label: "Group commit + co-change 5 + imports 1 + inhibition by the strongest file", model: "firetrident-group", cochange: 5, imports: 1, inhibit: true, inhibitBy: "strongest" },
];
/** Caps the sweep tries (Infinity = uncapped, as before). */
export const AGE_CAPS = [Number.POSITIVE_INFINITY, 2, 3, 4, 6, 8];

/**
 * How long a silent agent's claims (no heartbeats, so each decays from 1 with TAU_MS.claim) keep an
 * intent that writes `files` of the same files inhibited, in milliseconds, with the claims combined as
 * `combine` and checked with core inhibited at LATERAL_INHIBITION, stepping 1 s. `agents` silent agents
 * holding the same files multiply the claim on each.
 */
export function silentHoldMs(files: number, combine: ClaimCombine, agents = 1, stepMs = 1_000): number {
  const paths = Array.from({ length: files }, (_, i) => `src/f${i}.ts`);
  const mark = { id: "m", kind: "claim" as const, path: "", strength: 1, at: 0 };
  for (let t = 0; t <= 24 * 3_600_000; t += stepMs) {
    const v = agents * markValue(mark, t);
    const byPath: FieldReading["byPath"] = Object.fromEntries(paths.map((p) => [p, { claim: v }]));
    if (!inhibited({ directClaim: directClaimOn(byPath, paths, combine) }, LATERAL_INHIBITION)) return t;
  }
  return Number.POSITIVE_INFINITY;
}

/** A run's result plus the share of the candidate window lateral inhibition held back. */
export type Row = SimResult & { variant: string; weight?: number; window?: number; inhibitedWindowPct: number | null };

type Build = (v: Variant, p: SimParams, source: TaskSource, weight?: number, window?: number, ageCap?: number) => FireSim | BaselineSim;

function inhibitedPct(sim: FireSim | BaselineSim): number | null {
  const m = sim.m;
  return m.windowAdmitted > 0 ? Math.round((1000 * m.windowInhibited) / m.windowAdmitted) / 10 : null;
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
      variants: { type: "string" },
      duration: { type: "string" },
      warmup: { type: "string" },
      "ttz-agents": { type: "string" },
      "ttz-tasks": { type: "string" },
      "ttz-seeds": { type: "string" },
      "ttz-variants": { type: "string" },
      caps: { type: "string" },
      neighbors: { type: "string" },
      model: { type: "string" },
      calibration: { type: "string" },
    },
    strict: true,
  });
  const out = values.out ?? join(HERE, "..", "..", "results", "2026-10-12-inhibition");
  const steps = new Set((values.steps ?? "sim,ttz,weights,window,report").split(",").map((s) => s.trim()));
  const log = (s: string) => console.error(`[${new Date().toISOString().slice(11, 19)}] ${s}`);
  mkdirSync(out, { recursive: true });
  if (steps.size === 1 && (steps.has("report") || steps.has("summary"))) {
    writeReport(out, steps.has("report"));
    return;
  }

  const nbFile = values.neighbors ?? join(HERE, "..", "..", "results", "2026-10-12-cochange", "neighbors.json");
  const nbDoc = JSON.parse(readFileSync(nbFile, "utf8")) as { k: number; minWeight: number; head: string; tables: Record<string, Record<string, Neighbor[]>> };
  const neighbors = monorepoNeighbors(nbDoc.tables["h200"]!);
  const model = JSON.parse(readFileSync(values.model ?? join(HERE, "..", "..", "data", "hono-workload.json"), "utf8")) as WorkloadModel;
  const cal = JSON.parse(readFileSync(values.calibration ?? join(HERE, "..", "..", "data", "calibration.json"), "utf8")) as Calibration;
  const timings: Timings = { ...cal.inPlatform, testMs: 0 };
  const work = { medianMs: 60_000, sigma: 0.8 };
  const mk = (): TaskSource => new HistoryWorkload(model, { packages: 100, regionDepth: 3, maxReads: 8, work });
  const imports = monorepoImports(importTable(model));
  const build: Build = (v, p, source, weight, window, ageCap) => {
    if (v.model === "baseline") return new BaselineSim(p, source, () => "v0");
    const w = weight ?? v.cochange ?? 0;
    const cap = ageCap ?? v.ageCap;
    const opts: FireOptions = {
      ...(v.inhibit ? { inhibitAt: LATERAL_INHIBITION } : {}),
      ...(window !== undefined ? { window } : {}),
      ...(v.inhibitBy ? { inhibitBy: v.inhibitBy } : {}),
      ...(cap !== undefined && cap !== Number.POSITIVE_INFINITY ? { ageCap: cap } : {}),
    };
    const parts: ExtraRepulsion[] = [];
    if (w > 0) parts.push(cochangeRepulsion(neighbors, w));
    if (v.imports) parts.push(importRepulsion(imports, v.imports));
    return new FireSim(p, source, () => "v0", parts.length > 1 ? sumRepulsion(...parts) : parts[0], opts);
  };
  const pick = (names: string | undefined, fallback: Variant[]): Variant[] => {
    if (!names) return fallback;
    const wanted = new Set(names.split(",").map((s) => s.trim()));
    return [...VARIANTS, ...AGECAP_VARIANTS].filter((v) => wanted.has(v.name));
  };
  const meta = {
    workload: mk().describe(),
    cochange: { weight: 2, k: nbDoc.k, minWeight: nbDoc.minWeight, table: "h200 (hono's last 200 first-parent commits, TrunkDO's import depth)", source: "results/2026-10-12-cochange/neighbors.json" },
    inhibition: { inhibitAt: LATERAL_INHIBITION, note: "a candidate with >= 0.5 of a fresh claim from other agents on its own files is skipped; every live claim is fresh (1) in the model" },
    ageFactorCap: AGE_FACTOR_CAP,
    imports: { weight: 1, table: "direct relative imports and importers of hono's files (the workload model), inside each package copy", source: "data/hono-workload.json" },
  };

  if (steps.has("sim")) {
    const agentsList = list(values.agents, [100, 1_000, 10_000]);
    const seeds = list(values.seeds, [1, 2, 3]);
    const variants = pick(values.variants, VARIANTS);
    const durationMs = Number(values.duration ?? 1_200) * 1000;
    const warmupMs = Number(values.warmup ?? 300) * 1000;
    const results: Row[] = [];
    for (const agents of agentsList) {
      for (const v of variants) {
        for (const seed of seeds) {
          const p = simParams(v.model, agents, { durationMs, warmupMs, seed, timings, backlog: 1_000, rampMs: Math.min(60_000, agents * 5) });
          const sim = build(v, p, mk());
          const r = sim.run();
          results.push({ variant: v.name, ...r, inhibitedWindowPct: inhibitedPct(sim) });
          log(`${v.name} N=${agents} seed=${seed}: ${r.landingsPerMin}/min, rework ${r.reworkPct}%, conflicts ${r.conflictsPer1000}/1000 (ww ${r.writeWritePer1000}), e2e p50 ${r.e2eP50S}s, inhibited ${inhibitedPct(sim) ?? "-"}% of window, ${r.wallMs} ms`);
        }
      }
    }
    writeFileSync(join(out, "sim-steady.json"), `${JSON.stringify({ kind: "sim", label: "SIMULATED", generatedAt: new Date().toISOString(), ...meta, durationMs, warmupMs, variants: VARIANTS, results }, null, 2)}\n`);
  }

  if (steps.has("ttz")) {
    const agentsList = list(values["ttz-agents"], [100, 1_000, 10_000]);
    const seeds = list(values["ttz-seeds"], [1, 2, 3, 4, 5]);
    const tasks = Number(values["ttz-tasks"] ?? 1_500);
    const variants = pick(
      values["ttz-variants"],
      VARIANTS.filter((v) => ["baseline", "ft+cc", "ft+cc+inh", "group+cc", "group+cc+inh", "ft+cc+inh+max", "ft+cc+inh+fix", "group+cc+inh+max", "group+cc+inh+fix", "ft+cc5+inh", "ft+cc5+inh+fix", "group+cc5+inh", "group+cc5+inh+fix"].includes(v.name)),
    );
    const results: TtzResult[] = [];
    for (const agents of agentsList) {
      for (const v of variants) {
        for (const seed of seeds) {
          const p = simParams(v.model, agents, { durationMs: 4 * 3_600_000, warmupMs: 0, seed, timings, backlog: tasks, rampMs: Math.min(60_000, agents * 5) });
          const r = runToZero(v.name, build(v, p, mk()), tasks, p.durationMs);
          results.push(r);
          log(`ttz ${v.name} N=${agents} seed=${seed}: ${r.timeToZeroS ?? "not done"} s (50% ${r.timeTo50S} s, 90% ${r.timeTo90S} s), rework ${r.reworkPct}%, conflicts ${r.conflictsPer1000}/1000`);
        }
      }
    }
    writeFileSync(join(out, "sim-ttz.json"), `${JSON.stringify({ kind: "sim-ttz", label: "SIMULATED", generatedAt: new Date().toISOString(), ...meta, tasks, results }, null, 2)}\n`);
  }

  if (steps.has("weights")) {
    // Co-change weight with lateral inhibition on (0 = co-change off, 2 = deployed).
    const seeds = list(values.seeds, [1, 2, 3]);
    const results: Row[] = [];
    for (const v of VARIANTS.filter((x) => x.name === "ft+cc+inh" || x.name === "group+cc+inh")) {
      for (const w of [0, 2, 5, 10]) {
        for (const seed of seeds) {
          const p = simParams(v.model, 1_000, { durationMs: 1_200_000, warmupMs: 300_000, seed, timings, backlog: 1_000, rampMs: 5_000 });
          const sim = build(v, p, mk(), w);
          const r = sim.run();
          results.push({ variant: v.name, weight: w, ...r, inhibitedWindowPct: inhibitedPct(sim) });
          log(`weights ${v.name} w=${w} seed=${seed}: ${r.landingsPerMin}/min, rework ${r.reworkPct}%`);
        }
      }
    }
    writeFileSync(join(out, "sim-weights.json"), `${JSON.stringify({ kind: "sim-weights", label: "SIMULATED", generatedAt: new Date().toISOString(), ...meta, agents: 1_000, results }, null, 2)}\n`);
  }

  if (steps.has("window")) {
    // ANALYSIS (ColonyDO's window is 200, not changed): how many open intents a take considers,
    // oldest first. Inhibited intents stay at the head of the window until their files' claims clear.
    const seeds = list(values.seeds, [1, 2, 3]);
    const results: Row[] = [];
    for (const v of VARIANTS.filter((x) => ["ft+cc", "ft+cc+inh", "group+cc", "group+cc+inh"].includes(x.name))) {
      for (const window of [200, 400, 1_000]) {
        for (const seed of seeds) {
          const p = simParams(v.model, 1_000, { durationMs: 1_200_000, warmupMs: 300_000, seed, timings, backlog: 1_000, rampMs: 5_000 });
          const sim = build(v, p, mk(), undefined, window);
          const r = sim.run();
          results.push({ variant: v.name, window, ...r, inhibitedWindowPct: inhibitedPct(sim) });
          log(`window ${v.name} w=${window} seed=${seed}: ${r.landingsPerMin}/min, rework ${r.reworkPct}%, inhibited ${inhibitedPct(sim) ?? "-"}%`);
        }
      }
    }
    writeFileSync(join(out, "sim-window.json"), `${JSON.stringify({ kind: "sim-window", label: "SIMULATED (analysis: the candidate window is not changed in ColonyDO)", generatedAt: new Date().toISOString(), ...meta, agents: 1_000, backlog: 1_000, results }, null, 2)}\n`);
  }

  if (steps.has("silent")) {
    // COMPUTED, not simulated: core markValue, directClaimOn and inhibited, the functions ColonyDO.take uses.
    const files = [1, 2, 3, 5, 10, 20, 50];
    const rows = files.map((n) => ({
      files: n,
      sumMin: r2(silentHoldMs(n, "sum") / 60_000),
      strongestMin: r2(silentHoldMs(n, "strongest") / 60_000),
      formulaSumMin: r2(((TAU_MS.claim ?? 0) * Math.log(n / LATERAL_INHIBITION)) / 60_000),
    }));
    const twoAgents = { files: 1, agents: 2, sumMin: r2(silentHoldMs(1, "sum", 2) / 60_000), strongestMin: r2(silentHoldMs(1, "strongest", 2) / 60_000) };
    writeFileSync(
      join(out, "silent.json"),
      `${JSON.stringify({ kind: "silent", label: "COMPUTED (core functions, 1 s steps; no simulation)", generatedAt: new Date().toISOString(), tauMs: TAU_MS.claim, inhibitAt: LATERAL_INHIBITION, rows, twoAgentsOneFile: twoAgents }, null, 2)}\n`,
    );
    log(`silent: ${rows.map((r) => `${r.files} files ${r.sumMin} -> ${r.strongestMin} min`).join("; ")}`);
  }

  if (steps.has("agecap")) {
    const caps = values.caps ? values.caps.split(",").map((x) => (x.trim() === "inf" ? Number.POSITIVE_INFINITY : Number(x.trim()))).filter((x) => x >= 1) : AGE_CAPS;
    const seeds = list(values.seeds, [1, 2, 3]);
    const ttzSeeds = list(values["ttz-seeds"], [1, 2, 3, 4, 5]);
    const tasks = Number(values["ttz-tasks"] ?? 1_500);
    const variants = pick(values.variants, AGECAP_VARIANTS);
    const steady: Array<Row & { ageCap: number | null }> = [];
    const drain: Array<TtzResult & { ageCap: number | null }> = [];
    const capOf = (c: number): number | null => (c === Number.POSITIVE_INFINITY ? null : c);
    for (const v of variants) {
      for (const cap of caps) {
        for (const seed of seeds) {
          const p = simParams(v.model, 1_000, { durationMs: 1_200_000, warmupMs: 300_000, seed, timings, backlog: 1_000, rampMs: 5_000 });
          const sim = build(v, p, mk(), undefined, undefined, cap);
          const r = sim.run();
          steady.push({ variant: v.name, ageCap: capOf(cap), ...r, inhibitedWindowPct: inhibitedPct(sim) });
          log(`agecap ${v.name} cap=${cap} seed=${seed}: ${r.landingsPerMin}/min, rework ${r.reworkPct}%, conflicts ${r.conflictsPer1000}/1000, wait p99 ${r.waitP99S} s max ${r.waitMaxS} s`);
        }
        for (const agents of [100, 1_000]) {
          for (const seed of ttzSeeds) {
            const p = simParams(v.model, agents, { durationMs: 4 * 3_600_000, warmupMs: 0, seed, timings, backlog: tasks, rampMs: Math.min(60_000, agents * 5) });
            const r = runToZero(v.name, build(v, p, mk(), undefined, undefined, cap), tasks, p.durationMs);
            drain.push({ ...r, ageCap: capOf(cap) });
            log(`agecap ttz ${v.name} cap=${cap} N=${agents} seed=${seed}: ${r.timeToZeroS ?? "not done"} s, rework ${r.reworkPct}%, wait p99 ${r.waitP99S} s max ${r.waitMaxS} s`);
          }
        }
      }
    }
    writeFileSync(
      join(out, "sim-agecap.json"),
      `${JSON.stringify({ kind: "sim-agecap", label: "SIMULATED", generatedAt: new Date().toISOString(), ...meta, caps: caps.map(capOf), tasks, variants, steady, drain }, null, 2)}\n`,
    );
  }

  if (steps.has("report") || steps.has("summary")) writeReport(out, steps.has("report"));
}

const r2 = (x: number): number => Math.round(x * 100) / 100;

// ---------------------------------------------------------------------------
// Report: summary.json and a section for the chart page
// ---------------------------------------------------------------------------

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

/** Mean, min and max of a metric over seeds. */
interface Stat {
  mean: number | null;
  min: number | null;
  max: number | null;
}

function stat(xs: Array<number | null>): Stat {
  const v = xs.filter((x): x is number => x !== null && Number.isFinite(x));
  return { mean: r1(mean(v)), min: v.length ? r1(Math.min(...v)) : null, max: v.length ? r1(Math.max(...v)) : null };
}

/** Per (agents, variant[, weight]) aggregates over seeds. */
function aggregate(rows: Row[], key: (r: Row) => string) {
  const groups = new Map<string, Row[]>();
  for (const r of rows) groups.set(key(r), [...(groups.get(key(r)) ?? []), r]);
  return new Map(
    [...groups].map(([k, g]) => [
      k,
      {
        n: g.length,
        landingsPerMin: stat(g.map((r) => r.landingsPerMin)),
        reworkPct: stat(g.map((r) => r.reworkPct)),
        conflictsPer1000: stat(g.map((r) => r.conflictsPer1000)),
        writeWritePer1000: stat(g.map((r) => r.writeWritePer1000)),
        e2eP50S: stat(g.map((r) => r.e2eP50S)),
        e2eP99S: stat(g.map((r) => r.e2eP99S)),
        waitP99S: stat(g.map((r) => r.waitP99S ?? null)),
        waitMaxS: stat(g.map((r) => r.waitMaxS ?? null)),
        inhibitedWindowPct: stat(g.map((r) => r.inhibitedWindowPct)),
      },
    ]),
  );
}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const cell = (x: number | null | undefined, digits = 1): string => (x === null || x === undefined ? "-" : Math.abs(x) >= 100 ? Math.round(x).toLocaleString("en-US") : x.toFixed(digits));
const pct = (after: number | null | undefined, before: number | null | undefined): string =>
  after === null || after === undefined || before === null || before === undefined || before === 0 ? "-" : `${after >= before ? "+" : ""}${(((after - before) / before) * 100).toFixed(1)}%`;

/** Write summary.json (and section.html, with `section`) from the JSON files in `out`. */
export function writeReport(out: string, section = true): void {
  const steady = readJson<{ results: Row[] }>(join(out, "sim-steady.json"));
  const silent = readJson<Record<string, unknown>>(join(out, "silent.json"));
  const agecap = readJson<{ tasks: number; steady: Array<Row & { ageCap: number | null }>; drain: Array<TtzResult & { ageCap: number | null }> }>(join(out, "sim-agecap.json"));
  const ttz = readJson<{ tasks: number; results: TtzResult[] }>(join(out, "sim-ttz.json"));
  const weights = readJson<{ results: Row[] }>(join(out, "sim-weights.json"));
  const windows = readJson<{ results: Row[] }>(join(out, "sim-window.json"));
  const live = readJson<Record<string, unknown>>(join(out, "live-inhibition.json"));

  const steadyAgg = aggregate(steady?.results ?? [], (r) => `${r.agents}|${r.variant}`);
  const weightAgg = aggregate(weights?.results ?? [], (r) => `${r.variant}|${r.weight}`);
  const windowAgg = aggregate(windows?.results ?? [], (r) => `${r.variant}|${r.window}`);
  const ttzGroups = new Map<string, TtzResult[]>();
  for (const r of ttz?.results ?? []) ttzGroups.set(`${r.agents}|${r.variant}`, [...(ttzGroups.get(`${r.agents}|${r.variant}`) ?? []), r]);
  const ttzAgg = new Map(
    [...ttzGroups].map(([k, g]) => {
      const vals = (f: (r: TtzResult) => number | null) => g.map(f).filter((x): x is number => x !== null);
      return [
        k,
        {
          n: g.length,
          drained: g.filter((r) => r.timeToZeroS !== null).length,
          t50: r1(mean(vals((r) => r.timeTo50S))),
          t90: r1(mean(vals((r) => r.timeTo90S))),
          t95: r1(mean(vals((r) => r.timeTo95S))),
          ttzMedian: r1(median(vals((r) => r.timeToZeroS))),
          ttzMean: r1(mean(vals((r) => r.timeToZeroS))),
          reworkPct: r1(mean(vals((r) => r.reworkPct))),
          conflictsPer1000: r1(mean(vals((r) => r.conflictsPer1000))),
          waitP99S: r1(mean(vals((r) => r.waitP99S ?? null))),
          waitMaxS: r1(mean(vals((r) => r.waitMaxS ?? null))),
        },
      ] as const;
    }),
  );
  // The age-cap sweep, by variant and cap ("none" = uncapped): steady state at 1,000 agents, and draining by agents.
  const capName = (c: number | null): string => (c === null ? "none" : String(c));
  const capSteady = aggregate(agecap?.steady ?? [], (r) => `${r.variant}|${capName((r as Row & { ageCap: number | null }).ageCap)}`);
  const capDrainGroups = new Map<string, TtzResult[]>();
  for (const r of agecap?.drain ?? []) {
    const k = `${r.agents}|${r.variant}|${capName(r.ageCap)}`;
    capDrainGroups.set(k, [...(capDrainGroups.get(k) ?? []), r]);
  }
  const capDrain = Object.fromEntries(
    [...capDrainGroups].map(([k, g]) => {
      const vals = (f: (r: TtzResult) => number | null | undefined) => g.map(f).filter((x): x is number => typeof x === "number");
      return [
        k,
        {
          n: g.length,
          drained: g.filter((r) => r.timeToZeroS !== null).length,
          t50: r1(mean(vals((r) => r.timeTo50S))),
          t95: r1(mean(vals((r) => r.timeTo95S))),
          ttzMedian: r1(median(vals((r) => r.timeToZeroS))),
          ttzMax: r1(Math.max(...vals((r) => r.timeToZeroS))),
          reworkPct: r1(mean(vals((r) => r.reworkPct))),
          conflictsPer1000: r1(mean(vals((r) => r.conflictsPer1000))),
          waitP99S: r1(mean(vals((r) => r.waitP99S))),
          waitMaxS: r1(Math.max(...vals((r) => r.waitMaxS))),
        },
      ];
    }),
  );
  const summary = {
    generatedAt: new Date().toISOString(),
    labels: { sim: "SIMULATED", live: "MEASURED (preview deployment)", silent: "COMPUTED (core functions)" },
    variants: Object.fromEntries([...VARIANTS, ...AGECAP_VARIANTS].map((v) => [v.name, v.label])),
    steady: Object.fromEntries(steadyAgg),
    timeToZero: { tasks: ttz?.tasks ?? null, byVariant: Object.fromEntries(ttzAgg) },
    weights: Object.fromEntries(weightAgg),
    window: Object.fromEntries(windowAgg),
    ...(silent ? { silent } : {}),
    ...(agecap ? { ageCap: { tasks: agecap.tasks, steady1000: Object.fromEntries(capSteady), drain: capDrain } } : {}),
    live,
  };
  writeFileSync(join(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  if (!section) return;

  const S = (n: number, v: string) => steadyAgg.get(`${n}|${v}`);
  const T = (n: number, v: string) => ttzAgg.get(`${n}|${v}`);
  const shown = ["baseline", "ft+cc", "ft+cc+inh", "group+cc", "group+cc+inh", "ft", "ft+inh", "group", "group+inh"];
  const label = (v: string) => VARIANTS.find((x) => x.name === v)?.label ?? v;
  const steadyRows = [100, 1_000, 10_000]
    .flatMap((n) =>
      shown.map((v) => {
        const r = S(n, v);
        return r
          ? `<tr><td>${n.toLocaleString("en-US")}</td><td class="l">${esc(label(v))}</td><td>${cell(r.landingsPerMin.mean)}</td><td>${cell(r.reworkPct.mean)} <small>(${cell(r.reworkPct.min)}-${cell(r.reworkPct.max)})</small></td><td>${cell(r.conflictsPer1000.mean, 0)}</td><td>${cell(r.e2eP50S.mean, 0)}</td><td>${cell(r.inhibitedWindowPct.mean, 0)}</td></tr>`
          : "";
      }),
    )
    .join("");
  const ttzRows = [100, 1_000, 10_000]
    .flatMap((n) =>
      shown.map((v) => {
        const r = T(n, v);
        return r ? `<tr><td>${n.toLocaleString("en-US")}</td><td class="l">${esc(label(v))}</td><td>${cell(r.t50, 0)}</td><td>${cell(r.t90, 0)}</td><td>${cell(r.t95, 0)}</td><td>${cell(r.ttzMedian, 0)}</td><td>${cell(r.reworkPct)}</td></tr>` : "";
      }),
    )
    .join("");
  const weightRows = ["ft+cc+inh", "group+cc+inh"]
    .map((v) => {
      const cells = [0, 2, 5, 10].map((w) => {
        const r = weightAgg.get(`${v}|${w}`);
        return `<td>${r ? `${cell(r.reworkPct.mean)}% @ ${cell(r.landingsPerMin.mean, 0)}` : "-"}</td>`;
      });
      return `<tr><td class="l">${v.startsWith("group") ? "group commit" : "per-lane landing"}</td>${cells.join("")}</tr>`;
    })
    .join("");
  const windowRows = ["ft+cc", "ft+cc+inh", "group+cc", "group+cc+inh"]
    .map((v) => {
      const cells = [200, 400, 1_000].map((w) => {
        const r = windowAgg.get(`${v}|${w}`);
        return `<td>${r ? `${cell(r.reworkPct.mean)}% @ ${cell(r.landingsPerMin.mean, 0)}` : "-"}</td>`;
      });
      return `<tr><td class="l">${esc(label(v))}</td>${cells.join("")}</tr>`;
    })
    .join("");
  const W = (v: string, w: number) => windowAgg.get(`${v}|${w}`);
  type LiveDoc = {
    url?: string;
    rounds?: { rounds?: number; inhibited?: number; tookOther?: number };
    landing?: { before?: string; whileQueued?: string; after?: string; proposal?: { status?: string; outcomeAfterMs?: number } };
    decay?: { pollS?: number; halfLifeS?: number; tookOtherAtS?: number | null; lastInhibitedAtS?: number | null };
  };
  const lv = live as LiveDoc | null;
  const liveCard = lv
    ? `<div class="card table-wrap"><h3>Live check on a preview deployment (MEASURED: real takes, a real landing, real decay)</h3>
<p>X writes [shared, a] (priority 5) and Y writes [shared, b] (priority 4); agent A takes first, then agent B tries for the other intent. Claims that only repel would let B take it with p = 0.9 per try.</p>
<table><thead><tr><th class="l">check</th><th class="l">result</th></tr></thead><tbody>
<tr><td class="l">B tries once while A's claim is live (fresh agents each round)</td><td class="l">turned away in ${lv.rounds?.inhibited ?? "-"} of ${lv.rounds?.rounds ?? "-"} rounds, took the other intent in ${lv.rounds?.tookOther ?? "-"}</td></tr>
<tr><td class="l">A's change lands</td><td class="l">B ${esc(lv.landing?.before ?? "-")} before, ${esc(lv.landing?.whileQueued ?? "-")} while queued; proposal ${esc(lv.landing?.proposal?.status ?? "-")} in ${cell(lv.landing?.proposal?.outcomeAfterMs ?? null, 0)} ms; then B ${esc(lv.landing?.after ?? "-")}</td></tr>
<tr><td class="l">A goes silent (no heartbeats); B retries every ${lv.decay?.pollS ?? "-"} s</td><td class="l">turned away through ${cell(lv.decay?.lastInhibitedAtS ?? null)} s, took the other intent at ${cell(lv.decay?.tookOtherAtS ?? null)} s (one half-life of a claim: ${cell(lv.decay?.halfLifeS ?? null)} s)</td></tr>
</tbody></table></div>`
    : "";
  const b = (n: number, v: string) => S(n, v);
  const line = (n: number, before: string, after: string) => {
    const x = b(n, before);
    const y = b(n, after);
    return x && y
      ? `rework ${cell(x.reworkPct.mean)}% → ${cell(y.reworkPct.mean)}%, landings ${cell(x.landingsPerMin.mean)} → ${cell(y.landingsPerMin.mean)}/min (${pct(y.landingsPerMin.mean, x.landingsPerMin.mean)})`
      : "-";
  };
  const locks = (n: number) => b(n, "baseline");
  const html = `<!-- Lateral inhibition section for the chart page (generated by packages/bench/src/sim/inhibition.ts --steps report) -->
<h2>Lateral inhibition: the first claimant suppresses its neighbors<span class="tag s">SIMULATED</span>${live ? '<span class="tag m">MEASURED</span>' : ""}</h2>
<p>Before, a claim on a file only lowered the stimulus of other intents that write it, so the age term and reinforced thresholds let agents take claimed files anyway and read-set validation sent the later change back. Now <code>ColonyDO.take</code> keeps that soft repulsion and adds winner-take-all: an open intent whose own files carry at least half a fresh claim from other agents is skipped (core <code>chooseIntent</code>, <code>LATERAL_INHIBITION</code> = 0.5). Co-change neighbors still only repel. It is not a lock: there is no lock manager and no release protocol, and a silent agent's claim decays below the threshold after one half-life (about 3.5 minutes; <code>FT_LATERAL_INHIBITION</code> tunes it, <code>off</code> disables it).</p>
<div class="card table-wrap"><h3>hono workload, 20 simulated minutes, mean of 3 seeds (min-max) (SIMULATED)</h3>
<table><thead><tr><th>agents</th><th class="l">model</th><th>landed/min</th><th>rework %</th><th>conflicts/1k</th><th>claim to land p50 s</th><th>window inhibited %</th></tr></thead><tbody>${steadyRows}</tbody></table></div>
<div class="card table-wrap"><h3>Draining ${ttz?.tasks?.toLocaleString("en-US") ?? "-"} tasks to zero, seconds, mean over seeds (median for the last task) (SIMULATED)</h3>
<table><thead><tr><th>agents</th><th class="l">model</th><th>50% landed</th><th>90%</th><th>95%</th><th>all (median)</th><th>rework %</th></tr></thead><tbody>${ttzRows}</tbody></table></div>
<div class="card table-wrap"><h3>Co-change weight with lateral inhibition on, 1,000 agents: rework % @ landed/min, mean of 3 seeds (SIMULATED; 2 = deployed)</h3>
<table><thead><tr><th class="l">trunk writer</th><th>0</th><th>2</th><th>5</th><th>10</th></tr></thead><tbody>${weightRows}</tbody></table></div>
${
  windowRows && windows
    ? `<div class="card table-wrap"><h3>Candidate window (open intents a take considers, oldest first), 1,000 agents: rework % @ landed/min, mean of 3 seeds (SIMULATED analysis; ColonyDO's window stays 200)</h3>
<table><thead><tr><th class="l">model</th><th>200</th><th>400</th><th>1,000</th></tr></thead><tbody>${windowRows}</tbody></table></div>`
    : ""
}
${liveCard}
<ul>
<li><b>Per-lane landing (as deployed), 1,000 agents:</b> ${line(1_000, "ft+cc", "ft+cc+inh")}; locks: ${cell(locks(1_000)?.reworkPct.mean)}% at ${cell(locks(1_000)?.landingsPerMin.mean)}/min. 10,000 agents: ${line(10_000, "ft+cc", "ft+cc+inh")}. 100 agents: ${line(100, "ft+cc", "ft+cc+inh")}: the runs are identical, because with few agents a claimed intent never outranked a free one, so inhibition changed no choice.</li>
<li><b>Group commit, 1,000 agents:</b> ${line(1_000, "group+cc", "group+cc+inh")}. 10,000 agents: ${line(10_000, "group+cc", "group+cc+inh")}. Throughput falls because inhibited intents stay at the head of the 200-oldest window until their files' claims clear (${cell(b(1_000, "group+cc+inh")?.inhibitedWindowPct.mean, 0)}% of the admitted window is inhibited at 1,000 agents), so agents find less independent work.${
    W("group+cc", 400) && W("group+cc+inh", 400)
      ? ` With a 400-intent window (analysis, not built) inhibition costs ${pct(W("group+cc+inh", 400)!.landingsPerMin.mean, W("group+cc", 400)!.landingsPerMin.mean)} (${cell(W("group+cc", 400)!.landingsPerMin.mean, 0)} → ${cell(W("group+cc+inh", 400)!.landingsPerMin.mean, 0)}/min), but a wider window raises group-commit rework too (${cell(W("group+cc+inh", 400)!.reworkPct.mean)}% with inhibition), so the window is a trade-off of its own.`
      : ""
  }</li>
<li><b>Draining ${ttz?.tasks?.toLocaleString("en-US") ?? "-"} tasks, 1,000 agents:</b> the last task lands sooner (median ${cell(T(1_000, "ft+cc")?.ttzMedian, 0)} → ${cell(T(1_000, "ft+cc+inh")?.ttzMedian, 0)} s per-lane, ${cell(T(1_000, "group+cc")?.ttzMedian, 0)} → ${cell(T(1_000, "group+cc+inh")?.ttzMedian, 0)} s with group commit; locks ${cell(T(1_000, "baseline")?.ttzMedian, 0)} s) and rework falls ${cell(T(1_000, "ft+cc")?.reworkPct)}% → ${cell(T(1_000, "ft+cc+inh")?.reworkPct)}% (per-lane); half the tasks land at the same time per-lane (${cell(T(1_000, "ft+cc")?.t50, 0)} → ${cell(T(1_000, "ft+cc+inh")?.t50, 0)} s) and later with group commit (${cell(T(1_000, "group+cc")?.t50, 0)} → ${cell(T(1_000, "group+cc+inh")?.t50, 0)} s). No starvation tail appeared.</li>
<li><b>Co-change weight under inhibition, 1,000 agents.</b> Weight 5 takes per-lane rework to ${cell(weightAgg.get("ft+cc+inh|5")?.reworkPct.mean)}% at ${cell(weightAgg.get("ft+cc+inh|5")?.landingsPerMin.mean)}/min (weight 2: ${cell(weightAgg.get("ft+cc+inh|2")?.reworkPct.mean)}%); with group commit it costs throughput (${cell(weightAgg.get("group+cc+inh|2")?.landingsPerMin.mean, 0)} → ${cell(weightAgg.get("group+cc+inh|5")?.landingsPerMin.mean, 0)}/min for ${cell(weightAgg.get("group+cc+inh|2")?.reworkPct.mean)}% → ${cell(weightAgg.get("group+cc+inh|5")?.reworkPct.mean)}% rework). FT_COCHANGE_WEIGHT stays 2.</li>
<li><b>Conflicts vs locks.</b> At 1,000 agents FireTrident with inhibition returns ${cell(b(1_000, "ft+cc+inh")?.conflictsPer1000.mean, 0)} changes per 1,000 submitted against ${cell(locks(1_000)?.conflictsPer1000.mean, 0)} for locks, so the rework gap that is left is the cost per conflict in the model: a returned FireTrident intent is redone from scratch by whoever takes it, a locked change keeps its agent and reworks half. What still comes back is read-set conflicts, which claims on write footprints cannot see: with group commit only ${cell(b(1_000, "group+cc+inh")?.writeWritePer1000.mean)} of ${cell(b(1_000, "group+cc+inh")?.conflictsPer1000.mean, 0)} returns per 1,000 are write-write (${cell(b(1_000, "group+cc")?.writeWritePer1000.mean, 0)} before).</li>
<li><b>Method.</b> The simulator's take sets each candidate's direct claim to the number of other agents' claims on its write set (live agents heartbeat, so every claim is fresh) and passes LATERAL_INHIBITION to core <code>chooseIntent</code>, as <code>ColonyDO.take</code> does; co-change repulsion uses core <code>neighborRepulsion</code> at weight 2 with hono's last 200 commits. "Window inhibited" is the share of admitted candidates in the 200-oldest window that inhibition held back.</li>
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
