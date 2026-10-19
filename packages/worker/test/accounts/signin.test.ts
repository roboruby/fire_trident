import { describe, expect, it } from "vitest";
import { accountsApp } from "../../src/accounts/routes.ts";
import { OAUTH_COOKIE, SESSION_COOKIE, SIGNUP_COOKIE } from "../../src/accounts/cookies.ts";
import { SESSION_TTL_MS } from "../../src/accounts/limits.ts";
import { currentAccount } from "../../src/accounts/session.ts";
import type { Env } from "../../src/env.ts";
import { ADMIN, CookieJar, FakeGithub, ORIGIN, accountsEnv, memoryStore, type FakeUser } from "./fakes.ts";

/** Sign-in with GitHub against a fake GitHub (no network): state and PKCE, invite codes for new people, sessions. */

function setup(opts: { vars?: Partial<Env> } = {}) {
  const store = memoryStore();
  const env = accountsEnv(store, opts);
  const github = new FakeGithub();
  let clock = 1_000_000;
  const app = accountsApp({ fetch: github.fetch, now: () => clock });
  const jar = new CookieJar();
  const call = async (method: string, path: string, init: { body?: unknown; origin?: string | null; headers?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    const cookie = jar.header(new URL(path, ORIGIN).pathname);
    if (cookie) headers.cookie = cookie;
    if (init.origin !== null && method !== "GET") headers.origin = init.origin ?? ORIGIN;
    if (init.body !== undefined) headers["content-type"] = "application/json";
    const res = await app.request(path, { method, headers, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) }, env);
    jar.take(res);
    return res;
  };
  const mintInvite = async (body: Record<string, unknown> = {}) => {
    const res = await app.request("/api/accounts/invites", { method: "POST", headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, body: JSON.stringify(body) }, env);
    expect(res.status).toBe(201);
    return ((await res.json()) as { code: string }).code;
  };
  /** Sign in as `user` through GitHub: the location the callback sends the browser to. */
  const signIn = async (user: FakeUser) => {
    const start = await call("GET", "/auth/github/start");
    expect(start.status).toBe(302);
    const back = github.authorize(start.headers.get("location") ?? "", user);
    const cb = await call("GET", new URL(back).pathname + new URL(back).search);
    expect(cb.status).toBe(302);
    return cb.headers.get("location") ?? "";
  };
  /** Another person's browser on the same deployment: its own cookies. */
  const browser = () => {
    const own = new CookieJar();
    const ownCall = async (method: string, path: string, init: { body?: unknown } = {}) => {
      const headers: Record<string, string> = {};
      const cookie = own.header(new URL(path, ORIGIN).pathname);
      if (cookie) headers.cookie = cookie;
      if (method !== "GET") headers.origin = ORIGIN;
      if (init.body !== undefined) headers["content-type"] = "application/json";
      const res = await app.request(path, { method, headers, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) }, env);
      own.take(res);
      return res;
    };
    const ownSignIn = async (user: FakeUser) => {
      const start = await ownCall("GET", "/auth/github/start");
      const back = new URL(github.authorize(start.headers.get("location") ?? "", user));
      return (await ownCall("GET", back.pathname + back.search)).headers.get("location") ?? "";
    };
    return { jar: own, call: ownCall, signIn: ownSignIn };
  };
  return { store, env, github, app, jar, call, mintInvite, signIn, browser, tick: (ms: number) => (clock += ms), now: () => clock };
}

const ada: FakeUser = { id: 101, login: "ada", name: "Ada Lovelace" };

describe("GitHub sign-in", () => {
  it("sends the browser to GitHub with state, PKCE S256 and the fixed redirect URI, the state in a short sealed cookie", async () => {
    const t = setup();
    const res = await t.call("GET", "/auth/github/start", { headers: { host: "evil.test" } });
    const loc = new URL(res.headers.get("location") ?? "");
    expect(loc.origin + loc.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(loc.searchParams.get("client_id")).toBe("test-client-id");
    expect(loc.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/auth/github/callback`);
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    expect(loc.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(loc.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(loc.searchParams.has("scope")).toBe(false);
    const line = res.headers.getSetCookie().find((l) => l.startsWith(`${OAUTH_COOKIE}=`)) ?? "";
    expect(line).toMatch(/; Path=\/auth\/github; Max-Age=600; HttpOnly; Secure; SameSite=Lax$/);
    // The cookie is sealed: neither the state nor the verifier reads in it.
    expect(line).not.toContain(loc.searchParams.get("state") ?? "-");
  });

  it("asks a new person for an invite code, opens the account with it, and signs them in", async () => {
    const t = setup();
    const code = await t.mintInvite({ uses: 1, days: 7, note: "first" });
    expect(code).toMatch(/^ft-inv-[a-z2-7]{26}$/);
    expect(await t.signIn(ada)).toBe(`${ORIGIN}/account?signin=invite`);
    expect(t.jar.has(SIGNUP_COOKIE)).toBe(true);
    expect(t.jar.has(SESSION_COOKIE)).toBe(false);
    expect(await (await t.call("GET", "/auth/github/pending")).json()).toEqual({ github: { login: "ada", name: "Ada Lovelace" } });
    expect(await (await t.call("GET", "/api/me")).json()).toMatchObject({ signedIn: false });

    const wrong = await t.call("POST", "/auth/github/invite", { body: { code: "ft-inv-aaaaaaaaaaaaaaaaaaaaaaaaaa" } });
    expect(wrong.status).toBe(403);
    expect(((await wrong.json()) as { error: string }).error).toMatch(/not one FireTrident knows/);
    // Typed with spaces and capitals, it still reads.
    const ok = await t.call("POST", "/auth/github/invite", { body: { code: `  ${code.toUpperCase()} ` } });
    expect(ok.status).toBe(201);
    expect(await ok.json()).toMatchObject({ ok: true, created: true, account: { github: { id: 101, login: "ada", name: "Ada Lovelace" } } });
    const session = ok.headers.getSetCookie().find((l) => l.startsWith(`${SESSION_COOKIE}=`)) ?? "";
    expect(session).toMatch(new RegExp(`; Path=/; Max-Age=${SESSION_TTL_MS / 1000}; HttpOnly; Secure; SameSite=Lax$`));
    expect(t.jar.has(SIGNUP_COOKIE)).toBe(false);
    const me = (await (await t.call("GET", "/api/me")).json()) as { signedIn: boolean; account: { id: string; github: unknown }; colonies: unknown[] };
    expect(me).toMatchObject({ signedIn: true, account: { github: { id: 101, login: "ada" } }, colonies: [] });
    expect(me.account.id).toMatch(/^acc_/);
    // The session id itself is never stored: the store holds its hash.
    expect(JSON.stringify(t.store.listInvites(t.now()))).not.toContain(code);
  });

  it("signs a returning person straight in, refreshing their login and name, and asks for no code", async () => {
    const t = setup();
    const code = await t.mintInvite();
    await t.signIn(ada);
    await t.call("POST", "/auth/github/invite", { body: { code } });
    await t.call("POST", "/auth/logout");
    expect(await t.signIn({ id: 101, login: "ada-l", name: null })).toBe(`${ORIGIN}/account`);
    expect(await (await t.call("GET", "/api/me")).json()).toMatchObject({ signedIn: true, account: { github: { id: 101, login: "ada-l" } } });
  });

  it("refuses a used-up or expired code with a sentence", async () => {
    const t = setup();
    const code = await t.mintInvite({ uses: 1 });
    await t.signIn(ada);
    expect((await t.call("POST", "/auth/github/invite", { body: { code } })).status).toBe(201);

    // A second person, in their own browser, on the same deployment.
    const bob = t.browser();
    await bob.signIn({ id: 202, login: "bob" });
    const used = await bob.call("POST", "/auth/github/invite", { body: { code } });
    expect(used.status).toBe(403);
    expect(((await used.json()) as { error: string }).error).toMatch(/used as many times as it allows/);

    const late = await t.mintInvite({ days: 1 });
    t.tick(2 * 24 * 60 * 60_000);
    // Bob's sign-up waited too long as well; once he signs in again, the code itself has expired.
    expect((await bob.call("POST", "/auth/github/invite", { body: { code: late } })).status).toBe(401);
    await bob.signIn({ id: 202, login: "bob" });
    const expired = await bob.call("POST", "/auth/github/invite", { body: { code: late } });
    expect(expired.status).toBe(403);
    expect(((await expired.json()) as { error: string }).error).toMatch(/expired/);
  });

  it("sends the person back with a reason when the state does not match, the cookie is gone, GitHub refuses or is down, or they said no", async () => {
    const t = setup();
    const start = await t.call("GET", "/auth/github/start");
    const back = new URL(t.github.authorize(start.headers.get("location") ?? "", ada));
    const forged = new URL(back);
    forged.searchParams.set("state", "x".repeat(43));
    expect((await t.call("GET", forged.pathname + forged.search)).headers.get("location")).toBe(`${ORIGIN}/account?signin=expired`);
    // The state cookie is cleared after any answer, so the real callback no longer works either.
    expect((await t.call("GET", back.pathname + back.search)).headers.get("location")).toBe(`${ORIGIN}/account?signin=expired`);

    for (const failure of ["refuse", "down"] as const) {
      t.github.tokenFailure = failure;
      const s = await t.call("GET", "/auth/github/start");
      const b = new URL(t.github.authorize(s.headers.get("location") ?? "", ada));
      expect((await t.call("GET", b.pathname + b.search)).headers.get("location")).toBe(`${ORIGIN}/account?signin=github`);
    }
    t.github.tokenFailure = "none";
    await t.call("GET", "/auth/github/start");
    expect((await t.call("GET", "/auth/github/callback?error=access_denied&state=x")).headers.get("location")).toBe(`${ORIGIN}/account?signin=denied`);
    expect(t.jar.has(SESSION_COOKIE)).toBe(false);
    // A code GitHub sent is never put in a URL FireTrident makes, nor in a cookie.
    for (const r of t.github.requests) expect(r.url).not.toContain("code-");
  });

  it("refuses a tampered sign-up cookie", async () => {
    const t = setup();
    const code = await t.mintInvite();
    await t.signIn(ada);
    const sealed = t.jar.get(SIGNUP_COOKIE) ?? "";
    t.jar.set(SIGNUP_COOKIE, `${sealed.slice(0, -2)}${sealed.endsWith("A") ? "B" : "A"}A`, "/auth/github");
    expect((await t.call("POST", "/auth/github/invite", { body: { code } })).status).toBe(401);
  });

  it("checks the Origin of the browser's writes", async () => {
    const t = setup();
    const code = await t.mintInvite();
    await t.signIn(ada);
    expect((await t.call("POST", "/auth/github/invite", { body: { code }, origin: "https://evil.test" })).status).toBe(403);
    expect((await t.call("POST", "/auth/github/invite", { body: { code }, origin: null })).status).toBe(403);
    expect((await t.call("POST", "/auth/github/invite", { body: { code } })).status).toBe(201);
    expect((await t.call("POST", "/auth/logout", { origin: "https://evil.test" })).status).toBe(403);
    expect(await (await t.call("GET", "/api/me")).json()).toMatchObject({ signedIn: true });
  });

  it("refuses to start when sign-in is not set up, naming what is missing in the log only", async () => {
    const t = setup({ vars: { FT_GITHUB_CLIENT_SECRET: undefined, FT_SESSION_KEY: "too-short" } });
    expect((await t.call("GET", "/auth/github/start")).headers.get("location")).toBe(`${ORIGIN}/account?signin=unavailable`);
  });
});

describe("sessions", () => {
  it("end at logout, in the store as well as the browser", async () => {
    const t = setup();
    const code = await t.mintInvite();
    await t.signIn(ada);
    await t.call("POST", "/auth/github/invite", { body: { code } });
    const cookie = t.jar.header("/api/me");
    const out = await t.call("POST", "/auth/logout");
    expect(out.status).toBe(200);
    expect(out.headers.getSetCookie()).toContain(`${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
    // The old cookie, replayed, no longer signs anyone in.
    const replay = await t.app.request("/api/me", { headers: { cookie } }, t.env);
    expect(await replay.json()).toMatchObject({ signedIn: false });
  });

  it("expire after their life, and a forged or unsigned cookie is never looked up", async () => {
    const t = setup();
    const code = await t.mintInvite();
    await t.signIn(ada);
    await t.call("POST", "/auth/github/invite", { body: { code } });
    const c = { env: t.env, req: { header: (n: string) => (n === "cookie" ? t.jar.header("/") : undefined) } };
    expect((await currentAccount(c, t.now()))?.github.login).toBe("ada");
    expect(await currentAccount(c, t.now() + SESSION_TTL_MS + 1)).toBeNull();
    t.tick(SESSION_TTL_MS + 1);
    expect(await (await t.call("GET", "/api/me")).json()).toMatchObject({ signedIn: false });
    const raw = t.jar.get(SESSION_COOKIE) ?? "";
    const forged = { env: t.env, req: { header: () => `${SESSION_COOKIE}=${raw.split(".")[0]}.AAAA` } };
    expect(await currentAccount(forged, 0)).toBeNull();
    expect(await currentAccount({ env: { ...t.env, FT_ACCOUNTS: undefined }, req: c.req }, 0)).toBeNull();
  });
});

describe("invite codes for the operator", () => {
  it("need the admin token configured and presented, show the code once and list without it", async () => {
    const t = setup();
    const post = (headers: Record<string, string>, env = t.env) => t.app.request("/api/accounts/invites", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" }, env);
    expect((await post({})).status).toBe(401);
    expect((await post({ authorization: "Bearer wrong" })).status).toBe(401);
    expect((await post({}, { ...t.env, FT_ADMIN_TOKEN: undefined, FT_OPEN_WRITES: "1" } as Env)).status).toBe(403);
    const res = await post({ authorization: `Bearer ${ADMIN}` });
    const made = (await res.json()) as { code: string; invite: { id: string; uses: number; expiresAt: number } };
    expect(made.invite).toMatchObject({ uses: 1, expiresAt: t.now() + 14 * 24 * 60 * 60_000 });
    const list = await t.app.request("/api/accounts/invites", { headers: { authorization: `Bearer ${ADMIN}` } }, t.env);
    const text = await list.text();
    expect(text).toContain(made.invite.id);
    expect(text).not.toContain(made.code);
    const bad = await t.app.request("/api/accounts/invites", { method: "POST", headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, body: JSON.stringify({ uses: 0, days: 91 }) }, t.env);
    expect(bad.status).toBe(400);
    const gone = await t.app.request(`/api/accounts/invites/${made.invite.id}`, { method: "DELETE", headers: { authorization: `Bearer ${ADMIN}` } }, t.env);
    expect(await gone.json()).toMatchObject({ ok: true, invite: { live: false } });
  });
});

describe("with FT_ACCOUNTS off", () => {
  it("every accounts route answers 404, as an unknown route does, and the accounts object is never read", async () => {
    for (const value of [undefined, "off", "1", "true", ""]) {
      const store = memoryStore();
      const env = { ...accountsEnv(store), FT_ACCOUNTS: value, ACCOUNTS: undefined } as unknown as Env;
      const app = accountsApp({ fetch: async () => { throw new Error("no network"); } });
      const routes: Array<[string, string]> = [
        ["GET", "/auth/github/start"],
        ["GET", "/auth/github/callback?code=x&state=y"],
        ["GET", "/auth/github/pending"],
        ["POST", "/auth/github/invite"],
        ["POST", "/auth/logout"],
        ["GET", "/api/me"],
        ["POST", "/api/me/colonies"],
        ["GET", "/api/me/colonies/web/tokens"],
        ["POST", "/api/me/colonies/web/tokens"],
        ["DELETE", "/api/me/colonies/web/tokens/tok_1"],
        ["POST", "/api/accounts/invites"],
        ["GET", "/api/accounts/invites"],
        ["DELETE", "/api/accounts/invites/inv_1"],
      ];
      for (const [method, path] of routes) {
        const res = await app.request(path, { method, headers: { authorization: `Bearer ${ADMIN}`, origin: ORIGIN } }, env);
        expect(res.status, `${method} ${path} with FT_ACCOUNTS=${String(value)}`).toBe(404);
        expect(await res.json()).toEqual({ error: `no route for ${method} ${path.split("?")[0]}` });
      }
    }
  });
});
