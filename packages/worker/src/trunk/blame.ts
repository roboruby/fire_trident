// Line tracking across landings (a small blame): which landing last changed a given line.

/** Default cap on diff work (trace cells); larger diffs count as "every line changed". */
const DIFF_BUDGET = 2_000_000;

/**
 * Matching line pairs `[indexInA, indexInB]` of a shortest edit script from `a` to `b`
 * (Myers, after trimming the common prefix and suffix), in increasing order. Null when the
 * diff would exceed `budget` cells of work.
 */
export function matchLines(a: string[], b: string[], budget = DIFF_BUDGET): Array<[number, number]> | null {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const mid = myers(a.slice(start, endA), b.slice(start, endB), budget);
  if (mid === null) return null;
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < start; i++) pairs.push([i, i]);
  for (const [x, y] of mid) pairs.push([x + start, y + start]);
  for (let i = 0; i < a.length - endA; i++) pairs.push([endA + i, endB + i]);
  return pairs;
}

function myers(a: string[], b: string[], budget: number): Array<[number, number]> | null {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return [];
  const max = n + m;
  const size = 2 * max + 1;
  const off = max;
  const v = new Int32Array(size + 1);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    if ((d + 1) * size > budget) return null;
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!) ? v[off + k + 1]! : v[off + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) return backtrack(trace, n, m, off);
    }
  }
  return null;
}

function backtrack(trace: Int32Array[], n: number, m: number, off: number): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!) ? k + 1 : k - 1;
    const prevX = v[off + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      pairs.push([x - 1, y - 1]);
      x--;
      y--;
    }
    x = prevX;
    y = prevY;
  }
  return pairs.reverse();
}

/**
 * Index in `older` of line `newerIndex` (0-based) of `newer`, or null when that line was
 * added or changed between the two versions (or the diff is too large to tell).
 */
export function mapLine(older: string, newer: string, newerIndex: number): number | null {
  const pairs = matchLines(older.split("\n"), newer.split("\n"));
  if (pairs === null) return null;
  for (const [i, j] of pairs) if (j === newerIndex) return i;
  return null;
}
