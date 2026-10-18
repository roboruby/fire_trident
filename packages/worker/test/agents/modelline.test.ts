import { describe, expect, it } from "vitest";
import { knownModel, modelLineChoice } from "../../src/agents/modelline.ts";

/** Who may choose an in-platform agent's model through a Model line (agents/modelline.ts), as a pure decision. */

const KNOWN = { default: "@cf/deploy/default", bulk: "@cf/deploy/bulk", own: "@cf/agent/own" };

describe("modelLineChoice", () => {
  it("chooses nothing without a line", () => {
    expect(modelLineChoice(null, "agent", KNOWN)).toEqual({ model: null });
    expect(modelLineChoice("  ", "human", KNOWN)).toEqual({ model: null });
  });

  it("knows the classes, the deployment's models, the agent's own and the listed ones, and nothing else", () => {
    for (const m of ["default", "bulk", KNOWN.default, KNOWN.bulk, KNOWN.own, "@cf/zai-org/glm-4.7-flash"]) expect(knownModel(m, KNOWN), m).toBe(true);
    for (const m of ["claude-opus-anything", "@cf/unlisted/model", "constructor", "toString"]) expect(knownModel(m, KNOWN), m).toBe(false);
  });

  it("fails closed on an intent whose source is missing or unknown", () => {
    for (const source of [undefined, null, "", "mystery"]) {
      const c = modelLineChoice("default", source, KNOWN);
      expect(c.model, String(source)).toBeNull();
      expect(c.ignored).toContain("nothing says a person or a rule declared it");
    }
  });

  it("quotes a long or odd model name on one short line", () => {
    const c = modelLineChoice(`x${"y".repeat(300)}`, "agent", KNOWN);
    expect(c.ignored).toMatch(/"Model: xy+…" line was ignored/);
    expect(c.ignored!.length).toBeLessThan(400);
  });
});
