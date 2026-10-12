import { AnimatedNumber } from "../components/AnimatedNumber.tsx";
import type { ColonyCard, Series } from "../colonies.ts";
import { fmtInt, prettyUrl, shortSha, timeAgo } from "../format.ts";
import { colonyHref } from "../route.ts";

type Status = "working" | "converged" | "idle" | "unreachable";

function statusOf(c: ColonyCard): Status {
  if (c.error) return "unreachable";
  const working = c.counters.get("agentsworking") ?? 0;
  const perMin = c.counters.get("landingspermin") ?? 0;
  if (working > 0 || perMin > 0) return "working";
  const landed = c.counters.get("landedintents") ?? c.counters.get("intentslanded") ?? 0;
  if ((c.violations ?? 0) === 0 && landed > 0) return "converged";
  return "idle";
}

/** Colonies in the order worth showing: working now, then real projects before benchmarks, then the most work landed; failures last. */
export function rankColonies(cards: readonly ColonyCard[]): ColonyCard[] {
  const order: Record<Status, number> = { working: 0, converged: 1, idle: 2, unreachable: 3 };
  const landed = (c: ColonyCard) => c.counters.get("landedintents") ?? c.counters.get("intentslanded") ?? 0;
  return [...cards].sort(
    (a, b) => order[statusOf(a)] - order[statusOf(b)] || Number(/^bench/i.test(a.id)) - Number(/^bench/i.test(b.id)) || landed(b) - landed(a),
  );
}

const STATUS_LABEL: Record<Status, string> = { working: "Working", converged: "Converged", idle: "Idle", unreachable: "Unreachable" };

/** A small per-minute sparkline: the violations burn-down when there is one, else landings. */
function Spark({ series }: { series: Series }) {
  const burn = series.violations.some((v) => v > 0);
  const data = burn ? series.violations : series.landings;
  if (data.length < 2) return null;
  const W = 280;
  const H = 44;
  const max = Math.max(1, ...data);
  const step = W / (data.length - 1);
  const pts = data.map((v, i) => `${(i * step).toFixed(1)},${(H - 3 - (v / max) * (H - 8)).toFixed(1)}`);
  return (
    <div className="lc-spark">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
        <polyline className={burn ? "lc-line-need" : "lc-line-trail"} points={pts.join(" ")} />
        <polygon className={burn ? "lc-fill-need" : "lc-fill-trail"} points={`0,${H} ${pts.join(" ")} ${W},${H}`} />
      </svg>
      <span>{burn ? "violations, last 30 min" : "landings per minute, last 30 min"}</span>
    </div>
  );
}

function Counter({ value, label }: { value: number | undefined; label: string }) {
  return (
    <div className="lc-counter">
      <b>{value === undefined ? "–" : <AnimatedNumber value={value} duration={600} />}</b>
      <span>{label}</span>
    </div>
  );
}

/** One live colony with its counters; the whole card links to the colony map. */
function Card({ c }: { c: ColonyCard }) {
  const status = statusOf(c);
  const k = (...names: string[]): number | undefined => {
    for (const n of names) {
      const v = c.counters.get(n);
      if (v !== undefined) return v;
    }
    return undefined;
  };
  const violations = c.violations ?? k("violations") ?? 0;
  const funnel = (k("funnelproof") ?? 0) + (k("funnelreflex") ?? 0) + (k("funnelllm") ?? 0) + (k("funnelhuman") ?? 0);
  return (
    <a className={`lc lc-${status}`} href={colonyHref(c.id)}>
      <div className="lc-head">
        <span className={`lc-status lc-status-${status}`}>
          <i />
          {STATUS_LABEL[status]}
        </span>
        <span className="lc-open" aria-hidden="true">
          Open map →
        </span>
      </div>
      <div className="lc-name mono">{c.name}</div>
      <div className="lc-src mono">{c.source ? `${prettyUrl(c.source.url)}${c.source.branch ? ` · ${c.source.branch}` : ""}` : "started from a spec"}</div>
      {c.error ? (
        <div className="lc-error">The colony did not answer ({c.error}).</div>
      ) : (
        <>
          <div className="lc-hero">
            <b className={violations === 0 ? "is-clean" : ""}>
              <AnimatedNumber value={violations} duration={800} />
            </b>
            <span>{violations === 0 ? "violations left: every rule satisfied" : "violations left"}</span>
          </div>
          {c.series ? <Spark series={c.series} /> : null}
          <div className="lc-counters">
            <Counter value={k("landedintents", "intentslanded")} label="intents landed" />
            <Counter value={k("landings")} label="landings" />
            <Counter value={k("agentsactive", "agents")} label="agents" />
            <Counter value={funnel || k("decisions")} label="decisions" />
          </div>
          <div className="lc-foot mono">
            <span>head {shortSha(c.trunkSha)}</span>
            <span>{c.lastLandingAt ? `last landing ${timeAgo(c.lastLandingAt)}` : "no landings yet"}</span>
          </div>
        </>
      )}
    </a>
  );
}

/** The strip of deployed colonies with live counters. */
/** A colony with nothing in it yet (a probe, a fresh import before its first rule). */
function isEmpty(c: ColonyCard): boolean {
  return !c.error && (c.counters.get("landings") ?? 0) === 0 && (c.counters.get("intents") ?? 0) === 0 && (c.violations ?? 0) === 0;
}

/** Columns that keep the rows even: 1 to 3 cards in one row, 4 as a square, more in threes. */
function columns(n: number): number {
  return n <= 3 ? Math.max(1, n) : n === 4 ? 2 : 3;
}

export function LiveColonies({ cards: all }: { cards: ColonyCard[] | null }) {
  const busy = all?.filter((c) => !isEmpty(c)) ?? [];
  const cards = all && busy.length >= 3 ? busy : all;
  if (cards === null) {
    return (
      <div className="lc-grid" style={{ "--cols": 2 } as React.CSSProperties}>
        <div className="lc lc-skeleton" />
        <div className="lc lc-skeleton" />
      </div>
    );
  }
  if (!cards.length) {
    return (
      <div className="lc-empty">
        No colony is answering right now. <a href={colonyHref("demo", { mock: true })}>Open the simulator</a> to see one run.
      </div>
    );
  }
  return (
    <div className={`lc-grid${cards.length === 1 ? " is-single" : ""}`} style={{ "--cols": columns(cards.length === 1 ? 2 : cards.length) } as React.CSSProperties}>
      {cards.map((c) => (
        <Card key={c.id} c={c} />
      ))}
      {cards.length === 1 ? (
        <a className="lc lc-sim" href={colonyHref("demo", { mock: true })}>
          <div className="lc-head">
            <span className="lc-status lc-status-sim">
              <i />
              Simulator
            </span>
            <span className="lc-open" aria-hidden="true">
              Open →
            </span>
          </div>
          <div className="lc-name mono">copperleaf/storefront</div>
          <div className="lc-src">A simulated colony that runs in your browser: {fmtInt(64)} agents, three architecture rules, rebase storms, and a review queue you can act on.</div>
        </a>
      ) : null}
    </div>
  );
}
