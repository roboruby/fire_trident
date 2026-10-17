import { describe, expect, it } from "vitest";
import type { Proposal, ReviewTestsRun } from "@fire_trident/core";
import { helpText, parseCommand } from "../src/args.ts";
import { planRequest } from "../src/api.ts";
import { colors, formatReview } from "../src/format.ts";
import { reviewTestsLines, reviewTestsOf } from "../src/reviewtests.ts";
import { main } from "../src/run.ts";
import type { Io } from "../src/run.ts";

/** `ft review`: each escalated change leads with its tests before approval, and `--retest` runs them again. */

const plain = colors(false);
const NOW = 10_000_000;

const RAN: ReviewTestsRun = {
  id: "rtr_1",
  status: "ran",
  by: "escalation",
  at: NOW - 5_000,
  baseSha: "1a2b3c4d5e6f",
  tests: 434,
  passed: 433,
  failed: 1,
  failing: [{ file: "test/math.test.ts", name: "subtracts", error: "AssertionError (strictEqual): actual 8, expected 2", onTrunk: "passes" }],
  onTrunk: { passes: 1 },
  trunk: { sha: "1a2b3c4d5e6f", status: "green", tests: 434, passed: 434, failing: 0 },
  text: 'Tests on this change: 433/434 passed, 1 failed ("subtracts"). 1 failing here that passes on trunk.',
};

function proposal(over: Record<string, unknown> = {}): Proposal {
  return {
    id: "prp_1",
    colonyId: "web",
    intentId: "int_1",
    agentId: "agt_1",
    workspace: { namespace: "n", name: "w", remote: "r" },
    baseSha: "a",
    headSha: "b",
    writeSet: [{ path: "src/math.ts", blob: "c" }],
    readSet: [],
    declared: { footprint: ["src/math.ts"], summary: "Speed up subtraction" },
    evidence: { checks: [] },
    status: "escalated",
    createdAt: NOW - 60_000,
    reason: "escalated by deterministic: P3 protected path",
    ...over,
  } as Proposal;
}

describe("tests before approval in ft review", () => {
  it("leads each change with its tests: the sentence, each failing test against trunk, the base's certification, how to run again", () => {
    const out = formatReview([proposal({ reviewTests: RAN })], undefined, plain, NOW, { colony: "web" }).split("\n");
    const at = out.findIndex((l) => l.includes("tests    Tests on this change"));
    // Right under the change's title and summary, before the reason and the checks.
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(out.findIndex((l) => l.includes("reason  ")));
    expect(out.slice(at, at + 5)).toEqual([
      '  tests    Tests on this change: 433/434 passed, 1 failed ("subtracts"). 1 failing here that passes on trunk.',
      '           ✗ "subtracts"  test/math.test.ts  passes on trunk',
      "             AssertionError (strictEqual): actual 8, expected 2",
      "           on trunk at 1a2b3c4 (certified green): 434/434 passed",
      "           run them again: ft review web --retest prp_1",
    ]);
  });

  it("says why they did not run, reads what the server sent defensively, and shows nothing for an older server", () => {
    const notrun = reviewTestsLines(proposal({ reviewTests: { id: "", status: "notrun", by: "escalation", at: 0, reason: "no test file imports node:test (2 test files)" } }), plain, "web");
    expect(notrun[0]).toBe("  tests    Tests on this change: not run: no test file imports node:test (2 test files).");
    // From the evidence when the queue sent no view, a sentence built from the counts when it sent none.
    expect(reviewTestsLines(proposal({ evidence: { checks: [], reviewTests: { ...RAN, text: undefined } } }), plain, "web")[0]).toBe("  tests    Tests on this change: 433/434 passed, 1 failed.");
    expect(reviewTestsOf(proposal({ reviewTests: { status: "maybe" } }))).toBeNull();
    expect(reviewTestsOf(proposal({ reviewTests: { ...RAN, failing: [{ name: "x\u001b[31m", file: 3, onTrunk: "sideways" }] } }))?.failing).toEqual([{ name: "x\u001b[31m", file: "", onTrunk: "unknown" }]);
    expect(reviewTestsLines(proposal({ reviewTests: { ...RAN, failing: [{ name: "x\u001b[31m", file: "t.ts", onTrunk: "new" }] } }), plain, "web")[1]).toBe('           ✗ "x\\u{1b}[31m"  t.ts  new with this change');
    expect(reviewTestsLines(proposal(), plain, "web")).toEqual([]);
    expect(formatReview([proposal()], undefined, plain, NOW, { colony: "web" })).not.toContain("Tests on this change");
  });

  it("parses --retest, asks the server to run them again, and says where the result shows", async () => {
    const r = parseCommand(["review", "web", "--retest", "prp_1", "--by", "matt"]);
    expect(r.ok && r.command).toEqual({ name: "review-retest", colony: "web", proposalId: "prp_1", by: "matt" });
    expect(planRequest({ name: "review-retest", colony: "web", proposalId: "prp_1" }, "matt")).toEqual({ method: "POST", path: "/api/colonies/web/proposals/prp_1/tests", body: { by: "matt" } });
    const bad = parseCommand(["review", "web", "prp_1", "--retest", "prp_1"]);
    expect(bad.ok).toBe(false);
    const diff = parseCommand(["review", "web", "--retest", "prp_1", "--diff"]);
    expect(!diff.ok && diff.error).toMatch(/--diff does not apply to running a change's tests again/);
    expect(helpText("review")).toContain("ft review <colony> --retest <proposalId> [--by <name>]");

    const out: string[] = [];
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    const fake: Io = {
      env: { FT_URL: "https://ft.test", FT_TOKEN: "t", FT_USER: "matt" },
      stdout: (line) => out.push(line),
      stderr: (line) => out.push(line),
      isTTY: false,
      fetch: (async (url: string, init?: RequestInit) => {
        calls.push({ method: init?.method ?? "GET", url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
        return new Response(JSON.stringify({ started: true, run: { id: "rtr_2", status: "queued", by: "matt", at: NOW } }), { status: 202, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
      readFile: async () => "",
      sleep: async () => undefined,
      now: () => NOW,
      WebSocket: globalThis.WebSocket,
      onInterrupt: () => undefined,
    };
    expect(await main(["review", "web", "--retest", "prp_1"], fake)).toBe(0);
    expect(calls).toEqual([{ method: "POST", url: "https://ft.test/api/colonies/web/proposals/prp_1/tests", body: { by: "matt" } }]);
    expect(out.join("\n")).toBe("Running the tests of prp_1 again on its base (waiting for a free test run).\n  ft review web shows the result when they end; it replaces the earlier one.");
  });
});
