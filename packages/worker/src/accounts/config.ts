import type { Env } from "../env.ts";
import { configuredToken } from "../api/token.ts";

/**
 * The accounts flag and settings. FT_ACCOUNTS is deployment-wide: "on" turns accounts on, anything else (absent
 * included) leaves them off, every accounts route answers 404 and nothing reads the accounts object.
 */

/** The env the accounts module reads. */
export type AccountsEnv = Pick<
  Env,
  "FT_ACCOUNTS" | "FT_PUBLIC_URL" | "FT_GITHUB_CLIENT_ID" | "FT_GITHUB_CLIENT_SECRET" | "FT_SESSION_KEY" | "FT_ADMIN_TOKEN" | "FT_MCP_TOKEN" | "ACCOUNTS"
>;

/** Whether accounts are on for this deployment (FT_ACCOUNTS is "on"). */
export function accountsOn(env: Partial<Pick<Env, "FT_ACCOUNTS">>): boolean {
  return typeof env.FT_ACCOUNTS === "string" && env.FT_ACCOUNTS.trim().toLowerCase() === "on";
}

/** The shortest session key accepted: 32 characters, so the key material is not guessable. */
const MIN_SESSION_KEY = 32;

/** The public origin every redirect URI and Origin check is made from (FT_PUBLIC_URL), or null when it is not an http(s) URL. */
export function publicOrigin(env: Partial<Pick<Env, "FT_PUBLIC_URL">>): string | null {
  const raw = typeof env.FT_PUBLIC_URL === "string" ? env.FT_PUBLIC_URL.trim() : "";
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null;
  } catch {
    return null;
  }
}

/** The session key (FT_SESSION_KEY without a trailing line break), or null when it is missing or too short. */
export function sessionKey(env: Partial<Pick<Env, "FT_SESSION_KEY">>): string | null {
  const key = configuredToken(typeof env.FT_SESSION_KEY === "string" ? env.FT_SESSION_KEY : "");
  return key.length >= MIN_SESSION_KEY ? key : null;
}

/** What GitHub sign-in needs, all present. */
export interface SignInConfig {
  origin: string;
  clientId: string;
  clientSecret: string;
  sessionKey: string;
  /** `${FT_PUBLIC_URL}/auth/github/callback`, never taken from a request. */
  redirectUri: string;
}

/**
 * GitHub sign-in's settings, or the sentence saying which one is missing (names only, never a value). The redirect URI
 * is fixed from FT_PUBLIC_URL.
 */
export function signInConfig(env: Partial<AccountsEnv>): SignInConfig | { missing: string } {
  const origin = publicOrigin(env);
  const clientId = typeof env.FT_GITHUB_CLIENT_ID === "string" ? env.FT_GITHUB_CLIENT_ID.trim() : "";
  const clientSecret = configuredToken(typeof env.FT_GITHUB_CLIENT_SECRET === "string" ? env.FT_GITHUB_CLIENT_SECRET : "");
  const key = sessionKey(env);
  const gaps: string[] = [];
  if (!origin) gaps.push("FT_PUBLIC_URL");
  if (!clientId) gaps.push("FT_GITHUB_CLIENT_ID");
  if (!clientSecret) gaps.push("FT_GITHUB_CLIENT_SECRET");
  if (!key) gaps.push("FT_SESSION_KEY (at least 32 characters)");
  if (!origin || !clientId || !clientSecret || !key) {
    return { missing: `Sign-in is not set up on this deployment: the operator has to set ${gaps.join(", ")}.` };
  }
  return { origin, clientId, clientSecret, sessionKey: key, redirectUri: `${origin}/auth/github/callback` };
}
