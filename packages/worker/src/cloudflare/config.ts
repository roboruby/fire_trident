import type { Env } from "../env.ts";
import { configuredToken } from "../api/token.ts";

/**
 * Configuration for "Connect Cloudflare": the accounts flag, Cloudflare's endpoints, the scopes, and the deployment's
 * OAuth client. Endpoints as developers.cloudflare.com/fundamentals/oauth/integrate-with-cloudflare lists them (and
 * dash.cloudflare.com/.well-known/openid-configuration publishes them).
 */

export const CF_AUTHORIZE_URL = "https://dash.cloudflare.com/oauth2/auth";
export const CF_TOKEN_URL = "https://dash.cloudflare.com/oauth2/token";
export const CF_REVOKE_URL = "https://dash.cloudflare.com/oauth2/revoke";
/** Cloudflare's REST API (accounts, Workers AI). */
export const CF_API = "https://api.cloudflare.com/client/v4";

/** Scopes a connection must have: who the person is, which accounts they can choose, and the colonies' repositories. */
export const REQUIRED_SCOPES: readonly string[] = ["user-details.read", "account-settings.read", "artifacts.read", "artifacts.write"];
/** Optional scopes for models on the person's Workers AI. Running a model accepts either one (the API reference for /ai/run). */
export const WORKERS_AI_SCOPES: readonly string[] = ["ai.read", "ai.write"];
/** Asked for so Cloudflare issues a refresh token (its discovery document lists offline_access); not required. */
export const OFFLINE_SCOPE = "offline_access";
/** Every scope the authorize request asks for. */
export const REQUESTED_SCOPES: readonly string[] = [...REQUIRED_SCOPES, ...WORKERS_AI_SCOPES, OFFLINE_SCOPE];

/** Where Cloudflare sends the person back, under FT_PUBLIC_URL (never taken from the request). */
export const CALLBACK_PATH = "/auth/cloudflare/callback";
/** Where the callback sends the person afterwards: the account page, with ?cloudflare=<what happened>. */
export const ACCOUNT_PAGE_PATH = "/account";
/** The cookie that binds an authorize request's state to the browser that started it, and its path. */
export const STATE_COOKIE = "ft_cf_state";
export const STATE_COOKIE_PATH = "/auth/cloudflare";
/** How long a started connection may take to come back (the state cookie's life and the stored verifier's). */
export const STATE_TTL_MS = 10 * 60_000;
/** The shortest FT_GRANT_KEY accepted (characters); shorter, connecting stays off. */
export const MIN_GRANT_KEY_CHARS = 32;

/** What this module reads from the Worker's environment. FT_ACCOUNTS belongs to the accounts module; read here as the same flag. */
export type ConnectEnv = Pick<Env, "FT_PUBLIC_URL"> & Partial<Pick<Env, "FT_CF_CLIENT_ID" | "FT_CF_CLIENT_SECRET" | "FT_GRANT_KEY" | "CF_GRANTS">> & { FT_ACCOUNTS?: string };

/** Whether accounts are on for this deployment (FT_ACCOUNTS "on"; absent or anything else is off). */
export function accountsOn(env: object): boolean {
  const flag = (env as { FT_ACCOUNTS?: unknown }).FT_ACCOUNTS;
  return typeof flag === "string" && flag.trim().toLowerCase() === "on";
}

/** The deployment's OAuth client and the addresses made from FT_PUBLIC_URL. */
export interface ConnectConfig {
  clientId: string;
  clientSecret: string;
  grantKey: string;
  /** FT_PUBLIC_URL's origin: what a browser's Origin header must be on a state-changing route. */
  origin: string;
  /** FT_PUBLIC_URL without a trailing slash: the base of the redirect URI and of the account page. */
  base: string;
  redirectUri: string;
}

/** The base and origin of FT_PUBLIC_URL, or null when it is not an http(s) URL. */
export function publicBase(publicUrl: string | undefined): { base: string; origin: string } | null {
  if (!publicUrl) return null;
  let url: URL;
  try {
    url = new URL(publicUrl.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  return { base: `${url.origin}${url.pathname.replace(/\/+$/, "")}`, origin: url.origin };
}

/**
 * The OAuth client, or null when connecting is not set up: FT_CF_CLIENT_ID, FT_CF_CLIENT_SECRET and FT_GRANT_KEY (at
 * least MIN_GRANT_KEY_CHARS) all present, and FT_PUBLIC_URL an http(s) URL. Secrets lose a trailing line break, as the
 * deployment's other secrets do (api/token.ts).
 */
export function connectConfig(env: Partial<ConnectEnv>): ConnectConfig | null {
  const clientId = env.FT_CF_CLIENT_ID?.trim() ?? "";
  const clientSecret = configuredToken(env.FT_CF_CLIENT_SECRET ?? "");
  const grantKey = configuredToken(env.FT_GRANT_KEY ?? "");
  const pub = publicBase(env.FT_PUBLIC_URL);
  if (!clientId || !clientSecret || grantKey.length < MIN_GRANT_KEY_CHARS || !pub) return null;
  return { clientId, clientSecret, grantKey, origin: pub.origin, base: pub.base, redirectUri: `${pub.base}${CALLBACK_PATH}` };
}

/** Whether a grant's scopes include Workers AI (ai.read or ai.write). */
export function hasWorkersAi(scopes: readonly string[]): boolean {
  return scopes.some((s) => WORKERS_AI_SCOPES.includes(s));
}

/** The required scopes a grant lacks (empty when it has them all). */
export function missingScopes(scopes: readonly string[]): string[] {
  return REQUIRED_SCOPES.filter((s) => !scopes.includes(s));
}
