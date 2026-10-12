// FireTrident measurement spike: Artifacts forks, git in a Durable Object,
// namespace push triggers, binding read APIs, and Clef latency.
// Every route returns JSON timings. Every route requires the x-spike-key header.
import { DurableObject, WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { Workspace } from "@cloudflare/computer";
import { createGitClient } from "@cloudflare/computer/git";
import { create as createVfs, VirtualProvider } from "@platformatic/vfs";
import git from "isomorphic-git";
import gitHttp from "isomorphic-git/http/web";

type Env = {
  A: Artifacts;
  B: Artifacts;
  AI: Ai;
  SPIKE_DO: DurableObjectNamespace<SpikeDO>;
  PUSH_WF: Workflow;
  SPIKE_KEY: string;
};

const IDENT = { name: "ft-spike", email: "spike@firetrident.invalid" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const who = () => ({ ...IDENT, timestamp: Math.floor(Date.now() / 1000), timezoneOffset: 0 });

function errInfo(e: unknown) {
  const x = e as any;
  return {
    name: x?.name,
    code: x?.code,
    numericCode: x?.numericCode,
    message: String(x?.message ?? x).slice(0, 600),
    data: x?.data ? JSON.stringify(x.data).slice(0, 600) : undefined,
  };
}

function stats(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => (s.length ? s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))] : null);
  return {
    n: s.length,
    min: s[0] ?? null,
    p50: q(0.5),
    p95: q(0.95),
    max: s[s.length - 1] ?? null,
    mean: s.length ? Math.round(s.reduce((a, b) => a + b, 0) / s.length) : null,
  };
}

function b64(bytes: Uint8Array) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

function dispose(x: any) {
  try {
    x?.[(Symbol as any).dispose]?.();
  } catch {}
}

const redact = (o: any) => (o && typeof o === "object" ? { ...o, token: o.token ? "<redacted>" : undefined } : o);

// ---------------------------------------------------------------------------
// isomorphic-git fs over the Workspace's SQLite VFS. Mirrors the adapter that
// @cloudflare/computer/git builds internally, so raw isomorphic-git calls
// (writeTree/writeCommit/addNote/push) and ws.git share one filesystem object.
const FORWARDED = [
  "open", "openSync", "stat", "statSync", "lstat", "lstatSync", "readdir", "readdirSync",
  "mkdir", "mkdirSync", "rmdir", "rmdirSync", "unlink", "unlinkSync", "rename", "renameSync",
  "readFile", "readFileSync", "writeFile", "writeFileSync", "appendFile", "appendFileSync",
  "exists", "existsSync", "copyFile", "copyFileSync", "internalModuleStat", "realpath",
  "realpathSync", "access", "accessSync", "readlink", "readlinkSync", "symlink", "symlinkSync",
  "watch", "watchAsync", "watchFile", "unwatchFile", "closeSync", "readSync", "writeSync",
  "fstatSync", "truncateSync", "ftruncateSync",
];

function buildIsoFs(provider: any) {
  const Base = VirtualProvider as any;
  class Glue extends Base {
    #inner: any;
    constructor(inner: any) {
      super();
      this.#inner = inner;
    }
    get readonly() {
      return this.#inner.readonly;
    }
    get supportsSymlinks() {
      return this.#inner.supportsSymlinks;
    }
    get supportsWatch() {
      return this.#inner.supportsWatch;
    }
    get inner() {
      return this.#inner;
    }
  }
  for (const name of FORWARDED) {
    Object.defineProperty(Glue.prototype, name, {
      value(this: any, ...args: any[]) {
        const fn = this.inner[name];
        if (typeof fn !== "function") throw new Error(`SQLiteWorkspaceProvider.${name} is not a function`);
        return fn.apply(this.inner, args);
      },
      writable: true,
      configurable: true,
    });
  }
  return { promises: (createVfs as any)(new Glue(provider), { moduleHooks: false }).promises };
}

// Replace the blob at `parts` inside tree `treeOid`, writing new tree objects bottom-up.
async function replacePath(fs: any, dir: string, treeOid: string, parts: string[], blobOid: string): Promise<string> {
  const { tree } = await git.readTree({ fs, dir, oid: treeOid });
  const [head, ...rest] = parts;
  const idx = tree.findIndex((e: any) => e.path === head);
  let entry: any;
  if (rest.length === 0) {
    entry = { mode: "100644", path: head, oid: blobOid, type: "blob" };
  } else {
    const sub = idx >= 0 ? tree[idx]!.oid : await git.writeTree({ fs, dir, tree: [] });
    entry = { mode: "040000", path: head, oid: await replacePath(fs, dir, sub, rest, blobOid), type: "tree" };
  }
  if (idx >= 0) tree[idx] = entry;
  else tree.push(entry);
  return git.writeTree({ fs, dir, tree });
}

// An isomorphic-git http client that serves a previously captured (stale)
// receive-pack ref advertisement, so the push carries a stale old-oid.
function replayHttp(adB64: string) {
  const bytes = Uint8Array.from(atob(adB64), (c) => c.charCodeAt(0));
  return {
    async request(req: any) {
      const method = req.method ?? "GET";
      if (method === "GET" && req.url.includes("/info/refs") && req.url.includes("service=git-receive-pack")) {
        return {
          url: req.url,
          method: "GET",
          statusCode: 200,
          statusMessage: "OK",
          headers: { "content-type": "application/x-git-receive-pack-advertisement" },
          body: (async function* () {
            yield bytes;
          })(),
        };
      }
      return (gitHttp as any).request(req);
    },
  };
}

// ---------------------------------------------------------------------------
export class SpikeDO extends DurableObject<Env> {
  private _ws?: Workspace;
  private _fs?: any;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS spike_push_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, recorded_at INTEGER, namespace TEXT, repo TEXT, ref TEXT,
      before_oid TEXT, after_oid TEXT, event_ts TEXT, wf_created_at INTEGER, wf_started_at INTEGER,
      instance_id TEXT, raw TEXT)`);
  }

  private ws(): Workspace {
    if (!this._ws) {
      this._ws = new Workspace({
        storage: this.ctx.storage as any,
        git: createGitClient({ adapter: async () => this.isoFs() }) as any,
        defaultGitIdentity: IDENT,
      });
    }
    return this._ws;
  }

  private isoFs() {
    if (!this._fs) this._fs = buildIsoFs(this.ws().provider());
    return this._fs;
  }

  async ping() {
    return { t: Date.now() };
  }

  // --- @cloudflare/computer git client: clone / write+commit / push
  async flowClone(p: { remote: string; token: string; dir: string }) {
    const t0 = Date.now();
    await this.ws().git.clone({ url: p.remote, dir: p.dir, headers: auth(p.token) });
    const cloneMs = Date.now() - t0;
    const head = await git.resolveRef({ fs: this.isoFs(), dir: p.dir, ref: "HEAD" });
    const files = (await this.ws().fs.readdir(p.dir)).map((f: any) => f.name);
    return { cloneMs, head, files };
  }

  async flowWriteCommit(p: { dir: string; file: string; content: string; message: string }) {
    const t0 = Date.now();
    await this.ws().fs.writeFile(`${p.dir}/${p.file}`, p.content);
    const t1 = Date.now();
    await this.ws().git.add({ dir: p.dir, paths: [p.file] });
    const c = await this.ws().git.commit({ dir: p.dir, message: p.message });
    return { writeMs: t1 - t0, commitMs: Date.now() - t1, oid: c.oid };
  }

  async flowPush(p: { dir: string; remote: string; token: string; ref?: string; remoteRef?: string; force?: boolean }) {
    const t0 = Date.now();
    try {
      const r = await this.ws().git.push({
        dir: p.dir,
        url: p.remote,
        ref: p.ref ?? "main",
        remoteRef: p.remoteRef,
        force: p.force,
        headers: auth(p.token),
      });
      return { ms: Date.now() - t0, result: r };
    } catch (e) {
      return { ms: Date.now() - t0, error: errInfo(e) };
    }
  }

  // --- raw isomorphic-git on the same fs
  async initFetch(p: { dir: string; remote: string; token: string; ref?: string; depth?: number }) {
    const fs = this.isoFs();
    const t0 = Date.now();
    await git.init({ fs, dir: p.dir, defaultBranch: "main" });
    await git.addRemote({ fs, dir: p.dir, remote: "origin", url: p.remote, force: true });
    const r = await git.fetch({
      fs, http: gitHttp, dir: p.dir, remote: "origin", ref: p.ref ?? "main",
      singleBranch: true, depth: p.depth, tags: false, headers: auth(p.token),
    });
    if (r.fetchHead) await git.writeRef({ fs, dir: p.dir, ref: "refs/heads/main", value: r.fetchHead, force: true });
    return { ms: Date.now() - t0, fetchHead: r.fetchHead, defaultBranch: r.defaultBranch };
  }

  async surgeryBuild(p: { dir: string; baseRef: string; path: string; content: string; branch: string; message: string }) {
    const fs = this.isoFs();
    const dir = p.dir;
    const t0 = Date.now();
    const base = /^[0-9a-f]{40}$/.test(p.baseRef) ? p.baseRef : await git.resolveRef({ fs, dir, ref: p.baseRef });
    const { commit } = await git.readCommit({ fs, dir, oid: base });
    const blob = await git.writeBlob({ fs, dir, blob: new TextEncoder().encode(p.content) });
    const tree = await replacePath(fs, dir, commit.tree, p.path.split("/"), blob);
    const w = who();
    const oid = await git.writeCommit({
      fs, dir, commit: { message: p.message, tree, parent: [base], author: w, committer: w },
    });
    await git.writeRef({ fs, dir, ref: `refs/heads/${p.branch}`, value: oid, force: true });
    return { ms: Date.now() - t0, base, baseTree: commit.tree, blob, tree, commit: oid };
  }

  async noteAdd(p: { dir: string; oid: string; note: string; notesRef: string }) {
    const fs = this.isoFs();
    const t0 = Date.now();
    const w = who();
    const noteCommit = await git.addNote({
      fs, dir: p.dir, ref: p.notesRef, oid: p.oid, note: p.note, author: w, committer: w, force: true,
    });
    const back = await git.readNote({ fs, dir: p.dir, ref: p.notesRef, oid: p.oid });
    return { ms: Date.now() - t0, noteCommit, readBack: new TextDecoder().decode(back) };
  }

  async isoPush(p: {
    dir: string; remote: string; token: string; ref: string; remoteRef?: string; force?: boolean; staleAdvertB64?: string;
  }) {
    const fs = this.isoFs();
    const http = p.staleAdvertB64 ? replayHttp(p.staleAdvertB64) : gitHttp;
    const t0 = Date.now();
    try {
      const r = await git.push({
        fs, http: http as any, dir: p.dir, url: p.remote, ref: p.ref, remoteRef: p.remoteRef,
        force: p.force, headers: auth(p.token),
      });
      return { ms: Date.now() - t0, result: { ok: r.ok, error: r.error, refs: r.refs } };
    } catch (e) {
      return { ms: Date.now() - t0, error: errInfo(e) };
    }
  }

  async captureAdvert(p: { remote: string; token: string }) {
    const t0 = Date.now();
    const res = await fetch(`${p.remote}/info/refs?service=git-receive-pack`, {
      headers: { ...auth(p.token), "user-agent": "git/isomorphic-git@1.43.3" },
    });
    const buf = new Uint8Array(await res.arrayBuffer());
    return {
      ms: Date.now() - t0,
      status: res.status,
      contentType: res.headers.get("content-type"),
      b64: b64(buf),
      text: new TextDecoder().decode(buf).slice(0, 600),
    };
  }

  async resolve(p: { dir: string; ref: string }) {
    return git.resolveRef({ fs: this.isoFs(), dir: p.dir, ref: p.ref });
  }

  // --- namespace push trigger: commit + push to a repo in ft-spike-b
  async triggerPush(p: { dir: string; remote: string; token: string; tag: string }) {
    const fs = this.isoFs();
    const dir = p.dir;
    try {
      await fs.promises.stat(`${dir}/.git/HEAD`);
    } catch {
      await git.init({ fs, dir, defaultBranch: "main" });
    }
    await fs.promises.writeFile(`${dir}/push.txt`, `${p.tag} ${Date.now()}\n`);
    await git.add({ fs, dir, filepath: "push.txt" });
    const w = who();
    const after = await git.commit({ fs, dir, message: `trigger ${p.tag}`, author: w, committer: w });
    const pushStart = Date.now();
    try {
      const r = await git.push({
        fs, http: gitHttp, dir, url: p.remote, ref: "main", remoteRef: "refs/heads/main", headers: auth(p.token),
      });
      const pushEnd = Date.now();
      return { after, pushStart, pushEnd, pushMs: pushEnd - pushStart, ok: r.ok, refs: r.refs };
    } catch (e) {
      return { after, pushStart, pushEnd: Date.now(), error: errInfo(e) };
    }
  }

  async recordPush(r: any) {
    this.ctx.storage.sql.exec(
      `INSERT INTO spike_push_events (recorded_at, namespace, repo, ref, before_oid, after_oid, event_ts,
        wf_created_at, wf_started_at, instance_id, raw) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      Date.now(), r.namespace, r.repo, r.ref, r.before, r.after, r.eventTs, r.wfCreatedAt, r.wfStartedAt,
      r.instanceId, r.raw,
    );
    return true;
  }

  async listPushes() {
    return this.ctx.storage.sql.exec(`SELECT * FROM spike_push_events ORDER BY id`).toArray();
  }

  async clearPushes() {
    this.ctx.storage.sql.exec(`DELETE FROM spike_push_events`);
    return true;
  }
}

// ---------------------------------------------------------------------------
export class SpikePushWorkflow extends WorkflowEntrypoint<Env, any> {
  async run(event: WorkflowEvent<any>, step: WorkflowStep) {
    const wfStartedAt = Date.now();
    await step.do("record", async () => {
      const ev = (event as any).payload ?? {};
      const inner = ev.payload ?? ev;
      const ts = (event as any).timestamp;
      const rec = {
        namespace: ev.source?.namespace ?? null,
        repo: ev.source?.repoName ?? null,
        ref: inner.ref ?? null,
        before: inner.before ?? null,
        after: inner.after ?? null,
        eventTs: ev.metadata?.eventTimestamp ?? null,
        wfCreatedAt: ts ? new Date(ts).getTime() : null,
        wfStartedAt,
        instanceId: (event as any).instanceId ?? null,
        raw: JSON.stringify(ev).slice(0, 4000),
      };
      const stub = this.env.SPIKE_DO.get(this.env.SPIKE_DO.idFromName("events"));
      await stub.recordPush(rec);
      return { ok: true };
    });
  }
}

// ---------------------------------------------------------------------------
type Ops = { n: number };

function nsOf(env: Env, ns: string): Artifacts {
  if (ns === "a") return env.A;
  if (ns === "b") return env.B;
  throw new Error(`unknown namespace ${ns}`);
}

async function waitReady(ns: Artifacts, name: string, ops: Ops, t0: number, requireCommit = true, timeoutMs = 120000) {
  let delay = 100;
  let polls = 0;
  const errors: Record<string, number> = {};
  while (Date.now() - t0 < timeoutMs) {
    polls++;
    try {
      ops.n++;
      const repo = await ns.get(name);
      try {
        if (!requireCommit) {
          ops.n++;
          await repo.info();
          return { readyMs: Date.now() - t0, polls, errors };
        }
        ops.n++;
        const log = await repo.log({ limit: 1 });
        if (log.length > 0) return { readyMs: Date.now() - t0, polls, head: log[0]!.hash, errors };
        errors["EMPTY_LOG"] = (errors["EMPTY_LOG"] ?? 0) + 1;
      } finally {
        dispose(repo);
      }
    } catch (e) {
      const c = (e as any)?.code ?? String((e as any)?.message).slice(0, 80);
      errors[c] = (errors[c] ?? 0) + 1;
    }
    await sleep(delay);
    delay = Math.min(1000, Math.round(delay * 1.5));
  }
  return { readyMs: null, polls, errors, timeout: true };
}

const tokenCache = new Map<string, { remote: string; token: string; exp: number }>();
async function repoAccess(env: Env, ns: string, repoName: string, scope: "read" | "write", ops: Ops) {
  const key = `${ns}/${repoName}/${scope}`;
  const hit = tokenCache.get(key);
  if (hit && hit.exp > Date.now() + 60000) return hit;
  ops.n++;
  const repo = await nsOf(env, ns).get(repoName);
  try {
    ops.n += 2;
    const [info, tok] = await Promise.all([repo.info(), repo.createToken(scope, 3600)]);
    const v = { remote: info.remote, token: tok.plaintext, exp: Date.parse(tok.expiresAt) || Date.now() + 3600e3 };
    tokenCache.set(key, v);
    return v;
  } finally {
    dispose(repo);
  }
}

const doStub = (env: Env, name?: string) => env.SPIKE_DO.get(env.SPIKE_DO.idFromName(name ?? "git-1"));

async function timeN<T>(n: number, ops: Ops, fn: () => Promise<T>) {
  const ms: number[] = [];
  let last: T | undefined;
  const errors: any[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = Date.now();
    try {
      ops.n++;
      last = await fn();
    } catch (e) {
      errors.push(errInfo(e));
    }
    ms.push(Date.now() - t0);
  }
  return { stats: stats(ms), raw: ms, last, errors };
}

const CLEF_QUESTIONS = {
  safe: {
    type: "noul",
    instructions: "Is this diff safe to merge into trunk without a human review?",
    criteria: { true: "Safe to merge automatically", false: "Needs a human review" },
  },
  kind: {
    type: "choice",
    instructions: "What kind of change is this diff?",
    criteria: {
      bugfix: "Fixes incorrect behavior",
      feature: "Adds new behavior",
      refactor: "Restructures code without changing behavior",
      docs: "Changes documentation only",
    },
  },
  risk: {
    type: "score",
    instructions: "How risky is this diff for existing callers?",
    criteria: ["trivial", "low", "medium", "high", "critical"],
  },
};

const CLEF_STATE = {
  path: "index.js",
  description: "Agent change to is-plain-obj: treat objects with a null prototype as plain.",
  diff: [
    "--- a/index.js",
    "+++ b/index.js",
    "@@ -1,8 +1,9 @@",
    " export default function isPlainObject(value) {",
    " \tif (typeof value !== 'object' || value === null) {",
    " \t\treturn false;",
    " \t}",
    " ",
    " \tconst prototype = Object.getPrototypeOf(value);",
    "-\treturn (prototype === null || prototype === Object.prototype || Object.getPrototypeOf(prototype) === null) && !(Symbol.toStringTag in value) && !(Symbol.iterator in value);",
    "+\tif (prototype === null) return true;",
    "+\treturn (prototype === Object.prototype || Object.getPrototypeOf(prototype) === null) && !(Symbol.toStringTag in value) && !(Symbol.iterator in value);",
    " }",
  ].join("\n"),
};

async function route(path: string, b: any, env: Env): Promise<any> {
  const ops: Ops = { n: 0 };
  switch (path) {
    case "/ping":
      return { t: Date.now() };

    case "/do/ping": {
      const t0 = Date.now();
      const r = await doStub(env, b.obj).ping();
      return { ms: Date.now() - t0, r };
    }

    case "/import": {
      const ns = nsOf(env, b.ns);
      const t0 = Date.now();
      let res: any;
      let err: any;
      try {
        ops.n++;
        res = await ns.import({ source: { url: b.url, branch: b.branch, depth: b.depth }, target: { name: b.name } });
      } catch (e) {
        err = errInfo(e);
      }
      const callMs = Date.now() - t0;
      const ready = await waitReady(ns, b.name, ops, t0);
      return { name: b.name, tStart: t0, callMs, err, result: redact(res), ready, ops: ops.n };
    }

    case "/create": {
      const ns = nsOf(env, b.ns);
      const t0 = Date.now();
      let res: any;
      let err: any;
      try {
        ops.n++;
        res = await ns.create(b.name, { description: "ft-spike", setDefaultBranch: "main" });
      } catch (e) {
        err = errInfo(e);
      }
      const callMs = Date.now() - t0;
      const ready = err ? null : await waitReady(ns, b.name, ops, t0, false);
      return { name: b.name, callMs, err, result: redact(res), ready, ops: ops.n };
    }

    case "/fork": {
      const ns = nsOf(env, b.ns);
      const t0 = Date.now();
      let repo: any;
      try {
        ops.n++;
        repo = await ns.get(b.source);
      } catch (e) {
        return { name: b.name, source: b.source, tStart: t0, getErr: errInfo(e), ops: ops.n };
      }
      const tGot = Date.now();
      let res: any;
      let err: any;
      try {
        ops.n++;
        const opts: any = { description: `fork of ${b.source}` };
        if (b.defaultBranchOnly !== undefined) opts.defaultBranchOnly = b.defaultBranchOnly;
        if (b.readOnly !== undefined) opts.readOnly = b.readOnly;
        res = await repo.fork(b.name, opts);
      } catch (e) {
        err = errInfo(e);
      } finally {
        dispose(repo);
      }
      const tForked = Date.now();
      const ready = !err && b.wait !== false ? await waitReady(ns, b.name, ops, t0) : null;
      return {
        name: b.name, source: b.source, tStart: t0, tEnd: Date.now(), getMs: tGot - t0, forkCallMs: tForked - tGot,
        callMs: tForked - t0, err, ready, result: redact(res), ops: ops.n,
      };
    }

    case "/delete": {
      const ns = nsOf(env, b.ns);
      const out: any[] = [];
      for (const name of b.names as string[]) {
        const t0 = Date.now();
        try {
          ops.n++;
          const r = await ns.delete(name);
          out.push({ name, ok: r, ms: Date.now() - t0 });
        } catch (e) {
          out.push({ name, err: errInfo(e), ms: Date.now() - t0 });
        }
      }
      return { out, ops: ops.n };
    }

    case "/list": {
      const ns = nsOf(env, b.ns);
      const repos: any[] = [];
      let cursor: string | undefined;
      const t0 = Date.now();
      do {
        ops.n++;
        const page: any = await ns.list({ limit: 100, cursor });
        repos.push(...page.repos.map((r: any) => ({ name: r.name, status: r.status, lastPushAt: r.lastPushAt })));
        cursor = page.cursor;
      } while (cursor);
      return { ms: Date.now() - t0, count: repos.length, repos, ops: ops.n };
    }

    case "/token": {
      const a = await repoAccess(env, b.ns, b.repo, b.scope ?? "read", ops);
      return { remote: a.remote, token: a.token, ops: ops.n };
    }

    case "/info": {
      const ns = nsOf(env, b.ns);
      const repo = await ns.get(b.repo);
      try {
        const info = await repo.info();
        const log = await repo.log(b.ref ? { ref: b.ref, limit: Number(b.limit ?? 5) } : { limit: Number(b.limit ?? 5) });
        return { info, log };
      } finally {
        dispose(repo);
      }
    }

    case "/refprobe": {
      // Which ref spellings do readFile/log/readCommit resolve? b.probes = [{ref, path}]
      const ns = nsOf(env, b.ns);
      const repo = await ns.get(b.repo);
      try {
        const out: any[] = [];
        for (const p of b.probes as { ref: string; path: string }[]) {
          const row: any = { ref: p.ref, path: p.path };
          try {
            const f = await repo.readFile({ ref: p.ref, path: p.path });
            row.readFile = f ? { size: f.size, type: f.type, text: (await f.text()).slice(0, 160) } : null;
          } catch (e) {
            row.readFileErr = errInfo(e);
          }
          try {
            const l = await repo.log({ ref: p.ref, limit: 1 });
            row.log = l.map((c) => c.hash);
          } catch (e) {
            row.logErr = errInfo(e);
          }
          out.push(row);
        }
        return { out };
      } finally {
        dispose(repo);
      }
    }

    case "/reads": {
      const ns = nsOf(env, b.ns);
      const n = Number(b.n ?? 10);
      const getT = await timeN(n, ops, async () => {
        const r = await ns.get(b.repo);
        dispose(r);
        return true;
      });
      const repo = await ns.get(b.repo);
      ops.n++;
      try {
        const info = await timeN(n, ops, () => repo.info());
        const log = await timeN(n, ops, () => repo.log({ ref: b.ref ?? "main", limit: 10 }));
        const head = (log.last as any)[0].hash;
        const commit = await timeN(n, ops, () => repo.readCommit(head));
        const treeHash = (commit.last as any).treeHash;
        const tree = await timeN(n, ops, () => repo.readTree(treeHash));
        const blobEntry = (tree.last as any).find((e: any) => e.type === "blob");
        const blob = await timeN(n, ops, async () => {
          const bl = await repo.readBlob(blobEntry.hash);
          return bl ? { size: bl.size, type: bl.type, head: (await bl.text()).slice(0, 80) } : null;
        });
        const file = await timeN(n, ops, async () => {
          const f = await repo.readFile({ ref: b.ref ?? "main", path: blobEntry.name });
          return f ? { size: f.size, type: f.type, head: (await f.text()).slice(0, 80) } : null;
        });
        const token = await timeN(n, ops, async () => {
          const t = await repo.createToken("read", 600);
          return { ...t, plaintext: "<redacted>" };
        });
        const list = await timeN(Math.min(n, 5), ops, () => ns.list({ limit: 20 }));
        return {
          get: { stats: getT.stats, raw: getT.raw },
          info: { stats: info.stats, raw: info.raw, example: info.last, errors: info.errors },
          log: { stats: log.stats, raw: log.raw, example: (log.last as any)?.slice(0, 2), errors: log.errors },
          readCommit: { stats: commit.stats, raw: commit.raw, example: commit.last, errors: commit.errors },
          readTree: { stats: tree.stats, raw: tree.raw, example: tree.last, errors: tree.errors },
          readBlob: { stats: blob.stats, raw: blob.raw, example: blob.last, errors: blob.errors },
          readFile: { stats: file.stats, raw: file.raw, example: file.last, errors: file.errors },
          createToken: { stats: token.stats, raw: token.raw, example: token.last, errors: token.errors },
          list: {
            stats: list.stats, raw: list.raw,
            example: { ...(list.last as any), repos: (list.last as any)?.repos?.slice(0, 2) },
          },
          ops: ops.n,
        };
      } finally {
        dispose(repo);
      }
    }

    case "/clef": {
      const model = b.model === "clef-flash" ? "clef-flash" : "clef";
      const n = Number(b.n ?? 10);
      const ms: number[] = [];
      const errors: any[] = [];
      let example: any;
      const answers: any[] = [];
      for (let i = 0; i < n; i++) {
        const t0 = Date.now();
        try {
          const r: any = await (env.AI as any).run(`@cf/cloudflare/${model}`, {
            model, state: CLEF_STATE, questions: CLEF_QUESTIONS,
          });
          ms.push(Date.now() - t0);
          example ??= r;
          answers.push(r?.answers ?? r);
        } catch (e) {
          ms.push(Date.now() - t0);
          errors.push(errInfo(e));
        }
      }
      return { model, stats: stats(ms), raw: ms, errors, example, answers };
    }

    // ---- git in the Durable Object
    case "/git/clone": {
      const a = await repoAccess(env, b.ns, b.repo, "write", ops);
      const t0 = Date.now();
      const r = await doStub(env, b.obj).flowClone({ remote: a.remote, token: a.token, dir: b.dir });
      return { ...r, rpcMs: Date.now() - t0, ops: ops.n };
    }
    case "/git/write-commit": {
      const t0 = Date.now();
      const r = await doStub(env, b.obj).flowWriteCommit(b);
      return { ...r, rpcMs: Date.now() - t0 };
    }
    case "/git/push": {
      const a = await repoAccess(env, b.ns, b.repo, "write", ops);
      const t0 = Date.now();
      const r = await doStub(env, b.obj).flowPush({ ...b, remote: a.remote, token: a.token });
      return { ...r, rpcMs: Date.now() - t0, ops: ops.n };
    }
    case "/git/init-fetch": {
      const a = await repoAccess(env, b.ns, b.repo, "write", ops);
      const t0 = Date.now();
      const r = await doStub(env, b.obj).initFetch({ ...b, remote: a.remote, token: a.token });
      return { ...r, rpcMs: Date.now() - t0, ops: ops.n };
    }
    case "/git/surgery-build": {
      const t0 = Date.now();
      const r = await doStub(env, b.obj).surgeryBuild(b);
      return { ...r, rpcMs: Date.now() - t0 };
    }
    case "/git/note-add": {
      const t0 = Date.now();
      const r = await doStub(env, b.obj).noteAdd(b);
      return { ...r, rpcMs: Date.now() - t0 };
    }
    case "/git/iso-push": {
      const a = await repoAccess(env, b.ns, b.repo, "write", ops);
      const t0 = Date.now();
      const r = await doStub(env, b.obj).isoPush({ ...b, remote: a.remote, token: a.token });
      return { ...r, rpcMs: Date.now() - t0, ops: ops.n };
    }
    case "/git/advert": {
      const a = await repoAccess(env, b.ns, b.repo, "write", ops);
      const r = await doStub(env, b.obj).captureAdvert({ remote: a.remote, token: a.token });
      return { ...r, ops: ops.n };
    }
    case "/git/resolve": {
      return { oid: await doStub(env, b.obj).resolve(b) };
    }

    // ---- namespace push trigger (ft-spike-b)
    case "/trigger/push": {
      const a = await repoAccess(env, "b", b.repo, "write", ops);
      const r = await doStub(env, b.obj ?? "trigger").triggerPush({ dir: b.dir, remote: a.remote, token: a.token, tag: b.tag });
      return { repo: b.repo, ...r, ops: ops.n };
    }
    case "/events":
      return { events: await doStub(env, "events").listPushes() };
    case "/events/clear":
      return { ok: await doStub(env, "events").clearPushes() };
    case "/wf/status": {
      const inst = await env.PUSH_WF.get(b.id);
      return { status: await inst.status() };
    }
  }
  return { error: "no such route", path };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const key = req.headers.get("x-spike-key");
    if (!env.SPIKE_KEY || key !== env.SPIKE_KEY) return new Response("forbidden", { status: 403 });
    const body: any = req.method === "POST" ? await req.json().catch(() => ({})) : Object.fromEntries(url.searchParams);
    const t0 = Date.now();
    try {
      const out = await route(url.pathname, body, env);
      return Response.json({ ...out, serverMs: Date.now() - t0 });
    } catch (e) {
      return Response.json({ error: errInfo(e), serverMs: Date.now() - t0 }, { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
