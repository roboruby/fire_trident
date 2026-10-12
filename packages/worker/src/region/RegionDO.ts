import { DurableObject } from "cloudflare:workers";
import { admissionOpen, aggregate, branchingRatio, isExpired, markValue, selectBatch, validateProposal } from "@fire_trident/core";
import type { CausalEvent, ColonyEvent, FieldReading, FileVersion, Id, Landing, Mark, MarkKind, OccResult, Path, Proposal, Sha } from "@fire_trident/core";
import type { Env } from "../env.ts";
import { errorText } from "../colony/errors.ts";
import { coalesceEvents } from "../colony/events.ts";
import type { ClearFilter, FieldOps } from "../colony/logic.ts";
import {
  accumulates,
  chunks,
  foldDeposit,
  laneDelayMs,
  mergeKey,
  nextTickAt,
  proposalPaths,
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
/** Branching-ratio window (matches the core default) and how long cause events are kept. */
const SIGMA_WINDOW_MS = 60_000;
const SIGMA_KEEP_MS = 10 * 60_000;
const LOG_KEEP_MS = 15 * 60_000;
const PATH_LANDING_KEEP_MS = 60 * 60_000;
const GC_EVERY_MS = 10_000;
/** Cache lifetimes for the full-region aggregate (exact readings / totals only) and sigma. */
const EXACT_TTL_MS = 250;
const TOTALS_TTL_MS = 1_000;
const SIGMA_TTL_MS = 1_000;
/** Mark/sigma events are batched and sent to the ColonyDO at most this often. */
const EMIT_EVERY_MS = 100;
/** After the ColonyDO reports no listeners, stop sending field events for this long. */
const QUIET_MS = 5_000;
const MAX_OUTBOX = 20_000;
/** Max items bound into one json_each() parameter. */
const JSON_CHUNK = 500;
/** Undelivered colony reports are retried this often, at most this many times. */
const REPORT_RETRY_MS = 5_000;
const MAX_REPORT_ATTEMPTS = 50;

/** What a lane tick tells the ColonyDO. */
type LaneReport = { kind: "landing"; landing: Landing } | { kind: "updates"; updates: Array<{ id: Id; patch: Partial<Proposal> }> };

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
  private lastTickAt = 0;
  private ticking = false;
  private outbox: ColonyEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private quietUntil = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    for (const stmt of SCHEMA) this.sql.exec(stmt);
    for (const row of this.sql.exec<{ k: string; v: string }>("SELECT k, v FROM meta")) {
      if (row.k === "colonyId") this.colonyId = row.v;
      else if (row.k === "region") this.region = row.v;
    }
    if (this.colonyId === null) this.adoptName();
  }

  // -------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------

  /** Bind this object to its colony and region (idempotent). */
  async configure(p: { colonyId: Id; region: string }): Promise<void> {
    const upsert = "INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v";
    this.sql.exec(upsert, "colonyId", p.colonyId);
    this.sql.exec(upsert, "region", p.region);
    this.colonyId = p.colonyId;
    this.region = p.region;
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
    let totals: FieldReading["totals"];
    let byPath: FieldReading["byPath"];
    if (opts.paths !== undefined) {
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
    const activeAgents = holders.size;
    const agents: FieldReading["agents"] = [];
    if (opts.agents !== false) {
      for (const [agentId, h] of holders) {
        agents.push(h.intentId !== undefined ? { agentId, intentId: h.intentId, paths: [...h.paths] } : { agentId, paths: [...h.paths] });
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
    this.sql.exec(
      `INSERT INTO lane (id, priority, created_at, enqueued_at, attempts, data) VALUES (?, ?, ?, ?, 0, ?)
       ON CONFLICT(id) DO UPDATE SET priority = excluded.priority, enqueued_at = excluded.enqueued_at, attempts = 0, data = excluded.data`,
      p.id,
      Number.isFinite(priority) ? priority : 1,
      Number.isFinite(p.createdAt) ? p.createdAt : now,
      now,
      JSON.stringify(p),
    );
    this.log(`enq:${p.id}:${now}`, "enq", now);
    await this.ensureAlarm(now);
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

  /** Lane tick: deliver pending reports, then validate, batch, land, report, reschedule. */
  async alarm(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    const started = Date.now();
    this.lastTickAt = started;
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
    }
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
    if (ops.landingId) this.log(`land:${ops.landingId}`, "land", now);
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

  /** Agents holding live claims here (one entry per agent; intent = its most recent claim). */
  private claimHolders(now: number, excludeAgentId?: Id): Map<Id, { intentId?: Id; at: number; paths: Set<Path> }> {
    const out = new Map<Id, { intentId?: Id; at: number; paths: Set<Path> }>();
    for (const r of this.sql.exec<MarkRow>(`SELECT ${MARK_COLUMNS} FROM marks WHERE kind = 'claim' AND agent_id IS NOT NULL`)) {
      if (r.agent_id === null || r.agent_id === excludeAgentId) continue;
      if (isExpired(toMark(r), now)) continue;
      let h = out.get(r.agent_id);
      if (!h) {
        h = { at: -Infinity, paths: new Set() };
        out.set(r.agent_id, h);
      }
      h.paths.add(r.path);
      if (r.at >= h.at) {
        h.at = r.at;
        if (r.intent_id !== null) h.intentId = r.intent_id;
      }
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
    const sigma = branchingRatio(events, now, SIGMA_WINDOW_MS);
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
    }, EMIT_EVERY_MS);
  }

  private async flushOutbox(): Promise<void> {
    const events = this.outbox;
    this.outbox = [];
    if (events.length === 0 || this.colonyId === null) return;
    try {
      const res = await this.colonyStub(this.colonyId).emit(coalesceEvents(events));
      if (res && res.listeners === 0) this.quietUntil = Date.now() + QUIET_MS;
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

  /** Schedule the next tick, or pull a far-off one closer when rising flux shortens the cadence. */
  private async ensureAlarm(now: number): Promise<void> {
    if (this.ticking) return; // the running tick reschedules when it finishes
    const want = nextTickAt(now, this.lastTickAt, this.delayMs(now));
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > want) await this.ctx.storage.setAlarm(want);
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

    // 2. Optimistic concurrency: stale proposals go back with the exact delta.
    const valid: Proposal[] = [];
    const stale: Array<{ p: Proposal; occ: OccResult }> = [];
    for (const p of proposals) {
      const base = bases.get(p.baseSha);
      const baseBlobs: FileVersion[] = p.writeSet.map((w) => ({ path: w.path, blob: base?.get(w.path) ?? null }));
      const occ = validateProposal(p, (path) => current[path], baseBlobs);
      if (occ.eligible) valid.push(p);
      else stale.push({ p, occ });
    }

    // 3. Lateral inhibition: the largest non-conflicting batch lands as one commit.
    const { batch } = selectBatch(valid, LANE_SCAN);
    let landing: Landing | undefined;
    let trunkReturned: Array<{ proposalId: Id; reason: string }> = [];
    let landError: string | null = null;
    if (batch.length > 0) {
      try {
        const res = await trunk.land(batch);
        landing = res.landing;
        trunkReturned = res.returned ?? [];
      } catch (err) {
        landError = errorText(err);
        console.error(`TrunkDO.land failed for ${colonyId}:${this.region}: ${landError}`);
      }
    }

    // 4. Bookkeeping: lane removals, returns, causal events.
    const now = Date.now();
    const remove = new Set<Id>();
    const updates: Array<{ id: Id; patch: Partial<Proposal> }> = [];
    if (landing) {
      this.recordLanding(landing, batch, now);
      for (const id of landing.proposalIds) remove.add(id);
    }
    for (const { p, occ } of stale) {
      remove.add(p.id);
      updates.push({ id: p.id, patch: { status: "returned", reason: staleReason(occ.stale) } });
      this.recordReturn(p, occ.stale, now);
    }
    const byId = new Map(batch.map((p) => [p.id, p]));
    for (const r of trunkReturned) {
      if (remove.has(r.proposalId)) continue;
      remove.add(r.proposalId);
      updates.push({ id: r.proposalId, patch: { status: "returned", reason: r.reason } });
      const p = byId.get(r.proposalId);
      if (p) this.recordReturn(p, null, now);
    }
    let retryMs: number | null = null;
    const unresolved = batch.filter((p) => !remove.has(p.id));
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

    // 5. Report to the colony (landing first so intents settle before returns reopen anything).
    if (landing) await this.report(colonyId, { kind: "landing", landing });
    if (updates.length > 0) await this.report(colonyId, { kind: "updates", updates });
    this.sigmaCache = null;
    this.queueEvent({ t: "sigma", at: now, region: this.region ?? "", sigma: this.sigma(now) });
    return retryMs;
  }

  /**
   * Causal bookkeeping for a landing: one cause event per landed proposal, linked
   * to the return that sent its intent back (if any), and a path+blob index so a
   * later stale return can name the landing that caused it.
   */
  private recordLanding(landing: Landing, batch: Proposal[], now: number): void {
    this.log(`land:${landing.id}`, "land", now);
    const landed = new Set(landing.proposalIds);
    for (const p of batch) {
      if (!landed.has(p.id)) continue;
      const eventId = `land:${landing.id}:${p.id}`;
      const prior = this.sql.exec<{ event_id: string }>("DELETE FROM intent_returns WHERE intent_id = ? RETURNING event_id", p.intentId).toArray()[0];
      this.sql.exec("INSERT OR IGNORE INTO causes (id, cause_id, at) VALUES (?, ?, ?)", eventId, prior?.event_id ?? null, now);
      for (const w of p.writeSet) {
        this.sql.exec(
          "INSERT INTO path_landing (path, blob, event_id, at) VALUES (?, ?, ?, ?) ON CONFLICT(path, blob) DO UPDATE SET event_id = excluded.event_id, at = excluded.at",
          w.path,
          w.blob ?? "",
          eventId,
          now,
        );
      }
    }
  }

  /** A return is a child of the landing that changed one of its stale paths (when known). */
  private recordReturn(p: Proposal, stale: OccResult["stale"] | null, now: number): void {
    let cause: string | null = null;
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
    this.sql.exec(
      "INSERT INTO intent_returns (intent_id, event_id, at) VALUES (?, ?, ?) ON CONFLICT(intent_id) DO UPDATE SET event_id = excluded.event_id, at = excluded.at",
      p.intentId,
      eventId,
      now,
    );
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
