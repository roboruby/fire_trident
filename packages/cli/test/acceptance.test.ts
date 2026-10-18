import { describe, expect, it } from "vitest";
import type { Landing, LineageNote, NoteDecision } from "@fire_trident/core";
import { acceptanceRows } from "../src/acceptance.ts";
import { colors, formatWhy } from "../src/format.ts";

/** `ft why` with quoted acceptance (FT_QUOTED_ACCEPTANCE): the changed line quoted for each acceptance line. */

const plain = colors(false);

const LLM: NoteDecision = {
  kind: "triage",
  layer: "llm",
  p: 0.95,
  action: "land",
  by: "@cf/google/gemma-4-26b-a4b-it",
  answer: "approve: meets both lines",
  acceptance: [
    { kind: "intent", line: "slugify lowercases its input", verdict: "met", path: "src/slug.ts", quote: "const lower = text.toLowerCase();" },
    { kind: "intent", line: "slugify replaces each run of spaces with one hyphen", verdict: "unclear", said: "met", problem: "its quote is from a line the change removes from src/slug.ts" },
    { kind: "keep", line: "Returns 404 for an unknown slug", verdict: "not met", landingId: "lnd_7" },
  ],
};

function entry(decisions: NoteDecision[]): { landing: Landing; note: LineageNote } {
  return {
    landing: { id: "lnd_1", colonyId: "c", trunkSha: "b".repeat(40), parentSha: "c".repeat(40), proposalIds: ["prp_1"], intentIds: ["int_1"], paths: ["src/slug.ts"], regions: ["src"], at: 1 },
    note: {
      schema: "firetrident.lineage/v1",
      landingId: "lnd_1",
      colonyId: "c",
      proposals: [
        { id: "prp_1", agentId: "agt_1", agentKind: "external", intent: { id: "int_1", title: "Add slugify", why: "" }, writeSet: [{ path: "src/slug.ts", blob: "a".repeat(40) }], readSet: [], decisions, evidence: { checks: [] } },
      ],
    },
  };
}

describe("acceptanceRows", () => {
  it("prints each line with what counted and the changed line quoted for it", () => {
    expect(acceptanceRows([LLM], plain)).toEqual([
      { k: "accept", v: '✓ line 1 "slugify lowercases its input"  src/slug.ts: "const lower = text.toLowerCase();"' },
      { k: "", v: '? line 2 "slugify replaces each run of spaces with one hyphen"  unclear: answered met but its quote is from a line the change removes from src/slug.ts' },
      { k: "", v: '✗ keep line 1 "Returns 404 for an unknown slug" (from lnd_7)  not met' },
    ]);
  });

  it("marks the lines FireTrident checked itself (the review view), with what it found", () => {
    const checked: NoteDecision = {
      ...LLM,
      acceptance: [
        { kind: "intent", line: "src/core/money.ts exports isZero(m: Money): boolean", verdict: "met", basis: "checked", path: "src/core/money.ts", quote: "isZero(m: Money): boolean" },
        { kind: "keep", line: "src/core/money.ts exports allocate(m: Money): Money[]", verdict: "not met", basis: "checked", path: "src/core/money.ts", problem: "src/core/money.ts does not export allocate, though it held before this change", landingId: "lnd_7" },
        { kind: "keep", line: "src/core/money.ts exports isNegative(m: Money): boolean", verdict: "unclear", basis: "checked", path: "src/core/money.ts", problem: "it did not hold before this change either" },
      ],
    };
    expect(acceptanceRows([checked], plain)).toEqual([
      { k: "accept", v: '✓ line 1 "src/core/money.ts exports isZero(m: Money): boolean"  checked by FireTrident: src/core/money.ts isZero(m: Money): boolean' },
      { k: "", v: '✗ keep line 1 "src/core/money.ts exports allocate(m: Money): Money[]" (from lnd_7)  not met: checked by FireTrident: src/core/money.ts does not export allocate, though it held before this change' },
      { k: "", v: '? keep line 2 "src/core/money.ts exports isNegative(m: Money): boolean"  unclear: checked by FireTrident: it did not hold before this change either' },
    ]);
  });

  it("prints nothing for notes without them, or with odd data", () => {
    expect(acceptanceRows([], plain)).toEqual([]);
    expect(acceptanceRows(undefined, plain)).toEqual([]);
    expect(acceptanceRows([{ ...LLM, acceptance: "odd" as unknown as NoteDecision["acceptance"] }], plain)).toEqual([]);
  });

  it("shows under the decisions in ft why", () => {
    const text = formatWhy({ path: "src/slug.ts" }, [entry([LLM])], {}, plain, 0);
    expect(text).toContain('  accept   ✓ line 1 "slugify lowercases its input"  src/slug.ts: "const lower = text.toLowerCase();"');
    expect(text.indexOf("accept ")).toBeGreaterThan(text.indexOf("decided"));
    const { acceptance: _gone, ...before } = LLM;
    expect(formatWhy({ path: "src/slug.ts" }, [entry([before])], {}, plain, 0)).not.toContain("accept ");
  });

  it("marks a met that rests on the model's word (a line stating an absence), and what the model saw for a line not met", () => {
    const decision: NoteDecision = {
      ...LLM,
      acceptance: [
        { kind: "intent", line: "No other option, file or formatting changes", verdict: "met", basis: "absence" },
        { kind: "intent", line: "No console output is added", verdict: "not met", path: "src/slug.ts", quote: "console.log(lower);" },
        { kind: "intent", line: "slugify lowercases its input", verdict: "met", basis: "quote", path: "src/slug.ts", quote: "const lower = text.toLowerCase();" },
      ],
    };
    expect(acceptanceRows([decision], plain)).toEqual([
      { k: "accept", v: `✓ line 1 "No other option, file or formatting changes"  model's word (it states an absence, so there is no changed line to quote)` },
      { k: "", v: `✗ line 2 "No console output is added"  not met (it saw src/slug.ts: "console.log(lower);")` },
      { k: "", v: `✓ line 3 "slugify lowercases its input"  src/slug.ts: "const lower = text.toLowerCase();"` },
    ]);
    expect(formatWhy({ path: "src/slug.ts" }, [entry([decision])], {}, plain, 0)).toContain("model's word (it states an absence, so there is no changed line to quote)");
  });
});
