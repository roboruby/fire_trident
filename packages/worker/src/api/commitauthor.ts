import type { Context, Hono, MiddlewareHandler } from "hono";
import type { CommitAuthor, Id } from "@fire_trident/core";
import { z } from "zod";
import type { Env } from "../env.ts";
import { ftError } from "../colony/errors.ts";
import type { ApiEnv } from "./app.ts";

/**
 * People as commit authors (colony/commitauthor.ts; registered by createApi). No flag: nothing changes until a person
 * names someone.
 *   GET  /colonies/:id/commit-author   the person who authors the colony's landing commits, or null when FireTrident
 *                                      does (public; the email only with the admin token, as commits show it anyway)
 *   POST /colonies/:id/commit-author   { name, email, by? }: that person authors every landing commit from now on, the
 *                                      committer stays FireTrident and agents get no Co-authored-by trailers;
 *                                      { name: null, by? } goes back to FireTrident as the author (admin)
 */

/** POST /colonies/:id/commit-author. */
export const CommitAuthorBody = z.object({
  name: z.union([z.string().max(1_000), z.null()]),
  email: z.string().max(1_000).optional(),
  by: z.string().trim().min(1).max(200).optional(),
});

type ColonyAuthorRpc = {
  commitAuthor(): Promise<CommitAuthor | null>;
  setCommitAuthor(p: { name: string | null; email?: string; by?: string }): Promise<{ author: CommitAuthor | null; cleared?: boolean }>;
};

function colonyRpc(env: Pick<Env, "COLONY">, colonyId: Id): ColonyAuthorRpc {
  return env.COLONY.get(env.COLONY.idFromName(colonyId)) as unknown as ColonyAuthorRpc;
}

/** The setting as a reader sees it: without the address unless `admin`. */
function shown(a: CommitAuthor | null, admin: boolean): Partial<CommitAuthor> | null {
  if (!a) return null;
  return admin ? a : { name: a.name, by: a.by, at: a.at };
}

/** Register the commit author routes. `admin` is the API's write check (requireAdmin), `isAdmin` tells an operator's read. */
export function commitAuthorRoutes(app: Hono<ApiEnv>, admin: MiddlewareHandler<ApiEnv>, isAdmin: (c: Context<ApiEnv>) => Promise<boolean>): void {
  app.get("/colonies/:id/commit-author", async (c) => {
    const id = colonyId(c);
    return json({ colonyId: id, author: shown(await colonyRpc(c.env, id).commitAuthor(), await isAdmin(c)) });
  });

  app.post("/colonies/:id/commit-author", admin, async (c) => {
    const id = colonyId(c);
    const b = await parse(c);
    const res = await colonyRpc(c.env, id).setCommitAuthor({ name: b.name, ...(b.email !== undefined ? { email: b.email } : {}), by: b.by ?? "api" });
    return json({ colonyId: id, ...res });
  });
}

const EXAMPLE = '{ "name": "Dana Reviewer", "email": "dana@example.com" } (or { "name": null } to go back to FireTrident as the author)';

/** The JSON body checked against CommitAuthorBody; a 400 that shows what to send otherwise. */
async function parse(c: Context<ApiEnv>): Promise<z.output<typeof CommitAuthorBody>> {
  let raw: unknown;
  try {
    const text = await c.req.text();
    raw = text.trim() ? JSON.parse(text) : {};
  } catch {
    throw ftError(400, `body must be JSON: send ${EXAMPLE}`);
  }
  const parsed = CommitAuthorBody.safeParse(raw);
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
