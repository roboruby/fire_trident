import type { Path } from "@fire_trident/core";

/**
 * Line diffs for review: Myers' O(ND) algorithm on the lines between the common prefix and
 * suffix, rendered as compact unified hunks. Pure: no I/O.
 */

/** One line of an edit script: kept, removed from the old text, or added in the new one. */
export interface DiffOp {
  kind: "=" | "-" | "+";
  text: string;
  /** 0-based line in the old text (for "=" and "-"). */
  a: number;
  /** 0-based line in the new text (for "=" and "+"). */
  b: number;
}

/** What one changed file looks like to a reviewer. */
export interface FileDiff {
  path: Path;
  status: "added" | "deleted" | "modified" | "binary" | "unreadable";
  added: number;
  removed: number;
  /** Unified hunks with line numbers and context, cut to the character budget. */
  hunks: string;
  truncated: boolean;
  /** Every added line (capped), for screening. */
  addedLines: string[];
  /** Every removed line (capped). */
  removedLines: string[];
}

/** Edit distance above which the middle of a file is shown as one replaced block. */
const MAX_EDIT = 1_500;
/** Added/removed lines kept per file for screening. */
const KEEP_LINES = 2_000;

/** Split text into lines (\n, \r\n or \r); a trailing newline does not make an empty last line. */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split(/\r\n|\r|\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Myers' shortest edit script between `a` and `b` (line arrays), or null when it is longer than `maxD`. */
function myers(a: string[], b: string[], maxD: number): DiffOp[] | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, maxD);
  const offset = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice());
    const next = v.slice();
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) x = v[offset + k + 1]!;
      else x = v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      next[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    v = next;
  }
  if (found < 0) return null;
  // Walk the trace back from (n, m).
  const ops: DiffOp[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const vd = trace[d]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && vd[offset + k - 1]! < vd[offset + k + 1]!) ? k + 1 : k - 1;
    const prevX = vd[offset + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      ops.push({ kind: "=", text: a[x]!, a: x, b: y });
    }
    if (x === prevX) {
      y--;
      ops.push({ kind: "+", text: b[y]!, a: x, b: y });
    } else {
      x--;
      ops.push({ kind: "-", text: a[x]!, a: x, b: y });
    }
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    ops.push({ kind: "=", text: a[x]!, a: x, b: y });
  }
  return ops.reverse();
}

/**
 * The edit script turning `before` into `after`: common prefix and suffix are matched first,
 * the middle by Myers' algorithm; a middle needing more than MAX_EDIT edits is shown as one
 * removed block followed by one added block.
 */
export function diffLines(before: string[], after: string[]): DiffOp[] {
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head++;
  let tail = 0;
  while (tail < before.length - head && tail < after.length - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  const ops: DiffOp[] = [];
  for (let i = 0; i < head; i++) ops.push({ kind: "=", text: before[i]!, a: i, b: i });
  const midA = before.slice(head, before.length - tail);
  const midB = after.slice(head, after.length - tail);
  const mid = myers(midA, midB, MAX_EDIT);
  if (mid) {
    for (const op of mid) ops.push({ ...op, a: op.a + head, b: op.b + head });
  } else {
    midA.forEach((text, i) => ops.push({ kind: "-", text, a: head + i, b: head }));
    midB.forEach((text, i) => ops.push({ kind: "+", text, a: head + midA.length, b: head + i }));
  }
  for (let i = 0; i < tail; i++) {
    ops.push({ kind: "=", text: before[before.length - tail + i]!, a: before.length - tail + i, b: after.length - tail + i });
  }
  return ops;
}

/** Unified hunks ("@@ -a,b +c,d @@") with `context` lines around each change. */
export function renderHunks(ops: DiffOp[], context = 2): string {
  const changed = ops.map((op, i) => (op.kind === "=" ? -1 : i)).filter((i) => i >= 0);
  if (changed.length === 0) return "";
  const out: string[] = [];
  let i = 0;
  while (i < changed.length) {
    const start = Math.max(0, changed[i]! - context);
    let end = Math.min(ops.length - 1, changed[i]! + context);
    let j = i + 1;
    while (j < changed.length && changed[j]! - context <= end + 1) {
      end = Math.min(ops.length - 1, changed[j]! + context);
      j++;
    }
    const slice = ops.slice(start, end + 1);
    const first = slice[0]!;
    const oldCount = slice.filter((op) => op.kind !== "+").length;
    const newCount = slice.filter((op) => op.kind !== "-").length;
    out.push(`@@ -${first.a + 1},${oldCount} +${first.b + 1},${newCount} @@`);
    for (const op of slice) out.push(`${op.kind === "=" ? " " : op.kind}${op.text}`);
    i = j;
  }
  return out.join("\n");
}

/** Cut text to `max` characters on a line boundary, marking the cut. */
export function clip(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const cut = text.lastIndexOf("\n", max);
  return { text: `${text.slice(0, cut > max / 2 ? cut : max)}\n… (truncated)`, truncated: true };
}

/**
 * Review diff of one file. `before`/`after` are the old and new text (null when absent);
 * `binary` marks content that is not text. Hunks are cut to `maxChars`.
 */
export function fileDiff(path: Path, before: string | null, after: string | null, opts: { binary?: boolean; unreadable?: boolean; maxChars?: number; context?: number } = {}): FileDiff {
  const base = { path, hunks: "", truncated: false, addedLines: [] as string[], removedLines: [] as string[] };
  if (opts.unreadable) return { ...base, status: "unreadable", added: 0, removed: 0 };
  if (opts.binary) return { ...base, status: "binary", added: 0, removed: 0 };
  const a = before === null ? [] : splitLines(before);
  const b = after === null ? [] : splitLines(after);
  const ops = diffLines(a, b);
  const addedLines = ops.filter((o) => o.kind === "+").map((o) => o.text);
  const removedLines = ops.filter((o) => o.kind === "-").map((o) => o.text);
  const clipped = clip(renderHunks(ops, opts.context ?? 2), opts.maxChars ?? 2_000);
  return {
    path,
    status: before === null ? "added" : after === null ? "deleted" : "modified",
    added: addedLines.length,
    removed: removedLines.length,
    hunks: clipped.text,
    truncated: clipped.truncated,
    addedLines: addedLines.slice(0, KEEP_LINES),
    removedLines: removedLines.slice(0, KEEP_LINES),
  };
}

/** Added lines recovered from rendered hunks ("+" lines, without the marker). */
export function addedFromHunks(hunks: string): string[] {
  return hunks
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .map((l) => l.slice(1));
}
