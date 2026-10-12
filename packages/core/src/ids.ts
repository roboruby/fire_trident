import type { Id, Path } from "./types.ts";

/** Time-sortable id: base36 millis + random suffix, with an optional prefix ("int_", "prp_", ...). */
export function newId(prefix = ""): Id {
  throw new Error("not implemented");
}

/** The region a path belongs to: its first `depth` directory segments ("." for root files). */
export function regionOf(path: Path, depth = 1): string {
  throw new Error("not implemented");
}

/** Stable id for a region's Durable Object: `${colonyId}:${region}`. */
export function regionKey(colonyId: Id, region: string): string {
  return `${colonyId}:${region}`;
}
