import type { FileVersion, Path, Proposal, Sha } from "./types.ts";

/** Current trunk blob per path (null = absent). */
export type TrunkIndex = (path: Path) => Sha | null | undefined;

export interface OccResult {
  eligible: boolean;
  /** Paths whose trunk blob differs from what the proposal read or based its write on. */
  stale: Array<{ path: Path; expected: Sha | null; actual: Sha | null }>;
}

/**
 * Optimistic concurrency (Kung & Robinson): a proposal may land only if every path in
 * its read set still has the blob it read, and every path in its write set still has
 * the blob it had at the proposal's base (`baseBlobs`, which the caller derives from baseSha).
 */
export function validateProposal(p: Pick<Proposal, "readSet" | "writeSet">, trunk: TrunkIndex, baseBlobs: FileVersion[]): OccResult {
  throw new Error("not implemented");
}
