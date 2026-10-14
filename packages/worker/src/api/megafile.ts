import type { Context, Hono, MiddlewareHandler } from "hono";
import type { Id } from "@fire_trident/core";
import { z } from "zod";
import { ftError } from "../colony/errors.ts";
import type { ApiEnv } from "./app.ts";

/** POST /api/colonies/:id/megafile: a person holds one file for its split, or releases it. */
export const MegafileBody = z.object({
  path: z.string().trim().min(1).max(1024),
  action: z.enum(["hold", "release"]),
  by: z.string().trim().min(1).max(200).optional(),
});

/**
 * Megafile alarm routes (registered by createApi; colony/megafile.ts, FT_MEGAFILE):
 *   GET  /colonies/:id/megafile   the files held for their split now and the holds lifted lately, with `on`
 *   POST /colonies/:id/megafile   { path, action: "hold" | "release", by? }: a person holds a file (its split intent is
 *                                 declared unless one is live; 201, or 200 when it was already held) or releases it
 *                                 (200; 404 when it is not held); 409 while the alarm is off for the colony
 * POST needs the admin token.
 */
export function megafileRoutes(app: Hono<ApiEnv>, admin: MiddlewareHandler<ApiEnv>): void {
  app.get("/colonies/:id/megafile", async (c) => {
    const id = colonyId(c);
    const stub = colony(c);
    if (!(await stub.getColony())) throw ftError(404, "colony not found");
    const report = await stub.megafileReport();
    return json({ colonyId: id, on: report !== null, ...(report ?? { at: Date.now(), held: [], lifted: [] }) });
  });

  app.post("/colonies/:id/megafile", admin, async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw ftError(400, "body must be JSON");
    }
    const parsed = MegafileBody.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.map(String).join(".") || "body"}: ${i.message}`);
      throw ftError(400, `invalid request: ${issues.join("; ")}`);
    }
    const b = parsed.data;
    const res = await colony(c).megafile({ path: b.path, action: b.action, by: b.by ?? "api" });
    return json(res, "hold" in res && !res.already ? 201 : 200);
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
