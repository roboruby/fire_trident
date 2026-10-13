import { describe, expect, it } from "vitest";
import { MAX_FAILING, MAX_NAME, countsLine, isReport, readBounded, summarize, type RunReport } from "../../src/certify/report.ts";

const report = (tests: RunReport["tests"], suites: RunReport["suites"] = []): RunReport => ({ runner: "x", files: [], tests, suites, ms: 1 });
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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

  it("counts a test file that did not load as one failing test, unless a failing or cancelled test of its own names it", () => {
    const r: RunReport = {
      runner: "x",
      ms: 1,
      files: [
        { path: "test/a.test.ts", ms: 1, tests: 1, loadError: null },
        { path: "test/b.test.ts", ms: 0, tests: 0, loadError: "runner failed: assign is gone" },
        { path: "test/c.test.ts", ms: 1, tests: 1, loadError: "SyntaxError: x" },
        { path: "test/d.test.ts", ms: 0, tests: 1, loadError: "not run: the certification ran out of time" },
      ],
      tests: [
        { name: "a", file: "test/a.test.ts", status: "pass" },
        { name: "test/c.test.ts", file: "test/c.test.ts", status: "fail", error: "SyntaxError: x" },
        { name: "test/d.test.ts", file: "test/d.test.ts", status: "cancelled", error: "not run: the certification ran out of time" },
      ],
      suites: [],
    };
    const s = summarize(r);
    expect(s.status).toBe("red");
    expect(s.counts).toEqual({ tests: 4, pass: 1, fail: 2, cancelled: 1, skipped: 0, todo: 0, suites: 0 });
    expect(s.failing).toEqual([
      { name: "test/c.test.ts", file: "test/c.test.ts", error: "SyntaxError: x" },
      { name: "test/d.test.ts", file: "test/d.test.ts", error: "cancelled: not run: the certification ran out of time" },
      { name: "test/b.test.ts", file: "test/b.test.ts", error: "runner failed: assign is gone" },
    ]);
    expect(countsLine(s.counts)).toBe("3 failing");
    // Beside passing tests, or alone: never green, never "no tests".
    expect(summarize({ ...r, files: r.files.slice(0, 2), tests: r.tests.slice(0, 1) }).status).toBe("red");
    expect(summarize({ ...r, files: [r.files[1]!], tests: [] })).toMatchObject({ status: "red", counts: { tests: 1, fail: 1 } });
  });
});

describe("reading the test Worker's answer", () => {
  it("reads a body that ends within both bounds", async () => {
    expect(await readBounded(new Response('{"ok":true} ✓').body, 1024, Date.now() + 5_000)).toEqual({ text: '{"ok":true} ✓', over: null });
    expect(await readBounded(null, 1024, Date.now() + 5_000)).toEqual({ text: "", over: null });
  });

  it("stops a body that never ends at the deadline, and cancels it", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start: (c) => c.enqueue(bytes('{"tests":[')),
      pull: () => new Promise<void>(() => undefined),
      cancel: () => {
        cancelled = true;
      },
    });
    const started = Date.now();
    expect(await readBounded(body, 1024, started + 150)).toEqual({ text: '{"tests":[', over: "time" });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(cancelled).toBe(true);
  });

  it("stops a body that trickles past the deadline", async () => {
    let sent = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull: async (c) => {
        await sleep(20);
        sent++;
        c.enqueue(bytes(" "));
      },
      cancel: () => {
        cancelled = true;
      },
    });
    const started = Date.now();
    const r = await readBounded(body, 1024 * 1024, started + 300);
    expect(r.over).toBe("time");
    expect(r.text.length).toBeGreaterThan(0);
    expect(r.text.length).toBeLessThanOrEqual(sent);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(cancelled).toBe(true);
  });

  it("stops at the size cap, counting bytes, and cancels the rest", async () => {
    let cancelled = false;
    const endless = new ReadableStream<Uint8Array>({
      pull: (c) => c.enqueue(new Uint8Array(1000).fill(0x20)),
      cancel: () => {
        cancelled = true;
      },
    });
    const r = await readBounded(endless, 4_500, Date.now() + 5_000);
    expect(r).toEqual({ text: " ".repeat(4_500), over: "size" });
    expect(cancelled).toBe(true);
    // Bytes, not characters: "é" is two bytes.
    expect(await readBounded(new Response("éé").body, 4, Date.now() + 5_000)).toEqual({ text: "éé", over: null });
    expect(await readBounded(new Response("ééé").body, 4, Date.now() + 5_000)).toEqual({ text: "éé", over: "size" });
  });

  it("keeps many small chunks in one buffer", async () => {
    let n = 0;
    const body = new ReadableStream<Uint8Array>({
      pull: (c) => {
        if (n++ < 20_000) c.enqueue(bytes("x"));
        else c.close();
      },
    });
    const r = await readBounded(body, 40_000, Date.now() + 30_000);
    expect(r.over).toBeNull();
    expect(r.text).toBe("x".repeat(20_000));
  }, 30_000);
});

describe("the shape of a report", () => {
  it("accepts the harness's answer and refuses anything later steps could not read", () => {
    const ok: RunReport = { runner: "x", ms: 1, files: [{ path: "t.ts", ms: 1, tests: 1, loadError: null }], tests: [{ name: "a", file: "t.ts", status: "pass" }], suites: [] };
    expect(isReport(ok)).toBe(true);
    for (const bad of [null, "report", [], { tests: [] }, { ...ok, files: "t.ts" }, { ...ok, tests: [null] }, { ...ok, files: [{ tests: 1 }] }, { ...ok, suites: [{ name: "s" }] }]) expect(isReport(bad)).toBe(false);
  });
});
