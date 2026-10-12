import { describe, expect, it } from "vitest";
import { gate, noulConfidence, type GateInput, type ReflexSignals, type SecondOpinion } from "../../src/decide/gate.ts";
import { DEFAULT_POLICY } from "../../src/decide/policy.ts";
import type { DamageSignals } from "../../src/decide/signals.ts";

const NONE: DamageSignals = { sensitivePaths: [], residual: [], capabilities: [] };
const CLEAN: ReflexSignals = { needsHuman: 0.05, sensitive: 0.03, offIntent: 0.03, risk: 0.7, antibodies: [] };
const SECRET: ReflexSignals = { needsHuman: 0.93, sensitive: 0.98, offIntent: 0.96, risk: 2.6, antibodies: [] };
const LOGS_SECRET: DamageSignals = { sensitivePaths: [], residual: [], capabilities: [{ id: "secret-log", label: "logs a secret or credential", path: "src/a.ts" }] };

function input(over: Partial<GateInput> = {}): GateInput {
  return {
    innate: { ok: true, failures: [] },
    damage: NONE,
    reflex: CLEAN,
    autonomy: false,
    alerts: { used: 0, max: 30 },
    detectors: {},
    policy: DEFAULT_POLICY,
    ...over,
  };
}

function opinion(over: Partial<SecondOpinion> = {}): SecondOpinion {
  return { verdict: "approve", needsHuman: 0.05, offIntent: false, sensitive: false, confidence: 0.95, reason: "does what the intent says", model: "@cf/openai/gpt-oss-120b", ...over };
}

describe("noulConfidence", () => {
  it("is 0 at even odds and 1 at certainty", () => {
    expect(noulConfidence(0.5)).toBe(0);
    expect(noulConfidence(0)).toBe(1);
    expect(noulConfidence(1)).toBe(1);
    expect(noulConfidence(0.9)).toBeCloseTo(0.8);
  });
});

describe("gate: System 1 phase", () => {
  it("R1 escalates a confident detector hit with damage without consulting System 2", () => {
    const v = gate(input({ reflex: SECRET, damage: LOGS_SECRET }));
    expect(v).toMatchObject({ action: "escalate", layer: "reflex", rule: "R1 detector+damage" });
    expect(v.detectors).toEqual(["clef:needs_human", "clef:touches_sensitive"]);
    expect(v.damage.some((d) => d.includes("logs a secret"))).toBe(true);
    expect(v.p).toBeCloseTo(0.98);
  });

  it("consults System 2 when the alarm is not confident", () => {
    const unsure: ReflexSignals = { ...CLEAN, needsHuman: 0.64, offIntent: 0.89 };
    const v = gate(input({ reflex: unsure, damage: { ...NONE, residual: ["test/a.test.ts"] } }));
    expect(v).toMatchObject({ action: "consult", layer: "reflex", rule: "R4 consult" });
    expect(v.reasons[0]).toContain("reflex unsure");
  });

  it("R2 returns deterministic failures to the agent", () => {
    const v = gate(input({ innate: { ok: false, failures: ["src/a.ts still has 2 violations"] } }));
    expect(v).toMatchObject({ action: "return", layer: "reflex", rule: "R2 innate", p: 1 });
    expect(v.reasons).toEqual(["innate: src/a.ts still has 2 violations"]);
  });

  it("R1 wins over an innate failure when a confident detector and damage agree", () => {
    const v = gate(input({ reflex: SECRET, damage: LOGS_SECRET, innate: { ok: false, failures: ["adds 1 violation"] } }));
    expect(v.action).toBe("escalate");
  });

  it("R3 lets a confident, quiet reflex land alone only with earned autonomy", () => {
    const v = gate(input({ autonomy: true }));
    expect(v).toMatchObject({ action: "land", layer: "reflex", rule: "R3 innate+autonomy", confirmations: ["innate", "autonomy"] });
    expect(v.p).toBeCloseTo(0.95);
    const w = gate(input({ autonomy: false }));
    expect(w).toMatchObject({ action: "consult" });
    expect(w.reasons[0]).toContain("no earned autonomy");
  });

  it("does not land on autonomy when there is any damage", () => {
    expect(gate(input({ autonomy: true, damage: { ...NONE, residual: ["README.md"] } })).action).toBe("consult");
  });

  it("consults System 2 when Clef is unavailable", () => {
    const v = gate(input({ reflex: null }));
    expect(v).toMatchObject({ action: "consult", reasons: ["reflex unavailable"] });
  });

  it("treats Clef's off_intent as damage, not as a detector", () => {
    const v = gate(input({ reflex: { ...CLEAN, offIntent: 0.97, needsHuman: 0.03 } }));
    expect(v.detectors).toEqual([]);
    expect(v.damage.some((d) => d.startsWith("off-intent"))).toBe(true);
    expect(v.action).toBe("consult");
  });
});

describe("gate: after System 2", () => {
  it("L3 lands with two confirmations: innate checks and System 2 approval", () => {
    const v = gate(input({ llm: opinion() }));
    expect(v).toMatchObject({ action: "land", layer: "llm", rule: "L3 innate+llm", confirmations: ["innate", "llm"] });
    expect(v.p).toBeCloseTo(0.95);
  });

  it("L4 returns when System 2 approves but p(needs_human) is too high", () => {
    const v = gate(input({ llm: opinion({ needsHuman: 0.7 }) }));
    expect(v).toMatchObject({ action: "return", rule: "L4 one signal" });
  });

  it("L4 returns (one signal only) when System 2 says return, even with damage", () => {
    const unsure: ReflexSignals = { ...CLEAN, needsHuman: 0.64, offIntent: 0.89 };
    const v = gate(input({ reflex: unsure, damage: { ...NONE, residual: ["test/a.test.ts"] }, llm: opinion({ verdict: "return", needsHuman: 0.9, offIntent: true, reason: "skips a test" }) }));
    expect(v).toMatchObject({ action: "return", layer: "llm" });
    expect(v.detectors).toEqual([]);
    expect(v.reasons.join(" ")).toContain("skips a test");
  });

  it("L1 escalates when System 2 escalates and there is damage", () => {
    const v = gate(input({ reflex: { ...CLEAN, needsHuman: 0.6 }, damage: LOGS_SECRET, llm: opinion({ verdict: "escalate", needsHuman: 0.95, sensitive: true, reason: "prints a token" }) }));
    expect(v).toMatchObject({ action: "escalate", layer: "llm", rule: "L1 detector+damage" });
    expect(v.detectors).toEqual(["llm:escalate"]);
    expect(v.risk).toBeGreaterThanOrEqual(2);
  });

  it("does not page a human for a System 2 escalation without damage", () => {
    const v = gate(input({ llm: opinion({ verdict: "escalate", needsHuman: 0.9, reason: "looks odd" }) }));
    expect(v.action).toBe("return");
    expect(v.reasons.join(" ")).toContain("one signal only");
  });

  it("keeps a confident System 1 alarm: reviewers disagreeing never land", () => {
    const v = gate(input({ reflex: { ...CLEAN, needsHuman: 0.96 }, llm: opinion() }));
    expect(v).toMatchObject({ action: "return" });
    expect(v.reasons[0]).toContain("reviewers disagree");
  });

  it("returns when System 2 is unavailable", () => {
    const v = gate(input({ llm: null }));
    expect(v).toMatchObject({ action: "return", p: 1 });
    expect(v.reasons[0]).toContain("unavailable");
  });
});

describe("gate: antibodies, probation and the alert budget", () => {
  const hit = { id: "ab_1", p: 0.92, threshold: 0.7, state: "active" as const };

  it("an antibody hit with damage escalates at the reflex", () => {
    const v = gate(input({ reflex: { ...CLEAN, antibodies: [hit] }, damage: LOGS_SECRET }));
    expect(v).toMatchObject({ action: "escalate", layer: "reflex" });
    expect(v.detectors).toEqual(["antibody:ab_1"]);
  });

  it("an antibody hit without damage goes back to the agent after System 2", () => {
    const first = gate(input({ reflex: { ...CLEAN, antibodies: [hit] } }));
    expect(first.action).toBe("consult");
    const v = gate(input({ reflex: { ...CLEAN, antibodies: [hit] }, llm: opinion() }));
    expect(v).toMatchObject({ action: "return" });
    expect(v.detectors).toEqual(["antibody:ab_1"]);
  });

  it("advisory antibodies and detectors are recorded but never gate", () => {
    const v = gate(input({ reflex: { ...SECRET, antibodies: [{ ...hit, state: "advisory" }] }, damage: LOGS_SECRET, detectors: { "clef:needs_human": "advisory", "clef:touches_sensitive": "off" } }));
    expect(v.detectors).toEqual([]);
    expect(v.action).toBe("consult");
  });

  it("over the alert budget, low-risk escalations go back to their agents", () => {
    const low: ReflexSignals = { ...SECRET, risk: 1.2 };
    const v = gate(input({ reflex: low, damage: LOGS_SECRET, alerts: { used: 30, max: 30 } }));
    expect(v).toMatchObject({ action: "return", rule: "R1 detector+damage+budget" });
    expect(v.reasons.at(-1)).toContain("alert budget spent");
  });

  it("over the alert budget, high-risk escalations still reach a human", () => {
    const v = gate(input({ reflex: SECRET, damage: LOGS_SECRET, alerts: { used: 31, max: 30 } }));
    expect(v.action).toBe("escalate");
  });
});
