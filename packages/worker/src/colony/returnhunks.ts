import { revalidationEnabled } from "@fire_trident/core";
import type { ContestedRegion, Id, MergeConflict, MovedBy, MovedHunk, Path, Proposal, Sha } from "@fire_trident/core";
import { errorText } from "./errors.ts";
import { CONTESTED_MAX, HUNK_PATHS, RETURN_HUNK_CHARS, RETURN_HUNK_LINES, cleanContested, cleanHunks, fitDiff, fitRegion, type HunkBudget } from "./hunks.ts";
import { movedBy, movedCollision, type SqlRunner, type StalePath } from "./movedby.ts";
import { cleanConflicts } from "./resolver-merge.ts";

/**
 * Return hunks (FT_RETURN_HUNKS: "on", or a comma-separated list of colony ids; off when absent). When a change goes back
 * because trunk moved files it read or wrote, movedBy (colony/movedby.ts) names the landings that moved them; with this
 * flag the return also quotes what they did, so the agent repairs in one pass without reading trunk again:
 *
 * - Each landing movedBy names carries its unified diff of each moved file (`movedBy[].hunks`, the first HUNK_PATHS files
 *   of the landing, about HUNK_LINES lines each), and a text merge conflict carries each contested region (`contested`:
 *   the base's lines, trunk's and the change's own, from the base line where it starts). At most RETURN_HUNK_LINES lines
 *   and RETURN_HUNK_CHARS characters a return, contested regions first (colony/hunks.ts holds the caps).
 * - The colony keeps no file contents, so it asks the trunk writer, which keeps every landing's blobs per file and reads
 *   blobs (TrunkDO.returnHunks, trunk/quote.ts). One call per batch of returns (a lane tick's returns arrive together),
 *   made before anything of the batch is written, so the write itself stays one synchronous step. The writer answers
 *   beside its landing cycles, from its own landing log and blob store, and stops at the budget it is given.
 * - Best effort with a short budget: the colony waits at most RETURN_HUNKS_MS. When the writer is slow, busy, on older
 *   code or fails, the return goes out as it does without the flag, its landings named.
 * - The reason then ends with one more sentence (no file named, as movedBy's own sentence names none): the quote is
 *   there, build on it. The quotes are masked where a line looks like a secret (trunk/mask.ts), and they stay out of the
 *   live event stream (eventMovedBy); the proposal, the take's lastReturn, the inbox and the review queue carry them.
 */

/** Is FT_RETURN_HUNKS on for this colony? Read like FT_REVALIDATE: "on", a list of colony ids, or off. */
export function returnHunksEnabled(setting: string | undefined, colonyId: Id): boolean {
  return revalidationEnabled(setting, colonyId);
}

/** How long a batch of returns waits for the trunk writer's quotes, in ms; past it they go out as before. */
export const RETURN_HUNKS_MS = 1_000;
/** The part of that budget the trunk writer may spend reading and diffing (the rest covers the call itself). */
const WRITER_SHARE = 0.7;
/** What one call asks the trunk writer at most: (landing, file) pairs, and conflicting files. */
export const HUNK_ASKS = 48;
export const CONFLICT_ASKS = 12;

/** What the colony asks the trunk writer to quote (TrunkDO.returnHunks). */
export interface ReturnHunksQuery {
  /** The change each landing made to each file. */
  diffs: Array<{ landingId: Id; path: Path }>;
  /** Text merge conflicts as the writer carried them back: each file's contested regions. */
  conflicts: MergeConflict[];
  /** How long the writer may spend, in ms. */
  budgetMs: number;
}

/** The trunk writer's quotes: the diffs and conflicts it could read in time (each capped and masked); the rest are left out. */
export interface ReturnHunksAnswer {
  diffs: Array<{ landingId: Id; path: Path; trunkSha?: Sha; diff: string; truncated: boolean }>;
  conflicts: Array<{ path: Path; base: Sha; trunk: Sha; theirs: Sha; regions: ContestedRegion[] }>;
}

/** What one batch of returns got quoted, keyed for quoteHunks. */
export interface QuotedHunks {
  /** By landing and file (diffKey). */
  diffs: Map<string, MovedHunk>;
  /** By conflict (conflictKey). */
  conflicts: Map<string, ContestedRegion[]>;
}

/** What fetchReturnHunks needs from its colony (ColonyDO; tests fake it). */
export interface HunkHost {
  sql: SqlRunner;
  /** The proposal as stored, or null. */
  proposal(id: Id): Proposal | null;
  /** The trunk writer's quote call; a writer on older code refuses it, which counts as no answer. */
  quote(q: ReturnHunksQuery): Promise<ReturnHunksAnswer>;
  /** How long to wait, in ms (RETURN_HUNKS_MS when absent). */
  budgetMs?: number;
}

/** One updateProposals item (ColonyDO.updateProposals). */
export interface HunkItem {
  id: Id;
  patch: Partial<Proposal>;
  stale?: StalePath[];
}

function diffKey(landingId: Id, path: Path): string {
  return `${landingId}\u0000${path}`;
}

function conflictKey(c: Pick<MergeConflict, "path" | "base" | "trunk" | "theirs">): string {
  return [c.path, c.base, c.trunk, c.theirs].join("\u0000");
}

/**
 * What to ask the trunk writer for these items: for each that goes back because trunk moved its files (movedCollision,
 * read as updateProposals will write it), the first HUNK_PATHS files of each landing movedBy names, and each text merge
 * conflict it carries. Deduplicated, at most HUNK_ASKS and CONFLICT_ASKS.
 */
export function hunkQuery(host: Pick<HunkHost, "sql" | "proposal">, items: readonly HunkItem[], budgetMs = RETURN_HUNKS_MS): ReturnHunksQuery {
  const diffs = new Map<string, { landingId: Id; path: Path }>();
  const conflicts = new Map<string, MergeConflict>();
  for (const item of Array.isArray(items) ? items : []) {
    if (item?.patch?.status !== "returned") continue;
    const prev = host.proposal(item.id);
    // As updateProposals settles it: final proposals and ones already back are not returned again.
    if (!prev || prev.status === "landed" || prev.status === "rejected" || prev.status === "returned") continue;
    const next = { ...prev, ...item.patch } as Proposal;
    if (!movedCollision(next)) continue;
    for (const m of movedBy(host.sql, next, Array.isArray(item.stale) ? item.stale : null)) {
      for (const path of m.paths.slice(0, HUNK_PATHS)) if (diffs.size < HUNK_ASKS) diffs.set(diffKey(m.landingId, path), { landingId: m.landingId, path });
    }
    for (const c of cleanConflicts(next.mergeConflicts, CONFLICT_ASKS)) if (conflicts.size < CONFLICT_ASKS) conflicts.set(conflictKey(c), c);
  }
  return { diffs: [...diffs.values()], conflicts: [...conflicts.values()], budgetMs: Math.max(1, Math.floor(budgetMs * WRITER_SHARE)) };
}

/** The trunk writer's answer as received, checked entry by entry and keyed. */
export function quotedOf(answer: unknown): QuotedHunks {
  const out: QuotedHunks = { diffs: new Map(), conflicts: new Map() };
  const a = (answer && typeof answer === "object" ? answer : {}) as Partial<Record<"diffs" | "conflicts", unknown>>;
  for (const d of (Array.isArray(a.diffs) ? a.diffs : []).slice(0, HUNK_ASKS)) {
    const e = (d && typeof d === "object" ? d : {}) as Record<string, unknown>;
    if (typeof e.landingId !== "string" || e.landingId === "") continue;
    const hunk = cleanHunks([e])?.[0];
    if (hunk) out.diffs.set(diffKey(e.landingId, hunk.path), hunk);
  }
  for (const c of (Array.isArray(a.conflicts) ? a.conflicts : []).slice(0, CONFLICT_ASKS)) {
    const e = (c && typeof c === "object" ? c : {}) as Record<string, unknown>;
    if (typeof e.path !== "string" || typeof e.base !== "string" || typeof e.trunk !== "string" || typeof e.theirs !== "string") continue;
    const regions = (cleanContested(e.regions) ?? []).filter((r) => r.path === e.path);
    if (regions.length > 0) out.conflicts.set(conflictKey(e as Pick<MergeConflict, "path" | "base" | "trunk" | "theirs">), regions);
  }
  return out;
}

/**
 * Ask the trunk writer to quote what beat these returns (hunkQuery), waiting at most the host's budget. Null when
 * nothing is to be quoted, and when the writer does not answer in time, refuses the call or fails (logged): the returns
 * then go out as they would without the flag. Never throws.
 */
export async function fetchReturnHunks(host: HunkHost, items: readonly HunkItem[]): Promise<QuotedHunks | null> {
  const budget = host.budgetMs ?? RETURN_HUNKS_MS;
  let q: ReturnHunksQuery;
  try {
    q = hunkQuery(host, items, budget);
  } catch (err) {
    console.warn(`return hunks not asked: ${errorText(err)}`);
    return null;
  }
  if (q.diffs.length === 0 && q.conflicts.length === 0) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer in ${budget} ms`)), budget);
    });
    return quotedOf(await Promise.race([host.quote(q), late]));
  } catch (err) {
    console.warn(`return hunks not quoted (the returns go out naming their landings): ${errorText(err)}`);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The sentence a quoted return's reason ends with: the quote is there, build on it. No file is named (see movedSentence). */
export function quotedSentence(diffs: boolean, regions: boolean): string {
  if (diffs && regions) {
    return "What those landings changed in the files, and each contested region of the text merge (the base's lines, trunk's and this change's), are quoted with this return: build on them without reading trunk again.";
  }
  if (regions) return "Each contested region of the text merge is quoted with this return (the base's lines, trunk's and this change's): build on them without reading trunk again.";
  return "What those landings changed in the files is quoted with this return: build on it without reading trunk again.";
}

/**
 * Attach a batch's quotes to one change going back (ColonyDO.attributeReturn, after movedReturn): each movedBy landing's
 * diffs of its first HUNK_PATHS files, and each contested region of its text merge conflicts, within the return's budget
 * (RETURN_HUNK_LINES, RETURN_HUNK_CHARS; regions first). When anything is attached, the reason ends with quotedSentence.
 * A change not back for trunk moving, or with nothing quoted, is left as it is.
 */
export function quoteHunks(p: Proposal, quoted: QuotedHunks | null): void {
  if (!quoted || !movedCollision(p) || typeof p.reason !== "string") return;
  const budget: HunkBudget = { lines: RETURN_HUNK_LINES, chars: RETURN_HUNK_CHARS };
  const contested: ContestedRegion[] = [];
  regions: for (const c of cleanConflicts(p.mergeConflicts, CONFLICT_ASKS)) {
    for (const r of quoted.conflicts.get(conflictKey(c)) ?? []) {
      if (contested.length >= CONTESTED_MAX) break regions;
      const fit = fitRegion(r, budget);
      if (!fit) break regions;
      contested.push(fit);
    }
  }
  let full = false;
  const moved: MovedBy[] = (Array.isArray(p.movedBy) ? p.movedBy : []).map((m) => {
    const hunks: MovedHunk[] = [];
    for (const path of full ? [] : m.paths.slice(0, HUNK_PATHS)) {
      const h = quoted.diffs.get(diffKey(m.landingId, path));
      if (!h) continue;
      const fit = fitDiff(h, budget);
      if (!fit) {
        full = true;
        break;
      }
      hunks.push(fit);
    }
    return hunks.length > 0 ? { ...m, hunks } : m;
  });
  const diffs = moved.some((m) => m.hunks !== undefined);
  if (!diffs && contested.length === 0) return;
  if (diffs) p.movedBy = moved;
  if (contested.length > 0) p.contested = contested;
  const reason = p.reason.trimEnd();
  p.reason = `${reason}${/[.!?]$/.test(reason) ? "" : "."} ${quotedSentence(diffs, contested.length > 0)}`;
}

/** movedBy as the live event stream carries it: without the quoted hunks (the proposal and the review queue carry them). */
export function eventMovedBy(moved: readonly MovedBy[]): MovedBy[] {
  return moved.map((m) => {
    if (m.hunks === undefined) return m;
    const { hunks: _quoted, ...rest } = m;
    return rest;
  });
}
