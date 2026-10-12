/**
 * Parameters and metrics shared by both coordination models. Every number that is not
 * a model input is documented where it is set (see sweep.ts and the results README).
 */
import { EventQueue, Rng, q } from "./engine.ts";
import type { SimTask, TaskSource } from "./workloads.ts";

/** Agent and platform timings (milliseconds). */
export interface Timings {
  /** Agent -> coordinator take/claim round trip (excluding queueing in a lane or merge queue). */
  takeMs: number;
  /** Agent -> coordinator propose/submit round trip. */
  proposeMs: number;
  /** Lane tick work before the trunk writer is called (trunk blobs, base blobs, lineage context RPCs). */
  laneOverheadMs: number;
  /** Trunk writer service time for one commit of b proposals: commitBaseMs + commitPerProposalMs * b. */
  commitBaseMs: number;
  commitPerProposalMs: number;
  /** Baseline merge queue: landing one change (pull, tree, push), and the extra cost of a rebase on a stale base. */
  landMs: number;
  rebaseMs: number;
  /** Checks/tests per change. FireTrident runs them in the agent's workspace before proposing (parallel);
   * the baseline runs them there too and re-runs them in the queue after every rebase (serialized). */
  testMs: number;
}

/** Everything a run needs. */
export interface SimParams {
  model: "baseline" | "firetrident" | "firetrident-group";
  agents: number;
  durationMs: number;
  warmupMs: number;
  seed: number;
  /** Open tasks kept in the backlog (new ones are created as tasks are taken). */
  backlog: number;
  timings: Timings;
  /** Fraction of a task's work an agent spends again after the change comes back. */
  rework: number;
  /** Same agent-side outcome polling as the in-platform agent: first, factor, cap (ms). */
  poll: { firstMs: number; factor: number; capMs: number };
  /** Agents start over this window. */
  rampMs: number;
}

/** Counters and samples a run produces. */
export class Metrics {
  readonly warmupMs: number;
  landed = 0;
  commits = 0;
  submitted = 0;
  invalidated = 0;
  invalidatedWriteWrite = 0;
  workMs = 0;
  reworkMs = 0;
  wastedMs = 0;
  messages: Record<string, number> = {};
  agentRequests = 0;
  ttl: number[] = [];
  e2e: number[] = [];
  batch: number[] = [];
  waits: Record<string, number> = {};
  sigmaMax = 0;
  sigmaSamples = 0;
  inhibitedTicks = 0;
  ticks = 0;
  trunkBusyMs = 0;

  constructor(warmupMs: number) {
    this.warmupMs = warmupMs;
  }

  on(now: number): boolean {
    return now >= this.warmupMs;
  }

  msg(now: number, kind: string, n = 1, agent = false): void {
    if (!this.on(now)) return;
    this.messages[kind] = (this.messages[kind] ?? 0) + n;
    if (agent) this.agentRequests += n;
  }

  wait(now: number, reason: string): void {
    if (!this.on(now)) return;
    this.waits[reason] = (this.waits[reason] ?? 0) + 1;
  }
}

/** One run's summary (what the sweep writes). */
export interface SimResult {
  model: SimParams["model"];
  agents: number;
  seed: number;
  simulatedMin: number;
  measuredMin: number;
  landingsPerMin: number;
  commitsPerMin: number;
  submittedPerMin: number;
  reworkPct: number;
  wastedPct: number;
  conflictsPer1000: number;
  writeWritePer1000: number;
  ttlP50S: number | null;
  ttlP99S: number | null;
  e2eP50S: number | null;
  e2eP99S: number | null;
  meanBatch: number | null;
  messagesPerLanded: number | null;
  messagesPerAgentAction: number | null;
  agentRequestsPerLanded: number | null;
  messages: Record<string, number>;
  waits: Record<string, number>;
  trunkUtilization: number;
  backlogAtEnd: number;
  sigmaMax: number;
  inhibitedTickPct: number;
  events: number;
  wallMs: number;
}

/** Turn metrics into a result row. */
export function summarize(p: SimParams, m: Metrics, extra: { backlogAtEnd: number; events: number; wallMs: number }): SimResult {
  const minutes = Math.max(1e-9, (p.durationMs - p.warmupMs) / 60_000);
  const totalMsgs = Object.values(m.messages).reduce((a, b) => a + b, 0);
  const sortS = (xs: number[]) => xs.map((x) => x / 1000).sort((a, b) => a - b);
  const ttl = sortS(m.ttl);
  const e2e = sortS(m.e2e);
  const r1 = (x: number | null) => (x === null ? null : Math.round(x * 10) / 10);
  const r2 = (x: number | null) => (x === null ? null : Math.round(x * 100) / 100);
  return {
    model: p.model,
    agents: p.agents,
    seed: p.seed,
    simulatedMin: p.durationMs / 60_000,
    measuredMin: minutes,
    landingsPerMin: r1(m.landed / minutes)!,
    commitsPerMin: r1(m.commits / minutes)!,
    submittedPerMin: r1(m.submitted / minutes)!,
    reworkPct: r2(m.workMs > 0 ? (100 * m.reworkMs) / m.workMs : 0)!,
    wastedPct: r2(m.workMs > 0 ? (100 * m.wastedMs) / m.workMs : 0)!,
    conflictsPer1000: r1(m.submitted > 0 ? (1000 * m.invalidated) / m.submitted : 0)!,
    writeWritePer1000: r1(m.submitted > 0 ? (1000 * m.invalidatedWriteWrite) / m.submitted : 0)!,
    ttlP50S: r1(q(ttl, 0.5)),
    ttlP99S: r1(q(ttl, 0.99)),
    e2eP50S: r1(q(e2e, 0.5)),
    e2eP99S: r1(q(e2e, 0.99)),
    meanBatch: m.batch.length ? r2(m.batch.reduce((a, b) => a + b, 0) / m.batch.length) : null,
    messagesPerLanded: m.landed > 0 ? r1(totalMsgs / m.landed) : null,
    messagesPerAgentAction: m.agentRequests > 0 ? r2(totalMsgs / m.agentRequests) : null,
    agentRequestsPerLanded: m.landed > 0 ? r1(m.agentRequests / m.landed) : null,
    messages: m.messages,
    waits: m.waits,
    trunkUtilization: r2(m.trunkBusyMs / Math.max(1, p.durationMs - p.warmupMs))!,
    backlogAtEnd: extra.backlogAtEnd,
    sigmaMax: r2(m.sigmaMax)!,
    inhibitedTickPct: r1(m.ticks > 0 ? (100 * m.inhibitedTicks) / m.ticks : 0)!,
    events: extra.events,
    wallMs: extra.wallMs,
  };
}

/**
 * The open task list, oldest first (all tasks have priority 1, so this is the order the
 * ColonyDO uses: priority DESC, created_at ASC). Returned tasks go back in age order.
 */
export class OpenTasks {
  private list: SimTask[] = [];
  version = 0;

  get size(): number {
    return this.list.length;
  }

  /** The first `n` open tasks. */
  top(n: number): SimTask[] {
    return this.list.length <= n ? this.list : this.list.slice(0, n);
  }

  /** Insert in (createdAt, id) order. */
  add(t: SimTask): void {
    t.status = "open";
    const l = this.list;
    if (l.length === 0 || cmp(l[l.length - 1]!, t) < 0) l.push(t);
    else l.splice(this.findIndex(t), 0, t);
    this.version++;
  }

  remove(t: SimTask): void {
    const i = this.findIndex(t);
    if (this.list[i] === t) this.list.splice(i, 1);
    else {
      const j = this.list.indexOf(t);
      if (j >= 0) this.list.splice(j, 1);
    }
    this.version++;
  }

  private findIndex(t: SimTask): number {
    let lo = 0;
    let hi = this.list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cmp(this.list[mid]!, t) < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}

function cmp(a: SimTask, b: SimTask): number {
  return a.createdAt - b.createdAt || a.id - b.id;
}

/** Shared scaffolding: clock, randomness, tasks, metrics, and outcome polling. */
export abstract class SimBase {
  readonly p: SimParams;
  readonly q = new EventQueue();
  readonly rng: Rng;
  readonly m: Metrics;
  readonly open = new OpenTasks();
  readonly source: TaskSource;
  private nextTaskId = 0;

  constructor(p: SimParams, source: TaskSource) {
    this.p = p;
    this.rng = new Rng(p.seed);
    this.m = new Metrics(p.warmupMs);
    this.source = source;
  }

  /** Keep the backlog topped up with fresh tasks. */
  refill(): void {
    while (this.open.size < this.p.backlog) this.open.add(this.source.make(this.nextTaskId++, this.q.now, this.rng));
  }

  /**
   * An agent that submitted at `submittedAt` polls its outcome on the in-platform schedule
   * (1.5 s, x1.6, capped at 15 s). Returns when it learns of an outcome that happened at
   * `outcomeAt`, and counts the polls as agent requests.
   */
  learnAt(submittedAt: number, outcomeAt: number): number {
    const { firstMs, factor, capMs } = this.p.poll;
    let t = submittedAt;
    let wait = firstMs;
    let polls = 0;
    for (;;) {
      t += wait;
      polls++;
      if (t >= outcomeAt) break;
      wait = Math.min(capMs, wait * factor);
    }
    this.m.msg(this.q.now, "poll", polls, true);
    return t;
  }

  /** Record work done for an attempt (and how much of it is rework). */
  work(task: SimTask, ms: number, rework: boolean): void {
    if (!this.m.on(this.q.now)) return;
    this.m.workMs += ms;
    if (rework) this.m.reworkMs += ms;
  }

  /** Run the simulation and summarize. */
  run(): SimResult {
    const t0 = performance.now();
    this.refill();
    this.start();
    this.q.run(this.p.durationMs);
    return summarize(this.p, this.m, { backlogAtEnd: this.backlogAtEnd(), events: this.q.processed, wallMs: Math.round(performance.now() - t0) });
  }

  protected abstract start(): void;
  protected abstract backlogAtEnd(): number;
}
