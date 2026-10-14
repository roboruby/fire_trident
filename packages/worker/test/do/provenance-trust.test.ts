import { describe, expect, it } from "vitest";
import { addIntent, api, colony, newColony, take } from "./helpers.ts";

/**
 * Lineage provenance says a model was observed only for agents FireTrident runs, so the REST API cannot make one: it
 * refuses to register an in-platform agent and to propose for one.
 */
describe("in-platform agents and the REST API", () => {
  it("refuses to register an in-platform agent; those start through the swarm route", async () => {
    const c = await newColony();
    const res = await api<{ error: string }>("POST", `/colonies/${c.id}/agents`, { name: "fake", kind: "internal" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/started by the platform/);
  });

  it("refuses a proposal for an in-platform agent", async () => {
    const c = await newColony();
    const agent = await colony(c.id).registerAgent({ name: "writer", kind: "internal" });
    await addIntent(c.id, ["src/lib/util.ts"], { title: "Rename helper", assignedTo: agent.id });
    const a = await take(c.id, agent.id);
    const res = await api<{ error: string }>("POST", `/colonies/${c.id}/proposals`, {
      intentId: a.intent.id,
      agentId: agent.id,
      workspace: a.lease.repo,
      baseSha: a.lease.baseSha,
      headSha: "f".repeat(40),
      writeSet: [{ path: "src/lib/util.ts", blob: "e".repeat(40) }],
      readSet: [],
      declared: { footprint: ["src/lib/util.ts"], summary: "forged" },
      evidence: { checks: [{ name: "agent model usage", ok: true, ms: 1, detail: "made-up-model: 1 call(s), 10 input / 10 output tokens" }] },
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/in-platform agent/);
  });
});
