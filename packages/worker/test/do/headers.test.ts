import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index.ts";
import { JSON_CACHE_CONTROL, SECURITY_HEADERS } from "../../src/front/headers.ts";
import type { Env } from "../../src/env.ts";
import { env, newColony } from "./helpers.ts";

/**
 * Response headers through the Worker's own fetch handler (src/index.ts): every door gets the security headers, JSON that
 * sets no caching gets no-store, answers that set their own caching keep it, and streams still stream.
 */

const SITE = "https://ft.test";
const PAGE = "<!doctype html><title>FireTrident</title>";
const ASSET_CACHE = "public, max-age=0, must-revalidate";
const REMOTE = "https://upstream.test/git/ft-trunk/hono--trunk.git";
const enc = new TextEncoder();

/** Static assets as Workers serves them through ASSETS: the page for any path it has no file for (single-page-application). */
const assets = {
  fetch: async (input: Request | string | URL) => {
    const req = input instanceof Request ? input : new Request(input);
    const md = new URL(req.url).pathname === "/start.md";
    return new Response(md ? "# FireTrident\n" : PAGE, {
      headers: { "content-type": md ? "text/markdown" : "text/html; charset=utf-8", "cache-control": ASSET_CACHE, etag: '"page"' },
    });
  },
};

/** One public colony's trunk in Artifacts, for the git proxy (it keeps the first binding it sees for the isolate). */
const artifacts = {
  get: async () => ({
    info: async () => ({ remote: REMOTE }),
    createToken: async (scope: string) => ({ id: "tok-1", plaintext: "art_v1_00", scope, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }),
  }),
};

const testEnv = { ...env, ASSETS: assets, ARTIFACTS: artifacts, FT_PUBLIC_GIT: "hono" } as unknown as Env;

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${SITE}${path}`, init), testEnv, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

function expectSecurityHeaders(res: Response): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) expect(res.headers.get(name), name).toBe(value);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("response headers on every door of the Worker", () => {
  it("the front page: security headers, and the static assets' own caching", async () => {
    const res = await call("/", { headers: { accept: "text/html,*/*;q=0.8" } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(PAGE);
    expectSecurityHeaders(res);
    expect(res.headers.get("cache-control")).toBe(ASSET_CACHE);
    expect(res.headers.get("link")).toContain("/start.md");
  });

  it("start.md from the front door, for an agent that asks for markdown", async () => {
    const res = await call("/", { headers: { accept: "text/markdown" } });
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expectSecurityHeaders(res);
    expect(res.headers.get("cache-control")).toBe(ASSET_CACHE);
  });

  it("a colony page that reaches the Worker: the page from ASSETS with the security headers", async () => {
    const res = await call("/c/hono?replay=1");
    expect(await res.text()).toBe(PAGE);
    expectSecurityHeaders(res);
    expect(res.headers.get("cache-control")).toBe(ASSET_CACHE);
  });

  it("/api/about keeps its own no-store", async () => {
    const res = await call("/api/about");
    expect(res.status).toBe(200);
    expectSecurityHeaders(res);
    expect(res.headers.get("cache-control")).toBe(JSON_CACHE_CONTROL);
  });

  it("an API JSON answer that sets no caching gets no-store, errors too", async () => {
    const colony = await newColony();
    const res = await call(`/api/colonies/${colony.id}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { colony: { id: string } }).colony.id).toBe(colony.id);
    expectSecurityHeaders(res);
    expect(res.headers.get("cache-control")).toBe("no-store");

    const missing = await call("/api/no-such-route");
    expect(missing.status).toBe(404);
    expectSecurityHeaders(missing);
    expect(missing.headers.get("cache-control")).toBe("no-store");

    const health = await call("/healthz");
    expectSecurityHeaders(health);
    expect(health.headers.get("cache-control")).toBe("no-store");
  });

  it("/mcp and /sse refusals carry the headers", async () => {
    for (const path of ["/mcp", "/sse"]) {
      const res = await call(path, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(res.status, path).toBe(403);
      expectSecurityHeaders(res);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    const open = await call("/public/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expectSecurityHeaders(open);
  });

  it("the signing-key endpoint keeps its public max-age", async () => {
    const res = await call("/.well-known/firetrident-keys.json");
    expect(res.status).toBe(200);
    expectSecurityHeaders(res);
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("the git proxy keeps its no-cache", async () => {
    const refused = await call("/git/not-public.git/info/refs?service=git-upload-pack");
    expect(refused.status).toBe(404);
    expectSecurityHeaders(refused);
    expect(refused.headers.get("cache-control")).toBe("no-cache");

    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("001e# service=git-upload-pack\n0000", { headers: { "content-type": "application/x-git-upload-pack-advertisement" } }));
    const refs = await call("/git/hono.git/info/refs?service=git-upload-pack");
    expect(refs.status).toBe(200);
    expectSecurityHeaders(refs);
    expect(refs.headers.get("cache-control")).toBe("no-cache");
  });

  it("a git pack still streams: the first bytes arrive before the upstream has finished", async () => {
    let finish: () => void = () => undefined;
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode("0008NAK\n"));
        finish = () => {
          controller.enqueue(enc.encode("PACK-rest"));
          controller.close();
        };
      },
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(upstream, { headers: { "content-type": "application/x-git-upload-pack-result" } }));
    const body = enc.encode("0032want 0123456789012345678901234567890123456789\n00000009done\n");
    const res = await call("/git/hono.git/git-upload-pack", {
      method: "POST",
      headers: { "content-type": "application/x-git-upload-pack-request", "content-length": String(body.byteLength) },
      body,
    });
    expect(res.status).toBe(200);
    expectSecurityHeaders(res);
    expect(res.headers.get("cache-control")).toBe("no-cache");
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("0008NAK\n");
    finish();
    let rest = "";
    for (let next = await reader.read(); !next.done; next = await reader.read()) rest += new TextDecoder().decode(next.value);
    expect(rest).toBe("PACK-rest");
  });

  it("the live WebSocket upgrade passes untouched", async () => {
    const colony = await newColony();
    const res = await call(`/api/colonies/${colony.id}/live`, { headers: { upgrade: "websocket" } });
    expect(res.status).toBe(101);
    const ws = res.webSocket;
    expect(ws).toBeTruthy();
    ws!.accept();
    ws!.close(1000, "done");
  });
});
