import type { Context, Hono } from "hono";
import type { Id, Landing, Path, Sha } from "@fire_trident/core";
import type { Env } from "../env.ts";
import { dispose, withArtifactsRetry } from "../artifacts/git.ts";
import { bindingFor } from "../artifacts/shards.ts";
import { ftError } from "../colony/errors.ts";
import { LANDING_REF } from "../trunk/landing-note.ts";
import type { ApiEnv } from "./app.ts";
import { publicColonies } from "./git-proxy.ts";

/**
 * A sandboxed preview of a colony's files as they stood at one landing (registered by createApi):
 *   GET /colonies/:id/preview/:commit/<path>   the file <path> of trunk at that landing's commit, as it is (a path that
 *                                              is empty or ends in "/" names its index.html)
 * `commit` is the trunk commit a landing made (40 hex, or a unique prefix of 7+) or the landing's id; a commit that no
 * landing made answers 404. The file is read the way the landing diff route reads one (api/landing.ts): its blob at the
 * commit from the trunk writer, its bytes through the Artifacts binding. It shows file contents, so it is served only
 * for colonies that are public already (listed in FT_PUBLIC_GIT or FT_PUBLIC_MCP, the diff route's policy); every other
 * colony answers 404.
 *
 * Contents are untrusted, so every answer is sandboxed: `Content-Security-Policy: sandbox` with nothing to load but
 * styles, images and fonts from this site (no script runs, no form submits, the page gets an opaque origin and no frame
 * may embed it), `X-Content-Type-Options: nosniff`, and a type chosen from the file's extension out of a short list;
 * every other file, scripts included, is served as plain text. A file over PREVIEW_FILE_BYTES is not served (413). A
 * commit named by its full 40 hex never changes, so its answers are cached as immutable; a prefix or a landing id is
 * resolved again on each read.
 */

/** Largest file the preview serves, in bytes. */
export const PREVIEW_FILE_BYTES = 512 * 1024;
/** Previews read at once in one isolate; more answer 503. */
export const PREVIEW_IN_FLIGHT = 16;
/** Longest path the preview takes, in characters. */
const MAX_PATH = 1024;

/**
 * The policy every preview answer carries: no script runs (no allow-scripts), nothing loads but styles, images and
 * fonts from this site, no base or form target, and no frame may embed it.
 */
export const PREVIEW_CSP = [
  "sandbox",
  "default-src 'none'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

/** How a pinned commit's answer is cached: its file at that commit never changes. */
export const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
/** How an answer for a prefix or a landing id is cached: checked again on every read. */
export const REVALIDATE_CACHE = "no-cache";

/** What a file is served as, by extension; any other file is plain text (TEXT). */
const TYPES: Readonly<Record<string, string>> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/vnd.microsoft.icon",
};
const TEXT = "text/plain; charset=utf-8";

/** Previews in flight in this isolate. */
let inFlight = 0;

/** Register the preview route (createApi). */
export function previewRoutes(app: Hono<ApiEnv>): void {
  app.get("/colonies/:id/preview/:commit/*", async (c) => {
    const id = colonyId(c);
    if (!isPublic(c.env, id)) {
      throw ftError(404, `colony ${id} does not show file contents here: only colonies listed in FT_PUBLIC_GIT or FT_PUBLIC_MCP do; list it there on the deployment to preview its files`);
    }
    const ref = commitRef(c.req.param("commit"));
    const path = previewPath(new URL(c.req.url).pathname);
    if (inFlight >= PREVIEW_IN_FLIGHT) {
      return new Response(JSON.stringify({ error: "busy: too many files are being previewed here; retry in a second" }), {
        status: 503,
        headers: { "content-type": "application/json; charset=utf-8", "Retry-After": "1" },
      });
    }
    inFlight++;
    try {
      const file = await previewFile(c.env, id, ref, path);
      const pinned = ref === file.trunkSha;
      return new Response(file.bytes, {
        status: 200,
        headers: {
          "Content-Type": contentTypeOf(path),
          "Content-Security-Policy": PREVIEW_CSP,
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": pinned ? IMMUTABLE_CACHE : REVALIDATE_CACHE,
          "X-FT-Commit": file.trunkSha,
        },
      });
    } finally {
      inFlight--;
    }
  });
}

/** One file of a landing's commit, read for the preview. */
export interface PreviewFile {
  landing: Landing;
  trunkSha: Sha;
  path: Path;
  blob: Sha;
  bytes: Uint8Array;
}

/**
 * The file `path` of colony `colonyId`'s trunk at the commit landing `ref` made. Throws a 404 for an unknown colony,
 * landing or file, a 413 for a file over PREVIEW_FILE_BYTES, and a 503 when the trunk repository does not give the file.
 */
export async function previewFile(env: Env, colonyId: Id, ref: string, path: Path): Promise<PreviewFile> {
  const record = await env.COLONY.get(env.COLONY.idFromName(colonyId)).getColony();
  if (!record) throw ftError(404, "colony not found");
  const writer = env.TRUNK.get(env.TRUNK.idFromName(colonyId));
  const found = await writer.landingNote(ref);
  if (!found) throw ftError(404, `no landing ${ref} in colony ${colonyId}: name a commit a landing made (or the landing's id)`);
  const { landing } = found;
  const blob = (await writer.baseBlobs(landing.trunkSha, [path]))[0]?.blob ?? null;
  if (!blob) throw ftError(404, `there is no file ${path} at commit ${landing.trunkSha.slice(0, 7)}: name a file the colony's trunk held there`);
  const binding = bindingFor(env, record.trunk.namespace) ?? env.ARTIFACTS;
  const bytes = await readBytes(binding, record.trunk.name, blob);
  if (bytes === "too-large") throw ftError(413, `${path} is over ${PREVIEW_FILE_BYTES / 1024} KB, too large to preview: read it from a plain git clone of the colony`);
  if (bytes === null) throw ftError(503, "the trunk repository did not return the file just now: try again in a moment");
  return { landing, trunkSha: landing.trunkSha, path, blob, bytes };
}

/** A blob's bytes through the binding; "too-large" past the cap, null when it cannot be read. */
async function readBytes(binding: Artifacts, name: string, blob: Sha): Promise<Uint8Array | "too-large" | null> {
  let repo: ArtifactsRepo;
  try {
    repo = await withArtifactsRetry(() => binding.get(name));
  } catch {
    return null;
  }
  try {
    const b = await withArtifactsRetry(() => repo.readBlob(blob));
    if (!b) return null;
    if (b.size > PREVIEW_FILE_BYTES) return "too-large";
    return new Uint8Array(await b.arrayBuffer());
  } catch {
    return null;
  } finally {
    dispose(repo);
  }
}

/**
 * The trunk path a preview URL names: what follows /preview/<commit>/, each segment percent-decoded, with index.html
 * for a path that is empty or ends in "/". Throws a 400 for a path that leaves the tree (".." or "."), has an empty
 * segment, a backslash or a control character, or is over 1,024 characters.
 */
export function previewPath(pathname: string): Path {
  const m = /\/colonies\/[^/]+\/preview\/[^/]+\/(.*)$/.exec(pathname);
  const raw = m?.[1] ?? "";
  const bad = (): Error => ftError(400, "name a file in the colony's trunk after the commit, as a relative path of at most 1,024 characters with no . or .. segment");
  const parts = raw === "" ? [] : raw.split("/");
  const segments: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    // A trailing slash names the folder's index.html.
    if (part === "" && i === parts.length - 1) break;
    let seg: string;
    try {
      seg = decodeURIComponent(part);
    } catch {
      throw bad();
    }
    if (seg === "" || seg === "." || seg === ".." || seg.includes("/") || seg.includes("\\") || /[\u0000-\u001f\u007f]/.test(seg)) throw bad();
    segments.push(seg);
  }
  const path = [...segments, ...(raw === "" || raw.endsWith("/") ? ["index.html"] : [])].join("/");
  if (path.length > MAX_PATH) throw bad();
  return path;
}

/** The Content-Type a file is served with, from its extension (TYPES); plain text for any other. */
export function contentTypeOf(path: Path): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? (TYPES[name.slice(dot + 1).toLowerCase()] ?? TEXT) : TEXT;
}

/** Colonies whose trunk is public already: plain git (FT_PUBLIC_GIT) or the public MCP (FT_PUBLIC_MCP) serves them. */
function isPublic(env: Env, id: Id): boolean {
  return publicColonies(env.FT_PUBLIC_GIT).has(id) || publicColonies(env.FT_PUBLIC_MCP).has(id);
}

function commitRef(raw: string | undefined): string {
  const ref = (raw ?? "").trim();
  if (!LANDING_REF.test(ref)) throw ftError(400, "name the commit as the trunk commit a landing made (7 to 40 hex characters) or the landing's id (lnd_...)");
  return ref;
}

function colonyId(c: Context<ApiEnv>): Id {
  const id = c.req.param("id") ?? "";
  if (!/^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/.test(id)) throw ftError(404, "colony not found");
  return id;
}
