import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Certification, FileVersion, Path, Proposal, Sha } from "@fire_trident/core";
import { blobId, changesetId } from "@fire_trident/core";
import { addAgent, addIntent, api, colony, eventually, externalLanding, headSha, newColony, proposal, take, tick, trunk } from "../helpers.ts";

/**
 * Tests before landing (FT_PRELAND) inside workerd: the real ColonyDO, its decide stage (review off here: the harness
 * binds no Workers AI) and its certifier, real Dynamic Workers running the test file a change reaches. Where the flag
 * covers the colony, a change that breaks a test that passed on trunk comes back before landing, naming the test, and
 * the fixed change lands with the run in its evidence; where it does not, the breaking change lands and certification
 * goes red after landing.
 */

const MATH_OK = "export function sub(a: number, b: number): number {\n  return a - b;\n}\n";
const MATH_BUG = "export function sub(a: number, b: number): number {\n  return a + b;\n}\n";
const MATH_FIXED = "export function sub(a: number, b: number): number {\n  // Subtraction, as the test asks.\n  return a - b;\n}\n";
const MATH_TEST = 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { sub } from "../src/math.ts";\ntest("subtracts", () => {\n  assert.equal(sub(5, 3), 2);\n});\n';

/** Turn tests before landing on for one colony as its ColonyDO sees FT_PRELAND (the harness binds none, so it is off by default). */
async function prelandOn(colonyId: string): Promise<void> {
  await runInDurableObject(colony(colonyId), (instance) => {
    const i = instance as unknown as { env: Record<string, unknown> };
    i.env = { ...i.env, FT_PRELAND: `other,${colonyId}` };
  });
}

async function result(colonyId: string, sha: string): Promise<Certification | null> {
  const res = await api<Certification>("GET", `/colonies/${colonyId}/certifications/${sha}`);
  return res.status === 200 ? res.body : null;
}

async function settled(colonyId: string, sha: string): Promise<Certification> {
  const found = await eventually(() => result(colonyId, sha), (r) => r !== null && r.status !== "running", 30_000);
  if (!found || found.status === "running") throw new Error(`no certification of ${sha} yet`);
  return found;
}

/** A colony whose trunk holds the math module and its test, certified green, certifying at once after each landing. */
async function project(preland: boolean): Promise<{ colonyId: string; green: Sha }> {
  const c = await newColony();
  if (preland) await prelandOn(c.id);
  expect((await api("POST", `/colonies/${c.id}/certify/policy`, { minIntervalMs: 0, repair: false })).status).toBe(200);
  const green = await externalLanding(c.id, { "src/math.ts": MATH_OK, "test/math.test.ts": MATH_TEST });
  expect(await settled(c.id, green)).toMatchObject({ status: "green" });
  return { colonyId: c.id, green };
}

/** An agent takes a new intent on src/math.ts and proposes `text` for it as an inline change (the file itself, no git). */
async function proposeMath(colonyId: string, title: string, text: string): Promise<Proposal> {
  const agent = await addAgent(colonyId, title);
  const intent = await addIntent(colonyId, ["src/math.ts"], { title, why: `Why: ${title.toLowerCase()}.`, assignedTo: agent.id });
  const a = await take(colonyId, agent.id);
  const blob = blobId(text);
  const writeSet: FileVersion[] = [{ path: "src/math.ts", blob }];
  // The trunk stand-in lands a blob with the text set for it (the real trunk writer fetches inline contents from the colony).
  await trunk(colonyId).setContents({ [blob]: text });
  return colony(colonyId).propose({
    colonyId,
    intentId: intent.id,
    agentId: agent.id,
    workspace: a.lease.repo,
    baseSha: a.lease.baseSha,
    headSha: changesetId(a.lease.baseSha, writeSet),
    writeSet,
    readSet: await trunk(colonyId).baseBlobs(a.lease.baseSha, ["src/math.ts"] as Path[]),
    declared: { footprint: ["src/math.ts"], summary: title },
    evidence: { checks: [], notVerified: "Not verified: the colony's tests decide." },
    contents: { [blob]: text },
  });
}

/** An agent takes a new intent (declared by a person through the API) on `files` and proposes them inline (null deletes a file). */
async function proposeFiles(colonyId: string, title: string, files: Record<Path, string | null>, why = `Why: ${title.toLowerCase()}.`): Promise<Proposal> {
  const paths = Object.keys(files) as Path[];
  const agent = await addAgent(colonyId, title);
  const intent = await addIntent(colonyId, paths, { title, why, assignedTo: agent.id });
  const a = await take(colonyId, agent.id);
  const writeSet: FileVersion[] = paths.map((path) => ({ path, blob: files[path] === null ? null : blobId(files[path]!) }));
  const contents = Object.fromEntries(paths.filter((p) => files[p] !== null).map((p) => [blobId(files[p]!), files[p]!]));
  await trunk(colonyId).setContents(contents);
  return colony(colonyId).propose({
    colonyId,
    intentId: intent.id,
    agentId: agent.id,
    workspace: a.lease.repo,
    baseSha: a.lease.baseSha,
    headSha: changesetId(a.lease.baseSha, writeSet),
    writeSet,
    readSet: await trunk(colonyId).baseBlobs(a.lease.baseSha, paths),
    declared: { footprint: paths, summary: title },
    evidence: { checks: [], notVerified: "Not verified: the colony's tests decide." },
    contents,
  });
}

/** The proposal once its decide stage has settled it (it leaves "checking"). */
async function decided(colonyId: string, id: string): Promise<Proposal> {
  return eventually(() => proposal(colonyId, id), (p) => p.status !== "checking", 20_000);
}

describe("tests before landing (FT_PRELAND)", () => {
  it("sends back a change that breaks a test that passed on trunk, naming it, and lands the fixed one with the run", async () => {
    const { colonyId, green } = await project(true);

    const bad = await proposeMath(colonyId, "Speed up subtraction", MATH_BUG);
    // With review off it still takes the decide path, where its tests run.
    expect(bad.status).toBe("checking");
    const back = await decided(colonyId, bad.id);
    expect(back.status).toBe("returned");
    expect(back.reason).toMatch(/^Tests before landing: the test "subtracts" in test\/math\.test\.ts passed on trunk and fails with this change: .*actual 8, expected 2/);
    expect(back.evidence.preland).toMatchObject({ status: "failed", trunkSha: green, files: ["test/math.test.ts"], tests: 1, passed: 0, failed: 1, broke: [{ file: "test/math.test.ts", name: "subtracts" }] });
    expect(back.evidence.checks).toContainEqual(expect.objectContaining({ name: "tests before landing", ok: false }));
    // Nothing landed: trunk is still the green commit.
    expect(await headSha(colonyId)).toBe(green);

    const fixed = await proposeMath(colonyId, "Document subtraction", MATH_FIXED);
    const ready = await decided(colonyId, fixed.id);
    expect(ready.status).toBe("ready");
    expect(ready.evidence.preland).toMatchObject({ status: "passed", trunkSha: green, files: ["test/math.test.ts"], tests: 1, passed: 1, failed: 0 });
    expect(await tick(colonyId, "src")).toBe(true);
    const landed = await proposal(colonyId, fixed.id);
    expect(landed.status).toBe("landed");
    // The lineage note is written from the landed proposal's evidence: the run goes with it.
    expect(landed.evidence.preland?.status).toBe("passed");
    expect(landed.evidence.checks.find((c) => c.name === "tests before landing")?.detail).toBe("1 test file that reach the change ran on its base with it: 1 of 1 test passed");
    expect(await settled(colonyId, await headSha(colonyId))).toMatchObject({ status: "green" });

    // Counted per outcome.
    const metrics = (await api<{ counters?: Record<string, number> }>("GET", `/colonies/${colonyId}/metrics`)).body;
    expect(JSON.stringify(metrics)).toMatch(/"preland\.failed":1/);
  }, 120_000);

  it("sends back a change whose own new test fails, and one deleting a passing test file unless the person's intent names it", async () => {
    const { colonyId, green } = await project(true);
    const failing = 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { sub } from "../src/math.ts";\ntest("subtracts negatives", () => {\n  assert.equal(sub(-1, -1), 1);\n});\n';
    const added = await decided(colonyId, (await proposeFiles(colonyId, "Cover negatives", { "test/neg.test.ts": failing })).id);
    expect(added.status).toBe("returned");
    expect(added.reason).toMatch(/^Tests before landing: the test "subtracts negatives" in test\/neg\.test\.ts, a test file this change adds or edits, fails with it: .*A change cannot land tests its own code fails/);
    expect(added.evidence.preland).toMatchObject({ status: "failed", files: ["test/neg.test.ts"], broke: [{ file: "test/neg.test.ts", name: "subtracts negatives", kind: "own" }] });

    // The intent a person declared does not name the file: the deletion goes back.
    const tidy = await decided(colonyId, (await proposeFiles(colonyId, "Tidy the tests", { "test/math.test.ts": null })).id);
    expect(tidy.status).toBe("returned");
    expect(tidy.reason).toBe(
      "Tests before landing: this change deletes the test file test/math.test.ts, whose tests passed on trunk. Keep that file (a passing test file is deleted only when the intent a person declared names its path), then propose again.",
    );
    expect(await headSha(colonyId)).toBe(green);
    // It names the file: the deletion is the person's, and it lands.
    const asked = await decided(colonyId, (await proposeFiles(colonyId, "Retire the subtraction tests", { "test/math.test.ts": null }, "Delete test/math.test.ts: subtraction moves to another package.")).id);
    expect(asked.status).toBe("ready");
    expect(asked.evidence.preland?.status).toBe("unchecked");
    // The "test" lane is not held by the harness: its own alarm may land it first.
    await tick(colonyId, "test");
    expect((await eventually(() => proposal(colonyId, asked.id), (p) => p.status === "landed", 10_000)).status).toBe("landed");
  }, 120_000);

  it("is off unless FT_PRELAND names the colony: the breaking change lands and certification goes red after landing", async () => {
    const { colonyId } = await project(false);
    const bad = await proposeMath(colonyId, "Speed up subtraction", MATH_BUG);
    expect(bad.status).toBe("ready");
    expect(bad.evidence.preland).toBeUndefined();
    expect(await tick(colonyId, "src")).toBe(true);
    const landed = await proposal(colonyId, bad.id);
    expect(landed.status).toBe("landed");
    expect(landed.evidence.checks.some((c) => c.name === "tests before landing")).toBe(false);
    const red = await settled(colonyId, await headSha(colonyId));
    expect(red).toMatchObject({ status: "red", failing: [{ file: "test/math.test.ts", name: "subtracts" }] });
  }, 120_000);
});
