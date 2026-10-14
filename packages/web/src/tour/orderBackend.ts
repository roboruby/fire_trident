import { fmtInt, plural } from "../format.ts";
import type { Moment, Timeline } from "../replay.ts";
import type { ColonyStore } from "../store.ts";
import { checkTour, fmtSeconds, loadTourSteps, planTour, settledBy, type ColonyTour, type MetricsReport, type TourCheck, type TourData, type TourPlan, type TourStop } from "./tour.ts";
import raw from "./orderBackend.json" with { type: "json" };

/**
 * The tour of the order-backend colony (/c/order-backend?tour=1): one file seeded in one language, three agents each
 * moving it to another, the first change landing, the second and third waiting for a person because each would undo
 * that landing (the goal-conflict check, FT_GOAL_CONFLICT), and the review queue still holding them, or what a person
 * decided. Each step stands on an event of the colony's record; the reasons are quoted from its `proposal` events and
 * checked against the public review queue (GET /review), the snapshot and the metrics endpoint.
 */

/** The moments of a goal-conflict run (orderBackend.json stands its steps on them). */
export const ORDER_BACKEND_MOMENTS: readonly string[] = ["@start", "@seed", "@goals", "@first-port", "@held-1", "@held-2", "@held-3", "@end"];

/** The public reads the tour needs: the review queue (what still waits for a person) and the snapshot (the goals' whys and the check). */
export const ORDER_BACKEND_READS: Readonly<Record<string, string>> = { review: "/review", snapshot: "" };

/** A reason the goal-conflict check wrote: "would undo 5 lines in src/backend.ts that landing lnd_1 wrote 3 seconds ago for intent "…"". */
const WOULD_UNDO = /would undo (\d+) lines? in .*? that landing (\S+) wrote/;
/** The part of such a reason the tour quotes: through the intent's title, before its why. */
const QUOTE = /would undo .*? for intent "[^"]*"/;
const REASON_CHARS = 200;
/** Decisions a person takes on a change waiting in the review queue. */
const DECISIONS: ReadonlySet<string> = new Set(["approve", "reject", "return"]);

type Json = Record<string, unknown>;
const isObj = (x: unknown): x is Json => typeof x === "object" && x !== null && !Array.isArray(x);
const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
const str = (x: unknown): string => (typeof x === "string" ? x : "");
const unique = (list: readonly string[]): string[] => [...new Set(list.filter((p) => p !== ""))];

/** "src/a.ts", "src/a.ts and src/b.ts", "src/a.ts, src/b.ts and 3 more". */
function fileList(paths: readonly string[]): string {
  if (!paths.length) return "a file";
  if (paths.length <= 2) return paths.join(" and ");
  return `${paths[0]}, ${paths[1]} and ${fmtInt(paths.length - 2)} more`;
}

/** "a", "a and b", "a, b and c". */
function listed(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** Text written by agents on one line, cut to `n` characters. */
function clip(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}

/** "Go" for an intent titled "Move the order backend to Go"; null when the title names no language that way. */
export function languageOf(title: string): string | null {
  const m = /\bto ([A-Z][\w+#.-]*)$/.exec(title.trim());
  return m?.[1] ?? null;
}

/** "the Go version" for such a title; any other title quoted whole. */
function versionOf(title: string): string {
  const lang = languageOf(title);
  return lang ? `the ${lang} version` : `“${title}”`;
}

/** The part of a goal-conflict reason worth quoting: the lines, the file, the landing and the intent it would undo. */
export function quoteReason(reason: string): string {
  const m = QUOTE.exec(reason);
  if (m) return m[0];
  return clip(reason.replace(/^escalated by [^:]+: /, ""), REASON_CHARS);
}

/** One landing that carried proposals, with what the record knows of them. */
interface Commit {
  index: number;
  at: number;
  landingId: string;
  paths: string[];
  proposalIds: string[];
  intentIds: string[];
  agentIds: string[];
}

/** One change the goal-conflict check sent to a person, as its `proposal` event says. */
interface Held {
  index: number;
  at: number;
  proposalId: string;
  intentId: string;
  agentId: string;
  reason: string;
  /** The landing and the lines the reason names, when it reads as the check writes it. */
  undoesLanding: string | null;
  lines: number | null;
}

/** What the record shows of the run; the parts it lacks are null or empty. */
interface Facts {
  /** The first landing: the file seeded in its first language. */
  seed: Commit | null;
  /** The conflicting goals: the intents of the first landing after the seed and of every held change, in declaration order. */
  goals: string[];
  /** The event that declared the last of them. */
  goalsDeclared: number | null;
  /** The first landing after the seed: the goal that landed. */
  firstPort: Commit | null;
  held: Held[];
}

const MEMO = new WeakMap<Timeline, Facts>();

/** The facts of the run, read once per record. */
function factsOf(timeline: Timeline): Facts {
  let facts = MEMO.get(timeline);
  if (!facts) {
    facts = readFacts(timeline);
    MEMO.set(timeline, facts);
  }
  return facts;
}

function readFacts(timeline: Timeline): Facts {
  const ev = timeline.events;
  const at = (i: number): number => timeline.times[i] ?? 0;
  const proposals = new Map<string, { intentId: string; agentId: string }>();
  const opened = new Map<string, number>();
  const commits: Commit[] = [];
  const held: Held[] = [];
  const seen = new Set<string>();
  ev.forEach((e, i) => {
    if (e.t === "intent") {
      if (e.status === "open" && !opened.has(e.intentId)) opened.set(e.intentId, i);
    } else if (e.t === "proposal") {
      proposals.set(e.proposalId, { intentId: str(e.intentId), agentId: str(e.agentId) });
      const reason = str(e.reason);
      if (e.status === "escalated" && WOULD_UNDO.test(reason) && !seen.has(e.proposalId)) {
        seen.add(e.proposalId);
        const m = WOULD_UNDO.exec(reason);
        held.push({ index: i, at: at(i), proposalId: e.proposalId, intentId: str(e.intentId), agentId: str(e.agentId), reason, undoesLanding: m?.[2] ?? null, lines: m?.[1] ? Number(m[1]) : null });
      }
    } else if (e.t === "landing" && Array.isArray(e.proposalIds) && e.proposalIds.length) {
      const known = e.proposalIds.map((id) => proposals.get(id));
      commits.push({ index: i, at: at(i), landingId: str(e.landingId), paths: Array.isArray(e.paths) ? e.paths : [], proposalIds: e.proposalIds, intentIds: unique(known.map((p) => p?.intentId ?? "")), agentIds: unique(known.map((p) => p?.agentId ?? "")) });
    }
  });
  const seed = commits[0] ?? null;
  const firstPort = commits[1] ?? null;
  const goals = unique([...(firstPort?.intentIds ?? []), ...held.map((h) => h.intentId)]).sort((a, b) => (opened.get(a) ?? 0) - (opened.get(b) ?? 0));
  const declared = goals.map((id) => opened.get(id)).filter((i): i is number => i !== undefined);
  return { seed, goals, goalsDeclared: declared.length ? Math.max(...declared) : null, firstPort, held };
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

/** The held change a stop is about (@held-1, @held-2, …), else null. */
function heldOf(stop: TourStop, f: Facts): Held | null {
  const m = /^@held-(\d+)$/.exec(stop.moment.name);
  return m ? (f.held[Number(m[1]) - 1] ?? null) : null;
}

/** The review queue as GET /review answers it (an array of proposals), else null when the read failed. */
function reviewItems(data: TourData): Json[] | null {
  const v = data["review"];
  const list = Array.isArray(v) ? v : isObj(v) && Array.isArray(v.queue) ? v.queue : null;
  return list ? list.filter(isObj) : null;
}

/** A person's decision on a proposal, from its human-layer decision events (the latest). */
function humanDecision(store: ColonyStore, proposalId: string): string | null {
  let out: string | null = null;
  for (const d of store.decisions.get(proposalId) ?? []) if (d.layer === "human" && DECISIONS.has(d.action)) out = d.action;
  return out;
}

/** What became of one held change, as the store at the end of the record and the review queue tell it. */
function outcomeOf(h: Held, store: ColonyStore, review: Json[] | null): { text: string; waiting: boolean } {
  const v = versionOf(store.intents.get(h.intentId)?.title ?? h.intentId);
  const status = store.proposals.get(h.proposalId)?.status ?? "escalated";
  const decision = humanDecision(store, h.proposalId);
  const queued = review ? review.some((r) => r.id === h.proposalId) : null;
  if (decision === "approve") return { text: status === "landed" ? `a person kept ${v}` : status === "returned" || status === "rejected" ? `a person approved ${v}, and it went back to its agent` : `a person approved ${v}`, waiting: false };
  if (decision === "return") return { text: `a person sent ${v} back to its agent`, waiting: false };
  if (decision === "reject") return { text: `a person rejected ${v}`, waiting: false };
  if (status === "escalated" && queued !== false) return { text: `${v} still waits for a person`, waiting: true };
  if (status === "escalated") return { text: `${v} left the review queue`, waiting: false };
  return { text: status === "landed" ? `${v} landed` : `${v} went back to its agent`, waiting: false };
}

/** The last step's sentence: the queue still holds the held changes, or what a person decided. */
function queueLine(f: Facts, store: ColonyStore, data: TourData): string {
  if (!f.held.length) return "No change waited for a person in this run.";
  const review = reviewItems(data);
  const outcomes = f.held.map((h) => outcomeOf(h, store, review));
  const kept = f.firstPort ? versionOf(store.intents.get(f.firstPort.intentIds[0] ?? "")?.title ?? "the first change") : "the first change";
  if (outcomes.every((o) => o.waiting)) {
    const which = f.held.length === 1 ? "that change" : f.held.length === 2 ? "both changes" : `all ${fmtInt(f.held.length)} changes`;
    return `The review queue still holds ${which}: a person decides which goal stands, in the Review tab or from the command line, and until then trunk keeps ${kept}.`;
  }
  const said = outcomes.map((o) => o.text).join(", and ");
  return `${said.charAt(0).toUpperCase()}${said.slice(1)}.`;
}

/** Find a moment of the goal-conflict run in its record. */
function findOrderBackend(name: string, timeline: Timeline, f: Facts): Moment | null {
  const n = timeline.length;
  if (!n) return null;
  const moment = (index: number, extra: Partial<Moment> = {}): Moment => ({ name, at: timeline.times[index] ?? 0, index, paths: [], proposalIds: [], ...extra });
  switch (name) {
    case "@start":
      return moment(0);
    case "@end":
      return moment(n - 1);
    case "@seed":
      return f.seed ? moment(f.seed.index, { paths: f.seed.paths, proposalIds: f.seed.proposalIds }) : null;
    case "@goals":
      return f.goalsDeclared !== null ? moment(f.goalsDeclared, { paths: f.seed?.paths ?? [], count: f.goals.length }) : null;
    case "@first-port":
      return f.firstPort ? moment(f.firstPort.index, { paths: f.firstPort.paths, proposalIds: f.firstPort.proposalIds }) : null;
    default: {
      const m = /^@held-(\d+)$/.exec(name);
      const h = m ? f.held[Number(m[1]) - 1] : undefined;
      if (!h) return null;
      return moment(h.index, { paths: f.seed?.paths ?? f.firstPort?.paths ?? [], proposalIds: [h.proposalId], reason: h.reason, count: h.lines ?? undefined });
    }
  }
}

/** Every value a goal-conflict caption can name, from the record's facts and the store standing at the stop. */
export function orderBackendValues(stop: TourStop, store: ColonyStore, plan: TourPlan, data: TourData): Record<string, string> {
  const f = factsOf(plan.timeline);
  const title = (intentId: string | undefined): string => (intentId ? (store.intents.get(intentId)?.title ?? intentId) : "");
  const seedIntent = f.seed ? store.intents.get(f.seed.intentIds[0] ?? "") : undefined;
  const seedWhy = clip(seedIntent?.why ?? "", REASON_CHARS);
  const goalTitles = f.goals.map((id) => title(id));
  const languages = goalTitles.map(languageOf);
  const goalTargets = languages.every((l) => l !== null) && languages.length ? `move it to ${listed(languages.map((l) => l as string))}` : listed(goalTitles.map((t) => `“${t}”`));
  const firstTitle = title(f.firstPort?.intentIds[0]);
  const held = heldOf(stop, f);
  const heldTitle = title(held?.intentId);
  const undone = held?.undoesLanding ?? null;
  const first = f.held[0];
  const sameAsFirst = held !== null && first !== undefined && held !== first && undone !== null && undone === first.undoesLanding;
  const undoneTitle = undone && f.firstPort?.landingId === undone ? firstTitle : "";
  return {
    colony: store.colonyId,
    seedAgent: agentName(store, f.seed?.agentIds[0], "An agent"),
    seedFile: fileList(f.seed?.paths ?? []),
    seedTitle: seedIntent?.title ?? "the first intent",
    seedWhy: seedWhy ? ` (“${seedWhy}”)` : "",
    seedSettledBy: f.seed ? settledBy(landingMoment(f.seed, "@seed"), store) : "its checks",
    goals: plural(f.goals.length, "goal"),
    goalTargets,
    firstAgent: agentName(store, f.firstPort?.agentIds[0], "An agent"),
    firstVersion: firstTitle ? versionOf(firstTitle) : "its version",
    firstTitle,
    firstLanding: f.firstPort?.landingId ?? "its landing",
    firstSettledBy: f.firstPort ? settledBy(landingMoment(f.firstPort, "@first-port"), store) : "its checks",
    firstAfterGoals: fmtSeconds(f.firstPort && f.goalsDeclared !== null ? f.firstPort.at - (plan.timeline.times[f.goalsDeclared] ?? 0) : 0),
    heldAgent: agentName(store, held?.agentId, "The next agent"),
    heldVersion: heldTitle ? versionOf(heldTitle) : "its version",
    heldTitle,
    heldReason: held ? quoteReason(held.reason) : "",
    heldAfter: fmtSeconds(held && f.firstPort ? held.at - f.firstPort.at : 0),
    heldLines: plural(held?.lines ?? 0, "line"),
    heldNames: sameAsFirst ? "naming the same landing" : undone ? `naming landing ${undone}` : "naming no landing",
    undoneVersion: undoneTitle ? versionOf(undoneTitle) : undone ? `landing ${undone}` : "the landing before it",
    waiting: plural(f.held.filter((h) => outcomeOf(h, store, reviewItems(data)).waiting).length, "change"),
    queueLine: queueLine(f, store, data),
  };
}

/** The numbers (and ids) a goal-conflict stop quotes, unformatted, for the check against the review queue and the snapshot. */
export function orderBackendNumbers(stop: TourStop, store: ColonyStore, plan: TourPlan, _data: TourData): Record<string, number | string> {
  const f = factsOf(plan.timeline);
  const held = heldOf(stop, f);
  if (held) return { lines: held.lines ?? 0, undoesLanding: held.undoesLanding ?? "", proposal: held.proposalId };
  switch (stop.moment.name) {
    case "@goals":
      return { goals: f.goals.length };
    case "@end":
      // From the record alone (held, and no person's decision), so the check against the review queue is a real comparison.
      return { waiting: f.held.filter((h) => outcomeOf(h, store, null).waiting).length };
    default:
      return {};
  }
}

/**
 * Compare what the goal-conflict tour quotes with the API: the changes waiting for a person against the review queue,
 * the landing and the lines each would undo against the queue items' `undoes`, the goals against the snapshot's intents
 * on the seeded file, the review queue against the metrics endpoint; then, like every tour, the end of the record
 * against the metrics endpoint.
 */
export function orderBackendCheck(plan: TourPlan, quoted: ReadonlyArray<Record<string, number | string>>, end: ColonyStore, data: TourData, metrics: MetricsReport): TourCheck[] {
  const out: TourCheck[] = [];
  const f = factsOf(plan.timeline);
  const review = reviewItems(data);
  const show = (v: number | string | undefined | null): string => (v === undefined || v === null ? "absent" : typeof v === "number" ? fmtInt(v) : v);
  const same = (name: string, tour: number | string | undefined, api: number | string | null | undefined, note?: string) => {
    if (tour === undefined) return;
    out.push({ name, tour: show(tour), metrics: show(api), ok: api !== undefined && api !== null && tour === api, ...(note ? { note } : {}) });
  };
  const last = plan.stops.findIndex((s) => s.moment.name === "@end");
  const endQ = last >= 0 ? quoted[last] : undefined;
  const heldInQueue = review ? review.filter((r) => WOULD_UNDO.test(str(r.reason))) : null;
  if (endQ) same("changes waiting for a person", endQ.waiting, heldInQueue ? heldInQueue.length : null);
  plan.stops.forEach((stop, i) => {
    const h = heldOf(stop, f);
    const q = quoted[i];
    if (!h || !q) return;
    const who = agentName(end, h.agentId, "an agent");
    const item = review?.find((r) => r.id === h.proposalId);
    if (review && !item) {
      out.push({ name: `the landing ${who}'s change would undo`, tour: show(q.undoesLanding), metrics: "not comparable", ok: true, note: "the change is no longer in the review queue" });
      return;
    }
    const undoes = item && Array.isArray(item.undoes) ? item.undoes.filter(isObj) : [];
    same(`the landing ${who}'s change would undo`, q.undoesLanding, undoes.length ? str(undoes[0]?.landingId) : null);
    same(`lines ${who}'s change would undo`, q.lines, undoes.length ? undoes.reduce((n, u) => n + (num(u.lines) ?? 0), 0) : null);
  });
  const goalsAt = plan.stops.findIndex((s) => s.moment.name === "@goals");
  const goalsQ = goalsAt >= 0 ? quoted[goalsAt] : undefined;
  const snapshot = data["snapshot"];
  if (goalsQ && isObj(snapshot)) {
    const seedFile = f.seed?.paths[0];
    const seedIntent = f.seed?.intentIds[0];
    const intents = Array.isArray(snapshot.intents) ? snapshot.intents.filter(isObj) : [];
    const onFile = seedFile ? intents.filter((i) => i.id !== seedIntent && Array.isArray(i.footprint) && i.footprint.includes(seedFile)).length : null;
    same("goals for the seeded file", goalsQ.goals, onFile, "intents on the file besides the seed, in the snapshot");
  }
  same("review queue at the end", end.reviewQueue(), metrics.metrics?.["reviewQueue"]);
  out.push(...checkTour(plan, null, null, end, metrics));
  return out;
}

const STEPS = loadTourSteps(raw, new Set(ORDER_BACKEND_MOMENTS));

/** The order-backend colony's tour. */
export const ORDER_BACKEND_TOUR: ColonyTour = {
  id: "order-backend",
  about: "Three agents with conflicting goals: the first change lands, the other two wait for a person, each naming the landing it would undo, told from the colony's record",
  steps: STEPS,
  reads: ORDER_BACKEND_READS,
  plan: (timeline, _store, _data, source) => planTour(STEPS, timeline, { source, find: (name) => findOrderBackend(name, timeline, factsOf(timeline)) }),
  values: orderBackendValues,
  numbers: orderBackendNumbers,
  check: orderBackendCheck,
};
