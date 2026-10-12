import type { AgentInfo, Id } from "@fire_trident/core";
import type { Env } from "../env.ts";
import { resolveModel } from "./llm.ts";
import { agentStub, colonyStub, errorMessage } from "./rpc.ts";

/** Most agents one call may spawn. */
export const MAX_SWARM = 1_000;
/** Agents registered per ColonyDO call. */
const REGISTER_BATCH = 100;
/** AgentDO starts in flight at once. */
const START_CONCURRENCY = 50;

/** Options for spawnSwarm. */
export interface SpawnOptions {
  count: number;
  /** "internal" agents edit with a model; "synthetic" agents apply rule replacements (model as fallback). */
  kind?: "internal" | "synthetic";
  /** Model id, or "default" / "bulk". Swarms default to the bulk model. */
  model?: string;
  /** Spread first steps over this window (ms). Default: 250 ms per agent, at most 8 s. */
  staggerMs?: number;
  /** Agent name prefix. */
  namePrefix?: string;
}

/** What spawnSwarm reports. */
export interface SwarmResult {
  started: number;
  agentIds: Id[];
  kind: "internal" | "synthetic";
  model: string;
  staggerMs: number;
  failed: number;
  errors: string[];
}

/** First-step delay of agent `i` of `n` across a window of `windowMs`. */
export function staggerDelay(i: number, n: number, windowMs: number): number {
  if (n <= 1 || windowMs <= 0) return 0;
  return Math.round((i * windowMs) / n);
}

async function inBatches<T, R>(items: T[], size: number, fn: (item: T, index: number) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const out: PromiseSettledResult<R>[] = [];
  for (let i = 0; i < items.length; i += size) {
    const chunk = items.slice(i, i + size);
    out.push(...(await Promise.allSettled(chunk.map((item, j) => fn(item, i + j)))));
  }
  return out;
}

/**
 * Register `count` agents with the colony and start one AgentDO per agent (named by
 * agent id). Starts return immediately; each agent's first step is delayed so the
 * swarm ramps up over a few seconds instead of stampeding take().
 */
export async function spawnSwarm(env: Env, colonyId: Id, opts: SpawnOptions): Promise<SwarmResult> {
  const count = Math.max(1, Math.min(MAX_SWARM, Math.floor(Number(opts.count) || 1)));
  const kind: "internal" | "synthetic" = opts.kind === "synthetic" ? "synthetic" : "internal";
  const model = resolveModel(env, opts.model, "bulk");
  const staggerMs = Math.max(0, Math.min(60_000, Math.floor(opts.staggerMs ?? Math.min(8_000, 250 * count))));
  const prefix = (opts.namePrefix ?? kind).trim().slice(0, 40) || kind;
  const colony = colonyStub(env, colonyId);
  const stamp = Date.now().toString(36).slice(-4);

  const agents: AgentInfo[] = [];
  const errors: string[] = [];
  for (let i = 0; i < count; i += REGISTER_BATCH) {
    const n = Math.min(REGISTER_BATCH, count - i);
    const list = Array.from({ length: n }, (_, j) => ({ kind, name: `${prefix}-${stamp}-${i + j + 1}`, model }));
    try {
      agents.push(...(await colony.registerAgents(list)));
    } catch (e) {
      errors.push(`register: ${errorMessage(e)}`);
      break;
    }
  }

  const results = await inBatches(agents, START_CONCURRENCY, (a, i) =>
    agentStub(env, a.id).start({ colonyId, agentId: a.id, model, kind, name: a.name, delayMs: staggerDelay(i, agents.length, staggerMs) }),
  );
  const agentIds: Id[] = [];
  results.forEach((r, i) => {
    const id = agents[i]?.id;
    if (!id) return;
    if (r.status === "fulfilled") agentIds.push(id);
    else if (errors.length < 10) errors.push(`start ${id}: ${errorMessage(r.reason)}`);
  });
  return { started: agentIds.length, agentIds, kind, model, staggerMs, failed: count - agentIds.length, errors };
}

/** Stop agents by id (each gives back a claimed intent). Returns how many stopped. */
export async function stopAgents(env: Env, agentIds: Id[], reason = "stopped by request"): Promise<number> {
  const results = await inBatches(agentIds, START_CONCURRENCY, (id) => agentStub(env, id).stop(reason));
  return results.filter((r) => r.status === "fulfilled").length;
}
