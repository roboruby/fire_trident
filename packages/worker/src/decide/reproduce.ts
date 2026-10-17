import { applyRecipe, parseRecipe, recipeCovers, recipeText, sameOutputs } from "@fire_trident/core";
import type { CheckResult, NoteReproduction, Path, Recipe } from "@fire_trident/core";
import type { InnateFile } from "../colony/innate.ts";
import type { DangerHit } from "./danger.ts";
import type { DestructiveFact, DestructiveHit } from "./destructive.ts";
import { fileDiff, type FileDiff } from "./diff.ts";
import type { ReviewReproduction } from "./review.ts";
import { capabilityDelta, sensitiveReason } from "./signals.ts";

/**
 * Review by reproduction (FT_REPRODUCE). An agent or a person may propose an ordinary change (files) and declare the
 * recipe that made it (Proposal.recipe: a built-in kind, its pinned version, arguments and scope, core/recipe.ts). The
 * decide stage replays that recipe on each written file's base text, twice, the same pure transform the trunk writer
 * lands recipes with. A file whose new text equals the replay is reproduced: deterministic, like a proof, it needs no
 * model and no person (gate rule D5 when every file is). Everything else is the residual (a file outside the scope, a new
 * or deleted file, one the recipe leaves as it was, one that differs from the replay), and only the residual goes through
 * the reflex arc, as a change of its own: the models and the review card see each residual file against the replay where
 * the recipe rewrote it, so a smuggled line in a mass rename is the whole diff to read.
 *
 * What the reproduction does not waive: the danger scan, protected paths, damage and the innate checks still read the
 * whole change, and goal conflicts too, except in the files a rename reproduced (it keeps what each line means). A
 * reproduced file that carries damage of its own (a sensitive path, a write outside the footprint, a capability its new
 * text adds), a danger pattern, or a destructive fact the recipe does not explain moves to the residual with its whole
 * diff, so a model or a person sees it. A rename's removed export is the one destructive fact a recipe explains: the
 * name is exported under its new one.
 *
 * Which kinds prove a change (REPLAY_KINDS): a reproduction proves only that the files equal the recipe's output, so the
 * recipe itself must be one whose output cannot do more than its arguments name. A rename moves every binding of a name
 * together and keeps what the code does (renaming onto a capability adds a danger pattern, which the scan catches);
 * replace-import changes module specifiers alone (a relative one that lands on another module goes back on the resolution
 * check, D1, and a package swap needs its manifest change reviewed). A text-replace can rewrite any text, removing a check
 * as easily as a typo, so an agent's text-replace is not taken as proof: a person declares one as a recipe (ft recipe).
 *
 * Fail closed: an unknown kind, a kind that does not prove a change, a recipe with no version (unpinned), one pinned to
 * another version, a module recipe (it runs only in the trunk writer's sandbox), a replay whose two runs differ (not
 * deterministic), a change too large to replay, one where no file equals the replay, or one the replay removes many lines
 * from across files: nothing is replayed and the whole change has ordinary review, with the reason in its evidence.
 * Pure: no I/O, no clock.
 */

/** The recipe kinds whose reproduction proves a change (see above); a declared recipe of another kind gets ordinary review. */
export const REPLAY_KINDS: ReadonlySet<string> = new Set(["rename-identifier", "replace-import"]);

/** The metric of lines a reproduction proved in changes that landed (the spend card's mechanical share). */
export const REPRODUCED_LINES_METRIC = "decide.reproduced.lines";

/** Files and base bytes one review replays at most; a larger change has ordinary review. */
export const REPLAY_FILES = 1_000;
export const REPLAY_BYTES = 8 * 1024 * 1024;
/** Paths a note lists for each side (the counts stay exact). */
const NOTE_PATHS = 200;

/** What the gate reads of a reproduction (decide/gate.ts rule D5): the recipe, and the reproduced and residual counts. */
export interface ReproductionSignal {
  /** The recipe as kind@version: "rename-identifier@1". */
  label: string;
  reproduced: { files: number; lines: number };
  residual: { files: number; lines: number };
  /** "3,999 lines reproduced by rename-identifier@1, 1 line to review". */
  text: string;
}

/** A review by reproduction of one change. */
export interface Reproduced {
  /** For the evidence and the lineage note. */
  note: NoteReproduction;
  /** For the gate; null when nothing was replayed (ordinary review). */
  signal: ReproductionSignal | null;
  /** The files the model layers and the review card see: the residual, each against the replay where the recipe rewrote it; the whole change when nothing was replayed. */
  view: InnateFile[];
  /** Review diffs of `view` when something was replayed (the caller's whole-change diffs stand otherwise). */
  diffs: FileDiff[] | null;
  /** The destructive fact with what the recipe explains taken out (a rename's removed export). */
  destructive: DestructiveFact;
  /** The evidence check: what was reproduced and what is left to review, or why nothing was replayed. */
  check: CheckResult;
  /** One sentence for the models' facts; null when nothing was replayed. */
  fact: string | null;
  /** What the review card says of it; null when nothing was replayed. */
  review: ReviewReproduction | null;
  /**
   * The files the goal-conflict check reads (decide/goalconflict.ts): a rename keeps what every line it rewrote means, so
   * the files it reproduced undo no other intent's goal and are left out; null (the whole change) for any other kind.
   */
  goalFiles: InnateFile[] | null;
}

/** What a review by reproduction reads: the change's files (innate checks), and the whole-change facts that keep a file in the residual. */
export interface ReproduceInput {
  files: readonly InnateFile[];
  /** Written paths outside the intent's footprint (InnateResult.residual). */
  outside: readonly Path[];
  /** Danger patterns found in the whole change. */
  danger: readonly DangerHit[];
  /** The destructive fact of the whole change. */
  destructive: DestructiveFact;
  /** FT_REPRODUCE covers the colony. */
  on: boolean;
  /** Diff characters kept per residual file for review. */
  maxChars: number;
  /** The whole change's review diffs, one per file in `files` order (the counts read them; absent: computed here). */
  diffs?: readonly FileDiff[];
  /** The kinds that prove a change (default REPLAY_KINDS). */
  kinds?: ReadonlySet<string>;
}

const n = (x: number): string => x.toLocaleString("en-US");
const lines = (x: number): string => `${n(x)} ${x === 1 ? "line" : "lines"}`;
const files = (x: number): string => `${n(x)} ${x === 1 ? "file" : "files"}`;

/** A changed-line count for one diff: its added or removed lines, whichever are more (a rewritten line counts once). */
function changedLines(d: Pick<FileDiff, "added" | "removed">): number {
  return Math.max(d.added, d.removed);
}

/** Whether review by reproduction is on for some colony of the deployment (FT_REPRODUCE): MCP propose then offers `recipe`. */
export function reproduceOffered(setting: string | undefined): boolean {
  const s = typeof setting === "string" ? setting.trim() : "";
  if (s === "" || s.toLowerCase() === "off") return false;
  return s.toLowerCase() === "on" || s.split(",").some((id) => id.trim() !== "");
}

/** What MCP propose says of its `recipe` argument. */
export const RECIPE_ARGUMENT =
  "The recipe that made this change, when a deterministic transform did (a rename across many files, an import migration): " +
  "kind (rename-identifier or replace-import), version (the version it ran at, \"1\"), args (rename-identifier: from, to; " +
  "replace-import: from, to, prefix) and scope (globs). The server replays it on your base files: " +
  "files that equal its output need no other review, and only the rest of your change is reviewed. Send only what the recipe produced " +
  "plus any edit you made by hand; a recipe that is unknown, has no version, is a text-replace or does not reproduce gets ordinary review.";

/** Characters a declared recipe's argument keeps, and its scope globs. */
const ARG_CHARS = 70_000;
const SCOPE_GLOBS = 20;

/**
 * The recipe a proposal declares, as the colony keeps it (Proposal.recipe): its kind, version, string and boolean
 * arguments and scope globs, each bounded; undefined when it carries none or nothing that reads as one. It is checked
 * when the change is reviewed (replayable), not here: an unknown or unpinned recipe is kept and gets ordinary review.
 */
export function declaredRecipe(raw: unknown): Recipe | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.kind !== "string" || r.kind.trim() === "") return undefined;
  const args: Recipe["args"] = {};
  if (r.args && typeof r.args === "object" && !Array.isArray(r.args)) {
    for (const [k, v] of Object.entries(r.args as Record<string, unknown>).slice(0, 10)) {
      if (typeof v === "string") args[k.slice(0, 40)] = v.slice(0, ARG_CHARS);
      else if (typeof v === "boolean") args[k.slice(0, 40)] = v;
    }
  }
  const scope = (typeof r.scope === "string" ? [r.scope] : Array.isArray(r.scope) ? r.scope : []).filter((g): g is string => typeof g === "string").slice(0, SCOPE_GLOBS).map((g) => g.slice(0, 200));
  const version = typeof r.version === "string" || typeof r.version === "number" ? String(r.version).slice(0, 20) : "";
  return { kind: r.kind.trim().slice(0, 40) as Recipe["kind"], version, args, scope };
}

/** The recipe as kind@version. */
export function recipeLabel(r: Pick<Recipe, "kind" | "version">): string {
  return `${r.kind}@${r.version}`;
}

/** The check line: "3,999 lines reproduced by rename-identifier@1, 1 line to review", or with nothing left, "nothing else to review". */
export function reproductionText(label: string, reproduced: number, residual: { files: number; lines: number }): string {
  const rest = residual.files === 0 ? "nothing else to review" : `${lines(residual.lines)} to review${residual.lines === 0 ? ` (${files(residual.files)})` : ""}`;
  return `${lines(reproduced)} reproduced by ${label}, ${rest}`;
}

/**
 * The declared recipe a change can be replayed with, or why it cannot: a built-in kind, pinned to a version (a recipe
 * with none is unpinned: what made the change is not known for sure), parsed as the trunk writer parses recipes (its
 * version must be the one this deployment runs). `raw` is what the proposal carried.
 */
export function replayable(raw: unknown): { ok: true; recipe: Recipe } | { ok: false; reason: string; recipe: Recipe } {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const shown: Recipe = {
    kind: (typeof r.kind === "string" ? r.kind.slice(0, 40) : "") as Recipe["kind"],
    version: typeof r.version === "string" || typeof r.version === "number" ? String(r.version).slice(0, 20) : "",
    args: r.args && typeof r.args === "object" && !Array.isArray(r.args) ? (r.args as Recipe["args"]) : {},
    scope: Array.isArray(r.scope) ? r.scope.filter((g): g is string => typeof g === "string").slice(0, 20) : typeof r.scope === "string" ? [r.scope] : [],
  };
  if (shown.kind === "module") return { ok: false, recipe: shown, reason: "a module recipe is not replayed in review (it runs only in the trunk writer's sandbox), so the whole change has ordinary review" };
  if (shown.version === "") return { ok: false, recipe: shown, reason: "the recipe names no version, so what made the change is not known for sure: declare the version it ran at; the whole change has ordinary review" };
  const parsed = parseRecipe(raw, { modules: false });
  if (!parsed.ok) return { ok: false, recipe: shown, reason: `the recipe cannot be replayed (${parsed.error}), so the whole change has ordinary review` };
  return { ok: true, recipe: parsed.recipe };
}

/** Destructive hits a rename explains: for rename-identifier, an export of the old name removed from a file the recipe rewrote (it is exported under the new name). */
function explained(fact: DestructiveFact, recipe: Recipe, rewritten: ReadonlySet<Path>): DestructiveFact {
  if (recipe.kind !== "rename-identifier") return fact;
  const from = String(recipe.args.from);
  const hits: DestructiveHit[] = [];
  for (const h of fact.hits) {
    if (h.kind !== "export-removed" || !h.path || !rewritten.has(h.path) || !h.names?.includes(from)) {
      hits.push(h);
      continue;
    }
    const names = h.names.filter((x) => x !== from);
    if (names.length > 0) hits.push({ ...h, names, label: `removes the export${names.length === 1 ? "" : "s"} ${names.join(", ")} from ${h.path}` });
  }
  return { hits, unknown: fact.unknown };
}

/** Why a file that equals the replay still goes to review, or null: damage of its own, a danger pattern, or a destructive fact the recipe does not explain. */
function ownDamage(f: InnateFile, d: FileDiff, x: ReproduceInput, fact: DestructiveFact): string | null {
  const sensitive = sensitiveReason(f.path);
  if (sensitive) return `it equals the recipe's output but is on a sensitive path (${sensitive})`;
  if (x.outside.includes(f.path)) return "it equals the recipe's output but is outside the intent's footprint";
  const caps = capabilityDelta(f.path, f.before, f.after, d.addedLines);
  if (caps.length > 0) return `it equals the recipe's output but its new text ${caps.map((c) => c.label).join(", ")}`;
  if (x.danger.some((h) => h.path === f.path)) return "it equals the recipe's output but carries a danger pattern";
  const hit = fact.hits.find((h) => h.path === f.path || h.to === f.path);
  if (hit) return `it equals the recipe's output but ${hit.label.replace(/^removes/, "it removes")}`;
  return null;
}

/** The whole change's diff of the file at `i` (the caller's when it gave them). */
function wholeDiff(x: ReproduceInput, i: number): FileDiff {
  const f = x.files[i]!;
  const given = x.diffs?.[i];
  return given && given.path === f.path ? given : fileDiff(f.path, f.before, f.after, { binary: f.binary, unreadable: f.unreadable, maxChars: x.maxChars });
}

/** The result when nothing is replayed: the whole change has ordinary review, and the evidence says why. */
function notReplayed(recipe: Recipe, reason: string, x: ReproduceInput): Reproduced {
  const text = `not replayed: ${reason}`;
  const all = x.files.map((_, i) => changedLines(wholeDiff(x, i))).reduce((a, k) => a + k, 0);
  return {
    note: { recipe, applied: false, reason, reproduced: { files: 0, lines: 0, paths: [] }, residual: { files: x.files.length, lines: all, paths: [] }, text },
    signal: null,
    view: [...x.files],
    diffs: null,
    destructive: x.destructive,
    check: { name: "deterministic: reproduction", ok: false, ms: 0, detail: text.slice(0, 1_000) },
    fact: null,
    review: null,
    goalFiles: null,
  };
}

/**
 * Review one change by reproduction. Null when it declared no recipe. Otherwise the replay's verdict per file: reproduced
 * (its new text equals the recipe's output on its base) or residual (with why), the view the model layers and the review
 * card get, and the destructive fact with the recipe's own removals explained. See the module comment for what fails closed.
 */
export function reproduceChange(declared: unknown, x: ReproduceInput): Reproduced | null {
  if (declared === undefined || declared === null) return null;
  const parsed = replayable(declared);
  if (!parsed.ok) return notReplayed(parsed.recipe, parsed.reason, x);
  const recipe = parsed.recipe;
  if (!(x.kinds ?? REPLAY_KINDS).has(recipe.kind)) {
    return notReplayed(recipe, `a ${recipe.kind} recipe can change what code does, so reproducing it would prove only that the change is that replacement: the whole change has ordinary review (a person can declare it as a recipe instead)`, x);
  }
  if (!x.on) return notReplayed(recipe, "review by reproduction is off for this colony (FT_REPRODUCE), so the whole change has ordinary review", x);
  const inScope = x.files.filter((f) => recipeCovers(recipe, f.path));
  const bytes = inScope.reduce((a, f) => a + (f.before?.length ?? 0), 0);
  if (inScope.length > REPLAY_FILES || bytes > REPLAY_BYTES) {
    return notReplayed(recipe, `the change is too large to replay in review (${files(inScope.length)} and ${n(Math.ceil(bytes / 1024))} KB in scope; at most ${n(REPLAY_FILES)} files and ${n(REPLAY_BYTES / 1024 / 1024)} MB), so the whole change has ordinary review`, x);
  }

  // Replay: each written file's base text through the recipe, twice; a file the two runs disagree on stops the replay.
  const replays = new Map<Path, string | null>();
  const refusals = new Map<Path, string>();
  for (const f of x.files) {
    if (!recipeCovers(recipe, f.path) || f.beforeBlob === null || f.afterBlob === null || f.before === null || f.after === null || f.binary || f.unreadable) continue;
    const first = applyRecipe(recipe, f.path, f.before);
    const second = applyRecipe(recipe, f.path, f.before);
    if (!sameOutputs([first], [second])) return notReplayed(recipe, `the recipe did not give the same output twice on ${f.path}, so it is not deterministic and the whole change has ordinary review`, x);
    if (first.ok) replays.set(f.path, first.text);
    else refusals.set(f.path, `${first.reason}${first.detail ? `: ${first.detail}` : ""}`);
  }
  const bases = new Map(x.files.map((f) => [f.path, f.before]));
  const rewritten = new Set([...replays].filter(([path, text]) => text !== bases.get(path)).map(([path]) => path));
  const destructive = explained(x.destructive, recipe, rewritten);

  const reproduced: Array<{ path: Path; lines: number }> = [];
  const damaged: string[] = [];
  const residual: Array<{ path: Path; why: string; lines: number }> = [];
  const view: InnateFile[] = [];
  const diffs: FileDiff[] = [];
  const toReview = (f: InnateFile, against: string | null, why: string): void => {
    const shown: InnateFile = { ...f, before: against };
    const d = fileDiff(f.path, shown.before, shown.after, { binary: f.binary, unreadable: f.unreadable, maxChars: x.maxChars });
    view.push(shown);
    diffs.push(d);
    residual.push({ path: f.path, why, lines: changedLines(d) });
  };
  for (const [i, f] of x.files.entries()) {
    if (!recipeCovers(recipe, f.path)) {
      toReview(f, f.before, "outside the recipe's scope");
      continue;
    }
    if (f.afterBlob === null) {
      toReview(f, f.before, "deleted (a recipe never deletes a file)");
      continue;
    }
    if (f.beforeBlob === null) {
      toReview(f, f.before, "a new file (a recipe only rewrites files that exist)");
      continue;
    }
    if (f.before === null || f.after === null || f.binary || f.unreadable) {
      toReview(f, f.before, "not readable as text, so the recipe cannot be replayed on it");
      continue;
    }
    const refused = refusals.get(f.path);
    if (refused !== undefined) {
      toReview(f, f.before, `the recipe leaves it as it was (${refused})`);
      continue;
    }
    const replay = replays.get(f.path)!;
    if (replay === f.before) {
      toReview(f, f.before, "the recipe changes nothing in it");
      continue;
    }
    if (replay !== f.after) {
      toReview(f, replay, "it differs from the recipe's output (shown against the replay)");
      continue;
    }
    const whole = wholeDiff(x, i);
    const own = ownDamage(f, whole, x, destructive);
    if (own) {
      damaged.push(`${f.path}: ${own}`);
      toReview(f, f.before, own);
      continue;
    }
    reproduced.push({ path: f.path, lines: changedLines(whole) });
  }
  if (reproduced.length === 0) {
    const why = damaged.length > 0 ? `every file that equals the recipe's output needs review of its own (${damaged.slice(0, 3).join("; ")})` : "no file of the change equals the recipe's output on its base";
    return notReplayed(recipe, `${why}, so the whole change has ordinary review`, x);
  }

  // A destructive fact of the change as a whole (lines removed across files) belongs to no residual file, so no model would
  // see what it is about: the whole change has ordinary review.
  const across = destructive.hits.find((h) => !h.path);
  if (across) return notReplayed(recipe, `the change ${across.label}, a destructive fact no single file shows, so the whole change has ordinary review`, x);
  const label = recipeLabel(recipe);
  const proven = new Set(reproduced.map((r) => r.path));
  const counts = {
    reproduced: { files: reproduced.length, lines: reproduced.reduce((a, r) => a + r.lines, 0) },
    residual: { files: residual.length, lines: residual.reduce((a, r) => a + r.lines, 0) },
  };
  const text = reproductionText(label, counts.reproduced.lines, counts.residual);
  const note: NoteReproduction = {
    recipe,
    applied: true,
    reproduced: { ...counts.reproduced, paths: reproduced.slice(0, NOTE_PATHS).map((r) => r.path) },
    residual: { ...counts.residual, paths: residual.slice(0, NOTE_PATHS).map((r) => ({ path: r.path, why: r.why })) },
    text,
  };
  const left = residual.slice(0, 5).map((r) => `${r.path}: ${r.why}`);
  const detail = `${text} (${files(counts.reproduced.files)} reproduced${residual.length > 0 ? `; residual ${left.join("; ")}${residual.length > 5 ? ` and ${residual.length - 5} more` : ""}` : ""})`;
  return {
    note,
    signal: { label, ...counts, text },
    view,
    diffs,
    destructive,
    check: { name: "deterministic: reproduction", ok: true, ms: 0, detail: detail.slice(0, 1_000) },
    fact:
      `Review by reproduction: ${files(counts.reproduced.files)} (${lines(counts.reproduced.lines)}) of this change equal the declared recipe ${label} (${recipeText(recipe)}) replayed on their base, so they are proven and not shown. ` +
      "Judge only what is shown: each file the recipe rewrote is diffed against the recipe's output, so its diff is what differs from the replay.",
    review: { recipe: label, ...counts, text },
    goalFiles: recipe.kind === "rename-identifier" ? x.files.filter((f) => !proven.has(f.path)) : null,
  };
}
