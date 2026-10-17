import { describe, expect, it } from "vitest";
import { changeConfirmed, decidesOf, gateRecordOf, landingConfirmed, presetLabel, splitRows, splitText, valueNumber, valueText, type DecidesSplit } from "../src/decides.ts";
import type { CheckResult, GateRecord, LineageNote, NoteDecision } from "../src/types.ts";

/** How a colony decides: the rule that confirmed each landed change, read from its gate check, and the words for the colony's report. */

const GEMMA = "@cf/google/gemma-4-26b-a4b-it";
const head = (rule: string, action: string, layer: string, conf: string, reasons: string) => `${rule} → ${action} by ${layer} at head 9a7220a8f2f2 (confirmations: ${conf}): ${reasons}`;

const R3: GateRecord = {
  rule: "R3 innate+autonomy",
  preset: "production",
  values: [
    { name: "confidence", value: 0.93, op: "≥", bound: 0.85 },
    { name: "p(needs_human)", value: 0.04, op: "<", bound: 0.2 },
    { name: "approved landings", value: 20, op: "≥", bound: 20 },
  ],
};

const gateCheck = (detail: string, gate?: GateRecord, extra: Partial<CheckResult> = {}): CheckResult => ({ name: "gate", ok: true, ms: 0, detail, ...(gate ? { gate } : {}), ...extra });
const change = (checks: CheckResult[], decisions: NoteDecision[] = [], id = "prp_1") => ({
  id,
  agentId: "agt_1",
  agentKind: "internal",
  intent: { id: `int_${id}`, title: "t", why: "w" },
  writeSet: [{ path: "src/a.ts", blob: "b".repeat(40) }],
  readSet: [],
  decisions,
  evidence: { checks: [{ name: "innate: blobs", ok: true, ms: 1 }, ...checks], residual: [] },
});
const note = (proposals: unknown[], extra: Record<string, unknown> = {}): LineageNote => ({ schema: "firetrident.lineage/v1", landingId: "lnd_1", colonyId: "web", proposals, ...extra }) as unknown as LineageNote;

describe("the rule line from the gate's record", () => {
  it("names the rule and each value with the bound it met", () => {
    const c = changeConfirmed(change([gateCheck(head("R3 innate+autonomy", "land", "reflex", "innate + autonomy", "reflex clear (confidence 0.93), region has earned autonomy"), R3)]));
    expect(c).toMatchObject({ rung: "autonomy", rule: "R3", ruleName: "R3 innate+autonomy", preset: "production", recorded: true });
    expect(c.text).toBe("R3: confidence 0.93 ≥ 0.85, p(needs_human) 0.04 < 0.2, approved landings 20 ≥ 20");
  });

  it("names a person's approval, and the rule that sent the change to them", () => {
    const sent: GateRecord = { rule: "L5 too large", preset: "central-development", values: [{ name: "escalations this hour", value: 4, op: "<", bound: 30 }, { name: "risk", value: 2 }] };
    const human: NoteDecision = { kind: "triage", layer: "human", p: 1, action: "approve", by: "maya", answer: "approve" };
    const checks = [gateCheck(head("L5 too large", "escalate", "llm", "", "too large for model review"), sent)];
    expect(changeConfirmed(change(checks, [human])).text).toBe("A person (maya) approved it; L5 too large had sent it to a person (escalations this hour 4 < 30, risk 2).");
    expect(changeConfirmed(change(checks, [{ ...human, by: "api" }])).text).toMatch(/^A person approved it; L5 too large/);
    // A person approved a change no gate decided (review off).
    expect(changeConfirmed(change([], [human])).text).toBe("A person (maya) approved it.");
  });

  it("does not call a rule that sent a change to a person its confirmation when nobody approved it", () => {
    const sent: GateRecord = { rule: "P3 protected path", preset: "production", values: [{ name: "protected paths", value: 1 }] };
    const c = changeConfirmed(change([gateCheck(head("P3 protected path", "escalate", "deterministic", "", "protected paths need a person"), sent)]));
    expect(c).toMatchObject({ rung: "unreviewed", rule: "P3" });
    expect(c.text).toBe("No confirmation recorded: P3 protected path sent it to a person, and it landed without a recorded approval.");
  });

  it("says no review was recorded when there is no gate check, and ignores a gate check the agent sent", () => {
    expect(changeConfirmed(change([])).text).toBe("No review recorded: no gate decision is kept with this change.");
    const forged = changeConfirmed(change([gateCheck(head("D3 innate+proof", "land", "deterministic", "innate + deterministic", "x"), undefined, { by: "agent" })]));
    expect(forged.rung).toBe("unreviewed");
  });

  it("reads an older note's words where the gate kept no record, and says the bounds were not recorded", () => {
    const reflex: CheckResult = { name: "reflex: @cf/cloudflare/clef", ok: true, ms: 900, detail: "needs_human 0.04, touches_sensitive 0.03, off_intent 0.02, risk 0.40; confidence 0.93" };
    const r3 = changeConfirmed(change([reflex, gateCheck(head("R3 innate+autonomy", "land", "reflex", "innate + autonomy", "reflex clear (confidence 0.93), region has earned autonomy"))]));
    expect(r3).toMatchObject({ rule: "R3", recorded: false });
    expect(r3.text).toBe("R3: model clef, confidence 0.93, p(needs_human) 0.04; its bounds were not recorded (the note predates the gate's record)");
    const llm: CheckResult = { name: `llm: ${GEMMA}`, ok: true, ms: 1200, detail: "approve, needs_human 0.1: does what it says" };
    const l3 = changeConfirmed(change([llm, gateCheck(head("L3 innate+llm", "land", "llm", "innate + llm", `${GEMMA} approves: does what it says`))], [{ kind: "triage", layer: "llm", p: 0.9, action: "land", by: GEMMA }]));
    expect(l3.text).toBe("L3: model gemma-4-26b-a4b-it, p(needs_human) 0.1; its bounds were not recorded (the note predates the gate's record)");
    // A proof has no bounds: an older D3 says what it is.
    const d3 = changeConfirmed(change([gateCheck(head("D3 innate+proof", "land", "deterministic", "innate + deterministic", "deterministic proof: 1 file proven"))]));
    expect(d3.text).toBe("D3 innate+proof: a deterministic proof, no model");
  });

  it("keeps only usable values from a stored record", () => {
    expect(gateRecordOf(null)).toBeNull();
    expect(gateRecordOf({ rule: "" })).toBeNull();
    const r = gateRecordOf({
      rule: "R3 innate+autonomy",
      preset: 7,
      values: [{ name: "confidence", value: 0.9, op: "≥", bound: 0.8 }, { name: "x", value: Infinity }, { name: "", value: 1 }, { name: "risk", value: 1, op: "!=", bound: 2 }, { name: "y", value: { a: 1 } }, "z"],
    });
    expect(r).toEqual({ rule: "R3 innate+autonomy", preset: "", values: [{ name: "confidence", value: 0.9, op: "≥", bound: 0.8 }, { name: "risk", value: 1 }] });
  });

  it("writes values on one line: booleans as words, models by their last segment, small probabilities to three places", () => {
    expect(valueText({ name: "destructive change", value: false })).toBe("no destructive change");
    expect(valueText({ name: "saw every changed line", value: true })).toBe("saw every changed line");
    expect(valueText({ name: "model", value: GEMMA })).toBe("model gemma-4-26b-a4b-it");
    expect(valueText({ name: "proof", value: "line one\nline\u001b[2J two" })).toBe("proof line one line [2J two");
    expect(valueNumber(0.004)).toBe("0.004");
    expect(valueNumber(0.925)).toBe("0.93");
    expect(valueNumber(20)).toBe("20");
  });
});

describe("a landing's line", () => {
  it("is its one change's line, or each distinct line with how many changes it covers", () => {
    const r3 = change([gateCheck(head("R3 innate+autonomy", "land", "reflex", "innate + autonomy", "clear"), R3)], [], "prp_1");
    const d3: GateRecord = { rule: "D3 innate+proof", preset: "production", values: [{ name: "proof", value: "1 file proven" }] };
    const proof = (id: string) => change([gateCheck(head("D3 innate+proof", "land", "deterministic", "innate + deterministic", "proven"), d3)], [], id);
    expect(landingConfirmed(note([r3]))).toMatchObject({ kind: "autonomy", text: "R3: confidence 0.93 ≥ 0.85, p(needs_human) 0.04 < 0.2, approved landings 20 ≥ 20" });
    const mixed = landingConfirmed(note([proof("prp_2"), r3, proof("prp_3")]));
    expect(mixed.kind).toBe("mixed");
    expect(mixed.changes.map((c) => c.proposalId)).toEqual(["prp_2", "prp_1", "prp_3"]);
    expect(mixed.text).toBe("2 of 3 changes: D3: proof 1 file proven; 1 of 3 changes: R3: confidence 0.93 ≥ 0.85, p(needs_human) 0.04 < 0.2, approved landings 20 ≥ 20");
  });

  it("says a revert and FireTrident's own commits are not the gate's, and reads anything else defensively", () => {
    expect(landingConfirmed(note([], { revert: { by: "maya", of: "lnd_0" } })).text).toBe("A person (maya) reverted lnd_0: no gate decides a revert.");
    expect(landingConfirmed(note([], { system: { kind: "antibody" } }))).toMatchObject({ kind: "system", text: "FireTrident's own commit: no gate decides it." });
    expect(landingConfirmed(null)).toMatchObject({ kind: "unknown", text: "Unknown: the note lists no change." });
    expect(landingConfirmed(note(["junk", { id: 3 }])).changes).toHaveLength(1);
  });
});

describe("the colony's report", () => {
  const split = (counts: Partial<DecidesSplit["counts"]>): DecidesSplit => {
    const c = { deterministic: 0, model: 0, autonomy: 0, person: 0, unreviewed: 0, ...counts };
    return { days: 30, since: 0, total: Object.values(c).reduce((a, b) => a + b, 0), counts: c };
  };

  it("splits the landed changes into shares that add up to 100", () => {
    const rows = splitRows(split({ deterministic: 1, model: 1, autonomy: 1 }));
    expect(rows.map((r) => [r.kind, r.count, r.percent])).toEqual([
      ["deterministic", 1, 34],
      ["model", 1, 33],
      ["autonomy", 1, 33],
      ["person", 0, 0],
    ]);
    expect(splitRows(split({ person: 2, unreviewed: 1 })).map((r) => r.percent)).toEqual([0, 0, 0, 67, 33]);
    expect(splitRows(split({})).map((r) => r.percent)).toEqual([0, 0, 0, 0]);
  });

  it("says the split in one sentence", () => {
    expect(splitText(split({ deterministic: 24, model: 10, autonomy: 4, person: 2 }))).toBe(
      "Last 30 days: 40 changes landed, 24 by deterministic proof (60%), 10 by a model (25%), 4 on earned autonomy (10%), 2 by a person (5%).",
    );
    expect(splitText(split({ person: 1 }))).toBe("Last 30 days: 1 change landed, 1 by a person (100%).");
  });

  it("reads the server's report defensively, and nothing that is not one", () => {
    expect(decidesOf(null)).toBeNull();
    expect(decidesOf({ error: "no route" })).toBeNull();
    const r = decidesOf({
      colonyId: "web",
      preset: "custom",
      nearest: "production",
      differs: [{ field: "needsHuman", label: "p(needs_human) a landing stays under", value: 0.25, preset: 0.2 }, { field: "x" }],
      settings: [{ field: "confidence", label: "reflex confidence", value: 0.9 }, { field: "bad", value: "high" }],
      lets: "A deterministic proof\u0007 lands it.",
      reviewing: false,
      presets: [{ name: "production", label: "production", lets: "x", settings: [] }, { label: "nameless" }],
      split: { days: 30, since: 5, total: 999, counts: { deterministic: 2, model: -1, person: "3" } },
      at: 9,
    })!;
    expect(r).toMatchObject({ colonyId: "web", preset: "custom", nearest: "production", reviewing: false, lets: "A deterministic proof lands it.", protectedPaths: 0 });
    expect(r.differs).toHaveLength(1);
    expect(r.settings).toEqual([{ field: "confidence", label: "reflex confidence", value: 0.9 }]);
    expect(r.presets.map((p) => p.name)).toEqual(["production"]);
    // The total is the sum of the counts it could read, whatever the server said.
    expect(r.split).toEqual({ days: 30, since: 5, total: 2, counts: { deterministic: 2, model: 0, autonomy: 0, person: 0, unreviewed: 0 } });
    expect(presetLabel(r, "production")).toBe("production");
    expect(presetLabel(r, "custom")).toBe("custom");
    expect(presetLabel(r, "unknown-name")).toBe("unknown-name");
  });
});
