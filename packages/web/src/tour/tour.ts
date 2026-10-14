import type { FunnelStage, Rule } from "@fire_trident/core";
import type { Tab } from "../components/SidePanel.tsx";
import { fmtDuration, fmtInt, plural } from "../format.ts";
import { MOMENT_NAMES, findMoment, type Moment, type Timeline } from "../replay.ts";
import type { ColonyStore } from "../store.ts";

/**
 * The tour of a finished run (?tour=1): about seven steps, each standing on a moment found in the colony's own events
 * (replay.ts findMoment) and told in one sentence filled from the record at that moment. Pure, with no DOM: the Tour
 * component and scripts/tour_check.ts share it, so the numbers a step quotes can be checked against the colony's
 * metrics endpoint. A colony can have a tour of its own (tours.ts): the same steps, placed by its own moment finder and
 * filled by its own values, with the same player and the same check.
 */

/** One step of the tour script (tour.json; its $comment is the field reference). */
export interface TourStep {
  id: string;
  /** Moments tried in order: the first one the record holds places the step. */
  at: string[];
  /** The label over the sentence and the sentence itself, per moment name ("*" for any). */
  kicker: Record<string, string>;
  caption: Record<string, string>;
  /** Seconds after the moment the replay stops at. */
  offset: number;
  /** Seconds the step holds when the tour plays. */
  duration: number;
  tab?: Tab;
  select?: string[];
  highlight?: string;
  focus?: string;
  /** A top-bar widget to bring forward, per moment name ("*" for any). */
  emphasize?: Record<string, string>;
  /** The step's numbers rest on claim times (estimated in a reconstructed record). */
  estimated?: boolean;
  /** Shell lines shown under the sentence. */
  commands?: string[];
}

/** A step placed on its moment. */
export interface TourStop {
  step: TourStep;
  moment: Moment;
  /** Where the replay stops for it: the moment plus the step's offset, inside the run. */
  at: number;
  kicker: string;
  caption: string;
  emphasize?: string;
}

/** The steps a run holds, in the order the tour shows them, and the frame their sentences need. */
export interface TourPlan {
  stops: TourStop[];
  timeline: Timeline;
  /** When the rule was declared (the rule's own time when the colony lists it, else when its violations appeared); null without one. */
  ruleAt: number | null;
  /** Rules declared then (several can be declared together). */
  rules: number;
  /** The run's first event. */
  start: number;
  source: "recorded" | "reconstructed";
}

const TABS: ReadonlySet<string> = new Set(["events", "intents", "review", "why"]);
const EMPHASES: ReadonlySet<string> = new Set(["hero", "stats", "sigma", "vaccine", "funnel", "trunk"]);
const MOMENTS: ReadonlySet<string> = new Set(MOMENT_NAMES);
const STAGES: readonly FunnelStage[] = ["proof", "reflex", "llm", "human"];
/** A recorded run samples its funnel every 3 s: the sample after a moment holds every change settled by then. */
const FUNNEL_SAMPLE_MS = 3_500;
/** Rules declared this long before the one whose violations appeared count as declared together. */
const TOGETHER_MS = 60_000;
const DEFAULT_DURATION_S = 10;
const REASON_CHARS = 160;

/** Text per moment from a string (any moment) or an object keyed by moment name; null when it is neither. */
function perMoment(x: unknown, moments: ReadonlySet<string>): Record<string, string> | null {
  if (typeof x === "string") return { "*": x };
  if (!x || typeof x !== "object" || Array.isArray(x)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(x as Record<string, unknown>)) if (typeof v === "string" && (k === "*" || moments.has(k))) out[k] = v;
  return Object.keys(out).length ? out : null;
}

const strings = (x: unknown): string[] => (typeof x === "string" ? [x] : Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : []);

/** The text for a moment: its own, else the one for any moment. */
export function textFor(map: Record<string, string> | undefined, moment: string): string | undefined {
  return map?.[moment] ?? map?.["*"];
}

/**
 * The steps of a tour script, keeping only well-formed ones (a known moment and a caption). `moments` names the moments
 * the script may stand on: findMoment's by default, a colony tour's own otherwise.
 */
export function loadTourSteps(data: unknown, moments: ReadonlySet<string> = MOMENTS): TourStep[] {
  const list = (data as { steps?: unknown })?.steps;
  if (!Array.isArray(list)) return [];
  const out: TourStep[] = [];
  list.forEach((raw, i) => {
    if (!raw || typeof raw !== "object") return;
    const s = raw as Record<string, unknown>;
    const at = strings(s.at).filter((m) => moments.has(m));
    const caption = perMoment(s.caption, moments);
    if (!at.length || !caption) return;
    const emphasize = perMoment(s.emphasize, moments);
    const step: TourStep = {
      id: typeof s.id === "string" ? s.id : `step-${i + 1}`,
      at,
      kicker: perMoment(s.kicker, moments) ?? {},
      caption,
      offset: typeof s.offset === "number" && Number.isFinite(s.offset) ? s.offset : 0,
      duration: typeof s.duration === "number" && s.duration > 0 ? s.duration : DEFAULT_DURATION_S,
    };
    if (typeof s.tab === "string" && TABS.has(s.tab)) step.tab = s.tab as Tab;
    if (strings(s.select).length) step.select = strings(s.select);
    if (typeof s.highlight === "string") step.highlight = s.highlight;
    if (typeof s.focus === "string") step.focus = s.focus;
    if (emphasize) step.emphasize = Object.fromEntries(Object.entries(emphasize).filter(([, v]) => EMPHASES.has(v)));
    if (s.estimated === true) step.estimated = true;
    if (Array.isArray(s.commands)) step.commands = strings(s.commands);
    out.push(step);
  });
  return out;
}

/**
 * Place each step on the first of its moments the run holds, and order them as the run went: by moment, ties in script
 * order. Steps whose moments the record lacks are left out. A step's offset moves where the replay stops, never past
 * the next step's moment, so the tour only ever plays forward. The rule's time is its own declaration when the colony
 * lists it (what the metrics endpoint measures convergence from), else when its violations appeared; every moment but
 * @rule is looked for from then on. A colony tour passes its own `find` for its moments (asked for each name once).
 */
export function planTour(
  steps: readonly TourStep[],
  timeline: Timeline,
  opts: { rules?: readonly Rule[]; known?: ReadonlySet<string>; source?: "recorded" | "reconstructed"; find?: (name: string) => Moment | null } = {},
): TourPlan {
  const rise = opts.find ? opts.find("@rule") : findMoment(timeline, "@rule");
  let ruleAt: number | null = null;
  let rules = 0;
  if (rise) {
    const declared = (opts.rules ?? []).map((r) => r.createdAt).filter((t): t is number => typeof t === "number" && Number.isFinite(t) && t <= rise.at);
    const last = declared.length ? Math.max(...declared) : null;
    ruleAt = last ?? rise.at;
    rules = last === null ? 1 : declared.filter((t) => t >= last - TOGETHER_MS).length;
  }
  const since = ruleAt ?? undefined;
  const found = new Map<string, Moment | null>();
  const momentOf = (name: string): Moment | null => {
    if (name === "@rule") return rise;
    if (!found.has(name)) found.set(name, opts.find ? opts.find(name) : findMoment(timeline, name, { ...(since !== undefined ? { since } : {}), ...(opts.known ? { known: opts.known } : {}) }));
    return found.get(name) ?? null;
  };
  const placed: Array<TourStop & { order: number }> = [];
  steps.forEach((step, order) => {
    for (const name of step.at) {
      const moment = momentOf(name);
      const caption = textFor(step.caption, name);
      if (!moment || !caption) continue;
      const emphasize = textFor(step.emphasize, name);
      placed.push({ step, moment, at: moment.at, kicker: textFor(step.kicker, name) ?? "", caption, ...(emphasize ? { emphasize } : {}), order });
      break;
    }
  });
  placed.sort((a, b) => a.moment.at - b.moment.at || a.order - b.order);
  placed.forEach((stop, i) => {
    const prev = placed[i - 1]?.at ?? timeline.first;
    const next = placed[i + 1]?.moment.at ?? timeline.last;
    const at = stop.moment.at + stop.step.offset * 1000;
    stop.at = Math.max(timeline.first, prev, Math.min(timeline.last, stop.step.offset > 0 ? Math.min(at, next) : at));
  });
  return { stops: placed.map(({ order: _order, ...stop }) => stop), timeline, ruleAt, rules, start: timeline.first, source: opts.source ?? "recorded" };
}

/** "58.0 s", or "23 min 49 s" past ten minutes. */
export function fmtSeconds(ms: number): string {
  const v = Math.max(0, ms);
  return v < 600_000 ? `${(v / 1000).toFixed(1)} s` : fmtDuration(v);
}

/** "src/a.ts", "src/a.ts and src/b.ts", "src/a.ts, src/b.ts and 3 more". */
function fileList(paths: readonly string[]): string {
  if (!paths.length) return "a file";
  if (paths.length <= 2) return paths.join(" and ");
  return `${paths[0]}, ${paths[1]} and ${fmtInt(paths.length - 2)} more`;
}

/** "100%", "99.6%". */
const pct = (p: number): string => (p >= 1 ? "100%" : `${(Math.max(0, p) * 100).toFixed(1)}%`);

/** The latest funnel totals (funnel.* metric events) at or before time `t`. */
function funnelAt(timeline: Timeline, t: number): Record<FunnelStage, number> {
  const out: Record<FunnelStage, number> = { proof: 0, reflex: 0, llm: 0, human: 0 };
  timeline.events.forEach((e, i) => {
    if (e.t !== "metric" || (timeline.times[i] ?? 0) > t || !e.name.startsWith("funnel.")) return;
    const stage = e.name.slice(7) as FunnelStage;
    if (STAGES.includes(stage) && Number.isFinite(e.value)) out[stage] = e.value;
  });
  return out;
}

/** Landing commits that carried proposals, and the distinct intents they landed, in [from, to]. */
function landedBetween(timeline: Timeline, from: number, to: number): { landings: number; intents: number } {
  const intentOf = new Map<string, string>();
  const intents = new Set<string>();
  let landings = 0;
  timeline.events.forEach((e, i) => {
    if (e.t === "proposal") intentOf.set(e.proposalId, e.intentId);
    const t = timeline.times[i] ?? 0;
    if (e.t !== "landing" || t < from || t > to || !Array.isArray(e.proposalIds) || !e.proposalIds.length) return;
    landings++;
    for (const id of e.proposalIds) {
      const intent = intentOf.get(id);
      if (intent) intents.add(intent);
    }
  });
  return { landings, intents: intents.size };
}

/** What settled a landing's changes: the deciding layers' decisions on its proposals, else the proof or the innate checks. */
export function settledBy(moment: Moment, store: ColonyStore): string {
  let layer = "";
  for (const id of moment.proposalIds) {
    for (const d of store.decisions.get(id) ?? []) {
      if (d.layer === "human") layer = "human";
      else if (d.layer === "llm" && layer !== "human") layer = "llm";
      else if (d.layer === "reflex" && !layer) layer = "reflex";
    }
  }
  if (layer === "human") return "a person's approval";
  if (layer === "llm") return "a second model's approval";
  if (layer === "reflex") return "the reflex models";
  return moment.name === "@first-proof" || store.funnel.proof > 0 ? "a deterministic proof, with no model consulted" : "its innate checks, with review off";
}

/** The file (and line) a step opens the Why tab on, when the run landed on it; null when none fits. */
export function tourSelection(stop: TourStop, store: ColonyStore, plan: TourPlan): { path: string; line: number | null } | null {
  const known = new Set(store.files.map((f) => f.path));
  const landed: string[][] = [];
  plan.timeline.events.forEach((e, i) => {
    if (e.t === "landing" && (plan.timeline.times[i] ?? 0) <= stop.at && Array.isArray(e.proposalIds) && e.proposalIds.length) landed.push(e.paths ?? []);
  });
  const everLanded = new Set(landed.flat());
  for (const spec of stop.step.select ?? []) {
    if (spec === "@moment" || spec === "@last-landing") {
      const paths = spec === "@moment" ? stop.moment.paths : (landed[landed.length - 1] ?? []);
      const path = paths.find((p) => known.has(p));
      if (path) return { path, line: null };
      continue;
    }
    const m = /^(.+):(\d+)$/.exec(spec);
    const path = m?.[1] ?? spec;
    const line = m?.[2] ? Number(m[2]) : null;
    if (known.has(path) && everLanded.has(path)) return { path, line: line && line >= 1 ? line : null };
  }
  return null;
}

/** The numbers a step quotes, unformatted (scripts/tour_check.ts compares them with the metrics endpoint). */
export interface TourNumbers {
  violations: number;
  /** Violations fixed, and the time from the rule's declaration to the moment, for @converged. */
  fixed: number;
  fixedInMs: number;
  landingsSince: number;
  intentsLanded: number;
  /** Changes the proof settled, and every change review settled, since the rule (or the run's start). */
  proof: number;
  settled: number;
}

/** The numbers a stop quotes, read from the store at its moment and from the record. */
export function tourNumbers(stop: TourStop, store: ColonyStore, plan: TourPlan): TourNumbers {
  const from = plan.ruleAt ?? plan.start;
  const landed = landedBetween(plan.timeline, from, stop.at);
  const lag = plan.source === "recorded" ? FUNNEL_SAMPLE_MS : 0;
  const before = funnelAt(plan.timeline, from - 1);
  const after = funnelAt(plan.timeline, stop.at + lag);
  const settled = STAGES.reduce((n, s) => n + Math.max(0, after[s] - before[s]), 0);
  return {
    violations: store.violations.total,
    fixed: store.convergedIn()?.fixed ?? store.baseline?.initial ?? 0,
    fixedInMs: Math.max(0, stop.moment.at - from),
    landingsSince: landed.landings,
    intentsLanded: landed.intents,
    proof: Math.max(0, after.proof - before.proof),
    settled,
  };
}

/** Every value a caption can name, filled from the record at the stop's moment. */
export function tourValues(stop: TourStop, store: ColonyStore, plan: TourPlan): Record<string, string> {
  const m = stop.moment;
  const n = tourNumbers(stop, store, plan);
  const since = stop.at - (plan.ruleAt ?? plan.start);
  const needFiles = new Set<string>();
  for (const it of store.intents.values()) if (it.status === "open" || it.status === "claimed" || it.status === "proposed") for (const p of it.footprint) needFiles.add(p);
  const working = store.agentsWorking();
  const inFlight = m.count ?? 0;
  const sel = tourSelection(stop, store, plan);
  const reason = (m.reason ?? "").replace(/\s+/g, " ").trim();
  return {
    colony: store.colonyId,
    when: `${fmtSeconds(since)} ${plan.ruleAt !== null ? "after the rule" : "into the run"}`,
    rules: plan.rules === 1 ? "one rule" : plural(plan.rules, "rule"),
    violations: fmtInt(n.violations),
    needFiles: plural(needFiles.size, "file"),
    agentsAtWork: `${fmtInt(working)} ${working === 1 ? "agent was" : "agents were"} at work`,
    file: m.paths[0] ?? "a file",
    files: fileList(m.paths),
    settledBy: settledBy(m, store),
    returnPath: m.paths[0] ?? "a file it read",
    reason: reason.length > REASON_CHARS ? `${reason.slice(0, REASON_CHARS - 1)}…` : reason,
    noticeAgents: plural(m.agents ?? m.count ?? 0, "agent"),
    inFlight: `${fmtInt(inFlight)} ${inFlight === 1 ? "change was" : "changes were"}`,
    hotFile: m.paths[0] ?? "a file",
    hotReturns: plural(m.count ?? 0, "return"),
    hotLandings: plural(m.count ?? 0, "commit"),
    hotAgents: plural(m.agents ?? 0, "agent"),
    batchSize: fmtInt(m.count ?? 0),
    fixed: fmtInt(n.fixed),
    fixedIn: fmtSeconds(n.fixedInMs),
    intentsLanded: plural(n.intentsLanded, "intent"),
    landingsSince: plural(n.landingsSince, "commit"),
    proofLine: n.settled > 0 ? `a deterministic proof settled ${fmtInt(n.proof)} of the ${fmtInt(n.settled)} changes reviewed (${pct(n.proof / n.settled)}), with no model consulted` : "none of them went through review",
    selWhere: sel ? (sel.line ? `Line ${sel.line} of ${sel.path}` : sel.path) : "Every landed file",
    selArg: sel ? (sel.line ? `${sel.path}:${sel.line}` : sel.path) : "<path>",
  };
}

/** Fill {placeholders} from `values`; unknown ones stay as written, so a script mistake shows. */
export function fillTour(text: string, values: Readonly<Record<string, string>>): string {
  return text.replace(/\{(\w+)\}/g, (all, k: string) => values[k] ?? all);
}

/**
 * The replay speed for travelling `gapMs` of the run between two moments: the slowest that takes at most `maxWallMs`,
 * at least 1×; null when even 16× would take longer (the tour then jumps).
 */
export function travelSpeed(gapMs: number, maxWallMs = 6_000): number | null {
  for (const speed of [1, 2, 4, 8, 16]) if (gapMs / speed <= maxWallMs) return speed;
  return null;
}

/** What a colony tour read from the public API besides the record (tours.ts loadTourData), by name; a read that failed is null. */
export type TourData = Readonly<Record<string, unknown>>;

/**
 * A colony's own tour (tours.ts): its steps, the public reads they need, and how they are placed on the record, filled
 * from the store at each stop and checked against the API. The generic run tour (tour.json, Hono's) is one of these;
 * first-red and order-backend have their own. The player (Tour.tsx) and scripts/tour_check.ts work from this alone.
 */
export interface ColonyTour {
  /** The colony it tells (also the script's name: ?tour=<id> plays it on another colony with the same shape). */
  id: string;
  /** What it tells, in a line (the results card's link title). */
  about: string;
  steps: TourStep[];
  /** Public GETs under /api/colonies/<colony> the tour reads besides the snapshot, the agents and the record, by the name `data` holds them under. */
  reads: Readonly<Record<string, string>>;
  /** Place the steps on the record (the store stands at its start). */
  plan(timeline: Timeline, store: ColonyStore, data: TourData, source: "recorded" | "reconstructed"): TourPlan;
  /** Every value a caption can name, from the store standing at the stop's moment. */
  values(stop: TourStop, store: ColonyStore, plan: TourPlan, data: TourData): Record<string, string>;
  /** The numbers (and ids) a stop quotes, unformatted, from the store standing at its moment. */
  numbers(stop: TourStop, store: ColonyStore, plan: TourPlan, data: TourData): Record<string, number | string>;
  /** Compare what the stops quoted (`quoted[i]` for `plan.stops[i]`) with the API; `end` is the store after the whole record. */
  check(plan: TourPlan, quoted: ReadonlyArray<Record<string, number | string>>, end: ColonyStore, data: TourData, metrics: MetricsReport): TourCheck[];
}

/** What the colony's metrics endpoint answers (GET /api/colonies/:id/metrics), as far as the check reads it. */
export interface MetricsReport {
  metrics?: Record<string, number>;
  funnel?: Partial<Record<FunnelStage, number>>;
  violations?: { total?: number };
  convergence?: { since?: number | null; initial?: number; fixed?: number; convergedAt?: number | null };
}

/** One number the tour quotes beside the metrics endpoint's. */
export interface TourCheck {
  name: string;
  tour: string;
  metrics: string;
  ok: boolean;
  note?: string;
}

/**
 * Compare what the tour quotes with the colony's metrics endpoint: the violations the rule found, how many were fixed
 * and how fast (convergence, measured from the rule's declaration, within half a second), and at the end of the record
 * the violations, the funnel per stage, the landings and the intents landed (the per-step counts are differences of
 * those series). `rule` and `converged` are the numbers of those stops (null when the run has none); `end` is the store
 * after the whole record.
 */
export function checkTour(plan: TourPlan, rule: TourNumbers | null, converged: TourNumbers | null, end: ColonyStore, report: MetricsReport): TourCheck[] {
  const out: TourCheck[] = [];
  const same = (name: string, tour: number, metrics: number | undefined, note?: string) =>
    out.push({ name, tour: fmtInt(tour), metrics: metrics === undefined ? "absent" : fmtInt(metrics), ok: metrics !== undefined && tour === metrics, ...(note ? { note } : {}) });
  const c = report.convergence;
  const sameRule = !!c && typeof c.since === "number" && plan.ruleAt !== null && Math.abs(c.since - plan.ruleAt) < 1;
  const otherRule = "the endpoint measures from a later rule change";
  if (rule) {
    if (sameRule) same("violations the rule found", rule.violations, c?.initial);
    else out.push({ name: "violations the rule found", tour: fmtInt(rule.violations), metrics: "not comparable", ok: true, note: otherRule });
  }
  if (converged) {
    if (sameRule && typeof c?.convergedAt === "number" && typeof c.since === "number") {
      same("violations fixed", converged.fixed, c.fixed);
      const ms = c.convergedAt - c.since;
      out.push({ name: "time to zero", tour: fmtSeconds(converged.fixedInMs), metrics: fmtSeconds(ms), ok: Math.abs(converged.fixedInMs - ms) <= 500, note: `${Math.round(converged.fixedInMs - ms)} ms apart` });
    } else {
      out.push({ name: "time to zero", tour: fmtSeconds(converged.fixedInMs), metrics: "not comparable", ok: true, note: sameRule ? "the endpoint has not converged" : otherRule });
    }
  }
  same("violations at the end", end.violations.total, report.violations?.total);
  for (const s of STAGES) same(`funnel ${s} at the end`, end.funnel[s], report.funnel?.[s]);
  same("landings at the end", end.landingsTotal(), report.metrics?.["landings"]);
  same("intents landed at the end", end.intentsLanded(), report.metrics?.["landedIntents"] ?? report.metrics?.["intentsLanded"]);
  return out;
}
