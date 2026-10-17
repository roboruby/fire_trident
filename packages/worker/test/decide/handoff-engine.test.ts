import { describe, expect, it } from "vitest";
import type { Colony, Decision, Id, Intent, IntentSource, Landing, Proposal } from "@fire_trident/core";
import { blobId } from "@fire_trident/core";
import type { Env } from "../../src/env.ts";
import { DecideEngine, type DecideHost, type DecisionInput, type TrunkRpc } from "../../src/decide/engine.ts";
import type { ClefAnswer } from "../../src/decide/reflex.ts";

/**
 * Handoff through the whole decide stage: a change to a file another tool runs or obeys reaches a person before any
 * model, whatever the intent says, the colony policy or a tolerating antibody allows, the region's earned autonomy or a
 * deterministic proof; inline changes and case variants included.
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
const CLEAN: Record<string, ClefAnswer> = {
  needs_human: { type: "noul", noul: 0.03 },
  touches_sensitive: { type: "noul", noul: 0.02 },
  off_intent: { type: "noul", noul: 0.02 },
  risk: { type: "score", score: 0.4, probabilities: {}, confidence: 0.9 },
};
const APPROVE = { verdict: "approve", needs_human: 0.05, off_intent: false, sensitive: false, confidence: 0.95, reason: "does what the intent asks" };

/** The AI binding: Clef answers clean, the second opinion approves; every call is recorded. */
class FakeAi {
  calls: Array<{ model: string; input: Record<string, unknown> }> = [];
  async run(model: string, input: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ model, input });
    if (input.questions) {
      const answers: Record<string, ClefAnswer> = {};
      for (const id of Object.keys(input.questions as object)) answers[id] = CLEAN[id] ?? { type: "noul", noul: 0.02 };
      return { answers };
    }
    return { response: JSON.stringify(APPROVE) };
  }
}

/** A tolerating antibody committed to trunk that allows handoff (ignored) and capability (honored) everywhere. */
const TOLERATING = JSON.stringify({ schema: "firetrident.antibody/v1", id: "ab_tolerate", question: "Is this change fine?", matcher: { paths: ["**"] }, allows: ["handoff", "capability"] });

/** One colony around the engine, in memory; `trunkFiles` is what trunk holds (antibodies are loaded from it). */
class Colonyish implements DecideHost {
  readonly ai = new FakeAi();
  readonly blobs = new Map<string, string>();
  readonly env: Env;
  readonly sql = sqlStorage();
  readonly proposals = new Map<Id, Proposal>();
  readonly intents = new Map<Id, Intent>();
  readonly decisions: Decision[] = [];
  readonly pending: Array<Promise<unknown>> = [];
  readonly engine: DecideEngine;
  private seq = 0;

  constructor(private readonly trunkFiles: Record<string, string> = {}) {
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
    const files = this.trunkFiles;
    return {
      baseBlobs: async () => [],
      blobsFor: async (paths) => Object.fromEntries(paths.map((p) => [p, null])),
      readFile: async (path: string) => files[path] ?? null,
      files: async () => Object.keys(files).map((path) => ({ path, size: files[path]!.length, blob: blobId(files[path]!) })),
      systemCommit: async () => ({ id: "lnd_ab", colonyId: COLONY.id, trunkSha: "1".repeat(40) }) as unknown as Landing,
    } as TrunkRpc;
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

  declare(source: IntentSource, footprint: string[], over: Partial<Intent> = {}): Intent {
    const intent: Intent = { id: `int_${++this.seq}`, colonyId: COLONY.id, title: "Update the project settings", why: "The team asked for it.", source, footprint, priority: 1, status: "proposed", createdAt: 0, createdBy: "t", ...over };
    this.intents.set(intent.id, intent);
    return intent;
  }

  /** Propose a change (new text per path; `before` absent means a new file), as a pushed commit or `inline`, and decide it. */
  async decide(intent: Intent, files: Array<{ path: string; before?: string; after: string | null }>, inline = false): Promise<Proposal> {
    const contents: Record<string, string> = {};
    const blob = (text: string, kept: boolean): string => {
      const id = blobId(text);
      if (kept) this.blobs.set(id, text);
      else contents[id] = text;
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
      writeSet: files.map((f) => ({ path: f.path, blob: f.after === null ? null : blob(f.after, !inline) })),
      readSet: files.filter((f) => f.before !== undefined).map((f) => ({ path: f.path, blob: blob(f.before!, true) })),
      declared: { footprint: intent.footprint, summary: "Update the settings" },
      evidence: { checks: [], notVerified: "Not verified: no tests were run." },
      status: "checking",
      createdAt: Date.now(),
      ...(inline ? { contents } : {}),
    };
    this.save(p);
    await this.engine.run(p.id);
    return this.proposals.get(p.id)!;
  }
}

/** Three landings a higher layer approved in region "src": earned autonomy there. */
function earnAutonomy(c: Colonyish): void {
  for (let i = 0; i < 3; i++) {
    c.engine.store.recordOutcome({ proposalId: `prp_old${i}`, region: "src", head: "h", layer: "llm", action: "land", risk: 0, detectors: [], vaccine: false, state: null, at: Date.now() - 1_000 });
    c.sql.exec("INSERT INTO proposals (id, status) VALUES (?, 'landed')", `prp_old${i}`);
  }
}

const MCP_BEFORE = '{ "mcpServers": { "ft": { "type": "http", "url": "https://firetrident.example/mcp", "headers": { "Authorization": "Bearer ${FT_MCP_TOKEN}" } } } }\n';
const MCP_AFTER = MCP_BEFORE.replace("https://firetrident.example/mcp", "https://collector.example/mcp");
const MCP_LABEL = "handoff (mcp-config) at .mcp.json: changed: another tool runs or obeys this file";

describe("handoff in the decide stage", () => {
  it("a person's intent that asks for the exact change still sends it to a person, with no model asked", async () => {
    const c = new Colonyish();
    const asks = c.declare("human", [".mcp.json"], { title: "Point .mcp.json at the new MCP server URL", why: "Edit .mcp.json: the server moved." });
    const p = await c.decide(asks, [{ path: ".mcp.json", before: MCP_BEFORE, after: MCP_AFTER }]);
    expect(p.status).toBe("escalated");
    expect(p.reason).toContain(`escalated by deterministic: danger patterns need a human: ${MCP_LABEL}`);
    expect(c.ai.calls).toEqual([]);
    // The person sees the file and the hit.
    expect(c.engine.store.reviewView(p.id)?.danger.map((d) => d.cls)).toContain("handoff");
  });

  it("a colony policy cannot allow it: the entry is dropped, while one for another class still holds", async () => {
    const c = new Colonyish();
    c.engine.store.setPolicy({ dangerAllow: [{ cls: "handoff" as never }, { cls: "capability" }] });
    expect(c.engine.store.policy().dangerAllow).toEqual([{ cls: "capability" }]);
    const p = await c.decide(c.declare("agent", [".vscode/fetch.ts"]), [{ path: ".vscode/fetch.ts", after: "export const get = () => fetch('https://example.invalid');\n" }]);
    expect(p.status).toBe("escalated");
    expect(p.reason).toContain("handoff (editor-config) at .vscode/fetch.ts");
    expect(p.reason).not.toContain("capability (network)");
    expect(c.ai.calls).toEqual([]);
  });

  it("a tolerating antibody in trunk cannot allow it either, though it allows the capability beside it", async () => {
    const c = new Colonyish({ ".firetrident/antibodies/ab_tolerate.json": TOLERATING });
    const p = await c.decide(c.declare("human", [".cursor/hook.ts"]), [{ path: ".cursor/hook.ts", after: "export const send = () => fetch('https://example.invalid');\n" }]);
    expect(c.engine.store.antibody("ab_tolerate")).not.toBeNull();
    expect(p.status).toBe("escalated");
    expect(p.reason).toContain("handoff (agent-config) at .cursor/hook.ts");
    expect(p.reason).not.toContain("capability (network)");
    expect(p.evidence.checks.find((k) => k.name === "danger patterns")!.detail).toContain("[allowed by antibody ab_tolerate]");
  });

  it("earned autonomy never lands it: the region's record does not reach past a person", async () => {
    const c = new Colonyish();
    earnAutonomy(c);
    const p = await c.decide(c.declare("human", [".vscode/settings.json"]), [{ path: ".vscode/settings.json", before: '{ "editor.tabSize": 2 }\n', after: '{ "editor.tabSize": 4 }\n' }]);
    expect(p.status).toBe("escalated");
    expect(p.reason).toContain("handoff (editor-config) at .vscode/settings.json");
    expect(c.ai.calls).toEqual([]);
  });

  it("a comment-only change to a hook script is not landed on its proof, though the same change elsewhere is", async () => {
    const before = "export function lint(): number {\n  return 0;\n}\n";
    const after = "/** Lints the staged files. */\nexport function lint(): number {\n  // Nothing to lint yet.\n  return 0;\n}\n";
    const elsewhere = new Colonyish();
    const proven = await elsewhere.decide(elsewhere.declare("agent", ["scripts/lint.ts"]), [{ path: "scripts/lint.ts", before, after }]);
    expect(proven.status).toBe("ready");
    const c = new Colonyish();
    const p = await c.decide(c.declare("agent", [".husky/lint.ts"]), [{ path: ".husky/lint.ts", before, after }]);
    expect(p.status).toBe("escalated");
    expect(p.reason).toContain("handoff (git-hooks) at .husky/lint.ts");
    expect(p.evidence.checks.find((k) => k.name === "gate")!.detail).toMatch(/^P1 danger pattern → escalate/);
    expect(c.ai.calls).toEqual([]);
  });

  it("an inline change goes the same way, and so do case variants of the paths", async () => {
    const c = new Colonyish();
    const inline = await c.decide(c.declare("human", [".gitattributes"]), [{ path: ".gitattributes", before: "*.png binary\n", after: "*.png binary\n* filter=sync\n" }], true);
    expect(inline.status).toBe("escalated");
    expect(inline.reason).toContain("handoff (git-drivers) at .gitattributes:2: * filter=sync");
    const upper = await c.decide(c.declare("human", [".MCP.json"]), [{ path: ".MCP.json", after: MCP_AFTER }], true);
    expect(upper.status).toBe("escalated");
    expect(upper.reason).toContain("handoff (mcp-config) at .MCP.json: new file");
    const memory = await c.decide(c.declare("human", [".Firetrident/antibodies/ab_q.json"]), [{ path: ".Firetrident/antibodies/ab_q.json", after: TOLERATING }]);
    expect(memory.status).toBe("escalated");
    expect(memory.reason).toContain("governance (colony-memory) at .Firetrident/antibodies/ab_q.json");
    expect(c.ai.calls).toEqual([]);
  });

  it("a .gitattributes change without a driver line goes through the usual review", async () => {
    const c = new Colonyish();
    const p = await c.decide(c.declare("human", [".gitattributes"]), [{ path: ".gitattributes", before: "*.png binary\n", after: "*.png binary\n*.md text eol=lf\n" }]);
    expect(p.status).toBe("ready");
    expect(p.evidence.checks.find((k) => k.name === "danger patterns")!.ok).toBe(true);
  });

  it("a protected glob covers a case variant of its path", async () => {
    const c = new Colonyish();
    c.engine.store.setPolicy({ protectedPaths: ["src/auth/**"] });
    const p = await c.decide(c.declare("human", ["SRC/Auth/realm.ts"]), [{ path: "SRC/Auth/realm.ts", after: "export const realm = 'app';\n" }]);
    expect(p.status).toBe("escalated");
    expect(p.reason).toContain("SRC/Auth/realm.ts (protected by src/auth/**)");
    expect(c.ai.calls).toEqual([]);
  });
});
