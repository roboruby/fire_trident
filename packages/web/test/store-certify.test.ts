import { describe, expect, it } from "vitest";
import type { ColonySnapshot } from "@fire_trident/core";
import { certCounts, certSuspects, certTitle } from "../src/certs.ts";
import { startingPoint } from "../src/replay.ts";
import { ColonyStore, type CertView } from "../src/store.ts";

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

  it("names skipped and todo tests whenever there are any", () => {
    const green = { trunkSha: A, status: "green" as const, at: 1, counts: { ...counts(58, 0), tests: 60, skipped: 2 } };
    expect(certCounts(green)).toBe("58/60 tests · 2 skipped");
    expect(certCounts(green, "pass")).toBe("58/60 tests pass · 2 skipped");
    expect(certCounts({ counts: { ...counts(57, 0), tests: 60, skipped: 2, todo: 1 } })).toBe("57/60 tests · 2 skipped · 1 todo");
    expect(certCounts({ counts: { ...counts(62, 5), tests: 68, todo: 1 } })).toBe("5 failing · 1 todo");
    expect(certCounts({ counts: counts(60, 0) }, "pass")).toBe("60/60 tests pass");
    expect(certTitle(green)).toBe("aaaaaaa: 58 of 60 tests pass, 2 skipped (node:test in a Dynamic Worker)");
    expect(certTitle({ ...green, counts: counts(60, 0) })).toBe("aaaaaaa: all 60 tests pass (node:test in a Dynamic Worker)");
    expect(certTitle({ ...green, status: "red", counts: { ...counts(62, 5), tests: 69, skipped: 2 }, failing: [] })).toMatch(/^aaaaaaa: 5 of 69 tests failing \(2 skipped\)\n/);
  });

  it("keeps a red result's suspects from the snapshot and from live events, and words each with its undo command", () => {
    const failing = [{ name: "subtracts", file: "test/math.test.ts" }];
    const suspect = { landingId: "lnd_2", trunkSha: C, proposalId: "prp_2", intentId: "int_2", title: "Speed up subtraction", paths: ["src/math.ts"], files: ["test/math.test.ts"], at: 2 };
    const s = new ColonyStore("web");
    s.applySnapshot(snapshot({ greenSha: B, certification: { trunkSha: A, status: "red", startedAt: 1, finishedAt: 2, counts: counts(1, 1), failing, suspects: [suspect] } }));
    const red = s.headCert()!.cert;
    expect(red.suspects).toEqual([suspect]);
    // The card: the proposal, its intent's title, what it changed, and `ft revert <colony> <prp>`.
    expect(certSuspects(red, s.colonyId)).toEqual([{ key: "lnd_2:prp_2", ref: "prp_2", title: "Speed up subtraction", paths: "src/math.ts", files: "test/math.test.ts", commit: "ccccccc", undo: "ft revert web prp_2" }]);
    expect(certTitle(red)).toContain("\nSuspects, newest first:\n• prp_2 “Speed up subtraction” changed src/math.ts");

    // A live result: a suspect with no single proposal is undone by its landing.
    s.applyEvents([{ t: "landing", at: 3, landingId: "l3", trunkSha: B, proposalIds: [], paths: [] }]);
    s.applyEvents([
      { t: "certify", at: 4, trunkSha: B, status: "red", counts: counts(1, 1), failing, greenSha: C, suspects: [{ landingId: "lnd_3", paths: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"], files: ["test/a.test.ts"], at: 3 }] },
    ]);
    expect(certSuspects(s.headCert()!.cert, s.colonyId)).toEqual([{ key: "lnd_3:lnd_3", ref: "lnd_3", title: "", paths: "src/a.ts, src/b.ts, src/c.ts +1", files: "test/a.test.ts", commit: "", undo: "ft revert web lnd_3" }]);
    // Green results and results without suspects show none; malformed entries are left out.
    s.applyEvents([{ t: "certify", at: 5, trunkSha: B, status: "red", counts: counts(1, 1), failing }]);
    expect(s.headCert()!.cert.suspects).toBeUndefined();
    expect(certTitle(s.headCert()!.cert)).not.toContain("Suspects");
    expect(certSuspects({ suspects: [null, { landingId: 5 }, { landingId: "lnd_4", paths: "src/x.ts" }] as unknown as CertView["suspects"] }, "web")).toEqual([
      { key: "lnd_4:lnd_4", ref: "lnd_4", title: "", paths: "", files: "", commit: "", undo: "ft revert web lnd_4" },
    ]);
  });

  it("starts a replay without the finished run's green commit or result", () => {
    const snap = snapshot({ greenSha: A, certification: { trunkSha: A, status: "green", startedAt: 1 } });
    const { snapshot: start } = startingPoint(snap, { first: 0, last: 1, events: [] } as unknown as Parameters<typeof startingPoint>[1]);
    expect(start.colony.greenSha).toBeUndefined();
    expect(start.colony.certification).toBeUndefined();
  });
});

describe("culprit finding's labels on the certification card", () => {
  const suspect = (n: number, labels?: Array<"first-since-green" | "latest" | "first-red">) => ({
    landingId: `lnd_${n}`,
    proposalId: `prp_${n}`,
    paths: [`src/${n}.ts`],
    files: ["test/a.test.ts"],
    at: n,
    ...(labels ? { labels } : {}),
  });

  it("says why each suspect is listed and keeps the first since green, and the first red, before newer ones", () => {
    const red: CertView = { trunkSha: B, status: "red", at: 1, suspects: [suspect(5, ["latest"]), suspect(4, ["latest"]), suspect(3), suspect(1, ["first-since-green"])] };
    expect(certSuspects(red, "web").map((s) => [s.ref, s.label])).toEqual([
      ["prp_5", "latest"],
      ["prp_4", "latest"],
      ["prp_1", "first since green"],
    ]);
    expect(certTitle(red)).toContain("• prp_1 changed src/1.ts (first since green)");
    // The first red search ended later (a bisect event): its landing's suspect is marked and kept first.
    const searched: CertView = { ...red, firstRed: { status: "found", trunkSha: C, landingId: "lnd_3", probes: 2, ms: 5 } };
    expect(certSuspects(searched, "web", 2).map((s) => [s.ref, s.label])).toEqual([
      ["prp_3", "first red"],
      ["prp_1", "first since green"],
    ]);
    // A suspect recorded before labels existed shows as before: no label.
    expect(certSuspects({ suspects: [suspect(3)] }, "web")).toEqual([{ key: "lnd_3:prp_3", ref: "prp_3", title: "", paths: "src/3.ts", files: "test/a.test.ts", commit: "", undo: "ft revert web prp_3" }]);
  });
});
