import { describe, expect, it } from "vitest";
import { splitReport } from "../../src/certify/cache.ts";
import { baselineOf, runFiles } from "../../src/certify/owed.ts";
import { RUNNER_FAILED, buildPlan } from "../../src/certify/plan.ts";
import { summarize } from "../../src/certify/report.ts";
import { nodeStripsTypes, nodeTestCounts, planOf, runPlanInNode, trunkOf } from "./harness.ts";

/**
 * The runner end to end: fixture projects are loaded, transpiled and planned exactly as a
 * certification run does, the plan runs in a real Node process, and the counts are compared with
 * `node --test` on the same files (and with the numbers Node 24 prints for them).
 */

// The node:test semantics the shim supports, one file per area (written as TypeScript Node can strip).
const SEMANTICS: Record<string, string> = {
  "test/basics.test.ts": `import { test, describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
test("plain pass", () => {});
test("plain fail", () => { assert.equal(1, 2); });
test("parent", async (t) => {
  await t.test("child ok", () => {});
  await t.test("child fail", () => { throw new Error("boom"); });
});
test("skip opt", { skip: true }, () => {});
test.skip("skip fn", () => {});
test.todo("todo fn", () => { throw new Error("x"); });
test("todo opt fail", { todo: "later" }, () => { throw new Error("x"); });
describe("suite", () => {
  before(() => {});
  beforeEach(() => {});
  it("a", () => {});
  it("b", () => { assert.ok(false); });
  describe("inner", () => { it("c", () => {}); });
});
describe("suite with failing before", () => {
  before(() => { throw new Error("before failed"); });
  it("x", () => {});
  it("y", () => {});
});
test("t.skip inside", (t) => { t.skip("nah"); });
test("done cb", (t, done) => { setTimeout(done, 5); });
test("not awaited subtest", (t) => { t.test("late child", () => {}); });
`,
  "test/hooks.test.ts": `import { test, describe, it, beforeEach, afterEach, after } from "node:test";
describe("each fails", () => {
  beforeEach(() => { throw new Error("be"); });
  it("p", () => {});
  it("q", () => {});
});
describe("aftereach fails", () => {
  afterEach(() => { throw new Error("ae"); });
  it("r", () => {});
});
describe("after fails", () => {
  after(() => { throw new Error("af"); });
  it("s", () => {});
});
test("timeout", { timeout: 50 }, async () => { await new Promise((r) => setTimeout(r, 400)); });
test("returns promise rejecting", () => Promise.reject(new Error("rej")));
test("only opt", { only: true }, () => {});
test(function namedFn() {});
test("concurrency opt", { concurrency: true }, async (t) => { t.diagnostic("hi"); await t.test("sub"); });
`,
  "test/edges.test.ts": `import { test, describe, it } from "node:test";
describe("throws in body", () => { it("registered first", () => {}); throw new Error("body boom"); });
describe("async body rejects", async () => { it("r1", () => {}); await null; throw new Error("async boom"); });
describe.skip("skipped suite", () => { it("s1", () => {}); it("s2", () => {}); });
describe("todo suite", { todo: true }, () => { it("t1", () => { throw new Error("x"); }); });
test("hook in test", async (t) => {
  t.beforeEach(() => {});
  t.after(() => {});
  await t.test("c1", () => {});
});
test("plan", (t) => { t.plan(2); t.assert.ok(true); });
test("global it inside test", async () => { await it("nested via global", () => {}); });
test("throws non-error", () => { throw "str"; });
test("sync after async subtest fail", async (t) => { t.test("x", async () => { await null; throw new Error("late"); }); });
`,
  "test/top-throw.test.ts": `import { test } from "node:test";
test("registered before throw", () => {});
throw new Error("top level boom");
`,
  "test/missing-import.test.ts": `import { test } from "node:test";
import { nope } from "./missing.ts";
test("never", () => { nope(); });
`,
  "test/syntax.test.ts": `import { test } from "node:test";
test("x", () => {
`,
};

// A small project: a bug, a type-only module, module state per file, and files the runner leaves out.
const PROJECT: Record<string, string> = {
  "src/types.ts": "export interface Link { slug: string; clicks: number }\nexport type Store = { get(slug: string): Link | null };\n",
  "src/counter.ts": "let n = 0;\nexport function inc(): number {\n  n += 1;\n  return n;\n}\n",
  "src/math.ts":
    'import type { Link } from "./types.ts";\nexport function add(a: number, b: number): number {\n  return a + b;\n}\nexport function sub(a: number, b: number): number {\n  return a + b;\n}\nexport function clicks(l: Link): number {\n  return l.clicks;\n}\n',
  "src/unused.ts": "export const unused = 1;\n",
  "src/data.json": '{ "answer": 42 }\n',
  "test/math.test.ts":
    'import { describe, it } from "node:test";\nimport assert from "node:assert/strict";\nimport { add, sub, clicks } from "../src/math.ts";\nimport type { Link } from "../src/types.ts";\ndescribe("math", () => {\n  it("adds", () => assert.equal(add(2, 3), 5));\n  it("subtracts", () => assert.equal(sub(5, 3), 2));\n  it("reads clicks", () => {\n    const l: Link = { slug: "a", clicks: 2 };\n    assert.equal(clicks(l), 2);\n  });\n});\n',
  "test/state-a.test.ts": 'import { test } from "node:test";\nimport { strict as assert } from "node:assert";\nimport { inc } from "../src/counter.ts";\ntest("fresh module state (a)", () => {\n  assert.equal(inc(), 1);\n});\n',
  "test/state-b.test.ts": 'import { test } from "node:test";\nimport { strict as assert } from "node:assert";\nimport { inc } from "../src/counter.ts";\ntest("fresh module state (b)", () => {\n  assert.equal(inc(), 1);\n});\n',
  "test/missing.test.ts": 'import { test } from "node:test";\nimport { nope } from "../src/nope.ts";\ntest("never runs", () => {\n  nope();\n});\n',
  "test/enum.test.ts": 'import { test } from "node:test";\nenum Color {\n  Red,\n}\ntest("enum", () => {\n  void Color.Red;\n});\n',
  "test/value-type.test.ts": 'import { test } from "node:test";\nimport { Link } from "../src/types.ts";\ntest("imports a type as a value", () => {\n  void Link;\n});\n',
  "test/pkg.test.ts": 'import { test } from "node:test";\nimport pad from "some-pad";\ntest("pads", () => {\n  pad("a", 2);\n});\n',
  "test/foreign.test.ts": 'import { describe, it } from "some-runner";\ndescribe("x", () => {\n  it("y", () => {});\n});\n',
  "lib/util.test.js": 'import test from "node:test";\nimport assert from "node:assert";\ntest("js test", () => {\n  assert.strictEqual(typeof test.describe, "function");\n});\n',
};

const counts = (c: { tests: number; pass: number; fail: number; cancelled: number; skipped: number; todo: number; suites: number }) => ({
  tests: c.tests,
  pass: c.pass,
  fail: c.fail,
  cancelled: c.cancelled,
  skipped: c.skipped,
  todo: c.todo,
  suites: c.suites,
});

describe("certification runner (Node process, compared with node --test)", () => {
  it("counts node:test semantics exactly as node --test does", async () => {
    const { loaded, plan } = await planOf(SEMANTICS);
    expect(loaded.unsupported).toEqual([]);
    expect(loaded.tests).toEqual(Object.keys(SEMANTICS).sort());
    const report = runPlanInNode(plan);
    const s = summarize(report);
    // What Node 24 prints for these files (checked by hand against node --test).
    expect(counts(s.counts)).toEqual({ tests: 42, pass: 16, fail: 15, cancelled: 5, skipped: 3, todo: 3, suites: 10 });
    expect(s.status).toBe("red");
    if (nodeStripsTypes()) expect(counts(s.counts)).toEqual(counts(nodeTestCounts(SEMANTICS, loaded.tests)));
    const names = s.failing.map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(["plain fail", "parent", "parent > child fail", "suite > b", "suite with failing before > x", "test/top-throw.test.ts", "test/syntax.test.ts"]));
    const fail = s.failing.find((f) => f.name === "plain fail");
    expect(fail?.error).toMatch(/^AssertionError \(strictEqual\): actual 1, expected 2 \(at test\/basics\.test\.ts:4\)$/);
    expect(s.failing.find((f) => f.name === "test/missing-import.test.ts")?.error).toMatch(/missing\.ts/);
    expect(s.failing.find((f) => f.name === "timeout")?.error).toMatch(/cancelled: Error: test timed out after 50ms/);
  }, 60_000);

  it("runs a project's own tests: exact imports, erased types, module state per file, files it cannot run left out", async () => {
    const { loaded, plan } = await planOf(PROJECT);
    expect(loaded.unsupported).toEqual([
      { path: "test/foreign.test.ts", reason: "does not import node:test" },
      { path: "test/pkg.test.ts", reason: "imports the package some-pad (test/pkg.test.ts); nothing is installed" },
    ]);
    expect([...loaded.via]).toEqual([
      ["test/foreign.test.ts", "test/foreign.test.ts"],
      ["test/pkg.test.ts", "test/pkg.test.ts"],
    ]);
    expect(loaded.tests).toEqual(["lib/util.test.js", "test/enum.test.ts", "test/math.test.ts", "test/missing.test.ts", "test/state-a.test.ts", "test/state-b.test.ts", "test/value-type.test.ts"]);
    // Only what the tests reach is read.
    expect(loaded.modules.has("src/unused.ts")).toBe(false);
    expect(loaded.modules.has("src/data.json")).toBe(false);
    const s = summarize(runPlanInNode(plan));
    expect(counts(s.counts)).toEqual({ tests: 9, pass: 5, fail: 4, cancelled: 0, skipped: 0, todo: 0, suites: 1 });
    expect(s.failing.map((f) => f.name).sort()).toEqual(["math > subtracts", "test/enum.test.ts", "test/missing.test.ts", "test/value-type.test.ts"]);
    expect(s.failing.find((f) => f.name === "test/enum.test.ts")?.error).toMatch(/type stripping cannot run: line 2 declares an enum/);
    expect(s.failing.find((f) => f.name === "test/value-type.test.ts")?.error).toMatch(/Link/);
    if (nodeStripsTypes()) expect(counts(s.counts)).toEqual(counts(nodeTestCounts(PROJECT, loaded.tests)));
  }, 60_000);

  it("gives each test file its own module instances (shared modules would leak state)", async () => {
    const t = trunkOf(PROJECT);
    const { load } = await import("../../src/certify/load.ts");
    const loaded = await load(t.index, t.read);
    const tests = ["test/state-a.test.ts", "test/state-b.test.ts"];
    const config = { testTimeoutMs: 2_000, budgetMs: 20_000 };
    const isolated = summarize(runPlanInNode(buildPlan({ tests, modules: loaded.modules, config })));
    const shared = summarize(runPlanInNode(buildPlan({ tests, modules: loaded.modules, config, isolate: false })));
    expect(isolated.counts.pass).toBe(2);
    expect(shared.counts.fail).toBe(1);
  }, 60_000);

  it("stops at the run's budget and reports what did not run as cancelled", async () => {
    const files = {
      "test/a-slow.test.ts": 'import { test } from "node:test";\ntest("slow", async () => { await new Promise((r) => setTimeout(r, 5_000)); });\n',
      "test/b-later.test.ts": 'import { test } from "node:test";\ntest("never reached", () => {});\n',
    };
    const { plan } = await planOf(files, { testTimeoutMs: 10_000, budgetMs: 600 });
    const s = summarize(runPlanInNode(plan));
    expect(s.status).toBe("red");
    expect(counts(s.counts)).toEqual({ tests: 2, pass: 0, fail: 0, cancelled: 2, skipped: 0, todo: 0, suites: 0 });
    expect(s.failing.map((f) => [f.name, f.error])).toEqual([
      ["slow", "cancelled: Error: the certification ran out of time while this test ran"],
      ["test/b-later.test.ts", "cancelled: not run: the certification ran out of time"],
    ]);
  }, 60_000);

  it("never lets a test file that breaks the runner drop a later file from a green run", async () => {
    // node --test gives each file a process; here the files share one isolate, so a file that
    // replaces a global the runner needs (the node:test shim calls Object.assign as it loads) keeps
    // the next file's runner from starting. That file did not run: it fails the run.
    const files = {
      "test/a-breaks.test.ts": 'import { test } from "node:test";\ntest("passes", () => {});\nObject.assign = () => {\n  throw new Error("assign is gone");\n};\n',
      "test/b-later.test.ts": 'import { test } from "node:test";\ntest("would pass", () => {});\n',
    };
    const { loaded, plan } = await planOf(files);
    const report = runPlanInNode(plan);
    // The harness itself reports the file as one failing test.
    const error = `${RUNNER_FAILED}assign is gone`;
    expect(report.files[1]).toEqual({ path: "test/b-later.test.ts", ms: 0, tests: 1, loadError: error });
    expect(report.tests.filter((t) => t.file === "test/b-later.test.ts")).toEqual([{ name: "test/b-later.test.ts", file: "test/b-later.test.ts", status: "fail", error }]);
    const s = summarize(report);
    expect(s.status).toBe("red");
    expect(counts(s.counts)).toEqual({ tests: 2, pass: 1, fail: 1, cancelled: 0, skipped: 0, todo: 0, suites: 0 });
    expect(s.failing).toEqual([{ name: "test/b-later.test.ts", file: "test/b-later.test.ts", error }]);
    // Its result depended on the file before it: never kept for reuse, and never counted as having run.
    expect([...splitReport(report, loaded.tests).keys()]).toEqual(["test/a-breaks.test.ts"]);
    const run = runFiles(report, loaded);
    expect([...run.broken]).toEqual(["test/b-later.test.ts"]);
    expect([...run.ran.keys()]).toEqual(["test/a-breaks.test.ts"]);
  }, 60_000);

  it("holds a file to what it owes when a todo test's error claims the run ran out of time", async () => {
    // The error of a todo test is the repository's text: it must not mark the file as cut short.
    const files = {
      "test/a.test.ts": 'import { test } from "node:test";\ntest("kept", () => {});\ntest("later", { todo: true }, () => {\n  throw new Error("the certification ran out of time");\n});\n',
    };
    const { loaded, plan } = await planOf(files);
    const report = runPlanInNode(plan);
    expect(summarize(report).status).toBe("green");
    expect(report.tests.find((t) => t.name === "later")).toMatchObject({ status: "todo", error: expect.stringMatching(/ran out of time/) });
    const run = runFiles(report, loaded);
    expect([...run.broken]).toEqual([]);
    expect([...baselineOf("a".repeat(40), run).files]).toEqual([["test/a.test.ts", ["kept"]]]);
  }, 60_000);
});
