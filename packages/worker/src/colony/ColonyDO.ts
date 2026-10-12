import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.ts";

/** Stub. See docs/ARCHITECTURE.md for the RPC contract of ColonyDO. */
export class ColonyDO extends DurableObject<Env> {
  async ping(): Promise<string> {
    return "ColonyDO";
  }
}
