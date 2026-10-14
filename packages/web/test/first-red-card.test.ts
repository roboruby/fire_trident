import { describe, expect, it } from "vitest";
import { FIRSTRED_ORIGIN, firstRedCard, loadFirstRedCard, type GetJson } from "../src/landing/showcase.ts";

/** The first red card of the results strip: what it says from a colony's certification results, read without a token. */

const T0 = 1_760_400_000_000;
const GREEN = `2ab1b21${"0".repeat(33)}`;
const BROKE = "01763b56dfa595bb9bf9f98aad741e8f77dd779c";
const RED = `f3a226a${"1".repeat(33)}`;
const FIXED = `9c0ffee${"2".repeat(33)}`;
const counts = (pass: number, fail: number) => ({ tests: pass + fail, pass, fail, cancelled: 0, skipped: 0, todo: 0, suites: 0 });

/** What the search found on the demo's red head: the fourth of six landings since green broke `subtracts`. */
const FOUND = {
  status: "found",
  trunkSha: BROKE,
  landingId: "lnd_4",
  intents: [{ id: "int_4", title: "Speed up subtraction" }],
  proposals: [{ id: "prp_4", intentId: "int_4", title: "Speed up subtraction", paths: ["src/math.js"] }],
  files: ["test/math.test.js"],
  probes: 3,
  ms: 267,
  landings: 6,
  greenSha: GREEN,
};
const INCONCLUSIVE = { status: "inconclusive", reason: "The failing tests passed when run alone on the red commit f3a226a: they may be flaky or depend on other test files.", probes: 1, ms: 80 };

const baseline = { trunkSha: GREEN, status: "green", counts: counts(1, 0), startedAt: T0, finishedAt: T0 + 300, durationMs: 300, greenSha: GREEN };
function red(firstRed?: object, failing = [{ name: "subtracts", file: "test/math.test.js", error: "8 !== 2" }]) {
  return { trunkSha: RED, status: "red", counts: counts(0, failing.length), failing, startedAt: T0 + 60_000, finishedAt: T0 + 60_400, durationMs: 400, repairIntentId: "int_fix", greenSha: GREEN, ...(firstRed ? { firstRed } : {}) };
}
const fixed = { trunkSha: FIXED, status: "green", counts: counts(1, 0), startedAt: T0 + 74_000, finishedAt: T0 + 74_300, durationMs: 300, greenSha: FIXED };
/** GET /certifications: the state, then the results, newest first. */
const certs = (...results: object[]) => ({ colonyId: "first-red", on: true, deployment: true, runner: true, running: false, pending: false, results });
const snapshot = (repair: string) => ({ colony: { id: "first-red" }, intents: [{ id: "int_4", status: "landed" }, { id: "int_fix", source: "certify", status: repair, title: "Make the failing tests pass: subtracts" }] });

describe("first red card", () => {
  it("names the landing that broke the test and how the search found it, while the repair is open", () => {
    expect(firstRedCard(certs(red(FOUND), baseline), snapshot("open"))).toEqual({
      headline: "Found the breaking landing in 3 test runs",
      lede: "of the six landings since green, the one for “Speed up subtraction” broke the test “subtracts”",
      details: ["commit 01763b5 changed src/math.js", "found in 267 ms by running the failing test on earlier commits, not by a model", "the colony declared a repair intent; trunk is not green again yet"],
      origin: FIRSTRED_ORIGIN,
    });
  });

  it("says the repair landed and how long until trunk was certified green again", () => {
    const card = firstRedCard(certs(fixed, red(FOUND), baseline), snapshot("landed"));
    expect(card?.headline).toBe("Found the breaking landing in 3 test runs");
    expect(card?.details[2]).toBe("its repair intent landed; trunk was certified green again 14 s after the red result");
    // Green without the snapshot (or with the repair not landed) says only what the results show.
    expect(firstRedCard(certs(fixed, red(FOUND), baseline), null)?.details[2]).toBe("trunk was certified green again 14 s after the red result");
    // The first green result after the red one counts, not a later one.
    const later = { ...fixed, trunkSha: `abcdef0${"3".repeat(33)}`, startedAt: T0 + 600_000, finishedAt: T0 + 600_300 };
    expect(firstRedCard(certs(later, fixed, red(FOUND), baseline), snapshot("landed"))?.details[2]).toBe("its repair intent landed; trunk was certified green again 14 s after the red result");
  });

  it("shows nothing when the search was inconclusive", () => {
    expect(firstRedCard(certs(red(INCONCLUSIVE), baseline), snapshot("open"))).toBeNull();
    expect(firstRedCard(certs(fixed, red(INCONCLUSIVE), baseline), snapshot("landed"))).toBeNull();
  });

  it("shows nothing without a search: no red result, a red one without an answer, or no results at all", () => {
    expect(firstRedCard(certs(baseline), null)).toBeNull();
    expect(firstRedCard(certs(red(), baseline), snapshot("open"))).toBeNull();
    expect(firstRedCard(certs(), null)).toBeNull();
    expect(firstRedCard(null, null)).toBeNull();
    expect(firstRedCard({ results: "odd" }, null)).toBeNull();
    // An answer it cannot read (no test runs, no commit) is not shown either.
    expect(firstRedCard(certs(red({ ...FOUND, probes: undefined })), null)).toBeNull();
    expect(firstRedCard(certs(red({ ...FOUND, trunkSha: 7 })), null)).toBeNull();
  });

  it("words one run, one landing, several failing tests and an untitled landing", () => {
    const one = firstRedCard(certs(red({ ...FOUND, probes: 1, landings: 1 })), null);
    expect(one?.headline).toBe("Found the breaking landing in 1 test run");
    expect(one?.lede).toBe("the landing for “Speed up subtraction” broke the test “subtracts”");
    const failing = ["subtracts", "adds", "divides"].map((name) => ({ name: `math > ${name}`, file: "test/math.test.js", error: "" }));
    const untitled = firstRedCard(certs(red({ ...FOUND, intents: [{ id: "int_4" }], proposals: [] }, failing)), null);
    expect(untitled?.lede).toBe("of the six landings since green, the one at commit 01763b5 broke “subtracts” and two more tests");
    expect(untitled?.details.slice(0, 2)).toEqual(["commit 01763b5, landing lnd_4", "found in 267 ms by running the failing tests on earlier commits, not by a model"]);
  });

  it("reads the certification results and the snapshot, and shows nothing for a colony that does not exist", async () => {
    const asked: string[] = [];
    const answers: Record<string, unknown> = {
      "/api/colonies/first-red/certifications?limit=50": certs(fixed, red(FOUND), baseline),
      "/api/colonies/first-red": snapshot("landed"),
    };
    const get: GetJson = async (url) => {
      asked.push(url);
      if (!(url in answers)) throw new Error(`404 ${url}`);
      return answers[url];
    };
    const card = await loadFirstRedCard("first-red", get);
    expect(card?.lede).toBe("of the six landings since green, the one for “Speed up subtraction” broke the test “subtracts”");
    expect(card?.details[2]).toBe("its repair intent landed; trunk was certified green again 14 s after the red result");
    expect(asked.sort()).toEqual(["/api/colonies/first-red", "/api/colonies/first-red/certifications?limit=50"]);
    expect(await loadFirstRedCard("nowhere", get)).toBeNull();
  });
});
