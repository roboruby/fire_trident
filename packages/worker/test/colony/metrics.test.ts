import { describe, expect, it } from "vitest";
import {
  BUCKET_MS,
  LIVE_METRICS,
  METRIC_KEYS,
  SERIES_BUCKETS,
  STOP_GRACE_MS,
  agentCounters,
  changedMetrics,
  counterBuckets,
  effectiveState,
  gaugeBuckets,
  inPlatform,
  minuteOf,
  seriesStart,
  stableMetrics,
  summaryOf,
} from "../../src/colony/metrics.ts";

describe("series buckets", () => {
  it("maps times to minutes and a window to its start", () => {
    expect(minuteOf(0)).toBe(0);
    expect(minuteOf(BUCKET_MS - 1)).toBe(0);
    expect(minuteOf(BUCKET_MS * 7 + 5)).toBe(7);
    expect(seriesStart(100, 30)).toBe(71 * BUCKET_MS);
    expect(seriesStart(100)).toBe((100 - SERIES_BUCKETS + 1) * BUCKET_MS);
  });

  it("sums counters per bucket and ignores rows outside the window", () => {
    const rows = [
      { minute: 96, value: 2 },
      { minute: 100, value: 3 },
      { minute: 100, value: 1 },
      { minute: 101, value: 9 },
      { minute: 90, value: 9 },
      { minute: 99, value: Number.NaN },
    ];
    expect(counterBuckets(rows, 100, 5)).toEqual([2, 0, 0, 0, 4]);
    expect(counterBuckets([], 100, 3)).toEqual([0, 0, 0]);
    expect(counterBuckets(rows, 100)).toHaveLength(SERIES_BUCKETS);
  });

  it("carries gauges forward, starts from the sample before the window, and ends at the current value", () => {
    const rows = [
      { minute: 97, value: 214 },
      { minute: 99, value: 150 },
    ];
    expect(gaugeBuckets(rows, 100, null, 120, 5)).toEqual([0, 214, 214, 150, 120]);
    expect(gaugeBuckets(rows, 100, 300, 120, 5)).toEqual([300, 214, 214, 150, 120]);
    expect(gaugeBuckets([], 100, 80, 80, 3)).toEqual([80, 80, 80]);
  });

  it("draws a flat line at the current value when nothing was ever sampled", () => {
    expect(gaugeBuckets([], 100, null, 42, 4)).toEqual([42, 42, 42, 42]);
    expect(gaugeBuckets([{ minute: 10, value: 5 }], 100, null, 7, 3)).toEqual([7, 7, 7]);
  });
});

describe("metrics", () => {
  it("always carries every stable key, zero-filled, then extras in name order", () => {
    const m = stableMetrics({ landings: 3, zeta: 1, alpha: 2, agentsActive: Number.NaN, bogus: Number.POSITIVE_INFINITY });
    expect(Object.keys(m).slice(0, METRIC_KEYS.length)).toEqual([...METRIC_KEYS]);
    expect(m.landings).toBe(3);
    expect(m.agentsActive).toBe(0);
    expect(m["funnel.human"]).toBe(0);
    expect(Object.keys(m).slice(METRIC_KEYS.length)).toEqual(["alpha", "zeta"]);
    expect(m).not.toHaveProperty("bogus");
  });

  it("counts agents by state", () => {
    expect(agentCounters({ idle: 2, working: 3, proposing: 1, waiting: 4, dead: 5 })).toEqual({
      agents: 15,
      agentsActive: 10,
      agentsWorking: 4,
      agentsIdle: 2,
      agentsWaiting: 4,
      agentsDead: 5,
    });
    expect(agentCounters({}).agentsActive).toBe(0);
  });

  it("sends only changed live metrics, and all of them on a full tick", () => {
    const sent = new Map<string, number>();
    const current = Object.fromEntries(LIVE_METRICS.map((k, i) => [k, i]));
    expect(changedMetrics(current, sent, false)).toHaveLength(LIVE_METRICS.length);
    expect(changedMetrics(current, sent, false)).toEqual([]);
    expect(changedMetrics({ ...current, landingsPerMin: 99 }, sent, false)).toEqual([{ name: "landingsPerMin", value: 99 }]);
    expect(changedMetrics({ ...current, landingsPerMin: 99 }, sent, true)).toHaveLength(LIVE_METRICS.length);
    expect(changedMetrics({ unrelated: 1 }, new Map(), true)).toEqual([]);
  });
});

describe("agents", () => {
  it("counts an agent stopped since it was last seen as dead", () => {
    expect(effectiveState("waiting", 1_000, null)).toBe("waiting");
    expect(effectiveState("waiting", 1_000, undefined)).toBe("waiting");
    expect(effectiveState("idle", 1_000, 1_000)).toBe("dead");
    expect(effectiveState("idle", 1_000 + STOP_GRACE_MS, 1_000)).toBe("dead");
    expect(effectiveState("working", 1_001 + STOP_GRACE_MS, 1_000)).toBe("working");
  });

  it("knows which kinds run inside the platform", () => {
    expect(inPlatform("internal")).toBe(true);
    expect(inPlatform("synthetic")).toBe(true);
    expect(inPlatform("external")).toBe(false);
  });

  it("summarizes a colony record", () => {
    const colony = { id: "web", name: "Web", trunk: { namespace: "ft-trunk", name: "web--trunk", remote: "r" }, trunkSha: "a".repeat(40), createdAt: 5, regionDepth: 2 };
    expect(summaryOf(colony, 0, { landings: 0 })).toEqual({ id: "web", name: "Web", createdAt: 5, trunkSha: "a".repeat(40), regionDepth: 2, lastLandingAt: null, counters: { landings: 0 } });
    const s = summaryOf({ ...colony, source: { url: "https://x", branch: "main" }, greenSha: "b".repeat(40) }, 9, {});
    expect(s).toMatchObject({ lastLandingAt: 9, source: { url: "https://x", branch: "main" }, greenSha: "b".repeat(40) });
  });
});
