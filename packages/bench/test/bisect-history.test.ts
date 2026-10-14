import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_LANDINGS, SEARCH_LANDINGS, SEARCH_RUNS, SETTLED_LANDINGS, defaultBreakAt, history, minimumRuns, mostRuns, predictRuns } from "../../../scripts/bisect_history.ts";

/** The history scripts/bisect.ts lands and the runs the first red search needs for it (scripts/bisect_history.ts). */

/** The smallest r with 2^r >= x, which is ceil(log2 x), by counting: the tests never lean on floating-point logarithms. */
function ceilLog2(x: number): number {
  let r = 0;
  while (2 ** r < x) r++;
  return r;
}

const WORKER = new URL("../../worker/src/certify/", import.meta.url);

describe("the search's bounds, mirrored from the worker", () => {
  it("match MAX_PROBES in certify/bisect.ts and RANGE_MAX in certify/range.ts", () => {
    const bisect = readFileSync(new URL("bisect.ts", WORKER), "utf8");
    const range = readFileSync(new URL("range.ts", WORKER), "utf8");
    expect(bisect).toMatch(new RegExp(`^export const MAX_PROBES = ${SEARCH_RUNS};$`, "m"));
    expect(range).toMatch(new RegExp(`^export const RANGE_MAX = ${SEARCH_LANDINGS};$`, "m"));
  });

  it("settle every position of 128 landings in 8 runs, some of up to 255, none past that", () => {
    expect(SETTLED_LANDINGS).toBe(128);
    const settled = (n: number): boolean[] => Array.from({ length: n }, (_, i) => predictRuns(n, i + 1).settled);
    expect(settled(SETTLED_LANDINGS).every(Boolean)).toBe(true);
    expect(settled(SETTLED_LANDINGS + 1).every(Boolean)).toBe(false);
    expect(settled(2 * SETTLED_LANDINGS - 1).some(Boolean)).toBe(true);
    expect(settled(2 * SETTLED_LANDINGS).some(Boolean)).toBe(false);
    expect(settled(SEARCH_LANDINGS).some(Boolean)).toBe(false);
  });
});

describe("the fewest and most runs", () => {
  it("are ceil(log2(n + 1)) and 1 + ceil(log2 n)", () => {
    for (let n = 1; n <= 600; n++) {
      expect(minimumRuns(n)).toBe(ceilLog2(n + 1));
      expect(mostRuns(n)).toBe(1 + ceilLog2(n));
    }
  });

  it("give the numbers the results quote", () => {
    expect([minimumRuns(1), mostRuns(1)]).toEqual([1, 1]);
    expect([minimumRuns(6), mostRuns(6)]).toEqual([3, 4]);
    expect([minimumRuns(40), mostRuns(40)]).toEqual([6, 7]);
    expect([minimumRuns(100), mostRuns(100)]).toEqual([7, 8]);
    expect([minimumRuns(128), mostRuns(128)]).toEqual([8, 8]);
    expect([minimumRuns(129), mostRuns(129)]).toEqual([8, 9]);
    expect([minimumRuns(256), mostRuns(256)]).toEqual([9, 9]);
  });

  it("meet when n is a power of two and differ by one otherwise", () => {
    for (let n = 1; n <= 600; n++) expect(mostRuns(n) - minimumRuns(n)).toBe((n & (n - 1)) === 0 ? 0 : 1);
  });
});

describe("the runs one history takes", () => {
  it("replays the live demo: six landings with the break at the fourth took 3 runs", () => {
    expect(predictRuns(6, 4)).toEqual({ runs: 3, settled: true, found: 4 });
  });

  it("predicts the histories the live check runs", () => {
    expect(predictRuns(40, 21)).toEqual({ runs: 6, settled: true, found: 21 });
    expect(predictRuns(100, 7)).toEqual({ runs: 7, settled: true, found: 7 });
    expect(predictRuns(6, 6)).toEqual({ runs: 4, settled: true, found: 6 });
    expect(predictRuns(1, 1)).toEqual({ runs: 1, settled: true, found: 1 });
  });

  it("finds the break at every position, within the fewest and most runs", () => {
    for (let n = 1; n <= 300; n++) {
      for (let k = 1; k <= n; k++) {
        const p = predictRuns(n, k);
        if (!p.settled) continue;
        expect(p.found).toBe(k);
        expect(p.runs).toBeGreaterThanOrEqual(minimumRuns(n));
        expect(p.runs).toBeLessThanOrEqual(mostRuns(n));
      }
    }
  });

  it("says how far the runs got when they do not settle", () => {
    expect(predictRuns(129, 129)).toEqual({ runs: 8, settled: false, narrowed: 2 });
    expect(predictRuns(256, 1)).toEqual({ runs: 8, settled: false, narrowed: 2 });
    expect(predictRuns(512, 257)).toEqual({ runs: 8, settled: false, narrowed: 4 });
  });
});

describe("the history", () => {
  it("defaults to six landings with the break at the fourth, the middle", () => {
    expect(DEFAULT_LANDINGS).toBe(6);
    expect(defaultBreakAt(DEFAULT_LANDINGS)).toBe(4);
    expect([1, 2, 7, 40, 100].map(defaultBreakAt)).toEqual([1, 2, 4, 21, 51]);
  });

  it("lands the titles the check always landed, for six and the fourth", () => {
    expect(history(6, 4).map((l) => l.title)).toEqual(["Add note 1", "Add note 2", "Add note 3", "Speed up subtraction", "Add note 4", "Add note 5"]);
    expect(history(6, 4)[3]).toEqual({ kind: "break", title: "Speed up subtraction" });
    expect(history(6, 4)[4]).toEqual({ kind: "note", title: "Add note 4", note: 4 });
  });

  it("puts the break at the position asked and numbers the notes in order around it", () => {
    for (const [n, k] of [
      [1, 1],
      [40, 1],
      [40, 40],
      [100, 7],
    ]) {
      const landings = history(n!, k!);
      expect(landings).toHaveLength(n!);
      expect(landings.filter((l) => l.kind === "break")).toHaveLength(1);
      expect(landings[k! - 1]?.kind).toBe("break");
      expect(landings.flatMap((l) => (l.kind === "note" ? [l.note] : []))).toEqual(Array.from({ length: n! - 1 }, (_, i) => i + 1));
    }
  });
});
