/**
 * Merge locks: what a person decided on is what lands. Text merge (FT_TEXT_MERGE) and its insertion rule
 * (FT_MERGE_INSERTIONS) land a change whose written files trunk moved past as a merge of the change with trunk's newer
 * version, and with FT_RESOLVER a merge that conflicts goes on to the conflict resolver, whose model writes the merged
 * file. Either way the bytes that land are not the bytes that were decided on. A change a person approved, one whose
 * decision found a danger pattern a person must see (governance included), and one that writes a protected path were
 * decided against their base only, so the trunk writer does not merge them on its own:
 * - a clean merge goes back to a person (status escalated) with the trunk delta: each file, its version at the change's
 *   base, the version trunk has now and the merged result. The writer keeps the hold (table ft_merge_holds), and a
 *   person's approval given after it lands exactly that merge; a trunk that moved again since is a new hold;
 * - a merge that conflicts, or a file that cannot be merged, goes back to its agent as before, without the conflicts
 *   the conflict resolver would take it on with.
 * A file whose merge leaves trunk's version as it was, or comes out as the change's own version, lands nothing nobody
 * decided on and needs no hold. Import-name revalidation lands a change's own files unchanged and is not affected.
 */
import type { HeldDiff, HeldMergeFile, Id, Path, Proposal, Sha, TextMerged } from "@fire_trident/core";
import type { SqlRunner } from "../colony/inline.ts";
import { humanApproval, type DecisionLike, type ProtectRecord } from "../colony/protect.ts";
import { DANGER_CHECK } from "../decide/danger.ts";
import { fileDiff } from "../decide/diff.ts";
import { maskHunks } from "../decide/review.ts";
import { protectedHits } from "../decide/signals.ts";
import { cycleProtect, storedProtect, type ProtectContext } from "./protect.ts";

/** Why a change's files land as decided, and the merges a person approved for it. */
export interface MergeLock {
  /** When a person last approved the change (ms); null when no approval is known. */
  approvedAt: number | null;
  /** Without a known approval, why a person must see a merge: a danger pattern, or a protected path. */
  needs?: "danger" | "protected";
  /** Merges a person approved after the writer held the change for them: per file, the trunk version and the result. */
  consented?: ReadonlyMap<Path, { trunk: Sha; result: Sha }>;
}

/**
 * One file of a held merge (core HeldMergeFile): its blobs (the change's base, the trunk version it would land on, the
 * change's own and the merged result), the change landing ahead in the cycle that wrote that trunk version, and for the
 * first DIFF_FILES files the diffs a person reads before approving.
 */
export type HeldFile = HeldMergeFile;

/** Held files that carry their diffs, lines and characters a diff keeps, and the cut marker (as the review view marks one). */
const DIFF_FILES = 5;
const DIFF_LINES = 60;
const DIFF_CHARS = 6_000;
const CUT = "… (truncated)";
/** Characters a diff is rendered to before it is masked and cut (a 512 KiB file fits). */
const RENDER_CHARS = 2_000_000;

/** How a held change's reason starts, by what locked it: lanes tell a hold from other returns by it (isMergeHold). */
const OPENERS = {
  approved: "A person approved this change",
  danger: "This change has a danger pattern a person must see and was decided",
  protected: "This change writes a protected path and was decided",
} as const;

const HOLD = new RegExp(`^(?:${Object.values(OPENERS).join("|")}) against an older trunk; trunk has since changed `);

/** Files a hold's reason names at most. */
const FILES_NAMED = 5;

/** How long the writer keeps a hold: a person's approval after it lands its merge. */
const HOLD_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

/** The writer's holds: one row per change and file, with the trunk version and the result a person was shown, and when. */
export const MERGE_HOLDS_TABLE =
  "CREATE TABLE IF NOT EXISTS ft_merge_holds (proposal_id TEXT NOT NULL, path TEXT NOT NULL, trunk TEXT NOT NULL, result TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (proposal_id, path))";

/**
 * The merge lock of one change, or null when it has none: a person's approval (the proposal's `approvedAt`, or a human
 * approval among the decisions its lane passed, whichever is later), a failed danger check in its evidence (a pattern
 * that needs a person, governance included), or a written path that `protect` covers. A change from before
 * `approvedAt` existed is read from its decisions alone. Pure.
 */
export function mergeLock(p: Proposal, decisions: ReadonlyArray<DecisionLike> | undefined, protect: ProtectRecord | undefined): MergeLock | null {
  const own = typeof p.approvedAt === "number" && Number.isFinite(p.approvedAt) ? p.approvedAt : null;
  const decided = humanApproval(decisions);
  const approvedAt = own === null ? decided : decided === null ? own : Math.max(own, decided);
  if (approvedAt !== null) return { approvedAt };
  const checks = Array.isArray(p.evidence?.checks) ? p.evidence.checks : [];
  if (checks.some((c) => c?.name === DANGER_CHECK && c.ok === false)) return { approvedAt: null, needs: "danger" };
  const paths = (Array.isArray(p.writeSet) ? p.writeSet : []).filter((w) => typeof w?.path === "string").map((w) => w.path);
  if (protect && protectedHits(paths, protect.globs.map((g) => g.glob)).length > 0) return { approvedAt: null, needs: "protected" };
  return null;
}

/**
 * A locked change's clean merge (planCycle): null when it may land, else its return to a person with the trunk delta
 * (`held`: every file that would land a merged result). A file lands nothing nobody decided on when its result is
 * trunk's version or the change's own; any other file needs a person's approval of that very merge (the same trunk
 * version and result) given after the writer held it. `aheadBy`: the change landing ahead in the cycle that wrote a
 * path's trunk version, when one did. `textOf` gives a blob's text, for the diffs of the first DIFF_FILES files: what
 * trunk changed since the base, and the merged result against the change's own version. Pure.
 */
export function mergeHold(
  lock: MergeLock,
  proposalId: Id,
  files: readonly TextMerged[],
  aheadBy: (path: Path) => Id | undefined,
  textOf: (blob: Sha) => string | null = () => null,
): { proposalId: Id; reason: string; held: HeldFile[] } | null {
  const merged = files.filter((f) => f.result !== f.trunk && f.result !== f.theirs);
  const agreed = (f: TextMerged): boolean => {
    const c = lock.consented?.get(f.path);
    return c !== undefined && c.trunk === f.trunk && c.result === f.result;
  };
  if (merged.every(agreed)) return null;
  const held = merged.map((f, i): HeldFile => {
    const by = aheadBy(f.path);
    const out: HeldFile = { path: f.path, base: f.base, trunk: f.trunk, theirs: f.theirs, result: f.result, ...(by ? { by } : {}) };
    if (i >= DIFF_FILES) return out;
    const trunkDiff = heldDiff(f.path, textOf(f.base), textOf(f.trunk));
    const mergedDiff = heldDiff(f.path, textOf(f.theirs), textOf(f.result));
    return { ...out, ...(trunkDiff ? { trunkDiff } : {}), ...(mergedDiff ? { mergedDiff } : {}) };
  });
  return { proposalId, reason: holdReason(lock, held), held };
}

/**
 * One diff of a held file, from `before` to `after` (undefined without both texts): rendered whole, masked as a review
 * view is (a line that may hold a secret replaced), then cut to DIFF_LINES lines and DIFF_CHARS characters, marked when
 * cut. The counts are the whole diff's.
 */
export function heldDiff(path: Path, before: string | null, after: string | null): HeldDiff | undefined {
  if (before === null || after === null) return undefined;
  const d = fileDiff(path, before, after, { maxChars: RENDER_CHARS });
  const lines = maskHunks(path, d.hunks).split("\n");
  const kept: string[] = [];
  let chars = 0;
  for (const line of lines) {
    if (kept.length >= DIFF_LINES || chars + line.length + 1 > DIFF_CHARS) break;
    kept.push(line);
    chars += line.length + 1;
  }
  const cut = kept.length < lines.length;
  return { hunks: cut ? [...kept, CUT].join("\n") : kept.join("\n"), added: d.added, removed: d.removed, truncated: d.truncated || cut };
}

/** The reason a held change goes to a person with: who decided it, the trunk delta of each file, and what to do next. */
export function holdReason(lock: Pick<MergeLock, "approvedAt" | "needs">, held: readonly HeldFile[]): string {
  const opener = lock.approvedAt !== null ? OPENERS.approved : lock.needs === "protected" ? OPENERS.protected : OPENERS.danger;
  const shown = held
    .slice(0, FILES_NAMED)
    .map((f) => `${f.path} (${short(f.base)} at its base, ${short(f.trunk)} on trunk${f.by ? ` from ${f.by}, landing ahead in this cycle` : ""}, merged as ${short(f.result)})`);
  if (held.length > shown.length) shown.push(`${held.length - shown.length} more`);
  const files = shown.length <= 1 ? (shown[0] ?? "") : `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
  return (
    `${opener} against an older trunk; trunk has since changed ${files}, so it was not merged automatically. ` +
    "Review the merged result or the trunk change, both shown with it for review: approving it lands exactly this merge, and returning it sends it to its agent to redo on the new trunk."
  );
}

/** Whether a return's reason is a merge hold (holdReason): the lane sends it to a person instead of its agent. */
export function isMergeHold(reason: string | undefined): boolean {
  return typeof reason === "string" && HOLD.test(reason);
}

/** Short form of a blob id for reasons. */
function short(blob: Sha): string {
  return blob.slice(0, 10);
}

/**
 * One cycle's merge locks, by proposal id (see mergeLock), each with the merges a person approved after the writer held
 * it. One read of the protected-paths record (the newest of the writer's own and those its lanes passed) and one of the
 * holds. Null when they cannot be read: the cycle then merges nothing, and a stale change goes back as without text merge.
 */
export function mergeLocks(sql: SqlRunner, items: ReadonlyArray<{ p: Proposal; ctx: ProtectContext | undefined }>): Map<Id, MergeLock> | null {
  try {
    const protect = cycleProtect(storedProtect(sql), items.map((i) => i.ctx));
    const out = new Map<Id, MergeLock>();
    for (const { p, ctx } of items) {
      const lock = mergeLock(p, ctx?.decisions?.[p.id], protect);
      if (lock) out.set(p.id, lock);
    }
    const approved = [...out].filter(([, l]) => l.approvedAt !== null).map(([id]) => id);
    if (approved.length === 0) return out;
    sql.exec(MERGE_HOLDS_TABLE);
    const rows = sql
      .exec("SELECT proposal_id, path, trunk, result, at FROM ft_merge_holds WHERE proposal_id IN (SELECT value FROM json_each(?))", JSON.stringify(approved))
      .toArray() as Array<{ proposal_id: string; path: string; trunk: string; result: string; at: number }>;
    for (const r of rows) {
      const lock = out.get(r.proposal_id);
      // Only an approval given after the hold agrees to its merge.
      if (!lock || lock.approvedAt === null || !(r.at < lock.approvedAt)) continue;
      const consented = new Map(lock.consented ?? []);
      consented.set(r.path, { trunk: r.trunk, result: r.result });
      out.set(r.proposal_id, { ...lock, consented });
    }
    return out;
  } catch (e) {
    console.error(`merge locks not read; this cycle merges nothing: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/**
 * Keep the holds among a cycle's returns (each file a person is asked to approve the merge of, at `now`), and drop holds
 * older than HOLD_KEEP_MS. A failure is logged: the change still goes to a person, and an approval with no hold on
 * record is held again, never merged.
 */
export function keepHolds(sql: SqlRunner, returned: ReadonlyArray<{ proposalId: Id; held?: readonly HeldFile[] }>, now: number): void {
  const holds = returned.filter((r) => Array.isArray(r.held) && r.held.length > 0);
  if (holds.length === 0) return;
  try {
    sql.exec(MERGE_HOLDS_TABLE);
    for (const r of holds) {
      for (const f of r.held!) {
        sql.exec("INSERT OR REPLACE INTO ft_merge_holds (proposal_id, path, trunk, result, at) VALUES (?, ?, ?, ?, ?)", r.proposalId, f.path, f.trunk, f.result, now);
      }
    }
    sql.exec("DELETE FROM ft_merge_holds WHERE at < ?", now - HOLD_KEEP_MS);
  } catch (e) {
    console.error(`merge holds not kept: ${e instanceof Error ? e.message : String(e)}`);
  }
}
