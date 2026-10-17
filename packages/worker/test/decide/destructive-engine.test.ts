import { describe, expect, it } from "vitest";
import type { Colony, Decision, Id, Intent, IntentSource, Landing, Proposal } from "@fire_trident/core";
import type { Env } from "../../src/env.ts";
import { DecideEngine, type DecideHost, type DecisionInput, type TrunkRpc } from "../../src/decide/engine.ts";
import type { ClefAnswer } from "../../src/decide/reflex.ts";

/**
 * The decide pipeline and destructive changes (decide/destructive.ts): in a region that earned autonomy, a person's
 * quiet change that deletes or renames a file, removes an export or removes a large share of a file goes to the second
 * opinion with the reason named, and the fact is in the decision records and the evidence the review card shows. A
 * change that takes nothing away still lands on earned autonomy alone.
 */

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

const MODULE = "export function add(a: number, b: number): number {\n  return a + b;\n}\n";
const TWO = `${MODULE}\nexport function sub(a: number, b: number): number {\n  return a - b;\n}\n`;
/** One exported function with `n` statement lines in its body (n + 4 lines). */
const lines = (n: number): string => `export function sum(): number {\n  let total = 0;\n${Array.from({ length: n }, (_, i) => `  total += ${i};\n`).join("")}  return total;\n}\n`;

/** Three landings a higher layer approved in region "src": earned autonomy there. */
function earnAutonomy(c: Colonyish): void {
  for (let i = 0; i < 3; i++) {
    c.engine.store.recordOutcome({ proposalId: `prp_old${i}`, region: "src", head: "h", layer: "llm", action: "land", risk: 0, detectors: [], vaccine: false, state: null, at: Date.now() - 1_000 });
    c.sql.exec("INSERT INTO proposals (id, status) VALUES (?, 'landed')", `prp_old${i}`);
  }
}

/** The evidence check the review card shows for destructive changes. */
const check = (p: Proposal) => p.evidence.checks.find((k) => k.name === "destructive changes");

const KINDS: Array<{ kind: string; footprint: string[]; files: Array<{ path: string; before?: string; after: string | null }>; says: string; hit: Record<string, unknown> }> = [
  { kind: "a deleted file", footprint: ["src/old.ts"], files: [{ path: "src/old.ts", before: MODULE, after: null }], says: "deletes src/old.ts", hit: { kind: "deleted", path: "src/old.ts" } },
  {
    kind: "a renamed file",
    footprint: ["src/old.ts", "src/new.ts"],
    files: [
      { path: "src/old.ts", before: MODULE, after: null },
      { path: "src/new.ts", after: MODULE },
    ],
    says: "renames src/old.ts to src/new.ts",
    hit: { kind: "renamed", path: "src/old.ts", to: "src/new.ts" },
  },
  {
    kind: "a removed export",
    footprint: ["src/math.ts"],
    files: [{ path: "src/math.ts", before: TWO, after: TWO.replace("export function sub", "function sub") }],
    says: "removes the export sub from src/math.ts",
    hit: { kind: "export-removed", path: "src/math.ts", names: ["sub"] },
  },
  {
    kind: "a large removal",
    footprint: ["src/sum.ts"],
    files: [{ path: "src/sum.ts", before: lines(300), after: lines(60) }],
    says: "removes 240 lines net from src/sum.ts, which had 304",
    hit: { kind: "net-removal", path: "src/sum.ts", lines: 240, of: 304 },
  },
];

describe("earned autonomy and destructive changes", () => {
  it("still lands a person's quiet change that only grows a file on the reflex alone", async () => {
    const c = new Colonyish();
    earnAutonomy(c);
    const p = await c.decide(c.declare("human", ["src/math.ts"]), [{ path: "src/math.ts", before: MODULE, after: TWO }]);
    expect(p.status).toBe("ready");
    expect(c.ai.secondOpinions()).toEqual([]);
    expect(c.decisions.map((d) => d.answers.rule)).toEqual(["R3 innate+autonomy"]);
    expect(c.decisions[0]!.answers.destructive).toBeUndefined();
    expect(check(p)).toMatchObject({ ok: true, detail: expect.stringContaining("takes nothing away") });
  });

  for (const { kind, footprint, files, says, hit } of KINDS) {
    it(`sends ${kind} to the second opinion with the reason, the fact in the records and on the review card`, async () => {
      const c = new Colonyish();
      earnAutonomy(c);
      const p = await c.decide(c.declare("human", footprint), files);
      // The second opinion approved, so it lands on two confirmations; no person was asked.
      expect(p.status).toBe("ready");
      expect(c.ai.secondOpinions()).toHaveLength(1);
      const [reflex, llm] = c.decisions;
      expect(reflex!.answers).toMatchObject({ rule: "R4 consult", reasons: [`Earned autonomy does not land destructive changes: this change ${says}`] });
      expect(reflex!.answers.destructive).toMatchObject({ hits: [hit], unknown: [] });
      expect(llm!.answers).toMatchObject({ rule: "L3 innate+llm", destructive: { hits: [hit] } });
      expect(check(p)).toMatchObject({ ok: false, detail: expect.stringContaining(`destructive: ${says}`) });
    });
  }

  it("goes back to its agent, not to a person, when the second opinion is unavailable", async () => {
    const c = new Colonyish();
    earnAutonomy(c);
    c.ai.verdict = new Error("model unavailable");
    const p = await c.decide(c.declare("human", ["src/old.ts"]), [{ path: "src/old.ts", before: MODULE, after: null }]);
    expect(p.status).toBe("returned");
    expect(p.reason).toContain("second opinion unavailable");
  });

  it("fails closed: a module whose exports cannot be read for sure gets no autonomy", async () => {
    const c = new Colonyish();
    earnAutonomy(c);
    const cjs = "function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n";
    const p = await c.decide(c.declare("human", ["src/add.js"]), [{ path: "src/add.js", before: cjs, after: cjs.replace("a + b", "b + a") }]);
    expect(p.status).toBe("ready");
    expect(c.ai.secondOpinions()).toHaveLength(1);
    expect(c.decisions[0]!.answers.reasons).toEqual([
      "Earned autonomy needs to know whether a change is destructive, and this one could not be read to tell (src/add.js: its exports cannot be read for sure)",
    ]);
    expect(check(p)).toMatchObject({ ok: false, detail: expect.stringContaining("could not tell whether it is destructive") });
  });
});

describe("a deterministic proof and destructive changes", () => {
  const notes = Array.from({ length: 45 }, (_, i) => `// Note ${i}: how this module came to be.`).join("\n");

  it("a comment-only change that removes most of a file goes to the second opinion instead of landing on the proof", async () => {
    const c = new Colonyish();
    const p = await c.decide(c.declare("agent", ["src/add.ts"], { title: "Trim the notes" }), [{ path: "src/add.ts", before: `${notes}\n${MODULE}`, after: MODULE }]);
    expect(p.status).toBe("ready");
    expect(p.evidence.checks.find((k) => k.name === "deterministic: mechanical proof")).toMatchObject({ ok: true });
    expect(c.ai.secondOpinions()).toHaveLength(1);
    expect(c.decisions[0]!.answers).toMatchObject({
      rule: "R4 consult",
      reasons: ["A deterministic proof does not land destructive changes alone: this change removes 45 lines net from src/add.ts, which had 48"],
    });
  });

  it("a short comment-only change still lands on the proof with no model", async () => {
    const c = new Colonyish();
    const p = await c.decide(c.declare("agent", ["src/add.ts"]), [{ path: "src/add.ts", before: `// Adds.\n${MODULE}`, after: MODULE }]);
    expect(p.status).toBe("ready");
    expect(c.ai.calls).toEqual([]);
  });
});
