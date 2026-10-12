import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.ts";

/** Stub for the MCP server (stream S4 replaces with an agents/mcp McpAgent). */
export class FireTridentMcp extends DurableObject<Env> {
  async ping(): Promise<string> {
    return "FireTridentMcp";
  }
}
