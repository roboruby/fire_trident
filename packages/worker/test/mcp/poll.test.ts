import { describe, expect, it } from "vitest";
import { POLL_FIRST_MS, POLL_MAX_MS, PollBackoff, pollGapMs } from "../../src/mcp/poll.ts";

/** The server-side waits' gaps between asks (mcp/poll.ts): growing to a cap, starting over after a change. */

describe("poll gaps", () => {
  it("grow 1 s, 2 s, 4 s, then stay at the cap", () => {
    expect([1, 2, 3, 4, 5, 50].map(pollGapMs)).toEqual([1_000, 2_000, 4_000, POLL_MAX_MS, POLL_MAX_MS, POLL_MAX_MS]);
    expect(pollGapMs(0)).toBe(POLL_FIRST_MS);
    expect(pollGapMs(Number.NaN)).toBe(POLL_FIRST_MS);
  });

  it("ask about a dozen times in a 45 s wait instead of 45, and start over after a change", () => {
    const b = new PollBackoff();
    let t = 0;
    let asks = 1;
    while (t + POLL_FIRST_MS <= 45_000) {
      t += Math.min(b.next(), 45_000 - t);
      asks++;
    }
    expect(t).toBe(45_000);
    expect(asks).toBe(12);
    b.reset();
    expect(b.next()).toBe(POLL_FIRST_MS);
  });
});
