/**
 * Import-aware repulsion for take() (ANALYSIS, not built). A claim on a file that a candidate's
 * files import, or on a file that imports them, repels the candidate, the way ColonyDO.take adds
 * co-change repulsion. In the history workload an agent reads the direct imports of the files it
 * writes, so these claims are the landings that would make its reads stale, and the agents whose
 * reads its own landing would make stale.
 */
import { neighborRepulsion } from "@fire_trident/core";
import type { Neighbor } from "@fire_trident/core";
import type { WorkloadModel } from "../workload.ts";
import type { ExtraRepulsion } from "./fire.ts";

/** Direct relative imports and importers of every model file that has either, by file name. */
export function importTable(model: Pick<WorkloadModel, "files" | "imports">): Map<string, string[]> {
  const sets = new Map<string, Set<string>>();
  const link = (a: string, b: string): void => {
    if (a === b) return;
    let s = sets.get(a);
    if (!s) {
      s = new Set();
      sets.set(a, s);
    }
    s.add(b);
  };
  model.imports.forEach((imports, i) => {
    const from = model.files[i];
    if (from === undefined) return;
    for (const j of imports ?? []) {
      const to = model.files[j];
      if (to === undefined) continue;
      link(from, to);
      link(to, from);
    }
  });
  return new Map([...sets].map(([f, s]) => [f, [...s].sort()]));
}

/**
 * Import neighbors of monorepo paths `p<k>/<file>` (see HistoryWorkload): the file's direct imports
 * and importers inside the same package copy, each at weight 1. Cached per path.
 */
export function monorepoImports(table: Map<string, string[]>): (path: string) => Neighbor[] | undefined {
  const cache = new Map<string, Neighbor[] | undefined>();
  return (path) => {
    if (cache.has(path)) return cache.get(path);
    const slash = path.indexOf("/");
    let out: Neighbor[] | undefined;
    if (slash > 0) {
      const prefix = path.slice(0, slash + 1);
      out = table.get(path.slice(slash + 1))?.map((f) => ({ path: prefix + f, weight: 1 }));
    }
    cache.set(path, out);
    return out;
  };
}

/**
 * Extra repulsion of `weight` times core neighborRepulsion over import neighbors: every distinct
 * import or importer outside the candidate's footprint adds the claim other agents hold on it.
 */
export function importRepulsion(neighbors: (path: string) => Neighbor[] | undefined, weight: number): ExtraRepulsion {
  return (t, claimOn) => weight * neighborRepulsion(t.writes, neighbors, claimOn);
}

/** The sum of several extra repulsions (for example co-change plus imports). */
export function sumRepulsion(...parts: ExtraRepulsion[]): ExtraRepulsion {
  return (t, claimOn) => parts.reduce((total, f) => total + f(t, claimOn), 0);
}

/** The `k` model files with the most direct importers, most first (ties by name). */
export function mostImported(model: Pick<WorkloadModel, "files" | "imports">, k: number): string[] {
  const fanIn = new Map<number, number>();
  for (const imports of model.imports) for (const j of new Set(imports ?? [])) fanIn.set(j, (fanIn.get(j) ?? 0) + 1);
  return [...fanIn]
    .filter(([j]) => model.files[j] !== undefined)
    .sort((a, b) => b[1] - a[1] || (model.files[a[0]]! < model.files[b[0]]! ? -1 : 1))
    .slice(0, Math.max(0, k))
    .map(([j]) => model.files[j]!);
}
