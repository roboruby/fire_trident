import { afterEach, describe, expect, it, vi } from "vitest";
import { newId, regionKey, regionOf } from "../src/ids.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("newId", () => {
  it("is prefix + 8 base36 time digits + 6 base36 random characters", () => {
    const id = newId("int_", 1_760_000_000_000, () => 0.5);
    expect(id).toMatch(/^int_[0-9a-z]{14}$/);
    expect(parseInt(id.slice(4, 12), 36)).toBe(1_760_000_000_000);
    expect(newId("", 1_760_000_000_000, () => 0.5)).toMatch(/^[0-9a-z]{14}$/);
  });

  it("draws one random base36 character per call of the random source it is given", () => {
    const draws = [0, 0.5, 0.999999, 0.1, 0.25, 0.75];
    let calls = 0;
    expect(newId("x_", 0, () => draws[calls++]!)).toBe("x_00000000" + "0iz39r");
    expect(calls).toBe(6);
  });

  it("sorts by creation time, even when the random part says otherwise", () => {
    const times = [35, 36, 1_295, 1_296, 1_700_000_000_000, 1_760_000_000_000];
    const ids = times.map((t, i) => newId("prp_", t, () => (i % 2 === 0 ? 0.999 : 0)));
    expect([...ids].sort()).toEqual(ids);
  });

  it("is pure: it reads neither the clock nor Math.random, and the same inputs give the same id", () => {
    const now = vi.spyOn(Date, "now");
    const random = vi.spyOn(Math, "random");
    expect(newId("int_", 1_760_000_000_000, () => 0)).toBe(`int_${(1_760_000_000_000).toString(36).padStart(8, "0")}000000`);
    expect(newId("p_", 42, () => 0.3)).toBe(newId("p_", 42, () => 0.3));
    expect(now).not.toHaveBeenCalled();
    expect(random).not.toHaveBeenCalled();
  });
});

describe("regionOf", () => {
  it.each([
    ["src/a/b.ts", 1, "src"],
    ["src/a/b.ts", 2, "src/a"],
    ["src/a/b.ts", 3, "src/a"],
    ["src/b.ts", 2, "src"],
    ["README.md", 1, "."],
    ["README.md", 3, "."],
    ["src/a/b.ts", 0, "."],
    ["src/a/b.ts", -2, "."],
    ["src/a/b.ts", Infinity, "src/a"],
    ["src/a/b.ts", 1.9, "src"],
    ["", 1, "."],
  ] as const)("regionOf(%j, %d) = %j", (path, depth, region) => {
    expect(regionOf(path, depth)).toBe(region);
  });

  it("defaults to depth 1", () => {
    expect(regionOf("packages/core/src/ids.ts")).toBe("packages");
  });

  it("treats NaN depth as the default", () => {
    expect(regionOf("src/a/b.ts", NaN)).toBe("src");
  });

  it("treats a trailing slash as a directory path", () => {
    expect(regionOf("src/", 1)).toBe("src");
    expect(regionOf("src/a/", 1)).toBe("src");
    expect(regionOf("src/a/", 2)).toBe("src/a");
    expect(regionOf("src/a/", 5)).toBe("src/a");
  });

  it("ignores empty and '.' segments", () => {
    expect(regionOf("./src/x.ts")).toBe("src");
    expect(regionOf("src//a/b.ts", 2)).toBe("src/a");
    expect(regionOf("./README.md")).toBe(".");
  });

  it("stops at the first glob segment", () => {
    expect(regionOf("src/**/*.ts", 1)).toBe("src");
    expect(regionOf("src/**/*.ts", 3)).toBe("src");
    expect(regionOf("packages/*/src/a.ts", 2)).toBe("packages");
    expect(regionOf("**/*.ts")).toBe(".");
    expect(regionOf("{src,lib}/x.ts")).toBe(".");
    expect(regionOf("src/a?/x.ts", 2)).toBe("src");
  });
});

describe("regionKey", () => {
  it("joins colony and region", () => {
    expect(regionKey("col_1", "src/a")).toBe("col_1:src/a");
    expect(regionKey("col_1", ".")).toBe("col_1:.");
  });
});
