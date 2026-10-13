import { describe, expect, it } from "vitest";
import type { ColonyEvent } from "@fire_trident/core";
import { ColonySim } from "../src/mock.ts";
import { ColonyStore } from "../src/store.ts";

/** The simulator plays the round-2 events too (reports, contests, landing notices, revalidation), so ?mock=1 shows them. */

function run(steps: number): { sim: ColonySim; store: ColonyStore; events: ColonyEvent[] } {
  const sim = new ColonySim("demo", { files: 0, agents: 64, speed: 20, seed: 11 });
  const store = new ColonyStore("demo");
  store.applySnapshot(sim.snapshot());
  const events: ColonyEvent[] = [];
  let now = Date.now();
  for (let i = 0; i < steps; i++) {
    now += 250;
    const evs = sim.step(now);
    events.push(...evs);
    store.applyEvents(evs);
  }
  return { sim, store, events };
}

describe("the simulator's round-2 events", () => {
  it("reports intents, decides contests, sends landing notices and lands on revalidation", () => {
    const { store, events } = run(500);
    const kinds = new Set(events.map((e) => e.t));
    expect(kinds.has("escalation")).toBe(true);
    expect(kinds.has("contest")).toBe(true);
    expect(kinds.has("revalidated")).toBe(true);
    expect(events.some((e) => e.t === "directive" && e.kind === "landing")).toBe(true);
    // Every contest names a winner and the attempts it superseded, which the store marks.
    for (const e of events) if (e.t === "contest") for (const l of e.losers) expect(store.superseded.get(l)).toBe(e.winner);
    // Reports nobody answered are answered by a simulated reviewer after a while.
    expect(events.some((e) => e.t === "escalation" && e.resolved)).toBe(true);
  });

  it("answers a report the way the API does, and refuses a second answer", () => {
    const { sim, store, events } = run(500);
    const open = store.openEscalations()[0] ?? null;
    const any = events.find((e): e is Extract<ColonyEvent, { t: "escalation" }> => e.t === "escalation" && !e.resolved);
    expect(any).toBeDefined();
    if (open) {
      sim.resolveEscalation(open.intentId, "dismiss", "the test is right", "matt");
      const evs = sim.step(Date.now() + 1);
      store.applyEvents(evs);
      expect(store.escalations.get(open.intentId)?.resolved).toMatchObject({ decision: "dismiss", by: "matt", note: "the test is right" });
      expect(() => sim.resolveEscalation(open.intentId, "withdraw", "again", "matt")).toThrow(/already answered/);
    }
    expect(() => sim.resolveEscalation(any?.intentId ?? "none", "dismiss", "", "matt")).toThrow();
  });
});
