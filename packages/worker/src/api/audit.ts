import type { Context, Hono, MiddlewareHandler } from "hono";
import type { Id } from "@fire_trident/core";
import { z } from "zod";
import { ftError } from "../colony/errors.ts";
import { AUDIT_VERDICTS } from "../decide/audit.ts";
import type { ApiEnv } from "./app.ts";

/** POST /api/colonies/:id/audit/:pid: a person's answer to an audit item. */
export const AuditBody = z.object({
  verdict: z.enum(AUDIT_VERDICTS as unknown as [string, ...string[]]),
  reason: z.string().max(5_000).default(""),
  by: z.string().trim().min(1).max(200).optional(),
  /** With should-not-have-landed: revert the change now (as `ft revert` would), instead of only offering it. */
  revert: z.boolean().optional(),
});

/** POST /api/colonies/:id/canaries: who asks (the body may be empty). */
export const CanaryBody = z.object({
  by: z.string().trim().min(1).max(200).optional(),
});

/**
 * The audit sample and blind canaries (registered by createApi; colony/audit.ts):
 *   GET  /colonies/:id/audit             public: of the changes that landed without a person, how many went to the audit
 *                                        queue and what people answered, per confirming layer with Wilson 95% intervals;
 *                                        the canaries' catch rate; people's decisions on escalations per week; the items
 *                                        waiting (by proposal id) and the latest answers. A waiting canary is never named.
 *   POST /colonies/:id/audit/:pid        { verdict: fine | should-not-have-landed, reason, by?, revert? }: answer an audit
 *                                        item. should-not-have-landed needs a reason, takes back the region's earned
 *                                        autonomy when earned autonomy landed it, and offers the revert (or does it with
 *                                        revert: true). 404 when the proposal is not in the audit queue, 409 when it was
 *                                        already answered.
 *   POST /colonies/:id/canaries          { by? }: put one canary in the human queue now (409 while canaryRate is 0).
 * The rates are the colony decide policy's auditRate and canaryRate (POST /colonies/:id/decide/policy). POST routes need
 * the admin token.
 */
export function auditRoutes(app: Hono<ApiEnv>, admin: MiddlewareHandler<ApiEnv>): void {
  app.get("/colonies/:id/audit", async (c) => {
    const stub = await colony(c);
    return json(await stub.auditState());
  });

  app.post("/colonies/:id/audit/:pid", admin, async (c) => {
    const b = parse(AuditBody, await bodyOf(c));
    const pid = c.req.param("pid") ?? "";
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(pid)) throw ftError(404, "proposal not found");
    const stub = await colony(c);
    return json(await stub.auditAnswer(pid, { verdict: b.verdict, reason: b.reason, by: b.by ?? "api", ...(b.revert !== undefined ? { revert: b.revert } : {}) }));
  });

  app.post("/colonies/:id/canaries", admin, async (c) => {
    parse(CanaryBody, await bodyOf(c));
    const stub = await colony(c);
    return json(await stub.canaryNow(), 202);
  });
}

async function bodyOf(c: Context<ApiEnv>): Promise<unknown> {
  const text = await c.req.text();
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw ftError(400, "body must be JSON, or empty");
  }
}

function parse<T extends z.ZodTypeAny>(schema: T, raw: unknown): z.infer<T> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.map(String).join(".") || "body"}: ${i.message}`);
    throw ftError(400, `invalid request: ${issues.join("; ")}`);
  }
  return parsed.data as z.infer<T>;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

function colonyId(c: Context<ApiEnv>): Id {
  const id = c.req.param("id") ?? "";
  if (!/^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/.test(id)) throw ftError(404, "colony not found");
  return id;
}

/** The colony's object, once it is known to exist (404 otherwise). */
async function colony(c: Context<ApiEnv>) {
  const stub = c.env.COLONY.get(c.env.COLONY.idFromName(colonyId(c)));
  if (!(await stub.getColony())) throw ftError(404, "colony not found");
  return stub;
}
