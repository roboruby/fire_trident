#!/usr/bin/env node
/**
 * Live load run against the deployed service with synthetic API agents and REAL landings.
 *
 * Each agent registers (kind "synthetic"), takes work, optionally "works" for --work ms,
 * proposes, then polls its proposal like an in-platform agent does (1.5 s, x1.6, cap 15 s)
 * until it lands or comes back. Proposals write a NEW file per intent whose blob id is an
 * object that already exists in every workspace fork (a trunk blob found once at setup), so
 * the trunk writer really reads the blob from the agent's workspace repo, builds the commit by
 * tree surgery and pushes trunk with compare-and-swap: every landing counted here is a real
 * Artifacts commit. What is synthetic: no agent-side git (no clone, edit or push) and no model.
 *
 *   node packages/bench/src/live.ts --colony bench-w2-load --agents 50 --duration 60 --out run.json
 *
 * With --inline every proposal is an inline change instead: it carries the text of the new file it writes, so
 * nothing is read from a workspace (the trunk writer fetches the texts from the colony once per cycle) and setup
 * needs no git. The colony must take inline changes (FT_INLINE on for it):
 *
 *   node packages/bench/src/live.ts --colony bench-inline --agents 50 --duration 60 --inline --out run.json
 */
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { blobId, changesetId } from "@fire_trident/core";
import type { ColonyEvent, ColonySnapshot, FileVersion, Intent, Proposal, TrunkPublish, WorkspaceLease } from "@fire_trident/core";
import { liveConfig, redact, type LiveConfig } from "./env.ts";
import { Recorder, summarize, type Summary } from "./stats.ts";
import { fakeSha } from "./swarm.ts";

const run = promisify(execFile);

export const LIVE_NOTE =
  "MEASURED, real landings: synthetic API agents (no model, no agent-side git); every landed proposal is a real trunk commit built by the trunk writer from a blob read out of the agent's workspace fork.";
/** The note of an --inline run. */
export const LIVE_INLINE_NOTE =
  "MEASURED, real landings: synthetic API agents (no model, no git at all); every proposal is an inline change carrying its new file's text, and every landed one is a real trunk commit built by the trunk writer with no workspace read.";

/** Options for one live run. */
export interface LiveOptions {
  colony: string;
  agents: number;
  durationS: number;
  rampS: number;
  workMs: number;
  /** Bench regions (directories bench/rNN) the run's intents are spread over. */
  regions: number;
  /** Open bench intents to have before starting (topped up). */
  intents: number;
  /** After the deadline, keep polling in-flight proposals this long. */
  drainS: number;
  timeoutMs: number;
  out?: string;
  label: string;
  /** After the run, stop (retire) its agents so their claims never hold admission (default true). */
  stopAgents?: boolean;
  /** Inline changes: each proposal carries its new file's text, so the trunk writer reads no workspace (FT_INLINE on for the colony). */
  inline?: boolean;
  /** Refuse to run unless the colony's trunk publishing is this (FT_ASYNC_PUBLISH lists the colony: "async"; otherwise "sync"). */
  expectPublish?: PublishMode;
}

/** How a colony's trunk writer publishes: asynchronously (FT_ASYNC_PUBLISH on for it) or in every landing cycle. */
export type PublishMode = "async" | "sync";

/** Trunk publishing in one run: the mode, the publish queue as the run ended, and how long it took to drain after it. */
export interface PublishReport {
  mode: PublishMode;
  atEnd: TrunkPublish | null;
  drained: TrunkPublish | null;
  /** From the end of the run until nothing waited to be published (null: it did not drain within the wait, or sync). */
  drainMs: number | null;
}

/** The colony's trunk publishing as its status shows it (`colony.publish`, present only when publishing is asynchronous). */
export function publishOf(snapshot: unknown): TrunkPublish | null {
  const p = (snapshot as { colony?: { publish?: unknown } } | null)?.colony?.publish;
  return p && typeof p === "object" && typeof (p as TrunkPublish).publishedSha === "string" ? (p as TrunkPublish) : null;
}

/**
 * How the colony's trunk is published: asynchronous only when its trunk writer reports it (`publish.on`). The colony
 * object and its trunk writer pick up a change to FT_ASYNC_PUBLISH as each restarts on the new deployment, so the
 * status can carry `publish` while the trunk writer still pushes every cycle.
 */
export function publishModeOf(snapshot: unknown): PublishMode {
  return publishOf(snapshot)?.on === true ? "async" : "sync";
}

type Assignment = { intent: Intent; lease: WorkspaceLease };
type TakeResult = Assignment | { wait: true; retryInMs: number; reason: string };
const TERMINAL = new Set(["landed", "returned", "rejected"]);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/** Backoff after the n-th failed call in a row, as in-platform agents do (agents/loop.ts backoffMs): 1 s, 2 s, 4 s, ... +-25%, at most 60 s. */
export function errorBackoffMs(n: number, rand: () => number = Math.random): number {
  const base = Math.min(60_000, 1000 * 2 ** Math.max(0, n - 1));
  return Math.round(base * (0.75 + rand() * 0.5));
}

/**
 * "Name: message (cause)" for a failed call. fetch reports every network failure as "fetch failed"
 * and keeps the reason (reset, refused, connect timeout, no free local port) in `cause`.
 */
export function errorDetail(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const cause = (e as { cause?: unknown }).cause;
  const code = cause instanceof Error ? (cause as { code?: unknown }).code : undefined;
  const why = typeof code === "string" ? code : cause instanceof Error ? cause.message : typeof cause === "string" ? cause : undefined;
  return why ? `${e.name}: ${e.message} (${why})` : `${e.name}: ${e.message}`;
}

/** Minimal timed JSON client for one colony. */
export class Client {
  readonly cfg: LiveConfig;
  readonly colony: string;
  readonly rec: Recorder;
  readonly timeoutMs: number;
  calls = 0;
  failures = 0;
  /** Calls, failures and the slowest call per second of wall time (by when each call finished). */
  readonly timeline = new Map<number, { calls: number; errors: number; maxMs: number }>();

  constructor(cfg: LiveConfig, colony: string, rec: Recorder, timeoutMs = 30_000) {
    this.cfg = cfg;
    this.colony = colony;
    this.rec = rec;
    this.timeoutMs = timeoutMs;
  }

  /** Call /api/colonies/:colony{path}; returns the body or null (error recorded). */
  async call<T>(op: string, method: "GET" | "POST", path: string, body?: unknown): Promise<T | null> {
    const headers: Record<string, string> = { accept: "application/json", "user-agent": "ft-bench-live/0.0.1" };
    if (this.cfg.token) headers.authorization = `Bearer ${this.cfg.token}`;
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(this.timeoutMs) };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const prefix = path.startsWith("/colonies") ? "" : `/colonies/${encodeURIComponent(this.colony)}`;
    const t0 = performance.now();
    this.calls++;
    try {
      const res = await fetch(`${this.cfg.url}/api${prefix}${path}`, init);
      const text = await res.text();
      const ms = performance.now() - t0;
      if (!res.ok) {
        let detail = text.slice(0, 200);
        try {
          const j = JSON.parse(text) as { error?: unknown };
          if (typeof j.error === "string") detail = j.error;
        } catch {
          // not JSON
        }
        this.failures++;
        this.rec.error(op, ms, redact(`${res.status} ${detail}`));
        this.mark(ms, true);
        return null;
      }
      this.rec.record(op, ms);
      this.mark(ms, false);
      return (text ? JSON.parse(text) : null) as T;
    } catch (e) {
      this.failures++;
      this.rec.error(op, performance.now() - t0, redact(errorDetail(e)));
      this.mark(performance.now() - t0, true);
      return null;
    }
  }

  private mark(ms: number, failed: boolean): void {
    const sec = Math.floor(Date.now() / 1000);
    const b = this.timeline.get(sec) ?? { calls: 0, errors: 0, maxMs: 0 };
    b.calls++;
    if (failed) b.errors++;
    b.maxMs = Math.max(b.maxMs, Math.round(ms));
    this.timeline.set(sec, b);
  }
}

/** Run git with the bearer header passed through the environment (never on the command line). */
export async function git(args: string[], token: string, cwd?: string): Promise<string> {
  const env = { ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`, GIT_TERMINAL_PROMPT: "0" };
  try {
    const { stdout } = await run("git", ["-c", "protocol.version=2", ...args], { cwd, env, maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch (e) {
    throw new Error(redact(`git ${args[0]} failed: ${e instanceof Error ? e.message : String(e)}`));
  }
}

/** What setup learns once per colony (no secrets). */
export interface LiveState {
  colony: string;
  blob: string;
  blobPath: string;
  probe: { proposalId: string; status: string; landingId?: string; ms: number };
}

/** List trunk blobs at the lease's base commit with the read-only trunk token. */
export async function trunkBlobs(lease: WorkspaceLease, dir: string): Promise<Array<{ path: string; blob: string }>> {
  mkdirSync(dirname(dir), { recursive: true });
  await run("rm", ["-rf", dir]);
  await git(["clone", "--quiet", "--no-checkout", "--depth", "1", "--filter=blob:none", "--branch", "main", lease.trunk.remote, dir], lease.trunk.token);
  const out = await git(["ls-tree", "-r", "HEAD"], lease.trunk.token, dir);
  return out
    .split("\n")
    .map((l) => /^\d+ blob ([0-9a-f]{40})\t(.+)$/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ blob: m[1]!, path: m[2]! }));
}

/** A proposal outcome as the agent loop needs it. */
type Outcome = Pick<Proposal, "status" | "reason" | "landingId">;

/** With the live feed, how long an agent waits for its outcome event before it asks the colony once. */
const FEED_FALLBACK_MS = 20_000;

/**
 * Wait for a proposal to become terminal. With the live feed connected, the outcome arrives as an
 * event (the colony pushes it, as it pushes outcomes to in-platform agents) and the colony is only
 * asked when no event came for FEED_FALLBACK_MS; without it, poll with the in-platform agent's old
 * backoff (1.5 s, x1.6, cap 15 s). `via` counts where outcomes came from.
 */
async function awaitOutcome(client: Client, id: string, untilMs: number, op = "poll", feed?: LiveFeed, via?: { feed: number; poll: number }): Promise<Outcome | null> {
  let last: Outcome | null = null;
  if (feed?.open) {
    while (performance.now() < untilMs) {
      const got = await feed.waitFor(id, Math.min(FEED_FALLBACK_MS, untilMs - performance.now()));
      if (got) {
        if (via) via.feed++;
        return got;
      }
      const p = await client.call<Proposal>(op, "GET", `/proposals/${encodeURIComponent(id)}`);
      if (p) {
        last = p;
        if (TERMINAL.has(p.status)) {
          if (via) via.poll++;
          return p;
        }
      }
    }
    return last;
  }
  let wait = 1_500;
  while (performance.now() < untilMs) {
    await sleep(Math.min(wait, untilMs - performance.now()));
    const p = await client.call<Proposal>(op, "GET", `/proposals/${encodeURIComponent(id)}`);
    if (p) {
      last = p;
      if (TERMINAL.has(p.status)) {
        if (via) via.poll++;
        return p;
      }
    }
    wait = Math.min(15_000, Math.round(wait * 1.6));
  }
  return last;
}

/** The POST /proposals body: one new file per intent, written with an existing blob. */
export function liveProposal(agentId: string, a: Assignment, blob: string, seq: number): Record<string, unknown> {
  const path = a.intent.footprint[0] ?? `bench/orphan/${agentId}-${seq}.txt`;
  return {
    intentId: a.intent.id,
    agentId,
    workspace: a.lease.repo,
    baseSha: a.lease.baseSha,
    headSha: fakeSha("head", agentId, a.intent.id, String(seq)),
    writeSet: [{ path, blob }],
    readSet: [],
    declared: { footprint: a.intent.footprint, summary: `bench: synthetic landing by ${agentId}` },
    evidence: { checks: [], notVerified: LIVE_NOTE },
  };
}

/**
 * The POST /proposals body of an --inline run: the same new file per intent, as an inline change. Its text travels
 * with it (keyed by its git blob id) and its head is the changeset id of the lease base and the write set.
 */
export function inlineProposal(agentId: string, a: Assignment, seq: number): Record<string, unknown> {
  const path = a.intent.footprint[0] ?? `bench/orphan/${agentId}-${seq}.txt`;
  const text = `bench: synthetic inline landing by ${agentId} (${seq}) for ${a.intent.id}\n`;
  const writeSet: FileVersion[] = [{ path, blob: blobId(text) }];
  return {
    intentId: a.intent.id,
    agentId,
    workspace: a.lease.repo,
    baseSha: a.lease.baseSha,
    headSha: changesetId(a.lease.baseSha, writeSet),
    writeSet,
    readSet: [],
    contents: { [writeSet[0]!.blob!]: text },
    declared: { footprint: a.intent.footprint, summary: `bench: synthetic inline landing by ${agentId}` },
    evidence: { checks: [], notVerified: LIVE_INLINE_NOTE },
  };
}

/**
 * Find a trunk blob (cached per colony) and prove one end-to-end landing with it. With `inline`, prove an inline
 * landing instead: no trunk blob and no git are needed (cached apart).
 */
export async function setup(cfg: LiveConfig, colony: string, stateDir: string, log: (s: string) => void, inline = false): Promise<LiveState> {
  const file = `${stateDir}/state-${colony}${inline ? "-inline" : ""}.json`;
  try {
    const cached = JSON.parse(readFileSync(file, "utf8")) as LiveState;
    if (cached.colony === colony && (inline || /^[0-9a-f]{40}$/.test(cached.blob))) return cached;
  } catch {
    // no cache
  }
  const rec = new Recorder();
  const client = new Client(cfg, colony, rec);
  const agent = await client.call<{ id: string }>("register", "POST", "/agents", { name: "bench-probe", kind: "synthetic" });
  if (!agent) throw new Error(`register failed: ${rec.errorSamples.join("; ")}`);
  const path = `bench/probe/probe-${Date.now().toString(36)}.txt`;
  const intent = await client.call<Intent>("intent", "POST", "/intents", { title: "bench: probe landing", why: "prove the synthetic landing path", footprint: [path], assignedTo: agent.id, createdBy: "bench-live" });
  if (!intent) throw new Error(`intent failed: ${rec.errorSamples.join("; ")}`);
  const t = await client.call<TakeResult>("take", "POST", `/agents/${agent.id}/take`, {});
  if (!t || "wait" in t) throw new Error(`probe take did not assign: ${JSON.stringify(t)}`);
  if (inline) {
    const t0 = performance.now();
    const p = await client.call<Proposal>("propose", "POST", "/proposals", inlineProposal(agent.id, t, 0));
    if (!p) throw new Error(`inline probe propose failed (is FT_INLINE on for ${colony}?): ${rec.errorSamples.join("; ")}`);
    const done = await awaitOutcome(client, p.id, performance.now() + 120_000);
    const probe = { proposalId: p.id, status: done?.status ?? "unknown", ms: Math.round(performance.now() - t0), ...(done?.landingId ? { landingId: done.landingId } : {}) };
    if (done?.status !== "landed") throw new Error(`inline probe proposal did not land: ${done?.status} ${done?.reason ?? ""}`);
    const state: LiveState = { colony, blob: "", blobPath: "", probe };
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(file, JSON.stringify(state, null, 2));
    return state;
  }
  const blobs = await trunkBlobs(t.lease, `${stateDir}/trunk-${colony}`);
  const license = blobs.find((b) => b.path === "LICENSE") ?? blobs[0];
  if (!license) throw new Error("trunk has no blobs");
  log(`setup: ${blobs.length} trunk blobs; using ${license.path} ${license.blob.slice(0, 10)}`);
  const t0 = performance.now();
  const p = await client.call<Proposal>("propose", "POST", "/proposals", liveProposal(agent.id, t, license.blob, 0));
  if (!p) throw new Error(`probe propose failed: ${rec.errorSamples.join("; ")}`);
  const done = await awaitOutcome(client, p.id, performance.now() + 120_000);
  const probe = { proposalId: p.id, status: done?.status ?? "unknown", ms: Math.round(performance.now() - t0), ...(done?.landingId ? { landingId: done.landingId } : {}) };
  if (done?.status !== "landed") throw new Error(`probe proposal did not land: ${done?.status} ${done?.reason ?? ""}`);
  const state: LiveState = { colony, blob: license.blob, blobPath: license.path, probe };
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(file, JSON.stringify(state, null, 2));
  return state;
}

/** Make sure at least `target` open bench intents exist, spread over `regions` directories. */
export async function ensureIntents(client: Client, target: number, regions: number, tag: string, log: (s: string) => void): Promise<number> {
  // The metrics report counts every open intent (a snapshot lists 5,000 at most); bench colonies hold only bench intents.
  const m = await client.call<{ metrics?: Record<string, number> }>("metrics", "GET", "/metrics");
  const open = m?.metrics?.["intentsOpen"] ?? 0;
  const need = Math.max(0, target - open);
  if (need === 0) return open;
  log(`creating ${need} bench intents over ${regions} regions (open ${open}, target ${target})`);
  let next = 0;
  let made = 0;
  const worker = async (): Promise<void> => {
    while (next < need) {
      const i = next++;
      const r = String(i % regions).padStart(2, "0");
      const path = `bench/r${r}/${tag}-${String(i).padStart(5, "0")}.txt`;
      const res = await client.call<Intent>("intent", "POST", "/intents", { title: `bench: add ${path}`, why: "synthetic load", footprint: [path], priority: 1, createdBy: "bench-live" });
      if (res) made++;
    }
  };
  await Promise.all(Array.from({ length: 24 }, worker));
  return open + made;
}

/** Live event capture from /api/colonies/:id/live. */
export class LiveFeed {
  landings: Array<{ id: string; at: number; recvMs: number; proposalIds: string[] }> = [];
  proposalStatus = new Map<string, { status: string; at: number; reason?: string }>();
  sigma: Array<{ at: number; recvMs: number; region: string; sigma: number }> = [];
  metrics: Array<{ at: number; recvMs: number; name: string; value: number }> = [];
  events = 0;
  open = false;
  reconnects = 0;
  private ws: WebSocket | null = null;
  private closing = false;
  /** Agents waiting for a proposal's final status (see waitFor). */
  private readonly waiters = new Map<string, Array<(o: { status: Proposal["status"]; reason?: string }) => void>>();

  /** Connect; resolves once open (or after 5 s). A socket that drops is reopened until close(). */
  async connect(cfg: LiveConfig, colony: string): Promise<void> {
    const url = `${cfg.url.replace(/^http/, "ws")}/api/colonies/${encodeURIComponent(colony)}/live`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onmessage = (ev: MessageEvent) => this.onMessage(ev.data);
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 5_000);
      ws.onopen = () => {
        this.open = true;
        clearTimeout(t);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(t);
        resolve();
      };
    });
    ws.onclose = () => {
      if (this.closing || this.ws !== ws) return;
      this.reconnects++;
      setTimeout(() => void this.connect(cfg, colony).catch(() => undefined), 1_000);
    };
  }

  /**
   * The final status of a proposal as the feed reports it, or null after `ms` without one (the
   * caller then asks the colony). Statuses seen before the call count.
   */
  waitFor(id: string, ms: number): Promise<{ status: Proposal["status"]; reason?: string } | null> {
    const known = this.proposalStatus.get(id);
    if (known && TERMINAL.has(known.status)) return Promise.resolve({ status: known.status as Proposal["status"], ...(known.reason ? { reason: known.reason } : {}) });
    return new Promise((resolve) => {
      const list = this.waiters.get(id) ?? [];
      const done = (o: { status: Proposal["status"]; reason?: string } | null): void => {
        clearTimeout(timer);
        const left = (this.waiters.get(id) ?? []).filter((f) => f !== done);
        if (left.length > 0) this.waiters.set(id, left);
        else this.waiters.delete(id);
        resolve(o);
      };
      const timer = setTimeout(() => done(null), Math.max(0, ms));
      list.push(done);
      this.waiters.set(id, list);
    });
  }

  private onMessage(data: unknown): void {
    if (typeof data !== "string" || data === "pong") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    const list = (Array.isArray(parsed) ? parsed : [parsed]) as ColonyEvent[];
    const recvMs = performance.now();
    for (const e of list) {
      this.events++;
      if (e.t === "landing") this.landings.push({ id: e.landingId, at: e.at, recvMs, proposalIds: e.proposalIds });
      else if (e.t === "proposal") {
        this.proposalStatus.set(e.proposalId, e.reason ? { status: e.status, at: e.at, reason: e.reason } : { status: e.status, at: e.at });
        if (TERMINAL.has(e.status)) for (const done of this.waiters.get(e.proposalId) ?? []) done(e.reason ? { status: e.status, reason: e.reason } : { status: e.status });
      } else if (e.t === "sigma") this.sigma.push({ at: e.at, recvMs, region: e.region, sigma: e.sigma });
      else if (e.t === "metric") this.metrics.push({ at: e.at, recvMs, name: e.name, value: e.value });
    }
  }

  close(): void {
    this.closing = true;
    try {
      this.ws?.close();
    } catch {
      // closed
    }
  }
}

/** Everything one live run measured. */
export interface LiveReport {
  kind: "live";
  note: string;
  /** Whether every proposal was an inline change (--inline). */
  inline?: boolean;
  label: string;
  url: string;
  colony: string;
  agents: number;
  durationS: number;
  workMs: number;
  regions: number;
  startedAt: string;
  elapsedS: number;
  stoppedEarly: string | null;
  ops: Array<{ op: string; calls: number; errors: number } & Summary>;
  takeAssigned: Summary;
  takeWait: Summary;
  counts: { registered: number; assigned: number; waits: Record<string, number>; proposals: number; landed: number; returned: number; rejected: number; unresolved: number };
  returns: Record<string, number>;
  window: { fromS: number; toS: number; commits: number; landedProposals: number; landedPerMin: number; commitsPerMin: number; source: string };
  snapshotDelta: Record<string, number>;
  timeToLandMs: Summary;
  batchSize: Summary;
  commitGapMs: Summary;
  feed: { connected: boolean; events: number; sigmaMax: number; sigmaEvents: number; reconnects: number };
  /** Where agents learned their outcomes: a live feed event, or a (fallback) poll. */
  outcomes: { feed: number; poll: number };
  /** Per second of the run (UTC seconds): calls finished, failed, and the slowest. */
  timeline: Array<{ t: string; calls: number; errors: number; maxMs: number }>;
  /** The colony's event-loop lag over 250 ms per 5-s window, when the preview runs with FT_LAG_PROBE (colony/lag.ts). */
  colonyLag: Array<{ t: string; ms: number }>;
  /** The end-of-run stop of this run's agents (POST /swarm/stop), when it ran. */
  stopped?: { ok: boolean; ms: number; retired?: number; failed?: number; error?: string };
  /** Trunk writer cycles seen on the live feed (`trunk.*` metrics, one group per cycle); absent before group commit. */
  trunkCycles?: TrunkCycles;
  /** Trunk publishing: the mode, and with asynchronous publishing the publish pushes seen on the feed (`trunk.publish.*`). */
  publish?: PublishReport;
  publishes?: TrunkCycles;
  errors: string[];
}

/** Summaries over the trunk writer's group-commit cycles in the steady-state window, one per `trunk.<name>` metric. */
export interface TrunkCycles {
  n: number;
  perMin: number;
  metrics: Record<string, Summary>;
}

/** Metrics of the publish loop's pushes (asynchronous publishing): one group per push, apart from the cycles. */
const PUBLISH_PREFIX = "trunk.publish.";

/**
 * Group the feed's `trunk.*` metrics by cycle (they share `at`) and summarize the cycles received in [fromMs, toMs].
 * With `prefix` "trunk.publish." the groups are the publish loop's pushes instead (left out of the cycles).
 */
export function trunkCycles(metrics: LiveFeed["metrics"], fromMs: number, toMs: number, prefix = "trunk."): TrunkCycles | undefined {
  const cycles = new Map<number, { recvMs: number; v: Record<string, number> }>();
  for (const m of metrics) {
    if (!m.name.startsWith(prefix) || (prefix !== PUBLISH_PREFIX && m.name.startsWith(PUBLISH_PREFIX))) continue;
    const c = cycles.get(m.at) ?? { recvMs: m.recvMs, v: {} };
    c.v[m.name.slice(prefix.length)] = m.value;
    cycles.set(m.at, c);
  }
  const rows = [...cycles.values()].filter((c) => c.recvMs >= fromMs && c.recvMs <= toMs).map((c) => c.v);
  if (rows.length === 0) return undefined;
  const names = [...new Set(rows.flatMap((r) => Object.keys(r)))].sort();
  return {
    n: rows.length,
    perMin: (rows.length / Math.max(1e-9, (toMs - fromMs) / 1000)) * 60,
    metrics: Object.fromEntries(names.map((k) => [k, summarize(rows.map((r) => r[k]).filter((x): x is number => typeof x === "number"))])),
  };
}

function reasonKey(reason: string | undefined): string {
  if (!reason) return "unknown";
  const r = reason.toLowerCase();
  if (r.startsWith("stale")) return "stale";
  if (r.includes("conflicts with another proposal")) return "conflict-in-batch";
  if (r.includes("not in workspace")) return "blob-missing";
  if (r.includes("inline change") || r.includes("inline contents")) return "inline-contents";
  if (r.includes("landing failed")) return "landing-failed";
  if (r.includes("trunk kept moving")) return "trunk-moving";
  if (r.startsWith("already landed")) return "already-landed";
  return reason.slice(0, 40);
}

/** Run the swarm and measure it. */
export async function runLive(cfg: LiveConfig, opts: LiveOptions, state: LiveState, log: (s: string) => void): Promise<LiveReport> {
  const rec = new Recorder();
  const client = new Client(cfg, opts.colony, rec, opts.timeoutMs);
  const tag = `${opts.label}-${Date.now().toString(36)}`;
  await ensureIntents(client, opts.intents, opts.regions, tag, log);
  const before = await client.call<{ metrics?: Record<string, number> }>("metrics", "GET", "/metrics");
  // Trunk publishing: asynchronous when the colony's trunk writer says so (FT_ASYNC_PUBLISH lists the colony and the
  // trunk writer runs on a deployment that has it).
  const status = await client.call<ColonySnapshot>("status", "GET", "");
  const mode: PublishMode = publishModeOf(status);
  if (opts.expectPublish && (status === null || opts.expectPublish !== mode)) {
    throw new Error(`colony ${opts.colony} publishes ${status === null ? "(status unreadable)" : mode}, not ${opts.expectPublish}: check FT_ASYNC_PUBLISH on the deployment, and that the colony's trunk writer has restarted on it (status publish.on)`);
  }
  const feed = new LiveFeed();
  await feed.connect(cfg, opts.colony);
  log(`feed ${feed.open ? "connected" : "NOT connected"}; ${opts.agents} agents for ${opts.durationS}s (ramp ${opts.rampS}s, work ${opts.workMs} ms)`);

  const counts = { registered: 0, assigned: 0, waits: {} as Record<string, number>, proposals: 0, landed: 0, returned: 0, rejected: 0, unresolved: 0 };
  const returns: Record<string, number> = {};
  const takeAssigned: number[] = [];
  const takeWait: number[] = [];
  const created = new Map<string, number>(); // proposalId -> server createdAt
  const via = { feed: 0, poll: 0 };
  const t0 = performance.now();
  const startedAt = new Date().toISOString();
  const deadline = t0 + opts.durationS * 1000;
  const drainUntil = deadline + opts.drainS * 1000;
  let stoppedEarly: string | null = null;
  let stop = false;

  // Error guard: stop early when more than a quarter of recent calls fail.
  let lastCalls = 0;
  let lastFailures = 0;
  const guard = setInterval(() => {
    const calls = client.calls - lastCalls;
    const fails = client.failures - lastFailures;
    lastCalls = client.calls;
    lastFailures = client.failures;
    if (calls >= 50 && fails / calls > 0.25 && !stop) {
      stop = true;
      stoppedEarly = `error rate ${(fails / calls * 100).toFixed(0)}% over 5 s at ${((performance.now() - t0) / 1000).toFixed(0)} s`;
      log(`stopping early: ${stoppedEarly}`);
    }
  }, 5_000);

  const agent = async (i: number): Promise<void> => {
    await sleep(opts.agents > 1 ? (i * opts.rampS * 1000) / opts.agents : 0);
    if (stop || performance.now() >= deadline) return;
    const reg = await client.call<{ id: string }>("register", "POST", "/agents", { name: `bench-live-${tag}-${i + 1}`, kind: "synthetic" });
    if (!reg?.id) return;
    counts.registered++;
    let seq = 0;
    let failures = 0;
    let lastBeat = performance.now();
    while (!stop && performance.now() < deadline) {
      const ts = performance.now();
      const t = await client.call<TakeResult>("take", "POST", `/agents/${reg.id}/take`, {});
      if (!t) {
        // The in-platform agents' backoff (1 s, 2 s, 4 s, ... +-25%, cap 60 s): a failed call is not retried at once,
        // so a colony that stalls for a moment is not met by every agent retrying four times a second.
        await sleep(errorBackoffMs(++failures));
        continue;
      }
      failures = 0;
      if ("wait" in t) {
        takeWait.push(performance.now() - ts);
        counts.waits[t.reason] = (counts.waits[t.reason] ?? 0) + 1;
        await sleep(Math.min(Math.max(200, Math.min(60_000, t.retryInMs)), deadline - performance.now()));
        continue;
      }
      takeAssigned.push(performance.now() - ts);
      counts.assigned++;
      if (opts.workMs > 0) await sleep(opts.workMs * (0.75 + Math.random() * 0.5));
      if (performance.now() - lastBeat > 45_000) {
        lastBeat = performance.now();
        await client.call("heartbeat", "POST", `/agents/${reg.id}/heartbeat`, {});
      }
      const body = opts.inline ? inlineProposal(reg.id, t, ++seq) : liveProposal(reg.id, t, state.blob, ++seq);
      const p = await client.call<Proposal>("propose", "POST", "/proposals", body);
      if (!p) {
        await sleep(500);
        continue;
      }
      counts.proposals++;
      created.set(p.id, p.createdAt);
      const done = await awaitOutcome(client, p.id, drainUntil, "poll", feed, via);
      const status = done?.status ?? "unknown";
      if (status === "landed") counts.landed++;
      else if (status === "returned") {
        counts.returned++;
        const k = reasonKey(done?.reason);
        returns[k] = (returns[k] ?? 0) + 1;
      } else if (status === "rejected") counts.rejected++;
      else counts.unresolved++;
    }
  };

  await Promise.all(Array.from({ length: opts.agents }, (_, i) => agent(i)));
  clearInterval(guard);
  const elapsedS = (performance.now() - t0) / 1000;
  await sleep(1_500); // let the feed catch the last events
  const after = await client.call<{ metrics?: Record<string, number> }>("metrics", "GET", "/metrics");
  // With asynchronous publishing a landing counts once recorded: wait (at most a minute) until every one is published.
  const publish: PublishReport = { mode, atEnd: null, drained: null, drainMs: null };
  if (mode === "async") {
    const t1 = performance.now();
    publish.atEnd = publishOf(await client.call<ColonySnapshot>("status", "GET", ""));
    let p = publish.atEnd;
    while (p !== null && p.unpublished > 0 && performance.now() - t1 < 60_000) {
      await sleep(2_000);
      p = publishOf(await client.call<ColonySnapshot>("status", "GET", "")) ?? p;
    }
    publish.drained = p;
    publish.drainMs = p !== null && p.unpublished === 0 ? Math.round(performance.now() - t1) : null;
    log(`publishing: ${publish.atEnd?.unpublished ?? "?"} landing(s) waiting at the end, ${publish.drainMs === null ? "NOT drained" : `drained in ${publish.drainMs} ms`}`);
  }
  feed.close();
  // Retire the run's agents: their claims go at once, so the next run is never held back by this one.
  let stopped: LiveReport["stopped"];
  if (opts.stopAgents !== false) {
    const s0 = performance.now();
    const stopRec = new Recorder();
    const stopper = new Client(cfg, opts.colony, stopRec, 300_000);
    // A large swarm may not stop in one call (each agent is one call from the API); repeat for the rest.
    let res: { ok?: boolean; retired?: number; failed?: unknown[]; error?: string } | null = null;
    let retired = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      res = await stopper.call<{ ok?: boolean; retired?: number; failed?: unknown[]; error?: string }>("stop", "POST", "/swarm/stop", { reason: `bench run ${tag} over` });
      retired += typeof res?.retired === "number" ? res.retired : 0;
      if (res?.ok) break;
    }
    const error = res?.error ?? stopRec.errorSamples[0];
    stopped = { ok: !!res?.ok, ms: Math.round(performance.now() - s0), retired, ...(Array.isArray(res?.failed) ? { failed: res.failed.length } : {}), ...(error ? { error: error.slice(0, 300) } : {}) };
    log(`stopped the run's agents: ${JSON.stringify(stopped)}`);
  }

  // Steady-state window: skip the ramp and a short warm-up; stop at the deadline.
  const fromS = Math.min(opts.durationS / 2, opts.rampS + Math.min(15, opts.durationS / 4));
  const toS = Math.min(opts.durationS, (deadline - t0) / 1000);
  const inWindow = feed.landings.filter((l) => (l.recvMs - t0) / 1000 >= fromS && (l.recvMs - t0) / 1000 <= toS);
  const commits = inWindow.length;
  const landedProposals = inWindow.reduce((n, l) => n + l.proposalIds.length, 0);
  const span = Math.max(1e-9, toS - fromS);
  const timeToLand: number[] = [];
  const landedAt = new Map<string, number>();
  for (const l of feed.landings) for (const id of l.proposalIds) landedAt.set(id, l.at);
  for (const [id, c] of created) {
    const at = landedAt.get(id);
    if (at !== undefined) timeToLand.push(at - c);
  }
  const ordered = [...feed.landings].sort((a, b) => a.at - b.at);
  const gaps: number[] = [];
  for (let i = 1; i < ordered.length; i++) gaps.push(ordered[i]!.at - ordered[i - 1]!.at);
  const delta: Record<string, number> = {};
  for (const k of ["landings", "landedProposals", "proposals", "returned", "rejected", "takes"]) {
    const a = after?.metrics?.[k];
    const b = before?.metrics?.[k];
    if (typeof a === "number") delta[k] = a - (typeof b === "number" ? b : 0);
  }
  const sigmaMax = feed.sigma.reduce((m, s) => Math.max(m, s.sigma), 0);

  return {
    kind: "live",
    note: opts.inline ? LIVE_INLINE_NOTE : LIVE_NOTE,
    ...(opts.inline ? { inline: true } : {}),
    label: opts.label,
    url: cfg.url,
    colony: opts.colony,
    agents: opts.agents,
    durationS: opts.durationS,
    workMs: opts.workMs,
    regions: opts.regions,
    startedAt,
    elapsedS,
    stoppedEarly,
    ops: rec.ops().map((op) => ({ op, calls: rec.summary(op).n, errors: rec.errors(op), ...rec.summary(op) })),
    takeAssigned: summarize(takeAssigned),
    takeWait: summarize(takeWait),
    counts,
    returns,
    window: { fromS, toS, commits, landedProposals, landedPerMin: (landedProposals / span) * 60, commitsPerMin: (commits / span) * 60, source: feed.open ? "live WebSocket landing events" : "feed not connected" },
    snapshotDelta: delta,
    timeToLandMs: summarize(timeToLand),
    batchSize: summarize(feed.landings.map((l) => l.proposalIds.length)),
    commitGapMs: summarize(gaps),
    feed: { connected: feed.open, events: feed.events, sigmaMax, sigmaEvents: feed.sigma.length, reconnects: feed.reconnects },
    outcomes: via,
    timeline: [...client.timeline].sort((a, b) => a[0] - b[0]).map(([sec, b]) => ({ t: new Date(sec * 1000).toISOString().slice(11, 19), ...b })),
    colonyLag: feed.metrics.filter((m) => m.name === "colony.lagMs").map((m) => ({ t: new Date(m.at).toISOString().slice(11, 19), ms: m.value })),
    ...(stopped ? { stopped } : {}),
    ...(() => {
      const tc = trunkCycles(feed.metrics, t0 + fromS * 1000, t0 + toS * 1000);
      return tc ? { trunkCycles: tc } : {};
    })(),
    publish,
    ...(() => {
      const pushes = trunkCycles(feed.metrics, t0 + fromS * 1000, t0 + toS * 1000, PUBLISH_PREFIX);
      return pushes ? { publishes: pushes } : {};
    })(),
    errors: rec.errorSamples,
  };
}

function num(v: string | undefined, name: string, fallback: number, min: number, max: number): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`--${name} must be a number from ${min} to ${max}`);
  return n;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      colony: { type: "string" },
      agents: { type: "string" },
      duration: { type: "string" },
      ramp: { type: "string" },
      work: { type: "string" },
      regions: { type: "string" },
      intents: { type: "string" },
      drain: { type: "string" },
      timeout: { type: "string" },
      out: { type: "string" },
      label: { type: "string" },
      state: { type: "string" },
      "expect-publish": { type: "string" },
      "setup-only": { type: "boolean" },
      "keep-agents": { type: "boolean" },
      inline: { type: "boolean" },
    },
    strict: true,
  });
  const colony = (values.colony ?? "").trim();
  if (!colony) throw new Error("--colony is required");
  const agents = Math.floor(num(values.agents, "agents", 10, 1, 5_000));
  const expectPublish = values["expect-publish"];
  if (expectPublish !== undefined && expectPublish !== "async" && expectPublish !== "sync") throw new Error("--expect-publish must be async or sync");
  const opts: LiveOptions = {
    colony,
    agents,
    durationS: num(values.duration, "duration", 60, 5, 3_600),
    rampS: num(values.ramp, "ramp", Math.min(10, agents / 50), 0, 600),
    workMs: num(values.work, "work", 0, 0, 600_000),
    regions: Math.floor(num(values.regions, "regions", 64, 1, 100)),
    intents: Math.floor(num(values.intents, "intents", Math.max(400, agents * 3), 0, 20_000)),
    drainS: num(values.drain, "drain", 20, 0, 600),
    timeoutMs: num(values.timeout, "timeout", 30_000, 1_000, 600_000),
    label: values.label ?? `n${agents}`,
    ...(values.out ? { out: values.out } : {}),
    stopAgents: values["keep-agents"] !== true,
    ...(values.inline ? { inline: true } : {}),
    ...(expectPublish ? { expectPublish } : {}),
  };
  const cfg = liveConfig();
  const log = (s: string) => console.error(`[${new Date().toISOString().slice(11, 19)}] ${s}`);
  const state = await setup(cfg, colony, values.state ?? "/tmp/ft-w2", log, opts.inline === true);
  log(opts.inline ? `inline probe landed ${state.probe.proposalId} in ${state.probe.ms} ms` : `probe landed ${state.probe.proposalId} in ${state.probe.ms} ms (blob ${state.blob.slice(0, 10)} from ${state.blobPath})`);
  if (values["setup-only"]) return;
  const report = await runLive(cfg, opts, state, log);
  const text = JSON.stringify(report, null, 2);
  if (opts.out) {
    mkdirSync(dirname(opts.out), { recursive: true });
    writeFileSync(opts.out, `${text}\n`);
    log(`wrote ${opts.out}`);
  }
  const s = report;
  log(
    `N=${s.agents}: landed/min ${s.window.landedPerMin.toFixed(1)} (commits/min ${s.window.commitsPerMin.toFixed(1)}), take p50 ${s.takeAssigned.p50?.toFixed(0)} ms p99 ${s.takeAssigned.p99?.toFixed(0)} ms, ` +
      `ttl p50 ${s.timeToLandMs.p50?.toFixed(0)} ms p90 ${s.timeToLandMs.p90?.toFixed(0)} ms p99 ${s.timeToLandMs.p99?.toFixed(0)} ms, batch p50 ${s.batchSize.p50}, returned ${s.counts.returned}, ` +
      `errors ${s.ops.reduce((n, o) => n + o.errors, 0)}, outcomes feed ${s.outcomes.feed} poll ${s.outcomes.poll}${s.stoppedEarly ? `, STOPPED EARLY: ${s.stoppedEarly}` : ""}` +
      `, publish ${s.publish?.mode ?? "?"}${s.publish?.mode === "async" ? ` (push p50 ${s.publishes?.metrics.ms?.p50?.toFixed(0) ?? "?"} ms, lag p90 ${s.trunkCycles?.metrics.publishLagMs?.p90?.toFixed(0) ?? "?"} ms, drained ${s.publish.drainMs ?? "NO"})` : ""}`,
  );
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
    console.error(redact(e instanceof Error ? e.message : String(e)));
    process.exit(1);
  });
}
