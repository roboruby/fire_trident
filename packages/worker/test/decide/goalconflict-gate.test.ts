import { describe, expect, it } from "vitest";
import { agentReason, gate, type GateInput, type ReflexSignals, type SecondOpinion } from "../../src/decide/gate.ts";
import { DEFAULT_POLICY } from "../../src/decide/policy.ts";
import type { DamageSignals } from "../../src/decide/signals.ts";

const NONE: DamageSignals = { sensitivePaths: [], residual: [], capabilities: [] };
const CLEAN: ReflexSignals = { needsHuman: 0.05, sensitive: 0.03, offIntent: 0.03, risk: 0.7, antibodies: [] };
const REASON =
  'would undo 4 lines in src/backend.ts that landing lnd_1 wrote 3 minutes ago for intent "Move the backend to Rust" (One static binary.), a different intent; a person decides which goal stands';
const CONFLICT = { reason: REASON };

function input(over: Partial<GateInput> = {}): GateInput {
  return {
    innate: { ok: true, failures: [] },
    damage: NONE,
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
  return { verdict: "approve", needsHuman: 0.05, offIntent: false, sensitive: false, confidence: 0.95, reason: "does what the intent says", model: "@cf/openai/gpt-oss-120b", ...over };
}

const pass = { verdict: "pass" as const, reasons: ["only comments changed"] };

describe("gate: goal conflicts (P4)", () => {
  it("sends a change that would undo another intent's recent landing to a person before any model, whatever proves it", () => {
    const v = gate(input({ reflex: undefined, mechanical: pass, goalConflict: CONFLICT }));
    expect(v).toMatchObject({ action: "escalate", layer: "deterministic", rule: "P4 goal conflict", p: 1, detectors: ["policy:goal-conflict"], reasons: [REASON] });
    expect(v.risk).toBeGreaterThanOrEqual(DEFAULT_POLICY.budgetRiskFloor);
    expect(v.security).toBeUndefined();
  });

  it("holds in every phase: after a clear reflex, earned autonomy, or a second opinion's approval", () => {
    expect(gate(input({ goalConflict: CONFLICT, autonomy: true }))).toMatchObject({ action: "escalate", rule: "P4 goal conflict" });
    expect(gate(input({ goalConflict: CONFLICT, llm: opinion() }))).toMatchObject({ action: "escalate", rule: "P4 goal conflict" });
  });

  it("is never bounced by the alert budget", () => {
    const v = gate(input({ reflex: undefined, goalConflict: CONFLICT, alerts: { used: 99, max: 30 } }));
    expect(v).toMatchObject({ action: "escalate", rule: "P4 goal conflict" });
    expect(gate(input({ reflex: undefined, goalConflict: CONFLICT, alerts: { used: 99, max: 30 }, policy: { ...DEFAULT_POLICY, budgetRiskFloor: 3 } })).action).toBe("escalate");
  });

  it("returns a change that fails its checks first, telling its agent what it would undo", () => {
    const v = gate(input({ reflex: undefined, goalConflict: CONFLICT, innate: { ok: false, failures: ["no Not verified statement"] } }));
    expect(v).toMatchObject({ action: "return", layer: "deterministic", rule: "P4 goal conflict+innate" });
    expect(v.reasons).toEqual(["innate: no Not verified statement", `${REASON} once its checks pass`]);
    expect(agentReason(v)).toContain("that landing lnd_1 wrote 3 minutes ago");
  });

  it("leaves a refuted import to D1, and lets danger patterns and protected paths name the conflict too", () => {
    const fail = { verdict: "fail" as const, reasons: ["src/a.ts:1 './x.ts' names nothing"] };
    expect(gate(input({ reflex: undefined, mechanical: fail, goalConflict: CONFLICT })).rule).toBe("D1 resolution");
    const danger = gate(input({ reflex: undefined, danger: { mustHuman: ["auth (authorization-header) at src/a.ts:4: …"], signals: [] }, goalConflict: CONFLICT }));
    expect(danger).toMatchObject({ action: "escalate", rule: "P1 danger pattern" });
    expect(danger.reasons).toContain(REASON);
    const guarded = gate(input({ reflex: undefined, protected: [{ path: "src/backend.ts", glob: "src/**" }], goalConflict: CONFLICT }));
    expect(guarded).toMatchObject({ action: "escalate", rule: "P3 protected path" });
    expect(guarded.reasons).toEqual(["protected paths need a person: src/backend.ts (protected by src/**)", REASON]);
  });

  it("changes nothing without a conflict", () => {
    expect(gate(input({ reflex: undefined, mechanical: pass, goalConflict: null }))).toMatchObject({ action: "land", rule: "D3 innate+proof" });
    expect(gate(input({ reflex: undefined, mechanical: pass }))).toMatchObject({ action: "land", rule: "D3 innate+proof" });
  });
});
