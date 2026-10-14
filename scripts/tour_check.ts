/**
 * Check a colony's tour (/c/<colony>?tour=1) against the colony's own public API. It reads the colony, its agents, its
 * whole event record, its metrics and the tour's own reads (the certifications list for first-red; the review queue and
 * the snapshot for order-backend) with public GET requests only, replays the record through the same replay engine and
 * store the web page uses, plans the tour (packages/web/src/tour: tour.json for hono and any colony without a tour of
 * its own, firstRed.json, orderBackend.json), prints each step's moment and sentence as the tour shows it, then compares
 * the numbers the steps quote with the API. For hono: the violations the rule found, how many were fixed and how long
 * that took (convergence, within half a second), and at the end of the record the violations, the funnel per stage, the
 * landings and the intents landed, against GET /metrics. For first-red: the search's test runs, time and landings since
 * green, the landing it named, the failing tests, the tests passing when green again and the time from the red result
 * to the green one (within half a second), against GET /certifications, then the end of the record against GET /metrics.
 * For order-backend: the changes waiting for a person and the landing and the lines each would undo against GET /review,
 * the goals against the snapshot, the review queue and the end of the record against GET /metrics.
 *
 * Usage:
 *   node --experimental-transform-types scripts/tour_check.ts --url https://<deployment> --colony hono
 *   node --experimental-transform-types scripts/tour_check.ts --url https://<deployment> --colony first-red
 *   node --experimental-transform-types scripts/tour_check.ts --url https://<deployment> --colony order-backend
 *   node --experimental-transform-types scripts/tour_check.ts --url https://<deployment> --colony <id> --tour first-red
 *     (another colony with the same shape, such as a preview run of the first-red demo, told with that tour)
 *
 * Exits 0 when every number agrees, 1 when one differs, 2 on a usage or network error.
 */
import type { AgentKind, ColonySnapshot, EventsPage, RecordedEvent } from "@fire_trident/core";
import { FieldSynth, ReplayEngine, Timeline, startingPoint } from "../packages/web/src/replay.ts";
import { ColonyStore } from "../packages/web/src/store.ts";
import type { MetricsReport } from "../packages/web/src/tour/tour.ts";
import { loadTourData, runTourCheck, tourFor, tourIds } from "../packages/web/src/tour/tours.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const BASE = (arg("url") ?? process.env.FT_URL ?? "").replace(/\/+$/, "");
const COLONY = arg("colony") ?? "";
const SCRIPT = arg("tour");
if (!/^https?:\/\//.test(BASE) || !COLONY) {
  console.error("usage: node --experimental-transform-types scripts/tour_check.ts --url https://<deployment> --colony <id> [--tour <id>]");
  process.exit(2);
}
const tour = tourFor(COLONY, SCRIPT);
if (SCRIPT && tour.id !== SCRIPT) {
  console.error(`no tour is named ${SCRIPT}: the tours are ${tourIds().join(", ")}`);
  process.exit(2);
}

async function get<T>(suffix: string): Promise<T> {
  const url = `${BASE}/api/colonies/${encodeURIComponent(COLONY)}${suffix}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`GET ${url} answered ${res.status}`);
  return (await res.json()) as T;
}

async function main(): Promise<number> {
  const [snap, metrics, agents] = await Promise.all([
    get<ColonySnapshot>(""),
    get<MetricsReport>("/metrics"),
    get<{ agents?: Array<{ id: string; name?: string; kind?: AgentKind }> }>("/agents?all=1&journal=0&limit=10000").catch(() => ({ agents: [] })),
  ]);
  const data = await loadTourData(tour, (suffix) => get<unknown>(suffix));
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

  // The store as the page loads it: the agents' names, and what the snapshot knows of the intents (their origin and why).
  const store = new ColonyStore(COLONY);
  for (const a of agents.agents ?? []) {
    if (!a || typeof a.id !== "string") continue;
    if (a.name) store.agentNames.set(a.id, a.name);
    if (a.kind) store.agentKinds.set(a.id, a.kind);
  }
  store.learnIntents(snap.intents ?? []);
  const timeline = new Timeline(events);
  const { snapshot, newFiles } = startingPoint(snap, timeline);
  const priorities = new Map((snap.intents ?? []).map((i) => [i.id, Number.isFinite(i.priority) ? i.priority : 1]));
  const engine = new ReplayEngine(store, timeline, snapshot, newFiles, new FieldSynth((id) => priorities.get(id) ?? 1));
  const run = runTourCheck(tour, engine, data, metrics, source);
  const missing = Object.entries(tour.reads).filter(([name]) => data[name] === null).map(([, suffix]) => suffix);

  const which = tour.id === COLONY ? "its own tour" : `the ${tour.id} tour`;
  console.log(`Tour of ${COLONY} (${which}; ${source} record, ${timeline.length.toLocaleString("en-US")} events, rule ${run.plan.ruleAt === null ? "none" : new Date(run.plan.ruleAt).toISOString()})`);
  if (missing.length) console.log(`  (could not read ${missing.join(", ")}: the steps that need it say less, and their numbers cannot be checked)`);
  for (const line of run.lines) console.log(`\n${line.label}\n  ${line.text}`);
  console.log("\nAgainst the API:");
  for (const c of run.checks) console.log(`  ${c.ok ? "ok  " : "DIFF"} ${c.name}: tour ${c.tour}, api ${c.metrics}${c.note ? ` (${c.note})` : ""}`);
  const failed = run.checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n${failed} of ${run.checks.length} numbers differ.` : `\nAll ${run.checks.length} numbers agree.`);
  return failed ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`tour_check: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  },
);
