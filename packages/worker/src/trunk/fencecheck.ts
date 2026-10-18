/**
 * The direction fence's per-cycle check, failing closed (trunk/direction.ts holds the record and the rule).
 *
 * Every landing cycle reads the fence's record of intents withdrawn or amended once, before it builds: that read is the
 * commit point of a change of direction. When the read fails, or an intent's row cannot be parsed, the cycle cannot
 * tell whether a person changed course, so the changes it could not judge are held: deferred to the next cycle, neither
 * landed nor sent back, with a reason saying why. Their lane keeps them without counting a failed landing attempt and
 * offers them again after FENCE_RECHECK_MS, so landing resumes with the first cycle whose read succeeds; a lasting
 * failure holds them in their lanes rather than landing work a person may have withdrawn.
 *
 * Counted: a cycle that held changes says how many in its stats (`directionUnchecked`) and its live feed
 * (FENCE_HELD_EVENT), and the colony keeps the running count in its metrics (FENCE_HELD_METRIC, GET /metrics).
 *
 * The protected-path check at the same commit point (trunk/protect.ts protectCheck) holds the same way when it cannot
 * read the colony's protected globs, with its own reason (protectHeldReason) and counts (`protectUnchecked`,
 * PROTECT_HELD_EVENT, PROTECT_HELD_METRIC); lanes treat both holds alike (isFenceHeld).
 */
import type { ColonyEvent, Id, Proposal } from "@fire_trident/core";
import type { DirectionInfo } from "../colony/direction.ts";
import type { SqlRunner } from "../colony/inline.ts";
import { directionReturns, parseDirection } from "./direction.ts";
import type { LandResult } from "./plan.ts";

/** The per-cycle metric event of a cycle that held changes (the value is how many), on the colony's live feed. */
export const FENCE_HELD_EVENT = "trunk.directionUnchecked";
/** The colony's running count of changes held that way, in GET /api/colonies/:id/metrics. */
export const FENCE_HELD_METRIC = "direction.unchecked";
/** The same two for changes the protected-path check held (trunk/protect.ts). */
export const PROTECT_HELD_EVENT = "trunk.protectUnchecked";
export const PROTECT_HELD_METRIC = "protect.unchecked";
/** How long a lane waits before it offers held changes to the trunk writer again (ms). */
export const FENCE_RECHECK_MS = 1_000;

/** Intents per IN (...) list. */
const CHUNK = 500;
/** How every held change's reason starts (isFenceHeld): the direction check's, and the protected-path check's. */
const HELD = "waiting for the next landing cycle: the direction check could not read";
const PROTECT_HELD = "waiting for the next landing cycle: the protected-path check could not read";

/** What one cycle's check found: the changes that go back (stale direction), and the ones held for the next cycle. */
export interface FenceCheck {
  returned: Map<Id, string>;
  held: Map<Id, string>;
  /** Why changes were held, for the log line; null when none were. */
  problem: string | null;
}

/** The reason a held change carries: what could not be read, and that it lands once the check runs. */
export function fenceHeldReason(detail: string): string {
  return `${HELD} whether this change's intent was withdrawn or amended (${detail}), so the change was neither landed nor sent back; it lands once the check can run`;
}

/** The reason a change the protected-path check could not check carries: it goes to a person instead of landing if it writes a protected path. */
export function protectHeldReason(detail: string): string {
  return `${PROTECT_HELD} the colony's protected paths (${detail}), so the change was neither landed nor sent to a person; once the check can run it lands, or goes to a person if it writes a protected path`;
}

/** Whether a deferral's reason is a commit-point check (the direction fence, or the protected-path check) holding a change it could not check. */
export function isFenceHeld(reason: unknown): boolean {
  return typeof reason === "string" && (reason.startsWith(HELD) || reason.startsWith(PROTECT_HELD));
}

function message(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").trim().slice(0, 300);
}

/**
 * One cycle's direction check from the writer's record (`ft_direction`): the changes whose intent was withdrawn or
 * amended after the revision they were built on go back (directionReturns); the ones it could not judge are held. A
 * change that already landed (`landed`) is neither.
 */
export function fenceCheck(sql: SqlRunner, proposals: ReadonlyArray<Pick<Proposal, "id" | "intentId" | "intentRevision" | "createdAt">>, landed: ReadonlySet<Id> = new Set()): FenceCheck {
  const none: FenceCheck = { returned: new Map(), held: new Map(), problem: null };
  const open = proposals.filter((p) => !landed.has(p.id));
  if (open.length === 0) return none;
  const direction = new Map<Id, DirectionInfo>();
  const unreadable = new Set<Id>();
  try {
    const intents = [...new Set(open.map((p) => p.intentId))];
    for (let i = 0; i < intents.length; i += CHUNK) {
      const rows = sql.exec("SELECT intent_id, info FROM ft_direction WHERE intent_id IN (SELECT value FROM json_each(?))", JSON.stringify(intents.slice(i, i + CHUNK))).toArray() as Array<{ intent_id: string; info: unknown }>;
      for (const r of rows) {
        const info = parseDirection(r.info);
        if (info) direction.set(r.intent_id, info);
        else unreadable.add(r.intent_id);
      }
    }
  } catch (e) {
    const detail = message(e);
    return { returned: new Map(), held: new Map(open.map((p) => [p.id, fenceHeldReason(detail)])), problem: `the record could not be read: ${detail}` };
  }
  const returned = directionReturns(open, direction, landed);
  const held = new Map<Id, string>();
  for (const p of open) {
    if (!returned.has(p.id) && unreadable.has(p.intentId)) held.set(p.id, fenceHeldReason(`the record of intent ${p.intentId} cannot be parsed`));
  }
  return { returned, held, problem: held.size > 0 ? `the record of ${unreadable.size} intent${unreadable.size === 1 ? "" : "s"} cannot be parsed` : null };
}

/** The changes of a landing answer the fence held (its deferrals with the fence's reason), by proposal id. */
export function fenceHeldIds(result: Pick<LandResult, "deferred"> | null | undefined): Set<Id> {
  const out = new Set<Id>();
  for (const d of Array.isArray(result?.deferred) ? result.deferred : []) if (d && typeof d.proposalId === "string" && isFenceHeld(d.reason)) out.add(d.proposalId);
  return out;
}

/** The colony's counter deltas for the events a trunk writer emitted: the changes its cycles held (FENCE_HELD_METRIC, PROTECT_HELD_METRIC). */
export function fenceHeldBumps(events: readonly ColonyEvent[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  const metrics: Record<string, string> = { [FENCE_HELD_EVENT]: FENCE_HELD_METRIC, [PROTECT_HELD_EVENT]: PROTECT_HELD_METRIC };
  for (const e of events) {
    if (e?.t !== "metric" || !Object.hasOwn(metrics, e.name) || typeof e.value !== "number" || !Number.isFinite(e.value) || e.value <= 0) continue;
    const name = metrics[e.name]!;
    counts.set(name, (counts.get(name) ?? 0) + Math.floor(e.value));
  }
  return [...counts].filter(([, n]) => n > 0);
}
