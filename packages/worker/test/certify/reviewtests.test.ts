import { describe, expect, it } from "vitest";
import type { Certification, Id, Path, Proposal, ReviewTestsRun, Sha } from "@fire_trident/core";
import { Certifier, type CertifyHost, type CertifyTrunk } from "../../src/certify/certifier.ts";
import type { Plan } from "../../src/certify/plan.ts";
import { REVIEW_TESTS_AT_ONCE, REVIEW_TESTS_MS, ReviewTests, compareFailing, reviewTestsLine, reviewTestsText, type ReviewTestsHost } from "../../src/certify/reviewtests.ts";
import { noteDecision } from "../../src/colony/direction.ts";
import { runPlanInNode } from "./harness.ts";

/**
 * Tests before approval in Node: an escalated change gets the colony's tests run on its base with its files laid over it,
 * through the certifier's sandbox (each plan run with the real harness and node:test shim in a Node process), each
 * failing test set against the base; the runs queue behind a per-colony cap, fail open with the reason, run again on
 * request, and leave the line a person's decision records.
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

/** How the stand-in Worker Loader answers: by running the plan in Node, never, or once released. */
type Mode = { kind: "node" } | { kind: "hang" } | { kind: "held"; waiting: Array<() => void> };

/** A Worker Loader stand-in whose answer `mode` decides; `loads` keeps the plans it was given. */
function loader(mode: { current: Mode }): WorkerLoader & { loads: Plan[] } {
  const loads: Plan[] = [];
  const load = (code: WorkerLoaderWorkerCode): WorkerStub => {
    const plan = { mainModule: code.mainModule, modules: code.modules } as unknown as Plan;
    loads.push(plan);
    const m = mode.current;
    const entrypoint = {
      fetch: async (): Promise<Response> => {
        if (m.kind === "hang") return new Promise<Response>(() => undefined);
        if (m.kind === "held") await new Promise<void>((go) => m.waiting.push(go));
        return new Response(JSON.stringify(runPlanInNode(plan)));
      },
    };
    return { getEntrypoint: () => entrypoint } as unknown as WorkerStub;
  };
  return { loads, load } as unknown as WorkerLoader & { loads: Plan[] };
}

let seq = 0;

/** A colony in miniature: a certifier over `trunk`, its proposals (each with the texts of its new files), and its runs. */
function colony(trunk: Trunk, opts: { off?: string | null; ms?: number; atOnce?: number; queue?: number } = {}) {
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
  };
  const certifier = new Certifier(host);
  const set = certifier.setPolicy({ minIntervalMs: 0, repair: false });
  if ("error" in set) throw new Error(set.error);
  const proposals = new Map<Id, Proposal>();
  const texts = new Map<Sha, string>();
  const saves: Array<{ id: Id; run: ReviewTestsRun }> = [];
  const rtHost: ReviewTestsHost = {
    off: () => opts.off ?? null,
    trunk: () => trunk,
    sandbox: () => certifier.sealedRuns(),
    certification: (sha) => certifier.get(sha),
    proposal: (id) => proposals.get(id) ?? null,
    reader: () => async (blobs) => new Map(blobs.map((b) => [b, texts.get(b) ?? null])),
    save: (id, run, replaces) => {
      const cur = proposals.get(id);
      if (!cur || cur.status !== "escalated") return false;
      if (replaces !== null && cur.evidence.reviewTests?.id !== replaces) return false;
      proposals.set(id, { ...cur, evidence: { ...cur.evidence, reviewTests: run } });
      saves.push({ id, run });
      return true;
    },
  };
  const tests = new ReviewTests(rtHost, { ...(opts.ms !== undefined ? { ms: opts.ms } : {}), ...(opts.atOnce !== undefined ? { atOnce: opts.atOnce } : {}), ...(opts.queue !== undefined ? { queue: opts.queue } : {}) });

  /** An escalated change on `base` writing `files` (null deletes), escalated as the colony does it. */
  const escalate = (base: Sha, files: Record<Path, string | null>): Proposal => {
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
      status: "escalated",
      createdAt: Date.now(),
    };
    proposals.set(p.id, p);
    tests.escalated(p);
    return p;
  };

  /** The proposal's recorded run once it has ended (ran or not run). */
  const result = async (id: Id, timeoutMs = 20_000): Promise<ReviewTestsRun> => {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const run = proposals.get(id)?.evidence.reviewTests;
      if (run && (run.status === "ran" || run.status === "notrun")) return run;
      if (Date.now() > until) throw new Error(`no result for ${id} yet (${JSON.stringify(run)})`);
      await sleep(10);
    }
  };

  return { certifier, mode, runner, proposals, tests, escalate, result, saves };
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

const MATH_OK = "export function sub(a: number, b: number): number {\n  return a - b;\n}\n";
const MATH_BUG = "export function sub(a: number, b: number): number {\n  return a + b;\n}\n";
const MATH_TEST = 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { sub } from "../src/math.ts";\ntest("subtracts", () => {\n  assert.equal(sub(5, 3), 2);\n});\n';
/** A file with one test that passes with sub() as it is and one that never does. */
const KNOWN_TEST = 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { sub } from "../src/math.ts";\ntest("subtracts", () => {\n  assert.equal(sub(5, 3), 2);\n});\ntest("known bug", () => {\n  assert.equal(sub(1, 1), 1);\n});\n';
const OTHER = 'export const name = "a";\n';
const OTHER_TEST = 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { name } from "../src/other.ts";\ntest("names", () => {\n  assert.equal(typeof name, "string");\n});\n';

/** A trunk with the math module and another one, each with its test, certified green. */
async function greenProject() {
  const trunk = new Trunk();
  const head = trunk.commit({ "src/math.ts": MATH_OK, "test/math.test.ts": MATH_TEST, "src/other.ts": OTHER, "test/other.test.ts": OTHER_TEST });
  return { trunk, head };
}

describe("tests before approval: the sentences", () => {
  it("leads with the counts, names the failing tests and says how they did on trunk", () => {
    const run: ReviewTestsRun = {
      id: "r",
      status: "ran",
      by: "escalation",
      at: 0,
      tests: 434,
      passed: 433,
      failed: 1,
      failing: [{ file: "test/math.test.ts", name: "subtracts", error: "AssertionError: 8 !== 2", onTrunk: "passes" }],
      onTrunk: { passes: 1 },
    };
    expect(reviewTestsText(run)).toBe('Tests on this change: 433/434 passed, 1 failed ("subtracts"). 1 failing here that passes on trunk.');
    expect(reviewTestsLine(run)).toBe("433/434 passed, 1 failed, 1 failing here that passes on trunk");
    const many: ReviewTestsRun = {
      ...run,
      passed: 429,
      failed: 5,
      skipped: 2,
      failing: [
        { file: "a", name: "a", onTrunk: "passes" },
        { file: "b", name: "b", onTrunk: "fails" },
        { file: "c", name: "c", onTrunk: "fails" },
        { file: "d", name: "d", onTrunk: "new" },
      ],
      onTrunk: { passes: 1, fails: 2, new: 1, unknown: 1 },
    };
    expect(reviewTestsText(many)).toBe('Tests on this change: 429/434 passed, 2 skipped, 5 failed ("a", "b", "c" and 2 more). 1 failing here that passes on trunk; 2 fail on trunk too; 1 is new with this change; 1 with no result on trunk to compare with.');
    expect(reviewTestsText({ ...run, passed: 434, failed: 0, failing: [], onTrunk: {} })).toBe("Tests on this change: 434/434 passed.");
    expect(reviewTestsText({ id: "r", status: "notrun", by: "x", at: 0, reason: "the tests took longer than 60 s" })).toBe("Tests on this change: not run: the tests took longer than 60 s.");
    expect(reviewTestsLine({ id: "r", status: "notrun", by: "x", at: 0, reason: "no test file imports node:test (2 test files)" })).toBe("not run, no test file imports node:test (2 test files)");
    expect(reviewTestsText({ id: "r", status: "queued", by: "x", at: 0 }, 2)).toBe("Tests on this change: waiting to run (2 runs ahead of it in this colony).");
    expect(reviewTestsText({ id: "r", status: "running", by: "x", at: 0, baseSha: "abcdef1234" })).toBe("Tests on this change: running on its base abcdef1.");
  });

  it("sets a failing test against its file's result at the base, else the base commit's certification", () => {
    const results = new Map([["t/a.test.ts", { path: "t/a.test.ts", loadError: null, tests: [{ name: "ok", file: "t/a.test.ts", status: "pass" as const }, { name: "red", file: "t/a.test.ts", status: "fail" as const }], suites: [] }]]);
    const base = { tests: new Set(["t/a.test.ts", "t/b.test.ts"]), results, cert: { status: "red" as const, failing: [{ file: "t/b.test.ts", name: "old" }] } };
    expect(compareFailing({ file: "t/a.test.ts", name: "ok" }, base)).toBe("passes");
    expect(compareFailing({ file: "t/a.test.ts", name: "red" }, base)).toBe("fails");
    expect(compareFailing({ file: "t/a.test.ts", name: "brand new" }, base)).toBe("new");
    expect(compareFailing({ file: "t/a.test.ts", name: "t/a.test.ts", error: "SyntaxError" }, base)).toBe("passes");
    expect(compareFailing({ file: "t/b.test.ts", name: "old" }, base)).toBe("fails");
    expect(compareFailing({ file: "t/b.test.ts", name: "other" }, base)).toBe("unknown");
    expect(compareFailing({ file: "t/c.test.ts", name: "x" }, base)).toBe("new");
    expect(compareFailing({ file: "t/a.test.ts", name: "ok", error: "the certification ran out of time while this test ran" }, base)).toBe("unfinished");
  });

  it("carries the line into the human decision of the lineage note, and leaves a decision without one as it was", () => {
    const row = (answers: Record<string, unknown>) => ({ id: "dec_1", kind: "triage", subject: "prp_1", layer: "human", answers: JSON.stringify(answers), p: 1, action: "approve", at: 5 });
    expect(noteDecision(row({ decision: "approve", reason: "looks right", by: "matt", tests: "0/1 passed, 1 failed, 1 failing here that passes on trunk" })).answer).toBe(
      "approve (tests before approval: 0/1 passed, 1 failed, 1 failing here that passes on trunk): looks right",
    );
    expect(noteDecision(row({ decision: "approve", reason: "looks right", by: "matt" })).answer).toBe("approve: looks right");
    expect(noteDecision({ ...row({ decision: "reject", reason: "no", tests: "1/1 passed" }), action: "reject" }).answer).toBe("reject (tests before the decision: 1/1 passed): no");
  });
});

describe("tests before approval: runs on escalated changes", () => {
  it("runs the colony's tests on an escalated change, the ones it reaches with it, and sets each failing test against trunk", async () => {
    const { trunk, head } = await greenProject();
    const c = colony(trunk);
    expect((await certify(c.certifier, trunk)).status).toBe("green");
    const loads = c.runner.loads.length;

    const bad = c.escalate(head, { "src/math.ts": MATH_BUG });
    const run = await c.result(bad.id);
    expect(run).toMatchObject({
      status: "ran",
      by: "escalation",
      headSha: bad.headSha,
      baseSha: head,
      files: 2,
      ranFiles: 1,
      tests: 2,
      passed: 1,
      failed: 1,
      onTrunk: { passes: 1 },
      trunk: { sha: head, status: "green", tests: 2, passed: 2, failing: 0 },
    });
    expect(run.failing).toEqual([{ file: "test/math.test.ts", name: "subtracts", error: "AssertionError (strictEqual): actual 8, expected 2 (at test/math.test.ts:5)", onTrunk: "passes" }]);
    expect(run.text).toBe('Tests on this change: 1/2 passed, 1 failed ("subtracts"). 1 failing here that passes on trunk.');
    // Only the test file the change reaches ran; the other kept certification's result.
    expect(c.runner.loads.length).toBe(loads + 1);
    expect(JSON.stringify(c.runner.loads.at(-1)!.modules)).not.toContain("other.test.ts");
    // The card's view is the recorded run.
    expect(c.tests.view(c.proposals.get(bad.id)!)).toMatchObject({ status: "ran", text: run.text });
  });

  it("says a failing test fails on trunk too, and that a new failing test is new", async () => {
    const trunk = new Trunk();
    const head = trunk.commit({ "src/math.ts": MATH_OK, "test/math.test.ts": KNOWN_TEST });
    const c = colony(trunk);
    expect((await certify(c.certifier, trunk)).status).toBe("red");
    const edit = c.escalate(head, { "src/math.ts": `// Subtraction.\n${MATH_OK}`, "test/extra.test.ts": 'import { test } from "node:test";\ntest("extra", () => {\n  throw new Error("not yet");\n});\n' });
    const run = await c.result(edit.id);
    expect(run).toMatchObject({ status: "ran", tests: 3, passed: 1, failed: 2, onTrunk: { fails: 1, new: 1 }, trunk: { status: "red", failing: 1 } });
    expect(run.failing?.map((f) => [f.name, f.onTrunk])).toEqual([
      ["extra", "new"],
      ["known bug", "fails"],
    ]);
    expect(run.text).toBe('Tests on this change: 1/3 passed, 2 failed ("extra", "known bug"). 1 fails on trunk too; 1 is new with this change.');
  });

  it("tests a change on its base when trunk moved after it, and says so when the base can no longer be read", async () => {
    const { trunk, head } = await greenProject();
    const c = colony(trunk);
    expect((await certify(c.certifier, trunk)).status).toBe("green");
    trunk.commit({ "src/other.ts": 'export const name = "b";\n' });
    const bad = c.escalate(head, { "src/math.ts": MATH_BUG });
    expect(await c.result(bad.id)).toMatchObject({ status: "ran", baseSha: head, failed: 1, onTrunk: { passes: 1 } });
    const lost = c.escalate("e".repeat(40), { "src/math.ts": MATH_BUG });
    expect(await c.result(lost.id)).toMatchObject({ status: "notrun", reason: "the change's base commit eeeeeee can no longer be read" });
  });

  it("says not run, with the reason, when the colony has no tests this runner can run", async () => {
    const trunk = new Trunk();
    const head = trunk.commit({ "src/math.ts": MATH_OK, "test/math.test.ts": 'import { describe, it } from "vitest";\nimport { sub } from "../src/math.ts";\ndescribe("math", () => it("subtracts", () => sub(1, 1)));\n' });
    const c = colony(trunk);
    const bad = c.escalate(head, { "src/math.ts": MATH_BUG });
    const run = await c.result(bad.id);
    expect(run).toMatchObject({ status: "notrun", reason: "no test file imports node:test (1 test file)" });
    expect(run.text).toBe("Tests on this change: not run: no test file imports node:test (1 test file).");
    const bare = new Trunk();
    const at = bare.commit({ "src/math.ts": MATH_OK });
    const d = colony(bare);
    const none = d.escalate(at, { "src/math.ts": MATH_BUG });
    expect(await d.result(none.id)).toMatchObject({ status: "notrun", reason: "there are no test files (*.test.ts or *.test.js) with the change" });
  });

  it("says not run when the tests take longer than the bound", async () => {
    const { trunk, head } = await greenProject();
    const c = colony(trunk, { ms: 1_500 });
    expect((await certify(c.certifier, trunk)).status).toBe("green");
    c.mode.current = { kind: "hang" };
    const t0 = Date.now();
    const bad = c.escalate(head, { "src/math.ts": MATH_BUG });
    const run = await c.result(bad.id);
    expect(run).toMatchObject({ status: "notrun", reason: "the tests took longer than 2 s" });
    expect(run.text).toBe("Tests on this change: not run: the tests took longer than 2 s.");
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(REVIEW_TESTS_MS).toBe(60_000);
  });

  it("runs again when a person asks, replacing the result, and refuses what it cannot run", async () => {
    const { trunk, head } = await greenProject();
    const c = colony(trunk);
    expect((await certify(c.certifier, trunk)).status).toBe("green");
    c.mode.current = { kind: "hang" };
    const bad = c.escalate(head, { "src/math.ts": MATH_BUG });
    // The first run hangs; asking again while it goes is refused.
    await sleep(20);
    expect(c.tests.request(bad.id, "matt")).toMatchObject({ started: false, status: 409, reason: expect.stringMatching(/already waiting or running/) });
    expect(c.tests.view(c.proposals.get(bad.id)!)).toMatchObject({ status: "running", text: `Tests on this change: running on its base ${head.slice(0, 7)}.` });

    const d = colony(trunk);
    const first = d.escalate(head, { "src/math.ts": MATH_BUG });
    const one = await d.result(first.id);
    const loads = d.runner.loads.length;
    const again = d.tests.request(first.id, "matt");
    expect(again).toMatchObject({ started: true, run: { status: expect.stringMatching(/^(queued|running)$/), by: "matt" } });
    const two = await d.result(first.id);
    expect(two.id).not.toBe(one.id);
    expect(two).toMatchObject({ status: "ran", by: "matt", failed: 1 });
    expect(d.runner.loads.length).toBe(loads + 1);

    expect(d.tests.request("prp_none", "matt")).toMatchObject({ started: false, status: 404 });
    d.proposals.set(first.id, { ...d.proposals.get(first.id)!, status: "ready" });
    expect(d.tests.request(first.id, "matt")).toMatchObject({ started: false, status: 409, reason: expect.stringMatching(/is ready, not waiting for a person/) });
  });

  it("asks for nothing when tests cannot run in the colony, and the card says why", async () => {
    const { trunk, head } = await greenProject();
    const c = colony(trunk, { off: "trunk certification is off for this colony" });
    const p = c.escalate(head, { "src/math.ts": MATH_BUG });
    await sleep(30);
    expect(c.saves).toEqual([]);
    expect(c.proposals.get(p.id)!.evidence.reviewTests).toBeUndefined();
    expect(c.tests.view(c.proposals.get(p.id)!)).toMatchObject({ status: "notrun", text: "Tests on this change: not run: trunk certification is off for this colony." });
    expect(c.tests.request(p.id, "matt")).toMatchObject({ started: false, status: 409, reason: "Tests cannot run in this colony: trunk certification is off for this colony. Turn certification on to test escalated changes." });
  });

  it("runs at most the cap at once in a colony and queues the rest in order", async () => {
    const { trunk, head } = await greenProject();
    const c = colony(trunk, { atOnce: 1, queue: 2 });
    expect((await certify(c.certifier, trunk)).status).toBe("green");
    expect(REVIEW_TESTS_AT_ONCE).toBe(2);
    const held: Mode = { kind: "held", waiting: [] };
    c.mode.current = held;
    const a = c.escalate(head, { "src/math.ts": MATH_BUG });
    const b = c.escalate(head, { "src/other.ts": 'export const name = "c";\n' });
    const d = c.escalate(head, { "src/math.ts": `// Subtraction.\n${MATH_OK}` });
    const e = c.escalate(head, { "src/math.ts": `// Again.\n${MATH_OK}` });
    for (let i = 0; i < 200 && held.waiting.length === 0; i++) await sleep(10);
    expect(c.tests.running).toBe(1);
    expect(c.tests.queued).toBe(2);
    expect(c.tests.view(c.proposals.get(a.id)!)?.status).toBe("running");
    expect(c.tests.view(c.proposals.get(b.id)!)).toMatchObject({ status: "queued", text: "Tests on this change: waiting to run." });
    expect(c.tests.view(c.proposals.get(d.id)!)).toMatchObject({ status: "queued", text: "Tests on this change: waiting to run (1 run ahead of it in this colony)." });
    // Past the queue's cap, a change is recorded as not run, and can be run again later.
    expect(c.proposals.get(e.id)!.evidence.reviewTests).toMatchObject({ status: "notrun", reason: "2 other escalated changes already waited for a test run in this colony; run it again once they end" });
    // Released one by one, they run one at a time and all end.
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 400 && held.waiting.length === 0; j++) await sleep(10);
      expect(held.waiting.length).toBe(1);
      held.waiting.shift()!();
      await sleep(20);
    }
    expect(await c.result(a.id)).toMatchObject({ status: "ran", failed: 1 });
    expect(await c.result(b.id)).toMatchObject({ status: "ran", failed: 0, text: "Tests on this change: 2/2 passed." });
    expect(await c.result(d.id)).toMatchObject({ status: "ran", failed: 0 });
    expect(c.tests.running).toBe(0);
  });

  it("records a run still waiting when a person decides as not finished, and gives the decision its line", async () => {
    const { trunk, head } = await greenProject();
    const c = colony(trunk, { atOnce: 1 });
    expect((await certify(c.certifier, trunk)).status).toBe("green");
    c.mode.current = { kind: "held", waiting: [] };
    c.escalate(head, { "src/math.ts": MATH_BUG });
    const late = c.escalate(head, { "src/math.ts": `// Subtraction.\n${MATH_OK}` });
    await sleep(30);
    const decided = c.tests.decided(c.proposals.get(late.id)!);
    expect(decided.line).toBe("not run, the change was decided before its tests finished");
    expect(decided.evidence?.reviewTests).toMatchObject({ status: "notrun", reason: "the change was decided before its tests finished" });
    expect(c.tests.queued).toBe(0);
    // A change with a result gives its line and changes nothing.
    const d = colony(trunk);
    expect((await certify(d.certifier, trunk)).status).toBe("green");
    const done = d.escalate(head, { "src/math.ts": MATH_BUG });
    await d.result(done.id);
    expect(d.tests.decided(d.proposals.get(done.id)!)).toEqual({ line: "1/2 passed, 1 failed, 1 failing here that passes on trunk" });
    // A recorded run nothing runs any more (the colony restarted) is cut short.
    const e = colony(trunk);
    const p = { ...done, id: "prp_restarted", evidence: { checks: [], reviewTests: { id: "rtr_x", status: "queued" as const, by: "escalation", at: 1 } } };
    expect(e.tests.view(p)).toMatchObject({ status: "notrun", reason: expect.stringMatching(/cut short/) });
    expect(e.tests.decided(p).line).toMatch(/^not run, its run was cut short/);
  });

  it("keeps the result of a change sent to a person again unchanged, without running it twice", async () => {
    const { trunk, head } = await greenProject();
    const c = colony(trunk);
    expect((await certify(c.certifier, trunk)).status).toBe("green");
    const p = c.escalate(head, { "src/math.ts": MATH_BUG });
    const run = await c.result(p.id);
    const loads = c.runner.loads.length;
    c.tests.escalated(c.proposals.get(p.id)!);
    await sleep(30);
    expect(c.proposals.get(p.id)!.evidence.reviewTests).toEqual(run);
    expect(c.runner.loads.length).toBe(loads);
  });
});
