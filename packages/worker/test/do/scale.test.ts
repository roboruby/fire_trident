import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ColonyEvent, FieldReading, Mark } from "@fire_trident/core";
import type { ColonyDO } from "../../src/colony/ColonyDO.ts";
import { addAgent, addIntent, api, colony, eventually, fakeSha, newColony, region, rows, take, tick } from "./helpers.ts";

/**
 * Scale work in the coordination layer: admission counts only live claims, stopping agents clears
 * their claims everywhere, heartbeats never re-create a cleared claim, self-assignment reads a
 * shared claim-only field, regions are paced, and in-platform agents get their outcomes pushed.
 */

function claim(path: string, agentId: string, intentId: string, at = Date.now()): Omit<Mark, "id"> {
  return { kind: "claim", path, strength: 1, at, agentId, intentId };
}

async function reading(colonyId: string, name: string, opts: Record<string, unknown> = {}): Promise<FieldReading> {
  return (await region(colonyId, name).reading(opts)) as FieldReading;
}

/** Let the next colony heartbeat refresh claims at once (it throttles refreshes to one per 15 s per agent). */
async function forgetRefreshes(colonyId: string): Promise<void> {
  await runInDurableObject(colony(colonyId), (instance) => {
    (instance as unknown as { lastRefresh: Map<string, number> }).lastRefresh.clear();
  });
}

describe("admission counts live claims only", () => {
  it("does not let claims below half a fresh claim keep a region closed", async () => {
    const c = await newColony();
    const r = region(c.id, "src");
    await r.configure({ colonyId: c.id, region: "src" });
    // Three agents that went silent 4 minutes ago: 0.45 of a fresh claim each.
    const old = Date.now() - 4 * 60_000;
    await r.deposit([1, 2, 3].map((i) => claim(`src/s${i}.ts`, `ghost${i}`, `i${i}`, old)));
    let f = await reading(c.id, "src");
    expect(f.admission).toEqual({ open: true, landingsPerMin: 0, activeAgents: 0 });
    expect(f.agents).toHaveLength(3); // still listed while they decay
    expect((await r.admit({ agentId: "new", intentId: "i9", paths: ["src/n.ts"] })).admitted).toBe(true);
    // Fresh claims count: the newcomer plus two more fill the cap of three.
    await r.deposit([claim("src/f1.ts", "fresh1", "j1"), claim("src/f2.ts", "fresh2", "j2")]);
    f = await reading(c.id, "src");
    expect(f.admission).toEqual({ open: false, landingsPerMin: 0, activeAgents: 3 });
    expect((await r.admit({ agentId: "late", intentId: "i10", paths: ["src/l.ts"] })).admitted).toBe(false);
    // An agent whose only claim here has decayed is not "inside": it goes through admission.
    expect((await r.admit({ agentId: "ghost1", intentId: "i11", paths: ["src/g.ts"] })).admitted).toBe(false);
  });

  it("stopping agents clears every claim they hold, in every region, at once", async () => {
    const c = await newColony();
    for (const n of [1, 2, 3]) await addIntent(c.id, [`src/x${n}.ts`]);
    await addIntent(c.id, ["docs/guide.md"], { priority: 0 });
    const agents = [await addAgent(c.id, "a"), await addAgent(c.id, "b"), await addAgent(c.id, "c")];
    for (const a of agents) await take(c.id, a.id);
    expect((await reading(c.id, "src")).admission.activeAgents).toBe(3);
    // An orphan claim of agent a in another region (as a heartbeat racing a landing used to leave behind).
    await region(c.id, "docs").deposit([claim("docs/guide.md", agents[0]!.id, "int_orphan")]);
    for (const a of agents) expect((await api("POST", `/colonies/${c.id}/agents/${a.id}/stop`, {})).status).toBe(200);
    const src = await reading(c.id, "src");
    expect(src.admission).toMatchObject({ open: true, activeAgents: 0 });
    expect(src.agents).toEqual([]);
    expect((await reading(c.id, "docs")).agents).toEqual([]);
    // A new agent is admitted right away instead of after the claims decay.
    const d = await addAgent(c.id, "d");
    expect((await take(c.id, d.id)).intent.footprint[0]).toMatch(/^src\/x/);
  });
});

describe("claim refreshes", () => {
  it("a heartbeat re-dates held claims but never re-creates a cleared one", async () => {
    const c = await newColony();
    const a = await addAgent(c.id, "a");
    await addIntent(c.id, ["src/h.ts"]);
    await take(c.id, a.id);
    const r = region(c.id, "src");
    await rows(r, "UPDATE marks SET at = ? WHERE kind = 'claim'", Date.now() - 4 * 60_000);
    expect((await reading(c.id, "src", { kinds: ["claim"] })).byPath["src/h.ts"]!.claim).toBeLessThan(0.5);
    await forgetRefreshes(c.id);
    expect((await api("POST", `/colonies/${c.id}/agents/${a.id}/heartbeat`)).status).toBe(200);
    expect((await reading(c.id, "src", { kinds: ["claim"] })).byPath["src/h.ts"]!.claim).toBeCloseTo(1, 2);
    // The claim is cleared (as a landing or a return does), then a heartbeat that raced it arrives.
    await r.clear({ agentId: a.id, kind: "claim" });
    await forgetRefreshes(c.id);
    expect((await api("POST", `/colonies/${c.id}/agents/${a.id}/heartbeat`)).status).toBe(200);
    expect((await reading(c.id, "src", { kinds: ["claim"] })).byPath["src/h.ts"]).toBeUndefined();
  });

  it("refreshes only the named intents' claims, and clears agents' claims whatever the intent", async () => {
    const c = await newColony();
    const r = region(c.id, "src");
    await r.configure({ colonyId: c.id, region: "src" });
    const old = Date.now() - 3 * 60_000;
    await r.deposit([claim("src/a.ts", "a1", "i1", old), claim("src/b.ts", "a1", "i2", old), claim("src/c.ts", "a2", "i3", old)]);
    expect(await r.refreshClaims({ agentId: "a1", intentIds: ["i1"] })).toBe(1);
    const f = await reading(c.id, "src", { kinds: ["claim"] });
    expect(f.byPath["src/a.ts"]!.claim).toBeCloseTo(1, 2);
    expect(f.byPath["src/b.ts"]!.claim).toBeLessThan(0.6);
    expect(await r.refreshClaims({ agentId: "nobody" })).toBe(0);
    expect(await r.clearClaims(["a1", "a2", "a3"])).toBe(3);
    expect(Object.keys((await reading(c.id, "src", { kinds: ["claim"] })).byPath)).toEqual([]);
  });
});

describe("self-assignment reads", () => {
  it("a claim-only reading covers the whole region and leaves other kinds out", async () => {
    const c = await newColony();
    const r = region(c.id, "src");
    await r.configure({ colonyId: c.id, region: "src" });
    await r.deposit([
      claim("src/a.ts", "a1", "i1"),
      { kind: "need", path: "src/a.ts", strength: 2, at: Date.now(), intentId: "i1" },
      { kind: "trail", path: "src/b.ts", strength: 1, at: Date.now() },
      { kind: "danger", path: "src/c.ts", strength: 1, at: Date.now() },
    ]);
    const f = await reading(c.id, "src", { kinds: ["claim", "danger"], agents: false });
    expect(Object.keys(f.byPath).sort()).toEqual(["src/a.ts", "src/c.ts"]);
    expect(f.byPath["src/a.ts"]).toEqual({ claim: expect.closeTo(1, 3) });
    expect(f.totals.need).toBe(2);
    expect(f.admission.activeAgents).toBe(1);
  });

  it("concurrent takes share one reading per region and still never double-assign", async () => {
    const c = await newColony();
    const stub = colony(c.id);
    for (let i = 0; i < 12; i++) await addIntent(c.id, [`src/p${i}.ts`]);
    const agents = await stub.registerAgents(Array.from({ length: 12 }, (_, i) => ({ kind: "synthetic" as const, name: `s${i}` })));
    const results = await Promise.all(agents.map((a) => stub.take(a.id)));
    const assigned = results.filter((r) => "intent" in r) as unknown as Array<{ intent: { id: string } }>;
    // Admission lets three agents into src (no landings yet); each got a different intent.
    expect(assigned).toHaveLength(3);
    expect(new Set(assigned.map((r) => r.intent.id)).size).toBe(3);
    expect((await reading(c.id, "src")).admission.activeAgents).toBe(3);
  });
});

describe("pacing", () => {
  it("asks regions to batch field events for longer as more regions emit", async () => {
    const c = await newColony();
    const stub = colony(c.id);
    const mark = (r: string): ColonyEvent => ({ t: "mark", at: Date.now(), region: r, path: `${r}/x.ts`, kind: "claim", value: 1 });
    expect((await stub.emit([mark("src")])).emitEveryMs).toBe(100);
    for (let i = 0; i < 120; i++) await stub.emit([mark(`r${i}`)]);
    expect((await stub.emit([mark("src")])).emitEveryMs).toBe(Math.round((1000 * 121) / 60));
  });
});

describe("pushed outcomes", () => {
  async function watched(colonyId: string): Promise<Array<{ proposal_id: string; agent_id: string }>> {
    return runInDurableObject(colony(colonyId), (_i: ColonyDO, state: DurableObjectState) =>
      state.storage.sql.exec<{ proposal_id: string; agent_id: string }>("SELECT proposal_id, agent_id FROM outcome_watch").toArray(),
    );
  }

  it("watches a proposal made with notify until it lands, and ignores ones made without", async () => {
    const c = await newColony();
    const a = await addAgent(c.id, "a");
    await addIntent(c.id, ["src/w.ts"]);
    const got = await take(c.id, a.id);
    const p = await colony(c.id).propose({
      colonyId: c.id,
      intentId: got.intent.id,
      agentId: a.id,
      workspace: got.lease.repo,
      baseSha: got.lease.baseSha,
      headSha: fakeSha(),
      writeSet: [{ path: "src/w.ts", blob: fakeSha() }],
      readSet: [],
      declared: { footprint: got.intent.footprint, summary: "w" },
      notify: true,
    });
    expect(p.status).toBe("ready");
    expect(await watched(c.id)).toEqual([{ proposal_id: p.id, agent_id: a.id }]);
    expect(JSON.stringify(p)).not.toContain("notify");
    await tick(c.id, "src");
    expect((await colony(c.id).getProposal(p.id))?.status).toBe("landed");
    expect(await eventually(() => watched(c.id), (w) => w.length === 0)).toEqual([]);
  });
});
