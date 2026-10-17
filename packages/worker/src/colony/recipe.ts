import { newId, parseRecipe, recipeText, scopeFootprint } from "@fire_trident/core";
import type { ColonyEvent, Id, Intent, Landing, Recipe, RecipeRecord } from "@fire_trident/core";
import { ftError } from "./errors.ts";
import type { SqlRunner } from "./inline.ts";

/**
 * Recipes at the colony (trunk/recipes.ts lands them). A person declares a recipe (POST /api/colonies/:id/recipes, `ft
 * recipe`); the colony parses it (core parseRecipe: its kind, pinned version, arguments and scope), makes it an intent
 * with `recipe` set, and hands it to the trunk writer, which lands it. No agent takes a recipe's intent: it is created
 * `proposed` (the recipe is its change) with no need marks, and it lands when the first batch of the recipe lands (that
 * landing names it). The trunk writer tells the colony of every batch and of the end (recipeNews): a recipe that changed
 * nothing, or stopped before any batch landed, withdraws its intent with the reason.
 */

/** Longest why a recipe keeps, and title. */
export const RECIPE_WHY_CHARS = 2_000;
const TITLE_CHARS = 200;

/** The intents column that keeps an intent's recipe (Recipe & { id } as JSON), added where it is missing. */
const RECIPE_COLUMN = "recipe";

/** Add the intents' recipe column where it is missing (additive; an intent without it reads as no recipe). */
export function migrateIntentRecipes(sql: SqlRunner): void {
  try {
    const cols = sql.exec("PRAGMA table_info(intents)").toArray() as Array<{ name?: unknown }>;
    if (cols.length === 0 || cols.some((c) => c.name === RECIPE_COLUMN)) return;
  } catch {
    // The store cannot list columns: ALTER decides.
  }
  try {
    sql.exec(`ALTER TABLE intents ADD COLUMN ${RECIPE_COLUMN} TEXT`);
  } catch {
    // Already there.
  }
}

/** An intent row's recipe, or undefined (absent, or not one this code reads). */
export function intentRecipe(text: unknown): (Recipe & { id: Id }) | undefined {
  if (typeof text !== "string" || text === "") return undefined;
  try {
    const r = JSON.parse(text) as Recipe & { id: Id };
    return r && typeof r.id === "string" && typeof r.kind === "string" && Array.isArray(r.scope) ? r : undefined;
  } catch {
    return undefined;
  }
}

/** What a person sends to declare a recipe. */
export interface RecipeDeclare {
  kind: string;
  version?: string;
  args?: Record<string, unknown>;
  scope: string[] | string;
  why: string;
  by?: string;
  title?: string;
}

/** The trunk writer's recipe calls the colony makes (TrunkDO). */
export interface RecipeTrunk {
  recipe(p: { id: Id; intentId: Id; recipe: Recipe; why: string; by: string }): Promise<RecipeRecord>;
}

/** What the colony's recipe door needs (ColonyDO). */
export interface RecipeColonyHost {
  sql: SqlRunner;
  colonyId: Id;
  now(): number;
  /** Module recipes (FT_RECIPE_MODULES) cover the colony. */
  modules: boolean;
  trunk(): RecipeTrunk;
  publish(events: ColonyEvent[]): void;
  bump(name: string, delta: number, now: number): void;
  /** Settle a landing the trunk writer made (ColonyDO.onLanding, idempotent per landing). */
  onLanding(l: Landing): Promise<void>;
  /** Withdraw an intent with a reason (ColonyDO.withdrawIntent). */
  withdraw(intentId: Id, reason: string, by: string): Promise<void>;
  /** An intent's status now, or null. */
  intentStatus(id: Id): string | null;
}

/**
 * Declare a recipe: parse it (a refused one is a 400 that says what to change), create its intent (`proposed`, source
 * human, its footprint the scope's fixed paths, `recipe` set), and hand it to the trunk writer, which lands batches for a
 * while before it answers. When the trunk writer refuses or fails, the intent is withdrawn and the error stands.
 */
export async function declareRecipe(host: RecipeColonyHost, input: RecipeDeclare): Promise<{ intent: Intent; recipe: RecipeRecord }> {
  const parsed = parseRecipe(input, { modules: host.modules });
  if (!parsed.ok) throw ftError(400, parsed.error);
  const why = typeof input.why === "string" ? input.why.trim().slice(0, RECIPE_WHY_CHARS) : "";
  if (why === "") throw ftError(400, "a recipe needs a why: say what the change is for, as for any intent");
  const by = (typeof input.by === "string" ? input.by.replace(/\s+/g, " ").trim().slice(0, 200) : "") || "unknown";
  const recipe = parsed.recipe;
  const title = ((typeof input.title === "string" ? input.title.replace(/\s+/g, " ").trim() : "") || `Recipe: ${recipeText(recipe)}`).slice(0, TITLE_CHARS);
  const id = newId("rcp_");
  const now = host.now();
  const footprint = scopeFootprint(recipe.scope);
  const intent: Intent = { id: newId("int_"), colonyId: host.colonyId, title, why, source: "human", footprint, priority: 1, status: "proposed", createdAt: now, createdBy: by, recipe: { ...recipe, id } };
  host.sql.exec(
    `INSERT INTO intents (id, title, why, source, rule_id, parent_id, footprint, acceptance, priority, status, created_at, created_by, assigned_to, violations, updated_at, ${RECIPE_COLUMN})
     VALUES (?, ?, ?, 'human', NULL, NULL, ?, NULL, 1, 'proposed', ?, ?, NULL, 0, ?, ?)`,
    intent.id,
    title,
    why,
    JSON.stringify(footprint),
    now,
    by,
    now,
    JSON.stringify(intent.recipe),
  );
  host.bump("intents", 1, now);
  host.publish([{ t: "intent", at: now, intentId: intent.id, status: "proposed", title, footprint }]);
  let record: RecipeRecord;
  try {
    record = await host.trunk().recipe({ id, intentId: intent.id, recipe, why, by });
  } catch (e) {
    await host.withdraw(intent.id, `the trunk writer did not take the recipe: ${e instanceof Error ? e.message : String(e)}`, "recipe").catch(() => undefined);
    throw e;
  }
  return { intent: { ...intent, status: (host.intentStatus(intent.id) ?? intent.status) as Intent["status"] }, recipe: record };
}

/**
 * What the trunk writer tells the colony of a recipe (TrunkDO.tellColony): a batch that landed is settled as any landing
 * (its intent lands with it); a recipe that ended with nothing landed, or stopped before any batch landed, withdraws
 * its intent with the reason. Idempotent.
 */
export async function recipeNews(host: RecipeColonyHost, raw: unknown): Promise<void> {
  const p = raw && typeof raw === "object" ? (raw as { record?: RecipeRecord; landing?: Landing }) : {};
  if (p.landing && typeof p.landing.id === "string") await host.onLanding(p.landing);
  const r = p.record;
  if (!r || typeof r.intentId !== "string") return;
  const status = host.intentStatus(r.intentId);
  if (status === null || status === "landed" || status === "withdrawn") return;
  const landed = Array.isArray(r.batches) && r.batches.length > 0;
  if (r.state === "landed" && !landed) await host.withdraw(r.intentId, `recipe ${r.id} ran over its scope and changed no file, so there is nothing to land`, "recipe");
  else if (r.state === "failed" && !landed) await host.withdraw(r.intentId, `recipe ${r.id} stopped: ${r.reason ?? "it could not run"}`, "recipe");
}
