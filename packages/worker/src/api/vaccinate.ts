import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import type { Id } from "@fire_trident/core";
import type { Env } from "../env.ts";
import { decodeError, ftError } from "../colony/errors.ts";
import { VACCINE_CLASSES } from "../decide/vaccine.ts";

/**
 * Decide-prong routes (mounted on the API root):
 *   POST /colonies/:id/vaccinate            { count?, classes? } start a vaccination batch (sealed bad proposals)
 *   GET  /colonies/:id/vaccinate            the vaccination meter: recall per class with Wilson 95% intervals; returned
 *                                           (a model or check stopped it) apart from escalated (sent to a person, not
 *                                           measured), errors (a model layer unavailable) left out
 *   GET  /colonies/:id/immune              antibodies, detector probation, earned autonomy, alert budget, policy
 *   POST /colonies/:id/decide/policy        change the decide policy (partial)
 *   POST /colonies/:id/detectors/:did       { useful } mark a detector (clef:<question> or antibody:<id>)
 * POST routes require the admin bearer token when FT_ADMIN_TOKEN is set.
 */

type DecideEnv = { Bindings: Env };

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
}

/** Constant-time comparison of two secrets (SHA-256 digests). */
async function sameSecret(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  const x = new Uint8Array(da);
  const y = new Uint8Array(db);
  let diff = x.length ^ y.length;
  for (let i = 0; i < x.length && i < y.length; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

const adminOnly: MiddlewareHandler<DecideEnv> = async (c, next) => {
  const expected = c.env.FT_ADMIN_TOKEN;
  if (expected) {
    const m = /^Bearer\s+(\S+)\s*$/i.exec(c.req.header("Authorization") ?? "");
    if (!m || !(await sameSecret(m[1] ?? "", expected))) return json({ error: "unauthorized" }, 401, { "WWW-Authenticate": "Bearer" });
  } else if (c.env.FT_OPEN_WRITES !== "1") {
    return json({ error: "forbidden: writes need FT_ADMIN_TOKEN configured on the server" }, 403);
  }
  await next();
};

function colonyOf(c: Context<DecideEnv>): Id {
  const id = c.req.param("id") ?? "";
  if (!/^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/.test(id)) throw ftError(404, "colony not found");
  return id;
}

function stub(env: Env, colonyId: Id) {
  return env.COLONY.get(env.COLONY.idFromName(colonyId));
}

async function jsonBody(c: Context<DecideEnv>): Promise<Record<string, unknown>> {
  const text = await c.req.text();
  if (!text.trim()) return {};
  try {
    const v = JSON.parse(text) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw ftError(400, "body must be a JSON object");
}

/** The decide-prong sub-app. */
export const decideApi = new Hono<DecideEnv>();

decideApi.onError((err, c) => {
  const { status, message } = decodeError(err);
  if (status >= 500) console.error(`${c.req.method} ${c.req.path} failed: ${message}`);
  return json({ error: message }, status);
});

decideApi.post("/colonies/:id/vaccinate", adminOnly, async (c) => {
  const colonyId = colonyOf(c);
  const b = await jsonBody(c);
  const count = b.count === undefined ? 8 : Number(b.count);
  if (!Number.isInteger(count) || count < 1 || count > 64) throw ftError(400, "count must be an integer from 1 to 64");
  const classes = b.classes === undefined ? undefined : Array.isArray(b.classes) ? b.classes.filter((x): x is string => typeof x === "string") : null;
  if (classes === null || (classes && classes.some((x) => !(VACCINE_CLASSES as readonly string[]).includes(x)))) {
    throw ftError(400, `classes must be a list of: ${VACCINE_CLASSES.join(", ")}`);
  }
  const res = await stub(c.env, colonyId).vaccinate({ count, ...(classes ? { classes } : {}) });
  return json(res, 202);
});

decideApi.get("/colonies/:id/vaccinate", async (c) => json(await stub(c.env, colonyOf(c)).vaccineReport()));

decideApi.get("/colonies/:id/immune", async (c) => json(await stub(c.env, colonyOf(c)).immune()));

decideApi.post("/colonies/:id/decide/policy", adminOnly, async (c) => {
  const colonyId = colonyOf(c);
  return json(await stub(c.env, colonyId).setDecidePolicy(await jsonBody(c)));
});

decideApi.post("/colonies/:id/detectors/:did", adminOnly, async (c) => {
  const colonyId = colonyOf(c);
  const b = await jsonBody(c);
  if (typeof b.useful !== "boolean") throw ftError(400, "useful must be true or false");
  return json(await stub(c.env, colonyId).detectorFeedback(c.req.param("did") ?? "", b.useful));
});
