/**
 * One spelling for every path a safety check matches. A case-insensitive or normalization-insensitive file system (the
 * default on most desktop machines) opens `.Firetrident/x.json`, `claude.md` and `.MCP.json` as `.firetrident/x.json`,
 * `CLAUDE.md` and `.mcp.json`, and the tools that read those files follow it. So governance, handoff, sensitive paths,
 * protected paths, the `.git` checks and the trunk writer's case-collision check all compare this form, never the raw
 * path. Pure.
 */

/** Characters some file systems ignore in names: zero-width spaces, joiners and marks, bidirectional controls, the byte-order mark. */
const IGNORED = /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g;
const ASCII = /^[\x00-\x7f]*$/;

/**
 * `path` as a case-insensitive, normalization-insensitive file system sees it: NFC-normalized, ignorable characters
 * removed, and case-folded (upper case, then lower case, so the long s folds to "s" and the Kelvin sign to "k").
 */
export function foldPath(path: string): string {
  // Most paths are ASCII, which normalization and ignorable characters leave alone: lower case is the whole fold.
  if (ASCII.test(path)) return path.toLowerCase();
  return path.normalize("NFC").replace(IGNORED, "").toUpperCase().toLowerCase().normalize("NFC");
}
