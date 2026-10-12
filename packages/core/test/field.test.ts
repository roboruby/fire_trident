import { describe, expect, it } from "vitest";
import { MARK_KINDS, TAU_MS, aggregate, isExpired, markValue, repulsion } from "../src/field.ts";
import type { FieldReading, Mark, MarkKind } from "../src/types.ts";

const T0 = 1_000_000;
const MIN = 60_000;

const mark = (over: Partial<Mark> = {}): Mark => ({ id: "m1", kind: "claim", path: "src/a.ts", strength: 1, at: T0, ...over });

describe("TAU_MS and MARK_KINDS", () => {
  it("lists every kind once, matching the decay table", () => {
    expect(new Set(MARK_KINDS).size).toBe(5);
    expect([...MARK_KINDS].sort()).toEqual(Object.keys(TAU_MS).sort());
    expect(TAU_MS.need).toBeNull();
  });
});

describe("markValue", () => {
  it("is the full strength at the deposit instant", () => {
    expect(markValue(mark({ strength: 2 }), T0)).toBe(2);
  });

  it("is the full strength before the deposit instant (clock skew)", () => {
    expect(markValue(mark({ strength: 2 }), T0 - 10 * MIN)).toBe(2);
  });

  it.each([
    ["claim", 5 * MIN],
    ["trail", 60 * MIN],
    ["failure", 30 * MIN],
    ["danger", 30 * MIN],
  ] as const)("decays a %s mark to strength/e after one time constant", (kind, tau) => {
    expect(markValue(mark({ kind, strength: 2 }), T0 + tau)).toBeCloseTo(2 / Math.E, 12);
    expect(markValue(mark({ kind, strength: 2 }), T0 + 2 * tau)).toBeCloseTo(2 / Math.E ** 2, 12);
  });

  it("decays monotonically", () => {
    const values = [0, 1, 2, 5, 10, 30].map((m) => markValue(mark(), T0 + m * MIN));
    for (let i = 1; i < values.length; i++) expect(values[i]!).toBeLessThan(values[i - 1]!);
  });

  it("never decays a need mark", () => {
    expect(markValue(mark({ kind: "need", strength: 3 }), T0 + 365 * 24 * 60 * MIN)).toBe(3);
  });
});

describe("isExpired", () => {
  // A claim of strength 1 falls below 0.01 after tau * ln(100), about 23.03 minutes.
  const crossing = TAU_MS.claim! * Math.log(100);

  it("expires once the value drops below epsilon", () => {
    expect(isExpired(mark(), T0 + crossing - 1_000)).toBe(false);
    expect(isExpired(mark(), T0 + crossing + 1_000)).toBe(true);
  });

  it("is not expired at the deposit instant", () => {
    expect(isExpired(mark(), T0)).toBe(false);
  });

  it("honors a custom epsilon", () => {
    const oneTau = T0 + TAU_MS.claim!;
    expect(isExpired(mark(), oneTau, 0.5)).toBe(true);
    expect(isExpired(mark(), oneTau, 0.3)).toBe(false);
  });

  it("expires a deposit that starts below epsilon", () => {
    expect(isExpired(mark({ strength: 0.005 }), T0)).toBe(true);
  });

  it("never expires a need mark, even at zero strength", () => {
    expect(isExpired(mark({ kind: "need", strength: 0 }), T0 + 1e12)).toBe(false);
    expect(isExpired(mark({ kind: "need", strength: 1 }), T0 + 1e12, 5)).toBe(false);
  });
});

describe("aggregate", () => {
  it("returns zero totals for all five kinds and no paths when empty", () => {
    const { totals, byPath } = aggregate([], T0);
    expect(totals).toEqual({ claim: 0, need: 0, trail: 0, failure: 0, danger: 0 });
    expect(byPath).toEqual({});
  });

  it("sums values per path and kind, and totals per kind", () => {
    const marks = [
      mark({ id: "1", path: "a.ts", kind: "claim", strength: 1 }),
      mark({ id: "2", path: "a.ts", kind: "claim", strength: 2 }),
      mark({ id: "3", path: "a.ts", kind: "need", strength: 3 }),
      mark({ id: "4", path: "b.ts", kind: "danger", strength: 0.5 }),
      mark({ id: "5", path: "b.ts", kind: "trail", strength: 1 }),
    ];
    const { totals, byPath } = aggregate(marks, T0);
    expect(byPath).toEqual({ "a.ts": { claim: 3, need: 3 }, "b.ts": { danger: 0.5, trail: 1 } });
    expect(totals).toEqual({ claim: 3, need: 3, trail: 1, failure: 0, danger: 0.5 });
  });

  it("omits kinds a path does not have instead of writing zeros", () => {
    const { byPath } = aggregate([mark({ path: "b.ts", kind: "trail" })], T0);
    expect(Object.keys(byPath["b.ts"]!)).toEqual(["trail"]);
  });

  it("applies decay at `now`", () => {
    const marks = [mark({ kind: "claim", strength: 1 }), mark({ id: "2", kind: "need", strength: 1 })];
    const { totals, byPath } = aggregate(marks, T0 + TAU_MS.claim!);
    expect(byPath["src/a.ts"]?.claim).toBeCloseTo(1 / Math.E, 12);
    expect(byPath["src/a.ts"]?.need).toBe(1);
    expect(totals.claim).toBeCloseTo(1 / Math.E, 12);
  });

  it("keeps prototype-named paths as ordinary own keys", () => {
    const marks = ["constructor", "__proto__", "toString"].map((path, i) => mark({ id: String(i), path, strength: i + 1 }));
    const { byPath } = aggregate(marks, T0);
    expect(Object.keys(byPath).sort()).toEqual(["__proto__", "constructor", "toString"]);
    expect(Object.hasOwn(byPath, "__proto__")).toBe(true);
    expect(byPath["constructor"]).toEqual({ claim: 1 });
    expect(byPath["toString"]).toEqual({ claim: 3 });
    expect(Object.getPrototypeOf(byPath)).toBe(Object.prototype);
  });

  it("skips unknown kinds and non-finite values", () => {
    const marks = [mark({ kind: "bogus" as MarkKind }), mark({ id: "2", strength: Number.NaN }), mark({ id: "3", strength: 2 })];
    const { totals, byPath } = aggregate(marks, T0);
    expect(totals).toEqual({ claim: 2, need: 0, trail: 0, failure: 0, danger: 0 });
    expect(byPath).toEqual({ "src/a.ts": { claim: 2 } });
  });
});

describe("repulsion", () => {
  const field: FieldReading["byPath"] = {
    "src/a.ts": { claim: 1, need: 5, trail: 2, failure: 3, danger: 0.5 },
    "src/b.ts": { claim: 2 },
    "lib/c.ts": { claim: 4 },
    "srcx/d.ts": { claim: 8 },
  };

  it("counts only claim and danger values", () => {
    expect(repulsion(field, ["src/a.ts"])).toBe(1.5);
    expect(repulsion({ "a.ts": { need: 10, trail: 10, failure: 10 } }, ["a.ts"])).toBe(0);
  });

  it("matches a directory prefix when the entry ends with '/'", () => {
    expect(repulsion(field, ["src/"])).toBe(3.5);
  });

  it("does not treat an entry without a trailing slash as a directory", () => {
    expect(repulsion(field, ["src"])).toBe(0);
    expect(repulsion(field, ["sr"])).toBe(0);
  });

  it("matches globs", () => {
    expect(repulsion(field, ["**/*.ts"])).toBe(15.5);
    expect(repulsion(field, ["src/{a,b}.ts"])).toBe(3.5);
  });

  it("counts each field path once across overlapping entries", () => {
    expect(repulsion(field, ["src/", "src/a.ts", "src/a.ts", "src/*.ts"])).toBe(3.5);
  });

  it("feels claims deposited on directories and globs (field keys are footprints too)", () => {
    expect(repulsion({ "src/": { claim: 2 } }, ["src/x/y.ts"])).toBe(2);
    expect(repulsion({ "src/**/*.ts": { danger: 1 } }, ["src/a.ts"])).toBe(1);
    expect(repulsion({ "lib/": { claim: 2 } }, ["src/a.ts"])).toBe(0);
  });

  it("is zero for an empty footprint or an empty field", () => {
    expect(repulsion(field, [])).toBe(0);
    expect(repulsion({}, ["src/"])).toBe(0);
  });

  it("works on an aggregate that excludes the requesting agent's own marks", () => {
    const marks: Mark[] = [
      mark({ id: "1", agentId: "me", strength: 5 }),
      mark({ id: "2", agentId: "other", strength: 1 }),
    ];
    const { byPath } = aggregate(marks.filter((m) => m.agentId !== "me"), T0);
    expect(repulsion(byPath, ["src/a.ts"])).toBe(1);
  });
});
