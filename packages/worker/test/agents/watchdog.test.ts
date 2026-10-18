import { describe, expect, it } from "vitest";
import { BUSY_MIN_MS, WATCHDOG_MS, busyAlarmAt } from "../../src/agents/watchdog.ts";

/** An alarm that finds a tick still running (agents/watchdog.ts): it comes back in a minute, not every second. */

describe("busyAlarmAt", () => {
  it("re-arms WATCHDOG_MS ahead while the running tick's step runs", () => {
    expect(busyAlarmAt(1_000_000, null)).toBe(1_000_000 + WATCHDOG_MS);
    expect(WATCHDOG_MS).toBe(60_000);
  });

  it("keeps the next alarm a finishing tick chose, held to between one second and the watchdog", () => {
    expect(busyAlarmAt(1_000_000, 1_000_000 + 20_000)).toBe(1_020_000);
    expect(busyAlarmAt(1_000_000, 1_000_000)).toBe(1_000_000 + BUSY_MIN_MS);
    expect(busyAlarmAt(1_000_000, 1_000_000 + 10 * WATCHDOG_MS)).toBe(1_000_000 + WATCHDOG_MS);
    expect(busyAlarmAt(1_000_000, Number.NaN)).toBe(1_000_000 + WATCHDOG_MS);
  });

  it("a long step that outlives its handler costs one alarm a minute, not sixty", () => {
    let now = 0;
    let fired = 0;
    // Ten minutes of a leftover tick: each alarm that finds it running sets the next.
    for (let at = busyAlarmAt(now, null); at <= 10 * 60_000; at = busyAlarmAt(now, null)) {
      now = at;
      fired++;
    }
    expect(fired).toBe(10);
  });
});
