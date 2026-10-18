import type { AgentInfo, AgentState, Colony, ColonySeries, ColonySnapshot, Id, Millis, Sha } from "@fire_trident/core";

/**
 * Metrics, per-minute series, the colony registry, and agent listings: the
 * shapes ColonyDO serves to the UI, the CLI and GET /api/colonies, plus the
 * pure helpers behind them. No I/O here.
 */

/** Width of one series bucket (one minute). */
export const BUCKET_MS = 60_000;
/** Buckets a snapshot series covers: the last 30 minutes, the current one included. */
export const SERIES_BUCKETS = 30;
/** Per-minute rows kept per series name. */
export const SERIES_KEEP_MINUTES = 6 * 60;

/** Counter metrics that also keep a per-minute series (bumped through ColonyDO.bump). */
export const COUNTER_SERIES: ReadonlySet<string> = new Set(["landings", "proposals", "landedProposals", "returned", "rejected", "escalated", "takes", "intents", "landedIntents"]);
/** Gauge series: the last value recorded in each minute. */
export const GAUGE_SERIES: ReadonlySet<string> = new Set(["violations"]);

export type { ColonySeries } from "@fire_trident/core";

/** The snapshot as served: the core contract plus the per-minute series. */
export interface SnapshotWithSeries extends ColonySnapshot {
  series: ColonySeries;
}

/** Metrics every snapshot carries, zero until something happens, so the UI sees a stable map. */
export const METRIC_KEYS: readonly string[] = [
  "agents",
  "agentsActive",
  "agentsWorking",
  "agentsIdle",
  "agentsWaiting",
  "agentsDead",
  "intents",
  "intentsOpen",
  "intentsClaimed",
  "intentsProposed",
  "intentsLanded",
  "intentsAbandoned",
  "takes",
  "proposals",
  "proposalsInFlight",
  "reviewQueue",
  "landedProposals",
  // Already on trunk (FT_ALREADY_ON_TRUNK): changes closed with no commit, their content on trunk; neither landed nor returned.
  "alreadyOnTrunk",
  "returned",
  "rejected",
  "escalated",
  "landings",
  "landingsPerMin",
  "landedIntents",
  "violations",
  "rules",
  "regions",
  "decisions",
  "funnel.proof",
  "funnel.reflex",
  "funnel.llm",
  "funnel.human",
];

/** Metrics the live hub re-broadcasts while sockets are connected (they change without an event of their own). */
export const LIVE_METRICS: readonly string[] = [
  "agentsActive",
  "agentsWorking",
  "landingsPerMin",
  "proposalsInFlight",
  "reviewQueue",
  "intentsOpen",
  "intentsClaimed",
  "intentsProposed",
];

/** The minute (bucket number) holding time `at`. */
export function minuteOf(at: Millis): number {
  return Math.floor(at / BUCKET_MS);
}

/** Start time of the first bucket of a series ending at `endMinute`. */
export function seriesStart(endMinute: number, buckets = SERIES_BUCKETS): Millis {
  return (endMinute - buckets + 1) * BUCKET_MS;
}

/** Per-bucket sums for the `buckets` minutes ending at `endMinute` (inclusive), from sparse rows. */
export function counterBuckets(rows: Iterable<{ minute: number; value: number }>, endMinute: number, buckets = SERIES_BUCKETS): number[] {
  const out = new Array<number>(buckets).fill(0);
  const first = endMinute - buckets + 1;
  for (const r of rows) {
    const i = r.minute - first;
    if (i < 0 || i >= buckets || !Number.isFinite(r.value)) continue;
    out[i] = (out[i] ?? 0) + r.value;
  }
  return out;
}

/**
 * A gauge per bucket: each bucket holds the last sample at or before its minute.
 * Buckets before the first sample in the window hold `before` (the last sample
 * older than the window), or 0 when there is none. With no samples at all, the
 * line is flat at `current`. The final bucket is always `current`.
 */
export function gaugeBuckets(rows: Iterable<{ minute: number; value: number }>, endMinute: number, before: number | null, current: number, buckets = SERIES_BUCKETS): number[] {
  const first = endMinute - buckets + 1;
  const at = new Map<number, number>();
  for (const r of rows) {
    if (r.minute >= first && r.minute <= endMinute && Number.isFinite(r.value)) at.set(r.minute, r.value);
  }
  if (at.size === 0 && before === null) return new Array<number>(buckets).fill(current);
  const out: number[] = [];
  let last = before ?? 0;
  for (let i = 0; i < buckets; i++) {
    const v = at.get(first + i);
    if (v !== undefined) last = v;
    out.push(last);
  }
  if (buckets > 0) out[buckets - 1] = current;
  return out;
}

/** Every key of METRIC_KEYS (0 when missing or not finite) followed by any other finite metric, sorted. */
export function stableMetrics(values: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of METRIC_KEYS) {
    const v = values[k];
    out[k] = typeof v === "number" && Number.isFinite(v) ? v : 0;
  }
  for (const k of Object.keys(values).sort()) {
    const v = values[k];
    if (!Object.hasOwn(out, k) && typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/**
 * The metric events worth sending now: values that changed since `sent`, or every
 * live metric when `full`. Updates `sent` with what it returns.
 */
export function changedMetrics(current: Record<string, number>, sent: Map<string, number>, full: boolean): Array<{ name: string; value: number }> {
  const out: Array<{ name: string; value: number }> = [];
  for (const name of LIVE_METRICS) {
    const value = current[name];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    if (!full && sent.get(name) === value) continue;
    sent.set(name, value);
    out.push({ name, value });
  }
  return out;
}

/**
 * A call already in flight when an agent is stopped may still touch its last-seen time;
 * a stop counts until the agent is seen this long after it.
 */
export const STOP_GRACE_MS = 2_000;

/** An agent stopped since it was last seen (within STOP_GRACE_MS) counts as dead, whatever its last recorded state. */
export function effectiveState(state: AgentState, lastSeen: Millis, stoppedAt: Millis | null | undefined): AgentState {
  return typeof stoppedAt === "number" && stoppedAt + STOP_GRACE_MS >= lastSeen ? "dead" : state;
}

/** Agent counters by state, plus the active (not dead) and working (working or proposing) totals. */
export function agentCounters(byState: Partial<Record<AgentState, number>>): Record<string, number> {
  const n = (s: AgentState) => byState[s] ?? 0;
  const total = n("idle") + n("working") + n("proposing") + n("waiting") + n("dead");
  return {
    agents: total,
    agentsActive: total - n("dead"),
    agentsWorking: n("working") + n("proposing"),
    agentsIdle: n("idle"),
    agentsWaiting: n("waiting"),
    agentsDead: n("dead"),
  };
}

// ---------------------------------------------------------------------------
// Registry and listings
// ---------------------------------------------------------------------------

/** Name of the ColonyDO instance that holds the colony registry (never a valid colony slug). */
export const REGISTRY_NAME = "__registry__";

/** One colony as the registry records it. */
export interface RegistryEntry {
  id: Id;
  name: string;
  source?: { url: string; branch: string };
  createdAt: Millis;
  registeredAt: Millis;
}

/** A colony's identity and live counters: cheap enough to fan out across every colony. */
export interface ColonySummary {
  id: Id;
  name: string;
  source?: { url: string; branch: string };
  createdAt: Millis;
  trunkSha: Sha;
  greenSha?: Sha;
  regionDepth: number;
  /** Time of the latest landing, or null before the first. */
  lastLandingAt: Millis | null;
  counters: Record<string, number>;
}

/** Summary of a colony record (counters filled by the caller). */
export function summaryOf(colony: Colony, lastLandingAt: number, counters: Record<string, number>): ColonySummary {
  const out: ColonySummary = {
    id: colony.id,
    name: colony.name,
    createdAt: colony.createdAt,
    trunkSha: colony.trunkSha,
    regionDepth: colony.regionDepth,
    lastLandingAt: lastLandingAt > 0 ? lastLandingAt : null,
    counters,
  };
  if (colony.source) out.source = colony.source;
  if (colony.greenSha) out.greenSha = colony.greenSha;
  return out;
}

/** One agent in GET /api/colonies/:id/agents: the colony's view, plus the agent's own journal for in-platform agents. */
export interface AgentListEntry extends AgentInfo {
  createdAt: Millis;
  intentTitle?: string;
  /** When the agent was stopped through the API (it stays dead until it is seen again). */
  stoppedAt?: Millis;
  stopReason?: string;
  /** Journal fields, present for in-platform agents whose object answered. */
  running?: boolean;
  step?: string;
  attempts?: number;
  proposalId?: Id;
  lastError?: string;
  counters?: Record<string, number>;
  /** Why the journal is missing (object unreachable or not an in-platform agent). */
  journalError?: string;
}

/** True for agents that run inside the platform (an AgentDO per agent). */
export function inPlatform(kind: string): boolean {
  return kind === "internal" || kind === "synthetic";
}
