import type { MiddlewareHandler } from "hono";

/**
 * Response headers on everything FireTrident serves. The Worker adds them to every answer it gives (`responseHeaders`
 * runs before every route in index.ts: the API, /mcp and /sse, the public MCP, /git, the front door, the signing key and
 * the static assets it fetches through ASSETS). Static assets that Workers serves without running the Worker (every path
 * outside run_worker_first in wrangler.jsonc, colony pages included) get the same security headers from
 * packages/web/public/_headers, which is `headersFile()` written out (test/front/headers.test.ts fails when they differ).
 *
 * Every header is added only when the answer does not set it already, and the body is passed on unread, so streams
 * (git packs, MCP and SSE streams) keep streaming. A WebSocket upgrade passes untouched.
 */

/**
 * The full Content-Security-Policy, sent report-only (violations show in the browser console; nothing is blocked) until
 * the replay and director UIs comply. It allows what packages/web loads: its own scripts and stylesheets, inline styles
 * (index.html's static summary and the colony map's tooltips set style attributes), the data: favicon, and fetches and
 * the live WebSocket to the same origin.
 */
export const REPORTED_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * Security headers on every response, static assets included. Nothing embeds the site on purpose, so framing is refused
 * everywhere (X-Frame-Options, and frame-ancestors in an enforced policy of its own).
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "frame-ancestors 'none'",
  "Content-Security-Policy-Report-Only": REPORTED_POLICY,
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
});

/** What a JSON answer that sets no caching of its own gets, so nobody sees a stale colony state through a cache. */
export const JSON_CACHE_CONTROL = "no-store";

const JSON_TYPE = /^application\/(?:[a-z0-9.+-]+\+)?json\s*(?:;|$)/i;

/** Whether an answer with these headers is JSON and says nothing about caching (no Cache-Control, no Expires). */
export function needsNoStore(headers: Headers): boolean {
  return JSON_TYPE.test((headers.get("content-type") ?? "").trim()) && !headers.has("cache-control") && !headers.has("expires");
}

/**
 * `res` with every security header it does not set itself, and Cache-Control: no-store when it is JSON that sets no
 * caching. Only headers change: the body is handed on unread. A WebSocket upgrade (101) and an answer that already has
 * everything come back as they are.
 */
export function withResponseHeaders(res: Response): Response {
  if (res.status === 101 || (res as { webSocket?: unknown }).webSocket) return res;
  const missing = Object.entries(SECURITY_HEADERS).filter(([name]) => !res.headers.has(name));
  const noStore = needsNoStore(res.headers);
  if (missing.length === 0 && !noStore) return res;
  // A copy, because a response from fetch, ASSETS or a Durable Object has headers that cannot be changed.
  const out = new Response(res.body, res);
  for (const [name, value] of missing) out.headers.set(name, value);
  if (noStore) out.headers.set("Cache-Control", JSON_CACHE_CONTROL);
  return out;
}

/** Middleware that gives every answer of the app it runs in the headers of `withResponseHeaders`. Register it first. */
export const responseHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  const out = withResponseHeaders(c.res);
  if (out !== c.res) c.res = out;
};

/** The text of packages/web/public/_headers: SECURITY_HEADERS on every path the static assets serve. */
export function headersFile(): string {
  const lines = Object.entries(SECURITY_HEADERS).map(([name, value]) => `  ${name}: ${value}`);
  return [
    "# Security headers on the static assets, which Workers serves without running the Worker on every path outside run_worker_first.",
    "# Written from SECURITY_HEADERS in packages/worker/src/front/headers.ts; test/front/headers.test.ts fails when they differ.",
    "/*",
    ...lines,
    "",
  ].join("\n");
}
