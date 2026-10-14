import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AgentInfo, Colony, Id, ImpactReport, Intent, Path, WorkspaceLease } from "@fire_trident/core";
import type { TakeResult } from "../../src/agents/rpc.ts";
import { stepupHint } from "../../src/colony/stepup.ts";
import { FireTridentMcp } from "../../src/mcp/FireTridentMcp.ts";
import { FireTridentTools } from "../../src/mcp/tools.ts";
import type { McpColonyRpc, Session, ToolContext } from "../../src/mcp/tools.ts";

/**
 * The MCP `impact` tool (what a change to some files reaches, and who works on it now; ColonyDO.impact) and the take's
 * model hint (FT_MODEL_STEPUP), which an outside agent gets as advice only.
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
const theIntent: Intent = { id: "int_1", colonyId: "col", title: "Parse dates", why: "w", source: "human", footprint: ["src/date.ts", "src/parse/"], priority: 1, status: "claimed", createdAt: 0, createdBy: "t" };

const REPORT = { colonyId: "col", files: [{ path: "src/date.ts", depth: 0 }], about: "data" } as unknown as ImpactReport;

function setup(opts: { impact?: boolean; model?: unknown } = {}) {
  const agents: AgentInfo[] = [];
  const impactCalls: Array<{ paths: Path[]; opts: unknown }> = [];
  const colony: Record<string, unknown> = {
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
      return { intent: theIntent, lease, ...(opts.model !== undefined ? { model: opts.model } : {}) } as TakeResult;
    },
    async abandon(): Promise<void> {},
  };
  if (opts.impact !== false) {
    colony.impact = async (paths: Path[], o: unknown): Promise<ImpactReport> => {
      impactCalls.push({ paths, opts: o });
      return REPORT;
    };
  }
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
  return { tools: new FireTridentTools(ctx), impactCalls, session: () => session };
}

describe("MCP impact", () => {
  it("asks the colony about the paths given, or the held intent's footprint, with the depth", async () => {
    const { tools, impactCalls } = setup();
    await tools.join({ colony: "col" });
    expect(await tools.impact({ paths: ["src/a.ts", " "], depth: 2 })).toEqual(REPORT);
    await tools.take();
    await tools.impact({});
    expect(impactCalls).toEqual([
      { paths: ["src/a.ts"], opts: { depth: 2 } },
      { paths: ["src/date.ts", "src/parse/"], opts: {} },
    ]);
  });

  it("needs a join, and paths or a held intent; says so when the colony cannot answer yet", async () => {
    const { tools } = setup();
    await expect(tools.impact({ paths: ["src/a.ts"] })).rejects.toThrow("[ft:400] call join first");
    await tools.join({ colony: "col" });
    await expect(tools.impact({})).rejects.toThrow("[ft:400] name the files to look at in paths, or take an intent first: impact then looks at its footprint");
    const old = setup({ impact: false });
    await old.tools.join({ colony: "col" });
    await expect(old.tools.impact({ paths: ["src/a.ts"] })).rejects.toThrow("[ft:503] this colony cannot answer impact yet");
  });

  it("is registered as a read-only tool taking paths and depth", async () => {
    const server = new FireTridentMcp({} as never, {} as never);
    await server.init();
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.server.connect(serverSide);
    const client = new Client({ name: "impact-test", version: "0.0.0" });
    await client.connect(clientSide);
    try {
      const tool = (await client.listTools()).tools.find((t) => t.name === "impact");
      expect(tool?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
      expect(Object.keys(tool?.inputSchema.properties ?? {}).sort()).toEqual(["depth", "paths"]);
      expect(tool?.description).toContain("who works on it now");
    } finally {
      await client.close();
    }
  });
});

describe("MCP take: the model step-up as advice", () => {
  it("take and checkout carry the hint as advice only, and it goes with the held intent", async () => {
    const hint = stepupHint(2)!;
    const { tools, session } = setup({ model: hint });
    await tools.join({ colony: "col" });
    const t = (await tools.take()) as Record<string, any>;
    expect(t.model).toEqual({ class: "default", returns: 2, reason: hint.reason, advice: expect.stringContaining("This is advice only") });
    expect(await tools.checkout()).toEqual(t);
    expect(session().model).toEqual(hint);
    await tools.release({});
    expect(session().model).toBeUndefined();
  });

  it("shows nothing when the colony sends no usable hint", async () => {
    for (const model of [undefined, { model: "default", returns: 1, reason: "r" }, "default"]) {
      const { tools } = setup({ model });
      await tools.join({ colony: "col" });
      expect(await tools.take(), JSON.stringify(model)).not.toHaveProperty("model");
    }
  });
});
