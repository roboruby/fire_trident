import type { Id, Path } from "./types.ts";

/** Width of the base36 millisecond field. Fixed so ids sort by time (8 digits cover 1972 to 2059). */
const TIME_WIDTH = 8;
const RANDOM_CHARS = 6;
const GLOB_CHARS = /[*?{]/;

/** Time-sortable id: base36 millis + random suffix, with an optional prefix ("int_", "prp_", ...). */
export function newId(prefix = ""): Id {
  const time = Date.now().toString(36).padStart(TIME_WIDTH, "0");
  let suffix = "";
  for (let i = 0; i < RANDOM_CHARS; i++) suffix += (Math.floor(Math.random() * 36) % 36).toString(36);
  return prefix + time + suffix;
}

/**
 * The region a path belongs to: its first `depth` directory segments ("." for root files).
 * A path with fewer directories than `depth` uses all of them. A trailing "/" marks the whole
 * path as a directory, and a glob segment ends the prefix, so a footprint entry maps to its
 * static directory instead of a region named after a wildcard.
 */
export function regionOf(path: Path, depth = 1): string {
  const max = Number.isNaN(depth) ? 1 : Math.floor(depth);
  const segments = path.split("/").filter((s) => s !== "" && s !== ".");
  const dirs = path.endsWith("/") ? segments : segments.slice(0, -1);
  const kept: string[] = [];
  for (const dir of dirs) {
    if (kept.length >= max || GLOB_CHARS.test(dir)) break;
    kept.push(dir);
  }
  return kept.length > 0 ? kept.join("/") : ".";
}

/** Stable id for a region's Durable Object: `${colonyId}:${region}`. */
export function regionKey(colonyId: Id, region: string): string {
  return `${colonyId}:${region}`;
}
