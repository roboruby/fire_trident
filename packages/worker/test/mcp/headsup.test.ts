import { describe, expect, it } from "vitest";
import type { AgentInfo, Colony, FileVersion, Intent, Path, Proposal, Sha, WorkspaceLease } from "@fire_trident/core";
import type { ProposeInput, TakeResult } from "../../src/agents/rpc.ts";
import type { HeadsUpAnswer, HeadsUpQuery, HeadsUpReport } from "../../src/colony/headsup.ts";
import { AGENT_CONFIG_KEY, HEADS_UP_ABOUT, HeadsUpTools, TOLD_KEY, sessionTools, withAgentConfig, type ToldRecord } from "../../src/mcp/headsup.ts";
import { FireTridentTools } from "../../src/mcp/tools.ts";
import type { McpColonyRpc, McpTrunkRpc, Session, ToolContext } from "../../src/mcp/tools.ts";

/**
 * The heads-up on MCP replies (FT_HEADS_UP): every reply to an agent that holds an intent carries what moved under its
 * files and what waits to land on them, only when there is something to say, within a tight time budget, failing open;
 * what it told the agent goes with the proposal.
 */

const BASE = "b".repeat(40);
const colonyInfo: Colony = { id: "col", name: "Colony", trunk: { namespace: "ft-trunk", name: "col--trunk", remote: "https://trunk.invalid/col--trunk.git" }, trunkSha: BASE, createdAt: 0, regionDepth: 1 };
const lease: WorkspaceLease = {
  repo: { namespace: "ft-ws-2", name: "col--ws-2", remote: "https://ws.invalid/col--ws-2.git" },
  token: "fixture-workspace",
  tokenExpiresAt: Date.UTC(2030, 0, 1),
  baseSha: BASE,
  leasedAt: 0,
  trunk: { remote: colonyInfo.trunk.remote, token: "fixture-trunk", sha: BASE },
};
const intent: Intent = { id: "int_1", colonyId: "col", title: "Rename helper", why: "Clarity", source: "human", footprint: ["src/a.ts"], priority: 1, status: "claimed", createdAt: 0, createdBy: "t" };
const LANDED_AT = Date.UTC(2026, 9, 17, 12, 0, 0);
const MOVED: HeadsUpReport = { moved: [{ landingId: "lnd_x", at: LANDED_AT, intentId: "int_x", title: "Cache lookups", paths: ["src/a.ts"] }], ahead: [] };
const AHEAD: HeadsUpReport = { moved: [], ahead: [{ proposalId: "prp_y", intentId: "int_y", title: "Rename the flag", region: "src", paths: ["src/a.ts"] }] };

/** The colony as the tools see it, with a heads-up that answers `report` after `delayMs` (or fails). */
class FakeColony {
  agents: AgentInfo[] = [];
  proposals: ProposeInput[] = [];
  asked: HeadsUpQuery[] = [];
  report: HeadsUpReport | null = null;
  delayMs = 0;
  fail = false;
  async getColony(): Promise<Colony | null> {
    return colonyInfo;
  }
  async getAgent(id: string): Promise<AgentInfo | null> {
    return this.agents.find((a) => a.id === id) ?? null;
  }
  async registerAgent(a: { kind: AgentInfo["kind"]; name: string }): Promise<AgentInfo> {
    const info: AgentInfo = { id: `agt_${this.agents.length + 1}`, colonyId: "col", kind: a.kind, name: a.name, thresholds: {}, state: "idle", lastSeen: 0 };
    this.agents.push(info);
    return info;
  }
  async heartbeat(): Promise<void> {}
  async take(): Promise<TakeResult> {
    return { intent, lease };
  }
  async inbox(): Promise<Proposal[]> {
    return [];
  }
  async propose(p: ProposeInput): Promise<Proposal> {
    this.proposals.push(p);
    return { ...p, id: "prp_1", status: "checking", createdAt: 0, evidence: { checks: [], residual: [], notVerified: "n" } };
  }
  async headsUp(_agentId: string, q: HeadsUpQuery = {}): Promise<HeadsUpAnswer> {
    this.asked.push(q);
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.fail) throw new Error("colony unreachable");
    return { intentId: q.intentId ?? null, baseSha: q.baseSha ?? null, report: this.report };
  }
}

/** A joined session holding int_1, with the heads-up on (or off), a clock the test moves, and the stored told record. */
async function setup(opts: { enabled?: boolean; budgetMs?: number } = {}) {
  const colony = new FakeColony();
  let session: Session = { reads: {}, proposals: [] };
  const clock = { now: Date.UTC(2026, 9, 17, 12, 3, 0) };
  const stored = new Map<string, unknown>();
  const trunk = { baseBlobs: async (_b: Sha, paths: Path[]): Promise<FileVersion[]> => paths.map((path) => ({ path, blob: null })) };
  const ctx: ToolContext = {
    colony: () => colony as unknown as McpColonyRpc,
    region: () => {
      throw new Error("not used");
    },
    trunk: () => trunk as unknown as McpTrunkRpc,
    inline: () => true,
    repo: async () => {
      throw new Error("not used");
    },
    load: async () => structuredClone(session),
    save: async (s) => {
      session = structuredClone(s);
    },
    now: () => clock.now,
    sleep: async () => undefined,
  };
  const store = { get: async (k: string) => structuredClone(stored.get(k)), put: async (k: string, v: unknown) => void stored.set(k, structuredClone(v)) };
  const tools = new HeadsUpTools(ctx, { enabled: () => opts.enabled ?? true, store, budgetMs: opts.budgetMs ?? 50, cacheMs: 3_000 });
  await tools.join({ colony: "col" });
  const read = (path: string): void => {
    session.reads[path] = "1".repeat(40);
  };
  return { tools, colony, clock, stored, read };
}

describe("heads-up on MCP replies", () => {
  it("a take carries headsUp and deliveredThrough when trunk moved under a file the agent will write", async () => {
    const { tools, colony, clock } = await setup();
    colony.report = MOVED;
    const t = (await tools.take()) as Record<string, any>;
    expect(t.headsUp).toEqual({
      about: HEADS_UP_ABOUT,
      trunkMoved: [{ landingId: "lnd_x", at: new Date(LANDED_AT).toISOString(), intent: { id: "int_x", title: "Cache lookups" }, paths: ["src/a.ts"] }],
      next: expect.stringMatching(/^Trunk changed files you read or will write after your lease base/),
    });
    expect(t.deliveredThrough).toEqual({ landingId: "lnd_x", landedAt: new Date(LANDED_AT).toISOString(), toldAt: new Date(clock.now).toISOString() });
    expect(colony.asked[0]).toEqual({ intentId: "int_1", baseSha: BASE, reads: [] });
  });

  it("a queued change that writes a file the agent read shows on the read set's next reply, and nothing shows when nothing applies", async () => {
    const { tools, colony, read } = await setup();
    await tools.take();
    const quiet = (await tools.checkout()) as Record<string, any>;
    expect(quiet).not.toHaveProperty("headsUp");
    expect(quiet).not.toHaveProperty("deliveredThrough");
    read("src/b.ts");
    colony.report = AHEAD;
    const loud = (await tools.checkout()) as Record<string, any>;
    expect(colony.asked.at(-1)?.reads).toEqual(["src/b.ts"]);
    expect(loud.headsUp.waitingAhead).toEqual([{ proposalId: "prp_y", intent: { id: "int_y", title: "Rename the flag" }, region: "src", paths: ["src/a.ts"] }]);
    expect(loud.headsUp).not.toHaveProperty("trunkMoved");
    expect(loud.deliveredThrough).toBeNull();
  });

  it("asks the colony once while nothing it asks about changes, within the cache window", async () => {
    const { tools, colony, clock, read } = await setup();
    await tools.take();
    await tools.checkout();
    expect(colony.asked).toHaveLength(1);
    read("src/c.ts");
    await tools.checkout();
    expect(colony.asked).toHaveLength(2);
    clock.now += 3_000;
    await tools.checkout();
    expect(colony.asked).toHaveLength(3);
  });

  it("never slows a reply past its budget: a slow answer is left out, and the next reply carries it", async () => {
    const { tools, colony, clock, read } = await setup({ budgetMs: 30 });
    await tools.take();
    read("src/z.ts");
    colony.report = MOVED;
    colony.delayMs = 250;
    const t0 = Date.now();
    const slow = (await tools.checkout()) as Record<string, any>;
    expect(Date.now() - t0).toBeLessThan(200);
    expect(slow).not.toHaveProperty("headsUp");
    expect(slow.intent.id).toBe("int_1");
    await new Promise((r) => setTimeout(r, 300));
    clock.now += 1_000;
    const later = (await tools.checkout()) as Record<string, any>;
    expect(later.headsUp.trunkMoved[0].landingId).toBe("lnd_x");
    expect(colony.asked).toHaveLength(2);
  });

  it("fails open: a colony that errs leaves the reply as it was", async () => {
    const { tools, colony } = await setup();
    colony.fail = true;
    const t = (await tools.take()) as Record<string, any>;
    expect(t.intent.id).toBe("int_1");
    expect(t).not.toHaveProperty("headsUp");
  });

  it("off for the colony: replies are exactly the plain tools' replies", async () => {
    const { tools, colony } = await setup({ enabled: false });
    colony.report = MOVED;
    const t = (await tools.take()) as Record<string, any>;
    expect(t).not.toHaveProperty("headsUp");
    expect(t.git.some((l: string) => l.includes(AGENT_CONFIG_KEY))).toBe(false);
    expect(colony.asked).toHaveLength(0);
    expect(sessionTools({} as ToolContext, undefined, { get: async () => undefined, put: async () => undefined })).not.toBeInstanceOf(HeadsUpTools);
    expect(sessionTools({} as ToolContext, "off", { get: async () => undefined, put: async () => undefined })).toBeInstanceOf(FireTridentTools);
    expect(sessionTools({} as ToolContext, "col", { get: async () => undefined, put: async () => undefined })).toBeInstanceOf(HeadsUpTools);
  });

  it("take's git commands record the colony and agent in the clone's local config, right after the checkout", async () => {
    const { tools } = await setup();
    const t = (await tools.take()) as Record<string, any>;
    const at = (t.git as string[]).findIndex((l) => l.includes(" checkout -B ft-work "));
    expect(t.git[at + 1]).toBe(`git -C ft-int_1 config ${AGENT_CONFIG_KEY} col/agt_1`);
    expect(withAgentConfig(t.git, "col", "agt_1")).toEqual(t.git);
    expect(withAgentConfig(["git status"], "col", "agt_1")).toEqual(["git status"]);
  });
});

describe("the watermark: what the session told the agent goes with its proposal", () => {
  it("stores each landing named with when it was first told, and the proposal carries it with the last reply's time", async () => {
    const { tools, colony, clock, stored } = await setup();
    colony.report = MOVED;
    const toldAt = clock.now;
    await tools.take();
    clock.now += 10_000;
    await tools.checkout();
    const record = stored.get(TOLD_KEY) as ToldRecord;
    expect(record.landings).toEqual([{ landingId: "lnd_x", at: LANDED_AT, toldAt }]);
    expect(record.lastReplyAt).toBe(toldAt + 10_000);
    clock.now += 30_000;
    const p = (await tools.propose({ files: [{ path: "src/a.ts", content: "x\n" }] })) as Record<string, any>;
    expect(colony.proposals[0]?.toldOf).toEqual({ landings: [{ landingId: "lnd_x", at: LANDED_AT, toldAt }], through: { landingId: "lnd_x", at: LANDED_AT, toldAt }, lastReplyAt: toldAt + 10_000 });
    // The propose reply looks at the intent the agent held when it proposed.
    expect(p.headsUp.trunkMoved[0].landingId).toBe("lnd_x");
    expect(colony.asked.at(-1)?.intentId).toBe("int_1");
  });

  it("a proposal from a session that told nothing still says when it last replied, and a new take starts a new record", async () => {
    const { tools, colony, clock, stored } = await setup();
    await tools.take();
    const repliedAt = clock.now;
    clock.now += 5_000;
    await tools.propose({ files: [{ path: "src/a.ts", content: "x\n" }] });
    expect(colony.proposals[0]?.toldOf).toEqual({ landings: [], lastReplyAt: repliedAt });
    stored.set(TOLD_KEY, { intentId: "int_old", baseSha: BASE, landings: [{ landingId: "lnd_q", at: 1, toldAt: 2 }] });
    colony.report = null;
    await tools.take();
    expect((stored.get(TOLD_KEY) as ToldRecord).landings).toEqual([]);
  });
});
