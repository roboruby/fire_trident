import { describe, expect, it } from "vitest";
import type { Colony, Decision, Id, Intent, Landing, Path, Proposal, Sha } from "@fire_trident/core";
import type { Env } from "../../src/env.ts";
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
        one: () => rows[0],
        [Symbol.iterator]: () => rows[Symbol.iterator](),
      };
    },
  } as unknown as SqlStorage;
}

const COLONY: Colony = { id: "c1", name: "c1", trunk: { namespace: "ft-trunk", name: "c1", remote: "" }, trunkSha: "0".repeat(40), createdAt: 0, regionDepth: 1 };

/** Workers AI as the engine calls it: clean reflex answers and an approving second opinion. */
const AI = {
  async run(_model: string, input: Record<string, unknown>): Promise<unknown> {
    if (input.questions) return { answers: Object.fromEntries(Object.keys(input.questions as object).map((id) => [id, id === "risk" ? { type: "score", score: 0.4, probabilities: {}, confidence: 0.9 } : { type: "noul", noul: 0.02 }])) };
    return { response: JSON.stringify({ verdict: "approve", needs_human: 0.05, off_intent: false, sensitive: false, confidence: 0.95, reason: "does what the intent asks" }) };
  },
};

/** A colony around the engine with a trunk holding `files`, and FT_REVALIDATE set to `revalidate`. */
class Host implements DecideHost {
  readonly blobs = new Map<string, string>();
  readonly env: Env;
  readonly sql = sqlStorage();
  readonly proposals = new Map<Id, Proposal>();
  readonly intents = new Map<Id, Intent>();
  readonly decisions: Decision[] = [];
  readonly asked: Path[][] = [];
  readonly engine: DecideEngine;
  private seq = 0;

  constructor(
    private readonly files: Record<Path, Sha>,
    revalidate?: string,
  ) {
    const blobs = this.blobs;
    const artifacts = { get: async () => ({ readBlob: async (sha: string) => (blobs.has(sha) ? new Blob([blobs.get(sha)!]) : null) }) };
    this.env = { AI, ARTIFACTS: artifacts, ...(revalidate !== undefined ? { FT_REVALIDATE: revalidate } : {}) } as unknown as Env;
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
  bump(): void {}
  setMetric(): void {}
  emit(): void {}
  trunk(): TrunkRpc {
    return {
      baseBlobs: async () => [],
      blobsFor: async (paths) => {
        this.asked.push(paths);
        return Object.fromEntries(paths.map((p) => [p, this.files[p] ?? null]));
      },
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

  /** A person's intent for one file (new, or edited from `before`), proposed and decided. */
  async decide(path: Path, text: string, before?: string): Promise<Proposal> {
    const intent: Intent = { id: `int_${++this.seq}`, colonyId: COLONY.id, title: "Add the module", why: "The spec asks for it.", source: "human", footprint: [path], priority: 1, status: "proposed", createdAt: 0, createdBy: "t" };
    this.intents.set(intent.id, intent);
    const store = (t: string): string => {
      const id = `${(++this.seq).toString(16).padStart(8, "0")}${"a".repeat(32)}`;
      this.blobs.set(id, t);
      return id;
    };
    const blob = store(text);
    const p: Proposal = {
      id: `prp_${++this.seq}`,
      colonyId: COLONY.id,
      intentId: intent.id,
      agentId: "agt_1",
      workspace: { namespace: "ft-trunk", name: "ws", remote: "" },
      baseSha: COLONY.trunkSha,
      headSha: `${this.seq}`.padStart(40, "f"),
      writeSet: [{ path, blob }],
      readSet: [{ path: "src/add.ts", blob: "b".repeat(40) }, ...(before !== undefined ? [{ path, blob: store(before) }] : [])],
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

const TRUNK: Record<Path, Sha> = { "src/add.ts": "b".repeat(40), "src/ns.ts": "c".repeat(40) };
const READER = 'import { add, sub as minus } from "./add";\nimport * as ns from "./ns";\n\nexport const total = add(1, minus(3, 2)) + Object.keys(ns).length;\n';

describe("decide: name assumptions (assumption revalidation)", () => {
  it("records the names a change imports from trunk files when FT_REVALIDATE is on for the colony", async () => {
    const h = new Host(TRUNK, "other,c1");
    const p = await h.decide("src/total.ts", READER);
    expect(p.status).toBe("ready");
    // src/ns.ts is imported as a namespace: no checkable names, so no assumption for it.
    expect(p.nameAssumptions).toEqual([{ path: "src/add.ts", names: ["add", "sub"] }]);
    expect(h.asked.flat()).toContain("src/add.ts");
  });

  it("also covers imports the change did not touch (an edited file)", async () => {
    const h = new Host(TRUNK, "on");
    const p = await h.decide("src/total.ts", READER, READER.replace("add(1,", "add(2,"));
    expect(p.nameAssumptions).toEqual([{ path: "src/add.ts", names: ["add", "sub"] }]);
  });

  it("records none, and asks the trunk about nothing more, when it is off", async () => {
    for (const setting of [undefined, "off", "other"]) {
      const h = new Host(TRUNK, setting);
      expect((await h.decide("src/total.ts", READER)).nameAssumptions).toBeUndefined();
      // Same imports before and after: the proof has no specifier to resolve, so the trunk is not asked at all.
      const edited = await h.decide("src/total.ts", READER, READER.replace("add(1,", "add(2,"));
      expect(edited.nameAssumptions).toBeUndefined();
      expect(h.asked).toHaveLength(1);
    }
  });
});
