import { describe, expect, it } from "vitest";
import { mapLine, matchLines } from "../../src/trunk/blame.ts";

function lcs(a: string[], b: string[]): number {
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) dp[i]![j] = a[i - 1] === b[j - 1] ? dp[i - 1]![j - 1]! + 1 : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
  }
  return dp[a.length]![b.length]!;
}

/** Small deterministic PRNG so the fuzz case is reproducible. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe("matchLines", () => {
  it("matches identical inputs one to one", () => {
    expect(matchLines(["a", "b", "c"], ["a", "b", "c"])).toEqual([[0, 0], [1, 1], [2, 2]]);
  });

  it("handles empty sides", () => {
    expect(matchLines([], ["a"])).toEqual([]);
    expect(matchLines(["a"], [])).toEqual([]);
  });

  it("finds a longest common subsequence (fuzz against dynamic programming)", () => {
    const rand = rng(7);
    for (let round = 0; round < 200; round++) {
      const a = Array.from({ length: Math.floor(rand() * 12) }, () => "xyz"[Math.floor(rand() * 3)]!);
      const b = Array.from({ length: Math.floor(rand() * 12) }, () => "xyz"[Math.floor(rand() * 3)]!);
      const pairs = matchLines(a, b)!;
      expect(pairs.length).toBe(lcs(a, b));
      for (let k = 0; k < pairs.length; k++) {
        const [i, j] = pairs[k]!;
        expect(a[i]).toBe(b[j]);
        if (k > 0) {
          expect(i).toBeGreaterThan(pairs[k - 1]![0]);
          expect(j).toBeGreaterThan(pairs[k - 1]![1]);
        }
      }
    }
  });

  it("gives up past its budget", () => {
    const a = Array.from({ length: 400 }, (_, i) => `a${i}`);
    const b = Array.from({ length: 400 }, (_, i) => `b${i}`);
    expect(matchLines(a, b, 1_000)).toBeNull();
  });
});

describe("mapLine", () => {
  const older = "one\ntwo\nthree\nfour";
  it("maps unchanged lines across an insertion", () => {
    const newer = "one\ninserted\ntwo\nthree\nfour";
    expect(mapLine(older, newer, 0)).toBe(0);
    expect(mapLine(older, newer, 1)).toBeNull();
    expect(mapLine(older, newer, 2)).toBe(1);
    expect(mapLine(older, newer, 4)).toBe(3);
  });

  it("reports a changed line as new", () => {
    expect(mapLine(older, "one\nTWO\nthree\nfour", 1)).toBeNull();
    expect(mapLine(older, "one\nTWO\nthree\nfour", 2)).toBe(2);
  });

  it("maps across a deletion", () => {
    expect(mapLine(older, "one\nfour", 1)).toBe(3);
  });
});
