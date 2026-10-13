import type { FileVersion, Id, Path, Proposal, Sha } from "./types.ts";

/** Current trunk blob per path (null = absent). */
export type TrunkIndex = (path: Path) => Sha | null | undefined;

export interface OccResult {
  eligible: boolean;
  /** Paths whose trunk blob differs from what the proposal read or based its write on. */
  stale: Array<{ path: Path; expected: Sha | null; actual: Sha | null }>;
}

/**
 * Optimistic concurrency (Kung & Robinson): a proposal may land only if every path in
 * its read set still has the blob it read, and every path in its write set still has
 * the blob it had at the proposal's base (`baseBlobs`, which the caller derives from baseSha).
 *
 * `undefined` from the trunk index and a write path missing from `baseBlobs` both mean absent (null).
 * Every stale path is reported (reads first, then writes); an identical repeat is reported once.
 */
export function validateProposal(p: Pick<Proposal, "readSet" | "writeSet">, trunk: TrunkIndex, baseBlobs: FileVersion[]): OccResult {
  const base = new Map<Path, Sha | null>();
  for (const f of baseBlobs) base.set(f.path, f.blob ?? null);
  const stale: OccResult["stale"] = [];
  const reported = new Set<string>();
  const check = (path: Path, expected: Sha | null): void => {
    const actual = trunk(path) ?? null;
    if (actual === expected) return;
    const key = `${path}\u0000${expected}\u0000${actual}`;
    if (reported.has(key)) return;
    reported.add(key);
    stale.push({ path, expected, actual });
  };
  for (const r of p.readSet) check(r.path, r.blob ?? null);
  for (const w of p.writeSet) check(w.path, base.get(w.path) ?? null);
  return { eligible: stale.length === 0, stale };
}

// ---------------------------------------------------------------------------
// Assumption revalidation: decision conflicts, not version conflicts
// ---------------------------------------------------------------------------

/**
 * A file a change read that changed before the change landed, and the names the change imports
 * from it that still held there. The lineage note records one per such file.
 */
export interface Revalidated {
  path: Path;
  /** The blob the change read. */
  read: Sha | null;
  /** The blob it landed on. */
  landedOn: Sha | null;
  names: string[];
}

/**
 * The names one version of a file exports. `open`: it also re-exports whole modules (`export * from`),
 * which are not followed, so a name missing from `names` may still be exported (and is not relied on).
 */
export interface ExportSurface {
  names: ReadonlySet<string>;
  open: boolean;
}

/** The export surface of one version (blob) of a file, or null when it cannot be known for sure. */
export type ExportedNames = (path: Path, blob: Sha) => ExportSurface | null;

/**
 * What assumption revalidation decided for a stale proposal: it lands over the files listed, or it goes
 * back. `broken` names the file and the imported names it no longer exports when that is why.
 */
export type Revalidation = { ok: true; revalidated: Revalidated[] } | { ok: false; broken?: { path: Path; names: string[] } };

/**
 * Is assumption revalidation on for this colony? `setting` is FT_REVALIDATE: "on" (every colony), a
 * comma-separated list of colony ids, or absent / empty / "off" (no colony).
 */
export function revalidationEnabled(setting: string | undefined, colonyId: Id): boolean {
  const s = typeof setting === "string" ? setting.trim() : "";
  if (s === "" || s.toLowerCase() === "off") return false;
  if (s.toLowerCase() === "on") return true;
  return s.split(",").some((id) => id.trim() !== "" && id.trim() === colonyId);
}

/**
 * The name assumptions of a proposal by path. Stored proposals may be old or odd: an entry that is not
 * a path with a non-empty list of non-empty names makes its path uncovered, and so does a path whose
 * entries disagree in shape. Two entries for one path give the union of their names.
 */
function assumptionNames(p: Pick<Proposal, "nameAssumptions">): Map<Path, string[]> {
  const out = new Map<Path, Set<string>>();
  const bad = new Set<Path>();
  for (const np of Array.isArray(p.nameAssumptions) ? p.nameAssumptions : []) {
    if (!np || typeof np.path !== "string") continue;
    const names = Array.isArray(np.names) ? np.names : [];
    if (names.length === 0 || !names.every((n) => typeof n === "string" && n !== "")) {
      bad.add(np.path);
      continue;
    }
    const set = out.get(np.path) ?? new Set<string>();
    for (const n of names) set.add(n);
    out.set(np.path, set);
  }
  return new Map([...out].filter(([path]) => !bad.has(path)).map(([path, set]) => [path, [...set].sort()]));
}

/**
 * The part of assumption revalidation that needs no file contents (the lane's pre-check): the proposal is
 * stale only through files it read (none it writes), each read as present, still on trunk, and covered
 * by a name assumption. Anything else goes back as usual.
 */
export function revalidationCandidate(p: Pick<Proposal, "readSet" | "writeSet" | "nameAssumptions">, stale: OccResult["stale"]): boolean {
  if (stale.length === 0) return false;
  const written = new Set(p.writeSet.map((w) => w.path));
  const read = new Set(p.readSet.map((r) => r.path));
  const assumptions = assumptionNames(p);
  return stale.every((s) => read.has(s.path) && !written.has(s.path) && s.expected !== null && s.actual !== null && assumptions.has(s.path));
}

/**
 * Assumption revalidation (the trunk writer, with file contents): a proposal stale only through files it
 * read lands when every name it imports from each of them is still exported by the version it would
 * land on (`stale[].actual`). When the exported names of a version are unknown, or a name is gone, it
 * goes back. `stale` is the OCC result against the trunk the proposal would land on.
 */
export function revalidate(p: Pick<Proposal, "readSet" | "writeSet" | "nameAssumptions">, stale: OccResult["stale"], exported: ExportedNames): Revalidation {
  if (!revalidationCandidate(p, stale)) return { ok: false };
  const assumptions = assumptionNames(p);
  const revalidated: Revalidated[] = [];
  for (const s of stale) {
    const names = assumptions.get(s.path)!;
    const surface = exported(s.path, s.actual!);
    if (surface === null) return { ok: false };
    const missing = names.filter((n) => !surface.names.has(n));
    if (missing.length > 0) return surface.open ? { ok: false } : { ok: false, broken: { path: s.path, names: missing } };
    revalidated.push({ path: s.path, read: s.expected, landedOn: s.actual, names });
  }
  return { ok: true, revalidated };
}
