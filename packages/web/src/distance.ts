import type { ColonyEvent, Id, IntentStatus, Rule } from "@fire_trident/core";
import { originOf, ruleBook, ruleHead, type OriginKind, type RuleBook } from "./intentTree.ts";
import { finite, fmtDuration, fmtInt, shortId } from "./format.ts";
import type { Series } from "./series.ts";
import type { CertView, ColonyStore, IntentOrigin, IntentView } from "./store.ts";

/**
 * The colony's distance to its target (the first screen, components/FirstScreen.tsx): the open needs by kind, one
 * number per kind and a total, zero everywhere meaning done. Every count is read from what the colony already records,
 * now from the store and over a finished run from its event record (the convergence curve). Each need counts once, by
 * what it waits on: a rule's intents count as the rule's violations, a certification repair as the failing tests, and
 * an intent whose change or report waits for a person as waiting for a person.
 */

/** The kinds of need, in the order the first screen shows them. */
export type DistanceKey = "violations" | "tests" | "intents" | "waiting";

/** One part of a kind: a rule's violations, the intents from one origin, one kind of wait. */
export interface DistancePart {
  key: string;
  label: string;
  count: number;
}

/** One kind of need: how many are open, and what they are. */
export interface DistanceKind {
  key: DistanceKey;
  count: number;
  /** "rule violations", "failing test", ... (singular for one). */
  label: string;
  /** Hover text: what is counted and what moves it. */
  title: string;
  /** The parts with a count above zero, largest first (rules), or in a fixed order (origins, waits). */
  parts: DistancePart[];
}

/** The distance to target now. */
export interface Distance {
  kinds: DistanceKind[];
  total: number;
  /** Zero everywhere, once the colony is loaded: "At target". */
  atTarget: boolean;
}

/** Intent states still to be met (not landed, withdrawn or abandoned). */
const LIVE: ReadonlySet<IntentStatus> = new Set<IntentStatus>(["open", "claimed", "proposed"]);

/** Origins counted by another kind: a rule's intents are its violations, a repair is the failing tests. */
const COUNTED_ELSEWHERE: ReadonlySet<OriginKind> = new Set<OriginKind>(["rule", "certify"]);

/** The origins an unmet intent can have, in the order the parts list them, with their words. */
const ORIGIN_PARTS: ReadonlyArray<[OriginKind, string]> = [
  ["human", "from people"],
  ["agent", "from agents"],
  ["system", "from the colony"],
  ["unknown", "origin not known"],
];

const TITLES: Readonly<Record<DistanceKey, string>> = {
  violations: "Matches of the colony's rules still on trunk. Each rule declared one intent per violating file; those intents count here, by their violations, and a landing that fixes a file takes its matches off.",
  tests: "Tests failing on trunk in the newest finished certification run. A red trunk becomes a repair intent, which counts here; certified stays on the last commit whose tests passed.",
  intents: "Intents people, agents or the colony declared that have not landed. Rule intents and certification repairs count as their violations and failing tests, and an intent whose change or report waits for a person counts as waiting.",
  waiting: "Changes the reflex arc sent to a person (held merges among them), and agents' reports that an intent cannot be done as written. Nothing moves on them until a person answers.",
};

/** "1 rule violation", "2 rule violations": the label of a kind for its count. */
function label(key: DistanceKey, n: number): string {
  switch (key) {
    case "violations":
      return n === 1 ? "rule violation" : "rule violations";
    case "tests":
      return n === 1 ? "failing test" : "failing tests";
    case "intents":
      return n === 1 ? "unmet intent" : "unmet intents";
    default:
      return "waiting for a person";
  }
}

function kind(key: DistanceKey, count: number, parts: DistancePart[]): DistanceKind {
  return { key, count, label: label(key, count), title: TITLES[key], parts: parts.filter((p) => p.count > 0) };
}

/** A rule as a part's label: the head of its description, else its short id. */
function ruleLabel(rule: Rule | undefined, id: Id): string {
  const head = rule && typeof rule.description === "string" ? ruleHead(rule.description) : "";
  return head || `Rule ${shortId(id)}`;
}

/** The newest finished certification (a run in progress keeps the last result: trunk is as red as it was). */
export function lastResult(certs: Iterable<CertView>): CertView | null {
  let last: CertView | null = null;
  for (const c of certs) if (c.status !== "running") last = c;
  return last;
}

/** Tests a result counts as failing: failed and cancelled ones on a red result (at least one), none otherwise. */
export function failingIn(c: Pick<CertView, "status" | "counts" | "failing"> | null | undefined): number {
  if (!c || c.status !== "red") return 0;
  const k = c.counts;
  const n = k ? Math.max(0, finite(k.fail)) + Math.max(0, finite(k.cancelled)) : Array.isArray(c.failing) ? c.failing.length : 0;
  return Math.max(1, n);
}

/** The distance to target from what the store holds now. */
export function distanceOf(store: ColonyStore): Distance {
  const book = ruleBook(store.rules.values());
  const byRule: DistancePart[] = Object.entries(store.violations.byRule ?? {})
    .filter(([, n]) => typeof n === "number" && Number.isFinite(n) && n > 0)
    .map(([id, n]) => ({ key: id, label: ruleLabel(store.rules.get(id), id), count: n }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  const violations = Math.max(0, finite(store.violations.total));

  const failing = failingIn(lastResult(store.certs.values()));

  // Intents whose change or report waits for a person count as waiting, not as unmet.
  const waitingOn = new Set<Id>(store.openEscalations().map((e) => e.intentId));
  for (const p of store.proposals.values()) if (p.status === "escalated") waitingOn.add(p.intentId);
  const byOrigin = new Map<OriginKind, number>();
  for (const it of store.intents.values()) {
    if (!LIVE.has(it.status) || waitingOn.has(it.id)) continue;
    const o = originOf(it, book).kind;
    if (COUNTED_ELSEWHERE.has(o)) continue;
    byOrigin.set(o, (byOrigin.get(o) ?? 0) + 1);
  }
  const unmet = [...byOrigin.values()].reduce((a, n) => a + n, 0);

  const review = store.reviewQueue();
  const reports = store.openEscalations().length;

  const kinds: DistanceKind[] = [
    kind("violations", violations, byRule),
    kind("tests", failing, []),
    kind(
      "intents",
      unmet,
      ORIGIN_PARTS.map(([k, words]) => ({ key: k, label: words, count: byOrigin.get(k) ?? 0 })),
    ),
    kind("waiting", review + reports, [
      { key: "review", label: review === 1 ? "change to review" : "changes to review", count: review },
      { key: "reports", label: reports === 1 ? "agent report" : "agent reports", count: reports },
    ]),
  ];
  const total = kinds.reduce((a, k) => a + k.count, 0);
  return { kinds, total, atTarget: store.loaded && total === 0 };
}

// ---------------------------------------------------------------------------
// Over a run: the convergence curve
// ---------------------------------------------------------------------------

/** The distance at one moment of a run (after the events at that time). */
export interface CurvePoint {
  at: number;
  total: number;
  violations: number;
  tests: number;
  intents: number;
  waiting: number;
}

/** A run's events with their times (a replay's Timeline: times made monotone); without `times`, each event's own `at`. */
export interface EventRecord {
  events: readonly ColonyEvent[];
  times?: ArrayLike<number>;
}

/** Whether two points have the same count of every kind. */
function sameKinds(a: CurvePoint, b: CurvePoint): boolean {
  return a.violations === b.violations && a.tests === b.tests && a.intents === b.intents && a.waiting === b.waiting;
}

interface IntentTrack {
  view: IntentView;
  /** Counted as an unmet intent by its origin (not a rule's, not a repair). */
  own: boolean;
}

/**
 * The distance to target after each moment of a run, from its event record: violations totals, certification results,
 * intents and their states, changes sent to a person and agents' reports, counted as distanceOf counts them (an intent's
 * origin from what the page learned, else from the titles the colony writes for its own intents). Moments at one time
 * keep only their last point, and a point is kept only when some kind changed. `learned` gives an intent's origin when
 * the page knows it (ColonyStore.learnedOrigin).
 */
export function distanceSeries(record: EventRecord, rules: Iterable<Rule>, learned?: (id: Id) => IntentOrigin | undefined): CurvePoint[] {
  const book: RuleBook = ruleBook(rules);
  const intents = new Map<Id, IntentTrack>();
  const escalated = new Map<Id, Id>();
  const escalatedFor = new Map<Id, number>();
  const reports = new Set<Id>();
  let violations = 0;
  let tests = 0;
  let unmet = 0;
  const out: CurvePoint[] = [];
  let clock = Number.NEGATIVE_INFINITY;

  const counts = (id: Id): boolean => {
    const t = intents.get(id);
    return !!t && t.own && LIVE.has(t.view.status) && !reports.has(id) && (escalatedFor.get(id) ?? 0) === 0;
  };
  /** Run `change` on intent `id`, keeping the unmet count right. */
  const touch = (id: Id, change: () => void): void => {
    const before = counts(id);
    change();
    const after = counts(id);
    if (before !== after) unmet += after ? 1 : -1;
  };
  const placed = (id: Id, title: string, status: IntentStatus, footprint: readonly string[], at: number): IntentTrack => {
    const o = learned?.(id);
    const view: IntentView = { id, title, status, footprint: [...footprint], priority: 1, createdAt: at, updatedAt: at, revision: 1 };
    if (o) {
      view.source = o.source;
      if (o.ruleId) view.ruleId = o.ruleId;
    }
    return { view, own: !COUNTED_ELSEWHERE.has(originOf(view, book).kind) };
  };

  record.events.forEach((e, i) => {
    const at = Math.max(clock, finite(record.times?.[i], finite((e as { at?: unknown }).at, clock)));
    clock = at;
    switch (e.t) {
      case "violations":
        violations = Math.max(0, finite(e.total, violations));
        break;
      case "certify":
        if (e.status !== "running") tests = failingIn(e);
        break;
      case "intent": {
        if (typeof e.intentId !== "string") break;
        touch(e.intentId, () => {
          const t = intents.get(e.intentId);
          if (!t) {
            intents.set(e.intentId, placed(e.intentId, typeof e.title === "string" ? e.title : e.intentId, e.status, Array.isArray(e.footprint) ? e.footprint : [], at));
            return;
          }
          t.view.status = e.status;
          if (Array.isArray(e.footprint) && e.footprint.length) t.view.footprint = [...e.footprint];
        });
        // A report on an intent that landed or was withdrawn is settled.
        if (!LIVE.has(e.status) && reports.has(e.intentId)) touch(e.intentId, () => reports.delete(e.intentId));
        break;
      }
      case "withdrawn":
        if (typeof e.intentId !== "string") break;
        touch(e.intentId, () => {
          const t = intents.get(e.intentId);
          if (t) t.view.status = "withdrawn";
          reports.delete(e.intentId);
        });
        break;
      case "proposal": {
        if (typeof e.proposalId !== "string") break;
        const was = escalated.get(e.proposalId);
        const now = e.status === "escalated";
        if ((was !== undefined) === now || (now && typeof e.intentId !== "string")) break;
        const intentId = was ?? e.intentId;
        touch(intentId, () => {
          if (now) {
            escalated.set(e.proposalId, e.intentId);
            escalatedFor.set(e.intentId, (escalatedFor.get(e.intentId) ?? 0) + 1);
          } else {
            escalated.delete(e.proposalId);
            const left = (escalatedFor.get(intentId) ?? 1) - 1;
            if (left > 0) escalatedFor.set(intentId, left);
            else escalatedFor.delete(intentId);
          }
        });
        break;
      }
      case "escalation":
        if (typeof e.intentId !== "string" || !e.intentId) break;
        touch(e.intentId, () => {
          const t = intents.get(e.intentId);
          if (e.resolved || (t && !LIVE.has(t.view.status))) reports.delete(e.intentId);
          else reports.add(e.intentId);
        });
        break;
      default:
        return;
    }
    const point: CurvePoint = { at, violations, tests, intents: unmet, waiting: escalated.size + reports.size, total: 0 };
    point.total = point.violations + point.tests + point.intents + point.waiting;
    const prev = out[out.length - 1];
    if (prev && prev.at === at) {
      // Moments at one time keep the last; one that ends where the point before it was is no change at all.
      out[out.length - 1] = point;
      const before = out[out.length - 2];
      if (before && sameKinds(before, point)) out.pop();
    } else if (!prev || !sameKinds(prev, point)) {
      out.push(point);
    }
  });
  return out;
}

/** What the curve says about a run: its peak, when it left zero for that peak, and when it got back to zero. */
export interface CurveSummary {
  peak: number;
  peakAt: number;
  /** When the climb to the peak began (the rule change before it, within a minute, as the colony measures convergence). */
  from: number;
  /** The first time after the peak that every kind was zero; null while something stays open. */
  zeroAt: number | null;
  /** The distance at the end of the record. */
  last: number;
}

/** The summary of a curve; null for an empty one. `rules` places the climb's start at the rule change behind it. */
export function summarize(points: readonly CurvePoint[], rules: Iterable<Rule> = []): CurveSummary | null {
  if (!points.length) return null;
  let peak = -1;
  let peakIdx = 0;
  points.forEach((p, i) => {
    if (p.total > peak) {
      peak = p.total;
      peakIdx = i;
    }
  });
  const peakAt = points[peakIdx]?.at ?? 0;
  // The climb starts at the first point after the last zero before the peak.
  let rise = 0;
  for (let i = peakIdx; i >= 0; i--) {
    if ((points[i]?.total ?? 0) === 0) {
      rise = i + 1;
      break;
    }
  }
  let from = points[Math.min(rise, peakIdx)]?.at ?? peakAt;
  let best: number | null = null;
  for (const r of rules) {
    for (const t of [r.createdAt, r.retractedAt]) {
      if (typeof t === "number" && Number.isFinite(t) && t <= from && t >= from - 60_000 && (best === null || t > best)) best = t;
    }
  }
  if (best !== null) from = best;
  let zeroAt: number | null = null;
  for (let i = peakIdx + 1; i < points.length; i++) {
    const p = points[i];
    if (p && p.total === 0) {
      zeroAt = p.at;
      break;
    }
  }
  return { peak: Math.max(0, peak), peakAt, from, zeroAt: peak > 0 ? zeroAt : null, last: points[points.length - 1]?.total ?? 0 };
}

/** The distance at time `t`: the last point at or before it (0 before the first). */
export function distanceAt(points: readonly CurvePoint[], t: number): number {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((points[mid]?.at ?? 0) <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 ? (points[lo - 1]?.total ?? 0) : 0;
}

/**
 * An SVG path of the curve as steps (the distance holds until the next moment), in a W×H box spanning [t0, t1] and
 * scaled to `max`, with `pad` above and below; points past `upTo` are left out (the part played so far). "" for no points.
 */
export function stepPath(points: readonly CurvePoint[], t0: number, t1: number, W: number, H: number, max: number, pad = 2, upTo = Number.POSITIVE_INFINITY): string {
  if (!points.length || !(t1 > t0)) return "";
  const x = (t: number) => (Math.max(0, Math.min(1, (t - t0) / (t1 - t0))) * W).toFixed(1);
  const y = (v: number) => (H - pad - (Math.max(0, v) / Math.max(1, max)) * (H - pad * 2)).toFixed(1);
  const end = Math.min(t1, upTo);
  let d = `M0 ${y(0)}`;
  for (const p of points) {
    if (p.at > end) break;
    d += ` H${x(p.at)} V${y(p.total)}`;
  }
  return `${d} H${x(end)}`;
}

/** What the curve panel draws: the points, the span, a marker for the replay's time, and the sentence under it. */
export interface CurveData {
  points: CurvePoint[];
  t0: number;
  t1: number;
  /** The top of the scale (the peak, at least 1). */
  max: number;
  /** The replay's time now (a marker and the part played so far), null for a live window. */
  now: number | null;
  /** "run": a finished run's whole distance, from its record; "window": live violations over the server's per-minute window. */
  kind: "run" | "window";
  /** "960 → 0 in 60 s", "120 at the peak, 4 at the end", ... */
  caption: string;
  summary: CurveSummary | null;
}

/** A run's span for the caption: seconds up to two minutes ("60 s"), then fmtDuration. */
function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 120 ? `${s} s` : fmtDuration(ms);
}

/** The curve of a finished run over [start, end], from its points (distanceSeries); null without any. */
export function runCurve(points: CurvePoint[], start: number, end: number, now: number | null, rules: Iterable<Rule> = []): CurveData | null {
  if (!points.length) return null;
  const summary = summarize(points, rules);
  const t0 = Math.min(start, points[0]?.at ?? start);
  const t1 = Math.max(end, points[points.length - 1]?.at ?? end, t0 + 1);
  const caption = !summary || summary.peak === 0 ? "Nothing open during the run" : summary.zeroAt !== null ? `${fmtInt(summary.peak)} → 0 in ${span(summary.zeroAt - summary.from)}` : `${fmtInt(summary.peak)} at the peak, ${fmtInt(summary.last)} at the end`;
  return { points, t0, t1, max: Math.max(1, summary?.peak ?? 1), now, kind: "run", caption, summary };
}

/** The live curve: violations per minute over the server's window, the last bucket the live total; null without history. */
export function windowCurve(series: Series | null, live: number): CurveData | null {
  if (!series || series.violations.length < 2) return null;
  const v = [...series.violations.slice(0, -1), Math.max(0, live)];
  const points: CurvePoint[] = v.map((n, i) => ({ at: series.start + i * series.bucketMs, total: n, violations: n, tests: 0, intents: 0, waiting: 0 }));
  const t0 = series.start;
  const t1 = series.start + v.length * series.bucketMs;
  const peak = Math.max(0, ...v);
  const minutes = Math.max(1, Math.round((t1 - t0) / 60_000));
  const caption = peak === 0 ? `No violations in the last ${minutes} min` : `Violations, last ${minutes} min: ${fmtInt(peak)} at the peak, ${fmtInt(v[v.length - 1] ?? 0)} now`;
  return { points, t0, t1, max: Math.max(1, peak), now: null, kind: "window", caption, summary: null };
}
