/**
 * How a lane settles one tick against the trunk writer, idempotent per proposal id.
 *
 * A call to `TrunkDO.land` can fail on the lane's side after the trunk writer landed the batch
 * (the trunk object was reset by a deploy mid-call, a network error). The lane then still holds
 * proposals that are on trunk. Re-validated, such a proposal looks stale against its own new
 * blob, and a retried land call used to send it back as "already landed". Both reopened work that
 * had landed. The trunk writer's index of landed proposals (keyed by proposal id) is the source of
 * truth: a proposal it knows as landed is settled as landed, with its landing, and never returned.
 */
import type { FileVersion, HeldMergeFile, Id, Landing, MergeConflict, OccResult, Proposal, Sha } from "@fire_trident/core";
import type { LandResult } from "./plan.ts";

/** What the lane does with one tick's proposals. */
export interface LaneSettlement {
  /** Landings to record and report to the colony, each once (the new one first). */
  landings: Landing[];
  /** Every proposal id those landings carry (settled as landed). */
  landed: Set<Id>;
  /**
   * Proposals that go back to their agents. `stale` is set for lane-side OCC returns; `conflicts` for a trunk writer
   * return whose text merge conflicted (the colony's conflict resolver reads them).
   */
  returned: Array<{ p: Proposal | null; id: Id; reason: string; stale?: OccResult["stale"]; conflicts?: MergeConflict[]; held?: HeldMergeFile[] }>;
  /** Proposals that stay in the lane (neither landed nor returned this tick). */
  keep: Id[];
}

const ALREADY_LANDED = /^already landed in /;

/** True when trunk already holds every blob the proposal writes (absent for deletions): it may have landed. */
export function writesOnTrunk(p: Pick<Proposal, "writeSet">, trunk: (path: string) => Sha | null | undefined): boolean {
  return p.writeSet.length > 0 && p.writeSet.every((w: FileVersion) => (trunk(w.path) ?? null) === (w.blob ?? null));
}

/** Ids worth asking the trunk writer about: every stale proposal, and returns that say "already landed". */
export function suspects(stale: Array<{ p: Proposal }>, result: LandResult | null): Id[] {
  const out = new Set<Id>(stale.map((s) => s.p.id));
  for (const r of result?.returned ?? []) if (ALREADY_LANDED.test(r.reason)) out.add(r.proposalId);
  return [...out];
}

/**
 * Settle a tick. `known` is the trunk writer's answer for `suspects` (proposal id → landing; null
 * when it could not be asked). A proposal that landed (now, earlier, or per `known`) is never
 * returned. A stale proposal whose writes are all on trunk is kept, not returned, when `known`
 * is unavailable: it has probably landed, and the next tick asks again.
 */
export function settleLane(p: {
  batch: Proposal[];
  stale: Array<{ p: Proposal; occ: OccResult; reason: string }>;
  result: LandResult | null;
  known: Record<Id, Landing> | null;
  trunk: (path: string) => Sha | null | undefined;
}): LaneSettlement {
  const landings = new Map<Id, Landing>();
  const add = (l: Landing | undefined): void => {
    if (l && typeof l.id === "string" && !landings.has(l.id)) landings.set(l.id, l);
  };
  add(p.result?.landing);
  for (const l of p.result?.prior ?? []) add(l);
  for (const l of Object.values(p.known ?? {})) add(l);
  const landed = new Set<Id>();
  for (const l of landings.values()) for (const id of l.proposalIds ?? []) landed.add(id);

  const returned: LaneSettlement["returned"] = [];
  const keep = new Set<Id>();
  const gone = new Set<Id>(landed);
  for (const s of p.stale) {
    if (gone.has(s.p.id)) continue;
    if (p.known === null && writesOnTrunk(s.p, p.trunk)) {
      keep.add(s.p.id);
      continue;
    }
    gone.add(s.p.id);
    returned.push({ p: s.p, id: s.p.id, reason: s.reason, stale: s.occ.stale });
  }
  const byId = new Map(p.batch.map((x) => [x.id, x]));
  for (const r of p.result?.returned ?? []) {
    if (gone.has(r.proposalId)) continue;
    if (ALREADY_LANDED.test(r.reason)) {
      // An older trunk writer said "already landed" without the landing: never report that as a return.
      keep.add(r.proposalId);
      continue;
    }
    gone.add(r.proposalId);
    returned.push({
      p: byId.get(r.proposalId) ?? null,
      id: r.proposalId,
      reason: r.reason,
      ...(Array.isArray(r.conflicts) && r.conflicts.length > 0 ? { conflicts: r.conflicts } : {}),
      // Merge locks (trunk/mergelock.ts): the merge held for a person, with its diffs.
      ...(Array.isArray(r.held) && r.held.length > 0 ? { held: r.held } : {}),
    });
  }
  for (const x of p.batch) if (!gone.has(x.id)) keep.add(x.id);
  for (const id of landed) keep.delete(id);
  return { landings: [...landings.values()], landed, returned, keep: [...keep] };
}
