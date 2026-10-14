import { describe, expect, it } from "vitest";
import { START_LINK, frontDoor, prefersMarkdown } from "../../src/front/door.ts";

/** GET /: the landing page for browsers, start.md for agents that ask for markdown, and a Link to start.md for both. */

/** The part of node:fs these tests use (the worker compiles against workers types, not Node's). */
interface Fs {
  existsSync(path: URL): boolean;
  readFileSync(path: URL, encoding: "utf8"): string;
}
const FS = "node:fs";
const { existsSync, readFileSync } = (await import(FS)) as Fs;
// The tests run in Node, where a module knows its own URL (the workers types leave it out).
const HERE = (import.meta as ImportMeta & { url: string }).url;

const SITE = "https://firetrident.com";
const BROWSER = "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";
const PAGE = "<!doctype html><title>FireTrident</title>";
const START = "# FireTrident\n\nA colony, not a queue.\n";

interface Seen {
  path: string;
  method: string;
}

/** Static assets as the Worker sees them: a missing file answers with the page itself (single-page-application). */
function assets(files: Record<string, string> = { "/index.html": PAGE, "/start.md": START }) {
  const seen: Seen[] = [];
  const fetcher = {
    fetch: async (input: Request | string | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      const url = new URL(req.url);
      seen.push({ path: url.pathname, method: req.method });
      const path = url.pathname === "/" ? "/index.html" : url.pathname;
      const found = files[path];
      const file = found === undefined ? "/index.html" : path;
      const body = files[file] ?? "";
      const etag = `"${file}"`;
      const type = file.endsWith(".md") ? "text/markdown" : "text/html; charset=utf-8";
      if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { etag, vary: "Accept-Encoding" } });
      return new Response(req.method === "HEAD" ? null : body, { headers: { "content-type": type, etag, vary: "Accept-Encoding" } });
    },
  };
  return { env: { ASSETS: fetcher as unknown as Fetcher }, seen };
}

const get = (accept: string | null, extra: Record<string, string> = {}, method = "GET") => new Request(`${SITE}/`, { method, headers: { ...(accept === null ? {} : { accept }), ...extra } });

describe("which requests prefer markdown", () => {
  it("a markdown type named with a q no lower than HTML's", () => {
    expect(prefersMarkdown("text/markdown")).toBe(true);
    expect(prefersMarkdown("text/x-markdown")).toBe(true);
    expect(prefersMarkdown("text/markdown, text/html;q=0.9")).toBe(true);
    expect(prefersMarkdown("text/html, text/markdown")).toBe(true);
    expect(prefersMarkdown("Text/Markdown; charset=utf-8, */*;q=0.1")).toBe(true);
    expect(prefersMarkdown("text/markdown;q=0.5, text/plain")).toBe(true);
  });

  it("never a browser, a client that takes anything, or markdown ranked below HTML", () => {
    expect(prefersMarkdown(BROWSER)).toBe(false);
    expect(prefersMarkdown("*/*")).toBe(false);
    expect(prefersMarkdown(null)).toBe(false);
    expect(prefersMarkdown("")).toBe(false);
    expect(prefersMarkdown("text/markdown;q=0")).toBe(false);
    expect(prefersMarkdown("text/markdown;q=0.5, text/html")).toBe(false);
    expect(prefersMarkdown("text/markdown;q=0.5, text/*;q=0.8")).toBe(false);
    expect(prefersMarkdown("text/markdown;q=0.5, */*")).toBe(false);
  });
});

describe("GET /", () => {
  it("gives a browser the landing page, with the Link to start.md and Vary: Accept", async () => {
    const { env, seen } = assets();
    const res = await frontDoor(get(BROWSER), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toBe(PAGE);
    expect(res.headers.get("link")).toBe('</start.md>; rel="service-doc"');
    expect(res.headers.get("vary")).toBe("Accept-Encoding, Accept");
    expect(seen).toEqual([{ path: "/", method: "GET" }]);
  });

  it("gives an agent that asks for markdown start.md, saying where it lives", async () => {
    const { env, seen } = assets();
    const res = await frontDoor(get("text/markdown, text/html;q=0.5"), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(res.headers.get("content-location")).toBe("/start.md");
    expect(res.headers.get("link")).toBe(START_LINK);
    expect(res.headers.get("vary")).toBe("Accept-Encoding, Accept");
    expect(await res.text()).toBe(START);
    expect(seen).toEqual([{ path: "/start.md", method: "GET" }]);
  });

  it("answers HEAD the same way, without a body", async () => {
    const { env, seen } = assets();
    const res = await frontDoor(get("text/markdown", {}, "HEAD"), env);
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(res.body).toBeNull();
    expect(seen).toEqual([{ path: "/start.md", method: "HEAD" }]);
  });

  it("serves the page when start.md is missing from the assets", async () => {
    const { env, seen } = assets({ "/index.html": PAGE });
    const res = await frontDoor(get("text/markdown"), env);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toBe(PAGE);
    expect(res.headers.get("link")).toBe(START_LINK);
    expect(seen.map((s) => s.path)).toEqual(["/start.md", "/"]);
  });

  it("keeps a browser's cache working: a matching ETag still answers 304, marked like the page", async () => {
    const { env } = assets();
    const res = await frontDoor(get(BROWSER, { "if-none-match": '"/index.html"' }), env);
    expect(res.status).toBe(304);
    expect(res.headers.get("link")).toBe(START_LINK);
    expect(res.headers.get("vary")).toBe("Accept-Encoding, Accept");
  });
});

describe("the deployment serves the front door", () => {
  const config = JSON.parse(readFileSync(new URL("../../wrangler.jsonc", HERE), "utf8")) as {
    assets: { not_found_handling: string; run_worker_first: string[] };
    version_metadata?: { binding: string };
    previews: { version_metadata?: { binding: string } };
  };

  it("runs the Worker first for / only: llms.txt and start.md are files, served before the single-page fallback", () => {
    expect(config.assets.not_found_handling).toBe("single-page-application");
    expect(config.assets.run_worker_first).toContain("/");
    expect(config.assets.run_worker_first).toContain("/api/*");
    for (const pattern of config.assets.run_worker_first) expect(["/*", "*", "/llms.txt", "/start.md"]).not.toContain(pattern);
    for (const file of ["llms.txt", "start.md"]) expect(existsSync(new URL(`../../../web/public/${file}`, HERE)), file).toBe(true);
  });

  it("binds the version metadata in production and in previews, for GET /api/about", () => {
    expect(config.version_metadata).toEqual({ binding: "CF_VERSION_METADATA" });
    expect(config.previews.version_metadata).toEqual({ binding: "CF_VERSION_METADATA" });
  });
});
