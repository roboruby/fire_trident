/**
 * How the MCP server-side waits (take and inbox with `wait`) ask the colony again. A wait of up to 45 s used to ask once
 * a second, 45 colony calls for one tool call. Now the gaps grow, 1 s, 2 s, 4 s and then POLL_MAX_MS, so a long wait
 * asks about a dozen times; and when something changes (the watched proposal moves to another status) the next ask comes
 * after POLL_FIRST_MS again, since the next change often follows soon. The answer itself is never delayed: a wait ends
 * on the ask that sees the news, and the last ask lands at the deadline.
 */

/** The first gap between two asks, and the longest. */
export const POLL_FIRST_MS = 1_000;
export const POLL_MAX_MS = 5_000;

/** The gap before the n-th ask again (n from 1): 1 s, 2 s, 4 s, then POLL_MAX_MS. */
export function pollGapMs(n: number): number {
  const k = Number.isFinite(n) ? Math.max(1, Math.floor(n)) : 1;
  return Math.min(POLL_MAX_MS, POLL_FIRST_MS * 2 ** Math.min(k - 1, 16));
}

/** Gaps between asks: `next` gives the gap to wait now, `reset` starts over after a change. */
export class PollBackoff {
  private n = 0;

  /** The gap before the next ask, growing with each one. */
  next(): number {
    this.n += 1;
    return pollGapMs(this.n);
  }

  /** Something changed: the next ask comes after POLL_FIRST_MS again. */
  reset(): void {
    this.n = 0;
  }
}
