import type { Context, Hono, MiddlewareHandler } from "hono";
import type { Id, SpendCap } from "@fire_trident/core";
import { z } from "zod";
import type { Env } from "../env.ts";
import { ftError } from "../colony/errors.ts";
import { MAX_PAUSE_BY } from "../colony/pause.ts";
import { MAX_CAP_USD, type SpendCapAnswer } from "../colony/spendcap.ts";
import type { ApiEnv } from "./app.ts";

/**
 * Spend cap routes (colony/spendcap.ts; registered by createApi). No flag: nothing changes until a person sets a cap.
 *   GET  /colonies/:id/spend-cap   the colony's spend cap as it stands, or null (public, like the other reads)
 *   POST /colonies/:id/spend-cap   { usd, reviewReserveUsd?, by? }: set, raise or lower the cap; { usd: null } removes it (admin)
 * The cap covers the model calls this platform makes for the colony, never what external agents spend on their own
 * models. At the cap minus the review reserve the pause switch trips (api/pause.ts resumes it), and review may spend
 * the reserve on changes already in flight.
 */

/** POST /colonies/:id/spend-cap. */
export const SpendCapBody = z.object({
  usd: z.number().positive().max(MAX_CAP_USD).nullable(),
  reviewReserveUsd: z.number().min(0).max(MAX_CAP_USD).optional(),
  by: z.string().trim().min(1).max(MAX_PAUSE_BY).optional(),
});

type ColonyCapRpc = {
  setSpendCap(p: { usd: number | null; reviewReserveUsd?: number; by?: string }): Promise<SpendCapAnswer>;
  spendCap(): Promise<SpendCap | null>;
};

function colonyRpc(env: Pick<Env, "COLONY">, colonyId: Id): ColonyCapRpc {
  return env.COLONY.get(env.COLONY.idFromName(colonyId)) as unknown as ColonyCapRpc;
}

/** Register the spend cap routes on the API. `admin` is the API's write check (requireAdmin). */
export function spendCapRoutes(app: Hono<ApiEnv>, admin: MiddlewareHandler<ApiEnv>): void {
  app.get("/colonies/:id/spend-cap", async (c) => {
    const id = colonyId(c);
    return json({ colonyId: id, cap: await colonyRpc(c.env, id).spendCap() });
  });

  app.post("/colonies/:id/spend-cap", admin, async (c) => {
    const id = colonyId(c);
    const b = await parse(c);
    const res = await colonyRpc(c.env, id).setSpendCap({ usd: b.usd, ...(b.reviewReserveUsd !== undefined ? { reviewReserveUsd: b.reviewReserveUsd } : {}), by: b.by ?? "api" });
    return json({ colonyId: id, ...res });
  });
}

const EXAMPLE = '{ "usd": 5, "reviewReserveUsd": 0.5 } (or { "usd": null } to remove the cap)';

/** The JSON body checked against SpendCapBody; a 400 that shows what to send otherwise. */
async function parse(c: Context<ApiEnv>): Promise<z.output<typeof SpendCapBody>> {
  let raw: unknown;
  try {
    const text = await c.req.text();
    raw = text.trim() ? JSON.parse(text) : {};
  } catch {
    throw ftError(400, `body must be JSON: send ${EXAMPLE}`);
  }
  const parsed = SpendCapBody.safeParse(raw);
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
