import { Workspace } from "@cloudflare/computer";
import { create as createVfs, VirtualProvider } from "@platformatic/vfs";
import git from "isomorphic-git";
import type { GitHttpRequest, GitHttpResponse, HttpClient } from "isomorphic-git";
import type { FileVersion, Path, Sha } from "@fire_trident/core";
import type { BaseFile, GitOps, NetStats } from "./loop.ts";

/**
 * Git for one agent, inside its Durable Object: isomorphic-git over the SQLite
 * virtual filesystem of a `@cloudflare/computer` Workspace (spike/RESULTS.md §3:
 * clone ~350 ms, tree-surgery commit ~40 ms, push ~300 ms). The clone is bare in
 * practice: objects are fetched shallowly and edits are written as blobs and
 * trees directly, so no working tree is ever checked out.
 */

const FORWARDED = [
  "open", "openSync", "stat", "statSync", "lstat", "lstatSync", "readdir", "readdirSync",
  "mkdir", "mkdirSync", "rmdir", "rmdirSync", "unlink", "unlinkSync", "rename", "renameSync",
  "readFile", "readFileSync", "writeFile", "writeFileSync", "appendFile", "appendFileSync",
  "exists", "existsSync", "copyFile", "copyFileSync", "internalModuleStat", "realpath",
  "realpathSync", "access", "accessSync", "readlink", "readlinkSync", "symlink", "symlinkSync",
  "watch", "watchAsync", "watchFile", "unwatchFile", "closeSync", "readSync", "writeSync",
  "fstatSync", "truncateSync", "ftruncateSync",
];

/** An isomorphic-git fs over the Workspace's SQLite provider (same glue the package builds internally). */
// The provider and the vfs are untyped seams; keep `any` contained to this function.
export function buildIsoFs(provider: unknown): any {
  const Base = VirtualProvider as any;
  class Glue extends Base {
    #inner: Record<string, unknown>;
    constructor(inner: Record<string, unknown>) {
      super();
      this.#inner = inner;
    }
    get readonly(): unknown {
      return this.#inner.readonly;
    }
    get supportsSymlinks(): unknown {
      return this.#inner.supportsSymlinks;
    }
    get supportsWatch(): unknown {
      return this.#inner.supportsWatch;
    }
    get inner(): Record<string, unknown> {
      return this.#inner;
    }
  }
  for (const name of FORWARDED) {
    Object.defineProperty(Glue.prototype, name, {
      value(this: { inner: Record<string, unknown> }, ...args: unknown[]) {
        const fn = this.inner[name];
        if (typeof fn !== "function") throw new Error(`workspace provider has no ${name}`);
        return (fn as (...a: unknown[]) => unknown).apply(this.inner, args);
      },
      writable: true,
      configurable: true,
    });
  }
  return { promises: (createVfs as any)(new Glue(provider as Record<string, unknown>), { moduleHooks: false }).promises };
}

const auth = (token: string): Record<string, string> => (token ? { Authorization: `Bearer ${token}` } : {});
const LOCAL_BRANCH = "refs/heads/ft-work";
/**
 * The newest trunk commit this clone holds. isomorphic-git offers the local ref
 * named like the fetched branch as a "have", so keeping it current makes every
 * later fetch send only what trunk gained since (not the whole tree again).
 */
const TRUNK_HAVE = "refs/heads/main";
const DEEPEN = 64;
/** Email domain of in-platform agent commits (see change.ts agentIdentity). */
const AGENT_EMAIL = "@agents.firetrident.dev";

/** A zeroed NetStats. */
export function emptyNet(): NetStats {
  return { requests: 0, sentBytes: 0, receivedBytes: 0, ms: 0 };
}

async function collectBody(body: unknown): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const add = (c: unknown): void => {
    if (c instanceof Uint8Array) {
      chunks.push(c);
      size += c.byteLength;
    }
  };
  if (body instanceof Uint8Array) add(body);
  else if (body && typeof (body as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function") for await (const c of body as AsyncIterable<unknown>) add(c);
  else if (body && typeof (body as Iterable<unknown>)[Symbol.iterator] === "function") for (const c of body as Iterable<unknown>) add(c);
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/**
 * An isomorphic-git HTTP client (same contract as isomorphic-git/http/web) that
 * buffers each request and response and adds their sizes and durations to `stats`.
 */
export function meteredHttp(stats: NetStats): HttpClient {
  return {
    async request(req: GitHttpRequest): Promise<GitHttpResponse> {
      const t0 = Date.now();
      const method = req.method ?? "GET";
      const body = req.body ? await collectBody(req.body) : undefined;
      const res = await fetch(req.url, {
        method,
        headers: req.headers ?? {},
        ...(body ? { body } : {}),
        ...(req.signal ? { signal: req.signal as AbortSignal } : {}),
      });
      const bytes = new Uint8Array(await res.arrayBuffer());
      stats.requests += 1;
      stats.sentBytes += body?.byteLength ?? 0;
      stats.receivedBytes += bytes.byteLength;
      stats.ms += Date.now() - t0;
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        headers[k] = v;
      });
      return { url: res.url, method, statusCode: res.status, statusMessage: res.statusText, body: once(bytes), headers };
    },
  };
}

async function* once(bytes: Uint8Array): AsyncIterableIterator<Uint8Array> {
  yield bytes;
}

interface TreeEntry {
  mode: string;
  path: string;
  oid: string;
  type: "blob" | "tree" | "commit";
}

/** Map an isomorphic-git HTTP error to a `[ft:NNN]`-tagged error so callers can tell auth failures apart. */
function httpError(e: unknown, what: string): Error {
  const x = e as { code?: string; data?: { statusCode?: number; statusMessage?: string }; message?: string };
  const status = x?.data?.statusCode;
  if (x?.code === "HttpError" && typeof status === "number") return new Error(`[ft:${status}] ${what}: HTTP ${status} ${x.data?.statusMessage ?? ""}`.trim());
  return new Error(`${what}: ${x?.message ?? String(e)}`);
}

/** isomorphic-git over a Workspace in this Durable Object's storage. */
export class WorkspaceGit implements GitOps {
  private readonly ws: Workspace;
  private fsClient: any = null;
  private cache: Record<string, unknown> = {};
  private initialized = false;
  private net: NetStats = emptyNet();
  private readonly http = meteredHttp(this.net);

  constructor(storage: DurableObjectStorage, private readonly dir = "/repo") {
    // The Workspace's options type wants its own storage-like interface; the DO storage satisfies it.
    this.ws = new Workspace({ storage: storage as unknown as ConstructorParameters<typeof Workspace>[0]["storage"] });
  }

  private fs(): any {
    if (!this.fsClient) this.fsClient = buildIsoFs(this.ws.provider());
    return this.fsClient;
  }

  private async init(): Promise<void> {
    if (this.initialized) return;
    const fs = this.fs();
    try {
      await fs.promises.stat(`${this.dir}/.git/HEAD`);
    } catch {
      await git.init({ fs, dir: this.dir, defaultBranch: "main" });
    }
    this.initialized = true;
  }

  private async hasCommit(oid: Sha): Promise<boolean> {
    try {
      await git.readCommit({ fs: this.fs(), dir: this.dir, oid, cache: this.cache });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * isomorphic-git records shallow boundaries before it stores the pack, so a fetch
   * that dies in between (eviction, CPU limit, a ref-update error) leaves `.git/shallow`
   * naming commits whose objects are absent. The server then believes we have them
   * and sends an empty pack forever. Drop such entries before fetching.
   */
  private async repairShallow(): Promise<void> {
    const fs = this.fs();
    const path = `${this.dir}/.git/shallow`;
    let text: string;
    try {
      text = String(await fs.promises.readFile(path, "utf8"));
    } catch {
      return;
    }
    const listed = text.split("\n").map((s) => s.trim()).filter((s) => /^[0-9a-f]{40}$/.test(s));
    const keep: string[] = [];
    for (const oid of listed) if (await this.hasCommit(oid)) keep.push(oid);
    if (keep.length === listed.length) return;
    if (keep.length === 0) await fs.promises.unlink(path);
    else await fs.promises.writeFile(path, `${keep.join("\n")}\n`);
  }

  /**
   * Fetch `ref` (a branch name or a commit id) from trunk. The haves are the
   * TRUNK_HAVE ref (when its commit is present), so trunk sends only objects
   * that commit lacks. Fetching "main" moves TRUNK_HAVE to the fetched tip.
   */
  private async fetch(remote: string, token: string, ref: string, depth: number): Promise<string | null> {
    const fs = this.fs();
    // fetch needs a configured remote for its refspec (a bare url has none).
    await git.addRemote({ fs, dir: this.dir, remote: "origin", url: remote, force: true });
    // isomorphic-git takes its haves from the local ref named by `ref`, so `ref` stays "main"
    // (TRUNK_HAVE) and a commit id goes in `remoteRef`, which is what gets wanted.
    const byId = /^[0-9a-f]{40}$/.test(ref);
    const r = await git.fetch({
      fs,
      http: this.http,
      dir: this.dir,
      remote: "origin",
      ref: "main",
      remoteRef: ref,
      singleBranch: true,
      depth,
      tags: false,
      headers: auth(token),
      cache: this.cache,
    });
    const head = r.fetchHead ?? null;
    if (!byId && ref === "main" && head && (await this.hasCommit(head))) {
      await git.writeRef({ fs, dir: this.dir, ref: TRUNK_HAVE, value: head, force: true });
    }
    return head;
  }

  /** Network cost of the git calls since the last call to this method (then resets it). */
  takeNetStats(): NetStats {
    const out = { ...this.net };
    this.net.requests = 0;
    this.net.sentBytes = 0;
    this.net.receivedBytes = 0;
    this.net.ms = 0;
    return out;
  }

  /**
   * Make `baseSha` available: already present, or the trunk tip at depth 1 (the
   * usual case: the lease was just issued), or a direct want of the commit, or a
   * deeper fetch. When none reaches it the tip is used and `fallback` is set.
   * Fetches are incremental: trunk sends only what changed since the newest trunk
   * commit this clone already holds.
   */
  async ensureBase(p: { remote: string; token: string; baseSha: Sha }): Promise<{ baseSha: Sha; fallback: boolean }> {
    await this.init();
    if (await this.hasCommit(p.baseSha)) return { baseSha: p.baseSha, fallback: false };
    await this.repairShallow();
    let tip: string | null;
    try {
      tip = await this.fetch(p.remote, p.token, "main", 1);
    } catch (e) {
      throw httpError(e, "fetch trunk");
    }
    if (await this.hasCommit(p.baseSha)) return { baseSha: p.baseSha, fallback: false };
    try {
      await this.fetch(p.remote, p.token, p.baseSha, 1);
    } catch {
      // The server may refuse wants of unadvertised commits; deepen instead.
    }
    if (await this.hasCommit(p.baseSha)) return { baseSha: p.baseSha, fallback: false };
    try {
      await this.fetch(p.remote, p.token, "main", DEEPEN);
    } catch (e) {
      throw httpError(e, "deepen trunk");
    }
    if (await this.hasCommit(p.baseSha)) return { baseSha: p.baseSha, fallback: false };
    if (!tip) throw new Error("trunk has no main branch");
    return { baseSha: tip, fallback: true };
  }

  /** Fetch trunk's `main` at depth 1 (incremental) and return the commit it points at now, or null. */
  async fetchTip(p: { remote: string; token: string }): Promise<Sha | null> {
    await this.init();
    await this.repairShallow();
    let tip: string | null;
    try {
      tip = await this.fetch(p.remote, p.token, "main", 1);
    } catch (e) {
      throw httpError(e, "fetch trunk");
    }
    return tip && (await this.hasCommit(tip)) ? tip : null;
  }

  /** Every file path in the commit's tree. */
  async listFiles(baseSha: Sha): Promise<Path[]> {
    return git.listFiles({ fs: this.fs(), dir: this.dir, ref: baseSha, cache: this.cache });
  }

  /** The commit `refs/heads/main` of a remote repo points at (null when the branch does not exist). */
  async remoteHead(p: { remote: string; token: string }): Promise<Sha | null> {
    let refs: Array<{ ref: string; oid: string }>;
    try {
      refs = await git.listServerRefs({ http: this.http, url: p.remote, headers: auth(p.token), forPush: true, protocolVersion: 1, prefix: "refs/heads/main" });
    } catch (e) {
      throw httpError(e, "list workspace refs");
    }
    return refs.find((r) => r.ref === "refs/heads/main")?.oid ?? null;
  }

  /**
   * Fetch one trunk commit by id (shallow; only objects the clone lacks travel).
   * True when the commit is present afterwards; false when trunk does not serve it.
   */
  async fetchCommit(p: { remote: string; token: string; sha: Sha }): Promise<boolean> {
    await this.init();
    if (await this.hasCommit(p.sha)) return true;
    await this.repairShallow();
    try {
      await this.fetch(p.remote, p.token, p.sha, 1);
    } catch {
      return false;
    }
    return this.hasCommit(p.sha);
  }

  /** Parents of a local commit and whether an in-platform agent made it (null when absent). */
  async commitInfo(sha: Sha): Promise<{ parents: Sha[]; byAgent: boolean } | null> {
    try {
      const { commit } = await git.readCommit({ fs: this.fs(), dir: this.dir, oid: sha, cache: this.cache });
      return { parents: commit.parent, byAgent: commit.author.email.endsWith(AGENT_EMAIL) };
    } catch {
      return null;
    }
  }

  /** Blob id of each path at a local commit (null when absent or not a file). */
  async blobsAt(sha: Sha, paths: Path[]): Promise<Map<Path, Sha | null>> {
    const out = new Map<Path, Sha | null>();
    for (const path of paths) {
      const e = await this.entryAt(sha, path);
      out.set(path, e && e.type === "blob" ? e.oid : null);
    }
    return out;
  }

  private async entryAt(baseSha: Sha, path: Path): Promise<TreeEntry | null> {
    const fs = this.fs();
    const { commit } = await git.readCommit({ fs, dir: this.dir, oid: baseSha, cache: this.cache });
    let treeOid = commit.tree;
    const parts = path.split("/");
    for (let i = 0; i < parts.length; i++) {
      const { tree } = await git.readTree({ fs, dir: this.dir, oid: treeOid, cache: this.cache });
      const entry = tree.find((e) => e.path === parts[i]) as TreeEntry | undefined;
      if (!entry) return null;
      if (i === parts.length - 1) return entry;
      if (entry.type !== "tree") return null;
      treeOid = entry.oid;
    }
    return null;
  }

  /** A file at the base commit with its blob id and mode, or null when absent (or not a file). */
  async readFile(baseSha: Sha, path: Path): Promise<BaseFile | null> {
    const entry = await this.entryAt(baseSha, path);
    if (!entry || entry.type !== "blob") return null;
    const { blob } = await git.readBlob({ fs: this.fs(), dir: this.dir, oid: entry.oid, cache: this.cache });
    return { blob: entry.oid, mode: entry.mode, bytes: blob };
  }

  private async replacePath(treeOid: string | null, parts: string[], blobOid: string): Promise<string> {
    const fs = this.fs();
    const tree: TreeEntry[] = treeOid ? ((await git.readTree({ fs, dir: this.dir, oid: treeOid, cache: this.cache })).tree as TreeEntry[]) : [];
    const [head, ...rest] = parts;
    if (!head) throw new Error("empty path");
    const idx = tree.findIndex((e) => e.path === head);
    const existing = idx >= 0 ? tree[idx] : undefined;
    let entry: TreeEntry;
    if (rest.length === 0) {
      const mode = existing && existing.type === "blob" && (existing.mode === "100644" || existing.mode === "100755") ? existing.mode : "100644";
      entry = { mode, path: head, oid: blobOid, type: "blob" };
    } else {
      const sub = existing && existing.type === "tree" ? existing.oid : null;
      entry = { mode: "040000", path: head, oid: await this.replacePath(sub, rest, blobOid), type: "tree" };
    }
    if (idx >= 0) tree[idx] = entry;
    else tree.push(entry);
    return git.writeTree({ fs, dir: this.dir, tree });
  }

  /** Write the new contents as blobs, graft them into the base tree, and commit on top of the base. */
  async commit(p: {
    baseSha: Sha;
    changes: Array<{ path: Path; content: string }>;
    message: string;
    author: { name: string; email: string };
    timestamp: number;
  }): Promise<{ headSha: Sha; writeSet: FileVersion[] }> {
    const fs = this.fs();
    const { commit } = await git.readCommit({ fs, dir: this.dir, oid: p.baseSha, cache: this.cache });
    let tree = commit.tree;
    const writeSet: FileVersion[] = [];
    const enc = new TextEncoder();
    for (const c of p.changes) {
      const blob = await git.writeBlob({ fs, dir: this.dir, blob: enc.encode(c.content) });
      tree = await this.replacePath(tree, c.path.split("/"), blob);
      writeSet.push({ path: c.path, blob });
    }
    const who = { name: p.author.name, email: p.author.email, timestamp: p.timestamp, timezoneOffset: 0 };
    const headSha = await git.writeCommit({
      fs,
      dir: this.dir,
      commit: { message: p.message, tree, parent: [p.baseSha], author: who, committer: who },
    });
    await git.writeRef({ fs, dir: this.dir, ref: LOCAL_BRANCH, value: headSha, force: true });
    return { headSha, writeSet };
  }

  /** Force-push the commit to `main` of the workspace repo. */
  async push(p: { remote: string; token: string; headSha: Sha }): Promise<void> {
    const fs = this.fs();
    await git.writeRef({ fs, dir: this.dir, ref: LOCAL_BRANCH, value: p.headSha, force: true });
    let r: { ok: boolean; error: string | null; refs: Record<string, { ok: boolean; error?: string }> };
    try {
      r = await git.push({
        fs,
        http: this.http,
        dir: this.dir,
        url: p.remote,
        ref: LOCAL_BRANCH,
        remoteRef: "refs/heads/main",
        force: true,
        headers: auth(p.token),
        cache: this.cache,
      });
    } catch (e) {
      throw httpError(e, "push workspace");
    }
    const main = r.refs?.["refs/heads/main"];
    if (!r.ok || (main && !main.ok)) throw new Error(`push rejected: ${main?.error || r.error || "unknown"}`);
  }

  /** Drop the local clone (reclaims storage; the next job fetches again). */
  async reset(): Promise<void> {
    this.cache = {};
    this.initialized = false;
    await this.ws.fs.rm(this.dir, { recursive: true, force: true });
  }
}
