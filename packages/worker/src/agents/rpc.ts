import { regionKey } from "@fire_trident/core";
import type {
  AgentInfo,
  AgentKind,
  Colony,
  ColonySnapshot,
  Directive,
  EscalationKind,
  Evidence,
  FieldReading,
  GuideTake,
  Id,
  Intent,
  IntentEscalation,
  Landing,
  LessonReceipt,
  LineageNote,
  Path,
  Proposal,
  ProposalStatus,
  Rule,
  Sha,
  WorkspaceLease,
} from "@fire_trident/core";
import type { Env } from "../env.ts";
import type { LandedWhy } from "./landed.ts";
import type { ReviewPreview } from "./preview.ts";

/**
 * The RPC surfaces the agents and the MCP server call, typed from the contracts in
 * docs/ARCHITECTURE.md. Typing the stubs here (instead of through the DO classes)
 * keeps this stream independent of the other streams' progress and lets tests
 * substitute plain objects.
 */

/**
 * What ColonyDO.take returns: work plus a workspace lease, or a hint to come back later. `review`
 * is what review will ask of the change (agents/preview.ts); `context` the latest landings that
 * changed the intent's files, with their intents' whys (agents/landed.ts); `guide`, where the field
 * guide is on, the newest lessons agents recorded (core/guide.ts). A colony on the previous
 * version sends none of them.
 */
export type TakeResult = { intent: Intent; lease: WorkspaceLease; rule?: Rule; review?: ReviewPreview; context?: LandedWhy[]; guide?: GuideTake } | { wait: true; retryInMs: number; reason: string };

/** Input of ColonyDO.propose. */
export type ProposeInput = Omit<Proposal, "id" | "status" | "createdAt" | "evidence"> & {
  evidence?: Partial<Evidence>;
  /** Push the outcome to this agent's AgentDO (AgentDO.outcome) instead of making it poll. */
  notify?: boolean;
  /** One surprising fact the agent learned, for the colony's field guide (FT_FIELD_GUIDE; ignored where it is off). */
  lesson?: string;
};

/** ColonyDO methods used by agents, the swarm, and the MCP server. */
export interface ColonyRpc {
  getColony(): Promise<Colony | null>;
  snapshot(): Promise<ColonySnapshot>;
  addIntent(i: Omit<Intent, "id" | "status" | "createdAt">): Promise<Intent>;
  registerAgent(a: { kind: AgentKind; name: string; model?: string }): Promise<AgentInfo>;
  registerAgents(list: Array<{ kind: AgentKind; name: string; model?: string }>): Promise<AgentInfo[]>;
  getAgent(agentId: Id): Promise<AgentInfo | null>;
  /** Idempotent for an agent that already holds an assignment (returns it again). */
  take(agentId: Id): Promise<TakeResult>;
  /** Liveness and claim refresh; `{ claims: false }` when the agent refreshes its claims in the regions itself. */
  heartbeat(agentId: Id, opts?: { claims?: boolean }): Promise<void>;
  /** Where the field guide is on and the input left a lesson, the answer says what became of it (`lesson`). */
  propose(p: ProposeInput): Promise<Proposal & { lesson?: LessonReceipt }>;
  getProposal(id: Id): Promise<Proposal | null>;
  /**
   * An agent's inbox, newest first: its recent proposals and, unless `proposalsOnly`, the directives
   * addressed to it (human guidance, revisions and withdrawals of intents it held). A directive entry
   * carries a proposal entry's id, intentId, status ("directive"), reason (what to do) and createdAt,
   * so a reader that lists proposals shows it too. It is not a Proposal: tell them apart with
   * isInboxDirective (colony/direction.ts). Typed as Proposal[] for those readers.
   */
  inbox(agentId: Id, limit?: number, opts?: { proposalsOnly?: boolean }): Promise<Proposal[]>;
  getRule(id: Id): Promise<Rule | null>;
  /** One intent as it stands now (its current revision). */
  getIntent?(id: Id): Promise<Intent | null>;
  /** Give back every intent the agent holds as claimed: it reopens, claims clear, a failure mark is left. */
  abandon(agentId: Id, reason?: string): Promise<void>;
  /** Take back the agent's own change while it is in flight (a directive changed its course); the agent keeps its intent. */
  recall?(agentId: Id, proposalId: Id, reason?: string): Promise<Proposal>;
  /** The agent's one-line "what I am doing now" (stored on the agent, shown live, recorded with its next proposal). */
  relay?(agentId: Id, note: string): Promise<unknown>;
  /** The human guidance about an intent: an agent that takes it over follows it too. */
  guidance?(intentId: Id): Promise<Array<{ id: Id; message: string; by: string; at: number }>>;
  /**
   * Report that the intent the agent holds cannot be done as written (a wrong test, a contradictory
   * spec, an impossible ask): the intent waits for a person, and the agent's claim and lease are released.
   */
  escalate?(agentId: Id, p: { intentId?: Id; kind: EscalationKind; report: string }): Promise<{ intent: Intent; escalation: IntentEscalation }>;
}

/** RegionDO methods used for sensing. */
export interface RegionRpc {
  reading(opts?: { excludeAgentId?: Id; paths?: Path[]; agents?: boolean }): Promise<FieldReading>;
}

/** TrunkDO methods used for lineage questions. */
export interface TrunkRpc {
  why(path: Path, line?: number): Promise<Array<{ landing: Landing; note: LineageNote }>>;
}

/** TrunkDO reads an agent uses. */
export interface TrunkBlobsRpc {
  /** Current trunk blob of each path (null when absent). */
  blobsFor(paths: Path[]): Promise<Record<Path, Sha | null>>;
}

/** Parameters of AgentDO.start. */
export interface AgentStartParams {
  colonyId: Id;
  agentId: Id;
  model?: string;
  kind?: AgentKind;
  name?: string;
  /** Delay before the first loop step (the swarm staggers starts with it). */
  delayMs?: number;
}

/** AgentDO methods used by the swarm and the API. */
export interface AgentRpc {
  start(p: AgentStartParams): Promise<unknown>;
  stop(reason?: string): Promise<unknown>;
  status(): Promise<unknown>;
  /** A directive pushed by the colony (guidance, or a revision or withdrawal of an intent the agent holds). */
  direct?(p: { directive: Directive; intent?: Intent }): Promise<unknown>;
}

/** Proposal states after which nothing more happens to a proposal. */
export const TERMINAL_STATUSES: ReadonlySet<ProposalStatus> = new Set<ProposalStatus>(["landed", "returned", "rejected"]);

/** RPC stub of a colony's ColonyDO. */
export function colonyStub(env: Pick<Env, "COLONY">, colonyId: Id): ColonyRpc {
  return env.COLONY.get(env.COLONY.idFromName(colonyId)) as unknown as ColonyRpc;
}

/** RPC stub of one region's RegionDO (`${colonyId}:${region}`). */
export function regionStub(env: Pick<Env, "REGION">, colonyId: Id, region: string): RegionRpc {
  return env.REGION.get(env.REGION.idFromName(regionKey(colonyId, region))) as unknown as RegionRpc;
}

/** RPC stub of a colony's TrunkDO. */
export function trunkStub(env: Pick<Env, "TRUNK">, colonyId: Id): TrunkRpc {
  return env.TRUNK.get(env.TRUNK.idFromName(colonyId)) as unknown as TrunkRpc;
}

/** RPC stub of a colony's TrunkDO for blob reads. */
export function trunkBlobsStub(env: Pick<Env, "TRUNK">, colonyId: Id): TrunkBlobsRpc {
  return env.TRUNK.get(env.TRUNK.idFromName(colonyId)) as unknown as TrunkBlobsRpc;
}

/** RPC stub of an in-platform agent's AgentDO (named by agent id). */
export function agentStub(env: Pick<Env, "AGENT">, agentId: Id): AgentRpc {
  return env.AGENT.get(env.AGENT.idFromName(agentId)) as unknown as AgentRpc;
}

/** The Artifacts binding that serves a namespace (ft-trunk, ft-ws-0..3, ft-sessions), or null. */
export function artifactsFor(env: Pick<Env, "ARTIFACTS" | "WS0" | "WS1" | "WS2" | "WS3" | "SESSIONS">, namespace: string): Artifacts | null {
  switch (namespace) {
    case "ft-trunk":
      return env.ARTIFACTS;
    case "ft-ws-0":
      return env.WS0;
    case "ft-ws-1":
      return env.WS1;
    case "ft-ws-2":
      return env.WS2;
    case "ft-ws-3":
      return env.WS3;
    case "ft-sessions":
      return env.SESSIONS;
    default:
      return null;
  }
}

const STATUS_TAG = /\[ft:(\d{3})\]\s*/;

function rawMessage(err: unknown): string {
  try {
    const raw = err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err);
    return typeof raw === "string" ? raw : String(err);
  } catch {
    return String(err);
  }
}

/** HTTP-like status carried by an error that crossed RPC (`[ft:NNN]` tag), or null. */
export function errorStatus(err: unknown): number | null {
  const m = STATUS_TAG.exec(rawMessage(err));
  return m ? Number(m[1]) : null;
}

/** An error's message without the `[ft:NNN]` tag, cut to `max` characters. Never throws. */
export function errorMessage(err: unknown, max = 400): string {
  const text = rawMessage(err).replace(STATUS_TAG, "").trim() || "error";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** What kind of failure a call met: the `kind` of an error envelope. */
export type ErrorKind = "validation" | "auth" | "not_found" | "conflict" | "too_large" | "rate_limit" | "server" | "unavailable";

/**
 * A failure in a form a program can act on: its kind, the sentence that explains it, whether the same call may
 * succeed later and after how long, the status it carried (`[ft:NNN]`), and the next call when that is clear.
 */
export interface ErrorEnvelope {
  kind: ErrorKind;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
  status?: number;
  next?: string;
}

/** Shortest and longest wait before retrying a platform failure; each envelope picks a time between them. */
export const RETRY_MIN_MS = 1_000;
export const RETRY_MAX_MS = 5_000;
/** Wait before retrying a call that reached an object still on the previous deployment (the API's Retry-After). */
const UPGRADE_RETRY_MS = 30_000;
/** Failures of the platform itself, which carry no status: the same call usually succeeds a moment later. */
const PLATFORM_FAILURE =
  /Durable Object is overloaded|Network connection lost|internal error.*reference|Durable Object reset because|Cannot resolve Durable Object due to transient issue|exceeded timeout which caused object to be reset|code has been updated|exceeded its memory limit and was reset/i;
/** An object still on the previous class lacks a newer method for a while (deploys roll out gradually). */
const UPGRADING = /RPC receiver does not implement the method/i;

function kindOf(status: number): ErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 413) return "too_large";
  if (status === 429) return "rate_limit";
  return status >= 500 ? "server" : "validation";
}

/** True for a failure of the platform (the runtime marks some itself as retryable or overloaded), never for one of ours. */
function platformFailure(err: unknown): boolean {
  const marks = err && typeof err === "object" ? (err as { retryable?: unknown; overloaded?: unknown }) : {};
  return marks.retryable === true || marks.overloaded === true || PLATFORM_FAILURE.test(rawMessage(err));
}

/**
 * The envelope of anything thrown. A `[ft:NNN]` status maps to its kind (400 validation, 401 and 403 auth, 404
 * not_found, 409 conflict, 413 too_large, 429 rate_limit, 5xx server); only rate limits are retryable. An error
 * with no status is a platform failure (an overloaded or reset object, a lost connection, an internal error
 * reference: `unavailable`, retryable after 1 to 5 s, jittered so callers do not retry in step; 30 s for an object
 * still on the previous deployment) or else a `server` failure. `random` picks the jitter (tests inject it).
 * The message is today's sentence without the tag; `next` is left to the caller, which knows its tools.
 */
export function errorEnvelope(err: unknown, random: () => number = Math.random): ErrorEnvelope {
  const message = errorMessage(err);
  const after = (min: number, max: number): number => Math.round(min + Math.min(1, Math.max(0, random())) * (max - min));
  const status = errorStatus(err);
  if (status !== null) {
    const kind = kindOf(status);
    if (kind === "rate_limit") return { kind, message, retryable: true, retryAfterMs: after(RETRY_MIN_MS, RETRY_MAX_MS), status };
    return { kind, message, retryable: false, status };
  }
  if (UPGRADING.test(rawMessage(err))) return { kind: "unavailable", message, retryable: true, retryAfterMs: after(UPGRADE_RETRY_MS, UPGRADE_RETRY_MS + RETRY_MAX_MS) };
  if (platformFailure(err)) return { kind: "unavailable", message, retryable: true, retryAfterMs: after(RETRY_MIN_MS, RETRY_MAX_MS) };
  return { kind: "server", message, retryable: false };
}
