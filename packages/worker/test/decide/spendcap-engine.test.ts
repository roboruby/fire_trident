import { describe, expect, it } from "vitest";
import type { Antibody, Colony, Decision, Id, Intent, IntentSource, Landing, Proposal } from "@fire_trident/core";
import type { Env } from "../../src/env.ts";
import { ColonyPause } from "../../src/colony/pause.ts";
import { REVIEW_REFUSAL, SPEND_CAP_ACTOR, SpendCapBook, cappedAi } from "../../src/colony/spendcap.ts";
import { DecideEngine, type DecideHost, type DecisionInput, type TrunkRpc } from "../../src/decide/engine.ts";
import type { AiRunner, ClefAnswer } from "../../src/decide/reflex.ts";

/**
 * The decide stage under a spend cap (colony/spendcap.ts, decide/gate.ts L8): a colony in memory around the engine, its
 * model calls reserved against a real cap with the real pause switch. Once the agents' share is spent, a change with a
 * deterministic proof still lands (no model asked), one that needs the second opinion is reviewed from the reserve, and
 * once the reserve is gone too no model is called and the change waits for a person: it never lands on a refused call.
 * With no cap the stage calls its models exactly as it does without the cap's hook.
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
      return {
        toArray: () => rows,
        one: () => rows[0],
        [Symbol.iterator]: () => rows[Symbol.iterator](),
      };
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
const MODULE = "export function add(a: number, b: number): number {\n  return a + b;\n}\n";
const DOCUMENTED = `/** Adds two numbers. */\n${MODULE}`;

/** The AI binding: Clef answers clean, the second opinion approves; each reports `clefTokens` and `opinionTokens`. */
class FakeAi implements AiRunner {
  calls: Array<{ model: string; kind: "clef" | "opinion" }> = [];
  clefTokens = 1_000;
  opinionTokens = { in: 1_000, out: 100 };
  /** Clef fails with this (an outage), when set. */
  clefFails: Error | null = null;
  async run(model: string, input: Record<string, unknown>): Promise<unknown> {
    if (input.questions) {
      this.calls.push({ model, kind: "clef" });
      if (this.clefFails) throw this.clefFails;
      const answers = Object.fromEntries(Object.keys(input.questions as object).map((id) => [id, CLEAN[id] ?? { type: "noul", noul: 0.02 }]));
      return { answers, usage: { input_tokens: this.clefTokens } };
    }
    this.calls.push({ model, kind: "opinion" });
    return { response: JSON.stringify(APPROVE), usage: { prompt_tokens: this.opinionTokens.in, completion_tokens: this.opinionTokens.out } };
  }
}

/** One colony around the engine, with a spend cap and a pause switch on its storage (`capped: false`: no cap hook at all). */
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
  readonly pause: ColonyPause;
  readonly cap: SpendCapBook;
  readonly counters: Record<string, number> = {};
  /** The colony's spend as it last counted it, besides what the cap settles. */
  book = 0;
  capAi?: DecideHost["capAi"];
  private seq = 0;

  constructor(opts: { capped?: boolean } = {}) {
    const blobs = this.blobs;
    const artifacts = { get: async () => ({ readBlob: async (sha: string) => (blobs.has(sha) ? new Blob([blobs.get(sha)!]) : null) }) };
    this.env = { AI: this.ai, ARTIFACTS: artifacts } as unknown as Env;
    const sql = this.sql as unknown as ConstructorParameters<typeof ColonyPause>[0]["sql"];
    this.pause = new ColonyPause({ sql, now: () => Date.now(), readDeployment: async () => null, publish: () => undefined, tellWriter: async () => true });
    this.cap = new SpendCapBook({
      sql,
      now: () => Date.now(),
      bookUsd: () => this.book,
      ownPause: () => this.pause.own(),
      trip: (reason) => this.pause.pause({ by: SPEND_CAP_ACTOR, reason }),
      lift: (by, reason) => this.pause.resume({ by, reason }),
      waitUntil: (p) => void this.pending.push(p),
    });
    if (opts.capped !== false) this.capAi = (ai, use) => cappedAi(ai, this.cap, use);
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
  save(p: Proposal): void {
    this.proposals.set(p.id, p);
    this.sql.exec("INSERT INTO proposals (id, status) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status", p.id, p.status);
  }

  declare(source: IntentSource, footprint: string[]): Intent {
    const intent: Intent = { id: `int_${++this.seq}`, colonyId: COLONY.id, title: "Add the module", why: "The spec asks for it.", source, footprint, priority: 1, status: "proposed", createdAt: 0, createdBy: "t" };
    this.intents.set(intent.id, intent);
    return intent;
  }

  /** Propose a change (new text per path; `before` absent means a new file) and run the pipeline on it. */
  async decide(files: Array<{ path: string; before?: string; after: string }>): Promise<Proposal> {
    const intent = this.declare("human", files.map((f) => f.path));
    const blob = (text: string): string => {
      const id = `${(++this.seq).toString(16).padStart(8, "0")}${"a".repeat(32)}`;
      this.blobs.set(id, text);
      return id;
    };
    const p: Proposal = {
      id: `prp_${++this.seq}`,
      colonyId: COLONY.id,
      intentId: intent.id,
      agentId: "agt_1",
      workspace: { namespace: "ft-trunk", name: "ws", remote: "" },
      baseSha: COLONY.trunkSha,
      headSha: `${this.seq}`.padStart(40, "f"),
      writeSet: files.map((f) => ({ path: f.path, blob: blob(f.after) })),
      readSet: files.filter((f) => f.before !== undefined).map((f) => ({ path: f.path, blob: blob(f.before!) })),
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

describe("the decide stage under a spend cap", () => {
  it("with no cap calls its models exactly as without the cap's hook, and lands the same", async () => {
    const plain = new Colonyish({ capped: false });
    const hooked = new Colonyish();
    for (const c of [plain, hooked]) {
      expect((await c.decide([{ path: "src/add.ts", after: MODULE }])).status).toBe("ready");
      expect((await c.decide([{ path: "src/add.ts", before: MODULE, after: DOCUMENTED }])).status).toBe("ready");
    }
    expect(hooked.ai.calls).toEqual(plain.ai.calls);
    expect(hooked.ai.calls.map((c) => c.kind)).toEqual(["clef", "opinion"]);
    expect(hooked.decisions.map((d) => [d.layer, d.action])).toEqual(plain.decisions.map((d) => [d.layer, d.action]));
    expect(hooked.counters).toEqual(plain.counters);
    expect(hooked.pause.own()).toBeNull();
  });

  it("once the agents' share is spent, reviews a change from the reserve; once the reserve is gone, calls no model and sends the next to a person", async () => {
    const c = new Colonyish();
    c.book = 0.9;
    await c.cap.set({ usd: 1, reviewReserveUsd: 0.1, by: "maya" });
    expect(c.pause.own()).toMatchObject({ by: SPEND_CAP_ACTOR, reason: "spend cap: $0.900 of $1.00 spent on model calls this platform made" });

    // A change that needs both models: they are asked, from the reserve, and it lands on the second opinion's approval.
    const reviewed = await c.decide([{ path: "src/add.ts", after: MODULE }]);
    expect(reviewed.status).toBe("ready");
    expect(c.ai.calls.map((k) => k.kind)).toEqual(["clef", "opinion"]);
    expect(reviewed.evidence.checks.find((k) => k.name === "gate")!.detail).toMatch(/^L3 innate\+llm → land/);
    expect(c.cap.state()!.spentUsd).toBeGreaterThan(0.9);

    // Another review call spends what is left of the reserve: the next change is never shown to a model, and waits for
    // a person instead of landing.
    c.cap.settle(null, 0.1);
    expect(c.cap.state()!.state).toBe("spent");
    const waiting = await c.decide([{ path: "src/sub.ts", after: MODULE.replace("add", "sub").replace("a + b", "a - b") }]);
    expect(c.ai.calls).toHaveLength(2);
    expect(waiting.status).toBe("escalated");
    expect(waiting.reason).toBe(`escalated by llm: ${REVIEW_REFUSAL}`);
    const checks = waiting.evidence.checks;
    expect(checks.find((k) => k.name.startsWith("reflex:"))!.detail).toBe(`unavailable: ${REVIEW_REFUSAL}`);
    expect(checks.find((k) => k.name.startsWith("llm:"))).toMatchObject({ ok: false, detail: `unavailable: ${REVIEW_REFUSAL}` });
    expect(checks.find((k) => k.name === "gate")!.detail).toMatch(/^L8 spend cap → escalate by llm/);
    // The second opinion's decision records the refusal as its error, never a verdict.
    const llm = c.decisions.filter((d) => d.subject === waiting.id && d.layer === "llm");
    expect(llm).toHaveLength(1);
    expect(llm[0]!.answers).toMatchObject({ error: REVIEW_REFUSAL, rule: "L8 spend cap" });
    expect(llm[0]!.answers.verdict).toBeUndefined();
    expect(llm[0]!.action).toBe("escalate");
    // Nothing about the change was found wrong, so its region keeps its autonomy.
    expect(c.engine.store.autonomyTable(0).find((r) => r.region === "src")?.revokedAt ?? null).toBeNull();

    // A change with a deterministic proof still lands with no model asked.
    const proven = await c.decide([{ path: "src/add.ts", before: MODULE, after: DOCUMENTED }]);
    expect(proven.status).toBe("ready");
    expect(proven.evidence.checks.find((k) => k.name === "gate")!.detail).toMatch(/^D3 innate\+proof → land by deterministic/);
    expect(c.ai.calls).toHaveLength(2);
  });

  it("sends a change to a person when the reserve pays for the reflex but not the second opinion: the refused call is never an approval", async () => {
    const c = new Colonyish();
    c.book = 0.9;
    await c.cap.set({ usd: 1, reviewReserveUsd: 0.1, by: "maya" });
    // Clef's answer reports more input than its reservation guessed: after it the reserve has no room for the second opinion.
    c.ai.clefTokens = Math.ceil(0.1 / 0.24e-6);
    const p = await c.decide([{ path: "src/add.ts", after: MODULE }]);
    expect(c.ai.calls.map((k) => k.kind)).toEqual(["clef"]);
    expect(p.status).toBe("escalated");
    expect(p.status).not.toBe("ready");
    expect(p.evidence.checks.find((k) => k.name === "gate")!.detail).toMatch(/^L8 spend cap → escalate/);
    expect(c.cap.state()!.state).toBe("spent");
  });
});

describe("a proven change with matching antibodies the reflex could not screen (M2)", () => {
  const ab: Antibody = { id: "ab_1", colonyId: "c1", origin: "human-reject", matcher: { paths: ["src/**"] }, question: "Does this change rename an exported function without updating its callers?", threshold: 0.7, createdAt: 1, hits: 0, falsePositives: 0 };
  const proven = [{ path: "src/add.ts", before: MODULE, after: DOCUMENTED }];
  const reason = (cause: string) => `escalated by reflex: Matching antibodies could not be checked because the reflex model was unavailable (${cause}); a person decides.`;

  it("goes to a person when the spend cap refused the reflex, never landing unscreened", async () => {
    const c = new Colonyish();
    c.engine.store.putAntibody(ab, "active");
    c.book = 1;
    await c.cap.set({ usd: 1, reviewReserveUsd: 0.1, by: "maya" });
    const p = await c.decide(proven);
    expect(c.ai.calls).toEqual([]);
    expect(p.status).toBe("escalated");
    expect(p.reason).toBe(reason("the spend cap left review no room for the call"));
    expect(p.evidence.checks.find((k) => k.name === "gate")!.detail).toMatch(/^M2 antibodies unscreened → escalate by reflex/);
  });

  it("goes to a person when the reflex failed, even past the alert budget, and the region keeps its autonomy", async () => {
    const c = new Colonyish();
    c.engine.store.putAntibody(ab, "active");
    c.engine.store.setPolicy({ alertsPerHour: 0 });
    c.ai.clefFails = new Error("@cf/cloudflare/clef did not answer within 15 s");
    const p = await c.decide(proven);
    expect(c.ai.calls.map((k) => k.kind)).toEqual(["clef"]);
    expect(p.status).toBe("escalated");
    expect(p.reason).toBe(reason("@cf/cloudflare/clef did not answer within 15 s"));
    expect(c.engine.store.autonomyTable(0).find((r) => r.region === "src")?.revokedAt ?? null).toBeNull();
  });

  it("lands on its proof as before when no antibody matches, with no model asked, whatever the reflex's state", async () => {
    const c = new Colonyish();
    c.ai.clefFails = new Error("model down");
    const p = await c.decide(proven);
    expect(p.status).toBe("ready");
    expect(p.evidence.checks.find((k) => k.name === "gate")!.detail).toMatch(/^D3 innate\+proof → land by deterministic/);
    expect(c.ai.calls).toEqual([]);
  });

  it("lands on its proof when the reflex answered and no antibody hit (M1, as before)", async () => {
    const c = new Colonyish();
    c.engine.store.putAntibody(ab, "active");
    const p = await c.decide(proven);
    expect(p.status).toBe("ready");
    expect(p.evidence.checks.find((k) => k.name === "gate")!.detail).toMatch(/^M1 innate\+proof → land by deterministic/);
  });
});
