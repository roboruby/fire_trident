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
import { mergeProblem, mergeText, onlyGrew, revalidate, revalidationEnabled, textMergeCandidate, validateProposal } from "@fire_trident/core";
import type { ExportSurface, ExportedNames, FileVersion, GrewOnly, Id, Landing, MergeConflict, OccResult, Path, Proposal, Revalidated, Sha, TextMerged } from "@fire_trident/core";
import { exportedNames, resolveModule } from "../decide/mechanical.ts";
import { topStatements } from "../decide/statements.ts";
import { importBindings, isRelative, mayName, specifierTarget, type ImportBinding } from "../decide/mechanical.ts";
import { guardExports, guardsScript, removedNames, type GuardExports } from "./exportguard.ts";
import { importTargets } from "./imports.ts";
import { mergeHold, type HeldFile, type MergeLock } from "./mergelock.ts";
import { commute, recipeHold, recipeLockFiles, refusedText, type RecipeInput } from "./recipes.ts";

/** A proposal sent back from `land`, with the exact reason. */
export interface Returned {
  proposalId: Id;
  reason: string;
  /** Text merge: the files whose line merge conflicted, when that is why it went back (the conflict resolver reads them). */
  conflicts?: MergeConflict[];
  /** Merge locks (trunk/mergelock.ts): the merge a person is asked to approve, when that is why it went back. */
  held?: HeldFile[];
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
  | { kind: "returned"; reason: string; conflicts?: MergeConflict[]; held?: HeldFile[] }
  | { kind: "deferred"; reason: string };

/** A proposal ready for planning: shape-checked, not landed before, its new blobs local. */
export interface PlanProposal {
  p: Proposal;
  /** Blob of every written path at the proposal's base commit. */
  base: FileVersion[];
  /** Merge locks (trunk/mergelock.ts): its files land as decided; a merge lands only once a person approved that merge. */
  lock?: MergeLock;
}

/**
 * Per batch (same order as the input): the proposals that land in its commit, and the ones that go
 * back. `revalidated`: accepted proposals that land over files they read that changed, with the names
 * that held in each, each file having only grown (import-name revalidation). `merged`: accepted proposals whose stale files were merged
 * line by line (text merge); their write sets in `accepted` name the results, whose texts are in
 * `mergedTexts` (the trunk writer stores them before it builds the commits).
 */
export interface PlanResult {
  accepted: Proposal[][];
  returned: Returned[][];
  revalidated: Map<Id, Revalidated[]>;
  merged: Map<Id, TextMerged[]>;
  mergedTexts: Map<Sha, string>;
  /** The export guard (with `exportGuard`): checks of changed script files it left undone (see brokenExports). */
  exportsUncovered?: number;
  /**
   * Recipes (with `recipes`): accepted proposals whose written files recipes that landed after their base rewrote, with
   * each recipe, its landing and those files (trunk/recipes.ts commute). The rewritten texts are in `mergedTexts`.
   */
  recipes?: Map<Id, Array<{ recipe: Id; landing: Id; paths: Path[] }>>;
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
 * The export guard's input (FT_EXPORT_GUARD), read from the cycle's blobs and trunk's import index (imports.ts
 * exportImports). `exports`: what each version of a changed script file exports (trunk's, and each new one the cycle
 * writes there), null when that cannot be known for sure; a version missing here was not read. `importers`: for each
 * changed file a version of the cycle stops exporting a name at, the trunk script files whose imports resolve to it; a
 * file missing here was not looked up. `bindings`: the imports of those importers' trunk versions and of every script
 * version the cycle writes, by blob, each with the names it takes; a version missing here was not read.
 */
export interface ExportImports {
  exports: ReadonlyMap<Sha, GuardExports | null>;
  importers: ReadonlyMap<Path, readonly Path[]>;
  bindings: ReadonlyMap<Sha, readonly ImportBinding[]>;
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

/** Import-name revalidation: how a stale read file did more than grow, as the return's reason says it. */
function changedText(c: { path: Path; line: number; why: "edited" | "added" }): string {
  return c.why === "edited"
    ? `${c.path} changed after this change read it: the statement at line ${c.line} of the version it read is no longer there as it was, so re-read the file and propose again`
    : `${c.path} changed after this change read it: line ${c.line} of the version it would land on adds a statement that is not a declaration, so re-read the file and propose again`;
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
 * - Import-name revalidation (with `exported`, the names each version of a file exports and its top-level
 *   statements): a proposal stale only through files it read, each covered by a name assumption, still lands
 *   when every name it imports from each is exported by the version on the virtual trunk (trunk, or the
 *   new blob of a proposal accepted earlier in the cycle) and that version only grew since the one it
 *   read (core onlyGrew: every statement it read still there unchanged and in order, every new one a
 *   declaration). A name that is gone, or the first statement that did more than grow, is named in the
 *   reason; anything else goes back as above. Without `exported`, stale means back.
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
 * - Merge locks (a proposal's `lock`, see trunk/mergelock.ts mergeHold): a change a person approved, or one with a danger
 *   pattern a person must see or a protected write, whose clean merge would land a result no person approved goes back
 *   to a person with the trunk delta (`held`); one whose merge conflicts goes back without `conflicts`.
 * - Export guard (with `exportGuard`, see brokenExports): a proposal that stops exporting a name from a script file goes
 *   back while a script file imports that name from it once the proposal lands, unless the proposal itself or one
 *   accepted earlier in the cycle rewrites that importer without the import; and of a proposal that stops exporting a
 *   name and one that imports it anew in the same cycle, the second goes back, naming the first. Checked after the
 *   deletion guard. Null: on, but its input could not be read; every changed script file counts as unchecked.
 * - Recipes (with `recipes`, see trunk/recipes.ts commute): a proposal built before a recipe landed is brought through
 *   the recipe before any rule above: the recipe's output of each file it writes in scope is what lands (and what later
 *   batches see), its base versions that trunk has only through the recipe are its bases, and a read whose transform is
 *   what trunk has is current; every rule above then applies to it as to any proposal. A written file the recipe cannot
 *   transform keeps the proposal's own version, and a return for it being stale names the recipe's landing. A locked
 *   proposal whose files a recipe rewrote goes to a person with the rewrite, as a held merge does.
 *
 * Proposal ids must be unique across the cycle (the caller dedupes); a repeated id is skipped.
 */
export function planCycle(
  batches: PlanProposal[][],
  trunk: (path: Path) => Sha | null,
  exported?: ExportedNames,
  deletions?: DeletionImports | null,
  merge?: TextMergeInput | null,
  exportGuard?: ExportImports | null,
  recipes?: RecipeInput | null,
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
  const textOf = (blob: Sha): string | null => produced.get(blob)?.text ?? merge?.text(blob) ?? recipes?.text(blob) ?? null;
  /** Recipes: what each accepted proposal had applied. */
  const applied = new Map<Id, Array<{ recipe: Id; landing: Id; paths: Path[] }>>();
  // A merged version is not one the trunk writer read exports or imports from: they are read from its text here.
  const surfaces = new Map<Sha, ExportSurface | null>();
  const exportedOf: ExportedNames | undefined = exported
    ? (path, blob) => {
        const made = produced.get(blob);
        if (!made) return exported(path, blob);
        if (!surfaces.has(blob)) surfaces.set(blob, exportSurface(new TextEncoder().encode(made.text), made.path));
        return surfaces.get(blob) ?? null;
      }
    : undefined;
  // The growth check (core onlyGrew) compares the statements of the version a stale read saw with those of the
  // version it would land on, both read with their export surfaces.
  const grewOnly: GrewOnly = (path, read, landed) => {
    const was = exportedOf?.(path, read)?.statements;
    const now = exportedOf?.(path, landed)?.statements;
    return was && now ? onlyGrew(was, now) : null;
  };
  const imported = new Map<Sha, readonly string[]>();
  const targetsOf = (blob: Sha): readonly string[] | undefined => {
    const known = deletions?.targets.get(blob);
    const made = known ? undefined : produced.get(blob);
    if (!made) return known;
    if (!imported.has(blob)) imported.set(blob, importTargets(made.path, made.text));
    return imported.get(blob);
  };
  const exportRun = exportGuard === undefined ? null : exportRunFor(exportGuard, produced);
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
    for (const { p: proposal, base: started, lock } of batch) {
      let p = proposal;
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      // Recipes (trunk/recipes.ts): a proposal built before a recipe landed is brought through it first. What lands is the
      // recipe's output of its written files; it is checked with its bases and reads moved through the recipe.
      const commuted = recipes ? commute(p, started, recipes, virtual) : null;
      if (commuted) for (const [blob, made] of commuted.texts) produced.set(blob, made);
      const base = commuted ? commuted.base : started;
      if (commuted) p = commuted.p;
      const checked = commuted ? commuted.check : p;
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
      const occ = validateProposal(checked, virtual, base);
      let kept: Revalidated[] | null = null;
      let files: TextMerged[] | null = null;
      if (!occ.eligible) {
        const tried = merge ? mergeWrites(p, occ.stale, base, virtual, textOf, merge.blobOf, merge.insertions === true) : null;
        const rv = tried?.ok || !exportedOf ? null : revalidate(checked, occ.stale, exportedOf, grewOnly);
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
          const changed = rv?.ok === false && rv.changed ? `; ${changedText(rv.changed)}` : "";
          const conflicted = tried && !tried.ok && tried.conflicts.length > 0 ? tried.conflicts : null;
          const conflicts = conflicted ? `; ${conflictText(conflicted)}` : "";
          // Recipes: the versions a recipe made that a conflict names are stored with the cycle, so its quotes can be read.
          if (commuted && conflicted) for (const c of conflicted) for (const b of [c.base, c.theirs]) if (produced.has(b)) mergedTexts.set(b, produced.get(b)!.text);
          const reason = `stale: ${detail}${broken}${changed}${conflicts}`;
          // A locked change never goes on to the conflict resolver (merge locks): its conflicts stay in the reason only.
          back.push({ proposalId: p.id, reason: commuted ? refusedText(reason, commuted, occ.stale) : reason, ...(conflicted && !lock ? { conflicts: conflicted } : {}) });
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
      // Merge locks (trunk/mergelock.ts): a change a person decided on lands merged only once a person approved that merge.
      // Before the export guard, which records what a change it lets through stops exporting.
      // Recipes: a locked change's files a recipe rewrote land only once a person approved the rewrite, as a merge does.
      const lockFiles = commuted && lock ? recipeLockFiles(files, commuted, started, virtual) : files;
      const hold = lockFiles && lock ? mergeHold(lock, p.id, lockFiles, (path) => ahead.get(path)?.by, textOf) : null;
      if (hold !== null) {
        back.push(commuted ? recipeHold(hold, commuted) : hold);
        continue;
      }
      const unexported = exportRun ? brokenExports(p, before, trunk, exportRun, accepted.length) : null;
      if (unexported !== null) {
        back.push({ proposalId: p.id, reason: unexported });
        continue;
      }
      ok.push(p);
      if (commuted) {
        // Recipes: the rewritten versions that land are stored with the cycle's merged texts.
        for (const f of p.writeSet) if (f.blob && produced.has(f.blob)) mergedTexts.set(f.blob, produced.get(f.blob)!.text);
        if (commuted.applied.length > 0) applied.set(p.id, commuted.applied);
      }
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
  return { accepted, returned, revalidated, merged, mergedTexts, ...(exportRun ? { exportsUncovered: exportRun.uncovered } : {}), ...(applied.size > 0 ? { recipes: applied } : {}) };
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

/** Names an export guard reason names at most, per file. */
const GUARD_NAMES_NAMED = 5;

/** What the export guard keeps through one cycle (see brokenExports). */
interface ExportRun {
  /** Null: the guard is on but its input could not be read. */
  input: ExportImports | null;
  /** A version's exports and imports: as the trunk writer read them, or from the text of a version a merge of the cycle made. */
  exportsOf(blob: Sha): GuardExports | null | undefined;
  bindingsOf(blob: Sha): readonly ImportBinding[] | undefined;
  /** Names the proposals accepted so far stopped exporting, per file, each with the first to stop and its batch. */
  removed: Map<Path, Map<string, { by: Id; batch: number }>>;
  /** Script files the proposals accepted so far write (not delete), each with the last to write it and its batch. */
  written: Map<Path, { by: Id; batch: number }>;
  /** Checks of changed script files left undone. */
  uncovered: number;
}

/** A fresh ExportRun over the guard's input and the versions the cycle's merges make (read from their texts once each). */
function exportRunFor(input: ExportImports | null, produced: ReadonlyMap<Sha, { path: Path; text: string }>): ExportRun {
  const made = new Map<Sha, { exports: GuardExports | null; bindings: ImportBinding[] }>();
  const fromMerge = (blob: Sha): { exports: GuardExports | null; bindings: ImportBinding[] } | undefined => {
    const version = produced.get(blob);
    if (!version) return undefined;
    let read = made.get(blob);
    if (!read) {
      read = { exports: guardExports(version.text), bindings: importBindings(version.text) };
      made.set(blob, read);
    }
    return read;
  };
  return {
    input,
    exportsOf: (blob) => (input?.exports.has(blob) ? input.exports.get(blob) : fromMerge(blob)?.exports),
    bindingsOf: (blob) => input?.bindings.get(blob) ?? fromMerge(blob)?.bindings,
    removed: new Map(),
    written: new Map(),
    uncovered: 0,
  };
}

/**
 * The export guard for one proposal: why it goes back, or null. `before` is trunk as it will be just before `p` lands
 * (trunk, the proposals accepted earlier in the cycle, and the ones accepted earlier in its batch); imports resolve as
 * the deletion guard resolves them, against trunk as it will be once `p` lands. `batch` is `p`'s batch in the cycle.
 * - A script file `p` writes imports a name that a proposal accepted earlier in the cycle stopped exporting from the
 *   file the import resolves to: `p` goes back naming that proposal (of the two, only the first lands in the cycle).
 * - `p` stops exporting a name from a script file (the version before it exports it; `p`'s version neither exports it
 *   nor may still export it where the export reader cannot see for sure, GuardExports.loose) while a script file
 *   imports it from there once `p` lands: a trunk importer, in the version `p`, the cycle or trunk gives it, or a file a
 *   proposal accepted earlier in the cycle writes. `p` goes back naming the importers, or naming that proposal when it
 *   added the import. An importer rewritten without the import by `p`, or by a proposal ahead of it, no longer counts;
 *   a rewrite later in the cycle does not help, since `p` lands before it.
 * What cannot be checked is skipped and counted in `run.uncovered`, once per file and proposal: a version whose exports
 * were not read or cannot be known (exportedNames null, `export *`, CommonJS), a file whose importers were not looked up,
 * an importer version not read, and an import of the file that takes no checkable names (a namespace import, `export *`,
 * dynamic import, require) or that a path alias might resolve to it. Without input (`run.input` null) every changed
 * script file is skipped. When it lets `p` through, it records what `p` stops exporting and writes for the proposals
 * after it.
 */
function brokenExports(p: Proposal, before: (path: Path) => Sha | null, trunk: (path: Path) => Sha | null, run: ExportRun, batch: number): string | null {
  const own = new Map<Path, Sha | null>();
  for (const f of p.writeSet) own.set(f.path, f.blob ?? null);
  const versionOf = (path: Path): Sha | null => {
    const w = own.get(path);
    return w !== undefined ? w : before(path);
  };
  const exists = (path: Path): boolean => versionOf(path) !== null;
  const changed: Array<{ path: Path; was: Sha; now: Sha }> = [];
  for (const [path, now] of own) {
    const was = before(path);
    if (now !== null && was !== null && now !== was && guardsScript(path)) changed.push({ path, was, now });
  }
  if (run.input === null) {
    run.uncovered += changed.length;
    return null;
  }
  const where = (ahead: { by: Id; batch: number }): string => `${ahead.by}${ahead.batch === batch ? " in this landing" : ", landing ahead in this cycle"}`;

  // A name stopped by a proposal ahead, imported by p.
  if (run.removed.size > 0) {
    for (const [path, blob] of own) {
      if (blob === null || !guardsScript(path)) continue;
      const binds = run.bindingsOf(blob);
      if (binds === undefined) {
        run.uncovered++;
        continue;
      }
      for (const b of binds) {
        if (b.names === null || !isRelative(b.specifier)) continue;
        const file = resolveModule(specifierTarget(path, b.specifier), exists);
        const gone = file === null || own.has(file) ? undefined : run.removed.get(file);
        const hit = gone ? b.names.filter((n) => gone.has(n)) : [];
        if (hit.length === 0) continue;
        const ahead = gone!.get(hit[0]!)!;
        return `conflicts with ${where(ahead)}: it removes ${exportText(hit)} from ${file}, which ${path} imports in this change: read ${file} again once that change lands, and import what it exports then`;
      }
    }
  }

  // Names p stops exporting, and the files importing them once p lands.
  const removes = new Map<Path, string[]>();
  for (const c of changed) {
    const was = run.exportsOf(c.was);
    const now = run.exportsOf(c.now);
    if (!was || !now) {
      run.uncovered++;
      continue;
    }
    const gone = removedNames(was, now);
    if (gone.length > 0) removes.set(c.path, gone);
  }
  const broken = new Map<Path, Map<Path, Set<string>>>();
  let added: { ahead: { by: Id; batch: number }; path: Path; file: Path; names: string[] } | null = null;
  for (const [file, gone] of removes) {
    const importers = run.input.importers.get(file);
    if (importers === undefined) {
      run.uncovered++;
      continue;
    }
    const onTrunk = new Set(importers);
    const candidates = new Set<Path>(importers);
    for (const path of run.written.keys()) candidates.add(path);
    for (const [path, blob] of own) if (blob !== null) candidates.add(path);
    let partial = false;
    for (const path of candidates) {
      const version = versionOf(path);
      // Deleted, not a script, or a file the cycle leaves as trunk has it that does not import the file there.
      if (path === file || version === null || !guardsScript(path) || (!onTrunk.has(path) && version === trunk(path))) continue;
      const binds = run.bindingsOf(version);
      if (binds === undefined) {
        partial = true;
        continue;
      }
      for (const b of binds) {
        if (!isRelative(b.specifier)) {
          if (mayName(b.specifier, file) && (b.names === null || b.names.some((n) => gone.includes(n)))) partial = true;
          continue;
        }
        if (resolveModule(specifierTarget(path, b.specifier), exists) !== file) continue;
        if (b.names === null) {
          partial = true;
          continue;
        }
        const hit = b.names.filter((n) => gone.includes(n));
        if (hit.length === 0) continue;
        const ahead = own.has(path) ? undefined : run.written.get(path);
        if (ahead && !onTrunk.has(path)) {
          added ??= { ahead, path, file, names: hit };
          continue;
        }
        const by = broken.get(file) ?? new Map<Path, Set<string>>();
        const names = by.get(path) ?? new Set<string>();
        for (const n of hit) names.add(n);
        by.set(path, names);
        broken.set(file, by);
      }
    }
    if (partial) run.uncovered++;
  }
  if (added) {
    return `conflicts with ${where(added.ahead)}: its ${added.path} imports ${listText(added.names, GUARD_NAMES_NAMED)} from ${added.file}, which this change stops exporting: keep the export, or change ${added.path} in this change once that change lands`;
  }
  if (broken.size > 0) return removalReason(broken);

  // p lands: what it stops exporting and what it writes bind the proposals after it.
  for (const [path, blob] of own) {
    const stopped = run.removed.get(path);
    if (blob === null) {
      run.removed.delete(path);
      run.written.delete(path);
      continue;
    }
    if (stopped) {
      // A name p's version exports again, or may, is no longer removed; with its exports unknown, nothing is.
      const now = run.exportsOf(blob);
      if (!now) run.removed.delete(path);
      else for (const n of [...stopped.keys()]) if (now.names.has(n) || now.loose.has(n)) stopped.delete(n);
    }
    if (guardsScript(path)) run.written.set(path, { by: p.id, batch });
  }
  for (const [file, gone] of removes) {
    const stopped = run.removed.get(file) ?? new Map<string, { by: Id; batch: number }>();
    for (const n of gone) if (!stopped.has(n)) stopped.set(n, { by: p.id, batch });
    run.removed.set(file, stopped);
  }
  return null;
}

/** "export foo" or "exports foo and bar" (at most GUARD_NAMES_NAMED names). */
function exportText(names: readonly string[]): string {
  return `${names.length === 1 ? "export" : "exports"} ${listText(names, GUARD_NAMES_NAMED)}`;
}

/** The export guard's reason for a removal that breaks imports: per removed file its names, then the importers. */
function removalReason(broken: Map<Path, Map<Path, Set<string>>>): string {
  const files = [...broken.keys()].sort();
  const parts = files.map((file) => `${exportText([...new Set([...broken.get(file)!.values()].flatMap((s) => [...s]))].sort())} from ${file}`);
  const importers = [...new Set([...broken.values()].flatMap((by) => [...by.keys()]))].sort();
  const one = importers.length === 1;
  return `removing ${listText(parts, GUARD_FILES_NAMED)} breaks the ${one ? "import" : "imports"} in ${listText(importers, GUARD_IMPORTERS_NAMED)}: change ${one ? importers[0] : "them"} in the same change, or first`;
}

/** "a", "a and b", "a, b and c"; past `max` items, the first `max` and "N more". */
function listText(items: readonly string[], max: number): string {
  const parts = items.length > max ? [...items.slice(0, max), `${items.length - max} more`] : [...items];
  return parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** Larger files are never read for their exports (their readers go back as stale). */
export const SURFACE_FILE_BYTES = 512 * 1024;

/**
 * Import-name revalidation: the blobs whose exported names and statements a cycle may need, each with
 * its file. For each file a proposal read and imports names from (a name assumption): trunk's blob of it and
 * every new blob a proposal of the cycle writes there (the versions the plan's virtual trunk can hold),
 * other than the blob the proposal read, and then, when there is any, the blob it read (the growth check
 * compares the two). A file whose only version is the one read is not stale: nothing to read. Each blob
 * once, in first-seen order, with the first file it was wanted for.
 */
export function surfaceBlobs(proposals: Proposal[], trunk: (path: Path) => Sha | null): Array<{ blob: Sha; path: Path }> {
  const written = new Map<Path, Sha[]>();
  for (const p of proposals) {
    for (const w of p.writeSet) {
      if (w.blob === null) continue;
      const list = written.get(w.path) ?? [];
      list.push(w.blob);
      written.set(w.path, list);
    }
  }
  const want = new Map<Sha, Path>();
  for (const p of proposals) {
    if (!Array.isArray(p.nameAssumptions)) continue;
    const reads = new Map<Path, Set<Sha | null>>();
    for (const r of p.readSet) reads.set(r.path, (reads.get(r.path) ?? new Set<Sha | null>()).add(r.blob ?? null));
    for (const np of p.nameAssumptions) {
      const read = np && typeof np.path === "string" ? reads.get(np.path) : undefined;
      if (!read) continue;
      const others = [trunk(np.path), ...(written.get(np.path) ?? [])].filter((blob): blob is Sha => blob !== null && !read.has(blob));
      if (others.length === 0) continue;
      for (const blob of [...others, ...read]) if (blob !== null && !want.has(blob)) want.set(blob, np.path);
    }
  }
  return [...want].map(([blob, path]) => ({ blob, path }));
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
 * The export surface of one file version (import-name revalidation), or null when it cannot be known for
 * sure: too large, not UTF-8 text, or a source the export reader cannot read reliably. With `path` (which
 * says how to read the file), its top-level statements too, for the growth check: null when they cannot
 * be read for sure (decide/statements.ts), so a change that read another version of the file goes back.
 */
export function exportSurface(bytes: Uint8Array, path?: Path): ExportSurface | null {
  if (bytes.length > SURFACE_FILE_BYTES) return null;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
  const ex = exportedNames(text);
  if (ex === null) return null;
  const surface: ExportSurface = { names: ex.names, open: ex.star.length > 0 };
  if (path !== undefined) surface.statements = topStatements(path, text);
  return surface;
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
        res.returned.push({ proposalId: id, reason: o.reason, ...(o.conflicts ? { conflicts: o.conflicts } : {}), ...(o.held ? { held: o.held } : {}) });
      } else {
        (res.deferred ??= []).push({ proposalId: id, reason: o.reason });
      }
    }
    if (prior.size > 0) res.prior = [...prior.values()];
    return res;
  });
}
