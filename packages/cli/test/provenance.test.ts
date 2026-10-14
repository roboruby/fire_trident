import { describe, expect, it } from "vitest";
import type { Landing, LineageNote, NoteProvenance } from "@fire_trident/core";
import { colors, formatWhy, provenanceLine } from "../src/format.ts";

/** `ft why`: how each landed change's author and model are known (the note's provenance), and notes written before it. */

const plain = colors(false);
const GEMMA = "@cf/google/gemma-4-26b-a4b-it";

function entry(provenance: unknown, model?: string): { landing: Landing; note: LineageNote } {
  const p = {
    id: "prp_1",
    agentId: "agt_1",
    agentKind: "internal" as const,
    ...(model ? { model } : {}),
    intent: { id: "int_1", title: "Fix it", why: "" },
    writeSet: [{ path: "src/a.ts", blob: "a".repeat(40) }],
    readSet: [],
    decisions: [],
    evidence: { checks: [] },
    ...(provenance !== undefined ? { provenance: provenance as NoteProvenance } : {}),
  };
  return {
    landing: { id: "lnd_1", colonyId: "c", trunkSha: "b".repeat(40), parentSha: "c".repeat(40), proposalIds: ["prp_1"], intentIds: ["int_1"], paths: ["src/a.ts"], regions: ["src"], at: 1 },
    note: { schema: "firetrident.lineage/v1", landingId: "lnd_1", colonyId: "c", proposals: [p] },
  };
}

describe("provenanceLine", () => {
  it("says an in-platform agent's model was observed by FireTrident, with what it counted", () => {
    const observed: NoteProvenance = { author: "platform", auth: "platform", model: { evidence: "observed", name: GEMMA, observed: [{ model: GEMMA, calls: 3, inputTokens: 4120, outputTokens: 812, cachedTokens: 100 }] } };
    expect(provenanceLine(observed, GEMMA, plain)).toBe("in-platform agent, run by FireTrident · model observed by FireTrident: 3 calls, 4,120 in / 812 out tokens (100 cached)");
    // A model the intent asked for is named; so is every model called.
    const other: NoteProvenance = { author: "platform", model: { evidence: "observed", name: GEMMA, observed: [{ model: "@cf/openai/gpt-oss-120b", calls: 1, inputTokens: 1, outputTokens: 2 }, { model: GEMMA, calls: 2 }] } };
    expect(provenanceLine(other, GEMMA, plain)).toBe("in-platform agent, run by FireTrident · model observed by FireTrident: @cf/openai/gpt-oss-120b 1 call, 1 in / 2 out tokens; 2 calls");
    expect(provenanceLine({ author: "platform", model: { evidence: "observed", name: GEMMA } }, GEMMA, plain)).toBe(
      "in-platform agent, run by FireTrident · model observed by FireTrident (no model call recorded for this change)",
    );
  });

  it("says an external agent's model was declared by the agent, and what authenticated it when the colony said", () => {
    expect(provenanceLine({ author: "external", auth: "mcp", model: { evidence: "declared", name: "claude-sonnet-5-5" } }, "claude-sonnet-5-5", plain)).toBe(
      "external agent (MCP token and its resume key) · model declared by the agent",
    );
    expect(provenanceLine({ author: "external", auth: "token", model: { evidence: "declared", name: "x-1" } }, undefined, plain)).toBe("external agent (a deployment token, not bound to it) · model declared by the agent: x-1");
    expect(provenanceLine({ author: "external" }, undefined, plain)).toBe("external agent (MCP or API token) · model not known");
    expect(provenanceLine({ author: "synthetic" }, undefined, plain)).toBe("bench agent · model not known");
  });

  it("shows values it does not know as they are, and nothing for what is not provenance", () => {
    expect(provenanceLine({ author: "robot", auth: "badge", model: { evidence: "guessed", name: "m" } }, undefined, plain)).toBe("author robot · model guessed: m");
    expect(provenanceLine({ model: { evidence: "observed", observed: [null, 7, { model: GEMMA, calls: "3" }] } }, GEMMA, plain)).toBe(
      "author unknown · model observed by FireTrident (no model call recorded for this change)",
    );
    for (const x of [undefined, null, "platform", 3, []]) expect(provenanceLine(x, undefined, plain)).toBeNull();
  });
});

describe("ft why: the source line", () => {
  it("follows the proposal line when the note records provenance", () => {
    const text = formatWhy({ path: "src/a.ts" }, [entry({ author: "external", auth: "mcp", model: { evidence: "declared", name: "claude-sonnet-5-5" } }, "claude-sonnet-5-5")], {}, plain, 0);
    const lines = text.split("\n");
    const at = lines.findIndex((l) => l.startsWith("  proposal "));
    expect(lines.slice(at, at + 3)).toEqual([
      "  proposal prp_1 by agt_1 (internal · claude-sonnet-5-5)",
      "  source   external agent (MCP token and its resume key) · model declared by the agent",
      '  intent   int_1 "Fix it"',
    ]);
  });

  it("reads a note written before provenance was kept exactly as before", () => {
    const text = formatWhy({ path: "src/a.ts" }, [entry(undefined, GEMMA)], {}, plain, 0);
    expect(text).not.toContain("source");
    expect(text).toContain(`  proposal prp_1 by agt_1 (internal · ${GEMMA})\n  intent   int_1 "Fix it"`);
  });
});
