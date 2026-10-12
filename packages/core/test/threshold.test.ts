import { describe, expect, it, vi } from "vitest";
import { markValue } from "../src/field.ts";
import {
  LATERAL_INHIBITION,
  admissionOpen,
  chooseIntent,
  directClaimOn,
  inhibited,
  reinforceThreshold,
  responseProbability,
  stimulus,
} from "../src/threshold.ts";
import type { Candidate } from "../src/threshold.ts";
import type { FieldReading, Intent } from "../src/types.ts";

const MIN = 60_000;
const NOW = 100 * MIN;

const intent = (over: Partial<Intent> = {}): Intent => ({
  id: "int_1",
  colonyId: "col",
  title: "Do the thing",
  why: "Because",
  source: "human",
  footprint: [],
  priority: 1,
  status: "open",
  createdAt: NOW,
  createdBy: "user",
  ...over,
});

const candidate = (id: string, priority: number, region: string, over: Partial<Candidate> = {}): Candidate => ({
  intent: intent({ id, priority }),
  region,
  repulsion: 0,
  admissionOpen: true,
  ...over,
});

/** A rand that replays `values` in order and fails the test if called more often. */
const sequence = (...values: number[]) => {
  let i = 0;
  return vi.fn(() => {
    const v = values[i++];
    if (v === undefined) throw new Error("rand called too often");
    return v;
  });
};

describe("responseProbability", () => {
  it("is 0 for non-positive or NaN stimulus", () => {
    expect(responseProbability(0, 1)).toBe(0);
    expect(responseProbability(-1, 1)).toBe(0);
    expect(responseProbability(Number.NaN, 1)).toBe(0);
    expect(responseProbability(0, 0)).toBe(0);
  });

  it("is 1 for a non-positive threshold", () => {
    expect(responseProbability(1, 0)).toBe(1);
    expect(responseProbability(0.001, -2)).toBe(1);
  });

  it("is s^2 / (s^2 + theta^2)", () => {
    expect(responseProbability(1, 1)).toBe(0.5);
    expect(responseProbability(2, 1)).toBeCloseTo(0.8, 15);
    expect(responseProbability(1, 2)).toBeCloseTo(0.2, 15);
    expect(responseProbability(3, 4)).toBeCloseTo(9 / 25, 15);
  });

  it("rises with stimulus and falls with threshold", () => {
    expect(responseProbability(2, 1)).toBeGreaterThan(responseProbability(1, 1));
    expect(responseProbability(1, 2)).toBeLessThan(responseProbability(1, 1));
  });

  it("is 0 for a NaN threshold", () => {
    expect(responseProbability(1, Number.NaN)).toBe(0);
  });

  it("stays in [0, 1] for huge and infinite inputs", () => {
    expect(responseProbability(1e200, 1)).toBe(1);
    expect(responseProbability(1, 1e200)).toBe(0);
    expect(responseProbability(1e200, 1e200)).toBe(0.5);
    expect(responseProbability(Infinity, 1)).toBe(1);
    expect(responseProbability(1, Infinity)).toBe(0);
    expect(responseProbability(Infinity, Infinity)).toBe(0.5);
  });
});

describe("stimulus", () => {
  it("is the priority for a fresh, unrepelled intent", () => {
    expect(stimulus(intent({ priority: 2 }), NOW, 0)).toBe(2);
  });

  it("grows 10% per minute of age", () => {
    expect(stimulus(intent({ priority: 2, createdAt: NOW - 5 * MIN }), NOW, 0)).toBeCloseTo(3, 12);
    expect(stimulus(intent({ priority: 2, createdAt: NOW - 10 * MIN }), NOW, 0)).toBeCloseTo(4, 12);
  });

  it("subtracts repulsion with a default weight of 1", () => {
    expect(stimulus(intent({ priority: 2 }), NOW, 0.5)).toBe(1.5);
  });

  it("applies a custom repulsion weight", () => {
    expect(stimulus(intent({ priority: 2 }), NOW, 0.5, 2)).toBe(1);
    expect(stimulus(intent({ priority: 2 }), NOW, 0.5, 0)).toBe(2);
  });

  it("is floored at 0", () => {
    expect(stimulus(intent({ priority: 2 }), NOW, 10)).toBe(0);
    expect(stimulus(intent({ priority: -1 }), NOW, 0)).toBe(0);
    expect(stimulus(intent({ priority: Number.NaN }), NOW, 0)).toBe(0);
  });

  it("treats an intent dated in the future as age 0", () => {
    expect(stimulus(intent({ priority: 2, createdAt: NOW + 10 * MIN }), NOW, 0)).toBe(2);
  });
});

describe("chooseIntent", () => {
  it("returns null for no candidates", () => {
    expect(chooseIntent([], {}, NOW, () => 0)).toBeNull();
  });

  it("takes the highest stimulus first", () => {
    const cands = [candidate("a", 1, "src"), candidate("b", 3, "lib"), candidate("c", 2, "docs")];
    expect(chooseIntent(cands, {}, NOW, () => 0)?.intent.id).toBe("b");
  });

  it("skips regions with closed admission, without drawing for them", () => {
    const cands = [candidate("closed", 10, "hot", { admissionOpen: false }), candidate("a", 1, "src")];
    const rand = sequence(0);
    expect(chooseIntent(cands, {}, NOW, rand)?.intent.id).toBe("a");
    expect(rand).toHaveBeenCalledTimes(1);
    expect(chooseIntent([candidate("x", 5, "hot", { admissionOpen: false })], {}, NOW, () => 0)).toBeNull();
  });

  it("walks down the ranking when a draw rejects, drawing once per candidate", () => {
    // b: s=3, theta 1 -> p=0.9; a: s=1 -> p=0.5
    const cands = [candidate("a", 1, "src"), candidate("b", 3, "lib")];
    const rand = sequence(0.95, 0.3);
    expect(chooseIntent(cands, {}, NOW, rand)?.intent.id).toBe("a");
    expect(rand).toHaveBeenCalledTimes(2);
  });

  it("accepts exactly when rand() < p", () => {
    const one = [candidate("a", 1, "src")]; // p = 0.5
    expect(chooseIntent(one, {}, NOW, () => 0.4999)?.intent.id).toBe("a");
    expect(chooseIntent(one, {}, NOW, () => 0.5)).toBeNull();
  });

  it("returns null when every candidate is rejected", () => {
    const cands = [candidate("a", 1, "src"), candidate("b", 3, "lib")];
    expect(chooseIntent(cands, {}, NOW, () => 0.999)).toBeNull();
  });

  it("uses the agent's threshold for the candidate's region", () => {
    const cands = [candidate("a", 1, "src"), candidate("b", 3, "lib")];
    // lib theta 1000 makes b nearly unattractive; src falls back to the default theta 1.
    expect(chooseIntent(cands, { lib: 1000 }, NOW, () => 0.01)?.intent.id).toBe("a");
    // a very eager src threshold makes a near-certain even with a high draw.
    expect(chooseIntent([candidate("a", 1, "src")], { src: 0.01 }, NOW, () => 0.999)?.intent.id).toBe("a");
  });

  it("falls back to defaultTheta for missing regions", () => {
    const cands = [candidate("a", 1, "src")];
    expect(chooseIntent(cands, {}, NOW, () => 0.999, 0)?.intent.id).toBe("a");
    expect(chooseIntent(cands, {}, NOW, () => 0.01, 1000)).toBeNull();
  });

  it("never picks a zero-stimulus candidate", () => {
    expect(chooseIntent([candidate("a", 0, "src")], {}, NOW, () => 0)).toBeNull();
    expect(chooseIntent([candidate("a", 1, "src", { repulsion: 5 })], {}, NOW, () => 0)).toBeNull();
  });

  it("ranks by repulsion and age, not raw priority", () => {
    const repelled = [candidate("a", 3, "src", { repulsion: 2.5 }), candidate("b", 1, "lib")];
    expect(chooseIntent(repelled, {}, NOW, () => 0)?.intent.id).toBe("b");
    const old: Candidate = { ...candidate("old", 1, "src"), intent: intent({ id: "old", priority: 1, createdAt: NOW - 20 * MIN }) };
    expect(chooseIntent([candidate("fresh", 2, "lib"), old], {}, NOW, () => 0)?.intent.id).toBe("old");
  });

  it("keeps input order on ties and does not reorder the input", () => {
    const cands = [candidate("first", 2, "src"), candidate("second", 2, "lib")];
    const before = [...cands];
    expect(chooseIntent(cands, {}, NOW, () => 0)?.intent.id).toBe("first");
    expect(cands).toEqual(before);
  });

  it("returns the candidate object itself", () => {
    const c = candidate("a", 1, "src");
    expect(chooseIntent([c], {}, NOW, () => 0)).toBe(c);
  });
});

describe("directClaimOn", () => {
  const byPath: FieldReading["byPath"] = {
    "src/a.ts": { claim: 1, danger: 3 },
    "src/b.ts": { claim: 0.25 },
    "src/": { claim: 2 },
    "src/**/*.ts": { claim: 2 },
    "src/c.ts": { danger: 1, trail: 4 },
  };

  it("sums claims on exactly the footprint paths", () => {
    expect(directClaimOn(byPath, ["src/a.ts", "src/b.ts"])).toBe(1.25);
    expect(directClaimOn(byPath, ["src/a.ts"])).toBe(1);
  });

  it("ignores directory and glob claims that only overlap, danger, and other kinds", () => {
    expect(directClaimOn(byPath, ["src/z.ts"])).toBe(0);
    expect(directClaimOn(byPath, ["src/c.ts"])).toBe(0);
  });

  it("counts a directory or glob entry only against the same entry", () => {
    expect(directClaimOn(byPath, ["src/"])).toBe(2);
    expect(directClaimOn(byPath, ["src/**/*.ts"])).toBe(2);
  });

  it("counts a path once however often the footprint lists it", () => {
    expect(directClaimOn(byPath, ["src/a.ts", "src/a.ts"])).toBe(1);
  });

  it("is 0 for an empty footprint or reading", () => {
    expect(directClaimOn(byPath, [])).toBe(0);
    expect(directClaimOn({}, ["src/a.ts"])).toBe(0);
  });

  it("skips non-finite and negative values", () => {
    const odd: FieldReading["byPath"] = { a: { claim: Number.NaN }, b: { claim: -1 }, c: { claim: Infinity }, d: { claim: 0.5 } };
    expect(directClaimOn(odd, ["a", "b", "c", "d"])).toBe(0.5);
  });

  it("does not read inherited keys", () => {
    expect(directClaimOn({}, ["constructor", "__proto__", "toString"])).toBe(0);
    const own = Object.fromEntries([["constructor", { claim: 1 }]]) as FieldReading["byPath"];
    expect(directClaimOn(own, ["constructor"])).toBe(1);
  });
});

describe("inhibited (lateral inhibition)", () => {
  it("defaults to half a fresh claim", () => {
    expect(LATERAL_INHIBITION).toBe(0.5);
    expect(inhibited({ directClaim: 0.5 })).toBe(true);
    expect(inhibited({ directClaim: 1 })).toBe(true);
    expect(inhibited({ directClaim: 0.4999 })).toBe(false);
  });

  it("never inhibits without a positive claim", () => {
    expect(inhibited({})).toBe(false);
    expect(inhibited({ directClaim: 0 })).toBe(false);
    expect(inhibited({ directClaim: -1 })).toBe(false);
    expect(inhibited({ directClaim: Number.NaN })).toBe(false);
    expect(inhibited({ directClaim: 0 }, 0)).toBe(false);
  });

  it("takes a custom threshold; Infinity turns it off, 0 inhibits on any claim, NaN is the default", () => {
    expect(inhibited({ directClaim: 1 }, 1.5)).toBe(false);
    expect(inhibited({ directClaim: 2 }, 1.5)).toBe(true);
    expect(inhibited({ directClaim: 1e9 }, Infinity)).toBe(false);
    expect(inhibited({ directClaim: Infinity }, Infinity)).toBe(false);
    expect(inhibited({ directClaim: 0.01 }, 0)).toBe(true);
    expect(inhibited({ directClaim: 0.01 }, -1)).toBe(true);
    expect(inhibited({ directClaim: 0.6 }, Number.NaN)).toBe(true);
    expect(inhibited({ directClaim: 0.4 }, Number.NaN)).toBe(false);
  });

  it("decays with the claim: a silent agent's claim stops inhibiting after one half-life", () => {
    const claim = { id: "m", kind: "claim" as const, path: "src/a.ts", strength: 1, at: 0 };
    const halfLife = 5 * MIN * Math.LN2;
    expect(inhibited({ directClaim: markValue(claim, 45_000) })).toBe(true); // a heartbeat interval
    expect(inhibited({ directClaim: markValue(claim, halfLife - 1_000) })).toBe(true);
    expect(inhibited({ directClaim: markValue(claim, halfLife + 1_000) })).toBe(false);
    // Two agents on the same file keep it inhibited for about two half-lives.
    expect(inhibited({ directClaim: 2 * markValue(claim, 2 * halfLife - 1_000) })).toBe(true);
    expect(inhibited({ directClaim: 2 * markValue(claim, 2 * halfLife + 1_000) })).toBe(false);
  });
});

describe("chooseIntent with lateral inhibition", () => {
  it("skips a candidate whose files another agent claims, without drawing for it", () => {
    const cands = [candidate("claimed", 5, "src", { repulsion: 1, directClaim: 1 }), candidate("free", 1, "lib")];
    const rand = sequence(0);
    expect(chooseIntent(cands, {}, NOW, rand)?.intent.id).toBe("free");
    expect(rand).toHaveBeenCalledTimes(1);
  });

  it("is not overridden by age, priority or an eager threshold", () => {
    const old: Candidate = { ...candidate("old", 10, "src", { repulsion: 1, directClaim: 1 }), intent: intent({ id: "old", priority: 10, createdAt: NOW - 600 * MIN }) };
    expect(chooseIntent([old], { src: 0.01 }, NOW, () => 0)).toBeNull();
    expect(chooseIntent([old, candidate("free", 0.5, "lib")], { src: 0.01 }, NOW, () => 0)?.intent.id).toBe("free");
  });

  it("returns null when every candidate is inhibited", () => {
    const cands = [candidate("a", 2, "src", { directClaim: 0.5 }), candidate("b", 3, "lib", { directClaim: 2 })];
    expect(chooseIntent(cands, {}, NOW, () => 0)).toBeNull();
  });

  it("leaves a claim below the threshold soft: it only lowers the stimulus", () => {
    // A decayed claim of 0.4: still the best candidate (stimulus 3 - 0.4 > 2), so it is taken.
    const cands = [candidate("decayed", 3, "src", { repulsion: 0.4, directClaim: 0.4 }), candidate("other", 2, "lib")];
    expect(chooseIntent(cands, {}, NOW, () => 0)?.intent.id).toBe("decayed");
  });

  it("keeps co-change repulsion soft however large it is", () => {
    // Repulsion from claimed neighbors (no claim on the intent's own files) never skips a candidate.
    const coupled: Candidate = { ...candidate("coupled", 1, "src", { repulsion: 5 }), intent: intent({ id: "coupled", priority: 1, createdAt: NOW - 60 * MIN }) };
    expect(chooseIntent([coupled], {}, NOW, () => 0)?.intent.id).toBe("coupled");
  });

  it("takes a custom threshold (Infinity turns lateral inhibition off)", () => {
    const cands = [candidate("claimed", 5, "src", { repulsion: 1, directClaim: 1 }), candidate("free", 1, "lib")];
    expect(chooseIntent(cands, {}, NOW, () => 0, 1, Infinity)?.intent.id).toBe("claimed");
    expect(chooseIntent(cands, {}, NOW, () => 0, 1, 1.5)?.intent.id).toBe("claimed");
    expect(chooseIntent(cands, {}, NOW, () => 0, 1, 1)?.intent.id).toBe("free");
  });

  it("treats a missing directClaim as no claim", () => {
    expect(chooseIntent([candidate("a", 1, "src")], {}, NOW, () => 0)?.intent.id).toBe("a");
  });
});

describe("reinforceThreshold", () => {
  it("starts a missing region from 1", () => {
    expect(reinforceThreshold({}, "src")).toEqual({ src: 0.8 });
  });

  it("multiplies by 0.8", () => {
    expect(reinforceThreshold({ src: 0.5 }, "src").src).toBeCloseTo(0.4, 15);
  });

  it("floors at 0.1 and converges there", () => {
    expect(reinforceThreshold({ src: 0.11 }, "src").src).toBe(0.1);
    let t: Record<string, number> = {};
    for (let i = 0; i < 40; i++) t = reinforceThreshold(t, "src");
    expect(t.src).toBe(0.1);
  });

  it("never raises a threshold already below the floor", () => {
    expect(reinforceThreshold({ src: 0.05 }, "src").src).toBe(0.05);
    expect(reinforceThreshold({ src: 0 }, "src").src).toBe(0);
  });

  it("returns a new record and leaves other regions alone", () => {
    const input = { src: 1, lib: 0.3 };
    const out = reinforceThreshold(input, "src");
    expect(out).toEqual({ src: 0.8, lib: 0.3 });
    expect(input).toEqual({ src: 1, lib: 0.3 });
    expect(out).not.toBe(input);
  });

  it("treats NaN as missing", () => {
    expect(reinforceThreshold({ src: Number.NaN }, "src").src).toBe(0.8);
  });

  it("handles region names that collide with Object.prototype", () => {
    const out = reinforceThreshold({}, "constructor");
    expect(Object.hasOwn(out, "constructor")).toBe(true);
    expect(out["constructor"]).toBe(0.8);
  });
});

describe("admissionOpen", () => {
  it("admits up to minAgents (3) when nothing is landing", () => {
    expect(admissionOpen(0, 0)).toBe(true);
    expect(admissionOpen(2, 0)).toBe(true);
    expect(admissionOpen(3, 0)).toBe(false);
  });

  it("caps at k (2) times the landing rate", () => {
    expect(admissionOpen(9, 5)).toBe(true);
    expect(admissionOpen(10, 5)).toBe(false);
    expect(admissionOpen(2, 1)).toBe(true);
    expect(admissionOpen(3, 1)).toBe(false);
    expect(admissionOpen(3, 1.6)).toBe(true);
  });

  it("accepts custom k and minAgents", () => {
    expect(admissionOpen(5, 2, 3, 1)).toBe(true);
    expect(admissionOpen(6, 2, 3, 1)).toBe(false);
    expect(admissionOpen(0, 0, 2, 0)).toBe(false);
  });

  it("treats a negative or NaN landing rate as 0", () => {
    expect(admissionOpen(2, Number.NaN)).toBe(true);
    expect(admissionOpen(3, -5)).toBe(false);
  });
});
