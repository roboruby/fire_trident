import { describe, expect, it } from "vitest";
import { laneIntervalMs, selectBatch } from "../src/batch.ts";
import type { Proposal } from "../src/types.ts";

type P = Pick<Proposal, "id" | "writeSet" | "readSet"> & { priority?: number };

const prop = (id: string, writes: string[], reads: string[] = []): P => ({
  id,
  writeSet: writes.map((path) => ({ path, blob: "f".repeat(40) })),
  readSet: reads.map((path) => ({ path, blob: "e".repeat(40) })),
});
const ids = (list: P[]): string[] => list.map((p) => p.id);
const select = (list: P[], maxSize?: number) => {
  const { batch, deferred } = selectBatch(list, maxSize);
  return { batch: ids(batch), deferred: ids(deferred) };
};

describe("selectBatch", () => {
  it("returns empty lists for no proposals", () => {
    expect(selectBatch([])).toEqual({ batch: [], deferred: [] });
  });

  it("takes every proposal when nothing overlaps", () => {
    expect(select([prop("a", ["x"]), prop("b", ["y"], ["r"]), prop("c", ["z"], ["r"])])).toEqual({ batch: ["a", "b", "c"], deferred: [] });
  });

  it("defers a write that collides with a chosen write", () => {
    expect(select([prop("a", ["x"]), prop("b", ["x"])])).toEqual({ batch: ["a"], deferred: ["b"] });
  });

  it("defers a write to a path a chosen proposal read", () => {
    expect(select([prop("a", ["y"], ["x"]), prop("b", ["x"])])).toEqual({ batch: ["a"], deferred: ["b"] });
  });

  it("defers a read of a path a chosen proposal writes", () => {
    expect(select([prop("a", ["x"]), prop("b", ["z"], ["x"])])).toEqual({ batch: ["a"], deferred: ["b"] });
  });

  it("allows overlapping reads", () => {
    expect(select([prop("a", ["y"], ["x"]), prop("b", ["z"], ["x"])])).toEqual({ batch: ["a", "b"], deferred: [] });
  });

  it("allows a proposal to read and write the same path itself", () => {
    expect(select([prop("a", ["x"], ["x"]), prop("b", ["y"], ["y"])])).toEqual({ batch: ["a", "b"], deferred: [] });
  });

  it("does not let a deferred proposal block later ones", () => {
    // b loses x to a, so its claim on y must not stop c.
    expect(select([prop("a", ["x"]), prop("b", ["x", "y"]), prop("c", ["y"])])).toEqual({ batch: ["a", "c"], deferred: ["b"] });
  });

  it("is greedy in the given order", () => {
    expect(select([prop("a", ["x"]), prop("b", ["x"])]).batch).toEqual(["a"]);
    expect(select([prop("b", ["x"]), prop("a", ["x"])]).batch).toEqual(["b"]);
  });

  it("keeps the original relative order in both lists", () => {
    const list = [prop("a", ["x"]), prop("b", ["x"]), prop("c", ["y"]), prop("d", ["y"]), prop("e", ["z"]), prop("f", ["z"], ["x"])];
    expect(select(list)).toEqual({ batch: ["a", "c", "e"], deferred: ["b", "d", "f"] });
  });

  it("honors maxSize", () => {
    const list = [prop("a", ["1"]), prop("b", ["2"]), prop("c", ["3"]), prop("d", ["4"])];
    expect(select(list, 2)).toEqual({ batch: ["a", "b"], deferred: ["c", "d"] });
    expect(select(list, 0)).toEqual({ batch: [], deferred: ["a", "b", "c", "d"] });
    expect(select(list, 10)).toEqual({ batch: ["a", "b", "c", "d"], deferred: [] });
  });

  it("fills maxSize past conflicts", () => {
    const list = [prop("a", ["x"]), prop("b", ["x"]), prop("c", ["y"]), prop("d", ["z"])];
    expect(select(list, 2)).toEqual({ batch: ["a", "c"], deferred: ["b", "d"] });
  });

  it("floors a fractional maxSize and ignores NaN", () => {
    const list = [prop("a", ["1"]), prop("b", ["2"])];
    expect(select(list, 1.9).batch).toEqual(["a"]);
    expect(select(list, Number.NaN).batch).toEqual(["a", "b"]);
  });

  it("treats an empty write set as conflict-free, but still checks its reads", () => {
    expect(select([prop("a", ["x"]), prop("noop", [])])).toEqual({ batch: ["a", "noop"], deferred: [] });
    expect(select([prop("a", ["x"]), prop("reader", [], ["x"])])).toEqual({ batch: ["a"], deferred: ["reader"] });
  });

  it("defers a repeated proposal id", () => {
    expect(select([prop("a", ["x"]), prop("a", ["y"])])).toEqual({ batch: ["a"], deferred: ["a"] });
  });

  it("returns the caller's objects with their extra fields", () => {
    const a: P = { ...prop("a", ["x"]), priority: 7 };
    const { batch } = selectBatch([a]);
    expect(batch[0]).toBe(a);
    expect(batch[0]?.priority).toBe(7);
  });
});

describe("laneIntervalMs", () => {
  it.each([
    [0, 30_000],
    [0.5, 30_000],
    [1, 30_000],
    [2, 15_000],
    [3, 10_000],
    [30, 1_000],
    [60, 1_000],
    [1e9, 1_000],
    [Infinity, 1_000],
    [-5, 30_000],
    [Number.NaN, 30_000],
  ])("laneIntervalMs(%d) = %d", (flux, ms) => {
    expect(laneIntervalMs(flux)).toBe(ms);
  });

  it("accepts custom k, minMs, and maxMs", () => {
    expect(laneIntervalMs(4, 10_000, 500, 60_000)).toBe(2_500);
    expect(laneIntervalMs(0, 10_000, 500, 60_000)).toBe(60_000);
    expect(laneIntervalMs(100, 10_000, 500, 60_000)).toBe(500);
  });

  it("speeds up as flux grows", () => {
    let prev = Infinity;
    for (const flux of [0, 0.5, 1, 2, 5, 10, 20, 40, 80]) {
      const ms = laneIntervalMs(flux);
      expect(ms).toBeLessThanOrEqual(prev);
      prev = ms;
    }
  });
});
