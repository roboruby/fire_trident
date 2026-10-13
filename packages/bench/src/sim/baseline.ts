/**
 * BASELINE coordination model: exclusive file locks plus one serialized merge queue.
 *
 *  - claim: the coordinator offers the same 200 oldest open tasks FireTrident's take sees and
 *    hands out the first one whose write set is entirely unlocked, locking those files. With
 *    none claimable the agent retries after the same hint FireTrident gives for a closed
 *    region (3 s, +-25%).
 *  - the agent works, runs its checks, and submits to the single merge queue, keeping its
 *    locks until the change lands (so write-write conflicts cannot happen).
 *  - the queue serves one change at a time. A change whose base is stale (trunk moved since
 *    the agent started) is rebased and its checks re-run in the queue. If any file it read or
 *    wrote changed on trunk since its base, the re-run fails (the same invalidation rule
 *    FireTrident's read-set validation applies) and it goes back to its agent, who reworks it
 *    (`rework` x the task's work time) with its locks held and resubmits at the back.
 *    Otherwise it lands (`landMs`), and its locks are released.
 *  - ANALYSIS, off by default: with `assumptions`, a change whose changed files it only read lands
 *    after the rebase when its assumptions held, as FireSim's option does (not built).
 */
import { SimBase, holdChance, assumptionStream, type SimParams } from "./common.ts";
import type { Rng } from "./engine.ts";
import type { SimTask, TaskSource } from "./workloads.ts";

/** Model options beyond SimParams. */
export interface BaselineOptions {
  /**
   * ANALYSIS, not built: assumption revalidation. A change whose changed files it only read lands
   * anyway when its assumption on each held through every change since its base, each change
   * independently with probability `hold`. Undefined leaves it off.
   */
  assumptions?: { hold: number };
}

const CANDIDATE_CAP = 200;
const HEARTBEAT_MS = 45_000;
const RETRY = { idle: 5_000, blocked: 3_000 };

interface Agent {
  id: number;
  task: SimTask | null;
  claimedAt: number;
}

interface Change {
  task: SimTask;
  agent: Agent;
  base: Map<string, string | null>;
  baseCommit: number;
  submittedAt: number;
  attemptMs: number;
  /** Assumption revalidation only: landings that had written each base path at the base. */
  versions: Map<string, number> | null;
  /** Assumption revalidation only: it went past a changed read because its assumptions held. */
  kept: boolean;
}

/** Locks + one merge queue. */
export class BaselineSim extends SimBase {
  private readonly initial: (path: string) => string | null;
  private readonly agents: Agent[] = [];
  private readonly locks = new Map<string, number>();
  private readonly trunk = new Map<string, string>();
  private readonly queue: Change[] = [];
  private busy = false;
  private commitsSeen = 0;
  private blobSeq = 0;
  private lockVersion = 0;
  private blockedAt = -1;
  /** Assumption revalidation: the chance a assumption holds through one change (null = off), drawn from its own stream. */
  private readonly assumptionHold: number | null;
  private readonly assumptionRng: Rng | null;
  /** Assumption revalidation only: landings that wrote each path. */
  private readonly versions = new Map<string, number>();
  /** Landings after warm-up that went past a changed read because their assumptions held. */
  keptLandings = 0;

  constructor(p: SimParams, source: TaskSource, initial: (path: string) => string | null, opts: BaselineOptions = {}) {
    super(p, source);
    this.initial = initial;
    this.assumptionHold = opts.assumptions ? holdChance(opts.assumptions.hold) : null;
    this.assumptionRng = opts.assumptions ? assumptionStream(p.seed) : null;
  }

  protected backlogAtEnd(): number {
    return this.queue.length + (this.busy ? 1 : 0);
  }

  protected start(): void {
    for (let i = 0; i < this.p.agents; i++) {
      const a: Agent = { id: i, task: null, claimedAt: 0 };
      this.agents.push(a);
      const t0 = this.p.agents > 1 ? (i * this.p.rampMs) / this.p.agents : 0;
      this.q.at(t0, () => this.claim(a));
    }
  }

  private blob(path: string): string | null {
    const v = this.trunk.get(path);
    return v !== undefined ? v : this.initial(path);
  }

  private snapshot(t: SimTask): Map<string, string | null> {
    const m = new Map<string, string | null>();
    for (const p of t.writes) m.set(p, this.blob(p));
    for (const p of t.reads) m.set(p, this.blob(p));
    return m;
  }

  private claim(a: Agent): void {
    const now = this.q.now;
    this.m.msg(now, "claim", 1, true);
    if (this.open.size === 0) {
      this.m.wait(now, "no open tasks");
      this.q.after(this.p.timings.takeMs + this.rng.jitter(RETRY.idle), () => this.claim(a));
      return;
    }
    if (this.blockedAt !== this.lockVersion + this.open.version * 1e9) {
      for (const t of this.open.top(CANDIDATE_CAP)) {
        if (t.writes.every((w) => !this.locks.has(w))) {
          this.start1(a, t, now);
          return;
        }
      }
      this.blockedAt = this.lockVersion + this.open.version * 1e9;
    }
    this.m.wait(now, "every offered task has a locked file");
    this.q.after(this.p.timings.takeMs + this.rng.jitter(RETRY.blocked), () => this.claim(a));
  }

  private start1(a: Agent, t: SimTask, now: number): void {
    this.open.remove(t);
    this.refill();
    for (const w of t.writes) this.locks.set(w, a.id);
    this.lockVersion++;
    t.status = "claimed";
    t.attempts++;
    t.firstClaimAt = now;
    a.task = t;
    a.claimedAt = now;
    this.attempt(a, t, now + this.p.timings.takeMs, t.workMs, false);
  }

  /** Work (or rework) from `from`, then submit. The agent starts from trunk as of `from`. */
  private attempt(a: Agent, t: SimTask, from: number, workMs: number, rework: boolean): void {
    this.work(t, workMs, rework);
    const base = this.snapshot(t);
    const versions = this.assumptionHold !== null ? new Map([...base.keys()].map((path) => [path, this.versions.get(path) ?? 0])) : null;
    const baseCommit = this.commitsSeen;
    this.q.at(from + workMs + this.p.timings.testMs, () => {
      this.m.msg(this.q.now, "submit", 1, true);
      this.q.after(this.p.timings.proposeMs, () => {
        const now = this.q.now;
        if (t.firstSubmitAt < 0) t.firstSubmitAt = now;
        if (this.m.on(now)) this.m.submitted++;
        t.status = "proposed";
        this.queue.push({ task: t, agent: a, base, baseCommit, submittedAt: now, attemptMs: workMs, versions, kept: false });
        this.serve();
      });
    });
  }

  /**
   * Assumption revalidation (analysis, see BaselineOptions.assumptions): true when every changed base path
   * is one the change only read and its assumption held through each landing that wrote it since the
   * base (one draw per landing).
   */
  private keeps(c: Change): boolean {
    const hold = this.assumptionHold;
    if (hold === null) return false;
    const writes = new Set(c.task.writes);
    const changed: string[] = [];
    for (const [path, blob] of c.base) {
      if (this.blob(path) === blob) continue;
      if (writes.has(path)) return false;
      changed.push(path);
    }
    for (const path of changed) {
      const changes = Math.max(1, (this.versions.get(path) ?? 0) - (c.versions?.get(path) ?? 0));
      for (let k = 0; k < changes; k++) if (this.assumptionRng!.next() >= hold) return false;
    }
    return changed.length > 0;
  }

  private serve(): void {
    if (this.busy || this.queue.length === 0) return;
    this.busy = true;
    const c = this.queue.shift()!;
    const t = this.p.timings;
    const stale = this.commitsSeen > c.baseCommit;
    const discover = stale ? t.rebaseMs + t.testMs : 0;
    let conflict = false;
    for (const [path, blob] of c.base) {
      if (this.blob(path) !== blob) {
        conflict = true;
        break;
      }
    }
    if (conflict && this.assumptionHold !== null && this.keeps(c)) {
      conflict = false;
      c.kept = true;
    }
    this.m.msg(this.q.now, "queueFetch", 1);
    if (stale) this.m.msg(this.q.now, "queueRebasePush", 1);
    const service = conflict ? discover : discover + t.landMs;
    this.q.after(service, () => {
      const now = this.q.now;
      if (this.m.on(now)) this.m.trunkBusyMs += Math.min(service, now - this.p.warmupMs);
      this.busy = false;
      if (conflict) this.fail(c, now);
      else this.land(c, now);
      this.serve();
    });
  }

  private land(c: Change, now: number): void {
    for (const w of c.task.writes) this.trunk.set(w, `b${this.blobSeq++}`);
    if (this.assumptionHold !== null) for (const w of c.task.writes) this.versions.set(w, (this.versions.get(w) ?? 0) + 1);
    this.commitsSeen++;
    for (const w of c.task.writes) this.locks.delete(w);
    this.lockVersion++;
    c.task.status = "landed";
    this.m.msg(now, "landPush", 1);
    if (this.m.on(now)) {
      this.m.landed++;
      this.m.commits++;
      if (c.kept) this.keptLandings++;
      this.m.batch.push(1);
      this.m.ttl.push(now - c.task.firstSubmitAt);
      this.m.e2e.push(now - c.task.firstClaimAt);
    }
    const at = this.learn(c, now);
    c.agent.task = null;
    this.q.at(at, () => this.claim(c.agent));
  }

  private fail(c: Change, now: number): void {
    if (this.m.on(now)) {
      this.m.invalidated++;
      this.m.wastedMs += c.attemptMs * this.p.rework;
    }
    const at = this.learn(c, now);
    // The agent keeps its locks, rebases onto current trunk, reworks part of the change, resubmits.
    this.q.at(at, () => {
      c.task.attempts++;
      this.attempt(c.agent, c.task, this.q.now, c.task.workMs * this.p.rework, true);
    });
  }

  private learn(c: Change, now: number): number {
    const at = this.learnAt(c.submittedAt, now);
    this.m.msg(now, "heartbeat", Math.floor((at - c.agent.claimedAt) / HEARTBEAT_MS), true);
    c.agent.claimedAt = at;
    return at;
  }
}
