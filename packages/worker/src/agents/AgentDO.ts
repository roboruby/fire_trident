import { DurableObject } from "cloudflare:workers";
import type { AgentInfo, AgentKind, Directive, Id, Intent } from "@fire_trident/core";
import { trunkRepoName } from "../artifacts/shards.ts";
import { colonyStorage } from "../artifacts/storage.ts";
import { colonyModelsOf } from "../cloudflare/models.ts";
import type { Env } from "../env.ts";
import { WorkspaceGit } from "./gitfs.ts";
import { SqlJournal } from "./journal.ts";
import { modelClient, resolveModel } from "./llm.ts";
import { DEFAULT_TICK_BUDGET_MS, agentState, receiveDirective, stopAgent, tick } from "./loop.ts";
import type { AgentConfig, AgentIntentUsage, HistoryEntry, Job, JobStep, LoopDeps, ModelClient, StepLogEntry } from "./loop.ts";
import { intentSpendEnabled } from "../colony/intentspend.ts";
import { hedgeFor } from "../colony/hedge.ts";
import { agentCapGate, cappedClient, type CapMemo } from "../colony/spendcap.ts";
import { OutcomeBox, regionNames, type ClaimRefresher, type PushedOutcome } from "./outcomes.ts";
import { colonyStub, errorMessage, trunkBlobsStub } from "./rpc.ts";
import type { AgentStartParams } from "./rpc.ts";
import { SHARED_OBJECTS, VirtualReads, trunkObjects, virtualCheckoutEnabled } from "./virtual.ts";
import { personWaitOn } from "../colony/personwait.ts";
import { recordLeftOutcome } from "./personwait.ts";
import { WATCHDOG_MS, busyAlarmAt } from "./watchdog.ts";

/** Longest first-step delay a caller may ask for. */
const MAX_START_DELAY_MS = 60_000;
/**
 * Recycle the local clone after this many finished jobs (reclaims storage). Until then
 * the clone is kept across jobs: its objects make each trunk fetch incremental and let a
 * push to a workspace this agent used before carry only the new objects.
 */
const RESET_CLONE_EVERY = 200;
/** When the colony owner's model access could not be read (a connection object that did not answer), try again after this. */
const OWNER_MODELS_RETRY_MS = 30_000;

/** AgentInfo plus the agent's own view of its work. Tokens never appear here. */
export interface AgentStatus extends AgentInfo {
  running: boolean;
  step?: JobStep;
  intentTitle?: string;
  attempts?: number;
  proposalId?: Id;
  counters: Record<string, number>;
  lastError?: string;
  stopReason?: string;
  history: HistoryEntry[];
  steps: StepLogEntry[];
  /** Model calls by intent and model (spend per intent, FT_INTENT_SPEND); absent when none was counted. */
  intentUsage?: AgentIntentUsage[];
}

/**
 * An in-platform agent. It loops take -> fetch -> read -> produce -> commit -> push
 * -> propose -> await, driven by Durable Object alarms, with every step journaled
 * in its SQLite database (see loop.ts). Git runs inside the object on a
 * `@cloudflare/computer` Workspace, or, with FT_VIRTUAL_CHECKOUT, not at all: trunk is
 * read object by object through the binding and changes go inline (virtual.ts); edits come from the rule's deterministic
 * replacement (synthetic agents) or a model (Workers AI, or Anthropic for
 * `claude-*` ids when ANTHROPIC_API_KEY is set). The agent emits no events; the
 * colony does.
 *
 * A plain Durable Object rather than the Agents SDK `Agent` class: the loop owns
 * the alarm (watchdog plus next step), and a step can wait minutes on a model,
 * which the SDK scheduler treats as a hung job.
 */
export class AgentDO extends DurableObject<Env> {
  private readonly journal: SqlJournal;
  private git: WorkspaceGit | null = null;
  private ticking = false;
  /** The alarm the running tick chose for its next step, once it chose one (null while its step runs; agents/watchdog.ts). */
  private chosenAt: number | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.journal = new SqlJournal(ctx.storage.sql);
    this.outcomes = new OutcomeBox(ctx.storage.sql);
  }

  /** Outcomes the colony pushed (outcome()), read by the await step instead of polling. */
  private outcomes: OutcomeBox;
  /** The running tick's interrupt: aborted by direct() when a directive halts the step in flight. */
  private stepAbort: AbortController | null = null;
  /** An outcome arrived while a tick ran: run the next tick at once. */
  private wake = false;
  /** Region depth per colony (claims are refreshed in their regions directly). */
  private readonly depths = new Map<Id, number>();
  /** The trunk repo handle of the running tick (virtual checkouts), released when the tick ends. */
  private trunkRepo: { release(): void } | null = null;
  /** What this agent last heard of its colony's spend cap (colony/spendcap.ts agentCapGate). */
  private readonly capMemo: CapMemo = { capped: null };

  /**
   * The model client of one tick. Hedged calls (FT_HEDGE, colony/hedge.ts): copies to the same model, counted in this
   * agent's journal. Spend cap (colony/spendcap.ts): each call reserved with the colony before it starts (twice when a
   * copy may go out) and settled after; with no cap the colony says so and the call goes as before.
   */
  private modelFor(colonyId: Id, models: Env = this.env): ModelClient {
    const hedge = hedgeFor(this.env, colonyId, "agent", { bump: (name, delta) => this.journal.bump(name, delta) });
    return cappedClient(modelClient(models, hedge), agentCapGate(colonyStub(this.env, colonyId), this.journal.config()?.agentId ?? "", this.capMemo), hedge ? 2 : 1);
  }

  /**
   * `models`: the env the tick's model calls read. The deployment's own (Workers AI) for an operator colony; for a colony
   * a person owns, their Workers AI (cloudflare/models.ts), read by alarm() before the tick.
   */
  private deps(colonyId: Id, models: Env = this.env): LoopDeps {
    if (!this.git) this.git = new WorkspaceGit(this.ctx.storage);
    // One per tick: direct() aborts it when a directive makes the step in flight moot.
    this.stepAbort = new AbortController();
    // Virtual checkouts read trunk by object id through the binding: the handle opens on a job's first read. Every
    // tick gets the reader, so a job taken with it keeps reading through it even after FT_VIRTUAL_CHECKOUT turns off.
    this.trunkRepo?.release();
    // The trunk binding: the deployment's own, or the Cloudflare account of the colony's owner (artifacts/storage.ts).
    const objects = trunkObjects(colonyStorage(this.env, this.journal.config()?.owner).trunk, trunkRepoName(colonyId));
    this.trunkRepo = objects;
    return {
      signal: this.stepAbort.signal,
      colony: colonyStub(this.env, colonyId),
      trunk: trunkBlobsStub(this.env, colonyId),
      git: this.git,
      model: this.modelFor(colonyId, models),
      journal: this.journal,
      now: () => Date.now(),
      log: (line) => console.log(`agent ${this.journal.config()?.agentId ?? "?"}: ${line}`),
      metric: (record) => console.log(JSON.stringify({ ft: "agent-job", ...record })),
      outcome: (proposalId) => this.outcomes.get(proposalId),
      refreshClaims: (job) => this.refreshClaims(colonyId, job),
      virtual: { on: virtualCheckoutEnabled(this.env.FT_VIRTUAL_CHECKOUT, colonyId), reads: new VirtualReads(objects, SHARED_OBJECTS) },
      // Spend per intent (colony/intentspend.ts): each call counted under the job's intent too, where the flag covers the colony.
      intentSpend: intentSpendEnabled(this.env.FT_INTENT_SPEND, colonyId),
      // Changes waiting for a person hold no files (colony/personwait.ts), where the flag covers the colony.
      personWait: personWaitOn(this.env.FT_PERSON_WAIT, colonyId),
      // The models a spec intent's Model line may name besides the classes and the price list (agents/modelline.ts).
      models: { default: this.env.FT_DEFAULT_MODEL, bulk: this.env.FT_BULK_MODEL },
    };
  }

  /**
   * The colony pushes a proposal's outcome here (landed, returned, rejected, escalated) when this
   * agent proposed with `notify`. It is kept and the loop wakes at once, so a waiting agent learns
   * its outcome without polling. Outcomes for a proposal the agent no longer waits on are ignored.
   */
  async outcome(o: PushedOutcome): Promise<{ accepted: boolean }> {
    const job = this.journal.job();
    const cfg = this.journal.config();
    // A change this agent left with a person (agents/personwait.ts): its final outcome is recorded in the journal.
    if (job?.proposalId !== o?.proposalId && recordLeftOutcome(this.journal, o, Date.now())) return { accepted: true };
    if (!cfg?.running || !job || job.proposalId !== o?.proposalId) return { accepted: false };
    if (!this.outcomes.put(o, Date.now())) return { accepted: false };
    if (this.ticking) this.wake = true;
    else await this.ctx.storage.setAlarm(Date.now());
    return { accepted: true };
  }

  /**
   * Heartbeat for claims, straight to the regions of the job's footprint (RegionDO.refreshClaims
   * re-dates existing claims only). A region that cannot (an older version mid-deploy) gets the
   * refresh through the colony's heartbeat instead.
   */
  private async refreshClaims(colonyId: Id, job: Job): Promise<void> {
    const cfg = this.journal.config();
    if (!cfg) return;
    let depth = this.depths.get(colonyId);
    if (depth === undefined) {
      const colony = await colonyStub(this.env, colonyId).getColony();
      depth = colony?.regionDepth ?? 1;
      this.depths.set(colonyId, depth);
    }
    const ns = this.env.REGION;
    try {
      await Promise.all(
        regionNames(colonyId, job.intent.footprint ?? [], depth).map((name) =>
          (ns.get(ns.idFromName(name)) as unknown as ClaimRefresher).refreshClaims({ agentId: cfg.agentId, intentIds: [job.intentId] }),
        ),
      );
    } catch (e) {
      console.warn(`agent ${cfg.agentId}: claim refresh in the regions failed (${errorMessage(e)}); refreshing through the colony`);
      await colonyStub(this.env, colonyId).heartbeat(cfg.agentId);
    }
  }

  /** Start (or restart) the loop. Idempotent while running with the same agent. */
  async start(p: AgentStartParams): Promise<AgentStatus> {
    if (!p || typeof p.colonyId !== "string" || !p.colonyId || typeof p.agentId !== "string" || !p.agentId) {
      throw new Error("[ft:400] start needs colonyId and agentId");
    }
    const named = this.ctx.id.name;
    if (named && named !== p.agentId) throw new Error(`[ft:400] this agent object is ${named}, not ${p.agentId}`);
    const kind: AgentKind = p.kind === "synthetic" ? "synthetic" : "internal";
    const model = resolveModel(this.env, p.model);
    const now = Date.now();
    const prev = this.journal.config();
    if (prev && prev.running && prev.agentId === p.agentId && prev.colonyId === p.colonyId) {
      if (prev.model !== model || prev.kind !== kind) {
        prev.model = model;
        prev.kind = kind;
        this.journal.setConfig(prev);
      }
      if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(now);
      return this.status();
    }
    if (prev && prev.agentId !== p.agentId) this.journal.setJob(null);
    // The colony's owner, learned at start and kept (a restart for the same colony that names none keeps the one known).
    const owner = typeof p.owner === "string" && p.owner !== "" ? p.owner : prev?.colonyId === p.colonyId ? prev.owner : undefined;
    const cfg: AgentConfig = {
      colonyId: p.colonyId,
      agentId: p.agentId,
      name: (p.name ?? "").trim() || prev?.name || p.agentId,
      kind,
      model,
      running: true,
      epoch: (prev?.epoch ?? 0) + 1,
      startedAt: now,
      failures: 0,
      ...(owner ? { owner } : {}),
    };
    this.journal.setConfig(cfg);
    const delay = Math.min(MAX_START_DELAY_MS, Math.max(0, Math.floor(p.delayMs ?? 0)));
    await this.ctx.storage.setAlarm(now + delay);
    return this.status();
  }

  /** Stop the loop. A claimed intent is given back; a pending proposal stands. */
  async stop(reason = "stopped by request"): Promise<AgentStatus> {
    const cfg = this.journal.config();
    if (cfg && cfg.running) await stopAgent({ colony: colonyStub(this.env, cfg.colonyId), journal: this.journal, now: () => Date.now() }, reason);
    await this.ctx.storage.deleteAlarm();
    return this.status();
  }

  /**
   * Erase this agent (colony deletion, after stop): cancel the alarm and delete all storage
   * (journal and local clone). The journal tables are recreated empty, so status() keeps
   * answering as an agent that never started; the clone is rebuilt on next use.
   */
  async destroy(): Promise<{ cleared: true }> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    new SqlJournal(this.ctx.storage.sql); // the journal's constructor creates its tables
    this.outcomes = new OutcomeBox(this.ctx.storage.sql);
    this.git = null;
    return { cleared: true };
  }

  /**
   * A directive pushed by the colony: human guidance, a revision or withdrawal of an intent this agent
   * holds, or a landing notice (files its intent covers changed on trunk). It is kept in the journal
   * and acted on at the next step (loop.ts receiveDirective and applyDirection); a step working the old
   * way is halted, and a sleeping agent wakes at once.
   */
  async direct(p: { directive: Directive; intent?: Intent }): Promise<{ received: true; action: string; step?: JobStep }> {
    const d = p?.directive;
    if (!d || typeof d.id !== "string" || typeof d.kind !== "string" || typeof d.message !== "string") throw new Error("[ft:400] direct needs a directive");
    const cfg = this.journal.config();
    if (cfg && d.agentId && d.agentId !== cfg.agentId) throw new Error(`[ft:400] this agent is ${cfg.agentId}, not ${d.agentId}`);
    const r = receiveDirective(this.journal, d, p.intent, Date.now());
    // The epoch moved: drop a model call the step waits on rather than wait for a reply that no longer matters.
    if (r.interrupted) this.stepAbort?.abort();
    if (cfg?.running) {
      if (this.ticking) this.wake = true;
      else await this.ctx.storage.setAlarm(Date.now());
    }
    const job = this.journal.job();
    return { received: true, action: r.action, ...(job ? { step: job.step } : {}) };
  }

  /** What the agent is doing (no tokens). */
  async status(): Promise<AgentStatus> {
    const cfg = this.journal.config();
    const job = this.journal.job();
    const out: AgentStatus = {
      id: cfg?.agentId ?? this.ctx.id.name ?? "",
      colonyId: cfg?.colonyId ?? "",
      kind: cfg?.kind ?? "internal",
      name: cfg?.name ?? this.ctx.id.name ?? "",
      thresholds: {},
      state: agentState(cfg, job),
      lastSeen: Date.now(),
      running: cfg?.running ?? false,
      counters: this.journal.counters(),
      history: this.journal.history(10),
      steps: this.journal.steps(20),
    };
    // Spend per intent (FT_INTENT_SPEND): the colony's spend book reads these rows with the counters.
    const intentUsage = this.journal.intentUsage();
    if (intentUsage.length > 0) out.intentUsage = intentUsage;
    if (cfg?.model) out.model = cfg.model;
    if (cfg?.lastError) out.lastError = cfg.lastError;
    if (cfg?.stopReason) out.stopReason = cfg.stopReason;
    if (job) {
      out.intentId = job.intentId;
      out.intentTitle = job.intent.title;
      out.step = job.step;
      out.attempts = job.attempts;
      if (job.proposalId) out.proposalId = job.proposalId;
      if (job.lastError) out.lastError = job.lastError;
    }
    return out;
  }

  /** One tick of the loop: runs steps until one sleeps, then re-arms the alarm. */
  async alarm(): Promise<void> {
    const cfg = this.journal.config();
    if (!cfg || !cfg.running) return;
    if (this.ticking) {
      // Only a tick the runtime gave up on still runs here (agents/watchdog.ts): wait for it a minute, not a second.
      await this.ctx.storage.setAlarm(busyAlarmAt(Date.now(), this.chosenAt));
      return;
    }
    // A colony a person owns: its agents' models run on the owner's Workers AI (cloudflare/models.ts). Without it the
    // agent stops with the sentence that says why; a connection that could not be read is tried again shortly.
    let models: Env = this.env;
    if (cfg.owner) {
      try {
        const owned = await colonyModelsOf(this.env, cfg.colonyId, cfg.owner);
        if (owned.off) {
          await this.stop(owned.off);
          return;
        }
        models = owned.env;
      } catch (e) {
        console.warn(`agent ${cfg.agentId}: the colony owner's model access was not read (${errorMessage(e)}); trying again in 30 s`);
        await this.ctx.storage.setAlarm(Date.now() + OWNER_MODELS_RETRY_MS);
        return;
      }
    }
    this.ticking = true;
    this.chosenAt = null;
    try {
      await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_MS);
      const finishedBefore = this.finishedJobs();
      let sleepMs: number | null;
      try {
        sleepMs = (await tick(this.deps(cfg.colonyId, models), DEFAULT_TICK_BUDGET_MS)).sleepMs;
      } catch (e) {
        // A bug, not a step failure (those are journaled inside tick): back off and try again.
        console.error(`agent ${cfg.agentId} tick failed: ${errorMessage(e)}`);
        sleepMs = 15_000;
      }
      const finished = this.finishedJobs();
      if (this.git && finished !== finishedBefore && finished % RESET_CLONE_EVERY === 0 && !this.journal.job()) {
        await this.git.reset().catch(() => undefined);
      }
      // An outcome pushed during the tick: act on it now instead of after the step's sleep.
      if (this.wake) {
        this.wake = false;
        sleepMs = 0;
      }
      // A start() during the tick bumps the epoch (the tick halts) but leaves the agent running.
      if (this.journal.config()?.running) {
        this.chosenAt = Date.now() + Math.max(0, sleepMs ?? 0);
        await this.ctx.storage.setAlarm(this.chosenAt);
      } else await this.ctx.storage.deleteAlarm();
    } finally {
      this.ticking = false;
      this.trunkRepo?.release();
      this.trunkRepo = null;
    }
  }

  private finishedJobs(): number {
    const c = this.journal.counters();
    return (c.landed ?? 0) + (c.returned ?? 0) + (c.rejected ?? 0) + (c.abandoned ?? 0) + (c.timeout ?? 0) + (c.lost ?? 0) + (c.escalated ?? 0);
  }
}
