import type { Context, Hono, MiddlewareHandler } from "hono";
import type { Id } from "@fire_trident/core";
import { ftError } from "../colony/errors.ts";
import type { ApiEnv } from "./app.ts";

/**
 * Trunk certification routes (registered by createApi):
 *   GET  /colonies/:id/certifications         results, newest first (?limit=), with the state: switches, policy, run in flight
 *   GET  /colonies/:id/certifications/:sha    one commit's result (a full sha or a unique prefix of 7+ characters)
 *   POST /colonies/:id/certify                certify the current trunk now (even if it was certified)
 *   POST /colonies/:id/certify/policy         change the colony's policy (partial): { enabled, repair, repairsPerHour, timeoutMs, testTimeoutMs, minIntervalMs }
 * POST routes need the admin token.
 */
export function certifyRoutes(app: Hono<ApiEnv>, admin: MiddlewareHandler<ApiEnv>): void {
  app.get("/colonies/:id/certifications", async (c) => {
    const stub = colony(c);
    const raw = c.req.query("limit");
    const limit = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : 50;
    const [state, results] = await Promise.all([stub.certifyState(), stub.certifications(limit)]);
    return json({ colonyId: colonyId(c), ...state, results });
  });

  app.get("/colonies/:id/certifications/:sha", async (c) => {
    const cert = await colony(c).certification(c.req.param("sha"));
    if (!cert) throw ftError(404, "no certification for that commit");
    return json(cert);
  });

  app.post("/colonies/:id/certify", admin, async (c) => {
    const res = await colony(c).certifyNow();
    return json(res, res.started ? 202 : 409);
  });

  app.post("/colonies/:id/certify/policy", admin, async (c) => {
    let patch: unknown;
    try {
      patch = JSON.parse((await c.req.text()) || "{}");
    } catch {
      throw ftError(400, "body must be JSON");
    }
    return json(await colony(c).setCertifyPolicy(patch));
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
