import type { SignInConfig } from "./config.ts";
import type { GithubIdentity } from "./types.ts";

/**
 * GitHub sign-in: the OAuth authorization code flow with `state` and PKCE (S256), and one read of the signed-in user.
 * The redirect URI is FT_PUBLIC_URL's (config.ts), never the request's. No scope is asked for: the public profile is
 * all FireTrident reads (the numeric user id, the login and the name). GitHub's access token is used for that one read
 * and dropped: it is never stored, logged or sent anywhere else.
 */

export const GITHUB_AUTHORIZE = "https://github.com/login/oauth/authorize";
export const GITHUB_TOKEN = "https://github.com/login/oauth/access_token";
export const GITHUB_USER = "https://api.github.com/user";

/** How long each call to GitHub may take. */
const FETCH_MS = 10_000;
/** GitHub logins: letters, digits and single hyphens, at most 39 characters. */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
/** The longest display name kept. */
const NAME_CHARS = 100;

/** What sign-in may stand in for (tests): the fetch that reaches GitHub. */
export type GithubFetch = (url: string, init: RequestInit) => Promise<Response>;

/** The URL that sends a person to GitHub to sign in. */
export function authorizeUrl(cfg: Pick<SignInConfig, "clientId" | "redirectUri">, state: string, challenge: string): string {
  const q = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    allow_signup: "true",
  });
  return `${GITHUB_AUTHORIZE}?${q.toString()}`;
}

/** Why sign-in with GitHub failed, as a sentence for the person (never a token, a code or GitHub's raw answer). */
export class GithubSignInError extends Error {}

/** A display name: control characters out, spaces folded, at most NAME_CHARS characters; undefined when empty. */
export function cleanName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const s = raw
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s ? [...s].slice(0, NAME_CHARS).join("") : undefined;
}

/** GitHub's user object as the identity FireTrident keeps, or null when it is not one (no positive id, a login that is not a login). */
export function identityOf(raw: unknown): GithubIdentity | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const id = o.id;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) return null;
  if (typeof o.login !== "string" || !LOGIN.test(o.login)) return null;
  const name = cleanName(o.name);
  return { id, login: o.login, ...(name ? { name } : {}) };
}

/**
 * Exchange the authorization code (with the PKCE verifier and the client secret) for an access token, read who it
 * belongs to, and drop the token. Throws GithubSignInError with a sentence when GitHub refuses or answers something else.
 */
export async function githubIdentity(cfg: SignInConfig, code: string, verifier: string, fetcher: GithubFetch): Promise<GithubIdentity> {
  let token: string;
  try {
    const res = await fetcher(GITHUB_TOKEN, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded", "user-agent": "FireTrident" },
      body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, code, redirect_uri: cfg.redirectUri, code_verifier: verifier }).toString(),
      signal: AbortSignal.timeout(FETCH_MS),
    });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    const t = body?.access_token;
    if (!res.ok || typeof t !== "string" || t === "") {
      throw new GithubSignInError("GitHub did not accept the sign-in (the link may have expired or been used already). Sign in again.");
    }
    token = t;
  } catch (e) {
    if (e instanceof GithubSignInError) throw e;
    throw new GithubSignInError("GitHub could not be reached to finish the sign-in. Try again in a minute.");
  }
  let who: GithubIdentity | null = null;
  try {
    const res = await fetcher(GITHUB_USER, {
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "FireTrident", "x-github-api-version": "2022-11-28" },
      signal: AbortSignal.timeout(FETCH_MS),
    });
    who = res.ok ? identityOf(await res.json().catch(() => null)) : null;
  } catch {
    throw new GithubSignInError("GitHub could not be reached to say who you are. Try again in a minute.");
  }
  if (!who) throw new GithubSignInError("GitHub did not say who you are. Sign in again.");
  return who;
}
