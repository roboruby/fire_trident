import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.ts";

/** Stub. See docs/ARCHITECTURE.md for the RPC contract of TrunkDO. */
export class TrunkDO extends DurableObject<Env> {
  async ping(): Promise<string> {
    return "TrunkDO";
  }
}
