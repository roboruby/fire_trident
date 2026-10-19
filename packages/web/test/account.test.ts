import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SignIn, SignedIn } from "../src/account/Account.tsx";
import { parseMe, parseTokens, signinText, tokenState, whoText, type Me } from "../src/account/account.ts";
import { CloudflareSlot } from "../src/account/CloudflareSlot.tsx";
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
    for (const o of ["unavailable", "expired", "denied", "github"]) expect(signinText(o)).toMatch(/^[A-Z][^]*\.$/);
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

  it("leaves a slot for the Cloudflare connection, saying what it is for", () => {
    const html = renderToStaticMarkup(createElement(CloudflareSlot, { status: "connected" }));
    expect(html).toContain('data-slot="connect-cloudflare"');
    expect(html).toContain("billed to you");
  });
});
