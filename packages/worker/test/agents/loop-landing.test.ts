import { describe, expect, it } from "vitest";
import type { AgentInfo, Colony, ColonySnapshot, Directive, EscalationKind, FileVersion, Id, Intent, IntentEscalation, Path, Proposal, Rule, Sha, WorkspaceLease } from "@fire_trident/core";
import { MemoryJournal } from "../../src/agents/journal.ts";
import { MAX_REBASES, receiveDirective, tick } from "../../src/agents/loop.ts";
import type { AgentConfig, BaseFile, GitOps, LoopDeps, ModelClient, ModelReply } from "../../src/agents/loop.ts";
import type { LandedWhy } from "../../src/agents/landed.ts";
import type { ChatMessage } from "../../src/agents/prompt.ts";
import type { ColonyRpc, ProposeInput, TakeResult } from "../../src/agents/rpc.ts";

/**
 * The agent loop and what landed on its files: the take's why-context goes into its prompts, a
 * landing notice before it proposes makes it re-read on the trunk tip, and a model that finds the
 * intent cannot be done as written reports it to a person instead of writing a file.
 */

const BASE = "a".repeat(40);
const TIP = "c".repeat(40);
const sha1 = (s: string): Sha => {
  let out = "";
  for (let k = 0; k < 5; k++) {
    let h = (0x811c9dc5 ^ Math.imul(k + 1, 0x9e3779b9)) >>> 0;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
    out += (h >>> 0).toString(16).padStart(8, "0");
  }
  return out;
};

const OLD = "export function f() {\n  return 1;\n}\n";
const NEW = "export function f() {\n  return 1;\n}\nexport const g = 2;\n";
const WRITTEN = "export function f() {\n  return 3;\n}\nexport const g = 2;\n";

const LEASE: WorkspaceLease = {
  repo: { namespace: "ft-ws-1", name: "col--ws-1", remote: "https://ws.invalid/col--ws-1.git" },
  token: "fixture-workspace",
  tokenExpiresAt: Number.MAX_SAFE_INTEGER,
  baseSha: BASE,
  leasedAt: 0,
  trunk: { remote: "https://trunk.invalid/col--trunk.git", token: "fixture-trunk", sha: BASE },
};

const CONTEXT: LandedWhy[] = [{ landingId: "lnd_1", at: Date.UTC(2026, 9, 13, 9), trunkSha: BASE, intentId: "int_0", title: "Add f", why: "f is the entry point", paths: ["src/a.ts"] }];

function intent(): Intent {
  return { id: "int_1", colonyId: "col", title: "Make f return 3", why: "Callers need 3.", source: "human", footprint: ["src/a.ts"], priority: 1, status: "open", createdAt: 0, createdBy: "t" };
}

class FakeColony implements ColonyRpc {
  intents: Intent[] = [intent()];
  proposals = new Map<Id, Proposal>();
  abandoned: string[] = [];
  relays: string[] = [];
  escalations: Array<{ agentId: Id; intentId?: Id; kind: EscalationKind; report: string }> = [];
  escalateError: Error | null = null;
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
    const i = this.intents.find((x) => (x.status === "claimed" && x.assignedTo === agentId) || x.status === "open");
    if (!i) return { wait: true, retryInMs: 5000, reason: "no open intents" };
    i.status = "claimed";
    i.assignedTo = agentId;
    return { intent: { ...i }, lease: LEASE, context: CONTEXT };
  }
  async heartbeat(): Promise<void> {}
  async propose(p: ProposeInput): Promise<Proposal> {
    const id = `prp_${this.proposals.size + 1}`;
    const proposal: Proposal = { ...p, id, status: "ready", createdAt: 0, evidence: { checks: p.evidence?.checks ?? [], notVerified: p.evidence?.notVerified ?? "" } };
    this.proposals.set(id, proposal);
    return proposal;
  }
  async getProposal(id: Id): Promise<Proposal | null> {
    return this.proposals.get(id) ?? null;
  }
  async inbox(): Promise<Proposal[]> {
    return [];
  }
  async getRule(): Promise<Rule | null> {
    return null;
  }
  async abandon(_agentId: Id, reason?: string): Promise<void> {
    this.abandoned.push(reason ?? "");
    for (const i of this.intents) if (i.status === "claimed") i.status = "open";
  }
  async relay(_agentId: Id, note: string): Promise<unknown> {
    this.relays.push(note);
    return {};
  }
  async escalate(agentId: Id, p: { intentId?: Id; kind: EscalationKind; report: string }): Promise<{ intent: Intent; escalation: IntentEscalation }> {
    if (this.escalateError) throw this.escalateError;
    this.escalations.push({ agentId, ...p });
    const i = this.intents.find((x) => x.id === p.intentId)!;
    i.status = "open";
    delete i.assignedTo;
    const escalation: IntentEscalation = { kind: p.kind, report: p.report, by: agentId, at: 1 };
    i.escalation = escalation;
    return { intent: { ...i }, escalation };
  }
}

/** Trunk at two commits: the lease base, and the tip after another agent's landing changed src/a.ts. */
class FakeGit implements GitOps {
  tips = 0;
  reads: Array<{ base: Sha; path: Path }> = [];
  commits: Array<{ baseSha: Sha; changes: Array<{ path: string; content: string }> }> = [];
  trees: Record<Sha, Record<Path, string>> = { [BASE]: { "src/a.ts": OLD }, [TIP]: { "src/a.ts": NEW } };
  async ensureBase(p: { baseSha: Sha }): Promise<{ baseSha: Sha; fallback: boolean }> {
    return { baseSha: p.baseSha, fallback: false };
  }
  async fetchTip(): Promise<Sha | null> {
    this.tips++;
    return TIP;
  }
  async listFiles(base: Sha): Promise<string[]> {
    return Object.keys(this.trees[base] ?? {});
  }
  async readFile(base: Sha, path: string): Promise<BaseFile | null> {
    this.reads.push({ base, path });
    const c = this.trees[base]?.[path];
    return c === undefined ? null : { blob: sha1(`blob ${c}`), mode: "100644", bytes: new TextEncoder().encode(c) };
  }
  async commit(p: Parameters<GitOps["commit"]>[0]): Promise<{ headSha: Sha; writeSet: FileVersion[] }> {
    this.commits.push({ baseSha: p.baseSha, changes: p.changes });
    const writeSet = p.changes.map((c) => ({ path: c.path, blob: sha1(`blob ${c.content}`) }));
    return { headSha: sha1(JSON.stringify([p.baseSha, writeSet])), writeSet };
  }
  async push(): Promise<void> {}
}

class FakeModel implements ModelClient {
  calls: ChatMessage[][] = [];
  gate: Promise<void> | null = null;
  constructor(public replies: string[]) {}
  async complete(p: { messages: ChatMessage[] }): Promise<ModelReply> {
    this.calls.push(p.messages);
    const gate = this.gate;
    this.gate = null;
    if (gate) await gate;
    return { text: this.replies.shift() ?? `<file>\n${WRITTEN}</file>` };
  }
}

function setup(replies: string[] = []) {
  const journal = new MemoryJournal();
  const colony = new FakeColony();
  const git = new FakeGit();
  const model = new FakeModel(replies);
  let t = 1_000_000;
  const cfg: AgentConfig = { colonyId: "col", agentId: "agt_1", name: "a1", kind: "internal", model: "@cf/test/model", running: true, epoch: 1, startedAt: 0, failures: 0 };
  journal.setConfig(cfg);
  const deps = (over: Partial<LoopDeps> = {}): LoopDeps => ({ colony, git, model, journal, now: () => t, rand: () => 0.5, ...over });
  return { journal, colony, git, model, deps, now: () => t, advance: (ms: number) => (t += ms) };
}

const user = (m: ChatMessage[]): string => m.find((x) => x.role === "user")?.content ?? "";

const notice = (over: Partial<Directive> = {}): Directive => ({
  id: "dir_9",
  colonyId: "col",
  agentId: "agt_1",
  kind: "landing",
  intentId: "int_1",
  message: "Landing lnd_9 (trunk ccccccc) changed src/a.ts",
  by: "colony",
  at: Date.UTC(2026, 9, 13, 11),
  landing: { landingId: "lnd_9", trunkSha: TIP, paths: [{ path: "src/a.ts", before: sha1(`blob ${OLD}`), after: sha1(`blob ${NEW}`) }], intentTitle: "Add g", why: "g is needed by the router" },
  ...over,
});

/** Hold the next model call until the returned function is called; resolves once the call started. */
async function holdModel(model: FakeModel, started: () => boolean): Promise<() => void> {
  let release!: () => void;
  model.gate = new Promise<void>((r) => (release = r));
  for (let i = 0; i < 200 && !started(); i++) await new Promise((r) => setTimeout(r, 0));
  return release;
}

describe("why-context in the agent loop", () => {
  it("writes with the take's latest landings on its files in the prompt", async () => {
    const s = setup();
    await tick(s.deps());
    const prompt = user(s.model.calls[0]!);
    expect(prompt).toContain("Why this code is the way it is");
    expect(prompt).toContain('landing lnd_1 aaaaaaa changed src/a.ts for "Add f": f is the entry point');
    expect(s.colony.proposals.size).toBe(1);
  });
});

describe("landing notices in the agent loop", () => {
  it("restarts a job that has not proposed on the trunk tip, re-reads the changed file, and says so in the evidence", async () => {
    const s = setup();
    const running = tick(s.deps());
    const release = await holdModel(s.model, () => s.model.calls.length === 1);
    expect(receiveDirective(s.journal, notice(), undefined, s.now())).toEqual({ action: "re-reading the changed files on the new trunk", interrupted: true });
    release();
    expect(await running).toEqual({ sleepMs: null }); // the write in flight was halted
    expect(s.colony.proposals.size).toBe(0);

    await tick(s.deps());
    expect(s.git.tips).toBe(1);
    expect(s.git.reads.filter((r) => r.path === "src/a.ts").map((r) => r.base)).toEqual([BASE, BASE, TIP, TIP]);
    // The second write sees the new content, and why it changed.
    const prompt = user(s.model.calls[1]!);
    expect(prompt).toContain("export const g = 2;");
    expect(prompt).toContain('landing lnd_9 ccccccc changed src/a.ts for "Add g": g is needed by the router');
    expect(prompt.indexOf("lnd_9")).toBeLessThan(prompt.indexOf("lnd_1"));
    const p = [...s.colony.proposals.values()][0]!;
    expect(p.baseSha).toBe(TIP);
    expect(p.readSet).toEqual([{ path: "src/a.ts", blob: sha1(`blob ${NEW}`) }]);
    expect(p.evidence.notVerified).toContain(`Rebased on trunk ${TIP} after landing lnd_9 changed files it covers`);
    expect(s.git.commits[0]!.baseSha).toBe(TIP);
    expect(s.journal.directives().find((h) => h.directive.id === "dir_9")).toMatchObject({ outcome: "re-reading the changed files on the new trunk" });
    expect(s.colony.relays.some((n) => n.startsWith("src/a.ts changed on trunk (lnd_9): re-reading them on the new trunk"))).toBe(true);
  });

  it("does nothing once the change is proposed: the lane checks it against trunk", async () => {
    const s = setup();
    await tick(s.deps());
    expect(s.journal.job()).toMatchObject({ step: "await" });
    expect(receiveDirective(s.journal, notice(), undefined, s.now())).toEqual({ action: "noted: the change is already proposed (the lane checks it against trunk)", interrupted: false });
    await tick(s.deps());
    expect(s.journal.job()).toMatchObject({ step: "await" });
    expect(s.model.calls).toHaveLength(1);
    expect(s.git.tips).toBe(0);
    expect(s.journal.directives()[0]).toMatchObject({ outcome: "already proposed: the lane checks the change against trunk" });
  });

  it("starts over at most MAX_REBASES times, then leaves staleness to the lane", async () => {
    const s = setup();
    const running = tick(s.deps());
    const release = await holdModel(s.model, () => s.model.calls.length === 1);
    receiveDirective(s.journal, notice(), undefined, s.now());
    const job = s.journal.job()!;
    s.journal.setJob({ ...job, rebases: MAX_REBASES });
    release();
    await running;
    await tick(s.deps());
    expect(s.git.tips).toBe(0);
    expect(s.journal.directives()[0]).toMatchObject({ outcome: `noted: the job already started over ${MAX_REBASES} times; the lane checks the change against trunk` });
    expect([...s.colony.proposals.values()][0]?.baseSha).toBe(BASE);
  });

  it("leaves alone a notice from before the take, and one about another intent", async () => {
    const s = setup();
    // Received with no job: the take that follows leases a trunk that already has the landing.
    expect(receiveDirective(s.journal, notice({ id: "dir_0" }), undefined, s.now())).toEqual({ action: "noted (no job held)", interrupted: false });
    s.advance(1_000);
    await tick(s.deps());
    expect(s.journal.job()).toMatchObject({ step: "await" });
    expect(s.journal.directives().find((h) => h.directive.id === "dir_0")).toMatchObject({ outcome: "noted: the job was taken after it, on a trunk that has the landing" });
    expect(receiveDirective(s.journal, notice({ intentId: "int_other" }), undefined, s.now())).toEqual({ action: "noted (not the current job)", interrupted: false });
    await tick(s.deps());
    expect(s.journal.directives().find((h) => h.directive.id === "dir_9")?.appliedAt).toBeUndefined();
    expect(s.git.tips).toBe(0);
  });
});

describe("escalating instead of writing", () => {
  const REPLY = "ESCALATE broken-test: test/a.test.ts expects f() to return 4, the intent says 3";

  it("reports the intent to a person and ends the job, with no proposal and no release", async () => {
    const s = setup([REPLY]);
    await tick(s.deps());
    expect(s.colony.escalations).toEqual([{ agentId: "agt_1", intentId: "int_1", kind: "broken-test", report: "test/a.test.ts expects f() to return 4, the intent says 3" }]);
    expect(s.colony.proposals.size).toBe(0);
    expect(s.colony.abandoned).toEqual([]);
    expect(s.journal.job()).toBeNull();
    expect(s.journal.history(1)[0]).toMatchObject({ intentId: "int_1", outcome: "escalated", reason: "escalated (broken-test): test/a.test.ts expects f() to return 4, the intent says 3" });
    expect(s.journal.counters()).toMatchObject({ escalated: 1 });
    expect(s.colony.relays).toContain('escalated "Make f return 3" to a person (broken-test)');
  });

  it("gives the intent back with the report when the colony cannot take it", async () => {
    const s = setup([REPLY]);
    s.colony.escalateError = new Error("[ft:409] intent int_1 already has a report waiting for a person");
    await tick(s.deps());
    expect(s.colony.abandoned).toEqual(["could not report it to a person, so the intent goes back: escalated (broken-test): test/a.test.ts expects f() to return 4, the intent says 3"]);
    expect(s.journal.history(1)[0]).toMatchObject({ outcome: "abandoned" });
  });
});
