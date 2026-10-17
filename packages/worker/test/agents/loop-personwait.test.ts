import { describe, expect, it } from "vitest";
import type { AgentInfo, Colony, ColonySnapshot, Id, Intent, Proposal, ProposalStatus, Rule, Sha, WorkspaceLease } from "@fire_trident/core";
import { MemoryJournal } from "../../src/agents/journal.ts";
import { ESCALATED_POLL_MS, HEARTBEAT_EVERY_MS, tick } from "../../src/agents/loop.ts";
import type { AgentConfig, Job, LoopDeps } from "../../src/agents/loop.ts";
import { AWAITING_PERSON, recordLeftOutcome } from "../../src/agents/personwait.ts";
import type { ColonyRpc, TakeResult } from "../../src/agents/rpc.ts";

/**
 * An in-platform agent whose change waits for a person (FT_PERSON_WAIT, agents/personwait.ts): an inline change ends
 * the job and the agent takes other work; a change committed to the workspace keeps the agent waiting but its claims
 * are no longer refreshed; and the final outcome the colony pushes later is recorded in the agent's journal.
 */

const BASE = "b".repeat(40) as Sha;
const INTENT: Intent = {
  id: "int_1",
  colonyId: "col",
  title: "Split a bill evenly",
  why: "Split bills.",
  source: "human",
  footprint: ["src/core/money.ts", "src/split.ts"],
  priority: 1,
  status: "claimed",
  createdAt: 0,
  createdBy: "t",
};
const LEASE: WorkspaceLease = {
  repo: { namespace: "ft-ws-1", name: "col--ws-1", remote: "https://ws.invalid/col--ws-1.git" },
  token: "fixture-workspace",
  tokenExpiresAt: Number.MAX_SAFE_INTEGER,
  baseSha: BASE,
  leasedAt: 0,
  trunk: { remote: "https://trunk.invalid/col--trunk.git", token: "fixture-trunk", sha: BASE },
};

class FakeColony implements ColonyRpc {
  status: ProposalStatus = "escalated";
  takes = 0;
  polls = 0;
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
  async take(): Promise<TakeResult> {
    this.takes++;
    return { wait: true, retryInMs: 5_000, reason: "no open intents" };
  }
  async heartbeat(): Promise<void> {}
  async propose(): Promise<Proposal> {
    throw new Error("not used");
  }
  async getProposal(id: Id): Promise<Proposal | null> {
    this.polls++;
    return { id, intentId: INTENT.id, agentId: "agt_1", status: this.status, reason: "escalated by llm: acceptance not shown met" } as Proposal;
  }
  async inbox(): Promise<Proposal[]> {
    return [];
  }
  async getRule(): Promise<Rule | null> {
    return null;
  }
  async abandon(): Promise<void> {}
}

/** An agent waiting on proposal prp_1 (inline or committed), with `personWait` as the colony's flag gives it. */
function setup(p: { inline: boolean; personWait: boolean }) {
  const journal = new MemoryJournal();
  const colony = new FakeColony();
  const refreshed: Job[] = [];
  let t = 1_000_000;
  const cfg: AgentConfig = { colonyId: "col", agentId: "agt_1", name: "a1", kind: "internal", model: "m", running: true, epoch: 1, startedAt: 0, failures: 0 };
  journal.setConfig(cfg);
  const job: Job = {
    intentId: INTENT.id,
    intent: INTENT,
    lease: LEASE,
    rule: null,
    step: "await",
    attempts: 0,
    takenAt: t - 60_000,
    stepStartedAt: t - 30_000,
    llmCalls: 3,
    lastHeartbeatAt: t,
    proposalId: "prp_1",
    proposedAt: t - 30_000,
    headSha: "c".repeat(40),
    writeSet: [{ path: "src/core/money.ts", blob: "d".repeat(40) }],
    ...(p.inline ? { checkout: "virtual" as const, inline: true } : {}),
  };
  journal.setJob(job);
  const deps = (): LoopDeps => ({
    colony,
    git: {} as LoopDeps["git"],
    model: { complete: async () => ({ text: null }) },
    journal,
    now: () => t,
    rand: () => 0.5,
    outcome: () => null,
    refreshClaims: async (j: Job) => void refreshed.push(j),
    personWait: p.personWait,
  });
  return { journal, colony, refreshed, deps, advance: (ms: number) => (t += ms) };
}

describe("an agent whose change waits for a person", () => {
  it("ends the job of an inline change and takes other work, its proposal left with the person", async () => {
    const s = setup({ inline: true, personWait: true });
    await tick(s.deps());
    expect(s.journal.job()).toBeNull();
    expect(s.journal.history(1)[0]).toMatchObject({ outcome: AWAITING_PERSON, proposalId: "prp_1", intentId: "int_1", reason: "escalated by llm: acceptance not shown met" });
    expect(s.journal.counters()[AWAITING_PERSON]).toBe(1);
    // The next tick asks the colony for work.
    await tick(s.deps());
    expect(s.colony.takes).toBe(1);
  });

  it("keeps waiting, as before, without the flag or when its change is committed to the workspace, and then refreshes no claim", async () => {
    const off = setup({ inline: true, personWait: false });
    expect(await tick(off.deps())).toEqual({ sleepMs: ESCALATED_POLL_MS });
    expect(off.journal.job()).toMatchObject({ step: "await", lastStatus: "escalated" });
    off.advance(HEARTBEAT_EVERY_MS);
    await tick(off.deps());
    expect(off.refreshed).toHaveLength(1);

    const committed = setup({ inline: false, personWait: true });
    expect(await tick(committed.deps())).toEqual({ sleepMs: ESCALATED_POLL_MS });
    expect(committed.journal.job()).toMatchObject({ step: "await", lastStatus: "escalated" });
    committed.advance(HEARTBEAT_EVERY_MS);
    await tick(committed.deps());
    expect(committed.refreshed).toEqual([]);
    expect(committed.colony.takes).toBe(0);
    // A person approves: the change is in a lane again, and its claims are refreshed again.
    committed.colony.status = "ready";
    await tick(committed.deps());
    committed.advance(HEARTBEAT_EVERY_MS);
    await tick(committed.deps());
    expect(committed.refreshed).toHaveLength(1);
  });

  it("records the final outcome the colony pushes later for the change it left with the person", async () => {
    const s = setup({ inline: true, personWait: true });
    await tick(s.deps());
    expect(recordLeftOutcome(s.journal, { proposalId: "prp_1", status: "escalated" }, 2_000_000)).toBe(false);
    expect(recordLeftOutcome(s.journal, { proposalId: "prp_other", status: "landed" }, 2_000_000)).toBe(false);
    expect(recordLeftOutcome(s.journal, { proposalId: "prp_1", status: "landed", landingId: "lnd_1" }, 2_000_000)).toBe(true);
    expect(s.journal.counters()["landed"]).toBe(1);
    expect(s.journal.steps(1)[0]).toMatchObject({ step: "outcome", intentId: "int_1", ok: true, detail: "the change left with a person (prp_1) landed" });
  });
});
