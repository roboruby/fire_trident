import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AgentInfo, Colony, Id, Intent, Proposal, WorkspaceLease } from "@fire_trident/core";
import type { ProposeInput, TakeResult } from "../../src/agents/rpc.ts";
import { FireTridentMcp } from "../../src/mcp/FireTridentMcp.ts";
import { FireTridentTools } from "../../src/mcp/tools.ts";
import type { McpColonyRpc, Session, ToolContext } from "../../src/mcp/tools.ts";

/**
 * Review by reproduction over MCP (FT_REPRODUCE, decide/reproduce.ts): propose takes the recipe that made the change and
 * passes it on, bounded; the server offers `recipe` only where the deployment replays one for some colony.
 */

// The server's base class needs the Workers runtime; registering and listing tools needs only the env it holds.
vi.mock("agents/mcp", () => ({
  McpAgent: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

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
const theIntent: Intent = { id: "int_1", colonyId: "col", title: "Rename compose", why: "One name.", source: "human", footprint: ["src/"], priority: 1, status: "claimed", createdAt: 0, createdBy: "t" };

function setup() {
  const agents: AgentInfo[] = [];
  const proposed: ProposeInput[] = [];
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
      return { intent: theIntent, lease } as TakeResult;
    },
    async abandon(): Promise<void> {},
    async propose(p: ProposeInput): Promise<Proposal> {
      proposed.push(p);
      return { ...p, id: `prp_${proposed.length}`, status: "checking", createdAt: 0, evidence: { checks: [], notVerified: "n", residual: [] } } as Proposal;
    },
  };
  let session: Session = { reads: {}, proposals: [] };
  const ctx: ToolContext = {
    colony: () => colony as unknown as McpColonyRpc,
    region: () => {
      throw new Error("not used");
    },
    trunk: () => ({ why: async () => [], baseBlobs: async () => [{ path: "src/a.ts", blob: sha("1") }] }),
    inline: () => true,
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
  return { tools: new FireTridentTools(ctx), proposed };
}

/** The propose tool's arguments on a server started with `env`. */
async function proposeArgs(env: Record<string, string>): Promise<Set<string>> {
  const server = new FireTridentMcp({} as never, env as never);
  await server.init();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.server.connect(serverSide);
  const client = new Client({ name: "recipe-test", version: "0.0.0" });
  await client.connect(clientSide);
  try {
    const { tools } = await client.listTools();
    return new Set(Object.keys(tools.find((t) => t.name === "propose")?.inputSchema.properties ?? {}));
  } finally {
    await client.close();
  }
}

describe("MCP propose with the recipe that made the change", () => {
  it("passes the recipe on to the colony, bounded, and sends none when the agent gives none", async () => {
    const { tools, proposed } = setup();
    await tools.join({ colony: "col" });
    await tools.take();
    await tools.propose({ files: [{ path: "src/a.ts", content: "export function assemble() {}\n" }], recipe: { kind: "rename-identifier", version: 1, args: { from: "compose", to: "assemble", extra: 3 }, scope: "src/**" } });
    expect(proposed[0]!.recipe).toEqual({ kind: "rename-identifier", version: "1", args: { from: "compose", to: "assemble" }, scope: ["src/**"] });
    await tools.take();
    await tools.propose({ files: [{ path: "src/a.ts", content: "export function assemble2() {}\n" }] });
    expect(proposed[1]).not.toHaveProperty("recipe");
  });

  it("offers recipe only where the deployment replays recipes for some colony", async () => {
    expect((await proposeArgs({})).has("recipe")).toBe(false);
    const envs: Array<Record<string, string>> = [{ FT_REPRODUCE: "on" }, { FT_REPRODUCE: "web", FT_INLINE: "on" }];
    for (const env of envs) expect((await proposeArgs(env)).has("recipe")).toBe(true);
  });
});
