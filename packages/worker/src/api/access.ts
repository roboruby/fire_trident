import type { Env } from "../env.ts";
import type { ApproverWho } from "../decide/receipt.ts";

/**
 * Verified approvers behind Cloudflare Access. A person's review decision names who decided; the request body's `by` is
 * only what the caller says. Where FT_ACCESS_TEAM_DOMAIN and FT_ACCESS_AUD are set (the Access team domain and the
 * Application Audience tag of the Access application in front of this Worker), the decision routes read the
 * Cf-Access-Jwt-Assertion header that Access adds to every request it lets through and verify it: an RS256 JWT signed by
 * one of the team's keys (https://<team domain>/cdn-cgi/access/certs, read once an hour and again for a key id not seen
 * yet, at most once a minute), whose `aud` holds FT_ACCESS_AUD, `iss` is https://<team domain>, `exp` is in the future
 * and `nbf` is not. Its `email` is then the approver, recorded as verified. Anything else (no token, a bad one, a service
 * token with no email, keys that cannot be read) records the stated name as stated, with why; the plain
 * Cf-Access-Authenticated-User-Email header is never read. Verification never decides whether the write may happen: the
 * admin token still does (api/app.ts requireAdmin). Absent either variable, nothing is verified and names are stated.
 */

/** The header Access adds with the signed token. */
export const ACCESS_HEADER = "cf-access-jwt-assertion";
/** How long the team's keys are kept, and how soon an unknown key id may read them again. */
const KEYS_TTL_MS = 60 * 60_000;
const KEYS_RETRY_MS = 60_000;
/** How long reading the keys may take. */
const FETCH_MS = 5_000;
/** Clock skew allowed on `nbf` (seconds). `exp` gets none: an expired token is not verified. */
const NBF_SKEW_S = 60;
/** Longest token read. */
const MAX_TOKEN_CHARS = 16_384;
const HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const B64URL = /^[A-Za-z0-9_-]+$/;
const EMAIL = /^[^\s@<>()",;:\\[\]\u0000-\u001f\u007f]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const RSA = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

/** What verification needs: the team's host name, the audience tag, and the issuer and keys URL made from the host. */
export interface AccessConfig {
  team: string;
  aud: string;
  issuer: string;
  certs: string;
}

/** What a verification may stand in for (tests): the fetch of the team's keys and the clock (ms). */
export interface AccessDeps {
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  now?: () => number;
}

/**
 * The Access settings, null when either is absent (verification is off), or an error sentence when they are set but the
 * team domain is not a host name (decisions are then recorded as stated, with that sentence).
 */
export function accessConfig(env: Pick<Env, "FT_ACCESS_TEAM_DOMAIN" | "FT_ACCESS_AUD">): AccessConfig | { error: string } | null {
  const rawTeam = typeof env.FT_ACCESS_TEAM_DOMAIN === "string" ? env.FT_ACCESS_TEAM_DOMAIN.trim() : "";
  const aud = typeof env.FT_ACCESS_AUD === "string" ? env.FT_ACCESS_AUD.trim() : "";
  if (rawTeam === "" || aud === "") return null;
  const team = rawTeam.replace(/^https?:\/\//i, "").replace(/\/+$/, "").toLowerCase();
  if (!HOST.test(team)) return { error: "FT_ACCESS_TEAM_DOMAIN is not a host name such as <team>.cloudflareaccess.com, so no Access token can be verified" };
  return { team, aud, issuer: `https://${team}`, certs: `https://${team}/cdn-cgi/access/certs` };
}

/** The team's keys by key id, as last read; kept per team domain for the isolate's life. */
const keyCache = new Map<string, { at: number; keys: Map<string, CryptoKey> }>();

/** Forget every cached key (tests). */
export function resetAccessKeys(): void {
  keyCache.clear();
}

function fromBase64url(text: string): Uint8Array {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const s = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

function jsonPart(part: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(fromBase64url(part)));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Read the team's keys (only RSA signing keys with an id), and keep them. */
async function readKeys(cfg: AccessConfig, deps: AccessDeps): Promise<Map<string, CryptoKey>> {
  const get = deps.fetch ?? ((url: string, init?: RequestInit) => fetch(url, init));
  const res = await get(cfg.certs, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(FETCH_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { keys?: unknown };
  const keys = new Map<string, CryptoKey>();
  for (const k of Array.isArray(body?.keys) ? body.keys : []) {
    if (!k || typeof k !== "object") continue;
    const j = k as Record<string, unknown>;
    if (j.kty !== "RSA" || typeof j.kid !== "string" || typeof j.n !== "string" || typeof j.e !== "string") continue;
    if (j.alg !== undefined && j.alg !== "RS256") continue;
    if (j.use !== undefined && j.use !== "sig") continue;
    try {
      keys.set(j.kid, await crypto.subtle.importKey("jwk", { kty: "RSA", n: j.n, e: j.e, alg: "RS256", ext: true }, RSA, false, ["verify"]));
    } catch {
      // A key that does not import verifies nothing.
    }
  }
  keyCache.set(cfg.team, { at: (deps.now ?? Date.now)(), keys });
  return keys;
}

/** The key for `kid`: from the cache while fresh, read again when stale or when the id is new (at most once a minute). */
async function keyFor(cfg: AccessConfig, kid: string, deps: AccessDeps): Promise<CryptoKey | undefined> {
  const now = (deps.now ?? Date.now)();
  const cached = keyCache.get(cfg.team);
  if (cached && now - cached.at < KEYS_TTL_MS && (cached.keys.has(kid) || now - cached.at < KEYS_RETRY_MS)) return cached.keys.get(kid);
  return (await readKeys(cfg, deps)).get(kid);
}

/**
 * Verify an Access token against the settings: the person's email when it checks out, else why not as a sentence.
 * Never throws.
 */
export async function verifyAccessToken(token: string, cfg: AccessConfig, deps: AccessDeps = {}): Promise<{ ok: true; email: string } | { ok: false; why: string }> {
  const no = (why: string): { ok: false; why: string } => ({ ok: false, why });
  const parts = token.trim().split(".");
  if (token.length > MAX_TOKEN_CHARS || parts.length !== 3 || !parts.every((p) => B64URL.test(p))) return no("the Access token is not a JWT");
  const [h, p, s] = parts as [string, string, string];
  const header = jsonPart(h);
  const claims = jsonPart(p);
  if (!header || !claims) return no("the Access token is not a JWT");
  if (header.alg !== "RS256") return no("the Access token is not signed with RS256");
  if (typeof header.kid !== "string" || header.kid === "") return no("the Access token names no key");
  let key: CryptoKey | undefined;
  try {
    key = await keyFor(cfg, header.kid, deps);
  } catch (e) {
    return no(`the Access team's keys could not be read (${e instanceof Error ? e.message.slice(0, 80) : "unknown error"})`);
  }
  if (!key) return no("the Access token is signed by a key the team does not publish");
  let good = false;
  try {
    good = await crypto.subtle.verify(RSA, key, fromBase64url(s), new TextEncoder().encode(`${h}.${p}`));
  } catch {
    good = false;
  }
  if (!good) return no("the Access token's signature does not verify");
  if (claims.iss !== cfg.issuer) return no("the Access token was issued by another team");
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(cfg.aud)) return no("the Access token is for another application (its audience does not match FT_ACCESS_AUD)");
  const nowS = (deps.now ?? Date.now)() / 1000;
  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || nowS >= claims.exp) return no("the Access token has expired");
  if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || nowS + NBF_SKEW_S < claims.nbf)) return no("the Access token is not valid yet");
  const email = typeof claims.email === "string" ? claims.email.trim() : "";
  if (email === "" || email.length > 254 || !EMAIL.test(email)) return no("the Access token names no person (a service token, or no email)");
  return { ok: true, email };
}

/**
 * Who a person's decision names: with Access verification configured and a token that checks out, the token's email,
 * verified; otherwise `stated` (the request's `by`, or "human"), stated, with why when verification was configured.
 */
export async function approverIdentity(env: Pick<Env, "FT_ACCESS_TEAM_DOMAIN" | "FT_ACCESS_AUD">, headers: Headers, stated: string | undefined, deps: AccessDeps = {}): Promise<ApproverWho> {
  const name = typeof stated === "string" && stated.trim() !== "" ? stated.trim() : "human";
  const cfg = accessConfig(env);
  if (cfg === null) return { by: name, identity: "stated" };
  if ("error" in cfg) return { by: name, identity: "stated", why: cfg.error };
  const token = headers.get(ACCESS_HEADER);
  if (!token) return { by: name, identity: "stated", why: "no Access token came with the request" };
  const v = await verifyAccessToken(token, cfg, deps);
  if (!v.ok) return { by: name, identity: "stated", why: v.why };
  return { by: v.email, identity: "verified", ...(name !== "human" && name !== v.email ? { stated: name } : {}) };
}

/** What the decision routes answer about the name they recorded. */
export function recordedAs(who: ApproverWho): { by: string; identity: ApproverWho["identity"]; why?: string } {
  return { by: who.by, identity: who.identity, ...(who.why ? { why: who.why } : {}) };
}
