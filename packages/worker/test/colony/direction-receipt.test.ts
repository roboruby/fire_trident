import { describe, expect, it } from "vitest";
import { MAX_NOTE_DECISIONS, noteDecision, noteDecisions } from "../../src/colony/direction.ts";

/** The review receipt in a lineage note's decisions (colony/direction.ts noteDecision, decide/receipt.ts). */

const HEAD = "b".repeat(40);
const DIGEST = `sha256:${"c".repeat(64)}`;
const row = (over: Record<string, unknown>) => ({ id: "dec_1", kind: "triage", subject: "prp_1", layer: "llm", answers: "{}", p: 0.9, action: "land", at: 10, ...over });

describe("the receipt in a note's decisions", () => {
  it("carries the head each layer decided on, what it was shown, and whether a person was verified", () => {
    const llm = noteDecision(row({ answers: JSON.stringify({ head: HEAD, model: "gpt", verdict: { verdict: "approve", reason: "fine" }, shown: { view: "prompt-diff", digest: DIGEST, clipped: true, seen: "saw 20 of 22 files" } }) }));
    expect(llm).toMatchObject({ layer: "llm", by: "gpt", head: HEAD, shown: { view: "prompt-diff", digest: DIGEST, clipped: true, seen: "saw 20 of 22 files" } });
    expect(llm).not.toHaveProperty("identity");
    const human = noteDecision(
      row({ layer: "human", action: "approve", answers: JSON.stringify({ decision: "approve", reason: "", by: "dana@example.com", head: HEAD, shown: { view: "review-card", digest: DIGEST }, identity: "verified", verifiedBy: "access" }) }),
    );
    expect(human).toMatchObject({ by: "dana@example.com", head: HEAD, shown: { view: "review-card", digest: DIGEST }, identity: "verified" });
    // Only the receipt's fields reach the note: not how it was verified or the name the request stated.
    expect(human).not.toHaveProperty("verifiedBy");
    expect(human).not.toHaveProperty("stated");
  });

  it("reads a decision recorded before receipts as before, with its head", () => {
    const old = noteDecision(row({ layer: "human", action: "approve", answers: JSON.stringify({ decision: "approve", reason: "looks right", by: "matt", head: HEAD }) }));
    expect(old).toEqual({ kind: "triage", layer: "human", p: 0.9, action: "approve", at: 10, question: "human review", by: "matt", answer: "approve: looks right", head: HEAD });
  });

  it("says on the oldest kept decision how many earlier ones the cap left out, and nothing when it kept them all", () => {
    const rows = Array.from({ length: 11 }, (_, i) => row({ id: `d${i}`, at: i + 1 }));
    const out = noteDecisions([...rows, row({ id: "x", subject: "prp_2", at: 1 })]);
    expect(out.prp_1).toHaveLength(MAX_NOTE_DECISIONS);
    expect(out.prp_1![0]).toMatchObject({ at: 4, earlier: 3 });
    expect(out.prp_1!.slice(1).some((d) => "earlier" in d)).toBe(false);
    expect(out.prp_2![0]).not.toHaveProperty("earlier");
    const eight = noteDecisions(rows.slice(0, MAX_NOTE_DECISIONS));
    expect(eight.prp_1!.some((d) => "earlier" in d)).toBe(false);
  });
});
