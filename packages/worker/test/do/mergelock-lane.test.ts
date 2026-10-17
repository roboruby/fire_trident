import { describe, expect, it } from "vitest";
import type { HeldMergeFile, Proposal } from "@fire_trident/core";
import { holdReason } from "../../src/trunk/mergelock.ts";
import { addAgent, addIntent, api, newColony, proposal, proposeEdit, region, rows, take, tick, trunk } from "./helpers.ts";

/**
 * Merge locks through the real ColonyDO and RegionDO (the stand-in trunk writer gives the return): a change the trunk
 * writer held rather than merge with a newer trunk goes to a person, and that person's approval travels with the change
 * to its lane and on to the trunk writer.
 */

const PATH = "src/app/main.ts";

describe("a change the trunk writer held rather than merge", () => {
  it("goes to the review queue, and a person's approval travels with it back through its lane to a landing", async () => {
    const c = await newColony();
    await addIntent(c.id, [PATH]);
    const a = await addAgent(c.id, "a");
    const p = await proposeEdit(c.id, await take(c.id, a.id), a.id);
    expect(p.status).toBe("ready");
    expect(p.approvedAt).toBeUndefined();
    const held: HeldMergeFile[] = [
      {
        path: PATH,
        base: "a".repeat(40),
        trunk: "b".repeat(40),
        theirs: "d".repeat(40),
        result: "c".repeat(40),
        trunkDiff: { hunks: "@@ -1,1 +1,1 @@\n-line 1\n+trunk one", added: 1, removed: 1, truncated: false },
        mergedDiff: { hunks: "@@ -1,1 +1,1 @@\n-line 1\n+trunk one", added: 1, removed: 1, truncated: false },
      },
    ];
    const reason = holdReason({ approvedAt: 1 }, held);
    await trunk(c.id).returnOnLand([p.id], undefined, { [p.id]: { reason, held } });

    await tick(c.id, "src");
    // The person reads the held merge with the change: each file's blobs and diffs.
    expect(await proposal(c.id, p.id)).toMatchObject({ status: "escalated", reason, mergeHold: held });
    const queue = (await api<Proposal[]>("GET", `/colonies/${c.id}/review`)).body ?? [];
    expect(queue.find((x) => x.id === p.id)?.mergeHold).toEqual(held);
    expect((await region(c.id, "src").status()).lane).toBe(0);
    expect(((await api<Proposal[]>("GET", `/colonies/${c.id}/review`)).body ?? []).map((x) => x.id)).toContain(p.id);
    // A person decides, not a landing: no return is counted as caused by one.
    expect(await rows(region(c.id, "src"), "SELECT id FROM causes WHERE id = ?", `ret:${p.id}`)).toEqual([]);

    // A person approves: the approval is on the change in its lane, for the trunk writer.
    await trunk(c.id).returnOnLand([]);
    const before = Date.now();
    expect((await api("POST", `/colonies/${c.id}/review/${p.id}`, { decision: "approve", reason: "read the trunk change", by: "matt" })).status).toBe(200);
    const ready = await proposal(c.id, p.id);
    expect(ready.status).toBe("ready");
    expect(ready.approvedAt).toBeGreaterThanOrEqual(before);
    // The held merge is answered.
    expect(ready.mergeHold).toBeUndefined();
    const queued = await rows<{ data: string }>(region(c.id, "src"), "SELECT data FROM lane WHERE id = ?", p.id);
    expect((JSON.parse(queued[0]!.data) as Proposal).approvedAt).toBe(ready.approvedAt);

    await tick(c.id, "src");
    expect((await proposal(c.id, p.id)).status).toBe("landed");
  });

  it("a stale return from the trunk writer still goes back to its agent", async () => {
    const c = await newColony();
    await addIntent(c.id, [PATH]);
    const a = await addAgent(c.id, "a");
    const p = await proposeEdit(c.id, await take(c.id, a.id), a.id);
    await trunk(c.id).returnOnLand([p.id], undefined, { [p.id]: { reason: `stale: ${PATH} (expected ${"a".repeat(40)}, trunk has ${"b".repeat(40)})` } });
    await tick(c.id, "src");
    expect((await proposal(c.id, p.id)).status).toBe("returned");
  });

  it("a person's approval of a change already cleared to land is recorded on it and on its lane's copy", async () => {
    const c = await newColony();
    await addIntent(c.id, [PATH]);
    const a = await addAgent(c.id, "a");
    const p = await proposeEdit(c.id, await take(c.id, a.id), a.id);
    expect(p.status).toBe("ready");
    const before = Date.now();
    expect((await api("POST", `/colonies/${c.id}/review/${p.id}`, { decision: "approve", reason: "looked at it", by: "matt" })).status).toBe(200);
    const after = await proposal(c.id, p.id);
    expect(after.status).toBe("ready");
    expect(after.approvedAt).toBeGreaterThanOrEqual(before);
    const queued = await rows<{ data: string }>(region(c.id, "src"), "SELECT data FROM lane WHERE id = ?", p.id);
    expect((JSON.parse(queued[0]!.data) as Proposal).approvedAt).toBe(after.approvedAt);
    // The lane's lineage context names that approval too, for the trunk writer.
    await tick(c.id, "src");
    const ctx = JSON.parse((await trunk(c.id).state()).contexts!.at(-1)!) as { decisions: Record<string, Array<{ layer: string; action: string }>> };
    expect(ctx.decisions[p.id]?.some((d) => d.layer === "human" && d.action === "approve")).toBe(true);
    // A lane that does not hold the change is left alone.
    expect(await region(c.id, "src").stampApproval(p.id, Date.now())).toBe(false);
  });
});
