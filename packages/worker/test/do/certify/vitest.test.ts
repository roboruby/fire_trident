import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Certification, Intent, Proposal } from "@fire_trident/core";
import { load } from "../../../src/certify/load.ts";
import { buildPlan, type Plan } from "../../../src/certify/plan.ts";
import { summarize, type RunReport } from "../../../src/certify/report.ts";
import { VITEST_EXPECTED, VITEST_PROJECT } from "../../certify/vitest-fixture.ts";
import { addAgent, addIntent, api, colony, env, eventually, externalLanding, fakeSha, headSha, newColony, proposal, take, tick, trunk } from "../helpers.ts";
import hono from "./fixtures/hono-subset.json";

/**
 * vitest in real Dynamic Workers (Worker Loader), the way certification runs every test file: the vitest semantics
 * fixture and a subset of Hono's own test files (fixtures/hono-subset.json, MIT, see fixtures/NOTICE) give the counts
 * real vitest reported for them; a colony whose tests are written for vitest certifies green, counts unsupported APIs
 * apart, goes red on a breaking landing, honours the policy's excluded tests, and its first red search finds the landing.
 */

type Counts = { pass: number; fail: number; skipped: number; todo: number; unsupported: number };

async function runInWorker(plan: Plan): Promise<RunReport> {
  if (!env.LOADER) throw new Error("no Worker Loader binding");
  const worker = env.LOADER.load({ compatibilityDate: "2026-08-01", compatibilityFlags: ["nodejs_compat"], mainModule: plan.mainModule, modules: plan.modules as Record<string, WorkerLoaderModule>, globalOutbound: null });
  const res = await worker.getEntrypoint().fetch("https://certify.invalid/run");
  return (await res.json()) as RunReport;
}

async function planFor(files: Record<string, string>, isolate = true): Promise<Plan> {
  const index = Object.entries(files).map(([path, text]) => ({ path, blob: `b:${path}`, size: text.length }));
  const loaded = await load(index, async (blobs) => Object.fromEntries(blobs.map((b) => [b, files[b.slice(2)] ?? null])));
  return buildPlan({ tests: loaded.tests, modules: loaded.modules, config: { testTimeoutMs: 5_000, budgetMs: 40_000 }, isolate });
}

function perFile(r: RunReport): Map<string, Counts> {
  const out = new Map<string, Counts>();
  for (const f of r.files) out.set(f.path, { pass: 0, fail: 0, skipped: 0, todo: 0, unsupported: 0 });
  for (const t of r.tests) {
    const c = out.get(t.file)!;
    if (t.unsupported) c.unsupported++;
    else if (t.status === "cancelled") c.fail++;
    else c[t.status]++;
  }
  return out;
}

describe("vitest in the test Worker (Dynamic Workers)", () => {
  it("counts the vitest semantics fixture as real vitest does", async () => {
    const got = perFile(await runInWorker(await planFor(VITEST_PROJECT)));
    for (const [file, want] of Object.entries(VITEST_EXPECTED)) {
      if (file === "test/mocked.test.ts") continue;
      const c = got.get(file)!;
      expect({ ...c, pass: c.pass + c.unsupported, unsupported: 0 }, file).toEqual({ ...want, unsupported: 0 });
    }
    expect(got.get("test/unsupported.test.ts")).toMatchObject({ unsupported: 2 });
    expect(got.get("test/node.test.ts")).toEqual({ pass: 1, fail: 0, skipped: 0, todo: 0, unsupported: 0 });
  });

  it("agrees with real vitest on a subset of Hono's test files, with one module copy each and shared", async () => {
    const corpus = hono as { expected: Record<string, Omit<Counts, "unsupported">>; files: Record<string, string> };
    for (const isolate of [true, false]) {
      const report = await runInWorker(await planFor(corpus.files, isolate));
      const got = perFile(report);
      expect(Object.fromEntries([...got].filter(([f]) => f in corpus.expected).map(([f, c]) => [f, { pass: c.pass, fail: c.fail, skipped: c.skipped, todo: c.todo }]))).toEqual(corpus.expected);
      // The shared router cases are a test file other test files import: run on its own it defines no tests.
      expect(got.get("src/router/common.case.test.ts")).toEqual({ pass: 0, fail: 0, skipped: 0, todo: 0, unsupported: 0 });
      expect(summarize(report)).toMatchObject({ status: "green", counts: { tests: 180, pass: 178, skipped: 2, fail: 0 } });
    }
  });
});

const CONFIG = "export default { test: { globals: true } }\n";
const MATH = "export enum Op {\n  Sub = 'sub',\n}\nexport function sub(a: number, b: number): number {\n  return a - b\n}\n";
const MATH_BUG = "export enum Op {\n  Sub = 'sub',\n}\nexport function sub(a: number, b: number): number {\n  return a + b\n}\n";
const INDEX = "export { sub, Op } from './math.js'\n";
const MATH_TEST = "import { Op, sub } from '../src'\n\ndescribe('sub', () => {\n  it('subtracts', () => {\n    expect(sub(5, 3)).toBe(2)\n  })\n  it.each([[3, 1, 2]])('sub(%i, %i)', (a, b, c) => {\n    expect(sub(a, b)).toBe(c)\n  })\n  it('names the op', () => {\n    expect(Op.Sub).toBe('sub')\n  })\n})\n";
const SNAPSHOT_TEST = "import { it, expect } from 'vitest'\n\nit('passes', () => expect(1).toBe(1))\nit('snapshots', () => expect({ a: 1 }).toMatchSnapshot())\n";
const NODE_TEST = 'import { describe, it } from "node:test";\nimport assert from "node:assert/strict";\ndescribe("node:test suite", () => {\n  it("runs in the Worker", () => assert.equal(1, 1));\n});\n';

type CertState = { results: Certification[] };

async function result(colonyId: string, sha: string): Promise<Certification | null> {
  const res = await api<Certification>("GET", `/colonies/${colonyId}/certifications/${sha}`);
  return res.status === 200 ? res.body : null;
}

async function settled(colonyId: string, sha: string, after = 0): Promise<Certification> {
  const found = await eventually(() => result(colonyId, sha), (r) => r !== null && r.status !== "running" && (r.finishedAt ?? 0) > after, 30_000);
  if (!found || found.status === "running") throw new Error(`no certification of ${sha} yet`);
  return found;
}

describe("a colony whose tests are written for vitest", () => {
  it("certifies green, counts unsupported APIs apart, goes red on a breaking landing, and honours excluded tests", async () => {
    const c = await newColony();
    await api("POST", `/colonies/${c.id}/certify/policy`, { repair: false });
    const sha1 = await externalLanding(c.id, { "vitest.config.ts": CONFIG, "src/math.ts": MATH, "src/index.ts": INDEX, "test/math.test.ts": MATH_TEST, "test/node.test.ts": NODE_TEST });
    expect(await settled(c.id, sha1)).toMatchObject({ status: "green", files: 2, counts: { tests: 4, pass: 4, fail: 0 } });

    const sha2 = await externalLanding(c.id, { "test/snap.test.ts": SNAPSHOT_TEST });
    const withSnapshot = await settled(c.id, sha2);
    expect(withSnapshot).toMatchObject({ status: "green", files: 3, counts: { tests: 6, pass: 5, fail: 0, unsupported: 1 } });
    expect(withSnapshot.unsupportedTests).toEqual([{ name: "snapshots", file: "test/snap.test.ts", api: "toMatchSnapshot" }]);

    const sha3 = await externalLanding(c.id, { "src/math.ts": MATH_BUG });
    const red = await settled(c.id, sha3);
    expect(red).toMatchObject({ status: "red", counts: { pass: 3, fail: 2, unsupported: 1 } });
    expect(red.failing!.map((f) => f.name).sort()).toEqual(["sub > sub(3, 1)", "sub > subtracts"]);
    expect(red.failing!.find((f) => f.name === "sub > subtracts")?.error).toBe("AssertionError: expected 8 to be 2 // Object.is equality (at test/math.test.ts:5)");

    // A person excludes the two tests (a known runtime difference, say): certified again, they count as unsupported.
    const policy = await api("POST", `/colonies/${c.id}/certify/policy`, { excludeTests: ["test/math.test.ts > sub > subtracts", "test/math.test.ts > sub > sub(3, 1)"] });
    expect(policy.status).toBe(200);
    expect((await api("POST", `/colonies/${c.id}/certify`)).status).toBe(202);
    const excluded = await settled(c.id, sha3, red.finishedAt);
    expect(excluded).toMatchObject({ counts: { pass: 3, fail: 0, unsupported: 3 } });
    expect(excluded.unsupportedTests!.map((u) => u.api)).toContain("excluded by the colony's certification policy");
  }, 120_000);
});

/** Land one change the way an agent does: an intent, a take, a proposal whose files hold `files`, a lane tick. */
async function landChange(colonyId: string, title: string, files: Record<string, string>): Promise<{ proposal: Proposal; intent: Intent; sha: string }> {
  const paths = Object.keys(files);
  const agent = await addAgent(colonyId, title);
  const intent = await addIntent(colonyId, paths, { title, why: `Why: ${title.toLowerCase()}.`, assignedTo: agent.id });
  const a = await take(colonyId, agent.id);
  const blobs = Object.fromEntries(paths.map((path) => [path, fakeSha()]));
  await trunk(colonyId).setContents(Object.fromEntries(paths.map((path) => [blobs[path]!, files[path]!])));
  const res = await api<Proposal>("POST", `/colonies/${colonyId}/proposals`, {
    intentId: intent.id,
    agentId: agent.id,
    workspace: a.lease.repo,
    baseSha: a.lease.baseSha,
    headSha: fakeSha(),
    writeSet: paths.map((path) => ({ path, blob: blobs[path] })),
    readSet: await trunk(colonyId).baseBlobs(a.lease.baseSha, paths),
    declared: { footprint: paths, summary: title },
  });
  expect(res.status).toBe(201);
  expect(await tick(colonyId, "src")).toBe(true);
  const landed = await proposal(colonyId, res.body.id);
  expect(landed.status).toBe("landed");
  return { proposal: landed, intent, sha: await headSha(colonyId) };
}

describe("the first red search on a vitest project (FT_BISECT)", () => {
  it("reads older commits as vite resolves imports and names the landing that broke the tests", async () => {
    const c = await newColony();
    await runInDurableObject(colony(c.id), (instance) => {
      const i = instance as unknown as { env: Record<string, unknown> };
      i.env = { ...i.env, FT_BISECT: c.id };
    });
    const green = await externalLanding(c.id, { "vitest.config.ts": CONFIG, "src/math.ts": MATH, "src/index.ts": INDEX, "test/math.test.ts": MATH_TEST });
    expect(await settled(c.id, green)).toMatchObject({ status: "green" });
    expect((await api("POST", `/colonies/${c.id}/certify/policy`, { enabled: false })).status).toBe(200);
    await landChange(c.id, "Add a note", { "src/note.ts": "export const note = 1\n" });
    const broke = await landChange(c.id, "Speed up subtraction", { "src/math.ts": MATH_BUG });
    await landChange(c.id, "Add another note", { "src/note2.ts": "export const note2 = 2\n" });
    const head = await headSha(c.id);
    expect((await api("POST", `/colonies/${c.id}/certify/policy`, { enabled: true })).status).toBe(200);
    expect(await settled(c.id, head)).toMatchObject({ status: "red", greenSha: green });
    const done = await eventually(() => result(c.id, head), (r) => r?.firstRed !== undefined, 30_000);
    expect(done?.firstRed).toMatchObject({ status: "found", trunkSha: broke.sha, landingId: broke.proposal.landingId, files: ["test/math.test.ts"] });
    const state = await api<CertState>("GET", `/colonies/${c.id}/certifications`);
    expect(state.status).toBe(200);
  }, 120_000);
});
