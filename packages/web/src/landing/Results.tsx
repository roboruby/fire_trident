import { useEffect, useState } from "react";
import { spendLine } from "@fire_trident/core";
import { parseSpend } from "../spend.ts";
import { metricKey } from "../store.ts";
import { fmtDuration, fmtInt, prettyUrl } from "../format.ts";
import { colonyHref } from "../route.ts";
import { serverOrigin } from "./LiveNote.tsx";
import { TOUR_ABOUT, hasTour } from "../tour/catalog.ts";
import { loadFirstRedCard, loadGoalsCard, loadScaleCard, loadSignedCard, specBuild } from "./showcase.ts";

/**
 * The results strip: what the production showcase colonies did, read from their own API (the
 * convergence, counts, agents and the funnel), with a replay and the colony one click away. Only
 * what the API cannot know (a test run from a plain clone, the load generator's timing) is written here, as measured.
 */

type Kind = "rule" | "spec" | "mcp" | "certify" | "scale" | "goals" | "firstred" | "signed";

/** A showcase run: its colony, its kind of card, a fact measured outside the colony, and where its replay starts (`t=<s>&speed=<n>`, for a record that opens on setup). */
export interface Showcase {
  id: string;
  kind: Kind;
  measured?: string;
  replay?: string;
}

/** The showcase runs, and the facts measured outside the colony (tests run on a plain clone, the load generator's timing). */
const SHOWCASE: ReadonlyArray<Showcase> = [
  { id: "hono", kind: "rule" },
  { id: "shortlinks", kind: "spec", measured: "60/60 tests pass from a plain clone" },
  { id: "shortlinks-review", kind: "certify", measured: "67/67 from a plain clone; acceptance 7/7" },
  { id: "scale", kind: "scale", measured: "2,730 changes a minute over the run, median 9.6 s to land (the load generator's timing)", replay: "t=32&speed=4" },
  { id: "byo-demo", kind: "mcp" },
  { id: "signed-notes", kind: "signed" },
];

interface Result {
  id: string;
  kind: Kind;
  name: string;
  source?: string;
  /** Where a colony with no source came from (scale, goals, firstred, signed); without either the card says it started from a spec. */
  origin?: string;
  /** Where the replay link starts (Showcase.replay). */
  replay?: string;
  headline: string;
  lede: string;
  details: string[];
}

type Json = Record<string, unknown>;
const isObj = (x: unknown): x is Json => typeof x === "object" && x !== null && !Array.isArray(x);
const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);

/** A request the strip gives up on: its card is left out instead of holding the others. */
const REQUEST_TIMEOUT_MS = 15_000;

async function getJson(url: string, signal: AbortSignal): Promise<unknown> {
  const limited = typeof AbortSignal.any === "function" ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : signal;
  const res = await fetch(url, { headers: { accept: "application/json" }, signal: limited });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

/** A duration as people say it about a run: seconds under three minutes, whole minutes above. */
function runTime(ms: number): string {
  return ms < 180_000 ? fmtDuration(ms) : `${fmtInt(Math.round(ms / 60_000))} min`;
}

async function loadResult(s: Showcase, listing: Json[], signal: AbortSignal): Promise<Result | null> {
  const base = `/api/colonies/${encodeURIComponent(s.id)}`;
  const row = listing.find((r) => r.id === s.id);
  const m = await getJson(`${base}/metrics`, signal).catch(() => null);
  if (!isObj(m)) return null;
  const metrics = new Map<string, number>();
  if (isObj(m.metrics)) for (const [k, v] of Object.entries(m.metrics)) if (typeof v === "number") metrics.set(metricKey(k), v);
  const k = (name: string) => metrics.get(metricKey(name)) ?? 0;
  const name = typeof row?.name === "string" ? row.name : s.id;
  const src = isObj(row?.source) && typeof row.source.url === "string" ? prettyUrl(row.source.url) : undefined;
  const agents = k("agents");
  const landed = k("landedIntents");
  const intents = k("intents");
  const landings = k("landings");
  const settled = k("funnel.proof") + k("funnel.reflex") + k("funnel.llm") + k("funnel.human");
  const proofLine = settled ? `${fmtInt(k("funnel.proof"))} of ${fmtInt(settled)} settled by proof` : null;
  const details: string[] = [];
  const out: Result = { id: s.id, kind: s.kind, name, ...(src ? { source: src } : {}), ...(s.replay ? { replay: s.replay } : {}), headline: "", lede: "", details };

  if (s.kind === "rule") {
    const c = isObj(m.convergence) ? m.convergence : null;
    const initial = num(c?.initial) ?? 0;
    const since = num(c?.since);
    const at = num(c?.convergedAt);
    if (initial > 0 && since !== null && at !== null) {
      out.headline = `${fmtInt(initial)} → 0`;
      out.lede = `violations in ${runTime(at - since)}, with ${fmtInt(agents)} agents`;
    } else {
      out.headline = `${fmtInt(num(c?.fixed) ?? 0)}`;
      out.lede = `of ${fmtInt(initial)} violations fixed so far, by ${fmtInt(agents)} agents`;
    }
    details.push(`${fmtInt(landed)} intents in ${fmtInt(landings)} commits`);
    if (proofLine) details.push(proofLine);
    // Model spend as the colony prices it from the tokens it counted (core/pricing.ts); none from an older server.
    const spent = spendLine(parseSpend(m.spend));
    if (spent) details.push(spent);
  } else if (s.kind === "spec") {
    // Timed to the last landing of the spec's own intents (showcase.ts specBuild): a later documentation pass by an
    // outside agent is not part of the build from the spec.
    const created = num(row?.createdAt);
    const build = specBuild(created, await getJson(base, signal).catch(() => null));
    const last = build?.lastLandingAt ?? null;
    const timed = created !== null && last !== null && last > created;
    out.headline = timed ? runTime(last - created) : `${fmtInt(landed)}`;
    out.lede = timed && build ? `from a spec to a working project: ${fmtInt(build.landed)} of ${fmtInt(build.intents)} intents landed` : "intents landed from a spec";
    details.push(`${fmtInt(agents)} agents, ${fmtInt(build && build.landings > 0 ? build.landings : landings)} commits`);
} else if (s.kind === "certify") {
  // Results come newest first: the oldest red one is where the repair began, the newest green one after it is where it ended.
  const [c, snap] = await Promise.all([getJson(`${base}/certifications?limit=50`, signal).catch(() => null), getJson(base, signal).catch(() => null)]);
  const results = isObj(c) && Array.isArray(c.results) ? (c.results as Json[]) : [];
  const reds = results.filter((r) => r.status === "red");
  const first = reds[reds.length - 1];
  const began = num(first?.startedAt);
  const green = began === null ? undefined : results.find((r) => r.status === "green" && (num(r.startedAt) ?? 0) > began);
  const rc = isObj(first?.counts) ? first.counts : null;
  const gc = isObj(green?.counts) ? green.counts : null;
  if (!first || !green || !rc || !gc || began === null) return null;
  out.headline = `${fmtInt((num(rc.fail) ?? 0) + (num(rc.cancelled) ?? 0))} failing → ${fmtInt(num(gc.pass) ?? 0)}/${fmtInt(num(gc.tests) ?? 0)}`;
  out.lede = "tests: certification found the failures and the colony repaired them";
  const ms = num(first.durationMs);
  if (ms !== null) details.push(`found in ${fmtInt(ms)} ms by the project's own tests in a Dynamic Worker`);
  const repairs = isObj(snap) && Array.isArray(snap.intents) ? (snap.intents as Json[]).filter((i) => i.source === "certify" && i.status === "landed").length : 0;
  const ended = num(green.finishedAt);
  if (repairs > 0) details.push(`${fmtInt(repairs)} repair ${repairs === 1 ? "intent" : "intents"} landed${ended !== null ? `; green ${runTime(ended - began)} later` : ""}`);
  } else if (s.kind === "scale" || s.kind === "goals") {
    // Runs on the live service (showcase.ts): many synthetic agents in one repository, or changes held for a person.
    const get = (url: string) => getJson(url, signal);
    const card = s.kind === "scale" ? await loadScaleCard(k) : await loadGoalsCard(s.id, get);
    if (!card) return null;
    out.headline = card.headline;
    out.lede = card.lede;
    out.origin = card.origin;
    details.push(...card.details);
  } else if (s.kind === "firstred") {
    // The first red commit on the live service (showcase.ts): the landing that broke the tests, found by running them, and the repair.
    const card = await loadFirstRedCard(s.id, (url) => getJson(url, signal));
    if (!card) return null;
    out.headline = card.headline;
    out.lede = card.lede;
    out.origin = card.origin;
    details.push(...card.details);
  } else if (s.kind === "signed") {
    // Signed lineage notes on the live service (showcase.ts): the trunk writer's published key and the newest notes it signed.
    const card = await loadSignedCard(s.id, (url) => getJson(url, signal), serverOrigin(location));
    if (!card) return null;
    out.headline = card.headline;
    out.lede = card.lede;
    out.origin = card.origin;
    details.push(...card.details);
  } else {
    const [list, snap] = await Promise.all([getJson(`${base}/agents?all=1&journal=0`, signal).catch(() => null), getJson(base, signal).catch(() => null)]);
    const all = isObj(list) && Array.isArray(list.agents) ? (list.agents as Json[]) : [];
    const outside = all.filter((a) => a.kind === "external");
    const landedBy = new Map<string, number>();
    if (isObj(snap) && Array.isArray(snap.intents)) {
      for (const i of snap.intents as Json[]) if (i.status === "landed" && typeof i.assignedTo === "string") landedBy.set(i.assignedTo, (landedBy.get(i.assignedTo) ?? 0) + 1);
    }
    const agent = outside.find((a) => typeof a.id === "string" && (landedBy.get(a.id) ?? 0) > 0) ?? outside[0];
    if (!agent) return null;
    const n = typeof agent.id === "string" ? (landedBy.get(agent.id) ?? 0) : 0;
    out.headline = typeof agent.name === "string" ? agent.name : "An outside agent";
    out.lede = `joined over MCP and landed ${n === 1 ? "a change" : `${fmtInt(n)} changes`}`;
    if (typeof agent.model === "string") details.push(agent.model);
    const inside = all.length - outside.length;
    details.push(`beside ${fmtInt(inside)} in-platform ${inside === 1 ? "agent" : "agents"}, ${fmtInt(landed)} of ${fmtInt(intents)} intents landed`);
  }
  if (s.measured) details.push(s.measured);
  return out;
}

function Card({ r }: { r: Result }) {
  return (
    <article className={`rs rs-${r.kind}`}>
      <div className="rs-head">
        <span className="rs-name mono">{r.name}</span>
        {r.source ? <span className="rs-src mono">{r.source}</span> : <span className="rs-src">{r.origin ?? "started from a spec"}</span>}
      </div>
      <div className="rs-headline">{r.headline}</div>
      <div className="rs-lede">{r.lede}</div>
      <ul className="rs-details">
        {r.details.map((d) => (
          <li key={d}>{d}</li>
        ))}
      </ul>
      <div className="rs-links">
        <a className="rs-replay" href={`${colonyHref(r.id, { replay: true })}${r.replay ? `&${r.replay}` : ""}`}>
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path d="M4 2.5v11l9.5-5.5z" fill="currentColor" />
          </svg>
          Replay
        </a>
        {/* The colonies with a tour of their own (tour/catalog.ts): the run told from its record, step by step. */}
        {hasTour(r.id) ? (
          <a className="rs-tour" href={colonyHref(r.id, { tour: true })} title={TOUR_ABOUT[r.id]}>
            Take the tour
          </a>
        ) : null}
        <a className="rs-open" href={colonyHref(r.id)}>
          Open
        </a>
      </div>
    </article>
  );
}

/** The kinds ?results= may name. */
const KINDS: ReadonlySet<string> = new Set(["rule", "spec", "mcp", "certify", "scale", "goals", "firstred", "signed"]);

/** The showcase, or ?results=id:kind,id:kind (rule, spec, mcp, certify, scale, goals, firstred or signed) for a deployment without the production colonies. */
export function showcaseFrom(search: string): ReadonlyArray<Showcase> {
  const raw = new URLSearchParams(search).get("results");
  if (!raw) return SHOWCASE;
  return raw
    .split(",")
    .map((x) => x.trim().split(":"))
    .filter(([id, kind]) => !!id && !!kind && KINDS.has(kind))
    .map(([id, kind]) => ({ id: id as string, kind: kind as Kind }));
}

const showcase = (): ReadonlyArray<Showcase> => showcaseFrom(location.search);

/** The results strip on the landing page (hidden when none of the showcase colonies answers). */
export function Results() {
  const [list] = useState(showcase);
  // One slot per showcase run: undefined while it loads, null when it has nothing to show.
  const [results, setResults] = useState<Array<Result | null | undefined>>(() => list.map(() => undefined));
  useEffect(() => {
    const ctl = new AbortController();
    void (async () => {
      const listing = await getJson("/api/colonies", ctl.signal)
        .then((d) => (isObj(d) && Array.isArray(d.colonies) ? (d.colonies as Json[]) : []))
        .catch(() => [] as Json[]);
      await Promise.all(
        list.map(async (s, i) => {
          const r = await loadResult(s, listing, ctl.signal).catch(() => null);
          if (!ctl.signal.aborted) setResults((cur) => cur.map((x, j) => (j === i ? r : x)));
        }),
      );
    })();
    return () => ctl.abort();
  }, [list]);
  if (results.every((r) => r === null)) return null;
  return (
    <section className="l-section" id="results">
      <div className="l-section-head">
        <div className="l-kicker">Runs on production</div>
        <h2 className="l-h2">Six real runs. Replay any of them.</h2>
        <p className="l-section-lede">Every number below comes from the colony's own API. A replay plays the run back from its record, at up to 16 times speed, and a tour tells it step by step.</p>
      </div>
      <div className="rs-grid">
        {results.map((r, i) => (r === undefined ? <div className="rs rs-skeleton" key={list[i]?.id ?? i} /> : r === null ? null : <Card key={r.id} r={r} />))}
      </div>
    </section>
  );
}
