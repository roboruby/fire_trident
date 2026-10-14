import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { fmtClock } from "../format.ts";
import { SPEEDS, type ReplayBackend, type ReplayState } from "../replay.ts";
import { colonyHref } from "../route.ts";

/**
 * Going back replays the record from its start, so in a record of more than BACK_SEEK_EVENTS events (thousands of agents)
 * a position behind the current one is applied once the scrubber or the arrow keys rest BACK_SEEK_MS, not once a frame or
 * once a key repeat. Smaller records seek as before.
 */
const BACK_SEEK_EVENTS = 20_000;
const BACK_SEEK_MS = 250;

function useReplayState(backend: ReplayBackend): ReplayState {
  return useSyncExternalStore(
    (notify) => backend.subscribe(notify),
    () => backend.state,
  );
}

function Icon({ name }: { name: "play" | "pause" | "again" }) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      {name === "play" ? <path d="M4 2.5v11l9.5-5.5z" fill="currentColor" /> : null}
      {name === "pause" ? (
        <g fill="currentColor">
          <rect x="3.5" y="2.5" width="3" height="11" rx="0.8" />
          <rect x="9.5" y="2.5" width="3" height="11" rx="0.8" />
        </g>
      ) : null}
      {name === "again" ? <path d="M8 2.5a5.5 5.5 0 1 1-5.2 3.7M2.5 2.8v3.4h3.4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /> : null}
    </svg>
  );
}

/**
 * Replay controls over the map: play and pause, the run's clock, a scrubber, the speed, and the way
 * back to the live colony. Space plays or pauses; the arrow keys step five seconds of the run times the speed.
 */
export function ReplayBar({ backend, colonyId }: { backend: ReplayBackend; colonyId: string }) {
  const s = useReplayState(backend);
  const pending = useRef<number | null>(null);
  const frame = useRef(0);
  // A position behind the current one, waiting BACK_SEEK_MS before it is applied (the scrubber shows it meanwhile).
  const [back, setBack] = useState<number | null>(null);
  const backTo = useRef<number | null>(null);
  const backTimer = useRef(0);
  const cancelBack = useCallback(() => {
    window.clearTimeout(backTimer.current);
    backTimer.current = 0;
    backTo.current = null;
    setBack(null);
  }, []);
  // Seek to `t`: forward at once, back once the request rests (in a large record).
  const go = useCallback(
    (t: number) => {
      if (t >= backend.state.at || backend.state.events <= BACK_SEEK_EVENTS) {
        cancelBack();
        backend.seek(t);
        return;
      }
      backTo.current = t;
      setBack(t);
      window.clearTimeout(backTimer.current);
      backTimer.current = window.setTimeout(() => {
        backTimer.current = 0;
        const v = backTo.current;
        backTo.current = null;
        setBack(null);
        if (v !== null) backend.seek(v);
      }, BACK_SEEK_MS);
    },
    [backend, cancelBack],
  );
  useEffect(() => () => window.clearTimeout(backTimer.current), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || e.metaKey || e.ctrlKey || e.altKey) return;
      const space = e.key === " " || e.code === "Space";
      // Space on a focused button or row presses that control, not the replay.
      if (space && t instanceof HTMLElement && t !== document.body && t.closest("button, a, summary, select, [tabindex]")) return;
      // Steps count from a position still waiting to be applied, so held keys add up.
      const from = backTo.current ?? backend.state.at;
      if (space) backend.toggle();
      else if (e.key === "ArrowRight") go(from + 5_000 * backend.state.speed);
      else if (e.key === "ArrowLeft") go(from - 5_000 * backend.state.speed);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [backend, go]);

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  // Dragging the scrubber seeks forward at most once a frame, and back once it rests.
  const scrub = (value: number) => {
    if (value < backend.state.at && backend.state.events > BACK_SEEK_EVENTS) {
      pending.current = null;
      go(value);
      return;
    }
    cancelBack();
    pending.current = value;
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const v = pending.current;
      pending.current = null;
      if (v !== null) backend.seek(v);
    });
  };

  if (!s.ready) return null;
  const span = Math.max(1, s.end - s.start);
  const at = Math.max(s.start, Math.min(s.end, back ?? s.at));
  const rebuilt = s.source === "reconstructed";
  return (
    <div className="replay-bar" role="group" aria-label="Replay controls">
      <button type="button" className="rp-play" onClick={() => backend.toggle()} aria-label={s.ended ? "Replay again" : s.playing ? "Pause" : "Play"} title={s.ended ? "Replay again" : s.playing ? "Pause (space)" : "Play (space)"}>
        <Icon name={s.ended ? "again" : s.playing ? "pause" : "play"} />
      </button>
      <span className="rp-time mono">
        {fmtClock(at - s.start)}
        <span> / {fmtClock(span)}</span>
      </span>
      <input
        className="rp-scrub"
        type="range"
        min={s.start}
        max={s.end}
        step={100}
        value={at}
        aria-label="Position in the run"
        style={{ "--rp-progress": `${(((at - s.start) / span) * 100).toFixed(2)}%` } as React.CSSProperties}
        onChange={(e) => scrub(Number(e.currentTarget.value))}
      />
      <div className="rp-speeds" role="radiogroup" aria-label="Speed">
        {SPEEDS.map((x) => (
          <button key={x} type="button" role="radio" aria-checked={s.speed === x} className={`rp-speed${s.speed === x ? " is-on" : ""}`} onClick={() => backend.setSpeed(x)}>
            {x}×
          </button>
        ))}
      </div>
      <span className={`rp-source${rebuilt ? " is-rebuilt" : ""}`} title={rebuilt ? "Rebuilt from what the colony stores: intents, proposals, decisions and landings with their times. Claim times are estimated." : "The events the colony recorded as they happened."}>
        {rebuilt ? "reconstructed" : "recorded"} · {s.events.toLocaleString("en-US")} events
      </span>
      <a className="rp-live" href={colonyHref(colonyId)} title="Leave the replay for the colony as it is now">
        Live view
      </a>
    </div>
  );
}
