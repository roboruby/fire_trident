import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AgentInfo, Colony, Intent } from "@fire_trident/core";
import { FORCE_ARGUMENT, TWIN_DESCRIPTION, twinNote, type DeclareAnswer } from "../../src/colony/twins.ts";
import { FireTridentMcp } from "../../src/mcp/FireTridentMcp.ts";
import { FireTridentTools } from "../../src/mcp/tools.ts";
import type { McpColonyRpc, Session, ToolContext } from "../../src/mcp/tools.ts";

/**
 * Twin intents at the MCP door (FT_TWINS): declare passes force to the colony and returns a twin as the colony answers
 * it, the intent it duplicates with duplicateOf, similar and the note; a twin creates nothing, so the session keeps
 * nothing to replay. The declare tool offers force and says what a twin answers only where the deployment catches
 * twins for some colony, and docs/agents says the same sentence.
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

type IntentInput = Omit<Intent, "id" | "status" | "createdAt">;

const colonyInfo: Colony = { id: "col", name: "Colony", trunk: { namespace: "ft-trunk", name: "col--trunk", remote: "https://trunk.invalid/col--trunk.git" }, trunkSha: "b".repeat(40), createdAt: 0, regionDepth: 1 };
const existing: Intent = { id: "int_rate", colonyId: "col", title: "Add rate limiting to /api/links", why: "w", source: "human", footprint: ["src/links/**"], priority: 1, status: "open", createdAt: 0, createdBy: "person" };

/** A session over a fake colony whose declareIntent finds `existing` a twin of any title mentioning the links API. */
function setup() {
  const agents: AgentInfo[] = [];
  const calls: Array<{ input: IntentInput; opts: { force?: boolean } | undefined }> = [];
  let created = 0;
  const colony = {
    async getColony(): Promise<Colony | null> {
      return colonyInfo;
    },
    async registerAgent(a: { kind: AgentInfo["kind"]; name: string }): Promise<AgentInfo> {
      const info: AgentInfo = { id: `agt_${agents.length + 1}`, colonyId: "col", kind: a.kind, name: a.name, thresholds: {}, state: "idle", lastSeen: 0 };
      agents.push(info);
      return info;
    },
    async heartbeat(): Promise<void> {},
    async addIntent(): Promise<Intent> {
      throw new Error("declare goes through declareIntent where the colony has it");
    },
    async declareIntent(input: IntentInput, opts?: { force?: boolean }): Promise<DeclareAnswer> {
      calls.push({ input, opts });
      if (opts?.force !== true && /links api/i.test(input.title)) {
        const similar = [{ id: existing.id, title: existing.title, status: existing.status, score: 1 }];
        return { intent: existing, duplicateOf: existing.id, similar, note: twinNote(existing) };
      }
      return { intent: { ...input, id: `int_new${++created}`, status: "open", createdAt: 0 } };
    },
  };
  let session: Session = { reads: {}, proposals: [] };
  const ctx: ToolContext = {
    colony: () => colony as unknown as McpColonyRpc,
    region: () => {
      throw new Error("not used");
    },
    trunk: () => ({ why: async () => [] }),
    repo: async () => {
      throw new Error("not used");
    },
    load: async () => structuredClone(session),
    save: async (s) => {
      session = structuredClone(s);
    },
    now: () => 5_000_000,
    sleep: async () => undefined,
  };
  return { tools: new FireTridentTools(ctx), calls, session: () => session };
}

const ask = { title: "Rate-limit the links API", why: "Abuse", footprint: ["src/links/handler.ts"] };

describe("MCP declare with twin intents", () => {
  it("returns the twin as the colony answers it, and creates nothing", async () => {
    const { tools, calls, session } = setup();
    await tools.join({ colony: "col" });
    const got = (await tools.declare(ask)) as Record<string, any>;
    expect(got).toEqual({
      intent: { id: "int_rate", title: existing.title, status: "open", footprint: ["src/links/**"], parentId: null },
      duplicateOf: "int_rate",
      similar: [{ id: "int_rate", title: existing.title, status: "open", score: 1 }],
      note: `This looks like int_rate "${existing.title}" (open): take that one, or declare again with force: true if yours is different work.`,
    });
    expect(calls).toEqual([{ input: expect.objectContaining({ title: ask.title, source: "agent", footprint: ask.footprint }), opts: {} }]);
    expect(session().declared ?? []).toEqual([]);
  });

  it("passes force to the colony, and replays the intent force created, not the twin", async () => {
    const { tools, calls } = setup();
    await tools.join({ colony: "col" });
    expect(await tools.declare(ask)).toHaveProperty("duplicateOf", "int_rate");
    const forced = (await tools.declare({ ...ask, force: true })) as Record<string, any>;
    expect(forced).toEqual({ intent: { id: "int_new1", title: ask.title, status: "open", footprint: ask.footprint, parentId: null } });
    expect(calls.map((c) => c.opts)).toEqual([{}, { force: true }]);
    // The same content again is the intent force declared, replayed.
    expect(await tools.declare(ask)).toMatchObject({ intent: { id: "int_new1" }, replayed: true });
    expect(calls).toHaveLength(2);
  });
});

/** The declare tool as an MCP client lists it from a server started with `env`. */
async function declareTool(env: Record<string, string>): Promise<{ description: string; args: string[] }> {
  const server = new FireTridentMcp({} as never, env as never);
  await server.init();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.server.connect(serverSide);
  const client = new Client({ name: "twins-test", version: "0.0.0" });
  await client.connect(clientSide);
  try {
    const tool = (await client.listTools()).tools.find((t) => t.name === "declare");
    return { description: tool?.description ?? "", args: Object.keys(tool?.inputSchema.properties ?? {}) };
  } finally {
    await client.close();
  }
}

describe("the declare tool", () => {
  it("offers force and says what a twin answers where FT_TWINS covers some colony, and nothing new elsewhere", async () => {
    for (const setting of ["on", "shortlinks"]) {
      const on = await declareTool({ FT_TWINS: setting });
      expect(on.description.endsWith(` ${TWIN_DESCRIPTION}`), setting).toBe(true);
      expect(on.args).toContain("force");
    }
    const off = await declareTool({});
    expect(off.description).not.toContain("twin");
    expect(off.args).toEqual(["title", "why", "footprint", "acceptance", "priority", "parentId"]);
    expect(FORCE_ARGUMENT).toMatch(/duplicateOf/);
  });

  it("says the same sentence in docs/agents", async () => {
    const FS = "node:fs";
    const { readFileSync } = (await import(FS)) as { readFileSync(path: URL, encoding: "utf8"): string };
    const url = new URL("../../../../docs/agents/README.md", (import.meta as ImportMeta & { url: string }).url);
    expect(readFileSync(url, "utf8").replace(/`/g, "")).toContain(TWIN_DESCRIPTION);
  });
});
