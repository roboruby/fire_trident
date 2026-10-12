import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { FieldReading, Mark, Proposal } from "@fire_trident/core";
import { api, fakeSha, newColony, region } from "./helpers.ts";

async function freshRegion(name = "src") {
  const c = await newColony();
  const r = region(c.id, name);
  await r.configure({ colonyId: c.id, region: name });
  return { c, r };
}

function mark(kind: Mark["kind"], path: string, extra: Partial<Omit<Mark, "id">> = {}): Omit<Mark, "id"> {
  return { kind, path, strength: 1, at: Date.now(), ...extra };
}

describe("RegionDO field", () => {
  it("refreshes claims and needs in place but accumulates trails", async () => {
    const { r } = await freshRegion();
    await r.deposit([mark("claim", "src/a.ts", { agentId: "a1", intentId: "i1" }), mark("claim", "src/a.ts", { agentId: "a1", intentId: "i1" })]);
    await r.deposit([mark("claim", "src/a.ts", { agentId: "a2", intentId: "i2" })]);
    await r.deposit([mark("need", "src/a.ts", { intentId: "i1", strength: 2 }), mark("need", "src/a.ts", { intentId: "i1", strength: 3 })]);
    await r.deposit([mark("trail", "src/a.ts"), mark("trail", "src/a.ts")]);
    await r.deposit([mark("trail", "src/a.ts", { strength: 0.5 })]);
    const f = (await r.reading()) as FieldReading;
    expect(f.byPath["src/a.ts"]!.claim).toBeCloseTo(2, 3); // one per agent
    expect(f.byPath["src/a.ts"]!.need).toBe(3); // replaced
    expect(f.byPath["src/a.ts"]!.trail).toBeCloseTo(2.5, 3); // accumulated
    expect(f.totals).toMatchObject({ need: 3, failure: 0, danger: 0 });
    expect(f.agents.map((a) => a.agentId).sort()).toEqual(["a1", "a2"]);
    expect((await r.status()).marks).toBe(4);
  });

  it("ignores invalid deposits and clears only with a filter", async () => {
    const { r } = await freshRegion();
    await r.deposit([
      mark("claim", "src/a.ts", { agentId: "a1" }),
      { ...mark("trail", "src/b.ts"), kind: "bogus" as Mark["kind"] },
      mark("trail", "src/c.ts", { strength: -1 }),
      mark("trail", "", {}),
    ]);
    expect((await r.status()).marks).toBe(1);
    expect(await r.clear({})).toBe(0);
    expect(await r.clear({ paths: [] })).toBe(0);
    expect(await r.clear({ agentId: "nobody" })).toBe(0);
    expect(await r.clear({ agentId: "a1", kind: "claim", paths: ["src/a.ts"] })).toBe(1);
    expect((await r.status()).marks).toBe(0);
  });

  it("filters readings to paths, keeps overlapping directory marks, and excludes the reader's claims", async () => {
    const { r } = await freshRegion();
    await r.deposit([
      mark("claim", "src/lib/", { agentId: "other", intentId: "i9" }),
      mark("claim", "src/lib/a.ts", { agentId: "me", intentId: "i1" }),
      mark("need", "src/zzz.ts", { intentId: "i2" }),
    ]);
    const f = (await r.reading({ paths: ["src/lib/a.ts"], excludeAgentId: "me", agents: false })) as FieldReading;
    expect(Object.keys(f.byPath).sort()).toEqual(["src/lib/"]);
    expect(f.byPath["src/lib/"]!.claim).toBeCloseTo(1, 3);
    expect(f.agents).toEqual([]);
    expect(f.admission.activeAgents).toBe(1);
    expect(f.totals.need).toBe(1);
  });

  it("closes admission once three agents hold claims and no landings flow", async () => {
    const { r } = await freshRegion();
    await r.deposit([mark("claim", "src/a.ts", { agentId: "a1" }), mark("claim", "src/b.ts", { agentId: "a2" })]);
    expect(((await r.reading()) as FieldReading).admission).toEqual({ open: true, landingsPerMin: 0, activeAgents: 2 });
    await r.deposit([mark("claim", "src/c.ts", { agentId: "a3" })]);
    expect(((await r.reading()) as FieldReading).admission).toEqual({ open: false, landingsPerMin: 0, activeAgents: 3 });
    // Landings raise the rate and reopen the region (k = 2 per landing/min).
    await r.apply({ landingId: "l1" });
    await r.apply({ landingId: "l2" });
    await r.apply({ landingId: "l2" });
    expect(((await r.reading()) as FieldReading).admission).toEqual({ open: true, landingsPerMin: 2, activeAgents: 3 });
  });

  it("drops expired marks from readings", async () => {
    const { r } = await freshRegion();
    await r.deposit([mark("claim", "src/old.ts", { agentId: "a1", at: Date.now() - 60 * 60_000 }), mark("need", "src/old.ts", { at: 0 })]);
    const f = (await r.reading()) as FieldReading;
    expect(f.byPath["src/old.ts"]).toEqual({ need: 1 });
    expect(f.agents).toEqual([]);
  });

  it("computes sigma from recorded causes", async () => {
    const { r } = await freshRegion();
    const now = Date.now();
    await r.recordCause({ id: "L1", at: now - 20_000 });
    for (const id of ["R1", "R2", "R3"]) await r.recordCause({ id, causeId: "L1", at: now - 19_000 });
    // Every event in the window is a potential parent: 3 children over 4 events.
    expect(((await r.reading()) as FieldReading).sigma).toBeCloseTo(0.75, 6);
  });
});

describe("RegionDO reports", () => {
  it("keeps undelivered colony reports and delivers them in order later", async () => {
    const name = `ghost-${Date.now()}`;
    const r = region(name, "src");
    type Internals = { report(c: string, r: unknown): Promise<void>; retryReports(c: string): Promise<void>; pendingReports(): number };
    // The colony does not exist yet, so delivery fails and both reports wait.
    await runInDurableObject(r, async (instance) => {
      const i = instance as unknown as Internals;
      await i.report(name, { kind: "updates", updates: [] });
      await i.report(name, { kind: "updates", updates: [] });
      expect(i.pendingReports()).toBe(2);
    });
    expect((await api("POST", "/colonies", { name })).status).toBe(201);
    await runInDurableObject(r, async (instance) => {
      const i = instance as unknown as Internals;
      await i.retryReports(name);
      expect(i.pendingReports()).toBe(0);
    });
  });
});

describe("RegionDO lane", () => {
  it("queues, replaces and drops proposals", async () => {
    const { c, r } = await freshRegion();
    const p: Proposal = {
      id: "prp_lane1",
      colonyId: c.id,
      intentId: "int_x",
      agentId: "agt_x",
      workspace: { namespace: "ft-ws-0", name: "w", remote: "https://artifacts.invalid/w.git" },
      baseSha: fakeSha(),
      headSha: fakeSha(),
      writeSet: [{ path: "src/a.ts", blob: fakeSha() }],
      readSet: [],
      declared: { footprint: ["src/a.ts"], summary: "" },
      evidence: { checks: [] },
      status: "ready",
      createdAt: Date.now(),
    };
    await r.enqueue(p, 2);
    await r.enqueue(p, 3);
    const s = await r.status();
    expect(s.lane).toBe(1);
    expect(s.fluxPerMin).toBe(2);
    expect(s.nextTickAt).toBeGreaterThan(Date.now() + 30 * 60_000); // held by the test helper
    expect(await r.dequeue([p.id, "prp_other"])).toBe(1);
    expect((await r.status()).lane).toBe(0);
  });
});
