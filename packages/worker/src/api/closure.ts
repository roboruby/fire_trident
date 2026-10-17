import type { Context, Hono, MiddlewareHandler } from "hono";
import type { Id } from "@fire_trident/core";
import { z } from "zod";
import type { Env } from "../env.ts";
import { ftError } from "../colony/errors.ts";
import { MAX_PAUSE_BY } from "../colony/pause.ts";
import { MAX_SILENT_TTL_MS, MIN_SILENT_TTL_MS, type SilentTtlView } from "../colony/closure.ts";
import type { ApiEnv } from "./app.ts";

/**
 * The silent-agent limit (colony/closure.ts; registered by createApi). No flag: nothing changes until a person sets one.
 *   GET  /colonies/:id/silent-ttl   the colony's limit as it stands (public, like the other reads)
 *   POST /colonies/:id/silent-ttl   { seconds, by? }: an agent outside the platform silent this long loses its claimed
 *                                   intents to the colony, which reopens them with a failure mark; { seconds: null } goes
 *                                   back to the default ten minutes (admin)
 * In-platform agents keep at least ten minutes whatever the setting. The closures it causes (reaped_silent) are in the
 * metrics report's `closures`.
 */

/** POST /colonies/:id/silent-ttl (the colony checks the range, with a sentence). */
export const SilentTtlBody = z.object({
  seconds: z.number().finite().nullable(),
  by: z.string().trim().min(1).max(MAX_PAUSE_BY).optional(),
});

type ColonyTtlRpc = {
  silentTtl(): Promise<SilentTtlView>;
  setSilentTtl(p: { seconds: number | null; by?: string }): Promise<SilentTtlView>;
};

function colonyRpc(env: Pick<Env, "COLONY">, colonyId: Id): ColonyTtlRpc {
  return env.COLONY.get(env.COLONY.idFromName(colonyId)) as unknown as ColonyTtlRpc;
}

/** Register the silent-agent limit's routes on the API. `admin` is the API's write check (requireAdmin). */
export function silentTtlRoutes(app: Hono<ApiEnv>, admin: MiddlewareHandler<ApiEnv>): void {
  app.get("/colonies/:id/silent-ttl", async (c) => {
    const id = colonyId(c);
    return json({ colonyId: id, ...(await colonyRpc(c.env, id).silentTtl()) });
  });

  app.post("/colonies/:id/silent-ttl", admin, async (c) => {
    const id = colonyId(c);
    const b = await parse(c);
    return json({ colonyId: id, ...(await colonyRpc(c.env, id).setSilentTtl({ seconds: b.seconds, by: b.by ?? "api" })) });
  });
}

const EXAMPLE = `{ "seconds": 90 } (${MIN_SILENT_TTL_MS / 1000} to ${MAX_SILENT_TTL_MS / 1000}), or { "seconds": null } for the default ten minutes`;

/** The JSON body checked against SilentTtlBody; a 400 that shows what to send otherwise. */
async function parse(c: Context<ApiEnv>): Promise<z.output<typeof SilentTtlBody>> {
  let raw: unknown;
  try {
    const text = await c.req.text();
    raw = text.trim() ? JSON.parse(text) : {};
  } catch {
    throw ftError(400, `body must be JSON: send ${EXAMPLE}`);
  }
  const parsed = SilentTtlBody.safeParse(raw);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.map(String).join(".") || "body"}: ${i.message}`);
  throw ftError(400, `invalid request: ${issues.join("; ")}. Send ${EXAMPLE}`);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

function colonyId(c: Context<ApiEnv>): Id {
  const id = c.req.param("id") ?? "";
  if (!/^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/.test(id)) throw ftError(404, "colony not found");
  return id;
}
