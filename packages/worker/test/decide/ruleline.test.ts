import { describe, expect, it } from "vitest";
import { changeConfirmed, type CheckResult } from "@fire_trident/core";
import { gate, type GateInput, type GateVerdict, type ReflexSignals, type SecondOpinion } from "../../src/decide/gate.ts";
import { DEFAULT_POLICY, mergePolicy, type DecidePolicy } from "../../src/decide/policy.ts";
import { presetPolicy } from "../../src/decide/presets.ts";
import { gateRecord } from "../../src/decide/ruleline.ts";
import type { DamageSignals } from "../../src/decide/signals.ts";

/**
 * The gate check's record (decide/ruleline.ts): the values the deciding rule compared, each with the policy bound it met,
 * and the preset then; core/decides.ts turns it into the line every landing card shows.
 */

const NONE: DamageSignals = { sensitivePaths: [], residual: [], capabilities: [] };
const CLEAR: ReflexSignals = { needsHuman: 0.04, sensitive: 0.03, offIntent: 0.035, risk: 0.4, antibodies: [] };
const PROOF = { verdict: "pass" as const, reasons: ["1 file proven: only import specifiers changed, each still resolving to the same file", "inside the footprint", "no sensitive path"] };

function input(policy: DecidePolicy, over: Partial<GateInput> = {}): GateInput {
  return {
    innate: { ok: true, failures: [] },
    damage: NONE,
    autonomy: false,
    whyBy: "person",
    destructive: { hits: [], unknown: [] },
    alerts: { used: 0, max: 30 },
    detectors: {},
    policy,
    ...over,
  };
}

function opinion(over: Partial<SecondOpinion> = {}): SecondOpinion {
  return { verdict: "approve", needsHuman: 0.1, offIntent: false, sensitive: false, confidence: 0.9, reason: "does what the intent says", model: "@cf/google/gemma-4-26b-a4b-it", ...over };
}

/** The gate check as the engine writes it, inside a lineage note's proposal entry, with any recorded decisions. */
function entry(v: GateVerdict, gi: GateInput, policy: DecidePolicy, decisions: unknown[] = [], approvals = 0): Record<string, unknown> {
  const check: CheckResult = {
    name: "gate",
    ok: v.action === "land",
    ms: 0,
    detail: `${v.rule} → ${v.action} by ${v.layer} at head 0123456789ab${v.confirmations.length > 0 ? ` (confirmations: ${v.confirmations.join(" + ")})` : ""}: ${v.reasons.join("; ")}`,
    gate: gateRecord(v, { input: gi, policy, approvals: () => approvals }),
  };
  return { id: "prp_1", decisions, evidence: { checks: [{ name: "innate: blobs", ok: true, ms: 1 }, check], residual: [] } };
}

describe("the rule line from the gate's record", () => {
  it("R3 names the reflex's confidence, its p(needs_human) and the approved landings, each against the policy", () => {
    const policy = mergePolicy(presetPolicy("production"), { confidence: 0.85 });
    const gi = input(policy, { reflex: { ...CLEAR, needsHuman: 0.04, sensitive: 0.035, offIntent: 0.03 }, autonomy: true });
    const v = gate(gi);
    expect(v.rule).toBe("R3 innate+autonomy");
    let asked = 0;
    const record = gateRecord(v, { input: gi, policy, approvals: () => ++asked && 23 });
    expect(asked).toBe(1);
    expect(record).toEqual({
      rule: "R3 innate+autonomy",
      preset: "custom",
      values: [
        { name: "model", value: "@cf/cloudflare/clef" },
        { name: "confidence", value: 0.92, op: "≥", bound: 0.85 },
        { name: "p(needs_human)", value: 0.04, op: "<", bound: 0.2 },
        { name: "approved landings", value: 23, op: "≥", bound: 20 },
        { name: "intent by", value: "a person" },
      ],
    });
    const c = changeConfirmed(entry(v, gi, policy, [], 23));
    expect(c).toMatchObject({ rung: "autonomy", rule: "R3", ruleName: "R3 innate+autonomy", preset: "custom", recorded: true });
    expect(c.text).toBe("R3: model clef, confidence 0.92 ≥ 0.85, p(needs_human) 0.04 < 0.2, approved landings 23 ≥ 20, intent by a person");
  });

  it("L3 names the second opinion's model, its p(needs_human) against the bound, and that it saw every changed line", () => {
    const policy = presetPolicy("central-development");
    const gi = input(policy, { reflex: { ...CLEAR, needsHuman: 0.3 }, llm: opinion() });
    const v = gate(gi);
    expect(v.rule).toBe("L3 innate+llm");
    const c = changeConfirmed(entry(v, gi, policy, [{ kind: "triage", layer: "llm", p: 0.9, action: "land", by: "@cf/google/gemma-4-26b-a4b-it" }]));
    expect(c).toMatchObject({ rung: "model", by: "@cf/google/gemma-4-26b-a4b-it", preset: "central-development" });
    expect(c.text).toBe("L3: model gemma-4-26b-a4b-it, p(needs_human) 0.1 < 0.5, model confidence 0.9, saw every changed line");
  });

  it("D3 names the proof's first clause, no antibody to screen and nothing destructive; it never asks for approvals", () => {
    const policy = DEFAULT_POLICY;
    const gi = input(policy, { mechanical: PROOF, antibodies: 0 });
    const v = gate(gi);
    expect(v.rule).toBe("D3 innate+proof");
    const record = gateRecord(v, {
      input: gi,
      policy,
      approvals: () => {
        throw new Error("D3 needs no approvals");
      },
    });
    expect(record.values).toEqual([
      { name: "proof", value: "1 file proven: only import specifiers changed, each still resolving to the same file" },
      { name: "antibodies to screen", value: 0 },
      { name: "destructive change", value: false },
    ]);
    expect(changeConfirmed(entry(v, gi, policy)).text).toBe(
      "D3: proof 1 file proven: only import specifiers changed, each still resolving to the same file, antibodies to screen 0, no destructive change",
    );
  });

  it("M1 names the antibodies it answered and the model flags the proof overruled", () => {
    const gi = input(DEFAULT_POLICY, { mechanical: PROOF, antibodies: 2, reflex: { ...CLEAR, needsHuman: 0.97 } });
    const v = gate(gi);
    expect(v.rule).toBe("M1 innate+proof");
    expect(changeConfirmed(entry(v, gi, DEFAULT_POLICY)).text).toBe(
      "M1: proof 1 file proven: only import specifiers changed, each still resolving to the same file, matching antibodies 2, antibody hits 0, model flags overruled by the proof 1",
    );
  });

  it("a person's approval names the person and the rule that sent the change to them, with its risk", () => {
    const policy = DEFAULT_POLICY;
    const gi = input(policy, { reflex: { ...CLEAR, needsHuman: 0.3 }, llm: opinion(), coverage: { llm: { complete: false, seen: "the second opinion saw 20 of 26 files" } }, alerts: { used: 4, max: 30 } });
    const v = gate(gi);
    expect(v).toMatchObject({ action: "escalate", rule: "L5 too large" });
    const human = { kind: "triage", layer: "human", p: 1, action: "approve", by: "maya", answer: "approve" };
    const c = changeConfirmed(entry(v, gi, policy, [human]));
    expect(c).toMatchObject({ rung: "person", rule: "L5", by: "maya" });
    expect(c.text).toBe("A person (maya) approved it; L5 too large had sent it to a person (escalations this hour 4 < 30, risk 2).");
  });

  it("names the detectors that fired when a detector and damage escalate", () => {
    const gi = input(DEFAULT_POLICY, { reflex: { ...CLEAR, needsHuman: 0.97, sensitive: 0.95 }, damage: { ...NONE, residual: ["src/other.ts"] } });
    const v = gate(gi);
    expect(v.rule).toBe("R1 detector+damage");
    expect(gateRecord(v, { input: gi, policy: DEFAULT_POLICY, approvals: () => 0 }).values).toEqual([
      { name: "escalations this hour", value: 0, op: "<", bound: 30 },
      { name: "risk", value: 0.4 },
      { name: "detectors", value: "clef:needs_human, clef:touches_sensitive" },
    ]);
  });

  it("an escalation past the alert budget names the risk floor it met", () => {
    const policy = presetPolicy("production");
    const gi = input(policy, { reflex: { ...CLEAR, needsHuman: 0.3 }, llm: opinion(), coverage: { llm: { complete: false, seen: "part" } }, alerts: { used: 200, max: 120 } });
    const v = gate(gi);
    expect(gateRecord(v, { input: gi, policy, approvals: () => 0 }).values).toEqual([{ name: "risk", value: 0.4, op: "≥", bound: 0 }]);
  });
});
