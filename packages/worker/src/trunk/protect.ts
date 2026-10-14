/**
 * The trunk writer's copy of its colony's protected globs (colony/protect.ts ProtectRecord), kept the way the direction
 * fence keeps changes of direction (trunk/direction.ts): the colony records it with TrunkDO.protect when its protected
 * globs change, and every landing cycle reads it once before it builds (protectReturns). That read is the commit point:
 * a change that writes a path protected after a person last approved it (or that no person approved) goes back to a
 * person, with a reason the lane turns into an escalation. Lanes also pass the record they read with their lineage
 * context; a newer one than the writer's own (the colony's call did not reach it) is kept and used, so the record only
 * moves forward.
 */
import type { Id, Proposal } from "@fire_trident/core";
import type { SqlRunner } from "../colony/inline.ts";
import { humanApproval, newerProtect, parseProtectRecord, protectHits, protectReason, type DecisionLike, type ProtectRecord } from "../colony/protect.ts";

/** The trunk writer's record: one row, `record` a ProtectRecord as JSON. */
export const PROTECT_TABLE = "CREATE TABLE IF NOT EXISTS ft_protected (k TEXT PRIMARY KEY, record TEXT NOT NULL, at INTEGER NOT NULL)";

/** The writer's stored record; undefined when it has none or cannot read it. */
export function storedProtect(sql: SqlRunner): ProtectRecord | undefined {
  const row = sql.exec("SELECT record FROM ft_protected WHERE k = 'record'").toArray()[0] as { record?: unknown } | undefined;
  return parseProtectRecord(row?.record);
}

/** Keep `record` when it is one and newer than the stored record. Returns the record in force afterwards. */
export function keepProtect(sql: SqlRunner, record: unknown, now: number): ProtectRecord | undefined {
  const prev = storedProtect(sql);
  const next = parseProtectRecord(record);
  const kept = newerProtect(prev, next);
  if (kept && kept !== prev) sql.exec("INSERT OR REPLACE INTO ft_protected (k, record, at) VALUES ('record', ?, ?)", JSON.stringify(kept), now);
  return kept;
}

/**
 * The lineage context fields the protection check reads: TrunkDO's LandContext as lanes pass it, with the record
 * ColonyDO.landContext adds as `protect` (LandContext does not name it; it is read here as data and checked).
 */
export interface ProtectContext {
  protect?: unknown;
  decisions?: Record<Id, ReadonlyArray<DecisionLike>>;
}

/**
 * The reason each change goes back at the protection check, by proposal id, against `record`: a change that writes a
 * path the record protects and that no person approved since that path was protected (its decisions, as the lane
 * passed them). Pure.
 */
export function protectionReturns(record: ProtectRecord | undefined, items: ReadonlyArray<{ p: Proposal; ctx: ProtectContext | undefined }>): Map<Id, string> {
  const out = new Map<Id, string>();
  if (!record || record.globs.length === 0) return out;
  for (const { p, ctx } of items) {
    if (out.has(p.id)) continue;
    const hits = protectHits(p, record, humanApproval(ctx?.decisions?.[p.id]));
    if (hits.length > 0) out.set(p.id, protectReason(hits));
  }
  return out;
}

/** The record a cycle checks against: the newest of the writer's own and those its lanes passed (each request's `protect`). */
export function cycleProtect(stored: ProtectRecord | undefined, ctxs: ReadonlyArray<ProtectContext | undefined>): ProtectRecord | undefined {
  let out = stored;
  // A cycle's changes share their batch's context: each one is read once.
  for (const c of new Set(ctxs)) out = newerProtect(out, parseProtectRecord(c?.protect));
  return out;
}

/**
 * One cycle's protection check: one read of the stored record, the newest record a lane passed kept in its place, and
 * the reason each change goes back (protectionReturns). A read or write that fails is logged and stops nothing, as before
 * the check existed (the colony and the lanes still check).
 */
export function protectReturns(sql: SqlRunner, items: ReadonlyArray<{ p: Proposal; ctx: ProtectContext | undefined }>, now: number): Map<Id, string> {
  if (items.length === 0) return new Map();
  try {
    const stored = storedProtect(sql);
    const record = cycleProtect(stored, items.map((i) => i.ctx));
    if (record && record !== stored) keepProtect(sql, record, now);
    return protectionReturns(record, items);
  } catch (e) {
    console.error(`protection check skipped in this cycle: ${e instanceof Error ? e.message : String(e)}`);
    return new Map();
  }
}
