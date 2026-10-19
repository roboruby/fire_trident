import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { z } from "zod";
import type { Id, RepoRef, Sha } from "@fire_trident/core";
import type { Env } from "../env.ts";
import { decodeError, ftError } from "../colony/errors.ts";
import { slug } from "../colony/logic.ts";
import { createColony, requireAdminStrict } from "../api/app.ts";
import { isUnsupportedRpc, messageOf } from "../api/logic.ts";
import { UPGRADING, deleteColony } from "../api/ops.ts";
import { tokensEqual } from "../api/token.ts";
import { publicColonies } from "../api/git-proxy.ts";
import { hasWorkersAi } from "../cloudflare/config.ts";
import { MODELS_OFF } from "../cloudflare/models.ts";
import { newId } from "../ids.ts";
import { accountsStub, type AccountsRpc } from "./client.ts";
import { accountsOn, publicOrigin, sessionKey, signInConfig } from "./config.ts";
import { OAUTH_COOKIE, SIGNIN_PATH, SIGNUP_COOKIE, clearCookie, readCookie, setCookie } from "./cookies.ts";
import { base64url, open, pkceChallenge, randomBytes, seal, sha256Hex } from "./crypto.ts";
import { GithubSignInError, authorizeUrl, cleanName, githubIdentity, identityOf, type GithubFetch } from "./github.ts";
import {
  DAY_MS,
  INVITE_DEFAULT_DAYS,
  INVITE_MAX_DAYS,
  INVITE_MAX_USES,
  MAX_AGENTS_PER_COLONY,
  MAX_COLONIES_PER_ACCOUNT,
  MAX_LIVE_TOKENS_PER_COLONY,
  OAUTH_TTL_MS,
  SIGNUP_TTL_MS,
  TOKEN_MAX_DAYS,
} from "./limits.ts";
import { CROSS_SITE, bearerOf, sameSite, tokenRefusal } from "./scope.ts";
import { endSessionCookie, newSession, sessionAccount, sessionHash } from "./session.ts";
import { ROLE_WORDS, isScopedToken, newInviteCode, newScopedToken, normalizedInvite } from "./tokens.ts";
import { TOKEN_ROLES, type Account, type AccountId, type CloudflareGrant, type GithubIdentity } from "./types.ts";

/**
 * The accounts routes (FT_ACCOUNTS), mounted by index.ts before the API. While the flag is off each one answers 404
 * exactly as an unknown route does, and nothing reads the accounts object.
 *
 *   GET    /auth/github/start                   send the browser to GitHub to sign in (state and PKCE in a sealed cookie)
 *   GET    /auth/github/callback                GitHub's answer: an account signs in; a new person is asked for an invite code
 *   GET    /auth/github/pending                 the GitHub login waiting for an invite code (the account page shows it)
 *   POST   /auth/github/invite                  { code }: open the account with an invite code and sign in
 *   POST   /auth/logout                         end the session
 *   GET    /api/me                              who is signed in, their colonies and the limits
 *   POST   /api/me/colonies                     { name, source?, regionDepth? }: create a colony the account owns
 *   DELETE /api/me/colonies/:id                 delete a colony the account owns: its repositories in the owner's storage, its objects, its tokens
 *   GET    /api/me/colonies/:id/tokens          the colony's scoped tokens, without secrets
 *   POST   /api/me/colonies/:id/tokens          { role, label, days? }: mint one, its secret shown once
 *   DELETE /api/me/colonies/:id/tokens/:tid     revoke one
 *   POST   /api/accounts/invites                { uses?, days?, note? }: the operator mints an invite code, shown once (admin token)
 *   GET    /api/accounts/invites                the invite codes, without the codes (admin token)
 *   DELETE /api/accounts/invites/:iid           end an invite code now (admin token)
 *
 * State-changing routes a browser calls with the session cookie check the Origin header against FT_PUBLIC_URL. The
 * token routes also take a bearer token scoped to the colony with the owner role.
 */

/** What the routes call outside the accounts module: wired by index.ts, faked by the tests. */
export interface AccountsDeps {
  /**
   * Provision an owned colony's trunk on its owner's storage (the colony storage module's storageFor). Absent, creating
   * an owned colony is refused: it is never provisioned on the deployment's own storage.
   */
  provisionOwned?: (env: Env, colonyId: Id, owner: AccountId, source?: { url: string; branch?: string }) => Promise<{ trunk: RepoRef; trunkSha: Sha }>;
  /** The account's Cloudflare connection (the Cloudflare module's cloudflareGrantFor). Absent, nobody counts as connected. */
  grantFor?: (env: Env, account: AccountId) => Promise<CloudflareGrant | null>;
  /** The fetch that reaches GitHub (tests pass a fake GitHub). */
  fetch?: GithubFetch;
  now?: () => number;
}

type AccountsContext = Context<{ Bindings: Env }>;

/** The HKDF purposes of the two sealed sign-in cookies. */
const OAUTH_PURPOSE = "firetrident github oauth state v1";
const SIGNUP_PURPOSE = "firetrident signup v1";

/** Where the account page lives, and the sign-in outcomes it explains (?signin=). */
const ACCOUNT_PAGE = "/account";
export const SIGNIN_OUTCOMES = ["unavailable", "expired", "denied", "github", "invite"] as const;
export type SigninOutcome = (typeof SIGNIN_OUTCOMES)[number];

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
}

/** The answer of a route that does not exist: what the API's own catch-all says, and what every accounts route says while the flag is off. */
function noRoute(c: AccountsContext): Response {
  return json({ error: `no route for ${c.req.method} ${c.req.path}` }, 404);
}

/** A redirect that sets cookies (each its own Set-Cookie line) and keeps the URL it came from out of any Referer. */
function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ location, "cache-control": "no-store", "referrer-policy": "no-referrer" });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 302, headers });
}

/** JSON with Set-Cookie lines. */
function jsonWithCookies(body: unknown, status: number, cookies: string[]): Response {
  const res = json(body, status);
  for (const cookie of cookies) res.headers.append("set-cookie", cookie);
  return res;
}

/** The account page with a sign-in outcome (?signin=), on FT_PUBLIC_URL's origin when it has one. */
function accountPage(env: Partial<Env>, outcome?: SigninOutcome): string {
  const base = `${publicOrigin(env) ?? ""}${ACCOUNT_PAGE}`;
  return outcome ? `${base}?signin=${outcome}` : base;
}

/** Parse a JSON body against a schema; a 400 with the first issues otherwise. */
async function body<S extends z.ZodType>(c: AccountsContext, schema: S): Promise<z.output<S>> {
  let raw: unknown;
  try {
    const text = await c.req.text();
    raw = text.trim() === "" ? {} : JSON.parse(text);
  } catch {
    throw ftError(400, "The body must be JSON.");
  }
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.map(String).join(".") || "body"}: ${i.message}`);
  throw ftError(400, `invalid request: ${issues.join("; ")}`);
}

/** A label or note: control characters out, spaces folded. */
const Text = (max: number) =>
  z
    .string()
    .transform((s) => cleanName(s) ?? "")
    .pipe(z.string().max(max));

const InviteCodeBody = z.object({ code: z.string().max(200) });
const OwnedColonyBody = z.object({
  name: z.string().trim().min(1).max(200),
  source: z
    .object({
      url: z
        .string()
        .trim()
        .max(2048)
        .refine((u) => /^https:\/\/[^\s]+$/i.test(u) && URL.canParse(u), { message: "the repository must be a public https:// git URL" }),
      branch: z.string().trim().min(1).max(255).optional(),
    })
    .optional(),
  regionDepth: z.number().int().min(1).max(8).optional(),
});
const MintTokenBody = z.object({
  role: z.enum(TOKEN_ROLES as [string, ...string[]]),
  label: Text(80).pipe(z.string().min(1, "a label says what the token is for, such as the agent or the person using it")),
  days: z.number().int().min(1).max(TOKEN_MAX_DAYS).default(TOKEN_MAX_DAYS),
});
const MintInviteBody = z.object({
  uses: z.number().int().min(1).max(INVITE_MAX_USES).default(1),
  days: z.number().int().min(1).max(INVITE_MAX_DAYS).default(INVITE_DEFAULT_DAYS),
  note: Text(200).default(""),
});

/** Colony ids as the API takes them. */
const COLONY_ID = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
const OBJECT_ID = /^[A-Za-z0-9_-]{1,100}$/;

function colonyParam(c: AccountsContext): Id {
  const id = c.req.param("id") ?? "";
  if (!COLONY_ID.test(id)) throw ftError(404, "There is no colony by that id.");
  return id;
}

/** The accounts object, or a 503 when this deployment has no ACCOUNTS binding. */
function stubOf(env: Env): AccountsRpc {
  const stub = accountsStub(env);
  if (!stub) throw ftError(503, "Accounts are on (FT_ACCOUNTS) but this deployment has no ACCOUNTS binding; the operator has to add it.");
  return stub;
}

/** The limits a person sees on the account page. */
export const LIMITS = {
  colonies: MAX_COLONIES_PER_ACCOUNT,
  agentsPerColony: MAX_AGENTS_PER_COLONY,
  tokensPerColony: MAX_LIVE_TOKENS_PER_COLONY,
  tokenDays: TOKEN_MAX_DAYS,
} as const;

/** Who may manage a colony's tokens: its owner signed in, or an owner token of that colony (whose expiry bounds new tokens). */
type TokenManager = { accountId: AccountId; bound: number | null };

/**
 * The owner of a colony managing its tokens: by session (with the Origin check on a write) or by a bearer token scoped to
 * the colony with the owner role. Throws the refusal otherwise.
 */
async function tokenManager(c: AccountsContext, stub: AccountsRpc, colonyId: Id, now: number, write: boolean): Promise<TokenManager> {
  const bearer = bearerOf(c.req.header("authorization"));
  if (bearer !== null) {
    if (!isScopedToken(bearer)) throw ftError(401, "Manage tokens with your session on the account page, or with an owner token of this colony.");
    const check = await stub.checkToken(await sha256Hex(bearer), now);
    const refused = tokenRefusal(check, colonyId, "owner");
    if (refused || !check) throw ftError(refused?.status ?? 403, refused?.error ?? "This token cannot manage tokens.");
    return { accountId: check.accountId, bound: check.token.expiresAt };
  }
  const account = await sessionAccount(c, now);
  if (!account) throw ftError(401, "Sign in first: only a colony's owner manages its tokens.");
  if ((await stub.ownerOf(colonyId)) !== account.id) throw ftError(403, `Colony ${colonyId} is not yours: only its owner manages its tokens.`);
  if (write && !sameSite(c.env, c.req.header("origin"))) throw ftError(403, CROSS_SITE);
  return { accountId: account.id, bound: null };
}

/** The signed-in account for a browser write (session and Origin both checked). */
async function signedIn(c: AccountsContext, now: number): Promise<Account> {
  const account = await sessionAccount(c, now);
  if (!account) throw ftError(401, "Sign in first: go to the account page and sign in with GitHub.");
  if (!sameSite(c.env, c.req.header("origin"))) throw ftError(403, CROSS_SITE);
  return account;
}

/** The sentence a refused invite code gets. */
const INVITE_REFUSED: Record<"invalid" | "used" | "expired", string> = {
  invalid: "That invite code is not one FireTrident knows. Check it for typos, or ask whoever invited you for another.",
  used: "That invite code has been used as many times as it allows. Ask whoever invited you for another.",
  expired: "That invite code has expired. Ask whoever invited you for another.",
};

/** The sentence for a person with no Cloudflare connection who tries to create a colony. */
export const CONNECT_FIRST =
  "Connect your Cloudflare account first: a colony's repositories and model calls run on your own Cloudflare account, so FireTrident cannot create one until it is connected (Connect Cloudflare, on this page).";

/** Build the accounts routes. */
export function accountsApp(deps: AccountsDeps = {}): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  const now = deps.now ?? Date.now;
  const fetcher: GithubFetch = deps.fetch ?? ((url, init) => fetch(url, init));

  app.onError((err, c) => {
    if (isUnsupportedRpc(err)) return json({ error: `${UPGRADING} (${messageOf(err)})` }, 503, { "Retry-After": "30" });
    const { status, message } = decodeError(err);
    if (status >= 500) console.error(`${c.req.method} ${c.req.path} failed: ${message}`);
    return json({ error: message }, status);
  });

  /** Every handler answers 404 while accounts are off. */
  type Handler = (c: AccountsContext) => Promise<Response> | Response;
  const on =
    (h: Handler): Handler =>
    (c) =>
      accountsOn(c.env) ? h(c) : noRoute(c);

  // Sign in with GitHub: a fresh state and PKCE verifier, sealed in a short cookie scoped to /auth/github.
  app.get(
    "/auth/github/start",
    on(async (c) => {
      const cfg = signInConfig(c.env);
      if ("missing" in cfg) {
        console.warn(`accounts: ${cfg.missing}`);
        return redirect(accountPage(c.env, "unavailable"));
      }
      const state = base64url(randomBytes(32));
      const verifier = base64url(randomBytes(32));
      const sealed = await seal({ s: state, v: verifier }, now() + OAUTH_TTL_MS, cfg.sessionKey, OAUTH_PURPOSE);
      return redirect(authorizeUrl(cfg, state, await pkceChallenge(verifier)), [setCookie(OAUTH_COOKIE, sealed, SIGNIN_PATH, OAUTH_TTL_MS / 1000)]);
    }),
  );

  app.get(
    "/auth/github/callback",
    on(async (c) => {
      const cfg = signInConfig(c.env);
      const clearState = clearCookie(OAUTH_COOKIE, SIGNIN_PATH);
      if ("missing" in cfg) return redirect(accountPage(c.env, "unavailable"), [clearState]);
      if (c.req.query("error") !== undefined) return redirect(accountPage(c.env, "denied"), [clearState]);
      const at = now();
      const sealed = readCookie(c.req.header("cookie"), OAUTH_COOKIE);
      const kept = sealed ? await open(sealed, at, cfg.sessionKey, OAUTH_PURPOSE) : null;
      const state = c.req.query("state") ?? "";
      const code = c.req.query("code") ?? "";
      if (!kept || typeof kept.s !== "string" || typeof kept.v !== "string" || state === "" || code === "" || code.length > 512 || !(await tokensEqual(state, kept.s))) {
        return redirect(accountPage(c.env, "expired"), [clearState]);
      }
      let who: GithubIdentity;
      try {
        who = await githubIdentity(cfg, code, kept.v, fetcher);
      } catch (e) {
        if (!(e instanceof GithubSignInError)) console.error(`accounts: GitHub sign-in failed: ${messageOf(e)}`);
        return redirect(accountPage(c.env, "github"), [clearState]);
      }
      const stub = stubOf(c.env);
      const session = await newSession(cfg.sessionKey, at);
      const account = await stub.signIn(who, session.hash, session.expiresAt, at);
      if (account) return redirect(accountPage(c.env), [clearState, clearCookie(SIGNUP_COOKIE, SIGNIN_PATH), session.cookie]);
      // A new person: who GitHub said they are waits, sealed, for an invite code.
      const signup = await seal({ gh: who }, at + SIGNUP_TTL_MS, cfg.sessionKey, SIGNUP_PURPOSE);
      return redirect(accountPage(c.env, "invite"), [clearState, setCookie(SIGNUP_COOKIE, signup, SIGNIN_PATH, SIGNUP_TTL_MS / 1000)]);
    }),
  );

  /** The GitHub identity a sign-up cookie carries, when it opens and has not expired. */
  const pendingSignup = async (c: AccountsContext, at: number): Promise<GithubIdentity | null> => {
    const key = sessionKey(c.env);
    const sealed = readCookie(c.req.header("cookie"), SIGNUP_COOKIE);
    if (!key || !sealed) return null;
    const kept = await open(sealed, at, key, SIGNUP_PURPOSE);
    return kept ? identityOf(kept.gh) : null;
  };

  app.get(
    "/auth/github/pending",
    on(async (c) => {
      const who = await pendingSignup(c, now());
      if (!who) return json({ error: "No sign-up is waiting for an invite code. Sign in with GitHub first." }, 404);
      return json({ github: { login: who.login, ...(who.name ? { name: who.name } : {}) } });
    }),
  );

  app.post(
    "/auth/github/invite",
    on(async (c) => {
      if (!sameSite(c.env, c.req.header("origin"))) return json({ error: CROSS_SITE }, 403);
      const key = sessionKey(c.env);
      if (!key) return json({ error: "Sign-in is not set up on this deployment: the operator has to set FT_SESSION_KEY." }, 503);
      const at = now();
      const who = await pendingSignup(c, at);
      if (!who) return json({ error: "Your sign-up waited too long or was not started here. Sign in with GitHub again, then enter the code." }, 401);
      const b = await body(c, InviteCodeBody);
      const code = normalizedInvite(b.code);
      if (!code) return json({ error: INVITE_REFUSED.invalid }, 403);
      const session = await newSession(key, at);
      const res = await stubOf(c.env).redeemInvite(await sha256Hex(code), who, session.hash, session.expiresAt, at);
      if (!res.ok) return json({ error: INVITE_REFUSED[res.why] }, 403);
      return jsonWithCookies({ ok: true, created: res.created, account: { id: res.account.id, github: res.account.github } }, res.created ? 201 : 200, [
        clearCookie(SIGNUP_COOKIE, SIGNIN_PATH),
        session.cookie,
      ]);
    }),
  );

  app.post(
    "/auth/logout",
    on(async (c) => {
      if (!sameSite(c.env, c.req.header("origin"))) return json({ error: CROSS_SITE }, 403);
      const hash = await sessionHash(c.env, c.req.header("cookie"));
      const stub = accountsStub(c.env);
      if (hash && stub) await stub.endSession(hash, now());
      return jsonWithCookies({ ok: true }, 200, [endSessionCookie()]);
    }),
  );

  app.get(
    "/api/me",
    on(async (c) => {
      const account = await sessionAccount(c, now());
      if (!account) return json({ signedIn: false, limits: LIMITS });
      const owned = await stubOf(c.env).coloniesOf(account.id);
      const colonies = await Promise.all(
        owned.map(async (o) => {
          let name: string | null = null;
          if (o.state === "active") {
            try {
              name = (await c.env.COLONY.get(c.env.COLONY.idFromName(o.colonyId)).getColony())?.name ?? null;
            } catch {
              name = null;
            }
          }
          return { id: o.colonyId, name, state: o.state, createdAt: o.createdAt };
        }),
      );
      let cloudflare: "connected" | "not-connected" | "unknown" = "unknown";
      // A connection without Workers AI: the account's colonies run without in-platform agents and model review, and the
      // page says so (cloudflare/models.ts).
      let modelsOff: string | null = null;
      if (deps.grantFor) {
        try {
          const grant = await deps.grantFor(c.env, account.id);
          cloudflare = grant ? "connected" : "not-connected";
          if (grant && !hasWorkersAi(grant.scopes)) modelsOff = MODELS_OFF.no_workers_ai;
        } catch {
          cloudflare = "unknown";
        }
      }
      return json({
        signedIn: true,
        account: { id: account.id, github: account.github, createdAt: account.createdAt },
        colonies,
        cloudflare,
        ...(modelsOff ? { modelsOff } : {}),
        limits: LIMITS,
      });
    }),
  );

  app.post(
    "/api/me/colonies",
    on(async (c) => {
      const at = now();
      const account = await signedIn(c, at);
      const b = await body(c, OwnedColonyBody);
      const colonyId = slug(b.name);
      if (!colonyId) throw ftError(400, "A colony name needs letters or digits.");
      const grant = deps.grantFor ? await deps.grantFor(c.env, account.id) : null;
      if (!grant) throw ftError(409, CONNECT_FIRST);
      const provision = deps.provisionOwned;
      if (!provision) throw ftError(503, "Creating colonies on your own Cloudflare account is not available on this deployment yet.");
      const stub = stubOf(c.env);
      const taken = `A colony named ${colonyId} exists already. Choose another name.`;
      // The names this deployment publishes to everyone (FT_PUBLIC_GIT, FT_PUBLIC_MCP) are the operator's, whether or not they exist yet.
      if (publicColonies(c.env.FT_PUBLIC_GIT ?? "").has(colonyId) || publicColonies(c.env.FT_PUBLIC_MCP ?? "").has(colonyId)) {
        throw ftError(409, `The name ${colonyId} is kept for the operator's public colonies on this deployment. Choose another name.`);
      }
      if (await c.env.COLONY.get(c.env.COLONY.idFromName(colonyId)).getColony()) throw ftError(409, taken);
      const reserved = await stub.reserveColony(account.id, colonyId, at);
      if (!reserved.ok) {
        throw ftError(409, reserved.why === "taken" ? taken : `You own ${reserved.owned} colonies, the most an account may own (${MAX_COLONIES_PER_ACCOUNT}).`);
      }
      // Owned from before its objects exist, so each of them finds its owner (and its storage) from the start.
      let res: { status: 201 | 409; body: unknown };
      try {
        res = await createColony(c.env, (env, id, source) => provision(env, id, account.id, source), { name: b.name, ...(b.source ? { source: b.source } : {}), ...(b.regionDepth !== undefined ? { regionDepth: b.regionDepth } : {}) });
      } catch (e) {
        // Nothing was created: the name goes back. A colony that came to exist stays owned.
        const exists = await c.env.COLONY.get(c.env.COLONY.idFromName(colonyId))
          .getColony()
          .catch(() => null);
        if (exists) await stub.confirmColony(colonyId, account.id);
        else await stub.releaseColony(colonyId, now());
        throw e;
      }
      if (res.status === 409) {
        await stub.releaseColony(colonyId, now());
        throw ftError(409, taken);
      }
      await stub.confirmColony(colonyId, account.id);
      return json({ colony: res.body, owner: account.id }, 201);
    }),
  );

  // The owner deletes a colony they own, from the account page (their session and this site's Origin; never a token):
  // the same delete the operator's DELETE /api/colonies/:id runs, which sweeps the repositories from the owner's own
  // storage (artifacts/storage.ts), then the colony is nobody's and its tokens stop working.
  app.delete(
    "/api/me/colonies/:id",
    on(async (c) => {
      const colonyId = colonyParam(c);
      const account = await signedIn(c, now());
      const stub = stubOf(c.env);
      if ((await stub.ownerOf(colonyId)) !== account.id) throw ftError(403, `Colony ${colonyId} is not yours: only its owner deletes it.`);
      const report = await deleteColony(c.env, colonyId);
      if (!report.ok) {
        const failed = [...report.agents.failed.map((f) => `agent ${f.agentId}: ${f.error}`), ...report.repos.failed.map((f) => `repo ${f.repo}: ${f.error}`)];
        return json({ ...report, error: `The delete did not finish (delete again to finish it): ${failed.slice(0, 5).join("; ") || "a colony object did not clear"}.` }, 502);
      }
      await stub.releaseColony(colonyId, now());
      return json(report);
    }),
  );

  app.get(
    "/api/me/colonies/:id/tokens",
    on(async (c) => {
      const colonyId = colonyParam(c);
      const at = now();
      const stub = stubOf(c.env);
      await tokenManager(c, stub, colonyId, at, false);
      const tokens = await stub.listTokens(colonyId, at);
      return json({ colonyId, live: tokens.filter((t) => t.live).length, max: MAX_LIVE_TOKENS_PER_COLONY, roles: ROLE_WORDS, tokens });
    }),
  );

  app.post(
    "/api/me/colonies/:id/tokens",
    on(async (c) => {
      const colonyId = colonyParam(c);
      const at = now();
      const stub = stubOf(c.env);
      const who = await tokenManager(c, stub, colonyId, at, true);
      const b = await body(c, MintTokenBody);
      // A token minted with an owner token never outlives it.
      const expiresAt = Math.min(at + b.days * DAY_MS, who.bound ?? Number.POSITIVE_INFINITY);
      const secret = newScopedToken();
      const res = await stub.mintToken(
        { id: newId("tok_"), hash: await sha256Hex(secret), colonyId, accountId: who.accountId, role: b.role as (typeof TOKEN_ROLES)[number], label: b.label, expiresAt },
        at,
      );
      if (!res.ok) {
        throw ftError(
          res.why === "quota" ? 409 : 403,
          res.why === "quota" ? `Colony ${colonyId} has ${res.live} live tokens, the most a colony may have (${MAX_LIVE_TOKENS_PER_COLONY}). Revoke one first.` : `Colony ${colonyId} is not yours: only its owner mints its tokens.`,
        );
      }
      return json({ token: res.token, secret, note: "Copy the token now: FireTrident keeps only its hash and cannot show it again." }, 201);
    }),
  );

  app.delete(
    "/api/me/colonies/:id/tokens/:tid",
    on(async (c) => {
      const colonyId = colonyParam(c);
      const tokenId = c.req.param("tid") ?? "";
      if (!OBJECT_ID.test(tokenId)) throw ftError(404, "There is no such token.");
      const at = now();
      const stub = stubOf(c.env);
      await tokenManager(c, stub, colonyId, at, true);
      const token = await stub.revokeToken(colonyId, tokenId, at);
      if (!token) throw ftError(404, `Colony ${colonyId} has no token ${tokenId}.`);
      return json({ ok: true, token });
    }),
  );

  // The operator's invite codes: the admin token only, never opened by FT_OPEN_WRITES (api/app.ts requireAdminStrict).
  const admin: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => (accountsOn(c.env) ? requireAdminStrict(c, next) : noRoute(c));
  app.post("/api/accounts/invites", admin, async (c) => {
    const b = await body(c, MintInviteBody);
    const at = now();
    const code = newInviteCode();
    const invite = await stubOf(c.env).mintInvite({ id: newId("inv_"), hash: await sha256Hex(code), uses: b.uses, expiresAt: at + b.days * DAY_MS, note: b.note }, at);
    return json({ invite, code, note: "Copy the code now: FireTrident keeps only its hash and cannot show it again." }, 201);
  });

  app.get("/api/accounts/invites", admin, async (c) => {
    return json({ invites: await stubOf(c.env).listInvites(now()) });
  });

  app.delete("/api/accounts/invites/:iid", admin, async (c) => {
    const id = c.req.param("iid") ?? "";
    const invite = OBJECT_ID.test(id) ? await stubOf(c.env).revokeInvite(id, now()) : null;
    if (!invite) throw ftError(404, "There is no such invite code.");
    return json({ ok: true, invite });
  });

  return app;
}
