import { accountsStub } from "./client.ts";
import { accountsOn, sessionKey, type AccountsEnv } from "./config.ts";
import { SESSION_COOKIE, clearCookie, readCookie, setCookie } from "./cookies.ts";
import { base64url, randomBytes, sha256Hex, signValue, verifySigned } from "./crypto.ts";
import { SESSION_TTL_MS } from "./limits.ts";
import type { Account, CurrentAccount } from "./types.ts";

/**
 * Sessions: after sign-in the browser holds `__Host-ft_session`, a random 32-byte session id signed with HMAC under a key
 * derived from FT_SESSION_KEY. The accounts object keeps only the id's SHA-256, with the session's expiry and whether it
 * was ended. A cookie whose signature does not check out is never looked up.
 */

/** The HKDF purpose of the session cookie's signing key. */
const SESSION_PURPOSE = "firetrident session cookie v1";

/** What reading a session needs from a request: its env and its headers (a Hono context fits). */
export interface SessionContext {
  env: Partial<AccountsEnv>;
  req: { header(name: string): string | undefined };
}

/** A new session: the cookie to set, the hash the accounts object keeps, and when it ends. */
export async function newSession(key: string, now: number): Promise<{ cookie: string; hash: string; expiresAt: number }> {
  const sid = base64url(randomBytes(32));
  return {
    cookie: setCookie(SESSION_COOKIE, await signValue(sid, key, SESSION_PURPOSE), "/", SESSION_TTL_MS / 1000),
    hash: await sha256Hex(sid),
    expiresAt: now + SESSION_TTL_MS,
  };
}

/** The Set-Cookie line that ends the session cookie in the browser. */
export function endSessionCookie(): string {
  return clearCookie(SESSION_COOKIE, "/");
}

/** The hash of the session id a Cookie header carries, when its signature checks out; null otherwise. */
export async function sessionHash(env: Partial<AccountsEnv>, cookieHeader: string | undefined): Promise<string | null> {
  const key = sessionKey(env);
  const raw = readCookie(cookieHeader, SESSION_COOKIE);
  if (!key || !raw) return null;
  const sid = await verifySigned(raw, key, SESSION_PURPOSE);
  return sid ? sha256Hex(sid) : null;
}

/** The account of the request's session (live, not ended, signature good), with its creation time; null otherwise. */
export async function sessionAccount(c: SessionContext, now = Date.now()): Promise<Account | null> {
  if (!accountsOn(c.env)) return null;
  const stub = accountsStub(c.env);
  const hash = await sessionHash(c.env, c.req.header("cookie"));
  if (!stub || !hash) return null;
  return stub.sessionAccount(hash, now);
}

/**
 * The signed-in person of a request (a Hono context), or null: accounts off, no session cookie, a cookie whose
 * signature fails, or a session that expired or was ended.
 */
export async function currentAccount(c: SessionContext, now = Date.now()): Promise<CurrentAccount | null> {
  const a = await sessionAccount(c, now);
  return a ? { id: a.id, github: a.github } : null;
}
