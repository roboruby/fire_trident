import type { Context, Hono, MiddlewareHandler } from "hono";
import type { Id } from "@fire_trident/core";
import { z } from "zod";
import { ftError } from "../colony/errors.ts";
import { listOpenIssues, type Fetcher } from "../colony/github.ts";
import { ISSUE_LIMIT_DEFAULT, ISSUE_LIMIT_MAX, ISSUE_TEXT_CHARS, parseRepo } from "../colony/issues.ts";
import type { ApiEnv } from "./app.ts";

/** POST /api/colonies/:id/issues/import: the repository, and which of its open issues to import. */
export const IssueImportBody = z
  .object({
    repo: z.string().trim().min(3).max(200),
    labels: z
      .array(z.string().trim().min(1).max(50).refine((l) => !l.includes(","), "a label may not contain a comma"))
      .max(10)
      .optional(),
    limit: z.number().int().min(1).max(ISSUE_LIMIT_MAX).optional(),
    footprint: z.array(z.string().trim().min(1).max(1024)).min(1).max(50).optional(),
    closeOnLand: z.boolean().optional(),
    close: z.boolean().optional(),
    by: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

/** Most of an issue's text sent on to the colony: what its intent quotes, and the rest of the window paths are read from. */
const TEXT_SENT = ISSUE_TEXT_CHARS * 2;

/**
 * Issue routes (registered by createApi; colony/issues.ts, colony/github.ts). Importing does nothing until a person
 * asks, so there is no flag.
 *   POST /colonies/:id/issues/import   { repo: "owner/name", labels?, limit? (1 to 100, default 20), footprint?,
 *                                       closeOnLand?, close?, by? }: read the repository's open issues from GitHub
 *                                       (pull requests skipped; FT_GITHUB_TOKEN when set, else no token) and declare
 *                                       one intent per issue not imported before. 201 when it imported any, else 200;
 *                                       the answer lists what it imported and what it skipped, and why.
 * It needs the admin token. `fetcher` replaces the global fetch in tests: no test calls GitHub.
 */
export function issueRoutes(app: Hono<ApiEnv>, admin: MiddlewareHandler<ApiEnv>, fetcher?: Fetcher): void {
  app.post("/colonies/:id/issues/import", admin, async (c) => {
    const b = await body(c);
    const repo = parseRepo(b.repo);
    if (repo === null) throw ftError(400, `repo must name a GitHub repository as owner/name, such as octo-org/hello-world; got ${JSON.stringify(b.repo.slice(0, 100))}`);
    if (b.close === true && b.closeOnLand !== true) throw ftError(400, "close needs closeOnLand: an issue is closed only after the colony comments on it at landing");
    if (!(await colony(c).getColony())) throw ftError(404, "colony not found");
    const token = c.env.FT_GITHUB_TOKEN?.trim() || undefined;
    const read = await listOpenIssues(fetcher ?? ((input, init) => fetch(input, init)), repo, { limit: b.limit ?? ISSUE_LIMIT_DEFAULT, ...(b.labels ? { labels: b.labels } : {}), ...(token ? { token } : {}) });
    const issues = read.issues.map((i) => ({ ...i, body: i.body.slice(0, TEXT_SENT) }));
    const res = await colony(c).importIssues({
      repo,
      issues,
      ...(b.footprint ? { footprint: b.footprint } : {}),
      closeOnLand: b.closeOnLand === true,
      close: b.close === true,
      by: b.by ?? "api",
      tokenSet: token !== undefined,
    });
    return json({ ...res, read: { issues: read.issues.length, pullRequests: read.pulls, unreadable: read.malformed } }, res.imported.length > 0 ? 201 : 200);
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

async function body(c: Context<ApiEnv>): Promise<z.output<typeof IssueImportBody>> {
  let raw: unknown;
  try {
    raw = JSON.parse(await c.req.text());
  } catch {
    throw ftError(400, "body must be JSON");
  }
  const parsed = IssueImportBody.safeParse(raw);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.map(String).join(".") || "body"}: ${i.message}`);
  throw ftError(400, `invalid request: ${issues.join("; ")}`);
}

function colonyId(c: Context<ApiEnv>): Id {
  const id = c.req.param("id") ?? "";
  if (!/^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/.test(id)) throw ftError(404, "colony not found");
  return id;
}

function colony(c: Context<ApiEnv>) {
  return c.env.COLONY.get(c.env.COLONY.idFromName(colonyId(c)));
}
