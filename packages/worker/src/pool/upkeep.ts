import type { Id } from "@fire_trident/core";

/**
 * Upkeep of a workspace pool (PoolDO), on the alarm it already has, so the pool neither leaks workspaces nor keeps
 * growing after a burst:
 * - The lease sweep. The colony releases an agent's workspace when its work ends (ColonyDO.releaseLeases); a release
 *   that fails, or an agent that never comes back, used to leave the slot leased for good. The sweep looks at up to
 *   SWEEP_BATCH leases older than SWEEP_AFTER_MS (longer than the colony waits before it reaps a silent agent), asks the
 *   colony which of their agents still hold a workspace (ColonyDO.leaseHolders: a workspace recorded, or working), and
 *   releases the rest, as their release would have. It is conservative: it frees only what the colony already counts as
 *   released; an agent whose lease call is in flight, or that leased since the sweep asked, is skipped (LeaseGuard); and a
 *   colony that does not answer, or answers with anything but a list, frees nothing.
 * - Release retries. A failed release is tried again RELEASE_RETRY_MS later, twice, asking each time which agents are
 *   still to be released; what still fails is left to the sweep.
 * - The target comes back down. Exhausted leases raise the target (PoolDO.raiseTarget) and nothing lowered it. After
 *   QUIET_MS with no raise, the alarm lowers it toward demand: the leases held now plus a quarter (at least 4), never below
 *   the target the colony was created with (its floor). Only future forks change: no workspace is deleted.
 */

/** Leases at least this old are looked at by the sweep (the colony reaps an agent after ten silent minutes). */
export const SWEEP_AFTER_MS = 15 * 60_000;
/** Leases one sweep looks at, at most. */
export const SWEEP_BATCH = 64;
/** A sweep runs at most this often. */
export const SWEEP_EVERY_MS = 5 * 60_000;
/** How long a sweep waits for the colony's answer before it frees nothing this round. */
export const SWEEP_ASK_MS = 10_000;
/** A pool whose target was not raised for this long lowers it toward demand. */
export const QUIET_MS = 30 * 60_000;
/** The floor of a pool created before the floor was recorded (the API's default target). */
export const LEGACY_FLOOR = 16;
/** Waits before the two retries of a failed release. */
export const RELEASE_RETRY_MS: readonly number[] = [1_000, 5_000];

/**
 * The agents a sweep must not touch: those with a lease call in flight, and those that leased since the sweep began.
 * PoolDO enters and leaves it around every lease; a sweep begins it before it asks the colony and ends it after.
 */
export class LeaseGuard {
  private readonly inFlight = new Map<Id, number>();
  private touched: Set<Id> | null = null;

  /** A lease call for `agentId` starts. */
  enter(agentId: Id): void {
    this.inFlight.set(agentId, (this.inFlight.get(agentId) ?? 0) + 1);
    this.touched?.add(agentId);
  }

  /** That lease call ended. */
  leave(agentId: Id): void {
    const n = (this.inFlight.get(agentId) ?? 0) - 1;
    if (n > 0) this.inFlight.set(agentId, n);
    else this.inFlight.delete(agentId);
  }

  /** A sweep starts: from now on every lease call is remembered until it ends. */
  begin(): void {
    this.touched = new Set();
  }

  /** The sweep ended. */
  end(): void {
    this.touched = null;
  }

  /** Must the sweep leave `agentId` alone? */
  busy(agentId: Id): boolean {
    return this.inFlight.has(agentId) || this.touched?.has(agentId) === true;
  }
}

/** Leased slots older than SWEEP_AFTER_MS, oldest first, at most `limit`. */
export function oldLeases(sql: SqlStorage, now: number, limit = SWEEP_BATCH): Array<{ n: number; agentId: Id }> {
  return sql
    .exec<{ n: number; agent_id: string }>(
      `SELECT n, agent_id FROM ft_pool_ws WHERE state = 'leased' AND agent_id IS NOT NULL AND leased_at IS NOT NULL AND leased_at <= ? ORDER BY leased_at, n LIMIT ?`,
      now - SWEEP_AFTER_MS,
      limit,
    )
    .toArray()
    .map((r) => ({ n: r.n, agentId: r.agent_id }));
}

/** When the oldest lease was made, or null when nothing is leased. */
export function oldestLeaseAt(sql: SqlStorage): number | null {
  const r = sql.exec<{ at: number | null }>(`SELECT MIN(leased_at) AS at FROM ft_pool_ws WHERE state = 'leased' AND agent_id IS NOT NULL`).toArray()[0];
  return typeof r?.at === "number" ? r.at : null;
}

/** When the next sweep should run (ms since epoch), or null when nothing is leased. */
export function nextSweepAt(sql: SqlStorage, lastSweepAt: number): number | null {
  const oldest = oldestLeaseAt(sql);
  if (oldest === null) return null;
  return Math.max(lastSweepAt + SWEEP_EVERY_MS, oldest + SWEEP_AFTER_MS);
}

/** What one sweep did. */
export interface SweepResult {
  /** Old leases looked at. */
  looked: number;
  /** Agents whose leases were released. */
  released: Id[];
  /** Why nothing was released, when the colony did not answer. */
  skipped?: string;
}

/**
 * Release the old leases whose agents the colony no longer counts as holding a workspace (see the module comment).
 * `holders` asks the colony; `release` gives one agent's slots back (SlotBook.release) and says how many.
 */
export async function sweepLeases(p: {
  sql: SqlStorage;
  now: number;
  guard: LeaseGuard;
  holders: (agentIds: Id[]) => Promise<unknown>;
  release: (agentId: Id) => number;
  limit?: number;
  /** How long to wait for the colony (SWEEP_ASK_MS). */
  askMs?: number;
}): Promise<SweepResult> {
  const old = oldLeases(p.sql, p.now, p.limit ?? SWEEP_BATCH);
  const agents = [...new Set(old.map((o) => o.agentId))].filter((id) => !p.guard.busy(id));
  if (agents.length === 0) return { looked: old.length, released: [] };
  p.guard.begin();
  try {
    let answer: unknown;
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const late = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer within ${Math.round((p.askMs ?? SWEEP_ASK_MS) / 1000)} s`)), p.askMs ?? SWEEP_ASK_MS);
      });
      answer = await Promise.race([p.holders(agents), late]);
    } catch (err) {
      return { looked: old.length, released: [], skipped: `the colony did not answer: ${err instanceof Error ? err.message : String(err)}` };
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
    if (!Array.isArray(answer) || !answer.every((x) => typeof x === "string")) return { looked: old.length, released: [], skipped: "the colony's answer was not a list of agents" };
    const holding = new Set(answer as string[]);
    const released: Id[] = [];
    for (const id of agents) {
      if (holding.has(id) || p.guard.busy(id)) continue;
      if (p.release(id) > 0) released.push(id);
    }
    return { looked: old.length, released };
  } finally {
    p.guard.end();
  }
}

/** Of these agents, the ones the colony counts as holding a workspace: one recorded for them, or working (ColonyDO.leaseHolders). */
export function leaseHolders(sql: SqlStorage, agentIds: unknown): Id[] {
  const ids = Array.isArray(agentIds) ? [...new Set(agentIds.filter((x): x is string => typeof x === "string" && x !== ""))].slice(0, SWEEP_BATCH * 4) : [];
  if (ids.length === 0) return [];
  return sql
    .exec<{ id: string }>(`SELECT id FROM agents WHERE id IN (SELECT value FROM json_each(?)) AND (workspace IS NOT NULL OR state = 'working')`, JSON.stringify(ids))
    .toArray()
    .map((r) => r.id);
}

/**
 * The target a quiet pool comes down to, or null to leave it: after QUIET_MS without a raise, the leases held now plus a
 * quarter (at least 4), never below `floor`, and only ever lower than the target it has.
 */
export function shrunkTarget(p: { target: number; floor: number; leased: number; quietSince: number; now: number }): number | null {
  if (p.now - p.quietSince < QUIET_MS) return null;
  const leased = Math.max(0, Math.floor(p.leased));
  const demand = leased + Math.max(4, Math.ceil(leased / 4));
  const next = Math.max(Math.max(0, Math.floor(p.floor)), demand);
  return next < p.target ? next : null;
}

/**
 * Release agents' workspaces with `call` (PoolDO.releaseMany), trying again after each of RELEASE_RETRY_MS when it
 * fails, with `releasable` asked before each try (an agent that leased again meanwhile drops out). "unsupported": the
 * pool is on the previous version (the caller releases one by one); "failed": every try failed (the pool's lease sweep
 * frees them later).
 */
export async function releaseRetried(
  call: (agentIds: Id[]) => Promise<unknown>,
  releasable: () => Id[],
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<"released" | "nothing" | "unsupported" | "failed"> {
  for (let attempt = 0; ; attempt++) {
    const ids = releasable();
    if (ids.length === 0) return "nothing";
    try {
      await call(ids);
      return "released";
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      if (/does not implement/i.test(text)) return "unsupported";
      const wait = RELEASE_RETRY_MS[attempt];
      if (wait === undefined) {
        console.warn(`PoolDO.releaseMany failed ${attempt + 1} times for ${ids.length} agent(s), the pool's lease sweep frees them later: ${text}`);
        return "failed";
      }
      await sleep(wait);
    }
  }
}
