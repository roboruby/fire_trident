import { DurableObject } from "cloudflare:workers";
import type { Id, RepoRef, Sha, WorkspaceLease } from "@fire_trident/core";
import type { Env } from "../env.ts";

/** Warm pool of workspace forks grown by fork trees (stream S3 implements). */
export class PoolDO extends DurableObject<Env> {
  async init(_p: { colonyId: Id; trunk: RepoRef; target: number }): Promise<void> {
    throw new Error("PoolDO.init not implemented");
  }
  async lease(_agentId: Id, _trunkSha: Sha): Promise<WorkspaceLease | null> {
    throw new Error("PoolDO.lease not implemented");
  }
  async release(_agentId: Id): Promise<void> {
    throw new Error("PoolDO.release not implemented");
  }
  async status(): Promise<{ ready: number; leased: number; forking: number; target: number }> {
    throw new Error("PoolDO.status not implemented");
  }
}
