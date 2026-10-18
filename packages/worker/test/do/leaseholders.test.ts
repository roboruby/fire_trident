import { describe, expect, it } from "vitest";
import { addAgent, addIntent, colony, newColony, proposal, proposeEdit, take, tick } from "./helpers.ts";

/**
 * The colony's answer to the workspace pool's lease sweep (ColonyDO.leaseHolders, pool/upkeep.ts), against the real
 * ColonyDO: an agent holds its workspace from its take until its change lands, and an unknown agent holds none.
 */

describe("ColonyDO.leaseHolders", () => {
  it("names the agents that hold a workspace, and none once their work ended", async () => {
    const c = await newColony();
    await addIntent(c.id, ["src/lib/util.ts"]);
    const a = await addAgent(c.id, "a");
    const idle = await addAgent(c.id, "idle");
    expect(await colony(c.id).leaseHolders([a.id, idle.id, "agt_unknown"])).toEqual([]);
    const got = await take(c.id, a.id);
    expect(await colony(c.id).leaseHolders([a.id, idle.id, "agt_unknown"])).toEqual([a.id]);
    const p = await proposeEdit(c.id, got, a.id);
    await tick(c.id, "src");
    expect((await proposal(c.id, p.id)).status).toBe("landed");
    expect(await colony(c.id).leaseHolders([a.id])).toEqual([]);
  });
});
