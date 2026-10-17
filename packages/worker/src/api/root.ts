import type { Context, Hono } from "hono";
import type { Id } from "@fire_trident/core";
import type { Env } from "../env.ts";
import { ftError } from "../colony/errors.ts";
import type { ApiEnv } from "./app.ts";

/**
 * Root route (registered by createApi; trunk/root.ts):
 *   GET /colonies/:id/root   the colony's root commit: the first commit of its trunk, first parent from the tip, kept from
 *                            the trunk writer's first read on (TrunkRoot). A read, public like every read: the colony page
 *                            and `ft status` show it, and a clone is pinned to it with `scripts/verify_note.mjs --colony`.
 */
export function rootRoutes(app: Hono<ApiEnv>): void {
  app.get("/colonies/:id/root", async (c) => {
    const id = colonyId(c);
    if (!(await c.env.COLONY.get(c.env.COLONY.idFromName(id)).getColony())) throw ftError(404, "colony not found");
    return json(await trunk(c.env, id).rootCommit());
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

function colonyId(c: Context<ApiEnv>): Id {
  const id = c.req.param("id") ?? "";
  if (!/^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/.test(id)) throw ftError(404, "colony not found");
  return id;
}

function trunk(env: Env, id: Id) {
  return env.TRUNK.get(env.TRUNK.idFromName(id));
}
