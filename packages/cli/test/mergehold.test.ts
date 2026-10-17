import { describe, expect, it } from "vitest";
import type { HeldMergeFile, Proposal } from "@fire_trident/core";
import { colors, formatReview } from "../src/format.ts";

/** `ft review` with a merge held for a person (merge locks): the blobs and both diffs come before the change itself. */

const plain = colors(false);

const HELD: HeldMergeFile = {
  path: "src/app/main.ts",
  base: "a".repeat(40),
  trunk: "b".repeat(40),
  theirs: "d".repeat(40),
  result: "c".repeat(40),
  trunkDiff: { hunks: "@@ -1,3 +1,3 @@\n-line 1\n+trunk one\n line 2\n line 3", added: 1, removed: 1, truncated: false },
};

function proposal(mergeHold: unknown): Proposal {
  return {
    id: "prp_1",
    colonyId: "c",
    intentId: "int_1",
    agentId: "agt_1",
    workspace: { namespace: "ft-ws-0", name: "c--ws-1", remote: "https://example.invalid/ws.git" },
    baseSha: "b".repeat(40),
    headSha: "h".repeat(40),
    writeSet: [{ path: HELD.path, blob: HELD.theirs }],
    readSet: [],
    declared: { footprint: [HELD.path], summary: "edit" },
    evidence: { checks: [] },
    status: "escalated",
    createdAt: 0,
    reason: "A person approved this change against an older trunk; trunk has since changed src/app/main.ts",
    mergeHold,
  } as unknown as Proposal;
}

describe("ft review: a held merge", () => {
  it("prints each file's blobs, what trunk changed, and says when a diff was not kept", () => {
    const out = formatReview([proposal([HELD])], [], plain, 0);
    expect(out).toContain("trunk moved since this was decided  approving lands this merge");
    expect(out).toContain("src/app/main.ts  aaaaaaaaaa at its base, bbbbbbbbbb on trunk, decided on dddddddddd, merged as cccccccccc");
    expect(out).toContain("what trunk changed since the change's base  +1 −1");
    expect(out).toContain("+    1  trunk one");
    expect(out).toContain("the merged result against the version decided on: not kept");
    // Before the reason.
    expect(out.indexOf("trunk moved since this was decided")).toBeLessThan(out.indexOf("reason"));
  });

  it("prints nothing for a proposal without one, or with damaged data", () => {
    for (const held of [undefined, "x", [{ base: "a" }]]) expect(formatReview([proposal(held)], [], plain, 0)).not.toContain("trunk moved since");
  });
});
