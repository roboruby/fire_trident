import { GUIDE_LIMITS, cleanLesson, duplicateOf, guideEntry, lessonKey, lessonVerdict, overBudget, revalidationEnabled, takeLessons } from "@fire_trident/core";
import { newId } from "../ids.ts";
import type { AgentKind, Certification, ColonyEvent, Evidence, GuideCertification, GuideEntry, GuideLesson, GuideTake, Id, Landing, LessonGate, LessonProvenance, LessonReceipt, LessonStatus, Proposal } from "@fire_trident/core";
import { MASKED, maskSecrets } from "../trunk/mask.ts";
import { noteProvenance } from "../trunk/provenance.ts";
import { errorText, ftError } from "./errors.ts";
import type { SqlRunner } from "./inline.ts";
import { landedScope, lessonScope, scopedEntries } from "./lessonscope.ts";

/**
 * A colony's field guide (FT_FIELD_GUIDE; the rules are core/guide.ts). An agent may leave one lesson with a proposal:
 * one surprising fact about this codebase that would have shortened its work. The lesson is cleaned, masked like a
 * lineage note's free text (trunk/mask.ts), and kept as a candidate with the proposal's provenance (trunk/provenance.ts,
 * the same record the lineage note is written from). It joins the guide when its change has landed and the first green
 * certification of trunk at or after that landing comes in, or when a person approves it; it is dropped when its
 * landing is reverted, when a red certification names its change, when a person rejects it, or when its change comes
 * back. Every take carries the newest active lessons (GUIDE_LIMITS.takeChars), and the guide keeps at most
 * GUIDE_LIMITS.activeLessons lessons and GUIDE_LIMITS.activeChars characters: past either, the oldest retires.
 * Each lesson keeps the files its change read and wrote, with their blobs (its scope, colony/lessonscope.ts); where
 * FT_LESSON_SCOPE covers the colony too, a take ranks the lessons on its intent's footprint first, marks the files that
 * changed since a lesson was written, and leaves out a lesson whose every file changed.
 *
 * Its own table is `guide_lessons`, made on first use (so a colony with the guide off has none). It also reads, never
 * writes, the colony's `proposals` (id, status), `landings` (id, at, trunk_sha), `agents` (id, kind, model),
 * `agent_keys` (agent_id), `landing_paths` and `intents` (id, title). Every hook is best effort: a failure here is
 * logged and never fails a proposal, a landing, a certification or a take.
 */

/** FT_FIELD_GUIDE: whether this colony keeps a field guide: "on", or a comma-separated list of colony ids; off when absent. */
export function guideEnabled(setting: string | undefined, colonyId: Id): boolean {
  return revalidationEnabled(setting, colonyId);
}

/** Whether FT_FIELD_GUIDE turns the guide on for any colony (the MCP server then offers `lesson` on propose and says so). */
export function guideOffered(setting: string | undefined): boolean {
  const s = typeof setting === "string" ? setting.trim() : "";
  if (s === "" || s.toLowerCase() === "off") return false;
  return s.toLowerCase() === "on" || s.split(",").some((id) => id.trim() !== "");
}

/** What the colony gives its guide. */
export interface GuideHost {
  sql: SqlRunner;
  /**
   * Whether certification can activate lessons here: it runs (deployment switch, colony policy, a runner) and has tests
   * to run. If not, only a person activates them.
   */
  certifying(): boolean;
  /** One commit's certification, or null. */
  certification(sha: string): Certification | null;
  /** Certification results, newest first. */
  certifications(limit: number): Certification[];
  /** The clock (tests inject one). */
  now?(): number;
}

/** The guide as the API shows it. */
export interface GuideView {
  on: true;
  /** How a candidate joins the guide on this colony: a green certification or a person, or only a person. */
  gate: "certification" | "person";
  note: string;
  limits: typeof GUIDE_LIMITS;
  /** Active lessons, newest first, each with its provenance. */
  active: GuideEntry[];
  /** Characters of the active lessons together. */
  chars: number;
  /** Operator only: the candidates, newest first, and the lessons dropped or retired lately. */
  candidates?: GuideLesson[];
  ended?: GuideLesson[];
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS guide_lessons (
    id TEXT PRIMARY KEY, status TEXT NOT NULL, proposal_id TEXT NOT NULL, landing_id TEXT,
    created_at INTEGER NOT NULL, activated_at INTEGER, ended_at INTEGER, data TEXT NOT NULL)`,
  "CREATE INDEX IF NOT EXISTS guide_lessons_by_status ON guide_lessons(status, created_at)",
  "CREATE INDEX IF NOT EXISTS guide_lessons_by_proposal ON guide_lessons(proposal_id)",
  "CREATE INDEX IF NOT EXISTS guide_lessons_by_landing ON guide_lessons(landing_id)",
];

/** Lessons that left the guide (dropped or retired) kept for the operator, and how many the operator's view lists. */
const ENDED_KEEP = 500;
const ENDED_SHOWN = 50;
/** Certification results a landing looks through for the newest verdict. */
const VERDICT_LOOKBACK = 5;
const STATUSES: ReadonlySet<string> = new Set<LessonStatus>(["candidate", "active", "dropped", "retired"]);

/** One colony's field guide (see the module comment). */
export class FieldGuide {
  /** The active lessons takes read, kept until the guide changes (what moved since is read at each take). */
  private active: GuideLesson[] | null = null;

  constructor(private readonly host: GuideHost) {
    for (const stmt of SCHEMA) host.sql.exec(stmt);
  }

  private now(): number {
    return this.host.now?.() ?? Date.now();
  }

  // -------------------------------------------------------------------------
  // Hooks: a proposal, a landing, a certification, a revert, a take
  // -------------------------------------------------------------------------

  /**
   * The lesson an agent left with its proposal becomes a candidate: cleaned, masked, with the proposal's provenance
   * and its scope (the read set and write set with their blobs, when the proposal has them). Not kept when nothing
   * worth keeping is left, or when it repeats an active lesson or a waiting one. The receipt says which, in a sentence
   * the agent can act on.
   */
  capture(p: Pick<Proposal, "id" | "intentId" | "agentId" | "evidence"> & Partial<Pick<Proposal, "readSet" | "writeSet">>, raw: unknown): LessonReceipt {
    try {
      const existing = this.rows("SELECT data FROM guide_lessons WHERE proposal_id = ? LIMIT 1", p.id)[0];
      if (existing) return this.receipt(existing);
      const cleaned = cleanLesson(raw);
      if (!cleaned) return { status: "ignored", note: `The lesson was not recorded: it needs at least ${GUIDE_LIMITS.minLessonChars} characters of text on one line.` };
      const text = cleanLesson(maskSecrets(cleaned));
      if (!text || lessonKey(text.split(MASKED).join(" ")).length < GUIDE_LIMITS.minLessonChars) {
        return { status: "ignored", note: "The lesson was not recorded: it is mostly text that looks like a secret. Never put credentials in a lesson." };
      }
      const now = this.now();
      this.sweepReturned(now);
      const dup = duplicateOf(text, this.list(["active", "candidate"]));
      if (dup) return { status: "duplicate", duplicateOf: dup.id, note: `The guide already holds this lesson (${dup.id}, ${dup.status}), so it was not added again.` };
      this.makeRoom(now);
      const provenance = this.provenanceOf(p.agentId, p.evidence);
      const scope = lessonScope(p);
      const lesson: GuideLesson = { id: newId("les_"), text, status: "candidate", agentId: p.agentId, proposalId: p.id, intentId: p.intentId, ...(scope ? { scope } : {}), createdAt: now, ...(provenance ? { provenance } : {}) };
      this.write(lesson);
      this.pruneEnded();
      return this.receipt(lesson);
    } catch (err) {
      console.warn(`field guide: lesson of ${p.id} not recorded: ${errorText(err)}`);
      return { status: "ignored", note: "The lesson was not recorded: the colony could not store it. Your change is unaffected." };
    }
  }

  /** What a repeat of a proposal (the same agent, intent and head) is told: about the lesson the first call left, if any. */
  repeated(proposalId: Id): LessonReceipt {
    try {
      const l = this.rows("SELECT data FROM guide_lessons WHERE proposal_id = ? LIMIT 1", proposalId)[0];
      if (l) return this.receipt(l);
    } catch (err) {
      console.warn(`field guide: lesson of ${proposalId} not read: ${errorText(err)}`);
    }
    return { status: "ignored", note: "This change was proposed before without a lesson, so its repeat records none." };
  }

  /**
   * A landing: the lessons of its proposals record it (landing, commit, when it landed and when the colony learned it).
   * The colony can learn of a landing after the certification that covered it finished, so the newest verdict is
   * applied to them at once.
   */
  landed(l: Landing): void {
    try {
      const ids = (Array.isArray(l?.proposalIds) ? l.proposalIds : []).filter((id): id is string => typeof id === "string" && id !== "");
      if (ids.length === 0) return;
      const lessons = this.rows(
        "SELECT data FROM guide_lessons WHERE landing_id IS NULL AND status IN ('candidate', 'active') AND proposal_id IN (SELECT value FROM json_each(?))",
        JSON.stringify(ids),
      );
      if (lessons.length === 0) return;
      const now = this.now();
      for (const lesson of lessons) {
        lesson.landingId = l.id;
        if (typeof l.trunkSha === "string" && l.trunkSha !== "") lesson.trunkSha = l.trunkSha;
        lesson.landedAt = typeof l.at === "number" && Number.isFinite(l.at) ? l.at : now;
        lesson.receivedAt = now;
        // Its scope's written files hold what landed: a text merge's own blob where one merged them.
        if (lesson.scope) lesson.scope = landedScope(lesson.scope, l.merged, lesson.proposalId);
        this.write(lesson);
      }
      const verdict = this.host.certifications(VERDICT_LOOKBACK).find((c) => c.status === "green" || c.status === "red");
      if (verdict) this.apply(this.asCertification(verdict), lessons.filter((x) => x.status === "candidate"), now);
    } catch (err) {
      console.warn(`field guide: landing ${l?.id} not recorded: ${errorText(err)}`);
    }
  }

  /**
   * A certification result (the `certify` event the certifier publishes): a green run activates the candidates whose
   * landing it covers; a red one drops the candidates whose change it names as a suspect. Anything else is ignored.
   */
  certified(e: ColonyEvent | ColonyEvent[]): void {
    for (const ev of Array.isArray(e) ? e : [e]) {
      if (ev?.t !== "certify" || (ev.status !== "green" && ev.status !== "red")) continue;
      try {
        // The stored result names every suspect (the event carries the first five) and when the run started. Without it,
        // the start is unknown: 0 never counts a run as started after a landing, so only the commit decides.
        const stored = this.host.certification(ev.trunkSha);
        const cert: Certification =
          stored && stored.status === ev.status ? stored : { trunkSha: ev.trunkSha, status: ev.status, startedAt: 0, ...(ev.landingId ? { landingId: ev.landingId } : {}), ...(ev.suspects ? { suspects: ev.suspects } : {}) };
        const now = this.now();
        this.sweepReturned(now);
        this.apply(this.asCertification(cert), this.list(["candidate"]), now);
      } catch (err) {
        console.warn(`field guide: certification of ${ev.trunkSha} not applied: ${errorText(err)}`);
      }
    }
  }

  /** A person reverted a landing (or one proposal of it): its lessons, waiting or active, are dropped. Returns their ids. */
  reverted(p: { landing: Pick<Landing, "id" | "proposalIds">; proposalId?: Id; by: string; reason: string }): Id[] {
    try {
      const ids = p.proposalId ? [p.proposalId] : (Array.isArray(p.landing.proposalIds) ? p.landing.proposalIds : []).filter((id): id is string => typeof id === "string");
      const lessons = this.rows(
        `SELECT data FROM guide_lessons WHERE status IN ('candidate', 'active')
           AND (proposal_id IN (SELECT value FROM json_each(?))${p.proposalId ? "" : " OR landing_id = ?"})`,
        JSON.stringify(ids),
        ...(p.proposalId ? [] : [p.landing.id]),
      );
      const now = this.now();
      const what = p.proposalId ? `proposal ${p.proposalId} of landing ${p.landing.id}` : `landing ${p.landing.id}`;
      for (const l of lessons) this.end(l, "dropped", `${oneLine(p.by, 200) || "a person"} reverted ${what}: ${oneLine(p.reason, 300)}`, now);
      return lessons.map((l) => l.id);
    } catch (err) {
      console.warn(`field guide: revert of ${p.landing?.id} not applied: ${errorText(err)}`);
      return [];
    }
  }

  /**
   * What a take carries: the newest active lessons whose lines fit in GUIDE_LIMITS.takeChars (possibly none). With
   * `scoped` (FT_LESSON_SCOPE), the take's intent footprint: the lessons whose change read or wrote a file it covers come
   * first, each lesson is marked with the files of its scope that changed since it was written, and a lesson whose every
   * file changed is left out (colony/lessonscope.ts).
   */
  take(scoped?: { footprint: readonly string[] }): GuideTake {
    try {
      this.active ??= this.list(["active"]);
      return { lessons: takeLessons(scoped ? scopedEntries(this.host.sql, this.active, scoped.footprint) : this.active.map(guideEntry)) };
    } catch (err) {
      console.warn(`field guide: not read for a take: ${errorText(err)}`);
      return { lessons: [] };
    }
  }

  // -------------------------------------------------------------------------
  // A person's decisions, and the API's view
  // -------------------------------------------------------------------------

  /**
   * A person approves a lesson (it becomes active, whatever its gate said; refused while it repeats an active lesson)
   * or rejects one (it is dropped, active or not). Approving an active lesson, or rejecting a rejected one, changes nothing.
   */
  decide(id: Id, p: { action: "approve" | "reject"; by: string; reason?: string }): GuideLesson {
    const lesson = this.get(id);
    if (!lesson) throw ftError(404, `no lesson ${id} in this colony's guide`);
    const by = oneLine(p.by, 200) || "a person";
    const now = this.now();
    if (p.action === "approve") {
      if (lesson.status === "active") return lesson;
      const dup = duplicateOf(lesson.text, this.list(["active"]));
      if (dup) throw ftError(409, `lesson ${id} repeats active lesson ${dup.id}: reject that one first if this one says it better`);
      this.activate(lesson, { kind: "person", by }, now);
      this.enforceBudget(now);
    } else if (p.action === "reject") {
      if (lesson.status === "dropped" && (lesson.endReason ?? "").startsWith("rejected by ")) return lesson;
      const reason = oneLine(p.reason ?? "", 300);
      this.end(lesson, "dropped", `rejected by ${by}${reason ? `: ${reason}` : ""}`, now);
    } else {
      throw ftError(400, "action must be approve or reject");
    }
    return this.get(id) ?? lesson;
  }

  /** The guide for the API: the active lessons with their provenance; for the operator, the candidates and the lessons that left lately too. */
  view(admin: boolean): GuideView {
    const now = this.now();
    this.sweepReturned(now);
    const active = this.list(["active"])
      .map(guideEntry)
      .sort((a, b) => b.activatedAt - a.activatedAt);
    const certifying = this.host.certifying();
    const out: GuideView = {
      on: true,
      gate: certifying ? "certification" : "person",
      note: certifying
        ? "A lesson joins the guide once its change has landed and the first certification of trunk after it is green, or once a person approves it."
        : "This colony does not certify trunk, so a lesson joins the guide only when a person approves it.",
      limits: GUIDE_LIMITS,
      active,
      chars: active.reduce((n, e) => n + e.text.length, 0),
    };
    if (admin) {
      out.candidates = this.list(["candidate"]).sort((a, b) => b.createdAt - a.createdAt);
      out.ended = this.rows("SELECT data FROM guide_lessons WHERE status IN ('dropped', 'retired') ORDER BY ended_at DESC LIMIT ?", ENDED_SHOWN);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Rules applied to the store
  // -------------------------------------------------------------------------

  /** One certification's verdict on some candidates (core lessonVerdict), the oldest landing activated first, then the budget. */
  private apply(c: GuideCertification, candidates: readonly GuideLesson[], now: number): void {
    const activate: GuideLesson[] = [];
    for (const l of candidates) {
      const verdict = lessonVerdict(l, c);
      if (verdict === "drop") this.end(l, "dropped", `a red certification of ${c.trunkSha.slice(0, 7)} names its change as a suspect`, now);
      else if (verdict === "activate") activate.push(l);
    }
    if (activate.length === 0) return;
    activate.sort((a, b) => (a.landedAt ?? 0) - (b.landedAt ?? 0) || a.createdAt - b.createdAt);
    for (const l of activate) this.activate(l, { kind: "certification", trunkSha: c.trunkSha }, now);
    this.enforceBudget(now);
  }

  /** Make a lesson active, unless it repeats an active one (then it is dropped). */
  private activate(l: GuideLesson, gate: LessonGate, now: number): void {
    const dup = duplicateOf(
      l.text,
      this.list(["active"]).filter((a) => a.id !== l.id),
    );
    if (dup) {
      this.end(l, "dropped", `it repeats active lesson ${dup.id}`, now);
      return;
    }
    l.status = "active";
    l.activatedAt = now;
    l.activatedBy = gate;
    delete l.endedAt;
    delete l.endReason;
    this.write(l);
  }

  /** Drop or retire a lesson, saying why. */
  private end(l: GuideLesson, status: "dropped" | "retired", reason: string, now: number): void {
    l.status = status;
    l.endedAt = now;
    l.endReason = reason;
    this.write(l);
  }

  /** Retire the oldest active lessons while the guide is over its budget (core overBudget). */
  private enforceBudget(now: number): void {
    const reason = `the guide was over its budget of ${GUIDE_LIMITS.activeLessons} lessons and ${GUIDE_LIMITS.activeChars.toLocaleString("en-US")} characters, and the oldest lesson retires first`;
    for (const l of overBudget(this.list(["active"]))) this.end(l, "retired", reason, now);
  }

  /** Drop the candidates whose change came back (returned or rejected): it will never land. */
  private sweepReturned(now: number): void {
    let back: Array<{ data: string; status: string }>;
    try {
      back = this.host.sql
        .exec(
          `SELECT g.data AS data, p.status AS status FROM guide_lessons g JOIN proposals p ON p.id = g.proposal_id
            WHERE g.status = 'candidate' AND p.status IN ('returned', 'rejected')`,
        )
        .toArray() as Array<{ data: string; status: string }>;
    } catch {
      return; // no proposals table: nothing to sweep
    }
    for (const r of back) {
      const l = parseLesson(r.data);
      if (l) this.end(l, "dropped", `its change was ${r.status}, so it never landed`, now);
    }
  }

  /** Keep room for one more candidate: past GUIDE_LIMITS.candidates, the oldest waiting ones are dropped. */
  private makeRoom(now: number): void {
    const waiting = this.list(["candidate"]);
    const extra = waiting.length - (GUIDE_LIMITS.candidates - 1);
    if (extra <= 0) return;
    const oldest = waiting.sort((a, b) => a.createdAt - b.createdAt).slice(0, extra);
    for (const l of oldest) this.end(l, "dropped", `more than ${GUIDE_LIMITS.candidates} lessons were waiting, and the oldest goes first`, now);
  }

  /** Forget all but the newest ENDED_KEEP dropped or retired lessons. */
  private pruneEnded(): void {
    this.host.sql.exec(
      `DELETE FROM guide_lessons WHERE status IN ('dropped', 'retired') AND id NOT IN (
         SELECT id FROM guide_lessons WHERE status IN ('dropped', 'retired') ORDER BY ended_at DESC LIMIT ?)`,
      ENDED_KEEP,
    );
  }

  /** How a lesson's author and model are known, from the colony's record of the agent and the proposal's evidence, as its lineage note will say. */
  private provenanceOf(agentId: Id, evidence: Evidence | undefined): LessonProvenance | undefined {
    try {
      const row = this.host.sql.exec("SELECT kind, model FROM agents WHERE id = ?", agentId).toArray()[0] as { kind?: unknown; model?: unknown } | undefined;
      if (!row || typeof row.kind !== "string") return undefined;
      const kind = row.kind as AgentKind;
      const resumeKey = kind === "external" ? this.host.sql.exec("SELECT 1 AS x FROM agent_keys WHERE agent_id = ?", agentId).toArray().length > 0 : undefined;
      const p = noteProvenance({ kind, ...(typeof row.model === "string" && row.model ? { model: row.model } : {}), ...(resumeKey !== undefined ? { resumeKey } : {}) }, evidence);
      if (!p) return undefined;
      const model = p.model?.name ? maskSecrets(p.model.name) : undefined;
      return { author: p.author, ...(p.auth ? { auth: p.auth } : {}), ...(model && p.model ? { model, modelEvidence: p.model.evidence } : {}) };
    } catch {
      return undefined;
    }
  }

  /** A certification as the gate reads it, with when the colony saw its commit land (null when it did not record that landing). */
  private asCertification(c: Certification): GuideCertification {
    let landedAt: number | null = null;
    try {
      const row = this.host.sql.exec("SELECT at FROM landings WHERE id = ? OR trunk_sha = ? ORDER BY at DESC LIMIT 1", c.landingId ?? "", c.trunkSha).toArray()[0] as { at?: unknown } | undefined;
      if (typeof row?.at === "number") landedAt = row.at;
    } catch {
      landedAt = null;
    }
    return { status: c.status, trunkSha: c.trunkSha, landedAt, startedAt: c.startedAt, suspects: c.suspects ?? [] };
  }

  /** What the proposer is told about a lesson it left (a repeat of the same proposal hears about the lesson it left before). */
  private receipt(l: GuideLesson): LessonReceipt {
    if (l.status !== "candidate") return { status: "duplicate", duplicateOf: l.id, note: `This proposal's lesson is already in the guide's record as ${l.id} (${l.status}).` };
    const gate = this.host.certifying()
      ? "Other agents see it, with your agent id and model, once your change lands and the first certification of trunk after it is green, or once a person approves it."
      : "This colony does not certify trunk, so other agents see it, with your agent id and model, once a person approves it.";
    return { status: "candidate", lessonId: l.id, note: `Recorded as lesson ${l.id}. ${gate}` };
  }

  // -------------------------------------------------------------------------
  // Storage
  // -------------------------------------------------------------------------

  private get(id: Id): GuideLesson | null {
    return this.rows("SELECT data FROM guide_lessons WHERE id = ?", String(id ?? ""))[0] ?? null;
  }

  private list(statuses: LessonStatus[]): GuideLesson[] {
    return this.rows("SELECT data FROM guide_lessons WHERE status IN (SELECT value FROM json_each(?)) ORDER BY created_at", JSON.stringify(statuses));
  }

  private rows(query: string, ...bindings: unknown[]): GuideLesson[] {
    return (this.host.sql.exec(query, ...bindings).toArray() as Array<{ data?: unknown }>).flatMap((r) => {
      const l = parseLesson(r.data);
      return l ? [l] : [];
    });
  }

  private write(l: GuideLesson): void {
    this.host.sql.exec(
      "INSERT OR REPLACE INTO guide_lessons (id, status, proposal_id, landing_id, created_at, activated_at, ended_at, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      l.id,
      l.status,
      l.proposalId,
      l.landingId ?? null,
      l.createdAt,
      l.activatedAt ?? null,
      l.endedAt ?? null,
      JSON.stringify(l),
    );
    this.active = null;
  }
}

/** A stored lesson, or null when the row is not one (older or foreign data never crashes the guide). */
function parseLesson(data: unknown): GuideLesson | null {
  if (typeof data !== "string") return null;
  try {
    const l = JSON.parse(data) as GuideLesson;
    if (!l || typeof l !== "object" || typeof l.id !== "string" || typeof l.text !== "string" || !STATUSES.has(l.status) || typeof l.createdAt !== "number") return null;
    return l;
  } catch {
    return null;
  }
}

function oneLine(s: string, max: number): string {
  const t = String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
