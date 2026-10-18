import type { EscalationKind, Id, StuckItem, StuckKind, StuckReport, StuckRepairState } from "@fire_trident/core";
import { isRedirect, parseEscalation } from "./direction.ts";
import { STOP_GRACE_MS } from "./metrics.ts";

/**
 * The stuck-work detector: deterministic checks on the colony's own tables for work that stopped
 * moving, so a person hears about it without watching every agent. It only reports, and it is on for
 * every colony. ColonyDO serves its findings with the snapshot and the metrics report (computed on
 * demand from indexed queries) and, on its periodic tick, publishes one `stuck` event per item it has
 * not published before. The ledger (table `stuck_reported`) remembers what was published: an item is
 * published once, one that clears publishes nothing and leaves the ledger, and one that comes back
 * later is a new episode with a new key, published again.
 */

/** An intent claimed this long with no change proposed is stuck. */
export const CLAIMED_MS = 10 * 60_000;
/** An intent whose changes came back this many times since it last changed course (a landing, a substantive amendment) is stuck. */
export const RETURNS_MIN = 3;
/** A trunk whose certification has been red this long is stuck. */
export const RED_MS = 15 * 60_000;
/** An agent's report, or a change, waiting this long for a person is stuck. */
export const WAITING_MS = 10 * 60_000;
/** An agent alive and holding work with no step forward this long (no claim, change, outcome or status note) is stuck. */
export const STALLED_MS = 10 * 60_000;
/** Rows each check reads at most. A check that fills its cap may have found more, so the ledger keeps its earlier items. */
export const CHECK_CAP = 50;
/** Items a report lists at most (`total` counts them all). */
export const LIST_MAX = 50;
/** The periodic tick looks for stuck work at most this often. */
export const SWEEP_MS = 30_000;
/** Proposals of one intent the returns check reads at most, newest first. */
const RETURNS_LOOKBACK = 20;
/** Reported keys the ledger keeps at most (the oldest go first). */
const LEDGER_KEEP = 5_000;
/** Reasons a returns item carries, and how much of each quoted text an item keeps. */
const REASONS = 3;
const REASON_CHARS = 200;
const TITLE_CHARS = 100;
const NOTE_CHARS = 160;

/** The kinds in the order a person should look at them. */
export const STUCK_ORDER: readonly StuckKind[] = ["red", "report", "review", "claimed", "returns", "agent"];

const LEDGER_SCHEMA = "CREATE TABLE IF NOT EXISTS stuck_reported (key TEXT PRIMARY KEY, kind TEXT NOT NULL, at INTEGER NOT NULL)";
/** The returns check counts an intent's proposals through this index (take's lastReturn makes the same one). */
const RETURNS_INDEX = "proposals_by_intent";

/** How an agent's report is named in a sentence. */
const REPORTED: Readonly<Record<EscalationKind, string>> = {
  "broken-test": "a broken test",
  "contradictory-spec": "a contradictory spec",
  impossible: "an impossible ask",
  other: "a problem",
  chain: "a chain of agent-declared intents to check",
};

/** Untrusted text as one line: control and invisible characters and runs of whitespace become one space, cut to `max`. */
export function clip(s: string | null | undefined, max: number): string {
  const t = (s ?? "").replace(/[\s\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** A title in quotes, or the fallback when there is none. */
function quoted(title: string | null | undefined, fallback: string): string {
  const t = clip(title, TITLE_CHARS);
  return t ? `“${t}”` : fallback;
}

/** What an agent's own note adds to a sentence. */
function says(note: string | null | undefined, verb = "says"): string {
  const n = clip(note, NOTE_CHARS);
  return n ? `; it ${verb} “${n}”` : "; it has not said what it is doing";
}

// ---------------------------------------------------------------------------
// The checks, as pure functions of the rows ColonyDO's tables give
// ---------------------------------------------------------------------------

/** An intent claimed with no change in flight, with its holder. */
export interface ClaimedRow {
  id: Id;
  title: string;
  /** When it was claimed (or its course last changed). */
  since: number;
  agentId: Id | null;
  agentName: string | null;
  /** The holder's last status note, and when it said it. */
  note: string | null;
  noteAt: number | null;
}

/**
 * An intent claimed for CLAIMED_MS or longer with no change proposed: look at its agent. The agent's
 * note is quoted only when it was said after the claim (an older one is about earlier work).
 */
export function claimedItem(r: ClaimedRow, now: number): StuckItem | null {
  if (now - r.since < CLAIMED_MS) return null;
  const who = clip(r.agentName, 80) || r.agentId || "an agent";
  const note = (r.noteAt ?? 0) >= r.since ? clip(r.note, NOTE_CHARS) : "";
  const item: StuckItem = {
    key: `claimed:${r.id}:${r.agentId ?? ""}:${r.since}`,
    kind: "claimed",
    since: r.since,
    text: `${quoted(r.title, `intent ${r.id}`)} is claimed by ${who} with no change proposed yet${says(note)}`,
    action: "agent",
    intentId: r.id,
    title: clip(r.title, TITLE_CHARS),
  };
  if (r.agentId) item.agentId = r.agentId;
  if (note) item.note = note;
  return item;
}

/** One proposal of an intent that came back or landed, as the returns check reads it. */
export interface ReturnedProposal {
  status: string;
  createdAt: number;
  updatedAt: number;
  reason: string | null;
  supersededBy: string | null;
}

/** An intent still in play, with its newest proposals that came back or landed (newest first). */
export interface ReturnsRow {
  id: Id;
  title: string;
  revision: number;
  /** Its latest substantive amendment, if any: returns before it were for an older course. */
  revisedAt: number | null;
  proposals: ReturnedProposal[];
}

/**
 * The changes of an intent that came back since it last changed course, newest first: the returns and
 * rejections before a landing or a substantive amendment, leaving out returns that only changed
 * direction (withdrawn, revised, recalled) and lost contests. The returns check counts them, and so
 * does the model step-up (colony/stepup.ts).
 */
export function returnsSinceCourse(r: Pick<ReturnsRow, "revisedAt" | "proposals">): ReturnedProposal[] {
  const counted: ReturnedProposal[] = [];
  for (const p of r.proposals) {
    if (p.status === "landed") break;
    if (r.revisedAt !== null && p.createdAt <= r.revisedAt) break;
    if (p.status !== "returned" && p.status !== "rejected") continue;
    if (p.supersededBy || isRedirect(p.reason ?? undefined)) continue;
    counted.push(p);
  }
  return counted;
}

/**
 * An intent whose changes came back RETURNS_MIN times or more since it last changed course
 * (returnsSinceCourse). Amending or withdrawing it may help more than another attempt.
 */
export function returnsItem(r: ReturnsRow): StuckItem | null {
  const counted = returnsSinceCourse(r);
  if (counted.length < RETURNS_MIN) return null;
  const reasons = counted
    .slice(0, REASONS)
    .map((p) => clip(p.reason, REASON_CHARS))
    .filter((s) => s !== "");
  // Stuck since the return that reached the threshold (counted is newest first).
  const since = counted[counted.length - RETURNS_MIN]?.updatedAt ?? counted[0]?.updatedAt ?? 0;
  const item: StuckItem = {
    key: `returns:${r.id}:${r.revision}`,
    kind: "returns",
    since,
    text: `Changes for ${quoted(r.title, `intent ${r.id}`)} came back ${counted.length} times${reasons[0] ? `; the latest: ${reasons[0]}` : ""}`,
    action: "intent",
    intentId: r.id,
    title: clip(r.title, TITLE_CHARS),
    returns: counted.length,
  };
  if (reasons.length > 0) item.reasons = reasons;
  return item;
}

/** A red trunk's open repair intent, as the red check reads it. */
export interface RepairRow {
  id: Id;
  title: string;
  status: string;
  /** An agent's report on it waits for a person. */
  reported: boolean;
  agentId: Id | null;
  agentName: string | null;
  /** Its newest change in flight. */
  proposal: { id: Id; status: string } | null;
}

/** The newest certification result, the first red one since the last green one, and the open repair intent. */
export interface RedRow {
  latest: { trunkSha: string; status: string; failing: number } | null;
  first: { trunkSha: string; at: number } | null;
  repair: RepairRow | null;
}

/** Where a repair stands. */
export function repairState(r: RepairRow): StuckRepairState {
  if (r.reported) return "reported";
  if (r.proposal?.status === "escalated") return "review";
  if (r.status === "proposed") return "proposed";
  if (r.status === "claimed") return "working";
  return "open";
}

/**
 * Trunk certification red for RED_MS or longer (the newest result is red, and so is every one since the
 * first red after the last green one), with where its repair stands: answer the report on it, review its
 * change, look at the agent working on it, or look at the tests.
 */
export function redItem(r: RedRow, now: number): StuckItem | null {
  if (!r.latest || r.latest.status !== "red" || !r.first || now - r.first.at < RED_MS) return null;
  const sha = r.first.trunkSha.slice(0, 7);
  const failing = r.latest.failing > 0 ? ` (${r.latest.failing} failing)` : "";
  const item: StuckItem = { key: `red:${r.first.trunkSha}`, kind: "red", since: r.first.at, text: "", action: "tests", trunkSha: r.first.trunkSha };
  const rep = r.repair;
  let repair = "no repair intent is open";
  if (rep) {
    const state = repairState(rep);
    const title = quoted(rep.title, rep.id);
    item.repair = state;
    item.intentId = rep.id;
    item.title = clip(rep.title, TITLE_CHARS);
    if (rep.proposal) item.proposalId = rep.proposal.id;
    if (state === "reported") {
      repair = `an agent reported that repair ${title} cannot be done as written, and a person must answer`;
      item.action = "answer";
    } else if (state === "review") {
      repair = `the change for repair ${title} waits for a person's review`;
      item.action = "review";
    } else if (state === "proposed") {
      repair = `the change for repair ${title} is being checked or waits for its lane`;
    } else if (state === "working") {
      repair = `${clip(rep.agentName, 80) || rep.agentId || "an agent"} is working on repair ${title}`;
      if (rep.agentId) {
        item.agentId = rep.agentId;
        item.action = "agent";
      }
    } else {
      repair = `repair ${title} waits for an agent to take it`;
    }
  }
  item.text = `Trunk tests have been red since ${sha}${failing}; ${repair}`;
  return item;
}

/** An open report on an intent (the intent's stored escalation), with its reporter's name. */
export interface ReportRow {
  id: Id;
  title: string;
  escalation: string | null;
  updatedAt: number;
  agentName: string | null;
}

/** An agent's report that has waited WAITING_MS or longer for a person: answer it. */
export function reportItem(r: ReportRow, now: number): StuckItem | null {
  const e = parseEscalation(r.escalation);
  if (e?.resolved) return null;
  const since = e?.at ?? r.updatedAt;
  if (now - since < WAITING_MS) return null;
  const who = clip(r.agentName, 80) || e?.by || "An agent";
  const item: StuckItem = {
    key: `report:${r.id}:${since}`,
    kind: "report",
    since,
    text: `${who} reported ${REPORTED[e?.kind ?? "other"]} on ${quoted(r.title, `intent ${r.id}`)}; it waits for a person's answer`,
    action: "answer",
    intentId: r.id,
    title: clip(r.title, TITLE_CHARS),
  };
  if (e?.by) item.agentId = e.by;
  return item;
}

/** A change in the review queue. */
export interface ReviewRow {
  id: Id;
  intentId: Id;
  agentId: Id;
  /** When it was escalated (its last change of state). */
  since: number;
  title: string | null;
  agentName: string | null;
}

/** A change that has waited WAITING_MS or longer for a person's review: review it. */
export function reviewItem(r: ReviewRow, now: number): StuckItem | null {
  if (now - r.since < WAITING_MS) return null;
  const who = clip(r.agentName, 80) || r.agentId;
  return {
    key: `review:${r.id}`,
    kind: "review",
    since: r.since,
    text: `A change for ${quoted(r.title, `intent ${r.intentId}`)} by ${who} waits for a person's review`,
    action: "review",
    intentId: r.intentId,
    ...(r.title ? { title: clip(r.title, TITLE_CHARS) } : {}),
    agentId: r.agentId,
    proposalId: r.id,
  };
}

/** An agent alive and holding work, with the newest signs that its work moves. */
export interface StalledRow {
  id: Id;
  name: string;
  intentId: Id | null;
  title: string | null;
  note: string | null;
  noteAt: number | null;
  createdAt: number;
  /** The intent it holds last changed (claimed, proposed, amended). */
  claimAt: number | null;
  /** Its newest proposal. */
  proposal: { id: Id; status: string; createdAt: number; updatedAt: number } | null;
}

/**
 * An agent alive and holding work whose work has not moved for STALLED_MS: no claim, change, outcome
 * or status note since. Agents another item already names (`covered`: the holders of claimed intents)
 * and agents whose change waits for a person (the review check reports it) are left out.
 */
export function stalledItem(r: StalledRow, now: number, covered: ReadonlySet<Id>): StuckItem | null {
  if (covered.has(r.id)) return null;
  const p = r.proposal;
  if (p?.status === "escalated") return null;
  const since = Math.max(r.createdAt, r.noteAt ?? 0, r.claimAt ?? 0, p ? Math.max(p.createdAt, p.updatedAt) : 0);
  if (now - since < STALLED_MS) return null;
  const inFlight = p && (p.status === "pending" || p.status === "checking" || p.status === "ready") ? p : null;
  const change = inFlight ? `: its change ${inFlight.id} ${inFlight.status === "ready" ? "still waits for its lane" : "is still being checked"}` : "";
  const item: StuckItem = {
    key: `agent:${r.id}:${since}`,
    kind: "agent",
    since,
    text: `${clip(r.name, 80) || r.id} is alive but its work on ${quoted(r.title, r.intentId ? `intent ${r.intentId}` : "its intent")} has not moved${change}${says(r.note, "last said")}`,
    action: "agent",
    agentId: r.id,
  };
  if (r.intentId) item.intentId = r.intentId;
  if (r.title) item.title = clip(r.title, TITLE_CHARS);
  if (inFlight) item.proposalId = inFlight.id;
  const note = clip(r.note, NOTE_CHARS);
  if (note) item.note = note;
  return item;
}

/** Items in the order a person should look at them: by kind (STUCK_ORDER), then oldest first. */
export function sortStuck(items: readonly StuckItem[]): StuckItem[] {
  const rank = (k: StuckKind): number => {
    const i = STUCK_ORDER.indexOf(k);
    return i < 0 ? STUCK_ORDER.length : i;
  };
  return [...items].sort((a, b) => rank(a.kind) - rank(b.kind) || a.since - b.since || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** The report the snapshot and the metrics report carry: sorted, cut to LIST_MAX, with the total. */
export function toReport(items: readonly StuckItem[], now: number): StuckReport {
  const sorted = sortStuck(items);
  return { at: now, items: sorted.slice(0, LIST_MAX), total: sorted.length };
}

/**
 * What the periodic tick publishes, and what leaves the ledger: items whose key was never published,
 * and published keys no longer found. A key whose check was cut short (it filled its cap, or failed) is
 * not cleared, since its item may simply not have been read; a key of a kind this version does not know
 * is cleared.
 */
export function ledgerDiff(
  items: readonly StuckItem[],
  reported: ReadonlyArray<{ key: string; kind: string }>,
  complete: ReadonlySet<StuckKind>,
): { publish: StuckItem[]; clear: string[] } {
  const known = new Set(reported.map((r) => r.key));
  const current = new Set<string>();
  const publish: StuckItem[] = [];
  for (const item of sortStuck(items)) {
    if (current.has(item.key)) continue;
    current.add(item.key);
    if (!known.has(item.key)) publish.push(item);
  }
  const clear = reported
    .filter((r) => !current.has(r.key) && (complete.has(r.kind as StuckKind) || !(STUCK_ORDER as readonly string[]).includes(r.kind)))
    .map((r) => r.key);
  return { publish, clear };
}

// ---------------------------------------------------------------------------
// Reading the colony's tables
// ---------------------------------------------------------------------------

/** What every check found, and the kinds whose check read all of its rows. */
export interface StuckFindings {
  items: StuckItem[];
  complete: Set<StuckKind>;
}

/**
 * Runs the checks on a colony's SQLite tables. Every query is indexed (intents by status and update
 * time, proposals by status, by intent and by agent, agents by state and last-seen time) and capped
 * at CHECK_CAP rows. A check that fails is logged and skipped; the others still report.
 */
export class StuckDetector {
  /**
   * `aliveMs`: how long an agent counts as alive after it was last seen (the colony's reaper declares
   * an agent dead after that long). `moreRed`: further items of the red check (the red brake's, colony/redbrake.ts).
   */
  constructor(
    private readonly sql: SqlStorage,
    private readonly aliveMs: number,
    private readonly moreRed?: (now: number) => StuckItem[],
  ) {}

  /** Everything stuck at `now`. */
  find(now: number): StuckFindings {
    const items: StuckItem[] = [];
    const complete = new Set<StuckKind>();
    const run = (kind: StuckKind, check: () => { items: StuckItem[]; complete: boolean }): void => {
      try {
        const found = check();
        items.push(...found.items);
        if (found.complete) complete.add(kind);
      } catch (err) {
        console.warn(`stuck check ${kind} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    let holders = new Set<Id>();
    run("claimed", () => {
      const rows = this.claimedRows(now);
      const found = rows.map((r) => claimedItem(r, now)).filter((x): x is StuckItem => x !== null);
      holders = new Set(found.flatMap((i) => (i.agentId ? [i.agentId] : [])));
      return { items: found, complete: rows.length < CHECK_CAP };
    });
    run("returns", () => {
      const rows = this.returnsRows();
      return { items: rows.items.map(returnsItem).filter((x): x is StuckItem => x !== null), complete: rows.complete };
    });
    run("red", () => {
      const item = redItem(this.redRow(), now);
      // The red brake's stops (colony/redbrake.ts); its failure leaves the red check's own item standing.
      let more: StuckItem[] = [];
      try {
        more = this.moreRed?.(now) ?? [];
      } catch (err) {
        console.warn(`stuck check red (red brake) failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return { items: item ? [item, ...more] : more, complete: true };
    });
    run("report", () => {
      const rows = this.reportRows();
      return { items: rows.map((r) => reportItem(r, now)).filter((x): x is StuckItem => x !== null), complete: rows.length < CHECK_CAP };
    });
    run("review", () => {
      const rows = this.reviewRows(now);
      return { items: rows.map((r) => reviewItem(r, now)).filter((x): x is StuckItem => x !== null), complete: rows.length < CHECK_CAP };
    });
    run("agent", () => {
      const rows = this.stalledRows(now);
      return { items: rows.map((r) => stalledItem(r, now, holders)).filter((x): x is StuckItem => x !== null), complete: rows.length < CHECK_CAP };
    });
    return { items, complete };
  }

  /** The report the snapshot and the metrics report carry. */
  report(now: number): StuckReport {
    return toReport(this.find(now).items, now);
  }

  /**
   * The periodic tick's look: the items not published before, recorded in the ledger as published,
   * while keys no longer found leave it (so an item that comes back later is published again).
   */
  sweep(now: number): StuckItem[] {
    const found = this.find(now);
    this.sql.exec(LEDGER_SCHEMA);
    const reported = this.sql.exec<{ key: string; kind: string }>("SELECT key, kind FROM stuck_reported").toArray();
    const { publish, clear } = ledgerDiff(found.items, reported, found.complete);
    if (clear.length > 0) this.sql.exec("DELETE FROM stuck_reported WHERE key IN (SELECT value FROM json_each(?))", JSON.stringify(clear));
    if (publish.length > 0) {
      this.sql.exec(
        "INSERT OR IGNORE INTO stuck_reported (key, kind, at) SELECT json_extract(value, '$.key'), json_extract(value, '$.kind'), ? FROM json_each(?)",
        now,
        JSON.stringify(publish.map((i) => ({ key: i.key, kind: i.kind }))),
      );
      this.sql.exec("DELETE FROM stuck_reported WHERE key IN (SELECT key FROM stuck_reported ORDER BY at DESC, key LIMIT -1 OFFSET ?)", LEDGER_KEEP);
    }
    return publish;
  }

  /** Intents claimed CLAIMED_MS ago or more, oldest claim first (index intents_by_update). Vaccine intents are left out. */
  private claimedRows(now: number): ClaimedRow[] {
    return this.sql
      .exec<{ id: string; title: string; since: number; agent_id: string | null; agent_name: string | null; note: string | null; note_at: number | null }>(
        `SELECT i.id AS id, i.title AS title, i.updated_at AS since, i.assigned_to AS agent_id, a.name AS agent_name, a.note AS note, a.note_at AS note_at
           FROM intents i LEFT JOIN agents a ON a.id = i.assigned_to
          WHERE i.status = 'claimed' AND i.updated_at <= ? AND i.created_by != 'vaccine'
          ORDER BY i.updated_at LIMIT ?`,
        now - CLAIMED_MS,
        CHECK_CAP,
      )
      .toArray()
      .map((r) => ({ id: r.id, title: r.title, since: r.since, agentId: r.agent_id, agentName: r.agent_name, note: r.note, noteAt: r.note_at }));
  }

  /**
   * Intents in play with RETURNS_MIN or more proposals that came back (counted through proposals_by_intent,
   * made here when missing), with their newest proposals and latest substantive amendment.
   */
  private returnsRows(): { items: ReturnsRow[]; complete: boolean } {
    if (this.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?", RETURNS_INDEX).toArray().length === 0) {
      this.sql.exec(`CREATE INDEX IF NOT EXISTS ${RETURNS_INDEX} ON proposals(intent_id, created_at)`);
    }
    const candidates = this.sql
      .exec<{ id: string; title: string; revision: number | null }>(
        `SELECT id, title, revision FROM (
           SELECT i.id AS id, i.title AS title, i.revision AS revision,
                  (SELECT COUNT(*) FROM proposals p WHERE p.intent_id = i.id AND p.status IN ('returned', 'rejected')) AS n
             FROM intents i WHERE i.status IN ('open', 'claimed', 'proposed') AND i.created_by != 'vaccine')
          WHERE n >= ? ORDER BY n DESC, id LIMIT ?`,
        RETURNS_MIN,
        CHECK_CAP,
      )
      .toArray();
    const items = candidates.map((c): ReturnsRow => {
      const proposals = this.sql
        .exec<{ status: string; created_at: number; updated_at: number; reason: string | number | null; superseded_by: string | number | null }>(
          `SELECT status, created_at, updated_at, json_extract(data, '$.reason') AS reason, json_extract(data, '$.supersededBy') AS superseded_by
             FROM proposals WHERE intent_id = ? AND status IN ('returned', 'rejected', 'landed') ORDER BY created_at DESC LIMIT ?`,
          c.id,
          RETURNS_LOOKBACK,
        )
        .toArray()
        .map((p) => ({
          status: p.status,
          createdAt: p.created_at,
          updatedAt: p.updated_at,
          reason: typeof p.reason === "string" ? p.reason : null,
          supersededBy: typeof p.superseded_by === "string" && p.superseded_by !== "" ? p.superseded_by : null,
        }));
      const revisedAt = this.sql.exec<{ at: number | null }>("SELECT MAX(at) AS at FROM intent_revisions WHERE intent_id = ? AND substantive = 1", c.id).one().at;
      return { id: c.id, title: c.title, revision: typeof c.revision === "number" ? c.revision : 1, revisedAt: typeof revisedAt === "number" ? revisedAt : null, proposals };
    });
    return { items, complete: candidates.length < CHECK_CAP };
  }

  /** The newest certification result; when it is red, the first red result since the last green one and the open repair intent. */
  private redRow(): RedRow {
    const latest = this.sql
      .exec<{ trunk_sha: string; status: string; fail: number | null; cancelled: number | null; listed: number | null }>(
        `SELECT trunk_sha, status, json_extract(data, '$.counts.fail') AS fail, json_extract(data, '$.counts.cancelled') AS cancelled,
                json_array_length(data, '$.failing') AS listed
           FROM certifications WHERE status != 'running' ORDER BY started_at DESC, rowid DESC LIMIT 1`,
      )
      .toArray()[0];
    if (!latest || latest.status !== "red") return { latest: latest ? { trunkSha: latest.trunk_sha, status: latest.status, failing: 0 } : null, first: null, repair: null };
    const counted = (typeof latest.fail === "number" ? latest.fail : 0) + (typeof latest.cancelled === "number" ? latest.cancelled : 0);
    const failing = typeof latest.fail === "number" ? counted : typeof latest.listed === "number" ? latest.listed : 0;
    const first = this.sql
      .exec<{ trunk_sha: string; at: number }>(
        `SELECT trunk_sha, COALESCE(finished_at, started_at) AS at FROM certifications
          WHERE status = 'red' AND started_at > COALESCE((SELECT MAX(started_at) FROM certifications WHERE status = 'green'), -1)
          ORDER BY started_at, rowid LIMIT 1`,
      )
      .toArray()[0];
    const r = this.sql
      .exec<{ id: string; title: string; status: string; reported: number | null; agent_id: string | null; agent_name: string | null }>(
        `SELECT i.id AS id, i.title AS title, i.status AS status, i.escalation_open AS reported, i.assigned_to AS agent_id, a.name AS agent_name
           FROM intents i LEFT JOIN agents a ON a.id = i.assigned_to
          WHERE i.status IN ('open', 'claimed', 'proposed') AND i.source = 'certify'
          ORDER BY i.created_at DESC LIMIT 1`,
      )
      .toArray()[0];
    let repair: RepairRow | null = null;
    if (r) {
      const p = this.sql
        .exec<{ id: string; status: string }>(
          "SELECT id, status FROM proposals WHERE intent_id = ? AND status IN ('pending', 'checking', 'ready', 'escalated') ORDER BY created_at DESC LIMIT 1",
          r.id,
        )
        .toArray()[0];
      repair = { id: r.id, title: r.title, status: r.status, reported: r.reported === 1, agentId: r.agent_id, agentName: r.agent_name, proposal: p ? { id: p.id, status: p.status } : null };
    }
    return { latest: { trunkSha: latest.trunk_sha, status: latest.status, failing }, first: first ? { trunkSha: first.trunk_sha, at: first.at } : null, repair };
  }

  /** Open reports, oldest first, with their reporters' names. */
  private reportRows(): ReportRow[] {
    const rows = this.sql
      .exec<{ id: string; title: string; escalation: string | null; updated_at: number }>(
        "SELECT id, title, escalation, updated_at FROM intents WHERE status = 'open' AND escalation_open = 1 ORDER BY updated_at LIMIT ?",
        CHECK_CAP,
      )
      .toArray();
    const by = new Map<string, string>();
    for (const r of rows) {
      const e = parseEscalation(r.escalation);
      if (e?.by) by.set(r.id, e.by);
    }
    const names = new Map<string, string>();
    if (by.size > 0) {
      for (const a of this.sql.exec<{ id: string; name: string }>("SELECT id, name FROM agents WHERE id IN (SELECT value FROM json_each(?))", JSON.stringify([...new Set(by.values())]))) {
        names.set(a.id, a.name);
      }
    }
    return rows.map((r) => ({ id: r.id, title: r.title, escalation: r.escalation, updatedAt: r.updated_at, agentName: names.get(by.get(r.id) ?? "") ?? null }));
  }

  /** Changes escalated WAITING_MS ago or more, oldest first (index proposals_by_status). Vaccines are left out. */
  private reviewRows(now: number): ReviewRow[] {
    return this.sql
      .exec<{ id: string; intent_id: string; agent_id: string; since: number; title: string | null; agent_name: string | null }>(
        `SELECT p.id AS id, p.intent_id AS intent_id, p.agent_id AS agent_id, p.updated_at AS since, i.title AS title, a.name AS agent_name
           FROM proposals p LEFT JOIN intents i ON i.id = p.intent_id LEFT JOIN agents a ON a.id = p.agent_id
          WHERE p.status = 'escalated' AND p.updated_at <= ? AND COALESCE(i.created_by, '') != 'vaccine'
          ORDER BY p.created_at LIMIT ?`,
        now - WAITING_MS,
        CHECK_CAP,
      )
      .toArray()
      .map((r) => ({ id: r.id, intentId: r.intent_id, agentId: r.agent_id, since: r.since, title: r.title, agentName: r.agent_name }));
  }

  /**
   * Agents alive (seen within aliveMs, not stopped since) and holding work (working or proposing) whose
   * registration, status note, intent and newest proposal are all STALLED_MS old or more (indexes
   * agents_by_seen and proposals_by_agent), with that proposal. The vaccine agent is left out.
   */
  private stalledRows(now: number): StalledRow[] {
    const cutoff = now - STALLED_MS;
    const rows = this.sql
      .exec<{ id: string; name: string; intent_id: string | null; note: string | null; note_at: number | null; created_at: number; title: string | null; claim_at: number | null }>(
        `SELECT a.id AS id, a.name AS name, a.intent_id AS intent_id, a.note AS note, a.note_at AS note_at, a.created_at AS created_at,
                i.title AS title, i.updated_at AS claim_at
           FROM agents a LEFT JOIN agent_stops s ON s.agent_id = a.id LEFT JOIN intents i ON i.id = a.intent_id
          WHERE a.state IN ('working', 'proposing') AND a.last_seen > ?
            AND NOT (s.at IS NOT NULL AND s.at + ? >= a.last_seen)
            AND COALESCE(a.model, '') != 'vaccine' AND COALESCE(a.note_at, 0) <= ? AND a.created_at <= ? AND COALESCE(i.updated_at, 0) <= ?
            AND COALESCE((SELECT MAX(p.created_at) FROM proposals p WHERE p.agent_id = a.id), 0) <= ?
          ORDER BY a.created_at LIMIT ?`,
        now - this.aliveMs,
        STOP_GRACE_MS,
        cutoff,
        cutoff,
        cutoff,
        cutoff,
        CHECK_CAP,
      )
      .toArray();
    return rows.map((r) => {
      const p = this.sql
        .exec<{ id: string; status: string; created_at: number; updated_at: number }>(
          "SELECT id, status, created_at, updated_at FROM proposals WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1",
          r.id,
        )
        .toArray()[0];
      return {
        id: r.id,
        name: r.name,
        intentId: r.intent_id,
        title: r.title,
        note: r.note,
        noteAt: r.note_at,
        createdAt: r.created_at,
        claimAt: r.claim_at,
        proposal: p ? { id: p.id, status: p.status, createdAt: p.created_at, updatedAt: p.updated_at } : null,
      };
    });
  }
}

