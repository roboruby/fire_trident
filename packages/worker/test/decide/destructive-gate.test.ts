import { describe, expect, it } from "vitest";
import { destructiveFact, type DestructiveFact, type DestructiveFile } from "../../src/decide/destructive.ts";
import { gate, type GateInput, type ReflexSignals, type SecondOpinion } from "../../src/decide/gate.ts";
import { DEFAULT_POLICY } from "../../src/decide/policy.ts";

/**
 * The gate and destructive changes (decide/destructive.ts): no rung that lands without the second opinion or a person
 * (R3 earned autonomy, D3 and M1 deterministic proofs) lands a change that deletes or renames a file, removes an export
 * or removes a large share of a file. Such a change goes on to the second opinion, never straight to a person.
 */

const CLEAN: ReflexSignals = { needsHuman: 0.05, sensitive: 0.03, offIntent: 0.03, risk: 0.7, antibodies: [] };
const APPROVE: SecondOpinion = { verdict: "approve", needsHuman: 0.05, offIntent: false, sensitive: false, confidence: 0.95, reason: "does what the intent says", model: "@cf/openai/gpt-oss-120b" };
const NOTHING: DestructiveFact = { hits: [], unknown: [] };
const PROOF = { verdict: "pass" as const, reasons: ["1 file proven comment-only (src/a.ts)"] };

const MODULE = "export function add(a: number, b: number): number {\n  return a + b;\n}\n";
const TWO = `${MODULE}\nexport function sub(a: number, b: number): number {\n  return a - b;\n}\n`;
const lines = (n: number): string => `export function sum(): number {\n  let total = 0;\n${Array.from({ length: n }, (_, i) => `  total += ${i};\n`).join("")}  return total;\n}\n`;

let seq = 0;
const sha = (): string => `${(++seq).toString(16).padStart(8, "0")}${"c".repeat(32)}`;
const edit = (path: string, before: string, after: string): DestructiveFile => ({ path, beforeBlob: sha(), afterBlob: sha(), before, after });

/** The fact of each destructive kind, as the engine computes it from the change. */
const KINDS: Record<string, { fact: DestructiveFact; says: string }> = {
  deleted: { fact: destructiveFact([{ path: "src/x.ts", beforeBlob: sha(), afterBlob: null, before: MODULE, after: null }]), says: "this change deletes src/x.ts" },
  renamed: (() => {
    const blob = sha();
    return {
      fact: destructiveFact([
        { path: "src/a.ts", beforeBlob: blob, afterBlob: null, before: MODULE, after: null },
        { path: "src/b.ts", beforeBlob: null, afterBlob: blob, before: null, after: MODULE },
      ]),
      says: "this change renames src/a.ts to src/b.ts",
    };
  })(),
  "export removed": { fact: destructiveFact([edit("src/math.ts", TWO, TWO.replace("export function sub", "function sub"))]), says: "this change removes the export sub from src/math.ts" },
  "large removal": { fact: destructiveFact([edit("src/sum.ts", lines(300), lines(60))]), says: "this change removes 240 lines net from src/sum.ts, which had 304" },
};

function input(over: Partial<GateInput> = {}): GateInput {
  return {
    innate: { ok: true, failures: [] },
    damage: { sensitivePaths: [], residual: [], capabilities: [] },
    reflex: CLEAN,
    autonomy: true,
    whyBy: "person",
    destructive: NOTHING,
    alerts: { used: 0, max: 30 },
    detectors: {},
    policy: DEFAULT_POLICY,
    ...over,
  };
}

describe("earned autonomy does not land destructive changes", () => {
  it("still lands a change that takes nothing away (R3)", () => {
    expect(gate(input())).toMatchObject({ action: "land", rule: "R3 innate+autonomy", confirmations: ["innate", "autonomy"] });
    const grown = destructiveFact([edit("src/math.ts", MODULE, TWO)]);
    expect(gate(input({ destructive: grown }))).toMatchObject({ action: "land", rule: "R3 innate+autonomy" });
  });

  for (const [kind, { fact, says }] of Object.entries(KINDS)) {
    it(`sends a change that ${kind === "large removal" ? "removes a large share of a file" : `has a file ${kind}`} to the second opinion, naming why`, () => {
      const v = gate(input({ destructive: fact }));
      expect(v).toMatchObject({ action: "consult", layer: "reflex", rule: "R4 consult", reasons: [`Earned autonomy does not land destructive changes: ${says}`] });
      // The second opinion decides, as for any change without autonomy: its approval lands it, its return sends it back.
      expect(gate(input({ destructive: fact, llm: APPROVE }))).toMatchObject({ action: "land", rule: "L3 innate+llm", confirmations: ["innate", "llm"] });
      expect(gate(input({ destructive: fact, llm: { ...APPROVE, verdict: "return", reason: "deletes code the intent did not ask to delete" } }))).toMatchObject({ action: "return", rule: "L4 one signal" });
    });
  }

  it("fails closed: a fact that is unknown or was never computed lets no autonomy apply", () => {
    const unknown = gate(input({ destructive: { hits: [], unknown: ["src/legacy.js: its exports cannot be read for sure"] } }));
    expect(unknown).toMatchObject({ action: "consult", rule: "R4 consult" });
    expect(unknown.reasons).toEqual(["Earned autonomy needs to know whether a change is destructive, and this one could not be read to tell (src/legacy.js: its exports cannot be read for sure)"]);
    for (const destructive of [undefined, null]) {
      const v = gate(input({ destructive }));
      expect(v).toMatchObject({ action: "consult", reasons: ["Earned autonomy needs to know whether a change is destructive, and that was not computed for this one"] });
    }
  });

  it("names the reason autonomy did not apply first when there is one, and claims no autonomy a region has not earned", () => {
    expect(gate(input({ destructive: KINDS.deleted!.fact, whyBy: "agent" })).reasons[0]).toContain("earned autonomy does not cover an intent written by an agent");
    expect(gate(input({ destructive: KINDS.deleted!.fact, autonomy: false })).reasons).toEqual(["no earned autonomy and no deterministic proof: a second confirmation is required"]);
  });

  it("never sends one straight to a person on that account", () => {
    for (const { fact } of Object.values(KINDS)) {
      expect(gate(input({ destructive: fact, reflex: undefined })).action).toBe("screen");
      expect(gate(input({ destructive: fact })).action).not.toBe("escalate");
    }
  });
});

describe("a deterministic proof does not land destructive changes alone", () => {
  const large = KINDS["large removal"]!.fact;

  it("D3 screens a proven change that removes a large share of a file instead of landing it", () => {
    const v = gate(input({ reflex: undefined, mechanical: PROOF, destructive: large }));
    expect(v).toMatchObject({ action: "screen", rule: "D4 screen", reasons: ["A deterministic proof does not land destructive changes alone: this change removes 240 lines net from src/sum.ts, which had 304"] });
  });

  it("M1 sends it to the second opinion after a quiet reflex, which then decides", () => {
    const v = gate(input({ mechanical: PROOF, destructive: large, autonomy: false }));
    expect(v).toMatchObject({ action: "consult", rule: "R4 consult", reasons: ["A deterministic proof does not land destructive changes alone: this change removes 240 lines net from src/sum.ts, which had 304"] });
    expect(gate(input({ mechanical: PROOF, destructive: large, autonomy: false, llm: APPROVE }))).toMatchObject({ action: "land", rule: "L3 innate+llm" });
  });

  it("lands a proven change that takes nothing away, or one whose fact is unknown (the proof read every file)", () => {
    expect(gate(input({ reflex: undefined, mechanical: PROOF }))).toMatchObject({ action: "land", rule: "D3 innate+proof" });
    expect(gate(input({ reflex: undefined, mechanical: PROOF, destructive: { hits: [], unknown: ["src/index.ts: its exports cannot be read for sure"] } }))).toMatchObject({ action: "land", rule: "D3 innate+proof" });
    expect(gate(input({ reflex: undefined, mechanical: PROOF, destructive: undefined }))).toMatchObject({ action: "land", rule: "D3 innate+proof" });
    expect(gate(input({ mechanical: PROOF, antibodies: 1 }))).toMatchObject({ action: "land", rule: "M1 innate+proof" });
  });
});

describe("destructive changes and the rules that reach a person", () => {
  it("leave danger patterns, protected paths and goal conflicts as they were", () => {
    const fact = KINDS.deleted!.fact;
    expect(gate(input({ destructive: fact, protected: [{ path: "src/x.ts", glob: "src/**" }] }))).toMatchObject({ action: "escalate", rule: "P3 protected path" });
    expect(gate(input({ destructive: fact, danger: { mustHuman: ["auth (jwt) at src/x.ts:1: removed: verify(token)"], signals: [] } }))).toMatchObject({ action: "escalate", rule: "P1 danger pattern" });
    expect(gate(input({ destructive: fact, goalConflict: { reason: "it undoes lines landing lnd_1 wrote" } }))).toMatchObject({ action: "escalate", rule: "P4 goal conflict" });
  });
});
