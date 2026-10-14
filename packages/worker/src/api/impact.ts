import type { Context, Hono } from "hono";
import type { Id } from "@fire_trident/core";
import { ftError } from "../colony/errors.ts";
import type { ApiEnv } from "./app.ts";

/**
 * Impact route (registered by createApi; colony/impact.ts):
 *   GET /colonies/:id/impact?path=<p>[&path=<p>...][&depth=1|2|3]
 *     what a change to the paths (files, directories ending in /, or globs; at most 20) reaches: the trunk files that
 *     import them, up to `depth` levels (default 3, at most 200 files), the live claims on those files (agent, intent,
 *     claim age) and the latest landings on them with their intents' whys. A read, public like every read.
 */
export function impactRoutes(app: Hono<ApiEnv>): void {
  app.get("/colonies/:id/impact", async (c) => {
    const paths = c.req.queries("path") ?? [];
    if (paths.length === 0) throw ftError(400, "name the file to look at: ?path=src/index.ts (repeat path for a footprint, at most 20)");
    const depth = c.req.query("depth");
    // A bad path or depth is refused by the colony (400), as is a colony that does not exist (404).
    const report = await colony(c).impact(paths, depth === undefined ? {} : { depth: /^\d{1,3}$/.test(depth) ? Number(depth) : Number.NaN });
    return json(report);
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

function colony(c: Context<ApiEnv>) {
  return c.env.COLONY.get(c.env.COLONY.idFromName(colonyId(c)));
}
