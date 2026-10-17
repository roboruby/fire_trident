import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import type { Id } from "@fire_trident/core";
import type { Env } from "../env.ts";
import { decodeError, ftError } from "../colony/errors.ts";
import { policyProblems } from "../decide/policy.ts";
import { VACCINE_CLASSES } from "../decide/vaccine.ts";
import { bearerMatches } from "./token.ts";

/**
 * Decide-prong routes (mounted on the API root):
 *   POST /colonies/:id/vaccinate            { count?, classes? } start a vaccination batch (sealed bad proposals)
 *   GET  /colonies/:id/vaccinate            the vaccination meter: recall per class with Wilson 95% intervals; returned
 *                                           (a model or check stopped it) apart from escalated (sent to a person, not
 *                                           measured), errors (a model layer unavailable) left out
 *   GET  /colonies/:id/immune              antibodies, detector probation, earned autonomy, alert budget, policy
 *   GET  /colonies/:id/decide/policy        the decide policy
 *   POST /colonies/:id/decide/policy        change the decide policy (partial; returns it). commentProof must be a
 *                                           boolean and protectedPaths a list of at most 50 usable globs (400 otherwise)
 *   POST /colonies/:id/detectors/:did       { useful } mark a detector (clef:<question> or antibody:<id>)
 *   GET  /colonies/:id/decides              how the colony decides: the preset its policy equals (or custom and how it
 *                                           differs), and the last 30 days of landed changes by what confirmed them
 *                                           (decide/decides.ts)
 * POST routes require the admin bearer token when FT_ADMIN_TOKEN is set.
 */

type DecideEnv = { Bindings: Env };

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
}

const adminOnly: MiddlewareHandler<DecideEnv> = async (c, next) => {
  const expected = c.env.FT_ADMIN_TOKEN;
  if (expected) {
    const m = /^Bearer\s+(\S+)\s*$/i.exec(c.req.header("Authorization") ?? "");
    if (!m || !(await bearerMatches(m[1] ?? "", expected))) return json({ error: "unauthorized" }, 401, { "WWW-Authenticate": "Bearer" });
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

decideApi.get("/colonies/:id/decide/policy", async (c) => {
  const immune = (await stub(c.env, colonyOf(c)).immune()) as { policy?: unknown };
  return json(immune.policy ?? null);
});

// How the colony decides (decide/decides.ts): a public read, like the policy itself.
decideApi.get("/colonies/:id/decides", async (c) => json(await stub(c.env, colonyOf(c)).decides()));

decideApi.post("/colonies/:id/decide/policy", adminOnly, async (c) => {
  const colonyId = colonyOf(c);
  const body = await jsonBody(c);
  // Fields the policy would otherwise drop silently (a person would believe them set) are refused instead.
  const problems = policyProblems(body);
  if (problems.length > 0) throw ftError(400, `invalid request: ${problems.join("; ")}`);
  return json(await stub(c.env, colonyId).setDecidePolicy(body));
});

decideApi.post("/colonies/:id/detectors/:did", adminOnly, async (c) => {
  const colonyId = colonyOf(c);
  const b = await jsonBody(c);
  if (typeof b.useful !== "boolean") throw ftError(400, "useful must be true or false");
  return json(await stub(c.env, colonyId).detectorFeedback(c.req.param("did") ?? "", b.useful));
});
