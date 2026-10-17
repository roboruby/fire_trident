import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Proposal } from "@fire_trident/core";
import { addAgent, addIntent, api, colony, newColony, proposal, proposeEdit, take, tick, trunk } from "./helpers.ts";

/** The audit sample, the baseline stream and blind canaries through the colony and its API (colony/audit.ts, api/audit.ts). */

type Item = Proposal & { audit?: { kind: string; layer: string; rule: string; landedBy: string; landingId: string } };

/** The decide engine's store inside the colony object (the harness has no AI binding, so the engine decides nothing itself). */
type EngineStore = {
  recordOutcome(o: Record<string, unknown>): void;
  registerVaccine(intentId: string, cls: string, batch: string, now: number): void;
  linkVaccine(intentId: string, proposalId: string): void;
};
async function store<T>(colonyId: string, fn: (s: EngineStore, instance: unknown) => T): Promise<T> {
  return runInDurableObject(colony(colonyId), (instance: unknown) => fn((instance as { decider(): { store: EngineStore } }).decider().store, instance)) as Promise<T>;
}

/** One change to `path` that a model's approval landed through the lane (its outcome recorded as the engine would). */
async function landByModel(colonyId: string, agentId: string, path: string, layer = "llm"): Promise<Proposal> {
  await addIntent(colonyId, [path]);
  const p = await proposeEdit(colonyId, await take(colonyId, agentId), agentId);
  await store(colonyId, (s) => s.recordOutcome({ proposalId: p.id, region: "src", head: p.headSha, layer, action: "land", risk: 0, detectors: [], vaccine: false, state: null, at: Date.now() }));
  expect(await tick(colonyId, "src")).toBe(true);
  const landed = await proposal(colonyId, p.id);
  expect(landed.status).toBe("landed");
  return landed;
}

describe("the audit sample", () => {
  it("puts a landing without a person in the review queue after it landed, marked, and records a person's answer", async () => {
    const c = await newColony();
    const a = await addAgent(c.id, "a");
    const landed = await landByModel(c.id, a.id, "src/lib/util.ts");
    const queue = (await api<Item[]>("GET", `/colonies/${c.id}/review`, undefined, {})).body;
    expect(queue.map((p) => p.id)).toEqual([landed.id]);
    expect(queue[0]).toMatchObject({ status: "landed", audit: { kind: "audit", layer: "model", rule: "L3 innate+llm", landedBy: "Already landed by L3 innate+llm (a model's approval).", landingId: landed.landingId } });

    const wrong = await api("POST", `/colonies/${c.id}/audit/${landed.id}`, { verdict: "should-not-have-landed" });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toMatch(/say why it should not have landed/);
    const unauth = await api("POST", `/colonies/${c.id}/audit/${landed.id}`, { verdict: "fine" }, {});
    expect(unauth.status).toBe(401);
    const fine = await api("POST", `/colonies/${c.id}/audit/${landed.id}`, { verdict: "fine", by: "lee" });
    expect(fine.status).toBe(200);
    expect(fine.body.sentence).toBe(`Recorded as fine: ${landed.id} landed by L3 innate+llm (a model's approval) and should have.`);
    expect((await api("POST", `/colonies/${c.id}/audit/${landed.id}`, { verdict: "fine" })).status).toBe(409);
    expect((await api("POST", `/colonies/${c.id}/audit/prp_nope`, { verdict: "fine" })).status).toBe(404);
    expect((await api<Item[]>("GET", `/colonies/${c.id}/review`)).body).toEqual([]);

    const report = (await api("GET", `/colonies/${c.id}/audit`, undefined, {})).body;
    expect(report).toMatchObject({ rate: 0.03, landed: 1, audited: 1, fine: 1, waiting: [], line: "audited 1 of 1 landing without a person: 0 should not have landed (0–79%)" });
    expect(report.answered[0]).toMatchObject({ proposalId: landed.id, verdict: "fine", by: "lee" });
    const metrics = (await api("GET", `/colonies/${c.id}/metrics`, undefined, {})).body;
    expect(metrics.audit).toMatchObject({ audited: 1, line: report.line, canaries: { on: false, line: "canaries off" } });
    expect(metrics.audit.layers.model).toMatchObject({ audited: 1, fine: 1 });
    const decides = (await api("GET", `/colonies/${c.id}/decides`, undefined, {})).body;
    expect(decides.audit).toMatchObject({ line: report.line, rate: 0.03, audited: 1, canaries: "canaries off" });
  });

  it("should not have landed reverts on request and says so", async () => {
    const c = await newColony();
    const a = await addAgent(c.id, "a");
    const original = (await trunk(c.id).state()).files["src/lib/util.ts"]!.content;
    const landed = await landByModel(c.id, a.id, "src/lib/util.ts");
    expect((await trunk(c.id).state()).files["src/lib/util.ts"]!.content).not.toBe(original);
    const res = await api("POST", `/colonies/${c.id}/audit/${landed.id}`, { verdict: "should-not-have-landed", reason: "the helper was right before", by: "lee", revert: true });
    expect(res.status).toBe(200);
    expect(res.body.revert.landingId).toMatch(/^lnd_/);
    expect(res.body.sentence).toContain("Reverted as");
    expect((await trunk(c.id).state()).files["src/lib/util.ts"]!.content).toBe(original);
  });

  it("follows the policy's rate, and refuses a rate meant as a percent", async () => {
    const c = await newColony();
    expect((await api("POST", `/colonies/${c.id}/decide/policy`, { auditRate: 3 })).body.error).toMatch(/auditRate: must be a share from 0 to 0.2/);
    expect((await api("POST", `/colonies/${c.id}/decide/policy`, { auditRate: 0 })).status).toBe(200);
    const a = await addAgent(c.id, "a");
    await landByModel(c.id, a.id, "src/lib/util.ts");
    expect((await api<Item[]>("GET", `/colonies/${c.id}/review`)).body).toEqual([]);
    expect((await api("GET", `/colonies/${c.id}/audit`)).body).toMatchObject({ rate: 0, landed: 1, queued: 0, line: "audit sample off: 1 landing without a person, none put in front of a person" });
  });
});

describe("blind canaries", () => {
  /** A change in the human queue that is a canary: sealed in the vaccine registry, nothing on its queue item says so. */
  async function canaryInQueue(colonyId: string, agentId: string): Promise<Proposal> {
    await addIntent(colonyId, ["src/lib/util.ts"]);
    const p = await proposeEdit(colonyId, await take(colonyId, agentId), agentId);
    await store(colonyId, (s, instance) => {
      s.registerVaccine(p.intentId, "secret-log", "canary", Date.now());
      s.linkVaccine(p.intentId, p.id);
      (instance as { audits(): { store: { addCanary(i: string, cls: string, t: string, at: number): void; linkCanary(i: string, p: string): void } } }).audits().store.addCanary(p.intentId, "secret-log", "prp_trigger", Date.now());
    });
    await colony(colonyId).updateProposals([{ id: p.id, patch: { status: "escalated", reason: "escalated by deterministic: danger patterns need a human: secret" } }]);
    return p;
  }

  it("an approved canary is revealed in the answer, sealed, and never lands", async () => {
    const c = await newColony();
    const a = await addAgent(c.id, "a");
    const before = (await trunk(c.id).state()).head;
    const p = await canaryInQueue(c.id, a.id);
    // Until it is decided, its queue item is an escalation like any other.
    const queue = (await api<Item[]>("GET", `/colonies/${c.id}/review`)).body;
    expect(queue.map((x) => x.id)).toEqual([p.id]);
    expect(queue[0]).not.toHaveProperty("audit");
    expect(JSON.stringify(queue[0])).not.toMatch(/canary/i);

    const res = await api("POST", `/colonies/${c.id}/review/${p.id}`, { decision: "approve", by: "lee" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, canary: { proposalId: p.id, outcome: "approved", cls: "secret-log" } });
    expect(res.body.canary.sentence).toMatch(/^This was a canary, not a real change: .* it was sealed and can never land/);
    expect((await proposal(c.id, p.id)).status).toBe("rejected");
    await tick(c.id, "src");
    expect((await proposal(c.id, p.id)).status).toBe("rejected");
    expect((await trunk(c.id).state()).head).toBe(before);
    const metrics = (await api("GET", `/colonies/${c.id}/metrics`)).body;
    expect(metrics.audit.canaries).toMatchObject({ decided: 1, approved: 1, caught: 0, catchRate: 0 });
  });

  it("a rejected canary is a catch; a person turns canaries on before one can be made", async () => {
    const c = await newColony();
    const a = await addAgent(c.id, "a");
    const p = await canaryInQueue(c.id, a.id);
    const res = await api("POST", `/colonies/${c.id}/review/${p.id}`, { decision: "reject", reason: "logs a token", by: "lee" });
    expect(res.body).toMatchObject({ ok: true, canary: { outcome: "caught" } });
    expect((await api("GET", `/colonies/${c.id}/audit`)).body.canaries).toMatchObject({ decided: 1, caught: 1, catchRate: 1, revealed: [{ proposalId: p.id, outcome: "caught", by: "lee" }] });
    const off = await api("POST", `/colonies/${c.id}/canaries`, {});
    expect(off.status).toBe(409);
    expect(off.body.error).toMatch(/canaries are off in this colony/);
  });

  it("an ordinary escalation is decided as before", async () => {
    const c = await newColony();
    const a = await addAgent(c.id, "a");
    await addIntent(c.id, ["src/lib/util.ts"]);
    const p = await proposeEdit(c.id, await take(c.id, a.id), a.id);
    await colony(c.id).updateProposals([{ id: p.id, patch: { status: "escalated" } }]);
    const res = await api("POST", `/colonies/${c.id}/review/${p.id}`, { decision: "approve", by: "lee" });
    expect(res.body).toEqual({ ok: true });
    expect((await proposal(c.id, p.id)).status).toBe("ready");
  });
});
