import type { Context, Hono, MiddlewareHandler } from "hono";
import type { Id } from "@fire_trident/core";
import { z } from "zod";
import { ftError } from "../colony/errors.ts";
import { RECIPE_WHY_CHARS } from "../colony/recipe.ts";
import { maskStrings } from "../trunk/mask.ts";
import type { ApiEnv } from "./app.ts";

/** POST /api/colonies/:id/recipes: a person declares a recipe (core parseRecipe reads kind, version, args and scope). */
export const RecipeBody = z.object({
  kind: z.enum(["rename-identifier", "replace-import", "text-replace", "module"]),
  version: z.string().trim().min(1).max(20).optional(),
  args: z.record(z.string(), z.union([z.string().max(70_000), z.boolean()])).default({}),
  scope: z.union([z.string().trim().min(1).max(200), z.array(z.string().trim().min(1).max(200)).min(1).max(20)]),
  why: z.string().trim().min(1).max(RECIPE_WHY_CHARS),
  by: z.string().trim().min(1).max(200).optional(),
  title: z.string().trim().min(1).max(200).optional(),
});

/** POST /api/colonies/:id/recipes/:rid/approve. */
export const RecipeApproveBody = z.object({ by: z.string().trim().min(1).max(200).optional() });

/**
 * Recipe routes (registered by createApi; colony/recipe.ts, trunk/recipes.ts). A recipe does nothing until a person
 * declares one, so there is no flag; the `module` kind needs FT_RECIPE_MODULES.
 *   GET  /colonies/:id/recipes                the colony's recipes, newest first (?limit=)
 *   GET  /colonies/:id/recipes/:rid           one recipe; with the admin token, also what it would still change on trunk
 *                                             (its residue: reading the scope's files costs the trunk writer reads)
 *   POST /colonies/:id/recipes                { kind, version?, args, scope, why, by?, title? }: declare a recipe; its
 *                                             intent and the recipe as the trunk writer left it after landing batches for
 *                                             up to 20 s (201; the alarm lands the rest)
 *   POST /colonies/:id/recipes/:rid/approve   { by? }: a person approves a held recipe's output; it goes on landing
 * POST needs the admin token. Reads mask secret-looking text in what a person typed.
 */
export function recipeRoutes(app: Hono<ApiEnv>, admin: MiddlewareHandler<ApiEnv>, isAdmin: (c: Context<ApiEnv>) => Promise<boolean>): void {
  app.get("/colonies/:id/recipes", async (c) => {
    const raw = c.req.query("limit");
    if (raw !== undefined && !/^\d{1,3}$/.test(raw)) throw ftError(400, "limit must be a whole number up to 999");
    await requireColony(c);
    return json(maskStrings(await trunk(c).recipes(raw === undefined ? undefined : Number(raw))));
  });

  app.get("/colonies/:id/recipes/:rid", async (c) => {
    await requireColony(c);
    if (!(await isAdmin(c))) {
      const record = (await trunk(c).recipes(200)).find((r) => r.id === recipeId(c));
      if (!record) throw ftError(404, `no recipe ${recipeId(c)} in this colony`);
      return json(maskStrings({ record, residue: null, note: "send the admin token to read what the recipe would still change on trunk" }));
    }
    const res = await trunk(c).recipeResidue(recipeId(c));
    if (!res) throw ftError(404, `no recipe ${recipeId(c)} in this colony`);
    return json(maskStrings(res));
  });

  app.post("/colonies/:id/recipes", admin, async (c) => {
    const b = await body(c, RecipeBody);
    await requireColony(c);
    const res = await colony(c).declareRecipe({ ...b, scope: b.scope, by: b.by ?? "api" });
    return json(res, 201);
  });

  app.post("/colonies/:id/recipes/:rid/approve", admin, async (c) => {
    const b = await body(c, RecipeApproveBody, true);
    await requireColony(c);
    const res = await trunk(c).recipeApprove(recipeId(c), b.by ?? "api");
    if (!res) throw ftError(404, `no recipe ${recipeId(c)} in this colony`);
    return json(res);
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

async function body<S extends z.ZodType>(c: Context<ApiEnv>, schema: S, optional = false): Promise<z.output<S>> {
  const text = await c.req.text();
  let raw: unknown = {};
  if (!optional || text.trim() !== "") {
    try {
      raw = JSON.parse(text);
    } catch {
      throw ftError(400, "body must be JSON");
    }
  }
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.map(String).join(".") || "body"}: ${i.message}`);
  throw ftError(400, `invalid request: ${issues.join("; ")}`);
}

function colonyId(c: Context<ApiEnv>): Id {
  const id = c.req.param("id") ?? "";
  if (!/^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/.test(id)) throw ftError(404, "colony not found");
  return id;
}

function recipeId(c: Context<ApiEnv>): Id {
  const id = c.req.param("rid") ?? "";
  if (!/^rcp_[\w-]{1,64}$/.test(id)) throw ftError(404, "no such recipe (recipe ids start with rcp_)");
  return id;
}

function colony(c: Context<ApiEnv>) {
  return c.env.COLONY.get(c.env.COLONY.idFromName(colonyId(c)));
}

function trunk(c: Context<ApiEnv>) {
  return c.env.TRUNK.get(c.env.TRUNK.idFromName(colonyId(c)));
}

async function requireColony(c: Context<ApiEnv>): Promise<void> {
  if (!(await colony(c).getColony())) throw ftError(404, "colony not found");
}
