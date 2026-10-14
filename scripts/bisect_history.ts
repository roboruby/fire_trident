/**
 * The history scripts/bisect.ts lands since the green certification, and what the first red search
 * (packages/worker/src/certify/bisect.ts) should make of it. The check and the demo land n changes with certification
 * held: the change at position k (counted from the first since green) breaks sub(), the others each add a small note
 * file. The search then tries the red commit first and halves the landings left until one remains, so the runs it
 * needs follow from n and k alone. The functions here say how many, so the script can print the fewest possible beside
 * what the search used, and refuse a history the search's bounds cannot settle.
 */

/** The history when --landings is absent: six landings, as the check and the demo always landed. */
export const DEFAULT_LANDINGS = 6;

/**
 * The search's bounds, as certify/bisect.ts (MAX_PROBES) and certify/range.ts (RANGE_MAX) set them: test runs a
 * search uses at most, and landings since green the landing log answers for at most. Repeated here because the script
 * runs outside the worker; the tests read both source files and fail when these drift.
 */
export const SEARCH_RUNS = 8;
export const SEARCH_LANDINGS = 512;

/**
 * The longest history the runs settle whatever the position: the red commit, then SEARCH_RUNS - 1 halvings, which
 * settle up to 2^(SEARCH_RUNS - 1) landings. Longer ones settle only at the positions whose halvings keep landing on the
 * smaller half, and none settle past twice this.
 */
export const SETTLED_LANDINGS = 2 ** (SEARCH_RUNS - 1);

/** floor(log2 n) for a positive whole number, exactly (the bit length minus one). */
function floorLog2(n: number): number {
  return 31 - Math.clz32(n);
}

/** Where the breaking change goes when --break-at is absent: the middle landing (the fourth of six, as before). */
export function defaultBreakAt(n: number): number {
  return Math.floor(n / 2) + 1;
}

/**
 * The fewest runs a search over n landings can take: ceil(log2(n + 1)), which is one run for the red commit plus
 * floor(log2 n) halvings. Each halving keeps the smaller or the larger half of the landings left, so the halvings
 * stop at one landing after floor(log2 n) of them at best and ceil(log2 n) at worst (the same when n is a power of two).
 */
export function minimumRuns(n: number): number {
  return 1 + floorLog2(n);
}

/** The most runs a search over n landings takes when it settles: the red commit, then ceil(log2 n) halvings. */
export function mostRuns(n: number): number {
  const exact = (n & (n - 1)) === 0;
  return 1 + floorLog2(n) + (exact ? 0 : 1);
}

/** What the search would do with one history: its runs, and whether SEARCH_RUNS settle it on the breaking landing. */
export interface Prediction {
  runs: number;
  settled: boolean;
  /** Settled: the position (from 1) the search names, which is the break's. */
  found?: number;
  /** Not settled: the landings the search had narrowed the first failing commit to when its runs ran out. */
  narrowed?: number;
}

/**
 * Replay the search's halving (certify/bisect.ts searchFirstRed) on a history whose landings from position k on fail:
 * the red commit first, then the middle of what is left (rounded down) until one landing is left or SEARCH_RUNS are
 * used. The exact count for one history; minimumRuns and mostRuns bracket it.
 */
export function predictRuns(n: number, k: number): Prediction {
  const red = (index: number): boolean => index >= k - 1;
  // The red commit, which fails.
  let runs = 1;
  let lo = -1;
  let hi = n - 1;
  while (hi - lo > 1) {
    if (runs >= SEARCH_RUNS) return { runs, settled: false, narrowed: hi - lo };
    const mid = Math.floor((lo + hi) / 2);
    runs++;
    if (red(mid)) hi = mid;
    else lo = mid;
  }
  return { runs, settled: true, found: hi + 1 };
}

/** One landing of the history: a note file (numbered from 1 in order, the break skipped), or the change that breaks sub(). */
export type HistoryLanding = { kind: "note"; title: string; note: number } | { kind: "break"; title: string };

/** The n landings in order with the break at position k: for 6 and 4, notes 1 to 3, the break, then notes 4 and 5. */
export function history(n: number, k: number): HistoryLanding[] {
  const out: HistoryLanding[] = [];
  let note = 0;
  for (let position = 1; position <= n; position++) {
    if (position === k) out.push({ kind: "break", title: "Speed up subtraction" });
    else {
      note++;
      out.push({ kind: "note", title: `Add note ${note}`, note });
    }
  }
  return out;
}
