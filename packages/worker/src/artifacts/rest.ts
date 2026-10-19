import { errorText } from "./git.ts";

/**
 * Artifacts over Cloudflare's REST API, for a colony whose repositories live in a person's own Cloudflare account
 * (artifacts/storage.ts). The object artifactsOverRest returns has the Artifacts binding's interface, so the code that
 * uses `env.ARTIFACTS` and the workspace bindings today takes it unchanged. The methods FireTrident calls are
 * create, get, import, list and delete on a namespace, and createToken, revokeToken, info, readBlob, readTree,
 * readCommit, log and fork on a repository; listTokens and readFile complete the interface.
 *
 * Every call asks `credentials` for the account and its access token (a connection refreshes its token as it nears
 * expiry), sends it as a bearer token, and never puts it in a URL, a message or a log line. Repositories made here are
 * reached by git exactly like the binding's: the remote and the repository token the API returns.
 *
 * Errors come back shaped like the binding's ArtifactsError: `code` carries the same string codes (ALREADY_EXISTS,
 * NOT_FOUND, the *_IN_PROGRESS codes, INTERNAL_ERROR and the rest), read from Cloudflare's numeric error code or, when
 * the answer has none, from the HTTP status, so artifactsCode, withArtifactsRetry and getRepoIfExists retry and stay
 * idempotent as they do with the binding. Two codes exist only here: UNAUTHORIZED (Cloudflare refused the token: HTTP
 * 401 or 403) and NOT_CONNECTED (no credentials to send). Neither is retried.
 *
 * Endpoints (developers.cloudflare.com/artifacts/api/rest-api, checked against Cloudflare's API schema), relative to
 * /accounts/{account}/artifacts: POST and GET /namespaces/{ns}; under /namespaces/{ns}/repos: POST (create), GET
 * (list), GET and DELETE /{name}, POST /{name}/fork, POST /{name}/import, GET /{name}/log, /{name}/commit/{hash},
 * /{name}/tree/{hash}, /{name}/blob/{hash}, /{name}/file and /{name}/tokens; POST /namespaces/{ns}/tokens and DELETE
 * /namespaces/{ns}/tokens/{id}. Repository metadata comes back in snake_case and is renamed to the binding's
 * camelCase; commits, logs and trees already have the binding's shape.
 */

/** Cloudflare's v4 API. */
export const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

/** What a call authenticates with: the Cloudflare account and an access token for it. */
export interface RestCredentials {
  accountId: string;
  accessToken: string;
}

/** Options of artifactsOverRest. */
export interface RestArtifactsOptions {
  /** The Artifacts namespace in that account. */
  namespace: string;
  /** The account and token, asked for on every call; null refuses the call with NOT_CONNECTED. */
  credentials: () => Promise<RestCredentials | null>;
  /** The sentence a NOT_CONNECTED refusal carries. */
  notConnected?: string;
  /** fetch to use (tests pass a fake server); defaults to the global fetch. */
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  /** API base; defaults to CLOUDFLARE_API. */
  base?: string;
}

/** An Artifacts REST failure, shaped like the binding's ArtifactsError: `code` is what artifactsCode reads. */
export class ArtifactsRestError extends Error {
  override readonly name = "ArtifactsError";

  constructor(
    readonly code: string,
    /** Cloudflare's numeric error code, or the HTTP status when the answer had none (0: no answer at all). */
    readonly numericCode: number,
    /** HTTP status of the answer (0: no answer at all). */
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Cloudflare's numeric Artifacts error codes (developers.cloudflare.com/artifacts/api/errors) and the binding's names for them. */
const NUMERIC_CODES: Readonly<Record<number, string>> = {
  10100: "INVALID_INPUT",
  10101: "INVALID_REPO_NAME",
  10103: "INVALID_TTL",
  10104: "INVALID_URL",
  10106: "REMOTE_AUTH_REQUIRED",
  10200: "NOT_FOUND",
  10201: "ALREADY_EXISTS",
  10302: "IMPORT_IN_PROGRESS",
  10303: "FORK_IN_PROGRESS",
  10400: "INTERNAL_ERROR",
  10401: "UPSTREAM_UNAVAILABLE",
  10402: "MEMORY_LIMIT",
};

const DEFAULT_NOT_CONNECTED = "This colony's repositories are in its owner's Cloudflare account, and no working Cloudflare connection is on file for that account. The owner can connect Cloudflare again on the account page.";

/** What a 409 means for a call: a create, fork or import says the target exists; a read says the repository is still being made. */
type ConflictMeans = "ALREADY_EXISTS" | "CREATE_IN_PROGRESS";

/** The binding's code for a failed answer: Cloudflare's numeric code when it is a known one, else the HTTP status. */
export function restErrorCode(status: number, numeric: number | undefined, conflict: ConflictMeans = "ALREADY_EXISTS"): string {
  const known = numeric === undefined ? undefined : NUMERIC_CODES[numeric];
  if (known !== undefined) return known;
  if (status === 401 || status === 403) return "UNAUTHORIZED";
  if (status === 404) return "NOT_FOUND";
  if (status === 409) return conflict;
  if (status === 413) return "MEMORY_LIMIT";
  if (status === 422) return "INVALID_URL";
  if (status === 502 || status === 503 || status === 504) return "UPSTREAM_UNAVAILABLE";
  if (status === 429 || status >= 500) return "INTERNAL_ERROR";
  return "INVALID_INPUT";
}

interface Envelope<T> {
  result?: T | null;
  success?: boolean;
  errors?: Array<{ code?: unknown; message?: unknown }>;
  result_info?: { cursor?: unknown; total_count?: unknown; count?: unknown };
}

interface RestRepoInfo {
  id: string;
  name: string;
  description?: string | null;
  default_branch?: string;
  created_at?: string;
  updated_at?: string;
  last_push_at?: string | null;
  source?: string | null;
  read_only?: boolean;
  remote?: string;
}

interface RestCreated {
  id: string;
  name: string;
  description?: string | null;
  default_branch?: string;
  remote: string;
  token: string;
}

interface RestToken {
  id: string;
  plaintext?: string;
  scope: "read" | "write";
  state?: "active" | "expired" | "revoked";
  created_at?: string;
  expires_at: string;
}

/** One call: what it is (for messages), its method and path below the namespace, and what its 409 means. */
interface Call {
  op: string;
  method: "GET" | "POST" | "DELETE";
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  conflict?: ConflictMeans;
  /** Below the account's /artifacts instead of the namespace (namespace routes). */
  account?: boolean;
}

/** Namespaces this isolate has seen exist, by "<account>/<namespace>" (each is checked once, then trusted). */
const knownNamespaces = new Set<string>();

/** Forget which namespaces exist (tests). */
export function forgetKnownNamespaces(): void {
  knownNamespaces.clear();
}

/** The REST client one Artifacts object uses. */
class RestApi {
  readonly namespace: string;
  private readonly credentials: () => Promise<RestCredentials | null>;
  private readonly notConnected: string;
  private readonly fetcher: (input: string, init: RequestInit) => Promise<Response>;
  private readonly base: string;

  constructor(o: RestArtifactsOptions) {
    this.namespace = o.namespace;
    this.credentials = o.credentials;
    this.notConnected = o.notConnected ?? DEFAULT_NOT_CONNECTED;
    this.fetcher = o.fetch ?? ((input, init) => fetch(input, init));
    this.base = (o.base ?? CLOUDFLARE_API).replace(/\/+$/, "");
  }

  /** Send a call and return its answer when it succeeded; a failure throws an ArtifactsRestError. */
  async send(c: Call): Promise<Response> {
    const cred = await this.credentials();
    if (!cred || !cred.accountId || !cred.accessToken) throw new ArtifactsRestError("NOT_CONNECTED", 0, 0, this.notConnected);
    const root = `${this.base}/accounts/${encodeURIComponent(cred.accountId)}/artifacts`;
    const under = c.account ? root : `${root}/namespaces/${encodeURIComponent(this.namespace)}`;
    const query = Object.entries(c.query ?? {}).filter((e): e is [string, string | number] => e[1] !== undefined && e[1] !== "");
    const url = `${under}${c.path}${query.length > 0 ? `?${new URLSearchParams(query.map(([k, v]) => [k, String(v)])).toString()}` : ""}`;
    const headers: Record<string, string> = { Authorization: `Bearer ${cred.accessToken}` };
    if (c.body !== undefined) headers["Content-Type"] = "application/json";
    let res: Response;
    try {
      res = await this.fetcher(url, { method: c.method, headers, ...(c.body !== undefined ? { body: JSON.stringify(c.body) } : {}) });
    } catch (e) {
      throw new ArtifactsRestError("INTERNAL_ERROR", 0, 0, `Artifacts ${c.op} could not reach Cloudflare: ${errorText(e)}`);
    }
    if (res.ok) return res;
    throw await this.failure(c, res);
  }

  /** The JSON result of a call. */
  async json<T>(c: Call): Promise<{ result: T; info: Envelope<T>["result_info"] }> {
    const res = await this.send(c);
    let body: Envelope<T>;
    try {
      body = (await res.json()) as Envelope<T>;
    } catch {
      throw new ArtifactsRestError("INTERNAL_ERROR", res.status, res.status, `Artifacts ${c.op} answered with a body that is not JSON (HTTP ${res.status}).`);
    }
    if (body?.success === false || body?.result === undefined || body.result === null) {
      const numeric = firstCode(body);
      throw new ArtifactsRestError(restErrorCode(res.status, numeric, c.conflict), numeric ?? res.status, res.status, `Artifacts ${c.op} failed: ${firstMessage(body) || "Cloudflare answered without a result"}.`);
    }
    return { result: body.result, info: body.result_info };
  }

  /** Make sure the namespace exists before a repository is made in it (once per isolate per namespace). */
  async ensureNamespace(): Promise<void> {
    const cred = await this.credentials();
    const key = `${cred?.accountId ?? ""}/${this.namespace}`;
    if (knownNamespaces.has(key)) return;
    try {
      await this.send({ op: `lookup of namespace ${this.namespace}`, method: "GET", path: `/namespaces/${encodeURIComponent(this.namespace)}`, account: true });
    } catch (e) {
      if ((e as { code?: unknown }).code !== "NOT_FOUND") throw e;
      try {
        await this.send({ op: `creation of namespace ${this.namespace}`, method: "POST", path: "/namespaces", body: { namespace: this.namespace }, account: true });
      } catch (err) {
        if ((err as { code?: unknown }).code !== "ALREADY_EXISTS") throw err;
      }
    }
    knownNamespaces.add(key);
  }

  private async failure(c: Call, res: Response): Promise<ArtifactsRestError> {
    let body: Envelope<unknown> | null = null;
    try {
      body = (await res.json()) as Envelope<unknown>;
    } catch {
      // Not JSON: the status speaks for the answer.
    }
    const numeric = firstCode(body);
    const code = restErrorCode(res.status, numeric, c.conflict);
    const said = firstMessage(body);
    if (code === "UNAUTHORIZED") {
      return new ArtifactsRestError(
        code,
        numeric ?? res.status,
        res.status,
        `Cloudflare refused the ${c.op} with the colony owner's connection (HTTP ${res.status}${said ? `: ${said}` : ""}). The owner can connect Cloudflare again on the account page and allow Artifacts.`,
      );
    }
    return new ArtifactsRestError(code, numeric ?? res.status, res.status, `Artifacts ${c.op} failed (HTTP ${res.status}${numeric !== undefined ? `, code ${numeric}` : ""})${said ? `: ${said}` : ""}.`);
  }
}

function firstCode(body: Envelope<unknown> | null): number | undefined {
  const code = body?.errors?.[0]?.code;
  return typeof code === "number" && Number.isFinite(code) ? code : undefined;
}

function firstMessage(body: Envelope<unknown> | null): string {
  const m = body?.errors?.[0]?.message;
  return typeof m === "string" ? m.replace(/\s+/g, " ").trim().slice(0, 200) : "";
}

function created(r: RestCreated): ArtifactsCreateRepoResult {
  return { id: r.id, name: r.name, description: r.description ?? null, defaultBranch: r.default_branch ?? "main", remote: r.remote, token: r.token };
}

function repoInfo(r: RestRepoInfo): Omit<ArtifactsRepoInfo, "remote"> {
  return {
    id: r.id,
    name: r.name,
    description: r.description ?? null,
    defaultBranch: r.default_branch ?? "main",
    createdAt: r.created_at ?? "",
    updatedAt: r.updated_at ?? "",
    lastPushAt: r.last_push_at ?? null,
    source: r.source ?? null,
    readOnly: r.read_only ?? false,
  };
}

function seg(x: string): string {
  return `/${encodeURIComponent(x)}`;
}

/** Blob bytes of a successful raw answer. */
async function blobOf(res: Response): Promise<Blob> {
  const bytes = new Uint8Array(await res.arrayBuffer());
  const type = res.headers.get("content-type") ?? "";
  return new Blob([bytes], type && !type.startsWith("application/json") ? { type } : {});
}

/** Null for a call answered 404 (an object or ref that does not exist), else the error again. */
function absentAsNull(e: unknown): null {
  if ((e as { code?: unknown } | null)?.code === "NOT_FOUND") return null;
  throw e;
}

/** One repository through the REST API (what `get` returns). */
class RestRepo implements ArtifactsRepo {
  constructor(
    private readonly api: RestApi,
    private readonly name: string,
  ) {}

  private get path(): string {
    return `/repos${seg(this.name)}`;
  }

  async createToken(scope: "write" | "read" = "write", ttl = 86_400): Promise<ArtifactsCreateTokenResult> {
    const { result } = await this.api.json<RestToken>({ op: `token for ${this.name}`, method: "POST", path: "/tokens", body: { repo: this.name, scope, ttl } });
    return { id: result.id, plaintext: result.plaintext ?? "", scope: result.scope, expiresAt: result.expires_at };
  }

  async listTokens(): Promise<ArtifactsTokenListResult> {
    const { result, info } = await this.api.json<RestToken[]>({ op: `token list of ${this.name}`, method: "GET", path: `${this.path}/tokens`, query: { state: "all", per_page: 100 } });
    const tokens = result.map((t) => ({ id: t.id, scope: t.scope, state: t.state ?? "active", createdAt: t.created_at ?? "", expiresAt: t.expires_at }));
    return { tokens, total: typeof info?.total_count === "number" ? info.total_count : tokens.length };
  }

  /** Revoke a token by id (the REST API revokes by id only: a plaintext token is refused, and FireTrident revokes by id). */
  async revokeToken(tokenOrId: string): Promise<boolean> {
    if (typeof tokenOrId !== "string" || tokenOrId.trim() === "") throw new ArtifactsRestError("INVALID_INPUT", 10100, 400, "Revoking a token needs its id.");
    if (tokenOrId.startsWith("art_")) throw new ArtifactsRestError("INVALID_INPUT", 10100, 400, "Over the REST API a token is revoked by its id, not by its secret.");
    try {
      await this.api.send({ op: `revocation of a token of ${this.name}`, method: "DELETE", path: `/tokens${seg(tokenOrId)}` });
      return true;
    } catch (e) {
      if ((e as { code?: unknown }).code === "NOT_FOUND") return false;
      throw e;
    }
  }

  async info(): Promise<ArtifactsRepoInfo> {
    const { result } = await this.api.json<RestRepoInfo>({ op: `lookup of ${this.name}`, method: "GET", path: this.path, conflict: "CREATE_IN_PROGRESS" });
    return { ...repoInfo(result), remote: result.remote ?? "" };
  }

  async readBlob(hash: string): Promise<Blob | null> {
    try {
      return await blobOf(await this.api.send({ op: `read of blob ${hash.slice(0, 12)} in ${this.name}`, method: "GET", path: `${this.path}/blob${seg(hash)}` }));
    } catch (e) {
      return absentAsNull(e);
    }
  }

  async readTree(hash: string): Promise<ArtifactsTreeEntry[] | null> {
    try {
      return (await this.api.json<ArtifactsTreeEntry[]>({ op: `read of tree ${hash.slice(0, 12)} in ${this.name}`, method: "GET", path: `${this.path}/tree${seg(hash)}` })).result;
    } catch (e) {
      return absentAsNull(e);
    }
  }

  async readCommit(hash: string): Promise<ArtifactsCommitMetadata | null> {
    try {
      return (await this.api.json<ArtifactsCommitMetadata>({ op: `read of commit ${hash.slice(0, 12)} in ${this.name}`, method: "GET", path: `${this.path}/commit${seg(hash)}` })).result;
    } catch (e) {
      return absentAsNull(e);
    }
  }

  async readFile(args: { ref: string; path: string }): Promise<Blob | null> {
    try {
      return await blobOf(await this.api.send({ op: `read of a file in ${this.name}`, method: "GET", path: `${this.path}/file`, query: { ref: args.ref, path: args.path } }));
    } catch (e) {
      return absentAsNull(e);
    }
  }

  /** Commits along the first-parent chain, newest first; an empty list when the ref does not resolve (as the binding answers). */
  async log(opts: { ref?: string; limit?: number; offset?: number } = {}): Promise<ArtifactsCommitMetadata[]> {
    try {
      return (await this.api.json<ArtifactsCommitMetadata[]>({ op: `log of ${this.name}`, method: "GET", path: `${this.path}/log`, query: { ref: opts.ref, limit: opts.limit, offset: opts.offset } })).result;
    } catch (e) {
      if ((e as { code?: unknown }).code === "NOT_FOUND") return [];
      throw e;
    }
  }

  async fork(name: string, opts: { description?: string; readOnly?: boolean; defaultBranchOnly?: boolean } = {}): Promise<ArtifactsCreateRepoResult> {
    const body = { name, ...(opts.description !== undefined ? { description: opts.description } : {}), ...(opts.readOnly !== undefined ? { read_only: opts.readOnly } : {}), ...(opts.defaultBranchOnly !== undefined ? { default_branch_only: opts.defaultBranchOnly } : {}) };
    return created((await this.api.json<RestCreated>({ op: `fork of ${this.name} to ${name}`, method: "POST", path: `${this.path}/fork`, body })).result);
  }
}

/** An Artifacts namespace through the REST API, with the binding's interface. */
class RestArtifacts implements Artifacts {
  constructor(private readonly api: RestApi) {}

  async create(name: string, opts: { readOnly?: boolean; description?: string; setDefaultBranch?: string } = {}): Promise<ArtifactsCreateRepoResult> {
    await this.api.ensureNamespace();
    const body = { name, ...(opts.description !== undefined ? { description: opts.description } : {}), ...(opts.setDefaultBranch !== undefined ? { default_branch: opts.setDefaultBranch } : {}), ...(opts.readOnly !== undefined ? { read_only: opts.readOnly } : {}) };
    return created((await this.api.json<RestCreated>({ op: `creation of ${name}`, method: "POST", path: "/repos", body })).result);
  }

  /** A handle on an existing repository: NOT_FOUND when it does not exist, an *_IN_PROGRESS code while it is being made. */
  async get(name: string): Promise<ArtifactsRepo> {
    await this.api.send({ op: `lookup of ${name}`, method: "GET", path: `/repos${seg(name)}`, conflict: "CREATE_IN_PROGRESS" });
    return new RestRepo(this.api, name);
  }

  /** Import a public HTTPS remote. The REST import takes no description, so `target.opts.description` is not kept. */
  async import(params: { source: { url: string; branch?: string; depth?: number }; target: { name: string; opts?: { description?: string; readOnly?: boolean } } }): Promise<ArtifactsCreateRepoResult> {
    await this.api.ensureNamespace();
    const s = params.source;
    const body = { url: s.url, ...(s.branch ? { branch: s.branch } : {}), ...(s.depth !== undefined ? { depth: s.depth } : {}), ...(params.target.opts?.readOnly !== undefined ? { read_only: params.target.opts.readOnly } : {}) };
    return created((await this.api.json<RestCreated>({ op: `import into ${params.target.name}`, method: "POST", path: `/repos${seg(params.target.name)}/import`, body })).result);
  }

  async list(opts: { limit?: number; cursor?: string } = {}): Promise<ArtifactsRepoListResult> {
    const { result, info } = await this.api.json<RestRepoInfo[]>({ op: `list of namespace ${this.api.namespace}`, method: "GET", path: "/repos", query: { limit: opts.limit, cursor: opts.cursor } });
    const repos = result.map(repoInfo);
    const cursor = typeof info?.cursor === "string" && info.cursor !== "" ? info.cursor : undefined;
    return { repos, total: typeof info?.total_count === "number" ? info.total_count : repos.length, ...(cursor ? { cursor } : {}) };
  }

  /** Delete a repository: true when one was deleted, false when there was none. */
  async delete(name: string): Promise<boolean> {
    try {
      await this.api.send({ op: `deletion of ${name}`, method: "DELETE", path: `/repos${seg(name)}` });
      return true;
    } catch (e) {
      if ((e as { code?: unknown }).code === "NOT_FOUND") return false;
      throw e;
    }
  }
}

/**
 * An Artifacts namespace in a Cloudflare account, reached over the REST API, with the interface of the Artifacts
 * binding (see the module comment). The namespace is created on first use when a repository is made in it.
 */
export function artifactsOverRest(o: RestArtifactsOptions): Artifacts {
  return new RestArtifacts(new RestApi(o));
}
