import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Certification, GuideLesson, GuideTake, LessonReceipt, Proposal } from "@fire_trident/core";
import { addAgent, addIntent, api, colony, eventually, externalLanding, fakeSha, headSha, newColony, proposal, take, tick, trunk, type Assignment } from "../helpers.ts";

/**
 * The field guide's gate with real certification (FT_FIELD_GUIDE, FT_TRUNK_TESTS, Dynamic Workers): a lesson left with a
 * change becomes active when the first certification of trunk at or after its landing is green, and the next take
 * carries it; a lesson left with a change that breaks the tests is dropped when the red run names that change.
 */

const MATH_OK = "export function sub(a: number, b: number): number {\n  return a - b;\n}\n";
const MATH_BUG = "export function sub(a: number, b: number): number {\n  return a + b;\n}\n";
const MATH_TEST = 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { sub } from "../src/math.ts";\ntest("subtracts", () => {\n  assert.equal(sub(5, 3), 2);\n});\n';

type GuideView = { on: boolean; gate: string; active: Array<Record<string, unknown>>; candidates?: GuideLesson[]; ended?: GuideLesson[] };

/** Turn the field guide and culprit finding on for one colony as its ColonyDO sees them (the harness binds neither). */
async function guideOn(colonyId: string): Promise<void> {
  await runInDurableObject(colony(colonyId), (instance) => {
    const i = instance as unknown as { env: Record<string, unknown> };
    i.env = { ...i.env, FT_FIELD_GUIDE: colonyId, FT_CULPRITS: colonyId };
  });
}

async function settled(colonyId: string, sha: string): Promise<Certification> {
  const state = await eventually(
    async () => (await api<{ results: Certification[] }>("GET", `/colonies/${colonyId}/certifications`)).body,
    (s) => s.results.some((r) => r.trunkSha === sha && r.status !== "running"),
    30_000,
  );
  const found = state.results.find((r) => r.trunkSha === sha);
  if (!found || found.status === "running") throw new Error(`no certification of ${sha} yet`);
  return found;
}

/** Land one change through the src lane with a lesson: an intent, a take, a proposal whose files hold `files`, a lane tick. */
async function landWithLesson(colonyId: string, title: string, files: Record<string, string>, lesson: string): Promise<{ proposal: Proposal; receipt: LessonReceipt; sha: string }> {
  const paths = Object.keys(files);
  const agent = await addAgent(colonyId, title);
  const intent = await addIntent(colonyId, paths, { title, why: `Why: ${title.toLowerCase()}.`, assignedTo: agent.id });
  const a = await take(colonyId, agent.id);
  const blobs = Object.fromEntries(paths.map((path) => [path, fakeSha()]));
  await trunk(colonyId).setContents(Object.fromEntries(paths.map((path) => [blobs[path]!, files[path]!])));
  const res = await api<Proposal & { lesson: LessonReceipt }>("POST", `/colonies/${colonyId}/proposals`, {
    intentId: intent.id,
    agentId: agent.id,
    workspace: a.lease.repo,
    baseSha: a.lease.baseSha,
    headSha: fakeSha(),
    writeSet: paths.map((path) => ({ path, blob: blobs[path] })),
    readSet: await trunk(colonyId).baseBlobs(a.lease.baseSha, paths),
    declared: { footprint: paths, summary: title },
    lesson,
  });
  expect(res.status).toBe(201);
  expect(res.body.lesson.status).toBe("candidate");
  expect(await tick(colonyId, "src")).toBe(true);
  const landed = await proposal(colonyId, res.body.id);
  expect(landed.status).toBe("landed");
  return { proposal: landed, receipt: res.body.lesson, sha: await headSha(colonyId) };
}

async function guide(colonyId: string): Promise<GuideView> {
  return (await api<GuideView>("GET", `/colonies/${colonyId}/guide`)).body;
}

describe("the field guide's gate with trunk certification", () => {
  it("activates a lesson on the first green run after its landing, drops one a red run names, and a take carries the active one", async () => {
    const c = await newColony();
    await guideOn(c.id);
    const sha1 = await externalLanding(c.id, { "src/math.ts": MATH_OK, "test/math.test.ts": MATH_TEST });
    expect(await settled(c.id, sha1)).toMatchObject({ status: "green" });

    // A change that keeps the tests green: its lesson joins the guide.
    const good = await landWithLesson(c.id, "Document subtraction", { "src/README.md": "# math\n" }, "src/math.ts is tested by test/math.test.ts with node:test.");
    expect(good.receipt.note).toContain("once your change lands and the first certification of trunk after it is green");
    expect(await settled(c.id, good.sha)).toMatchObject({ status: "green" });
    const active = await eventually(() => guide(c.id), (g) => g.active.length === 1);
    expect(active.gate).toBe("certification");
    expect(active.active[0]).toMatchObject({ id: good.receipt.lessonId, landingId: good.proposal.landingId, activatedBy: "certification", author: "synthetic" });

    // A change that breaks them: the red run names it, and its lesson is dropped.
    const bad = await landWithLesson(c.id, "Speed up subtraction", { "src/math.ts": MATH_BUG }, "sub() can add instead: nobody calls it with negatives.");
    const red = await settled(c.id, bad.sha);
    expect(red.status).toBe("red");
    expect(red.suspects?.map((s) => s.proposalId)).toEqual([bad.proposal.id]);
    const after = await eventually(() => guide(c.id), (g) => (g.ended ?? []).some((l) => l.id === bad.receipt.lessonId));
    expect(after.ended?.find((l) => l.id === bad.receipt.lessonId)).toMatchObject({ status: "dropped", endReason: `a red certification of ${bad.sha.slice(0, 7)} names its change as a suspect` });
    expect(after.active.map((e) => e.id)).toEqual([good.receipt.lessonId]);

    // The next agent's take carries the active lesson, with its provenance.
    const next = await addAgent(c.id, "next");
    await addIntent(c.id, ["docs/guide.md"], { assignedTo: next.id });
    const t = (await take(c.id, next.id)) as Assignment & { guide?: GuideTake };
    expect(t.guide?.lessons.map((e) => e.text)).toEqual(["src/math.ts is tested by test/math.test.ts with node:test."]);
  });
});
