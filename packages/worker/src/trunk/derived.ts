/**
 * Derived data: indexes computed from a landing log by one mechanism. An index is a name, a version, a
 * mode and an incremental `apply` for one landing: its value after a landing is its value before it
 * plus that landing, so an index can be added, changed or rebuilt without touching the landing path
 * or the readers of the others.
 *
 * - Cursor: each index keeps the last landing it applied (ft_derived: name, version, seq), so a
 *   restart resumes where it stopped and each landing is applied once. `apply` must also be
 *   idempotent per landing on its own: an apply that fails partway in the landing hook keeps its
 *   writes without moving the cursor, and the landing is applied again later.
 * - Eager indexes apply each landing in the landing hook (`landed`), inside the transaction that
 *   records it, once they have applied every landing before it. Lazy ones cost nothing there and
 *   catch up from their cursor when read (`catchUp`).
 * - Version: bumping an index's version rebuilds it. The next catch-up forgets it (`reset`), and the
 *   catch-ups after that apply the log again from where `reset` says, a bounded slice at a time.
 * - Failing open: a landing an index cannot apply is logged and skipped, a catch-up that cannot read
 *   the log stops, and readers answer from what the index holds.
 *
 * TrunkDO's log is ft_landings with each landing's lineage note (trunkLog below), and its indexes are
 * the import index (eager, trunk/imports.ts), the co-change map (lazy, trunk/cochange.ts) and path
 * history (lazy, trunk/history.ts). ColonyDO's log is its landings table in arrival order, and its
 * index is the landing path index behind why-context (eager).
 */
import type { Landing, Path, Sha } from "@fire_trident/core";

/** The cursor table (ft_ prefix: TrunkDO.destroy replays ft_ DDL): each index's version and the last landing it applied. */
export const DERIVED_SCHEMA = ["CREATE TABLE IF NOT EXISTS ft_derived (name TEXT PRIMARY KEY, version INTEGER NOT NULL, seq INTEGER NOT NULL, at INTEGER NOT NULL)"];

/** Landings one catch-up applies at most unless its budget says otherwise, and landings per transaction. */
const CATCH_UP_LANDINGS = 1_000;
const SLICE_LANDINGS = 100;
/** Catch-ups that apply at least this many landings, or take this long, are logged. */
const LOG_LANDINGS = 500;
const LOG_MS = 1_000;

/** One landing of a log: its place (increasing, not necessarily dense) and what the log holds for it. */
export interface LogEntry<L> {
  seq: number;
  landing: L;
}

/** The log a set of derived indexes is computed from, oldest first. */
export interface LandingLog<L> {
  /** The entries after `seq`, oldest first, at most `limit`. */
  after(seq: number, limit: number): Array<LogEntry<L>>;
  /** The newest entry's seq (0 when the log is empty). */
  head(): number;
  /** The seq of the newest entry before `seq` (0 when there is none). */
  before(seq: number): number;
  /** How many entries come after `seq`. */
  count(after: number): number;
}

/** Eager: applied in the landing hook. Lazy: applied when read. */
export type DerivedMode = "eager" | "lazy";

/** One derived index. */
export interface Derived<L> {
  /** Its key in the cursor table. */
  readonly name: string;
  /** Bumping it rebuilds the index (see the file comment). */
  readonly version: number;
  readonly mode: DerivedMode;
  /**
   * Apply one landing, inside a transaction with the cursor's move. Idempotent per landing. Returns the
   * units of work it did (a catch-up's `work` budget counts them; nothing counts as 1).
   */
  apply(entry: LogEntry<L>): number | void;
  /**
   * Forget everything (a version change, a rebuild, a new trunk). Returns where the cursor starts
   * again: 0 to apply the whole log again, `head` for an index that is not built from history (it
   * reads what it needs elsewhere when read).
   */
  reset(head: number): number;
  /**
   * Where the cursor starts for an index that has none yet. `base` is the newest landing an index
   * kept up to date before cursors existed already reflects: the landing before this one in the
   * landing hook, the log's head in a catch-up. Without it the index is built from the whole log (0).
   */
  adopt?(base: number): number;
  /** After a slice of landings (and after the hook's apply), inside the same transaction: keep the index bounded. */
  settle?(): void;
}

/** What one catch-up may do. Each bound is checked between landings, so the landing in progress always finishes. */
export interface CatchUpBudget {
  /** Landings applied at most (default 1,000). */
  landings?: number;
  /** Units of work at most (what `apply` returns). */
  work?: number;
  /** Wall-clock time (ms), checked between slices. */
  ms?: number;
  /** Landings per transaction (default 100). */
  slice?: number;
}

/** What one catch-up did. */
export interface CatchUpResult {
  /** Landings applied (skipped ones included), and the work they did. */
  applied: number;
  work: number;
  /** Landings the index has not applied yet. */
  behind: number;
  /** The index's version had changed: it was forgotten, and the next catch-ups build it again. */
  rebuilt: boolean;
  /** The log could not be read: the catch-up stopped there. */
  error?: string;
}

/** One index's state, for status pages and tests. */
export interface DerivedStatus {
  name: string;
  mode: DerivedMode;
  version: number;
  /** The version its cursor was written for (null before its first use). */
  stored: number | null;
  /** The last landing it applied, the log's newest, and how many it has not applied yet. */
  seq: number;
  head: number;
  behind: number;
}

type Row = { version: number; seq: number };

/**
 * A set of derived indexes over one log, with their cursors in the ft_derived table of the same
 * storage. It keeps no state of its own besides the definitions, so a new set over the same storage
 * (a restart) resumes every index from its cursor.
 */
export class DerivedSet<L> {
  private readonly defs = new Map<string, Derived<L>>();
  private readonly now: () => number;

  constructor(
    private readonly sql: SqlStorage,
    private readonly transaction: (fn: () => void) => void,
    private readonly log: LandingLog<L>,
    defs: Iterable<Derived<L>> = [],
    private readonly opts: { label?: () => string | null; now?: () => number } = {},
  ) {
    for (const stmt of DERIVED_SCHEMA) sql.exec(stmt);
    for (const def of defs) this.define(def);
    this.now = opts.now ?? Date.now;
  }

  /** Add an index to the set (a definition with the same name replaces the earlier one). */
  define(def: Derived<L>): void {
    this.defs.set(def.name, def);
  }

  /**
   * The landing hook. Call it inside the transaction that records the landing, once the landing is in
   * the log. Each eager index that has applied every landing before this one applies it and moves its
   * cursor; one that has not (its version changed, or an earlier apply failed) is left to its
   * catch-up, which applies landings in order. Lazy indexes are not touched. Never throws: an index
   * must not fail a landing. Returns the eager indexes left behind.
   */
  landed(entry: LogEntry<L>): string[] {
    const behind: string[] = [];
    let base: number | null = null;
    for (const def of this.defs.values()) {
      if (def.mode !== "eager") continue;
      try {
        base ??= this.log.before(entry.seq);
        const row = this.row(def) ?? this.adopt(def, base);
        if (row.seq >= entry.seq) continue;
        if (row.version !== def.version || row.seq < base) {
          behind.push(def.name);
          continue;
        }
        def.apply(entry);
        def.settle?.();
        this.write(def, entry.seq);
      } catch (e) {
        behind.push(def.name);
        this.report(def.name, { error: errorText(e), seq: entry.seq });
      }
    }
    return behind;
  }

  /**
   * Bring one index toward the head of the log. A changed version first: the index is forgotten and
   * starts again from where `reset` says, and this call stops there (a reader such as the co-change
   * map can then hold the rebuild until it is ready for it). Otherwise the landings after its cursor
   * are applied oldest first, a slice per transaction, within the budget. Call it outside any
   * transaction. Never throws (fails open; see the file comment).
   */
  catchUp(name: string, budget: CatchUpBudget = {}): CatchUpResult {
    const out: CatchUpResult = { applied: 0, work: 0, behind: 0, rebuilt: false };
    const def = this.defs.get(name);
    if (!def) return out;
    const start = this.now();
    let seq = 0;
    try {
      const head = this.log.head();
      const row = this.row(def) ?? this.adopt(def, head);
      seq = row.seq;
      if (row.version !== def.version) {
        this.transaction(() => {
          seq = this.restart(def, head);
        });
        out.rebuilt = true;
      } else {
        const landings = Math.max(0, Math.floor(budget.landings ?? CATCH_UP_LANDINGS));
        const work = budget.work ?? Infinity;
        const ms = budget.ms ?? Infinity;
        const slice = Math.max(1, Math.floor(budget.slice ?? SLICE_LANDINGS));
        while (seq < head && out.applied < landings && out.work < work && this.now() - start <= ms) {
          const batch = this.log.after(seq, Math.min(slice, landings - out.applied));
          if (batch.length === 0) break;
          seq = this.slice(def, batch, seq, work, out);
        }
      }
      out.behind = this.log.count(seq);
    } catch (e) {
      out.error = errorText(e);
      try {
        out.behind = this.log.count(seq);
      } catch {
        out.behind = Math.max(1, out.behind);
      }
    }
    const ms = this.now() - start;
    if (out.rebuilt || out.error !== undefined || out.applied >= LOG_LANDINGS || ms >= LOG_MS) this.report(name, { ...out, ms });
    return out;
  }

  /** Forget one index now: it starts again from where `reset` says, and the next catch-ups build it. Call it alone or inside a transaction. */
  rebuild(name: string): void {
    const def = this.defs.get(name);
    if (def) this.restart(def, this.log.head());
  }

  /** Forget every index (a new trunk): each starts again from where its `reset` says. Call it alone or inside a transaction. */
  reset(): void {
    const head = this.log.head();
    this.sql.exec("DELETE FROM ft_derived");
    for (const def of this.defs.values()) this.restart(def, head);
  }

  /** Each index's version, cursor and how far behind the log it is. */
  status(): DerivedStatus[] {
    const head = this.log.head();
    return [...this.defs.values()].map((def) => {
      const row = this.row(def);
      const seq = row?.seq ?? 0;
      return { name: def.name, mode: def.mode, version: def.version, stored: row?.version ?? null, seq, head, behind: this.log.count(seq) };
    });
  }

  /**
   * Apply a slice of landings in one transaction, stopping before a landing once the work budget is
   * spent. When one of them fails the slice rolls back and they are applied one per transaction
   * instead, the one that fails skipped (its cursor moved past it) and logged. Returns the new cursor.
   */
  private slice(def: Derived<L>, batch: Array<LogEntry<L>>, from: number, maxWork: number, out: CatchUpResult): number {
    const done = { seq: from, applied: 0, work: 0 };
    try {
      this.transaction(() => {
        for (const e of batch) {
          if (out.work + done.work >= maxWork) break;
          done.work += units(def.apply(e));
          done.applied++;
          done.seq = e.seq;
        }
        def.settle?.();
        this.write(def, done.seq);
      });
      out.applied += done.applied;
      out.work += done.work;
      return done.seq;
    } catch {
      let seq = from;
      for (const e of batch) {
        if (out.work >= maxWork) break;
        let work = 0;
        try {
          this.transaction(() => {
            work = units(def.apply(e));
            def.settle?.();
            this.write(def, e.seq);
          });
        } catch (err) {
          this.report(def.name, { skipped: e.seq, error: errorText(err) });
          this.transaction(() => this.write(def, e.seq));
        }
        out.applied++;
        out.work += work;
        seq = e.seq;
      }
      return seq;
    }
  }

  /** Forget an index and write its new cursor (inside the caller's transaction, if any). */
  private restart(def: Derived<L>, head: number): number {
    const seq = cursorValue(def.reset(head));
    this.write(def, seq);
    return seq;
  }

  /** An index with no cursor yet starts where `adopt` says (the whole log without it). */
  private adopt(def: Derived<L>, base: number): Row {
    const seq = cursorValue(def.adopt?.(base) ?? 0);
    this.write(def, seq);
    return { version: def.version, seq };
  }

  private row(def: Derived<L>): Row | null {
    return this.sql.exec<Row>("SELECT version, seq FROM ft_derived WHERE name = ?", def.name).toArray()[0] ?? null;
  }

  private write(def: Derived<L>, seq: number): void {
    this.sql.exec("INSERT OR REPLACE INTO ft_derived (name, version, seq, at) VALUES (?, ?, ?, ?)", def.name, def.version, seq, this.now());
  }

  /** A log line about one index: errors go to the error log, the rest (rebuilds, long catch-ups) to the ordinary one. */
  private report(name: string, fields: Record<string, unknown>): void {
    const line = JSON.stringify({ ft: "derived", index: name, colonyId: this.opts.label?.() ?? null, ...fields });
    if (fields.error !== undefined) console.error(line);
    else console.log(line);
  }
}

/** Work units of one apply: what it returned, or 1. */
function units(w: number | void): number {
  return typeof w === "number" && Number.isFinite(w) ? Math.max(0, w) : 1;
}

/** A cursor value from an index's own answer: a whole number, at least 0. */
function cursorValue(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------
// The trunk writer's landing log
// ---------------------------------------------------------------------------

/** One landing of the trunk writer's log, as its derived indexes read it. */
export interface TrunkLanding {
  landing: Landing;
  /** Its lineage note (JSON text), null when it has none. */
  note: string | null;
  /**
   * Each path it changed with its blob after and before (null: deleted, or created). Only the landing
   * hook has them: a landing read back from the log knows its paths, not their blobs.
   */
  changes?: ReadonlyArray<readonly [Path, { blob: Sha | null; before?: Sha | null }]>;
}

/** TrunkDO's landing log: ft_landings in seq order, each landing with its lineage note (ft_notes). */
export function trunkLog(sql: SqlStorage): LandingLog<TrunkLanding> {
  const n = (query: string, ...bindings: unknown[]): number => sql.exec<{ n: number }>(query, ...bindings).one().n;
  return {
    after: (seq, limit) =>
      sql
        .exec<{ seq: number; id: string; trunk_sha: string; parent_sha: string; at: number; data: string; note: string | null }>(
          `SELECT l.seq AS seq, l.id AS id, l.trunk_sha AS trunk_sha, l.parent_sha AS parent_sha, l.at AS at, l.data AS data, n.note AS note
             FROM ft_landings l LEFT JOIN ft_notes n ON n.landing_id = l.id WHERE l.seq > ? ORDER BY l.seq LIMIT ?`,
          seq,
          Math.max(1, limit),
        )
        .toArray()
        .map((r) => ({ seq: r.seq, landing: { landing: recordedLanding(r), note: r.note } })),
    head: () => n("SELECT COALESCE(MAX(seq), 0) AS n FROM ft_landings"),
    before: (seq) => n("SELECT COALESCE(MAX(seq), 0) AS n FROM ft_landings WHERE seq < ?", seq),
    count: (after) => n("SELECT COUNT(*) AS n FROM ft_landings WHERE seq > ?", after),
  };
}

/**
 * A landing as a log stored it (its JSON), checked: the row's own columns win, lists keep only
 * strings, and a record that does not parse is the row's fields with empty lists.
 */
export function recordedLanding(r: { id: string; data: string; at: number; trunk_sha?: string; parent_sha?: string }): Landing {
  let x: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(r.data) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) x = parsed as Record<string, unknown>;
  } catch {
    // Unreadable: the row's fields only.
  }
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && s !== "") : []);
  const text = (v: unknown): string => (typeof v === "string" ? v : "");
  return {
    id: r.id,
    colonyId: text(x.colonyId),
    trunkSha: r.trunk_sha ?? text(x.trunkSha),
    parentSha: r.parent_sha ?? text(x.parentSha),
    proposalIds: list(x.proposalIds),
    intentIds: list(x.intentIds),
    paths: list(x.paths),
    regions: list(x.regions),
    at: typeof x.at === "number" && Number.isFinite(x.at) ? x.at : r.at,
  };
}
