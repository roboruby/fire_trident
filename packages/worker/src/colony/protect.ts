import type { Id, LandedChange, Landing, Path, Proposal } from "@fire_trident/core";
import { protectedHits, type ProtectedHit } from "../decide/signals.ts";
import { FENCE_ANSWER_MS, type FenceAnswer } from "../trunk/direction.ts";

/**
 * Protected paths reach changes already decided (a correctness fix, no flag). The decide policy's protectedPaths send a
 * change that writes, deletes or renames a covered path to a person (rule P3), but only a change decided after the glob
 * was added saw it: one already cleared to land, waiting in its lane or in the trunk writer's queue, still landed.
 *
 * Now the colony keeps a record of its protected globs, each with the time it was protected, and a version that moves
 * at every change of them (ProtectRecord, in the decide store). The record is the rule's input at three points:
 * - the colony, when the globs change (protectChanged): the changes cleared to land that the new record covers go to
 *   the review queue at once, naming the glob, and leave their lanes;
 * - each lane, before it hands a batch to the trunk writer: the record comes with its lineage context (landContext);
 * - the trunk writer, which records it the way a change of direction is recorded (TrunkDO.protect, table ft_protected):
 *   every landing cycle reads it once before it builds, so a change queued there is stopped too. A change one of its
 *   cycles had already passed lands; the colony waits for that cycle and names the landing.
 *
 * The rule (protectHits): a change that writes a path a protected glob covers lands only with a person's approval given
 * at or after that path was protected. Anything else goes back to a person (status escalated), whose approval then lands
 * it. Globs protected before the colony kept a record count as protected from the start (time 0), so for them any
 * person's approval will do, as review has always required.
 */

/** The colony's protected globs as its lanes and its trunk writer read them. */
export interface ProtectRecord {
  /** Moves by one at every change of the colony's protected globs; a newer version always wins. */
  version: number;
  /** Each protected glob and when it was protected (ms; 0 for a glob protected before the colony kept this record). */
  globs: Array<{ glob: string; at: number }>;
}

/** What protecting new globs did to the changes already cleared to land: the decide policy answer's `protection`. */
export interface ProtectOutcome {
  /** The globs this policy change protected that were not protected before. */
  added: string[];
  /** Changes stopped and sent to a person (the review queue), each with a path it writes and the glob that covers it. */
  stopped: Array<{ proposalId: Id; intentId: Id; path: Path; glob: string }>;
  /** Changes the trunk writer had already landed when the protection reached it, each with its landing (ft revert undoes it). */
  landed: Array<LandedChange & { intentId: Id; path: Path; glob: string }>;
  /** False when the trunk writer did not answer for every change: the ones in `unconfirmed` may still land. */
  confirmed: boolean;
  unconfirmed?: Id[];
}

/** One decide-arc decision as lineage context carries it (NoteDecision): the fields the rule reads. */
export interface DecisionLike {
  layer?: unknown;
  action?: unknown;
  at?: unknown;
}

/** Where the colony keeps its record (decide store meta). */
export const PROTECT_META = "protected_paths";

/** How each change that the record stops starts its reason, so lanes and the colony can tell it from other returns. */
export const PROTECT_STOP = /^newly protected: /;

/** Most globs a record holds (the policy keeps at most 50). */
const MAX_GLOBS = 50;

/** A stored or received record (an object or its JSON), checked: malformed globs are dropped. Undefined when it is not one. */
export function parseProtectRecord(x: unknown): ProtectRecord | undefined {
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
  if (typeof r.version !== "number" || !Number.isInteger(r.version) || r.version < 1 || !Array.isArray(r.globs)) return undefined;
  const globs: ProtectRecord["globs"] = [];
  const seen = new Set<string>();
  for (const g of r.globs) {
    const e = g as Record<string, unknown> | null;
    if (!e || typeof e !== "object" || typeof e.glob !== "string" || e.glob === "" || seen.has(e.glob)) continue;
    if (typeof e.at !== "number" || !Number.isFinite(e.at) || e.at < 0) continue;
    seen.add(e.glob);
    globs.push({ glob: e.glob, at: e.at });
    if (globs.length >= MAX_GLOBS) break;
  }
  return { version: r.version, globs };
}

/** The newer of two records (the higher version; the first on a tie), or undefined when neither is one. */
export function newerProtect(a: ProtectRecord | undefined, b: ProtectRecord | undefined): ProtectRecord | undefined {
  if (!a) return b;
  if (!b) return a;
  return b.version > a.version ? b : a;
}

/**
 * The record after the policy's protected globs went from `before` to `after`, or null when they did not change (as
 * sets). A glob keeps the time the previous record gave it; one already protected that the record does not know (it
 * was protected before the colony kept a record) gets 0; a new one gets `now`.
 */
export function nextProtectRecord(prev: ProtectRecord | undefined, before: readonly string[], after: readonly string[], now: number): ProtectRecord | null {
  const was = new Set(before);
  const next = [...new Set(after)];
  if (next.length === was.size && next.every((g) => was.has(g))) return null;
  const known = new Map((prev?.globs ?? []).map((g) => [g.glob, g.at]));
  return {
    version: (prev?.version ?? 0) + 1,
    globs: next.slice(0, MAX_GLOBS).map((glob) => ({ glob, at: known.get(glob) ?? (was.has(glob) ? 0 : now) })),
  };
}

/** When a person last approved a change, from its recorded decisions (layer human, action approve); null when never. */
export function humanApproval(decisions: ReadonlyArray<DecisionLike> | undefined): number | null {
  let at: number | null = null;
  for (const d of Array.isArray(decisions) ? decisions : []) {
    if (!d || d.layer !== "human" || d.action !== "approve" || typeof d.at !== "number" || !Number.isFinite(d.at)) continue;
    if (at === null || d.at > at) at = d.at;
  }
  return at;
}

/**
 * The paths of a change that the record protects and no person approved it for since: each path the change writes,
 * deletes or renames that a glob covers (signals.ts protectedHits), with the glob that protected it first, when that
 * happened after `approved` (a person's latest approval of the change) or the change has none. Empty: it may land.
 */
export function protectHits(p: Pick<Proposal, "writeSet">, record: ProtectRecord | undefined, approved: number | null): ProtectedHit[] {
  if (!record || record.globs.length === 0 || !Array.isArray(p?.writeSet)) return [];
  const byTime = [...record.globs].sort((a, b) => a.at - b.at);
  const at = new Map(byTime.map((g) => [g.glob, g.at]));
  const paths = p.writeSet.filter((w) => w && typeof w.path === "string").map((w) => w.path);
  return protectedHits(paths, byTime.map((g) => g.glob)).filter((h) => approved === null || approved < (at.get(h.glob) ?? 0));
}

/** The reason a change stopped by the record carries: the paths and their globs, and what a person does next. */
export function protectReason(hits: readonly ProtectedHit[]): string {
  const shown = hits.slice(0, 3).map((h) => `${h.path} (protected by ${h.glob})`);
  const more = hits.length > shown.length ? ` and ${hits.length - shown.length} more` : "";
  return `newly protected: ${shown.join(", ")}${more} became protected after this change was cleared to land, so a person decides it: approve it to land it, or reject it`;
}

/** Whether a reason is a stop for a newly protected path (protectReason). */
export function isProtectStop(reason: string | undefined): boolean {
  return typeof reason === "string" && PROTECT_STOP.test(reason);
}

/** The reason a change keeps when it landed although the colony had stopped it: the trunk writer's cycle had passed its check. */
export function protectLandedText(reason: string): string {
  const what = reason.replace(PROTECT_STOP, "").replace(/ became protected after this change was cleared to land.*$/, "");
  return `landed before the protection of ${what} reached the trunk writer; ft revert undoes it`;
}

/** Split a lane batch: changes the record lets through, and the ones that go to a person with the reason. */
export function splitByProtection<P extends Pick<Proposal, "id" | "writeSet">>(
  batch: P[],
  record: ProtectRecord | undefined,
  decisions: Record<Id, ReadonlyArray<DecisionLike>> | undefined,
): { keep: P[]; stopped: Array<{ p: P; reason: string }> } {
  const rec = parseProtectRecord(record);
  if (!rec || rec.globs.length === 0) return { keep: batch, stopped: [] };
  const keep: P[] = [];
  const stopped: Array<{ p: P; reason: string }> = [];
  for (const p of batch) {
    const hits = protectHits(p, rec, humanApproval(decisions?.[p.id]));
    if (hits.length > 0) stopped.push({ p, reason: protectReason(hits) });
    else keep.push(p);
  }
  return { keep, stopped };
}

/** The colony's side of a change of its protected globs (see protectChanged). */
export interface ProtectHost {
  /** The colony's record; undefined while it keeps none. */
  record(): ProtectRecord | undefined;
  /** Keep the colony's record (its lanes read it from now on). */
  keep(record: ProtectRecord): void;
  now(): number;
  /** Changes cleared to land (status ready, no vaccines), each with when a person last approved it (null: never). */
  cleared(): Array<{ p: Proposal; approved: number | null }>;
  /** Record at the trunk writer (TrunkDO.protect), which then answers for these changes once the cycles that read the old record are over. */
  fence(record: ProtectRecord, proposalIds: Id[]): Promise<FenceAnswer>;
  /** Send these changes to a person: status escalated, with the reason; their lanes drop them. */
  escalate(items: Array<{ id: Id; reason: string }>): Promise<void>;
  /** Settle a landing the trunk writer named (onLanding; idempotent per landing). */
  settle(landing: Landing): Promise<void>;
}

/** `p`, or a rejection once `ms` pass. */
function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), ms);
  });
  return Promise.race([p, late]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * A change of the decide policy's protected globs, from `before` to `after`. The colony's record moves (nothing happens
 * when the globs did not change), each change cleared to land that it covers without a person's approval since goes to
 * the review queue naming the glob, and the trunk writer records the new record first, as for a change of direction:
 * its next cycles stop such changes, and its answer names the ones a cycle had already landed (settled here at once).
 * Returns what protecting new globs did, or null when no glob was added (a removal is recorded all the same).
 */
export async function protectChanged(host: ProtectHost, before: readonly string[], after: readonly string[]): Promise<ProtectOutcome | null> {
  const record = nextProtectRecord(host.record(), before, after, host.now());
  if (!record) return null;
  host.keep(record);
  const stops: Array<{ p: Proposal; hits: ProtectedHit[] }> = [];
  for (const c of host.cleared()) {
    const hits = protectHits(c.p, record, c.approved);
    if (hits.length > 0) stops.push({ p: c.p, hits });
  }
  const ids = stops.map((s) => s.p.id);
  // The trunk writer records the protection before the lanes are told: a lane's dequeue can wait behind a landing call in
  // flight, and a change queued in the writer is stopped by its next cycle only once this is recorded.
  const fencing = within(host.fence(record, ids), FENCE_ANSWER_MS);
  fencing.catch(() => undefined);
  if (stops.length > 0) await host.escalate(stops.map((s) => ({ id: s.p.id, reason: protectReason(s.hits) })));
  let answer: FenceAnswer | null = null;
  try {
    answer = await fencing;
  } catch (err) {
    console.error(`protected paths: the trunk writer did not answer: ${err instanceof Error ? err.message : String(err)}`);
  }
  for (const l of Array.isArray(answer?.landings) ? answer.landings : []) {
    try {
      await host.settle(l);
    } catch (err) {
      console.error(`protected paths: landing ${l?.id} named by the trunk writer not settled: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const added = [...new Set(after)].filter((g) => !before.includes(g));
  if (added.length === 0) return null;
  const asked = new Set(ids);
  const landedById = new Map((Array.isArray(answer?.landed) ? answer.landed : []).filter((x) => asked.has(x.proposalId)).map((x) => [x.proposalId, x]));
  const open = new Set(answer ? (Array.isArray(answer.undetermined) ? answer.undetermined : []).filter((id) => asked.has(id) && !landedById.has(id)) : ids);
  const out: ProtectOutcome = { added, stopped: [], landed: [], confirmed: open.size === 0 };
  for (const s of stops) {
    const hit = s.hits[0]!;
    const l = landedById.get(s.p.id);
    if (l) out.landed.push({ proposalId: l.proposalId, landingId: l.landingId, trunkSha: l.trunkSha, intentId: s.p.intentId, path: hit.path, glob: hit.glob });
    else if (!open.has(s.p.id)) out.stopped.push({ proposalId: s.p.id, intentId: s.p.intentId, path: hit.path, glob: hit.glob });
  }
  if (open.size > 0) out.unconfirmed = [...open];
  return out;
}
