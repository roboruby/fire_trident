import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { JSON_CACHE_CONTROL, REPORTED_POLICY, SECURITY_HEADERS, headersFile, needsNoStore, responseHeaders, withResponseHeaders } from "../../src/front/headers.ts";

/** Security headers on every answer, no-store on JSON that sets no caching, and the static assets' _headers file. */

/** The part of node:fs these tests use (the worker compiles against workers types, not Node's). */
interface Fs {
  readFileSync(path: URL, encoding: "utf8"): string;
}
const FS = "node:fs";
const { readFileSync } = (await import(FS)) as Fs;
// The tests run in Node, where a module knows its own URL (the workers types leave it out).
const HERE = (import.meta as ImportMeta & { url: string }).url;
const HEADERS_FILE = new URL("../../../web/public/_headers", HERE);
const enc = new TextEncoder();

function expectSecurityHeaders(res: Response): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) expect(res.headers.get(name), name).toBe(value);
}

/** The header rules of a _headers file, as Workers static assets reads them: a path line, then indented `name: value` lines. */
function parseHeadersFile(text: string): Record<string, Record<string, string>> {
  const rules: Record<string, Record<string, string>> = {};
  let path: string | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("/")) {
      path = line;
      rules[path] = {};
      continue;
    }
    const at = line.indexOf(":");
    if (path === null || at < 0) throw new Error(`not a header line: ${line}`);
    rules[path]![line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return rules;
}

describe("withResponseHeaders", () => {
  it("adds every security header", () => {
    const res = withResponseHeaders(new Response("<p>hi</p>", { headers: { "content-type": "text/html" } }));
    expectSecurityHeaders(res);
    expect(res.headers.get("content-type")).toBe("text/html");
  });

  it("puts no-store on JSON that sets no caching of its own, and on nothing else", () => {
    for (const type of ["application/json", "application/json; charset=utf-8", "application/problem+json"]) {
      expect(withResponseHeaders(new Response("{}", { headers: { "content-type": type } })).headers.get("cache-control"), type).toBe(JSON_CACHE_CONTROL);
    }
    for (const type of ["text/html; charset=utf-8", "text/plain", "text/event-stream", "application/x-git-upload-pack-result", "application/jsonl"]) {
      expect(withResponseHeaders(new Response("x", { headers: { "content-type": type } })).headers.get("cache-control"), type).toBeNull();
    }
    expect(withResponseHeaders(new Response(null, { status: 204 })).headers.get("cache-control")).toBeNull();
  });

  it("keeps the caching an answer sets itself", () => {
    const keys = withResponseHeaders(new Response("{}", { headers: { "content-type": "application/json", "cache-control": "public, max-age=300" } }));
    expect(keys.headers.get("cache-control")).toBe("public, max-age=300");
    const git = withResponseHeaders(new Response("x", { headers: { "content-type": "application/x-git-upload-pack-advertisement", "cache-control": "no-cache" } }));
    expect(git.headers.get("cache-control")).toBe("no-cache");
    const dated = withResponseHeaders(new Response("{}", { headers: { "content-type": "application/json", expires: "Thu, 01 Jan 2099 00:00:00 GMT" } }));
    expect(dated.headers.get("cache-control")).toBeNull();
    expect(needsNoStore(new Headers({ "content-type": "application/json", "Cache-Control": "max-age=5" }))).toBe(false);
  });

  it("keeps a security header the answer sets itself", () => {
    const res = withResponseHeaders(new Response("x", { headers: { "x-frame-options": "SAMEORIGIN", "referrer-policy": "no-referrer" } }));
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("copies an answer whose headers cannot change, keeping its status and headers", () => {
    const redirect = Response.redirect("https://ft.example/c/hono", 302);
    expect(() => redirect.headers.set("x-test", "1")).toThrow();
    const res = withResponseHeaders(redirect);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://ft.example/c/hono");
    expectSecurityHeaders(res);
  });

  it("hands the answer back as it is when it already has everything", () => {
    const res = withResponseHeaders(new Response("x", { headers: { ...SECURITY_HEADERS } }));
    expect(withResponseHeaders(res)).toBe(res);
  });

  it("passes a stream on unread: the first chunk arrives while the source is still open", async () => {
    let finish: () => void = () => undefined;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode("data: one\n\n"));
        finish = () => {
          controller.enqueue(enc.encode("data: two\n\n"));
          controller.close();
        };
      },
    });
    const res = withResponseHeaders(new Response(source, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } }));
    expectSecurityHeaders(res);
    const reader = res.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: one\n\n");
    finish();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: two\n\n");
    expect((await reader.read()).done).toBe(true);
  });
});

describe("responseHeaders middleware", () => {
  const app = new Hono();
  app.use("*", responseHeaders);
  app.get("/json", (c) => c.json({ ok: true }));
  app.get("/boom", () => {
    throw new Error("boom");
  });

  it("covers route answers, errors and unknown paths", async () => {
    for (const path of ["/json", "/boom", "/nowhere"]) {
      const res = await app.request(path);
      expectSecurityHeaders(res);
    }
    expect((await app.request("/json")).headers.get("cache-control")).toBe("no-store");
    expect((await app.request("/boom")).status).toBe(500);
  });
});

describe("packages/web/public/_headers", () => {
  const text = readFileSync(HEADERS_FILE, "utf8");

  it("gives every static asset the same security headers as the Worker", () => {
    const rules = parseHeadersFile(text);
    expect(Object.keys(rules)).toEqual(["/*"]);
    expect(rules["/*"]).toEqual({ ...SECURITY_HEADERS });
  });

  it("is headersFile() written out, within the static assets' line limit", () => {
    expect(text, "rewrite packages/web/public/_headers from headersFile() in src/front/headers.ts").toBe(headersFile());
    for (const line of text.split("\n")) expect(line.length).toBeLessThanOrEqual(2000);
  });
});

describe("the reported Content-Security-Policy", () => {
  const page = readFileSync(new URL("../../../web/index.html", HERE), "utf8");

  it("allows what index.html loads: same-origin scripts and stylesheets, a data: icon, inline styles", () => {
    const scripts = [...page.matchAll(/<script\b([^>]*)>/gi)].map((m) => m[1] ?? "");
    expect(scripts.length).toBeGreaterThan(0);
    for (const attrs of scripts) expect(attrs, "an inline or cross-origin script needs a policy change").toMatch(/\bsrc="\/[^/]/);
    for (const m of page.matchAll(/<link\b[^>]*\bhref="([^"]*)"/gi)) {
      const href = m[1] ?? "";
      if (/^https?:/i.test(href)) throw new Error(`index.html links a cross-origin file the policy would report: ${href}`);
    }
    expect(page).toMatch(/<link\s+rel="icon"\s+href="data:image\/svg\+xml,/);
    expect(REPORTED_POLICY).toContain("img-src 'self' data:");
    expect(REPORTED_POLICY).toContain("style-src 'self' 'unsafe-inline'");
    expect(REPORTED_POLICY).toContain("script-src 'self';");
  });
});
