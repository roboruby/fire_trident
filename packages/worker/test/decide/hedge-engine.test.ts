import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Colony, Decision, Id, Intent, Landing, Proposal } from "@fire_trident/core";
import type { Env } from "../../src/env.ts";
import { noteDecisions, type DecisionRow } from "../../src/colony/direction.ts";
import { DecideEngine, type DecideHost, type DecisionInput, type TrunkRpc } from "../../src/decide/engine.ts";
import type { ClefAnswer } from "../../src/decide/reflex.ts";

/**
 * Hedged model calls in the decide stage (FT_HEDGE): a colony in memory around the engine, with a Workers AI binding
 * whose models answer when the test says. The clock and timers are faked, so the hedge's waits are exact.
 */

interface DatabaseSync {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  exec(sql: string): void;
}
const SQLITE = "node:sqlite";
const { DatabaseSync } = (await import(SQLITE)) as { DatabaseSync: new (path: string) => DatabaseSync };

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

const COLONY: Colony = { id: "c1", name: "c1", trunk: { namespace: "ft-trunk", name: "c1", remote: "" }, trunkSha: "0".repeat(40), createdAt: 0, regionDepth: 1 };
const CLEAN: Record<string, ClefAnswer> = {
  needs_human: { type: "noul", noul: 0.03 },
  touches_sensitive: { type: "noul", noul: 0.02 },
  off_intent: { type: "noul", noul: 0.02 },
  risk: { type: "score", score: 0.4, probabilities: {}, confidence: 0.9 },
};
const APPROVE = { verdict: "approve", needs_human: 0.05, off_intent: false, sensitive: false, confidence: 0.95, reason: "does what the intent asks" };
/** The policy's first two second-opinion candidates for an author outside both families. */
const GEMMA = "@cf/google/gemma-4-26b-a4b-it";
const GPT = "@cf/openai/gpt-oss-120b";
const CLEF = "@cf/cloudflare/clef";

/** One run as the binding saw it. */
interface Run {
  model: string;
  kind: "clef" | "opinion";
  signal: AbortSignal | undefined;
  aborted: boolean;
}

/**
 * The AI binding: Clef answers clean and the second opinion approves, each run with usage (Clef 50 input tokens, a
 * second opinion 100 in and 20 out, more on later runs so each can be told apart). A run of a model in `slow` answers
 * only after SLOW_MS; with `stops`, it fails at once when aborted, else it notes the abort and answers anyway.
 */
class FakeAi {
  runs: Run[] = [];
  slow = new Map<string, number>();
  stops = false;
  async run(model: string, input: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<unknown> {
    const kind = input.questions ? "clef" : "opinion";
    const run: Run = { model, kind, signal: options?.signal, aborted: false };
    const n = this.runs.push(run);
    const reply =
      kind === "clef"
        ? { answers: Object.fromEntries(Object.keys(input.questions as object).map((id) => [id, CLEAN[id] ?? { type: "noul", noul: 0.02 }])), usage: { input_tokens: 50 * n } }
        : { response: JSON.stringify(APPROVE), usage: { prompt_tokens: 100 * n, completion_tokens: 20 * n } };
    const ms = this.slow.get(model) ?? 0;
    if (ms === 0) return reply;
    this.slow.delete(model);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(reply), ms);
      options?.signal?.addEventListener("abort", () => {
        run.aborted = true;
        if (this.stops) {
          clearTimeout(timer);
          reject(new Error("The operation was aborted"));
        }
      });
    });
  }
  of(kind: Run["kind"]): Run[] {
    return this.runs.filter((r) => r.kind === kind);
  }
}

/** One colony around the engine, its counters and its spend per intent kept. */
class Colonyish implements DecideHost {
  readonly ai = new FakeAi();
  readonly blobs = new Map<string, string>();
  readonly env: Env;
  readonly sql = sqlStorage();
  readonly proposals = new Map<Id, Proposal>();
  readonly intents = new Map<Id, Intent>();
  readonly decisions: Decision[] = [];
  readonly counters: Record<string, number> = {};
  readonly intentCalls: Array<{ model: string; input?: number; output?: number }> = [];
  readonly engine: DecideEngine;
  private seq = 0;

  constructor(vars: { FT_HEDGE?: string; FT_HEDGE_MS?: string } = {}) {
    const blobs = this.blobs;
    const artifacts = { get: async () => ({ readBlob: async (sha: string) => (blobs.has(sha) ? new Blob([blobs.get(sha)!]) : null) }) };
    this.env = { AI: this.ai, ARTIFACTS: artifacts, ...vars } as unknown as Env;
    this.engine = new DecideEngine(this);
  }
  waitUntil(): void {}
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
    return { kind: "external" as const, name: "a", model: "@cf/example/author-model" };
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
  bump(name: string, delta: number): void {
    this.counters[name] = (this.counters[name] ?? 0) + delta;
  }
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
  countIntentCall(_intentId: Id, _layer: "review" | "judge", model: string, usage: { input?: number; output?: number } | null): void {
    this.intentCalls.push({ model, ...(usage ?? {}) });
  }
  save(p: Proposal): void {
    this.proposals.set(p.id, p);
    this.sql.exec("INSERT INTO proposals (id, status) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status", p.id, p.status);
  }

  /** A person's intent for one new module, proposed: its pipeline runs (the second opinion is asked). */
  start(): { id: Id; done: Promise<void> } {
    const intent: Intent = { id: `int_${++this.seq}`, colonyId: COLONY.id, title: "Add the module", why: "The spec asks for it.", source: "human", footprint: ["src/add.ts"], priority: 1, status: "proposed", createdAt: 0, createdBy: "t" };
    this.intents.set(intent.id, intent);
    const blob = `${(++this.seq).toString(16).padStart(8, "0")}${"a".repeat(32)}`;
    this.blobs.set(blob, "export function add(a: number, b: number): number {\n  return a + b;\n}\n");
    const p: Proposal = {
      id: `prp_${++this.seq}`,
      colonyId: COLONY.id,
      intentId: intent.id,
      agentId: "agt_1",
      workspace: { namespace: "ft-trunk", name: "ws", remote: "" },
      baseSha: COLONY.trunkSha,
      headSha: `${this.seq}`.padStart(40, "f"),
      writeSet: [{ path: "src/add.ts", blob }],
      readSet: [],
      declared: { footprint: intent.footprint, summary: "Add the module" },
      evidence: { checks: [], notVerified: "Not verified: no tests were run." },
      status: "checking",
      createdAt: Date.now(),
    };
    this.save(p);
    return { id: p.id, done: this.engine.run(p.id) };
  }

  /** Let the pipeline run on until `cond` holds, without moving the fake clock. */
  async until(cond: () => boolean): Promise<void> {
    for (let i = 0; i < 1_000 && !cond(); i++) await new Promise<void>((resolve) => setImmediate(resolve));
    expect(cond()).toBe(true);
  }
}

/** Decisions as ColonyDO stores them, for the lineage note. */
function rows(decisions: Decision[]): DecisionRow[] {
  return decisions.map((d) => ({ id: d.id, kind: d.kind, subject: d.subject, layer: d.layer, answers: JSON.stringify(d.answers), p: d.p, action: d.action, at: d.at }));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the second opinion, hedged", () => {
  it("takes the copy's answer from the next candidate when the original is slow, aborts the original, counts both, and records it", async () => {
    const c = new Colonyish({ FT_HEDGE: "on" });
    c.ai.slow.set(GEMMA, 30_000);
    const { id, done } = c.start();
    await c.until(() => c.ai.of("opinion").length === 1);
    await vi.advanceTimersByTimeAsync(12_000);
    await done;
    const p = c.proposals.get(id)!;
    expect(p.status).toBe("ready");
    const [original, copy] = c.ai.of("opinion");
    expect([original!.model, copy!.model]).toEqual([GEMMA, GPT]);
    expect(original!.aborted).toBe(true);
    // The decision record and the model's check say which copy answered.
    const llm = c.decisions.find((d) => d.layer === "llm")!;
    expect(llm.answers).toMatchObject({ model: GPT, verdict: { verdict: "approve", model: GPT }, hedged: { after_ms: 12_000, winner: "copy", model: GPT, cause: "slow" } });
    const check = p.evidence.checks.find((k) => k.name.startsWith("llm:"))!;
    expect(check.name).toBe(`llm: ${GPT}`);
    expect(check.detail).toContain(`answered by the hedge copy to ${GPT} after 12.0 s`);
    // So does the landing's lineage note, decision by decision.
    const note = noteDecisions(rows(c.decisions))[id]!.find((d) => d.layer === "llm")!;
    expect(note).toMatchObject({ by: GPT, answer: "approve (answered by the hedge copy after 12.0 s): does what the intent asks" });
    expect(c.counters).toMatchObject({ "hedge.review.sent": 1, "hedge.review.copy": 1 });
    // The copy's tokens count as it answers (the third run: 300 in, 60 out)...
    expect(c.counters).toMatchObject({ "decide.llm.tokensIn": 300, "decide.llm.tokensOut": 60, [`decide.llm.tokensIn:${GPT}`]: 300 });
    expect(c.counters[`decide.llm.tokensIn:${GEMMA}`]).toBeUndefined();
    // ...and the original's when it answers anyway (the second run: 200 in, 40 out), under its own model.
    await vi.advanceTimersByTimeAsync(18_000);
    expect(c.counters).toMatchObject({ "decide.llm.tokensIn": 500, "decide.llm.tokensOut": 100, [`decide.llm.tokensIn:${GEMMA}`]: 200, [`decide.llm.tokensOut:${GEMMA}`]: 40 });
    expect(c.intentCalls.filter((u) => u.model !== CLEF)).toEqual([
      { model: GPT, input: 300, output: 60 },
      { model: GEMMA, input: 200, output: 40 },
    ]);
  });

  it("counts nothing for an original that stopped when aborted", async () => {
    const c = new Colonyish({ FT_HEDGE: "c1" });
    c.ai.slow.set(GEMMA, 30_000);
    c.ai.stops = true;
    const { done } = c.start();
    await c.until(() => c.ai.of("opinion").length === 1);
    await vi.advanceTimersByTimeAsync(12_000);
    await done;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(c.counters[`decide.llm.tokensIn:${GEMMA}`]).toBeUndefined();
    expect(c.counters["decide.llm.tokensIn"]).toBe(300);
  });

  it("sends no copy when the original answers in time", async () => {
    const c = new Colonyish({ FT_HEDGE: "on" });
    c.ai.slow.set(GEMMA, 5_000);
    const { id, done } = c.start();
    await c.until(() => c.ai.of("opinion").length === 1);
    await vi.advanceTimersByTimeAsync(5_000);
    await done;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(c.ai.of("opinion").map((r) => r.model)).toEqual([GEMMA]);
    expect(c.proposals.get(id)!.status).toBe("ready");
    expect(c.decisions.find((d) => d.layer === "llm")!.answers.hedged).toBeUndefined();
    expect(Object.keys(c.counters).filter((k) => k.startsWith("hedge."))).toEqual([]);
  });

  it("waits as before, with no copy and no signal, when the flag does not cover the colony", async () => {
    for (const vars of [{}, { FT_HEDGE: "c2" }, { FT_HEDGE: "off", FT_HEDGE_MS: "1000" }]) {
      const c = new Colonyish(vars);
      c.ai.slow.set(GEMMA, 30_000);
      const { id, done } = c.start();
      await c.until(() => c.ai.of("opinion").length === 1);
      await vi.advanceTimersByTimeAsync(30_000);
      await done;
      expect(c.ai.runs.map((r) => [r.model, r.signal])).toEqual([
        [CLEF, undefined],
        [GEMMA, undefined],
      ]);
      expect(c.proposals.get(id)!.status).toBe("ready");
      const llm = c.decisions.find((d) => d.layer === "llm")!;
      expect(llm.answers.model).toBe(GEMMA);
      expect(llm.answers.hedged).toBeUndefined();
      expect(c.proposals.get(id)!.evidence.checks.find((k) => k.name.startsWith("llm:"))!.detail).not.toContain("hedge");
      expect(noteDecisions(rows(c.decisions))[id]!.find((d) => d.layer === "llm")!.answer).toBe("approve: does what the intent asks");
    }
  });

  it("follows FT_HEDGE_MS", async () => {
    const c = new Colonyish({ FT_HEDGE: "on", FT_HEDGE_MS: "review=8000" });
    c.ai.slow.set(GEMMA, 30_000);
    const { done } = c.start();
    await c.until(() => c.ai.of("opinion").length === 1);
    await vi.advanceTimersByTimeAsync(8_000);
    await done;
    expect(c.decisions.find((d) => d.layer === "llm")!.answers.hedged).toEqual({ after_ms: 8_000, winner: "copy", model: GPT, cause: "slow" });
  });
});

describe("Clef, hedged", () => {
  it("takes the copy's answers when the reflex call is slow, and counts both copies' input tokens", async () => {
    const c = new Colonyish({ FT_HEDGE: "on" });
    c.ai.slow.set(CLEF, 10_000);
    const { id, done } = c.start();
    await c.until(() => c.ai.of("clef").length === 1);
    await vi.advanceTimersByTimeAsync(3_000);
    await done;
    const [original, copy] = c.ai.of("clef");
    expect([original!.model, copy!.model, original!.aborted]).toEqual([CLEF, CLEF, true]);
    const reflex = c.proposals.get(id)!.evidence.checks.find((k) => k.name.startsWith("reflex:"))!;
    expect(reflex.detail).toContain("answered by the hedge copy after 3.0 s");
    expect(c.decisions.find((d) => d.layer === "reflex")!.answers.hedged).toEqual({ after_ms: 3_000, winner: "copy", model: CLEF, cause: "slow" });
    expect(noteDecisions(rows(c.decisions))[id]!.find((d) => d.layer === "reflex")!.answer).toContain("answered by the hedge copy after 3.0 s");
    expect(c.counters).toMatchObject({ "hedge.reflex.sent": 1, "hedge.reflex.copy": 1, "decide.clef.tokens": 100, [`decide.clef.tokensIn:${CLEF}`]: 100 });
    await vi.advanceTimersByTimeAsync(7_000);
    expect(c.counters).toMatchObject({ "decide.clef.tokens": 150, [`decide.clef.tokensIn:${CLEF}`]: 150 });
  });
});
