import type { Context, Hono, MiddlewareHandler } from "hono";
import type { Id } from "@fire_trident/core";
import { z } from "zod";
import { ftError } from "../colony/errors.ts";
import type { ApiEnv } from "./app.ts";

/**
 * Field guide routes (FT_FIELD_GUIDE; registered by createApi):
 *   GET  /colonies/:id/guide              the active lessons with their provenance (public); with the admin token, the
 *                                         candidates and the lessons dropped or retired lately too
 *   POST /colonies/:id/guide/:lessonId    { action: "approve" | "reject", by?, reason? }: a person's decision (admin)
 */
export function guideRoutes(app: Hono<ApiEnv>, admin: MiddlewareHandler<ApiEnv>, isAdmin: (c: Context<ApiEnv>) => Promise<boolean>): void {
  app.get("/colonies/:id/guide", async (c) => json(await colony(c).fieldGuide({ admin: await isAdmin(c) })));

  app.post("/colonies/:id/guide/:lessonId", admin, async (c) => {
    let raw: unknown;
    try {
      raw = JSON.parse((await c.req.text()) || "{}");
    } catch {
      throw ftError(400, "body must be JSON");
    }
    const parsed = GuideDecisionBody.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.map(String).join(".") || "body"}: ${i.message}`);
      throw ftError(400, `invalid request: ${issues.join("; ")}. Send { "action": "approve" } or { "action": "reject", "reason": "..." }`);
    }
    const b = parsed.data;
    return json(await colony(c).decideLesson(c.req.param("lessonId"), { action: b.action, by: b.by ?? "api", ...(b.reason ? { reason: b.reason } : {}) }));
  });
}

/** POST /api/colonies/:id/guide/:lessonId */
export const GuideDecisionBody = z.object({
  action: z.enum(["approve", "reject"]),
  by: z.string().trim().min(1).max(200).optional(),
  reason: z.string().max(500).optional(),
});

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
