import type { Context, Hono } from "hono";
import type { Id } from "@fire_trident/core";
import { ftError } from "../colony/errors.ts";
import type { HeadsUpAnswer, HeadsUpQuery } from "../colony/headsup.ts";
import { HEADS_UP_ASKED } from "../colony/headsup.ts";
import type { ResumeCheck } from "../mcp/tools.ts";
import type { ApiEnv } from "./app.ts";
import { bearerMatches } from "./token.ts";

/**
 * Heads-up route for the Claude Code hook (registered by createApi; colony/headsup.ts, `ft hook check`):
 *   GET /colonies/:id/agents/:aid/headsup[?path=<p>...]
 *     what the agent's held intent should know before it proposes: the landings since its lease base that changed its
 *     footprint's files or the files asked about (at most 4), and the changes waiting to land that write them, each with
 *     its intent's title. Read-only: it records nothing (the MCP replies record what they tell the agent). Nothing about
 *     another agent beyond what take shows: landings, proposal ids, regions and intent titles, never their agents.
 *
 * Auth as the agent's other calls: `Authorization: Bearer <FT_MCP_TOKEN>` (the admin token works too), or the agent's own
 * resume key in `X-FT-Resume-Key`, checked by the colony against the digest it keeps. A token or key in the URL is
 * refused. Without either secret configured the route refuses (fail closed), unless FT_OPEN_WRITES is "1" (local
 * development only).
 */
export function headsUpRoutes(app: Hono<ApiEnv>): void {
  app.get("/colonies/:id/agents/:aid/headsup", async (c) => {
    const agentId = agentParam(c);
    const stub = colony(c);
    const refused = await refusal(c, agentId, stub);
    if (refused) return refused;
    const paths = (c.req.queries("path") ?? []).filter((p) => typeof p === "string" && p.trim() !== "" && p.length <= 1_024).slice(0, HEADS_UP_ASKED);
    const q: HeadsUpQuery = paths.length > 0 ? { paths } : {};
    // An unknown agent is refused by the colony (404), as is a colony that does not exist.
    const answer = (await stub.headsUp(agentId, q)) as HeadsUpAnswer;
    return json({ agentId, intentId: answer.intentId, baseSha: answer.baseSha, headsUp: answer.report });
  });
}

/** The colony stub with the methods this route calls. */
type HeadsUpStub = {
  headsUp(agentId: Id, q: HeadsUpQuery): Promise<unknown>;
  resumeAgent(agentId: Id, resumeKey: string): Promise<unknown>;
};

/** Null when the request may read this agent's heads-up, else the refusal. */
async function refusal(c: Context<ApiEnv>, agentId: Id, stub: HeadsUpStub): Promise<Response | null> {
  const url = new URL(c.req.url);
  if (url.searchParams.has("token") || url.searchParams.has("resumeKey")) {
    return json({ error: "unauthorized: send the MCP token as an Authorization: Bearer header or the resume key as X-FT-Resume-Key, never in the URL" }, 401);
  }
  const m = /^Bearer\s+(\S+)\s*$/i.exec(c.req.header("Authorization") ?? "");
  if (m) {
    for (const secret of [c.env.FT_MCP_TOKEN, c.env.FT_ADMIN_TOKEN]) if (secret && (await bearerMatches(m[1] ?? "", secret))) return null;
  }
  const key = (c.req.header("X-FT-Resume-Key") ?? "").trim();
  if (key) {
    const r = (await stub.resumeAgent(agentId, key)) as ResumeCheck;
    if (r && "agent" in r) return null;
  }
  if (!c.env.FT_MCP_TOKEN && !c.env.FT_ADMIN_TOKEN && c.env.FT_OPEN_WRITES === "1") return null;
  return json({ error: "unauthorized: send the MCP token as Authorization: Bearer <token>, or the agent's resume key as X-FT-Resume-Key" }, 401, { "WWW-Authenticate": "Bearer" });
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
}

function colonyId(c: Context<ApiEnv>): Id {
  const id = c.req.param("id") ?? "";
  if (!/^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/.test(id)) throw ftError(404, "colony not found");
  return id;
}

function agentParam(c: Context<ApiEnv>): Id {
  const id = c.req.param("aid") ?? "";
  if (!/^[\w-]{1,100}$/.test(id)) throw ftError(404, "agent not found");
  return id;
}

function colony(c: Context<ApiEnv>): HeadsUpStub {
  return c.env.COLONY.get(c.env.COLONY.idFromName(colonyId(c))) as unknown as HeadsUpStub;
}
