import { describe, expect, it } from "vitest";
import { ESCALATE_TEXT, buildWriteMessages, parseEscalateReply } from "../../src/agents/prompt.ts";
import { SERVER_INSTRUCTIONS, serverInstructions } from "../../src/mcp/instructions.ts";

/**
 * The norm behind the goal-conflict check: an agent whose change would undo what a recent landing did for another
 * intent escalates with contradictory-spec, naming that intent, instead of undoing it. In-platform agents read it in
 * their write prompt, external agents in the MCP server's step 9.
 */

describe("the goal-conflict norm", () => {
  it("tells an in-platform writer to escalate instead of undoing another intent's recent landing, pointing at its why", () => {
    expect(ESCALATE_TEXT).toContain("If this file would undo what a recent landing did for another intent");
    expect(ESCALATE_TEXT).toContain('the landings under "Why this code is the way it is" give each one\'s intent and why');
    expect(ESCALATE_TEXT).toContain("do not undo it: reply ESCALATE contradictory-spec: <report>, naming that intent");
    const user = buildWriteMessages({ intent: { id: "int_1", title: "Move the backend to Go", why: "The team writes Go." }, path: "src/backend.ts", content: "x\n", siblings: [], rules: [], tree: [], context: [], missing: [], written: [], nonce: "abc123" })[1]!.content;
    expect(user).toContain(ESCALATE_TEXT);
    // The reply it asks for is one the agent loop reads as an escalation.
    expect(parseEscalateReply("ESCALATE contradictory-spec: landing lnd_1 moved the backend to Rust for int_rust; this intent wants Go")).toEqual({
      kind: "contradictory-spec",
      report: "landing lnd_1 moved the backend to Rust for int_rust; this intent wants Go",
    });
  });

  it("tells every MCP client the same in step 9, with the steps still numbered 1 to 9", () => {
    for (const text of [SERVER_INSTRUCTIONS, serverInstructions(true)]) {
      const step9 = text.split("\n").find((l) => l.startsWith("9. ")) ?? "";
      expect(step9).toContain("If your change would undo what a recent landing did for another intent (take's context gives each landing's intent and why), do not undo it");
      expect(step9).toContain("call escalate with kind contradictory-spec and a report that names that intent");
      const numbers = text
        .split("\n")
        .map((l) => /^(\d+)\. /.exec(l)?.[1])
        .filter((n): n is string => n !== undefined);
      expect(numbers).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
    }
  });
});
