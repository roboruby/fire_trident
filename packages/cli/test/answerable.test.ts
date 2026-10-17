import { describe, expect, it } from "vitest";
import type { CheckResult, Landing, LineageNote, NoteDecision } from "@fire_trident/core";
import { colors, formatReview, formatWhy } from "../src/format.ts";

/** `ft why` names who answers for each landing and labels who said each line of its evidence; `ft review` labels the checks. */

const plain = colors(false);
const GEMMA = "@cf/google/gemma-4-26b-a4b-it";
const llmGate: CheckResult = { name: "gate", ok: true, ms: 0, detail: "L1 innate+llm → land by llm at head ffffffffffff (confirmations: innate + llm): approved" };
const proofGate: CheckResult = { name: "gate", ok: true, ms: 0, detail: "D3 innate+proof → land by deterministic at head ffffffffffff (confirmations: innate + deterministic): proven" };

function entry(intent: Record<string, unknown>, extra: { decisions?: NoteDecision[]; checks?: CheckResult[]; notVerified?: string; notVerifiedBy?: "agent" | "platform" } = {}): { landing: Landing; note: LineageNote } {
  const p = {
    id: "prp_1",
    agentId: "agt_1",
    agentKind: "external" as const,
    intent: { id: "int_1", title: "Fix it", why: "", ...intent },
    writeSet: [{ path: "src/a.ts", blob: "a".repeat(40) }],
    readSet: [],
    decisions: extra.decisions ?? [],
    evidence: { checks: extra.checks ?? [], ...(extra.notVerified ? { notVerified: extra.notVerified } : {}), ...(extra.notVerifiedBy ? { notVerifiedBy: extra.notVerifiedBy } : {}) },
  };
  return {
    landing: { id: "lnd_1", colonyId: "c", trunkSha: "b".repeat(40), parentSha: "c".repeat(40), proposalIds: ["prp_1"], intentIds: ["int_1"], paths: ["src/a.ts"], regions: ["src"], at: 1 },
    note: { schema: "firetrident.lineage/v1", landingId: "lnd_1", colonyId: "c", proposals: [p] } as unknown as LineageNote,
  };
}

const why = (e: ReturnType<typeof entry>): string[] => formatWhy({ path: "src/a.ts" }, [e], {}, plain, 0).split("\n");

describe("ft why: the answer line", () => {
  it("names the person who approved, the rule's approver, or the asker, under the landing", () => {
    const approved = why(entry({ source: "agent", createdBy: "agt_1" }, { decisions: [{ kind: "triage", layer: "human", p: 1, action: "approve", by: "Matt" }] }));
    expect(approved[3]).toBe("  answer   Matt approved this change.");
    expect(why(entry({ source: "rule", createdBy: "Ana", ruleId: "rul_1", ruleApprovedBy: "Ana" }, { checks: [proofGate] }))).toContain("  answer   Ana approved rule rul_1, whose deterministic proof landed this change.");
    expect(why(entry({ source: "human", createdBy: "Lee" }, { checks: [llmGate], decisions: [{ kind: "triage", layer: "llm", p: 0.9, action: "land", by: GEMMA }] }))).toContain(
      `  answer   Lee asked for this intent; model ${GEMMA} approved it.`,
    );
  });

  it("says no person is answerable and why, or unknown for an old note", () => {
    expect(why(entry({ source: "agent", createdBy: "agt_9" }, { checks: [llmGate] }))).toContain("  answer   No person is answerable for this landing: agent agt_9 declared the intent and a model approved it.");
    expect(why(entry({}, { checks: [llmGate] }))).toContain("  answer   Unknown: the note was written before notes recorded who asked for each intent.");
  });
});

describe("ft why and ft review: who said each line", () => {
  const checks: CheckResult[] = [{ name: "write src/a.ts", ok: true, ms: 3, by: "agent" }, { name: "innate: blobs", ok: true, ms: 1 }, { name: `llm: ${GEMMA}`, ok: true, ms: 900 }, llmGate];

  it("labels the checks in runs, FireTrident's first, and quotes the agent's statement", () => {
    const lines = why(entry({ source: "human", createdBy: "Lee" }, { checks, notVerified: "Not verified: the build", notVerifiedBy: "agent" }));
    expect(lines).toContain(`  checks   checked by FireTrident: ✓ innate: blobs 1ms  ✓ gate 0ms · model (${GEMMA}): ✓ llm: ${GEMMA} 900ms · agent's claim: ✓ write src/a.ts 3ms`);
    expect(lines).toContain('  unproven agent\'s claim: "the build"');
    const platform = why(entry({ source: "agent", createdBy: "agt_1" }, { notVerified: "Not verified: external agent over MCP; no check it ran is visible to the platform.", notVerifiedBy: "platform" }));
    expect(platform).toContain("  unproven checked by FireTrident: external agent over MCP; no check it ran is visible to the platform.");
  });

  it("labels the review card's checks the same way", () => {
    const p = { id: "prp_9", colonyId: "c", intentId: "int_1", agentId: "agt_1", writeSet: [], readSet: [], declared: { footprint: [], summary: "" }, evidence: { checks }, status: "escalated", createdAt: 0 };
    expect(formatReview([p] as never, [], plain, 0, { colony: "c" })).toContain(`checked by FireTrident: ✓ innate: blobs 1ms  ✓ gate 0ms · model (${GEMMA}): ✓ llm: ${GEMMA} 900ms · agent's claim: ✓ write src/a.ts 3ms`);
  });
});
