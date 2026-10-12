import type { DecisionLayer } from "@fire_trident/core";
import { fmtInt, fmtPct } from "../format.ts";
import type { ColonyStore, ConnState } from "../store.ts";
import { sparkPoints, type Series } from "../series.ts";
import { LAYER_COLOR } from "../theme.ts";
import { useThrottledVersion } from "../useStore.ts";
import { AnimatedNumber } from "./AnimatedNumber.tsx";
import { ColonyPicker } from "./ColonyPicker.tsx";
import { VaccineMeter } from "./VaccineMeter.tsx";

const fmtSigma = (n: number): string => n.toFixed(2);

/** Product mark: a trident in the brand accent. */
export function TridentMark({ size = 30 }: { size?: number }) {
  return (
    <svg className="mark" viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
      <defs>
        <linearGradient id="ft-mark" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffb469" />
          <stop offset="1" stopColor="#f38020" />
        </linearGradient>
      </defs>
      <g fill="none" stroke="url(#ft-mark)" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">
        <path d="M16 6.5V29" />
        <path d="M7.5 9v4a8.5 8.5 0 0 0 17 0V9" />
      </g>
      <g fill="url(#ft-mark)">
        <path d="M16 1.6l3.1 5h-6.2z" />
        <path d="M7.5 4.2l2.7 4.6H4.8z" />
        <path d="M24.5 4.2l2.7 4.6h-5.4z" />
      </g>
    </svg>
  );
}

const CONN_LABEL: Record<ConnState, string> = {
  connecting: "Connecting",
  live: "Live",
  reconnecting: "Reconnecting",
  error: "Offline",
  mock: "Simulated",
};

function ConnPill({ conn }: { conn: ConnState }) {
  return (
    <span className={`conn conn-${conn}`}>
      <i />
      {CONN_LABEL[conn]}
    </span>
  );
}

function Stat({ label, value, sub, ready }: { label: string; value: number; sub: string; ready: boolean }) {
  return (
    <div className="stat">
      <div className="stat-k">{label}</div>
      {ready ? <AnimatedNumber className="stat-num" value={value} /> : <span className="stat-num is-empty">–</span>}
      <div className="stat-sub">{ready ? sub : "waiting"}</div>
    </div>
  );
}

function SigmaGauge({ value, region }: { value: number; region: string | null }) {
  const v = Number.isFinite(value) ? Math.max(0, value) : 0;
  const frac = Math.max(0, Math.min(1, v / 2));
  const r = 26;
  const cx = 34;
  const cy = 33;
  const len = Math.PI * r;
  const critical = v > 1;
  const tone = critical ? "critical" : v > 0.85 ? "warm" : "calm";
  const arc = `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`;
  return (
    <div className={`gauge gauge-${tone}`} title="Branching ratio of recent causal events. Above 1 means a runaway cascade; the governor slows lanes and closes admission.">
      <svg viewBox="0 0 68 40" width="78" height="46" aria-hidden="true">
        <path d={arc} className="gauge-track" />
        <path d={arc} className="gauge-fill" style={{ strokeDasharray: len, strokeDashoffset: len * (1 - frac) }} />
        <line x1={cx} y1={cy - r - 4} x2={cx} y2={cy - r + 5} className="gauge-tick" />
        <g className="gauge-needle" style={{ transform: `rotate(${180 * frac}deg)`, transformOrigin: `${cx}px ${cy}px` }}>
          <line x1={cx} y1={cy} x2={cx - r + 8} y2={cy} />
        </g>
        <circle cx={cx} cy={cy} r="2.6" className="gauge-hub" />
      </svg>
      <div className="gauge-text">
        <div className="stat-k">Sigma</div>
        <AnimatedNumber className="gauge-num" value={v} format={fmtSigma} duration={500} />
        <div className="stat-sub">{critical && region ? `cascade · ${region}` : critical ? "governor engaged" : "branching ratio"}</div>
      </div>
    </div>
  );
}

/** The violations burn-down over the server's per-minute window; the last point is the live total. */
function BurnDown({ series, live }: { series: Series; live: number }) {
  const data = [...series.violations.slice(0, -1), Math.max(0, live)];
  const W = 228;
  const H = 22;
  const pts = sparkPoints(data, W, H);
  if (!pts) return null;
  const minutes = Math.round((series.bucketMs * data.length) / 60_000);
  return (
    <svg className="burn" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-label={`Violations, last ${minutes} minutes`}>
      <defs>
        <linearGradient id="burn-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="rgba(255,181,61,0.32)" />
          <stop offset="1" stopColor="rgba(255,181,61,0)" />
        </linearGradient>
      </defs>
      <polygon points={`0,${H} ${pts} ${W},${H}`} fill="url(#burn-fill)" />
      <polyline points={pts} className="burn-line" />
    </svg>
  );
}

const LAYERS: readonly DecisionLayer[] = ["reflex", "llm", "human"];
const LAYER_LABEL: Record<DecisionLayer, string> = { reflex: "Reflex", llm: "LLM", human: "Human" };

function Funnel({ funnel, last }: { funnel: Record<DecisionLayer, number>; last: Record<DecisionLayer, number> }) {
  const W = 240;
  const H = 26;
  const n = (l: DecisionLayer) => Math.max(0, Number.isFinite(funnel[l]) ? funnel[l] : 0);
  const max = Math.max(1, ...LAYERS.map(n));
  const total = LAYERS.reduce((a, l) => a + n(l), 0);
  const height = (x: number) => 7 + (H - 7) * (Math.log10(x + 1) / Math.log10(max + 1));
  const hs = LAYERS.map((l) => height(n(l)));
  const seg = W / 3;
  const now = Date.now();
  return (
    <div className="funnel" title="Every decision goes to the cheapest layer that is confident: calibrated reflex models first, then an LLM, then a human.">
      <div className="stat-k">
        Reflex arc <span className="funnel-share">{total ? `${fmtPct(n("reflex") / total, 1)} at reflex` : "no decisions yet"}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="funnel-svg" aria-hidden="true">
        {LAYERS.map((l, i) => {
          const hl = hs[i] ?? 8;
          const hr = i < 2 ? (hs[i + 1] ?? 8) : hl * 0.72;
          const x0 = i * seg + (i ? 2 : 0);
          const x1 = (i + 1) * seg - 2;
          const d = `M${x0} ${(H - hl) / 2} L${x1} ${(H - hr) / 2} L${x1} ${(H + hr) / 2} L${x0} ${(H + hl) / 2} Z`;
          const hot = now - last[l] < 700;
          return <path key={`${l}-${hot ? last[l] : 0}`} d={d} className={`funnel-seg${hot ? " is-hot" : ""}`} style={{ fill: LAYER_COLOR[l], stroke: LAYER_COLOR[l] }} />;
        })}
      </svg>
      <div className="funnel-row">
        {LAYERS.map((l) => (
          <div className="funnel-cell" key={l}>
            <span className="funnel-label" style={{ color: LAYER_COLOR[l] }}>
              {LAYER_LABEL[l]}
            </span>
            <AnimatedNumber className="funnel-num" value={n(l)} duration={400} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** The top bar: brand and colony, the hero violations counter, live stats, sigma, vaccination, and the reflex funnel. */
export function TopBar({ store, director = false, mock = false }: { store: ColonyStore; director?: boolean; mock?: boolean }) {
  useThrottledVersion(store, 200);
  const now = Date.now();
  const total = store.violations.total;
  const fixed = store.violationsFixed();
  const progress = fixed + total > 0 ? fixed / (fixed + total) : store.loaded ? 1 : 0;
  const rate = store.fixRate(now);
  const sigma = store.sigmaMax(now);
  const clean = store.loaded && total === 0;
  const landedIntents = store.intentsLanded();
  const vaccine = store.vaccination();
  const review = store.reviewQueue();
  const byRule = Object.entries(store.violations.byRule)
    .filter(([, n]) => typeof n === "number" && n > 0)
    .map(([id, n]) => `${store.rules.get(id)?.description ?? id}: ${fmtInt(n)}`)
    .join("\n");
  const label = store.colony?.name ?? store.colonyId;
  return (
    <header className={`top${director ? " is-director" : ""}`}>
      <div className="brand">
        <a className="brand-home" href="/" title="FireTrident home" tabIndex={director ? -1 : 0}>
          <TridentMark />
        </a>
        <div className="brand-text">
          <div className="brand-name">FireTrident</div>
          <div className="brand-colony">
            {director ? <span className="mono brand-colony-name">{label}</span> : <ColonyPicker current={store.colonyId} label={label} mock={mock} />}
            <ConnPill conn={store.conn} />
          </div>
        </div>
      </div>
      <div className={`hero${clean ? " is-clean" : ""}`} title={byRule || undefined}>
        <div className="stat-k">{clean ? "Every rule satisfied" : "Violations remaining"}</div>
        <div className="hero-row">
          <span className="hero-slot" style={{ minWidth: `${Math.max(3, fmtInt(fixed + total).length)}ch` }}>
            {store.loaded ? <AnimatedNumber className="hero-num" value={total} duration={900} /> : <span className="hero-num is-empty">–</span>}
          </span>
          <div className="hero-side">
            <div className="hero-rate">{clean ? "clean" : rate >= 1 ? `−${fmtInt(rate)}/min` : "·"}</div>
            <div className="hero-fixed">{fixed > 0 || !landedIntents ? `${fmtInt(fixed)} fixed` : `${fmtInt(landedIntents)} intents landed`}</div>
          </div>
        </div>
        {store.series && store.series.violations.some((v) => v > 0) ? (
          <BurnDown series={store.series} live={total} />
        ) : (
          <div className="hero-bar">
            <b style={{ transform: `scaleX(${Math.max(0, Math.min(1, progress))})` }} />
          </div>
        )}
      </div>
      <div className="stats">
        <Stat ready={store.loaded} label="Agents" value={store.agentsActive()} sub={`${fmtInt(store.agentsWorking())} working`} />
        <Stat ready={store.loaded} label="Landings / min" value={Math.round(store.landingsPerMin(now))} sub={`${fmtInt(store.landingsTotal())} landings`} />
        <Stat ready={store.loaded} label="In flight" value={store.proposalsInFlight()} sub={review > 0 ? `${fmtInt(review)} need a human` : "proposals"} />
      </div>
      <SigmaGauge value={sigma.value} region={sigma.region} />
      {vaccine ? <VaccineMeter v={vaccine} /> : null}
      <Funnel funnel={store.funnel} last={store.lastDecisionAt} />
    </header>
  );
}
