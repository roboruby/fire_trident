import { describe, expect, it } from "vitest";
import { blobId, changesetId } from "@fire_trident/core";
import type { FileVersion, Path, Proposal } from "@fire_trident/core";
import type { Assignment } from "./helpers.ts";
import { addAgent, addIntent, api, colony, newColony, proposal, take } from "./helpers.ts";

/** A well-formed inline change for an assignment (so innate checks pass and only the policy decides). */
function inlineChange(colonyId: string, a: Assignment, agentId: string, path: Path, text: string) {
  const writeSet: FileVersion[] = [{ path, blob: blobId(text) }];
  return {
    colonyId,
    intentId: a.intent.id,
    agentId,
    workspace: a.lease.repo,
    baseSha: a.lease.baseSha,
    headSha: changesetId(a.lease.baseSha, writeSet),
    writeSet,
    readSet: [],
    declared: { footprint: a.intent.footprint, summary: "inline" },
    evidence: { notVerified: "Not verified: anything beyond the edit" },
    contents: { [blobId(text)]: text },
  };
}

/** Protected paths need a person even when the colony runs without review (no models, or review turned off). */
describe("protected paths with review off", () => {
  it("sends a change to a protected path to a person, and lets other changes through to their lane", async () => {
    const c = await newColony();
    expect((await api("POST", `/colonies/${c.id}/decide/policy`, { enabled: false, protectedPaths: ["src/secret/**"] })).status).toBe(200);
    const agent = await addAgent(c.id, "a");

    await addIntent(c.id, ["src/secret/key.ts"]);
    const a = await take(c.id, agent.id);
    const guarded = (await colony(c.id).propose(inlineChange(c.id, a, agent.id, "src/secret/key.ts", "export const keyName = \"K\";\n"))) as Proposal;
    let p = await proposal(c.id, guarded.id);
    for (let i = 0; i < 60 && p.status === "checking"; i++) {
      await new Promise((r) => setTimeout(r, 50));
      p = await proposal(c.id, guarded.id);
    }
    expect(`${p.status}: ${p.reason ?? ""}`).toMatch(/^escalated: .*src\/secret\/\*\*/);

    const other = await addAgent(c.id, "b");
    await addIntent(c.id, ["src/lib/util.ts"]);
    const b = await take(c.id, other.id);
    const open = (await colony(c.id).propose(inlineChange(c.id, b, other.id, "src/lib/util.ts", "export const x = 1;\n"))) as Proposal;
    expect(open.status).toBe("ready");
  });
});
