import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { AgentInfo, Intent, Proposal, ToldOf } from "@fire_trident/core";
import type { HeadsUpAnswer } from "../../src/colony/headsup.ts";
import type { Assignment } from "./helpers.ts";
import { addIntent, api, colony, eventually, fakeSha, newColony, proposal, proposeEdit, take, tick, trunk } from "./helpers.ts";

/**
 * Heads-up (FT_HEADS_UP) in a real colony: what moved under an agent's files since its lease base and what waits to land
 * on them; the hook's read-only route with its auth; and, when the agent's change goes back, whether it had been told of
 * the landing that beat it, in its reason, on the proposal and in /metrics.
 */

const F = "src/lib/util.ts";

async function agent(colonyId: string, name: string): Promise<AgentInfo> {
  const res = await api<AgentInfo>("POST", `/colonies/${colonyId}/agents`, { name, kind: "synthetic", model: `model-${name}` });
  expect(res.status).toBe(201);
  return res.body;
}

/** Turn FT_HEADS_UP on as the colony sees it (the harness binds none). */
async function headsUpOn(colonyId: string): Promise<void> {
  await runInDurableObject(colony(colonyId), (instance) => {
    const i = instance as unknown as { env: Record<string, unknown> };
    i.env = { ...i.env, FT_HEADS_UP: "on" };
  });
}

/** Two agents hold intents on F from the same trunk; A's change waits in the lane. */
async function race(colonyId: string): Promise<{ a: AgentInfo; b: AgentInfo; ia: Intent; tb: Assignment; pa: Proposal }> {
  const [a, b] = [await agent(colonyId, "a"), await agent(colonyId, "b")];
  const ia = await addIntent(colonyId, [F], { title: "Cache lookups", why: "Lookups repeat.", assignedTo: a.id });
  await addIntent(colonyId, [F], { title: "Rename the flag", why: "The old name misleads.", assignedTo: b.id });
  const ta = await take(colonyId, a.id);
  const tb = await take(colonyId, b.id);
  const pa = await proposeEdit(colonyId, ta, a.id);
  expect(pa.status).toBe("ready");
  return { a, b, ia, tb, pa };
}

/** B proposes its change built on its lease base, carrying what its MCP session told it. */
async function proposeB(colonyId: string, b: AgentInfo, tb: Assignment, toldOf: ToldOf): Promise<Proposal> {
  const readSet = await trunk(colonyId).baseBlobs(tb.lease.baseSha, [F]);
  return (await colony(colonyId).propose({
    colonyId,
    intentId: tb.intent.id,
    agentId: b.id,
    workspace: tb.lease.repo,
    baseSha: tb.lease.baseSha,
    headSha: fakeSha(),
    writeSet: [{ path: F, blob: fakeSha() }],
    readSet,
    declared: { footprint: tb.intent.footprint, summary: "edit" },
    toldOf,
  })) as Proposal;
}

async function metric(colonyId: string, name: string): Promise<number> {
  const res = await api<{ metrics: Record<string, number> }>("GET", `/colonies/${colonyId}/metrics`);
  expect(res.status).toBe(200);
  return res.body.metrics[name] ?? 0;
}

describe("heads-up in a colony", () => {
  it("names the change waiting ahead, then the landing that moved the agent's file, with the intent's title", async () => {
    const c = await newColony();
    const { b, ia, pa } = await race(c.id);
    const ahead = (await colony(c.id).headsUp(b.id, { reads: [F] })) as HeadsUpAnswer;
    expect(ahead.report?.ahead).toEqual([{ proposalId: pa.id, intentId: ia.id, title: "Cache lookups", region: "src", paths: [F] }]);
    expect(ahead.report?.moved).toEqual([]);
    await tick(c.id, "src");
    const landed = await proposal(c.id, pa.id);
    expect(landed.status).toBe("landed");
    const moved = (await colony(c.id).headsUp(b.id, { reads: [F] })) as HeadsUpAnswer;
    expect(moved.report?.moved).toEqual([expect.objectContaining({ landingId: landed.landingId, intentId: ia.id, title: "Cache lookups", paths: [F] })]);
  });

  it("serves the hook a read-only answer with the MCP token or admin token, or the agent's resume key, and nothing without", async () => {
    const c = await newColony();
    const { b, pa } = await race(c.id);
    await tick(c.id, "src");
    const path = `/colonies/${c.id}/agents/${b.id}/headsup?path=${encodeURIComponent(F)}`;
    const ok = await api<{ agentId: string; intentId: string; headsUp: { moved: Array<{ landingId: string }> } }>("GET", path);
    expect(ok.status).toBe(200);
    expect(ok.body.headsUp.moved[0]?.landingId).toBe((await proposal(c.id, pa.id)).landingId);
    expect((await api("GET", path, undefined, {})).status).toBe(401);
    expect((await api("GET", path, undefined, { authorization: "Bearer wrong" })).status).toBe(401);
    expect((await api("GET", `${path}&token=test-admin`)).status).toBe(401);
    expect((await api("GET", path, undefined, { "x-ft-resume-key": "not-the-key" })).status).toBe(401);
    expect((await api("GET", `/colonies/${c.id}/agents/agt_nobody/headsup`)).status).toBe(404);
  });

  it("a return says the agent was told before it proposed, and /metrics counts it as warned", async () => {
    const c = await newColony();
    await headsUpOn(c.id);
    const { b, tb, pa } = await race(c.id);
    await tick(c.id, "src");
    const landed = await proposal(c.id, pa.id);
    const landing = (await trunk(c.id).state()).landings.find((l) => l.id === landed.landingId)!;
    const toldAt = Date.now() - 40_000;
    const pb = await proposeB(c.id, b, tb, { landings: [{ landingId: landing.id, at: landing.at, toldAt }], lastReplyAt: Date.now() - 1_000 });
    expect(pb.toldOf?.landings[0]?.landingId).toBe(landing.id);
    await tick(c.id, "src");
    const back = await proposal(c.id, pb.id);
    expect(back.status).toBe("returned");
    expect(back.warning).toEqual({ landingId: landing.id, verdict: "warned", toldAt });
    const clock = new Date(toldAt).toISOString().slice(11, 19);
    expect(back.reason).toMatch(new RegExp(`escalate if both cannot hold\\. You were told of ${landing.id} at ${clock} UTC, 4[01] s before you proposed\\.$`));
    expect(await eventually(() => metric(c.id, "headsUp.warned"), (n) => n === 1)).toBe(1);
    expect(await metric(c.id, "headsUp.unwarned")).toBe(0);
  });

  it("a return says the agent could not have known when the landing came after its last reply, and counts it so", async () => {
    const c = await newColony();
    await headsUpOn(c.id);
    const { b, tb } = await race(c.id);
    const lastReplyAt = Date.now() - 1;
    await tick(c.id, "src");
    const pb = await proposeB(c.id, b, tb, { landings: [], lastReplyAt });
    await tick(c.id, "src");
    const back = await proposal(c.id, pb.id);
    expect(back.status).toBe("returned");
    expect(back.warning?.verdict).toBe("unwarned");
    expect(back.reason).toMatch(/ came after your last reply, so you could not have known\.$/);
    expect(await eventually(() => metric(c.id, "headsUp.unwarned"), (n) => n === 1)).toBe(1);
  });

  it("with the flag off, the return and the counters are as before", async () => {
    const c = await newColony();
    const { b, tb } = await race(c.id);
    await tick(c.id, "src");
    const pb = await proposeB(c.id, b, tb, { landings: [], lastReplyAt: 1 });
    await tick(c.id, "src");
    const back = await proposal(c.id, pb.id);
    expect(back.status).toBe("returned");
    expect(back.warning).toBeUndefined();
    expect(back.reason).not.toMatch(/could not have known|You were told/);
    expect(await metric(c.id, "headsUp.unwarned")).toBe(0);
  });
});
