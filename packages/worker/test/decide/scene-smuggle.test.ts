import { describe, expect, it } from "vitest";
import { blobId } from "@fire_trident/core";
import type { Colony, Decision, Id, Intent, Landing, Proposal } from "@fire_trident/core";
import type { Env } from "../../src/env.ts";
import { DecideEngine, type DecideHost, type DecisionInput, type TrunkRpc } from "../../src/decide/engine.ts";
import { SMUGGLE_LINE, SMUGGLE_PATH, sceneData } from "../../../../scripts/scene_project.ts";

/**
 * The finals' smuggle scene (scripts/scene_smuggle.rb) at its full size, through the decide stage's own code: one change
 * of the 212 files the rename rewrites, naming its recipe, with one line added that calls an outside address, and the
 * same change without the line. Review by reproduction (FT_REPRODUCE) and the goal-conflict check (FT_GOAL_CONFLICT) are
 * on, as on staging. What staging is asked to show: the smuggled change does not land on D5, the review card says
 * everything else was reproduced and one line is left, the danger scan sends it to a person, and the control lands on
 * D5; neither asks a model. The project comes from scripts/scene_project.ts.
 */

/** The part of node:sqlite these tests use (the worker compiles against workers types, not Node's). */
interface DatabaseSync {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  exec(sql: string): void;
}
const SQLITE = "node:sqlite";
const { DatabaseSync } = (await import(SQLITE)) as { DatabaseSync: new (path: string) => DatabaseSync };

const COLONY: Colony = { id: "smuggle", name: "smuggle", trunk: { namespace: "ft-trunk", name: "smuggle", remote: "" }, trunkSha: "0".repeat(40), createdAt: 0, regionDepth: 1 };
const DATA = sceneData();

/** A colony around the engine, in memory: blobs by id, every model call kept (none is expected). */
class Host implements DecideHost {
  readonly calls: Array<{ model: string; input: Record<string, unknown> }> = [];
  readonly blobs = new Map<string, string>();
  readonly env: Env;
  readonly sql: SqlStorage;
  readonly proposals = new Map<Id, Proposal>();
  readonly intents = new Map<Id, Intent>();
  readonly decisions: Decision[] = [];
  readonly engine: DecideEngine;
  private seq = 0;

  constructor() {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE proposals (id TEXT PRIMARY KEY, status TEXT NOT NULL)");
    this.sql = {
      exec(query: string, ...bindings: unknown[]) {
        const rows = db.prepare(query).all(...bindings);
        return { toArray: () => rows, one: () => rows[0], [Symbol.iterator]: () => rows[Symbol.iterator]() };
      },
    } as unknown as SqlStorage;
    const blobs = this.blobs;
    const calls = this.calls;
    const ai = {
      async run(model: string, input: Record<string, unknown>): Promise<unknown> {
        calls.push({ model, input });
        throw new Error("the scene asks no model");
      },
    };
    const artifacts = { get: async () => ({ readBlob: async (sha: string) => (blobs.has(sha) ? new Blob([blobs.get(sha)!]) : null) }) };
    // Trunk blobs through ARTIFACTS, a workspace's through its shard's binding (artifacts/shards.ts): one store here.
    this.env = { AI: ai, ARTIFACTS: artifacts, WS0: artifacts, FT_REPRODUCE: "on", FT_GOAL_CONFLICT: "on" } as unknown as Env;
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
    return { kind: "synthetic" as const, name: "scene-agent", model: "scripted" };
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
      systemCommit: async () => ({ id: "lnd_x", colonyId: COLONY.id, trunkSha: "1".repeat(40) }) as unknown as Landing,
      removedLineOwners: async () => ({ owners: [], skipped: [] }),
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

  blob(text: string): string {
    const id = blobId(text);
    this.blobs.set(id, text);
    return id;
  }

  /** One agent's change of `files` (path to new text) on the seed, naming the scene's recipe, run through the stage. */
  async decide(files: Record<string, string>): Promise<Proposal> {
    const paths = Object.keys(files);
    const intent: Intent = { id: `int_${++this.seq}`, colonyId: COLONY.id, title: DATA.smuggle.title, why: DATA.smuggle.why, source: "human", footprint: paths, priority: 1, status: "claimed", createdAt: 0, createdBy: "stage-scene" };
    this.intents.set(intent.id, intent);
    const p: Proposal = {
      id: `prp_${++this.seq}`,
      colonyId: COLONY.id,
      intentId: intent.id,
      agentId: "agt_scene",
      workspace: { namespace: "ft-ws-0", name: "ws", remote: "" },
      baseSha: COLONY.trunkSha,
      headSha: `${this.seq}`.padStart(40, "e"),
      writeSet: paths.map((path) => ({ path, blob: this.blob(files[path]!) })),
      readSet: paths.map((path) => ({ path, blob: this.blob(DATA.files[path]!) })),
      declared: { footprint: paths, summary: DATA.smuggle.title },
      evidence: { checks: [], notVerified: "A scripted scene agent: no tests were run." },
      status: "checking",
      createdAt: Date.now(),
      recipe: DATA.recipe,
    };
    this.save(p);
    await this.engine.run(p.id);
    return this.proposals.get(p.id)!;
  }
}

const check = (p: Proposal, name: string) => p.evidence.checks.find((c) => c.name === name);
const files = Object.keys(DATA.renamed).length;
const lines = DATA.users.reduce((n, path) => n + DATA.files[path]!.split("\n").filter((l) => /(?<![\w$])formatPrice(?![\w$])/.test(l)).length, 0);

describe("the smuggle scene at its full size, through the decide stage", () => {
  it("does not land the change with the smuggled line: everything else is reproduced, and the danger scan sends the one line to a person", async () => {
    expect([files, lines]).toEqual([212, 892]);
    const h = new Host();
    const p = await h.decide({ ...DATA.renamed, [SMUGGLE_PATH]: DATA.smuggle.text });
    expect(p.status).toBe("escalated");
    expect(p.reason).toMatch(/^escalated by deterministic: danger patterns need a human: capability \(network\)/);
    expect(check(p, "gate")!.gate!.rule).toBe("P1 danger pattern");
    expect(h.calls).toEqual([]);
    expect(p.evidence.reproduction).toMatchObject({
      applied: true,
      reproduced: { files: files - 1, lines: lines - 3 },
      residual: { files: 1, lines: 1, paths: [{ path: SMUGGLE_PATH, why: "it differs from the recipe's output (shown against the replay)" }] },
      text: `${(lines - 3).toLocaleString("en-US")} lines reproduced by rename-identifier@1, 1 line to review`,
    });
    // The review card: the residual alone, the smuggled line against the replay, with the reproduced count above it.
    const view = h.engine.store.reviewView(p.id)!;
    expect(view.files.map((f) => [f.path, f.added, f.removed])).toEqual([[SMUGGLE_PATH, 1, 0]]);
    expect(view.files[0]!.hunks).toContain(`+${SMUGGLE_LINE}`);
    expect(view.reproduction).toEqual({ recipe: "rename-identifier@1", reproduced: { files: files - 1, lines: lines - 3 }, residual: { files: 1, lines: 1 }, text: `${(lines - 3).toLocaleString("en-US")} lines reproduced by rename-identifier@1, 1 line to review` });
    expect(view.danger.map((d) => d.path)).toEqual([SMUGGLE_PATH]);
  });

  it("lands the same rename without the line on D5, reproduced by recipe, with no model call", async () => {
    const h = new Host();
    const p = await h.decide(DATA.renamed);
    expect(p.status).toBe("ready");
    expect(check(p, "gate")!.gate!.rule).toBe("D5 reproduced by recipe");
    expect(check(p, "gate")!.detail).toMatch(/^D5 reproduced by recipe → land by deterministic /);
    expect(h.calls).toEqual([]);
    expect(p.evidence.reproduction).toMatchObject({ applied: true, reproduced: { files, lines }, residual: { files: 0, lines: 0 }, text: `${lines.toLocaleString("en-US")} lines reproduced by rename-identifier@1, nothing else to review` });
    expect(check(p, "goal conflict")).toMatchObject({ ok: true });
  });
});
