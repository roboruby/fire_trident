import { afterEach, describe, expect, it, vi } from "vitest";
import { newId, regionKey, regionOf } from "../src/ids.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("newId", () => {
  it("is prefix + 8 base36 time digits + 6 base36 random characters", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_760_000_000_000);
    const id = newId("int_");
    expect(id).toMatch(/^int_[0-9a-z]{14}$/);
    expect(parseInt(id.slice(4, 12), 36)).toBe(1_760_000_000_000);
  });

  it("defaults to no prefix", () => {
    expect(newId()).toMatch(/^[0-9a-z]{14}$/);
  });

  it("draws one random base36 character per Math.random call", () => {
    vi.spyOn(Date, "now").mockReturnValue(0);
    const random = vi.spyOn(Math, "random");
    for (const draw of [0, 0.5, 0.999999, 0.1, 0.25, 0.75]) random.mockReturnValueOnce(draw);
    expect(newId("x_")).toBe("x_00000000" + "0iz39r");
    expect(random).toHaveBeenCalledTimes(6);
  });

  it("sorts by creation time, even when the random part says otherwise", () => {
    const times = [35, 36, 1_295, 1_296, 1_700_000_000_000, 1_760_000_000_000];
    const now = vi.spyOn(Date, "now");
    const random = vi.spyOn(Math, "random");
    const ids = times.map((t, i) => {
      now.mockReturnValue(t);
      random.mockReturnValue(i % 2 === 0 ? 0.999 : 0);
      return newId("prp_");
    });
    expect([...ids].sort()).toEqual(ids);
  });

  it("does not repeat within one millisecond", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_760_000_000_000);
    const ids = new Set(Array.from({ length: 200 }, () => newId()));
    expect(ids.size).toBe(200);
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
