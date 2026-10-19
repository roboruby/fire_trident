import { SELF } from "cloudflare:test";
import { expect } from "vitest";
import { CookieJar, FakeGithub, type FakeUser } from "../accounts/fake-github.ts";
import { FakeArtifacts } from "../artifacts/fake-artifacts.ts";
import { ACCOUNT_A, ACCOUNT_B, FakeCloudflare } from "../cloudflare/fake-cloudflare.ts";

/**
 * The world around the Worker in the accounts end-to-end tests (test/e2e): GitHub, Cloudflare (OAuth, the accounts list,
 * Workers AI) and the person's Artifacts are fakes behind the global fetch, so the Worker and every Durable Object reach
 * them exactly as they reach the real ones, and anything else is refused. People use browsers (a cookie jar on the
 * Worker's fetch, redirects not followed) and agents speak MCP over HTTP to /mcp.
 */

export const ORIGIN = "https://ft.test";
/** The deployment's admin token (vitest.config.ts e2eBindings). */
export const ADMIN = "test-admin";

/** A Workers AI call as the fake saw it. */
export interface AiCall {
  account: string;
  model: string;
  bearer: string;
  input: Record<string, unknown>;
}

function envelope(status: number, result: unknown, errors: Array<{ code: number; message: string }> = []): Response {
  return new Response(JSON.stringify({ result, success: status < 400, errors, messages: [] }), { status, headers: { "content-type": "application/json" } });
}

/** Every outside service the Worker reaches, faked, and installed as the global fetch. */
export class Network {
  readonly github = new FakeGithub();
  readonly cloudflare = new FakeCloudflare({
    get now() {
      return Date.now();
    },
  });
  /** The Artifacts of the Cloudflare account a person chooses (ACCOUNT_A). */
  readonly artifacts = new FakeArtifacts({ accountId: ACCOUNT_A.id });
  readonly ai: AiCall[] = [];
  /** Calls to anywhere else (each is refused). */
  readonly unexpected: string[] = [];
  /** The reflex's answers by question id, over a clean default (low noul, a middling risk score). */
  clef: Record<string, unknown> = {};
  /** The second opinion's answer. */
  verdict: Record<string, unknown> = { verdict: "approve", needs_human: 0.05, off_intent: false, sensitive: false, confidence: 0.95, reason: "does what the intent asks" };
  private saved: typeof fetch | null = null;

  constructor() {
    // Two accounts, so connecting asks the person to choose one.
    this.cloudflare.accounts = [ACCOUNT_A, ACCOUNT_B];
  }

  install(): void {
    this.saved = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => this.route(input, init)) as typeof fetch;
  }

  uninstall(): void {
    if (this.saved) globalThis.fetch = this.saved;
    this.saved = null;
  }

  /** Whether `bearer` is an access token the fake Cloudflare issued, still good, with one of `scopes`. */
  live(bearer: string, scopes: readonly string[]): boolean {
    const t = this.cloudflare.tokens.get(bearer);
    return !!t && t.kind === "access" && !t.revoked && t.expiresAt > Date.now() && scopes.some((s) => t.scopes.includes(s));
  }

  /** The repositories of the person's Artifacts whose names start with `prefix`, as "namespace/name". */
  repos(prefix: string): string[] {
    return [...this.artifacts.namespaces.entries()].flatMap(([ns, repos]) => [...repos.keys()].filter((n) => n.startsWith(prefix)).map((n) => `${ns}/${n}`)).sort();
  }

  private async route(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const req = input instanceof Request && init === undefined ? input : new Request(input instanceof Request ? input.url : String(input), init);
    const url = new URL(req.url);
    const text = async () => (req.method === "GET" || req.method === "HEAD" ? undefined : new TextDecoder().decode(await req.arrayBuffer()));
    if (url.origin === "https://github.com" || url.origin === "https://api.github.com") {
      return this.github.fetch(req.url, { method: req.method, headers: req.headers, body: await text() });
    }
    if (url.origin === "https://dash.cloudflare.com" || (url.origin === "https://api.cloudflare.com" && url.pathname === "/client/v4/accounts")) {
      return this.cloudflare.fetch(req.url, { method: req.method, headers: req.headers, body: await text() });
    }
    const api = /^\/client\/v4\/accounts\/([0-9a-f]{32})\/(ai\/run|artifacts)\/(.*)$/.exec(url.pathname);
    if (url.origin === "https://api.cloudflare.com" && api) {
      const bearer = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "")?.[1] ?? "";
      if (api[2] === "ai/run") return this.runAi(api[1] ?? "", api[3] ?? "", bearer, req);
      // Artifacts takes the access token Cloudflare issued with the artifacts scopes; the fake Artifacts knows one token.
      if (!this.live(bearer, ["artifacts.write"])) return envelope(401, null, [{ code: 10000, message: "Authentication error" }]);
      const headers = new Headers(req.headers);
      headers.set("authorization", `Bearer ${this.artifacts.accessToken}`);
      return this.artifacts.fetch(new Request(req, { headers }));
    }
    if (url.origin === this.artifacts.gitHost) return this.artifacts.fetch(req);
    this.unexpected.push(`${req.method} ${url.origin}${url.pathname}`);
    throw new Error(`unexpected network call to ${url.host}`);
  }

  /** Workers AI: the reflex's questions answered from `clef`, the second opinion with `verdict`, each in Cloudflare's envelope. */
  private async runAi(account: string, model: string, bearer: string, req: Request): Promise<Response> {
    const input = (await req.json()) as Record<string, unknown>;
    this.ai.push({ account, model, bearer, input });
    if (!this.live(bearer, ["ai.read", "ai.write"])) return envelope(401, null, [{ code: 10000, message: "Authentication error" }]);
    const usage = { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 };
    if (input.questions && typeof input.questions === "object") {
      const answers = Object.fromEntries(
        Object.keys(input.questions as object).map((id) => [id, this.clef[id] ?? (id === "risk" ? { type: "score", score: 0.4, probabilities: {}, confidence: 0.9 } : { type: "noul", noul: 0.02 })]),
      );
      return envelope(200, { answers, usage });
    }
    return envelope(200, { response: JSON.stringify(this.verdict), usage });
  }
}

/** A person's browser on the Worker: cookies kept by path, this site's Origin on writes, redirects not followed. */
export class Browser {
  readonly jar = new CookieJar();

  async call(method: string, path: string, opts: { body?: unknown; origin?: string | null; bearer?: string } = {}): Promise<Response> {
    const url = new URL(path, ORIGIN);
    const headers = new Headers();
    const cookie = this.jar.header(url.pathname);
    if (cookie) headers.set("cookie", cookie);
    if (method !== "GET" && opts.origin !== null) headers.set("origin", opts.origin ?? ORIGIN);
    if (opts.bearer) headers.set("authorization", `Bearer ${opts.bearer}`);
    if (opts.body !== undefined) headers.set("content-type", "application/json");
    const res = await SELF.fetch(url.toString(), { method, headers, redirect: "manual", ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) });
    this.jar.take(res);
    return res;
  }

  /** A JSON call: the status and the parsed answer. */
  async json<T = any>(method: string, path: string, opts: { body?: unknown; origin?: string | null; bearer?: string } = {}): Promise<{ status: number; body: T }> {
    const res = await this.call(method, path, opts);
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
  }
}

/** A signed-up person: their browser, their account id and their GitHub login. */
export interface Person {
  browser: Browser;
  id: string;
  login: string;
}

/** The operator's own call with the admin token. */
export async function admin<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await SELF.fetch(`${ORIGIN}${path}`, {
    method,
    headers: { authorization: `Bearer ${ADMIN}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

/** A new person: the operator mints an invite code, the person signs in with GitHub and opens their account with it. */
export async function signUp(net: Network, user: FakeUser): Promise<Person> {
  const invite = await admin<{ code: string }>("POST", "/api/accounts/invites", {});
  expect(invite.status).toBe(201);
  const browser = new Browser();
  const start = await browser.call("GET", "/auth/github/start");
  expect(start.status).toBe(302);
  const back = new URL(net.github.authorize(start.headers.get("location") ?? "", user));
  const callback = await browser.call("GET", back.pathname + back.search);
  expect(callback.headers.get("location")).toBe(`${ORIGIN}/account?signin=invite`);
  const opened = await browser.json<{ account: { id: string } }>("POST", "/auth/github/invite", { body: { code: invite.body.code } });
  expect(opened.status).toBe(201);
  expect(browser.jar.has("__Host-ft_session")).toBe(true);
  return { browser, id: opened.body.account.id, login: user.login };
}

/**
 * Connect Cloudflare: start (the session cookie travels to /auth/cloudflare/start and the callback), consent on the fake
 * Cloudflare with `granted`, come back; then choose `account` when the connection reaches several. Returns where the
 * callback sent the person.
 */
export async function connectCloudflare(net: Network, p: Person, granted: readonly string[], account = ACCOUNT_A.id): Promise<string> {
  const start = await p.browser.call("GET", "/auth/cloudflare/start");
  expect(start.status).toBe(302);
  const { code, state } = net.cloudflare.authorize(start.headers.get("location") ?? "", [...granted]);
  const back = await p.browser.call("GET", `/auth/cloudflare/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`);
  expect(back.status).toBe(302);
  const location = back.headers.get("location") ?? "";
  if (location.endsWith("?cloudflare=choose")) {
    const chosen = await p.browser.json("POST", "/api/me/cloudflare/account", { body: { accountId: account } });
    expect(chosen.status).toBe(200);
    expect(chosen.body).toMatchObject({ state: "connected", account: { id: account } });
  }
  return location;
}

/** An MCP client over Streamable HTTP at /mcp, with a bearer token. */
export class McpClient {
  session: string | null = null;
  private n = 0;

  constructor(private readonly token: string) {}

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(this.session ? { "mcp-session-id": this.session, "mcp-protocol-version": "2025-06-18" } : {}),
    };
  }

  /** One JSON-RPC request: the HTTP status and the message (from JSON or the event stream). */
  async rpc(method: string, params?: unknown): Promise<{ status: number; message: any }> {
    const res = await SELF.fetch(`${ORIGIN}/mcp`, { method: "POST", headers: this.headers(), body: JSON.stringify({ jsonrpc: "2.0", id: ++this.n, method, ...(params !== undefined ? { params } : {}) }) });
    const issued = res.headers.get("mcp-session-id");
    if (issued && !this.session && res.ok) this.session = issued;
    const text = await res.text();
    if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
      const data = text
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .map((l) => l.slice(6));
      return { status: res.status, message: data.length > 0 ? JSON.parse(data[data.length - 1] ?? "null") : null };
    }
    return { status: res.status, message: text ? JSON.parse(text) : null };
  }

  /** Open the session. */
  async initialize(): Promise<{ status: number; message: any }> {
    const r = await this.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e-agent", version: "1" } });
    if (r.status === 200) await SELF.fetch(`${ORIGIN}/mcp`, { method: "POST", headers: this.headers(), body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
    return r;
  }

  /** Call a tool: its parsed answer, or the error the server or the gate gave. */
  async tool<T = any>(name: string, args: Record<string, unknown> = {}): Promise<{ status: number; ok: boolean; data: T; error?: string }> {
    const r = await this.rpc("tools/call", { name, arguments: args });
    if (r.message?.error) return { status: r.status, ok: false, data: null as T, error: String(r.message.error.message) };
    const content = r.message?.result?.content?.[0]?.text ?? "null";
    const isError = r.message?.result?.isError === true;
    let data: unknown = content;
    try {
      data = JSON.parse(content);
    } catch {
      // A plain-text answer.
    }
    return { status: r.status, ok: !isError, data: data as T, ...(isError ? { error: content } : {}) };
  }
}

/** Poll `read` until `check` passes or `timeoutMs` passes; the last value either way. */
export async function eventually<T>(read: () => Promise<T>, check: (v: T) => boolean, timeoutMs = 30_000): Promise<T> {
  const start = Date.now();
  let value = await read();
  while (!check(value) && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 100));
    value = await read();
  }
  return value;
}
