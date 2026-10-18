import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { FireTridentMcp } from "../../../src/mcp/FireTridentMcp.ts";
import { PublicTools, publicServer } from "../../../src/mcp/public.ts";
import { serveReviewMcp } from "../../../src/mcp/review/server.ts";
import { fakeColony } from "./fixtures.ts";

/**
 * No agent can decide: the agents' MCP (/mcp, FT_MCP_TOKEN) and the public MCP have no tool that approves, rejects or
 * returns a change, and no MCP module but the review endpoint's calls a colony's decide. The review endpoint, the one MCP
 * door to a decision, refuses the agents' token.
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

/** The part of node:fs these tests use (the worker compiles against workers types, not Node's). */
interface Fs {
  readdirSync(path: URL, opts: { recursive: true }): string[];
  readFileSync(path: URL, encoding: "utf8"): string;
}
const FS = "node:fs";
const fs = (await import(FS)) as Fs;
const SRC = new URL("../../../src/", (import.meta as ImportMeta & { url: string }).url);

async function listed(connect: (c: Client) => Promise<void>): Promise<Tool[]> {
  const client = new Client({ name: "no-decide-test", version: "0.0.0" });
  await connect(client);
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close();
  }
}

/** Every tool /mcp registers, under every flag that changes its tool list or its arguments. */
async function agentTools(): Promise<Tool[]> {
  const all: Tool[] = [];
  const flags = { FT_INLINE: "on", FT_FIELD_GUIDE: "on", FT_TWINS: "on", FT_REPRODUCE: "on", FT_HEADS_UP: "on" };
  for (const env of [{}, flags, ...Object.entries(flags).map(([k, v]) => ({ [k]: v }))]) {
    const server = new FireTridentMcp({} as never, env as never);
    await server.init();
    all.push(
      ...(await listed(async (client) => {
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        await server.server.connect(serverSide);
        await client.connect(clientSide);
      })),
    );
  }
  return all;
}

async function publicTools(): Promise<Tool[]> {
  const server = publicServer(new PublicTools({ colonies: new Set(["demo"]), reads: {} as never }), ["demo"]);
  return listed(async (client) => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    await client.connect(clientSide);
  });
}

/** Why a tool could decide a change, or null: its name, or an argument that names a decision. */
function decides(t: Tool): string | null {
  if (/decid|approv|reject|review/i.test(t.name)) return `its name ${t.name}`;
  const props = Object.keys((t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
  const arg = props.find((p) => /^(?:decision|verdict|approve|approved|reject)$/i.test(p));
  return arg ? `its argument ${arg}` : null;
}

describe("no agent can decide", () => {
  it("/mcp lists no tool that decides, under any flag", async () => {
    const tools = await agentTools();
    expect(tools.length).toBeGreaterThan(10);
    expect(tools.map((t) => [t.name, decides(t)]).filter(([, why]) => why !== null)).toEqual([]);
  });

  it("the public MCP lists no tool that decides", async () => {
    const tools = await publicTools();
    expect(tools.length).toBe(5);
    expect(tools.map((t) => [t.name, decides(t)]).filter(([, why]) => why !== null)).toEqual([]);
  });

  it("no MCP module but the review endpoint's calls a colony's decide", () => {
    const files = fs.readdirSync(new URL("mcp/", SRC), { recursive: true }).filter((f) => f.endsWith(".ts"));
    const calling = files.filter((f) => /\.decide(?:Batch)?\(/.test(fs.readFileSync(new URL(`mcp/${f}`, SRC), "utf8"))).sort();
    expect(calling).toEqual(["review/server.ts"]);
  });

  it("the review endpoint refuses the agents' MCP token", async () => {
    const res = await serveReviewMcp(
      new Request("https://ft.test/mcp/review", {
        method: "POST",
        headers: { authorization: "Bearer mcp-s3cret", "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
      { colonies: fakeColony([]).colonies, env: { FT_ADMIN_TOKEN: "admin-s3cret", FT_MCP_TOKEN: "mcp-s3cret" } },
    );
    expect(res.status).toBe(401);
  });
});
