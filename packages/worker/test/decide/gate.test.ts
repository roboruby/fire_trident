import { describe, expect, it } from "vitest";
import { agentReason, gate, noulConfidence, type GateInput, type ReflexSignals, type SecondOpinion } from "../../src/decide/gate.ts";
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

describe("noulConfidence", () => {
  it("is 0 at even odds and 1 at certainty", () => {
    expect(noulConfidence(0.5)).toBe(0);
    expect(noulConfidence(0)).toBe(1);
    expect(noulConfidence(1)).toBe(1);
    expect(noulConfidence(0.9)).toBeCloseTo(0.8);
  });
});

describe("gate: deterministic stage (before any model)", () => {
  const pass = { verdict: "pass" as const, reasons: ["1 file proven"] };
  const fail = { verdict: "fail" as const, reasons: ["src/a.ts:1 './x.ts' names nothing"] };
  const inconclusive = { verdict: "inconclusive" as const, reasons: ["changes more than import specifiers"] };

  it("D3 lands a proven change with two deterministic confirmations and no model", () => {
    const v = gate(input({ reflex: undefined, mechanical: pass, antibodies: 0 }));
    expect(v).toMatchObject({ action: "land", layer: "deterministic", rule: "D3 innate+proof", confirmations: ["innate", "deterministic"], p: 1 });
  });

  it("D1 returns a change whose imports resolve to nothing or to another module", () => {
    const v = gate(input({ reflex: undefined, mechanical: fail }));
    expect(v).toMatchObject({ action: "return", layer: "deterministic", rule: "D1 resolution" });
    expect(v.reasons[0]).toContain("deterministic:");
  });

  it("D2 returns innate failures without damage at once, but screens them when there is damage", () => {
    expect(gate(input({ reflex: undefined, innate: { ok: false, failures: ["2 violations left"] } }))).toMatchObject({ action: "return", rule: "D2 innate" });
    expect(gate(input({ reflex: undefined, innate: { ok: false, failures: ["adds a violation"] }, damage: LOGS_SECRET }))).toMatchObject({ action: "screen" });
  });

  it("D4 screens inconclusive changes and proofs with antibodies to answer", () => {
    expect(gate(input({ reflex: undefined, mechanical: inconclusive })).action).toBe("screen");
    expect(gate(input({ reflex: undefined, mechanical: pass, antibodies: 2 })).action).toBe("screen");
  });

  it("M1: after screening, a proof lands unless an antibody hit; Clef alarms are only advisory", () => {
    const alarmed = gate(input({ reflex: { ...CLEAN, needsHuman: 0.97 }, mechanical: pass, antibodies: 1 }));
    expect(alarmed).toMatchObject({ action: "land", layer: "deterministic", rule: "M1 innate+proof", overruled: ["clef:needs_human"] });
    expect(alarmed.reasons.join(" ")).toContain("advisory only");
    const hit = gate(input({ reflex: { ...CLEAN, antibodies: [{ id: "ab_1", p: 0.95, threshold: 0.8, state: "active" }] }, mechanical: pass, antibodies: 1 }));
    expect(hit).toMatchObject({ action: "return", layer: "reflex", rule: "M1 proof+antibody", detectors: ["antibody:ab_1"] });
  });

  it("never consults System 2 for a proven or a refuted change", () => {
    for (const mechanical of [pass, fail]) {
      const v = gate(input({ reflex: { ...CLEAN, needsHuman: 0.6 }, mechanical }));
      expect(v.action).not.toBe("consult");
    }
  });
});

describe("gate: danger patterns", () => {
  const auth = { mustHuman: ["auth (authorization-header) at src/routes/links.ts:4: …"], signals: [] };
  const pass = { verdict: "pass" as const, reasons: ["proven"] };

  it("P1 escalates a must-human danger pattern before any model, whatever else confirms the change", () => {
    const v = gate(input({ reflex: undefined, danger: auth, mechanical: pass, autonomy: true }));
    expect(v).toMatchObject({ action: "escalate", layer: "deterministic", rule: "P1 danger pattern", risk: 3, detectors: ["danger:auth"] });
    // Even a System 2 approval cannot land it.
    expect(gate(input({ danger: auth, llm: opinion() }))).toMatchObject({ action: "escalate", rule: "P1 danger pattern" });
    expect(gate(input({ danger: auth, autonomy: true }))).toMatchObject({ action: "escalate", rule: "P1 danger pattern" });
  });

  it("P1 ignores the alert budget: danger always reaches a human", () => {
    expect(gate(input({ reflex: undefined, danger: auth, alerts: { used: 99, max: 30 } })).action).toBe("escalate");
  });

  it("P0 returns a dangerous change that fails its checks, so the human sees a fixed version", () => {
    const v = gate(input({ reflex: undefined, danger: auth, innate: { ok: false, failures: ["rule left 2 violations"] } }));
    expect(v).toMatchObject({ action: "return", rule: "P0 danger+innate" });
    expect(v.reasons.at(-1)).toContain("need a human once the checks pass");
  });

  it("danger signals are damage: no deterministic or autonomous landing, but a second opinion can approve", () => {
    const crypto = { mustHuman: [], signals: ["crypto (primitive) at src/index.ts:26: …"] };
    expect(gate(input({ reflex: undefined, danger: crypto, mechanical: pass })).action).toBe("screen");
    expect(gate(input({ danger: crypto, autonomy: true })).action).toBe("consult");
    expect(gate(input({ danger: crypto, llm: opinion() })).action).toBe("land");
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

describe("gate: earned autonomy covers only changes like the ones that earned it", () => {
  it("R3 never lands an intent an agent declared or a repair certification asked for", () => {
    for (const whyBy of ["agent", "certification"] as const) {
      const v = gate(input({ autonomy: true, whyBy }));
      expect(v).toMatchObject({ action: "consult", rule: "R4 consult" });
      expect(v.reasons[0]).toContain("earned autonomy does not cover an intent written by");
    }
    expect(gate(input({ autonomy: true, whyBy: "rule" })).action).toBe("land");
    // Unknown author: no autonomy landing.
    expect(gate(input({ autonomy: true, whyBy: undefined })).action).toBe("consult");
  });

  it("R3 never lands when the reflex saw only part of the change", () => {
    const v = gate(input({ autonomy: true, coverage: { reflex: { complete: false, seen: "the reflex saw 20 of 31 files" } } }));
    expect(v).toMatchObject({ action: "consult" });
    expect(v.reasons[0]).toContain("the reflex saw 20 of 31 files");
    expect(gate(input({ autonomy: true, coverage: { reflex: { complete: true, seen: "the reflex saw every changed line (2 files)" } } })).action).toBe("land");
  });
});

describe("gate: an approval counts only for what its layer saw", () => {
  const cut = { complete: false, seen: "the second opinion saw 3 of 4 files, 1 only in part (src/big.ts)" };

  it("L5 sends a System 2 approval of a cut view to a person, with the reason", () => {
    const v = gate(input({ llm: opinion(), coverage: { llm: cut } }));
    expect(v).toMatchObject({ action: "escalate", layer: "llm", rule: "L5 too large", detectors: ["review:too-large"] });
    expect(v.reasons[0]).toBe("too large for model review: the second opinion saw 3 of 4 files, 1 only in part (src/big.ts), so its approval does not count and a person decides");
  });

  it("the alert budget cannot send a too-large change back to loop", () => {
    expect(gate(input({ llm: opinion(), coverage: { llm: cut }, alerts: { used: 99, max: 30 } })).action).toBe("escalate");
  });

  it("small diffs behave as before: a complete view lands on L3, and returns are unchanged", () => {
    expect(gate(input({ llm: opinion(), coverage: { llm: { complete: true, seen: "the second opinion saw every changed line (2 files)" } } })).rule).toBe("L3 innate+llm");
    expect(gate(input({ llm: opinion({ verdict: "return", reason: "wrong" }), coverage: { llm: cut } })).action).toBe("return");
  });
});

describe("gate: after a security return, the intent's next proposal goes to a person", () => {
  const probation = { classes: ["capability"] };
  const inconclusive = { verdict: "inconclusive" as const, reasons: ["changes more than import specifiers"] };
  const pass = { verdict: "pass" as const, reasons: ["proven"] };

  it("P2 escalates instead of screening with a model, past the alert budget", () => {
    const v = gate(input({ reflex: undefined, mechanical: inconclusive, probation, alerts: { used: 99, max: 30 } }));
    expect(v).toMatchObject({ action: "escalate", layer: "deterministic", rule: "P2 security finding", risk: 3, detectors: ["intent:security-finding"] });
    expect(v.reasons[0]).toContain("had a security finding (capability)");
  });

  it("a change failing its checks goes back first; a proof needs no model and still lands", () => {
    expect(gate(input({ reflex: undefined, mechanical: inconclusive, probation, innate: { ok: false, failures: ["adds 1 violation"] }, damage: LOGS_SECRET }))).toMatchObject({
      action: "return",
      rule: "P2 probation+innate",
    });
    expect(gate(input({ reflex: undefined, mechanical: pass, probation, antibodies: 0 })).rule).toBe("D3 innate+proof");
  });
});

describe("gate: security returns tell the agent only the class", () => {
  const capability = { mustHuman: ["capability (network) at src/a.ts:3: await fetch('https://x.example/u')"], signals: [] };
  const crypto = { mustHuman: [], signals: ["crypto (primitive) at src/id.ts:2: const n = crypto.getRandomValues(buf)"] };

  it("P0 returns with the danger classes and the checks to fix; the details stay in the reasons", () => {
    const v = gate(input({ reflex: undefined, danger: capability, innate: { ok: false, failures: ["src/a.ts adds 1 violation of rule r1"] } }));
    expect(v).toMatchObject({ action: "return", rule: "P0 danger+innate", security: ["capability"], fix: ["innate: src/a.ts adds 1 violation of rule r1"] });
    expect(v.reasons.join(" ")).toContain("fetch(");
    const told = agentReason(v, capability);
    expect(told).toBe(
      "returned for review: security (capability); details are with the reviewers, and a person reviews this intent's next proposal. Fix these checks first: innate: src/a.ts adds 1 violation of rule r1",
    );
    expect(told).not.toContain("fetch");
  });

  it("System 2 flagging sensitive code or real damage is a security return", () => {
    expect(gate(input({ llm: opinion({ verdict: "return", sensitive: true, reason: "reads the admin token" }) })).security).toEqual(["sensitive"]);
    const v = gate(input({ llm: opinion({ verdict: "escalate", needsHuman: 0.9, reason: "opens a backdoor" }) }));
    expect(v).toMatchObject({ action: "return", security: ["damage"] });
    expect(agentReason(v)).not.toContain("backdoor");
  });

  it("an ordinary return keeps the model's sentence, with danger excerpts reduced to their class", () => {
    const v = gate(input({ danger: crypto, llm: opinion({ verdict: "return", reason: "the slug is one character short" }) }));
    expect(v.security).toBeUndefined();
    const told = agentReason(v, crypto);
    expect(told).toContain("the slug is one character short");
    expect(told).toContain("danger: crypto");
    expect(told).not.toContain("getRandomValues");
  });

  it("an unavailable second opinion defers the change without putting the intent on probation", () => {
    const alarmed = gate(input({ reflex: { ...CLEAN, sensitive: 0.95 }, llm: null }));
    expect(alarmed).toMatchObject({ action: "return", detectors: ["clef:touches_sensitive"] });
    expect(alarmed.security).toBeUndefined();
    const v = gate(input({ danger: crypto, llm: null }));
    expect(v.security).toBeUndefined();
    expect(agentReason(v, crypto)).toBe("llm: second opinion unavailable; one confirmation only; damage without a detector: danger: crypto");
  });

  it("an escalation over budget goes back as a security return when its damage is security damage", () => {
    const low: ReflexSignals = { ...SECRET, risk: 1.2 };
    expect(gate(input({ reflex: low, damage: LOGS_SECRET, alerts: { used: 30, max: 30 } })).security).toEqual(["secret", "sensitive"]);
    const scope: ReflexSignals = { ...CLEAN, needsHuman: 0.97, risk: 0.5 };
    const v = gate(input({ reflex: scope, damage: { ...NONE, residual: ["README.md"] }, alerts: { used: 30, max: 30 } }));
    expect(v).toMatchObject({ action: "return", rule: "R1 detector+damage+budget" });
    expect(v.security).toBeUndefined();
  });
});

describe("gate: antibody returns", () => {
  const pass = { verdict: "pass" as const, reasons: ["proven"] };
  const question = "Does this change rename an exported function without updating its callers?";

  it("name the antibody's question so the agent knows which check it failed", () => {
    const v = gate(input({ reflex: { ...CLEAN, antibodies: [{ id: "ab_1", p: 0.95, threshold: 0.8, state: "active", question }] }, mechanical: pass, antibodies: 1 }));
    expect(v).toMatchObject({ action: "return", rule: "M1 proof+antibody" });
    expect(v.security).toBeUndefined();
    expect(agentReason(v)).toContain(question);
  });

  it("an antibody learned from a security finding returns only the class", () => {
    const v = gate(input({ reflex: { ...CLEAN, antibodies: [{ id: "ab_2", p: 0.95, threshold: 0.8, state: "active", question: "Does it log a token?", security: true }] }, mechanical: pass, antibodies: 1 }));
    expect(v.security).toEqual(["antibody"]);
    expect(agentReason(v)).not.toContain("log a token");
  });
});

describe("gate: escalations driven by a security finding say so", () => {
  it("a capped list of danger labels adds no class of its own", () => {
    const many = { mustHuman: ["auth (bearer-scheme) at src/a.ts:4: …", "and 3 more"], signals: [] };
    const v = gate(input({ reflex: undefined, danger: many, innate: { ok: false, failures: ["x"] } }));
    expect(v.security).toEqual(["auth"]);
    expect(agentReason(v, many)).toContain("security (auth)");
  });

  it("P1 carries its danger classes; an escalation with only scope damage carries none", () => {
    const auth = { mustHuman: ["auth (bearer-scheme) at src/routes/links.ts:4: …"], signals: [] };
    expect(gate(input({ reflex: undefined, danger: auth })).security).toEqual(["auth"]);
    expect(gate(input({ reflex: SECRET, damage: LOGS_SECRET })).security).toEqual(["secret", "sensitive"]);
    const scope = gate(input({ reflex: { ...CLEAN, needsHuman: 0.97 }, damage: { ...NONE, residual: ["README.md"] } }));
    expect(scope).toMatchObject({ action: "escalate", rule: "R1 detector+damage" });
    expect(scope.security).toBeUndefined();
  });
});
