import { TOUR_ABOUT } from "./catalog.ts";
import { FIRST_RED_TOUR } from "./firstRed.ts";
import { ORDER_BACKEND_TOUR } from "./orderBackend.ts";
import type { ReplayEngine } from "../replay.ts";
import { checkTour, fillTour, fmtSeconds, loadTourSteps, planTour, tourNumbers, tourValues, type ColonyTour, type MetricsReport, type TourCheck, type TourData, type TourNumbers, type TourPlan } from "./tour.ts";
import raw from "./tour.json" with { type: "json" };

/**
 * The tours by colony: Hono's (tour.json, the tour of any run that a rule started: it also serves a colony without a
 * tour of its own), first-red's and order-backend's. The player (Tour.tsx) and scripts/tour_check.ts pick one with
 * tourFor, read what it needs from the public API with loadTourData, and tell and check it with runTourCheck.
 */

const RUN_STEPS = loadTourSteps(raw);

/** TourNumbers from what a stop quoted (the run tour's numbers are all numeric). */
function numbersOf(q: Record<string, number | string> | undefined): TourNumbers | null {
  if (!q) return null;
  const n = (k: string): number => (typeof q[k] === "number" ? (q[k] as number) : 0);
  return { violations: n("violations"), fixed: n("fixed"), fixedInMs: n("fixedInMs"), landingsSince: n("landingsSince"), intentsLanded: n("intentsLanded"), proof: n("proof"), settled: n("settled") };
}

/** The tour of a run that a rule started (tour.json): Hono's, and any colony's without a tour of its own. */
export const RUN_TOUR: ColonyTour = {
  id: "hono",
  about: TOUR_ABOUT["hono"] ?? "",
  steps: RUN_STEPS,
  reads: {},
  plan: (timeline, store, _data, source) => planTour(RUN_STEPS, timeline, { rules: [...store.rules.values()], known: new Set(store.files.map((f) => f.path)), source }),
  values: (stop, store, plan) => tourValues(stop, store, plan),
  numbers: (stop, store, plan) => ({ ...tourNumbers(stop, store, plan) }),
  check: (plan, quoted, end, _data, metrics) => {
    const rule = plan.stops.findIndex((s) => s.step.id === "rule" && s.moment.name === "@rule");
    const converged = plan.stops.findIndex((s) => s.moment.name === "@converged");
    return checkTour(plan, rule >= 0 ? numbersOf(quoted[rule]) : null, converged >= 0 ? numbersOf(quoted[converged]) : null, end, metrics);
  },
};

const TOURS: Readonly<Record<string, ColonyTour>> = { hono: RUN_TOUR, "first-red": FIRST_RED_TOUR, "order-backend": ORDER_BACKEND_TOUR };

/** The tours by id, as the catalog lists them. */
export function tourIds(): string[] {
  return Object.keys(TOURS);
}

/**
 * The tour for a colony: the script named (?tour=<id>, for another colony with the same shape, such as a preview run of
 * the same demo), else the colony's own, else the run tour.
 */
export function tourFor(colonyId: string, script?: string | null): ColonyTour {
  return (script ? TOURS[script] : undefined) ?? TOURS[colonyId] ?? RUN_TOUR;
}

/** The public reads a tour needs, each fetched under /api/colonies/<colony> with `get` (relative in the page, absolute in a script); one that fails is null. */
export async function loadTourData(tour: ColonyTour, get: (suffix: string) => Promise<unknown>): Promise<TourData> {
  const entries = await Promise.all(Object.entries(tour.reads).map(async ([name, suffix]) => [name, await get(suffix).catch(() => null)] as const));
  return Object.fromEntries(entries);
}

/** A tour told and checked on one record (scripts/tour_check.ts prints this). */
export interface TourCheckRun {
  plan: TourPlan;
  /** Each stop: where it stands and its sentence, as the tour shows it. */
  lines: Array<{ label: string; text: string }>;
  checks: TourCheck[];
}

/**
 * Plan a colony's tour on its record, stand the replay at each stop to fill its sentence and read the numbers it quotes,
 * then compare them with the API (`data` from loadTourData, `metrics` from GET /metrics). The engine is left at the end.
 */
export function runTourCheck(tour: ColonyTour, engine: ReplayEngine, data: TourData, metrics: MetricsReport, source: "recorded" | "reconstructed"): TourCheckRun {
  const store = engine.store;
  engine.begin();
  const plan = tour.plan(engine.timeline, store, data, source);
  const quoted: Array<Record<string, number | string>> = [];
  const lines: TourCheckRun["lines"] = [];
  plan.stops.forEach((stop, i) => {
    engine.seek(stop.at);
    quoted.push(tour.numbers(stop, store, plan, data));
    lines.push({ label: `${i + 1}/${plan.stops.length} ${stop.kicker} (${stop.moment.name}, ${fmtSeconds(stop.at - plan.start)} into the record)`, text: fillTour(stop.caption, tour.values(stop, store, plan, data)) });
  });
  engine.seek(engine.end);
  return { plan, lines, checks: tour.check(plan, quoted, store, data, metrics) };
}
