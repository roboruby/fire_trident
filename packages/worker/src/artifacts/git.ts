import { create as createVfs, MemoryProvider, VirtualProvider } from "@platformatic/vfs";
import git, { type PromiseFsClient, type TreeEntry } from "isomorphic-git";
import gitHttp from "isomorphic-git/http/web";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The all-zero object id git uses for "no ref". */
export const ZERO_SHA = "0".repeat(40);
/** Ref that carries FireTrident lineage notes. */
export const NOTES_REF = "refs/notes/firetrident";
/** Author and committer of every landing. */
export const LANDING_IDENTITY = { name: "FireTrident", email: "lanes@firetrident.dev" } as const;
const SHA_RE = /^[0-9a-f]{40}$/;
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const FILE_MODE = "100644";
const TREE_MODE = "040000";

/** True for a 40-character lowercase hex object id. */
export function isSha(x: unknown): x is string {
  return typeof x === "string" && SHA_RE.test(x);
}

/** Promise that resolves after `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** Short, single-line text for an unknown thrown value (never includes tokens: callers never put them in messages). */
export function errorText(e: unknown): string {
  const x = e as { code?: unknown; message?: unknown } | null;
  const code = typeof x?.code === "string" ? `${x.code}: ` : "";
  return `${code}${String(x?.message ?? e)}`.replace(/\s+/g, " ").slice(0, 400);
}

// ---------------------------------------------------------------------------
// Tokens and auth
// ---------------------------------------------------------------------------

/** Add the server's status and a body snippet to an isomorphic-git HttpError's message (code and data kept). */
function annotateHttpError(e: unknown, what: string): unknown {
  const x = e as { code?: unknown; message?: unknown; data?: { statusCode?: unknown; response?: unknown } } | null;
  if (x?.code !== "HttpError" || typeof x.message !== "string") return e;
  const body = typeof x.data?.response === "string" ? x.data.response.replace(/\s+/g, " ").slice(0, 200) : "";
  try {
    x.message = `${x.message} (${what})${body ? `: ${body}` : ""}`;
  } catch {
    // read-only message
  }
  return e;
}

/** True for a git-over-HTTP rejection of the token (401/403): re-mint and retry once. */
export function isAuthError(e: unknown): boolean {
  const x = e as { code?: unknown; data?: { statusCode?: unknown } } | null;
  return x?.code === "HttpError" && (x.data?.statusCode === 401 || x.data?.statusCode === 403);
}

/** Authorization header for an Artifacts token (the full token, including its `?expires=` suffix). */
export function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

/** The secret part of a token (`art_v1_<hex>`), as Basic auth wants it. */
export function tokenSecret(token: string): string {
  const i = token.indexOf("?expires=");
  return i === -1 ? token : token.slice(0, i);
}

/** Expiry encoded in a token's `?expires=<unix seconds>` suffix, in ms; `fallback` when absent. */
export function tokenExpiresAt(token: string, fallback: number): number {
  const m = /\?expires=(\d+)/.exec(token);
  return m ? Number(m[1]) * 1000 : fallback;
}

/** Remote URL with the token embedded as Basic auth, for git clients that cannot set headers. */
export function authenticatedRemote(remote: string, token: string): string {
  const url = new URL(remote);
  url.username = "x";
  url.password = tokenSecret(token);
  return url.toString();
}

/** A freshly minted repo-scoped token. */
export interface MintedToken {
  id: string;
  token: string;
  scope: "read" | "write";
  expiresAt: number;
}

/** Mint a `scope` token for repo `name` valid for `ttlSec` seconds (60..31536000). */
export async function mintToken(binding: Artifacts, name: string, scope: "read" | "write", ttlSec: number): Promise<MintedToken> {
  const ttl = Math.min(31_536_000, Math.max(60, Math.floor(ttlSec)));
  const t = await withArtifactsRetry(() => withRepo(binding, name, (repo) => repo.createToken(scope, ttl)));
  const fallback = Date.now() + ttl * 1000;
  const parsed = Date.parse(t.expiresAt);
  return { id: t.id, token: t.plaintext, scope: t.scope, expiresAt: Number.isFinite(parsed) ? parsed : tokenExpiresAt(t.plaintext, fallback) };
}

/** Caches one token and re-mints it when it is within `marginMs` of expiry. Concurrent callers share one mint. */
export class TokenCache {
  private current: MintedToken | null = null;
  private pending: Promise<MintedToken> | null = null;

  constructor(
    private readonly mint: () => Promise<MintedToken>,
    private readonly marginMs: number,
  ) {}

  /** A token valid for at least the margin, minting a new one if needed. */
  async get(now = Date.now()): Promise<MintedToken> {
    if (this.current && this.current.expiresAt - now > this.marginMs) return this.current;
    if (!this.pending) {
      this.pending = this.mint().then(
        (t) => {
          this.current = t;
          this.pending = null;
          return t;
        },
        (e: unknown) => {
          this.pending = null;
          throw e;
        },
      );
    }
    return this.pending;
  }

  /** Drop the cached token (after an auth failure). */
  invalidate(): void {
    this.current = null;
  }
}

// ---------------------------------------------------------------------------
// Artifacts binding helpers
// ---------------------------------------------------------------------------

/** The string code of an ArtifactsError, if `e` is one. */
export function artifactsCode(e: unknown): string | undefined {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

/** Release an RPC stub (repo handles are Disposable). */
export function dispose(x: unknown): void {
  const key = (Symbol as unknown as { dispose?: symbol }).dispose;
  if (key === undefined || x === null || typeof x !== "object") return;
  try {
    const d = (x as Record<symbol, unknown>)[key];
    if (typeof d === "function") (d as () => void).call(x);
  } catch {
    // already released
  }
}

/** Run `fn` with a repo handle and always release the handle. */
export async function withRepo<T>(binding: Artifacts, name: string, fn: (repo: ArtifactsRepo) => Promise<T>): Promise<T> {
  const repo = await binding.get(name);
  try {
    return await fn(repo);
  } finally {
    dispose(repo);
  }
}

/** Retry policy for transient Artifacts errors. */
export interface RetryOptions {
  /** Delays between attempts; one attempt more than entries. */
  delaysMs?: number[];
  /** Codes worth retrying. */
  codes?: string[];
}

const TRANSIENT = ["INTERNAL_ERROR", "UPSTREAM_UNAVAILABLE"];

/** Call `fn`, retrying with backoff while it throws one of `codes` (default: INTERNAL_ERROR, UPSTREAM_UNAVAILABLE). */
export async function withArtifactsRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const delays = opts.delaysMs ?? [250, 750];
  const codes = new Set(opts.codes ?? TRANSIENT);
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const code = artifactsCode(e);
      if (attempt >= delays.length || code === undefined || !codes.has(code)) throw e;
      await sleep(delays[attempt]! * (0.75 + Math.random() * 0.5));
    }
  }
}

/** Get a repo handle, or null when it does not exist; waits out create/import/fork in progress. */
export async function getRepoIfExists(binding: Artifacts, name: string, waitMs = 60_000): Promise<ArtifactsRepo | null> {
  const t0 = Date.now();
  let delay = 250;
  for (;;) {
    try {
      return await binding.get(name);
    } catch (e) {
      const code = artifactsCode(e);
      if (code === "NOT_FOUND") return null;
      const busy = code === "CREATE_IN_PROGRESS" || code === "IMPORT_IN_PROGRESS" || code === "FORK_IN_PROGRESS" || code === "INTERNAL_ERROR";
      if (!busy || Date.now() - t0 > waitMs) throw e;
      await sleep(delay);
      delay = Math.min(2_000, Math.round(delay * 1.6));
    }
  }
}

// ---------------------------------------------------------------------------
// Filesystems for isomorphic-git
// ---------------------------------------------------------------------------

/** Methods forwarded from the Workspace's SQLite provider to the vfs glue. */
const FORWARDED = [
  "open", "openSync", "stat", "statSync", "lstat", "lstatSync", "readdir", "readdirSync",
  "mkdir", "mkdirSync", "rmdir", "rmdirSync", "unlink", "unlinkSync", "rename", "renameSync",
  "readFile", "readFileSync", "writeFile", "writeFileSync", "appendFile", "appendFileSync",
  "exists", "existsSync", "copyFile", "copyFileSync", "internalModuleStat", "realpath",
  "realpathSync", "access", "accessSync", "readlink", "readlinkSync", "symlink", "symlinkSync",
  "watch", "watchAsync", "watchFile", "unwatchFile", "closeSync", "readSync", "writeSync",
  "fstatSync", "truncateSync", "ftruncateSync",
] as const;

export type ProviderLike = { readonly: boolean; supportsSymlinks: boolean; supportsWatch: boolean } & Record<string, unknown>;

/**
 * An isomorphic-git fs over a Workspace provider (the same glue @cloudflare/computer/git
 * builds internally), so raw isomorphic-git and the Workspace share one SQLite filesystem.
 */
export function glueFs(provider: ProviderLike): PromiseFsClient {
  const Base = VirtualProvider as unknown as new () => object;
  class Glue extends Base {
    readonly #inner: ProviderLike;
    constructor(inner: ProviderLike) {
      super();
      this.#inner = inner;
    }
    get readonly(): boolean {
      return this.#inner.readonly;
    }
    get supportsSymlinks(): boolean {
      return this.#inner.supportsSymlinks;
    }
    get supportsWatch(): boolean {
      return this.#inner.supportsWatch;
    }
    get inner(): ProviderLike {
      return this.#inner;
    }
  }
  for (const name of FORWARDED) {
    Object.defineProperty(Glue.prototype, name, {
      value(this: Glue, ...args: unknown[]) {
        const fn = this.inner[name];
        if (typeof fn !== "function") throw new Error(`workspace provider has no ${name}`);
        return (fn as (...a: unknown[]) => unknown).apply(this.inner, args);
      },
      writable: true,
      configurable: true,
    });
  }
  const vfs = createVfs(new Glue(provider) as unknown as VirtualProvider, { moduleHooks: false });
  return { promises: vfs.promises } as unknown as PromiseFsClient;
}

/** Throwaway in-memory isomorphic-git fs (for one-off repos outside a Durable Object). */
export function memoryFs(): PromiseFsClient {
  const vfs = createVfs(new MemoryProvider(), { moduleHooks: false });
  return { promises: vfs.promises } as unknown as PromiseFsClient;
}

// ---------------------------------------------------------------------------
// Git operations (isomorphic-git, no working tree)
// ---------------------------------------------------------------------------

/** One local repository: an fs, its directory, and a shared object cache. */
export interface GitRepo {
  fs: PromiseFsClient;
  dir: string;
  /** isomorphic-git object/packfile cache; keep one per repo for the life of the object. */
  cache: object;
}

/** Init `repo.dir` (main as default branch) if needed and point `origin` at `remote`. */
export async function ensureRepo(repo: GitRepo, remote: string): Promise<void> {
  const { fs, dir } = repo;
  let exists = true;
  try {
    await fs.promises.stat(`${dir}/.git/HEAD`);
  } catch {
    exists = false;
  }
  if (!exists) await git.init({ fs, dir, defaultBranch: "main" });
  await git.addRemote({ fs, dir, remote: "origin", url: remote, force: true });
}

/** Resolve a local ref to an oid, or null when it does not exist. */
export async function resolveLocal(repo: GitRepo, ref: string): Promise<string | null> {
  try {
    return await git.resolveRef({ fs: repo.fs, dir: repo.dir, ref });
  } catch {
    return null;
  }
}

/** Point local `ref` at `oid`. */
export async function setRef(repo: GitRepo, ref: string, oid: string): Promise<void> {
  await git.writeRef({ fs: repo.fs, dir: repo.dir, ref, value: oid, force: true });
}

/** Delete local `ref` if it exists. */
export async function deleteLocalRef(repo: GitRepo, ref: string): Promise<void> {
  try {
    await git.deleteRef({ fs: repo.fs, dir: repo.dir, ref });
  } catch {
    // absent
  }
}

/**
 * Fetch one remote ref (a branch such as "refs/heads/main" or "refs/notes/firetrident").
 * Returns its oid, or null when the remote has no such ref. Does not move local refs.
 */
export async function fetchRef(repo: GitRepo, p: { url: string; token: string; ref: string; depth?: number }): Promise<string | null> {
  try {
    const r = await git.fetch({
      fs: repo.fs,
      http: gitHttp,
      dir: repo.dir,
      cache: repo.cache,
      url: p.url,
      ref: p.ref,
      remoteRef: p.ref,
      singleBranch: true,
      tags: false,
      depth: p.depth,
      headers: authHeaders(p.token),
    });
    return r.fetchHead ?? null;
  } catch (e) {
    if ((e as { code?: string }).code === "NotFoundError") return null;
    throw annotateHttpError(e, `fetch ${p.ref}`);
  }
}

/** Refs a remote advertises (with HEAD's symref target), read over smart HTTP. */
export async function listRemoteRefs(url: string, token: string): Promise<Array<{ ref: string; oid: string; target?: string }>> {
  const refs = await git.listServerRefs({ http: gitHttp, url, headers: authHeaders(token), symrefs: true, protocolVersion: 1 });
  return refs.map((r) => ({ ref: r.ref, oid: r.oid, target: r.target }));
}

/** Outcome of a compare-and-swap push. */
export type PushOutcome =
  | { ok: true }
  | { ok: false; stale: true; remoteOid: string | null; detail: string }
  | { ok: false; stale: false; detail: string };

/**
 * Push local `localRef` to `remoteRef`. With `expectedOld` (an oid, or null for "must not
 * exist"), the push is a compare-and-swap: it is cancelled before any pack is sent when the
 * advertised value differs, and the server rejects it ("stale ref") if the ref moves between
 * advertisement and update. Without `expectedOld`, `force` overwrites whatever is there.
 * `remote` names the remote-tracking refs the push updates (default "origin").
 */
export async function pushRef(
  repo: GitRepo,
  p: { url: string; token: string; localRef: string; remoteRef: string; expectedOld?: string | null; force?: boolean; remote?: string },
): Promise<PushOutcome> {
  let advertised: string | null = null;
  try {
    await git.push({
      fs: repo.fs,
      http: gitHttp,
      dir: repo.dir,
      cache: repo.cache,
      remote: p.remote ?? "origin",
      url: p.url,
      ref: p.localRef,
      remoteRef: p.remoteRef,
      force: p.force ?? false,
      headers: authHeaders(p.token),
      onPrePush: ({ remoteRef }) => {
        advertised = remoteRef.oid === ZERO_SHA ? null : remoteRef.oid;
        if (p.expectedOld === undefined) return true;
        return advertised === p.expectedOld;
      },
    });
    return { ok: true };
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "UserCanceledError") {
      return { ok: false, stale: true, remoteOid: advertised, detail: `remote ${p.remoteRef} is ${advertised ?? "absent"}, expected ${p.expectedOld ?? "absent"}` };
    }
    if (code === "PushRejectedError") return { ok: false, stale: true, remoteOid: advertised, detail: errorText(e) };
    if (code === "GitPushError") {
      const refs = (e as { data?: { result?: { refs?: Record<string, { ok: boolean; error?: string }> } } }).data?.result?.refs ?? {};
      const err = refs[p.remoteRef]?.error ?? "";
      const stale = /stale|non-fast-forward|fetch first|lock/i.test(err);
      return stale ? { ok: false, stale: true, remoteOid: advertised, detail: err } : { ok: false, stale: false, detail: errorText(e) };
    }
    throw annotateHttpError(e, `push ${p.remoteRef}`);
  }
}

/** One file entry of a tree walk. */
export interface TreeFile {
  path: string;
  blob: string;
  mode: string;
}

/** Entries of tree `oid` (immediate children). */
export async function readTreeEntries(repo: GitRepo, oid: string): Promise<TreeEntry[]> {
  const { tree } = await git.readTree({ fs: repo.fs, dir: repo.dir, oid, cache: repo.cache });
  return tree;
}

/** Root tree of commit `oid`, or null when the commit is not in the local repo. */
export async function commitTree(repo: GitRepo, oid: string): Promise<string | null> {
  try {
    const { commit } = await git.readCommit({ fs: repo.fs, dir: repo.dir, oid, cache: repo.cache });
    return commit.tree;
  } catch (e) {
    if ((e as { code?: string }).code === "NotFoundError") return null;
    throw e;
  }
}

/** Every file (blobs and symlinks; submodules skipped) under tree `oid`, depth first. */
export async function listTreeFiles(repo: GitRepo, oid: string, prefix = ""): Promise<TreeFile[]> {
  const out: TreeFile[] = [];
  for (const e of await readTreeEntries(repo, oid)) {
    const path = prefix === "" ? e.path : `${prefix}/${e.path}`;
    if (e.type === "tree") out.push(...(await listTreeFiles(repo, e.oid, path)));
    else if (e.type === "blob") out.push({ path, blob: e.oid, mode: e.mode });
  }
  return out;
}

/** The blob at `path` in tree `root` (null when absent or not a file). `trees` memoizes reads within one call. */
export async function blobAt(repo: GitRepo, root: string, path: string, trees = new Map<string, TreeEntry[]>()): Promise<{ blob: string; mode: string } | null> {
  const parts = path.split("/");
  let oid = root;
  for (let i = 0; i < parts.length; i++) {
    let entries = trees.get(oid);
    if (!entries) {
      entries = await readTreeEntries(repo, oid);
      trees.set(oid, entries);
    }
    const e = entries.find((x) => x.path === parts[i]);
    if (!e) return null;
    if (i === parts.length - 1) return e.type === "blob" ? { blob: e.oid, mode: e.mode } : null;
    if (e.type !== "tree") return null;
    oid = e.oid;
  }
  return null;
}

/**
 * The blob at `path` in tree `root` of a remote repo, read through the binding (null when
 * absent or not a file). `trees` memoizes tree reads within one call.
 */
export async function remoteBlobAt(repo: ArtifactsRepo, root: string, path: string, trees = new Map<string, ArtifactsTreeEntry[] | null>()): Promise<string | null> {
  const parts = path.split("/");
  let oid = root;
  for (let i = 0; i < parts.length; i++) {
    let entries = trees.get(oid);
    if (entries === undefined) {
      entries = await repo.readTree(oid);
      trees.set(oid, entries);
    }
    if (!entries) return null;
    const e = entries.find((x) => x.name === parts[i]);
    if (!e) return null;
    if (i === parts.length - 1) return e.type === "blob" || e.type === "exec" || e.type === "symlink" ? e.hash : null;
    if (e.type !== "tree") return null;
    oid = e.hash;
  }
  return null;
}

/** Bytes of blob `oid` from the local object store. */
export async function readLocalBlob(repo: GitRepo, oid: string): Promise<Uint8Array> {
  const { blob } = await git.readBlob({ fs: repo.fs, dir: repo.dir, oid, cache: repo.cache });
  return blob;
}

/** Write `bytes` as a blob; returns its oid. */
export async function writeLocalBlob(repo: GitRepo, bytes: Uint8Array): Promise<string> {
  return git.writeBlob({ fs: repo.fs, dir: repo.dir, blob: bytes });
}

/** Git blob id of `bytes` (sha1 of "blob <len>\0" + bytes). */
export async function blobSha(bytes: Uint8Array): Promise<string> {
  return (await git.hashBlob({ object: bytes })).oid;
}

/** A change to one path: the new blob and mode, or null to delete it. */
export type PathChange = { blob: string; mode: string } | null;

interface ChangeNode {
  files: Map<string, PathChange>;
  dirs: Map<string, ChangeNode>;
}

function changeTree(changes: Map<string, PathChange>): ChangeNode {
  const root: ChangeNode = { files: new Map(), dirs: new Map() };
  for (const [path, change] of changes) {
    const parts = path.split("/");
    let node = root;
    for (const dir of parts.slice(0, -1)) {
      let next = node.dirs.get(dir);
      if (!next) {
        next = { files: new Map(), dirs: new Map() };
        node.dirs.set(dir, next);
      }
      node = next;
    }
    node.files.set(parts[parts.length - 1]!, change);
  }
  return root;
}

async function rewriteTree(repo: GitRepo, oid: string | null, node: ChangeNode): Promise<string | null> {
  const entries = new Map<string, TreeEntry>();
  if (oid !== null) for (const e of await readTreeEntries(repo, oid)) entries.set(e.path, e);
  for (const [name, change] of node.files) {
    if (change === null) entries.delete(name);
    else entries.set(name, { mode: change.mode, path: name, oid: change.blob, type: "blob" });
  }
  for (const [name, child] of node.dirs) {
    const cur = entries.get(name);
    const next = await rewriteTree(repo, cur?.type === "tree" ? cur.oid : null, child);
    if (next === null) entries.delete(name);
    else entries.set(name, { mode: TREE_MODE, path: name, oid: next, type: "tree" });
  }
  if (entries.size === 0) return null;
  return git.writeTree({ fs: repo.fs, dir: repo.dir, tree: [...entries.values()] });
}

/**
 * Tree surgery: a new root tree equal to `root` with `changes` applied. Only trees on a
 * changed path are rewritten, each once; directories left empty disappear.
 */
export async function applyTreeChanges(repo: GitRepo, root: string, changes: Map<string, PathChange>): Promise<string> {
  const out = await rewriteTree(repo, root, changeTree(changes));
  return out ?? (await git.writeTree({ fs: repo.fs, dir: repo.dir, tree: [] }));
}

/** A root tree holding exactly `files` (path → blob and mode), built from scratch. */
export async function buildTree(repo: GitRepo, files: Map<string, { blob: string; mode: string }>): Promise<string> {
  const out = await rewriteTree(repo, null, changeTree(files));
  return out ?? (await git.writeTree({ fs: repo.fs, dir: repo.dir, tree: [] }));
}

/** One path that differs between two trees. */
export interface TreeDelta {
  path: string;
  before: { blob: string; mode: string } | null;
  after: { blob: string; mode: string } | null;
}

async function filesUnder(repo: GitRepo, e: TreeEntry | undefined, path: string): Promise<TreeFile[]> {
  if (!e) return [];
  if (e.type === "blob") return [{ path, blob: e.oid, mode: e.mode }];
  if (e.type === "tree") return listTreeFiles(repo, e.oid, path);
  return [];
}

/** Paths whose blob or mode differ between trees `a` and `b` (null = empty), descending only into changed subtrees. */
export async function diffTrees(repo: GitRepo, a: string | null, b: string | null, prefix = ""): Promise<TreeDelta[]> {
  if (a === b) return [];
  const ea = new Map((a && a !== EMPTY_TREE ? await readTreeEntries(repo, a) : []).map((e) => [e.path, e]));
  const eb = new Map((b && b !== EMPTY_TREE ? await readTreeEntries(repo, b) : []).map((e) => [e.path, e]));
  const out: TreeDelta[] = [];
  for (const name of new Set([...ea.keys(), ...eb.keys()])) {
    const x = ea.get(name);
    const y = eb.get(name);
    const path = prefix === "" ? name : `${prefix}/${name}`;
    if (x && y && x.oid === y.oid && x.mode === y.mode) continue;
    if (x?.type === "tree" && y?.type === "tree") {
      out.push(...(await diffTrees(repo, x.oid, y.oid, path)));
      continue;
    }
    const before = new Map((await filesUnder(repo, x, path)).map((f) => [f.path, f]));
    const after = new Map((await filesUnder(repo, y, path)).map((f) => [f.path, f]));
    for (const p of new Set([...before.keys(), ...after.keys()])) {
      const bf = before.get(p);
      const af = after.get(p);
      if (bf && af && bf.blob === af.blob && bf.mode === af.mode) continue;
      out.push({ path: p, before: bf ? { blob: bf.blob, mode: bf.mode } : null, after: af ? { blob: af.blob, mode: af.mode } : null });
    }
  }
  return out;
}

/** Write a commit object; returns its oid. Time is injected so callers control it. */
export async function writeCommitObject(
  repo: GitRepo,
  p: { tree: string; parents: string[]; message: string; at: number; identity?: { name: string; email: string } },
): Promise<string> {
  const who = { ...(p.identity ?? LANDING_IDENTITY), timestamp: Math.floor(p.at / 1000), timezoneOffset: 0 };
  return git.writeCommit({ fs: repo.fs, dir: repo.dir, commit: { message: p.message, tree: p.tree, parent: p.parents, author: who, committer: who } });
}

/** Add (or replace) the note for `oid` under `ref`; returns the new notes commit. */
export async function addNoteObject(repo: GitRepo, p: { ref: string; oid: string; note: string; at: number }): Promise<string> {
  const who = { ...LANDING_IDENTITY, timestamp: Math.floor(p.at / 1000), timezoneOffset: 0 };
  return git.addNote({ fs: repo.fs, dir: repo.dir, cache: repo.cache, ref: p.ref, oid: p.oid, note: p.note, force: true, author: who, committer: who });
}

/** The note text for `oid` under `ref`, or null. */
export async function readNoteText(repo: GitRepo, ref: string, oid: string): Promise<string | null> {
  try {
    const bytes = await git.readNote({ fs: repo.fs, dir: repo.dir, cache: repo.cache, ref, oid });
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/** The mode a new file gets. */
export const NEW_FILE_MODE = FILE_MODE;
