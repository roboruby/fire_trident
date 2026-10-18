import { describe, expect, it } from "vitest";
import { AGE_FACTOR_CAP } from "@fire_trident/core";
import { ageCapFor, directClaims, inhibitStrongestOn, lowerClaim, strongestClaim, type DirectView } from "../../src/colony/takemath.ts";

describe("take math flags", () => {
  it("read like FT_REVALIDATE: on, a list of colony ids, or off when absent", () => {
    expect(inhibitStrongestOn(undefined, "hono")).toBe(false);
    expect(inhibitStrongestOn("off", "hono")).toBe(false);
    expect(inhibitStrongestOn("on", "hono")).toBe(true);
    expect(inhibitStrongestOn("scale, hono", "hono")).toBe(true);
    expect(inhibitStrongestOn("scale", "hono")).toBe(false);
    expect(ageCapFor(undefined, "hono")).toBe(Number.POSITIVE_INFINITY);
    expect(ageCapFor("on", "hono")).toBe(AGE_FACTOR_CAP);
    expect(ageCapFor("scale", "hono")).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("directClaims", () => {
  const view = (over: Partial<DirectView> = {}): DirectView => ({ byPath: {}, repulsive: true, unseen: [], ...over });

  it("adds a repulsive reading's claims and each recent claim it may not include, per file", () => {
    const views = new Map([
      ["src", view({ byPath: { "src/a.ts": { claim: 0.4 }, "src/b.ts": { claim: 0.3 }, "src/": { claim: 2 } }, unseen: [{ paths: new Set(["src/a.ts"]) }] })],
      ["lib", view({ byPath: { "lib/c.ts": { claim: 0.2 } } })],
    ]);
    const claims = directClaims(
      new Map([
        ["src", ["src/a.ts", "src/b.ts"]],
        ["lib", ["lib/c.ts"]],
      ]),
      views,
      1,
    );
    expect([...claims]).toEqual([
      ["src/a.ts", 1.4],
      ["src/b.ts", 0.3],
      ["lib/c.ts", 0.2],
    ]);
    expect(strongestClaim(claims)).toBe(1.4);
  });

  it("skips an unreadable region and a reading that does not repel (its recent claims still count)", () => {
    const views = new Map([["src", view({ repulsive: false, byPath: { "src/a.ts": { claim: 1 } }, unseen: [{ paths: new Set(["src/b.ts"]) }] })]]);
    const claims = directClaims(
      new Map([
        ["src", ["src/a.ts", "src/b.ts"]],
        ["gone", ["gone/x.ts"]],
      ]),
      views,
      1,
    );
    expect([...claims]).toEqual([["src/b.ts", 1]]);
  });

  it("lowerClaim takes a contestant's share off one file, never below 0", () => {
    const claims = new Map([["a", 1.5]]);
    lowerClaim(claims, "a", 1);
    expect(claims.get("a")).toBe(0.5);
    lowerClaim(claims, "a", 1);
    lowerClaim(claims, "missing", 1);
    expect([...claims]).toEqual([["a", 0]]);
    expect(strongestClaim(claims)).toBe(0);
  });
});
