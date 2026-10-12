#!/usr/bin/env node
/**
 * Synthetic swarm driver: load-tests the FireTrident coordination layer over the
 * REST API only. Each simulated agent registers (kind "synthetic"), takes work,
 * proposes a change with FAKE blob ids built from its lease (no git, no model),
 * heartbeats, and repeats. Reports latency percentiles per call, takes/s,
 * proposals/s, and landings/min from the colony snapshot.
 *
 *   node packages/bench/src/swarm.ts --url <base> --colony <id> --agents <n> --duration <s>
 */
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { ColonySnapshot, FileVersion, Intent, WorkspaceLease } from "@fire_trident/core";
import { Recorder, perSecond, table } from "./stats.ts";

export const SYNTHETIC_NOTE = "SYNTHETIC AGENTS: REST calls only. No git, no model; proposals carry fake blob ids.";

/** Benchmark options. */
export interface Options {
  url: string;
  colony: string;
  agents: number;
  durationS: number;
  token?: string;
  /** Spread agent starts over this many seconds. */
  rampS: number;
  heartbeatMs: number;
  /** Simulated work between take and propose. */
  workMs: number;
  /** Add fake read-set entries (exercises stale returns). */
  readSet: boolean;
  timeoutMs: number;
  json: boolean;
}

const HELP = `usage: node packages/bench/src/swarm.ts --url <base> --colony <id> [options]

  --url <base>        server base URL (or FT_URL)
  --colony <id>       colony id
  --agents <n>        simulated agents (default 10)
  --duration <s>      run time in seconds (default 30)
  --token <t>         bearer token for mutating routes (or FT_TOKEN / FT_ADMIN_TOKEN)
  --ramp <s>          spread agent starts over s seconds (default: min(5, agents / 20))
  --heartbeat <ms>    heartbeat interval while holding work (default 15000)
  --work <ms>         simulated work between take and propose (default 0)
  --read-set          include fake read-set entries (they never match trunk, so proposals come back stale)
  --timeout <ms>      per-request timeout (default 30000)
  --json              print the report as JSON

${SYNTHETIC_NOTE}`;

function num(v: string | undefined, name: string, fallback: number, min: number, max: number): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`--${name} must be a number from ${min} to ${max}`);
  return n;
}

/** Parse command-line arguments (throws with a usage message on bad input). */
export function parseOptions(argv: string[], env: Record<string, string | undefined>): Options {
  const { values } = parseArgs({
    args: argv,
    options: {
      url: { type: "string" },
      colony: { type: "string" },
      agents: { type: "string" },
      duration: { type: "string" },
      token: { type: "string" },
      ramp: { type: "string" },
      heartbeat: { type: "string" },
      work: { type: "string" },
      "read-set": { type: "boolean" },
      timeout: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });
  if (values.help) throw new Error(HELP);
  const url = (values.url ?? env.FT_URL ?? "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(url)) throw new Error(`--url is required (http or https)\n\n${HELP}`);
  const colony = (values.colony ?? "").trim();
  if (!colony) throw new Error(`--colony is required\n\n${HELP}`);
  const agents = Math.floor(num(values.agents, "agents", 10, 1, 10_000));
  const opts: Options = {
    url,
    colony,
    agents,
    durationS: num(values.duration, "duration", 30, 1, 86_400),
    rampS: num(values.ramp, "ramp", Math.min(5, agents / 20), 0, 600),
    heartbeatMs: num(values.heartbeat, "heartbeat", 15_000, 100, 600_000),
    workMs: num(values.work, "work", 0, 0, 600_000),
    readSet: values["read-set"] ?? false,
    timeoutMs: num(values.timeout, "timeout", 30_000, 100, 600_000),
    json: values.json ?? false,
  };
  const token = values.token ?? env.FT_TOKEN ?? env.FT_ADMIN_TOKEN;
  if (token) opts.token = token;
  return opts;
}

/** Deterministic fake 40-hex object id. */
export function fakeSha(...parts: string[]): string {
  return createHash("sha1").update(parts.join("\0")).digest("hex");
}

/** Concrete paths for a fake write set: literal footprint entries, else a file under the first entry's static prefix. */
export function writePaths(footprint: string[], agentId: string): string[] {
  const literal = footprint.filter((p) => p !== "" && !p.endsWith("/") && !/[*?{]/.test(p));
  if (literal.length > 0) return literal.slice(0, 5);
  const first = footprint[0] ?? "";
  const segs = first.split("/");
  const dir: string[] = [];
  for (const [i, seg] of segs.entries()) {
    if (/[*?{]/.test(seg) || (i === segs.length - 1 && !first.endsWith("/"))) break;
    if (seg !== "") dir.push(seg);
  }
  return [`${dir.length > 0 ? `${dir.join("/")}/` : ""}bench-${agentId.slice(-8)}.txt`];
}

type Assignment = { intent: Intent; lease: WorkspaceLease };

/** The POST /proposals body a synthetic agent sends for an assignment. */
export function proposalBody(agentId: string, a: Assignment, withReads: boolean, seq: number): Record<string, unknown> {
  const paths = writePaths(a.intent.footprint ?? [], agentId);
  const writeSet: FileVersion[] = paths.map((path) => ({ path, blob: fakeSha("blob", agentId, a.intent.id, path, String(seq)) }));
  const readSet: FileVersion[] = withReads ? paths.map((path) => ({ path, blob: fakeSha("read", a.lease.baseSha, path) })) : [];
  return {
    intentId: a.intent.id,
    agentId,
    workspace: a.lease.repo,
    baseSha: a.lease.baseSha,
    headSha: fakeSha("head", agentId, a.intent.id, String(seq)),
    writeSet,
    readSet,
    declared: { footprint: a.intent.footprint, summary: `synthetic bench change by ${agentId}` },
    evidence: { checks: [], notVerified: SYNTHETIC_NOTE },
  };
}

/** A timed JSON client that records every call. */
export class Api {
  private readonly opts: Options;
  private readonly rec: Recorder;
  private readonly doFetch: typeof fetch;

  constructor(opts: Options, rec: Recorder, doFetch: typeof fetch = fetch) {
    this.opts = opts;
    this.rec = rec;
    this.doFetch = doFetch;
  }

  /** Call the API; returns the parsed body, or null after recording an error. */
  async call<T>(op: string, method: "GET" | "POST", path: string, body?: unknown): Promise<T | null> {
    const headers: Record<string, string> = { accept: "application/json", "user-agent": "ft-bench/0.0.1" };
    if (this.opts.token) headers.authorization = `Bearer ${this.opts.token}`;
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(this.opts.timeoutMs) };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const t0 = performance.now();
    try {
      const res = await this.doFetch(`${this.opts.url}/api/colonies/${encodeURIComponent(this.opts.colony)}${path}`, init);
      const text = await res.text();
      const ms = performance.now() - t0;
      if (!res.ok) {
        let detail = text.slice(0, 160);
        try {
          const j = JSON.parse(text) as { error?: unknown };
          if (typeof j.error === "string") detail = j.error;
        } catch {
          // not JSON
        }
        this.rec.error(op, ms, `${res.status} ${detail}`);
        return null;
      }
      this.rec.record(op, ms);
      return (text ? JSON.parse(text) : null) as T;
    } catch (e) {
      this.rec.error(op, performance.now() - t0, e instanceof Error ? `${e.name}: ${e.message}` : String(e));
      return null;
    }
  }
}

/** Counters the agents share. */
interface Counts {
  registered: number;
  assigned: number;
  waits: number;
  proposals: number;
  heartbeats: number;
}

/** Everything the run measured. */
export interface Report {
  note: string;
  url: string;
  colony: string;
  agents: number;
  durationS: number;
  elapsedS: number;
  ops: Array<{ op: string; calls: number; errors: number; p50: number | null; p90: number | null; p99: number | null; max: number | null }>;
  counts: Counts;
  rates: { takesPerS: number; waitsPerS: number; proposalsPerS: number; landingsPerMin: number | null; landedProposalsPerMin: number | null };
  landings: { before: number | null; after: number | null; source: string };
  errors: string[];
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.max(0, ms)));

function metric(snap: ColonySnapshot | null, name: string): number | null {
  const v = snap?.metrics?.[name];
  return typeof v === "number" ? v : null;
}

/** Run the swarm for the configured duration and measure it. */
export async function runBench(opts: Options, doFetch: typeof fetch = fetch, log: (line: string) => void = () => undefined): Promise<Report> {
  const rec = new Recorder();
  const api = new Api(opts, rec, doFetch);
  const counts: Counts = { registered: 0, assigned: 0, waits: 0, proposals: 0, heartbeats: 0 };
  const run = Date.now().toString(36);

  const before = await api.call<ColonySnapshot>("snapshot", "GET", "");
  if (!before) throw new Error(`cannot read colony ${opts.colony}: ${rec.errorSamples[0] ?? "unknown error"}`);
  const startedAt = performance.now();
  const deadline = startedAt + opts.durationS * 1000;
  const startedWall = Date.now();
  log(`${SYNTHETIC_NOTE}\nrunning ${opts.agents} agents for ${opts.durationS}s against ${opts.url} (colony ${opts.colony})`);

  const agent = async (i: number): Promise<void> => {
    await sleep(opts.agents > 1 ? (i * opts.rampS * 1000) / opts.agents : 0);
    if (performance.now() >= deadline) return;
    const reg = await api.call<{ id: string }>("register", "POST", "/agents", { name: `bench-synthetic-${run}-${i + 1}`, kind: "synthetic" });
    if (!reg?.id) return;
    counts.registered++;
    let lastBeat = performance.now();
    let seq = 0;
    let failures = 0;
    while (performance.now() < deadline) {
      if (performance.now() - lastBeat >= opts.heartbeatMs) {
        lastBeat = performance.now();
        if (await api.call("heartbeat", "POST", `/agents/${reg.id}/heartbeat`, {})) counts.heartbeats++;
      }
      const t = await api.call<Assignment | { wait: true; retryInMs: number; reason: string }>("take", "POST", `/agents/${reg.id}/take`, {});
      if (!t) {
        await sleep(Math.min(5_000, 250 * 2 ** Math.min(4, failures++)));
        continue;
      }
      failures = 0;
      if ("wait" in t) {
        counts.waits++;
        await sleep(Math.min(Math.max(50, t.retryInMs), deadline - performance.now()));
        continue;
      }
      counts.assigned++;
      if (opts.workMs > 0) await sleep(Math.min(opts.workMs, deadline - performance.now()));
      const p = await api.call<{ id: string }>("propose", "POST", "/proposals", proposalBody(reg.id, t, opts.readSet, ++seq));
      if (p) counts.proposals++;
      else await sleep(500);
    }
  };

  await Promise.all(Array.from({ length: opts.agents }, (_, i) => agent(i)));
  const elapsedS = (performance.now() - startedAt) / 1000;
  const after = await api.call<ColonySnapshot>("snapshot", "GET", "");

  const lBefore = metric(before, "landings");
  const lAfter = metric(after, "landings");
  let landingsPerMin: number | null = null;
  let source = "snapshot metrics.landings";
  if (lBefore !== null && lAfter !== null) landingsPerMin = ((lAfter - lBefore) / elapsedS) * 60;
  else if (after) {
    const inWindow = (after.recentLandings ?? []).filter((l) => l.at >= startedWall).length;
    landingsPerMin = (inWindow / elapsedS) * 60;
    source = "snapshot recentLandings in the run window (may be capped)";
  }
  const pBefore = metric(before, "landedProposals");
  const pAfter = metric(after, "landedProposals");
  const landedProposalsPerMin = pBefore !== null && pAfter !== null ? ((pAfter - pBefore) / elapsedS) * 60 : null;

  return {
    note: SYNTHETIC_NOTE,
    url: opts.url,
    colony: opts.colony,
    agents: opts.agents,
    durationS: opts.durationS,
    elapsedS,
    ops: rec.ops().map((op) => {
      const s = rec.summary(op);
      return { op, calls: s.n, errors: rec.errors(op), p50: s.p50, p90: s.p90, p99: s.p99, max: s.max };
    }),
    counts,
    rates: {
      takesPerS: perSecond(counts.assigned, elapsedS),
      waitsPerS: perSecond(counts.waits, elapsedS),
      proposalsPerS: perSecond(counts.proposals, elapsedS),
      landingsPerMin,
      landedProposalsPerMin,
    },
    landings: { before: lBefore, after: lAfter, source },
    errors: rec.errorSamples,
  };
}

const round1 = (n: number | null): number | null => (n === null ? null : Math.round(n * 10) / 10);

/** Human-readable report. */
export function formatReport(r: Report): string {
  const ops = table([
    ["call", "count", "errors", "p50 ms", "p90 ms", "p99 ms", "max ms"],
    ...r.ops.map((o) => [o.op, o.calls, o.errors, round1(o.p50), round1(o.p90), round1(o.p99), round1(o.max)]),
  ]);
  const rates = table([
    ["rate", "value"],
    ["takes/s (assigned)", round1(r.rates.takesPerS)],
    ["waits/s", round1(r.rates.waitsPerS)],
    ["proposals/s", round1(r.rates.proposalsPerS)],
    ["landings/min", round1(r.rates.landingsPerMin)],
    ["landed proposals/min", round1(r.rates.landedProposalsPerMin)],
  ]);
  const lines = [
    `FireTrident coordination benchmark`,
    r.note,
    `target ${r.url}  colony ${r.colony}  agents ${r.agents}  ran ${round1(r.elapsedS)}s`,
    "",
    ops,
    "",
    rates,
    "",
    `registered ${r.counts.registered}, assigned ${r.counts.assigned}, waits ${r.counts.waits}, proposals ${r.counts.proposals}, heartbeats ${r.counts.heartbeats}`,
    `landings from ${r.landings.source}${r.landings.before !== null ? ` (${r.landings.before} -> ${r.landings.after})` : ""}`,
  ];
  if (r.errors.length > 0) lines.push("", "first errors:", ...r.errors.map((e) => `  ${e}`));
  lines.push("", `Reminder: ${r.note}`);
  return lines.join("\n");
}

async function main(): Promise<void> {
  let opts: Options;
  try {
    opts = parseOptions(process.argv.slice(2), process.env);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const help = process.argv.includes("--help") || process.argv.includes("-h");
    (help ? console.log : console.error)(message);
    process.exit(help ? 0 : 2);
  }
  const report = await runBench(opts, fetch, (line) => {
    if (!opts.json) console.log(line);
  });
  console.log(opts.json ? JSON.stringify(report, null, 2) : formatReport(report));
}

function isEntry(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntry()) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
