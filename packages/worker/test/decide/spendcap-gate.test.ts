import { describe, expect, it } from "vitest";
import { gate, type GateInput, type SecondOpinion } from "../../src/decide/gate.ts";
import { DEFAULT_POLICY } from "../../src/decide/policy.ts";
import { REVIEW_REFUSAL } from "../../src/colony/spendcap.ts";

/**
 * Rule L8 (decide/gate.ts): when the spend cap refused the second opinion's model call (colony/spendcap.ts), nothing
 * approved the change, so a person decides; the alert budget cannot send it back, and it never lands.
 */

function input(over: Partial<GateInput> = {}): GateInput {
  return {
    innate: { ok: true, failures: [] },
    damage: { sensitivePaths: [], residual: [], capabilities: [] },
    reflex: null,
    llm: null,
    autonomy: false,
    whyBy: "person",
    destructive: { hits: [], unknown: [] },
    alerts: { used: 0, max: 30 },
    detectors: {},
    policy: DEFAULT_POLICY,
    ...over,
  };
}

const APPROVE: SecondOpinion = { verdict: "approve", needsHuman: 0.05, offIntent: false, sensitive: false, confidence: 0.95, reason: "does what the intent says", model: "@cf/openai/gpt-oss-120b" };

describe("gate: a second opinion the spend cap refused", () => {
  it("L8 sends the change to a person, never to its lane", () => {
    const v = gate(input({ spendCap: REVIEW_REFUSAL }));
    expect(v).toMatchObject({ action: "escalate", layer: "llm", rule: "L8 spend cap", detectors: ["review:spend-cap"], confirmations: [] });
    expect(v.reasons[0]).toBe(REVIEW_REFUSAL);
  });

  it("is not sent back by the alert budget", () => {
    expect(gate(input({ spendCap: REVIEW_REFUSAL, alerts: { used: 30, max: 30 } }))).toMatchObject({ action: "escalate", rule: "L8 spend cap" });
  });

  it("an unavailable second opinion with no cap involved still goes back to its agent as before", () => {
    expect(gate(input())).toMatchObject({ action: "return", rule: "L4 one signal", reasons: ["second opinion unavailable; one confirmation only"] });
  });

  it("deterministic findings still come first: a change failing its checks goes back", () => {
    expect(gate(input({ spendCap: REVIEW_REFUSAL, innate: { ok: false, failures: ["2 violations left"] } }))).toMatchObject({ action: "return", rule: "L2 innate" });
  });

  it("only a second opinion that answered can land a change", () => {
    expect(gate(input({ llm: APPROVE }))).toMatchObject({ action: "land", rule: "L3 innate+llm" });
    for (const spendCap of [REVIEW_REFUSAL, undefined]) expect(gate(input({ spendCap })).action).not.toBe("land");
  });
});

describe("gate: a proof whose matching antibodies the reflex could not screen", () => {
  const PROOF = { verdict: "pass" as const, reasons: ["1 file proven comment-only (src/add.ts)"] };

  it("M2 sends it to a person, naming why the reflex was unavailable, and the alert budget cannot bounce it", () => {
    for (const alerts of [{ used: 0, max: 30 }, { used: 30, max: 30 }]) {
      const v = gate(input({ llm: undefined, mechanical: PROOF, antibodies: 2, reflexError: "the spend cap left review no room for the call", alerts }));
      expect(v).toMatchObject({ action: "escalate", layer: "reflex", rule: "M2 antibodies unscreened", detectors: ["reflex:unavailable"], confirmations: [] });
      expect(v.reasons).toEqual(["Matching antibodies could not be checked because the reflex model was unavailable (the spend cap left review no room for the call); a person decides."]);
    }
    expect(gate(input({ llm: undefined, mechanical: PROOF, antibodies: 1 })).reasons[0]).toContain("unavailable (no answer)");
  });

  it("a proof with no matching antibody still lands on the proof, and a screened one lands as before", () => {
    expect(gate(input({ llm: undefined, reflex: undefined, mechanical: PROOF, antibodies: 0 }))).toMatchObject({ action: "land", rule: "D3 innate+proof" });
    expect(gate(input({ llm: undefined, reflex: null, mechanical: PROOF, antibodies: 0 }))).toMatchObject({ action: "land", rule: "M1 innate+proof" });
    const clean = { needsHuman: 0.05, sensitive: 0.03, offIntent: 0.03, risk: 0.7, antibodies: [] };
    expect(gate(input({ llm: undefined, reflex: clean, mechanical: PROOF, antibodies: 1 }))).toMatchObject({ action: "land", rule: "M1 innate+proof" });
  });
});
