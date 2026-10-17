import { describe, expect, it } from "vitest";
import type { AgentInfo, Colony, ColonySnapshot, FileVersion, Id, Intent, Proposal, Rule, Sha, WorkspaceLease } from "@fire_trident/core";
import { MemoryJournal } from "../../src/agents/journal.ts";
import { FIRST_POLL_MS, tick } from "../../src/agents/loop.ts";
import type { AgentConfig, BaseFile, GitOps, LoopDeps, ModelClient, ModelReply } from "../../src/agents/loop.ts";
import type { ColonyRpc, ProposeInput, TakeResult } from "../../src/agents/rpc.ts";

/**
 * Hedged model calls in an in-platform agent (FT_HEDGE): the reply says which copy answered, the change's usage check
 * says so, and a losing copy that answers anyway has its tokens counted in the agent's journal once it settles.
 */

const BASE = "a".repeat(40);
const OWN = "@cf/small/model";
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

/** A colony that hands out one intent and keeps the proposals. */
class FakeColony implements ColonyRpc {
  intent: Intent = { ...INTENT };
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
    return { intent: { ...this.intent }, lease: LEASE } as TakeResult;
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

/** What a hedged reply's losing copy settles with. */
type Late = Awaited<NonNullable<ModelReply["late"]>>;

/** One write of the version file through a client whose reply is `reply` (and whose losing copy settles with `late`). */
async function write(reply: Partial<ModelReply>, late?: Late) {
  const colony = new FakeColony();
  let settle: (v: Late) => void = () => undefined;
  const model: ModelClient = {
    complete: async (p) => ({
      text: `<file>\n${VERSION}</file>`,
      usage: { input: 70, output: 30, cached: 0, neurons: 0 },
      model: p.model,
      ...reply,
      ...(late !== undefined ? { late: new Promise<Late>((r) => (settle = r)) } : {}),
    }),
  };
  const journal = new MemoryJournal();
  const cfg: AgentConfig = { colonyId: "col", agentId: "agt_1", name: "a1", kind: "internal", model: OWN, running: true, epoch: 1, startedAt: 0, failures: 0 };
  journal.setConfig(cfg);
  const deps: LoopDeps = { colony, git, model, journal, now: () => 1_000_000, rand: () => 0.5, intentSpend: true };
  expect(await tick(deps)).toEqual({ sleepMs: FIRST_POLL_MS });
  expect(colony.proposals).toHaveLength(1);
  return { journal, proposal: colony.proposals[0]!, settle: () => settle(late ?? null) };
}

describe("an agent's hedged call", () => {
  it("says on its usage check that the copy answered, and counts the losing copy's tokens once it answers", async () => {
    const w = await write({ hedged: { after_ms: 60_000, winner: "copy", model: OWN, cause: "slow" } }, { model: OWN, usage: { input: 70, output: 50, cached: 0, neurons: 0 } });
    const usage = w.proposal.evidence.checks.find((c) => c.name === "agent model usage")!;
    expect(usage.detail).toBe(`${OWN}: 1 call(s), 70 input / 30 output tokens; 1 answer came from a hedge copy sent after 60.0 s`);
    expect(w.journal.counters()).toMatchObject({ llmCalls: 1, tokensIn: 70, tokensOut: 30 });
    w.settle();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(w.journal.counters()).toMatchObject({ llmCalls: 2, tokensIn: 140, tokensOut: 80 });
    expect(w.journal.intentUsage()).toEqual([{ intentId: "int_v", model: OWN, calls: 2, input: 140, output: 80, at: 1_000_000 }]);
  });

  it("counts nothing more for a losing copy that was aborted, and nothing changes without a hedge", async () => {
    const aborted = await write({ hedged: { after_ms: 60_000, winner: "copy", model: OWN, cause: "slow" } }, null);
    aborted.settle();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(aborted.journal.counters()).toMatchObject({ llmCalls: 1, tokensIn: 70, tokensOut: 30 });
    const plain = await write({});
    expect(plain.proposal.evidence.checks.find((c) => c.name === "agent model usage")!.detail).toBe(`${OWN}: 1 call(s), 70 input / 30 output tokens`);
    expect(plain.journal.counters()).toMatchObject({ llmCalls: 1, tokensIn: 70, tokensOut: 30 });
  });
});
