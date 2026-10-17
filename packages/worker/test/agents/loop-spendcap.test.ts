import { describe, expect, it } from "vitest";
import type { AgentInfo, Colony, ColonySnapshot, FileVersion, Id, Intent, Proposal, Rule, Sha, WorkspaceLease } from "@fire_trident/core";
import { MemoryJournal } from "../../src/agents/journal.ts";
import { FIRST_POLL_MS, tick } from "../../src/agents/loop.ts";
import type { AgentConfig, BaseFile, GitOps, LoopDeps, ModelClient } from "../../src/agents/loop.ts";
import type { ColonyRpc, ProposeInput, TakeResult } from "../../src/agents/rpc.ts";
import { ColonyPause, PAUSE_WAIT_MS, pausedSentence, type PauseView, type SqlRunner } from "../../src/colony/pause.ts";
import { SPEND_CAP_ACTOR, SpendCapBook, agentCapGate, agentReserve, agentSettle, cappedClient, type AgentCapAsk, type CapSettle } from "../../src/colony/spendcap.ts";

/**
 * An in-platform agent against a colony with a spend cap (colony/spendcap.ts): each model call is reserved with the
 * colony first. At the cap the colony refuses the call and trips the pause, so no model call starts and the agent waits
 * as it does for any pause, counting no failure and keeping its job; once a person raises the cap it writes and
 * proposes, and what the call cost is settled with the colony.
 */

interface DatabaseSync {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
}
const SQLITE = "node:sqlite";
const { DatabaseSync } = (await import(SQLITE)) as { DatabaseSync: new (path: string) => DatabaseSync };

function sqlite(): SqlRunner {
  const db = new DatabaseSync(":memory:");
  return {
    exec: (q, ...b) => {
      const rows = db.prepare(q).all(...(b as never[]));
      return { toArray: () => rows };
    },
  };
}

const GPT = "@cf/openai/gpt-oss-120b";
const BASE = "a".repeat(40);
const LEASE: WorkspaceLease = {
  repo: { namespace: "ft-ws-1", name: "col--ws-1", remote: "https://ws.invalid/col--ws-1.git" },
  token: "fixture-workspace",
  tokenExpiresAt: Number.MAX_SAFE_INTEGER,
  baseSha: BASE,
  leasedAt: 0,
  trunk: { remote: "https://trunk.invalid/col--trunk.git", token: "fixture-trunk", sha: BASE },
};
const INTENT: Intent = { id: "int_v", colonyId: "col", title: "Expose the version", why: "Expose the version.", source: "human", footprint: ["src/version.ts"], priority: 1, status: "open", createdAt: 0, createdBy: "t" };

/** A colony with a real pause switch and spend cap: its pause view, and the agent's reservations and settles. */
class CappedColony implements ColonyRpc {
  readonly sql = sqlite();
  readonly pending: Array<Promise<unknown>> = [];
  book = 0;
  intent: Intent = { ...INTENT };
  proposals: Proposal[] = [];
  readonly pause = new ColonyPause({ sql: this.sql, now: () => Date.now(), readDeployment: async () => null, publish: () => undefined, tellWriter: async () => true });
  readonly cap = new SpendCapBook({
    sql: this.sql,
    now: () => Date.now(),
    bookUsd: () => this.book,
    ownPause: () => this.pause.own(),
    trip: (reason) => this.pause.pause({ by: SPEND_CAP_ACTOR, reason }),
    lift: (by, reason) => this.pause.resume({ by, reason }),
    waitUntil: (p) => void this.pending.push(p),
  });
  async spendReserve(a: AgentCapAsk) {
    return agentReserve(this.cap, a, (m) => m);
  }
  async spendSettle(s: CapSettle) {
    agentSettle(this.cap, s, (m) => m);
    return { settled: true };
  }
  async pauseState(): Promise<PauseView> {
    return this.pause.view();
  }
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
    return { intent: { ...this.intent }, lease: LEASE };
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

const git: GitOps = {
  ensureBase: async (p) => ({ baseSha: p.baseSha, fallback: false }),
  listFiles: async () => ["README.md"],
  readFile: async (): Promise<BaseFile | null> => null,
  commit: async (p): Promise<{ headSha: Sha; writeSet: FileVersion[] }> => ({ headSha: "b".repeat(40), writeSet: p.changes.map((c) => ({ path: c.path, blob: "c".repeat(40) })) }),
  push: async () => undefined,
};

function setup() {
  const colony = new CappedColony();
  let calls = 0;
  // Each call reports 100,000 input tokens: $0.035 at gpt-oss-120b's list price.
  const model: ModelClient = {
    complete: async () => {
      calls++;
      return { text: '<file>\nexport const VERSION = "1";\n</file>', model: GPT, usage: { input: 100_000, output: 0, cached: 0, neurons: 0 } };
    },
  };
  const journal = new MemoryJournal();
  const cfg: AgentConfig = { colonyId: "col", agentId: "agt_1", name: "a1", kind: "internal", model: GPT, running: true, epoch: 1, startedAt: 0, failures: 0 };
  journal.setConfig(cfg);
  let t = 1_000_000;
  const capped = cappedClient(model, agentCapGate(colony, cfg.agentId));
  const deps: LoopDeps = { colony, git, model: capped, journal, now: () => (t += 1), rand: () => 0.5 };
  return { colony, journal, deps, calls: () => calls };
}

describe("agent loop: a colony with a spend cap", () => {
  it("starts no model call at the cap, waits as for a pause without counting a failure, and writes once a person raises the cap", async () => {
    const s = setup();
    s.colony.book = 0.999;
    await s.colony.cap.set({ usd: 1, reviewReserveUsd: 0, by: "maya" });
    expect(s.colony.pause.own()).toBeNull();

    // The write's reservation does not fit in what is left: refused, and the pause trips.
    expect(await tick(s.deps)).toEqual({ sleepMs: PAUSE_WAIT_MS });
    await Promise.all(s.colony.pending);
    expect(s.calls()).toBe(0);
    const reason = "spend cap: $0.999 of $1.00 spent on model calls this platform made";
    expect(s.colony.pause.own()).toMatchObject({ by: SPEND_CAP_ACTOR });
    expect(s.colony.pause.own()!.reason.startsWith(reason)).toBe(true);
    expect(s.journal.job()).toMatchObject({ step: "produce", attempts: 0 });
    expect(s.journal.job()?.lastError).toBe(pausedSentence({ by: SPEND_CAP_ACTOR, reason: s.colony.pause.own()!.reason }));
    expect(s.journal.counters().errors ?? 0).toBe(0);

    // Paused: the next tick starts no model call either.
    expect(await tick(s.deps)).toEqual({ sleepMs: PAUSE_WAIT_MS });
    expect(s.calls()).toBe(0);

    // A person raises the cap: the pause lifts, the agent writes and proposes, and the call's cost is settled.
    expect(await s.colony.cap.set({ usd: 2, by: "maya" })).toMatchObject({ lifted: true });
    expect(await tick(s.deps)).toEqual({ sleepMs: FIRST_POLL_MS });
    expect(s.calls()).toBe(1);
    expect(s.colony.proposals).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(s.colony.cap.state()).toMatchObject({ inFlightUsd: 0, spentUsd: 1.034 });
  });

  it("calls the model as before when the colony has no cap", async () => {
    const s = setup();
    expect(await tick(s.deps)).toEqual({ sleepMs: FIRST_POLL_MS });
    expect(s.calls()).toBe(1);
    expect(s.colony.proposals).toHaveLength(1);
    expect(s.colony.cap.state()).toBeNull();
  });
});
