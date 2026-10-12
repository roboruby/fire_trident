import { useEffect, useState } from "react";
import { metricKey } from "../store.ts";
import { fmtDuration, fmtInt, prettyUrl } from "../format.ts";
import { colonyHref } from "../route.ts";

/**
 * The results strip: what the production showcase colonies did, read from their own API (the
 * convergence, counts, agents and the funnel), with a replay and the colony one click away. Only
 * what the API cannot know (model spend, a test run from a plain clone) is written here, as measured.
 */

type Kind = "rule" | "spec" | "mcp";

/** The showcase runs, and the facts measured outside the colony (model spend from the agents' token counts, tests run on a plain clone). */
const SHOWCASE: ReadonlyArray<{ id: string; kind: Kind; measured?: string }> = [
  { id: "hono", kind: "rule", measured: "$0.05 of model calls" },
  { id: "shortlinks", kind: "spec", measured: "60/60 tests pass from a plain clone" },
  { id: "byo-demo", kind: "mcp" },
];

interface Result {
  id: string;
  kind: Kind;
  name: string;
  source?: string;
  headline: string;
  lede: string;
  details: string[];
}

type Json = Record<string, unknown>;
const isObj = (x: unknown): x is Json => typeof x === "object" && x !== null && !Array.isArray(x);
const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);

async function getJson(url: string, signal: AbortSignal): Promise<unknown> {
  const res = await fetch(url, { headers: { accept: "application/json" }, signal });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

/** A duration as people say it about a run: seconds under three minutes, whole minutes above. */
function runTime(ms: number): string {
  return ms < 180_000 ? fmtDuration(ms) : `${fmtInt(Math.round(ms / 60_000))} min`;
}

async function loadResult(s: (typeof SHOWCASE)[number], listing: Json[], signal: AbortSignal): Promise<Result | null> {
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
  const out: Result = { id: s.id, kind: s.kind, name, ...(src ? { source: src } : {}), headline: "", lede: "", details };

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
  } else if (s.kind === "spec") {
    const created = num(row?.createdAt);
    const last = num(row?.lastLandingAt);
    out.headline = created !== null && last !== null && last > created ? runTime(last - created) : `${fmtInt(landed)}`;
    out.lede = created !== null && last !== null && last > created ? `from a spec to a working project: ${fmtInt(landed)} of ${fmtInt(intents)} intents landed` : "intents landed from a spec";
    details.push(`${fmtInt(agents)} agents, ${fmtInt(landings)} commits`);
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
        {r.source ? <span className="rs-src mono">{r.source}</span> : <span className="rs-src">started from a spec</span>}
      </div>
      <div className="rs-headline">{r.headline}</div>
      <div className="rs-lede">{r.lede}</div>
      <ul className="rs-details">
        {r.details.map((d) => (
          <li key={d}>{d}</li>
        ))}
      </ul>
      <div className="rs-links">
        <a className="rs-replay" href={colonyHref(r.id, { replay: true })}>
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path d="M4 2.5v11l9.5-5.5z" fill="currentColor" />
          </svg>
          Replay
        </a>
        <a className="rs-open" href={colonyHref(r.id)}>
          Open
        </a>
      </div>
    </article>
  );
}

/** The showcase, or ?results=id:kind,id:kind (rule, spec or mcp) for a deployment without the production colonies. */
function showcase(): ReadonlyArray<{ id: string; kind: Kind; measured?: string }> {
  const raw = new URLSearchParams(location.search).get("results");
  if (!raw) return SHOWCASE;
  const kinds: ReadonlySet<string> = new Set(["rule", "spec", "mcp"]);
  return raw
    .split(",")
    .map((x) => x.trim().split(":"))
    .filter(([id, kind]) => !!id && !!kind && kinds.has(kind))
    .map(([id, kind]) => ({ id: id as string, kind: kind as Kind }));
}

/** The results strip on the landing page (hidden when none of the showcase colonies answers). */
export function Results() {
  const [results, setResults] = useState<Result[] | null>(null);
  const [list] = useState(showcase);
  useEffect(() => {
    const ctl = new AbortController();
    void (async () => {
      const listing = await getJson("/api/colonies", ctl.signal)
        .then((d) => (isObj(d) && Array.isArray(d.colonies) ? (d.colonies as Json[]) : []))
        .catch(() => [] as Json[]);
      const out = await Promise.all(list.map((s) => loadResult(s, listing, ctl.signal).catch(() => null)));
      if (!ctl.signal.aborted) setResults(out.filter((r): r is Result => r !== null));
    })();
    return () => ctl.abort();
  }, [list]);
  if (results !== null && results.length === 0) return null;
  return (
    <section className="l-section" id="results">
      <div className="l-section-head">
        <div className="l-kicker">Results</div>
        <h2 className="l-h2">Real runs on production. Replay any of them.</h2>
        <p className="l-section-lede">Every number below comes from the colony's own API. A replay plays the run back from its record, at up to 16 times speed.</p>
      </div>
      <div className="rs-grid">
        {results === null
          ? list.map((s) => <div className="rs rs-skeleton" key={s.id} />)
          : results.map((r) => <Card key={r.id} r={r} />)}
      </div>
    </section>
  );
}
