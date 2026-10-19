import { describe, expect, it } from "vitest";
import type { Context } from "hono";
import type { ApiEnv } from "../../src/api/app.ts";
import { cloudflareRoutes } from "../../src/cloudflare/routes.ts";
import { ACCOUNT_A, ACCOUNT_B, ALL_SCOPES, CLIENT_SECRET, connectEnv, FakeCloudflare, NO_AI_SCOPES, PUBLIC_URL } from "./fake.ts";

/**
 * "Connect Cloudflare" end to end against the fake Cloudflare (no network): start sets a state cookie and sends the
 * person to Cloudflare with PKCE S256 and our fixed redirect URI; the callback checks the state against the cookie and
 * the signed-in account, exchanges the code with the client secret in the body and the verifier, records the scopes
 * granted and the account chosen; disconnect revokes at Cloudflare. With FT_ACCOUNTS off, every route is a 404.
 */

const ME = "acc_me";
const OTHER = "acc_other";

/** A session stand-in: the test names the signed-in account in a header (the accounts module does this for real). */
const currentAccount = async (c: Context<ApiEnv>) => {
  const id = c.req.header("x-test-account");
  return id ? { id } : null;
};

function setup(over: Record<string, unknown> = {}) {
  const clock = { now: Date.parse("2026-10-19T10:00:00Z") };
  const fake = new FakeCloudflare(clock);
  const { env, services } = connectEnv(fake, over);
  const app = cloudflareRoutes({ currentAccount });
  const req = (path: string, init: RequestInit & { account?: string | null; cookie?: string; origin?: string | null } = {}) => {
    const headers = new Headers(init.headers);
    if (init.account !== null) headers.set("x-test-account", init.account ?? ME);
    if (init.cookie) headers.set("cookie", init.cookie);
    if (init.origin) headers.set("origin", init.origin);
    return app.request(`https://worker.internal${path}`, { ...init, headers }, env);
  };
  /** Start, consent on the fake Cloudflare with `granted`, and come back; returns the callback's answer. */
  const connect = async (granted = ALL_SCOPES, account = ME) => {
    const start = await req("/auth/cloudflare/start", { account });
    const location = start.headers.get("location") ?? "";
    const cookie = (start.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const { code, state } = fake.authorize(location, granted);
    const back = await req(`/auth/cloudflare/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`, { account, cookie });
    return { start, back, cookie, code, state };
  };
  const status = async (account = ME) => (await (await req("/api/me/cloudflare", { account })).json()) as Record<string, unknown>;
  return { clock, fake, env, services, app, req, connect, status };
}

describe("GET /auth/cloudflare/start", () => {
  it("sends a signed-in person to Cloudflare's authorize endpoint with state, PKCE S256 and the fixed redirect URI", async () => {
    const t = setup();
    const res = await t.req("/auth/cloudflare/start");
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location") ?? "");
    expect(loc.origin + loc.pathname).toBe("https://dash.cloudflare.com/oauth2/auth");
    expect(loc.searchParams.get("response_type")).toBe("code");
    expect(loc.searchParams.get("client_id")).toBe("ft-test-client");
    // From FT_PUBLIC_URL, never the request's host.
    expect(loc.searchParams.get("redirect_uri")).toBe(`${PUBLIC_URL}/auth/cloudflare/callback`);
    expect(loc.searchParams.get("scope")?.split(" ")).toEqual(ALL_SCOPES);
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    expect(loc.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(res.headers.get("location")).not.toContain(CLIENT_SECRET);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^ft_cf_state=[A-Za-z0-9_-]{43};/);
    expect(cookie).toContain(`ft_cf_state=${loc.searchParams.get("state")};`);
    for (const part of ["Max-Age=600", "Path=/auth/cloudflare", "HttpOnly", "Secure", "SameSite=Lax"]) expect(cookie).toContain(part);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("refuses a person who is not signed in, and a deployment where connecting is not set up", async () => {
    const t = setup();
    expect((await t.req("/auth/cloudflare/start", { account: null })).status).toBe(401);
    const u = setup({ FT_CF_CLIENT_SECRET: undefined });
    const res = await u.req("/auth/cloudflare/start");
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe("Connecting Cloudflare is not set up on this deployment.");
    expect((await u.status()).configured).toBe(false);
    // A grant key shorter than 32 characters is not set up either.
    expect((await setup({ FT_GRANT_KEY: "short" }).req("/auth/cloudflare/start")).status).toBe(503);
  });
});

describe("GET /auth/cloudflare/callback", () => {
  it("connects with one account: client_secret_post, the PKCE verifier, the scopes granted recorded", async () => {
    const t = setup();
    const { back } = await t.connect();
    expect(back.status).toBe(302);
    expect(back.headers.get("location")).toBe(`${PUBLIC_URL}/account?cloudflare=connected`);
    // The state cookie is spent.
    expect(back.headers.get("set-cookie")).toMatch(/^ft_cf_state=;.*Max-Age=0/);
    const [exchange] = t.fake.tokenCalls();
    const form = new URLSearchParams(exchange?.body);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("client_secret")).toBe(CLIENT_SECRET);
    expect(form.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect(exchange?.url).not.toContain("secret");
    const s = await t.status();
    expect(s).toMatchObject({ configured: true, state: "connected", account: ACCOUNT_A, workersAi: true });
    expect(s.scopes).toEqual(ALL_SCOPES);
  });

  it("never shows or stores a token in the clear", async () => {
    const t = setup();
    await t.connect();
    const tokens = [...t.fake.tokens.keys()];
    expect(tokens.length).toBe(2);
    const text = JSON.stringify(await t.status());
    const rows = JSON.stringify(t.services.get(ME)?.db.prepare("SELECT * FROM cf_grants").all());
    for (const tok of tokens) {
      expect(text).not.toContain(tok);
      expect(rows).not.toContain(tok);
    }
    expect(rows).toMatch(/"tokens":"v1\./);
  });

  it("records a grant without Workers AI as connected with model calls off", async () => {
    const t = setup();
    await t.connect(NO_AI_SCOPES);
    expect(await t.status()).toMatchObject({ state: "connected", workersAi: false, scopes: NO_AI_SCOPES });
  });

  it("refuses a state that does not match the cookie, before any code is exchanged", async () => {
    const t = setup();
    const start = await t.req("/auth/cloudflare/start");
    const { code } = t.fake.authorize(start.headers.get("location") ?? "", ALL_SCOPES);
    const forged = await t.req(`/auth/cloudflare/callback?code=${code}&state=someone-elses-state`, { cookie: (start.headers.get("set-cookie") ?? "").split(";")[0] });
    expect(forged.headers.get("location")).toBe(`${PUBLIC_URL}/account?cloudflare=expired`);
    const noCookie = await t.req(`/auth/cloudflare/callback?code=${code}&state=x`);
    expect(noCookie.headers.get("location")).toBe(`${PUBLIC_URL}/account?cloudflare=expired`);
    expect(t.fake.tokenCalls()).toHaveLength(0);
    expect((await t.status()).state).toBe("none");
  });

  it("uses a state once, binds it to the account that started, and lets it expire", async () => {
    const t = setup();
    const first = await t.connect();
    const replay = await t.req(`/auth/cloudflare/callback?code=${first.code}&state=${first.state}`, { cookie: first.cookie });
    expect(replay.headers.get("location")).toBe(`${PUBLIC_URL}/account?cloudflare=expired`);

    // Another signed-in account with the same cookie and state finds no started connection of its own.
    const u = setup();
    const start = await u.req("/auth/cloudflare/start");
    const { code, state } = u.fake.authorize(start.headers.get("location") ?? "", ALL_SCOPES);
    const cookie = (start.headers.get("set-cookie") ?? "").split(";")[0];
    const other = await u.req(`/auth/cloudflare/callback?code=${code}&state=${state}`, { cookie, account: OTHER });
    expect(other.headers.get("location")).toBe(`${PUBLIC_URL}/account?cloudflare=expired`);
    expect((await u.status(OTHER)).state).toBe("none");

    // Eleven minutes later the started connection is gone.
    const v = setup();
    const s2 = await v.req("/auth/cloudflare/start");
    const g = v.fake.authorize(s2.headers.get("location") ?? "", ALL_SCOPES);
    v.clock.now += 11 * 60_000;
    const late = await v.req(`/auth/cloudflare/callback?code=${g.code}&state=${g.state}`, { cookie: (s2.headers.get("set-cookie") ?? "").split(";")[0] });
    expect(late.headers.get("location")).toBe(`${PUBLIC_URL}/account?cloudflare=expired`);
    expect(v.fake.tokenCalls()).toHaveLength(0);
  });

  it("fails the exchange when the verifier is not the one the challenge was made from (PKCE)", async () => {
    const t = setup();
    const start = await t.req("/auth/cloudflare/start");
    const loc = new URL(start.headers.get("location") ?? "");
    loc.searchParams.set("code_challenge", "A".repeat(43));
    const { code, state } = t.fake.authorize(loc.toString(), ALL_SCOPES);
    const back = await t.req(`/auth/cloudflare/callback?code=${code}&state=${state}`, { cookie: (start.headers.get("set-cookie") ?? "").split(";")[0] });
    expect(back.headers.get("location")).toBe(`${PUBLIC_URL}/account?cloudflare=refused`);
    expect((await t.status()).state).toBe("none");
  });

  it("says when the person declined on Cloudflare, or is not signed in", async () => {
    const t = setup();
    const start = await t.req("/auth/cloudflare/start");
    const cookie = (start.headers.get("set-cookie") ?? "").split(";")[0];
    const denied = await t.req("/auth/cloudflare/callback?error=access_denied&state=x", { cookie });
    expect(denied.headers.get("location")).toBe(`${PUBLIC_URL}/account?cloudflare=denied`);
    const anon = await t.req("/auth/cloudflare/callback?code=c&state=s", { account: null });
    expect(anon.headers.get("location")).toBe(`${PUBLIC_URL}/account?cloudflare=signin`);
  });

  it("refuses a grant without a required scope, revokes it, and keeps nothing", async () => {
    const t = setup();
    const { back } = await t.connect(["user-details.read", "account-settings.read", "artifacts.read", "offline_access"]);
    expect(back.headers.get("location")).toBe(`${PUBLIC_URL}/account?cloudflare=scopes`);
    expect(t.fake.revoked.length).toBeGreaterThan(0);
    expect([...t.fake.tokens.values()].every((x) => x.revoked)).toBe(true);
    expect((await t.status()).state).toBe("none");
  });

  it("records only the required scopes when Cloudflare's answer names none (Workers AI is never assumed)", async () => {
    const t = setup();
    t.fake.namesScopes = false;
    await t.connect();
    expect(await t.status()).toMatchObject({ state: "connected", workersAi: false, scopes: ["user-details.read", "account-settings.read", "artifacts.read", "artifacts.write"] });
  });

  it("refuses a connection that reaches no account", async () => {
    const t = setup();
    t.fake.accounts = [];
    const { back } = await t.connect();
    expect(back.headers.get("location")).toBe(`${PUBLIC_URL}/account?cloudflare=accounts`);
    expect((await t.status()).state).toBe("none");
  });
});

describe("choosing the account", () => {
  it("lists the accounts when there are several and takes the person's choice from our own pages only", async () => {
    const t = setup();
    t.fake.accounts = [ACCOUNT_A, ACCOUNT_B];
    const { back } = await t.connect();
    expect(back.headers.get("location")).toBe(`${PUBLIC_URL}/account?cloudflare=choose`);
    expect(await t.status()).toMatchObject({ state: "choose", accounts: [ACCOUNT_A, ACCOUNT_B] });
    const choose = (accountId: string, origin: string | null = PUBLIC_URL) =>
      t.req("/api/me/cloudflare/account", { method: "POST", origin, headers: { "content-type": "application/json" }, body: JSON.stringify({ accountId }) });
    expect((await choose(ACCOUNT_B.id, null)).status).toBe(403);
    expect((await choose(ACCOUNT_B.id, "https://evil.example")).status).toBe(403);
    const unknown = await choose("c".repeat(32));
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { error: string }).error).toBe("That account is not one this connection reaches. Choose one from the list.");
    const ok = await choose(ACCOUNT_B.id);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ state: "connected", account: ACCOUNT_B });
    // Chosen once: a second choice is refused (the colonies' repositories live in the chosen account).
    expect((await choose(ACCOUNT_A.id)).status).toBe(400);
  });

  it("keeps the account chosen before on a reconnect, and revokes the replaced grant", async () => {
    const t = setup();
    t.fake.accounts = [ACCOUNT_A, ACCOUNT_B];
    await t.connect();
    await t.req("/api/me/cloudflare/account", { method: "POST", origin: PUBLIC_URL, body: JSON.stringify({ accountId: ACCOUNT_B.id }) });
    const before = [...t.fake.tokens.keys()];
    const { back } = await t.connect();
    expect(back.headers.get("location")).toBe(`${PUBLIC_URL}/account?cloudflare=connected`);
    expect(await t.status()).toMatchObject({ state: "connected", account: ACCOUNT_B });
    for (const tok of before) expect(t.fake.tokens.get(tok)?.revoked).toBe(true);
  });
});

describe("POST /api/me/cloudflare/disconnect", () => {
  it("revokes at Cloudflare and forgets the connection, from our own pages only", async () => {
    const t = setup();
    await t.connect();
    expect((await t.req("/api/me/cloudflare/disconnect", { method: "POST" })).status).toBe(403);
    const res = await t.req("/api/me/cloudflare/disconnect", { method: "POST", origin: PUBLIC_URL });
    expect(await res.json()).toEqual({ disconnected: true, revokedAtCloudflare: true, state: "none" });
    expect([...t.fake.tokens.values()].every((x) => x.revoked)).toBe(true);
    expect((await t.status()).state).toBe("none");
    expect((await t.req("/api/me/cloudflare/disconnect", { method: "POST", origin: PUBLIC_URL, account: null })).status).toBe(401);
  });
});

describe("with FT_ACCOUNTS off", () => {
  it("answers 404 on every route, as for a route that does not exist, and does nothing", async () => {
    for (const flag of [undefined, "off", "", "1"]) {
      const t = setup({ FT_ACCOUNTS: flag });
      const routes: Array<[string, string]> = [
        ["GET", "/auth/cloudflare/start"],
        ["GET", "/auth/cloudflare/callback?code=c&state=s"],
        ["GET", "/api/me/cloudflare"],
        ["POST", "/api/me/cloudflare/account"],
        ["POST", "/api/me/cloudflare/disconnect"],
      ];
      for (const [method, path] of routes) {
        const res = await t.req(path, { method, origin: PUBLIC_URL });
        expect(res.status, `${flag} ${method} ${path}`).toBe(404);
        expect(res.headers.get("set-cookie")).toBeNull();
      }
      expect(t.fake.calls).toHaveLength(0);
      expect(t.services.size).toBe(0);
    }
  });
});
