import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Tab } from "../components/SidePanel.tsx";
import { EMPHASIS } from "../director/Director.tsx";
import { SERVER } from "../landing/RunIt.tsx";
import type { MapRenderer } from "../map/renderer.ts";
import type { ReplayBackend } from "../replay.ts";
import type { ColonyStore } from "../store.ts";
import { fillTour, tourSelection, travelSpeed, type TourData, type TourPlan, type TourStop } from "./tour.ts";
import { loadTourData, tourFor } from "./tours.ts";

/** The source repository (as on the landing page): the verify script's home. */
const REPO = "https://github.com/roboruby/fire_trident";
/** Files outlined at most (more dims the rest of the map). */
const MAX_HIGHLIGHT = 3000;

/** The step to start on: ?step=<number from 1> or ?step=<id>. */
function initialStep(plan: TourPlan): number {
  const q = new URLSearchParams(location.search).get("step");
  if (!q) return 0;
  const n = Number(q);
  if (Number.isInteger(n) && n >= 1 && n <= plan.stops.length) return n - 1;
  const i = plan.stops.findIndex((s) => s.step.id === q);
  return i >= 0 ? i : 0;
}

/** The files a step outlines: the moment's, or every file an intent still in play covers. */
function highlightFor(stop: TourStop, store: ColonyStore): string[] {
  if (stop.step.highlight === "@moment") return stop.moment.paths.slice(0, MAX_HIGHLIGHT);
  if (stop.step.highlight !== "@needs") return [];
  const out = new Set<string>();
  for (const it of store.intents.values()) {
    if (it.status !== "open" && it.status !== "claimed" && it.status !== "proposed") continue;
    for (const p of it.footprint) if (out.size < MAX_HIGHLIGHT) out.add(p);
  }
  return [...out];
}

function Icon({ name }: { name: "play" | "pause" }) {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      {name === "play" ? (
        <path d="M4 2.5v11l9.5-5.5z" fill="currentColor" />
      ) : (
        <g fill="currentColor">
          <rect x="3.5" y="2.5" width="3" height="11" rx="0.8" />
          <rect x="9.5" y="2.5" width="3" height="11" rx="0.8" />
        </g>
      )}
    </svg>
  );
}

/** Shell lines with a copy button; lines starting with # read as comments. */
function Commands({ lines }: { lines: string[] }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard
      ?.writeText(lines.join("\n"))
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => undefined);
  };
  return (
    <div className="tour-code">
      <button type="button" className="tour-copy" onClick={copy}>
        {copied ? "Copied" : "Copy"}
      </button>
      <pre className="mono">
        {lines.map((line, i) => (
          <span key={i} className={line.startsWith("#") ? "tour-comment" : undefined}>
            {line}
            {"\n"}
          </span>
        ))}
      </pre>
    </div>
  );
}

interface Shown {
  index: number;
  /** Bumped on every step shown, even the same one again (the hold restarts). */
  gen: number;
  text: string;
  commands: string[];
}

interface Props {
  store: ColonyStore;
  backend: ReplayBackend;
  renderer: MapRenderer | null;
  onTab: (t: Tab) => void;
  /** Leave the tour for the plain replay. */
  onClose: () => void;
  /** ?tour=<id>: another colony's tour script to play on this one (tours.ts); null for the colony's own. */
  script?: string | null;
}

/**
 * The tour of a finished run (?tour=1): a card over the map that walks the replay through about seven moments found in
 * the colony's own events (tours.ts: tour.json for a run a rule started, and a tour of its own for first-red and
 * order-backend), each told in one sentence filled from the record at that moment. Back, Next and Play (← → space);
 * playing holds each step, then plays the run on to the next moment, faster over long stretches. The map and the side
 * panel stay live: hover, click a file, switch tabs.
 */
export function Tour({ store, backend, renderer, onTab, onClose, script = null }: Props) {
  const replay = useSyncExternalStore(
    (notify) => backend.subscribe(notify),
    () => backend.state,
  );
  const tour = useMemo(() => tourFor(store.colonyId, script), [store, script]);
  const [plan, setPlan] = useState<TourPlan | null>(null);
  /** What the tour read from the public API besides the record (its reads), once planned. */
  const data = useRef<TourData>({});
  const [shown, setShown] = useState<Shown | null>(null);
  const [playing, setPlaying] = useState(true);
  const [travel, setTravel] = useState<{ from: number; to: number; speed: number } | null>(null);
  const [, setTick] = useState(0);
  const hold = useRef({ gen: 0, left: 0, total: 1, startedAt: 0 });
  const card = useRef<HTMLElement>(null);

  // The plan, once the record is loaded: the tour's public reads first, then each step on its moment, in the order the run went.
  useEffect(() => {
    const timeline = backend.timeline;
    if (!replay.ready || plan || !timeline) return;
    let gone = false;
    const get = (suffix: string): Promise<unknown> =>
      fetch(`/api/colonies/${encodeURIComponent(store.colonyId)}${suffix}`, { headers: { accept: "application/json" } }).then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))));
    void loadTourData(tour, get).then((read) => {
      if (gone) return;
      data.current = read;
      setPlan(tour.plan(timeline, store, read, replay.source));
    });
    return () => {
      gone = true;
    };
  }, [replay.ready, replay.source, plan, backend, store, tour]);

  /** Show step `i`: the replay at its moment (paused), the view it asks for, and its sentence filled from there. */
  const go = useCallback(
    (i: number) => {
      const stop = plan?.stops[Math.max(0, Math.min((plan?.stops.length ?? 1) - 1, i))];
      if (!plan || !stop) return;
      const index = plan.stops.indexOf(stop);
      setTravel(null);
      backend.seek(stop.at);
      backend.setPaused(true);
      if (stop.step.tab) onTab(stop.step.tab);
      if (stop.step.select) {
        const sel = tourSelection(stop, store, plan);
        store.select(sel?.path ?? null, sel?.line ?? null);
      }
      store.setHighlight(highlightFor(stop, store));
      const values = tour.values(stop, store, plan, data.current);
      const gen = hold.current.gen + 1;
      hold.current = { gen, left: stop.step.duration * 1000, total: stop.step.duration * 1000, startedAt: performance.now() };
      setShown({ index, gen, text: fillTour(stop.caption, values), commands: (stop.step.commands ?? []).map((l) => fillTour(l, { ...values, server: SERVER, repo: REPO })) });
    },
    [plan, backend, store, onTab, tour],
  );

  // Start on the first step (or ?step=) once planned.
  useEffect(() => {
    if (plan && !shown && plan.stops.length) go(initialStep(plan));
  }, [plan, shown, go]);

  /** After a step's hold: play on to the next moment (or jump, when it is far), or stop at the last. */
  const advance = useCallback(() => {
    if (!plan || !shown) return;
    const next = plan.stops[shown.index + 1];
    if (!next) {
      setPlaying(false);
      return;
    }
    const vt = backend.state.at;
    const speed = travelSpeed(next.at - vt);
    if (next.at <= vt || speed === null) {
      go(shown.index + 1);
      return;
    }
    setTravel({ from: vt, to: next.at, speed });
    backend.playTo(next.at, speed, () => go(shown.index + 1));
  }, [plan, shown, backend, go]);

  // The hold: while playing, each step stays for its duration (what is left of it after a pause).
  useEffect(() => {
    if (!shown || !playing || travel) return;
    const gen = shown.gen;
    const started = performance.now();
    hold.current.startedAt = started;
    const timer = window.setTimeout(advance, hold.current.left);
    const ticker = window.setInterval(() => setTick((t) => t + 1), 200);
    return () => {
      window.clearTimeout(timer);
      window.clearInterval(ticker);
      if (hold.current.gen === gen) hold.current.left = Math.max(0, hold.current.left - (performance.now() - started));
    };
  }, [shown, playing, travel, advance]);

  const toggle = useCallback(() => {
    if (!plan || !shown) return;
    if (playing) {
      setPlaying(false);
      // A pause on the way to the next moment stays where the run is; Play goes on from there.
      if (travel) backend.setPaused(true);
      return;
    }
    if (!travel && shown.index >= plan.stops.length - 1 && hold.current.left <= 0) {
      // The tour is over: Play starts it again.
      go(0);
    } else if (travel) {
      advance();
    }
    setPlaying(true);
  }, [plan, shown, playing, travel, backend, go, advance]);

  const step = useCallback((d: number) => shown && go(shown.index + d), [shown, go]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return;
      const space = e.key === " " || e.code === "Space";
      // Space on a focused button or link presses it instead.
      if (space && t instanceof HTMLElement && t !== document.body && t.closest("button, a, summary, [tabindex]")) return;
      if (e.key === "ArrowRight" || e.key === "PageDown") step(1);
      else if (e.key === "ArrowLeft" || e.key === "PageUp") step(-1);
      else if (e.key === "Home") go(0);
      else if (e.key === "End") go((plan?.stops.length ?? 1) - 1);
      else if (space) toggle();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, go, toggle, plan]);

  // The camera, once the card shows the step (a focused region stays clear of the card).
  const stop = plan && shown ? plan.stops[shown.index] : undefined;
  useEffect(() => {
    if (!stop || !renderer) return;
    const spec = stop.step.focus === "@moment" ? (stop.moment.paths[0] ?? null) : stop.step.focus === "@selected" ? store.selectedPath : null;
    const h = card.current?.getBoundingClientRect().height ?? 0;
    renderer.focus(spec, { insets: { bottom: spec ? h + 52 : 0 }, duration: 1400 });
  }, [stop, renderer, store]);

  // A step can bring one top-bar widget forward, as director mode does.
  useEffect(() => {
    const root = document.documentElement;
    const sel = stop?.emphasize ? EMPHASIS[stop.emphasize] : undefined;
    if (stop?.emphasize && sel && document.querySelector(sel)) root.dataset.emphasize = stop.emphasize;
    else delete root.dataset.emphasize;
  }, [stop]);

  // Leaving the tour keeps the replay where it is and the selection, and gives the map back whole.
  const view = useRef(renderer);
  view.current = renderer;
  useEffect(
    () => () => {
      delete document.documentElement.dataset.emphasize;
      store.setHighlight([]);
      view.current?.focus(null, { duration: 900 });
      if (backend.state.playing) backend.setPaused(true);
    },
    [store, backend],
  );

  if (!replay.ready || !plan) return null;
  if (!plan.stops.length || !stop || !shown) {
    return (
      <section className="tour" role="region" aria-label="Tour of this run">
        <p className="tour-text">This run's record holds none of the moments the tour tells, so there is nothing to tour here. The replay shows the whole run.</p>
        <div className="tour-foot">
          <button type="button" className="btn btn-approve tour-btn" onClick={onClose}>
            Watch the replay
          </button>
        </div>
      </section>
    );
  }
  const n = plan.stops.length;
  const last = shown.index === n - 1;
  const rebuilt = replay.source === "reconstructed";
  const holding = playing && !travel && hold.current.gen === shown.gen;
  const progress = travel
    ? Math.max(0, Math.min(1, (replay.at - travel.from) / Math.max(1, travel.to - travel.from)))
    : holding
      ? Math.max(0, Math.min(1, 1 - (hold.current.left - (performance.now() - hold.current.startedAt)) / hold.current.total))
      : null;
  return (
    <section
      ref={card}
      className={`tour${shown.commands.length ? " has-code" : ""}`}
      role="region"
      aria-label="Tour of this run"
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        onClose();
      }}
    >
      <div className="tour-head">
        <span className="tour-k">
          Tour · {shown.index + 1}/{n}
          {stop.kicker ? <span className="tour-kicker"> · {stop.kicker}</span> : null}
        </span>
        <span
          className={`tour-src${rebuilt ? " is-rebuilt" : ""}`}
          title={
            rebuilt
              ? "Rebuilt from what the colony stores: intents, proposals, decisions and landings with their times. Claim times are estimated."
              : "The events the colony recorded as they happened."
          }
        >
          {rebuilt ? (stop.step.estimated ? "claim times estimated" : "reconstructed record") : "recorded"}
        </span>
        <button type="button" className="tour-x" aria-label="Leave the tour" title="Leave the tour (the replay stays)" onClick={onClose}>
          ×
        </button>
      </div>
      <p className="tour-text" aria-live="polite" key={shown.gen}>
        {shown.text}
      </p>
      {shown.commands.length ? <Commands lines={shown.commands} /> : null}
      <div className={`tour-progress${progress === null ? " is-idle" : ""}`} aria-hidden="true">
        <b style={{ transform: `scaleX(${progress ?? 0})` }} />
        {travel ? <span className="tour-travel">{playing ? `playing on at ${travel.speed}×` : "paused on the way to the next step"}</span> : null}
      </div>
      <div className="tour-foot">
        <span className="tour-dots">
          {plan.stops.map((s, j) => (
            <button
              key={s.step.id}
              type="button"
              className={j === shown.index ? "is-on" : j < shown.index ? "is-past" : undefined}
              aria-label={`Step ${j + 1}${s.kicker ? `: ${s.kicker}` : ""}`}
              title={s.kicker || `Step ${j + 1}`}
              onClick={() => go(j)}
            />
          ))}
        </span>
        <button type="button" className="btn tour-btn" onClick={() => step(-1)} disabled={shown.index === 0} title="Back (←)">
          Back
        </button>
        <button type="button" className="btn tour-btn tour-play" onClick={toggle} aria-label={playing ? "Pause the tour" : "Play the tour"} title={playing ? "Pause (space)" : "Play (space)"}>
          <Icon name={playing ? "pause" : "play"} />
          {playing ? "Pause" : "Play"}
        </button>
        {last ? (
          <button type="button" className="btn btn-approve tour-btn" onClick={onClose} title="Leave the tour for the replay">
            Done
          </button>
        ) : (
          <button type="button" className="btn btn-approve tour-btn" onClick={() => step(1)} title="Next (→)">
            Next
          </button>
        )}
      </div>
    </section>
  );
}
