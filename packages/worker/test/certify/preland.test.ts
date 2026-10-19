import { describe, expect, it } from "vitest";
import type { Certification, Id, Path, Proposal, Sha } from "@fire_trident/core";
import type { FileResult } from "../../src/certify/cache.ts";
import { Certifier, type CertifyHost, type CertifyTrunk } from "../../src/certify/certifier.ts";
import type { Plan } from "../../src/certify/plan.ts";
import {
  PRELAND_CHECK,
  PRELAND_FILES,
  deletedPassing,
  deletionAsked,
  judgeRun,
  namesFile,
  ownTests,
  prelandCheck,
  prelandGlobs,
  prelandMatches,
  prelandReason,
  reachingTests,
  type PrelandReader,
} from "../../src/certify/preland.ts";
import { DEFAULT_POLICY, mergePolicy } from "../../src/certify/repair.ts";
import type { RunReport } from "../../src/certify/report.ts";
import { planOf, runPlanInNode } from "./harness.ts";

/**
 * Tests before landing (FT_PRELAND) in Node: the pure parts (which changes and which test files, how a run is judged),
 * then the certifier's precheck end to end, running each plan with the real harness and node:test shim in a Node
 * process, against the results certification stored for trunk.
 */

/** The part of node:sqlite these tests use (the worker compiles against workers types, not Node's). */
interface DatabaseSync {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
}
const SQLITE = "node:sqlite";
const { DatabaseSync } = (await import(SQLITE)) as { DatabaseSync: new (path: string) => DatabaseSync };

function sqlStorage(): SqlStorage {
  const db = new DatabaseSync(":memory:");
  return {
    exec(query: string, ...bindings: unknown[]) {
      const rows = db.prepare(query).all(...bindings);
      return { toArray: () => rows, one: () => rows[0], [Symbol.iterator]: () => rows[Symbol.iterator]() };
    },
  } as unknown as SqlStorage;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A blob id that follows the content (FNV-1a and the length). */
function blobOf(text: string): Sha {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return `${h.toString(16).padStart(8, "0")}${text.length.toString(16)}`;
}

/** A trunk of file texts, one commit per change, with every commit's files kept (baseBlobs reads older ones). */
class Trunk implements CertifyTrunk {
  sha: Sha = "";
  readonly files = new Map<Path, string>();
  private readonly blobs = new Map<Sha, string>();
  private readonly history = new Map<Sha, Map<Path, Sha>>();
  private n = 0;

  commit(changes: Record<Path, string | null>): Sha {
    for (const [path, text] of Object.entries(changes)) {
      if (text === null) this.files.delete(path);
      else {
        this.files.set(path, text);
        this.blobs.set(blobOf(text), text);
      }
    }
    this.sha = (++this.n).toString(16).padStart(40, "0");
    this.history.set(this.sha, new Map([...this.files].map(([path, text]) => [path, blobOf(text)])));
    return this.sha;
  }

  async baseBlobs(sha: Sha, paths: Path[]): Promise<Array<{ path: Path; blob: Sha | null }>> {
    const at = this.history.get(sha);
    return paths.map((path) => ({ path, blob: at?.get(path) ?? null }));
  }

  async certifySnapshot(): Promise<{ trunkSha: Sha; landingId: Id | null; files: Array<{ path: Path; blob: Sha; size: number }>; truncated: boolean }> {
    const files = [...this.files].filter(([path]) => /\.(ts|js|mjs|json)$/.test(path)).map(([path, text]) => ({ path, blob: blobOf(text), size: text.length }));
    return { trunkSha: this.sha, landingId: null, files, truncated: false };
  }

  async readBlobs(blobs: Sha[]): Promise<Record<Sha, string | null>> {
    return Object.fromEntries(blobs.map((b) => [b, this.blobs.get(b) ?? null]));
  }

  async annotate(): Promise<boolean> {
    return true;
  }

  async markCertified(): Promise<boolean> {
    return true;
  }
}

/** How the stand-in Worker Loader answers: by running the plan in Node, never, with an error, or once released. */
type Mode = { kind: "node" } | { kind: "hang" } | { kind: "fail" } | { kind: "held"; waiting: Array<() => void> };

/** A Worker Loader stand-in whose answer `mode` decides; `loads` counts the plans it was given. */
function loader(mode: { current: Mode }): WorkerLoader & { loads: Plan[] } {
  const loads: Plan[] = [];
  const load = (code: WorkerLoaderWorkerCode): WorkerStub => {
    const plan = { mainModule: code.mainModule, modules: code.modules } as unknown as Plan;
    loads.push(plan);
    const answer = (): Response => new Response(JSON.stringify(runPlanInNode(plan)));
    const m = mode.current;
    const entrypoint = {
      fetch: async (): Promise<Response> => {
        if (m.kind === "hang") return new Promise<Response>(() => undefined);
        if (m.kind === "fail") throw new Error("the Worker Loader is unavailable");
        if (m.kind === "held") await new Promise<void>((go) => m.waiting.push(go));
        return answer();
      },
    };
    return { getEntrypoint: () => entrypoint } as unknown as WorkerStub;
  };
  return { loads, load } as unknown as WorkerLoader & { loads: Plan[] };
}

/** A certifier over `trunk` with tests before landing on (unless `preland` is false) and runs at once. */
function setup(trunk: Trunk, opts: { preland?: boolean; policy?: Record<string, unknown> } = {}) {
  const mode: { current: Mode } = { current: { kind: "node" } };
  const runner = loader(mode);
  let green: Sha | null = null;
  const host: CertifyHost = {
    sql: sqlStorage(),
    enabled: () => true,
    loader: () => runner,
    trunk: () => trunk,
    publish: () => undefined,
    exists: () => true,
    greenSha: () => green,
    setGreen: (sha) => {
      green = sha;
    },
    repairs: () => [],
    declare: async () => "int_repair",
    satisfy: async () => undefined,
    specFor: () => null,
    ...(opts.preland === false ? {} : { preland: () => true }),
  };
  const certifier = new Certifier(host);
  const set = certifier.setPolicy({ minIntervalMs: 0, repair: false, ...(opts.policy ?? {}) });
  if ("error" in set) throw new Error(set.error);
  return { certifier, mode, runner };
}

/** Report the head as landed and wait for its certification. */
async function certify(c: Certifier, trunk: Trunk): Promise<Certification> {
  c.landed({ trunkSha: trunk.sha, at: Date.now(), paths: [...trunk.files.keys()] });
  const until = Date.now() + 30_000;
  for (;;) {
    const found = c.get(trunk.sha);
    const state = c.state();
    if (found && found.status !== "running" && !state.running && !state.pending) return found;
    if (Date.now() > until) throw new Error(`no certification of ${trunk.sha} yet`);
    await sleep(20);
  }
}

let seq = 0;

/** A change on `base` writing `files` (null deletes), and the reader of its texts. */
function change(base: Sha, files: Record<Path, string | null>): { p: Proposal; read: PrelandReader } {
  const texts = new Map<Sha, string>();
  const writeSet = Object.entries(files).map(([path, text]) => {
    if (text === null) return { path, blob: null };
    const blob = blobOf(text);
    texts.set(blob, text);
    return { path, blob };
  });
  const p: Proposal = {
    id: `prp_${++seq}`,
    colonyId: "c",
    intentId: `int_${seq}`,
    agentId: "agt_1",
    workspace: { namespace: "ft-ws-0", name: "c--ws-1", remote: "" },
    baseSha: base,
    headSha: `${seq}`.padStart(40, "f"),
    writeSet,
    readSet: [],
    declared: { footprint: Object.keys(files), summary: "change" },
    evidence: { checks: [] },
    status: "checking",
    createdAt: Date.now(),
  };
  return { p, read: async (blobs) => new Map(blobs.map((b) => [b, texts.get(b) ?? null])) };
}

const MATH_OK = "export function sub(a: number, b: number): number {\n  return a - b;\n}\n";
const MATH_BUG = "export function sub(a: number, b: number): number {\n  return a + b;\n}\n";
const MATH_TEST = 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { sub } from "../src/math.ts";\ntest("subtracts", () => {\n  assert.equal(sub(5, 3), 2);\n});\n';
/** A file with one test that passes with sub() as it is and one that never does. */
const KNOWN_TEST = 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { sub } from "../src/math.ts";\ntest("subtracts", () => {\n  assert.equal(sub(5, 3), 2);\n});\ntest("known bug", () => {\n  assert.equal(sub(1, 1), 1);\n});\n';
const OTHER_TEST = 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { name } from "../src/other.ts";\ntest("names", () => {\n  assert.equal(typeof name, "string");\n});\n';

describe("which changes tests before landing cover (prelandPaths)", () => {
  it("covers every change when no globs are set, else the changes that write a path under one", () => {
    expect(prelandMatches(undefined, ["README.md"])).toBe(true);
    expect(prelandMatches([], ["src/a.ts"])).toBe(true);
    expect(prelandMatches(["src/api"], ["src/api/links.ts"])).toBe(true);
    expect(prelandMatches(["src/**/*.ts"], ["docs/a.md", "src/x/y.ts"])).toBe(true);
    expect(prelandMatches(["src/api"], ["src/apis.ts", "test/api.test.ts"])).toBe(false);
    expect(prelandMatches(undefined, [])).toBe(false);
  });

  it("keeps globs trimmed and each once, and refuses what is not a list of globs, in a sentence", () => {
    expect(prelandGlobs([" ./src/api/ ", "src/api", "lib/**"])).toEqual(["src/api", "lib/**"]);
    expect(prelandGlobs([])).toEqual([]);
    expect(prelandGlobs("src")).toBe("prelandPaths must be a list of globs");
    expect(prelandGlobs([3])).toMatch(/must be a glob/);
    expect(prelandGlobs([" / "])).toMatch(/cannot be empty/);
    expect(prelandGlobs(Array.from({ length: 51 }, (_, i) => `d${i}`))).toMatch(/at most 50 globs/);
  });

  it("is part of the certify policy: set, cleared by an empty list, refused with the reason, absent by default", () => {
    expect(DEFAULT_POLICY.prelandPaths).toBeUndefined();
    const set = mergePolicy(DEFAULT_POLICY, { prelandPaths: ["src/api/", "src/api"] });
    expect(set).toEqual({ policy: { ...DEFAULT_POLICY, prelandPaths: ["src/api"] } });
    const cleared = mergePolicy((set as { policy: typeof DEFAULT_POLICY }).policy, { prelandPaths: [] });
    expect(cleared).toEqual({ policy: DEFAULT_POLICY });
    expect(mergePolicy(DEFAULT_POLICY, { prelandPaths: "src" })).toEqual({ error: "prelandPaths must be a list of globs" });
    // The other fields behave as before.
    expect(mergePolicy(DEFAULT_POLICY, { enabled: false })).toEqual({ policy: { ...DEFAULT_POLICY, enabled: false } });
  });
});

describe("choosing the test files a change reaches", () => {
  it("takes the test files whose closure holds a written, added or deleted path, nearest first", async () => {
    const files = {
      "src/shared.ts": "export const one = 1;\n",
      "src/mid.ts": 'import { one } from "./shared.ts";\nexport const two = one + 1;\n',
      "src/other.ts": 'export const name = "a";\n',
      "test/b.test.ts": 'import { test } from "node:test";\nimport { two } from "../src/mid.ts";\ntest("two", () => {});\n',
      "test/a.test.ts": 'import { test } from "node:test";\nimport { one } from "../src/shared.ts";\ntest("one", () => {});\n',
      "test/other.test.ts": OTHER_TEST,
    };
    const base = (await planOf(files)).loaded;
    // A change to shared.ts reaches a.test.ts directly and b.test.ts through mid.ts; other.test.ts not at all.
    expect(reachingTests(base, base, new Set(["src/shared.ts"]))).toEqual(["test/a.test.ts", "test/b.test.ts"]);
    // A deleted file is reached through the closures on trunk.
    const { "src/shared.ts": _gone, ...without } = files;
    const after = (await planOf(without)).loaded;
    expect(reachingTests(base, after, new Set(["src/shared.ts"]))).toEqual(["test/a.test.ts", "test/b.test.ts"]);
    // A test file the change edits reaches itself first.
    expect(reachingTests(base, base, new Set(["test/b.test.ts", "src/shared.ts"]))).toEqual(["test/b.test.ts", "test/a.test.ts"]);
    // A new test file is not on trunk: it has nothing to be compared with.
    const added = (await planOf({ ...files, "test/new.test.ts": 'import { test } from "node:test";\nimport { one } from "../src/shared.ts";\ntest("new", () => {});\n' })).loaded;
    expect(reachingTests(base, added, new Set(["src/shared.ts", "test/new.test.ts"]))).toEqual(["test/a.test.ts", "test/b.test.ts"]);
  });
});

describe("judging a run with the change against trunk", () => {
  const trunkResult = (path: Path, tests: Array<[string, "pass" | "fail"]>, loadError: string | null = null): FileResult => ({
    path,
    loadError,
    tests: tests.map(([name, status]) => ({ name, file: path, status })),
    suites: [],
  });
  const report = (files: RunReport["files"], tests: RunReport["tests"]): RunReport => ({ runner: "r", files, tests, suites: [], ms: 1 });

  it("holds only tests that passed on trunk; failing ones that did not pass there are known", () => {
    const trunk = new Map([["t/a.test.ts", trunkResult("t/a.test.ts", [["passes", "pass"], ["was red", "fail"]])]]);
    const j = judgeRun(
      report(
        [{ path: "t/a.test.ts", ms: 1, tests: 4, loadError: null }],
        [
          { name: "passes", file: "t/a.test.ts", status: "fail", error: "Expected 2, got 8" },
          { name: "was red", file: "t/a.test.ts", status: "fail", error: "still red" },
          { name: "new", file: "t/a.test.ts", status: "cancelled", error: "new and failing" },
          { name: "skipped", file: "t/a.test.ts", status: "skipped" },
        ],
      ),
      ["t/a.test.ts"],
      trunk,
    );
    expect(j).toEqual({ tests: 4, passed: 0, failed: 3, known: 2, broke: [{ file: "t/a.test.ts", name: "passes", error: "Expected 2, got 8" }], unjudged: [] });
  });

  it("holds a file that loaded on trunk and no longer loads; leaves a file whose result depended on the run unjudged", () => {
    const trunk = new Map([
      ["t/a.test.ts", trunkResult("t/a.test.ts", [["one", "pass"]])],
      ["t/b.test.ts", trunkResult("t/b.test.ts", [["two", "pass"]])],
      ["t/c.test.ts", trunkResult("t/c.test.ts", [], "SyntaxError: broken on trunk")],
    ]);
    const j = judgeRun(
      report(
        [
          { path: "t/a.test.ts", ms: 1, tests: 0, loadError: "Cannot find module '../src/gone.ts'" },
          { path: "t/b.test.ts", ms: 1, tests: 1, loadError: null },
          { path: "t/c.test.ts", ms: 1, tests: 0, loadError: "SyntaxError: still broken" },
        ],
        [{ name: "two", file: "t/b.test.ts", status: "cancelled", error: "the certification ran out of time while this test ran" }],
      ),
      ["t/a.test.ts", "t/b.test.ts", "t/c.test.ts", "t/missing.test.ts"],
      trunk,
    );
    expect(j.broke).toEqual([{ file: "t/a.test.ts", name: "t/a.test.ts", error: "Cannot find module '../src/gone.ts'" }]);
    expect(j.unjudged).toEqual(["t/b.test.ts", "t/missing.test.ts"]);
    expect(j).toMatchObject({ tests: 2, failed: 2, known: 1 });
  });

  it("says what broke and what to do next, in a sentence", () => {
    expect(prelandReason([{ file: "test/math.test.ts", name: "subtracts", error: "Expected values to be strictly equal:\n\n8 !== 2\n" }])).toBe(
      'Tests before landing: the test "subtracts" in test/math.test.ts passed on trunk and fails with this change: Expected values to be strictly equal: 8 !== 2. Fix the change so it passes again (the test is the specification), then propose again.',
    );
    const many = prelandReason([
      { file: "t/a.test.ts", name: "a" },
      { file: "t/b.test.ts", name: "t/b.test.ts", error: "SyntaxError" },
      { file: "t/c.test.ts", name: "c" },
      { file: "t/d.test.ts", name: "d" },
    ]);
    expect(many).toBe(
      'Tests before landing: 4 tests that passed on trunk fail with this change: the test "a" in t/a.test.ts; the test file t/b.test.ts (it loaded on trunk and fails to load): SyntaxError; the test "c" in t/c.test.ts; and 1 more. Fix the change so they pass again (the tests are the specification), then propose again.',
    );
    expect(prelandCheck({ status: "unchecked", files: [], tests: 0, passed: 0, failed: 0, ms: 3, reason: "busy" })).toEqual({ name: PRELAND_CHECK, ok: true, ms: 3, detail: "not checked: busy" });
  });
});

describe("the certifier's precheck (tests before landing)", () => {
  it("sends back a change that breaks a test that passed on trunk, naming it, and passes the fixed one", async () => {
    const trunk = new Trunk();
    const head = trunk.commit({ "src/math.ts": MATH_OK, "test/math.test.ts": MATH_TEST, "src/other.ts": 'export const name = "a";\n', "test/other.test.ts": OTHER_TEST });
    const { certifier, runner } = setup(trunk);
    expect((await certify(certifier, trunk)).status).toBe("green");
    const loads = runner.loads.length;

    const bad = change(head, { "src/math.ts": MATH_BUG });
    const failed = await certifier.precheck(bad.p, bad.read);
    expect(failed?.run).toMatchObject({ status: "failed", trunkSha: head, files: ["test/math.test.ts"], tests: 1, passed: 0, failed: 1 });
    expect(failed?.run.broke).toEqual([{ file: "test/math.test.ts", name: "subtracts", error: "AssertionError (strictEqual): actual 8, expected 2 (at test/math.test.ts:5)" }]);
    expect(failed?.reason).toMatch(/^Tests before landing: the test "subtracts" in test\/math\.test\.ts passed on trunk and fails with this change: AssertionError \(strictEqual\): actual 8, expected 2 \(at test\/math\.test\.ts:5\)\. Fix the change/);
    expect(failed?.check).toMatchObject({ name: PRELAND_CHECK, ok: false });
    // Only the test file the change reaches ran.
    expect(runner.loads.length).toBe(loads + 1);
    expect(JSON.stringify(runner.loads.at(-1)!.modules)).not.toContain("other.test.ts");

    const fixed = change(head, { "src/math.ts": `${MATH_OK}export const twice = (a: number): number => a * 2;\n` });
    const passed = await certifier.precheck(fixed.p, fixed.read);
    expect(passed?.run).toMatchObject({ status: "passed", files: ["test/math.test.ts"], tests: 1, passed: 1, failed: 0 });
    expect(passed?.check).toMatchObject({ name: PRELAND_CHECK, ok: true, detail: "1 test file that reach the change ran on its base with it: 1 of 1 test passed" });
    expect(passed?.reason).toBeUndefined();
  });

  it("does not hold a test that already failed on trunk against the change", async () => {
    const trunk = new Trunk();
    const head = trunk.commit({ "src/math.ts": MATH_OK, "test/math.test.ts": KNOWN_TEST });
    const { certifier } = setup(trunk);
    expect((await certify(certifier, trunk)).status).toBe("red");
    const edit = change(head, { "src/math.ts": `// Subtraction.\n${MATH_OK}` });
    const out = await certifier.precheck(edit.p, edit.read);
    expect(out?.run).toMatchObject({ status: "passed", tests: 2, passed: 1, failed: 1, known: 1 });
    expect(out?.check.detail).toContain("1 failing test did not pass on trunk either, so not held against it");
    // Breaking the passing one is held; the known one is still not.
    const bad = change(head, { "src/math.ts": MATH_BUG });
    expect((await certifier.precheck(bad.p, bad.read))?.run).toMatchObject({ status: "failed", known: 1, broke: [{ name: "subtracts" }] });
  });

  it("runs at most five test files, nearest first, and counts the ones it left to certification", async () => {
    const trunk = new Trunk();
    const files: Record<Path, string> = {
      "src/shared.ts": "export const one = 1;\n",
      "src/mid.ts": 'import { one } from "./shared.ts";\nexport const two = one + 1;\n',
    };
    for (const n of [1, 2, 3, 4, 5]) files[`test/a${n}.test.ts`] = `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { one } from "../src/shared.ts";\ntest("a${n}", () => assert.equal(one, 1));\n`;
    for (const n of [1, 2]) files[`test/b${n}.test.ts`] = `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { two } from "../src/mid.ts";\ntest("b${n}", () => assert.equal(two, 2));\n`;
    const head = trunk.commit(files);
    const { certifier } = setup(trunk);
    expect((await certify(certifier, trunk)).status).toBe("green");
    const edit = change(head, { "src/shared.ts": "export const one = 2 - 1;\n" });
    const out = await certifier.precheck(edit.p, edit.read);
    expect(PRELAND_FILES).toBe(5);
    expect(out?.run).toMatchObject({ status: "passed", files: ["test/a1.test.ts", "test/a2.test.ts", "test/a3.test.ts", "test/a4.test.ts", "test/a5.test.ts"], reached: 7, tests: 5, passed: 5 });
    expect(out?.check.detail).toContain("2 more test files reach it, left to certification after landing");
  });

  it("tests a change on its base when trunk moved after it", async () => {
    const trunk = new Trunk();
    const base = trunk.commit({ "src/math.ts": MATH_OK, "test/math.test.ts": MATH_TEST, "src/other.ts": 'export const name = "a";\n', "test/other.test.ts": OTHER_TEST });
    const { certifier } = setup(trunk);
    expect((await certify(certifier, trunk)).status).toBe("green");
    trunk.commit({ "src/other.ts": 'export const name = "b";\n', "docs/a.md": "# a\n" });
    expect((await certify(certifier, trunk)).status).toBe("green");
    const bad = change(base, { "src/math.ts": MATH_BUG });
    expect((await certifier.precheck(bad.p, bad.read))?.run).toMatchObject({ status: "failed", trunkSha: base, broke: [{ name: "subtracts" }] });
  });

  it("fails open: nothing reaches the change, no trunk result yet, a time-out, a runner error, busy", async () => {
    const trunk = new Trunk();
    const head = trunk.commit({ "src/math.ts": MATH_OK, "test/math.test.ts": MATH_TEST, "src/lonely.ts": "export const x = 1;\n" });
    const { certifier, mode } = setup(trunk);
    const bad = change(head, { "src/math.ts": MATH_BUG });

    // Before certification has run these tests, there is nothing to compare with.
    mode.current = { kind: "node" };
    const early = await certifier.precheck(bad.p, bad.read);
    expect(early?.run).toMatchObject({ status: "unchecked", reason: expect.stringMatching(/^no trunk result to compare with: certification has not run the 1 test file that reach it/) });
    expect(early?.check).toMatchObject({ ok: true, detail: expect.stringMatching(/^not checked: no trunk result/) });
    expect((await certify(certifier, trunk)).status).toBe("green");

    const lonely = change(head, { "src/lonely.ts": "export const x = 2;\n" });
    expect((await certifier.precheck(lonely.p, lonely.read))?.run).toMatchObject({ status: "unchecked", reason: "no test file on trunk reaches the files it changes" });
    const docs = change(head, { "README.md": "# hi\n" });
    expect((await certifier.precheck(docs.p, docs.read))?.run).toMatchObject({ status: "unchecked", reason: "it changes no file a test can load" });

    mode.current = { kind: "fail" };
    expect((await certifier.precheck(bad.p, bad.read))?.run).toMatchObject({ status: "unchecked", reason: "the test run failed: the Worker Loader is unavailable" });

    mode.current = { kind: "hang" };
    const t0 = Date.now();
    const late = await certifier.precheck(bad.p, bad.read);
    expect(late?.run).toMatchObject({ status: "unchecked", reason: "the tests took longer than 2 s" });
    expect(Date.now() - t0).toBeLessThan(4_000);

    // Three checks hold the colony's slots; a fourth waits a second for one, then goes on, not checked.
    const held: Mode = { kind: "held", waiting: [] };
    mode.current = held;
    const running = [1, 2, 3].map(() => certifier.precheck(bad.p, bad.read));
    const busy = await certifier.precheck(bad.p, bad.read);
    expect(busy?.run).toMatchObject({ status: "unchecked", reason: "busy: 3 test runs before landing were already going in this colony" });
    expect(busy!.run.ms).toBeGreaterThanOrEqual(900);
    for (const go of held.waiting) go();
    for (const r of await Promise.all(running)) expect(r?.run.status === "failed" || r?.run.reason === "the tests took longer than 2 s").toBe(true);
  }, 30_000);

  it("is off unless FT_PRELAND covers the colony, its certification is on and prelandPaths match", async () => {
    const trunk = new Trunk();
    const head = trunk.commit({ "src/math.ts": MATH_OK, "test/math.test.ts": MATH_TEST, "src/api/x.ts": 'import { sub } from "../math.ts";\nexport const y = sub(2, 1);\n' });
    const bad = change(head, { "src/math.ts": MATH_BUG });

    const off = setup(trunk, { preland: false });
    expect(off.certifier.prelandCovers(["src/math.ts"])).toBe(false);
    expect(await off.certifier.precheck(bad.p, bad.read)).toBeNull();

    const certOff = setup(trunk, { policy: { enabled: false } });
    expect(await certOff.certifier.precheck(bad.p, bad.read)).toBeNull();

    const narrow = setup(trunk, { policy: { prelandPaths: ["src/api"] } });
    expect(narrow.certifier.prelandCovers(["src/math.ts"])).toBe(false);
    expect(await narrow.certifier.precheck(bad.p, bad.read)).toBeNull();
    expect(narrow.certifier.prelandCovers(["src/api/x.ts"])).toBe(true);
    expect(narrow.runner.loads).toHaveLength(0);
  });
});

/**
 * The change's own tests (FT_PRELAND): a test file the change adds or edits whose new tests fail with it sends it back,
 * and so does deleting a test file that passed on trunk, unless a person's intent names that file.
 */
const NEG_FAILS = 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { sub } from "../src/math.ts";\ntest("subtracts negatives", () => {\n  assert.equal(sub(-1, -1), 1);\n});\n';
const NEG_PASSES = NEG_FAILS.replace("sub(-1, -1), 1", "sub(-1, -1), 0");
const OTHER_TS = 'export const name = "a";\n';

describe("which test files are the change's own", () => {
  it("lists the test files it adds, edits and deletes by path, without the ones the policy excludes whole", () => {
    const before = { tests: ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts", "test/x.test.ts"] };
    const after = { tests: ["test/a.test.ts", "test/b.test.ts", "test/new.test.ts", "test/x.test.ts", "test/y.test.ts"] };
    const writes = [
      { path: "test/new.test.ts", blob: "n" },
      { path: "test/b.test.ts", blob: "b" },
      { path: "test/c.test.ts", blob: null },
      { path: "src/a.ts", blob: "s" },
      { path: "test/x.test.ts", blob: "x" },
      { path: "test/y.test.ts", blob: "y" },
      { path: "test/gone.test.ts", blob: null },
    ];
    expect(ownTests(before, after, writes)).toEqual({ added: ["test/new.test.ts", "test/y.test.ts"], edited: ["test/b.test.ts", "test/x.test.ts"], deleted: ["test/c.test.ts"] });
    expect(ownTests(before, after, writes, (p) => p === "test/x.test.ts" || p === "test/y.test.ts")).toEqual({ added: ["test/new.test.ts"], edited: ["test/b.test.ts"], deleted: ["test/c.test.ts"] });
  });

  it("lets a change delete a test file only when a person declared its intent and named the file's path", () => {
    const human = (why: string, extra: Record<string, unknown> = {}) => ({ source: "human", title: "Retire the old parser", why, ...extra });
    expect(deletionAsked(human("Delete src/old.test.ts: the parser it covers is gone."), "src/old.test.ts")).toBe(true);
    expect(deletionAsked(human("Remove `./src/old.test.ts`."), "src/old.test.ts")).toBe(true);
    expect(deletionAsked(human("Nothing here.", { acceptance: ["src/old.test.ts no longer exists"] }), "src/old.test.ts")).toBe(true);
    expect(deletionAsked({ source: "human", title: "Delete src/old.test.ts", why: "" }, "src/old.test.ts")).toBe(true);
    // The file's name alone, a longer path or name, another source, or no intent: not asked.
    expect(deletionAsked(human("Delete old.test.ts."), "src/old.test.ts")).toBe(false);
    expect(deletionAsked(human("Delete lib/src/old.test.ts and src/old.test.tsx."), "src/old.test.ts")).toBe(false);
    expect(deletionAsked(human("Delete src/old.test.ts.bak."), "src/old.test.ts")).toBe(false);
    expect(deletionAsked({ source: "agent", title: "Delete src/old.test.ts", why: "src/old.test.ts" }, "src/old.test.ts")).toBe(false);
    expect(deletionAsked({ source: "external", title: "Delete src/old.test.ts", why: "" }, "src/old.test.ts")).toBe(false);
    expect(deletionAsked(null, "src/old.test.ts")).toBe(false);
    expect(namesFile("see src/a+b.test.ts", "src/a+b.test.ts")).toBe(true);
  });

  it("holds a deleted test file that loaded and passed a test on trunk, not one that failed, did not load or has no result", () => {
    const result = (path: Path, tests: Array<[string, "pass" | "fail"]>, loadError: string | null = null): FileResult => ({ path, loadError, tests: tests.map(([name, status]) => ({ name, file: path, status })), suites: [] });
    const trunk = new Map([
      ["t/a.test.ts", result("t/a.test.ts", [["one", "pass"], ["two", "fail"]])],
      ["t/b.test.ts", result("t/b.test.ts", [["red", "fail"]])],
      ["t/c.test.ts", result("t/c.test.ts", [], "SyntaxError")],
      ["t/d.test.ts", result("t/d.test.ts", [["excluded", "pass"]])],
    ]);
    const files = ["t/a.test.ts", "t/b.test.ts", "t/c.test.ts", "t/d.test.ts", "t/none.test.ts"];
    expect(deletedPassing(files, trunk, (f, n) => f === "t/d.test.ts" && n === "excluded")).toEqual([{ file: "t/a.test.ts", name: "t/a.test.ts", kind: "deleted" }]);
    expect(deletedPassing(files, trunk).map((b) => b.file)).toEqual(["t/a.test.ts", "t/d.test.ts"]);
  });
});

describe("judging the change's own test files", () => {
  const trunkResult = (path: Path, tests: Array<[string, "pass" | "fail"]>, loadError: string | null = null): FileResult => ({
    path,
    loadError,
    tests: tests.map(([name, status]) => ({ name, file: path, status })),
    suites: [],
  });
  const report = (files: RunReport["files"], tests: RunReport["tests"]): RunReport => ({ runner: "r", files, tests, suites: [], ms: 1 });

  it("holds a failing test trunk's result does not list; a test failing there too, or one the policy excludes, stays known", () => {
    const trunk = new Map([["t/a.test.ts", trunkResult("t/a.test.ts", [["passes", "pass"], ["was red", "fail"]])]]);
    const run = report(
      [
        { path: "t/a.test.ts", ms: 1, tests: 4, loadError: null },
        { path: "t/new.test.ts", ms: 1, tests: 1, loadError: null },
      ],
      [
        { name: "passes", file: "t/a.test.ts", status: "pass" },
        { name: "was red", file: "t/a.test.ts", status: "fail", error: "still red" },
        { name: "added", file: "t/a.test.ts", status: "fail", error: "Expected 1, got 0" },
        { name: "runtime gap", file: "t/a.test.ts", status: "fail", error: "not in this runtime" },
        { name: "brand new", file: "t/new.test.ts", status: "fail", error: "nope" },
      ],
    );
    const own = new Set(["t/a.test.ts", "t/new.test.ts"]);
    const j = judgeRun(run, ["t/a.test.ts", "t/new.test.ts"], trunk, { own, excluded: (f, n) => f === "t/a.test.ts" && n === "runtime gap" });
    expect(j).toEqual({
      tests: 5,
      passed: 1,
      failed: 4,
      known: 2,
      broke: [
        { file: "t/a.test.ts", name: "added", error: "Expected 1, got 0", kind: "own" },
        { file: "t/new.test.ts", name: "brand new", error: "nope", kind: "own" },
      ],
      unjudged: [],
    });
    // Not the change's own files: the same run holds nothing (as before).
    expect(judgeRun(run, ["t/a.test.ts", "t/new.test.ts"], trunk).broke).toEqual([]);
  });

  it("holds an own file that fails to load when it is new or loaded on trunk, not when it failed to load there too", () => {
    const trunk = new Map([
      ["t/edited.test.ts", trunkResult("t/edited.test.ts", [["red", "fail"]])],
      ["t/broken.test.ts", trunkResult("t/broken.test.ts", [], "SyntaxError: on trunk")],
    ]);
    const run = report(
      [
        { path: "t/new.test.ts", ms: 1, tests: 0, loadError: "ReferenceError: src is not defined" },
        { path: "t/edited.test.ts", ms: 1, tests: 0, loadError: "SyntaxError: now" },
        { path: "t/broken.test.ts", ms: 1, tests: 0, loadError: "SyntaxError: still" },
      ],
      [],
    );
    const files = ["t/new.test.ts", "t/edited.test.ts", "t/broken.test.ts"];
    const j = judgeRun(run, files, trunk, { own: new Set(files) });
    expect(j.broke).toEqual([
      { file: "t/new.test.ts", name: "t/new.test.ts", error: "ReferenceError: src is not defined", kind: "own" },
      { file: "t/edited.test.ts", name: "t/edited.test.ts", error: "SyntaxError: now", kind: "own" },
    ]);
    expect(j).toMatchObject({ tests: 3, failed: 3, known: 1 });
  });

  it("says what the change's own tests and deleted files did, and what to do next, in a sentence", () => {
    const own = { file: "test/neg.test.ts", name: "subtracts negatives", error: "Expected 1, got 0", kind: "own" as const };
    expect(prelandReason([own])).toBe(
      'Tests before landing: the test "subtracts negatives" in test/neg.test.ts, a test file this change adds or edits, fails with it: Expected 1, got 0. A change cannot land tests its own code fails: fix the code, or the test if it asks for the wrong behavior, then propose again.',
    );
    expect(prelandReason([{ file: "src/router/node.test.ts", name: "src/router/node.test.ts", error: "ReferenceError: src is not defined", kind: "own" }])).toBe(
      "Tests before landing: the test file src/router/node.test.ts, which this change adds or edits, fails to load: ReferenceError: src is not defined. A change cannot land tests its own code fails: fix the code, or the test if it asks for the wrong behavior, then propose again.",
    );
    expect(prelandReason([{ file: "src/url.test.ts", name: "src/url.test.ts", kind: "deleted" }])).toBe(
      "Tests before landing: this change deletes the test file src/url.test.ts, whose tests passed on trunk. Keep that file (a passing test file is deleted only when the intent a person declared names its path), then propose again.",
    );
    expect(
      prelandReason([
        { file: "src/url.test.ts", name: "src/url.test.ts", kind: "deleted" },
        { file: "src/cookie.test.ts", name: "src/cookie.test.ts", kind: "deleted" },
        { file: "test/math.test.ts", name: "subtracts", error: "8 !== 2" },
        own,
        { ...own, name: "adds" },
      ]),
    ).toBe(
      'Tests before landing: the test "subtracts" in test/math.test.ts passed on trunk and fails with this change: 8 !== 2; 2 tests in test files this change adds or edits fail with it: the test "subtracts negatives" in test/neg.test.ts: Expected 1, got 0; the test "adds" in test/neg.test.ts: Expected 1, got 0; this change deletes 2 test files whose tests passed on trunk: src/url.test.ts; src/cookie.test.ts. Fix the change so that test passes again (a test that passed on trunk is the specification); a change cannot land tests its own code fails: fix the code, or the test if it asks for the wrong behavior; keep those files (a passing test file is deleted only when the intent a person declared names its path), then propose again.',
    );
  });
});

describe("the certifier's precheck of the change's own tests", () => {
  const seed = { "src/math.ts": MATH_OK, "test/math.test.ts": MATH_TEST, "src/other.ts": OTHER_TS, "test/other.test.ts": OTHER_TEST };

  it("sends back a change that adds a test its code fails, naming it, and passes one that adds a passing test", async () => {
    const trunk = new Trunk();
    const head = trunk.commit(seed);
    const { certifier } = setup(trunk);
    expect((await certify(certifier, trunk)).status).toBe("green");

    const bad = change(head, { "test/neg.test.ts": NEG_FAILS });
    const failed = await certifier.precheck(bad.p, bad.read);
    expect(failed?.run).toMatchObject({ status: "failed", trunkSha: head, files: ["test/neg.test.ts"], tests: 1, passed: 0, failed: 1 });
    expect(failed?.run.broke).toEqual([{ file: "test/neg.test.ts", name: "subtracts negatives", error: "AssertionError (strictEqual): actual 0, expected 1 (at test/neg.test.ts:5)", kind: "own" }]);
    expect(failed?.reason).toBe(
      'Tests before landing: the test "subtracts negatives" in test/neg.test.ts, a test file this change adds or edits, fails with it: AssertionError (strictEqual): actual 0, expected 1 (at test/neg.test.ts:5). A change cannot land tests its own code fails: fix the code, or the test if it asks for the wrong behavior, then propose again.',
    );
    expect(failed?.check).toMatchObject({ name: PRELAND_CHECK, ok: false });

    // A passing new test file runs first, ahead of the trunk test file the change's code edit reaches.
    const good = change(head, { "src/math.ts": `// Subtraction.\n${MATH_OK}`, "test/neg.test.ts": NEG_PASSES });
    expect((await certifier.precheck(good.p, good.read))?.run).toMatchObject({ status: "passed", files: ["test/neg.test.ts", "test/math.test.ts"], tests: 2, passed: 2, failed: 0 });
  });

  it("holds a new failing test in a test file it edits, but not a test that failed on trunk too", async () => {
    const trunk = new Trunk();
    const head = trunk.commit({ ...seed, "test/math.test.ts": KNOWN_TEST });
    const { certifier } = setup(trunk);
    expect((await certify(certifier, trunk)).status).toBe("red");
    const added = 'test("subtracts negatives", () => {\n  assert.equal(sub(-1, -1), 1);\n});\n';
    const bad = change(head, { "test/math.test.ts": `${KNOWN_TEST}${added}` });
    const failed = await certifier.precheck(bad.p, bad.read);
    expect(failed?.run).toMatchObject({ status: "failed", files: ["test/math.test.ts"], tests: 3, passed: 1, failed: 2, known: 1, broke: [{ file: "test/math.test.ts", name: "subtracts negatives", kind: "own" }] });
    const good = change(head, { "test/math.test.ts": `${KNOWN_TEST}${added.replace("sub(-1, -1), 1", "sub(-1, -1), 0")}` });
    expect((await certifier.precheck(good.p, good.read))?.run).toMatchObject({ status: "passed", tests: 3, passed: 2, failed: 1, known: 1 });
  });

  it("sends back a change that deletes a passing test file unless a person's intent names it", async () => {
    const trunk = new Trunk();
    const head = trunk.commit(seed);
    const { certifier } = setup(trunk);
    expect((await certify(certifier, trunk)).status).toBe("green");
    const gone = change(head, { "test/math.test.ts": null });
    const sent = await certifier.precheck(gone.p, gone.read);
    expect(sent?.run).toMatchObject({ status: "failed", trunkSha: head, files: [], tests: 0, broke: [{ file: "test/math.test.ts", name: "test/math.test.ts", kind: "deleted" }] });
    expect(sent?.reason).toBe(
      "Tests before landing: this change deletes the test file test/math.test.ts, whose tests passed on trunk. Keep that file (a passing test file is deleted only when the intent a person declared names its path), then propose again.",
    );
    // An agent's intent, or a person's that names only the file's name, does not ask for it.
    expect((await certifier.precheck(gone.p, gone.read, { source: "agent", title: "Delete test/math.test.ts", why: "" }))?.run.status).toBe("failed");
    expect((await certifier.precheck(gone.p, gone.read, { source: "human", title: "Drop math.test.ts", why: "" }))?.run.status).toBe("failed");
    // A person's intent that names it: the deletion is theirs, and nothing else reaches the change.
    const asked = await certifier.precheck(gone.p, gone.read, { source: "human", title: "Retire subtraction tests", why: "Delete test/math.test.ts; subtraction moves out." });
    expect(asked?.run).toMatchObject({ status: "unchecked", reason: "no test file on trunk reaches the files it changes" });

    // Deleted with a code change that breaks another test: both are named.
    const both = change(head, { "test/math.test.ts": null, "src/other.ts": "export const name = 1;\n" });
    const out = await certifier.precheck(both.p, both.read);
    expect(out?.run).toMatchObject({ status: "failed", files: ["test/other.test.ts"], broke: [{ file: "test/math.test.ts", kind: "deleted" }, { file: "test/other.test.ts", name: "names" }] });
    expect(out?.reason).toMatch(/^Tests before landing: the test "names" in test\/other\.test\.ts passed on trunk and fails with this change: .*; this change deletes the test file test\/math\.test\.ts, whose tests passed on trunk\. Fix the change so that test passes again/);
  });

  it("keeps the limits: own test files count against the five, and a run that cannot finish still sends a deletion back", async () => {
    const trunk = new Trunk();
    const head = trunk.commit(seed);
    const { certifier, mode } = setup(trunk);
    expect((await certify(certifier, trunk)).status).toBe("green");
    const six: Record<Path, string> = {};
    for (const n of [1, 2, 3, 4, 5, 6]) six[`test/n${n}.test.ts`] = NEG_PASSES.replace("subtracts negatives", `n${n}`);
    const many = change(head, six);
    const out = await certifier.precheck(many.p, many.read);
    expect(out?.run).toMatchObject({ status: "passed", files: ["test/n1.test.ts", "test/n2.test.ts", "test/n3.test.ts", "test/n4.test.ts", "test/n5.test.ts"], reached: 6, tests: 5, passed: 5 });
    expect(out?.check.detail).toContain("1 more test file reach it, left to certification after landing");

    mode.current = { kind: "hang" };
    const gone = change(head, { "test/math.test.ts": null, "src/other.ts": 'export const name = "b";\n' });
    expect((await certifier.precheck(gone.p, gone.read))?.run).toMatchObject({ status: "failed", files: [], broke: [{ file: "test/math.test.ts", kind: "deleted" }] });
    // Without a deletion, a run that cannot finish lets the change go on, not checked, as before.
    const added = change(head, { "test/neg.test.ts": NEG_FAILS });
    expect((await certifier.precheck(added.p, added.read))?.run).toMatchObject({ status: "unchecked", reason: "the tests took longer than 2 s" });
  }, 30_000);

  it("leaves out the change's own tests the certify policy excludes", async () => {
    const trunk = new Trunk();
    const head = trunk.commit(seed);
    const byFile = setup(trunk, { policy: { excludeTests: ["test/neg.test.ts"] } });
    expect((await certify(byFile.certifier, trunk)).status).toBe("green");
    const bad = change(head, { "test/neg.test.ts": NEG_FAILS });
    expect((await byFile.certifier.precheck(bad.p, bad.read))?.run).toMatchObject({ status: "unchecked", reason: "no test file on trunk reaches the files it changes" });
    const byName = setup(trunk, { policy: { excludeTests: ["test/neg.test.ts > subtracts negatives"] } });
    expect((await certify(byName.certifier, trunk)).status).toBe("green");
    expect((await byName.certifier.precheck(bad.p, bad.read))?.run).toMatchObject({ status: "passed", files: ["test/neg.test.ts"], tests: 1, failed: 1, known: 1 });
  });
});
