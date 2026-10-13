import { describe, expect, it } from "vitest";
import { CertifySchedule } from "../../src/certify/schedule.ts";

const sha = (c: string) => c.repeat(40);

describe("certification scheduler", () => {
  it("starts a run for a landing and keeps one in flight", () => {
    const s = new CertifySchedule(0);
    expect(s.next(0)).toEqual({ kind: "idle" });
    expect(s.request(sha("a"), 1)).toBe(true);
    expect(s.next(1)).toEqual({ kind: "start" });
    s.start(1);
    s.certifying(sha("a"));
    expect(s.busy()).toBe(true);
    // Landings while it runs mark trunk as moved; nothing else starts.
    expect(s.request(sha("b"), 2)).toBe(true);
    expect(s.request(sha("c"), 3)).toBe(true);
    expect(s.next(4)).toEqual({ kind: "busy" });
    s.finish(sha("a"));
    // One more run for all of them: it certifies trunk as it is then (the newest).
    expect(s.next(5)).toEqual({ kind: "start" });
    s.start(5);
    s.certifying(sha("c"));
    s.finish(sha("c"));
    expect(s.next(6)).toEqual({ kind: "idle" });
  });

  it("ignores reports of older landings and of the commit already certified", () => {
    const s = new CertifySchedule(0);
    s.request(sha("b"), 10);
    s.start(10);
    s.certifying(sha("b"));
    s.finish(sha("b"));
    expect(s.request(sha("a"), 5)).toBe(false); // an older landing reported late
    expect(s.request(sha("b"), 10)).toBe(false); // the commit just certified (a second report)
    expect(s.next(11)).toEqual({ kind: "idle" });
    expect(s.request(sha("c"), 11)).toBe(true);
    expect(s.pending()).toBe(true);
  });

  it("does not ask again for the commit a run in flight is certifying", () => {
    const s = new CertifySchedule(0);
    s.request(sha("a"), 1);
    s.start(1);
    s.certifying(sha("b")); // trunk had already moved to b when the run read it
    expect(s.request(sha("b"), 2)).toBe(false);
    s.finish(sha("b"));
    expect(s.next(3)).toEqual({ kind: "idle" });
  });

  it("spaces runs at least minIntervalMs apart, so a burst of landings shares one run", () => {
    const s = new CertifySchedule(2_000);
    s.request(sha("a"), 0);
    expect(s.next(0)).toEqual({ kind: "start" });
    s.start(0);
    s.finish(sha("a"));
    s.request(sha("b"), 100);
    expect(s.next(500)).toEqual({ kind: "wait", ms: 1_500 });
    s.request(sha("c"), 600);
    s.minIntervalMs = 1_000; // the policy changed meanwhile
    expect(s.next(800)).toEqual({ kind: "wait", ms: 200 });
    expect(s.next(1_000)).toEqual({ kind: "start" });
  });

  it("runs again on request even for a certified commit, and forgets everything on reset", () => {
    const s = new CertifySchedule(0);
    s.request(sha("a"), 1);
    s.start(1);
    s.finish(sha("a"));
    expect(s.request(sha("a"), 1)).toBe(false);
    s.force();
    expect(s.next(2)).toEqual({ kind: "start" });
    s.reset();
    expect(s.next(3)).toEqual({ kind: "idle" });
    expect(s.request(sha("a"), 0)).toBe(true);
  });
});
