import { describe, expect, it } from "vitest";
import type { AgentInfo, Colony, FieldReading, Id, Intent, Proposal, ProposalStatus, Rule, WorkspaceLease } from "@fire_trident/core";
import type { ProposeInput, TakeResult } from "../../src/agents/rpc.ts";
import { EXTERNAL_NOT_VERIFIED, FireTridentTools, HEARTBEAT_EVERY_MS, MAX_WAIT_S } from "../../src/mcp/tools.ts";
import type { McpColonyRpc, RepoReader, Session, ToolContext } from "../../src/mcp/tools.ts";
import type { TreeEntryLike } from "../../src/mcp/gitread.ts";

const sha = (c: string): string => c.repeat(40).slice(0, 40);
const BASE = sha("b");

const colonyInfo: Colony = {
  id: "col",
  name: "Colony",
  trunk: { namespace: "ft-trunk", name: "col--trunk", remote: "https://trunk.invalid/col--trunk.git" },
  trunkSha: BASE,
  createdAt: 0,
  regionDepth: 1,
};

const lease: WorkspaceLease = {
  repo: { namespace: "ft-ws-2", name: "col--ws-2", remote: "https://ws.invalid/col--ws-2.git" },
  token: "fixture-workspace",
  tokenExpiresAt: Date.UTC(2030, 0, 1),
  baseSha: BASE,
  leasedAt: 0,
  trunk: { remote: colonyInfo.trunk.remote, token: "fixture-trunk", sha: BASE },
};

const theIntent: Intent = {
  id: "int_1",
  colonyId: "col",
  title: "Rename helper",
  why: "Clarity",
  source: "human",
  footprint: ["src/lib/util.ts"],
  priority: 1,
  status: "claimed",
  createdAt: 0,
  createdBy: "t",
};

/** One repo's objects: commits, trees and blobs. */
class Objects {
  commits = new Map<string, { hash: string; treeHash: string; parents: string[] }>();
  trees = new Map<string, TreeEntryLike[]>();
  blobs = new Map<string, string>();
  reader(): RepoReader & { released: number } {
    const self = this;
    return {
      released: 0,
      readCommit: async (h) => self.commits.get(h) ?? null,
      readTree: async (h) => self.trees.get(h) ?? null,
      readBlob: async (h) => {
        const b = self.blobs.get(h);
        return b === undefined ? null : { arrayBuffer: async () => new TextEncoder().encode(b).buffer as ArrayBuffer };
      },
      release() {
        this.released++;
      },
    };
  }
}

/** base: src/lib/util.ts (u1), README.md (r1). head1 (on base): util -> u2, adds src/new.ts. stray: unrelated root commit. */
function repos() {
  const trunk = new Objects();
  const ws = new Objects();
  for (const o of [trunk, ws]) {
    o.trees.set(sha("1"), [
      { name: "README.md", mode: "100644", hash: sha("e"), type: "blob" },
      { name: "src", mode: "40000", hash: sha("2"), type: "tree" },
    ]);
    o.trees.set(sha("2"), [{ name: "lib", mode: "40000", hash: sha("3"), type: "tree" }]);
    o.trees.set(sha("3"), [{ name: "util.ts", mode: "100644", hash: sha("a"), type: "blob" }]);
    o.commits.set(BASE, { hash: BASE, treeHash: sha("1"), parents: [] });
    o.blobs.set(sha("a"), "export const helper = 1;\n");
    o.blobs.set(sha("e"), "# readme\n");
  }
  ws.trees.set(sha("4"), [
    { name: "README.md", mode: "100644", hash: sha("e"), type: "blob" },
    { name: "src", mode: "40000", hash: sha("5"), type: "tree" },
  ]);
  ws.trees.set(sha("5"), [
    { name: "lib", mode: "40000", hash: sha("6"), type: "tree" },
    { name: "new.ts", mode: "100644", hash: sha("f"), type: "blob" },
  ]);
  ws.trees.set(sha("6"), [{ name: "util.ts", mode: "100644", hash: sha("7"), type: "blob" }]);
  ws.commits.set(sha("c"), { hash: sha("c"), treeHash: sha("4"), parents: [BASE] });
  ws.commits.set(sha("d"), { hash: sha("d"), treeHash: sha("4"), parents: [] });
  return { trunk, ws };
}

class FakeColony implements Partial<McpColonyRpc> {
  agents: AgentInfo[] = [];
  proposals: ProposeInput[] = [];
  intents: Array<Omit<Intent, "id" | "status" | "createdAt">> = [];
  heartbeats: Id[] = [];
  abandoned: Array<{ agentId: Id; reason?: string }> = [];
  takes = 0;
  /** Takes answered with wait before work appears. */
  waitsBeforeWork = 0;
  regions = ["src", "."];
  /** Statuses getProposal walks through, one per call (the last repeats). */
  statuses: ProposalStatus[] = ["ready"];
  statusCalls = 0;
  async getColony(): Promise<Colony | null> {
    return colonyInfo;
  }
  async getAgent(id: Id): Promise<AgentInfo | null> {
    return this.agents.find((a) => a.id === id) ?? null;
  }
  async registerAgent(a: { kind: AgentInfo["kind"]; name: string; model?: string }): Promise<AgentInfo> {
    const info: AgentInfo = { id: `agt_${this.agents.length + 1}`, colonyId: "col", kind: a.kind, name: a.name, thresholds: {}, state: "idle", lastSeen: 0 };
    this.agents.push(info);
    return info;
  }
  /** When set, the first heartbeat waits for it (a slow heartbeat racing other tool calls). */
  firstHeartbeatGate: Promise<void> | null = null;
  async heartbeat(agentId: Id): Promise<void> {
    this.heartbeats.push(agentId);
    if (this.firstHeartbeatGate && this.heartbeats.length === 1) await this.firstHeartbeatGate;
  }
  async listRegions(): Promise<string[]> {
    return this.regions;
  }
  async take(): Promise<TakeResult> {
    this.takes++;
    if (this.takes <= this.waitsBeforeWork) return { wait: true, retryInMs: 5_000, reason: "no open intents" };
    const rule: Rule = { id: "rul_1", colonyId: "col", kind: "forbid-pattern", spec: { pattern: "x", hint: "h" }, description: "d", approvedBy: "t", createdAt: 0 };
    return { intent: theIntent, lease, rule };
  }
  async propose(p: ProposeInput): Promise<Proposal> {
    this.proposals.push(p);
    return { ...p, id: "prp_1", status: "checking", createdAt: 0, evidence: { checks: [], residual: ["src/new.ts"], notVerified: "n" } };
  }
  async getProposal(id: Id): Promise<Proposal | null> {
    const p = this.proposals[0];
    if (!p || id !== "prp_1") return null;
    const status = this.statuses[Math.min(this.statusCalls++, this.statuses.length - 1)] ?? "ready";
    return { ...p, id, status, createdAt: 0, evidence: { checks: [] }, ...(status === "landed" ? { landingId: "lnd_1" } : {}) };
  }
  async inbox(): Promise<Proposal[]> {
    return [];
  }
  async addIntent(i: Omit<Intent, "id" | "status" | "createdAt">): Promise<Intent> {
    this.intents.push(i);
    return { ...i, id: "int_2", status: "open", createdAt: 0 };
  }
  async abandon(agentId: Id, reason?: string): Promise<void> {
    this.abandoned.push({ agentId, ...(reason !== undefined ? { reason } : {}) });
  }
}

function setup() {
  const colony = new FakeColony();
  const { trunk, ws } = repos();
  let session: Session = { reads: {}, proposals: [] };
  const readings: Array<{ region: string; opts: unknown }> = [];
  const clock = { now: 1_000_000, slept: 0 };
  const ctx: ToolContext = {
    colony: () => colony as unknown as McpColonyRpc,
    region: (_c, region) => ({
      reading: async (opts) => {
        readings.push({ region, opts });
        return { region, at: 0, totals: { claim: 1.23456, need: 0, trail: 0, failure: 0, danger: 0 }, byPath: {}, agents: [], sigma: 0.5, admission: { open: true, landingsPerMin: 0, activeAgents: 1 } } as FieldReading;
      },
    }),
    trunk: () => ({ why: async () => [] }),
    repo: async (ref) => (ref.namespace === "ft-trunk" ? trunk.reader() : ws.reader()),
    load: async () => structuredClone(session),
    save: async (s) => {
      session = structuredClone(s);
    },
    now: () => clock.now,
    sleep: async (ms) => {
      clock.now += ms;
      clock.slept += ms;
    },
  };
  return { tools: new FireTridentTools(ctx), colony, session: () => session, readings, ws, clock };
}

describe("MCP tools", () => {
  it("requires join before anything else", async () => {
    const { tools } = setup();
    await expect(tools.take()).rejects.toThrow(/call join first/);
  });

  it("joins as an external agent, and resumes the same agent in the same session", async () => {
    const { tools, colony } = setup();
    expect(await tools.join({ colony: "col", name: "laptop" })).toMatchObject({ agentId: "agt_1", resumed: false, colony: { id: "col", regionDepth: 1 } });
    expect(colony.agents[0]).toMatchObject({ kind: "external", name: "laptop" });
    expect(await tools.join({ colony: " COL " })).toMatchObject({ agentId: "agt_1", resumed: true });
    expect(colony.agents).toHaveLength(1);
    await expect(tools.join({ colony: "col", agentId: "agt_404" })).rejects.toThrow(/no external agent/);
  });

  it("join refuses ids that cannot name a colony", async () => {
    const { tools } = setup();
    await expect(tools.join({ colony: "../col" })).rejects.toThrow(/lowercase slugs/);
    await expect(tools.join({ colony: "a b" })).rejects.toThrow(/lowercase slugs/);
  });

  it("take returns the lease, both tokens and self-contained git commands that use them", async () => {
    const { tools } = setup();
    await tools.join({ colony: "col" });
    const t = (await tools.take()) as Record<string, any>;
    expect(t.tokens).toEqual({ trunkRead: "fixture-trunk", workspaceWrite: "fixture-workspace" });
    expect(t.lease).toMatchObject({ baseSha: BASE, workspace: { remote: lease.repo.remote } });
    expect(JSON.stringify(t.lease)).not.toContain("fixture-");
    expect(t.rule).toMatchObject({ id: "rul_1", hint: "h", pattern: "x" });
    const git = (t.git as string[]).join("\n");
    expect(git).toContain(`checkout -B ft-work ${BASE}`);
    expect(git).toContain("push --force 'https://ws.invalid/col--ws-2.git' HEAD:refs/heads/main");
    expect(git).toContain('http.extraHeader="Authorization: Bearer <trunkRead>"');
    expect(git).toContain('http.extraHeader="Authorization: Bearer <workspaceWrite>"');
    expect(git).not.toContain("fixture-");
    // Each command stands alone: no shell state, nothing but git (agents with per-call shells and git-only permissions).
    for (const line of t.git as string[]) if (!line.startsWith("#")) expect(line).toMatch(/^git /);
    expect(git).not.toMatch(/\bcd |export |\$FT_/);
    expect(await tools.checkout()).toEqual(t);
  });

  it("take with wait keeps asking while the colony has no work, without wait it hands back the hint", async () => {
    const { tools, colony, clock } = setup();
    await tools.join({ colony: "col" });
    colony.waitsBeforeWork = 1;
    expect(await tools.take()).toMatchObject({ wait: true, retryInMs: 5_000, reason: "no open intents" });
    colony.takes = 0;
    colony.waitsBeforeWork = 2;
    const t = (await tools.take({ wait: 30 })) as Record<string, any>;
    expect(t.intent).toMatchObject({ id: "int_1" });
    expect(colony.takes).toBe(3);
    expect(clock.slept).toBe(10_000);
    colony.takes = 0;
    colony.waitsBeforeWork = 100;
    clock.slept = 0;
    expect(await tools.take({ wait: 999 })).toMatchObject({ wait: true });
    expect(clock.slept).toBeLessThanOrEqual(MAX_WAIT_S * 1000);
  });

  it("read returns the file at the lease base and records it in the read set", async () => {
    const { tools, session } = setup();
    await tools.join({ colony: "col" });
    await tools.take();
    expect(await tools.read({ path: "./src/lib/util.ts" })).toMatchObject({ path: "src/lib/util.ts", blob: sha("a"), content: "export const helper = 1;\n", baseSha: BASE });
    expect(await tools.read({ path: "src/missing.ts" })).toMatchObject({ blob: null });
    expect(session().reads).toEqual({ "src/lib/util.ts": sha("a"), "src/missing.ts": null });
    await expect(tools.read({ path: "../etc/passwd" })).rejects.toThrow(/invalid path/);
  });

  it("parallel reads each land in the read set (no tool saves a stale session)", async () => {
    const { tools, colony, session } = setup();
    await tools.join({ colony: "col" });
    await tools.take();
    await Promise.all([tools.read({ path: "src/lib/util.ts" }), tools.read({ path: "README.md" }), tools.read({ path: "src/gone.ts" })]);
    expect(session().reads).toEqual({ "src/lib/util.ts": sha("a"), "README.md": sha("e"), "src/gone.ts": null });
    await tools.propose({ headSha: sha("c") });
    expect(colony.proposals[0]?.readSet).toHaveLength(3);
  });

  it("a slow heartbeat does not undo a lease taken while it was in flight", async () => {
    const { tools, colony, clock } = setup();
    await tools.join({ colony: "col" });
    clock.now += HEARTBEAT_EVERY_MS;
    let open = (): void => undefined;
    colony.firstHeartbeatGate = new Promise<void>((r) => {
      open = r;
    });
    const sensing = tools.sense({ regions: ["src"] }); // loads the session (no lease), then its heartbeat stalls
    await new Promise((r) => setTimeout(r, 0));
    await tools.take(); // heartbeats and stores the lease meanwhile
    open();
    await sensing;
    expect(await tools.checkout()).toMatchObject({ intent: { id: "int_1" } });
  });

  it("propose computes the write set from the workspace commits and sends the session's read set", async () => {
    const { tools, colony, session } = setup();
    await tools.join({ colony: "col" });
    await tools.take();
    await tools.read({ path: "src/lib/util.ts" });
    const out = (await tools.propose({ headSha: sha("c").toUpperCase(), summary: "rename", notVerified: "tests were not run" })) as Record<string, any>;
    expect(colony.proposals).toHaveLength(1);
    expect(colony.proposals[0]).toMatchObject({
      colonyId: "col",
      intentId: "int_1",
      agentId: "agt_1",
      workspace: lease.repo,
      baseSha: BASE,
      headSha: sha("c"),
      writeSet: [
        { path: "src/lib/util.ts", blob: sha("7") },
        { path: "src/new.ts", blob: sha("f") },
      ],
      readSet: [{ path: "src/lib/util.ts", blob: sha("a") }],
      declared: { footprint: ["src/lib/util.ts"], summary: "rename" },
      evidence: { notVerified: "Not verified: tests were not run" },
    });
    expect(out.proposal).toMatchObject({ id: "prp_1", status: "checking", residual: ["src/new.ts"] });
    expect(session()).toMatchObject({ reads: {}, proposals: [{ id: "prp_1", intentId: "int_1", headSha: sha("c"), at: 1_000_000 }] });
    expect(session().lease).toBeUndefined();
  });

  it("propose keeps an agent's own Not verified statement and falls back to the platform's", async () => {
    const { tools, colony } = setup();
    await tools.join({ colony: "col" });
    await tools.take();
    await tools.propose({ headSha: sha("c"), notVerified: "Not verified: Windows paths" });
    expect(colony.proposals[0]?.evidence?.notVerified).toBe("Not verified: Windows paths");
    colony.proposals = [];
    await tools.take();
    await tools.propose({ headSha: sha("c") });
    expect(colony.proposals[0]?.evidence?.notVerified).toBe(EXTERNAL_NOT_VERIFIED);
  });

  it("propose refuses commits that are missing or do not build on the lease base", async () => {
    const { tools, colony } = setup();
    await tools.join({ colony: "col" });
    await tools.take();
    await expect(tools.propose({ headSha: sha("9") })).rejects.toThrow(/not in your workspace/);
    await expect(tools.propose({ headSha: sha("d") })).rejects.toThrow(/does not build on the lease base/);
    await expect(tools.propose({ headSha: BASE })).rejects.toThrow(/changes nothing/);
    await expect(tools.propose({ headSha: "abc" })).rejects.toThrow(/40-character/);
    expect(colony.proposals).toHaveLength(0);
  });

  it("inbox with wait blocks until the latest proposal is final", async () => {
    const { tools, colony, clock } = setup();
    await tools.join({ colony: "col" });
    await tools.take();
    await tools.propose({ headSha: sha("c") });
    colony.statuses = ["checking", "checking", "ready", "landed"];
    const out = (await tools.inbox({ wait: 30 })) as Record<string, any>;
    expect(out.watching).toMatchObject({ id: "prp_1", status: "landed", final: true, landingId: "lnd_1" });
    expect(out.next).toMatch(/^Landed/);
    expect(clock.slept).toBe(3_000);
    await expect(tools.inbox({ wait: 5, proposalId: "prp_other" })).rejects.toThrow(/not one of yours/);
  });

  it("inbox with wait returns when a proposal is escalated, then waits for the human's decision", async () => {
    const { tools, colony, clock } = setup();
    await tools.join({ colony: "col" });
    await tools.take();
    await tools.propose({ headSha: sha("c") });
    colony.statuses = ["checking", "escalated"];
    expect(await tools.inbox({ wait: 30 })).toMatchObject({ watching: { status: "escalated", final: false } });
    colony.statusCalls = 0;
    colony.statuses = ["escalated"];
    clock.slept = 0;
    expect(await tools.inbox({ wait: 10 })).toMatchObject({ watching: { status: "escalated", final: false } });
    expect(clock.slept).toBe(10_000);
    await expect(setup().tools.inbox({ wait: 1 })).rejects.toThrow(/call join first/);
  });

  it("tool calls heartbeat the agent at most every 15 s, so a slow agent keeps its claim", async () => {
    const { tools, colony, clock } = setup();
    await tools.join({ colony: "col" });
    await tools.take();
    await tools.read({ path: "src/lib/util.ts" });
    expect(colony.heartbeats).toEqual([]);
    clock.now += HEARTBEAT_EVERY_MS;
    await tools.read({ path: "src/lib/util.ts" });
    await tools.sense({});
    expect(colony.heartbeats).toEqual(["agt_1"]);
    clock.now += HEARTBEAT_EVERY_MS;
    await tools.checkout();
    expect(colony.heartbeats).toEqual(["agt_1", "agt_1"]);
  });

  it("sense reads the regions of the given paths, or of the held footprint, or the whole colony", async () => {
    const { tools, readings } = setup();
    await tools.join({ colony: "col" });
    const all = (await tools.sense({})) as Record<string, any>;
    expect(all.scope).toBe("colony");
    expect(readings).toEqual([
      { region: "src", opts: {} },
      { region: ".", opts: {} },
    ]);
    readings.length = 0;
    const out = (await tools.sense({ paths: ["src/a.ts", "src/b.ts", "README.md"] })) as Record<string, any>;
    expect(readings).toEqual([
      { region: "src", opts: { paths: ["src/a.ts", "src/b.ts"] } },
      { region: ".", opts: { paths: ["README.md"] } },
    ]);
    expect(out.readings[0].totals.claim).toBe(1.235);
    await tools.take();
    await tools.sense({});
    expect(readings.at(-1)).toEqual({ region: "src", opts: { paths: ["src/lib/util.ts"] } });
  });

  it("declare adds an agent intent as a child of the held intent", async () => {
    const { tools, colony } = setup();
    await tools.join({ colony: "col" });
    await tools.take();
    await tools.declare({ title: "Follow-up", why: "found more", footprint: ["src/lib/", "../x"] });
    expect(colony.intents[0]).toMatchObject({ colonyId: "col", source: "agent", footprint: ["src/lib/"], createdBy: "agt_1", parentId: "int_1", priority: 1 });
  });

  it("release gives the held intent back to the colony and forgets the lease", async () => {
    const { tools, colony, session } = setup();
    await tools.join({ colony: "col" });
    await tools.take();
    expect(await tools.release({ reason: "cannot reproduce" })).toMatchObject({ released: { intentId: "int_1" } });
    expect(colony.abandoned).toEqual([{ agentId: "agt_1", reason: "cannot reproduce" }]);
    expect(session().lease).toBeUndefined();
    await expect(tools.checkout()).rejects.toThrow(/hold no intent/);
  });
});
