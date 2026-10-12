import { describe, expect, it } from "vitest";
import type { AgentInfo, Colony, ColonySnapshot, Directive, FileVersion, Id, Intent, Proposal, Rule, Sha, WorkspaceLease } from "@fire_trident/core";
import { MemoryJournal } from "../../src/agents/journal.ts";
import { receiveDirective, tick } from "../../src/agents/loop.ts";
import type { AgentConfig, BaseFile, GitOps, LoopDeps, ModelClient, ModelReply } from "../../src/agents/loop.ts";
import type { ChatMessage } from "../../src/agents/prompt.ts";
import type { ColonyRpc, ProposeInput, TakeResult } from "../../src/agents/rpc.ts";

/**
 * Changing direction in the agent loop: directives the colony pushes (withdrawal, revision,
 * guidance), refusals that mean the intent moved, and the status notes the agent relays.
 */

const BASE = "b".repeat(40);
const hash = (s: string): Sha => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h.toString(16).padStart(8, "0").repeat(5);
};
const RULE: Rule = { id: "rul_1", colonyId: "col", kind: "forbid-pattern", spec: { pattern: "console\\.log", hint: "Use logger.info." }, description: "No console.log", approvedBy: "t", createdAt: 0 };
const ORIGINAL = "export function f(x: number) {\n  console.log(x);\n  return x;\n}\n";
const FIXED = "export function f(x: number) {\n  logger.info(x);\n  return x;\n}\n";
const LEASE: WorkspaceLease = {
  repo: { namespace: "ft-ws-1", name: "col--ws-1", remote: "https://ws.invalid/col--ws-1.git" },
  token: "fixture-workspace",
  tokenExpiresAt: Number.MAX_SAFE_INTEGER,
  baseSha: BASE,
  leasedAt: 0,
  trunk: { remote: "https://trunk.invalid/col--trunk.git", token: "fixture-trunk", sha: BASE },
};

function intent(over: Partial<Intent> = {}): Intent {
  return { id: "int_1", colonyId: "col", title: "No console.log in src/a.ts", why: "Use the logger.", source: "rule", ruleId: "rul_1", footprint: ["src/a.ts"], priority: 1, status: "open", createdAt: 0, createdBy: "t", ...over };
}

class FakeColony implements ColonyRpc {
  intents: Intent[] = [intent()];
  proposals = new Map<Id, Proposal>();
  abandoned: string[] = [];
  recalls: Id[] = [];
  relays: string[] = [];
  proposeError: Error | null = null;
  /** Guidance the colony holds per intent (sent to other agents). */
  intentGuidance: Record<Id, Array<{ id: Id; message: string; by: string; at: number }>> = {};
  guidanceCalls = 0;

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
  async take(agentId: Id): Promise<TakeResult> {
    const held = this.intents.find((i) => (i.status === "claimed" || i.status === "proposed") && i.assignedTo === agentId);
    const i = held ?? this.intents.find((x) => x.status === "open");
    if (!i) return { wait: true, retryInMs: 5000, reason: "no open intents" };
    i.status = "claimed";
    i.assignedTo = agentId;
    return { intent: { ...i }, lease: LEASE, rule: RULE };
  }
  async heartbeat(): Promise<void> {}
  async propose(p: ProposeInput): Promise<Proposal> {
    if (this.proposeError) {
      const e = this.proposeError;
      this.proposeError = null;
      throw e;
    }
    const id = `prp_${this.proposals.size + 1}`;
    const proposal: Proposal = { ...p, id, status: "ready", createdAt: this.proposals.size, evidence: { checks: p.evidence?.checks ?? [], notVerified: p.evidence?.notVerified ?? "" } };
    this.proposals.set(id, proposal);
    const i = this.intents.find((x) => x.id === p.intentId);
    if (i) i.status = "proposed";
    return proposal;
  }
  async getProposal(id: Id): Promise<Proposal | null> {
    return this.proposals.get(id) ?? null;
  }
  async inbox(agentId: Id): Promise<Proposal[]> {
    return [...this.proposals.values()].filter((p) => p.agentId === agentId).reverse();
  }
  async getRule(): Promise<Rule | null> {
    return RULE;
  }
  async abandon(_agentId: Id, reason?: string): Promise<void> {
    this.abandoned.push(reason ?? "");
  }
  async recall(_agentId: Id, proposalId: Id, reason?: string): Promise<Proposal> {
    this.recalls.push(proposalId);
    const p = this.proposals.get(proposalId)!;
    if (p.status === "ready") {
      p.status = "returned";
      p.reason = `superseded: ${reason}`;
      const i = this.intents.find((x) => x.id === p.intentId);
      if (i) i.status = "claimed";
    }
    return { ...p };
  }
  async guidance(intentId: Id): Promise<Array<{ id: Id; message: string; by: string; at: number }>> {
    this.guidanceCalls++;
    return this.intentGuidance[intentId] ?? [];
  }
  async relay(_agentId: Id, note: string): Promise<unknown> {
    this.relays.push(note);
    return { ok: true };
  }
}

class FakeGit implements GitOps {
  files: Record<string, string> = { "src/a.ts": ORIGINAL };
  commits: Array<{ changes: Array<{ path: string; content: string }> }> = [];
  async ensureBase(p: { baseSha: Sha }): Promise<{ baseSha: Sha; fallback: boolean }> {
    return { baseSha: p.baseSha, fallback: false };
  }
  async listFiles(): Promise<string[]> {
    return Object.keys(this.files);
  }
  async readFile(_base: Sha, path: string): Promise<BaseFile | null> {
    const c = this.files[path];
    return c === undefined ? null : { blob: hash(`blob ${c}`), mode: "100644", bytes: new TextEncoder().encode(c) };
  }
  async commit(p: Parameters<GitOps["commit"]>[0]): Promise<{ headSha: Sha; writeSet: FileVersion[] }> {
    this.commits.push({ changes: p.changes });
    const writeSet = p.changes.map((c) => ({ path: c.path, blob: hash(`blob ${c.content}`) }));
    return { headSha: hash(JSON.stringify([this.commits.length, writeSet])), writeSet };
  }
  async push(): Promise<void> {}
}

class FakeModel implements ModelClient {
  calls: ChatMessage[][] = [];
  gate: Promise<void> | null = null;
  async complete(p: { messages: ChatMessage[] }): Promise<ModelReply> {
    this.calls.push(p.messages);
    const gate = this.gate;
    this.gate = null;
    if (gate) await gate;
    return { text: `<file>\n${FIXED}</file>` };
  }
}

function setup(kind: "internal" | "synthetic" = "internal") {
  const journal = new MemoryJournal();
  const colony = new FakeColony();
  const git = new FakeGit();
  const model = new FakeModel();
  let t = 1_000_000;
  const cfg: AgentConfig = { colonyId: "col", agentId: "agt_1", name: "a1", kind, model: "@cf/test/model", running: true, epoch: 1, startedAt: 0, failures: 0 };
  journal.setConfig(cfg);
  const deps = (over: Partial<LoopDeps> = {}): LoopDeps => ({ colony, git, model, journal, now: () => t, rand: () => 0.5, ...over });
  return { journal, colony, git, model, deps, advance: (ms: number) => (t += ms), now: () => t };
}

const directive = (over: Partial<Directive> = {}): Directive => ({ id: "dir_1", colonyId: "col", agentId: "agt_1", kind: "guidance", intentId: "int_1", message: "Name the logger call logger.debug", by: "matt", at: 1, ...over });

/** Hold the next model call until the returned function is called; resolves once the call started. */
async function holdModel(model: FakeModel, started: () => boolean): Promise<() => void> {
  let release!: () => void;
  model.gate = new Promise<void>((r) => (release = r));
  for (let i = 0; i < 200 && !started(); i++) await new Promise((r) => setTimeout(r, 0));
  return release;
}

describe("changing direction in the agent loop", () => {
  it("stops a withdrawn job at once, without giving the intent back (the colony already did)", async () => {
    const { journal, colony, model, deps, now } = setup();
    const running = tick(deps());
    const release = await holdModel(model, () => model.calls.length === 1);
    expect(receiveDirective(journal, directive({ kind: "withdrawal", message: "not needed any more" }), undefined, now())).toEqual({ action: "stopping the job", interrupted: true });
    colony.intents[0]!.status = "withdrawn";
    release();
    expect(await running).toEqual({ sleepMs: null }); // the step in flight was halted
    await tick(deps());
    expect(journal.history(1)[0]).toMatchObject({ intentId: "int_1", outcome: "withdrawn", reason: "intent withdrawn: not needed any more" });
    expect(colony.abandoned).toEqual([]);
    expect(colony.proposals.size).toBe(0);
    expect(colony.relays.some((n) => n.startsWith('stopped "No console.log in src/a.ts": withdrawn'))).toBe(true);
    expect(journal.counters()).toMatchObject({ withdrawn: 1 });
  });

  it("drops a model call in flight when a directive makes it moot, instead of waiting for the reply", async () => {
    const { journal, colony, model, deps, now } = setup();
    const abort = new AbortController();
    model.gate = new Promise<void>(() => undefined); // this reply never comes
    const running = tick(deps({ signal: abort.signal }));
    for (let i = 0; i < 200 && model.calls.length === 0; i++) await new Promise((r) => setTimeout(r, 0));
    expect(receiveDirective(journal, directive({ kind: "withdrawal", message: "stop" }), undefined, now()).interrupted).toBe(true);
    abort.abort(); // what AgentDO.direct does for an interrupting directive
    expect(await running).toEqual({ sleepMs: null });
    colony.intents[0]!.status = "withdrawn";
    await tick(deps());
    expect(journal.history(1)[0]).toMatchObject({ outcome: "withdrawn" });
    expect(colony.proposals.size).toBe(0);
  });

  it("restarts a revised job from the new revision, keeping its claim, and the change carries the revision", async () => {
    const { journal, colony, model, deps, now } = setup();
    const running = tick(deps());
    const release = await holdModel(model, () => model.calls.length === 1);
    // The colony amended the intent: revision 2, a new why; the agent keeps it.
    Object.assign(colony.intents[0]!, { why: "Use logger.debug, not logger.info.", revision: 2 });
    const r = receiveDirective(journal, directive({ kind: "revision", revision: 2, changed: ["why"], message: "debug level" }), colony.intents[0], now());
    expect(r).toEqual({ action: "restarting at r2", interrupted: true });
    release();
    await running;
    await tick(deps());
    expect(journal.history(1)[0]).toMatchObject({ outcome: "redirected", reason: "intent revised to r2: debug level" });
    expect(colony.abandoned).toEqual([]);
    const p = [...colony.proposals.values()][0]!;
    expect(p.intentRevision).toBe(2);
    expect(model.calls.at(-1)![1]!.content).toContain("Use logger.debug, not logger.info.");
    expect(journal.job()).toMatchObject({ step: "await", intent: { revision: 2 } });
  });

  it("re-plans a job that is producing with the guidance in its prompt", async () => {
    const { journal, colony, model, deps, now } = setup();
    const running = tick(deps());
    const release = await holdModel(model, () => model.calls.length === 1);
    expect(receiveDirective(journal, directive(), undefined, now())).toEqual({ action: "re-planning with it", interrupted: true });
    release();
    await running;
    await tick(deps());
    expect(model.calls).toHaveLength(2);
    expect(model.calls[0]![1]!.content).not.toContain("Directives from a human operator");
    expect(model.calls[1]![1]!.content).toContain("- Name the logger call logger.debug (from matt)");
    const p = [...colony.proposals.values()][0]!;
    expect(p.evidence.checks).toContainEqual(expect.objectContaining({ name: "directives", ok: true, detail: expect.stringContaining('dir_1 from matt: "Name the logger call logger.debug"') }));
    expect(journal.directives()[0]).toMatchObject({ appliedAt: expect.any(Number), outcome: "re-planned: redoing the change with it" });
  });

  it("recalls a proposal still in flight and redoes it with the guidance", async () => {
    const { journal, colony, model, deps, now } = setup();
    await tick(deps());
    const first = [...colony.proposals.values()][0]!;
    expect(journal.job()).toMatchObject({ step: "await", proposalId: first.id });
    expect(receiveDirective(journal, directive(), undefined, now())).toEqual({ action: "recalling the proposal to redo it", interrupted: false });
    await tick(deps());
    expect(colony.recalls).toEqual([first.id]);
    expect(colony.proposals.get(first.id)!.status).toBe("returned");
    expect(colony.proposals.size).toBe(2);
    expect(model.calls.at(-1)![1]!.content).toContain("Name the logger call logger.debug");
    expect(journal.job()).toMatchObject({ step: "await", proposalId: "prp_2" });
  });

  it("keeps guidance that arrives after the change was decided for later work, and goes on", async () => {
    const { journal, colony, deps, now } = setup();
    await tick(deps());
    const first = [...colony.proposals.values()][0]!;
    first.status = "landed";
    colony.intents[0]!.status = "landed";
    receiveDirective(journal, directive(), undefined, now());
    await tick(deps());
    expect(colony.recalls).toEqual([first.id]);
    expect(colony.proposals.size).toBe(1);
    expect(journal.history(1)[0]).toMatchObject({ outcome: "landed" });
    expect(journal.directives()[0]!.outcome).toMatch(/^arrived after proposing \(landed\)/);
  });

  it("turns, without retrying or abandoning, when the colony refuses a change for a revised intent", async () => {
    const { journal, colony, deps } = setup();
    colony.proposeError = new Error("[ft:409] intent revised: int_1 is at r2 (why changed: debug level); this change was built on r1. Take the intent again for r2 and redo the change.");
    await tick(deps());
    expect(journal.history(1)[0]).toMatchObject({ outcome: "redirected", reason: expect.stringMatching(/^intent revised: int_1 is at r2/) });
    expect(colony.abandoned).toEqual([]);
    expect(journal.counters().errors ?? 0).toBe(0);
  });

  it("starts the next job with guidance sent while it held none", async () => {
    const { journal, colony, model, deps, now } = setup();
    colony.intents[0]!.status = "landed";
    await tick(deps()); // nothing open: waits
    expect(receiveDirective(journal, directive({ intentId: undefined }), undefined, now())).toEqual({ action: "kept for the next job", interrupted: false });
    colony.intents.push(intent({ id: "int_2", title: "No console.log in src/b.ts", footprint: ["src/a.ts"] }));
    await tick(deps());
    expect(model.calls[0]![1]!.content).toContain("Name the logger call logger.debug");
    expect(journal.job()).toMatchObject({ intentId: "int_2", directives: [expect.objectContaining({ id: "dir_1" })] });
  });

  it("follows guidance another agent was sent about the intent it takes over (internal agents only)", async () => {
    const { colony, model, deps, journal } = setup();
    colony.intentGuidance.int_1 = [{ id: "dir_9", message: "Use logger.warn here", by: "matt", at: 5 }];
    await tick(deps());
    expect(model.calls[0]![1]!.content).toContain("- Use logger.warn here (from matt)");
    expect(journal.job()).toMatchObject({ directives: [{ id: "dir_9" }] });
    const synthetic = setup("synthetic");
    synthetic.colony.intentGuidance.int_1 = [{ id: "dir_9", message: "x", by: "m", at: 5 }];
    await tick(synthetic.deps());
    expect(synthetic.colony.guidanceCalls).toBe(0);
  });

  it("calls relay as a method: on a Durable Object stub, relay.bind would name a remote property", async () => {
    const { colony, deps } = setup();
    const send = colony.relay.bind(colony);
    colony.relay = Object.assign((agentId: string, note: string) => send(agentId, note), {
      bind: () => {
        throw new Error("RPC: no such property relay.bind");
      },
    }) as typeof colony.relay;
    await tick(deps());
    expect(colony.relays[0]).toBe('fetching trunk for "No console.log in src/a.ts"');
  });

  it("relays what it is doing as it enters a step, only when it changed and not too often", async () => {
    const { colony, deps, advance } = setup();
    let clock = 1_000_000;
    await tick(deps({ now: () => (clock += 1_500) }));
    expect(colony.relays[0]).toBe('fetching trunk for "No console.log in src/a.ts"');
    expect(colony.relays.length).toBeGreaterThan(1);
    expect(new Set(colony.relays).size).toBe(colony.relays.length);
    advance(0);
    const synthetic = setup("synthetic");
    await tick(synthetic.deps());
    expect(synthetic.colony.relays).toHaveLength(1); // synthetic agents relay at most once a minute
  });
});
