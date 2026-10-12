import { describe, expect, it } from "vitest";
import type { Intent } from "@fire_trident/core";
import type { TakeResult } from "../../src/colony/ColonyDO.ts";
import { colony, newColony } from "./helpers.ts";

describe("concurrent self-assignment", () => {
  it("never double-assigns and holds admission at three agents per region during a burst", async () => {
    const c = await newColony();
    const stub = colony(c.id);
    const regions = ["alpha", "beta", "gamma", "delta"];
    for (const r of regions) {
      for (let i = 0; i < 8; i++) await stub.addIntent({ colonyId: c.id, title: `t ${r} ${i}`, why: "", source: "human", footprint: [`${r}/f${i}.ts`], priority: 1, createdBy: "test" });
    }
    const agents = await stub.registerAgents(Array.from({ length: 40 }, (_, i) => ({ kind: "synthetic" as const, name: `a${i}` })));

    const started = Date.now();
    const results = (await Promise.all(agents.map((a) => stub.take(a.id)))) as TakeResult[];
    const ms = Date.now() - started;

    const assigned = results.filter((r): r is { intent: Intent; lease: never } => "intent" in r).map((r) => r.intent);
    expect(new Set(assigned.map((i) => i.id)).size).toBe(assigned.length);
    const perRegion = new Map<string, number>();
    for (const i of assigned) perRegion.set(i.footprint[0]!.split("/")[0]!, (perRegion.get(i.footprint[0]!.split("/")[0]!) ?? 0) + 1);
    expect([...perRegion.values()].every((n) => n <= 3)).toBe(true);
    expect(assigned.length).toBe(12);
    const waits = results.filter((r) => "wait" in r) as Array<{ wait: true; reason: string }>;
    expect(waits).toHaveLength(28);
    expect(new Set(waits.map((w) => w.reason))).toEqual(new Set(["admission closed in every candidate region"]));
    console.log(`burst: 40 concurrent takes in ${ms} ms (${assigned.length} assigned)`);
  });

  it("serves many takes across many regions without collisions", async () => {
    const c = await newColony();
    const stub = colony(c.id);
    for (let r = 0; r < 50; r++) {
      for (let i = 0; i < 4; i++) await stub.addIntent({ colonyId: c.id, title: `t${r}.${i}`, why: "", source: "human", footprint: [`r${r}/f${i}.ts`], priority: 1, createdBy: "test" });
    }
    const agents = await stub.registerAgents(Array.from({ length: 200 }, (_, i) => ({ kind: "synthetic" as const, name: `b${i}` })));
    const started = Date.now();
    const results = (await Promise.all(agents.map((a) => stub.take(a.id)))) as TakeResult[];
    const ms = Date.now() - started;
    const assigned = results.filter((r): r is { intent: Intent; lease: never } => "intent" in r).map((r) => r.intent);
    expect(new Set(assigned.map((i) => i.id)).size).toBe(assigned.length);
    expect(assigned.length).toBe(150); // 3 per region x 50 regions
    console.log(`burst: 200 concurrent takes over 50 regions in ${ms} ms (${assigned.length} assigned)`);
  });
});
