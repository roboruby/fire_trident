import { describe, expect, it } from "vitest";
import { PLATFORM_NOT_VERIFIED, type LineageNote } from "@fire_trident/core";
import { DEFAULT_NOT_VERIFIED } from "../../src/colony/logic.ts";
import { EXTERNAL_NOT_VERIFIED } from "../../src/mcp/tools.ts";
import { maskNote } from "../../src/trunk/mask.ts";
import { ANSWERABLE_COUNTERS, agentClaims, answerableBumps, answerableMeter, intentWho, landingAnswer, noteIntentWho } from "../../src/trunk/answerable.ts";

/** The worker's side of who answers for a landing: what the land context and the note carry, and the colony's meter. */

describe("who declared the intent, in the land context and the note", () => {
  it("carries source and creator, and a rule's approver only for a rule's intent", () => {
    const approver = (id: string) => (id === "rul_1" ? "Ana" : null);
    expect(intentWho({ source: "rule", createdBy: "Ana", ruleId: "rul_1" }, approver)).toEqual({ source: "rule", createdBy: "Ana", ruleApprovedBy: "Ana" });
    expect(intentWho({ source: "rule", createdBy: "Ana", ruleId: "rul_gone" }, approver)).toEqual({ source: "rule", createdBy: "Ana" });
    expect(intentWho({ source: "human", createdBy: "Lee" }, approver)).toEqual({ source: "human", createdBy: "Lee" });
    expect(noteIntentWho({ source: "human", createdBy: "  Lee \n Doe ", ruleApprovedBy: "Ana" })).toEqual({ source: "human", createdBy: "Lee Doe" });
    expect(noteIntentWho({ source: "rule", createdBy: "x".repeat(300), ruleId: "rul_1", ruleApprovedBy: "Ana" })).toEqual({ source: "rule", createdBy: "x".repeat(200), ruleApprovedBy: "Ana" });
    // An unknown source, or none at all (an older colony's context): left out, so the note reads as unknown.
    expect(noteIntentWho({ source: "forged" as never })).toEqual({});
    expect(noteIntentWho(undefined)).toEqual({});
  });

  it("masks a secret-looking name like any free text of a note", () => {
    const note: LineageNote = {
      schema: "firetrident.lineage/v1",
      landingId: "lnd_1",
      colonyId: "c",
      proposals: [
        { id: "p", agentId: "a", agentKind: "external", intent: { id: "i", title: "t", why: "w", source: "human", createdBy: "api_key=sk_live_51HabcdefghijklmnopqrstuvWXYZ" }, writeSet: [], readSet: [], decisions: [], evidence: { checks: [] } },
      ],
    };
    expect(maskNote(note).proposals[0]?.intent.createdBy).toBe("[masked]");
    expect(maskNote(note).proposals[0]?.intent.source).toBe("human");
  });
});

describe("the checks and statement an agent sends", () => {
  it("marks each check as the agent's claim", () => {
    expect(agentClaims([{ name: "gate", ok: true, ms: 0, detail: "→ land by deterministic" }])).toEqual([{ name: "gate", ok: true, ms: 0, detail: "→ land by deterministic", by: "agent" }]);
    expect(agentClaims(undefined)).toEqual([]);
  });

  it("knows FireTrident's own statements exactly as the colony and the MCP server write them", () => {
    expect(PLATFORM_NOT_VERIFIED).toEqual([DEFAULT_NOT_VERIFIED, EXTERNAL_NOT_VERIFIED]);
  });
});

describe("the meter", () => {
  it("counts landings that carry an answer, and those no person answers for", () => {
    expect(answerableBumps({ answerable: "person" })).toEqual([[ANSWERABLE_COUNTERS.landings, 1]]);
    expect(answerableBumps({ answerable: "none" })).toEqual([[ANSWERABLE_COUNTERS.landings, 1], [ANSWERABLE_COUNTERS.none, 1]]);
    expect(answerableBumps({ answerable: "unknown" })).toEqual([[ANSWERABLE_COUNTERS.landings, 1], [ANSWERABLE_COUNTERS.unknown, 1]]);
    // A landing recorded before landings carried an answer is not counted.
    expect(answerableBumps({})).toEqual([]);
    expect(answerableMeter({})).toEqual({ landings: 0, none: 0, unknown: 0, share: null });
    expect(answerableMeter({ "answerable.landings": 3, "answerable.none": 1, "answerable.unknown": 1 })).toEqual({ landings: 3, none: 1, unknown: 1, share: 0.3333 });
  });

  it("takes a landing's answer from its note", () => {
    const base = { id: "p", agentId: "a", agentKind: "external" as const, writeSet: [], readSet: [], evidence: { checks: [] } };
    const note = (intent: LineageNote["proposals"][number]["intent"], decisions: LineageNote["proposals"][number]["decisions"] = []): LineageNote => ({
      schema: "firetrident.lineage/v1",
      landingId: "lnd_1",
      colonyId: "c",
      proposals: [{ ...base, intent, decisions }],
    });
    expect(landingAnswer(note({ id: "i", title: "t", why: "", source: "human", createdBy: "Lee" }))).toBe("person");
    expect(landingAnswer(note({ id: "i", title: "t", why: "", source: "agent", createdBy: "agt_1" }))).toBe("none");
    expect(landingAnswer(note({ id: "i", title: "t", why: "" }))).toBe("unknown");
    expect(landingAnswer(note({ id: "i", title: "t", why: "", source: "agent", createdBy: "agt_1" }, [{ kind: "triage", layer: "human", p: 1, action: "approve", by: "Matt" }]))).toBe("person");
  });
});
