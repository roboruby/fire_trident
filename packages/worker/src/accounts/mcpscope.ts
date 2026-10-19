import type { Env } from "../env.ts";
import { bearerMatches } from "../api/token.ts";
import { accountsStub } from "./client.ts";
import { accountsOn } from "./config.ts";
import { sha256Hex } from "./crypto.ts";
import { bearerOf, tokenRefusal } from "./scope.ts";
import { isScopedToken } from "./tokens.ts";

/**
 * Scoped tokens at the agents' MCP endpoint (FT_ACCOUNTS). index.ts asks `scopedMcp` before the MCP gate (mcp/gate.ts):
 * a request whose bearer is a scoped token is handled here, everything else (FT_MCP_TOKEN, no token, accounts off) gets
 * null and goes through the gate exactly as before.
 *
 * A scoped token opens /mcp (Streamable HTTP) for an agent or owner token whose colony its account still owns. The MCP
 * session it opens is bound to it (the session id's hash, kept until the token expires): another token, or the
 * deployment's, never continues that session, and this token never continues another. Every tool call that names a
 * colony (join's `colony`) must name the token's: an MCP session works on the colony it joined, so it can only ever work
 * on that one. /sse is refused: its session id travels in the URL.
 */

/** The longest request body read here (the MCP SDK's own limit is lower). */
const MAX_BODY = 8 * 1024 * 1024;

function refuse(status: number, error: string): Response {
  const headers: Record<string, string> = { "content-type": "application/json; charset=utf-8" };
  if (status === 401) headers["WWW-Authenticate"] = "Bearer";
  return new Response(JSON.stringify({ error }), { status, headers });
}

/** A JSON-RPC error answer for one message, as an MCP client reads a refusal of its call. */
function rpcRefusal(id: unknown, message: string): Response {
  const rid = typeof id === "string" || typeof id === "number" ? id : null;
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: rid, error: { code: -32003, message } }), { status: 403, headers: { "content-type": "application/json; charset=utf-8" } });
}

/** A colony id as join reads it (trimmed, lowercased). */
function colonyArg(raw: unknown): string | null {
  return typeof raw === "string" ? raw.trim().toLowerCase() : null;
}

/** The first tool call in a JSON-RPC body that names a colony other than `colonyId`, or null. */
export function otherColonyCall(body: unknown, colonyId: string): { id: unknown; named: string } | null {
  const messages = Array.isArray(body) ? body : [body];
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const msg = m as { id?: unknown; method?: unknown; params?: { arguments?: unknown } };
    if (msg.method !== "tools/call") continue;
    const args = msg.params?.arguments;
    if (!args || typeof args !== "object" || !("colony" in args)) continue;
    const named = colonyArg((args as { colony?: unknown }).colony);
    if (named !== colonyId) return { id: msg.id, named: named ?? String((args as { colony?: unknown }).colony) };
  }
  return null;
}

/**
 * Handle an MCP request made with a scoped token, forwarding it to the MCP server (`forward`) when the token allows it;
 * null when the request carries no scoped token (the MCP gate decides as before).
 */
export async function scopedMcp(req: Request, env: Env, forward: (req: Request) => Promise<Response>, now: () => number = Date.now): Promise<Response | null> {
  if (!accountsOn(env)) return null;
  const bearer = bearerOf(req.headers.get("authorization"));
  if (bearer === null || !isScopedToken(bearer)) return null;
  const url = new URL(req.url);
  // A token in the URL is the gate's to refuse, whatever the header holds.
  if (url.searchParams.has("token")) return null;
  if (env.FT_MCP_TOKEN && (await bearerMatches(bearer, env.FT_MCP_TOKEN))) return null;
  const stub = accountsStub(env);
  if (!stub) return null;
  if (url.pathname !== "/mcp" && !url.pathname.startsWith("/mcp/")) {
    return refuse(403, "A scoped token works at /mcp (Streamable HTTP) only; /sse takes only the deployment's MCP token. Point your client at /mcp.");
  }
  const at = now();
  const check = await stub.checkToken(await sha256Hex(bearer), at);
  const t = check?.token;
  // Every token is scoped to its own colony; the MCP endpoint itself names none, so the colony checked here is the token's.
  const refused = tokenRefusal(check, t?.colonyId, "agent");
  if (refused || !check || !t) return refuse(refused?.status ?? 403, refused?.error ?? "This token cannot open the MCP endpoint.");
  const sessionId = req.headers.get("mcp-session-id");
  if (sessionId) {
    const bound = await stub.mcpSessionToken(await sha256Hex(sessionId), at);
    if (bound !== t.id) return refuse(403, "This MCP session was not opened with this token. Start a new session with it (reconnect your client).");
  }
  let forwarded = req;
  if (req.method === "POST") {
    if (Number(req.headers.get("content-length") ?? "0") > MAX_BODY) return refuse(413, "The request is too large.");
    const text = await req.text();
    if (text.length > MAX_BODY) return refuse(413, "The request is too large.");
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      // Not JSON: the MCP server answers it as it answers any malformed request.
    }
    const other = otherColonyCall(body, t.colonyId);
    if (other) return rpcRefusal(other.id, `This token is for colony ${t.colonyId} only, so it cannot join colony ${other.named.slice(0, 100)}.`);
    forwarded = new Request(req, { body: text });
  }
  const res = await forward(forwarded);
  if (!sessionId) {
    const issued = res.headers.get("mcp-session-id");
    if (issued && res.ok) await stub.bindMcpSession(await sha256Hex(issued), t.id, t.expiresAt, at);
  }
  return res;
}
