import type { Id, Path } from "@fire_trident/core";
import type { HeldDirective } from "./direction.ts";
import type { AgentConfig, AgentIntentUsage, HistoryEntry, Job, Journal, StepLogEntry } from "./loop.ts";

/** Steps kept in the step log. */
const LOG_KEEP = 500;
/** Finished jobs kept in the history. */
const HISTORY_KEEP = 200;
/** Intents whose model calls are kept, by model (spend per intent); the colony keeps what it read of older ones. */
const INTENTS_KEEP = 2_000;

/** The subset of the Durable Object SQL API the journal uses. */
export interface SqlLike {
  exec<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]): { toArray(): T[]; one(): T };
}

/** Read-side view of a journal for status reports. */
export interface JournalView {
  counters(): Record<string, number>;
  history(limit?: number): HistoryEntry[];
  steps(limit?: number): StepLogEntry[];
  /** Model calls by intent and model (spend per intent, FT_INTENT_SPEND), most recently called first. */
  intentUsage(limit?: number): AgentIntentUsage[];
}

/**
 * Journal in the agent's own SQLite database. Config, the current job and
 * counters are JSON rows in a key-value table; new file contents live in their
 * own table (one row per path) so a large edit never rewrites the job row.
 * Every write is synchronous and durable before the next output.
 */
export class SqlJournal implements Journal, JournalView {
  private writes = 0;

  constructor(private readonly sql: SqlLike) {
    sql.exec("CREATE TABLE IF NOT EXISTS ft_agent_kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS ft_agent_changes (path TEXT PRIMARY KEY, content TEXT NOT NULL)");
    sql.exec(
      "CREATE TABLE IF NOT EXISTS ft_agent_steps (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, intent_id TEXT, step TEXT NOT NULL, ok INTEGER NOT NULL, ms INTEGER NOT NULL, detail TEXT)",
    );
    sql.exec("CREATE TABLE IF NOT EXISTS ft_agent_history (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, outcome TEXT NOT NULL, data TEXT NOT NULL)");
    // Spend per intent (FT_INTENT_SPEND): one row per intent and model, added to on each call.
    sql.exec(
      "CREATE TABLE IF NOT EXISTS ft_agent_intents (intent_id TEXT NOT NULL, model TEXT NOT NULL, calls INTEGER NOT NULL, tokens_in INTEGER NOT NULL, tokens_out INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (intent_id, model))",
    );
  }

  private get<T>(key: string): T | null {
    const row = this.sql.exec<{ v: string }>("SELECT v FROM ft_agent_kv WHERE k = ?", key).toArray()[0];
    return row ? (JSON.parse(row.v) as T) : null;
  }

  private put(key: string, value: unknown): void {
    this.sql.exec("INSERT INTO ft_agent_kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", key, JSON.stringify(value));
  }

  config(): AgentConfig | null {
    return this.get<AgentConfig>("config");
  }

  setConfig(c: AgentConfig): void {
    this.put("config", c);
  }

  job(): Job | null {
    return this.get<Job>("job");
  }

  setJob(j: Job | null): void {
    if (j) {
      this.put("job", j);
      return;
    }
    this.sql.exec("DELETE FROM ft_agent_kv WHERE k = 'job'");
    this.sql.exec("DELETE FROM ft_agent_changes");
  }

  changes(): Array<{ path: Path; content: string }> {
    return this.sql.exec<{ path: string; content: string }>("SELECT path, content FROM ft_agent_changes ORDER BY path").toArray();
  }

  /** Directives the colony pushed (see agents/direction.ts). */
  directives(): HeldDirective[] {
    return this.get<HeldDirective[]>("directives") ?? [];
  }

  setDirectives(list: HeldDirective[]): void {
    this.put("directives", list);
  }

  putChange(path: Path, content: string): void {
    this.sql.exec("INSERT INTO ft_agent_changes (path, content) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET content = excluded.content", path, content);
  }

  log(e: StepLogEntry): void {
    this.sql.exec(
      "INSERT INTO ft_agent_steps (at, intent_id, step, ok, ms, detail) VALUES (?, ?, ?, ?, ?, ?)",
      e.at,
      e.intentId ?? null,
      e.step,
      e.ok ? 1 : 0,
      Math.max(0, Math.round(e.ms)),
      e.detail ? e.detail.slice(0, 1000) : null,
    );
    if (++this.writes % 50 === 0) {
      this.sql.exec("DELETE FROM ft_agent_steps WHERE id <= (SELECT MAX(id) FROM ft_agent_steps) - ?", LOG_KEEP);
      this.sql.exec("DELETE FROM ft_agent_history WHERE id <= (SELECT MAX(id) FROM ft_agent_history) - ?", HISTORY_KEEP);
    }
  }

  finish(h: HistoryEntry): void {
    this.sql.exec("INSERT INTO ft_agent_history (at, outcome, data) VALUES (?, ?, ?)", h.at, h.outcome, JSON.stringify(h));
  }

  bump(counter: string, by = 1): void {
    const c = this.counters();
    c[counter] = (c[counter] ?? 0) + by;
    this.put("counters", c);
  }

  counters(): Record<string, number> {
    return this.get<Record<string, number>>("counters") ?? {};
  }

  /** One statement per call, no read; now and then the rows of the oldest intents past INTENTS_KEEP go. */
  bumpIntent(intentId: Id, model: string, usage: { input: number; output: number }, at: number): void {
    const n = (v: number): number => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
    this.sql.exec(
      "INSERT INTO ft_agent_intents (intent_id, model, calls, tokens_in, tokens_out, at) VALUES (?, ?, 1, ?, ?, ?) ON CONFLICT(intent_id, model) DO UPDATE SET calls = calls + 1, tokens_in = tokens_in + excluded.tokens_in, tokens_out = tokens_out + excluded.tokens_out, at = excluded.at",
      intentId,
      model,
      n(usage.input),
      n(usage.output),
      Math.max(0, Math.round(at)),
    );
    if (++this.intentWrites % 100 === 0) {
      this.sql.exec("DELETE FROM ft_agent_intents WHERE at < (SELECT at FROM ft_agent_intents ORDER BY at DESC LIMIT 1 OFFSET ?)", INTENTS_KEEP - 1);
    }
  }
  private intentWrites = 0;

  intentUsage(limit = INTENTS_KEEP): AgentIntentUsage[] {
    return this.sql
      .exec<{ intent_id: string; model: string; calls: number; tokens_in: number; tokens_out: number; at: number }>(
        "SELECT intent_id, model, calls, tokens_in, tokens_out, at FROM ft_agent_intents ORDER BY at DESC, intent_id, model LIMIT ?",
        limit,
      )
      .toArray()
      .map((r) => ({ intentId: r.intent_id, model: r.model, calls: r.calls, input: r.tokens_in, output: r.tokens_out, at: r.at }));
  }

  history(limit = 10): HistoryEntry[] {
    return this.sql
      .exec<{ data: string }>("SELECT data FROM ft_agent_history ORDER BY id DESC LIMIT ?", limit)
      .toArray()
      .map((r) => JSON.parse(r.data) as HistoryEntry);
  }

  steps(limit = 20): StepLogEntry[] {
    return this.sql
      .exec<{ at: number; intent_id: string | null; step: string; ok: number; ms: number; detail: string | null }>(
        "SELECT at, intent_id, step, ok, ms, detail FROM ft_agent_steps ORDER BY id DESC LIMIT ?",
        limit,
      )
      .toArray()
      .map((r) => {
        const e: StepLogEntry = { at: r.at, step: r.step, ok: r.ok === 1, ms: r.ms };
        if (r.intent_id) e.intentId = r.intent_id;
        if (r.detail) e.detail = r.detail;
        return e;
      });
  }
}

/**
 * In-memory journal with the same semantics, for tests. Values are deep-copied
 * in and out, like rows, so a test can "kill" a loop and resume from the journal.
 */
export class MemoryJournal implements Journal, JournalView {
  private cfg: AgentConfig | null = null;
  private current: Job | null = null;
  private held: HeldDirective[] = [];
  private files = new Map<Path, string>();
  private readonly log_: StepLogEntry[] = [];
  private readonly history_: HistoryEntry[] = [];
  private readonly counters_: Record<string, number> = {};
  private readonly intents_ = new Map<string, AgentIntentUsage>();

  config(): AgentConfig | null {
    return this.cfg ? structuredClone(this.cfg) : null;
  }
  setConfig(c: AgentConfig): void {
    this.cfg = structuredClone(c);
  }
  job(): Job | null {
    return this.current ? structuredClone(this.current) : null;
  }
  setJob(j: Job | null): void {
    this.current = j ? structuredClone(j) : null;
    if (!j) this.files.clear();
  }
  changes(): Array<{ path: Path; content: string }> {
    return [...this.files].sort(([a], [b]) => (a < b ? -1 : 1)).map(([path, content]) => ({ path, content }));
  }
  putChange(path: Path, content: string): void {
    this.files.set(path, content);
  }
  directives(): HeldDirective[] {
    return structuredClone(this.held);
  }
  setDirectives(list: HeldDirective[]): void {
    this.held = structuredClone(list);
  }
  log(e: StepLogEntry): void {
    this.log_.push(structuredClone(e));
  }
  finish(h: HistoryEntry): void {
    this.history_.push(structuredClone(h));
  }
  bump(counter: string, by = 1): void {
    this.counters_[counter] = (this.counters_[counter] ?? 0) + by;
  }
  counters(): Record<string, number> {
    return { ...this.counters_ };
  }
  bumpIntent(intentId: Id, model: string, usage: { input: number; output: number }, at: number): void {
    const k = `${intentId}\n${model}`;
    const u = this.intents_.get(k) ?? { intentId, model, calls: 0, input: 0, output: 0, at: 0 };
    u.calls += 1;
    u.input += Math.max(0, Math.floor(usage.input || 0));
    u.output += Math.max(0, Math.floor(usage.output || 0));
    u.at = at;
    this.intents_.set(k, u);
  }
  intentUsage(limit = INTENTS_KEEP): AgentIntentUsage[] {
    return [...this.intents_.values()]
      .sort((a, b) => b.at - a.at || (a.intentId < b.intentId ? -1 : a.intentId > b.intentId ? 1 : 0))
      .slice(0, limit)
      .map((u) => structuredClone(u));
  }
  history(limit = 10): HistoryEntry[] {
    return this.history_.slice(-limit).reverse();
  }
  steps(limit = 20): StepLogEntry[] {
    return this.log_.slice(-limit).reverse();
  }
}
