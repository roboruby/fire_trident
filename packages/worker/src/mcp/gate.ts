import type { Env } from "../env.ts";
import { tokensEqual } from "../api/app.ts";

function refuse(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json" } });
}

/**
 * The gate in front of /mcp and /sse: null lets the request through, a Response refuses it. Clients
 * send FT_MCP_TOKEN as `Authorization: Bearer <token>`, compared in constant time. A `token` query
 * parameter is refused (401) whatever it holds: a token in a URL ends up in logs and histories.
 * Without the secret the endpoint refuses (fail closed), unless FT_OPEN_WRITES is "1" (local
 * development only).
 */
export async function mcpRefusal(req: Request, env: Pick<Env, "FT_MCP_TOKEN" | "FT_OPEN_WRITES">): Promise<Response | null> {
  if (new URL(req.url).searchParams.has("token")) {
    return refuse(401, "unauthorized: send the FireTrident MCP token as an Authorization: Bearer <token> header, never in the URL");
  }
  const expected = env.FT_MCP_TOKEN;
  if (!expected) return env.FT_OPEN_WRITES === "1" ? null : refuse(403, "forbidden: MCP needs FT_MCP_TOKEN configured on the server");
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get("authorization") ?? "");
  if (!m || !(await tokensEqual(m[1] ?? "", expected))) return refuse(401, "unauthorized: send the FireTrident MCP token as an Authorization: Bearer <token> header");
  return null;
}
