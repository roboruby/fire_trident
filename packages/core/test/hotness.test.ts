import { describe, expect, it } from "vitest";
import { HOTNESS, hotness, lineCount } from "../src/hotness.ts";
import type { PathReturn, PathWrite } from "../src/hotness.ts";

const NOW = 10_000_000_000;
const MIN = 60_000;
const P = "src/big.ts";

/** A landing `ago` minutes before NOW that left the file `lines` long, written by these agents. */
const w = (ago: number, lines: number | null, ...agents: string[]): PathWrite => ({ at: NOW - ago * MIN, lines, agents });
const r = (ago: number): PathReturn => ({ at: NOW - ago * MIN });

describe("lineCount", () => {
  it("counts lines whatever the line endings, with or without a final break", () => {
    expect(lineCount("")).toBe(0);
    expect(lineCount("a")).toBe(1);
    expect(lineCount("a\n")).toBe(1);
    expect(lineCount("a\nb")).toBe(2);
    expect(lineCount("a\r\nb\r\n")).toBe(2);
    expect(lineCount("a\rb\rc")).toBe(3);
    expect(lineCount("\n\n")).toBe(2);
  });
});

describe("hotness: growth among many writers", () => {
  it("is hot when the file is long enough, grew a quarter and four agents wrote it within the window", () => {
    const h = hotness(P, [w(20, 650, "a1"), w(15, 700, "a2"), w(10, 750, "a3"), w(5, 820, "a4")], [], NOW);
    expect(h).toMatchObject({ path: P, hot: true, signal: "growth", lines: 820, baseline: 650, agents: 4, landings: 4, returns: 0, windowMs: HOTNESS.windowMs });
    expect(h.growth).toBeCloseTo(170 / 650);
  });

  it("is not hot one short of any growth threshold", () => {
    // Three agents.
    expect(hotness(P, [w(20, 650, "a1"), w(15, 700, "a2"), w(5, 820, "a3")], [], NOW).hot).toBe(false);
    // Grew 24%.
    expect(hotness(P, [w(20, 650, "a1"), w(15, 700, "a2"), w(10, 750, "a3"), w(5, 806, "a4")], [], NOW).hot).toBe(false);
    // 599 lines, grown by a third.
    expect(hotness(P, [w(20, 449, "a1"), w(15, 500, "a2"), w(10, 550, "a3"), w(5, 599, "a4")], [], NOW).hot).toBe(false);
  });

  it("counts distinct agents, every agent of a landing, and only landings within the window", () => {
    const repeat = [w(20, 650, "a1"), w(15, 700, "a1"), w(10, 750, "a2"), w(5, 820, "a2", "a3")];
    expect(hotness(P, repeat, [], NOW)).toMatchObject({ agents: 3, hot: false });
    const old = [w(45, 640, "a0"), w(20, 650, "a1"), w(15, 700, "a2"), w(10, 750, "a3"), w(5, 820, "a3")];
    expect(hotness(P, old, [], NOW)).toMatchObject({ agents: 3, landings: 4, hot: false });
  });

  it("measures growth from the length when the window opened, known from a landing before it", () => {
    // Before the window: 600 lines. Within it the newest landing says 760 (27% more), the earliest 700.
    const h = hotness(P, [w(40, 600, "a0"), w(20, 700, "a1"), w(15, 720, "a2"), w(10, 740, "a3"), w(5, 760, "a4")], [], NOW);
    expect(h).toMatchObject({ baseline: 600, lines: 760, hot: true });
    // Without the earlier landing the baseline is the earliest length known within the window, and 9% is not enough.
    expect(hotness(P, [w(20, 700, "a1"), w(15, 720, "a2"), w(10, 740, "a3"), w(5, 760, "a4")], [], NOW)).toMatchObject({ baseline: 700, hot: false });
  });

  it("uses the newest known length, skipping landings whose length is not known", () => {
    const h = hotness(P, [w(20, 650, "a1"), w(15, null, "a2"), w(10, 830, "a3"), w(5, null, "a4")], [], NOW);
    expect(h).toMatchObject({ lines: 830, baseline: 650, agents: 4, landings: 4, hot: true });
    expect(hotness(P, [w(20, null, "a1"), w(15, null, "a2"), w(10, null, "a3"), w(5, null, "a4")], [], NOW)).toMatchObject({ lines: null, baseline: null, growth: null, hot: false });
  });

  it("counts a file that was empty when the window opened as grown", () => {
    const h = hotness(P, [w(40, 0, "a0"), w(20, 300, "a1"), w(15, 400, "a2"), w(10, 500, "a3"), w(5, 640, "a4")], [], NOW);
    expect(h).toMatchObject({ baseline: 0, growth: null, lines: 640, hot: true, signal: "growth" });
  });

  it("ignores landings after the time asked about and entries that are not well formed", () => {
    const odd = [w(20, 650, "a1"), w(15, 700, "a2"), w(10, 750, "a3"), { at: NOW - 5 * MIN, lines: 8.5, agents: ["a4", 3] } as unknown as PathWrite, w(-5, 900, "a5")];
    expect(hotness(P, odd, [], NOW)).toMatchObject({ lines: 750, agents: 4, landings: 4, hot: false });
  });
});

describe("hotness: collisions", () => {
  it("is hot when six changes that named the file went back within the window, whatever its size", () => {
    const back = [r(29), r(20), r(10), r(5), r(2), r(1)];
    expect(hotness(P, [], back, NOW)).toMatchObject({ hot: true, signal: "returns", returns: 6, lines: null, agents: 0 });
    expect(hotness(P, [], back.slice(1), NOW)).toMatchObject({ hot: false, signal: null, returns: 5 });
    expect(hotness(P, [], [r(31), ...back.slice(1)], NOW)).toMatchObject({ hot: false, returns: 5 });
  });

  it("names growth when both signals fire", () => {
    const h = hotness(P, [w(20, 650, "a1"), w(15, 700, "a2"), w(10, 750, "a3"), w(5, 820, "a4")], [r(9), r(8), r(7), r(6), r(5), r(4)], NOW);
    expect(h).toMatchObject({ hot: true, signal: "growth", returns: 6 });
  });
});

describe("hotness: thresholds", () => {
  it("takes other thresholds", () => {
    const writes = [w(20, 100, "a1"), w(5, 130, "a2")];
    expect(hotness(P, writes, [], NOW).hot).toBe(false);
    expect(hotness(P, writes, [], NOW, { ...HOTNESS, minLines: 100, minAgents: 2 })).toMatchObject({ hot: true, signal: "growth" });
    expect(hotness(P, writes, [], NOW, { ...HOTNESS, windowMs: 10 * MIN, minLines: 100, minAgents: 1 })).toMatchObject({ baseline: 100, agents: 1, landings: 1, hot: true });
  });
});
