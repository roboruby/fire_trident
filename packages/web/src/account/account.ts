/**
 * The account page's data (packages/worker/src/accounts/routes.ts): who is signed in, their colonies and each colony's
 * scoped tokens, read defensively. Every name here came from GitHub or a person and is shown as text, never as markup.
 */

/** The roles a scoped token can have. */
export type TokenRole = "agent" | "reviewer" | "owner";
export const TOKEN_ROLES: readonly TokenRole[] = ["agent", "reviewer", "owner"];

/** What each role lets its holder do, as the account page says it. */
export const ROLE_TEXT: Readonly<Record<TokenRole, string>> = {
  agent: "For an agent: join the colony, take work, read files and propose changes (the API and /mcp).",
  reviewer: "For a reviewer: approve, reject or return changes that wait for a person.",
  owner: "Everything an agent and a reviewer do, plus the colony's settings and its tokens.",
};

/** One of the person's colonies. */
export interface OwnedColony {
  id: string;
  name: string | null;
  state: "pending" | "active";
  createdAt: number;
}

/** The limits an account works within. */
export interface Limits {
  colonies: number;
  agentsPerColony: number;
  tokensPerColony: number;
  tokenDays: number;
}

/** GET /api/me, signed in or not. */
export type Me =
  | { signedIn: false; limits: Limits }
  | {
      signedIn: true;
      account: { id: string; github: { id: number; login: string; name?: string } };
      colonies: OwnedColony[];
      /** Whether the account's Cloudflare connection exists, as the server knows it. */
      cloudflare: "connected" | "not-connected" | "unknown";
      limits: Limits;
    };

/** A scoped token as the API lists it (never its secret). */
export interface TokenView {
  id: string;
  role: TokenRole;
  label: string;
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
  live: boolean;
}

const DEFAULT_LIMITS: Limits = { colonies: 3, agentsPerColony: 20, tokensPerColony: 20, tokenDays: 30 };

function obj(x: unknown): Record<string, unknown> | null {
  return x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : null;
}

function str(x: unknown, max = 200): string | null {
  return typeof x === "string" && x.length <= max ? x : null;
}

function num(x: unknown): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

function limitsOf(x: unknown): Limits {
  const o = obj(x);
  if (!o) return DEFAULT_LIMITS;
  const pick = (k: keyof Limits) => {
    const v = num(o[k]);
    return v !== null && v > 0 ? v : DEFAULT_LIMITS[k];
  };
  return { colonies: pick("colonies"), agentsPerColony: pick("agentsPerColony"), tokensPerColony: pick("tokensPerColony"), tokenDays: pick("tokenDays") };
}

/** GET /api/me's answer, or null when it is not one. */
export function parseMe(x: unknown): Me | null {
  const o = obj(x);
  if (!o || typeof o.signedIn !== "boolean") return null;
  const limits = limitsOf(o.limits);
  if (!o.signedIn) return { signedIn: false, limits };
  const account = obj(o.account);
  const github = obj(account?.github);
  const id = str(account?.id, 100);
  const login = str(github?.login, 39);
  const ghId = num(github?.id);
  if (!id || !login || ghId === null) return null;
  const name = str(github?.name, 100);
  const colonies = (Array.isArray(o.colonies) ? o.colonies : []).flatMap((c): OwnedColony[] => {
    const r = obj(c);
    const cid = str(r?.id, 48);
    if (!r || !cid) return [];
    return [{ id: cid, name: str(r.name), state: r.state === "pending" ? "pending" : "active", createdAt: num(r.createdAt) ?? 0 }];
  });
  const cloudflare = o.cloudflare === "connected" || o.cloudflare === "not-connected" ? o.cloudflare : "unknown";
  return { signedIn: true, account: { id, github: { id: ghId, login, ...(name ? { name } : {}) } }, colonies, cloudflare, limits };
}

/** A token list's entries, each read field by field; entries that do not read are left out. */
export function parseTokens(x: unknown): TokenView[] {
  const list = obj(x)?.tokens;
  return (Array.isArray(list) ? list : []).flatMap((t): TokenView[] => {
    const r = obj(t);
    const id = str(r?.id, 100);
    const role = r?.role;
    if (!r || !id || (role !== "agent" && role !== "reviewer" && role !== "owner")) return [];
    return [
      {
        id,
        role,
        label: str(r.label) ?? "",
        createdAt: num(r.createdAt) ?? 0,
        expiresAt: num(r.expiresAt) ?? 0,
        lastUsedAt: num(r.lastUsedAt),
        revokedAt: num(r.revokedAt),
        live: r.live === true,
      },
    ];
  });
}

/** What the account page says after a sign-in round trip (?signin=). Null for no outcome or one it does not know. */
export function signinText(outcome: string | null): string | null {
  switch (outcome) {
    case "unavailable":
      return "Sign-in is not set up on this deployment yet. The operator has to configure GitHub sign-in.";
    case "expired":
      return "That sign-in took too long or did not start here, so it was stopped. Sign in again.";
    case "denied":
      return "GitHub said you declined the sign-in. Sign in again when you are ready.";
    case "github":
      return "GitHub did not finish the sign-in. Try again in a minute.";
    default:
      return null;
  }
}

/** "Oct 19, 2026" in the reader's time zone, for lists. */
export function shortDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

/** A token's state in words: live until a date, expired on one, or revoked on one. */
export function tokenState(t: TokenView, now: number): string {
  if (t.revokedAt !== null) return `revoked ${shortDate(t.revokedAt)}`;
  if (t.expiresAt <= now) return `expired ${shortDate(t.expiresAt)}`;
  return `live until ${shortDate(t.expiresAt)}`;
}

/** The person's name as the page shows it: "Ada Lovelace (@ada)", or "@ada" without a name. */
export function whoText(github: { login: string; name?: string }): string {
  return github.name ? `${github.name} (@${github.login})` : `@${github.login}`;
}

/** The error sentence of an API answer, or a plain one when it has none. */
export async function errorOf(res: Response): Promise<string> {
  try {
    const body = obj(await res.json());
    const e = str(body?.error, 2_000);
    if (e) return e;
  } catch {
    // Not JSON.
  }
  return `The server answered ${res.status}. Try again.`;
}

/** A JSON request to the accounts API from this page (same origin, so the session cookie and the Origin header go with it). */
export async function send(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(path, {
    method,
    credentials: "same-origin",
    headers: { accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
