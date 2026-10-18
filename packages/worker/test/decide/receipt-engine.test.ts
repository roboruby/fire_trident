import { describe, expect, it } from "vitest";
import type { Colony, Decision, Id, Intent, IntentSource, Landing, Proposal } from "@fire_trident/core";
import type { Env } from "../../src/env.ts";
import { DecideEngine, type DecideHost, type DecisionInput, type TrunkRpc } from "../../src/decide/engine.ts";
import type { ClefAnswer } from "../../src/decide/reflex.ts";
import { sha256Hex } from "../../src/trunk/digest.ts";

/** The review receipt the decide pipeline records for each model layer (decide/receipt.ts): the head and a digest of exactly what it was shown. */

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

  constructor() {
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

const sha = async (text: string): Promise<string> => `sha256:${await sha256Hex(text)}`;
const MODULE = "export function add(a: number, b: number): number {\n  return a + b;\n}\n";

/** The text a prompt fenced under `label`. */
function fencedSection(prompt: string, label: string): string {
  const m = new RegExp(`${label}, between (fence-[0-9a-f]{12}) markers:\\n\\1\\n([\\s\\S]*?)\\n\\1(?:\\n|$)`).exec(prompt);
  if (!m) throw new Error(`the prompt fences no ${label}`);
  return m[2]!;
}

describe("the review receipt of each model layer", () => {
  it("records the head and the digest of the diff the reflex read and the diff the second opinion was given", async () => {
    const c = new Colonyish();
    const p = await c.decide(c.declare("human", ["src/add.ts"]), [{ path: "src/add.ts", after: MODULE }]);
    expect(p.status).toBe("ready");
    const reflex = c.decisions.find((d) => d.layer === "reflex")!;
    const llm = c.decisions.find((d) => d.layer === "llm")!;
    const state = c.ai.clefCalls()[0]!;
    expect(reflex.answers).toMatchObject({ head: p.headSha, shown: { view: "reflex-state", digest: await sha(JSON.stringify(state.diff)) } });
    expect(reflex.answers.shown).not.toHaveProperty("clipped");
    expect(llm.answers).toMatchObject({ head: p.headSha, shown: { view: "prompt-diff", digest: await sha(fencedSection(c.ai.secondOpinions()[0]!, "Diff")) } });
  });

  it("says when a layer saw only part of the change", async () => {
    const c = new Colonyish();
    const files = Array.from({ length: 22 }, (_, i) => ({ path: `src/m${i}.ts`, after: MODULE.replace("add", `add${i}`) }));
    await c.decide(c.declare("human", files.map((f) => f.path)), files);
    const llm = c.decisions.find((d) => d.layer === "llm");
    expect(llm?.answers.shown).toMatchObject({ view: "prompt-diff", clipped: true, seen: "saw 20 of 22 files" });
    const reflex = c.decisions.find((d) => d.layer === "reflex");
    expect(reflex?.answers.shown).toMatchObject({ view: "reflex-state", clipped: true });
  });
});
