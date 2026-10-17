import { describe, expect, it } from "vitest";
import type { Certification, Landing, LandingTests, LineageNote, WhyHolds, WhyWalk } from "@fire_trident/core";
import { whyAnswer } from "../../src/mcp/tools.ts";
import { latestCertification, withHoldsText } from "../../src/mcp/whyholds.ts";

/**
 * Both MCP `why` tools carry what the trunk writer found about today (trunk/whywalk.ts): each landing's holds, ended with
 * the current certification of the tests that cover it, and the walk for a line, the landing that wrote it in another
 * file cut to that file.
 */

const landing = (id: string, paths: string[]): Landing => ({ id, colonyId: "c", trunkSha: "b".repeat(40), parentSha: "c".repeat(40), proposalIds: [], intentIds: [], paths, regions: [], at: 1 });
const change = (id: string, path: string) => ({ id, agentId: "agt_1", agentKind: "internal", intent: { id: `int_${id}`, title: "t", why: "" }, writeSet: [{ path, blob: "d".repeat(40) }], readSet: [], decisions: [], evidence: { checks: [] } });
const note = (id: string, ...changes: Array<ReturnType<typeof change>>) => ({ schema: "firetrident.lineage/v1", landingId: id, colonyId: "c", proposals: changes }) as unknown as LineageNote;
const holds: WhyHolds = { wrote: { path: "src/a.ts", state: "same" }, others: { files: 0, changed: 0, list: [] } };
const green: Certification = { trunkSha: "e".repeat(40), status: "green", startedAt: 0, counts: { tests: 4, pass: 4, fail: 0, cancelled: 0, skipped: 0, todo: 0, suites: 1 } };

describe("why over MCP: does it still hold", () => {
  it("keeps the holds and the walk, and cuts the landing that wrote the line in another file to that file", () => {
    const walk: WhyWalk = { landingId: "lnd_old", path: "src/util.ts", line: 4, skipped: [], moved: [{ landingId: "lnd_move", from: "src/util.ts", to: "src/total.ts", line: 4 }] };
    const owner = { landing: landing("lnd_old", ["src/util.ts", "src/x.ts"]), note: note("lnd_old", change("p1", "src/util.ts"), change("p2", "src/x.ts")), holds, walk };
    const mover = { landing: landing("lnd_move", ["src/util.ts", "src/total.ts"]), note: note("lnd_move", change("p3", "src/total.ts")), holds };
    const [first, second] = whyAnswer("src/total.ts", 4, [owner, mover]).entries;
    expect(first!.walk).toEqual(walk);
    expect(first!.note.proposals.map((p) => p.id)).toEqual(["p1"]);
    expect(first!.otherProposals).toBe(1);
    expect(second!.holds).toEqual(holds);
    expect(second).not.toHaveProperty("walk");
    // An answer from a trunk writer before the walk carries neither.
    expect(whyAnswer("src/a.ts", undefined, [{ landing: landing("lnd_1", ["src/a.ts"]), note: note("lnd_1", change("p1", "src/a.ts")) }]).entries[0]).not.toHaveProperty("holds");
  });

  it("ends each holds line with the covering tests from the test row, else the latest certification", () => {
    const row = { status: "certified", reach: { earlier: 1, own: 0, later: 0, earlierFiles: ["test/a.test.ts"], ownFiles: [], checked: 3 } } as unknown as LandingTests;
    const entries = [
      { landing: landing("lnd_1", ["src/a.ts"]), note: note("lnd_1", change("p1", "src/a.ts")), holds, tests: row },
      { landing: landing("lnd_2", ["src/a.ts"]), note: note("lnd_2", change("p2", "src/a.ts")), holds, tests: { unavailable: "not ready" } },
      { landing: landing("lnd_3", ["src/a.ts"]), note: note("lnd_3", change("p3", "src/a.ts")) },
    ];
    const out = withHoldsText(entries, green);
    expect(out[0]!.holds?.text).toBe("src/a.ts as it wrote it · covered by 1 test file, green at eeeeeee");
    expect(out[1]!.holds?.text).toBe("src/a.ts as it wrote it · trunk tests green at eeeeeee (4/4)");
    expect(out[2]).toEqual(entries[2]);
    expect(withHoldsText(entries, null)[0]!.holds?.text).toBe("src/a.ts as it wrote it");
  });

  it("reads the latest certification once, and goes on without it when it is slow, fails or there is none", async () => {
    const asked: number[] = [];
    expect(await latestCertification(async (n) => (asked.push(n), [green]))).toEqual(green);
    expect(asked).toEqual([1]);
    expect(await latestCertification(() => new Promise(() => undefined), 10)).toBeNull();
    expect(await latestCertification(() => Promise.reject(new Error("restarting")))).toBeNull();
    expect(await latestCertification(async () => [])).toBeNull();
    expect(await latestCertification(undefined)).toBeNull();
  });
});
