import { footprintCovers, revalidationEnabled } from "@fire_trident/core";
import type { Id, Millis, MovedBy, Path, Proposal, ReturnWarning, Sha, ToldOf } from "@fire_trident/core";
import { WHY_FOOTPRINT, indexRange, isLiteralEntry, pickLanded, shortTitle, type LandedRow } from "../agents/landed.ts";

/**
 * Heads-up (FT_HEADS_UP): what an agent working on an intent should know before it proposes, from the colony's own
 * tables. Two lists, both cheap and bounded:
 *
 * - trunk moved under you: the landings since the agent's lease base that changed files it read or will write (its read
 *   set as its MCP session holds it, its intent's footprint, and the files a hook asks about), read from the per-path
 *   landing index the why-context and landing notices use (`landing_paths`, agents/landed.ts), grouped by landing with
 *   the intent each completed;
 * - changes waiting ahead: proposals in flight (pending, checking, ready) whose write sets meet those files, from the
 *   colony's proposals table, read at most every LANE_TTL_MS for the whole colony. If one lands first, the agent's
 *   change comes back. The read takes the oldest LANE_SCAN; with more in flight the report says how many it checked
 *   of how many (`aheadScanned`), so a partial answer never reads as a complete one.
 *
 * Read-only: the MCP server (mcp/headsup.ts) asks for it on each reply and records what it told the agent in the
 * session; GET /api/colonies/:id/agents/:aid/headsup serves it to the Claude Code hook (`ft hook check`).
 *
 * When a change goes back because trunk moved, `warnReturn` reads what the MCP server had told its agent (the proposal's
 * `toldOf`) and says whether and when the agent was told of the landing that beat it; the colony counts the return as
 * warned (it proposed anyway) or unwarned (it could not have known).
 */

/** Landings and waiting changes one heads-up lists at most, and paths per entry. */
export const HEADS_UP_LANDINGS = 5;
export const HEADS_UP_AHEAD = 5;
export const HEADS_UP_PATHS = 10;
/** Files of the read set, and files a hook asks about, looked up at most. */
export const HEADS_UP_READS = 64;
export const HEADS_UP_ASKED = 4;
/** Index rows read for one directory or glob of the footprint. */
const RANGE_ROWS = 200;
/** How long the colony reuses its read of the changes in flight (ms), and how many it reads (oldest first). */
export const LANE_TTL_MS = 2_000;
export const LANE_SCAN = 200;
/** Landings a proposal's toldOf keeps at most. */
export const TOLD_KEEP = 16;
/** The metric names of the two kinds of return (GET /metrics). */
export const HEADS_UP_WARNED = "headsUp.warned";
export const HEADS_UP_UNWARNED = "headsUp.unwarned";
/** Paths per IN (...) list. */
const IN_CHUNK = 500;
const ID = /^[\w-]{1,100}$/;
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
/** Latest time a Date can show (ms since the epoch). */
const MAX_DATE_MS = 8.64e15;

/** Whether FT_HEADS_UP covers the colony ("on", or a comma-separated list of colony ids). */
export function headsUpEnabled(setting: string | undefined, colonyId: Id): boolean {
  return revalidationEnabled(setting, colonyId);
}

/** The SQL the heads-up runs (a Durable Object's storage, or node:sqlite in unit tests). */
export interface SqlRunner {
  exec(query: string, ...bindings: unknown[]): { toArray(): unknown[] };
}

/**
 * What to look at. The MCP server passes the session's intent, lease base and read set; the hook's route passes only the
 * files it asks about, and the colony uses the intent the agent holds and its lease.
 */
export interface HeadsUpQuery {
  intentId?: Id;
  baseSha?: Sha;
  reads?: Path[];
  paths?: Path[];
}

/** A landing since the lease base that changed files the agent read or will write (the intent's title is data). */
export interface HeadsUpMoved {
  landingId: Id;
  at: Millis;
  intentId?: Id;
  title: string;
  paths: Path[];
}

/** A change waiting to land whose write set meets the agent's files (the intent's title is data). */
export interface HeadsUpAhead {
  proposalId: Id;
  intentId: Id;
  title: string;
  region: string;
  paths: Path[];
}

/** One heads-up: what moved, newest first, and what waits, oldest first; `more*` count the entries left out. */
export interface HeadsUpReport {
  moved: HeadsUpMoved[];
  ahead: HeadsUpAhead[];
  moreMoved?: number;
  moreAhead?: number;
  /**
   * Only the oldest `scanned` of the `of` changes in flight were checked for `ahead` (LANE_SCAN): one of the others may
   * write the agent's files too. Absent: every change in flight was checked.
   */
  aheadScanned?: { scanned: number; of: number };
}

/** The answer for one agent: the intent and lease base looked at, and the heads-up (null when there is nothing to say). */
export interface HeadsUpAnswer {
  intentId: Id | null;
  baseSha: Sha | null;
  report: HeadsUpReport | null;
}

/** The files one heads-up looks at: exact paths, and the footprint's directories and globs. */
interface Watch {
  agentId: Id;
  intentId: Id;
  baseSha: Sha;
  exact: Set<Path>;
  patterns: string[];
}

/** One change in flight as the colony keeps it between reads. */
interface LaneEntry {
  id: Id;
  intentId: Id;
  agentId: Id;
  region: string;
  createdAt: number;
  paths: Path[];
}

function first<T>(sql: SqlRunner, query: string, ...bindings: unknown[]): T | undefined {
  return sql.exec(query, ...bindings).toArray()[0] as T | undefined;
}

function rows<T>(sql: SqlRunner, query: string, ...bindings: unknown[]): T[] {
  return sql.exec(query, ...bindings).toArray() as T[];
}

/** A repository path as the colony keeps it (no leading "./" or "/"), or "" when it is not one. */
function cleanAsked(p: unknown): Path {
  if (typeof p !== "string" || p.length > 1_024) return "";
  return p.trim().replace(/^(?:\.\/)+/, "").replace(/^\/+/, "");
}

/** A JSON list of strings, or [] when unreadable. */
function stringList(text: unknown): string[] {
  if (typeof text !== "string") return [];
  try {
    const v = JSON.parse(text) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "") : [];
  } catch {
    return [];
  }
}

/** The lease base an agent row records, or null. */
function leaseBase(workspace: unknown): Sha | null {
  if (typeof workspace !== "string") return null;
  try {
    const lease = JSON.parse(workspace) as { baseSha?: unknown } | null;
    return lease && typeof lease.baseSha === "string" && SHA.test(lease.baseSha) ? lease.baseSha : null;
  } catch {
    return null;
  }
}

/**
 * The colony's heads-up. One per ColonyDO: it keeps the changes in flight for LANE_TTL_MS, so a burst of replies reads
 * the proposals table once. Everything else is a few indexed lookups.
 */
export class HeadsUpBook {
  /** The changes in flight as last read, and, when the read stopped at LANE_SCAN, how many it read of how many (else null). */
  private lane: { at: number; entries: LaneEntry[]; scan: { scanned: number; of: number } | null } | null = null;

  constructor(
    private readonly sql: SqlRunner,
    private readonly now: () => number = Date.now,
  ) {}

  /** The heads-up for an agent: its intent (the one asked about, else the one it holds), that intent's lease base, its files. */
  answer(agentId: Id, q: HeadsUpQuery = {}): HeadsUpAnswer {
    const agent = first<{ intent_id: string | null; workspace: string | null }>(this.sql, "SELECT intent_id, workspace FROM agents WHERE id = ?", agentId);
    const asked = typeof q.intentId === "string" && ID.test(q.intentId) ? q.intentId : null;
    const intentId = asked ?? agent?.intent_id ?? null;
    if (!agent || !intentId) return { intentId: null, baseSha: null, report: null };
    const intent = first<{ footprint: string }>(this.sql, "SELECT footprint FROM intents WHERE id = ?", intentId);
    const baseSha = typeof q.baseSha === "string" && SHA.test(q.baseSha) ? q.baseSha : agent.intent_id === intentId ? leaseBase(agent.workspace) : null;
    if (!intent || !baseSha) return { intentId, baseSha, report: null };
    const exact = new Set<Path>();
    const patterns: string[] = [];
    for (const entry of stringList(intent.footprint).slice(0, WHY_FOOTPRINT)) {
      const e = cleanAsked(entry);
      if (!e) continue;
      if (isLiteralEntry(e)) exact.add(e);
      else patterns.push(e);
    }
    for (const p of (Array.isArray(q.reads) ? q.reads : []).slice(0, HEADS_UP_READS)) if (cleanAsked(p)) exact.add(cleanAsked(p));
    for (const p of (Array.isArray(q.paths) ? q.paths : []).slice(0, HEADS_UP_ASKED)) if (cleanAsked(p)) exact.add(cleanAsked(p));
    return { intentId, baseSha, report: this.report({ agentId, intentId, baseSha, exact, patterns }) };
  }

  /** Both lists for these files; null when both are empty and every change in flight was checked. */
  private report(w: Watch): HeadsUpReport | null {
    const moved = this.moved(w);
    const ahead = this.ahead(w);
    // A read that stopped at LANE_SCAN says so even with nothing found: "nothing waits" would not be true then.
    const scan = this.lane?.scan ?? null;
    if (moved.length === 0 && ahead.length === 0 && scan === null) return null;
    const out: HeadsUpReport = { moved: moved.slice(0, HEADS_UP_LANDINGS), ahead: ahead.slice(0, HEADS_UP_AHEAD) };
    if (moved.length > HEADS_UP_LANDINGS) out.moreMoved = moved.length - HEADS_UP_LANDINGS;
    if (ahead.length > HEADS_UP_AHEAD) out.moreAhead = ahead.length - HEADS_UP_AHEAD;
    if (scan !== null) out.aheadScanned = { ...scan };
    return out;
  }

  /**
   * The landings after the lease base that changed the watched files, newest first, grouped by landing and intent as the
   * why-context groups them (pickLanded). The base is the landing that made the lease's commit; a base the colony never
   * recorded (its first commit) counts every landing, as movedBy does, so a heads-up names what a return would name.
   */
  private moved(w: Watch): HeadsUpMoved[] {
    const base = first<{ id: string; at: number }>(this.sql, "SELECT id, at FROM landings WHERE trunk_sha = ? LIMIT 1", w.baseSha);
    const since = base?.at ?? 0;
    const found: LandedRow[] = [];
    const add = (list: Array<{ path: string; at: number; landing_id: string; intent_id: string | null }>): void => {
      for (const r of list) if (r.landing_id !== base?.id) found.push({ path: r.path, at: r.at, landingId: r.landing_id, intentId: r.intent_id });
    };
    const exact = [...w.exact];
    for (let i = 0; i < exact.length; i += IN_CHUNK) {
      add(rows(this.sql, "SELECT path, at, landing_id, intent_id FROM landing_paths WHERE path IN (SELECT value FROM json_each(?)) AND at >= ?", JSON.stringify(exact.slice(i, i + IN_CHUNK)), since));
    }
    for (const entry of w.patterns) {
      const range = indexRange(entry);
      if (!range || "eq" in range) continue;
      add(rows(this.sql, "SELECT path, at, landing_id, intent_id FROM landing_paths WHERE path >= ? AND path < ? AND at >= ? ORDER BY at DESC LIMIT ?", range.from, range.to, since, RANGE_ROWS));
    }
    if (found.length === 0) return [];
    const picked = pickLanded(found, [...exact, ...w.patterns], Number.MAX_SAFE_INTEGER);
    const titles = this.titles(picked.flatMap((e) => (e.intentId ? [e.intentId] : [])));
    return picked.map((e) => ({
      landingId: e.landingId,
      at: e.at,
      ...(e.intentId ? { intentId: e.intentId } : {}),
      title: e.intentId ? (titles.get(e.intentId) ?? "") : "",
      paths: e.paths.slice(0, HEADS_UP_PATHS),
    }));
  }

  /** Other agents' changes in flight, for other intents, whose write sets meet the watched files, oldest first. */
  private ahead(w: Watch): HeadsUpAhead[] {
    const hits: Array<{ e: LaneEntry; paths: Path[] }> = [];
    for (const e of this.inFlight()) {
      if (e.agentId === w.agentId || e.intentId === w.intentId) continue;
      const paths = e.paths.filter((p) => w.exact.has(p) || w.patterns.some((entry) => footprintCovers(entry, p)));
      if (paths.length > 0) hits.push({ e, paths: [...new Set(paths)].sort().slice(0, HEADS_UP_PATHS) });
    }
    if (hits.length === 0) return [];
    const titles = this.titles(hits.slice(0, HEADS_UP_AHEAD).map((h) => h.e.intentId));
    return hits.map(({ e, paths }) => ({ proposalId: e.id, intentId: e.intentId, title: titles.get(e.intentId) ?? "", region: e.region, paths }));
  }

  /**
   * The changes in flight with the paths they write (the oldest LANE_SCAN), read again at most every LANE_TTL_MS. A read
   * that took LANE_SCAN of them also counts how many are in flight, which report() names when it is more.
   */
  private inFlight(): LaneEntry[] {
    const now = this.now();
    if (this.lane && now - this.lane.at < LANE_TTL_MS) return this.lane.entries;
    // LEFT JOIN: a change with no written path still counts as one read.
    const found = rows<{ id: string; intent_id: string; agent_id: string; region: string; created_at: number; path: string | null }>(
      this.sql,
      `SELECT p.id AS id, p.intent_id AS intent_id, p.agent_id AS agent_id, p.region AS region, p.created_at AS created_at, json_extract(w.value, '$.path') AS path
         FROM (SELECT id, intent_id, agent_id, region, created_at, data FROM proposals WHERE status IN ('pending', 'checking', 'ready') ORDER BY created_at LIMIT ?) p
         LEFT JOIN json_each(p.data, '$.writeSet') w`,
      LANE_SCAN,
    );
    const byId = new Map<Id, LaneEntry>();
    const read = new Set<Id>();
    for (const r of found) {
      read.add(r.id);
      if (typeof r.path !== "string" || r.path === "") continue;
      const e = byId.get(r.id) ?? { id: r.id, intentId: r.intent_id, agentId: r.agent_id, region: r.region, createdAt: r.created_at, paths: [] };
      e.paths.push(r.path);
      byId.set(r.id, e);
    }
    const entries = [...byId.values()].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    let scan: { scanned: number; of: number } | null = null;
    if (read.size >= LANE_SCAN) {
      const n = Number(first<{ n: number }>(this.sql, "SELECT COUNT(*) AS n FROM proposals WHERE status IN ('pending', 'checking', 'ready')")?.n ?? 0);
      if (n > read.size) scan = { scanned: read.size, of: n };
    }
    this.lane = { at: now, entries, scan };
    return entries;
  }

  /** Intent titles as a take shows them (one line, cut). */
  private titles(ids: Id[]): Map<Id, string> {
    const want = [...new Set(ids)].slice(0, IN_CHUNK);
    if (want.length === 0) return new Map();
    return new Map(rows<{ id: string; title: string }>(this.sql, "SELECT id, title FROM intents WHERE id IN (SELECT value FROM json_each(?))", JSON.stringify(want)).map((r) => [r.id, shortTitle(r.title)]));
  }
}

/** A time as a sentence shows it: "12:03:10 UTC". */
function clock(at: number): string {
  return `${new Date(at).toISOString().slice(11, 19)} UTC`;
}

/** A gap as a sentence shows it: "40 s", "less than a second", "12 min". */
function gapText(ms: number): string {
  const s = Math.round(Math.max(0, ms) / 1000);
  if (s === 0) return "less than a second";
  return s < 120 ? `${s} s` : `${Math.round(s / 60)} min`;
}

function moment(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= MAX_DATE_MS;
}

/**
 * A proposal's toldOf as received over RPC or read back, checked field by field and capped; undefined when it is not one
 * (older data and other callers send none).
 */
export function cleanToldOf(x: unknown): ToldOf | undefined {
  if (!x || typeof x !== "object") return undefined;
  const t = x as Record<string, unknown>;
  const entry = (raw: unknown): { landingId: Id; at: Millis; toldAt: Millis } | null => {
    if (!raw || typeof raw !== "object") return null;
    const e = raw as Record<string, unknown>;
    return typeof e.landingId === "string" && ID.test(e.landingId) && moment(e.at) && moment(e.toldAt) ? { landingId: e.landingId, at: e.at, toldAt: e.toldAt } : null;
  };
  const landings = (Array.isArray(t.landings) ? t.landings : []).map(entry).filter((e): e is NonNullable<typeof e> => e !== null).slice(0, TOLD_KEEP);
  const out: ToldOf = { landings };
  const through = entry(t.through);
  if (through) out.through = through;
  if (moment(t.lastReplyAt)) out.lastReplyAt = t.lastReplyAt;
  return out;
}

/** The toldOf field a new proposal keeps: the cleaned value, or nothing. */
export function toldOfField(x: unknown): { toldOf?: ToldOf } {
  const told = cleanToldOf(x);
  return told ? { toldOf: told } : {};
}

/**
 * Whether the agent of a change going back because trunk moved had been told of the landing that beat it, and the
 * sentence its reason ends with. Warned: a reply named one of the landings that moved its files (movedBy) before it
 * proposed. Otherwise unwarned, naming the newest of them: told only after it proposed, landed after its last reply, or
 * named by no reply. Null without movedBy or without a toldOf (an agent the heads-up never served).
 */
export function returnWarning(p: Pick<Proposal, "createdAt" | "toldOf" | "movedBy">): { warning: ReturnWarning; sentence: string } | null {
  const told = cleanToldOf(p.toldOf);
  const moved: readonly MovedBy[] = Array.isArray(p.movedBy) ? p.movedBy : [];
  if (!told || moved.length === 0 || !moment(p.createdAt)) return null;
  const toldAt = new Map(told.landings.map((l) => [l.landingId, l.toldAt]));
  const proposedAt = p.createdAt;
  const before = moved.find((m) => (toldAt.get(m.landingId) ?? Number.POSITIVE_INFINITY) <= proposedAt);
  if (before) {
    const at = toldAt.get(before.landingId)!;
    return { warning: { landingId: before.landingId, verdict: "warned", toldAt: at }, sentence: `You were told of ${before.landingId} at ${clock(at)}, ${gapText(proposedAt - at)} before you proposed.` };
  }
  const newest = moved[0]!;
  const warning: ReturnWarning = { landingId: newest.landingId, verdict: "unwarned" };
  const after = toldAt.get(newest.landingId);
  if (after !== undefined) return { warning, sentence: `You were told of ${newest.landingId} only at ${clock(after)}, after you proposed: you could not have known.` };
  if (told.lastReplyAt !== undefined && (!moment(newest.at) || newest.at > told.lastReplyAt)) {
    return { warning, sentence: `Landing ${newest.landingId} came after your last reply, so you could not have known.` };
  }
  return { warning, sentence: `No reply named landing ${newest.landingId} before you proposed, so you could not have known.` };
}

/**
 * Apply returnWarning to a change going back: its `warning`, and its reason ending with the sentence. Returns the metric
 * to count (HEADS_UP_WARNED or HEADS_UP_UNWARNED), or null when nothing applies.
 */
export function warnReturn(p: Proposal): string | null {
  const w = returnWarning(p);
  if (!w || typeof p.reason !== "string") return null;
  p.warning = w.warning;
  p.reason = `${p.reason.trimEnd()} ${w.sentence}`;
  return w.warning.verdict === "warned" ? HEADS_UP_WARNED : HEADS_UP_UNWARNED;
}
