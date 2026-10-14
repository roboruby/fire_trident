import { describe, expect, it } from "vitest";
import type { Colony, Decision, Id, Intent, IntentSource, Landing, Proposal } from "@fire_trident/core";
import type { Env } from "../../src/env.ts";
import { noteDecisions, type DecisionRow } from "../../src/colony/direction.ts";
import { DecideEngine, type DecideHost, type DecisionInput, type TrunkRpc } from "../../src/decide/engine.ts";
import type { KeepSource } from "../../src/decide/quotes.ts";
import type { ClefAnswer } from "../../src/decide/reflex.ts";

/**
 * Quoted acceptance through the decide pipeline (FT_QUOTED_ACCEPTANCE): a colony in memory around the engine, Clef
 * answering clean, and a second opinion whose reply each test sets.
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

class FakeAi {
  verdict: Record<string, unknown> = APPROVE;
  calls: Array<{ model: string; input: Record<string, unknown> }> = [];
  async run(model: string, input: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ model, input });
    if (input.questions) return { answers: Object.fromEntries(Object.keys(input.questions as object).map((id) => [id, CLEAN[id] ?? { type: "noul", noul: 0.02 }])) };
    return { response: JSON.stringify(this.verdict) };
  }
  /** The second opinion's requests. */
  opinions(): Array<Record<string, unknown>> {
    return this.calls.filter((c) => c.input.messages).map((c) => c.input);
  }
  prompt(i = 0): string {
    return ((this.opinions()[i]?.messages ?? []) as Array<{ content: string }>).map((m) => m.content).join("\n");
  }
}

class Colonyish implements DecideHost {
  readonly ai = new FakeAi();
  readonly blobs = new Map<string, string>();
  readonly env: Env;
  readonly sql = sqlStorage();
  readonly proposals = new Map<Id, Proposal>();
  readonly intents = new Map<Id, Intent>();
  readonly decisions: Decision[] = [];
  readonly engine: DecideEngine;
  keep: KeepSource | null = null;
  keepAsked: Array<{ intentId: Id; paths: string[] }> = [];
  private seq = 0;

  constructor(flag?: string) {
    const blobs = this.blobs;
    const artifacts = { get: async () => ({ readBlob: async (sha: string) => (blobs.has(sha) ? new Blob([blobs.get(sha)!]) : null) }) };
    this.env = { AI: this.ai, ARTIFACTS: artifacts, ...(flag !== undefined ? { FT_QUOTED_ACCEPTANCE: flag } : {}) } as unknown as Env;
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
    const decision: Decision = { ...d, id: `dec_${++this.seq}`, colonyId: COLONY.id, at: d.at ?? Date.now() + this.seq };
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
  keepAcceptance(intentId: Id, paths: string[]): KeepSource | null {
    this.keepAsked.push({ intentId, paths });
    return this.keep;
  }

  save(p: Proposal): void {
    this.proposals.set(p.id, p);
    this.sql.exec("INSERT INTO proposals (id, status) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status", p.id, p.status);
  }

  declare(source: IntentSource, over: Partial<Intent> = {}): Intent {
    const intent: Intent = { id: `int_${++this.seq}`, colonyId: COLONY.id, title: "Add slugify", why: "Links need readable slugs.", source, footprint: ["src/slug.ts"], priority: 1, status: "proposed", createdAt: 0, createdBy: "t", ...over };
    this.intents.set(intent.id, intent);
    return intent;
  }

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
      declared: { footprint: intent.footprint, summary: "Add slugify" },
      evidence: { checks: [], notVerified: "Not verified: no tests were run." },
      status: "checking",
      createdAt: Date.now(),
    };
    this.save(p);
    await this.engine.run(p.id);
    return this.proposals.get(p.id)!;
  }

  /** The second opinion's recorded decision for a proposal. */
  llmDecision(id: Id): Decision | undefined {
    return this.decisions.find((d) => d.subject === id && d.layer === "llm");
  }
}

const ACCEPTANCE = ["slugify lowercases its input", "slugify replaces each run of spaces with one hyphen"];
const BEFORE = "export function slugify(text: string): string {\n  return text.trim();\n}\n";
const AFTER = 'export function slugify(text: string): string {\n  const lower = text.toLowerCase();\n  return lower.replace(/ +/g, "-");\n}\n';
const ANSWERS = [
  { line: 1, verdict: "met", path: "src/slug.ts", quote: "const lower = text.toLowerCase();" },
  { line: 2, verdict: "met", path: "src/slug.ts", quote: 'return lower.replace(/ +/g, "-");' },
];

describe("flag off, or no acceptance list: exactly as today", () => {
  for (const [label, flag, acceptance] of [
    ["the flag absent", undefined, ACCEPTANCE],
    ["the flag naming another colony", "c2,c3", ACCEPTANCE],
    ["an intent without acceptance", "on", undefined],
  ] as const) {
    it(`${label}: the second opinion is asked as before and its approval lands the change`, async () => {
      const c = new Colonyish(flag);
      // A volunteered per-line answer is ignored when none was asked.
      c.ai.verdict = { ...APPROVE, acceptance: [{ line: 1, verdict: "not met", path: "", quote: "" }] };
      const p = await c.decide(c.declare("human", acceptance ? { acceptance: [...acceptance] } : {}), [{ path: "src/slug.ts", after: AFTER }]);
      expect(p.status).toBe("ready");
      const request = c.ai.opinions()[0]!;
      expect(request.max_tokens).toBe(2_000);
      expect(JSON.stringify(request.response_format)).not.toContain("acceptance");
      expect(c.ai.prompt()).not.toMatch(/acceptance/i);
      const llm = c.llmDecision(p.id)!;
      expect(llm.answers.rule).toBe("L3 innate+llm");
      expect(llm.answers).not.toHaveProperty("acceptance");
      expect((llm.answers.verdict as Record<string, unknown>).acceptance).toBeUndefined();
      expect(p.evidence.checks.map((k) => k.name)).not.toContain("acceptance: quoted");
      expect(c.keepAsked).toEqual([]);
    });
  }

  it("a repair intent from certification keeps today's rule: its lines are checked by running the tests", async () => {
    const c = new Colonyish("on");
    const p = await c.decide(c.declare("certify", { acceptance: ["Every test listed above passes under trunk certification"] }), [{ path: "src/slug.ts", before: BEFORE, after: AFTER }]);
    expect(p.status).toBe("ready");
    expect(c.ai.prompt()).not.toMatch(/acceptance/i);
  });
});

describe("flag on, an intent with an acceptance list", () => {
  it("lands when each line is met with a quote found in the diff, and the decision keeps each line with its quote", async () => {
    const c = new Colonyish("other,c1");
    c.ai.verdict = { ...APPROVE, acceptance: ANSWERS };
    const p = await c.decide(c.declare("agent", { acceptance: [...ACCEPTANCE] }), [{ path: "src/slug.ts", after: AFTER }]);
    expect(p.status).toBe("ready");
    const request = c.ai.opinions()[0]!;
    expect(JSON.stringify(request.response_format)).toContain('"acceptance"');
    expect(c.ai.prompt()).toContain("1. slugify lowercases its input\n2. slugify replaces each run of spaces with one hyphen");
    const llm = c.llmDecision(p.id)!;
    expect(llm.answers.rule).toBe("L3 innate+llm");
    expect(llm.answers.acceptance).toEqual([
      { kind: "intent", line: ACCEPTANCE[0], verdict: "met", path: "src/slug.ts", quote: "const lower = text.toLowerCase();" },
      { kind: "intent", line: ACCEPTANCE[1], verdict: "met", path: "src/slug.ts", quote: 'return lower.replace(/ +/g, "-");' },
    ]);
    expect(llm.answers.reasons).toContain("every acceptance line is met, each with a quote found in the diff (2 lines)");
    expect(p.evidence.checks.find((k) => k.name === "acceptance: quoted")).toMatchObject({ ok: true, detail: expect.stringContaining('line 2 met: src/slug.ts "return lower.replace') });

    // The lineage note keeps them with the decision (colony/direction.ts noteDecision).
    const rows: DecisionRow[] = c.decisions.map((d) => ({ id: d.id, kind: d.kind, subject: d.subject, layer: d.layer, answers: JSON.stringify(d.answers), p: d.p, action: d.action, at: d.at }));
    const note = noteDecisions(rows)[p.id]!.find((d) => d.layer === "llm")!;
    expect(note.acceptance).toEqual(llm.answers.acceptance);
  });

  it("an approval whose quote is from a removed line does not count: a person decides, told which line", async () => {
    const c = new Colonyish("on");
    c.ai.verdict = { ...APPROVE, acceptance: [ANSWERS[0], { line: 2, verdict: "met", path: "src/slug.ts", quote: "return text.trim();" }] };
    const p = await c.decide(c.declare("human", { acceptance: [...ACCEPTANCE] }), [{ path: "src/slug.ts", before: BEFORE, after: AFTER }]);
    expect(p.status).toBe("escalated");
    expect(p.reason).toContain('acceptance not shown met: line 2 "slugify replaces each run of spaces with one hyphen" (its quote is from a line the change removes from src/slug.ts)');
    expect(c.llmDecision(p.id)!.answers.rule).toBe("L7 acceptance unclear");
    expect(c.engine.store.reviewView(p.id)?.files[0]?.path).toBe("src/slug.ts");
  });

  it("a fabricated quote does not count either, and a reply with no per-line answers leaves every line unclear", async () => {
    const c = new Colonyish("on");
    c.ai.verdict = { ...APPROVE, acceptance: [ANSWERS[0], { line: 2, verdict: "met", path: "src/slug.ts", quote: 'return text.replaceAll(" ", "-");' }] };
    const fabricated = await c.decide(c.declare("human", { acceptance: [...ACCEPTANCE] }), [{ path: "src/slug.ts", after: AFTER }]);
    expect(fabricated.status).toBe("escalated");
    expect(c.llmDecision(fabricated.id)!.answers.acceptance).toMatchObject([{ verdict: "met" }, { verdict: "unclear", said: "met", problem: "its quote is not in the added or unchanged lines of src/slug.ts it was shown" }]);
    c.ai.verdict = APPROVE;
    const silent = await c.decide(c.declare("human", { acceptance: [...ACCEPTANCE] }), [{ path: "src/slug.ts", after: AFTER }]);
    expect(silent.status).toBe("escalated");
    expect(silent.reason).toContain("(the second opinion did not answer this line)");
  });

  it("a line answered not met sends the change back naming it", async () => {
    const c = new Colonyish("on");
    c.ai.verdict = { ...APPROVE, acceptance: [ANSWERS[0], { line: 2, verdict: "not met", path: "", quote: "" }] };
    const p = await c.decide(c.declare("human", { acceptance: [...ACCEPTANCE] }), [{ path: "src/slug.ts", after: "export function slugify(text: string): string {\n  return text.toLowerCase();\n}\n" }]);
    expect(p.status).toBe("returned");
    expect(p.reason).toContain('acceptance not met: line 2 "slugify replaces each run of spaces with one hyphen"; change it so it meets that line');
  });

  it("keep lines: the newest landing by another intent on the files it modifies is asked too, and breaking one sends the change back", async () => {
    const c = new Colonyish("on");
    c.keep = { landingId: "lnd_7", intentId: "int_other", acceptance: ["slugify keeps digits"], source: "agent" };
    c.ai.verdict = { ...APPROVE, acceptance: [...ANSWERS, { line: 3, verdict: "not met", path: "", quote: "" }] };
    const intent = c.declare("human", { acceptance: [...ACCEPTANCE] });
    const p = await c.decide(intent, [
      { path: "src/slug.ts", before: BEFORE, after: AFTER },
      { path: "src/new.ts", after: "export const fresh = 1;\n" },
    ]);
    // Only files it modifies are looked up: a file it adds has no landing to keep.
    expect(c.keepAsked).toEqual([{ intentId: intent.id, paths: ["src/slug.ts"] }]);
    expect(c.ai.prompt()).toMatch(/Keep lines, numbered: what a recent landing by another intent met in the files this change modifies \(answer each in "acceptance"\), between (fence-[0-9a-f]{12}) markers:\n\1\n3\. slugify keeps digits\n\1/);
    expect(p.status).toBe("returned");
    expect(p.reason).toContain('keep line 1 "slugify keeps digits" (from landing lnd_7); keep what that landing did unless your intent says otherwise');
  });

  it("a keep line that is met or unclear changes nothing, and a failing keep lookup is not a failure", async () => {
    const c = new Colonyish("on");
    c.keep = { landingId: "lnd_7", intentId: "int_other", acceptance: ["slugify keeps digits"], source: "agent" };
    c.ai.verdict = { ...APPROVE, acceptance: [...ANSWERS, { line: 3, verdict: "unclear", path: "", quote: "" }] };
    expect((await c.decide(c.declare("human", { acceptance: [...ACCEPTANCE] }), [{ path: "src/slug.ts", before: BEFORE, after: AFTER }])).status).toBe("ready");
    c.keepAcceptance = () => {
      throw new Error("index unavailable");
    };
    c.ai.verdict = { ...APPROVE, acceptance: ANSWERS };
    expect((await c.decide(c.declare("human", { acceptance: [...ACCEPTANCE] }), [{ path: "src/slug.ts", before: BEFORE, after: AFTER }])).status).toBe("ready");
  });
});
