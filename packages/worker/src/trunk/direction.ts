/**
 * The direction fence, the pure part: the trunk writer's record of each intent's latest change of
 * direction (a withdrawal or a substantive amendment), the check every landing cycle runs against it,
 * and what the fence answers about the changes that were in flight.
 *
 * Why: the lane checks direction just before it hands a batch to the trunk writer, but a batch can wait
 * for a cycle, and a cycle runs for a while before its push commits. A person who withdrew or amended an
 * intent in that window was told its change went back while it landed. The trunk writer now reads the
 * record once per cycle, before it builds anything: that read is the commit point. A change of direction
 * recorded before it stops the change; one recorded after it finds the change landing, and the fence
 * (TrunkDO.direction) waits for that cycle and names the landing.
 */
import type { Id, IntentField, IntentStatus, LandedChange, Landing, Proposal } from "@fire_trident/core";
import { staleDirection, type DirectionInfo } from "../colony/direction.ts";

/** The trunk writer's direction record: one row per intent whose direction changed, `info` a DirectionInfo as JSON. */
export const DIRECTION_TABLE = "CREATE TABLE IF NOT EXISTS ft_direction (intent_id TEXT PRIMARY KEY, info TEXT, at INTEGER)";

/** How long the fence waits for the cycles that read an intent's old direction before it answers anyway. */
export const FENCE_WAIT_MS = 15_000;

/** How long the colony waits for the fence's answer (its wait, a journal recovery, the call itself). */
export const FENCE_ANSWER_MS = FENCE_WAIT_MS + 5_000;

/** What the fence answers (TrunkDO.direction). */
export interface FenceAnswer {
  /** Each change asked about that landed, with its landing. */
  landed: LandedChange[];
  /** Those landings, each once, for the colony to settle (onLanding is idempotent per landing). */
  landings: Landing[];
  /** Changes asked about that a cycle may still land: the wait ran out, or a push outcome is unknown. Every other one never lands. */
  undetermined: Id[];
}

const STATUSES: ReadonlySet<string> = new Set<IntentStatus>(["open", "claimed", "proposed", "landed", "abandoned", "withdrawn"]);
const FIELDS: ReadonlySet<string> = new Set<IntentField>(["title", "why", "footprint", "priority"]);

/** A stored or received direction (an object or its JSON), checked: malformed fields and revisions are dropped. Undefined when it is not one. */
export function parseDirection(x: unknown): DirectionInfo | undefined {
  let o = x;
  if (typeof x === "string") {
    try {
      o = JSON.parse(x);
    } catch {
      return undefined;
    }
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) return undefined;
  const r = o as Record<string, unknown>;
  const out: DirectionInfo = {};
  if (typeof r.status === "string" && STATUSES.has(r.status)) out.status = r.status as IntentStatus;
  if (typeof r.revision === "number" && Number.isInteger(r.revision) && r.revision >= 1) out.revision = r.revision;
  if (typeof r.withdrawnReason === "string") out.withdrawnReason = r.withdrawnReason;
  if (Array.isArray(r.revisions)) {
    out.revisions = r.revisions.flatMap((v) => {
      const e = v as Record<string, unknown> | null;
      if (!e || typeof e !== "object" || typeof e.revision !== "number" || typeof e.at !== "number") return [];
      const changed = (Array.isArray(e.changed) ? e.changed : []).filter((f): f is IntentField => typeof f === "string" && FIELDS.has(f));
      return [{ revision: e.revision, changed, reason: typeof e.reason === "string" ? e.reason : "", at: e.at }];
    });
  }
  return out;
}

/**
 * The record once a new direction arrives. A withdrawal is final, so it stays; otherwise the higher
 * revision wins (a tie goes to the newer). Calls may arrive out of order; the record only moves forward.
 */
export function mergeDirection(prev: DirectionInfo | undefined, next: DirectionInfo): DirectionInfo {
  if (!prev) return next;
  if (prev.status === "withdrawn" && next.status !== "withdrawn") return prev;
  if (next.status === "withdrawn") return next;
  return (next.revision ?? 1) >= (prev.revision ?? 1) ? next : prev;
}

/**
 * One cycle's direction check: the reason each change goes back, by proposal id. A change goes back when
 * its intent was withdrawn, or amended substantively after the revision it was built on (staleDirection).
 * A priority-only amendment, and an intent with no record, let it through. A change that already landed
 * (`landed`) is never judged: it stays landed.
 */
export function directionReturns(
  proposals: ReadonlyArray<Pick<Proposal, "id" | "intentId" | "intentRevision" | "createdAt">>,
  direction: ReadonlyMap<Id, DirectionInfo>,
  landed: ReadonlySet<Id> = new Set(),
): Map<Id, string> {
  const out = new Map<Id, string>();
  if (direction.size === 0) return out;
  for (const p of proposals) {
    if (landed.has(p.id) || out.has(p.id)) continue;
    const reason = staleDirection(p, direction.get(p.intentId));
    if (reason) out.set(p.id, reason);
  }
  return out;
}

/**
 * The fence's answer for the changes asked about (`ids`), from the landing records (`landings`, by
 * proposal id) once the cycles that may have read the old direction are over. `settled` is false when the
 * wait ran out: every change that has not landed is then undetermined. `open` holds the changes of pushes
 * whose outcome is still unknown (null when that cannot be read: every change not landed is undetermined).
 */
export function fenceAnswer(ids: readonly Id[], landings: ReadonlyMap<Id, Landing>, settled: boolean, open: ReadonlySet<Id> | null): FenceAnswer {
  const landed: LandedChange[] = [];
  const byId = new Map<Id, Landing>();
  const undetermined: Id[] = [];
  for (const id of new Set(ids)) {
    const l = landings.get(id);
    if (l) {
      landed.push({ proposalId: id, landingId: l.id, trunkSha: l.trunkSha });
      byId.set(l.id, l);
    } else if (!settled || open === null || open.has(id)) {
      undetermined.push(id);
    }
  }
  return { landed, landings: [...byId.values()], undetermined };
}

/** Whether `p` settles within `ms` (its value or error is not looked at; the timer is cleared either way). */
export async function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), Math.max(0, ms));
  });
  try {
    const done = p.then(
      () => true,
      () => true,
    );
    return await Promise.race([done, late]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The test hook FT_TEST_PUSH_DELAY_MS (previews only): milliseconds a landing cycle sleeps before its push, 0 when unset or invalid, at most 60 s. */
export function pushDelayMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 60_000) : 0;
}
