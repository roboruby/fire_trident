import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Certification, ColonySnapshot, Intent, Proposal } from "@fire_trident/core";
import { addAgent, addIntent, api, colony, eventually, externalLanding, fakeSha, headSha, newColony, proposal, take, tick, trunk } from "../helpers.ts";

/**
 * Culprit finding inside workerd: the real ColonyDO and its per-path landing index, the trunk
 * stand-in's commits (baseBlobs), and real Dynamic Workers running the colony's tests. A red run
 * names the proposal that broke the tests, on the result and in the repair intent.
 */

const MATH_OK = "export function sub(a: number, b: number): number {\n  return a - b;\n}\n";
const MATH_BUG = "export function sub(a: number, b: number): number {\n  return a + b;\n}\n";
const MATH_TEST = 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { sub } from "../src/math.ts";\ntest("subtracts", () => {\n  assert.equal(sub(5, 3), 2);\n});\n';

type CertState = { results: Certification[] };

/** Turn culprit finding on for one colony as its ColonyDO sees FT_CULPRITS (the harness binds none, so it is off by default). */
async function culpritsOn(colonyId: string): Promise<void> {
  await runInDurableObject(colony(colonyId), (instance) => {
    const i = instance as unknown as { env: Record<string, unknown> };
    i.env = { ...i.env, FT_CULPRITS: colonyId };
  });
}

async function settled(colonyId: string, sha: string): Promise<Certification> {
  const state = await eventually(
    async () => (await api<CertState>("GET", `/colonies/${colonyId}/certifications`)).body,
    (s) => s.results.some((r) => r.trunkSha === sha && r.status !== "running"),
    30_000,
  );
  const found = state.results.find((r) => r.trunkSha === sha);
  if (!found || found.status === "running") throw new Error(`no certification of ${sha} yet`);
  return found;
}

/** Land one change in the src lane the way an agent does: an intent, a take, a proposal whose files hold `files`, a lane tick. */
async function landChange(colonyId: string, title: string, files: Record<string, string>): Promise<{ intent: Intent; proposal: Proposal; sha: string }> {
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
  return { intent, proposal: landed, sha: await headSha(colonyId) };
}

async function repairs(colonyId: string): Promise<Intent[]> {
  const snap = (await api<ColonySnapshot>("GET", `/colonies/${colonyId}`)).body;
  return snap.intents.filter((i) => i.source === "certify");
}

describe("culprit finding (FT_CULPRITS)", () => {
  it("names the proposal that changed what a failing test loads since green, with its intent, on the result and in the repair intent", async () => {
    const c = await newColony();
    await culpritsOn(c.id);
    const sha1 = await externalLanding(c.id, { "src/math.ts": MATH_OK, "test/math.test.ts": MATH_TEST });
    expect(await settled(c.id, sha1)).toMatchObject({ status: "green" });

    const broke = await landChange(c.id, "Speed up subtraction", { "src/math.ts": MATH_BUG });
    const red = await settled(c.id, broke.sha);
    expect(red).toMatchObject({ status: "red", greenSha: sha1 });
    expect(red.suspects).toEqual([
      {
        landingId: broke.proposal.landingId,
        trunkSha: broke.sha,
        proposalId: broke.proposal.id,
        intentId: broke.intent.id,
        title: "Speed up subtraction",
        paths: ["src/math.ts"],
        files: ["test/math.test.ts"],
        at: expect.any(Number),
        // The only landing since green: the first since then, and the latest.
        labels: ["first-since-green", "latest"],
      },
    ]);
    // The snapshot's latest result carries them too (the web card shows them from there).
    const snap = (await api<ColonySnapshot>("GET", `/colonies/${c.id}`)).body;
    expect(snap.colony.certification?.suspects?.[0]?.proposalId).toBe(broke.proposal.id);

    // The repair intent names the suspect as fenced data: the proposal, its intent and why, the file it changed.
    const declared = await repairs(c.id);
    expect(declared).toHaveLength(1);
    expect(declared[0]!.footprint).toEqual(["src/math.ts"]);
    expect(declared[0]!.why).toContain(
      `- [first since green, latest] proposal ${broke.proposal.id} (landing ${broke.proposal.landingId}, commit ${broke.sha.slice(0, 7)}) for intent ${broke.intent.id} "Speed up subtraction" changed src/math.ts; a suspect for test/math.test.ts. Why it was written: Why: speed up subtraction.`,
    );
    expect(declared[0]!.why).toMatch(/\n<<<SUSPECTS ([0-9a-f]{12})>>>\n- \[first since green, latest\] proposal [^\n]+\n<<<END SUSPECTS \1>>>\n/);

    // A landing that changes nothing the tests load is never a suspect: the next red run names the same one.
    const docs = await landChange(c.id, "Document subtraction", { "src/README.md": "# math\n" });
    const again = await settled(c.id, docs.sha);
    expect(again.status).toBe("red");
    expect(again.suspects?.map((s) => s.proposalId)).toEqual([broke.proposal.id]);
  });

  it("keeps the first landing since green beside the newest two when five changed what the failing test loads", async () => {
    const c = await newColony();
    await culpritsOn(c.id);
    const sha1 = await externalLanding(c.id, { "src/math.ts": MATH_OK, "test/math.test.ts": MATH_TEST });
    expect(await settled(c.id, sha1)).toMatchObject({ status: "green" });
    // The first breaks the test; the four after it land on a red trunk. The colony's path index keeps only the newest three.
    const broke = await landChange(c.id, "Speed up subtraction", { "src/math.ts": MATH_BUG });
    const later: Array<Awaited<ReturnType<typeof landChange>>> = [];
    for (let i = 2; i <= 5; i++) later.push(await landChange(c.id, `Tidy subtraction ${i}`, { "src/math.ts": `${MATH_BUG}// pass ${i}\n` }));
    const head = later.at(-1)!;
    const red = await settled(c.id, head.sha);
    expect(red.status).toBe("red");
    expect(red.suspects?.map((s) => [s.proposalId, s.labels])).toEqual([
      [later[3]!.proposal.id, ["latest"]],
      [later[2]!.proposal.id, ["latest"]],
      [broke.proposal.id, ["first-since-green"]],
    ]);
    expect(red.suspects?.[2]).toMatchObject({ landingId: broke.proposal.landingId, intentId: broke.intent.id, title: "Speed up subtraction", paths: ["src/math.ts"], files: ["test/math.test.ts"] });
  });

  it("is off unless FT_CULPRITS names the colony", async () => {
    const c = await newColony();
    const sha1 = await externalLanding(c.id, { "src/math.ts": MATH_OK, "test/math.test.ts": MATH_TEST });
    expect(await settled(c.id, sha1)).toMatchObject({ status: "green" });
    const broke = await landChange(c.id, "Speed up subtraction", { "src/math.ts": MATH_BUG });
    const red = await settled(c.id, broke.sha);
    expect(red.status).toBe("red");
    expect(red.suspects).toBeUndefined();
    const declared = await repairs(c.id);
    expect(declared[0]!.why).not.toContain("SUSPECTS");
  });
});
