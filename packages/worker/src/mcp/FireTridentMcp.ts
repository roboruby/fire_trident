import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { RepoRef } from "@fire_trident/core";
import type { Env } from "../env.ts";
import { artifactsFor, colonyStub, errorMessage, errorStatus, regionStub, trunkStub } from "../agents/rpc.ts";
import { withArtifactsRetry } from "../artifacts/git.ts";
import { SERVER_INSTRUCTIONS } from "./instructions.ts";
import { FireTridentTools, MAX_WAIT_S } from "./tools.ts";
import type { McpColonyRpc, RepoReader, Session, ToolContext } from "./tools.ts";

const SESSION_KEY = "ft:session";

/** Release a binding RPC stub (Disposable) without depending on the esnext lib typings. */
function release(x: unknown): void {
  const key = (Symbol as unknown as { dispose?: symbol }).dispose;
  if (!key || !x || typeof x !== "object") return;
  const fn = (x as Record<symbol, unknown>)[key];
  if (typeof fn === "function") {
    try {
      (fn as () => void).call(x);
    } catch {
      // Already released.
    }
  }
}

function ok(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function failed(e: unknown): CallToolResult {
  const status = errorStatus(e);
  return { isError: true, content: [{ type: "text", text: status ? `${errorMessage(e)} (${status})` : errorMessage(e) }] };
}

async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return ok(await fn());
  } catch (e) {
    return failed(e);
  }
}

const path = z.string().min(1).max(1024);
const wait = z.number().min(0).max(MAX_WAIT_S).optional();

/**
 * The FireTrident MCP server for external coding agents. Each MCP session is its
 * own Durable Object (binding MCP) holding the session's agent id, current
 * intent, lease and read set. Tools: join, sense, take, checkout, declare, read,
 * propose, inbox, release, why. Served over Streamable HTTP at /mcp and legacy SSE at /sse.
 */
export class FireTridentMcp extends McpAgent<Env, Record<string, never>, Record<string, unknown>> {
  server = new McpServer({ name: "firetrident", version: "0.0.1" }, { instructions: SERVER_INSTRUCTIONS });

  private context(): ToolContext {
    const env = this.env;
    const storage = this.ctx.storage;
    return {
      colony: (colonyId) => colonyStub(env, colonyId) as McpColonyRpc,
      region: (colonyId, region) => regionStub(env, colonyId, region),
      trunk: (colonyId) => trunkStub(env, colonyId),
      repo: async (ref: Pick<RepoRef, "namespace" | "name">): Promise<RepoReader> => {
        const ns = artifactsFor(env, ref.namespace);
        if (!ns) throw new Error(`[ft:400] no binding serves namespace ${ref.namespace}`);
        const r = await withArtifactsRetry(() => ns.get(ref.name));
        return {
          readCommit: (h) => withArtifactsRetry(() => r.readCommit(h)),
          readTree: (h) => withArtifactsRetry(() => r.readTree(h)),
          readBlob: (h) => withArtifactsRetry(() => r.readBlob(h)),
          release: () => release(r),
        };
      },
      load: async () => (await storage.get<Session>(SESSION_KEY)) ?? { reads: {}, proposals: [] },
      save: async (s) => {
        await storage.put(SESSION_KEY, s);
      },
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    };
  }

  private toolsInstance: FireTridentTools | null = null;

  /** One tools instance per session object, so parallel tool calls share its write queue. */
  private tools(): FireTridentTools {
    this.toolsInstance ??= new FireTridentTools(this.context());
    return this.toolsInstance;
  }

  async init(): Promise<void> {
    const readOnly = { readOnlyHint: true, openWorldHint: false };

    this.server.registerTool(
      "join",
      {
        title: "Join a colony",
        description: "Join a FireTrident colony as an external agent. Returns your agent id for this session. Pass agentId to resume an identity from an earlier session.",
        inputSchema: {
          colony: z.string().min(1).max(100).describe("Colony id"),
          name: z.string().max(100).optional().describe("A name for this agent (shown in the colony UI)"),
          model: z.string().max(200).optional().describe("The model driving this agent, for lineage"),
          agentId: z.string().max(100).optional().describe("Resume this external agent id instead of registering a new one"),
        },
        annotations: { idempotentHint: true, openWorldHint: false },
      },
      async (a) => run(() => this.tools().join(a)),
    );

    this.server.registerTool(
      "sense",
      {
        title: "Read the field",
        description:
          "Field readings (claims, needs, trails, failures, danger) for the regions of the given paths or for the given regions, plus which agents work there and whether the region admits new agents. With no arguments: your current intent's footprint, or every region of the colony before you take work.",
        inputSchema: {
          paths: z.array(path).max(200).optional().describe("Repository paths"),
          regions: z.array(z.string().max(1024)).max(50).optional().describe("Region names (directory prefixes, '.' for root files)"),
        },
        annotations: readOnly,
      },
      async (a) => run(() => this.tools().sense(a)),
    );

    this.server.registerTool(
      "take",
      {
        title: "Take work",
        description:
          "Self-assign an intent. Returns the intent (what to change, why, footprint), its rule if any, review when there is something to say (the questions review will ask of your change, learned from changes a person rejected, and the colony's rules for these paths), a workspace lease with a trunk read token and a workspace write token, and self-contained git commands that use them. When there is no work it returns wait; pass wait (seconds) to let the server keep trying for you.",
        inputSchema: { wait: wait.describe(`Seconds to keep trying while there is no work for you (at most ${MAX_WAIT_S})`) },
        annotations: { openWorldHint: false },
      },
      async (a) => run(() => this.tools().take(a)),
    );

    this.server.registerTool(
      "checkout",
      {
        title: "Show the lease",
        description: "The intent, review questions, lease, tokens and git commands for the work you currently hold (same as take returned).",
        inputSchema: {},
        annotations: readOnly,
      },
      async () => run(() => this.tools().checkout()),
    );

    this.server.registerTool(
      "declare",
      {
        title: "Declare an intent",
        description: "Declare a new intent with a predicted footprint before writing code. By default it becomes a child of the intent you hold.",
        inputSchema: {
          title: z.string().min(1).max(500),
          why: z.string().max(20_000),
          footprint: z.array(path).min(1).max(200).describe("Paths, directories (trailing /) or globs the change is expected to touch"),
          acceptance: z.array(z.string().max(2_000)).max(50).optional(),
          priority: z.number().min(0).max(1_000).optional(),
          parentId: z.string().max(100).optional(),
        },
        annotations: { openWorldHint: false },
      },
      async (a) => run(() => this.tools().declare(a)),
    );

    this.server.registerTool(
      "read",
      {
        title: "Read a trunk file",
        description:
          "Read a file at your lease's base commit. Records (path, blob) in your read set, which decides whether your proposal is still valid when it reaches trunk. Read every file your change depends on.",
        inputSchema: { path: path.describe("Repository path") },
        annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
      },
      async (a) => run(() => this.tools().read(a)),
    );

    this.server.registerTool(
      "propose",
      {
        title: "Propose your change",
        description:
          "Propose the commit you pushed to refs/heads/main of your workspace. The server computes the files you wrote by diffing your commit against the lease base; your read set comes from read calls in this session. Say what you did not verify in notVerified: reviewers see it.",
        inputSchema: {
          headSha: z.string().regex(/^[0-9a-fA-F]{40}$/).describe("Full commit id of your pushed head"),
          summary: z.string().max(2_000).optional().describe("One-paragraph summary of the change"),
          notVerified: z.string().max(5_000).optional().describe("What you did not check (tests not run, platforms not tried, ...)"),
        },
        annotations: { openWorldHint: false },
      },
      async (a) => run(() => this.tools().propose(a)),
    );

    this.server.registerTool(
      "inbox",
      {
        title: "Proposal outcomes",
        description:
          "Status of your proposals, newest first: checking, ready, landed, returned (with the reason), rejected, or escalated. Pass wait (seconds) to block until your latest proposal (or proposalId) is decided; repeat until it is final.",
        inputSchema: {
          limit: z.number().int().min(1).max(50).optional(),
          proposalId: z.string().max(100).optional().describe("The proposal to watch (default: your latest)"),
          wait: wait.describe(`Seconds to wait for the watched proposal to be decided (at most ${MAX_WAIT_S})`),
        },
        annotations: readOnly,
      },
      async (a) => run(() => this.tools().inbox(a)),
    );

    this.server.registerTool(
      "release",
      {
        title: "Give work back",
        description: "Give back the intent you hold without proposing (you cannot finish it): it reopens for other agents and your workspace lease ends.",
        inputSchema: { reason: z.string().max(500).optional().describe("Why you are giving it back") },
        annotations: { destructiveHint: false, openWorldHint: false },
      },
      async (a) => run(() => this.tools().release(a)),
    );

    this.server.registerTool(
      "why",
      {
        title: "Why is this here",
        description: "Lineage of a trunk path, or one line of it: the landings, intents, agents, read and write sets, review decisions and evidence that produced it.",
        inputSchema: { path: path.describe("Repository path"), line: z.number().int().min(1).optional() },
        annotations: readOnly,
      },
      async (a) => run(() => this.tools().why(a)),
    );
  }
}
