import type { FailingTest, FirstRed, TestCounts } from "@fire_trident/core";
import { certCounts } from "../certs.ts";
import { fmtInt, fmtMs, plural, shortSha } from "../format.ts";
import type { Moment, Timeline } from "../replay.ts";
import type { ColonyStore } from "../store.ts";
import { checkTour, fmtSeconds, loadTourSteps, planTour, settledBy, type ColonyTour, type MetricsReport, type TourCheck, type TourData, type TourPlan, type TourStop } from "./tour.ts";
import raw from "./firstRed.json" with { type: "json" };

/**
 * The tour of the first-red colony (/c/first-red?tour=1): a small project certified green, six changes landed while
 * certification was held and one of them broke a test, certification went red, the first red search ran the failing
 * test alone at earlier commits and named the landing, a scripted repair landed and trunk certified green again. Each
 * step stands on an event of the colony's record (its `certify`, `landing` and `bisect` events); the numbers come from
 * the record and are checked against the public certifications list (GET /certifications) and the metrics endpoint.
 */

/** The moments of a first red run (firstRed.json stands its steps on them). */
export const FIRST_RED_MOMENTS: readonly string[] = ["@start", "@green", "@held", "@red", "@search", "@repair", "@repair-landed", "@green-again", "@end"];

/** The public reads the tour needs: the certification results (newest first), for the repair intent's id and the check. */
export const FIRST_RED_READS: Readonly<Record<string, string>> = { certifications: "/certifications?limit=50" };

const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];
const WHY_QUOTE_CHARS = 220;
const ERROR_CHARS = 120;

type Json = Record<string, unknown>;
const isObj = (x: unknown): x is Json => typeof x === "object" && x !== null && !Array.isArray(x);
const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
const str = (x: unknown): string => (typeof x === "string" ? x : "");
const unique = (list: readonly string[]): string[] => [...new Set(list.filter((p) => p !== ""))];

/** "the fourth" of the held landings, or "one" when its position is unknown. */
function ordinal(position: number | null): string {
  if (position === null || position < 1) return "one";
  return ORDINALS[position - 1] ?? `${fmtInt(position)}th`;
}

/** "src/a.ts", "src/a.ts and src/b.ts", "src/a.ts, src/b.ts and 3 more". */
function fileList(paths: readonly string[]): string {
  if (!paths.length) return "a file";
  if (paths.length <= 2) return paths.join(" and ");
  return `${paths[0]}, ${paths[1]} and ${fmtInt(paths.length - 2)} more`;
}

/** Text written by agents or the repository on one line, cut to `n` characters. */
function clip(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}

/** One certification result as the record shows it (a `certify` event with a status other than running). */
interface Result {
  index: number;
  at: number;
  sha: string;
  status: string;
  counts: TestCounts | null;
  failing: FailingTest[];
  durationMs: number | null;
}

/** One landing that carried proposals, with what the record knows of them. */
interface Commit {
  index: number;
  at: number;
  landingId: string;
  sha: string;
  paths: string[];
  proposalIds: string[];
  intentIds: string[];
  agentIds: string[];
}

/** What the record shows of the run (and, for the repair intent's id, the certifications list); the parts it lacks are null. */
interface Facts {
  green: Result | null;
  /** The landings between the green result and the red one, in order. */
  held: Commit[];
  red: Result | null;
  /** The `bisect` event that ended the search for the red result. */
  search: { index: number; at: number; firstRed: FirstRed } | null;
  /** The search's answer: the record's, else the certifications list's. */
  firstRed: FirstRed | null;
  /** The landing the answer names, when it is one of the held ones, with its position among them (from 1). */
  broke: { commit: Commit; position: number } | null;
  repairIntentId: string | null;
  /** The repair intent's events: its declaration, and an agent taking it. */
  repairOpened: number | null;
  repairClaimed: number | null;
  repairFootprint: string[];
  /** The first landing after the red result that carried the repair intent. */
  repairLanding: Commit | null;
  greenAgain: Result | null;
}

/** The results of GET /certifications, newest first, as far as the tour reads them. */
function certResults(data: TourData): Json[] {
  const certs = data["certifications"];
  return isObj(certs) && Array.isArray(certs.results) ? certs.results.filter(isObj) : [];
}

/** The red result the tour is about: the newest whose first red search found a commit, else the newest red one. */
function listedRed(results: readonly Json[]): Json | null {
  return results.find((r) => r.status === "red" && isObj(r.firstRed) && r.firstRed.status === "found") ?? results.find((r) => r.status === "red") ?? null;
}

/** A FirstRed from the API's JSON, checked field by field (older or odd data is left out); null unless it found a commit. */
function firstRedOf(x: unknown): FirstRed | null {
  if (!isObj(x) || x.status !== "found" || typeof x.trunkSha !== "string" || typeof x.landingId !== "string") return null;
  const probes = num(x.probes);
  const ms = num(x.ms);
  if (probes === null || ms === null) return null;
  const out: FirstRed = { status: "found", trunkSha: x.trunkSha, landingId: x.landingId, probes, ms };
  if (Array.isArray(x.intents)) out.intents = x.intents.filter(isObj).filter((i) => typeof i.id === "string").map((i) => ({ id: i.id as string, ...(typeof i.title === "string" ? { title: i.title } : {}) }));
  if (Array.isArray(x.proposals)) {
    out.proposals = x.proposals
      .filter(isObj)
      .filter((p) => typeof p.id === "string")
      .map((p) => ({
        id: p.id as string,
        paths: Array.isArray(p.paths) ? p.paths.filter((q): q is string => typeof q === "string") : [],
        ...(typeof p.intentId === "string" ? { intentId: p.intentId } : {}),
        ...(typeof p.title === "string" ? { title: p.title } : {}),
      }));
  }
  const landings = num(x.landings);
  if (landings !== null) out.landings = landings;
  if (typeof x.greenSha === "string") out.greenSha = x.greenSha;
  return out;
}

const MEMO = new WeakMap<Timeline, { data: TourData; facts: Facts }>();

/** The facts of the run, read once per record and data. */
function factsOf(timeline: Timeline, data: TourData): Facts {
  const hit = MEMO.get(timeline);
  if (hit && hit.data === data) return hit.facts;
  const facts = readFacts(timeline, data);
  MEMO.set(timeline, { data, facts });
  return facts;
}

function readFacts(timeline: Timeline, data: TourData): Facts {
  const ev = timeline.events;
  const at = (i: number): number => timeline.times[i] ?? 0;
  const proposals = new Map<string, { intentId: string; agentId: string }>();
  const footprints = new Map<string, string[]>();
  const results: Result[] = [];
  const commits: Commit[] = [];
  ev.forEach((e, i) => {
    if (e.t === "proposal") proposals.set(e.proposalId, { intentId: str(e.intentId), agentId: str(e.agentId) });
    else if (e.t === "intent" && Array.isArray(e.footprint) && e.footprint.length) footprints.set(e.intentId, e.footprint);
    else if (e.t === "certify" && typeof e.trunkSha === "string" && e.status !== "running") {
      results.push({ index: i, at: at(i), sha: e.trunkSha, status: e.status, counts: e.counts ?? null, failing: Array.isArray(e.failing) ? e.failing : [], durationMs: num(e.durationMs) });
    } else if (e.t === "landing" && Array.isArray(e.proposalIds) && e.proposalIds.length) {
      const known = e.proposalIds.map((id) => proposals.get(id));
      commits.push({
        index: i,
        at: at(i),
        landingId: str(e.landingId),
        sha: str(e.trunkSha),
        paths: Array.isArray(e.paths) ? e.paths : [],
        proposalIds: e.proposalIds,
        intentIds: unique(known.map((p) => p?.intentId ?? "")),
        agentIds: unique(known.map((p) => p?.agentId ?? "")),
      });
    }
  });
  const listed = listedRed(certResults(data));
  const listedSha = str(listed?.trunkSha);
  const green = results.find((r) => r.status === "green") ?? null;
  const after = (r: Result, from: Result | null): boolean => from === null || r.index > from.index;
  // The red result the tour tells: the one the certifications list leads with when the record holds it, else the first after green.
  const red = results.find((r) => r.status === "red" && r.sha === listedSha && after(r, green)) ?? results.find((r) => r.status === "red" && after(r, green)) ?? null;
  const held = red ? commits.filter((c) => (green === null || c.index > green.index) && c.index < red.index) : [];
  let search: Facts["search"] = null;
  if (red) {
    for (let i = red.index + 1; i < ev.length; i++) {
      const e = ev[i];
      if (e?.t !== "bisect" || e.trunkSha !== red.sha) continue;
      const fr = firstRedOf(e.firstRed);
      search = { index: i, at: at(i), firstRed: fr ?? (isObj(e.firstRed) ? (e.firstRed as unknown as FirstRed) : { status: "inconclusive", probes: 0, ms: 0 }) };
      break;
    }
  }
  const firstRed = (search?.firstRed.status === "found" ? search.firstRed : null) ?? (listed && listedSha === red?.sha ? firstRedOf(listed.firstRed) : null);
  const brokeAt = firstRed?.landingId ? held.findIndex((c) => c.landingId === firstRed.landingId) : -1;
  const broke = brokeAt >= 0 ? { commit: held[brokeAt] as Commit, position: brokeAt + 1 } : null;
  // The repair intent: the one the red result declared (the list says), else the first intent opened after the result.
  let repairIntentId: string | null = listed && listedSha === red?.sha && typeof listed.repairIntentId === "string" && listed.repairIntentId ? listed.repairIntentId : null;
  let repairOpened: number | null = null;
  let repairClaimed: number | null = null;
  if (red) {
    for (let i = red.index + 1; i < ev.length; i++) {
      const e = ev[i];
      if (e?.t !== "intent") continue;
      if (repairIntentId === null && e.status === "open") repairIntentId = e.intentId;
      if (e.intentId !== repairIntentId) continue;
      if (e.status === "open" && repairOpened === null) repairOpened = i;
      if (e.status === "claimed" && repairClaimed === null) repairClaimed = i;
    }
  }
  const repairLanding = red && repairIntentId ? (commits.find((c) => c.index > red.index && c.intentIds.includes(repairIntentId as string)) ?? null) : null;
  const greenAgain = red ? (results.find((r) => r.status === "green" && r.index > red.index) ?? null) : null;
  return {
    green,
    held,
    red,
    search,
    firstRed,
    broke,
    repairIntentId,
    repairOpened,
    repairClaimed,
    repairFootprint: repairIntentId ? (footprints.get(repairIntentId) ?? []) : [],
    repairLanding,
    greenAgain,
  };
}

/** The paths the answer says the breaking landing changed under the failing tests, else every path it changed. */
function brokePaths(f: Facts): string[] {
  const named = unique((f.firstRed?.proposals ?? []).flatMap((p) => p.paths));
  return named.length ? named : (f.broke?.commit.paths ?? []);
}

/** Failing and cancelled tests of a result. */
function failures(r: Result | null): number {
  if (!r) return 0;
  return r.counts ? r.counts.fail + r.counts.cancelled : r.failing.length;
}

/** A test's own name: the last part of "suite > test". */
function leafName(name: string): string {
  const parts = name.split(" > ");
  return parts[parts.length - 1] ?? name;
}

/** "“subtracts”", "“subtracts” and “adds”", "“subtracts” and 2 more tests". */
function failingNames(r: Result | null): string {
  const names = unique((r?.failing ?? []).map((t) => leafName(str(t.name))));
  if (!names.length) return "the tests";
  if (names.length === 1) return `“${names[0]}”`;
  if (names.length === 2) return `“${names[0]}” and “${names[1]}”`;
  return `“${names[0]}” and ${fmtInt(names.length - 1)} more tests`;
}

/** "1/1 tests pass", or "" without counts. */
function testsLine(r: Result | null): string {
  return r?.counts ? certCounts({ counts: r.counts }, "pass") : "";
}

/** A moment of the record for a landing (what settledBy reads). */
function landingMoment(c: Commit, name: string): Moment {
  return { name, at: c.at, index: c.index, paths: c.paths, proposalIds: c.proposalIds };
}

/** An agent's name as the page shows it, else its id, else what to call an unknown one. */
function agentName(store: ColonyStore, id: string | undefined, fallback: string): string {
  if (!id) return fallback;
  return store.agentNames.get(id) ?? store.agents.get(id)?.name ?? id;
}

/**
 * The sentence of a repair intent's why that names the first failing commit ("First failing commit: the failing tests
 * first failed at commit … (found in 3 test runs)", written by certify/bisect.ts withFirstRed, without its final stop
 * so the caption's own closes it), else "".
 */
export function firstRedSentence(why: string | undefined): string {
  const line = (why ?? "").split("\n").find((l) => l.startsWith("First failing commit:"));
  if (!line) return "";
  const end = line.indexOf("). ");
  return end > 0 ? line.slice(0, end + 1) : clip(line, WHY_QUOTE_CHARS).replace(/\.$/, "");
}

/** Find a moment of the first red run in its record. */
function findFirstRed(name: string, timeline: Timeline, f: Facts): Moment | null {
  const n = timeline.length;
  if (!n) return null;
  const moment = (index: number, extra: Partial<Moment> = {}): Moment => ({ name, at: timeline.times[index] ?? 0, index, paths: [], proposalIds: [], ...extra });
  switch (name) {
    case "@start":
      return moment(0);
    case "@end":
      return moment(n - 1);
    case "@green":
      return f.green ? moment(f.green.index) : null;
    case "@held": {
      // The step stands on the last held landing and is about the one that broke the tests.
      const last = f.held[f.held.length - 1];
      if (!last) return null;
      const about = f.broke?.commit ?? last;
      return moment(last.index, { paths: about.paths, proposalIds: about.proposalIds, count: f.held.length });
    }
    case "@red":
      return f.red ? moment(f.red.index, { paths: unique(f.red.failing.map((t) => str(t.file))), count: failures(f.red) }) : null;
    case "@search":
      return f.search ? moment(f.search.index, { paths: brokePaths(f), proposalIds: (f.firstRed?.proposals ?? []).map((p) => p.id), count: f.firstRed?.probes ?? f.search.firstRed.probes }) : null;
    case "@repair": {
      const i = f.repairClaimed ?? f.repairOpened;
      return i !== null ? moment(i, { paths: f.repairFootprint }) : null;
    }
    case "@repair-landed":
      return f.repairLanding ? moment(f.repairLanding.index, { paths: f.repairLanding.paths, proposalIds: f.repairLanding.proposalIds }) : null;
    case "@green-again":
      return f.greenAgain ? moment(f.greenAgain.index) : null;
    default:
      return null;
  }
}

/** Every value a first red caption can name, from the record's facts and the store standing at the stop. */
export function firstRedValues(stop: TourStop, store: ColonyStore, plan: TourPlan, data: TourData): Record<string, string> {
  const f = factsOf(plan.timeline, data);
  const fr = f.firstRed;
  const brokeIntentId = fr?.proposals?.[0]?.intentId ?? fr?.intents?.[0]?.id ?? f.broke?.commit.intentIds[0];
  const brokeTitle = fr?.proposals?.[0]?.title ?? fr?.intents?.[0]?.title ?? (brokeIntentId ? store.intents.get(brokeIntentId)?.title : undefined) ?? "";
  const repair = f.repairIntentId ? store.intents.get(f.repairIntentId) : undefined;
  const repairWhy = firstRedSentence(repair?.why);
  const firstHeld = f.held[0];
  const lastHeld = f.held[f.held.length - 1];
  const redAt = f.red?.at ?? 0;
  const error = clip(str(f.red?.failing[0]?.error), ERROR_CHARS);
  return {
    colony: store.colonyId,
    greenSha: shortSha(f.green?.sha),
    greenTests: testsLine(f.green) || "its tests passed",
    greenMs: fmtMs(f.green?.durationMs ?? 0),
    heldLandings: plural(f.held.length, "change"),
    heldCommits: plural(f.held.length, "commit"),
    heldSpan: fmtSeconds(firstHeld && lastHeld ? lastHeld.at - firstHeld.at : 0),
    brokeOrdinal: ordinal(f.broke?.position ?? null),
    brokeIntent: brokeTitle ? `“${brokeTitle}”` : "an intent without a title",
    brokeFile: fileList(brokePaths(f)),
    brokeSha: shortSha(fr?.trunkSha ?? f.broke?.commit.sha),
    brokeLanding: fr?.landingId ?? f.broke?.commit.landingId ?? "an unnamed landing",
    brokeProposal: fr?.proposals?.[0]?.id ?? f.broke?.commit.proposalIds[0] ?? "an unnamed proposal",
    redSha: shortSha(f.red?.sha),
    redAfterGreen: fmtSeconds(f.red && f.green ? f.red.at - f.green.at : 0),
    redMs: fmtMs(f.red?.durationMs ?? 0),
    failing: plural(failures(f.red), "test"),
    failingNames: failingNames(f.red),
    failingError: error ? ` (${error})` : "",
    runs: plural(fr?.probes ?? f.search?.firstRed.probes ?? 0, "test run"),
    searchMs: fmtMs(fr?.ms ?? f.search?.firstRed.ms ?? 0),
    sinceGreen: plural(fr?.landings ?? f.held.length, "landing"),
    repairTitle: repair?.title ?? "the repair intent",
    repairAgent: agentName(store, repair?.assignedTo ?? f.repairLanding?.agentIds[0], "An agent"),
    repairWhyLine: repairWhy ? `, whose why names the commit: “${repairWhy}”` : "",
    repairFile: fileList(f.repairLanding?.paths ?? []),
    repairSettledBy: f.repairLanding ? settledBy(landingMoment(f.repairLanding, "@repair-landed"), store) : "its checks",
    afterRed: fmtSeconds(f.repairLanding ? f.repairLanding.at - redAt : 0),
    greenAgainSha: shortSha(f.greenAgain?.sha),
    greenAgainTests: testsLine(f.greenAgain) || "its tests pass again",
    greenAfterRed: fmtSeconds(f.greenAgain ? f.greenAgain.at - redAt : 0),
  };
}

/** The numbers (and ids) a first red stop quotes, unformatted, for the check against the certifications list. */
export function firstRedNumbers(stop: TourStop, _store: ColonyStore, plan: TourPlan, data: TourData): Record<string, number | string> {
  const f = factsOf(plan.timeline, data);
  const fr = f.firstRed;
  switch (stop.moment.name) {
    case "@green":
      return { tests: f.green?.counts?.tests ?? 0, passing: f.green?.counts?.pass ?? 0 };
    case "@held":
      return { heldLandings: f.held.length };
    case "@red":
      return { failing: failures(f.red) };
    case "@search":
      return { runs: fr?.probes ?? 0, searchMs: fr?.ms ?? 0, sinceGreen: fr?.landings ?? f.held.length, brokeLanding: fr?.landingId ?? "", brokeCommit: shortSha(fr?.trunkSha) };
    case "@repair-landed":
      return { afterRedMs: f.repairLanding && f.red ? f.repairLanding.at - f.red.at : 0 };
    case "@green-again":
      return { greenAfterRedMs: f.greenAgain && f.red ? f.greenAgain.at - f.red.at : 0, passing: f.greenAgain?.counts?.pass ?? 0, tests: f.greenAgain?.counts?.tests ?? 0 };
    default:
      return {};
  }
}

/**
 * Compare what the first red tour quotes with the public certifications list: the search's test runs, time and
 * landings since green, the landing it named, the failing tests on the red commit, the tests passing when green again
 * and the time from the red result to the green one (within half a second); then, like every tour, the end of the
 * record against the metrics endpoint.
 */
export function firstRedCheck(plan: TourPlan, quoted: ReadonlyArray<Record<string, number | string>>, end: ColonyStore, data: TourData, metrics: MetricsReport): TourCheck[] {
  const out: TourCheck[] = [];
  const q = (name: string): Record<string, number | string> | undefined => {
    const i = plan.stops.findIndex((s) => s.moment.name === name);
    return i >= 0 ? quoted[i] : undefined;
  };
  const results = certResults(data);
  const f = factsOf(plan.timeline, data);
  const red = results.find((r) => r.status === "red" && r.trunkSha === f.red?.sha) ?? listedRed(results);
  const redStart = num(red?.startedAt);
  const greens = redStart === null ? [] : results.filter((r) => r.status === "green" && (num(r.startedAt) ?? Number.NEGATIVE_INFINITY) > redStart);
  const greenAgain = greens[greens.length - 1];
  const fr = red && isObj(red.firstRed) ? red.firstRed : null;
  const show = (v: number | string | undefined | null): string => (v === undefined || v === null ? "absent" : typeof v === "number" ? fmtInt(v) : v);
  const same = (name: string, tour: number | string | undefined, api: number | string | null | undefined, fmt: (v: number | string) => string = show) => {
    if (tour === undefined) return;
    const ok = api !== undefined && api !== null && tour === api;
    out.push({ name, tour: fmt(tour), metrics: api === undefined || api === null ? "absent" : fmt(api), ok });
  };
  const search = q("@search");
  if (search) {
    same("test runs the search used", search.runs, num(fr?.probes));
    same("search time (ms)", search.searchMs, num(fr?.ms));
    same("landings since green", search.sinceGreen, num(fr?.landings));
    same("the landing that broke the tests", search.brokeLanding, typeof fr?.landingId === "string" ? fr.landingId : null);
  }
  const redQ = q("@red");
  const redCounts = isObj(red?.counts) ? red.counts : null;
  if (redQ) same("failing tests on the red commit", redQ.failing, redCounts ? (num(redCounts.fail) ?? 0) + (num(redCounts.cancelled) ?? 0) : null);
  const again = q("@green-again");
  if (again) {
    const counts = isObj(greenAgain?.counts) ? greenAgain.counts : null;
    same("tests passing when green again", again.passing, counts ? num(counts.pass) : null);
    const from = num(red?.finishedAt) ?? redStart;
    const to = num(greenAgain?.finishedAt) ?? num(greenAgain?.startedAt);
    const tourMs = typeof again.greenAfterRedMs === "number" ? again.greenAfterRedMs : 0;
    if (from !== null && to !== null) {
      const ms = to - from;
      out.push({ name: "red to green", tour: fmtSeconds(tourMs), metrics: fmtSeconds(ms), ok: Math.abs(tourMs - ms) <= 500, note: `${Math.round(tourMs - ms)} ms apart` });
    } else out.push({ name: "red to green", tour: fmtSeconds(tourMs), metrics: "absent", ok: false, note: "the certifications list has no green result after the red one" });
  }
  out.push(...checkTour(plan, null, null, end, metrics));
  return out;
}

const STEPS = loadTourSteps(raw, new Set(FIRST_RED_MOMENTS));

/** The first-red colony's tour. */
export const FIRST_RED_TOUR: ColonyTour = {
  id: "first-red",
  about: "Certification goes red, the search names the landing that broke the test, the repair lands and trunk is green again, told from the colony's record",
  steps: STEPS,
  reads: FIRST_RED_READS,
  plan: (timeline, _store, data, source) => planTour(STEPS, timeline, { source, find: (name) => findFirstRed(name, timeline, factsOf(timeline, data)) }),
  values: firstRedValues,
  numbers: firstRedNumbers,
  check: firstRedCheck,
};
