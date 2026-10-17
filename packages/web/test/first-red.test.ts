import { describe, expect, it } from "vitest";
import type { ColonySnapshot, FirstRed, FirstRedIsolation } from "@fire_trident/core";
import { certFirstRed, certSuspects, certTitle } from "../src/certs.ts";
import { ColonyStore } from "../src/store.ts";

/** The first red search (FT_BISECT) in the UI: the answer from the snapshot or a live `bisect` event, and its words on the certification card. */
const A = "a".repeat(40);
const B = "b".repeat(40);
const counts = (pass: number, fail: number) => ({ tests: pass + fail, pass, fail, cancelled: 0, skipped: 0, todo: 0, suites: 1 });
const failing = [{ name: "subtracts", file: "test/math.test.ts", error: "8 !== 2" }];

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

const found: FirstRed = {
  status: "found",
  trunkSha: "1a2b3c4".padEnd(40, "0"),
  landingId: "lnd_4",
  intents: [{ id: "int_4", title: "Speed up subtraction" }],
  proposals: [{ id: "prp_4", intentId: "int_4", title: "Speed up subtraction", paths: ["src/math.ts"] }],
  files: ["test/math.test.ts"],
  probes: 3,
  ms: 420,
  landings: 6,
  greenSha: B,
};

describe("the first failing commit in the UI", () => {
  it("words a found commit with its landing, intent and the change that is the likely cause, with the undo command", () => {
    expect(certFirstRed({ firstRed: found }, "web")).toEqual({
      text: "The failing tests first failed at commit 1a2b3c4 (landing lnd_4, intent “Speed up subtraction”), found in 3 test runs; its change to src/math.ts is the likely cause.",
      undo: ["ft revert web prp_4"],
    });
    const two = { ...found, intents: [{ id: "int_4", title: "A" }, { id: "int_5" }], proposals: [], probes: 1 };
    expect(certFirstRed({ firstRed: two }, "web")?.text).toBe("The failing tests first failed at commit 1a2b3c4 (landing lnd_4, intents “A” and int_5), found in 1 test run; none of its proposals changed a file the failing tests load.");
    expect(certFirstRed({ firstRed: { ...found, intents: [], proposals: [] } }, "web")?.text).toContain("(landing lnd_4, a commit FireTrident made itself)");
    expect(certFirstRed({ firstRed: { status: "inconclusive", reason: "The failing tests passed when run alone on the red commit aaaaaaa: they may be flaky or depend on other test files.", probes: 1, ms: 80 } }, "web")).toEqual({
      text: "The search for the first failing commit was inconclusive. The failing tests passed when run alone on the red commit aaaaaaa: they may be flaky or depend on other test files.",
      undo: [],
    });
    expect(certFirstRed({}, "web")).toBeNull();
    expect(certFirstRed({ firstRed: { status: "odd" } as never }, "web")).toBeNull();
  });

  it("keeps the answer from the snapshot, and adds one from a live bisect event to the red result it names", () => {
    const s = new ColonyStore("web");
    s.applySnapshot(snapshot({ greenSha: B, certification: { trunkSha: A, status: "red", startedAt: 1, finishedAt: 2, counts: counts(1, 1), failing, firstRed: found } }));
    const red = s.headCert()!.cert;
    expect(red.firstRed).toEqual(found);
    expect(certTitle(red)).toContain("\nThe failing tests first failed at commit 1a2b3c4 (landing lnd_4, intent “Speed up subtraction”), found in 3 test runs;");

    const live = new ColonyStore("web");
    live.applySnapshot(snapshot({ greenSha: B }));
    live.applyEvents([{ t: "certify", at: 3, trunkSha: A, status: "red", counts: counts(1, 1), failing, greenSha: B }]);
    expect(live.headCert()!.cert.firstRed).toBeUndefined();
    // An answer for a commit this page never saw, or one it cannot read, changes nothing.
    live.applyEvents([{ t: "bisect", at: 4, trunkSha: B, firstRed: found }]);
    live.applyEvents([{ t: "bisect", at: 4, trunkSha: A, firstRed: { status: "found" } as never }]);
    expect(live.headCert()!.cert.firstRed).toBeUndefined();
    live.applyEvents([{ t: "bisect", at: 5, trunkSha: A, firstRed: found }]);
    expect(live.headCert()!.cert.firstRed).toEqual(found);
    expect(live.typeCounts.get("bisect")).toBe(3);
  });
});

/** Proposal isolation inside the first red landing: the isolated proposal, and its undo shown as proven only when causal. */
const isolation = (causal: boolean): FirstRedIsolation => ({
  status: "isolated",
  reason: "Proposal prp_4 is the one inside the landing.",
  culprit: { id: "prp_4", intentId: "int_4", title: "Speed up subtraction", agentId: "agt_b", paths: ["src/math.ts"] },
  revert: causal
    ? { causal: true, reason: "causal: reverting it alone turns these tests green (on the red commit aaaaaaa).", trunkSha: A }
    : { causal: false, reason: "not shown causal: on the red commit aaaaaaa, 1 test of the failing files still fails with it reverted.", trunkSha: A },
  runs: [
    { kind: "half", proposals: ["prp_3"], outcome: "pass" },
    { kind: "half", proposals: ["prp_4"], outcome: "red" },
    { kind: "without", proposals: ["prp_4"], outcome: "green" },
    { kind: "revert", proposals: ["prp_4"], outcome: causal ? "green" : "red" },
  ],
  candidates: 2,
  probes: 4,
  ms: 300,
});

describe("the proposal isolated inside the first failing commit in the UI", () => {
  const two = { ...found, proposals: [found.proposals![0]!, { id: "prp_3", intentId: "int_3", title: "Tidy", paths: ["src/fmt.ts"] }] };
  it("names the proposal, its intent and agent, and shows its undo as proven only when reverting it alone turned the tests green", () => {
    expect(certFirstRed({ firstRed: { ...two, isolated: isolation(true) } }, "web")).toEqual({
      text: "The failing tests first failed at commit 1a2b3c4 (landing lnd_4, intent “Speed up subtraction”), found in 3 test runs; its change to src/fmt.ts, src/math.ts is the likely cause. Inside it, proposal prp_4 (intent “Speed up subtraction”, agent agt_b) is the one the failing tests pass without (4 more test runs); causal: reverting it alone turns these tests green (on the red commit aaaaaaa).",
      undo: ["ft revert web prp_4"],
      proven: true,
      proof: "proven: reverting it alone turns these tests green",
    });
    expect(certFirstRed({ firstRed: { ...two, isolated: isolation(false) } }, "web")).toMatchObject({
      undo: ["ft revert web prp_4"],
      proven: false,
      proof: "not proven: reverting it alone was not shown to turn these tests green",
    });
    expect(certFirstRed({ firstRed: { ...two, isolated: isolation(false) } }, "web")!.text).toContain("; not shown causal: on the red commit aaaaaaa, 1 test of the failing files still fails with it reverted.");
    // No single proposal: the reason, and the landing's undo commands, none proven.
    const none: FirstRedIsolation = { status: "interaction", reason: "Each half of the 2 proposals that changed what the failing tests load passed on its own (prp_4; prp_3): they break the tests only together, so no single proposal is the cause.", halves: [["prp_4"], ["prp_3"]], runs: [], candidates: 2, probes: 2, ms: 90 };
    const view = certFirstRed({ firstRed: { ...two, isolated: none } }, "web")!;
    expect(view.text).toMatch(/is the likely cause\. Inside it: Each half of the 2 proposals .* so no single proposal is the cause\.$/);
    expect(view).toMatchObject({ undo: ["ft revert web prp_4", "ft revert web prp_3"], proven: false, proof: "not proven: no single proposal was isolated" });
    // Before isolation ran (or on answers recorded before it existed): as before, with no proof shown.
    expect(certFirstRed({ firstRed: two }, "web")).not.toHaveProperty("proof");
  });

  it("marks the isolated proposal among the suspects, proven only when causal", () => {
    const suspects = [
      { landingId: "lnd_4", proposalId: "prp_3", title: "Tidy", paths: ["src/fmt.ts"], files: ["test/math.test.ts"], at: 4, labels: ["first-since-green" as const] },
      { landingId: "lnd_4", proposalId: "prp_4", title: "Speed up subtraction", paths: ["src/math.ts"], files: ["test/math.test.ts"], at: 4, labels: ["first-since-green" as const] },
    ];
    const proven = certSuspects({ suspects, firstRed: { ...two, isolated: isolation(true) } }, "web");
    expect(proven.map((s) => [s.ref, s.label, s.proven ?? false])).toEqual([
      ["prp_3", "first red · first since green", false],
      ["prp_4", "first red · isolated · first since green", true],
    ]);
    const unproven = certSuspects({ suspects, firstRed: { ...two, isolated: isolation(false) } }, "web");
    expect(unproven.map((s) => [s.ref, s.label, s.proven ?? false])).toEqual([
      ["prp_3", "first red · first since green", false],
      ["prp_4", "first red · isolated · first since green", false],
    ]);
  });
});
