import { describe, expect, it } from "vitest";
import type { LineageNote, NoteProvenance } from "@fire_trident/core";
import { provenanceOf } from "../src/lineage.ts";
import { ColonySim } from "../src/mock.ts";

/** The Why panel's provenance line: who ran a change's agent and whether its model was observed by FireTrident or declared. */

type NoteProposal = LineageNote["proposals"][number];
const GEMMA = "@cf/google/gemma-4-26b-a4b-it";

const proposal = (provenance: unknown, model?: string): NoteProposal =>
  ({
    id: "prp_1",
    agentId: "agt_1",
    agentKind: "internal",
    ...(model ? { model } : {}),
    intent: { id: "int_1", title: "t", why: "" },
    writeSet: [],
    readSet: [],
    decisions: [],
    evidence: { checks: [] },
    ...(provenance !== undefined ? { provenance: provenance as NoteProvenance } : {}),
  }) as NoteProposal;

describe("provenanceOf", () => {
  it("says FireTrident observed an in-platform agent's model, with what it counted", () => {
    const p = proposal({ author: "platform", auth: "platform", model: { evidence: "observed", name: GEMMA, observed: [{ model: GEMMA, calls: 3, inputTokens: 4120, outputTokens: 812 }] } }, GEMMA);
    expect(provenanceOf(p)).toEqual({ author: "Run by FireTrident", level: "observed", label: "Model observed by FireTrident", detail: "3 calls · 4,120 in / 812 out tokens" });
    const other = proposal({ author: "platform", model: { evidence: "observed", name: GEMMA, observed: [{ model: "@cf/openai/gpt-oss-120b", calls: 1 }] } }, GEMMA);
    expect(provenanceOf(other)?.detail).toBe("@cf/openai/gpt-oss-120b · 1 call");
    expect(provenanceOf(proposal({ author: "platform", model: { evidence: "observed", name: GEMMA } }, GEMMA))?.detail).toBe("No model call recorded for this change");
  });

  it("says an external agent declared its model, and what authenticated it when the colony said", () => {
    expect(provenanceOf(proposal({ author: "external", auth: "mcp", model: { evidence: "declared", name: "claude-sonnet-5-5" } }, "claude-sonnet-5-5"))).toEqual({
      author: "External agent: the MCP token and its resume key",
      level: "declared",
      label: "Model declared by the agent",
    });
    expect(provenanceOf(proposal({ author: "external", model: { evidence: "declared", name: "x-1" } }))).toEqual({ author: "External agent: the MCP or API token", level: "declared", label: "Model declared by the agent", detail: "x-1" });
    expect(provenanceOf(proposal({ author: "external", auth: "token" }))).toEqual({ author: "External agent: a deployment token, not bound to it", level: "unknown", label: "Model not known" });
    expect(provenanceOf(proposal({ author: "synthetic" }))).toMatchObject({ author: "Bench agent", level: "unknown" });
  });

  it("reads notes written before provenance as none, and values it does not know as they are", () => {
    for (const raw of [undefined, null, "platform", [1], 3]) expect(provenanceOf(proposal(raw))).toBeNull();
    expect(provenanceOf(proposal({ author: "robot", model: { evidence: "guessed", name: "m" } }))).toEqual({ author: "Author: robot", level: "unknown", label: "Model guessed", detail: "m" });
    expect(provenanceOf(proposal({ model: { evidence: "observed", observed: [null, "x", { calls: -1 }] } }))).toEqual({
      author: "Author not known",
      level: "observed",
      label: "Model observed by FireTrident",
      detail: "No model call recorded for this change",
    });
  });

  it("is on every note the demo colony writes", () => {
    const sim = new ColonySim("demo", { files: 0, agents: 64, speed: 20, seed: 11 });
    let now = Date.now();
    for (let i = 0; i < 200; i++) sim.step((now += 250));
    const paths = [...new Set(sim.snapshot().recentLandings.flatMap((l) => l.paths))].slice(0, 5);
    const views = paths.flatMap((path) => sim.why(path)).flatMap((e) => e.note.proposals.map(provenanceOf));
    expect(views.length).toBeGreaterThan(0);
    expect(views.every((v) => v !== null && (v.level === "observed" || v.level === "declared"))).toBe(true);
  });
});
