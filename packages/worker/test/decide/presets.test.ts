import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, mergePolicy } from "../../src/decide/policy.ts";
import { PRESETS, PRESET_FIELDS, letsLand, presetNamed, presetOf, presetPolicy, presetValues } from "../../src/decide/presets.ts";

/** The gate's four presets: one place defines them, a colony's policy reads as the one it equals, or custom with what differs. */

describe("the four presets", () => {
  it("are local development, central development, pre-production and production, in that order", () => {
    expect(PRESETS.map((p) => p.name)).toEqual(["local-development", "central-development", "pre-production", "production"]);
    expect(PRESETS.map((p) => p.label)).toEqual(["local development", "central development", "pre-production", "production"]);
    expect(presetNamed("production")?.values.autonomyAfter).toBe(20);
    expect(presetNamed("staging")).toBeNull();
  });

  it("call the default policy central development, so a colony nobody tuned reads as it", () => {
    expect(presetOf(DEFAULT_POLICY)).toEqual({ preset: "central-development", nearest: "central-development", differs: [] });
  });

  it("each match their own policy, also after the policy store's JSON round trip, and keep everything else", () => {
    for (const p of PRESETS) {
      const policy = presetPolicy(p.name);
      expect(presetOf(policy).preset).toBe(p.name);
      // The decide store keeps a policy as JSON and merges it over the defaults when it reads it (DecideStore.policy).
      expect(presetOf(mergePolicy(DEFAULT_POLICY, JSON.parse(JSON.stringify(policy)))).preset).toBe(p.name);
      // Every preset value is inside the range mergePolicy clamps to, so setting it through the policy route keeps it.
      expect(presetValues(mergePolicy(DEFAULT_POLICY, p.values))).toEqual(p.values);
      // Fields a preset does not set stay as they were.
      expect(presetPolicy(p.name, { ...DEFAULT_POLICY, protectedPaths: ["src/auth/**"] }).protectedPaths).toEqual(["src/auth/**"]);
    }
  });

  it("ask for more certainty at each step up", () => {
    const v = PRESETS.map((p) => p.values);
    for (let i = 1; i < v.length; i++) {
      expect(v[i]!.confidence).toBeGreaterThan(v[i - 1]!.confidence);
      expect(v[i]!.needsHuman).toBeLessThan(v[i - 1]!.needsHuman);
      expect(v[i]!.autonomyAfter).toBeGreaterThan(v[i - 1]!.autonomyAfter);
      expect(v[i]!.budgetRiskFloor).toBeLessThan(v[i - 1]!.budgetRiskFloor);
    }
  });

  it("say in one sentence what each lets land without a person, with its own numbers", () => {
    const production = letsLand(presetNamed("production")!.values);
    expect(production).toBe(
      "A deterministic proof (an import rewrite, a rule's replacement, or a change only to comments), a second opinion's approval with p(needs_human) under 0.2, or the reflex alone at confidence 0.9 or more, in a region with 20 approved landings since its last escalation or rejection lands a change without a person.",
    );
    expect(letsLand(presetNamed("local-development")!.values)).toContain("in a region with 1 approved landing since");
    expect(letsLand({ ...presetNamed("central-development")!.values, deterministic: false })).toMatch(/^A second opinion's approval with p\(needs_human\) under 0\.5 or the reflex alone/);
    expect(letsLand({ ...presetNamed("central-development")!.values, enabled: false })).toMatch(/^Every change that passes its checks lands without a person or a model/);
    for (const p of PRESETS) expect(letsLand(p.values).split(". ").length).toBe(1);
  });
});

describe("a custom policy", () => {
  it("names the nearest preset and each value that differs from it, in the card's order", () => {
    const m = presetOf(mergePolicy(DEFAULT_POLICY, { confidence: 0.9, needsHuman: 0.25 }));
    expect(m).toEqual({
      preset: "custom",
      nearest: "central-development",
      differs: [
        { field: "confidence", label: "reflex confidence to act alone", value: 0.9, preset: 0.8 },
        { field: "needsHuman", label: "p(needs_human) a landing stays under", value: 0.25, preset: 0.5 },
      ],
    });
  });

  it("is custom when review is off, whatever the numbers", () => {
    const m = presetOf(mergePolicy(presetPolicy("production"), { enabled: false }));
    expect(m.preset).toBe("custom");
    expect(m.nearest).toBe("production");
    expect(m.differs).toEqual([{ field: "enabled", label: "review by models", value: false, preset: true }]);
  });

  it("ignores fields no preset sets (models, protected paths, rate limits)", () => {
    const tuned = mergePolicy(presetPolicy("pre-production"), { reflexModel: "@cf/x/y", llmPerMinute: 20, protectedPaths: ["db/**"] });
    expect(presetOf(tuned).preset).toBe("pre-production");
    expect(PRESET_FIELDS.map((f) => f.key)).not.toContain("protectedPaths");
  });

  it("breaks a tie toward the more trusting preset, the earlier in the list", () => {
    // Three fields from central development's values and three from pre-production's.
    const m = presetOf({ ...DEFAULT_POLICY, confidence: 0.85, hit: 0.4, needsHuman: 0.3 });
    expect(m.nearest).toBe("central-development");
    expect(m.differs.map((d) => d.field)).toEqual(["confidence", "hit", "needsHuman"]);
  });
});
