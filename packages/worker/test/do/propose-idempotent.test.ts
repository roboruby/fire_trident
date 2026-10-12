import { describe, expect, it } from "vitest";
import type { Proposal } from "@fire_trident/core";
import { addAgent, addIntent, api, colony, fakeSha, newColony, proposal, take, tick, trunk } from "./helpers.ts";
import type { Assignment } from "./helpers.ts";

/** A proposal body for an assignment at a fixed head commit. */
async function body(colonyId: string, a: Assignment, agentId: string, headSha: string): Promise<Record<string, unknown>> {
  const paths = a.intent.footprint;
  return {
    intentId: a.intent.id,
    agentId,
    workspace: a.lease.repo,
    baseSha: a.lease.baseSha,
    headSha,
    writeSet: paths.map((path) => ({ path, blob: fakeSha() })),
    readSet: await trunk(colonyId).baseBlobs(a.lease.baseSha, paths),
    declared: { footprint: paths, summary: "edit" },
    evidence: { notVerified: "Not verified: anything beyond the edit" },
  };
}

describe("propose is idempotent per (agent, intent, head commit)", () => {
  it("returns the existing proposal for a retried propose, before and after it lands", async () => {
    const c = await newColony();
    await addIntent(c.id, ["src/lib/util.ts"]);
    const a = await addAgent(c.id, "a");
    const got = await take(c.id, a.id);
    const head = fakeSha();
    const first = await api<Proposal>("POST", `/colonies/${c.id}/proposals`, await body(c.id, got, a.id, head));
    expect(first.status).toBe(201);
    // A retry (new blob ids in the body do not matter: the head commit names the change).
    const again = await api<Proposal>("POST", `/colonies/${c.id}/proposals`, await body(c.id, got, a.id, head));
    expect(again.status).toBe(201);
    expect(again.body.id).toBe(first.body.id);
    const snap = await api<{ metrics: Record<string, number> }>("GET", `/colonies/${c.id}`);
    expect(snap.body.metrics["proposals"]).toBe(1);

    await tick(c.id, "src");
    expect((await proposal(c.id, first.body.id)).status).toBe("landed");
    // A late retry after the landing gets the landed proposal back instead of a 409.
    const late = await api<Proposal>("POST", `/colonies/${c.id}/proposals`, await body(c.id, got, a.id, head));
    expect(late.status).toBe(201);
    expect(late.body).toMatchObject({ id: first.body.id, status: "landed" });
  });

  it("treats a different head commit as a new proposal", async () => {
    const c = await newColony();
    await addIntent(c.id, ["src/lib/util.ts"]);
    const a = await addAgent(c.id, "a");
    const got = await take(c.id, a.id);
    const one = await api<Proposal>("POST", `/colonies/${c.id}/proposals`, await body(c.id, got, a.id, fakeSha()));
    const two = await api<Proposal>("POST", `/colonies/${c.id}/proposals`, await body(c.id, got, a.id, fakeSha()));
    expect(one.status).toBe(201);
    expect(two.status).toBe(201);
    expect(two.body.id).not.toBe(one.body.id);
  });

  it("lets the same commit be proposed again after a transient return", async () => {
    const c = await newColony();
    await addIntent(c.id, ["src/lib/util.ts"]);
    const a = await addAgent(c.id, "a");
    const got = await take(c.id, a.id);
    const head = fakeSha();
    const first = await api<Proposal>("POST", `/colonies/${c.id}/proposals`, await body(c.id, got, a.id, head));
    await colony(c.id).updateProposal(first.body.id, { status: "returned", reason: "lane unavailable: region timed out" });
    const again = await take(c.id, a.id);
    const retry = await api<Proposal>("POST", `/colonies/${c.id}/proposals`, await body(c.id, again, a.id, head));
    expect(retry.status).toBe(201);
    expect(retry.body.id).not.toBe(first.body.id);
    // A judged return is final for that commit: the retry gets the returned proposal back.
    await colony(c.id).updateProposal(retry.body.id, { status: "returned", reason: "stale: src/lib/util.ts changed" });
    const third = await take(c.id, a.id);
    const judged = await api<Proposal>("POST", `/colonies/${c.id}/proposals`, await body(c.id, third, a.id, head));
    expect(judged.body).toMatchObject({ id: retry.body.id, status: "returned" });
  });
});
