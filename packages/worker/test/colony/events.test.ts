import { describe, expect, it } from "vitest";
import type { ColonyEvent } from "@fire_trident/core";
import { EventHub, chunkEvents, coalesceEvents, eventKey } from "../../src/colony/events.ts";
import { decodeError, errorText, ftError } from "../../src/colony/errors.ts";

const mark = (path: string, value: number): ColonyEvent => ({ t: "mark", at: 1, region: "src", path, kind: "claim", value });
const landing = (id: string): ColonyEvent => ({ t: "landing", at: 1, landingId: id, trunkSha: "a".repeat(40), proposalIds: [], paths: [] });

describe("event coalescing", () => {
  it("keys state events and leaves facts unkeyed", () => {
    expect(eventKey(mark("a", 1))).toBe("m|src|claim|a");
    expect(eventKey({ t: "metric", at: 1, name: "x", value: 1 })).toBe("x|x");
    expect(eventKey({ t: "violations", at: 1, total: 0, byRule: {} })).toBe("v");
    expect(eventKey(landing("l1"))).toBeNull();
    expect(eventKey({ t: "decision", at: 1, decisionId: "d", kind: "triage", layer: "human", p: 1, action: "approve", subject: "s" })).toBeNull();
  });

  it("keeps the latest value per key at its latest position", () => {
    const events = [mark("a", 1), landing("l1"), mark("b", 1), mark("a", 2), landing("l2"), mark("a", 3)];
    expect(coalesceEvents(events)).toEqual([landing("l1"), mark("b", 1), landing("l2"), mark("a", 3)]);
    expect(coalesceEvents([])).toEqual([]);
  });

  it("chunks messages under the size budget without losing events", () => {
    const events = Array.from({ length: 50 }, (_, i) => mark(`src/file-${i}.ts`, i));
    const chunks = chunkEvents(events, 600);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(600);
    expect(chunks.flatMap((c) => JSON.parse(c) as ColonyEvent[])).toEqual(events);
    expect(chunkEvents([])).toEqual([]);
  });
});

describe("EventHub", () => {
  function setup(socketCount: number) {
    const sent: string[][] = Array.from({ length: socketCount }, () => []);
    const sockets = sent.map((box) => ({ send: (m: string) => void box.push(m) }));
    let now = 1_000;
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const hub = new EventHub(
      () => sockets,
      100,
      () => now,
      (fn, ms) => timers.push({ fn, ms }),
    );
    return { hub, sent, timers, advance: (ms: number) => (now += ms) };
  }

  it("drops events when nobody listens", () => {
    const { hub, timers } = setup(0);
    expect(hub.push(mark("a", 1))).toBe(0);
    expect(timers).toEqual([]);
  });

  it("batches a burst into one coalesced message per socket", () => {
    const { hub, sent, timers, advance } = setup(2);
    expect(hub.push([mark("a", 1), mark("a", 2)])).toBe(2);
    hub.push(landing("l1"));
    expect(timers).toHaveLength(1);
    expect(timers[0]!.ms).toBe(0); // first flush after a quiet period goes out at once
    timers[0]!.fn();
    expect(sent[0]).toEqual([JSON.stringify([mark("a", 2), landing("l1")])]);
    expect(sent[1]).toEqual(sent[0]);
    // Within the interval, the next flush waits for the remainder.
    advance(30);
    hub.push(mark("b", 1));
    expect(timers[1]!.ms).toBe(70);
  });

  it("keeps broadcasting when one socket fails", () => {
    const good: string[] = [];
    const hub = new EventHub(
      () => [{ send: () => { throw new Error("closing"); } }, { send: (m: string) => void good.push(m) }],
      100,
      () => 0,
      (fn) => fn(),
    );
    hub.push(landing("l1"));
    expect(good).toHaveLength(1);
  });
});

describe("errors across RPC", () => {
  it("round-trips the status through the message", () => {
    expect(decodeError(ftError(404, "colony not found"))).toEqual({ status: 404, message: "colony not found" });
    expect(decodeError(new Error("Error: [ft:409] intent is held"))).toEqual({ status: 409, message: "intent is held" });
    expect(decodeError(new Error("boom"))).toEqual({ status: 500, message: "boom" });
    expect(decodeError("plain")).toEqual({ status: 500, message: "plain" });
    expect(errorText(new Error("x".repeat(400)))).toHaveLength(300);
  });
});
