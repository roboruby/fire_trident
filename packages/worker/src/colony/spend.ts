import { colonySpend, modelPrice } from "@fire_trident/core";
import type { ColonySpend, Id, LayerUsage, SpendLayer } from "@fire_trident/core";
import type { Env } from "../env.ts";
import { modelClient } from "../agents/llm.ts";
import type { ModelClient } from "../agents/loop.ts";
import { extractUsage } from "../agents/prompt.ts";
import type { AiRunner } from "../decide/reflex.ts";
import type { Hedge } from "./hedge.ts";
import type { SqlRunner } from "./inline.ts";
import { agentIntentUsage, migrateIntentSpend, storeAgentIntents } from "./intentspend.ts";

/**
 * Model spend, live, per colony (GET /api/colonies/:id/metrics and the colony's status carry it as `spend`). Every model
 * call the platform makes is counted where it happens, and core/pricing.ts prices the tokens at Workers AI list prices:
 *
 * - agents: each in-platform agent counts its calls and tokens in its own journal (agents/loop.ts countCall), with
 *   `tokensIn:<model>` and the like for calls to a model other than its own. The colony reads those journals
 *   (AgentDO.status) into its own table, so a finished run's spend stays readable: an agent's journal is read again
 *   while it may still spend, and is final once its loop stopped and the agent has been quiet for SETTLE_MS.
 * - review (the decide stage's reflex and second opinion), contest judging, the conflict resolver and antibody minting
 *   count in the colony's metrics, per model: `<prefix>.tokensIn:<model>` and `<prefix>.tokensOut:<model>`
 *   (SPEND_PREFIXES), beside the aggregate counters that existed before them (decide.llm.tokensIn and tokensOut, which the
 *   contest judge's calls share, and decide.clef.tokens). What an aggregate holds beyond its per-model counters came
 *   before them, and is priced at the model the layer is configured with: the reflex model for Clef's, and the dearest of
 *   the second-opinion models for the second opinion's and the judge's, as the demo scripts priced them (an upper bound).
 *
 * Read-only reporting: nothing here changes what agents or the decide stage do.
 */

/** The per-model counter prefixes the colony object keeps, and the layer each belongs to. */
export const SPEND_PREFIXES = {
  "decide.llm": "review",
  "decide.clef": "review",
  "contest.judge": "judge",
  resolver: "resolver",
  "decide.antibody": "other",
} as const satisfies Record<string, SpendLayer>;

/** One prefix of SPEND_PREFIXES. */
export type SpendPrefix = keyof typeof SPEND_PREFIXES;

/** Journals read per refresh at most, and at once. */
const MAX_READS = 256;
const READ_CONCURRENCY = 16;
/** One journal read may take this long; past it the agent's last read stands. */
const READ_TIMEOUT_MS = 3_000;
/** A report waits this long for the refresh it started; what the refresh reads later is in the next report. */
const REPORT_WAIT_MS = 2_000;
/** An agent's journal is read again at most this often while the agent may still spend... */
export const READ_EVERY_MS = 15_000;
/** ...and is final once its loop stopped and nothing was heard of it for this long (a model call in flight when it stopped can take three minutes). */
export const SETTLE_MS = 5 * 60_000;
/** Longest model id a counter name keeps. */
const MAX_MODEL = 200;

/** A model id as a counter name keeps it: one line, at most MAX_MODEL characters ("unknown" when empty). */
export function modelKey(model: unknown): string {
  const m = typeof model === "string" ? model.replace(/\s+/g, " ").trim().slice(0, MAX_MODEL) : "";
  return m === "" ? "unknown" : m;
}

/** A finite, non-negative whole number, or 0. */
function count(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/** The per-model counters (name, delta) for one call's tokens; none for a call that reported no tokens. */
export function spendCounters(prefix: SpendPrefix, model: string, usage: { input?: number; output?: number } | null | undefined): Array<[string, number]> {
  if (!usage) return [];
  const m = modelKey(model);
  const out: Array<[string, number]> = [];
  if (count(usage.input) > 0) out.push([`${prefix}.tokensIn:${m}`, count(usage.input)]);
  if (count(usage.output) > 0) out.push([`${prefix}.tokensOut:${m}`, count(usage.output)]);
  return out;
}

/** The Workers AI binding with each call's tokens counted under `prefix`, per model. The answer passes through untouched. */
export function meteredAi(ai: AiRunner, prefix: SpendPrefix, bump: (name: string, delta: number) => void): AiRunner {
  return {
    run: async (model, input, options) => {
      const res = await (options === undefined ? ai.run(model, input) : ai.run(model, input, options));
      try {
        for (const [name, delta] of spendCounters(prefix, model, extractUsage(res))) bump(name, delta);
      } catch {
        // Counting never fails a call.
      }
      return res;
    },
  };
}

/**
 * A model client with each reply's tokens counted under `prefix`, per model (the one that answered). The reply passes
 * through untouched. A hedged call's losing copy (FT_HEDGE, colony/hedge.ts) counts too, under its own model, once it
 * settles with usage.
 */
export function meteredClient(client: ModelClient, prefix: SpendPrefix, bump: (name: string, delta: number) => void): ModelClient {
  return {
    complete: async (req) => {
      const reply = await client.complete(req);
      try {
        for (const [name, delta] of spendCounters(prefix, reply.model ?? req.model, reply.usage)) bump(name, delta);
      } catch {
        // Counting never fails a call.
      }
      if (reply.late) {
        void reply.late.then(
          (l) => {
            try {
              if (l) for (const [name, delta] of spendCounters(prefix, l.model, l.usage)) bump(name, delta);
            } catch {
              // Counting never fails a call.
            }
          },
          () => undefined,
        );
      }
      return reply;
    },
  };
}

/** The conflict resolver's model client: the one agents use (agents/llm.ts), with its calls counted under `resolver`; `hedge`: FT_HEDGE. */
export function resolverClient(env: Parameters<typeof modelClient>[0], bump: (name: string, delta: number) => void, hedge?: Hedge | null): ModelClient {
  return meteredClient(modelClient(env, hedge), "resolver", bump);
}

/**
 * A hedged decide call's losing copy that answered anyway (FT_HEDGE, colony/hedge.ts), counted where the decide stage
 * counts its winner's tokens: Clef's (`decide.clef`: input tokens) or the second opinion's (`decide.llm`), in the
 * aggregate counters, per model, and for the proposal's intent (spend per intent). A result with no usage counts nothing.
 */
export function lateDecideSpend(
  host: { bump(name: string, delta: number): void; countIntentCall?(intentId: Id, layer: "review" | "judge", model: string, usage: { input?: number; output?: number } | null): void },
  prefix: "decide.clef" | "decide.llm",
  intentId: Id,
): (model: string, result: unknown) => void {
  return (model, result) => {
    const u = extractUsage(result);
    if (!u) return;
    const usage = prefix === "decide.clef" ? { input: u.input } : { input: u.input, output: u.output };
    if (prefix === "decide.clef") host.bump("decide.clef.tokens", count(u.input));
    else {
      host.bump("decide.llm.tokensIn", count(u.input));
      host.bump("decide.llm.tokensOut", count(u.output));
    }
    for (const [name, delta] of spendCounters(prefix, model, usage)) host.bump(name, delta);
    host.countIntentCall?.(intentId, "review", model, usage);
  };
}

/** A model id as priced: "default" and "bulk" are the models they name on this server; any other id as given. */
export function modelOfClass(env: Partial<Pick<Env, "FT_DEFAULT_MODEL" | "FT_BULK_MODEL">>, model: string): string {
  const m = typeof model === "string" ? model.trim() : "";
  if (m === "default") return env.FT_DEFAULT_MODEL || m;
  if (m === "bulk") return env.FT_BULK_MODEL || m;
  return m;
}

/** The dearest of these models by list price (input plus output), or the first when none has a price. */
export function dearestModel(models: readonly string[]): string {
  let best: string | null = null;
  let bestPrice = -1;
  for (const m of models) {
    const p = modelPrice(m);
    if (p && p.input + p.output > bestPrice) {
      best = m;
      bestPrice = p.input + p.output;
    }
  }
  return best ?? models[0] ?? "unknown";
}

/** What the colony's review is configured with, for pricing the aggregate counters' older tokens. */
export interface ReviewConfig {
  reflexModel: string;
  secondOpinionModels: readonly string[];
}

const COUNTER = /^(decide\.llm|decide\.clef|contest\.judge|resolver|decide\.antibody)\.tokens(In|Out):(.+)$/;

/**
 * The usage the colony object counted, by layer and model, from its metrics: the per-model counters, plus what the
 * aggregate counters hold beyond them (counted before the per-model counters existed) at the layer's configured model.
 */
export function counterUsage(metrics: Readonly<Record<string, number>>, review: ReviewConfig): LayerUsage[] {
  const per = new Map<string, LayerUsage & { prefix: SpendPrefix }>();
  for (const [name, value] of Object.entries(metrics)) {
    const m = COUNTER.exec(name);
    if (!m) continue;
    const prefix = m[1] as SpendPrefix;
    const key = `${prefix}\n${m[3]}`;
    const u = per.get(key) ?? { prefix, layer: SPEND_PREFIXES[prefix], model: m[3]!, input: 0, output: 0 };
    if (m[2] === "In") u.input += count(value);
    else u.output += count(value);
    per.set(key, u);
  }
  const sum = (prefixes: readonly SpendPrefix[], side: "input" | "output"): number =>
    [...per.values()].filter((u) => prefixes.includes(u.prefix)).reduce((a, u) => a + u[side], 0);
  const out: LayerUsage[] = [...per.values()].map(({ layer, model, input, output }) => ({ layer, model, input, output }));
  // The second opinion and the contest judge share decide.llm.tokensIn and tokensOut.
  const llmIn = Math.max(0, count(metrics["decide.llm.tokensIn"]) - sum(["decide.llm", "contest.judge"], "input"));
  const llmOut = Math.max(0, count(metrics["decide.llm.tokensOut"]) - sum(["decide.llm", "contest.judge"], "output"));
  if (llmIn + llmOut > 0) out.push({ layer: "review", model: dearestModel(review.secondOpinionModels), input: llmIn, output: llmOut });
  const clef = Math.max(0, count(metrics["decide.clef.tokens"]) - sum(["decide.clef"], "input"));
  if (clef > 0) out.push({ layer: "review", model: modelKey(review.reflexModel), input: clef, output: 0 });
  return out;
}

/** One model's calls and tokens in an agent's journal. */
export interface AgentModelUsage {
  model: string;
  calls: number;
  input: number;
  output: number;
}

const JOURNAL_COUNTER = /^(llmCalls|tokensIn|tokensOut):(.+)$/;

/**
 * An agent's usage by model from its journal counters (agents/loop.ts countCall): `llmCalls`, `tokensIn` and `tokensOut`
 * count every call, and `tokensIn:<model>` and the like count the calls to a model other than the agent's own (an
 * intent that asks for one, or the model step-up), so the agent's own model has the rest.
 */
export function journalUsage(counters: Readonly<Record<string, unknown>>, ownModel: string): AgentModelUsage[] {
  const others = new Map<string, AgentModelUsage>();
  for (const [k, v] of Object.entries(counters ?? {})) {
    const m = JOURNAL_COUNTER.exec(k);
    if (!m) continue;
    const model = modelKey(m[2]);
    const u = others.get(model) ?? { model, calls: 0, input: 0, output: 0 };
    if (m[1] === "llmCalls") u.calls += count(v);
    else if (m[1] === "tokensIn") u.input += count(v);
    else u.output += count(v);
    others.set(model, u);
  }
  const own = modelKey(ownModel);
  const list = [...others.values()].filter((u) => u.model !== own);
  const rest = (k: "llmCalls" | "tokensIn" | "tokensOut", side: "calls" | "input" | "output"): number =>
    Math.max(0, count(counters?.[k]) - list.reduce((a, u) => a + u[side], 0));
  const mine: AgentModelUsage = { model: own, calls: rest("llmCalls", "calls"), input: rest("tokensIn", "input"), output: rest("tokensOut", "output") };
  return [mine, ...list].filter((u) => u.calls + u.input + u.output > 0);
}

/** What the spend book needs from its colony (ColonyDO implements it; tests fake it). */
export interface SpendHost {
  sql: SqlRunner;
  /** One in-platform agent's journal (AgentDO.status); absent where the colony has no agent binding. */
  readAgent?: (agentId: Id) => Promise<unknown>;
  /** The colony's own agents, which have no journal of their own (the conflict resolver's, the vaccines'). */
  platformAgents(): Id[];
  /** A model id as priced: "default" and "bulk" name the server's models. */
  resolveModel(model: string): string;
  waitUntil(p: Promise<unknown>): void;
}

/** What a report prices besides the agents: the colony's metrics (counters and intentsLanded) and its review's models. */
export interface SpendInput {
  metrics: Readonly<Record<string, number>>;
  review: ReviewConfig;
}

/** One agent whose journal is due a read. */
interface DueAgent {
  id: Id;
  model: string | null;
  last_seen: number;
  stopped_at: number | null;
}

/** Agents that may have a journal: every in-platform agent the platform started (synthetic ones registered through the API have no model). */
const ELIGIBLE = "(a.kind = 'internal' OR (a.kind = 'synthetic' AND COALESCE(a.model, '') != '')) AND a.id NOT IN (SELECT value FROM json_each(?))";

/** Resolve `p`, or undefined once `ms` passed (the timer is cleared either way). */
async function within<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    return await Promise.race([p, late]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Create the spend book's tables (additive: nothing existing is touched). */
export function migrateSpend(sql: SqlRunner): void {
  sql.exec("CREATE TABLE IF NOT EXISTS spend_agents (agent_id TEXT PRIMARY KEY, read_at INTEGER NOT NULL, settled INTEGER NOT NULL)");
  sql.exec(
    "CREATE TABLE IF NOT EXISTS spend_agent_models (agent_id TEXT NOT NULL, model TEXT NOT NULL, calls INTEGER NOT NULL, tokens_in INTEGER NOT NULL, tokens_out INTEGER NOT NULL, PRIMARY KEY (agent_id, model))",
  );
  // Spend per intent (colony/intentspend.ts): the agents' rows by intent, and the colony's own.
  migrateIntentSpend(sql);
}

/** The agents' usage as last read from their journals, and the colony's spend from it and the colony's own counters. */
export class SpendBook {
  /** The refresh in flight (one at a time). */
  private inflight: Promise<void> | null = null;

  constructor(private readonly host: SpendHost) {}

  /** Agents due a read: never read; or read READ_EVERY_MS ago and still able to spend, or seen again since they settled. Never-read ones first. */
  private due(now: number): DueAgent[] {
    return this.host.sql
      .exec(
        `SELECT a.id AS id, a.model AS model, a.last_seen AS last_seen, s.at AS stopped_at
           FROM agents a LEFT JOIN agent_stops s ON s.agent_id = a.id LEFT JOIN spend_agents x ON x.agent_id = a.id
          WHERE ${ELIGIBLE} AND (x.agent_id IS NULL OR (x.read_at <= ? AND (x.settled = 0 OR a.last_seen > x.read_at)))
          ORDER BY x.read_at IS NOT NULL, x.read_at, a.last_seen DESC LIMIT ?`,
        JSON.stringify(this.host.platformAgents()),
        now - READ_EVERY_MS,
        MAX_READS,
      )
      .toArray() as DueAgent[];
  }

  /** Eligible agents whose journal was never read. */
  private unread(): number {
    const row = this.host.sql
      .exec(`SELECT COUNT(*) AS n FROM agents a LEFT JOIN spend_agents x ON x.agent_id = a.id WHERE ${ELIGIBLE} AND x.agent_id IS NULL`, JSON.stringify(this.host.platformAgents()))
      .toArray()[0] as { n?: number } | undefined;
    return count(row?.n);
  }

  /** Store one journal read: the agent's usage by model, when it was read, and whether it is final. */
  private store(a: DueAgent, status: unknown, now: number): void {
    const s = status && typeof status === "object" ? (status as Record<string, unknown>) : {};
    const counters = s.counters && typeof s.counters === "object" ? (s.counters as Record<string, unknown>) : {};
    const own = typeof s.model === "string" && s.model.trim() !== "" ? s.model : (a.model ?? "");
    // By the model each call went to: a class name ("default", "bulk") counts as the model it names.
    const byModel = new Map<string, AgentModelUsage>();
    for (const u of journalUsage(counters, this.host.resolveModel(own))) {
      const model = modelKey(this.host.resolveModel(u.model));
      const t = byModel.get(model) ?? { model, calls: 0, input: 0, output: 0 };
      t.calls += u.calls;
      t.input += u.input;
      t.output += u.output;
      byModel.set(model, t);
    }
    const quietSince = Math.max(count(a.last_seen), count(a.stopped_at));
    const settled = s.running !== true && now - quietSince >= SETTLE_MS;
    const sql = this.host.sql;
    sql.exec("DELETE FROM spend_agent_models WHERE agent_id = ?", a.id);
    for (const u of byModel.values()) {
      sql.exec("INSERT INTO spend_agent_models (agent_id, model, calls, tokens_in, tokens_out) VALUES (?, ?, ?, ?, ?)", a.id, u.model, u.calls, u.input, u.output);
    }
    sql.exec(
      "INSERT INTO spend_agents (agent_id, read_at, settled) VALUES (?, ?, ?) ON CONFLICT(agent_id) DO UPDATE SET read_at = excluded.read_at, settled = excluded.settled",
      a.id,
      now,
      settled ? 1 : 0,
    );
    // Per intent too (colony/intentspend.ts): the journal's rows by intent and model, each replacing its last read.
    storeAgentIntents(sql, a.id, agentIntentUsage(s), (m) => modelKey(this.host.resolveModel(m)), now);
  }

  /** Read these journals, READ_CONCURRENCY at a time, as of `now` (when the refresh began); an agent that does not answer keeps its last read. */
  private async readAll(due: DueAgent[], now: number): Promise<void> {
    const read = this.host.readAgent;
    if (!read) return;
    let next = 0;
    let failed = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const a = due[next++];
        if (!a) return;
        try {
          const status = await within(read(a.id), READ_TIMEOUT_MS);
          if (status === undefined) failed++;
          else this.store(a, status, now);
        } catch {
          failed++;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, due.length) }, () => worker()));
    if (failed > 0) console.warn(`spend: ${failed} of ${due.length} agent journals did not answer; their last reads stand`);
  }

  /** Read the journals that are due (one refresh at a time). Null when nothing is due or nothing can be read. */
  refresh(now: number): Promise<void> | null {
    if (!this.host.readAgent) return null;
    migrateSpend(this.host.sql);
    if (this.inflight) return this.inflight;
    const due = this.due(now);
    if (due.length === 0) return null;
    const run: Promise<void> = this.readAll(due, now)
      .catch((err) => console.warn(`spend: journal reads failed: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        if (this.inflight === run) this.inflight = null;
      });
    this.inflight = run;
    this.host.waitUntil(run);
    return run;
  }

  /** Read the journals that are due and wait for them at most REPORT_WAIT_MS (what they read later is in the next report). */
  async refreshed(now: number): Promise<void> {
    migrateSpend(this.host.sql);
    const run = this.refresh(now);
    if (run) await within(run, REPORT_WAIT_MS);
  }

  /** The agents' usage by model, as last read. */
  agentUsage(): AgentModelUsage[] {
    migrateSpend(this.host.sql);
    return (
      this.host.sql
        .exec("SELECT model, SUM(calls) AS calls, SUM(tokens_in) AS input, SUM(tokens_out) AS output FROM spend_agent_models GROUP BY model ORDER BY model")
        .toArray() as Array<{ model: string; calls: number; input: number; output: number }>
    ).map((r) => ({ model: r.model, calls: count(r.calls), input: count(r.input), output: count(r.output) }));
  }

  /**
   * The colony's spend now: the journals that are due are read first (the report waits at most REPORT_WAIT_MS for them),
   * then the agents' usage and the colony's own counters are priced (core/pricing.ts).
   */
  async report(now: number, input: SpendInput): Promise<ColonySpend> {
    await this.refreshed(now);
    const agents: LayerUsage[] = this.agentUsage().map((u) => ({ layer: "agents", model: u.model, input: u.input, output: u.output }));
    const usage = [...agents, ...counterUsage(input.metrics, input.review)];
    const landed = count(input.metrics["intentsLanded"] ?? input.metrics["landedIntents"]);
    return colonySpend(usage, landed, this.host.readAgent ? { agentsUnread: this.unread() } : {});
  }
}
