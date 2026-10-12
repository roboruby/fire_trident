import { describe, expect, it } from "vitest";
import type { AgentInfo, Colony, ColonySnapshot, FileVersion, Id, Intent, Proposal, ProposalStatus, Rule, Sha, WorkspaceLease } from "@fire_trident/core";
import { MemoryJournal } from "../../src/agents/journal.ts";
import { COLONY_BEAT_EVERY_MS, HEARTBEAT_EVERY_MS, PUSH_FALLBACK_POLL_MS, tick } from "../../src/agents/loop.ts";
import type { AgentConfig, BaseFile, GitOps, Job, LoopDeps } from "../../src/agents/loop.ts";
import { OutcomeBox, footprintRegions, regionNames } from "../../src/agents/outcomes.ts";
import type { ColonyRpc, ProposeInput, TakeResult } from "../../src/agents/rpc.ts";

/**
 * Pushed outcomes and direct claim refreshes in the agent loop: an agent that can receive pushes
 * proposes with `notify`, learns its outcome without polling, and refreshes its claims in the
 * regions itself, sending the colony only a liveness beat every few minutes.
 */

const BASE = "b".repeat(40);
const sha = (s: string): Sha => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0").repeat(5);
};

const RULE: Rule = { id: "rul_1", colonyId: "col", kind: "forbid-pattern", spec: { pattern: "console\\.log", replacement: "logger.info" }, description: "No console.log", approvedBy: "t", createdAt: 0 };
const INTENT: Intent = {
  id: "int_1",
  colonyId: "col",
  title: "No console.log in src/a.ts",
  why: "No console.log.",
  source: "rule",
  ruleId: "rul_1",
  footprint: ["src/a.ts"],
  priority: 1,
  status: "open",
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
  proposals = new Map<Id, Proposal>();
  inputs: ProposeInput[] = [];
  polls = 0;
  beats: Array<{ claims?: boolean } | undefined> = [];
  taken = false;
  async getColony(): Promise<Colony | null> {
    return null;
  }
  async snapshot(): Promise<ColonySnapshot> {
    return { rules: [RULE] } as unknown as ColonySnapshot;
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
    if (this.taken) return { wait: true, retryInMs: 5_000, reason: "no open intents" };
    this.taken = true;
    return { intent: { ...INTENT, status: "claimed" }, lease: LEASE, rule: RULE };
  }
  async heartbeat(_agentId: Id, opts?: { claims?: boolean }): Promise<void> {
    this.beats.push(opts);
  }
  async propose(p: ProposeInput): Promise<Proposal> {
    this.inputs.push(p);
    const id = `prp_${this.proposals.size + 1}`;
    const proposal: Proposal = { ...p, id, status: "ready", createdAt: 0, evidence: { checks: [], notVerified: "" } } as Proposal;
    this.proposals.set(id, proposal);
    return proposal;
  }
  async getProposal(id: Id): Promise<Proposal | null> {
    this.polls++;
    return this.proposals.get(id) ?? null;
  }
  async inbox(): Promise<Proposal[]> {
    return [];
  }
  async getRule(): Promise<Rule | null> {
    return RULE;
  }
  async abandon(): Promise<void> {}
}

class FakeGit implements GitOps {
  hang: Promise<void> | null = null;
  async ensureBase(p: { baseSha: Sha }): Promise<{ baseSha: Sha; fallback: boolean }> {
    return { baseSha: p.baseSha, fallback: false };
  }
  async listFiles(): Promise<string[]> {
    return ["src/a.ts"];
  }
  async readFile(): Promise<BaseFile | null> {
    const c = "console.log(1);\n";
    return { blob: sha(c), mode: "100644", bytes: new TextEncoder().encode(c) };
  }
  async commit(p: Parameters<GitOps["commit"]>[0]): Promise<{ headSha: Sha; writeSet: FileVersion[] }> {
    return { headSha: sha(JSON.stringify(p.changes)), writeSet: p.changes.map((c) => ({ path: c.path, blob: sha(c.content) })) };
  }
  async push(): Promise<void> {
    if (this.hang) await this.hang;
  }
}

function setup(push: boolean) {
  const journal = new MemoryJournal();
  const colony = new FakeColony();
  const git = new FakeGit();
  const pushed = new Map<Id, { status: ProposalStatus; reason?: string }>();
  const refreshed: Job[] = [];
  let t = 1_000_000;
  const cfg: AgentConfig = { colonyId: "col", agentId: "agt_1", name: "a1", kind: "synthetic", model: "m", running: true, epoch: 1, startedAt: 0, failures: 0 };
  journal.setConfig(cfg);
  const deps = (): LoopDeps => ({
    colony,
    git,
    model: { complete: async () => ({ text: null }) },
    journal,
    now: () => t,
    rand: () => 0.5,
    ...(push
      ? {
          outcome: (id: Id) => pushed.get(id) ?? null,
          refreshClaims: async (job: Job) => void refreshed.push(job),
        }
      : {}),
  });
  return { journal, colony, git, pushed, refreshed, deps, advance: (ms: number) => (t += ms) };
}

describe("pushed outcomes", () => {
  it("proposes with notify, waits for the push, and settles without polling the colony", async () => {
    const s = setup(true);
    expect(await tick(s.deps())).toEqual({ sleepMs: PUSH_FALLBACK_POLL_MS });
    const p = [...s.colony.proposals.values()][0]!;
    expect(s.colony.inputs[0]).toMatchObject({ notify: true });
    expect(s.journal.job()).toMatchObject({ step: "await", proposalId: p.id });
    // The colony pushes the landing; the woken loop finishes the job without a getProposal call.
    s.pushed.set(p.id, { status: "landed" });
    await tick(s.deps());
    expect(s.colony.polls).toBe(0);
    expect(s.journal.job()).toBeNull();
    expect(s.journal.history(1)[0]).toMatchObject({ outcome: "landed", proposalId: p.id });
  });

  it("falls back to a slow poll when no push came, and carries a pushed return's reason", async () => {
    const s = setup(true);
    await tick(s.deps());
    const p = [...s.colony.proposals.values()][0]!;
    s.advance(PUSH_FALLBACK_POLL_MS);
    expect(await tick(s.deps())).toEqual({ sleepMs: PUSH_FALLBACK_POLL_MS });
    expect(s.colony.polls).toBe(1);
    s.pushed.set(p.id, { status: "returned", reason: "stale: src/a.ts" });
    await tick(s.deps());
    expect(s.journal.history(1)[0]).toMatchObject({ outcome: "returned", reason: "stale: src/a.ts" });
    expect(s.colony.polls).toBe(1);
  });

  it("without push support it proposes without notify and polls as before", async () => {
    const s = setup(false);
    await tick(s.deps());
    expect(s.colony.inputs[0]).not.toHaveProperty("notify");
    await tick(s.deps());
    expect(s.colony.polls).toBe(1);
  });
});

describe("claim refreshes straight to the regions", () => {
  it("refreshes claims every heartbeat and beats the colony only every few minutes", async () => {
    const s = setup(true);
    let open: () => void = () => undefined;
    s.git.hang = new Promise<void>((r) => (open = r));
    const running = tick(s.deps());
    await new Promise((r) => setTimeout(r, 5));
    // While the push hangs, time passes; the next steps run their heartbeats.
    s.advance(HEARTBEAT_EVERY_MS);
    open();
    await running;
    await tick(s.deps());
    expect(s.refreshed.map((j) => j.intentId)).toEqual(["int_1"]);
    expect(s.colony.beats).toEqual([]);
    s.advance(COLONY_BEAT_EVERY_MS);
    await tick(s.deps());
    expect(s.refreshed).toHaveLength(2);
    expect(s.colony.beats).toEqual([{ claims: false }]);
  });
});

/** The part of node:sqlite these tests use (the worker compiles against workers types, not Node's). */
interface DatabaseSync {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
}
const SQLITE = "node:sqlite";
const { DatabaseSync } = (await import(SQLITE)) as { DatabaseSync: new (path: string) => DatabaseSync };

function sqlStorage(): SqlStorage {
  const db = new DatabaseSync(":memory:");
  return {
    exec(query: string, ...bindings: unknown[]) {
      const rows = db.prepare(query).all(...bindings);
      return { toArray: () => rows, one: () => rows[0], [Symbol.iterator]: () => rows[Symbol.iterator]() };
    },
  } as unknown as SqlStorage;
}

describe("OutcomeBox", () => {
  it("keeps the latest pushed outcome per proposal, rejects malformed ones, and forgets old ones", () => {
    const box = new OutcomeBox(sqlStorage());
    expect(box.put({ proposalId: "p1", status: "escalated" }, 1_000)).toBe(true);
    expect(box.put({ proposalId: "p1", status: "landed", landingId: "l1" }, 2_000)).toBe(true);
    expect(box.get("p1")).toEqual({ status: "landed" });
    expect(box.put({ proposalId: "p2", status: "returned", reason: "stale" }, 3_000)).toBe(true);
    expect(box.get("p2")).toEqual({ status: "returned", reason: "stale" });
    expect(box.put({ proposalId: "", status: "landed" }, 3_000)).toBe(false);
    expect(box.put({ proposalId: "p3", status: "bogus" as ProposalStatus }, 3_000)).toBe(false);
    expect(box.get("nope")).toBeNull();
    box.put({ proposalId: "p4", status: "landed" }, 2 * 60 * 60_000);
    expect(box.get("p1")).toBeNull();
    expect(box.get("p4")).toEqual({ status: "landed" });
  });

  it("names each region a footprint touches once", () => {
    expect(footprintRegions(["src/a.ts", "src/b.ts", "docs/x.md", "README.md"], 1)).toEqual(["src", "docs", "."]);
    expect(regionNames("col", ["src/lib/a.ts", "src/lib/b.ts", "src/c.ts"], 2)).toEqual(["col:src/lib", "col:src"]);
  });
});
