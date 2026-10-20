// The runner inside the container: a small HTTP server on 8080 that starts the contention-scale scenario as a child
// process, keeps its stdout/stderr in /data/logs/<tag>.log, and serves the log and the results back. One run at a
// time. Secrets (FT_TOKEN, CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET) reach the scenario through the container's
// environment and are never written here; FT_BASE names the deployment.
import { spawn } from "node:child_process";
import { closeSync, createWriteStream, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const APP = "/app";
const SCENARIO = join(APP, "packages/bench/src/scenarios/contention-scale.ts");
const RESULTS = "/data/results";
const LOGS = "/data/logs";
mkdirSync(RESULTS, { recursive: true });
mkdirSync(LOGS, { recursive: true });
const TAG = /^[a-z0-9][a-z0-9-]{0,39}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const BOOTED = new Date().toISOString();
const SOURCE = existsSync(join(APP, "SOURCE")) ? readFileSync(join(APP, "SOURCE"), "utf8").trim() : "unknown";

/** @type {{tag:string,pid:number,args:string[],startedAt:string,endedAt:string|null,exitCode:number|null,signal:string|null,child:import("node:child_process").ChildProcess|null}|null} */
let current = null;
const history = [];

const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(`${JSON.stringify(body)}\n`);
};
const publicRun = (r) => (r ? { tag: r.tag, pid: r.pid, args: r.args, conn: r.conn ?? 0, threads: r.threads ?? 0, startedAt: r.startedAt, endedAt: r.endedAt, exitCode: r.exitCode, signal: r.signal, logBytes: logSize(r.tag) } : null);
const logPath = (tag) => join(LOGS, `${tag}.log`);
const logSize = (tag) => (existsSync(logPath(tag)) ? statSync(logPath(tag)).size : 0);

/** Bytes of a file from `from` (at most 4 MiB a call). */
function readFrom(path, from) {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.min(Math.max(0, from), size);
    const len = Math.min(size - start, 4 * 1024 * 1024);
    const buf = Buffer.alloc(len);
    if (len > 0) readSync(fd, buf, 0, len, start);
    return { buf, size };
  } finally {
    closeSync(fd);
  }
}

/** Start a run. conn > 0 preloads dispatcher.mjs (a pool of that many keep-alive connections); threads sets UV_THREADPOOL_SIZE. */
function start(tag, agents, intents, extra, conn, threads) {
  if (current && current.exitCode === null && current.signal === null) return { error: `a run is in progress: ${current.tag}` };
  const outDir = join(RESULTS, tag);
  const nodeArgs = conn > 0 ? ["--import", join(APP, "dispatcher.mjs")] : [];
  const env = { ...process.env };
  if (conn > 0) env.FT_BENCH_CONNECTIONS = String(conn);
  if (threads > 0) env.UV_THREADPOOL_SIZE = String(threads);
  const args = [...nodeArgs, SCENARIO, "--base", process.env.FT_BASE ?? "https://staging.firetrident.com", "--scenario", "contention-scale", "--agents", String(agents), "--intents", String(intents), "--out", outDir, ...extra];
  const log = createWriteStream(logPath(tag), { flags: "a" });
  log.write(`[runner] ${new Date().toISOString()} ${conn > 0 ? `FT_BENCH_CONNECTIONS=${conn} ` : ""}${threads > 0 ? `UV_THREADPOOL_SIZE=${threads} ` : ""}node ${args.join(" ")}\n`);
  const child = spawn("node", args, { cwd: APP, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  const run = { tag, pid: child.pid ?? 0, args, conn, threads, startedAt: new Date().toISOString(), endedAt: null, exitCode: null, signal: null, child };
  child.on("exit", (code, signal) => {
    run.exitCode = code;
    run.signal = signal;
    run.endedAt = new Date().toISOString();
    log.write(`[runner] ${run.endedAt} exit code ${code} signal ${signal}\n`);
    log.end();
    history.push(publicRun(run));
  });
  child.on("error", (e) => {
    log.write(`[runner] spawn error: ${e.message}\n`);
  });
  current = run;
  return publicRun(run);
}

function listDir(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = join(dir, d.name);
    return d.isDirectory() ? listDir(p) : [{ path: p.slice(RESULTS.length + 1), bytes: statSync(p).size }];
  });
}

const cfEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("CLOUDFLARE_")));

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://container");
  const q = url.searchParams;
  try {
    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, { ok: true, node: process.version, booted: BOOTED, source: SOURCE, running: !!current && current.exitCode === null && current.signal === null, env: cfEnv(), hasToken: !!process.env.FT_TOKEN, hasAccess: !!process.env.CF_ACCESS_CLIENT_ID && !!process.env.CF_ACCESS_CLIENT_SECRET });
    }
    if (req.method === "GET" && url.pathname === "/trace") {
      const r = await fetch("https://www.cloudflare.com/cdn-cgi/trace", { signal: AbortSignal.timeout(15_000) });
      res.writeHead(r.status, { "content-type": "text/plain" });
      return res.end(await r.text());
    }
    if (req.method === "GET" && url.pathname === "/about") {
      const headers = {};
      if (process.env.CF_ACCESS_CLIENT_ID) {
        headers["CF-Access-Client-Id"] = process.env.CF_ACCESS_CLIENT_ID;
        headers["CF-Access-Client-Secret"] = process.env.CF_ACCESS_CLIENT_SECRET ?? "";
      }
      const r = await fetch(`${process.env.FT_BASE ?? "https://staging.firetrident.com"}/api/about`, { headers, signal: AbortSignal.timeout(20_000) });
      res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "text/plain" });
      return res.end(await r.text());
    }
    if (req.method === "POST" && url.pathname === "/start") {
      const tag = q.get("tag") ?? "";
      const agents = Number(q.get("agents"));
      const intents = Number(q.get("intents"));
      if (!TAG.test(tag)) return json(res, 400, { error: "tag must be a lowercase slug" });
      if (!Number.isInteger(agents) || agents < 1 || !Number.isInteger(intents) || intents < 1) return json(res, 400, { error: "agents and intents must be whole numbers" });
      const extra = (q.get("extra") ?? "").split(" ").filter(Boolean);
      const conn = Number(q.get("conn") ?? 0);
      const threads = Number(q.get("threads") ?? 0);
      if (!Number.isInteger(conn) || conn < 0 || conn > 10_000 || !Number.isInteger(threads) || threads < 0 || threads > 128) return json(res, 400, { error: "conn must be 0 to 10000 and threads 0 to 128" });
      const r = start(tag, agents, intents, extra, conn, threads);
      return json(res, r.error ? 409 : 202, r);
    }
    if (req.method === "POST" && url.pathname === "/stop") {
      if (!current || current.exitCode !== null || current.signal !== null) return json(res, 409, { error: "no run in progress" });
      current.child?.kill(q.get("signal") === "KILL" ? "SIGKILL" : "SIGTERM");
      return json(res, 202, publicRun(current));
    }
    if (req.method === "GET" && url.pathname === "/status") {
      return json(res, 200, { now: new Date().toISOString(), current: publicRun(current), history });
    }
    if (req.method === "GET" && url.pathname === "/log") {
      const tag = q.get("tag") ?? "";
      if (!TAG.test(tag) || !existsSync(logPath(tag))) return json(res, 404, { error: "no such log" });
      const { buf, size } = readFrom(logPath(tag), Number(q.get("from") ?? 0));
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "x-log-size": String(size) });
      return res.end(buf);
    }
    if (req.method === "GET" && url.pathname === "/ls") {
      const tag = q.get("tag") ?? "";
      if (!TAG.test(tag)) return json(res, 400, { error: "tag must be a lowercase slug" });
      return json(res, 200, { files: listDir(join(RESULTS, tag)) });
    }
    if (req.method === "GET" && url.pathname === "/file") {
      const tag = q.get("tag") ?? "";
      const name = q.get("name") ?? "";
      if (!TAG.test(tag) || !NAME.test(name)) return json(res, 400, { error: "bad tag or name" });
      const p = join(RESULTS, tag, name);
      if (!existsSync(p)) return json(res, 404, { error: "no such file" });
      const { buf, size } = readFrom(p, Number(q.get("from") ?? 0));
      res.writeHead(200, { "content-type": "application/octet-stream", "x-file-size": String(size) });
      return res.end(buf);
    }
    return json(res, 404, { error: "no such route" });
  } catch (e) {
    return json(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
});
server.listen(8080, () => console.log(`bench runner listening on 8080 (source ${SOURCE}, ${process.version})`));
