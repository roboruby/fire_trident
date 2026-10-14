import { describe, expect, it } from "vitest";
import type { NoteAcceptance } from "@fire_trident/core";
import { agentReason, gate, type GateInput, type ReflexSignals, type SecondOpinion } from "../../src/decide/gate.ts";
import { DEFAULT_POLICY } from "../../src/decide/policy.ts";

/** The gate after a second opinion, with quoted acceptance (FT_QUOTED_ACCEPTANCE): rules L6 and L7 beside L3 and L5. */

const CLEAN: ReflexSignals = { needsHuman: 0.05, sensitive: 0.03, offIntent: 0.03, risk: 0.7, antibodies: [] };

function input(over: Partial<GateInput> = {}): GateInput {
  return {
    innate: { ok: true, failures: [] },
    damage: { sensitivePaths: [], residual: [], capabilities: [] },
    reflex: CLEAN,
    autonomy: false,
    whyBy: "person",
    alerts: { used: 0, max: 30 },
    detectors: {},
    policy: DEFAULT_POLICY,
    ...over,
  };
}

function opinion(over: Partial<SecondOpinion> = {}): SecondOpinion {
  return { verdict: "approve", needsHuman: 0.05, offIntent: false, sensitive: false, confidence: 0.9, reason: "does what the intent says", model: "@cf/google/gemma-4-26b-a4b-it", ...over };
}

const MET_1: NoteAcceptance = { kind: "intent", line: "slugify lowercases its input", verdict: "met", path: "src/slug.ts", quote: "const lower = text.toLowerCase();" };
const MET_2: NoteAcceptance = { kind: "intent", line: "slugify replaces each run of spaces with one hyphen", verdict: "met", path: "src/slug.ts", quote: 'return lower.replace(/ +/g, "-");' };

describe("an approval counts only when every acceptance line is met with a valid quote", () => {
  it("all lines met with quotes found: it lands on two confirmations, saying so", () => {
    const v = gate(input({ llm: opinion(), acceptance: [MET_1, MET_2] }));
    expect(v).toMatchObject({ action: "land", layer: "llm", rule: "L3 innate+llm", confirmations: ["innate", "llm"] });
    expect(v.reasons).toEqual(["@cf/google/gemma-4-26b-a4b-it approves: does what the intent says", "every acceptance line is met, each with a quote found in the diff (2 lines)"]);
  });

  it("one line unclear (a quote the platform could not find): a person decides, and the alert budget cannot bounce it", () => {
    const unclear: NoteAcceptance = { ...MET_2, verdict: "unclear", said: "met", problem: "its quote is not in the added or unchanged lines of src/slug.ts it was shown" };
    const v = gate(input({ llm: opinion(), acceptance: [MET_1, unclear] }));
    expect(v).toMatchObject({ action: "escalate", layer: "llm", rule: "L7 acceptance unclear", detectors: ["acceptance:unclear"] });
    expect(v.reasons[0]).toBe(
      'acceptance not shown met: line 2 "slugify replaces each run of spaces with one hyphen" (its quote is not in the added or unchanged lines of src/slug.ts it was shown); the second opinion\'s approval does not count, so a person decides',
    );
    // Over the hourly budget it still reaches a person: sending it back would not make the quote appear.
    expect(gate(input({ llm: opinion(), acceptance: [MET_1, unclear], alerts: { used: 30, max: 30 } })).action).toBe("escalate");
  });

  it("a line the model answered unclear itself goes to a person too", () => {
    const v = gate(input({ llm: opinion(), acceptance: [MET_1, { ...MET_2, verdict: "unclear", path: undefined, quote: undefined }] }));
    expect(v).toMatchObject({ action: "escalate", rule: "L7 acceptance unclear" });
    expect(v.reasons[0]).toContain("(the second opinion answered unclear)");
  });

  it("one line not met: the change goes back to its agent naming that line, even though the model approved", () => {
    const v = gate(input({ llm: opinion(), acceptance: [MET_1, { ...MET_2, verdict: "not met", path: undefined, quote: undefined }] }));
    expect(v).toMatchObject({ action: "return", layer: "llm", rule: "L6 acceptance not met", detectors: ["acceptance:not-met"] });
    expect(agentReason(v)).toBe(
      'llm: acceptance not met: line 2 "slugify replaces each run of spaces with one hyphen"; change it so it meets that line, or escalate if the intent cannot be met as written; @cf/google/gemma-4-26b-a4b-it approves otherwise: does what the intent says',
    );
  });

  it("not met outranks unclear", () => {
    const v = gate(input({ llm: opinion(), acceptance: [{ ...MET_1, verdict: "unclear" }, { ...MET_2, verdict: "not met" }] }));
    expect(v.rule).toBe("L6 acceptance not met");
  });
});

describe("keep lines: what the newest landing by another intent met on these files", () => {
  const keep = (verdict: NoteAcceptance["verdict"]): NoteAcceptance => ({ kind: "keep", line: "Returns 404 for an unknown slug", verdict, landingId: "lnd_42" });

  it("a keep line not met sends the change back naming it", () => {
    const v = gate(input({ llm: opinion(), acceptance: [MET_1, keep("not met")] }));
    expect(v).toMatchObject({ action: "return", rule: "L6 acceptance not met" });
    expect(v.reasons[0]).toBe(
      'it breaks what a recent landing by another intent met: keep line 1 "Returns 404 for an unknown slug" (from landing lnd_42); keep what that landing did unless your intent says otherwise, and escalate if both cannot hold',
    );
  });

  it("a keep line met or unclear changes nothing", () => {
    for (const verdict of ["met", "unclear"] as const) expect(gate(input({ llm: opinion(), acceptance: [MET_1, keep(verdict)] }))).toMatchObject({ action: "land", rule: "L3 innate+llm" });
  });
});

describe("the other rules stand", () => {
  it("without acceptance lines (no list, or the flag off) the verdict is exactly today's", () => {
    for (const llm of [opinion(), opinion({ verdict: "return", reason: "wrong" }), opinion({ needsHuman: 0.9 }), null]) {
      expect(gate(input({ llm, acceptance: undefined }))).toEqual(gate(input({ llm })));
      expect(gate(input({ llm, acceptance: [] }))).toEqual(gate(input({ llm })));
    }
  });

  it("a view that was cut still goes to a person first (L5): the model may not have seen the meeting line", () => {
    const v = gate(input({ llm: opinion(), coverage: { llm: { complete: false, seen: "the second opinion saw 1 of 2 files" } }, acceptance: [MET_1, { ...MET_2, verdict: "not met" }] }));
    expect(v.rule).toBe("L5 too large");
  });

  it("a model that returns the change names the lines it found not met", () => {
    const v = gate(input({ llm: opinion({ verdict: "return", reason: "spaces are kept" }), acceptance: [MET_1, { ...MET_2, verdict: "not met" }] }));
    expect(v).toMatchObject({ action: "return", rule: "L4 one signal" });
    expect(v.reasons).toEqual(["@cf/google/gemma-4-26b-a4b-it: return (spaces are kept)", expect.stringContaining('acceptance not met: line 2 "slugify replaces each run of spaces with one hyphen"')]);
  });

  it("an unavailable second opinion defers as today, whatever the lines say", () => {
    const v = gate(input({ llm: null, acceptance: [{ ...MET_1, verdict: "not met" }] }));
    expect(v).toMatchObject({ action: "return", rule: "L4 one signal", reasons: ["second opinion unavailable; one confirmation only"] });
  });

  it("failing innate checks go back first", () => {
    expect(gate(input({ llm: opinion(), innate: { ok: false, failures: ["missing Not verified"] }, acceptance: [MET_1, MET_2] })).rule).toBe("L2 innate");
  });
});
