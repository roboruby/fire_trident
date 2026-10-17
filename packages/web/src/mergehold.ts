import type { HeldDiff, HeldMergeFile, Proposal } from "@fire_trident/core";

/**
 * A merge the trunk writer held for a person instead of landing it (merge locks): the change was decided against an
 * older trunk, and trunk has since changed files it writes. The proposal carries each such file (`mergeHold`) with its
 * blobs and, for the first files, two masked diffs: what trunk changed since the change's base, and the merged result
 * against the version that was decided on. Repository text is shown as text, never as markup; everything is read
 * defensively.
 */

/** One held file as the review card shows it; a diff the server did not keep is null. */
export interface HeldFileView {
  path: string;
  base: string;
  trunk: string;
  theirs: string;
  result: string;
  by?: string;
  trunkDiff: HeldDiff | null;
  mergedDiff: HeldDiff | null;
}

const text = (v: unknown): string => (typeof v === "string" ? v : "");
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

function diffOf(v: unknown): HeldDiff | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const d = v as Record<string, unknown>;
  if (typeof d.hunks !== "string") return null;
  return { hunks: d.hunks, added: count(d.added), removed: count(d.removed), truncated: d.truncated === true };
}

/** The held merge a review queue item carries, file by file; null when it carries none. */
export function mergeHoldOf(item: Proposal): HeldFileView[] | null {
  const raw = (item as Proposal & { mergeHold?: unknown }).mergeHold;
  if (!Array.isArray(raw)) return null;
  const files: HeldFileView[] = [];
  for (const x of raw as unknown[]) {
    if (!x || typeof x !== "object" || Array.isArray(x)) continue;
    const f = x as Partial<Record<keyof HeldMergeFile, unknown>>;
    if (typeof f.path !== "string" || f.path === "") continue;
    const by = text(f.by);
    files.push({
      path: f.path,
      base: text(f.base),
      trunk: text(f.trunk),
      theirs: text(f.theirs),
      result: text(f.result),
      ...(by ? { by } : {}),
      trunkDiff: diffOf(f.trunkDiff),
      mergedDiff: diffOf(f.mergedDiff),
    });
  }
  return files.length > 0 ? files : null;
}

/** A blob id as the card names it (its first ten characters), or "unknown". */
export function shortBlob(blob: string): string {
  return blob ? blob.slice(0, 10) : "unknown";
}
