import { checkFile, parseRecipe, recipeCovers, recipeText } from "@fire_trident/core";
import type { ColonyEvent, Id, Landing, MechanicalShare, Path, Recipe, RecipeRecord, Rule, Violation } from "@fire_trident/core";
import { REPRODUCED_LINES_METRIC } from "../decide/reproduce.ts";
import { ftError } from "./errors.ts";
import type { SqlRunner } from "./inline.ts";
import { normalizePath, violationIntents, type ViolationIntentDraft } from "./logic.ts";
import { declareRecipe, type RecipeColonyHost } from "./recipe.ts";

/**
 * Target items that carry recipes. A rule (POST /api/colonies/:id/rules with `recipe`, `ft rule ... --recipe`) may name
 * a recipe that fixes its violations mechanically: "no identifier `compose` in src" with `rename-identifier compose to
 * assemble`. When such a rule is added, the colony declares one agent intent per violating file only outside the
 * recipe's scope; the violations inside it wait for the recipe, which the colony lands directly (a recipe landing,
 * colony/recipe.ts and trunk/recipes.ts, declared by the rule's approver, its intent the rule's, so it answers to them).
 *
 * As each batch of the recipe lands, the colony reads the files it rewrote that were waiting and counts their violations
 * again: the rule's open violations, and with them the first screen's distance to target, fall batch by batch. When the
 * recipe ends (all landed, or stopped), the files it could not transform and the ones that still violate the rule after
 * it are the residue, and only they become agent intents, one per file, as any rule's violations do. Every recipe batch
 * also counts in the colony's mechanical share (`recipes.*` metrics), which the spend card shows at $0 of model calls.
 *
 * A rule whose recipe the trunk writer does not take (or with no violation in the recipe's scope) declares its intents
 * as a rule without one would. Its tables are additive: rule_recipes (one row per rule with a recipe), rule_recipe_files
 * (the violating files waiting for it, with their violation lines) and recipe_batches_seen (the batches counted once).
 */

/** The tables (additive, created on first use). */
export const RULE_RECIPE_TABLES = [
  `CREATE TABLE IF NOT EXISTS rule_recipes (rule_id TEXT PRIMARY KEY, recipe_id TEXT NOT NULL, intent_id TEXT NOT NULL, state TEXT NOT NULL,
    fixed INTEGER NOT NULL DEFAULT 0, residue INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  "CREATE INDEX IF NOT EXISTS rule_recipes_by_recipe ON rule_recipes(recipe_id)",
  "CREATE TABLE IF NOT EXISTS rule_recipe_files (rule_id TEXT NOT NULL, path TEXT NOT NULL, lines TEXT NOT NULL, PRIMARY KEY (rule_id, path))",
  "CREATE TABLE IF NOT EXISTS recipe_batches_seen (landing_id TEXT PRIMARY KEY, recipe_id TEXT NOT NULL, files INTEGER NOT NULL, at INTEGER NOT NULL)",
];

/** Metrics of the mechanical share (the spend card): recipe batches landed, files they rewrote, rule violations they fixed. */
export const MECHANICAL_METRICS = { landings: "recipes.landings", files: "recipes.files", violations: "recipes.violationsFixed", reproduced: REPRODUCED_LINES_METRIC } as const;

/** Create the tables. */
export function migrateRuleRecipes(sql: SqlRunner): void {
  for (const stmt of RULE_RECIPE_TABLES) sql.exec(stmt);
}

/** What the colony gives a rule's recipe (ColonyDO). */
export interface RuleRecipeHost {
  sql: SqlRunner;
  now(): number;
  /** The colony's recipe door, to declare the recipe (colony/recipe.ts). */
  recipes(): RecipeColonyHost;
  /** A rule by id, retracted ones included; null when unknown. */
  rule(id: Id): Rule | null;
  /** A trunk file's text now, or null when it is gone or not text (TrunkDO.readFile). */
  readFile(path: Path): Promise<string | null>;
  /** Declare one agent intent per draft for the rule (ColonyDO.createIntents, source rule); answers how many. */
  declareIntents(rule: Rule, drafts: ViolationIntentDraft[]): Promise<number>;
  publish(events: ColonyEvent[]): void;
  /** The violations event for the current totals (ColonyDO.violationsEvent). */
  violationsEvent(now: number): ColonyEvent;
  bump(name: string, delta: number, now: number): void;
}

/** What a rule's recipe did when the rule was added (the answer to POST /rules carries it). */
export interface RuleRecipeStart {
  /** The recipe's id and its intent, when the trunk writer took it. */
  id?: Id;
  intentId?: Id;
  recipe: Recipe;
  /** Violating files, and violations, left to the recipe. */
  files: number;
  violations: number;
  /** Where the recipe stands after the declaring call (it lands the rest on the trunk writer's alarm). */
  state?: string;
  /** Why the colony declared intents for every violation instead (no violation in scope, or the trunk writer refused it). */
  skipped?: string;
  /** Intents declared for the waiting violations when the trunk writer did not take the recipe. */
  intents?: number;
}

/** A rule's recipe as a person declares it: a kind, its arguments, and optionally a version and a scope. */
export type RuleRecipeInput = { kind?: unknown; version?: unknown; args?: unknown; scope?: unknown };

/** The scope a rule's recipe takes when it names none: the globs the rule applies to (include, or from), else every file. */
export function ruleScope(rule: Pick<Rule, "kind" | "spec">): string[] {
  const raw = rule.kind === "forbid-import" ? rule.spec.from : rule.spec.include;
  const list = (typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : []).filter((g): g is string => typeof g === "string" && g.trim() !== "");
  return list.length > 0 ? list.slice(0, 20) : ["**"];
}

/**
 * The recipe a rule names, parsed and pinned (core parseRecipe), or null when it names none. A recipe it cannot run is a
 * 400 that says what to change, before anything is stored. `modules`: FT_RECIPE_MODULES covers the colony.
 */
export function ruleRecipe(raw: unknown, rule: Pick<Rule, "kind" | "spec">, modules: boolean): Recipe | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) throw ftError(400, "a rule's recipe is an object with kind and args (and optionally version and scope)");
  const r = raw as RuleRecipeInput;
  const parsed = parseRecipe({ ...r, scope: r.scope === undefined ? ruleScope(rule) : r.scope }, { modules });
  if (!parsed.ok) throw ftError(400, `the rule's recipe is refused: ${parsed.error}`);
  return parsed.recipe;
}

/** A rule's violations split by the recipe: the ones it covers wait for it (by file, with their lines), the others become intents now. */
export function splitViolations(recipe: Recipe | null, violations: readonly Violation[]): { now: Violation[]; later: Map<Path, number[]> } {
  const now: Violation[] = [];
  const later = new Map<Path, number[]>();
  for (const v of violations) {
    const path = normalizePath(v.path);
    if (recipe && path !== "" && recipeCovers(recipe, path)) {
      const lines = later.get(path);
      if (lines) lines.push(v.line);
      else later.set(path, [v.line]);
    } else now.push(v);
  }
  return { now, later };
}

/** Violations waiting for a recipe, counted. */
function count(later: ReadonlyMap<Path, number[]>): number {
  let n = 0;
  for (const lines of later.values()) n += lines.length;
  return n;
}

/**
 * Land a rule's recipe: declare it (its intent the rule's, by the rule's approver), with the violating files in its scope
 * recorded as waiting before the trunk writer is asked, so the batches it lands while it is asked count. When nothing in
 * its scope violates the rule, or the trunk writer does not take it, the waiting violations become intents now, as a
 * rule without a recipe declares them. Answers what the recipe took on.
 */
export async function startRuleRecipe(host: RuleRecipeHost, rule: Rule, recipe: Recipe, later: ReadonlyMap<Path, number[]>): Promise<RuleRecipeStart> {
  migrateRuleRecipes(host.sql);
  const violations = count(later);
  if (later.size === 0) return { recipe, files: 0, violations: 0, skipped: "no file the rule finds lies in the recipe's scope, so the recipe was not run" };
  const head = rule.description.replace(/\s+/g, " ").trim();
  try {
    const res = await declareRecipe(
      host.recipes(),
      {
        kind: recipe.kind,
        version: recipe.version,
        args: recipe.args,
        scope: recipe.scope,
        why: `${head.endsWith(".") ? head : `${head}.`}\nThe rule's recipe (${recipeText(recipe)}) fixes its violations mechanically; the files it cannot fix get an intent each once it has landed.`,
        by: rule.approvedBy,
        title: `Rule recipe: ${recipeText(recipe)}`,
      },
      {
        ruleId: rule.id,
        declared: (intentId, recipeId) => {
          const now = host.now();
          host.sql.exec("INSERT OR REPLACE INTO rule_recipes (rule_id, recipe_id, intent_id, state, fixed, residue, created_at, updated_at) VALUES (?, ?, ?, 'running', 0, 0, ?, ?)", rule.id, recipeId, intentId, now, now);
          for (const [path, lines] of later) host.sql.exec("INSERT OR REPLACE INTO rule_recipe_files (rule_id, path, lines) VALUES (?, ?, ?)", rule.id, path, JSON.stringify(lines));
        },
      },
    );
    return { id: res.recipe.id, intentId: res.intent.id, recipe, files: later.size, violations, state: res.recipe.state };
  } catch (e) {
    // The trunk writer did not take it (its intent is withdrawn): every waiting violation becomes an intent now.
    const reason = e instanceof Error ? e.message : String(e);
    host.sql.exec("DELETE FROM rule_recipe_files WHERE rule_id = ?", rule.id);
    host.sql.exec("DELETE FROM rule_recipes WHERE rule_id = ?", rule.id);
    const drafts = violationIntents(rule, toViolations(rule.id, later));
    const intents = await host.declareIntents(rule, drafts);
    return { recipe, files: later.size, violations, intents, skipped: `the trunk writer did not take the recipe (${reason}), so every violation got an intent` };
  }
}

/** Waiting files as the violations violationIntents reads (the path and line of each). */
function toViolations(ruleId: Id, files: Iterable<[Path, number[]]>): Violation[] {
  const out: Violation[] = [];
  for (const [path, lines] of files) for (const line of lines) out.push({ ruleId, path, line, excerpt: "", message: "" });
  return out;
}

function parseLines(text: unknown): number[] {
  try {
    const v = JSON.parse(String(text)) as unknown;
    return Array.isArray(v) ? v.filter((x): x is number => typeof x === "number" && Number.isFinite(x)) : [];
  } catch {
    return [];
  }
}

const ENDED: ReadonlySet<string> = new Set(["landed", "failed"]);
/** Waiting files read again when a recipe ends; past these, the counts from the last read stand. */
const END_READS = 2_000;

/**
 * What the trunk writer told the colony of a recipe (colony/recipe.ts recipeNews calls this): a batch that landed counts
 * once in the mechanical share; for a rule's recipe, the waiting files it rewrote are read and counted again (the rule's
 * open violations fall by what it fixed), and once the recipe ended, the files still waiting with violations become one
 * agent intent each (the residue). Idempotent: a batch counts once, a file's count is set (not subtracted twice), and
 * the residue is declared once.
 */
export async function ruleRecipeNews(host: RuleRecipeHost, record: RecipeRecord, landing?: Landing): Promise<void> {
  migrateRuleRecipes(host.sql);
  const now = host.now();
  if (landing && typeof landing.id === "string") {
    const files = Array.isArray(landing.paths) ? landing.paths.length : 0;
    const seen = host.sql.exec("SELECT 1 AS x FROM recipe_batches_seen WHERE landing_id = ?", landing.id).toArray().length > 0;
    if (!seen) {
      host.sql.exec("INSERT INTO recipe_batches_seen (landing_id, recipe_id, files, at) VALUES (?, ?, ?, ?)", landing.id, record.id, files, now);
      host.bump(MECHANICAL_METRICS.landings, 1, now);
      host.bump(MECHANICAL_METRICS.files, files, now);
    }
  }
  const link = host.sql.exec("SELECT rule_id, state FROM rule_recipes WHERE recipe_id = ?", record.id).toArray()[0] as { rule_id: string; state: string } | undefined;
  if (!link) return;
  const rule = host.rule(link.rule_id);
  if (!rule) return;
  const retracted = rule.retractedAt !== undefined;
  if (landing && Array.isArray(landing.paths) && !retracted) await recount(host, rule, landing.paths);
  if (!ENDED.has(record.state)) return;

  // The recipe ended. Claimed in one synchronous step, so a second telling of the end finds it taken.
  const fresh = host.sql.exec("SELECT state FROM rule_recipes WHERE rule_id = ?", rule.id).toArray()[0] as { state: string } | undefined;
  if (fresh?.state !== "running") return;
  host.sql.exec("UPDATE rule_recipes SET state = 'ending', updated_at = ? WHERE rule_id = ?", now, rule.id);
  // Every file still waiting is read once more (up to END_READS), so one that changed meanwhile counts as it stands.
  if (!retracted) {
    const waiting = (host.sql.exec("SELECT path FROM rule_recipe_files WHERE rule_id = ? ORDER BY path", rule.id).toArray() as Array<{ path: string }>).map((r) => r.path);
    await recount(host, rule, waiting.slice(0, END_READS));
  }
  // The files still waiting with violations are its residue, an agent intent each (none for a retracted rule).
  const rows = host.sql.exec("SELECT path, lines FROM rule_recipe_files WHERE rule_id = ?", rule.id).toArray() as Array<{ path: string; lines: string }>;
  const residue: Array<[Path, number[]]> = rows.map((r) => [r.path, parseLines(r.lines)] as [Path, number[]]).filter(([, lines]) => lines.length > 0);
  host.sql.exec("UPDATE rule_recipes SET state = 'done', residue = ?, updated_at = ? WHERE rule_id = ?", residue.length, now, rule.id);
  host.sql.exec("DELETE FROM rule_recipe_files WHERE rule_id = ?", rule.id);
  if (retracted || residue.length === 0) return;
  await host.declareIntents(rule, violationIntents(rule, toViolations(rule.id, residue)));
}

/**
 * Count the waiting files a batch rewrote again: each is read from trunk and checked against the rule. The rule's open
 * violations move by the difference (fewer when the recipe fixed them), the file stops waiting when it has none, and the
 * colony's violations event goes out, so the distance to target falls as the batch lands.
 */
async function recount(host: RuleRecipeHost, rule: Rule, paths: readonly Path[]): Promise<void> {
  const waiting = new Set(
    (host.sql.exec("SELECT path FROM rule_recipe_files WHERE rule_id = ?", rule.id).toArray() as Array<{ path: string }>).map((r) => r.path),
  );
  const touched = [...new Set(paths.map(normalizePath))].filter((p) => waiting.has(p));
  if (touched.length === 0) return;
  const fresh = new Map<Path, number[]>();
  for (const path of touched) {
    let text: string | null;
    try {
      text = await host.readFile(path);
    } catch {
      continue; // Not read now: the file keeps its count and waits (the residue counts it if the recipe ends first).
    }
    fresh.set(path, text === null ? [] : checkFile(rule, path, text).map((v) => v.line));
  }
  // Written in one synchronous step after the reads, against each file's count as it stands now.
  const now = host.now();
  let fixed = 0;
  for (const [path, lines] of fresh) {
    const row = host.sql.exec("SELECT lines FROM rule_recipe_files WHERE rule_id = ? AND path = ?", rule.id, path).toArray()[0] as { lines: string } | undefined;
    if (!row) continue;
    fixed += parseLines(row.lines).length - lines.length;
    if (lines.length === 0) host.sql.exec("DELETE FROM rule_recipe_files WHERE rule_id = ? AND path = ?", rule.id, path);
    else host.sql.exec("UPDATE rule_recipe_files SET lines = ? WHERE rule_id = ? AND path = ?", JSON.stringify(lines), rule.id, path);
  }
  if (fixed === 0) return;
  host.sql.exec("UPDATE rules SET open_violations = MAX(0, open_violations - ?) WHERE id = ?", fixed, rule.id);
  host.sql.exec("UPDATE rule_recipes SET fixed = fixed + ?, updated_at = ? WHERE rule_id = ?", fixed, now, rule.id);
  if (fixed > 0) host.bump(MECHANICAL_METRICS.violations, fixed, now);
  host.publish([host.violationsEvent(now)]);
}

/** A rule's recipe as it stands (for the rule's readers): its id, intent, state, violations fixed, files waiting and residue intents. Null when the rule has none. */
export function ruleRecipeState(sql: SqlRunner, ruleId: Id): { recipeId: Id; intentId: Id; state: string; fixed: number; waiting: number; residue: number } | null {
  migrateRuleRecipes(sql);
  const row = sql.exec("SELECT recipe_id, intent_id, state, fixed, residue FROM rule_recipes WHERE rule_id = ?", ruleId).toArray()[0] as
    | { recipe_id: string; intent_id: string; state: string; fixed: number; residue: number }
    | undefined;
  if (!row) return null;
  const waiting = (sql.exec("SELECT COUNT(*) AS n FROM rule_recipe_files WHERE rule_id = ?", ruleId).toArray()[0] as { n: number } | undefined)?.n ?? 0;
  return { recipeId: row.recipe_id, intentId: row.intent_id, state: row.state === "done" ? "done" : "running", fixed: row.fixed, waiting, residue: row.residue };
}

/** The mechanical share from the colony's metrics (the spend card), or null when nothing landed with no model call. */
export function mechanicalShare(metrics: Readonly<Record<string, number>>): MechanicalShare | null {
  const num = (k: string): number => {
    const v = metrics[k];
    return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
  };
  const share: MechanicalShare = { landings: num(MECHANICAL_METRICS.landings), files: num(MECHANICAL_METRICS.files), violations: num(MECHANICAL_METRICS.violations), reproducedLines: num(MECHANICAL_METRICS.reproduced) };
  return share.landings + share.files + share.violations + share.reproducedLines > 0 ? share : null;
}
