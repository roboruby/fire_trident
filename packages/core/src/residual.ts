import type { FileVersion, Path } from "./types.ts";

/** Paths written that the declared footprint did not predict (globs allowed in the footprint). */
export function residualPaths(declaredFootprint: Path[], writeSet: FileVersion[]): Path[] {
  throw new Error("not implemented");
}
