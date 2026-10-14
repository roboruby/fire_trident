import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { Proposal } from "@fire_trident/core";
import { addAgent, addIntent, api, colony, eventually, newColony, proposal, proposeEdit, region, take, tick, trunk } from "./helpers.ts";

/**
 * Protected paths reach changes already decided (colony/protect.ts), against the real ColonyDO and RegionDO: the
 * colony's sweep when a glob is protected, the lane's own check before it hands a batch to the trunk writer, and the
 * trunk writer's check at its commit point (the stand-in runs the same check, trunk/protect.ts), with the answer naming
 * what was stopped and what had already landed.
 */

const GLOB = "src/auth/**";
const PATH = "src/auth/x.ts";
const STOP = /^newly protected: src\/auth\/x\.ts \(protected by src\/auth\/\*\*\) became protected after this change was cleared to land/;

/** A change to src/auth/x.ts cleared to land and waiting in its lane (the harness runs without review). */
async function cleared() {
  const c = await newColony();
  const i = await addIntent(c.id, [PATH]);
  const a = await addAgent(c.id, "a");
  const p = await proposeEdit(c.id, await take(c.id, a.id), a.id);
  expect(p.status).toBe("ready");
  expect((await region(c.id, "src").status()).lane).toBe(1);
  return { c, i, a, p };
}

/** Wait until `check` passes, or fail. */
async function until<T>(read: () => Promise<T>, check: (v: T) => boolean, what: string): Promise<T> {
  const v = await eventually(read, check, 10_000);
  if (!check(v)) throw new Error(`timed out waiting for ${what}`);
  return v;
}

function protect(colonyId: string, globs: string[]) {
  return api("POST", `/colonies/${colonyId}/decide/policy`, { protectedPaths: globs });
}

describe("a newly protected path reaches changes already cleared to land", () => {
  it("stops a change waiting in its lane and sends it to a person, whose approval then lands it", async () => {
    const { c, i, p } = await cleared();
    const res = await protect(c.id, [GLOB]);
    expect(res.status).toBe(200);
    expect(res.body.protectedPaths).toEqual([GLOB]);
    expect(res.body.protection).toEqual({ added: [GLOB], stopped: [{ proposalId: p.id, intentId: i.id, path: PATH, glob: GLOB }], landed: [], confirmed: true });
    expect(await proposal(c.id, p.id)).toMatchObject({ status: "escalated", reason: expect.stringMatching(STOP) });
    expect((await region(c.id, "src").status()).lane).toBe(0);
    expect(((await api<Proposal[]>("GET", `/colonies/${c.id}/review`)).body ?? []).map((x) => x.id)).toContain(p.id);
    // The trunk writer keeps the colony's record, for every later cycle.
    expect(await trunk(c.id).protectRecord()).toEqual({ version: 1, globs: [{ glob: GLOB, at: expect.any(Number) }] });

    await tick(c.id, "src");
    expect((await trunk(c.id).state()).landings).toHaveLength(0);

    // A person approves: the lane and the trunk writer find an approval given after the glob was protected.
    expect((await api("POST", `/colonies/${c.id}/review/${p.id}`, { decision: "approve", reason: "read the auth change", by: "matt" })).status).toBe(200);
    expect((await proposal(c.id, p.id)).status).toBe("ready");
    await tick(c.id, "src");
    expect(await proposal(c.id, p.id)).toMatchObject({ status: "landed" });
    expect((await trunk(c.id).state()).landings.map((l) => l.proposalIds)).toEqual([[p.id]]);
  });

  it("the lane stops a covered change itself before it calls the trunk writer", async () => {
    const { c, i, p } = await cleared();
    // The record reaches the lane's lineage context while the colony's own sweep missed the change (a policy change racing the propose).
    const record = { version: 1, globs: [{ glob: GLOB, at: Date.now() }] };
    await runInDurableObject(colony(c.id), (_instance: unknown, state: DurableObjectState) => {
      state.storage.sql.exec("INSERT INTO decide_policy (k, v) VALUES ('meta:protected_paths', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", JSON.stringify(record));
    });
    expect((await colony(c.id).landContext([i.id], [], [p.id])).protect).toEqual(record);
    const calls = (await trunk(c.id).state()).contexts?.length ?? 0;

    await tick(c.id, "src");
    expect(await proposal(c.id, p.id)).toMatchObject({ status: "escalated", reason: expect.stringMatching(STOP) });
    expect((await region(c.id, "src").status()).lane).toBe(0);
    // The trunk writer never saw it.
    expect((await trunk(c.id).state()).contexts?.length ?? 0).toBe(calls);
    expect((await trunk(c.id).state()).landings).toHaveLength(0);
  });

  it("the trunk writer stops a change queued for its cycle when the protection is recorded before the cycle's check", async () => {
    const { c, i, p } = await cleared();
    await trunk(c.id).setReportLandings(false);
    await trunk(c.id).holdNextLand("read");
    // The lane checked its batch (nothing protected yet) and handed p to the writer, where it waits for a cycle.
    const ticking = tick(c.id, "src");
    await until(() => trunk(c.id).held(), (h) => h, "the lane's batch to wait for a cycle");
    const res = await protect(c.id, [GLOB]);
    expect(res.body.protection).toEqual({ added: [GLOB], stopped: [{ proposalId: p.id, intentId: i.id, path: PATH, glob: GLOB }], landed: [], confirmed: true });

    // The cycle reads the record before it builds: p goes back to a person, and trunk never gets it.
    await trunk(c.id).releaseLand();
    await ticking;
    expect((await trunk(c.id).state()).landings).toHaveLength(0);
    expect(await proposal(c.id, p.id)).toMatchObject({ status: "escalated", reason: expect.stringMatching(STOP) });
    expect((await region(c.id, "src").status()).lane).toBe(0);
  });

  it("names a change a cycle had already landed when the protection reached the trunk writer", async () => {
    const { c, i, p } = await cleared();
    await trunk(c.id).setReportLandings(false);
    await trunk(c.id).holdNextLand("push");
    const ticking = tick(c.id, "src");
    await until(() => trunk(c.id).held(), (h) => h, "the cycle to pass its checks");
    const protecting = protect(c.id, [GLOB]);
    await until(() => trunk(c.id).fenceWaiting(), (n) => n > 0, "the trunk writer to wait for the cycle");
    await trunk(c.id).releaseLand();
    const res = await protecting;
    await ticking;

    const landings = (await trunk(c.id).state()).landings;
    expect(landings.map((l) => l.proposalIds)).toEqual([[p.id]]);
    const l = landings[0]!;
    expect(res.status).toBe(200);
    expect(res.body.protection).toEqual({ added: [GLOB], stopped: [], landed: [{ proposalId: p.id, landingId: l.id, trunkSha: l.trunkSha, intentId: i.id, path: PATH, glob: GLOB }], confirmed: true });
    // Settled before the answer, and the change says why it landed without a person.
    expect(await proposal(c.id, p.id)).toMatchObject({
      status: "landed",
      landingId: l.id,
      reason: "landed before the protection of src/auth/x.ts (protected by src/auth/**) reached the trunk writer; ft revert undoes it",
    });
  });

  it("says unconfirmed when the trunk writer does not answer, and the colony's own stop stands", async () => {
    const { c, p } = await cleared();
    await trunk(c.id).failNextFences(1);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const res = await protect(c.id, [GLOB]);
      expect(res.status).toBe(200);
      expect(res.body.protection).toEqual({ added: [GLOB], stopped: [], landed: [], confirmed: false, unconfirmed: [p.id] });
    } finally {
      error.mockRestore();
    }
    expect(await proposal(c.id, p.id)).toMatchObject({ status: "escalated", reason: expect.stringMatching(STOP) });
    expect((await region(c.id, "src").status()).lane).toBe(0);
  });

  it("records a removal too, so a change to an unprotected path lands as before", async () => {
    const c = await newColony();
    expect((await protect(c.id, [GLOB])).body.protection).toEqual({ added: [GLOB], stopped: [], landed: [], confirmed: true });
    const off = await protect(c.id, []);
    expect(off.status).toBe(200);
    expect(off.body.protectedPaths).toEqual([]);
    expect(off.body.protection).toBeUndefined();
    expect(await trunk(c.id).protectRecord()).toEqual({ version: 2, globs: [] });
    // Unchanged globs leave everything as it was (no record move, no answer).
    expect((await api("POST", `/colonies/${c.id}/decide/policy`, { commentProof: false })).body.protection).toBeUndefined();
    expect(await trunk(c.id).protectRecord()).toEqual({ version: 2, globs: [] });

    await addIntent(c.id, [PATH]);
    const a = await addAgent(c.id, "a");
    const p = await proposeEdit(c.id, await take(c.id, a.id), a.id);
    expect(p.status).toBe("ready");
    await tick(c.id, "src");
    expect(await proposal(c.id, p.id)).toMatchObject({ status: "landed" });
  });
});
