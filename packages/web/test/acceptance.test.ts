import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { NoteDecision } from "@fire_trident/core";
import { acceptanceOf } from "../src/acceptance.ts";
import { AcceptanceLines } from "../src/components/AcceptanceLines.tsx";

/** The Why panel's reading of quoted acceptance (FT_QUOTED_ACCEPTANCE) in a note's second-opinion decision. */

const BASE: NoteDecision = { kind: "triage", layer: "llm", p: 0.9, action: "land" };

describe("acceptanceOf", () => {
  it("gives each line its place, verdict and the quoted changed line", () => {
    const rows = acceptanceOf({
      ...BASE,
      acceptance: [
        { kind: "intent", line: "slugify lowercases its input", verdict: "met", path: "src/slug.ts", quote: "const lower = text.toLowerCase();" },
        { kind: "intent", line: "slugify replaces spaces", verdict: "unclear", said: "met", path: "src/slug.ts", quote: "made up", problem: "its quote is not in the added or unchanged lines of src/slug.ts it was shown" },
        { kind: "keep", line: "Returns 404", verdict: "not met", landingId: "lnd_7" },
        { kind: "intent", line: "the model said unclear", verdict: "unclear" },
      ],
    });
    expect(rows).toEqual([
      { place: "line 1", line: "slugify lowercases its input", verdict: "met", path: "src/slug.ts", quote: "const lower = text.toLowerCase();" },
      { place: "line 2", line: "slugify replaces spaces", verdict: "unclear", why: "answered met but its quote is not in the added or unchanged lines of src/slug.ts it was shown" },
      { place: "keep line 1", line: "Returns 404", verdict: "not met", landingId: "lnd_7" },
      { place: "line 3", line: "the model said unclear", verdict: "unclear", why: "the second opinion answered unclear" },
    ]);
  });

  it("reads notes without them, and odd entries, as nothing", () => {
    expect(acceptanceOf(BASE)).toEqual([]);
    expect(acceptanceOf(null)).toEqual([]);
    expect(acceptanceOf({ ...BASE, acceptance: [null, "x", { kind: "intent", line: "", verdict: "met" }, { kind: "intent", line: "a", verdict: "maybe" }] as unknown as NoteDecision["acceptance"] })).toEqual([]);
  });

  it("keeps the basis of a met, and what the model saw for a line not met", () => {
    expect(
      acceptanceOf({
        ...BASE,
        acceptance: [
          { kind: "intent", line: "No other option, file or formatting changes", verdict: "met", basis: "absence" },
          { kind: "intent", line: "slugify lowercases its input", verdict: "met", basis: "quote", path: "src/slug.ts", quote: "const lower = text.toLowerCase();" },
          { kind: "intent", line: "No console output is added", verdict: "not met", path: "src/slug.ts", quote: "console.log(lower);" },
        ],
      }),
    ).toEqual([
      { place: "line 1", line: "No other option, file or formatting changes", verdict: "met", basis: "absence" },
      { place: "line 2", line: "slugify lowercases its input", verdict: "met", basis: "quote", path: "src/slug.ts", quote: "const lower = text.toLowerCase();" },
      { place: "line 3", line: "No console output is added", verdict: "not met", why: 'it saw src/slug.ts: "console.log(lower);"' },
    ]);
  });

  it("marks the lines FireTrident checked itself (the review view), with what it found", () => {
    const rows = acceptanceOf({
      ...BASE,
      acceptance: [
        { kind: "intent", line: "src/core/money.ts exports isZero(m: Money): boolean", verdict: "met", basis: "checked", path: "src/core/money.ts", quote: "isZero(m: Money): boolean" },
        { kind: "keep", line: "src/core/money.ts exports allocate(m: Money): Money[]", verdict: "not met", basis: "checked", path: "src/core/money.ts", problem: "src/core/money.ts does not export allocate, though it held before this change", landingId: "lnd_7" },
        { kind: "keep", line: "src/core/money.ts exports isNegative(m: Money): boolean", verdict: "unclear", basis: "checked", path: "src/core/money.ts", problem: "it did not hold before this change either: src/core/money.ts does not export isNegative" },
      ],
    });
    expect(rows).toEqual([
      { place: "line 1", line: "src/core/money.ts exports isZero(m: Money): boolean", verdict: "met", basis: "checked", path: "src/core/money.ts", quote: "isZero(m: Money): boolean" },
      { place: "keep line 1", line: "src/core/money.ts exports allocate(m: Money): Money[]", verdict: "not met", basis: "checked", why: "checked by FireTrident: src/core/money.ts does not export allocate, though it held before this change", landingId: "lnd_7" },
      { place: "keep line 2", line: "src/core/money.ts exports isNegative(m: Money): boolean", verdict: "unclear", basis: "checked", why: "checked by FireTrident: it did not hold before this change either: src/core/money.ts does not export isNegative" },
    ]);
    const html = renderToStaticMarkup(createElement(AcceptanceLines, { rows }));
    expect(html).toContain("checked by FireTrident<span class=\"mono\">: src/core/money.ts: isZero(m: Money): boolean</span>");
    expect(html).toContain("checked by FireTrident: src/core/money.ts does not export allocate, though it held before this change");
  });

  it("the Why tab marks a met on the model's word, and shows the quote for the others", () => {
    const rows = acceptanceOf({
      ...BASE,
      acceptance: [
        { kind: "intent", line: "No other option, file or formatting changes", verdict: "met", basis: "absence" },
        { kind: "intent", line: "slugify lowercases its input", verdict: "met", basis: "quote", path: "src/slug.ts", quote: "const lower = text.toLowerCase();" },
        { kind: "intent", line: "No console output is added", verdict: "not met", path: "src/slug.ts", quote: "console.log(lower);" },
      ],
    });
    const html = renderToStaticMarkup(createElement(AcceptanceLines, { rows }));
    expect(html).toContain("model&#x27;s word (it states an absence, so there is no changed line to quote)");
    expect(html).toContain("src/slug.ts: const lower = text.toLowerCase();");
    expect(html).toContain("it saw src/slug.ts: &quot;console.log(lower);&quot;");
    expect(renderToStaticMarkup(createElement(AcceptanceLines, { rows: [] }))).toBe("");
  });
});
