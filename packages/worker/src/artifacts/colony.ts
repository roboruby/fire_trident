import type { Id, RepoRef, Sha } from "@fire_trident/core";
import type { Env } from "../env.ts";

/**
 * Create the colony's trunk repo in Artifacts: import from a public git URL when
 * `source` is given (waiting until the import is ready), otherwise create an empty
 * repo with an initial commit. Stream S3 implements.
 */
export async function provisionTrunk(_env: Env, _colonyId: Id, _source?: { url: string; branch?: string }): Promise<{ trunk: RepoRef; trunkSha: Sha }> {
  throw new Error("provisionTrunk not implemented");
}
