/**
 * Check the tour of a finished run (/c/<colony>?tour=1) against the colony's own metrics endpoint. It reads the colony,
 * its whole event record and its metrics with public GET requests only, replays the record through the same replay
 * engine and store the web page uses, plans the tour from packages/web/src/tour/tour.json, prints each step's moment
 * and sentence as the tour shows it, then compares the numbers the steps quote with GET /api/colonies/<id>/metrics:
 * the violations the rule found, how many were fixed and how long that took (convergence, within half a second), and
 * at the end of the record the violations, the funnel per stage, the landings and the intents landed.
 *
 * Usage:
 *   node --experimental-transform-types scripts/tour_check.ts --url https://<deployment> --colony hono
 *
 * Exits 0 when every number agrees, 1 when one differs, 2 on a usage or network error.
 */
import { readFileSync } from "node:fs";
import type { ColonySnapshot, EventsPage, RecordedEvent } from "@fire_trident/core";
import { FieldSynth, ReplayEngine, Timeline, startingPoint } from "../packages/web/src/replay.ts";
import { ColonyStore } from "../packages/web/src/store.ts";
import { checkTour, fillTour, fmtSeconds, loadTourSteps, planTour, tourNumbers, tourValues, type MetricsReport, type TourNumbers } from "../packages/web/src/tour/tour.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const BASE = (arg("url") ?? process.env.FT_URL ?? "").replace(/\/+$/, "");
const COLONY = arg("colony") ?? "";
if (!/^https?:\/\//.test(BASE) || !COLONY) {
  console.error("usage: node --experimental-transform-types scripts/tour_check.ts --url https://<deployment> --colony <id>");
  process.exit(2);
}

async function get<T>(suffix: string): Promise<T> {
  const url = `${BASE}/api/colonies/${encodeURIComponent(COLONY)}${suffix}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`GET ${url} answered ${res.status}`);
  return (await res.json()) as T;
}

async function main(): Promise<number> {
  const [snap, metrics] = await Promise.all([get<ColonySnapshot>(""), get<MetricsReport>("/metrics")]);
  const events: RecordedEvent[] = [];
  let source: "recorded" | "reconstructed" = "recorded";
  for (let after = 0; ; ) {
    const page = await get<EventsPage>(`/events?after=${after}&limit=5000`);
    source = page.source;
    events.push(...(page.events ?? []));
    if (page.next === null || page.next === undefined || !page.events?.length) break;
    after = page.next;
  }
  if (!events.length) throw new Error(`colony ${COLONY} has no events to replay`);

  const store = new ColonyStore(COLONY);
  const timeline = new Timeline(events);
  const { snapshot, newFiles } = startingPoint(snap, timeline);
  const priorities = new Map((snap.intents ?? []).map((i) => [i.id, Number.isFinite(i.priority) ? i.priority : 1]));
  const engine = new ReplayEngine(store, timeline, snapshot, newFiles, new FieldSynth((id) => priorities.get(id) ?? 1));
  engine.begin();
  const steps = loadTourSteps(JSON.parse(readFileSync(new URL("../packages/web/src/tour/tour.json", import.meta.url), "utf8")));
  const plan = planTour(steps, timeline, { rules: [...store.rules.values()], known: new Set(store.files.map((f) => f.path)), source });

  console.log(`Tour of ${COLONY} (${source} record, ${timeline.length.toLocaleString("en-US")} events, rule ${plan.ruleAt === null ? "none" : new Date(plan.ruleAt).toISOString()})`);
  let rule: TourNumbers | null = null;
  let converged: TourNumbers | null = null;
  plan.stops.forEach((stop, i) => {
    engine.seek(stop.at);
    const numbers = tourNumbers(stop, store, plan);
    if (stop.step.id === "rule" && stop.moment.name === "@rule") rule = numbers;
    if (stop.moment.name === "@converged") converged = numbers;
    const label = `${i + 1}/${plan.stops.length} ${stop.kicker} (${stop.moment.name}, ${fmtSeconds(stop.at - plan.start)} into the record)`;
    console.log(`\n${label}\n  ${fillTour(stop.caption, tourValues(stop, store, plan))}`);
  });

  engine.seek(engine.end);
  const checks = checkTour(plan, rule, converged, store, metrics);
  console.log("\nAgainst GET /metrics:");
  for (const c of checks) console.log(`  ${c.ok ? "ok  " : "DIFF"} ${c.name}: tour ${c.tour}, metrics ${c.metrics}${c.note ? ` (${c.note})` : ""}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n${failed} of ${checks.length} numbers differ.` : `\nAll ${checks.length} numbers agree.`);
  return failed ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`tour_check: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  },
);
