import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { AgentInfo, ColonyEvent, Intent, MovedBy, Proposal } from "@fire_trident/core";
import type { LastReturn } from "../../src/agents/prompt.ts";
import type { Assignment } from "./helpers.ts";
import { addIntent, api, colony, eventually, newColony, proposal, proposeEdit, region, take, tick, trunk } from "./helpers.ts";

/**
 * What beat a returned change (movedBy): when a change goes back because trunk moved files it read or wrote, the colony
 * names the landing that moved each of them, from its per-path landing index: the intent with its title and why, the
 * agent and the model its lineage note names, the trunk commit. The reason ends with what to do, and the attribution
 * travels with the proposal (REST and the inbox), the take's lastReturn, the proposal event and the review queue.
 */

const F = "src/lib/util.ts";
const pastSharedReading = (): Promise<void> => new Promise((r) => setTimeout(r, 300));
const lastReturnOf = (a: Assignment): LastReturn | undefined => (a as Assignment & { lastReturn?: LastReturn }).lastReturn;
const INSTRUCTION = "Keep what that landing did unless your intent says otherwise, and escalate if both cannot hold.";

async function agent(colonyId: string, name: string, model: string): Promise<AgentInfo> {
  const res = await api<AgentInfo>("POST", `/colonies/${colonyId}/agents`, { name, kind: "synthetic", model });
  expect(res.status).toBe(201);
  return res.body;
}

async function events(colonyId: string): Promise<ColonyEvent[]> {
  const res = await api<{ events: ColonyEvent[] }>("GET", `/colonies/${colonyId}/events?limit=5000`);
  expect(res.status).toBe(200);
  return res.body.events;
}

/** Set FT_TEXT_MERGE as one lane sees it (the harness binds none). */
async function setMerging(colonyId: string, name: string, value: string): Promise<void> {
  await runInDurableObject(region(colonyId, name), (instance) => {
    const i = instance as unknown as { env: Record<string, unknown> };
    i.env = { ...i.env, FT_TEXT_MERGE: value };
  });
}

/**
 * Two agents take intents on F from the same trunk; A's change lands first. Returns B's change, proposed on the trunk B
 * read (not yet ticked), and what landed for A.
 */
async function race(colonyId: string): Promise<{ a: AgentInfo; b: AgentInfo; ia: Intent; ib: Intent; pb: Proposal; landed: Proposal }> {
  const [a, b] = [await agent(colonyId, "a", "model-a"), await agent(colonyId, "b", "model-b")];
  const ia = await addIntent(colonyId, [F], { title: "Cache lookups", why: "Lookups repeat; keep the last 100.", assignedTo: a.id });
  const ib = await addIntent(colonyId, [F], { title: "Rename the flag", why: "The old name misleads.", assignedTo: b.id });
  const [ta, tb] = [await take(colonyId, a.id), await take(colonyId, b.id)];
  const pa = await proposeEdit(colonyId, ta, a.id);
  await tick(colonyId, "src");
  const landed = await proposal(colonyId, pa.id);
  expect(landed.status).toBe("landed");
  const pb = await proposeEdit(colonyId, tb, b.id);
  expect(pb.status).toBe("ready");
  return { a, b, ia, ib, pb, landed };
}

/** The attribution of A's landing, as the colony computes it. */
async function expected(colonyId: string, r: { a: AgentInfo; ia: Intent; landed: Proposal }): Promise<MovedBy> {
  const landing = (await trunk(colonyId).state()).landings.find((l) => l.id === r.landed.landingId)!;
  return {
    landingId: landing.id,
    paths: [F],
    trunkSha: landing.trunkSha,
    at: landing.at,
    intentId: r.ia.id,
    title: "Cache lookups",
    why: "Lookups repeat; keep the last 100.",
    agentId: r.a.id,
    model: "model-a",
  };
}

describe("a stale return names the landing that moved its files", () => {
  it("on the proposal, ending its reason with the instruction, in the proposal event, the inbox and the next take", async () => {
    const c = await newColony();
    const r = await race(c.id);
    await tick(c.id, "src");
    const back = await proposal(c.id, r.pb.id);
    const moved = await expected(c.id, r);
    expect(back.status).toBe("returned");
    expect(back.movedBy).toEqual([moved]);
    expect(back.reason).toMatch(new RegExp(`^stale: 1 path changed on trunk since read: src/lib/util\\.ts \\(expected \\w+, trunk \\w+\\)\\. Landing ${moved.landingId} \\(commit ${moved.trunkSha!.slice(0, 7)}, intent ${r.ia.id}, agent ${r.a.id}\\) moved it\\. `));
    expect(back.reason!.endsWith(INSTRUCTION)).toBe(true);

    // The proposal event carries it (the web's cards read it there).
    const event = await eventually(
      async () => (await events(c.id)).find((e) => e.t === "proposal" && e.proposalId === r.pb.id && e.status === "returned"),
      (e) => e !== undefined,
    );
    expect(event).toMatchObject({ reason: back.reason, movedBy: [moved] });

    // The agent's inbox lists the proposal with it.
    const inbox = await api<Array<Proposal & { kind?: string }>>("GET", `/colonies/${c.id}/agents/${r.b.id}/inbox`);
    expect(inbox.body.find((e) => e.id === r.pb.id)).toMatchObject({ status: "returned", movedBy: [moved] });

    // The next take of the reopened intent hands it back with the return.
    await pastSharedReading();
    const again = await take(c.id, r.b.id);
    expect(again.intent.id).toBe(r.ib.id);
    expect(lastReturnOf(again)).toMatchObject({ proposalId: r.pb.id, reason: back.reason, movedBy: [moved] });
  });

  it("a text merge conflict the trunk writer sends back keeps its hunks and gains the same attribution", async () => {
    const c = await newColony();
    const r = await race(c.id);
    await setMerging(c.id, "src", "on");
    const conflict = { path: F, base: "1".repeat(40), trunk: "2".repeat(40), theirs: r.pb.writeSet[0]!.blob!, lines: [3] };
    await trunk(c.id).returnOnLand([r.pb.id], { [r.pb.id]: [conflict] });
    await tick(c.id, "src");
    const back = await proposal(c.id, r.pb.id);
    expect(back.status).toBe("returned");
    expect(back.mergeConflicts).toEqual([conflict]);
    expect(back.movedBy).toEqual([await expected(c.id, r)]);
    expect(back.reason!.startsWith("conflict at land time: src/lib/util.ts. Landing ")).toBe(true);
    expect(back.reason!.endsWith(INSTRUCTION)).toBe(true);
  });

  it("names nothing for a return that is not about trunk moving, and nothing when no landing moved the files", async () => {
    const c = await newColony();
    const r = await race(c.id);
    // A review return: the reason stays as it is, even with stale paths at hand.
    await colony(c.id).updateProposals([{ id: r.pb.id, patch: { status: "returned", reason: "llm: the flag is still read under its old name" }, stale: [{ path: F }] }]);
    const back = await proposal(c.id, r.pb.id);
    expect(back.reason).toBe("llm: the flag is still read under its old name");
    expect(back.movedBy).toBeUndefined();

    // A stale return where no landing the colony knows of moved the file: no attribution.
    const d = await newColony();
    const solo = await agent(d.id, "solo", "model-s");
    await addIntent(d.id, [F], { assignedTo: solo.id });
    const p = await proposeEdit(d.id, await take(d.id, solo.id), solo.id);
    await colony(d.id).updateProposals([{ id: p.id, patch: { status: "returned", reason: "stale: 1 path changed on trunk since read: src/lib/util.ts" }, stale: [{ path: F }] }]);
    const quiet = await proposal(d.id, p.id);
    expect(quiet.reason).toBe("stale: 1 path changed on trunk since read: src/lib/util.ts");
    expect(quiet.movedBy).toBeUndefined();
  });

  it("the review queue carries what beat the intent's last change, for the card of its next change", async () => {
    const c = await newColony();
    const r = await race(c.id);
    await tick(c.id, "src");
    expect((await proposal(c.id, r.pb.id)).status).toBe("returned");
    await pastSharedReading();
    const again = await take(c.id, r.b.id);
    const next = await proposeEdit(c.id, again, r.b.id);
    await colony(c.id).updateProposals([{ id: next.id, patch: { status: "escalated", reason: "needs a person" } }]);
    const queue = (await api<Array<Proposal & { lastReturn?: LastReturn }>>("GET", `/colonies/${c.id}/review`)).body;
    const card = queue.find((p) => p.id === next.id)!;
    expect(card.lastReturn).toMatchObject({ proposalId: r.pb.id, movedBy: [await expected(c.id, r)] });
  });
});
