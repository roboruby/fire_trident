import { describe, expect, it } from "vitest";
import type { NoteDecision } from "@fire_trident/core";
import { acceptanceOf } from "../src/acceptance.ts";

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
});
