import { describe, expect, it } from "vitest";
import type { AgentInfo, Colony, ColonySnapshot, FileVersion, Id, Intent, Proposal, Rule, Sha, WorkspaceLease } from "@fire_trident/core";
import { MemoryJournal } from "../../src/agents/journal.ts";
import { FIRST_POLL_MS, agentState, stopAgent, tick } from "../../src/agents/loop.ts";
import type { AgentConfig, BaseFile, GitOps, LoopDeps, ModelClient, ModelReply } from "../../src/agents/loop.ts";
import type { ChatMessage } from "../../src/agents/prompt.ts";
import type { ReviewPreview } from "../../src/agents/preview.ts";
import type { ColonyRpc, ProposeInput, TakeResult } from "../../src/agents/rpc.ts";

const BASE = "b".repeat(40);
/** Deterministic 40-hex id (FNV-1a, five lanes); stands in for git object ids. */
const sha1 = (s: string): Sha => {
  let out = "";
  for (let k = 0; k < 5; k++) {
    let h = (0x811c9dc5 ^ Math.imul(k + 1, 0x9e3779b9)) >>> 0;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
    out += (h >>> 0).toString(16).padStart(8, "0");
  }
  return out;
};
const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

const RULE: Rule = {
  id: "rul_1",
  colonyId: "col",
  kind: "forbid-pattern",
  spec: { pattern: "console\\.log", hint: "Use logger.info." },
  description: "No console.log",
  approvedBy: "t",
  createdAt: 0,
};
const ORIGINAL = "export function f(x: number) {\n  console.log(x);\n  return x;\n}\n";
const FIXED = "export function f(x: number) {\n  logger.info(x);\n  return x;\n}\n";

function intent(over: Partial<Intent> = {}): Intent {
  return {
    id: "int_1",
    colonyId: "col",
    title: "No console.log in src/a.ts",
    why: "No console.log.\nHint: Use logger.info.\nViolation on line 2.",
    source: "rule",
    ruleId: "rul_1",
    footprint: ["src/a.ts"],
    priority: 1,
    status: "open",
    createdAt: 0,
    createdBy: "t",
    ...over,
  };
}

const LEASE: WorkspaceLease = {
  repo: { namespace: "ft-ws-1", name: "col--ws-1", remote: "https://ws.invalid/col--ws-1.git" },
  token: "fixture-workspace",
  tokenExpiresAt: Number.MAX_SAFE_INTEGER,
  baseSha: BASE,
  leasedAt: 0,
  trunk: { remote: "https://trunk.invalid/col--trunk.git", token: "fixture-trunk", sha: BASE },
};

/** A colony with just enough behavior for one agent. */
class FakeColony implements ColonyRpc {
  intents: Intent[] = [intent()];
  rule: Rule | null = RULE;
  proposals = new Map<Id, Proposal>();
  proposeCalls = 0;
  heartbeats = 0;
  abandoned: string[] = [];
  takes = 0;
  waits = 0;
  takeError: Error | null = null;
  hangAfterPropose = false;
  lease: WorkspaceLease = LEASE;
  /** What review will ask, sent with every assignment when set. */
  review: ReviewPreview | null = null;

  async getColony(): Promise<Colony | null> {
    return null;
  }
  /** Only `rules` is read (by jobs of non-rule intents, to check what they write). */
  async snapshot(): Promise<ColonySnapshot> {
    return { rules: this.rule ? [this.rule] : [] } as unknown as ColonySnapshot;
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
    this.takes++;
    if (this.takeError) throw this.takeError;
    if (this.waits > 0) {
      this.waits--;
      return { wait: true, retryInMs: 1234, reason: "no open intents" };
    }
    const held = this.intents.find((i) => i.status === "claimed" && i.assignedTo === agentId);
    const i = held ?? this.intents.find((x) => x.status === "open");
    if (!i) return { wait: true, retryInMs: 5000, reason: "no open intents" };
    i.status = "claimed";
    i.assignedTo = agentId;
    const got = this.rule ? { intent: { ...i }, lease: this.lease, rule: this.rule } : { intent: { ...i }, lease: this.lease };
    return this.review ? { ...got, review: this.review } : got;
  }
  async heartbeat(): Promise<void> {
    this.heartbeats++;
  }
  async propose(p: ProposeInput): Promise<Proposal> {
    this.proposeCalls++;
    const id = `prp_${this.proposals.size + 1}`;
    const proposal: Proposal = {
      ...p,
      id,
      status: "ready",
      createdAt: this.proposals.size,
      evidence: { checks: p.evidence?.checks ?? [], notVerified: p.evidence?.notVerified ?? "" },
    };
    this.proposals.set(id, proposal);
    const i = this.intents.find((x) => x.id === p.intentId);
    if (i) i.status = "proposed";
    if (this.hangAfterPropose) return never();
    return proposal;
  }
  async getProposal(id: Id): Promise<Proposal | null> {
    return this.proposals.get(id) ?? null;
  }
  async inbox(agentId: Id): Promise<Proposal[]> {
    return [...this.proposals.values()].filter((p) => p.agentId === agentId).reverse();
  }
  async getRule(id: Id): Promise<Rule | null> {
    return this.rule?.id === id ? this.rule : null;
  }
  async abandon(_agentId: Id, reason?: string): Promise<void> {
    this.abandoned.push(reason ?? "");
    for (const i of this.intents) if (i.status === "claimed") i.status = "open";
  }
  settle(id: Id, status: Proposal["status"], reason?: string): void {
    const p = this.proposals.get(id)!;
    p.status = status;
    if (reason) p.reason = reason;
    const i = this.intents.find((x) => x.id === p.intentId);
    if (i) i.status = status === "landed" ? "landed" : "open";
  }
}

/** Trunk files at BASE, commits computed from content (deterministic, like git). */
class FakeGit implements GitOps {
  files: Record<string, string> = { "src/a.ts": ORIGINAL, "src/b.ts": "export const b = 1;\n" };
  commits: Array<{ message: string; changes: Array<{ path: string; content: string }>; timestamp: number }> = [];
  pushes: Sha[] = [];
  pushError: Error | null = null;
  hangOnPush = false;

  async ensureBase(p: { baseSha: Sha }): Promise<{ baseSha: Sha; fallback: boolean }> {
    return { baseSha: p.baseSha, fallback: false };
  }
  async listFiles(): Promise<string[]> {
    return Object.keys(this.files);
  }
  async readFile(_base: Sha, path: string): Promise<BaseFile | null> {
    const c = this.files[path];
    return c === undefined ? null : { blob: sha1(`blob ${c}`), mode: "100644", bytes: new TextEncoder().encode(c) };
  }
  async commit(p: Parameters<GitOps["commit"]>[0]): Promise<{ headSha: Sha; writeSet: FileVersion[] }> {
    this.commits.push({ message: p.message, changes: p.changes, timestamp: p.timestamp });
    const writeSet = p.changes.map((c) => ({ path: c.path, blob: sha1(`blob ${c.content}`) }));
    return { headSha: sha1(JSON.stringify([p.baseSha, p.message, p.timestamp, writeSet])), writeSet };
  }
  async push(p: { headSha: Sha }): Promise<void> {
    if (this.hangOnPush) return never();
    if (this.pushError) throw this.pushError;
    this.pushes.push(p.headSha);
  }
}

/** Replies from a queue; records every request. */
class FakeModel implements ModelClient {
  calls: ChatMessage[][] = [];
  gate: Promise<void> | null = null;
  constructor(public replies: string[]) {}
  async complete(p: { messages: ChatMessage[] }): Promise<ModelReply> {
    this.calls.push(p.messages);
    if (this.gate) await this.gate;
    return { text: this.replies.shift() ?? "" };
  }
}

function setup(kind: "internal" | "synthetic" = "internal", replies: string[] = [`<file>\n${FIXED}</file>`]) {
  const journal = new MemoryJournal();
  const colony = new FakeColony();
  const git = new FakeGit();
  const model = new FakeModel(replies);
  let t = 1_000_000;
  const cfg: AgentConfig = { colonyId: "col", agentId: "agt_1", name: "a1", kind, model: "@cf/test/model", running: true, epoch: 1, startedAt: 0, failures: 0 };
  journal.setConfig(cfg);
  const deps = (over: Partial<LoopDeps> = {}): LoopDeps => ({ colony, git, model, journal, now: () => t, rand: () => 0.5, ...over });
  return { journal, colony, git, model, deps, advance: (ms: number) => (t += ms) };
}

describe("agent loop", () => {
  it("takes a rule intent, edits with the model, commits, pushes, proposes, and records the landing", async () => {
    const { journal, colony, git, model, deps } = setup();
    expect(await tick(deps())).toEqual({ sleepMs: FIRST_POLL_MS });

    expect(model.calls).toHaveLength(1);
    const user = model.calls[0]![1]!.content;
    expect(user).toContain("Rule: No console.log");
    expect(user).toContain(ORIGINAL);

    expect(git.commits).toHaveLength(1);
    expect(git.commits[0]!.message).toBe("No console.log in src/a.ts\n\nFT-Intent: int_1\nFT-Agent: agt_1\n");
    expect(git.commits[0]!.changes).toEqual([{ path: "src/a.ts", content: FIXED }]);
    expect(git.pushes).toHaveLength(1);

    const p = [...colony.proposals.values()][0]!;
    expect(p).toMatchObject({
      colonyId: "col",
      intentId: "int_1",
      agentId: "agt_1",
      workspace: LEASE.repo,
      baseSha: BASE,
      headSha: git.pushes[0],
      writeSet: [{ path: "src/a.ts", blob: sha1(`blob ${FIXED}`) }],
      readSet: [{ path: "src/a.ts", blob: sha1(`blob ${ORIGINAL}`) }],
      declared: { footprint: ["src/a.ts"] },
    });
    expect(p.evidence.checks).toEqual([expect.objectContaining({ name: "recheck src/a.ts", ok: true })]);
    expect(p.evidence.notVerified).toContain("@cf/test/model");
    expect(journal.job()).toMatchObject({ step: "await", proposalId: p.id });
    expect(agentState(journal.config(), journal.job())).toBe("waiting");

    // Not settled yet: the agent polls with backoff.
    expect(await tick(deps())).toEqual({ sleepMs: Math.round(FIRST_POLL_MS * 1.6) });
    colony.settle(p.id, "landed");
    const after = await tick(deps());
    expect(after.sleepMs).toBe(5000); // landed, took again, nothing open: the colony's wait hint
    expect(journal.job()).toBeNull();
    expect(journal.history(1)[0]).toMatchObject({ intentId: "int_1", outcome: "landed", proposalId: p.id, llmCalls: 1, method: "model", files: 1 });
    expect(journal.counters()).toMatchObject({ taken: 1, proposed: 1, landed: 1, llmCalls: 1, pushed: 1 });
  });

  it("synthetic agents apply the rule's replacement without a model", async () => {
    const { colony, git, model, deps } = setup("synthetic");
    colony.rule = { ...RULE, spec: { ...RULE.spec, replacement: "logger.info" } };
    await tick(deps());
    expect(model.calls).toHaveLength(0);
    expect(git.commits[0]!.changes).toEqual([{ path: "src/a.ts", content: FIXED }]);
    const p = [...colony.proposals.values()][0]!;
    expect(p.evidence.checks[0]).toMatchObject({ ok: true, detail: "1 -> 0 violations (deterministic replacement)" });
    expect(p.declared.summary).toContain("applied the rule's replacement");
  });

  it("retries once with feedback, then accepts a valid reply", async () => {
    const { colony, model, deps } = setup("internal", [`<file>\n${ORIGINAL}</file>`, `<file>\n${FIXED}</file>`]);
    await tick(deps());
    expect(model.calls).toHaveLength(2);
    expect(model.calls[1]!.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(model.calls[1]![3]!.content).toContain("src/a.ts still violates the rule on line 2");
    expect(colony.proposals.size).toBe(1);
  });

  it("shows the model the questions review will ask of the change, on every attempt, and keeps them with the job", async () => {
    const { journal, colony, model, deps } = setup("internal", [`<file>\n${ORIGINAL}</file>`, `<file>\n${FIXED}</file>`]);
    colony.review = { antibodies: [{ id: "ab_1", question: "Does this change print the user's email?" }], rules: ["Shown to external agents only."] };
    await tick(deps());
    expect(model.calls).toHaveLength(2);
    for (const call of model.calls) {
      expect(call[1]!.content).toMatch(/A person rejected changes like this before\. Review will ask these questions of your change[^\n]*\n<<<QUESTIONS [0-9a-f]{12}>>>\n- Does this change print the user's email\?\n<<<END QUESTIONS [0-9a-f]{12}>>>/);
      expect(call[1]!.content).not.toContain("Shown to external agents only.");
    }
    expect(journal.job()).toMatchObject({ step: "await", antibodies: [{ id: "ab_1", question: "Does this change print the user's email?" }] });
    expect(colony.proposals.size).toBe(1);
  });

  it("writes no review block when the take carries none", async () => {
    const { journal, model, deps } = setup();
    await tick(deps());
    expect(model.calls[0]![1]!.content).not.toContain("Review will ask");
    expect(journal.job()?.antibodies).toBeUndefined();
  });

  it("abandons after the retry also fails, and gives the intent back", async () => {
    const { journal, colony, model, deps } = setup("internal", ["no tags at all", `<file>\n${ORIGINAL}</file>`]);
    const r = await tick(deps());
    expect(r.sleepMs).toBe(3000);
    expect(model.calls).toHaveLength(2);
    expect(colony.proposals.size).toBe(0);
    expect(colony.abandoned).toHaveLength(1);
    expect(colony.abandoned[0]).toContain("still violates the rule on line 2");
    expect(colony.intents[0]!.status).toBe("open");
    expect(journal.history(1)[0]).toMatchObject({ outcome: "abandoned" });
    expect(journal.job()).toBeNull();
  });

  it("resumes after being killed mid-push without repeating the model call or the commit", async () => {
    const s = setup();
    s.git.hangOnPush = true;
    void tick(s.deps()); // the process dies while the push is in flight
    await new Promise((r) => setTimeout(r, 10));
    const killed = s.journal.job()!;
    expect(killed).toMatchObject({ step: "push", attempts: 1 });
    const head = killed.headSha;

    // A new instance with the same journal and the same (durable) clone.
    const git2 = new FakeGit();
    const model2 = new FakeModel([]);
    expect(await tick(s.deps({ git: git2, model: model2 }))).toEqual({ sleepMs: FIRST_POLL_MS });
    expect(model2.calls).toHaveLength(0);
    expect(git2.commits).toHaveLength(0);
    expect(git2.pushes).toEqual([head]);
    expect(s.colony.proposals.size).toBe(1);
    expect([...s.colony.proposals.values()][0]!.headSha).toBe(head);
  });

  it("resumes after being killed mid-produce: finished files are kept, the commit is the same", async () => {
    const s = setup();
    s.colony.intents = [intent({ id: "int_2", ruleId: undefined, source: "human", title: "Touch two files", footprint: ["src/a.ts", "src/b.ts"] })];
    s.colony.rule = null;
    s.model.replies = [`<file>\n${FIXED}</file>`];
    let release!: () => void;
    const second = new Promise<void>((r) => (release = r));
    const model = {
      calls: 0,
      async complete(p: { messages: ChatMessage[] }): Promise<ModelReply> {
        this.calls++;
        if (this.calls === 1) return { text: `<file>\n${FIXED}</file>` };
        await second; // dies during the second file
        return never();
      },
    };
    void tick(s.deps({ model }));
    await new Promise((r) => setTimeout(r, 10));
    expect(s.journal.job()).toMatchObject({ step: "produce", produced: ["src/a.ts"] });
    expect(s.journal.changes()).toEqual([{ path: "src/a.ts", content: FIXED }]);
    release();

    const model2 = new FakeModel(["<file>\nexport const b = 2;\n</file>"]);
    await tick(s.deps({ model: model2 }));
    expect(model2.calls).toHaveLength(1);
    expect(model2.calls[0]![1]!.content).toContain("Path: src/b.ts");
    expect(s.git.commits.at(-1)!.changes.map((c) => c.path)).toEqual(["src/a.ts", "src/b.ts"]);
    const p = [...s.colony.proposals.values()][0]!;
    expect(p.readSet.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("does not propose twice when killed after the colony stored the proposal", async () => {
    const s = setup();
    s.colony.hangAfterPropose = true;
    void tick(s.deps());
    await new Promise((r) => setTimeout(r, 10));
    expect(s.journal.job()).toMatchObject({ step: "propose", attempts: 1 });
    s.colony.hangAfterPropose = false;
    expect(await tick(s.deps())).toEqual({ sleepMs: FIRST_POLL_MS });
    expect(s.colony.proposeCalls).toBe(1);
    expect(s.journal.job()).toMatchObject({ step: "await", proposalId: "prp_1" });
  });

  it("sleeps for the colony's wait hint", async () => {
    const { colony, deps, journal } = setup();
    colony.waits = 1;
    expect(await tick(deps())).toEqual({ sleepMs: 1234 });
    expect(journal.counters()).toMatchObject({ waits: 1 });
  });

  it("records a returned proposal and takes the reopened intent again", async () => {
    const { colony, deps, journal, model } = setup("internal", [`<file>\n${FIXED}</file>`, `<file>\n${FIXED}</file>`]);
    await tick(deps());
    colony.settle("prp_1", "returned", "stale: src/a.ts changed on trunk since read");
    const pause = await tick(deps());
    expect(pause.sleepMs).toBe(750); // a short pause before taking again
    expect(journal.history(2).map((h) => h.outcome)).toEqual(["returned"]);
    expect(journal.history(1)[0]!.reason).toContain("stale");
    await tick(deps());
    expect(model.calls).toHaveLength(2);
    expect(colony.proposals.size).toBe(2);
  });

  it("retries a failed push with backoff, then abandons when the workspace refuses the token", async () => {
    const { colony, git, deps, journal } = setup();
    git.pushError = new Error("connection reset");
    const r = await tick(deps());
    expect(r.sleepMs).toBe(1000);
    expect(journal.job()).toMatchObject({ step: "push", attempts: 1, lastError: "connection reset" });
    git.pushError = new Error("[ft:403] push workspace: HTTP 403 Forbidden");
    await tick(deps());
    expect(colony.abandoned[0]).toContain("refused the push");
    expect(journal.job()).toBeNull();
  });

  it("abandons when the lease token expired before the push", async () => {
    const { colony, deps, journal } = setup();
    colony.lease = { ...LEASE, tokenExpiresAt: 1_000_000 + 5_000 };
    await tick(deps());
    expect(colony.abandoned[0]).toContain("expired");
    expect(journal.history(1)[0]).toMatchObject({ outcome: "abandoned" });
  });

  it("stops when the colony no longer knows the agent", async () => {
    const { colony, deps, journal } = setup();
    colony.takeError = new Error("[ft:404] unknown agent agt_1");
    expect(await tick(deps())).toEqual({ sleepMs: null });
    expect(journal.config()).toMatchObject({ running: false, stopReason: "unknown agent agt_1" });
    expect(agentState(journal.config(), null)).toBe("dead");
  });

  it("halts an in-flight step when stopped, and gives the intent back", async () => {
    const s = setup();
    let open!: () => void;
    s.model.gate = new Promise<void>((r) => (open = r));
    const running = tick(s.deps());
    await new Promise((r) => setTimeout(r, 10));
    expect(s.journal.job()).toMatchObject({ step: "produce" });
    await stopAgent(s.deps(), "test over");
    open();
    expect(await running).toEqual({ sleepMs: null });
    expect(s.journal.job()).toBeNull();
    expect(s.colony.abandoned).toEqual(["agent stopped: test over"]);
    expect(s.colony.proposals.size).toBe(0);
    expect(s.journal.config()).toMatchObject({ running: false, epoch: 2 });
  });

  it("heartbeats while a job is open", async () => {
    const s = setup();
    s.git.hangOnPush = true;
    void tick(s.deps());
    await new Promise((r) => setTimeout(r, 10));
    s.git.hangOnPush = false;
    s.advance(50_000);
    await tick(s.deps());
    expect(s.colony.heartbeats).toBe(1);
  });
});
