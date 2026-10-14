/**
 * Group commit, the pure part: what one trunk cycle does with the landing requests that queued
 * while the previous cycle ran (one request per lane batch, in arrival order).
 *
 * Every request becomes its own landing commit, and the commits of a cycle are chained: the
 * second batch's commit has the first's as parent, and only the tip is pushed. Lineage stays
 * per landing (one commit, one lineage note, one `why` entry per lane batch) while the cycle
 * pays for one trunk push and one notes push. Because the commits are chained, the plan is
 * sequential optimistic concurrency over a virtual trunk: each proposal is validated against
 * trunk as it will be once every earlier accepted proposal of the cycle has landed. That is
 * what serving the batches one commit at a time would decide, without a push per batch.
 */
import { mergeProblem, mergeText, revalidate, revalidationEnabled, textMergeCandidate, validateProposal } from "@fire_trident/core";
import type { ExportSurface, ExportedNames, FileVersion, Id, Landing, MergeConflict, OccResult, Path, Proposal, Revalidated, Sha, TextMerged } from "@fire_trident/core";
import { exportedNames, resolveModule } from "../decide/mechanical.ts";
import { importTargets } from "./imports.ts";

/** A proposal sent back from `land`, with the exact reason. */
export interface Returned {
  proposalId: Id;
  reason: string;
  /** Text merge: the files whose line merge conflicted, when that is why it went back (the conflict resolver reads them). */
  conflicts?: MergeConflict[];
}

/**
 * What `TrunkDO.land` reports for one batch. Idempotent per proposal id: a proposal that landed
 * earlier (a retried batch whose result was lost) comes back in `prior` with its landing and is
 * never returned. `deferred` proposals were neither landed nor returned (a transient failure);
 * the lane keeps them and tries again.
 */
export interface LandResult {
  landing?: Landing;
  prior?: Landing[];
  returned: Returned[];
  deferred?: Returned[];
}

/** One proposal's fate in a cycle. */
export type Outcome =
  | { kind: "landed"; landing: Landing }
  | { kind: "returned"; reason: string; conflicts?: MergeConflict[] }
  | { kind: "deferred"; reason: string };

/** A proposal ready for planning: shape-checked, not landed before, its new blobs local. */
export interface PlanProposal {
  p: Proposal;
  /** Blob of every written path at the proposal's base commit. */
  base: FileVersion[];
}

/**
 * Per batch (same order as the input): the proposals that land in its commit, and the ones that go
 * back. `revalidated`: accepted proposals that land over files they read that changed, with the names
 * that held in each (assumption revalidation). `merged`: accepted proposals whose stale files were merged
 * line by line (text merge); their write sets in `accepted` name the results, whose texts are in
 * `mergedTexts` (the trunk writer stores them before it builds the commits).
 */
export interface PlanResult {
  accepted: Proposal[][];
  returned: Returned[][];
  revalidated: Map<Id, Revalidated[]>;
  merged: Map<Id, TextMerged[]>;
  mergedTexts: Map<Sha, string>;
}

/**
 * Text merge (FT_TEXT_MERGE): what the plan reads to merge a stale change's files with the virtual trunk. `text` gives a
 * blob's text as the trunk writer loaded it, or null when it did not (larger than 512 KB, binary, not UTF-8, unreadable,
 * or past the cycle's budget); `blobOf` gives the git blob id of a text.
 */
export interface TextMergeInput {
  text(blob: Sha): string | null;
  blobOf(text: string): Sha;
  /**
   * The insertion rule (FT_MERGE_INSERTIONS): where both sides only inserted lines at the same place of the base, their
   * union lands, trunk's lines first (core mergeText with `insertions`); the merged file records `rule: "insertions"`.
   */
  insertions?: boolean;
}

/**
 * Is text merge on for this colony? `setting` is FT_TEXT_MERGE, read like FT_REVALIDATE: "on" (every colony), a
 * comma-separated list of colony ids, or absent / empty / "off" (no colony).
 */
export function textMergeEnabled(setting: string | undefined, colonyId: Id): boolean {
  return revalidationEnabled(setting, colonyId);
}

/**
 * Is text merge's insertion rule on for this colony? `setting` is FT_MERGE_INSERTIONS, read like FT_REVALIDATE: "on"
 * (every colony), a comma-separated list of colony ids, or absent / empty / "off" (no colony). It applies only where
 * text merge (FT_TEXT_MERGE) is on too.
 */
export function mergeInsertionsEnabled(setting: string | undefined, colonyId: Id): boolean {
  return revalidationEnabled(setting, colonyId);
}

/**
 * The deletion guard's input (FT_DELETION_GUARD), read from trunk's import index (imports.ts deletionImports). For
 * each path a proposal of the cycle deletes: the trunk script files with an import whose resolution it takes part in,
 * each with the targets of those imports (the path a specifier names, before extensions and index files are tried).
 * `targets`: the import targets of each new version (blob) the cycle writes at one of those files; a new version
 * missing here was not read, and its file is not checked.
 */
export interface DeletionImports {
  importers: ReadonlyMap<Path, ReadonlyMap<Path, readonly string[]>>;
  targets: ReadonlyMap<Sha, readonly string[]>;
}

/**
 * Is the deletion guard on for this colony? `setting` is FT_DELETION_GUARD, read like FT_REVALIDATE: "on" (every
 * colony), a comma-separated list of colony ids, or absent / empty / "off" (no colony).
 */
export function deletionGuardEnabled(setting: string | undefined, colonyId: Id): boolean {
  return revalidationEnabled(setting, colonyId);
}

/** Same path, or one is a directory prefix of the other. */
export function overlaps(a: Path, b: Path): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** Short form of a blob id for reasons. */
function short(blob: Sha | null): string {
  return blob === null ? "absent" : blob.slice(0, 10);
}

/**
 * Plan one cycle. Batches are served in order and proposals in batch order:
 *
 * - Within a batch (one commit) the lane's lateral-inhibition rule holds: a proposal whose writes
 *   overlap an accepted proposal's writes or reads, or whose reads overlap its writes, goes back
 *   ("conflicts with another proposal in this landing").
 * - Across batches the commits are chained, so a proposal is checked against the virtual trunk:
 *   current trunk plus every write accepted earlier in the cycle. A read or written path that an
 *   earlier batch changes makes it stale (write/write and write-then-read overlaps), with the
 *   exact delta and the proposal landing ahead of it. Writing a path that an earlier batch only
 *   read is fine: that batch lands first, on the trunk it read.
 * - A file/directory clash with an earlier batch's write (one path a prefix of the other) goes back.
 * - Assumptions (the files a proposal's imports resolve to) must still exist: a proposal whose assumption
 *   is gone from the virtual trunk goes back, and so does one that would delete a assumption of a
 *   proposal accepted earlier in the cycle. Only existence counts; an edited assumption is fine.
 * - Assumption revalidation (with `exported`, the names each version of a file exports): a proposal
 *   stale only through files it read, each covered by a name assumption, still lands when every name it
 *   imports from each is exported by the version on the virtual trunk (trunk, or the new blob of a
 *   proposal accepted earlier in the cycle). A name that is gone is named in the reason; anything
 *   else goes back as above. Without `exported`, stale means back.
 * - Deletion guard (with `deletions`, see brokenImports): a proposal that deletes a file goes back
 *   while a trunk file's import of it would resolve to nothing once the proposal lands, unless the
 *   proposal itself or one accepted earlier in the cycle deletes that file or rewrites it. Checked
 *   last, so a proposal that goes back for another reason gets that reason.
 * - Text merge (with `merge`, see mergeWrites): a proposal stale only on files it writes (each written,
 *   in its base and on the virtual trunk: textMergeCandidate) has each of them merged line by line with
 *   the version on the virtual trunk. When every merge is clean it goes on with those files' blobs
 *   replaced by the results, every other rule still applying, and later batches see the results (they
 *   may merge against them in turn). A conflict, a text the trunk writer did not load, or a file that is
 *   never merged (binary, over 512 KB, a lockfile) leaves it to the rules above, and a conflict is named
 *   in the reason and carried in the return's `conflicts` (for the conflict resolver). With `merge.insertions`
 *   (FT_MERGE_INSERTIONS), a file whose only conflicts are insertions by both sides at one place merges as their
 *   union, recorded with `rule: "insertions"`. Without `merge`, stale means back as before.
 *
 * Proposal ids must be unique across the cycle (the caller dedupes); a repeated id is skipped.
 */
export function planCycle(
  batches: PlanProposal[][],
  trunk: (path: Path) => Sha | null,
  exported?: ExportedNames,
  deletions?: DeletionImports | null,
  merge?: TextMergeInput | null,
): PlanResult {
  const ahead = new Map<Path, { blob: Sha | null; by: Id }>();
  const aheadPaths: Path[] = [];
  /** Assumptions of the proposals accepted in earlier batches, with the proposal relying on each. */
  const reliedAhead = new Map<Path, Id>();
  const virtual = (path: Path): Sha | null => {
    const w = ahead.get(path);
    return w !== undefined ? w.blob : trunk(path);
  };
  const seen = new Set<Id>();
  const accepted: Proposal[][] = [];
  const returned: Returned[][] = [];
  const revalidated = new Map<Id, Revalidated[]>();
  const merged = new Map<Id, TextMerged[]>();
  const mergedTexts = new Map<Sha, string>();
  /** The versions this cycle's merges made, by blob id, with their file: a later merge, export or import check may read one. */
  const produced = new Map<Sha, { path: Path; text: string }>();
  const textOf = (blob: Sha): string | null => produced.get(blob)?.text ?? merge?.text(blob) ?? null;
  // A merged version is not one the trunk writer read exports or imports from: they are read from its text here.
  const surfaces = new Map<Sha, ExportSurface | null>();
  const exportedOf: ExportedNames | undefined = exported
    ? (path, blob) => {
        const made = produced.get(blob);
        if (!made) return exported(path, blob);
        if (!surfaces.has(blob)) surfaces.set(blob, exportSurface(new TextEncoder().encode(made.text)));
        return surfaces.get(blob) ?? null;
      }
    : undefined;
  const imported = new Map<Sha, readonly string[]>();
  const targetsOf = (blob: Sha): readonly string[] | undefined => {
    const known = deletions?.targets.get(blob);
    const made = known ? undefined : produced.get(blob);
    if (!made) return known;
    if (!imported.has(blob)) imported.set(blob, importTargets(made.path, made.text));
    return imported.get(blob);
  };
  for (const batch of batches) {
    const ok: Proposal[] = [];
    const back: Returned[] = [];
    const writes = new Set<Path>();
    const reads = new Set<Path>();
    /** Paths this batch's accepted proposals delete, and the assumptions they rely on. */
    const deleted = new Map<Path, Id>();
    const relied = new Map<Path, Id>();
    /** What this batch's accepted proposals write: the deletion guard reads trunk as it will be with them. */
    const batchWrites = new Map<Path, Sha | null>();
    const before = (path: Path): Sha | null => {
      const w = batchWrites.get(path);
      return w !== undefined ? w : virtual(path);
    };
    for (const { p: proposal, base } of batch) {
      let p = proposal;
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      const w = p.writeSet.map((f) => f.path);
      const r = p.readSet.map((f) => f.path);
      const assumptions = p.assumptions ?? [];
      const clash = w.find((path) => reads.has(path) || [...writes].some((x) => overlaps(x, path))) ?? r.find((path) => writes.has(path));
      if (clash !== undefined) {
        back.push({ proposalId: p.id, reason: `conflicts with another proposal in this landing on ${clash}` });
        continue;
      }
      const gone = assumptions.find((path) => deleted.has(path));
      if (gone !== undefined) {
        back.push({ proposalId: p.id, reason: `conflicts with ${deleted.get(gone)} in this landing: it deletes ${gone}, which this change's imports resolve to` });
        continue;
      }
      const kill = p.writeSet.find((f) => (f.blob ?? null) === null && (relied.has(f.path) || reliedAhead.has(f.path)));
      if (kill !== undefined) {
        const here = relied.get(kill.path);
        const by = here ?? reliedAhead.get(kill.path)!;
        back.push({ proposalId: p.id, reason: `conflicts with ${by}${here ? " in this landing" : ", landing ahead in this cycle"}: this change deletes ${kill.path}, which ${by}'s imports resolve to` });
        continue;
      }
      const occ = validateProposal(p, virtual, base);
      let kept: Revalidated[] | null = null;
      let files: TextMerged[] | null = null;
      if (!occ.eligible) {
        const tried = merge ? mergeWrites(p, occ.stale, base, virtual, textOf, merge.blobOf, merge.insertions === true) : null;
        const rv = tried?.ok || !exportedOf ? null : revalidate(p, occ.stale, exportedOf);
        if (tried?.ok) {
          // The change goes on with its merged files: what it lands, and what later batches see.
          files = tried.files;
          const result = new Map(files.map((f) => [f.path, f.result]));
          for (const f of files) produced.set(f.result, { path: f.path, text: tried.texts.get(f.result)! });
          p = { ...p, writeSet: p.writeSet.map((f) => (result.has(f.path) ? { path: f.path, blob: result.get(f.path)! } : f)) };
        } else if (rv?.ok) {
          kept = rv.revalidated;
        } else {
          const detail = occ.stale
            .map((s) => {
              const by = ahead.get(s.path)?.by;
              return `${s.path} (expected ${s.expected ?? "absent"}, trunk has ${s.actual ?? "absent"}${by ? `, landing ahead in this cycle from ${by}` : ""})`;
            })
            .join(", ");
          const broken = rv?.ok === false && rv.broken ? `; ${rv.broken.path} no longer exports ${rv.broken.names.join(", ")}, which this change imports` : "";
          const conflicted = tried && !tried.ok && tried.conflicts.length > 0 ? tried.conflicts : null;
          const conflicts = conflicted ? `; ${conflictText(conflicted)}` : "";
          back.push({ proposalId: p.id, reason: `stale: ${detail}${broken}${conflicts}`, ...(conflicted ? { conflicts: conflicted } : {}) });
          continue;
        }
      }
      const missing = assumptions.find((path) => virtual(path) === null);
      if (missing !== undefined) {
        const by = ahead.get(missing)?.by;
        back.push({ proposalId: p.id, reason: `stale: its imports resolve to ${missing}, which ${by ? `${by} deletes, landing ahead in this cycle` : "is no longer on trunk"}` });
        continue;
      }
      const shape = [...w, ...r].find((path) => aheadPaths.some((x) => x !== path && overlaps(x, path)));
      if (shape !== undefined) {
        const x = aheadPaths.find((y) => y !== shape && overlaps(y, shape))!;
        const a = ahead.get(x)!;
        back.push({ proposalId: p.id, reason: `conflicts with ${a.by} on ${shape}: ${a.by} ${a.blob === null ? "deletes" : `writes ${short(a.blob)} at`} ${x}, landing ahead in this cycle` });
        continue;
      }
      const broken = deletions ? brokenImports(p, before, trunk, deletions, targetsOf) : null;
      if (broken !== null) {
        back.push({ proposalId: p.id, reason: broken });
        continue;
      }
      ok.push(p);
      if (kept) revalidated.set(p.id, kept);
      if (files) {
        merged.set(p.id, files);
        for (const f of files) mergedTexts.set(f.result, produced.get(f.result)!.text);
      }
      for (const path of w) writes.add(path);
      for (const path of r) reads.add(path);
      for (const f of p.writeSet) batchWrites.set(f.path, f.blob ?? null);
      for (const f of p.writeSet) if ((f.blob ?? null) === null) deleted.set(f.path, p.id);
      for (const path of assumptions) if (!relied.has(path)) relied.set(path, p.id);
    }
    // The batch's writes become the base of every later batch, and its assumptions bind them.
    for (const p of ok) {
      for (const f of p.writeSet) {
        if (!ahead.has(f.path)) aheadPaths.push(f.path);
        ahead.set(f.path, { blob: f.blob ?? null, by: p.id });
      }
    }
    for (const [path, id] of relied) if (!reliedAhead.has(path)) reliedAhead.set(path, id);
    accepted.push(ok);
    returned.push(back);
  }
  return { accepted, returned, revalidated, merged, mergedTexts };
}

/** The merge of one stale proposal's files (mergeWrites): the files and their merged texts by blob id, or the conflicts that stopped it. */
type MergeTry = { ok: true; files: TextMerged[]; texts: Map<Sha, string> } | { ok: false; conflicts: MergeConflict[] };

/**
 * Text merge for one stale proposal (see planCycle), or null when it is not a candidate (textMergeCandidate). Every
 * stale file must be one whose base the virtual trunk moved past, with its three versions loaded (`textOf`) and
 * mergeable (core mergeProblem), or nothing is merged and no conflict is named; then each file is merged (core
 * mergeText): its base, the virtual trunk's version (ours) and the proposal's (theirs). `conflicts` lists the files
 * whose merge conflicted, with their three blobs and where each conflicting hunk starts in the base. `insertions`: the
 * insertion rule (FT_MERGE_INSERTIONS) applies, and a file it merged records `rule: "insertions"`.
 */
function mergeWrites(
  p: Proposal,
  stale: OccResult["stale"],
  base: FileVersion[],
  virtual: (path: Path) => Sha | null,
  textOf: (blob: Sha) => string | null,
  blobOf: (text: string) => Sha,
  insertions = false,
): MergeTry | null {
  if (!textMergeCandidate(p, stale)) return null;
  const started = new Map(base.map((f) => [f.path, f.blob ?? null]));
  const wrote = new Map(p.writeSet.map((w) => [w.path, w.blob ?? null]));
  const todo: Array<{ path: Path; base: Sha; trunk: Sha; theirs: Sha; texts: [string, string, string] }> = [];
  for (const path of new Set(stale.map((s) => s.path))) {
    const b = started.get(path) ?? null;
    const o = virtual(path);
    const t = wrote.get(path) ?? null;
    // A file stale only through what the change read of it (its base is still the version here) is not a merge.
    if (b === null || o === null || t === null || b === o) return { ok: false, conflicts: [] };
    const texts = [textOf(b), textOf(o), textOf(t)];
    if (texts.some((x) => x === null) || mergeProblem(path, texts as string[]) !== null) return { ok: false, conflicts: [] };
    todo.push({ path, base: b, trunk: o, theirs: t, texts: texts as [string, string, string] });
  }
  const files: TextMerged[] = [];
  const texts = new Map<Sha, string>();
  const conflicts: MergeConflict[] = [];
  let limited = false;
  for (const f of todo) {
    const r = mergeText(...f.texts, undefined, { insertions });
    if (!r.clean) {
      if (r.conflicts > 0) conflicts.push({ path: f.path, base: f.base, trunk: f.trunk, theirs: f.theirs, lines: r.lines });
      else limited = true;
      continue;
    }
    const result = blobOf(r.text);
    texts.set(result, r.text);
    files.push({ path: f.path, base: f.base, trunk: f.trunk, theirs: f.theirs, result, ...(r.rule ? { rule: r.rule } : {}) });
  }
  if (conflicts.length > 0 || limited) return { ok: false, conflicts };
  return { ok: true, files, texts };
}

/** Conflicting hunks a reason places at most, per file. */
const MERGE_LINES_NAMED = 5;

/** A text merge's conflicts as a return reason states them: each file, its conflicting hunks and where they start in the change's base. */
function conflictText(conflicts: Array<{ path: Path; lines: number[] }>): string {
  return conflicts
    .map((c) => {
      const n = c.lines.length;
      return `text merge of ${c.path}: ${n} conflicting hunk${n === 1 ? "" : "s"}, at line${n === 1 ? "" : "s"} ${listText(c.lines.map(String), MERGE_LINES_NAMED)} of its base`;
    })
    .join("; ");
}

/** Importers a deletion guard reason names at most, and deleted files. */
const GUARD_IMPORTERS_NAMED = 10;
const GUARD_FILES_NAMED = 3;

/**
 * The deletion guard for one proposal: why it goes back, or null. `before` is trunk as it will be just before `p`
 * lands (trunk, the proposals accepted earlier in the cycle, and the ones accepted earlier in its batch). For each
 * file `p` deletes that is there, the importers `deletions` lists are checked: one that `p` or an earlier proposal
 * deletes is fine; one rewritten in the cycle is checked in its new version; and an import breaks when it resolves
 * on `before` but to nothing once `p` lands, resolved as the decide stage and `ft revert` resolve relative imports.
 * An import that finds another file afterwards (the module moved into a directory, or a .js name now finds its
 * TypeScript twin) does not break. `targetsOf` gives a new version's import targets (`deletions.targets`, or read from
 * a version a text merge of the cycle made); a version it does not know leaves its file unchecked.
 */
function brokenImports(
  p: Proposal,
  before: (path: Path) => Sha | null,
  trunk: (path: Path) => Sha | null,
  deletions: DeletionImports,
  targetsOf: (blob: Sha) => readonly string[] | undefined = (blob) => deletions.targets.get(blob),
): string | null {
  const own = new Map<Path, Sha | null>();
  for (const f of p.writeSet) own.set(f.path, f.blob ?? null);
  const gone = new Set<Path>();
  for (const [path, blob] of own) if (blob === null && before(path) !== null) gone.add(path);
  if (gone.size === 0) return null;
  const existed = (path: Path): boolean => before(path) !== null;
  const exists = (path: Path): boolean => {
    const w = own.get(path);
    return w !== undefined ? w !== null : before(path) !== null;
  };
  // Each importer once, with the targets of its trunk imports that a deleted file takes part in resolving.
  const candidates = new Map<Path, Set<string>>();
  for (const path of gone) {
    for (const [importer, targets] of deletions.importers.get(path) ?? []) {
      const set = candidates.get(importer) ?? new Set<string>();
      for (const t of targets) set.add(t);
      candidates.set(importer, set);
    }
  }
  const broken = new Map<Path, Set<Path>>();
  for (const [importer, onTrunk] of candidates) {
    const mine = own.get(importer);
    const blob = mine !== undefined ? mine : before(importer);
    if (blob === null) continue;
    const targets = blob === trunk(importer) ? onTrunk : targetsOf(blob);
    if (!targets) continue;
    for (const t of targets) {
      const was = resolveModule(t, existed);
      if (was === null || !gone.has(was) || resolveModule(t, exists) !== null) continue;
      const by = broken.get(was) ?? new Set<Path>();
      by.add(importer);
      broken.set(was, by);
    }
  }
  if (broken.size === 0) return null;
  const files = [...broken.keys()].sort();
  const importers = [...new Set([...broken.values()].flatMap((s) => [...s]))].sort();
  return `deleting ${listText(files, GUARD_FILES_NAMED)} breaks the imports of ${listText(importers, GUARD_IMPORTERS_NAMED)}: change them in the same change, or first`;
}

/** "a", "a and b", "a, b and c"; past `max` items, the first `max` and "N more". */
function listText(items: readonly string[], max: number): string {
  const parts = items.length > max ? [...items.slice(0, max), `${items.length - max} more`] : [...items];
  return parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** Larger files are never read for their exports (their readers go back as stale). */
export const SURFACE_FILE_BYTES = 512 * 1024;

/**
 * Assumption revalidation: the blobs whose exported names a cycle may need. For each file a proposal read
 * and imports names from (a name assumption), trunk's blob of it and every new blob a proposal of the
 * cycle writes there (the versions the plan's virtual trunk can hold), unless it is the blob the
 * proposal read (not stale, nothing to check). Each once, in first-seen order.
 */
export function surfaceBlobs(proposals: Proposal[], trunk: (path: Path) => Sha | null): Sha[] {
  const written = new Map<Path, Sha[]>();
  for (const p of proposals) {
    for (const w of p.writeSet) {
      if (w.blob === null) continue;
      const list = written.get(w.path) ?? [];
      list.push(w.blob);
      written.set(w.path, list);
    }
  }
  const want = new Set<Sha>();
  for (const p of proposals) {
    if (!Array.isArray(p.nameAssumptions)) continue;
    const reads = new Map<Path, Set<Sha | null>>();
    for (const r of p.readSet) reads.set(r.path, (reads.get(r.path) ?? new Set<Sha | null>()).add(r.blob ?? null));
    for (const np of p.nameAssumptions) {
      const read = np && typeof np.path === "string" ? reads.get(np.path) : undefined;
      if (!read) continue;
      for (const blob of [trunk(np.path), ...(written.get(np.path) ?? [])]) if (blob !== null && !read.has(blob)) want.add(blob);
    }
  }
  return [...want];
}

/**
 * Text merge: the blobs whose texts a cycle's merges may read. For each file a proposal writes (not deletes) on a
 * base that has it, when trunk holds another version or another proposal of the cycle writes the file too: the
 * proposal's base blob and its own, trunk's blob, and every blob the cycle's other proposals write there (one of them
 * can be on the virtual trunk when it lands). Versions a merge of the cycle makes are not listed: the plan holds their
 * texts. Each once, in first-seen order.
 */
export function mergeBlobs(entries: readonly PlanProposal[], trunk: (path: Path) => Sha | null): Sha[] {
  const writers = new Map<Path, Array<{ blob: Sha | null; base: Sha | null }>>();
  for (const { p, base } of entries) {
    const started = new Map(base.map((f) => [f.path, f.blob ?? null]));
    for (const w of p.writeSet) {
      const list = writers.get(w.path) ?? [];
      list.push({ blob: w.blob ?? null, base: started.get(w.path) ?? null });
      writers.set(w.path, list);
    }
  }
  const want = new Set<Sha>();
  for (const [path, list] of writers) {
    const now = trunk(path);
    const shared = list.length > 1;
    for (const w of list) {
      if (w.blob === null || w.base === null || (!shared && w.base === now)) continue;
      want.add(w.base);
      if (now !== null) want.add(now);
      want.add(w.blob);
      if (shared) for (const x of list) if (x.blob !== null) want.add(x.blob);
    }
  }
  return [...want];
}

/**
 * The export surface of one file version (assumption revalidation), or null when it cannot be known for
 * sure: too large, not UTF-8 text, or a source the export reader cannot read reliably.
 */
export function exportSurface(bytes: Uint8Array): ExportSurface | null {
  if (bytes.length > SURFACE_FILE_BYTES) return null;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
  const ex = exportedNames(text);
  return ex === null ? null : { names: ex.names, open: ex.star.length > 0 };
}

/**
 * Split a cycle's requests into the first occurrence of each proposal id (in arrival order) and
 * the repeats. A repeat (the same proposal sent again, say by a lane retrying a call whose answer
 * it never got) is not processed twice; it shares the first occurrence's outcome.
 */
export function uniqueProposals(requests: Proposal[][]): Array<{ request: number; p: Proposal }> {
  const seen = new Set<Id>();
  const out: Array<{ request: number; p: Proposal }> = [];
  requests.forEach((batch, request) => {
    for (const p of batch) {
      const id = typeof p?.id === "string" ? p.id : "";
      if (id === "" || seen.has(id)) continue;
      seen.add(id);
      out.push({ request, p });
    }
  });
  return out;
}

/**
 * Each request's result from the per-proposal outcomes, idempotent per proposal id: a landed
 * proposal reports its landing (the request's own new landing in `landing`, any other in
 * `prior`, each once) and is never returned. Proposals without an id or outcome come back with
 * `fallback` reasons from `direct` (malformed input) or as deferred.
 */
export function resultsFor(requests: Proposal[][], outcome: Map<Id, Outcome>, own: Array<Landing | undefined>, direct: Returned[][] = []): LandResult[] {
  return requests.map((batch, i) => {
    const res: LandResult = { returned: [...(direct[i] ?? [])] };
    const mine = own[i];
    const prior = new Map<Id, Landing>();
    const listed = new Set<Id>();
    for (const p of batch) {
      const id = typeof p?.id === "string" ? p.id : "";
      if (id === "" || listed.has(id)) continue;
      listed.add(id);
      const o = outcome.get(id);
      if (!o) {
        (res.deferred ??= []).push({ proposalId: id, reason: "not decided in this trunk cycle" });
      } else if (o.kind === "landed") {
        if (mine && o.landing.id === mine.id) res.landing = mine;
        else prior.set(o.landing.id, o.landing);
      } else if (o.kind === "returned") {
        res.returned.push({ proposalId: id, reason: o.reason, ...(o.conflicts ? { conflicts: o.conflicts } : {}) });
      } else {
        (res.deferred ??= []).push({ proposalId: id, reason: o.reason });
      }
    }
    if (prior.size > 0) res.prior = [...prior.values()];
    return res;
  });
}
