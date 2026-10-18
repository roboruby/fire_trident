import type { Context, Hono, MiddlewareHandler } from "hono";
import type { Id } from "@fire_trident/core";
import { z } from "zod";
import { ftError } from "../colony/errors.ts";
import { MAX_BATCH_DECISION } from "../decide/batch.ts";
import { approverIdentity } from "./access.ts";
import type { ApiEnv } from "./app.ts";

/**
 * POST /api/colonies/:id/review/batches/decide: a person's answer for one batch of the review queue. `ids` are the
 * changes the card listed; only those are decided. A rejection needs a reason, as on a change's own card.
 */
export const BatchDecisionBody = z
  .object({
    key: z.string().min(1).max(1_000),
    ids: z
      .array(z.string().regex(/^[A-Za-z0-9_-]{1,100}$/, "a proposal id"))
      .min(1)
      .max(MAX_BATCH_DECISION),
    decision: z.enum(["approve", "reject"]),
    reason: z.string().max(5_000).default(""),
    by: z.string().trim().min(1).max(200).optional(),
  })
  .refine((b) => b.decision !== "reject" || b.reason.trim() !== "", { message: "a rejection needs a reason: it becomes the antibody that screens later changes", path: ["reason"] });

/**
 * Escalation batching routes (registered by createApi; decide/batch.ts, FT_ESCALATION_BATCH):
 *   POST /colonies/:id/review/batches/decide   { key, ids, decision: "approve" | "reject", reason, by? }: the person's
 *                                              decision on each listed change that still waits in that batch, one by
 *                                              one, as on its own card. Answers { key, decision, decided, skipped:
 *                                              [{ id, why }] }; 409 where the flag does not cover the colony.
 * Needs the admin token. The queue (GET /colonies/:id/review) marks each batched change with its `batch`.
 */
export function reviewBatchRoutes(app: Hono<ApiEnv>, admin: MiddlewareHandler<ApiEnv>): void {
  app.post("/colonies/:id/review/batches/decide", admin, async (c) => {
    let raw: unknown;
    try {
      raw = JSON.parse(await c.req.text()) as unknown;
    } catch {
      throw ftError(400, "body must be JSON: { key, ids, decision, reason }");
    }
    const parsed = BatchDecisionBody.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.map(String).join(".") || "body"}: ${i.message}`);
      throw ftError(400, `invalid request: ${issues.join("; ")}`);
    }
    const b = parsed.data;
    const stub = colony(c);
    if (!(await stub.getColony())) throw ftError(404, "colony not found");
    // Verified approvers (api/access.ts): each change of the batch records the verified email, else the stated name.
    const who = await approverIdentity(c.env, c.req.raw.headers, b.by);
    return json(await stub.decideBatch({ key: b.key, ids: b.ids, decision: b.decision, reason: b.reason, by: who.by }, who));
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
