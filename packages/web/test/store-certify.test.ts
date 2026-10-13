import { describe, expect, it } from "vitest";
import type { ColonySnapshot } from "@fire_trident/core";
import { certCounts, certTitle } from "../src/certs.ts";
import { startingPoint } from "../src/replay.ts";
import { ColonyStore } from "../src/store.ts";

/** Trunk certification in the UI store: the snapshot's latest result, live certify events, greenSha. */
const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const counts = (pass: number, fail: number) => ({ tests: pass + fail, pass, fail, cancelled: 0, skipped: 0, todo: 0, suites: 1 });

function snapshot(extra: Record<string, unknown> = {}): ColonySnapshot {
  return {
    colony: { id: "web", name: "web", trunk: { namespace: "n", name: "t", remote: "r" }, trunkSha: A, createdAt: 0, regionDepth: 1, ...extra },
    files: [],
    intents: [],
    rules: [],
    agents: [],
    recentLandings: [],
    violations: { total: 0, byRule: {} },
    funnel: { reflex: 0, llm: 0, human: 0 },
    metrics: {},
  } as unknown as ColonySnapshot;
}

describe("trunk certification in the UI store", () => {
  it("loads the latest result from the snapshot and shows it on the head", () => {
    const s = new ColonyStore("web");
    s.applySnapshot(snapshot({ greenSha: A, certification: { trunkSha: A, status: "green", startedAt: 1, finishedAt: 2, counts: counts(60, 0) } }));
    expect(s.greenSha).toBe(A);
    expect(s.headCert()).toMatchObject({ onHead: true, cert: { trunkSha: A, status: "green", at: 2 } });
    expect(certCounts(s.headCert()!.cert)).toBe("60/60 tests");
  });

  it("follows certify events: running, red keeps the last green, green moves it", () => {
    const s = new ColonyStore("web");
    s.applySnapshot(snapshot({ greenSha: A }));
    expect(s.headCert()).toBeNull();
    s.applyEvents([{ t: "landing", at: 3, landingId: "l1", trunkSha: B, proposalIds: [], paths: [] }]);
    s.applyEvents([{ t: "certify", at: 4, trunkSha: B, status: "running" }]);
    expect(s.headCert()).toMatchObject({ onHead: true, cert: { status: "running" } });
    s.applyEvents([
      { t: "certify", at: 5, trunkSha: B, status: "red", counts: counts(62, 5), failing: [{ name: "A6", file: "test/acceptance.test.ts", error: "AssertionError: 405 vs 401" }], greenSha: A },
    ]);
    expect(s.greenSha).toBe(A);
    const red = s.headCert()!;
    expect(red).toMatchObject({ onHead: true, cert: { status: "red" } });
    expect(certCounts(red.cert)).toBe("5 failing");
    expect(certTitle(red.cert)).toContain("• A6: AssertionError: 405 vs 401");
    // A newer head waits for its run: the last result stays visible, marked as not the head's.
    s.applyEvents([{ t: "landing", at: 6, landingId: "l2", trunkSha: C, proposalIds: [], paths: [] }]);
    expect(s.headCert()).toMatchObject({ onHead: false, cert: { trunkSha: B } });
    s.applyEvents([{ t: "certify", at: 7, trunkSha: C, status: "green", counts: counts(67, 0), greenSha: C }]);
    expect(s.greenSha).toBe(C);
    expect(s.headCert()).toMatchObject({ onHead: true, cert: { trunkSha: C, status: "green" } });
    expect(s.typeCounts.get("certify")).toBe(3);
  });

  it("starts a replay without the finished run's green commit or result", () => {
    const snap = snapshot({ greenSha: A, certification: { trunkSha: A, status: "green", startedAt: 1 } });
    const { snapshot: start } = startingPoint(snap, { first: 0, last: 1, events: [] } as unknown as Parameters<typeof startingPoint>[1]);
    expect(start.colony.greenSha).toBeUndefined();
    expect(start.colony.certification).toBeUndefined();
  });
});
