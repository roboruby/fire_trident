import { Hono } from "hono";
import type { Context, Handler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { ApiEnv } from "../api/app.ts";
import { tokensEqual } from "../api/token.ts";
import { ACCOUNT_PAGE_PATH, accountsOn, connectConfig, publicBase, STATE_COOKIE, STATE_COOKIE_PATH, STATE_TTL_MS } from "./config.ts";
import { grantObject } from "./grant.ts";
import { ACCOUNT_ID, authorizeUrl, pkceChallenge, randomToken, sha256Hex } from "./oauth.ts";
import { REFUSED } from "./service.ts";
import type { AccountId, ConnectCode } from "./types.ts";

/**
 * "Connect Cloudflare", the routes (mounted at the root of the Worker's app; FT_ACCOUNTS on, else each answers 404 as an
 * unknown route does):
 *   GET  /auth/cloudflare/start        signed in: start the OAuth flow (state cookie, PKCE), redirect to Cloudflare
 *   GET  /auth/cloudflare/callback     Cloudflare sends the person back here; redirect to /account?cloudflare=<what happened>
 *   GET  /api/me/cloudflare            signed in: the connection's status (never a token)
 *   POST /api/me/cloudflare/account    signed in, from our own pages: choose the Cloudflare account ({ accountId })
 *   POST /api/me/cloudflare/disconnect signed in, from our own pages: revoke at Cloudflare and forget
 * The redirect URI is fixed from FT_PUBLIC_URL; the state is bound to a short HttpOnly cookie and to the signed-in
 * account, compared in constant time and used once. The signed-in account comes from the accounts module, injected.
 */

/** What these routes need from the accounts module: who is signed in. */
export interface ConnectRoutesDeps {
  currentAccount: (c: Context<ApiEnv>) => Promise<{ id: AccountId } | null>;
}

const SIGN_IN = "Sign in first: a Cloudflare connection belongs to a FireTrident account.";
const WRONG_ORIGIN = "This request did not come from this site's own pages, so it was refused.";
/** The longest authorization code taken from Cloudflare's redirect. */
const MAX_CODE_CHARS = 2048;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

/** The 404 every route here answers while FT_ACCOUNTS is off: the same answer as a route that does not exist. */
function notFound(c: Context<ApiEnv>): Response {
  return json({ error: `no route for ${c.req.method} ${c.req.path}` }, 404);
}

/** A handler that answers only with FT_ACCOUNTS on. */
function gated(h: Handler<ApiEnv>): Handler<ApiEnv> {
  return (c, next) => (accountsOn(c.env) ? h(c, next) : notFound(c));
}

/** Whether a browser's state-changing request came from FT_PUBLIC_URL's origin (no Origin header: refused). */
function sameOrigin(c: Context<ApiEnv>): boolean {
  const pub = publicBase(c.env.FT_PUBLIC_URL);
  const origin = c.req.header("Origin");
  return !!pub && typeof origin === "string" && origin === pub.origin;
}

/** The routes, with the signed-in account from `deps`. */
export function cloudflareRoutes(deps: ConnectRoutesDeps): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();

  app.get(
    "/auth/cloudflare/start",
    gated(async (c) => {
      const me = await deps.currentAccount(c);
      if (!me) return json({ error: SIGN_IN }, 401);
      const cfg = connectConfig(c.env);
      const obj = grantObject(c.env, me.id);
      if (!cfg || !obj) return json({ error: REFUSED.unavailable }, 503);
      const state = randomToken(32);
      // 64 characters, inside PKCE's 43 to 128.
      const verifier = randomToken(48);
      await obj.begin(me.id, await sha256Hex(state), verifier);
      setCookie(c, STATE_COOKIE, state, { path: STATE_COOKIE_PATH, httpOnly: true, secure: true, sameSite: "Lax", maxAge: Math.round(STATE_TTL_MS / 1000) });
      c.header("Cache-Control", "no-store");
      return c.redirect(authorizeUrl(cfg, state, await pkceChallenge(verifier)), 302);
    }),
  );

  app.get(
    "/auth/cloudflare/callback",
    gated(async (c) => {
      const pub = publicBase(c.env.FT_PUBLIC_URL);
      if (!pub) return json({ error: REFUSED.unavailable }, 503);
      const cookieState = getCookie(c, STATE_COOKIE) ?? "";
      // The state cookie is spent whatever happens.
      deleteCookie(c, STATE_COOKIE, { path: STATE_COOKIE_PATH, httpOnly: true, secure: true, sameSite: "Lax" });
      c.header("Cache-Control", "no-store");
      const back = (what: ConnectCode | "connected" | "choose") => c.redirect(`${pub.base}${ACCOUNT_PAGE_PATH}?cloudflare=${what}`, 302);
      const cfg = connectConfig(c.env);
      const me = await deps.currentAccount(c);
      if (!me) return back("signin");
      const obj = grantObject(c.env, me.id);
      if (!cfg || !obj) return back("unavailable");
      const error = c.req.query("error");
      if (error) return back(error === "access_denied" ? "denied" : "refused");
      const state = c.req.query("state") ?? "";
      const code = c.req.query("code") ?? "";
      if (!state || !cookieState || !(await tokensEqual(state, cookieState))) return back("expired");
      if (!code || code.length > MAX_CODE_CHARS) return back("error");
      const r = await obj.complete(me.id, await sha256Hex(state), code);
      return back(r.ok ? (r.status.state === "choose" ? "choose" : "connected") : r.code);
    }),
  );

  app.get(
    "/api/me/cloudflare",
    gated(async (c) => {
      const me = await deps.currentAccount(c);
      if (!me) return json({ error: SIGN_IN }, 401);
      const obj = connectConfig(c.env) ? grantObject(c.env, me.id) : null;
      if (!obj) return json({ configured: false, state: "none", scopes: [], workersAi: false });
      return json({ configured: true, ...(await obj.status(me.id)) });
    }),
  );

  app.post(
    "/api/me/cloudflare/account",
    gated(async (c) => {
      if (!sameOrigin(c)) return json({ error: WRONG_ORIGIN }, 403);
      const me = await deps.currentAccount(c);
      if (!me) return json({ error: SIGN_IN }, 401);
      const obj = connectConfig(c.env) ? grantObject(c.env, me.id) : null;
      if (!obj) return json({ error: REFUSED.unavailable }, 503);
      const body = (await c.req.json().catch(() => null)) as { accountId?: unknown } | null;
      const id = body && typeof body.accountId === "string" ? body.accountId : "";
      if (!ACCOUNT_ID.test(id)) return json({ error: REFUSED.choice, code: "choice" }, 400);
      const r = await obj.choose(me.id, id);
      return r.ok ? json({ configured: true, ...r.status }) : json({ error: r.message, code: r.code }, 400);
    }),
  );

  app.post(
    "/api/me/cloudflare/disconnect",
    gated(async (c) => {
      if (!sameOrigin(c)) return json({ error: WRONG_ORIGIN }, 403);
      const me = await deps.currentAccount(c);
      if (!me) return json({ error: SIGN_IN }, 401);
      const obj = grantObject(c.env, me.id);
      if (!obj) return json({ error: REFUSED.unavailable }, 503);
      const r = await obj.disconnect(me.id);
      return json({ disconnected: r.disconnected, revokedAtCloudflare: r.revoked, state: "none" });
    }),
  );

  return app;
}
