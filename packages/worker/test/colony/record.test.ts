import { describe, expect, it } from "vitest";
import type { ColonyEvent } from "@fire_trident/core";
import { EventRecorder, SIGMA_STEP, coalesceMetrics, recordable } from "../../src/colony/events.ts";

const mark = (path: string): ColonyEvent => ({ t: "mark", at: 1, region: "src", path, kind: "claim", value: 1 });
const metric = (name: string, value: number): ColonyEvent => ({ t: "metric", at: 1, name, value });
const sigma = (region: string, value: number): ColonyEvent => ({ t: "sigma", at: 1, region, sigma: value });
const landing = (id: string): ColonyEvent => ({ t: "landing", at: 1, landingId: id, trunkSha: "a".repeat(40), proposalIds: ["p"], paths: ["src/a.ts"] });

function setup() {
  const written: ColonyEvent[][] = [];
  const timers: Array<() => void> = [];
  let flushed = 0;
  const rec = new EventRecorder(
    (events) => void written.push(events),
    500,
    (fn) => void timers.push(fn),
    () => void flushed++,
  );
  const run = () => {
    while (timers.length) timers.shift()?.();
  };
  return { rec, written, run, flushes: () => flushed };
}

describe("event record", () => {
  it("keeps facts and state, skips marks and internal metrics", () => {
    expect(recordable(mark("a"))).toBe(false);
    expect(recordable(metric("trunk.cycleMs", 1))).toBe(false);
    expect(recordable(metric("inhibition:src", 1))).toBe(false);
    expect(recordable(metric("colony.lagMs", 1))).toBe(false);
    expect(recordable(metric("landingsPerMin", 1))).toBe(true);
    expect(recordable(metric("funnel.proof", 1))).toBe(true);
    expect(recordable(landing("l1"))).toBe(true);
    expect(recordable({ t: "intent", at: 1, intentId: "i", status: "open", title: "t", footprint: ["a"] })).toBe(true);
  });

  it("coalesces metric values per name within a batch, at the last position", () => {
    const events = [metric("a", 1), landing("l1"), metric("b", 1), metric("a", 2), landing("l2")];
    expect(coalesceMetrics(events)).toEqual([landing("l1"), metric("b", 1), metric("a", 2), landing("l2")]);
  });

  it("writes one batch per interval, after the events that were published", () => {
    const { rec, written, run, flushes } = setup();
    rec.add([mark("a"), landing("l1"), metric("landings", 1)]);
    rec.add([metric("landings", 2), landing("l2")]);
    expect(written).toEqual([]);
    expect(rec.pending).toBe(4);
    run();
    expect(written).toEqual([[landing("l1"), metric("landings", 2), landing("l2")]]);
    expect(flushes()).toBe(1);
    // Nothing worth keeping: no write, no timer.
    rec.add(mark("b"));
    run();
    expect(written).toHaveLength(1);
  });

  it("keeps a region's sigma only when it moved by a step or crossed 1", () => {
    const { rec, written, run } = setup();
    rec.add([sigma("src", 0.2), sigma("src", 0.2 + SIGMA_STEP / 2), sigma("src", 0.4), sigma("docs", 0.4)]);
    rec.add([sigma("src", 0.99), sigma("src", 1.01), sigma("src", 1.02), sigma("src", 0.98)]);
    run();
    expect(written.flat().map((e) => (e.t === "sigma" ? `${e.region}:${e.sigma}` : e.t))).toEqual(["src:0.2", "src:0.4", "docs:0.4", "src:0.99", "src:1.01", "src:0.98"]);
  });

  it("flushes on demand and forgets everything when cleared", () => {
    const { rec, written } = setup();
    rec.add(landing("l1"));
    rec.flush();
    expect(written).toEqual([[landing("l1")]]);
    rec.add(landing("l2"));
    rec.clear();
    rec.flush();
    expect(written).toHaveLength(1);
  });

  it("survives a failing write", () => {
    const rec = new EventRecorder(
      () => {
        throw new Error("disk full");
      },
      500,
      () => undefined,
    );
    rec.add(landing("l1"));
    expect(() => rec.flush()).not.toThrow();
    expect(rec.pending).toBe(0);
  });
});
