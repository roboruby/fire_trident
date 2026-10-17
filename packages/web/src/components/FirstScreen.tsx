import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import type { PauseState } from "@fire_trident/core";
import type { Backend } from "../api.ts";
import { distanceAt, distanceOf, distanceSeries, runCurve, stepPath, windowCurve, type CurveData, type Distance } from "../distance.ts";
import { exceptionsOf, type Exceptions } from "../exceptions.ts";
import { fmtInt, plural } from "../format.ts";
import type { Need } from "../needs.ts";
import { pauseBanner } from "../pause.ts";
import { ReplayBackend } from "../replay.ts";
import type { ColonyStore } from "../store.ts";
import { readProtected, targetOf, type ProtectedPaths, type Target } from "../target.ts";
import { useThrottledVersion } from "../useStore.ts";
import { StuckList } from "./NeedsYou.tsx";
import "./firstscreen.css";

/**
 * The colony's first screen, over the map: its target (what it is asked to satisfy, from its own records), its
 * distance to it (open needs by kind, zero meaning done; a finished run's distance over time is its convergence curve),
 * and the exceptions strip (what needs a person now). No new mechanism: every number is a view over what the colony
 * records. The target's words (rules, intent titles, acceptance lines) are people's and agents': rendered as text.
 */

/** How often a live page reads the protected paths again (they change only when a person changes the policy). */
const PROTECTED_REFRESH_MS = 60_000;
/** Where this browser remembers that the viewer folded the panel. */
const FOLD_KEY = "ft.firstscreen";

/** Rules, acceptance lines and goals the summary names before "and N more". */
const SHOWN = 2;

function readFold(): boolean {
  try {
    return localStorage.getItem(FOLD_KEY) === "folded";
  } catch {
    return false;
  }
}

function writeFold(folded: boolean): void {
  try {
    if (folded) localStorage.setItem(FOLD_KEY, "folded");
    else localStorage.removeItem(FOLD_KEY);
  } catch {
    // Storage blocked: the panel opens unfolded next visit.
  }
}

/** "a, b and 3 more" from the first `shown` of `items`. */
function andMore(items: readonly string[], shown = SHOWN): string {
  const head = items.slice(0, shown);
  const more = items.length - head.length;
  return more > 0 ? `${head.join(", ")} and ${fmtInt(more)} more` : head.join(", ");
}

const CERT_WORD: Record<Target["cert"]["status"], string> = { green: "green", red: "red", running: "running", error: "could not run", skipped: "skipped", none: "not run yet" };

/** The target column: rules with who approved them, acceptance, protected paths, open goals, certification. */
export function TargetView({ target, open = false, onToggle }: { target: Target; open?: boolean; onToggle?: () => void }) {
  const { rules, acceptance, protectedPaths: pp, goals, cert } = target;
  const approvers = [...new Set(rules.map((r) => r.approvedBy))];
  return (
    <div className="fs-col fs-target">
      <div className="fs-head">
        <span className="fs-k">Target</span>
        <span className="fs-sub">what the colony is asked to satisfy</span>
        {onToggle ? (
          <button type="button" className="fs-toggle" aria-expanded={open} onClick={onToggle}>
            {open ? "Less" : "All of it"}
          </button>
        ) : null}
      </div>
      <dl className="fs-dl">
        <dt>Rules</dt>
        <dd title={rules.map((r) => `${r.description || r.head} (approved by ${r.approvedBy})`).join("\n") || undefined}>
          {rules.length === 0 ? (
            <span className="fs-none">none in force</span>
          ) : (
            <>
              <b>{fmtInt(rules.length)}</b> {rules.length === 1 ? "rule" : "rules"}, approved by {andMore(approvers, 3)}: <span className="fs-quote">{rules[0]?.head}</span>
              {rules.length > 1 ? <span className="fs-dim"> and {plural(rules.length - 1, "more")}</span> : null}
            </>
          )}
          {target.retracted > 0 ? <span className="fs-dim"> · {fmtInt(target.retracted)} retracted</span> : null}
        </dd>
        <dt>Acceptance</dt>
        <dd>
          {target.acceptanceLines === 0 ? (
            <span className="fs-none">no lines on open intents</span>
          ) : (
            <>
              <b>{fmtInt(target.acceptanceLines)}</b> {target.acceptanceLines === 1 ? "line" : "lines"} on {plural(acceptance.length, "open intent")}: <span className="fs-quote">{acceptance[0]?.lines[0]}</span>
            </>
          )}
        </dd>
        <dt>Protected</dt>
        <dd>
          {pp.state === "loading" ? (
            <span className="fs-none">reading the policy…</span>
          ) : pp.state === "unknown" ? (
            <span className="fs-none" title={`Not known: ${pp.why}.`}>
              not known: {pp.why}
            </span>
          ) : pp.globs.length === 0 ? (
            <span className="fs-none">no paths only a person may change</span>
          ) : (
            <span className="mono fs-globs">{andMore(pp.globs, 3)}</span>
          )}
        </dd>
        <dt>Goals</dt>
        <dd>
          {goals.people + goals.rules === 0 ? (
            <span className="fs-none">none open</span>
          ) : (
            <>
              <b>{fmtInt(goals.people + goals.rules)}</b> open: {fmtInt(goals.people)} from people, {fmtInt(goals.rules)} from rules
            </>
          )}
        </dd>
        <dt>Certified</dt>
        <dd className={`fs-cert fs-cert-${cert.status}`} title={cert.detail || undefined}>
          {cert.status === "none" ? (
            <span className="fs-none">tests not run yet</span>
          ) : (
            <>
              tests <b>{CERT_WORD[cert.status]}</b> on <span className="mono">{cert.sha}</span>
              {cert.detail ? <span className="fs-dim"> · {cert.detail}</span> : null}
            </>
          )}
          {" · "}
          {cert.certified ? (
            <>
              <span className="mono">certified</span> at <span className="mono">{cert.certified}</span>
              {cert.atHead === false ? <span className="fs-dim">, behind trunk</span> : cert.atHead ? <span className="fs-dim">, trunk&apos;s head</span> : null}
            </>
          ) : (
            <span className="fs-dim">
              no <span className="mono">certified</span> commit yet
            </span>
          )}
        </dd>
      </dl>
    </div>
  );
}

/** Everything in the target, listed: each rule with who approved it, each acceptance line, every protected path, the open goals. */
export function TargetDetails({ target }: { target: Target }) {
  const pp = target.protectedPaths;
  return (
    <div className="fs-detail" aria-label="The whole target">
      <section className="fs-detail-col">
        <h3 className="fs-detail-k">Rules in force</h3>
        {target.rules.length === 0 ? <p className="fs-none">No rule is in force.</p> : null}
        <ul className="fs-list">
          {target.rules.map((r) => (
            <li key={r.id} title={r.description}>
              <span className="fs-quote">{r.description || r.head}</span>
              <span className="fs-dim">
                {" "}
                approved by <b className="fs-who">{r.approvedBy}</b> · {r.open > 0 ? plural(r.open, "violation") + " open" : "satisfied"}
              </span>
            </li>
          ))}
        </ul>
      </section>
      <section className="fs-detail-col">
        <h3 className="fs-detail-k">Acceptance of open intents</h3>
        {target.acceptance.length === 0 ? <p className="fs-none">No open intent carries acceptance lines.</p> : null}
        <ul className="fs-list">
          {target.acceptance.slice(0, 20).map((a) => (
            <li key={a.intentId}>
              <span className="fs-title">{a.title}</span>
              <ol className="fs-lines">
                {a.lines.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ol>
            </li>
          ))}
        </ul>
        {target.acceptance.length > 20 ? <p className="fs-dim">{plural(target.acceptance.length - 20, "more intent")} with acceptance lines.</p> : null}
      </section>
      <section className="fs-detail-col">
        <h3 className="fs-detail-k">Protected paths</h3>
        {pp.state === "loaded" ? (
          pp.globs.length === 0 ? (
            <p className="fs-none">None: no path needs a person by policy alone.</p>
          ) : (
            <ul className="fs-list mono">
              {pp.globs.map((g) => (
                <li key={g}>{g}</li>
              ))}
            </ul>
          )
        ) : (
          <p className="fs-none">{pp.state === "loading" ? "Reading the decide policy…" : `Not known: ${pp.why}.`}</p>
        )}
        <h3 className="fs-detail-k">Open goals</h3>
        {target.goals.list.length === 0 ? <p className="fs-none">No goal from a person or a rule is open.</p> : null}
        <ul className="fs-list">
          {target.goals.list.slice(0, 12).map((g) => (
            <li key={g.id}>
              <span className="fs-title">{g.title}</span>
              <span className="fs-dim">
                {" "}
                · from {g.from === "people" ? "people" : "a rule"}, {g.status}
              </span>
            </li>
          ))}
        </ul>
        {target.goals.list.length > 12 ? <p className="fs-dim">{plural(target.goals.people + target.goals.rules - 12, "more goal")}.</p> : null}
      </section>
    </div>
  );
}

/** The distance column: the total (or "At target"), then one number per kind with what it is made of. */
export function DistanceView({ distance, replay = false }: { distance: Distance; replay?: boolean }) {
  return (
    <div className={`fs-col fs-distance${distance.atTarget ? " is-done" : ""}`}>
      <div className="fs-head">
        <span className="fs-k">Distance</span>
        <span className="fs-sub">{replay ? "open needs at this point of the run" : "open needs, by kind"}</span>
      </div>
      <div className="fs-total">
        {distance.atTarget ? (
          <span className="fs-at">At target</span>
        ) : (
          <>
            <span className="fs-total-n">{fmtInt(distance.total)}</span>
            <span className="fs-total-k">{distance.total === 1 ? "open need" : "open needs"}</span>
          </>
        )}
      </div>
      <ul className="fs-kinds">
        {distance.kinds.map((k) => (
          <li key={k.key} className={`fs-kind fs-kind-${k.key}${k.count === 0 ? " is-zero" : ""}`} title={`${k.title}${k.parts.length ? `\n${k.parts.map((p) => `${p.label}: ${fmtInt(p.count)}`).join("\n")}` : ""}`}>
            <b className="fs-kind-n">{fmtInt(k.count)}</b>
            <span className="fs-kind-label">{k.label}</span>
            {k.count > 0 && k.parts.length > 0 ? (
              <span className="fs-kind-parts">
                {k.parts
                  .slice(0, 2)
                  .map((p) => `${fmtInt(p.count)} ${p.label}`)
                  .join(" · ")}
                {k.parts.length > 2 ? ` · ${plural(k.parts.length - 2, "more")}` : ""}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

const CURVE_W = 260;
const CURVE_H = 56;

/** The distance over time: a finished run's convergence curve (its record) with the replay's time marked, or live violations. */
export function CurveView({ curve }: { curve: CurveData | null }) {
  const clip = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  if (!curve) {
    return (
      <div className="fs-col fs-curve is-empty">
        <div className="fs-head">
          <span className="fs-k">Over time</span>
        </div>
        <p className="fs-none">No history to draw yet. A replay draws its run&apos;s whole convergence curve from the record.</p>
      </div>
    );
  }
  const { points, t0, t1, max, now } = curve;
  const full = stepPath(points, t0, t1, CURVE_W, CURVE_H, max, 3);
  const nowX = now === null ? null : Math.max(0, Math.min(1, (now - t0) / (t1 - t0))) * CURVE_W;
  const zeroAt = curve.summary?.zeroAt ?? null;
  const zeroX = zeroAt === null ? null : Math.max(0, Math.min(1, (zeroAt - t0) / (t1 - t0))) * CURVE_W;
  const nowValue = now === null ? null : distanceAt(points, now);
  return (
    <div className="fs-col fs-curve">
      <div className="fs-head">
        <span className="fs-k">{curve.kind === "run" ? "Convergence" : "Over time"}</span>
        <span className="fs-sub">{curve.kind === "run" ? "distance over the run" : "from the per-minute history"}</span>
      </div>
      <svg className="fs-svg" viewBox={`0 0 ${CURVE_W} ${CURVE_H}`} preserveAspectRatio="none" role="img" aria-label={`${curve.caption}${nowValue !== null ? `; ${fmtInt(nowValue)} at this point` : ""}`}>
        <defs>
          <linearGradient id={`${clip}-fill`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="rgba(255,181,61,0.30)" />
            <stop offset="1" stopColor="rgba(255,181,61,0)" />
          </linearGradient>
          {nowX !== null ? (
            <clipPath id={`${clip}-played`}>
              <rect x="0" y="0" width={Math.max(0.5, nowX)} height={CURVE_H} />
            </clipPath>
          ) : null}
        </defs>
        <path d={full} className={`fs-line${nowX !== null ? " is-ahead" : ""}`} />
        <g clipPath={nowX !== null ? `url(#${clip}-played)` : undefined}>
          <path d={`${full} V${CURVE_H} H0 Z`} fill={`url(#${clip}-fill)`} stroke="none" />
          <path d={full} className="fs-line" />
        </g>
        {zeroX !== null ? <circle cx={zeroX} cy={CURVE_H - 3} r="2.6" className="fs-zero" /> : null}
        {nowX !== null ? <line x1={nowX} y1="0" x2={nowX} y2={CURVE_H} className="fs-now" /> : null}
      </svg>
      <div className="fs-caption">
        <span>{curve.caption}</span>
        {nowValue !== null ? <span className="fs-dim"> · {fmtInt(nowValue)} at this point</span> : null}
      </div>
    </div>
  );
}

/** The pause in force as the strip words it. */
function pauseText(p: PauseState): string {
  return `${p.scope === "deployment" ? "Deployment paused" : "Paused"} by ${p.by}: ${p.reason}`;
}

/**
 * The exceptions strip: each need a button to the tab that shows it (stuck work opens its list), the pause in force,
 * or a plain line saying nothing needs a person.
 */
export function ExceptionsView({
  exceptions,
  replay = false,
  colonyId = "",
  stuckOpen = false,
  onStuck,
  onGo,
  stuckList = null,
}: {
  exceptions: Exceptions;
  replay?: boolean;
  colonyId?: string;
  stuckOpen?: boolean;
  onStuck?: () => void;
  onGo?: (need: Need) => void;
  stuckList?: ReactNode;
}) {
  const { needs, pause } = exceptions;
  const quiet = needs.length === 0 && !pause;
  const banner = pause ? pauseBanner([pause], colonyId) : null;
  return (
    <section className={`fs-needs${quiet ? " is-quiet" : ""}`} aria-label="Exceptions: what needs a person">
      <span className="needs-k">{replay ? "Exceptions then" : "Exceptions"}</span>
      {quiet ? <span className="fs-quiet">{replay ? "Nothing needed a person at this point." : "Nothing needs a person."}</span> : null}
      {pause ? (
        <span className="need need-paused" role="status" title={banner?.detail}>
          <span className="need-label">{pauseText(pause)}</span>
        </span>
      ) : null}
      {needs.map((n) =>
        n.key === "stuck" ? (
          <button key={n.key} type="button" className={`need need-stuck${stuckOpen ? " is-open" : ""}`} title={n.title} aria-expanded={stuckOpen} onClick={onStuck}>
            {n.count > 0 ? <b className="need-n">{fmtInt(n.count)}</b> : null}
            <span className="need-label">{n.label}</span>
            <span className="need-caret" aria-hidden="true">
              {stuckOpen ? "▴" : "▾"}
            </span>
          </button>
        ) : (
          <button key={n.key} type="button" className={`need need-${n.key}`} title={n.title} onClick={() => onGo?.(n)}>
            {n.count > 0 ? <b className="need-n">{fmtInt(n.count)}</b> : null}
            <span className="need-label">{n.label}</span>
          </button>
        ),
      )}
      {stuckOpen ? stuckList : null}
    </section>
  );
}

/** The curve for this page: a replay's whole run from its record, or the live per-minute window. */
function useCurve(store: ColonyStore, backend: Backend): CurveData | null {
  const timeline = backend instanceof ReplayBackend ? backend.timeline : null;
  const points = useMemo(() => (timeline ? distanceSeries(timeline, store.rules.values(), (id) => store.learnedOrigin(id)) : null), [timeline, store]);
  if (timeline && points) {
    const state = backend instanceof ReplayBackend ? backend.state : null;
    return runCurve(points, state?.start ?? timeline.first, state?.end ?? timeline.last, store.now(), store.rules.values());
  }
  return windowCurve(store.series, store.violations.total);
}

/** The protected paths, read when the page opens (and every minute on a live page). */
function useProtected(colonyId: string, mode: Backend["mode"]): ProtectedPaths {
  const [pp, setPp] = useState<ProtectedPaths>({ state: "loading" });
  useEffect(() => {
    let live = true;
    const read = () => {
      if (document.hidden && mode === "live") return;
      void readProtected(colonyId, mode).then((next) => {
        if (live) setPp((cur) => (next.state === "unknown" && cur.state === "loaded" ? cur : next));
      });
    };
    read();
    const timer = mode === "live" ? window.setInterval(read, PROTECTED_REFRESH_MS) : 0;
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [colonyId, mode]);
  return pp;
}

/** The first screen over the map: target, distance and the convergence curve, then the exceptions strip; folds to one line. */
export function FirstScreen({ store, backend, onGo }: { store: ColonyStore; backend: Backend; onGo: (need: Need) => void }) {
  useThrottledVersion(store, 400);
  const [folded, setFolded] = useState(readFold);
  const [open, setOpen] = useState(false);
  const [stuckOpen, setStuckOpen] = useState(false);
  const pp = useProtected(store.colonyId, backend.mode);
  const curve = useCurve(store, backend);
  // An empty row while the colony loads keeps the page grid in place.
  if (!store.loaded) return <section className="fs is-loading" aria-hidden="true" />;
  const replay = store.replay !== null;
  const distance = distanceOf(store);
  const exceptions = exceptionsOf(store);
  const stuck = exceptions.needs.find((n) => n.key === "stuck");
  const strip = (
    <ExceptionsView
      exceptions={exceptions}
      replay={replay}
      colonyId={store.colony?.id ?? store.colonyId}
      stuckOpen={stuckOpen && !!stuck}
      onStuck={() => setStuckOpen(!stuckOpen)}
      onGo={onGo}
      stuckList={stuck ? <StuckList store={store} need={stuck} onGo={onGo} /> : null}
    />
  );
  const fold = (next: boolean) => {
    setFolded(next);
    writeFold(next);
  };
  if (folded) {
    return (
      <section className="fs is-folded" aria-label="Target, distance and exceptions">
        <div className="fs-fold-line">
          <span className="fs-k">Distance</span>
          <span className={`fs-fold-total${distance.atTarget ? " is-done" : ""}`}>{distance.atTarget ? "At target" : `${fmtInt(distance.total)} ${distance.total === 1 ? "open need" : "open needs"}`}</span>
          {strip}
          <button type="button" className="fs-toggle" onClick={() => fold(false)}>
            Show the target
          </button>
        </div>
      </section>
    );
  }
  const target = targetOf(store, pp);
  return (
    <section className="fs" aria-label="Target, distance and exceptions">
      <div className="fs-grid">
        <TargetView target={target} open={open} onToggle={() => setOpen(!open)} />
        <DistanceView distance={distance} replay={replay} />
        <CurveView curve={curve} />
        <button type="button" className="fs-toggle fs-fold" onClick={() => fold(true)} title="Fold the target into one line (this browser remembers)">
          Fold
        </button>
      </div>
      {open ? <TargetDetails target={target} /> : null}
      {strip}
    </section>
  );
}
