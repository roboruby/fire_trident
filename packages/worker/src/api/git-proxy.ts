import { pushRefusal } from "@fire_trident/core";
import type { Env } from "../env.ts";
import { authHeaders, dispose, getRepoIfExists, mintToken, TokenCache } from "../artifacts/git.ts";
import { trunkRepoName } from "../artifacts/shards.ts";
import { colonyOwnerOf, colonyStorage } from "../artifacts/storage.ts";

/**
 * Read-only plain git for public colonies, over git's smart HTTP protocol:
 *
 *   GET  /git/<colony>.git/info/refs?service=git-upload-pack   ref advertisement (protocol v0, v1 or v2)
 *   POST /git/<colony>.git/git-upload-pack                      negotiation and pack
 *
 * Both go to the colony's trunk repo (`<colony>--trunk` in ft-trunk) with a read token the Worker
 * mints and keeps; the client never sees it. Pushes (git-receive-pack) get 403 and anything else
 * 404. Only colonies named in FT_PUBLIC_GIT are served; when it is empty or unset the proxy is off.
 *
 * A push is answered with a plain-text 403 because stock git prints each line of such a body as
 * "remote: <line>" before it gives up (an ERR packet in the advertisement prints as one "fatal: remote
 * error:" line instead): the colony's page, how a change reaches trunk, the command that adds the MCP
 * server that proposes, and the page with every client (pushRefused).
 */

/** Largest upload-pack request body accepted, in bytes, both as sent and after gzip decoding. */
export const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
/** Lifetime of a minted trunk read token. */
export const READ_TOKEN_TTL_S = 30 * 60;
/** A cached read token is replaced this long before it expires. */
export const READ_TOKEN_MARGIN_MS = 5 * 60_000;
/** How long a request waits for a trunk that is still being created or imported. */
const TRUNK_WAIT_MS = 10_000;

/** What git prints (as "remote: ...") when someone tries to push and the helpful answer cannot be built. */
export const PUSH_REFUSED = "This is a read-only view of a FireTrident colony. Changes land through the colony's agents, not git push.";

/**
 * The body of the 403 a push gets, one "remote:" line each in git's output (core/connect.ts pushRefusal), for the
 * deployment the request reached; PUSH_REFUSED when its origin is not one a command can carry.
 */
export function pushRefused(url: URL, colony: string): string {
  try {
    return pushRefusal(url.origin, colony).join("\n");
  } catch {
    return PUSH_REFUSED;
  }
}

const NOT_FOUND = "Repository not found.";
const TOO_LARGE = "Request body too large.";
const UNREADABLE = "Could not read the request body.";
const UNAVAILABLE = "The repository is unavailable right now. Try again.";
const UNREACHABLE = "The repository could not be reached. Try again.";

const ADVERTISEMENT = "application/x-git-upload-pack-advertisement";
const UPLOAD_REQUEST = "application/x-git-upload-pack-request";
const UPLOAD_RESULT = "application/x-git-upload-pack-result";

const COLONY_RE = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
const PATH_RE = /^\/git\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;
const GIT_PROTOCOL_RE = /^[A-Za-z0-9=:._-]{1,256}$/;

/** True for a colony slug: lowercase letters, digits and single hyphens, 1 to 48 characters, no hyphen at either end. */
export function isColonyName(name: string): boolean {
  return COLONY_RE.test(name) && !name.includes("--");
}

/** Colonies named in FT_PUBLIC_GIT (comma-separated). Entries that are not colony names are ignored; empty or unset means none. */
export function publicColonies(raw: string | undefined): Set<string> {
  const out = new Set<string>();
  for (const part of (raw ?? "").split(",")) {
    const name = part.trim();
    if (isColonyName(name)) out.add(name);
  }
  return out;
}

/** What a request under /git/ asks for. */
export type GitRoute =
  | { kind: "advertise"; colony: string }
  | { kind: "upload-pack"; colony: string }
  | { kind: "push"; colony: string }
  | { kind: "none" };

const NONE: GitRoute = { kind: "none" };

/** Classify a request under /git/ by method, path and `service`, before the allowlist is consulted. */
export function routeGitRequest(method: string, url: URL): GitRoute {
  const m = PATH_RE.exec(url.pathname);
  const colony = m?.[1];
  if (!m || colony === undefined || !isColonyName(colony)) return NONE;
  switch (m[2]) {
    case "info/refs": {
      if (method !== "GET") return NONE;
      const service = url.searchParams.get("service");
      if (service === "git-upload-pack") return { kind: "advertise", colony };
      if (service === "git-receive-pack") return { kind: "push", colony };
      return NONE;
    }
    case "git-upload-pack":
      return method === "POST" ? { kind: "upload-pack", colony } : NONE;
    default:
      return method === "POST" ? { kind: "push", colony } : NONE;
  }
}

/** How the proxy reaches trunks: ArtifactsTrunkAccess in the Worker, fakes in tests. */
export interface TrunkAccess {
  /** The trunk's git remote URL, or null when the colony has no trunk repo. */
  remote(colony: string): Promise<string | null>;
  /** A read token for the trunk, valid for at least a few more minutes. */
  token(colony: string): Promise<string>;
  /** Forget the cached token for `colony` (the remote refused it). */
  invalidate(colony: string): void;
}

/** What the proxy needs from its surroundings. */
export interface GitProxyDeps {
  trunk: TrunkAccess;
  /** Fetch from the upstream remote. */
  fetch(url: string, init: RequestInit): Promise<Response>;
}

/**
 * Serve one request under /git/ for the colonies in `publicGit` (FT_PUBLIC_GIT): upload-pack is
 * forwarded to the colony's trunk with a server-held read token, receive-pack gets 403 and
 * anything else 404.
 */
export async function handleGitRequest(req: Request, publicGit: string | undefined, deps: GitProxyDeps): Promise<Response> {
  const route = routeGitRequest(req.method, new URL(req.url));
  if (route.kind === "none" || !publicColonies(publicGit).has(route.colony)) return plain(404, NOT_FOUND);
  if (route.kind === "push") return plain(403, pushRefused(new URL(req.url), route.colony));
  const body = route.kind === "upload-pack" ? forwardBody(req) : null;
  if (body !== null && "refuse" in body) return body.refuse;
  let remote: string | null;
  try {
    remote = await deps.trunk.remote(route.colony);
  } catch {
    return plain(503, UNAVAILABLE);
  }
  if (remote === null) return plain(404, NOT_FOUND);
  if (body === null) return advertise(req, route.colony, remote, deps);
  return uploadPack(req, route.colony, remote, body, deps);
}

/** GET info/refs: one retry with a fresh token when the remote refuses the cached one. */
async function advertise(req: Request, colony: string, remote: string, deps: GitProxyDeps): Promise<Response> {
  const url = `${remote}/info/refs?service=git-upload-pack`;
  for (let attempt = 0; ; attempt++) {
    let token: string;
    try {
      token = await deps.trunk.token(colony);
    } catch {
      return plain(503, UNAVAILABLE);
    }
    let res: Response;
    try {
      res = await deps.fetch(url, { method: "GET", headers: upstreamHeaders(req, token, { Accept: "*/*" }) });
    } catch {
      return plain(502, UNREACHABLE);
    }
    if (attempt === 0 && refusedToken(res)) {
      await discard(res);
      deps.trunk.invalidate(colony);
      continue;
    }
    return relay(res, colony, deps, ADVERTISEMENT);
  }
}

/** POST git-upload-pack: the (decoded, capped) body streams up, the result streams back. */
async function uploadPack(req: Request, colony: string, remote: string, body: ForwardBody, deps: GitProxyDeps): Promise<Response> {
  let token: string;
  try {
    token = await deps.trunk.token(colony);
  } catch {
    await body.stream.cancel().catch(() => undefined);
    return plain(503, UNAVAILABLE);
  }
  let res: Response;
  try {
    res = await deps.fetch(`${remote}/git-upload-pack`, {
      method: "POST",
      headers: upstreamHeaders(req, token, { "Content-Type": UPLOAD_REQUEST, Accept: UPLOAD_RESULT }),
      body: body.stream,
    });
  } catch {
    return body.fault.reason ? faultResponse(body.fault.reason) : plain(502, UNREACHABLE);
  }
  if (body.fault.reason) {
    await discard(res);
    return faultResponse(body.fault.reason);
  }
  return relay(res, colony, deps, UPLOAD_RESULT);
}

/** Why a request body could not be forwarded. */
interface BodyFault {
  reason?: "too-large" | "unreadable";
}

/** An upload-pack request body ready to forward; `fault` says why it failed, if it did. */
interface ForwardBody {
  stream: ReadableStream<Uint8Array>;
  fault: BodyFault;
}

/**
 * The upload-pack request body to forward: gzip is decoded here, and the body is capped at
 * `limit` bytes as sent and after decoding. A body of declared length within the cap passes
 * through untouched. Returns the response that refuses the request instead when it cannot be
 * forwarded.
 */
export function forwardBody(req: Request, limit = MAX_REQUEST_BYTES): ForwardBody | { refuse: Response } {
  const encoding = (req.headers.get("content-encoding") ?? "identity").trim().toLowerCase();
  const gzip = encoding === "gzip" || encoding === "x-gzip";
  if (!gzip && encoding !== "identity") return { refuse: plain(415, "Unsupported Content-Encoding.") };
  const declared = req.headers.get("content-length");
  if (declared !== null && !/^\d+$/.test(declared.trim())) return { refuse: plain(400, UNREADABLE) };
  if (declared !== null && Number(declared) > limit) return { refuse: plain(413, TOO_LARGE) };
  const src = req.body as ReadableStream<Uint8Array> | null;
  if (src === null) return { refuse: plain(400, UNREADABLE) };
  const fault: BodyFault = {};
  if (!gzip && declared !== null) return { stream: src, fault };
  const raw = capped(src, limit, fault);
  return { stream: gzip ? capped(raw.pipeThrough(new DecompressionStream("gzip")), limit, fault) : raw, fault };
}

/** `src` unchanged until more than `limit` bytes have passed, then an error; a failed read of `src` is recorded in `fault`. */
function capped(src: ReadableStream<Uint8Array>, limit: number, fault: BodyFault): ReadableStream<Uint8Array> {
  const reader = src.getReader();
  let seen = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let next: Awaited<ReturnType<typeof reader.read>>;
      try {
        next = await reader.read();
      } catch (e) {
        fault.reason ??= "unreadable";
        controller.error(e);
        return;
      }
      if (next.done) {
        controller.close();
        return;
      }
      seen += next.value.byteLength;
      if (seen > limit) {
        fault.reason = "too-large";
        controller.error(new RangeError(TOO_LARGE));
        void reader.cancel().catch(() => undefined);
        return;
      }
      controller.enqueue(next.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

function faultResponse(reason: NonNullable<BodyFault["reason"]>): Response {
  return reason === "too-large" ? plain(413, TOO_LARGE) : plain(400, UNREADABLE);
}

/** Upstream headers: our token plus the client's protocol version and agent; nothing else of the client's goes up. */
function upstreamHeaders(req: Request, token: string, extra: Record<string, string>): Headers {
  const h = new Headers({ ...extra, ...authHeaders(token) });
  const protocol = req.headers.get("git-protocol");
  if (protocol !== null && GIT_PROTOCOL_RE.test(protocol)) h.set("Git-Protocol", protocol);
  const agent = req.headers.get("user-agent");
  if (agent !== null && agent.length <= 256) h.set("User-Agent", agent);
  return h;
}

/** Success streams through with its content type; failures become short plain-text errors git prints as "remote: ...". */
async function relay(res: Response, colony: string, deps: GitProxyDeps, contentType: string): Promise<Response> {
  if (res.ok) {
    return new Response(res.body, {
      status: res.status,
      headers: { "Content-Type": res.headers.get("content-type") ?? contentType, "Cache-Control": "no-cache" },
    });
  }
  await discard(res);
  if (res.status === 404) return plain(404, NOT_FOUND);
  if (refusedToken(res)) {
    // Never pass a 401 on: git would ask the user for credentials that do not exist.
    deps.trunk.invalidate(colony);
    return plain(503, UNAVAILABLE);
  }
  if (res.status >= 500) return plain(502, UNREACHABLE);
  return plain(res.status, `The repository refused the request (HTTP ${res.status}).`);
}

function refusedToken(res: Response): boolean {
  return res.status === 401 || res.status === 403;
}

async function discard(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => undefined);
}

function plain(status: number, message: string): Response {
  return new Response(`${message}\n`, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" } });
}

/**
 * Trunk access through the ARTIFACTS binding, cached for the life of the isolate: a trunk's
 * remote URL once found, and one read token per colony until shortly before it expires.
 */
export class ArtifactsTrunkAccess implements TrunkAccess {
  private readonly remotes = new Map<string, Promise<string | null>>();
  private readonly tokens = new Map<string, TokenCache>();
  private readonly owned = new Map<string, Promise<Artifacts>>();

  /**
   * `ownedTrunk`, when given, answers the trunk binding of a colony a person owns, in that person's Cloudflare account
   * (artifacts/storage.ts), and null for an operator colony, whose trunk is in `binding`. Its answer is kept per colony.
   */
  constructor(
    private readonly binding: Artifacts,
    private readonly ownedTrunk?: (colony: string) => Promise<Artifacts | null>,
  ) {}

  /** The binding that holds the colony's trunk; a failed lookup is not cached. */
  private bindingOf(colony: string): Promise<Artifacts> {
    if (!this.ownedTrunk) return Promise.resolve(this.binding);
    let found = this.owned.get(colony);
    if (!found) {
      found = this.ownedTrunk(colony).then((b) => b ?? this.binding);
      this.owned.set(colony, found);
      found.catch(() => this.owned.delete(colony));
    }
    return found;
  }

  /** The trunk's remote URL; a missing trunk or a failed lookup is not cached. */
  remote(colony: string): Promise<string | null> {
    let found = this.remotes.get(colony);
    if (!found) {
      found = this.lookup(colony);
      this.remotes.set(colony, found);
      found.then(
        (remote) => {
          if (remote === null) this.remotes.delete(colony);
        },
        () => this.remotes.delete(colony),
      );
    }
    return found;
  }

  /** A read token minted with mintToken, shared by every request in this isolate. */
  async token(colony: string): Promise<string> {
    let cache = this.tokens.get(colony);
    if (!cache) {
      cache = new TokenCache(async () => mintToken(await this.bindingOf(colony), trunkRepoName(colony), "read", READ_TOKEN_TTL_S), READ_TOKEN_MARGIN_MS);
      this.tokens.set(colony, cache);
    }
    return (await cache.get()).token;
  }

  /** Drop the cached token; the next request mints a new one. */
  invalidate(colony: string): void {
    this.tokens.get(colony)?.invalidate();
  }

  private async lookup(colony: string): Promise<string | null> {
    const repo = await getRepoIfExists(await this.bindingOf(colony), trunkRepoName(colony), TRUNK_WAIT_MS);
    if (repo === null) return null;
    try {
      return (await repo.info()).remote;
    } finally {
      dispose(repo);
    }
  }
}

let shared: ArtifactsTrunkAccess | null = null;

/** The Worker's handler for /git/*: read-only plain git for the colonies in FT_PUBLIC_GIT. */
export function gitProxy(req: Request, env: Env): Promise<Response> {
  // A public colony a person owns is served from the trunk in their Cloudflare account (artifacts/storage.ts).
  shared ??= new ArtifactsTrunkAccess(env.ARTIFACTS, async (colony) => {
    const owner = await colonyOwnerOf(env, colony);
    return owner ? colonyStorage(env, owner).trunk : null;
  });
  return handleGitRequest(req, env.FT_PUBLIC_GIT, { trunk: shared, fetch: (url, init) => fetch(url, init) });
}
