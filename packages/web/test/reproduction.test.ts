import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ColonySpend, Proposal } from "@fire_trident/core";
import { ReviewChange } from "../src/components/ReviewChange.tsx";
import { SpendNote } from "../src/components/Spend.tsx";
import { reviewOf } from "../src/review.ts";
import { mechanicalLine, parseMechanical, parseSpend } from "../src/spend.ts";

/**
 * Review by reproduction on the review card (the residual diff first, with the reproduced count), and the mechanical
 * share on the spend card (work that landed with no model call, at $0).
 */

const RESIDUAL = { path: "src/mod.ts", status: "modified", added: 1, removed: 0, hunks: "@@ -1,3 +1,4 @@\n export function assemble(a) {\n+  globalThis.audit = true;\n   return a + 1;\n }", truncated: false };

function queued(review: unknown): Proposal {
  return { id: "prp_1", declared: { footprint: ["src/"], summary: "" }, review } as unknown as Proposal;
}

describe("the review card of a reproduced change", () => {
  it("reads the reproduction the server sends, and leaves it out when it does not read as one", () => {
    const view = reviewOf(
      queued({
        files: [RESIDUAL],
        filesChanged: 1,
        danger: [],
        residual: [],
        reproduction: { recipe: "rename-identifier@1", reproduced: { files: 211, lines: 3_998 }, residual: { files: 1, lines: 1 }, text: "3,998 lines reproduced by rename-identifier@1, 1 line to review" },
      }),
    )!;
    expect(view.reproduction).toEqual({ recipe: "rename-identifier@1", reproduced: { files: 211, lines: 3_998 }, residual: { files: 1, lines: 1 }, text: "3,998 lines reproduced by rename-identifier@1, 1 line to review" });
    expect(reviewOf(queued({ files: [RESIDUAL], filesChanged: 1, danger: [], residual: [], reproduction: { recipe: 3 } }))!.reproduction).toBeUndefined();
  });

  it("shows the reproduced count first and the residual as the change to review", () => {
    const view = reviewOf(
      queued({
        files: [RESIDUAL],
        filesChanged: 1,
        danger: [],
        residual: [],
        reproduction: { recipe: "rename-identifier@1", reproduced: { files: 211, lines: 3_998 }, residual: { files: 1, lines: 1 }, text: "3,998 lines reproduced by rename-identifier@1, 1 line to review" },
      }),
    )!;
    const html = renderToStaticMarkup(createElement(ReviewChange, { view, declared: ["src/"] }));
    expect(html).toContain("Reproduced by recipe");
    expect(html).toContain("3,998 lines reproduced by rename-identifier@1, 1 line to review");
    expect(html).toContain("211 files (3,998 lines) equal");
    expect(html).toContain("Residual to review · 1 file");
    expect(html.indexOf("Reproduced by recipe")).toBeLessThan(html.indexOf("Residual to review"));
    const plain = renderToStaticMarkup(createElement(ReviewChange, { view: { ...view, reproduction: undefined }, declared: ["src/"] }));
    expect(plain).toContain("Full change · 1 file");
    expect(plain).not.toContain("Reproduced by recipe");
  });
});

describe("the mechanical share on the spend card", () => {
  const base = { usd: 0, byLayer: { agents: 0, review: 0, judge: 0, resolver: 0, other: 0 }, perLandedIntent: null, landedIntents: 0, tokens: { input: 0, output: 0 }, byModel: {}, unpriced: {}, priceDate: "2026-10-01" };

  it("reads it and says it in one line at $0", () => {
    expect(parseMechanical({ landings: 3, files: 212, violations: 340, reproducedLines: 3_999 })).toEqual({ landings: 3, files: 212, violations: 340, reproducedLines: 3_999 });
    expect(parseMechanical({ landings: 0, files: 0, violations: 0, reproducedLines: 0 })).toBeNull();
    expect(parseMechanical("x")).toBeNull();
    expect(mechanicalLine({ landings: 3, files: 212, violations: 340, reproducedLines: 3_999 })).toBe("$0 mechanical: 212 files by 3 recipe landings, 340 rule violations fixed, 3,999 lines reproduced");
    expect(mechanicalLine({ landings: 0, files: 0, violations: 0, reproducedLines: 1 })).toBe("$0 mechanical: 1 line reproduced");
    expect(parseSpend({ ...base, mechanical: { landings: 1, files: 2, violations: 3, reproducedLines: 0 } })?.mechanical).toEqual({ landings: 1, files: 2, violations: 3, reproducedLines: 0 });
    expect(parseSpend(base)?.mechanical).toBeUndefined();
  });

  it("shows the card for mechanical work even when no model call was made", () => {
    const spend = parseSpend({ ...base, mechanical: { landings: 2, files: 120, violations: 0, reproducedLines: 0 } }) as ColonySpend;
    const html = renderToStaticMarkup(createElement(SpendNote, { spend }));
    expect(html).toContain("no model calls yet");
    expect(html).toContain("$0 mechanical: 120 files by 2 recipe landings");
    expect(renderToStaticMarkup(createElement(SpendNote, { spend: parseSpend(base) }))).toBe("");
  });
});
