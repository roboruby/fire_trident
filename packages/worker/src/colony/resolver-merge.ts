import { MERGE_MAX_EDITS, lineDiff, splitLines, type LineHunk } from "@fire_trident/core";
import type { Id, MergeConflict, NoteResolves, Path, Sha } from "@fire_trident/core";

/**
 * The conflict resolver's merge logic (FT_RESOLVER; colony/resolver.ts runs it). Pure and synchronous.
 *
 * A file whose text merge conflicted is split the way core/textmerge.ts merges it (the same line diff and the same
 * region rules as git's default merge): the merged lines everywhere both changes agree or only one changed (the
 * `segments`), and between them each conflicting hunk with its base, trunk and change versions. The model writes the
 * whole merged file; checkMerged then holds it to both changes: every segment must come back exactly and in order, so
 * nothing either side changed outside the conflicting hunks is lost or altered, and each conflicting hunk must be
 * resolved to text that is neither side's version whole (that would drop the other side's change), nor the base's.
 */

/** A three-way merge of one file split at its conflicts: the clean text between them and each conflict's versions. */
export interface ConflictedMerge {
  /** Merged lines (each with its line ending) before the first conflict, between conflicts, and after the last: one more than `conflicts`. */
  segments: string[][];
  /** Each conflicting hunk: where it starts in the base (1-based), and the base, trunk ("ours") and change ("theirs") lines. */
  conflicts: Array<{ line: number; base: string[]; ours: string[]; theirs: string[] }>;
}

/** What a three-way merge gives: the merged text, a split at conflicts, or `limited` when a side changed too much to compare. */
export type MergeSides = { clean: true; text: string } | ({ clean: false; limited?: undefined } & ConflictedMerge) | { clean: false; limited: true };

/** Push `items[from..to)` onto `out` (no spread: a large file has more lines than a call takes arguments). */
function pushRange(out: string[], items: readonly string[], from: number, to: number): void {
  for (let i = from; i < to; i++) out.push(items[i]!);
}

/** Two line lists are the same lines. */
export function sameLines(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((line, i) => line === b[i]);
}

/**
 * Merge two edits of one text as core mergeText does (base, ours: the version on trunk, theirs: the change), keeping
 * the conflicts instead of only counting them: the same diff (core lineDiff), the same regions (hunks that overlap or
 * touch form one), the same decisions (one side changed it, or both the same way: merged; otherwise a conflict).
 */
export function mergeSides(base: string, ours: string, theirs: string, maxEdits = MERGE_MAX_EDITS): MergeSides {
  if (ours === theirs || theirs === base) return { clean: true, text: ours };
  if (ours === base) return { clean: true, text: theirs };
  const ids = new Map<string, number>();
  const intern = (lines: string[]): Int32Array => {
    const out = new Int32Array(lines.length);
    for (let i = 0; i < lines.length; i++) {
      let id = ids.get(lines[i]!);
      if (id === undefined) {
        id = ids.size;
        ids.set(lines[i]!, id);
      }
      out[i] = id;
    }
    return out;
  };
  const baseLines = splitLines(base);
  const ourLines = splitLines(ours);
  const theirLines = splitLines(theirs);
  const b = intern(baseLines);
  const mine = lineDiff(b, intern(ourLines), maxEdits);
  const other = lineDiff(b, intern(theirLines), maxEdits);
  if (mine === null || other === null) return { clean: false, limited: true };
  // One side's version of base lines [from, to), given that side's hunks inside them.
  const side = (lines: string[], hunks: LineHunk[], from: number, to: number): string[] => {
    const out: string[] = [];
    let at = from;
    for (const h of hunks) {
      pushRange(out, baseLines, at, h.a0);
      pushRange(out, lines, h.b0, h.b1);
      at = h.a1;
    }
    pushRange(out, baseLines, at, to);
    return out;
  };
  const segments: string[][] = [];
  const conflicts: ConflictedMerge["conflicts"] = [];
  let out: string[] = [];
  let pos = 0;
  let i = 0;
  let j = 0;
  while (i < mine.length || j < other.length) {
    const ownFirst = j >= other.length || (i < mine.length && mine[i]!.a0 <= other[j]!.a0);
    const first = ownFirst ? mine[i++]! : other[j++]!;
    const ownIn: LineHunk[] = ownFirst ? [first] : [];
    const otherIn: LineHunk[] = ownFirst ? [] : [first];
    const start = first.a0;
    let end = first.a1;
    for (;;) {
      if (i < mine.length && mine[i]!.a0 <= end) {
        end = Math.max(end, mine[i]!.a1);
        ownIn.push(mine[i++]!);
      } else if (j < other.length && other[j]!.a0 <= end) {
        end = Math.max(end, other[j]!.a1);
        otherIn.push(other[j++]!);
      } else break;
    }
    pushRange(out, baseLines, pos, start);
    const left = side(ourLines, ownIn, start, end);
    const right = side(theirLines, otherIn, start, end);
    if (otherIn.length === 0 || sameLines(left, right)) pushRange(out, left, 0, left.length);
    else if (ownIn.length === 0) pushRange(out, right, 0, right.length);
    else {
      segments.push(out);
      out = [];
      conflicts.push({ line: start + 1, base: baseLines.slice(start, end), ours: left, theirs: right });
    }
    pos = end;
  }
  pushRange(out, baseLines, pos, baseLines.length);
  if (conflicts.length === 0) return { clean: true, text: out.join("") };
  segments.push(out);
  return { clean: false, segments, conflicts };
}

/** A conflict marker line (git's), with or without a label: such a line left in a resolved hunk means it was not resolved. */
const MARKER = /^(?:<{7}|\|{7}|>{7})(?: .*)?$|^={7}$/;

/** Whether a line (its ending removed) is a conflict marker. */
export function isMarker(line: string): boolean {
  return MARKER.test(line.replace(/\r?\n$/, ""));
}

/** The first position at or after `from` where `pattern` occurs in `lines` as a run, ending by `limit`; -1 when it does not. */
function findRun(lines: readonly string[], pattern: readonly string[], from: number, limit: number): number {
  if (pattern.length === 0) return from <= limit ? from : -1;
  for (let at = from; at + pattern.length <= limit; at++) {
    let k = 0;
    while (k < pattern.length && lines[at + k] === pattern[k]) k++;
    if (k === pattern.length) return at;
  }
  return -1;
}

/** How many leading lines two lists share. */
function sharedHead(a: readonly string[], b: readonly string[]): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/** The result of checking a merged text: each conflicting hunk's resolution, or what is wrong (a phrase after "the merge of <path>"). */
export type MergedCheck = { ok: true; resolutions: string[][] } | { ok: false; problem: string };

/** Placements of segments a check tries at most before it gives up (lines that repeat can make many). */
const PLACEMENT_STEPS = 20_000;

/** Whether lines [from, to) of `lines` are exactly `want`. */
function runIs(lines: readonly string[], from: number, to: number, want: readonly string[]): boolean {
  if (to - from !== want.length) return false;
  for (let q = 0; q < want.length; q++) if (lines[from + q] !== want[q]) return false;
  return true;
}

/**
 * Hold a merged text to both changes. Every segment of the merge (the lines outside the conflicting hunks, with both
 * changes' edits there applied) must come back exactly and in order: the first at the start, the last at the end, each
 * one between them after the one before. Whatever lies between two segments resolves the conflict there; it must not be
 * trunk's version, the change's version or the base's version of the hunk whole, and must not keep a conflict marker
 * the versions did not have. (Empty is allowed: two deletions merge to nothing.) Where lines repeat, a segment can
 * fit in more than one place: every placement is tried, and the text is refused when any of them shows a hunk resolved
 * to one side's version whole, or when there are too many to try.
 */
export function checkMerged(m: ConflictedMerge, merged: string): MergedCheck {
  const lines = splitLines(merged);
  const k = m.conflicts.length;
  const head = m.segments[0] ?? [];
  const tail = m.segments[k] ?? [];
  if (lines.length < head.length + tail.length) return { ok: false, problem: "is shorter than the lines both changes left as they are" };
  const firstOff = sharedHead(lines, head);
  if (firstOff < head.length) return { ok: false, problem: `changes or drops line ${firstOff + 1}, which is outside the conflicting hunks` };
  const tailAt = lines.length - tail.length;
  for (let q = 0; q < tail.length; q++) {
    if (lines[tailAt + q] !== tail[q]) return { ok: false, problem: `changes or drops the lines after the last conflicting hunk (from line ${tailAt + 1} of the merged text)` };
  }
  // The first placement of every segment (each at the first place it fits): it exists exactly when any placement does.
  const resolutions: string[][] = [];
  let at = head.length;
  for (let c = 1; c < k; c++) {
    const seg = m.segments[c]!;
    const found = findRun(lines, seg, at, tailAt);
    if (found < 0) {
      return { ok: false, problem: `does not keep the lines between the conflicting hunks at lines ${m.conflicts[c - 1]!.line} and ${m.conflicts[c]!.line} of the base as both changes left them` };
    }
    resolutions.push(lines.slice(at, found));
    at = found + seg.length;
  }
  resolutions.push(lines.slice(at, tailAt));

  // What is wrong with lines [from, to) as the resolution of conflict c, or null.
  const wrong = (c: number, from: number, to: number): string | null => {
    const v = m.conflicts[c]!;
    const where = `the conflicting hunk at line ${v.line} of the base`;
    if (runIs(lines, from, to, v.ours)) return `takes trunk's version of ${where} whole, which drops the change's edit there`;
    if (runIs(lines, from, to, v.theirs)) return `takes the change's version of ${where} whole, which drops the edit that landed first`;
    if (runIs(lines, from, to, v.base)) return `puts back the base version of ${where}, which drops both changes there`;
    const known = [...v.base, ...v.ours, ...v.theirs].some(isMarker);
    if (!known) for (let q = from; q < to; q++) if (isMarker(lines[q]!)) return `leaves a conflict marker in ${where}`;
    return null;
  };
  // Every placement: from conflict c's resolution starting at p, the first problem any completion shows (null when
  // every completion is fine), or undefined when nothing completes. Memoized by (c, p); bounded by PLACEMENT_STEPS.
  const memo = new Map<number, string | null | undefined>();
  let steps = 0;
  const tooMany = "repeats lines so often that its conflicting hunks cannot be told apart";
  const worst = (c: number, p: number): string | null | undefined => {
    if (c === k - 1) return wrong(c, p, tailAt);
    const key = c * (lines.length + 1) + p;
    if (memo.has(key)) return memo.get(key);
    const seg = m.segments[c + 1]!;
    let completes = false;
    let problem: string | null = null;
    for (let q = findRun(lines, seg, p, tailAt); q >= 0; q = findRun(lines, seg, q + 1, tailAt)) {
      if (++steps > PLACEMENT_STEPS) throw new Error(tooMany);
      const rest = worst(c + 1, q + seg.length);
      if (rest === undefined) continue;
      completes = true;
      problem = wrong(c, p, q) ?? rest;
      if (problem !== null) break;
    }
    const out = completes ? problem : undefined;
    memo.set(key, out);
    return out;
  };
  let problem: string | null | undefined;
  try {
    problem = worst(0, head.length);
  } catch {
    return { ok: false, problem: tooMany };
  }
  if (problem) return { ok: false, problem };
  return { ok: true, resolutions };
}

/** Conflicts as stored or received, each field checked (anything else is dropped, never thrown on); at most `max`. */
export function cleanConflicts(v: unknown, max = 64): MergeConflict[] {
  if (!Array.isArray(v)) return [];
  const sha = (x: unknown): x is Sha => typeof x === "string" && /^[0-9a-f]{40}$/.test(x);
  const out: MergeConflict[] = [];
  const seen = new Set<Path>();
  for (const x of v.slice(0, max)) {
    if (!x || typeof x !== "object") continue;
    const o = x as Record<string, unknown>;
    if (typeof o.path !== "string" || o.path === "" || seen.has(o.path) || !sha(o.base) || !sha(o.trunk) || !sha(o.theirs)) continue;
    const lines = (Array.isArray(o.lines) ? o.lines : []).filter((n): n is number => typeof n === "number" && Number.isInteger(n) && n > 0).slice(0, 50);
    seen.add(o.path);
    out.push({ path: o.path, base: o.base, trunk: o.trunk, theirs: o.theirs, lines });
  }
  return out;
}

/** A `resolves` record as stored or received, checked (ids and paths only); null when it is not one. */
export function cleanResolves(v: unknown): NoteResolves | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.proposalId !== "string" || o.proposalId === "") return null;
  const strings = (x: unknown, max: number): string[] => [...new Set(Array.isArray(x) ? x.filter((s): s is string => typeof s === "string" && s !== "" && s.length <= 4_096) : [])].slice(0, max);
  return { proposalId: o.proposalId, landingIds: strings(o.landingIds, 20), paths: strings(o.paths, 20) };
}

/**
 * The `resolves` field of a lineage note entry: what the change the platform's resolver wrote resolves, as the colony
 * handed it to the trunk writer (keyed by the resolver's proposal id). Nothing for other proposals.
 */
export function noteResolves(all: Record<Id, unknown> | undefined, proposalId: Id): { resolves?: NoteResolves } {
  if (!all || typeof all !== "object" || !Object.hasOwn(all, proposalId)) return {};
  const r = cleanResolves(all[proposalId]);
  return r ? { resolves: r } : {};
}
