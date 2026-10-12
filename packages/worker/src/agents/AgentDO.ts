import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.ts";

/** Stub for in-platform agents (stream S4). See docs/ARCHITECTURE.md. */
export class AgentDO extends DurableObject<Env> {
  async ping(): Promise<string> {
    return "AgentDO";
  }
}
