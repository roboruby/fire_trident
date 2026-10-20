import { describe, expect, it } from "vitest";
import { accountsApp } from "../../src/accounts/routes.ts";
import { SESSION_COOKIE } from "../../src/accounts/cookies.ts";
import { REQUEST_PATH, cleanNote, requestMail } from "../../src/accounts/requests.ts";
import { ADMIN, CookieJar, FakeGithub, ORIGIN, accountsEnv, memoryStore, type FakeUser } from "./fakes.ts";

/**
 * Invite requests: a person asks with their GitHub username and email behind Turnstile, the operator gets one email with
 * a signed link, the page behind it approves or denies, and an approved GitHub account opens on its next sign-in.
 */

type Sent = { from: string; to: string; subject: string; text: string };

function setup(opts: { configured?: boolean; turnstile?: (token: string) => boolean } = {}) {
  const store = memoryStore();
  const sent: Sent[] = [];
  const mail = { send: async (m: Sent) => void sent.push(m) };
  const env = accountsEnv(store, {
    vars: opts.configured === false ? {} : ({ FT_TURNSTILE_SITE_KEY: "site-key", FT_TURNSTILE_SECRET: "turnstile-secret", FT_INVITE_TO: "op@example.com", FT_INVITE_FROM: "invites@ft.test", INVITE_MAIL: mail } as never),
  });
  const github = new FakeGithub();
  let clock = 1_000_000;
  const good = opts.turnstile ?? ((token: string) => token === "good-token");
  const app = accountsApp({ fetch: github.fetch, now: () => clock, verifyTurnstile: async (_secret, token) => good(token) });
  const jar = new CookieJar();
  const call = async (method: string, path: string, init: { body?: unknown; form?: Record<string, string>; origin?: string | null; headers?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    const cookie = jar.header(new URL(path, ORIGIN).pathname);
    if (cookie) headers.cookie = cookie;
    if (init.origin !== null && method !== "GET") headers.origin = init.origin ?? ORIGIN;
    let body: string | undefined;
    if (init.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(init.body);
    } else if (init.form) {
      headers["content-type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(init.form).toString();
    }
    const res = await app.request(path, { method, headers, ...(body !== undefined ? { body } : {}) }, env);
    jar.take(res);
    return res;
  };
  const signIn = async (user: FakeUser) => {
    const start = await call("GET", "/auth/github/start");
    expect(start.status).toBe(302);
    const back = new URL(github.authorize(start.headers.get("location") ?? "", user));
    const cb = await call("GET", back.pathname + back.search);
    expect(cb.status).toBe(302);
    return cb.headers.get("location") ?? "";
  };
  const request = (body: Record<string, unknown> = {}) => call("POST", "/api/accounts/invite-requests", { body: { login: "ada", email: "Ada@Example.com", note: "I run a small team", token: "good-token", ...body } });
  /** The decision link in the newest email, as a path on this deployment. */
  const linkOf = () => {
    const m = sent.at(-1)?.text.match(/https?:\/\/\S+\/auth\/invite-requests\/\S+/);
    expect(m, "the email holds the decision link").toBeTruthy();
    const u = new URL(m![0]);
    return u.pathname + u.search;
  };
  return { store, env, app, jar, call, request, signIn, sent, linkOf, tick: (ms: number) => (clock += ms) };
}

const ada: FakeUser = { id: 101, login: "ada", name: "Ada Lovelace" };
const bob: FakeUser = { id: 102, login: "bob" };

describe("asking for an invite", () => {
  it("says whether requests are open, with the site key only", async () => {
    const t = setup();
    expect(await (await t.call("GET", "/api/accounts/invite-requests/config")).json()).toEqual({ siteKey: "site-key" });
    const off = setup({ configured: false });
    expect(await (await off.call("GET", "/api/accounts/invite-requests/config")).json()).toEqual({ siteKey: null });
    expect((await off.request()).status).toBe(503);
  });

  it("records the request and emails the operator one signed decision link, the person's email and note as text", async () => {
    const t = setup();
    const res = await t.request({ note: "I run a small\u0000team\n\n  please" });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { ok: boolean; id: string };
    expect(body.ok).toBe(true);
    expect(body.id).toMatch(/^req_/);
    expect(t.sent).toHaveLength(1);
    const mail = t.sent[0]!;
    expect(mail.to).toBe("op@example.com");
    expect(mail.from).toBe("invites@ft.test");
    expect(mail.subject).toBe("FireTrident: invite request from @ada");
    expect(mail.text).toContain("https://github.com/ada");
    expect(mail.text).toContain("Email:   ada@example.com");
    expect(mail.text).toContain("Note:    I run a small team please");
    expect(t.linkOf()).toMatch(new RegExp(`^${REQUEST_PATH}/req_[a-z0-9]+\\?t=req_[a-z0-9]+\\.[A-Za-z0-9_-]+$`));
    const listed = await t.call("GET", "/api/accounts/invite-requests", { headers: { authorization: `Bearer ${ADMIN}` } });
    expect(listed.status).toBe(200);
    const list = (await listed.json()) as { requests: Array<{ id: string; login: string; email: string; status: string }> };
    expect(list.requests).toEqual([{ id: body.id, login: "ada", email: "ada@example.com", note: "I run a small team please", createdAt: 1_000_000, status: "pending" }]);
  });

  it("refuses without Turnstile's say-so, a bad username or email, a cross-site origin, and a second request while one waits", async () => {
    const t = setup();
    expect((await t.request({ token: "bad-token" })).status).toBe(403);
    expect((await t.request({ login: "-ada" })).status).toBe(400);
    expect((await t.request({ login: "ada lovelace" })).status).toBe(400);
    expect((await t.request({ email: "not an email" })).status).toBe(400);
    expect((await t.request({ token: "" })).status).toBe(400);
    expect((await t.call("POST", "/api/accounts/invite-requests", { body: { login: "ada", email: "a@b.co", token: "good-token" }, origin: "https://evil.test" })).status).toBe(403);
    expect(t.sent).toHaveLength(0);
    expect((await t.request()).status).toBe(202);
    const again = await t.request({ email: "other@example.com" });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toContain("already waiting");
    expect((await t.request({ login: "ADA" })).status).toBe(409);
    expect((await t.request({ login: "bob" })).status).toBe(409);
    expect(t.sent).toHaveLength(1);
  });

  it("drops the request and says so when the operator's mail cannot be sent", async () => {
    const t = setup();
    (t.env as unknown as { INVITE_MAIL: { send: () => Promise<void> } }).INVITE_MAIL.send = async () => {
      throw new Error("mail down");
    };
    expect((await t.request()).status).toBe(503);
    const listed = await t.call("GET", "/api/accounts/invite-requests", { headers: { authorization: `Bearer ${ADMIN}` } });
    expect(((await listed.json()) as { requests: unknown[] }).requests).toEqual([]);
  });
});

describe("the decision page", () => {
  it("shows the request to whoever holds the link, with an Approve and a Deny button, and nothing to a bad link", async () => {
    const t = setup();
    await t.request();
    const link = t.linkOf();
    const page = await t.call("GET", link);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    const html = await page.text();
    expect(html).toContain("@ada asks for an invite.");
    expect(html).toContain('name="decision" value="approve"');
    expect(html).toContain('name="decision" value="deny"');
    expect(html).toContain("ada@example.com");
    const bad = await t.call("GET", `${link.slice(0, -4)}AAAA`);
    expect(bad.status).toBe(404);
    expect(await bad.text()).toContain("does not name an invite request");
    expect((await t.call("GET", `${REQUEST_PATH}/req_nope?t=req_nope.AAAA`)).status).toBe(404);
  });

  it("approves on the button, and the approved GitHub account then opens with no code and no second use", async () => {
    const t = setup();
    await t.request();
    const link = t.linkOf();
    const token = new URL(link, ORIGIN).searchParams.get("t")!;
    const path = new URL(link, ORIGIN).pathname;
    // A GET never decides: the person still needs a code.
    expect(await t.signIn(ada)).toContain("signin=invite");
    const decided = await t.call("POST", path, { form: { t: token, decision: "approve" } });
    expect(decided.status).toBe(200);
    expect(await decided.text()).toContain("Approved: @ada can sign in.");
    // The same link again shows the decision, with no buttons.
    expect(await (await t.call("GET", link)).text()).not.toContain('name="decision"');
    // Ada signs in: her account opens.
    const where = await t.signIn(ada);
    expect(where).toContain("signin=approved");
    expect(t.jar.header("/api")).toContain(`${SESSION_COOKIE}=`);
    const me = await t.call("GET", "/api/me");
    expect(((await me.json()) as { signedIn: boolean; account: { github: { login: string } } }).account.github.login).toBe("ada");
    // The request is opened, so Bob (not approved) still needs a code, and Ada's approval cannot be reused by a lookalike.
    const list = (await (await t.call("GET", "/api/accounts/invite-requests", { headers: { authorization: `Bearer ${ADMIN}` } })).json()) as { requests: Array<{ status: string; accountId?: string }> };
    expect(list.requests[0]?.status).toBe("opened");
    expect(list.requests[0]?.accountId).toMatch(/^acc_/);
    expect(await t.signIn(bob)).toContain("signin=invite");
    expect(await (await t.call("GET", link)).text()).toContain("@ada is in.");
  });

  it("denies on the other button; a denied person still needs a code, and a forged decision changes nothing", async () => {
    const t = setup();
    await t.request();
    const link = t.linkOf();
    const token = new URL(link, ORIGIN).searchParams.get("t")!;
    const path = new URL(link, ORIGIN).pathname;
    expect((await t.call("POST", path, { form: { t: `${token.slice(0, -4)}AAAA`, decision: "approve" } })).status).toBe(404);
    expect((await t.call("POST", path, { form: { t: token, decision: "maybe" } })).status).toBe(400);
    const denied = await t.call("POST", path, { form: { t: token, decision: "deny" } });
    expect(await denied.text()).toContain("Denied: @ada.");
    expect(await t.signIn(ada)).toContain("signin=invite");
    // Approving after denying does nothing: the decision stands.
    expect(await (await t.call("POST", path, { form: { t: token, decision: "approve" } })).text()).toContain("Denied: @ada.");
    // A week later, Ada may ask again.
    expect((await t.request()).status).toBe(409);
    t.tick(8 * 24 * 60 * 60_000);
    expect((await t.request()).status).toBe(202);
  });
});

describe("the pieces", () => {
  it("cleans a note and writes the operator's mail as text with the link on its own line", () => {
    expect(cleanNote("  a\u0000b\n\n c  ")).toBe("a b c");
    expect(cleanNote("x".repeat(500))).toHaveLength(280);
    const mail = requestMail({ to: "op@example.com", from: "invites@ft.test", origin: "https://ft.test" }, { id: "req_1", login: "ada", email: "ada@example.com", note: "", createdAt: 0, status: "pending" }, "https://ft.test/auth/invite-requests/req_1?t=x.y");
    expect(mail.text.split("\n")).toContain("https://ft.test/auth/invite-requests/req_1?t=x.y");
    expect(mail.text).toContain("Note:    (none)");
    expect(mail.subject).toBe("FireTrident: invite request from @ada");
  });
});
