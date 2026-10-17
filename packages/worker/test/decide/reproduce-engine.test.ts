import { describe, expect, it } from "vitest";
import type { Colony, Decision, Id, Intent, Landing, Proposal, Recipe } from "@fire_trident/core";
import type { Env } from "../../src/env.ts";
import { DecideEngine, type DecideHost, type DecisionInput, type TrunkRpc } from "../../src/decide/engine.ts";
import type { ClefAnswer } from "../../src/decide/reflex.ts";
import { maskNote } from "../../src/trunk/mask.ts";

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
const CLEAN: Record<string, ClefAnswer> = {
  needs_human: { type: "noul", noul: 0.03 },
  touches_sensitive: { type: "noul", noul: 0.02 },
  off_intent: { type: "noul", noul: 0.02 },
  risk: { type: "score", score: 0.4, probabilities: {}, confidence: 0.9 },
};

/** The AI binding: Clef answers clean, the second opinion approves; every call is kept. */
class FakeAi {
  calls: Array<{ model: string; input: Record<string, unknown> }> = [];
  async run(model: string, input: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ model, input });
    if (input.questions) return { answers: Object.fromEntries(Object.keys(input.questions as object).map((id) => [id, CLEAN[id] ?? { type: "noul", noul: 0.02 }])) };
    return { response: JSON.stringify({ verdict: "approve", needs_human: 0.05, off_intent: false, sensitive: false, confidence: 0.95, reason: "the residual line is what the intent asks" }) };
  }
  clefStates(): Array<Record<string, unknown>> {
    return this.calls.filter((c) => c.input.questions).map((c) => c.input.state as Record<string, unknown>);
  }
}

/** A colony around the engine, in memory, with review by reproduction on (FT_REPRODUCE) unless `flag` says otherwise. */
class Host implements DecideHost {
  readonly ai = new FakeAi();
  readonly blobs = new Map<string, string>();
  readonly env: Env;
  readonly sql = sqlStorage();
  readonly proposals = new Map<Id, Proposal>();
  readonly intents = new Map<Id, Intent>();
  readonly decisions: Decision[] = [];
  readonly pending: Array<Promise<unknown>> = [];
  readonly engine: DecideEngine;
  readonly bumped = new Map<string, number>();
  private seq = 0;

  /** Paths the goal-conflict check asked the trunk to trace (FT_GOAL_CONFLICT on). */
  readonly traced: string[] = [];

  constructor(flag = "on", extra: Record<string, string> = {}) {
    const blobs = this.blobs;
    const artifacts = { get: async () => ({ readBlob: async (sha: string) => (blobs.has(sha) ? new Blob([blobs.get(sha)!]) : null) }) };
    this.env = { AI: this.ai, ARTIFACTS: artifacts, FT_REPRODUCE: flag, ...extra } as unknown as Env;
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
  bump(name: string, delta: number): void {
    this.bumped.set(name, (this.bumped.get(name) ?? 0) + delta);
  }
  setMetric(): void {}
  emit(): void {}
  trunk(): TrunkRpc {
    return {
      baseBlobs: async () => [],
      blobsFor: async (paths) => Object.fromEntries(paths.map((p) => [p, null])),
      readFile: async () => null,
      files: async () => [],
      systemCommit: async () => ({ id: "lnd_x", colonyId: COLONY.id, trunkSha: "1".repeat(40) }) as unknown as Landing,
      removedLineOwners: async (q) => {
        this.traced.push(...q.files.map((f) => f.path));
        return { owners: [], skipped: [] };
      },
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

  declare(): Intent {
    const intent: Intent = { id: `int_${++this.seq}`, colonyId: COLONY.id, title: "Rename compose to assemble", why: "One name for one idea across src.", source: "human", footprint: ["src/"], priority: 1, status: "proposed", createdAt: 0, createdBy: "matt" };
    this.intents.set(intent.id, intent);
    return intent;
  }

  /** Propose a change that declares `recipe` (base text and new text per path) and run the pipeline on it. */
  async decide(files: Array<{ path: string; before: string; after: string }>, recipe?: Recipe | Record<string, unknown>): Promise<Proposal> {
    const intent = this.declare();
    const blob = (text: string): string => {
      const id = `${(++this.seq).toString(16).padStart(8, "0")}${"b".repeat(32)}`;
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
      writeSet: files.map((f) => ({ path: f.path, blob: blob(f.after) })),
      readSet: files.map((f) => ({ path: f.path, blob: blob(f.before) })),
      declared: { footprint: intent.footprint, summary: "Rename compose to assemble" },
      evidence: { checks: [], notVerified: "Not verified: no tests were run." },
      status: "checking",
      createdAt: Date.now(),
      ...(recipe ? { recipe: recipe as Recipe } : {}),
    };
    this.save(p);
    await this.engine.run(p.id);
    return this.proposals.get(p.id)!;
  }
}

const RENAME: Recipe = { kind: "rename-identifier", version: "1", args: { from: "compose", to: "assemble" }, scope: ["src/**"] };

/** A module that defines compose and calls it `n` times, renamed when `name` says so. */
function mod(n: number, name = "compose"): string {
  return [`export function ${name}(a: number): number {`, "  return a + 1;", "}", ...Array.from({ length: n }, (_, i) => `export const v${i} = ${name}(${i});`), ""].join("\n");
}
/** `count` files that import compose and call it twice. */
function users(count: number, name = "compose"): Array<{ path: string; text: string }> {
  return Array.from({ length: count }, (_, i) => ({ path: `src/use${i}.ts`, text: `import { ${name} } from "./mod.ts";\nexport const total${i} = ${name}(${i}) + ${name}(1);\n` }));
}
/** The rename as an agent made it by hand: every file the recipe would produce, plus `edit` applied to src/mod.ts. */
function renamed(edit: (text: string) => string = (t) => t): Array<{ path: string; before: string; after: string }> {
  const before = users(5);
  const after = users(5, "assemble");
  return [{ path: "src/mod.ts", before: mod(40), after: edit(mod(40, "assemble")) }, ...before.map((u, i) => ({ path: u.path, before: u.text, after: after[i]!.text }))];
}

function check(p: Proposal, name: string) {
  return p.evidence.checks.find((c) => c.name === name);
}

describe("review by reproduction in the decide stage", () => {
  it("lands a change every file of which equals its declared recipe on D5, with no model call", async () => {
    const h = new Host();
    const p = await h.decide(renamed(), RENAME);
    expect(p.status).toBe("ready");
    expect(h.ai.calls).toEqual([]);
    const gate = check(p, "gate")!;
    expect(gate.detail).toMatch(/^D5 reproduced by recipe → land by deterministic .*\(confirmations: innate \+ reproduction\): reproduced by recipe: 51 lines reproduced by rename-identifier@1, nothing else to review$/);
    expect(gate.gate).toMatchObject({ rule: "D5 reproduced by recipe", values: [{ name: "recipe", value: "rename-identifier@1" }, { name: "lines reproduced", value: 51 }, { name: "files reproduced", value: 6 }, { name: "lines to review", value: 0 }] });
    expect(check(p, "deterministic: reproduction")).toMatchObject({ ok: true, detail: "51 lines reproduced by rename-identifier@1, nothing else to review (6 files reproduced)" });
    // The decision record the lineage note keeps: what was reproduced and what was left.
    expect(p.evidence.reproduction).toMatchObject({ applied: true, recipe: RENAME, reproduced: { files: 6, lines: 51 }, residual: { files: 0, lines: 0, paths: [] }, text: "51 lines reproduced by rename-identifier@1, nothing else to review" });
    expect(p.evidence.reproduction!.reproduced.paths).toHaveLength(6);
    // The lineage note carries the evidence as it is (trunk/TrunkDO.ts buildNote), masked where text looks like a secret.
    const note = maskNote({ schema: "firetrident.lineage/v1", landingId: "lnd_1", colonyId: COLONY.id, proposals: [{ id: p.id, agentId: p.agentId, agentKind: "external", intent: { id: p.intentId, title: "t", why: "w" }, writeSet: p.writeSet, readSet: p.readSet, decisions: [], evidence: p.evidence }] });
    expect(note.proposals[0]!.evidence.reproduction).toEqual(p.evidence.reproduction);
    expect(h.bumped.get("decide.reproduced.lines")).toBe(51);
  });

  it("sends only the smuggled line through the reflex arc, and records both sides", async () => {
    const h = new Host();
    const p = await h.decide(
      renamed((t) => t.replace("  return a + 1;\n", "  return a + 1;\n  globalThis.audit = true;\n")),
      RENAME,
    );
    // The reflex saw one file, against the replay: the smuggled line and nothing of the rename.
    const [state] = h.ai.clefStates();
    const diff = state!.diff as { files: Array<{ path: string; hunks: string }>; files_changed: number; total_added: number; total_removed: number };
    expect(diff.files_changed).toBe(1);
    expect(diff.files.map((f) => f.path)).toEqual(["src/mod.ts"]);
    expect([diff.total_added, diff.total_removed]).toEqual([1, 0]);
    expect(diff.files[0]!.hunks).toContain("+  globalThis.audit = true;");
    expect(diff.files[0]!.hunks).not.toContain("-export function compose");
    expect(state!.checked_facts).toEqual([expect.stringMatching(/^Review by reproduction: 5 files \(10 lines\) of this change equal the declared recipe rename-identifier@1/)]);
    // The residual is its own change: no autonomy here, so the second opinion decides it (and sees it alone too).
    expect(p.status).toBe("ready");
    expect(check(p, "gate")!.gate).toMatchObject({ rule: "L3 innate+llm" });
    expect(check(p, "gate")!.gate!.values).toEqual(expect.arrayContaining([{ name: "lines reproduced by rename-identifier@1", value: 10 }, { name: "residual lines reviewed", value: 1 }]));
    expect(check(p, "deterministic: reproduction")!.detail).toBe("10 lines reproduced by rename-identifier@1, 1 line to review (5 files reproduced; residual src/mod.ts: it differs from the recipe's output (shown against the replay))");
    expect(p.evidence.reproduction).toMatchObject({ applied: true, reproduced: { files: 5, lines: 10 }, residual: { files: 1, lines: 1, paths: [{ path: "src/mod.ts", why: "it differs from the recipe's output (shown against the replay)" }] } });
    const decided = h.decisions.filter((d) => d.subject === p.id);
    expect(decided.map((d) => d.layer)).toEqual(["reflex", "llm"]);
    for (const d of decided) expect(d.answers.reproduction).toMatchObject({ reproduced: { files: 5, lines: 10 }, residual: { files: 1, lines: 1 } });
  });

  it("escalates a danger pattern in the residual before any model, and the card shows the residual with the reproduced count", async () => {
    const h = new Host();
    const p = await h.decide(
      renamed((t) => t.replace("  return a + 1;\n", '  void fetch("https://collector.example/x");\n  return a + 1;\n')),
      RENAME,
    );
    expect(p.status).toBe("escalated");
    expect(p.reason).toMatch(/^escalated by deterministic: danger patterns need a human: capability \(network\)/);
    expect(h.ai.calls).toEqual([]);
    const view = h.engine.store.reviewView(p.id)!;
    expect(view.files.map((f) => [f.path, f.added, f.removed])).toEqual([["src/mod.ts", 1, 0]]);
    expect(view.reproduction).toEqual({ recipe: "rename-identifier@1", reproduced: { files: 5, lines: 10 }, residual: { files: 1, lines: 1 }, text: "10 lines reproduced by rename-identifier@1, 1 line to review" });
    expect(view.danger.map((d) => d.path)).toEqual(["src/mod.ts"]);
  });

  it("gives an unknown, unpinned or module recipe ordinary review, with the reason in the evidence", async () => {
    for (const [recipe, reason] of [
      [{ ...RENAME, kind: "codemod" }, /unknown recipe kind "codemod"/],
      [{ ...RENAME, version: "" }, /names no version/],
      [{ kind: "module", version: "1", args: { source: "export function transform(p, t) { return t; }" }, scope: ["src/**"] }, /module recipe is not replayed in review/],
    ] as const) {
      const h = new Host();
      const p = await h.decide(renamed(), recipe);
      expect(p.evidence.reproduction).toMatchObject({ applied: false, reason: expect.stringMatching(reason), reproduced: { files: 0, lines: 0 }, residual: { files: 6, lines: 51 } });
      expect(check(p, "deterministic: reproduction")).toMatchObject({ ok: false, detail: expect.stringMatching(/^not replayed: /) });
      // Ordinary review: the reflex saw the whole change.
      expect((h.ai.clefStates()[0]!.diff as { files_changed: number }).files_changed).toBe(6);
      expect(check(p, "gate")!.gate!.rule).not.toMatch(/^D5/);
    }
  });

  it("records a declared recipe and reviews the whole change where FT_REPRODUCE does not cover the colony", async () => {
    const h = new Host("other-colony");
    const p = await h.decide(renamed(), RENAME);
    expect(p.evidence.reproduction).toMatchObject({ applied: false, reason: expect.stringMatching(/off for this colony \(FT_REPRODUCE\)/) });
    expect(h.ai.clefStates()).toHaveLength(1);
    expect(check(p, "gate")!.gate!.rule).toBe("L3 innate+llm");
  });

  it("leaves the files a rename reproduced out of the goal-conflict check: a mass rename undoes no other intent's lines", async () => {
    const h = new Host("on", { FT_GOAL_CONFLICT: "on" });
    const p = await h.decide(renamed(), RENAME);
    expect(p.status).toBe("ready");
    expect(h.traced).toEqual([]);
    expect(check(p, "goal conflict")).toMatchObject({ ok: true, detail: "no line of an existing text file removed" });
    const smuggled = new Host("on", { FT_GOAL_CONFLICT: "on" });
    await smuggled.decide(
      renamed((t) => t.replace("export const v0 = assemble(0);\n", "")),
      RENAME,
    );
    expect(smuggled.traced).toEqual(["src/mod.ts"]);
  });

  it("leaves a change that declares no recipe exactly as before", async () => {
    const h = new Host();
    const p = await h.decide(renamed());
    expect(p.evidence.reproduction).toBeUndefined();
    expect(check(p, "deterministic: reproduction")).toBeUndefined();
    expect(h.ai.clefStates()).toHaveLength(1);
  });
});
