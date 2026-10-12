import { describe, expect, it } from "vitest";
import { addedFromHunks, clip, diffLines, fileDiff, renderHunks, splitLines } from "../../src/decide/diff.ts";
import { isTestPath, sensitiveReason } from "../../src/decide/signals.ts";

describe("diffLines", () => {
  it("finds the shortest edit script", () => {
    const ops = diffLines(["a", "b", "c", "d"], ["a", "x", "c", "d", "e"]);
    expect(ops.map((o) => `${o.kind}${o.text}`)).toEqual(["=a", "-b", "+x", "=c", "=d", "+e"]);
  });

  it("handles empty sides", () => {
    expect(diffLines([], ["a"]).map((o) => o.kind)).toEqual(["+"]);
    expect(diffLines(["a"], []).map((o) => o.kind)).toEqual(["-"]);
    expect(diffLines([], [])).toEqual([]);
  });

  it("reconstructs both texts", () => {
    const a = splitLines("one\ntwo\nthree\nfour\nfive\nsix\n");
    const b = splitLines("zero\none\nthree\nfour\nFIVE\nsix\nseven\n");
    const ops = diffLines(a, b);
    expect(ops.filter((o) => o.kind !== "+").map((o) => o.text)).toEqual(a);
    expect(ops.filter((o) => o.kind !== "-").map((o) => o.text)).toEqual(b);
  });
});

describe("renderHunks", () => {
  it("renders unified hunks with line numbers and context", () => {
    const a = Array.from({ length: 20 }, (_, i) => `l${i + 1}`);
    const b = [...a];
    b[1] = "L2";
    b[17] = "L18";
    const text = renderHunks(diffLines(a, b), 1);
    expect(text.split("\n")).toEqual(["@@ -1,3 +1,3 @@", " l1", "-l2", "+L2", " l3", "@@ -17,3 +17,3 @@", " l17", "-l18", "+L18", " l19"]);
    expect(addedFromHunks(text)).toEqual(["L2", "L18"]);
  });
});

describe("fileDiff", () => {
  it("summarizes a modified file and caps the hunks", () => {
    const before = "import fs from 'fs';\nimport path from 'path';\nexport {};\n";
    const after = "import fs from 'node:fs';\nimport path from 'node:path';\nexport {};\n";
    const d = fileDiff("src/a.ts", before, after);
    expect(d).toMatchObject({ status: "modified", added: 2, removed: 2, truncated: false });
    expect(d.addedLines).toEqual(["import fs from 'node:fs';", "import path from 'node:path';"]);
    expect(fileDiff("src/b.ts", null, "x\n")).toMatchObject({ status: "added", added: 1 });
    expect(fileDiff("src/b.ts", "x\n", null)).toMatchObject({ status: "deleted", removed: 1 });
    expect(fileDiff("img.png", null, null, { binary: true }).status).toBe("binary");
    const big = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    expect(fileDiff("src/c.ts", "", big, { maxChars: 200 }).truncated).toBe(true);
  });

  it("clips on a line boundary", () => {
    expect(clip("aaaa\nbbbb\ncccc", 11)).toEqual({ text: "aaaa\nbbbb\n… (truncated)", truncated: true });
    expect(clip("aaaa\nbbbb", 20)).toEqual({ text: "aaaa\nbbbb", truncated: false });
  });
});

describe("sensitive paths", () => {
  it("flags secrets, CI, dependency manifests and colony memory", () => {
    expect(sensitiveReason("package.json")).toBe("dependency manifest");
    expect(sensitiveReason("packages/web/package.json")).toBe("dependency manifest");
    expect(sensitiveReason(".github/workflows/ci.yml")).toBe("CI configuration");
    expect(sensitiveReason(".env.production")).toBe("secrets file");
    expect(sensitiveReason("src/auth/session.ts")).toBe("authentication");
    expect(sensitiveReason(".firetrident/antibodies/ab_1.json")).toBe("FireTrident colony memory (antibodies)");
    expect(sensitiveReason("src/core/author.ts")).toBeNull();
    expect(sensitiveReason("src/core/list.ts")).toBeNull();
  });

  it("recognizes test files", () => {
    expect(isTestPath("test/core/list.test.ts")).toBe(true);
    expect(isTestPath("src/a.spec.tsx")).toBe(true);
    expect(isTestPath("src/core/list.ts")).toBe(false);
  });
});
