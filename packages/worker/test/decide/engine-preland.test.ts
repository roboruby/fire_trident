import { describe, expect, it } from "vitest";
import type { Colony, Decision, Id, Intent, Landing, Path, PrelandRun, Proposal, Sha } from "@fire_trident/core";
import type { Env } from "../../src/env.ts";
import { DecideEngine, type DecideHost, type DecisionInput, type TrunkRpc } from "../../src/decide/engine.ts";
import { PRELAND_CHECK, prelandCheck, prelandReason, type PrelandOutcome } from "../../src/certify/preland.ts";

/**
 * The decide stage's hooks for tests before landing (FT_PRELAND): with review on, the check runs before the gate and a
 * failing one sends the change back before any model is asked; with review off, a change here only for its tests goes
 * to its lane or back. A colony whose host offers no check decides exactly as before.
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
      return { toArray: () => rows, one: () => rows[0], [Symbol.iterator]: () => rows[Symbol.iterator]() };
    },
  } as unknown as SqlStorage;
}

const COLONY: Colony = { id: "c1", name: "c1", trunk: { namespace: "ft-trunk", name: "c1", remote: "" }, trunkSha: "0".repeat(40), createdAt: 0, regionDepth: 1 };

/** Workers AI as the engine calls it (clean reflex answers, an approving second opinion), counting its calls. */
class Ai {
  calls = 0;
  async run(_model: string, input: Record<string, unknown>): Promise<unknown> {
    this.calls++;
    if (input.questions) return { answers: Object.fromEntries(Object.keys(input.questions as object).map((id) => [id, id === "risk" ? { type: "score", score: 0.4, probabilities: {}, confidence: 0.9 } : { type: "noul", noul: 0.02 }])) };
    return { response: JSON.stringify({ verdict: "approve", needs_human: 0.05, off_intent: false, sensitive: false, confidence: 0.95, reason: "does what the intent asks" }) };
  }
}

/** The outcome a check reports, as the certifier builds it. */
function outcome(run: Omit<PrelandRun, "ms">): PrelandOutcome {
  const full: PrelandRun = { ...run, ms: 42 };
  const reason = full.status === "failed" ? prelandReason(full.broke ?? []) : undefined;
  return { run: full, check: prelandCheck(full, reason), ...(reason ? { reason } : {}) };
}

const BROKE = outcome({ status: "failed", files: ["test/math.test.ts"], tests: 1, passed: 0, failed: 1, broke: [{ file: "test/math.test.ts", name: "subtracts", error: "actual 8, expected 2" }] });
const PASSED = outcome({ status: "passed", files: ["test/math.test.ts"], tests: 1, passed: 1, failed: 0 });
const BUSY = outcome({ status: "unchecked", files: [], tests: 0, passed: 0, failed: 0, reason: "busy: 3 test runs before landing were already going in this colony" });

/** A colony around the engine; `check` is what its tests before landing answer (undefined: the host offers none). */
class Host implements DecideHost {
  readonly ai = new Ai();
  readonly blobs = new Map<string, string>();
  readonly env: Env;
  readonly sql = sqlStorage();
  readonly proposals = new Map<Id, Proposal>();
  readonly intents = new Map<Id, Intent>();
  readonly decisions: Decision[] = [];
  readonly asked: Array<{ id: Id; texts: string[] }> = [];
  readonly engine: DecideEngine;
  readonly prelandCovers?: (p: Proposal) => boolean;
  readonly preland?: (p: Proposal, texts?: ReadonlyMap<Sha, string>) => Promise<PrelandOutcome | null>;
  private seq = 0;

  constructor(check: PrelandOutcome | null | undefined, opts: { review?: boolean; protect?: string[] } = {}) {
    const blobs = this.blobs;
    const artifacts = { get: async () => ({ readBlob: async (sha: string) => (blobs.has(sha) ? new Blob([blobs.get(sha)!]) : null) }) };
    this.env = { ...(opts.review === false ? {} : { AI: this.ai }), ARTIFACTS: artifacts } as unknown as Env;
    this.engine = new DecideEngine(this);
    if (opts.protect) this.engine.store.setPolicy({ ...this.engine.store.policy(), protectedPaths: opts.protect });
    if (check !== undefined) {
      this.prelandCovers = () => check !== null;
      this.preland = async (p, texts) => {
        this.asked.push({ id: p.id, texts: [...(texts?.values() ?? [])] });
        return check;
      };
    }
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

  /** A person's intent for one new file, proposed and decided. */
  async decide(path: Path, text: string): Promise<Proposal> {
    const intent: Intent = { id: `int_${++this.seq}`, colonyId: COLONY.id, title: "Add the module", why: "The spec asks for it.", source: "human", footprint: [path], priority: 1, status: "proposed", createdAt: 0, createdBy: "t" };
    this.intents.set(intent.id, intent);
    const blob = `${(++this.seq).toString(16).padStart(8, "0")}${"a".repeat(32)}`;
    this.blobs.set(blob, text);
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
      declared: { footprint: [path], summary: "Add the module" },
      evidence: { checks: [], notVerified: "Not verified: no tests were run." },
      status: "checking",
      createdAt: Date.now(),
    };
    this.save(p);
    await this.engine.run(p.id);
    return this.proposals.get(p.id)!;
  }
}

const MODULE = "export function sub(a: number, b: number): number {\n  return a - b;\n}\n";

describe("decide with review on: tests before landing run before the gate", () => {
  it("sends a change back before any model when a test that passed on trunk fails with it, naming the test", async () => {
    const h = new Host(BROKE);
    const p = await h.decide("src/math.ts", MODULE);
    expect(p.status).toBe("returned");
    expect(p.reason).toBe(`deterministic: ${BROKE.reason}`);
    expect(p.reason).toContain('the test "subtracts" in test/math.test.ts passed on trunk and fails with this change: actual 8, expected 2');
    expect(h.ai.calls).toBe(0);
    expect(p.evidence.preland).toEqual(BROKE.run);
    expect(p.evidence.checks.find((c) => c.name === PRELAND_CHECK)).toEqual(BROKE.check);
    expect(p.evidence.checks.find((c) => c.name === "gate")?.detail).toMatch(/^T1 tests before landing → return by deterministic/);
    // The change's new file reached the check from the innate checks' read: nothing was read twice.
    expect(h.asked).toEqual([{ id: p.id, texts: [MODULE] }]);
  });

  it("goes on to the gate as before when the tests pass or were not checked, with the run in its evidence", async () => {
    for (const check of [PASSED, BUSY]) {
      const h = new Host(check);
      const p = await h.decide("src/math.ts", MODULE);
      expect(p.status).toBe("ready");
      expect(h.ai.calls).toBeGreaterThan(0);
      expect(p.evidence.preland).toEqual(check.run);
      expect(p.evidence.checks.find((c) => c.name === PRELAND_CHECK)).toMatchObject({ ok: true, ms: 42 });
    }
  });

  it("decides exactly as before when the host offers no check, or it does not cover the change", async () => {
    const plain = await new Host(undefined).decide("src/math.ts", MODULE);
    for (const h of [new Host(null)]) {
      const p = await h.decide("src/math.ts", MODULE);
      expect(p.status).toBe(plain.status);
      expect(p.evidence.preland).toBeUndefined();
      expect(p.evidence.checks.map((c) => c.name)).toEqual(plain.evidence.checks.map((c) => c.name));
    }
    expect(plain.evidence.checks.some((c) => c.name === PRELAND_CHECK)).toBe(false);
  });
});

describe("decide with review off: a change here only for its tests", () => {
  it("goes to its lane with the run in its evidence, or back when a test that passed on trunk fails", async () => {
    const ok = new Host(PASSED, { review: false });
    const landed = await ok.decide("src/math.ts", MODULE);
    expect(landed.status).toBe("ready");
    expect(landed.evidence.preland).toEqual(PASSED.run);
    expect(landed.evidence.checks.map((c) => c.name)).toEqual([PRELAND_CHECK]);
    expect(ok.ai.calls).toBe(0);

    const bad = new Host(BROKE, { review: false });
    const back = await bad.decide("src/math.ts", MODULE);
    expect(back.status).toBe("returned");
    expect(back.reason).toBe(BROKE.reason);
    expect(back.evidence.preland).toEqual(BROKE.run);
  });

  it("leaves a change on a protected path to the full decide path, where its tests run before the person", async () => {
    const h = new Host(PASSED, { review: false, protect: ["src/math.ts"] });
    const p = await h.decide("src/math.ts", MODULE);
    expect(p.status).toBe("escalated");
    expect(p.reason).toMatch(/protected paths need a person/);
    expect(p.evidence.preland).toEqual(PASSED.run);
  });
});
