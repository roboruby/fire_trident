import { describe, expect, it } from "vitest";
import { gate, type GateInput } from "../../src/decide/gate.ts";
import { DEFAULT_POLICY } from "../../src/decide/policy.ts";
import { parseVerdict } from "../../src/decide/reflex.ts";

/**
 * A second opinion that leaves out needs_human, or gives one that is not a number, reads as 1 (a person must look), as a
 * missing Clef probability does: its approval never lands on its own.
 */

const APPROVE = { verdict: "approve", off_intent: false, sensitive: false, confidence: 0.95, reason: "does what the intent says" };

function input(llm: GateInput["llm"]): GateInput {
  return {
    innate: { ok: true, failures: [] },
    damage: { sensitivePaths: [], residual: [], capabilities: [] },
    reflex: { needsHuman: 0.05, sensitive: 0.03, offIntent: 0.03, risk: 0.7, antibodies: [] },
    autonomy: false,
    whyBy: "person",
    destructive: { hits: [], unknown: [] },
    alerts: { used: 0, max: 30 },
    detectors: {},
    policy: DEFAULT_POLICY,
    ...(llm ? { llm } : {}),
  };
}

describe("a second opinion without needs_human", () => {
  it("reads a missing, null, string or non-finite value as 1, and keeps a number in [0, 1]", () => {
    const read = (extra: Record<string, unknown>, verdict = "approve") => parseVerdict(JSON.stringify({ ...APPROVE, verdict, ...extra }), "m")?.needsHuman;
    expect(read({})).toBe(1);
    expect(read({ needs_human: null })).toBe(1);
    expect(read({ needs_human: "0.05" })).toBe(1);
    expect(parseVerdict('{"verdict":"approve","needs_human":1e999,"reason":"ok"}', "m")?.needsHuman).toBe(1);
    expect(read({}, "return")).toBe(1);
    expect(read({}, "escalate")).toBe(1);
    expect(read({ needs_human: 0.05 })).toBe(0.05);
    expect(read({ needs_human: -2 })).toBe(0);
    expect(read({ needs_human: 7 })).toBe(1);
  });

  it("never lands: the approval goes back as one signal, naming the probability", () => {
    const missing = parseVerdict(JSON.stringify(APPROVE), "m");
    const v = gate(input(missing!));
    expect(v).toMatchObject({ action: "return", rule: "L4 one signal" });
    expect(v.reasons.join(" ")).toContain("p(needs_human) 1");
    // The same approval with a low probability lands, so the missing field alone keeps it back.
    expect(gate(input(parseVerdict(JSON.stringify({ ...APPROVE, needs_human: 0.05 }), "m")!))).toMatchObject({ action: "land", rule: "L3 innate+llm" });
  });
});
