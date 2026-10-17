import { applyRecipe, blobId, recipeCovers, recipeNames, recipeText, sameOutputs } from "@fire_trident/core";
import type { FileVersion, HeldMergeFile, Id, Landing, LineageNote, NoteRecipe, Path, Proposal, Recipe, RecipeBatch, RecipeOutput, RecipeRecord, RecipeRefusal, RecipeState, Sha, TextMerged } from "@fire_trident/core";
import type { SqlRunner } from "../colony/inline.ts";
import { dangerLabels, scanDanger } from "../decide/danger.ts";
import { parseDirection } from "./direction.ts";
import { maskStrings } from "./mask.ts";

/**
 * Recipes: a third kind of change beside a proposal of files and an intent. A person declares a recipe (a built-in,
 * deterministic transform with a pinned version, its arguments and a scope of globs, core/recipe.ts); the colony makes it
 * an intent with `recipe` set, and the trunk writer lands it:
 *
 * - Landing. On its serial chain, between landing cycles, the trunk writer takes the next batch of trunk files in scope
 *   (in path order after the recipe's cursor, at most RECIPE_BATCH_FILES files and RECIPE_BATCH_BYTES bytes: its read
 *   budget), runs the transform over each twice and compares the outputs (the determinism check), scans the output for
 *   danger patterns, and lands the files it changed as one tree-surgery commit, an ordinary diff to stock git. Its lineage
 *   note carries the recipe, the batch, every output with its blobs before and after, and the files it left as they were
 *   with why. A scope larger than one batch spans several commits, landing cycles running between them. A danger pattern
 *   in a batch's output holds the recipe for a person (`held`): their approval of that very output lands it. A batch that
 *   changes nothing moves the cursor without a commit. The recipe is `landed` once its cursor passed the last file.
 * - Commutation. A change in flight whose base is older than a recipe's completion (or any change, while the recipe is
 *   still landing) has the recipe applied before it is validated (`commute`): to each file it writes in scope (its
 *   blobs are what lands), to its base versions (a file whose only change since the base is the recipe's is not stale),
 *   and to what it read (a read that, transformed, equals what trunk has is current). Its note records the recipes
 *   applied. A written file a recipe cannot transform, or whose transform would add a danger pattern, keeps its own
 *   version and the ordinary rules apply (stale means back, and the reason names the recipe's landing). A change a
 *   person decided on (a merge lock) whose files a recipe would rewrite goes to a person with the rewrite, as a held
 *   merge does.
 * - A person's revert of one of a recipe's landings stops the recipe: it lands no more and is applied to no change.
 *
 * The SQL lives in the trunk writer's storage (ft_recipes, ft_recipe_landings); the landing step reads and commits through
 * a RecipeHost (TrunkDO, or a stand-in in tests). The `module` kind (FT_RECIPE_MODULES) runs through a RecipeRunner,
 * which the trunk writer only has where the flag is on; it lands batches but is not applied to changes in flight.
 */

/** Scope files one batch reads at most, and their bytes: the read budget a recipe spans cycles past. */
export const RECIPE_BATCH_FILES = 100;
export const RECIPE_BATCH_BYTES = 4 * 1024 * 1024;
/** A file larger than this is never transformed (it is left as it was, `unread`). */
export const RECIPE_FILE_BYTES = 512 * 1024;
/** Commutation: blobs one cycle reads at most for the texts its recipes need, and bytes. */
export const RECIPE_TEXT_READS = 400;
export const RECIPE_TEXT_BYTES = 8 * 1024 * 1024;
/** How long a declaring call drives batches before the trunk writer's alarm takes over (ms), and that alarm's delay. */
export const RECIPE_CALL_MS = 20_000;
export const RECIPE_ALARM_MS = 1_000;
/** Recipes that commutation considers at most (the newest), and files left as they were that a record lists. */
const RECIPES_LIVE = 32;
const UNTRANSFORMED_LISTED = 50;
const NOTE_UNTRANSFORMED = 50;

/** The trunk writer's recipe tables (additive: nothing existing is touched). */
export const RECIPE_TABLES = [
  "CREATE TABLE IF NOT EXISTS ft_recipes (id TEXT PRIMARY KEY, intent_id TEXT NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS ft_recipe_landings (landing_id TEXT PRIMARY KEY, recipe_id TEXT NOT NULL, landing_seq INTEGER NOT NULL, from_path TEXT, through_path TEXT NOT NULL, reverted INTEGER NOT NULL DEFAULT 0)",
];

/** Create the recipe tables. */
export function migrateRecipes(sql: SqlRunner): void {
  for (const stmt of RECIPE_TABLES) sql.exec(stmt);
}

/** What the trunk writer keeps of a recipe besides its columns. */
interface RecipeData {
  colonyId: Id;
  recipe: Recipe;
  why: string;
  by: string;
  cursor: Path | null;
  batches: RecipeBatch[];
  examined: number;
  changed: number;
  untransformed: Array<{ path: Path; reason: RecipeRefusal; detail?: string }>;
  untransformedMore: number;
  held?: { hits: string[]; paths: Path[]; outputs: Record<Path, Sha> };
  /** A person's approval of a held batch's exact output. */
  approval?: { by: string; at: number; hits: string[]; outputs: Record<Path, Sha> };
  reason?: string;
  /** The landing log's newest sequence number when the recipe landed its last batch (commutation's watermark). */
  doneSeq?: number;
}

interface RecipeRow {
  id: string;
  intent_id: string;
  state: string;
  data: string;
  created_at: number;
  updated_at: number;
}

const STATES: ReadonlySet<string> = new Set<RecipeState>(["running", "held", "landed", "failed"]);

function readRow(row: RecipeRow | undefined): { row: RecipeRow; data: RecipeData } | null {
  if (!row) return null;
  try {
    const data = JSON.parse(row.data) as RecipeData;
    if (!data || typeof data !== "object" || !data.recipe) return null;
    return { row, data };
  } catch {
    return null;
  }
}

function rowOf(sql: SqlRunner, id: Id): { row: RecipeRow; data: RecipeData } | null {
  return readRow(sql.exec("SELECT id, intent_id, state, data, created_at, updated_at FROM ft_recipes WHERE id = ?", id).toArray()[0] as RecipeRow | undefined);
}

function save(sql: SqlRunner, id: Id, state: RecipeState, data: RecipeData, now: number): void {
  sql.exec("UPDATE ft_recipes SET state = ?, data = ?, updated_at = ? WHERE id = ?", state, JSON.stringify(data), now, id);
}

/** A stored recipe as the API shows it. */
function toRecord(row: RecipeRow, data: RecipeData): RecipeRecord {
  const state = (STATES.has(row.state) ? row.state : "failed") as RecipeState;
  return {
    id: row.id,
    colonyId: data.colonyId,
    intentId: row.intent_id,
    recipe: data.recipe,
    why: data.why,
    by: data.by,
    state,
    at: row.created_at,
    updatedAt: row.updated_at,
    cursor: data.cursor ?? null,
    batches: data.batches ?? [],
    examined: data.examined ?? 0,
    changed: data.changed ?? 0,
    untransformed: data.untransformed ?? [],
    ...(data.untransformedMore > 0 ? { untransformedMore: data.untransformedMore } : {}),
    ...(state === "held" && data.held ? { held: { hits: data.held.hits, paths: data.held.paths } } : {}),
    ...(data.reason ? { reason: data.reason } : {}),
  };
}

/** One recipe by id, or null. */
export function recipeRecord(sql: SqlRunner, id: Id): RecipeRecord | null {
  const r = rowOf(sql, id);
  return r ? toRecord(r.row, r.data) : null;
}

/** The newest recipes first (at most `limit`). */
export function recipeRecords(sql: SqlRunner, limit = 50): RecipeRecord[] {
  const n = Math.max(1, Math.min(200, Math.floor(Number.isFinite(limit) ? limit : 50)));
  return (sql.exec("SELECT id, intent_id, state, data, created_at, updated_at FROM ft_recipes ORDER BY created_at DESC, rowid DESC LIMIT ?", n).toArray() as RecipeRow[])
    .map(readRow)
    .filter((x): x is { row: RecipeRow; data: RecipeData } => x !== null)
    .map((x) => toRecord(x.row, x.data));
}

/**
 * Record a declared recipe (idempotent by id: a repeat answers the stored one). The recipe was parsed by the colony
 * (core parseRecipe); it starts `running`, its cursor before the first path.
 */
export function recordRecipe(sql: SqlRunner, p: { id: Id; colonyId: Id; intentId: Id; recipe: Recipe; why: string; by: string }, now: number): RecipeRecord {
  const known = recipeRecord(sql, p.id);
  if (known) return known;
  const data: RecipeData = { colonyId: p.colonyId, recipe: p.recipe, why: p.why, by: p.by, cursor: null, batches: [], examined: 0, changed: 0, untransformed: [], untransformedMore: 0 };
  sql.exec("INSERT INTO ft_recipes (id, intent_id, state, data, created_at, updated_at) VALUES (?, ?, 'running', ?, ?, ?)", p.id, p.intentId, JSON.stringify(data), now, now);
  return recipeRecord(sql, p.id)!;
}

/**
 * A person approves a held recipe's next batch: exactly the output they were shown (its files and blobs) lands with the
 * approval in its note; any other output is held again. Null when the recipe is unknown; unchanged when it is not held.
 */
export function approveRecipe(sql: SqlRunner, id: Id, by: string, now: number): RecipeRecord | null {
  const r = rowOf(sql, id);
  if (!r) return null;
  if (r.row.state !== "held" || !r.data.held) return toRecord(r.row, r.data);
  const data: RecipeData = { ...r.data, approval: { by, at: now, hits: r.data.held.hits, outputs: r.data.held.outputs } };
  delete data.held;
  delete data.reason;
  save(sql, id, "running", data, now);
  return recipeRecord(sql, id);
}

/**
 * A person reverted `landingId` (trunk/revert.ts): when it is one of a recipe's batches, the batch is marked reverted
 * and the recipe stops (`failed`, saying why), so it lands no more and no change in flight gets it applied. Returns the
 * recipe's id, or null when the landing was no recipe's.
 */
export function recipeReverted(sql: SqlRunner, landingId: Id, now: number): Id | null {
  const hit = sql.exec("SELECT recipe_id FROM ft_recipe_landings WHERE landing_id = ?", landingId).toArray()[0] as { recipe_id: string } | undefined;
  if (!hit) return null;
  sql.exec("UPDATE ft_recipe_landings SET reverted = 1 WHERE landing_id = ?", landingId);
  const r = rowOf(sql, hit.recipe_id);
  if (!r) return hit.recipe_id;
  const data: RecipeData = {
    ...r.data,
    batches: r.data.batches.map((b) => (b.landingId === landingId ? { ...b, reverted: true } : b)),
    reason: `a person reverted its landing ${landingId}, so it lands no more and is not applied to changes in flight`,
  };
  delete data.held;
  save(sql, hit.recipe_id, "failed", data, now);
  return hit.recipe_id;
}

// ---------------------------------------------------------------------------
// Landing a batch
// ---------------------------------------------------------------------------

/** Runs a recipe over files (a module recipe in the sealed sandbox); one output per file, in order. */
export interface RecipeRunner {
  run(recipe: Recipe, files: ReadonlyArray<{ path: Path; text: string | null }>): Promise<RecipeOutput[]>;
}

/** What a recipe's landing step reads and writes (TrunkDO, or a stand-in in tests). */
export interface RecipeHost {
  sql: SqlRunner;
  now(): number;
  /** Every trunk file now, with its blob and size. */
  files(): Array<{ path: Path; blob: Sha; size: number }>;
  /** A blob's bytes, or null when it cannot be read. */
  read(blob: Sha): Promise<Uint8Array | null>;
  /** Commit the files now, on the serial chain: the landing, or `stale` when a file no longer holds its `expect` (nothing written). */
  commit(c: { files: Array<{ path: Path; content: string; expect: Sha }>; message: string; note: LineageNote & Record<string, unknown>; intentIds: Id[] }): Promise<{ landing: Landing } | { stale: string }>;
  /** The landing log's sequence number of a landing, and the newest one (0 when there is none). */
  landingSeq(landingId: Id): number | null;
  headSeq(): number;
  /** Runs module recipes (FT_RECIPE_MODULES); absent where they are off. */
  runner?: RecipeRunner;
}

/** After a step failed (a push, a read), how long before the alarm tries again (ms). */
export const RECIPE_RETRY_MS = 30_000;

/** What driving recipes needs from the trunk writer (TrunkDO). */
export interface RecipeDriver {
  host(): RecipeHost;
  /** Run `fn` on the trunk writer's serial chain: no landing cycle runs while it does. */
  serial<T>(fn: () => Promise<T>): Promise<T>;
  /** A batch landed: start pushing its lineage note. */
  landed(landing: Landing): Promise<void>;
  /** Tell the colony what a step did (best effort). */
  tell(step: Exclude<RecipeStep, { kind: "idle" }>): Promise<void>;
  /** Be called again in `ms` (the trunk writer's alarm). */
  later(ms: number): Promise<void>;
  now(): number;
  /** While a person has paused the colony's agents trunk stays where it is: the pause's sentence, else null. */
  paused(): string | null;
}

/**
 * Land running recipes, one step at a time on the serial chain (landing cycles run between steps), until none is left
 * running or `until` passes; then the alarm goes on. A step that throws (a push or a read failed) is tried again from the
 * alarm after RECIPE_RETRY_MS.
 */
export async function driveRecipes(d: RecipeDriver, until: number): Promise<void> {
  for (;;) {
    // A pause holds recipes as it holds landing cycles; the alarm looks again.
    if (d.paused() !== null) {
      await d.later(RECIPE_RETRY_MS);
      return;
    }
    let step: RecipeStep;
    try {
      step = await d.serial(() => recipeStep(d.host()));
    } catch (e) {
      console.error(`recipe step failed, trying again later: ${e instanceof Error ? e.message : String(e)}`);
      await d.later(RECIPE_RETRY_MS);
      return;
    }
    if (step.kind === "idle") return;
    if (step.kind === "landed") await d.landed(step.landing).catch((e: unknown) => console.error(`notes flush not started after ${step.kind === "landed" ? step.landing.id : ""}: ${e instanceof Error ? e.message : String(e)}`));
    // A batch that changed nothing is news to nobody.
    if (step.kind !== "advanced") await d.tell(step).catch((e: unknown) => console.warn(`colony not told of recipe ${step.record.id}: ${e instanceof Error ? e.message : String(e)}`));
    if (d.now() >= until) {
      await d.later(RECIPE_ALARM_MS);
      return;
    }
  }
}

/** Whether a recipe is running (the alarm then drives it). */
export function recipeRunning(sql: SqlRunner): boolean {
  return sql.exec("SELECT 1 AS x FROM ft_recipes WHERE state = 'running' LIMIT 1").toArray().length > 0;
}

/** What one landing step did. */
export type RecipeStep =
  | { kind: "idle" }
  | { kind: "landed"; record: RecipeRecord; landing: Landing }
  | { kind: "advanced"; record: RecipeRecord }
  | { kind: "done"; record: RecipeRecord }
  | { kind: "held"; record: RecipeRecord }
  | { kind: "failed"; record: RecipeRecord };

/** A file's bytes as text for a recipe, or null when they are not UTF-8 text (a NUL byte, or invalid UTF-8): binary. */
export function recipeTextOf(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * The next batch of a recipe: trunk files in its scope after `cursor`, in path order, until RECIPE_BATCH_FILES files or
 * RECIPE_BATCH_BYTES bytes (always at least one file). Empty when none is left. Pure.
 */
export function nextBatch(files: ReadonlyArray<{ path: Path; blob: Sha; size: number }>, recipe: Pick<Recipe, "scope">, cursor: Path | null): Array<{ path: Path; blob: Sha; size: number }> {
  const todo = files.filter((f) => (cursor === null || f.path > cursor) && recipeCovers(recipe, f.path)).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const out: Array<{ path: Path; blob: Sha; size: number }> = [];
  let bytes = 0;
  for (const f of todo) {
    if (out.length >= RECIPE_BATCH_FILES || (out.length > 0 && bytes + Math.min(f.size, RECIPE_FILE_BYTES) > RECIPE_BATCH_BYTES)) break;
    out.push(f);
    bytes += Math.min(f.size, RECIPE_FILE_BYTES);
  }
  return out;
}

/** Run a recipe over a batch's texts: a built-in in place, a module through the runner (null: it cannot run here). */
async function runOnce(recipe: Recipe, files: ReadonlyArray<{ path: Path; text: string | null }>, runner: RecipeRunner | undefined): Promise<RecipeOutput[] | null> {
  if (recipe.kind === "module") return runner ? runner.run(recipe, files) : null;
  return files.map((f) => applyRecipe(recipe, f.path, f.text));
}

/** The recipe the step works on: the oldest running one. */
function nextRunning(sql: SqlRunner): { row: RecipeRow; data: RecipeData } | null {
  return readRow(sql.exec("SELECT id, intent_id, state, data, created_at, updated_at FROM ft_recipes WHERE state = 'running' ORDER BY created_at, rowid LIMIT 1").toArray()[0] as RecipeRow | undefined);
}

/**
 * One landing step of the oldest running recipe (call it on the trunk writer's serial chain): read its next batch, run
 * the transform twice and compare (a difference fails the recipe), scan the output for danger patterns (a hit holds the
 * recipe for a person unless they approved exactly this output), and land what changed as one commit. A batch that
 * changes nothing moves the cursor. No batch left: the recipe is landed.
 */
export async function recipeStep(host: RecipeHost): Promise<RecipeStep> {
  const cur = nextRunning(host.sql);
  if (!cur) return { kind: "idle" };
  const { row, data } = cur;
  const id = row.id;
  const recipe = data.recipe;
  // A person withdrew the recipe's intent (the direction fence recorded it): the recipe stops before its next batch.
  const withdrawn = withdrawnReason(host.sql, row.intent_id);
  if (withdrawn !== null) return fail(host, id, data, `a person withdrew its intent (${withdrawn}), so it lands no more`);
  const batch = nextBatch(host.files(), recipe, data.cursor);
  if (batch.length === 0) {
    // Its watermark: the landing of its last batch (a change built on that commit or later has all of it).
    const last = data.batches[data.batches.length - 1];
    const done: RecipeData = { ...data, doneSeq: (last ? host.landingSeq(last.landingId) : null) ?? host.headSeq() };
    save(host.sql, id, "landed", done, host.now());
    return { kind: "done", record: recipeRecord(host.sql, id)! };
  }
  if (recipe.kind === "module" && !host.runner) {
    return fail(host, id, data, "module recipes are off on this deployment (FT_RECIPE_MODULES), so this recipe cannot run");
  }
  const inputs: Array<{ path: Path; blob: Sha; text: string | null; unread?: string }> = [];
  for (const f of batch) {
    if (f.size > RECIPE_FILE_BYTES) {
      inputs.push({ path: f.path, blob: f.blob, text: null, unread: `larger than ${RECIPE_FILE_BYTES / 1024} KB` });
      continue;
    }
    const bytes = await host.read(f.blob);
    if (bytes === null) inputs.push({ path: f.path, blob: f.blob, text: null, unread: "its blob could not be read" });
    else inputs.push({ path: f.path, blob: f.blob, text: recipeTextOf(bytes) });
  }
  const readable = inputs.map((f) => ({ path: f.path, text: f.text }));
  // The determinism check: two runs over the same texts must agree exactly, or nothing lands.
  let first: RecipeOutput[] | null;
  let second: RecipeOutput[] | null;
  try {
    first = await runOnce(recipe, readable, host.runner);
    second = await runOnce(recipe, readable, host.runner);
  } catch (e) {
    return fail(host, id, data, `the recipe's sandbox failed (${e instanceof Error ? e.message : String(e)}), so nothing of it lands`);
  }
  if (first === null || second === null || first.length !== inputs.length || !sameOutputs(first, second)) {
    return fail(host, id, data, "the recipe gave different outputs for the same files on two runs, so it is not deterministic and nothing of it lands");
  }
  const outputs: Array<{ path: Path; before: Sha; text: string; was: string; after: Sha }> = [];
  const left: Array<{ path: Path; reason: RecipeRefusal; detail?: string }> = [];
  inputs.forEach((f, i) => {
    if (f.unread) {
      left.push({ path: f.path, reason: "unread", detail: f.unread });
      return;
    }
    const out = first[i]!;
    if (!out.ok) left.push({ path: f.path, reason: out.reason, detail: out.detail });
    else if (f.text !== null && out.text !== f.text) outputs.push({ path: f.path, before: f.blob, text: out.text, was: f.text, after: blobId(out.text) });
  });
  const through = batch[batch.length - 1]!.path;
  const from = data.cursor;
  // The danger scan on the output: a recipe proves its output by construction, not that the output is harmless.
  const hits = scanDanger(
    outputs.map((o) => ({ path: o.path, before: o.was, after: o.text })),
    null,
  );
  const outputMap = Object.fromEntries(outputs.map((o) => [o.path, o.after]));
  let approved: NoteRecipe["approved"];
  if (hits.length > 0) {
    const ok = data.approval !== undefined && sameMap(data.approval.outputs, outputMap);
    if (!ok) {
      const labels = dangerLabels(hits);
      const held: RecipeData = {
        ...data,
        held: { hits: labels, paths: [...new Set(hits.map((h) => h.path))].sort(), outputs: outputMap },
        reason: `its next batch's output has ${hits.length === 1 ? "a danger pattern" : `${hits.length} danger patterns`} a person must see (${labels.slice(0, 3).join("; ")}): approve the recipe to land exactly this output, or leave it held`,
      };
      delete held.approval;
      save(host.sql, id, "held", held, host.now());
      return { kind: "held", record: recipeRecord(host.sql, id)! };
    }
    approved = { by: data.approval!.by, at: data.approval!.at, hits: data.approval!.hits };
  }
  const listed = data.untransformed.length;
  const room = Math.max(0, UNTRANSFORMED_LISTED - listed);
  const next: RecipeData = {
    ...data,
    cursor: through,
    examined: data.examined + inputs.length,
    changed: data.changed + outputs.length,
    untransformed: [...data.untransformed, ...left.slice(0, room)],
    untransformedMore: data.untransformedMore + Math.max(0, left.length - room),
  };
  delete next.approval;
  delete next.reason;
  if (outputs.length === 0) {
    save(host.sql, id, "running", next, host.now());
    return { kind: "advanced", record: recipeRecord(host.sql, id)! };
  }
  const number = data.batches.length + 1;
  const noteRecipe: NoteRecipe = {
    id,
    intentId: row.intent_id,
    kind: recipe.kind,
    version: recipe.version,
    // A module's source is code, not lineage: the note names it by its blob id.
    args: recipe.kind === "module" ? { source: blobId(String(recipe.args.source ?? "")) } : recipe.args,
    scope: recipe.scope,
    why: data.why,
    by: data.by,
    batch: number,
    from,
    through,
    outputs: outputs.map((o) => ({ path: o.path, before: o.before, after: o.after })),
    untransformed: left.slice(0, NOTE_UNTRANSFORMED),
    ...(left.length > NOTE_UNTRANSFORMED ? { untransformedMore: left.length - NOTE_UNTRANSFORMED } : {}),
    ...(approved ? { approved } : {}),
  };
  const note = { schema: "firetrident.lineage/v1", landingId: "", colonyId: "", proposals: [], recipe: maskStrings(noteRecipe) } as unknown as LineageNote & Record<string, unknown>;
  const message = recipeMessage(id, row.intent_id, recipe, data.why, number, outputs.length);
  const done = await host.commit({ files: outputs.map((o) => ({ path: o.path, content: o.text, expect: o.before })), message, note, intentIds: [row.intent_id] });
  // A file moved since the batch was read (trunk caught up with an outside push): the next step reads it again.
  if ("stale" in done) return { kind: "advanced", record: recipeRecord(host.sql, id)! };
  const landing = done.landing;
  const seq = host.landingSeq(landing.id) ?? host.headSeq();
  host.sql.exec(
    "INSERT OR REPLACE INTO ft_recipe_landings (landing_id, recipe_id, landing_seq, from_path, through_path, reverted) VALUES (?, ?, ?, ?, ?, 0)",
    landing.id,
    id,
    seq,
    from,
    through,
  );
  next.batches = [...data.batches, { landingId: landing.id, trunkSha: landing.trunkSha, from, through, files: inputs.length, changed: outputs.length, at: landing.at }];
  save(host.sql, id, "running", next, host.now());
  return { kind: "landed", record: recipeRecord(host.sql, id)!, landing };
}

/** Why the recipe's intent was withdrawn, from the trunk writer's direction record (trunk/direction.ts), or null. */
function withdrawnReason(sql: SqlRunner, intentId: Id): string | null {
  try {
    const row = sql.exec("SELECT info FROM ft_direction WHERE intent_id = ?", intentId).toArray()[0] as { info?: unknown } | undefined;
    const info = row ? parseDirection(row.info) : undefined;
    return info?.status === "withdrawn" ? (info.withdrawnReason ?? "no reason given").slice(0, 300) : null;
  } catch {
    return null;
  }
}

function fail(host: RecipeHost, id: Id, data: RecipeData, reason: string): RecipeStep {
  const failed: RecipeData = { ...data, reason };
  delete failed.held;
  save(host.sql, id, "failed", failed, host.now());
  return { kind: "failed", record: recipeRecord(host.sql, id)! };
}

function sameMap(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
}

/** A recipe batch's commit message: the recipe in a few words, the person's why, and FT-Recipe and FT-Intent trailers. */
export function recipeMessage(id: Id, intentId: Id, recipe: Recipe, why: string, batch: number, files: number): string {
  const subject = `Recipe: ${recipeText(recipe)}`.replace(/\s+/g, " ").slice(0, 72);
  const body = `${batch === 1 ? "First batch" : `Batch ${batch}`} of recipe ${id}: ${files} file${files === 1 ? "" : "s"} rewritten by the trunk writer.${why.trim() ? `\n\n${why.replace(/\r/g, "").trim().slice(0, 500)}` : ""}`;
  return `${subject}\n\n${body}\n\nFT-Recipe: ${id}\nFT-Intent: ${intentId}`;
}

/**
 * What the recipe would still change on trunk now (the residue): the scope files it would rewrite, and the ones it would
 * leave as they were, reading at most `maxFiles` files. A landed rename has none to rewrite. Read only.
 */
export async function recipeResidue(
  host: Pick<RecipeHost, "files" | "read" | "runner">,
  record: RecipeRecord,
  maxFiles = 2_000,
): Promise<{ examined: number; rewrite: Path[]; untransformed: Array<{ path: Path; reason: RecipeRefusal }>; truncated: boolean; grep?: Path[] }> {
  const todo = host.files().filter((f) => recipeCovers(record.recipe, f.path)).sort((a, b) => (a.path < b.path ? -1 : 1));
  const files = todo.slice(0, maxFiles);
  const rewrite: Path[] = [];
  const untransformed: Array<{ path: Path; reason: RecipeRefusal }> = [];
  // A rename's plain grep too: the scope files whose text still has the old name as a whole word anywhere (comments and
  // strings included, which the rename leaves).
  const from = record.recipe.kind === "rename-identifier" ? String(record.recipe.args.from) : null;
  const word = from ? new RegExp(`(^|[^\\w$])${from.replace(/\$/g, "\\$")}(?![\\w$])`) : null;
  const grep: Path[] = [];
  for (const f of files) {
    const bytes = f.size > RECIPE_FILE_BYTES ? null : await host.read(f.blob);
    if (bytes === null) {
      untransformed.push({ path: f.path, reason: "unread" });
      continue;
    }
    const text = recipeTextOf(bytes);
    if (word && text !== null && word.test(text)) grep.push(f.path);
    let out: RecipeOutput | undefined;
    try {
      out = (await runOnce(record.recipe, [{ path: f.path, text }], host.runner))?.[0];
    } catch {
      out = undefined;
    }
    if (!out) untransformed.push({ path: f.path, reason: "unread" });
    else if (!out.ok) untransformed.push({ path: f.path, reason: out.reason });
    else if (out.text !== text) rewrite.push(f.path);
  }
  return { examined: files.length, rewrite, untransformed, truncated: todo.length > files.length, ...(word ? { grep } : {}) };
}

// ---------------------------------------------------------------------------
// Commutation
// ---------------------------------------------------------------------------

/** A recipe as commutation applies it: the recipe, its newest batch landing, how far it has run, and its completion watermark. */
export interface LiveRecipe {
  id: Id;
  recipe: Recipe;
  /** Its newest landed batch: what a note and a reason name. */
  landingId: Id;
  /** Its landed batches' ranges, to name the batch that covered a path. */
  batches: ReadonlyArray<Pick<RecipeBatch, "landingId" | "from" | "through">>;
  /** The last scope path it has run over (null: none). */
  cursor: Path | null;
  /** The landing log's newest sequence number when it landed its last batch; null while it still runs. */
  doneSeq: number | null;
}

/**
 * The recipes commutation applies: built-in recipes that landed at least one batch, none of them reverted, that are
 * still running, held, or landed (the newest RECIPES_LIVE), oldest first.
 */
export function liveRecipes(sql: SqlRunner): LiveRecipe[] {
  const rows = sql
    .exec("SELECT id, intent_id, state, data, created_at, updated_at FROM ft_recipes WHERE state IN ('running', 'held', 'landed') ORDER BY created_at DESC, rowid DESC LIMIT ?", RECIPES_LIVE)
    .toArray() as RecipeRow[];
  const out: LiveRecipe[] = [];
  for (const r of rows.reverse()) {
    const x = readRow(r);
    if (!x || x.data.recipe.kind === "module") continue;
    const batches = (x.data.batches ?? []).filter((b) => !b.reverted);
    if (batches.length === 0 || batches.length !== (x.data.batches ?? []).length) continue;
    out.push({
      id: r.id,
      recipe: x.data.recipe,
      landingId: batches[batches.length - 1]!.landingId,
      batches,
      cursor: x.data.cursor ?? null,
      doneSeq: r.state === "landed" && typeof x.data.doneSeq === "number" ? x.data.doneSeq : null,
    });
  }
  return out;
}

/** A base commit's place in the landing log (its newest sequence number; 0 for the commit the log starts from; -1 when unknown, older than every landing). */
function baseSeqs(sql: SqlRunner, shas: readonly Sha[]): Map<Sha, number> {
  const want = [...new Set(shas.filter((s) => typeof s === "string" && /^[0-9a-f]{40}$/.test(s)))];
  const out = new Map<Sha, number>();
  if (want.length === 0) return out;
  for (const r of sql.exec("SELECT trunk_sha, MAX(seq) AS seq FROM ft_landings WHERE trunk_sha IN (SELECT value FROM json_each(?)) GROUP BY trunk_sha", JSON.stringify(want)).toArray() as Array<{ trunk_sha: string; seq: number }>) {
    out.set(r.trunk_sha, r.seq);
  }
  return out;
}

/**
 * The recipes each change gets applied (commutation): the live recipes it touches (a path it reads or writes in scope)
 * whose completion its base does not include: still running or held, or landed after its base (its base's place in the
 * landing log is before the recipe's watermark; a base the log does not know counts as older). Changes with none are
 * left out. Oldest recipe first.
 */
export function recipesFor(
  sql: SqlRunner,
  proposals: ReadonlyArray<Pick<Proposal, "id" | "baseSha" | "writeSet" | "readSet">>,
  live: readonly LiveRecipe[] = liveRecipes(sql),
): Map<Id, LiveRecipe[]> {
  const out = new Map<Id, LiveRecipe[]>();
  if (live.length === 0 || proposals.length === 0) return out;
  const seqs = baseSeqs(sql, proposals.map((p) => p.baseSha));
  for (const p of proposals) {
    const base = seqs.get(p.baseSha) ?? -1;
    const paths = [...(Array.isArray(p.writeSet) ? p.writeSet : []), ...(Array.isArray(p.readSet) ? p.readSet : [])].map((f) => f.path);
    const list = live.filter((r) => (r.doneSeq === null || base < r.doneSeq) && paths.some((path) => typeof path === "string" && recipeCovers(r.recipe, path)));
    if (list.length > 0) out.set(p.id, list);
  }
  return out;
}

/**
 * The blobs whose texts commutation reads for these changes: in each applied recipe's scope, every blob a change writes,
 * its base versions and the versions it read, other than trunk's own. Each once, in first-seen order.
 */
export function recipeBlobs(entries: ReadonlyArray<{ p: Proposal; base: readonly FileVersion[] }>, recipes: ReadonlyMap<Id, readonly LiveRecipe[]>, trunk: (path: Path) => Sha | null): Sha[] {
  const want = new Set<Sha>();
  for (const { p, base } of entries) {
    const list = recipes.get(p.id);
    if (!list) continue;
    const covered = (path: Path): boolean => list.some((r) => recipeCovers(r.recipe, path));
    for (const f of [...p.writeSet, ...base, ...p.readSet]) {
      const blob = f.blob ?? null;
      if (blob !== null && covered(f.path) && blob !== trunk(f.path)) want.add(blob);
    }
  }
  return [...want];
}

/** What the plan reads to apply recipes to changes in flight (see planCycle). */
export interface RecipeInput {
  /** The recipes a change gets applied, oldest first (recipesFor); none: it is planned as before. */
  later(p: Proposal): readonly LiveRecipe[] | undefined;
  /** A blob's text as the trunk writer loaded it; null when it did not (binary, too large, past the budget, unreadable). */
  text(blob: Sha): string | null;
  blobOf(text: string): Sha;
}

/** One change brought through the recipes that landed after its base (see commute). */
export interface Commuted {
  /** The change as it lands: each written file a recipe rewrote has the recipe's output instead. */
  p: Proposal;
  /** The change as it is validated: also its reads that equal trunk through the recipes, and its imported names renamed. */
  check: Proposal;
  /** Its base versions, moved through the recipes where trunk already has them so. */
  base: FileVersion[];
  /** Each recipe that rewrote one of its written files, with the landing named and those files. */
  applied: Array<{ recipe: Id; landing: Id; paths: Path[] }>;
  /** Every text the recipes made, by blob, with its file. */
  texts: Map<Sha, { path: Path; text: string }>;
  /** Written files a recipe could not bring through: the change keeps its own version there. */
  refused: Array<{ path: Path; recipe: Id; landing: Id; why: string }>;
  /** Written files the recipes rewrote: the change's own blob and the rewrite (a merge lock holds them for a person). */
  rewrote: Array<{ path: Path; theirs: Sha; result: Sha }>;
}

/** The batch of a recipe that covered `path` (its range holds it), else its newest. */
function landingFor(r: LiveRecipe, path: Path): Id {
  const b = r.batches.find((x) => (x.from === null || path > x.from) && path <= x.through);
  return b?.landingId ?? r.landingId;
}

/** Has the recipe run over `path` on trunk (landed, or its cursor passed the path)? */
function ranOver(r: LiveRecipe, path: Path): boolean {
  return r.doneSeq !== null || (r.cursor !== null && path <= r.cursor);
}

/** Why a refusal leaves a file as it was, in words. */
function refusalWords(o: Extract<RecipeOutput, { ok: false }>): string {
  return `${o.reason}: ${o.detail}`;
}

/**
 * Bring one change through the recipes that landed after its base (planCycle calls it before validating the change),
 * or null when none applies. In order, each recipe whose scope covers a file:
 * - a written file's text is transformed; the output is what lands. A refusal (unparsable, binary, a name taken, a text
 *   not loaded), or an output that adds a danger pattern, leaves the change's own version, and the file is named in
 *   `refused` (the ordinary rules then decide: stale means back);
 * - its base version is transformed: when the output is what trunk has, or the recipe has already run over the file on
 *   trunk, the transformed base is the one the change is checked against (and merged from);
 * - a version it read is transformed: when the output is what trunk has, the read counts as current.
 * Imported names follow a rename (core recipeNames). Pure.
 */
export function commute(p: Proposal, base: readonly FileVersion[], input: RecipeInput, virtual: (path: Path) => Sha | null): Commuted | null {
  const list = input.later(p);
  if (!list || list.length === 0) return null;
  const texts = new Map<Sha, { path: Path; text: string }>();
  const covering = (path: Path): LiveRecipe[] => list.filter((r) => recipeCovers(r.recipe, path));
  /** A blob through every covering recipe: the final text and blob, or the first refusal. */
  const through = (path: Path, blob: Sha, rs: readonly LiveRecipe[]): { blob: Sha; text: string; was: string } | { refused: string; by: LiveRecipe } => {
    const was = input.text(blob);
    if (was === null) return { refused: "unread: its text was not loaded (binary, larger than 512 KB, or past this cycle's budget)", by: rs[0]! };
    let text = was;
    for (const r of rs) {
      const out = applyRecipe(r.recipe, path, text);
      if (!out.ok) return { refused: refusalWords(out), by: r };
      text = out.text;
    }
    if (text === was) return { blob, text, was };
    const made = input.blobOf(text);
    texts.set(made, { path, text });
    return { blob: made, text, was };
  };
  const applied = new Map<Id, { recipe: Id; landing: Id; paths: Path[] }>();
  const refused: Commuted["refused"] = [];
  const rewrote: Commuted["rewrote"] = [];
  const writes = p.writeSet.map((w) => {
    const blob = w.blob ?? null;
    const rs = covering(w.path);
    if (blob === null || rs.length === 0) return w;
    const out = through(w.path, blob, rs);
    if ("refused" in out) {
      refused.push({ path: w.path, recipe: out.by.id, landing: landingFor(out.by, w.path), why: out.refused });
      return w;
    }
    if (out.blob === blob) return w;
    // A recipe proves its output by construction, not that the output is harmless: a rewrite that adds a danger pattern
    // is not made here, and the change's own version goes through the ordinary rules.
    const hits = scanDanger([{ path: w.path, before: out.was, after: out.text }], null);
    if (hits.length > 0) {
      texts.delete(out.blob);
      refused.push({ path: w.path, recipe: rs[0]!.id, landing: landingFor(rs[0]!, w.path), why: `its rewrite would add a danger pattern (${dangerLabels(hits, 2).join("; ")})` });
      return w;
    }
    rewrote.push({ path: w.path, theirs: blob, result: out.blob });
    for (const r of rs) {
      const a = applied.get(r.id) ?? { recipe: r.id, landing: landingFor(r, w.path), paths: [] };
      a.paths.push(w.path);
      applied.set(r.id, a);
    }
    return { path: w.path, blob: out.blob };
  });
  const refusedPaths = new Set(refused.map((r) => r.path));
  const bases = base.map((f) => {
    const blob = f.blob ?? null;
    const rs = covering(f.path);
    // A written file that keeps its own version keeps its own base: the ordinary rules decide it.
    if (blob === null || rs.length === 0 || refusedPaths.has(f.path) || blob === virtual(f.path)) return f;
    const out = through(f.path, blob, rs);
    if ("refused" in out || out.blob === blob) return f;
    return out.blob === virtual(f.path) || rs.every((r) => ranOver(r, f.path)) ? { path: f.path, blob: out.blob } : f;
  });
  const reads = p.readSet.map((f) => {
    const blob = f.blob ?? null;
    const rs = covering(f.path);
    if (blob === null || rs.length === 0 || blob === virtual(f.path)) return f;
    const out = through(f.path, blob, rs);
    return !("refused" in out) && out.blob === virtual(f.path) ? { path: f.path, blob: out.blob } : f;
  });
  const renamed = Array.isArray(p.nameAssumptions)
    ? p.nameAssumptions.map((np) => {
        if (!np || typeof np.path !== "string" || !Array.isArray(np.names)) return np;
        let names = np.names;
        for (const r of list) names = recipeNames(r.recipe, names);
        return { ...np, names };
      })
    : undefined;
  const landed: Proposal = { ...p, writeSet: writes };
  const check: Proposal = { ...landed, readSet: reads, ...(renamed ? { nameAssumptions: renamed } : {}) };
  return { p: landed, check, base: bases, applied: [...applied.values()], texts, refused, rewrote };
}

/**
 * The reason a change brought through recipes goes back with, when a written file a recipe could not bring through is
 * stale: the ordinary reason, then each such file with the recipe and its landing.
 */
export function refusedText(reason: string, c: Commuted, stale: ReadonlyArray<{ path: Path }>): string {
  const stalePaths = new Set(stale.map((s) => s.path));
  const named = c.refused.filter((r) => stalePaths.has(r.path)).slice(0, 5);
  if (named.length === 0) return reason;
  const parts = named.map((r) => `recipe ${r.recipe} (landing ${r.landing}) could not rewrite ${r.path} (${r.why})`);
  return `${reason}; ${parts.join("; ")}, so it went back as stale: read ${named.length === 1 ? "that file" : "those files"} again and propose on the new trunk`;
}

/**
 * Merge locks with recipes: the files of a locked change whose landed bytes differ from what a person decided on, as a
 * held merge lists them. A file a text merge made is listed with the change's own blob as `theirs` (not the recipe's
 * rewrite of it); a file only a recipe rewrote is listed with the trunk version it lands on. Null when there is none.
 */
export function recipeLockFiles(files: readonly TextMerged[] | null, c: Commuted, base: readonly FileVersion[], virtual: (path: Path) => Sha | null): TextMerged[] | null {
  const own = new Map(c.rewrote.map((r) => [r.path, r.theirs]));
  const baseOf = new Map(base.map((f) => [f.path, f.blob ?? null]));
  const out: TextMerged[] = (files ?? []).map((f) => (own.has(f.path) ? { ...f, theirs: own.get(f.path)! } : f));
  const merged = new Set(out.map((f) => f.path));
  for (const r of c.rewrote) {
    if (merged.has(r.path)) continue;
    const b = baseOf.get(r.path) ?? null;
    const t = virtual(r.path);
    if (b === null || t === null) continue;
    out.push({ path: r.path, base: b, trunk: t, theirs: r.theirs, result: r.result });
  }
  return out.length > 0 ? out : null;
}

/** A held change's return when recipes rewrote its files: the hold's reason, then which recipes made the rewrite. */
export function recipeHold<T extends { reason: string; held: HeldMergeFile[] }>(hold: T, c: Commuted): T {
  if (c.applied.length === 0) return hold;
  const by = c.applied.map((a) => `recipe ${a.recipe} (landing ${a.landing})`).join(" and ");
  return { ...hold, reason: `${hold.reason} The rewrite of ${c.rewrote.map((r) => r.path).slice(0, 5).join(", ")} is ${by}'s, applied because this change was built before it landed.` };
}
