import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CloudflarePanel, CloudflarePanelView } from "../src/cloudflare/CloudflarePanel.tsx";
import { chooseAccount, disconnectCloudflare, loadCloudflare, NOTICES, noticeFor, SCOPE_LINES, type CloudflareStatus, type PanelState } from "../src/cloudflare/cloudflare.ts";

/**
 * The "Connect Cloudflare" panel: each state drawn (not connected, choosing, connected with or without Workers AI,
 * broken), every scope explained in one line, the callback's notice, nothing at all while accounts are off, the
 * person's own text escaped, and the three calls it makes.
 */

const A = { id: "a".repeat(32), name: "Ada's <script>alert(1)</script> account" };
const B = { id: "b".repeat(32), name: "Second" };
const ALL = ["user-details.read", "account-settings.read", "artifacts.read", "artifacts.write", "ai.read", "ai.write", "offline_access"];

const view = (state: PanelState, extra: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(CloudflarePanelView, { state, notice: null, ...extra }));
const status = (s: Partial<CloudflareStatus>): PanelState => ({ kind: "status", status: { configured: true, state: "none", scopes: [], workersAi: false, ...s } });

describe("the panel's states", () => {
  it("shows nothing while accounts are off", () => {
    expect(view({ kind: "off" })).toBe("");
    expect(renderToStaticMarkup(createElement(CloudflarePanel, { fetchFn: async () => new Response("", { status: 404 }), search: "" }))).toContain("Reading your Cloudflare connection");
  });

  it("explains, when not connected, what each scope allows and why, and links to the start of the flow", () => {
    const out = view(status({ state: "none" }));
    expect(out).toContain("Not connected.");
    expect(out).toContain("billed to it");
    expect(out).toContain("FireTrident itself is free");
    expect(out).toContain('href="/auth/cloudflare/start"');
    expect(out).toContain("Connect Cloudflare");
    for (const line of SCOPE_LINES) expect(out).toContain(line.why.replaceAll("'", "&#x27;"));
    expect(out).toContain("your colonies&#x27; repositories live in your Artifacts, billed to your account.");
    expect(out).toContain("in-platform agents and model review run on your Workers AI, billed to your account.");
  });

  it("shows the connected account and the scopes granted, and says plainly when Workers AI is off", () => {
    const on = view(status({ state: "connected", account: A, scopes: ALL, workersAi: true }));
    expect(on).toContain("Connected to <strong>Ada&#x27;s &lt;script&gt;alert(1)&lt;/script&gt; account</strong>");
    expect(on).not.toContain("<script>");
    expect(on).not.toContain("Workers AI was not allowed");
    expect(on.match(/aria-label="granted"/g)).toHaveLength(SCOPE_LINES.length);
    expect(on).toContain("Disconnect");
    const off = view(status({ state: "connected", account: A, scopes: ALL.filter((s) => !s.startsWith("ai.")), workersAi: false }));
    expect(off).toContain("Workers AI was not allowed: in-platform agents and model review are off in your colonies. Connect again and allow Workers AI, or bring your own agents over MCP.");
    expect(off.match(/aria-label="not granted"/g)).toHaveLength(1);
    expect(off).toContain('href="/auth/cloudflare/start"');
  });

  it("lists the accounts to choose from, with the button off until one is picked", () => {
    const out = view(status({ state: "choose", accounts: [A, B], scopes: ALL, workersAi: true }));
    expect(out).toContain("Choose the Cloudflare account your colonies use.");
    expect(out.match(/type="radio"/g)).toHaveLength(2);
    expect(out).toContain("Second");
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>Use this account<\/button>/);
    const picked = view(status({ state: "choose", accounts: [A, B], scopes: ALL, workersAi: true }), { picked: B.id });
    expect(picked).toMatch(/<button[^>]*class="btn btn-approve"[^>]*>Use this account<\/button>/);
    expect(picked).not.toMatch(/disabled=""[^>]*>Use this account/);
  });

  it("says why a broken connection stopped, and offers to connect again or disconnect (asking once to confirm)", () => {
    const reason = "Cloudflare refused to renew this connection (it may have been revoked on Cloudflare). Connect Cloudflare again on the account page.";
    const out = view(status({ state: "broken", account: A, reason, scopes: ALL, workersAi: true }));
    expect(out).toContain("This connection stopped working");
    expect(out).toContain(reason);
    expect(out).toContain("Connect again");
    const confirming = view(status({ state: "broken", account: A, reason, scopes: ALL, workersAi: true }), { confirming: true });
    expect(confirming).toContain("Yes, disconnect");
    expect(confirming).toContain("FireTrident cannot reach them");
  });

  it("shows the callback's notice, and only for codes it knows", () => {
    expect(noticeFor("?cloudflare=connected")).toBe(NOTICES.connected);
    expect(noticeFor("?cloudflare=denied")).toBe("You declined on Cloudflare's page, so nothing was connected.");
    expect(noticeFor("?cloudflare=__proto__")).toBeNull();
    expect(noticeFor("?cloudflare=<b>")).toBeNull();
    expect(noticeFor("")).toBeNull();
    const out = view(status({ state: "connected", account: A, scopes: ALL, workersAi: true }), { notice: NOTICES.connected });
    expect(out).toContain('role="status">Cloudflare is connected.</p>');
  });

  it("asks to sign in, and says when connecting is not set up", () => {
    expect(view({ kind: "signin" })).toContain("Sign in to connect your Cloudflare account.");
    expect(view({ kind: "unset" })).toContain("not set up on this deployment yet");
  });
});

describe("the panel's calls", () => {
  const answer = (code: number, body: unknown) => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });

  it("reads the connection: 404 is off, 401 is sign in, not configured is unset", async () => {
    expect(await loadCloudflare(async () => new Response("", { status: 404 }))).toEqual({ kind: "off" });
    expect(await loadCloudflare(async () => answer(401, { error: "Sign in first" }))).toEqual({ kind: "signin" });
    expect(await loadCloudflare(async () => answer(200, { configured: false, state: "none", scopes: [], workersAi: false }))).toEqual({ kind: "unset" });
    expect(await loadCloudflare(async () => answer(200, { configured: true, state: "connected", account: A, scopes: ALL, workersAi: true }))).toMatchObject({ kind: "status", status: { state: "connected" } });
    expect(await loadCloudflare(async () => Promise.reject(new Error("offline")))).toEqual({ kind: "error", message: "The server did not answer. Try again." });
  });

  it("posts the chosen account and shows the server's sentence when it refuses", async () => {
    const seen: Array<[string, RequestInit | undefined]> = [];
    const ok = await chooseAccount(async (u, init) => (seen.push([u, init]), answer(200, { configured: true, state: "connected", account: B, scopes: ALL, workersAi: true })), B.id);
    expect(ok).toMatchObject({ kind: "status", status: { state: "connected", account: B } });
    expect(seen[0]?.[0]).toBe("/api/me/cloudflare/account");
    expect(seen[0]?.[1]).toMatchObject({ method: "POST", credentials: "same-origin", body: JSON.stringify({ accountId: B.id }) });
    const refused = await chooseAccount(async () => answer(400, { error: "That account is not one this connection reaches. Choose one from the list." }), "x");
    expect(refused).toEqual({ kind: "error", message: "That account is not one this connection reaches. Choose one from the list." });
  });

  it("disconnects, then reads the connection again", async () => {
    const urls: string[] = [];
    const s = await disconnectCloudflare(async (u) => {
      urls.push(u);
      return u.endsWith("/disconnect") ? answer(200, { disconnected: true, revokedAtCloudflare: true, state: "none" }) : answer(200, { configured: true, state: "none", scopes: [], workersAi: false });
    });
    expect(urls).toEqual(["/api/me/cloudflare/disconnect", "/api/me/cloudflare"]);
    expect(s).toMatchObject({ kind: "status", status: { state: "none" } });
  });
});
