import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { AgentInfo, ColonySnapshot, FieldReading, Intent, Proposal } from "@fire_trident/core";
import {
  addAgent,
  addIntent,
  api,
  colony,
  eventually,
  externalLanding,
  fakeSha,
  headSha,
  newColony,
  pool,
  proposal,
  proposeEdit,
  region,
  rows,
  take,
  tick,
  trunk,
} from "./helpers.ts";

async function reading(colonyId: string, name: string): Promise<FieldReading> {
  return (await region(colonyId, name).reading()) as FieldReading;
}

async function intent(colonyId: string, id: string): Promise<Intent> {
  return (await colony(colonyId).getIntent(id)) as Intent;
}

async function agent(colonyId: string, id: string): Promise<AgentInfo> {
  return (await colony(colonyId).getAgent(id)) as AgentInfo;
}

describe("take → propose → lane → landing", () => {
  it("runs one intent end to end", async () => {
    const c = await newColony();
    const i = await addIntent(c.id, ["src/lib/util.ts"], { priority: 2 });
    const a = await addAgent(c.id, "a");

    const got = await take(c.id, a.id);
    expect(got.intent).toMatchObject({ id: i.id, status: "claimed", assignedTo: a.id });
    expect(got.lease.baseSha).toBe(c.trunkSha);
    expect(got.lease.trunk.sha).toBe(c.trunkSha);
    expect(got.rule).toBeUndefined();

    // The public snapshot never carries lease tokens.
    const held = (await api<ColonySnapshot>("GET", `/colonies/${c.id}`)).body.agents.find((x) => x.id === a.id)!;
    expect(held).toMatchObject({ state: "working", intentId: i.id });
    expect(held.workspace!.repo).toEqual(got.lease.repo);
    expect(held.workspace!.token).toBe("");
    expect(held.workspace!.trunk.token).toBe("");

    // Claims are in the field; the agent is the region's only active agent.
    const claimed = await reading(c.id, "src");
    expect(claimed.byPath["src/lib/util.ts"]).toMatchObject({ need: 2 });
    expect(claimed.byPath["src/lib/util.ts"]!.claim).toBeCloseTo(1, 3);
    expect(claimed.agents).toEqual([{ agentId: a.id, intentId: i.id, paths: ["src/lib/util.ts"] }]);
    expect(claimed.admission.activeAgents).toBe(1);
    // The agent's own claims do not repel it.
    const own = (await region(c.id, "src").reading({ excludeAgentId: a.id, paths: ["src/lib/util.ts"] })) as FieldReading;
    expect(own.byPath["src/lib/util.ts"]).toEqual({ need: 2 });
    expect(own.admission.activeAgents).toBe(0);

    // A repeated take hands back the same assignment; another agent finds nothing open.
    expect((await take(c.id, a.id)).intent.id).toBe(i.id);
    const b = await addAgent(c.id, "b");
    const waitB = await api("POST", `/colonies/${c.id}/agents/${b.id}/take`);
    expect(waitB.body).toMatchObject({ wait: true, reason: "no open intents" });

    const p = await proposeEdit(c.id, got, a.id);
    expect(p).toMatchObject({ status: "ready", intentId: i.id, agentId: a.id, colonyId: c.id });
    expect(p.evidence).toEqual({ checks: [], residual: [], notVerified: "Not verified: behavior beyond the checks listed" });
    expect((await intent(c.id, i.id)).status).toBe("proposed");
    expect((await agent(c.id, a.id)).state).toBe("proposing");
    expect((await region(c.id, "src").status()).lane).toBe(1);

    expect(await tick(c.id, "src")).toBe(true);

    const landed = await proposal(c.id, p.id);
    expect(landed.status).toBe("landed");
    expect(landed.landingId).toMatch(/^lnd_/);
    expect((await intent(c.id, i.id)).status).toBe("landed");
    const after = await agent(c.id, a.id);
    expect(after.state).toBe("idle");
    expect(after.intentId).toBeUndefined();
    expect(after.thresholds["src"]).toBeCloseTo(0.8, 6);
    expect((await colony(c.id).getColony())!.trunkSha).toBe(await headSha(c.id));

    // The field: need met, claim gone, a trail left behind.
    const field = await reading(c.id, "src");
    expect(field.byPath["src/lib/util.ts"]!.need).toBeUndefined();
    expect(field.byPath["src/lib/util.ts"]!.claim).toBeUndefined();
    expect(field.byPath["src/lib/util.ts"]!.trail).toBeCloseTo(1, 3);
    expect(field.agents).toEqual([]);
    expect(field.admission.landingsPerMin).toBe(1);
    expect((await region(c.id, "src").status()).lane).toBe(0);

    // Reported twice (lane + trunk) but counted once.
    const snap = await api<ColonySnapshot>("GET", `/colonies/${c.id}`);
    expect(snap.body.metrics).toMatchObject({ landings: 1, landedProposals: 1, landedIntents: 1, takes: 1, proposals: 1, landingsPerMin: 1 });
    expect(snap.body.recentLandings).toHaveLength(1);
    const released = await eventually(() => pool(c.id).state(), (s) => s.released.includes(a.id));
    expect(released.released).toContain(a.id);
  });

  it("returns a stale proposal with the exact paths and reopens its intent", async () => {
    const c = await newColony();
    const i = await addIntent(c.id, ["src/lib/util.ts"]);
    const a = await addAgent(c.id);
    const got = await take(c.id, a.id);
    // Trunk moves under the agent before it proposes.
    await externalLanding(c.id, { "src/lib/util.ts": "export const changed = true;\n" });
    const p = await proposeEdit(c.id, got, a.id);
    await tick(c.id, "src");

    const back = await proposal(c.id, p.id);
    expect(back.status).toBe("returned");
    expect(back.reason).toMatch(/^stale: 1 path changed on trunk since read: src\/lib\/util\.ts \(expected [0-9a-f]{10}, trunk [0-9a-f]{10}\)$/);
    const reopened = await intent(c.id, i.id);
    expect(reopened.status).toBe("open");
    expect(reopened.assignedTo).toBeUndefined();
    expect((await agent(c.id, a.id)).state).toBe("idle");
    const field = await reading(c.id, "src");
    expect(field.byPath["src/lib/util.ts"]).toMatchObject({ need: 1 });
    expect(field.byPath["src/lib/util.ts"]!.claim).toBeUndefined();
    expect(field.byPath["src/lib/util.ts"]!.failure).toBeCloseTo(0.5, 3);

    // A duplicate report (trunk and lane both) does not stack another failure mark.
    await colony(c.id).updateProposal(p.id, { status: "returned", reason: "again" });
    expect((await reading(c.id, "src")).byPath["src/lib/util.ts"]!.failure).toBeCloseTo(0.5, 3);
    expect((await proposal(c.id, p.id)).reason).toContain("stale:");

    // The intent can be taken again and lands this time.
    const again = await take(c.id, a.id);
    expect(again.intent.id).toBe(i.id);
    const p2 = await proposeEdit(c.id, again, a.id);
    await tick(c.id, "src");
    expect((await proposal(c.id, p2.id)).status).toBe("landed");
  });

  it("lands disjoint proposals in one commit and defers an overlapping one", async () => {
    const c = await newColony();
    // Two agents write the same file on purpose: lateral inhibition (on by default) would keep b off i1.
    await runInDurableObject(colony(c.id), (instance) => {
      const self = instance as unknown as { env: object };
      self.env = new Proxy(self.env, { get: (t, k) => (k === "FT_LATERAL_INHIBITION" ? "off" : Reflect.get(t, k)) });
    });
    const i1 = await addIntent(c.id, ["src/lib/util.ts"], { priority: 3 });
    const i2 = await addIntent(c.id, ["src/app/main.ts"], { priority: 2 });
    const i3 = await addIntent(c.id, ["src/lib/util.ts"], { priority: 5 });
    const [a, b, d] = [await addAgent(c.id, "a"), await addAgent(c.id, "b"), await addAgent(c.id, "d")];
    const ta = await take(c.id, a.id); // highest stimulus: i3 (5)
    const tb = await take(c.id, b.id); // i1 is repelled by a's claim on util.ts: 3 - 1 = 2, ties with i2 (2) in input order
    const td = await take(c.id, d.id);
    expect(ta.intent.id).toBe(i3.id);
    expect(new Set([tb.intent.id, td.intent.id])).toEqual(new Set([i1.id, i2.id]));

    const pa = await proposeEdit(c.id, ta, a.id);
    const pb = await proposeEdit(c.id, tb, b.id);
    const pd = await proposeEdit(c.id, td, d.id);
    await tick(c.id, "src");

    const [ra, rb, rd] = [await proposal(c.id, pa.id), await proposal(c.id, pb.id), await proposal(c.id, pd.id)];
    const util = [ra, rb, rd].filter((p) => p.writeSet[0]!.path === "src/lib/util.ts");
    const main = [ra, rb, rd].find((p) => p.writeSet[0]!.path === "src/app/main.ts")!;
    // Priority order: i3 (5) lands with the main.ts change; the second util.ts writer waits.
    expect(ra.status).toBe("landed");
    expect(main.status).toBe("landed");
    expect(main.landingId).toBe(ra.landingId);
    const deferred = util.find((p) => p.id !== ra.id)!;
    expect(deferred.status).toBe("ready");

    // Next tick: its base is now stale, so it goes back with the delta; sigma links the return to the landing.
    await tick(c.id, "src");
    const ret = await proposal(c.id, deferred.id);
    expect(ret.status).toBe("returned");
    expect(ret.reason).toContain("src/lib/util.ts");
    const causes = await rows<{ id: string; cause_id: string | null }>(region(c.id, "src"), "SELECT id, cause_id FROM causes ORDER BY id");
    expect(causes.find((e) => e.id === `ret:${deferred.id}`)?.cause_id).toBe(`land:${ra.landingId}:${ra.id}`);
    expect((await api<ColonySnapshot>("GET", `/colonies/${c.id}`)).body.metrics).toMatchObject({ landings: 1, landedProposals: 2, returned: 1 });
  });

  it("prefers intents away from other agents' claims (repulsion)", async () => {
    const c = await newColony();
    await addIntent(c.id, ["src/lib/util.ts"], { priority: 1 });
    const y = await addIntent(c.id, ["src/lib/util.ts"], { priority: 1.5 });
    const z = await addIntent(c.id, ["docs/guide.md"], { priority: 1.2 });
    const a = await addAgent(c.id, "a");
    const b = await addAgent(c.id, "b");
    expect((await take(c.id, a.id)).intent.id).toBe(y.id); // highest priority
    // For b, the other util.ts intent is repelled by a's claim (1 - 1 = 0) so z wins.
    expect((await take(c.id, b.id)).intent.id).toBe(z.id);
  });

  it("waits when the pool is empty and leaves the intent open", async () => {
    const c = await newColony();
    const i = await addIntent(c.id, ["README.md"]);
    const a = await addAgent(c.id);
    await pool(c.id).setEmpty(true);
    const res = await api("POST", `/colonies/${c.id}/agents/${a.id}/take`);
    expect(res.body).toMatchObject({ wait: true, reason: "pool empty" });
    expect(res.body.retryInMs).toBeGreaterThan(0);
    expect((await intent(c.id, i.id)).status).toBe("open");
    expect((await agent(c.id, a.id)).state).toBe("waiting");
    expect((await reading(c.id, ".")).byPath["README.md"]).toEqual({ need: 1 });
    await pool(c.id).setEmpty(false);
    expect((await take(c.id, a.id)).intent.id).toBe(i.id);
  });

  it("waits when the agent declines every candidate", async () => {
    const c = await newColony();
    await addIntent(c.id, ["README.md"]);
    const a = await addAgent(c.id);
    await runInDurableObject(colony(c.id), (instance) => {
      (instance as unknown as { rand: () => number }).rand = () => 0.999999;
    });
    const res = await api("POST", `/colonies/${c.id}/agents/${a.id}/take`);
    expect(res.body).toMatchObject({ wait: true, reason: "no intent accepted at this agent's thresholds" });
  });
});

describe("lane failure handling", () => {
  it("retries a failing land and returns the proposal after five attempts", async () => {
    const c = await newColony();
    await addIntent(c.id, ["src/app/main.ts"]);
    const a = await addAgent(c.id);
    const got = await take(c.id, a.id);
    const p = await proposeEdit(c.id, got, a.id);
    await trunk(c.id).failNextLands(5);
    for (let n = 1; n <= 4; n++) {
      expect(await tick(c.id, "src")).toBe(true);
      expect((await proposal(c.id, p.id)).status).toBe("ready");
    }
    await tick(c.id, "src");
    const back = await proposal(c.id, p.id);
    expect(back.status).toBe("returned");
    expect(back.reason).toBe("landing failed 5 times: simulated push rejection");
    expect((await region(c.id, "src").status()).lane).toBe(0);
  });

  it("passes trunk conflicts back to the agent", async () => {
    const c = await newColony();
    await addIntent(c.id, ["src/app/main.ts"]);
    const a = await addAgent(c.id);
    const got = await take(c.id, a.id);
    const p = await proposeEdit(c.id, got, a.id);
    await trunk(c.id).returnOnLand([p.id]);
    await tick(c.id, "src");
    expect(await proposal(c.id, p.id)).toMatchObject({ status: "returned", reason: "conflict at land time: src/lib/util.ts" });
  });
});

describe("proposals", () => {
  it("computes the residual and keeps a supplied gap statement", async () => {
    const c = await newColony();
    const i = await addIntent(c.id, ["src/app/"]);
    const a = await addAgent(c.id);
    const got = await take(c.id, a.id);
    const res = await api<Proposal>("POST", `/colonies/${c.id}/proposals`, {
      intentId: i.id,
      agentId: a.id,
      workspace: got.lease.repo,
      baseSha: got.lease.baseSha,
      headSha: fakeSha(),
      writeSet: [
        { path: "src/app/main.ts", blob: fakeSha() },
        { path: "src/lib/util.ts", blob: fakeSha() },
      ],
      declared: { footprint: ["src/app/"], summary: "two files" },
      evidence: { checks: [{ name: "typecheck", ok: true, ms: 12 }], notVerified: "Not verified: runtime behavior" },
    });
    expect(res.status).toBe(201);
    expect(res.body.evidence).toEqual({
      checks: [{ name: "typecheck", ok: true, ms: 12 }],
      residual: ["src/lib/util.ts"],
      notVerified: "Not verified: runtime behavior",
    });
  });

  it("rejects proposals for unknown, landed, or foreign intents", async () => {
    const c = await newColony();
    const i = await addIntent(c.id, ["README.md"]);
    const a = await addAgent(c.id, "a");
    const b = await addAgent(c.id, "b");
    const got = await take(c.id, a.id);
    const body = (intentId: string, agentId: string) => ({
      intentId,
      agentId,
      workspace: got.lease.repo,
      baseSha: got.lease.baseSha,
      headSha: fakeSha(),
      writeSet: [{ path: "README.md", blob: fakeSha() }],
    });
    expect((await api("POST", `/colonies/${c.id}/proposals`, body("int_missing", a.id))).status).toBe(404);
    expect((await api("POST", `/colonies/${c.id}/proposals`, body(i.id, b.id))).status).toBe(409);
    expect((await api("POST", `/colonies/${c.id}/proposals`, { ...body(i.id, a.id), writeSet: [] })).status).toBe(400);
    expect((await api("POST", `/colonies/${c.id}/proposals`, { ...body(i.id, a.id), baseSha: "HEAD" })).status).toBe(400);
  });

  it("lets an agent propose for an intent assigned at declaration", async () => {
    const c = await newColony();
    const a = await addAgent(c.id);
    const i = await addIntent(c.id, ["docs/guide.md"], { assignedTo: a.id, source: "agent" });
    expect(i).toMatchObject({ status: "claimed", assignedTo: a.id });
    expect((await reading(c.id, "docs")).agents).toEqual([{ agentId: a.id, intentId: i.id, paths: ["docs/guide.md"] }]);
    const res = await api<Proposal>("POST", `/colonies/${c.id}/proposals`, {
      intentId: i.id,
      agentId: a.id,
      workspace: { namespace: "ft-ws-0", name: "x", remote: "https://artifacts.invalid/x.git" },
      baseSha: c.trunkSha,
      headSha: fakeSha(),
      writeSet: [{ path: "docs/guide.md", blob: fakeSha() }],
    });
    expect(res.body.status).toBe("ready");
    await tick(c.id, "docs");
    expect((await proposal(c.id, res.body.id)).status).toBe("landed");
  });
});

describe("review", () => {
  it("approves escalated proposals back into the lane and rejects others", async () => {
    const c = await newColony();
    const i1 = await addIntent(c.id, ["src/app/main.ts"]);
    const i2 = await addIntent(c.id, ["docs/guide.md"]);
    const a = await addAgent(c.id, "a");
    const b = await addAgent(c.id, "b");
    const ta = await take(c.id, a.id);
    const tb = await take(c.id, b.id);
    const pa = await proposeEdit(c.id, ta, a.id);
    const pb = await proposeEdit(c.id, tb, b.id);
    await colony(c.id).updateProposals([
      { id: pa.id, patch: { status: "escalated" } },
      { id: pb.id, patch: { status: "escalated" } },
    ]);
    expect(((await region(c.id, "src").status()).lane)).toBe(0);
    const queue = await api<Proposal[]>("GET", `/colonies/${c.id}/review`);
    expect(queue.body.map((p) => p.id).sort()).toEqual([pa.id, pb.id].sort());

    expect((await api("POST", `/colonies/${c.id}/review/${pa.id}`, { decision: "approve", reason: "looks right" })).status).toBe(200);
    expect((await proposal(c.id, pa.id)).status).toBe("ready");
    await tick(c.id, "src");
    expect((await proposal(c.id, pa.id)).status).toBe("landed");
    expect((await intent(c.id, i1.id)).status).toBe("landed");

    expect((await api("POST", `/colonies/${c.id}/review/${pb.id}`, { decision: "reject", reason: "wrong layer", by: "matt" })).status).toBe(200);
    expect(await proposal(c.id, pb.id)).toMatchObject({ status: "rejected", reason: "wrong layer" });
    expect((await intent(c.id, i2.id)).status).toBe("open");
    expect((await api("POST", `/colonies/${c.id}/review/${pb.id}`, { decision: "approve" })).status).toBe(409);
    expect((await api("POST", `/colonies/${c.id}/review/prp_missing`, { decision: "approve" })).status).toBe(404);
    expect((await api("POST", `/colonies/${c.id}/review/${pb.id}`, { decision: "maybe" })).status).toBe(400);

    const snap = await api<ColonySnapshot>("GET", `/colonies/${c.id}`);
    expect(snap.body.funnel).toEqual({ reflex: 0, llm: 0, human: 2 });
    expect((await api("GET", `/colonies/${c.id}/review`)).body).toEqual([]);
  });
});

describe("liveness", () => {
  it("heartbeats refresh claims and the reaper reopens a silent agent's intent", async () => {
    const c = await newColony();
    const i = await addIntent(c.id, ["src/lib/util.ts"]);
    const a = await addAgent(c.id, "a");
    await take(c.id, a.id);
    expect((await api("POST", `/colonies/${c.id}/agents/${a.id}/heartbeat`)).body).toEqual({ ok: true });
    expect((await api("POST", `/colonies/${c.id}/agents/agt_missing/heartbeat`)).status).toBe(404);

    // Make the agent look silent for 11 minutes and let the next call reap it.
    await runInDurableObject(colony(c.id), (instance, state) => {
      state.storage.sql.exec("UPDATE agents SET last_seen = ? WHERE id = ?", Date.now() - 11 * 60_000, a.id);
      (instance as unknown as { lastReap: number }).lastReap = 0;
    });
    const b = await addAgent(c.id, "b");
    const got = await take(c.id, b.id);
    expect(got.intent.id).toBe(i.id);
    expect((await agent(c.id, a.id)).state).toBe("dead");
    // b's take saw the intent reopened; a's claim is gone from the field.
    const field = await reading(c.id, "src");
    expect(field.agents.map((x) => x.agentId)).toEqual([b.id]);
  });

  it("abandoning reopens the intent and leaves a failure mark", async () => {
    const c = await newColony();
    const i = await addIntent(c.id, ["docs/guide.md"]);
    const a = await addAgent(c.id);
    await take(c.id, a.id);
    await colony(c.id).abandon(a.id, "cannot do it");
    expect((await intent(c.id, i.id)).status).toBe("open");
    expect((await reading(c.id, "docs")).byPath["docs/guide.md"]).toMatchObject({ need: 1 });
    expect((await reading(c.id, "docs")).byPath["docs/guide.md"]!.failure).toBeCloseTo(0.5, 3);
  });
});
