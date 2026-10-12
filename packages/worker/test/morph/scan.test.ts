import { describe, expect, it, vi } from "vitest";
import type { Rule } from "@fire_trident/core";
import { MAX_SCAN_BYTES, isSourcePath, mapLimit, scanFiles, scanRule, withinBytes } from "../../src/morph/scan.ts";
import type { Env } from "../../src/env.ts";

function rule(kind: Rule["kind"], spec: Record<string, unknown>): Rule {
  return { id: "r1", colonyId: "c1", kind, spec, description: "test rule", approvedBy: "tester", createdAt: 0 };
}

describe("isSourcePath", () => {
  it("accepts TypeScript and JavaScript sources", () => {
    for (const p of ["a.ts", "src/a.tsx", "src/b/c.js", "x.jsx", "m.mjs", "c.cjs", "m.mts", "c.cts", "types/index.d.ts", "src/A.TS"]) {
      expect(isSourcePath(p), p).toBe(true);
    }
  });

  it("rejects other files, minified bundles, and node_modules", () => {
    for (const p of ["README.md", "package.json", "src/a.ts.snap", "Makefile", "src/.ts", "dist/app.min.js", "node_modules/x/index.js", "pkg/node_modules/y/a.ts"]) {
      expect(isSourcePath(p), p).toBe(false);
    }
  });
});

describe("withinBytes", () => {
  it("counts UTF-8 bytes, not UTF-16 units", () => {
    expect(withinBytes("abc", 3)).toBe(true);
    expect(withinBytes("abcd", 3)).toBe(false);
    expect(withinBytes("é", 2)).toBe(true); // 2 bytes
    expect(withinBytes("é", 1)).toBe(false);
    expect(withinBytes("€", 3)).toBe(true); // 3 bytes
    expect(withinBytes("€", 2)).toBe(false);
    expect(withinBytes("😀", 4)).toBe(true); // surrogate pair, 4 bytes
    expect(withinBytes("😀", 3)).toBe(false);
  });

  it("handles the scan limit boundary", () => {
    expect(withinBytes("x".repeat(MAX_SCAN_BYTES), MAX_SCAN_BYTES)).toBe(true);
    expect(withinBytes("x".repeat(MAX_SCAN_BYTES + 1), MAX_SCAN_BYTES)).toBe(false);
    expect(withinBytes("é".repeat(MAX_SCAN_BYTES / 2), MAX_SCAN_BYTES)).toBe(true);
    expect(withinBytes("é".repeat(MAX_SCAN_BYTES / 2 + 1), MAX_SCAN_BYTES)).toBe(false);
  });
});

describe("mapLimit", () => {
  it("keeps input order and never exceeds the limit", async () => {
    let active = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 4, 2, 3, 0, 6], 3, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, n));
      active--;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30, 0, 60]);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("handles empty input", async () => {
    expect(await mapLimit([], 16, async () => 1)).toEqual([]);
  });
});

describe("scanFiles", () => {
  const consoleRule = rule("forbid-pattern", {
    pattern: "console\\.(log|error)\\(",
    include: ["src/**"],
    exclude: ["**/*.test.ts"],
    hint: "Use the logger from src/log.ts",
  });

  it("checks only applicable source files and sorts by path and line", () => {
    const violations = scanFiles(consoleRule, [
      { path: "src/lib/deep.tsx", content: "line1\nline2\n  console.error(e);\n" },
      { path: "src/app/main.ts", content: "import { x } from './x.ts';\nconsole.log('hi');\nconst y = 1;\n" },
      { path: "src/app/util.ts", content: "export const a = 1;\n" },
      { path: "src/app/main.test.ts", content: "console.log('excluded by glob');\n" },
      { path: "README.md", content: "console.log('not source');\n" },
      { path: "scripts/tool.ts", content: "console.log('outside include');\n" },
      { path: "src/app/bundle.min.js", content: "console.log(1);\n" },
      { path: "src/vendor/big.js", content: "console.log(1);\n" + "x".repeat(MAX_SCAN_BYTES) },
    ]);
    expect(violations.map((v) => [v.path, v.line])).toEqual([
      ["src/app/main.ts", 2],
      ["src/lib/deep.tsx", 3],
    ]);
    for (const v of violations) expect(v.ruleId).toBe("r1");
  });

  it("finds forbidden imports only in the importing globs", () => {
    const boundary = rule("forbid-import", { from: ["src/ui/**"], module: "^\\.\\./(db|server)/", hint: "Go through src/api" });
    const violations = scanFiles(boundary, [
      { path: "src/ui/page.tsx", content: "import { q } from '../db/query.ts';\nimport React from 'react';\nexport * from '../server/x.ts';\n" },
      { path: "src/api/handler.ts", content: "import { q } from '../db/query.ts';\n" },
    ]);
    expect(violations.map((v) => [v.path, v.line])).toEqual([
      ["src/ui/page.tsx", 1],
      ["src/ui/page.tsx", 3],
    ]);
  });

  it("returns nothing when no file applies", () => {
    expect(scanFiles(consoleRule, [{ path: "docs/a.md", content: "console.log(1)" }])).toEqual([]);
  });
});

describe("scanRule", () => {
  const consoleRule = rule("forbid-pattern", { pattern: "console\\.log\\(", include: ["src/**"], hint: "Use the logger" });

  function fakeEnv(files: Record<string, { size?: number; content: string | null; failures?: number }>) {
    const reads: string[] = [];
    const failures = new Map(Object.entries(files).map(([p, f]) => [p, f.failures ?? 0]));
    const stub = {
      files: async () => Object.entries(files).map(([path, f]) => ({ path, size: f.size ?? (f.content ?? "").length, blob: "0".repeat(40) })),
      readFile: async (path: string) => {
        reads.push(path);
        const left = failures.get(path) ?? 0;
        if (left > 0) {
          failures.set(path, left - 1);
          throw new Error("transient");
        }
        return files[path]?.content ?? null;
      },
    };
    const env = { TRUNK: { idFromName: (name: string) => name, get: () => stub } } as unknown as Env;
    return { env, reads };
  }

  it("reads only applicable source files under the size limit and checks them", async () => {
    const { env, reads } = fakeEnv({
      "src/a.ts": { content: "console.log(1);\n" },
      "src/big.ts": { size: MAX_SCAN_BYTES + 1, content: "console.log(2);\n" },
      "src/readme.md": { content: "console.log(3);\n" },
      "lib/b.ts": { content: "console.log(4);\n" },
      "src/gone.ts": { content: null },
    });
    const violations = await scanRule(env, "c1", consoleRule);
    expect(violations.map((v) => [v.path, v.line])).toEqual([["src/a.ts", 1]]);
    expect(reads.sort()).toEqual(["src/a.ts", "src/gone.ts"]);
  });

  it("retries a failed read once, then skips a file that stays unreadable", async () => {
    const { env, reads } = fakeEnv({
      "src/flaky.ts": { content: "console.log(1);\n", failures: 1 },
      "src/broken.ts": { content: "console.log(2);\n", failures: 5 },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const violations = await scanRule(env, "c1", consoleRule);
    expect(violations.map((v) => v.path)).toEqual(["src/flaky.ts"]);
    expect(reads.filter((p) => p === "src/broken.ts")).toHaveLength(2);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
