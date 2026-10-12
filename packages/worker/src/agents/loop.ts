import { checkFile, ruleApplies } from "@fire_trident/core";
import type { AgentKind, AgentState, CheckResult, FileVersion, Id, Intent, Path, Proposal, ProposalStatus, Rule, Sha, WorkspaceLease } from "@fire_trident/core";
import { agentIdentity, applyReplacement, changeSummary, commitMessage, decodeText, expandFootprint, isLiteralPath, recheck, ruleReplacement } from "./change.ts";
import { buildEditMessages, maxTokensFor, parseFileReply, retryMessages, violationProblem } from "./prompt.ts";
import type { ChatMessage } from "./prompt.ts";
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
  proposalId?: Id;
  proposedAt?: number;
  pollMs?: number;
  lastStatus?: ProposalStatus;
  lastHeartbeatAt: number;
  lastError?: string;
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
}

/** A model reply. */
export interface ModelReply {
  text: string | null;
  finishReason?: string;
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
}

export const MAX_STEP_ATTEMPTS = 4;
export const HEARTBEAT_EVERY_MS = 45_000;
export const FIRST_POLL_MS = 1_500;
export const MAX_POLL_MS = 15_000;
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
  const r = await deps.git.ensureBase({ remote: job.lease.trunk.remote, token: job.lease.trunk.token, baseSha: job.lease.baseSha });
  job.baseSha = r.baseSha;
  if (r.fallback) job.baseFallback = true;
  return advance(deps, cfg, job, "read");
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
  for (const f of job.reads ?? []) {
    if (done.has(f.path)) continue;
    const out = await produceFile(deps, cfg, job, baseSha, f);
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

async function produceFile(deps: LoopDeps, cfg: AgentConfig, job: Job, baseSha: Sha, f: FileRead): Promise<FileOutcome> {
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
    job.llmCalls += 1;
    job.method = "model";
    save(deps, cfg, job);
    deps.journal.bump("llmCalls");
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

async function commitStep(deps: LoopDeps, cfg: AgentConfig, job: Job): Promise<StepResult> {
  const changes = deps.journal.changes().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (changes.length === 0) return abandon(deps, cfg, job, "nothing to commit");
  // The clone lives in durable storage, but make sure the base is still there after a restart.
  const base = await deps.git.ensureBase({ remote: job.lease.trunk.remote, token: job.lease.trunk.token, baseSha: requireBase(job) });
  if (base.baseSha !== job.baseSha) throw new Error(`base ${job.baseSha} is no longer reachable`);
  const r = await deps.git.commit({
    baseSha: base.baseSha,
    changes,
    message: commitMessage(job.intent, cfg.agentId),
    author: agentIdentity(cfg.agentId),
    timestamp: Math.floor(job.takenAt / 1000),
  });
  job.headSha = r.headSha;
  job.writeSet = r.writeSet;
  return advance(deps, cfg, job, "push");
}

async function pushStep(deps: LoopDeps, cfg: AgentConfig, job: Job): Promise<StepResult> {
  if (deps.now() > job.lease.tokenExpiresAt - TOKEN_SLACK_MS) return abandon(deps, cfg, job, "the workspace token expired before the push");
  try {
    await deps.git.push({ remote: job.lease.repo.remote, token: job.lease.token, headSha: requireHead(job) });
  } catch (e) {
    const status = errorStatus(e);
    if (status === 401 || status === 403) return abandon(deps, cfg, job, `the workspace refused the push: ${errorMessage(e)}`);
    throw e;
  }
  deps.journal.bump("pushed");
  return advance(deps, cfg, job, "propose");
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
    const notVerified = [
      job.method === "replacement" ? "Deterministic replacement re-checked against the rule only." : `Edited by model ${cfg.model}; re-checked against the rule only.`,
      "No tests, type checks or builds were run by the agent.",
      job.baseFallback ? `Based on trunk ${job.baseSha} because the leased base was unreachable.` : "",
    ]
      .filter(Boolean)
      .join(" ");
    proposal = await deps.colony.propose({
      colonyId: cfg.colonyId,
      intentId: job.intentId,
      agentId: cfg.agentId,
      workspace: job.lease.repo,
      baseSha: requireBase(job),
      headSha,
      writeSet: job.writeSet ?? [],
      readSet,
      declared: { footprint: job.intent.footprint, summary: job.summary ?? job.intent.title },
      evidence: { checks: job.checks ?? [], notVerified },
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
  deps.journal.finish(entry);
  deps.journal.bump(outcome);
  deps.log?.(`${outcome} ${job.intentId} after ${entry.ms} ms${reason ? `: ${reason}` : ""}`);
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

