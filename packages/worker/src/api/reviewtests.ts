import type { Context, Hono, MiddlewareHandler } from "hono";
import type { Id } from "@fire_trident/core";
import { z } from "zod";
import { ftError } from "../colony/errors.ts";
import type { ApiEnv } from "./app.ts";

/** POST /api/colonies/:id/proposals/:pid/tests: who asks for the run (recorded with it). The body may be empty. */
export const RetestBody = z.object({
  by: z.string().trim().min(1).max(200).optional(),
});

/**
 * Tests before approval routes (registered by createApi; certify/reviewtests.ts):
 *   POST /colonies/:id/proposals/:pid/tests   { by? }: run the colony's tests on an escalated change again, on its base
 *                                             (202 with the queued run; the review queue shows the result when it ends;
 *                                             404 for an unknown proposal; 409 when the change no longer waits for a
 *                                             person, its run is already waiting or going, or tests cannot run in the
 *                                             colony)
 * Needs the admin token. Every escalated change gets a run without asking; this is the review card's "Run again".
 */
export function reviewTestsRoutes(app: Hono<ApiEnv>, admin: MiddlewareHandler<ApiEnv>): void {
  app.post("/colonies/:id/proposals/:pid/tests", admin, async (c) => {
    let raw: unknown = {};
    const text = await c.req.text();
    if (text.trim() !== "") {
      try {
        raw = JSON.parse(text) as unknown;
      } catch {
        throw ftError(400, "body must be JSON, or empty");
      }
    }
    const parsed = RetestBody.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.map(String).join(".") || "body"}: ${i.message}`);
      throw ftError(400, `invalid request: ${issues.join("; ")}`);
    }
    const pid = c.req.param("pid") ?? "";
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(pid)) throw ftError(404, "proposal not found");
    const stub = colony(c);
    if (!(await stub.getColony())) throw ftError(404, "colony not found");
    return json(await stub.retestProposal(pid, parsed.data.by ?? "api"), 202);
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
