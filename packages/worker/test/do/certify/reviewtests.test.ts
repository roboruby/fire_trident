import { describe, expect, it } from "vitest";
import type { Certification, FileVersion, Path, Proposal, ReviewTestsRun, Sha } from "@fire_trident/core";
import { blobId, changesetId } from "@fire_trident/core";
import { addAgent, addIntent, api, colony, eventually, externalLanding, newColony, proposal, take, tick, trunk } from "../helpers.ts";

/**
 * Tests before approval inside workerd: the real ColonyDO, its decide stage (review off here: the harness binds no Workers
 * AI, so a protected path is what sends a change to a person) and its certifier, real Dynamic Workers running the
 * colony's tests on the escalated change. The review queue leads each card with the result, a person can run it again,
 * and the approved change lands with the result in its evidence and in the person's decision its lineage note carries.
 */

const MATH_OK = "export function sub(a: number, b: number): number {\n  return a - b;\n}\n";
const MATH_BUG = "export function sub(a: number, b: number): number {\n  return a + b;\n}\n";
const MATH_TEST = 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { sub } from "../src/math.ts";\ntest("subtracts", () => {\n  assert.equal(sub(5, 3), 2);\n});\n';

type QueueItem = Proposal & { reviewTests?: ReviewTestsRun };

async function result(colonyId: string, sha: string): Promise<Certification | null> {
  const res = await api<Certification>("GET", `/colonies/${colonyId}/certifications/${sha}`);
  return res.status === 200 ? res.body : null;
}

/** A colony whose trunk holds the math module and its test, certified green, where src/math.ts needs a person. */
async function project(): Promise<{ colonyId: string; green: Sha }> {
  const c = await newColony();
  expect((await api("POST", `/colonies/${c.id}/certify/policy`, { minIntervalMs: 0, repair: false })).status).toBe(200);
  expect((await api("POST", `/colonies/${c.id}/decide/policy`, { enabled: false, protectedPaths: ["src/math.ts"] })).status).toBe(200);
  const green = await externalLanding(c.id, { "src/math.ts": MATH_OK, "test/math.test.ts": MATH_TEST });
  const cert = await eventually(() => result(c.id, green), (r) => r !== null && r.status !== "running", 30_000);
  expect(cert).toMatchObject({ status: "green" });
  return { colonyId: c.id, green };
}

/** An agent takes a new intent on src/math.ts and proposes `text` for it as an inline change. */
async function proposeMath(colonyId: string, title: string, text: string): Promise<Proposal> {
  const agent = await addAgent(colonyId, title);
  const intent = await addIntent(colonyId, ["src/math.ts"], { title, why: `Why: ${title.toLowerCase()}.`, assignedTo: agent.id });
  const a = await take(colonyId, agent.id);
  const blob = blobId(text);
  const writeSet: FileVersion[] = [{ path: "src/math.ts", blob }];
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

/** The review queue's card for a proposal once its run has ended, other than the run `not` (a run asked for again). */
async function card(colonyId: string, id: string, not?: string): Promise<QueueItem> {
  const read = async (): Promise<QueueItem | undefined> => ((await api<QueueItem[]>("GET", `/colonies/${colonyId}/review`)).body ?? []).find((p) => p.id === id);
  const found = await eventually(read, (p) => !!p?.reviewTests && (p.reviewTests.status === "ran" || p.reviewTests.status === "notrun") && p.reviewTests.id !== not, 30_000);
  if (!found?.reviewTests || found.reviewTests.id === not) throw new Error(`no test result on ${id}'s card yet: ${JSON.stringify(found?.reviewTests)}`);
  return found;
}

describe("tests before approval", () => {
  it("leads an escalated change's card with its tests, runs them again on request, and the approved change carries them", async () => {
    const { colonyId, green } = await project();
    const p = await proposeMath(colonyId, "Speed up subtraction", MATH_BUG);
    const escalated = await eventually(() => proposal(colonyId, p.id), (x) => x.status !== "checking", 20_000);
    expect(escalated.status).toBe("escalated");

    // The card leads with the result: the colony's test ran on the change at its base, and passes on trunk.
    const first = await card(colonyId, p.id);
    expect(first.reviewTests).toMatchObject({
      status: "ran",
      by: "escalation",
      baseSha: green,
      tests: 1,
      passed: 0,
      failed: 1,
      onTrunk: { passes: 1 },
      trunk: { sha: green, status: "green", tests: 1, passed: 1, failing: 0 },
      failing: [{ file: "test/math.test.ts", name: "subtracts", onTrunk: "passes", error: expect.stringMatching(/actual 8, expected 2/) }],
      text: 'Tests on this change: 0/1 passed, 1 failed ("subtracts"). 1 failing here that passes on trunk.',
    });
    // The proposal records it.
    expect((await proposal(colonyId, p.id)).evidence.reviewTests).toMatchObject({ id: first.reviewTests!.id, status: "ran" });

    // Run again: the admin token is needed; the run replaces the result.
    expect((await api("POST", `/colonies/${colonyId}/proposals/${p.id}/tests`, { by: "matt" }, {})).status).toBe(401);
    const again = await api<{ started: boolean; run: ReviewTestsRun }>("POST", `/colonies/${colonyId}/proposals/${p.id}/tests`, { by: "matt" });
    expect(again.status).toBe(202);
    expect(again.body).toMatchObject({ started: true, run: { by: "matt", status: expect.stringMatching(/^(queued|running)$/) } });
    const second = await card(colonyId, p.id, first.reviewTests!.id);
    expect(second.reviewTests).toMatchObject({ status: "ran", by: "matt", failed: 1, onTrunk: { passes: 1 } });
    expect((await api("POST", `/colonies/${colonyId}/proposals/prp_nope/tests`, {})).status).toBe(404);

    // Approved: it lands with the result in its evidence, and the person's decision in its lineage context carries it.
    expect((await api("POST", `/colonies/${colonyId}/review/${p.id}`, { decision: "approve", reason: "the test is wrong, not the code", by: "matt" })).status).toBe(200);
    expect((await api("POST", `/colonies/${colonyId}/proposals/${p.id}/tests`, {})).status).toBe(409);
    const ctx = await colony(colonyId).landContext([p.intentId], [p.agentId], [p.id]);
    expect(ctx.decisions[p.id]?.find((d) => d.layer === "human")?.answer).toBe(
      "approve (tests before approval: 0/1 passed, 1 failed, 1 failing here that passes on trunk): the test is wrong, not the code",
    );
    expect(await tick(colonyId, "src")).toBe(true);
    const landed = await proposal(colonyId, p.id);
    expect(landed.status).toBe("landed");
    expect(landed.evidence.reviewTests).toMatchObject({ status: "ran", by: "matt", failed: 1 });
  }, 120_000);
});
