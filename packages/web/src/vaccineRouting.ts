import { fmtInt, fmtPct } from "./format.ts";
import type { Vaccination } from "./store.ts";

/**
 * The vaccination result in words. Seeded bad changes are sealed and never land, so what review does with them is
 * routing: a model or a deterministic check returns some to their agents, and others go to a person, whose own catch
 * is not measured. Both together are what the meter's ring shows, so the words say "routed" and give the two apart,
 * never "recall" (the classes are named in review's own patterns and prompts).
 */

/** What the meter calls the number it shows. */
export const ROUTED_LABEL = "Vaccine routing";

/**
 * "28 of 28 routed away from landing: 7 returned by a model or a check, 21 sent to a person"; the share alone when the
 * colony reports no counts, the total alone when it reports no split, and a plain sentence before anything is judged.
 */
export function routedLine(v: Vaccination | null): string {
  const none = "no seeded change judged yet";
  if (!v) return none;
  const n = v.seeded !== null && v.seeded > 0 ? v.seeded : null;
  const split = v.returned !== null && v.escalated !== null ? { returned: v.returned, escalated: v.escalated } : null;
  const routed = v.caught ?? (split ? split.returned + split.escalated : null);
  const head =
    n !== null && routed !== null
      ? `${fmtInt(Math.min(routed, n))} of ${fmtInt(n)} routed away from landing`
      : v.recall !== null
        ? `${fmtPct(v.recall)} routed away from landing`
        : null;
  if (head === null) return none;
  return split ? `${head}: ${fmtInt(split.returned)} returned by a model or a check, ${fmtInt(split.escalated)} sent to a person` : head;
}
