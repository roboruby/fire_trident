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
 * resolved to text that is neither side's version whole (that would drop the other side's change), nor the base's, and
 * that keeps, in each side's order, every line that side added there (keptLines): only a line rewriting a base line the
 * other side also rewrote or deleted may be combined, and a line the other side deleted may go.
 */

/** A three-way merge of one file split at its conflicts: the clean text between them and each conflict's versions. */
export interface ConflictedMerge {
  /** Merged lines (each with its line ending) before the first conflict, between conflicts, and after the last: one more than `conflicts`. */
  segments: string[][];
  /**
   * Each conflicting hunk: where it starts in the base (1-based), the base, trunk ("ours") and change ("theirs") lines, and
   * where trunk's and the change's lines start in their own versions of the file (1-based).
   */
  conflicts: Array<{ line: number; base: string[]; ours: string[]; theirs: string[]; oursLine: number; theirsLine: number }>;
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
  const intern = interner();
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
      // Each side's version of the region starts where its first hunk there says (no hunk of its own lies between).
      const oursLine = start + ownIn[0]!.b0 - ownIn[0]!.a0 + 1;
      const theirsLine = start + otherIn[0]!.b0 - otherIn[0]!.a0 + 1;
      conflicts.push({ line: start + 1, base: baseLines.slice(start, end), ours: left, theirs: right, oursLine, theirsLine });
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

/** A line one side added in a conflicting hunk, which every resolution of the hunk keeps (keptLines). */
export interface KeptLine {
  /** Its text as kept lines compare (keptKey). */
  text: string;
  /** Its line in that side's version of the file (1-based). */
  line: number;
}

/**
 * A line as kept lines compare: trimmed, without one trailing comma or semicolon. Indentation, the line ending and the
 * separator a joined list needs may change in a merge; the text may not.
 */
export function keptKey(line: string): string {
  return line.trim().replace(/[,;]$/, "").trimEnd();
}

/** Likeness at or above which a line a side wrote counts as a rewrite of the base line it replaced (lineLikeness). */
const REWRITE_LIKENESS = 0.5;
/** Pairs of lines one hunk of a side's diff is compared by at most; past it no line counts as a rewrite (all are kept). */
const PAIR_CELLS = 100_000;
/** Words of a line: letters, digits, `_` and `$` runs. */
const WORDS = /[\p{L}\p{N}_$]+/gu;

/**
 * How alike two lines are, from 0 to 1: 1 when they are equal once trimmed, else the share of words they have in common
 * (twice the shared words over all words, each word counted as often as it occurs). "export const v6 = 6;" and
 * "export const six = 6;" score 0.75; "requireAuth(req);" and "const user = load(req);" score 0.33.
 */
export function lineLikeness(a: string, b: string): number {
  const x = a.trim();
  const y = b.trim();
  if (x === y) return 1;
  const wx = x.match(WORDS) ?? [];
  const wy = y.match(WORDS) ?? [];
  if (wx.length === 0 || wy.length === 0) return 0;
  const left = new Map<string, number>();
  for (const w of wx) left.set(w, (left.get(w) ?? 0) + 1);
  let shared = 0;
  for (const w of wy) {
    const n = left.get(w) ?? 0;
    if (n > 0) {
      shared++;
      left.set(w, n - 1);
    }
  }
  return (2 * shared) / (wx.length + wy.length);
}

/**
 * Which base line each line a side wrote in one hunk of its diff rewrites (an index into `replaced`), or -1 for a line
 * it inserted: the pairing in order that is most alike in total, each pair at least REWRITE_LIKENESS alike. A hunk too
 * large to compare (PAIR_CELLS) pairs nothing, so every line in it counts as inserted.
 */
function rewrites(replaced: readonly string[], added: readonly string[]): Int32Array {
  const k = replaced.length;
  const m = added.length;
  const out = new Int32Array(m).fill(-1);
  if (k === 0 || m === 0 || k * m > PAIR_CELLS) return out;
  const like = new Float64Array(k * m);
  for (let i = 0; i < k; i++) for (let j = 0; j < m; j++) like[i * m + j] = lineLikeness(replaced[i]!, added[j]!);
  // best[(i, j)]: the most alike pairing of replaced[0..i) with added[0..j); step: 1 pair (i-1, j-1), 2 skip i-1, 3 skip j-1.
  const w = m + 1;
  const best = new Float64Array((k + 1) * w);
  const step = new Uint8Array((k + 1) * w);
  for (let i = 1; i <= k; i++) {
    for (let j = 1; j <= m; j++) {
      let v = best[(i - 1) * w + j]!;
      let s = 2;
      if (best[i * w + j - 1]! > v) {
        v = best[i * w + j - 1]!;
        s = 3;
      }
      const l = like[(i - 1) * m + j - 1]!;
      if (l >= REWRITE_LIKENESS && best[(i - 1) * w + j - 1]! + l > v) {
        v = best[(i - 1) * w + j - 1]! + l;
        s = 1;
      }
      best[i * w + j] = v;
      step[i * w + j] = s;
    }
  }
  for (let i = k, j = m; i > 0 && j > 0; ) {
    const s = step[i * w + j];
    if (s === 1) out[--j] = --i;
    else if (s === 2) i--;
    else j--;
  }
  return out;
}

/** Lines as numbers, equal lines equal numbers (one numbering for every list passed to the same interner). */
function interner(): (lines: readonly string[]) => Int32Array {
  const ids = new Map<string, number>();
  return (lines) => {
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
}

/**
 * The lines each side added in one conflicting hunk that every resolution of it keeps, in that side's order. A side's
 * added lines are the ones its line diff of the hunk (against the base) writes. Of these, a line goes free only when the
 * other side deleted it, that is when it rewrites a base line the other side also rewrote or deleted (the two rewrites
 * meet there, and the merge may write one line doing both; review judges it), or its text is that of a base line the
 * other side deleted (a line it moved or kept that the other side took out). Blank lines are never kept by rule.
 * Lines compare by keptKey (indentation, line ending and a trailing comma or semicolon aside). When a side's diff cannot
 * be computed (never within the merge's own edit limit), every non-blank line it has in the hunk is kept.
 */
export function keptLines(v: ConflictedMerge["conflicts"][number]): { ours: KeptLine[]; theirs: KeptLine[] } {
  const intern = interner();
  const base = intern(v.base);
  const diffs = { ours: lineDiff(base, intern(v.ours), MERGE_MAX_EDITS), theirs: lineDiff(base, intern(v.theirs), MERGE_MAX_EDITS) };
  const side = (lines: readonly string[], start: number, mine: LineHunk[] | null, other: LineHunk[] | null): KeptLine[] => {
    const out: KeptLine[] = [];
    if (mine === null || other === null) {
      lines.forEach((line, j) => {
        if (keptKey(line) !== "") out.push({ text: keptKey(line), line: start + j });
      });
      return out;
    }
    const gone = new Uint8Array(v.base.length);
    for (const h of other) for (let i = h.a0; i < h.a1; i++) gone[i] = 1;
    const goneText = new Set<string>();
    for (let i = 0; i < v.base.length; i++) if (gone[i]) goneText.add(keptKey(v.base[i]!));
    for (const h of mine) {
      const pairs = rewrites(v.base.slice(h.a0, h.a1), lines.slice(h.b0, h.b1));
      for (let j = h.b0; j < h.b1; j++) {
        const text = keptKey(lines[j]!);
        if (text === "" || goneText.has(text)) continue;
        const at = pairs[j - h.b0]!;
        if (at >= 0 && gone[h.a0 + at]) continue;
        out.push({ text, line: start + j });
      }
    }
    return out;
  };
  return { ours: side(v.ours, v.oursLine, diffs.ours, diffs.theirs), theirs: side(v.theirs, v.theirsLine, diffs.theirs, diffs.ours) };
}

/**
 * The first of `kept` that lines [from, to) do not keep in order (as a subsequence, compared by keptKey), or null when they
 * keep them all: `reordered` when the lines still hold as many copies of it as `kept` asks for (it moved), else it was dropped.
 */
export function lostLine(lines: readonly string[], from: number, to: number, kept: readonly KeptLine[]): { line: KeptLine; reordered: boolean } | null {
  let q = from;
  for (const want of kept) {
    while (q < to && keptKey(lines[q]!) !== want.text) q++;
    if (q < to) {
      q++;
      continue;
    }
    let have = 0;
    for (let r = from; r < to; r++) if (keptKey(lines[r]!) === want.text) have++;
    const asked = kept.reduce((n, x) => n + (x.text === want.text ? 1 : 0), 0);
    return { line: want, reordered: have >= asked };
  }
  return null;
}

/**
 * Hold a merged text to both changes. Every segment of the merge (the lines outside the conflicting hunks, with both
 * changes' edits there applied) must come back exactly and in order: the first at the start, the last at the end, each
 * one between them after the one before. Whatever lies between two segments resolves the conflict there; it must not be
 * trunk's version, the change's version or the base's version of the hunk whole, must not keep a conflict marker
 * the versions did not have, and must keep every line each side added there in that side's order (keptLines, matched
 * as a subsequence, so lines of the two sides may interleave and a line both added once counts for both). (Empty is
 * allowed: two deletions merge to nothing.) Where lines repeat, a segment can fit in more than one place: every
 * placement is tried, and the text is refused when any of them shows a hunk resolved to one side's version whole or
 * dropping a kept line, or when there are too many to try.
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

  // The lines each side added in each conflicting hunk that its resolution keeps, worked out on first use.
  const kept: Array<ReturnType<typeof keptLines> | undefined> = [];
  // What is wrong with lines [from, to) as the resolution of conflict c, or null.
  const wrong = (c: number, from: number, to: number): string | null => {
    const v = m.conflicts[c]!;
    const where = `the conflicting hunk at line ${v.line} of the base`;
    if (runIs(lines, from, to, v.ours)) return `takes trunk's version of ${where} whole, which drops the change's edit there`;
    if (runIs(lines, from, to, v.theirs)) return `takes the change's version of ${where} whole, which drops the edit that landed first`;
    if (runIs(lines, from, to, v.base)) return `puts back the base version of ${where}, which drops both changes there`;
    const known = [...v.base, ...v.ours, ...v.theirs].some(isMarker);
    if (!known) for (let q = from; q < to; q++) if (isMarker(lines[q]!)) return `leaves a conflict marker in ${where}`;
    // Both edits, by construction: every line a side added there comes back, in that side's order.
    const keep = (kept[c] ??= keptLines(v));
    for (const [who, own, list] of [["trunk", "trunk's", keep.ours], ["the change", "the change's", keep.theirs]] as const) {
      const lost = lostLine(lines, from, to, list);
      if (!lost) continue;
      if (lost.reordered) return `changes the order of the lines ${who} added in ${where} (line ${lost.line.line} of ${own} version is out of order)`;
      return `drops a line ${who} added in ${where} (line ${lost.line.line} of ${own} version)`;
    }
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
