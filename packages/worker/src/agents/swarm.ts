import type { AgentInfo, Id } from "@fire_trident/core";
import type { Env } from "../env.ts";
import { colonyOwnerOf } from "../artifacts/storage.ts";
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
  /**
   * Model id, or "default" / "bulk" (swarms default to the bulk model). A comma-separated
   * list spreads the swarm over several models, whose per-model rate limits add up:
   * "a=5,b,c" gives exactly 5 agents model a and splits the rest between b and c.
   */
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
  /** The model, or "model×count, ..." for a mixed swarm. */
  model: string;
  /** Agents per model. */
  models: Record<string, number>;
  staggerMs: number;
  failed: number;
  errors: string[];
}

/** First-step delay of agent `i` of `n` across a window of `windowMs`. */
export function staggerDelay(i: number, n: number, windowMs: number): number {
  if (n <= 1 || windowMs <= 0) return 0;
  return Math.round((i * windowMs) / n);
}

/**
 * The model of each of `n` agents from a swarm model spec (see SpawnOptions.model):
 * entries with "=count" get exactly that many agents (in order, while agents remain),
 * the rest are split evenly over the entries without a count (or over all entries
 * when every one has a count). Models are interleaved so a staggered start mixes them.
 */
export function assignModels(spec: string | undefined, n: number, resolve: (m: string | undefined) => string): string[] {
  const entries = (spec ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (entries.length <= 1) return Array.from({ length: n }, () => resolve(entries[0]));
  const counted: Array<{ model: string; count: number }> = [];
  const open: string[] = [];
  for (const e of entries) {
    const m = /^(.*?)=(\d+)$/.exec(e);
    if (m) counted.push({ model: resolve(m[1]!.trim()), count: Number(m[2]) });
    else open.push(resolve(e));
  }
  const groups = new Map<string, number>();
  const add = (model: string, k: number): void => {
    groups.set(model, (groups.get(model) ?? 0) + k);
  };
  let left = n;
  for (const c of counted) {
    const k = Math.min(c.count, left);
    add(c.model, k);
    left -= k;
  }
  const spread = open.length > 0 ? open : counted.map((c) => c.model);
  for (let i = 0; left > 0; i++, left--) add(spread[i % spread.length]!, 1);
  const queues = [...groups].filter(([, k]) => k > 0).map(([model, k]) => ({ model, k }));
  const out: string[] = [];
  while (out.length < n) {
    for (const q of queues) {
      if (q.k > 0) {
        out.push(q.model);
        q.k--;
      }
    }
  }
  return out;
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
  const modelOf = assignModels(opts.model, count, (m) => resolveModel(env, m, "bulk"));
  const staggerMs = Math.max(0, Math.min(60_000, Math.floor(opts.staggerMs ?? Math.min(8_000, 250 * count))));
  const prefix = (opts.namePrefix ?? kind).trim().slice(0, 40) || kind;
  const colony = colonyStub(env, colonyId);
  const stamp = Date.now().toString(36).slice(-4);
  // A colony a person owns: its agents read trunk from the owner's Cloudflare account (artifacts/storage.ts).
  const owner = await colonyOwnerOf(env, colonyId);

  const agents: Array<AgentInfo & { assigned: string }> = [];
  const errors: string[] = [];
  for (let i = 0; i < count; i += REGISTER_BATCH) {
    const n = Math.min(REGISTER_BATCH, count - i);
    const list = Array.from({ length: n }, (_, j) => ({ kind, name: `${prefix}-${stamp}-${i + j + 1}`, model: modelOf[i + j]! }));
    try {
      const got = await colony.registerAgents(list);
      got.forEach((a, j) => agents.push({ ...a, assigned: list[j]?.model ?? modelOf[0]! }));
    } catch (e) {
      errors.push(`register: ${errorMessage(e)}`);
      break;
    }
  }

  const results = await inBatches(agents, START_CONCURRENCY, (a, i) =>
    agentStub(env, a.id).start({ colonyId, agentId: a.id, model: a.assigned, kind, name: a.name, delayMs: staggerDelay(i, agents.length, staggerMs), ...(owner ? { owner } : {}) }),
  );
  const agentIds: Id[] = [];
  const models: Record<string, number> = {};
  results.forEach((r, i) => {
    const a = agents[i];
    if (!a) return;
    if (r.status === "fulfilled") {
      agentIds.push(a.id);
      models[a.assigned] = (models[a.assigned] ?? 0) + 1;
    } else if (errors.length < 10) errors.push(`start ${a.id}: ${errorMessage(r.reason)}`);
  });
  const names = Object.keys(models);
  const model = names.length <= 1 ? (names[0] ?? modelOf[0] ?? "") : names.map((m) => `${m}×${models[m]}`).join(", ");
  return { started: agentIds.length, agentIds, kind, model, models, staggerMs, failed: count - agentIds.length, errors };
}

/** Stop agents by id (each gives back a claimed intent). Returns how many stopped. */
export async function stopAgents(env: Env, agentIds: Id[], reason = "stopped by request"): Promise<number> {
  const results = await inBatches(agentIds, START_CONCURRENCY, (id) => agentStub(env, id).stop(reason));
  return results.filter((r) => r.status === "fulfilled").length;
}
