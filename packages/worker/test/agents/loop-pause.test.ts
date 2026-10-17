import { describe, expect, it } from "vitest";
import type { AgentInfo, Colony, ColonySnapshot, FileVersion, Id, Intent, Proposal, Rule, Sha, WorkspaceLease } from "@fire_trident/core";
import { MemoryJournal } from "../../src/agents/journal.ts";
import { FIRST_POLL_MS, MAX_STEP_ATTEMPTS, tick } from "../../src/agents/loop.ts";
import type { AgentConfig, BaseFile, GitOps, LoopDeps, ModelClient } from "../../src/agents/loop.ts";
import type { ColonyRpc, ProposeInput, TakeResult } from "../../src/agents/rpc.ts";
import { PAUSE_WAIT_MS, pauseError, pausedSentence, type PauseView } from "../../src/colony/pause.ts";

/**
 * An in-platform agent while its colony is paused (colony/pause.ts): a refused take waits with no failure counted; no
 * model call starts while paused (the agent keeps heartbeating, so it keeps its place); a refused proposal gives its
 * attempt back and waits as long as the pause lasts, so the job and its work survive; on resume it goes on.
 */

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
const PAUSE = { by: "maya", reason: "demo reset" };

/** A colony with a pause switch the test flips: what pauseState says, and which writes it refuses. */
class FakeColony implements ColonyRpc {
  intent: Intent = { ...INTENT };
  proposals: Proposal[] = [];
  heartbeats = 0;
  /** What pauseState answers. */
  paused = false;
  /** Writes refused with the pause's sentence. */
  refuseTake = false;
  refusePropose = false;
  /** Set paused right after a take hands out work (a person paused while the agent was reading). */
  pauseAfterTake = false;
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
    if (this.refuseTake) throw pauseError(PAUSE);
    if (this.intent.status !== "open" && this.intent.assignedTo !== agentId) return { wait: true, retryInMs: 5_000, reason: "no open intents" };
    this.intent = { ...this.intent, status: "claimed", assignedTo: agentId };
    if (this.pauseAfterTake) this.paused = true;
    return { intent: { ...this.intent }, lease: LEASE };
  }
  async heartbeat(): Promise<void> {
    this.heartbeats++;
  }
  async propose(p: ProposeInput): Promise<Proposal> {
    if (this.refusePropose) throw pauseError(PAUSE);
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
  async pauseState(): Promise<PauseView> {
    return this.paused ? { paused: true, pauses: [{ scope: "colony", ...PAUSE, at: 1 }], refusal: pausedSentence(PAUSE) } : { paused: false, pauses: [], refusal: null };
  }
}

/** A clone of an empty trunk: the file is new. */
const git: GitOps = {
  ensureBase: async (p) => ({ baseSha: p.baseSha, fallback: false }),
  listFiles: async () => ["README.md"],
  readFile: async (): Promise<BaseFile | null> => null,
  commit: async (p): Promise<{ headSha: Sha; writeSet: FileVersion[] }> => ({ headSha: "b".repeat(40), writeSet: p.changes.map((c) => ({ path: c.path, blob: "c".repeat(40) })) }),
  push: async () => undefined,
};

function setup() {
  const colony = new FakeColony();
  let calls = 0;
  const model: ModelClient = {
    complete: async () => {
      calls++;
      return { text: '<file>\nexport const VERSION = "1";\n</file>' };
    },
  };
  const journal = new MemoryJournal();
  const cfg: AgentConfig = { colonyId: "col", agentId: "agt_1", name: "a1", kind: "internal", model: "@cf/test/model", running: true, epoch: 1, startedAt: 0, failures: 0 };
  journal.setConfig(cfg);
  let t = 1_000_000;
  const deps: LoopDeps = { colony, git, model, journal, now: () => t, rand: () => 0.5 };
  return { colony, journal, deps, calls: () => calls, advance: (ms: number) => (t += ms) };
}

describe("agent loop: a paused colony", () => {
  it("waits on a refused take without counting a failure", async () => {
    const s = setup();
    s.colony.refuseTake = true;
    for (let i = 0; i < 3; i++) expect(await tick(s.deps)).toEqual({ sleepMs: PAUSE_WAIT_MS });
    expect(s.journal.config()?.failures).toBe(0);
    expect(s.journal.counters().errors ?? 0).toBe(0);
    s.colony.refuseTake = false;
    expect(await tick(s.deps)).toEqual({ sleepMs: FIRST_POLL_MS });
    expect(s.colony.proposals).toHaveLength(1);
  });

  it("starts no model call while paused, keeps its place by heartbeating, and writes once resumed", async () => {
    const s = setup();
    s.colony.pauseAfterTake = true;
    expect(await tick(s.deps)).toEqual({ sleepMs: PAUSE_WAIT_MS });
    expect(s.journal.job()).toMatchObject({ step: "produce", attempts: 0 });
    expect(s.calls()).toBe(0);
    s.advance(60_000);
    const beats = s.colony.heartbeats;
    expect(await tick(s.deps)).toEqual({ sleepMs: PAUSE_WAIT_MS });
    expect(s.colony.heartbeats).toBeGreaterThan(beats);
    expect(s.calls()).toBe(0);
    s.colony.pauseAfterTake = false;
    s.colony.paused = false;
    expect(await tick(s.deps)).toEqual({ sleepMs: FIRST_POLL_MS });
    expect(s.calls()).toBe(1);
    expect(s.colony.proposals).toHaveLength(1);
  });

  it("gives a refused proposal's attempt back and waits as long as the pause lasts, keeping the work", async () => {
    const s = setup();
    s.colony.refusePropose = true;
    for (let i = 0; i < MAX_STEP_ATTEMPTS + 3; i++) expect(await tick(s.deps)).toEqual({ sleepMs: PAUSE_WAIT_MS });
    expect(s.journal.job()).toMatchObject({ step: "propose", attempts: 0 });
    expect(s.journal.job()?.lastError).toBe(pausedSentence(PAUSE));
    expect(s.calls()).toBe(1);
    s.colony.refusePropose = false;
    expect(await tick(s.deps)).toEqual({ sleepMs: FIRST_POLL_MS });
    expect(s.colony.proposals).toHaveLength(1);
    expect(s.calls()).toBe(1);
  });
});
