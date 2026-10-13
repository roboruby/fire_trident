import { describe, expect, it } from "vitest";
import {
  MAX_KEPT_CHARS,
  acceptInBaseline,
  acceptInOwed,
  baselineOf,
  findLost,
  lostAsFailing,
  lostDetail,
  owedOf,
  runFiles,
  type Baseline,
  type Listing,
  type OwedRepair,
} from "../../src/certify/owed.ts";
import type { ReportedTest, RunReport } from "../../src/certify/report.ts";

const GREEN = "1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const RED = "2222222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

/** A run's report from per-file tests (a file listed with a load error failed to load). */
function report(files: Record<string, Array<[string, ReportedTest["status"], string?]>>, opts: { loadErrors?: Record<string, string>; suites?: RunReport["suites"] } = {}): RunReport {
  const r: RunReport = { runner: "x", files: [], tests: [], suites: opts.suites ?? [], ms: 1 };
  for (const [path, tests] of Object.entries(files)) {
    r.files.push({ path, ms: 1, tests: tests.length, loadError: opts.loadErrors?.[path] ?? null });
    for (const [name, status, error] of tests) r.tests.push({ name, file: path, status, ...(error ? { error } : {}) });
  }
  return r;
}

const everything: Listing = { has: () => true, truncated: false };
const listed = (...paths: string[]): Listing => ({ has: (p) => paths.includes(p), truncated: false });
const baseline = (files: Record<string, string[] | number>): Baseline => ({ sha: GREEN, files: new Map(Object.entries(files)) });
const none = { unsupported: [], via: new Map<string, string>() };

describe("what a green run proved: the baseline", () => {
  it("keeps, per test file that ran, the names of the tests that passed (sorted, duplicates counted)", () => {
    const run = runFiles(report({ "test/b.test.ts": [["z", "pass"], ["a", "pass"], ["a", "pass"], ["later", "todo"], ["off", "skipped"]], "test/empty.test.ts": [] }), none);
    const b = baselineOf(GREEN, run);
    expect(b.sha).toBe(GREEN);
    expect([...b.files]).toEqual([
      ["test/b.test.ts", ["a", "a", "z"]],
      ["test/empty.test.ts", []],
    ]);
  });

  it("keeps only the number of a file's passing tests when their names are too long to keep", () => {
    const many = Array.from({ length: 3_000 }, (_, i): [string, ReportedTest["status"]] => [`case ${i} ${"x".repeat(100)}`, "pass"]);
    expect(JSON.stringify(many.map((m) => m[0])).length).toBeGreaterThan(MAX_KEPT_CHARS);
    expect(baselineOf(GREEN, runFiles(report({ "test/big.test.ts": many }), none)).files.get("test/big.test.ts")).toBe(3_000);
  });
});

describe("what a run lost", () => {
  it("loses a test that passed on certified and is todo, skipped or gone now; a failing one is red already and not lost", () => {
    const b = baseline({ "test/math.test.ts": ["adds", "divides", "multiplies", "subtracts"] });
    const run = runFiles(report({ "test/math.test.ts": [["adds", "pass"], ["subtracts", "todo"], ["divides", "skipped"], ["new one", "pass"]] }), none);
    expect(findLost({ baseline: b, repairs: [], run, listing: everything })).toEqual([
      { file: "test/math.test.ts", name: "divides", scope: "test", why: "skipped now", since: GREEN },
      { file: "test/math.test.ts", name: "multiplies", scope: "test", why: "not defined any more", since: GREEN },
      { file: "test/math.test.ts", name: "subtracts", scope: "test", why: "todo now", since: GREEN },
    ]);
    const failing = runFiles(report({ "test/math.test.ts": [["adds", "pass"], ["subtracts", "fail"], ["divides", "cancelled"], ["multiplies", "pass"]] }), none);
    expect(findLost({ baseline: b, repairs: [], run: failing, listing: everything })).toEqual([]);
  });

  it("counts duplicate names: one of two passing runs of a name turning todo is lost", () => {
    const b = baseline({ "test/a.test.ts": ["works", "works"] });
    const run = runFiles(report({ "test/a.test.ts": [["works", "pass"], ["works", "todo"]] }), none);
    expect(findLost({ baseline: b, repairs: [], run, listing: everything })).toEqual([{ file: "test/a.test.ts", name: "works", scope: "test", why: "todo now", since: GREEN }]);
  });

  it("does not blame subtests a failing parent kept from running, and names a skipped parent", () => {
    const b = baseline({ "test/a.test.ts": ["parent", "parent > child", "suite > inner"] });
    const failed = runFiles(report({ "test/a.test.ts": [["parent", "fail"]] }, { suites: [{ name: "suite", file: "test/a.test.ts", status: "fail", error: "before threw" }] }), none);
    expect(findLost({ baseline: b, repairs: [], run: failed, listing: everything })).toEqual([]);
    const skipped = runFiles(report({ "test/a.test.ts": [["parent", "skipped"], ["suite > inner", "pass"]] }), none);
    expect(findLost({ baseline: b, repairs: [], run: skipped, listing: everything }).map((l) => [l.name, l.why])).toEqual([
      ["parent", "skipped now"],
      ["parent > child", "not run: parent is skipped now"],
    ]);
  });

  it("loses a whole test file that ran on certified and did not run now: left out by the runner, or deleted from trunk", () => {
    const b = baseline({ "test/a.test.ts": ["x"], "test/b.test.ts": ["y"], "test/c.test.ts": [] });
    const run = runFiles(report({ "test/c.test.ts": [] }), {
      unsupported: [{ path: "test/a.test.ts", reason: "imports the package zod (src/util.ts); nothing is installed" }],
      via: new Map([["test/a.test.ts", "src/util.ts"]]),
    });
    expect(findLost({ baseline: b, repairs: [], run, listing: listed("test/a.test.ts", "test/c.test.ts") })).toEqual([
      { file: "test/a.test.ts", scope: "file", why: "did not run: imports the package zod (src/util.ts); nothing is installed", since: GREEN, via: "src/util.ts" },
      { file: "test/b.test.ts", scope: "file", why: "deleted from trunk", since: GREEN, via: null },
    ]);
    // A listing cut short cannot tell a deletion from a file past the cut: still lost, with that reason.
    const cut = findLost({ baseline: b, repairs: [], run, listing: { has: (p) => p === "test/c.test.ts", truncated: true } });
    expect(cut.map((l) => l.why)).toEqual(["did not run: imports the package zod (src/util.ts); nothing is installed", "not in the trunk listing, which was cut short"]);
  });

  it("leaves a file that failed to load or was cut short to its own failure", () => {
    const b = baseline({ "test/a.test.ts": ["x"], "test/b.test.ts": ["y"] });
    const run = runFiles(
      report(
        { "test/a.test.ts": [["test/a.test.ts", "fail", "SyntaxError"]], "test/b.test.ts": [["y", "cancelled", "not run: the certification ran out of time"]] },
        { loadErrors: { "test/a.test.ts": "SyntaxError" } },
      ),
      none,
    );
    expect([...run.broken].sort()).toEqual(["test/a.test.ts", "test/b.test.ts"]);
    expect(findLost({ baseline: b, repairs: [], run, listing: everything })).toEqual([]);
  });

  it("does not take a todo test's error for the run's time running out: the file still owes its tests", () => {
    // A file cut short is red already only when the test that says so fails the run; a todo test's error is the repository's text.
    const b = baseline({ "test/a.test.ts": ["kept", "later"] });
    const run = runFiles(report({ "test/a.test.ts": [["later", "todo", "Error: the certification ran out of time"]] }), none);
    expect([...run.broken]).toEqual([]);
    expect(findLost({ baseline: b, repairs: [], run, listing: everything })).toEqual([
      { file: "test/a.test.ts", name: "kept", scope: "test", why: "not defined any more", since: GREEN },
      { file: "test/a.test.ts", name: "later", scope: "test", why: "todo now", since: GREEN },
    ]);
  });

  it("checks a file whose names were not kept by how many of its tests pass", () => {
    const run = runFiles(report({ "test/big.test.ts": [["a", "pass"], ["b", "todo"]] }), none);
    expect(findLost({ baseline: baseline({ "test/big.test.ts": 2 }), repairs: [], run, listing: everything })).toEqual([
      { file: "test/big.test.ts", scope: "test", count: 1, why: "1 of the 2 tests that passed here no longer pass (their names were too long to keep)", since: GREEN },
    ]);
  });
});

describe("what a repair intent owes", () => {
  it("turns a red result's failing tests into obligations: tests, suites, and whole files for load failures and file hooks", () => {
    expect(
      owedOf([
        { name: "subtracts", file: "test/math.test.ts" },
        { name: "subtracts", file: "test/math.test.ts" },
        { name: "KvStore (suite)", file: "test/kv.test.ts" },
        { name: "(file before hook) (suite)", file: "test/hooks.test.ts" },
        { name: "test/broken.test.ts", file: "test/broken.test.ts" },
      ]),
    ).toEqual([
      { file: "test/math.test.ts", kind: "test", name: "subtracts" },
      { file: "test/kv.test.ts", kind: "suite", name: "KvStore" },
      { file: "test/hooks.test.ts", kind: "file" },
      { file: "test/broken.test.ts", kind: "file" },
    ]);
  });

  it("is met only when each test it was declared for ran and passed: todo, skipped, gone or a file that did not run is lost", () => {
    const repair = (owed: OwedRepair["owed"]): OwedRepair[] => [{ intentId: "int_r", sha: RED, owed }];
    const owed = repair([{ file: "test/math.test.ts", kind: "test", name: "subtracts" }]);
    const todo = runFiles(report({ "test/math.test.ts": [["adds", "pass"], ["subtracts", "todo"]] }), none);
    expect(findLost({ baseline: null, repairs: owed, run: todo, listing: everything })).toEqual([
      { file: "test/math.test.ts", name: "subtracts", scope: "test", why: "todo now", since: RED, repairIntentId: "int_r" },
    ]);
    const gone = runFiles(report({ "test/math.test.ts": [["adds", "pass"]] }), none);
    expect(findLost({ baseline: null, repairs: owed, run: gone, listing: everything })[0]?.why).toBe("not defined any more");
    const passes = runFiles(report({ "test/math.test.ts": [["subtracts", "pass"]] }), none);
    expect(findLost({ baseline: null, repairs: owed, run: passes, listing: everything })).toEqual([]);
    const fails = runFiles(report({ "test/math.test.ts": [["subtracts", "fail"]] }), none);
    expect(findLost({ baseline: null, repairs: owed, run: fails, listing: everything })).toEqual([]);
    const leftOut = runFiles(report({}), { unsupported: [{ path: "test/math.test.ts", reason: "does not import node:test" }], via: new Map([["test/math.test.ts", "test/math.test.ts"]]) });
    expect(findLost({ baseline: null, repairs: owed, run: leftOut, listing: everything })).toEqual([
      { file: "test/math.test.ts", scope: "file", why: "did not run: does not import node:test", since: RED, via: "test/math.test.ts", repairIntentId: "int_r" },
    ]);
  });

  it("holds a suite to every test in it, and a file that failed to load to all of its tests", () => {
    const suite = [{ intentId: "int_s", sha: RED, owed: [{ file: "test/kv.test.ts", kind: "suite" as const, name: "KvStore" }] }];
    const quiet = runFiles(report({ "test/kv.test.ts": [["KvStore > hit", "pass"], ["KvStore > miss", "todo"]] }, { suites: [{ name: "KvStore", file: "test/kv.test.ts", status: "pass" }] }), none);
    expect(findLost({ baseline: null, repairs: suite, run: quiet, listing: everything }).map((l) => [l.name, l.why])).toEqual([["KvStore", "1 of its 2 tests is todo or skipped now"]]);
    const file = [{ intentId: "int_f", sha: RED, owed: [{ file: "test/new.test.ts", kind: "file" as const }] }];
    const loads = runFiles(report({ "test/new.test.ts": [["a", "pass"], ["b", "todo"]] }), none);
    expect(findLost({ baseline: null, repairs: file, run: loads, listing: everything }).map((l) => [l.name, l.why])).toEqual([[undefined, "1 of its 2 tests is todo or skipped now"]]);
    // A file a green run included: the baseline owes its tests by name, so loading again is enough here.
    expect(findLost({ baseline: baseline({ "test/new.test.ts": ["a"] }), repairs: file, run: loads, listing: everything })).toEqual([]);
  });

  it("names each loss once, as the baseline's when the baseline owes it too", () => {
    const b = baseline({ "test/math.test.ts": ["subtracts"] });
    const repairs = [{ intentId: "int_r", sha: RED, owed: [{ file: "test/math.test.ts", kind: "test" as const, name: "subtracts" }] }];
    const run = runFiles(report({ "test/math.test.ts": [["subtracts", "todo"]] }), none);
    expect(findLost({ baseline: b, repairs, run, listing: everything })).toEqual([{ file: "test/math.test.ts", name: "subtracts", scope: "test", why: "todo now", since: GREEN }]);
  });
});

describe("a person accepting a loss", () => {
  it("drops what was accepted from the baseline and from every repair's obligations", () => {
    const b = baseline({ "test/a.test.ts": ["x", "x", "y"], "test/b.test.ts": ["z"], "test/big.test.ts": 10 });
    expect(acceptInBaseline(b, [{ file: "test/a.test.ts", name: "x", scope: "test" }, { file: "test/b.test.ts", scope: "file" }, { file: "test/big.test.ts", scope: "test", count: 3 }])).toBe(true);
    expect([...b.files]).toEqual([
      ["test/a.test.ts", ["x", "y"]],
      ["test/big.test.ts", 7],
    ]);
    expect(acceptInBaseline(b, [{ file: "test/other.test.ts", scope: "file" }])).toBe(false);
    const owed = [
      { file: "test/a.test.ts", kind: "test" as const, name: "x" },
      { file: "test/a.test.ts", kind: "test" as const, name: "y" },
      { file: "test/b.test.ts", kind: "suite" as const, name: "S" },
    ];
    expect(acceptInOwed(owed, [{ file: "test/a.test.ts", name: "x", scope: "test" }, { file: "test/b.test.ts", scope: "file" }])).toEqual([{ file: "test/a.test.ts", kind: "test", name: "y" }]);
  });
});

describe("how a loss reads", () => {
  it("lists a lost test in failing with the reason, and gives a plain detail", () => {
    const test = { file: "test/math.test.ts", name: "subtracts", scope: "test" as const, why: "todo now", since: GREEN };
    const file = { file: "test/b.test.ts", scope: "file" as const, why: "deleted from trunk", since: GREEN, via: null };
    const owed = { file: "test/c.test.ts", name: "c", scope: "test" as const, why: "skipped now", since: RED, repairIntentId: "int_r" };
    expect(lostAsFailing(test)).toEqual({ name: "subtracts", file: "test/math.test.ts", error: "lost: todo now (it passed on certified 1111111)" });
    expect(lostAsFailing(file)).toEqual({ name: "test/b.test.ts", file: "test/b.test.ts", error: "lost: deleted from trunk (it ran on certified 1111111)" });
    expect(lostAsFailing(owed).error).toBe("lost: skipped now (repair int_r was declared for it on trunk 2222222)");
    expect(lostDetail([test, file], false)).toBe(
      "Every test that ran passed, but 1 test and 1 test file that passed on certified 1111111 did not run: test/math.test.ts > subtracts (todo now), test/b.test.ts (deleted from trunk)",
    );
    expect(lostDetail([owed], true)).toBe("Not certified: 1 test repair int_r was declared for did not run: test/c.test.ts > c (skipped now)");
    const many = Array.from({ length: 7 }, (_, i) => ({ ...test, name: `t${i}` }));
    expect(lostDetail(many, false)).toMatch(/and 3 more$/);
  });
});
