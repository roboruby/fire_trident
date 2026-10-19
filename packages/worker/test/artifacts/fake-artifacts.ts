import git from "isomorphic-git";
import { memoryFs, type GitRepo } from "../../src/artifacts/git.ts";

/**
 * A fake Cloudflare Artifacts service for one Cloudflare account, in memory: the REST API (namespaces, repos, forks,
 * imports, tokens, and the log, commit, tree and blob reads, in Cloudflare's v4 envelope) and git's smart HTTP protocol
 * (upload-pack with shallow fetches, receive-pack with compare-and-swap ref updates) for the remotes it hands out, over
 * isomorphic-git repositories. Pass `fetch` to the REST adapter, or install it as the global fetch so git reaches it.
 * It records every call, so tests can see which account, namespace and token each one used.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();
const ZERO = "0".repeat(40);
const API = "https://api.cloudflare.com/client/v4/accounts/";

/** One recorded call. */
export interface FakeCall {
  kind: "rest" | "git";
  method: string;
  /** REST: the path below /accounts/{account}/artifacts; git: "<namespace>/<repo> <service>". */
  path: string;
  account: string;
  bearer: string;
}

interface FakeToken {
  id: string;
  plaintext: string;
  scope: "read" | "write";
  state: "active" | "revoked";
  createdAt: string;
  expiresAt: number;
}

/** A repository in the fake. */
export interface FakeRepo {
  id: string;
  name: string;
  namespace: string;
  description: string | null;
  defaultBranch: string;
  readOnly: boolean;
  source: string | null;
  createdAt: string;
  lastPushAt: string | null;
  g: GitRepo;
  tokens: Map<string, FakeToken>;
}

function randomHex(n: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(Math.ceil(n / 2)));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, n);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** One pkt-line. */
function pkt(data: string | Uint8Array): Uint8Array {
  const body = typeof data === "string" ? enc.encode(data) : data;
  return concat([enc.encode((body.length + 4).toString(16).padStart(4, "0")), body]);
}
const FLUSH = enc.encode("0000");

/** Read pkt-lines from `bytes` (null for a flush) until the end, or until the first flush when `untilFlush`. */
function readPkts(bytes: Uint8Array, untilFlush = false): { lines: Array<Uint8Array | null>; rest: Uint8Array } {
  const lines: Array<Uint8Array | null> = [];
  let at = 0;
  while (at + 4 <= bytes.length) {
    const len = Number.parseInt(dec.decode(bytes.subarray(at, at + 4)), 16);
    if (!Number.isFinite(len)) break;
    if (len === 0) {
      at += 4;
      lines.push(null);
      if (untilFlush) break;
      continue;
    }
    lines.push(bytes.subarray(at + 4, at + len));
    at += len;
  }
  return { lines, rest: bytes.subarray(at) };
}

/** Pack data on side-band channel 1, then a flush. */
function sideband(data: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  for (let i = 0; i < data.length; i += 65_000) parts.push(pkt(concat([Uint8Array.of(1), data.subarray(i, i + 65_000)])));
  return concat([...parts, FLUSH]);
}

function json(status: number, result: unknown, info?: unknown): Response {
  return new Response(JSON.stringify({ result, success: status < 400, errors: [], messages: [], ...(info ? { result_info: info } : {}) }), { status, headers: { "content-type": "application/json" } });
}

function fail(status: number, code: number, message: string): Response {
  return new Response(JSON.stringify({ result: null, success: false, errors: [{ code, message }], messages: [] }), { status, headers: { "content-type": "application/json" } });
}

/** A canonical git mode and the binding's entry type for it. */
function entryType(mode: string): { mode: string; type: string } {
  const m = mode.replace(/^0+/, "");
  if (m === "40000") return { mode: m, type: "tree" };
  if (m === "100755") return { mode: m, type: "exec" };
  if (m === "120000") return { mode: m, type: "symlink" };
  if (m === "160000") return { mode: m, type: "gitlink" };
  return { mode: m, type: "blob" };
}

/** The fake service. */
export class FakeArtifacts {
  readonly accountId: string;
  accessToken: string;
  readonly namespaces = new Map<string, Map<string, FakeRepo>>();
  /** Namespaces made by POST /namespaces (not by a repo create). */
  readonly createdNamespaces: string[] = [];
  /** Public repos an import can copy, by URL. */
  readonly sources = new Map<string, FakeRepo>();
  readonly calls: FakeCall[] = [];
  /** Failures to answer instead: the first whose pattern matches "METHOD path" answers, `times` times. */
  readonly failures: Array<{ match: RegExp; status: number; code?: number; message?: string; times: number }> = [];

  constructor(opts: { accountId?: string; accessToken?: string } = {}) {
    this.accountId = opts.accountId ?? randomHex(32);
    this.accessToken = opts.accessToken ?? `cf-access-${randomHex(12)}`;
  }

  /** Where git reaches this account's repositories. */
  get gitHost(): string {
    return `https://${this.accountId}.artifacts.cloudflare.net`;
  }

  /** Answer `times` matching REST calls with an error. */
  failNext(match: RegExp, status: number, code?: number, message = "injected failure", times = 1): void {
    this.failures.push({ match, status, ...(code !== undefined ? { code } : {}), message, times });
  }

  repo(namespace: string, name: string): FakeRepo | undefined {
    return this.namespaces.get(namespace)?.get(name);
  }

  /** Where `ref` points in a repo, or null. */
  async head(namespace: string, name: string, ref = "refs/heads/main"): Promise<string | null> {
    const r = this.repo(namespace, name);
    if (!r) return null;
    try {
      return await git.resolveRef({ fs: r.g.fs, dir: r.g.dir, ref });
    } catch {
      return null;
    }
  }

  /** A file's text at `ref` in a repo, or null. */
  async readText(namespace: string, name: string, path: string, ref = "refs/heads/main"): Promise<string | null> {
    const r = this.repo(namespace, name);
    const oid = await this.head(namespace, name, ref);
    if (!r || !oid) return null;
    try {
      return dec.decode((await git.readBlob({ fs: r.g.fs, dir: r.g.dir, oid, filepath: path })).blob);
    } catch {
      return null;
    }
  }

  /** A public repository an import can copy from `url`, holding one commit of `files` on `branch`. */
  async addSource(url: string, files: Record<string, string>, branch = "main"): Promise<string> {
    const r = await this.newRepo("public", `source-${this.sources.size}`, { defaultBranch: branch });
    const oid = await commitFiles(r.g, files, [], "source");
    await git.writeRef({ fs: r.g.fs, dir: r.g.dir, ref: `refs/heads/${branch}`, value: oid, force: true });
    this.sources.set(url, r);
    return oid;
  }

  /** The fetch every request goes through. */
  readonly fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(req.url);
    const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "")?.[1] ?? "";
    const body = new Uint8Array(await req.arrayBuffer());
    if (req.url.startsWith(API)) return this.rest(req.method, url, body, bearer);
    if (url.origin === this.gitHost && url.pathname.startsWith("/git/")) return this.gitRequest(req.method, url, body, bearer);
    return new Response(`no fake answers ${url.origin}`, { status: 502 });
  };

  // -------------------------------------------------------------------------
  // REST
  // -------------------------------------------------------------------------

  private async rest(method: string, url: URL, body: Uint8Array, bearer: string): Promise<Response> {
    const tail = url.pathname.slice(new URL(API).pathname.length);
    const [account, artifacts, ...segs] = tail.split("/").map((s) => decodeURIComponent(s));
    const path = `/${segs.join("/")}`;
    this.calls.push({ kind: "rest", method, path, account: account ?? "", bearer });
    if (artifacts !== "artifacts") return fail(404, 7003, "no route");
    if (bearer !== this.accessToken) return fail(401, 10000, "Authentication error");
    if (account !== this.accountId) return fail(403, 10000, "Authentication error");
    const injected = this.failures.find((f) => f.times > 0 && f.match.test(`${method} ${path}`));
    if (injected) {
      injected.times--;
      return injected.code === undefined ? new Response("upstream trouble", { status: injected.status }) : fail(injected.status, injected.code, injected.message ?? "failure");
    }
    const input = body.length > 0 ? (JSON.parse(dec.decode(body)) as Record<string, unknown>) : {};
    const q = url.searchParams;
    if (segs[0] !== "namespaces") return fail(404, 7003, "no route");
    const ns = segs[1];
    if (ns === undefined) {
      if (method === "POST") {
        const name = String(input.namespace ?? "");
        if (this.namespaces.has(name)) return fail(409, 10201, "namespace already exists");
        this.namespaces.set(name, new Map());
        this.createdNamespaces.push(name);
        return json(201, this.nsInfo(name));
      }
      return json(200, [...this.namespaces.keys()].map((n) => this.nsInfo(n)));
    }
    if (segs.length === 2) {
      if (!this.namespaces.has(ns)) return fail(404, 10200, "namespace not found");
      return json(200, this.nsInfo(ns));
    }
    if (segs[2] === "tokens") {
      if (method === "POST") {
        const r = this.repo(ns, String(input.repo ?? ""));
        if (!r) return fail(404, 10200, "repo not found");
        const ttl = Number(input.ttl ?? 86_400);
        if (!(ttl >= 60 && ttl <= 31_536_000)) return fail(400, 10103, "ttl out of range");
        const t = this.mint(r, input.scope === "read" ? "read" : "write", ttl);
        return json(201, { id: t.id, plaintext: t.plaintext, scope: t.scope, expires_at: new Date(t.expiresAt).toISOString() });
      }
      if (method === "DELETE" && segs[3]) {
        for (const r of this.namespaces.get(ns)?.values() ?? []) {
          const t = r.tokens.get(segs[3]);
          if (t) {
            t.state = "revoked";
            return json(200, { id: t.id });
          }
        }
        return fail(404, 10200, "token not found");
      }
    }
    if (segs[2] !== "repos") return fail(404, 7003, "no route");
    const name = segs[3];
    if (name === undefined) {
      if (method === "POST") {
        const n = String(input.name ?? "");
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(n)) return fail(400, 10101, "invalid repo name");
        if (this.repo(ns, n)) return fail(409, 10201, "repo already exists");
        const r = await this.newRepo(ns, n, { defaultBranch: typeof input.default_branch === "string" ? input.default_branch : "main", description: typeof input.description === "string" ? input.description : null });
        return json(201, this.created(r));
      }
      const all = [...(this.namespaces.get(ns)?.values() ?? [])].sort((a, b) => a.name.localeCompare(b.name));
      const limit = Number(q.get("limit") ?? 50);
      const from = Number(q.get("cursor") ?? 0);
      const page = all.slice(from, from + limit);
      return json(200, page.map((r) => this.info(r)), { cursor: from + limit < all.length ? String(from + limit) : "", per_page: limit, count: page.length });
    }
    const r = this.repo(ns, name);
    const action = segs[4];
    if (action === "import" && method === "POST") {
      if (r) return fail(409, 10201, "repo already exists");
      const src = this.sources.get(String(input.url ?? ""));
      if (!src) return fail(404, 10200, "remote repository not found");
      const target = await this.newRepo(ns, name, { defaultBranch: src.defaultBranch });
      target.source = String(input.url);
      await copyRepo(src.g, target.g, null);
      return json(201, this.created(target));
    }
    if (!r) return fail(404, 10200, "repo not found");
    if (action === undefined) {
      if (method === "DELETE") {
        this.namespaces.get(ns)?.delete(name);
        return json(202, { id: r.id });
      }
      return json(200, this.info(r));
    }
    const { fs, dir } = r.g;
    switch (action) {
      case "fork": {
        const n = String(input.name ?? "");
        if (this.repo(ns, n)) return fail(409, 10201, "repo already exists");
        const f = await this.newRepo(ns, n, { defaultBranch: r.defaultBranch, description: typeof input.description === "string" ? input.description : null });
        f.source = `artifacts:${ns}/${name}`;
        await copyRepo(r.g, f.g, input.default_branch_only === false ? null : `refs/heads/${r.defaultBranch}`);
        return json(201, { ...this.created(f), objects: 0 });
      }
      case "log": {
        let oid: string;
        try {
          oid = await git.resolveRef({ fs, dir, ref: q.get("ref") || "HEAD" });
        } catch {
          return fail(404, 10200, "ref not found");
        }
        const out: unknown[] = [];
        const offset = Number(q.get("offset") ?? 0);
        const limit = Number(q.get("limit") ?? 50);
        for (let i = 0; oid && out.length < limit; i++) {
          const meta = await commitMeta(r.g, oid);
          if (!meta) break;
          if (i >= offset) out.push(meta);
          oid = meta.parents[0] ?? "";
        }
        return json(200, out);
      }
      case "commit": {
        const meta = await commitMeta(r.g, segs[5] ?? "");
        return meta ? json(200, meta) : fail(404, 10200, "commit not found");
      }
      case "tree": {
        try {
          const { tree } = await git.readTree({ fs, dir, oid: segs[5] ?? "" });
          return json(200, tree.map((e) => ({ name: e.path, hash: e.oid, ...entryType(e.mode) })));
        } catch {
          return fail(404, 10200, "tree not found");
        }
      }
      case "blob": {
        try {
          const { blob } = await git.readBlob({ fs, dir, oid: segs[5] ?? "" });
          return new Response(blob, { status: 200, headers: { "content-type": "application/octet-stream" } });
        } catch {
          return fail(404, 10200, "blob not found");
        }
      }
      case "file": {
        try {
          const oid = await git.resolveRef({ fs, dir, ref: q.get("ref") ?? "HEAD" });
          const { blob } = await git.readBlob({ fs, dir, oid, filepath: q.get("path") ?? "" });
          return new Response(blob, { status: 200, headers: { "content-type": "application/octet-stream" } });
        } catch {
          return fail(404, 10200, "file not found");
        }
      }
      case "tokens": {
        const list = [...r.tokens.values()].map((t) => ({ id: t.id, scope: t.scope, state: t.state === "revoked" ? "revoked" : t.expiresAt < Date.now() ? "expired" : "active", created_at: t.createdAt, expires_at: new Date(t.expiresAt).toISOString() }));
        return json(200, list, { page: 1, per_page: 100, total_pages: 1, count: list.length, total_count: list.length });
      }
    }
    return fail(404, 7003, "no route");
  }

  private nsInfo(name: string): unknown {
    const now = new Date().toISOString();
    return { namespace: name, jurisdiction: "unrestricted", repo_count: this.namespaces.get(name)?.size ?? 0, created_at: now, updated_at: now };
  }

  private info(r: FakeRepo): unknown {
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      default_branch: r.defaultBranch,
      created_at: r.createdAt,
      updated_at: r.lastPushAt ?? r.createdAt,
      last_push_at: r.lastPushAt,
      source: r.source,
      read_only: r.readOnly,
      remote: this.remoteOf(r),
    };
  }

  private created(r: FakeRepo): Record<string, unknown> {
    return { id: r.id, name: r.name, description: r.description, default_branch: r.defaultBranch, remote: this.remoteOf(r), token: this.mint(r, "write", 86_400).plaintext };
  }

  remoteOf(r: Pick<FakeRepo, "namespace" | "name">): string {
    return `${this.gitHost}/git/${r.namespace}/${r.name}.git`;
  }

  private mint(r: FakeRepo, scope: "read" | "write", ttlSec: number): FakeToken {
    const expiresAt = Date.now() + ttlSec * 1000;
    const t: FakeToken = { id: randomHex(16), plaintext: `art_v1_${randomHex(40)}?expires=${Math.floor(expiresAt / 1000)}`, scope, state: "active", createdAt: new Date().toISOString(), expiresAt };
    r.tokens.set(t.id, t);
    return t;
  }

  private async newRepo(namespace: string, name: string, o: { defaultBranch?: string; description?: string | null }): Promise<FakeRepo> {
    let ns = this.namespaces.get(namespace);
    if (!ns) {
      ns = new Map();
      this.namespaces.set(namespace, ns);
    }
    const g: GitRepo = { fs: memoryFs(), dir: "/repo", cache: {} };
    const defaultBranch = o.defaultBranch ?? "main";
    await git.init({ fs: g.fs, dir: g.dir, defaultBranch });
    const r: FakeRepo = { id: `repo_${randomHex(8)}`, name, namespace, description: o.description ?? null, defaultBranch, readOnly: false, source: null, createdAt: new Date().toISOString(), lastPushAt: null, g, tokens: new Map() };
    ns.set(name, r);
    return r;
  }

  // -------------------------------------------------------------------------
  // Git smart HTTP
  // -------------------------------------------------------------------------

  private async gitRequest(method: string, url: URL, body: Uint8Array, bearer: string): Promise<Response> {
    const m = /^\/git\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(url.pathname);
    if (!m) return new Response("not found", { status: 404 });
    const [, namespace, name, what] = m as unknown as [string, string, string, string];
    const service = what === "info/refs" ? (url.searchParams.get("service") ?? "") : what;
    this.calls.push({ kind: "git", method, path: `${namespace}/${name} ${service}`, account: this.accountId, bearer });
    const r = this.repo(namespace, name);
    if (!r) return new Response("repository not found", { status: 404 });
    const token = [...r.tokens.values()].find((t) => t.plaintext === bearer && t.state === "active" && t.expiresAt > Date.now());
    if (!token || (service === "git-receive-pack" && token.scope !== "write")) return new Response("unauthorized", { status: 401 });
    if (what === "info/refs") return this.advertise(r, service);
    if (what === "git-upload-pack") return this.uploadPack(r, body);
    return this.receivePack(r, body);
  }

  private async refs(r: FakeRepo): Promise<Array<{ ref: string; oid: string }>> {
    const { fs, dir } = r.g;
    const names = (await git.listRefs({ fs, dir, filepath: "refs" })).map((n) => `refs/${n}`).sort();
    const out: Array<{ ref: string; oid: string }> = [];
    for (const ref of names) out.push({ ref, oid: await git.resolveRef({ fs, dir, ref }) });
    return out;
  }

  private async advertise(r: FakeRepo, service: string): Promise<Response> {
    const refs = await this.refs(r);
    const upload = service === "git-upload-pack";
    const head = refs.find((x) => x.ref === `refs/heads/${r.defaultBranch}`);
    const caps = upload
      ? `side-band-64k shallow no-progress allow-tip-sha1-in-want allow-reachable-sha1-in-want symref=HEAD:refs/heads/${r.defaultBranch} agent=fake/1`
      : "report-status delete-refs side-band-64k no-thin agent=fake/1";
    const lines = upload && head ? [{ ref: "HEAD", oid: head.oid }, ...refs] : refs;
    const parts = [pkt(`# service=${service}\n`), FLUSH];
    if (lines.length === 0) parts.push(pkt(`${ZERO} capabilities^{}\0${caps}\n`));
    lines.forEach((l, i) => parts.push(pkt(i === 0 ? `${l.oid} ${l.ref}\0${caps}\n` : `${l.oid} ${l.ref}\n`)));
    parts.push(FLUSH);
    return new Response(concat(parts), { status: 200, headers: { "content-type": `application/x-${service}-advertisement` } });
  }

  private async uploadPack(r: FakeRepo, body: Uint8Array): Promise<Response> {
    const wants: string[] = [];
    let depth: number | null = null;
    for (const line of readPkts(body).lines) {
      if (line === null) continue;
      const text = dec.decode(line).trim();
      if (text.startsWith("want ")) wants.push(text.slice(5, 45));
      else if (text.startsWith("deepen ")) depth = Number(text.slice(7));
    }
    const { oids, shallow } = await reachable(r.g, wants, depth);
    const { packfile } = await git.packObjects({ fs: r.g.fs, dir: r.g.dir, oids, cache: r.g.cache });
    const parts: Uint8Array[] = [];
    if (depth !== null) {
      for (const oid of shallow) parts.push(pkt(`shallow ${oid}\n`));
      parts.push(FLUSH);
    }
    parts.push(pkt("NAK\n"), sideband(packfile ?? new Uint8Array()));
    return new Response(concat(parts), { status: 200, headers: { "content-type": "application/x-git-upload-pack-result" } });
  }

  private async receivePack(r: FakeRepo, body: Uint8Array): Promise<Response> {
    const { fs, dir, cache } = r.g;
    const { lines, rest } = readPkts(body, true);
    const commands = lines.filter((l): l is Uint8Array => l !== null).map((l) => dec.decode(l).split("\0")[0]!.trim().split(" ") as [string, string, string]);
    if (rest.length >= 12 && new DataView(rest.buffer, rest.byteOffset + 8, 4).getUint32(0) > 0) {
      const name = [...rest.subarray(rest.length - 20)].map((b) => b.toString(16).padStart(2, "0")).join("");
      const file = `.git/objects/pack/pack-${name}.pack`;
      await fs.promises.mkdir(`${dir}/.git/objects/pack`, { recursive: true } as never).catch(() => undefined);
      await fs.promises.writeFile(`${dir}/${file}`, rest);
      await git.indexPack({ fs, dir, filepath: file, cache });
    }
    const report: Uint8Array[] = [pkt("unpack ok\n")];
    for (const [oldOid, newOid, ref] of commands) {
      let current = ZERO;
      try {
        current = await git.resolveRef({ fs, dir, ref });
      } catch {
        // absent
      }
      if (current !== oldOid) {
        report.push(pkt(`ng ${ref} stale info\n`));
        continue;
      }
      if (newOid === ZERO) await git.deleteRef({ fs, dir, ref });
      else await git.writeRef({ fs, dir, ref, value: newOid, force: true });
      r.lastPushAt = new Date().toISOString();
      report.push(pkt(`ok ${ref}\n`));
    }
    report.push(FLUSH);
    return new Response(concat([pkt(concat([Uint8Array.of(1), concat(report)])), FLUSH]), { status: 200, headers: { "content-type": "application/x-git-receive-pack-result" } });
  }
}

/** The binding's commit metadata of `oid`, or null when it is not a commit there. */
async function commitMeta(g: GitRepo, oid: string): Promise<{ hash: string; treeHash: string; message: string; author: { name: string; email: string }; committer: { name: string; email: string }; parents: string[]; authoredAt: number; committedAt: number } | null> {
  try {
    const { commit } = await git.readCommit({ fs: g.fs, dir: g.dir, oid, cache: g.cache });
    return {
      hash: oid,
      treeHash: commit.tree,
      message: commit.message.replace(/\n$/, ""),
      author: { name: commit.author.name, email: commit.author.email },
      committer: { name: commit.committer.name, email: commit.committer.email },
      parents: commit.parent,
      authoredAt: commit.author.timestamp,
      committedAt: commit.committer.timestamp,
    };
  } catch {
    return null;
  }
}

/** Every object reachable from `tips` (commits `depth` deep when given), and the commits cut off there. */
async function reachable(g: GitRepo, tips: string[], depth: number | null): Promise<{ oids: string[]; shallow: string[] }> {
  const { fs, dir, cache } = g;
  const out = new Set<string>();
  const shallow: string[] = [];
  const queue = tips.map((oid) => ({ oid, level: 1 }));
  const trees = async (oid: string): Promise<void> => {
    if (out.has(oid)) return;
    out.add(oid);
    for (const e of (await git.readTree({ fs, dir, oid, cache })).tree) {
      if (e.type === "tree") await trees(e.oid);
      else if (e.type === "blob") out.add(e.oid);
    }
  };
  while (queue.length > 0) {
    const { oid, level } = queue.shift()!;
    if (out.has(oid)) continue;
    out.add(oid);
    const { commit } = await git.readCommit({ fs, dir, oid, cache });
    await trees(commit.tree);
    if (depth !== null && level >= depth && commit.parent.length > 0) shallow.push(oid);
    else for (const p of commit.parent) queue.push({ oid: p, level: level + 1 });
  }
  return { oids: [...out], shallow };
}

/** Copy every object reachable from `from`'s heads (or only `onlyRef`) into `to`, with those refs and HEAD. */
async function copyRepo(from: GitRepo, to: GitRepo, onlyRef: string | null): Promise<void> {
  const names = (await git.listRefs({ fs: from.fs, dir: from.dir, filepath: "refs/heads" })).map((n) => `refs/heads/${n}`);
  const refs: Array<{ ref: string; oid: string }> = [];
  for (const ref of names) if (onlyRef === null || ref === onlyRef) refs.push({ ref, oid: await git.resolveRef({ fs: from.fs, dir: from.dir, ref }) });
  if (refs.length === 0) return;
  const { oids } = await reachable(from, refs.map((r) => r.oid), null);
  for (const oid of oids) {
    const o = await git.readObject({ fs: from.fs, dir: from.dir, oid, format: "content", cache: from.cache });
    await git.writeObject({ fs: to.fs, dir: to.dir, type: o.type as "blob" | "tree" | "commit" | "tag", object: o.object as Uint8Array, format: "content" });
  }
  for (const r of refs) await git.writeRef({ fs: to.fs, dir: to.dir, ref: r.ref, value: r.oid, force: true });
}

/** Commit `files` (path to text) as a root tree on `parents`; returns the commit. */
export async function commitFiles(g: GitRepo, files: Record<string, string>, parents: string[], message: string): Promise<string> {
  const { fs, dir } = g;
  const blobs = new Map<string, string>();
  for (const [path, text] of Object.entries(files)) blobs.set(path, await git.writeBlob({ fs, dir, blob: enc.encode(text) }));
  // Build nested trees from the paths.
  type Dir = { files: Map<string, string>; dirs: Map<string, Dir> };
  const top: Dir = { files: new Map(), dirs: new Map() };
  for (const [path, oid] of blobs) {
    const parts = path.split("/");
    let d = top;
    for (const p of parts.slice(0, -1)) {
      let next = d.dirs.get(p);
      if (!next) {
        next = { files: new Map(), dirs: new Map() };
        d.dirs.set(p, next);
      }
      d = next;
    }
    d.files.set(parts[parts.length - 1]!, oid);
  }
  const write = async (d: Dir): Promise<string> => {
    const tree: Array<{ mode: string; path: string; oid: string; type: "blob" | "tree" }> = [];
    for (const [name, oid] of d.files) tree.push({ mode: "100644", path: name, oid, type: "blob" });
    for (const [name, sub] of d.dirs) tree.push({ mode: "040000", path: name, oid: await write(sub), type: "tree" });
    return git.writeTree({ fs, dir, tree });
  };
  const who = { name: "Test", email: "test@example.invalid", timestamp: 1_700_000_000, timezoneOffset: 0 };
  return git.writeCommit({ fs, dir, commit: { message: `${message}\n`, tree: await write(top), parent: parents, author: who, committer: who } });
}
