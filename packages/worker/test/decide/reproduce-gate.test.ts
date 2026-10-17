import { describe, expect, it } from "vitest";
import { gate, type GateInput } from "../../src/decide/gate.ts";
import { DEFAULT_POLICY } from "../../src/decide/policy.ts";
import type { ReproductionSignal } from "../../src/decide/reproduce.ts";
import { gateRecord } from "../../src/decide/ruleline.ts";

const ALL: ReproductionSignal = { label: "rename-identifier@1", reproduced: { files: 212, lines: 3_999 }, residual: { files: 0, lines: 0 }, text: "3,999 lines reproduced by rename-identifier@1, nothing else to review" };
const ONE_LEFT: ReproductionSignal = { ...ALL, reproduced: { files: 211, lines: 3_998 }, residual: { files: 1, lines: 1 }, text: "3,998 lines reproduced by rename-identifier@1, 1 line to review" };

/** The deterministic stage's input (no model asked yet), with nothing wrong. */
function input(over: Partial<GateInput> = {}): GateInput {
  return {
    innate: { ok: true, failures: [] },
    damage: { sensitivePaths: [], residual: [], capabilities: [] },
    autonomy: false,
    whyBy: "person",
    destructive: { hits: [], unknown: [] },
    alerts: { used: 0, max: 30 },
    detectors: {},
    policy: DEFAULT_POLICY,
    ...over,
  };
}

describe("gate rule D5: reproduced by recipe", () => {
  it("lands a change every file of which equals its recipe's replay, deterministically, with the reproduction as both confirmations", () => {
    const v = gate(input({ reproduction: ALL }));
    expect(v).toMatchObject({ action: "land", layer: "deterministic", rule: "D5 reproduced by recipe", confirmations: ["innate", "reproduction"], p: 1, reasons: [`reproduced by recipe: ${ALL.text}`] });
    expect(gateRecord(v, { input: { reproduction: ALL, alerts: { used: 0, max: 30 } }, policy: DEFAULT_POLICY, approvals: () => 0 }).values).toEqual([
      { name: "recipe", value: "rename-identifier@1" },
      { name: "lines reproduced", value: 3_999 },
      { name: "files reproduced", value: 212 },
      { name: "lines to review", value: 0 },
    ]);
  });

  it("screens the residual when one is left, saying how much was reproduced", () => {
    const v = gate(input({ reproduction: ONE_LEFT }));
    expect(v).toMatchObject({ action: "screen", rule: "D4 screen" });
    expect(v.reasons).toContain("reproduced by recipe: 3,998 lines reproduced by rename-identifier@1, 1 line to review; the residual goes to review");
  });

  it("does not waive what reads the whole change: danger, protected paths, failing checks, damage, antibodies, destructive facts", () => {
    expect(gate(input({ reproduction: ALL, danger: { mustHuman: ["capability (network) at src/a.ts:3"], signals: [] } }))).toMatchObject({ action: "escalate", rule: "P1 danger pattern" });
    expect(gate(input({ reproduction: ALL, protected: [{ path: "src/a.ts", glob: "src/**" }] }))).toMatchObject({ action: "escalate", rule: "P3 protected path" });
    expect(gate(input({ reproduction: ALL, innate: { ok: false, failures: ["rule re-check: 1 violation left"] } }))).toMatchObject({ action: "return", rule: "D2 innate" });
    expect(gate(input({ reproduction: ALL, damage: { sensitivePaths: [{ path: "src/auth/a.ts", why: "authentication" }], residual: [], capabilities: [] } }))).toMatchObject({ action: "screen" });
    expect(gate(input({ reproduction: ALL, antibodies: 1 }))).toMatchObject({ action: "screen" });
    expect(gate(input({ reproduction: ALL, destructive: { hits: [{ kind: "deleted", path: "src/a.ts", label: "deletes src/a.ts" }], unknown: [] } }))).toMatchObject({ action: "screen" });
  });

  it("names the reproduced share when a model lands the residual", () => {
    const v = gate(input({ reproduction: ONE_LEFT, reflex: { needsHuman: 0.05, sensitive: 0.03, offIntent: 0.03, risk: 0.5, antibodies: [] }, llm: { verdict: "approve", needsHuman: 0.05, offIntent: false, sensitive: false, confidence: 0.95, reason: "fine", model: "m" } }));
    expect(v).toMatchObject({ action: "land", rule: "L3 innate+llm" });
    const values = gateRecord(v, { input: { reproduction: ONE_LEFT, alerts: { used: 0, max: 30 }, llm: { verdict: "approve", needsHuman: 0.05, offIntent: false, sensitive: false, confidence: 0.95, reason: "fine", model: "m" } }, policy: DEFAULT_POLICY, approvals: () => 0 }).values;
    expect(values.slice(-2)).toEqual([
      { name: "lines reproduced by rename-identifier@1", value: 3_998 },
      { name: "residual lines reviewed", value: 1 },
    ]);
  });
});
