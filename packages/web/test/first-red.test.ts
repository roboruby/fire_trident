import { describe, expect, it } from "vitest";
import type { ColonySnapshot, FirstRed } from "@fire_trident/core";
import { certFirstRed, certTitle } from "../src/certs.ts";
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
