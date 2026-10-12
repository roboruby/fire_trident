import { describe, expect, it } from "vitest";
import type { Violation } from "@fire_trident/core";
import { FieldBatch, groupByRegion, jitter, normalizePath, normalizePaths, overlapCount, primaryRegion, ruleHint, ruleIntentTitle, slug, violationIntents } from "../../src/colony/logic.ts";

describe("paths and regions", () => {
  it("normalizes repository paths", () => {
    expect(normalizePath(" ./src/a.ts ")).toBe("src/a.ts");
    expect(normalizePath("/src//lib///b.ts")).toBe("src/lib/b.ts");
    expect(normalizePath("src\\win\\c.ts")).toBe("src/win/c.ts");
    expect(normalizePath("././x")).toBe("x");
    expect(normalizePath("src/dir/")).toBe("src/dir/");
    expect(normalizePaths(["a", "./a", "", "  ", "b"])).toEqual(["a", "b"]);
  });

  it("groups paths by region at a depth", () => {
    const paths = ["src/a.ts", "README.md", "src/lib/b.ts", "docs/x.md", "src/a.ts"];
    expect([...groupByRegion(paths, 1)]).toEqual([
      ["src", ["src/a.ts", "src/lib/b.ts"]],
      [".", ["README.md"]],
      ["docs", ["docs/x.md"]],
    ]);
    expect([...groupByRegion(paths, 2)].map(([r]) => r)).toEqual(["src", ".", "src/lib", "docs"]);
  });

  it("picks the region holding most paths, ties to the earliest", () => {
    expect(primaryRegion(["docs/a.md", "src/a.ts", "src/b.ts"], 1)).toBe("src");
    expect(primaryRegion(["docs/a.md", "src/a.ts"], 1)).toBe("docs");
    expect(primaryRegion([], 1)).toBe(".");
  });
});

describe("violationIntents", () => {
  const v = (path: string, line: number): Violation => ({ ruleId: "r", path, line, excerpt: "secret excerpt", message: "m" });

  it("drafts one intent per file with lines but no excerpts", () => {
    const drafts = violationIntents({ description: "No console.log", spec: { hint: " use the logger " } }, [v("src/a.ts", 9), v("src/a.ts", 2), v("./src/b.ts", 4), v("src/a.ts", 2)]);
    expect(drafts).toEqual([
      { path: "src/a.ts", title: "No console.log in src/a.ts", why: "No console.log.\nHint: use the logger\n3 violations on lines 2, 9.", violations: 3 },
      { path: "src/b.ts", title: "No console.log in src/b.ts", why: "No console.log.\nHint: use the logger\nViolation on line 4.", violations: 1 },
    ]);
    expect(drafts.some((d) => d.why.includes("secret excerpt"))).toBe(false);
  });

  it("handles missing hints, trailing periods and long line lists", () => {
    const many = Array.from({ length: 25 }, (_, i) => v("x.ts", i + 1));
    const [d] = violationIntents({ description: "Avoid eval.", spec: {} }, many);
    expect(d!.title).toBe("Avoid eval in x.ts");
    expect(d!.why).toBe(`Avoid eval.\n25 violations on lines ${Array.from({ length: 20 }, (_, i) => i + 1).join(", ")}, and 5 more.`);
    expect(ruleHint({ spec: { hint: 42 } })).toBe("");
    expect(violationIntents({ description: "x", spec: {} }, [])).toEqual([]);
  });

  it("titles rule intents without the description's trailing punctuation", () => {
    expect(ruleIntentTitle("Use the shared logger instead of console.log.", "src/a.ts")).toBe("Use the shared logger instead of console.log in src/a.ts");
    expect(ruleIntentTitle("  No eval! ", "a.ts")).toBe("No eval in a.ts");
    expect(ruleIntentTitle("Keep imports clean;.. ", "a.ts")).toBe("Keep imports clean in a.ts");
    expect(ruleIntentTitle("No console.log", "a.ts")).toBe("No console.log in a.ts");
    expect(ruleIntentTitle("...", "a.ts")).toBe("... in a.ts");
  });
});

describe("FieldBatch", () => {
  it("routes deposits and clears to regions", () => {
    const b = new FieldBatch(1)
      .deposit("claim", ["src/a.ts", "README.md"], 1, 100, { agentId: "a1", intentId: "i1" })
      .clear(["src/a.ts", "src/b.ts", "docs/x.md"], { agentId: "a1", kind: "claim" })
      .landing(["src", "lib"], "l1");
    expect(b.size).toBe(4);
    expect(b.byRegion.get("src")).toEqual({
      deposit: [{ kind: "claim", path: "src/a.ts", strength: 1, at: 100, agentId: "a1", intentId: "i1" }],
      clear: [{ agentId: "a1", kind: "claim", paths: ["src/a.ts", "src/b.ts"] }],
      landingId: "l1",
    });
    expect(b.byRegion.get(".")).toEqual({ deposit: [{ kind: "claim", path: "README.md", strength: 1, at: 100, agentId: "a1", intentId: "i1" }] });
    expect(b.byRegion.get("docs")).toEqual({ clear: [{ agentId: "a1", kind: "claim", paths: ["docs/x.md"] }] });
    expect(b.byRegion.get("lib")).toEqual({ landingId: "l1" });
  });

  it("omits agent and intent when not given", () => {
    const b = new FieldBatch(1).deposit("trail", ["src/a.ts"], 1, 5);
    expect(b.byRegion.get("src")!.deposit).toEqual([{ kind: "trail", path: "src/a.ts", strength: 1, at: 5 }]);
  });
});

describe("overlapCount", () => {
  it("counts claimed paths that touch a footprint, including directories and globs", () => {
    expect(overlapCount(new Set(["src/a.ts", "src/b.ts"]), ["src/a.ts"])).toBe(1);
    expect(overlapCount(new Set(["src/a.ts", "src/b.ts"]), ["src/a.ts", "src/b.ts"])).toBe(2);
    expect(overlapCount(new Set(["src/lib/"]), ["src/lib/x.ts"])).toBe(1);
    expect(overlapCount(new Set(["src/lib/x.ts"]), ["src/**/*.ts"])).toBe(1);
    expect(overlapCount(new Set(["docs/a.md"]), ["src/a.ts"])).toBe(0);
    expect(overlapCount(new Set(), ["src/a.ts"])).toBe(0);
  });
});

describe("misc", () => {
  it("jitters within plus or minus 25%", () => {
    expect(jitter(1000, () => 0)).toBe(750);
    expect(jitter(1000, () => 1)).toBe(1250);
    expect(jitter(1000, () => 0.5)).toBe(1000);
  });

  it("slugs colony names", () => {
    expect(slug("Démo App #1")).toBe("demo-app-1");
    expect(slug("honojs/hono")).toBe("honojs-hono");
    expect(slug("  --Hello__World--  ")).toBe("hello-world");
    expect(slug("!!!")).toBe("");
    const long = slug("a".repeat(47) + " b c");
    expect(long.length).toBeLessThanOrEqual(48);
    expect(long.endsWith("-")).toBe(false);
  });
});
