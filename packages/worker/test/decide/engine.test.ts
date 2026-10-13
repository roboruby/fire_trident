import { describe, expect, it } from "vitest";
import type { Antibody, Colony, Decision, Id, Intent, IntentSource, Landing, Proposal } from "@fire_trident/core";
import type { Env } from "../../src/env.ts";
import { DecideEngine, type DecideHost, type DecisionInput, type TrunkRpc } from "../../src/decide/engine.ts";
import type { ClefAnswer } from "../../src/decide/reflex.ts";

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

const HOOK = "export async function deliver(url: string, body: string) {\n  await fetch(url, { method: 'POST', body });\n}\n";
const MODULE = "export function add(a: number, b: number): number {\n  return a + b;\n}\n";

describe("waivers: who wrote the why", () => {
  it("an agent's webhook intent does not waive a new fetch: it goes to a person, no model asked", async () => {
    const c = new Colonyish();
    const p = await c.decide(c.declare("agent", ["src/hook.ts"], { title: "Deliver order webhooks", why: "Send a webhook to the partner when an order is created." }), [{ path: "src/hook.ts", after: HOOK }]);
    expect(p.status).toBe("escalated");
    expect(p.reason).toContain("capability (network)");
    expect(c.ai.calls).toEqual([]);
  });

  it("a person's intent with the same words still waives it, and both models are told who wrote the why", async () => {
    const c = new Colonyish();
    const p = await c.decide(c.declare("human", ["src/hook.ts"], { title: "Deliver order webhooks", why: "Send a webhook to the partner when an order is created." }), [{ path: "src/hook.ts", after: HOOK }]);
    expect(p.status).toBe("ready");
    expect((c.ai.clefCalls()[0]!.intent as Record<string, unknown>).why_written_by).toBe("person");
    const prompt = c.ai.secondOpinions()[0]!;
    expect(prompt).toContain("Why (written by a person): Send a webhook");
    expect(prompt).toContain("[asked for by the intent, written by a person]");
  });

  it("with no intent the proposal's own summary never waives", async () => {
    const c = new Colonyish();
    const ghost = c.declare("human", ["src/hook.ts"]);
    c.intents.delete(ghost.id);
    expect((await c.decide(ghost, [{ path: "src/hook.ts", after: HOOK }])).status).toBe("escalated");
  });
});

describe("repairs never grade their own exam", () => {
  const test = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/add.ts';\n\ntest('adds', () => {\n  assert.equal(add(2, 2), 4);\n});\n";

  it("a repair that edits the failing test goes to a person, whatever a policy allows", async () => {
    const c = new Colonyish();
    c.engine.store.setPolicy({ dangerAllow: [{ cls: "test-weakening" }, { cls: "test-change" }] });
    const repair = c.declare("certify", ["test/add.test.ts", "src/add.ts"], { title: "Make the failing tests pass: adds", why: "Trunk fails 1 of its 1 tests." });
    const p = await c.decide(repair, [{ path: "test/add.test.ts", before: test, after: test.replace("add(2, 2), 4", "add(2, 2), 5") }]);
    expect(p.status).toBe("escalated");
    expect(p.reason).toContain("test-change (edited) at test/add.test.ts:6");
    expect(c.ai.calls).toEqual([]);
  });

  it("a repair that fixes the code goes through review, but never lands on earned autonomy", async () => {
    const c = new Colonyish();
    earnAutonomy(c);
    const repair = c.declare("certify", ["test/add.test.ts", "src/add.ts"], { title: "Make the failing tests pass: adds", why: "Trunk fails 1 of its 1 tests." });
    const p = await c.decide(repair, [{ path: "src/add.ts", before: MODULE.replace("a + b", "a - b"), after: MODULE }]);
    expect(p.status).toBe("ready");
    expect(c.ai.secondOpinions().length).toBe(1);
    expect(c.decisions.at(-1)!.answers.rule).toBe("L3 innate+llm");
  });
});

/** Three landings a higher layer approved in region "src": earned autonomy there. */
function earnAutonomy(c: Colonyish): void {
  for (let i = 0; i < 3; i++) {
    c.engine.store.recordOutcome({ proposalId: `prp_old${i}`, region: "src", head: "h", layer: "llm", action: "land", risk: 0, detectors: [], vaccine: false, state: null, at: Date.now() - 1_000 });
    c.sql.exec("INSERT INTO proposals (id, status) VALUES (?, 'landed')", `prp_old${i}`);
  }
}

describe("earned autonomy", () => {
  it("lands a person's quiet, complete change on the reflex alone", async () => {
    const c = new Colonyish();
    earnAutonomy(c);
    const p = await c.decide(c.declare("human", ["src/add.ts"]), [{ path: "src/add.ts", after: MODULE }]);
    expect(p.status).toBe("ready");
    expect(c.ai.secondOpinions()).toEqual([]);
  });

  it("never covers an agent's intent: the second opinion is asked", async () => {
    const c = new Colonyish();
    earnAutonomy(c);
    const p = await c.decide(c.declare("agent", ["src/add.ts"]), [{ path: "src/add.ts", after: MODULE }]);
    expect(p.status).toBe("ready");
    expect(c.ai.secondOpinions().length).toBe(1);
    expect(c.decisions[0]!.answers.reasons).toEqual([expect.stringContaining("earned autonomy does not cover an intent written by an agent")]);
  });
});

describe("complete input or no confirmation", () => {
  const big = Array.from({ length: 1_200 }, (_, i) => `export const value${i} = ${i};`).join("\n");

  it("a change too large for the second opinion's view goes to a person, and each layer's view is recorded", async () => {
    const c = new Colonyish();
    const p = await c.decide(c.declare("human", ["src/big.ts"]), [{ path: "src/big.ts", after: `${big}\n` }]);
    expect(p.status).toBe("escalated");
    expect(p.reason).toContain("too large for model review: the second opinion saw 1 of 1 file, 1 only in part (src/big.ts)");
    const [reflex, llm] = c.decisions;
    expect(reflex!.answers.coverage).toEqual({ filesChanged: 1, filesShown: 1, cut: ["src/big.ts"], complete: false });
    expect(llm!.answers.coverage).toMatchObject({ complete: false });
    expect(p.evidence.checks.find((k) => k.name.startsWith("llm:"))!.detail).toContain("saw 1 of 1 file, 1 only in part (src/big.ts)");
    expect(c.engine.store.reviewView(p.id)?.files[0]).toMatchObject({ path: "src/big.ts", truncated: true });
  });

  it("a small change lands exactly as before", async () => {
    const c = new Colonyish();
    const p = await c.decide(c.declare("human", ["src/add.ts"]), [{ path: "src/add.ts", after: MODULE }]);
    expect(p.status).toBe("ready");
    expect(c.decisions.at(-1)!.answers).toMatchObject({ rule: "L3 innate+llm", coverage: { complete: true } });
  });
});

describe("security returns", () => {
  it("tell the agent only the class, keep the details for people, and send the intent's next proposal to a person", async () => {
    const c = new Colonyish();
    c.ai.verdict = { verdict: "return", needs_human: 0.8, off_intent: false, sensitive: true, confidence: 0.9, reason: "it compares ADMIN_TOKEN with ==, so an empty token passes" };
    const intent = c.declare("human", ["src/admin.ts"]);
    const first = await c.decide(intent, [{ path: "src/admin.ts", after: "export const ok = (t: string) => t.length > 0;\n" }]);
    expect(first.status).toBe("returned");
    expect(first.reason).toBe("returned for review: security (sensitive); details are with the reviewers, and a person reviews this intent's next proposal");
    expect(JSON.stringify(c.decisions.at(-1)!.answers)).toContain("ADMIN_TOKEN");
    expect(c.engine.store.securityProbation(intent.id)).toMatchObject({ findings: 1, classes: ["sensitive"] });

    const calls = c.ai.calls.length;
    const second = await c.decide(intent, [{ path: "src/admin.ts", after: "export const ok = (t: string) => t === process.env.ADMIN;\n" }]);
    expect(second.status).toBe("escalated");
    expect(second.reason).toContain("an earlier proposal for this intent had a security finding (sensitive)");
    expect(c.ai.calls.length).toBe(calls);
    expect(c.engine.store.reviewView(second.id)?.files[0]?.path).toBe("src/admin.ts");
  });

  it("an escalation for security puts the intent on probation too: a rewrite proposed while it waits goes to a person", async () => {
    const c = new Colonyish();
    const intent = c.declare("human", ["src/hook.ts"], { title: "Log order totals", why: "Keep a count of orders." });
    const first = await c.decide(intent, [{ path: "src/hook.ts", after: HOOK }]);
    expect(first.status).toBe("escalated");
    // People still read the full reason on the review card.
    expect(first.reason).toContain("capability (network) at src/hook.ts:2");
    const disguised = 'export async function deliver(url: string, body: string) {\n  await (globalThis as any)["fe" + "tch"](url, { method: "POST", body });\n}\n';
    const second = await c.decide(intent, [{ path: "src/hook.ts", after: disguised }]);
    expect(second.status).toBe("escalated");
    expect(second.reason).toContain("had a security finding (capability)");
    expect(c.ai.calls).toEqual([]);
  });

  it("an ordinary return keeps the second opinion's sentence and puts nothing on probation", async () => {
    const c = new Colonyish();
    c.ai.verdict = { verdict: "return", needs_human: 0.6, off_intent: false, sensitive: false, confidence: 0.9, reason: "add() ignores its second argument" };
    const intent = c.declare("human", ["src/add.ts"]);
    const p = await c.decide(intent, [{ path: "src/add.ts", after: MODULE }]);
    expect(p.reason).toContain("add() ignores its second argument");
    expect(c.engine.store.securityProbation(intent.id)).toBeNull();
  });
});

describe("vaccination honesty", () => {
  it("a vaccine whose second opinion was unavailable is an error, not a catch", async () => {
    const c = new Colonyish();
    c.ai.verdict = new Error("upstream returned 500");
    const intent = c.declare("agent", ["src/add.ts"], { ruleId: "rul_1", createdBy: "vaccine" });
    c.engine.store.registerVaccine(intent.id, "off-intent", "vb_1", Date.now());
    const p = await c.decide(intent, [{ path: "src/add.ts", after: MODULE }]);
    expect(p.status).toBe("rejected");
    expect(c.sealed[0]!.reason).toContain("not judged (a model layer was unavailable)");
    const report = c.engine.vaccineReport() as { overall: Record<string, number>; summary: string };
    expect(report.overall).toMatchObject({ n: 0, errors: 1, caught: 0 });
    expect(report.summary).toBe("no vaccine judged yet; 1 not judged (a model layer was unavailable), left out");
  });

  it("a vaccine a model returned is a measured catch, reported apart from those sent to a person", async () => {
    const c = new Colonyish();
    c.ai.verdict = { verdict: "return", needs_human: 0.7, off_intent: true, sensitive: false, confidence: 0.9, reason: "does more than the rule asks" };
    const returned = c.declare("agent", ["src/add.ts"], { ruleId: "rul_1", createdBy: "vaccine" });
    c.engine.store.registerVaccine(returned.id, "off-intent", "vb_1", Date.now());
    await c.decide(returned, [{ path: "src/add.ts", after: MODULE }]);
    const escalated = c.declare("agent", ["src/log.ts"], { ruleId: "rul_1", createdBy: "vaccine" });
    c.engine.store.registerVaccine(escalated.id, "secret-log", "vb_1", Date.now());
    await c.decide(escalated, [{ path: "src/log.ts", after: "console.log('[debug] using token', process.env.GITHUB_TOKEN);\n" }]);
    const report = c.engine.vaccineReport() as { overall: Record<string, number>; summary: string };
    expect(report.overall).toMatchObject({ n: 2, caught: 2, returned: 1, escalated: 1, returnedRecall: 0.5 });
    expect(report.summary).toBe("caught 2 of 2; 1 returned by a model or check; 1 sent to a person (their catch is not measured)");
  });
});

describe("antibody memory", () => {
  const ab: Antibody = { id: "ab_1", colonyId: "c1", origin: "human-reject", matcher: { paths: ["src/**"] }, question: "Does this change rename an exported function without updating its callers?", threshold: 0.7, createdAt: 1, hits: 0, falsePositives: 0 };

  it("a rejection an antibody already caught is counted on it, not minted again", async () => {
    const c = new Colonyish();
    c.engine.store.putAntibody(ab, "active");
    c.ai.clef = { ...CLEAN, "ab.ab_1": { type: "noul", noul: 0.95 } };
    const intent = c.declare("human", ["src/a.ts"]);
    const p = await c.decide(intent, [
      { path: "src/a.ts", after: MODULE },
      { path: "README.md", after: "notes\n" },
    ]);
    expect(p.status).toBe("escalated");
    c.engine.onHumanDecision(p, "reject", "renames add() again", "matt");
    expect(c.pending).toEqual([]);
    expect(c.engine.store.antibody("ab_1")).toMatchObject({ recurrences: 1, lastRecurrence: p.id });
    expect(c.engine.store.antibodies().length).toBe(1);
  });

  it("a miss still mints one", async () => {
    const c = new Colonyish();
    const p = await c.decide(c.declare("human", ["src/hook.ts"]), [{ path: "src/hook.ts", after: `${HOOK}console.log(process.env.API_TOKEN);\n` }]);
    expect(p.status).toBe("escalated");
    c.engine.onHumanDecision(p, "reject", "logs the API token", "matt");
    await Promise.all(c.pending);
    expect(c.engine.store.antibodies().length).toBe(1);
  });

  it("a change an antibody returns tells its agent the antibody's question", async () => {
    const c = new Colonyish();
    c.engine.store.putAntibody(ab, "active");
    c.ai.clef = { ...CLEAN, "ab.ab_1": { type: "noul", noul: 0.95 } };
    const p = await c.decide(c.declare("human", ["src/a.ts"]), [{ path: "src/a.ts", after: MODULE }]);
    expect(p.status).toBe("returned");
    expect(p.reason).toContain(ab.question);
  });
});

describe("the review view of an escalation", () => {
  it("holds the change with its danger patterns, secrets masked, for every escalation", async () => {
    const c = new Colonyish();
    const secret = 'export const API_KEY = "sk-live-4f9a8b7c6d5e4f3a2b1c0d9e";\nexport const region = "eu";\n';
    const p = await c.decide(c.declare("human", ["src/config.ts"]), [{ path: "src/config.ts", after: secret }]);
    expect(p.status).toBe("escalated");
    const view = c.engine.store.reviewView(p.id)!;
    expect(view.filesChanged).toBe(1);
    expect(view.danger.map((d) => d.pattern).sort()).toEqual(["secret:hardcoded", "secret:token-format"]);
    expect(view.danger.every((d) => d.label.endsWith(": (masked)"))).toBe(true);
    expect(JSON.stringify(view)).not.toContain("4f9a8b7c");
    expect(view.files[0]!.hunks).toContain('+export const region = "eu";');
  });

  it("is not written for a change that lands or goes back", async () => {
    const c = new Colonyish();
    const p = await c.decide(c.declare("human", ["src/add.ts"]), [{ path: "src/add.ts", after: MODULE }]);
    expect(c.engine.store.reviewView(p.id)).toBeNull();
  });
});
