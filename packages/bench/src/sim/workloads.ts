/**
 * Task generators for the simulator. A task is one change: the files it writes (its
 * declared footprint), the files it reads, and how long an agent works on it.
 */
import { regionOf } from "@fire_trident/core";
import type { Intent } from "@fire_trident/core";
import { Alias, Rng } from "./engine.ts";
import type { WorkloadModel } from "../workload.ts";

/** One change as both coordination models see it. */
export interface SimTask {
  id: number;
  writes: string[];
  reads: string[];
  /** Distinct regions of the writes, in first-seen order. */
  regions: string[];
  /** Region of each write, aligned with `writes`. */
  writeRegions: string[];
  /** Region holding most writes (ties: first); the proposal's lane. */
  primary: string;
  /** Agent work time for one full attempt (ms). */
  workMs: number;
  createdAt: number;
  /** What chooseIntent needs (priority and age). */
  intent: Intent;
  status: "open" | "claimed" | "proposed" | "landed";
  attempts: number;
  firstClaimAt: number;
  firstSubmitAt: number;
}

/** Produces tasks on demand. */
export interface TaskSource {
  describe(): Record<string, unknown>;
  make(id: number, now: number, rng: Rng): SimTask;
}

/** Work-time distribution: log-normal with a median (ms) and log-space sigma; 0 median means no work. */
export interface WorkDist {
  medianMs: number;
  sigma: number;
}

function drawWork(rng: Rng, w: WorkDist): number {
  return w.medianMs <= 0 ? 0 : Math.max(1, rng.lognormal(w.medianMs, w.sigma));
}

const regionCache = new Map<string, string>();

/** regionOf with a cache (paths repeat a lot). */
export function regionFor(path: string, depth: number): string {
  const key = `${depth}\u0000${path}`;
  let r = regionCache.get(key);
  if (r === undefined) {
    r = regionOf(path, depth);
    regionCache.set(key, r);
  }
  return r;
}

function finish(id: number, writes: string[], reads: string[], depth: number, now: number, workMs: number): SimTask {
  const counts = new Map<string, number>();
  const writeRegions = writes.map((w) => regionFor(w, depth));
  for (const r of writeRegions) counts.set(r, (counts.get(r) ?? 0) + 1);
  let primary = ".";
  let best = 0;
  for (const [r, n] of counts) {
    if (n > best) {
      primary = r;
      best = n;
    }
  }
  const intent = { id: `t${id}`, priority: 1, createdAt: now } as unknown as Intent;
  return { id, writes, reads, regions: [...counts.keys()], writeRegions, primary, workMs, createdAt: now, intent, status: "open", attempts: 0, firstClaimAt: -1, firstSubmitAt: -1 };
}

/**
 * Tasks shaped by a real repository's history, in a monorepo of `packages` copies of it
 * (paths `p<k>/<file>`): sizes from the change-size histogram, write sets grown along
 * co-change edges from a popularity-weighted seed file, read sets from the direct imports
 * of the written files (capped at `maxReads`).
 */
export class HistoryWorkload implements TaskSource {
  private readonly m: WorkloadModel;
  private readonly sizes: Alias;
  private readonly seeds: Alias;
  private readonly seedIndex: number[];
  private readonly paths: Array<Map<number, string>>;
  readonly packages: number;
  readonly depth: number;
  readonly maxReads: number;
  readonly work: WorkDist;

  constructor(model: WorkloadModel, opts: { packages: number; regionDepth: number; maxReads: number; work: WorkDist }) {
    this.m = model;
    this.packages = Math.max(1, Math.floor(opts.packages));
    this.depth = opts.regionDepth;
    this.maxReads = opts.maxReads;
    this.work = opts.work;
    this.sizes = new Alias(model.sizeHist.map((n, k) => (k === 0 ? 0 : n)));
    this.seedIndex = model.touches.map((t, i) => (t > 0 ? i : -1)).filter((i) => i >= 0);
    this.seeds = new Alias(this.seedIndex.map((i) => model.touches[i]!));
    this.paths = Array.from({ length: this.packages }, () => new Map<number, string>());
  }

  describe(): Record<string, unknown> {
    return {
      kind: "history",
      repo: this.m.source.repo,
      head: this.m.source.head.slice(0, 12),
      commitsUsed: this.m.source.commitsUsed,
      packages: this.packages,
      regionDepth: this.depth,
      maxReads: this.maxReads,
      work: this.work,
      meanFilesPerChange: this.m.stats.meanFilesPerChange,
    };
  }

  private path(pkg: number, file: number): string {
    const cache = this.paths[pkg]!;
    let p = cache.get(file);
    if (p === undefined) {
      p = `p${pkg}/${this.m.files[file]!}`;
      cache.set(file, p);
    }
    return p;
  }

  make(id: number, now: number, rng: Rng): SimTask {
    const k = Math.max(1, this.sizes.sample(rng));
    const chosen: number[] = [this.seedIndex[this.seeds.sample(rng)]!];
    const have = new Set(chosen);
    for (let tries = 0; chosen.length < k && tries < 8 * k; tries++) {
      const from = chosen[rng.int(chosen.length)]!;
      const nb = this.m.neighbours[from] ?? [];
      let next = -1;
      if (nb.length > 0) {
        let total = 0;
        for (const [, n] of nb) total += n;
        let x = rng.next() * total;
        for (const [j, n] of nb) {
          x -= n;
          if (x <= 0) {
            next = j;
            break;
          }
        }
      }
      if (next < 0 || have.has(next)) next = this.seedIndex[this.seeds.sample(rng)]!;
      if (!have.has(next)) {
        have.add(next);
        chosen.push(next);
      }
    }
    const readSet = new Set<number>();
    for (const f of chosen) for (const d of this.m.imports[f] ?? []) if (!have.has(d)) readSet.add(d);
    let reads = [...readSet];
    if (reads.length > this.maxReads) {
      for (let i = reads.length - 1; i > 0; i--) {
        const j = rng.int(i + 1);
        [reads[i], reads[j]] = [reads[j]!, reads[i]!];
      }
      reads = reads.slice(0, this.maxReads);
    }
    const pkg = rng.int(this.packages);
    return finish(
      id,
      chosen.map((f) => this.path(pkg, f)),
      reads.map((f) => this.path(pkg, f)),
      this.depth,
      now,
      drawWork(rng, this.work),
    );
  }
}

/**
 * The live benchmark's workload: each task adds one new file in one of `regions`
 * directories (bench/rNN/...), round-robin by task id, and reads nothing.
 */
export class LiveWorkload implements TaskSource {
  readonly regions: number;
  readonly depth: number;
  readonly work: WorkDist;

  constructor(opts: { regions: number; regionDepth: number; work: WorkDist }) {
    this.regions = opts.regions;
    this.depth = opts.regionDepth;
    this.work = opts.work;
  }

  describe(): Record<string, unknown> {
    return { kind: "live-like", regions: this.regions, regionDepth: this.depth, work: this.work };
  }

  make(id: number, now: number, rng: Rng): SimTask {
    const r = String(id % this.regions).padStart(2, "0");
    return finish(id, [`bench/r${r}/t${id}.txt`], [], this.depth, now, drawWork(rng, this.work));
  }
}
