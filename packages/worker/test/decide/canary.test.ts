import { describe, expect, it } from "vitest";
import type { Colony, Decision, Id, Intent, Landing, Proposal } from "@fire_trident/core";
import type { Env } from "../../src/env.ts";
import { CANARY_BATCH, canaryChange, canaryDraw, canaryLine, canaryMeasures, canaryReveal, pickCanary, type CanaryTarget } from "../../src/decide/canary.ts";
import { DecideEngine, type DecideHost, type DecisionInput, type TrunkRpc } from "../../src/decide/engine.ts";

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
const APP = "import { log } from './log';\n\nexport function greet(name: string): string {\n  return `hello ${name}`;\n}\n";
const GUARD = "export function handler(req: { user?: string }) {\n  if (!req.user) throw new Error('unauthorized');\n  return req.user;\n}\n";

/** The AI binding: every call is recorded; a canary must never make one. */
class CountingAi {
  calls: string[] = [];
  async run(model: string): Promise<unknown> {
    this.calls.push(model);
    return { response: "{}" };
  }
}

/** A colony around the engine, all in memory (as test/decide/engine.test.ts builds it). */
class Colonyish implements DecideHost {
  readonly ai = new CountingAi();
  readonly blobs = new Map<string, string>();
  readonly env: Env;
  readonly sql = sqlStorage();
  readonly proposals = new Map<Id, Proposal>();
  readonly intents = new Map<Id, Intent>();
  readonly sealed: Array<{ id: Id; reason: string }> = [];
  readonly engine: DecideEngine;
  private seq = 0;

  constructor() {
    const blobs = this.blobs;
    const artifacts = { get: async () => ({ readBlob: async (sha: string) => (blobs.has(sha) ? new Blob([blobs.get(sha)!]) : null) }) };
    this.env = { AI: this.ai, ARTIFACTS: artifacts } as unknown as Env;
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
    return { kind: "synthetic" as const, name: "synthetic-abcd-1", model: "canary" };
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
  bump(): void {}
  setMetric(): void {}
  emit(): void {}
  trunk(): TrunkRpc {
    return {
      baseBlobs: async () => [],
      blobsFor: async (paths) => Object.fromEntries(paths.map((p) => [p, null])),
      readFile: async () => null,
      files: async () => [],
      systemCommit: async () => ({ id: "lnd_ab" }) as unknown as Landing,
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

  /** A canary on src/app.ts (a rule's intent, sealed in the vaccine registry as batch "canary") with this new text, decided. */
  async canary(before: string, after: string, cls = "secret-log"): Promise<Proposal> {
    const n = ++this.seq;
    const intent: Intent = { id: `int_${n}`, colonyId: COLONY.id, title: "Greet through the logger", why: "One logging module.", source: "agent", ruleId: "rul_1", footprint: ["src/app.ts"], priority: 0, status: "claimed", createdAt: 0, createdBy: "vaccine" };
    this.intents.set(intent.id, intent);
    this.engine.store.registerVaccine(intent.id, cls, CANARY_BATCH, Date.now());
    const blob = (text: string): string => {
      const id = `${(++this.seq).toString(16).padStart(8, "0")}${"a".repeat(32)}`;
      this.blobs.set(id, text);
      return id;
    };
    const p: Proposal = {
      id: `prp_${n}`,
      colonyId: COLONY.id,
      intentId: intent.id,
      agentId: "agt_canary",
      workspace: { namespace: "ft-trunk", name: "c1--vaccine", remote: "" },
      baseSha: COLONY.trunkSha,
      headSha: `${n}`.padStart(40, "f"),
      writeSet: [{ path: "src/app.ts", blob: blob(after) }],
      readSet: [{ path: "src/app.ts", blob: blob(before) }],
      declared: { footprint: ["src/app.ts"], summary: "Greet through the logger: deterministic replacement in src/app.ts" },
      evidence: { checks: [{ name: "recheck src/app.ts", ok: true, ms: 1 }], notVerified: "Deterministic replacement re-checked against the rule only." },
      status: "checking",
      createdAt: Date.now(),
    };
    this.save(p);
    this.engine.store.linkVaccine(intent.id, p.id);
    await this.engine.run(p.id);
    return this.proposals.get(p.id)!;
  }
}

const target = (content: string, path = "src/app.ts"): CanaryTarget => ({ intent: { title: "Greet through the logger", why: "One logging module.", footprint: [path], ruleId: "rul_1" }, file: { path, content }, rule: null });

describe("canaries in the decide pipeline", () => {
  it("a canary the danger scan sends to a person waits in the queue as a real escalation, and no model is asked", async () => {
    const c = new Colonyish();
    const built = canaryChange("secret-log", 0, target(APP))!;
    const p = await c.canary(APP, built.change.files[0]!.after);
    expect(p.status).toBe("escalated");
    expect(p.reason).toMatch(/^escalated by deterministic: danger patterns need a human: secret/);
    expect(c.ai.calls).toEqual([]);
    expect(c.sealed).toEqual([]);
    // Its card is built like any escalation's, the secret masked.
    const view = c.engine.store.reviewView(p.id);
    expect(view?.files.map((f) => f.path)).toEqual(["src/app.ts"]);
    expect(view?.danger.some((d) => d.cls === "secret")).toBe(true);
    // Sealed all the same, and it says nothing about its region, its intent or the vaccination meter.
    expect(c.engine.store.vaccineByIntent(p.intentId)).toMatchObject({ batch: "canary", outcome: "escalated" });
    expect(c.engine.store.vaccines()).toEqual([]);
    expect(c.engine.store.autonomyTable(3)).toEqual([]);
    expect(c.engine.store.securityProbation(p.intentId)).toBeNull();
    expect(c.engine.store.escalationsSince(0)).toBe(0);
  });

  it("a canary only a model could stop is discarded, sealed, before any model is asked", async () => {
    const c = new Colonyish();
    const p = await c.canary(APP, `${APP}export const extra = 1;\n`, "off-intent");
    expect(p.status).toBe("rejected");
    expect(c.sealed[0]?.reason).toMatch(/^canary \(sealed\): not sent to a person by the deterministic stage, so it was discarded before any model was asked: /);
    expect(c.ai.calls).toEqual([]);
    expect(c.engine.store.vaccineByIntent(p.intentId)).toMatchObject({ outcome: "error" });
  });
});

describe("building a canary", () => {
  it("takes only classes the danger scan sends to a person on its own", () => {
    expect(canaryChange("secret-log", 0, target(APP))?.labels.join(" ")).toMatch(/secret/);
    expect(canaryChange("forbidden-import", 0, target(APP))?.labels.join(" ")).toMatch(/capability/);
    // A loosened guard is a signal for a model, never a person on its own: not a canary.
    expect(canaryChange("loosened-guard", 0, target(GUARD, "src/handler.ts"))).toBeNull();
    // A policy allowance that waives the class waives the canary too.
    expect(canaryChange("forbidden-import", 0, target(APP), [{ cls: "capability", by: "policy" }])).toBeNull();
  });

  it("picks the same canary from the same seed, and another from another", () => {
    const targets = [target(APP), target(GUARD, "src/handler.ts")];
    expect(pickCanary(7, targets)).toEqual(pickCanary(7, targets));
    const classes = new Set(Array.from({ length: 10 }, (_, s) => pickCanary(s, targets)?.change.cls));
    expect([...classes].sort()).toEqual(["forbidden-import", "secret-log"]);
    expect(pickCanary(0, [])).toBeNull();
  });

  it("draws from the escalation's id, at the rate", () => {
    expect(canaryDraw("prp_1", 0)).toBe(false);
    expect(canaryDraw("prp_1", 0.2)).toBe(canaryDraw("prp_1", 0.2));
    const n = Array.from({ length: 2000 }, (_, i) => canaryDraw(`prp_${i}`, 0.05)).filter(Boolean).length;
    expect(n).toBeGreaterThan(60);
    expect(n).toBeLessThan(140);
  });
});

describe("scoring and revealing", () => {
  it("says plainly what it was and how the decision counted", () => {
    expect(canaryReveal("approved", "approve", "secret-log")).toBe(
      "This was a canary, not a real change: a sealed known-bad change that prints a secret to the logs, put in the review queue to check that people catch what review sends them. You approved it, so it counts as missed; it was sealed and can never land, so nothing changed. Before you approve the next escalation, read the lines its card lists first.",
    );
    expect(canaryReveal("caught", "return", "forbidden-import")).toBe(
      "Caught: this was a canary, not a real change: a sealed known-bad change that adds a forbidden import, put in the review queue to check that people catch what review sends them. Your return counts as a catch; it was discarded, no antibody was minted, and nothing changed.",
    );
  });

  it("measures the catch rate with its interval, and never names a canary still waiting", () => {
    const row = (outcome: string, cls = "secret-log", review: string | null = "escalated") => ({ proposalId: `prp_${outcome}_${Math.random()}`, cls, outcome, decision: outcome === "approved" ? "approve" : "reject", by: "lee", decidedAt: 1, createdAt: 1, review });
    const m = canaryMeasures([...Array.from({ length: 4 }, () => row("caught")), row("approved", "forbidden-import"), row("pending"), row("pending", "secret-log", "error")], 0.05);
    expect(m).toMatchObject({ on: true, made: 7, waiting: 1, discarded: 1, decided: 5, caught: 4, approved: 1, catchRate: 0.8, lo: 0.376, hi: 0.964 });
    expect(m.classes["secret-log"]).toMatchObject({ decided: 4, caught: 4, catchRate: 1 });
    expect(m.revealed).toHaveLength(5);
    expect(m.line).toBe("canaries: 4 of 5 caught (80%, 38–96%), 1 approved");
    expect(canaryLine({ on: false, rate: 0, decided: 0, caught: 0, approved: 0, catchRate: 0, lo: 0, hi: 1 })).toBe("canaries off");
    expect(canaryLine({ on: true, rate: 0.05, decided: 0, caught: 0, approved: 0, catchRate: 0, lo: 0, hi: 1 })).toBe("canaries on (about 5% of escalations): none decided yet");
  });
});
