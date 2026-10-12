import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Intent } from "@fire_trident/core";
import type { TakeResult } from "../../src/colony/ColonyDO.ts";
import { addAgent, addIntent, api, colony, newColony, proposeEdit, region, take, tick } from "./helpers.ts";

/**
 * Lateral inhibition in ColonyDO.take: an open intent whose own files another agent holds a live
 * claim on (at least half a fresh claim) is skipped, not merely repelled. It is suppression, not a
 * lock: it ends when the claim lands, is released, or decays. Self-assignment is deterministic in
 * these tests (the best candidate is always accepted).
 */
const SHARED = "src/app/shared.ts";
const INHIBITED = "every open intent's files are claimed by another agent";

async function tryTake(colonyId: string, agentId: string): Promise<TakeResult> {
  const res = await api<TakeResult>("POST", `/colonies/${colonyId}/agents/${agentId}/take`);
  expect(res.status).toBe(200);
  return res.body;
}

async function status(colonyId: string, intentId: string): Promise<string | undefined> {
  return ((await colony(colonyId).getIntent(intentId)) as Intent | null)?.status;
}

/** The colony caches region readings for 250 ms; wait past it so the next take reads the field again. */
const pastReadingCache = (): Promise<void> => new Promise((r) => setTimeout(r, 300));

describe("lateral inhibition", () => {
  it("skips an intent whose files another agent claims, whatever its priority", async () => {
    const c = await newColony();
    const x = await addIntent(c.id, [SHARED, "src/app/a.ts"], { priority: 5 });
    const y = await addIntent(c.id, [SHARED, "src/app/b.ts"], { priority: 4 });
    const [a, b] = [await addAgent(c.id, "a"), await addAgent(c.id, "b")];
    expect((await take(c.id, a.id)).intent.id).toBe(x.id);
    // Soft repulsion alone would let B take Y (stimulus 4 - 1 > 0); inhibition keeps it off.
    expect(await tryTake(c.id, b.id)).toMatchObject({ wait: true, reason: INHIBITED });
    expect(await status(c.id, y.id)).toBe("open");
    const docs = await addIntent(c.id, ["docs/guide.md"], { priority: 1 });
    expect((await take(c.id, b.id)).intent.id).toBe(docs.id);
  });

  it("takes the intent once the first claim lands", async () => {
    const c = await newColony();
    const x = await addIntent(c.id, [SHARED, "src/app/a.ts"], { priority: 5 });
    const y = await addIntent(c.id, [SHARED, "src/app/b.ts"], { priority: 4 });
    const [a, b] = [await addAgent(c.id, "a"), await addAgent(c.id, "b")];
    const got = await take(c.id, a.id);
    expect(got.intent.id).toBe(x.id);
    expect(await tryTake(c.id, b.id)).toMatchObject({ wait: true, reason: INHIBITED });
    await proposeEdit(c.id, got, a.id);
    // The claim holds while the proposal waits in its lane.
    await pastReadingCache();
    expect(await tryTake(c.id, b.id)).toMatchObject({ wait: true, reason: INHIBITED });
    await tick(c.id, "src");
    expect(await status(c.id, x.id)).toBe("landed");
    await pastReadingCache();
    expect((await take(c.id, b.id)).intent.id).toBe(y.id);
  });

  it("lets a silent agent's claim go once it decays below half a fresh claim", async () => {
    const c = await newColony();
    const y = await addIntent(c.id, [SHARED, "src/app/b.ts"], { priority: 4 });
    const b = await addAgent(c.id, "b");
    const ghost = { kind: "claim" as const, path: SHARED, strength: 1, agentId: "agt_ghost", intentId: "int_ghost" };
    // Last refreshed 2 minutes ago: exp(-2/5) = 0.67 of a fresh claim still inhibits.
    await region(c.id, "src").deposit([{ ...ghost, at: Date.now() - 2 * 60_000 }]);
    expect(await tryTake(c.id, b.id)).toMatchObject({ wait: true, reason: INHIBITED });
    // Last refreshed 4 minutes ago: 0.45 only repels (stimulus 4 - 0.45 > 0), so B takes Y.
    await region(c.id, "src").deposit([{ ...ghost, at: Date.now() - 4 * 60_000 }]);
    await pastReadingCache();
    expect((await take(c.id, b.id)).intent.id).toBe(y.id);
  });

  it("never assigns two intents that share a file in a burst of concurrent takes", async () => {
    const c = await newColony();
    const stub = colony(c.id);
    for (let i = 0; i < 6; i++) await addIntent(c.id, [SHARED, `src/app/f${i}.ts`], { priority: 1 });
    const agents = await stub.registerAgents(Array.from({ length: 6 }, (_, i) => ({ kind: "synthetic" as const, name: `s${i}` })));
    const results = (await Promise.all(agents.map((a) => stub.take(a.id)))) as TakeResult[];
    const assigned = results.filter((r) => "intent" in r);
    expect(assigned).toHaveLength(1);
    const reasons = new Set(results.filter((r): r is Extract<TakeResult, { wait: true }> => "wait" in r).map((r) => r.reason));
    expect(reasons).toEqual(new Set([INHIBITED]));
  });

  it("does not inhibit on co-change neighbors or directory overlaps (they only repel)", async () => {
    const c = await newColony();
    const x = await addIntent(c.id, ["src/app/"], { priority: 5 });
    const y = await addIntent(c.id, [SHARED], { priority: 4 });
    const [a, b] = [await addAgent(c.id, "a"), await addAgent(c.id, "b")];
    expect((await take(c.id, a.id)).intent.id).toBe(x.id);
    // A claims the directory src/app/: Y's file is inside it, but not the same entry.
    expect((await take(c.id, b.id)).intent.id).toBe(y.id);
  });

  it("turns off with FT_LATERAL_INHIBITION=off", async () => {
    const c = await newColony();
    await runInDurableObject(colony(c.id), (instance) => {
      const self = instance as unknown as { env: object };
      self.env = new Proxy(self.env, { get: (t, k) => (k === "FT_LATERAL_INHIBITION" ? "off" : Reflect.get(t, k)) });
    });
    const x = await addIntent(c.id, [SHARED, "src/app/a.ts"], { priority: 5 });
    const y = await addIntent(c.id, [SHARED, "src/app/b.ts"], { priority: 4 });
    const [a, b] = [await addAgent(c.id, "a"), await addAgent(c.id, "b")];
    expect((await take(c.id, a.id)).intent.id).toBe(x.id);
    expect((await take(c.id, b.id)).intent.id).toBe(y.id);
  });
});
