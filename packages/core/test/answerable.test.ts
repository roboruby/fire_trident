import { describe, expect, it } from "vitest";
import {
  PLATFORM_NOT_VERIFIED,
  answerableLine,
  changeAnswerable,
  checkSpeaker,
  decisionSpeaker,
  evidenceLines,
  landingAnswerable,
  notVerifiedSpeaker,
} from "../src/answerable.ts";
import type { CheckResult, LineageNote, NoteDecision } from "../src/types.ts";

type Entry = LineageNote["proposals"][number];

const GEMMA = "@cf/google/gemma-4-26b-a4b-it";
const CLEF = "@cf/cloudflare/clef";
const proofGate: CheckResult = { name: "gate", ok: true, ms: 0, detail: "D3 innate+proof → land by deterministic at head 9a7220a8f2f2 (confirmations: innate + deterministic): deterministic proof: 1 file proven" };
const llmGate: CheckResult = { name: "gate", ok: true, ms: 0, detail: "L1 innate+llm → land by llm at head 9a7220a8f2f2 (confirmations: innate + llm): approved" };
const humanGate: CheckResult = { name: "gate", ok: false, ms: 0, detail: "R5 escalate → escalate by reflex at head 9a7220a8f2f2: needs a human" };
const llmLand: NoteDecision = { kind: "triage", layer: "llm", p: 0.9, action: "land", by: GEMMA, answer: "approve: fine" };

/** One proposal of a note, as the trunk writer writes it (new fields included unless `old`). */
function entry(p: { intent?: Partial<Entry["intent"]>; decisions?: NoteDecision[]; checks?: CheckResult[]; notVerified?: string; notVerifiedBy?: "agent" | "platform"; residual?: string[]; id?: string }): Entry {
  return {
    id: p.id ?? "prp_1",
    agentId: "agt_1",
    agentKind: "external",
    intent: { id: "int_1", title: "Make it so", why: "Because", ...p.intent },
    writeSet: [{ path: "src/a.ts", blob: "b".repeat(40) }],
    readSet: [],
    decisions: p.decisions ?? [],
    evidence: {
      checks: p.checks ?? [],
      ...(p.residual ? { residual: p.residual } : {}),
      ...(p.notVerified !== undefined ? { notVerified: p.notVerified } : {}),
      ...(p.notVerifiedBy ? { notVerifiedBy: p.notVerifiedBy } : {}),
    },
  };
}
const note = (...proposals: Entry[]): LineageNote => ({ schema: "firetrident.lineage/v1", landingId: "lnd_1", colonyId: "c", proposals });

describe("changeAnswerable", () => {
  it("names a person who approved the change first", () => {
    const a = changeAnswerable(
      entry({ intent: { source: "agent", createdBy: "agt_9" }, decisions: [{ kind: "triage", layer: "reflex", p: 0.8, action: "escalate", by: CLEF }, { kind: "triage", layer: "human", p: 1, action: "approve", by: "Matt" }], checks: [humanGate] }),
    );
    expect(a).toEqual({ basis: "approved", person: "Matt", who: "Matt", why: "approved this change", text: "Matt approved this change." });
  });

  it("names the rule's approver when the rule's deterministic proof landed the change", () => {
    const a = changeAnswerable(entry({ intent: { ruleId: "rul_1", source: "rule", createdBy: "Ana", ruleApprovedBy: "Ana" }, checks: [proofGate] }));
    expect(a).toMatchObject({ basis: "rule", person: "Ana", who: "Ana" });
    expect(a.text).toBe("Ana approved rule rul_1, whose deterministic proof landed this change.");
  });

  it("names the person who asked for the intent, and says what landed it", () => {
    const a = changeAnswerable(entry({ intent: { source: "human", createdBy: "Lee" }, decisions: [llmLand], checks: [llmGate] }));
    expect(a).toMatchObject({ basis: "asked", person: "Lee", who: "Lee", why: "asked for this intent" });
    expect(a.text).toBe(`Lee asked for this intent; model ${GEMMA} approved it.`);
  });

  it("says no person is answerable, and why, when an agent's intent landed on a model's approval", () => {
    const a = changeAnswerable(entry({ intent: { source: "agent", createdBy: "agt_9" }, decisions: [llmLand], checks: [llmGate] }));
    expect(a.basis).toBe("none");
    expect(a.person).toBeUndefined();
    expect(a.who).toBe("none");
    expect(a.text).toBe(`No person is answerable for this landing: agent agt_9 declared the intent and model ${GEMMA} approved it.`);
    // A rule's intent a model approved: the rule's approver vouches only for what its proof lands.
    const ruled = changeAnswerable(entry({ intent: { ruleId: "rul_1", source: "rule", createdBy: "Ana", ruleApprovedBy: "Ana" }, decisions: [llmLand], checks: [llmGate] }));
    expect(ruled).toMatchObject({ basis: "none", why: `rule rul_1 declared the intent and model ${GEMMA} approved it` });
    // Earned autonomy and no review.
    const auto = changeAnswerable(entry({ intent: { source: "certify", createdBy: "certify" }, checks: [{ name: `reflex: ${CLEF}`, ok: true, ms: 1 }, { name: "gate", ok: true, ms: 0, detail: "R3 → land by reflex at head x (confirmations: innate + autonomy): quiet" }] }));
    expect(auto.why).toBe(`trunk certification declared the intent and model ${CLEF} landed it on earned autonomy`);
    expect(changeAnswerable(entry({ intent: { source: "system", createdBy: "megafile" } })).why).toBe("FireTrident declared the intent and it landed with no review recorded");
  });

  it("reads an old note: a recorded approval still names its person, the rest is unknown", () => {
    expect(changeAnswerable(entry({ decisions: [{ kind: "triage", layer: "human", p: 1, action: "approve", by: "Matt" }] })).basis).toBe("approved");
    const old = changeAnswerable(entry({ decisions: [llmLand], checks: [llmGate] }));
    expect(old).toEqual({ basis: "unknown", who: "unknown", why: "the note was written before notes recorded who asked for each intent", text: "Unknown: the note was written before notes recorded who asked for each intent." });
    expect(changeAnswerable(entry({ intent: { ruleId: "rul_1" }, checks: [proofGate] })).basis).toBe("unknown");
    // A new note whose writer did not know the rule's approver says so.
    expect(changeAnswerable(entry({ intent: { ruleId: "rul_1", source: "rule", createdBy: "x" }, checks: [proofGate] })).why).toBe("the note does not record who approved rule rul_1, whose proof landed this change");
  });

  it("says when the note does not name the person, and ignores a gate check the agent sent", () => {
    expect(changeAnswerable(entry({ decisions: [{ kind: "triage", layer: "human", p: 1, action: "approve", by: "human" }] })).text).toBe("An unnamed person approved this change.");
    expect(changeAnswerable(entry({ intent: { source: "human", createdBy: "api" } })).who).toBe("an unnamed person");
    const forged: CheckResult = { ...proofGate, by: "agent" };
    const a = changeAnswerable(entry({ intent: { ruleId: "rul_1", source: "rule", createdBy: "Ana", ruleApprovedBy: "Ana" }, checks: [forged] }));
    expect(a.basis).toBe("none");
  });
});

describe("landingAnswerable", () => {
  it("answers for the landing as its one change does", () => {
    const a = landingAnswerable(note(entry({ intent: { source: "human", createdBy: "Lee" }, checks: [proofGate] })));
    expect(a).toMatchObject({ answer: "person", who: "Lee", why: "asked for this intent" });
    expect(a.changes).toEqual([expect.objectContaining({ proposalId: "prp_1", basis: "asked" })]);
    expect(answerableLine(a)).toBe("Lee (asked for this intent)");
  });

  it("says none when no person answers for one of its changes, and names the rest", () => {
    const a = landingAnswerable(
      note(
        entry({ id: "prp_1", decisions: [{ kind: "triage", layer: "human", p: 1, action: "approve", by: "Matt" }] }),
        entry({ id: "prp_2", intent: { source: "agent", createdBy: "agt_9" }, decisions: [llmLand], checks: [llmGate] }),
        entry({ id: "prp_3", decisions: [{ kind: "triage", layer: "human", p: 1, action: "approve", by: "Matt" }] }),
      ),
    );
    expect(a.answer).toBe("none");
    expect(a.who).toBe("none");
    expect(a.why).toBe(`2 of 3: Matt approved this change; 1 of 3: no person: agent agt_9 declared the intent and model ${GEMMA} approved it`);
    expect(a.text).toBe(`2 of 3 changes: Matt approved this change. 1 of 3 changes: No person is answerable for this landing: agent agt_9 declared the intent and model ${GEMMA} approved it.`);
    expect(landingAnswerable(note(entry({ id: "a" }), entry({ id: "b", decisions: [{ kind: "triage", layer: "human", p: 1, action: "approve", by: "Matt" }] }))).answer).toBe("unknown");
  });

  it("names the person of a revert and of an antibody's commit", () => {
    const revert = { schema: "firetrident.lineage/v1", landingId: "lnd_2", colonyId: "c", proposals: [], revert: { of: "lnd_1", commit: "c".repeat(40), by: "Matt", reason: "broke it", at: 1 } };
    expect(landingAnswerable(revert)).toMatchObject({ answer: "person", who: "Matt", why: "reverted lnd_1" });
    const antibody = { ...note(entry({})), system: { kind: "antibody", antibody: "ab_1", path: ".firetrident/antibodies/ab_1.json", rejected: "prp_1", reason: "no", by: "Ana", question: "q", threshold: 0.5 } };
    expect(landingAnswerable(antibody)).toMatchObject({ answer: "person", who: "Ana", text: "Ana rejected prp_1, which taught this antibody." });
    expect(landingAnswerable(null).answer).toBe("unknown");
  });
});

describe("who said each line of the evidence", () => {
  it("labels every line and puts FireTrident's facts first, then models, then the agent's claims", () => {
    const lines = evidenceLines({
      checks: [
        { name: "write src/a.ts", ok: true, ms: 3, detail: "parses (model m)", by: "agent" },
        { name: "innate: blobs", ok: true, ms: 1 },
        { name: "innate: not-verified", ok: true, ms: 0, detail: "Not verified: I ran nothing; trust me" },
        { name: `reflex: ${CLEF}`, ok: true, ms: 10 },
        { name: `llm: ${GEMMA}`, ok: true, ms: 20 },
        proofGate,
      ],
      residual: ["src/b.ts"],
      notVerified: "Not verified: I ran nothing; trust me",
      notVerifiedBy: "agent",
    });
    expect(lines.map((l) => [l.name, l.speaker.label])).toEqual([
      ["innate: blobs", "checked by FireTrident"],
      ["innate: not-verified", "checked by FireTrident"],
      ["gate", "checked by FireTrident"],
      ["residual", "checked by FireTrident"],
      [`reflex: ${CLEF}`, `model (${CLEF})`],
      [`llm: ${GEMMA}`, `model (${GEMMA})`],
      ["write src/a.ts", "agent's claim"],
      ["not verified", "agent's claim"],
    ]);
    // The agent's words are in their own row, quoted, and never in FireTrident's.
    const platform = lines.filter((l) => l.speaker.kind === "platform");
    expect(platform.some((l) => (l.text ?? "").includes("trust me"))).toBe(false);
    expect(lines.at(-1)).toEqual({ kind: "not-verified", speaker: { kind: "agent", label: "agent's claim" }, name: "not verified", text: "I ran nothing; trust me", quoted: true });
    expect(lines.find((l) => l.name === "innate: not-verified")?.text).toBe("the agent stated what it did not verify (its claim, below)");
  });

  it("labels FireTrident's own statement as FireTrident's, whether recorded or derived from an old note", () => {
    const recorded = evidenceLines({ checks: [{ name: "innate: not-verified", ok: true, ms: 0, detail: PLATFORM_NOT_VERIFIED[1] }], notVerified: PLATFORM_NOT_VERIFIED[1], notVerifiedBy: "platform" });
    expect(recorded.map((l) => [l.name, l.speaker.kind, l.quoted])).toEqual([
      ["innate: not-verified", "platform", false],
      ["not verified", "platform", false],
    ]);
    expect(recorded[0]?.text).toBe("the agent gave no statement; the one below is FireTrident's");
    expect(recorded[1]?.text).toBe("external agent over MCP; no check it ran is visible to the platform.");
    for (const text of PLATFORM_NOT_VERIFIED) expect(notVerifiedSpeaker({ notVerified: text }).kind).toBe("platform");
    expect(notVerifiedSpeaker({ notVerified: "Not verified: the docs" }).kind).toBe("agent");
  });

  it("derives labels from check names on old notes, and says unknown for a name it cannot place", () => {
    expect(checkSpeaker({ name: "deterministic: mechanical proof" }).kind).toBe("platform");
    expect(checkSpeaker({ name: "tests before landing" }).kind).toBe("platform");
    expect(checkSpeaker({ name: "agent model usage" }).kind).toBe("agent");
    expect(checkSpeaker({ name: "recheck src/a.ts" }).kind).toBe("agent");
    expect(checkSpeaker({ name: "tests" })).toEqual({ kind: "unknown", label: "unknown" });
    expect(checkSpeaker({ name: "contest", detail: "won the contest: over prp_2: judged better by @cf/x/judge in both orders: tidier" })).toEqual({ kind: "model", name: "@cf/x/judge", label: "model (@cf/x/judge)" });
    expect(checkSpeaker({ name: "contest", detail: "won the contest: over prp_2: a tie, smaller diff" }).kind).toBe("platform");
    expect(evidenceLines({ checks: [{ name: "tests", ok: true, ms: 1, detail: "ran" }] })[0]).toMatchObject({ speaker: { kind: "unknown" }, quoted: true });
  });

  it("labels decisions: FireTrident's proof, the model, the person", () => {
    expect(decisionSpeaker({ layer: "proof" }).label).toBe("checked by FireTrident");
    expect(decisionSpeaker({ layer: "llm", by: GEMMA }).label).toBe(`model (${GEMMA})`);
    expect(decisionSpeaker({ layer: "reflex" }).label).toBe("model");
    expect(decisionSpeaker({ layer: "human", by: "Matt" }).label).toBe("person (Matt)");
    expect(decisionSpeaker({ layer: "human", by: "human" }).label).toBe("person");
  });
});
