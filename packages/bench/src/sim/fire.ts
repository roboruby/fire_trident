/**
 * FireTrident coordination model, mirroring the deployed code paths:
 *  - take = ColonyDO.takeFor: the 200 oldest open intents are candidates; repulsion is the
 *    other agents' claims on the footprint; admission per region is core admissionOpen(active
 *    claim holders, landing commits in the last minute); core chooseIntent picks. With `inhibitAt`
 *    set, lateral inhibition as ColonyDO.take applies it: a candidate whose own files carry that
 *    much claim from other agents is skipped (core inhibited). Live agents heartbeat, so every
 *    claim counts as a fresh one (1); unset keeps the model as it was before inhibition was built.
 *    `inhibitBy` picks how a candidate's per-file claims make that value (the sum, as before, or the
 *    strongest single file), and `ageCap` caps the stimulus's age multiplier (unset: uncapped, as before).
 *  - each proposal goes to the lane of its primary region (RegionDO): on a tick it is validated
 *    with core validateProposal against current trunk, core selectBatch picks the batch, and the
 *    trunk writer lands it; the next tick waits core laneIntervalMs(flux) times
 *    inhibitionFactor(sigma), with sigma from recorded causes (returns are never parents).
 *  - there is ONE trunk writer per colony (TrunkDO). In "firetrident" it is a serial chain: every
 *    lane's batch is one commit, served first-come first-served, and each batch is re-validated
 *    when its turn comes.
 *  - "firetrident-group" is the trunk writer as deployed (TrunkDO, trunk/plan.ts): it folds every
 *    batch waiting in its queue into the commit it is building (group commit), still re-validating
 *    each proposal.
 *  - ANALYSIS options, off by default: `assumptions` lands a proposal that is stale only through files
 *    it read when its assumptions held (not built), and `onReturn` reports what sent each proposal back.
 */
import {
  admissionOpen,
  ageFactor,
  branchingRatio,
  chooseIntent,
  inhibited,
  inhibitionFactor,
  laneIntervalMs,
  reinforceThreshold,
  selectBatch,
  stimulus,
  validateProposal,
} from "@fire_trident/core";
import type { CausalEvent, Candidate, ClaimCombine, FileVersion, OccResult } from "@fire_trident/core";
import { SimBase, holdChance, assumptionStream, type SimParams } from "./common.ts";
import type { Rng } from "./engine.ts";
import type { SimTask, TaskSource } from "./workloads.ts";

const CANDIDATE_CAP = 200;
const LANE_SCAN = 50;
const RATE_WINDOW_MS = 60_000;
const SIGMA_KEEP_MS = 10 * 60_000;
const SIGMA_TTL_MS = 1_000;
const READING_TTL_MS = 250;
const HEARTBEAT_MS = 45_000;
const RETRY = { idle: 5_000, closed: 3_000, declined: 1_500 };

/**
 * Extra repulsion on a candidate task, given the claim count on any path (other agents' claims;
 * the taking agent holds none). ColonyDO.take adds co-change repulsion this way. With `relative`,
 * only the part above the least repelled admitted candidate counts (lateral inhibition: it
 * reorders candidates but never makes the best one less acceptable).
 */
export type ExtraRepulsion = ((task: SimTask, claimOn: (path: string) => number) => number) & { relative?: boolean };

/** Model options beyond SimParams. */
export interface FireOptions {
  /**
   * Lateral inhibition at this claim value, passed to core chooseIntent (ColonyDO.take uses core
   * LATERAL_INHIBITION, half a fresh claim). Undefined leaves it off.
   */
  inhibitAt?: number;
  /**
   * How a candidate's per-file claims make its inhibition value: "sum" (as before; the default) or
   * "strongest" (the largest single file's, core directClaimOn). With every live claim fresh (1),
   * both inhibit the same candidates at a threshold of 1 or less.
   */
  inhibitBy?: ClaimCombine;
  /** Cap on the stimulus's age multiplier, passed to core chooseIntent (core AGE_FACTOR_CAP as deployed). Undefined leaves it uncapped. */
  ageCap?: number;
  /** Open intents considered per take, oldest first (ColonyDO's CANDIDATE_CAP, 200). For analysis. */
  window?: number;
  /**
   * ANALYSIS, not built: assumption revalidation. A proposal that is stale only through files it read
   * (see ReturnInfo, kind "read") lands anyway when its assumption on each of those files held through
   * every change since the agent read it, each change independently with probability `hold`.
   * Undefined leaves it off.
   */
  assumptions?: { hold: number };
  /** ANALYSIS: called for every returned proposal with what sent it back. It does not change the run. */
  onReturn?: (r: ReturnInfo) => void;
}

/**
 * Why a proposal went back. `kind` is "write" when a file it writes moved on trunk or another
 * proposal of the same commit writes it, "order" when it writes a file that a proposal ahead of it
 * in the same commit read (the group-commit screen returns that too), and otherwise "read": only
 * files it read moved, on trunk or by a write ahead of it in the same commit.
 */
export interface ReturnInfo {
  task: SimTask;
  at: number;
  /** Found by the lane tick, or by the trunk writer's re-validation. */
  where: "lane" | "trunk";
  kind: "read" | "write" | "order";
  /** Read paths that moved under it. */
  reads: string[];
  /** Written paths that moved under it, or that another proposal of the commit writes or read. */
  writes: string[];
}

/** The paths that make a proposal ineligible, by side. */
interface Conflict {
  reads: string[];
  writes: string[];
  /** Written paths that a proposal ahead of it in the same commit read. */
  order: string[];
}

/**
 * Split a proposal's conflicts: stale paths from validateProposal, plus (at the trunk writer) the
 * paths that proposals staged ahead of it in the same commit write or read.
 */
function conflictOf(p: Prop, stale: OccResult["stale"], writes: Set<string> | null, reads: Set<string> | null): Conflict {
  const own = new Set(p.writeSet.map((w) => w.path));
  const c: Conflict = { reads: [], writes: [], order: [] };
  for (const s of stale) (own.has(s.path) ? c.writes : c.reads).push(s.path);
  if (writes) {
    for (const w of p.writeSet) if (writes.has(w.path) && !c.writes.includes(w.path)) c.writes.push(w.path);
    for (const f of p.readSet) if (writes.has(f.path) && !c.reads.includes(f.path)) c.reads.push(f.path);
  }
  if (reads) for (const w of p.writeSet) if (reads.has(w.path)) c.order.push(w.path);
  return c;
}

/** The kind of return a conflict is (see ReturnInfo). */
function kindOf(c: Conflict): ReturnInfo["kind"] {
  return c.writes.length > 0 ? "write" : c.order.length > 0 ? "order" : "read";
}

interface Agent {
  id: number;
  thresholds: Record<string, number>;
  task: SimTask | null;
  claimedAt: number;
}

interface Prop {
  id: string;
  seq: number;
  task: SimTask;
  agent: Agent;
  writeSet: FileVersion[];
  readSet: FileVersion[];
  baseWrites: FileVersion[];
  submittedAt: number;
  attemptMs: number;
  lane: Region;
  /** Trunk commits before the claim: proposals with the same value share a base commit. */
  base: number;
  /** Assumption revalidation only: landings that had written each read path when it was read (aligned with readSet). */
  readVersions: number[] | null;
  /** Assumption revalidation only: it went past a changed read because its assumptions held. */
  kept: boolean;
}

interface EvalCache {
  version: number;
  at: number;
  /** Admitted candidates. */
  open: Array<Candidate & { task: SimTask }>;
  /** Admitted candidates that are not laterally inhibited (all of `open` when inhibition is off). */
  free: Array<Candidate & { task: SimTask }>;
  nextViableAt: number;
}

interface Region {
  name: string;
  holders: Map<number, number>;
  landTimes: number[];
  enqTimes: number[];
  lane: Prop[];
  ticking: boolean;
  lastTickAt: number;
  alarmAt: number | null;
  alarmGen: number;
  causes: CausalEvent[];
  sigmaCache: { at: number; sigma: number } | null;
  pathLanding: Map<string, Map<string, { id: string; at: number }>>;
  intentReturns: Map<number, string>;
}

/** Drop timestamps older than the window from the front of an ascending array. */
function prune(times: number[], since: number): number {
  let i = 0;
  while (i < times.length && times[i]! <= since) i++;
  if (i > 0) times.splice(0, i);
  return times.length;
}

/** FireTrident: as deployed, with group commit ("firetrident-group"), or with the serial trunk writer before it ("firetrident"). */
export class FireSim extends SimBase {
  private readonly group: boolean;
  private readonly initial: (path: string) => string | null;
  private readonly agents: Agent[] = [];
  private readonly regions = new Map<string, Region>();
  private readonly trunk = new Map<string, string>();
  private readonly claimCount = new Map<string, number>();
  private blobSeq = 0;
  private propSeq = 0;
  private landingSeq = 0;
  /** Version of everything take() depends on except time (open set, claims, landings). */
  private stateVersion = 0;
  private evalCache: EvalCache | null = null;
  private readingsAt = -Infinity;
  private candidateRegions: { version: number; n: number } = { version: -1, n: 0 };
  private readonly trunkQueue: Array<{ region: Region; batch: Prop[]; done: (res: { landed: Prop[]; returned: Prop[]; landingId: string | null; why: Map<Prop, Conflict> }) => void }> = [];
  private trunkBusy = false;
  /** Optional repulsion added to the claim overlap (co-change neighbors, see sim/cochange.ts). */
  private readonly extraRepulsion: ExtraRepulsion | null;
  private readonly claimOn = (path: string): number => this.claimCount.get(path) ?? 0;
  /** Lateral inhibition threshold passed to core chooseIntent (Infinity = off). */
  private readonly inhibitAt: number;
  private readonly inhibitBy: ClaimCombine;
  /** Cap on the stimulus's age multiplier (Infinity = uncapped). */
  private readonly ageCap: number;
  private readonly window: number;
  /** Assumption revalidation: the chance a assumption holds through one change (null = off), drawn from its own stream. */
  private readonly assumptionHold: number | null;
  private readonly assumptionRng: Rng | null;
  /** Assumption revalidation only: landings that wrote each path. */
  private readonly versions = new Map<string, number>();
  private readonly onReturn: ((r: ReturnInfo) => void) | null;
  /** Landings after warm-up that went past a changed read because their assumptions held. */
  keptLandings = 0;

  constructor(p: SimParams, source: TaskSource, initial: (path: string) => string | null, extraRepulsion?: ExtraRepulsion, opts: FireOptions = {}) {
    super(p, source);
    this.group = p.model === "firetrident-group";
    this.initial = initial;
    this.extraRepulsion = extraRepulsion ?? null;
    this.inhibitAt = opts.inhibitAt ?? Number.POSITIVE_INFINITY;
    this.inhibitBy = opts.inhibitBy ?? "sum";
    this.ageCap = opts.ageCap ?? Number.POSITIVE_INFINITY;
    this.window = opts.window !== undefined && opts.window >= 1 ? Math.floor(opts.window) : CANDIDATE_CAP;
    this.assumptionHold = opts.assumptions ? holdChance(opts.assumptions.hold) : null;
    this.assumptionRng = opts.assumptions ? assumptionStream(p.seed) : null;
    this.onReturn = opts.onReturn ?? null;
  }

  protected backlogAtEnd(): number {
    let n = 0;
    for (const r of this.regions.values()) n += r.lane.length;
    return n + this.trunkQueue.reduce((a, b) => a + b.batch.length, 0);
  }

  protected start(): void {
    for (let i = 0; i < this.p.agents; i++) {
      const a: Agent = { id: i, thresholds: {}, task: null, claimedAt: 0 };
      this.agents.push(a);
      const t0 = this.p.agents > 1 ? (i * this.p.rampMs) / this.p.agents : 0;
      this.q.at(t0, () => this.take(a));
    }
  }

  private region(name: string): Region {
    let r = this.regions.get(name);
    if (!r) {
      r = {
        name,
        holders: new Map(),
        landTimes: [],
        enqTimes: [],
        lane: [],
        ticking: false,
        lastTickAt: -Infinity,
        alarmAt: null,
        alarmGen: 0,
        causes: [],
        sigmaCache: null,
        pathLanding: new Map(),
        intentReturns: new Map(),
      };
      this.regions.set(name, r);
    }
    return r;
  }

  private blob(path: string): string | null {
    const v = this.trunk.get(path);
    return v !== undefined ? v : this.initial(path);
  }

  private landingsPerMin(r: Region, now: number): number {
    return prune(r.landTimes, now - RATE_WINDOW_MS);
  }

  // ---------------------------------------------------------------------------
  // Self-assignment (ColonyDO.takeFor)
  // ---------------------------------------------------------------------------

  private take(a: Agent): void {
    const now = this.q.now;
    this.m.msg(now, "take", 1, true);
    if (this.open.size === 0) {
      this.m.wait(now, "no open intents");
      this.q.after(this.p.timings.takeMs + this.rng.jitter(RETRY.idle), () => this.take(a));
      return;
    }
    this.countReadings(now);
    let ev = this.evalCache;
    if (ev === null || ev.version !== this.stateVersion || now - ev.at >= READING_TTL_MS) ev = this.evaluate(now);
    if (ev.open.length === 0) {
      this.m.wait(now, "admission closed in every candidate region");
      this.q.after(this.p.timings.takeMs + this.rng.jitter(RETRY.closed), () => this.take(a));
      return;
    }
    if (ev.free.length === 0) {
      // ColonyDO.takeFor: every admitted candidate is laterally inhibited; same hint as a closed region.
      this.m.wait(now, "every open intent's files are claimed by another agent");
      this.q.after(this.p.timings.takeMs + this.rng.jitter(RETRY.closed), () => this.take(a));
      return;
    }
    // Candidates whose stimulus is still 0 (repelled more than their age offsets) have p = 0 in
    // chooseIntent, and inhibited ones are skipped without a draw; leaving them out changes nothing
    // but the number of random draws.
    const viable = now < ev.nextViableAt ? [] : ev.free.filter((c) => stimulus(c.intent, now, c.repulsion, 1, this.ageCap) > 0);
    const pick = viable.length > 0 ? (chooseIntent(viable, a.thresholds, now, this.rng.fn(), undefined, this.inhibitAt, this.ageCap) as (Candidate & { task: SimTask }) | null) : null;
    if (!pick) {
      this.m.wait(now, "no intent accepted at this agent's thresholds");
      this.q.after(this.p.timings.takeMs + this.rng.jitter(RETRY.declined), () => this.take(a));
      return;
    }
    this.claim(a, pick.task, now);
  }

  /**
   * What takeFor computes for the top 200 open intents: repulsion from other agents' claims and
   * admission of every region they touch. Valid until the state changes (claims, landings, the
   * open set) or the field reading it stands for is older than the ColonyDO's 250 ms reading TTL.
   */
  private evaluate(now: number): EvalCache {
    const open: Array<Candidate & { task: SimTask }> = [];
    const openRegion = new Map<string, boolean>();
    const extras: number[] = [];
    for (const t of this.open.top(this.window)) {
      let rep = 0;
      let strongest = 0;
      for (const w of t.writes) {
        const n = this.claimCount.get(w) ?? 0;
        rep += n;
        if (n > strongest) strongest = n;
      }
      let ok = true;
      for (const rn of t.regions) {
        let o = openRegion.get(rn);
        if (o === undefined) {
          const r = this.regions.get(rn);
          o = r ? admissionOpen(r.holders.size, this.landingsPerMin(r, now)) : admissionOpen(0, 0);
          openRegion.set(rn, o);
        }
        if (!o) ok = false;
      }
      if (!ok) continue;
      if (this.extraRepulsion) extras.push(this.extraRepulsion(t, this.claimOn));
      // The direct claim is the soft overlap term itself (or its largest file's part): every live claim is a fresh one (1).
      open.push({ intent: t.intent, region: t.primary, repulsion: rep, directClaim: this.inhibitBy === "strongest" ? strongest : rep, admissionOpen: true, task: t });
    }
    if (this.extraRepulsion && open.length > 0) {
      const floor = this.extraRepulsion.relative ? Math.min(...extras) : 0;
      open.forEach((c, i) => (c.repulsion += extras[i]! - floor));
    }
    const free = this.inhibitAt === Number.POSITIVE_INFINITY ? open : open.filter((c) => !inhibited(c, this.inhibitAt));
    if (this.m.on(now) && this.inhibitAt !== Number.POSITIVE_INFINITY) {
      this.m.windowAdmitted += open.length;
      this.m.windowInhibited += open.length - free.length;
    }
    let nextViableAt = Number.POSITIVE_INFINITY;
    // stimulus = min(1 + ageMinutes / 10, cap) - repulsion is positive once age > 10 min * (repulsion - 1), and never
    // while repulsion >= cap (until the state changes).
    const cap = ageFactor(Number.POSITIVE_INFINITY, this.ageCap);
    for (const c of free) {
      const viableAt = c.repulsion < 1 ? Number.NEGATIVE_INFINITY : c.repulsion >= cap ? Number.POSITIVE_INFINITY : c.task.createdAt + 600_000 * (c.repulsion - 1);
      if (viableAt < nextViableAt) nextViableAt = viableAt;
    }
    const ev: EvalCache = { version: this.stateVersion, at: now, open, free, nextViableAt };
    this.evalCache = ev;
    return ev;
  }

  /** Field readings a take triggers: every candidate region once per reading TTL (shared by concurrent takes). */
  private countReadings(now: number): void {
    if (now - this.readingsAt < READING_TTL_MS) return;
    this.readingsAt = now;
    if (this.candidateRegions.version !== this.open.version) {
      const set = new Set<string>();
      for (const t of this.open.top(this.window)) for (const r of t.regions) set.add(r);
      this.candidateRegions = { version: this.open.version, n: set.size };
    }
    this.m.msg(now, "fieldReading", this.candidateRegions.n);
  }

  private claim(a: Agent, t: SimTask, now: number): void {
    this.open.remove(t);
    this.refill();
    t.status = "claimed";
    t.attempts++;
    if (t.firstClaimAt < 0) {
      t.firstClaimAt = now;
      if (this.m.on(now)) this.m.claimWait.push(now - t.createdAt);
    }
    a.task = t;
    a.claimedAt = now;
    for (const w of t.writes) this.claimCount.set(w, (this.claimCount.get(w) ?? 0) + 1);
    for (const rn of t.regions) {
      const r = this.region(rn);
      r.holders.set(a.id, (r.holders.get(a.id) ?? 0) + 1);
    }
    this.stateVersion++;
    this.m.msg(now, "poolLease", 1);
    this.m.msg(now, "claimDeposit", t.regions.length);
    // The agent reads at the lease base: trunk as of now.
    const readSet = t.reads.map((path) => ({ path, blob: this.blob(path) }));
    const readVersions = this.assumptionHold !== null ? t.reads.map((path) => this.versions.get(path) ?? 0) : null;
    const baseWrites = t.writes.map((path) => ({ path, blob: this.blob(path) }));
    const attemptMs = t.attempts === 1 ? t.workMs : t.workMs * this.p.rework;
    this.work(t, attemptMs, t.attempts > 1);
    const ready = now + this.p.timings.takeMs + attemptMs + this.p.timings.testMs;
    const base = this.landingSeq;
    this.q.at(ready, () => this.propose(a, t, readSet, baseWrites, attemptMs, base, readVersions));
  }

  private propose(a: Agent, t: SimTask, readSet: FileVersion[], baseWrites: FileVersion[], attemptMs: number, base: number, readVersions: number[] | null): void {
    const now = this.q.now;
    this.m.msg(now, "propose", 1, true);
    this.m.msg(now, "heartbeat", Math.floor((now - a.claimedAt) / HEARTBEAT_MS), true);
    const at = now + this.p.timings.proposeMs;
    this.q.at(at, () => {
      const id = `p${this.propSeq++}`;
      const writeSet = t.writes.map((path) => ({ path, blob: `b${this.blobSeq++}` }));
      const p: Prop = { id, seq: this.propSeq, task: t, agent: a, writeSet, readSet, baseWrites, submittedAt: this.q.now, attemptMs, lane: this.region(t.primary), base, readVersions, kept: false };
      t.status = "proposed";
      if (t.firstSubmitAt < 0) t.firstSubmitAt = this.q.now;
      if (this.m.on(this.q.now)) this.m.submitted++;
      this.m.msg(this.q.now, "enqueue", 1);
      this.enqueue(p);
    });
  }

  // ---------------------------------------------------------------------------
  // Lanes (RegionDO)
  // ---------------------------------------------------------------------------

  private sigma(r: Region, now: number): number {
    if (r.sigmaCache && now - r.sigmaCache.at < SIGMA_TTL_MS) return r.sigmaCache.sigma;
    let i = 0;
    while (i < r.causes.length && r.causes[i]!.at < now - SIGMA_KEEP_MS) i++;
    if (i > 0) r.causes.splice(0, i);
    // RegionDO.cascadeSigma through core branchingRatio: a return is never a parent, so it is
    // passed with an infinite time (outside every parent window) and still counts as a child.
    const events = r.causes.map((e) => (e.id.startsWith("ret:") ? { ...e, at: Number.POSITIVE_INFINITY } : e));
    const sigma = branchingRatio(events, now);
    r.sigmaCache = { at: now, sigma };
    if (sigma > this.m.sigmaMax && this.m.on(now)) this.m.sigmaMax = sigma;
    return sigma;
  }

  private delayMs(r: Region, now: number): number {
    const flux = prune(r.enqTimes, now - RATE_WINDOW_MS);
    return Math.round(laneIntervalMs(flux) * inhibitionFactor(this.sigma(r, now)));
  }

  private setAlarm(r: Region, at: number): void {
    r.alarmAt = at;
    const gen = ++r.alarmGen;
    this.q.at(at, () => {
      if (gen !== r.alarmGen) return;
      r.alarmAt = null;
      this.tick(r);
    });
  }

  private enqueue(p: Prop): void {
    const r = p.lane;
    const now = this.q.now;
    const wasEmpty = r.lane.length === 0;
    r.lane.push(p);
    r.enqTimes.push(now);
    if (r.ticking) return;
    const want = Math.max(now, r.lastTickAt + this.delayMs(r, now));
    if (r.alarmAt === null || r.alarmAt > want || (wasEmpty && r.alarmAt !== want)) this.setAlarm(r, want);
  }

  private tick(r: Region): void {
    if (r.ticking || r.lane.length === 0) return;
    const now = this.q.now;
    r.ticking = true;
    r.lastTickAt = now;
    if (this.m.on(now)) {
      this.m.ticks++;
      if (inhibitionFactor(this.sigma(r, now)) > 1) this.m.inhibitedTicks++;
    }
    const rows = r.lane.slice(0, LANE_SCAN);
    // blobsFor, plus one baseBlobs call per distinct base commit.
    this.m.msg(now, "laneRpc", 1 + new Set(rows.map((p) => p.base)).size);
    this.q.after(this.p.timings.laneOverheadMs, () => {
      const valid: Prop[] = [];
      const stale: Array<{ p: Prop; occ: ReturnType<typeof validateProposal> }> = [];
      for (const p of rows) {
        const occ = validateProposal(p, (path) => this.blob(path), p.baseWrites);
        if (occ.eligible || (this.assumptionHold !== null && this.keeps(p, conflictOf(p, occ.stale, null, null), null))) valid.push(p);
        else stale.push({ p, occ });
      }
      const { batch } = selectBatch(valid, LANE_SCAN);
      if (batch.length === 0) {
        this.finishTick(r, null, [], stale, []);
        return;
      }
      this.m.msg(this.q.now, "laneRpc", 2); // landContext + land
      this.trunkQueue.push({ region: r, batch, done: (res) => this.finishTick(r, res.landingId, res.landed, stale, res.returned, res.why) });
      this.serveTrunk();
    });
  }

  /**
   * Assumption revalidation (analysis, see FireOptions.assumptions): true when the proposal is stale only
   * through files it read and its assumption on each held through every change since the read. One
   * draw per change: each landing that wrote the file on trunk since the read, plus one for a write
   * to it ahead of the proposal in the same commit (`inCommit`). A kept proposal's reads are
   * refreshed to trunk, so a later check sees only newer changes.
   */
  private keeps(p: Prop, c: Conflict, inCommit: Set<string> | null): boolean {
    const hold = this.assumptionHold;
    if (hold === null || kindOf(c) !== "read" || c.reads.length === 0) return false;
    const changed = new Set(c.reads);
    const versions = p.readVersions ?? [];
    for (let i = 0; i < p.readSet.length; i++) {
      const path = p.readSet[i]!.path;
      if (!changed.has(path)) continue;
      const onTrunk = (this.versions.get(path) ?? 0) - (versions[i] ?? 0);
      const changes = Math.max(1, onTrunk + (inCommit?.has(path) ? 1 : 0));
      for (let k = 0; k < changes; k++) if (this.assumptionRng!.next() >= hold) return false;
    }
    p.readSet = p.readSet.map((f) => ({ path: f.path, blob: this.blob(f.path) }));
    p.readVersions = p.readSet.map((f) => this.versions.get(f.path) ?? 0);
    p.kept = true;
    return true;
  }

  // ---------------------------------------------------------------------------
  // The trunk writer (TrunkDO serial chain)
  // ---------------------------------------------------------------------------

  private serveTrunk(): void {
    if (this.trunkBusy || this.trunkQueue.length === 0) return;
    this.trunkBusy = true;
    const jobs = this.group ? this.trunkQueue.splice(0, this.trunkQueue.length) : [this.trunkQueue.shift()!];
    // Screen in order against current trunk, as TrunkDO.screen does (also across folded batches).
    const writes = new Set<string>();
    const reads = new Set<string>();
    const staged: Prop[] = [];
    const returned = new Map<Region, Prop[]>();
    const why = new Map<Prop, Conflict>();
    const classify = this.assumptionHold !== null || this.onReturn !== null;
    let n = 0;
    for (const job of jobs) {
      for (const p of job.batch) {
        n++;
        const occ = validateProposal(p, (path) => this.blob(path), p.baseWrites);
        const clash = p.writeSet.some((w) => writes.has(w.path) || reads.has(w.path)) || p.readSet.some((f) => writes.has(f.path));
        if (!occ.eligible || clash) {
          const c = classify ? conflictOf(p, occ.stale, writes, reads) : null;
          if (!c || !this.keeps(p, c, writes)) {
            const list = returned.get(job.region) ?? [];
            list.push(p);
            returned.set(job.region, list);
            if (c) why.set(p, c);
            continue;
          }
        }
        staged.push(p);
        for (const w of p.writeSet) writes.add(w.path);
        for (const f of p.readSet) reads.add(f.path);
      }
    }
    const t = this.p.timings;
    const service = staged.length > 0 ? t.commitBaseMs + t.commitPerProposalMs * n : t.commitPerProposalMs * n;
    this.q.after(service, () => {
      const now = this.q.now;
      if (this.m.on(now)) this.m.trunkBusyMs += Math.min(service, now - this.p.warmupMs);
      let landingId: string | null = null;
      if (staged.length > 0) {
        landingId = `L${this.landingSeq++}`;
        for (const p of staged) for (const w of p.writeSet) this.trunk.set(w.path, w.blob!);
        if (this.assumptionHold !== null) for (const p of staged) for (const w of p.writeSet) this.versions.set(w.path, (this.versions.get(w.path) ?? 0) + 1);
        const touched = new Set<string>();
        for (const p of staged) for (const rn of p.task.writeRegions) touched.add(rn);
        for (const rn of touched) this.region(rn).landTimes.push(now);
        this.m.msg(now, "landingApply", touched.size);
        if (this.m.on(now)) {
          this.m.commits++;
          this.m.batch.push(staged.length);
        }
        this.stateVersion++;
      }
      this.trunkBusy = false;
      for (const job of jobs) {
        const mine = new Set(job.batch);
        job.done({ landed: staged.filter((p) => mine.has(p)), returned: returned.get(job.region) ?? [], landingId: staged.some((p) => mine.has(p)) ? landingId : null, why });
      }
      this.serveTrunk();
    });
  }

  // ---------------------------------------------------------------------------
  // Tick bookkeeping (RegionDO.tick steps 4-5, recordLanding, recordReturn) and colony effects
  // ---------------------------------------------------------------------------

  private finishTick(r: Region, landingId: string | null, landed: Prop[], stale: Array<{ p: Prop; occ: ReturnType<typeof validateProposal> }>, trunkReturned: Prop[], why?: Map<Prop, Conflict>): void {
    const now = this.q.now;
    const remove = new Set<Prop>();
    if (landingId !== null && landed.length > 0) {
      for (const p of landed) {
        const eventId = `land:${landingId}:${p.id}`;
        const prior = r.intentReturns.get(p.task.id);
        r.intentReturns.delete(p.task.id);
        r.causes.push(prior !== undefined ? { id: eventId, causeId: prior, at: now } : { id: eventId, at: now });
        for (const w of p.writeSet) {
          let m = r.pathLanding.get(w.path);
          if (!m) {
            m = new Map();
            r.pathLanding.set(w.path, m);
          }
          m.set(w.blob!, { id: eventId, at: now });
        }
        remove.add(p);
        this.landedEffects(p, now);
      }
      this.m.msg(now, "laneRpc", 1); // report landing
    }
    let updates = 0;
    for (const { p, occ } of stale) {
      let cause: string | undefined;
      for (const s of occ.stale) {
        const hit = r.pathLanding.get(s.path)?.get(s.actual ?? "");
        if (hit) {
          cause = hit.id;
          break;
        }
      }
      this.recordReturn(r, p, cause, now);
      remove.add(p);
      updates++;
      this.returnedEffects(p, now, occ.stale.some((s) => p.writeSet.some((w) => w.path === s.path)));
      if (this.onReturn) this.report(p, "lane", conflictOf(p, occ.stale, null, null), now);
    }
    for (const p of trunkReturned) {
      let cause: string | undefined;
      let best = -Infinity;
      for (const w of p.writeSet) {
        const m = r.pathLanding.get(w.path);
        if (!m) continue;
        for (const v of m.values()) if (v.at > now - RATE_WINDOW_MS && v.at > best) {
          best = v.at;
          cause = v.id;
        }
      }
      this.recordReturn(r, p, cause, now);
      remove.add(p);
      updates++;
      // Counted as write-write here whatever the cause (the existing metric); onReturn gets the real split.
      this.returnedEffects(p, now, true);
      const c = why?.get(p);
      if (this.onReturn && c) this.report(p, "trunk", c, now);
    }
    if (updates > 0) this.m.msg(now, "laneRpc", 1); // report updates
    if (remove.size > 0) r.lane = r.lane.filter((p) => !remove.has(p));
    r.sigmaCache = null;
    r.ticking = false;
    if (r.lane.length > 0) this.setAlarm(r, Math.max(now, r.lastTickAt + this.delayMs(r, now)));
  }

  private recordReturn(r: Region, p: Prop, cause: string | undefined, now: number): void {
    const eventId = `ret:${p.id}`;
    r.causes.push(cause !== undefined ? { id: eventId, causeId: cause, at: now } : { id: eventId, at: now });
    r.intentReturns.set(p.task.id, eventId);
  }

  /** Hand a return to the onReturn hook (analysis only). */
  private report(p: Prop, where: ReturnInfo["where"], c: Conflict, now: number): void {
    this.onReturn?.({ task: p.task, at: now, where, kind: kindOf(c), reads: c.reads, writes: [...c.writes, ...c.order] });
  }

  private release(p: Prop): void {
    const a = p.agent;
    for (const w of p.task.writes) {
      const n = (this.claimCount.get(w) ?? 1) - 1;
      if (n <= 0) this.claimCount.delete(w);
      else this.claimCount.set(w, n);
    }
    for (const rn of p.task.regions) {
      const r = this.region(rn);
      const n = (r.holders.get(a.id) ?? 1) - 1;
      if (n <= 0) r.holders.delete(a.id);
      else r.holders.set(a.id, n);
    }
    this.stateVersion++;
  }

  private landedEffects(p: Prop, now: number): void {
    const t = p.task;
    t.status = "landed";
    this.release(p);
    p.agent.thresholds = reinforceThreshold(p.agent.thresholds, p.lane.name);
    this.m.msg(now, "release", 1);
    if (this.m.on(now)) {
      this.m.landed++;
      this.m.ttl.push(now - t.firstSubmitAt);
      this.m.e2e.push(now - t.firstClaimAt);
      if (p.kept) this.keptLandings++;
    }
    this.agentLearns(p, now);
  }

  private returnedEffects(p: Prop, now: number, writeWrite: boolean): void {
    this.release(p);
    this.open.add(p.task);
    this.stateVersion++;
    this.m.msg(now, "returnApply", p.task.regions.length);
    this.m.msg(now, "release", 1);
    if (this.m.on(now)) {
      this.m.invalidated++;
      if (writeWrite) this.m.invalidatedWriteWrite++;
      this.m.wastedMs += p.attemptMs;
    }
    this.agentLearns(p, now);
  }

  private agentLearns(p: Prop, outcomeAt: number): void {
    const a = p.agent;
    const at = this.learnAt(p.submittedAt, outcomeAt);
    this.m.msg(outcomeAt, "heartbeat", Math.floor((at - p.submittedAt) / HEARTBEAT_MS), true);
    a.task = null;
    this.q.at(at, () => this.take(a));
  }
}

