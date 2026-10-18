import type { Env } from "../../env.ts";
import { bearerMatches, configuredToken } from "../../api/token.ts";

function refuse(status: number, error: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json", ...headers } });
}

/**
 * The gate in front of the review endpoint (/mcp/review), where a person decides escalated changes from a chat client:
 * null lets the request through, a Response refuses it. It takes the admin token only, as `Authorization: Bearer
 * <token>`, compared in constant time (api/token.ts). It fails closed: without FT_ADMIN_TOKEN configured it refuses
 * every request, and FT_OPEN_WRITES does not open it (deciding is never open, not even in local development). The
 * agents' token never opens it: a token that is also FT_MCP_TOKEN is refused even when the two secrets were set to the
 * same value. A `token` query parameter is refused whatever it holds: a token in a URL ends up in logs and histories.
 */
export async function reviewMcpRefusal(req: Request, env: Pick<Env, "FT_ADMIN_TOKEN" | "FT_MCP_TOKEN">): Promise<Response | null> {
  if (new URL(req.url).searchParams.has("token")) {
    return refuse(401, "unauthorized: send the FireTrident admin token as an Authorization: Bearer <token> header, never in the URL");
  }
  const admin = configuredToken(env.FT_ADMIN_TOKEN ?? "");
  if (admin === "") return refuse(403, "forbidden: the review endpoint needs FT_ADMIN_TOKEN configured on the server");
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get("authorization") ?? "");
  const presented = m?.[1] ?? "";
  if (!m || !(await bearerMatches(presented, admin))) {
    return refuse(401, "unauthorized: the review endpoint takes the FireTrident admin token as an Authorization: Bearer <token> header; the agents' MCP token does not open it", { "WWW-Authenticate": "Bearer" });
  }
  if (env.FT_MCP_TOKEN && (await bearerMatches(presented, env.FT_MCP_TOKEN))) {
    return refuse(403, "forbidden: FT_ADMIN_TOKEN and FT_MCP_TOKEN hold the same value, so an agent's token would open the review endpoint; set them to different values");
  }
  return null;
}
