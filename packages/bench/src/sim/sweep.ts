#!/usr/bin/env node
/**
 * Run the coordination simulator over agent counts and write one JSON file.
 *
 *   node packages/bench/src/sim/sweep.ts --mode history --agents 10,100,1000,10000,100000 --out sim-history.json
 *   node packages/bench/src/sim/sweep.ts --mode live    --agents 10,50,200,1000 --out sim-live.json
 *
 * `--baseline-rework <fraction>` sets the share of a returned change the baseline redoes (0.5 when absent, as in the
 * published runs; 1 redoes it in full, as FireTrident does). The output records both fractions under `rework`.
 *
 * Modes:
 *  - history: the hono workload model (data/hono-workload.json) in a monorepo of --packages copies,
 *    in-platform agents (server-side latencies), log-normal work times.
 *  - live: the live benchmark's own workload (one new file per task over 64 regions, no work time,
 *    client-side latencies as measured from the laptop), to check the simulator against the
 *    measured runs.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { WorkloadModel } from "../workload.ts";
import { BaselineSim } from "./baseline.ts";
import type { SimParams, SimResult, Timings } from "./common.ts";
import { FireSim } from "./fire.ts";
import { HistoryWorkload, LiveWorkload, type TaskSource } from "./workloads.ts";

/** Calibration from the live runs (see results/<date>/calibration.json for the derivation). */
export interface Calibration {
  source: string;
  inPlatform: Timings;
  /** Laptop-side take/propose p50 per agent count, for the live-mode check. */
  client: Record<string, { takeMs: number; proposeMs: number }>;
  clientDefault: { takeMs: number; proposeMs: number };
}

const HERE = dirname(fileURLToPath(import.meta.url));

/** FireTrident redoes a returned change from scratch; the baseline redoes this share of it unless a run says otherwise. */
export const DEFAULT_REWORK = { baseline: 0.5, firetrident: 1.0 } as const;

/** Build the parameters for one run; `baselineRework` overrides the baseline's share of a returned change it redoes. */
export function params(model: SimParams["model"], agents: number, opts: { durationMs: number; warmupMs: number; seed: number; timings: Timings; backlog: number; rampMs: number; baselineRework?: number }): SimParams {
  return {
    model,
    agents,
    durationMs: opts.durationMs,
    warmupMs: opts.warmupMs,
    seed: opts.seed,
    backlog: opts.backlog,
    timings: opts.timings,
    // FireTrident as built: a returned intent reopens and is redone from scratch by whoever takes it.
    // Baseline: the same agent keeps its locks, rebases and reworks half of the change, unless the run sets another share.
    rework: model === "baseline" ? (opts.baselineRework ?? DEFAULT_REWORK.baseline) : DEFAULT_REWORK.firetrident,
    poll: { firstMs: 1_500, factor: 1.6, capMs: 15_000 },
    rampMs: opts.rampMs,
  };
}

/** Run one model once. */
export function runOne(p: SimParams, source: TaskSource, initial: (path: string) => string | null): SimResult {
  const sim = p.model === "baseline" ? new BaselineSim(p, source, initial) : new FireSim(p, source, initial);
  return sim.run();
}

function list(v: string | undefined, fallback: number[]): number[] {
  return v ? v.split(",").map((x) => Number(x.trim())).filter((x) => Number.isFinite(x) && x > 0) : fallback;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      mode: { type: "string" },
      agents: { type: "string" },
      models: { type: "string" },
      duration: { type: "string" },
      warmup: { type: "string" },
      seed: { type: "string" },
      seeds: { type: "string" },
      packages: { type: "string" },
      depth: { type: "string" },
      "max-reads": { type: "string" },
      "work-median": { type: "string" },
      "work-sigma": { type: "string" },
      "test-ms": { type: "string" },
      "baseline-rework": { type: "string" },
      calibration: { type: "string" },
      model: { type: "string" },
      out: { type: "string" },
    },
    strict: true,
  });
  const mode = values.mode ?? "history";
  const cal = JSON.parse(readFileSync(values.calibration ?? join(HERE, "..", "..", "data", "calibration.json"), "utf8")) as Calibration;
  const models = (values.models ?? "baseline,firetrident,firetrident-group").split(",").map((s) => s.trim()) as Array<SimParams["model"]>;
  const seeds = values.seeds ? list(values.seeds, [1]) : [Number(values.seed ?? 1)];
  const testMs = Number(values["test-ms"] ?? 0);
  const baselineRework = Number(values["baseline-rework"] ?? DEFAULT_REWORK.baseline);
  if (!(baselineRework > 0 && baselineRework <= 1)) throw new Error(`--baseline-rework must be in (0, 1], got ${values["baseline-rework"]}`);
  const out = values.out ?? `sim-${mode}.json`;
  const results: SimResult[] = [];
  let workloadInfo: Record<string, unknown> = {};
  const log = (s: string) => console.error(`[${new Date().toISOString().slice(11, 19)}] ${s}`);

  if (mode === "history") {
    const model = JSON.parse(readFileSync(values.model ?? join(HERE, "..", "..", "data", "hono-workload.json"), "utf8")) as WorkloadModel;
    const agentsList = list(values.agents, [10, 100, 1_000, 10_000, 100_000]);
    const durationMs = Number(values.duration ?? 1_200) * 1000;
    const warmupMs = Number(values.warmup ?? 300) * 1000;
    const work = { medianMs: Number(values["work-median"] ?? 60) * 1000, sigma: Number(values["work-sigma"] ?? 0.8) };
    const mk = () => new HistoryWorkload(model, { packages: Number(values.packages ?? 100), regionDepth: Number(values.depth ?? 3), maxReads: Number(values["max-reads"] ?? 8), work });
    workloadInfo = mk().describe();
    for (const agents of agentsList) {
      for (const m of models) {
        for (const seed of seeds) {
          const timings = { ...cal.inPlatform, testMs };
          const p = params(m, agents, { durationMs, warmupMs, seed, timings, backlog: Math.max(1_000, 400), rampMs: Math.min(60_000, agents * 5), baselineRework });
          const r = runOne(p, mk(), () => "v0");
          results.push(r);
          log(`${m} N=${agents} seed=${seed}: ${r.landingsPerMin}/min, rework ${r.reworkPct}%, ttl p50 ${r.ttlP50S}s p99 ${r.ttlP99S}s, conflicts ${r.conflictsPer1000}/1000, msgs/landed ${r.messagesPerLanded}, batch ${r.meanBatch}, ${r.events} events in ${r.wallMs} ms`);
        }
      }
    }
  } else if (mode === "live") {
    const agentsList = list(values.agents, [10, 50, 200, 1_000]);
    const runs: Record<string, number> = { "10": 60, "50": 75, "200": 90, "1000": 90 };
    workloadInfo = new LiveWorkload({ regions: 64, regionDepth: 3, work: { medianMs: 0, sigma: 0 } }).describe();
    for (const agents of agentsList) {
      const durationS = Number(values.duration ?? runs[String(agents)] ?? 90);
      const rampS = Math.min(10, agents / 50);
      const warmupS = Math.min(durationS / 2, rampS + Math.min(15, durationS / 4));
      const c = cal.client[String(agents)] ?? cal.clientDefault;
      for (const m of models) {
        for (const seed of seeds) {
          const timings: Timings = { ...cal.inPlatform, takeMs: c.takeMs, proposeMs: c.proposeMs, testMs: 0 };
          const p = params(m, agents, { durationMs: durationS * 1000, warmupMs: warmupS * 1000, seed, timings, backlog: Math.max(400, agents * 3), rampMs: rampS * 1000, baselineRework });
          const r = runOne(p, new LiveWorkload({ regions: 64, regionDepth: 3, work: { medianMs: 0, sigma: 0 } }), () => null);
          results.push(r);
          log(`${m} N=${agents}: ${r.landingsPerMin}/min (commits ${r.commitsPerMin}/min), ttl p50 ${r.ttlP50S}s p99 ${r.ttlP99S}s, batch ${r.meanBatch}`);
        }
      }
    }
  } else {
    throw new Error(`unknown --mode ${mode}`);
  }

  const doc = {
    kind: "sim",
    label: "SIMULATED",
    generatedAt: new Date().toISOString(),
    mode,
    workload: workloadInfo,
    calibration: cal,
    testMs,
    rework: { baseline: baselineRework, firetrident: DEFAULT_REWORK.firetrident },
    results,
  };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
  log(`wrote ${out}`);
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
