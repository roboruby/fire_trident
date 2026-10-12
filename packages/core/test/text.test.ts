import { describe, expect, it } from "vitest";
import { oneLine, truncate } from "../src/text.ts";

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

describe("oneLine", () => {
  it("collapses whitespace runs, newlines included, and trims", () => {
    expect(oneLine("  a\n\n b\t\tc \r\n")).toBe("a b c");
    expect(oneLine("")).toBe("");
  });
});

describe("truncate", () => {
  it("leaves short and exact-length text alone", () => {
    expect(truncate("abc", 5)).toBe("abc");
    expect(truncate("abcde", 5)).toBe("abcde");
  });

  it("cuts to exactly max characters with an ellipsis", () => {
    const out = truncate("x".repeat(100), 72);
    expect(out).toHaveLength(72);
    expect(out.endsWith("…")).toBe(true);
  });

  it("drops trailing spaces before the ellipsis", () => {
    expect(truncate("abc   defghij", 7)).toBe("abc…");
  });

  it("never splits a surrogate pair", () => {
    const text = `${"a".repeat(70)}\u{1F600}${"b".repeat(10)}`;
    const out = truncate(text, 72);
    expect(out.length).toBeLessThanOrEqual(72);
    expect(out).not.toMatch(LONE_SURROGATE);
    expect(out).toBe(`${"a".repeat(70)}…`);
  });

  it("returns an empty string for max below 1", () => {
    expect(truncate("abc", 0)).toBe("");
    expect(truncate("abc", 1)).toBe("…");
  });
});
