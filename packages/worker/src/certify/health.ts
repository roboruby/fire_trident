import { usdText } from "@fire_trident/core";
import type { CertificationStatus, CulpritPrecision, Id, Sha, TrunkHealth, TrunkHealthMeasured } from "@fire_trident/core";
import type { SqlRunner } from "../colony/inline.ts";
import { nothingToRun } from "./landingtests.ts";

/**
 * Trunk health (GET /api/colonies/:id/metrics `trunkHealth`): what certifying after landing costs, computed only from
 * what certification and the colony already record. Certification runs after a change lands, so trunk can go red and
 * stay red until a fix lands; these are the numbers on that side of the trade. scripts/coordination.rb definition 18
 * computes the same from the public reads.
 *
 * - Results: the certifications table (the newest 500 results). A red episode runs from the first red result after a
 *   green one (or the first result kept) to the next green result; `error` and `skipped` results judge nothing and are
 *   passed over. Time red runs from the episode's first red result to its green one (when each was recorded), clipped
 *   to the window; an episode still red runs to now. The window runs from the oldest result kept (or the landing that
 *   made its commit) to now, or from the oldest landing kept when the landing log was trimmed past that.
 * - Commits: the colony's landing log (its newest 1,000 landings, in trunk order). A result sits at the landing that made
 *   its commit, else (a commit FireTrident made itself, or one older than the log) just after the newest landing at or
 *   before its start. A commit is red from the episode's first red commit (the first-red search's answer when FT_BISECT
 *   found one, else the commit of its first red result) until the fix: the first landing after the episode's last red
 *   result that carried a repair intent, else the commit the green result certified. A landing whose parent is red was
 *   built on red; a fix (it carried a repair intent, or made the commit that turned trunk green) is counted apart.
 * - Repairs: the intents certification declared (certify_repairs, and each red result's repairIntentId). How long agents
 *   held them comes from the event record's intent events (claimed or proposed, until any other status), what their
 *   model calls cost from the per-intent spend counters where FT_INTENT_SPEND counted them.
 * - Culprit precision: scripts/coordination.rb definition 15, the same rules, over the results kept.
 *
 * Nothing here writes, and a colony with no verdict says why (no test this platform can run, certification off, no run
 * yet) instead of showing zeros. The reads are cached until a landing or a result changes them (or a minute passes).
 */

/** Bounds of the certified-within shares, in minutes. */
export const WITHIN_MINUTES: readonly number[] = [5, 15, 60];
/** Inputs are read again at least this often (a first-red answer is written into a result already kept). */
export const HEALTH_TTL_MS = 60_000;

/** One certification result as trunk health reads it. */
export interface HealthResult {
  trunkSha: Sha;
  landingId?: Id | null;
  status: CertificationStatus;
  startedAt: number;
  finishedAt?: number | null;
  detail?: string | null;
  repairIntentId?: Id | null;
  /** Red only: the commit and landing its first-red search found, when it found one. */
  firstRed?: { trunkSha?: Sha | null; landingId?: Id | null } | null;
}

/** One landing of the colony's log, in trunk order (oldest first). */
export interface HealthLanding {
  id: Id;
  trunkSha: Sha;
  at: number;
  intentIds: Id[];
}

/** A repair intent and when certification declared it. */
export interface HealthRepair {
  id: Id;
  at: number;
}

/** How long agents held one intent: the holds that ended, and since when one holds it now (null when none does). */
export interface Hold {
  closedMs: number;
  since: number | null;
}

/** What trunkHealth computes from. */
export interface HealthInput {
  results: readonly HealthResult[];
  landings: readonly HealthLanding[];
  /** The landing log may no longer hold every landing since the oldest result (it is at its cap). */
  logTrimmed: boolean;
  repairs: readonly HealthRepair[];
  holds: ReadonlyMap<Id, Hold>;
  /** What the model calls counted for these intents cost, summed; null when none was counted. */
  spend: (ids: Id[]) => { usd: number; calls: number; intents: number } | null;
  culprits: CulpritPrecision;
  /** Why certification does not run in the colony, as a clause, or null when it does. */
  off: string | null;
  now: number;
}

/** A red episode as the walk over the results finds it. */
interface Episode {
  /** When its first red result was recorded, and when its green one was (null while it is red). */
  start: number;
  end: number | null;
  /** Where its red commits begin and end on the landing log (see the module comment); `green` is the green commit's place. */
  from: number;
  to: number;
  green: number | null;
}

const MINUTE = 60_000;

/** The value at quantile q of sorted values, by linear interpolation (as scripts/coordination.rb quantile), or null. */
export function quantile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/** A share rounded to four places, or null over nothing. */
function share(n: number, of: number): number | null {
  return of > 0 ? Math.round((n / of) * 10_000) / 10_000 : null;
}

/** When a result was recorded: its end, else its start. */
function doneAt(r: HealthResult): number {
  return typeof r.finishedAt === "number" && r.finishedAt > 0 ? r.finishedAt : r.startedAt;
}

/** A duration in words: "45 s", "3.4 min", "12 min", "2.5 h", "3.1 d". */
export function span(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  if (s < 59.5) return `${Math.round(s)} s`;
  const unit = (v: number, name: string): string => `${v < 9.95 ? v.toFixed(1) : String(Math.round(v))} ${name}`;
  const m = s / 60;
  if (m < 59.5) return unit(m, "min");
  const h = m / 60;
  if (h < 47.5) return unit(h, "h");
  return unit(h / 24, "d");
}

/** A whole number with thousands separators. */
function int(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** "1 landing", "400 landings". */
function many(n: number, word: string, plural = `${word}s`): string {
  return `${int(n)} ${n === 1 ? word : plural}`;
}

function percent(x: number | null): string {
  return x === null ? "n/a" : `${Math.round(x * 1000) / 10}%`;
}

/** A first-red answer and its result's suspects, as definition 15 reads them (stored JSON: read defensively). */
export interface CulpritResult {
  status?: unknown;
  suspects?: unknown;
  firstRed?: unknown;
}

const rec = (x: unknown): Record<string, unknown> | null => (x !== null && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : null);

/**
 * Culprit precision against first red (scripts/coordination.rb definition 15, the same rules): for each red result whose
 * first-red search found a landing, where that landing stood among the result's suspects, first match wins: a suspect
 * (at rank r, from 1, newest first); outside the import trace (the answer lists no proposal); not looked for (no
 * suspects); closure not recorded (the answer predates its proposal list); else cut by a limit.
 */
export function culpritPrecision(results: readonly CulpritResult[]): CulpritPrecision {
  const out: CulpritPrecision = { answers: 0, suspect: 0, rank1: 0, outsideImportTrace: 0, notLookedFor: 0, closureNotRecorded: 0, cutByLimit: 0, precision: null, reused: 0, isolated: { answers: 0, suspect: 0 } };
  for (const c of results) {
    const fr = rec(c.firstRed);
    if (c.status !== "red" || !fr || fr.status !== "found" || typeof fr.landingId !== "string" || fr.landingId === "") continue;
    const suspects = Array.isArray(c.suspects) ? c.suspects.map(rec).filter((s): s is Record<string, unknown> => s !== null) : [];
    const at = suspects.findIndex((s) => s.landingId === fr.landingId);
    out.answers++;
    if (at >= 0) {
      out.suspect++;
      if (at === 0) out.rank1++;
    } else if (Array.isArray(fr.proposals) && fr.proposals.length === 0) out.outsideImportTrace++;
    else if (suspects.length === 0) out.notLookedFor++;
    else if (!Array.isArray(fr.proposals)) out.closureNotRecorded++;
    else out.cutByLimit++;
    if (typeof fr.reusedFrom === "string" && fr.reusedFrom !== "") out.reused++;
    const iso = rec(fr.isolated);
    const culprit = iso && iso.status === "isolated" ? rec(iso.culprit) : null;
    if (culprit && typeof culprit.id === "string") {
      out.isolated.answers++;
      if (suspects.some((s) => s.proposalId === culprit.id)) out.isolated.suspect++;
    }
  }
  out.precision = share(out.suspect, out.answers);
  return out;
}

/**
 * How long agents held each intent, from its intent events in record order: a hold starts at `claimed` or `proposed`
 * and ends at any other status (open, landed, withdrawn, abandoned); one still going at the last event is open.
 */
export function holdsOf(events: Iterable<{ intentId: Id; status: string; at: number }>): Map<Id, Hold> {
  const out = new Map<Id, Hold>();
  for (const e of events) {
    if (typeof e.intentId !== "string" || typeof e.at !== "number" || !Number.isFinite(e.at)) continue;
    const h = out.get(e.intentId) ?? { closedMs: 0, since: null };
    const held = e.status === "claimed" || e.status === "proposed";
    if (held && h.since === null) h.since = e.at;
    else if (!held && h.since !== null) {
      h.closedMs += Math.max(0, e.at - h.since);
      h.since = null;
    }
    out.set(e.intentId, h);
  }
  return out;
}

/** Why there are no numbers, when no result in the window judged trunk (see TrunkHealth). */
function unmeasured(results: readonly HealthResult[], off: string | null): TrunkHealth {
  if (off) return { status: "off", reason: off, text: `trunk health not measured: ${off}` };
  const newest = [...results].filter((r) => r.status !== "running").sort((a, b) => doneAt(b) - doneAt(a))[0];
  if (newest && nothingToRun({ status: newest.status, ...(newest.detail ? { detail: newest.detail } : {}) })) {
    return { status: "no-tests", reason: newest.detail ?? "no test file", text: "trunk health not measured: certification found no test this platform can run" };
  }
  if (newest?.status === "error") {
    const why = `the last certification could not run${newest.detail ? ` (${newest.detail.replace(/[.\s]+$/, "")})` : ""}`;
    return { status: "none", reason: why, text: `trunk health not measured yet: ${why}` };
  }
  return { status: "none", reason: "no certification has judged trunk yet", text: "trunk health not measured yet: no certification has judged trunk" };
}

/**
 * Trunk health from the colony's records (see the module comment): red episodes and time red, landings built on red,
 * the time and spend repairs took, culprit precision, and how soon landings were certified.
 */
export function trunkHealth(input: HealthInput): TrunkHealth {
  const { landings, now } = input;
  const results = [...input.results].sort((a, b) => a.startedAt - b.startedAt || doneAt(a) - doneAt(b));
  const judged = results.filter((r) => r.status === "green" || r.status === "red");
  if (judged.length === 0) return unmeasured(results, input.off);

  // Places on the landing log: a landing's own commit sits at its index; any other commit just after the newest landing before it.
  const bySha = new Map<Sha, number>();
  const byId = new Map<Id, number>();
  landings.forEach((l, i) => {
    if (l.trunkSha) bySha.set(l.trunkSha, i);
    byId.set(l.id, i);
  });
  const exact = (sha: Sha | null | undefined, landingId: Id | null | undefined): number | null => {
    if (sha && bySha.has(sha)) return bySha.get(sha)!;
    if (landingId && byId.has(landingId)) return byId.get(landingId)!;
    return null;
  };
  const after = (at: number): number => {
    let k = -1;
    for (let i = 0; i < landings.length && landings[i]!.at <= at; i++) k = i;
    return k + 0.5;
  };
  const place = (r: HealthResult): number => exact(r.trunkSha, r.landingId) ?? after(r.startedAt);

  // The window: from the oldest result kept (or the landing that made its commit), or from the oldest landing kept when
  // the log was trimmed past it.
  let from = results[0]!.startedAt;
  const oldest = exact(results[0]!.trunkSha, results[0]!.landingId);
  if (oldest !== null) from = Math.min(from, landings[oldest]!.at);
  if (input.logTrimmed && landings.length > 0 && landings[0]!.at > from) from = landings[0]!.at;
  const to = Math.max(now, from);

  // Repair intents: what certification declared (its records, and each red result's), and the landings that carried one.
  const repairIds = new Set<Id>([...input.repairs.map((r) => r.id), ...results.flatMap((r) => (r.repairIntentId ? [r.repairIntentId] : []))]);
  const isRepair = (i: number): boolean => landings[i]!.intentIds.some((id) => repairIds.has(id));

  // The episodes, walking the verdicts in order.
  const episodes: Episode[] = [];
  let open: { start: number; from: number; last: number } | null = null;
  let lastGreen: number | null = null;
  const close = (end: number | null, green: number | null): void => {
    if (!open) return;
    // The fix: the first landing after the last red commit that carried a repair intent, before the green commit.
    let fix = green ?? Number.POSITIVE_INFINITY;
    for (let i = Math.floor(open.last) + 1; i < landings.length && i < fix; i++) {
      if (isRepair(i)) {
        fix = i;
        break;
      }
    }
    episodes.push({ start: open.start, end, from: open.from, to: fix, green });
    open = null;
  };
  for (const r of judged) {
    const at = place(r);
    if (r.status === "green") {
      close(doneAt(r), at);
      lastGreen = at;
      continue;
    }
    if (!open) {
      // Where its red commits begin: the first-red search's commit when it is on the log, else this result's commit.
      let begin = at;
      const fr = r.firstRed ? exact(r.firstRed.trunkSha, r.firstRed.landingId) : null;
      if (fr !== null) begin = Math.min(begin, fr);
      if (lastGreen !== null) begin = Math.max(begin, Math.min(at, Math.floor(lastGreen) + 1));
      open = { start: doneAt(r), from: begin, last: at };
    } else {
      open.last = Math.max(open.last, at);
      const fr = r.firstRed ? exact(r.firstRed.trunkSha, r.firstRed.landingId) : null;
      if (fr !== null && fr < open.from && (lastGreen === null || fr > lastGreen)) open.from = fr;
    }
  }
  close(null, null);
  const seen = episodes.filter((e) => (e.end ?? to) > from);

  // Time red, clipped to the window, and time to green over the episodes that ended.
  let redMs = 0;
  for (const e of seen) redMs += Math.max(0, Math.min(e.end ?? to, to) - Math.max(e.start, from));
  const toGreen = seen
    .filter((e) => e.end !== null)
    .map((e) => Math.max(0, e.end! - e.start))
    .sort((a, b) => a - b);
  const still = seen.find((e) => e.end === null);

  // Landings in the window, and the ones whose parent commit was red.
  const inWindow: number[] = [];
  landings.forEach((l, i) => {
    if (l.at >= from && l.at <= to) inWindow.push(i);
  });
  const builtOnRed = { landings: 0, afterRedKnown: 0, repairs: 0 };
  for (const i of inWindow) {
    const e = episodes.find((x) => x.from <= i - 0.5 && i - 0.5 < x.to);
    if (!e) continue;
    if (isRepair(i) || e.green === i) builtOnRed.repairs++;
    else {
      builtOnRed.landings++;
      if (landings[i]!.at >= e.start) builtOnRed.afterRedKnown++;
    }
  }

  // How soon each landing reached a green result that includes it.
  const greens = judged.filter((r) => r.status === "green").map((r) => ({ place: place(r), at: doneAt(r) }));
  const certifiedWithin = WITHIN_MINUTES.map((minutes) => ({ minutes, landings: 0, certified: 0, share: null as number | null }));
  for (const i of inWindow) {
    const l = landings[i]!;
    const g = greens.find((x) => x.place >= i);
    for (const w of certifiedWithin) {
      const bound = w.minutes * MINUTE;
      if (g) {
        w.landings++;
        if (Math.max(0, g.at - l.at) <= bound) w.certified++;
      } else if (now - l.at > bound) w.landings++;
    }
  }
  for (const w of certifiedWithin) w.share = share(w.certified, w.landings);

  // Repairs declared in the window: the time agents held them and what their calls cost.
  const declared = new Map<Id, number>();
  for (const r of input.repairs) declared.set(r.id, Math.min(declared.get(r.id) ?? r.at, r.at));
  for (const r of results) if (r.repairIntentId && !declared.has(r.repairIntentId)) declared.set(r.repairIntentId, doneAt(r));
  const repairs = [...declared].filter(([, at]) => at >= from).map(([id]) => id);
  let agentMs = 0;
  let held = 0;
  for (const id of repairs) {
    const h = input.holds.get(id);
    if (!h) continue;
    agentMs += h.closedMs + (h.since !== null ? Math.max(0, now - h.since) : 0);
    if (h.since !== null) held++;
  }
  const spend = repairs.length > 0 ? input.spend(repairs) : null;

  const health: TrunkHealthMeasured = {
    status: "measured",
    text: "",
    detail: [],
    window: { from, to, landings: inWindow.length, results: judged.filter((r) => doneAt(r) >= from).length },
    episodes: { count: seen.length, open: still ? 1 : 0, per100Landings: inWindow.length > 0 ? Math.round((seen.length / inWindow.length) * 100 * 100) / 100 : null },
    red: {
      ms: redMs,
      share: share(redMs, to - from),
      toGreen: { episodes: toGreen.length, p50Ms: quantile(toGreen, 0.5), p90Ms: quantile(toGreen, 0.9), maxMs: toGreen.at(-1) ?? null },
      ...(still ? { since: still.start } : {}),
    },
    builtOnRed,
    repair: { intents: repairs.length, agentMs, held, ...(spend ? { spend } : {}) },
    culprits: input.culprits,
    certifiedWithin,
  };
  health.text = healthText(health);
  health.detail = healthDetail(health, input.off);
  return health;
}

/** The line the colony page and `ft status` show: "red 2 times in 400 landings, 3.4 min to green at p50, 0 landings built on red". */
export function healthText(h: TrunkHealthMeasured): string {
  const parts = [`red ${many(h.episodes.count, "time")} in ${many(h.window.landings, "landing")}`];
  if (h.red.since !== undefined) parts.push(`red now for ${span(h.window.to - h.red.since)}`);
  if (h.red.toGreen.p50Ms !== null) parts.push(`${span(h.red.toGreen.p50Ms)} to green at p50`);
  parts.push(`${many(h.builtOnRed.landings, "landing")} built on red`);
  return parts.join(", ");
}

/** The rest of the numbers in sentences, for the page's detail and `ft status`. */
export function healthDetail(h: TrunkHealthMeasured, off: string | null): string[] {
  const out: string[] = [];
  const measured = span(h.window.to - h.window.from);
  if (h.episodes.count === 0) out.push(`Green at every verdict over the ${measured} measured (${many(h.window.results, "result")}).`);
  else {
    const g = h.red.toGreen;
    const closed = g.episodes > 0 ? `; to green at p50 ${span(g.p50Ms!)}, p90 ${span(g.p90Ms!)}, longest ${span(g.maxMs!)} over ${many(g.episodes, "episode")}` : "";
    out.push(`Red for ${span(h.red.ms)} of the ${measured} measured (${percent(h.red.share)})${closed}.`);
    const b = h.builtOnRed;
    out.push(`Built on red: ${many(b.landings, "landing")} besides the fixes, ${int(b.afterRedKnown)} of them after trunk was known red; ${many(b.repairs, "fix", "fixes")} (a repair intent, or the commit that turned trunk green).`);
  }
  const r = h.repair;
  if (r.intents > 0) {
    const cost = r.spend ? `; their model calls cost ${usdText(r.spend.usd)} (${many(r.spend.calls, "call")})` : "";
    out.push(`Repairs: ${many(r.intents, "intent")} held by agents for ${span(r.agentMs)}${r.held > 0 ? ` (${int(r.held)} held now)` : ""}${cost}.`);
  }
  const within = h.certifiedWithin.filter((w) => w.landings > 0).map((w) => `${w.minutes} min ${percent(w.share)} (${int(w.certified)}/${int(w.landings)})`);
  if (within.length > 0) out.push(`Certified within ${within.join(", ")}.`);
  const c = h.culprits;
  if (c.answers > 0) out.push(`Culprit finding listed the first red landing among its suspects in ${int(c.suspect)} of ${many(c.answers, "first-red answer")} (${int(c.rank1)} at rank 1).`);
  if (off) out.push(`Certification does not run now (${off}): these numbers end at its last result.`);
  return out;
}

/** What the colony gives the book. */
export interface HealthHost {
  sql: SqlRunner;
  /** Why certification does not run in the colony, as a clause, or null when it does (certify/landingtests.ts certificationOff). */
  off: () => string | null;
  /** What the model calls counted for these intents cost, summed; null when none was counted (certify/landingtests.ts landingSpend). */
  spend: (ids: Id[]) => { usd: number; calls: number; intents: number } | null;
  /** The landings the colony's log keeps at most: a log holding this many may have dropped older ones. */
  landingsKept: number;
}

type ResultRow = {
  trunk_sha: string;
  landing_id: string | null;
  status: string;
  started_at: number;
  finished_at: number | null;
  detail: string | null;
  repair: string | null;
  fr_sha: string | null;
  fr_landing: string | null;
};

function parseJson(text: unknown): unknown {
  if (typeof text !== "string") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Reads the inputs from the colony's tables (cached until they change) and computes trunk health. */
export class TrunkHealthBook {
  /** The results, repairs and culprit precision, kept until a result comes, finishes or changes (or HEALTH_TTL_MS passes). */
  private cached: { key: string; at: number; input: Pick<HealthInput, "results" | "repairs" | "culprits"> } | null = null;
  /** The landing log as read so far, by rowid: each call reads only the landings added since (the log only grows and trims). */
  private log: { rows: Array<HealthLanding & { seq: number }>; hi: number } = { rows: [], hi: 0 };
  private holdsCache: { key: string; holds: Map<Id, Hold> } | null = null;

  constructor(private readonly host: HealthHost) {}

  /** Trunk health now (see trunkHealth). */
  report(now: number): TrunkHealth {
    const input = this.inputs(now);
    const landings = this.landings();
    return trunkHealth({
      ...input,
      landings,
      logTrimmed: landings.length >= this.host.landingsKept,
      holds: this.holds(input.repairs, input.results),
      spend: (ids) => this.host.spend(ids),
      off: this.host.off(),
      now,
    });
  }

  private rows<T>(query: string, ...bindings: unknown[]): T[] {
    return this.host.sql.exec(query, ...bindings).toArray() as T[];
  }

  /** The colony's landing log in trunk order, reading only what was added since the last call. */
  private landings(): HealthLanding[] {
    const span = this.rows<{ lo: number | null; hi: number | null }>("SELECT MIN(rowid) AS lo, MAX(rowid) AS hi FROM landings")[0];
    const lo = span?.lo ?? 0;
    const hi = span?.hi ?? 0;
    // The log was erased (the colony was reset): read it whole.
    if (hi < this.log.hi) this.log = { rows: [], hi: 0 };
    if (hi > this.log.hi) {
      const fresh = this.rows<{ seq: number; id: string; at: number; trunk_sha: string; intents: string | null }>(
        "SELECT rowid AS seq, id, at, trunk_sha, json_extract(data, '$.intentIds') AS intents FROM landings WHERE rowid > ? ORDER BY rowid",
        this.log.hi,
      ).map((l) => {
        const ids = parseJson(l.intents);
        return { seq: l.seq, id: l.id, at: l.at, trunkSha: l.trunk_sha, intentIds: Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : [] };
      });
      this.log = { rows: [...this.log.rows, ...fresh], hi };
    }
    if (this.log.rows.length > 0 && this.log.rows[0]!.seq < lo) this.log.rows = this.log.rows.filter((r) => r.seq >= lo);
    return [...this.log.rows].sort((a, b) => a.at - b.at || a.seq - b.seq);
  }

  /** What changed in the results since the last read: their count and times. */
  private key(): string {
    const c = this.rows<{ n: number; s: number | null; f: number | null }>("SELECT COUNT(*) AS n, MAX(started_at) AS s, MAX(finished_at) AS f FROM certifications")[0];
    return `${c?.n ?? 0}:${c?.s ?? 0}:${c?.f ?? 0}`;
  }

  private inputs(now: number): Pick<HealthInput, "results" | "repairs" | "culprits"> {
    const key = this.key();
    if (this.cached && this.cached.key === key && now - this.cached.at < HEALTH_TTL_MS) return this.cached.input;
    const results: HealthResult[] = this.rows<ResultRow>(
      `SELECT trunk_sha, landing_id, status, started_at, finished_at, json_extract(data, '$.detail') AS detail, json_extract(data, '$.repairIntentId') AS repair,
         json_extract(data, '$.firstRed.trunkSha') AS fr_sha, json_extract(data, '$.firstRed.landingId') AS fr_landing
       FROM certifications ORDER BY started_at, rowid`,
    ).map((r) => ({
      trunkSha: r.trunk_sha,
      landingId: r.landing_id,
      status: r.status as CertificationStatus,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      detail: typeof r.detail === "string" ? r.detail : null,
      repairIntentId: typeof r.repair === "string" ? r.repair : null,
      firstRed: r.fr_sha || r.fr_landing ? { trunkSha: r.fr_sha, landingId: r.fr_landing } : null,
    }));
    let repairs: HealthRepair[] = [];
    try {
      repairs = this.rows<{ intent_id: string; at: number }>("SELECT intent_id, at FROM certify_repairs").map((r) => ({ id: r.intent_id, at: r.at }));
    } catch {
      // No repair records yet (certification never declared one in this colony).
    }
    const culprits = culpritPrecision(
      this.rows<{ suspects: string | null; first_red: string | null }>(
        "SELECT json_extract(data, '$.suspects') AS suspects, json_extract(data, '$.firstRed') AS first_red FROM certifications WHERE status = 'red' AND json_extract(data, '$.firstRed.status') = 'found'",
      ).map((r) => ({ status: "red", suspects: parseJson(r.suspects), firstRed: parseJson(r.first_red) })),
    );
    const input = { results, repairs, culprits };
    this.cached = { key, at: now, input };
    return input;
  }

  /** How long agents held the repair intents, from the event record; read again only when one of those intents changed. */
  private holds(repairs: readonly HealthRepair[], results: readonly HealthResult[]): Map<Id, Hold> {
    const ids = [...new Set([...repairs.map((r) => r.id), ...results.flatMap((r) => (r.repairIntentId ? [r.repairIntentId] : []))])].sort();
    if (ids.length === 0) return new Map();
    const list = JSON.stringify(ids);
    let key = list;
    try {
      key += JSON.stringify(this.rows<{ id: string; status: string; updated_at: number }>("SELECT id, status, updated_at FROM intents WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id", list));
    } catch {
      // No intents table: the key is the ids alone.
    }
    if (this.holdsCache && this.holdsCache.key === key) return this.holdsCache.holds;
    let holds = new Map<Id, Hold>();
    try {
      holds = holdsOf(
        this.rows<{ at: number; intent: string; status: string }>(
          "SELECT at, json_extract(data, '$.intentId') AS intent, json_extract(data, '$.status') AS status FROM events WHERE t = 'intent' AND json_extract(data, '$.intentId') IN (SELECT value FROM json_each(?)) ORDER BY seq",
          list,
        ).map((e) => ({ intentId: e.intent, status: e.status, at: e.at })),
      );
    } catch (err) {
      // No event record: the time agents held repairs is not known (0), the rest stands.
      console.warn(`trunk health: repair holds not read: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.holdsCache = { key, holds };
    return holds;
  }
}
