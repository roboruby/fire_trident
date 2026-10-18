import { afterEach, describe, expect, it, vi } from "vitest";
import { newId as idFrom } from "@fire_trident/core";
import { cryptoRandom, newId } from "../src/ids.ts";

/** The worker's ids (src/ids.ts): core's format, with the clock and crypto.getRandomValues supplied here. */

afterEach(() => {
  vi.restoreAllMocks();
});

describe("newId (worker)", () => {
  it("keeps core's format: prefix, 8 base36 time digits from the clock, 6 random base36 characters", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_760_000_000_000);
    const id = newId("int_");
    expect(id).toMatch(/^int_[0-9a-z]{14}$/);
    expect(parseInt(id.slice(4, 12), 36)).toBe(1_760_000_000_000);
    expect(newId()).toMatch(/^[0-9a-z]{14}$/);
    // The same time and draws through core give the same text.
    expect(idFrom("int_", 1_760_000_000_000, () => 0)).toBe(`int_${(1_760_000_000_000).toString(36)}000000`);
  });

  it("draws from crypto.getRandomValues, never Math.random, uniform in [0, 1)", () => {
    const random = vi.spyOn(Math, "random");
    const words = vi.spyOn(crypto, "getRandomValues");
    newId("x_");
    expect(words).toHaveBeenCalledTimes(6);
    expect(random).not.toHaveBeenCalled();
    for (let i = 0; i < 1_000; i++) {
      const r = cryptoRandom();
      expect(r >= 0 && r < 1).toBe(true);
    }
  });

  it("does not repeat within one millisecond", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_760_000_000_000);
    expect(new Set(Array.from({ length: 200 }, () => newId())).size).toBe(200);
  });
});
