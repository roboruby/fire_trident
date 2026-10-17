import type { HeldDiff, Proposal } from "@fire_trident/core";
import type { Colors } from "./format.ts";
import { parseHunks, visible, type DiffLine } from "./review.ts";

/**
 * A merge the trunk writer held for a person in `ft review` (merge locks): the change was decided against an older trunk
 * and trunk has since changed files it writes. For each such file the proposal carries (`mergeHold`) its blobs and, for
 * the first files, what trunk changed since the change's base and the merged result against the version decided on.
 * Approving the change lands exactly that merge. Read defensively; repository text is printed as text.
 */

/** Lines of one held diff printed at most (the server keeps about 60). */
const HELD_LINES = 60;

const text = (v: unknown): string => (typeof v === "string" ? v : "");
const short = (blob: unknown): string => text(blob).slice(0, 10) || "unknown";

function diffOf(v: unknown): HeldDiff | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const d = v as Record<string, unknown>;
  if (typeof d.hunks !== "string") return null;
  const n = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) && x > 0 ? Math.floor(x) : 0);
  return { hunks: d.hunks, added: n(d.added), removed: n(d.removed), truncated: d.truncated === true };
}

/** The held merge's lines of one review queue item, or none; `diffText` prints one diff line as the rest of the review does. */
export function heldLines(p: Proposal, c: Colors, diffText: (l: DiffLine) => string): string[] {
  const raw = (p as Proposal & { mergeHold?: unknown }).mergeHold;
  const files = (Array.isArray(raw) ? (raw as unknown[]) : []).filter(
    (f): f is Record<string, unknown> => !!f && typeof f === "object" && !Array.isArray(f) && typeof (f as Record<string, unknown>).path === "string" && (f as Record<string, unknown>).path !== "",
  );
  if (files.length === 0) return [];
  const out = [`  ${c.bold("trunk moved since this was decided")}  ${c.yellow(files.length === 1 ? "approving lands this merge" : `approving lands these ${files.length} merged files`)}`];
  for (const f of files) {
    const by = text(f.by);
    out.push(`    ${visible(text(f.path))}  ${c.dim(`${short(f.base)} at its base, ${short(f.trunk)} on trunk${by ? ` from ${visible(by)}` : ""}, decided on ${short(f.theirs)}, merged as ${short(f.result)}`)}`);
    for (const [title, d] of [
      ["what trunk changed since the change's base", diffOf(f.trunkDiff)],
      ["the merged result against the version decided on", diffOf(f.mergedDiff)],
    ] as const) {
      out.push(`      ${c.dim(title)}${d ? `  ${c.green(`+${d.added}`)} ${c.red(`−${d.removed}`)}${d.truncated ? c.yellow("  truncated") : ""}` : c.dim(": not kept")}`);
      for (const l of d ? parseHunks(d.hunks).slice(0, HELD_LINES) : []) out.push(`        ${diffText(l)}`);
    }
  }
  return out;
}
