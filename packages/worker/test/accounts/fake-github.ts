import { pkceChallenge } from "../../src/accounts/crypto.ts";

/**
 * The browser and GitHub stand-ins of the accounts tests, with no network and nothing Node-only, so the Node tests
 * (test/accounts) and the Worker's end-to-end tests (test/e2e) share them: a cookie jar that keeps cookies by path as a
 * browser does, and a GitHub OAuth server that checks the client secret, the redirect URI and PKCE.
 */

/** A browser's cookies: kept by name and path, sent where the path matches, dropped at Max-Age=0. */
export class CookieJar {
  private readonly jar = new Map<string, { value: string; path: string }>();

  /** Keep what a response set. */
  take(res: Response): void {
    for (const line of res.headers.getSetCookie()) {
      const [pair = "", ...attrs] = line.split(";").map((s) => s.trim());
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      const path = attrs.find((a) => a.toLowerCase().startsWith("path="))?.slice(5) ?? "/";
      const maxAge = attrs.find((a) => a.toLowerCase().startsWith("max-age="));
      if (maxAge && Number(maxAge.slice(8)) <= 0) this.jar.delete(name);
      else this.jar.set(name, { value, path });
    }
  }

  /** The Cookie header for a request to `path`. */
  header(path: string): string {
    return [...this.jar.entries()]
      .filter(([, c]) => path === c.path || path.startsWith(c.path.endsWith("/") ? c.path : `${c.path}/`))
      .map(([n, c]) => `${n}=${c.value}`)
      .join("; ");
  }

  has(name: string): boolean {
    return this.jar.has(name);
  }

  get(name: string): string | undefined {
    return this.jar.get(name)?.value;
  }

  set(name: string, value: string, path = "/"): void {
    this.jar.set(name, { value, path });
  }
}

/** A GitHub user the fake GitHub knows. */
export interface FakeUser {
  id: number;
  login: string;
  name?: string | null;
}

/**
 * A GitHub OAuth server with no network: `authorize` stands for the person approving the sign-in (it reads the
 * authorize URL FireTrident redirected to and issues a code for its challenge); the token endpoint checks the client id
 * and secret, the redirect URI, the code (once) and the PKCE verifier against that challenge; /user answers who the
 * token belongs to.
 */
export class FakeGithub {
  readonly requests: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
  private readonly codes = new Map<string, { user: FakeUser; challenge: string; redirectUri: string }>();
  private readonly tokens = new Map<string, FakeUser>();
  private n = 0;
  /** Make the token endpoint fail (GitHub down) or refuse. */
  tokenFailure: "none" | "refuse" | "down" = "none";

  /** The person approves the sign-in on GitHub: the callback URL GitHub sends the browser back to. */
  authorize(location: string, user: FakeUser): string {
    const u = new URL(location);
    if (u.origin + u.pathname !== "https://github.com/login/oauth/authorize") throw new Error(`not GitHub's authorize URL: ${location}`);
    if (u.searchParams.get("code_challenge_method") !== "S256") throw new Error("no S256 challenge");
    const code = `code-${++this.n}`;
    const redirectUri = u.searchParams.get("redirect_uri") ?? "";
    this.codes.set(code, { user, challenge: u.searchParams.get("code_challenge") ?? "", redirectUri });
    const back = new URL(redirectUri);
    back.searchParams.set("code", code);
    back.searchParams.set("state", u.searchParams.get("state") ?? "");
    return back.toString();
  }

  /** The fetch FireTrident's sign-in uses. */
  fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const body = typeof init.body === "string" ? init.body : "";
    this.requests.push({ url, body, headers });
    if (url === "https://github.com/login/oauth/access_token") {
      if (this.tokenFailure === "down") throw new TypeError("network down");
      const f = new URLSearchParams(body);
      const issued = this.codes.get(f.get("code") ?? "");
      const verifierOk = issued ? (await pkceChallenge(f.get("code_verifier") ?? "")) === issued.challenge : false;
      if (
        this.tokenFailure === "refuse" ||
        !issued ||
        f.get("client_id") !== "test-client-id" ||
        f.get("client_secret") !== "test-client-secret" ||
        f.get("redirect_uri") !== issued.redirectUri ||
        !verifierOk
      ) {
        return Response.json({ error: "bad_verification_code" });
      }
      this.codes.delete(f.get("code") ?? "");
      const token = `gho_fake_${++this.n}`;
      this.tokens.set(token, issued.user);
      return Response.json({ access_token: token, token_type: "bearer", scope: "" });
    }
    if (url === "https://api.github.com/user") {
      const user = this.tokens.get((headers.authorization ?? "").replace(/^Bearer /, ""));
      return user ? Response.json({ id: user.id, login: user.login, name: user.name ?? null }) : new Response("{}", { status: 401 });
    }
    return new Response("not found", { status: 404 });
  };
}
