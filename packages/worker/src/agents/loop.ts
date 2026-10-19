import { checkFile, cleanGuideTake, importsOf, ruleApplies } from "@fire_trident/core";
import type { AgentKind, AgentState, CheckResult, EscalationKind, FileVersion, GuideTake, Id, Intent, Path, Proposal, ProposalStatus, Rule, Sha, WorkspaceLease } from "@fire_trident/core";
import { agentIdentity, applyReplacement, changeSummary, cleanPath, commitMessage, decodeText, expandFootprint, inlineChange, isLiteralPath, oneLine, recheck, ruleReplacement } from "./change.ts";
import { TreeIndex, applySpecifierEdits, isImportRule, parseSpecifierEdits, specifierFacts } from "./context.ts";
import { checkWrittenFile, parseIntentSpec, resolveImport, wantsErasable, writeOrder } from "./create.ts";
import { cleanContext, noticeEntry, withLanded, type LandedWhy } from "./landed.ts";
import { MAX_REWRITE_CHARS, TREE_MAX, buildEditMessages, buildSpecifierMessages, buildWriteMessages, cleanLastReturn, maxTokensFor, parseEscalateReply, parseFileReply, retryMessages, specifierRetryMessages, violationProblem } from "./prompt.ts";
import { parseLessonReply } from "./prompt.ts";
import type { ChatMessage, LastReturn, TokenUsage } from "./prompt.ts";
import { cleanPreview, type AntibodyQuestion } from "./preview.ts";
import { TERMINAL_STATUSES, errorMessage, errorStatus } from "./rpc.ts";
import { throttleRetryAfterMs } from "./throttle.ts";
import { MODEL_LINE_CHECK, modelLineChoice, type KnownModels } from "./modelline.ts";
import { tooLargeToRewrite, tooManyFiles } from "./limits.ts";
import type { ColonyRpc, TakeResult } from "./rpc.ts";
import { MAX_GUIDANCE, directionError, directiveNote, guidanceFor, holdDirective, interrupts, markApplied, nextDirection, stepNote, withGuidance } from "./direction.ts";
import type { Guidance, HeldDirective } from "./direction.ts";
import type { Directive } from "@fire_trident/core";
import { isInboxDirective } from "../colony/direction.ts";
import type { VirtualReads } from "./virtual.ts";
import { cleanModelHint, stepupCheck, type ModelHint } from "../colony/stepup.ts";
import { hedgeSummary, type HedgeRecord } from "../colony/hedge.ts";
import { cleanDeclaredBy, type DeclaredBy } from "../colony/chain.ts";
import { PAUSE_WAIT_MS, isPauseRefusal, pauseViewOf } from "../colony/pause.ts";
import { AWAITING_PERSON, holdsNoFiles, leavesToPerson } from "./personwait.ts";

/**
 * The in-platform agent loop as a journaled state machine.
 *
 * One job (an intent plus its workspace lease) moves through
 * [deps ->] fetch -> read -> produce -> commit -> push -> propose -> await. The job record is
 * written to the journal after every step (and after every file in `produce`), so an
 * agent that is killed resumes at the step it was in, keyed by intent id:
 * - deps (only for intents that build on other intents' files) waits until those files are
 *   on trunk; it only reads, so it is safe to repeat,
 * - fetch and read are reads and safe to repeat,
 * - produce keeps each finished file's new content, so no model call is repeated,
 * - commit uses the job's take time as the commit time, so a repeat yields the same sha,
 * - push force-pushes that same commit,
 * - propose first looks for a proposal it may already have made (inbox) before proposing.
 *
 * A job taken with a virtual checkout (FT_VIRTUAL_CHECKOUT, agents/virtual.ts) reads trunk object by
 * object through the binding instead of a clone, and its commit step only computes the change's inline
 * form (blob ids and changeset id; the journal keeps the files), so it skips push and proposes the
 * contents. A change too large or binary for that is committed and pushed as above.
 *
 * Nothing here touches Cloudflare APIs: the Durable Object injects the colony stub,
 * git, the model, the journal, and the clock.
 */

export type JobStep = "deps" | "fetch" | "read" | "produce" | "commit" | "push" | "propose" | "await";
/**
 * `redirected`: the intent was revised under the job (it restarts from the new revision); `withdrawn`: called off;
 * `escalated`: the model reported that the intent cannot be done as written, and the intent waits for a person;
 * `awaiting_person`: the job's inline change waits for a person, and the agent went on to other work (agents/personwait.ts);
 * `already_on_trunk`: its change would have changed nothing, its content already on trunk (FT_ALREADY_ON_TRUNK), so the
 * intent is done and the agent goes on to other work.
 */
export type Outcome = "landed" | "returned" | "rejected" | "abandoned" | "timeout" | "lost" | "redirected" | "withdrawn" | "escalated" | "awaiting_person" | "already_on_trunk";

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
  /** Characters of a text file at the base (absent in jobs read before it was recorded: `size` stands in). */
  chars?: number;
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
  /**
   * "virtual": the job reads trunk object by object through the binding (agents/virtual.ts) and proposes its change
   * inline when it can. Set at take when FT_VIRTUAL_CHECKOUT is on for the colony; a job keeps the way it started.
   * Absent: the job reads the agent's clone and pushes its commit, as before.
   */
  checkout?: "virtual";
  /** The change is proposed inline: its files travel in Proposal.contents and its headSha is its changeset id. */
  inline?: boolean;
  /** Why a virtual job's change was committed and pushed instead of proposed inline. */
  inlineSkipped?: string;
  reads?: FileRead[];
  /** Paths whose outcome in `produce` is final (changed or left alone). */
  produced?: Path[];
  checks?: CheckResult[];
  llmCalls: number;
  method?: "replacement" | "model" | "write";
  /** Files of other intents this intent builds on (from its spec layout; see create.ts). */
  buildsOn?: Path[];
  /** Of those, the files not on trunk at the last check (deps step) or at the base (read step). */
  depsMissing?: Path[];
  /** Time spent waiting for them. */
  depsWaitedMs?: number;
  /** Files the job read as context (the files it builds on, at the base). */
  context?: FileRead[];
  /** The colony's rules, for checking the files a non-rule intent writes. */
  rules?: Rule[];
  /** The model that wrote the files, when the intent asked for one other than the agent's. */
  writeModel?: string;
  headSha?: Sha;
  writeSet?: FileVersion[];
  summary?: string;
  /** Commit the change was built on: the lease base, or an equivalent trunk commit the workspace already holds. */
  parentSha?: Sha;
  /** Why that parent was chosen (telemetry). */
  parentHow?: string;
  /** Model usage of this job. */
  usage?: JobUsage;
  /** Its hedged model calls (FT_HEDGE, colony/hedge.ts): which copy answered each, the newest few. */
  hedged?: HedgeRecord[];
  /** Git network cost of this job, by phase; `reads` is what a virtual checkout read through the binding. */
  net?: { fetch?: NetStats; probe?: NetStats; push?: NetStats; reads?: NetStats };
  proposalId?: Id;
  proposedAt?: number;
  pollMs?: number;
  lastStatus?: ProposalStatus;
  lastHeartbeatAt: number;
  /** Last liveness beat sent to the colony when claims are refreshed in the regions directly. */
  lastColonyBeatAt?: number;
  lastError?: string;
  /** Times a step waited because the model provider throttled it (does not count as a failed attempt). */
  throttled?: number;
  /** Directory imports the agent rewrote to their index file, after checking the tree (for the evidence). */
  directoryRewrites?: string[];
  /** Imports that name a file beside a same-named directory (the file wins resolution), for the evidence. */
  fileOverDirectory?: string[];
  /** Human guidance this job follows (it goes into every prompt; see agents/direction.ts). */
  directives?: Guidance[];
  /** Questions review will ask of this change, from the take (agents/preview.ts); every prompt shows them. */
  antibodies?: AntibodyQuestion[];
  /** The latest landings that changed the intent's files, with their intents' whys (the take's context, agents/landed.ts). */
  history?: LandedWhy[];
  /** Why the intent's latest change came back, from the take (agents/prompt.ts); every prompt shows it, to address first. */
  lastReturn?: LastReturn;
  /** The colony's field guide, from the take where FT_FIELD_GUIDE is on: every prompt shows its lessons and invites one (agents/prompt.ts). */
  guide?: GuideTake;
  /** The model the take asked this attempt to write with, and why (FT_MODEL_STEPUP, colony/stepup.ts); absent: the spec's model or the agent's own. */
  modelHint?: ModelHint;
  /** Who declared the intent, from the take (colony/chain.ts): for an agent-declared intent every prompt says so beside the why. */
  declaredBy?: DeclaredBy;
  /** The lesson the model left with an accepted file (the first one), proposed with the change. */
  lesson?: string;
  /** Build on trunk as it is now, not the lease base: a landing notice changed files this job covers (fetch takes the tip). */
  freshBase?: boolean;
  /**
   * The blobs that files this job covers had before the landings its notices announced (path → blob, null when the
   * file was new). With asynchronous publishing (FT_ASYNC_PUBLISH) trunk's tip can lag a landing for a moment, so the
   * fetch step waits, at most TIP_WAIT_MS from `since`, until the tip no longer shows them.
   */
  awaitTip?: { before: Record<Path, Sha | null>; since: number };
  /** Times a landing notice restarted this job, and the landings it rebased past (for the evidence). */
  rebases?: number;
  rebasedOn?: Id[];
  /** The last status note relayed to the colony, and when. */
  relayedNote?: string;
  relayedAt?: number;
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

/** One intent's model calls in an agent's journal, by model (spend per intent, FT_INTENT_SPEND; Journal.bumpIntent). */
export interface AgentIntentUsage {
  intentId: Id;
  model: string;
  calls: number;
  input: number;
  output: number;
  /** When the last call was counted. */
  at: number;
}

/** Bytes and time the git network calls cost (accumulated until taken). */
export interface NetStats {
  requests: number;
  sentBytes: number;
  receivedBytes: number;
  ms: number;
  /** Objects a virtual checkout's cache answered without a call. */
  hits?: number;
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
  /** Spend per intent (FT_INTENT_SPEND): one model call for an intent, under the model that answered; the colony reads these with the journal. */
  bumpIntent?(intentId: Id, model: string, usage: { input: number; output: number }, at: number): void;
  /** Directives the colony pushed, kept until acted on (agents/direction.ts). */
  directives?(): HeldDirective[];
  setDirectives?(list: HeldDirective[]): void;
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
  /** Fetch trunk's `main` (shallow) and return the commit it points at now (null when absent). */
  fetchTip?(p: { remote: string; token: string }): Promise<Sha | null>;
}

/**
 * What a job reads trunk through: the agent's clone (GitOps) or a virtual checkout (agents/virtual.ts), which answer
 * alike. A job reads through the one it was taken with (Job.checkout).
 */
export interface ReadOps {
  /** Every file path at the commit; a virtual checkout given footprint entries (`scope`) walks only where they can match. */
  listFiles(baseSha: Sha, scope?: string[]): Promise<Path[]>;
  readFile(baseSha: Sha, path: Path): Promise<BaseFile | null>;
}

/** A model reply. */
export interface ModelReply {
  text: string | null;
  finishReason?: string;
  usage?: TokenUsage;
  /** Wall time of the call. */
  ms?: number;
  /** The model that answered (the client resolves "default" and "bulk" to model ids). */
  model?: string;
  /** Which copy answered, when the call was hedged (FT_HEDGE, colony/hedge.ts). */
  hedged?: HedgeRecord;
  /** A hedged call's losing copy: its model and tokens once it settles, or null when it failed or was aborted. */
  late?: Promise<{ model: string; usage: TokenUsage | null } | null>;
}

/**
 * Text generation, whichever provider serves the model. `valid` (optional): whether a reply's text is well formed; a
 * hedged call (FT_HEDGE, colony/hedge.ts) counts a reply that is not as a failed attempt, so its copy may answer.
 */
export interface ModelClient {
  complete(p: { model: string; messages: ChatMessage[]; maxTokens: number; valid?: (text: string | null) => boolean }): Promise<ModelReply>;
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
  /**
   * The outcome the colony pushed for a proposal (AgentDO.outcome), or null. When this is
   * provided the agent proposes with `notify`, waits for the push, and asks the colony only as a
   * slow fallback (PUSH_FALLBACK_POLL_MS) instead of polling every few seconds.
   */
  outcome?(proposalId: Id): { status: ProposalStatus; reason?: string } | null;
  /**
   * Refresh the job's claims in its regions directly (RegionDO.refreshClaims). When provided, the
   * colony only gets a liveness beat every COLONY_BEAT_EVERY_MS: it does not need claim refreshes.
   */
  refreshClaims?(job: Job): Promise<void>;
  /**
   * Aborted when a directive makes the step in flight moot (AgentDO.direct): a model call the step
   * waits on is dropped at once (it finishes in the background, its reply unused), so the agent
   * re-orients without waiting for a reply that no longer matters.
   */
  signal?: AbortSignal;
  /**
   * Virtual checkouts (agents/virtual.ts): `reads` reads trunk by object id through the binding. `on`
   * (FT_VIRTUAL_CHECKOUT for the colony) makes new jobs use it and lets their changes go inline; a job
   * taken with it keeps reading through it whatever `on` says later.
   */
  virtual?: { on: boolean; reads: VirtualReads };
  /** Spend per intent (FT_INTENT_SPEND for the colony): count each model call under the job's intent in the journal too. */
  intentSpend?: boolean;
  /** Changes waiting for a person hold no files (FT_PERSON_WAIT for the colony, agents/personwait.ts): an inline one ends its job. */
  personWait?: boolean;
  /** The deployment's default and bulk models (FT_DEFAULT_MODEL, FT_BULK_MODEL): a Model line may name them (agents/modelline.ts). */
  models?: { default?: string; bulk?: string };
}

export const MAX_STEP_ATTEMPTS = 4;
export const HEARTBEAT_EVERY_MS = 45_000;
export const FIRST_POLL_MS = 1_500;
export const MAX_POLL_MS = 5_000;
export const ESCALATED_POLL_MS = 30_000;
/** With pushed outcomes, how often a waiting agent still asks the colony (in case a push was lost). */
export const PUSH_FALLBACK_POLL_MS = 30_000;
/** With claims refreshed in the regions directly, how often the colony hears that the agent is alive (reaped after 10 minutes). */
export const COLONY_BEAT_EVERY_MS = 3 * 60_000;
export const AWAIT_TIMEOUT_MS = 30 * 60_000;
export const ABANDON_PAUSE_MS = 3_000;
export const DEFAULT_TICK_BUDGET_MS = 4 * 60_000;
/** Files one job writes at most: an intent whose footprint covers more goes to a person whole (agents/limits.ts). */
export const MAX_FILES = 20;
/**
 * Largest file a model is asked to rewrite (characters): what one reply can write back within the output budget
 * (prompt.ts MAX_REWRITE_CHARS). A larger file would fail every attempt, so it is refused before any call.
 */
export const MAX_MODEL_CHARS = MAX_REWRITE_CHARS;
/** Largest file the deterministic replacement edits (characters; journal rows stay under 2 MB). */
export const MAX_EDIT_CHARS = 1_500_000;
/** Output budget of one specifier-edit call: the reply is a few lines, the rest is room for reasoning. */
export const SPECIFIER_MAX_TOKENS = 8_192;
/** Model attempts per written file (the first, then retries with the problems found). */
export const MAX_WRITE_ATTEMPTS = 3;
/** Smallest output budget for writing a file (room for reasoning models to think). */
export const WRITE_MIN_TOKENS = 12_288;
/** Files an intent builds on that one job reads as context, and their characters in all. */
export const MAX_CONTEXT_FILES = 12;
export const MAX_CONTEXT_CHARS = 60_000;
/** How often a job waiting for the files it builds on looks at trunk, and how long it waits at most. */
export const DEPS_POLL_MS = 5_000;
export const DEPS_MAX_WAIT_MS = 15 * 60_000;
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

/** `p`, or a Halt as soon as `deps.signal` aborts (a directive changed course; the call runs on, unused). */
export function interruptible<T>(deps: Pick<LoopDeps, "signal">, p: Promise<T>): Promise<T> {
  const signal = deps.signal;
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(new Halt());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Halt());
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
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
  // A pushed directive (withdrawal, revision, guidance) is acted on before the next step runs.
  const turned = await applyDirection(deps, cfg, job);
  if (turned) return turned;
  // Pause (colony/pause.ts): no model call starts while the colony's agents are paused; the agent keeps its place.
  if (job.step === "produce" && (await pausedNow(deps))) {
    await maybeHeartbeat(deps, cfg, job);
    return { sleepMs: PAUSE_WAIT_MS };
  }
  if (job.attempts >= MAX_STEP_ATTEMPTS) {
    return abandon(deps, cfg, job, `gave up at ${job.step} after ${job.attempts} attempts: ${job.lastError ?? "interrupted"}`);
  }
  job.attempts += 1;
  save(deps, cfg, job);
  await maybeHeartbeat(deps, cfg, job);
  await relayStep(deps, cfg, job);
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
    if (errorStatus(e) === 429) return throttled(deps, cfg, job, msg, throttleRetryAfterMs(e));
    if (isPauseRefusal(e)) return paused(deps, cfg, job, msg);
    // The colony refused because the intent was revised or withdrawn under this job: turn, do not retry.
    const turn = directionError(e);
    if (turn) return finishJob(deps, cfg, job, turn.kind === "withdrawal" ? "withdrawn" : "redirected", turn.reason);
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

/** Whether the colony's agents are paused now (colony/pause.ts). Fails open: the colony refuses the write itself. */
async function pausedNow(deps: LoopDeps): Promise<boolean> {
  return (await pauseViewOf(deps.colony).catch(() => null))?.paused === true;
}

/**
 * The colony refused a write because its agents are paused (colony/pause.ts). That is not the agent's failure: the
 * attempt is given back and the step waits PAUSE_WAIT_MS, as long as the pause lasts, keeping the job and its work.
 */
function paused(deps: LoopDeps, cfg: AgentConfig, job: Job, msg: string): StepResult {
  const fresh = deps.journal.job();
  if (fresh && fresh.intentId === job.intentId) {
    fresh.attempts = Math.max(0, fresh.attempts - 1);
    fresh.lastError = msg;
    save(deps, cfg, fresh);
  }
  return { sleepMs: PAUSE_WAIT_MS };
}

/** Throttled waits one job may take before it gives its intent back (about half an hour). */
export const MAX_THROTTLED = 40;

/** Wait after the n-th throttle: 4 s, 8 s, 16 s, 32 s, then 60 s, each +-50% so agents spread out. */
export function throttleWaitMs(n: number, rand: () => number = Math.random): number {
  const base = Math.min(MAX_WAIT_MS, 4_000 * 2 ** (Math.min(Math.max(n, 1), 5) - 1));
  return Math.round(base * (0.5 + rand()));
}

/**
 * The wait after the n-th throttle when the provider asked for `retryAfterMs` (agents/throttle.ts): at least that, plus
 * up to a quarter more so agents told the same wait do not all come back at once; else throttleWaitMs alone.
 */
export function throttledSleepMs(n: number, retryAfterMs: number | null, rand: () => number = Math.random): number {
  const backoff = throttleWaitMs(n, rand);
  if (retryAfterMs === null || !Number.isFinite(retryAfterMs) || retryAfterMs <= 0) return backoff;
  return Math.max(backoff, Math.round(retryAfterMs * (1 + rand() * 0.25)));
}

/**
 * The model provider throttled a step (rate limit, no capacity, Anthropic overloaded). That is not the
 * agent's failure: the attempt is given back and the step waits with jittered backoff, at least as long
 * as the provider asked (Retry-After). Only a job throttled MAX_THROTTLED times gives its intent back.
 */
async function throttled(deps: LoopDeps, cfg: AgentConfig, job: Job, msg: string, retryAfterMs: number | null = null): Promise<StepResult> {
  deps.journal.bump("throttled");
  const fresh = deps.journal.job();
  if (!fresh || fresh.intentId !== job.intentId) return { sleepMs: throttledSleepMs(1, retryAfterMs, deps.rand) };
  fresh.throttled = (fresh.throttled ?? 0) + 1;
  fresh.attempts = Math.max(0, fresh.attempts - 1);
  fresh.lastError = msg;
  save(deps, cfg, fresh);
  if (fresh.throttled > MAX_THROTTLED) return abandon(deps, cfg, fresh, `the model stayed throttled through ${MAX_THROTTLED} waits: ${msg}`);
  return { sleepMs: throttledSleepMs(fresh.throttled, retryAfterMs, deps.rand) };
}

async function runStep(deps: LoopDeps, cfg: AgentConfig, job: Job): Promise<StepResult> {
  switch (job.step) {
    case "deps":
      return depsStep(deps, cfg, job);
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
    // Pause (colony/pause.ts): the colony's agents are paused; wait for a person to resume, no failure counted.
    if (isPauseRefusal(e)) return { sleepMs: PAUSE_WAIT_MS };
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
  // A spec-declared intent names the files it builds on; its agent waits for them to land first.
  const own = new Set((res.intent.footprint ?? []).map(cleanPath));
  const buildsOn = rule ? [] : parseIntentSpec(res.intent.why ?? "").buildsOn.filter((p) => isLiteralPath(p) && !own.has(p));
  // A virtual checkout reads trunk through the binding, and so does its wait for the files the intent builds on.
  const virtual = deps.virtual?.on === true;
  const job: Job = {
    intentId: res.intent.id,
    intent: res.intent,
    lease: res.lease,
    rule,
    step: buildsOn.length > 0 && (deps.trunk || virtual) ? "deps" : "fetch",
    attempts: 0,
    takenAt: now,
    stepStartedAt: now,
    llmCalls: 0,
    lastHeartbeatAt: now,
  };
  if (virtual) job.checkout = "virtual";
  if (buildsOn.length > 0) job.buildsOn = buildsOn;
  // What review will ask of the change, so the model can avoid what a person rejected before.
  const antibodies = cleanPreview(res.review)?.antibodies ?? [];
  if (antibodies.length > 0) job.antibodies = antibodies;
  // Why the code is the way it is: the latest landings on these files and their intents' whys.
  const history = cleanContext(res.context);
  if (history) job.history = history;
  // Why the intent's latest change came back, so this one addresses that first (a colony on the previous version sends none).
  const lastReturn = cleanLastReturn("lastReturn" in res ? res.lastReturn : undefined);
  if (lastReturn) job.lastReturn = lastReturn;
  // The colony's field guide (FT_FIELD_GUIDE; a colony with it off, or on the previous version, sends none).
  const guide = cleanGuideTake("guide" in res ? res.guide : undefined);
  if (guide) job.guide = guide;
  // Model step-up (FT_MODEL_STEPUP): after two returns the take asks for the stronger model class (none where it is off).
  const modelHint = cleanModelHint(res.model);
  if (modelHint) job.modelHint = modelHint;
  // Who declared the intent (colony/chain.ts; a colony on the previous version sends none).
  const declaredBy = cleanDeclaredBy("declaredBy" in res ? res.declaredBy : undefined);
  if (declaredBy) job.declaredBy = declaredBy;
  await adoptGuidance(deps, cfg, job, now);
  save(deps, cfg, job);
  deps.journal.bump("taken");
  // A Model line the agent will not honor (agents/modelline.ts): the take's line says why.
  const ignored = rule ? undefined : modelLineChoice(parseIntentSpec(res.intent.why ?? "").model, res.intent.source, knownModels(deps, cfg)).ignored;
  deps.journal.log({ at: now, intentId: res.intent.id, step: "take", ok: true, ms: now - t0, ...(ignored ? { detail: ignored } : {}) });
  return { sleepMs: 0 };
}

/** The models this deployment knows beyond the classes and the price list, for a Model line (agents/modelline.ts). */
function knownModels(deps: LoopDeps, cfg: AgentConfig): KnownModels {
  return { default: deps.models?.default, bulk: deps.models?.bulk, own: cfg.model };
}

/**
 * Wait until every file the intent builds on is on trunk (one TrunkDO.blobsFor per poll).
 * The colony checks every new import against trunk, so a file written before its
 * dependencies land would only come back; waiting also lets the agent read the real code.
 * The claim stays held (heartbeats refresh it). After DEPS_MAX_WAIT_MS the intent is given
 * back, so a colony whose dependencies stall never deadlocks on waiting agents. A virtual
 * checkout looks at trunk's tip in the repo instead (what it will build on), sparing the trunk writer.
 */
async function depsStep(deps: LoopDeps, cfg: AgentConfig, job: Job): Promise<StepResult> {
  const needed = job.buildsOn ?? [];
  if (needed.length === 0) return advance(deps, cfg, job, "fetch");
  let blobs: Record<Path, Sha | null>;
  if (job.checkout === "virtual") blobs = await blobsAtTip(virtualOf(deps), needed);
  else if (deps.trunk) blobs = await deps.trunk.blobsFor(needed);
  else return advance(deps, cfg, job, "fetch");
  bookReads(deps, job);
  const missing = needed.filter((p) => !blobs[p]);
  const now = deps.now();
  const waited = Math.max(0, now - job.stepStartedAt);
  job.depsWaitedMs = waited;
  if (missing.length === 0) {
    delete job.depsMissing;
    if (waited > 0) deps.journal.log({ at: now, intentId: job.intentId, step: "deps", ok: true, ms: waited, detail: `${needed.length} file(s) on trunk after ${Math.round(waited / 1000)} s` });
    return advance(deps, cfg, job, "fetch");
  }
  if (waited >= DEPS_MAX_WAIT_MS) {
    return abandon(deps, cfg, job, `waited ${Math.round(waited / 60_000)} min for ${missing.join(", ")} to land; giving the intent back`);
  }
  // Waiting is not a failed attempt.
  job.attempts = 0;
  job.depsMissing = missing;
  save(deps, cfg, job);
  return { sleepMs: Math.round(DEPS_POLL_MS * (0.75 + (deps.rand ?? Math.random)() * 0.5)) };
}

async function fetchStep(deps: LoopDeps, cfg: AgentConfig, job: Job): Promise<StepResult> {
  if (job.checkout === "virtual") return virtualFetchStep(deps, cfg, job);
  deps.git.takeNetStats?.();
  // A job that waited for files to land builds on trunk as it is now: the lease base predates them. So
  // does a job a landing notice restarted (freshBase): files it covers changed after the lease base.
  const atTip = (job.buildsOn ?? []).length > 0 || job.freshBase === true;
  const tip = atTip && deps.git.fetchTip ? await deps.git.fetchTip({ remote: job.lease.trunk.remote, token: job.lease.trunk.token }) : null;
  if (tip && !(await tipShowsLandings(job, tip, deps.git.blobsAt ? (sha, paths) => deps.git.blobsAt!(sha, paths) : undefined, deps.now()))) {
    save(deps, cfg, job);
    return { sleepMs: TIP_POLL_MS };
  }
  delete job.awaitTip;
  const reuse = tip ? null : await workspaceBase(deps, job);
  if (tip) {
    job.baseSha = tip;
  } else if (reuse) {
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
 * The base of a virtual checkout: the lease base when the trunk repo has it (the trunk writer makes sure it does
 * before leasing it), else trunk's tip; the tip itself for a job that waited for files to land or that a landing
 * notice restarted. Only the commit is read here; trees and blobs are read when a path needs them.
 */
async function virtualFetchStep(deps: LoopDeps, cfg: AgentConfig, job: Job): Promise<StepResult> {
  const v = virtualOf(deps);
  const atTip = (job.buildsOn ?? []).length > 0 || job.freshBase === true;
  const tip = atTip ? await v.fetchTip() : null;
  if (tip && !(await tipShowsLandings(job, tip, (sha, paths) => v.blobsAt(sha, paths), deps.now()))) {
    bookReads(deps, job);
    save(deps, cfg, job);
    return { sleepMs: TIP_POLL_MS };
  }
  delete job.awaitTip;
  if (tip) {
    job.baseSha = tip;
  } else {
    const r = await v.ensureBase({ baseSha: job.lease.baseSha });
    job.baseSha = r.baseSha;
    if (r.fallback) job.baseFallback = true;
  }
  bookReads(deps, job);
  return advance(deps, cfg, job, "read");
}

/** How long a job a landing notice restarted waits for trunk's tip to show that landing, and how often it looks. */
export const TIP_WAIT_MS = 15_000;
export const TIP_POLL_MS = 1_000;

/**
 * Whether trunk's tip shows the landings the job's notices announced: no file they changed still has its blob from
 * before them. True as well when there is nothing to wait for, no way to read blobs, the read fails, or the job has
 * waited TIP_WAIT_MS: then it rebuilds on the tip as it is, and the lane's read-set check catches a change that is
 * still stale.
 */
async function tipShowsLandings(job: Job, tip: Sha, blobsAt: ((sha: Sha, paths: Path[]) => Promise<Map<Path, Sha | null>>) | undefined, now: number): Promise<boolean> {
  const want = job.awaitTip;
  if (!want || !blobsAt || now - want.since >= TIP_WAIT_MS) return true;
  const paths = Object.keys(want.before);
  if (paths.length === 0) return true;
  const at = await blobsAt(tip, paths).catch(() => null);
  if (!at) return true;
  return paths.every((p) => (at.get(p) ?? null) !== (want.before[p] ?? null));
}

/** `fn` on each item in order: together for a virtual checkout (each read is a call to the trunk repo), in turn for a clone. */
async function eachRead<T, R>(job: Job, items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  if (job.checkout === "virtual") return Promise.all(items.map(fn));
  const out: R[] = [];
  for (const item of items) out.push(await fn(item));
  return out;
}

/** Where the job reads trunk: the virtual checkout it was taken with, or the agent's clone. */
function readsOf(deps: LoopDeps, job: Job): ReadOps {
  return job.checkout === "virtual" ? virtualOf(deps) : deps.git;
}

/** The virtual checkout of a job taken with one. */
function virtualOf(deps: LoopDeps): VirtualReads {
  if (!deps.virtual) throw new Error("this job reads trunk through a virtual checkout, which this agent was not given");
  return deps.virtual.reads;
}

/** Blob of each path at trunk's tip as the trunk repo serves it (null when absent, or when trunk has no main). */
async function blobsAtTip(v: VirtualReads, paths: Path[]): Promise<Record<Path, Sha | null>> {
  const tip = await v.fetchTip();
  const at = tip ? await v.blobsAt(tip, paths) : new Map<Path, Sha | null>();
  return Object.fromEntries(paths.map((p) => [p, at.get(p) ?? null]));
}

/** Add what the job's virtual checkout read since the last call to its telemetry (job.net.reads). */
function bookReads(deps: LoopDeps, job: Job): void {
  if (job.checkout !== "virtual" || !deps.virtual) return;
  const s = deps.virtual.reads.takeNetStats();
  if (s.requests === 0 && !s.hits) return;
  const r = job.net?.reads;
  job.net = {
    ...job.net,
    reads: { requests: (r?.requests ?? 0) + s.requests, sentBytes: 0, receivedBytes: (r?.receivedBytes ?? 0) + s.receivedBytes, ms: (r?.ms ?? 0) + s.ms, hits: (r?.hits ?? 0) + (s.hits ?? 0) },
  };
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
  // The files the intent builds on must match trunk too: the job reads them.
  const paths = [...new Set([...footprint, ...(job.buildsOn ?? [])].map(cleanPath))];
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
  const files = readsOf(deps, job);
  const footprint = job.intent.footprint ?? [];
  const listing = footprint.some((e) => !isLiteralPath(e)) ? await files.listFiles(baseSha, footprint) : null;
  let paths = expandFootprint(footprint, listing, MAX_FILES * 4);
  const rule = job.rule;
  if (rule) paths = paths.filter((p) => ruleApplies(rule, p));
  // More files than one agent writes: the intent goes to a person whole, before any read, never landed in part as done.
  const tooMany = tooManyFiles(paths.length, MAX_FILES, MAX_FILES * 4);
  if (tooMany) return escalateJob(deps, cfg, job, tooMany);
  if (paths.length === 0) return abandon(deps, cfg, job, "the footprint names no file this agent can edit");
  const at = async (path: Path): Promise<FileRead | null> => {
    const f = await files.readFile(baseSha, path);
    if (!f) return null;
    const regular = f.mode === "100644" || f.mode === "100755";
    const text = regular ? decodeText(f.bytes) : null;
    return { path, blob: f.blob, mode: f.mode, size: f.bytes.length, text: text !== null, ...(text !== null ? { chars: text.length } : {}) };
  };
  const reads: FileRead[] = (await eachRead(job, paths, at)).map((f, i) => f ?? { path: paths[i]!, blob: null, mode: null, size: 0, text: true });
  // A file a model would rewrite whole that its reply cannot hold: to a person before any model call (agents/limits.ts).
  // A rule's intent rewrites only a file with violations, which its model edit checks for itself.
  if (!rule) {
    for (const f of reads) {
      const big = f.blob !== null && f.text ? tooLargeToRewrite(f.path, f.chars ?? f.size, MAX_MODEL_CHARS) : null;
      if (big) {
        bookReads(deps, job);
        return escalateJob(deps, cfg, job, big);
      }
    }
  }
  if (rule) {
    job.reads = reads;
    bookReads(deps, job);
    return advance(deps, cfg, job, "produce");
  }
  // A non-rule intent writes its files with a model: sources before tests, so a test sees the code it tests;
  // the files it builds on as context; and the colony's rules, which every written file must keep.
  job.reads = writeOrder(reads);
  const context: FileRead[] = [];
  const missing: Path[] = [];
  let chars = 0;
  const wanted = (job.buildsOn ?? []).slice(0, MAX_CONTEXT_FILES);
  const found = await eachRead(job, wanted, at);
  wanted.forEach((path, i) => {
    const f = found[i];
    if (!f) missing.push(path);
    else if (f.text && chars + f.size <= MAX_CONTEXT_CHARS) {
      context.push(f);
      chars += f.size;
    }
  });
  job.context = context;
  if (missing.length > 0) job.depsMissing = missing;
  else delete job.depsMissing;
  // A retracted rule stays in history but is no longer checked.
  job.rules = ((await deps.colony.snapshot()).rules ?? []).filter((r) => !r.retractedAt);
  bookReads(deps, job);
  return advance(deps, cfg, job, "produce");
}

/** What the model reported instead of writing a file (an ESCALATE reply). */
type Escalation = { kind: EscalationKind; report: string };

type FileOutcome = { kind: "change"; content: string } | { kind: "skip" } | { kind: "abandon"; reason: string } | { kind: "escalate"; escalation: Escalation };

async function produceStep(deps: LoopDeps, cfg: AgentConfig, job: Job): Promise<StepResult> {
  const baseSha = requireBase(job);
  const done = new Set(job.produced ?? []);
  // The base tree's listing, read once per step and only when a file needs it. A virtual checkout's tree
  // loads only the directories the questions asked of it touch.
  let tree: TreeIndex | null = null;
  const treeAt = async (): Promise<TreeIndex> => (tree ??= job.checkout === "virtual" ? await virtualOf(deps).tree(baseSha) : new TreeIndex(await deps.git.listFiles(baseSha)));
  for (const f of job.reads ?? []) {
    if (done.has(f.path)) continue;
    const out = await produceFile(deps, cfg, job, baseSha, f, treeAt);
    if (out.kind === "abandon") return abandon(deps, cfg, job, out.reason);
    if (out.kind === "escalate") return escalateJob(deps, cfg, job, out.escalation);
    guard(deps, cfg.epoch);
    if (out.kind === "change") deps.journal.putChange(f.path, out.content);
    done.add(f.path);
    job.produced = [...done];
    save(deps, cfg, job);
  }
  const changed = deps.journal.changes().map((c) => c.path);
  if (changed.length === 0) return abandon(deps, cfg, job, "no change needed: the files already satisfy the intent");
  const how = job.method === "replacement" ? "applied the rule's replacement" : job.method === "write" ? "written with a model and checked" : "edited with a model";
  job.summary = changeSummary(job.intent, changed, how);
  bookReads(deps, job);
  return advance(deps, cfg, job, "commit");
}

async function produceFile(deps: LoopDeps, cfg: AgentConfig, job: Job, baseSha: Sha, f: FileRead, treeAt: () => Promise<TreeIndex>): Promise<FileOutcome> {
  if (!f.text) return { kind: "skip" };
  let original: string | null = null;
  if (f.blob !== null) {
    const file = await readsOf(deps, job).readFile(baseSha, f.path);
    if (!file) throw new Error(job.checkout === "virtual" ? `${f.path} is missing from trunk at ${baseSha}` : `${f.path} is missing from the local clone of ${baseSha}`);
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
  const r = await writeFile(deps, cfg, job, baseSha, f.path, original, treeAt);
  if (!r.ok) return r.escalate ? { kind: "escalate", escalation: r.escalate } : { kind: "abandon", reason: r.reason };
  return r.content === (original ?? "") ? { kind: "skip" } : { kind: "change", content: r.content };
}

/**
 * Write one file of a non-rule intent with a model (see create.ts and buildWriteMessages):
 * the model sees the intent with its spec context, the colony's rules for the path, the
 * project tree, the files the intent builds on and the files this change already wrote.
 * The reply must parse and pass every check (syntax, rules, erasable TypeScript when the
 * project asks for it, imports that resolve in trunk or this change); otherwise the model
 * gets the problems and tries again, MAX_WRITE_ATTEMPTS times in all. A reply that starts with
 * `ESCALATE <kind>: <report>` writes nothing: the model says the intent cannot be done as written.
 */
async function writeFile(
  deps: LoopDeps,
  cfg: AgentConfig,
  job: Job,
  baseSha: Sha,
  path: Path,
  original: string | null,
  treeAt: () => Promise<TreeIndex>,
): Promise<{ ok: true; content: string } | { ok: false; reason: string; escalate?: Escalation }> {
  if (original !== null && original.length > MAX_MODEL_CHARS) {
    return { ok: false, reason: `${path} is too large to rewrite with a model (${original.length} characters)` };
  }
  const tree = await treeAt();
  const files = readsOf(deps, job);
  const siblings = (job.reads ?? []).map((r) => r.path);
  const written = deps.journal.changes().filter((c) => c.path !== path);
  const context: Array<{ path: Path; content: string }> = [];
  const contextFiles = await eachRead(job, job.context ?? [], (c) => files.readFile(baseSha, c.path));
  (job.context ?? []).forEach((c, i) => {
    const file = contextFiles[i];
    const text = file ? decodeText(file.bytes) : null;
    if (text !== null) context.push({ path: c.path, content: text });
  });
  const spec = parseIntentSpec(job.intent.why ?? "");
  const tsconfig =
    written.find((w) => w.path === "tsconfig.json")?.content ??
    ((await tree.settle(() => tree.isFile("tsconfig.json"))) ? decodeText((await files.readFile(baseSha, "tsconfig.json"))?.bytes ?? new Uint8Array()) : null);
  const erasable = wantsErasable(`${job.intent.why ?? ""}\n${(job.intent.acceptance ?? []).join("\n")}`, tsconfig);
  const rules = job.rules ?? [];
  const exists = (p: Path): boolean => tree.isFile(p) || siblings.includes(p);
  const planned = new Set(spec.planned);
  // The project tree the prompt lists: every path from a clone; from a virtual checkout, the first TREE_MAX in path order.
  const listed = await tree.paths(TREE_MAX);
  const first = buildWriteMessages({
    intent: job.intent,
    directives: job.directives ?? [],
    antibodies: job.antibodies ?? [],
    history: job.history ?? [],
    lastReturn: job.lastReturn,
    guide: job.guide,
    declaredBy: job.declaredBy,
    path,
    content: original,
    siblings,
    rules: rules.filter((r) => ruleApplies(r, path)),
    tree: listed.paths,
    ...(listed.complete ? {} : { treeComplete: false }),
    context,
    missing: job.depsMissing ?? [],
    written,
  });
  // Modules the written file imports, read once, so the binding check sees what they export.
  const sources = new Map<Path, string | null>();
  const loadSources = async (content: string): Promise<void> => {
    const targets = await tree.settle(() => importsOf(content).map((imp) => resolveImport(path, imp.specifier, exists)));
    for (const target of targets) {
      if (target === null || sources.has(target)) continue;
      const mine = written.find((w) => w.path === target);
      if (mine) sources.set(target, mine.content);
      else sources.set(target, tree.isFile(target) ? decodeText((await files.readFile(baseSha, target))?.bytes ?? new Uint8Array()) : null);
    }
  };
  const maxTokens = maxTokensFor(original, WRITE_MIN_TOKENS);
  // The take's hint first (the model step-up), then the model class the intent asks for ("default" for integration-heavy
  // work; bulk agents then write with it), then the agent's own. A Model line is honored only where a person, a spec or
  // a rule wrote it and it names a model this deployment knows (agents/modelline.ts); otherwise the evidence says why not.
  const line = modelLineChoice(spec.model, job.intent.source, knownModels(deps, cfg));
  if (line.ignored && !job.modelHint) addCheck(job, { name: MODEL_LINE_CHECK, ok: true, ms: 0, detail: line.ignored });
  const asked = job.modelHint?.model ?? line.model ?? cfg.model;
  let messages = first;
  let problem = "";
  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
    await maybeHeartbeat(deps, cfg, job);
    const t0 = deps.now();
    const reply = await interruptible(deps, deps.model.complete({ model: asked, messages, maxTokens }));
    countCall(deps, cfg, job, reply, deps.now() - t0, asked);
    job.method = "write";
    const used = reply.model ?? asked;
    if (used !== cfg.model) job.writeModel = used;
    // The lineage note says why this change's model is not the agent's own.
    if (job.modelHint) addCheck(job, stepupCheck(job.modelHint, used, cfg.model));
    const text = reply.text ?? "";
    const escalation = parseEscalateReply(text);
    if (escalation) return { ok: false, reason: `escalated (${escalation.kind}) by model ${used}`, escalate: escalation };
    if (reply.finishReason === "length" && !text.includes("</file>")) {
      problem = "the reply was cut off before </file>; return the complete file and nothing else";
    } else {
      const parsed = parseFileReply(text, original, path);
      if (!parsed.ok) problem = parsed.reason;
      else {
        await loadSources(parsed.content);
        const check = await tree.settle(() => checkWrittenFile({ path, before: original, after: parsed.content, rules, exists, planned, erasable, source: (p) => sources.get(p) ?? null }));
        if (check.problems.length === 0) {
          addCheck(job, { name: `write ${path}`, ok: true, ms: deps.now() - t0, detail: `${check.detail} (model ${used}, attempt ${attempt + 1})` });
          // Field guide: the first lesson an accepted reply leaves goes with the change.
          if (job.guide && job.lesson === undefined) {
            const lesson = parseLessonReply(text);
            if (lesson) job.lesson = lesson;
          }
          return { ok: true, content: parsed.content };
        }
        problem = `the file has these problems:\n${check.problems.map((p) => `- ${p}`).join("\n")}`;
      }
    }
    messages = retryMessages(first, text, problem);
  }
  addCheck(job, { name: `write ${path}`, ok: false, ms: 0, detail: problem.slice(0, 500) });
  return { ok: false, reason: `the model did not write a valid ${path}: ${oneLine(problem).slice(0, 300)}` };
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
  const parsed = parseFileReply(text, original, path);
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
  const first = buildEditMessages({ intent: job.intent, directives: job.directives ?? [], antibodies: job.antibodies ?? [], history: job.history ?? [], lastReturn: job.lastReturn, guide: job.guide, declaredBy: job.declaredBy, rule: job.rule, path, content: original, violations });
  const maxTokens = maxTokensFor(original);
  let messages = first;
  let problem = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    await maybeHeartbeat(deps, cfg, job);
    const t0 = deps.now();
    const reply = await interruptible(deps, deps.model.complete({ model: cfg.model, messages, maxTokens }));
    countCall(deps, cfg, job, reply, deps.now() - t0);
    const text = reply.text ?? "";
    const v = judgeReply(job.rule, path, original, text, reply.finishReason);
    if (v.ok) {
      addCheck(job, { name: `recheck ${path}`, ok: true, ms: deps.now() - t0, detail: `${v.detail} (model ${cfg.model}, attempt ${attempt + 1})` });
      // Field guide: the first lesson an accepted reply leaves goes with the change.
      if (job.guide && job.lesson === undefined) {
        const lesson = parseLessonReply(text);
        if (lesson) job.lesson = lesson;
      }
      return { ok: true, content: v.content };
    }
    problem = v.problem;
    messages = retryMessages(first, text, problem);
  }
  addCheck(job, { name: `recheck ${path}`, ok: false, ms: 0, detail: problem });
  return { ok: false, reason: `the model did not produce a valid change for ${path}: ${problem}` };
}

/** Book one model call on the job (calls, tokens, time) and in the agent's counters. */
function countCall(deps: LoopDeps, cfg: AgentConfig, job: Job, reply: ModelReply, ms: number, asked?: string): void {
  job.llmCalls += 1;
  job.method = "model";
  const u = job.usage ?? { calls: 0, input: 0, output: 0, cached: 0, neurons: 0, ms: 0 };
  u.calls += 1;
  u.ms += reply.ms ?? ms;
  // A call to a model other than the agent's own (an intent that asks for one) is also counted under that model.
  const model = reply.model ?? asked ?? cfg.model;
  const other = model !== cfg.model ? model : null;
  if (reply.usage) {
    u.input += reply.usage.input;
    u.output += reply.usage.output;
    u.cached += reply.usage.cached;
    u.neurons += reply.usage.neurons;
    deps.journal.bump("tokensIn", reply.usage.input);
    deps.journal.bump("tokensOut", reply.usage.output);
    if (other) {
      deps.journal.bump(`tokensIn:${other}`, reply.usage.input);
      deps.journal.bump(`tokensOut:${other}`, reply.usage.output);
    }
  }
  job.usage = u;
  // Hedged calls (FT_HEDGE, colony/hedge.ts): which copy answered, for the usage check, kept with the job's usage.
  if (reply.hedged) job.hedged = [...(job.hedged ?? []), reply.hedged].slice(-MAX_HEDGED);
  save(deps, cfg, job);
  deps.journal.bump("llmCalls");
  if (other) deps.journal.bump(`llmCalls:${other}`);
  // Per intent too, where FT_INTENT_SPEND covers the colony: the colony prices each intent's calls from these rows.
  if (deps.intentSpend) deps.journal.bumpIntent?.(job.intentId, model, { input: reply.usage?.input ?? 0, output: reply.usage?.output ?? 0 }, deps.now());
  // A hedged call's losing copy that answered anyway spent tokens too: they count once it settles.
  if (reply.late) void reply.late.then((l) => (l?.usage ? countLate(deps, cfg, job.intentId, l.model, l.usage) : undefined), () => undefined);
}

/** Hedge records a job keeps. */
const MAX_HEDGED = 8;

/**
 * A hedged call's losing copy that answered anyway (FT_HEDGE): its call and tokens in the agent's counters, under its
 * model as countCall books them, and for its intent where FT_INTENT_SPEND covers the colony. The job's own usage is
 * left as it was: the job may have moved on.
 */
function countLate(deps: LoopDeps, cfg: AgentConfig, intentId: Id, model: string, usage: TokenUsage): void {
  try {
    deps.journal.bump("llmCalls");
    deps.journal.bump("tokensIn", usage.input);
    deps.journal.bump("tokensOut", usage.output);
    if (model !== cfg.model) {
      deps.journal.bump(`llmCalls:${model}`);
      deps.journal.bump(`tokensIn:${model}`, usage.input);
      deps.journal.bump(`tokensOut:${model}`, usage.output);
    }
    if (deps.intentSpend) deps.journal.bumpIntent?.(intentId, model, { input: usage.input, output: usage.output }, deps.now());
  } catch {
    // Counting never fails a call.
  }
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
  // Each question about the tree is settled: a virtual checkout's tree loads the directories it touches first.
  const facts = await tree.settle(() => specifierFacts(rule, path, original, tree));
  if (facts.length === 0) return { ok: true, content: original };
  const first = await tree.settle(() =>
    buildSpecifierMessages({ intent: job.intent, directives: job.directives ?? [], antibodies: job.antibodies ?? [], lastReturn: job.lastReturn, guide: job.guide, declaredBy: job.declaredBy, rule, path, content: original, facts, tree }),
  );
  let messages = first;
  let problems: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    await maybeHeartbeat(deps, cfg, job);
    const t0 = deps.now();
    const reply = await interruptible(deps, deps.model.complete({ model: cfg.model, messages, maxTokens: SPECIFIER_MAX_TOKENS }));
    countCall(deps, cfg, job, reply, deps.now() - t0);
    const text = reply.text ?? "";
    const parsed = parseSpecifierEdits(text);
    if (!parsed.ok) {
      problems = [reply.finishReason === "length" ? "the reply was cut off before </edits>; reply with only the <edits> block" : parsed.reason];
    } else {
      const applied = await tree.settle(() => applySpecifierEdits(rule, path, original, facts, parsed.edits, tree));
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
  if (job.checkout === "virtual" && !job.inlineSkipped) {
    // Inline: the blob ids and the changeset id are the commit (the journal keeps the files until the proposal is made).
    // A change the inline limits refuse, or one made after virtual checkouts were turned off, is committed and pushed.
    const change = deps.virtual?.on ? inlineChange(requireBase(job), changes) : ({ ok: false, reason: "virtual checkouts are off for this colony now" } as const);
    if (change.ok) {
      job.headSha = change.headSha;
      job.writeSet = change.writeSet;
      job.inline = true;
      return advance(deps, cfg, job, "propose");
    }
    job.inlineSkipped = change.reason;
    deps.journal.log({ at: deps.now(), intentId: job.intentId, step: "inline", ok: false, ms: 0, detail: `committing and pushing instead: ${change.reason}` });
    save(deps, cfg, job);
  }
  // The clone lives in durable storage, but make sure the base is still there after a restart.
  // (A virtual job's change that went the git way fetches its base into the clone here.)
  if (job.checkout === "virtual") deps.git.takeNetStats?.();
  const base = await deps.git.ensureBase({ remote: job.lease.trunk.remote, token: job.lease.trunk.token, baseSha: requireBase(job) });
  if (base.baseSha !== job.baseSha) throw new Error(`base ${job.baseSha} is no longer reachable`);
  if (job.checkout === "virtual") {
    const fetched = deps.git.takeNetStats?.();
    if (fetched && fetched.requests > 0) job.net = { ...job.net, fetch: fetched };
  }
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
      detail: `${job.writeModel ?? cfg.model}: ${u.calls} call(s), ${u.input} input / ${u.output} output tokens${u.cached ? ` (${u.cached} cached)` : ""}${u.neurons ? `, ${u.neurons.toFixed(1)} neurons` : ""}${job.hedged?.length ? `; ${hedgeSummary(job.hedged)}` : ""}`,
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
  if (job.checkout === "virtual") {
    const r = n?.reads;
    const parts = [r ? `${r.requests} object read(s) from the trunk repo (${kb(r.receivedBytes)}), ${r.hits ?? 0} from cache` : "no object reads"];
    parts.push(job.inline ? `proposed inline (${(job.writeSet ?? []).length} file(s), no clone, commit or push)` : `committed and pushed: ${job.inlineSkipped ?? "not inline"}`);
    out.push({ name: "agent virtual checkout", ok: true, ms: r?.ms ?? 0, detail: parts.join("; ").slice(0, 500) });
  }
  return out;
}

/**
 * The not-verified statement of a written change: what the agent checked (every file passed
 * syntax, the colony's rules and import resolution before it was proposed), what it read, and
 * what it did not run. Reviewers see the first 400 characters, so the facts come first.
 */
export function writeStatement(
  cfg: Pick<AgentConfig, "model">,
  job: Pick<Job, "rules" | "context" | "depsMissing" | "buildsOn" | "baseSha" | "lease" | "checks" | "writeModel" | "freshBase" | "rebasedOn">,
): string {
  const read = (job.context ?? []).map((c) => c.path);
  const erasable = (job.checks ?? []).some((c) => c.name.startsWith("write ") && (c.detail ?? "").includes("erasable TypeScript"));
  const parts = [
    // Review diffs are cut per file for length and end in "… (truncated)"; say up front that the files are whole.
    `Complete files (each parses); a diff ending in "… (truncated)" is a display limit, not the file. Checked by the agent before proposing: the colony's ${(job.rules ?? []).length} rule(s) hold${erasable ? ", the TypeScript is erasable (Node runs it by stripping types)" : ""}, and each relative import names a file in trunk or in this change and only names it exports. No tests, type checks or builds were run. Written by model ${job.writeModel ?? cfg.model} from the intent and its spec context.`,
    read.length > 0 ? `Built on the landed ${read.slice(0, 4).join(", ")}${read.length > 4 ? ` and ${read.length - 4} more` : ""}.` : "",
    (job.depsMissing ?? []).length > 0 ? `Not in trunk when written (built against the spec's contracts): ${(job.depsMissing ?? []).join(", ")}.` : "",
    (job.buildsOn ?? []).length > 0 && !job.freshBase && job.baseSha && job.baseSha !== job.lease.baseSha ? `Based on trunk ${job.baseSha}, the tip once those files had landed.` : "",
    rebaseStatement(job),
  ];
  return parts.filter(Boolean).join(" ");
}

/** The evidence sentence of a job a landing notice restarted on the trunk tip, or "". */
function rebaseStatement(job: Pick<Job, "freshBase" | "rebasedOn" | "baseSha" | "lease">): string {
  if (!job.freshBase || !job.baseSha || job.baseSha === job.lease.baseSha) return "";
  const landings = job.rebasedOn ?? [];
  return `Rebased on trunk ${job.baseSha} after ${landings.length > 0 ? `landing ${landings.join(", ")}` : "a landing"} changed files it covers; every file was read there.`;
}

async function proposeStep(deps: LoopDeps, cfg: AgentConfig, job: Job): Promise<StepResult> {
  const headSha = requireHead(job);
  let proposal: Proposal | undefined;
  if (job.attempts > 1) {
    // A previous attempt may have reached the colony before it was journaled.
    const recent = await deps.colony.inbox(cfg.agentId, 20, { proposalsOnly: true });
    proposal = recent.find((p) => !isInboxDirective(p) && p.intentId === job.intentId && p.headSha === headSha);
  }
  if (!proposal) {
    // An inline change carries the text of every file it writes, rebuilt from the journal (which keeps the files
    // until the job ends) and checked against the change's id before it goes.
    let contents: Record<Sha, string> | undefined;
    if (job.inline) {
      const change = inlineChange(requireBase(job), deps.journal.changes());
      if (!change.ok) return toGitPath(deps, cfg, job, change.reason);
      if (change.headSha !== headSha) return toGitPath(deps, cfg, job, "the journal's files no longer match the change's id");
      contents = change.contents;
    }
    // The files read as context belong in the read set: if one changes before landing, the change is re-checked.
    const readSet: FileVersion[] = [...(job.reads ?? []), ...(job.context ?? [])].filter((f) => f.text).map((f) => ({ path: f.path, blob: f.blob }));
    // Reviewers read the start of this statement (the decide stream's second opinion keeps 400 characters),
    // so for import rules it leads with what was and was not checked, naming any directory rewrites.
    const importEdit = isImportRule(job.rule) && job.method === "model";
    const dirs = job.directoryRewrites ?? [];
    const notVerified = job.method === "write" ? writeStatement(cfg, job) : [
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
      !job.baseFallback && !job.freshBase && job.baseSha && job.baseSha !== job.lease.baseSha && job.parentSha === job.baseSha
        ? `Based on trunk ${job.baseSha}, which the workspace already held; every footprint file matched current trunk when the work started.`
        : "",
      rebaseStatement(job),
    ]
      .filter(Boolean)
      .join(" ");
    try {
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
        // The revision this change was built on: the colony refuses it if the intent was revised since.
        intentRevision: job.intent.revision ?? 1,
        evidence: { checks: [...(job.checks ?? []), ...telemetryChecks(cfg, job), ...directionChecks(job)], notVerified },
        // With pushed outcomes the colony tells this agent when the proposal settles (no polling).
        ...(deps.outcome ? { notify: true } : {}),
        ...(contents ? { contents } : {}),
        // Field guide (FT_FIELD_GUIDE): the lesson the model left, a candidate until its gate passes.
        ...(job.lesson ? { lesson: job.lesson } : {}),
      });
    } catch (e) {
      // A colony that refuses the inline form (bad request, too large) gets the change committed and pushed instead.
      const status = errorStatus(e);
      if (contents && !(e instanceof Halt) && (status === 400 || status === 413 || status === 422)) {
        return toGitPath(deps, cfg, job, `the colony refused the inline change: ${errorMessage(e, 200)}`);
      }
      throw e;
    }
    deps.journal.bump("proposed");
  }
  job.proposalId = proposal.id;
  job.proposedAt = deps.now();
  job.pollMs = deps.outcome ? PUSH_FALLBACK_POLL_MS : FIRST_POLL_MS;
  job.lastStatus = proposal.status;
  if (TERMINAL_STATUSES.has(proposal.status)) return finishJob(deps, cfg, job, proposal.status as Outcome, proposal.reason);
  advance(deps, cfg, job, "await");
  return { sleepMs: job.pollMs };
}

/** Commit and push a virtual job's change instead of proposing it inline (the commit step's git path), saying why. */
function toGitPath(deps: LoopDeps, cfg: AgentConfig, job: Job, why: string): StepResult {
  deps.journal.log({ at: deps.now(), intentId: job.intentId, step: "inline", ok: false, ms: 0, detail: `committing and pushing instead: ${why}` });
  delete job.inline;
  delete job.headSha;
  delete job.writeSet;
  job.inlineSkipped = why;
  return advance(deps, cfg, job, "commit");
}

async function awaitStep(deps: LoopDeps, cfg: AgentConfig, job: Job): Promise<StepResult> {
  const id = job.proposalId;
  if (!id) throw new Error("await without a proposal id");
  // An outcome the colony pushed settles the job without asking it again.
  const pushed = deps.outcome?.(id) ?? null;
  if (pushed && TERMINAL_STATUSES.has(pushed.status as ProposalStatus)) return finishJob(deps, cfg, job, pushed.status as Outcome, pushed.reason);
  const p = await deps.colony.getProposal(id);
  if (!p) return finishJob(deps, cfg, job, "lost", "the colony no longer knows this proposal");
  if (TERMINAL_STATUSES.has(p.status)) return finishJob(deps, cfg, job, p.status as Outcome, p.reason);
  // An inline change waiting for a person needs nothing more of this agent (agents/personwait.ts): it takes other work.
  if (leavesToPerson(deps.personWait, job, p.status)) return finishJob(deps, cfg, job, AWAITING_PERSON, p.reason);
  const now = deps.now();
  if (now - (job.proposedAt ?? now) > AWAIT_TIMEOUT_MS) return finishJob(deps, cfg, job, "timeout", `still ${p.status} after ${AWAIT_TIMEOUT_MS / 60_000} minutes`);
  const prev = job.pollMs ?? FIRST_POLL_MS;
  job.pollMs = p.status === "escalated" ? ESCALATED_POLL_MS : deps.outcome ? PUSH_FALLBACK_POLL_MS : Math.min(MAX_POLL_MS, Math.round(prev * 1.6));
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
    // Virtual checkouts: how the job read trunk, what that cost, and whether its change went inline.
    checkout: job.checkout ?? "clone",
    inline: job.inline === true,
    inlineSkipped: job.inlineSkipped ? job.inlineSkipped.slice(0, 200) : null,
    objectReads: job.net?.reads?.requests ?? null,
    objectHits: job.net?.reads?.hits ?? null,
    objectBytes: job.net?.reads?.receivedBytes ?? null,
    objectMs: job.net?.reads?.ms ?? null,
    parent: job.parentHow ?? null,
    depsWaitMs: job.depsWaitedMs ?? 0,
    workspace: job.lease.repo.name,
  });
  deps.journal.setJob(null);
  deps.journal.log({ at: now, intentId: job.intentId, step: "done", ok: outcome === "landed", ms: now - job.takenAt, detail: reason ? `${outcome}: ${reason}` : outcome });
  return { sleepMs: outcome === "landed" ? 0 : Math.round(500 + (deps.rand ?? Math.random)() * 500) };
}

async function abandon(deps: LoopDeps, cfg: AgentConfig, job: Job, reason: string): Promise<StepResult> {
  try {
    // Closure ledger (colony/closure.ts): the loop's own give-up.
    await deps.colony.abandon(cfg.agentId, reason, "gave_up");
  } catch (e) {
    if (e instanceof Halt) throw e;
    deps.journal.log({ at: deps.now(), intentId: job.intentId, step: "abandon", ok: false, ms: 0, detail: errorMessage(e) });
  }
  finishJob(deps, cfg, job, "abandoned", reason);
  return { sleepMs: Math.round(ABANDON_PAUSE_MS * (0.75 + (deps.rand ?? Math.random)() * 0.5)) };
}

/**
 * The model reported that the intent cannot be done as written (an ESCALATE reply) instead of working
 * around it. The colony keeps the intent for a person and takes the claim and lease back (no failure
 * mark), and the job ends. A colony that cannot take the report (an older version, or a report on
 * the intent already open) gets the intent back as on a release, with the report as the reason.
 */
async function escalateJob(deps: LoopDeps, cfg: AgentConfig, job: Job, e: Escalation): Promise<StepResult> {
  const reason = `escalated (${e.kind}): ${oneLine(e.report).slice(0, 300)}`;
  // Called as a method: on a Durable Object stub, a detached function would name a remote property.
  const colony = deps.colony;
  if (colony.escalate) {
    try {
      await colony.escalate(cfg.agentId, { intentId: job.intentId, kind: e.kind, report: e.report });
      deps.journal.log({ at: deps.now(), intentId: job.intentId, step: "escalate", ok: true, ms: 0, detail: reason.slice(0, 500) });
      await relay(deps, cfg, job, `escalated "${oneLine(job.intent.title).slice(0, 60)}" to a person (${e.kind})`, true);
      return finishJob(deps, cfg, job, "escalated", reason);
    } catch (err) {
      if (err instanceof Halt) throw err;
      deps.journal.log({ at: deps.now(), intentId: job.intentId, step: "escalate", ok: false, ms: 0, detail: errorMessage(err) });
    }
  }
  return abandon(deps, cfg, job, `could not report it to a person, so the intent goes back: ${reason}`);
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
    if (deps.refreshClaims) {
      // Claims are refreshed in their regions directly; the colony only needs to know the agent is alive. A change
      // waiting for a person holds no files (agents/personwait.ts): its claims are left to go.
      if (!holdsNoFiles(deps.personWait, job)) await deps.refreshClaims(job);
      if (now - (job.lastColonyBeatAt ?? job.takenAt) >= COLONY_BEAT_EVERY_MS) {
        job.lastColonyBeatAt = now;
        await deps.colony.heartbeat(cfg.agentId, { claims: false });
      }
    } else {
      await deps.colony.heartbeat(cfg.agentId);
    }
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
        await deps.colony.abandon(c.agentId, `agent stopped: ${reason}`, "stopped");
      } catch {
        // Best effort: the colony reaps silent agents anyway.
      }
    }
  }
}


// ---------------------------------------------------------------------------
// Direction: directives the colony pushes, status notes the agent relays (agents/direction.ts)
// ---------------------------------------------------------------------------

/** Status notes go to the colony at most this often (synthetic agents seldom: they are load). */
export const RELAY_MIN_MS = 3_000;
export const SYNTHETIC_RELAY_MIN_MS = 60_000;
/** A status note that takes longer than this is left to finish on its own (the step goes on). */
const RELAY_WAIT_MS = 2_000;

/**
 * Keep a directive the colony pushed (AgentDO.direct) and say what the agent will do with it. A
 * withdrawal or revision of the current job's intent, or guidance while the job produces or proposes,
 * halts the step in flight (the epoch moves, the agent keeps running), so no more work goes the old
 * way; the next step acts on it (applyDirection).
 */
export function receiveDirective(journal: Journal, d: Directive, intent: Intent | undefined, now: number): { action: string; interrupted: boolean } {
  journal.setDirectives?.(holdDirective(journal.directives?.() ?? [], d, intent, now));
  const job = journal.job();
  const cfg = journal.config();
  const interrupted = !!cfg?.running && interrupts(d, job);
  if (interrupted && cfg) {
    cfg.epoch += 1;
    journal.setConfig(cfg);
  }
  const about = !!job && (d.intentId === undefined || d.intentId === job.intentId);
  let action: string;
  if (!job) action = d.kind === "guidance" ? "kept for the next job" : "noted (no job held)";
  else if (!about) action = d.kind === "guidance" ? `kept for intent ${d.intentId}` : "noted (not the current job)";
  else if (d.kind === "withdrawal") action = "stopping the job";
  else if (d.kind === "revision") action = `restarting at r${d.revision ?? "?"}`;
  else if (d.kind === "landing") action = job.step === "propose" || job.step === "await" ? "noted: the change is already proposed (the lane checks it against trunk)" : "re-reading the changed files on the new trunk";
  else if (interrupted) action = "re-planning with it";
  else if (job.step === "await") action = "recalling the proposal to redo it";
  else action = "folding it into the next prompt";
  return { action, interrupted };
}

/** Landing notices one job acts on at most (each restarts it on the trunk tip); later ones are left to the lane. */
export const MAX_REBASES = 2;

/**
 * Act on the first pending directive for this job (nextDirection). A withdrawal ends the job: the
 * colony already took the claim and lease back. A revision ends it too, and the next take hands back
 * the same intent at the new revision (the agent kept its claim and lease). A landing notice (files
 * the intent covers changed on trunk) restarts a job that has not proposed from fetch, on the trunk
 * tip, so it re-reads those files before it writes; a job that has proposed does nothing (the lane
 * checks its change against trunk), and neither does one taken after the notice came (its lease
 * already has the landing). Guidance joins the job's prompts; work already produced is redone with
 * it, after recalling a proposal still in flight. Returns the step result, or null to go on.
 */
async function applyDirection(deps: LoopDeps, cfg: AgentConfig, job: Job): Promise<StepResult | null> {
  if (!deps.journal.directives) return null;
  const held = nextDirection(deps.journal.directives(), job);
  if (!held) return null;
  const d = held.directive;
  const now = deps.now();
  const mark = (outcome: string): void => {
    guard(deps, cfg.epoch);
    deps.journal.setDirectives?.(markApplied(deps.journal.directives?.() ?? [], d.id, now, outcome));
  };
  deps.journal.log({ at: now, intentId: job.intentId, step: "direct", ok: true, ms: 0, detail: `${d.kind} ${d.id} from ${d.by}: ${d.message}` });
  if (d.kind === "withdrawal") {
    mark("stopped the job");
    await relay(deps, cfg, job, directiveNote(d, job.intent.title, ""), true);
    return finishJob(deps, cfg, job, "withdrawn", `intent withdrawn: ${d.message}`);
  }
  if (d.kind === "revision") {
    mark(`restarted at r${d.revision ?? "?"}`);
    await relay(deps, cfg, job, directiveNote(d, job.intent.title, ""), true);
    finishJob(deps, cfg, job, "redirected", `intent revised to r${d.revision ?? "?"}: ${d.message}`);
    return { sleepMs: 0 }; // take again now: the same intent comes back at its new revision
  }
  if (d.kind === "landing") {
    if (held.receivedAt < job.takenAt) {
      mark("noted: the job was taken after it, on a trunk that has the landing");
      return null;
    }
    if (job.step === "propose" || job.step === "await") {
      mark("already proposed: the lane checks the change against trunk");
      return null;
    }
    if (job.checkout === "virtual" ? !deps.virtual : !deps.git.fetchTip) {
      mark("noted: this agent cannot fetch the new trunk; the lane checks the change against it");
      return null;
    }
    if ((job.rebases ?? 0) >= MAX_REBASES) {
      mark(`noted: the job already started over ${MAX_REBASES} times; the lane checks the change against trunk`);
      return null;
    }
    rebase(deps, cfg, job, d);
    mark("re-reading the changed files on the new trunk");
    await relay(deps, cfg, job, directiveNote(d, job.intent.title, "re-reading them on the new trunk"), true);
    return { sleepMs: 0 };
  }
  if (d.kind !== "guidance") {
    mark(`noted (${d.kind})`);
    return null;
  }
  job.directives = withGuidance(job.directives, d);
  if (job.step === "deps" || job.step === "fetch" || job.step === "read") {
    mark("folded into the next prompt");
    save(deps, cfg, job);
    await relay(deps, cfg, job, directiveNote(d, job.intent.title, "folding it into the next prompt"), true);
    return null;
  }
  if (job.step === "propose" || job.step === "await") {
    const inFlight = await inFlightProposal(deps, cfg, job);
    if (inFlight) {
      let back: Proposal | null = null;
      try {
        back = deps.colony.recall ? await deps.colony.recall(cfg.agentId, inFlight, `directive ${d.id} from ${d.by}`) : null;
      } catch (e) {
        if (e instanceof Halt) throw e;
        deps.journal.log({ at: deps.now(), intentId: job.intentId, step: "recall", ok: false, ms: 0, detail: errorMessage(e) });
      }
      if (!back || back.status !== "returned") {
        // Decided already (or not recallable): the guidance stays with this intent for any later work on it.
        mark(`arrived after proposing (${back?.status ?? "not recalled"}); kept for later work on this intent`);
        save(deps, cfg, job);
        return null;
      }
    }
  }
  replan(deps, cfg, job);
  mark("re-planned: redoing the change with it");
  await relay(deps, cfg, job, directiveNote(d, job.intent.title, `redoing ${job.intent.footprint.slice(0, 2).join(", ")}`), true);
  return { sleepMs: 0 };
}

/** Redo the change from produce: what the job read stays, everything produced since goes. */
function replan(deps: LoopDeps, cfg: AgentConfig, job: Job): void {
  guard(deps, cfg.epoch);
  delete job.produced;
  delete job.checks;
  delete job.method;
  delete job.writeModel;
  delete job.headSha;
  delete job.writeSet;
  delete job.inline;
  delete job.inlineSkipped;
  delete job.summary;
  delete job.parentSha;
  delete job.parentHow;
  delete job.proposalId;
  delete job.proposedAt;
  delete job.pollMs;
  delete job.lastStatus;
  delete job.directoryRewrites;
  delete job.fileOverDirectory;
  delete job.lastError;
  job.step = "produce";
  job.attempts = 0;
  job.stepStartedAt = deps.now();
  deps.journal.setJob(null); // drops the old file contents with the old job
  deps.journal.setJob(job);
}

/**
 * Start the job over from fetch, on the trunk tip (freshBase): a landing changed files it covers, so
 * what it read, and anything it wrote from them, is out of date. The landing joins the job's
 * why-context, so the next prompt says why those files changed. A job still waiting for the files it
 * builds on keeps waiting (it fetches the tip once they land).
 */
function rebase(deps: LoopDeps, cfg: AgentConfig, job: Job, d: Directive): void {
  guard(deps, cfg.epoch);
  job.freshBase = true;
  job.rebases = (job.rebases ?? 0) + 1;
  if (d.landing) {
    job.history = withLanded(job.history, noticeEntry(d.landing, d.at));
    job.rebasedOn = [...new Set([...(job.rebasedOn ?? []), d.landing.landingId])].slice(-5);
    // Wait for the tip to show this landing (FT_ASYNC_PUBLISH can leave it behind for a moment): remember each file's
    // blob from before it, keeping the earliest known when several notices touch the same file.
    const before = { ...(job.awaitTip?.before ?? {}) };
    for (const p of Array.isArray(d.landing.paths) ? d.landing.paths : []) {
      if (typeof p?.path === "string" && !(p.path in before)) before[p.path] = p.before ?? null;
    }
    job.awaitTip = { before, since: deps.now() };
  }
  if (job.step === "deps") {
    deps.journal.setJob(job);
    return;
  }
  delete job.baseSha;
  delete job.baseFallback;
  delete job.reads;
  delete job.context;
  delete job.depsMissing;
  delete job.rules;
  delete job.produced;
  delete job.checks;
  delete job.method;
  delete job.writeModel;
  delete job.headSha;
  delete job.writeSet;
  delete job.inline;
  delete job.inlineSkipped;
  delete job.summary;
  delete job.parentSha;
  delete job.parentHow;
  delete job.directoryRewrites;
  delete job.fileOverDirectory;
  delete job.lastError;
  job.step = "fetch";
  job.attempts = 0;
  job.stepStartedAt = deps.now();
  deps.journal.setJob(null); // drops the files written from the old content
  deps.journal.setJob(job);
}

/** The job's proposal still in flight: its recorded id, else one the colony has for its head commit. */
async function inFlightProposal(deps: LoopDeps, cfg: AgentConfig, job: Job): Promise<Id | null> {
  if (job.proposalId) return job.proposalId;
  if (!job.headSha) return null;
  try {
    const recent = await deps.colony.inbox(cfg.agentId, 20, { proposalsOnly: true });
    return recent.find((p) => !isInboxDirective(p) && p.intentId === job.intentId && p.headSha === job.headSha && !TERMINAL_STATUSES.has(p.status))?.id ?? null;
  } catch (e) {
    if (e instanceof Halt) throw e;
    return null;
  }
}

/** A new job starts with the guidance held for its intent (and any not tied to an intent yet); it counts as applied. */
async function adoptGuidance(deps: LoopDeps, cfg: AgentConfig, job: Job, now: number): Promise<void> {
  const held = deps.journal.directives?.() ?? [];
  let guidance = guidanceFor(held, job.intentId);
  // Guidance sent to another agent about this intent counts too (the intent may have changed hands).
  // Synthetic agents skip the call: they are load and write no prompts.
  if (cfg.kind === "internal" && deps.colony.guidance) {
    try {
      const theirs = await deps.colony.guidance(job.intentId);
      const ids = new Set(guidance.map((g) => g.id));
      guidance = [...guidance, ...theirs.filter((g) => !ids.has(g.id))].sort((a, b) => a.at - b.at).slice(-MAX_GUIDANCE);
    } catch (e) {
      if (e instanceof Halt) throw e;
      // Best effort: the agent's own directives still apply.
    }
  }
  if (guidance.length === 0) return;
  job.directives = guidance;
  let list = held;
  for (const g of guidance) list = markApplied(list, g.id, now, "given to the job's prompts");
  deps.journal.setDirectives?.(list);
}

/**
 * Relay what the job is doing as it enters a step: only a changed note, at most every RELAY_MIN_MS.
 * An LLM agent's propose step always relays (when the note changed): the colony records it with the change.
 */
async function relayStep(deps: LoopDeps, cfg: AgentConfig, job: Job): Promise<void> {
  const note = stepNote(job);
  await relay(deps, cfg, job, note, job.step === "propose" && cfg.kind !== "synthetic" && note !== job.relayedNote);
}

async function relay(deps: LoopDeps, cfg: AgentConfig, job: Job, note: string, force: boolean): Promise<void> {
  // Called as a method: on a Durable Object stub, `relay.bind` would name a remote property, not Function.prototype.bind.
  const colony = deps.colony;
  if (!colony.relay) return;
  const now = deps.now();
  if (!force && (job.relayedNote === note || now - (job.relayedAt ?? 0) < (cfg.kind === "synthetic" ? SYNTHETIC_RELAY_MIN_MS : RELAY_MIN_MS))) return;
  job.relayedNote = note;
  job.relayedAt = now;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([colony.relay(cfg.agentId, note), new Promise((resolve) => (timer = setTimeout(resolve, RELAY_WAIT_MS)))]);
  } catch (e) {
    if (e instanceof Halt) throw e;
    // Best effort: a lost note only means the colony shows an older one.
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Evidence of the human guidance the change was written with (the colony records the same in its direction). */
function directionChecks(job: Job): CheckResult[] {
  const list = job.directives ?? [];
  if (list.length === 0) return [];
  const detail = list.map((g) => `${g.id} from ${g.by}: "${g.message.replace(/\s+/g, " ").slice(0, 160)}"`).join("; ");
  return [{ name: "directives", ok: true, ms: 0, detail: `given to the model with the intent: ${detail}`.slice(0, 1_000) }];
}
