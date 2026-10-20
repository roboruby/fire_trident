import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SignIn, SignedIn } from "../src/account/Account.tsx";
import { parseMe, parseTokens, signinText, tokenState, whoText, type Me } from "../src/account/account.ts";
import { AccountLink, accountsOn } from "../src/account/AccountLink.tsx";
import { parseAbout } from "../src/about.ts";
import { parseRoute } from "../src/route.ts";

/** The account page (/account): what it reads from the API, what it says, and that names from GitHub stay text. */

const DAY = 24 * 60 * 60_000;
const limits = { colonies: 3, agentsPerColony: 20, tokensPerColony: 20, tokenDays: 30 };

describe("the account page's data", () => {
  it("reads GET /api/me signed in and signed out, and drops what does not read", () => {
    expect(parseMe({ signedIn: false, limits })).toEqual({ signedIn: false, limits });
    const me = parseMe({
      signedIn: true,
      account: { id: "acc_1", github: { id: 7, login: "ada", name: "Ada" } },
      colonies: [{ id: "web", name: "Web", state: "active", createdAt: 5 }, { id: 42 }, { id: "new", name: null, state: "pending", createdAt: 6 }],
      cloudflare: "connected",
      limits,
    });
    expect(me).toEqual({
      signedIn: true,
      account: { id: "acc_1", github: { id: 7, login: "ada", name: "Ada" } },
      colonies: [
        { id: "web", name: "Web", state: "active", createdAt: 5 },
        { id: "new", name: null, state: "pending", createdAt: 6 },
      ],
      cloudflare: "connected",
      limits,
    });
    expect(parseMe({ signedIn: true, account: { id: "acc_1", github: { login: "ada" } } })).toBeNull();
    expect(parseMe(null)).toBeNull();
    expect((parseMe({ signedIn: false }) as Me).limits).toEqual(limits);
  });

  it("reads token lists without ever expecting a secret", () => {
    const tokens = parseTokens({ tokens: [{ id: "tok_1", role: "agent", label: "bot", createdAt: 1, expiresAt: 2 * DAY, lastUsedAt: null, revokedAt: null, live: true }, { id: "tok_2", role: "admin" }] });
    expect(tokens).toEqual([{ id: "tok_1", role: "agent", label: "bot", createdAt: 1, expiresAt: 2 * DAY, lastUsedAt: null, revokedAt: null, live: true }]);
    expect(tokenState(tokens[0]!, DAY)).toMatch(/^live until /);
    expect(tokenState({ ...tokens[0]!, revokedAt: DAY }, DAY)).toMatch(/^revoked /);
    expect(tokenState(tokens[0]!, 3 * DAY)).toMatch(/^expired /);
  });

  it("says what happened after a sign-in round trip, in plain sentences", () => {
    for (const o of ["unavailable", "expired", "denied", "github"]) expect(signinText(o)).toMatch(/^[A-Z][\s\S]*\.$/);
    expect(signinText(null)).toBeNull();
    expect(signinText("<script>")).toBeNull();
    expect(whoText({ login: "ada", name: "Ada" })).toBe("Ada (@ada)");
    expect(whoText({ login: "ada" })).toBe("@ada");
  });

  it("is the page at /account", () => {
    expect(parseRoute("/account", "")).toEqual({ kind: "account" });
    expect(parseRoute("/account/", "?signin=invite")).toEqual({ kind: "account" });
  });
});

describe("the account page's views", () => {
  it("offers GitHub sign-in when signed out", () => {
    const html = renderToStaticMarkup(createElement(SignIn));
    expect(html).toContain('href="/auth/github/start"');
    expect(html).toContain("A colony is one repository that FireTrident coordinates agents on.");
    expect(html).toContain(">Request an invite</button>");
    expect(signinText("approved")).toBe("Your request was approved and your account is open.");
  });

  it("shows a GitHub name as text, never as markup", () => {
    const me = parseMe({
      signedIn: true,
      account: { id: "acc_1", github: { id: 7, login: "ada", name: '<img src=x onerror="alert(1)">' } },
      colonies: [{ id: "web", name: "<b>Web</b>", state: "active", createdAt: 5 }],
      cloudflare: "not-connected",
      limits,
    }) as Extract<Me, { signedIn: true }>;
    const html = renderToStaticMarkup(createElement(SignedIn, { me, onChange: async () => undefined }));
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>Web</b>");
    expect(html).toContain("&lt;img src=x");
    expect(html).toContain('href="/c/web"');
    // Without a Cloudflare connection, the create button is off and the page says why.
    expect(html).toContain("Connect your Cloudflare account first");
    expect(html).toMatch(/<button type="submit" class="btn btn-approve" disabled="">Create the colony<\/button>/);
  });

  it("puts the Connect Cloudflare panel on the page, and each colony's delete", () => {
    const me = parseMe({
      signedIn: true,
      account: { id: "acc_1", github: { id: 7, login: "ada" } },
      colonies: [{ id: "web", name: "Web", state: "active", createdAt: 5 }],
      cloudflare: "connected",
      limits,
    }) as Extract<Me, { signedIn: true }>;
    const html = renderToStaticMarkup(createElement(SignedIn, { me, onChange: async () => undefined }));
    expect(html).toContain('class="cf-panel"');
    expect(html).toContain("Reading your Cloudflare connection");
    expect(html).toMatch(/<button type="button" class="btn btn-reject">Delete<\/button>/);
    expect(html).not.toContain("Workers AI access");
  });

  it("says why in-platform agents and model review are off when the connection has no Workers AI", () => {
    const sentence =
      "In-platform agents and model review are off: this colony's Cloudflare connection has no Workers AI access. Connect again and allow Workers AI, or bring your own agents over MCP.";
    const raw = { signedIn: true, account: { id: "acc_1", github: { id: 7, login: "ada" } }, colonies: [{ id: "web", name: "Web", state: "active", createdAt: 5 }], cloudflare: "connected", modelsOff: sentence, limits };
    const me = parseMe(raw) as Extract<Me, { signedIn: true }>;
    expect(me.modelsOff).toBe(sentence);
    expect(renderToStaticMarkup(createElement(SignedIn, { me, onChange: async () => undefined }))).toContain("Workers AI access. Connect again and allow Workers AI");
  });
});

describe("the account link", () => {
  it("shows only where the deployment has accounts on", () => {
    expect(accountsOn(parseAbout({ flags: ["FT_INLINE"] }))).toBe(false);
    expect(accountsOn(null)).toBe(false);
    expect(accountsOn(parseAbout({ flags: ["FT_ACCOUNTS"] }))).toBe(true);
    // Before /api/about answers, nothing shows.
    // Before the server answers, the buttons show (so the nav does not fill in late); they go only when it says accounts are off.
    const first = renderToStaticMarkup(createElement(AccountLink));
    expect(first).toContain('href="/auth/github/start"');
    expect(first).toContain('href="/account?request=1"');
  });

  it("offers Sign in and Request invite as buttons in the site's nav, after the GitHub mark, on every page but the account page", () => {
    const nav = readFileSync(new URL("../src/components/SiteNav.tsx", import.meta.url), "utf8");
    const mark = nav.indexOf("<GithubMark />");
    expect(mark).toBeGreaterThan(0);
    expect(nav.indexOf("<AccountLink />")).toBeGreaterThan(mark);
    expect(nav).not.toContain("Source\n");
    for (const page of ["../src/landing/Landing.tsx", "../src/limits/Limits.tsx", "../src/connect/Connect.tsx"]) expect(readFileSync(new URL(page, import.meta.url), "utf8")).toContain("<SiteNav");
    expect(readFileSync(new URL("../src/account/Account.tsx", import.meta.url), "utf8")).toContain("<SiteNav\n        account={false}");
    const link = readFileSync(new URL("../src/account/AccountLink.tsx", import.meta.url), "utf8");
    expect(link).toContain('href="/auth/github/start"');
    expect(link).toContain('href="/account?request=1"');
  });
});
