import { describe, expect, it } from "vitest";
import { fileKeyText, mergeResults, splitReport } from "../../src/certify/cache.ts";
import type { RunReport } from "../../src/certify/report.ts";

const report: RunReport = {
  runner: "r",
  ms: 5,
  files: [
    { path: "test/a.test.ts", ms: 1, tests: 2, loadError: null },
    { path: "test/b.test.ts", ms: 1, tests: 1, loadError: "SyntaxError: x" },
    { path: "test/c.test.ts", ms: 1, tests: 1, loadError: null },
  ],
  tests: [
    { name: "a1", file: "test/a.test.ts", status: "pass" },
    { name: "a2", file: "test/a.test.ts", status: "fail", error: "Error: no" },
    { name: "test/b.test.ts", file: "test/b.test.ts", status: "fail", error: "SyntaxError: x" },
    { name: "c1", file: "test/c.test.ts", status: "cancelled", error: "not run: the certification ran out of time" },
  ],
  suites: [{ name: "s", file: "test/a.test.ts", status: "fail" }],
};

describe("per-file results", () => {
  it("keys a file by what it reaches, in any order, with the runner and the test limit", () => {
    const blobs = new Map([
      ["test/a.test.ts", "1"],
      ["src/x.ts", "2"],
    ]);
    const k = fileKeyText("test/a.test.ts", ["test/a.test.ts", "src/x.ts"], blobs, "r1", 10);
    expect(k).toBe(fileKeyText("test/a.test.ts", ["src/x.ts", "test/a.test.ts"], blobs, "r1", 10));
    expect(k).not.toBe(fileKeyText("test/a.test.ts", ["src/x.ts", "test/a.test.ts"], new Map([...blobs, ["src/x.ts", "3"]]), "r1", 10));
    expect(k).not.toBe(fileKeyText("test/a.test.ts", ["test/a.test.ts", "src/x.ts"], blobs, "r2", 10));
    expect(k).not.toBe(fileKeyText("test/a.test.ts", ["test/a.test.ts", "src/x.ts"], blobs, "r1", 20));
  });

  it("splits a run per file, leaving out results that depended on the run's time", () => {
    const split = splitReport(report, ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts"]);
    expect([...split.keys()]).toEqual(["test/a.test.ts", "test/b.test.ts"]);
    expect(split.get("test/a.test.ts")).toEqual({ path: "test/a.test.ts", loadError: null, tests: report.tests.slice(0, 2), suites: report.suites });
    expect(split.get("test/b.test.ts")?.loadError).toBe("SyntaxError: x");
    expect([...splitReport(report, ["test/c.test.ts"], true).keys()]).toEqual(["test/c.test.ts"]);
  });

  it("never keeps a file whose runner could not start, or whose suite hook ran out of the run's time", () => {
    const run: RunReport = {
      runner: "r",
      ms: 5,
      files: [
        { path: "test/b.test.ts", ms: 0, tests: 1, loadError: "runner failed: assign is gone" },
        { path: "test/d.test.ts", ms: 1, tests: 1, loadError: null },
        { path: "test/e.test.ts", ms: 1, tests: 1, loadError: null },
      ],
      tests: [
        { name: "test/b.test.ts", file: "test/b.test.ts", status: "fail", error: "runner failed: assign is gone" },
        { name: "s > t", file: "test/d.test.ts", status: "cancelled", error: "test did not finish before its parent and was cancelled" },
        { name: "e", file: "test/e.test.ts", status: "pass" },
      ],
      suites: [{ name: "s", file: "test/d.test.ts", status: "fail", error: "Error: the certification ran out of time while this hook ran" }],
    };
    const paths = ["test/b.test.ts", "test/d.test.ts", "test/e.test.ts"];
    expect([...splitReport(run, paths).keys()]).toEqual(["test/e.test.ts"]);
    // This run's verdict still counts them.
    expect([...splitReport(run, paths, true).keys()]).toEqual(paths);
  });

  it("merges cached and fresh results back into one report, in file order", () => {
    const all = splitReport(report, ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts"], true);
    const merged = mergeResults(["test/c.test.ts", "test/a.test.ts", "test/missing.test.ts"], all, "r", 9);
    expect(merged.files.map((f) => f.path)).toEqual(["test/c.test.ts", "test/a.test.ts"]);
    expect(merged.tests.map((t) => t.name)).toEqual(["c1", "a1", "a2"]);
    expect(merged.suites).toHaveLength(1);
    expect(merged.ms).toBe(9);
  });
});
