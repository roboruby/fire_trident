import { useEffect, useState } from "react";
import { fmtInt } from "../format.ts";
import type { MapRenderer } from "../map/renderer.ts";
import type { ColonyStore } from "../store.ts";

interface Reading {
  fps: number;
  p95: number;
  worst: number;
  workP95: number;
  workMax: number;
  eventsPerSec: number;
  files: number;
  marks: number;
  dots: number;
}

declare global {
  interface Window {
    /** Latest perf reading (?debug=1), for automated checks. */
    __ftPerf?: Reading;
  }
}

/** ?debug=1: frames per second, frame-time p95, events per second, and what the map is drawing. */
export function PerfReadout({ store, renderer }: { store: ColonyStore; renderer: MapRenderer | null }) {
  const [r, setR] = useState<Reading | null>(null);
  useEffect(() => {
    let lastAt = performance.now();
    let lastEv = store.eventsApplied;
    const timer = window.setInterval(() => {
      const now = performance.now();
      const st = renderer?.stats() ?? { fps: 0, p95: 0, worst: 0, workP95: 0, workMax: 0 };
      const reading: Reading = {
        fps: st.fps,
        p95: st.p95,
        worst: st.worst,
        workP95: st.workP95,
        workMax: st.workMax,
        eventsPerSec: ((store.eventsApplied - lastEv) * 1000) / Math.max(1, now - lastAt),
        files: store.files.length,
        marks: store.active.size,
        dots: store.dotCount,
      };
      lastAt = now;
      lastEv = store.eventsApplied;
      window.__ftPerf = reading;
      setR(reading);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [store, renderer]);
  if (!r) return null;
  const tone = r.fps >= 55 ? "good" : r.fps >= 40 ? "warn" : "bad";
  return (
    <div className={`perf perf-${tone}`} aria-hidden="true">
      <b>{r.fps.toFixed(0)} fps</b>
      <span>p95 {r.p95.toFixed(1)} ms</span>
      <span>worst {r.worst.toFixed(0)} ms</span>
      <span>work p95 {r.workP95.toFixed(1)} ms</span>
      <span>{fmtInt(r.eventsPerSec)} ev/s</span>
      <span>{fmtInt(r.files)} files</span>
      <span>{fmtInt(r.marks)} marked</span>
      <span>{fmtInt(r.dots)} agents</span>
    </div>
  );
}
