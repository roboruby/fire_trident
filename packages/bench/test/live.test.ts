import { describe, expect, it } from "vitest";
import { errorDetail, LiveFeed, errorBackoffMs } from "../src/live.ts";

/** Feed a raw WebSocket message to the feed, as the socket would. */
function deliver(feed: LiveFeed, events: unknown[]): void {
  (feed as unknown as { onMessage(data: unknown): void }).onMessage(JSON.stringify(events));
}

describe("live feed outcomes", () => {
  it("resolves a waiting agent when its proposal's final status arrives, and ignores interim ones", async () => {
    const feed = new LiveFeed();
    const waiting = feed.waitFor("prp_1", 5_000);
    deliver(feed, [{ t: "proposal", at: 1, proposalId: "prp_1", intentId: "i", agentId: "a", status: "ready" }]);
    deliver(feed, [{ t: "proposal", at: 2, proposalId: "prp_2", intentId: "i", agentId: "b", status: "landed" }]);
    deliver(feed, [{ t: "proposal", at: 3, proposalId: "prp_1", intentId: "i", agentId: "a", status: "returned", reason: "stale: x" }]);
    expect(await waiting).toEqual({ status: "returned", reason: "stale: x" });
    // A status seen before anyone waited counts at once.
    expect(await feed.waitFor("prp_2", 5_000)).toEqual({ status: "landed" });
  });

  it("gives up after the timeout so the agent can ask the colony", async () => {
    const feed = new LiveFeed();
    expect(await feed.waitFor("prp_x", 10)).toBeNull();
  });
});

describe("errorBackoffMs", () => {
  it("doubles from one second with jitter and caps at a minute", () => {
    expect(errorBackoffMs(1, () => 0.5)).toBe(1_000);
    expect(errorBackoffMs(3, () => 0.5)).toBe(4_000);
    expect(errorBackoffMs(30, () => 0.5)).toBe(60_000);
    expect(errorBackoffMs(1, () => 0)).toBe(750);
    expect(errorBackoffMs(1, () => 0.999)).toBe(1_250);
  });
});

describe("errorDetail", () => {
  it("names the network cause fetch hides behind \"fetch failed\"", () => {
    const reset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    expect(errorDetail(new TypeError("fetch failed", { cause: reset }))).toBe("TypeError: fetch failed (ECONNRESET)");
    expect(errorDetail(new TypeError("fetch failed", { cause: new Error("other side closed") }))).toBe("TypeError: fetch failed (other side closed)");
    expect(errorDetail(new Error("plain"))).toBe("Error: plain");
    expect(errorDetail("text")).toBe("text");
  });
});
