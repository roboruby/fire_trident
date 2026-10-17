import type { LandingTests, LineageNote, Path, WhyHolds, WhyWalk } from "@fire_trident/core";
import { coverText, holdsText, walkLines, type CertNow } from "./whyholds.ts";
import type { Colors } from "./format.ts";

/**
 * Today in `ft why` (trunk/whywalk.ts on the server, core/whyholds.ts for the words): under the heading of a line's
 * lineage, how the walk found the landing that wrote it (the formatting-only landings it skipped, the moves it followed),
 * and on each landing a `holds` row: the file as it wrote it, changed since or deleted, the other files it wrote or read
 * that changed, and the current certification of the tests that cover it, from its test row's closure data where `ft why`
 * read one, else the status read's latest certification.
 */

/** The walk's lines under the heading, dimmed; none for a file, or from a server before the walk. */
export function walkRows(walk: WhyWalk | undefined, target: { path: Path; line?: number }, c: Colors): string[] {
  if (target.line === undefined) return [];
  return walkLines(walk, { path: target.path, line: target.line }).map((l) => `  ${c.dim(l)}`);
}

/** One landing's holds row, yellow when the file it wrote changed or went since; null from a server before holds. */
export function holdsRow(entry: { holds?: WhyHolds; note?: Pick<LineageNote, "proposals"> }, row: LandingTests | undefined, now: CertNow | undefined, c: Colors): string | null {
  const h = entry.holds;
  if (!h) return null;
  const wrote: Path[] = [];
  for (const p of Array.isArray(entry.note?.proposals) ? entry.note.proposals : []) for (const w of Array.isArray(p?.writeSet) ? p.writeSet : []) if (typeof w?.path === "string") wrote.push(w.path);
  const text = holdsText(h, coverText(row, now, wrote));
  if (!text) return null;
  return h.wrote?.state === "same" ? text : c.yellow(text);
}
