import { afterEach, describe, expect, it, vi } from "vitest";
import type { Colony, Decision, Id, Intent, IntentSource, Landing, Proposal, RemovedOwner } from "@fire_trident/core";
import { removedLines } from "@fire_trident/core";
import type { Env } from "../../src/env.ts";
import type { InnateFile } from "../../src/colony/innate.ts";
import { DecideEngine, type DecideHost, type DecisionInput, type TrunkRpc } from "../../src/decide/engine.ts";
import { checkGoalConflict, traceFiles } from "../../src/decide/goalconflict.ts";
import type { RemovedLinesQuery } from "../../src/decide/undone.ts";

/** The part of node:sqlite these tests use (the worker compiles against workers types, not Node's). */
interface DatabaseSync {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  exec(sql: string): void;
}
const SQLITE = "node:sqlite";
const { DatabaseSync } = (await import(SQLITE)) as { DatabaseSync: new (path: string) => DatabaseSync };

function sqlStorage(): SqlStorage {
  const db = new DatabaseSync(":memory:");
  // The colony's proposals table, as far as the decide store reads it.
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
const APPROVE = { verdict: "approve", needs_human: 0.05, off_intent: false, sensitive: false, confidence: 0.95, reason: "does what the intent asks" };

/** The AI binding as the engine calls it: Clef answers every question with a confident no, the second opinion approves. */
class FakeAi {
  calls = 0;
  async run(_model: string, input: Record<string, unknown>): Promise<unknown> {
    this.calls++;
    if (input.questions) {
      return { answers: Object.fromEntries(Object.keys(input.questions as object).map((id) => [id, id === "risk" ? { type: "score", score: 0.4, probabilities: {}, confidence: 0.9 } : { type: "noul", noul: 0.02 }])) };
    }
    return { response: JSON.stringify(APPROVE) };
  }
}

const RUST = 'export const language = "rust";\nexport const build = "cargo build";\nexport const start = "./orders";\nexport const health = "rust up";\nexport const port = 8080;\n';
const GO = 'export const language = "go";\nexport const build = "go build";\nexport const start = "./orders-go";\nexport const health = "go up";\nexport const port = 8080;\n';

/** A colony around the decide engine: intents, proposals and blobs in memory, and a trunk writer whose trace answers `owners`. */
class Colonyish implements DecideHost {
  readonly ai = new FakeAi();
  readonly blobs = new Map<string, string>();
  readonly env: Env;
  readonly sql = sqlStorage();
  readonly proposals = new Map<Id, Proposal>();
  readonly intents = new Map<Id, Intent>();
  readonly engine: DecideEngine;
  /** What the trunk writer's trace answers (a function of the query), or an error it throws; null: a trunk writer without the method. */
  owners: ((q: RemovedLinesQuery) => RemovedOwner[]) | Error | null = () => [];
  readonly queries: RemovedLinesQuery[] = [];
  private seq = 0;

  constructor(flag?: string) {
    const blobs = this.blobs;
    const artifacts = { get: async () => ({ readBlob: async (sha: string) => (blobs.has(sha) ? new Blob([blobs.get(sha)!]) : null) }) };
    this.env = { AI: this.ai, ARTIFACTS: artifacts, ...(flag !== undefined ? { FT_GOAL_CONFLICT: flag } : {}) } as unknown as Env;
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
    return { ...d, id: `dec_${++this.seq}`, colonyId: COLONY.id, at: d.at ?? Date.now() };
  }
  decisionsFor(): Decision[] {
    return [];
  }
  bump(): void {}
  setMetric(): void {}
  emit(): void {}
  trunk(): TrunkRpc {
    const rpc: TrunkRpc = {
      baseBlobs: async () => [],
      blobsFor: async (paths) => Object.fromEntries(paths.map((p) => [p, null])),
      readFile: async () => null,
      files: async () => [],
      systemCommit: async () => ({ id: "lnd_sys" }) as unknown as Landing,
    };
    const owners = this.owners;
    if (owners === null) return rpc;
    rpc.removedLineOwners = async (q) => {
      this.queries.push(q);
      if (owners instanceof Error) throw owners;
      return { owners: owners(q), skipped: [] };
    };
    return rpc;
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

  declare(id: Id, source: IntentSource = "human", over: Partial<Intent> = {}): Intent {
    const intent: Intent = { id, colonyId: COLONY.id, title: `Intent ${id}`, why: `Why ${id}.`, source, footprint: ["src/backend.ts"], priority: 1, status: "proposed", createdAt: 0, createdBy: "t", ...over };
    this.intents.set(id, intent);
    return intent;
  }

  blob(text: string): string {
    const id = `${(++this.seq).toString(16).padStart(8, "0")}${"a".repeat(32)}`;
    this.blobs.set(id, text);
    return id;
  }

  /** Propose changing src/backend.ts from `before` to `after` for `intent` and run the decide stage on it (`notVerified` "": no statement). */
  async decide(intent: Intent, before: string, after: string | null, notVerified = "Not verified: nothing was run."): Promise<Proposal> {
    const p: Proposal = {
      id: `prp_${++this.seq}`,
      colonyId: COLONY.id,
      intentId: intent.id,
      agentId: "agt_1",
      workspace: { namespace: "ft-trunk", name: "ws", remote: "" },
      baseSha: COLONY.trunkSha,
      headSha: `${this.seq}`.padStart(40, "f"),
      writeSet: [{ path: "src/backend.ts", blob: after === null ? null : this.blob(after) }],
      readSet: [{ path: "src/backend.ts", blob: this.blob(before) }],
      declared: { footprint: intent.footprint, summary: intent.title },
      evidence: { checks: [], notVerified },
      status: "checking",
      createdAt: Date.now(),
    };
    this.save(p);
    await this.engine.run(p.id);
    return this.proposals.get(p.id)!;
  }
}

/** The trunk writer's trace: landing lnd_rust wrote the removed lines of src/backend.ts for `intentId`, all of its lines there. */
function rustLanding(intentId: Id, over: Partial<RemovedOwner> = {}): (q: RemovedLinesQuery) => RemovedOwner[] {
  return (q) => q.files.map((f) => ({ landingId: "lnd_rust", at: Date.now() - 3 * 60_000 - 10_000, rank: 0, path: f.path, removed: f.removed.length, lines: f.removed.length, intentId, proposalId: "prp_rust", ...over }));
}

const check = (p: Proposal) => p.evidence.checks.find((c) => c.name === "goal conflict");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("decide: the goal-conflict check (FT_GOAL_CONFLICT)", () => {
  it("off when the flag does not cover the colony: the trunk writer is never asked and the change goes on as before", async () => {
    for (const flag of [undefined, "off", "c2,c3"]) {
      const c = new Colonyish(flag);
      c.owners = rustLanding(c.declare("int_rust").id);
      const p = await c.decide(c.declare("int_go"), RUST, GO);
      expect(p.status).toBe("ready");
      expect(check(p)).toBeUndefined();
      expect(c.queries).toEqual([]);
      expect(p.undoes).toBeUndefined();
    }
  });

  it("sends a change that undoes another intent's recent landing to a person, before any model, naming the landing", async () => {
    const c = new Colonyish("on");
    c.declare("int_rust", "human", { title: "Move the backend to Rust", why: "One static binary." });
    c.owners = rustLanding("int_rust");
    const p = await c.decide(c.declare("int_go"), RUST, GO);
    const reason = 'would undo 4 lines in src/backend.ts that landing lnd_rust wrote 3 minutes ago for intent "Move the backend to Rust" (One static binary.), a different intent; a person decides which goal stands';
    expect(p.status).toBe("escalated");
    expect(p.reason).toBe(`escalated by deterministic: ${reason}`);
    expect(p.undoes).toEqual([{ landingId: "lnd_rust", intentId: "int_rust", path: "src/backend.ts", lines: 4 }]);
    expect(check(p)).toMatchObject({ ok: false, detail: reason });
    expect(p.evidence.checks.find((x) => x.name === "gate")?.detail).toContain("P4 goal conflict → escalate");
    expect(c.ai.calls).toBe(0);
    // What the trunk writer was asked: the file at the change's base and the lines it removes, within the default window.
    const q = c.queries[0]!;
    expect(q.files).toEqual([{ path: "src/backend.ts", blob: c.proposals.get(p.id)!.readSet[0]!.blob, removed: removedLines(RUST, GO) }]);
    expect(q.landings).toBe(200);
    expect(Date.now() - q.since).toBeGreaterThanOrEqual(60 * 60_000);
    expect(Date.now() - q.since).toBeLessThan(60 * 60_000 + 5_000);
  });

  it("lets a change through that undoes an ancestor's landing, and records that it checked", async () => {
    const c = new Colonyish("on");
    c.declare("int_root");
    c.owners = rustLanding("int_root");
    const p = await c.decide(c.declare("int_child", "human", { parentId: "int_root" }), RUST, GO);
    expect(p.status).toBe("ready");
    expect(p.undoes).toBeUndefined();
    expect(check(p)).toMatchObject({ ok: true, detail: "no recent landing of another intent undone: 1 file and 4 removed lines traced" });
  });

  it("fails open: a trunk writer that errs or cannot trace lets the change go on, and says it was not checked", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const c = new Colonyish("on");
    c.declare("int_rust");
    c.owners = new Error("TrunkDO overloaded");
    const p = await c.decide(c.declare("int_go"), RUST, GO);
    expect(p.status).toBe("ready");
    expect(check(p)).toMatchObject({ ok: true, detail: "not checked: TrunkDO overloaded" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`goal-conflict check of ${p.id} in c1 failed`));
    c.owners = null;
    const q = await c.decide(c.declare("int_ts"), RUST, GO);
    expect(q.status).toBe("ready");
    expect(check(q)?.detail).toBe("not checked: the trunk writer cannot trace lines yet");
    // A trunk writer still on the previous code refuses the call over RPC (a deploy in progress).
    c.owners = new TypeError('The RPC receiver does not implement the method "removedLineOwners".');
    const r = await c.decide(c.declare("int_py"), RUST, GO);
    expect(r.status).toBe("ready");
    expect(check(r)?.detail).toBe("not checked: the trunk writer cannot trace lines yet");
  });

  it("does not check a repair of trunk certification, and never asks the trunk writer for it", async () => {
    const c = new Colonyish("on");
    c.declare("int_rust");
    c.owners = rustLanding("int_rust");
    const p = await c.decide(c.declare("int_fix", "certify"), RUST, GO);
    expect(p.status).not.toBe("escalated");
    expect(check(p)?.detail).toBe("not checked: a repair of trunk certification may change any line");
    expect(c.queries).toEqual([]);
  });

  it("does not check an intent a rule declared or the colony's own, and says why", async () => {
    const c = new Colonyish("on");
    c.declare("int_rust");
    c.owners = rustLanding("int_rust");
    const ruled = await c.decide(c.declare("int_rule", "rule"), RUST, GO);
    expect(ruled.status).not.toBe("escalated");
    expect(check(ruled)?.detail).toBe("not checked: an intent a rule declared brings code into line with that rule");
    const split = await c.decide(c.declare("int_split", "system"), RUST, GO);
    expect(check(split)?.detail).toBe("not checked: the colony's own intent (a megafile split) moves lines other intents wrote");
    expect(c.queries).toEqual([]);
  });

  it("returns a change that fails its checks first, telling its agent what it would undo", async () => {
    const c = new Colonyish("on");
    c.declare("int_rust");
    c.owners = rustLanding("int_rust");
    const p = await c.decide(c.declare("int_go"), RUST, GO, "");
    expect(p.status).toBe("returned");
    expect(p.reason).toMatch(/^deterministic: innate: no "Not verified:" statement.*would undo 4 lines in src\/backend\.ts that landing lnd_rust .* a person decides which goal stands once its checks pass$/);
    expect(p.undoes).toBeUndefined();
  });

  it("reads the window from the decide policy, and checks a deletion like any removal", async () => {
    const c = new Colonyish("on");
    c.engine.store.setPolicy({ goalConflictMinutes: 5, goalConflictLandings: 7 });
    c.declare("int_rust");
    c.owners = rustLanding("int_rust", { at: Date.now() - 10 * 60_000 });
    const p = await c.decide(c.declare("int_drop"), RUST, null);
    // Ten minutes old: outside a five-minute window.
    expect(p.status).toBe("ready");
    const q = c.queries[0]!;
    expect(q.landings).toBe(7);
    expect(Date.now() - q.since).toBeLessThan(5 * 60_000 + 5_000);
    expect(q.files[0]!.removed).toEqual([0, 1, 2, 3, 4]);
    c.owners = rustLanding("int_rust", { at: Date.now() - 60_000 });
    expect((await c.decide(c.declare("int_drop2"), RUST, null)).status).toBe("escalated");
  });

  it("leaves a sealed vaccine alone", async () => {
    const c = new Colonyish("on");
    c.declare("int_rust");
    c.owners = rustLanding("int_rust");
    const vaccine = c.declare("int_vaccine");
    c.engine.store.registerVaccine(vaccine.id, "secret-log", "vb_1", Date.now());
    await c.decide(vaccine, RUST, GO);
    expect(c.queries).toEqual([]);
  });
});

describe("the files the trace asks about", () => {
  const file = (over: Partial<InnateFile>): InnateFile => ({ path: "src/a.ts", beforeBlob: "b".repeat(40), afterBlob: "c".repeat(40), before: "a\nb\nc\n", after: "a\nB\nc\n", binary: false, unreadable: false, ...over });

  it("takes text files a change modifies or deletes, with the lines it removes; never new, binary or unreadable ones", () => {
    const { files, left } = traceFiles([
      file({}),
      file({ path: "src/new.ts", beforeBlob: null, before: null }),
      file({ path: "src/big.bin", binary: true, before: null }),
      file({ path: "src/gone.ts", afterBlob: null, after: null }),
      file({ path: "src/odd.ts", after: null }),
      file({ path: "src/same.ts", after: "a\nb\nc\n" }),
      file({ path: "src/lost.ts", unreadable: true }),
    ]);
    expect(files).toEqual([
      { path: "src/a.ts", blob: "b".repeat(40), removed: [1] },
      { path: "src/gone.ts", blob: "b".repeat(40), removed: [0, 1, 2] },
    ]);
    expect(left).toEqual([]);
  });

  it("stops at 20 files and 2,000 removed lines, naming what it left out", () => {
    const big = Array.from({ length: 1_500 }, (_, i) => `line ${i}`).join("\n");
    const { files, left } = traceFiles([file({ path: "src/x.ts", before: big, after: "" }), file({ path: "src/y.ts", before: big, after: "" }), file({ path: "src/z.ts" })]);
    expect(files.map((f) => `${f.path} ${f.removed.length}`)).toEqual(["src/x.ts 1500", "src/y.ts 500"]);
    expect(left).toEqual(["src/z.ts"]);
    const many = traceFiles(Array.from({ length: 25 }, (_, i) => file({ path: `src/f${i}.ts` })));
    expect(many.files).toHaveLength(20);
    expect(many.left).toHaveLength(5);
  });

  it("never throws: a host that fails is no check at all", async () => {
    const host = { env: { FT_GOAL_CONFLICT: "on" } as unknown as Env, colony: () => { throw new Error("no colony"); }, intent: () => null, trunk: () => ({}) };
    expect(await checkGoalConflict(host, { id: "prp_1", intentId: "int_1" }, [file({})])).toEqual({ conflict: null, check: null });
  });
});
