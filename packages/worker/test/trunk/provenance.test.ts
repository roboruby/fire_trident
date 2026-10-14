import { describe, expect, it } from "vitest";
import type { Evidence, LineageNote } from "@fire_trident/core";
import { MASKED, maskNote } from "../../src/trunk/mask.ts";
import { MODEL_USAGE_CHECK, noteProvenance, observedModels } from "../../src/trunk/provenance.ts";

/** The usage check as the agent loop writes it (agents/loop.ts, telemetryChecks). */
const usage = (detail: string, ms = 1_200) => ({ name: MODEL_USAGE_CHECK, ok: true, ms, detail });
const GEMMA = "@cf/google/gemma-4-26b-a4b-it";

describe("noteProvenance: how a landed change's author and model are known", () => {
  it("reads an in-platform agent's model as observed, with the calls and tokens its loop counted", () => {
    const evidence: Evidence = { checks: [{ name: "recheck src/a.ts", ok: true, ms: 3 }, usage(`${GEMMA}: 3 call(s), 4120 input / 812 output tokens (100 cached), 12.5 neurons`)] };
    expect(noteProvenance({ kind: "internal", model: GEMMA }, evidence)).toEqual({
      author: "platform",
      auth: "platform",
      model: { evidence: "observed", name: GEMMA, observed: [{ model: GEMMA, calls: 3, inputTokens: 4120, outputTokens: 812, cachedTokens: 100 }] },
    });
  });

  it("names the model an intent asked for when it is not the agent's own, and adds up repeated checks per model", () => {
    const other = "@cf/openai/gpt-oss-120b";
    const evidence: Evidence = { checks: [usage(`${other}: 2 call(s), 10 input / 5 output tokens`), usage(`${other}: 1 call(s), 1 input / 1 output tokens`)] };
    expect(noteProvenance({ kind: "internal", model: GEMMA }, evidence)?.model).toEqual({ evidence: "observed", name: GEMMA, observed: [{ model: other, calls: 3, inputTokens: 11, outputTokens: 6 }] });
  });

  it("keeps an in-platform agent observed without usage (a deterministic edit, or none reported), and claims no model it does not know", () => {
    expect(noteProvenance({ kind: "internal", model: GEMMA }, { checks: [] })).toEqual({ author: "platform", auth: "platform", model: { evidence: "observed", name: GEMMA } });
    expect(noteProvenance({ kind: "internal" }, { checks: [] })).toEqual({ author: "platform", auth: "platform" });
  });

  it("keeps an external agent's model declared however its evidence is worded", () => {
    const forged: Evidence = { checks: [usage(`${GEMMA}: 3 call(s), 4120 input / 812 output tokens`), { name: "model observed by FireTrident", ok: true, ms: 0 }], notVerified: "Model observed by FireTrident." };
    expect(noteProvenance({ kind: "external", model: "claude-sonnet-5-5" }, forged)).toEqual({ author: "external", model: { evidence: "declared", name: "claude-sonnet-5-5" } });
    // Without a model on its record, the name its proposal gives is still only declared, with no counts.
    expect(noteProvenance({ kind: "external" }, forged)).toEqual({ author: "external", model: { evidence: "declared", name: GEMMA } });
    expect(noteProvenance({ kind: "external" }, { checks: [] })).toEqual({ author: "external" });
  });

  it("says what authenticated an external agent only when the colony said whether it holds a resume key", () => {
    expect(noteProvenance({ kind: "external", model: "m", resumeKey: true }, undefined)?.auth).toBe("mcp");
    expect(noteProvenance({ kind: "external", model: "m", resumeKey: false }, undefined)?.auth).toBe("token");
    expect(noteProvenance({ kind: "external", model: "m" }, undefined)).not.toHaveProperty("auth");
    expect(noteProvenance({ kind: "synthetic", resumeKey: true }, undefined)).toEqual({ author: "synthetic" });
  });

  it("calls a bench agent synthetic, with its model declared when its record names one", () => {
    expect(noteProvenance({ kind: "synthetic" }, { checks: [] })).toEqual({ author: "synthetic" });
    expect(noteProvenance({ kind: "synthetic", model: "rule-replacement" }, { checks: [usage(`${GEMMA}: 1 call(s), 1 input / 1 output tokens`)] })).toEqual({
      author: "synthetic",
      model: { evidence: "declared", name: "rule-replacement" },
    });
  });

  it("claims nothing for an agent the writer does not know, or a kind it does not know", () => {
    expect(noteProvenance(undefined, { checks: [] })).toBeUndefined();
    expect(noteProvenance({ kind: "robot" } as never, { checks: [] })).toBeUndefined();
  });

  it("reads malformed evidence without failing", () => {
    for (const evidence of [undefined, {} as Evidence, { checks: "x" } as never, { checks: [null, 3, "x", { name: MODEL_USAGE_CHECK }, { name: MODEL_USAGE_CHECK, detail: 7 }, usage("no counts here")] } as never]) {
      expect(noteProvenance({ kind: "internal", model: GEMMA }, evidence)).toEqual({ author: "platform", auth: "platform", model: { evidence: "observed", name: GEMMA } });
    }
  });

  it("keeps model names to one line and 200 characters, and lists at most 8 models", () => {
    expect(noteProvenance({ kind: "external", model: `  a\nb ${"x".repeat(300)}` }, undefined)?.model?.name).toBe(`a b ${"x".repeat(196)}`);
    const many: Evidence = { checks: Array.from({ length: 12 }, (_, i) => usage(`m${i}: 1 call(s), 1 input / 1 output tokens`)) };
    expect(observedModels(many).map((m) => m.model)).toEqual(["m0", "m1", "m2", "m3", "m4", "m5", "m6", "m7"]);
  });

  it("is masked like the rest of a note's free text", () => {
    const key = "ghp_abcdefghijklmnopqrstuvwxyz0123456789AB";
    const note: LineageNote = {
      schema: "firetrident.lineage/v1",
      landingId: "lnd_1",
      colonyId: "c",
      proposals: [
        {
          id: "prp_1",
          agentId: "agt_1",
          agentKind: "external",
          intent: { id: "int_1", title: "t", why: "w" },
          writeSet: [],
          readSet: [],
          decisions: [],
          evidence: { checks: [] },
          provenance: { author: "external", auth: "mcp", model: { evidence: "declared", name: `token ${key}` } },
        },
      ],
    };
    expect(maskNote(note).proposals[0]?.provenance).toEqual({ author: "external", auth: "mcp", model: { evidence: "declared", name: `token ${MASKED}` } });
  });
});
