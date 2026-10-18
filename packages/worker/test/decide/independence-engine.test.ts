import { describe, expect, it } from "vitest";
import type { Colony, Decision, Id, Intent, Landing, Proposal } from "@fire_trident/core";
import type { Env } from "../../src/env.ts";
import { DecideEngine, type DecideHost, type DecisionInput, type TrunkRpc } from "../../src/decide/engine.ts";
import { AUTHOR_MODEL_UNREPORTED, NO_INDEPENDENT_RULE, reviewerPick } from "../../src/decide/independence.ts";
import { DEFAULT_POLICY, modelFamily } from "../../src/decide/policy.ts";
import type { AiRunner, ClefAnswer } from "../../src/decide/reflex.ts";

/**
 * Second-opinion independence (decide/independence.ts, decide/gate.ts L9): the model that confirms a change is never of
 * the author's model family. With every configured second-opinion model in that family, no model is asked and the change
 * goes to a person with the reason; an author that reported no model is reviewed as before, and the decision's detail
 * says independence was not checked. The default configuration never collides, so stage behavior does not change.
 */

interface DatabaseSync {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  exec(sql: string): void;
}
const SQLITE = "node:sqlite";
const { DatabaseSync } = (await import(SQLITE)) as { DatabaseSync: new (path: string) => DatabaseSync };
const FS = "node:fs";
const { readFileSync } = (await import(FS)) as { readFileSync(path: URL, encoding: "utf8"): string };
const HERE = (import.meta as ImportMeta & { url: string }).url;

function sqlStorage(): SqlStorage {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE proposals (id TEXT PRIMARY KEY, status TEXT NOT NULL)");
  return {
    exec(query: string, ...bindings: unknown[]) {
      const rows = db.prepare(query).all(...bindings);
      return { toArray: () => rows, one: () => rows[0], [Symbol.iterator]: () => rows[Symbol.iterator]() };
    },
  } as unknown as SqlStorage;
}

const GEMMA = "@cf/google/gemma-4-26b-a4b-it";
const GEMMA_SMALL = "@cf/google/gemma-3-12b-it";
const GPT = "@cf/openai/gpt-oss-120b";
const COLONY: Colony = { id: "c1", name: "c1", trunk: { namespace: "ft-trunk", name: "c1", remote: "" }, trunkSha: "0".repeat(40), createdAt: 0, regionDepth: 1 };
const CLEAN: Record<string, ClefAnswer> = {
  needs_human: { type: "noul", noul: 0.03 },
  touches_sensitive: { type: "noul", noul: 0.02 },
  off_intent: { type: "noul", noul: 0.02 },
  risk: { type: "score", score: 0.4, probabilities: {}, confidence: 0.9 },
};
const APPROVE = { verdict: "approve", needs_human: 0.05, off_intent: false, sensitive: false, confidence: 0.95, reason: "does what the intent asks" };
const MODULE = "export function add(a: number, b: number): number {\n  return a + b;\n}\n";

/** The AI binding: Clef answers clean, the second opinion approves; every call is recorded. */
class FakeAi implements AiRunner {
  calls: Array<{ model: string; kind: "clef" | "opinion" }> = [];
  async run(model: string, input: Record<string, unknown>): Promise<unknown> {
    if (input.questions) {
      this.calls.push({ model, kind: "clef" });
      return { answers: Object.fromEntries(Object.keys(input.questions as object).map((id) => [id, CLEAN[id] ?? { type: "noul", noul: 0.02 }])), usage: { input_tokens: 100 } };
    }
    this.calls.push({ model, kind: "opinion" });
    return { response: JSON.stringify(APPROVE), usage: { prompt_tokens: 100, completion_tokens: 10 } };
  }
}

/** One colony around the engine; its agent reports `authorModel` (undefined: no model reported). */
class Colonyish implements DecideHost {
  readonly ai = new FakeAi();
  readonly blobs = new Map<string, string>();
  readonly env: Env;
  readonly sql = sqlStorage();
  readonly proposals = new Map<Id, Proposal>();
  readonly intents = new Map<Id, Intent>();
  readonly decisions: Decision[] = [];
  readonly pending: Array<Promise<unknown>> = [];
  readonly engine: DecideEngine;
  private seq = 0;

  constructor(private readonly authorModel: string | undefined) {
    const blobs = this.blobs;
    const artifacts = { get: async () => ({ readBlob: async (sha: string) => (blobs.has(sha) ? new Blob([blobs.get(sha)!]) : null) }) };
    this.env = { AI: this.ai, ARTIFACTS: artifacts } as unknown as Env;
    this.engine = new DecideEngine(this);
  }
  waitUntil(p: Promise<unknown>): void {
    this.pending.push(p);
  }
  colony(): Colony {
    return COLONY;
  }
  intent(id: Id): Intent | null {
    return this.intents.get(id) ?? null;
  }
  rules() {
    return [];
  }
  agent() {
    return { kind: "external" as const, name: "a", ...(this.authorModel ? { model: this.authorModel } : {}) };
  }
  proposal(id: Id): Proposal | null {
    return this.proposals.get(id) ?? null;
  }
  proposalRegion(): string {
    return "src";
  }
  stuckChecking(): Id[] {
    return [];
  }
  async updateProposals(items: Array<{ id: Id; patch: Partial<Proposal> }>): Promise<void> {
    for (const { id, patch } of items) this.save({ ...this.proposals.get(id)!, ...patch });
  }
  async recordDecision(d: DecisionInput): Promise<Decision> {
    const decision: Decision = { ...d, id: `dec_${++this.seq}`, colonyId: COLONY.id, at: d.at ?? Date.now() };
    this.decisions.push(decision);
    return decision;
  }
  decisionsFor(subject: Id): Decision[] {
    return this.decisions.filter((d) => d.subject === subject);
  }
  bump(): void {}
  setMetric(): void {}
  emit(): void {}
  trunk(): TrunkRpc {
    return {
      baseBlobs: async () => [],
      blobsFor: async (paths) => Object.fromEntries(paths.map((p) => [p, null])),
      readFile: async () => null,
      files: async () => [],
      systemCommit: async () => ({ id: "lnd_ab", colonyId: COLONY.id, trunkSha: "1".repeat(40) }) as unknown as Landing,
    };
  }
  async systemCommitted(): Promise<void> {}
  async vaccineAgent(): Promise<Id> {
    return "agt_vaccine";
  }
  vaccineTargets() {
    return [];
  }
  sealedIntent(): Id {
    return "int_sealed";
  }
  async propose(): Promise<Proposal> {
    throw new Error("not used");
  }
  seal(): void {}
  save(p: Proposal): void {
    this.proposals.set(p.id, p);
    this.sql.exec("INSERT INTO proposals (id, status) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status", p.id, p.status);
  }

  /** Propose a new file (no proof: it needs the second opinion) and run the pipeline on it. */
  async decide(path = "src/add.ts"): Promise<Proposal> {
    const intent: Intent = { id: `int_${++this.seq}`, colonyId: COLONY.id, title: "Add the module", why: "The spec asks for it.", source: "human", footprint: [path], priority: 1, status: "proposed", createdAt: 0, createdBy: "t" };
    this.intents.set(intent.id, intent);
    const blob = `${(++this.seq).toString(16).padStart(8, "0")}${"a".repeat(32)}`;
    this.blobs.set(blob, MODULE);
    const p: Proposal = {
      id: `prp_${++this.seq}`,
      colonyId: COLONY.id,
      intentId: intent.id,
      agentId: "agt_1",
      workspace: { namespace: "ft-trunk", name: "ws", remote: "" },
      baseSha: COLONY.trunkSha,
      headSha: `${this.seq}`.padStart(40, "f"),
      writeSet: [{ path, blob }],
      readSet: [],
      declared: { footprint: intent.footprint, summary: "Add the module" },
      evidence: { checks: [], notVerified: "Not verified: no tests were run." },
      status: "checking",
      createdAt: Date.now(),
    };
    this.save(p);
    await this.engine.run(p.id);
    await Promise.all(this.pending);
    return this.proposals.get(p.id)!;
  }
}

describe("second-opinion independence", () => {
  it("with every second-opinion model in the author's family, asks none of them and sends the change to a person", async () => {
    const c = new Colonyish(GEMMA);
    // Even past the alert budget: the change cannot go back on that, it waits for a person.
    c.engine.store.setPolicy({ secondOpinionModels: [GEMMA, GEMMA_SMALL], alertsPerHour: 0 });
    const p = await c.decide();
    expect(c.ai.calls.map((k) => k.kind)).toEqual(["clef"]);
    expect(p.status).toBe("escalated");
    const reason = `no reviewer model outside the author's model family (google) is configured: every second-opinion model (${GEMMA}, ${GEMMA_SMALL}) is google's, so no model can confirm this change and a person decides; add a second-opinion model from another family to the colony's decide policy`;
    expect(p.reason).toBe(`escalated by llm: ${reason}`);
    const checks = p.evidence.checks;
    expect(checks.find((k) => k.name.startsWith("llm:"))).toMatchObject({ name: "llm: none", ok: false, detail: `unavailable: ${reason}` });
    expect(checks.find((k) => k.name === "gate")!.detail).toMatch(new RegExp(`^${NO_INDEPENDENT_RULE} → escalate by llm`));
    const llm = c.decisions.filter((d) => d.subject === p.id && d.layer === "llm");
    expect(llm).toHaveLength(1);
    expect(llm[0]!.answers).toMatchObject({ error: reason, rule: NO_INDEPENDENT_RULE, independence: reason });
    expect(llm[0]!.answers.verdict).toBeUndefined();
    expect(llm[0]!.action).toBe("escalate");
    // Nothing about the change was found wrong: its region keeps its autonomy.
    expect(c.engine.store.autonomyTable(0).find((r) => r.region === "src")?.revokedAt ?? null).toBeNull();
  });

  it("with one model outside the author's family, asks only that one and lands on its approval", async () => {
    const c = new Colonyish(GEMMA);
    c.engine.store.setPolicy({ secondOpinionModels: [GEMMA, GPT] });
    const p = await c.decide();
    expect(c.ai.calls).toEqual([
      { model: DEFAULT_POLICY.reflexModel, kind: "clef" },
      { model: GPT, kind: "opinion" },
    ]);
    expect(p.status).toBe("ready");
    const llm = c.decisions.find((d) => d.subject === p.id && d.layer === "llm")!;
    expect(llm.answers).not.toHaveProperty("independence");
    expect(p.evidence.checks.find((k) => k.name.startsWith("llm:"))!.detail).not.toContain("not reported");
  });

  it("an author that reported no model: reviewed as before, and the decision says independence was not checked", async () => {
    const c = new Colonyish(undefined);
    c.engine.store.setPolicy({ secondOpinionModels: [GEMMA, GEMMA_SMALL] });
    const p = await c.decide();
    expect(c.ai.calls.map((k) => [k.kind, k.model])).toEqual([
      ["clef", DEFAULT_POLICY.reflexModel],
      ["opinion", GEMMA],
    ]);
    expect(p.status).toBe("ready");
    const check = p.evidence.checks.find((k) => k.name === `llm: ${GEMMA}`)!;
    expect(check.detail).toMatch(/^approve, needs_human 0\.05: does what the intent asks; /);
    expect(check.detail?.endsWith(`; ${AUTHOR_MODEL_UNREPORTED}`)).toBe(true);
    expect(c.decisions.find((d) => d.subject === p.id && d.layer === "llm")!.answers).toMatchObject({ independence: AUTHOR_MODEL_UNREPORTED, model: GEMMA });
  });
});

describe("the default configuration never collides", () => {
  type Vars = Record<string, unknown>;
  const config = JSON.parse(readFileSync(new URL("../../wrangler.jsonc", HERE), "utf8")) as { vars?: Vars; env?: Record<string, { vars?: Vars }>; previews?: { vars?: Vars } };
  // Production, every named environment (the stage among them) and previews.
  const varSets = [config.vars ?? {}, ...Object.values(config.env ?? {}).map((e) => e.vars ?? {}), config.previews?.vars ?? {}];
  // Every model a deployment's agents or the platform write with (the configured ones), and every model the policy names.
  const configured = varSets.flatMap((v) => Object.entries(v).filter(([k, x]) => /^FT_.*MODEL$/.test(k) && typeof x === "string" && x !== "").map(([, x]) => x as string));
  const authors = [...new Set([...configured, ...DEFAULT_POLICY.secondOpinionModels, ...DEFAULT_POLICY.juryModels, DEFAULT_POLICY.reflexModel])];

  it("reads the deployments' models, the stage's among them", () => {
    expect(varSets.length).toBeGreaterThanOrEqual(2);
    expect(configured).toContain("@cf/moonshotai/kimi-k2.7-code");
  });

  it("leaves at least one independent second opinion for every author model, so no change is refused for it", () => {
    for (const author of authors) {
      const pick = reviewerPick(author, DEFAULT_POLICY.secondOpinionModels);
      expect(pick.refusal, author).toBeUndefined();
      expect(pick.models.length, author).toBeGreaterThan(0);
      expect(pick.models.every((m) => modelFamily(m) !== modelFamily(author)), author).toBe(true);
    }
    // Three families, so any one author leaves two.
    expect(new Set(DEFAULT_POLICY.secondOpinionModels.map(modelFamily)).size).toBe(3);
  });

  it("refuses only when every candidate shares the author's family, and never for an unknown author", () => {
    expect(reviewerPick(GEMMA, [GEMMA_SMALL]).refusal).toMatch(/^no reviewer model outside the author's model family \(google\) is configured/);
    expect(reviewerPick(undefined, [GEMMA_SMALL])).toEqual({ models: [GEMMA_SMALL], unchecked: AUTHOR_MODEL_UNREPORTED });
    expect(reviewerPick("", [GEMMA_SMALL])).toEqual({ models: [GEMMA_SMALL], unchecked: AUTHOR_MODEL_UNREPORTED });
    expect(reviewerPick(GPT, [GEMMA, GPT])).toEqual({ models: [GEMMA] });
  });
});
