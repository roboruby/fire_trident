import { checkFile, ruleApplies } from "@fire_trident/core";
import type { AgentKind, AgentState, CheckResult, FileVersion, Id, Intent, Path, Proposal, ProposalStatus, Rule, Sha, WorkspaceLease } from "@fire_trident/core";
import { agentIdentity, applyReplacement, changeSummary, cleanPath, commitMessage, decodeText, expandFootprint, isLiteralPath, recheck, ruleReplacement } from "./change.ts";
import { TreeIndex, applySpecifierEdits, isImportRule, parseSpecifierEdits, specifierFacts } from "./context.ts";
import { buildEditMessages, buildSpecifierMessages, maxTokensFor, parseFileReply, retryMessages, specifierRetryMessages, violationProblem } from "./prompt.ts";
import type { ChatMessage, TokenUsage } from "./prompt.ts";
import { TERMINAL_STATUSES, errorMessage, errorStatus } from "./rpc.ts";
import type { ColonyRpc, TakeResult } from "./rpc.ts";

/**
 * The in-platform agent loop as a journaled state machine.
 *
 * One job (an intent plus its workspace lease) moves through
 * fetch -> read -> produce -> commit -> push -> propose -> await. The job record is
 * written to the journal after every step (and after every file in `produce`), so an
 * agent that is killed resumes at the step it was in, keyed by intent id:
 * - fetch and read are reads and safe to repeat,
 * - produce keeps each finished file's new content, so no model call is repeated,
 * - commit uses the job's take time as the commit time, so a repeat yields the same sha,
 * - push force-pushes that same commit,
 * - propose first looks for a proposal it may already have made (inbox) before proposing.
 *
 * Nothing here touches Cloudflare APIs: the Durable Object injects the colony stub,
 * git, the model, the journal, and the clock.
 */

export type JobStep = "fetch" | "read" | "produce" | "commit" | "push" | "propose" | "await";
export type Outcome = "landed" | "returned" | "rejected" | "abandoned" | "timeout" | "lost";

/** Persistent configuration of one agent. `epoch` changes on every start/stop. */
export interface AgentConfig {
  colonyId: Id;
  agentId: Id;
  name: string;
  kind: AgentKind;
  model: string;
  running: boolean;
  epoch: number;
  startedAt: number;
  stoppedAt?: number;
  stopReason?: string;
  /** Consecutive failed takes (drives backoff). */
  failures: number;
  lastError?: string;
}

/** A file the job read at its base commit. */
export interface FileRead {
  path: Path;
  /** Blob id at the base, null when the path does not exist there. */
  blob: Sha | null;
  mode: string | null;
  size: number;
  /** False for binary content and non-regular files, which are never edited. */
  text: boolean;
}

/** The current unit of work, journaled after every step. */
export interface Job {
  intentId: Id;
  intent: Intent;
  lease: WorkspaceLease;
  rule: Rule | null;
  step: JobStep;
  /** Attempts at the current step (counted before running it, so a crash counts too). */
  attempts: number;
  takenAt: number;
  stepStartedAt: number;
  baseSha?: Sha;
  /** True when lease.baseSha was unreachable and the trunk tip was used instead. */
  baseFallback?: boolean;
  reads?: FileRead[];
  /** Paths whose outcome in `produce` is final (changed or left alone). */
  produced?: Path[];
  checks?: CheckResult[];
  llmCalls: number;
  method?: "replacement" | "model";
  headSha?: Sha;
  writeSet?: FileVersion[];
  summary?: string;
  /** Commit the change was built on: the lease base, or an equivalent trunk commit the workspace already holds. */
  parentSha?: Sha;
  /** Why that parent was chosen (telemetry). */
  parentHow?: string;
  /** Model usage of this job. */
  usage?: JobUsage;
  /** Git network cost of this job, by phase. */
  net?: { fetch?: NetStats; probe?: NetStats; push?: NetStats };
  proposalId?: Id;
  proposedAt?: number;
  pollMs?: number;
  lastStatus?: ProposalStatus;
  lastHeartbeatAt: number;
  lastError?: string;
  /** Times a step waited because the model provider throttled it (does not count as a failed attempt). */
  throttled?: number;
  /** Directory imports the agent rewrote to their index file, after checking the tree (for the evidence). */
  directoryRewrites?: string[];
  /** Imports that name a file beside a same-named directory (the file wins resolution), for the evidence. */
  fileOverDirectory?: string[];
}

/** Model calls, tokens and time spent by one job. */
export interface JobUsage {
  calls: number;
  input: number;
  output: number;
  cached: number;
  neurons: number;
  ms: number;
}

/** Bytes and time the git network calls cost (accumulated until taken). */
export interface NetStats {
  requests: number;
  sentBytes: number;
  receivedBytes: number;
  ms: number;
}

/** One finished job. */
export interface HistoryEntry {
  at: number;
  intentId: Id;
  title: string;
  outcome: Outcome;
  reason?: string;
  proposalId?: Id;
  headSha?: Sha;
  ms: number;
  llmCalls: number;
  method?: string;
  files: number;
  usage?: JobUsage;
  net?: Job["net"];
  parentHow?: string;
}

/** One journaled step. */
export interface StepLogEntry {
  at: number;
  intentId?: Id;
  step: string;
  ok: boolean;
  ms: number;
  detail?: string;
}

/** Durable state of one agent (SQLite in the Durable Object, memory in tests). */
export interface Journal {
  config(): AgentConfig | null;
  setConfig(c: AgentConfig): void;
  job(): Job | null;
  /** Replace the job; null clears it together with its changes. */
  setJob(j: Job | null): void;
  changes(): Array<{ path: Path; content: string }>;
  putChange(path: Path, content: string): void;
  log(e: StepLogEntry): void;
  finish(h: HistoryEntry): void;
  bump(counter: string, by?: number): void;
}

/** A file at the base commit. */
export interface BaseFile {
  blob: Sha;
  mode: string;
  bytes: Uint8Array;
}

/** Git operations on the agent's private clone. */
export interface GitOps {
  /** Make `baseSha` available locally (shallow), falling back to the trunk tip when it is unreachable. */
  ensureBase(p: { remote: string; token: string; baseSha: Sha }): Promise<{ baseSha: Sha; fallback: boolean }>;
  listFiles(baseSha: Sha): Promise<Path[]>;
  readFile(baseSha: Sha, path: Path): Promise<BaseFile | null>;
  commit(p: {
    baseSha: Sha;
    changes: Array<{ path: Path; content: string }>;
    message: string;
    author: { name: string; email: string };
    /** Unix seconds; fixed per job so a repeated commit has the same id. */
    timestamp: number;
  }): Promise<{ headSha: Sha; writeSet: FileVersion[] }>;
  /** Force-push `headSha` to `main` of the workspace. Throws `[ft:401]`/`[ft:403]` when the token is refused. */
  push(p: { remote: string; token: string; headSha: Sha }): Promise<void>;
  /** The commit `main` of a remote repo points at (optional: lets a change be built on what the workspace holds). */
  remoteHead?(p: { remote: string; token: string }): Promise<Sha | null>;
  /** Fetch one trunk commit by id; true when it is present afterwards. */
  fetchCommit?(p: { remote: string; token: string; sha: Sha }): Promise<boolean>;
  /** Parents of a local commit and whether an in-platform agent made it (null when absent). */
  commitInfo?(sha: Sha): Promise<{ parents: Sha[]; byAgent: boolean } | null>;
  /** Blob id of each path at a local commit (null when absent). */
  blobsAt?(sha: Sha, paths: Path[]): Promise<Map<Path, Sha | null>>;
  /** Network cost since the last call (then reset). */
  takeNetStats?(): NetStats;
}

/** A model reply. */
export interface ModelReply {
  text: string | null;
  finishReason?: string;
  usage?: TokenUsage;
  /** Wall time of the call. */
  ms?: number;
}

/** Text generation, whichever provider serves the model. */
export interface ModelClient {
  complete(p: { model: string; messages: ChatMessage[]; maxTokens: number }): Promise<ModelReply>;
}

/** Everything the loop needs. */
export interface LoopDeps {
  colony: ColonyRpc;
  git: GitOps;
  model: ModelClient;
  journal: Journal;
  now(): number;
  rand?(): number;
  /** Optional sink for one-line progress logs (failures and outcomes). */
  log?(line: string): void;
  /** Optional sink for one structured record per finished job (telemetry). */
  metric?(record: Record<string, unknown>): void;
  /** Current trunk blobs (TrunkDO.blobsFor); lets a job reuse a base the workspace already holds. */
  trunk?: { blobsFor(paths: Path[]): Promise<Record<Path, Sha | null>> };
}

export const MAX_STEP_ATTEMPTS = 4;
export const HEARTBEAT_EVERY_MS = 45_000;
export const FIRST_POLL_MS = 1_500;
export const MAX_POLL_MS = 5_000;
export const ESCALATED_POLL_MS = 30_000;
export const AWAIT_TIMEOUT_MS = 30 * 60_000;
export const ABANDON_PAUSE_MS = 3_000;
export const DEFAULT_TICK_BUDGET_MS = 4 * 60_000;
/** Files one job reads at most. */
export const MAX_FILES = 20;
/** Largest file a model is asked to rewrite (characters). */
export const MAX_MODEL_CHARS = 120_000;
/** Largest file the deterministic replacement edits (characters; journal rows stay under 2 MB). */
export const MAX_EDIT_CHARS = 1_500_000;
/** Output budget of one specifier-edit call: the reply is a few lines, the rest is room for reasoning. */
export const SPECIFIER_MAX_TOKENS = 8_192;
const TOKEN_SLACK_MS = 10_000;
const MIN_WAIT_MS = 200;
const MAX_WAIT_MS = 60_000;

/** Thrown when the agent was stopped or restarted while a step was running. */
export class Halt extends Error {
  constructor() {
    super("agent stopped");
    this.name = "Halt";
  }
}

interface StepResult {
  sleepMs: number;
  stop?: boolean;
}

/** The AgentInfo state for a configuration and job. */
export function agentState(cfg: AgentConfig | null, job: Job | null): AgentState {
  if (cfg && !cfg.running && cfg.stoppedAt !== undefined) return "dead";
  if (!job) return "idle";
  if (job.step === "propose") return "proposing";
  if (job.step === "await") return "waiting";
  return "working";
}

/** Exponential backoff with +-25% jitter: 1 s, 2 s, 4 s, ... capped at 60 s. */
export function backoffMs(attempt: number, rand: () => number = Math.random): number {
  const base = Math.min(MAX_WAIT_MS, 1000 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.75 + rand() * 0.5));
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo));
}

function guard(deps: LoopDeps, epoch: number): AgentConfig {
  const c = deps.journal.config();
  if (!c || !c.running || c.epoch !== epoch) throw new Halt();
  return c;
}

function save(deps: LoopDeps, cfg: AgentConfig, job: Job): void {
  guard(deps, cfg.epoch);
  deps.journal.setJob(job);
}

function advance(deps: LoopDeps, cfg: AgentConfig, job: Job, step: JobStep): StepResult {
  job.step = step;
  job.attempts = 0;
  job.stepStartedAt = deps.now();
  delete job.lastError;
  save(deps, cfg, job);
  return { sleepMs: 0 };
}

/** Is this error the colony telling us it, or this agent, no longer exists? */
function isGone(err: unknown): boolean {
  return errorStatus(err) === 404 && /unknown agent|colony not found/i.test(errorMessage(err));
}

/**
 * Run steps until one asks to sleep, the agent stops, or the time budget is spent.
 * Returns how long to sleep before the next tick (0 = continue now), or null when
 * the agent is not running. Never throws for step failures; they are journaled and
 * retried with backoff.
 */
export async function tick(deps: LoopDeps, budgetMs = DEFAULT_TICK_BUDGET_MS): Promise<{ sleepMs: number | null }> {
  const started = deps.now();
  const first = deps.journal.config();
  if (!first || !first.running) return { sleepMs: null };
  try {
    for (;;) {
      const cfg = guard(deps, first.epoch);
      const r = await stepOnce(deps, cfg);
      if (r.stop) return { sleepMs: null };
      if (r.sleepMs > 0) return { sleepMs: r.sleepMs };
      if (deps.now() - started >= budgetMs) return { sleepMs: 0 };
    }
  } catch (e) {
    if (e instanceof Halt) return { sleepMs: null };
    throw e;
  }
}

async function stepOnce(deps: LoopDeps, cfg: AgentConfig): Promise<StepResult> {
  const job = deps.journal.job();
  if (!job) return takeWork(deps, cfg);
  if (job.attempts >= MAX_STEP_ATTEMPTS) {
    return abandon(deps, cfg, job, `gave up at ${job.step} after ${job.attempts} attempts: ${job.lastError ?? "interrupted"}`);
  }
  job.attempts += 1;
  save(deps, cfg, job);
  await maybeHeartbeat(deps, cfg, job);
  const step = job.step;
  const t0 = deps.now();
  try {
    const r = await runStep(deps, cfg, job);
    deps.journal.log({ at: deps.now(), intentId: job.intentId, step, ok: true, ms: deps.now() - t0 });
    return r;
  } catch (e) {
    if (e instanceof Halt) throw e;
    const msg = errorMessage(e);
    deps.journal.log({ at: deps.now(), intentId: job.intentId, step, ok: false, ms: deps.now() - t0, detail: msg });
    if (errorStatus(e) === 429) return throttled(deps, cfg, job, msg);
    deps.journal.bump("errors");
    deps.log?.(`${step} failed (attempt ${job.attempts}) on ${job.intentId}: ${msg}`);
    if (isGone(e)) return halt(deps, cfg, msg);
    const fresh = deps.journal.job();
    if (fresh && fresh.intentId === job.intentId) {
      fresh.lastError = msg;
      save(deps, cfg, fresh);
    }
    return { sleepMs: backoffMs(job.attempts, deps.rand) };
  }
}

/** Throttled waits one job may take before it gives its intent back (about half an hour). */
export const MAX_THROTTLED = 40;

/** Wait after the n-th throttle: 4 s, 8 s, 16 s, 32 s, then 60 s, each +-50% so agents spread out. */
export function throttleWaitMs(n: number, rand: () => number = Math.random): number {
  const base = Math.min(MAX_WAIT_MS, 4_000 * 2 ** (Math.min(Math.max(n, 1), 5) - 1));
  return Math.round(base * (0.5 + rand()));
}

/**
 * The model provider throttled a step (rate limit or no capacity). That is not the
 * agent's failure: the attempt is given back and the step waits with jittered
 * backoff. Only a job throttled MAX_THROTTLED times gives its intent back.
 */
async function throttled(deps: LoopDeps, cfg: AgentConfig, job: Job, msg: string): Promise<StepResult> {
  deps.journal.bump("throttled");
  const fresh = deps.journal.job();
  if (!fresh || fresh.intentId !== job.intentId) return { sleepMs: throttleWaitMs(1, deps.rand) };
  fresh.throttled = (fresh.throttled ?? 0) + 1;
  fresh.attempts = Math.max(0, fresh.attempts - 1);
  fresh.lastError = msg;
  save(deps, cfg, fresh);
  if (fresh.throttled > MAX_THROTTLED) return abandon(deps, cfg, fresh, `the model stayed throttled through ${MAX_THROTTLED} waits: ${msg}`);
  return { sleepMs: throttleWaitMs(fresh.throttled, deps.rand) };
}

async function runStep(deps: LoopDeps, cfg: AgentConfig, job: Job): Promise<StepResult> {
  switch (job.step) {
    case "fetch":
      return fetchStep(deps, cfg, job);
    case "read":
      return readStep(deps, cfg, job);
    case "produce":
      return produceStep(deps, cfg, job);
    case "commit":
      return commitStep(deps, cfg, job);
    case "push":
      return pushStep(deps, cfg, job);
    case "propose":
      return proposeStep(deps, cfg, job);
    case "await":
      return awaitStep(deps, cfg, job);
  }
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

async function takeWork(deps: LoopDeps, cfg: AgentConfig): Promise<StepResult> {
  const t0 = deps.now();
  let res: TakeResult;
  try {
    res = await deps.colony.take(cfg.agentId);
  } catch (e) {
    if (e instanceof Halt) throw e;
    const msg = errorMessage(e);
    deps.journal.log({ at: deps.now(), step: "take", ok: false, ms: deps.now() - t0, detail: msg });
    deps.journal.bump("errors");
    deps.log?.(`take failed: ${msg}`);
    if (isGone(e)) return halt(deps, cfg, msg);
    const c = guard(deps, cfg.epoch);
    c.failures += 1;
    c.lastError = msg;
    deps.journal.setConfig(c);
    return { sleepMs: backoffMs(c.failures, deps.rand) };
  }
  const c = guard(deps, cfg.epoch);
  if (c.failures !== 0) {
    c.failures = 0;
    deps.journal.setConfig(c);
  }
  if ("wait" in res) {
    deps.journal.bump("waits");
    deps.journal.log({ at: deps.now(), step: "take", ok: true, ms: deps.now() - t0, detail: `wait: ${res.reason}` });
    return { sleepMs: clamp(res.retryInMs, MIN_WAIT_MS, MAX_WAIT_MS) };
  }
  if (!res.intent?.id || !res.lease?.repo || !res.lease.trunk) {
    deps.journal.log({ at: deps.now(), step: "take", ok: false, ms: deps.now() - t0, detail: "malformed assignment" });
    return { sleepMs: backoffMs(1, deps.rand) };
  }
  let rule: Rule | null = res.rule ?? null;
  if (!rule && res.intent.ruleId) {
    try {
      rule = await deps.colony.getRule(res.intent.ruleId);
    } catch (e) {
      if (e instanceof Halt) throw e;
    }
  }
  const now = deps.now();
  save(deps, cfg, {
    intentId: res.intent.id,
    intent: res.intent,
    lease: res.lease,
    rule,
    step: "fetch",
    attempts: 0,
    takenAt: now,
    stepStartedAt: now,
    llmCalls: 0,
    lastHeartbeatAt: now,
  });
  deps.journal.bump("taken");
  deps.journal.log({ at: now, intentId: res.intent.id, step: "take", ok: true, ms: now - t0 });
  return { sleepMs: 0 };
}

async function fetchStep(deps: LoopDeps, cfg: AgentConfig, job: Job): Promise<StepResult> {
  deps.git.takeNetStats?.();
  const reuse = await workspaceBase(deps, job);
  if (reuse) {
    job.baseSha = reuse.sha;
    job.parentSha = reuse.sha;
    job.parentHow = reuse.how;
  } else {
    const r = await deps.git.ensureBase({ remote: job.lease.trunk.remote, token: job.lease.trunk.token, baseSha: job.lease.baseSha });
    job.baseSha = r.baseSha;
    if (r.fallback) job.baseFallback = true;
  }
  const net = deps.git.takeNetStats?.();
  if (net) job.net = { ...job.net, fetch: net };
  return advance(deps, cfg, job, "read");
}

/**
 * The trunk commit the leased workspace already holds, when this job can work on it:
 * the base behind this agent's last push there (lease affinity), or the seed a fresh
 * workspace was forked from. The work is valid there when every footprint path has
 * the same blob as current trunk (one TrunkDO.blobsFor call); the lane re-checks that
 * against trunk before landing anyway. Building on it means no fetch at all when the
 * clone already has it (the git server sends whole trees, whatever the client holds)
 * and a push of only the new objects. Null: fetch the lease base as usual.
 */
async function workspaceBase(deps: LoopDeps, job: Job): Promise<{ sha: Sha; how: string } | null> {
  const g = deps.git;
  if (!deps.trunk || !g.remoteHead || !g.commitInfo || !g.blobsAt || !g.fetchCommit) return null;
  const footprint = job.intent.footprint ?? [];
  if (footprint.length === 0 || !footprint.every(isLiteralPath)) return null;
  const paths = [...new Set(footprint.map(cleanPath))];
  try {
    const tip = await g.remoteHead({ remote: job.lease.repo.remote, token: job.lease.token });
    if (!tip) return null;
    let info = await g.commitInfo(tip);
    let fetched = false;
    if (!info) {
      // A fresh workspace sits at its seed, a trunk commit. Fetch it from the workspace itself: the same bytes as
      // fetching the lease base from trunk, but a swarm starting at once spreads over its workspaces, not one trunk repo.
      if (!(await g.fetchCommit({ remote: job.lease.repo.remote, token: job.lease.token, sha: tip }))) return null;
      fetched = true;
      info = await g.commitInfo(tip);
      if (!info) return null;
    }
    const candidate = info.byAgent ? (info.parents[0] ?? null) : tip;
    if (candidate === null) return null;
    const cinfo = candidate === tip ? info : await g.commitInfo(candidate);
    if (!cinfo || cinfo.byAgent) return null;
    const [current, have] = await Promise.all([deps.trunk.blobsFor(paths), g.blobsAt(candidate, paths)]);
    for (const p of paths) if ((current[p] ?? null) !== (have.get(p) ?? null)) return null;
    return { sha: candidate, how: info.byAgent ? "base of the workspace's last push" : fetched ? "workspace seed (fetched)" : "workspace tip" };
  } catch (e) {
    if (e instanceof Halt) throw e;
    return null;
  }
}

async function readStep(deps: LoopDeps, cfg: AgentConfig, job: Job): Promise<StepResult> {
  const baseSha = requireBase(job);
  const footprint = job.intent.footprint ?? [];
  const listing = footprint.some((e) => !isLiteralPath(e)) ? await deps.git.listFiles(baseSha) : null;
  let paths = expandFootprint(footprint, listing, MAX_FILES * 4);
  const rule = job.rule;
  if (rule) paths = paths.filter((p) => ruleApplies(rule, p));
  paths = paths.slice(0, MAX_FILES);
  if (paths.length === 0) return abandon(deps, cfg, job, "the footprint names no file this agent can edit");
  const reads: FileRead[] = [];
  for (const path of paths) {
    const f = await deps.git.readFile(baseSha, path);
    if (!f) {
      reads.push({ path, blob: null, mode: null, size: 0, text: true });
      continue;
    }
    const regular = f.mode === "100644" || f.mode === "100755";
    reads.push({ path, blob: f.blob, mode: f.mode, size: f.bytes.length, text: regular && decodeText(f.bytes) !== null });
  }
  job.reads = reads;
  return advance(deps, cfg, job, "produce");
}

type FileOutcome = { kind: "change"; content: string } | { kind: "skip" } | { kind: "abandon"; reason: string };

async function produceStep(deps: LoopDeps, cfg: AgentConfig, job: Job): Promise<StepResult> {
  const baseSha = requireBase(job);
  const done = new Set(job.produced ?? []);
  // The base tree's listing, read once per step and only when a file needs it.
  let tree: TreeIndex | null = null;
  const treeAt = async (): Promise<TreeIndex> => (tree ??= new TreeIndex(await deps.git.listFiles(baseSha)));
  for (const f of job.reads ?? []) {
    if (done.has(f.path)) continue;
    const out = await produceFile(deps, cfg, job, baseSha, f, treeAt);
    if (out.kind === "abandon") return abandon(deps, cfg, job, out.reason);
    guard(deps, cfg.epoch);
    if (out.kind === "change") deps.journal.putChange(f.path, out.content);
    done.add(f.path);
    job.produced = [...done];
    save(deps, cfg, job);
  }
  const changed = deps.journal.changes().map((c) => c.path);
  if (changed.length === 0) return abandon(deps, cfg, job, "no change needed: the files already satisfy the intent");
  job.summary = changeSummary(job.intent, changed, job.method === "replacement" ? "applied the rule's replacement" : "edited with a model");
  return advance(deps, cfg, job, "commit");
}

async function produceFile(deps: LoopDeps, cfg: AgentConfig, job: Job, baseSha: Sha, f: FileRead, treeAt: () => Promise<TreeIndex>): Promise<FileOutcome> {
  if (!f.text) return { kind: "skip" };
  let original: string | null = null;
  if (f.blob !== null) {
    const file = await deps.git.readFile(baseSha, f.path);
    if (!file) throw new Error(`${f.path} is missing from the local clone of ${baseSha}`);
    original = decodeText(file.bytes);
    if (original === null) return { kind: "skip" };
  }
  const rule = job.rule;
  if (rule) {
    if (original === null) return { kind: "skip" };
    const before = checkFile(rule, f.path, original);
    if (before.length === 0) return { kind: "skip" };
    if (cfg.kind === "synthetic" && ruleReplacement(rule) !== null) {
      if (original.length > MAX_EDIT_CHARS) return { kind: "abandon", reason: `${f.path} is too large to edit (${original.length} characters)` };
      const t0 = deps.now();
      const updated = applyReplacement(rule, original);
      const rc = recheck(rule, f.path, original, updated);
      addCheck(job, { name: `recheck ${f.path}`, ok: rc.ok, ms: deps.now() - t0, detail: `${rc.before} -> ${rc.after} violations (deterministic replacement)` });
      job.method = "replacement";
      if (!rc.ok) return { kind: "abandon", reason: `the rule's replacement leaves ${rc.after} violation(s) in ${f.path}` };
      return updated === original ? { kind: "skip" } : { kind: "change", content: updated };
    }
    if (isImportRule(rule)) {
      const r = await specifierEdit(deps, cfg, job, f.path, original, await treeAt());
      if (!r.ok) return { kind: "abandon", reason: r.reason };
      return r.content === original ? { kind: "skip" } : { kind: "change", content: r.content };
    }
    const r = await modelEdit(deps, cfg, job, f.path, original, before);
    if (!r.ok) return { kind: "abandon", reason: r.reason };
    return r.content === original ? { kind: "skip" } : { kind: "change", content: r.content };
  }
  const r = await modelEdit(deps, cfg, job, f.path, original, []);
  if (!r.ok) return { kind: "abandon", reason: r.reason };
  return r.content === (original ?? "") ? { kind: "skip" } : { kind: "change", content: r.content };
}

function addCheck(job: Job, c: CheckResult): void {
  job.checks = [...(job.checks ?? []).filter((x) => x.name !== c.name), c];
}

type Verdict = { ok: true; content: string; detail: string } | { ok: false; problem: string };

/** Accept or reject one model reply for one file. */
export function judgeReply(rule: Rule | null, path: Path, original: string | null, text: string, finishReason?: string): Verdict {
  if (finishReason === "length" && !text.includes("</file>")) {
    return { ok: false, problem: "the reply was cut off before </file>; return the complete file and nothing else" };
  }
  const parsed = parseFileReply(text, original);
  if (!parsed.ok) return { ok: false, problem: parsed.reason };
  if (rule && original !== null) {
    const rc = recheck(rule, path, original, parsed.content);
    if (!rc.ok) return { ok: false, problem: violationProblem(path, rc.remaining) };
    return { ok: true, content: parsed.content, detail: `${rc.before} -> 0 violations` };
  }
  return { ok: true, content: parsed.content, detail: "no rule to re-check" };
}

async function modelEdit(
  deps: LoopDeps,
  cfg: AgentConfig,
  job: Job,
  path: Path,
  original: string | null,
  violations: ReturnType<typeof checkFile>,
): Promise<{ ok: true; content: string } | { ok: false; reason: string }> {
  if (original !== null && original.length > MAX_MODEL_CHARS) {
    return { ok: false, reason: `${path} is too large to rewrite with a model (${original.length} characters)` };
  }
  const first = buildEditMessages({ intent: job.intent, rule: job.rule, path, content: original, violations });
  const maxTokens = maxTokensFor(original);
  let messages = first;
  let problem = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    await maybeHeartbeat(deps, cfg, job);
    const t0 = deps.now();
    const reply = await deps.model.complete({ model: cfg.model, messages, maxTokens });
    countCall(deps, cfg, job, reply, deps.now() - t0);
    const text = reply.text ?? "";
    const v = judgeReply(job.rule, path, original, text, reply.finishReason);
    if (v.ok) {
      addCheck(job, { name: `recheck ${path}`, ok: true, ms: deps.now() - t0, detail: `${v.detail} (model ${cfg.model}, attempt ${attempt + 1})` });
      return { ok: true, content: v.content };
    }
    problem = v.problem;
    messages = retryMessages(first, text, problem);
  }
  addCheck(job, { name: `recheck ${path}`, ok: false, ms: 0, detail: problem });
  return { ok: false, reason: `the model did not produce a valid change for ${path}: ${problem}` };
}

/** Book one model call on the job (calls, tokens, time) and in the agent's counters. */
function countCall(deps: LoopDeps, cfg: AgentConfig, job: Job, reply: ModelReply, ms: number): void {
  job.llmCalls += 1;
  job.method = "model";
  const u = job.usage ?? { calls: 0, input: 0, output: 0, cached: 0, neurons: 0, ms: 0 };
  u.calls += 1;
  u.ms += reply.ms ?? ms;
  if (reply.usage) {
    u.input += reply.usage.input;
    u.output += reply.usage.output;
    u.cached += reply.usage.cached;
    u.neurons += reply.usage.neurons;
    deps.journal.bump("tokensIn", reply.usage.input);
    deps.journal.bump("tokensOut", reply.usage.output);
  }
  job.usage = u;
  save(deps, cfg, job);
  deps.journal.bump("llmCalls");
}

/**
 * Fix an import rule's violations in one file by asking the model only for
 * specifier rewrites (see context.ts): it sees the flagged lines, what the trunk
 * tree holds for each specifier, and the sibling listings. The agent applies the
 * rewrites itself, then re-checks with the rule and verifies every new path
 * exists. One retry with the problems as feedback; otherwise the file is given up.
 */
async function specifierEdit(
  deps: LoopDeps,
  cfg: AgentConfig,
  job: Job,
  path: Path,
  original: string,
  tree: TreeIndex,
): Promise<{ ok: true; content: string } | { ok: false; reason: string }> {
  const rule = job.rule;
  if (!rule) return { ok: false, reason: "no rule" };
  const facts = specifierFacts(rule, path, original, tree);
  if (facts.length === 0) return { ok: true, content: original };
  const first = buildSpecifierMessages({ intent: job.intent, rule, path, content: original, facts, tree });
  let messages = first;
  let problems: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    await maybeHeartbeat(deps, cfg, job);
    const t0 = deps.now();
    const reply = await deps.model.complete({ model: cfg.model, messages, maxTokens: SPECIFIER_MAX_TOKENS });
    countCall(deps, cfg, job, reply, deps.now() - t0);
    const text = reply.text ?? "";
    const parsed = parseSpecifierEdits(text);
    if (!parsed.ok) {
      problems = [reply.finishReason === "length" ? "the reply was cut off before </edits>; reply with only the <edits> block" : parsed.reason];
    } else {
      const applied = applySpecifierEdits(rule, path, original, facts, parsed.edits, tree);
      if (applied.problems.length === 0) {
        const rc = recheck(rule, path, original, applied.content);
        const dirs = applied.rewrites.filter((r) => r.directory).map((r) => `${r.from} -> ${r.to}`);
        if (dirs.length > 0) job.directoryRewrites = [...new Set([...(job.directoryRewrites ?? []), ...dirs])];
        const beside = applied.rewrites.filter((r) => r.besideDirectory).map((r) => `${r.from} -> ${r.to}`);
        if (beside.length > 0) job.fileOverDirectory = [...new Set([...(job.fileOverDirectory ?? []), ...beside])];
        addCheck(job, {
          name: `recheck ${path}`,
          ok: rc.ok,
          ms: deps.now() - t0,
          detail: `${rc.before} -> ${rc.after} violations; ${applied.changed} specifier(s) rewritten, every new path exists in trunk (model ${cfg.model}, attempt ${attempt + 1})`,
        });
        return { ok: true, content: applied.content };
      }
      problems = applied.problems;
    }
    messages = specifierRetryMessages(first, text, problems);
  }
  const why = problems.join("; ");
  addCheck(job, { name: `recheck ${path}`, ok: false, ms: 0, detail: why.slice(0, 500) });
  return { ok: false, reason: `the model did not produce a valid change for ${path}: ${why}` };
}

async function commitStep(deps: LoopDeps, cfg: AgentConfig, job: Job): Promise<StepResult> {
  const changes = deps.journal.changes().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (changes.length === 0) return abandon(deps, cfg, job, "nothing to commit");
  // The clone lives in durable storage, but make sure the base is still there after a restart.
  const base = await deps.git.ensureBase({ remote: job.lease.trunk.remote, token: job.lease.trunk.token, baseSha: requireBase(job) });
  if (base.baseSha !== job.baseSha) throw new Error(`base ${job.baseSha} is no longer reachable`);
  if (!job.parentSha) {
    deps.git.takeNetStats?.();
    const paths = [...new Set([...changes.map((c) => c.path), ...(job.reads ?? []).map((f) => f.path)])];
    const choice = await chooseParent(deps, job, paths);
    job.parentSha = choice.parent;
    job.parentHow = choice.how;
    const probe = deps.git.takeNetStats?.();
    if (probe && probe.requests > 0) job.net = { ...job.net, probe };
    save(deps, cfg, job);
  }
  const r = await deps.git.commit({
    baseSha: job.parentSha,
    changes,
    message: commitMessage(job.intent, cfg.agentId),
    author: agentIdentity(cfg.agentId),
    timestamp: Math.floor(job.takenAt / 1000),
  });
  job.headSha = r.headSha;
  job.writeSet = r.writeSet;
  return advance(deps, cfg, job, "push");
}

/**
 * The commit to build the change on. A pooled workspace already holds some trunk
 * commit: the seed it was forked from, or (behind this agent's own last push) the
 * base of that push. When every path this job read or wrote has the same blob
 * there as at the lease base, building on that commit makes the push carry only
 * the new objects (a commit, the trees on the changed paths, the new blobs)
 * instead of the whole tree. The lane's optimistic concurrency check compares
 * those paths with current trunk either way, so the older parent is just as valid.
 * Falls back to the lease base whenever anything is uncertain.
 */
export async function chooseParent(deps: Pick<LoopDeps, "git">, job: Job, paths: Path[]): Promise<{ parent: Sha; how: string }> {
  const leaseBase = requireBase(job);
  const g = deps.git;
  if (!g.remoteHead || !g.commitInfo || !g.blobsAt) return { parent: leaseBase, how: "lease base" };
  let tip: Sha | null;
  try {
    tip = await g.remoteHead({ remote: job.lease.repo.remote, token: job.lease.token });
  } catch {
    return { parent: leaseBase, how: "lease base (workspace refs unreadable)" };
  }
  if (tip === null) return { parent: leaseBase, how: "lease base (empty workspace)" };
  if (tip === leaseBase) return { parent: leaseBase, how: "lease base (workspace at base)" };
  let info = await g.commitInfo(tip);
  if (!info && g.fetchCommit) {
    // A fresh workspace sits at its seed, a trunk commit that trunk serves cheaply.
    if (await g.fetchCommit({ remote: job.lease.trunk.remote, token: job.lease.trunk.token, sha: tip })) info = await g.commitInfo(tip);
  }
  if (!info) return { parent: leaseBase, how: "lease base (workspace tip unknown)" };
  // Behind an agent commit sits the trunk commit it was built on.
  const candidate = info.byAgent ? (info.parents[0] ?? null) : tip;
  if (candidate === null || candidate === leaseBase) return { parent: leaseBase, how: "lease base" };
  const cinfo = info.byAgent ? await g.commitInfo(candidate) : info;
  if (!cinfo || cinfo.byAgent) return { parent: leaseBase, how: "lease base (workspace base unknown)" };
  const [want, have] = await Promise.all([g.blobsAt(leaseBase, paths), g.blobsAt(candidate, paths)]);
  for (const p of paths) {
    if ((want.get(p) ?? null) !== (have.get(p) ?? null)) return { parent: leaseBase, how: "lease base (files differ in the workspace)" };
  }
  return { parent: candidate, how: info.byAgent ? "base of the workspace's last push" : "workspace tip" };
}

async function pushStep(deps: LoopDeps, cfg: AgentConfig, job: Job): Promise<StepResult> {
  if (deps.now() > job.lease.tokenExpiresAt - TOKEN_SLACK_MS) return abandon(deps, cfg, job, "the workspace token expired before the push");
  deps.git.takeNetStats?.();
  try {
    await deps.git.push({ remote: job.lease.repo.remote, token: job.lease.token, headSha: requireHead(job) });
  } catch (e) {
    const status = errorStatus(e);
    if (status === 401 || status === 403) return abandon(deps, cfg, job, `the workspace refused the push: ${errorMessage(e)}`);
    throw e;
  }
  const net = deps.git.takeNetStats?.();
  if (net) {
    job.net = { ...job.net, push: net };
    deps.journal.bump("pushBytes", net.sentBytes);
  }
  deps.journal.bump("pushed");
  return advance(deps, cfg, job, "propose");
}

function kb(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${(bytes / 1024).toFixed(1)} KB`;
}

/** Telemetry checks for the evidence: model usage and git transfer (only what was measured). */
function telemetryChecks(cfg: AgentConfig, job: Job): CheckResult[] {
  const out: CheckResult[] = [];
  const u = job.usage;
  if (u && (u.input > 0 || u.output > 0)) {
    out.push({
      name: "agent model usage",
      ok: true,
      ms: u.ms,
      detail: `${cfg.model}: ${u.calls} call(s), ${u.input} input / ${u.output} output tokens${u.cached ? ` (${u.cached} cached)` : ""}${u.neurons ? `, ${u.neurons.toFixed(1)} neurons` : ""}`,
    });
  }
  const n = job.net;
  if (n && (n.fetch || n.push)) {
    const parts: string[] = [];
    if (n.fetch) parts.push(`fetch ${kb(n.fetch.receivedBytes)} down`);
    if (n.probe) parts.push(`workspace probe ${n.probe.requests} request(s)`);
    if (n.push) parts.push(`push ${kb(n.push.sentBytes)} up`);
    if (job.parentHow) parts.push(`built on ${job.parentHow}`);
    out.push({ name: "agent git transfer", ok: true, ms: (n.fetch?.ms ?? 0) + (n.probe?.ms ?? 0) + (n.push?.ms ?? 0), detail: parts.join("; ") });
  }
  return out;
}

async function proposeStep(deps: LoopDeps, cfg: AgentConfig, job: Job): Promise<StepResult> {
  const headSha = requireHead(job);
  let proposal: Proposal | undefined;
  if (job.attempts > 1) {
    // A previous attempt may have reached the colony before it was journaled.
    const recent = await deps.colony.inbox(cfg.agentId, 20);
    proposal = recent.find((p) => p.intentId === job.intentId && p.headSha === headSha);
  }
  if (!proposal) {
    const readSet: FileVersion[] = (job.reads ?? []).filter((f) => f.text).map((f) => ({ path: f.path, blob: f.blob }));
    // Reviewers read the start of this statement (the decide stream's second opinion keeps 400 characters),
    // so for import rules it leads with what was and was not checked, naming any directory rewrites.
    const importEdit = isImportRule(job.rule) && job.method === "model";
    const dirs = job.directoryRewrites ?? [];
    const notVerified = [
      importEdit
        ? `No tests, type checks or builds were run. Checked by the agent against the trunk tree: the rule reports 0 violations after the edit; every rewritten import names an existing file, the one TypeScript resolved before (x.ts before x/index.ts)${
            dirs.length > 0 ? `; directories name their index file: ${dirs.slice(0, 2).join(", ")}` : ""
          }${(job.fileOverDirectory ?? []).length > 0 ? `; a file beats the same-named directory: ${(job.fileOverDirectory ?? []).slice(0, 2).join(", ")}` : ""}. Edited by model ${cfg.model}.`
        : job.method === "replacement"
          ? "Deterministic replacement re-checked against the rule only."
          : `Edited by model ${cfg.model}; re-checked against the rule only.`,
      importEdit ? "" : "No tests, type checks or builds were run by the agent.",
      job.baseFallback ? `Based on trunk ${job.baseSha} because the leased base was unreachable.` : "",
      job.parentSha && job.parentSha !== job.baseSha ? `Built on trunk ${job.parentSha} (already in the workspace), where every file read or written matches the leased base ${job.baseSha}.` : "",
      !job.baseFallback && job.baseSha && job.baseSha !== job.lease.baseSha && job.parentSha === job.baseSha
        ? `Based on trunk ${job.baseSha}, which the workspace already held; every footprint file matched current trunk when the work started.`
        : "",
    ]
      .filter(Boolean)
      .join(" ");
    proposal = await deps.colony.propose({
      colonyId: cfg.colonyId,
      intentId: job.intentId,
      agentId: cfg.agentId,
      workspace: job.lease.repo,
      baseSha: job.parentSha ?? requireBase(job),
      headSha,
      writeSet: job.writeSet ?? [],
      readSet,
      declared: { footprint: job.intent.footprint, summary: job.summary ?? job.intent.title },
      evidence: { checks: [...(job.checks ?? []), ...telemetryChecks(cfg, job)], notVerified },
    });
    deps.journal.bump("proposed");
  }
  job.proposalId = proposal.id;
  job.proposedAt = deps.now();
  job.pollMs = FIRST_POLL_MS;
  job.lastStatus = proposal.status;
  if (TERMINAL_STATUSES.has(proposal.status)) return finishJob(deps, cfg, job, proposal.status as Outcome, proposal.reason);
  advance(deps, cfg, job, "await");
  return { sleepMs: FIRST_POLL_MS };
}

async function awaitStep(deps: LoopDeps, cfg: AgentConfig, job: Job): Promise<StepResult> {
  const id = job.proposalId;
  if (!id) throw new Error("await without a proposal id");
  const p = await deps.colony.getProposal(id);
  if (!p) return finishJob(deps, cfg, job, "lost", "the colony no longer knows this proposal");
  if (TERMINAL_STATUSES.has(p.status)) return finishJob(deps, cfg, job, p.status as Outcome, p.reason);
  const now = deps.now();
  if (now - (job.proposedAt ?? now) > AWAIT_TIMEOUT_MS) return finishJob(deps, cfg, job, "timeout", `still ${p.status} after ${AWAIT_TIMEOUT_MS / 60_000} minutes`);
  const prev = job.pollMs ?? FIRST_POLL_MS;
  job.pollMs = p.status === "escalated" ? ESCALATED_POLL_MS : Math.min(MAX_POLL_MS, Math.round(prev * 1.6));
  job.lastStatus = p.status;
  job.attempts = 0;
  save(deps, cfg, job);
  return { sleepMs: job.pollMs };
}

// ---------------------------------------------------------------------------
// Endings
// ---------------------------------------------------------------------------

function finishJob(deps: LoopDeps, cfg: AgentConfig, job: Job, outcome: Outcome, reason?: string): StepResult {
  guard(deps, cfg.epoch);
  const now = deps.now();
  const entry: HistoryEntry = {
    at: now,
    intentId: job.intentId,
    title: job.intent.title,
    outcome,
    ms: now - job.takenAt,
    llmCalls: job.llmCalls,
    files: job.writeSet?.length ?? 0,
  };
  if (reason) entry.reason = reason;
  if (job.proposalId) entry.proposalId = job.proposalId;
  if (job.headSha) entry.headSha = job.headSha;
  if (job.method) entry.method = job.method;
  if (job.usage) entry.usage = job.usage;
  if (job.net) entry.net = job.net;
  if (job.parentHow) entry.parentHow = job.parentHow;
  deps.journal.finish(entry);
  deps.journal.bump(outcome);
  deps.log?.(`${outcome} ${job.intentId} after ${entry.ms} ms${reason ? `: ${reason}` : ""}`);
  deps.metric?.({
    colonyId: cfg.colonyId,
    agentId: cfg.agentId,
    model: cfg.model,
    kind: cfg.kind,
    intentId: job.intentId,
    path: job.intent.footprint[0] ?? null,
    outcome,
    reason: reason ? reason.slice(0, 300) : null,
    ms: entry.ms,
    proposedAfterMs: job.proposedAt ? job.proposedAt - job.takenAt : null,
    method: job.method ?? null,
    calls: job.usage?.calls ?? job.llmCalls,
    throttled: job.throttled ?? 0,
    tokensIn: job.usage?.input ?? 0,
    tokensOut: job.usage?.output ?? 0,
    tokensCached: job.usage?.cached ?? 0,
    neurons: job.usage ? Math.round(job.usage.neurons * 100) / 100 : 0,
    llmMs: job.usage?.ms ?? 0,
    fetchDown: job.net?.fetch?.receivedBytes ?? null,
    fetchMs: job.net?.fetch?.ms ?? null,
    probeMs: job.net?.probe?.ms ?? null,
    pushUp: job.net?.push?.sentBytes ?? null,
    pushMs: job.net?.push?.ms ?? null,
    parent: job.parentHow ?? null,
    workspace: job.lease.repo.name,
  });
  deps.journal.setJob(null);
  deps.journal.log({ at: now, intentId: job.intentId, step: "done", ok: outcome === "landed", ms: now - job.takenAt, detail: reason ? `${outcome}: ${reason}` : outcome });
  return { sleepMs: outcome === "landed" ? 0 : Math.round(500 + (deps.rand ?? Math.random)() * 500) };
}

async function abandon(deps: LoopDeps, cfg: AgentConfig, job: Job, reason: string): Promise<StepResult> {
  try {
    await deps.colony.abandon(cfg.agentId, reason);
  } catch (e) {
    if (e instanceof Halt) throw e;
    deps.journal.log({ at: deps.now(), intentId: job.intentId, step: "abandon", ok: false, ms: 0, detail: errorMessage(e) });
  }
  finishJob(deps, cfg, job, "abandoned", reason);
  return { sleepMs: Math.round(ABANDON_PAUSE_MS * (0.75 + (deps.rand ?? Math.random)() * 0.5)) };
}

function halt(deps: LoopDeps, cfg: AgentConfig, reason: string): StepResult {
  const c = guard(deps, cfg.epoch);
  c.running = false;
  c.stoppedAt = deps.now();
  c.stopReason = reason;
  c.epoch += 1;
  deps.journal.setConfig(c);
  deps.journal.setJob(null);
  deps.journal.log({ at: deps.now(), step: "halt", ok: false, ms: 0, detail: reason });
  deps.log?.(`halted: ${reason}`);
  return { sleepMs: 0, stop: true };
}

async function maybeHeartbeat(deps: LoopDeps, cfg: AgentConfig, job: Job): Promise<void> {
  const now = deps.now();
  if (now - job.lastHeartbeatAt < HEARTBEAT_EVERY_MS) return;
  job.lastHeartbeatAt = now;
  try {
    await deps.colony.heartbeat(cfg.agentId);
  } catch (e) {
    if (e instanceof Halt) throw e;
    deps.journal.log({ at: deps.now(), intentId: job.intentId, step: "heartbeat", ok: false, ms: deps.now() - now, detail: errorMessage(e) });
  }
  save(deps, cfg, job);
}

function requireBase(job: Job): Sha {
  if (!job.baseSha) throw new Error("job has no base commit");
  return job.baseSha;
}

function requireHead(job: Job): Sha {
  if (!job.headSha) throw new Error("job has no head commit");
  return job.headSha;
}

/** Stop a running agent: bump the epoch (in-flight steps halt), give back a claimed intent, clear the job. */
export async function stopAgent(deps: Pick<LoopDeps, "colony" | "journal" | "now">, reason = "stopped"): Promise<void> {
  const c = deps.journal.config();
  if (!c) return;
  const job = deps.journal.job();
  c.running = false;
  c.stoppedAt = deps.now();
  c.stopReason = reason;
  c.epoch += 1;
  deps.journal.setConfig(c);
  if (job) {
    deps.journal.setJob(null);
    if (job.step !== "await") {
      try {
        await deps.colony.abandon(c.agentId, `agent stopped: ${reason}`);
      } catch {
        // Best effort: the colony reaps silent agents anyway.
      }
    }
  }
}

