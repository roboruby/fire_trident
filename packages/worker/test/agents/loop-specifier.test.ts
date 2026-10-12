import { describe, expect, it } from "vitest";
import type { AgentInfo, Colony, ColonySnapshot, FileVersion, Id, Intent, Path, Proposal, Rule, Sha, WorkspaceLease } from "@fire_trident/core";
import { MemoryJournal } from "../../src/agents/journal.ts";
import { FIRST_POLL_MS, chooseParent, throttleWaitMs, tick } from "../../src/agents/loop.ts";
import type { AgentConfig, BaseFile, GitOps, Job, LoopDeps, ModelClient, ModelReply, NetStats } from "../../src/agents/loop.ts";
import type { ChatMessage } from "../../src/agents/prompt.ts";
import type { ColonyRpc, ProposeInput, TakeResult } from "../../src/agents/rpc.ts";

const B2 = "2".repeat(40);
const K1 = "1".repeat(40);
const H1 = "a".repeat(40);
const SEED = "5".repeat(40);
const sha = (s: string): Sha => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0").repeat(5);
};

const RULE: Rule = {
  id: "rul_ext",
  colonyId: "col",
  kind: "forbid-import",
  spec: { from: ["src/**/*.ts"], module: "^\\.\\.?(?:/.*)?(?<!\\.ts|\\.tsx|\\.json)$", hint: "Name the file." },
  description: "Relative imports name their file",
  approvedBy: "t",
  createdAt: 0,
};
const ORIGINAL = "import { a } from './a'\nimport { d } from './d'\n";
const FIXED = "import { a } from './a.ts'\nimport { d } from './d/index.ts'\n";

const LEASE: WorkspaceLease = {
  repo: { namespace: "ft-ws-1", name: "col--ws-1", remote: "https://ws.invalid/col--ws-1.git" },
  token: "fixture-workspace",
  tokenExpiresAt: Number.MAX_SAFE_INTEGER,
  baseSha: B2,
  leasedAt: 0,
  trunk: { remote: "https://trunk.invalid/col--trunk.git", token: "fixture-trunk", sha: B2 },
};

function intent(): Intent {
  return { id: "int_1", colonyId: "col", title: "Imports in src/x.ts", why: "", source: "rule", ruleId: RULE.id, footprint: ["src/x.ts"], priority: 1, status: "open", createdAt: 0, createdBy: "t" };
}

class Colony1 implements ColonyRpc {
  intents = [intent()];
  proposals = new Map<Id, Proposal>();
  abandoned: string[] = [];
  async getColony(): Promise<Colony | null> {
    return null;
  }
  async snapshot(): Promise<ColonySnapshot> {
    throw new Error("unused");
  }
  async addIntent(): Promise<Intent> {
    throw new Error("unused");
  }
  async registerAgent(): Promise<AgentInfo> {
    throw new Error("unused");
  }
  async registerAgents(): Promise<AgentInfo[]> {
    throw new Error("unused");
  }
  async getAgent(): Promise<AgentInfo | null> {
    return null;
  }
  async take(agentId: Id): Promise<TakeResult> {
    const i = this.intents.find((x) => x.status === "open" || (x.status === "claimed" && x.assignedTo === agentId));
    if (!i) return { wait: true, retryInMs: 5000, reason: "no open intents" };
    i.status = "claimed";
    i.assignedTo = agentId;
    return { intent: { ...i }, lease: LEASE, rule: RULE };
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
    return [...this.proposals.values()];
  }
  async getRule(): Promise<Rule | null> {
    return RULE;
  }
  async abandon(_a: Id, reason?: string): Promise<void> {
    this.abandoned.push(reason ?? "");
    for (const i of this.intents) if (i.status === "claimed") i.status = "open";
  }
}

/** Trunk at B2 and K1 (same files), the workspace at `tip`; records commits and pushes. */
class Git2 implements GitOps {
  files: Record<string, string> = { "src/x.ts": ORIGINAL, "src/a.ts": "", "src/d/index.ts": "" };
  /** Blobs that differ at K1 (to test the fallback). */
  k1Diff: Record<Path, Sha> = {};
  tip: Sha | null = H1;
  local = new Map<Sha, { parents: Sha[]; byAgent: boolean }>([
    [B2, { parents: [], byAgent: false }],
    [K1, { parents: [], byAgent: false }],
    [H1, { parents: [K1], byAgent: true }],
  ]);
  servedByTrunk = new Set<Sha>([SEED]);
  commits: Array<{ baseSha: Sha }> = [];
  pushes: Sha[] = [];
  net: NetStats = { requests: 0, sentBytes: 0, receivedBytes: 0, ms: 0 };

  async ensureBase(p: { baseSha: Sha }): Promise<{ baseSha: Sha; fallback: boolean }> {
    this.net.requests++;
    this.net.receivedBytes += 1000;
    return { baseSha: p.baseSha, fallback: false };
  }
  async listFiles(): Promise<string[]> {
    return Object.keys(this.files);
  }
  async readFile(_b: Sha, path: string): Promise<BaseFile | null> {
    const c = this.files[path];
    return c === undefined ? null : { blob: sha(c), mode: "100644", bytes: new TextEncoder().encode(c) };
  }
  async commit(p: Parameters<GitOps["commit"]>[0]): Promise<{ headSha: Sha; writeSet: FileVersion[] }> {
    this.commits.push({ baseSha: p.baseSha });
    const writeSet = p.changes.map((c) => ({ path: c.path, blob: sha(c.content) }));
    return { headSha: sha(JSON.stringify([p.baseSha, writeSet])), writeSet };
  }
  async push(p: { headSha: Sha }): Promise<void> {
    this.net.requests += 2;
    this.net.sentBytes += 900;
    this.pushes.push(p.headSha);
  }
  async remoteHead(): Promise<Sha | null> {
    this.net.requests++;
    return this.tip;
  }
  async fetchCommit(p: { sha: Sha }): Promise<boolean> {
    if (!this.servedByTrunk.has(p.sha)) return false;
    this.local.set(p.sha, { parents: [], byAgent: false });
    return true;
  }
  async commitInfo(s: Sha): Promise<{ parents: Sha[]; byAgent: boolean } | null> {
    return this.local.get(s) ?? null;
  }
  async blobsAt(s: Sha, paths: Path[]): Promise<Map<Path, Sha | null>> {
    return new Map(paths.map((p) => [p, s === K1 && this.k1Diff[p] ? this.k1Diff[p]! : this.files[p] === undefined ? null : sha(this.files[p]!)]));
  }
  takeNetStats(): NetStats {
    const out = { ...this.net };
    this.net = { requests: 0, sentBytes: 0, receivedBytes: 0, ms: 0 };
    return out;
  }
}

class Model1 implements ModelClient {
  calls: ChatMessage[][] = [];
  throttleFirst = 0;
  constructor(public replies: string[]) {}
  async complete(p: { messages: ChatMessage[] }): Promise<ModelReply> {
    if (this.throttleFirst > 0) {
      this.throttleFirst--;
      throw new Error("[ft:429] model m is throttled: rate limiting");
    }
    this.calls.push(p.messages);
    return { text: this.replies.shift() ?? "", usage: { input: 700, output: 50, cached: 0, neurons: 1.5 }, ms: 1200 };
  }
}

function setup(replies: string[]) {
  const journal = new MemoryJournal();
  const colony = new Colony1();
  const git = new Git2();
  const model = new Model1(replies);
  const metrics: Array<Record<string, unknown>> = [];
  const cfg: AgentConfig = { colonyId: "col", agentId: "agt_1", name: "a1", kind: "internal", model: "@cf/test/m", running: true, epoch: 1, startedAt: 0, failures: 0 };
  journal.setConfig(cfg);
  const deps = (over: Partial<LoopDeps> = {}): LoopDeps => ({ colony, git, model, journal, now: () => 1_000_000, rand: () => 0.5, metric: (r) => metrics.push(r), ...over });
  return { journal, colony, git, model, deps, metrics };
}

const GOOD = "<edits>\n1: ./a => ./a.ts\n2: ./d => ./d/index.ts\n</edits>";

describe("agent loop: import rules and cheap pushes", () => {
  it("asks for specifier edits with the tree as context and proposes on the workspace's last base", async () => {
    const s = setup([GOOD]);
    expect(await tick(s.deps())).toEqual({ sleepMs: FIRST_POLL_MS });
    expect(s.model.calls).toHaveLength(1);
    const user = s.model.calls[0]![1]!.content;
    expect(user).toContain(`"./d" resolves to "./d/index.ts" (src/d is a directory, so the import names its index file)`);
    expect(user).toContain("src/d/: index.ts");
    // Built on K1, the base behind the agent's last push to this workspace.
    expect(s.git.commits).toEqual([{ baseSha: K1 }]);
    const p = [...s.colony.proposals.values()][0]!;
    expect(p.baseSha).toBe(K1);
    expect(p.readSet).toEqual([{ path: "src/x.ts", blob: sha(ORIGINAL) }]);
    expect(p.writeSet).toEqual([{ path: "src/x.ts", blob: sha(FIXED) }]);
    expect(p.evidence.checks.map((c) => c.name)).toEqual(["recheck src/x.ts", "agent model usage", "agent git transfer"]);
    expect(p.evidence.checks[2]!.detail).toBe("fetch 1.0 KB down; workspace probe 1 request(s); push 0.9 KB up; built on base of the workspace's last push");
    expect(p.evidence.notVerified).toContain(`Built on trunk ${K1}`);
    expect(p.evidence.notVerified).toMatch(/^No tests, type checks or builds were run\. Checked by the agent against the trunk tree: the rule reports 0 violations .*; directories name their index file: \.\/d -> \.\/d\/index\.ts\. Edited by model/);
  });

  it("retries once with the problems, then abandons", async () => {
    const s = setup(["<edits>\n2: ./d => ./d.ts\n</edits>", "nothing"]);
    await tick(s.deps());
    expect(s.model.calls).toHaveLength(2);
    expect(s.model.calls[1]![3]!.content).toContain(`line 2: "./d.ts" names no file in the trunk tree (existing: "./d/index.ts")`);
    expect(s.colony.abandoned[0]).toContain("the reply has no <edits>");
    expect(s.metrics[0]).toMatchObject({ outcome: "abandoned", calls: 2, tokensIn: 1400, tokensOut: 100 });
  });

  it("waits out a throttled model without spending its attempts", async () => {
    const s = setup([GOOD]);
    s.model.throttleFirst = 5;
    for (let i = 1; i <= 5; i++) {
      const r = await tick(s.deps());
      expect(r.sleepMs).toBe(throttleWaitMs(i, () => 0.5));
      expect(s.journal.job()).toMatchObject({ step: "produce", attempts: 0, throttled: i });
    }
    expect(await tick(s.deps())).toEqual({ sleepMs: FIRST_POLL_MS });
    expect(s.journal.counters()).toMatchObject({ throttled: 5, proposed: 1 });
  });
});

describe("agent loop: reusing the workspace's base instead of fetching", () => {
  it("skips the lease-base fetch when the workspace base matches current trunk on the footprint", async () => {
    const s = setup([GOOD]);
    const bases: Sha[] = [];
    const ensure = s.git.ensureBase.bind(s.git);
    s.git.ensureBase = async (p) => {
      bases.push(p.baseSha);
      return ensure(p);
    };
    const trunk = { blobsFor: async (paths: Path[]) => Object.fromEntries(paths.map((p) => [p, sha(ORIGINAL)])) };
    expect(await tick(s.deps({ trunk }))).toEqual({ sleepMs: FIRST_POLL_MS });
    expect(bases).toEqual([K1]); // only the commit step's local check; never the lease base B2
    const p = [...s.colony.proposals.values()][0]!;
    expect(p.baseSha).toBe(K1);
    expect(p.evidence.notVerified).toContain(`Based on trunk ${K1}, which the workspace already held`);
  });

  it("fetches a fresh workspace's seed instead of the lease base", async () => {
    const s = setup([GOOD]);
    s.git.tip = SEED;
    const bases: Sha[] = [];
    const ensure = s.git.ensureBase.bind(s.git);
    s.git.ensureBase = async (p) => {
      bases.push(p.baseSha);
      return ensure(p);
    };
    const trunk = { blobsFor: async (paths: Path[]) => Object.fromEntries(paths.map((p) => [p, sha(ORIGINAL)])) };
    await tick(s.deps({ trunk }));
    expect(s.git.local.has(SEED)).toBe(true);
    expect(bases).toEqual([SEED]);
    expect([...s.colony.proposals.values()][0]!.baseSha).toBe(SEED);
  });

  it("fetches the lease base when the footprint changed on trunk since the workspace's base", async () => {
    const s = setup([GOOD]);
    const bases: Sha[] = [];
    const ensure = s.git.ensureBase.bind(s.git);
    s.git.ensureBase = async (p) => {
      bases.push(p.baseSha);
      return ensure(p);
    };
    const trunk = { blobsFor: async (paths: Path[]) => Object.fromEntries(paths.map((p) => [p, "e".repeat(40)])) };
    await tick(s.deps({ trunk }));
    expect(bases[0]).toBe(B2);
  });
});

describe("chooseParent", () => {
  const job = (): Job =>
    ({ intentId: "int_1", intent: intent(), lease: LEASE, rule: RULE, step: "commit", attempts: 1, takenAt: 0, stepStartedAt: 0, baseSha: B2, llmCalls: 0, lastHeartbeatAt: 0 }) as Job;
  const paths = ["src/x.ts"];

  it("uses a fresh workspace's seed commit, fetched from trunk", async () => {
    const git = new Git2();
    git.tip = SEED;
    expect(await chooseParent({ git }, job(), paths)).toEqual({ parent: SEED, how: "workspace tip" });
  });

  it("falls back to the lease base when the files differ, the tip is unknown, or nothing can be probed", async () => {
    const git = new Git2();
    git.k1Diff = { "src/x.ts": "f".repeat(40) };
    expect((await chooseParent({ git }, job(), paths)).parent).toBe(B2);
    const g2 = new Git2();
    g2.tip = "9".repeat(40);
    expect(await chooseParent({ git: g2 }, job(), paths)).toEqual({ parent: B2, how: "lease base (workspace tip unknown)" });
    const g3 = new Git2();
    g3.tip = B2;
    expect((await chooseParent({ git: g3 }, job(), paths)).how).toBe("lease base (workspace at base)");
    const bare: GitOps = { ensureBase: g3.ensureBase, listFiles: g3.listFiles, readFile: g3.readFile, commit: g3.commit, push: g3.push };
    expect(await chooseParent({ git: bare }, job(), paths)).toEqual({ parent: B2, how: "lease base" });
  });
});
