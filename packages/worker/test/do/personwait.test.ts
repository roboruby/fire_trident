import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { HeldMergeFile, Intent } from "@fire_trident/core";
import type { TakeResult } from "../../src/colony/ColonyDO.ts";
import { holdReason } from "../../src/trunk/mergelock.ts";
import { addAgent, addIntent, api, colony, externalLanding, newColony, proposal, proposeEdit, region, rows, take, tick, trunk } from "./helpers.ts";

/**
 * Changes waiting for a person hold no files (FT_PERSON_WAIT, colony/personwait.ts), through the real ColonyDO and
 * RegionDO: two changes on one shared file escalated to a person no longer keep a third agent from an open intent on
 * that file; each still lands when the person approves (or is held again under the merge lock when trunk moved); and
 * the claim of an agent actually writing the file still holds others off, as before.
 */

const SHARED = "src/core/money.ts";
const INHIBITED = "every open intent's files are claimed by another agent";

/** Turn FT_PERSON_WAIT on for one colony as its ColonyDO sees it (the harness binds none, so it is off by default). */
async function personWaitOn(colonyId: string): Promise<void> {
  await runInDurableObject(colony(colonyId), (instance) => {
    const i = instance as unknown as { env: Record<string, unknown> };
    i.env = { ...i.env, FT_PERSON_WAIT: colonyId };
  });
}

/** Text merge on in one lane (the harness binds none): a change stale only on files it writes goes on to the trunk writer. */
async function merging(colonyId: string, name: string): Promise<void> {
  await runInDurableObject(region(colonyId, name), (instance) => {
    const i = instance as unknown as { env: Record<string, unknown> };
    i.env = { ...i.env, FT_TEXT_MERGE: "on" };
  });
}

async function tryTake(colonyId: string, agentId: string): Promise<TakeResult> {
  const res = await api<TakeResult>("POST", `/colonies/${colonyId}/agents/${agentId}/take`);
  expect(res.status).toBe(200);
  return res.body;
}

async function status(colonyId: string, intentId: string): Promise<string | undefined> {
  return ((await colony(colonyId).getIntent(intentId)) as Intent | null)?.status;
}

/** Claim marks of these intents in a region. */
async function claims(colonyId: string, regionName: string, ...intentIds: string[]): Promise<Array<{ intent_id: string; path: string }>> {
  return rows(region(colonyId, regionName), `SELECT intent_id, path FROM marks WHERE kind = 'claim' AND intent_id IN (${intentIds.map(() => "?").join(", ")}) ORDER BY intent_id, path`, ...intentIds);
}

/** The colony caches region readings for 250 ms; wait past it so the next take reads the field again. */
const pastReadingCache = (): Promise<void> => new Promise((r) => setTimeout(r, 300));

/** Two agents each hold an intent on the shared file and propose; a person is asked about both. */
async function twoEscalated(colonyId: string) {
  await externalLanding(colonyId, { [SHARED]: "export const cents = 100;\n" });
  const [a, b] = [await addAgent(colonyId, "a"), await addAgent(colonyId, "b")];
  const x = await addIntent(colonyId, [SHARED, "src/split.ts"], { assignedTo: a.id });
  const y = await addIntent(colonyId, [SHARED, "src/tip.ts"], { assignedTo: b.id });
  const pa = await proposeEdit(colonyId, await take(colonyId, a.id), a.id);
  const pb = await proposeEdit(colonyId, await take(colonyId, b.id), b.id);
  await colony(colonyId).updateProposals([
    { id: pa.id, patch: { status: "escalated", reason: "escalated by llm: acceptance not shown met" } },
    { id: pb.id, patch: { status: "escalated", reason: "escalated by llm: acceptance not shown met" } },
  ]);
  return { a, b, x, y, pa, pb };
}

describe("changes waiting for a person (FT_PERSON_WAIT)", () => {
  it("without the flag, two escalated changes on a shared file keep every other intent on it untaken", async () => {
    const c = await newColony();
    const { x, y } = await twoEscalated(c.id);
    const z = await addIntent(c.id, [SHARED, "src/refund.ts"]);
    expect(await claims(c.id, "src", x.id, y.id)).toHaveLength(4);
    const d = await addAgent(c.id, "d");
    await pastReadingCache();
    expect(await tryTake(c.id, d.id)).toMatchObject({ wait: true, reason: INHIBITED });
    expect(await status(c.id, z.id)).toBe("open");
  });

  it("frees the shared file: a third agent takes an open intent on it in one take, and the changes still land", async () => {
    const c = await newColony();
    await personWaitOn(c.id);
    const { a, b, x, y, pa, pb } = await twoEscalated(c.id);
    // Waiting for a person: no claim is left on either footprint, and no heartbeat brings one back.
    expect(await claims(c.id, "src", x.id, y.id)).toEqual([]);
    await runInDurableObject(colony(c.id), (instance) => {
      (instance as unknown as { lastRefresh: Map<string, number> }).lastRefresh.clear();
    });
    await colony(c.id).heartbeat(a.id);
    await colony(c.id).heartbeat(b.id);
    expect(await region(c.id, "src").refreshClaims({ agentId: a.id })).toBe(0);
    expect(await claims(c.id, "src", x.id, y.id)).toEqual([]);
    // The intents stay with their changes, which wait in the review queue.
    expect(await status(c.id, x.id)).toBe("proposed");
    expect((await proposal(c.id, pa.id)).status).toBe("escalated");

    const z = await addIntent(c.id, [SHARED, "src/refund.ts"]);
    const d = await addAgent(c.id, "d");
    await pastReadingCache();
    expect((await take(c.id, d.id)).intent.id).toBe(z.id);

    // The agent actually writing the file holds others off, as before.
    const w = await addIntent(c.id, [SHARED, "src/fx.ts"]);
    const e = await addAgent(c.id, "e");
    await pastReadingCache();
    expect(await tryTake(c.id, e.id)).toMatchObject({ wait: true, reason: INHIBITED });
    // So does a, whose change waits: it has no claim of its own on the file left to discount against d's.
    expect(await tryTake(c.id, a.id)).toMatchObject({ wait: true, reason: INHIBITED });
    expect(await status(c.id, w.id)).toBe("open");

    // b is free too: it takes other work while its change waits.
    const docs = await addIntent(c.id, ["docs/guide.md"]);
    expect((await take(c.id, b.id)).intent.id).toBe(docs.id);

    // The person approves a's change: it lands by the ordinary rules.
    expect((await api("POST", `/colonies/${c.id}/review/${pa.id}`, { decision: "approve", reason: "read it", by: "matt" })).status).toBe(200);
    await tick(c.id, "src");
    expect((await proposal(c.id, pa.id)).status).toBe("landed");
    expect(await status(c.id, x.id)).toBe("landed");

    // b's change: trunk moved under it (a's landed), so with text merge the trunk writer merges it, and as a person
    // approved it, holds that merge for the person again (the merge lock).
    await merging(c.id, "src");
    const held: HeldMergeFile[] = [
      {
        path: SHARED,
        base: "a".repeat(40),
        trunk: "b".repeat(40),
        theirs: "d".repeat(40),
        result: "c".repeat(40),
        trunkDiff: { hunks: "@@ -1,1 +1,1 @@\n-line 1\n+trunk one", added: 1, removed: 1, truncated: false },
        mergedDiff: { hunks: "@@ -1,1 +1,1 @@\n-line 1\n+trunk one", added: 1, removed: 1, truncated: false },
      },
    ];
    await trunk(c.id).returnOnLand([pb.id], undefined, { [pb.id]: { reason: holdReason({ approvedAt: 1 }, held), held } });
    expect((await api("POST", `/colonies/${c.id}/review/${pb.id}`, { decision: "approve", reason: "read it", by: "matt" })).status).toBe(200);
    await tick(c.id, "src");
    expect(await proposal(c.id, pb.id)).toMatchObject({ status: "escalated", mergeHold: held });
    expect(await claims(c.id, "src", y.id)).toEqual([]);
    // The person approves the merge: it lands, and b keeps the work it took meanwhile.
    await trunk(c.id).returnOnLand([]);
    expect((await api("POST", `/colonies/${c.id}/review/${pb.id}`, { decision: "approve", reason: "read the merge", by: "matt" })).status).toBe(200);
    await tick(c.id, "src");
    expect((await proposal(c.id, pb.id)).status).toBe("landed");
    expect(await status(c.id, y.id)).toBe("landed");
    expect((await colony(c.id).getIntent(docs.id)) as Intent | null).toMatchObject({ status: "claimed", assignedTo: b.id });
  });
});
