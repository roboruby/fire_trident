import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Certification, ColonyEvent, ColonySnapshot, FieldReading, Intent, Proposal, RedBrakeReport, StuckReport, TrunkHealth } from "@fire_trident/core";
import { CEILING_MS } from "../../../src/colony/redbrake.ts";
import { addAgent, addIntent, api, colony, eventually, externalLanding, fakeSha, headSha, newColony, proposal, region, tick, trunk } from "../helpers.ts";
import type { Assignment } from "../helpers.ts";

/**
 * The red brake (FT_RED_BRAKE, colony/redbrake.ts) inside workerd: real certification runs turn trunk red and declare
 * the repair; the brake hands the repair to the next agent that asks although another agent's claim covers its file,
 * holds a change to what the failing test loads while one outside it lands, and lets the held change go when the
 * repair makes trunk green, at the ceiling, or when the repair failed twice. With the flag off the same colony lands
 * the change on the red trunk, as before.
 */

const MATH_OK = "export function sub(a: number, b: number): number {\n  return a - b;\n}\n";
const MATH_BUG = "export function sub(a: number, b: number): number {\n  return a + b;\n}\n";
const MATH_TEST = 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { sub } from "../src/math.ts";\ntest("subtracts", () => {\n  assert.equal(sub(5, 3), 2);\n});\n';
const OTHER = "export const other = 1;\n";

type Metrics = { redBrake?: RedBrakeReport; trunkHealth?: TrunkHealth; stuck?: StuckReport };

/** Turn the red brake on for one colony, as its ColonyDO sees FT_RED_BRAKE (the harness binds none, so it is off by default). */
async function brakeOn(colonyId: string): Promise<void> {
  await runInDurableObject(colony(colonyId), (instance) => {
    const i = instance as unknown as { env: Record<string, unknown> };
    i.env = { ...i.env, FT_RED_BRAKE: colonyId };
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

async function metrics(colonyId: string): Promise<Metrics> {
  return (await api<Metrics>("GET", `/colonies/${colonyId}/metrics`)).body;
}

async function takeAny(colonyId: string, agentId: string): Promise<Assignment | { wait: true; reason: string }> {
  const res = await api<Assignment | { wait: true; reason: string }>("POST", `/colonies/${colonyId}/agents/${agentId}/take`);
  expect(res.status).toBe(200);
  return res.body;
}

/** Propose `files` (their contents in the trunk stand-in) for an assignment; `stale` reads a blob trunk never had, so the lane sends it back. */
async function proposeFiles(colonyId: string, a: Assignment, agentId: string, files: Record<string, string>, stale = false): Promise<Proposal> {
  const paths = Object.keys(files);
  const blobs = Object.fromEntries(paths.map((path) => [path, fakeSha()]));
  await trunk(colonyId).setContents(Object.fromEntries(paths.map((path) => [blobs[path]!, files[path]!])));
  const read = await trunk(colonyId).baseBlobs(a.lease.baseSha, paths);
  const res = await api<Proposal>("POST", `/colonies/${colonyId}/proposals`, {
    intentId: a.intent.id,
    agentId,
    workspace: a.lease.repo,
    baseSha: a.lease.baseSha,
    headSha: fakeSha(),
    writeSet: paths.map((path) => ({ path, blob: blobs[path] })),
    readSet: stale ? read.map((r) => ({ ...r, blob: fakeSha() })) : read,
    declared: { footprint: a.intent.footprint, summary: "edit" },
  });
  expect(res.status).toBe(201);
  return res.body;
}

/** An agent holding a new intent on `paths` (declared already claimed by it). */
async function holder(colonyId: string, name: string, paths: string[]): Promise<{ agentId: string; a: Assignment }> {
  const agent = await addAgent(colonyId, name);
  await addIntent(colonyId, paths, { title: name, assignedTo: agent.id });
  const a = (await takeAny(colonyId, agent.id)) as Assignment;
  expect(a.intent.title).toBe(name);
  return { agentId: agent.id, a };
}

async function repairOf(colonyId: string): Promise<Intent> {
  const snap = (await api<ColonySnapshot>("GET", `/colonies/${colonyId}`)).body;
  const found = snap.intents.find((i) => i.source === "certify");
  if (!found) throw new Error("no repair intent");
  return found;
}

async function brakeEvents(colonyId: string): Promise<Array<Extract<ColonyEvent, { t: "brake" }>>> {
  const page = (await api<{ events: Array<ColonyEvent & { seq?: number }> }>("GET", `/colonies/${colonyId}/events?source=recorded`)).body;
  return page.events.filter((e): e is Extract<ColonyEvent, { t: "brake" }> => e.t === "brake");
}

/** A colony whose trunk went red on src/math.ts after a green seed (the repair declared), with the brake on or off. */
async function redColony(on: boolean): Promise<{ id: string; repair: Intent }> {
  const c = await newColony();
  if (on) await brakeOn(c.id);
  const seed = await externalLanding(c.id, { "src/math.ts": MATH_OK, "src/other.ts": OTHER, "test/math.test.ts": MATH_TEST });
  expect(await settled(c.id, seed)).toMatchObject({ status: "green" });
  const broke = await externalLanding(c.id, { "src/math.ts": MATH_BUG });
  expect(await settled(c.id, broke)).toMatchObject({ status: "red" });
  const repair = await repairOf(c.id);
  expect(repair.footprint).toEqual(["src/math.ts"]);
  return { id: c.id, repair };
}

describe("the red brake (FT_RED_BRAKE)", () => {
  it("puts the repair first, holds the change to what the failing test loads, lands the rest, and lets go at green", async () => {
    const { id, repair } = await redColony(true);
    expect((await metrics(id)).redBrake?.holding).toMatchObject({ repairId: repair.id, failing: ["test/math.test.ts"], cone: 2 });

    // B changes src/math.ts (the failing test loads it): ready, but held out of its lane, and told so in its inbox.
    const b = await holder(id, "Tune subtraction", ["src/math.ts"]);
    const held = await proposeFiles(id, b.a, b.agentId, { "src/math.ts": MATH_BUG.replace("a + b", "b + a") });
    await tick(id, "src");
    expect((await proposal(id, held.id)).status).toBe("ready");
    const inbox = (await api<Array<{ reason?: string; directive?: { kind: string; message: string; by: string } }>>("GET", `/colonies/${id}/agents/${b.agentId}/inbox`)).body;
    const notice = inbox.find((d) => d.directive?.kind === "hold");
    expect(notice?.directive?.by).toBe("red brake");
    expect(notice?.directive?.message).toMatch(/^Trunk is red in files your change touches \(src\/math\.ts\): the tests that load them fail at [0-9a-f]{7}\. Your change waits for the repair/);

    // C changes src/other.ts, which no failing test loads: it lands on the red trunk as before.
    const c = await holder(id, "Tune other", ["src/other.ts"]);
    const outside = await proposeFiles(id, c.a, c.agentId, { "src/other.ts": "export const other = 2;\n" });
    await tick(id, "src");
    expect((await proposal(id, outside.id)).status).toBe("landed");

    // D asks for work: the repair, although B's claim covers its file (lateral inhibition would keep D off it).
    const d = await addAgent(id, "Repairer");
    const got = await takeAny(id, d.id);
    if ("wait" in got) throw new Error(`expected the repair, got wait: ${got.reason}`);
    expect(got.intent.id).toBe(repair.id);
    expect((got as Assignment & { model?: { model: string; cause?: string } }).model).toMatchObject({ model: "default", cause: "repair" });

    // The repair's change is never held: it lands, trunk goes green, and B's change goes on to its lane (stale now, so it comes back).
    const fix = await proposeFiles(id, got, d.id, { "src/math.ts": MATH_OK });
    await tick(id, "src");
    expect((await proposal(id, fix.id)).status).toBe("landed");
    expect(await settled(id, await headSha(id))).toMatchObject({ status: "green" });
    const events = await eventually(
      () => brakeEvents(id),
      (es) => es.some((e) => e.action === "release"),
      5_000,
    );
    expect(events.map((e) => e.action)).toEqual(["on", "hold", "reserve", "green", "release"]);
    expect(events.find((e) => e.action === "release")).toMatchObject({ proposalId: held.id, end: "green" });
    await tick(id, "src");
    const after = await proposal(id, held.id);
    expect(after.status).toBe("returned");
    expect(after.reason).toMatch(/^stale/);

    const m = await metrics(id);
    expect(m.redBrake).toMatchObject({ on: true, episodes: { count: 1, green: 1, open: 0 }, held: { changes: 1, holding: 0 }, toGreen: { episodes: 1 }, repairs: { reserved: 1, escalated: 0 } });
    expect(m.redBrake?.holding).toBeUndefined();
    if (m.trunkHealth?.status !== "measured") throw new Error("trunk health not measured");
    expect(m.trunkHealth.brake?.held.changes).toBe(1);
    expect(m.trunkHealth.detail.at(-1)).toMatch(/^Red brake: held 1 change for \d+ s in all over 1 red episode; 1 episode back to green in \d+ s at p50\.$/);
  });

  it("leaves the repair open and unreserved while its region's admission is closed, and gives it to the next ask once a slot frees", async () => {
    const { id, repair } = await redColony(true);
    const admission = async (): Promise<FieldReading["admission"]> => ((await region(id, "src").reading()) as FieldReading).admission;
    // Agents holding other files in src fill the region to its admission cap.
    const holders: Array<{ agentId: string; a: Assignment }> = [];
    for (let n = 0; n < 12 && (await admission()).open; n++) holders.push(await holder(id, `Hold ${n}`, [`src/h${n}.ts`]));
    expect(await admission()).toMatchObject({ open: false });
    const repairEvents = async (): Promise<number> =>
      (await api<{ events: ColonyEvent[] }>("GET", `/colonies/${id}/events?source=recorded`)).body.events.filter((e) => e.t === "intent" && e.intentId === repair.id).length;
    const before = await repairEvents();

    // Every ask waits on admission, and none of them reserves the repair and opens it again.
    const d = await addAgent(id, "Repairer");
    for (let n = 0; n < 5; n++) expect(await takeAny(id, d.id)).toMatchObject({ wait: true, reason: "admission closed in every candidate region" });
    expect(await repairEvents()).toBe(before);
    const snap = (await api<ColonySnapshot>("GET", `/colonies/${id}`)).body;
    expect(snap.intents.find((i) => i.id === repair.id)).toMatchObject({ status: "open" });
    expect(snap.intents.find((i) => i.id === repair.id)?.assignedTo).toBeUndefined();
    expect((await brakeEvents(id)).map((e) => e.action)).not.toContain("reserve");

    // A holder's change lands, its claims go, and the next ask takes the repair: one reservation in all.
    const h = holders[0]!;
    const done = await proposeFiles(id, h.a, h.agentId, { [h.a.intent.footprint[0]!]: "export const h = 1;\n" });
    await tick(id, "src");
    expect((await proposal(id, done.id)).status).toBe("landed");
    // The region's reading and the colony's view of it catch up within a second or so.
    const got = await eventually(
      () => takeAny(id, d.id),
      (r) => !("wait" in r),
      5_000,
    );
    if ("wait" in got) throw new Error(`expected the repair, got wait: ${got.reason}`);
    expect(got.intent.id).toBe(repair.id);
    expect((await brakeEvents(id)).filter((e) => e.action === "reserve")).toHaveLength(1);
  });

  it("is today's behavior with the flag off: the repair waits behind the claim and the change lands on red", async () => {
    const { id } = await redColony(false);
    const b = await holder(id, "Tune subtraction", ["src/math.ts"]);
    const d = await addAgent(id, "Repairer");
    expect(await takeAny(id, d.id)).toMatchObject({ wait: true, reason: "every open intent's files are claimed by another agent" });
    const change = await proposeFiles(id, b.a, b.agentId, { "src/math.ts": MATH_BUG.replace("a + b", "b + a") });
    await tick(id, "src");
    expect((await proposal(id, change.id)).status).toBe("landed");
    expect(await brakeEvents(id)).toEqual([]);
    expect((await metrics(id)).redBrake).toBeUndefined();
  });

  it("lets held changes go at the ceiling (the colony's alarm), and reports the episode as stuck work", async () => {
    const { id, repair } = await redColony(true);
    const b = await holder(id, "Tune subtraction", ["src/math.ts"]);
    const held = await proposeFiles(id, b.a, b.agentId, { "src/math.ts": MATH_BUG.replace("a + b", "b + a") });
    expect((await proposal(id, held.id)).status).toBe("ready");
    // Holding began more than the ceiling ago.
    await runInDurableObject(colony(id), (_i: unknown, state: DurableObjectState) => {
      state.storage.sql.exec("UPDATE red_brake_episodes SET holding_since = ?", Date.now() - CEILING_MS - 1_000);
    });
    await runDurableObjectAlarm(colony(id));
    const events = await eventually(
      () => brakeEvents(id),
      (es) => es.some((e) => e.action === "stop"),
      5_000,
    );
    expect(events.find((e) => e.action === "stop")).toMatchObject({ end: "ceiling", held: 1, repairId: repair.id });
    await tick(id, "src");
    expect((await proposal(id, held.id)).status).toBe("landed");
    const m = await metrics(id);
    expect(m.redBrake?.episodes).toMatchObject({ count: 1, open: 1, ceiling: 1 });
    expect(m.stuck?.items.find((i) => i.key.startsWith("brake:"))).toMatchObject({ kind: "red", action: "tests", intentId: repair.id });
  });

  it("sends the repair to a person with the failing tests after it failed twice, and lets held changes go", async () => {
    const { id, repair } = await redColony(true);
    const b = await holder(id, "Tune subtraction", ["src/math.ts"]);
    const held = await proposeFiles(id, b.a, b.agentId, { "src/math.ts": MATH_BUG.replace("a + b", "b + a") });
    const d = await addAgent(id, "Repairer");
    for (let n = 0; n < 2; n++) {
      const got = await takeAny(id, d.id);
      if ("wait" in got) throw new Error(`expected the repair, got wait: ${got.reason}`);
      expect(got.intent.id).toBe(repair.id);
      const p = await proposeFiles(id, got, d.id, { "src/math.ts": MATH_OK }, true);
      await tick(id, "src");
      expect((await proposal(id, p.id)).status).toBe("returned");
    }
    // The third ask finds the repair with a person, and nothing else open for D.
    expect(await takeAny(id, d.id)).toMatchObject({ wait: true });
    const waiting = (await api<{ intents: Intent[] }>("GET", `/colonies/${id}/escalations`)).body.intents;
    expect(waiting.map((i) => i.id)).toEqual([repair.id]);
    expect(waiting[0]?.escalation).toMatchObject({ kind: "other", by: "certify" });
    expect(waiting[0]?.escalation?.report).toMatch(/^The repair failed 2 times/);
    expect(waiting[0]?.escalation?.report).toContain("failing tests: test/math.test.ts > subtracts");
    await tick(id, "src");
    expect((await proposal(id, held.id)).status).toBe("landed");
    expect((await metrics(id)).redBrake?.repairs).toEqual({ reserved: 2, escalated: 1 });
  });
});
