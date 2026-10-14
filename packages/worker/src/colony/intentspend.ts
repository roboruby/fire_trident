import { intentSpend, intentSpendBrief, revalidationEnabled, spentOnIntent } from "@fire_trident/core";
import type { Id, IntentSpend, IntentSpendBrief, IntentUsage, SpendLayer } from "@fire_trident/core";
import type { AgentIntentUsage } from "../agents/loop.ts";
import type { SqlRunner } from "./inline.ts";

export type { AgentIntentUsage } from "../agents/loop.ts";

/**
 * Model spend per intent (FT_INTENT_SPEND). The colony's spend (colony/spend.ts) says what a run cost in total, by
 * layer and per landed intent on average; averages hide the expensive intents. Where the flag covers a colony, every
 * model call is also counted for the intent it serves, as it happens, and GET /api/colonies/:id/intents/:intentId/spend
 * prices one intent's calls (core/pricing.ts intentSpend):
 *
 * - agents: an in-platform agent's job is a take of one intent, so its loop counts each call under the job's intent and
 *   the model that answered, in its own journal (agents/loop.ts countCall, journal.ts bumpIntent). The colony's spend
 *   book reads those rows with the journal (AgentDO.status `intentUsage`) into `spend_agent_intents`, so they survive
 *   the agent and are read on the same schedule as its totals; nothing is read per intent.
 * - review and the contest judge: the decide stage's reflex and second opinion are per proposal, and a proposal names
 *   its intent; the judge compares the changes of one intent. Each call is one row update in `spend_intents`, keyed by
 *   intent, layer and model, beside the per-model counters the colony already keeps. The metrics table is not used: a
 *   snapshot reads it whole, and rows per intent would grow every read.
 *
 * Reads work without the flag and show nothing for an intent nothing was counted for (never a spend of zero). Calls made
 * before the flag was on are in the colony's total and in no intent's: the sum over intents falls short of the total by
 * them, and by the conflict resolver's and antibody minting's calls, which are not counted per intent.
 */

/** Is FT_INTENT_SPEND on for this colony? Read like FT_REVALIDATE: "on", a comma-separated list of colony ids, or absent / "off". */
export function intentSpendEnabled(setting: string | undefined, colonyId: Id): boolean {
  return revalidationEnabled(setting, colonyId);
}

/** The layers the colony counts per intent itself (the agents' calls come from their journals). */
export type IntentCallLayer = "review" | "judge";

/** The API's answer: the intent's spend, and a note when the colony is not counting per intent. */
export type IntentSpendAnswer = IntentSpend & { note?: string };

/** Intents a listing's spend map covers at most (the most recently active). */
export const MAP_CAP = 2_000;
/** Longest model id or intent id a row keeps. */
const MAX_KEY = 200;
/** What a colony that is not counting per intent says beside an intent nothing was counted for. */
export const NOT_COUNTING = "This colony does not count model calls per intent (FT_INTENT_SPEND is off for it); its spend in total is on GET /api/colonies/:id/metrics.";

/** A finite, non-negative whole number, or 0. */
function count(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/** A model id or intent id as a row keeps it: one line, at most MAX_KEY characters ("unknown" when empty). */
function key(v: unknown): string {
  const s = typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, MAX_KEY) : "";
  return s === "" ? "unknown" : s;
}

/** Create the per-intent tables (additive: nothing existing is touched). */
export function migrateIntentSpend(sql: SqlRunner): void {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS spend_intents (intent_id TEXT NOT NULL, layer TEXT NOT NULL, model TEXT NOT NULL, calls INTEGER NOT NULL, tokens_in INTEGER NOT NULL, tokens_out INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (intent_id, layer, model))",
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS spend_agent_intents (agent_id TEXT NOT NULL, intent_id TEXT NOT NULL, model TEXT NOT NULL, calls INTEGER NOT NULL, tokens_in INTEGER NOT NULL, tokens_out INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (agent_id, intent_id, model))",
  );
  sql.exec("CREATE INDEX IF NOT EXISTS spend_agent_intents_by_intent ON spend_agent_intents(intent_id)");
}

/** One of the colony's own model calls, counted for an intent. */
export interface IntentCall {
  intentId: Id;
  layer: IntentCallLayer;
  model: string;
  /** The call's tokens as the model reported them; null when it reported none (the call still counts). */
  usage: { input?: number; output?: number } | null | undefined;
  at: number;
}

/** Add one call to the intent's row for its layer and model (one statement, no read). */
export function countIntentCall(sql: SqlRunner, call: IntentCall): void {
  sql.exec(
    `INSERT INTO spend_intents (intent_id, layer, model, calls, tokens_in, tokens_out, at) VALUES (?, ?, ?, 1, ?, ?, ?)
     ON CONFLICT(intent_id, layer, model) DO UPDATE SET calls = calls + 1, tokens_in = tokens_in + excluded.tokens_in, tokens_out = tokens_out + excluded.tokens_out, at = excluded.at`,
    key(call.intentId),
    call.layer === "judge" ? "judge" : "review",
    key(call.model),
    count(call.usage?.input),
    count(call.usage?.output),
    count(call.at),
  );
}

/** The per-intent rows of an agent's status (AgentDO.status `intentUsage`), read defensively; none for an agent on older code. */
export function agentIntentUsage(status: unknown): AgentIntentUsage[] {
  const s = status && typeof status === "object" ? (status as Record<string, unknown>) : {};
  if (!Array.isArray(s.intentUsage)) return [];
  const out: AgentIntentUsage[] = [];
  for (const row of s.intentUsage) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    if (typeof r.intentId !== "string" || r.intentId.trim() === "") continue;
    const calls = count(r.calls);
    const input = count(r.input);
    const output = count(r.output);
    if (calls + input + output === 0) continue;
    out.push({ intentId: key(r.intentId), model: key(r.model), calls, input, output, at: count(r.at) });
  }
  return out;
}

/**
 * Store an agent's per-intent rows as last read: each replaces the row it names (the journal counts totals), and a
 * row the read did not carry stands as last stored. `resolveModel` prices a class name ("default", "bulk") as the model
 * it names on this server.
 */
export function storeAgentIntents(sql: SqlRunner, agentId: Id, rows: readonly AgentIntentUsage[], resolveModel: (model: string) => string, now: number): void {
  if (rows.length === 0) return;
  // Two rows that resolve to one model (a class name and the id it names) add up.
  const byKey = new Map<string, AgentIntentUsage>();
  for (const r of rows) {
    const model = key(resolveModel(r.model));
    const k = `${r.intentId}\n${model}`;
    const t = byKey.get(k) ?? { intentId: r.intentId, model, calls: 0, input: 0, output: 0, at: 0 };
    t.calls += r.calls;
    t.input += r.input;
    t.output += r.output;
    t.at = Math.max(t.at, r.at);
    byKey.set(k, t);
  }
  for (const r of byKey.values()) {
    sql.exec(
      `INSERT INTO spend_agent_intents (agent_id, intent_id, model, calls, tokens_in, tokens_out, at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(agent_id, intent_id, model) DO UPDATE SET calls = excluded.calls, tokens_in = excluded.tokens_in, tokens_out = excluded.tokens_out, at = excluded.at`,
      agentId,
      r.intentId,
      r.model,
      r.calls,
      r.input,
      r.output,
      r.at > 0 ? r.at : now,
    );
  }
}

/** A row of the two tables summed by intent, layer and model. */
interface UsageRow {
  intent_id: string;
  layer: string;
  model: string;
  calls: number;
  input: number;
  output: number;
}

/** Both tables as one: the agents' rows under the `agents` layer, the colony's own under theirs. */
const BOTH = `SELECT 'agents' AS layer, intent_id, model, calls, tokens_in, tokens_out, at FROM spend_agent_intents
  UNION ALL SELECT layer, intent_id, model, calls, tokens_in, tokens_out, at FROM spend_intents`;

/** The usage counted for one intent, by layer and model. */
export function intentUsageOf(sql: SqlRunner, intentId: Id): IntentUsage[] {
  const rows = sql
    .exec(
      `SELECT intent_id, layer, model, SUM(calls) AS calls, SUM(tokens_in) AS input, SUM(tokens_out) AS output FROM (${BOTH}) WHERE intent_id = ? GROUP BY layer, model ORDER BY layer, model`,
      intentId,
    )
    .toArray() as UsageRow[];
  return rows.map((r) => ({ layer: layerOf(r.layer), model: r.model, calls: count(r.calls), input: count(r.input), output: count(r.output) }));
}

/** A stored layer name as a SpendLayer ("other" for anything unknown). */
function layerOf(v: string): SpendLayer {
  return v === "agents" || v === "review" || v === "judge" || v === "resolver" || v === "other" ? v : "other";
}

/** One intent's spend from what the colony counted for it (migrating first, so a colony that never counted answers too). */
export function reportIntentSpend(sql: SqlRunner, intentId: Id): IntentSpend {
  migrateIntentSpend(sql);
  return intentSpend(intentId, intentUsageOf(sql, intentId));
}

/**
 * The spend of the intents the colony counted for, by id, for a listing: the `limit` most recently active ones at most,
 * each in its short form. Empty when nothing was counted (a colony without the flag, or one whose agents made no calls).
 */
export function intentSpendMap(sql: SqlRunner, limit = MAP_CAP): Record<Id, IntentSpendBrief> {
  migrateIntentSpend(sql);
  const recent = sql
    .exec(`SELECT intent_id, MAX(at) AS at FROM (${BOTH}) GROUP BY intent_id ORDER BY at DESC, intent_id LIMIT ?`, count(limit) || MAP_CAP)
    .toArray() as Array<{ intent_id: string }>;
  if (recent.length === 0) return {};
  const ids = recent.map((r) => r.intent_id);
  const rows = sql
    .exec(
      `SELECT intent_id, layer, model, SUM(calls) AS calls, SUM(tokens_in) AS input, SUM(tokens_out) AS output FROM (${BOTH})
        WHERE intent_id IN (SELECT value FROM json_each(?)) GROUP BY intent_id, layer, model ORDER BY intent_id, layer, model`,
      JSON.stringify(ids),
    )
    .toArray() as UsageRow[];
  const byIntent = new Map<string, IntentUsage[]>();
  for (const r of rows) {
    const list = byIntent.get(r.intent_id) ?? [];
    list.push({ layer: layerOf(r.layer), model: r.model, calls: count(r.calls), input: count(r.input), output: count(r.output) });
    byIntent.set(r.intent_id, list);
  }
  const out: Record<Id, IntentSpendBrief> = {};
  for (const [id, usage] of byIntent) {
    const brief = intentSpendBrief(intentSpend(id, usage));
    // Object.defineProperty defines an own property, so no intent id can reach a prototype.
    if (brief) Object.defineProperty(out, id, { value: brief, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/**
 * The colony's per-intent book: counts the colony's own calls where the flag covers it, and answers the per-intent
 * reads (always). ColonyDO keeps one; the agents' rows reach its tables through the spend book's journal reads.
 */
export class IntentSpendBook {
  private migrated = false;

  constructor(
    private readonly sql: SqlRunner,
    /** Whether FT_INTENT_SPEND covers the colony now. */
    private readonly on: () => boolean,
  ) {}

  private migrate(): void {
    if (this.migrated) return;
    migrateIntentSpend(this.sql);
    this.migrated = true;
  }

  /** Count one of the colony's own calls for an intent, where the flag covers the colony; otherwise nothing. Never fails the call. */
  count(intentId: Id, layer: IntentCallLayer, model: string, usage: IntentCall["usage"], at: number): void {
    try {
      if (!this.on()) return;
      this.migrate();
      countIntentCall(this.sql, { intentId, layer, model, usage, at });
    } catch (err) {
      console.warn(`intent spend: counting a ${layer} call for ${intentId} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** One intent's spend, with a note when the colony is not counting per intent and nothing was counted for the intent. */
  report(intentId: Id): IntentSpendAnswer {
    this.migrate();
    const spend = reportIntentSpend(this.sql, intentId);
    const counted: boolean = spentOnIntent(spend);
    return !this.on() && !counted ? { ...spend, note: NOT_COUNTING } : spend;
  }

  /** The spend of the most recently active intents, by id (intentSpendMap), or null when nothing was counted. */
  map(limit = MAP_CAP): Record<Id, IntentSpendBrief> | null {
    this.migrate();
    const out = intentSpendMap(this.sql, limit);
    return Object.keys(out).length > 0 ? out : null;
  }
}
