import { describe, expect, it } from "vitest";
import type { Colony, Decision, Id, Intent, IntentSource, Landing, Proposal } from "@fire_trident/core";
import type { Env } from "../../src/env.ts";
import { DecideEngine, type DecideHost, type DecisionInput, type TrunkRpc } from "../../src/decide/engine.ts";
import { ESCALATION_BATCH_PER_HOUR, EscalationBatches, batchKeyOf, markBatches } from "../../src/decide/batch.ts";
import { CANARY_BATCH } from "../../src/decide/canary.ts";

/**
 * Escalation batching through the decide stage (FT_ESCALATION_BATCH): past the hourly budget, a change a danger pattern
 * sends to a person still waits for one (never landed, never sent back), counted in a batch the queue shows as one card.
 */

/** The part of node:sqlite these tests use (the worker compiles against workers types, not Node's). */
interface DatabaseSync {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  exec(sql: string): void;
}
const SQLITE = "node:sqlite";
const { DatabaseSync } = (await import(SQLITE)) as { DatabaseSync: new (path: string) => DatabaseSync };

function sqlStorage(): { sql: SqlStorage; db: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE proposals (id TEXT PRIMARY KEY, status TEXT NOT NULL)");
  const sql = {
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
  return { sql, db };
}

const COLONY: Colony = { id: "c1", name: "c1", trunk: { namespace: "ft-trunk", name: "c1", remote: "" }, trunkSha: "0".repeat(40), createdAt: 0, regionDepth: 1 };

/** No model is asked here: every change below stops at a danger pattern first. */
const AI = {
  async run(): Promise<unknown> {
    throw new Error("no model call expected");
  },
};

/** One colony around the engine, in memory, with FT_ESCALATION_BATCH set to `flag`. */
class Colonyish implements DecideHost {
  readonly blobs = new Map<string, string>();
  readonly env: Env;
  readonly sql: SqlStorage;
  readonly db: DatabaseSync;
  readonly proposals = new Map<Id, Proposal>();
  readonly intents = new Map<Id, Intent>();
  readonly bumps: string[] = [];
  readonly pending: Array<Promise<unknown>> = [];
  readonly engine: DecideEngine;
  private seq = 0;

  constructor(flag?: string) {
    ({ sql: this.sql, db: this.db } = sqlStorage());
    const blobs = this.blobs;
    const artifacts = { get: async () => ({ readBlob: async (sha: string) => (blobs.has(sha) ? new Blob([blobs.get(sha)!]) : null) }) };
    this.env = { AI, ARTIFACTS: artifacts, ...(flag ? { FT_ESCALATION_BATCH: flag } : {}) } as unknown as Env;
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
    return { ...d, id: `dec_${++this.seq}`, colonyId: COLONY.id, at: d.at ?? Date.now() };
  }
  decisionsFor(): Decision[] {
    return [];
  }
  bump(name: string): void {
    this.bumps.push(name);
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
  seal(id: Id, reason: string): void {
    this.save({ ...this.proposals.get(id)!, status: "rejected", reason });
  }

  save(p: Proposal): void {
    this.proposals.set(p.id, p);
    this.sql.exec("INSERT INTO proposals (id, status) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status", p.id, p.status);
  }

  declare(source: IntentSource, footprint: string[]): Intent {
    const intent: Intent = { id: `int_${++this.seq}`, colonyId: COLONY.id, title: "Deliver order webhooks", why: "Send a webhook when an order is created.", source, footprint, priority: 1, status: "proposed", createdAt: 0, createdBy: "t" };
    this.intents.set(intent.id, intent);
    return intent;
  }

  /** Propose new files and run the pipeline on them. */
  async decide(intent: Intent, files: Array<{ path: string; after: string }>): Promise<Proposal> {
    const p: Proposal = {
      id: `prp_${++this.seq}`,
      colonyId: COLONY.id,
      intentId: intent.id,
      agentId: "agt_1",
      workspace: { namespace: "ft-trunk", name: "ws", remote: "" },
      baseSha: COLONY.trunkSha,
      headSha: `${this.seq}`.padStart(40, "f"),
      writeSet: files.map((f) => {
        const id = `${(++this.seq).toString(16).padStart(8, "0")}${"a".repeat(32)}`;
        this.blobs.set(id, f.after);
        return { path: f.path, blob: id };
      }),
      readSet: [],
      declared: { footprint: intent.footprint, summary: "Deliver order webhooks with fetch" },
      evidence: { checks: [], notVerified: "Not verified: no tests were run." },
      status: "checking",
      createdAt: Date.now(),
    };
    this.save(p);
    await this.engine.run(p.id);
    return this.proposals.get(p.id)!;
  }

  /** Spend the hourly budget with escalations recorded just now. */
  spendBudget(): void {
    const batches = new EscalationBatches(this.sql);
    const other = batchKeyOf("L5 too large")!;
    for (let i = 0; i < ESCALATION_BATCH_PER_HOUR; i++) batches.record(`prp_earlier${i}`, other, Date.now() - 1_000);
  }
}

/** A new outbound call an agent's own intent cannot ask for: danger pattern capability (network), rule P1. */
const HOOK = (n: number) => `export async function deliver${n}(url: string, body: string) {\n  await fetch(url, { method: 'POST', body });\n}\n`;

/** A new program run no intent here asks for: danger patterns capability (import-process) and capability (process), rule P1. */
const RUN = "import { execSync } from \"node:child_process\";\nexport const publish = () => execSync(\"npm publish\");\n";

describe("escalation batching in the decide stage", () => {
  it("past the budget, danger-pattern changes still wait for a person, batched by their pattern", async () => {
    const c = new Colonyish("on");
    c.spendBudget();
    const a = await c.decide(c.declare("agent", ["src/a.ts"]), [{ path: "src/a.ts", after: HOOK(1) }]);
    const b = await c.decide(c.declare("agent", ["src/b.ts"]), [{ path: "src/b.ts", after: HOOK(2) }]);
    for (const p of [a, b]) {
      expect(p.status).toBe("escalated");
      expect(p.reason).toContain("capability (network)");
    }
    const rows = new EscalationBatches(c.sql).batchedOf([a.id, b.id]);
    expect([...rows.values()].map((r) => [r.proposalId, r.key, r.rule])).toEqual([
      [a.id, "P1|capability (network)", "P1 danger pattern"],
      [b.id, "P1|capability (network)", "P1 danger pattern"],
    ]);
    expect(c.bumps.filter((n) => n === "decide.escalations.batched")).toHaveLength(2);
    const queue: Array<{ id: Id; batch?: { ids: Id[]; label: string } }> = [{ id: a.id }, { id: b.id }];
    markBatches(queue, rows);
    expect(queue[0]!.batch).toMatchObject({ ids: [a.id, b.id], label: "hit the danger pattern capability (network)" });
  });

  it("past the budget, keeps auth, secret, governance and protected-path changes on their own cards", async () => {
    const c = new Colonyish("on");
    c.engine.store.setPolicy({ protectedPaths: ["src/infra/**"] });
    c.spendBudget();
    const changes: Array<[string, string]> = [
      ["src/auth.ts", "export function ok(req: Request, token: string) {\n  return req.headers.get(\"authorization\") === `Bearer ${token}`;\n}\n"],
      ["src/log.ts", "export function log() {\n  console.log(\"token\", process.env.API_TOKEN);\n}\n"],
      [".firetrident/antibodies/ab_x.json", "{\"id\":\"ab_x\"}\n"],
      ["src/infra/hook.ts", HOOK(9)],
    ];
    const ids: string[] = [];
    for (const [path, after] of changes) {
      const p = await c.decide(c.declare("agent", [path]), [{ path, after }]);
      expect(p.status, path).toBe("escalated");
      ids.push(p.id);
    }
    expect(c.db.prepare(`SELECT batched FROM decide_batches WHERE proposal_id IN (${ids.map(() => "?").join(",")})`).all(...ids)).toEqual(ids.map(() => ({ batched: 0 })));
    // Next to them, a capability change past the budget is batched.
    const net = await c.decide(c.declare("agent", ["src/net.ts"]), [{ path: "src/net.ts", after: HOOK(8) }]);
    expect([...new EscalationBatches(c.sql).batchedOf([...ids, net.id]).keys()]).toEqual([net.id]);
  });

  it("never counts or batches a blind canary: past the budget it still waits as a single escalation", async () => {
    const c = new Colonyish("on");
    c.spendBudget();
    const intent = c.declare("agent", ["src/canary.ts"]);
    c.engine.store.registerVaccine(intent.id, "secret-log", CANARY_BATCH, Date.now());
    const canary = await c.decide(intent, [{ path: "src/canary.ts", after: RUN }]);
    expect(canary.status).toBe("escalated");
    expect(c.db.prepare("SELECT proposal_id FROM decide_batches WHERE proposal_id = ?").all(canary.id)).toEqual([]);
    // An ordinary change of the same pattern next to it is batched.
    const run = await c.decide(c.declare("agent", ["src/run.ts"]), [{ path: "src/run.ts", after: RUN }]);
    expect([...new EscalationBatches(c.sql).batchedOf([canary.id, run.id]).keys()]).toEqual([run.id]);
  });

  it("reads the budget from the colony's decide policy", async () => {
    const c = new Colonyish("on");
    c.engine.store.setPolicy({ escalationBatchPerHour: 1 });
    const a = await c.decide(c.declare("agent", ["src/a.ts"]), [{ path: "src/a.ts", after: HOOK(1) }]);
    const b = await c.decide(c.declare("agent", ["src/b.ts"]), [{ path: "src/b.ts", after: HOOK(2) }]);
    expect([a.status, b.status]).toEqual(["escalated", "escalated"]);
    expect([...new EscalationBatches(c.sql).batchedOf([a.id, b.id]).keys()]).toEqual([b.id]);
  });

  it("under the budget, an escalation is counted and waits on its own card", async () => {
    const c = new Colonyish("c1");
    const a = await c.decide(c.declare("agent", ["src/a.ts"]), [{ path: "src/a.ts", after: HOOK(1) }]);
    expect(a.status).toBe("escalated");
    expect(new EscalationBatches(c.sql).batchedOf([a.id]).size).toBe(0);
    expect(c.db.prepare("SELECT proposal_id, batched FROM decide_batches").all()).toEqual([{ proposal_id: a.id, batched: 0 }]);
  });

  it("a rejection told not to mint (the rest of a rejected batch) mints no antibody, and the first one mints one", async () => {
    const c = new Colonyish("on");
    const a = await c.decide(c.declare("agent", ["src/a.ts"]), [{ path: "src/a.ts", after: HOOK(1) }]);
    const b = await c.decide(c.declare("agent", ["src/b.ts"]), [{ path: "src/b.ts", after: HOOK(2) }]);
    c.engine.onHumanDecision(b, "reject", "No new network calls in the store.", "matt", false);
    await Promise.all(c.pending);
    expect(c.engine.store.antibodies()).toHaveLength(0);
    c.engine.onHumanDecision(a, "reject", "No new network calls in the store.", "matt");
    await Promise.all(c.pending);
    expect(c.engine.store.antibodies()).toHaveLength(1);
  });

  it("with the flag off, nothing is counted or batched and the table is never made", async () => {
    for (const flag of [undefined, "off", "c2"]) {
      const c = new Colonyish(flag);
      const a = await c.decide(c.declare("agent", ["src/a.ts"]), [{ path: "src/a.ts", after: HOOK(1) }]);
      expect(a.status).toBe("escalated");
      expect(c.db.prepare("SELECT name FROM sqlite_master WHERE name = 'decide_batches'").all()).toEqual([]);
      expect(c.bumps).not.toContain("decide.escalations.batched");
    }
  });
});
