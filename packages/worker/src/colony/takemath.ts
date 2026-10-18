import { AGE_FACTOR_CAP, claimsByPath, combineClaims, revalidationEnabled } from "@fire_trident/core";
import type { FieldReading, Id, Path } from "@fire_trident/core";

/**
 * Two fixes to how take() weighs claims and age, each behind its own flag (read like FT_REVALIDATE: "on", or a
 * comma-separated list of colony ids; off when absent):
 * - FT_INHIBIT_STRONGEST: lateral inhibition reads the strongest single file's live claim among an intent's own files,
 *   where it summed them. Summed, a silent agent's claims on n shared files kept an intent inhibited for 5 * ln(2n)
 *   minutes (3.5 for one file, 18.4 for twenty); by the strongest file it is one half-life, about 3.5 minutes, however
 *   many files overlap. A file several agents claim still adds their claims on that file.
 * - FT_AGE_CAP: the stimulus's age multiplier (1 + ageMinutes / 10) stops at core AGE_FACTOR_CAP, so co-change and
 *   import repulsion keep holding back an old intent whose coupled files are claimed; off, it grows without bound.
 */

/** Is FT_INHIBIT_STRONGEST on for this colony? */
export function inhibitStrongestOn(setting: string | undefined, colonyId: Id): boolean {
  return revalidationEnabled(setting, colonyId);
}

/** The age cap take() passes to core chooseIntent for this colony: AGE_FACTOR_CAP where FT_AGE_CAP covers it, else uncapped. */
export function ageCapFor(setting: string | undefined, colonyId: Id): number {
  return revalidationEnabled(setting, colonyId) ? AGE_FACTOR_CAP : Number.POSITIVE_INFINITY;
}

/** What take() reads of one region for inhibition: claims per path (the reader's own removed), and recent claims not in the reading. */
export interface DirectView {
  byPath: FieldReading["byPath"];
  repulsive: boolean;
  unseen: ReadonlyArray<{ paths: ReadonlySet<Path> }>;
}

/**
 * Other agents' live claim on each of an intent's own files, as take() counts it for lateral inhibition: a repulsive
 * region's reading (core claimsByPath) plus `strength` for each recent claim the reading may not include. `regions` is
 * the intent's files by region; an unreadable region (no view) adds nothing (fail open, as take() does).
 */
export function directClaims(regions: ReadonlyMap<string, readonly Path[]>, views: ReadonlyMap<string, DirectView>, strength: number): Map<Path, number> {
  const out = new Map<Path, number>();
  for (const [region, paths] of regions) {
    const view = views.get(region);
    if (!view) continue;
    if (view.repulsive) claimsByPath(view.byPath, paths, out);
    for (const c of view.unseen) for (const p of paths) if (c.paths.has(p)) out.set(p, (out.get(p) ?? 0) + strength);
  }
  return out;
}

/** Take `amount` off one file's claim (never below 0): contest mode leaves contestants' claims out. */
export function lowerClaim(claims: Map<Path, number>, path: Path, amount: number): void {
  const v = claims.get(path);
  if (v !== undefined) claims.set(path, Math.max(0, v - amount));
}

/** The strongest single file's claim among `claims` (core combineClaims). */
export function strongestClaim(claims: ReadonlyMap<Path, number>): number {
  return combineClaims(claims.values(), "strongest");
}
