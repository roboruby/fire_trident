import type { FunnelStage } from "@fire_trident/core";
import { useAbout } from "../about.ts";
import { fmtDuration, fmtInt, fmtPct, fmtWhen } from "../format.ts";
import { STAGES, type ColonyStore, type ConnState, type ReplayInfo } from "../store.ts";
import { sparkPoints, type Series } from "../series.ts";
import { STAGE_COLOR } from "../theme.ts";
import { useThrottledVersion } from "../useStore.ts";
import { AnimatedNumber } from "./AnimatedNumber.tsx";
import { BuildTag } from "./BuildTag.tsx";
import { ColonyPicker } from "./ColonyPicker.tsx";
import { ConnectLinks } from "../connect/ConnectLinks.tsx";
import { SignedBy } from "./SignedBy.tsx";
import { RootCommit } from "./RootCommit.tsx";
import { SpendNote } from "./Spend.tsx";
import { VaccineMeter } from "./VaccineMeter.tsx";

const fmtSigma = (n: number): string => n.toFixed(2);

/** Product mark: a trident in the brand accent. */
export function TridentMark({ size = 30 }: { size?: number }) {
  return (
    <svg className="mark" viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
      <g fill="none" stroke="#f38020" strokeWidth="2.6" strokeLinecap="round">
        <path d="M16 6.5V29" />
        <path d="M7.5 9v4a8.5 8.5 0 0 0 17 0V9" />
      </g>
      <g fill="#f38020">
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
  replay: "Replay",
};

/** The feed state; a live feed from a colony with no agent alive says so, so a finished colony does not read as running. */
function ConnPill({ conn, replay, idle }: { conn: ConnState; replay: ReplayInfo | null; idle: boolean }) {
  if (replay) {
    const rebuilt = replay.source === "reconstructed";
    const title = `A replay of the run that started ${new Date(replay.startedAt).toLocaleString()}${rebuilt ? ", reconstructed from what the colony stores (claim times are estimated)" : ", from the events the colony recorded as it happened"}.`;
    return (
      <span className="conn conn-replay" title={title}>
        <i />
        Replay · {fmtWhen(replay.startedAt)}
        {rebuilt ? <b className="conn-tag">reconstructed</b> : null}
      </span>
    );
  }
  return (
    <span className={`conn conn-${conn}${conn === "live" && idle ? " conn-idle" : ""}`} title={conn === "live" && idle ? "Connected. No agent is working in this colony now." : undefined}>
      <i />
      {CONN_LABEL[conn]}
      {conn === "live" && idle ? " · idle" : null}
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

const STAGE_LABEL: Record<FunnelStage, string> = { proof: "Proof", reflex: "Reflex", llm: "LLM", human: "Human" };

/**
 * The reflex arc. With a server that reports settled proposals, four stages: each proposal counts
 * once, at the stage that settled it (a deterministic proof first, no model). Older servers and the
 * simulator report decisions per layer: three stages.
 */
function Funnel({ funnel, last, settled }: { funnel: Record<FunnelStage, number>; last: Record<FunnelStage, number>; settled: boolean }) {
  const stages = settled ? STAGES : STAGES.filter((s) => s !== "proof");
  const W = settled ? 256 : 240;
  const H = 26;
  const n = (l: FunnelStage) => Math.max(0, Number.isFinite(funnel[l]) ? funnel[l] : 0);
  const max = Math.max(1, ...stages.map(n));
  const total = stages.reduce((a, l) => a + n(l), 0);
  const height = (x: number) => 7 + (H - 7) * (Math.log10(x + 1) / Math.log10(max + 1));
  const hs = stages.map((l) => height(n(l)));
  const seg = W / stages.length;
  const now = Date.now();
  const share = !total
    ? settled
      ? "nothing settled yet"
      : "no decisions yet"
    : settled && n("proof") > 0
      ? `${fmtPct(n("proof") / total, 1)} by proof`
      : `${fmtPct(n("reflex") / total, 1)} at reflex`;
  const title = settled
    ? "Each proposal counts once, at the stage that settled it: a deterministic proof first (no model), then calibrated reflex models, then an LLM, then a person."
    : "Every decision goes to the cheapest layer that is confident: calibrated reflex models first, then an LLM, then a human.";
  return (
    <div className="funnel" title={title}>
      <div className="stat-k">
        Reflex arc <span className="funnel-share">{share}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="funnel-svg" aria-hidden="true">
        {stages.map((l, i) => {
          const hl = hs[i] ?? 8;
          const hr = i < stages.length - 1 ? (hs[i + 1] ?? 8) : hl * 0.72;
          const x0 = i * seg + (i ? 2 : 0);
          const x1 = (i + 1) * seg - 2;
          const d = `M${x0} ${(H - hl) / 2} L${x1} ${(H - hr) / 2} L${x1} ${(H + hr) / 2} L${x0} ${(H + hl) / 2} Z`;
          const hot = now - last[l] < 700;
          return <path key={`${l}-${hot ? last[l] : 0}`} d={d} className={`funnel-seg${hot ? " is-hot" : ""}`} style={{ fill: STAGE_COLOR[l], stroke: STAGE_COLOR[l] }} />;
        })}
      </svg>
      <div className="funnel-row" style={{ gridTemplateColumns: `repeat(${stages.length}, 1fr)`, width: W }}>
        {stages.map((l) => (
          <div className="funnel-cell" key={l}>
            <span className="funnel-label" style={{ color: STAGE_COLOR[l] }}>
              {STAGE_LABEL[l]}
            </span>
            <AnimatedNumber className="funnel-num" value={n(l)} duration={400} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** The top bar: brand and colony (with the key that signs its notes), the hero violations counter, live stats, sigma, vaccination, the reflex funnel and model spend. */
export function TopBar({ store, director = false, mock = false }: { store: ColonyStore; director?: boolean; mock?: boolean }) {
  useThrottledVersion(store, 200);
  // The build serving the page, after the product name (left out of director recordings).
  const about = useAbout();
  const now = store.now();
  const total = store.violations.total;
  const fixed = store.violationsFixed();
  const converged = store.convergedIn();
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
          <div className="brand-name">
            FireTrident
            {director ? null : <BuildTag about={about} className="brand-build" />}
          </div>
          <div className="brand-colony">
            {director ? <span className="mono brand-colony-name">{label}</span> : <ColonyPicker current={store.colonyId} label={label} mock={mock} />}
            <ConnPill conn={store.conn} replay={store.replay} idle={store.loaded && store.agentsActive() === 0} />
          </div>
          {director ? null : <SignedBy store={store} about={about} mock={mock} />}
          {director ? null : <RootCommit store={store} mock={mock} />}
          {/* Connect your agent (connect/ConnectLinks.tsx): this colony's connect page and its SKILL.md. */}
          {director || mock ? null : <ConnectLinks colonyId={store.colonyId} />}
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
            <div className={`hero-fixed${converged ? " is-converged" : ""}`} title={converged ? "Every violation found since the latest rule change, fixed: the time runs from the rule change to the last fix landing." : undefined}>
              {converged ? `${fmtInt(converged.fixed)} fixed in ${fmtDuration(converged.ms)}` : fixed > 0 || !landedIntents ? `${fmtInt(fixed)} fixed` : `${fmtInt(landedIntents)} intents landed`}
            </div>
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
      <Funnel funnel={store.funnel} last={store.lastDecisionAt} settled={store.settledFunnel} />
      <SpendNote spend={store.spend} />
    </header>
  );
}
