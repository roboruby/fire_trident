import type { AgentKind, Evidence, NoteProvenance, ObservedModel, ProvenanceAuth } from "@fire_trident/core";

/**
 * Provenance: how a landed change's author and model are known. The trunk writer computes it for each proposal of a
 * lineage note from the colony's record of the agent (its kind, its model, whether it holds an MCP resume key), never
 * from what the proposal says about itself:
 * - an in-platform agent (`internal`) is FireTrident's own agent object, which makes every model call itself, so its
 *   model is `observed`, with the calls and tokens its loop counted (the `agent model usage` check of agents/loop.ts),
 *   and named after the model those calls went to: an intent may ask for a model that is not the agent's own;
 * - an external agent's model is the name it gave when it joined, or failing that the one its proposal names: `declared`,
 *   however it is worded; the same holds for a bench agent (`synthetic`), which FireTrident does not run.
 * Pure: no I/O.
 */

/** The evidence check an in-platform agent's loop writes with the model calls it made (agents/loop.ts, telemetryChecks). */
export const MODEL_USAGE_CHECK = "agent model usage";

/** What the colony records about an agent, as the land context carries it. */
export interface ProvenanceAgent {
  kind: AgentKind;
  model?: string;
  /** External agents: whether the agent holds an MCP resume key (it joined over MCP); absent when the colony did not say. */
  resumeKey?: boolean;
}

/** Longest model name a note keeps. */
const MAX_MODEL = 200;
/** Models listed per proposal at most. */
const MAX_MODELS = 8;
/** "<model>: <n> call(s), <in> input / <out> output tokens[ (<cached> cached)]", as the agent loop writes it. */
const USAGE = /^(.+?): (\d+) call\(s\), (\d+) input \/ (\d+) output tokens(?: \((\d+) cached\))?/;

/**
 * The provenance of one proposal from its agent's record and its evidence, or undefined when the colony's record of the
 * agent is unknown (nothing is claimed then). Only an in-platform agent's evidence is read for model usage: that check
 * is written by FireTrident's own agent loop. For any other agent a model named in its evidence stays declared.
 */
export function noteProvenance(agent: ProvenanceAgent | undefined, evidence: Evidence | undefined): NoteProvenance | undefined {
  if (!agent || typeof agent !== "object") return undefined;
  const name = modelName(agent.model);
  if (agent.kind === "internal") {
    const observed = observedModels(evidence);
    // The model the calls went to names the change; the agent's own model only when no call was counted.
    const used = mostCalls(observed) ?? name;
    const model = used || observed.length > 0 ? { evidence: "observed" as const, ...(used ? { name: used } : {}), ...(observed.length > 0 ? { observed } : {}) } : undefined;
    return { author: "platform", auth: "platform", ...(model ? { model } : {}) };
  }
  if (agent.kind !== "external" && agent.kind !== "synthetic") return undefined;
  const declared = name ?? observedModels(evidence)[0]?.model;
  const auth: ProvenanceAuth | undefined = agent.kind === "external" && typeof agent.resumeKey === "boolean" ? (agent.resumeKey ? "mcp" : "token") : undefined;
  return {
    author: agent.kind,
    ...(auth ? { auth } : {}),
    ...(declared ? { model: { evidence: "declared" as const, name: declared } } : {}),
  };
}

/** The model with the most calls (the first of equals), or undefined when none was counted. */
function mostCalls(observed: readonly ObservedModel[]): string | undefined {
  let best: ObservedModel | undefined;
  for (const o of observed) if (!best || (o.calls ?? 0) > (best.calls ?? 0)) best = o;
  return best?.model;
}

/**
 * The model calls an evidence's usage checks record, per model in order of first appearance (at most MAX_MODELS). A check
 * whose detail does not read as usage is skipped; so is everything that is not a check.
 */
export function observedModels(evidence: Evidence | undefined): ObservedModel[] {
  const checks: unknown[] = Array.isArray(evidence?.checks) ? evidence.checks : [];
  const out = new Map<string, Required<Omit<ObservedModel, "cachedTokens">> & { cachedTokens: number }>();
  for (const c of checks) {
    if (!c || typeof c !== "object") continue;
    const { name, detail } = c as { name?: unknown; detail?: unknown };
    if (name !== MODEL_USAGE_CHECK || typeof detail !== "string") continue;
    const m = USAGE.exec(detail.slice(0, 1_000));
    const model = m ? modelName(m[1]) : undefined;
    if (!m || !model) continue;
    let entry = out.get(model);
    if (!entry) {
      if (out.size >= MAX_MODELS) continue;
      entry = { model, calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
      out.set(model, entry);
    }
    entry.calls += Number(m[2]);
    entry.inputTokens += Number(m[3]);
    entry.outputTokens += Number(m[4]);
    entry.cachedTokens += Number(m[5] ?? 0);
  }
  return [...out.values()].map(({ cachedTokens, ...rest }) => (cachedTokens > 0 ? { ...rest, cachedTokens } : rest));
}

/** A model name as a note keeps it: one line, at most MAX_MODEL characters; undefined when empty or not a string. */
function modelName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const name = raw.replace(/\s+/g, " ").trim().slice(0, MAX_MODEL);
  return name === "" ? undefined : name;
}
