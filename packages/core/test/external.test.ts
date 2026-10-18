import { describe, expect, it } from "vitest";
import { changeAnswerable } from "../src/answerable.ts";
import { declaredText } from "../src/lifecycle.ts";
import type { CheckResult, LineageNote, NoteDecision } from "../src/types.ts";

/**
 * An imported GitHub issue's intent (source `external`, worker colony/issues.ts) in the words the note, `ft why`, the
 * lifecycle strip and the Why tab use: a stranger wrote it and a person imported it, so the person who imported it does
 * not answer for a change that landed on a model's approval, and the strip says where it came from.
 */

type Entry = LineageNote["proposals"][number];
const GEMMA = "@cf/google/gemma-4-26b-a4b-it";
const llmGate: CheckResult = { name: "gate", ok: true, ms: 0, detail: "L1 innate+llm → land by llm at head 9a7220a8f2f2 (confirmations: innate + llm): approved" };
const llmLand: NoteDecision = { kind: "triage", layer: "llm", p: 0.9, action: "land", by: GEMMA, answer: "approve: fine" };
const approve: NoteDecision = { kind: "triage", layer: "human", p: 1, action: "approve", by: "Dana" };
const EXT = { kind: "github-issue" as const, repo: "octo-org/site", number: 12, url: "https://github.com/octo-org/site/issues/12", author: "octocat" };

function entry(decisions: NoteDecision[]): Entry {
  return {
    id: "prp_1",
    agentId: "agt_1",
    agentKind: "external",
    intent: { id: "int_1", title: "Fix the footer link (octo-org/site#12)", why: "From the public GitHub issue ...", source: "external", createdBy: "Lee", external: EXT },
    writeSet: [{ path: "src/footer.ts", blob: "b".repeat(40) }],
    readSet: [],
    decisions,
    evidence: { checks: [llmGate] },
  };
}

describe("an imported issue's intent", () => {
  it("has no answerable person when a model landed it, and names who imported it", () => {
    const a = changeAnswerable(entry([llmLand]));
    expect(a.basis).toBe("none");
    expect(a.text).toBe(`No person is answerable for this landing: Lee imported the intent from a public issue and model ${GEMMA} approved it.`);
  });

  it("is answered for by the person who approved the change, as any change is", () => {
    expect(changeAnswerable(entry([llmLand, approve]))).toMatchObject({ basis: "approved", person: "Dana" });
  });

  it("says where it came from on the lifecycle strip", () => {
    expect(declaredText({ source: "external", createdBy: "Lee" })).toBe("a public issue, imported by Lee");
    expect(declaredText({ source: "external" })).toBe("a public issue");
  });
});
