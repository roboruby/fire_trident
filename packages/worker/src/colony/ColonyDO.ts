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
  Certification,
  Colony,
  ColonyEvent,
  ColonySnapshot,
  Convergence,
  Decision,
  DecisionLayer,
  EventsPage,
  Evidence,
  FunnelStage,
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
  RecordedEvent,
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
import { EventHub, EventRecorder, RECORD_KEEP } from "./events.ts";
import { reconstruct, type ReconInput } from "./replay.ts";
import { DecideEngine, type DecideHost, type TrunkRpc, type VaccinationResult } from "../decide/engine.ts";
import type { DecidePolicy } from "../decide/policy.ts";
import type { DetectorStats } from "../decide/store.ts";
import { DEFAULT_NOT_VERIFIED, FieldBatch, groupByRegion, jitter, normalizePath, normalizePaths, overlapCount, primaryRegion, violationIntents } from "./logic.ts";
import { EmitPacer, Gate, WaitPacer, fastRepulsion, fieldIndex, unseenByRegion, type FieldIndex, type RecentClaim } from "./views.ts";
import { LagProbe } from "./lag.ts";
import {
  MAX_DIRECTIVE_CHARS,
  MAX_NOTE_DIRECTIVES,
  MAX_REVISIONS,
  cleanNote,
  footprintDelta,
  guidanceText,
  inboxEntry,
  intentChanges,
  isRedirect,
  migrateDirection,
  noteDecisions,
  oneLine,
  revisedReturn,
  staleRevisionError,
  supersededReturn,
  toDirective,
  toRevision,
  unionChanged,
  withdrawnError,
  withdrawnReturn,
} from "./direction.ts";
import type { DecisionRow, DirectionInfo, DirectiveRow, IntentPatch, RevisionRow } from "./direction.ts";
import type { Direction, Directive, DirectiveKind, InboxDirective, IntentField, IntentRevision, NoteDecision } from "@fire_trident/core";
import { NeighborCache, claimLookup, type Neighbor } from "../trunk/cochange.ts";
import type { RevertResult } from "../trunk/revert.ts";
import {
  BUCKET_MS,
  COUNTER_SERIES,
  GAUGE_SERIES,
  LIVE_METRICS,
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
import { Certifier, type CertifyHost, type CertifyTrunk } from "../certify/certifier.ts";
import type { CertifyPolicy } from "../certify/repair.ts";
import { reviewPreview, type ReviewPreview } from "../agents/preview.ts";

/**
 * Result of ColonyDO.take: an assignment, or advice to wait and retry. `review`: what review will
 * ask of the change (agents/preview.ts), shown to the agent before it writes; absent when nothing.
 */
export type TakeResult = { intent: Intent; lease: WorkspaceLease; rule?: Rule; review?: ReviewPreview } | { wait: true; retryInMs: number; reason: string };

/** Input of ColonyDO.addIntent. */
export type IntentInput = Omit<Intent, "id" | "status" | "createdAt">;

/**
 * Input of ColonyDO.propose. `notify`: push the outcome to the agent's AgentDO (AgentDO.outcome)
 * when it lands, comes back or is escalated, so an in-platform agent need not poll for it.
 */
export type ProposalInput = Omit<Proposal, "id" | "status" | "createdAt" | "evidence"> & { evidence?: Partial<Evidence>; notify?: boolean };

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
/**
 * Concurrent takes share one claim reading per region, READING_TTL_MS old at most. Under load
 * (BUSY_TAKES takes in flight or more) a reading is shared for READING_BUSY_TTL_MS and then
 * refreshed in the background while takes keep using it, up to READING_STALE_MS old: claims made
 * since a reading started are overlaid, so a stale reading can only over-repel, never hide a claim.
 */
const READING_TTL_MS = 250;
const READING_BUSY_TTL_MS = 1_000;
const READING_STALE_MS = 3_000;
const BUSY_TAKES = 8;
/** Waiting agents together retry at about this many takes a second (see WaitPacer). */
const WAIT_TAKES_PER_S = 200;
/** Takes scoring candidates at once (see take); later ones wait their turn, up to TAKES_QUEUED. */
const TAKES_IN_FLIGHT = 128;
/** Takes waiting for a turn; past this the agent is told the colony is busy and to come back later. */
const TAKES_QUEUED = 1_024;
/** A take refreshes its agent's last-seen time at most this often. */
const LAST_SEEN_EVERY_MS = 15_000;
/** Buffered counter and gauge writes are flushed this often (see bump). */
const METRIC_FLUSH_MS = 1_000;
/** Under load, concurrent takes share the open-intent candidate list this long (see openCandidates). */
const CANDIDATES_TTL_MS = 200;
/** The metrics tick recomputes intent and agent counts (table scans) at most this often. */
const COUNTS_TTL_MS = 10_000;
/** In-platform agents' outcomes are pushed to them (AgentDO.outcome) in these states. */
const PUSHED_STATES: ReadonlySet<string> = new Set(["landed", "returned", "rejected", "escalated"]);
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
  // Proposals whose outcome is pushed to their agent (in-platform agents ask for it when they propose).
  "CREATE TABLE IF NOT EXISTS outcome_watch (proposal_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, at INTEGER NOT NULL)",
  // The event record for replays: what the colony published, in order (capped at RECORD_KEEP, see recordEvents).
  "CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, t TEXT NOT NULL, data TEXT NOT NULL)",
  // Reverts (`ft revert`): the intents each declared again and the rule violations it restored, so undoing a revert takes them back.
  "CREATE TABLE IF NOT EXISTS reverts (landing_id TEXT PRIMARY KEY, of TEXT NOT NULL, redo TEXT NOT NULL, restored TEXT NOT NULL, at INTEGER NOT NULL)",
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
/** Status-note events per agent at most this often (the note itself is always stored). */
const NOTE_EVENT_MS = 1_000;
/** How long a directive push to an in-platform agent may take before it counts as failed. */
const PUSH_TIMEOUT_MS = 5_000;
/** While the colony publishes, its record takes a sample of the live metrics this often. */
const RECORD_SAMPLE_MS = 3_000;
/** Metrics the record samples (the live hub's set, plus the totals the top bar shows). */
const SAMPLED_METRICS: readonly string[] = [...LIVE_METRICS, "landings", "landedIntents", "agents"];
/** Funnel totals go out this long after a proposal settles (several settling together send one update). */
const FUNNEL_EMIT_MS = 400;
/** The funnel's stages, in order. */
const FUNNEL_STAGES: readonly FunnelStage[] = ["proof", "reflex", "llm", "human"];
/** Events per page of GET /events at most. */
const EVENTS_PAGE_MAX = 5_000;
/** A reconstructed replay is rebuilt at most this often (pages of one replay share it). */
const RECON_TTL_MS = 10 * 60_000;
/** Rows a reconstruction reads per table at most. */
const RECON_ROWS = 20_000;

/** A directive for one agent to deliver, with the agent's kind (in-platform agents get it pushed). */
type Notice = { directive: Directive; kind: string; intent?: Intent };
/** How a directive reached its agent: pushed, left in the inbox (external agents), or the push failed. */
export type Notified = { agentId: Id; directiveId: Id; delivery: "pushed" | "inbox" | "failed" };

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
  /** Direction columns (direction.ts migrates older tables). */
  revision?: number;
  withdrawn_reason?: string | null;
};

type RuleRow = {
  id: string;
  kind: string;
  spec: string;
  description: string;
  approved_by: string;
  created_at: number;
  open_violations: number;
  retracted_at?: number | null;
  retracted_by?: string | null;
  retract_reason?: string | null;
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
  note?: string | null;
  note_at?: number | null;
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

/** A region's claim reading shared by concurrent takes (see readRegions). */
interface ReadingEntry {
  fetchStart: number;
  promise: Promise<FieldReading | null>;
  /** Set once the reading arrived: later takes use it without waiting. */
  reading?: FieldReading | null;
  /** Its claims and danger indexed for scoring, built once and shared. */
  index?: FieldIndex;
}

/** One region as self-assignment sees it. */
interface FieldView {
  /** Claim and danger values per path, the reader's own claims removed. */
  byPath: FieldReading["byPath"];
  repulsive: boolean;
  /** The same values indexed for scoring (views.ts). */
  index: FieldIndex;
  /** Recent claims of other agents the reading may not include. */
  unseen: RecentClaim[];
  open: boolean;
}

/** Side effects collected while changing proposal states, applied together. */
interface Effects {
  batch: FieldBatch;
  events: ColonyEvent[];
  enqueue: Array<{ proposal: Proposal; region: string; priority: number }>;
  dequeue: Map<string, Id[]>;
  release: Set<Id>;
  /** Outcomes to push to in-platform agents that asked for them (outcome_watch). */
  outcomes?: Proposal[];
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
  private readonly recentClaims = new Map<Id, RecentClaim>();
  /** Shared field readings for self-assignment (see readRegions), and the readings in flight. */
  private readonly readingCache = new Map<string, ReadingEntry>();
  private readonly pendingReadings = new Map<string, ReadingEntry>();
  /** Retry hints for waiting agents, and the pace regions send field events at (views.ts). */
  private readonly waits = new WaitPacer(WAIT_TAKES_PER_S);
  private readonly emitPace = new EmitPacer();
  /** Bounds the takes in flight (see take). */
  private readonly takeGate = new Gate(TAKES_IN_FLIGHT, TAKES_QUEUED);
  /** Metric and series writes waiting for the next flush (bump, setMetric, recordSeries). */
  private readonly pendingMetrics = new Map<string, { add: number; set: number | null; at: number }>();
  private readonly pendingSeries = new Map<string, { name: string; minute: number; value: number; gauge: boolean }>();
  private metricsFlush: ReturnType<typeof setTimeout> | null = null;
  /** The open-intent candidates shared by concurrent takes under load (openCandidates). */
  private candidateRows: { at: number; rows: Array<{ id: string; footprint: string; priority: number; created_at: number }> } | null = null;
  /** Intent and agent counts for the metrics tick, recomputed at most every COUNTS_TTL_MS (each is a scan). */
  private countsCache: { at: number; counts: Record<string, number> } | null = null;
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
  /** When each agent's last status-note event went out (see relay). */
  private readonly noteEmitted = new Map<Id, number>();
  /** Co-change neighbors of footprint files, cached from TrunkDO.neighbors (fails open). */
  private readonly cochange = new NeighborCache(
    (paths) => this.trunkStub().neighbors(paths, COCHANGE_K) as unknown as Promise<Record<Path, Neighbor[]>>,
  );
  /** The event record for replays: everything published, written in batches (see publish, recordEvents). */
  private readonly recorder = new EventRecorder(
    (events) => this.recordEvents(events),
    undefined,
    undefined,
    () => this.sampleMetrics(Date.now()),
  );
  private recordedSinceTrim = 0;
  /** Live metric values the record last sampled, when, and the trailing sample after the last write. */
  private readonly sampledMetrics = new Map<string, number>();
  private lastSampleAt = 0;
  private sampleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Funnel totals last published, and the pending publish after proposals settle (see scheduleFunnel). */
  private readonly funnelSent = new Map<string, number>();
  private funnelTimer: ReturnType<typeof setTimeout> | null = null;
  /** The last reconstructed replay, shared by the pages that read it. */
  private reconCache: { key: string; at: number; events: ColonyEvent[] } | null = null;
  /** Trunk certification: the colony's own tests after landings (certify/certifier.ts). */
  private readonly certifier: Certifier;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    for (const stmt of SCHEMA) this.sql.exec(stmt);
    for (const stmt of OPS_SCHEMA) this.sql.exec(stmt);
    migrateDirection(this.sql);
    this.backfillSeries();
    this.hub = new EventHub(() => this.ctx.getWebSockets());
    this.certifier = new Certifier(this.certifyHost());
    // Load tests only (FT_LAG_PROBE set): log how long this object's thread was busy or paused (lag.ts).
    if (env.FT_LAG_PROBE) {
      // Also on the live feed, so a load test records it beside its own timeline.
      new LagProbe(`colony ${ctx.id.name ?? ctx.id.toString()}`, (line) => {
        console.log(line);
        const worst = (JSON.parse(line) as { worstMs?: number }).worstMs;
        if (typeof worst === "number") this.publish({ t: "metric", at: Date.now(), name: "colony.lagMs", value: worst });
      }).start();
    }
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
      try {
        // A certification asked for before an eviction runs now.
        this.certifier.resume();
      } catch (err) {
        console.warn(`certification not resumed: ${errorText(err)}`);
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
        .exec<IntentRow>("SELECT * FROM intents WHERE status IN ('landed', 'abandoned', 'withdrawn') ORDER BY updated_at DESC LIMIT ?", SNAPSHOT_DONE_CAP)
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
    const violations = this.violationTotals();
    const certification = this.certifier.latestCertification();
    return {
      colony: certification ? { ...colony, certification } : colony,
      files,
      intents,
      agents,
      recentLandings,
      violations,
      funnel: this.funnelCounts(),
      metrics: this.currentMetrics(now),
      rules: this.sql.exec<RuleRow>("SELECT * FROM rules ORDER BY created_at").toArray().map((r) => this.toRule(r, colony.id)),
      series: this.seriesReport(now),
      convergence: this.convergence(violations.total),
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
    this.publish(this.violationsEvent(Date.now()));
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
  // Changing direction (chemotaxis): a human changes the gradient, needs
  // evaporate or move, agents re-orient. See colony/direction.ts.
  // =========================================================================

  /**
   * Amend an intent (title, why, footprint, priority) with a reason: its revision goes up by one and the
   * change is kept in its history. Needs move with the footprint (strength = priority) and claims leave
   * the paths it dropped. A substantive amendment (title, why or footprint) sends back the changes built
   * on the older revision and tells the holder, which keeps the intent and redoes the work against the
   * new revision (pushed to an in-platform agent, in an external agent's inbox). Landed, withdrawn and
   * sealed intents cannot be amended (409); an amendment that changes nothing returns the intent as is.
   */
  async amendIntent(id: Id, p: IntentPatch & { reason: string; by?: string }): Promise<{ intent: Intent; revision: IntentRevision | null; returned: number; notified: Notified[] }> {
    const colony = this.requireColony();
    const row = this.intentRow(id);
    if (!row) throw ftError(404, `unknown intent ${id}`);
    this.assertRedirectable(row, "amended");
    const reason = oneLine(String(p?.reason ?? ""), 500);
    if (!reason) throw ftError(400, "a reason is required: it is recorded with the revision and sent to the agent");
    const patch: IntentPatch = {};
    if (p.title !== undefined) {
      const title = String(p.title).trim();
      if (!title) throw ftError(400, "intent title cannot be empty");
      patch.title = title;
    }
    if (p.why !== undefined) patch.why = String(p.why);
    if (p.footprint !== undefined) {
      const footprint = normalizePaths(Array.isArray(p.footprint) ? p.footprint.map(String) : []);
      if (footprint.length === 0) throw ftError(400, "intent footprint must name at least one path");
      patch.footprint = footprint;
    }
    if (p.priority !== undefined) {
      if (typeof p.priority !== "number" || !Number.isFinite(p.priority) || p.priority < 0) throw ftError(400, "priority must be a number >= 0");
      patch.priority = p.priority;
    }
    if (Object.keys(patch).length === 0) throw ftError(400, "nothing to amend: give a title, why, footprint or priority");
    const current = this.toIntent(row, colony.id);
    const diff = intentChanges(current, patch);
    if (diff.changed.length === 0) return { intent: current, revision: null, returned: 0, notified: [] };

    const now = Date.now();
    const by = oneLine(p.by ?? "", 200) || "unknown";
    const revision = (row.revision ?? 1) + 1;
    this.sql.exec(
      "INSERT INTO intent_revisions (intent_id, revision, at, by, reason, changed, before, after, substantive) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      revision,
      now,
      by,
      reason,
      JSON.stringify(diff.changed),
      JSON.stringify(diff.before),
      JSON.stringify(diff.after),
      diff.substantive ? 1 : 0,
    );
    this.sql.exec(
      "UPDATE intents SET title = ?, why = ?, footprint = ?, priority = ?, revision = ?, updated_at = ? WHERE id = ?",
      diff.next.title,
      diff.next.why,
      JSON.stringify(diff.next.footprint),
      diff.next.priority,
      revision,
      now,
      id,
    );
    this.footprintCache.set(id, diff.next.footprint);

    const fx = this.effects(colony.regionDepth);
    const holder = row.assigned_to !== null && (row.status === "claimed" || row.status === "proposed") ? row.assigned_to : null;
    if (diff.changed.includes("footprint")) {
      const { added, removed } = footprintDelta(current.footprint, diff.next.footprint);
      if (removed.length > 0) fx.batch.clear(removed, { intentId: id, kind: "need" }).clear(removed, { intentId: id, kind: "claim" });
      if (holder && added.length > 0) fx.batch.deposit("claim", added, CLAIM_STRENGTH, now, { agentId: holder, intentId: id });
    }
    if (diff.changed.includes("footprint") || diff.changed.includes("priority")) fx.batch.deposit("need", diff.next.footprint, diff.next.priority, now, { intentId: id });

    let returned = 0;
    const notices: Notice[] = [];
    if (diff.substantive) {
      for (const prev of this.inFlightFor([id])) {
        const next: Proposal = { ...prev, status: "returned", reason: revisedReturn(prev.intentRevision ?? null, revision, diff.changed, reason) };
        this.writeProposal(next, now);
        this.transition(next, prev.status, now, fx);
        returned++;
      }
      const agent = holder ? this.agentRow(holder) : undefined;
      if (holder && agent) {
        // The holder works from the previous revision until it reads the notice (see stampDirection).
        this.sql.exec("INSERT INTO intent_acks (intent_id, agent_id, revision, at) VALUES (?, ?, ?, ?) ON CONFLICT(intent_id, agent_id) DO NOTHING", id, holder, revision - 1, now);
        notices.push({ directive: this.insertDirective({ agentId: holder, kind: "revision", intentId: id, message: reason, by, at: now, revision, changed: diff.changed }), kind: agent.kind });
      }
    }
    const fresh = this.intentRow(id);
    const intent = fresh ? this.toIntent(fresh, colony.id) : { ...current, ...diff.next, revision };
    fx.events.push({ t: "intent", at: now, intentId: id, status: intent.status, title: intent.title, footprint: intent.footprint });
    fx.events.push({ t: "amended", at: now, intentId: id, revision, changed: diff.changed, reason, by, title: intent.title, returned });
    await this.flushEffects(fx);
    for (const n of notices) n.intent = intent;
    const notified = await this.deliver(notices);
    return { intent, revision: { intentId: id, revision, changed: diff.changed, before: diff.before, after: diff.after, reason, by, at: now, substantive: diff.substantive }, returned, notified };
  }

  /**
   * Withdraw an intent before it lands: it becomes "withdrawn" (kept, with the reason), its needs
   * evaporate and its claims clear, the changes in flight for it go back ("withdrawn: ..."), and its
   * holder gives up its lease and is told to stop. Idempotent. Landed work is untouched (409).
   */
  async withdrawIntent(id: Id, p: { reason: string; by?: string }): Promise<{ intent: Intent; returned: number; notified: Notified[]; already?: true }> {
    const colony = this.requireColony();
    const row = this.intentRow(id);
    if (!row) throw ftError(404, `unknown intent ${id}`);
    if (row.status === "withdrawn") return { intent: this.toIntent(row, colony.id), returned: 0, notified: [], already: true };
    this.assertRedirectable(row, "withdrawn");
    const reason = oneLine(String(p?.reason ?? ""), 500);
    if (!reason) throw ftError(400, "a reason is required: it is recorded with the intent and sent to the agent");
    const now = Date.now();
    const fx = this.effects(colony.regionDepth);
    const out = this.withdrawRows([row], reason, oneLine(p.by ?? "", 200) || "unknown", now, fx);
    await this.flushEffects(fx);
    const notified = await this.deliver(out.notices);
    const fresh = this.intentRow(id);
    return { intent: this.toIntent(fresh ?? row, colony.id), returned: out.returned, notified };
  }

  /**
   * Retract a rule: it stays in history (retractedAt, by, reason) but is no longer checked, its open
   * violations no longer count, and every intent it created that has not landed is withdrawn (needs
   * evaporate, changes in flight go back, holders stop). Idempotent.
   */
  async retractRule(ruleId: Id, p: { reason: string; by?: string }): Promise<{ rule: Rule; withdrawn: number; returned: number; notified: Notified[]; already?: true }> {
    const colony = this.requireColony();
    const row = this.sql.exec<RuleRow>("SELECT * FROM rules WHERE id = ?", ruleId).toArray()[0];
    if (!row) throw ftError(404, `unknown rule ${ruleId}`);
    if (row.retracted_at) return { rule: this.toRule(row, colony.id), withdrawn: 0, returned: 0, notified: [], already: true };
    const reason = oneLine(String(p?.reason ?? ""), 500);
    if (!reason) throw ftError(400, "a reason is required: it is recorded with the rule and sent to the agents holding its intents");
    const now = Date.now();
    const by = oneLine(p.by ?? "", 200) || "unknown";
    this.sql.exec("UPDATE rules SET retracted_at = ?, retracted_by = ?, retract_reason = ?, open_violations = 0 WHERE id = ?", now, by, reason, ruleId);
    const rows = this.sql
      .exec<IntentRow>("SELECT * FROM intents WHERE rule_id = ? AND status IN ('open', 'claimed', 'proposed') AND created_by != 'vaccine'", ruleId)
      .toArray();
    const fx = this.effects(colony.regionDepth);
    const out = this.withdrawRows(rows, `rule ${ruleId} retracted: ${reason}`, by, now, fx, ruleId);
    fx.events.push({ t: "retracted", at: now, ruleId, reason, by, withdrawn: rows.length });
    fx.events.push(this.violationsEvent(now));
    await this.flushEffects(fx);
    const notified = await this.deliver(out.notices);
    const fresh = this.sql.exec<RuleRow>("SELECT * FROM rules WHERE id = ?", ruleId).toArray()[0] ?? row;
    return { rule: this.toRule(fresh, colony.id), withdrawn: rows.length, returned: out.returned, notified };
  }

  /**
   * Undo a landed change (`ft revert`): a person's decision, recorded with their reason in the event
   * record and in the revert commit's lineage note. The trunk writer refuses when work has landed on
   * top of the change. Unless `redo` is false, each intent the landing completed comes back as a new
   * intent (its parent is the one undone, its why starts with the reason), and the violations a rule
   * fix had cleared count again until that intent lands.
   */
  async revertLanding(ref: string, p: { reason: string; by?: string; redo?: boolean }): Promise<{ landing: Landing; reverted: Landing; redo: Id[] }> {
    const colony = this.requireColony();
    const reason = oneLine(String(p?.reason ?? ""), 500);
    if (!reason) throw ftError(400, "a reason is required: it is recorded with the revert and given to the intents it brings back");
    const by = oneLine(p.by ?? "", 200) || "unknown";
    const res = (await this.trunkStub().revert(String(ref ?? ""), { by, reason })) as RevertResult;
    if (!res.ok) throw ftError(res.status, res.error);
    this.noteSystemCommit(res.landing);
    const now = Date.now();
    const drafts: Array<IntentInput & { violations?: number }> = [];
    const restored: Array<{ ruleId: Id; violations: number }> = [];
    if (p.redo !== false) {
      for (const intentId of res.reverted.intentIds) {
        const row = this.intentRow(intentId);
        if (!row || row.status !== "landed") continue;
        const original = this.toIntent(row, colony.id);
        const rule = row.rule_id ? this.sql.exec<{ retracted_at: number | null }>("SELECT retracted_at FROM rules WHERE id = ?", row.rule_id).toArray()[0] : undefined;
        const ruleId = rule && !rule.retracted_at ? row.rule_id : null;
        drafts.push({
          colonyId: colony.id,
          title: oneLine(`Redo after revert: ${original.title}`, 200),
          why: `${by} reverted ${res.reverted.id} (${res.reverted.trunkSha.slice(0, 7)}): ${reason}\n\n${original.why}`,
          source: ruleId ? "rule" : "human",
          ...(ruleId ? { ruleId, violations: row.violations } : {}),
          parentId: original.id,
          footprint: original.footprint,
          ...(original.acceptance ? { acceptance: original.acceptance } : {}),
          priority: original.priority,
          createdBy: by,
        });
        if (ruleId && row.violations > 0) restored.push({ ruleId, violations: row.violations });
      }
    }
    const redo = drafts.length > 0 ? (await this.createIntents(drafts)).map((i) => i.id) : [];
    for (const r of restored) this.sql.exec("UPDATE rules SET open_violations = open_violations + ? WHERE id = ?", r.violations, r.ruleId);
    this.sql.exec("INSERT OR REPLACE INTO reverts (landing_id, of, redo, restored, at) VALUES (?, ?, ?, ?, ?)", res.landing.id, res.reverted.id, JSON.stringify(redo), JSON.stringify(restored), now);
    this.publish({ t: "reverted", at: now, landingId: res.landing.id, of: res.reverted.id, trunkSha: res.landing.trunkSha, paths: res.landing.paths, reason, by, redo });

    // Undoing a revert puts its change back: the intents it declared again are not needed any more
    // (none can have landed, or this revert would have been refused), and its violations are fixed again.
    const prior = this.sql.exec<{ redo: string; restored: string }>("SELECT redo, restored FROM reverts WHERE landing_id = ?", res.reverted.id).toArray()[0];
    if (prior) {
      const rows = (JSON.parse(prior.redo) as Id[])
        .map((id) => this.intentRow(id))
        .filter((r): r is IntentRow => r !== undefined && (r.status === "open" || r.status === "claimed" || r.status === "proposed"));
      for (const r of JSON.parse(prior.restored) as Array<{ ruleId: Id; violations: number }>) {
        this.sql.exec("UPDATE rules SET open_violations = MAX(0, open_violations - ?) WHERE id = ?", r.violations, r.ruleId);
      }
      const fx = this.effects(colony.regionDepth);
      const out = this.withdrawRows(rows, `${res.reverted.id} was itself reverted by ${by}: ${reason}`, by, now, fx);
      fx.events.push(this.violationsEvent(now));
      await this.flushEffects(fx);
      await this.deliver(out.notices);
    } else if (restored.length > 0) {
      this.publish(this.violationsEvent(now));
    }
    return { landing: res.landing, reverted: res.reverted, redo };
  }

  /**
   * Send free-text guidance to one agent, about the intent it holds unless `intentId` names another.
   * An in-platform agent gets it pushed and folds it into its next prompt, re-planning work it has not
   * proposed (and recalling a proposal still in flight); an external agent reads it in its inbox.
   */
  async direct(agentId: Id, p: { message: string; intentId?: Id; by?: string }): Promise<Directive & { delivery: Notified["delivery"] }> {
    this.requireColony();
    const agent = this.requireAgent(agentId);
    const message = String(p?.message ?? "").trim();
    if (!message) throw ftError(400, "a directive needs a message");
    if (message.length > MAX_DIRECTIVE_CHARS) throw ftError(400, `a directive is at most ${MAX_DIRECTIVE_CHARS} characters`);
    let intentId = typeof p.intentId === "string" && p.intentId.trim() ? p.intentId.trim() : undefined;
    if (intentId && !this.intentRow(intentId)) throw ftError(404, `unknown intent ${intentId}`);
    intentId ??= agent.intent_id ?? undefined;
    const now = Date.now();
    const by = oneLine(p.by ?? "", 200) || "unknown";
    const d = this.insertDirective({ agentId, kind: "guidance", ...(intentId ? { intentId } : {}), message, by, at: now });
    const intent = intentId ? this.intentRow(intentId) : undefined;
    const [n] = await this.deliver([{ directive: d, kind: agent.kind, ...(intent ? { intent: this.toIntent(intent, d.colonyId) } : {}) }]);
    const fresh = this.sql.exec<DirectiveRow>("SELECT * FROM directives WHERE id = ?", d.id).toArray()[0];
    const out = fresh ? toDirective(fresh, d.colonyId) : d;
    this.publish({ t: "directive", at: now, directiveId: d.id, agentId, ...(intentId ? { intentId } : {}), message, by, ...(out.via ? { via: out.via } : {}) });
    return { ...out, delivery: n?.delivery ?? "failed" };
  }

  /**
   * An agent takes back its own change while it is in flight (a directive changed its course): it is
   * returned ("superseded: ..."), and the agent keeps its intent, claim and lease to redo it. A change
   * already decided is returned as it is.
   */
  async recall(agentId: Id, proposalId: Id, reason = "recalled by its agent"): Promise<Proposal> {
    const colony = this.requireColony();
    this.requireAgent(agentId);
    const row = this.proposalRow(proposalId);
    if (!row) throw ftError(404, `unknown proposal ${proposalId}`);
    const prev = JSON.parse(row.data) as Proposal;
    if (prev.agentId !== agentId) throw ftError(409, `proposal ${proposalId} is not ${agentId}'s`);
    if (!OPEN_LIKE.has(prev.status) && prev.status !== "escalated") return prev;
    const now = Date.now();
    const next: Proposal = { ...prev, status: "returned", reason: supersededReturn(reason) };
    this.writeProposal(next, now);
    const fx = this.effects(colony.regionDepth);
    this.transition(next, prev.status, now, fx);
    await this.flushEffects(fx);
    return next;
  }

  /**
   * An agent's one-line "what I am doing now": stored on the agent (GET agents shows it), recorded in
   * the evidence of its next proposal (and so in the lineage note), and emitted live (at most one event
   * per agent per second). Counts as a sign of life.
   */
  async relay(agentId: Id, note: string): Promise<{ note: string; at: number; emitted: boolean }> {
    this.requireColony();
    const agent = this.requireAgent(agentId);
    const text = cleanNote(String(note ?? ""));
    if (!text) throw ftError(400, "a status note cannot be empty");
    const now = Date.now();
    this.sql.exec("UPDATE agents SET note = ?, note_at = ?, last_seen = ? WHERE id = ?", text, now, now, agentId);
    const emitted = now - (this.noteEmitted.get(agentId) ?? 0) >= NOTE_EVENT_MS;
    if (emitted) {
      if (this.noteEmitted.size > 20_000) this.noteEmitted.clear();
      this.noteEmitted.set(agentId, now);
      this.publish({ t: "status", at: now, agentId, ...(agent.intent_id ? { intentId: agent.intent_id } : {}), note: text });
    }
    return { note: text, at: now, emitted };
  }

  /**
   * The human guidance about an intent (the latest few, oldest first). An agent that takes the intent
   * over from another follows it too: guidance is about the work, not only the agent it was sent to.
   */
  async guidance(intentId: Id): Promise<Array<{ id: Id; message: string; by: string; at: number }>> {
    this.requireColony();
    return this.guidanceRows(intentId);
  }

  /** One intent with its revision history (oldest first) and the directives about it (newest first). */
  async intentHistory(id: Id): Promise<{ intent: Intent; revisions: IntentRevision[]; directives: Directive[] } | null> {
    const colony = this.requireColony();
    const row = this.intentRow(id);
    if (!row) return null;
    const directives = this.sql
      .exec<DirectiveRow>("SELECT * FROM directives WHERE intent_id = ? ORDER BY at DESC LIMIT 100", id)
      .toArray()
      .map((r) => toDirective(r, colony.id));
    return { intent: this.toIntent(row, colony.id), revisions: this.revisionRows(id).map(toRevision), directives };
  }

  /** Amending or withdrawing needs an intent that is still live: not landed, withdrawn or sealed. */
  private assertRedirectable(row: IntentRow, verb: string): void {
    if (row.status === "landed") throw ftError(409, `intent ${row.id} already landed; landed work is untouched (declare a new intent to change it further)`);
    if (row.status === "withdrawn") throw ftError(409, `intent ${row.id} was withdrawn${row.withdrawn_reason ? ` (${row.withdrawn_reason})` : ""} and cannot be ${verb}`);
    if (row.status === "abandoned" || row.created_by === "vaccine") throw ftError(409, `intent ${row.id} is sealed (${row.status}) and cannot be ${verb}`);
  }

  /**
   * Withdraw these intents in one batch of effects: status, reason, needs and claims cleared, changes
   * in flight sent back (see settleRedirect), holders idle with their leases released and a withdrawal
   * notice each. Returns the notices to deliver and how many changes went back.
   */
  private withdrawRows(rows: IntentRow[], reason: string, by: string, now: number, fx: Effects, ruleId?: Id): { notices: Notice[]; returned: number } {
    if (rows.length === 0) return { notices: [], returned: 0 };
    const inflight = this.inFlightFor(rows.map((r) => r.id));
    const perIntent = new Map<Id, number>();
    for (const p of inflight) perIntent.set(p.intentId, (perIntent.get(p.intentId) ?? 0) + 1);
    for (const row of rows) {
      const fp = this.footprintOf(row.id, row.footprint);
      this.sql.exec("UPDATE intents SET status = 'withdrawn', withdrawn_reason = ?, assigned_to = NULL, updated_at = ? WHERE id = ?", reason, now, row.id);
      fx.batch.clear(fp, { intentId: row.id, kind: "need" }).clear(fp, { intentId: row.id, kind: "claim" });
      fx.events.push({ t: "intent", at: now, intentId: row.id, status: "withdrawn", title: row.title, footprint: fp });
    }
    for (const prev of inflight) {
      const next: Proposal = { ...prev, status: "returned", reason: withdrawnReturn(reason) };
      this.writeProposal(next, now);
      this.transition(next, prev.status, now, fx);
    }
    const notices: Notice[] = [];
    for (const row of rows) {
      fx.events.push({ t: "withdrawn", at: now, intentId: row.id, reason, by, title: row.title, returned: perIntent.get(row.id) ?? 0, ...(ruleId ? { ruleId } : {}) });
      if (!row.assigned_to) continue;
      const agent = this.agentRow(row.assigned_to);
      if (!agent) continue;
      if (agent.intent_id === row.id) {
        this.sql.exec("UPDATE agents SET state = 'idle', intent_id = NULL, workspace = NULL WHERE id = ?", agent.id);
        if (agent.state !== "idle") fx.events.push({ t: "agent", at: now, agentId: agent.id, kind: agent.kind as AgentKind, state: "idle" });
        fx.release.add(agent.id);
      }
      notices.push({ directive: this.insertDirective({ agentId: agent.id, kind: "withdrawal", intentId: row.id, message: reason, by, at: now }), kind: agent.kind });
    }
    return { notices, returned: inflight.length };
  }

  /**
   * A change sent back because its direction changed (see isRedirect): no failure mark and nothing
   * reopens. For a withdrawn intent the agent goes idle and gives its lease back; for a revised one, or
   * one its agent recalled, the holder keeps intent, claim and lease and works on.
   */
  private settleRedirect(p: Proposal, intent: IntentRow | undefined, agent: AgentRow | undefined, now: number, fx: Effects): void {
    this.bump("redirected", 1, now);
    if (!intent || intent.status === "withdrawn" || intent.status === "landed" || intent.status === "abandoned") {
      if (intent?.status === "withdrawn") fx.batch.clear(this.footprintOf(intent.id, intent.footprint), { agentId: p.agentId, intentId: p.intentId, kind: "claim" });
      if (agent && agent.intent_id === p.intentId && intent?.status !== "landed") {
        this.sql.exec("UPDATE agents SET state = 'idle', intent_id = NULL, workspace = NULL WHERE id = ?", agent.id);
        if (agent.state !== "idle") fx.events.push({ t: "agent", at: now, agentId: agent.id, kind: agent.kind as AgentKind, state: "idle" });
        fx.release.add(agent.id);
      }
      return;
    }
    if (intent.status === "proposed" && intent.assigned_to === p.agentId && this.inFlightFor([intent.id]).every((x) => x.id === p.id || x.agentId !== p.agentId)) {
      this.sql.exec("UPDATE intents SET status = 'claimed', updated_at = ? WHERE id = ? AND status = 'proposed'", now, intent.id);
      fx.events.push({ t: "intent", at: now, intentId: intent.id, status: "claimed", title: intent.title, footprint: this.footprintOf(intent.id, intent.footprint) });
    }
    if (agent && agent.intent_id === p.intentId && agent.state === "proposing") {
      this.sql.exec("UPDATE agents SET state = 'working' WHERE id = ?", agent.id);
      fx.events.push({ t: "agent", at: now, agentId: agent.id, kind: agent.kind as AgentKind, state: "working", intentId: p.intentId });
    }
  }

  /**
   * Stamp a new proposal with the intent revision it was built on: the agent's own claim, else the
   * revision it last saw if the intent was amended while it held it, else the current one. A change
   * built on an older revision is refused (409) when a substantive amendment came after it. The
   * direction (revision, history, the human guidance the agent received for this intent, its last
   * status note) goes into the evidence and from there into the lineage note.
   */
  private stampDirection(draft: Proposal, row: IntentRow, claimed: unknown): void {
    const current = row.revision ?? 1;
    let built = current;
    if (typeof claimed === "number" && Number.isInteger(claimed) && claimed >= 1) built = Math.min(claimed, current);
    else if (current > 1) {
      const ack = this.sql.exec<{ revision: number }>("SELECT revision FROM intent_acks WHERE intent_id = ? AND agent_id = ?", row.id, draft.agentId).toArray()[0];
      if (ack) built = Math.min(ack.revision, current);
    }
    const revisions = current > 1 ? this.revisionRows(row.id) : [];
    if (built < current) {
      const later = revisions.filter((r) => r.revision > built && r.substantive === 1).map(toRevision);
      const last = later[later.length - 1];
      if (last) throw ftError(409, staleRevisionError(row.id, built, current, unionChanged(later), last.reason));
      built = current; // only the priority moved since: the change still fits the current revision
    }
    draft.intentRevision = built;
    const direction: Direction = { intentRevision: built };
    if (revisions.length > 0) {
      direction.revisions = revisions.slice(-MAX_REVISIONS).map((r) => {
        const v = toRevision(r);
        return { revision: v.revision, changed: v.changed, reason: v.reason, by: v.by, at: v.at };
      });
    }
    // Guidance is about the intent: whichever agent proposes for it, the change was made under it.
    const directives = this.guidanceRows(row.id);
    if (directives.length > 0) direction.directives = directives;
    const note = this.agentRow(draft.agentId)?.note;
    if (note) direction.note = note;
    // Only when it says something: an unamended intent, no guidance and no note leave the evidence as it was.
    if (built > 1 || direction.directives || direction.note) draft.evidence = { ...draft.evidence, direction };
  }

  /** The human guidance about an intent, the latest MAX_NOTE_DIRECTIVES, oldest first. */
  private guidanceRows(intentId: Id): Array<{ id: Id; message: string; by: string; at: number }> {
    return this.sql
      .exec<{ id: string; message: string; by: string; at: number }>(
        "SELECT id, message, by, at FROM directives WHERE intent_id = ? AND kind = 'guidance' ORDER BY at DESC LIMIT ?",
        intentId,
        MAX_NOTE_DIRECTIVES,
      )
      .toArray()
      .reverse()
      .map((d) => ({ id: d.id, message: d.message, by: d.by, at: d.at }));
  }

  /**
   * An intent as the decide arc reviews it: its human guidance is part of its direction, appended to
   * the why, so a change that follows a directive is judged against it instead of as off-intent.
   */
  private reviewIntent(id: Id): Intent | null {
    const r = this.intentRow(id);
    if (!r) return null;
    const intent = this.toIntent(r, this.requireColony().id);
    const guidance = this.guidanceRows(id);
    if (guidance.length > 0) intent.why = `${intent.why}\n\n${guidanceText(guidance)}`;
    return intent;
  }

  /** Changes in flight (pending, checking, in a lane, or waiting for a human) for these intents, oldest first. */
  private inFlightFor(intentIds: Id[]): Proposal[] {
    const want = new Set(intentIds);
    return this.sql
      .exec<{ intent_id: string; data: string }>("SELECT intent_id, data FROM proposals WHERE status IN ('pending', 'checking', 'ready', 'escalated') ORDER BY created_at")
      .toArray()
      .filter((r) => want.has(r.intent_id))
      .map((r) => JSON.parse(r.data) as Proposal);
  }

  private revisionRows(intentId: Id): RevisionRow[] {
    return this.sql.exec<RevisionRow>("SELECT * FROM intent_revisions WHERE intent_id = ? ORDER BY revision", intentId).toArray();
  }

  private insertDirective(d: { agentId: Id; kind: DirectiveKind; intentId?: Id; message: string; by: string; at: number; revision?: number; changed?: IntentField[] }): Directive {
    const out: Directive = { id: newId("dir_"), colonyId: this.requireColony().id, agentId: d.agentId, kind: d.kind, message: d.message, by: d.by, at: d.at };
    if (d.intentId) out.intentId = d.intentId;
    if (typeof d.revision === "number") out.revision = d.revision;
    if (d.changed) out.changed = d.changed;
    this.sql.exec(
      "INSERT INTO directives (id, agent_id, kind, intent_id, message, by, at, revision, changed, delivered_at, via) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)",
      out.id,
      out.agentId,
      out.kind,
      out.intentId ?? null,
      out.message,
      out.by,
      out.at,
      out.revision ?? null,
      out.changed ? JSON.stringify(out.changed) : null,
    );
    return out;
  }

  /** Deliver notices: pushed to in-platform agents (AgentDO.direct), left in the inbox of external ones. */
  private async deliver(notices: Notice[]): Promise<Notified[]> {
    return Promise.all(
      notices.map(async (n): Promise<Notified> => {
        const base = { agentId: n.directive.agentId, directiveId: n.directive.id };
        if (n.kind !== "internal" && n.kind !== "synthetic") return { ...base, delivery: "inbox" };
        return { ...base, delivery: (await this.pushDirective(n.directive, n.intent)) ? "pushed" : "failed" };
      }),
    );
  }

  /** Push a directive to an in-platform agent; true when the agent took it (marked delivered). */
  private async pushDirective(d: Directive, intent?: Intent): Promise<boolean> {
    const ns = (this.env as unknown as { AGENT?: DurableObjectNamespace }).AGENT;
    if (!ns) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const stub = ns.get(ns.idFromName(d.agentId)) as unknown as { direct(p: { directive: Directive; intent?: Intent }): Promise<unknown> };
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer in ${PUSH_TIMEOUT_MS} ms`)), PUSH_TIMEOUT_MS);
      });
      await Promise.race([stub.direct(intent ? { directive: d, intent } : { directive: d }), timeout]);
      this.sql.exec("UPDATE directives SET delivered_at = ?, via = 'push' WHERE id = ? AND delivered_at IS NULL", Date.now(), d.id);
      return true;
    } catch (err) {
      console.warn(`directive ${d.id} not pushed to ${d.agentId}: ${errorText(err)}`);
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
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
      this.publish(events);
    }
    return out;
  }

  /** One agent (with its lease, for the agent itself). */
  async getAgent(agentId: Id): Promise<AgentInfo | null> {
    const row = this.agentRow(agentId);
    return row ? this.toAgent(row, this.requireColony().id, false) : null;
  }

  /**
   * What a lane needs right before landing, in one call: each intent's lineage fields plus its
   * direction (status, revision, withdrawal reason, substantive amendments) so the lane can send back
   * changes for withdrawn or revised intents; each agent's kind and model; and the decide-arc
   * decisions recorded for each proposal (keyed by proposal id, the latest MAX_NOTE_DECISIONS each).
   * Lanes pass it on to TrunkDO.land, so the trunk writer never pulls a snapshot and the lineage note
   * carries the decisions.
   */
  async landContext(intentIds: Id[], agentIds: Id[], proposalIds: Id[] = []): Promise<{
    intents: Record<Id, { title: string; why: string; ruleId?: Id; parentId?: Id } & DirectionInfo>;
    agents: Record<Id, { kind: AgentKind; model?: string }>;
    decisions: Record<Id, NoteDecision[]>;
  }> {
    const colonyId = this.requireColony().id;
    const intents: Record<Id, { title: string; why: string; ruleId?: Id; parentId?: Id } & DirectionInfo> = {};
    for (const id of new Set(intentIds)) {
      const row = this.intentRow(id);
      if (!row) continue;
      const i = this.toIntent(row, colonyId);
      const entry: { title: string; why: string; ruleId?: Id; parentId?: Id } & DirectionInfo = { title: i.title, why: i.why, status: i.status, revision: i.revision ?? 1 };
      if (i.ruleId) entry.ruleId = i.ruleId;
      if (i.parentId) entry.parentId = i.parentId;
      if (i.withdrawnReason) entry.withdrawnReason = i.withdrawnReason;
      if ((i.revision ?? 1) > 1) {
        entry.revisions = this.revisionRows(id)
          .filter((r) => r.substantive === 1)
          .slice(-MAX_REVISIONS)
          .map((r) => ({ revision: r.revision, changed: toRevision(r).changed, reason: r.reason, at: r.at }));
      }
      intents[id] = entry;
    }
    const agents: Record<Id, { kind: AgentKind; model?: string }> = {};
    for (const id of new Set(agentIds)) {
      const row = this.agentRow(id);
      if (!row) continue;
      const a = this.toAgent(row, colonyId, false);
      agents[id] = { kind: a.kind, ...(a.model ? { model: a.model } : {}) };
    }
    const wanted = [...new Set(Array.isArray(proposalIds) ? proposalIds : [])].slice(0, 500);
    const decisions =
      wanted.length > 0
        ? noteDecisions(
            this.sql
              .exec<DecisionRow>(
                "SELECT id, kind, subject, layer, answers, p, action, at FROM decisions WHERE subject IN (SELECT value FROM json_each(?)) ORDER BY at",
                JSON.stringify(wanted),
              )
              .toArray(),
          )
        : {};
    return { intents, agents, decisions };
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
    // Backpressure: TAKES_IN_FLIGHT takes score candidates at once and up to TAKES_QUEUED more wait
    // their turn; past that the agent is told to come back later (paced like any wait). Every take in
    // flight holds its candidate set while it awaits regions and the pool: thousands at once (5,000
    // agents ramping up) exhausted the isolate's memory and reset the colony.
    const turn = this.takeGate.enter();
    if (turn === null) return this.waitFor(agentId, BUSY_RETRY_MS, "colony busy: too many takes in flight", Date.now());
    this.taking.add(agentId);
    try {
      if (turn !== true) await turn;
      return await this.takeFor(agentId);
    } finally {
      this.takeGate.leave();
      this.taking.delete(agentId);
    }
  }

  private async takeFor(agentId: Id): Promise<TakeResult> {
    const colony = this.requireColony();
    const agent = this.requireAgent(agentId);
    const now = Date.now();
    // Last-seen is written at most every LAST_SEEN_EVERY_MS per agent (the reaper waits 10 minutes):
    // waiting agents retry often, and a write per retry was the colony's main storage load.
    if (agent.state === "dead" || now - agent.last_seen >= LAST_SEEN_EVERY_MS) {
      this.sql.exec("UPDATE agents SET last_seen = ?, state = CASE WHEN state = 'dead' THEN 'idle' ELSE state END WHERE id = ?", now, agentId);
    }
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
    const rows = this.openCandidates(now);
    if (rows.length === 0) return this.waitFor(agentId, IDLE_RETRY_MS, "no open intents", now);
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
          rep += fastRepulsion(view.index, paths);
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
    const later = Date.now();
    if (candidates.every((c) => !c.admissionOpen)) return this.waitFor(agentId, CLOSED_RETRY_MS, "admission closed in every candidate region", later);
    if (candidates.every((c) => !c.admissionOpen || inhibited(c, inhibitAt))) {
      return this.waitFor(agentId, CLOSED_RETRY_MS, "every open intent's files are claimed by another agent", later);
    }
    return this.waitFor(agentId, DECLINED_RETRY_MS, "no intent accepted at this agent's thresholds", later);
  }

  /**
   * Tell an agent to wait. The retry hint grows with the number of agents waiting (WaitPacer), so
   * thousands of waiting agents come back at a pace the colony can serve instead of all at once.
   */
  private waitFor(agentId: Id, baseMs: number, reason: string, now: number): TakeResult {
    this.setAgentState(agentId, "waiting", now);
    return { wait: true, retryInMs: jitter(this.waits.wait(agentId, baseMs, now), this.rand), reason };
  }

  /**
   * Liveness: the agent's last-seen time, and a refresh of the claim marks it still holds (at most
   * every 15 s). Only existing claims are re-dated (RegionDO.refreshClaims): a claim cleared by a
   * landing or a return is never re-created by a heartbeat that raced it. Agents that refresh
   * their claims in the regions themselves (in-platform agents) pass `{ claims: false }`.
   */
  async heartbeat(agentId: Id, opts: { claims?: boolean } = {}): Promise<void> {
    const colony = this.requireColony();
    const agent = this.requireAgent(agentId);
    const now = Date.now();
    this.sql.exec("UPDATE agents SET last_seen = ? WHERE id = ?", now, agentId);
    if (agent.state === "dead") this.setAgentState(agentId, "idle", now);
    this.maybeReap(now);
    if (opts?.claims === false) {
      this.lastRefresh.set(agentId, now);
      return;
    }
    if (now - (this.lastRefresh.get(agentId) ?? 0) < CLAIM_REFRESH_MS) return;
    const held = this.sql
      .exec<{ id: string; footprint: string }>("SELECT id, footprint FROM intents WHERE assigned_to = ? AND status IN ('claimed', 'proposed')", agentId)
      .toArray();
    if (held.length === 0) return;
    this.lastRefresh.set(agentId, now);
    const byRegion = new Map<string, { intentIds: Set<Id>; deposit: Array<{ path: Path; intentId: Id }> }>();
    for (const h of held) {
      for (const [region, paths] of groupByRegion(this.footprintOf(h.id, h.footprint), colony.regionDepth)) {
        let r = byRegion.get(region);
        if (!r) byRegion.set(region, (r = { intentIds: new Set(), deposit: [] }));
        r.intentIds.add(h.id);
        for (const path of paths) r.deposit.push({ path, intentId: h.id });
      }
    }
    await Promise.all(
      [...byRegion].map(async ([region, r]) => {
        try {
          const stub = await this.region(region);
          try {
            await stub.refreshClaims({ agentId, intentIds: [...r.intentIds] });
          } catch (err) {
            if (!/does not implement/i.test(errorText(err))) throw err;
            // A region still on the previous version (mid-deploy): deposit the claims as before.
            await stub.apply({ deposit: r.deposit.map((d) => ({ kind: "claim" as const, path: d.path, strength: CLAIM_STRENGTH, at: now, agentId, intentId: d.intentId })) });
          }
        } catch (err) {
          console.error(`claim refresh failed in region ${region} for ${agentId}: ${errorText(err)}`);
        }
      }),
    );
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
    if (repeat) {
      if (input.notify === true && !SENT_BACK.has(repeat.status) && repeat.status !== "landed") this.watchOutcome(repeat.id, repeat.agentId);
      return repeat;
    }
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
    // Direction: refuse a change built on an older revision; record revision, directives and status note.
    this.stampDirection(draft, intentRow, input.intentRevision);

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
    if (input.notify === true) this.watchOutcome(proposal.id, proposal.agentId);
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

  /**
   * An agent's inbox, newest first: its recent proposals (their outcomes) and, unless `proposalsOnly`,
   * the directives addressed to it: human guidance, and revisions and withdrawals of intents it held.
   * A directive entry lines up with a proposal entry (id, intentId, status "directive", reason = what
   * to do, createdAt), so readers that list proposals show it too (see InboxDirective). Reading a
   * directive here marks it delivered; reading a revision notice records that the agent saw that
   * revision (stampDirection then accepts changes built on it).
   */
  async inbox(agentId: Id, limit = 20, opts: { proposalsOnly?: boolean } = {}): Promise<Array<Proposal | InboxDirective>> {
    const n = Math.max(1, Math.min(200, Math.floor(Number(limit) || 20)));
    const proposals: Array<Proposal | InboxDirective> = this.sql
      .exec<{ data: string }>("SELECT data FROM proposals WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?", agentId, n)
      .toArray()
      .map((r) => JSON.parse(r.data) as Proposal);
    if (opts?.proposalsOnly) return proposals;
    const fetched = this.sql.exec<DirectiveRow>("SELECT * FROM directives WHERE agent_id = ? ORDER BY at DESC LIMIT ?", agentId, n).toArray();
    if (fetched.length === 0) return proposals;
    // Only the directives that make the newest `n` entries are shown, so only those count as read.
    const oldestShown = [...proposals.map((p) => p.createdAt), ...fetched.map((r) => r.at)].sort((a, b) => b - a)[n - 1] ?? Number.NEGATIVE_INFINITY;
    const rows = fetched.filter((r) => r.at >= oldestShown);
    const now = Date.now();
    const colonyId = this.loadColony()?.colony.id ?? "";
    for (const r of rows) {
      if (r.delivered_at === null) {
        this.sql.exec("UPDATE directives SET delivered_at = ?, via = 'inbox' WHERE id = ? AND delivered_at IS NULL", now, r.id);
        r.delivered_at = now;
        r.via = "inbox";
      }
      if (r.kind === "revision" && r.intent_id && typeof r.revision === "number") {
        this.sql.exec(
          "INSERT INTO intent_acks (intent_id, agent_id, revision, at) VALUES (?, ?, ?, ?) ON CONFLICT(intent_id, agent_id) DO UPDATE SET revision = MAX(revision, excluded.revision), at = excluded.at",
          r.intent_id,
          agentId,
          r.revision,
          now,
        );
      }
    }
    return [...proposals, ...rows.map((r) => inboxEntry(toDirective(r, colonyId)))].sort((a, b) => b.createdAt - a.createdAt).slice(0, n);
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
    // Trunk moved: certify the newest trunk soon (asynchronous; nothing here waits for it).
    this.certifier.landed(l);
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
    this.scheduleFunnel();
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
      // The intent with its human guidance: a change that follows a directive is judged against it, not as off-intent.
      intent: (id) => this.reviewIntent(id),
      rules: () => {
        const colonyId = this.requireColony().id;
        // A retracted rule is history: it is no longer checked.
        return this.sql.exec<RuleRow>("SELECT * FROM rules WHERE retracted_at IS NULL ORDER BY created_at").toArray().map((r) => this.toRule(r, colonyId));
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
      emit: (events) => void this.publish(events),
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
    this.publish(events);
  }

  /** A FireTrident-authored trunk commit (an antibody) landed: track the trunk head and show it live. */
  private noteSystemCommit(l: Landing): void {
    const cached = this.loadColony();
    if (l.trunkSha && l.at >= (cached?.lastLandingAt ?? 0)) {
      this.sql.exec("UPDATE colony SET trunk_sha = ?, last_landing_at = ?", l.trunkSha, l.at);
      this.colonyCache = null;
    }
    this.publish({ t: "landing", at: Date.now(), landingId: l.id, trunkSha: l.trunkSha, proposalIds: [], paths: l.paths });
    this.certifier.landed(l);
  }

  // =========================================================================
  // Trunk certification (certify/certifier.ts)
  // =========================================================================

  /** Certification switches, policy, whether a run is in flight or asked for, the latest result and greenSha. */
  async certifyState(): Promise<ReturnType<Certifier["state"]>> {
    this.requireColony();
    return this.certifier.state();
  }

  /** Certification results, newest first (at most 500). */
  async certifications(limit = 50): Promise<Certification[]> {
    this.requireColony();
    return this.certifier.list(limit);
  }

  /** One commit's certification (a full sha or a unique prefix of 7+ characters), or null. */
  async certification(sha: string): Promise<Certification | null> {
    this.requireColony();
    return this.certifier.get(sha);
  }

  /** Certify the current trunk now (an operator asked), even when it was certified before. */
  async certifyNow(): Promise<{ started: boolean; reason?: string }> {
    this.requireColony();
    return this.certifier.certifyNow();
  }

  /** Change this colony's certification policy (partial): on/off, repairs, limits. */
  async setCertifyPolicy(patch: unknown): Promise<CertifyPolicy> {
    this.requireColony();
    const r = this.certifier.setPolicy(patch);
    if ("error" in r) throw ftError(400, r.error);
    return r;
  }

  /** What the certifier may use of this colony. */
  private certifyHost(): CertifyHost {
    return {
      sql: this.sql,
      enabled: () => this.env.FT_TRUNK_TESTS === "on",
      loader: () => this.env.LOADER,
      trunk: () => this.trunkStub() as unknown as CertifyTrunk,
      publish: (e) => {
        this.publish(e);
      },
      exists: () => this.loadColony() !== null,
      greenSha: () => this.loadColony()?.colony.greenSha ?? null,
      setGreen: (sha) => {
        this.sql.exec("UPDATE colony SET green_sha = ?", sha);
        this.colonyCache = null;
      },
      repairs: () =>
        this.sql
          .exec<{ id: string; status: string; created_at: number }>("SELECT id, status, created_at FROM intents WHERE source = 'certify' ORDER BY created_at DESC LIMIT 200")
          .toArray()
          .map((r) => ({ id: r.id, status: r.status as IntentStatus, createdAt: r.created_at })),
      declare: async (input) => (await this.addIntent({ ...input, colonyId: this.requireColony().id })).id,
      satisfy: async (id, reason) => {
        await this.withdrawIntent(id, { reason, by: "certify" });
      },
      specFor: (paths) => this.specContextFor(paths),
    };
  }

  /** The spec context carried by the intent that wrote one of `paths` (else the newest spec intent's), when the colony grew from a spec. */
  private specContextFor(paths: Path[]): { spec: string; label: string | null } | null {
    const want = new Set(paths);
    let fallback: { spec: string; label: string | null } | null = null;
    const rows = this.sql
      .exec<{ id: string; footprint: string; why: string }>("SELECT id, footprint, why FROM intents WHERE source != 'certify' AND instr(why, 'Spec context') > 0 ORDER BY created_at DESC LIMIT 500")
      .toArray();
    for (const r of rows) {
      const m = /\n\nSpec context(?: \(([^\n]*)\))?:\n/.exec(r.why);
      if (!m) continue;
      const found = { spec: r.why.slice(m.index + m[0].length).trim(), label: m[1] ?? null };
      if (this.footprintOf(r.id, r.footprint).some((p) => want.has(p))) return found;
      fallback ??= found;
    }
    return fallback;
  }

  // =========================================================================
  // Live hub
  // =========================================================================

  /**
   * Broadcast events to UI sockets (batched, at most every 100 ms). Returns the listener count and
   * `emitEveryMs`: how long regions should batch their field events before the next emit (longer
   * when many regions emit, so the colony gets about 60 emit calls a second whatever their number).
   */
  async emit(e: ColonyEvent | ColonyEvent[]): Promise<{ listeners: number; emitEveryMs: number }> {
    const list = Array.isArray(e) ? e : [e];
    let region: string | null = null;
    for (const ev of list) {
      if ((ev.t === "mark" || ev.t === "sigma") && typeof ev.region === "string") {
        region = ev.region;
        break;
      }
    }
    // The record always listens (it keeps sigma changes), so regions never go quiet while the colony works.
    return { listeners: Math.max(1, this.publish(list)), emitEveryMs: this.emitPace.pace(region, Date.now()) };
  }

  /**
   * Publish events: into the record (replays) and to the live sockets. Every event the colony shows
   * goes through here, so the record does not depend on who is watching or how delivery is batched.
   * Returns the number of live listeners.
   */
  private publish(events: ColonyEvent | ColonyEvent[]): number {
    this.recorder.add(events);
    return this.hub.push(events);
  }

  /** Write a batch of recorded events, and trim the record to RECORD_KEEP now and then. */
  private recordEvents(events: ColonyEvent[]): void {
    if (!this.loadColony()) return;
    this.sql.exec(
      "INSERT INTO events (at, t, data) SELECT CAST(json_extract(value, '$.at') AS INTEGER), json_extract(value, '$.t'), value FROM json_each(?)",
      JSON.stringify(events),
    );
    this.recordedSinceTrim += events.length;
    if (this.recordedSinceTrim >= 2_000) {
      this.recordedSinceTrim = 0;
      this.sql.exec("DELETE FROM events WHERE seq <= (SELECT MAX(seq) FROM events) - ?", RECORD_KEEP);
    }
  }

  /**
   * While events are being recorded, sample the live metrics into the record every RECORD_SAMPLE_MS
   * (only values that changed), plus one trailing sample after the last write, so a replay ends on the
   * colony's final counts.
   */
  private sampleMetrics(now: number): void {
    if (now - this.lastSampleAt < RECORD_SAMPLE_MS) {
      if (this.sampleTimer === null) {
        this.sampleTimer = setTimeout(() => {
          this.sampleTimer = null;
          this.sampleMetrics(Date.now());
        }, RECORD_SAMPLE_MS - (now - this.lastSampleAt) + 50);
      }
      return;
    }
    this.lastSampleAt = now;
    if (!this.loadColony()) return;
    let current: Record<string, number>;
    try {
      // Fresh counts (not the live tick's 10 s cache): the last sample is the state a replay ends on.
      current = this.currentMetrics(now, false);
    } catch (err) {
      console.warn(`metrics sample failed: ${errorText(err)}`);
      return;
    }
    const out: ColonyEvent[] = [];
    for (const name of SAMPLED_METRICS) {
      const value = current[name];
      if (typeof value !== "number" || !Number.isFinite(value) || this.sampledMetrics.get(name) === value) continue;
      this.sampledMetrics.set(name, value);
      out.push({ t: "metric", at: now, name, value });
    }
    if (out.length > 0) this.recorder.add(out);
  }

  /** Publish the funnel totals soon (a proposal just settled); several settling together send one update. */
  private scheduleFunnel(): void {
    if (this.funnelTimer !== null) return;
    this.funnelTimer = setTimeout(() => {
      this.funnelTimer = null;
      try {
        const now = Date.now();
        const f = this.funnelCounts();
        const out: ColonyEvent[] = [];
        for (const stage of FUNNEL_STAGES) {
          if (this.funnelSent.get(stage) === f[stage]) continue;
          this.funnelSent.set(stage, f[stage]);
          out.push({ t: "metric", at: now, name: `funnel.${stage}`, value: f[stage] });
        }
        if (out.length > 0) this.publish(out);
      } catch (err) {
        console.warn(`funnel update failed: ${errorText(err)}`);
      }
    }, FUNNEL_EMIT_MS);
  }

  /**
   * A page of the colony's event record (GET /api/colonies/:id/events): events after sequence number
   * `after`, oldest first. `source` "auto" serves the recorded events when there are any, else a replay
   * reconstructed from what the colony stores (colonies that ran before recording began).
   */
  async eventsPage(p: { after?: number; limit?: number; source?: "auto" | "recorded" | "reconstructed" } = {}): Promise<EventsPage> {
    const colony = this.requireColony();
    this.recorder.flush();
    const after = Math.max(0, Math.floor(Number(p.after) || 0));
    const limit = Math.max(1, Math.min(EVENTS_PAGE_MAX, Math.floor(Number(p.limit) || 1_000)));
    const stats = this.sql.exec<{ n: number; first: number | null; last: number | null }>("SELECT COUNT(*) AS n, MIN(at) AS first, MAX(at) AS last FROM events").one();
    // The record tells the whole story only when it reaches back to the colony's first rule or intent;
    // a colony that worked before recording began replays its reconstruction (which covers every run).
    const began = this.sql
      .exec<{ at: number | null }>("SELECT MIN(at) AS at FROM (SELECT MIN(created_at) AS at FROM intents WHERE created_by != 'vaccine' UNION ALL SELECT MIN(created_at) FROM rules)")
      .one().at;
    const covered = stats.n > 0 && (began === null || (stats.first ?? Number.POSITIVE_INFINITY) <= began + 1_000);
    const source = p.source === "recorded" || p.source === "reconstructed" ? p.source : covered ? "recorded" : "reconstructed";
    if (source === "recorded") {
      const rows = this.sql.exec<{ seq: number; data: string }>("SELECT seq, data FROM events WHERE seq > ? ORDER BY seq LIMIT ?", after, limit + 1).toArray();
      const more = rows.length > limit;
      const events: RecordedEvent[] = [];
      for (const r of rows.slice(0, limit)) {
        const e = parseJson<ColonyEvent | null>(r.data, null);
        if (e) events.push({ ...e, seq: r.seq });
      }
      const lastSeq = rows[Math.min(rows.length, limit) - 1]?.seq ?? null;
      return { colonyId: colony.id, source, events, next: more ? lastSeq : null, total: stats.n, first: stats.first, last: stats.last };
    }
    const all = this.reconstructed();
    const events: RecordedEvent[] = all.slice(after, after + limit).map((e, i) => ({ ...e, seq: after + i + 1 }));
    const end = after + events.length;
    return { colonyId: colony.id, source, events, next: end < all.length ? end : null, total: all.length, first: all[0]?.at ?? null, last: all[all.length - 1]?.at ?? null };
  }

  /** The reconstructed replay (cached while the colony's tables stay the same, up to RECON_TTL_MS). */
  private reconstructed(): ColonyEvent[] {
    const now = Date.now();
    const key = [
      this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM proposals").one().n,
      this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM intents").one().n,
      this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM agents").one().n,
      this.loadColony()?.lastLandingAt ?? 0,
    ].join("|");
    if (this.reconCache && this.reconCache.key === key && now - this.reconCache.at < RECON_TTL_MS) return this.reconCache.events;
    const events = reconstruct(this.reconInput());
    this.reconCache = { key, at: now, events };
    return events;
  }

  /** The rows a reconstruction reads (vaccines left out: they never touch the field or the funnel). */
  private reconInput(): ReconInput {
    this.decider(); // its tables (decide outcomes) exist from here on
    const list = <T>(sql: string, ...args: SqlStorageValue[]): T[] => this.sql.exec(sql, ...args).toArray() as unknown as T[];
    const strings = (json: string | null): string[] => parseJson<unknown[]>(json, []).filter((x): x is string => typeof x === "string");
    const vaccine = new Set(list<{ proposal_id: string }>("SELECT proposal_id FROM decide_outcomes WHERE vaccine = 1").map((r) => r.proposal_id));
    const rules = list<RuleRow>("SELECT * FROM rules ORDER BY created_at").map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      retractedAt: typeof r.retracted_at === "number" ? r.retracted_at : null,
      retractedBy: r.retracted_by ?? null,
      retractReason: r.retract_reason ?? null,
    }));
    const intents = list<IntentRow>("SELECT * FROM intents WHERE created_by != 'vaccine' ORDER BY created_at LIMIT ?", RECON_ROWS).map((r) => ({
      id: r.id,
      title: r.title,
      footprint: this.footprintOf(r.id, r.footprint),
      status: r.status as IntentStatus,
      ruleId: r.rule_id,
      violations: r.violations,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      withdrawnReason: r.withdrawn_reason ?? null,
    }));
    const agents = list<{ id: string; kind: string; state: string; created_at: number; last_seen: number; stopped_at: number | null }>(
      "SELECT a.id, a.kind, a.state, a.created_at, a.last_seen, s.at AS stopped_at FROM agents a LEFT JOIN agent_stops s ON s.agent_id = a.id WHERE a.model IS NOT 'vaccine' ORDER BY a.created_at LIMIT ?",
      RECON_ROWS,
    ).map((r) => ({ id: r.id, kind: r.kind as AgentKind, state: r.state, createdAt: r.created_at, lastSeen: r.last_seen, stoppedAt: r.stopped_at }));
    const proposals = list<{ id: string; intent_id: string; agent_id: string; status: string; created_at: number; updated_at: number; reason: string | null; landing_id: string | null; paths: string | null }>(
      `SELECT id, intent_id, agent_id, status, created_at, updated_at, json_extract(data, '$.reason') AS reason, json_extract(data, '$.landingId') AS landing_id,
         (SELECT json_group_array(json_extract(w.value, '$.path')) FROM json_each(json_extract(data, '$.writeSet')) w) AS paths
       FROM proposals ORDER BY created_at LIMIT ?`,
      RECON_ROWS,
    )
      .filter((r) => !vaccine.has(r.id))
      .map((r) => ({
        id: r.id,
        intentId: r.intent_id,
        agentId: r.agent_id,
        status: r.status as ProposalStatus,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        reason: r.reason,
        landingId: r.landing_id,
        paths: strings(r.paths),
      }));
    const decisions = list<{ id: string; kind: string; subject: string; layer: string; p: number; action: string; at: number }>(
      "SELECT id, kind, subject, layer, p, action, at FROM decisions ORDER BY at LIMIT ?",
      RECON_ROWS * 2,
    )
      .filter((r) => !vaccine.has(r.subject))
      .map((r) => ({ id: r.id, kind: r.kind as Decision["kind"], subject: r.subject, layer: r.layer as DecisionLayer, p: r.p, action: r.action, at: r.at }));
    const outcomes = list<{ proposal_id: string; layer: string; action: string; at: number; human: string | null; human_at: number | null }>(
      "SELECT proposal_id, layer, action, at, human, human_at FROM decide_outcomes WHERE vaccine = 0",
    ).map((r) => ({ proposalId: r.proposal_id, layer: r.layer, action: r.action, at: r.at, human: r.human, humanAt: r.human_at }));
    const landings = list<{ received_at: number; data: string }>("SELECT received_at, data FROM landings ORDER BY received_at").flatMap((r) => {
      const l = parseJson<Landing | null>(r.data, null);
      if (!l) return [];
      return [{ id: l.id, at: r.received_at, trunkSha: l.trunkSha ?? "", proposalIds: l.proposalIds ?? [], intentIds: l.intentIds ?? [], paths: l.paths ?? [] }];
    });
    const revisions = list<RevisionRow>("SELECT * FROM intent_revisions ORDER BY at").map((r) => {
      const v = toRevision(r);
      const title = typeof v.after.title === "string" ? v.after.title : null;
      return { intentId: v.intentId, revision: v.revision, at: v.at, by: v.by, reason: v.reason, changed: v.changed, title };
    });
    const directives = list<DirectiveRow>("SELECT * FROM directives WHERE kind = 'guidance' ORDER BY at LIMIT ?", RECON_ROWS).map((r) => ({
      id: r.id,
      agentId: r.agent_id,
      intentId: r.intent_id,
      message: r.message,
      by: r.by,
      at: r.at,
      via: r.via === "push" || r.via === "inbox" ? (r.via as "push" | "inbox") : null,
    }));
    const withdrawnBy: Record<Id, string> = {};
    for (const r of list<{ intent_id: string; by: string }>("SELECT intent_id, by FROM directives WHERE kind = 'withdrawal' AND intent_id IS NOT NULL")) withdrawnBy[r.intent_id] = r.by;
    return { rules, intents, agents, proposals, decisions, outcomes, landings, revisions, directives, withdrawnBy };
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
    funnel: Record<FunnelStage, number>;
    violations: { total: number; byRule: Record<Id, number> };
    series: ColonySeries;
    convergence: Convergence;
  }> {
    const colony = this.requireColony();
    const now = Date.now();
    this.maybeReap(now);
    const violations = this.violationTotals();
    return {
      colonyId: colony.id,
      at: now,
      metrics: this.currentMetrics(now),
      funnel: this.funnelCounts(),
      violations,
      series: this.seriesReport(now),
      convergence: this.convergence(violations.total),
    };
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
      this.waits.done(id);
      fx.events.push({ t: "agent", at: now, agentId: id, kind: agent.kind as AgentKind, state: "dead" });
    }
    await this.flushEffects(fx);
    // Every claim they still hold anywhere goes too (a proposal in flight stands, unprotected), so a
    // stopped run never keeps admission closed or inhibits work while its claims decay.
    await this.clearAgentClaims(out);
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
    // Buffered metrics belong to the colony being erased: drop them before the storage goes.
    this.pendingMetrics.clear();
    this.pendingSeries.clear();
    if (this.metricsFlush !== null) clearTimeout(this.metricsFlush);
    this.metricsFlush = null;
    // So do buffered record events, samples and funnel totals.
    this.recorder.clear();
    this.sampledMetrics.clear();
    this.funnelSent.clear();
    if (this.sampleTimer !== null) clearTimeout(this.sampleTimer);
    if (this.funnelTimer !== null) clearTimeout(this.funnelTimer);
    this.sampleTimer = this.funnelTimer = null;
    this.lastSampleAt = 0;
    this.recordedSinceTrim = 0;
    this.reconCache = null;
    // The decide engine's tables went with the storage; the next use creates them again.
    this.decideEngine = null;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.colonyCache = null;
    this.configured.clear();
    this.recentClaims.clear();
    this.readingCache.clear();
    this.pendingReadings.clear();
    this.waits.clear();
    this.emitPace.clear();
    this.candidateRows = null;
    this.countsCache = null;
    this.landingsSincePrune = 0;
    this.taking.clear();
    this.lastRefresh.clear();
    this.footprintCache.clear();
    this.sentMetrics.clear();
    this.lastReap = 0;
    this.registryReady = false;
    this.noteEmitted.clear();
    for (const stmt of SCHEMA) this.sql.exec(stmt);
    for (const stmt of OPS_SCHEMA) this.sql.exec(stmt);
    migrateDirection(this.sql);
    this.certifier.reset();
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
    const changed = changedMetrics(this.currentMetrics(now, true), this.sentMetrics, full);
    // Live only: the record samples these on its own (sampleMetrics), with or without a viewer.
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
  private currentMetrics(now: number, cachedCounts = false): Record<string, number> {
    const m = this.metricsRecord();
    // The metrics tick (every 3 s with a UI connected) reuses the intent and agent counts for a while: both are full scans.
    let counts = cachedCounts && this.countsCache && now - this.countsCache.at < COUNTS_TTL_MS ? this.countsCache.counts : null;
    if (!counts) {
      counts = { ...this.agentCounts() };
      for (const r of this.sql.exec<{ status: string; n: number }>("SELECT status, COUNT(*) AS n FROM intents GROUP BY status")) {
        counts[`intents${r.status.charAt(0).toUpperCase()}${r.status.slice(1)}`] = r.n;
      }
      this.countsCache = { at: now, counts };
    }
    Object.assign(m, counts);
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
    m["funnel.proof"] = funnel.proof;
    m["funnel.reflex"] = funnel.reflex;
    m["funnel.llm"] = funnel.llm;
    m["funnel.human"] = funnel.human;
    m["decisions"] = funnel.proof + funnel.reflex + funnel.llm + funnel.human;
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
    this.flushMetrics(now);
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
    // Buffered with the counters (flushMetrics); a gauge keeps its latest value for the minute.
    const minute = minuteOf(now);
    const key = `${name}|${minute}`;
    const r = this.pendingSeries.get(key);
    if (!r) this.pendingSeries.set(key, { name, minute, value, gauge });
    else r.value = gauge ? value : r.value + value;
    this.scheduleMetricsFlush();
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
    // Gone from the shared candidate list either way: claimed now, or by someone else before.
    if (this.candidateRows) this.candidateRows.rows = this.candidateRows.rows.filter((r) => r.id !== intentId);
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
    this.waits.done(agentId);
    this.publish([
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

  /**
   * The open intents self-assignment considers (highest priority, then oldest; CANDIDATE_CAP of
   * them). Under load (BUSY_TAKES takes in flight or more) concurrent takes share one list for
   * CANDIDATES_TTL_MS instead of each reading 200 rows; reserve() stays the atomic check, and drops
   * what it claims from the shared list.
   */
  private openCandidates(now: number): Array<{ id: string; footprint: string; priority: number; created_at: number }> {
    const busy = this.taking.size >= BUSY_TAKES;
    if (busy && this.candidateRows && now - this.candidateRows.at < CANDIDATES_TTL_MS) return this.candidateRows.rows;
    const rows = this.sql
      .exec<{ id: string; footprint: string; priority: number; created_at: number }>(
        "SELECT id, footprint, priority, created_at FROM intents WHERE status = 'open' ORDER BY priority DESC, created_at ASC LIMIT ?",
        CANDIDATE_CAP,
      )
      .toArray();
    this.candidateRows = { at: now, rows };
    return rows;
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
    const review = this.reviewAhead(intent);
    return { intent, lease, ...(rule ? { rule: this.toRule(rule, intent.colonyId) } : {}), ...(review ? { review } : {}) };
  }

  /**
   * What review will ask of a change to the intent's footprint (agents/preview.ts): the questions
   * of the antibodies people's rejections minted for those paths, and the colony's other rules
   * that cover them. Nothing when a person switched the colony's reflex arc off (then nothing
   * reviews the change). Best effort: a take never fails over it.
   */
  private reviewAhead(intent: Intent): ReviewPreview | undefined {
    try {
      const store = this.decider().store;
      if (!store.policy().enabled) return undefined;
      const rules = this.sql.exec<RuleRow>("SELECT * FROM rules WHERE retracted_at IS NULL ORDER BY created_at").toArray().map((r) => this.toRule(r, intent.colonyId));
      return reviewPreview(intent, store.antibodies(), rules);
    } catch (err) {
      console.warn(`review preview for intent ${intent.id} failed: ${errorText(err)}`);
      return undefined;
    }
  }

  /**
   * The claim field of each region the candidates touch. Concurrent takes share one reading per
   * region: the claim and danger marks of the whole region (a few dozen entries), so every take
   * can use it whatever paths it scores. Claims made after a reading started are overlaid from
   * recentClaims, so sharing never hides a newer claim. A reading younger than READING_TTL_MS is
   * used as is. Under load it is used for READING_BUSY_TTL_MS, then refreshed in the background
   * while takes keep using it up to READING_STALE_MS; otherwise the take waits for a new one.
   * A region that cannot be read is left out (fail open: it neither repels nor closes admission).
   */
  private async readRegions(wanted: Map<string, Set<Path>>): Promise<Map<string, ReadingEntry & { reading: FieldReading }>> {
    const now = Date.now();
    const busy = this.taking.size >= BUSY_TAKES;
    const out = new Map<string, ReadingEntry & { reading: FieldReading }>();
    const waits: Array<Promise<unknown>> = [];
    for (const region of wanted.keys()) {
      const cached = this.readingCache.get(region);
      const age = cached ? now - cached.fetchStart : Number.POSITIVE_INFINITY;
      if (cached && (age < READING_TTL_MS || (busy && age < READING_STALE_MS))) {
        if (age >= (busy ? READING_BUSY_TTL_MS : READING_TTL_MS)) this.startReading(region);
        if (cached.reading) out.set(region, cached as ReadingEntry & { reading: FieldReading });
        continue;
      }
      const next = this.startReading(region);
      waits.push(
        next.promise.then(() => {
          if (next.reading) out.set(region, next as ReadingEntry & { reading: FieldReading });
        }),
      );
    }
    if (waits.length > 0) await Promise.all(waits);
    return out;
  }

  /** Start a claim reading of one region (or join the one in flight); it replaces the cached one when it arrives. */
  private startReading(region: string): ReadingEntry {
    const flying = this.pendingReadings.get(region);
    if (flying) return flying;
    const created: ReadingEntry = { fetchStart: Date.now(), promise: Promise.resolve(null) };
    created.promise = this.region(region)
      .then((stub) => stub.reading({ kinds: ["claim", "danger"], agents: false }) as Promise<FieldReading>)
      .then((reading) => {
        created.reading = reading;
        this.readingCache.set(region, created);
        return reading;
      })
      .catch((err: unknown) => {
        console.error(`field reading failed for region ${region}: ${errorText(err)}`);
        created.reading = null;
        return null;
      })
      .finally(() => {
        if (this.pendingReadings.get(region) === created) this.pendingReadings.delete(region);
      });
    this.pendingReadings.set(region, created);
    return created;
  }

  /**
   * What self-assignment needs from each region's reading, from one agent's
   * point of view: claim/danger values with the agent's own claims removed,
   * claims the reading may predate, and admission counting those claims.
   * Agents with no claims of their own in a region share the reading's index.
   */
  private fieldViews(agentId: Id, readings: Map<string, ReadingEntry & { reading: FieldReading }>, depth: number): Map<string, FieldView> {
    const own = this.ownClaims(agentId, depth);
    const unseenAll = unseenByRegion(this.recentClaims, agentId, (region) => readings.get(region)?.fetchStart, Date.now() - RECENT_CLAIM_MS);
    const views = new Map<string, FieldView>();
    for (const [region, entry] of readings) {
      const reading = entry.reading;
      const mine = own.get(region);
      // An agent already working in the region adds no forager there, so admission does not apply to it.
      const inside = !!mine && mine.size > 0;
      const index = inside ? fieldIndex(reading.byPath, mine) : (entry.index ??= fieldIndex(reading.byPath));
      const unseen = unseenAll.get(region) ?? [];
      const active = Math.max(0, reading.admission.activeAgents - (inside ? 1 : 0)) + unseen.length;
      views.set(region, { byPath: index.byPath, repulsive: index.repulsive, index, unseen, open: inside || admissionOpen(active, reading.admission.landingsPerMin) });
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
      this.waits.done(a.id);
      fx.events.push({ t: "agent", at: now, agentId: a.id, kind: a.kind as AgentKind, state: "dead" });
      fx.release.add(a.id);
    }
    // ...and every claim they still hold in any region is removed, not left to decay.
    this.ctx.waitUntil(this.flushEffects(fx).then(() => this.clearAgentClaims(stale.map((a) => a.id))));
  }

  /**
   * Remove every claim these agents hold, in every region of the colony: one RegionDO.clearClaims
   * call per region however many agents. Used when agents are stopped, retired or reaped, so their
   * claims never keep a region's admission closed. Failures are logged (the claims still decay).
   */
  private async clearAgentClaims(agentIds: Id[]): Promise<void> {
    const ids = [...new Set(agentIds)];
    if (ids.length === 0) return;
    const regions = this.sql.exec<{ name: string }>("SELECT name FROM regions").toArray().map((r) => r.name);
    await Promise.all(
      regions.map(async (region) => {
        try {
          await (await this.region(region)).clearClaims(ids);
        } catch (err) {
          console.error(`claim clear failed in region ${region}: ${errorText(err)}`);
        }
      }),
    );
  }

  /** Push this proposal's outcome to its agent (AgentDO.outcome) when the agent asked for it at propose time. */
  private watchOutcome(proposalId: Id, agentId: Id): void {
    this.sql.exec("INSERT OR REPLACE INTO outcome_watch (proposal_id, agent_id, at) VALUES (?, ?, ?)", proposalId, agentId, Date.now());
  }

  /**
   * Deliver outcomes to the agents watching them: one AgentDO.outcome call per proposal. A final
   * outcome ends the watch; an escalation is delivered and the watch stays. Best effort: an agent
   * that misses a push finds the outcome on its next (slow) poll.
   */
  private async deliverOutcomes(list: Proposal[]): Promise<void> {
    const ns = (this.env as unknown as { AGENT?: DurableObjectNamespace }).AGENT;
    const byId = new Map(list.map((p) => [p.id, p]));
    const watched = this.sql
      .exec<{ proposal_id: string; agent_id: string }>("SELECT proposal_id, agent_id FROM outcome_watch WHERE proposal_id IN (SELECT value FROM json_each(?))", JSON.stringify([...byId.keys()]))
      .toArray();
    if (watched.length === 0) return;
    const final = watched.filter((w) => byId.get(w.proposal_id)?.status !== "escalated").map((w) => w.proposal_id);
    if (final.length > 0) this.sql.exec("DELETE FROM outcome_watch WHERE proposal_id IN (SELECT value FROM json_each(?))", JSON.stringify(final));
    if (!ns) return;
    await Promise.all(
      watched.map(async (w) => {
        const p = byId.get(w.proposal_id);
        if (!p) return;
        try {
          const stub = ns.get(ns.idFromName(w.agent_id)) as unknown as { outcome(o: { proposalId: Id; status: ProposalStatus; reason?: string; landingId?: Id }): Promise<unknown> };
          await stub.outcome({ proposalId: p.id, status: p.status, ...(p.reason ? { reason: p.reason } : {}), ...(p.landingId ? { landingId: p.landingId } : {}) });
        } catch (err) {
          console.warn(`outcome push to ${w.agent_id} failed for ${p.id}: ${errorText(err)}`);
        }
      }),
    );
  }

  // =========================================================================
  // Internals: proposal state machine
  // =========================================================================

  private effects(depth: number): Effects {
    return { batch: new FieldBatch(depth), events: [], enqueue: [], dequeue: new Map(), release: new Set(), outcomes: [] };
  }

  /** Apply the side effects of a proposal moving from `prev` to `p.status` (no-op if unchanged). */
  private transition(p: Proposal, prev: ProposalStatus, now: number, fx: Effects): void {
    if (p.status === prev) return;
    if (PUSHED_STATES.has(p.status)) (fx.outcomes ??= []).push(p);
    // The decide arc settled it (or a person will): the funnel moves.
    if (prev === "checking" || p.status === "escalated") this.scheduleFunnel();
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
        if (p.status === "returned" && isRedirect(p.reason)) {
          this.settleRedirect(p, intent, agent, now, fx);
          break;
        }
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
    if (fx.events.length > 0) this.publish(fx.events);
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
    if (fx.outcomes && fx.outcomes.length > 0) {
      const outcomes = fx.outcomes;
      this.ctx.waitUntil(this.deliverOutcomes(outcomes).catch((err) => console.error(`outcome delivery failed: ${errorText(err)}`)));
    }
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
    // Only release agents that have not leased again in the meantime.
    const ids = agentIds.filter((id) => this.agentRow(id)?.state !== "working");
    if (ids.length === 0) return;
    // One call for a whole landing's agents; a pool still on the previous version releases one by one.
    try {
      await pool.releaseMany(ids);
      return;
    } catch (err) {
      if (!/does not implement/i.test(errorText(err))) {
        console.warn(`PoolDO.releaseMany failed for ${ids.length} agent(s): ${errorText(err)}`);
        return;
      }
    }
    await Promise.all(
      ids.map(async (id) => {
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
      const source: IntentSource = d.source === "rule" || d.source === "agent" || d.source === "certify" ? d.source : "human";
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
      this.publish(events);
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
    if (row.status === "withdrawn") throw ftError(409, withdrawnError(row.id, row.withdrawn_reason ?? null));
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
    // Revision 1 is implied (absent) so a never-amended intent keeps its original shape.
    if (typeof r.revision === "number" && r.revision > 1) intent.revision = r.revision;
    if (r.withdrawn_reason) intent.withdrawnReason = r.withdrawn_reason;
    return intent;
  }

  private toRule(r: RuleRow, colonyId: Id): Rule {
    const rule: Rule = {
      id: r.id,
      colonyId,
      kind: r.kind as Rule["kind"],
      spec: parseJson<Record<string, unknown>>(r.spec, {}),
      description: r.description,
      approvedBy: r.approved_by,
      createdAt: r.created_at,
    };
    if (typeof r.retracted_at === "number") {
      rule.retractedAt = r.retracted_at;
      if (r.retracted_by) rule.retractedBy = r.retracted_by;
      if (r.retract_reason) rule.retractReason = r.retract_reason;
    }
    return rule;
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
    if (r.note) {
      info.note = r.note;
      if (typeof r.note_at === "number") info.noteAt = r.note_at;
    }
    return info;
  }

  private setAgentState(agentId: Id, state: AgentState, now: number): void {
    const row = this.sql.exec<{ kind: string; state: string }>("UPDATE agents SET state = ? WHERE id = ? AND state != ? RETURNING kind, state", state, agentId, state).toArray()[0];
    if (row) this.publish({ t: "agent", at: now, agentId, kind: row.kind as AgentKind, state });
  }

  private countIntents(status: IntentStatus): number {
    return this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM intents WHERE status = ?", status).one().n;
  }

  private landingsPerMin(now: number): number {
    return this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM landings WHERE received_at > ?", now - RATE_WINDOW_MS).one().n;
  }

  /** Keep the last LANDINGS_KEEP landings, trimming every 64 landings (each trim reads the whole log index). */
  private pruneLandings(): void {
    if (++this.landingsSincePrune < 64) return;
    this.landingsSincePrune = 0;
    this.sql.exec("DELETE FROM landings WHERE id IN (SELECT id FROM landings ORDER BY received_at DESC LIMIT -1 OFFSET ?)", LANDINGS_KEEP);
  }
  private landingsSincePrune = 0;

  /**
   * Add to a counter. Counter and gauge writes are buffered and written together at most every
   * METRIC_FLUSH_MS (flushMetrics): every take, proposal and landing bumped counters, and those tiny
   * tables were rewritten in each of hundreds of storage transactions a second. Reads see the
   * buffered values. Returns the delta.
   */
  private bump(name: string, delta: number, now: number): number {
    const p = this.pendingMetrics.get(name);
    if (!p) this.pendingMetrics.set(name, { add: delta, set: null, at: now });
    else {
      if (p.set !== null) p.set += delta;
      else p.add += delta;
      p.at = now;
    }
    if (COUNTER_SERIES.has(name)) this.recordSeries(name, delta, now, false);
    this.scheduleMetricsFlush();
    return delta;
  }

  /** Write the buffered metric and series changes in one go, and prune old series minutes now and then. */
  private flushMetrics(now = Date.now()): void {
    if (this.metricsFlush !== null) {
      clearTimeout(this.metricsFlush);
      this.metricsFlush = null;
    }
    for (const [name, p] of this.pendingMetrics) {
      if (p.set !== null) {
        this.sql.exec("INSERT INTO metrics (name, value, at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, at = excluded.at", name, p.set, p.at);
      } else {
        this.sql.exec("INSERT INTO metrics (name, value, at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = value + excluded.value, at = excluded.at", name, p.add, p.at);
      }
    }
    this.pendingMetrics.clear();
    for (const r of this.pendingSeries.values()) {
      const upsert = r.gauge
        ? "INSERT INTO series (name, minute, value) VALUES (?, ?, ?) ON CONFLICT(name, minute) DO UPDATE SET value = excluded.value"
        : "INSERT INTO series (name, minute, value) VALUES (?, ?, ?) ON CONFLICT(name, minute) DO UPDATE SET value = value + excluded.value";
      this.sql.exec(upsert, r.name, r.minute, r.value);
    }
    this.pendingSeries.clear();
    if (now - this.lastSeriesPrune < SERIES_PRUNE_EVERY_MS) return;
    this.lastSeriesPrune = now;
    const cutoff = minuteOf(now) - SERIES_KEEP_MINUTES;
    // Carry each gauge's last value to the cutoff so the line stays continuous after pruning.
    for (const g of GAUGE_SERIES) {
      this.sql.exec("INSERT OR IGNORE INTO series (name, minute, value) SELECT name, ?, value FROM series WHERE name = ? AND minute < ? ORDER BY minute DESC LIMIT 1", cutoff, g, cutoff);
    }
    this.sql.exec("DELETE FROM series WHERE minute < ?", cutoff);
  }

  private scheduleMetricsFlush(): void {
    if (this.metricsFlush !== null) return;
    this.metricsFlush = setTimeout(() => {
      this.metricsFlush = null;
      try {
        this.flushMetrics(Date.now());
      } catch (err) {
        console.error(`metrics flush failed: ${errorText(err)}`);
      }
    }, METRIC_FLUSH_MS);
  }

  private setMetric(name: string, value: number, now: number): void {
    this.pendingMetrics.set(name, { add: 0, set: value, at: now });
    this.scheduleMetricsFlush();
  }

  private metric(name: string): number {
    const stored = this.sql.exec<{ value: number }>("SELECT value FROM metrics WHERE name = ?", name).toArray()[0]?.value ?? 0;
    const p = this.pendingMetrics.get(name);
    return p ? (p.set !== null ? p.set : stored + p.add) : stored;
  }

  private metricsRecord(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.sql.exec<{ name: string; value: number }>("SELECT name, value FROM metrics")) out[r.name] = r.value;
    for (const [name, p] of this.pendingMetrics) out[name] = p.set !== null ? p.set : (out[name] ?? 0) + p.add;
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

  /**
   * The funnel: proposals settled per stage, each counted once at the stage that settled it. A
   * deterministic proof that decided alone counts as `proof`; anything escalated counts at `human`
   * (only a person settles it); vaccines are left out (the vaccination meter reports them).
   */
  private funnelCounts(): Record<FunnelStage, number> {
    const out: Record<FunnelStage, number> = { proof: 0, reflex: 0, llm: 0, human: 0 };
    this.decider(); // creates the decide tables on first use
    for (const r of this.sql.exec<{ stage: string; n: number }>(
      `SELECT CASE WHEN human IS NOT NULL OR action = 'escalate' OR layer = 'human' THEN 'human'
                   WHEN layer = 'deterministic' THEN 'proof' ELSE layer END AS stage, COUNT(*) AS n
         FROM decide_outcomes WHERE vaccine = 0 GROUP BY stage`,
    )) {
      if (r.stage === "proof" || r.stage === "reflex" || r.stage === "llm" || r.stage === "human") out[r.stage] += r.n;
    }
    return out;
  }

  /**
   * Violations since the latest rule change (a rule added or retracted): open right after it, fixed
   * since (landed fixes of rules still in force), and when the count reached zero.
   */
  private convergence(total: number): Convergence {
    const change = this.sql.exec<{ at: number | null }>("SELECT MAX(MAX(created_at, COALESCE(retracted_at, 0))) AS at FROM rules").one().at;
    if (change === null || !Number.isFinite(change)) return { since: null, initial: total, fixed: 0, convergedAt: null };
    const row = this.sql
      .exec<{ fixed: number; last: number | null }>(
        `SELECT COALESCE(SUM(i.violations), 0) AS fixed, MAX(i.updated_at) AS last FROM intents i JOIN rules r ON r.id = i.rule_id
          WHERE i.status = 'landed' AND i.violations > 0 AND i.updated_at >= ? AND r.retracted_at IS NULL AND i.created_by != 'vaccine'`,
        change,
      )
      .one();
    const fixed = Math.max(0, row.fixed);
    return { since: change, initial: total + fixed, fixed, convergedAt: total === 0 && fixed > 0 ? row.last : null };
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
    // Decisions per layer (a proposal can take several); the funnel counts proposals settled (funnelCounts).
    this.sql.exec("INSERT INTO funnel (layer, n) VALUES (?, 1) ON CONFLICT(layer) DO UPDATE SET n = n + 1", d.layer);
    this.publish({ t: "decision", at: now, decisionId: d.id, kind: d.kind, layer: d.layer, p: d.p, action: d.action, subject: d.subject });
  }

  private trunkStub() {
    return this.env.TRUNK.get(this.env.TRUNK.idFromName(this.requireColony().id));
  }

  private poolStub() {
    return this.env.POOL.get(this.env.POOL.idFromName(this.requireColony().id));
  }
}
