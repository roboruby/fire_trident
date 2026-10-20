import type { Context, Hono } from "hono";
import type { Id, IntentLifecycle } from "@fire_trident/core";
import type { Env } from "../env.ts";
import { ftError } from "../colony/errors.ts";
import type { ApiEnv } from "./app.ts";

/**
 * An intent's lifecycle strip (colony/lifecycle.ts; registered by createApi). No flag: a read that changes nothing.
 *   GET /colonies/:id/intents/:iid/lifecycle   declared, claimed, proposed, confirmed, landed and certified, each with its
 *                                              evidence and time, the two steps that happen on the team's GitHub (never
 *                                              done here), and where a change left the path (returned, escalated,
 *                                              withdrawn, reaped): for the change the intent stands on now and each of its
 *                                              changes, newest first. Public, like the intent's own read.
 */

type ColonyLifecycleRpc = { intentLifecycle(id: Id): Promise<IntentLifecycle | null> };

function colonyRpc(env: Pick<Env, "COLONY">, colonyId: Id): ColonyLifecycleRpc {
  return env.COLONY.get(env.COLONY.idFromName(colonyId)) as unknown as ColonyLifecycleRpc;
}

/** Register the lifecycle read on the API. */
export function lifecycleRoutes(app: Hono<ApiEnv>): void {
  app.get("/colonies/:id/intents/:iid/lifecycle", async (c) => {
    const iid = c.req.param("iid") ?? "";
    const res = await colonyRpc(c.env, colonyId(c)).intentLifecycle(iid);
    if (!res) throw ftError(404, `unknown intent ${iid}: list the colony's intents with GET /api/colonies/:id`);
    return json(res);
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
