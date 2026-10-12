import { describe, expect, it } from "vitest";
import { TAU_MS } from "@fire_trident/core";
import {
  accumulates,
  chunks,
  foldDeposit,
  laneDelayMs,
  mergeKey,
  nextTickAt,
  proposalPaths,
  shortSha,
  staleReason,
  validDeposit,
  writePathsByBase,
} from "../../src/region/logic.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);

describe("mark merging", () => {
  it("keys claims per agent+intent, needs per intent, others per path", () => {
    expect(mergeKey({ kind: "claim", path: "p", agentId: "a", intentId: "i" })).toBe("claim|a|i|p");
    expect(mergeKey({ kind: "need", path: "p", agentId: "a", intentId: "i" })).toBe("need|i|p");
    expect(mergeKey({ kind: "trail", path: "p", agentId: "a" })).toBe("trail|p");
    expect(mergeKey({ kind: "danger", path: "p" })).toBe("danger|p");
    expect(accumulates("trail") && accumulates("failure") && accumulates("danger")).toBe(true);
    expect(accumulates("claim") || accumulates("need")).toBe(false);
  });

  it("replaces claims and needs", () => {
    expect(foldDeposit({ strength: 5, at: 0 }, { kind: "claim", path: "p", strength: 1, at: 900 }, 1_000)).toEqual({ strength: 1, at: 900 });
    expect(foldDeposit({ strength: 5, at: 0 }, { kind: "need", path: "p", strength: 2, at: 1_000 }, 1_000)).toEqual({ strength: 2, at: 1_000 });
  });

  it("accumulates decaying kinds exactly", () => {
    const tau = TAU_MS.trail!;
    const folded = foldDeposit({ strength: 1, at: 0 }, { kind: "trail", path: "p", strength: 1, at: tau }, tau);
    expect(folded.at).toBe(tau);
    expect(folded.strength).toBeCloseTo(1 + Math.exp(-1), 12);
    expect(foldDeposit(undefined, { kind: "failure", path: "p", strength: 0.5, at: 10 }, 10)).toEqual({ strength: 0.5, at: 10 });
  });

  it("validates deposits", () => {
    expect(validDeposit({ kind: "claim", path: "p", strength: 1, at: 0 })).toBe(true);
    expect(validDeposit({ kind: "nope" as never, path: "p", strength: 1, at: 0 })).toBe(false);
    expect(validDeposit({ kind: "claim", path: "", strength: 1, at: 0 })).toBe(false);
    expect(validDeposit({ kind: "claim", path: "p", strength: -1, at: 0 })).toBe(false);
    expect(validDeposit({ kind: "claim", path: "p", strength: Number.NaN, at: 0 })).toBe(false);
  });
});

describe("lane helpers", () => {
  it("lists the exact stale paths", () => {
    expect(staleReason([{ path: "src/a.ts", expected: A, actual: B }])).toBe(
      "stale: 1 path changed on trunk since read: src/a.ts (expected aaaaaaaaaa, trunk bbbbbbbbbb)",
    );
    expect(staleReason([{ path: "x", expected: null, actual: A }, { path: "y", expected: A, actual: null }])).toBe(
      "stale: 2 paths changed on trunk since read: x (expected absent, trunk aaaaaaaaaa); y (expected aaaaaaaaaa, trunk absent)",
    );
    const many = Array.from({ length: 30 }, (_, i) => ({ path: `f${i}`, expected: A, actual: B }));
    expect(staleReason(many)).toMatch(/^stale: 30 paths changed .*; and 5 more$/);
    expect(shortSha(null)).toBe("absent");
  });

  it("collects paths and groups base lookups", () => {
    expect(proposalPaths({ readSet: [{ path: "a", blob: A }, { path: "b", blob: A }], writeSet: [{ path: "a", blob: B }] })).toEqual(["a", "b"]);
    const grouped = writePathsByBase([
      { baseSha: A, writeSet: [{ path: "x", blob: B }] },
      { baseSha: B, writeSet: [{ path: "y", blob: B }] },
      { baseSha: A, writeSet: [{ path: "x", blob: A }, { path: "z", blob: null }] },
    ]);
    expect([...grouped]).toEqual([
      [A, ["x", "z"]],
      [B, ["y"]],
    ]);
  });

  it("paces the lane by flux and slows it under cascades", () => {
    expect(laneDelayMs(0, 0)).toBe(30_000);
    expect(laneDelayMs(10, 0)).toBe(3_000);
    expect(laneDelayMs(600, 0)).toBe(1_000);
    expect(laneDelayMs(10, 2)).toBe(12_000);
    expect(nextTickAt(5_000, 0, 3_000)).toBe(5_000);
    expect(nextTickAt(5_000, 4_000, 3_000)).toBe(7_000);
    expect(chunks([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});
