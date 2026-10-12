// Internal text helpers shared by morph.ts and lineage.ts (not re-exported from index.ts).

/** Collapse every whitespace run (newlines included) to one space and trim, so user text stays on one line. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Shorten `text` to at most `max` UTF-16 units, ending in "…" when cut and never splitting a surrogate pair. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max < 1) return "";
  let end = max - 1;
  const last = text.charCodeAt(end - 1);
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end--;
  return `${text.slice(0, end).trimEnd()}…`;
}
