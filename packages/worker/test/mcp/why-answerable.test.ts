import { describe, expect, it } from "vitest";
import type { Landing, LineageNote } from "@fire_trident/core";
import { whyAnswer } from "../../src/mcp/tools.ts";

/** Both MCP `why` tools (authenticated and public) name who answers for each landing, from its whole note. */

const landing: Landing = { id: "lnd_1", colonyId: "c", trunkSha: "b".repeat(40), parentSha: "c".repeat(40), proposalIds: ["p1", "p2"], intentIds: ["i1", "i2"], paths: ["src/a.ts", "src/b.ts"], regions: ["src"], at: 1 };
const change = (id: string, path: string, intent: Record<string, unknown>, decisions: unknown[] = []) => ({
  id,
  agentId: "agt_1",
  agentKind: "external",
  intent: { id: `int_${id}`, title: "t", why: "", ...intent },
  writeSet: [{ path, blob: "d".repeat(40) }],
  readSet: [],
  decisions,
  evidence: { checks: [] },
});

describe("why over MCP", () => {
  it("answers who is answerable for the whole landing, though the note is cut to the path", () => {
    const note = {
      schema: "firetrident.lineage/v1",
      landingId: "lnd_1",
      colonyId: "c",
      proposals: [change("p1", "src/a.ts", { source: "human", createdBy: "Lee" }), change("p2", "src/b.ts", { source: "agent", createdBy: "agt_9" })],
    } as unknown as LineageNote;
    const [e] = whyAnswer("src/a.ts", undefined, [{ landing, note }]).entries;
    expect(e?.note.proposals.map((p) => p.id)).toEqual(["p1"]);
    expect(e?.otherProposals).toBe(1);
    expect(e?.answerable).toMatchObject({ answer: "none", who: "none" });
    expect(e?.answerable.changes.map((c) => [c.proposalId, c.basis, c.who])).toEqual([
      ["p1", "asked", "Lee"],
      ["p2", "none", "none"],
    ]);
    expect(e?.answerable.text).toBe("1 of 2 changes: Lee asked for this intent; it landed with no review recorded. 1 of 2 changes: No person is answerable for this landing: agent agt_9 declared the intent and it landed with no review recorded.");
  });

  it("names the approver of a change a person approved, and says unknown for an old note", () => {
    const approved = { schema: "firetrident.lineage/v1", landingId: "lnd_1", colonyId: "c", proposals: [change("p1", "src/a.ts", {}, [{ kind: "triage", layer: "human", p: 1, action: "approve", by: "Matt" }])] } as unknown as LineageNote;
    expect(whyAnswer("src/a.ts", 3, [{ landing, note: approved }]).entries[0]?.answerable).toMatchObject({ answer: "person", who: "Matt", text: "Matt approved this change." });
    const old = { ...approved, proposals: [change("p1", "src/a.ts", {})] } as unknown as LineageNote;
    expect(whyAnswer("src/a.ts", undefined, [{ landing, note: old }]).entries[0]?.answerable.answer).toBe("unknown");
  });
});
