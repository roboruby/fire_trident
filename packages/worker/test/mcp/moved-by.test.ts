import { describe, expect, it } from "vitest";
import type { AgentInfo, Colony, Id, Intent, MovedBy, Proposal, WorkspaceLease } from "@fire_trident/core";
import type { TakeResult } from "../../src/agents/rpc.ts";
import { FireTridentTools } from "../../src/mcp/tools.ts";
import type { McpColonyRpc, Session, ToolContext } from "../../src/mcp/tools.ts";

/**
 * Over MCP, a change that came back because trunk moved its files names the landings that moved them (movedBy): in the
 * take's lastReturn, with what to do in its next step, and in the inbox.
 */

const sha = (c: string): string => c.repeat(40).slice(0, 40);
const colonyInfo: Colony = { id: "col", name: "Colony", trunk: { namespace: "ft-trunk", name: "col--trunk", remote: "https://trunk.invalid/col--trunk.git" }, trunkSha: sha("b"), createdAt: 0, regionDepth: 1 };
const lease: WorkspaceLease = {
  repo: { namespace: "ft-ws-2", name: "col--ws-2", remote: "https://ws.invalid/col--ws-2.git" },
  token: "fixture-workspace",
  tokenExpiresAt: Date.UTC(2030, 0, 1),
  baseSha: sha("b"),
  leasedAt: 0,
  trunk: { remote: colonyInfo.trunk.remote, token: "fixture-trunk", sha: sha("b") },
};
const theIntent: Intent = { id: "int_1", colonyId: "col", title: "Add b", why: "Callers need b.", source: "human", footprint: ["src/values.ts"], priority: 1, status: "claimed", createdAt: 0, createdBy: "t" };
const MOVED: MovedBy[] = [{ landingId: "lnd_a", paths: ["src/values.ts"], trunkSha: sha("2"), at: Date.UTC(2026, 9, 14, 9, 29), intentId: "int_a", title: "Add a", why: "Callers need a.", agentId: "agt_a", model: "@cf/vendor/model" }];
const MOVED_VIEW = [{ ...MOVED[0]!, at: "2026-10-14T09:29:00.000Z" }];
const REASON = "stale: 1 path changed on trunk since read: src/values.ts (expected 1111111111, trunk 2222222222). Landing lnd_a (commit 2222222, intent int_a, agent agt_a) moved it. Keep what that landing did unless your intent says otherwise, and escalate if both cannot hold.";
const BACK = { proposalId: "prp_3", status: "returned", at: Date.UTC(2026, 9, 14, 9, 30), reason: REASON, paths: ["src/values.ts"], movedBy: MOVED };

function setup() {
  const agents: AgentInfo[] = [];
  const returned: Proposal = {
    id: "prp_3",
    colonyId: "col",
    intentId: "int_1",
    agentId: "agt_1",
    workspace: lease.repo,
    baseSha: sha("b"),
    headSha: sha("c"),
    writeSet: [{ path: "src/values.ts", blob: sha("d") }],
    readSet: [],
    declared: { footprint: ["src/values.ts"], summary: "add b" },
    evidence: { checks: [] },
    status: "returned",
    createdAt: Date.UTC(2026, 9, 14, 9, 28),
    reason: REASON,
    movedBy: MOVED,
  };
  const state = { lastReturn: BACK as unknown };
  const colony = {
    async getColony(): Promise<Colony | null> {
      return colonyInfo;
    },
    async getAgent(id: Id): Promise<AgentInfo | null> {
      return agents.find((a) => a.id === id) ?? null;
    },
    async registerAgent(a: { kind: AgentInfo["kind"]; name: string }): Promise<AgentInfo> {
      const info: AgentInfo = { id: `agt_${agents.length + 1}`, colonyId: "col", kind: a.kind, name: a.name, thresholds: {}, state: "idle", lastSeen: 0 };
      agents.push(info);
      return info;
    },
    async heartbeat(): Promise<void> {},
    async take(): Promise<TakeResult> {
      return { intent: theIntent, lease, ...(state.lastReturn !== undefined ? { lastReturn: state.lastReturn } : {}) } as TakeResult;
    },
    async getProposal(id: Id): Promise<Proposal | null> {
      return id === returned.id ? returned : null;
    },
    async inbox(): Promise<Proposal[]> {
      return [returned];
    },
    async abandon(): Promise<void> {},
  };
  let session: Session = { reads: {}, proposals: [] };
  const ctx: ToolContext = {
    colony: () => colony as unknown as McpColonyRpc,
    region: () => {
      throw new Error("not used");
    },
    trunk: () => {
      throw new Error("not used");
    },
    repo: async () => {
      throw new Error("not used");
    },
    load: async () => structuredClone(session),
    save: async (s) => {
      session = structuredClone(s);
    },
    now: () => 1_000_000,
    sleep: async () => undefined,
  };
  return { tools: new FireTridentTools(ctx), state };
}

describe("MCP: what beat a returned change", () => {
  it("take carries movedBy in lastReturn, and its next step says to keep what those landings did", async () => {
    const { tools } = setup();
    await tools.join({ colony: "col" });
    const t = (await tools.take()) as Record<string, any>;
    expect(t.lastReturn).toEqual({ ...BACK, at: "2026-10-14T09:30:00.000Z", movedBy: MOVED_VIEW });
    expect(t.next).toMatch(
      /^An earlier change for this intent came back: address lastReturn\.reason first, so that your change does not come back for the same reason\. lastReturn\.movedBy names the landings that moved its files, with their intents: keep what they did unless your intent says otherwise, and escalate if both cannot hold\. /,
    );
    expect(((await tools.checkout()) as Record<string, any>).lastReturn.movedBy).toEqual(MOVED_VIEW);
  });

  it("without movedBy, the take is as before", async () => {
    const { tools, state } = setup();
    const { movedBy: _gone, ...plain } = BACK;
    state.lastReturn = plain;
    await tools.join({ colony: "col" });
    const t = (await tools.take()) as Record<string, any>;
    expect(t.lastReturn).not.toHaveProperty("movedBy");
    expect(t.next).not.toContain("movedBy");
  });

  it("the inbox names the landings with the watched proposal and in its list", async () => {
    const { tools } = setup();
    await tools.join({ colony: "col" });
    const inbox = (await tools.inbox({ proposalId: "prp_3" })) as Record<string, any>;
    expect(inbox.watching).toMatchObject({ id: "prp_3", status: "returned", reason: REASON, movedBy: MOVED_VIEW });
    expect(inbox.proposals[0]).toMatchObject({ id: "prp_3", movedBy: MOVED_VIEW });
  });
});
