import { describe, expect, it } from "vitest";
import { branchingRatio, inhibitionFactor } from "../src/sigma.ts";
import type { CausalEvent } from "../src/sigma.ts";

// With the defaults, parents are events in [40_000, 95_000].
const NOW = 100_000;

const ev = (id: string, at: number, causeId?: string): CausalEvent => (causeId === undefined ? { id, at } : { id, at, causeId });

describe("branchingRatio", () => {
  it("is 0 with no events", () => {
    expect(branchingRatio([], NOW)).toBe(0);
  });

  it("is children per parent", () => {
    const events = [ev("p1", 50_000), ev("p2", 60_000), ev("c1", 96_000, "p1"), ev("c2", 97_000, "p1"), ev("c3", 98_000, "p2")];
    expect(branchingRatio(events, NOW)).toBe(1.5);
  });

  it("flags a runaway cascade above 1", () => {
    const events = [ev("p", 50_000), ev("a", 96_000, "p"), ev("b", 97_000, "p"), ev("c", 99_000, "p")];
    expect(branchingRatio(events, NOW)).toBe(3);
  });

  it("is 0 when parents have no children", () => {
    expect(branchingRatio([ev("p1", 50_000), ev("p2", 60_000)], NOW)).toBe(0);
  });

  it("does not use events inside the settle period as parents", () => {
    expect(branchingRatio([ev("r", 96_000), ev("rc", 99_000, "r")], NOW)).toBe(0);
  });

  it("does not use events older than the window as parents", () => {
    // "old" is outside; its child sits in the window, so it is a parent with no children.
    expect(branchingRatio([ev("old", 30_000), ev("child", 50_000, "old")], NOW)).toBe(0);
  });

  it("includes both window boundaries", () => {
    const events = [
      ev("start", 40_000),
      ev("end", 95_000),
      ev("before", 39_999),
      ev("after", 95_001),
      ev("c1", 99_000, "start"),
      ev("c2", 99_000, "end"),
      ev("c3", 99_000, "before"),
      ev("c4", 99_000, "after"),
    ];
    expect(branchingRatio(events, NOW)).toBe(1);
  });

  it("counts children at any time, including ones that are parents themselves", () => {
    const events = [ev("p", 50_000), ev("c", 60_000, "p"), ev("g", 96_000, "c"), ev("late", 200_000, "p")];
    // parents: p, c; children: c (of p), g (of c), late (of p)
    expect(branchingRatio(events, NOW)).toBe(1.5);
  });

  it("ignores events without a cause or with an unknown cause", () => {
    const events = [ev("p", 50_000), ev("x", 96_000), ev("y", 96_000, "nobody")];
    expect(branchingRatio(events, NOW)).toBe(0);
  });

  it("accepts custom window and settle periods", () => {
    const events = [ev("p1", 50_000), ev("p2", 92_000), ev("c", 99_000, "p2")];
    // window [90_000, 100_000]: only p2 and c are parents.
    expect(branchingRatio(events, NOW, 10_000, 0)).toBe(0.5);
    // window [40_000, 95_000] with defaults: p1, p2 are parents.
    expect(branchingRatio(events, NOW)).toBe(0.5);
    // window ends before it starts: no parents.
    expect(branchingRatio(events, NOW, 1_000, 5_000)).toBe(0);
  });

  it("does not depend on event order", () => {
    const events = [ev("p1", 50_000), ev("p2", 60_000), ev("c1", 96_000, "p1"), ev("c2", 97_000, "p1"), ev("c3", 98_000, "p2")];
    expect(branchingRatio([...events].reverse(), NOW)).toBe(branchingRatio(events, NOW));
  });
});

describe("inhibitionFactor", () => {
  it.each([
    [0, 1],
    [0.5, 1],
    [1, 1],
    [1.5, 2.25],
    [2, 4],
    [2.5, 6.25],
    [3, 8],
    [100, 8],
    [Infinity, 8],
    [Number.NaN, 1],
    [-3, 1],
  ])("inhibitionFactor(%d) = %d", (sigma, factor) => {
    expect(inhibitionFactor(sigma)).toBe(factor);
  });

  it("never decreases as sigma grows", () => {
    let prev = 0;
    for (let s = 0; s <= 4; s += 0.05) {
      const f = inhibitionFactor(s);
      expect(f).toBeGreaterThanOrEqual(prev);
      prev = f;
    }
  });
});
