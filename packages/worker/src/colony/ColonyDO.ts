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
  TrunkPublish,
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
import type { Antibody } from "@fire_trident/core";
import type { DetectorState } from "../decide/policy.ts";
import type { DecideStore, StoredAntibody } from "../decide/store.ts";
import { ANTIBODY_DIR, antibodyAllows, parseAntibodyFile, type AllowingAntibody } from "../decide/antibodies.ts";
import { keepSource } from "../decide/quotes.ts";
import { DEFAULT_NOT_VERIFIED, FieldBatch, groupByRegion, jitter, normalizePath, normalizePaths, overlapCount, primaryRegion, violationIntents } from "./logic.ts";
import { EmitPacer, Gate, WaitPacer, fastRepulsion, fieldIndex, unseenByRegion, type FieldIndex, type RecentClaim } from "./views.ts";
import { LagProbe } from "./lag.ts";
import { SWEEP_MS as STUCK_SWEEP_MS, StuckDetector } from "./stuck.ts";
import type { StuckReport } from "@fire_trident/core";
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
import { landedStaleText, missedRevisions, type MissedRevision } from "./direction.ts";
import { landedAnywayText, redirectOutcome } from "./direction.ts";
import type { LandedChange, RedirectOutcome } from "@fire_trident/core";
import { FENCE_ANSWER_MS, type FenceAnswer } from "../trunk/direction.ts";
import {
  ESCALATION_KINDS,
  MAX_ANSWER_CHARS,
  NOTICE_PATHS,
  NOTICE_WHY_CHARS,
  escalationDecision,
  escalationKind,
  landingMessage,
  parseEscalation,
  reportText,
  type EscalationDecision,
} from "./direction.ts";
import type { Direction, Directive, DirectiveKind, InboxDirective, IntentField, IntentRevision, NoteDecision } from "@fire_trident/core";
import type { EscalationKind, IntentEscalation, LandingNotice } from "@fire_trident/core";
import { WHY_FOOTPRINT, WHY_LANDINGS, WHY_PER_PATH, WHY_RANGE_ROWS, coveringFootprints, footprintIndex, indexRange, pickLanded, shortTitle, shortWhy } from "../agents/landed.ts";
import type { FootprintIndex, LandedRow, LandedWhy } from "../agents/landed.ts";
import { DerivedSet, recordedLanding, type LandingLog } from "../trunk/derived.ts";
import { NeighborCache, claimLookup, type Neighbor } from "../trunk/cochange.ts";
import { importNeighbors, type ImportLinks } from "../trunk/imports.ts";
import type { RevertResult } from "../trunk/revert.ts";
import { asyncPublishEnabled } from "../trunk/publish.ts";
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
import { culpritsEnabled, type LandedOn, type SinceGreen } from "../certify/culprit.ts";
import { landedSince } from "../certify/since.ts";
import { bisectEnabled } from "../certify/bisect.ts";
import { prelandEnabled, prelandReader } from "../certify/preland.ts";
import type { CertifyPolicy } from "../certify/repair.ts";
import { reviewPreview, type ReviewPreview } from "../agents/preview.ts";
import { RETURN_PATHS, extractUsage, returnReason, type LastReturn } from "../agents/prompt.ts";
import { MAX_RESUME_KEY, MIN_RESUME_KEY, resumeDigest, resumeKeyMatches } from "../mcp/resume.ts";
import { CONTEST_LOOK_MS, CONTEST_MIN, CONTEST_RETRY_MS, CONTEST_WAIT_MS, cleanAlternatives, contestEvidence, contestSeats, judgeModels, loadDiffs, migrateContest, pairJudge, selectWinner, supersededReason } from "../decide/contest.ts";
import type { ContestAlternative, ContestCandidate, ContestOutcome, ContestRound, JudgeIntent, PairJudge, PairVerdict } from "../decide/contest.ts";
import { juryEnabled, juryMembers, pairJury, type JuryMember } from "../decide/jury.ts";
import { whyAuthor } from "../decide/danger.ts";
import { protectedHits } from "../decide/signals.ts";
import type { FileDiff } from "../decide/diff.ts";
import { CallLimiter } from "../decide/limiter.ts";
import type { AiRunner } from "../decide/reflex.ts";
import type { CheckResult } from "@fire_trident/core";
import { INLINE_FETCH_BYTES, InlineContents, inlineRefusal, isInlineChange, migrateContents } from "./inline.ts";
import { FieldGuide, guideEnabled, type GuideView } from "./guide.ts";
import type { GuideLesson, GuideTake, LessonReceipt } from "@fire_trident/core";
import { MegafileAlarm, megafileEnabled, type MegafileHost } from "./megafile.ts";
import { A2A_ACTOR, ColonyPause, DEPLOYMENT_PAUSE_KEY, type PauseAnswer, type PauseView, type ResumeAnswer, type WriterPause } from "./pause.ts";
import type { MegafileHold, MegafileReport } from "@fire_trident/core";
import { grantPriority, migratePriority, notePriority, priorityCapOf, requestedPriorityOf } from "./priority.ts";
import { RESOLVER_AGENT, Resolver, migrateResolver, type ResolverTrunk } from "./resolver.ts";
import type { NoteResolves } from "@fire_trident/core";
import { impactReport } from "./impact.ts";
import type { ImporterWalk } from "../trunk/impact.ts";
import type { ImpactReport } from "@fire_trident/core";
import { modelHintFor, stepupEnabled, type ModelHint } from "./stepup.ts";
import { findTwin, twinChecked, twinsEnabled, type DeclareAnswer, type TwinAnswer } from "./twins.ts";
import { chainGateEnabled, chainHold, declaredBy, type DeclaredBy } from "./chain.ts";
import { a2aTasks, type A2APage, type A2AQuery } from "./a2a.ts";
import { REVIEW_MOVED, cleanMovedBy, movedCollision, movedReturn, type StalePath } from "./movedby.ts";
import { PROTECT_META, isProtectStop, parseProtectRecord, protectChanged, protectLandedText, type ProtectHost, type ProtectOutcome, type ProtectRecord } from "./protect.ts";
import { SpendBook, modelOfClass, resolverClient, spendCounters } from "./spend.ts";
import { hedgeFor } from "./hedge.ts";
import type { ColonySpend, IntentSpendBrief, SpendCap } from "@fire_trident/core";
import { IntentSpendBook, intentSpendEnabled, type IntentSpendAnswer } from "./intentspend.ts";
import { SPEND_CAP_ACTOR, SpendCapBook, agentReserve, agentSettle, bookUsd, cappedAi, cappedClient, localGate, type AgentCapAsk, type CapSettle, type CapUse, type SpendCapAnswer } from "./spendcap.ts";

/**
 * Result of ColonyDO.take: an assignment, or advice to wait and retry. `review`: what review will
 * ask of the change (agents/preview.ts), shown to the agent before it writes; `context`: the latest
 * landings that changed the intent's files, with their intents' whys (agents/landed.ts);
 * `lastReturn`: why the intent's latest change came back, for the agent to address first
 * (agents/prompt.ts); `guide`: where FT_FIELD_GUIDE covers the colony, the newest lessons agents
 * recorded, each with its provenance (colony/guide.ts); `model`: where FT_MODEL_STEPUP covers the
 * colony and the intent's changes came back twice since it last changed course, the stronger model
 * class for this attempt and why (colony/stepup.ts). Each is absent when there is nothing to say.
 */
export type TakeResult = { intent: Intent; lease: WorkspaceLease; rule?: Rule; review?: ReviewPreview; context?: LandedWhy[]; lastReturn?: LastReturn; guide?: GuideTake; model?: ModelHint } | { wait: true; retryInMs: number; reason: string };

/** Review views built per review-queue read for proposals escalated before views were kept. */
const REVIEW_BACKFILLS = 3;

/** Input of ColonyDO.addIntent. */
export type IntentInput = Omit<Intent, "id" | "status" | "createdAt">;

/**
 * Input of ColonyDO.propose. `notify`: push the outcome to the agent's AgentDO (AgentDO.outcome)
 * when it lands, comes back or is escalated, so an in-platform agent need not poll for it.
 * `lesson`: one surprising fact the agent learned, kept as a field guide candidate (FT_FIELD_GUIDE).
 */
export type ProposalInput = Omit<Proposal, "id" | "status" | "createdAt" | "evidence"> & { evidence?: Partial<Evidence>; notify?: boolean; lesson?: string };

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
/** Asynchronous publishing: how long the trunk writer's published head is reused as the base of leases before it is asked again. */
const LEASE_BASE_TTL_MS = 1_000;
/**
 * With asynchronous publishing, how many of the colony's latest landings a walk from its trunk head back to the published
 * head may cross (past it the take leases as before), and how soon a take that waited for publishing tries again.
 */
const UNPUBLISHED_WALK = 500;
const PUBLISH_WAIT_RETRY_MS = 500;
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
/**
 * Import repulsion (FT_IMPORT_WEIGHT; off when absent or 0): a claim on a file that a candidate's
 * files import, or on a file that imports them, repels the candidate, each such file at weight 1
 * times FT_IMPORT_WEIGHT. In the simulator's history workload at 1,000 agents with group commit,
 * weight 1 cut rework from 31% to 16% for about 10% fewer landings, and weight 2 to 2% for about
 * 13% fewer (packages/bench/results/2026-10-13-papers, Q4). How long a take waits for links it has
 * not cached.
 */
const IMPORT_WAIT_MS = 150;

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
  // External agents' resume keys (MCP join): only each key's SHA-256 digest, which no route returns.
  "CREATE TABLE IF NOT EXISTS agent_keys (agent_id TEXT PRIMARY KEY, digest TEXT NOT NULL, created_at INTEGER NOT NULL)",
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
  "CREATE INDEX IF NOT EXISTS landings_by_trunk ON landings(trunk_sha)",
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

/**
 * Paths of one landing indexed for why-context at most, and landings one take applies at most while the index catches up
 * (enough to rebuild it from the whole landing log the colony keeps, LANDINGS_KEEP trimmed every 64 landings, in one take).
 */
const LANDED_INDEX_PATHS = 1_000;
const LANDED_BACKFILL = LANDINGS_KEEP + 64;
/** The landing path index's name among the colony's derived indexes (trunk/derived.ts). */
const LANDED_INDEX = "landing-paths";
/** An intent's latest proposals a take looks through for the last one that came back (lastReturn). */
const RETURN_LOOKBACK = 10;
/** Agents told about one landing at most; landing notices are kept this long, pruned every so many notices. */
const MAX_LANDING_NOTICES = 100;
const NOTICE_KEEP_MS = 6 * 60 * 60_000;
const NOTICE_PRUNE_EVERY = 256;
/** The held intents' footprint index (landing notices) is rebuilt at most this often. */
const HELD_INDEX_MS = 1_000;

/** A directive for one agent to deliver, with the agent's kind (in-platform agents get it pushed). */
type Notice = { directive: Directive; kind: string; intent?: Intent };
/** One row of the landing path index (why-context). */
type LandedIndexRow = { path: string; at: number; landing_id: string; intent_id: string | null };
/** One landing of the colony's log for the landing path index: when it landed, and its index rows when the landing hook has them. */
type ColonyLanding = { landing: Landing; at: number; rows?: LandedRow[] };
/** An agent a landing concerns: the intent its notice is about, and the landed paths that intent covers. */
type NoticeRecipient = { agentId: Id; kind: string; intentId: Id; paths: Path[] };
/** An intent an agent holds, as the landing notices' footprint index keeps it (`current`: the agent's current intent). */
type HeldRef = { intentId: Id; agentId: Id; kind: string; current: boolean };
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
  /** An agent's report and the person's answer (IntentEscalation JSON), and 1 while it waits: take skips the intent. */
  escalation?: string | null;
  escalation_open?: number | null;
  /** Contest mode: seats (decide/contest.ts migrates older tables). */
  contest?: number | null;
  /** What an agent asked for when the cap lowered its priority, and which cap (priority.ts migrates older tables). */
  requested_priority?: number | null;
  priority_cap?: string | null;
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

/** An antibody as the colony stores it: a retired one remembers the state it had and why it was retired. */
type AntibodyRecord = AllowingAntibody & { retired?: { state: DetectorState; landingId: Id; at: number; reason: string } };

/** Whether a footprint entry covers any of the paths: the same path, a directory (trailing slash), or a glob's literal prefix. */
function footprintTouches(entry: string, paths: ReadonlySet<Path>): boolean {
  if (paths.has(entry)) return true;
  const star = entry.indexOf("*");
  const prefix = star >= 0 ? entry.slice(0, star) : entry.endsWith("/") ? entry : null;
  if (prefix === null) return false;
  for (const p of paths) if (p.startsWith(prefix)) return true;
  return false;
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
  /** Direct imports and importers of footprint files as weight-1 neighbors, cached from TrunkDO.importLinks (fails open; read only when FT_IMPORT_WEIGHT is on). */
  private readonly imports = new NeighborCache((paths) =>
    (this.trunkStub().importLinks(paths) as unknown as Promise<Record<Path, ImportLinks>>).then(importNeighbors, (err: unknown) => {
      throw new Error(`TrunkDO.importLinks failed: ${errorText(err)}`);
    }),
  );
  /** Asynchronous publishing (FT_ASYNC_PUBLISH): the trunk writer's published head as leases last saw it, and the read in flight (leaseBase). */
  private publishedBase: { sha: Sha; at: number } | null = null;
  private publishedRead: Promise<void> | null = null;
  /** The last answer of unpublishedPaths, reused while neither head moves (under load, takes ask many times a second). */
  private unpublishedMemo: { trunk: Sha; published: Sha; paths: Set<Path> | null } | null = null;
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
  /** The field guide (colony/guide.ts), made on first use where FT_FIELD_GUIDE covers the colony. */
  private guideStore: FieldGuide | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    for (const stmt of SCHEMA) this.sql.exec(stmt);
    for (const stmt of OPS_SCHEMA) this.sql.exec(stmt);
    migrateDirection(this.sql);
    migrateContest(this.sql);
    migrateContents(this.sql);
    migrateResolver(this.sql);
    migratePriority(this.sql);
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
      try {
        // A conflict resolution cut off by an eviction: its return stands and its intent reopens (colony/resolver.ts).
        if (this.loadColony()) this.resolver().resume();
      } catch (err) {
        console.warn(`conflict resolutions not resumed: ${errorText(err)}`);
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
    // Asynchronous publishing (FT_ASYNC_PUBLISH): the published head and the publish queue are part of the colony's status.
    const publishing = asyncPublishEnabled(this.env.FT_ASYNC_PUBLISH, colony.id);
    const [filesRes, landingsRes, publishRes] = await Promise.allSettled([
      trunk.files(),
      trunk.landings(20),
      publishing ? (trunk.publishState() as Promise<TrunkPublish>) : Promise.resolve(null),
    ]);
    const publish = publishRes.status === "fulfilled" && publishRes.value ? publishRes.value : null;
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
    const stuck = this.stuckReport(now);
    // Megafile alarm (colony/megafile.ts): the files held for their split, while FT_MEGAFILE covers the colony.
    const megafiles = this.megafileReportSafe();
    // Spend per intent (colony/intentspend.ts), for the Intents tab's rows; absent when nothing was counted per intent.
    const intentSpend = this.intentSpendMap();
    // Pause (colony/pause.ts): the pauses in force, for the colony page's banner and ft status; absent while agents may work.
    const pauses = await this.pauses().current();
    return {
      colony: certification || publish ? { ...colony, ...(certification ? { certification } : {}), ...(publish ? { publish } : {}) } : colony,
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
      ...(stuck ? { stuck } : {}),
      ...(megafiles ? { megafiles } : {}),
      ...(intentSpend ? { intentSpend } : {}),
      ...(pauses.length > 0 ? { pauses } : {}),
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

  /**
   * Declare an intent through a door a person or an agent uses (POST /intents, MCP declare). Where FT_TWINS covers the
   * colony, an intent whose title and footprint match one the colony has open, claimed, proposed or landed in the last
   * 30 minutes is not created: the answer is that intent with `duplicateOf`, `similar` and `note` (colony/twins.ts),
   * unless `force`. Otherwise, and for rule, certification and the colony's own intents, it is addIntent.
   */
  async declareIntent(i: IntentInput, opts: { force?: boolean } = {}): Promise<DeclareAnswer> {
    // Pause (colony/pause.ts): an agent's declaration (MCP declare, Agent2Agent SendMessage) waits for a person to resume.
    if (i?.source === "agent") await this.pauses().refuse();
    const twin = opts?.force === true ? null : this.twinOf(i);
    return twin ?? { intent: await this.addIntent(i) };
  }

  /** The intent a declaration would duplicate, where FT_TWINS covers the colony (colony/twins.ts); else null. Fails open. */
  private twinOf(i: IntentInput): TwinAnswer | null {
    const colony = this.requireColony();
    if (!twinsEnabled(this.env.FT_TWINS, colony.id) || !twinChecked(i)) return null;
    try {
      return findTwin(this.sql, i, Date.now(), (id) => {
        const row = this.intentRow(id);
        return row ? this.toIntent(row, colony.id) : null;
      });
    } catch (err) {
      console.warn(`twin check in ${colony.id} failed: ${errorText(err)}`);
      return null;
    }
  }

  /**
   * The hold for an intent being declared (colony/chain.ts) where FT_INTENT_CHAIN_GATE covers the colony, at the decide
   * policy's intentChainDepth and intentFanout; null elsewhere. Fails open: its own failure declares the intent as before.
   */
  private chainHold(intent: Intent, now: number): IntentEscalation | null {
    if (!chainGateEnabled(this.env.FT_INTENT_CHAIN_GATE, intent.colonyId)) return null;
    try {
      const policy = this.decider().store.policy();
      return chainHold(this.sql, intent, { depth: policy.intentChainDepth, fanout: policy.intentFanout }, now);
    } catch (err) {
      console.warn(`chain gate for intent ${intent.id} failed: ${errorText(err)}`);
      return null;
    }
  }

  /** Who declared an intent, for its take (colony/chain.ts): its source, the declarer and its model, the chain depth. Best effort: a take never fails over it. */
  private declaredBy(intent: Intent): DeclaredBy | undefined {
    try {
      return declaredBy(this.sql, intent);
    } catch (err) {
      console.warn(`declarer of intent ${intent.id} failed: ${errorText(err)}`);
      return undefined;
    }
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
   * new revision (pushed to an in-platform agent, in an external agent's inbox). The trunk writer's fence
   * then says what became of those changes: stopped, or already landed (named; the intent stays live at the
   * new revision), or unconfirmed. Landed, withdrawn and sealed intents cannot be amended (409); an
   * amendment that changes nothing returns the intent as is.
   */
  async amendIntent(id: Id, p: IntentPatch & { reason: string; by?: string }): Promise<{ intent: Intent; revision: IntentRevision | null; notified: Notified[] } & RedirectOutcome> {
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
    if (diff.changed.length === 0) return { intent: current, revision: null, returned: 0, landed: [], confirmed: true, notified: [] };

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

    const sent: Id[] = [];
    const notices: Notice[] = [];
    if (diff.substantive) {
      for (const prev of this.inFlightFor([id])) {
        const next: Proposal = { ...prev, status: "returned", reason: revisedReturn(prev.intentRevision ?? null, revision, diff.changed, reason) };
        this.writeProposal(next, now);
        this.transition(next, prev.status, now, fx);
        sent.push(prev.id);
      }
      const agent = holder ? this.agentRow(holder) : undefined;
      if (holder && agent) {
        // The holder works from the previous revision until it reads the notice (see stampDirection).
        this.sql.exec("INSERT INTO intent_acks (intent_id, agent_id, revision, at) VALUES (?, ?, ?, ?) ON CONFLICT(intent_id, agent_id) DO NOTHING", id, holder, revision - 1, now);
        notices.push({ directive: this.insertDirective({ agentId: holder, kind: "revision", intentId: id, message: reason, by, at: now, revision, changed: diff.changed }), kind: agent.kind });
      }
      // Contest mode: every other contestant is told as well.
      notices.push(...this.contestRevised(id, holder, revision, diff.changed, reason, by, now));
    }
    const fresh = this.intentRow(id);
    const intent = fresh ? this.toIntent(fresh, colony.id) : { ...current, ...diff.next, revision };
    fx.events.push({ t: "intent", at: now, intentId: id, status: intent.status, title: intent.title, footprint: intent.footprint });
    fx.events.push({ t: "amended", at: now, intentId: id, revision, changed: diff.changed, reason, by, title: intent.title, returned: sent.length });
    // The new direction as it stands now, before a landing report can interleave; the trunk writer's fence records it.
    const direction = diff.substantive ? this.directionOf([id]) : null;
    // The trunk writer records the new direction before the lanes are told: their dequeue can wait behind a
    // landing call in flight, and a change queued in the writer is stopped by its cycle only once this is recorded.
    const fencing = direction ? this.fence(direction, sent) : null;
    await this.flushEffects(fx);
    for (const n of notices) n.intent = intent;
    const [notified, fenced] = await Promise.all([this.deliver(notices), fencing]);
    const after = fenced ? this.intentRow(id) : undefined;
    return {
      intent: after ? this.toIntent(after, colony.id) : intent,
      revision: { intentId: id, revision, changed: diff.changed, before: diff.before, after: diff.after, reason, by, at: now, substantive: diff.substantive },
      ...redirectOutcome(sent, fenced?.landed ?? [], fenced?.unconfirmed ?? []),
      notified,
    };
  }

  /**
   * Withdraw an intent before it lands: it becomes "withdrawn" (kept, with the reason), its needs
   * evaporate and its claims clear, the changes in flight for it go back ("withdrawn: ..."), and its
   * holder gives up its lease and is told to stop. The trunk writer's fence then says what became of
   * those changes: stopped, or already landed (named, and the intent shows landed), or unconfirmed.
   * Idempotent. Landed work is untouched (409).
   */
  async withdrawIntent(id: Id, p: { reason: string; by?: string }): Promise<{ intent: Intent; notified: Notified[]; already?: true } & RedirectOutcome> {
    const colony = this.requireColony();
    // Pause (colony/pause.ts): the Agent2Agent CancelTask is an agent's write; a person's withdrawal goes ahead.
    if (p?.by === A2A_ACTOR) await this.pauses().refuse();
    const row = this.intentRow(id);
    if (!row) throw ftError(404, `unknown intent ${id}`);
    if (row.status === "withdrawn") return { intent: this.toIntent(row, colony.id), returned: 0, landed: [], confirmed: true, notified: [], already: true };
    this.assertRedirectable(row, "withdrawn");
    const reason = oneLine(String(p?.reason ?? ""), 500);
    if (!reason) throw ftError(400, "a reason is required: it is recorded with the intent and sent to the agent");
    const now = Date.now();
    const fx = this.effects(colony.regionDepth);
    const out = this.withdrawRows([row], reason, oneLine(p.by ?? "", 200) || "unknown", now, fx);
    const direction = this.directionOf([id]);
    const fencing = this.fence(direction, out.proposalIds); // recorded at the trunk writer before the lanes are told (see amendIntent)
    await this.flushEffects(fx);
    const [notified, fenced] = await Promise.all([this.deliver(out.notices), fencing]);
    const fresh = this.intentRow(id);
    return { intent: this.toIntent(fresh ?? row, colony.id), ...redirectOutcome(out.proposalIds, fenced.landed, fenced.unconfirmed), notified };
  }

  /**
   * Retract a rule: it stays in history (retractedAt, by, reason) but is no longer checked, its open
   * violations no longer count, and every intent it created that has not landed is withdrawn (needs
   * evaporate, changes in flight go back, holders stop; the trunk writer's fence says what became of those
   * changes, as for withdrawIntent). Idempotent.
   */
  async retractRule(ruleId: Id, p: { reason: string; by?: string }): Promise<{ rule: Rule; withdrawn: number; notified: Notified[]; already?: true } & RedirectOutcome> {
    const colony = this.requireColony();
    const row = this.sql.exec<RuleRow>("SELECT * FROM rules WHERE id = ?", ruleId).toArray()[0];
    if (!row) throw ftError(404, `unknown rule ${ruleId}`);
    if (row.retracted_at) return { rule: this.toRule(row, colony.id), withdrawn: 0, returned: 0, landed: [], confirmed: true, notified: [], already: true };
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
    const direction = this.directionOf(rows.map((r) => r.id));
    const fencing = this.fence(direction, out.proposalIds); // recorded at the trunk writer before the lanes are told (see amendIntent)
    await this.flushEffects(fx);
    const [notified, fenced] = await Promise.all([this.deliver(out.notices), fencing]);
    const fresh = this.sql.exec<RuleRow>("SELECT * FROM rules WHERE id = ?", ruleId).toArray()[0] ?? row;
    return { rule: this.toRule(fresh, colony.id), withdrawn: rows.length, ...redirectOutcome(out.proposalIds, fenced.landed, fenced.unconfirmed), notified };
  }

  /**
   * Undo one proposal of a landed change (`ft revert <colony> <prp_...>`): revertLanding limited to
   * that proposal, so only the files it wrote go back and only its intent comes back; the landing's
   * other proposals stay. A method of its own, so an object still on the previous class refuses the
   * call (deploys reach objects gradually) instead of undoing the whole landing.
   */
  async revertProposal(ref: string, p: { proposal: Id; reason: string; by?: string; redo?: boolean }): Promise<{ landing: Landing; reverted: Landing; redo: Id[]; proposal: Id }> {
    const proposal = String(p?.proposal ?? "").trim();
    if (!proposal) throw ftError(400, "say which proposal of the landing to revert");
    return { ...(await this.revertLanding(ref, { ...p, proposal })), proposal };
  }

  /**
   * Undo a landed change (`ft revert`): a person's decision, recorded with their reason in the event
   * record and in the revert commit's lineage note. The trunk writer refuses when work has landed on
   * top of the change. Unless `redo` is false, each intent the landing completed comes back as a new
   * intent (its parent is the one undone, its why starts with the reason), and the violations a rule
   * fix had cleared count again until that intent lands. With `proposal`, only that proposal of the
   * landing is undone (see revertProposal) and only its intent comes back.
   */
  async revertLanding(ref: string, p: { reason: string; by?: string; redo?: boolean; proposal?: Id }): Promise<{ landing: Landing; reverted: Landing; redo: Id[] } & Partial<RedirectOutcome>> {
    const colony = this.requireColony();
    const reason = oneLine(String(p?.reason ?? ""), 500);
    if (!reason) throw ftError(400, "a reason is required: it is recorded with the revert and given to the intents it brings back");
    const by = oneLine(p.by ?? "", 200) || "unknown";
    const proposal = typeof p.proposal === "string" && p.proposal.trim() !== "" ? p.proposal.trim() : undefined;
    const trunk = this.trunkStub();
    const res = (await (proposal ? trunk.revertProposal(String(ref ?? ""), { by, reason, proposal }) : trunk.revert(String(ref ?? ""), { by, reason }))) as RevertResult;
    if (!res.ok) throw ftError(res.status, res.error);
    this.noteSystemCommit(res.landing);
    const now = Date.now();
    const drafts: Array<IntentInput & { violations?: number }> = [];
    const restored: Array<{ ruleId: Id; violations: number }> = [];
    // One proposal undone: only its intent comes back (from the lineage note, else this colony's record of the proposal).
    const undone = res.proposal ?? (proposal ? { id: proposal, intentId: null } : undefined);
    const intentIds = undone ? [undone.intentId ?? this.proposalRow(undone.id)?.intent_id].filter((id): id is Id => typeof id === "string" && id !== "") : res.reverted.intentIds;
    const what = undone ? `${undone.id} of ${res.reverted.id}` : res.reverted.id;
    // Field guide (FT_FIELD_GUIDE): the lessons left with what was undone leave the guide (colony/guide.ts).
    this.guide()?.reverted({ landing: res.reverted, ...(undone ? { proposalId: undone.id } : {}), by, reason });
    if (p.redo !== false) {
      for (const intentId of intentIds) {
        const row = this.intentRow(intentId);
        if (!row || row.status !== "landed") continue;
        const original = this.toIntent(row, colony.id);
        const rule = row.rule_id ? this.sql.exec<{ retracted_at: number | null }>("SELECT retracted_at FROM rules WHERE id = ?", row.rule_id).toArray()[0] : undefined;
        const ruleId = rule && !rule.retracted_at ? row.rule_id : null;
        drafts.push({
          colonyId: colony.id,
          title: oneLine(`Redo after revert: ${original.title}`, 200),
          why: `${by} reverted ${what} (${res.reverted.trunkSha.slice(0, 7)}): ${reason}\n\n${original.why}`,
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
    this.publish({ t: "reverted", at: now, landingId: res.landing.id, of: res.reverted.id, trunkSha: res.landing.trunkSha, paths: res.landing.paths, reason, by, redo, ...(undone ? { proposal: undone.id } : {}) });

    // Undoing a revert puts its change back: the intents it declared again are not needed any more
    // (none can have landed, or this revert would have been refused), and its violations are fixed again.
    // Their changes in flight go back, and the trunk writer's fence says what became of them.
    const prior = this.sql.exec<{ redo: string; restored: string }>("SELECT redo, restored FROM reverts WHERE landing_id = ?", res.reverted.id).toArray()[0];
    let redirect: RedirectOutcome | undefined;
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
      const direction = this.directionOf(rows.map((r) => r.id));
      const fencing = this.fence(direction, out.proposalIds); // recorded at the trunk writer before the lanes are told (see amendIntent)
      await this.flushEffects(fx);
      const [, fenced] = await Promise.all([this.deliver(out.notices), fencing]);
      if (out.proposalIds.length > 0) redirect = redirectOutcome(out.proposalIds, fenced.landed, fenced.unconfirmed);
    } else if (restored.length > 0) {
      this.publish(this.violationsEvent(now));
    }
    return { landing: res.landing, reverted: res.reverted, redo, ...(redirect ?? {}) };
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

  /**
   * One intent with its revision history (oldest first), the directives about it (newest first), and
   * the reports agents made on it with the answers (newest first).
   */
  async intentHistory(id: Id): Promise<{ intent: Intent; revisions: IntentRevision[]; directives: Directive[]; escalations: IntentEscalation[] } | null> {
    const colony = this.requireColony();
    const row = this.intentRow(id);
    if (!row) return null;
    const directives = this.sql
      .exec<DirectiveRow>("SELECT * FROM directives WHERE intent_id = ? ORDER BY at DESC LIMIT 100", id)
      .toArray()
      .map((r) => toDirective(r, colony.id));
    return { intent: this.toIntent(row, colony.id), revisions: this.revisionRows(id).map(toRevision), directives, escalations: this.escalationHistory(id) };
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
   * notice each. Returns the notices to deliver and the changes sent back (for the trunk writer's fence).
   */
  private withdrawRows(rows: IntentRow[], reason: string, by: string, now: number, fx: Effects, ruleId?: Id): { notices: Notice[]; proposalIds: Id[] } {
    if (rows.length === 0) return { notices: [], proposalIds: [] };
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
      // Contest mode: every other contestant stops too.
      notices.push(...this.contestWithdrawn(row, reason, by, now, fx));
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
    return { notices, proposalIds: inflight.map((p) => p.id) };
  }

  /** These intents' direction as the trunk writer's fence records it: status, revision, withdrawal reason, substantive amendments. */
  private directionOf(intentIds: Id[]): Record<Id, DirectionInfo> {
    const out: Record<Id, DirectionInfo> = {};
    for (const id of new Set(intentIds)) {
      const row = this.intentRow(id);
      if (!row) continue;
      const revision = row.revision ?? 1;
      const info: DirectionInfo = { status: row.status as IntentStatus, revision };
      if (row.withdrawn_reason) info.withdrawnReason = row.withdrawn_reason;
      if (revision > 1) {
        info.revisions = this.revisionRows(id)
          .filter((r) => r.substantive === 1)
          .slice(-MAX_REVISIONS)
          .map((r) => ({ revision: r.revision, changed: toRevision(r).changed, reason: r.reason, at: r.at }));
      }
      out[id] = info;
    }
    return out;
  }

  /**
   * The trunk writer's direction fence (TrunkDO.direction), after a person changed these intents' direction
   * and the colony sent their changes in flight (`proposalIds`) back. The writer records the new direction
   * (every later landing cycle checks it) and answers once the cycles that read the old one are over: a
   * change one of them landed is named, and its landing is settled here at once (onLanding is idempotent),
   * so a landing report still on its way, or one that was lost, cannot leave the intent looking withdrawn
   * while its change is on trunk. Changes the writer cannot vouch for, or all of them when it does not
   * answer, are unconfirmed: they may still land.
   */
  private async fence(intents: Record<Id, DirectionInfo>, proposalIds: Id[]): Promise<{ landed: LandedChange[]; unconfirmed: Id[] }> {
    if (Object.keys(intents).length === 0 && proposalIds.length === 0) return { landed: [], unconfirmed: [] };
    let answer: FenceAnswer;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const late = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer in ${FENCE_ANSWER_MS} ms`)), FENCE_ANSWER_MS);
      });
      answer = (await Promise.race([this.trunkStub().direction({ intents, proposalIds }), late])) as FenceAnswer;
    } catch (err) {
      console.error(`direction fence for ${Object.keys(intents).join(", ") || "no intent"} did not answer: ${errorText(err)}`);
      return { landed: [], unconfirmed: [...proposalIds] };
    } finally {
      if (timer) clearTimeout(timer);
    }
    for (const l of Array.isArray(answer?.landings) ? answer.landings : []) {
      try {
        await this.onLanding(l);
      } catch (err) {
        console.error(`landing ${l?.id} named by the direction fence not settled: ${errorText(err)}`);
      }
    }
    const asked = new Set(proposalIds);
    const landed = (Array.isArray(answer?.landed) ? answer.landed : []).filter((x) => asked.has(x.proposalId));
    const done = new Set(landed.map((x) => x.proposalId));
    const unconfirmed = (Array.isArray(answer?.undetermined) ? answer.undetermined : []).filter((id) => asked.has(id) && !done.has(id));
    return { landed, unconfirmed };
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
  // Reports (escalations): an agent says an intent cannot be done as written,
  // instead of working around it, and a person answers. See colony/direction.ts.
  // =========================================================================

  /** Intents whose report a person is answering right now: a second answer at the same time is refused (409). */
  private readonly answering = new Set<Id>();

  /**
   * An agent reports that the intent it holds cannot be done as written: a test that is wrong, a
   * contradictory spec, an impossible ask. The intent stays open, but take() offers it to no agent
   * until a person answers (resolveEscalation). The agent's claim and lease are released as on a
   * release, with no failure mark (reporting is not failing), and a change it has in flight for the
   * intent goes back. The report is kept on the intent and in its history; one open report per
   * intent (409). Publishes `escalation` and `intent` events.
   */
  async escalate(agentId: Id, p: { intentId?: Id; kind: EscalationKind; report: string }): Promise<{ intent: Intent; escalation: IntentEscalation }> {
    const colony = this.requireColony();
    const agent = this.requireAgent(agentId);
    // Pause (colony/pause.ts): an agent's report waits for a person to resume, like its changes.
    await this.pauses().refuse();
    const kind = escalationKind(p?.kind);
    if (!kind) throw ftError(400, `kind must be one of ${ESCALATION_KINDS.join(", ")}`);
    const report = reportText(p?.report);
    if (!report) throw ftError(400, "a report is required: say what is wrong, quoting the test or the spec line");
    const named = typeof p.intentId === "string" && p.intentId.trim() ? p.intentId.trim() : null;
    const intentId =
      named ??
      agent.intent_id ??
      this.sql.exec<{ id: string }>("SELECT id FROM intents WHERE assigned_to = ? AND status IN ('claimed', 'proposed') ORDER BY updated_at DESC LIMIT 1", agentId).toArray()[0]?.id ??
      null;
    if (!intentId) throw ftError(400, "you hold no intent: take one, or name the intent your report is about");
    const row = this.intentRow(intentId);
    if (!row) throw ftError(404, `unknown intent ${intentId}`);
    this.assertRedirectable(row, "reported on");
    if (row.escalation_open === 1) throw ftError(409, `intent ${row.id} already has a report waiting for a person`);
    if (row.assigned_to !== agentId || (row.status !== "claimed" && row.status !== "proposed")) {
      throw ftError(409, `intent ${row.id} is not held by ${agentId}: report on an intent you hold`);
    }
    const now = Date.now();
    const escalation: IntentEscalation = { kind, report, by: agentId, at: now };
    const fp = this.footprintOf(row.id, row.footprint);
    const fx = this.effects(colony.regionDepth);
    // Open, unassigned and waiting for a person: take() skips intents whose report is open.
    this.sql.exec("UPDATE intents SET status = 'open', assigned_to = NULL, escalation = ?, escalation_open = 1, updated_at = ? WHERE id = ?", JSON.stringify(escalation), now, row.id);
    this.sql.exec("INSERT OR REPLACE INTO intent_escalations (intent_id, at, agent_id, kind, report, resolved) VALUES (?, ?, ?, ?, ?, NULL)", row.id, now, agentId, kind, report);
    if (this.candidateRows) this.candidateRows.rows = this.candidateRows.rows.filter((r) => r.id !== row.id);
    // Released as on a release, but reporting is not failing: no failure mark.
    fx.batch.clear(fp, { agentId, intentId: row.id, kind: "claim" });
    if (agent.intent_id === row.id || agent.intent_id === null) {
      this.sql.exec("UPDATE agents SET state = 'idle', intent_id = NULL, workspace = NULL WHERE id = ?", agentId);
      if (agent.state !== "idle") fx.events.push({ t: "agent", at: now, agentId, kind: agent.kind as AgentKind, state: "idle" });
      fx.release.add(agentId);
      // Its take's claim is gone: other takes stop counting it at once.
      this.recentClaims.delete(agentId);
    }
    // A change in flight for it goes back (a redirect: nothing reopens, no failure mark).
    for (const prev of this.inFlightFor([row.id])) {
      const next: Proposal = { ...prev, status: "returned", reason: supersededReturn(`its agent reported the intent to a person (${kind})`) };
      this.writeProposal(next, now);
      this.transition(next, prev.status, now, fx);
    }
    fx.events.push({ t: "intent", at: now, intentId: row.id, status: "open", title: row.title, footprint: fp });
    fx.events.push({ t: "escalation", at: now, intentId: row.id, agentId, kind, report, title: row.title });
    await this.flushEffects(fx);
    const fresh = this.intentRow(row.id);
    return { intent: this.toIntent(fresh ?? row, colony.id), escalation };
  }

  /**
   * A person answers an open report (POST /api/colonies/:id/intents/:iid/escalation). `amend` changes
   * the intent through amendIntent (the note is the amendment's reason) and reopens it; `withdraw`
   * withdraws it with the note; `dismiss` reopens it unchanged, and the note becomes guidance on the
   * intent, so whoever takes it next reads the answer. The report keeps the answer
   * (`escalation.resolved`), and an `escalation` event carries it. 409 when no report is open.
   */
  async resolveEscalation(
    intentId: Id,
    p: { decision: EscalationDecision; note: string; by?: string; amend?: { title?: string; why?: string; footprint?: Path[] } },
  ): Promise<{ intent: Intent }> {
    const colony = this.requireColony();
    const decision = escalationDecision(p?.decision);
    if (!decision) throw ftError(400, "decision must be amend, withdraw or dismiss");
    const note = reportText(p?.note, MAX_ANSWER_CHARS);
    if (!note) throw ftError(400, "a note is required: it is the answer the agents and the history keep");
    const by = oneLine(p.by ?? "", 200) || "unknown";
    const row = this.intentRow(intentId);
    if (!row) throw ftError(404, `unknown intent ${intentId}`);
    const open = row.escalation_open === 1 ? parseEscalation(row.escalation) : null;
    if (!open || open.resolved) throw ftError(409, `intent ${intentId} has no report waiting for a person`);
    if (this.answering.has(intentId)) throw ftError(409, `the report on intent ${intentId} is being answered`);
    this.answering.add(intentId);
    try {
      if (decision === "amend") {
        const a = p.amend ?? {};
        const patch: IntentPatch = {};
        if (a.title !== undefined) patch.title = a.title;
        if (a.why !== undefined) patch.why = a.why;
        if (a.footprint !== undefined) patch.footprint = a.footprint;
        if (Object.keys(patch).length === 0) throw ftError(400, "amend needs a title, why or footprint to change");
        await this.amendIntent(intentId, { ...patch, reason: note, by });
      } else if (decision === "withdraw") {
        await this.withdrawIntent(intentId, { reason: note, by });
      } else {
        // Only a live intent can be offered again.
        this.assertRedirectable(row, "reopened");
      }
      const now = Date.now();
      const resolved = { by, at: now, decision, note };
      this.sql.exec("UPDATE intents SET escalation = ?, escalation_open = 0, updated_at = ? WHERE id = ?", JSON.stringify({ ...open, resolved }), now, intentId);
      this.sql.exec("UPDATE intent_escalations SET resolved = ? WHERE intent_id = ? AND resolved IS NULL", JSON.stringify(resolved), intentId);
      const fresh = this.intentRow(intentId) ?? row;
      const intent = this.toIntent(fresh, colony.id);
      const events: ColonyEvent[] = [{ t: "escalation", at: now, intentId, agentId: open.by, kind: open.kind, report: open.report, title: intent.title, resolved }];
      if (decision === "dismiss") {
        events.push({ t: "intent", at: now, intentId, status: intent.status, title: intent.title, footprint: intent.footprint });
        // The answer follows the intent to whoever takes it next (guidance is about the intent).
        const reporter = this.agentRow(open.by);
        if (reporter) {
          const d = this.insertDirective({ agentId: reporter.id, kind: "guidance", intentId, message: oneLine(note, MAX_DIRECTIVE_CHARS), by, at: now });
          events.push({ t: "directive", at: now, directiveId: d.id, agentId: d.agentId, intentId, message: d.message, by, kind: "guidance" });
          this.ctx.waitUntil(this.deliver([{ directive: d, kind: reporter.kind }]).catch((err) => console.warn(`answer to ${reporter.id} not delivered: ${errorText(err)}`)));
        }
      }
      this.publish(events);
      return { intent };
    } finally {
      this.answering.delete(intentId);
    }
  }

  /** Reports waiting for a person, newest first: each intent carries its `escalation`. */
  async escalations(limit = 100): Promise<Intent[]> {
    const colony = this.requireColony();
    const n = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)));
    return this.sql
      .exec<IntentRow>("SELECT * FROM intents WHERE escalation_open = 1 AND status = 'open' ORDER BY updated_at DESC LIMIT ?", n)
      .toArray()
      .map((r) => this.toIntent(r, colony.id));
  }

  /** The reports agents made on an intent, with the answers, newest first. */
  private escalationHistory(intentId: Id): IntentEscalation[] {
    const rows = this.sql
      .exec<{ at: number; agent_id: string; kind: string; report: string; resolved: string | null }>(
        "SELECT at, agent_id, kind, report, resolved FROM intent_escalations WHERE intent_id = ? ORDER BY at DESC LIMIT 20",
        intentId,
      )
      .toArray();
    return rows.flatMap((r) => {
      const e = parseEscalation(JSON.stringify({ kind: r.kind, report: r.report, by: r.agent_id, at: r.at, resolved: parseJson<unknown>(r.resolved, undefined) }));
      return e ? [e] : [];
    });
  }

  // =========================================================================
  // Agents
  // =========================================================================

  /**
   * Register one agent. An external agent that joins over MCP brings a resume key (mcp/resume.ts):
   * only the key's SHA-256 digest is kept, and no route returns it (resumeAgent checks a key against it).
   */
  async registerAgent(a: { kind: AgentKind; name: string; model?: string; resumeKey?: string }): Promise<AgentInfo> {
    let digest: string | null = null;
    if (a.resumeKey !== undefined) {
      if (a.kind !== "external") throw ftError(400, "only external agents have resume keys");
      if (typeof a.resumeKey !== "string" || a.resumeKey.length < MIN_RESUME_KEY || a.resumeKey.length > MAX_RESUME_KEY) throw ftError(400, "invalid resume key");
      digest = await resumeDigest(a.resumeKey);
    }
    const [agent] = await this.registerAgents([{ kind: a.kind, name: a.name, ...(a.model ? { model: a.model } : {}) }]);
    if (!agent) throw ftError(500, "agent was not registered");
    if (digest) this.sql.exec("INSERT OR REPLACE INTO agent_keys (agent_id, digest, created_at) VALUES (?, ?, ?)", agent.id, digest, Date.now());
    return agent;
  }

  /**
   * An external agent acting as itself again from another MCP session: the agent when `resumeKey` is
   * the key it registered with (the stored digest compared in constant time). Refused as "unknown"
   * (no external agent by that id), "no-key" (registered before resume keys or outside MCP: it joins
   * again as a new agent) or "wrong-key". Never returns the key or its digest.
   */
  async resumeAgent(agentId: Id, resumeKey: string): Promise<{ agent: AgentInfo } | { refused: "unknown" | "no-key" | "wrong-key" }> {
    const colonyId = this.requireColony().id;
    const row = typeof agentId === "string" ? this.agentRow(agentId) : undefined;
    if (!row || row.kind !== "external") return { refused: "unknown" };
    const stored = this.sql.exec<{ digest: string }>("SELECT digest FROM agent_keys WHERE agent_id = ?", row.id).toArray()[0]?.digest;
    if (!stored) return { refused: "no-key" };
    if (typeof resumeKey !== "string" || resumeKey.length > MAX_RESUME_KEY || !(await resumeKeyMatches(resumeKey, stored))) return { refused: "wrong-key" };
    return { agent: this.toAgent(this.agentRow(row.id) ?? row, colonyId, false) };
  }

  /** Register many agents in one call (swarms). */
  async registerAgents(list: Array<{ kind: AgentKind; name: string; model?: string }>): Promise<AgentInfo[]> {
    const colony = this.requireColony();
    // Pause (colony/pause.ts): no platform-run agent (a swarm's in-platform or synthetic agents) starts while paused.
    if (Array.isArray(list) && list.some((a) => a?.kind === "internal" || a?.kind === "synthetic")) await this.pauses().refuse();
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
   * carries the decisions. A contest's winner also carries the other attempts at its intent
   * (`alternatives`, keyed by the winner's proposal id).
   */
  async landContext(intentIds: Id[], agentIds: Id[], proposalIds: Id[] = []): Promise<{
    intents: Record<Id, { title: string; why: string; ruleId?: Id; parentId?: Id; priority?: number; requestedPriority?: number } & DirectionInfo>;
    agents: Record<Id, { kind: AgentKind; model?: string; resumeKey?: boolean }>;
    decisions: Record<Id, NoteDecision[]>;
    alternatives?: Record<Id, ContestAlternative[]>;
    resolves?: Record<Id, NoteResolves>;
    protect?: ProtectRecord;
    pause?: WriterPause;
  }> {
    const colonyId = this.requireColony().id;
    const intents: Record<Id, { title: string; why: string; ruleId?: Id; parentId?: Id; priority?: number; requestedPriority?: number } & DirectionInfo> = {};
    for (const id of new Set(intentIds)) {
      const row = this.intentRow(id);
      if (!row) continue;
      const i = this.toIntent(row, colonyId);
      const entry: { title: string; why: string; ruleId?: Id; parentId?: Id } & DirectionInfo = { title: i.title, why: i.why, status: i.status, revision: i.revision ?? 1 };
      if (i.ruleId) entry.ruleId = i.ruleId;
      if (i.parentId) entry.parentId = i.parentId;
      if (i.withdrawnReason) entry.withdrawnReason = i.withdrawnReason;
      // What an agent asked for when the cap lowered its priority, for the lineage note (priority.ts).
      Object.assign(entry, notePriority(i));
      if ((i.revision ?? 1) > 1) {
        entry.revisions = this.revisionRows(id)
          .filter((r) => r.substantive === 1)
          .slice(-MAX_REVISIONS)
          .map((r) => ({ revision: r.revision, changed: toRevision(r).changed, reason: r.reason, at: r.at }));
      }
      intents[id] = entry;
    }
    const agents: Record<Id, { kind: AgentKind; model?: string; resumeKey?: boolean }> = {};
    for (const id of new Set(agentIds)) {
      const row = this.agentRow(id);
      if (!row) continue;
      const a = this.toAgent(row, colonyId, false);
      // External agents: whether the agent joined over MCP and holds a resume key (lineage provenance names how it was authenticated).
      const resumeKey = a.kind === "external" ? this.sql.exec("SELECT 1 AS x FROM agent_keys WHERE agent_id = ?", id).toArray().length > 0 : undefined;
      agents[id] = { kind: a.kind, ...(a.model ? { model: a.model } : {}), ...(resumeKey !== undefined ? { resumeKey } : {}) };
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
    const alternatives = this.contestAlternatives(wanted);
    // Conflict resolver: what each change its agent wrote resolves (the lineage note's `resolves`, colony/resolver.ts).
    const resolves = this.resolver().records(wanted);
    // Protected paths (colony/protect.ts): the colony's protected globs, once it keeps a record of them; lanes check
    // their batch against it, and the trunk writer keeps the newest one it is handed.
    const protect = parseProtectRecord(this.decider().store.meta(PROTECT_META));
    // Pause (colony/pause.ts): the colony's pauses as they stand; a lane holds on it, and the trunk writer keeps the newest.
    const pause = await this.pauses().writerRecord();
    return { intents, agents, decisions, ...(alternatives ? { alternatives } : {}), ...(Object.keys(resolves).length > 0 ? { resolves } : {}), ...(protect ? { protect } : {}), pause };
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
    // Pause (colony/pause.ts): no agent takes work while the colony's agents are paused.
    await this.pauses().refuse();
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
    // Contest mode: a contestant whose change is not in yet gets its own seat back.
    const seated = await this.contestSeatAgain(agent, colony.id, now);
    if (seated) return seated;

    // Only the columns self-assignment needs; the winner is loaded in full. Contest intents with a free seat join them.
    // Megafile alarm (colony/megafile.ts, FT_MEGAFILE): an intent whose footprint covers a file held for its split waits until the hold lifts.
    const offered = this.megafiles().offerable(this.contestRows(agentId, this.openCandidates(now)), (r) => this.footprintOf(r.id, r.footprint));
    const rows = offered.rows;
    if (rows.length === 0) return this.waitFor(agentId, IDLE_RETRY_MS, offered.reason ?? "no open intents", now);
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
    const importing = this.importsFor(intents, now);
    const neighbors = cochangeWeight > 0 ? await this.cochange.get(intents.flatMap((i) => i.footprint), now, COCHANGE_WAIT_MS) : new Map<Path, Neighbor[]>();
    for (const nbs of neighbors.values()) for (const nb of nbs) want(regionOf(nb.path, depth), nb.path);
    // Files that import each other: the claims on each footprint file's direct imports and importers too.
    const imports = await importing;
    for (const nbs of imports.neighbors.values()) for (const nb of nbs) want(regionOf(nb.path, depth), nb.path);
    const readings = await this.readRegions(wanted);
    const views = this.fieldViews(agentId, readings, depth);
    const claimOn = claimLookup(views, (p) => regionOf(p, depth), CLAIM_STRENGTH);
    const neighborsOf = (p: Path): Neighbor[] | undefined => neighbors.get(p);
    const importLinksOf = (p: Path): Neighbor[] | undefined => imports.neighbors.get(p);
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
      if (imports.neighbors.size > 0) rep += imports.weight * neighborRepulsion(intent.footprint, importLinksOf, claimOn);
      return { intent, region: primary, repulsion: rep, directClaim: direct, admissionOpen: open };
    });
    // Contest mode: contestants' own claims on a contest intent's files neither repel nor inhibit a taker.
    this.contestAdjust(agentId, candidates, perIntent, views);

    const thresholds = parseJson<Record<string, number>>(agent.thresholds, {});
    const inhibitAt = this.inhibitAt();
    let pool = candidates;
    for (let attempt = 0; attempt < PICK_ATTEMPTS && pool.length > 0; attempt++) {
      const pick = chooseIntent(pool, thresholds, Date.now(), this.rand, undefined, inhibitAt);
      if (!pick) break;
      // Contest mode: a contest intent seats several agents, each with a lease of its own.
      if (this.contestSeatsOf(pick.intent.id) >= CONTEST_MIN) {
        if (this.reserveSeat(pick.intent.id, agentId)) return this.leaseSeat(agentId, agent.kind as AgentKind, pick.intent.id);
      } else if (this.reserve(pick.intent.id, agentId)) {
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
    // Contest mode: a seat on a contest intent another agent holds keeps its claims fresh too.
    held.push(...this.contestHeld(agentId, held));
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
    // Contest mode: a seat on an intent another contestant holds is given back the same way.
    this.contestGiveBack(agent, held, now, fx);
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
   * its primary region. Where the field guide is on, the answer also says what
   * became of the agent's `lesson`.
   */
  async propose(input: ProposalInput): Promise<Proposal & { lesson?: LessonReceipt }> {
    const colony = this.requireColony();
    this.requireAgent(input.agentId);
    const intentRow = this.intentRow(input.intentId);
    if (!intentRow) throw ftError(404, `unknown intent ${input.intentId}`);
    // Idempotent: a retry of the same (agent, intent, head commit) gets the proposal it already made,
    // even after that proposal landed or went back.
    const repeat = this.repeatedProposal(input.agentId, intentRow.id, input.headSha);
    if (repeat) {
      if (input.notify === true && !SENT_BACK.has(repeat.status) && repeat.status !== "landed") this.watchOutcome(repeat.id, repeat.agentId);
      // Field guide (FT_FIELD_GUIDE): a repeat hears about the lesson the first call left.
      const again = input.lesson !== undefined ? this.guide()?.repeated(repeat.id) : undefined;
      return again ? { ...repeat, lesson: again } : repeat;
    }
    // Pause (colony/pause.ts): a new change waits for a person to resume (a repeat above gets the proposal it made).
    await this.pauses().refuse();
    this.assertProposable(intentRow, input.agentId);
    const writeSet = this.normalizeVersions(input.writeSet);
    if (writeSet.length === 0) throw ftError(400, "proposal write set is empty");
    // An inline change carries the text of every file it writes (colony/inline.ts); its head is the changeset id of its base and write set.
    const contents = input.contents ?? null;
    const shape = { baseSha: input.baseSha, headSha: input.headSha, writeSet };
    if (contents !== null) {
      const refused = inlineRefusal(shape, contents);
      if (refused) throw ftError(400, `inline change refused: ${refused}`);
    } else if (isInlineChange(shape)) {
      throw ftError(400, "headSha is the changeset id of an inline change: send its contents, or propose a commit pushed to the workspace");
    }
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
    // Megafile alarm (colony/megafile.ts, FT_MEGAFILE): a split's change records the held file's lines before and after
    // it in its evidence, which the landing's lineage note keeps.
    const splitCheck = this.megafiles().splitCheck(intentRow.id, writeSet, contents);
    if (splitCheck) evidence.checks = [...evidence.checks, splitCheck];
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
    // A change to a protected path (the colony policy) needs a person even with review off: it takes the decide path,
    // where rule P3 escalates it before any model is asked.
    const touchesProtected = protectedHits(writeSet.map((w) => w.path), engine.store.policy().protectedPaths ?? []).length > 0;
    // Megafile alarm (colony/megafile.ts, FT_MEGAFILE): a change that writes a file held for another intent's split goes
    // back here, the earliest point that knows what it writes, before any review (a sealed vaccine is left to its meter).
    const held = this.megafiles().heldBack(writeSet, intentRow.id);
    const heldBack = held !== null && engine.store.vaccineByIntent(intentRow.id) === null ? held : null;
    // Tests before landing (certify/preland.ts, FT_PRELAND): a change they cover takes the decide path even with review off,
    // where the test files it reaches run before it goes on to its lane.
    const prelanded = this.certifier.prelandCovers(writeSet.map((w) => w.path));
    const deciding = !heldBack && (engine.enabled() || engine.store.vaccineByIntent(intentRow.id) !== null || touchesProtected || prelanded);
    const proposal: Proposal = heldBack ? { ...draft, status: "returned", reason: heldBack } : { ...draft, status: deciding ? "checking" : OPEN_LIKE.has(draft.status) ? "ready" : draft.status };

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
    // The contents go in their own table, written with the row (no await between them), never into it (a held-back change's nowhere).
    if (contents !== null && !heldBack) {
      this.inline().put(proposal.id, contents);
      this.inline().sweep(now);
    }
    this.bump("proposals", 1, now);
    if (input.notify === true) this.watchOutcome(proposal.id, proposal.agentId);
    // Field guide (FT_FIELD_GUIDE): the agent's lesson waits as a candidate, recorded before anything can land the change.
    const lesson = input.lesson !== undefined ? this.guide()?.capture(proposal, input.lesson) : undefined;
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
    const stored = this.getProposalSync(proposal.id) ?? proposal;
    // What became of the lesson rides on the answer only (the stored proposal never carries it).
    return lesson ? { ...stored, lesson } : stored;
  }

  /** One proposal by id (agents poll their outcome). */
  async getProposal(id: Id): Promise<Proposal | null> {
    return this.getProposalSync(id);
  }

  /**
   * The contents of inline changes for the trunk writer, one call per landing cycle: by proposal id, each text
   * keyed by its blob id, at most `maxBytes` of text per answer (INLINE_FETCH_BYTES at most); the ids left over
   * come back in `more`. A change whose contents are gone is in neither.
   */
  async inlineContents(ids: Id[], maxBytes?: number): Promise<{ contents: Record<Id, Record<Sha, string>>; more: Id[] }> {
    const budget = typeof maxBytes === "number" && Number.isFinite(maxBytes) && maxBytes > 0 ? Math.min(maxBytes, INLINE_FETCH_BYTES) : INLINE_FETCH_BYTES;
    const out = this.inline().fetch(Array.isArray(ids) ? ids : [], budget);
    this.inline().sweep(Date.now());
    return out;
  }

  /** The contents of the colony's inline changes (created on first use; the table exists from the constructor on). */
  private inline(): InlineContents {
    return (this.inlineStore ??= new InlineContents(this.sql));
  }

  private inlineStore: InlineContents | null = null;

  /**
   * The proposal with its contents when it is an inline change, for the readers of its new files (the decide
   * stage, contest judging, antibody minting); `{}` when they are gone, so no reader falls back to a workspace
   * that never held them.
   */
  private withContents<P extends Proposal | null>(p: P): P {
    if (!p || !isInlineChange(p)) return p;
    return { ...p, contents: this.inline().get(p.id) ?? {} } as P;
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

  /**
   * Patch many proposals in one call (a lane tick's returns). A return may carry `stale`, the paths it was found stale
   * on, which name the landings that moved them (movedBy).
   */
  async updateProposals(items: Array<{ id: Id; patch: Partial<Proposal>; stale?: StalePath[] }>): Promise<void> {
    const colony = this.requireColony();
    const now = Date.now();
    const fx = this.effects(colony.regionDepth);
    for (const { id, patch, stale } of items) {
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
      // What beat it (colony/movedby.ts): a change back because trunk moved its files names the landings that moved them.
      if (next.status === "returned" && prev.status !== "returned") this.attributeReturn(next, stale);
      this.writeProposal(next, now);
      this.transition(next, prev.status, now, fx);
    }
    await this.flushEffects(fx);
  }

  /**
   * A change going back because trunk moved files it read or wrote: `movedBy` names the landings that moved them, from
   * the per-path landing index, and its reason ends by naming them, with what to do. Best effort: a return never fails
   * over it.
   */
  private attributeReturn(p: Proposal, stale: StalePath[] | undefined): void {
    if (!movedCollision(p)) return;
    try {
      this.backfillLandedIndex();
      const moved = movedReturn(this.sql, p, Array.isArray(stale) ? stale : null);
      if (moved) Object.assign(p, moved);
    } catch (err) {
      console.warn(`movedBy for ${p.id} skipped: ${errorText(err)}`);
    }
  }

  /**
   * A trunk commit landed: proposals and intents become landed, rule
   * violation counts drop, `trail` marks go on the landed paths, the agents'
   * claims are cleared and their thresholds for the region reinforced.
   * A change the trunk writer was already landing when a person amended its
   * intent lands too, but the intent stays live at its newer revision (see
   * keepRevised). Antibody files the landing changed are reloaded or retired.
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
    // Megafile alarm (colony/megafile.ts, FT_MEGAFILE): who wrote each script file and how long it is now, read before
    // the proposals settle below (an inline change's texts go then); a split that landed lifts its file's hold.
    this.megafiles().landed(l);

    const fx = this.effects(colony.regionDepth);
    const writtenPaths: Path[] = [];
    const known = new Set<Id>();
    for (const pid of l.proposalIds ?? []) {
      const row = this.proposalRow(pid);
      if (!row) continue;
      const p = JSON.parse(row.data) as Proposal;
      known.add(p.intentId);
      for (const w of p.writeSet) writtenPaths.push(w.path);
      if (p.status === "landed") continue; // already settled through updateProposal
      // Built on an older revision than a later substantive amendment: it lands, and says what is left.
      const missed = this.missedRevision(p);
      // Sent back by a change of direction that reached the trunk writer after its cycle read the old one: it landed, and says so.
      const raced = !missed && p.status === "returned" && isRedirect(p.reason) ? landedAnywayText(p.reason ?? "") : null;
      // Sent to a person for a newly protected path after its cycle had passed the trunk writer's check: it landed, and says so.
      const unguarded = !missed && !raced && p.status === "escalated" && isProtectStop(p.reason) ? protectLandedText(p.reason ?? "") : null;
      const next: Proposal = { ...p, status: "landed", landingId: l.id, ...(missed ? { reason: missed.text } : raced ? { reason: raced } : unguarded ? { reason: unguarded } : {}) };
      this.writeProposal(next, now);
      this.landingMissed = missed;
      try {
        this.transition(next, p.status, now, fx);
      } finally {
        this.landingMissed = null;
      }
    }
    // Intents named by the landing whose proposals this colony does not know (the ones it knows
    // settled with their proposals above).
    for (const iid of l.intentIds ?? []) if (!known.has(iid)) this.landIntent(iid, now, fx);

    const paths = normalizePaths(l.paths && l.paths.length > 0 ? l.paths : writtenPaths);
    fx.batch.deposit("trail", paths, TRAIL_STRENGTH, now);
    fx.batch.landing(groupByRegion(paths, colony.regionDepth).keys(), l.id);
    // For the agents working on these files: why-context at their next take, landing notices now.
    this.landed(l, paths, now);
    // Field guide (FT_FIELD_GUIDE): the lessons of these proposals record their landing (colony/guide.ts).
    this.guide()?.landed(l);

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
    // A person approved this change to colony memory (.firetrident/ is governance): it takes effect now.
    await this.refreshAntibodies({ ...l, paths });
  }

  /**
   * The human review queue: escalated proposals, highest risk first, then oldest first. A proposal
   * whose change the decide engine kept for its reviewer carries it as `review` (see reviewViews).
   */
  async review(): Promise<Proposal[]> {
    this.requireColony();
    const engine = this.decider();
    engine.sweep();
    const queue = this.sql
      .exec<{ data: string }>(
        `SELECT p.data AS data FROM proposals p LEFT JOIN decide_outcomes d ON d.proposal_id = p.id
         WHERE p.status = 'escalated' ORDER BY COALESCE(d.risk, 0) DESC, p.created_at ASC LIMIT 500`,
      )
      .toArray()
      .map((r) => JSON.parse(r.data) as Proposal);
    const views = this.reviewViews(queue.map((p) => p.id));
    let backfills = 0;
    for (const p of queue) {
      const review = views.get(p.id);
      if (review) Object.assign(p, { review });
      // Escalated before views were kept: build one in the background, for the next read.
      else if (backfills++ < REVIEW_BACKFILLS) this.ctx.waitUntil(engine.backfillReview(p.id).catch((err) => console.warn(`review view of ${p.id} not built: ${errorText(err)}`)));
    }
    // What beat the intent's last change (colony/movedby.ts): the landings this one was redone on, for its reviewer.
    for (const p of queue.slice(0, REVIEW_MOVED)) {
      const last = this.lastReturn(p.intentId);
      if (last?.movedBy) Object.assign(p, { lastReturn: last });
    }
    return queue;
  }

  /**
   * The change behind each escalated proposal as its reviewer should see it: the view the decide
   * engine keeps in `decide_review` when it escalates (diff per file, danger lines, residual paths;
   * secret lines already masked). Only those fields are copied, each one checked. A proposal escalated
   * before views were kept, a row that does not parse, and a colony without the table get none. Views
   * go to the first proposals of the queue until about a million characters, so a long queue stays one
   * bounded reply; the others get theirs once the ones ahead of them are decided.
   */
  private reviewViews(ids: readonly Id[]): Map<Id, Record<string, unknown>> {
    const views = new Map<Id, Record<string, unknown>>();
    if (ids.length === 0) return views;
    // The decide engine creates the table: a colony it has not escalated with yet has none.
    if (this.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'decide_review'").toArray().length === 0) return views;
    let rows: Array<{ id: string; view: SqlStorageValue }>;
    try {
      // Sizes first, so views past the budget are never read into memory.
      const sizes = this.sql
        .exec<{ id: string; n: number | null }>("SELECT proposal_id AS id, length(view) AS n FROM decide_review WHERE proposal_id IN (SELECT value FROM json_each(?))", JSON.stringify(ids))
        .toArray();
      const size = new Map(sizes.map((s) => [s.id, typeof s.n === "number" ? s.n : Infinity]));
      let left = 1_000_000;
      const wanted: Id[] = [];
      for (const id of ids) {
        const n = size.get(id);
        if (n === undefined || n > left) continue;
        wanted.push(id);
        left -= n;
      }
      if (wanted.length === 0) return views;
      rows = this.sql.exec<{ id: string; view: SqlStorageValue }>("SELECT proposal_id AS id, view FROM decide_review WHERE proposal_id IN (SELECT value FROM json_each(?))", JSON.stringify(wanted)).toArray();
    } catch {
      // A table without the expected columns: nothing to show rather than no queue.
      return views;
    }
    const text = (v: unknown): string => (typeof v === "string" ? v : "");
    const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
    const objects = (v: unknown): Array<Record<string, unknown>> => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x)) : []);
    for (const r of rows) {
      let v: unknown;
      try {
        v = typeof r.view === "string" ? JSON.parse(r.view) : null;
      } catch {
        continue;
      }
      if (!v || typeof v !== "object" || Array.isArray(v)) continue;
      const o = v as Record<string, unknown>;
      const files = objects(o.files)
        .filter((f) => typeof f.path === "string" && f.path !== "")
        .map((f) => ({ path: f.path as Path, status: text(f.status), added: count(f.added), removed: count(f.removed), hunks: text(f.hunks), truncated: f.truncated === true }));
      const danger = objects(o.danger)
        .filter((d) => typeof d.path === "string" && d.path !== "" && typeof d.cls === "string" && d.cls !== "")
        .map((d) => ({ path: d.path as Path, line: count(d.line), cls: d.cls as string, pattern: text(d.pattern), label: text(d.label) }));
      const residual = Array.isArray(o.residual) ? o.residual.filter((p): p is Path => typeof p === "string" && p !== "") : [];
      if (files.length === 0 && danger.length === 0 && residual.length === 0) continue;
      views.set(r.id, { files, filesChanged: Math.max(count(o.filesChanged), files.length), danger, residual });
    }
    return views;
  }

  /** A human decision on a proposal: approve (back to its lane), reject (intent reopened) or return. */
  async decide(proposalId: Id, d: "approve" | "reject" | "return", reason: string, by: string): Promise<void> {
    const colony = this.requireColony();
    if (d !== "approve" && d !== "reject" && d !== "return") throw ftError(400, `unknown decision ${String(d)}`);
    const row = this.proposalRow(proposalId);
    if (!row) throw ftError(404, `unknown proposal ${proposalId}`);
    // With an inline change's contents: an antibody minted from a rejection reads the change.
    const p = this.withContents(JSON.parse(row.data) as Proposal);
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
      // Merge locks (trunk/mergelock.ts): the approval travels with the change, so the trunk writer never merges it on its
      // own. A change already cleared to land carries it too, in its lane's copy as well; a held merge is answered.
      if (p.status === "ready") {
        await this.updateProposals([{ id: proposalId, patch: { approvedAt: now } }]);
        try {
          await (await this.region(row.region ?? ".")).stampApproval(proposalId, now);
        } catch (err) {
          // The lane still passes the recorded decision with its lineage context.
          console.warn(`approval of ${proposalId} not stamped in its lane: ${errorText(err)}`);
        }
        return;
      }
      await this.updateProposals([{ id: proposalId, patch: { status: "ready", approvedAt: now, mergeHold: undefined } }]);
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
  // Pause (colony/pause.ts): a person stops every agent of the colony, or of the deployment, with a reason
  // =========================================================================

  private pauseSwitch: ColonyPause | null = null;

  /**
   * Pause the colony's agents (POST /api/colonies/:id/pause, or code acting for a person, such as a spend cap, naming
   * itself as `by`). Until a person resumes, every agent-facing write is refused with one sentence, the lanes hold and
   * the trunk writer defers what it was handed. A pause already in force stands (`already`).
   */
  async pause(p: { reason: string; by?: string }): Promise<PauseAnswer> {
    this.requireColony();
    return this.pauses().pause({ by: p?.by ?? "api", reason: p?.reason });
  }

  /** Resume the colony's agents (POST /api/colonies/:id/resume); a deployment pause in force still holds them. */
  async resume(p: { by?: string; reason?: string } = {}): Promise<ResumeAnswer & { spendCap?: string }> {
    const colony = this.requireColony();
    const res = await this.pauses().resume({ by: p?.by ?? "api", reason: p?.reason });
    // Spend cap (colony/spendcap.ts): resumed while the spend is still at the cap, the next model call pauses again.
    const note = res.resumed ? this.spendCaps().resumeNote(colony.id) : null;
    return note ? { ...res, spendCap: note } : res;
  }

  /** The pauses in force (the colony's own first) and the sentence an agent's write meets: lanes, MCP and agents ask. */
  async pauseState(): Promise<PauseView> {
    this.requireColony();
    return this.pauses().view();
  }

  /** The deployment's switch changed (api/pause.ts pushes the registry's record to every colony). */
  async deploymentPause(record: unknown): Promise<{ changed: boolean; writer: boolean | null }> {
    if (!this.loadColony()) return { changed: false, writer: null };
    return this.pauses().deploymentChanged(record);
  }

  /** The pause switch, with this colony as its host (made on first use). */
  private pauses(): ColonyPause {
    if (this.pauseSwitch) return this.pauseSwitch;
    this.pauseSwitch = new ColonyPause({
      sql: this.sql,
      now: () => Date.now(),
      readDeployment: () => this.env.COLONY.get(this.env.COLONY.idFromName(REGISTRY_NAME)).registryFlag(DEPLOYMENT_PAUSE_KEY),
      publish: (events) => void this.publish(events),
      tellWriter: async (record: WriterPause) => {
        try {
          const trunk = this.trunkStub() as unknown as { pause(p: { record: WriterPause }): Promise<{ settled?: boolean }> };
          return (await trunk.pause({ record })).settled === true;
        } catch (err) {
          // Lanes pass the same record with every batch, and hold before they hand one over.
          console.warn(`pause: the trunk writer of ${this.loadColony()?.colony.id ?? "?"} was not told: ${errorText(err)}`);
          return false;
        }
      },
    });
    return this.pauseSwitch;
  }

  // =========================================================================
  // Megafile alarm (colony/megafile.ts, FT_MEGAFILE): hot files get a split intent and a hold
  // =========================================================================

  private megafileAlarm: MegafileAlarm | null = null;

  /**
   * A person holds a file for its split, or releases it (POST /api/colonies/:id/megafile). A hold declares the file's
   * split intent unless one is live, and sends back the changes on their way that write it; a release lifts the hold
   * and leaves the intent. 409 while FT_MEGAFILE does not cover the colony; 404 to release a file that is not held.
   */
  async megafile(p: { path: string; action: "hold" | "release"; by?: string }): Promise<{ hold: MegafileHold; already: boolean } | { released: MegafileHold }> {
    this.requireColony();
    const alarm = this.megafiles();
    if (p?.action === "release") {
      const released = alarm.release(p.path, p.by);
      if (!released) throw ftError(404, `${String(p.path).slice(0, 200)} is not held, so there is nothing to release`);
      return { released };
    }
    if (p?.action !== "hold") throw ftError(400, 'action must be "hold" or "release"');
    return alarm.holdByHand(p.path, p.by);
  }

  /** The files held for their split now and the holds lifted lately; null while FT_MEGAFILE does not cover the colony. */
  async megafileReport(): Promise<MegafileReport | null> {
    this.requireColony();
    return this.megafiles().report();
  }

  /** The megafile report for the snapshot: undefined when the alarm is off or its state cannot be read (the rest of the answer stands). */
  private megafileReportSafe(): MegafileReport | undefined {
    try {
      return this.megafiles().report() ?? undefined;
    } catch (err) {
      console.warn(`megafile report failed: ${errorText(err)}`);
      return undefined;
    }
  }

  /** The megafile alarm, with this colony as its host (made on first use; FT_MEGAFILE switches it on and off). */
  private megafiles(): MegafileAlarm {
    if (this.megafileAlarm) return this.megafileAlarm;
    const host: MegafileHost = {
      sql: this.sql,
      enabled: () => megafileEnabled(this.env.FT_MEGAFILE, this.loadColony()?.colony.id ?? ""),
      now: () => Date.now(),
      proposal: (id) => this.getProposalSync(id),
      contents: (id) => this.inline().get(id),
      intent: (id) => {
        const r = this.intentRow(id);
        return r ? { status: r.status, reported: r.escalation_open === 1 } : null;
      },
      declare: (input) => this.addIntent({ ...input, colonyId: this.requireColony().id }),
      readFile: (path) => this.trunkStub().readFile(path),
      inFlight: (path, intentId) =>
        this.sql
          .exec<{ id: string }>(
            `SELECT DISTINCT p.id AS id FROM proposals p JOIN json_each(p.data, '$.writeSet') w
              WHERE p.status IN ('pending', 'checking', 'ready', 'escalated') AND p.intent_id != ? AND json_extract(w.value, '$.path') = ?
                AND NOT EXISTS (SELECT 1 FROM intents i WHERE i.id = p.intent_id AND i.created_by = 'vaccine')`,
            intentId,
            path,
          )
          .toArray()
          .map((r) => r.id),
      sendBack: (items) => this.updateProposals(items.map((i) => ({ id: i.id, patch: { status: "returned" as const, reason: i.reason } }))),
      waitUntil: (p) => this.ctx.waitUntil(p.catch((err) => console.warn(`megafile: ${errorText(err)}`))),
    };
    this.megafileAlarm = new MegafileAlarm(host);
    return this.megafileAlarm;
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

  /**
   * Change the colony's decide policy (partial; numbers are clamped). Newly protected globs also reach the changes
   * already cleared to land (colony/protect.ts): `protection` says which were stopped and which had already landed.
   */
  async setDecidePolicy(patch: unknown): Promise<DecidePolicy & { protection?: ProtectOutcome }> {
    this.requireColony();
    const store = this.decider().store;
    const before = store.policy().protectedPaths;
    const policy = store.setPolicy(patch);
    // Protected paths (colony/protect.ts): a change of the protected globs moves the record lanes and the trunk writer read.
    const protection = await protectChanged(this.protectHost(), before, policy.protectedPaths);
    return protection ? { ...policy, protection } : policy;
  }

  /** The protected-paths record's host (colony/protect.ts): the decide store keeps the record, the trunk writer fences it. */
  private protectHost(): ProtectHost {
    const store = this.decider().store;
    return {
      record: () => parseProtectRecord(store.meta(PROTECT_META)),
      keep: (record) => store.setMeta(PROTECT_META, JSON.stringify(record)),
      now: () => Date.now(),
      cleared: () =>
        this.sql
          .exec<{ data: string; approved: number | null }>(
            `SELECT p.data AS data, (SELECT MAX(d.at) FROM decisions d WHERE d.subject = p.id AND d.layer = 'human' AND d.action = 'approve') AS approved
               FROM proposals p WHERE p.status = 'ready' AND NOT EXISTS (SELECT 1 FROM intents i WHERE i.id = p.intent_id AND i.created_by = 'vaccine')`,
          )
          .toArray()
          .map((r) => ({ p: JSON.parse(r.data) as Proposal, approved: typeof r.approved === "number" ? r.approved : null })),
      fence: (record, proposalIds) => this.trunkStub().protect({ record, proposalIds }),
      escalate: (items) => this.updateProposals(items.map((i) => ({ id: i.id, patch: { status: "escalated" as const, reason: i.reason } }))),
      settle: (l) => this.onLanding(l),
    };
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
      // An inline change with its contents: the decide stage reads its new files from them, never from a workspace.
      proposal: (id) => this.withContents(this.getProposalSync(id)),
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
      // Spend per intent (FT_INTENT_SPEND, colony/intentspend.ts): the stage's calls, counted for the proposal's intent.
      countIntentCall: (intentId, layer, model, usage) => this.intentSpends().count(intentId, layer, model, usage, Date.now()),
      // Spend cap (colony/spendcap.ts): each of the stage's model calls reserved against the cap; as before with none.
      capAi: (ai, use) => this.capped(ai, use),
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
      // Quoted acceptance's keep lines (FT_QUOTED_ACCEPTANCE, decide/quotes.ts): the newest landing by another intent on
      // these paths, from the why-context index, with that intent's acceptance list.
      keepAcceptance: (intentId, paths) =>
        keepSource(this.whyContext({ id: intentId, footprint: paths } as Intent), intentId, (id) => {
          const row = this.intentRow(id);
          return row ? this.toIntent(row, this.requireColony().id) : null;
        }),
      // Tests before landing (certify/preland.ts, FT_PRELAND): whether they cover a change, and the certifier's check of it.
      prelandCovers: (p) => this.certifier.prelandCovers(p.writeSet.map((w) => w.path)),
      preland: async (p, texts) => {
        const out = await this.certifier.precheck(p, prelandReader(this.env, p, texts));
        if (out) this.bump(`preland.${out.run.status}`, 1, Date.now());
        return out;
      },
    };
    this.decideEngine = new DecideEngine(host);
    return this.decideEngine;
  }

  /** Returns that leave a retry of the same commit welcome (nothing was judged wrong with it; a megafile hold lifts in time). */
  private static readonly TRANSIENT_RETURN = /lane unavailable|landing failed|decide pipeline failed|head commit changed|second opinion unavailable|trunk kept moving|is being split by intent/i;

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
    // A person's revert can bring an antibody file back or remove it (an antibody's own commit changes nothing).
    this.ctx.waitUntil(this.refreshAntibodies(l));
  }

  // =========================================================================
  // Contest mode (decide/contest.ts): up to `contest` agents hold one intent,
  // each builds its own change, one lands and the others are kept as the
  // winner's alternatives
  // =========================================================================

  /** Contest intents (id → seats) not known to be finished: loaded once, finished ones dropped when seen. */
  private contestCache: Map<Id, number> | null = null;
  /** Contests to look at once the effects being flushed are applied (a change was held for each). */
  private readonly contestDirty = new Set<Id>();
  /** Contests being decided now (the judge's model calls take a while). */
  private readonly contestBusy = new Set<Id>();
  /** Contests whose last decision failed, and when (tried again after CONTEST_RETRY_MS). */
  private readonly contestFailed = new Map<Id, number>();
  private contestTimer: ReturnType<typeof setTimeout> | null = null;
  private contestRunning: Promise<void> | null = null;
  private contestAgain = false;

  /** Forget the in-memory contest state (colony erased). */
  private contestReset(): void {
    this.contestCache = null;
    this.contestDirty.clear();
    this.contestBusy.clear();
    this.contestFailed.clear();
    if (this.contestTimer !== null) clearTimeout(this.contestTimer);
    this.contestTimer = null;
    this.contestAgain = false;
  }

  /** Contest intents not known to be finished, id → seats. */
  private contestIntents(): Map<Id, number> {
    if (this.contestCache) return this.contestCache;
    const map = new Map<Id, number>();
    for (const r of this.sql.exec<{ id: string; contest: number }>("SELECT id, contest FROM intents WHERE contest >= ? AND status IN ('open', 'claimed', 'proposed')", CONTEST_MIN)) {
      map.set(r.id, r.contest);
    }
    this.contestCache = map;
    return map;
  }

  /** Seats of a contest intent; 0 for an ordinary one. */
  private contestSeatsOf(intentId: Id): number {
    return this.contestIntents().get(intentId) ?? 0;
  }

  /** A new intent is a contest: its seats, and the seat of the agent it was declared for. */
  private contestRecord(intent: Intent, seats: number, now: number): void {
    this.sql.exec("UPDATE intents SET contest = ? WHERE id = ?", seats, intent.id);
    intent.contest = seats;
    this.contestIntents().set(intent.id, seats);
    if (intent.assignedTo) this.seat(intent.id, intent.assignedTo, now);
  }

  /** Give an agent a seat (again). */
  private seat(intentId: Id, agentId: Id, now: number): void {
    this.sql.exec(
      "INSERT INTO contest_seats (intent_id, agent_id, state, at) VALUES (?, ?, 'seated', ?) ON CONFLICT(intent_id, agent_id) DO UPDATE SET state = 'seated', at = excluded.at",
      intentId,
      agentId,
      now,
    );
  }

  /** An agent's seat state ('seated' or 'out'), or null. */
  private seatOf(intentId: Id, agentId: Id): string | null {
    return this.sql.exec<{ state: string }>("SELECT state FROM contest_seats WHERE intent_id = ? AND agent_id = ?", intentId, agentId).toArray()[0]?.state ?? null;
  }

  /** Live contestants, oldest seat first: seated, not dead, and still on this intent. */
  private contestLive(intentId: Id): Id[] {
    return this.sql
      .exec<{ id: string }>(
        "SELECT s.agent_id AS id FROM contest_seats s JOIN agents a ON a.id = s.agent_id WHERE s.intent_id = ? AND s.state = 'seated' AND a.state != 'dead' AND a.intent_id = s.intent_id ORDER BY s.at",
        intentId,
      )
      .toArray()
      .map((r) => r.id);
  }

  /** The latest round of a contest, or null. */
  private contestRound(intentId: Id): ContestRound | null {
    return this.sql.exec<ContestRound>("SELECT * FROM contests WHERE intent_id = ?", intentId).toArray()[0] ?? null;
  }

  /**
   * Whether a decided round still stands: its winner is in its lane, or landed and its intent with it.
   * A winner that came back (stale, conflicting, refused) ends the round, and the intent seats a new one.
   */
  private contestStands(round: ContestRound, intent: Pick<IntentRow, "status"> | undefined): boolean {
    if (round.state !== "decided" || !round.winner) return false;
    const status = this.proposalRow(round.winner)?.status;
    return status === "ready" || (status === "landed" && intent?.status === "landed");
  }

  /** Seats may be taken while no round's clock runs and no decision stands. */
  private contestSeatsOpen(intentId: Id, intent: Pick<IntentRow, "status"> | undefined): boolean {
    const round = this.contestRound(intentId);
    return !round || (round.state === "decided" && !this.contestStands(round, intent));
  }

  /** Is this status one an agent can still work on? */
  private static live(status: string | undefined): boolean {
    return status === "open" || status === "claimed" || status === "proposed";
  }

  /**
   * Take, for a contestant asking again: while its own change is not in yet, it gets its seat back
   * (its lease, or a new one). Null when the agent holds no seat on the intent it is on.
   */
  private async contestSeatAgain(agent: AgentRow, colonyId: Id, now: number): Promise<TakeResult | null> {
    const id = agent.intent_id;
    if (!id || this.contestSeatsOf(id) < CONTEST_MIN || this.seatOf(id, agent.id) !== "seated") return null;
    const row = this.intentRow(id);
    if (!row || !ColonyDO.live(row.status)) return null;
    // With a change in (in review, held, in a lane) it may take other work, as after any proposal.
    if (this.sql.exec("SELECT 1 FROM proposals WHERE agent_id = ? AND intent_id = ? AND status IN ('pending', 'checking', 'ready', 'escalated') LIMIT 1", agent.id, id).toArray().length > 0) return null;
    const lease = parseJson<WorkspaceLease | null>(agent.workspace, null);
    if (lease && lease.tokenExpiresAt > now + LEASE_MIN_LIFE_MS) return this.assignment({ ...this.toIntent(row, colonyId), status: "claimed", assignedTo: agent.id }, lease);
    return this.leaseSeat(agent.id, agent.kind as AgentKind, id);
  }

  /**
   * The rows a take scores: the open intents, plus contest intents another agent holds that still
   * have a free seat for this agent (none once a round's clock runs or while a decision stands).
   */
  private contestRows(
    agentId: Id,
    rows: Array<{ id: string; footprint: string; priority: number; created_at: number }>,
  ): Array<{ id: string; footprint: string; priority: number; created_at: number }> {
    const contests = this.contestIntents();
    if (contests.size === 0) return rows;
    const listed = new Set(rows.map((r) => r.id));
    const extra: typeof rows = [];
    const found = this.sql
      .exec<{ id: string; footprint: string; priority: number; created_at: number; status: string; escalation_open: number | null }>(
        "SELECT id, footprint, priority, created_at, status, escalation_open FROM intents WHERE id IN (SELECT value FROM json_each(?))",
        JSON.stringify([...contests.keys()].slice(0, CANDIDATE_CAP)),
      )
      .toArray();
    for (const r of found) {
      if (!ColonyDO.live(r.status)) {
        contests.delete(r.id); // finished: nobody joins it any more
        continue;
      }
      // A report waiting for a person keeps every seat closed (escalation).
      if (r.status === "open" || r.escalation_open === 1 || listed.has(r.id) || !this.contestSeatsOpen(r.id, r)) continue;
      const live = this.contestLive(r.id);
      if (live.includes(agentId) || live.length >= (contests.get(r.id) ?? 0)) continue;
      extra.push({ id: r.id, footprint: r.footprint, priority: r.priority, created_at: r.created_at });
    }
    return extra.length > 0 ? [...rows, ...extra] : rows;
  }

  /**
   * Contest candidates other agents already hold: their contestants' own claims on its files neither
   * repel nor inhibit the taker (each contestant holds at most one claim per file), and admission lets
   * it join work its regions already admitted. Claims of anyone else count as usual.
   */
  private contestAdjust(agentId: Id, candidates: Candidate[], perIntent: Array<Map<string, Path[]>>, views: Map<string, FieldView>): void {
    if (this.contestIntents().size === 0) return;
    candidates.forEach((c, i) => {
      if (this.contestSeatsOf(c.intent.id) < CONTEST_MIN) return;
      const others = this.contestLive(c.intent.id).filter((a) => a !== agentId);
      if (others.length === 0) return;
      const recent = new Set(others.map((a) => this.recentClaims.get(a)).filter((x): x is RecentClaim => x !== undefined));
      let rep = c.repulsion;
      let direct = c.directClaim ?? 0;
      for (const [region, paths] of perIntent[i] ?? new Map<string, Path[]>()) {
        const view = views.get(region);
        if (!view) continue;
        // Contestants' claims newer than the reading are in `unseen`; the rest are in the reading.
        const unseen = view.unseen.filter((u) => recent.has(u));
        const inReading = others.length - unseen.length;
        if (view.repulsive && inReading > 0) {
          for (const p of new Set(paths)) {
            const removed = Math.min(Object.hasOwn(view.byPath, p) ? (view.byPath[p]?.claim ?? 0) : 0, inReading * CLAIM_STRENGTH);
            rep -= removed;
            direct -= removed;
          }
        }
        for (const u of unseen) {
          rep -= CLAIM_STRENGTH * overlapCount(u.paths, paths);
          for (const p of paths) if (u.paths.has(p)) direct -= CLAIM_STRENGTH;
        }
      }
      c.repulsion = Math.max(0, rep);
      c.directClaim = Math.max(0, direct);
      c.admissionOpen = true;
    });
  }

  /**
   * Seat an agent on a contest intent (false when it is full, its clock runs, a decision stands, or the
   * agent holds a seat already). The first seat claims the intent as a take would.
   */
  private reserveSeat(intentId: Id, agentId: Id): boolean {
    const seats = this.contestSeatsOf(intentId);
    const row = this.intentRow(intentId);
    if (!row || !ColonyDO.live(row.status) || seats < CONTEST_MIN || !this.contestSeatsOpen(intentId, row)) return false;
    const live = this.contestLive(intentId);
    if (live.includes(agentId) || live.length >= seats) return false;
    const now = Date.now();
    if (row.status === "open") {
      const won = this.sql.exec("UPDATE intents SET status = 'claimed', assigned_to = ?, updated_at = ? WHERE id = ? AND status = 'open' RETURNING id", agentId, now, intentId).toArray();
      if (won.length === 0) return false;
      if (this.candidateRows) this.candidateRows.rows = this.candidateRows.rows.filter((r) => r.id !== intentId);
    }
    this.seat(intentId, agentId, now);
    this.sql.exec("UPDATE agents SET intent_id = ?, workspace = NULL WHERE id = ?", intentId, agentId);
    return true;
  }

  /**
   * Lease a workspace for a seated contestant and claim the intent's files: the first contestant goes
   * through admission like any taker, the others join work its regions already admitted. Undone (the
   * seat given up, the intent reopened if nobody else holds it) when a region refuses, the pool is
   * empty, or the seat was lost meanwhile.
   */
  private async leaseSeat(agentId: Id, kind: AgentKind, intentId: Id): Promise<TakeResult> {
    const colony = this.requireColony();
    const row = this.intentRow(intentId);
    if (!row) return { wait: true, retryInMs: jitter(LEASE_RETRY_MS, this.rand), reason: `unknown intent ${intentId}` };
    const intent = this.toIntent(row, colony.id);
    const first = this.contestLive(intentId).every((a) => a === agentId);
    const recent = { paths: new Set(intent.footprint), regions: new Set(groupByRegion(intent.footprint, colony.regionDepth).keys()), doneAt: null as number | null };
    this.recentClaims.set(agentId, recent);
    const closed = first ? await this.admitClaims(agentId, intent) : await this.seatClaims(agentId, intent);
    const claimedAt = Date.now();
    recent.doneAt = claimedAt;
    let lease: WorkspaceLease | null = null;
    let failure = closed.length > 0 ? `admission closed in ${closed.join(", ")}` : "pool empty";
    let publishWaitMs: number | undefined;
    if (closed.length === 0) {
      try {
        const got = await this.leaseFresh(agentId, intent);
        lease = got.lease;
        if (got.wait) {
          failure = got.wait;
          publishWaitMs = PUBLISH_WAIT_RETRY_MS;
        }
      } catch (err) {
        failure = `lease failed: ${errorText(err)}`;
        console.error(`PoolDO.lease failed for ${agentId}: ${failure}`);
      }
    }
    const now = Date.now();
    const fresh = this.intentRow(intentId);
    const held = !!fresh && ColonyDO.live(fresh.status) && this.seatOf(intentId, agentId) === "seated" && this.agentRow(agentId)?.intent_id === intentId;
    if (!lease || !held) {
      if (this.recentClaims.get(agentId) === recent) this.recentClaims.delete(agentId);
      const fx = this.effects(colony.regionDepth);
      this.sql.exec("UPDATE contest_seats SET state = 'out', at = ? WHERE intent_id = ? AND agent_id = ?", now, intentId, agentId);
      if (fresh && fresh.status === "claimed" && fresh.assigned_to === agentId) {
        // The intent stays with another contestant, or reopens when nobody else holds it.
        const other = this.contestLive(intentId).find((a) => a !== agentId);
        if (other) this.sql.exec("UPDATE intents SET assigned_to = ?, updated_at = ? WHERE id = ?", other, now, intentId);
        else {
          this.sql.exec("UPDATE intents SET status = 'open', assigned_to = NULL, updated_at = ? WHERE id = ?", now, intentId);
          fx.events.push({ t: "intent", at: now, intentId, status: "open", title: intent.title, footprint: intent.footprint });
        }
      }
      fx.batch.clear(intent.footprint, { agentId, intentId, kind: "claim" });
      this.sql.exec("UPDATE agents SET intent_id = NULL, workspace = NULL WHERE id = ? AND intent_id = ?", agentId, intentId);
      this.setAgentState(agentId, "waiting", now);
      if (lease) fx.release.add(agentId);
      await this.flushEffects(fx);
      return { wait: true, retryInMs: jitter(publishWaitMs ?? (closed.length > 0 ? CLOSED_RETRY_MS : LEASE_RETRY_MS), this.rand), reason: lease ? "the contest seat was lost while leasing" : failure };
    }
    this.sql.exec("UPDATE agents SET state = 'working', intent_id = ?, workspace = ?, last_seen = ? WHERE id = ?", intentId, JSON.stringify(lease), now, agentId);
    this.lastRefresh.set(agentId, claimedAt);
    this.waits.done(agentId);
    const events: ColonyEvent[] = [{ t: "agent", at: now, agentId, kind, state: "working", intentId, paths: intent.footprint }];
    if (first) events.unshift({ t: "intent", at: now, intentId, status: "claimed", title: intent.title, footprint: intent.footprint });
    this.publish(events);
    this.bump("takes", 1, now);
    return this.assignment({ ...intent, status: "claimed", assignedTo: agentId }, lease);
  }

  /** Claims for a contestant joining work its regions already admitted: deposited without the admission check. Returns the regions that could not be reached. */
  private async seatClaims(agentId: Id, intent: Intent): Promise<string[]> {
    const closed: string[] = [];
    const at = Date.now();
    await Promise.all(
      [...groupByRegion(intent.footprint, this.requireColony().regionDepth)].map(async ([region, paths]) => {
        try {
          await (await this.region(region)).apply({ deposit: paths.map((path) => ({ kind: "claim" as const, path, strength: CLAIM_STRENGTH, at, agentId, intentId: intent.id })) });
        } catch (err) {
          console.error(`contest claim failed in region ${region} for ${agentId}: ${errorText(err)}`);
          closed.push(region);
        }
      }),
    );
    return closed;
  }

  /** Contest intents an agent holds a live seat on but not the intent row: heartbeats refresh those claims too. */
  private contestHeld(agentId: Id, held: ReadonlyArray<{ id: string }>): Array<{ id: string; footprint: string }> {
    if (this.contestIntents().size === 0) return [];
    const have = new Set(held.map((h) => h.id));
    return this.sql
      .exec<{ id: string; footprint: string }>(
        `SELECT i.id AS id, i.footprint AS footprint FROM contest_seats s JOIN intents i ON i.id = s.intent_id JOIN agents a ON a.id = s.agent_id
          WHERE s.agent_id = ? AND s.state = 'seated' AND a.intent_id = s.intent_id AND i.status IN ('open', 'claimed', 'proposed')`,
        agentId,
      )
      .toArray()
      .filter((r) => !have.has(r.id));
  }

  /**
   * May an agent propose for a contest intent someone else holds? Yes while it holds a seat. One the
   * colony stood down after a decision gets a 409 that says so; anyone else is refused as usual.
   */
  private contestProposable(row: IntentRow, agentId: Id): boolean {
    if (this.contestSeatsOf(row.id) < CONTEST_MIN) return false;
    const seat = this.seatOf(row.id, agentId);
    if (seat === "seated") return true;
    const round = seat === "out" ? this.contestRound(row.id) : null;
    if (round && this.contestStands(round, row)) {
      throw ftError(409, `intent ${row.id}: its contest was decided (${round.winner} won); stop work on it and take other work`);
    }
    return false;
  }

  /**
   * A contest intent was withdrawn: its live contestants other than the intent row's holder (whom
   * withdrawRows tells) stop as the holder does: idle, lease released, told why. Their claims went with
   * the intent's.
   */
  private contestWithdrawn(row: IntentRow, reason: string, by: string, now: number, fx: Effects): Notice[] {
    if (this.contestSeatsOf(row.id) < CONTEST_MIN) return [];
    const out: Notice[] = [];
    for (const agentId of this.contestLive(row.id)) {
      const agent = agentId === row.assigned_to ? undefined : this.agentRow(agentId);
      if (!agent) continue;
      this.sql.exec("UPDATE agents SET state = 'idle', intent_id = NULL, workspace = NULL WHERE id = ?", agent.id);
      if (agent.state !== "idle") fx.events.push({ t: "agent", at: now, agentId: agent.id, kind: agent.kind as AgentKind, state: "idle" });
      fx.release.add(agent.id);
      out.push({ directive: this.insertDirective({ agentId: agent.id, kind: "withdrawal", intentId: row.id, message: reason, by, at: now }), kind: agent.kind });
    }
    this.sql.exec("UPDATE contest_seats SET state = 'out', at = ? WHERE intent_id = ? AND state = 'seated'", now, row.id);
    return out;
  }

  /**
   * A contest intent was amended substantively: its live contestants other than the holder (whom
   * amendIntent tells) get the revision notice too, and are held to the revision they saw until they
   * read it (see stampDirection).
   */
  private contestRevised(intentId: Id, holder: Id | null, revision: number, changed: IntentField[], reason: string, by: string, now: number): Notice[] {
    if (this.contestSeatsOf(intentId) < CONTEST_MIN) return [];
    const out: Notice[] = [];
    for (const agentId of this.contestLive(intentId)) {
      const agent = agentId === holder ? undefined : this.agentRow(agentId);
      if (!agent) continue;
      this.sql.exec("INSERT INTO intent_acks (intent_id, agent_id, revision, at) VALUES (?, ?, ?, ?) ON CONFLICT(intent_id, agent_id) DO NOTHING", intentId, agentId, revision - 1, now);
      out.push({ directive: this.insertDirective({ agentId, kind: "revision", intentId, message: reason, by, at: now, revision, changed }), kind: agent.kind });
    }
    return out;
  }

  /** A contestant gives back a seat on an intent another contestant holds: its claims go, a failure mark stays, the seat frees up. */
  private contestGiveBack(agent: AgentRow, handled: ReadonlyArray<{ id: string }>, now: number, fx: Effects): void {
    const id = agent.intent_id;
    if (!id || handled.some((h) => h.id === id) || this.contestSeatsOf(id) < CONTEST_MIN || this.seatOf(id, agent.id) !== "seated") return;
    const row = this.intentRow(id);
    if (!row) return;
    const fp = this.footprintOf(row.id, row.footprint);
    fx.batch.clear(fp, { agentId: agent.id, intentId: id, kind: "claim" }).deposit("failure", fp, FAILURE_STRENGTH, now, { agentId: agent.id, intentId: id });
    this.sql.exec("UPDATE contest_seats SET state = 'out', at = ? WHERE intent_id = ? AND agent_id = ?", now, id, agent.id);
  }

  /**
   * The lane hand-off for contest intents: a ready change waits for its contest instead of going to its
   * lane (the first one starts the contest's clock), and the contest is looked at once the effects are
   * flushed. False for ordinary intents and for a contest's winner.
   */
  private contestHold(p: Proposal, now: number): boolean {
    if (this.contestSeatsOf(p.intentId) < CONTEST_MIN) return false;
    const round = this.contestRound(p.intentId);
    if (round?.state === "decided" && round.winner === p.id) return false;
    if (!round || (round.state === "decided" && !this.contestStands(round, this.intentRow(p.intentId)))) {
      this.sql.exec(
        "INSERT OR REPLACE INTO contests (intent_id, state, opened_at, deadline, winner, reason, alternatives, decided_at) VALUES (?, 'open', ?, ?, NULL, NULL, NULL, NULL)",
        p.intentId,
        now,
        now + CONTEST_WAIT_MS,
      );
    }
    this.sql.exec("INSERT OR REPLACE INTO contest_entries (proposal_id, intent_id, agent_id, at) VALUES (?, ?, ?, ?)", p.id, p.intentId, p.agentId, now);
    this.contestDirty.add(p.intentId);
    return true;
  }

  /**
   * After effects are flushed: contests a change was just held for are looked at now, open ones a
   * second later (a contestant may have given back, died or been sent back, and then the others need
   * not wait for it).
   */
  private contestWake(): void {
    if (this.contestDirty.size > 0) {
      this.contestSweep();
      return;
    }
    if (this.contestTimer !== null || this.contestIntents().size === 0) return;
    if (this.sql.exec("SELECT 1 FROM contests WHERE state = 'open' LIMIT 1").toArray().length === 0) return;
    this.contestTimer = setTimeout(() => {
      this.contestTimer = null;
      this.contestSweep();
    }, CONTEST_LOOK_MS);
  }

  /** Look at every contest marked and every open one; a call during a sweep runs another after it. */
  private contestSweep(): void {
    if (this.contestRunning) {
      this.contestAgain = true;
      return;
    }
    const run = (async () => {
      do {
        this.contestAgain = false;
        const ids = new Set<Id>(this.contestDirty);
        this.contestDirty.clear();
        for (const r of this.sql.exec<{ intent_id: string }>("SELECT intent_id FROM contests WHERE state = 'open'")) ids.add(r.intent_id);
        for (const id of ids) {
          try {
            await this.contestCheck(id, Date.now());
          } catch (err) {
            console.warn(`contest ${id} not checked: ${errorText(err)}`);
          }
        }
      } while (this.contestAgain || this.contestDirty.size > 0);
    })().finally(() => {
      this.contestRunning = null;
    });
    this.contestRunning = run;
    this.ctx.waitUntil(run);
  }

  /**
   * Move one contest on. Held changes that are no longer ready (recalled, sent back by a withdrawal or
   * an amendment) drop out. A decided round sends late changes back; an open one is decided once every
   * live contestant has a ready change or its deadline passed (a contestant that gave back or died does
   * not count), else it waits for the deadline (the alarm).
   */
  private async contestCheck(intentId: Id, now: number): Promise<void> {
    if (this.contestBusy.has(intentId)) return;
    // A decision that failed is tried again a minute later (the alarm), not on every look.
    const failed = this.contestFailed.get(intentId);
    if (failed !== undefined && now - failed < CONTEST_RETRY_MS) {
      await this.armContestAlarm(failed + CONTEST_RETRY_MS);
      return;
    }
    let round = this.contestRound(intentId);
    if (!round) return;
    const row = this.intentRow(intentId);
    const ready: Proposal[] = [];
    for (const e of this.sql.exec<{ proposal_id: string }>("SELECT proposal_id FROM contest_entries WHERE intent_id = ? ORDER BY at", intentId).toArray()) {
      const p = this.getProposalSync(e.proposal_id);
      if (p?.status === "ready") ready.push(p);
      else this.sql.exec("DELETE FROM contest_entries WHERE proposal_id = ?", e.proposal_id);
    }
    if (round.state === "decided") {
      if (ready.length === 0) return;
      if (this.contestStands(round, row)) return this.contestLate(intentId, round, ready, now);
      // The winner came back meanwhile: these changes start the next round.
      this.sql.exec("UPDATE contests SET state = 'open', opened_at = ?, deadline = ?, winner = NULL, reason = NULL, alternatives = NULL, decided_at = NULL WHERE intent_id = ?", now, now + CONTEST_WAIT_MS, intentId);
      round = this.contestRound(intentId);
      if (!round) return;
    }
    if (!row || !ColonyDO.live(row.status) || ready.length === 0) {
      // Nothing to decide: the clock starts again with the next ready change.
      this.sql.exec("DELETE FROM contests WHERE intent_id = ? AND state = 'open'", intentId);
      return;
    }
    const proposed = new Set(ready.map((p) => p.agentId));
    const waiting = this.contestLive(intentId).filter((a) => !proposed.has(a));
    if (waiting.length > 0 && now < round.deadline) {
      await this.armContestAlarm(round.deadline);
      return;
    }
    this.contestBusy.add(intentId);
    // Should this object be evicted while the judge works, the alarm looks again.
    await this.armContestAlarm(now + CONTEST_RETRY_MS);
    const run = this.contestResolve(intentId, ready)
      .then(() => {
        this.contestFailed.delete(intentId);
        // Changes that became ready while it was being decided are looked at now.
        this.contestDirty.add(intentId);
      })
      .catch((err) => {
        this.contestFailed.set(intentId, Date.now());
        console.error(`contest ${intentId} not decided, tried again in a minute: ${errorText(err)}`);
      })
      .finally(() => {
        this.contestBusy.delete(intentId);
        this.contestWake();
      });
    this.ctx.waitUntil(run);
  }

  /** Decide a contest among its ready changes: deterministic evidence first, then the pairwise judge. */
  private async contestResolve(intentId: Id, ready: Proposal[]): Promise<void> {
    const intent = this.reviewIntent(intentId);
    if (!intent) return;
    const t0 = Date.now();
    const byId = new Map(ready.map((p) => [p.id, p]));
    const candidates: ContestCandidate[] = ready.map((p) => {
      const model = this.agentRow(p.agentId)?.model ?? undefined;
      return { proposalId: p.id, agentId: p.agentId, ...(model ? { model } : {}), createdAt: p.createdAt, ...contestEvidence(p, intent.footprint), size: null, diffs: null };
    });
    const outcome = await selectWinner(candidates, {
      judge: this.contestJudge(intent, candidates.map((c) => c.model)),
      diffs: (c) => {
        const p = byId.get(c.proposalId);
        return p ? this.contestDiffs(p) : Promise.resolve(null);
      },
    });
    await this.contestApply(intentId, outcome, Date.now() - t0);
  }

  /**
   * The pairwise judge (null without a Workers AI binding): second-opinion models outside the authors'
   * families, on the decide engine's call limiter.
   */
  private contestJudge(intent: Intent, authors: Array<string | undefined>): PairJudge | null {
    const bound = (this.env as unknown as { AI?: AiRunner }).AI;
    if (!bound) return null;
    // Spend cap (colony/spendcap.ts): each judge call reserved against the cap; a refused one reads as the judge unavailable (a tie).
    const ai = this.capped(bound, "judge");
    const policy = this.decider().store.policy();
    const limiter = this.contestLimiter();
    limiter.configure(policy.llmConcurrency, policy.llmPerMinute);
    const judged: JudgeIntent = { title: intent.title, why: intent.why, whyBy: whyAuthor(intent.source), ...(intent.acceptance ? { acceptance: intent.acceptance } : {}) };
    // Hedged calls (FT_HEDGE, colony/hedge.ts): judgeSpend counts every run, a losing copy's too.
    const hedge = hedgeFor(this.env, this.requireColony().id, "judge", { bump: (name, delta) => void this.bump(name, delta, Date.now()) });
    // The contest jury (FT_CONTEST_JURY, decide/jury.ts): two or three small models from different families in place of the one judge.
    if (juryEnabled(this.env.FT_CONTEST_JURY, this.requireColony().id)) {
      return pairJury({
        ai: this.judgeSpend(ai, intent.id),
        models: juryMembers(authors, policy.juryModels),
        limiter,
        intent: judged,
        onCall: () => this.bump("contest.judge.calls", 1, Date.now()),
        onVerdict: (members, better) => this.juryCount(members, better),
        hedge,
      });
    }
    return pairJudge({
      ai: this.judgeSpend(ai, intent.id),
      models: judgeModels(authors, policy.secondOpinionModels),
      limiter,
      intent: judged,
      onCall: () => this.bump("contest.judge.calls", 1, Date.now()),
      hedge,
    });
  }

  /** The jury's verdict on one pair, counted: a majority or a tie, and how many members voted consistently or not. */
  private juryCount(members: readonly JuryMember[], better: PairVerdict["better"]): void {
    const now = Date.now();
    this.bump(better === "tie" ? "contest.jury.ties" : "contest.jury.majority", 1, now);
    const inconsistent = members.filter((m) => m.vote === "inconsistent").length;
    if (inconsistent > 0) this.bump("contest.jury.inconsistent", inconsistent, now);
    if (members.length - inconsistent > 0) this.bump("contest.jury.consistent", members.length - inconsistent, now);
  }

  /**
   * The Workers AI binding for the contest judge, with each call's tokens counted in the decide spend
   * (decide.llm.tokensIn and decide.llm.tokensOut, where the second opinion's go: the judge runs on
   * the same second-opinion models). The answer itself passes through untouched.
   */
  private judgeSpend(ai: AiRunner, intentId: Id): AiRunner {
    return {
      run: async (model, input, options) => {
        const res = await (options === undefined ? ai.run(model, input) : ai.run(model, input, options));
        const usage = extractUsage(res);
        const now = Date.now();
        if (usage && usage.input > 0) this.bump("decide.llm.tokensIn", usage.input, now);
        if (usage && usage.output > 0) this.bump("decide.llm.tokensOut", usage.output, now);
        // Per model too, as the contest judge's own layer of the colony's spend (colony/spend.ts).
        for (const [name, delta] of spendCounters("contest.judge", model, usage)) this.bump(name, delta, now);
        // And for the contested intent (spend per intent, FT_INTENT_SPEND).
        this.intentSpends().count(intentId, "judge", model, usage, now);
        return res;
      },
    };
  }

  /** The decide engine's call limiter, so judge calls share its per-model rate, concurrency and throttling cooldowns with the second opinion. */
  private contestLimiter(): CallLimiter {
    return this.decider().limiter;
  }

  /** A contestant's change file by file, for the tie-break and the judge (tests replace it). */
  protected contestDiffs(p: Proposal): Promise<FileDiff[] | null> {
    const trunk = this.trunkStub() as unknown as TrunkRpc;
    return loadDiffs(this.withContents(p), { env: this.env, trunk: this.requireColony().trunk, baseBlobs: (sha, paths) => trunk.baseBlobs(sha, paths) });
  }

  /**
   * Carry out a contest decision: the winner goes to its lane with a `contest` check in its evidence,
   * every other change for the intent goes back superseded by it, contestants still working stand
   * down, and the round keeps the alternatives for the winner's lineage note. Nothing happens when the
   * winner or the intent moved meanwhile (the next look decides again).
   */
  private async contestApply(intentId: Id, outcome: ContestOutcome, ms: number): Promise<void> {
    const colony = this.requireColony();
    const now = Date.now();
    const row = this.intentRow(intentId);
    const won = this.getProposalSync(outcome.winner.proposalId);
    if (!row || !ColonyDO.live(row.status) || won?.status !== "ready") return;
    const fx = this.effects(colony.regionDepth);
    const n = outcome.losers.length;
    const check: CheckResult = { name: "contest", ok: true, ms, detail: oneLine(`won the contest for ${intentId} against ${n} other change${n === 1 ? "" : "s"}: ${outcome.reason}`, 1_000) };
    const winner: Proposal = { ...won, evidence: { ...won.evidence, checks: [...(won.evidence?.checks ?? []), check] } };
    this.writeProposal(winner, now);
    const prow = this.proposalRow(winner.id);
    fx.enqueue.push({ proposal: winner, region: prow?.region ?? ".", priority: prow?.priority ?? row.priority });
    if (row.status !== "proposed" || row.assigned_to !== winner.agentId) {
      this.sql.exec("UPDATE intents SET status = 'proposed', assigned_to = ?, updated_at = ? WHERE id = ?", winner.agentId, now, intentId);
      if (row.status !== "proposed") fx.events.push({ t: "intent", at: now, intentId, status: "proposed", title: row.title, footprint: this.footprintOf(row.id, row.footprint) });
    }
    const lostWhy = new Map(outcome.losers.map((l) => [l.candidate.proposalId, l.why]));
    const alternatives: ContestAlternative[] = [];
    const losers: Id[] = [];
    for (const prev of this.inFlightFor([intentId])) {
      if (prev.id === winner.id) continue;
      const why = lostWhy.get(prev.id) ?? (prev.status === "ready" ? "ready after the contest was decided" : `still ${prev.status} when the contest was decided`);
      const next: Proposal = { ...prev, status: "returned", supersededBy: winner.id, reason: supersededReason(intentId, winner.id, why) };
      this.writeProposal(next, now);
      this.settleSuperseded(prev, next, row, winner.agentId, now, fx);
      const model = this.agentRow(prev.agentId)?.model;
      alternatives.push({ proposalId: prev.id, agentId: prev.agentId, ...(model ? { model } : {}), reason: why });
      losers.push(prev.id);
    }
    const notices: Notice[] = [];
    for (const agentId of this.contestLive(intentId)) {
      const agent = agentId === winner.agentId ? undefined : this.agentRow(agentId);
      if (agent) notices.push(this.contestStop(agent, row, winner.id, now, fx));
    }
    this.sql.exec("UPDATE contest_seats SET state = 'out', at = ? WHERE intent_id = ? AND agent_id != ? AND state = 'seated'", now, intentId, winner.agentId);
    this.sql.exec("DELETE FROM contest_entries WHERE intent_id = ?", intentId);
    this.sql.exec(
      "UPDATE contests SET state = 'decided', winner = ?, reason = ?, alternatives = ?, decided_at = ? WHERE intent_id = ?",
      winner.id,
      outcome.reason,
      JSON.stringify(alternatives),
      now,
      intentId,
    );
    fx.events.push({ t: "contest", at: now, intentId, title: row.title, winner: winner.id, losers, reason: outcome.reason });
    this.bump("contests", 1, now);
    console.log(`contest ${intentId}: ${winner.id} won over ${losers.length} (${outcome.reason})`);
    await this.flushEffects(fx);
    await this.deliver(notices);
  }

  /** Changes that became ready after their contest was decided go back, superseded by its winner. */
  private async contestLate(intentId: Id, round: ContestRound, ready: Proposal[], now: number): Promise<void> {
    const row = this.intentRow(intentId);
    if (!row || !round.winner) return;
    const winnerAgent = this.getProposalSync(round.winner)?.agentId ?? null;
    const fx = this.effects(this.requireColony().regionDepth);
    for (const prev of ready) {
      if (prev.id === round.winner) continue;
      const next: Proposal = { ...prev, status: "returned", supersededBy: round.winner, reason: supersededReason(intentId, round.winner, "ready after the contest was decided") };
      this.writeProposal(next, now);
      this.settleSuperseded(prev, next, row, winnerAgent, now, fx);
    }
    this.sql.exec("DELETE FROM contest_entries WHERE intent_id = ?", intentId);
    await this.flushEffects(fx);
  }

  /**
   * A contest change superseded by its winner goes back to its agent (pushed when watched); the agent
   * stands down with its lease and claims released. No failure mark: it did not fail. The winner's own
   * agent keeps its claims.
   */
  private settleSuperseded(prev: Proposal, next: Proposal, row: IntentRow, winnerAgent: Id | null, now: number, fx: Effects): void {
    fx.events.push({ t: "proposal", at: now, proposalId: next.id, intentId: next.intentId, agentId: next.agentId, status: next.status, ...(next.reason ? { reason: next.reason } : {}) });
    (fx.outcomes ??= []).push(next);
    if (prev.status === "ready") {
      // Held changes sit in no lane; one queued anyway leaves it.
      const region = this.proposalRow(prev.id)?.region ?? ".";
      fx.dequeue.set(region, [...(fx.dequeue.get(region) ?? []), prev.id]);
    }
    this.bump("contest.superseded", 1, now);
    if (next.agentId === winnerAgent) return;
    fx.batch.clear(this.footprintOf(row.id, row.footprint), { agentId: next.agentId, intentId: row.id, kind: "claim" });
    const agent = this.agentRow(next.agentId);
    if (agent && agent.intent_id === row.id) {
      this.sql.exec("UPDATE agents SET state = 'idle', intent_id = NULL, workspace = NULL WHERE id = ?", agent.id);
      if (agent.state !== "idle") fx.events.push({ t: "agent", at: now, agentId: agent.id, kind: agent.kind as AgentKind, state: "idle" });
      fx.release.add(agent.id);
    }
  }

  /**
   * A contestant still working when its contest was decided stands down: told so (a withdrawal of the
   * intent for this agent, pushed or in its inbox), its lease and claims released.
   */
  private contestStop(agent: AgentRow, row: IntentRow, winnerId: Id, now: number, fx: Effects): Notice {
    this.sql.exec("UPDATE agents SET state = 'idle', intent_id = NULL, workspace = NULL WHERE id = ?", agent.id);
    if (agent.state !== "idle") fx.events.push({ t: "agent", at: now, agentId: agent.id, kind: agent.kind as AgentKind, state: "idle" });
    fx.release.add(agent.id);
    fx.batch.clear(this.footprintOf(row.id, row.footprint), { agentId: agent.id, intentId: row.id, kind: "claim" });
    const message = `the contest for this intent was decided before your change was ready (${winnerId} won); stop work on it and take other work`;
    const d = this.insertDirective({ agentId: agent.id, kind: "withdrawal", intentId: row.id, message, by: "colony", at: now });
    fx.events.push({ t: "directive", at: now, directiveId: d.id, agentId: agent.id, intentId: row.id, message, by: "colony", kind: "withdrawal" });
    return { directive: d, kind: agent.kind };
  }

  /**
   * The alarm's look at open contests: each is decided when it can be (its deadline passed, or a
   * decision cut short by an eviction), else the alarm stays on its deadline. Never throws.
   */
  private async contestAlarm(now: number): Promise<void> {
    try {
      if (!this.loadColony()) return;
      for (const r of this.sql.exec<{ intent_id: string }>("SELECT intent_id FROM contests WHERE state = 'open'").toArray()) await this.contestCheck(r.intent_id, now);
      // A decision still being made is looked at again, in case it is cut short.
      if (this.contestBusy.size > 0) await this.armContestAlarm(now + CONTEST_RETRY_MS);
    } catch (err) {
      console.warn(`contest alarm failed: ${errorText(err)}`);
    }
  }

  /** Make sure the alarm fires by `at` (it is shared with the metrics tick: an earlier one stays). */
  private async armContestAlarm(at: number): Promise<void> {
    try {
      const current = await this.ctx.storage.getAlarm();
      if (current === null || current > at) await this.ctx.storage.setAlarm(at);
    } catch (err) {
      console.warn(`contest alarm not armed: ${errorText(err)}`);
    }
  }

  /** The alternatives each contest winner among these proposals carries into its lineage note, or null. */
  private contestAlternatives(proposalIds: Id[]): Record<Id, ContestAlternative[]> | null {
    if (proposalIds.length === 0) return null;
    const rows = this.sql
      .exec<{ winner: string; alternatives: string | null }>(
        "SELECT winner, alternatives FROM contests WHERE state = 'decided' AND winner IN (SELECT value FROM json_each(?))",
        JSON.stringify(proposalIds),
      )
      .toArray();
    const out: Record<Id, ContestAlternative[]> = {};
    for (const r of rows) {
      const list = cleanAlternatives(parseJson<unknown>(r.alternatives, []));
      if (list.length > 0) out[r.winner] = list;
    }
    return Object.keys(out).length > 0 ? out : null;
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
        // Field guide (FT_FIELD_GUIDE): green activates the lessons whose landing it covers, red drops those it names (colony/guide.ts).
        this.guide()?.certified(e);
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
      // Culprit finding (certify/culprit.ts): off unless FT_CULPRITS names this colony.
      culprits: () => culpritsEnabled(this.env.FT_CULPRITS, this.loadColony()?.colony.id ?? ""),
      landedOn: (paths, since) => this.suspectLandings(paths, since),
      landingOf: (sha) => {
        const r = this.sql.exec<{ id: string; at: number }>("SELECT id, at FROM landings WHERE trunk_sha = ? ORDER BY at DESC LIMIT 1", sha).toArray()[0];
        return r ? { landingId: r.id, at: r.at } : null;
      },
      // First red search (certify/bisect.ts): off unless FT_BISECT names this colony. A found commit is added to the
      // open repair intent's why, without a revision: it adds context and sends back no change in flight.
      bisect: () => bisectEnabled(this.env.FT_BISECT, this.loadColony()?.colony.id ?? ""),
      // Tests before landing (certify/preland.ts): off unless FT_PRELAND names this colony.
      preland: () => prelandEnabled(this.env.FT_PRELAND, this.loadColony()?.colony.id ?? ""),
      repairWhy: (intentId, edit) => {
        const row = this.sql.exec<{ why: string }>("SELECT why FROM intents WHERE id = ? AND source = 'certify' AND status IN ('open', 'claimed', 'proposed')", intentId).toArray()[0];
        const why = row ? edit(row.why) : null;
        if (!row || why === null || why === row.why) return false;
        this.sql.exec("UPDATE intents SET why = ? WHERE id = ?", why, intentId);
        return true;
      },
    };
  }

  /**
   * Culprit finding: the latest landings that changed any of `paths` (at most three, newest first),
   * read from the per-path landing index through whyContext, each with the proposal of its intent in
   * that landing and the blobs that proposal landed for those paths (one query for all of them; a file
   * the trunk writer merged, the merged blob). With `since`: the oldest landings since the last green
   * commit that changed them, oldest first, from the landing log (certify/since.ts).
   */
  private async suspectLandings(paths: Path[], since?: SinceGreen): Promise<LandedOn[]> {
    // whyContext reads only the footprint, and the id for its log line.
    const found = since ? landedSince(this.sql, paths, since, LANDINGS_KEEP) : ((await this.whyContext({ id: "certify-suspects", footprint: paths } as Intent)) ?? []);
    if (found.length === 0) return [];
    const writes = this.sql
      .exec<{ landing_id: string; proposal_id: string; intent_id: string; path: string | null; blob: string | null }>(
        `SELECT l.id AS landing_id, p.id AS proposal_id, p.intent_id AS intent_id, json_extract(w.value, '$.path') AS path, json_extract(w.value, '$.blob') AS blob
           FROM landings l JOIN json_each(l.data, '$.proposalIds') j JOIN proposals p ON p.id = j.value JOIN json_each(p.data, '$.writeSet') w
          WHERE l.id IN (SELECT value FROM json_each(?)) AND json_extract(w.value, '$.path') IN (SELECT value FROM json_each(?))`,
        JSON.stringify(found.map((e) => e.landingId)),
        JSON.stringify(paths),
      )
      .toArray();
    // Text merge: a file the trunk writer merged landed as the merged blob, not the one its proposal wrote.
    const landedAs = new Map<string, Sha>();
    if (writes.length > 0) {
      const rows = this.sql
        .exec<{ id: string; merged: string | null }>("SELECT id, json_extract(data, '$.merged') AS merged FROM landings WHERE id IN (SELECT value FROM json_each(?))", JSON.stringify(found.map((e) => e.landingId)))
        .toArray();
      for (const r of rows) {
        let list: unknown = null;
        try {
          list = typeof r.merged === "string" ? JSON.parse(r.merged) : null;
        } catch {
          list = null;
        }
        for (const m of Array.isArray(list) ? (list as Array<{ proposalId?: unknown; path?: unknown; blob?: unknown }>) : []) {
          if (m && typeof m.proposalId === "string" && typeof m.path === "string" && typeof m.blob === "string") landedAs.set(`${r.id}\u0000${m.proposalId}\u0000${m.path}`, m.blob);
        }
      }
    }
    return found.map((e) => {
      const out: LandedOn = { landingId: e.landingId, at: e.at, title: e.title, why: e.why, paths: e.paths };
      if (e.trunkSha) out.trunkSha = e.trunkSha;
      if (e.intentId) out.intentId = e.intentId;
      // The proposal of this landing (for its intent, when known) that wrote these paths: named only when it is one.
      const mine = writes.filter((w) => w.landing_id === e.landingId && (!e.intentId || w.intent_id === e.intentId) && w.path !== null && e.paths.includes(w.path));
      const ids = [...new Set(mine.map((w) => w.proposal_id))];
      if (ids.length === 1) {
        out.proposalId = ids[0]!;
        out.wrote = Object.fromEntries(mine.map((w) => [w.path!, landedAs.get(`${w.landing_id}\u0000${w.proposal_id}\u0000${w.path}`) ?? (typeof w.blob === "string" ? w.blob : null)]));
      }
      return out;
    });
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
  // Field guide (colony/guide.ts, FT_FIELD_GUIDE): lessons agents leave with
  // their proposals, gated by certification or a person
  // =========================================================================

  /**
   * The colony's field guide, or null where FT_FIELD_GUIDE does not cover it (then nothing touches its table) or its
   * table cannot be made (logged: a proposal, a landing or a take never fails over the guide).
   */
  private guide(): FieldGuide | null {
    const colonyId = this.loadColony()?.colony.id;
    if (!colonyId || !guideEnabled(this.env.FT_FIELD_GUIDE, colonyId)) return null;
    try {
      this.guideStore ??= new FieldGuide({
        sql: this.sql,
        // Certification can activate lessons where it runs and has tests to run (its latest result was not skipped).
        certifying: () => this.certifier.active() && this.certifier.latestCertification()?.status !== "skipped",
        certification: (sha) => this.certifier.get(sha),
        certifications: (limit) => this.certifier.list(limit),
      });
    } catch (err) {
      console.warn(`field guide unavailable: ${errorText(err)}`);
      return null;
    }
    return this.guideStore;
  }

  /** The field guide: its active lessons with their provenance; with `admin`, the candidates and the lessons dropped or retired lately too. */
  async fieldGuide(p: { admin?: boolean } = {}): Promise<{ colonyId: Id } & (GuideView | { on: false; note: string; active: [] })> {
    const colonyId = this.requireColony().id;
    const guide = this.guide();
    if (!guide) return { colonyId, on: false, note: "The field guide is off for this colony (FT_FIELD_GUIDE).", active: [] };
    return { colonyId, ...guide.view(p?.admin === true) };
  }

  /** A person approves (the lesson joins the guide) or rejects (it leaves, or never joins) one lesson. */
  async decideLesson(lessonId: Id, p: { action: "approve" | "reject"; by?: string; reason?: string }): Promise<GuideLesson> {
    this.requireColony();
    const guide = this.guide();
    if (!guide) throw ftError(409, "the field guide is off for this colony (FT_FIELD_GUIDE)");
    return guide.decide(String(lessonId ?? ""), { action: p?.action, by: p?.by ?? "", ...(p?.reason ? { reason: p.reason } : {}) });
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

  /** Metrics, funnel, violations, the per-minute series, stuck work and model spend, without the snapshot's lists (GET /api/colonies/:id/metrics). */
  async metricsReport(): Promise<{
    colonyId: Id;
    at: number;
    metrics: Record<string, number>;
    funnel: Record<FunnelStage, number>;
    violations: { total: number; byRule: Record<Id, number> };
    series: ColonySeries;
    convergence: Convergence;
    stuck?: StuckReport;
    spend?: ColonySpend;
    intentSpend?: Record<Id, IntentSpendBrief>;
  }> {
    const colony = this.requireColony();
    const now = Date.now();
    this.maybeReap(now);
    const violations = this.violationTotals();
    const stuck = this.stuckReport(now);
    const metrics = this.currentMetrics(now);
    const report = {
      colonyId: colony.id,
      at: now,
      metrics,
      funnel: this.funnelCounts(),
      violations,
      series: this.seriesReport(now),
      convergence: this.convergence(violations.total),
      ...(stuck ? { stuck } : {}),
    };
    // Model spend (colony/spend.ts): left out when it cannot be computed; the rest of the report stands.
    const spend = await this.spendReport(now, metrics);
    // Spend per intent (colony/intentspend.ts), for the Intents tab's rows; absent when nothing was counted per intent.
    const intentSpend = this.intentSpendMap();
    return { ...report, ...(spend ? { spend } : {}), ...(intentSpend ? { intentSpend } : {}) };
  }

  /** What the colony's model calls cost so far (colony/spend.ts), for the status GET /api/colonies/:id serves; null before init. */
  async spend(): Promise<ColonySpend | null> {
    if (!this.loadColony()) return null;
    const now = Date.now();
    return (await this.spendReport(now, this.currentMetrics(now, true))) ?? null;
  }

  /** The spend book (colony/spend.ts), made on first use: it reads the in-platform agents' journals into this colony's tables. */
  private spendRun: SpendBook | null = null;

  private spendBook(): SpendBook {
    const ns = this.env.AGENT as DurableObjectNamespace | undefined;
    return (this.spendRun ??= new SpendBook({
      sql: this.sql,
      ...(ns ? { readAgent: (id: Id) => (ns.get(ns.idFromName(id)) as unknown as { status(): Promise<unknown> }).status() } : {}),
      platformAgents: () => [this.resolver().agentId(), this.decider().store.meta("vaccineAgent")].filter((id): id is Id => typeof id === "string" && id !== ""),
      resolveModel: (model) => modelOfClass(this.env, model),
      waitUntil: (p) => this.ctx.waitUntil(p),
    }));
  }

  /** The spend report, or undefined when it cannot be computed (logged). */
  private async spendReport(now: number, metrics: Record<string, number>): Promise<ColonySpend | undefined> {
    let spend: ColonySpend;
    try {
      const policy = this.decider().store.policy();
      spend = await this.spendBook().report(now, { metrics, review: { reflexModel: policy.reflexModel, secondOpinionModels: policy.secondOpinionModels } });
    } catch (err) {
      console.warn(`spend report failed: ${errorText(err)}`);
      return undefined;
    }
    // The spend cap (colony/spendcap.ts), when a person set one; the report stands without it if it cannot be read.
    try {
      const cap = this.spendCaps().state();
      return cap ? { ...spend, cap } : spend;
    } catch (err) {
      console.warn(`spend cap state failed: ${errorText(err)}`);
      return spend;
    }
  }

  // =========================================================================
  // Spend cap (colony/spendcap.ts): a person caps what this platform's model calls for the colony may cost
  // =========================================================================

  private spendCapRun: SpendCapBook | null = null;

  /** The spend cap's book, with this colony as its host (made on first use). */
  private spendCaps(): SpendCapBook {
    return (this.spendCapRun ??= new SpendCapBook({
      sql: this.sql,
      now: () => Date.now(),
      bookUsd: () => {
        const policy = this.decider().store.policy();
        return bookUsd(this.spendBook().agentUsage(), this.metricsRecord(), { reflexModel: policy.reflexModel, secondOpinionModels: policy.secondOpinionModels });
      },
      refreshBook: () => void this.spendBook().refresh(Date.now()),
      ownPause: () => this.pauses().own(),
      trip: (reason) => this.pauses().pause({ by: SPEND_CAP_ACTOR, reason }),
      lift: (by, reason) => this.pauses().resume({ by, reason }),
      waitUntil: (p) => this.ctx.waitUntil(p),
    }));
  }

  /** Set or change the colony's spend cap, or remove it with `usd: null` (POST /api/colonies/:id/spend-cap). */
  async setSpendCap(p: { usd: number | null; reviewReserveUsd?: number; by?: string }): Promise<SpendCapAnswer> {
    this.requireColony();
    const by = p?.by ?? "api";
    return p?.usd === null ? this.spendCaps().clear({ by }) : this.spendCaps().set({ usd: p?.usd, reviewReserveUsd: p?.reviewReserveUsd, by });
  }

  /** The spend cap as it stands, or null when none is set (GET /api/colonies/:id/spend-cap). */
  async spendCap(): Promise<SpendCap | null> {
    this.requireColony();
    return this.spendCaps().state();
  }

  /** An in-platform agent's reservation before a model call (agentCapGate); refused with the pause's sentence as the cap trips it. */
  async spendReserve(a: AgentCapAsk): Promise<{ hold: Id | null; capped: boolean }> {
    this.requireColony();
    return agentReserve(this.spendCaps(), a, (m) => modelOfClass(this.env, m));
  }

  /** An in-platform agent's settle after a model call: the hold is released and what the call cost counts. */
  async spendSettle(s: CapSettle): Promise<{ settled: true }> {
    this.requireColony();
    agentSettle(this.spendCaps(), s, (m) => modelOfClass(this.env, m));
    return { settled: true };
  }

  /** The Workers AI binding with each run reserved against the spend cap; with no cap each run goes as before. */
  private capped(ai: AiRunner, use: CapUse): AiRunner {
    return cappedAi(ai, this.spendCaps(), use);
  }

  /** The per-intent book (colony/intentspend.ts), made on first use; it counts only where FT_INTENT_SPEND covers the colony. */
  private intentSpendRun: IntentSpendBook | null = null;

  private intentSpends(): IntentSpendBook {
    return (this.intentSpendRun ??= new IntentSpendBook(this.sql, () => {
      const id = this.loadColony()?.colony.id;
      return !!id && intentSpendEnabled(this.env.FT_INTENT_SPEND, id);
    }));
  }

  /** The spend of the intents counted per intent, by id, for a listing; null when nothing was counted or it cannot be computed (logged). */
  private intentSpendMap(): Record<Id, IntentSpendBrief> | null {
    try {
      return this.intentSpends().map();
    } catch (err) {
      console.warn(`intent spend map failed: ${errorText(err)}`);
      return null;
    }
  }

  /**
   * What one intent's model calls cost (GET /api/colonies/:id/intents/:iid/spend; colony/intentspend.ts): the agents'
   * calls on its takes and the decide stage's on its changes, counted where FT_INTENT_SPEND covers the colony. The
   * journals due a read are read first, so a finished take's calls are in the answer. Null for an unknown intent.
   */
  async intentSpend(intentId: Id): Promise<IntentSpendAnswer | null> {
    this.requireColony();
    if (!this.intentRow(intentId)) return null;
    try {
      await this.spendBook().refreshed(Date.now());
    } catch (err) {
      console.warn(`intent spend: journal reads failed: ${errorText(err)}`);
    }
    return this.intentSpends().report(intentId);
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
    // So did the field guide's.
    this.guideStore = null;
    // So did the megafile alarm's.
    this.megafileAlarm = null;
    // And the pause switch's (a deployment pause in force is read again from the registry).
    this.pauseSwitch = null;
    // And the spend cap's.
    this.spendCapRun = null;
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
    this.contestReset();
    for (const stmt of SCHEMA) this.sql.exec(stmt);
    for (const stmt of OPS_SCHEMA) this.sql.exec(stmt);
    migrateDirection(this.sql);
    migrateContest(this.sql);
    migrateContents(this.sql);
    migratePriority(this.sql);
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

  /** Metrics tick: while UI sockets are connected, re-send live metrics that changed (all every 30 s), reap silent agents and publish newly stuck work. */
  async alarm(): Promise<void> {
    // Contest mode: contests whose deadline passed are decided (the alarm is shared with this tick).
    await this.contestAlarm(Date.now());
    if (this.ctx.getWebSockets().length === 0 || !this.loadColony()) return;
    const now = Date.now();
    this.maybeReap(now);
    this.stuckSweep(now);
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
      // A contest deadline may hold the alarm further out: the tick comes first.
      const at = await this.ctx.storage.getAlarm();
      if (at === null || at > Date.now() + METRICS_TICK_MS) await this.ctx.storage.setAlarm(Date.now() + METRICS_TICK_MS);
    } catch (err) {
      console.warn(`metrics tick not armed: ${errorText(err)}`);
    }
  }

  // =========================================================================
  // Stuck work (colony/stuck.ts)
  // =========================================================================

  /** The stuck-work detector (made on first use), and when the periodic tick last looked for stuck work. */
  private stuckDetector: StuckDetector | null = null;
  private lastStuckSweep = 0;

  /** The detector, on this colony's tables; an agent counts as alive as long as the reaper lets it live. */
  private stuck(): StuckDetector {
    return (this.stuckDetector ??= new StuckDetector(this.sql, AGENT_TTL_MS));
  }

  /** What is stuck now, for the snapshot and the metrics report; undefined when the checks cannot run (the rest of the answer stands). */
  private stuckReport(now: number): StuckReport | undefined {
    try {
      return this.stuck().report(now);
    } catch (err) {
      console.warn(`stuck work not computed: ${errorText(err)}`);
      return undefined;
    }
  }

  /**
   * On the metrics tick, at most every STUCK_SWEEP_MS: publish one `stuck` event per item not
   * published before (the detector's ledger remembers them). Never throws: the tick goes on.
   */
  private stuckSweep(now: number): void {
    if (now - this.lastStuckSweep < STUCK_SWEEP_MS) return;
    this.lastStuckSweep = now;
    try {
      const found = this.stuck().sweep(now);
      if (found.length > 0) this.publish(found.map((item): ColonyEvent => ({ t: "stuck", at: now, item })));
    } catch (err) {
      console.warn(`stuck work sweep failed: ${errorText(err)}`);
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
    let publishWaitMs: number | undefined;
    if (closed.length === 0) {
      try {
        const got = await this.leaseFresh(agentId, intent);
        lease = got.lease;
        if (got.wait) {
          failure = got.wait;
          publishWaitMs = PUBLISH_WAIT_RETRY_MS;
        }
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
      const retryMs = publishWaitMs ?? (closed.length > 0 ? CLOSED_RETRY_MS : LEASE_RETRY_MS);
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
   * Import repulsion for one take: its weight, FT_IMPORT_WEIGHT when set to a positive number
   * (absent, 0 or anything else turns it off, and then nothing is fetched), and the direct imports
   * and importers of the candidates' files from TrunkDO's import index, through a short-lived cache
   * that waits at most IMPORT_WAIT_MS for what it has not cached and fails open.
   */
  private async importsFor(intents: Intent[], now: number): Promise<{ weight: number; neighbors: Map<Path, Neighbor[]> }> {
    const raw = (this.env as unknown as { FT_IMPORT_WEIGHT?: string | number }).FT_IMPORT_WEIGHT;
    const weight = Number(raw ?? 0);
    if (!(Number.isFinite(weight) && weight > 0)) return { weight: 0, neighbors: new Map() };
    return { weight, neighbors: await this.imports.get(intents.flatMap((i) => i.footprint), now, IMPORT_WAIT_MS) };
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
   * what it claims from the shared list. An intent whose report waits for a person (escalate) is not
   * offered: only an intent its agent held can be reported on, so no list read before holds it.
   */
  private openCandidates(now: number): Array<{ id: string; footprint: string; priority: number; created_at: number }> {
    const busy = this.taking.size >= BUSY_TAKES;
    if (busy && this.candidateRows && now - this.candidateRows.at < CANDIDATES_TTL_MS) return this.candidateRows.rows;
    const rows = this.sql
      .exec<{ id: string; footprint: string; priority: number; created_at: number }>(
        "SELECT id, footprint, priority, created_at FROM intents WHERE status = 'open' AND escalation_open IS NOT 1 ORDER BY priority DESC, created_at ASC LIMIT ?",
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

  /** The colony (by creation time) for which this object made sure proposals are indexed by intent (lastReturn). */
  private returnsIndexedFor: number | null = null;

  /**
   * Why the intent's latest change came back, for its next taker: the newest of its proposals that was
   * returned or rejected for a reason other than a change of direction (withdrawn, revised, recalled,
   * a retracted rule) or a lost contest, unless a change for the intent landed after it. It carries
   * the reason as that change's agent was told it (a security return names only the class, and
   * nothing is added to it), the proposal, when it came back and the paths it wrote. Two indexed
   * lookups per take. Best effort: a take never fails over it.
   */
  private lastReturn(intentId: Id): LastReturn | undefined {
    try {
      const colony = this.requireColony();
      if (this.returnsIndexedFor !== colony.createdAt) {
        // Additive and idempotent: a colony gets the index at its first take after a deploy (or after it is made again).
        this.sql.exec("CREATE INDEX IF NOT EXISTS proposals_by_intent ON proposals(intent_id, created_at)");
        this.returnsIndexedFor = colony.createdAt;
      }
      const rows = this.sql
        .exec<{ id: string; status: string; updated_at: number; reason: string | null; superseded_by: string | null; moved_by: string | null }>(
          `SELECT id, status, updated_at, json_extract(data, '$.reason') AS reason, json_extract(data, '$.supersededBy') AS superseded_by, json_extract(data, '$.movedBy') AS moved_by
             FROM proposals WHERE intent_id = ? AND status IN ('returned', 'rejected', 'landed') ORDER BY created_at DESC LIMIT ?`,
          intentId,
          RETURN_LOOKBACK,
        )
        .toArray();
      for (const r of rows) {
        // A change for the intent landed since: what came back before it is history.
        if (r.status === "landed") return undefined;
        if (typeof r.reason !== "string" || r.reason.trim() === "" || r.superseded_by || isRedirect(r.reason)) continue;
        const paths = this.sql
          .exec<{ path: string | null }>("SELECT json_extract(w.value, '$.path') AS path FROM proposals p JOIN json_each(p.data, '$.writeSet') w WHERE p.id = ?", r.id)
          .toArray()
          .flatMap((w) => (typeof w.path === "string" && w.path !== "" ? [w.path] : []));
        const out: LastReturn = { proposalId: r.id, status: r.status === "rejected" ? "rejected" : "returned", at: r.updated_at, reason: returnReason(r.reason), paths: paths.slice(0, RETURN_PATHS) };
        if (paths.length > RETURN_PATHS) out.morePaths = paths.length - RETURN_PATHS;
        // What beat it: the landings that moved its files (colony/movedby.ts).
        const moved = cleanMovedBy(parseJson<unknown>(r.moved_by, undefined));
        if (moved) out.movedBy = moved;
        return out;
      }
      return undefined;
    } catch (err) {
      console.warn(`last return for intent ${intentId} failed: ${errorText(err)}`);
      return undefined;
    }
  }

  private assignment(intent: Intent, lease: WorkspaceLease): TakeResult {
    const rule = intent.ruleId ? this.sql.exec<RuleRow>("SELECT * FROM rules WHERE id = ?", intent.ruleId).toArray()[0] : undefined;
    const review = this.reviewAhead(intent);
    const context = this.whyContext(intent);
    const lastReturn = this.lastReturn(intent.id);
    // Field guide (FT_FIELD_GUIDE): the newest lessons, each with its provenance (colony/guide.ts); absent where the guide is off.
    const guide = this.guide()?.take();
    // Model step-up (FT_MODEL_STEPUP, colony/stepup.ts): the stronger model class after two returns; absent where it is off.
    const model = this.modelStepup(intent);
    // Who declared the intent (colony/chain.ts): its source, the declarer and its model, and the chain depth.
    const declared = this.declaredBy(intent);
    return { intent, lease, ...(rule ? { rule: this.toRule(rule, intent.colonyId) } : {}), ...(review ? { review } : {}), ...(context ? { context } : {}), ...(lastReturn ? { lastReturn } : {}), ...(guide ? { guide } : {}), ...(model ? { model } : {}), ...(declared ? { declaredBy: declared } : {}) };
  }

  /**
   * The model hint of a take (colony/stepup.ts) where FT_MODEL_STEPUP covers the colony: the stronger model class once
   * the intent's changes came back twice since it last changed course, else undefined. Best effort: a take never fails over it.
   */
  private modelStepup(intent: Intent): ModelHint | undefined {
    if (!stepupEnabled(this.env.FT_MODEL_STEPUP, intent.colonyId)) return undefined;
    try {
      return modelHintFor(this.sql, intent.id);
    } catch (err) {
      console.warn(`model step-up for intent ${intent.id} failed: ${errorText(err)}`);
      return undefined;
    }
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

  // =========================================================================
  // Landings, for the agents working on their files (agents/landed.ts): why
  // the code is the way it is at take, landing notices while they work
  // =========================================================================

  /** Set once this object found its landing path index caught up with the landing log; cleared when a landing finds it behind. */
  private landedIndexReady = false;
  /** Landing notices written since old ones were last pruned. */
  private noticesSincePrune = 0;

  /**
   * The latest landings that changed files in the intent's footprint, each with the intent it
   * completed and that intent's why (at most WHY_LANDINGS, newest first): why the code is the way it
   * is. Read from the colony's own path index, a few indexed lookups per take; trunk is never asked.
   * Best effort: a take never fails over it.
   */
  private whyContext(intent: Intent): LandedWhy[] | undefined {
    try {
      this.backfillLandedIndex();
      const footprint = (intent.footprint ?? []).slice(0, WHY_FOOTPRINT);
      const rows: LandedRow[] = [];
      for (const entry of footprint) {
        const range = indexRange(entry);
        if (!range) continue;
        const found =
          "eq" in range
            ? this.sql.exec<LandedIndexRow>("SELECT path, at, landing_id, intent_id FROM landing_paths WHERE path = ? ORDER BY at DESC LIMIT ?", range.eq, WHY_PER_PATH)
            : this.sql.exec<LandedIndexRow>("SELECT path, at, landing_id, intent_id FROM landing_paths WHERE path >= ? AND path < ? LIMIT ?", range.from, range.to, WHY_RANGE_ROWS);
        for (const r of found) rows.push({ path: r.path, at: r.at, landingId: r.landing_id, intentId: r.intent_id });
      }
      const picked = pickLanded(rows, footprint, WHY_LANDINGS);
      if (picked.length === 0) return undefined;
      const texts = this.intentTexts(picked.flatMap((e) => (e.intentId ? [e.intentId] : [])));
      const commits = new Map(
        this.sql
          .exec<{ id: string; trunk_sha: string }>("SELECT id, trunk_sha FROM landings WHERE id IN (SELECT value FROM json_each(?))", JSON.stringify(picked.map((e) => e.landingId)))
          .toArray()
          .map((r) => [r.id, r.trunk_sha]),
      );
      return picked.map((e) => {
        const t = e.intentId ? texts.get(e.intentId) : undefined;
        const out: LandedWhy = { landingId: e.landingId, at: e.at, title: shortTitle(t?.title), why: shortWhy(t?.why), paths: e.paths };
        const sha = commits.get(e.landingId);
        if (sha) out.trunkSha = sha;
        if (e.intentId) out.intentId = e.intentId;
        return out;
      });
    } catch (err) {
      console.warn(`why-context for intent ${intent.id} failed: ${errorText(err)}`);
      return undefined;
    }
  }

  /**
   * What a change to these paths reaches, and who works on it now (colony/impact.ts): the trunk files that import them,
   * up to three levels (TrunkDO.importerWalk), the live claims on those files from the regions' fields, and the latest
   * landings on them with their intents' whys from the why-context index. Read-only; GET /impact and the MCP tools serve it.
   */
  async impact(paths: Path[], opts: { depth?: number } = {}): Promise<ImpactReport> {
    const colony = this.requireColony();
    try {
      // The why-context index caught up first, as a take does.
      this.backfillLandedIndex();
    } catch (err) {
      console.warn(`impact: why-context index not caught up: ${errorText(err)}`);
    }
    return impactReport(
      {
        colony,
        sql: this.sql,
        importers: (p, o) => this.trunkStub().importerWalk(p, o) as unknown as Promise<ImporterWalk>,
        // Only regions the colony knows are read, so the stub is made without configuring one.
        reading: (region, p) => this.env.REGION.get(this.env.REGION.idFromName(regionKey(colony.id, region))).reading({ paths: p, kinds: ["claim"], claimTimes: true }),
        now: () => Date.now(),
      },
      { paths, depth: opts?.depth },
    );
  }

  /**
   * Intents as Agent2Agent tasks (colony/a2a.ts; api/a2a.ts serves them where FT_A2A covers the colony): one by id, or a
   * page latest update first, each landed one with its landing. Read only.
   */
  async a2aTasks(q: A2AQuery): Promise<A2APage> {
    const colony = this.requireColony();
    return a2aTasks(this.sql, q ?? {}, (id) => {
      const row = this.intentRow(id);
      return row ? this.toIntent(row, colony.id) : null;
    });
  }

  /** Titles and whys of these intents. */
  private intentTexts(ids: Id[]): Map<Id, { title: string; why: string }> {
    const want = [...new Set(ids)].slice(0, 1_000);
    if (want.length === 0) return new Map();
    return new Map(
      this.sql
        .exec<{ id: string; title: string; why: string }>("SELECT id, title, why FROM intents WHERE id IN (SELECT value FROM json_each(?))", JSON.stringify(want))
        .toArray()
        .map((r) => [r.id, { title: r.title, why: r.why }]),
    );
  }

  /**
   * Record which landing (and intent) changed each path. Only the newest WHY_PER_PATH rows of a path
   * are kept, so the index stays the size of the tree however long the colony runs, and still holds
   * the newest landings of any footprint.
   */
  private indexLanded(rows: LandedRow[]): void {
    for (const r of rows.slice(0, LANDED_INDEX_PATHS)) {
      this.sql.exec("INSERT OR IGNORE INTO landing_paths (path, at, landing_id, intent_id) VALUES (?, ?, ?, ?)", r.path, r.at, r.landingId, r.intentId);
      this.sql.exec(
        "DELETE FROM landing_paths WHERE path = ? AND at < (SELECT at FROM landing_paths WHERE path = ? ORDER BY at DESC LIMIT 1 OFFSET ?)",
        r.path,
        r.path,
        WHY_PER_PATH - 1,
      );
    }
  }

  /**
   * Bring the path index up to date before a take reads it: once per object, and again after a landing
   * found it behind. An index with no rows while the colony has landings (a colony that landed work
   * before the index existed) is rebuilt from the landing log, so its takes show why-context at once.
   * One call applies at most LANDED_BACKFILL landings; the next take goes on from there.
   */
  private backfillLandedIndex(): void {
    if (this.landedIndexReady) return;
    const index = this.landedIndex();
    if (this.sql.exec("SELECT 1 AS x FROM landing_paths LIMIT 1").toArray().length === 0 && this.sql.exec("SELECT 1 AS x FROM landings LIMIT 1").toArray().length > 0) {
      index.rebuild(LANDED_INDEX);
    }
    let r = index.catchUp(LANDED_INDEX, { landings: LANDED_BACKFILL });
    // A new version was just forgotten: build it now.
    if (r.rebuilt) r = index.catchUp(LANDED_INDEX, { landings: LANDED_BACKFILL });
    // A log that cannot be read is not retried on every take: the next landing that finds the index behind asks again.
    this.landedIndexReady = r.behind === 0 || r.error !== undefined;
  }

  /**
   * The landing path index as a derived index (trunk/derived.ts) of the colony's landing log: eager,
   * so each landing is applied as it arrives (landed); a version change, or an empty index while
   * landings remain, rebuilds it from the log (the newest LANDINGS_KEEP landings). Idempotent per
   * landing (rows keyed by path, time and landing). A new set per call: it keeps no state of its own,
   * and making it creates its cursor table again after destroy() erased the storage.
   */
  private landedIndex(): DerivedSet<ColonyLanding> {
    return new DerivedSet<ColonyLanding>(
      this.sql,
      (fn) => this.ctx.storage.transactionSync(fn),
      this.landingLog(),
      [
        {
          name: LANDED_INDEX,
          version: 1,
          mode: "eager",
          apply: (e) => this.indexLanded(e.landing.rows ?? this.landedRows(e.landing.landing, e.landing.at)),
          reset: () => {
            this.sql.exec("DELETE FROM landing_paths");
            return 0;
          },
          // An index kept before cursors existed was filled as landings arrived.
          adopt: (base) => base,
        },
      ],
      { label: () => this.loadColony()?.colony.id ?? null },
    );
  }

  /** The colony's landing log for its derived indexes: the landings table in arrival order (rowid). */
  private landingLog(): LandingLog<ColonyLanding> {
    const n = (query: string, ...bindings: unknown[]): number => this.sql.exec<{ n: number }>(query, ...bindings).one().n;
    return {
      after: (seq, limit) =>
        this.sql
          .exec<{ seq: number; id: string; at: number; trunk_sha: string; data: string }>("SELECT rowid AS seq, id, at, trunk_sha, data FROM landings WHERE rowid > ? ORDER BY rowid LIMIT ?", seq, Math.max(1, limit))
          .toArray()
          .map((r) => {
            const landing = recordedLanding({ id: r.id, data: r.data, at: r.at, trunk_sha: r.trunk_sha });
            return { seq: r.seq, landing: { landing, at: landing.at } };
          }),
      head: () => n("SELECT COALESCE(MAX(rowid), 0) AS n FROM landings"),
      before: (seq) => n("SELECT COALESCE(MAX(rowid), 0) AS n FROM landings WHERE rowid < ?", seq),
      count: (after) => n("SELECT COUNT(*) AS n FROM landings WHERE rowid > ?", after),
    };
  }

  /**
   * One landing's rows of the path index: each path it changed (its own list, else what its proposals
   * wrote) with the intent of the proposal that wrote it, or the landing's only intent.
   */
  private landedRows(l: Landing, at: number, writers = this.landingWriters(l), paths?: Path[]): LandedRow[] {
    const byPath = new Map(writers.map((w) => [w.path, w.intentId]));
    // A commit whose proposals this colony does not know: its one intent, if it names one.
    const single = (l.intentIds ?? []).length === 1 ? (l.intentIds[0] ?? null) : null;
    const list = paths ?? normalizePaths(Array.isArray(l.paths) && l.paths.length > 0 ? l.paths : writers.map((w) => w.path));
    return list.map((path) => ({ path, at, landingId: l.id, intentId: byPath.get(path) ?? single }));
  }

  /**
   * After a landing (onLanding): index which intent changed each path (why-context at take), and tell
   * the agents still working on those files, other than the landing's own authors (landing notices,
   * built and delivered in the background). Never throws: a landing never fails over it.
   */
  private landed(l: Landing, paths: Path[], now: number): void {
    try {
      const writers = this.landingWriters(l);
      const byPath = new Map(writers.map((w) => [w.path, w.intentId]));
      // A commit whose proposals this colony does not know: its one intent, if it names one.
      const single = (l.intentIds ?? []).length === 1 ? (l.intentIds[0] ?? null) : null;
      const at = typeof l.at === "number" && Number.isFinite(l.at) ? l.at : now;
      // The path index applies the landing now (its derived hook); left behind, the next take catches it up in order.
      const rows = this.landedRows(l, at, writers, paths);
      const seq = this.sql.exec<{ seq: number }>("SELECT rowid AS seq FROM landings WHERE id = ?", l.id).toArray()[0]?.seq;
      if (seq === undefined) this.indexLanded(rows);
      else if (this.landedIndex().landed({ seq, landing: { landing: l, at, rows } }).length > 0) this.landedIndexReady = false;
      const recipients = this.noticeRecipients(paths, new Set(writers.map((w) => w.agentId)), now);
      if (recipients.length > 0) {
        this.ctx.waitUntil(this.sendLandingNotices(l, recipients, byPath, single).catch((err) => console.warn(`landing notices for ${l.id} not sent: ${errorText(err)}`)));
      }
    } catch (err) {
      console.warn(`landing ${l.id}: why-context index and notices skipped: ${errorText(err)}`);
    }
  }

  /** Who wrote each path of a landing: the intent and agent of the landed proposal that wrote it. */
  private landingWriters(l: Landing): Array<{ path: Path; intentId: Id; agentId: Id }> {
    const ids = (l.proposalIds ?? []).slice(0, 1_000);
    if (ids.length === 0) return [];
    return this.sql
      .exec<{ path: string | null; intent_id: string; agent_id: string }>(
        `SELECT json_extract(w.value, '$.path') AS path, p.intent_id AS intent_id, p.agent_id AS agent_id
           FROM proposals p JOIN json_each(p.data, '$.writeSet') w
          WHERE p.id IN (SELECT value FROM json_each(?))`,
        JSON.stringify(ids),
      )
      .toArray()
      .flatMap((r) => (r.path ? [{ path: r.path, intentId: r.intent_id, agentId: r.agent_id }] : []));
  }

  /**
   * The agents a landing concerns: those still working on an intent (claimed, or proposed and in
   * flight) whose footprint covers a landed path, other than its authors. An agent's claims sit on the
   * footprint of the intents it holds, so the footprint stands for them. Synthetic agents are load and
   * are not told. One entry per agent, named after its current intent, at most MAX_LANDING_NOTICES.
   */
  private noticeRecipients(paths: Path[], authors: ReadonlySet<Id>, now: number): NoticeRecipient[] {
    if (paths.length === 0) return [];
    const out = new Map<Id, NoticeRecipient>();
    for (const { ref, paths: covered } of coveringFootprints(this.heldFootprints(now), paths)) {
      if (authors.has(ref.agentId) || ref.kind === "synthetic") continue;
      const prev = out.get(ref.agentId);
      if (prev) {
        if (ref.current) prev.intentId = ref.intentId;
        prev.paths = [...new Set([...prev.paths, ...covered])].sort();
      } else if (out.size < MAX_LANDING_NOTICES) {
        out.set(ref.agentId, { agentId: ref.agentId, kind: ref.kind, intentId: ref.intentId, paths: covered });
      }
    }
    return [...out.values()];
  }

  /** The footprints of the intents agents hold, indexed for landing notices (see heldFootprints). */
  private heldIndex: { at: number; index: FootprintIndex<HeldRef> } | null = null;

  /**
   * The footprints of the intents agents hold (claimed, or proposed and in flight), indexed by path.
   * Rebuilt from one scan of the held intents at most every HELD_INDEX_MS, however many landings
   * arrive meanwhile: at scale the colony gets dozens a second. An intent taken since the last
   * rebuild can miss a notice; the lane still checks its change against trunk.
   */
  private heldFootprints(now: number): FootprintIndex<HeldRef> {
    if (this.heldIndex && now - this.heldIndex.at < HELD_INDEX_MS) return this.heldIndex.index;
    const rows = this.sql
      .exec<{ id: string; footprint: string; agent_id: string; kind: string; current: string | null }>(
        `SELECT i.id AS id, i.footprint AS footprint, i.assigned_to AS agent_id, a.kind AS kind, a.intent_id AS current
           FROM intents i JOIN agents a ON a.id = i.assigned_to
          WHERE i.status IN ('claimed', 'proposed') AND i.created_by != 'vaccine' AND a.state != 'dead'`,
      )
      .toArray();
    const index = footprintIndex(rows.map((r) => ({ footprint: this.footprintOf(r.id, r.footprint), ref: { intentId: r.id, agentId: r.agent_id, kind: r.kind, current: r.current === r.id } })));
    this.heldIndex = { at: now, index };
    return index;
  }

  /**
   * Build and deliver landing notices: each changed path with its blob before and after the landing
   * (one trunk read of both commits for the whole landing), and the intent that changed the
   * recipient's files with its why. Facts only. Pushed to in-platform agents, left in the inbox of
   * external ones, and published as `directive` events of kind landing.
   */
  private async sendLandingNotices(l: Landing, recipients: NoticeRecipient[], writers: ReadonlyMap<Path, Id>, single: Id | null): Promise<void> {
    // Without both commits the blobs before and after cannot be stated.
    if (!l.parentSha || !l.trunkSha) return;
    const paths = [...new Set(recipients.flatMap((r) => r.paths.slice(0, NOTICE_PATHS)))];
    const trunk = this.trunkStub();
    const [before, after] = await Promise.all([trunk.baseBlobs(l.parentSha, paths), trunk.baseBlobs(l.trunkSha, paths)]);
    const was = new Map((before as FileVersion[]).map((f) => [f.path, f.blob ?? null]));
    const is = new Map((after as FileVersion[]).map((f) => [f.path, f.blob ?? null]));
    const texts = this.intentTexts([...writers.values(), ...(single ? [single] : [])]);
    const now = Date.now();
    const notices: Notice[] = [];
    // A landing with merged files (text merge) can leave a file it names as it was (the change was already on trunk): no news.
    const merged = Array.isArray(l.merged) && l.merged.length > 0;
    for (const r of recipients) {
      const shown = r.paths.slice(0, NOTICE_PATHS).filter((path) => !merged || (was.get(path) ?? null) !== (is.get(path) ?? null));
      if (shown.length === 0) continue;
      // The intent that changed most of this agent's files names the notice.
      const count = new Map<Id, number>();
      for (const p of shown) {
        const w = writers.get(p) ?? single;
        if (w) count.set(w, (count.get(w) ?? 0) + 1);
      }
      const writer = [...count].sort((a, b) => b[1] - a[1])[0]?.[0];
      const t = writer ? texts.get(writer) : undefined;
      const notice: LandingNotice = {
        landingId: l.id,
        trunkSha: l.trunkSha,
        paths: shown.map((path) => ({ path, before: was.get(path) ?? null, after: is.get(path) ?? null })),
        intentTitle: shortTitle(t?.title),
        why: shortWhy(t?.why, NOTICE_WHY_CHARS),
      };
      notices.push({ directive: this.insertLandingNotice(r.agentId, r.intentId, notice, now), kind: r.kind });
    }
    this.publish(
      notices.map(
        (n): ColonyEvent => ({ t: "directive", at: now, directiveId: n.directive.id, agentId: n.directive.agentId, ...(n.directive.intentId ? { intentId: n.directive.intentId } : {}), message: n.directive.message, by: n.directive.by, kind: "landing", ...(n.directive.landing ? { landingId: n.directive.landing.landingId, paths: n.directive.landing.paths.map((p) => p.path) } : {}) }),
      ),
    );
    this.noticesSincePrune += notices.length;
    if (this.noticesSincePrune >= NOTICE_PRUNE_EVERY) {
      this.noticesSincePrune = 0;
      this.sql.exec("DELETE FROM directives WHERE kind = 'landing' AND at < ?", now - NOTICE_KEEP_MS);
    }
    await this.deliver(notices);
  }

  /** Store a landing notice for one agent: a directive of kind landing, about the intent it works on. */
  private insertLandingNotice(agentId: Id, intentId: Id, notice: LandingNotice, at: number): Directive {
    const d: Directive = { id: newId("dir_"), colonyId: this.requireColony().id, agentId, kind: "landing", intentId, message: landingMessage(notice), by: "colony", at, landing: notice };
    this.sql.exec(
      "INSERT INTO directives (id, agent_id, kind, intent_id, message, by, at, revision, changed, delivered_at, via, landing) VALUES (?, ?, 'landing', ?, ?, 'colony', ?, NULL, NULL, NULL, NULL, ?)",
      d.id,
      agentId,
      intentId,
      d.message,
      at,
      JSON.stringify(notice),
    );
    return d;
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
    // Megafile alarm (colony/megafile.ts, FT_MEGAFILE): changes that went back colliding on a script file count toward its alarm.
    this.megafiles().returned(list);
    // Conflict resolver (colony/resolver.ts): a change its agent wrote that settled finishes its resolution.
    this.resolver().settled(list);
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
  // Conflict resolver (colony/resolver.ts, FT_RESOLVER)
  // =========================================================================

  /** The conflict resolver, on this colony's tables (made on first use; its tables exist from the constructor on). */
  private resolverRun: Resolver | null = null;

  /** The resolver with this colony as its host: the reads, writes and calls it makes go through here. */
  private resolver(): Resolver {
    return (this.resolverRun ??= new Resolver({
      sql: this.sql,
      env: () => this.env,
      colonyId: () => this.requireColony().id,
      now: () => Date.now(),
      waitUntil: (p) => this.ctx.waitUntil(p),
      limiter: () => this.decider().limiter,
      // The client agents use, with each call's tokens counted per model for the colony's spend (colony/spend.ts).
      // Hedged calls (FT_HEDGE, colony/hedge.ts): the copy goes to the same model, through the decide limiter.
      model: () => {
        const hedge = hedgeFor(this.env, this.requireColony().id, "resolver", { admit: (m) => this.decider().limiter.acquire(m, 0), bump: (name, delta) => void this.bump(name, delta, Date.now()) });
        // Spend cap (colony/spendcap.ts): the call reserved against the cap (twice with a hedge); a refused one fails the resolution.
        return cappedClient(resolverClient(this.env, (name, delta) => void this.bump(name, delta, Date.now()), hedge), localGate(this.spendCaps(), "resolver", (m) => modelOfClass(this.env, m)), hedge ? 2 : 1);
      },
      // An in-platform agent named "resolver", registered on first use (synchronously: a return is being settled).
      agent: (known, model) => {
        const now = Date.now();
        if (known && this.agentRow(known)) {
          this.sql.exec("UPDATE agents SET last_seen = ?, state = CASE WHEN state = 'dead' THEN 'idle' ELSE state END WHERE id = ?", now, known);
          return known;
        }
        const id = newId("agt_");
        this.sql.exec(
          "INSERT INTO agents (id, kind, name, model, thresholds, state, intent_id, workspace, last_seen, created_at) VALUES (?, 'internal', ?, ?, '{}', 'idle', NULL, NULL, ?, ?)",
          id,
          RESOLVER_AGENT,
          model,
          now,
          now,
        );
        this.bump("agents", 1, now);
        this.publish({ t: "agent", at: now, agentId: id, kind: "internal", state: "idle" });
        return id;
      },
      intent: (id) => {
        const row = this.intentRow(id);
        return row ? { title: row.title, why: row.why, status: row.status, assignedTo: row.assigned_to, contest: row.contest ?? null } : null;
      },
      hold: (intentId, agentId, events) => {
        const now = Date.now();
        this.sql.exec("UPDATE intents SET status = 'proposed', assigned_to = ?, updated_at = ? WHERE id = ?", agentId, now, intentId);
        this.sql.exec("UPDATE agents SET state = 'working', intent_id = ?, last_seen = ? WHERE id = ?", intentId, now, agentId);
        events.push({ t: "agent", at: now, agentId, kind: "internal", state: "working", intentId });
      },
      release: (intentId, agentId) => {
        const now = Date.now();
        if (this.sql.exec("UPDATE agents SET state = 'idle', intent_id = NULL WHERE id = ? AND intent_id = ? RETURNING id", agentId, intentId).toArray().length > 0) {
          this.publish({ t: "agent", at: now, agentId, kind: "internal", state: "idle" });
        }
        const row = this.intentRow(intentId);
        if (!row) return null;
        if ((row.status !== "proposed" && row.status !== "claimed") || row.assigned_to !== agentId) return row.status;
        this.sql.exec("UPDATE intents SET status = 'open', assigned_to = NULL, updated_at = ? WHERE id = ?", now, intentId);
        this.publish({ t: "intent", at: now, intentId, status: "open", title: row.title, footprint: this.footprintOf(row.id, row.footprint) });
        return "open";
      },
      proposal: (id) => this.getProposalSync(id),
      inlineContents: (id) => this.inline().get(id),
      trunkSha: () => this.requireColony().trunkSha,
      trunk: () => this.trunkStub() as unknown as ResolverTrunk,
      // The landings that changed these paths after the base commit landed, from the why-context path index.
      landedSince: (paths, baseSha) => {
        this.backfillLandedIndex();
        const base = this.sql.exec<{ id: string; at: number }>("SELECT id, at FROM landings WHERE trunk_sha = ? LIMIT 1", baseSha).toArray()[0];
        return paths.slice(0, 8).flatMap((path) =>
          this.sql
            .exec<LandedIndexRow>("SELECT path, at, landing_id, intent_id FROM landing_paths WHERE path = ? AND at >= ? AND landing_id != ? ORDER BY at DESC LIMIT ?", path, base?.at ?? 0, base?.id ?? "", WHY_PER_PATH)
            .toArray()
            .map((r) => ({ path: r.path, landingId: r.landing_id, intentId: r.intent_id })),
        );
      },
      propose: (input) => this.propose(input),
      notice: (agentId, intentId, message) => {
        const now = Date.now();
        const d = this.insertDirective({ agentId, kind: "resolution", intentId, message: oneLine(message, MAX_DIRECTIVE_CHARS), by: "resolver", at: now });
        return { t: "directive", at: now, directiveId: d.id, agentId, intentId, message: d.message, by: d.by, kind: "resolution" };
      },
      publish: (events) => void this.publish(events),
      bump: (name) => void this.bump(name, 1, Date.now()),
    }));
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
    // What beat a returned change (colony/movedby.ts): the web's intent and review cards show it.
    if (p.status === "returned" && Array.isArray(p.movedBy) && p.movedBy.length > 0) proposalEvent.movedBy = p.movedBy;
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
        // Contest mode: a ready change for a contest intent waits for its contest instead of its lane.
        if (p.status === "ready" && !this.contestHold(p, now)) fx.enqueue.push({ proposal: p, region, priority });
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
        // Conflict resolver (FT_RESOLVER, colony/resolver.ts): a change back for overlapping hunks that the resolver takes
        // on keeps its intent, held for the resolver, instead of reopening it; everything else of the return happens.
        const resolving = p.status === "returned" && this.resolver().hold(p, intent ?? null, fx.events);
        if (!resolving && intent && (intent.status === "proposed" || intent.status === "claimed") && (intent.assigned_to === p.agentId || intent.assigned_to === null)) {
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

  /** Set while onLanding settles a landed proposal that missed a substantive amendment (landIntent reads it). */
  private landingMissed: MissedRevision | null = null;

  /**
   * Mark an intent landed: its need is met and its rule has one fewer open violation file. When the
   * change that landed was built on an older revision than a later substantive amendment
   * (landingMissed), the intent stays live at its current revision instead (keepRevised). A withdrawn
   * intent shows landed when its change landed first (the trunk writer's cycle had read the old
   * direction); the withdrawal's answer names that landing (the direction fence).
   */
  private landIntent(intentId: Id, now: number, fx: Effects): void {
    const row = this.intentRow(intentId);
    if (!row || row.status === "landed") return;
    const missed = this.landingMissed?.intentId === intentId ? this.landingMissed : null;
    if (missed && row.status !== "withdrawn") {
      this.keepRevised(row, missed, now, fx);
      return;
    }
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

  /**
   * What a change that is landing missed: its intent was amended substantively after the revision
   * the change was built on (its `intentRevision`, else its recorded direction). Null when it still
   * fits; withdrawn and landed intents are not judged.
   */
  private missedRevision(p: Proposal): MissedRevision | null {
    const row = this.intentRow(p.intentId);
    const current = row?.revision ?? 1;
    if (!row || current <= 1 || row.status === "landed" || row.status === "withdrawn") return null;
    const built = typeof p.intentRevision === "number" ? p.intentRevision : (p.evidence?.direction?.intentRevision ?? null);
    const missed = missedRevisions({ ...(built !== null ? { intentRevision: built } : {}), createdAt: p.createdAt }, current, this.revisionRows(row.id).map(toRevision));
    if (missed.length === 0) return null;
    return { intentId: row.id, agentId: p.agentId, built, current, changed: unionChanged(missed), text: landedStaleText(built, current) };
  }

  /**
   * A change built on an older revision landed after a person amended its intent (it was already in
   * the trunk writer's cycle). The change stays landed and the intent stays live at its current
   * revision: a holder still working on it, or a newer change for it in flight, keeps it; otherwise
   * it goes back to open for the next taker. Its needs stay. An event and the intent's history (a
   * revision notice to the agent whose change landed, read in its inbox) say what is left to do.
   */
  private keepRevised(row: IntentRow, missed: MissedRevision, now: number, fx: Effects): void {
    const holder = row.assigned_to ? this.agentRow(row.assigned_to) : undefined;
    const held = (row.status === "claimed" || row.status === "proposed") && holder?.intent_id === row.id;
    const inFlight = row.status === "proposed" && this.inFlightFor([row.id]).length > 0;
    if (!held && !inFlight && row.status !== "open") {
      this.sql.exec("UPDATE intents SET status = 'open', assigned_to = NULL, updated_at = ? WHERE id = ?", now, row.id);
      fx.events.push({ t: "intent", at: now, intentId: row.id, status: "open", title: row.title, footprint: this.footprintOf(row.id, row.footprint) });
    }
    const d = this.insertDirective({ agentId: missed.agentId, kind: "revision", intentId: row.id, message: missed.text, by: "colony", at: now, revision: missed.current, changed: missed.changed });
    fx.events.push({ t: "directive", at: now, directiveId: d.id, agentId: d.agentId, intentId: row.id, message: d.message, by: d.by });
    console.log(`intent ${row.id}: ${missed.text}`);
  }

  /** Antibody refreshes run one at a time, so the last one always reads the newest trunk. */
  private antibodyRefresh: Promise<void> = Promise.resolve();

  /**
   * Antibody files in trunk are authoritative. When a landing (a person approved it: .firetrident/
   * is governance) or a revert changes .firetrident/antibodies/<id>.json, the colony reloads that
   * antibody's definition (matcher, question, threshold, allowances) and keeps its counters and
   * state. A file that is gone, or no longer parses, retires its antibody (off, the row kept), and
   * a retired antibody whose file comes back gets the state it had. The antibody's own mint commit
   * changes nothing. Never throws: a trunk read that fails leaves the antibodies as they were.
   */
  private refreshAntibodies(l: Landing): Promise<void> {
    const prefix = `${ANTIBODY_DIR}/`;
    const paths = [...new Set((l.paths ?? []).filter((p) => p.startsWith(prefix) && p.endsWith(".json") && !p.slice(prefix.length).includes("/")))];
    if (paths.length === 0) return Promise.resolve();
    const run = this.antibodyRefresh.then(() => this.refreshAntibodiesNow(l, paths));
    this.antibodyRefresh = run.catch(() => undefined);
    return run;
  }

  /** See refreshAntibodies: reads each changed antibody file on trunk as it is now, loads first, then retires. */
  private async refreshAntibodiesNow(l: Landing, paths: Path[]): Promise<void> {
    const prefix = `${ANTIBODY_DIR}/`;
    try {
      const colonyId = this.requireColony().id;
      const store = this.decider().store;
      // The antibodies a path holds: by the trunk path recorded for them, else by the id in the file name.
      const at = (path: Path) => (s: StoredAntibody) => s.path === path || (s.path === null && s.antibody.id === path.slice(prefix.length, -".json".length));
      const minted = store.antibodies().filter((s) => s.landingId === l.id);
      const todo = paths.filter((path) => !minted.some(at(path)));
      if (todo.length === 0) return;
      const trunk = this.trunkStub();
      const blobs = await trunk.blobsFor(todo);
      const found: Array<{ path: Path; ab: Antibody | null; why: string }> = [];
      for (const path of todo) {
        if (!blobs[path]) {
          found.push({ path, ab: null, why: `${path} deleted by ${l.id}` });
          continue;
        }
        const text = await trunk.readFile(path);
        if (text === null) {
          console.warn(`antibody file ${path} unreadable after ${l.id}; its antibodies are left as they were`);
          continue;
        }
        const ab = parseAntibodyFile(text, colonyId);
        found.push({ path, ab, why: `${path} no longer holds an antibody after ${l.id}` });
      }
      const now = Date.now();
      let changed = 0;
      const loaded = new Set<Id>();
      for (const f of found) {
        if (!f.ab) continue;
        changed += this.loadAntibody(store, f.ab, f.path, l.id);
        loaded.add(f.ab.id);
      }
      for (const f of found) {
        for (const s of store.antibodies().filter(at(f.path))) if (!loaded.has(s.antibody.id)) changed += this.retireAntibody(store, s, l.id, f.why, now);
      }
      if (changed > 0) {
        const active = store.antibodies().filter((a) => a.state !== "off").length;
        this.setMetric("antibodies.active", active, now);
        this.publish({ t: "metric", at: now, name: "antibodies.active", value: active });
      }
    } catch (err) {
      console.warn(`antibody refresh after ${l.id} failed: ${errorText(err)}`);
    }
  }

  /** Retire an antibody whose file is gone (off, row kept, the state it had remembered). 1 when that changed it. */
  private retireAntibody(store: DecideStore, s: StoredAntibody, landingId: Id, why: string, now: number): number {
    const data = s.antibody as AntibodyRecord;
    if (s.state === "off" && data.retired) return 0;
    const retired: AntibodyRecord = { ...data, retired: { state: s.state, landingId, at: now, reason: why } };
    store.putAntibody(retired, "off");
    console.log(`antibody ${s.antibody.id} retired: ${why}`);
    return 1;
  }

  /**
   * Load an antibody from its trunk file: an unknown one starts active, a known one takes the file's
   * definition and keeps its counters and state, a retired one gets back the state it had. 1 when
   * that changed it.
   */
  private loadAntibody(store: DecideStore, ab: Antibody, path: Path, landingId: Id): number {
    const s = store.antibody(ab.id);
    if (!s) {
      store.putAntibody(ab, "active", { path, landingId });
      console.log(`antibody ${ab.id} loaded from ${path} (${landingId})`);
      return 1;
    }
    const prev = s.antibody as AntibodyRecord;
    const next: Antibody = { ...ab, hits: prev.hits, falsePositives: prev.falsePositives };
    const definition = (x: Antibody) => JSON.stringify([x.origin, x.matcher.paths, x.matcher.pattern ?? null, x.question, x.threshold, x.createdFrom ?? null, antibodyAllows(x)]);
    if (!prev.retired && s.path === path && definition(prev) === definition(next)) return 0;
    store.putAntibody(next, prev.retired ? prev.retired.state : s.state, { path });
    console.log(`antibody ${ab.id} ${prev.retired ? "restored" : "reloaded"} from ${path} (${landingId})`);
    return 1;
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
    // Contest mode: held changes, and contestants that gave back, died or came back, move their contests on.
    this.contestWake();
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
      const source: IntentSource = d.source === "rule" || d.source === "agent" || d.source === "certify" || d.source === "system" ? d.source : "human";
      // An agent's intent takes at most the priority of a parent it holds or declared, else 1; what it asked is kept (priority.ts).
      const granted = grantPriority(d.priority, source, source === "agent" && d.parentId ? this.intentRow(d.parentId) : null, d.createdBy || "unknown");
      const { priority } = granted;
      const seats = contestSeats(d.contest);
      if (seats === null) throw ftError(400, "contest must be 2 to 4 agents (1 or absent: one holder)");
      return { d, footprint, title, source, priority, granted, seats };
    });
    const batch = new FieldBatch(colony.regionDepth);
    const events: ColonyEvent[] = [];
    const out: Intent[] = [];
    const declared: Array<{ doneAt: number | null }> = [];
    for (const { d, footprint, title, source, priority, granted, seats } of prepared) {
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
      if (granted.requestedPriority !== undefined) intent.requestedPriority = granted.requestedPriority;
      if (granted.priorityCap !== undefined) intent.priorityCap = granted.priorityCap;
      // Intent chains (FT_INTENT_CHAIN_GATE, colony/chain.ts): read before the row exists, so the declaring agent's earlier
      // intents are counted without this one.
      const hold = this.chainHold(intent, now);
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
      if (granted.requestedPriority !== undefined) this.recordRequestedPriority(intent.id, granted.requestedPriority, granted.priorityCap ?? null);
      // An intent the gate holds waits for a person as an open report, as a reported intent does, before any agent can take it.
      if (hold) {
        this.sql.exec("UPDATE intents SET escalation = ?, escalation_open = 1 WHERE id = ?", JSON.stringify(hold), intent.id);
        this.sql.exec("INSERT OR REPLACE INTO intent_escalations (intent_id, at, agent_id, kind, report, resolved) VALUES (?, ?, ?, ?, ?, NULL)", intent.id, now, hold.by, hold.kind, hold.report);
        intent.escalation = hold;
        events.push({ t: "escalation", at: now, intentId: intent.id, agentId: hold.by, kind: hold.kind, report: hold.report, title });
      }
      if (seats >= CONTEST_MIN) this.contestRecord(intent, seats, now);
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

  /** Keep what an agent asked for when the cap lowered its priority (priority.ts). Best effort: the intent stands at the cap either way. */
  private recordRequestedPriority(id: Id, requested: number, cap: string | null): void {
    try {
      this.sql.exec("UPDATE intents SET requested_priority = ?, priority_cap = ? WHERE id = ?", requested, cap, id);
    } catch (err) {
      console.warn(`requested priority of intent ${id} not kept: ${errorText(err)}`);
    }
  }

  private assertProposable(row: IntentRow, agentId: Id): void {
    if (row.status === "withdrawn") throw ftError(409, withdrawnError(row.id, row.withdrawn_reason ?? null));
    if (row.status === "landed" || row.status === "abandoned") throw ftError(409, `intent ${row.id} is already ${row.status}`);
    // Contest mode: every contestant holding a seat may propose.
    if (row.assigned_to && row.assigned_to !== agentId && (row.status === "claimed" || row.status === "proposed") && !this.contestProposable(row, agentId)) {
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
    // An inline change's contents stay in their own table, never in the row; they go once it settles (InlineContents.settle).
    const row = p.contents === undefined ? p : { ...p, contents: undefined };
    this.sql.exec("UPDATE proposals SET status = ?, updated_at = ?, data = ? WHERE id = ?", p.status, now, JSON.stringify(row), p.id);
    if ((p.status === "landed" || p.status === "returned" || p.status === "rejected") && isInlineChange(p)) this.inline().settle(p.id, p.status, now);
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
    const escalation = r.escalation ? parseEscalation(r.escalation) : null;
    if (escalation) intent.escalation = escalation;
    if (typeof r.contest === "number" && r.contest >= CONTEST_MIN) intent.contest = r.contest;
    const requested = requestedPriorityOf(r.requested_priority, r.priority);
    if (requested !== undefined) intent.requestedPriority = requested;
    const cap = requested !== undefined ? priorityCapOf(r.priority_cap) : undefined;
    if (cap) intent.priorityCap = cap;
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

  /**
   * A workspace lease for the intent, unless asynchronous publishing would start its agent on a stale base: when a landing
   * recorded after the published head changed a file the intent covers, the take waits (`wait` says why) and tries again
   * in PUBLISH_WAIT_RETRY_MS, by when the trunk writer has usually published it. Otherwise the lease, as before.
   */
  private async leaseFresh(agentId: Id, intent: Intent): Promise<{ lease: WorkspaceLease | null; wait?: string }> {
    const base = await this.leaseBase();
    const pending = this.unpublishedPaths(base);
    const hit = pending ? intent.footprint.find((entry) => footprintTouches(entry, pending)) : undefined;
    if (hit !== undefined) return { lease: null, wait: `waiting for the trunk writer to publish a landing that changed ${hit}` };
    return { lease: await this.poolStub().lease(agentId, base) };
  }

  /**
   * With asynchronous publishing, the paths changed by landings recorded after `publishedSha` (the colony's own landing
   * records, walked from its trunk head back to that commit through parent links). Null when publishing is synchronous,
   * nothing is waiting, or the walk does not reach the published head within UNPUBLISHED_WALK landings: a take then
   * leases as before. The commits between two heads never change, so the answer serves every take until a head moves;
   * when only the colony's head moved, the landings since the last answer are walked and their paths added.
   */
  private unpublishedPaths(publishedSha: Sha): Set<Path> | null {
    const colony = this.requireColony();
    if (!asyncPublishEnabled(this.env.FT_ASYNC_PUBLISH, colony.id) || colony.trunkSha === publishedSha) return null;
    const memo = this.unpublishedMemo;
    if (memo && memo.published === publishedSha) {
      if (memo.trunk === colony.trunkSha) return memo.paths;
      const added = memo.paths ? this.walkUnpublished(colony.trunkSha, memo.trunk) : null;
      if (memo.paths && added) {
        for (const p of added) memo.paths.add(p);
        memo.trunk = colony.trunkSha;
        return memo.paths;
      }
    }
    const paths = this.walkUnpublished(colony.trunkSha, publishedSha);
    this.unpublishedMemo = { trunk: colony.trunkSha, published: publishedSha, paths };
    return paths;
  }

  /**
   * The paths changed by the landings from `head` back to `published` through parent links, one indexed lookup a landing.
   * Null when a landing on the way is not recorded here or the walk passes UNPUBLISHED_WALK landings.
   */
  private walkUnpublished(head: Sha, published: Sha): Set<Path> | null {
    const paths = new Set<Path>();
    let at: Sha | undefined = head;
    for (let i = 0; at !== undefined && at !== published && i < UNPUBLISHED_WALK; i++) {
      const row: { data: string } | undefined = this.sql.exec<{ data: string }>("SELECT data FROM landings WHERE trunk_sha = ? LIMIT 1", at).toArray()[0];
      const l: Landing | null = row ? parseJson<Landing | null>(row.data, null) : null;
      if (!l) return null;
      for (const p of Array.isArray(l.paths) ? l.paths : []) paths.add(p);
      at = l.parentSha;
    }
    return at === published ? paths : null;
  }

  /**
   * The trunk commit a lease starts from: agents clone or read the trunk repository at it. With asynchronous publishing
   * (FT_ASYNC_PUBLISH) the colony's trunk head (its newest landing) can be recorded but not pushed yet, so leases get
   * the trunk writer's published head instead, asked at most every LEASE_BASE_TTL_MS (the last answer serves while a
   * newer one is on its way). Off, the colony's trunk head, as before.
   */
  private async leaseBase(): Promise<Sha> {
    const colony = this.requireColony();
    if (!asyncPublishEnabled(this.env.FT_ASYNC_PUBLISH, colony.id)) return colony.trunkSha;
    const cached = this.publishedBase;
    if (cached && Date.now() - cached.at < LEASE_BASE_TTL_MS) return cached.sha;
    if (this.publishedRead === null) {
      const read: Promise<void> = this.readPublishedBase().finally(() => {
        if (this.publishedRead === read) this.publishedRead = null;
      });
      this.publishedRead = read;
    }
    if (cached) {
      this.publishedRead.catch((err: unknown) => console.warn(`lease base not refreshed: ${errorText(err)}`));
      return cached.sha;
    }
    await this.publishedRead;
    if (!this.publishedBase) throw new Error("the trunk writer did not name its published head");
    return this.publishedBase.sha;
  }

  /**
   * Ask the trunk writer for its published head (leaseBase). A trunk writer still on code without publishState (deploys
   * reach objects gradually) pushes every landing before it is reported, so the colony's trunk head is published there.
   */
  private async readPublishedBase(): Promise<void> {
    try {
      const s = (await this.trunkStub().publishState()) as TrunkPublish;
      if (typeof s?.publishedSha === "string" && /^[0-9a-f]{40}$/.test(s.publishedSha)) this.publishedBase = { sha: s.publishedSha, at: Date.now() };
    } catch (err) {
      if (!/RPC receiver does not implement the method/i.test(errorText(err))) throw err;
      this.publishedBase = { sha: this.requireColony().trunkSha, at: Date.now() };
    }
  }

  private poolStub() {
    return this.env.POOL.get(this.env.POOL.idFromName(this.requireColony().id));
  }
}
