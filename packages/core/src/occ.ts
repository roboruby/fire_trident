import type { FileVersion, Id, Path, Proposal, Sha } from "./types.ts";
import { isLockfile } from "./textmerge.ts";

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
// Import-name revalidation: decision conflicts, not version conflicts
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
  /** The file only grew between the two (see onlyGrew): new top-level declarations, every statement read unchanged and in order. */
  grew: true;
}

/**
 * The names one version of a file exports. `open`: it also re-exports whole modules (`export * from`),
 * which are not followed, so a name missing from `names` may still be exported (and is not relied on).
 * `statements`: its top-level statements, for the growth check (absent when not read; null when they
 * cannot be read for sure, so a change that read another version of the file goes back).
 */
export interface ExportSurface {
  names: ReadonlySet<string>;
  open: boolean;
  statements?: TopStatements | null;
}

/**
 * The top-level statements of one version of a script file, in order (the worker reads them). For each:
 * a hash of its code (its tokens and where line breaks fall between them; comments and white space do
 * not count), the line it starts on, and whether it only declares (an import, an export, a function,
 * class, variable, type or similar) rather than running a statement. `prologue`: how many statements at
 * the start are directives ("use strict", "use client"), which count only while nothing comes before
 * them. `mode` says how the file was read: versions read in different modes are never compared.
 */
export interface TopStatements {
  mode: string;
  hashes: readonly string[];
  lines: readonly number[];
  declares: readonly boolean[];
  prologue: number;
}

/**
 * Did a file only grow from the version a change read to the version it would land on (see onlyGrew)?
 * Otherwise `line` says where it did more: `edited`, the first statement of the version read that is not
 * there unchanged and in order (its line in the version read); `added`, the first new statement that is
 * not a declaration (its line in the version it would land on). Null when that cannot be known for sure.
 */
export type Growth = { grew: true } | { grew: false; line: number; why: "edited" | "added" } | null;

/** The growth check of one file a change read: `read` is the blob it read, `landedOn` the one it would land on. */
export type GrewOnly = (path: Path, read: Sha, landedOn: Sha) => Growth;

/** The export surface of one version (blob) of a file, or null when it cannot be known for sure. */
export type ExportedNames = (path: Path, blob: Sha) => ExportSurface | null;

/**
 * What import-name revalidation decided for a stale proposal: it lands over the files listed, or it goes
 * back. `broken` names the file and the imported names it no longer exports when that is why; `changed`
 * names the file and where it did more than grow when that is why.
 */
export type Revalidation =
  | { ok: true; revalidated: Revalidated[] }
  | { ok: false; broken?: { path: Path; names: string[] }; changed?: { path: Path; line: number; why: "edited" | "added" } };

/**
 * Is import-name revalidation on for this colony? `setting` is FT_REVALIDATE: "on" (every colony), a
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
 * The part of import-name revalidation that needs no file contents (the lane's pre-check): the proposal is
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
 * The part of text merge that needs no file contents (FT_TEXT_MERGE; the lane's and the trunk writer's pre-check): the
 * proposal is stale only on files it writes, each written with new content (not deleted), present both in what it
 * expected and on trunk, and not a lockfile. The trunk writer then merges each of them with trunk's version line by
 * line (textmerge.ts) and lands the change only when every merge is clean; anything else goes back as usual.
 */
export function textMergeCandidate(p: Pick<Proposal, "writeSet">, stale: OccResult["stale"]): boolean {
  if (stale.length === 0) return false;
  const written = new Map<Path, Sha | null>();
  for (const w of p.writeSet) written.set(w.path, w.blob ?? null);
  return stale.every((s) => (written.get(s.path) ?? null) !== null && s.expected !== null && s.actual !== null && !isLockfile(s.path));
}

/**
 * Already on trunk (FT_ALREADY_ON_TRUNK): would landing this change on `trunk` change nothing? Yes when every file it
 * writes already holds the blob it writes there and every file it deletes is already absent (`undefined` from the index
 * means absent). A change that writes nothing is not one: there is no content to find on trunk. Whatever the change
 * read, and whatever base it started from, a change that changes nothing has nothing left to land.
 */
export function changesNothing(p: Pick<Proposal, "writeSet">, trunk: TrunkIndex): boolean {
  if (!Array.isArray(p.writeSet) || p.writeSet.length === 0) return false;
  return p.writeSet.every((w) => (trunk(w.path) ?? null) === (w.blob ?? null));
}

/**
 * Import-name revalidation (the trunk writer, with file contents): a proposal stale only through files it
 * read lands when, for each of them, every name it imports is still exported by the version it would land
 * on (`stale[].actual`) and the file only grew since the version it read (`grewOnly`: new top-level
 * declarations, every statement it read still there unchanged and in order). When the exported names or
 * the statements of a version are unknown, a name is gone, or the file did more than grow, it goes back.
 * `stale` is the OCC result against the trunk the proposal would land on.
 */
export function revalidate(p: Pick<Proposal, "readSet" | "writeSet" | "nameAssumptions">, stale: OccResult["stale"], exported: ExportedNames, grewOnly: GrewOnly): Revalidation {
  if (!revalidationCandidate(p, stale)) return { ok: false };
  const assumptions = assumptionNames(p);
  const revalidated: Revalidated[] = [];
  for (const s of stale) {
    const names = assumptions.get(s.path)!;
    const surface = exported(s.path, s.actual!);
    if (surface === null) return { ok: false };
    const missing = names.filter((n) => !surface.names.has(n));
    if (missing.length > 0) return surface.open ? { ok: false } : { ok: false, broken: { path: s.path, names: missing } };
    const growth = grewOnly(s.path, s.expected!, s.actual!);
    if (growth === null) return { ok: false };
    if (!growth.grew) return { ok: false, changed: { path: s.path, line: growth.line, why: growth.why } };
    revalidated.push({ path: s.path, read: s.expected, landedOn: s.actual, names, grew: true });
  }
  return { ok: true, revalidated };
}

/**
 * The growth check of import-name revalidation: did a file only grow from the version a change read
 * (`read`) to the version it would land on (`landed`)? Yes when every top-level statement of `read` is in
 * `landed` with the same hash and in the same order, its leading directives still first, and every other
 * statement of `landed` only declares: new declarations may appear anywhere between the old statements.
 * Otherwise it names the first statement of `read` that is not there that way (`edited`: edited, moved or
 * removed), or else the first new statement that is not a declaration (`added`). Null when the two were
 * read in different modes or a list is malformed.
 */
export function onlyGrew(read: TopStatements, landed: TopStatements): Growth {
  if (read.mode !== landed.mode || !wellFormed(read) || !wellFormed(landed)) return null;
  const matched = new Set<number>();
  let j = 0;
  for (let i = 0; i < read.hashes.length; i++) {
    // A directive of the version read counts only at the same place: nothing new may come before it.
    if (i < read.prologue) {
      if (landed.hashes[i] !== read.hashes[i]) return { grew: false, line: read.lines[i]!, why: "edited" };
      matched.add(i);
      j = i + 1;
      continue;
    }
    while (j < landed.hashes.length && landed.hashes[j] !== read.hashes[i]) j++;
    if (j === landed.hashes.length) return { grew: false, line: read.lines[i]!, why: "edited" };
    matched.add(j++);
  }
  for (let k = 0; k < landed.hashes.length; k++) {
    if (!matched.has(k) && !landed.declares[k]) return { grew: false, line: landed.lines[k]!, why: "added" };
  }
  return { grew: true };
}

/** A statement list whose per-statement arrays line up and whose prologue fits in it. */
function wellFormed(s: TopStatements): boolean {
  const n = s.hashes.length;
  return s.lines.length === n && s.declares.length === n && Number.isInteger(s.prologue) && s.prologue >= 0 && s.prologue <= n;
}
