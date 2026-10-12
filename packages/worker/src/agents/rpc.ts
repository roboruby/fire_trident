import { regionKey } from "@fire_trident/core";
import type {
  AgentInfo,
  AgentKind,
  Colony,
  ColonySnapshot,
  Evidence,
  FieldReading,
  Id,
  Intent,
  Landing,
  LineageNote,
  Path,
  Proposal,
  ProposalStatus,
  Rule,
  Sha,
  WorkspaceLease,
} from "@fire_trident/core";
import type { Env } from "../env.ts";

/**
 * The RPC surfaces the agents and the MCP server call, typed from the contracts in
 * docs/ARCHITECTURE.md. Typing the stubs here (instead of through the DO classes)
 * keeps this stream independent of the other streams' progress and lets tests
 * substitute plain objects.
 */

/** What ColonyDO.take returns: work plus a workspace lease, or a hint to come back later. */
export type TakeResult = { intent: Intent; lease: WorkspaceLease; rule?: Rule } | { wait: true; retryInMs: number; reason: string };

/** Input of ColonyDO.propose. */
export type ProposeInput = Omit<Proposal, "id" | "status" | "createdAt" | "evidence"> & { evidence?: Partial<Evidence> };

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
  heartbeat(agentId: Id): Promise<void>;
  propose(p: ProposeInput): Promise<Proposal>;
  getProposal(id: Id): Promise<Proposal | null>;
  /** An agent's recent proposals, newest first. */
  inbox(agentId: Id, limit?: number): Promise<Proposal[]>;
  getRule(id: Id): Promise<Rule | null>;
  /** Give back every intent the agent holds as claimed: it reopens, claims clear, a failure mark is left. */
  abandon(agentId: Id, reason?: string): Promise<void>;
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
