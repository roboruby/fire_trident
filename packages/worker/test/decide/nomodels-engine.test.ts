import { describe, expect, it } from "vitest";
import type { Colony, Decision, Id, Intent, IntentSource, Landing, Proposal } from "@fire_trident/core";
import type { Env } from "../../src/env.ts";
import { DecideEngine, type DecideHost, type DecisionInput, type TrunkRpc } from "../../src/decide/engine.ts";
import type { ClefAnswer } from "../../src/decide/reflex.ts";
import { NO_MODEL_RULE } from "../../src/decide/nomodels.ts";
import { PERSON_DECIDES } from "../../src/cloudflare/models.ts";

/** The part of node:sqlite these tests use (the worker compiles against workers types, not Node's). */
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
        one: () => {
          if (rows.length !== 1) throw new Error(`expected one row, got ${rows.length}`);
          return rows[0];
        },
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

/** The AI binding as the engine calls it: Clef answers from `clef`, the second opinion from `verdict` (an Error makes it unavailable). */
class FakeAi {
  clef: Record<string, ClefAnswer> = { ...CLEAN };
  verdict: Record<string, unknown> | Error = APPROVE;
  calls: Array<{ model: string; input: Record<string, unknown> }> = [];
  async run(model: string, input: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ model, input });
    if (input.questions) {
      const answers: Record<string, ClefAnswer> = {};
      for (const id of Object.keys(input.questions as object)) answers[id] = this.clef[id] ?? { type: "noul", noul: 0.02 };
      return { answers };
    }
    if (this.verdict instanceof Error) throw this.verdict;
    return { response: JSON.stringify(this.verdict) };
  }
  clefCalls(): Array<Record<string, unknown>> {
    return this.calls.filter((c) => c.input.questions).map((c) => c.input.state as Record<string, unknown>);
  }
  secondOpinions(): string[] {
    return this.calls.filter((c) => c.input.messages).map((c) => (c.input.messages as Array<{ content: string }>).map((m) => m.content).join("\n"));
  }
}

/** One colony around the engine: proposals, intents, decisions, blobs and the trunk, all in memory. */
class Colonyish implements DecideHost {
  /** The sentence of a colony with no model to ask; null: an operator colony. */
  off: string | null = null;
  /** Waits the engine made for the colony to read its model access. */
  readies = 0;
  modelsOff(): string | null {
    return this.off;
  }
  modelsReady(): Promise<void> | undefined {
    if (this.off === null) return undefined;
    this.readies++;
    return Promise.resolve();
  }
  readonly ai = new FakeAi();
  readonly blobs = new Map<string, string>();
  readonly env: Env;
  readonly sql = sqlStorage();
  readonly proposals = new Map<Id, Proposal>();
  readonly intents = new Map<Id, Intent>();
  readonly decisions: Decision[] = [];
  readonly sealed: Array<{ id: Id; reason: string }> = [];
  readonly pending: Array<Promise<unknown>> = [];
  readonly engine: DecideEngine;
  private seq = 0;

  constructor(ai: "tripwire" | "none") {
    const blobs = this.blobs;
    const artifacts = { get: async () => ({ readBlob: async (sha: string) => (blobs.has(sha) ? new Blob([blobs.get(sha)!]) : null) }) };
    // The binding a colony with no model to ask must never touch (a tripwire), or none at all (an operator deployment without Workers AI).
    this.env = (ai === "tripwire" ? { AI: this.ai, ARTIFACTS: artifacts } : { ARTIFACTS: artifacts }) as unknown as Env;
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
  bump(): void {}
  setMetric(): void {}
  emit(): void {}
  trunk(): TrunkRpc {
    return {
      baseBlobs: async () => [],
      blobsFor: async (paths) => Object.fromEntries(paths.map((p) => [p, null])),
      readFile: async () => null,
      files: async () => [],
      systemCommit: async (commit) => {
        this.commits.push(commit);
        return { id: "lnd_ab", colonyId: COLONY.id, trunkSha: "1".repeat(40) } as unknown as Landing;
      },
    };
  }
  /** What the engine committed to trunk itself (antibodies), as it sent it. */
  readonly commits: Array<Parameters<TrunkRpc["systemCommit"]>[0]> = [];
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
  seal(id: Id, reason: string): void {
    this.sealed.push({ id, reason });
    this.save({ ...this.proposals.get(id)!, status: "rejected", reason });
  }

  save(p: Proposal): void {
    this.proposals.set(p.id, p);
    this.sql.exec("INSERT INTO proposals (id, status) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status", p.id, p.status);
  }

  declare(source: IntentSource, footprint: string[], over: Partial<Intent> = {}): Intent {
    const intent: Intent = { id: `int_${++this.seq}`, colonyId: COLONY.id, title: "Add the module", why: "The spec asks for it.", source, footprint, priority: 1, status: "proposed", createdAt: 0, createdBy: "t", ...over };
    this.intents.set(intent.id, intent);
    return intent;
  }

  /** Propose a change (new text per path; `before` absent means a new file) and run the pipeline on it. */
  async decide(intent: Intent, files: Array<{ path: string; before?: string; after: string | null }>): Promise<Proposal> {
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
      writeSet: files.map((f) => ({ path: f.path, blob: f.after === null ? null : blob(f.after) })),
      readSet: files.filter((f) => f.before !== undefined).map((f) => ({ path: f.path, blob: blob(f.before!) })),
      declared: { footprint: intent.footprint, summary: "Deliver order webhooks with fetch" },
      evidence: { checks: [], notVerified: "Not verified: no tests were run." },
      status: "checking",
      createdAt: Date.now(),
    };
    this.save(p);
    await this.engine.run(p.id);
    return this.proposals.get(p.id)!;
  }
}


/**
 * Review in a colony a person owns whose Cloudflare connection runs no models (decide/nomodels.ts): it is on, every
 * deterministic layer runs as always, a deterministic proof still lands a change, and wherever review would ask a model a
 * person decides instead, with the reason. The Workers AI binding here is a tripwire that records any call: none is made.
 * An operator deployment without Workers AI keeps review off, as before.
 */

const HOOK = "export async function deliver(url: string, body: string) {\n  await fetch(url, { method: 'POST', body });\n}\n";
const MODULE = "export function add(a: number, b: number): number {\n  return a + b;\n}\n";
const DOCUMENTED = `/** Adds two numbers. */\n${MODULE.replace("  return a + b;", "  // Plain addition: no rounding.\n  return a + b;")}`;
const SENTENCE = PERSON_DECIDES.no_workers_ai;

/** A colony with no model to ask, whose binding must never be called. */
function noModels(): Colonyish {
  const c = new Colonyish("tripwire");
  c.off = SENTENCE;
  return c;
}

describe("review with no model to ask", () => {
  it("is on while the colony's policy is", () => {
    const c = noModels();
    expect(c.engine.enabled()).toBe(true);
    c.engine.store.setPolicy({ enabled: false });
    expect(c.engine.enabled()).toBe(false);
  });

  it("sends a danger-pattern change to a person, as always", async () => {
    const c = noModels();
    const p = await c.decide(c.declare("agent", ["src/hook.ts"], { title: "Deliver order webhooks", why: "Send a webhook when an order is created." }), [{ path: "src/hook.ts", after: HOOK }]);
    expect(p.status).toBe("escalated");
    expect(p.reason).toContain("escalated by deterministic: danger patterns need a human");
    expect(p.reason).toContain("capability (network)");
    expect(c.ai.calls).toEqual([]);
  });

  it("lands a deterministically proven change, with no model", async () => {
    const c = noModels();
    const p = await c.decide(c.declare("agent", ["src/add.ts"], { title: "Document add()" }), [{ path: "src/add.ts", before: MODULE, after: DOCUMENTED }]);
    expect(p.status).toBe("ready");
    expect(p.evidence.checks.find((k) => k.name === "gate")!.detail).toMatch(/^D3 innate\+proof → land by deterministic /);
    expect(c.ai.calls).toEqual([]);
  });

  it("sends an ordinary change to a person with the reason, where a model would have reviewed it", async () => {
    const c = noModels();
    const p = await c.decide(c.declare("human", ["src/add.ts"]), [{ path: "src/add.ts", after: MODULE }]);
    expect(p.status).toBe("escalated");
    expect(p.reason).toBe(`escalated by deterministic: ${SENTENCE}`);
    const gate = p.evidence.checks.find((k) => k.name === "gate")!;
    expect(gate.detail).toContain(`${NO_MODEL_RULE} → escalate by deterministic`);
    expect(gate.ok).toBe(false);
    // No model decided anything, and the innate checks still ran.
    expect(c.decisions).toEqual([]);
    expect(p.evidence.checks.some((k) => k.name.startsWith("innate:"))).toBe(true);
    expect(c.ai.calls).toEqual([]);
    // It waited for the colony to know whether it has models before deciding.
    expect(c.readies).toBe(1);
  });

  it("says the same for an owner with no working connection, in its own words", async () => {
    const c = noModels();
    c.off = PERSON_DECIDES.not_connected;
    const p = await c.decide(c.declare("human", ["src/add.ts"]), [{ path: "src/add.ts", after: MODULE }]);
    expect(p.reason).toBe(`escalated by deterministic: ${PERSON_DECIDES.not_connected}`);
    expect(c.ai.calls).toEqual([]);
  });

  it("asks the models as before in a colony whose models run", async () => {
    const c = new Colonyish("tripwire");
    const p = await c.decide(c.declare("human", ["src/add.ts"]), [{ path: "src/add.ts", after: MODULE }]);
    expect(p.status).toBe("ready");
    expect(c.ai.calls.length).toBeGreaterThan(0);
    expect(c.readies).toBe(0);
  });
});

describe("an operator deployment without Workers AI", () => {
  it("keeps review off, as before, and waits for nothing", () => {
    const c = new Colonyish("none");
    expect(c.engine.enabled()).toBe(false);
    expect(c.modelsReady()).toBeUndefined();
  });
});
