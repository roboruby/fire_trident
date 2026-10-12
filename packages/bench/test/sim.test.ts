import { describe, expect, it } from "vitest";
import { branchingRatio } from "@fire_trident/core";
import { parseEnvFile, redact } from "../src/env.ts";
import { Alias, EventQueue, Rng, q } from "../src/sim/engine.ts";
import { params, runOne } from "../src/sim/sweep.ts";
import type { Timings } from "../src/sim/common.ts";
import { HistoryWorkload, LiveWorkload } from "../src/sim/workloads.ts";
import { buildModel, parseLog } from "../src/workload.ts";

const timings: Timings = { takeMs: 250, proposeMs: 30, laneOverheadMs: 100, commitBaseMs: 620, commitPerProposalMs: 72, landMs: 692, rebaseMs: 350, testMs: 0 };

describe("engine", () => {
  it("is deterministic per seed and samples by weight", () => {
    const a = new Rng(7);
    const b = new Rng(7);
    expect(Array.from({ length: 5 }, () => a.next())).toEqual(Array.from({ length: 5 }, () => b.next()));
    const alias = new Alias([1, 0, 3]);
    const r = new Rng(1);
    const counts = [0, 0, 0];
    for (let i = 0; i < 20_000; i++) counts[alias.sample(r)]!++;
    expect(counts[1]).toBe(0);
    expect(counts[2]! / counts[0]!).toBeGreaterThan(2.6);
    expect(counts[2]! / counts[0]!).toBeLessThan(3.4);
  });

  it("runs events in time order, ties in scheduling order", () => {
    const qe = new EventQueue();
    const seen: string[] = [];
    qe.at(5, () => seen.push("b"));
    qe.at(1, () => seen.push("a"));
    qe.at(5, () => seen.push("c"));
    qe.at(9, () => qe.after(1, () => seen.push("e")));
    qe.run(100);
    expect(seen).toEqual(["a", "b", "c", "e"]);
    expect(q([1, 2, 3, 4], 0.5)).toBe(2);
  });
});

describe("workload model", () => {
  const log = ["@@aaa\t100\tfeat: a", "src/a.ts", "src/b.ts", "", "@@bbb\t200\tv1.2.3", "package.json", "", "@@ccc\t300\tfix: b", "src/b.ts", "deno_dist/b.ts", ""].join("\n");

  it("parses the log and drops release commits and generated files", () => {
    const commits = parseLog(log);
    expect(commits.map((c) => c.subject)).toEqual(["feat: a", "v1.2.3", "fix: b"]);
    const m = buildModel(commits, new Map([["src/a.ts", ["src/c.ts"]]]), { repo: "r", head: "h", cap: 30, maxNeighbours: 4 });
    expect(m.source.commitsUsed).toBe(2);
    expect(m.sizeHist[1]).toBe(1);
    expect(m.sizeHist[2]).toBe(1);
    const a = m.files.indexOf("src/a.ts");
    const b = m.files.indexOf("src/b.ts");
    expect(m.neighbours[a]).toEqual([[b, 1]]);
    expect(m.imports[a]).toEqual([m.files.indexOf("src/c.ts")]);
    expect(m.files).not.toContain("deno_dist/b.ts");
  });

  it("generates tasks whose reads are imports of their writes", () => {
    const m = buildModel(parseLog(log), new Map([["src/a.ts", ["src/c.ts"]], ["src/b.ts", []]]), { repo: "r", head: "h", cap: 30, maxNeighbours: 4 });
    const w = new HistoryWorkload(m, { packages: 3, regionDepth: 3, maxReads: 8, work: { medianMs: 1000, sigma: 0 } });
    const rng = new Rng(3);
    for (let i = 0; i < 50; i++) {
      const t = w.make(i, 0, rng);
      const pkg = t.writes[0]!.split("/")[0];
      expect(t.writes.every((p) => p.startsWith(`${pkg}/`))).toBe(true);
      if (t.writes.includes(`${pkg}/src/a.ts`)) expect(t.reads).toContain(`${pkg}/src/c.ts`);
      expect(t.primary).toBe(`${pkg}/src`);
      expect(t.workMs).toBeCloseTo(1000, 6);
    }
  });
});

describe("simulator", () => {
  const live = () => new LiveWorkload({ regions: 64, regionDepth: 3, work: { medianMs: 0, sigma: 0 } });
  const p = (model: "baseline" | "firetrident" | "firetrident-group", agents: number) =>
    params(model, agents, { durationMs: 120_000, warmupMs: 30_000, seed: 1, timings, backlog: 400, rampMs: 1_000 });

  it("is deterministic for a seed", () => {
    expect(runOne(p("firetrident", 20), live(), () => null).landingsPerMin).toBe(runOne(p("firetrident", 20), live(), () => null).landingsPerMin);
  });

  it("caps the baseline at one change per land + rebase, and FireTrident near one commit per trunk-writer cycle", () => {
    const base = runOne(p("baseline", 50), live(), () => null);
    expect(base.landingsPerMin).toBeGreaterThan(50);
    expect(base.landingsPerMin).toBeLessThanOrEqual(60_000 / (timings.landMs + timings.rebaseMs) + 1);
    const fire = runOne(p("firetrident", 50), live(), () => null);
    expect(fire.commitsPerMin).toBeLessThanOrEqual(60_000 / (timings.commitBaseMs + timings.commitPerProposalMs) + 1);
    expect(fire.landingsPerMin).toBeGreaterThan(base.landingsPerMin);
    const group = runOne(p("firetrident-group", 50), live(), () => null);
    expect(group.landingsPerMin).toBeGreaterThan(2 * fire.landingsPerMin);
    expect(group.meanBatch!).toBeGreaterThan(fire.meanBatch!);
  });

  it("computes the RegionDO sigma (returns are never parents) through core branchingRatio", () => {
    const now = 100_000;
    const causes = [
      { id: "land:L1:p0", at: now - 20_000 },
      ...["a", "b", "c"].map((x) => ({ id: `ret:p${x}`, causeId: "land:L1:p0", at: now - 19_000 })),
    ];
    // Plain core semantics: every event is a parent, 3 children over 4 events.
    expect(branchingRatio(causes, now)).toBeCloseTo(0.75, 6);
    // The simulator's mapping: returns get an infinite time, so only the landing is a parent.
    const mapped = causes.map((e) => (e.id.startsWith("ret:") ? { ...e, at: Number.POSITIVE_INFINITY } : e));
    expect(branchingRatio(mapped, now)).toBeCloseTo(3, 6);
  });
});

describe("env", () => {
  it("parses env files and redacts tokens", () => {
    expect(parseEnvFile("# c\nFT_URL=https://x.dev\nFT_TOKEN='abc'\n")).toEqual({ FT_URL: "https://x.dev", FT_TOKEN: "abc" });
    expect(redact("Authorization: Bearer abc123 and art_v1_not-a-real-token")).toBe("Authorization: Bearer <redacted> and <redacted>");
  });
});
