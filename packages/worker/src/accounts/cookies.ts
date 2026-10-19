/**
 * The accounts cookies. Every one is HttpOnly, Secure, SameSite=Lax, scoped to the paths that read it, and expires.
 * - The session (`__Host-ft_session`, path /, 14 days): a random session id and its HMAC; the server keeps the id's hash.
 * - The sign-in state (`ft_oauth`, path /auth/github, 10 minutes): the OAuth state and the PKCE verifier, sealed.
 * - A new person's sign-up (`ft_signup`, path /auth/github, 15 minutes): who GitHub said they are, sealed, until they
 *   enter an invite code.
 */

export const SESSION_COOKIE = "__Host-ft_session";
export const OAUTH_COOKIE = "ft_oauth";
export const SIGNUP_COOKIE = "ft_signup";
/** The path the sign-in cookies are scoped to. */
export const SIGNIN_PATH = "/auth/github";

const NAME = /^[A-Za-z0-9_-]+$/;
const VALUE = /^[A-Za-z0-9._~-]*$/;

/** One cookie's value from a Cookie header, or null. Values outside base64url and dots are ignored. */
export function readCookie(header: string | null | undefined, name: string): string | null {
  if (!header || header.length > 16_384) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    return VALUE.test(value) && value !== "" ? value : null;
  }
  return null;
}

/** A Set-Cookie line: HttpOnly, Secure, SameSite=Lax, on `path`, for `maxAgeS` seconds (0 clears it). */
export function setCookie(name: string, value: string, path: string, maxAgeS: number): string {
  if (!NAME.test(name)) throw new Error("bad cookie name");
  if (!VALUE.test(value)) throw new Error("bad cookie value");
  return `${name}=${value}; Path=${path}; Max-Age=${Math.max(0, Math.floor(maxAgeS))}; HttpOnly; Secure; SameSite=Lax`;
}

/** The Set-Cookie line that clears a cookie on its path. */
export function clearCookie(name: string, path: string): string {
  return setCookie(name, "", path, 0);
}
