import type { Id, Intent, Path, Sha } from "@fire_trident/core";
import type { SqlRunner } from "./inline.ts";

/**
 * Intents as Agent2Agent tasks (FT_A2A; api/a2a.ts renders them): what the colony's tables say about one intent, or
 * about a page of intents, latest update first. A landed intent carries the landing that completed it (the newest of
 * its proposals that landed, with the trunk commit the colony recorded for that landing while it still keeps it), a
 * proposed one whether a change for it waits for a person's review, and an open one whether an agent's report on it
 * waits for a person. Vaccine intents are never tasks. Read only, apart from the proposals_by_intent index that the
 * take path and the stuck detector also create.
 *
 * How an intent's status maps to a task's state (a2aState):
 *   open                                   submitted
 *   open, an agent's report waits          input-required (a person answers; amend or dismiss reopen it, withdraw ends it)
 *   claimed, proposed                      working
 *   landed                                 completed
 *   withdrawn by CancelTask                canceled (the withdrawal reason starts with A2A_CANCEL_REASON)
 *   withdrawn otherwise, abandoned         failed (a person, a retracted rule or a person's answer to a report withdrew it;
 *                                          abandoned intents are sealed vaccines, which are never listed)
 */

/** The reason CancelTask withdraws an intent with: a withdrawal whose reason starts with it is canceled, any other failed. */
export const A2A_CANCEL_REASON = "canceled over A2A";

/** A task's state as the colony maps it from its intent; api/a2a.ts spells it per protocol version. */
export type A2AState = "submitted" | "working" | "input-required" | "completed" | "canceled" | "failed";

/** Every state, in the order the docs list them. */
export const A2A_STATES: readonly A2AState[] = ["submitted", "working", "input-required", "completed", "canceled", "failed"];

/** Tasks a page holds by default, and at most. */
export const A2A_PAGE_DEFAULT = 50;
export const A2A_PAGE_MAX = 100;
/** Files of a landed change a task reports at most. */
const PATHS_MAX = 200;

/** The landing that completed an intent. */
export interface A2ALanding {
  id: Id;
  /** The intent's proposal that landed. */
  proposalId: Id;
  /** The trunk commit, or null when the colony no longer keeps the landing (it keeps its newest 1,000). */
  commit: Sha | null;
  /** When it landed (ms), or null when unknown. */
  at: number | null;
  /** The files the intent's change wrote, at most PATHS_MAX. */
  paths: Path[];
  /** Files beyond those. */
  morePaths: number;
}

/** One intent as a task. */
export interface A2ATaskFacts {
  intent: Intent;
  /** The intent's last update (ms): its task's status time. */
  updatedAt: number;
  /** An agent's report that the intent cannot be done as written waits for a person. */
  waiting?: true;
  /** A change for the intent waits for a person's review. */
  inReview?: true;
  /** Landed intents: the landing that completed it, when the colony has it on record. */
  landing?: A2ALanding;
}

/** Where a page ended: its last task's update time and id. */
export interface A2ACursor {
  at: number;
  id: Id;
}

/** What to read: one intent (`id`), or a page of intents. */
export interface A2AQuery {
  id?: Id;
  /** Only tasks in these states (absent or empty: every state). */
  states?: A2AState[];
  /** Only intents updated after this time (ms). */
  after?: number;
  /** Tasks a page holds, 1 to A2A_PAGE_MAX (default A2A_PAGE_DEFAULT). */
  limit?: number;
  /** Where the previous page ended. */
  cursor?: A2ACursor;
}

/** A page of tasks, latest update first. */
export interface A2APage {
  tasks: A2ATaskFacts[];
  /** Tasks that match across every page. */
  total: number;
  /** Where the next page starts, or null on the last page. */
  next: A2ACursor | null;
}

/** Whether a withdrawal reason is the one CancelTask writes. */
export function isA2ACancel(reason: unknown): boolean {
  return typeof reason === "string" && reason.startsWith(A2A_CANCEL_REASON);
}

/** The task state of an intent (see the table above). Unknown statuses read as failed: nothing will move them. */
export function a2aState(i: { status: string; withdrawnReason?: string | null }, waiting = false): A2AState {
  switch (i.status) {
    case "open":
      return waiting ? "input-required" : "submitted";
    case "claimed":
    case "proposed":
      return "working";
    case "landed":
      return "completed";
    case "withdrawn":
      return isA2ACancel(i.withdrawnReason) ? "canceled" : "failed";
    default:
      return "failed";
  }
}

/** Whether a state is terminal in the protocol: completed, canceled or failed. */
export function a2aTerminal(s: A2AState): boolean {
  return s === "completed" || s === "canceled" || s === "failed";
}

/** Each state as a condition on the intents table, matching a2aState. */
const CANCELED = `substr(COALESCE(withdrawn_reason, ''), 1, ${A2A_CANCEL_REASON.length}) = '${A2A_CANCEL_REASON}'`;
const STATE_SQL: Readonly<Record<A2AState, string>> = {
  submitted: "(status = 'open' AND COALESCE(escalation_open, 0) != 1)",
  "input-required": "(status = 'open' AND escalation_open = 1)",
  working: "status IN ('claimed', 'proposed')",
  completed: "status = 'landed'",
  canceled: `(status = 'withdrawn' AND ${CANCELED})`,
  failed: `(status NOT IN ('open', 'claimed', 'proposed', 'landed', 'withdrawn') OR (status = 'withdrawn' AND NOT ${CANCELED}))`,
};

/** The intents table columns a page reads first. */
interface TaskRow {
  id: string;
  updated_at: number;
  escalation_open: number | null;
}

/** Colonies whose proposals_by_intent index this isolate has made sure of (the same index lastReturn creates). */
const indexed = new WeakSet<object>();

function ensureIndex(sql: SqlRunner): void {
  if (indexed.has(sql)) return;
  try {
    sql.exec("CREATE INDEX IF NOT EXISTS proposals_by_intent ON proposals(intent_id, created_at)");
    indexed.add(sql);
  } catch (err) {
    // The reads still work without it, only slower.
    console.warn(`a2a: proposals_by_intent not created: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * One intent (`q.id`) or a page of the colony's intents as task facts, latest update first (ties by id), vaccines left
 * out. `load` reads one intent as the colony serves it.
 */
export function a2aTasks(sql: SqlRunner, q: A2AQuery, load: (id: Id) => Intent | null): A2APage {
  ensureIndex(sql);
  if (typeof q.id === "string") {
    const rows = sql.exec("SELECT id, updated_at, escalation_open FROM intents WHERE id = ? AND created_by != 'vaccine'", q.id).toArray() as TaskRow[];
    const tasks = factsOf(sql, rows, load);
    return { tasks, total: tasks.length, next: null };
  }
  const where = ["created_by != 'vaccine'"];
  const args: unknown[] = [];
  const states = Array.isArray(q.states) ? A2A_STATES.filter((s) => q.states!.includes(s)) : [];
  if (states.length > 0) where.push(`(${states.map((s) => STATE_SQL[s]).join(" OR ")})`);
  if (typeof q.after === "number" && Number.isFinite(q.after)) {
    where.push("updated_at > ?");
    args.push(q.after);
  }
  const counted = sql.exec(`SELECT COUNT(*) AS n FROM intents WHERE ${where.join(" AND ")}`, ...args).toArray()[0] as { n?: number } | undefined;
  const limit = Math.max(1, Math.min(A2A_PAGE_MAX, Math.floor(Number(q.limit) || A2A_PAGE_DEFAULT)));
  if (q.cursor && Number.isFinite(q.cursor.at) && typeof q.cursor.id === "string") {
    where.push("(updated_at < ? OR (updated_at = ? AND id < ?))");
    args.push(q.cursor.at, q.cursor.at, q.cursor.id);
  }
  const rows = sql
    .exec(`SELECT id, updated_at, escalation_open FROM intents WHERE ${where.join(" AND ")} ORDER BY updated_at DESC, id DESC LIMIT ?`, ...args, limit + 1)
    .toArray() as TaskRow[];
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { tasks: factsOf(sql, page, load), total: Number(counted?.n ?? 0), next: rows.length > limit && last ? { at: Number(last.updated_at), id: last.id } : null };
}

/** The facts of these rows: each intent, and the landing or review state its status calls for. */
function factsOf(sql: SqlRunner, rows: TaskRow[], load: (id: Id) => Intent | null): A2ATaskFacts[] {
  const out: A2ATaskFacts[] = [];
  for (const r of rows) {
    const intent = load(r.id);
    if (!intent) continue;
    out.push({ intent, updatedAt: Number(r.updated_at), ...(r.escalation_open === 1 ? { waiting: true as const } : {}) });
  }
  const landed = out.filter((f) => f.intent.status === "landed");
  if (landed.length > 0) {
    const landings = landingsOf(sql, landed.map((f) => f.intent.id));
    for (const f of landed) {
      const l = landings.get(f.intent.id);
      if (l) f.landing = l;
    }
  }
  const proposed = out.filter((f) => f.intent.status === "proposed").map((f) => f.intent.id);
  if (proposed.length > 0) {
    const waiting = new Set(
      (sql.exec("SELECT DISTINCT intent_id FROM proposals WHERE intent_id IN (SELECT value FROM json_each(?)) AND status = 'escalated'", JSON.stringify(proposed)).toArray() as Array<{ intent_id: string }>).map(
        (r) => r.intent_id,
      ),
    );
    for (const f of out) if (waiting.has(f.intent.id)) f.inReview = true;
  }
  return out;
}

/** The landing of each intent: its newest landed proposal, and the trunk commit of that landing while the colony keeps it. */
function landingsOf(sql: SqlRunner, intentIds: Id[]): Map<Id, A2ALanding> {
  const rows = sql
    .exec(
      `SELECT id, intent_id, updated_at, json_extract(data, '$.landingId') AS landing_id, json_extract(data, '$.writeSet') AS write_set
         FROM proposals WHERE intent_id IN (SELECT value FROM json_each(?)) AND status = 'landed' ORDER BY updated_at DESC`,
      JSON.stringify(intentIds),
    )
    .toArray() as Array<{ id: string; intent_id: string; updated_at: number; landing_id: unknown; write_set: unknown }>;
  const newest = new Map<Id, (typeof rows)[number]>();
  for (const r of rows) if (!newest.has(r.intent_id) && typeof r.landing_id === "string" && r.landing_id !== "") newest.set(r.intent_id, r);
  const ids = [...new Set([...newest.values()].map((r) => r.landing_id as string))];
  const recorded = new Map<Id, { trunk_sha: string; at: number }>();
  if (ids.length > 0) {
    for (const l of sql.exec("SELECT id, trunk_sha, at FROM landings WHERE id IN (SELECT value FROM json_each(?))", JSON.stringify(ids)).toArray() as Array<{ id: string; trunk_sha: string; at: number }>) {
      recorded.set(l.id, l);
    }
  }
  const out = new Map<Id, A2ALanding>();
  for (const [intentId, r] of newest) {
    const id = r.landing_id as string;
    const l = recorded.get(id);
    const paths = writtenPaths(r.write_set);
    const at = l ? Number(l.at) : Number(r.updated_at);
    out.set(intentId, {
      id,
      proposalId: r.id,
      commit: l && typeof l.trunk_sha === "string" && l.trunk_sha !== "" ? l.trunk_sha : null,
      at: Number.isFinite(at) ? at : null,
      paths: paths.slice(0, PATHS_MAX),
      morePaths: Math.max(0, paths.length - PATHS_MAX),
    });
  }
  return out;
}

/** The paths of a stored write set (JSON text); anything unreadable is none. */
function writtenPaths(raw: unknown): Path[] {
  try {
    const parsed: unknown = typeof raw === "string" ? JSON.parse(raw) : null;
    if (!Array.isArray(parsed)) return [];
    const out = new Set<Path>();
    for (const w of parsed) {
      const path = (w as { path?: unknown } | null)?.path;
      if (typeof path === "string" && path !== "") out.add(path);
    }
    return [...out];
  } catch {
    return [];
  }
}
