import { pathsOverlap, repulsion } from "@fire_trident/core";
import type { FieldReading, Id, Path } from "@fire_trident/core";

/**
 * Self-assignment at scale: the pure parts of how ColonyDO.take reads the field.
 *
 * Every take scores up to 200 open intents against the claims of the regions they touch. The
 * claim field of a region is read once and shared by every concurrent take (FieldIndex), so a
 * take costs map lookups per candidate instead of an overlap test against every claimed path
 * (core `repulsion` tests every pair with glob matching, which made each take cost milliseconds
 * of CPU on the one object every agent talks to). Results are the same as core `repulsion`.
 */

/** A directory prefix or a glob (it can overlap many concrete paths). */
const PATTERN = /[*?{]|\/$/;

/** True when `path` is a directory prefix ("src/") or a glob. */
export function isPatternPath(path: Path): boolean {
  return PATTERN.test(path);
}

/** The claim and danger a region holds, indexed for repeated scoring. Built once per reading. */
export interface FieldIndex {
  /** Claim and danger per path (positive values only), as core functions expect them. */
  byPath: FieldReading["byPath"];
  /** Concrete paths (not directory prefixes or globs) and their claim and danger. */
  exact: Map<Path, { claim: number; danger: number }>;
  /** Directory and glob entries: they can overlap many paths, so they are tested one by one. */
  patterns: Array<{ path: Path; claim: number; danger: number }>;
  /** Anything repels at all. */
  repulsive: boolean;
}

/**
 * Index a reading's claim and danger for scoring. `minus` (the reading agent's own claims per
 * path) is subtracted, so an agent is never repelled by itself.
 */
export function fieldIndex(byPath: FieldReading["byPath"], minus?: ReadonlyMap<Path, number>): FieldIndex {
  const out: FieldIndex = { byPath: {}, exact: new Map(), patterns: [], repulsive: false };
  const kept: Array<[Path, { claim: number; danger: number }]> = [];
  for (const [path, v] of Object.entries(byPath)) {
    const claim = Math.max(0, (v.claim ?? 0) - (minus?.get(path) ?? 0));
    const danger = v.danger ?? 0;
    if (claim + danger <= 1e-9) continue;
    const entry = { claim, danger };
    kept.push([path, entry]);
    if (isPatternPath(path)) out.patterns.push({ path, ...entry });
    else out.exact.set(path, entry);
  }
  // fromEntries defines own properties, so a path such as "__proto__" stays an ordinary key.
  out.byPath = Object.fromEntries(kept);
  out.repulsive = kept.length > 0;
  return out;
}

/**
 * Claim plus danger on the field paths that overlap `footprint`, each field path counted once:
 * the same value as core `repulsion(index.byPath, footprint)`. Two concrete normalized paths
 * overlap only when they are equal, so concrete footprints need one lookup per path; only
 * directory and glob entries (on either side) are tested pair by pair.
 */
export function fastRepulsion(index: FieldIndex, footprint: Path[]): number {
  if (!index.repulsive || footprint.length === 0) return 0;
  if (footprint.some(isPatternPath)) return repulsion(index.byPath, footprint);
  let total = 0;
  const seen = new Set<Path>();
  for (const path of footprint) {
    if (seen.has(path)) continue;
    seen.add(path);
    const v = index.exact.get(path);
    if (v) total += v.claim + v.danger;
  }
  for (const q of index.patterns) if (footprint.some((e) => pathsOverlap(e, q.path))) total += q.claim + q.danger;
  return total;
}

/** A claim a recent take made that a shared reading may predate (see ColonyDO.recentClaims). */
export interface RecentClaim {
  paths: Set<Path>;
  regions: Set<string>;
  /** When its deposit finished, null while in flight. */
  doneAt: number | null;
}

/**
 * Recent claims of other agents grouped by region, keeping those a region's reading may not
 * include: still in flight, or finished after that reading started. One pass over the recent
 * claims per take (instead of one per region), pruning entries older than `horizon` as it goes.
 */
export function unseenByRegion(
  recent: Map<Id, RecentClaim>,
  agentId: Id,
  fetchStart: (region: string) => number | undefined,
  horizon: number,
): Map<string, RecentClaim[]> {
  const out = new Map<string, RecentClaim[]>();
  for (const [id, c] of recent) {
    if (c.doneAt !== null && c.doneAt < horizon) {
      recent.delete(id);
      continue;
    }
    if (id === agentId) continue;
    for (const region of c.regions) {
      const since = fetchStart(region);
      if (since === undefined) continue;
      if (c.doneAt !== null && c.doneAt < since) continue;
      const list = out.get(region);
      if (list) list.push(c);
      else out.set(region, [c]);
    }
  }
  return out;
}

/**
 * Retry pacing for agents told to wait. Every waiting agent comes back, and with thousands of
 * them a fixed hint turns the waiting room into the colony's main load (the g1 run at 1,000
 * agents spent most of its takes on waits). The hint grows with the number of agents that
 * waited recently, so waiting agents together retry at about `perSecond` takes a second.
 */
export class WaitPacer {
  private readonly waiting = new Map<Id, number>();
  private lastPrune = 0;

  constructor(
    private readonly perSecond = 200,
    private readonly windowMs = 30_000,
    private readonly maxMs = 30_000,
  ) {}

  /** Agents that waited within the window. */
  get size(): number {
    return this.waiting.size;
  }

  /** Record a wait for `agentId` and return the retry hint (before jitter) for a base of `baseMs`. */
  wait(agentId: Id, baseMs: number, now: number): number {
    this.prune(now);
    this.waiting.set(agentId, now);
    const spread = Math.ceil((this.waiting.size / this.perSecond) * 1000);
    return Math.min(Math.max(baseMs, this.maxMs), Math.max(baseMs, spread));
  }

  /** The agent got work (or left): it no longer counts as waiting. */
  done(agentId: Id): void {
    this.waiting.delete(agentId);
  }

  /** Forget everything (colony erased). */
  clear(): void {
    this.waiting.clear();
  }

  private prune(now: number): void {
    if (now - this.lastPrune < 1_000) return;
    this.lastPrune = now;
    const cutoff = now - this.windowMs;
    for (const [id, at] of this.waiting) if (at < cutoff) this.waiting.delete(id);
  }
}

/**
 * How often each region should send its field events to the colony. Regions batch events for
 * this long; with many regions active the colony asks each to batch longer, so the emit calls it
 * receives stay near `perSecond` in total however many regions there are (at 1,000 agents, 64
 * regions emitting every 100 ms were 640 calls a second on the colony).
 */
export class EmitPacer {
  private readonly regions = new Map<string, number>();
  private lastPrune = 0;

  constructor(
    private readonly perSecond = 60,
    private readonly minMs = 100,
    private readonly maxMs = 5_000,
    private readonly windowMs = 10_000,
  ) {}

  /** Note an emit carrying events of `region` (if any) and return the interval regions should use. */
  pace(region: string | null, now: number): number {
    if (region !== null) this.regions.set(region, now);
    if (now - this.lastPrune >= 1_000) {
      this.lastPrune = now;
      const cutoff = now - this.windowMs;
      for (const [r, at] of this.regions) if (at < cutoff) this.regions.delete(r);
    }
    return Math.min(this.maxMs, Math.max(this.minMs, Math.round((1000 * this.regions.size) / this.perSecond)));
  }

  /** Forget everything (colony erased). */
  clear(): void {
    this.regions.clear();
  }
}

/**
 * Bounded concurrency: up to `limit` turns at once and up to `queueMax` callers waiting in arrival
 * order. `enter` returns true when the caller may go on at once (no await, so the uncontended path
 * keeps its timing), a promise that resolves on its turn, or null when the queue is full and the
 * caller should back off. Every non-null `enter` is paired with exactly one `leave`.
 */
export class Gate {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(
    private readonly limit: number,
    private readonly queueMax: number,
  ) {}

  /** A turn now (true), later (the promise resolves on it), or none (null: the queue is full). */
  enter(): true | Promise<void> | null {
    if (this.active < this.limit) {
      this.active++;
      return true;
    }
    if (this.queue.length >= this.queueMax) return null;
    return new Promise<void>((resolve) => this.queue.push(resolve));
  }

  /** End a turn: the oldest waiter takes it over, or the slot frees up. */
  leave(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.active = Math.max(0, this.active - 1);
  }

  /** Turns in progress. */
  get inFlight(): number {
    return this.active;
  }

  /** Callers waiting for a turn. */
  get waiting(): number {
    return this.queue.length;
  }
}
