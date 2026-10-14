import { describe, expect, it } from "vitest";
import type { AgentInfo, Colony, ColonySnapshot, FileVersion, Id, Intent, Proposal, Rule, Sha, WorkspaceLease } from "@fire_trident/core";
import { MemoryJournal, SqlJournal } from "../../src/agents/journal.ts";
import type { SqlLike } from "../../src/agents/journal.ts";
import { FIRST_POLL_MS, tick } from "../../src/agents/loop.ts";
import type { AgentConfig, BaseFile, GitOps, LoopDeps, ModelClient } from "../../src/agents/loop.ts";
import type { ColonyRpc, ProposeInput, TakeResult } from "../../src/agents/rpc.ts";

/**
 * Spend per intent in the agent (FT_INTENT_SPEND): the journal keeps one row per intent and model, and the loop adds
 * each model call to the row of the job's intent, under the model that answered.
 */

/** The part of node:sqlite these tests use (the worker compiles against workers types, not Node's). */
interface DatabaseSync {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
}
const SQLITE = "node:sqlite";
const { DatabaseSync } = (await import(SQLITE)) as { DatabaseSync: new (path: string) => DatabaseSync };

function sqlite(): SqlLike {
  const d = new DatabaseSync(":memory:");
  return {
    exec: <T extends Record<string, unknown>>(q: string, ...b: unknown[]) => {
      const rows = d.prepare(q).all(...b) as T[];
      return { toArray: () => rows, one: () => rows[0] as T };
    },
  } as SqlLike;
}

const BASE = "a".repeat(40);
const OWN = "@cf/small/model";
const STRONG = "@cf/big/model";
const VERSION = 'export const VERSION = "1";\n';

const LEASE: WorkspaceLease = {
  repo: { namespace: "ft-ws-1", name: "col--ws-1", remote: "https://ws.invalid/col--ws-1.git" },
  token: "fixture-workspace",
  tokenExpiresAt: Number.MAX_SAFE_INTEGER,
  baseSha: BASE,
  leasedAt: 0,
  trunk: { remote: "https://trunk.invalid/col--trunk.git", token: "fixture-trunk", sha: BASE },
};

const INTENT: Intent = { id: "int_v", colonyId: "col", title: "Expose the version", why: "Expose the version.", source: "human", footprint: ["src/version.ts"], priority: 1, status: "open", createdAt: 0, createdBy: "t" };

/** A colony that hands out one intent with whatever model hint the test sets, and keeps the proposals. */
class FakeColony implements ColonyRpc {
  intent: Intent = { ...INTENT };
  hint: unknown = undefined;
  proposals: Proposal[] = [];
  async getColony(): Promise<Colony | null> {
    return null;
  }
  async snapshot(): Promise<ColonySnapshot> {
    return { rules: [] } as unknown as ColonySnapshot;
  }
  async addIntent(): Promise<Intent> {
    throw new Error("not used");
  }
  async registerAgent(): Promise<AgentInfo> {
    throw new Error("not used");
  }
  async registerAgents(): Promise<AgentInfo[]> {
    throw new Error("not used");
  }
  async getAgent(): Promise<AgentInfo | null> {
    return null;
  }
  async take(agentId: Id): Promise<TakeResult> {
    if (this.intent.status !== "open" && this.intent.assignedTo !== agentId) return { wait: true, retryInMs: 5_000, reason: "no open intents" };
    this.intent = { ...this.intent, status: "claimed", assignedTo: agentId };
    return { intent: { ...this.intent }, lease: LEASE, ...(this.hint !== undefined ? { model: this.hint } : {}) } as TakeResult;
  }
  async heartbeat(): Promise<void> {}
  async propose(p: ProposeInput): Promise<Proposal> {
    const proposal: Proposal = { ...p, id: `prp_${this.proposals.length + 1}`, status: "ready", createdAt: 0, evidence: { checks: p.evidence?.checks ?? [], notVerified: p.evidence?.notVerified ?? "" } };
    this.proposals.push(proposal);
    return proposal;
  }
  async getProposal(id: Id): Promise<Proposal | null> {
    return this.proposals.find((p) => p.id === id) ?? null;
  }
  async inbox(): Promise<Proposal[]> {
    return [];
  }
  async getRule(): Promise<Rule | null> {
    return null;
  }
  async abandon(): Promise<void> {}
}

/** A clone of an empty trunk: the file is new. */
const git: GitOps = {
  ensureBase: async (p) => ({ baseSha: p.baseSha, fallback: false }),
  listFiles: async () => ["README.md"],
  readFile: async (): Promise<BaseFile | null> => null,
  commit: async (p): Promise<{ headSha: Sha; writeSet: FileVersion[] }> => ({ headSha: "b".repeat(40), writeSet: p.changes.map((c) => ({ path: c.path, blob: "c".repeat(40) })) }),
  push: async () => undefined,
};

/** One write of the version file through a model client that reports its usage and resolves "default" to the stronger model. */
async function write(opts: { on?: boolean; hint?: unknown; usage?: boolean }): Promise<MemoryJournal> {
  const colony = new FakeColony();
  colony.hint = opts.hint;
  const model: ModelClient = {
    complete: async (p) => ({
      text: `<file>\n${VERSION}</file>`,
      ...(opts.usage === false ? {} : { usage: { input: 70, output: 30, cached: 0, neurons: 0 } }),
      model: p.model === "default" ? STRONG : p.model,
    }),
  };
  const journal = new MemoryJournal();
  const cfg: AgentConfig = { colonyId: "col", agentId: "agt_1", name: "a1", kind: "internal", model: OWN, running: true, epoch: 1, startedAt: 0, failures: 0 };
  journal.setConfig(cfg);
  const deps: LoopDeps = { colony, git, model, journal, now: () => 1_000_000, rand: () => 0.5, ...(opts.on === undefined ? {} : { intentSpend: opts.on }) };
  expect(await tick(deps)).toEqual({ sleepMs: FIRST_POLL_MS });
  expect(colony.proposals).toHaveLength(1);
  return journal;
}

describe("the journal's rows by intent", () => {
  it("add up per intent and model, most recently called first, in memory and in SQLite alike", () => {
    for (const journal of [new MemoryJournal(), new SqlJournal(sqlite())]) {
      journal.bumpIntent("int_1", OWN, { input: 100, output: 10 }, 1_000);
      journal.bumpIntent("int_1", OWN, { input: 50, output: 5 }, 2_000);
      journal.bumpIntent("int_1", STRONG, { input: 0, output: 0 }, 3_000);
      journal.bumpIntent("int_2", OWN, { input: 7, output: 1 }, 1_500);
      expect(journal.intentUsage()).toEqual([
        { intentId: "int_1", model: STRONG, calls: 1, input: 0, output: 0, at: 3_000 },
        { intentId: "int_1", model: OWN, calls: 2, input: 150, output: 15, at: 2_000 },
        { intentId: "int_2", model: OWN, calls: 1, input: 7, output: 1, at: 1_500 },
      ]);
      expect(journal.intentUsage(1)).toHaveLength(1);
      // The totals the colony read before stay what they were.
      expect(journal.counters()).toEqual({});
    }
  });

  it("keeps the rows of the 2,000 most recently called intents in SQLite", () => {
    const journal = new SqlJournal(sqlite());
    for (let i = 1; i <= 2_100; i++) journal.bumpIntent(`int_${i}`, OWN, { input: 1, output: 0 }, i);
    const rows = journal.intentUsage(10_000);
    expect(rows).toHaveLength(2_000);
    expect(rows[0]?.intentId).toBe("int_2100");
    expect(rows[rows.length - 1]?.intentId).toBe("int_101");
  });
});

describe("the loop", () => {
  it("counts each call under the job's intent and the model that answered, where the flag covers the colony", async () => {
    const journal = await write({ on: true });
    expect(journal.intentUsage()).toEqual([{ intentId: "int_v", model: OWN, calls: 1, input: 70, output: 30, at: 1_000_000 }]);
    expect(journal.counters()).toMatchObject({ llmCalls: 1, tokensIn: 70, tokensOut: 30 });
  });

  it("counts a step-up's call under the stronger model, and a call that reported no usage as a call", async () => {
    const stepped = await write({ on: true, hint: { model: "default", returns: 2, reason: "two returns" } });
    expect(stepped.intentUsage()).toEqual([{ intentId: "int_v", model: STRONG, calls: 1, input: 70, output: 30, at: 1_000_000 }]);
    const silent = await write({ on: true, usage: false });
    expect(silent.intentUsage()).toEqual([{ intentId: "int_v", model: OWN, calls: 1, input: 0, output: 0, at: 1_000_000 }]);
  });

  it("counts nothing per intent without the flag, as before", async () => {
    expect((await write({})).intentUsage()).toEqual([]);
    expect((await write({ on: false })).intentUsage()).toEqual([]);
  });
});
