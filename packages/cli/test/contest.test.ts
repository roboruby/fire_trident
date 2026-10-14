import { describe, expect, it } from "vitest";
import type { Landing, LineageNote } from "@fire_trident/core";
import { contestLines } from "../src/contest.ts";
import { colors, formatWhy } from "../src/format.ts";

/** `ft why` on a change that won a contest: how it won (the judge's answer or the jury's votes) and the attempts it was chosen over. */

const plain = colors(false);
const GEMMA = "@cf/google/gemma-4-26b-a4b-it";
const GPT = "@cf/openai/gpt-oss-20b";
const VERDICT = `judged better by 2 of 3 jurors in both orders (${GEMMA}, @cf/zai-org/glm-4.7-flash): it greets in French as asked; ${GPT} preferred the change shown first in both orders`;

function entry(extra: Partial<LineageNote["proposals"][number]>): { landing: Landing; note: LineageNote } {
  const p: LineageNote["proposals"][number] = {
    id: "prp_1",
    agentId: "agt_1",
    agentKind: "synthetic",
    intent: { id: "int_1", title: "Greet in French", why: "Users in Paris" },
    writeSet: [{ path: "src/greet.ts", blob: "a".repeat(40) }],
    readSet: [],
    decisions: [],
    evidence: { checks: [] },
    ...extra,
  };
  return {
    landing: { id: "lnd_1", colonyId: "c", trunkSha: "b".repeat(40), parentSha: "c".repeat(40), proposalIds: ["prp_1"], intentIds: ["int_1"], paths: ["src/greet.ts"], regions: ["src"], at: 1 },
    note: { schema: "firetrident.lineage/v1", landingId: "lnd_1", colonyId: "c", proposals: [p] },
  };
}

describe("contestLines", () => {
  it("shows how the change won and each attempt it was chosen over, with why it lost", () => {
    const checks = [{ name: "contest", ok: true, ms: 2_400, detail: `won the contest for int_1 against 1 other change: over prp_2: ${VERDICT}` }];
    const lines = contestLines(checks, [{ proposalId: "prp_2", agentId: "agt_2", model: "m", reason: VERDICT }], plain);
    expect(lines).toEqual([
      { k: "contest", v: `won the contest for int_1 against 1 other change: over prp_2: ${VERDICT}` },
      { k: "also", v: `prp_2 by agt_2 (m): ${VERDICT}` },
    ]);
    // The judge's own wording, and an alternative without a model.
    const judge = contestLines(undefined, [{ proposalId: "prp_3", agentId: "agt_3", reason: `a tie (${GEMMA} preferred the change shown first in both orders), broken by the smaller diff: 2 lines against 4` }], plain);
    expect(judge).toEqual([{ k: "also", v: `prp_3 by agt_3: a tie (${GEMMA} preferred the change shown first in both orders), broken by the smaller diff: 2 lines against 4` }]);
  });

  it("prints nothing for a change that won no contest, and skips odd entries", () => {
    expect(contestLines([{ name: "gate", ok: true, ms: 1 }], undefined, plain)).toEqual([]);
    expect(contestLines(undefined, [{ agentId: "agt_2", reason: "x" } as never, null as never, "x" as never], plain)).toEqual([]);
    expect(contestLines(undefined, [{ proposalId: "prp_2", agentId: "agt_2", reason: "  " }], plain)).toEqual([{ k: "also", v: "prp_2 by agt_2" }]);
  });
});

describe("ft why", () => {
  it("prints the contest and also lines after the checks", () => {
    const checks = [{ name: "contest", ok: true, ms: 2_400, detail: `won the contest for int_1 against 1 other change: over prp_2: ${VERDICT}` }];
    const out = formatWhy({ path: "src/greet.ts" }, [entry({ evidence: { checks }, alternatives: [{ proposalId: "prp_2", agentId: "agt_2", model: "m", reason: VERDICT }] })], {}, plain, 10);
    const lines = out.split("\n");
    const checksAt = lines.findIndex((l) => l.includes("checks   "));
    expect(lines[checksAt + 1]).toBe(`  contest  won the contest for int_1 against 1 other change: over prp_2: ${VERDICT}`);
    expect(lines[checksAt + 2]).toBe(`  also     prp_2 by agt_2 (m): ${VERDICT}`);
    expect(formatWhy({ path: "src/greet.ts" }, [entry({})], {}, plain, 10)).not.toMatch(/contest|also/);
  });
});
