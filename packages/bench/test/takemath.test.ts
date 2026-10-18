import { describe, expect, it } from "vitest";
import { AGE_FACTOR_CAP, LATERAL_INHIBITION } from "@fire_trident/core";
import type { Intent } from "@fire_trident/core";
import type { Rng } from "../src/sim/engine.ts";
import { FireSim, type FireOptions } from "../src/sim/fire.ts";
import { AGE_CAPS, AGECAP_VARIANTS, VARIANTS, silentHoldMs } from "../src/sim/inhibition.ts";
import { params } from "../src/sim/sweep.ts";
import type { Timings } from "../src/sim/common.ts";
import type { SimTask, TaskSource } from "../src/sim/workloads.ts";

/** The 2026-10-18 review fixes in the simulator: inhibition by the strongest file, and the capped age multiplier. */

const timings: Timings = { takeMs: 250, proposeMs: 30, laneOverheadMs: 100, commitBaseMs: 620, commitPerProposalMs: 72, landMs: 692, rebaseMs: 350, testMs: 0 };

/** Tasks that write two of six files in one region, so takes see claimed and repelled candidates. */
const hot = (): TaskSource => ({
  describe: () => ({ kind: "hot" }),
  make(id: number, now: number, rng: Rng): SimTask {
    const files = ["a", "b", "c", "d", "e", "f"].map((f) => `src/${f}.ts`);
    const first = rng.int(6);
    const writes = [files[first]!, files[(first + 1 + rng.int(5)) % 6]!];
    const intent = { id: `t${id}`, priority: 1, createdAt: now } as unknown as Intent;
    return { id, writes, reads: [], regions: ["src"], writeRegions: writes.map(() => "src"), primary: "src", workMs: 30_000, createdAt: now, intent, status: "open", attempts: 0, firstClaimAt: -1, firstSubmitAt: -1 };
  },
});

const run = (opts: FireOptions) => {
  const p = params("firetrident", 16, { durationMs: 900_000, warmupMs: 60_000, seed: 3, timings, backlog: 60, rampMs: 1_000 });
  return new FireSim(p, hot(), () => "v0", undefined, opts).run();
};

describe("the review's fixes in the simulator", () => {
  it("silentHoldMs: summed, n shared files hold an intent 5 * ln(2n) minutes; by the strongest file, one half-life", () => {
    for (const n of [1, 2, 20]) {
      expect(silentHoldMs(n, "sum") / 60_000).toBeCloseTo(5 * Math.log(2 * n), 1);
      expect(silentHoldMs(n, "strongest") / 60_000).toBeCloseTo(5 * Math.LN2, 1);
    }
    expect(silentHoldMs(1, "strongest", 2) / 60_000).toBeCloseTo(5 * Math.log(4), 1);
  });

  it("inhibition by the strongest file changes no choice while every live claim is fresh (1)", () => {
    const sum = run({ inhibitAt: LATERAL_INHIBITION });
    const strongest = run({ inhibitAt: LATERAL_INHIBITION, inhibitBy: "strongest" });
    expect(strongest.landingsPerMin).toBe(sum.landingsPerMin);
    expect(strongest.conflictsPer1000).toBe(sum.conflictsPer1000);
    expect(strongest.waits).toEqual(sum.waits);
  });

  it("the age cap is deterministic per seed, and every run records how long tasks waited for a claim", () => {
    const capped = run({ inhibitAt: LATERAL_INHIBITION, ageCap: 2 });
    expect(run({ inhibitAt: LATERAL_INHIBITION, ageCap: 2 })).toMatchObject({ landingsPerMin: capped.landingsPerMin, waitMaxS: capped.waitMaxS });
    expect(capped.waitP50S).not.toBeNull();
    expect(capped.waitMaxS!).toBeGreaterThanOrEqual(capped.waitP99S!);
    const uncapped = run({ inhibitAt: LATERAL_INHIBITION });
    expect(uncapped.waitMaxS).not.toBeNull();
  });

  it("names the fixes' variants with the deployed cap, and sweeps the uncapped case first", () => {
    expect(VARIANTS.filter((v) => v.name.endsWith("+fix")).every((v) => v.ageCap === AGE_FACTOR_CAP && v.inhibitBy === "strongest")).toBe(true);
    expect(AGECAP_VARIANTS.every((v) => v.inhibit && v.cochange === 5)).toBe(true);
    expect(AGE_CAPS[0]).toBe(Number.POSITIVE_INFINITY);
  });
});
