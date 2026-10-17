import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { HeldMergeFile, Proposal } from "@fire_trident/core";
import { MergeHold } from "../src/components/MergeHold.tsx";
import { mergeHoldOf } from "../src/mergehold.ts";

/** A merge held for a person on a review card (merge locks): what trunk changed, and the merged result against what was decided on. */

const TRUNK_DIFF = "@@ -1,3 +1,3 @@\n-line 1\n+trunk one\n line 2\n line 3";
const MERGED_DIFF = "@@ -1,3 +1,3 @@\n-line 1\n+trunk one\n line 2\n line 3";

const HELD: HeldMergeFile = {
  path: "src/app/main.ts",
  base: "a".repeat(40),
  trunk: "b".repeat(40),
  theirs: "d".repeat(40),
  result: "c".repeat(40),
  by: "prp_ahead",
  trunkDiff: { hunks: TRUNK_DIFF, added: 1, removed: 1, truncated: false },
  mergedDiff: { hunks: MERGED_DIFF, added: 1, removed: 1, truncated: true },
};

const item = (mergeHold: unknown): Proposal => ({ id: "prp_1", status: "escalated", mergeHold }) as unknown as Proposal;

describe("mergeHoldOf", () => {
  it("reads each held file with its blobs and diffs", () => {
    expect(mergeHoldOf(item([HELD]))).toEqual([{ ...HELD }]);
  });

  it("reads old or damaged data defensively: a diff not kept is null, a file without a path is dropped", () => {
    expect(mergeHoldOf(item(undefined))).toBeNull();
    expect(mergeHoldOf(item("nope"))).toBeNull();
    expect(mergeHoldOf(item([{ base: "x" }, null]))).toBeNull();
    expect(mergeHoldOf(item([{ path: "a.ts", trunkDiff: { added: 2 } }]))).toEqual([{ path: "a.ts", base: "", trunk: "", theirs: "", result: "", trunkDiff: null, mergedDiff: null }]);
  });
});

describe("MergeHold on a review card", () => {
  it("shows each file's blobs, what trunk changed and the merged result, as text", () => {
    const html = renderToStaticMarkup(createElement(MergeHold, { files: mergeHoldOf(item([HELD]))! }));
    expect(html).toContain("Trunk moved since this was decided: approving lands this merge");
    expect(html).toContain("aaaaaaaaaa at its base, bbbbbbbbbb on trunk from prp_ahead, decided on dddddddddd, merged as cccccccccc");
    expect(html).toContain("What trunk changed since the change&#x27;s base");
    expect(html).toContain("The merged result against the version that was decided on");
    expect(html).toContain("trunk one");
    expect(html).toContain("truncated");
  });

  it("never renders repository text as markup, and says when a diff was not kept", () => {
    const hostile: HeldMergeFile = { ...HELD, path: "src/<b>x</b>.ts", trunkDiff: { hunks: "@@ -1,1 +1,1 @@\n-a\n+<img src=x onerror=alert(1)>", added: 1, removed: 1, truncated: false } };
    delete hostile.mergedDiff;
    const html = renderToStaticMarkup(createElement(MergeHold, { files: mergeHoldOf(item([hostile]))! }));
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("src/&lt;b&gt;x&lt;/b&gt;.ts");
    expect(html).toContain("Its diff was not kept with this card.");
  });
});
