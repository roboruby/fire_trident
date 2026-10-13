import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ColonySnapshot } from "@fire_trident/core";
import { addAgent, addIntent, api, colony, externalLanding, newColony, take, trunk } from "./helpers.ts";

/**
 * The base given to leases with asynchronous publishing (FT_ASYNC_PUBLISH): agents clone or read the trunk repository at
 * it, so it is the trunk writer's published head, which the colony's trunk head can run ahead of. The trunk writer here
 * is the harness's stand-in; test/do/publish.test.ts shows the real one's published head.
 */

/** Set FT_ASYNC_PUBLISH on one colony's object (the harness binds no such variable). */
async function setPublishFlag(colonyId: string, value: string | undefined): Promise<void> {
  await runInDurableObject(colony(colonyId), (instance) => {
    const o = instance as unknown as { env: Record<string, unknown> };
    o.env = { ...o.env, FT_ASYNC_PUBLISH: value };
  });
}

/** A colony whose trunk writer recorded a landing it has not published: the colony's head runs one commit ahead. */
async function recordedAhead(flag: string | undefined): Promise<{ colonyId: string; published: string; recorded: string }> {
  const c = await newColony();
  await setPublishFlag(c.id, flag === undefined ? undefined : flag === "self" ? c.id : flag);
  const recorded = await externalLanding(c.id, { "src/lib/util.ts": "export function helper() {\n  return 2;\n}\n" });
  await trunk(c.id).setPublished(c.trunkSha);
  expect((await colony(c.id).getColony())!.trunkSha).toBe(recorded);
  await addIntent(c.id, ["src/app/main.ts"]);
  await addIntent(c.id, ["docs/guide.md"]);
  return { colonyId: c.id, published: c.trunkSha, recorded };
}

describe("leases with asynchronous publishing (FT_ASYNC_PUBLISH)", () => {
  it("start from the trunk writer's published head, never a commit only recorded, and the status names both heads", async () => {
    for (const flag of ["on", "self"]) {
      const { colonyId, published, recorded } = await recordedAhead(flag);
      const a = await addAgent(colonyId, "a");
      const got = await take(colonyId, a.id);
      expect(got.lease.baseSha).toBe(published);
      expect(got.lease.trunk.sha).toBe(published);
      // The colony's status carries the published head and the publish queue.
      const snap = (await api<ColonySnapshot>("GET", `/colonies/${colonyId}`)).body;
      expect(snap.colony.trunkSha).toBe(recorded);
      expect(snap.colony.publish).toMatchObject({ on: true, publishedSha: published, trunkSha: recorded, unpublished: 1 });
    }
  });

  it("asks the trunk writer at most once a second, and keeps the last answer while a newer one fails", async () => {
    const { colonyId, published } = await recordedAhead("on");
    const a = await addAgent(colonyId, "a");
    const b = await addAgent(colonyId, "b");
    const t0 = Date.now();
    const leases = await Promise.all([take(colonyId, a.id), take(colonyId, b.id)]);
    const elapsed = Date.now() - t0;
    expect(leases.map((x) => x.lease.baseSha)).toEqual([published, published]);
    // One read serves every lease for a second (a slow run may start one more).
    expect((await trunk(colonyId).state()).publishStateCalls).toBeLessThanOrEqual(1 + Math.floor(elapsed / 1_000));
    // Past a second the trunk writer is asked again; when it cannot answer, the last published head still serves.
    await trunk(colonyId).setPublished("fail");
    await new Promise((r) => setTimeout(r, 1_100));
    const c = await addAgent(colonyId, "c");
    await addIntent(colonyId, ["README.md"]);
    expect((await take(colonyId, c.id)).lease.baseSha).toBe(published);
  });

  it("makes a take wait when the trunk writer cannot name its published head and none is known yet", async () => {
    const { colonyId } = await recordedAhead("on");
    await trunk(colonyId).setPublished("fail");
    const a = await addAgent(colonyId, "a");
    const res = await api<{ wait?: boolean; reason?: string }>("POST", `/colonies/${colonyId}/agents/${a.id}/take`);
    expect(res.status).toBe(200);
    expect(res.body.wait).toBe(true);
    expect(res.body.reason).toMatch(/^lease failed: simulated publish state failure/);
  });

  it("changes nothing with publishing off (absent, off, or on for another colony): leases start from the colony's head", async () => {
    for (const flag of [undefined, "off", "col_other"]) {
      const { colonyId, recorded } = await recordedAhead(flag);
      const a = await addAgent(colonyId, "a");
      expect((await take(colonyId, a.id)).lease.baseSha).toBe(recorded);
      const snap = (await api<ColonySnapshot>("GET", `/colonies/${colonyId}`)).body;
      expect(snap.colony.publish).toBeUndefined();
      expect((await trunk(colonyId).state()).publishStateCalls ?? 0).toBe(0);
    }
  });
});

describe("takes that would start on a stale base (FT_ASYNC_PUBLISH)", () => {
  it("wait while a recorded landing on the intent's files is unpublished, then lease from the head that has it", async () => {
    const c = await newColony();
    await setPublishFlag(c.id, "on");
    const recorded = await externalLanding(c.id, { "src/lib/util.ts": "export function helper() {\n  return 2;\n}\n" });
    await trunk(c.id).setPublished(c.trunkSha);
    await addIntent(c.id, ["src/lib/util.ts"]);
    const a = await addAgent(c.id, "a");

    const waited = await api<{ wait?: true; retryInMs?: number; reason?: string }>("POST", `/colonies/${c.id}/agents/${a.id}/take`);
    expect(waited.status).toBe(200);
    expect(waited.body).toMatchObject({ wait: true });
    expect(waited.body.reason).toMatch(/publish a landing that changed src\/lib\/util\.ts/);
    expect(waited.body.retryInMs).toBeLessThan(1_000);

    // Published: a later take leases from the head with the landing (the colony serves its cached published head while it
    // asks again, so the agent may wait one more round, as it would after any wait).
    await trunk(c.id).setPublished(recorded);
    let base: string | null = null;
    for (let i = 0; i < 6 && base === null; i++) {
      await new Promise((r) => setTimeout(r, 600));
      const res = await api<{ wait?: true; lease?: { baseSha: string } }>("POST", `/colonies/${c.id}/agents/${a.id}/take`);
      base = res.body.lease?.baseSha ?? null;
    }
    expect(base).toBe(recorded);
  });

  it("lease at once for intents on other files", async () => {
    const c = await newColony();
    await setPublishFlag(c.id, "on");
    await externalLanding(c.id, { "src/lib/util.ts": "export function helper() {\n  return 2;\n}\n" });
    await trunk(c.id).setPublished(c.trunkSha);
    await addIntent(c.id, ["docs/guide.md"]);
    const a = await addAgent(c.id, "a");
    expect((await take(c.id, a.id)).lease.baseSha).toBe(c.trunkSha);
  });
});
