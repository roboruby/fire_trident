import { DurableObject } from "cloudflare:workers";
import type { FileVersion, Id, Landing, LineageNote, Path, Proposal, RepoRef, Sha } from "@fire_trident/core";
import type { Env } from "../env.ts";

/**
 * The only writer of trunk (stream S3 implements). Holds a @cloudflare/computer
 * workspace with trunk cloned, a path → blob index of trunk HEAD, and lineage tables.
 */
export class TrunkDO extends DurableObject<Env> {
  async init(_p: { colonyId: Id; trunk: RepoRef }): Promise<{ trunkSha: Sha; files: number }> {
    throw new Error("TrunkDO.init not implemented");
  }
  async files(): Promise<Array<{ path: Path; size: number; blob: Sha }>> {
    throw new Error("TrunkDO.files not implemented");
  }
  async blobsFor(_paths: Path[]): Promise<Record<Path, Sha | null>> {
    throw new Error("TrunkDO.blobsFor not implemented");
  }
  async readFile(_path: Path): Promise<string | null> {
    throw new Error("TrunkDO.readFile not implemented");
  }
  async baseBlobs(_baseSha: Sha, _paths: Path[]): Promise<FileVersion[]> {
    throw new Error("TrunkDO.baseBlobs not implemented");
  }
  async land(_batch: Proposal[]): Promise<{ landing?: Landing; returned: Array<{ proposalId: Id; reason: string }> }> {
    throw new Error("TrunkDO.land not implemented");
  }
  async why(_path: Path, _line?: number): Promise<Array<{ landing: Landing; note: LineageNote }>> {
    throw new Error("TrunkDO.why not implemented");
  }
  async landings(_limit?: number): Promise<Landing[]> {
    throw new Error("TrunkDO.landings not implemented");
  }
}
