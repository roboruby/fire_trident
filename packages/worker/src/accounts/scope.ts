import type { Context } from "hono";
import { routePath } from "hono/route";
import type { Id } from "@fire_trident/core";
import type { Env } from "../env.ts";
import { bearerMatches } from "../api/token.ts";
import type { ApproverWho } from "../decide/receipt.ts";
import { accountsStub } from "./client.ts";
import { accountsOn, publicOrigin } from "./config.ts";
import { sha256Hex } from "./crypto.ts";
import { MAX_AGENTS_PER_COLONY } from "./limits.ts";
import { sessionHash } from "./session.ts";
import type { TokenCheck } from "./store.ts";
import { isScopedToken, roleAllows, roleRefusal } from "./tokens.ts";
import type { Account, Capability, TokenRole } from "./types.ts";

/**
 * Writes on owned colonies (FT_ACCOUNTS). The API's write check (api/app.ts requireAdmin) asks `accountWrite` first: on
 * a colony a person owns, a write goes through with a token scoped to that colony whose role covers the route, or with
 * the owner's own session from the site (its Origin checked against FT_PUBLIC_URL). Anything else gets null and goes on
 * to the admin token exactly as before, so the deployment's admin token keeps working everywhere and an operator colony
 * never takes a scoped token or a session. A scoped token that does not fit (another colony, an operator colony, a role
 * that does not cover the route, revoked or expired) is refused here with a sentence saying why.
 */

/**
 * What each colony route a scoped token or the owner's session may reach needs (paths as the API registers them, under
 * /api). A route that is not listed takes only the admin token: deleting a colony, the deployment's pause, the decide
 * policy and vaccination, Agent2Agent and anything added later.
 */
export const ROUTE_NEEDS: Readonly<Record<string, Capability>> = {
  // An agent's work, as an outside agent does it over the API.
  "POST /colonies/:id/agents": "agent",
  "POST /colonies/:id/agents/:aid/take": "agent",
  "POST /colonies/:id/agents/:aid/heartbeat": "agent",
  "POST /colonies/:id/agents/:aid/status": "agent",
  "GET /colonies/:id/agents/:aid/inbox": "agent",
  "POST /colonies/:id/proposals": "agent",
  // Review decisions.
  "POST /colonies/:id/review/:pid": "review",
  "POST /colonies/:id/review/batches/decide": "review",
  "POST /colonies/:id/proposals/:pid/tests": "review",
  "POST /colonies/:id/audit/:pid": "review",
  // The owner's direction and settings.
  "POST /colonies/:id/intents": "owner",
  "PATCH /colonies/:id/intents/:iid": "owner",
  "POST /colonies/:id/intents/:iid/withdraw": "owner",
  "POST /colonies/:id/intents/:iid/escalation": "owner",
  "POST /colonies/:id/rules": "owner",
  "DELETE /colonies/:id/rules/:rid": "owner",
  "POST /colonies/:id/agents/:aid/stop": "owner",
  "POST /colonies/:id/agents/:aid/directive": "owner",
  "POST /colonies/:id/swarm": "owner",
  "POST /colonies/:id/swarm/stop": "owner",
  "POST /colonies/:id/landings/:ref/revert": "owner",
  "POST /colonies/:id/certify": "owner",
  "POST /colonies/:id/certify/policy": "owner",
  "POST /colonies/:id/guide/:lessonId": "owner",
  "POST /colonies/:id/megafile": "owner",
  "POST /colonies/:id/pause": "owner",
  "POST /colonies/:id/resume": "owner",
  "POST /colonies/:id/spend-cap": "owner",
  "POST /colonies/:id/commit-author": "owner",
  "POST /colonies/:id/silent-ttl": "owner",
  "POST /colonies/:id/recipes": "owner",
  "POST /colonies/:id/recipes/:rid/approve": "owner",
  "POST /colonies/:id/issues/import": "owner",
  "POST /colonies/:id/canaries": "owner",
};

/** The route that starts in-platform agents, whose count an owned colony caps (MAX_AGENTS_PER_COLONY). */
const SWARM_ROUTE = "POST /colonies/:id/swarm";

/** Who a write on an owned colony went through as. */
export type Principal =
  | { kind: "token"; tokenId: Id; role: TokenRole; accountId: string; colonyId: Id }
  | { kind: "session"; account: Account; colonyId: Id };

/** Each request's principal, for the routes that record who acted (the review routes' approver). */
const principals = new WeakMap<Request, Principal>();

/** Who an allowed write on an owned colony went through as (undefined for the admin token and everything else). */
export function principalOf(req: Request): Principal | undefined {
  return principals.get(req);
}

/** What the check may stand in for (tests): the clock, and how many in-platform agents a colony runs now. */
export interface ScopeDeps {
  now?: () => number;
  inPlatformAgents?: (env: Env, colonyId: Id) => Promise<number>;
}

type ApiContext = Context<{ Bindings: Env }>;

function refuse(status: number, error: string): Response {
  const headers: Record<string, string> = { "content-type": "application/json; charset=utf-8" };
  if (status === 401) headers["WWW-Authenticate"] = "Bearer";
  return new Response(JSON.stringify({ error }), { status, headers });
}

/** The bearer token of an Authorization header, or null. */
export function bearerOf(header: string | null | undefined): string | null {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "");
  return m ? (m[1] ?? null) : null;
}

/** Whether a browser request's Origin is FT_PUBLIC_URL's (state-changing routes a browser calls with a cookie need it). */
export function sameSite(env: Partial<Pick<Env, "FT_PUBLIC_URL">>, origin: string | null | undefined): boolean {
  const expected = publicOrigin(env);
  return expected !== null && typeof origin === "string" && origin === expected;
}

/** The sentence a cross-site write gets. */
export const CROSS_SITE = "This request did not come from FireTrident's own pages (its Origin is not this site), so it was refused. Use the account page.";

/** "2026-10-19 14:05 UTC". */
function when(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * Why a presented scoped token may not do this (null: it may): unknown, revoked, expired, for another colony, on a
 * colony its account no longer owns, on a route no token may use, or a role that does not cover the route.
 */
export function tokenRefusal(check: TokenCheck | null, colonyId: Id | undefined, need: Capability | undefined): { status: number; error: string } | null {
  if (!check) return { status: 401, error: "This token is not one FireTrident minted (or it was mistyped). Mint a token on your account page." };
  const t = check.token;
  if (t.revokedAt !== null) return { status: 401, error: `This token was revoked at ${when(t.revokedAt)}. Mint a new one on your account page.` };
  if (!t.live) return { status: 401, error: `This token expired at ${when(t.expiresAt)}. Mint a new one on your account page.` };
  if (!colonyId || colonyId !== t.colonyId) {
    return { status: 403, error: `This token is for colony ${t.colonyId} only, so it cannot act ${colonyId ? `on colony ${colonyId}` : "outside that colony"}.` };
  }
  if (check.owner === null) return { status: 403, error: `Colony ${t.colonyId} is not owned by anyone now, so tokens minted for it no longer work.` };
  if (check.owner !== check.accountId) return { status: 403, error: `Colony ${t.colonyId} is no longer owned by the account that minted this token, so the token no longer works.` };
  if (!need) return { status: 403, error: "A scoped token cannot do this: it takes the operator's admin token." };
  if (!roleAllows(t.role, need)) return { status: 403, error: roleRefusal(t.role, need) };
  return null;
}

/** "POST /colonies/:id/review/:pid": the method and the route's path as the API registers it (without /api). */
function routeKey(c: ApiContext): string {
  return `${c.req.method} ${routePath(c).replace(/^\/api(?=\/)/, "")}`;
}

/** In-platform agents (internal and synthetic, not stopped) a colony runs now. */
async function liveAgents(env: Env, colonyId: Id): Promise<number> {
  const stub = env.COLONY.get(env.COLONY.idFromName(colonyId)) as unknown as { listAgents(o: { kinds: string[] }): Promise<unknown[]> };
  return (await stub.listAgents({ kinds: ["internal", "synthetic"] })).length;
}

/** The swarm route's refusal past MAX_AGENTS_PER_COLONY, or null. An unreadable body is left to the route to refuse. */
async function swarmRefusal(c: ApiContext, colonyId: Id, deps: ScopeDeps): Promise<Response | null> {
  let asked = 1;
  try {
    const b = JSON.parse(await c.req.text()) as { count?: unknown; agents?: unknown };
    const n = typeof b?.count === "number" ? b.count : typeof b?.agents === "number" ? b.agents : 1;
    if (Number.isFinite(n)) asked = Math.max(1, Math.floor(n));
  } catch {
    return null;
  }
  const running = await (deps.inPlatformAgents ?? liveAgents)(c.env, colonyId);
  if (running + asked <= MAX_AGENTS_PER_COLONY) return null;
  const room = Math.max(0, MAX_AGENTS_PER_COLONY - running);
  return refuse(
    409,
    `This colony runs ${running} in-platform agents and a colony you own may run at most ${MAX_AGENTS_PER_COLONY} at once, so ${room === 0 ? "none can start now" : `at most ${room} more can start`}. Stop some first, or start fewer.`,
  );
}

/**
 * The accounts part of the API's write check. "allow": a scoped token or the owner's session may do this on this owned
 * colony. A Response: a scoped token that may not, refused. Null: not a request for accounts (flag off, no scoped token
 * and no owner's session for an owned colony), so the admin token decides as before.
 */
export async function accountWrite(c: ApiContext, deps: ScopeDeps = {}): Promise<"allow" | Response | null> {
  const env = c.env;
  if (!accountsOn(env)) return null;
  const stub = accountsStub(env);
  if (!stub) return null;
  const now = (deps.now ?? Date.now)();
  const key = routeKey(c);
  const need = ROUTE_NEEDS[key];
  const colonyId = c.req.param("id");
  const bearer = bearerOf(c.req.header("authorization"));
  if (bearer !== null) {
    if (!isScopedToken(bearer)) return null;
    if (env.FT_ADMIN_TOKEN && (await bearerMatches(bearer, env.FT_ADMIN_TOKEN))) return null;
    const check = await stub.checkToken(await sha256Hex(bearer), now);
    const refused = tokenRefusal(check, colonyId, need);
    if (refused || !check || !colonyId) return refuse(refused?.status ?? 403, refused?.error ?? "This token cannot do this.");
    if (key === SWARM_ROUTE) {
      const over = await swarmRefusal(c, colonyId, deps);
      if (over) return over;
    }
    principals.set(c.req.raw, { kind: "token", tokenId: check.token.id, role: check.token.role, accountId: check.accountId, colonyId });
    return "allow";
  }
  // No bearer: the owner's own session, from the site, on a colony the account owns.
  if (!need || !colonyId) return null;
  const hash = await sessionHash(env, c.req.header("cookie"));
  if (!hash) return null;
  const account = await stub.sessionAccount(hash, now);
  if (!account || (await stub.ownerOf(colonyId)) !== account.id) return null;
  // Writes need this site's Origin; a read (an agent's inbox) has no Origin to check and changes nothing.
  if (c.req.method !== "GET" && !sameSite(env, c.req.header("origin"))) return refuse(403, CROSS_SITE);
  if (key === SWARM_ROUTE) {
    const over = await swarmRefusal(c, colonyId, deps);
    if (over) return over;
  }
  principals.set(c.req.raw, { kind: "session", account, colonyId });
  return "allow";
}

/**
 * The approver a review decision records when the owner decided from their own session: `github:<login>`, verified by
 * the GitHub sign-in. Null for every other request (the admin token, a scoped token, accounts off), which records its
 * approver as before (api/access.ts).
 */
export function accountApprover(req: Request, stated: string | undefined): ApproverWho | null {
  const p = principals.get(req);
  if (!p || p.kind !== "session") return null;
  const by = `github:${p.account.github.login}`;
  const name = typeof stated === "string" ? stated.trim().slice(0, 200) : "";
  return { by, identity: "verified", verifiedBy: "github", ...(name && name !== "human" && name !== by ? { stated: name } : {}) };
}
