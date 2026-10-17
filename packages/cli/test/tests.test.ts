import { describe, expect, it } from "vitest";
import type { Landing, LandingTests, LineageNote } from "@fire_trident/core";
import { colors, formatWhy } from "../src/format.ts";
import { firstLandings, readRows, testsRequest, testsRowOf, testsRows } from "../src/tests.ts";

/** `ft why` prints each of the newest landings' test row: base against certified, lost, proof, spend, and the lines under it. */

const plain = colors(false);
const proof = { rungs: [{ rung: "deterministic" as const, count: 1 }], text: "deterministic" };
const row = (t: Partial<LandingTests>): LandingTests => testsRowOf({ colonyId: "web", landingId: "lnd_1", trunkSha: "b".repeat(40), baseSha: "a".repeat(40), status: "certified", proof, ...t })!;
const landing = (id: string, at: number): Landing => ({ id, colonyId: "web", trunkSha: "b".repeat(40), parentSha: "a".repeat(40), proposalIds: [], intentIds: [], paths: ["src/a.ts"], regions: ["src"], at });
const note = (id: string): LineageNote => ({ schema: "firetrident.lineage/v1", landingId: id, colonyId: "web", proposals: [] });

describe("ft why: the test row", () => {
  it("asks for the newest landings it prints, in its order", () => {
    const entries = [{ landing: landing("old", 1) }, { landing: landing("new", 9) }, { landing: landing("mid", 5) }];
    expect(firstLandings(entries, undefined, 2)).toEqual(["new", "mid"]);
    expect(firstLandings(entries, 3, 2)).toEqual(["old", "new"]);
    expect(testsRequest("web", "lnd_1")).toEqual({ method: "GET", path: "/api/colonies/web/landings/lnd_1/tests" });
  });

  it("keeps the rows that came back and leaves out the rest", async () => {
    const rows = await readRows(["a", "b", "c"], async (id) => (id === "a" ? row({ landingId: "a", certified: { sha: "b".repeat(40), status: "green", pass: 2, tests: 2, failing: 0 } }) : id === "b" ? { error: "no landing" } : Promise.reject(new Error("down"))));
    expect(Object.keys(rows)).toEqual(["a"]);
    expect(rows.a!.text).toBe("no result at or before base, 2/2 certified · proof: deterministic");
  });

  it("prints the row under each landing, the warning in yellow", () => {
    const t = row({
      base: { sha: "a".repeat(40), status: "green", pass: 60, tests: 60, failing: 0, exact: true },
      certified: { sha: "b".repeat(40), status: "green", pass: 61, tests: 61, failing: 0 },
      lost: 0,
      added: 1,
      authors: { inherited: { files: 5, tests: 60 }, agents: { files: 1, tests: 1, by: ["@cf/google/gemma-4-26b-a4b-it"] }, person: { files: 0, tests: 0 } },
      reach: { earlier: 0, own: 1, later: 0, earlierFiles: [], ownFiles: ["test/new.test.ts"], checked: 6 },
      spend: { usd: 0.0003, calls: 1, intents: 1 },
    });
    const text = formatWhy({ path: "src/a.ts" }, [{ landing: landing("lnd_1", 5), note: note("lnd_1") }], { tests: { lnd_1: t } }, plain, 10);
    expect(text).toContain("  delta    60/60 at base, 61/61 certified, 0 lost, 1 new · proof: deterministic · $0.0003 (model calls this platform made)\n");
    expect(text).toContain("           60 inherited from the repository (5 files) · 1 written or edited by agents (1 file: gemma-4-26b-a4b-it).\n");
    expect(text).toContain("           No earlier test reaches this change: only 1 test file it wrote reaches its files.");
    const lines = testsRows(t, colors(true));
    expect(lines.find((l) => l.v.includes("No earlier test"))?.v).toBe("\u001b[33mNo earlier test reaches this change: only 1 test file it wrote reaches its files.\u001b[39m");
  });

  it("says not certified yet, and that a colony has no test this platform can run", () => {
    const pending = formatWhy({ path: "src/a.ts" }, [{ landing: landing("lnd_1", 5), note: note("lnd_1") }], { tests: { lnd_1: row({ status: "pending", reason: "trunk certification is off for this colony" }) } }, plain, 10);
    expect(pending).toContain("  delta    not certified yet: trunk certification is off for this colony · proof: deterministic");
    const none = formatWhy({ path: "src/a.ts" }, [{ landing: landing("lnd_1", 5), note: note("lnd_1") }], { tests: { lnd_1: row({ status: "no-tests", reason: "no test file imports node:test (223 test files)" }) } }, plain, 10);
    expect(none).toContain("  delta    no tests this platform can run · proof: deterministic");
    // Without a row, as before.
    expect(formatWhy({ path: "src/a.ts" }, [{ landing: landing("lnd_1", 5), note: note("lnd_1") }], {}, plain, 10)).not.toContain("delta");
  });
});

describe("ft why: test names are the repository's text", () => {
  it("prints them on one line, with no control characters", () => {
    const t = row({ lost: 1, lostTests: [{ file: "test/a.test.ts", name: "adds\u001b[2J\nnow" }], base: { sha: "a".repeat(40), status: "green", pass: 1, tests: 1, failing: 0, exact: true }, certified: { sha: "b".repeat(40), status: "green", pass: 0, tests: 0, failing: 0 } });
    const lost = testsRows(t, plain).find((r) => r.v.includes("adds"))!.v;
    expect(lost).toBe("Passed at base, not at the certified commit: adds [2J now (test/a.test.ts).");
  });
});
