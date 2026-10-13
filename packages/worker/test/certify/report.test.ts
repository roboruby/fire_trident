import { describe, expect, it } from "vitest";
import { MAX_FAILING, MAX_NAME, countsLine, summarize, type RunReport } from "../../src/certify/report.ts";

const report = (tests: RunReport["tests"], suites: RunReport["suites"] = []): RunReport => ({ runner: "x", files: [], tests, suites, ms: 1 });

describe("summarize a run", () => {
  it("counts like node --test and goes green only when nothing failed or was cancelled", () => {
    const s = summarize(
      report([
        { name: "a", file: "t.ts", status: "pass" },
        { name: "b", file: "t.ts", status: "skipped" },
        { name: "c", file: "t.ts", status: "todo", error: "Error: later" },
      ]),
    );
    expect(s).toEqual({ status: "green", counts: { tests: 3, pass: 1, fail: 0, cancelled: 0, skipped: 1, todo: 1, suites: 0 }, failing: [] });
    expect(countsLine(s.counts)).toBe("1/3 tests · 1 skipped · 1 todo");
  });

  it("goes red on a failure, a cancellation, or a suite that failed on its own", () => {
    const failing = summarize(report([{ name: "a", file: "t.ts", status: "fail", error: "Error: x" }]));
    expect(failing.status).toBe("red");
    expect(failing.failing).toEqual([{ name: "a", file: "t.ts", error: "Error: x" }]);
    const cancelled = summarize(report([{ name: "a", file: "t.ts", status: "cancelled", error: "test timed out after 5ms" }]));
    expect(cancelled.failing).toEqual([{ name: "a", file: "t.ts", error: "cancelled: test timed out after 5ms" }]);
    expect(countsLine(cancelled.counts)).toBe("1 failing");
    const hook = summarize(report([{ name: "a", file: "t.ts", status: "pass" }], [{ name: "s", file: "t.ts", status: "fail", error: "Error: after" }]));
    expect(hook.status).toBe("red");
    expect(hook.failing).toEqual([{ name: "s (suite)", file: "t.ts", error: "Error: after" }]);
    // A suite failing only because a test in it failed is not counted twice.
    const plain = summarize(report([{ name: "s > a", file: "t.ts", status: "fail" }], [{ name: "s", file: "t.ts", status: "fail" }]));
    expect(plain.failing).toHaveLength(1);
  });

  it("names skipped and todo tests in the counts line, so a test that stops running never drops out of it", () => {
    const k = (over: Partial<Record<"tests" | "pass" | "fail" | "cancelled" | "skipped" | "todo", number>>) => ({ tests: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0, suites: 0, ...over });
    expect(countsLine(k({ tests: 60, pass: 60 }))).toBe("60/60 tests");
    expect(countsLine(k({ tests: 60, pass: 58, skipped: 2 }))).toBe("58/60 tests · 2 skipped");
    expect(countsLine(k({ tests: 60, pass: 59, todo: 1 }))).toBe("59/60 tests · 1 todo");
    expect(countsLine(k({ tests: 67, pass: 61, fail: 5, cancelled: 1 }))).toBe("6 failing");
    expect(countsLine(k({ tests: 67, pass: 60, fail: 5, skipped: 2 }))).toBe("5 failing · 2 skipped");
    expect(countsLine(undefined)).toBe("");
  });

  it("judges nothing when there are no tests, and caps what it keeps", () => {
    expect(summarize(report([])).status).toBe("skipped");
    const many = summarize(report(Array.from({ length: 80 }, (_, i) => ({ name: `t${i}`, file: "t.ts", status: "fail" as const, error: "e".repeat(1_000) }))));
    expect(many.counts.fail).toBe(80);
    expect(many.failing).toHaveLength(MAX_FAILING);
    expect(many.failing[0]!.error!.length).toBe(300);
    // A test name is the repository's text: a very long one is cut to one line.
    const long = summarize(report([{ name: "n".repeat(5_000), file: "t.ts", status: "fail" }], [{ name: "s".repeat(5_000), file: "t.ts", status: "fail", error: "Error: x" }]));
    expect(long.failing[0]!.name.length).toBe(MAX_NAME);
    expect(long.failing[1]!.name).toBe(`${"s".repeat(MAX_NAME - 1)}… (suite)`);
  });
});
