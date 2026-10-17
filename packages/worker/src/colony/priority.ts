import type { Intent, IntentSource, PriorityCap } from "@fire_trident/core";

/**
 * Agent-declared priority (always on: a safety rule). An intent's priority orders every agent's work: take ranks open
 * intents by it, its need marks carry it as their strength, and its changes wait in their region's lane by it. So an
 * agent cannot put its own work above the work it was given: an intent an agent declares (source "agent": MCP declare,
 * Agent2Agent, POST /intents saying source agent) takes at most its parent's priority when the agent holds that parent
 * (assigned to it, claimed or proposed) or declared it, and DEFAULT_PRIORITY otherwise: with no parent, or under an
 * intent that is not its own (so naming a repair it does not hold as the parent borrows nothing). A person (PATCH
 * /intents/:id), a rule and the platform (certification's repairs, the megafile split, a revert's redo) keep the
 * priority they ask for. What the agent asked for is kept as `requestedPriority`, with which cap applied, when the cap
 * lowered it, so a person sees it and can raise the intent; the answer to the declare says so in a sentence.
 */

/** The priority an intent takes when it names none, and the most an agent's intent takes without a parent of its own. */
export const DEFAULT_PRIORITY = 1;

/** The priority an intent is declared at, and what was asked and which cap applied when the cap lowered it. */
export interface GrantedPriority {
  priority: number;
  /** Only when the cap lowered the priority asked for. */
  requestedPriority?: number;
  /** Only with requestedPriority. */
  priorityCap?: PriorityCap;
}

/** The columns of the parent intent's row the cap reads. */
export interface ParentRow {
  priority: unknown;
  status?: unknown;
  assigned_to?: unknown;
  created_by?: unknown;
}

/** Whether an intent from this source has its priority capped: only an agent's. */
export function priorityCapped(source: IntentSource): boolean {
  return source === "agent";
}

/**
 * Whether the declarer holds the parent (assigned to it while claimed or proposed) or declared it (its created_by). A
 * declarer with no name (empty or "unknown") owns nothing, so two unnamed callers never match each other.
 */
export function parentIsTheirs(parent: ParentRow, by: string): boolean {
  if (typeof by !== "string" || by === "" || by === "unknown") return false;
  if (parent.created_by === by) return true;
  return parent.assigned_to === by && (parent.status === "claimed" || parent.status === "proposed");
}

/**
 * The most an agent's intent takes, and why: its parent's priority (floored at 0) when the declarer holds or declared
 * the parent (`parent`); DEFAULT_PRIORITY with no parent (`no-parent`); and under any other parent the lower of
 * DEFAULT_PRIORITY and the parent's priority (`other-parent`, or `parent` when the parent's is the lower). A parent whose
 * priority is not a finite number counts as DEFAULT_PRIORITY, so a bad row never lifts the cap.
 */
export function priorityCap(parent: ParentRow | null | undefined, by: string): { cap: number; reason: PriorityCap } {
  if (!parent) return { cap: DEFAULT_PRIORITY, reason: "no-parent" };
  const p = parent.priority;
  const own = typeof p === "number" && Number.isFinite(p) ? Math.max(0, p) : DEFAULT_PRIORITY;
  if (parentIsTheirs(parent, by) || own < DEFAULT_PRIORITY) return { cap: own, reason: "parent" };
  return { cap: DEFAULT_PRIORITY, reason: "other-parent" };
}

/**
 * The priority an intent is declared at. What was asked counts when it is a finite number, floored at 0 (anything else
 * asks for DEFAULT_PRIORITY). An agent's intent takes the lower of that and its cap (priorityCap, for the declarer
 * `by`); every other source keeps what it asked. `requestedPriority` and `priorityCap` are set only when the cap lowered it.
 */
export function grantPriority(asked: unknown, source: IntentSource, parent: ParentRow | null | undefined, by: string): GrantedPriority {
  const requested = typeof asked === "number" && Number.isFinite(asked) ? Math.max(0, asked) : DEFAULT_PRIORITY;
  if (!priorityCapped(source)) return { priority: requested };
  const { cap, reason } = priorityCap(parent, by);
  return requested > cap ? { priority: cap, requestedPriority: requested, priorityCap: reason } : { priority: requested };
}

/**
 * The `requestedPriority` an intent row reports: what was asked, while it still differs from the intent's priority
 * (a person may since have raised it to that). Undefined for a row that has none, such as one written before the column.
 */
export function requestedPriorityOf(requested: unknown, priority: number): number | undefined {
  return typeof requested === "number" && Number.isFinite(requested) && requested !== priority ? requested : undefined;
}

/** The cap a row names, or undefined when it names none the colony writes. */
export function priorityCapOf(v: unknown): PriorityCap | undefined {
  return v === "parent" || v === "no-parent" || v === "other-parent" ? v : undefined;
}

/** A priority as a sentence shows it. */
function shown(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000);
}

/**
 * The sentence that tells an agent what its declare was granted, or null when it got what it asked for. It names what
 * was asked, the cap that applied (its parent's priority, the default with no parent, or the default under a parent
 * that is not its own) and what it got. An intent that does not say which cap applied reads it from its parent.
 */
export function priorityNote(i: Pick<Intent, "priority" | "requestedPriority" | "priorityCap" | "parentId">): string | null {
  const asked = i.requestedPriority;
  if (typeof asked !== "number" || asked === i.priority) return null;
  const got = shown(i.priority);
  const reason = i.priorityCap ?? (i.parentId ? "parent" : "no-parent");
  if (reason === "other-parent") return `You asked for priority ${shown(asked)}; its parent is not an intent you hold or declared, so it was declared at ${got}. A person can raise it.`;
  const rule = reason === "parent" ? `an agent's intent takes at most its parent's priority (${got})` : `an agent's intent with no parent takes at most the default priority (${got})`;
  return `You asked for priority ${shown(asked)}; ${rule}, so it was declared at ${got}. A person can raise it.`;
}

/** What a declare answer adds when the cap lowered the priority: the priority granted, the one asked and the sentence. */
export function priorityAnswer(i: Pick<Intent, "priority" | "requestedPriority" | "priorityCap" | "parentId">): { priority: number; requestedPriority: number; priorityNote: string } | null {
  const note = priorityNote(i);
  return note && i.requestedPriority !== undefined ? { priority: i.priority, requestedPriority: i.requestedPriority, priorityNote: note } : null;
}

/** The lineage note's priority fields for an intent: both, only when what was asked differs from what it got. */
export function notePriority(i: { priority?: unknown; requestedPriority?: unknown }): { priority: number; requestedPriority: number } | Record<string, never> {
  const { priority, requestedPriority } = i;
  if (typeof priority !== "number" || typeof requestedPriority !== "number" || !Number.isFinite(priority) || !Number.isFinite(requestedPriority)) return {};
  return requestedPriority !== priority ? { priority, requestedPriority } : {};
}

/** The SQL surface the migration needs. */
interface SqlLike {
  exec(query: string, ...bindings: unknown[]): { toArray(): unknown[] };
}

/** Columns added to tables that predate the cap: what an agent asked for when the cap lowered it, and which cap (null otherwise). */
export const PRIORITY_COLUMNS: ReadonlyArray<readonly [table: string, column: string, decl: string]> = [
  ["intents", "requested_priority", "REAL"],
  ["intents", "priority_cap", "TEXT"],
];

/** Add the cap's columns a table is missing (checked first; an ALTER that still fails is skipped). Nothing is rewritten. */
export function migratePriority(sql: SqlLike): void {
  const known = new Map<string, Set<string> | null>();
  for (const [table, column, decl] of PRIORITY_COLUMNS) {
    if (!known.has(table)) {
      try {
        known.set(table, new Set((sql.exec(`PRAGMA table_info(${table})`).toArray() as Array<{ name?: unknown }>).map((c) => String(c?.name ?? ""))));
      } catch {
        known.set(table, null);
      }
    }
    if (known.get(table)?.has(column)) continue;
    try {
      sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
    } catch {
      // Already there.
    }
  }
}
