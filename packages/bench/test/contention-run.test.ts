import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { esbuildParser } from "../src/contention/check.ts";
import { deploymentConfig, origin } from "../src/contention/config.ts";
import { readmeText, writeResults } from "../src/contention/report.ts";
import { classifyReturn, runContention, seedChanges, type RunOptions } from "../src/contention/run.ts";
import { DEFAULT_WORKLOAD, generate, type WorkloadOptions } from "../src/contention/workload.ts";
import { parseCli, planText, tokenSource } from "../src/scenarios/contention-scale.ts";
import { FakeColony } from "./contention-fake.ts";

const small = (over: Partial<WorkloadOptions> = {}): WorkloadOptions => ({ ...DEFAULT_WORKLOAD, hot: 2, modules: 8, counters: 2, registry: 4, intents: 48, ...over });
const runOpts = (over: Partial<RunOptions> = {}): RunOptions => ({ colony: "contention-test", agents: 8, rampS: 0, timeoutS: 30, drainS: 2, pollMs: 5, feed: false, regionDepth: 2, pool: 10, keep: false, callTimeoutMs: 5_000, ...over });

async function runOn(fake: FakeColony, wo: Partial<WorkloadOptions>, ro: Partial<RunOptions> = {}) {
  vi.stubGlobal("fetch", fake.fetch);
  const lines: string[] = [];
  try {
    const report = await runContention(generate(small(wo)), runOpts(ro), { cfg: { url: "https://fake.test", token: "admin-secret-token" }, trunk: fake, parse: await esbuildParser(), log: (s) => lines.push(s) });
    return { report, lines };
  } finally {
    fake.stop();
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a contention-scale run against a fake colony", () => {
  it("with text merge off, sends back every change whose file moved, redoes it on the current trunk, and every check passes", async () => {
    const fake = new FakeColony({ textMerge: false, cycleMs: 10 });
    const { report, lines } = await runOn(fake, {});
    expect(report.check?.checks.filter((c) => !c.ok).map((c) => c.summary)).toEqual([]);
    expect(report.check?.passed).toBe(true);
    expect(report.run.landedTasks).toBe(48);
    expect(report.seed).toMatchObject({ files: generate(small()).files.length, changes: 1 });
    expect(report.returns.total).toBeGreaterThan(0);
    expect(report.returns.byCause["stale-read"]).toBe(report.returns.total);
    expect(report.rounds.max).toBeGreaterThan(1);
    expect(report.holders.peak).toBeGreaterThan(1);
    expect(report.takes.intentsLeftOpen).toBe(report.returns.total);
    expect(report.metrics.delta.landedProposals).toBe(report.run.landedProposals);
    expect(report.cleanup).toEqual({ deleted: true, kept: false, detail: "deleted" });
    expect(fake.deleted).toBe(true);
    expect(lines.some((l) => l.startsWith("PASS  every counter equals its landed increments"))).toBe(true);
    expect(JSON.stringify(report)).not.toContain("admin-secret-token");
  }, 30_000);

  it("with text merge on, sends back an increment whose edit repeats one that landed from the same read, and every counter equals its landed increments", async () => {
    const fake = new FakeColony({ textMerge: true, insertions: true, cycleMs: 300 });
    const { report } = await runOn(fake, { hot: 1, counters: 2, intents: 12, mix: { register: 0, increment: 1, "read-own": 0 } });
    expect(report.run.landedTasks).toBe(12);
    expect(report.check?.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual([]);
    expect(report.check?.counters).toMatchObject({ lostUpdates: 0, doubleCounts: 0, landedIncrements: 12, total: 12 });
    // Repeats went back stale and were redone on the current trunk; increments of the other counter still merged.
    expect(report.returns.byCause["stale-read"]).toBeGreaterThan(0);
    expect(report.check?.merges.proposals).toBeGreaterThan(0);
  }, 30_000);

  it("with already-on-trunk closing too, closes no increment made from a stale read, and every check passes", async () => {
    const fake = new FakeColony({ textMerge: true, insertions: true, alreadyOnTrunk: true, cycleMs: 300 });
    const { report } = await runOn(fake, { hot: 1, counters: 1, intents: 8, mix: { register: 0, increment: 1, "read-own": 0 } });
    expect(report.run.ends["on-trunk"] ?? 0).toBe(0);
    expect(report.check?.counters).toMatchObject({ lostUpdates: 0, closedOnTrunk: 0, landedIncrements: 8, total: 8 });
    expect(report.check?.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual([]);
    expect(fake.metrics.alreadyOnTrunk).toBe(0);
  }, 30_000);

  it("with text merge on and the insertion rule, lands the full mix with every check passing", async () => {
    const fake = new FakeColony({ textMerge: true, insertions: true, alreadyOnTrunk: true, cycleMs: 50 });
    const { report } = await runOn(fake, { intents: 60, modules: 12 }, { agents: 12 });
    expect(report.check?.checks.filter((c) => !c.ok).map((c) => c.summary)).toEqual([]);
    expect(report.run.landedTasks).toBe(60);
    expect(report.check?.counters.lostUpdates).toBe(0);
    expect(report.check?.merges.insertions).toBeGreaterThan(0);
  }, 30_000);

  it("catches a trunk writer that lands changes without checking what they read", async () => {
    const fake = new FakeColony({ skipOcc: true, cycleMs: 100 });
    const { report } = await runOn(fake, { intents: 60, modules: 12 });
    expect(report.returns.total).toBe(0);
    expect(report.check?.passed).toBe(false);
    const failed = report.check!.checks.filter((c) => !c.ok).map((c) => c.name);
    expect(failed).toContain("every counter equals its landed increments");
    expect(report.check!.counters.lostUpdates + report.check!.registry.missingLanded + report.check!.readOwn.staleConstants).toBeGreaterThan(0);
  }, 30_000);

  it("declares the work again when a take loses its assignment, and still lands every task", async () => {
    const fake = new FakeColony({ textMerge: false, leaseFailEvery: 3, cycleMs: 10 });
    const { report } = await runOn(fake, { intents: 24 });
    expect(report.takes.lostAssignments).toBeGreaterThan(0);
    expect(report.takes.waits["pool empty"]).toBe(report.takes.lostAssignments);
    expect(report.run.landedTasks).toBe(24);
    expect(report.check?.passed).toBe(true);
  }, 30_000);

  it("refuses a deployment without inline changes, and a colony that already exists", async () => {
    vi.stubGlobal("fetch", new FakeColony({ flags: ["FT_TEXT_MERGE"] }).fetch);
    const deps = { cfg: { url: "https://fake.test", token: "t" }, trunk: new FakeColony(), parse: () => null, log: () => undefined };
    await expect(runContention(generate(small()), runOpts(), deps)).rejects.toThrow(/FT_INLINE is not on/);
    const taken = new FakeColony();
    taken.colony = "contention-test";
    vi.stubGlobal("fetch", taken.fetch);
    await expect(runContention(generate(small()), runOpts(), deps)).rejects.toThrow(/already exists/);
    expect(taken.deleted).toBe(false);
  });

  it("writes the results through the evidence redaction, and a README that covers every run in the directory", async () => {
    const fake = new FakeColony({ textMerge: false, cycleMs: 10 });
    const { report } = await runOn(fake, { intents: 12 }, { agents: 4 });
    const dir = mkdtempSync(join(tmpdir(), "contention-results-"));
    try {
      const log = "token art_v1_abcdefSECRET and admin-secret-token and Bearer abc.def\n";
      const written = writeResults(dir, { ...report, command: "node packages/bench/src/scenarios/contention-scale.ts --base https://fake.test --agents 4" }, log, ["admin-secret-token"]);
      expect(written.map((p) => p.slice(dir.length + 1))).toEqual(["README.md", "contention-scale-n4.json", "run-n4.log"]);
      const saved = readFileSync(join(dir, "contention-scale-n4.json"), "utf8");
      expect(JSON.parse(saved)).toEqual(JSON.parse(JSON.stringify({ ...report, command: "node packages/bench/src/scenarios/contention-scale.ts --base https://fake.test --agents 4" })));
      expect(saved).toMatch(/\n {4}\{"id":"t00001","kind":/);
      const text = readFileSync(join(dir, "run-n4.log"), "utf8");
      expect(text).not.toMatch(/SECRET|admin-secret-token|abc\.def/);
      writeResults(dir, { ...report, options: { ...report.options, agents: 9 }, command: "second run" }, "", []);
      const readme = readFileSync(join(dir, "README.md"), "utf8");
      expect(readme).toContain("<!-- measured -->");
      expect(readme).toContain("MEASURED on fake.test");
      expect(readme).toMatch(/\| Measure \| 4 agents \| 9 agents \|/);
      expect(readme).toMatch(/\| every counter equals its landed increments \| PASS \| PASS \|/);
      expect(readme).toContain("## Honest limits");
      expect(readmeText([])).toContain("No runs");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("the pieces of a run", () => {
  it("names why a change came back", () => {
    expect(classifyReturn("returned", "stale: hot/h00/state.ts changed after this change read it; text merge of hot/h00/state.ts: 1 conflicting hunk, at line 9 of its base")).toBe("merge-conflict");
    expect(classifyReturn("returned", "stale: hot/h00/state.ts changed after this change read it")).toBe("stale-read");
    expect(classifyReturn("rejected", "out of scope")).toBe("review");
    expect(classifyReturn("returned", "hot/h00/state.ts is being split by intent int_1; take again after it lands")).toBe("megafile-hold");
    expect(classifyReturn("returned", "withdrawn")).toBe("other");
  });

  it("splits the seed into inline changes under the limits, in path order", () => {
    const files = Array.from({ length: 130 }, (_, i) => ({ path: `f${String(i).padStart(3, "0")}.ts`, text: "x".repeat(5_000) }));
    const changes = seedChanges(files);
    expect(changes.map((c) => c.length)).toEqual([60, 60, 10]);
    expect(changes.flat()).toEqual(files);
    expect(seedChanges([{ path: "a", text: "x".repeat(300_000) }, { path: "b", text: "y".repeat(300_000) }]).map((c) => c.length)).toEqual([1, 1]);
  });
});

describe("the command", () => {
  it("defaults to 1,000 agents on 3,000 intents, 10 hot files and 400 modules, on a colony of its own", () => {
    const o = parseCli(["--base", "https://staging.example"]);
    expect(o.plan).toBe(false);
    expect(o.workload).toMatchObject({ hot: 10, modules: 400, counters: 4, intents: 3_000, certTest: true });
    expect(o.run).toMatchObject({ colony: "contention-scale-1000", agents: 1_000, rampS: 10, timeoutS: 1_800, pool: 1_008, keep: false, feed: true });
    expect(parseCli(["--base", "https://s", "--agents", "200", "--dry-run", "--keep"])).toMatchObject({ plan: true, run: { colony: "contention-scale-200", agents: 200, keep: true }, workload: { intents: 600 } });
    expect(parseCli(["--base", "https://s", "--scenario", "contention-scale", "--plan"]).plan).toBe(true);
    expect(() => parseCli([])).toThrow(/--base/);
    expect(() => parseCli(["--base", "https://s", "--scenario", "flood"])).toThrow(/--scenario/);
    expect(() => parseCli(["--base", "https://s", "--colony", "Bad Name"])).toThrow(/slug/);
    expect(() => parseCli(["--base", "https://s", "--agents", "0"])).toThrow(/--agents/);
  });

  it("prints a plan that sends nothing and never prints the token", () => {
    const o = parseCli(["--base", "https://staging.example", "--agents", "200", "--plan"]);
    const text = planText(o, generate(o.workload), tokenSource({ FT_TOKEN: "sekrit-token" }, true), true, "/x/packages/bench/results/2026-10-19-contention-scale");
    expect(text).toContain("nothing is sent");
    expect(text).toContain("contention-scale-200");
    expect(text).toContain("600 (seed 1): 200 register, 200 increment, 200 read-own");
    expect(text).toContain("admin token from FT_TOKEN");
    expect(text).not.toContain("sekrit-token");
  });

  it("reads the token from the environment, else from a config file issued for this deployment, and Access headers in pairs", () => {
    const file = "FT_URL=https://staging.example\nFT_TOKEN=from-file\n";
    expect(deploymentConfig("https://staging.example/", { HOME: "/h", FT_TOKEN: "from-env" }, () => file)).toEqual({ url: "https://staging.example", token: "from-env" });
    expect(deploymentConfig("https://staging.example", { HOME: "/h" }, () => file).token).toBe("from-file");
    expect(deploymentConfig("https://other.example", { HOME: "/h" }, () => file).token).toBeUndefined();
    expect(deploymentConfig("https://firetrident.com", { HOME: "/h" }, () => "FT_TOKEN=prod\n").token).toBe("prod");
    expect(deploymentConfig("https://s.example", { CF_ACCESS_CLIENT_ID: "id", CF_ACCESS_CLIENT_SECRET: "sec" }, () => null).headers).toEqual({ "CF-Access-Client-Id": "id", "CF-Access-Client-Secret": "sec" });
    expect(() => deploymentConfig("https://s.example", { CF_ACCESS_CLIENT_ID: "id" }, () => null)).toThrow(/both/);
    expect(() => deploymentConfig("ftp://s", {}, () => null)).toThrow(/--base/);
    expect(origin("https://A.example")).toBe("https://a.example:443");
    expect(tokenSource({}, false)).toMatch(/MISSING/);
  });
});
