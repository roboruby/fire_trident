import { describe, expect, it } from "vitest";
import { repulsion } from "@fire_trident/core";
import type { ColonyEvent, FieldReading } from "@fire_trident/core";
import { EmitPacer, Gate, WaitPacer, fastRepulsion, fieldIndex, isPatternPath, unseenByRegion, type RecentClaim } from "../../src/colony/views.ts";
import { EventHub, coalesceEvents } from "../../src/colony/events.ts";
import { admissionBar } from "../../src/region/logic.ts";

/** Deterministic pseudo-random numbers (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PATHS = ["src/a.ts", "src/b.ts", "src/lib/c.ts", "src/lib/d.ts", "src/lib/", "src/**/*.ts", "src/{a,b}.ts", "docs/x.md", "src/lib/e.ts"];

describe("fastRepulsion", () => {
  it("equals core repulsion on random fields and footprints, directories and globs included", () => {
    const rand = rng(7);
    const pick = (): string => PATHS[Math.floor(rand() * PATHS.length)]!;
    for (let round = 0; round < 400; round++) {
      const byPath: FieldReading["byPath"] = {};
      for (let i = 0; i < 1 + Math.floor(rand() * 6); i++) byPath[pick()] = { claim: rand() < 0.8 ? rand() : 0, danger: rand() < 0.3 ? rand() : 0, need: 1 };
      const footprint = Array.from({ length: 1 + Math.floor(rand() * 3) }, pick);
      const index = fieldIndex(byPath);
      expect(fastRepulsion(index, footprint)).toBeCloseTo(repulsion(index.byPath, footprint), 9);
    }
  });

  it("counts a field path once however many footprint entries it overlaps", () => {
    const index = fieldIndex({ "src/lib/": { claim: 1 }, "src/a.ts": { claim: 0.5, danger: 0.25 } });
    expect(fastRepulsion(index, ["src/lib/c.ts", "src/lib/d.ts"])).toBe(1);
    expect(fastRepulsion(index, ["src/a.ts", "src/a.ts"])).toBe(0.75);
    expect(fastRepulsion(index, ["docs/x.md"])).toBe(0);
  });

  it("indexes only claim and danger, takes the reader's own claims out, and stays safe for odd keys", () => {
    const byPath = JSON.parse('{"__proto__":{"claim":1},"src/a.ts":{"claim":1.5,"need":3},"src/n.ts":{"need":2}}') as FieldReading["byPath"];
    const index = fieldIndex(byPath, new Map([["src/a.ts", 1]]));
    expect(Object.keys(index.byPath).sort()).toEqual(["__proto__", "src/a.ts"]);
    expect(index.exact.get("src/a.ts")).toEqual({ claim: 0.5, danger: 0 });
    expect(fieldIndex({ "src/a.ts": { claim: 1 } }, new Map([["src/a.ts", 1]])).repulsive).toBe(false);
    expect(isPatternPath("src/lib/")).toBe(true);
    expect(isPatternPath("src/*.ts")).toBe(true);
    expect(isPatternPath("src/a.ts")).toBe(false);
  });
});

describe("unseenByRegion", () => {
  it("keeps other agents' claims each region's reading may predate, and prunes old ones", () => {
    const now = 100_000;
    const claim = (regions: string[], doneAt: number | null): RecentClaim => ({ paths: new Set(regions.map((r) => `${r}/f.ts`)), regions: new Set(regions), doneAt });
    const recent = new Map<string, RecentClaim>([
      ["me", claim(["src"], now)],
      ["inflight", claim(["src", "docs"], null)],
      ["after", claim(["src"], now - 100)],
      ["before", claim(["src"], now - 5_000)],
      ["old", claim(["src"], now - 60_000)],
    ]);
    const starts: Record<string, number> = { src: now - 1_000, docs: now - 50 };
    const out = unseenByRegion(recent, "me", (r) => starts[r], now - 10_000);
    expect(out.get("src")).toHaveLength(2); // in flight, and done after the src reading started
    expect(out.get("docs")).toHaveLength(1); // only the one still in flight
    expect(recent.has("old")).toBe(false);
    expect(recent.has("before")).toBe(true);
  });
});

describe("WaitPacer", () => {
  it("keeps the base hint for a few waiters and spreads thousands over time", () => {
    const p = new WaitPacer(200, 30_000, 30_000);
    expect(p.wait("a", 3_000, 0)).toBe(3_000);
    for (let i = 0; i < 4_000; i++) p.wait(`w${i}`, 3_000, 10);
    expect(p.wait("b", 3_000, 20)).toBe(Math.ceil((4_002 / 200) * 1000));
    for (let i = 0; i < 20_000; i++) p.wait(`x${i}`, 3_000, 30);
    expect(p.wait("c", 3_000, 40)).toBe(30_000); // capped
    p.done("c");
    expect(p.size).toBe(24_002);
    // Waiters that did not come back within the window stop counting.
    expect(p.wait("late", 1_500, 40_000)).toBe(1_500);
    expect(p.size).toBe(1);
  });
});

describe("EmitPacer", () => {
  it("asks regions to batch longer as more of them emit", () => {
    const p = new EmitPacer(60, 100, 5_000, 10_000);
    expect(p.pace("src", 0)).toBe(100);
    for (let i = 0; i < 64; i++) p.pace(`r${i}`, 1);
    expect(p.pace(null, 2)).toBe(Math.round((1000 * 65) / 60));
    for (let i = 0; i < 1_000; i++) p.pace(`q${i}`, 3);
    expect(p.pace(null, 4)).toBe(5_000);
    // Regions quiet for the window are forgotten.
    expect(p.pace("src", 20_000)).toBe(100);
  });
});

describe("EventHub incremental coalescing", () => {
  it("broadcasts what coalescing the whole buffer would, for random event streams", () => {
    const rand = rng(11);
    for (let round = 0; round < 50; round++) {
      const sent: string[] = [];
      let flushNow: (() => void) | null = null;
      const hub = new EventHub(
        () => [{ send: (m: string) => void sent.push(m) }],
        100,
        () => 0,
        (fn) => {
          flushNow = fn;
        },
      );
      const all: ColonyEvent[] = [];
      for (let i = 0; i < 300; i++) {
        const r = rand();
        const e: ColonyEvent =
          r < 0.5
            ? { t: "mark", at: i, region: "src", path: `src/${Math.floor(rand() * 20)}.ts`, kind: "claim", value: i }
            : r < 0.7
              ? { t: "metric", at: i, name: `m${Math.floor(rand() * 3)}`, value: i }
              : { t: "landing", at: i, landingId: `l${i}`, trunkSha: "a".repeat(40), proposalIds: [], paths: [] };
        all.push(e);
        hub.push(e);
      }
      expect(flushNow).not.toBeNull();
      flushNow!();
      expect(sent.flatMap((m) => JSON.parse(m) as ColonyEvent[])).toEqual(coalesceEvents(all));
    }
  });

  it("stays bounded and keeps the newest events when the buffer overflows", () => {
    let flushNow: (() => void) | null = null;
    const sent: string[] = [];
    const hub = new EventHub(
      () => [{ send: (m: string) => void sent.push(m) }],
      100,
      () => 0,
      (fn) => {
        flushNow = fn;
      },
    );
    const t0 = Date.now();
    for (let i = 0; i < 120_000; i++) hub.push({ t: "landing", at: i, landingId: `l${i}`, trunkSha: "a".repeat(40), proposalIds: [], paths: [] });
    expect(Date.now() - t0).toBeLessThan(3_000); // dropping the oldest is amortized, not one compaction per push
    flushNow!();
    const got = sent.flatMap((m) => JSON.parse(m) as Array<{ landingId: string }>);
    expect(got.length).toBeLessThanOrEqual(50_000);
    expect(got.length).toBeGreaterThanOrEqual(45_000);
    expect(got[got.length - 1]!.landingId).toBe("l119999");
    expect(Number(got[0]!.landingId.slice(1))).toBe(120_000 - got.length);
  });
});

describe("admissionBar", () => {
  it("follows the lateral-inhibition setting and never drops to counting dead claims", () => {
    expect(admissionBar(undefined)).toBe(0.5);
    expect(admissionBar("0.3")).toBe(0.3);
    expect(admissionBar("off")).toBe(0.5);
    expect(admissionBar("0")).toBe(0.5);
    expect(admissionBar("2")).toBe(0.5);
    expect(admissionBar("x")).toBe(0.5);
  });
});

describe("LagProbe", () => {
  it("reports a window whose timer fired late, and stays quiet otherwise", async () => {
    const { LagProbe } = await import("../../src/colony/lag.ts");
    const lines: string[] = [];
    const probe = new LagProbe("colony x", (l) => lines.push(l), 100, 1_000, 250);
    // Not started: drive ticks by hand from t = 0 (the first one is expected at 100).
    (probe as unknown as { expected: number; windowStart: number }).expected = 100;
    (probe as unknown as { windowStart: number }).windowStart = 0;
    for (let t = 100; t <= 1_000; t += 100) probe.tick(t);
    expect(lines).toEqual([]);
    probe.tick(1_100);
    probe.tick(1_900); // 700 ms late: the thread was busy or paused
    probe.tick(2_000);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ ft: "lag", object: "colony x", worstMs: 700 });
  });
});

describe("Gate", () => {
  it("lets a few through at once, queues the next ones in order, and refuses past the queue", async () => {
    const gate = new Gate(2, 2);
    expect(gate.enter()).toBe(true);
    expect(gate.enter()).toBe(true);
    const order: string[] = [];
    const third = gate.enter();
    const fourth = gate.enter();
    expect(third).toBeInstanceOf(Promise);
    expect(fourth).toBeInstanceOf(Promise);
    expect(gate.enter()).toBeNull(); // queue full: back off
    void (third as Promise<void>).then(() => order.push("third"));
    void (fourth as Promise<void>).then(() => order.push("fourth"));
    expect([gate.inFlight, gate.waiting]).toEqual([2, 2]);
    gate.leave(); // the oldest waiter takes the turn over
    await Promise.resolve();
    expect(order).toEqual(["third"]);
    expect([gate.inFlight, gate.waiting]).toEqual([2, 1]);
    gate.leave();
    await Promise.resolve();
    expect(order).toEqual(["third", "fourth"]);
    gate.leave();
    gate.leave();
    expect([gate.inFlight, gate.waiting]).toEqual([0, 0]);
    expect(gate.enter()).toBe(true);
  });
});
