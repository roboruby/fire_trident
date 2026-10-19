import { changesNothing, revalidationEnabled } from "@fire_trident/core";
import type { Id, Landing, OccResult, OnTrunkSource, Path, Proposal, Sha } from "@fire_trident/core";

/**
 * Already on trunk (FT_ALREADY_ON_TRUNK): a change that would change nothing on the trunk it lands on closes, instead of
 * landing as a commit that changes nothing or going back stale.
 *
 * Two agents can write the same thing: one on an older base writes what another already landed, or two changes in one
 * trunk cycle carry the same content. Before, the second landed as an empty commit with a lineage note when text merge was
 * on (core mergeText: the same edit on both sides merges cleanly) and counted as a landing; with text merge off it went
 * back stale, and its agent redid work that was done. Where the flag covers the colony:
 *
 * - its lane sends a stale change whose every write trunk already holds on to the trunk writer (liftOnTrunk), which
 *   decides at its commit point, as it does for text merge candidates;
 * - the trunk writer's screen lets such a change through to the plan, which checks each change in turn against the
 *   virtual trunk (trunk as the changes accepted ahead of it in the cycle leave it, its own batch included): before the
 *   in-batch conflict check, and again after a text merge (foundOnTrunk, core changesNothing). A change that would change
 *   nothing is left out of every commit: no commit, no note, no landing, not counted as landed or returned;
 * - the trunk writer names where its content came from (onTrunkSources): the change accepted ahead of it in the cycle that
 *   wrote it (that landing), else the landing whose commit last changed the files it writes (the landing log and its
 *   note), else the trunk head; and answers it in `onTrunk` with a sentence for its agent (onTrunkText);
 * - its lane reports it to the colony as status already_on_trunk (onTrunkUpdates); the colony clears its agent's claims
 *   (no failure mark), closes its intent as landed with the closure cause already_on_trunk naming that source, and counts
 *   `alreadyOnTrunk` apart from landings and returns.
 *
 * A change that read a file it writes at a version trunk has since moved past is never closed here (core changesNothing,
 * staleWrittenReads): trunk holding what it writes may be another change's identical edit while its own is still to
 * make (two increments of one counter from one read both write 6), so it goes back stale like any stale change, and the
 * redo, read on trunk as it is, lands its own edit or, a real duplicate, closes here. One that read those files at
 * trunk's version, or did not read them, closes as above.
 *
 * A retry of a change that did land still gets its landing (the trunk writer reads its landed index first), and the
 * commit point's checks (direction, protected paths, pause) still come first. Off: nothing here runs.
 */

/** FT_ALREADY_ON_TRUNK: whether it covers this colony ("on", or a comma-separated list of colony ids; off when absent). */
export function alreadyOnTrunkEnabled(setting: string | undefined, colonyId: Id): boolean {
  return revalidationEnabled(setting, colonyId);
}

/** A change a cycle's plan found would land nothing, and the change accepted ahead of it in the cycle that wrote its content, when one did. */
export interface OnTrunkFound {
  proposalId: Id;
  by?: Id;
}

/** A change the trunk writer closed as already on trunk, as `land` answers it: where its content came from, and the sentence for its agent. */
export interface OnTrunk {
  proposalId: Id;
  source: OnTrunkSource;
  reason: string;
}

/**
 * The plan's check (trunk/plan.ts planCycle): whether `p` would land nothing on trunk as `before` gives it (trunk with the
 * changes accepted ahead of it in the cycle), and if so the change accepted ahead of it that wrote one of its files: the
 * newest such change of its own batch (`batch`, in order), else the change of an earlier batch `ahead` names for the path.
 * Null when it would change something, or when it read a file it writes at a version `before` no longer has.
 */
export function foundOnTrunk(p: Proposal, before: (path: Path) => Sha | null, batch: readonly Proposal[], ahead: ReadonlyMap<Path, { by: Id }>): OnTrunkFound | null {
  if (!changesNothing(p, before)) return null;
  for (const w of p.writeSet) {
    for (let i = batch.length - 1; i >= 0; i--) if (batch[i]!.writeSet.some((f) => f.path === w.path)) return { proposalId: p.id, by: batch[i]!.id };
    const a = ahead.get(w.path);
    if (a) return { proposalId: p.id, by: a.by };
  }
  return { proposalId: p.id };
}

/** Who wrote a path in a landing, as its lineage note records it. */
export interface OnTrunkWriter {
  proposalId: Id;
  intentId?: Id;
  agentId?: Id;
}

/** The trunk writer's landing log as onTrunkSources reads it. */
export interface OnTrunkLog {
  /** The newest landing whose commit changed one of these paths, and the change of it that wrote that path when its note says; null when none did. */
  lastChange(paths: readonly Path[]): { landing: Landing; writer?: OnTrunkWriter } | null;
}

/** Paths of one change the landing log is asked about at most. */
const LOG_PATHS = 64;
/** A note larger than this is not read to find the writer (the landing is named without it). */
const NOTE_CHARS = 2_000_000;

/** The landing log over the trunk writer's tables (ft_landing_paths, ft_landings, ft_notes): an indexed read per path, one note read. */
export function onTrunkLog(sql: SqlStorage): OnTrunkLog {
  return {
    lastChange(paths) {
      let best: { seq: number; path: Path } | null = null;
      for (const path of [...new Set(paths)].slice(0, LOG_PATHS)) {
        const row = sql.exec<{ seq: number }>("SELECT seq FROM ft_landing_paths WHERE path = ? ORDER BY seq DESC LIMIT 1", path).toArray()[0];
        if (row && (best === null || row.seq > best.seq)) best = { seq: row.seq, path };
      }
      if (best === null) return null;
      const data = sql.exec<{ data: string }>("SELECT data FROM ft_landings WHERE seq = ?", best.seq).toArray()[0]?.data;
      const landing = data ? parse<Landing>(data) : null;
      if (!landing || typeof landing.id !== "string" || typeof landing.trunkSha !== "string") return null;
      const note = sql.exec<{ note: string }>("SELECT note FROM ft_notes WHERE landing_id = ?", landing.id).toArray()[0]?.note;
      const writer = typeof note === "string" && note.length <= NOTE_CHARS ? noteWriter(note, best.path) : null;
      return writer ? { landing, writer } : { landing };
    },
  };
}

/** The change a lineage note says wrote `path` (its id, intent and agent), or null. */
function noteWriter(text: string, path: Path): OnTrunkWriter | null {
  const note = parse<{ proposals?: unknown }>(text);
  const list = Array.isArray(note?.proposals) ? (note.proposals as unknown[]) : [];
  for (const x of list) {
    const e = x as { id?: unknown; agentId?: unknown; intent?: { id?: unknown }; writeSet?: unknown };
    if (typeof e?.id !== "string" || !Array.isArray(e.writeSet) || !e.writeSet.some((w: { path?: unknown }) => w?.path === path)) continue;
    return { proposalId: e.id, ...(typeof e.intent?.id === "string" ? { intentId: e.intent.id } : {}), ...(typeof e.agentId === "string" ? { agentId: e.agentId } : {}) };
  }
  return null;
}

function parse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * Where the content of each change the plan found came from, and its sentence: the landing of this cycle's chain that
 * carries the change ahead of it that wrote it (`chain`, `proposals` for its intent and agent), else the newest landing
 * whose commit changed the files it writes (`log`), else the trunk head (`head`). A log that cannot be read names the head.
 */
export function onTrunkSources(found: readonly OnTrunkFound[], proposals: ReadonlyMap<Id, Proposal>, chain: readonly Landing[], log: OnTrunkLog, head: Sha): OnTrunk[] {
  const landingOf = new Map<Id, Landing>();
  for (const l of chain) for (const id of l.proposalIds) landingOf.set(id, l);
  return found.map((f) => {
    const ahead = f.by ? landingOf.get(f.by) : undefined;
    let source: OnTrunkSource;
    if (ahead && f.by) {
      const w = proposals.get(f.by);
      source = { trunkSha: ahead.trunkSha, landingId: ahead.id, proposalId: f.by, ...(w ? { intentId: w.intentId, agentId: w.agentId } : {}), sameCycle: true };
    } else {
      const p = proposals.get(f.proposalId);
      let last: ReturnType<OnTrunkLog["lastChange"]> = null;
      try {
        last = p ? log.lastChange(p.writeSet.map((w) => w.path)) : null;
      } catch (err) {
        console.warn(`already on trunk: the landing log was not read for ${f.proposalId}: ${err instanceof Error ? err.message : String(err)}`);
      }
      source = last ? { trunkSha: last.landing.trunkSha, landingId: last.landing.id, ...(last.writer ?? {}) } : { trunkSha: head };
    }
    return { proposalId: f.proposalId, source, reason: onTrunkText(source) };
  });
}

/**
 * The sentence the agent of a change closed as already on trunk reads (its reason). Ids only, as returns name the
 * landings that beat them (colony/movedby.ts): titles are free text, and reasons are matched by pattern elsewhere.
 */
export function onTrunkText(s: OnTrunkSource): string {
  const done = "Nothing landed for it and it was not sent back, so there is nothing to redo: take your next intent.";
  const commit = typeof s.trunkSha === "string" ? s.trunkSha.slice(0, 7) : "unknown";
  if (!s.landingId) return `Your change is already on trunk: what it writes is there already at trunk commit ${commit}. ${done}`;
  const facts = [`commit ${commit}`, s.intentId ? `intent ${s.intentId}` : "", s.proposalId ? `proposal ${s.proposalId}` : ""].filter(Boolean).join(", ");
  const by = s.agentId ? ` by agent ${s.agentId}` : "";
  return `Your change is already on trunk: what it writes is there already, landed${by} in ${s.landingId} (${facts})${s.sameCycle ? " in the same trunk cycle" : ""}. ${done}`;
}

/** A source as stored or sent, checked field by field (null when it is not one), so old or odd data reads as none. */
export function onTrunkSourceOf(raw: unknown): OnTrunkSource | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.trunkSha !== "string" || o.trunkSha === "") return null;
  const out: OnTrunkSource = { trunkSha: o.trunkSha };
  for (const k of ["landingId", "proposalId", "intentId", "agentId"] as const) if (typeof o[k] === "string" && o[k] !== "") out[k] = o[k] as Id;
  if (o.sameCycle === true) out.sameCycle = true;
  return out;
}

/**
 * The lane's part (RegionDO tick): move each stale change whose every write trunk already holds (`trunk`: the blobs the
 * lane read), and that read none of those files at an older version, from `stale` to `valid`, keeping their order, with
 * its stale paths in `candidates`, so the trunk writer decides it. Returns how many moved.
 */
export function liftOnTrunk(stale: Array<{ p: Proposal; occ: OccResult }>, valid: Proposal[], candidates: Map<Id, OccResult["stale"]>, trunk: (path: Path) => Sha | null | undefined): number {
  const kept = stale.filter((s) => !changesNothing(s.p, trunk));
  const lifted = stale.filter((s) => changesNothing(s.p, trunk));
  for (const s of lifted) {
    valid.push(s.p);
    candidates.set(s.p.id, s.occ.stale);
  }
  stale.splice(0, stale.length, ...kept);
  return lifted.length;
}

/**
 * The lane's part after `land`: the colony's update for each change the trunk writer closed as already on trunk, each
 * once and never one settled as landed (`landed`): status already_on_trunk, its source and its sentence.
 */
export function onTrunkUpdates(answer: readonly unknown[] | null | undefined, landed: ReadonlySet<Id>): Array<{ id: Id; patch: Partial<Proposal> }> {
  const out: Array<{ id: Id; patch: Partial<Proposal> }> = [];
  const seen = new Set<Id>();
  for (const x of Array.isArray(answer) ? answer : []) {
    const e = x as Partial<OnTrunk> | null;
    const source = onTrunkSourceOf(e?.source);
    if (!e || typeof e.proposalId !== "string" || e.proposalId === "" || !source || seen.has(e.proposalId) || landed.has(e.proposalId)) continue;
    seen.add(e.proposalId);
    const reason = typeof e.reason === "string" && e.reason !== "" ? e.reason : onTrunkText(source);
    out.push({ id: e.proposalId, patch: { status: "already_on_trunk", reason, onTrunk: source } });
  }
  return out;
}
