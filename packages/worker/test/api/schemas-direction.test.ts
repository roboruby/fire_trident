import { describe, expect, it } from "vitest";
import { AmendIntentBody, DirectiveBody, EscalationBody, ProposalBody, StatusBody, WithdrawBody } from "../../src/api/schemas.ts";

describe("changing-direction request bodies", () => {
  it("amends need a reason and at least one field", () => {
    expect(AmendIntentBody.parse({ why: "say bonjour", reason: " French UI ", by: "matt" })).toEqual({ why: "say bonjour", reason: "French UI", by: "matt" });
    expect(AmendIntentBody.parse({ footprint: ["src/a.ts"], priority: 3, reason: "move it" })).toEqual({ footprint: ["src/a.ts"], priority: 3, reason: "move it" });
    expect(AmendIntentBody.safeParse({ reason: "nothing" }).success).toBe(false);
    expect(AmendIntentBody.safeParse({ why: "x" }).success).toBe(false);
    expect(AmendIntentBody.safeParse({ why: "x", reason: "   " }).success).toBe(false);
    expect(AmendIntentBody.safeParse({ footprint: [], reason: "x" }).success).toBe(false);
    expect(AmendIntentBody.safeParse({ title: "", reason: "x" }).success).toBe(false);
    expect(AmendIntentBody.safeParse({ priority: -1, reason: "x" }).success).toBe(false);
  });

  it("withdrawals and retractions need a reason", () => {
    expect(WithdrawBody.parse({ reason: "not needed" })).toEqual({ reason: "not needed" });
    expect(WithdrawBody.safeParse({}).success).toBe(false);
    expect(WithdrawBody.safeParse({ reason: "x".repeat(501) }).success).toBe(false);
  });

  it("directives carry a message of at most 2000 characters, and status notes a non-empty note", () => {
    expect(DirectiveBody.parse({ message: " use the logger ", intentId: "int_1" })).toEqual({ message: "use the logger", intentId: "int_1" });
    expect(DirectiveBody.safeParse({ message: "" }).success).toBe(false);
    expect(DirectiveBody.safeParse({ message: "x".repeat(2_001) }).success).toBe(false);
    expect(StatusBody.parse({ note: " writing a.ts " })).toEqual({ note: "writing a.ts" });
    expect(StatusBody.safeParse({ note: "  " }).success).toBe(false);
  });

  it("proposals may name the intent revision they were built on", () => {
    const base = {
      intentId: "int_1",
      agentId: "agt_1",
      workspace: { namespace: "ft-ws-0", name: "c--ws-0", remote: "https://x" },
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      writeSet: [{ path: "a.ts", blob: "c".repeat(40) }],
    };
    expect(ProposalBody.parse({ ...base, intentRevision: 2 }).intentRevision).toBe(2);
    expect(ProposalBody.parse(base).intentRevision).toBeUndefined();
    expect(ProposalBody.safeParse({ ...base, intentRevision: 0 }).success).toBe(false);
    expect(ProposalBody.safeParse({ ...base, intentRevision: 1.5 }).success).toBe(false);
  });
});

describe("answering an agent's report", () => {
  it("needs a decision and a note, and amend needs something to change", () => {
    expect(EscalationBody.parse({ decision: "dismiss", note: " the test is right ", by: "matt" })).toEqual({ decision: "dismiss", note: "the test is right", by: "matt" });
    expect(EscalationBody.parse({ decision: "amend", note: "spec changed", amend: { why: "Return 404", footprint: ["src/a.ts"] } })).toEqual({
      decision: "amend",
      note: "spec changed",
      amend: { why: "Return 404", footprint: ["src/a.ts"] },
    });
    expect(EscalationBody.parse({ decision: "withdraw", note: "not needed" })).toEqual({ decision: "withdraw", note: "not needed" });
    expect(EscalationBody.safeParse({ decision: "amend", note: "x" }).success).toBe(false);
    expect(EscalationBody.safeParse({ decision: "amend", note: "x", amend: {} }).success).toBe(false);
    expect(EscalationBody.safeParse({ decision: "amend", note: "x", amend: { title: " " } }).success).toBe(false);
    expect(EscalationBody.safeParse({ decision: "approve", note: "x" }).success).toBe(false);
    expect(EscalationBody.safeParse({ decision: "dismiss", note: "  " }).success).toBe(false);
    expect(EscalationBody.safeParse({ decision: "dismiss" }).success).toBe(false);
  });
});
