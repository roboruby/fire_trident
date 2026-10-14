import type { Env } from "../env.ts";

/**
 * The front door, GET / (index.ts; "/" is in run_worker_first so the Worker sees it before the static assets). Browsers
 * get the landing page. An agent that asks for markdown (`Accept: text/markdown`) gets start.md, the page that answers
 * what FireTrident is and how to use it, from the static assets (packages/web/public/start.md). Both answers carry
 * `Link: </start.md>; rel="service-doc"` (RFC 8631), so any client can find that page, and `Vary: Accept`, so a cache
 * never hands one of them to a client that asked for the other.
 */

/** The agents' start page, a static asset. */
export const START_PATH = "/start.md";

/** The Link header GET / carries. */
export const START_LINK = `<${START_PATH}>; rel="service-doc"`;

const MARKDOWN = new Set(["text/markdown", "text/x-markdown"]);
const HTML = new Set(["text/html", "application/xhtml+xml"]);

/**
 * Whether an Accept header asks for markdown at least as much as for HTML: a markdown type listed by name with a q above
 * 0, and no lower than HTML's q (HTML by name, else any text type, else any type). A browser lists no markdown, so it
 * gets HTML.
 */
export function prefersMarkdown(accept: string | null | undefined): boolean {
  if (!accept) return false;
  let markdown = -1;
  let html = -1;
  let text = -1;
  let any = -1;
  for (const part of accept.split(",")) {
    const [range = "", ...params] = part.split(";").map((s) => s.trim().toLowerCase());
    let q = 1;
    for (const p of params) {
      const m = /^q\s*=\s*([0-9.]+)$/.exec(p);
      if (m) q = Math.min(1, Math.max(0, Number(m[1]) || 0));
    }
    if (MARKDOWN.has(range)) markdown = Math.max(markdown, q);
    else if (HTML.has(range)) html = Math.max(html, q);
    else if (range === "text/*") text = Math.max(text, q);
    else if (range === "*/*") any = Math.max(any, q);
  }
  if (markdown <= 0) return false;
  const htmlQ = html >= 0 ? html : text >= 0 ? text : Math.max(any, 0);
  return markdown >= htmlQ;
}

/** Adds `token` to the Vary header unless it is there already (or Vary is `*`). */
function varyOn(headers: Headers, token: string): void {
  const vary = headers.get("vary");
  const listed = (vary ?? "").split(",").map((s) => s.trim().toLowerCase());
  if (listed.includes("*") || listed.includes(token.toLowerCase())) return;
  headers.set("vary", vary ? `${vary}, ${token}` : token);
}

/** A copy of `res` with its headers changed, both answers of GET / marked with the Link and Vary headers. */
function frontDoorResponse(res: Response, set: Record<string, string> = {}): Response {
  const out = new Response(res.body, res);
  for (const [name, value] of Object.entries(set)) out.headers.set(name, value);
  out.headers.set("link", START_LINK);
  varyOn(out.headers, "Accept");
  return out;
}

/**
 * GET (and HEAD) /: start.md for a request that prefers markdown, the landing page for every other. When start.md is
 * missing from the assets (they answer a missing file with the page itself), the request gets the page.
 */
export async function frontDoor(req: Request, env: Pick<Env, "ASSETS">): Promise<Response> {
  if (prefersMarkdown(req.headers.get("accept"))) {
    const md = await env.ASSETS.fetch(new Request(new URL(START_PATH, req.url), { method: req.method === "HEAD" ? "HEAD" : "GET" }));
    const type = md.headers.get("content-type") ?? "";
    if (md.ok && !/^text\/html\b/i.test(type)) {
      return frontDoorResponse(md, { "content-type": "text/markdown; charset=utf-8", "content-location": START_PATH });
    }
    await md.body?.cancel();
  }
  return frontDoorResponse(await env.ASSETS.fetch(req));
}
