import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { NameAssumption, Proposal } from "@fire_trident/core";
import { addAgent, addIntent, eventually, externalLanding, newColony, proposal, proposeEdit, region, rows, take, tick, trunk } from "./helpers.ts";

const UTIL = "src/lib/util.ts";

/** Set FT_REVALIDATE as one lane sees it (the harness binds none, so revalidation is off by default). */
async function setRevalidate(colonyId: string, name: string, value: string): Promise<void> {
  await runInDurableObject(region(colonyId, name), (instance) => {
    const i = instance as unknown as { env: Record<string, unknown> };
    i.env = { ...i.env, FT_REVALIDATE: value };
  });
}

/**
 * A reader in the src lane: it read src/lib/util.ts, then util.ts changed on trunk before its lane
 * ticked. Its queued copy carries `nameAssumptions` (the decide stage records them; the harness has no
 * Workers AI, so the test queues them itself).
 */
async function staleReader(assumptions: NameAssumption[] | null): Promise<{ colonyId: string; p: Proposal }> {
  const c = await newColony();
  const agent = await addAgent(c.id, "reader");
  await addIntent(c.id, ["src/app/reader.ts"], { assignedTo: agent.id });
  const a = await take(c.id, agent.id);
  const read = await trunk(c.id).baseBlobs(a.lease.baseSha, [UTIL]);
  const p = await proposeEdit(c.id, a, agent.id, { readSet: read });
  expect(p.status).toBe("ready");
  await externalLanding(c.id, { [UTIL]: "export function helper() {\n  return 2;\n}\nexport const added = 1;\n" });
  if (assumptions) await region(c.id, "src").enqueue({ ...p, nameAssumptions: assumptions }, 1);
  return { colonyId: c.id, p };
}

describe("assumption revalidation in the lane (FT_REVALIDATE)", () => {
  it("off: a change whose read file moved goes back as stale, assumptions or not", async () => {
    const { colonyId, p } = await staleReader([{ path: UTIL, names: ["helper"] }]);
    await tick(colonyId, "src");
    const after = await proposal(colonyId, p.id);
    expect(after.status).toBe("returned");
    expect(after.reason).toMatch(/^stale: 1 path changed on trunk since read: src\/lib\/util\.ts/);
    expect((await trunk(colonyId).state()).landings.some((l) => l.proposalIds.includes(p.id))).toBe(false);
  });

  it("on for the colony: a change stale only through a covered read file goes on to the trunk writer", async () => {
    const { colonyId, p } = await staleReader([{ path: UTIL, names: ["helper"] }]);
    await setRevalidate(colonyId, "src", `other-colony,${colonyId}`);
    await tick(colonyId, "src");
    expect((await trunk(colonyId).state()).landings.some((l) => l.proposalIds.includes(p.id))).toBe(true);
    expect((await proposal(colonyId, p.id)).status).toBe("landed");
  });

  it("on for another colony only: it goes back as today", async () => {
    const { colonyId, p } = await staleReader([{ path: UTIL, names: ["helper"] }]);
    await setRevalidate(colonyId, "src", "other-colony");
    await tick(colonyId, "src");
    expect((await proposal(colonyId, p.id)).status).toBe("returned");
  });

  it("on: a change without a name assumption for the moved file goes back as today", async () => {
    const { colonyId, p } = await staleReader(null);
    await setRevalidate(colonyId, "src", "on");
    await tick(colonyId, "src");
    const after = await proposal(colonyId, p.id);
    expect(after.status).toBe("returned");
    expect(after.reason).toMatch(/^stale: /);
  });

  it("on: a candidate the trunk writer sends back is a stale return caused by the landing that moved the file", async () => {
    const { colonyId, p } = await staleReader([{ path: UTIL, names: ["helper"] }]);
    await setRevalidate(colonyId, "src", "on");
    await trunk(colonyId).returnOnLand([p.id]);
    await tick(colonyId, "src");
    expect((await proposal(colonyId, p.id)).status).toBe("returned");
    const causes = await eventually(
      () => rows<{ id: string; cause_id: string | null }>(region(colonyId, "src"), "SELECT id, cause_id FROM causes WHERE id = ?", `ret:${p.id}`),
      (rs) => rs.length === 1,
    );
    expect(causes[0]!.cause_id).toMatch(/^land:lnd_external_/);
  });
});
