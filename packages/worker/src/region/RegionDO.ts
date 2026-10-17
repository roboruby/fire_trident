import { DurableObject } from "cloudflare:workers";
import {
  LATERAL_INHIBITION,
  admissionOpen,
  aggregate,
  inhibitionFactor,
  isExpired,
  markValue,
  regionKey,
  regionOf,
  revalidationCandidate,
  revalidationEnabled,
  selectBatch,
  textMergeCandidate,
  validateProposal,
} from "@fire_trident/core";
import type { CausalEvent, ColonyEvent, FieldReading, FileVersion, Id, Landing, Mark, MarkKind, OccResult, Path, Proposal, Sha } from "@fire_trident/core";
import type { Env } from "../env.ts";
import { errorText } from "../colony/errors.ts";
import { coalesceEvents } from "../colony/events.ts";
import { isRedirect, splitByDirection } from "../colony/direction.ts";
import { isProtectStop, splitByProtection } from "../colony/protect.ts";
import { LANE_PAUSE_RECHECK_MS, laneHold, pausedIn } from "../colony/pause.ts";
import type { ClearFilter, FieldOps } from "../colony/logic.ts";
import { settleLane, suspects } from "../trunk/outcome.ts";
import { textMergeEnabled, type LandResult } from "../trunk/plan.ts";
import { isMergeHold } from "../trunk/mergelock.ts";
import {
  accumulates,
  admissionBar,
  chunks,
  foldDeposit,
  laneDelayMs,
  mergeKey,
  nextTickAt,
  proposalPaths,
  stalePaths,
  staleReason,
  validDeposit,
  writePathsByBase,
} from "./logic.ts";

/** Field operation shapes shared with the ColonyDO. */
export type { ClearFilter, FieldOps };

/** Options for RegionDO.reading. With none, the reading covers the whole region. */
export interface ReadingOptions {
  /** Leave this agent's claims out of byPath, agents and admission (self-assignment). */
  excludeAgentId?: Id;
  /** Report byPath only for marks overlapping these paths (keeps payloads small). */
  paths?: Path[];
  /** Include the agents list (default true). */
  agents?: boolean;
  /**
   * Report byPath only for these mark kinds, over the whole region (self-assignment asks for
   * claim and danger: a small reading that every concurrent take can share, whatever paths it needs).
   * `paths` still narrows it when given.
   */
  kinds?: MarkKind[];
  /** Give each agent of the agents list `at`: when it last made or renewed a claim here (impact reads, colony/impact.ts). */
  claimTimes?: boolean;
}

/** Lane and field counters for dashboards and tests. */
export interface RegionStatus {
  colonyId: Id | null;
  region: string | null;
  lane: number;
  marks: number;
  fluxPerMin: number;
  landingsPerMin: number;
  sigma: number;
  nextTickAt: number | null;
}

/** Proposals examined per lane tick. */
const LANE_SCAN = 50;
/** TrunkDO.land failures before a proposal is returned to its agent. */
const MAX_LAND_ATTEMPTS = 5;
/** Window for flux (enqueues/min) and landings/min. */
const RATE_WINDOW_MS = 60_000;
/** Branching-ratio window and settle time (the core defaults) and how long cause events are kept. */
const SIGMA_WINDOW_MS = 60_000;
const SIGMA_SETTLE_MS = 5_000;
const SIGMA_KEEP_MS = 10 * 60_000;
/** With an empty lane, sigma is re-evaluated and re-sent this often while a cascade settles or inhibits. */
const SIGMA_WATCH_MS = 2_000;
const LOG_KEEP_MS = 15 * 60_000;
const PATH_LANDING_KEEP_MS = 60 * 60_000;
const GC_EVERY_MS = 10_000;
/** Cache lifetimes for the full-region aggregate (exact readings / totals only) and sigma. */
const EXACT_TTL_MS = 250;
const TOTALS_TTL_MS = 1_000;
const SIGMA_TTL_MS = 1_000;
/**
 * Mark/sigma events are batched and sent to the ColonyDO at most this often. The colony answers
 * each emit with the interval it wants (longer when many regions emit at once), within these bounds.
 */
const EMIT_EVERY_MS = 100;
const EMIT_MAX_MS = 5_000;
/** After the ColonyDO reports no listeners, stop sending field events for this long. */
const QUIET_MS = 5_000;
const MAX_OUTBOX = 20_000;
/** Max items bound into one json_each() parameter. */
const JSON_CHUNK = 500;
/** Undelivered colony reports are retried this often, at most this many times. */
const REPORT_RETRY_MS = 5_000;
const MAX_REPORT_ATTEMPTS = 50;
/**
 * A stale return whose cause landed in another lane is resolved this long after the tick (the
 * landing's fan-out to the regions it changed may still be on its way), at most this many times.
 */
const CAUSE_RESOLVE_MS = 1_500;
const MAX_CAUSE_ATTEMPTS = 3;
/** Pending causes resolved per pass. */
const CAUSE_BATCH = 200;

/** What a lane tick tells the ColonyDO. */
type LaneReport = { kind: "landing"; landing: Landing } | { kind: "updates"; updates: Array<{ id: Id; patch: Partial<Proposal>; stale?: OccResult["stale"] }> };

const UPSERT_MARK =
  "INSERT INTO marks (mkey, kind, path, strength, at, agent_id, intent_id, pattern) VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
  "ON CONFLICT(mkey) DO UPDATE SET strength = excluded.strength, at = excluded.at, agent_id = excluded.agent_id, intent_id = excluded.intent_id";

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)",
  `CREATE TABLE IF NOT EXISTS marks (
    mkey TEXT PRIMARY KEY, kind TEXT NOT NULL, path TEXT NOT NULL, strength REAL NOT NULL, at INTEGER NOT NULL,
    agent_id TEXT, intent_id TEXT, pattern INTEGER NOT NULL DEFAULT 0)`,
  "CREATE INDEX IF NOT EXISTS marks_path ON marks(path)",
  "CREATE INDEX IF NOT EXISTS marks_kind ON marks(kind)",
  "CREATE INDEX IF NOT EXISTS marks_agent ON marks(agent_id)",
  "CREATE INDEX IF NOT EXISTS marks_intent ON marks(intent_id)",
  "CREATE INDEX IF NOT EXISTS marks_pattern ON marks(pattern) WHERE pattern = 1",
  `CREATE TABLE IF NOT EXISTS lane (
    id TEXT PRIMARY KEY, priority REAL NOT NULL, created_at INTEGER NOT NULL, enqueued_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL)`,
  "CREATE INDEX IF NOT EXISTS lane_order ON lane(priority DESC, created_at)",
  "CREATE TABLE IF NOT EXISTS log (id TEXT PRIMARY KEY, kind TEXT NOT NULL, at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS log_kind_at ON log(kind, at)",
  "CREATE TABLE IF NOT EXISTS causes (id TEXT PRIMARY KEY, cause_id TEXT, at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS causes_at ON causes(at)",
  `CREATE TABLE IF NOT EXISTS path_landing (
    path TEXT NOT NULL, blob TEXT NOT NULL, event_id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (path, blob))`,
  "CREATE INDEX IF NOT EXISTS path_landing_path ON path_landing(path, at)",
  "CREATE TABLE IF NOT EXISTS intent_returns (intent_id TEXT PRIMARY KEY, event_id TEXT NOT NULL, at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY, at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL)",
  // The last landing that changed each of this region's paths, whichever lane landed it (fed by the colony's landing fan-out).
  "CREATE TABLE IF NOT EXISTS landed_paths (path TEXT PRIMARY KEY, landing_id TEXT NOT NULL, at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS landed_paths_at ON landed_paths(at)",
  // Stale returns whose cause is a landing this region has not heard of yet (resolved shortly after, see resolveCauses).
  "CREATE TABLE IF NOT EXISTS pending_causes (id TEXT PRIMARY KEY, paths TEXT NOT NULL, at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0)",
];

type MarkRow = {
  mkey: string;
  kind: string;
  path: string;
  strength: number;
  at: number;
  agent_id: string | null;
  intent_id: string | null;
};

const MARK_COLUMNS = "mkey, kind, path, strength, at, agent_id, intent_id";

function toMark(r: MarkRow): Mark {
  const m: Mark = { id: r.mkey, kind: r.kind as MarkKind, path: r.path, strength: r.strength, at: r.at };
  if (r.agent_id !== null) m.agentId = r.agent_id;
  if (r.intent_id !== null) m.intentId = r.intent_id;
  return m;
}

/** A path that is a directory prefix or a glob (it can overlap many concrete paths). */
function isPattern(path: Path): boolean {
  return path.endsWith("/") || /[*?{]/.test(path);
}

function touch(touched: Map<Path, Set<MarkKind>>, path: Path, kind: MarkKind): void {
  const kinds = touched.get(path);
  if (kinds) kinds.add(kind);
  else touched.set(path, new Set([kind]));
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/** Cause-event ids of stale returns (see recordReturn). */
const RETURN_EVENT = "ret:";

/**
 * Branching ratio of the lane's causal graph: children per parent, with parents
 * in [now - windowMs, now - settleMs] (both inclusive) and children at any time,
 * as in core `branchingRatio`, except that returns are never parents. A returned
 * proposal changed nothing on trunk, so it cannot make anything stale; counting
 * returns as parents would pin a burst of N returns from one landing at
 * N / (N + 1) and hide every cascade. Sigma is therefore the stale returns caused
 * per landed proposal: above 1, each landing invalidates more in-flight work
 * than it delivers.
 */
export function cascadeSigma(events: CausalEvent[], now: number, windowMs = SIGMA_WINDOW_MS, settleMs = SIGMA_SETTLE_MS): number {
  const from = now - windowMs;
  const to = now - settleMs;
  const parents = new Set<string>();
  for (const e of events) if (e.at >= from && e.at <= to && !e.id.startsWith(RETURN_EVENT)) parents.add(e.id);
  if (parents.size === 0) return 0;
  let children = 0;
  for (const e of events) if (e.causeId !== undefined && parents.has(e.causeId)) children++;
  return children / parents.size;
}

/**
 * One region of a colony: its stigmergic field (decaying marks) and its
 * integration lane. Named `${colonyId}:${region}`.
 */
export class RegionDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private colonyId: Id | null = null;
  private region: string | null = null;
  /** Bumped on every field write; exact readings reuse the aggregate only at the same version. */
  private version = 0;
  private agg: { at: number; version: number } & Pick<FieldReading, "totals" | "byPath"> | null = null;
  private sigmaCache: { at: number; sigma: number } | null = null;
  private lastGc = 0;
  /** Tells apart enqueues of one proposal in the same millisecond, so each counts toward the flux. */
  private enqSeq = 0;
  private lastTickAt = 0;
  private ticking = false;
  private outbox: ColonyEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private quietUntil = 0;
  /** Last inhibition factor sent to the colony (so the return to 1 is sent once). */
  private sentInhibition = 1;
  /** The colony's region depth (from configure), null until known. */
  private depth: number | null = null;
  private causeTimer: ReturnType<typeof setTimeout> | null = null;
  private resolvingCauses = false;
  /** Current batching interval of events to the colony (the colony sets it in its emit answer). */
  private emitEveryMs = EMIT_EVERY_MS;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    for (const stmt of SCHEMA) this.sql.exec(stmt);
    for (const row of this.sql.exec<{ k: string; v: string }>("SELECT k, v FROM meta")) {
      if (row.k === "colonyId") this.colonyId = row.v;
      else if (row.k === "region") this.region = row.v;
      else if (row.k === "regionDepth") this.depth = Number(row.v) || null;
    }
    if (this.colonyId === null) this.adoptName();
  }

  // -------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------

  /**
   * Bind this object to its colony and region (idempotent). `regionDepth` (the colony's) lets
   * the region find which region owns a path, to name causes that landed elsewhere.
   */
  async configure(p: { colonyId: Id; region: string; regionDepth?: number }): Promise<void> {
    const upsert = "INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v";
    this.sql.exec(upsert, "colonyId", p.colonyId);
    this.sql.exec(upsert, "region", p.region);
    this.colonyId = p.colonyId;
    this.region = p.region;
    if (typeof p.regionDepth === "number" && Number.isInteger(p.regionDepth) && p.regionDepth >= 1) {
      this.sql.exec(upsert, "regionDepth", String(p.regionDepth));
      this.depth = p.regionDepth;
    }
  }

  /** Fall back to the object name (`colonyId:region`) when configure() has not run yet. */
  private adoptName(): void {
    const name = this.ctx.id.name;
    if (!name) return;
    const i = name.indexOf(":");
    if (i <= 0) return;
    this.colonyId = name.slice(0, i);
    this.region = name.slice(i + 1);
  }

  // -------------------------------------------------------------------------
  // Field
  // -------------------------------------------------------------------------

  /** Deposit marks (claims and needs refresh in place; trail, failure and danger accumulate). */
  async deposit(marks: Array<Omit<Mark, "id">>): Promise<void> {
    this.applyOps({ deposit: marks });
  }

  /** Remove marks matching the filter; returns how many were removed. An empty filter removes nothing. */
  async clear(filter: ClearFilter): Promise<number> {
    return this.applyOps({ clear: [filter] }).cleared;
  }

  /** Several clears and deposits in one call (clears first). Used by the ColonyDO to batch field work. */
  async apply(ops: FieldOps): Promise<{ cleared: number; deposited: number }> {
    return this.applyOps(ops);
  }

  /** Current field reading for this region. See ReadingOptions. */
  async reading(opts: ReadingOptions = {}): Promise<FieldReading> {
    const now = Date.now();
    this.maybeGc(now);
    const exclude = opts.excludeAgentId;
    const kinds = Array.isArray(opts.kinds) ? opts.kinds.filter((k) => typeof k === "string") : null;
    let totals: FieldReading["totals"];
    let byPath: FieldReading["byPath"];
    if (kinds !== null) {
      totals = this.fullAggregate(now, false).totals;
      const keep = new Set<string>(kinds);
      const marks = opts.paths !== undefined ? this.marksOverlapping(opts.paths, now, exclude).filter((m) => keep.has(m.kind)) : this.marksOfKinds(kinds, now, exclude);
      byPath = aggregate(marks, now).byPath;
    } else if (opts.paths !== undefined) {
      totals = this.fullAggregate(now, false).totals;
      byPath = aggregate(this.marksOverlapping(opts.paths, now, exclude), now).byPath;
    } else if (exclude !== undefined) {
      const agg = aggregate(
        this.liveMarks(now).filter((m) => !(m.kind === "claim" && m.agentId === exclude)),
        now,
      );
      totals = agg.totals;
      byPath = agg.byPath;
    } else {
      const agg = this.fullAggregate(now, true);
      totals = agg.totals;
      byPath = agg.byPath;
    }
    const holders = this.claimHolders(now, exclude);
    const landingsPerMin = this.count("land", now - RATE_WINDOW_MS);
    const activeAgents = this.counted(holders);
    const agents: FieldReading["agents"] = [];
    if (opts.agents !== false) {
      for (const [agentId, h] of holders) {
        agents.push(h.intentId !== undefined ? { agentId, intentId: h.intentId, paths: [...h.paths] } : { agentId, paths: [...h.paths] });
        // Impact reads ask how fresh each holder's claims are (the newest claim it made or renewed here).
        if (opts.claimTimes === true) agents[agents.length - 1]!.at = h.at;
      }
    }
    return {
      region: this.region ?? "",
      at: now,
      totals,
      byPath,
      agents,
      sigma: this.sigma(now),
      admission: { open: admissionOpen(activeAgents, landingsPerMin), landingsPerMin, activeAgents },
    };
  }

  /**
   * Harvester-ant admission, decided here and atomically: admit an agent into this region and
   * deposit its claim marks in the same synchronous step, so concurrent takes (from any number
   * of callers, with any stale view of the field) can never push the region past its cap. An
   * agent already holding a live claim here is inside and always admitted. A refusal deposits
   * nothing. `activeAgents` counts the agents holding claims after the decision. Only claims at
   * or above the admission bar (see admissionBar) count, here and in readings: a claim that has
   * mostly decayed belongs to an agent that stopped, and must not keep the region closed.
   */
  async admit(p: { agentId: Id; intentId: Id; paths: Path[]; strength?: number }): Promise<{ admitted: boolean; activeAgents: number; landingsPerMin: number }> {
    const now = Date.now();
    this.maybeGc(now);
    const others = this.counted(this.claimHolders(now, p.agentId));
    const inside = this.holdsClaim(p.agentId, now);
    const landingsPerMin = this.count("land", now - RATE_WINDOW_MS);
    const admitted = inside || admissionOpen(others, landingsPerMin);
    if (admitted) {
      const strength = typeof p.strength === "number" && Number.isFinite(p.strength) && p.strength > 0 ? p.strength : 1;
      this.applyOps({ deposit: p.paths.map((path) => ({ kind: "claim" as const, path, strength, at: now, agentId: p.agentId, intentId: p.intentId })) });
    }
    return { admitted, activeAgents: others + (admitted || inside ? 1 : 0), landingsPerMin };
  }

  /**
   * Remove every claim mark these agents hold here, whatever intent it was for (agents stopped,
   * retired or reaped). One call per region however many agents, so stopping a swarm frees
   * admission and lateral inhibition at once. Returns how many claims were removed.
   */
  async clearClaims(agentIds: Id[]): Promise<number> {
    const ids = Array.isArray(agentIds) ? [...new Set(agentIds.filter((x): x is Id => typeof x === "string" && x !== ""))] : [];
    if (ids.length === 0) return 0;
    const now = Date.now();
    const touched = new Map<Path, Set<MarkKind>>();
    let removed = 0;
    for (const part of chunks(ids, JSON_CHUNK)) {
      const rows = this.sql
        .exec<{ path: string }>("DELETE FROM marks WHERE kind = 'claim' AND agent_id IN (SELECT value FROM json_each(?)) RETURNING path", JSON.stringify(part))
        .toArray();
      for (const r of rows) touch(touched, r.path, "claim");
      removed += rows.length;
    }
    if (removed > 0) {
      this.version++;
      this.queueMarkEvents(touched, now);
    }
    return removed;
  }

  /**
   * Heartbeat for claims: re-date this agent's existing claim marks here (only those of
   * `intentIds` when given) to now. A claim that was cleared (its proposal landed or came back,
   * or the agent was stopped) is never re-created, so a heartbeat that races a landing cannot
   * leave an orphan claim behind. Agents call it directly; the colony does not need to relay
   * claim refreshes. Returns how many claims were refreshed.
   */
  async refreshClaims(p: { agentId: Id; intentIds?: Id[] }): Promise<number> {
    const agentId = typeof p?.agentId === "string" ? p.agentId : "";
    if (!agentId) return 0;
    const now = Date.now();
    this.maybeGc(now);
    const touched = new Map<Path, Set<MarkKind>>();
    const rows: Array<{ path: string }> = [];
    if (Array.isArray(p.intentIds)) {
      const ids = [...new Set(p.intentIds.filter((x): x is Id => typeof x === "string" && x !== ""))];
      for (const part of chunks(ids, JSON_CHUNK)) {
        rows.push(
          ...this.sql
            .exec<{ path: string }>(
              "UPDATE marks SET at = ? WHERE kind = 'claim' AND agent_id = ? AND intent_id IN (SELECT value FROM json_each(?)) RETURNING path",
              now,
              agentId,
              JSON.stringify(part),
            )
            .toArray(),
        );
      }
    } else {
      rows.push(...this.sql.exec<{ path: string }>("UPDATE marks SET at = ? WHERE kind = 'claim' AND agent_id = ? RETURNING path", now, agentId).toArray());
    }
    for (const r of rows) touch(touched, r.path, "claim");
    if (rows.length > 0) {
      this.version++;
      this.queueMarkEvents(touched, now);
    }
    return rows.length;
  }

  /**
   * The last landing that changed each of these paths of this region, as the colony's landing
   * fan-out reported it. Another region asks when one of its stale returns read a path here.
   */
  async landedFor(paths: Path[]): Promise<Array<{ path: Path; landingId: Id; at: number }>> {
    const out: Array<{ path: Path; landingId: Id; at: number }> = [];
    const wanted = Array.isArray(paths) ? [...new Set(paths.filter((p) => typeof p === "string"))] : [];
    for (const part of chunks(wanted, JSON_CHUNK)) {
      for (const r of this.sql.exec<{ path: string; landing_id: string; at: number }>(
        "SELECT path, landing_id, at FROM landed_paths WHERE path IN (SELECT value FROM json_each(?))",
        JSON.stringify(part),
      )) {
        out.push({ path: r.path, landingId: r.landing_id, at: r.at });
      }
    }
    return out;
  }

  /** Record a causal event for the criticality governor (sigma). */
  async recordCause(e: { id: string; causeId?: string; at: number }): Promise<void> {
    this.sql.exec(
      "INSERT OR IGNORE INTO causes (id, cause_id, at) VALUES (?, ?, ?)",
      e.id,
      e.causeId ?? null,
      Number.isFinite(e.at) ? e.at : Date.now(),
    );
    this.sigmaCache = null;
  }

  // -------------------------------------------------------------------------
  // Lane
  // -------------------------------------------------------------------------

  /** Queue a ready proposal in this region's lane (re-enqueue replaces). Priority comes from its intent. */
  async enqueue(p: Proposal, priority = 1): Promise<void> {
    const now = Date.now();
    const wasEmpty = this.laneSize() === 0;
    this.sql.exec(
      `INSERT INTO lane (id, priority, created_at, enqueued_at, attempts, data) VALUES (?, ?, ?, ?, 0, ?)
       ON CONFLICT(id) DO UPDATE SET priority = excluded.priority, enqueued_at = excluded.enqueued_at, attempts = 0, data = excluded.data`,
      p.id,
      Number.isFinite(priority) ? priority : 1,
      Number.isFinite(p.createdAt) ? p.createdAt : now,
      now,
      JSON.stringify(p),
    );
    this.log(`enq:${p.id}:${now}:${++this.enqSeq}`, "enq", now);
    await this.ensureAlarm(now, wasEmpty);
  }

  /**
   * Merge locks (trunk/mergelock.ts): a person approved a change already waiting in this lane, so its copy here carries
   * the approval (`approvedAt`) to the trunk writer. A change not in the lane is left alone. Returns whether it was there.
   */
  async stampApproval(id: Id, at: number): Promise<boolean> {
    if (typeof id !== "string" || typeof at !== "number" || !Number.isFinite(at)) return false;
    return this.sql.exec("UPDATE lane SET data = json_set(data, '$.approvedAt', ?) WHERE id = ? RETURNING id", at, id).toArray().length > 0;
  }

  /** Drop proposals from the lane (rejected or returned elsewhere). Returns how many were queued. */
  async dequeue(ids: Id[]): Promise<number> {
    return this.deleteFromLane(ids);
  }

  /** Lane and field counters. */
  async status(): Promise<RegionStatus> {
    const now = Date.now();
    return {
      colonyId: this.colonyId,
      region: this.region,
      lane: this.laneSize(),
      marks: this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM marks").one().n,
      fluxPerMin: this.count("enq", now - RATE_WINDOW_MS),
      landingsPerMin: this.count("land", now - RATE_WINDOW_MS),
      sigma: this.sigma(now),
      nextTickAt: await this.ctx.storage.getAlarm(),
    };
  }

  /**
   * Erase this region (colony deletion): cancel the alarm and pending events, delete all
   * storage, and recreate the empty schema, so the object keeps answering as a fresh region.
   */
  async destroy(): Promise<{ cleared: true }> {
    if (this.flushTimer !== null) clearTimeout(this.flushTimer);
    if (this.causeTimer !== null) clearTimeout(this.causeTimer);
    this.flushTimer = null;
    this.causeTimer = null;
    this.depth = null;
    this.outbox = [];
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    for (const stmt of SCHEMA) this.sql.exec(stmt);
    this.colonyId = null;
    this.region = null;
    this.version++;
    this.agg = null;
    this.sigmaCache = null;
    this.lastGc = 0;
    this.lastTickAt = 0;
    this.quietUntil = 0;
    this.sentInhibition = 1;
    this.emitEveryMs = EMIT_EVERY_MS;
    this.adoptName();
    return { cleared: true };
  }

  /** Lane tick: deliver pending reports, then validate, batch, land, report, reschedule. */
  async alarm(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    const started = Date.now();
    // Only a tick with proposals to examine sets the cadence; a report retry or sigma watch does not.
    if (this.laneSize() > 0) this.lastTickAt = started;
    let retryMs: number | null = null;
    try {
      if (this.colonyId !== null) await this.retryReports(this.colonyId);
      retryMs = await this.tick();
    } catch (err) {
      console.error(`lane tick failed in ${this.colonyId}:${this.region}: ${errorText(err)}`);
      retryMs = 2_000;
    } finally {
      this.ticking = false;
    }
    const now = Date.now();
    if (this.laneSize() > 0) {
      await this.ctx.storage.setAlarm(retryMs !== null ? now + retryMs : nextTickAt(now, this.lastTickAt, this.delayMs(now)));
    } else if (this.pendingReports() > 0) {
      await this.ctx.storage.setAlarm(now + REPORT_RETRY_MS);
    } else if (this.watchingSigma(now)) {
      await this.ctx.storage.setAlarm(now + SIGMA_WATCH_MS);
    }
    this.emitSigma(now);
  }

  // -------------------------------------------------------------------------
  // Internals: field
  // -------------------------------------------------------------------------

  private applyOps(ops: FieldOps): { cleared: number; deposited: number } {
    const now = Date.now();
    this.maybeGc(now);
    const touched = new Map<Path, Set<MarkKind>>();
    let cleared = 0;
    for (const filter of ops.clear ?? []) cleared += this.clearRows(filter, touched);
    const deposited = ops.deposit && ops.deposit.length > 0 ? this.depositRows(ops.deposit, now, touched) : 0;
    if (ops.landingId) {
      this.log(`land:${ops.landingId}`, "land", now);
      // The colony's landing fan-out: its trail deposits are the paths the landing changed here.
      for (const m of ops.deposit ?? []) {
        if (m.kind !== "trail" || typeof m.path !== "string" || m.path === "") continue;
        this.sql.exec(
          "INSERT INTO landed_paths (path, landing_id, at) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET landing_id = excluded.landing_id, at = excluded.at",
          m.path,
          ops.landingId,
          now,
        );
      }
    }
    if (cleared > 0 || deposited > 0) {
      this.version++;
      this.queueMarkEvents(touched, now);
    }
    return { cleared, deposited };
  }

  private clearRows(filter: ClearFilter, touched: Map<Path, Set<MarkKind>>): number {
    if (filter.paths !== undefined && filter.paths.length > JSON_CHUNK) {
      let n = 0;
      for (const part of chunks(filter.paths, JSON_CHUNK)) n += this.clearRows({ ...filter, paths: part }, touched);
      return n;
    }
    const where: string[] = [];
    const args: SqlStorageValue[] = [];
    if (filter.agentId !== undefined) {
      where.push("agent_id = ?");
      args.push(filter.agentId);
    }
    if (filter.intentId !== undefined) {
      where.push("intent_id = ?");
      args.push(filter.intentId);
    }
    if (filter.kind !== undefined) {
      where.push("kind = ?");
      args.push(filter.kind);
    }
    if (filter.paths !== undefined) {
      if (filter.paths.length === 0) return 0;
      where.push("path IN (SELECT value FROM json_each(?))");
      args.push(JSON.stringify(filter.paths));
    }
    if (where.length === 0) return 0;
    const cond = where.join(" AND ");
    const rows = this.sql.exec<{ path: string; kind: string }>(`DELETE FROM marks WHERE ${cond} RETURNING path, kind`, ...args).toArray();
    for (const r of rows) touch(touched, r.path, r.kind as MarkKind);
    return rows.length;
  }

  private depositRows(marks: Array<Omit<Mark, "id">>, now: number, touched: Map<Path, Set<MarkKind>>): number {
    const items: Array<{ m: Omit<Mark, "id">; key: string }> = [];
    for (const raw of marks) {
      if (!validDeposit(raw)) continue;
      const at = typeof raw.at === "number" && Number.isFinite(raw.at) ? Math.min(raw.at, now) : now;
      const m: Omit<Mark, "id"> = { ...raw, at };
      items.push({ m, key: mergeKey(m) });
    }
    if (items.length === 0) return 0;
    const existing = new Map<string, { strength: number; at: number }>();
    const accKeys = [...new Set(items.filter((i) => accumulates(i.m.kind)).map((i) => i.key))];
    for (const part of chunks(accKeys, JSON_CHUNK)) {
      const rows = this.sql.exec<{ mkey: string; strength: number; at: number }>(
        "SELECT mkey, strength, at FROM marks WHERE mkey IN (SELECT value FROM json_each(?))",
        JSON.stringify(part),
      );
      for (const r of rows) existing.set(r.mkey, { strength: r.strength, at: r.at });
    }
    for (const { m, key } of items) {
      const folded = foldDeposit(existing.get(key), m, now);
      if (accumulates(m.kind)) existing.set(key, folded);
      this.sql.exec(UPSERT_MARK, key, m.kind, m.path, folded.strength, folded.at, m.agentId ?? null, m.intentId ?? null, isPattern(m.path) ? 1 : 0);
      touch(touched, m.path, m.kind);
    }
    return items.length;
  }

  /** Every live (not expired) mark in the region. */
  private liveMarks(now: number): Mark[] {
    const out: Mark[] = [];
    for (const r of this.sql.exec<MarkRow>(`SELECT ${MARK_COLUMNS} FROM marks`)) {
      const m = toMark(r);
      if (!isExpired(m, now)) out.push(m);
    }
    return out;
  }

  /** Live marks on these paths, plus directory/glob marks that may overlap them. */
  private marksOverlapping(paths: Path[], now: number, excludeAgentId?: Id): Mark[] {
    if (paths.some(isPattern)) {
      return this.liveMarks(now).filter((m) => !(m.kind === "claim" && m.agentId === excludeAgentId));
    }
    const seen = new Set<string>();
    const out: Mark[] = [];
    const take = (r: MarkRow): void => {
      if (seen.has(r.mkey)) return;
      seen.add(r.mkey);
      if (r.kind === "claim" && excludeAgentId !== undefined && r.agent_id === excludeAgentId) return;
      const m = toMark(r);
      if (!isExpired(m, now)) out.push(m);
    };
    for (const part of chunks([...new Set(paths)], JSON_CHUNK)) {
      for (const r of this.sql.exec<MarkRow>(`SELECT ${MARK_COLUMNS} FROM marks WHERE path IN (SELECT value FROM json_each(?))`, JSON.stringify(part))) take(r);
    }
    for (const r of this.sql.exec<MarkRow>(`SELECT ${MARK_COLUMNS} FROM marks WHERE pattern = 1`)) take(r);
    return out;
  }

  private fullAggregate(now: number, exact: boolean): Pick<FieldReading, "totals" | "byPath"> {
    const c = this.agg;
    if (c && (exact ? c.version === this.version && now - c.at < EXACT_TTL_MS : now - c.at < TOTALS_TTL_MS)) return c;
    const agg = aggregate(this.liveMarks(now), now);
    this.agg = { at: now, version: this.version, ...agg };
    return agg;
  }

  /**
   * Agents holding live claims here (one entry per agent; intent = its most recent claim; value =
   * its strongest claim now). Every live claim is listed; admission counts only those at or above
   * the bar (see counted).
   */
  private claimHolders(now: number, excludeAgentId?: Id): Map<Id, { intentId?: Id; at: number; paths: Set<Path>; value: number }> {
    const out = new Map<Id, { intentId?: Id; at: number; paths: Set<Path>; value: number }>();
    for (const r of this.sql.exec<MarkRow>(`SELECT ${MARK_COLUMNS} FROM marks WHERE kind = 'claim' AND agent_id IS NOT NULL`)) {
      if (r.agent_id === null || r.agent_id === excludeAgentId) continue;
      const m = toMark(r);
      if (isExpired(m, now)) continue;
      let h = out.get(r.agent_id);
      if (!h) {
        h = { at: -Infinity, paths: new Set(), value: 0 };
        out.set(r.agent_id, h);
      }
      h.paths.add(r.path);
      h.value = Math.max(h.value, markValue(m, now));
      if (r.at >= h.at) {
        h.at = r.at;
        if (r.intent_id !== null) h.intentId = r.intent_id;
      }
    }
    return out;
  }

  /** Claim holders that count toward admission: their strongest claim is at or above the bar. */
  private counted(holders: Map<Id, { value: number }>): number {
    const bar = this.admissionBar();
    let n = 0;
    for (const h of holders.values()) if (h.value >= bar) n++;
    return n;
  }

  /** The admission bar as a claim value (a fresh claim is worth 1). See region/logic.ts admissionBar. */
  private admissionBar(): number {
    return admissionBar((this.env as unknown as { FT_LATERAL_INHIBITION?: string } | undefined)?.FT_LATERAL_INHIBITION, LATERAL_INHIBITION);
  }

  /** Is this agent inside the region: does it hold a claim here at or above the admission bar? */
  private holdsClaim(agentId: Id, now: number): boolean {
    const bar = this.admissionBar();
    for (const r of this.sql.exec<MarkRow>(`SELECT ${MARK_COLUMNS} FROM marks WHERE agent_id = ? AND kind = 'claim'`, agentId)) {
      if (markValue(toMark(r), now) >= bar) return true;
    }
    return false;
  }

  /** Live marks of these kinds anywhere in the region (an excluded agent's claims left out). */
  private marksOfKinds(kinds: string[], now: number, excludeAgentId?: Id): Mark[] {
    const out: Mark[] = [];
    if (kinds.length === 0) return out;
    for (const r of this.sql.exec<MarkRow>(`SELECT ${MARK_COLUMNS} FROM marks WHERE kind IN (SELECT value FROM json_each(?))`, JSON.stringify(kinds))) {
      if (r.kind === "claim" && excludeAgentId !== undefined && r.agent_id === excludeAgentId) continue;
      const m = toMark(r);
      if (!isExpired(m, now)) out.push(m);
    }
    return out;
  }

  private sigma(now: number): number {
    if (this.sigmaCache && now - this.sigmaCache.at < SIGMA_TTL_MS) return this.sigmaCache.sigma;
    const events: CausalEvent[] = [];
    for (const r of this.sql.exec<{ id: string; cause_id: string | null; at: number }>(
      "SELECT id, cause_id, at FROM causes WHERE at >= ?",
      now - SIGMA_KEEP_MS,
    )) {
      events.push(r.cause_id !== null ? { id: r.id, causeId: r.cause_id, at: r.at } : { id: r.id, at: r.at });
    }
    const sigma = cascadeSigma(events, now, SIGMA_WINDOW_MS, SIGMA_SETTLE_MS);
    this.sigmaCache = { at: now, sigma };
    return sigma;
  }

  private log(id: string, kind: "enq" | "land", at: number): void {
    this.sql.exec("INSERT OR IGNORE INTO log (id, kind, at) VALUES (?, ?, ?)", id, kind, at);
  }

  private count(kind: "enq" | "land", since: number): number {
    return this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM log WHERE kind = ? AND at > ?", kind, since).one().n;
  }

  /** Lazy garbage collection: expired marks and old bookkeeping rows. */
  private maybeGc(now: number): void {
    if (now - this.lastGc < GC_EVERY_MS) return;
    this.lastGc = now;
    const expired: string[] = [];
    for (const r of this.sql.exec<MarkRow>(`SELECT ${MARK_COLUMNS} FROM marks WHERE kind != 'need'`)) {
      if (isExpired(toMark(r), now)) expired.push(r.mkey);
    }
    for (const part of chunks(expired, JSON_CHUNK)) {
      this.sql.exec("DELETE FROM marks WHERE mkey IN (SELECT value FROM json_each(?))", JSON.stringify(part));
    }
    this.sql.exec("DELETE FROM log WHERE at < ?", now - LOG_KEEP_MS);
    this.sql.exec("DELETE FROM causes WHERE at < ?", now - SIGMA_KEEP_MS);
    this.sql.exec("DELETE FROM path_landing WHERE at < ?", now - PATH_LANDING_KEEP_MS);
    this.sql.exec("DELETE FROM intent_returns WHERE at < ?", now - LOG_KEEP_MS);
    this.sql.exec("DELETE FROM landed_paths WHERE at < ?", now - PATH_LANDING_KEEP_MS);
    this.sql.exec("DELETE FROM pending_causes WHERE at < ?", now - SIGMA_KEEP_MS);
  }

  // -------------------------------------------------------------------------
  // Internals: events to the ColonyDO hub (batched)
  // -------------------------------------------------------------------------

  private queueMarkEvents(touched: Map<Path, Set<MarkKind>>, now: number): void {
    if (this.colonyId === null || this.region === null || now < this.quietUntil || touched.size === 0) return;
    const sums = new Map<string, number>();
    for (const part of chunks([...touched.keys()], JSON_CHUNK)) {
      for (const r of this.sql.exec<MarkRow>(`SELECT ${MARK_COLUMNS} FROM marks WHERE path IN (SELECT value FROM json_each(?))`, JSON.stringify(part))) {
        const k = `${r.kind}|${r.path}`;
        sums.set(k, (sums.get(k) ?? 0) + markValue(toMark(r), now));
      }
    }
    for (const [path, kinds] of touched) {
      for (const kind of kinds) {
        this.outbox.push({ t: "mark", at: now, region: this.region, path, kind, value: round4(sums.get(`${kind}|${path}`) ?? 0) });
      }
    }
    this.scheduleFlush();
  }

  private queueEvent(e: ColonyEvent): void {
    if (this.colonyId === null || Date.now() < this.quietUntil) return;
    this.outbox.push(e);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.outbox.length > MAX_OUTBOX) this.outbox = coalesceEvents(this.outbox).slice(-MAX_OUTBOX);
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.ctx.waitUntil(this.flushOutbox());
    }, this.emitEveryMs);
  }

  private async flushOutbox(): Promise<void> {
    const events = this.outbox;
    this.outbox = [];
    if (events.length === 0 || this.colonyId === null) return;
    try {
      const res = (await this.colonyStub(this.colonyId).emit(coalesceEvents(events))) as { listeners?: number; emitEveryMs?: number } | undefined;
      if (res && res.listeners === 0) this.quietUntil = Date.now() + QUIET_MS;
      // The colony paces its regions: with many regions emitting it asks each one to batch for longer.
      const pace = res?.emitEveryMs;
      if (typeof pace === "number" && Number.isFinite(pace)) this.emitEveryMs = Math.min(EMIT_MAX_MS, Math.max(EMIT_EVERY_MS, Math.round(pace)));
    } catch (err) {
      console.warn(`field events not delivered for ${this.colonyId}:${this.region}: ${errorText(err)}`);
      this.quietUntil = Date.now() + QUIET_MS;
    }
  }

  // -------------------------------------------------------------------------
  // Internals: lane
  // -------------------------------------------------------------------------

  private laneSize(): number {
    return this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM lane").one().n;
  }

  private deleteFromLane(ids: Id[]): number {
    let n = 0;
    for (const part of chunks([...new Set(ids)], JSON_CHUNK)) {
      n += this.sql.exec("DELETE FROM lane WHERE id IN (SELECT value FROM json_each(?)) RETURNING id", JSON.stringify(part)).toArray().length;
    }
    return n;
  }

  /** Interval to the next tick: Physarum cadence for the current flux, times the sigma inhibition. */
  private delayMs(now: number): number {
    return laneDelayMs(this.count("enq", now - RATE_WINDOW_MS), this.sigma(now));
  }

  /**
   * Schedule the next tick, or pull a far-off one closer when rising flux shortens the cadence.
   * A lane that was empty has no tick scheduled, only a report retry or a sigma watch, so its
   * alarm is replaced: an early watch alarm must not run the tick before the (inhibited) cadence.
   */
  private async ensureAlarm(now: number, replace = false): Promise<void> {
    if (this.ticking) return; // the running tick reschedules when it finishes
    const want = nextTickAt(now, this.lastTickAt, this.delayMs(now));
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > want || (replace && current !== want)) await this.ctx.storage.setAlarm(want);
  }

  /**
   * Keep an empty lane's alarm alive while sigma is above 1 (to report its fall) or while a
   * recent return may still raise it once its cause settles.
   */
  private watchingSigma(now: number): boolean {
    if (this.sigma(now) > 1) return true;
    const recent = this.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM causes WHERE id LIKE 'ret:%' AND at > ?", now - SIGMA_SETTLE_MS - SIGMA_WATCH_MS)
      .one().n;
    return recent > 0;
  }

  /** Send sigma, and the lane inhibition while it applies (and once when it lifts), to the colony. */
  private emitSigma(now: number): void {
    const region = this.region ?? "";
    const sigma = this.sigma(now);
    this.queueEvent({ t: "sigma", at: now, region, sigma: round4(sigma) });
    const factor = inhibitionFactor(sigma);
    if (factor !== 1 || this.sentInhibition !== 1) {
      this.queueEvent({ t: "metric", at: now, name: `inhibition:${region}`, value: round4(factor) });
      this.queueEvent({ t: "metric", at: now, name: `laneDelayMs:${region}`, value: this.delayMs(now) });
      this.sentInhibition = factor;
    }
  }

  /** One lane cycle. Returns a retry delay after a landing failure, else null (normal cadence). */
  private async tick(): Promise<number | null> {
    const colonyId = this.colonyId;
    if (colonyId === null) throw new Error("region is not configured");
    this.maybeGc(Date.now());
    const rows = this.sql
      .exec<{ id: string; attempts: number; data: string }>("SELECT id, attempts, data FROM lane ORDER BY priority DESC, created_at ASC LIMIT ?", LANE_SCAN)
      .toArray();
    if (rows.length === 0) return null;
    const proposals: Proposal[] = [];
    const attempts = new Map<Id, number>();
    for (const r of rows) {
      try {
        proposals.push(JSON.parse(r.data) as Proposal);
        attempts.set(r.id, r.attempts);
      } catch {
        this.deleteFromLane([r.id]);
      }
    }
    if (proposals.length === 0) return null;

    // 0. Pause (colony/pause.ts): while a person has paused the colony's agents (or the deployment's), the lane holds.
    //    It reads nothing, lands nothing and sends nothing back, and asks again shortly; a resume lets it go on.
    const hold = await laneHold(this.env, colonyId);
    if (hold !== null) return hold;

    // 1. Trunk state: current blobs for every path read or written, and base blobs per distinct base.
    const trunk = this.trunkStub(colonyId);
    const allPaths = [...new Set(proposals.flatMap(proposalPaths))];
    const current: Record<Path, Sha | null> = await trunk.blobsFor(allPaths);
    const bases = new Map<Sha, Map<Path, Sha | null>>();
    await Promise.all(
      [...writePathsByBase(proposals)].map(async ([sha, paths]) => {
        const versions: FileVersion[] = await trunk.baseBlobs(sha, paths);
        bases.set(sha, new Map(versions.map((v) => [v.path, v.blob ?? null])));
      }),
    );

    // 2. Optimistic concurrency: stale proposals go back with the exact delta. With assumption revalidation
    //    on for the colony (FT_REVALIDATE), one stale only through files it read, each still on trunk and
    //    covered by a name assumption, goes on to the trunk writer instead: it reads those files and lands
    //    the change only when every name the change imports from them is still exported. With text merge
    //    on (FT_TEXT_MERGE), so does one stale only on files it writes: the trunk writer merges each of
    //    them with trunk's version line by line and lands the change only when every merge is clean.
    const revalidating = revalidationEnabled((this.env as unknown as { FT_REVALIDATE?: string } | undefined)?.FT_REVALIDATE, colonyId);
    const merging = textMergeEnabled((this.env as unknown as { FT_TEXT_MERGE?: string } | undefined)?.FT_TEXT_MERGE, colonyId);
    const valid: Proposal[] = [];
    const stale: Array<{ p: Proposal; occ: OccResult }> = [];
    const candidates = new Map<Id, OccResult["stale"]>();
    for (const p of proposals) {
      const base = bases.get(p.baseSha);
      const baseBlobs: FileVersion[] = p.writeSet.map((w) => ({ path: w.path, blob: base?.get(w.path) ?? null }));
      const occ = validateProposal(p, (path) => current[path], baseBlobs);
      if (occ.eligible) valid.push(p);
      else if ((revalidating && revalidationCandidate(p, occ.stale)) || (merging && textMergeCandidate(p, occ.stale))) {
        valid.push(p);
        candidates.set(p.id, occ.stale);
      } else stale.push({ p, occ });
    }
    // Recipes (trunk/recipes.ts): a stale change built before a recipe landed goes on to the trunk writer, which brings it
    // through the recipe before it validates it. A writer that cannot answer (older code, busy) leaves them stale.
    if (stale.length > 0) {
      const asked = stale.map(({ p }) => ({ id: p.id, baseSha: p.baseSha, paths: proposalPaths(p) }));
      const through = new Set<Id>(await Promise.resolve().then(() => trunk.recipeCandidates(asked)).catch(() => [] as Id[]));
      for (let k = stale.length - 1; k >= 0; k--) {
        const s = stale[k]!;
        if (!through.has(s.p.id)) continue;
        valid.push(s.p);
        candidates.set(s.p.id, s.occ.stale);
        stale.splice(k, 1);
      }
    }

    // 3. Direction, then lateral inhibition. One small call fetches the lineage context (intents with
    //    their direction, agents, recorded decisions), so TrunkDO never pulls a full colony snapshot.
    //    A change for a withdrawn intent, or built on an older revision of a revised one, goes back
    //    before it can land. The largest non-conflicting batch of the rest lands as one commit (in the
    //    trunk writer's next group-commit cycle).
    const ctx =
      valid.length > 0
        ? await this.env.COLONY.get(this.env.COLONY.idFromName(colonyId))
            .landContext(valid.map((p) => p.intentId), valid.map((p) => p.agentId), valid.map((p) => p.id))
            .catch(() => undefined)
        : undefined;
    // A pause that began during this tick holds the lane too, before anything reaches the trunk writer.
    if (pausedIn(ctx)) return LANE_PAUSE_RECHECK_MS;
    const direction = splitByDirection(valid, ctx?.intents);
    // Protected paths (colony/protect.ts): a change that writes a path protected after a person last approved it goes to a person.
    const guarded = splitByProtection(direction.keep, ctx?.protect, ctx?.decisions);
    const { batch } = selectBatch(guarded.keep, LANE_SCAN);
    let result: LandResult | null = null;
    let landError: string | null = null;
    if (batch.length > 0) {
      try {
        result = (await trunk.land(batch, ctx)) as LandResult;
      } catch (err) {
        landError = errorText(err);
        console.error(`TrunkDO.land failed for ${colonyId}:${this.region}: ${landError}`);
      }
    }

    // 4. Idempotent per proposal id: a proposal whose landing report was lost (the land call failed
    //    after the trunk writer landed it) looks stale against its own blob. The trunk writer's index
    //    of landed proposals decides; a proposal that landed is settled as landed, never returned.
    const ask = suspects(stale, result);
    const known = ask.length > 0 ? ((await trunk.landingsOf(ask).catch(() => null)) as Record<Id, Landing> | null) : {};
    const settled = settleLane({ batch, stale: stale.map(({ p, occ }) => ({ p, occ, reason: staleReason(occ.stale) })), result, known, trunk: (path) => current[path] });

    // 5. Bookkeeping: lane removals, returns, causal events.
    const now = Date.now();
    const remove = new Set<Id>(settled.landed);
    const updates: Array<{ id: Id; patch: Partial<Proposal>; stale?: OccResult["stale"] }> = [];
    const seen = [...batch, ...stale.map((s) => s.p)];
    for (const landing of settled.landings) this.recordLanding(landing, seen, now);
    for (const r of settled.returned) {
      remove.add(r.id);
      // Protected paths (colony/protect.ts): one the trunk writer stopped at its protection check waits for a person; no causal event.
      // So does one the trunk writer held rather than merge with a newer trunk on its own (trunk/mergelock.ts).
      if (isProtectStop(r.reason) || isMergeHold(r.reason)) {
        updates.push({ id: r.id, patch: { status: "escalated", reason: r.reason, ...(r.held ? { mergeHold: r.held } : {}) } });
        continue;
      }
      // A text merge conflict travels with its return (FT_RESOLVER: the colony's conflict resolver reads it), and so do
      // the paths it was found stale on: the colony names the landings that moved them (colony/movedby.ts).
      const moved = stalePaths(r.stale ?? candidates.get(r.id) ?? null);
      updates.push({ id: r.id, patch: { status: "returned", reason: r.reason, ...(r.conflicts ? { mergeConflicts: r.conflicts } : {}) }, ...(moved ? { stale: moved } : {}) });
      // A revalidation or text merge candidate the trunk writer sent back is still a stale return: its cause is a landing.
      // One it sent back at its direction check is not: a person changed course, so sigma never sees it.
      if (r.p && !isRedirect(r.reason)) this.recordReturn(r.p, r.stale ?? candidates.get(r.id) ?? null, now);
    }
    // Stale direction goes back here, before the trunk writer (which checks again at its commit point,
    // TrunkDO.direction). A human changed course, not a landing: no causal event.
    for (const r of direction.returned) {
      remove.add(r.p.id);
      updates.push({ id: r.p.id, patch: { status: "returned", reason: r.reason } });
    }
    // Protected paths: a change the lane stopped for a path protected after its last approval goes to the review queue.
    for (const r of guarded.stopped) {
      remove.add(r.p.id);
      updates.push({ id: r.p.id, patch: { status: "escalated", reason: r.reason } });
    }
    let retryMs: number | null = null;
    const keep = new Set(settled.keep);
    const unresolved = seen.filter((p) => keep.has(p.id) && !remove.has(p.id));
    if (unresolved.length > 0) {
      // Land failed, or the trunk neither landed nor returned them: count an attempt so nothing loops forever.
      let worst = 0;
      for (const p of unresolved) {
        const n = (attempts.get(p.id) ?? 0) + 1;
        worst = Math.max(worst, n);
        if (n >= MAX_LAND_ATTEMPTS) {
          remove.add(p.id);
          updates.push({ id: p.id, patch: { status: "returned", reason: `landing failed ${n} times: ${landError ?? "not landed by trunk"}` } });
        } else {
          this.sql.exec("UPDATE lane SET attempts = ? WHERE id = ?", n, p.id);
        }
      }
      if (landError !== null) retryMs = Math.min(30_000, 1_000 * 2 ** worst);
    }
    if (remove.size > 0) this.deleteFromLane([...remove]);

    // 6. Report to the colony (landings first so intents settle before returns reopen anything; onLanding is idempotent per landing id).
    for (const landing of settled.landings) await this.report(colonyId, { kind: "landing", landing });
    if (updates.length > 0) await this.report(colonyId, { kind: "updates", updates });
    this.sigmaCache = null; // alarm() sends the new sigma
    return retryMs;
  }

  /**
   * Causal bookkeeping for a landing: one cause event per landed proposal, linked
   * to the return that sent its intent back (if any), and a path+blob index so a
   * later stale return can name the landing that caused it. A file the trunk writer
   * merged (text merge) is indexed at the blob that landed, not the one proposed.
   */
  private recordLanding(landing: Landing, batch: Proposal[], now: number): void {
    this.log(`land:${landing.id}`, "land", now);
    const landed = new Set(landing.proposalIds);
    const merged = new Map<string, Sha>();
    for (const m of Array.isArray(landing.merged) ? landing.merged : []) {
      if (m && typeof m.proposalId === "string" && typeof m.path === "string" && typeof m.blob === "string") merged.set(`${m.proposalId}\u0000${m.path}`, m.blob);
    }
    for (const p of batch) {
      if (!landed.has(p.id)) continue;
      const eventId = `land:${landing.id}:${p.id}`;
      const prior = this.sql.exec<{ event_id: string }>("DELETE FROM intent_returns WHERE intent_id = ? RETURNING event_id", p.intentId).toArray()[0];
      this.sql.exec("INSERT OR IGNORE INTO causes (id, cause_id, at) VALUES (?, ?, ?)", eventId, prior?.event_id ?? null, now);
      for (const w of p.writeSet) {
        this.sql.exec(
          "INSERT INTO path_landing (path, blob, event_id, at) VALUES (?, ?, ?, ?) ON CONFLICT(path, blob) DO UPDATE SET event_id = excluded.event_id, at = excluded.at",
          w.path,
          merged.get(`${p.id}\u0000${w.path}`) ?? w.blob ?? "",
          eventId,
          now,
        );
      }
    }
  }

  /**
   * A return is a child of the landing that changed one of its stale paths (when known): one this
   * lane landed, else one another lane landed on this region's paths, else (resolved shortly after,
   * see resolveCauses) one that landed in the region owning the stale path.
   */
  private recordReturn(p: Proposal, stale: OccResult["stale"] | null, now: number): void {
    let cause: string | null = null;
    let deferred = false;
    if (stale) {
      for (const s of stale) {
        const row = this.sql
          .exec<{ event_id: string }>("SELECT event_id FROM path_landing WHERE path = ? AND blob = ?", s.path, s.actual ?? "")
          .toArray()[0];
        if (row) {
          cause = row.event_id;
          break;
        }
      }
      if (cause === null && stale.length > 0) {
        cause = this.landedCause(stale.map((s) => s.path));
        deferred = cause === null;
      }
    } else {
      const row = this.sql
        .exec<{ event_id: string }>(
          "SELECT event_id FROM path_landing WHERE path IN (SELECT value FROM json_each(?)) AND at > ? ORDER BY at DESC LIMIT 1",
          JSON.stringify(p.writeSet.map((w) => w.path).slice(0, JSON_CHUNK)),
          now - RATE_WINDOW_MS,
        )
        .toArray()[0];
      cause = row?.event_id ?? null;
    }
    const eventId = `ret:${p.id}`;
    this.sql.exec("INSERT OR IGNORE INTO causes (id, cause_id, at) VALUES (?, ?, ?)", eventId, cause, now);
    if (deferred && stale) this.deferCause(eventId, stale.map((s) => s.path), now);
    this.sql.exec(
      "INSERT INTO intent_returns (intent_id, event_id, at) VALUES (?, ?, ?) ON CONFLICT(intent_id) DO UPDATE SET event_id = excluded.event_id, at = excluded.at",
      p.intentId,
      eventId,
      now,
    );
  }

  /** The most recent landing this region heard of on any of these paths, as a parent event here (null if none). */
  private landedCause(paths: Path[]): string | null {
    let best: { landing_id: string; at: number } | undefined;
    for (const part of chunks([...new Set(paths)], JSON_CHUNK)) {
      const row = this.sql
        .exec<{ landing_id: string; at: number }>(
          "SELECT landing_id, at FROM landed_paths WHERE path IN (SELECT value FROM json_each(?)) ORDER BY at DESC LIMIT 1",
          JSON.stringify(part),
        )
        .toArray()[0];
      if (row && (!best || row.at > best.at)) best = row;
    }
    return best ? this.landingParent(best.landing_id, best.at) : null;
  }

  /**
   * A landing as a parent event of this region's causal graph, keyed to its landing id. Only
   * landings that invalidated work here become parents this way (this lane's own landings are
   * recorded per landed proposal by recordLanding).
   */
  private landingParent(landingId: Id, at: number): string {
    const id = `land:${landingId}`;
    this.sql.exec("INSERT OR IGNORE INTO causes (id, cause_id, at) VALUES (?, NULL, ?)", id, at);
    return id;
  }

  /** Keep a stale return whose cause is not known here yet; resolveCauses names it shortly. */
  private deferCause(eventId: string, paths: Path[], now: number): void {
    this.sql.exec(
      "INSERT OR IGNORE INTO pending_causes (id, paths, at, attempts) VALUES (?, ?, ?, 0)",
      eventId,
      JSON.stringify([...new Set(paths)].slice(0, JSON_CHUNK)),
      now,
    );
    this.scheduleCauses();
  }

  private scheduleCauses(): void {
    if (this.causeTimer !== null) return;
    this.causeTimer = setTimeout(() => {
      this.causeTimer = null;
      this.ctx.waitUntil(this.resolveCauses());
    }, CAUSE_RESOLVE_MS);
  }

  /**
   * Name the landings behind stale returns this lane could not attribute when it returned them.
   * A path of this region is looked up in its own landed_paths; a path of another region is asked
   * of that region (landedFor), one call per region per pass. Each landing found becomes a parent
   * here and the return its child, so a landing elsewhere that invalidates this lane's work counts
   * in this region's sigma. Unresolved returns are retried a few times, then dropped.
   */
  private async resolveCauses(): Promise<void> {
    if (this.resolvingCauses) return;
    this.resolvingCauses = true;
    try {
      const rows = this.sql
        .exec<{ id: string; paths: string; attempts: number }>("SELECT id, paths, attempts FROM pending_causes ORDER BY at LIMIT ?", CAUSE_BATCH)
        .toArray();
      if (rows.length === 0) return;
      const pathsOf = new Map<string, Path[]>();
      const elsewhere = new Map<string, Set<Path>>();
      for (const r of rows) {
        let paths: Path[] = [];
        try {
          const parsed: unknown = JSON.parse(r.paths);
          if (Array.isArray(parsed)) paths = parsed.filter((x): x is Path => typeof x === "string");
        } catch {
          // dropped below
        }
        pathsOf.set(r.id, paths);
        if (this.depth === null) continue; // owners unknown until configure() passes the colony's depth
        for (const path of paths) {
          const owner = regionOf(path, this.depth);
          if (owner === this.region) continue;
          let set = elsewhere.get(owner);
          if (!set) elsewhere.set(owner, (set = new Set()));
          set.add(path);
        }
      }
      const found = new Map<Path, { landingId: Id; at: number }>();
      const colonyId = this.colonyId;
      if (colonyId !== null) {
        await Promise.all(
          [...elsewhere].map(async ([owner, paths]) => {
            try {
              const stub = this.env.REGION.get(this.env.REGION.idFromName(regionKey(colonyId, owner)));
              for (const l of await stub.landedFor([...paths])) found.set(l.path, { landingId: l.landingId, at: l.at });
            } catch (err) {
              console.warn(`cause lookup in region ${owner} failed for ${colonyId}:${this.region}: ${errorText(err)}`);
            }
          }),
        );
      }
      for (const r of rows) {
        const paths = pathsOf.get(r.id) ?? [];
        let cause = this.landedCause(paths);
        if (cause === null) {
          let best: { landingId: Id; at: number } | undefined;
          for (const path of paths) {
            const l = found.get(path);
            if (l && (!best || l.at > best.at)) best = l;
          }
          if (best) cause = this.landingParent(best.landingId, best.at);
        }
        if (cause !== null) {
          this.sql.exec("UPDATE causes SET cause_id = ? WHERE id = ? AND cause_id IS NULL", cause, r.id);
          this.sql.exec("DELETE FROM pending_causes WHERE id = ?", r.id);
        } else if (paths.length === 0 || r.attempts + 1 >= MAX_CAUSE_ATTEMPTS) {
          this.sql.exec("DELETE FROM pending_causes WHERE id = ?", r.id);
        } else {
          this.sql.exec("UPDATE pending_causes SET attempts = attempts + 1 WHERE id = ?", r.id);
        }
      }
      this.sigmaCache = null;
      if (this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM pending_causes").one().n > 0) this.scheduleCauses();
    } finally {
      this.resolvingCauses = false;
    }
  }

  /**
   * Tell the colony about a landing or returns. A failed delivery is kept in
   * the `reports` table and retried on later alarms, in order, so an agent is
   * never left waiting on a proposal whose outcome was lost.
   */
  private async report(colonyId: Id, r: LaneReport): Promise<void> {
    if (this.pendingReports() === 0 && (await this.deliver(colonyId, r))) return;
    const now = Date.now();
    this.sql.exec("INSERT INTO reports (id, at, attempts, data) VALUES (?, ?, 0, ?)", `${now}:${Math.random().toString(36).slice(2)}`, now, JSON.stringify(r));
  }

  private async deliver(colonyId: Id, r: LaneReport): Promise<boolean> {
    try {
      const colony = this.colonyStub(colonyId);
      if (r.kind === "landing") await colony.onLanding(r.landing);
      else await colony.updateProposals(r.updates);
      return true;
    } catch (err) {
      console.error(`report to ColonyDO failed (${r.kind}) in ${colonyId}:${this.region}: ${errorText(err)}`);
      return false;
    }
  }

  private async retryReports(colonyId: Id): Promise<void> {
    const pending = this.sql.exec<{ id: string; attempts: number; data: string }>("SELECT id, attempts, data FROM reports ORDER BY at, id LIMIT 50").toArray();
    for (const row of pending) {
      if (await this.deliver(colonyId, JSON.parse(row.data) as LaneReport)) {
        this.sql.exec("DELETE FROM reports WHERE id = ?", row.id);
      } else if (row.attempts + 1 >= MAX_REPORT_ATTEMPTS) {
        console.error(`dropping report ${row.id} after ${row.attempts + 1} attempts`);
        this.sql.exec("DELETE FROM reports WHERE id = ?", row.id);
      } else {
        this.sql.exec("UPDATE reports SET attempts = attempts + 1 WHERE id = ?", row.id);
        return; // keep order: later reports wait for this one
      }
    }
  }

  private pendingReports(): number {
    return this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM reports").one().n;
  }

  private colonyStub(colonyId: Id) {
    return this.env.COLONY.get(this.env.COLONY.idFromName(colonyId));
  }

  private trunkStub(colonyId: Id) {
    return this.env.TRUNK.get(this.env.TRUNK.idFromName(colonyId));
  }
}
