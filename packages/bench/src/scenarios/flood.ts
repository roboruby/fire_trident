#!/usr/bin/env node
/**
 * Polling flood over MCP, measured live (FT_AGENT_CALL_BUDGET). K greedy sessions call `inbox` with no wait (or `sense`)
 * as fast as answers come back, ignoring retryAfterMs, while M honest agents work as the agent guides say: `take` with
 * `wait`, `read` the file, `propose` an inline change, then `inbox` with `wait` until it is decided. Run it with the
 * budget off, then on: one JSON report gives the honest agents' landings a minute and their median time from propose
 * to landed, the greedy calls made and how many were answered 429 (`rate_limit`), and the errors.
 *
 *   FT_URL=https://<preview> FT_ADMIN_TOKEN=... FT_MCP_TOKEN=... node packages/bench/src/scenarios/flood.ts --label off --out flood-off.json
 *
 * It creates its colony (regions two directories deep, review off) and deletes it at the end unless --keep; --reuse
 * runs on an existing colony as it is and never deletes it. The deployment must take inline changes (FT_INLINE).
 * Synthetic agents, no model calls. --baseline <s> runs the honest agents alone first, as a reference.
 */
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { liveConfig, parseEnvFile, redact, type LiveConfig } from "../env.ts";
import { errorBackoffMs, errorDetail } from "../live.ts";
import { Recorder, summarize, type Summary } from "../stats.ts";

/** The MCP protocol version the scenario speaks (the one docs/agents/generic.md uses with curl). */
const PROTOCOL = "2025-06-18";
/** The production deployment: a flood there needs --allow-production. */
const PRODUCTION_HOST = "firetrident.mattsolt.workers.dev";
/** Longest server-side wait the MCP tools accept (seconds). */
const MAX_WAIT_S = 45;
/** Colony ids are lowercase slugs (the MCP join rule). */
const COLONY_ID = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
/** Proposal states after which nothing more happens. */
const FINAL = new Set(["landed", "returned", "rejected"]);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/** What greedy sessions call in their loops: both reach the colony on every call. */
export type GreedyTool = "inbox" | "sense";

/** A failed call: the tool's error envelope (kind `rate_limit` from the call budget), or kind `transport` when no tool answered. */
export interface CallError {
  kind: string;
  message: string;
  retryAfterMs?: number;
  status?: number;
}

/** A tool call's answer as the scenario counts it. */
export interface ToolAnswer<T> {
  /** The tool ran and answered without isError. */
  ok: boolean;
  /** The tool's answer (the JSON of its text), when it succeeded. */
  data: T | null;
  error: CallError | null;
  ms: number;
}

/** An HTTP failure of an MCP request (a refused token, an unknown session, the edge's own 429). */
class HttpError extends Error {
  // Plain fields, no parameter properties: node runs this file with type stripping only.
  readonly status: number;

  constructor(status: number, body: string) {
    super(`HTTP ${status}: ${body.replace(/\s+/g, " ").slice(0, 160)}`);
    this.status = status;
  }
}

/** A JSON-RPC error answer (the request reached the server, which refused the message itself). */
class RpcError extends Error {}

function isRecord(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

function jsonOrNull(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The JSON messages of a server-sent event stream: each event's data lines joined; comments, other fields and non-JSON skipped. */
export function parseSse(text: string): unknown[] {
  const out: unknown[] = [];
  for (const block of text.replace(/\r\n?/g, "\n").split(/\n{2,}/)) {
    const data = block
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""));
    if (data.length === 0) continue;
    const message = jsonOrNull(data.join("\n"));
    if (message !== null) out.push(message);
  }
  return out;
}

/** A call error from a tool's error envelope, or from its text when it carries none. */
function callError(envelope: unknown, text: string): CallError {
  if (isRecord(envelope) && typeof envelope.kind === "string") {
    return {
      kind: envelope.kind,
      message: typeof envelope.message === "string" ? envelope.message : "",
      ...(typeof envelope.retryAfterMs === "number" ? { retryAfterMs: envelope.retryAfterMs } : {}),
      ...(typeof envelope.status === "number" ? { status: envelope.status } : {}),
    };
  }
  return { kind: "unknown", message: text.slice(0, 200) };
}

/**
 * One MCP session over Streamable HTTP with plain fetch, as docs/agents/generic.md shows it with curl: `initialize`
 * returns the session id, and every later request carries it. Answers arrive as server-sent events or JSON.
 */
export class McpSession {
  sessionId: string | null = null;
  readonly name: string;
  private readonly url: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private seq = 0;

  constructor(url: string, token: string, name: string, fetchImpl: typeof fetch = fetch) {
    this.url = url;
    this.token = token;
    this.name = name;
    this.fetchImpl = fetchImpl;
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(this.sessionId ? { "mcp-session-id": this.sessionId, "mcp-protocol-version": PROTOCOL } : {}),
    };
  }

  private async post(message: Record<string, unknown>, timeoutMs: number): Promise<Response> {
    return this.fetchImpl(`${this.url}/mcp`, { method: "POST", headers: this.headers(), body: JSON.stringify(message), signal: AbortSignal.timeout(timeoutMs) });
  }

  /** One JSON-RPC request: its result, or a thrown error naming the HTTP status or the JSON-RPC error. */
  private async request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    const id = ++this.seq;
    const res = await this.post({ jsonrpc: "2.0", id, method, params }, timeoutMs);
    const text = await res.text();
    if (!res.ok) throw new HttpError(res.status, text);
    if (method === "initialize") this.sessionId = res.headers.get("mcp-session-id");
    const parsed = (res.headers.get("content-type") ?? "").includes("text/event-stream") ? parseSse(text) : [jsonOrNull(text)].flat();
    const reply = parsed.find((m) => isRecord(m) && m.id === id);
    if (!isRecord(reply)) throw new Error(`no answer to ${method} in the response`);
    if (isRecord(reply.error)) throw new RpcError(`${method}: ${String(reply.error.message ?? "error")}`);
    return isRecord(reply.result) ? reply.result : {};
  }

  /** Open the session: initialize (the server returns the session id), then the initialized notification. */
  async open(timeoutMs = 30_000): Promise<void> {
    this.sessionId = null;
    await this.request("initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: this.name, version: "0.0.1" } }, timeoutMs);
    if (!this.sessionId) throw new Error("initialize answered without an mcp-session-id header");
    const res = await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }, timeoutMs);
    const text = await res.text();
    if (!res.ok) throw new HttpError(res.status, text);
  }

  /** The server's tools with the argument names of each. */
  async tools(): Promise<Map<string, string[]>> {
    const result = await this.request("tools/list", {}, 30_000);
    const tools = Array.isArray(result.tools) ? result.tools : [];
    return new Map(
      tools.filter(isRecord).map((t) => {
        const schema = isRecord(t.inputSchema) ? t.inputSchema : {};
        return [String(t.name), Object.keys(isRecord(schema.properties) ? schema.properties : {})] as [string, string[]];
      }),
    );
  }

  /** Call a tool. Never throws: a failure comes back as `error`, kind `transport` when no tool answered (`protocol` for a JSON-RPC error). */
  async call<T>(tool: string, args: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<ToolAnswer<T>> {
    const t0 = performance.now();
    const ms = (): number => Math.round(performance.now() - t0);
    try {
      const result = await this.request("tools/call", { name: tool, arguments: args }, timeoutMs);
      const content = Array.isArray(result.content) ? result.content : [];
      const text = content
        .filter(isRecord)
        .map((c) => (c.type === "text" && typeof c.text === "string" ? c.text : ""))
        .join("");
      const data = jsonOrNull(text);
      if (result.isError === true) {
        const structured = isRecord(result.structuredContent) ? result.structuredContent.error : undefined;
        return { ok: false, data: null, error: callError(structured ?? (isRecord(data) ? data.error : undefined), text), ms: ms() };
      }
      return { ok: true, data: data as T, error: null, ms: ms() };
    } catch (e) {
      const message = redact(e instanceof HttpError || e instanceof RpcError ? e.message : errorDetail(e));
      const kind = e instanceof RpcError ? "protocol" : "transport";
      return { ok: false, data: null, error: { kind, message, ...(e instanceof HttpError ? { status: e.status } : {}) }, ms: ms() };
    }
  }

  /** End the session (DELETE): best effort. */
  async close(): Promise<void> {
    if (!this.sessionId) return;
    const headers = { authorization: `Bearer ${this.token}`, "mcp-session-id": this.sessionId };
    this.sessionId = null;
    await this.fetchImpl(`${this.url}/mcp`, { method: "DELETE", headers, signal: AbortSignal.timeout(10_000) })
      .then((r) => r.text())
      .catch(() => undefined);
  }
}

/** A uniform sample of at most `cap` values from a stream of any length (reservoir sampling). */
export class Reservoir {
  readonly values: number[] = [];
  private seen = 0;
  private readonly cap: number;
  private readonly random: () => number;

  constructor(cap = 50_000, random: () => number = Math.random) {
    this.cap = cap;
    this.random = random;
  }

  /** Offer one value. */
  add(v: number): void {
    this.seen++;
    if (this.values.length < this.cap) this.values.push(v);
    else {
      const j = Math.floor(this.random() * this.seen);
      if (j < this.cap) this.values[j] = v;
    }
  }
}

function bump(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

/** The kind a failed call is counted under: the envelope's kind, or the HTTP status of a transport failure (`http 429`). */
function errorKey(e: CallError): string {
  return e.kind === "transport" && e.status !== undefined ? `http ${e.status}` : e.kind;
}

/** What the greedy sessions' calls got: answered by the tool (it reached the colony), refused by the budget, or failed. */
export class GreedyTally {
  calls = 0;
  answered = 0;
  refused = 0;
  readonly errors: Record<string, number> = {};
  readonly errorSamples: string[] = [];
  readonly answeredMs = new Reservoir();
  readonly refusedMs = new Reservoir();
  readonly retryAfterMs = new Reservoir();

  /** Count one answer. */
  add(a: ToolAnswer<unknown>): void {
    this.calls++;
    if (a.ok) {
      this.answered++;
      this.answeredMs.add(a.ms);
    } else if (a.error?.kind === "rate_limit") {
      this.refused++;
      this.refusedMs.add(a.ms);
      if (a.error.retryAfterMs !== undefined) this.retryAfterMs.add(a.error.retryAfterMs);
    } else if (a.error) {
      bump(this.errors, errorKey(a.error));
      const line = `greedy: ${a.error.message.slice(0, 200)}`;
      if (this.errorSamples.length < 8 && !this.errorSamples.includes(line)) this.errorSamples.push(line);
    }
  }
}

/** One greedy loop: call `tool` with no wait as fast as answers come back until `until`, ignoring retryAfterMs. */
export async function greedyLoop(s: McpSession, tool: GreedyTool, until: number, tally: GreedyTally): Promise<void> {
  while (Date.now() < until) {
    const a = await s.call(tool, {});
    tally.add(a);
    // A loop on a broken connection would spin without sending anything: pause briefly after a transport failure.
    if (a.error?.kind === "transport") await sleep(50);
  }
}

/** One honest change that landed: when it was proposed and when its agent saw it landed (epoch ms). */
export interface Landing {
  proposedAt: number;
  landedAt: number;
}

/** What the honest agents did: their landings, their proposals' outcomes, and their calls (by tool, with latencies). */
export class HonestTally {
  readonly landings: Landing[] = [];
  readonly outcomes: Record<string, number> = {};
  calls = 0;
  refused = 0;
  /** Takes that came back with no work after waiting on the server. */
  noWork = 0;
  readonly errors: Record<string, number> = {};
  readonly rec = new Recorder();

  /** Count one call of `tool`. */
  add(tool: string, a: ToolAnswer<unknown>): void {
    this.calls++;
    if (a.ok) {
      this.rec.record(tool, a.ms);
      return;
    }
    if (a.error?.kind === "rate_limit") this.refused++;
    const e = a.error ?? { kind: "unknown", message: "no answer" };
    bump(this.errors, errorKey(e));
    this.rec.error(tool, a.ms, e.message.slice(0, 200));
  }
}

type TakeAnswer = { wait?: boolean; intent?: { id: string; footprint?: string[] } };
type ProposeAnswer = { proposal?: { id: string; status: string } };
type InboxAnswer = { watching?: { status: string; final?: boolean } };

/** What an honest agent writes into the file its intent names. */
function fileText(agent: string, intentId: string, n: number): string {
  return `flood scenario: written by ${agent} for ${intentId} (change ${n})\n`;
}

/** How often an honest agent repeats a call refused with rate_limit (after retryAfterMs each time) before it moves on. */
const RATE_LIMIT_RETRIES = 5;

/**
 * One honest agent, as the guides say: take with wait, read the file it changes, propose an inline change, and wait for
 * the outcome with inbox and wait. It takes no new work after `until`, waits on a change in flight until `drainUntil`,
 * and repeats a call refused with rate_limit after retryAfterMs. Throws when the colony refuses inline changes (the
 * scenario cannot run there).
 */
export async function honestAgent(s: McpSession, opts: { until: number; drainUntil: number }, tally: HonestTally): Promise<void> {
  const call = async <T>(tool: string, args: Record<string, unknown>, waitS = 0): Promise<ToolAnswer<T>> => {
    for (let attempt = 0; ; attempt++) {
      const a = await s.call<T>(tool, args, (waitS + 30) * 1000);
      tally.add(tool, a);
      if (a.error?.kind !== "rate_limit" || attempt >= RATE_LIMIT_RETRIES) return a;
      await sleep(a.error.retryAfterMs ?? 1_000);
    }
  };
  let failures = 0;
  const pause = async (): Promise<void> => {
    failures++;
    await sleep(errorBackoffMs(failures));
  };
  let changes = 0;
  while (Date.now() < opts.until) {
    const left = Math.floor((opts.until - Date.now()) / 1000);
    if (left < 1) break;
    const wait = Math.min(30, left);
    const t = await call<TakeAnswer>("take", { wait }, wait);
    if (!t.ok) {
      await pause();
      continue;
    }
    const intent = t.data?.intent;
    const path = intent?.footprint?.[0];
    if (!intent || !path) {
      tally.noWork++;
      continue;
    }
    failures = 0;
    changes++;
    // The guides: read every file the change depends on (here, that the new file is absent at the lease base).
    await call("read", { path });
    const proposedAt = Date.now();
    const p = await call<ProposeAnswer>("propose", {
      files: [{ path, content: fileText(s.name, intent.id, changes) }],
      summary: "flood scenario: add one new file",
      notVerified: "Not verified: a synthetic agent of the flood scenario; it ran nothing.",
    });
    const proposal = p.data?.proposal;
    if (!p.ok || !proposal) {
      if (/inline changes are off/.test(p.error?.message ?? "")) throw new Error(`the colony refuses inline changes (FT_INLINE): ${p.error?.message ?? ""}`);
      await call("release", { reason: "flood scenario: the proposal failed" });
      await pause();
      continue;
    }
    let status = proposal.status;
    while (!FINAL.has(status) && status !== "escalated" && Date.now() < opts.drainUntil) {
      const w = Math.max(1, Math.min(MAX_WAIT_S, Math.floor((opts.drainUntil - Date.now()) / 1000)));
      const r = await call<InboxAnswer>("inbox", { proposalId: proposal.id, wait: w }, w);
      if (!r.ok) {
        await pause();
        continue;
      }
      status = r.data?.watching?.status ?? status;
    }
    bump(tally.outcomes, FINAL.has(status) || status === "escalated" ? status : "unsettled");
    if (status === "landed") tally.landings.push({ proposedAt, landedAt: Date.now() });
  }
}

/** Honest agents' work in one phase of the run. */
export interface PhaseStats {
  seconds: number;
  /** Changes whose agent saw them land within the phase. */
  landed: number;
  landingsPerMin: number;
  /** From the propose call to the agent seeing the change landed, for changes proposed within the phase. */
  proposeToLandedMs: Summary;
}

function round(n: number, digits = 1): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/** The honest agents' landings a minute and propose-to-landed times in [from, to) (epoch ms). */
export function phaseStats(landings: readonly Landing[], from: number, to: number): PhaseStats {
  const seconds = Math.max(0, (to - from) / 1000);
  const landed = landings.filter((l) => l.landedAt >= from && l.landedAt < to).length;
  const times = landings.filter((l) => l.proposedAt >= from && l.proposedAt < to).map((l) => l.landedAt - l.proposedAt);
  return { seconds: round(seconds), landed, landingsPerMin: seconds > 0 ? round(landed / (seconds / 60), 2) : 0, proposeToLandedMs: summarize(times) };
}

/** Options of one flood run. */
export interface FloodOptions {
  url?: string;
  colony: string;
  reuse: boolean;
  keep: boolean;
  greedy: number;
  /** Loops each greedy session runs at once. */
  concurrency: number;
  honest: number;
  durationS: number;
  baselineS: number;
  drainS: number;
  tool: GreedyTool;
  intents: number;
  regions: number;
  label: string | null;
  out: string;
  allowProduction: boolean;
}

/** Parse the command line; throws a sentence on a bad value. */
export function parseFloodOptions(argv: string[], now: () => number = Date.now): FloodOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      url: { type: "string" },
      colony: { type: "string" },
      reuse: { type: "boolean" },
      keep: { type: "boolean" },
      greedy: { type: "string" },
      concurrency: { type: "string" },
      honest: { type: "string" },
      duration: { type: "string" },
      baseline: { type: "string" },
      drain: { type: "string" },
      tool: { type: "string" },
      intents: { type: "string" },
      regions: { type: "string" },
      label: { type: "string" },
      out: { type: "string" },
      "allow-production": { type: "boolean" },
    },
    strict: true,
  });
  const int = (name: string, raw: string | undefined, fallback: number, min: number): number => {
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min) throw new Error(`--${name} must be a whole number of at least ${min} (got ${raw})`);
    return n;
  };
  const colony = (values.colony ?? `flood-${now().toString(36)}`).trim();
  if (!COLONY_ID.test(colony)) throw new Error(`--colony must be a lowercase slug such as flood-1 (got ${colony})`);
  const tool = values.tool ?? "inbox";
  if (tool !== "inbox" && tool !== "sense") throw new Error(`--tool must be inbox or sense (got ${tool})`);
  const honest = int("honest", values.honest, 4, 1);
  const durationS = int("duration", values.duration, 120, 1);
  const baselineS = int("baseline", values.baseline, 0, 0);
  return {
    ...(values.url ? { url: values.url } : {}),
    colony,
    reuse: values.reuse === true,
    keep: values.keep === true,
    greedy: int("greedy", values.greedy, 16, 0),
    concurrency: int("concurrency", values.concurrency, 4, 1),
    honest,
    durationS,
    baselineS,
    drainS: int("drain", values.drain, 60, 0),
    tool,
    // Enough work that no honest agent runs out: one intent per agent for every two seconds of the run.
    intents: int("intents", values.intents, honest * Math.ceil((baselineS + durationS) / 2), 1),
    regions: int("regions", values.regions, 4, 1),
    label: values.label ?? null,
    out: values.out ?? "flood.json",
    allowProduction: values["allow-production"] === true,
  };
}

/** The run's timeline (epoch ms): honest agents start at `start`, greedy loops run [floodAt, end), changes in flight settle until drainUntil. */
export interface Timeline {
  start: number;
  floodAt: number;
  end: number;
}

/** The scenario's one JSON report. */
export function floodReport(p: { opts: FloodOptions; url: string; createdColony: boolean; timeline: Timeline; honest: HonestTally; greedy: GreedyTally; generatedAt?: string }): Record<string, unknown> {
  const { opts, timeline: t, honest: h, greedy: g } = p;
  const floodS = Math.max(0, (t.end - t.floodAt) / 1000);
  const perSec = (n: number): number => (floodS > 0 ? round(n / floodS) : 0);
  const latency = Object.fromEntries(h.rec.ops().map((op) => [op, { ...h.rec.summary(op), errors: h.rec.errors(op) }]));
  return {
    kind: "flood",
    label: "MEASURED",
    run: opts.label,
    generatedAt: p.generatedAt ?? new Date().toISOString(),
    url: p.url,
    colony: opts.colony,
    createdColony: p.createdColony,
    options: { greedy: opts.greedy, concurrency: opts.concurrency, honest: opts.honest, durationS: opts.durationS, baselineS: opts.baselineS, drainS: opts.drainS, tool: opts.tool, intents: opts.intents, regions: opts.regions },
    note: "Synthetic agents over MCP, no model calls. Greedy sessions call the tool with no wait as fast as answers come back and ignore retryAfterMs; honest agents take with wait, read, propose an inline change and wait on inbox with wait, honoring retryAfterMs.",
    budgetSeen: g.refused > 0 || h.refused > 0,
    honest: {
      agents: opts.honest,
      ...(opts.baselineS > 0 ? { baseline: phaseStats(h.landings, t.start, t.floodAt) } : {}),
      flood: phaseStats(h.landings, t.floodAt, t.end),
      outcomes: h.outcomes,
      noWork: h.noWork,
      calls: h.calls,
      refused429: h.refused,
      errors: h.errors,
      latencyMs: latency,
    },
    greedy: {
      sessions: opts.greedy,
      loops: opts.greedy * opts.concurrency,
      tool: opts.tool,
      seconds: round(floodS),
      calls: g.calls,
      callsPerSec: perSec(g.calls),
      answered429: g.refused,
      share429: g.calls > 0 ? round(g.refused / g.calls, 3) : 0,
      // Calls the tool ran: each reached the colony.
      reachedColony: g.answered,
      reachedColonyPerSec: perSec(g.answered),
      retryAfterMs: summarize(g.retryAfterMs.values),
      latencyMs: { answered: summarize(g.answeredMs.values), refused: summarize(g.refusedMs.values) },
      errors: g.errors,
    },
    errors: [...h.rec.errorSamples, ...g.errorSamples].map(redact),
  };
}

/** One admin request to /api: its status and JSON body (null when there is none). */
async function admin(cfg: LiveConfig, method: "GET" | "POST" | "DELETE", path: string, body?: unknown, timeoutMs = 120_000): Promise<{ status: number; data: unknown }> {
  const headers: Record<string, string> = { accept: "application/json", "user-agent": "ft-bench-flood/0.0.1" };
  if (cfg.token) headers.authorization = `Bearer ${cfg.token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${cfg.url}/api${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeoutMs) });
  return { status: res.status, data: jsonOrNull(await res.text()) };
}

/** The colony to run on: created with review off (true), or an existing one with --reuse (false). */
async function ensureColony(cfg: LiveConfig, opts: FloodOptions, log: (s: string) => void): Promise<boolean> {
  const made = await admin(cfg, "POST", "/colonies", { name: opts.colony, regionDepth: 2, poolTarget: Math.max(8, opts.honest * 2) }, 600_000);
  if (made.status === 409) {
    if (!opts.reuse) throw new Error(`colony ${opts.colony} already exists: pass --reuse to run on it as it is, or name a new --colony`);
    log(`reusing colony ${opts.colony} as it is (its review policy and region depth unchanged)`);
    return false;
  }
  if (made.status !== 201 && made.status !== 200) throw new Error(`could not create colony ${opts.colony}: ${made.status} ${redact(JSON.stringify(made.data)).slice(0, 200)}`);
  // Review off: a synthetic change is landed by the colony's checks alone, with no model call.
  const policy = await admin(cfg, "POST", `/colonies/${opts.colony}/decide/policy`, { enabled: false });
  if (policy.status !== 200) throw new Error(`could not turn review off for ${opts.colony}: ${policy.status}`);
  log(`created colony ${opts.colony} (review off)`);
  return true;
}

/** Add `n` intents, one new file each, spread over `regions` directories (flood/rNN, a region each at depth 2). */
async function addIntents(cfg: LiveConfig, opts: FloodOptions, tag: string, log: (s: string) => void): Promise<number> {
  let next = 0;
  let made = 0;
  const worker = async (): Promise<void> => {
    while (next < opts.intents) {
      const i = next++;
      const path = `flood/r${String(i % opts.regions).padStart(2, "0")}/${tag}-${String(i).padStart(5, "0")}.txt`;
      const r = await admin(cfg, "POST", `/colonies/${opts.colony}/intents`, { title: `flood: add ${path}`, why: "flood scenario: one new file for an honest agent to land", footprint: [path], priority: 1, createdBy: "flood" });
      if (r.status === 201 || r.status === 200) made++;
    }
  };
  await Promise.all(Array.from({ length: 16 }, worker));
  log(`added ${made} of ${opts.intents} intents over ${opts.regions} regions`);
  if (made === 0) throw new Error("no intent could be added");
  return made;
}

/** FT_MCP_TOKEN from the environment, else from ~/.config/firetrident/env. */
function mcpToken(env: Record<string, string | undefined>): string | undefined {
  if (env.FT_MCP_TOKEN) return env.FT_MCP_TOKEN;
  try {
    return parseEnvFile(readFileSync(join(homedir(), ".config", "firetrident", "env"), "utf8")).FT_MCP_TOKEN;
  } catch {
    return undefined;
  }
}

/** Open a session and join the colony as `name`. */
async function joined(cfg: LiveConfig, token: string, colony: string, name: string): Promise<McpSession> {
  const s = new McpSession(cfg.url, token, name);
  await s.open();
  const j = await s.call<{ agentId?: string }>("join", { colony, name, model: "none" });
  if (!j.ok || !j.data?.agentId) throw new Error(`${name} could not join ${colony}: ${j.error?.message ?? "no agent id"}`);
  return s;
}

async function main(): Promise<void> {
  const opts = parseFloodOptions(process.argv.slice(2));
  const cfg = liveConfig(opts.url ? { ...process.env, FT_URL: opts.url } : process.env);
  if (!cfg.token) throw new Error("FT_ADMIN_TOKEN (or FT_TOKEN) is not set: the scenario creates its colony and intents with it");
  const token = mcpToken(process.env);
  if (!token) throw new Error("FT_MCP_TOKEN is not set (environment or ~/.config/firetrident/env)");
  if (new URL(cfg.url).host === PRODUCTION_HOST && !opts.allowProduction) throw new Error(`${cfg.url} is production: run the flood on a preview, or pass --allow-production`);
  const log = (s: string): void => console.error(`[${new Date().toISOString().slice(11, 19)}] ${s}`);
  const tag = `fl${Date.now().toString(36)}`;

  const createdColony = await ensureColony(cfg, opts, log);
  // Every session that opens, kept as it opens, so that a failed join still ends the others.
  const sessions: McpSession[] = [];
  const open = async (name: string): Promise<McpSession> => {
    const s = await joined(cfg, token, opts.colony, name);
    sessions.push(s);
    return s;
  };
  try {
    await addIntents(cfg, opts, tag, log);
    const honest = await Promise.all(Array.from({ length: opts.honest }, (_, i) => open(`flood-honest-${i + 1}`)));
    const propose = (await honest[0]!.tools()).get("propose") ?? [];
    if (!propose.includes("files")) throw new Error("this deployment does not offer inline changes (FT_INLINE): the honest agents propose files");
    const greedy = await Promise.all(Array.from({ length: opts.greedy }, (_, i) => open(`flood-greedy-${i + 1}`)));
    log(`${honest.length} honest and ${greedy.length} greedy sessions joined ${opts.colony}`);

    const start = Date.now();
    const timeline: Timeline = { start, floodAt: start + opts.baselineS * 1000, end: start + (opts.baselineS + opts.durationS) * 1000 };
    const drainUntil = timeline.end + opts.drainS * 1000;
    const h = new HonestTally();
    const g = new GreedyTally();
    const progress = setInterval(() => {
      const s = Math.round((Date.now() - start) / 1000);
      log(`${s} s: honest ${h.landings.length} landed, ${h.refused} refused; greedy ${g.calls} calls, ${g.refused} answered 429, ${g.answered} reached the colony`);
    }, 10_000);
    const flood = async (): Promise<void> => {
      await sleep(timeline.floodAt - Date.now());
      await Promise.all(greedy.flatMap((s) => Array.from({ length: opts.concurrency }, () => greedyLoop(s, opts.tool, timeline.end, g))));
    };
    const settled = await Promise.allSettled([...honest.map((s) => honestAgent(s, { until: timeline.end, drainUntil }, h)), flood()]);
    clearInterval(progress);
    const failed = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed) throw failed.reason;

    const report = floodReport({ opts, url: cfg.url, createdColony, timeline, honest: h, greedy: g });
    mkdirSync(dirname(opts.out) || ".", { recursive: true });
    writeFileSync(opts.out, `${JSON.stringify(report, null, 2)}\n`);
    const flooded = report.honest as { flood: PhaseStats };
    log(
      `honest: ${flooded.flood.landed} landed in the flood (${flooded.flood.landingsPerMin}/min, propose to landed p50 ${flooded.flood.proposeToLandedMs.p50 ?? "-"} ms), ${h.refused} refused; ` +
        `greedy: ${g.calls} calls, ${g.refused} answered 429, ${g.answered} reached the colony; wrote ${opts.out}`,
    );
  } finally {
    await Promise.all(sessions.map((s) => s.close()));
    if (createdColony && !opts.keep) {
      const del = await admin(cfg, "DELETE", `/colonies/${opts.colony}`).catch(() => null);
      log(`delete ${opts.colony}: ${del && del.status < 300 ? "ok" : `failed (${del?.status ?? "network"})`}`);
    }
  }
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
    console.error(redact(errorDetail(e)));
    process.exit(1);
  });
}
