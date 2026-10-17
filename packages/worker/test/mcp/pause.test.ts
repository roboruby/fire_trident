import { describe, expect, it } from "vitest";
import type { AgentInfo, Colony, FieldReading, Id, Intent, Proposal, WorkspaceLease } from "@fire_trident/core";
import type { TakeResult } from "../../src/agents/rpc.ts";
import { pausedSentence, type PauseView } from "../../src/colony/pause.ts";
import { toolError } from "../../src/mcp/errors.ts";
import { FireTridentTools } from "../../src/mcp/tools.ts";
import type { McpColonyRpc, RepoReader, Session, ToolContext } from "../../src/mcp/tools.ts";

/**
 * The MCP gate's fast refusal (colony/pause.ts refuseWhilePaused in mcp/tools.ts): while the colony says its agents
 * are paused, take, declare, propose and escalate answer the pause's sentence without reaching the colony's write,
 * and the envelope says what to do next; reads and join keep working. A colony on the previous version has no switch.
 */

const BASE = "b".repeat(40);
const colonyInfo: Colony = { id: "col", name: "Colony", trunk: { namespace: "ft-trunk", name: "col--trunk", remote: "https://trunk.invalid/t.git" }, trunkSha: BASE, createdAt: 0, regionDepth: 1 };
const lease: WorkspaceLease = {
  repo: { namespace: "ft-ws-0", name: "col--ws-0", remote: "https://ws.invalid/w.git" },
  token: "fixture-ws",
  tokenExpiresAt: Date.UTC(2030, 0, 1),
  baseSha: BASE,
  leasedAt: 0,
  trunk: { remote: colonyInfo.trunk.remote, token: "fixture-trunk", sha: BASE },
};
const theIntent: Intent = { id: "int_1", colonyId: "col", title: "Rename", why: "Clarity", source: "human", footprint: ["src/a.ts"], priority: 1, status: "claimed", createdAt: 0, createdBy: "t" };
const SENTENCE = pausedSentence({ by: "maya", reason: "demo reset" });

/** A colony that counts its writes; `paused` is what its pauseState says (a colony with no switch has no pauseState). */
class Colony_ {
  paused = false;
  pauseState?: () => Promise<PauseView> = async () =>
    this.paused ? { paused: true, pauses: [{ scope: "colony", by: "maya", reason: "demo reset", at: 1 }], refusal: SENTENCE } : { paused: false, pauses: [], refusal: null };
  takes = 0;
  writes: string[] = [];
  agents: AgentInfo[] = [];
  async getColony(): Promise<Colony> {
    return colonyInfo;
  }
  async getAgent(id: Id): Promise<AgentInfo | null> {
    return this.agents.find((a) => a.id === id) ?? null;
  }
  async registerAgent(a: { kind: AgentInfo["kind"]; name: string }): Promise<AgentInfo> {
    const info: AgentInfo = { id: `agt_${this.agents.length + 1}`, colonyId: "col", kind: a.kind, name: a.name, thresholds: {}, state: "idle", lastSeen: 0 };
    this.agents.push(info);
    return info;
  }
  async heartbeat(): Promise<void> {}
  async take(): Promise<TakeResult> {
    this.takes++;
    return { intent: theIntent, lease };
  }
  async propose(): Promise<Proposal> {
    this.writes.push("propose");
    throw new Error("not reached");
  }
  async addIntent(): Promise<Intent> {
    this.writes.push("declare");
    throw new Error("not reached");
  }
  async escalate(): Promise<never> {
    this.writes.push("escalate");
    throw new Error("not reached");
  }
  async inbox(): Promise<Proposal[]> {
    return [];
  }
  async listRegions(): Promise<string[]> {
    return ["src"];
  }
}

function setup(colony: Colony_) {
  let session: Session = { reads: {}, proposals: [] };
  const reader: RepoReader = {
    readCommit: async () => ({ hash: BASE, treeHash: "1".repeat(40), parents: [] }),
    readTree: async () => [{ name: "README.md", mode: "100644", hash: "e".repeat(40), type: "blob" }],
    readBlob: async () => ({ arrayBuffer: async () => new TextEncoder().encode("# readme\n").buffer as ArrayBuffer }),
    release() {},
  };
  const ctx: ToolContext = {
    colony: () => colony as unknown as McpColonyRpc,
    region: (_c, region) => ({ reading: async () => ({ region, at: 0, totals: { claim: 0, need: 0, trail: 0, failure: 0, danger: 0 }, byPath: {}, agents: [], sigma: 0, admission: { open: true, landingsPerMin: 0, activeAgents: 0 } }) as FieldReading }),
    trunk: () => ({ why: async () => [] }),
    repo: async () => reader,
    load: async () => structuredClone(session),
    save: async (s) => {
      session = structuredClone(s);
    },
    now: () => 1_000_000,
    sleep: async () => undefined,
  };
  return new FireTridentTools(ctx);
}

describe("the MCP gate while a colony's agents are paused", () => {
  it("refuses take, declare, propose and escalate at once with the sentence, and leaves reads alone", async () => {
    const colony = new Colony_();
    const tools = setup(colony);
    await tools.join({ colony: "col", name: "laptop" });
    await tools.take();
    colony.paused = true;
    const takes = colony.takes;

    await expect(tools.take({ wait: 30 })).rejects.toThrow(`[ft:409] ${SENTENCE}`);
    await expect(tools.declare({ title: "More", why: "w", footprint: ["src/b.ts"] })).rejects.toThrow(`[ft:409] ${SENTENCE}`);
    await expect(tools.propose({ files: [{ path: "src/a.ts", content: "x\n" }] })).rejects.toThrow(`[ft:409] ${SENTENCE}`);
    await expect(tools.escalate({ kind: "impossible", report: "two answers" })).rejects.toThrow(`[ft:409] ${SENTENCE}`);
    // None of them reached the colony's write.
    expect(colony.takes).toBe(takes);
    expect(colony.writes).toEqual([]);

    // What the agent is told: the sentence, and what to do next.
    const err = await tools.take().catch((e: unknown) => e);
    expect(toolError(err).structuredContent).toEqual({
      error: {
        kind: "conflict",
        message: SENTENCE,
        retryable: false,
        status: 409,
        next: "Wait for a person to resume the colony, then call the tool again; sense, read, why, impact, inbox and checkout still answer meanwhile.",
      },
    });

    // Reads, and join, keep working.
    expect(await tools.sense({})).toBeDefined();
    expect(await tools.checkout()).toMatchObject({ intent: { id: "int_1" } });
    expect(await tools.why({ path: "README.md" })).toBeDefined();
    expect(await tools.inbox({})).toBeDefined();
    expect(await tools.join({ colony: "col" })).toMatchObject({ resumed: true });

    colony.paused = false;
    expect(await tools.take()).toMatchObject({ intent: { id: "int_1" } });
  });

  it("lets a colony with no switch (the previous version) through", async () => {
    const colony = new Colony_();
    delete colony.pauseState;
    const tools = setup(colony);
    await tools.join({ colony: "col" });
    expect(await tools.take()).toMatchObject({ intent: { id: "int_1" } });
  });
});
