import type { AgentKind, ClosureCause, ClosureKindShare, ClosureReport, Id, IntentClosure, IntentStatus } from "@fire_trident/core";

/**
 * The closure ledger: why each intent an agent held closed or reopened, and the silent-agent limit.
 *
 * Every close or reopen of an intent an agent held (claimed, or proposed with its change under review) is recorded with
 * its cause: `landed`, `released` (the agent gave it back), `escalated` (the agent reported it to a person), `withdrawn`
 * (a person or a change of direction called it off), `gave_up` (an in-platform agent's loop gave up), `reaped_silent`
 * (the agent was silent past the colony's limit and the reaper took the intent back), `returned` (review or a person
 * sent its change back) and `stopped` (a person stopped the agent). Each record keeps the agent, its kind and the gap
 * from the agent's last sign of life the colony recorded (a heartbeat or a call) to the close; a close the agent's own
 * call made has a gap of 0. The intent's latest closure is kept on its row (shown on the intent), every closure in
 * `intent_closures` (the intent's history; the newest LEDGER_KEEP rows), and a running count per agent kind and cause in
 * `closure_counts` (the shares in the metrics report). The intent event of the close carries the same fields.
 *
 * The silent-agent limit is a per-colony setting a person sets (POST /api/colonies/:id/silent-ttl): an agent outside
 * the platform (MCP or API) silent this long loses its claimed intents to the colony. In-platform agents keep at least
 * the default ten minutes, because they tell the colony they are alive only every three minutes while they refresh their
 * claims in the regions directly (agents/loop.ts COLONY_BEAT_EVERY_MS). With no setting, every agent has ten minutes, as
 * before. Nothing here changes what an agent may do; recording fails open (ColonyDO logs and goes on).
 */

/** Every cause, in the order reports list them. */
export const CLOSURE_CAUSES: readonly ClosureCause[] = ["landed", "released", "escalated", "withdrawn", "gave_up", "reaped_silent", "returned", "stopped"];
/** Causes the agent's own call made: its call is its sign of life, so the gap is 0. */
const OWN_CALL: ReadonlySet<ClosureCause> = new Set<ClosureCause>(["released", "escalated", "gave_up"]);
const AGENT_KINDS: readonly AgentKind[] = ["internal", "external", "synthetic"];
/** Causes an abandon may carry (ColonyDO.abandon): the MCP release, the agent loop's give-up, a stop. */
export type AbandonCause = Extract<ClosureCause, "released" | "gave_up" | "stopped">;

/** The silent-agent limit when no person set one: ten minutes, as it always was. */
export const DEFAULT_SILENT_TTL_MS = 10 * 60_000;
/** The shortest and longest limit a person may set. */
export const MIN_SILENT_TTL_MS = 60_000;
export const MAX_SILENT_TTL_MS = 24 * 60 * 60_000;
/** The least an in-platform (or synthetic) agent gets, whatever the setting: they beat the colony only every 3 minutes. */
export const IN_PLATFORM_TTL_FLOOR_MS = DEFAULT_SILENT_TTL_MS;
/** Closure rows kept for intent histories (the newest); counts are kept apart and never trimmed. */
export const LEDGER_KEEP = 20_000;
/** Closures kept per intent history answer at most (newest first). */
export const HISTORY_CAP = 50;
const TRIM_EVERY = 500;
const MAX_BY = 100;

/** The SQL the ledger runs (a Durable Object's storage, or node:sqlite in unit tests). */
export interface SqlRunner {
  exec(query: string, ...bindings: unknown[]): { toArray(): unknown[] };
}

/** The colony's silent-agent limit as GET and POST /silent-ttl answer it. */
export interface SilentTtlView {
  /** The limit for agents outside the platform, in ms and whole seconds. */
  ms: number;
  seconds: number;
  /** True when no person set it (ten minutes). */
  default: boolean;
  /** What in-platform and synthetic agents get: the larger of the limit and ten minutes. */
  inPlatformMs: number;
  setBy?: string;
  setAt?: number;
  /** What the limit means now, in a sentence or two. */
  note: string;
}

/** The fields an intent event of a close carries (empty when nothing was recorded). */
export type ClosureEventFields = Partial<Pick<IntentClosure, "cause" | "agentId" | "agentKind" | "gapMs">>;

/** What ColonyDO tells the ledger about one close or reopen. */
export interface ClosureInput {
  intentId: Id;
  cause: ClosureCause;
  /** What the intent became. */
  status: IntentStatus;
  at: number;
  /** The agent that held it, as its row stands before the close (lastSeen: its last_seen column). */
  agent: { id: Id; kind: string | null; lastSeen: number | null };
  /** A short reason (the release's or give-up's words, the return's status), kept with the row; never shown as instructions. */
  detail?: string;
}

/** Create the ledger's tables and the intent column (additive: the column only when it is missing, nothing rewritten). */
export function migrateClosure(sql: SqlRunner): void {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS intent_closures (seq INTEGER PRIMARY KEY AUTOINCREMENT, intent_id TEXT NOT NULL, at INTEGER NOT NULL, cause TEXT NOT NULL, status TEXT NOT NULL, agent_id TEXT, agent_kind TEXT, gap_ms INTEGER, detail TEXT)",
  );
  sql.exec("CREATE INDEX IF NOT EXISTS intent_closures_by_intent ON intent_closures(intent_id, seq)");
  sql.exec("CREATE INDEX IF NOT EXISTS intent_closures_by_cause ON intent_closures(cause, seq)");
  sql.exec("CREATE TABLE IF NOT EXISTS closure_counts (agent_kind TEXT NOT NULL, cause TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (agent_kind, cause))");
  sql.exec("CREATE TABLE IF NOT EXISTS silent_ttl (id INTEGER PRIMARY KEY CHECK (id = 1), ms INTEGER NOT NULL, set_by TEXT NOT NULL, set_at INTEGER NOT NULL)");
  let columns: Set<string> | null = null;
  try {
    columns = new Set((sql.exec("PRAGMA table_info(intents)").toArray() as Array<{ name?: unknown }>).map((c) => String(c?.name ?? "")));
  } catch {
    columns = null;
  }
  // No intents table (a unit test's bare storage): there is no row to keep the latest closure on.
  if (!columns || columns.size === 0 || columns.has("closure")) return;
  try {
    sql.exec("ALTER TABLE intents ADD COLUMN closure TEXT");
  } catch {
    // Already there.
  }
}

/** Whether `v` is a cause the ledger knows. */
export function isClosureCause(v: unknown): v is ClosureCause {
  return typeof v === "string" && (CLOSURE_CAUSES as readonly string[]).includes(v);
}

/**
 * The cause of an abandon: the one its caller named, else what the agent's kind implies (an older caller names none):
 * an outside agent's abandon is its MCP release, an in-platform agent's is its loop giving up.
 */
export function abandonCause(named: unknown, kind: string | null | undefined): AbandonCause {
  if (named === "released" || named === "gave_up" || named === "stopped") return named;
  return kind === "external" ? "released" : "gave_up";
}

/** The gap of a close: 0 when the agent's own call made it, else from its last recorded sign of life (never negative); undefined when unknown. */
export function gapOf(cause: ClosureCause, lastSeen: number | null | undefined, at: number): number | undefined {
  if (OWN_CALL.has(cause)) return 0;
  if (typeof lastSeen !== "number" || !Number.isFinite(lastSeen) || lastSeen <= 0) return undefined;
  return Math.max(0, Math.round(at - lastSeen));
}

/** A stored or sent closure checked field by field; null when it is not one. Old rows and unknown causes read as none. */
export function closureOf(raw: unknown): IntentClosure | null {
  let v: unknown = raw;
  if (typeof raw === "string") {
    try {
      v = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (!isClosureCause(o.cause) || typeof o.at !== "number" || !Number.isFinite(o.at) || typeof o.status !== "string") return null;
  const out: IntentClosure = { cause: o.cause, at: o.at, status: o.status as IntentStatus };
  if (typeof o.agentId === "string" && o.agentId) out.agentId = o.agentId;
  if (typeof o.agentKind === "string" && (AGENT_KINDS as readonly string[]).includes(o.agentKind)) out.agentKind = o.agentKind as AgentKind;
  if (typeof o.gapMs === "number" && Number.isFinite(o.gapMs) && o.gapMs >= 0) out.gapMs = Math.round(o.gapMs);
  return out;
}

/** The fields of a closure an intent event carries. */
export function eventFields(c: IntentClosure | null): ClosureEventFields {
  if (!c) return {};
  const out: ClosureEventFields = { cause: c.cause };
  if (c.agentId) out.agentId = c.agentId;
  if (c.agentKind) out.agentKind = c.agentKind;
  if (c.gapMs !== undefined) out.gapMs = c.gapMs;
  return out;
}

/**
 * The reaper's last-seen cutoffs at `now` for a limit of `ttlMs`: an outside agent last seen before `external` is
 * silent past the limit, an in-platform or synthetic one before `inPlatform` (it gets at least IN_PLATFORM_TTL_FLOOR_MS).
 */
export function reapCutoffs(ttlMs: number, now: number): { external: number; inPlatform: number } {
  return { external: now - ttlMs, inPlatform: now - Math.max(ttlMs, IN_PLATFORM_TTL_FLOOR_MS) };
}

/** A limit a person asked for, in ms, checked against the bounds; null to go back to the default. Throws a sentence otherwise. */
export function silentTtlMs(seconds: unknown): number | null {
  if (seconds === null) return null;
  const n = typeof seconds === "number" ? seconds : Number.NaN;
  if (!Number.isFinite(n) || n * 1000 < MIN_SILENT_TTL_MS || n * 1000 > MAX_SILENT_TTL_MS) {
    throw new RangeError(
      `seconds must be a number from ${MIN_SILENT_TTL_MS / 1000} to ${MAX_SILENT_TTL_MS / 1000} (${MAX_SILENT_TTL_MS / 3_600_000} hours), or null for the default ten minutes`,
    );
  }
  return Math.round(n * 1000);
}

/** "90 s", "10 min", "1 h 30 min": a duration as a person reads it. */
export function durationText(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 120 && s % 60 !== 0) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return m % 60 === 0 ? `${m / 60} h` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** The limit's sentence for a view. */
function ttlNote(ms: number, isDefault: boolean): string {
  if (isDefault) return "An agent silent for 10 min loses its claimed intents to the colony, which reopens them with a failure mark (the default).";
  const floor = ms < IN_PLATFORM_TTL_FLOOR_MS ? ` In-platform agents keep ${durationText(IN_PLATFORM_TTL_FLOOR_MS)}, since they tell the colony they are alive only every 3 min.` : "";
  return `An agent outside the platform silent for ${durationText(ms)} loses its claimed intents to the colony, which reopens them with a failure mark.${floor}`;
}

/** The median of a sorted list, or null. */
function median(sorted: readonly number[]): number | null {
  if (sorted.length === 0) return null;
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[m] ?? null) : Math.round(((sorted[m - 1] ?? 0) + (sorted[m] ?? 0)) / 2);
}

type ClosureRow = { cause: string; at: number; status: string; agent_id: string | null; agent_kind: string | null; gap_ms: number | null };
type TtlRow = { ms: number; set_by: string; set_at: number };

/** One colony's closure ledger and silent-agent limit, over its storage. */
export class ClosureLedger {
  private ttlRow: TtlRow | null | undefined;
  private sinceTrim = 0;

  constructor(private readonly sql: SqlRunner) {
    migrateClosure(sql);
  }

  /**
   * Record one close or reopen: the row, the running count, and the intent's latest closure on its row. Returns the
   * closure (its fields go on the intent event).
   */
  record(e: ClosureInput): IntentClosure {
    const kind = e.agent.kind && (AGENT_KINDS as readonly string[]).includes(e.agent.kind) ? (e.agent.kind as AgentKind) : null;
    const closure: IntentClosure = { cause: e.cause, at: e.at, status: e.status, agentId: e.agent.id };
    if (kind) closure.agentKind = kind;
    const gap = gapOf(e.cause, e.agent.lastSeen, e.at);
    if (gap !== undefined) closure.gapMs = gap;
    const detail = typeof e.detail === "string" ? e.detail.replace(/\s+/g, " ").trim().slice(0, 300) || null : null;
    this.sql.exec(
      "INSERT INTO intent_closures (intent_id, at, cause, status, agent_id, agent_kind, gap_ms, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      e.intentId,
      e.at,
      e.cause,
      e.status,
      e.agent.id,
      kind,
      gap ?? null,
      detail,
    );
    this.sql.exec(
      "INSERT INTO closure_counts (agent_kind, cause, n) VALUES (?, ?, 1) ON CONFLICT(agent_kind, cause) DO UPDATE SET n = n + 1",
      kind ?? "unknown",
      e.cause,
    );
    try {
      this.sql.exec("UPDATE intents SET closure = ? WHERE id = ?", JSON.stringify(closure), e.intentId);
    } catch {
      // A storage without the intents table (unit tests): the row and the count stand.
    }
    if (++this.sinceTrim >= TRIM_EVERY) this.trim();
    return closure;
  }

  /** The intent's closures, newest first (at most HISTORY_CAP). */
  history(intentId: Id, limit = HISTORY_CAP): IntentClosure[] {
    const rows = this.sql
      .exec("SELECT cause, at, status, agent_id, agent_kind, gap_ms FROM intent_closures WHERE intent_id = ? ORDER BY seq DESC LIMIT ?", intentId, Math.max(1, Math.min(limit, HISTORY_CAP)))
      .toArray() as ClosureRow[];
    return rows.map((r) => closureOf({ cause: r.cause, at: r.at, status: r.status, agentId: r.agent_id ?? undefined, agentKind: r.agent_kind ?? undefined, gapMs: r.gap_ms ?? undefined })).filter((c): c is IntentClosure => c !== null);
  }

  /** Shares per agent kind and cause, the reaped agents' gaps, and the limit (the metrics report's `closures`). */
  report(): ClosureReport {
    const byKind: Partial<Record<AgentKind, ClosureKindShare>> = {};
    let total = 0;
    for (const r of this.sql.exec("SELECT agent_kind, cause, n FROM closure_counts").toArray() as Array<{ agent_kind: string; cause: string; n: number }>) {
      if (!isClosureCause(r.cause) || !(AGENT_KINDS as readonly string[]).includes(r.agent_kind) || !(r.n > 0)) continue;
      const k = (byKind[r.agent_kind as AgentKind] ??= { total: 0, counts: {}, shares: {} });
      k.counts[r.cause] = (k.counts[r.cause] ?? 0) + r.n;
      k.total += r.n;
      total += r.n;
    }
    for (const k of Object.values(byKind)) {
      for (const cause of CLOSURE_CAUSES) {
        const n = k.counts[cause];
        if (n) k.shares[cause] = Math.round((n / k.total) * 10_000) / 10_000;
      }
    }
    const reapedCount = (byKind.internal?.counts.reaped_silent ?? 0) + (byKind.external?.counts.reaped_silent ?? 0) + (byKind.synthetic?.counts.reaped_silent ?? 0);
    const gaps = (this.sql.exec("SELECT gap_ms FROM intent_closures WHERE cause = 'reaped_silent' AND gap_ms IS NOT NULL ORDER BY seq DESC LIMIT 1000").toArray() as Array<{ gap_ms: number }>)
      .map((r) => r.gap_ms)
      .sort((a, b) => a - b);
    const ttl = this.ttl();
    return {
      total,
      byKind,
      reaped: { count: reapedCount, medianGapMs: median(gaps), maxGapMs: gaps.length > 0 ? (gaps[gaps.length - 1] ?? null) : null },
      silentTtlMs: ttl.ms,
      silentTtlDefault: ttl.default,
    };
  }

  /** The limit as it stands (read once, then kept in memory). */
  ttl(): SilentTtlView {
    if (this.ttlRow === undefined) this.ttlRow = (this.sql.exec("SELECT ms, set_by, set_at FROM silent_ttl WHERE id = 1").toArray()[0] as TtlRow | undefined) ?? null;
    const row = this.ttlRow;
    const ms = row && row.ms >= MIN_SILENT_TTL_MS && row.ms <= MAX_SILENT_TTL_MS ? row.ms : DEFAULT_SILENT_TTL_MS;
    const isDefault = !row || ms === DEFAULT_SILENT_TTL_MS;
    const view: SilentTtlView = { ms, seconds: Math.round(ms / 1000), default: isDefault, inPlatformMs: Math.max(ms, IN_PLATFORM_TTL_FLOOR_MS), note: ttlNote(ms, isDefault) };
    if (row) {
      view.setBy = row.set_by;
      view.setAt = row.set_at;
    }
    return view;
  }

  /** Set the limit (ms, checked by silentTtlMs) or go back to the default (null), as `by`. */
  setTtl(ms: number | null, by: string, now: number): SilentTtlView {
    const who = by.replace(/\s+/g, " ").trim().slice(0, MAX_BY) || "unknown";
    if (ms === null) {
      this.sql.exec("DELETE FROM silent_ttl WHERE id = 1");
      this.ttlRow = null;
    } else {
      this.sql.exec(
        "INSERT INTO silent_ttl (id, ms, set_by, set_at) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET ms = excluded.ms, set_by = excluded.set_by, set_at = excluded.set_at",
        ms,
        who,
        now,
      );
      this.ttlRow = { ms, set_by: who, set_at: now };
    }
    return this.ttl();
  }

  /** Keep the newest LEDGER_KEEP rows (counts stay whole). */
  private trim(): void {
    this.sinceTrim = 0;
    const cut = this.sql.exec("SELECT seq FROM intent_closures ORDER BY seq DESC LIMIT 1 OFFSET ?", LEDGER_KEEP).toArray()[0] as { seq: number } | undefined;
    if (cut) this.sql.exec("DELETE FROM intent_closures WHERE seq <= ?", cut.seq);
  }
}
