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
 *
 * `undefined` from the trunk index and a write path missing from `baseBlobs` both mean absent (null).
 * Every stale path is reported (reads first, then writes); an identical repeat is reported once.
 */
export function validateProposal(p: Pick<Proposal, "readSet" | "writeSet">, trunk: TrunkIndex, baseBlobs: FileVersion[]): OccResult {
  const base = new Map<Path, Sha | null>();
  for (const f of baseBlobs) base.set(f.path, f.blob ?? null);
  const stale: OccResult["stale"] = [];
  const reported = new Set<string>();
  const check = (path: Path, expected: Sha | null): void => {
    const actual = trunk(path) ?? null;
    if (actual === expected) return;
    const key = `${path}\u0000${expected}\u0000${actual}`;
    if (reported.has(key)) return;
    reported.add(key);
    stale.push({ path, expected, actual });
  };
  for (const r of p.readSet) check(r.path, r.blob ?? null);
  for (const w of p.writeSet) check(w.path, base.get(w.path) ?? null);
  return { eligible: stale.length === 0, stale };
}
