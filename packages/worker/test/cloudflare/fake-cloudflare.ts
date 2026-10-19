import { pkceChallenge } from "../../src/cloudflare/oauth.ts";
import type { CloudflareAccount } from "../../src/cloudflare/types.ts";

/**
 * A fake Cloudflare (no network, nothing Node-only, so the Worker's end-to-end tests in test/e2e load it too): the OAuth
 * authorize step, the token endpoint (authorization code with PKCE S256 and client_secret_post, refresh with rotation),
 * revocation, GET /accounts and Workers AI's /ai/run. It checks what the real one would refuse, so a test that passes
 * here sent a well-formed flow.
 */

export const CLIENT_ID = "ft-test-client";
export const CLIENT_SECRET = "test-client-secret-value";
export const GRANT_KEY = "test-grant-key-material-0123456789abcdef";
export const PUBLIC_URL = "https://ft.example";
export const ACCOUNT_A: CloudflareAccount = { id: "a".repeat(32), name: "Ada's <b>account</b>" };
export const ACCOUNT_B: CloudflareAccount = { id: "b".repeat(32), name: "Second account" };

interface IssuedCode {
  challenge: string;
  redirectUri: string;
  scopes: string[];
  used: boolean;
}

interface Token {
  kind: "access" | "refresh";
  scopes: string[];
  expiresAt: number;
  revoked: boolean;
}

export interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** The fake. `clock` is the shared test clock. */
export class FakeCloudflare {
  readonly calls: Call[] = [];
  readonly tokens = new Map<string, Token>();
  readonly revoked: string[] = [];
  private readonly codes = new Map<string, IssuedCode>();
  private n = 0;
  accounts: CloudflareAccount[] = [ACCOUNT_A];
  /** Refreshes answer this way: "ok", Cloudflare's invalid_grant refusal, or 503. */
  refreshAnswer: "ok" | "invalid_grant" | "unavailable" = "ok";
  /** Whether the token answer names the scopes it granted. */
  namesScopes = true;
  /** The access token life, in seconds. */
  expiresIn = 3600;
  /** Workers AI's answer: an envelope body and status. */
  aiAnswer: { status: number; body: unknown; headers?: Record<string, string> } = {
    status: 200,
    body: { result: { response: "hello", usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } }, success: true, errors: [], messages: [] },
  };

  constructor(readonly clock: { now: number }) {}

  private mint(kind: Token["kind"], scopes: string[]): string {
    const t = `${kind}-${++this.n}-${Math.random().toString(36).slice(2)}`;
    this.tokens.set(t, { kind, scopes, expiresAt: this.clock.now + this.expiresIn * 1000, revoked: false });
    return t;
  }

  /** The person consents on Cloudflare's page: a code for the authorize URL's challenge, sent back to its redirect URI. */
  authorize(authorizeUrl: string, granted: string[]): { code: string; state: string; redirectUri: string } {
    const u = new URL(authorizeUrl);
    if (u.origin + u.pathname !== "https://dash.cloudflare.com/oauth2/auth") throw new Error(`not the authorize endpoint: ${u.origin}${u.pathname}`);
    if (u.searchParams.get("client_id") !== CLIENT_ID || u.searchParams.get("response_type") !== "code") throw new Error("bad client or response type");
    if (u.searchParams.get("code_challenge_method") !== "S256" || !u.searchParams.get("code_challenge")) throw new Error("no S256 challenge");
    const code = `code-${++this.n}`;
    const redirectUri = u.searchParams.get("redirect_uri") ?? "";
    this.codes.set(code, { challenge: u.searchParams.get("code_challenge") ?? "", redirectUri, scopes: granted, used: false });
    return { code, state: u.searchParams.get("state") ?? "", redirectUri };
  }

  private json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  }

  private bearer(call: Call): Token | null {
    const m = /^Bearer (.+)$/.exec(call.headers.authorization ?? "");
    const t = m ? this.tokens.get(m[1] ?? "") : undefined;
    return t && t.kind === "access" && !t.revoked && t.expiresAt > this.clock.now ? t : null;
  }

  /** The fake's fetch. */
  readonly fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    const call: Call = { method: init.method ?? "GET", url: input, headers, body: typeof init.body === "string" ? init.body : "" };
    this.calls.push(call);
    const url = new URL(input);
    const form = new URLSearchParams(call.body);
    if (url.href === "https://dash.cloudflare.com/oauth2/token") {
      if (form.get("client_id") !== CLIENT_ID || form.get("client_secret") !== CLIENT_SECRET) return this.json(401, { error: "invalid_client" });
      if (form.get("grant_type") === "authorization_code") {
        const issued = this.codes.get(form.get("code") ?? "");
        if (!issued || issued.used || issued.redirectUri !== form.get("redirect_uri")) return this.json(400, { error: "invalid_grant" });
        issued.used = true;
        if ((await pkceChallenge(form.get("code_verifier") ?? "")) !== issued.challenge) return this.json(400, { error: "invalid_grant" });
        return this.json(200, this.tokenAnswer(issued.scopes));
      }
      if (form.get("grant_type") === "refresh_token") {
        if (this.refreshAnswer === "unavailable") return this.json(503, { error: "temporarily_unavailable" });
        const t = this.tokens.get(form.get("refresh_token") ?? "");
        if (this.refreshAnswer === "invalid_grant" || !t || t.kind !== "refresh" || t.revoked) return this.json(400, { error: "invalid_grant" });
        // Rotation: the used refresh token is spent.
        t.revoked = true;
        return this.json(200, this.tokenAnswer(t.scopes));
      }
      return this.json(400, { error: "unsupported_grant_type" });
    }
    if (url.href === "https://dash.cloudflare.com/oauth2/revoke") {
      if (form.get("client_id") !== CLIENT_ID || form.get("client_secret") !== CLIENT_SECRET) return this.json(401, { error: "invalid_client" });
      const token = form.get("token") ?? "";
      const t = this.tokens.get(token);
      if (t) t.revoked = true;
      this.revoked.push(token);
      return new Response(null, { status: 200 });
    }
    if (url.origin === "https://api.cloudflare.com" && url.pathname === "/client/v4/accounts") {
      if (!this.bearer(call)) return this.json(403, { success: false, errors: [{ code: 9109, message: "Unauthorized" }], result: null });
      const per = Number(url.searchParams.get("per_page") ?? 20);
      const page = Number(url.searchParams.get("page") ?? 1);
      const slice = this.accounts.slice((page - 1) * per, page * per);
      return this.json(200, { success: true, errors: [], messages: [], result: slice, result_info: { page, per_page: per, count: slice.length, total_count: this.accounts.length } });
    }
    const run = /^\/client\/v4\/accounts\/([0-9a-f]{32})\/ai\/run\/(.+)$/.exec(url.pathname);
    if (url.origin === "https://api.cloudflare.com" && run && call.method === "POST") {
      if (!this.bearer(call)) return this.json(401, { success: false, errors: [{ code: 10000, message: "Authentication error" }], result: null });
      return this.json(this.aiAnswer.status, this.aiAnswer.body, this.aiAnswer.headers ?? {});
    }
    return this.json(404, { error: `fake Cloudflare has no ${call.method} ${input}` });
  };

  private tokenAnswer(scopes: string[]): Record<string, unknown> {
    const out: Record<string, unknown> = { access_token: this.mint("access", scopes), expires_in: this.expiresIn, token_type: "bearer" };
    if (scopes.includes("offline_access")) out.refresh_token = this.mint("refresh", scopes);
    if (this.namesScopes) out.scope = scopes.join(" ");
    return out;
  }

  /** The token endpoint calls made so far. */
  tokenCalls(): Call[] {
    return this.calls.filter((c) => c.url === "https://dash.cloudflare.com/oauth2/token");
  }
}

/** Every scope the flow asks for. */
export const ALL_SCOPES = ["user-details.read", "account-settings.read", "artifacts.read", "artifacts.write", "ai.read", "ai.write", "offline_access"];
/** The required scopes and offline_access, Workers AI declined. */
export const NO_AI_SCOPES = ["user-details.read", "account-settings.read", "artifacts.read", "artifacts.write", "offline_access"];
