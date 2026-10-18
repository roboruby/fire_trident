import type { Context, MiddlewareHandler } from "hono";
import type { Env } from "../env.ts";

/**
 * Limits on public reads. Anyone may read a public colony without a token: the public MCP endpoint (POST /public/mcp,
 * mcp/public.ts) and the public GET routes of the API (/api/colonies and /api/colonies/:id/...), each of which makes a
 * colony's Durable Object do work. Two Workers Rate Limiting bindings count those reads: PUBLIC_IP_LIMIT per client
 * address, PUBLIC_COLONY_LIMIT per colony, both shared by the two doors. Their limits and periods are in wrangler.jsonc;
 * a binding's counters are kept per Cloudflare location. A read over either limit gets 429 with Retry-After and a plain
 * sentence. A request with the admin token is the operator's and is not counted. Without the bindings (local
 * development, tests) nothing is limited, and a binding that fails lets the read through (logged): the public MCP's
 * per-isolate in-flight cap stays as a second guard either way.
 */

/** The rate limit bindings this reads; either may be missing. */
export type PublicLimits = Partial<Pick<Env, "PUBLIC_IP_LIMIT" | "PUBLIC_COLONY_LIMIT">>;

/** Seconds a refused caller is told to wait: the bindings' period. */
export const RETRY_AFTER_S = 60;

/** Why a public read was refused: which limit, and the sentence the caller sees. */
export interface Refusal {
  limit: "ip" | "colony";
  message: string;
}

/** The address a request came from, as Cloudflare's edge saw it (CF-Connecting-IP), or "unknown" off the edge. */
export function clientIp(req: Request): string {
  return req.headers.get("cf-connecting-ip")?.trim() || "unknown";
}

/** One count against one binding: true when the call may go ahead (no binding, or a binding that fails, counts as yes). */
async function allowed(binding: RateLimit | undefined, key: string): Promise<boolean> {
  if (!binding) return true;
  try {
    return (await binding.limit({ key })).success;
  } catch (e) {
    console.error(`public read limit: ${e instanceof Error ? e.message : String(e)}`);
    return true;
  }
}

/**
 * Count `calls` reads from `ip` (one per call) and one read of each colony in `colonies` (one entry per call, repeats
 * counted), and say why the reads are refused, or null when they may go ahead. The address is counted first, so an
 * address over its limit spends nothing of a colony's.
 */
export async function publicReadRefusal(limits: PublicLimits, ip: string, calls: number, colonies: readonly string[]): Promise<Refusal | null> {
  for (let i = 0; i < Math.max(1, calls); i++) {
    if (!(await allowed(limits.PUBLIC_IP_LIMIT, `ip:${ip}`))) {
      return { limit: "ip", message: `Too many public reads from this address in the last minute; wait ${RETRY_AFTER_S} seconds and try again.` };
    }
  }
  for (const colony of colonies) {
    if (!(await allowed(limits.PUBLIC_COLONY_LIMIT, `colony:${colony}`))) {
      return { limit: "colony", message: `Too many public reads of colony ${colony} in the last minute; wait ${RETRY_AFTER_S} seconds and try again.` };
    }
  }
  return null;
}

/**
 * The reads a public MCP body (already checked as JSON-RPC) asks for: one call per message, and for each tools/call
 * whose `colony` argument is one of `listed`, that colony (a colony not listed is refused without a read).
 */
export function mcpReads(body: unknown, listed: ReadonlySet<string>): { calls: number; colonies: string[] } {
  const messages: unknown[] = Array.isArray(body) ? body : [body];
  const colonies: string[] = [];
  for (const m of messages) {
    const msg = (m ?? {}) as { method?: unknown; params?: { arguments?: { colony?: unknown } } };
    const colony = msg.method === "tools/call" ? msg.params?.arguments?.colony : undefined;
    if (typeof colony === "string" && listed.has(colony)) colonies.push(colony);
  }
  return { calls: messages.length, colonies };
}

/** The 429 a refused REST read gets: JSON `{ error }` with Retry-After. */
export function refusedResponse(r: Refusal): Response {
  return new Response(JSON.stringify({ error: r.message }), {
    status: 429,
    headers: { "content-type": "application/json; charset=utf-8", "Retry-After": String(RETRY_AFTER_S) },
  });
}

/**
 * Middleware for the API's public reads (GET and HEAD under /colonies): one read counted against the client's address
 * and, under /colonies/:id, against that colony. Writes are left to requireAdmin, and a request `isAdmin` accepts (the
 * operator, with the admin token: api/app.ts isAdminRequest) is not counted.
 */
export function publicReadLimit(isAdmin: (c: Context<{ Bindings: Env }>) => Promise<boolean>): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    if ((c.req.method !== "GET" && c.req.method !== "HEAD") || !(c.env.PUBLIC_IP_LIMIT || c.env.PUBLIC_COLONY_LIMIT)) return next();
    if (await isAdmin(c)) return next();
    const colony = /\/colonies\/([^/]+)/.exec(c.req.path)?.[1];
    const refusal = await publicReadRefusal(c.env, clientIp(c.req.raw), 1, colony ? [safeDecode(colony)] : []);
    if (refusal) return refusedResponse(refusal);
    return next();
  };
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
