import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { GUIDE_LABEL } from "@fire_trident/core";
import type { AgentInfo, Colony, GuideTake, Id, Intent, LessonReceipt, Proposal, WorkspaceLease } from "@fire_trident/core";
import type { ProposeInput, TakeResult } from "../../src/agents/rpc.ts";
import { FireTridentMcp } from "../../src/mcp/FireTridentMcp.ts";
import { LESSON_STEP, serverInstructions } from "../../src/mcp/instructions.ts";
import { FireTridentTools } from "../../src/mcp/tools.ts";
import type { McpColonyRpc, Session, ToolContext } from "../../src/mcp/tools.ts";

/**
 * The field guide over MCP (FT_FIELD_GUIDE): propose takes a lesson and says what became of it, take and checkout carry
 * the guide under its label with each lesson's provenance, and the server offers `lesson` and its sentence in the
 * instructions only where the deployment keeps a guide.
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
const theIntent: Intent = { id: "int_1", colonyId: "col", title: "Add the users route", why: "Users need a list.", source: "human", footprint: ["src/users.ts"], priority: 1, status: "claimed", createdAt: 0, createdBy: "t" };
const GUIDE: GuideTake = {
  lessons: [{ id: "les_1", text: "Routes register in src/routes/index.ts, not in the app file.", agentId: "agt_9", author: "platform", model: "@cf/model", modelEvidence: "observed", landingId: "lnd_7", activatedAt: Date.UTC(2026, 9, 14, 3, 12), activatedBy: "certification" }],
};

function setup(opts: { guide?: unknown; receipt?: LessonReceipt } = {}) {
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
      return { intent: theIntent, lease, ...(opts.guide !== undefined ? { guide: opts.guide } : {}) } as TakeResult;
    },
    async abandon(): Promise<void> {},
    async propose(p: ProposeInput): Promise<Proposal & { lesson?: LessonReceipt }> {
      proposed.push(p);
      return { ...p, id: "prp_1", status: "checking", createdAt: 0, evidence: { checks: [], notVerified: "n", residual: [] }, ...(opts.receipt && p.lesson ? { lesson: opts.receipt } : {}) } as Proposal & { lesson?: LessonReceipt };
    },
  };
  let session: Session = { reads: {}, proposals: [] };
  const ctx: ToolContext = {
    colony: () => colony as unknown as McpColonyRpc,
    region: () => {
      throw new Error("not used");
    },
    trunk: () => ({ why: async () => [], baseBlobs: async () => [{ path: "src/users.ts", blob: null }] }),
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
  return { tools: new FireTridentTools(ctx), proposed, session: () => session };
}

describe("MCP take and checkout carry the field guide", () => {
  it("as one section under the guide's label, each lesson with who wrote it and the landing it came from", async () => {
    const { tools, session } = setup({ guide: GUIDE });
    await tools.join({ colony: "col" });
    const t = (await tools.take()) as Record<string, any>;
    expect(t.guide).toEqual({
      about: GUIDE_LABEL,
      lessons: [{ id: "les_1", text: GUIDE.lessons[0]!.text, agentId: "agt_9", author: "platform", model: "@cf/model", modelEvidence: "observed", landingId: "lnd_7", activatedAt: "2026-10-14T03:12:00.000Z", activatedBy: "certification" }],
    });
    expect(await tools.checkout()).toEqual(t);
    expect(session().guide?.lessons).toHaveLength(1);
    await tools.release({});
    expect(session().guide).toBeUndefined();
  });

  it("carries none when the colony sends none, an empty guide, or something that is not one", async () => {
    for (const guide of [undefined, { lessons: [] }, { lessons: [{ id: "x", text: "tiny" }] }, "lessons"]) {
      const { tools } = setup({ guide });
      await tools.join({ colony: "col" });
      expect(await tools.take()).not.toHaveProperty("guide");
    }
  });
});

describe("MCP propose with a lesson", () => {
  it("passes the lesson on and answers with what became of it", async () => {
    const receipt: LessonReceipt = { status: "candidate", lessonId: "les_2", note: "Recorded as lesson les_2." };
    const { tools, proposed } = setup({ receipt });
    await tools.join({ colony: "col" });
    await tools.take();
    const res = (await tools.propose({ files: [{ path: "src/users.ts", content: "export const users = [];\n" }], notVerified: "Not verified: nothing.", lesson: "The users list is cached per isolate." })) as Record<string, any>;
    expect(proposed[0]!.lesson).toBe("The users list is cached per isolate.");
    expect(res.lesson).toEqual(receipt);
  });

  it("says the lesson was not recorded where the colony keeps no guide, and sends none when there is none", async () => {
    const { tools, proposed } = setup();
    await tools.join({ colony: "col" });
    await tools.take();
    const res = (await tools.propose({ files: [{ path: "src/users.ts", content: "export const users = [];\n" }], lesson: "The users list is cached per isolate." })) as Record<string, any>;
    expect(res.lesson).toEqual({ status: "ignored", note: "This colony keeps no field guide (FT_FIELD_GUIDE), so the lesson was not recorded." });
    await tools.take();
    const plain = (await tools.propose({ files: [{ path: "src/users.ts", content: "export const users = [1];\n" }], lesson: "   " })) as Record<string, any>;
    expect(proposed[1]).not.toHaveProperty("lesson");
    expect(plain).not.toHaveProperty("lesson");
  });
});

/** The propose tool's arguments and the instructions of a server started with `env`. */
async function served(env: Record<string, string>): Promise<{ propose: Set<string>; instructions: string }> {
  const server = new FireTridentMcp({} as never, env as never);
  await server.init();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.server.connect(serverSide);
  const client = new Client({ name: "guide-test", version: "0.0.0" });
  await client.connect(clientSide);
  try {
    const { tools } = await client.listTools();
    const propose = tools.find((t) => t.name === "propose");
    return { propose: new Set(Object.keys(propose?.inputSchema.properties ?? {})), instructions: client.getInstructions() ?? "" };
  } finally {
    await client.close();
  }
}

describe("the MCP server offers lesson only where the deployment keeps a guide", () => {
  it("adds lesson to propose, with or without inline changes, and one sentence to the proposing step", async () => {
    const off = await served({});
    expect(off.propose.has("lesson")).toBe(false);
    expect(off.instructions).not.toContain("lesson");
    const envs: Array<Record<string, string>> = [{ FT_FIELD_GUIDE: "on" }, { FT_FIELD_GUIDE: "some-colony", FT_INLINE: "on" }];
    for (const env of envs) {
      const on = await served(env);
      expect(on.propose.has("lesson")).toBe(true);
      expect(on.instructions).toContain(LESSON_STEP);
    }
  });

  it("keeps the steps' numbers, the sentence right after the proposing step", () => {
    const text = serverInstructions(true, true);
    const lines = text.split("\n");
    const at = lines.indexOf(LESSON_STEP);
    expect(lines[at - 1]).toMatch(/^ {3}Without git:/);
    expect(lines[at - 2]).toMatch(/^6\. propose/);
    expect(lines[at + 1]).toMatch(/^7\. inbox/);
    expect(serverInstructions(false)).toBe(serverInstructions(false, false));
  });
});
