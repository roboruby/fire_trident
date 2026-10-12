import { DurableObject } from "cloudflare:workers";
import {
  LATERAL_INHIBITION,
  admissionOpen,
  chooseIntent,
  directClaimOn,
  inhibited,
  markValue,
  newId,
  regionKey,
  regionOf,
  reinforceThreshold,
  repulsion,
  residualPaths,
  validateRule,
} from "@fire_trident/core";
// Direct import until packages/core/src/index.ts re-exports cochange.ts (orchestrator-owned).
import { neighborRepulsion } from "@fire_trident/core";
import type {
  AgentInfo,
  AgentKind,
  AgentState,
  Candidate,
  Colony,
  ColonyEvent,
  ColonySnapshot,
  Decision,
  DecisionLayer,
  Evidence,
  FieldReading,
  FileVersion,
  Id,
  Intent,
  IntentSource,
  IntentStatus,
  Landing,
  Path,
  Proposal,
  ProposalStatus,
  RepoRef,
  Rule,
  Sha,
  Violation,
  WorkspaceLease,
} from "@fire_trident/core";
import type { Env } from "../env.ts";
import { scanRule } from "../morph/scan.ts";
import type { RegionDO } from "../region/RegionDO.ts";
import { errorText, ftError } from "./errors.ts";
import { EventHub } from "./events.ts";
import { DecideEngine, type DecideHost, type TrunkRpc, type VaccinationResult } from "../decide/engine.ts";
import type { DecidePolicy } from "../decide/policy.ts";
import type { DetectorStats } from "../decide/store.ts";
import { DEFAULT_NOT_VERIFIED, FieldBatch, groupByRegion, jitter, normalizePath, normalizePaths, overlapCount, primaryRegion, violationIntents } from "./logic.ts";
import { NeighborCache, claimLookup, type Neighbor } from "../trunk/cochange.ts";
import {
  BUCKET_MS,
  COUNTER_SERIES,
  GAUGE_SERIES,
  REGISTRY_NAME,
  SERIES_BUCKETS,
  SERIES_KEEP_MINUTES,
  STOP_GRACE_MS,
  agentCounters,
  changedMetrics,
  counterBuckets,
  effectiveState,
  gaugeBuckets,
  minuteOf,
  seriesStart,
  stableMetrics,
  summaryOf,
} from "./metrics.ts";
import type { AgentListEntry, ColonySeries, ColonySummary, RegistryEntry, SnapshotWithSeries } from "./metrics.ts";

/** Result of ColonyDO.take: an assignment, or advice to wait and retry. */
export type TakeResult = { intent: Intent; lease: WorkspaceLease; rule?: Rule } | { wait: true; retryInMs: number; reason: string };

/** Input of ColonyDO.addIntent. */
export type IntentInput = Omit<Intent, "id" | "status" | "createdAt">;

/** Input of ColonyDO.propose. */
export type ProposalInput = Omit<Proposal, "id" | "status" | "createdAt" | "evidence"> & { evidence?: Partial<Evidence> };

/** Input of ColonyDO.init. */
export interface ColonyInit {
  colonyId: Id;
  name: string;
  trunk: RepoRef;
  trunkSha: Sha;
  source?: { url: string; branch?: string };
  regionDepth?: number;
}

/** A decision recorded by another layer (reflex or LLM triage). */
export type DecisionInput = Omit<Decision, "id" | "colonyId" | "at"> & { at?: number };

/** Open intents considered per take, by priority then age. */
const CANDIDATE_CAP = 200;
const CLAIM_STRENGTH = 1;
const FAILURE_STRENGTH = 0.5;
const TRAIL_STRENGTH = 1;
const LEASE_RETRY_MS = 2_000;
const IDLE_RETRY_MS = 5_000;
const DECLINED_RETRY_MS = 1_500;
const CLOSED_RETRY_MS = 3_000;
const BUSY_RETRY_MS = 500;
/** Claims younger than this are overlaid on field readings that may predate them. */
const RECENT_CLAIM_MS = 10_000;
/** Concurrent takes share a region reading this young (claims made since are overlaid). */
const READING_TTL_MS = 250;
/** Picks re-tried when a concurrent take wins the chosen intent. */
const PICK_ATTEMPTS = 8;
/** Heartbeats refresh claim marks at most this often (claims decay with tau = 5 min). */
const CLAIM_REFRESH_MS = 15_000;
/** Agents silent for this long are declared dead and their claimed intents reopened. */
const AGENT_TTL_MS = 10 * 60_000;
const REAP_EVERY_MS = 30_000;
/** A held lease is handed back on a repeated take only while its token has this much life left. */
const LEASE_MIN_LIFE_MS = 60_000;
const SNAPSHOT_ACTIVE_CAP = 5_000;
const SNAPSHOT_DONE_CAP = 200;
const SNAPSHOT_AGENT_CAP = 5_000;
const LANDINGS_KEEP = 1_000;
const RATE_WINDOW_MS = 60_000;
/**
 * Co-change repulsion: a claim on a file also repels work on the files that change with it
 * (TrunkDO's co-change map), weighted by their coupling and then by this (FT_COCHANGE_WEIGHT
 * overrides it; 0 turns it off). 2 cut simulated rework on hono's history from 42% to 39% at 1,000
 * agents with no throughput cost on per-lane landing; with group commit it costs about 6% of
 * throughput (packages/bench/results/2026-10-12-cochange).
 */
const COCHANGE_WEIGHT = 2;
/** Neighbors read per footprint file, and how long a take waits for neighbors it has not cached. */
const COCHANGE_K = 8;
const COCHANGE_WAIT_MS = 150;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS colony (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, trunk TEXT NOT NULL, trunk_sha TEXT NOT NULL, green_sha TEXT,
    source TEXT, created_at INTEGER NOT NULL, region_depth INTEGER NOT NULL, last_landing_at INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS intents (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, why TEXT NOT NULL, source TEXT NOT NULL, rule_id TEXT, parent_id TEXT,
    footprint TEXT NOT NULL, acceptance TEXT, priority REAL NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL,
    created_by TEXT NOT NULL, assigned_to TEXT, violations INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)`,
  "CREATE INDEX IF NOT EXISTS intents_by_status ON intents(status, priority DESC, created_at)",
  "CREATE INDEX IF NOT EXISTS intents_by_agent ON intents(assigned_to, status)",
  "CREATE INDEX IF NOT EXISTS intents_by_update ON intents(status, updated_at)",
  `CREATE TABLE IF NOT EXISTS rules (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, spec TEXT NOT NULL, description TEXT NOT NULL, approved_by TEXT NOT NULL,
    created_at INTEGER NOT NULL, open_violations INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, model TEXT, thresholds TEXT NOT NULL DEFAULT '{}',
    state TEXT NOT NULL, intent_id TEXT, workspace TEXT, last_seen INTEGER NOT NULL, created_at INTEGER NOT NULL)`,
  "CREATE INDEX IF NOT EXISTS agents_by_seen ON agents(state, last_seen)",
  `CREATE TABLE IF NOT EXISTS proposals (
    id TEXT PRIMARY KEY, intent_id TEXT NOT NULL, agent_id TEXT NOT NULL, status TEXT NOT NULL, region TEXT NOT NULL,
    priority REAL NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, data TEXT NOT NULL)`,
  "CREATE INDEX IF NOT EXISTS proposals_by_status ON proposals(status, created_at)",
  "CREATE INDEX IF NOT EXISTS proposals_by_agent ON proposals(agent_id, created_at)",
  `CREATE TABLE IF NOT EXISTS decisions (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, subject TEXT NOT NULL, layer TEXT NOT NULL, answers TEXT NOT NULL,
    p REAL NOT NULL, action TEXT NOT NULL, at INTEGER NOT NULL, escalated_from TEXT)`,
  "CREATE INDEX IF NOT EXISTS decisions_by_subject ON decisions(subject)",
  "CREATE TABLE IF NOT EXISTS funnel (layer TEXT PRIMARY KEY, n INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS metrics (name TEXT PRIMARY KEY, value REAL NOT NULL, at INTEGER NOT NULL)",
  `CREATE TABLE IF NOT EXISTS landings (
    id TEXT PRIMARY KEY, at INTEGER NOT NULL, received_at INTEGER NOT NULL, trunk_sha TEXT NOT NULL, data TEXT NOT NULL)`,
  "CREATE INDEX IF NOT EXISTS landings_by_received ON landings(received_at)",
  "CREATE TABLE IF NOT EXISTS regions (name TEXT PRIMARY KEY, created_at INTEGER NOT NULL)",
];

/** Operations tables: per-minute series (counters and gauges) and agents stopped through the API. */
const OPS_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS series (name TEXT NOT NULL, minute INTEGER NOT NULL, value REAL NOT NULL, PRIMARY KEY (name, minute))",
  "CREATE TABLE IF NOT EXISTS agent_stops (agent_id TEXT PRIMARY KEY, at INTEGER NOT NULL, reason TEXT NOT NULL)",
];
/** Registry tables, created only in the registry instance. */
const REGISTRY_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS registry (id TEXT PRIMARY KEY, name TEXT NOT NULL, source TEXT, created_at INTEGER NOT NULL, registered_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS registry_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)",
];
/** While UI sockets are connected, live metrics are re-sent this often (only those that changed)... */
const METRICS_TICK_MS = 3_000;
/** ...and all of them this often. */
const METRICS_FULL_MS = 30_000;
const SERIES_PRUNE_EVERY_MS = 10 * 60_000;
/** Agents listed by listAgents at most. */
const LIST_AGENTS_CAP = 10_000;

type ColonyRow = {
  id: string;
  name: string;
  trunk: string;
  trunk_sha: string;
  green_sha: string | null;
  source: string | null;
  created_at: number;
  region_depth: number;
  last_landing_at: number;
};

type IntentRow = {
  id: string;
  title: string;
  why: string;
  source: string;
  rule_id: string | null;
  parent_id: string | null;
  footprint: string;
  acceptance: string | null;
  priority: number;
  status: string;
  created_at: number;
  created_by: string;
  assigned_to: string | null;
  violations: number;
  updated_at: number;
};

type RuleRow = {
  id: string;
  kind: string;
  spec: string;
  description: string;
  approved_by: string;
  created_at: number;
  open_violations: number;
};

type AgentRow = {
  id: string;
  kind: string;
  name: string;
  model: string | null;
  thresholds: string;
  state: string;
  intent_id: string | null;
  workspace: string | null;
  last_seen: number;
  created_at: number;
};

type ProposalRow = {
  id: string;
  intent_id: string;
  agent_id: string;
  status: string;
  region: string;
  priority: number;
  created_at: number;
  updated_at: number;
  data: string;
};

/** A region reading shared by concurrent takes. */
interface ReadingEntry {
  fetchStart: number;
  paths: Set<Path>;
  promise: Promise<FieldReading | null>;
}

/** One region as self-assignment sees it. */
interface FieldView {
  /** Claim and danger values per path, the reader's own claims removed. */
  byPath: FieldReading["byPath"];
  repulsive: boolean;
  /** Recent claims of other agents the reading may not include. */
  unseen: Array<{ paths: Set<Path>; regions: Set<string> }>;
  open: boolean;
}

/** Side effects collected while changing proposal states, applied together. */
interface Effects {
  batch: FieldBatch;
  events: ColonyEvent[];
  enqueue: Array<{ proposal: Proposal; region: string; priority: number }>;
  dequeue: Map<string, Id[]>;
  release: Set<Id>;
}

function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (text === null || text === undefined || text === "") return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** A lease with both tokens blanked, for public output. */
function redactLease(lease: WorkspaceLease): WorkspaceLease {
  const out: WorkspaceLease = { ...lease, token: "" };
  if (lease.trunk) out.trunk = { ...lease.trunk, token: "" };
  return out;
}

const OPEN_LIKE: ReadonlySet<string> = new Set(["pending", "checking", "ready"]);
const SENT_BACK: ReadonlySet<string> = new Set(["returned", "rejected"]);

/**
 * One colony: config, intents, rules, agents, proposals index, review queue,
 * decision funnel, metrics, and the live WebSocket hub. Named by colonyId.
 * Field state lives in RegionDOs; trunk state in TrunkDO; workspaces in PoolDO.
 */
export class ColonyDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private readonly hub: EventHub;
  private colonyCache: { colony: Colony; lastLandingAt: number } | null = null;
  private readonly configured = new Map<string, Promise<void>>();
  /**
   * Claims made by recent takes (agentId → footprint), with the time their
   * deposit finished (null while in flight). A take overlays the ones its field
   * reading may have missed onto repulsion and admission, so a burst of
   * concurrent takes does not pile onto the same paths or overfill a region.
   */
  private readonly recentClaims = new Map<Id, { paths: Set<Path>; regions: Set<string>; doneAt: number | null }>();
  /** Shared field readings for self-assignment (see readRegions). */
  private readonly readingCache = new Map<string, ReadingEntry>();
  /** Agents with a take in progress (waiting on the pool). */
  private readonly taking = new Set<Id>();
  private readonly lastRefresh = new Map<Id, number>();
  private readonly footprintCache = new Map<Id, Path[]>();
  private lastReap = 0;
  /** Randomness for self-assignment; tests may replace it. */
  protected rand: () => number = Math.random;
  /** Live metric values last broadcast by the metrics tick. */
  private readonly sentMetrics = new Map<string, number>();
  private lastFullMetricsAt = 0;
  private lastSeriesPrune = 0;
  /** Co-change neighbors of footprint files, cached from TrunkDO.neighbors (fails open). */
  private readonly cochange = new NeighborCache(
    (paths) => this.trunkStub().neighbors(paths, COCHANGE_K) as unknown as Promise<Record<Path, Neighbor[]>>,
  );

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    for (const stmt of SCHEMA) this.sql.exec(stmt);
    for (const stmt of OPS_SCHEMA) this.sql.exec(stmt);
    this.backfillSeries();
    this.hub = new EventHub(() => this.ctx.getWebSockets());
    try {
      ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    } catch {
      // Older runtimes: webSocketMessage answers pings instead.
    }
    // The decide engine runs in memory, so an eviction orphans proposals in "checking".
    // Restart all of them as soon as the object wakes (the future `now` treats every one as stuck).
    queueMicrotask(() => {
      try {
        this.decider().sweep(Date.now() + 24 * 60 * 60_000);
      } catch {
        // No colony yet, or Workers AI unbound: nothing to resume.
      }
    });
  }

  // =========================================================================
  // Colony
  // =========================================================================

  /** Create the colony record (idempotent: returns the existing colony if already initialized). */
  async init(p: ColonyInit): Promise<Colony> {
    const existing = this.loadColony();
    if (existing) return existing.colony;
    if (!p.colonyId || !p.name || !p.trunk || !p.trunkSha) throw ftError(400, "colonyId, name, trunk and trunkSha are required");
    const depth = typeof p.regionDepth === "number" && Number.isInteger(p.regionDepth) && p.regionDepth >= 1 ? Math.min(p.regionDepth, 8) : 1;
    const source = p.source ? { url: p.source.url, branch: p.source.branch || "main" } : null;
    this.sql.exec(
      "INSERT INTO colony (id, name, trunk, trunk_sha, green_sha, source, created_at, region_depth, last_landing_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 0)",
      p.colonyId,
      p.name,
      JSON.stringify(p.trunk),
      p.trunkSha,
      source ? JSON.stringify(source) : null,
      Date.now(),
      depth,
    );
    this.colonyCache = null;
    return this.requireColony();
  }

  /** The colony record, or null before init. */
  async getColony(): Promise<Colony | null> {
    return this.loadColony()?.colony ?? null;
  }

  /** Regions this colony has touched (field or lane). */
  async listRegions(): Promise<string[]> {
    return this.sql.exec<{ name: string }>("SELECT name FROM regions ORDER BY name").toArray().map((r) => r.name);
  }

  /**
   * Everything the UI needs before applying live events. Lease tokens are redacted.
   * `metrics` always carries every METRIC_KEYS entry; `series` holds the last 30 minutes.
   */
  async snapshot(): Promise<SnapshotWithSeries> {
    const colony = this.requireColony();
    const now = Date.now();
    this.maybeReap(now);
    const trunk = this.trunkStub();
    const [filesRes, landingsRes] = await Promise.allSettled([trunk.files(), trunk.landings(20)]);
    const files =
      filesRes.status === "fulfilled" && Array.isArray(filesRes.value) ? filesRes.value.map((f) => ({ path: f.path, size: f.size })) : [];
    if (filesRes.status === "rejected") console.warn(`snapshot: TrunkDO.files failed: ${errorText(filesRes.reason)}`);
    let recentLandings: Landing[];
    if (landingsRes.status === "fulfilled" && Array.isArray(landingsRes.value)) recentLandings = landingsRes.value as Landing[];
    else {
      recentLandings = this.sql
        .exec<{ data: string }>("SELECT data FROM landings ORDER BY at DESC LIMIT 20")
        .toArray()
        .map((r) => parseJson<Landing>(r.data, null as unknown as Landing))
        .filter(Boolean);
    }

    const intents = [
      ...this.sql
        .exec<IntentRow>("SELECT * FROM intents WHERE status IN ('open', 'claimed', 'proposed') ORDER BY priority DESC, created_at ASC LIMIT ?", SNAPSHOT_ACTIVE_CAP)
        .toArray(),
      ...this.sql
        .exec<IntentRow>("SELECT * FROM intents WHERE status IN ('landed', 'abandoned') ORDER BY updated_at DESC LIMIT ?", SNAPSHOT_DONE_CAP)
        .toArray(),
    ].map((r) => this.toIntent(r, colony.id));
    const agents = this.sql
      .exec<AgentRow & { stopped_at: number | null }>(
        "SELECT a.*, s.at AS stopped_at FROM agents a LEFT JOIN agent_stops s ON s.agent_id = a.id WHERE a.state != 'dead' OR a.last_seen > ? ORDER BY a.last_seen DESC LIMIT ?",
        now - 60 * 60_000,
        SNAPSHOT_AGENT_CAP,
      )
      .toArray()
      .map((r) => {
        const a = this.toAgent(r, colony.id, true);
        a.state = effectiveState(a.state, r.last_seen, r.stopped_at);
        return a;
      });
    return {
      colony,
      files,
      intents,
      agents,
      recentLandings,
      violations: this.violationTotals(),
      funnel: this.funnelCounts(),
      metrics: this.currentMetrics(now),
      rules: this.sql.exec<RuleRow>("SELECT * FROM rules ORDER BY created_at").toArray().map((r) => this.toRule(r, colony.id)),
      series: this.seriesReport(now),
    };
  }

  // =========================================================================
  // Intents and rules
  // =========================================================================

  /** Declare an intent; deposits `need` marks (strength = priority) on its footprint. */
  async addIntent(i: IntentInput): Promise<Intent> {
    const [intent] = await this.createIntents([i]);
    if (!intent) throw ftError(500, "intent was not created");
    return intent;
  }

  /** One intent by id. */
  async getIntent(id: Id): Promise<Intent | null> {
    const row = this.intentRow(id);
    return row ? this.toIntent(row, this.requireColony().id) : null;
  }

  /** Add a morphology rule: scan trunk, one `rule` intent per violating file. */
  async addRule(r: Omit<Rule, "id" | "createdAt">): Promise<{ rule: Rule; violations: number; intents: number }> {
    const colony = this.requireColony();
    const problems = validateRule({ kind: r.kind, spec: r.spec ?? {} });
    if (problems.length > 0) throw ftError(400, `invalid rule: ${problems.join("; ")}`);
    if (!r.description || !r.description.trim()) throw ftError(400, "rule description is required");
    const rule: Rule = {
      id: newId("rul_"),
      colonyId: colony.id,
      kind: r.kind,
      spec: r.spec ?? {},
      description: r.description.trim(),
      approvedBy: r.approvedBy || "unknown",
      createdAt: Date.now(),
    };
    const violations = await this.scan(rule);
    const drafts = violationIntents(rule, violations);
    const open = drafts.reduce((n, d) => n + d.violations, 0);
    this.sql.exec(
      "INSERT INTO rules (id, kind, spec, description, approved_by, created_at, open_violations) VALUES (?, ?, ?, ?, ?, ?, ?)",
      rule.id,
      rule.kind,
      JSON.stringify(rule.spec),
      rule.description,
      rule.approvedBy,
      rule.createdAt,
      open,
    );
    const intents = await this.createIntents(
      drafts.map((d) => ({
        colonyId: colony.id,
        title: d.title,
        why: d.why,
        source: "rule" as const,
        ruleId: rule.id,
        footprint: [d.path],
        priority: 1,
        createdBy: rule.approvedBy,
        violations: d.violations,
      })),
    );
    this.hub.push(this.violationsEvent(Date.now()));
    return { rule, violations: open, intents: intents.length };
  }

  /** One rule by id. */
  async getRule(id: Id): Promise<Rule | null> {
    const row = this.sql.exec<RuleRow>("SELECT * FROM rules WHERE id = ?", id).toArray()[0];
    return row ? this.toRule(row, this.requireColony().id) : null;
  }

  /** Scan trunk for a rule's violations (separate so tests can substitute it). */
  protected async scan(rule: Rule): Promise<Violation[]> {
    return scanRule(this.env, rule.colonyId, rule);
  }

  // =========================================================================
  // Agents
  // =========================================================================

  /** Register one agent. */
  async registerAgent(a: { kind: AgentKind; name: string; model?: string }): Promise<AgentInfo> {
    const [agent] = await this.registerAgents([a]);
    if (!agent) throw ftError(500, "agent was not registered");
    return agent;
  }

  /** Register many agents in one call (swarms). */
  async registerAgents(list: Array<{ kind: AgentKind; name: string; model?: string }>): Promise<AgentInfo[]> {
    const colony = this.requireColony();
    const now = Date.now();
    const out: AgentInfo[] = [];
    const events: ColonyEvent[] = [];
    for (const a of list) {
      const kind: AgentKind = a.kind === "internal" || a.kind === "synthetic" ? a.kind : "external";
      const id = newId("agt_");
      const name = (a.name ?? "").trim() || id;
      this.sql.exec(
        "INSERT INTO agents (id, kind, name, model, thresholds, state, intent_id, workspace, last_seen, created_at) VALUES (?, ?, ?, ?, '{}', 'idle', NULL, NULL, ?, ?)",
        id,
        kind,
        name,
        a.model ?? null,
        now,
        now,
      );
      const info: AgentInfo = { id, colonyId: colony.id, kind, name, thresholds: {}, state: "idle", lastSeen: now };
      if (a.model) info.model = a.model;
      out.push(info);
      events.push({ t: "agent", at: now, agentId: id, kind, state: "idle" });
    }
    if (out.length > 0) {
      this.bump("agents", out.length, now);
      this.hub.push(events);
    }
    return out;
  }

  /** One agent (with its lease, for the agent itself). */
  async getAgent(agentId: Id): Promise<AgentInfo | null> {
    const row = this.agentRow(agentId);
    return row ? this.toAgent(row, this.requireColony().id, false) : null;
  }

  /**
   * The intents and agents a landing's lineage note needs, in one call. Lanes pass
   * this to TrunkDO.land so the trunk writer never has to pull a full snapshot.
   */
  async landContext(intentIds: Id[], agentIds: Id[]): Promise<{
    intents: Record<Id, { title: string; why: string; ruleId?: Id; parentId?: Id }>;
    agents: Record<Id, { kind: AgentKind; model?: string }>;
  }> {
    const colonyId = this.requireColony().id;
    const intents: Record<Id, { title: string; why: string; ruleId?: Id; parentId?: Id }> = {};
    for (const id of new Set(intentIds)) {
      const row = this.intentRow(id);
      if (!row) continue;
      const i = this.toIntent(row, colonyId);
      intents[id] = { title: i.title, why: i.why, ...(i.ruleId ? { ruleId: i.ruleId } : {}), ...(i.parentId ? { parentId: i.parentId } : {}) };
    }
    const agents: Record<Id, { kind: AgentKind; model?: string }> = {};
    for (const id of new Set(agentIds)) {
      const row = this.agentRow(id);
      if (!row) continue;
      const a = this.toAgent(row, colonyId, false);
      agents[id] = { kind: a.kind, ...(a.model ? { model: a.model } : {}) };
    }
    return { intents, agents };
  }

  /**
   * Self-assignment. Reads the field of every region the top open intents
   * touch, computes repulsion from other agents' claims, skips intents whose
   * own files another agent holds a live claim on (lateral inhibition), and
   * applies the response-threshold rule. On success: claims the intent, leases a workspace
   * and deposits `claim` marks. A repeated take returns the held assignment.
   */
  async take(agentId: Id): Promise<TakeResult> {
    this.requireColony();
    this.requireAgent(agentId);
    // One take per agent at a time: a second one could reserve another intent while the first awaits.
    if (this.taking.has(agentId)) return { wait: true, retryInMs: BUSY_RETRY_MS, reason: "take already in progress" };
    this.taking.add(agentId);
    try {
      return await this.takeFor(agentId);
    } finally {
      this.taking.delete(agentId);
    }
  }

  private async takeFor(agentId: Id): Promise<TakeResult> {
    const colony = this.requireColony();
    const agent = this.requireAgent(agentId);
    const now = Date.now();
    this.sql.exec("UPDATE agents SET last_seen = ?, state = CASE WHEN state = 'dead' THEN 'idle' ELSE state END WHERE id = ?", now, agentId);
    this.maybeReap(now);

    // Idempotent: hand back an assignment the agent already holds.
    if (agent.intent_id) {
      const held = this.intentRow(agent.intent_id);
      if (held && held.status === "claimed" && held.assigned_to === agentId) {
        const lease = parseJson<WorkspaceLease | null>(agent.workspace, null);
        const intent = this.toIntent(held, colony.id);
        if (lease && lease.tokenExpiresAt > now + LEASE_MIN_LIFE_MS) return this.assignment(intent, lease);
        return this.leaseAndClaim(agentId, agent.kind as AgentKind, intent);
      }
    }

    // Only the columns self-assignment needs; the winner is loaded in full.
    const rows = this.sql
      .exec<{ id: string; footprint: string; priority: number; created_at: number }>(
        "SELECT id, footprint, priority, created_at FROM intents WHERE status = 'open' ORDER BY priority DESC, created_at ASC LIMIT ?",
        CANDIDATE_CAP,
      )
      .toArray();
    if (rows.length === 0) {
      this.setAgentState(agentId, "waiting", now);
      return { wait: true, retryInMs: jitter(IDLE_RETRY_MS, this.rand), reason: "no open intents" };
    }
    const depth = colony.regionDepth;
    const intents = rows.map(
      (r) => ({ id: r.id, colonyId: colony.id, footprint: this.footprintOf(r.id, r.footprint), priority: r.priority, createdAt: r.created_at }) as Intent,
    );
    const perIntent = intents.map((i) => groupByRegion(i.footprint, depth));
    const wanted = new Map<string, Set<Path>>();
    const want = (region: string, path: Path): void => {
      let set = wanted.get(region);
      if (!set) {
        set = new Set();
        wanted.set(region, set);
      }
      set.add(path);
    };
    for (const regions of perIntent) {
      for (const [region, paths] of regions) for (const p of paths) want(region, p);
    }
    // Files that change together wire together: read the claims on each footprint file's co-change neighbors too.
    const cochangeWeight = this.cochangeWeight();
    const neighbors = cochangeWeight > 0 ? await this.cochange.get(intents.flatMap((i) => i.footprint), now, COCHANGE_WAIT_MS) : new Map<Path, Neighbor[]>();
    for (const nbs of neighbors.values()) for (const nb of nbs) want(regionOf(nb.path, depth), nb.path);
    const readings = await this.readRegions(wanted);
    const views = this.fieldViews(agentId, readings, depth);
    const claimOn = claimLookup(views, (p) => regionOf(p, depth), CLAIM_STRENGTH);
    const neighborsOf = (p: Path): Neighbor[] | undefined => neighbors.get(p);
    const candidates: Candidate[] = intents.map((intent, idx) => {
      let rep = 0;
      // Lateral inhibition: other agents' live claims on the intent's own files, kept apart from the
      // soft repulsion (which still counts them, plus overlaps, danger and co-change neighbors).
      let direct = 0;
      let open = true;
      let primary = ".";
      let most = 0;
      for (const [region, paths] of perIntent[idx] ?? new Map<string, Path[]>()) {
        if (paths.length > most) {
          primary = region;
          most = paths.length;
        }
        const view = views.get(region);
        if (!view) continue; // unreadable region: fail open
        if (view.repulsive) {
          rep += repulsion(view.byPath, paths);
          direct += directClaimOn(view.byPath, paths);
        }
        for (const c of view.unseen) {
          rep += CLAIM_STRENGTH * overlapCount(c.paths, paths);
          for (const p of paths) if (c.paths.has(p)) direct += CLAIM_STRENGTH;
        }
        if (!view.open) open = false;
      }
      if (neighbors.size > 0) rep += cochangeWeight * neighborRepulsion(intent.footprint, neighborsOf, claimOn);
      return { intent, region: primary, repulsion: rep, directClaim: direct, admissionOpen: open };
    });

    const thresholds = parseJson<Record<string, number>>(agent.thresholds, {});
    const inhibitAt = this.inhibitAt();
    let pool = candidates;
    for (let attempt = 0; attempt < PICK_ATTEMPTS && pool.length > 0; attempt++) {
      const pick = chooseIntent(pool, thresholds, Date.now(), this.rand, undefined, inhibitAt);
      if (!pick) break;
      if (this.reserve(pick.intent.id, agentId)) {
        const full = this.intentRow(pick.intent.id);
        return this.leaseAndClaim(agentId, agent.kind as AgentKind, full ? this.toIntent(full, colony.id) : pick.intent);
      }
      // Lost a race: drop every candidate that concurrent takes claimed meanwhile, not just this one.
      const stillOpen = this.openAmong(pool.map((c) => c.intent.id));
      pool = pool.filter((c) => stillOpen.has(c.intent.id));
    }
    this.setAgentState(agentId, "waiting", Date.now());
    if (candidates.every((c) => !c.admissionOpen)) {
      return { wait: true, retryInMs: jitter(CLOSED_RETRY_MS, this.rand), reason: "admission closed in every candidate region" };
    }
    if (candidates.every((c) => !c.admissionOpen || inhibited(c, inhibitAt))) {
      return { wait: true, retryInMs: jitter(CLOSED_RETRY_MS, this.rand), reason: "every open intent's files are claimed by another agent" };
    }
    return { wait: true, retryInMs: jitter(DECLINED_RETRY_MS, this.rand), reason: "no intent accepted at this agent's thresholds" };
  }

  /** Liveness: refresh the agent's claim marks (at most every 15 s) and its last-seen time. */
  async heartbeat(agentId: Id): Promise<void> {
    const colony = this.requireColony();
    const agent = this.requireAgent(agentId);
    const now = Date.now();
    this.sql.exec("UPDATE agents SET last_seen = ? WHERE id = ?", now, agentId);
    if (agent.state === "dead") this.setAgentState(agentId, "idle", now);
    this.maybeReap(now);
    if (now - (this.lastRefresh.get(agentId) ?? 0) < CLAIM_REFRESH_MS) return;
    const held = this.sql
      .exec<{ id: string; footprint: string }>("SELECT id, footprint FROM intents WHERE assigned_to = ? AND status IN ('claimed', 'proposed')", agentId)
      .toArray();
    if (held.length === 0) return;
    this.lastRefresh.set(agentId, now);
    const batch = new FieldBatch(colony.regionDepth);
    for (const h of held) batch.deposit("claim", this.footprintOf(h.id, h.footprint), CLAIM_STRENGTH, now, { agentId, intentId: h.id });
    await this.applyField(batch);
  }

  /** Give up a claimed intent: it reopens, claims are cleared and a failure mark is left. */
  async abandon(agentId: Id, reason = "abandoned by agent"): Promise<void> {
    const colony = this.requireColony();
    const agent = this.requireAgent(agentId);
    const now = Date.now();
    const fx = this.effects(colony.regionDepth);
    const held = this.sql.exec<IntentRow>("SELECT * FROM intents WHERE assigned_to = ? AND status = 'claimed'", agentId).toArray();
    for (const row of held) {
      const fp = this.footprintOf(row.id, row.footprint);
      this.sql.exec("UPDATE intents SET status = 'open', assigned_to = NULL, updated_at = ? WHERE id = ?", now, row.id);
      fx.batch.clear(fp, { agentId, intentId: row.id, kind: "claim" }).deposit("failure", fp, FAILURE_STRENGTH, now, { agentId, intentId: row.id });
      fx.events.push({ t: "intent", at: now, intentId: row.id, status: "open", title: row.title, footprint: fp });
    }
    this.sql.exec("UPDATE agents SET state = 'idle', intent_id = NULL, workspace = NULL WHERE id = ?", agentId);
    fx.events.push({ t: "agent", at: now, agentId, kind: agent.kind as AgentKind, state: "idle" });
    fx.release.add(agentId);
    if (held.length > 0) console.log(`agent ${agentId} abandoned ${held.length} intent(s): ${reason}`);
    await this.flushEffects(fx);
  }

  // =========================================================================
  // Proposals
  // =========================================================================

  /**
   * Record a proposal: residual (writes outside the declared footprint), the
   * mandatory not-verified statement, innate checks (hook), then the lane of
   * its primary region.
   */
  async propose(input: ProposalInput): Promise<Proposal> {
    const colony = this.requireColony();
    this.requireAgent(input.agentId);
    const intentRow = this.intentRow(input.intentId);
    if (!intentRow) throw ftError(404, `unknown intent ${input.intentId}`);
    // Idempotent: a retry of the same (agent, intent, head commit) gets the proposal it already made,
    // even after that proposal landed or went back.
    const repeat = this.repeatedProposal(input.agentId, intentRow.id, input.headSha);
    if (repeat) return repeat;
    this.assertProposable(intentRow, input.agentId);
    const writeSet = this.normalizeVersions(input.writeSet);
    if (writeSet.length === 0) throw ftError(400, "proposal write set is empty");
    const readSet = this.normalizeVersions(input.readSet);
    const declaredFootprint = normalizePaths(input.declared?.footprint ?? []);
    const footprint = declaredFootprint.length > 0 ? declaredFootprint : this.footprintOf(intentRow.id, intentRow.footprint);
    const now = Date.now();
    const ev = input.evidence ?? {};
    const evidence: Evidence = {
      checks: Array.isArray(ev.checks) ? ev.checks : [],
      residual: residualPaths(footprint, writeSet),
      notVerified: typeof ev.notVerified === "string" && ev.notVerified.trim() ? ev.notVerified.trim() : DEFAULT_NOT_VERIFIED,
    };
    if (typeof ev.previewUrl === "string" && ev.previewUrl) evidence.previewUrl = ev.previewUrl;
    const draft: Proposal = {
      id: newId("prp_"),
      colonyId: colony.id,
      intentId: intentRow.id,
      agentId: input.agentId,
      workspace: input.workspace,
      baseSha: input.baseSha,
      headSha: input.headSha,
      writeSet,
      readSet,
      declared: { footprint, summary: input.declared?.summary ?? "" },
      evidence,
      status: "pending",
      createdAt: now,
    };

    // Decide prong (decide/engine.ts): with Workers AI bound, the proposal waits in "checking" while
    // innate checks, the reflex arc and the two-signal gate decide where it goes; without it, it
    // goes straight to its lane. A sealed vaccine always takes the decide path, so it can never reach a lane.
    const engine = this.decider();
    const deciding = engine.enabled() || engine.store.vaccineByIntent(intentRow.id) !== null;
    const proposal: Proposal = { ...draft, status: deciding ? "checking" : OPEN_LIKE.has(draft.status) ? "ready" : draft.status };

    const fresh = this.intentRow(proposal.intentId);
    if (!fresh) throw ftError(404, `unknown intent ${proposal.intentId}`);
    this.assertProposable(fresh, proposal.agentId);

    const region = primaryRegion(writeSet.map((w) => w.path), colony.regionDepth);
    this.sql.exec(
      "INSERT INTO proposals (id, intent_id, agent_id, status, region, priority, created_at, updated_at, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      proposal.id,
      proposal.intentId,
      proposal.agentId,
      proposal.status,
      region,
      fresh.priority,
      now,
      now,
      JSON.stringify(proposal),
    );
    this.bump("proposals", 1, now);
    const fx = this.effects(colony.regionDepth);
    this.transition(proposal, "pending", now, fx);
    if (deciding && fresh.status === "claimed") {
      // A proposal under review holds its intent as proposed, so the reaper never reopens it mid-review.
      this.sql.exec("UPDATE intents SET status = 'proposed', updated_at = ? WHERE id = ? AND status = 'claimed'", now, fresh.id);
      fx.events.push({ t: "intent", at: now, intentId: fresh.id, status: "proposed", title: fresh.title, footprint: this.footprintOf(fresh.id, fresh.footprint) });
    }
    await this.flushEffects(fx);
    if (deciding) {
      engine.start(proposal.id);
      engine.sweep(now);
    }
    return this.getProposalSync(proposal.id) ?? proposal;
  }

  /** One proposal by id (agents poll their outcome). */
  async getProposal(id: Id): Promise<Proposal | null> {
    return this.getProposalSync(id);
  }

  /** An agent's recent proposals, newest first (its inbox of outcomes). */
  async inbox(agentId: Id, limit = 20): Promise<Proposal[]> {
    const n = Math.max(1, Math.min(200, Math.floor(limit)));
    return this.sql
      .exec<{ data: string }>("SELECT data FROM proposals WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?", agentId, n)
      .toArray()
      .map((r) => JSON.parse(r.data) as Proposal);
  }

  /** Patch one proposal (RegionDO/TrunkDO). Status changes carry their side effects. */
  async updateProposal(id: Id, patch: Partial<Proposal>): Promise<void> {
    await this.updateProposals([{ id, patch }]);
  }

  /** Patch many proposals in one call (a lane tick's returns). */
  async updateProposals(items: Array<{ id: Id; patch: Partial<Proposal> }>): Promise<void> {
    const colony = this.requireColony();
    const now = Date.now();
    const fx = this.effects(colony.regionDepth);
    for (const { id, patch } of items) {
      const row = this.proposalRow(id);
      if (!row) continue;
      const prev = JSON.parse(row.data) as Proposal;
      // Landed and rejected are final; returned may only move to rejected.
      if (prev.status === "landed" || prev.status === "rejected") continue;
      if (prev.status === "returned" && patch.status !== undefined && patch.status !== "rejected") continue;
      const next: Proposal = {
        ...prev,
        ...patch,
        id: prev.id,
        colonyId: prev.colonyId,
        intentId: prev.intentId,
        agentId: prev.agentId,
        createdAt: prev.createdAt,
        evidence: patch.evidence ? { ...prev.evidence, ...patch.evidence } : prev.evidence,
      };
      if (!next.evidence.notVerified) next.evidence = { ...next.evidence, notVerified: DEFAULT_NOT_VERIFIED };
      this.writeProposal(next, now);
      this.transition(next, prev.status, now, fx);
    }
    await this.flushEffects(fx);
  }

  /**
   * A trunk commit landed: proposals and intents become landed, rule
   * violation counts drop, `trail` marks go on the landed paths, the agents'
   * claims are cleared and their thresholds for the region reinforced.
   * Idempotent per landing id (RegionDO and TrunkDO may both report it).
   */
  async onLanding(l: Landing): Promise<void> {
    const colony = this.requireColony();
    const now = Date.now();
    const inserted = this.sql
      .exec("INSERT OR IGNORE INTO landings (id, at, received_at, trunk_sha, data) VALUES (?, ?, ?, ?, ?) RETURNING id", l.id, l.at ?? now, now, l.trunkSha ?? "", JSON.stringify(l))
      .toArray();
    if (inserted.length === 0) return;
    const cached = this.loadColony();
    if (l.trunkSha && (l.at ?? now) >= (cached?.lastLandingAt ?? 0)) {
      this.sql.exec("UPDATE colony SET trunk_sha = ?, last_landing_at = ?", l.trunkSha, l.at ?? now);
      this.colonyCache = null;
    }

    const fx = this.effects(colony.regionDepth);
    const writtenPaths: Path[] = [];
    for (const pid of l.proposalIds ?? []) {
      const row = this.proposalRow(pid);
      if (!row) continue;
      const p = JSON.parse(row.data) as Proposal;
      for (const w of p.writeSet) writtenPaths.push(w.path);
      if (p.status === "landed") continue; // already settled through updateProposal
      const next: Proposal = { ...p, status: "landed", landingId: l.id };
      this.writeProposal(next, now);
      this.transition(next, p.status, now, fx);
    }
    // Intents named by the landing whose proposals this colony does not know.
    for (const iid of l.intentIds ?? []) this.landIntent(iid, now, fx);

    const paths = normalizePaths(l.paths && l.paths.length > 0 ? l.paths : writtenPaths);
    fx.batch.deposit("trail", paths, TRAIL_STRENGTH, now);
    fx.batch.landing(groupByRegion(paths, colony.regionDepth).keys(), l.id);

    this.bump("landings", 1, now);
    const perMin = this.landingsPerMin(now);
    this.setMetric("landingsPerMin", perMin, now);
    fx.events.push({ t: "landing", at: now, landingId: l.id, trunkSha: l.trunkSha, proposalIds: l.proposalIds ?? [], paths });
    fx.events.push({ t: "metric", at: now, name: "landingsPerMin", value: perMin });
    fx.events.push({ t: "metric", at: now, name: "landings", value: this.metric("landings") });
    this.pruneLandings();
    await this.flushEffects(fx);
  }

  /** The human review queue: escalated proposals, highest risk first, then oldest first. */
  async review(): Promise<Proposal[]> {
    this.requireColony();
    const engine = this.decider();
    engine.sweep();
    return this.sql
      .exec<{ data: string }>(
        `SELECT p.data AS data FROM proposals p LEFT JOIN decide_outcomes d ON d.proposal_id = p.id
         WHERE p.status = 'escalated' ORDER BY COALESCE(d.risk, 0) DESC, p.created_at ASC LIMIT 500`,
      )
      .toArray()
      .map((r) => JSON.parse(r.data) as Proposal);
  }

  /** A human decision on a proposal: approve (back to its lane), reject (intent reopened) or return. */
  async decide(proposalId: Id, d: "approve" | "reject" | "return", reason: string, by: string): Promise<void> {
    const colony = this.requireColony();
    if (d !== "approve" && d !== "reject" && d !== "return") throw ftError(400, `unknown decision ${String(d)}`);
    const row = this.proposalRow(proposalId);
    if (!row) throw ftError(404, `unknown proposal ${proposalId}`);
    const p = JSON.parse(row.data) as Proposal;
    if (p.status === "landed" || p.status === "rejected" || p.status === "returned") throw ftError(409, `proposal is already ${p.status}`);
    const engine = this.decider();
    if (d === "approve" && engine.store.vaccineByIntent(p.intentId)) throw ftError(409, "vaccine proposals are sealed and can never land");
    const now = Date.now();
    // The human decision continues the proposal's decision chain and is bound to its head commit.
    const prior = this.sql.exec<{ id: string }>("SELECT id FROM decisions WHERE subject = ? ORDER BY at DESC LIMIT 1", proposalId).toArray()[0]?.id;
    this.storeDecision(
      {
        id: newId("dec_"),
        colonyId: colony.id,
        kind: "triage",
        subject: proposalId,
        layer: "human",
        answers: { decision: d, reason, by, head: p.headSha },
        p: 1,
        action: d,
        at: now,
        ...(prior ? { escalatedFrom: prior } : {}),
      },
      now,
    );
    engine.onHumanDecision(p, d, reason, by);
    if (d === "approve") {
      if (p.status === "ready") return;
      await this.updateProposals([{ id: proposalId, patch: { status: "ready" } }]);
    } else {
      await this.updateProposals([{ id: proposalId, patch: { status: d === "reject" ? "rejected" : "returned", reason: reason || `${d} by ${by}` } }]);
    }
  }

  /** Record a decision made by another layer (reflex, LLM); feeds the funnel and the live stream. */
  async recordDecision(d: DecisionInput): Promise<Decision> {
    const colony = this.requireColony();
    const at = typeof d.at === "number" ? d.at : Date.now();
    const decision: Decision = { ...d, id: newId("dec_"), colonyId: colony.id, at };
    this.storeDecision(decision, at);
    return decision;
  }

  // =========================================================================
  // Decide prong: reflex arc, immune review, vaccination meter (decide/engine.ts)
  // =========================================================================

  private decideEngine: DecideEngine | null = null;

  /** Start a vaccination batch: sealed bad proposals through the normal propose path. */
  async vaccinate(p: { count?: number; classes?: string[] }): Promise<VaccinationResult> {
    this.requireColony();
    return this.decider().vaccinate(p ?? {});
  }

  /** The vaccination meter: recall per threat class with Wilson 95% intervals. */
  async vaccineReport(): Promise<Record<string, unknown>> {
    this.requireColony();
    const engine = this.decider();
    engine.sweep();
    return engine.vaccineReport();
  }

  /** Immune state: antibodies, detector probation, earned autonomy, alert budget, policy. */
  async immune(): Promise<Record<string, unknown>> {
    this.requireColony();
    return this.decider().immune();
  }

  /** Change the colony's decide policy (partial; numbers are clamped). */
  async setDecidePolicy(patch: unknown): Promise<DecidePolicy> {
    this.requireColony();
    return this.decider().store.setPolicy(patch);
  }

  /** Mark a detector (clef:<question> or antibody:<id>) useful or not useful. */
  async detectorFeedback(id: string, useful: boolean): Promise<DetectorStats> {
    this.requireColony();
    return this.decider().detectorFeedback(id, useful);
  }

  /** The decide pipeline, with this colony as its host (created on first use). */
  private decider(): DecideEngine {
    if (this.decideEngine) return this.decideEngine;
    const host: DecideHost = {
      env: this.env,
      sql: this.sql,
      waitUntil: (p) => this.ctx.waitUntil(p),
      colony: () => this.requireColony(),
      intent: (id) => {
        const r = this.intentRow(id);
        return r ? this.toIntent(r, this.requireColony().id) : null;
      },
      rules: () => {
        const colonyId = this.requireColony().id;
        return this.sql.exec<RuleRow>("SELECT * FROM rules ORDER BY created_at").toArray().map((r) => this.toRule(r, colonyId));
      },
      agent: (id) => {
        const r = this.agentRow(id);
        return r ? { kind: r.kind as AgentKind, name: r.name, ...(r.model ? { model: r.model } : {}) } : null;
      },
      proposal: (id) => this.getProposalSync(id),
      proposalRegion: (id) => this.proposalRow(id)?.region ?? ".",
      stuckChecking: (before) =>
        this.sql
          .exec<{ id: string }>("SELECT id FROM proposals WHERE status = 'checking' AND created_at < ? ORDER BY created_at LIMIT 50", before)
          .toArray()
          .map((r) => r.id),
      updateProposals: (items) => this.updateProposals(items),
      recordDecision: (d) => this.recordDecision(d),
      decisionsFor: (subject) =>
        this.sql
          .exec<{ id: string; kind: string; subject: string; layer: string; answers: string; p: number; action: string; at: number; escalated_from: string | null }>(
            "SELECT * FROM decisions WHERE subject = ? ORDER BY at",
            subject,
          )
          .toArray()
          .map((r) => ({
            id: r.id,
            colonyId: this.requireColony().id,
            kind: r.kind as Decision["kind"],
            subject: r.subject,
            layer: r.layer as DecisionLayer,
            answers: parseJson<Record<string, unknown>>(r.answers, {}),
            p: r.p,
            action: r.action,
            at: r.at,
            ...(r.escalated_from ? { escalatedFrom: r.escalated_from } : {}),
          })),
      bump: (name, delta) => void this.bump(name, delta, Date.now()),
      setMetric: (name, value) => this.setMetric(name, value, Date.now()),
      emit: (events) => void this.hub.push(events),
      trunk: () => this.trunkStub() as unknown as TrunkRpc,
      systemCommitted: async (l) => this.noteSystemCommit(l),
      vaccineAgent: () => this.vaccineAgent(),
      vaccineTargets: (limit) =>
        this.sql
          .exec<{ id: string; title: string; why: string; footprint: string; rule_id: string | null }>(
            `SELECT id, title, why, footprint, rule_id FROM intents WHERE rule_id IS NOT NULL AND created_by != 'vaccine'
             ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'claimed' THEN 1 WHEN 'proposed' THEN 2 ELSE 3 END, created_at LIMIT ?`,
            limit,
          )
          .toArray()
          .map((r) => ({ title: r.title, why: r.why, footprint: this.footprintOf(r.id, r.footprint), ...(r.rule_id ? { ruleId: r.rule_id } : {}) })),
      sealedIntent: (i) => this.sealedIntent(i),
      propose: (input) => this.propose(input),
      seal: (id, reason, evidence) => this.sealProposal(id, reason, evidence),
    };
    this.decideEngine = new DecideEngine(host);
    return this.decideEngine;
  }

  /** Returns that leave a retry of the same commit welcome (nothing was judged wrong with it). */
  private static readonly TRANSIENT_RETURN = /lane unavailable|landing failed|decide pipeline failed|head commit changed|second opinion unavailable|trunk kept moving/i;

  /**
   * The proposal this agent already made for this intent at this head commit, if any (agents retry
   * after timeouts). One sent back for a transient reason does not count: proposing the same commit
   * again is then a fresh attempt.
   */
  private repeatedProposal(agentId: Id, intentId: Id, headSha: string): Proposal | null {
    if (typeof headSha !== "string" || headSha === "") return null;
    const row = this.sql
      .exec<{ data: string }>(
        "SELECT data FROM proposals WHERE agent_id = ? AND intent_id = ? AND json_extract(data, '$.headSha') = ? ORDER BY created_at DESC LIMIT 1",
        agentId,
        intentId,
        headSha,
      )
      .toArray()[0];
    if (!row) return null;
    const p = JSON.parse(row.data) as Proposal;
    if (p.status === "returned" && ColonyDO.TRANSIENT_RETURN.test(p.reason ?? "")) return null;
    return p;
  }

  /** The colony's vaccine agent (registered once, marked seen on every batch so it is never reaped mid-batch). */
  private async vaccineAgent(): Promise<Id> {
    const store = this.decider().store;
    const known = store.meta("vaccineAgent");
    if (known && this.agentRow(known)) {
      this.sql.exec("UPDATE agents SET last_seen = ?, state = 'idle' WHERE id = ?", Date.now(), known);
      return known;
    }
    const [agent] = await this.registerAgents([{ kind: "synthetic", name: "vaccine", model: "vaccine" }]);
    if (!agent) throw ftError(500, "vaccine agent was not registered");
    store.setMeta("vaccineAgent", agent.id);
    return agent.id;
  }

  /** A claimed intent for the vaccine agent: no need or claim marks, invisible to self-assignment. */
  private sealedIntent(i: { title: string; why: string; footprint: Path[]; ruleId?: Id; agentId: Id }): Id {
    const id = newId("int_");
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO intents (id, title, why, source, rule_id, parent_id, footprint, acceptance, priority, status, created_at, created_by, assigned_to, violations, updated_at)
       VALUES (?, ?, ?, 'agent', ?, NULL, ?, NULL, 0, 'claimed', ?, 'vaccine', ?, 0, ?)`,
      id,
      i.title,
      i.why,
      i.ruleId ?? null,
      JSON.stringify(normalizePaths(i.footprint)),
      now,
      i.agentId,
      now,
    );
    return id;
  }

  /** Finish a sealed vaccine: rejected with its outcome, intent abandoned; no lane, no field effects. */
  private sealProposal(id: Id, reason: string, evidence: Evidence): void {
    const row = this.proposalRow(id);
    if (!row) return;
    const prev = JSON.parse(row.data) as Proposal;
    if (prev.status === "landed") return;
    const now = Date.now();
    this.writeProposal({ ...prev, status: "rejected", reason, evidence }, now);
    const events: ColonyEvent[] = [{ t: "proposal", at: now, proposalId: id, intentId: prev.intentId, agentId: prev.agentId, status: "rejected", reason }];
    const intent = this.intentRow(prev.intentId);
    if (intent && intent.status !== "landed") {
      this.sql.exec("UPDATE intents SET status = 'abandoned', updated_at = ? WHERE id = ?", now, intent.id);
      events.push({ t: "intent", at: now, intentId: intent.id, status: "abandoned", title: intent.title, footprint: this.footprintOf(intent.id, intent.footprint) });
    }
    this.hub.push(events);
  }

  /** A FireTrident-authored trunk commit (an antibody) landed: track the trunk head and show it live. */
  private noteSystemCommit(l: Landing): void {
    const cached = this.loadColony();
    if (l.trunkSha && l.at >= (cached?.lastLandingAt ?? 0)) {
      this.sql.exec("UPDATE colony SET trunk_sha = ?, last_landing_at = ?", l.trunkSha, l.at);
      this.colonyCache = null;
    }
    this.hub.push({ t: "landing", at: Date.now(), landingId: l.id, trunkSha: l.trunkSha, proposalIds: [], paths: l.paths });
  }

  // =========================================================================
  // Live hub
  // =========================================================================

  /** Broadcast events to UI sockets (batched, at most every 100 ms). Returns the listener count. */
  async emit(e: ColonyEvent | ColonyEvent[]): Promise<{ listeners: number }> {
    return { listeners: this.hub.push(e) };
  }

  /** WebSocket upgrade for /api/colonies/:id/live (hibernation API). */
  async fetch(req: Request): Promise<Response> {
    if ((req.headers.get("Upgrade") ?? "").toLowerCase() !== "websocket") {
      return Response.json({ error: "expected a WebSocket upgrade" }, { status: 426 });
    }
    if (!this.loadColony()) return Response.json({ error: "colony not found" }, { status: 404 });
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, ["live"]);
    await this.armMetricsTick();
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Clients only ping; everything else flows server to client. */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (message === "ping") {
      try {
        ws.send("pong");
      } catch {
        // closing
      }
    }
  }

  /** Complete the close handshake. */
  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {
      // already closed
    }
  }

  /** Errors close the socket; nothing to clean up (the runtime drops it). */
  async webSocketError(_ws: WebSocket, _error: unknown): Promise<void> {}

  // =========================================================================
  // Operations: summary, metrics, agent listing and control, teardown, registry
  // =========================================================================

  /** Identity and live counters for GET /api/colonies, or null before init. Calls no other object. */
  async summary(): Promise<ColonySummary | null> {
    const loaded = this.loadColony();
    if (!loaded) return null;
    return summaryOf(loaded.colony, loaded.lastLandingAt, this.currentMetrics(Date.now()));
  }

  /** Metrics, funnel, violations and the per-minute series without the snapshot's lists (GET /api/colonies/:id/metrics). */
  async metricsReport(): Promise<{
    colonyId: Id;
    at: number;
    metrics: Record<string, number>;
    funnel: Record<DecisionLayer, number>;
    violations: { total: number; byRule: Record<Id, number> };
    series: ColonySeries;
  }> {
    const colony = this.requireColony();
    const now = Date.now();
    this.maybeReap(now);
    return { colonyId: colony.id, at: now, metrics: this.currentMetrics(now), funnel: this.funnelCounts(), violations: this.violationTotals(), series: this.seriesReport(now) };
  }

  /**
   * Agents for listings, most recently seen first, with the title of the intent each holds.
   * Dead agents (reaped, or stopped and not seen since) only with `includeDead`. Tokens are redacted.
   */
  async listAgents(opts: { includeDead?: boolean; kinds?: AgentKind[]; limit?: number } = {}): Promise<AgentListEntry[]> {
    const colony = this.requireColony();
    const limit = Math.max(1, Math.min(LIST_AGENTS_CAP, Math.floor(opts.limit ?? LIST_AGENTS_CAP)));
    const where: string[] = [];
    const args: SqlStorageValue[] = [];
    if (!opts.includeDead) {
      where.push("a.state != 'dead' AND NOT (s.at IS NOT NULL AND s.at + ? >= a.last_seen)");
      args.push(STOP_GRACE_MS);
    }
    if (opts.kinds && opts.kinds.length > 0) {
      where.push("a.kind IN (SELECT value FROM json_each(?))");
      args.push(JSON.stringify(opts.kinds));
    }
    const rows = this.sql
      .exec<AgentRow & { stopped_at: number | null; stop_reason: string | null; intent_title: string | null }>(
        `SELECT a.*, s.at AS stopped_at, s.reason AS stop_reason, i.title AS intent_title
           FROM agents a LEFT JOIN agent_stops s ON s.agent_id = a.id LEFT JOIN intents i ON i.id = a.intent_id
          ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY a.last_seen DESC LIMIT ?`,
        ...args,
        limit,
      )
      .toArray();
    return rows.map((r) => {
      const entry: AgentListEntry = { ...this.toAgent(r, colony.id, true), createdAt: r.created_at };
      entry.state = effectiveState(entry.state, r.last_seen, r.stopped_at);
      if (r.intent_title) entry.intentTitle = r.intent_title;
      if (r.stopped_at !== null && entry.state === "dead") {
        entry.stoppedAt = r.stopped_at;
        if (r.stop_reason) entry.stopReason = r.stop_reason;
      }
      return entry;
    });
  }

  /**
   * Record that agents were stopped (agent stop, swarm stop, colony deletion). Each one's claimed
   * intents reopen (claims cleared, a failure mark left) and its lease goes back to the pool unless
   * one of its proposals is still in flight (that proposal stands). It counts as dead until it is
   * seen again. Returns the ids that belong to this colony.
   */
  async retireAgents(agentIds: Id[], reason = "stopped"): Promise<Id[]> {
    const colony = this.requireColony();
    const now = Date.now();
    const fx = this.effects(colony.regionDepth);
    const out: Id[] = [];
    for (const id of new Set(agentIds)) {
      const agent = this.agentRow(id);
      if (!agent) continue;
      out.push(id);
      for (const h of this.sql.exec<IntentRow>("SELECT * FROM intents WHERE assigned_to = ? AND status = 'claimed'", id).toArray()) {
        const fp = this.footprintOf(h.id, h.footprint);
        this.sql.exec("UPDATE intents SET status = 'open', assigned_to = NULL, updated_at = ? WHERE id = ?", now, h.id);
        fx.batch.clear(fp, { agentId: id, intentId: h.id, kind: "claim" }).deposit("failure", fp, FAILURE_STRENGTH, now, { agentId: id, intentId: h.id });
        fx.events.push({ t: "intent", at: now, intentId: h.id, status: "open", title: h.title, footprint: fp });
      }
      const proposing = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM intents WHERE assigned_to = ? AND status = 'proposed'", id).one().n > 0;
      if (proposing) {
        this.sql.exec("UPDATE agents SET state = 'dead' WHERE id = ?", id);
      } else {
        this.sql.exec("UPDATE agents SET state = 'dead', intent_id = NULL, workspace = NULL WHERE id = ?", id);
        fx.release.add(id);
      }
      this.sql.exec(
        "INSERT INTO agent_stops (agent_id, at, reason) VALUES (?, ?, ?) ON CONFLICT(agent_id) DO UPDATE SET at = excluded.at, reason = excluded.reason",
        id,
        now,
        (reason || "stopped").slice(0, 500),
      );
      this.recentClaims.delete(id);
      this.lastRefresh.delete(id);
      fx.events.push({ t: "agent", at: now, agentId: id, kind: agent.kind as AgentKind, state: "dead" });
    }
    await this.flushEffects(fx);
    return out;
  }

  /**
   * Erase this object (DELETE /api/colonies/:id): close live sockets, cancel the alarm and delete
   * all storage. The empty schema is recreated so the object keeps answering, as a colony that
   * does not exist.
   */
  async destroy(): Promise<{ cleared: true }> {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(1001, "colony deleted");
      } catch {
        // already closed
      }
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.colonyCache = null;
    this.configured.clear();
    this.recentClaims.clear();
    this.readingCache.clear();
    this.taking.clear();
    this.lastRefresh.clear();
    this.footprintCache.clear();
    this.sentMetrics.clear();
    this.lastReap = 0;
    this.registryReady = false;
    for (const stmt of SCHEMA) this.sql.exec(stmt);
    for (const stmt of OPS_SCHEMA) this.sql.exec(stmt);
    return { cleared: true };
  }

  /** Registry instance only: record (or refresh) a colony. */
  async registerColony(e: { id: Id; name: string; source?: { url: string; branch?: string }; createdAt?: number }): Promise<RegistryEntry> {
    this.ensureRegistry();
    const now = Date.now();
    const source = e.source?.url ? { url: e.source.url, branch: e.source.branch || "main" } : null;
    this.sql.exec(
      `INSERT INTO registry (id, name, source, created_at, registered_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, source = excluded.source, created_at = excluded.created_at`,
      e.id,
      e.name,
      source ? JSON.stringify(source) : null,
      typeof e.createdAt === "number" && Number.isFinite(e.createdAt) ? e.createdAt : now,
      now,
    );
    const entry = this.registryEntries("WHERE id = ?", e.id)[0];
    if (!entry) throw ftError(500, `colony ${e.id} was not registered`);
    return entry;
  }

  /** Registry instance only: forget a colony. True when it was registered. */
  async unregisterColony(id: Id): Promise<boolean> {
    this.ensureRegistry();
    return this.sql.exec("DELETE FROM registry WHERE id = ? RETURNING id", id).toArray().length > 0;
  }

  /** Registry instance only: every registered colony, oldest first. */
  async listColonies(): Promise<RegistryEntry[]> {
    this.ensureRegistry();
    return this.registryEntries("");
  }

  /** Registry instance only: read a marker, or set it when `value` is given (used for the one-time backfill). */
  async registryFlag(key: string, value?: string): Promise<string | null> {
    this.ensureRegistry();
    if (value !== undefined) this.sql.exec("INSERT INTO registry_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", key, value);
    return this.sql.exec<{ v: string }>("SELECT v FROM registry_meta WHERE k = ?", key).toArray()[0]?.v ?? null;
  }

  /** Metrics tick: while UI sockets are connected, re-send live metrics that changed (all every 30 s) and reap silent agents. */
  async alarm(): Promise<void> {
    if (this.ctx.getWebSockets().length === 0 || !this.loadColony()) return;
    const now = Date.now();
    this.maybeReap(now);
    const full = now - this.lastFullMetricsAt >= METRICS_FULL_MS;
    if (full) this.lastFullMetricsAt = now;
    const changed = changedMetrics(this.currentMetrics(now), this.sentMetrics, full);
    if (changed.length > 0) this.hub.push(changed.map((m): ColonyEvent => ({ t: "metric", at: now, name: m.name, value: m.value })));
    await this.ctx.storage.setAlarm(now + METRICS_TICK_MS);
  }

  /** Start the metrics tick unless it is already scheduled (a UI socket just connected); its next tick sends every live metric. */
  private async armMetricsTick(): Promise<void> {
    this.lastFullMetricsAt = 0;
    try {
      if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + METRICS_TICK_MS);
    } catch (err) {
      console.warn(`metrics tick not armed: ${errorText(err)}`);
    }
  }

  /** Every metric (stored counters plus live gauges for agents, intents, proposals, violations and the funnel), as a stable map. */
  private currentMetrics(now: number): Record<string, number> {
    const m = this.metricsRecord();
    Object.assign(m, this.agentCounts());
    for (const r of this.sql.exec<{ status: string; n: number }>("SELECT status, COUNT(*) AS n FROM intents GROUP BY status")) {
      m[`intents${r.status.charAt(0).toUpperCase()}${r.status.slice(1)}`] = r.n;
    }
    const p = this.sql
      .exec<{ inflight: number; escalated: number }>(
        "SELECT COUNT(*) AS inflight, COALESCE(SUM(CASE WHEN status = 'escalated' THEN 1 ELSE 0 END), 0) AS escalated FROM proposals WHERE status IN ('pending', 'checking', 'ready', 'escalated')",
      )
      .one();
    m["proposalsInFlight"] = p.inflight;
    m["reviewQueue"] = p.escalated;
    m["landingsPerMin"] = this.landingsPerMin(now);
    m["violations"] = this.violationTotals().total;
    m["rules"] = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM rules").one().n;
    m["regions"] = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM regions").one().n;
    const funnel = this.funnelCounts();
    m["funnel.reflex"] = funnel.reflex;
    m["funnel.llm"] = funnel.llm;
    m["funnel.human"] = funnel.human;
    m["decisions"] = funnel.reflex + funnel.llm + funnel.human;
    return stableMetrics(m);
  }

  /** Agents by effective state (stopped and not seen since counts as dead). */
  private agentCounts(): Record<string, number> {
    const byState: Partial<Record<AgentState, number>> = {};
    for (const r of this.sql.exec<{ st: string; n: number }>(
      "SELECT CASE WHEN s.at IS NOT NULL AND s.at + ? >= a.last_seen THEN 'dead' ELSE a.state END AS st, COUNT(*) AS n FROM agents a LEFT JOIN agent_stops s ON s.agent_id = a.id GROUP BY st",
      STOP_GRACE_MS,
    )) {
      byState[r.st as AgentState] = r.n;
    }
    return agentCounters(byState);
  }

  /** The last SERIES_BUCKETS minutes of the per-minute series, ending with the current minute. */
  private seriesReport(now: number): ColonySeries {
    const end = minuteOf(now);
    const first = end - SERIES_BUCKETS + 1;
    const rows = this.sql.exec<{ name: string; minute: number; value: number }>("SELECT name, minute, value FROM series WHERE minute >= ? AND minute <= ?", first, end).toArray();
    const of = (name: string) => rows.filter((r) => r.name === name);
    const before = this.sql.exec<{ value: number }>("SELECT value FROM series WHERE name = 'violations' AND minute < ? ORDER BY minute DESC LIMIT 1", first).toArray()[0]?.value ?? null;
    return {
      bucketMs: BUCKET_MS,
      start: seriesStart(end),
      landings: counterBuckets(of("landings"), end),
      violations: gaugeBuckets(of("violations"), end, before, this.violationTotals().total),
      proposals: counterBuckets(of("proposals"), end),
      returned: counterBuckets(of("returned"), end),
      landedIntents: counterBuckets(of("landedIntents"), end),
    };
  }

  /** Add to (counter) or set (gauge) the current minute of a series; prunes old minutes now and then. */
  private recordSeries(name: string, value: number, now: number, gauge: boolean): void {
    if (!Number.isFinite(value)) return;
    const upsert = gauge
      ? "INSERT INTO series (name, minute, value) VALUES (?, ?, ?) ON CONFLICT(name, minute) DO UPDATE SET value = excluded.value"
      : "INSERT INTO series (name, minute, value) VALUES (?, ?, ?) ON CONFLICT(name, minute) DO UPDATE SET value = value + excluded.value";
    this.sql.exec(upsert, name, minuteOf(now), value);
    if (now - this.lastSeriesPrune < SERIES_PRUNE_EVERY_MS) return;
    this.lastSeriesPrune = now;
    const cutoff = minuteOf(now) - SERIES_KEEP_MINUTES;
    // Carry each gauge's last value to the cutoff so the line stays continuous after pruning.
    for (const g of GAUGE_SERIES) {
      this.sql.exec("INSERT OR IGNORE INTO series (name, minute, value) SELECT name, ?, value FROM series WHERE name = ? AND minute < ? ORDER BY minute DESC LIMIT 1", cutoff, g, cutoff);
    }
    this.sql.exec("DELETE FROM series WHERE minute < ?", cutoff);
  }

  /** Colonies from before the series table: rebuild the landings series from the landings log (once). */
  private backfillSeries(): void {
    if (this.sql.exec("SELECT 1 AS x FROM series LIMIT 1").toArray().length > 0) return;
    this.sql.exec(
      `INSERT OR IGNORE INTO series (name, minute, value)
       SELECT 'landings', CAST(received_at / ${BUCKET_MS} AS INTEGER) AS m, COUNT(*) FROM landings GROUP BY m`,
    );
  }

  private registryReady = false;

  private ensureRegistry(): void {
    const name = this.ctx.id.name;
    if (name !== undefined && name !== REGISTRY_NAME) throw ftError(400, "registry calls go to the registry instance");
    if (this.registryReady) return;
    for (const stmt of REGISTRY_SCHEMA) this.sql.exec(stmt);
    this.registryReady = true;
  }

  private registryEntries(where: string, ...args: SqlStorageValue[]): RegistryEntry[] {
    return this.sql
      .exec<{ id: string; name: string; source: string | null; created_at: number; registered_at: number }>(`SELECT * FROM registry ${where} ORDER BY created_at, id`, ...args)
      .toArray()
      .map((r) => {
        const e: RegistryEntry = { id: r.id, name: r.name, createdAt: r.created_at, registeredAt: r.registered_at };
        const source = parseJson<{ url: string; branch: string } | null>(r.source, null);
        if (source) e.source = source;
        return e;
      });
  }

  // =========================================================================
  // Internals: take
  // =========================================================================

  /** Atomically claim an open intent for an agent (false if someone else got it first). */
  private reserve(intentId: Id, agentId: Id): boolean {
    const won = this.sql
      .exec("UPDATE intents SET status = 'claimed', assigned_to = ?, updated_at = ? WHERE id = ? AND status = 'open' RETURNING id", agentId, Date.now(), intentId)
      .toArray();
    if (won.length === 0) return false;
    this.sql.exec("UPDATE agents SET intent_id = ?, workspace = NULL WHERE id = ?", intentId, agentId);
    return true;
  }

  /**
   * Admit the agent and claim the intent's footprint in every region it touches (each region
   * decides atomically, see admitClaims), then lease a workspace. Undoes the reservation and the
   * claims if a region refuses or the pool is empty.
   */
  private async leaseAndClaim(agentId: Id, kind: AgentKind, intent: Intent): Promise<TakeResult> {
    const recent = { paths: new Set(intent.footprint), regions: new Set(groupByRegion(intent.footprint, this.requireColony().regionDepth).keys()), doneAt: null as number | null };
    this.recentClaims.set(agentId, recent);
    const closed = await this.admitClaims(agentId, intent);
    const claimedAt = Date.now();
    recent.doneAt = claimedAt; // the claims are in the regions' readings from here on
    let lease: WorkspaceLease | null = null;
    let failure = closed.length > 0 ? `admission closed in ${closed.join(", ")}` : "pool empty";
    if (closed.length === 0) {
      try {
        lease = await this.poolStub().lease(agentId, this.requireColony().trunkSha);
      } catch (err) {
        failure = `lease failed: ${errorText(err)}`;
        console.error(`PoolDO.lease failed for ${agentId}: ${failure}`);
      }
    }
    const colony = this.requireColony();
    const now = Date.now();
    const row = this.intentRow(intent.id);
    const stillOurs = !!row && row.status === "claimed" && row.assigned_to === agentId;
    if (!lease || !stillOurs) {
      if (this.recentClaims.get(agentId) === recent) this.recentClaims.delete(agentId);
      const fx = this.effects(colony.regionDepth);
      if (stillOurs) {
        this.sql.exec("UPDATE intents SET status = 'open', assigned_to = NULL, updated_at = ? WHERE id = ?", now, intent.id);
        fx.events.push({ t: "intent", at: now, intentId: intent.id, status: "open", title: intent.title, footprint: intent.footprint });
      }
      // The claims admission deposited go back with the reservation.
      fx.batch.clear(intent.footprint, { agentId, intentId: intent.id, kind: "claim" });
      this.sql.exec("UPDATE agents SET intent_id = NULL, workspace = NULL WHERE id = ? AND intent_id = ?", agentId, intent.id);
      this.setAgentState(agentId, "waiting", now);
      if (lease) fx.release.add(agentId);
      await this.flushEffects(fx);
      const retryMs = closed.length > 0 ? CLOSED_RETRY_MS : LEASE_RETRY_MS;
      return { wait: true, retryInMs: jitter(retryMs, this.rand), reason: lease ? "intent was reassigned while leasing" : failure };
    }
    this.sql.exec("UPDATE agents SET state = 'working', intent_id = ?, workspace = ?, last_seen = ? WHERE id = ?", intent.id, JSON.stringify(lease), now, agentId);
    this.lastRefresh.set(agentId, claimedAt);
    this.hub.push([
      { t: "intent", at: now, intentId: intent.id, status: "claimed", title: intent.title, footprint: intent.footprint },
      { t: "agent", at: now, agentId, kind, state: "working", intentId: intent.id, paths: intent.footprint },
    ]);
    this.bump("takes", 1, now);
    return this.assignment({ ...intent, status: "claimed", assignedTo: agentId }, lease);
  }

  /**
   * Harvester-ant admission, decided by each region the intent touches (RegionDO.admit) in one
   * step with the claim deposit, so concurrent takes cannot overfill a region whatever their field
   * views missed. Returns the regions that refused. An unreachable region refuses (fail closed); a
   * region still on the previous version (mid-deploy) takes a plain claim deposit instead.
   */
  private async admitClaims(agentId: Id, intent: Intent): Promise<string[]> {
    const closed: string[] = [];
    await Promise.all(
      [...groupByRegion(intent.footprint, this.requireColony().regionDepth)].map(async ([region, paths]) => {
        try {
          const stub = await this.region(region);
          try {
            if (!(await stub.admit({ agentId, intentId: intent.id, paths, strength: CLAIM_STRENGTH })).admitted) closed.push(region);
          } catch (err) {
            if (!/does not implement/i.test(errorText(err))) throw err;
            const at = Date.now();
            await stub.apply({ deposit: paths.map((path) => ({ kind: "claim" as const, path, strength: CLAIM_STRENGTH, at, agentId, intentId: intent.id })) });
          }
        } catch (err) {
          console.error(`admission failed in region ${region} for ${agentId}: ${errorText(err)}`);
          closed.push(region);
        }
      }),
    );
    return closed;
  }

  /** Co-change repulsion weight: FT_COCHANGE_WEIGHT when set to a non-negative number, else COCHANGE_WEIGHT. */
  private cochangeWeight(): number {
    const raw = (this.env as unknown as { FT_COCHANGE_WEIGHT?: string }).FT_COCHANGE_WEIGHT;
    const w = raw === undefined || raw === "" ? Number.NaN : Number(raw);
    return Number.isFinite(w) && w >= 0 ? w : COCHANGE_WEIGHT;
  }

  /**
   * Lateral inhibition threshold for takes, as a claim value: FT_LATERAL_INHIBITION as a fraction of
   * a fresh claim when set to a non-negative number ("off" disables it), else core LATERAL_INHIBITION
   * (half a fresh claim). An open intent whose own files carry that much claim from other agents is
   * skipped until the claim lands, is released, or decays below it.
   */
  private inhibitAt(): number {
    const raw = (this.env as unknown as { FT_LATERAL_INHIBITION?: string }).FT_LATERAL_INHIBITION?.trim();
    if (raw === "off") return Number.POSITIVE_INFINITY;
    const f = raw === undefined || raw === "" ? Number.NaN : Number(raw);
    return (Number.isFinite(f) && f >= 0 ? f : LATERAL_INHIBITION) * CLAIM_STRENGTH;
  }

  /** Recent claims of other agents that a reading started at `since` may not include (prunes old entries). */
  private unseenClaims(agentId: Id, since: number): Array<{ paths: Set<Path>; regions: Set<string> }> {
    const horizon = Date.now() - RECENT_CLAIM_MS;
    const out: Array<{ paths: Set<Path>; regions: Set<string> }> = [];
    for (const [id, c] of this.recentClaims) {
      if (c.doneAt !== null && c.doneAt < horizon) {
        this.recentClaims.delete(id);
        continue;
      }
      if (id !== agentId && (c.doneAt === null || c.doneAt >= since)) out.push(c);
    }
    return out;
  }

  /** The subset of these intents that is still open. */
  private openAmong(ids: Id[]): Set<Id> {
    const out = new Set<Id>();
    for (let i = 0; i < ids.length; i += 500) {
      const part = JSON.stringify(ids.slice(i, i + 500));
      for (const r of this.sql.exec<{ id: string }>("SELECT id FROM intents WHERE status = 'open' AND id IN (SELECT value FROM json_each(?))", part)) out.add(r.id);
    }
    return out;
  }

  private assignment(intent: Intent, lease: WorkspaceLease): TakeResult {
    const rule = intent.ruleId ? this.sql.exec<RuleRow>("SELECT * FROM rules WHERE id = ?", intent.ruleId).toArray()[0] : undefined;
    return rule ? { intent, lease, rule: this.toRule(rule, intent.colonyId) } : { intent, lease };
  }

  /**
   * Field readings for the candidate paths of each region. Concurrent takes
   * share one in-flight or recent (READING_TTL_MS) reading per region when it
   * covers the paths they need; claims made after a reading started are
   * overlaid from recentClaims, so sharing never hides a newer claim.
   */
  private async readRegions(wanted: Map<string, Set<Path>>): Promise<Map<string, { reading: FieldReading; fetchStart: number }>> {
    const now = Date.now();
    const out = new Map<string, { reading: FieldReading; fetchStart: number }>();
    await Promise.all(
      [...wanted].map(async ([region, paths]) => {
        let entry = this.readingCache.get(region);
        const fresh = entry !== undefined && now - entry.fetchStart < READING_TTL_MS;
        if (!entry || !fresh || ![...paths].every((p) => entry!.paths.has(p))) {
          const all = new Set(paths);
          if (entry && fresh) for (const p of entry.paths) all.add(p);
          const created: ReadingEntry = { fetchStart: Date.now(), paths: all, promise: Promise.resolve(null) };
          created.promise = this.region(region)
            .then((stub) => stub.reading({ paths: [...all], agents: false }) as Promise<FieldReading>)
            .catch((err: unknown) => {
              // Fail open: a region we cannot read neither repels nor closes admission.
              console.error(`field reading failed for region ${region}: ${errorText(err)}`);
              if (this.readingCache.get(region) === created) this.readingCache.delete(region);
              return null;
            });
          this.readingCache.set(region, created);
          entry = created;
        }
        const reading = await entry.promise;
        if (reading) out.set(region, { reading, fetchStart: entry.fetchStart });
      }),
    );
    return out;
  }

  /**
   * What self-assignment needs from each region's reading, from one agent's
   * point of view: claim/danger values with the agent's own claims removed,
   * claims the reading may predate, and admission counting those claims.
   */
  private fieldViews(agentId: Id, readings: Map<string, { reading: FieldReading; fetchStart: number }>, depth: number): Map<string, FieldView> {
    const own = this.ownClaims(agentId, depth);
    const views = new Map<string, FieldView>();
    for (const [region, { reading, fetchStart }] of readings) {
      const mine = own.get(region);
      const byPath: FieldReading["byPath"] = {};
      let repulsive = false;
      for (const [path, v] of Object.entries(reading.byPath)) {
        const claim = Math.max(0, (v.claim ?? 0) - (mine?.get(path) ?? 0));
        const danger = v.danger ?? 0;
        if (claim + danger <= 1e-9) continue;
        byPath[path] = { claim, danger };
        repulsive = true;
      }
      const unseen = this.unseenClaims(agentId, fetchStart).filter((c) => c.regions.has(region));
      // An agent already working in the region adds no forager there, so admission does not apply to it.
      const inside = !!mine && mine.size > 0;
      const active = Math.max(0, reading.admission.activeAgents - (inside ? 1 : 0)) + unseen.length;
      views.set(region, { byPath, repulsive, unseen, open: inside || admissionOpen(active, reading.admission.landingsPerMin) });
    }
    return views;
  }

  /** The agent's own live claims (intents it holds, claimed or in a lane): region → path → value. */
  private ownClaims(agentId: Id, depth: number): Map<string, Map<Path, number>> {
    const out = new Map<string, Map<Path, number>>();
    const held = this.sql.exec<{ id: string; footprint: string }>("SELECT id, footprint FROM intents WHERE assigned_to = ? AND status IN ('claimed', 'proposed')", agentId).toArray();
    if (held.length === 0) return out;
    const now = Date.now();
    const value = markValue({ id: "", kind: "claim", path: "", strength: CLAIM_STRENGTH, at: this.lastRefresh.get(agentId) ?? now }, now);
    for (const h of held) {
      for (const [region, paths] of groupByRegion(this.footprintOf(h.id, h.footprint), depth)) {
        let m = out.get(region);
        if (!m) {
          m = new Map();
          out.set(region, m);
        }
        for (const p of paths) m.set(p, (m.get(p) ?? 0) + value);
      }
    }
    return out;
  }

  /** Declare silent agents dead and reopen the intents they claimed (throttled). */
  private maybeReap(now: number): void {
    if (now - this.lastReap < REAP_EVERY_MS) return;
    this.lastReap = now;
    const stale = this.sql
      .exec<{ id: string; kind: string }>("SELECT id, kind FROM agents WHERE state != 'dead' AND last_seen < ?", now - AGENT_TTL_MS)
      .toArray()
      .filter((a) => !this.taking.has(a.id));
    if (stale.length === 0) return;
    const colony = this.requireColony();
    const fx = this.effects(colony.regionDepth);
    for (const a of stale) {
      for (const h of this.sql.exec<IntentRow>("SELECT * FROM intents WHERE assigned_to = ? AND status = 'claimed'", a.id).toArray()) {
        const fp = this.footprintOf(h.id, h.footprint);
        this.sql.exec("UPDATE intents SET status = 'open', assigned_to = NULL, updated_at = ? WHERE id = ?", now, h.id);
        fx.batch.clear(fp, { agentId: a.id, intentId: h.id, kind: "claim" });
        fx.events.push({ t: "intent", at: now, intentId: h.id, status: "open", title: h.title, footprint: fp });
      }
      this.sql.exec("UPDATE agents SET state = 'dead', intent_id = NULL, workspace = NULL WHERE id = ?", a.id);
      // A dead agent's claims stop counting in the takes that follow (they inhibit; see takeFor).
      this.recentClaims.delete(a.id);
      fx.events.push({ t: "agent", at: now, agentId: a.id, kind: a.kind as AgentKind, state: "dead" });
      fx.release.add(a.id);
    }
    this.ctx.waitUntil(this.flushEffects(fx));
  }

  // =========================================================================
  // Internals: proposal state machine
  // =========================================================================

  private effects(depth: number): Effects {
    return { batch: new FieldBatch(depth), events: [], enqueue: [], dequeue: new Map(), release: new Set() };
  }

  /** Apply the side effects of a proposal moving from `prev` to `p.status` (no-op if unchanged). */
  private transition(p: Proposal, prev: ProposalStatus, now: number, fx: Effects): void {
    if (p.status === prev) return;
    const row = this.proposalRow(p.id);
    const region = row?.region ?? ".";
    const priority = row?.priority ?? 1;
    const intent = this.intentRow(p.intentId);
    const agent = this.agentRow(p.agentId);
    const proposalEvent: ColonyEvent = { t: "proposal", at: now, proposalId: p.id, intentId: p.intentId, agentId: p.agentId, status: p.status };
    if (p.reason) proposalEvent.reason = p.reason;
    fx.events.push(proposalEvent);
    if (prev === "ready" && p.status !== "landed") {
      const list = fx.dequeue.get(region) ?? [];
      list.push(p.id);
      fx.dequeue.set(region, list);
    }

    switch (p.status) {
      case "ready":
      case "escalated": {
        if (intent && intent.status !== "landed" && intent.status !== "abandoned") {
          this.sql.exec("UPDATE intents SET status = 'proposed', assigned_to = ?, updated_at = ? WHERE id = ?", p.agentId, now, intent.id);
          if (intent.status !== "proposed") {
            fx.events.push({ t: "intent", at: now, intentId: intent.id, status: "proposed", title: intent.title, footprint: this.footprintOf(intent.id, intent.footprint) });
          }
        }
        if (agent && (agent.intent_id === p.intentId || agent.intent_id === null) && agent.state !== "proposing") {
          this.sql.exec("UPDATE agents SET state = 'proposing', intent_id = ? WHERE id = ?", p.intentId, agent.id);
          fx.events.push({ t: "agent", at: now, agentId: agent.id, kind: agent.kind as AgentKind, state: "proposing", intentId: p.intentId });
        }
        if (p.status === "ready") fx.enqueue.push({ proposal: p, region, priority });
        if (p.status === "escalated") this.bump("escalated", 1, now);
        break;
      }
      case "returned":
      case "rejected": {
        const fp = intent ? this.footprintOf(intent.id, intent.footprint) : p.declared.footprint;
        if (intent && (intent.status === "proposed" || intent.status === "claimed") && (intent.assigned_to === p.agentId || intent.assigned_to === null)) {
          this.sql.exec("UPDATE intents SET status = 'open', assigned_to = NULL, updated_at = ? WHERE id = ?", now, intent.id);
          fx.events.push({ t: "intent", at: now, intentId: intent.id, status: "open", title: intent.title, footprint: fp });
        }
        fx.batch
          .clear(fp, { agentId: p.agentId, intentId: p.intentId, kind: "claim" })
          .deposit("failure", fp, FAILURE_STRENGTH, now, { agentId: p.agentId, intentId: p.intentId });
        if (agent && (agent.intent_id === p.intentId || agent.intent_id === null)) {
          this.sql.exec("UPDATE agents SET state = 'idle', intent_id = NULL, workspace = NULL WHERE id = ?", agent.id);
          if (agent.state !== "idle") fx.events.push({ t: "agent", at: now, agentId: agent.id, kind: agent.kind as AgentKind, state: "idle" });
          fx.release.add(agent.id);
        }
        this.bump(p.status, 1, now);
        break;
      }
      case "landed": {
        // The agent's claims go, it becomes more eager in this region, and the intent lands.
        const fp = intent ? this.footprintOf(intent.id, intent.footprint) : p.declared.footprint;
        fx.batch.clear(fp, { agentId: p.agentId, intentId: p.intentId, kind: "claim" });
        if (agent) {
          const thresholds = JSON.stringify(reinforceThreshold(parseJson<Record<string, number>>(agent.thresholds, {}), region));
          if (agent.intent_id === p.intentId || agent.intent_id === null) {
            this.sql.exec("UPDATE agents SET thresholds = ?, state = 'idle', intent_id = NULL, workspace = NULL WHERE id = ?", thresholds, agent.id);
            if (agent.state !== "idle") fx.events.push({ t: "agent", at: now, agentId: agent.id, kind: agent.kind as AgentKind, state: "idle" });
            fx.release.add(agent.id);
          } else {
            this.sql.exec("UPDATE agents SET thresholds = ? WHERE id = ?", thresholds, agent.id);
          }
        }
        this.landIntent(p.intentId, now, fx);
        this.bump("landedProposals", 1, now);
        break;
      }
      default:
        break;
    }
  }

  /** Mark an intent landed: its need is met and its rule has one fewer open violation file. */
  private landIntent(intentId: Id, now: number, fx: Effects): void {
    const row = this.intentRow(intentId);
    if (!row || row.status === "landed") return;
    this.sql.exec("UPDATE intents SET status = 'landed', updated_at = ? WHERE id = ?", now, intentId);
    const fp = this.footprintOf(row.id, row.footprint);
    fx.batch.clear(fp, { intentId: row.id, kind: "need" });
    fx.events.push({ t: "intent", at: now, intentId: row.id, status: "landed", title: row.title, footprint: fp });
    this.bump("landedIntents", 1, now);
    if (row.rule_id && row.violations > 0) {
      this.sql.exec("UPDATE rules SET open_violations = MAX(0, open_violations - ?) WHERE id = ?", row.violations, row.rule_id);
      fx.events.push(this.violationsEvent(now));
    }
  }

  private async flushEffects(fx: Effects): Promise<void> {
    if (fx.events.length > 0) this.hub.push(fx.events);
    const jobs: Array<Promise<unknown>> = [this.applyField(fx.batch)];
    for (const [region, ids] of fx.dequeue) {
      jobs.push(
        this.region(region)
          .then((stub) => stub.dequeue(ids))
          .catch((err) => console.error(`dequeue failed in ${region}: ${errorText(err)}`)),
      );
    }
    for (const item of fx.enqueue) jobs.push(this.enqueue(item.proposal, item.region, item.priority));
    await Promise.all(jobs);
    if (fx.release.size > 0) this.ctx.waitUntil(this.releaseLeases([...fx.release]));
  }

  /** Put a ready proposal in its region's lane; if the lane is unreachable, return it to its agent. */
  private async enqueue(p: Proposal, region: string, priority: number): Promise<void> {
    try {
      await (await this.region(region)).enqueue(p, priority);
    } catch (err) {
      const reason = `lane unavailable: ${errorText(err)}`;
      console.error(`enqueue failed for ${p.id} in ${region}: ${reason}`);
      const row = this.proposalRow(p.id);
      if (!row || row.status !== "ready") return;
      const colony = this.requireColony();
      const now = Date.now();
      const next: Proposal = { ...(JSON.parse(row.data) as Proposal), status: "returned", reason };
      this.writeProposal(next, now);
      const fx = this.effects(colony.regionDepth);
      this.transition(next, "pending", now, fx);
      fx.dequeue.clear();
      fx.enqueue.length = 0;
      await this.flushEffects(fx);
    }
  }

  private async releaseLeases(agentIds: Id[]): Promise<void> {
    const pool = this.poolStub();
    await Promise.all(
      agentIds.map(async (id) => {
        // Only release agents that have not leased again in the meantime.
        const agent = this.agentRow(id);
        if (agent && agent.state === "working") return;
        try {
          await pool.release(id);
        } catch (err) {
          console.warn(`PoolDO.release failed for ${id}: ${errorText(err)}`);
        }
      }),
    );
  }

  // =========================================================================
  // Internals: field
  // =========================================================================

  private async region(region: string): Promise<DurableObjectStub<RegionDO>> {
    const colonyId = this.requireColony().id;
    const stub = this.env.REGION.get(this.env.REGION.idFromName(regionKey(colonyId, region)));
    let ready = this.configured.get(region);
    if (!ready) {
      ready = (async () => {
        await stub.configure({ colonyId, region, regionDepth: this.requireColony().regionDepth });
        this.sql.exec("INSERT OR IGNORE INTO regions (name, created_at) VALUES (?, ?)", region, Date.now());
      })();
      this.configured.set(region, ready);
      ready.catch(() => this.configured.delete(region));
    }
    await ready;
    return stub;
  }

  /** Send a FieldBatch: one RegionDO.apply per region, in parallel. Failures are logged, not thrown. */
  private async applyField(batch: FieldBatch): Promise<void> {
    if (batch.size === 0) return;
    await Promise.all(
      [...batch.byRegion].map(async ([region, ops]) => {
        try {
          await (await this.region(region)).apply(ops);
        } catch (err) {
          console.error(`field update failed in region ${region}: ${errorText(err)}`);
        }
      }),
    );
  }

  // =========================================================================
  // Internals: intents
  // =========================================================================

  private async createIntents(drafts: Array<IntentInput & { violations?: number }>): Promise<Intent[]> {
    const colony = this.requireColony();
    const now = Date.now();
    // Validate everything before writing anything.
    const prepared = drafts.map((d) => {
      const footprint = normalizePaths(Array.isArray(d.footprint) ? d.footprint : []);
      if (footprint.length === 0) throw ftError(400, "intent footprint must name at least one path");
      const title = typeof d.title === "string" ? d.title.trim() : "";
      if (!title) throw ftError(400, "intent title is required");
      if (d.assignedTo !== undefined && d.assignedTo !== null && !this.agentRow(d.assignedTo)) throw ftError(404, `unknown agent ${d.assignedTo}`);
      if (d.parentId && !this.intentRow(d.parentId)) throw ftError(404, `unknown parent intent ${d.parentId}`);
      const source: IntentSource = d.source === "rule" || d.source === "agent" ? d.source : "human";
      const priority = typeof d.priority === "number" && Number.isFinite(d.priority) ? Math.max(0, d.priority) : 1;
      return { d, footprint, title, source, priority };
    });
    const batch = new FieldBatch(colony.regionDepth);
    const events: ColonyEvent[] = [];
    const out: Intent[] = [];
    const declared: Array<{ doneAt: number | null }> = [];
    for (const { d, footprint, title, source, priority } of prepared) {
      const assignedTo = d.assignedTo ?? undefined;
      const intent: Intent = {
        id: newId("int_"),
        colonyId: colony.id,
        title,
        why: typeof d.why === "string" ? d.why : "",
        source,
        footprint,
        priority,
        status: assignedTo ? "claimed" : "open",
        createdAt: now,
        createdBy: d.createdBy || "unknown",
      };
      if (d.ruleId) intent.ruleId = d.ruleId;
      if (d.parentId) intent.parentId = d.parentId;
      if (Array.isArray(d.acceptance) && d.acceptance.length > 0) intent.acceptance = d.acceptance;
      if (assignedTo) intent.assignedTo = assignedTo;
      this.sql.exec(
        `INSERT INTO intents (id, title, why, source, rule_id, parent_id, footprint, acceptance, priority, status, created_at, created_by, assigned_to, violations, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        intent.id,
        intent.title,
        intent.why,
        intent.source,
        intent.ruleId ?? null,
        intent.parentId ?? null,
        JSON.stringify(footprint),
        intent.acceptance ? JSON.stringify(intent.acceptance) : null,
        priority,
        intent.status,
        now,
        intent.createdBy,
        assignedTo ?? null,
        d.violations ?? 0,
        now,
      );
      this.footprintCache.set(intent.id, footprint);
      batch.deposit("need", footprint, priority, now, { intentId: intent.id });
      if (assignedTo) {
        batch.deposit("claim", footprint, CLAIM_STRENGTH, now, { agentId: assignedTo, intentId: intent.id });
        this.sql.exec("UPDATE agents SET state = 'working', intent_id = ?, last_seen = ? WHERE id = ?", intent.id, now, assignedTo);
        const recent = { paths: new Set(footprint), regions: new Set(groupByRegion(footprint, colony.regionDepth).keys()), doneAt: null as number | null };
        this.recentClaims.set(assignedTo, recent);
        declared.push(recent);
      }
      events.push({ t: "intent", at: now, intentId: intent.id, status: intent.status, title, footprint });
      out.push(intent);
    }
    if (out.length > 0) {
      this.bump("intents", out.length, now);
      this.hub.push(events);
      try {
        await this.applyField(batch);
      } finally {
        const done = Date.now();
        for (const r of declared) r.doneAt = done;
      }
    }
    return out;
  }

  private assertProposable(row: IntentRow, agentId: Id): void {
    if (row.status === "landed" || row.status === "abandoned") throw ftError(409, `intent ${row.id} is already ${row.status}`);
    if (row.assigned_to && row.assigned_to !== agentId && (row.status === "claimed" || row.status === "proposed")) {
      throw ftError(409, `intent ${row.id} is held by another agent`);
    }
  }

  private normalizeVersions(list: FileVersion[] | undefined): FileVersion[] {
    const out: FileVersion[] = [];
    const seen = new Set<Path>();
    for (const f of Array.isArray(list) ? list : []) {
      const path = normalizePath(String(f?.path ?? ""));
      if (!path || seen.has(path)) continue;
      seen.add(path);
      out.push({ path, blob: typeof f.blob === "string" && f.blob ? f.blob : null });
    }
    return out;
  }

  // =========================================================================
  // Internals: rows, metrics, decisions
  // =========================================================================

  private loadColony(): { colony: Colony; lastLandingAt: number } | null {
    if (this.colonyCache) return this.colonyCache;
    const row = this.sql.exec<ColonyRow>("SELECT * FROM colony LIMIT 1").toArray()[0];
    if (!row) return null;
    const colony: Colony = {
      id: row.id,
      name: row.name,
      trunk: parseJson<RepoRef>(row.trunk, { namespace: "", name: "", remote: "" }),
      trunkSha: row.trunk_sha,
      createdAt: row.created_at,
      regionDepth: row.region_depth,
    };
    if (row.green_sha) colony.greenSha = row.green_sha;
    const source = parseJson<{ url: string; branch: string } | null>(row.source, null);
    if (source) colony.source = source;
    this.colonyCache = { colony, lastLandingAt: row.last_landing_at };
    return this.colonyCache;
  }

  private requireColony(): Colony {
    const c = this.loadColony();
    if (!c) throw ftError(404, "colony not found");
    return c.colony;
  }

  private agentRow(id: Id): AgentRow | undefined {
    return this.sql.exec<AgentRow>("SELECT * FROM agents WHERE id = ?", id).toArray()[0];
  }

  private requireAgent(id: Id): AgentRow {
    const row = this.agentRow(id);
    if (!row) throw ftError(404, `unknown agent ${id}`);
    return row;
  }

  private intentRow(id: Id): IntentRow | undefined {
    return this.sql.exec<IntentRow>("SELECT * FROM intents WHERE id = ?", id).toArray()[0];
  }

  private proposalRow(id: Id): ProposalRow | undefined {
    return this.sql.exec<ProposalRow>("SELECT * FROM proposals WHERE id = ?", id).toArray()[0];
  }

  private getProposalSync(id: Id): Proposal | null {
    const row = this.proposalRow(id);
    return row ? (JSON.parse(row.data) as Proposal) : null;
  }

  private writeProposal(p: Proposal, now: number): void {
    this.sql.exec("UPDATE proposals SET status = ?, updated_at = ?, data = ? WHERE id = ?", p.status, now, JSON.stringify(p), p.id);
  }

  private footprintOf(id: Id, json: string): Path[] {
    let fp = this.footprintCache.get(id);
    if (!fp) {
      fp = parseJson<Path[]>(json, []);
      if (this.footprintCache.size > 50_000) this.footprintCache.clear();
      this.footprintCache.set(id, fp);
    }
    return fp;
  }

  private toIntent(r: IntentRow, colonyId: Id): Intent {
    const intent: Intent = {
      id: r.id,
      colonyId,
      title: r.title,
      why: r.why,
      source: r.source as IntentSource,
      footprint: this.footprintOf(r.id, r.footprint),
      priority: r.priority,
      status: r.status as IntentStatus,
      createdAt: r.created_at,
      createdBy: r.created_by,
    };
    if (r.rule_id) intent.ruleId = r.rule_id;
    if (r.parent_id) intent.parentId = r.parent_id;
    const acceptance = parseJson<string[] | null>(r.acceptance, null);
    if (acceptance) intent.acceptance = acceptance;
    if (r.assigned_to) intent.assignedTo = r.assigned_to;
    return intent;
  }

  private toRule(r: RuleRow, colonyId: Id): Rule {
    return {
      id: r.id,
      colonyId,
      kind: r.kind as Rule["kind"],
      spec: parseJson<Record<string, unknown>>(r.spec, {}),
      description: r.description,
      approvedBy: r.approved_by,
      createdAt: r.created_at,
    };
  }

  private toAgent(r: AgentRow, colonyId: Id, redact: boolean): AgentInfo {
    const info: AgentInfo = {
      id: r.id,
      colonyId,
      kind: r.kind as AgentKind,
      name: r.name,
      thresholds: parseJson<Record<string, number>>(r.thresholds, {}),
      state: r.state as AgentState,
      lastSeen: r.last_seen,
    };
    if (r.model) info.model = r.model;
    if (r.intent_id) info.intentId = r.intent_id;
    const lease = parseJson<WorkspaceLease | null>(r.workspace, null);
    if (lease) info.workspace = redact ? redactLease(lease) : lease;
    return info;
  }

  private setAgentState(agentId: Id, state: AgentState, now: number): void {
    const row = this.sql.exec<{ kind: string; state: string }>("UPDATE agents SET state = ? WHERE id = ? AND state != ? RETURNING kind, state", state, agentId, state).toArray()[0];
    if (row) this.hub.push({ t: "agent", at: now, agentId, kind: row.kind as AgentKind, state });
  }

  private countIntents(status: IntentStatus): number {
    return this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM intents WHERE status = ?", status).one().n;
  }

  private landingsPerMin(now: number): number {
    return this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM landings WHERE received_at > ?", now - RATE_WINDOW_MS).one().n;
  }

  private pruneLandings(): void {
    this.sql.exec("DELETE FROM landings WHERE id IN (SELECT id FROM landings ORDER BY received_at DESC LIMIT -1 OFFSET ?)", LANDINGS_KEEP);
  }

  private bump(name: string, delta: number, now: number): number {
    const row = this.sql
      .exec<{ value: number }>(
        "INSERT INTO metrics (name, value, at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = value + excluded.value, at = excluded.at RETURNING value",
        name,
        delta,
        now,
      )
      .toArray()[0];
    if (COUNTER_SERIES.has(name)) this.recordSeries(name, delta, now, false);
    return row?.value ?? delta;
  }

  private setMetric(name: string, value: number, now: number): void {
    this.sql.exec("INSERT INTO metrics (name, value, at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, at = excluded.at", name, value, now);
  }

  private metric(name: string): number {
    return this.sql.exec<{ value: number }>("SELECT value FROM metrics WHERE name = ?", name).toArray()[0]?.value ?? 0;
  }

  private metricsRecord(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.sql.exec<{ name: string; value: number }>("SELECT name, value FROM metrics")) out[r.name] = r.value;
    return out;
  }

  private violationTotals(): { total: number; byRule: Record<Id, number> } {
    const byRule: Record<Id, number> = {};
    let total = 0;
    for (const r of this.sql.exec<{ id: string; open_violations: number }>("SELECT id, open_violations FROM rules")) {
      byRule[r.id] = r.open_violations;
      total += r.open_violations;
    }
    return { total, byRule };
  }

  /** The violations event for the current totals (every change goes through here, so it also samples the series). */
  private violationsEvent(now: number): ColonyEvent {
    const totals = this.violationTotals();
    this.recordSeries("violations", totals.total, now, true);
    return { t: "violations", at: now, ...totals };
  }

  private funnelCounts(): Record<DecisionLayer, number> {
    const out: Record<DecisionLayer, number> = { reflex: 0, llm: 0, human: 0 };
    for (const r of this.sql.exec<{ layer: string; n: number }>("SELECT layer, n FROM funnel")) {
      if (r.layer === "reflex" || r.layer === "llm" || r.layer === "human") out[r.layer] = r.n;
    }
    return out;
  }

  private storeDecision(d: Decision, now: number): void {
    this.sql.exec(
      "INSERT INTO decisions (id, kind, subject, layer, answers, p, action, at, escalated_from) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      d.id,
      d.kind,
      d.subject,
      d.layer,
      JSON.stringify(d.answers ?? {}),
      Number.isFinite(d.p) ? d.p : 0,
      d.action,
      d.at,
      d.escalatedFrom ?? null,
    );
    this.sql.exec("INSERT INTO funnel (layer, n) VALUES (?, 1) ON CONFLICT(layer) DO UPDATE SET n = n + 1", d.layer);
    this.hub.push([
      { t: "decision", at: now, decisionId: d.id, kind: d.kind, layer: d.layer, p: d.p, action: d.action, subject: d.subject },
      { t: "metric", at: now, name: `funnel.${d.layer}`, value: this.funnelCounts()[d.layer] },
    ]);
  }

  private trunkStub() {
    return this.env.TRUNK.get(this.env.TRUNK.idFromName(this.requireColony().id));
  }

  private poolStub() {
    return this.env.POOL.get(this.env.POOL.idFromName(this.requireColony().id));
  }
}
