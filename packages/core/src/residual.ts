import type { FileVersion, Path } from "./types.ts";
import { globMatch } from "./morph.ts";

/**
 * Does one footprint entry cover a concrete path? An entry is an exact path, a directory
 * prefix ending in "/" (everything below it), or a glob. A leading "./" is ignored and an
 * empty entry covers nothing.
 */
export function footprintCovers(entry: string, path: Path): boolean {
  const e = entry.startsWith("./") ? entry.slice(2) : entry;
  if (e === "") return false;
  if (e === path) return true;
  if (e.endsWith("/")) return path.startsWith(e) || globMatch(`${e}**/*`, path);
  return globMatch(e, path);
}

/** Symmetric overlap of two footprint entries or paths: either one covers the other. */
export function pathsOverlap(a: string, b: string): boolean {
  return footprintCovers(a, b) || footprintCovers(b, a);
}

/**
 * Paths written that the declared footprint did not predict (globs allowed in the footprint).
 * Each path appears once, in write-set order; deletions (blob null) count as writes.
 */
export function residualPaths(declaredFootprint: Path[], writeSet: FileVersion[]): Path[] {
  const residual: Path[] = [];
  const seen = new Set<Path>();
  for (const { path } of writeSet) {
    if (seen.has(path)) continue;
    seen.add(path);
    if (!declaredFootprint.some((entry) => footprintCovers(entry, path))) residual.push(path);
  }
  return residual;
}
