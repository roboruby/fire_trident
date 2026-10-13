import type {
  Decision,
  Directive,
  DirectiveKind,
  EscalationKind,
  Id,
  InboxDirective,
  Intent,
  IntentEscalation,
  IntentField,
  IntentRevision,
  IntentStatus,
  LandingNotice,
  NoteDecision,
  Path,
  Proposal,
} from "@fire_trident/core";

/**
 * Changing direction: intent revisions, withdrawals, retracted rules, human directives, and agents'
 * status notes. Pure helpers (no Cloudflare APIs) shared by ColonyDO and the lanes. Chemotaxis: a
 * human changes the gradient (amends, withdraws, retracts, directs), needs evaporate or move, and
 * agents re-orient at their next step.
 */

/** Tables for revisions, directives and revision acknowledgements (created idempotently). */
export const DIRECTION_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS intent_revisions (
    intent_id TEXT NOT NULL, revision INTEGER NOT NULL, at INTEGER NOT NULL, by TEXT NOT NULL, reason TEXT NOT NULL,
    changed TEXT NOT NULL, before TEXT NOT NULL, after TEXT NOT NULL, substantive INTEGER NOT NULL, PRIMARY KEY (intent_id, revision))`,
  `CREATE TABLE IF NOT EXISTS directives (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, kind TEXT NOT NULL, intent_id TEXT, message TEXT NOT NULL, by TEXT NOT NULL,
    at INTEGER NOT NULL, revision INTEGER, changed TEXT, delivered_at INTEGER, via TEXT)`,
  "CREATE INDEX IF NOT EXISTS directives_by_agent ON directives(agent_id, at)",
  "CREATE INDEX IF NOT EXISTS directives_by_intent ON directives(intent_id, at)",
  // The revision an agent last saw of an intent it held when the intent was amended (see stampRevision).
  "CREATE TABLE IF NOT EXISTS intent_acks (intent_id TEXT NOT NULL, agent_id TEXT NOT NULL, revision INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (intent_id, agent_id))",
  // Which landing (and intent) changed each path, the newest few per path: why-context at take (agents/landed.ts).
  "CREATE TABLE IF NOT EXISTS landing_paths (path TEXT NOT NULL, at INTEGER NOT NULL, landing_id TEXT NOT NULL, intent_id TEXT, PRIMARY KEY (path, at, landing_id))",
  // Every report agents made on an intent, and the person's answer (the intent's history; intents.escalation holds the latest).
  `CREATE TABLE IF NOT EXISTS intent_escalations (
    intent_id TEXT NOT NULL, at INTEGER NOT NULL, agent_id TEXT NOT NULL, kind TEXT NOT NULL, report TEXT NOT NULL, resolved TEXT,
    PRIMARY KEY (intent_id, at, agent_id))`,
];

/** Columns added to tables that predate direction changes. */
export const DIRECTION_COLUMNS: ReadonlyArray<readonly [table: string, column: string, decl: string]> = [
  ["intents", "revision", "INTEGER NOT NULL DEFAULT 1"],
  ["intents", "withdrawn_reason", "TEXT"],
  ["rules", "retracted_at", "INTEGER"],
  ["rules", "retracted_by", "TEXT"],
  ["rules", "retract_reason", "TEXT"],
  ["agents", "note", "TEXT"],
  ["agents", "note_at", "INTEGER"],
  // An agent's report on the intent and the person's answer (IntentEscalation as JSON), and whether it still waits: take skips those.
  ["intents", "escalation", "TEXT"],
  ["intents", "escalation_open", "INTEGER NOT NULL DEFAULT 0"],
  // Landing notices: what landed (LandingNotice as JSON).
  ["directives", "landing", "TEXT"],
];

/** The SQL surface the migration needs. */
export interface SqlExec {
  exec(query: string, ...bindings: unknown[]): unknown;
}

/** A table's column names, or null when the store cannot list them (then ALTER decides). */
function tableColumns(sql: SqlExec, table: string): Set<string> | null {
  try {
    const rows = (sql.exec(`PRAGMA table_info(${table})`) as { toArray?: () => unknown[] } | null)?.toArray?.();
    if (!Array.isArray(rows)) return null;
    return new Set(rows.map((r) => (r && typeof r === "object" ? String((r as { name?: unknown }).name ?? "") : "")));
  } catch {
    return null;
  }
}

/** Create the direction tables and add the columns a table is missing (checked first; an ALTER that still fails is skipped). */
export function migrateDirection(sql: SqlExec): void {
  for (const stmt of DIRECTION_SCHEMA) sql.exec(stmt);
  const known = new Map<string, Set<string> | null>();
  for (const [table, column, decl] of DIRECTION_COLUMNS) {
    if (!known.has(table)) known.set(table, tableColumns(sql, table));
    if (known.get(table)?.has(column)) continue;
    try {
      sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
    } catch {
      // Already there.
    }
  }
}

/** Longest directive message and status note kept. */
export const MAX_DIRECTIVE_CHARS = 2_000;
export const MAX_NOTE_CHARS = 280;
/** Revisions a lane or a lineage note carries per intent at most (the latest ones). */
export const MAX_REVISIONS = 20;
/** Directives a lineage note carries per proposal at most (the latest ones). */
export const MAX_NOTE_DIRECTIVES = 8;
/** Decisions a lineage note carries per proposal at most (the latest ones), and characters per answer. */
export const MAX_NOTE_DECISIONS = 8;
const ANSWER_CHARS = 200;

/** Fields whose change redirects work in progress. */
const SUBSTANTIVE: ReadonlySet<IntentField> = new Set<IntentField>(["title", "why", "footprint"]);

/** The intent fields an amendment compares. */
export type IntentShape = Pick<Intent, IntentField>;

/** A validated amendment: only the fields it sets. */
export type IntentPatch = Partial<IntentShape>;

/** What an amendment changes, compared with the current intent. Footprints compare as sets. */
export function intentChanges(current: IntentShape, patch: IntentPatch): {
  changed: IntentField[];
  before: Partial<IntentShape>;
  after: Partial<IntentShape>;
  next: IntentShape;
  substantive: boolean;
} {
  const next: IntentShape = { title: current.title, why: current.why, footprint: [...current.footprint], priority: current.priority };
  const changed: IntentField[] = [];
  const before: Partial<IntentShape> = {};
  const after: Partial<IntentShape> = {};
  if (patch.title !== undefined && patch.title !== current.title) {
    changed.push("title");
    before.title = current.title;
    after.title = next.title = patch.title;
  }
  if (patch.why !== undefined && patch.why !== current.why) {
    changed.push("why");
    before.why = current.why;
    after.why = next.why = patch.why;
  }
  if (patch.footprint !== undefined && !sameSet(patch.footprint, current.footprint)) {
    changed.push("footprint");
    before.footprint = [...current.footprint];
    after.footprint = next.footprint = [...patch.footprint];
  }
  if (patch.priority !== undefined && patch.priority !== current.priority) {
    changed.push("priority");
    before.priority = current.priority;
    after.priority = next.priority = patch.priority;
  }
  return { changed, before, after, next, substantive: changed.some((f) => SUBSTANTIVE.has(f)) };
}

function sameSet(a: Path[], b: Path[]): boolean {
  const x = new Set(a);
  const y = new Set(b);
  if (x.size !== y.size) return false;
  for (const p of x) if (!y.has(p)) return false;
  return true;
}

/** Paths in `next` but not `prev`, and in `prev` but not `next`. */
export function footprintDelta(prev: Path[], next: Path[]): { added: Path[]; removed: Path[] } {
  const p = new Set(prev);
  const n = new Set(next);
  return { added: next.filter((x) => !p.has(x)), removed: prev.filter((x) => !n.has(x)) };
}

/** "why changed", "title and footprint changed (+src/b.ts, -src/a.ts)". */
export function describeChanges(changed: readonly IntentField[], before?: Partial<IntentShape>, after?: Partial<IntentShape>): string {
  if (changed.length === 0) return "nothing changed";
  const names = changed.length === 1 ? changed[0]! : `${changed.slice(0, -1).join(", ")} and ${changed[changed.length - 1]}`;
  let text = `${names} changed`;
  if (changed.includes("footprint") && before?.footprint && after?.footprint) {
    const { added, removed } = footprintDelta(before.footprint, after.footprint);
    const parts = [...added.slice(0, 3).map((x) => `+${x}`), ...removed.slice(0, 3).map((x) => `-${x}`)];
    const more = Math.max(0, added.length - 3) + Math.max(0, removed.length - 3);
    if (parts.length > 0) text += ` (${parts.join(", ")}${more > 0 ? `, ${more} more` : ""})`;
  }
  return text;
}

/** One line, collapsed whitespace, at most `max` characters. */
export function oneLine(s: string, max: number): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** A status note as stored: one line, at most MAX_NOTE_CHARS. */
export function cleanNote(note: string): string {
  return oneLine(note, MAX_NOTE_CHARS);
}

/** Reason of a proposal returned because its intent was withdrawn. */
export function withdrawnReturn(reason: string): string {
  return `withdrawn: ${oneLine(reason, 500) || "the intent was withdrawn"}`;
}

/** Reason of a proposal returned because its intent was revised after the revision it was built on. */
export function revisedReturn(from: number | null, to: number, changed: readonly IntentField[], reason: string): string {
  const span = from === null ? `r${to}` : `r${from} → r${to}`;
  return `intent revised: ${span}, ${describeChanges(changed)} (${oneLine(reason, 300)})`;
}

/** Reason of a proposal its own agent recalled to redo it (a directive changed its course). */
export function supersededReturn(reason: string): string {
  return `superseded: ${oneLine(reason, 500) || "recalled by its agent"}`;
}

/** Returns caused by a change of direction, not by stale reads or review: no failure mark, the holder keeps a revised intent. */
export const REDIRECT_RETURN = /^(withdrawn|intent revised|superseded): /;

/** Is this a return caused by a change of direction? */
export function isRedirect(reason: string | undefined): boolean {
  return typeof reason === "string" && REDIRECT_RETURN.test(reason);
}

/** The 409 a proposal built on an older substantive revision gets at propose time. */
export function staleRevisionError(intentId: Id, built: number, current: number, changed: readonly IntentField[], reason: string): string {
  return `intent revised: ${intentId} is at r${current} (${describeChanges(changed)}: ${oneLine(reason, 300)}); this change was built on r${built}. Take the intent again for r${current} and redo the change.`;
}

/** The 409 a proposal for a withdrawn intent gets at propose time. */
export function withdrawnError(intentId: Id, reason: string | null): string {
  return `intent withdrawn: ${intentId} (${oneLine(reason ?? "", 300) || "no reason given"}); stop work on it and take other work.`;
}

/** Union of the fields that changed across revisions, in a stable order. */
export function unionChanged(list: ReadonlyArray<{ changed: readonly IntentField[] }>): IntentField[] {
  const order: IntentField[] = ["title", "why", "footprint", "priority"];
  const seen = new Set<IntentField>();
  for (const r of list) for (const f of r.changed) seen.add(f);
  return order.filter((f) => seen.has(f));
}

/** What a lane needs to know about an intent before landing a change for it. */
export interface DirectionInfo {
  status?: IntentStatus;
  revision?: number;
  withdrawnReason?: string;
  /** Substantive amendments, oldest first. */
  revisions?: Array<{ revision: number; changed: IntentField[]; reason: string; at: number }>;
}

/**
 * Why a change must not land because its direction is stale, or null. A withdrawn intent's changes
 * never land. A change built on an older revision is stale when a substantive amendment came after
 * that revision; a change with no recorded revision is stale when such an amendment came after it
 * was proposed. Unknown intents (an older colony object) are not judged.
 */
export function staleDirection(p: Pick<Proposal, "intentRevision" | "createdAt">, info: DirectionInfo | undefined): string | null {
  if (!info) return null;
  if (info.status === "withdrawn") return withdrawnReturn(info.withdrawnReason ?? "");
  const current = typeof info.revision === "number" && info.revision >= 1 ? info.revision : 1;
  const later = (info.revisions ?? []).filter((r) => (typeof p.intentRevision === "number" ? r.revision > p.intentRevision : r.at > p.createdAt) && r.revision <= current);
  if (later.length === 0) return null;
  const last = later[later.length - 1]!;
  return revisedReturn(typeof p.intentRevision === "number" ? p.intentRevision : null, current, unionChanged(later), last.reason);
}

/**
 * The substantive amendments a change missed: revisions after the one it was built on (after it was
 * proposed, when it recorded none) up to the intent's current one, oldest first. Empty when the change
 * still fits its intent (none, or only priority moved).
 */
export function missedRevisions<R extends Pick<IntentRevision, "revision" | "substantive" | "at">>(p: Pick<Proposal, "intentRevision" | "createdAt">, current: number, revisions: readonly R[]): R[] {
  return revisions.filter((r) => r.substantive && r.revision <= current && (typeof p.intentRevision === "number" ? r.revision > p.intentRevision : r.at > p.createdAt));
}

/** A landed change that missed a substantive amendment of its intent, and what is left to do. */
export interface MissedRevision {
  intentId: Id;
  /** The agent whose change landed. */
  agentId: Id;
  /** The revision it was built on (null: not recorded). */
  built: number | null;
  current: number;
  /** The fields the missed amendments changed. */
  changed: IntentField[];
  /** "landed a change built on r1; r2 still to do" */
  text: string;
}

/** What is left when a change built on an older revision landed anyway: "landed a change built on r1; r2 still to do". */
export function landedStaleText(built: number | null, current: number): string {
  return `landed a change built on ${built === null ? "an older revision" : `r${built}`}; r${current} still to do`;
}

/** Split a lane batch: changes whose direction still holds, and the ones that go back with the reason. */
export function splitByDirection<P extends Pick<Proposal, "id" | "intentId" | "intentRevision" | "createdAt">>(
  batch: P[],
  intents: Record<Id, DirectionInfo> | undefined,
): { keep: P[]; returned: Array<{ p: P; reason: string }> } {
  const keep: P[] = [];
  const returned: Array<{ p: P; reason: string }> = [];
  for (const p of batch) {
    const reason = staleDirection(p, intents?.[p.intentId]);
    if (reason) returned.push({ p, reason });
    else keep.push(p);
  }
  return { keep, returned };
}

/** A stored revision row. */
export type RevisionRow = {
  intent_id: string;
  revision: number;
  at: number;
  by: string;
  reason: string;
  changed: string;
  before: string;
  after: string;
  substantive: number;
};

/** A stored directive row. */
export type DirectiveRow = {
  id: string;
  agent_id: string;
  kind: string;
  intent_id: string | null;
  message: string;
  by: string;
  at: number;
  revision: number | null;
  changed: string | null;
  delivered_at: number | null;
  via: string | null;
  /** Landing notices (absent in rows read before the column existed). */
  landing?: string | null;
};

function parse<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** A revision row as the API serves it. */
export function toRevision(r: RevisionRow): IntentRevision {
  return {
    intentId: r.intent_id,
    revision: r.revision,
    changed: parse<IntentField[]>(r.changed, []),
    before: parse<Partial<IntentShape>>(r.before, {}),
    after: parse<Partial<IntentShape>>(r.after, {}),
    reason: r.reason,
    by: r.by,
    at: r.at,
    substantive: r.substantive === 1,
  };
}

/** A directive row as the API serves it. */
export function toDirective(r: DirectiveRow, colonyId: Id): Directive {
  const d: Directive = { id: r.id, colonyId, agentId: r.agent_id, kind: (r.kind as DirectiveKind) ?? "guidance", message: r.message, by: r.by, at: r.at };
  if (r.intent_id) d.intentId = r.intent_id;
  if (typeof r.revision === "number") d.revision = r.revision;
  const changed = parse<IntentField[] | null>(r.changed, null);
  if (changed) d.changed = changed;
  if (typeof r.delivered_at === "number") d.deliveredAt = r.delivered_at;
  if (r.via === "push" || r.via === "inbox") d.via = r.via;
  const landing = parseLandingNotice(parse<unknown>(r.landing, null));
  if (landing) d.landing = landing;
  return d;
}

/** Characters of a landing notice's why, and paths one notice lists at most. */
export const NOTICE_WHY_CHARS = 300;
export const NOTICE_PATHS = 20;

const SHA_OR_NULL = (v: unknown): v is string | null => v === null || (typeof v === "string" && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(v));

/** A stored or received landing notice, checked (malformed paths dropped); null when it is not one. */
export function parseLandingNotice(x: unknown): LandingNotice | null {
  if (!x || typeof x !== "object" || Array.isArray(x)) return null;
  const o = x as Record<string, unknown>;
  if (typeof o.landingId !== "string" || !o.landingId || typeof o.trunkSha !== "string") return null;
  const paths = (Array.isArray(o.paths) ? o.paths : [])
    .filter((p): p is { path: string; before: string | null; after: string | null } => {
      const e = p as Record<string, unknown> | null;
      return !!e && typeof e === "object" && typeof e.path === "string" && e.path !== "" && SHA_OR_NULL(e.before) && SHA_OR_NULL(e.after);
    })
    .slice(0, NOTICE_PATHS)
    .map((p) => ({ path: p.path, before: p.before, after: p.after }));
  if (paths.length === 0) return null;
  return {
    landingId: o.landingId,
    trunkSha: o.trunkSha,
    paths,
    intentTitle: typeof o.intentTitle === "string" ? oneLine(o.intentTitle, 200) : "",
    why: typeof o.why === "string" ? oneLine(o.why, NOTICE_WHY_CHARS) : "",
  };
}

/** A blob id as a notice shows it: seven characters, or "absent". */
function blob7(sha: string | null): string {
  return sha ? sha.slice(0, 7) : "absent";
}

/**
 * A landing notice in words: which files changed on trunk, their blobs before and after, and the
 * intent that changed them. Facts only (the notice carries no instruction; what an agent does with
 * one is the platform's policy, given in its instructions).
 */
export function landingMessage(n: LandingNotice): string {
  const shown = n.paths.slice(0, 5).map((p) => `${p.path} (${blob7(p.before)} → ${blob7(p.after)})`);
  const more = n.paths.length > shown.length ? ` and ${n.paths.length - shown.length} more` : "";
  const intent = n.intentTitle ? `; it completed intent "${oneLine(n.intentTitle, 120)}"${n.why ? `: ${oneLine(n.why, 200)}` : ""}` : "";
  return `Landing ${n.landingId} (trunk ${n.trunkSha.slice(0, 7)}) changed ${shown.join(", ")}${more}${intent}.`;
}

// ---------------------------------------------------------------------------
// Escalations: an agent reports that an intent cannot be done as written; a person answers
// ---------------------------------------------------------------------------

/** What an agent can report, and the longest report and answer kept. */
export const ESCALATION_KINDS: readonly EscalationKind[] = ["broken-test", "contradictory-spec", "impossible", "other"];
export const MAX_REPORT_CHARS = 4_000;
export const MAX_ANSWER_CHARS = 2_000;
const DECISIONS: ReadonlySet<string> = new Set(["amend", "withdraw", "dismiss"]);

/** A person's answer to a report. */
export type EscalationDecision = NonNullable<IntentEscalation["resolved"]>["decision"];

/** The kind as given, when it is one an agent can report; null otherwise. */
export function escalationKind(x: unknown): EscalationKind | null {
  return typeof x === "string" && (ESCALATION_KINDS as readonly string[]).includes(x) ? (x as EscalationKind) : null;
}

/** The decision as given, when it is one a person can make; null otherwise. */
export function escalationDecision(x: unknown): EscalationDecision | null {
  return typeof x === "string" && DECISIONS.has(x) ? (x as EscalationDecision) : null;
}

/** Report or answer text as kept: trimmed, at most `max` characters (line breaks stay; it is shown as data). */
export function reportText(x: unknown, max = MAX_REPORT_CHARS): string {
  const t = typeof x === "string" ? x.replace(/\r\n?/g, "\n").trim() : "";
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** A stored escalation (intents.escalation, intent_escalations), checked; null when absent or unreadable. */
export function parseEscalation(text: string | null | undefined): IntentEscalation | null {
  const o = parse<Record<string, unknown> | null>(text, null);
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const kind = escalationKind(o.kind) ?? "other";
  if (typeof o.report !== "string" || typeof o.by !== "string" || typeof o.at !== "number") return null;
  const out: IntentEscalation = { kind, report: o.report, by: o.by, at: o.at };
  const r = o.resolved as Record<string, unknown> | undefined;
  const decision = r && typeof r === "object" ? escalationDecision(r.decision) : null;
  if (r && decision && typeof r.by === "string" && typeof r.at === "number") out.resolved = { by: r.by, at: r.at, decision, note: typeof r.note === "string" ? r.note : "" };
  return out;
}

/**
 * The guidance block a reviewer sees after an intent's why: human directives refine the intent, and
 * the agent was told to follow them, so following them is on-intent.
 */
export function guidanceText(list: ReadonlyArray<{ message: string; by: string }>): string {
  const lines = list.map((g) => `- ${oneLine(g.message, 500)} (from ${oneLine(g.by, 100)})`);
  return `Directives from a human operator about this intent (they refine it; the agent was told to follow them, and where they conflict with the text above they take precedence):\n${lines.join("\n")}`;
}

/** What an agent should read and do about a directive, in one paragraph. */
export function directiveText(d: Directive): string {
  switch (d.kind) {
    case "revision":
      return `Intent ${d.intentId ?? "?"} revised to r${d.revision ?? "?"} (${describeChanges(d.changed ?? [])}): ${d.message}. Call take to get the new revision and redo the change against it; changes built on an older revision are sent back.`;
    case "withdrawal":
      return `Intent ${d.intentId ?? "?"} withdrawn: ${d.message}. Stop working on it (nothing for it will land) and call take for other work.`;
    case "landing":
      // Facts about trunk, not instructions: the notice's text is the message the colony wrote from them.
      return `Trunk moved under intent ${d.intentId ?? "?"}: ${d.landing ? landingMessage(d.landing) : d.message}`;
    default:
      return `Directive from ${d.by}${d.intentId ? ` about intent ${d.intentId}` : ""}: ${d.message}`;
  }
}

/** A directive as an inbox entry (lines up with a proposal entry: id, intentId, status, reason, createdAt). */
export function inboxEntry(d: Directive): InboxDirective {
  return { kind: "directive", id: d.id, intentId: d.intentId ?? "", agentId: d.agentId, status: "directive", reason: directiveText(d), createdAt: d.at, headSha: "", directive: d };
}

/** Is this inbox entry a directive (not a proposal)? */
export function isInboxDirective(x: unknown): x is InboxDirective {
  return !!x && typeof x === "object" && (x as { kind?: unknown }).kind === "directive" && (x as { status?: unknown }).status === "directive";
}

/** A recorded decision row (the decisions table). */
export type DecisionRow = { id: string; kind: string; subject: string; layer: string; answers: string; p: number; action: string; at: number };

function text(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.filter((x) => typeof x === "string").join("; ");
  return "";
}

function prob(v: unknown): string {
  return typeof v === "number" && Number.isFinite(v) ? (Math.round(v * 100) / 100).toFixed(2) : "?";
}

/**
 * One decision as a lineage note keeps it: kind, layer, p and action, plus what was asked, who
 * answered and the answer in a line (the reflex's probabilities, the reviewer's or the human's reason).
 */
export function noteDecision(r: DecisionRow): NoteDecision {
  const a = parse<Record<string, unknown>>(r.answers, {});
  const d: NoteDecision = { kind: r.kind as Decision["kind"], layer: r.layer as Decision["layer"], p: Number.isFinite(r.p) ? Math.round(r.p * 1000) / 1000 : 0, action: r.action, at: r.at };
  if (r.layer === "reflex") {
    d.question = "reflex: needs_human, touches_sensitive, off_intent, risk, antibodies";
    if (typeof a.model === "string") d.by = a.model;
    const s = a.reflex as Record<string, unknown> | undefined;
    const answer = s
      ? `needs_human ${prob(s.needsHuman)}, touches_sensitive ${prob(s.sensitive)}, off_intent ${prob(s.offIntent)}, risk ${prob(s.risk)}`
      : typeof a.error === "string"
        ? `unavailable: ${a.error}`
        : "";
    const reasons = text(a.reasons);
    d.answer = oneLine([answer, reasons].filter(Boolean).join("; "), ANSWER_CHARS);
  } else if (r.layer === "llm") {
    d.question = "second opinion: approve, return or escalate";
    if (typeof a.model === "string") d.by = a.model;
    const v = a.verdict as Record<string, unknown> | undefined;
    const answer = v ? `${text(v.verdict)}: ${text(v.reason)}` : typeof a.error === "string" ? `unavailable: ${a.error}` : text(a.reasons);
    d.answer = oneLine(answer, ANSWER_CHARS);
  } else if (r.layer === "human") {
    d.question = "human review";
    if (typeof a.by === "string") d.by = a.by;
    d.answer = oneLine(`${text(a.decision) || r.action}${text(a.reason) ? `: ${text(a.reason)}` : ""}`, ANSWER_CHARS);
  }
  if (!d.answer) delete d.answer;
  return d;
}

/** The latest decisions per proposal (oldest first within each), at most MAX_NOTE_DECISIONS each. */
export function noteDecisions(rows: DecisionRow[]): Record<Id, NoteDecision[]> {
  const out: Record<Id, NoteDecision[]> = {};
  for (const r of [...rows].sort((x, y) => x.at - y.at)) (out[r.subject] ??= []).push(noteDecision(r));
  for (const k of Object.keys(out)) out[k] = out[k]!.slice(-MAX_NOTE_DECISIONS);
  return out;
}
