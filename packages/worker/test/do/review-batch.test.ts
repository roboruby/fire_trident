import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Proposal } from "@fire_trident/core";
import { EscalationBatches, batchKeyOf } from "../../src/decide/batch.ts";
import { addAgent, addIntent, api, colony, newColony, proposal, proposeEdit, take } from "./helpers.ts";

/** Escalation batching on a real colony (FT_ESCALATION_BATCH): the review queue's batch cards, and an answer for one. */

type Item = Proposal & { batch?: { key: string; label: string; budget: number; ids: string[] } };

const NETWORK = batchKeyOf("P1 danger pattern", { danger: [{ cls: "capability", pattern: "capability:network" }] })!;
const TOO_LARGE = batchKeyOf("L5 too large")!;

/** Three escalated proposals, recorded the way the decide engine records them past the budget: two in one batch. */
async function batchedThree(): Promise<{ colonyId: string; ids: string[] }> {
  const c = await newColony();
  const ids: string[] = [];
  for (const [i, dir] of ["src/a", "src/b", "docs"].entries()) {
    await addIntent(c.id, [`${dir}/file${i}.ts`]);
    const agent = await addAgent(c.id, `agent${i}`);
    ids.push((await proposeEdit(c.id, await take(c.id, agent.id), agent.id)).id);
  }
  await colony(c.id).updateProposals(ids.map((id) => ({ id, patch: { status: "escalated" as const } })));
  await runInDurableObject(colony(c.id), (_instance: unknown, state: DurableObjectState) => {
    const batches = new EscalationBatches(state.storage.sql);
    const now = Date.now();
    // The budget (1 here) is spent by an earlier escalation; the three after it are batched.
    batches.record("prp_earlier", TOO_LARGE, now - 10, 1);
    batches.record(ids[0]!, NETWORK, now - 3, 1);
    batches.record(ids[1]!, NETWORK, now - 2, 1);
    batches.record(ids[2]!, TOO_LARGE, now - 1, 1);
  });
  return { colonyId: c.id, ids };
}

/** Turn the flag on (a list naming the colony) or off for the colony's object. */
async function flag(colonyId: string, value: string | null): Promise<void> {
  await runInDurableObject(colony(colonyId), (instance: unknown) => {
    const env = (instance as { env: Record<string, unknown> }).env;
    if (value === null) delete env.FT_ESCALATION_BATCH;
    else env.FT_ESCALATION_BATCH = value;
  });
}

async function queue(colonyId: string): Promise<Map<string, Item>> {
  const res = await api<Item[]>("GET", `/colonies/${colonyId}/review`);
  expect(res.status).toBe(200);
  return new Map(res.body.map((p) => [p.id, p]));
}

describe("review queue batches", () => {
  it("keeps the queue as before with the flag off, and refuses an answer for a batch", async () => {
    const { colonyId, ids } = await batchedThree();
    const q = await queue(colonyId);
    expect([...q.keys()].sort()).toEqual([...ids].sort());
    expect([...q.values()].some((p) => "batch" in p)).toBe(false);
    const res = await api<{ error: string }>("POST", `/colonies/${colonyId}/review/batches/decide`, { key: NETWORK.key, ids: ids.slice(0, 2), decision: "approve" });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("decide each change on its own card");
    for (const id of ids) expect((await proposal(colonyId, id)).status).toBe("escalated");
  });

  it("with the flag on, marks a batch's waiting changes and approves the listed ones each as a person's decision", async () => {
    const { colonyId, ids } = await batchedThree();
    await flag(colonyId, `other,${colonyId}`);
    try {
      const q = await queue(colonyId);
      const [a, b, lone] = ids.map((id) => q.get(id)!);
      expect(a!.batch).toMatchObject({ key: NETWORK.key, label: "hit the danger pattern capability (network)", budget: 60 });
      expect([...a!.batch!.ids].sort()).toEqual([ids[0], ids[1]].sort());
      expect(b!.batch).toEqual(a!.batch);
      // Alone in its batch: its own card.
      expect(lone!.batch).toBeUndefined();

      const res = await api<{ decided: string[]; skipped: Array<{ id: string; why: string }> }>("POST", `/colonies/${colonyId}/review/batches/decide`, { key: NETWORK.key, ids, decision: "approve", by: "reviewer" });
      expect(res.status).toBe(200);
      expect(res.body.decided).toEqual([ids[0], ids[1]]);
      expect(res.body.skipped).toEqual([{ id: ids[2], why: "not in this batch; decide it on its own card" }]);
      for (const id of ids.slice(0, 2)) expect((await proposal(colonyId, id)).status).not.toBe("escalated");
      expect((await proposal(colonyId, ids[2]!)).status).toBe("escalated");
      const decisions = await runInDurableObject(colony(colonyId), (_i: unknown, state: DurableObjectState) =>
        state.storage.sql.exec<{ subject: string; answers: string }>("SELECT subject, answers FROM decisions WHERE layer = 'human' ORDER BY at").toArray(),
      );
      expect(decisions.map((d) => [d.subject, (JSON.parse(d.answers) as { decision: string; by: string }).decision, (JSON.parse(d.answers) as { by: string }).by])).toEqual([
        [ids[0], "approve", "reviewer"],
        [ids[1], "approve", "reviewer"],
      ]);
      // A held merge (a change a person approved that came back) is decided on its own card, never in a batch.
      await colony(colonyId).updateProposals([{ id: ids[0]!, patch: { status: "escalated" as const, approvedAt: Date.now(), mergeHold: [{ path: "src/a/file0.ts" } as never] } }]);
      expect((await queue(colonyId)).get(ids[0]!)?.batch).toBeUndefined();
      const held = await api<{ decided: string[]; skipped: Array<{ id: string; why: string }> }>("POST", `/colonies/${colonyId}/review/batches/decide`, { key: NETWORK.key, ids: [ids[0]], decision: "approve" });
      expect(held.body).toMatchObject({ decided: [], skipped: [{ id: ids[0], why: "a person already decided it once (a held merge); decide it on its own card" }] });
      // Answered twice, nothing waits in it any more.
      const again = await api<{ decided: string[] }>("POST", `/colonies/${colonyId}/review/batches/decide`, { key: NETWORK.key, ids: ids.slice(0, 2), decision: "approve" });
      expect(again.body.decided).toEqual([]);
    } finally {
      await flag(colonyId, null);
    }
  });
});
