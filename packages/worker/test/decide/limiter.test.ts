import { describe, expect, it } from "vitest";
import { CallLimiter } from "../../src/decide/limiter.ts";

describe("CallLimiter", () => {
  it("caps calls in flight and wakes a waiter on release", async () => {
    const l = new CallLimiter(1, 100);
    const first = await l.acquire("m", Date.now() + 1_000);
    expect(first).not.toBeNull();
    expect(l.active).toBe(1);
    const waiting = l.acquire("m", Date.now() + 1_000);
    first!();
    const second = await waiting;
    expect(second).not.toBeNull();
    expect(l.active).toBe(1);
    second!();
    second!();
    expect(l.active).toBe(0);
  });

  it("caps starts per minute per model and gives up at the deadline", async () => {
    const l = new CallLimiter(10, 2);
    (await l.acquire("m", Date.now() + 100))!();
    (await l.acquire("m", Date.now() + 100))!();
    expect(l.waitFor("m")).toBeGreaterThan(50_000);
    expect(await l.acquire("m", Date.now() + 80)).toBeNull();
    // Another model is not affected.
    expect(await l.acquire("other", Date.now() + 80)).not.toBeNull();
  });

  it("holds a model back during a cooldown", async () => {
    const l = new CallLimiter(10, 100);
    l.cooldown("m", 5_000);
    expect(l.waitFor("m")).toBeGreaterThan(4_000);
    expect(await l.acquire("m", Date.now() + 60)).toBeNull();
  });
});
