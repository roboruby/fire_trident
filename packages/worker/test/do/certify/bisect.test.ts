import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Certification, ColonyEvent, ColonySnapshot, Intent, Proposal } from "@fire_trident/core";
import { addAgent, addIntent, api, colony, eventually, externalLanding, fakeSha, headSha, newColony, proposal, take, tick, trunk } from "../helpers.ts";

/**
 * The first red search (FT_BISECT) inside workerd: the real ColonyDO and its certifier, the trunk stand-in's landing
 * log and commits, and real Dynamic Workers running only the failing test file on the commits it tries. Six landings
 * after a green certification, the fourth breaking a test: the red result names that landing and its proposal.
 */

const MATH_OK = "export function sub(a: number, b: number): number {\n  return a - b;\n}\n";
const MATH_BUG = "export function sub(a: number, b: number): number {\n  return a + b;\n}\n";
const MATH_TEST = 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { sub } from "../src/math.ts";\ntest("subtracts", () => {\n  assert.equal(sub(5, 3), 2);\n});\n';

type CertState = { results: Certification[] };

/** Turn the first red search on for one colony as its ColonyDO sees FT_BISECT (the harness binds none, so it is off by default). */
async function bisectOn(colonyId: string): Promise<void> {
  await runInDurableObject(colony(colonyId), (instance) => {
    const i = instance as unknown as { env: Record<string, unknown> };
    i.env = { ...i.env, FT_BISECT: colonyId };
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

/** Hold certification (landings then run nothing) or let it run again (it certifies the current trunk at once). */
async function certifying(colonyId: string, enabled: boolean): Promise<void> {
  expect((await api("POST", `/colonies/${colonyId}/certify/policy`, { enabled })).status).toBe(200);
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

async function events(colonyId: string): Promise<ColonyEvent[]> {
  return (await api<{ events: ColonyEvent[] }>("GET", `/colonies/${colonyId}/events?source=recorded&limit=5000`)).body.events;
}

async function repairs(colonyId: string): Promise<Intent[]> {
  const snap = (await api<ColonySnapshot>("GET", `/colonies/${colonyId}`)).body;
  return snap.intents.filter((i) => i.source === "certify");
}

describe("the first red search (FT_BISECT)", () => {
  it("names the landing that broke the failing tests and its proposal, on the result, in an event and in the repair intent", async () => {
    const c = await newColony();
    await bisectOn(c.id);
    const green = await externalLanding(c.id, { "src/math.ts": MATH_OK, "test/math.test.ts": MATH_TEST });
    expect(await settled(c.id, green)).toMatchObject({ status: "green" });

    // Six landings while certification waits: three good, the one that breaks sub(), two good.
    await certifying(c.id, false);
    for (let i = 1; i <= 3; i++) await landChange(c.id, `Add note ${i}`, { [`src/note${i}.ts`]: `export const note${i} = ${i};\n` });
    const broke = await landChange(c.id, "Speed up subtraction", { "src/math.ts": MATH_BUG });
    for (let i = 4; i <= 5; i++) await landChange(c.id, `Add note ${i}`, { [`src/note${i}.ts`]: `export const note${i} = ${i};\n` });
    const head = await headSha(c.id);
    await certifying(c.id, true);

    const red = await settled(c.id, head);
    expect(red).toMatchObject({ status: "red", greenSha: green });
    const done = await eventually(() => result(c.id, head), (r) => r?.firstRed !== undefined, 30_000);
    expect(done?.firstRed).toEqual({
      status: "found",
      trunkSha: broke.sha,
      landingId: broke.proposal.landingId,
      intents: [{ id: broke.intent.id, title: "Speed up subtraction" }],
      proposals: [{ id: broke.proposal.id, intentId: broke.intent.id, title: "Speed up subtraction", paths: ["src/math.ts"] }],
      files: ["test/math.test.ts"],
      probes: expect.any(Number),
      ms: expect.any(Number),
      landings: 6,
      greenSha: green,
    });
    expect(done!.firstRed!.probes).toBeLessThanOrEqual(4);
    // The snapshot's latest result carries it too (the web card shows it from there).
    const snap = (await api<ColonySnapshot>("GET", `/colonies/${c.id}`)).body;
    expect(snap.colony.certification?.firstRed?.landingId).toBe(broke.proposal.landingId);

    // The record says so after the red result.
    const recorded = await eventually(() => events(c.id), (list) => list.some((e) => e.t === "bisect"), 5_000);
    const redAt = recorded.findIndex((e) => e.t === "certify" && e.trunkSha === head && e.status === "red");
    const bisectAt = recorded.findIndex((e) => e.t === "bisect");
    expect(redAt).toBeGreaterThanOrEqual(0);
    expect(bisectAt).toBeGreaterThan(redAt);
    expect(recorded[bisectAt]).toMatchObject({ t: "bisect", trunkSha: head, firstRed: { status: "found", landingId: broke.proposal.landingId } });

    // The repair intent the red result declared names the proposal, fenced as data.
    const declared = await repairs(c.id);
    expect(declared).toHaveLength(1);
    expect(declared[0]!.why).toContain(`First failing commit: the failing tests first failed at commit ${broke.sha.slice(0, 7)} (landing ${broke.proposal.landingId})`);
    expect(declared[0]!.why).toMatch(new RegExp(`\\n<<<FIRST RED ([0-9a-f]{12})>>>\\n- proposal ${broke.proposal.id} for intent ${broke.intent.id} "Speed up subtraction" changed src/math\\.ts\\n<<<END FIRST RED \\1>>>\\n`));
  }, 120_000);

  it("is off unless FT_BISECT names the colony: the red result never gains firstRed", async () => {
    const c = await newColony();
    const green = await externalLanding(c.id, { "src/math.ts": MATH_OK, "test/math.test.ts": MATH_TEST });
    expect(await settled(c.id, green)).toMatchObject({ status: "green" });
    await certifying(c.id, false);
    await landChange(c.id, "Speed up subtraction", { "src/math.ts": MATH_BUG });
    await landChange(c.id, "Add a note", { "src/note.ts": "export const note = 1;\n" });
    const head = await headSha(c.id);
    await certifying(c.id, true);
    expect(await settled(c.id, head)).toMatchObject({ status: "red", greenSha: green });
    await new Promise((r) => setTimeout(r, 1_500));
    expect((await result(c.id, head))?.firstRed).toBeUndefined();
    expect((await events(c.id)).some((e) => e.t === "bisect")).toBe(false);
    expect((await repairs(c.id))[0]!.why).not.toContain("First failing commit");
  }, 120_000);
});
