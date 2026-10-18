import { describe, expect, it } from "vitest";
import { runSummary } from "../src/runsummary.ts";

/** The `run` block of a live report: the numbers a showcase card and the README quote. */
describe("runSummary", () => {
  it("counts over the whole run, from its first landing to its last", () => {
    const t0 = Date.UTC(2026, 9, 14, 20, 0, 0);
    const r = runSummary({
      registered: 2000,
      // Three commits over two minutes: 2, 3 and 5 changes.
      landings: [
        { at: t0 + 60_000, proposalIds: ["a", "b", "c"] },
        { at: t0, proposalIds: ["d", "e"] },
        { at: t0 + 120_000, proposalIds: ["f", "g", "h", "i", "j"] },
      ],
      timeToLand: Array.from({ length: 100 }, (_, i) => (i + 1) * 100),
      // Two more changes closed as already on trunk (FT_ALREADY_ON_TRUNK): counted apart, in no landing.
      delta: { landings: 3, landedProposals: 10, landedIntents: 10, proposals: 12, alreadyOnTrunk: 2 },
    });
    expect(r).toEqual({
      agentsJoined: 2000,
      landings: 3,
      landedProposals: 10,
      landedIntents: 10,
      alreadyOnTrunk: 2,
      firstLandingAt: "2026-10-14T20:00:00.000Z",
      lastLandingAt: "2026-10-14T20:02:00.000Z",
      spanS: 120,
      landingsPerMin: 1.5,
      landedPerMin: 5,
      timeToLandP50Ms: 5000,
      timeToLandP95Ms: 9500,
    });
  });

  it("leaves out what it cannot know: no rate without a span, no metric the colony did not report", () => {
    const r = runSummary({ registered: 3, landings: [{ at: 5, proposalIds: ["a"] }], timeToLand: [], delta: { landings: 1 } });
    expect(r.spanS).toBeNull();
    expect(r.landingsPerMin).toBeNull();
    expect(r.landedIntents).toBeNull();
    expect(r.alreadyOnTrunk).toBeNull();
    expect(r.timeToLandP50Ms).toBeNull();
    expect(runSummary({ registered: 0, landings: [], timeToLand: [], delta: {} }).firstLandingAt).toBeNull();
  });
});
