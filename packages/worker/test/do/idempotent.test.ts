import { describe, expect, it } from "vitest";
import type { ColonySnapshot } from "@fire_trident/core";
import { addAgent, addIntent, api, newColony, proposal, proposeEdit, region, take, tick, trunk } from "./helpers.ts";

async function snapshot(colonyId: string): Promise<ColonySnapshot> {
  return (await api<ColonySnapshot>("GET", `/colonies/${colonyId}`)).body;
}

describe("landing reports are idempotent per proposal id", () => {
  it("settles a proposal as landed when its land call failed after it landed (the lane then sees it stale against its own blob)", async () => {
    // Production, 2026-10-12 (colony w3-hono-a): TrunkDO.land failed with "Durable Object reset
    // because its code was updated" after the trunk writer had landed the batch. The next tick saw
    // the proposal stale against its own new blob and returned it; its intent reopened and agents
    // took and abandoned it 19 times in 5 minutes.
    const c = await newColony();
    const i = await addIntent(c.id, ["src/app/main.ts"]);
    const a = await addAgent(c.id);
    const p = await proposeEdit(c.id, await take(c.id, a.id), a.id);
    await trunk(c.id).loseNextAnswers(1);

    await tick(c.id, "src");
    const st = await trunk(c.id).state();
    expect(st.landings).toHaveLength(1);
    expect(st.landings[0]!.proposalIds).toEqual([p.id]);
    expect(st.files["src/app/main.ts"]!.blob).toBe(p.writeSet[0]!.blob); // trunk holds the proposal's own blob
    expect((await proposal(c.id, p.id)).status).toBe("ready"); // the colony never heard

    await tick(c.id, "src");
    const after = await proposal(c.id, p.id);
    expect(after.status).toBe("landed");
    expect(after.landingId).toBe(st.landings[0]!.id);
    expect(after.reason).toBeUndefined();
    expect((await region(c.id, "src").status()).lane).toBe(0);
    expect((await trunk(c.id).state()).landings).toHaveLength(1); // landed once, not twice
    const snap = await snapshot(c.id);
    expect(snap.intents.find((x) => x.id === i.id)?.status).toBe("landed");
  });

  it("settles the lost landing and lands the lane's new proposal in the same tick, returning nothing", async () => {
    const c = await newColony();
    await addIntent(c.id, ["src/app/main.ts"]);
    await addIntent(c.id, ["src/lib/util.ts"]);
    const a1 = await addAgent(c.id, "a1");
    const a2 = await addAgent(c.id, "a2");
    const p1 = await proposeEdit(c.id, await take(c.id, a1.id), a1.id);
    await trunk(c.id).loseNextAnswers(1);
    await tick(c.id, "src"); // p1 lands, the answer is lost
    const got2 = await take(c.id, a2.id);
    const p2 = await proposeEdit(c.id, got2, a2.id);

    await tick(c.id, "src");
    expect((await proposal(c.id, p1.id)).status).toBe("landed");
    expect((await proposal(c.id, p2.id)).status).toBe("landed");
    const landings = (await trunk(c.id).state()).landings;
    expect(landings.map((l) => l.proposalIds)).toEqual([[p1.id], [p2.id]]);
    expect((await region(c.id, "src").status()).lane).toBe(0);
  });
});
