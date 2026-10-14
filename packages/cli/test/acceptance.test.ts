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
});
