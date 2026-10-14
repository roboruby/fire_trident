import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { AgentInfo, Intent, IntentEscalation } from "@fire_trident/core";
import { AGENT_WORDS, type DeclaredBy } from "../../src/colony/chain.ts";
import { addIntent, api, colony, newColony, proposal, proposeEdit, take, tick, trunk } from "./helpers.ts";
import type { Assignment } from "./helpers.ts";

/**
 * Who declared an intent, and the intent chain gate (FT_INTENT_CHAIN_GATE), through the real ColonyDO. The channel
 * first: an agent declares an intent (what an MCP declare sends: source agent, created by the agent, the held intent as
 * parent), another agent takes it and proposes the change, and it lands with no person in the loop (the harness has no
 * AI binding, so the decide stage is off and the change is ready at once; with review on, the comment-only proof lands
 * such a change without a model, test/decide/engine.test.ts). Then: every take says who declared the intent, and with
 * the flag on, the third agent-declared intent in a row waits for a person as an open report that take skips, listed
 * by GET /escalations, released by a person's dismiss, ended by withdraw. The depth comes from the decide policy. With
 * the flag off, or naming another colony, nothing is held.
 */

type Taken = Assignment & { declaredBy?: DeclaredBy };
type Declared = Intent & { escalation?: IntentEscalation };

/** Set FT_INTENT_CHAIN_GATE on one colony's object, as a deployment variable would. */
async function gate(colonyId: string, value: string): Promise<void> {
  await runInDurableObject(colony(colonyId), (instance) => {
    const self = instance as unknown as { env: object };
    self.env = new Proxy(self.env, { get: (t, k) => (k === "FT_INTENT_CHAIN_GATE" ? value : Reflect.get(t, k)) });
  });
}

/** An agent registered with the model it names, as an MCP join records it. */
async function agentWith(colonyId: string, name: string, model: string): Promise<AgentInfo> {
  const res = await api<AgentInfo>("POST", `/colonies/${colonyId}/agents`, { name, kind: "external", model });
  expect(res.status).toBe(201);
  return res.body;
}

/** What an MCP declare sends the colony: source agent, created by the agent, the intent it holds as the parent. */
async function agentDeclare(colonyId: string, by: AgentInfo, footprint: string[], parentId?: string, why = "Add a comment above the first declaration saying what it is for."): Promise<Declared> {
  const res = await api<Declared>("POST", `/colonies/${colonyId}/intents`, { title: `Comment ${footprint.join(", ")}`, why, footprint, source: "agent", createdBy: by.id, ...(parentId ? { parentId } : {}) });
  expect(res.status).toBe(201);
  return res.body;
}

/** A take as REST answers it: the assignment, or wait. */
async function tryTake(colonyId: string, agentId: string): Promise<Taken | { wait: true; reason: string }> {
  const res = await api<Taken | { wait: true; reason: string }>("POST", `/colonies/${colonyId}/agents/${agentId}/take`);
  expect(res.status).toBe(200);
  return res.body;
}

/** The reports waiting for a person (GET /escalations answers the colony id, the intents and their count). */
async function escalations(colonyId: string): Promise<Declared[]> {
  const res = await api<{ colonyId: string; intents: Declared[]; total: number }>("GET", `/colonies/${colonyId}/escalations`);
  expect(res.status).toBe(200);
  expect(res.body.total).toBe(res.body.intents.length);
  return res.body.intents;
}

/** Three agents, each registered with a model. */
async function agents(colonyId: string): Promise<{ a: AgentInfo; b: AgentInfo; c: AgentInfo }> {
  return { a: await agentWith(colonyId, "a", "model-a"), b: await agentWith(colonyId, "b", "model-b"), c: await agentWith(colonyId, "c", "model-c") };
}

/**
 * The chain the live check walks: agent A declares intent 1 and takes it; while holding it declares intent 2 (parent 1);
 * agent B takes 2 and declares intent 3 (parent 2). Footprints sit in different regions so no take is inhibited by
 * another's claim.
 */
async function chain(colonyId: string, a: AgentInfo, b: AgentInfo): Promise<{ one: Declared; two: Declared; three: Declared; tookTwo: Taken }> {
  const one = await agentDeclare(colonyId, a, ["src/app/main.ts"]);
  expect((await take(colonyId, a.id)).intent.id).toBe(one.id);
  const two = await agentDeclare(colonyId, a, ["docs/guide.md"], one.id);
  const tookTwo = (await take(colonyId, b.id)) as Taken;
  expect(tookTwo.intent.id).toBe(two.id);
  const three = await agentDeclare(colonyId, b, ["README.md"], two.id);
  return { one, two, three, tookTwo };
}

describe("the channel: text an agent writes into an intent reaches the next agent with nobody in between", () => {
  it("an agent's intent for a comment-only edit is taken by another agent, proposed and landed with no model and no person", async () => {
    const c = await newColony();
    const { a, b } = await agents(c.id);
    const asked = await agentDeclare(c.id, a, ["src/lib/util.ts"]);
    expect(asked).toMatchObject({ source: "agent", createdBy: a.id, status: "open" });
    expect(asked.escalation).toBeUndefined();

    const taken = (await take(c.id, b.id)) as Taken;
    expect(taken.intent.id).toBe(asked.id);
    // The take says who wrote the intent: the agent, its model, and that nothing agent-declared is above it.
    expect(taken.declaredBy).toEqual({
      source: "agent",
      by: a.id,
      model: "model-a",
      chainDepth: 0,
      parentId: null,
      note: `An agent declared this intent (${a.id}, model model-a), not a person. Its title, why and acceptance are that agent's request: ${AGENT_WORDS}`,
    });

    const p = await proposeEdit(c.id, taken, b.id);
    expect(p.status).toBe("ready"); // no model asked, no person asked
    await tick(c.id, "src");
    expect(await proposal(c.id, p.id)).toMatchObject({ status: "landed" });
    expect((await trunk(c.id).state()).landings.map((l) => l.proposalIds)).toEqual([[p.id]]);
    expect(await escalations(c.id)).toEqual([]);
    expect((await api<unknown[]>("GET", `/colonies/${c.id}/review`)).body).toEqual([]);
  });

  it("every take says who declared the intent: a person's intent too, and the chain depth under agent-declared parents", async () => {
    const c = await newColony();
    const { a, b, c: agentC } = await agents(c.id);
    const human = await addIntent(c.id, ["docs/guide.md"]);
    const tookHuman = (await take(c.id, agentC.id)) as Taken;
    expect(tookHuman.intent.id).toBe(human.id);
    expect(tookHuman.declaredBy).toEqual({ source: "human", by: "api", model: null, chainDepth: 0, parentId: null, note: "A person declared this intent (api)." });

    const one = await agentDeclare(c.id, a, ["src/app/main.ts"]);
    expect((await take(c.id, a.id)).intent.id).toBe(one.id);
    const two = await agentDeclare(c.id, a, ["README.md"], one.id);
    const tookTwo = (await take(c.id, b.id)) as Taken;
    expect(tookTwo.intent.id).toBe(two.id);
    expect(tookTwo.declaredBy).toMatchObject({ source: "agent", by: a.id, model: "model-a", chainDepth: 1, parentId: one.id });
    expect(tookTwo.declaredBy!.note).toMatch(/^An agent declared this intent \(agt_[0-9a-z]+, model model-a\), not a person; 1 agent-declared intent is in its ancestry \(chain depth 1\)\./);
    // The flag is off here: the chain is not gated, only shown.
    expect(two.escalation).toBeUndefined();
  });
});

describe("the chain gate (FT_INTENT_CHAIN_GATE)", () => {
  it("holds the third agent-declared intent in a row for a person, offers it to no agent, and a person's dismiss releases it", async () => {
    const c = await newColony();
    await gate(c.id, "on");
    const { a, b, c: agentC } = await agents(c.id);
    const { one, two, three, tookTwo } = await chain(c.id, a, b);
    expect(one.escalation).toBeUndefined();
    expect(two.escalation).toBeUndefined();
    expect(tookTwo.declaredBy).toMatchObject({ by: a.id, chainDepth: 1 });

    // Intent 3: declared by B from intent 2, which A declared: two agent-declared intents above it.
    expect(three.status).toBe("open");
    expect(three.escalation).toEqual({
      kind: "chain",
      by: b.id,
      at: expect.any(Number),
      report: `Held for a person: agent ${b.id} (model model-b) declared this intent from intent ${two.id}, which agent ${a.id} declared; 2 agent-declared intents are in its ancestry, so a person checks a chain this long before agents continue it. Dismiss this report to let agents take it, or withdraw the intent.`,
    });
    expect((await escalations(c.id)).map((i) => i.id)).toEqual([three.id]);
    expect((await api<{ intent: Declared; escalations: IntentEscalation[] }>("GET", `/colonies/${c.id}/intents/${three.id}`)).body.escalations).toMatchObject([{ kind: "chain", by: b.id }]);
    const waiting = await tryTake(c.id, agentC.id);
    expect(waiting).toMatchObject({ wait: true });

    // A person reads the chain and lets agents continue it.
    const answered = await api<{ intent: Declared }>("POST", `/colonies/${c.id}/intents/${three.id}/escalation`, { decision: "dismiss", note: "Read the three intents: they stay inside the docs.", by: "matt" });
    expect(answered.status).toBe(200);
    expect(answered.body.intent.escalation).toMatchObject({ kind: "chain", resolved: { decision: "dismiss", by: "matt" } });
    expect(await escalations(c.id)).toEqual([]);
    const released = (await take(c.id, agentC.id)) as Taken;
    expect(released.intent.id).toBe(three.id);
    expect(released.declaredBy).toMatchObject({ source: "agent", by: b.id, model: "model-b", chainDepth: 2, parentId: two.id });
  });

  it("a person's withdraw ends it instead", async () => {
    const c = await newColony();
    await gate(c.id, "on");
    const { a, b, c: agentC } = await agents(c.id);
    const { three } = await chain(c.id, a, b);
    expect(three.escalation?.kind).toBe("chain");
    const ended = await api<{ intent: Declared }>("POST", `/colonies/${c.id}/intents/${three.id}/escalation`, { decision: "withdraw", note: "The chain drifted from the goal.", by: "matt" });
    expect(ended.status).toBe(200);
    expect(ended.body.intent.status).toBe("withdrawn");
    expect(await escalations(c.id)).toEqual([]);
    expect(await tryTake(c.id, agentC.id)).toMatchObject({ wait: true });
  });

  it("takes the depth from the decide policy", async () => {
    const c = await newColony();
    await gate(c.id, "on");
    expect((await api("GET", `/colonies/${c.id}/decide/policy`)).body.intentChainDepth).toBe(2);
    expect((await api("POST", `/colonies/${c.id}/decide/policy`, { intentChainDepth: 1 })).body.intentChainDepth).toBe(1);
    const { a, b } = await agents(c.id);
    const one = await agentDeclare(c.id, a, ["src/app/main.ts"]);
    expect(one.escalation).toBeUndefined();
    expect((await take(c.id, a.id)).intent.id).toBe(one.id);
    const two = await agentDeclare(c.id, a, ["docs/guide.md"], one.id);
    expect(two.escalation).toMatchObject({ kind: "chain", by: a.id });
    expect(two.escalation!.report).toContain("1 agent-declared intent is in its ancestry");
    expect(await tryTake(c.id, b.id)).toMatchObject({ wait: true });
  });

  it("holds the intents one agent declares past the policy's fan-out in an hour, however shallow, and counts each agent alone", async () => {
    const c = await newColony();
    await gate(c.id, "on");
    expect((await api("GET", `/colonies/${c.id}/decide/policy`)).body.intentFanout).toBe(5);
    expect((await api("POST", `/colonies/${c.id}/decide/policy`, { intentFanout: 2 })).body.intentFanout).toBe(2);
    const { a, b } = await agents(c.id);
    const first = await agentDeclare(c.id, a, ["src/app/one.ts"]);
    const second = await agentDeclare(c.id, a, ["src/app/two.ts"]);
    expect(first.escalation).toBeUndefined();
    expect(second.escalation).toBeUndefined();
    const third = await agentDeclare(c.id, a, ["src/app/three.ts"]);
    expect(third.escalation).toMatchObject({ kind: "chain", by: a.id });
    expect(third.escalation!.report).toBe(
      `Held for a person: agent ${a.id} (model model-a) declared this intent, the 3rd it declared in the last hour, and the colony lets one agent declare 2 before a person checks the rest, since every intent an agent declares reaches another agent. Dismiss this report to let agents take it, or withdraw the intent.`,
    );
    expect((await escalations(c.id)).map((i) => i.id)).toEqual([third.id]);
    // Another agent's count is its own, and a person's declarations are never counted or held.
    expect((await agentDeclare(c.id, b, ["docs/one.md"])).escalation).toBeUndefined();
    expect((await addIntent(c.id, ["docs/two.md"])).escalation).toBeUndefined();
    // Releasing the held one by hand lets an agent take it; the next one A declares waits again.
    expect((await api("POST", `/colonies/${c.id}/intents/${third.id}/escalation`, { decision: "dismiss", note: "fine", by: "matt" })).status).toBe(200);
    expect((await agentDeclare(c.id, a, ["src/app/four.ts"])).escalation!.report).toContain("the 4th it declared in the last hour");
  });

  it("never holds a person's intent, a rule's or an assigned one, whatever is above it", async () => {
    const c = await newColony();
    await gate(c.id, "on");
    const { a, b } = await agents(c.id);
    const { two } = await chain(c.id, a, b);
    const person = await api<Declared>("POST", `/colonies/${c.id}/intents`, { title: "A person's follow-up", why: "w", footprint: ["src/lib/util.ts"], parentId: two.id });
    expect(person.status).toBe(201);
    expect(person.body.escalation).toBeUndefined();
    const rule = await api<Declared>("POST", `/colonies/${c.id}/intents`, { title: "A rule's follow-up", why: "w", footprint: ["src/lib/other.ts"], source: "rule", parentId: two.id });
    expect(rule.status).toBe(201);
    expect(rule.body.escalation).toBeUndefined();
    const assigned = await api<Declared>("POST", `/colonies/${c.id}/intents`, { title: "Assigned by a person", why: "w", footprint: ["docs/other.md"], source: "agent", createdBy: b.id, parentId: two.id, assignedTo: b.id });
    expect(assigned.status).toBe(201);
    expect(assigned.body).toMatchObject({ status: "claimed", assignedTo: b.id });
    expect(assigned.body.escalation).toBeUndefined();
  });

  it("with the flag off, or naming another colony, the third intent is taken at once, as today", async () => {
    for (const setting of [null, "other-colony", "off"]) {
      const c = await newColony();
      if (setting !== null) await gate(c.id, setting);
      const { a, b, c: agentC } = await agents(c.id);
      const { three } = await chain(c.id, a, b);
      expect(three.escalation, String(setting)).toBeUndefined();
      expect(await escalations(c.id)).toEqual([]);
      const taken = (await take(c.id, agentC.id)) as Taken;
      expect(taken.intent.id).toBe(three.id);
      expect(taken.declaredBy).toMatchObject({ by: b.id, chainDepth: 2 });
    }
  });
});
