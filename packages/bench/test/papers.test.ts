import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LATERAL_INHIBITION } from "@fire_trident/core";
import type { Intent } from "@fire_trident/core";
import type { WorkloadModel } from "../src/workload.ts";
import { BaselineSim } from "../src/sim/baseline.ts";
import type { SimResult, Timings } from "../src/sim/common.ts";
import type { Rng } from "../src/sim/engine.ts";
import { FireSim, type FireOptions, type ReturnInfo } from "../src/sim/fire.ts";
import { importRepulsion, importTable, monorepoImports, mostImported, sumRepulsion } from "../src/sim/imports.ts";
import { diff, stat, tallyReturn, type ReturnTally } from "../src/sim/papers.ts";
import { params } from "../src/sim/sweep.ts";
import type { SimTask, TaskSource } from "../src/sim/workloads.ts";

const timings: Timings = { takeMs: 250, proposeMs: 30, laneOverheadMs: 100, commitBaseMs: 620, commitPerProposalMs: 72, landMs: 692, rebaseMs: 350, testMs: 0 };

/** One task in three writes the hub file; the rest write one of eight leaf files and read the hub. */
const hubWork = (): TaskSource => ({
  describe: () => ({ kind: "hub" }),
  make(id: number, now: number, rng: Rng): SimTask {
    const hub = rng.next() < 1 / 3;
    const writes = hub ? ["src/hub.ts"] : [`src/leaf${rng.int(8)}.ts`];
    const intent = { id: `t${id}`, priority: 1, createdAt: now } as unknown as Intent;
    return { id, writes, reads: hub ? [] : ["src/hub.ts"], regions: ["src"], writeRegions: ["src"], primary: "src", workMs: 20_000, createdAt: now, intent, status: "open", attempts: 0, firstClaimAt: -1, firstSubmitAt: -1 };
  },
});

const p = (model: "baseline" | "firetrident" | "firetrident-group") => params(model, 12, { durationMs: 900_000, warmupMs: 60_000, seed: 3, timings, backlog: 40, rampMs: 1_000 });

/** A FireTrident run on the hub workload, with every return after warm-up collected. */
const fire = (model: "firetrident" | "firetrident-group", opts: FireOptions = {}, hook = true) => {
  const returns: ReturnInfo[] = [];
  const sim = new FireSim(p(model), hubWork(), () => "v0", undefined, { ...opts, ...(hook ? { onReturn: (r: ReturnInfo) => r.at >= 60_000 && returns.push(r) } : {}) });
  return { r: sim.run(), sim, returns };
};

/** A result without the wall-clock time, for comparing runs. */
const same = (r: SimResult) => ({ ...r, wallMs: 0 });

describe("import-aware repulsion", () => {
  // a imports b and c, b imports c, d imports c: c has three importers, b one.
  const model: Pick<WorkloadModel, "files" | "imports"> = { files: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"], imports: [[1, 2], [2], [], [2]] };

  it("links each file to its direct imports and its importers, inside the same package copy", () => {
    const table = importTable(model);
    expect(table.get("src/a.ts")).toEqual(["src/b.ts", "src/c.ts"]);
    expect(table.get("src/c.ts")).toEqual(["src/a.ts", "src/b.ts", "src/d.ts"]);
    const nb = monorepoImports(table);
    expect(nb("p3/src/d.ts")).toEqual([{ path: "p3/src/c.ts", weight: 1 }]);
    expect(nb("p3/src/unknown.ts")).toBeUndefined();
    expect(mostImported(model, 2)).toEqual(["src/c.ts", "src/b.ts"]);
  });

  it("repels a candidate by the claims on its imports and importers outside its own footprint, times the weight", () => {
    const nb = monorepoImports(importTable(model));
    const claims = new Map([
      ["p3/src/c.ts", 1],
      ["p3/src/d.ts", 2],
      ["p3/src/a.ts", 5],
      ["p4/src/c.ts", 7],
    ]);
    const claimOn = (path: string) => claims.get(path) ?? 0;
    const task = (writes: string[]) => ({ writes }) as SimTask;
    // a's neighbors are b and c (claim 1); its own claim and other package copies do not count.
    expect(importRepulsion(nb, 2)(task(["p3/src/a.ts"]), claimOn)).toBe(2);
    // Writing c too: c is inside the footprint, so the claims left are on d (2), counted once.
    expect(importRepulsion(nb, 1)(task(["p3/src/a.ts", "p3/src/c.ts"]), claimOn)).toBe(2);
    expect(importRepulsion(nb, 0)(task(["p3/src/a.ts"]), claimOn)).toBe(0);
    expect(sumRepulsion(importRepulsion(nb, 2), () => 0.5)(task(["p3/src/a.ts"]), claimOn)).toBe(2.5);
  });

  it("ranks hono's three most-imported files as the diagnosis counts them", () => {
    const hono = JSON.parse(readFileSync(new URL("../data/hono-workload.json", import.meta.url), "utf8")) as WorkloadModel;
    expect(mostImported(hono, 3)).toEqual(["src/context.ts", "src/hono.ts", "src/types.ts"]);
  });
});

describe("the return hook", () => {
  it("sees every return after warm-up and does not change the run", () => {
    for (const model of ["firetrident", "firetrident-group"] as const) {
      const on = fire(model);
      const off = fire(model, {}, false);
      expect(same(on.r)).toEqual(same(off.r));
      expect(on.returns.length).toBe(on.sim.m.invalidated);
      expect(on.returns.length).toBeGreaterThan(0);
    }
  });

  it("tells read-only staleness from write-write conflicts", () => {
    // Claims that only repel let two agents write the same file, so both kinds occur.
    const { returns, sim } = fire("firetrident");
    const kinds = new Set(returns.map((r) => r.kind));
    expect(kinds).toEqual(new Set(["read", "write"]));
    for (const r of returns) {
      if (r.kind === "read") expect(r.reads).toEqual(["src/hub.ts"]);
      if (r.kind === "write") expect(r.writes.length).toBeGreaterThan(0);
    }
    // With lateral inhibition no two agents hold the same file, so every return is read-only.
    const inh = fire("firetrident", { inhibitAt: LATERAL_INHIBITION });
    expect(inh.returns.length).toBeGreaterThan(0);
    expect(inh.returns.every((r) => r.kind === "read")).toBe(true);
    expect(sim.m.invalidatedWriteWrite).toBeGreaterThan(0);
  });
});

describe("assumption revalidation", () => {
  it("lands every change that is stale only through files it read when assumptions always hold", () => {
    const off = fire("firetrident", { inhibitAt: LATERAL_INHIBITION });
    expect(off.sim.m.invalidated).toBeGreaterThan(0);
    const on = fire("firetrident", { inhibitAt: LATERAL_INHIBITION, assumptions: { hold: 1 } });
    expect(on.sim.m.invalidated).toBe(0);
    expect(on.sim.keptLandings).toBeGreaterThan(0);
    expect(on.r.reworkPct).toBe(0);
    // Group commit: readers behind a hub write in the same commit are kept too.
    const group = fire("firetrident-group", { inhibitAt: LATERAL_INHIBITION, assumptions: { hold: 1 } });
    expect(group.returns.filter((r) => r.kind === "read")).toEqual([]);
    expect(group.sim.keptLandings).toBeGreaterThan(0);
  });

  it("still returns write-write conflicts", () => {
    const on = fire("firetrident", { assumptions: { hold: 1 } });
    expect(on.returns.length).toBeGreaterThan(0);
    expect(on.returns.every((r) => r.kind === "write")).toBe(true);
  });

  it("changes nothing when assumptions never hold, and keeps some at the probe's rates", () => {
    const off = fire("firetrident-group", { inhibitAt: LATERAL_INHIBITION });
    const never = fire("firetrident-group", { inhibitAt: LATERAL_INHIBITION, assumptions: { hold: 0 } });
    expect(same(never.r)).toEqual(same(off.r));
    expect(never.sim.keptLandings).toBe(0);
    const probe = fire("firetrident-group", { inhibitAt: LATERAL_INHIBITION, assumptions: { hold: 0.687 } });
    expect(probe.sim.keptLandings).toBeGreaterThan(0);
    expect(probe.sim.m.invalidated).toBeLessThan(off.sim.m.invalidated);
    expect(same(fire("firetrident-group", { inhibitAt: LATERAL_INHIBITION, assumptions: { hold: 0.687 } }).r)).toEqual(same(probe.r));
  });

  it("applies to the locks baseline the same way", () => {
    const run = (hold?: number) => {
      const sim = new BaselineSim(p("baseline"), hubWork(), () => "v0", hold === undefined ? {} : { assumptions: { hold } });
      return { r: sim.run(), sim };
    };
    const off = run();
    expect(off.sim.m.invalidated).toBeGreaterThan(0);
    expect(same(run(0).r)).toEqual(same(off.r));
    const always = run(1);
    expect(always.sim.m.invalidated).toBe(0);
    expect(always.sim.keptLandings).toBeGreaterThan(0);
  });
});

describe("report helpers", () => {
  it("counts returns after warm-up by kind and the hub files among changed reads", () => {
    const t: ReturnTally = { total: 0, read: 0, write: 0, order: 0, trunk: 0, trunkRead: 0, readPaths: 0, readPathsHub: 0, readHub: 0 };
    const hubs = new Set(["src/context.ts"]);
    const r = (at: number, kind: ReturnInfo["kind"], reads: string[], where: ReturnInfo["where"] = "lane"): ReturnInfo => ({ task: {} as SimTask, at, where, kind, reads, writes: [] });
    tallyReturn(t, r(10, "read", ["p1/src/context.ts"]), hubs, 100);
    tallyReturn(t, r(100, "read", ["p1/src/context.ts", "p1/src/a.ts"]), hubs, 100);
    tallyReturn(t, r(200, "read", ["p2/src/b.ts"], "trunk"), hubs, 100);
    tallyReturn(t, r(300, "write", []), hubs, 100);
    expect(t).toEqual({ total: 3, read: 2, write: 1, order: 0, trunk: 1, trunkRead: 1, readPaths: 3, readPathsHub: 1, readHub: 1 });
  });

  it("summarizes seeds with a t interval and compares means", () => {
    const a = stat([1, 2, 3])!;
    expect(a.mean).toBe(2);
    expect(a.sd).toBe(1);
    expect(a.ci95).toBeCloseTo(4.303 / Math.sqrt(3), 6);
    expect(stat([null, Number.NaN])).toBeNull();
    const b = stat([3, 4, 5])!;
    const d = diff(a, b);
    expect(d.delta).toBe(2);
    expect(d.pct).toBe(100);
    expect(d.lo).toBeLessThan(2);
    expect(d.hi).toBeGreaterThan(2);
  });
});
