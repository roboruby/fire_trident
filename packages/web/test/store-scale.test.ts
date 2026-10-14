import { describe, expect, it } from "vitest";
import type { ColonyEvent } from "@fire_trident/core";
import { ColonyStore } from "../src/store.ts";

/** The store at the size of a scale run: thousands of proposals in one batch (a replay's seek applies the record in one). */
describe("proposals past the store's cap", () => {
  const landed = (i: number, at: number): ColonyEvent => ({ t: "proposal", at, proposalId: `prp_${i}`, intentId: `int_${i}`, agentId: `agt_${i % 2000}`, status: "landed" });

  it("keeps a batch's proposals whole, and trims the old ones once a later batch comes", () => {
    const s = new ColonyStore("scale");
    let now = 1_000_000;
    s.now = () => now;
    // One batch of 7,000 settled proposals: nothing in it is old enough to drop, so the store keeps them all (a pass per
    // event over the whole map made this quadratic).
    s.applyEvents(Array.from({ length: 7000 }, (_, i) => landed(i, now)));
    expect(s.proposals.size).toBe(7000);
    // A later batch, 30 s on: the old settled proposals go, down to the trim's floor.
    now += 30_000;
    s.applyEvents([landed(7000, now)]);
    expect(s.proposals.size).toBe(4500);
    expect(s.proposals.has("prp_7000")).toBe(true);
  });
});
