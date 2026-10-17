import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Proposal, ReviewTestsRun } from "@fire_trident/core";
import { HttpBackend, saveToken, type Backend } from "../src/api.ts";
import { ReviewTests } from "../src/components/ReviewTests.tsx";
import { reviewTestsLead, reviewTestsOf, reviewTestsTone, testsPending } from "../src/reviewtests.ts";

/** Tests before approval on a review card: the colony's tests on the change at its base lead what a person reads. */

const RAN: ReviewTestsRun = {
  id: "rtr_1",
  status: "ran",
  by: "escalation",
  at: 1,
  baseSha: "1a2b3c4d5e6f",
  tests: 434,
  passed: 433,
  failed: 1,
  failing: [{ file: "test/math.test.ts", name: "subtracts", error: "AssertionError (strictEqual): actual 8, expected 2", onTrunk: "passes" }],
  onTrunk: { passes: 1 },
  trunk: { sha: "1a2b3c4d5e6f", status: "green", tests: 434, passed: 434, failing: 0 },
  text: 'Tests on this change: 433/434 passed, 1 failed ("subtracts"). 1 failing here that passes on trunk.',
};

const item = (reviewTests: unknown, evidence: Record<string, unknown> = { checks: [] }): Proposal => ({ id: "prp_1", status: "escalated", evidence, reviewTests }) as unknown as Proposal;

/** A backend that can run tests again (a live colony), or not (the simulator), recording what it was asked. */
function backend(retest: boolean, asked: string[] = []): Backend {
  return {
    mode: "live",
    ...(retest
      ? {
          retestProposal: async (id: string) => {
            asked.push(id);
          },
        }
      : {}),
  } as unknown as Backend;
}

const render = (p: Proposal, b: Backend, readOnly = false): string => renderToStaticMarkup(createElement(ReviewTests, { item: p, backend: b, readOnly }));

describe("reviewTestsOf", () => {
  it("reads the run the queue sends, else the one the evidence records", () => {
    expect(reviewTestsOf(item(RAN))).toEqual(RAN);
    expect(reviewTestsOf(item(undefined, { checks: [], reviewTests: RAN }))).toEqual(RAN);
  });

  it("reads old or damaged data defensively", () => {
    expect(reviewTestsOf(item(undefined))).toBeNull();
    expect(reviewTestsOf(item("ran"))).toBeNull();
    expect(reviewTestsOf(item({ status: "done" }))).toBeNull();
    expect(reviewTestsOf(item({ status: "ran", failing: [null, { name: "x", onTrunk: "sideways" }], tests: -3, trunk: { status: "blue" } }))).toEqual({
      id: "",
      status: "ran",
      by: "",
      at: 0,
      tests: 0,
      passed: 0,
      failed: 0,
      failing: [{ file: "", name: "x", onTrunk: "unknown" }],
    });
    expect(reviewTestsLead({ id: "", status: "notrun", by: "", at: 0, reason: "the tests took longer than 60 s" })).toBe("Tests on this change: not run: the tests took longer than 60 s.");
    expect(reviewTestsLead({ ...RAN, text: undefined })).toBe("Tests on this change: 433/434 passed, 1 failed.");
    expect(reviewTestsTone(RAN)).toBe("failed");
    expect(reviewTestsTone({ ...RAN, failed: 0, failing: undefined })).toBe("passed");
    expect(reviewTestsTone({ id: "", status: "queued", by: "", at: 0 })).toBe("pending");
  });

  it("tells the review tab when a card's run still waits or goes", () => {
    expect(testsPending([item(RAN)])).toBe(false);
    expect(testsPending([item(RAN), item({ id: "r", status: "running", by: "x", at: 0 })])).toBe(true);
    expect(testsPending([item(undefined)])).toBe(false);
  });
});

describe("ReviewTests on a review card", () => {
  it("leads with the result, each failing test against trunk with its error, the base's certification, and Run again", () => {
    const html = render(item(RAN), backend(true));
    expect(html).toContain('class="rtests is-failed"');
    expect(html).toContain("Tests on this change: 433/434 passed, 1 failed (&quot;subtracts&quot;). 1 failing here that passes on trunk.");
    expect(html).toContain(">subtracts</span>");
    expect(html).toContain("test/math.test.ts");
    expect(html).toContain('class="rtests-on is-passes">passes on trunk');
    expect(html).toContain("AssertionError (strictEqual): actual 8, expected 2");
    expect(html).toContain('On trunk at <span class="mono">1a2b3c4</span> (certified green): 434/434 passed');
    expect(html).toContain("Run again</button>");
  });

  it("says why they did not run, and offers Run again only where a person can ask for it", () => {
    const notrun = item({ id: "", status: "notrun", by: "escalation", at: 0, reason: "no test file imports node:test (2 test files)", text: "Tests on this change: not run: no test file imports node:test (2 test files)." });
    const html = render(notrun, backend(true));
    expect(html).toContain('class="rtests is-pending"');
    expect(html).toContain("Tests on this change: not run: no test file imports node:test (2 test files).");
    expect(html).toContain("Run again</button>");
    // A replay, the simulator, and a run still going: no button.
    expect(render(notrun, backend(true), true)).not.toContain("Run again");
    expect(render(notrun, backend(false))).not.toContain("Run again");
    expect(render(item({ id: "r", status: "running", by: "x", at: 0, text: "Tests on this change: running on its base 1a2b3c4." }), backend(true))).not.toContain("Run again");
    // An item that carries no run (an older server) shows nothing.
    expect(render(item(undefined), backend(true))).toBe("");
  });

  it("never renders repository text as markup", () => {
    const html = render(item({ ...RAN, failing: [{ file: "t/<b>.ts", name: '<img src=x onerror="alert(1)">', error: "x‮y", onTrunk: "new" }] }), backend(true));
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain("x\\u{202e}y");
    expect(html).toContain("new with this change");
  });
});

describe("Run again in the live backend", () => {
  afterEach(() => {
    saveToken("");
    vi.unstubAllGlobals();
  });

  it("posts to the proposal's tests route with this browser's token and the reviewer's name", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, ...(init ? { init } : {}) });
        return new Response(JSON.stringify({ started: true }), { status: 202 });
      }),
    );
    saveToken("operator-token");
    await new HttpBackend("web").retestProposal("prp_1", "matt");
    expect(calls.map((c) => [c.url, c.init?.method, c.init?.body])).toEqual([["/api/colonies/web/proposals/prp_1/tests", "POST", JSON.stringify({ by: "matt" })]]);
    expect(JSON.stringify(calls[0]?.init?.headers)).toContain("Bearer operator-token");
  });
});
