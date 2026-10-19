import { CF_API, CF_AUTHORIZE_URL, CF_REVOKE_URL, CF_TOKEN_URL, REQUESTED_SCOPES, REQUIRED_SCOPES, type ConnectConfig } from "./config.ts";
import { toBase64Url } from "./seal.ts";
import type { CloudflareAccount } from "./types.ts";

/**
 * Cloudflare OAuth, the client side: the authorization code flow with the client secret in the form body
 * (client_secret_post) and PKCE S256, refresh, revocation, and the accounts a token reaches. Every call goes through an
 * injected fetch (tests use a fake Cloudflare) with a time limit. No token, code or secret is ever put in an error,
 * a log line or a URL of ours: errors carry only the OAuth error code Cloudflare answered.
 */

/** fetch as this module calls it (the global one in the Worker, a fake in tests). */
export type HttpFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** One call's time limit. */
const CALL_TIMEOUT_MS = 15_000;
/** The access token life assumed when Cloudflare names none. */
const DEFAULT_EXPIRES_S = 3600;
/** Account list pages read at most (50 accounts each). */
const MAX_ACCOUNT_PAGES = 4;
const ACCOUNTS_PER_PAGE = 50;
/** A Cloudflare account id. */
export const ACCOUNT_ID = /^[0-9a-f]{32}$/;

/** Tokens from the token endpoint. */
export interface TokenSet {
  accessToken: string;
  /** Absent when Cloudflare issued none (offline_access not granted): the connection then lasts one access token. */
  refreshToken: string | null;
  expiresAt: number;
  /** The scopes granted, from the answer's `scope`; null when the answer named none. */
  scopes: string[] | null;
}

/**
 * Cloudflare refused or could not answer. `code` is Cloudflare's OAuth error code (invalid_grant, access_denied, ...)
 * or "unavailable"; `definitive` is true when Cloudflare answered with a refusal (a retry would get the same answer).
 */
export class OAuthRefusal extends Error {
  constructor(
    readonly code: string,
    readonly definitive: boolean,
    readonly status: number | null = null,
  ) {
    super(`Cloudflare OAuth: ${code}${status ? ` (HTTP ${status})` : ""}`);
    this.name = "OAuthRefusal";
  }
}

/** A random URL-safe string of `bytes` random bytes (state values, PKCE verifiers). */
export function randomToken(bytes = 32): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** SHA-256 of a string, as base64url (the PKCE S256 challenge of a verifier). */
export async function pkceChallenge(verifier: string): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

/** SHA-256 of a string, as hex (how a state value is stored: never the value itself). */
export async function sha256Hex(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The authorize URL a person is sent to: code flow, our fixed redirect URI, every requested scope, state and the S256 challenge. */
export function authorizeUrl(cfg: ConnectConfig, state: string, challenge: string): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    scope: REQUESTED_SCOPES.join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `${CF_AUTHORIZE_URL}?${q.toString()}`;
}

/** Cloudflare's OAuth error code from an answer's body, reduced to a short identifier (never echoed text). */
function errorCode(body: unknown): string {
  const code = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
  return typeof code === "string" && /^[a-z_]{1,40}$/.test(code) ? code : "refused";
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** The granted scopes in an answer's `scope` (space-separated), or null when there is none. */
export function scopeList(scope: unknown): string[] | null {
  if (typeof scope !== "string") return null;
  return [...new Set(scope.split(/\s+/).filter((s) => /^[a-z0-9_.:-]{1,64}$/i.test(s)))];
}

/** A token endpoint answer as tokens; throws OAuthRefusal when it is not one. */
function tokenSet(body: unknown, now: number): TokenSet {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const access = b.access_token;
  if (typeof access !== "string" || access.length === 0 || access.length > 8192) throw new OAuthRefusal("no_access_token", true);
  const refresh = typeof b.refresh_token === "string" && b.refresh_token.length > 0 && b.refresh_token.length <= 8192 ? b.refresh_token : null;
  const expiresIn = typeof b.expires_in === "number" && Number.isFinite(b.expires_in) && b.expires_in > 0 ? b.expires_in : DEFAULT_EXPIRES_S;
  return { accessToken: access, refreshToken: refresh, expiresAt: now + Math.round(expiresIn * 1000), scopes: scopeList(b.scope) };
}

/** POST a form to the token endpoint with the client's credentials in the body (client_secret_post). */
async function tokenCall(cfg: ConnectConfig, form: Record<string, string>, fetchFn: HttpFetch, now: number): Promise<TokenSet> {
  const body = new URLSearchParams({ ...form, client_id: cfg.clientId, client_secret: cfg.clientSecret });
  let res: Response;
  try {
    res = await fetchFn(CF_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: body.toString(),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
  } catch {
    throw new OAuthRefusal("unavailable", false);
  }
  const json = await readJson(res);
  // 400 and 401 are the OAuth server's refusals (invalid_grant, invalid_client, ...): the same request fails again.
  if (res.status === 400 || res.status === 401) throw new OAuthRefusal(errorCode(json), true, res.status);
  if (!res.ok) throw new OAuthRefusal("unavailable", false, res.status);
  return tokenSet(json, now);
}

/** Exchange an authorization code (with its PKCE verifier) for tokens. */
export function exchangeCode(cfg: ConnectConfig, code: string, verifier: string, fetchFn: HttpFetch, now: number): Promise<TokenSet> {
  return tokenCall(cfg, { grant_type: "authorization_code", code, redirect_uri: cfg.redirectUri, code_verifier: verifier }, fetchFn, now);
}

/** Trade a refresh token for new tokens (Cloudflare may rotate the refresh token: the caller keeps the new one). */
export function refreshTokens(cfg: ConnectConfig, refreshToken: string, fetchFn: HttpFetch, now: number): Promise<TokenSet> {
  return tokenCall(cfg, { grant_type: "refresh_token", refresh_token: refreshToken }, fetchFn, now);
}

/** Revoke a token at Cloudflare; true when Cloudflare accepted. Never throws. */
export async function revokeToken(cfg: ConnectConfig, token: string, hint: "refresh_token" | "access_token", fetchFn: HttpFetch): Promise<boolean> {
  const body = new URLSearchParams({ token, token_type_hint: hint, client_id: cfg.clientId, client_secret: cfg.clientSecret });
  try {
    const res = await fetchFn(CF_REVOKE_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** A Cloudflare account name as shown: control characters dropped, trimmed, at most 120 characters. */
function cleanName(name: unknown, id: string): string {
  const s = typeof name === "string" ? name.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 120) : "";
  return s || id;
}

/**
 * The accounts an access token reaches (GET /accounts, up to MAX_ACCOUNT_PAGES pages of 50). Entries without a
 * Cloudflare account id are left out. Throws OAuthRefusal when Cloudflare does not answer with a list.
 */
export async function listAccounts(accessToken: string, fetchFn: HttpFetch): Promise<CloudflareAccount[]> {
  const out = new Map<string, CloudflareAccount>();
  for (let page = 1; page <= MAX_ACCOUNT_PAGES; page++) {
    let res: Response;
    try {
      res = await fetchFn(`${CF_API}/accounts?per_page=${ACCOUNTS_PER_PAGE}&page=${page}`, {
        headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch {
      throw new OAuthRefusal("unavailable", false);
    }
    const json = (await readJson(res)) as { success?: unknown; result?: unknown } | null;
    if (!res.ok || !json || json.success !== true || !Array.isArray(json.result)) throw new OAuthRefusal("accounts_unavailable", res.status === 401 || res.status === 403, res.status);
    for (const a of json.result as Array<{ id?: unknown; name?: unknown }>) {
      if (a && typeof a.id === "string" && ACCOUNT_ID.test(a.id) && !out.has(a.id)) out.set(a.id, { id: a.id, name: cleanName(a.name, a.id) });
    }
    if (json.result.length < ACCOUNTS_PER_PAGE) break;
  }
  return [...out.values()];
}

/**
 * The scopes a new grant records: what Cloudflare said it granted, or, when its answer named none, only the required
 * scopes (an unnamed optional scope is not assumed: Workers AI stays off until a grant names it).
 */
export function grantedScopes(tokens: TokenSet): string[] {
  return tokens.scopes ?? [...REQUIRED_SCOPES];
}
