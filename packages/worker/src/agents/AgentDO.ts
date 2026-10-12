import { DurableObject } from "cloudflare:workers";
import type { AgentInfo, AgentKind, Id } from "@fire_trident/core";
import type { Env } from "../env.ts";
import { WorkspaceGit } from "./gitfs.ts";
import { SqlJournal } from "./journal.ts";
import { modelClient, resolveModel } from "./llm.ts";
import { DEFAULT_TICK_BUDGET_MS, agentState, stopAgent, tick } from "./loop.ts";
import type { AgentConfig, HistoryEntry, JobStep, LoopDeps, StepLogEntry } from "./loop.ts";
import { colonyStub, errorMessage, trunkBlobsStub } from "./rpc.ts";
import type { AgentStartParams } from "./rpc.ts";

/** Re-arm time set at the start of every tick, so a killed tick resumes within a minute. */
const WATCHDOG_MS = 60_000;
/** Longest first-step delay a caller may ask for. */
const MAX_START_DELAY_MS = 60_000;
/**
 * Recycle the local clone after this many finished jobs (reclaims storage). Until then
 * the clone is kept across jobs: its objects make each trunk fetch incremental and let a
 * push to a workspace this agent used before carry only the new objects.
 */
const RESET_CLONE_EVERY = 200;

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
}

/**
 * An in-platform agent. It loops take -> fetch -> read -> produce -> commit -> push
 * -> propose -> await, driven by Durable Object alarms, with every step journaled
 * in its SQLite database (see loop.ts). Git runs inside the object on a
 * `@cloudflare/computer` Workspace; edits come from the rule's deterministic
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

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.journal = new SqlJournal(ctx.storage.sql);
  }

  private deps(colonyId: Id): LoopDeps {
    if (!this.git) this.git = new WorkspaceGit(this.ctx.storage);
    return {
      colony: colonyStub(this.env, colonyId),
      trunk: trunkBlobsStub(this.env, colonyId),
      git: this.git,
      model: modelClient(this.env),
      journal: this.journal,
      now: () => Date.now(),
      log: (line) => console.log(`agent ${this.journal.config()?.agentId ?? "?"}: ${line}`),
      metric: (record) => console.log(JSON.stringify({ ft: "agent-job", ...record })),
    };
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
      await this.ctx.storage.setAlarm(Date.now() + 1_000);
      return;
    }
    this.ticking = true;
    try {
      await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_MS);
      const finishedBefore = this.finishedJobs();
      let sleepMs: number | null;
      try {
        sleepMs = (await tick(this.deps(cfg.colonyId), DEFAULT_TICK_BUDGET_MS)).sleepMs;
      } catch (e) {
        // A bug, not a step failure (those are journaled inside tick): back off and try again.
        console.error(`agent ${cfg.agentId} tick failed: ${errorMessage(e)}`);
        sleepMs = 15_000;
      }
      const finished = this.finishedJobs();
      if (this.git && finished !== finishedBefore && finished % RESET_CLONE_EVERY === 0 && !this.journal.job()) {
        await this.git.reset().catch(() => undefined);
      }
      // A start() during the tick bumps the epoch (the tick halts) but leaves the agent running.
      if (this.journal.config()?.running) await this.ctx.storage.setAlarm(Date.now() + Math.max(0, sleepMs ?? 0));
      else await this.ctx.storage.deleteAlarm();
    } finally {
      this.ticking = false;
    }
  }

  private finishedJobs(): number {
    const c = this.journal.counters();
    return (c.landed ?? 0) + (c.returned ?? 0) + (c.rejected ?? 0) + (c.abandoned ?? 0) + (c.timeout ?? 0) + (c.lost ?? 0);
  }
}
