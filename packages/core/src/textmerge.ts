import type { Path, Sha } from "./types.ts";

/**
 * Text merge: a deterministic line-based three-way merge, for a change that is stale only on files it writes (the
 * trunk writer's FT_TEXT_MERGE). Three versions of a file meet: the change's base (what it started from), ours (the
 * version it would land on) and theirs (what the change wrote). Each version is split into lines that keep their own
 * endings ("\n" or "\r\n"; the last line may have none), and each side is diffed against the base. Edits to separate
 * regions of the base merge; the same edit made on both sides counts once; different edits that overlap, or that touch
 * with no unchanged base line between them, conflict, as git's default merge decides. Lines are copied whole from the
 * versions, so line endings and the final newline come out as the inputs have them. Pure and synchronous.
 */

/** Largest version of a file (bytes) a text merge reads; a larger one is not merged. */
export const MERGE_FILE_BYTES = 512 * 1024;
/** Bytes of each version looked at for a NUL byte (as git does): one there means binary content, which is never merged. */
export const MERGE_SNIFF_BYTES = 8_000;
/** Lines one side may insert plus delete against the base, past what both sides share, before a merge gives up. */
export const MERGE_MAX_EDITS = 1_000;

/** What a three-way merge of one file gives: the merged text, or the conflicts that stop it. */
export type TextMergeResult =
  | { clean: true; text: string }
  | {
      clean: false;
      /** Conflicting hunks: regions of the base that both sides changed differently, or changed side by side. */
      conflicts: number;
      /** Where each starts, as a 1-based line of the base (one past its last line for an insertion at the end). */
      lines: number[];
      /** The sides were not compared: one changed more than the edit limit (MERGE_MAX_EDITS); `conflicts` is 0. */
      limited?: true;
    };

/**
 * One file a change landed merged, as its lineage note records it: the change's base blob, the blob it merged with
 * (trunk's, or that of a change landing ahead of it in the same cycle), the blob the change wrote, and the result.
 */
export interface TextMerged {
  path: Path;
  base: Sha;
  trunk: Sha;
  theirs: Sha;
  result: Sha;
}

/** One hunk of a line diff: lines [a0, a1) of the first sequence became lines [b0, b1) of the second. */
export interface LineHunk {
  a0: number;
  a1: number;
  b0: number;
  b1: number;
}

/** Lockfiles by exact name (lowercase): generated, so a line merge could leave them inconsistent; they are regenerated. */
const LOCKFILE_NAMES = new Set(["npm-shrinkwrap.json", "go.sum", "go.work.sum", "package.resolved"]);
/** Lockfile name endings (lowercase): yarn.lock, cargo.lock, gemfile.lock, poetry.lock, bun.lockb, package-lock.json, ... */
const LOCKFILE_ENDINGS = [".lock", ".lockb", ".lockfile", "-lock.json", "-lock.yaml", "-lock.yml", ".lock.json"];

/** Whether a path names a dependency lockfile (package-lock.json, yarn.lock, pnpm-lock.yaml, Cargo.lock, go.sum, ...). */
export function isLockfile(path: Path): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  return LOCKFILE_NAMES.has(name) || LOCKFILE_ENDINGS.some((end) => name.endsWith(end));
}

/** Bytes one UTF-16 unit at `i` of `text` takes in UTF-8, and how many units it spans (a lone surrogate is U+FFFD, 3 bytes). */
function utf8Step(text: string, i: number): { bytes: number; units: number } {
  const c = text.charCodeAt(i);
  if (c < 0x80) return { bytes: 1, units: 1 };
  if (c < 0x800) return { bytes: 2, units: 1 };
  if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
    const d = text.charCodeAt(i + 1);
    if (d >= 0xdc00 && d <= 0xdfff) return { bytes: 4, units: 2 };
  }
  return { bytes: 3, units: 1 };
}

/** The UTF-8 byte length of a text, as TextEncoder would write it. */
export function utf8Length(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; ) {
    const s = utf8Step(text, i);
    n += s.bytes;
    i += s.units;
  }
  return n;
}

/** Whether the first `limit` bytes of a text's UTF-8 form hold a NUL byte (only U+0000 encodes to one). */
function nulWithin(text: string, limit: number): boolean {
  let bytes = 0;
  for (let i = 0; i < text.length && bytes < limit; ) {
    if (text.charCodeAt(i) === 0) return true;
    const s = utf8Step(text, i);
    bytes += s.bytes;
    i += s.units;
  }
  return false;
}

/**
 * Why these versions of a file cannot be text-merged, or null when they can: one is larger than MERGE_FILE_BYTES, or
 * holds a NUL byte in its first MERGE_SNIFF_BYTES bytes (binary). A version is its text or its bytes.
 */
export function mergeContentProblem(versions: ReadonlyArray<string | Uint8Array>): string | null {
  for (const v of versions) {
    const size = typeof v === "string" ? utf8Length(v) : v.length;
    if (size > MERGE_FILE_BYTES) return `larger than ${MERGE_FILE_BYTES / 1024} KB`;
    if (typeof v === "string" ? nulWithin(v, MERGE_SNIFF_BYTES) : v.subarray(0, MERGE_SNIFF_BYTES).includes(0)) return "binary";
  }
  return null;
}

/** Why a file cannot be text-merged, or null when it can: a lockfile, or a version too large or binary (mergeContentProblem). */
export function mergeProblem(path: Path, versions: ReadonlyArray<string | Uint8Array>): string | null {
  if (isLockfile(path)) return "a lockfile";
  return mergeContentProblem(versions);
}

/** A text's lines, each keeping its ending, so that joining them gives the text back: "a\r\nb\n" is ["a\r\n", "b\n"], "a\nb" is ["a\n", "b"]. */
export function splitLines(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let nl = text.indexOf("\n"); nl >= 0; nl = text.indexOf("\n", start)) {
    out.push(text.slice(start, nl + 1));
    start = nl + 1;
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

/**
 * The hunks that turn sequence `a` into sequence `b` (lines as numbers: equal lines, equal numbers), in order and
 * separated by at least one unchanged line. A shortest edit script (Myers' greedy algorithm) over what is left once the
 * common head and tail are set aside; null when that needs more than `maxEdits` inserted plus deleted lines.
 */
export function lineDiff(a: ArrayLike<number>, b: ArrayLike<number>, maxEdits = MERGE_MAX_EDITS): LineHunk[] | null {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const n = a.length - head - tail;
  const m = b.length - head - tail;
  if (n === 0 && m === 0) return [];
  if (n === 0 || m === 0) return [{ a0: head, a1: head + n, b0: head, b1: head + m }];
  // v[k + off]: how far along a (x) the furthest path with d edits reaches on diagonal k = x - y. A copy is kept per d
  // (the values the step read, diagonals -d-1..d+1) to walk the path back.
  const limit = Math.min(n + m, Number.isNaN(maxEdits) ? MERGE_MAX_EDITS : Math.max(0, Math.floor(maxEdits)));
  const off = limit + 1;
  const v = new Int32Array(2 * limit + 3);
  const trace: Int32Array[] = [];
  let depth = -1;
  search: for (let d = 0; d <= limit; d++) {
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!) ? v[off + k + 1]! : v[off + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[head + x] === b[head + y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        depth = d;
        break search;
      }
    }
  }
  if (depth < 0) return null;
  // Walk back from the end (cx, cy), keeping each run of equal lines (x, y, length), last first.
  const runs: Array<[number, number, number]> = [];
  let cx = n;
  let cy = m;
  for (let d = depth; d > 0; d--) {
    const t = trace[d]!;
    const k = cx - cy;
    const down = k === -d || (k !== d && t[k + d]! < t[k + d + 2]!);
    const pk = down ? k + 1 : k - 1;
    const px = t[pk + d + 1]!;
    const sx = down ? px : px + 1;
    if (cx > sx) runs.push([sx, sx - k, cx - sx]);
    cx = px;
    cy = px - pk;
  }
  if (cx > 0) runs.push([0, 0, cx]);
  runs.reverse();
  const hunks: LineHunk[] = [];
  let ax = 0;
  let by = 0;
  for (const [rx, ry, len] of runs) {
    if (rx > ax || ry > by) hunks.push({ a0: head + ax, a1: head + rx, b0: head + by, b1: head + ry });
    ax = rx + len;
    by = ry + len;
  }
  if (ax < n || by < m) hunks.push({ a0: head + ax, a1: head + n, b0: head + by, b1: head + m });
  return hunks;
}

/** Push `items[from..to)` onto `out` (no spread: a large file has more lines than a call takes arguments). */
function pushRange(out: string[], items: readonly string[], from: number, to: number): void {
  for (let i = from; i < to; i++) out.push(items[i]!);
}

/**
 * Merge two edits of one text. `base` is the version both started from, `ours` the version the merge lands on, and
 * `theirs` the change being merged. Each side is diffed against the base (lineDiff); a hunk only one side has is
 * applied, and hunks of the two sides that overlap or touch form one region: the same lines on both sides land once,
 * anything else is a conflict. Clean: the merged text. Otherwise the conflicting hunks, or `limited` when a side
 * changed more than `maxEdits` lines.
 */
export function mergeText(base: string, ours: string, theirs: string, maxEdits = MERGE_MAX_EDITS): TextMergeResult {
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
  if (mine === null || other === null) return { clean: false, conflicts: 0, lines: [], limited: true };
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
  const out: string[] = [];
  const conflicts: number[] = [];
  let pos = 0;
  let i = 0;
  let j = 0;
  while (i < mine.length || j < other.length) {
    // A region starts at the earliest hunk left and takes in every hunk of either side that starts before it ends or
    // right where it ends (git's rule: edits with no unchanged base line between them conflict).
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
    if (otherIn.length === 0 || (left.length === right.length && left.every((line, q) => line === right[q]))) pushRange(out, left, 0, left.length);
    else if (ownIn.length === 0) pushRange(out, right, 0, right.length);
    else conflicts.push(start + 1);
    pos = end;
  }
  if (conflicts.length > 0) return { clean: false, conflicts: conflicts.length, lines: conflicts };
  pushRange(out, baseLines, pos, baseLines.length);
  return { clean: true, text: out.join("") };
}
