import { useEffect, useRef, type RefObject } from "react";
import { fmtInt, shortSha } from "../format.ts";
import type { ColonyStore } from "../store.ts";
import { FIELD_COLOR, KINDS } from "../theme.ts";
import { usePolled, useThrottledVersion } from "../useStore.ts";
import { MapRenderer } from "./renderer.ts";

interface Props {
  store: ColonyStore;
  onPick: (path: string | null) => void;
  /** Receives the renderer once it runs (and null when it stops), for camera control. */
  onRenderer?: (r: MapRenderer | null) => void;
  /** Director mode: no legend strip, no tooltips, no hint text. */
  director?: boolean;
  /** A compact frame (the landing page hero): no hint text. */
  compact?: boolean;
}

/** The hero view: the colony as a living treemap, with the trunk rail across the top. */
export function ColonyMap({ store, onPick, onRenderer, director = false, compact = false }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const base = useRef<HTMLCanvasElement>(null);
  const field = useRef<HTMLCanvasElement>(null);
  const glow = useRef<HTMLCanvasElement>(null);
  const labels = useRef<HTMLCanvasElement>(null);
  const fx = useRef<HTMLCanvasElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const sha = useRef<HTMLSpanElement>(null);
  const renderer = useRef<MapRenderer | null>(null);
  const pick = useRef(onPick);
  pick.current = onPick;
  const report = useRef(onRenderer);
  report.current = onRenderer;

  useEffect(() => {
    if (!wrap.current || !base.current || !field.current || !glow.current || !labels.current || !fx.current || !tip.current || !head.current || !sha.current) return;
    const r = new MapRenderer(
      store,
      { wrap: wrap.current, base: base.current, field: field.current, glow: glow.current, labels: labels.current, fx: fx.current, tip: tip.current, head: head.current, sha: sha.current },
      (path) => pick.current(path),
    );
    renderer.current = r;
    r.start();
    report.current?.(r);
    return () => {
      r.stop();
      renderer.current = null;
      report.current?.(null);
    };
  }, [store]);

  useEffect(() => {
    renderer.current?.setOptions({ legendH: director ? 0 : 34, tooltips: !director });
  }, [director]);

  return (
    <section className={`map${director ? " is-director" : ""}${compact ? " is-compact" : ""}`} ref={wrap} aria-label="Colony map">
      <canvas className="map-layer" ref={base} />
      <canvas className="map-layer" ref={field} />
      <canvas className="map-layer map-glow" ref={glow} />
      <canvas className="map-layer map-labels" ref={labels} />
      <div className="map-vignette" />
      <TrunkBar store={store} headRef={head} shaRef={sha} />
      <canvas className="map-layer map-fx" ref={fx} />
      {director ? null : <Legend store={store} hint={!compact} compact={compact} />}
      <div className="map-tip" ref={tip} role="tooltip" />
    </section>
  );
}

function TrunkBar({ store, headRef, shaRef }: { store: ColonyStore; headRef: RefObject<HTMLDivElement | null>; shaRef: RefObject<HTMLSpanElement | null> }) {
  useThrottledVersion(store, 1000);
  const branch = store.colony?.source?.branch ?? "main";
  return (
    <div className="trunk">
      <div className="trunk-label">
        <span className="trunk-title">Trunk</span>
        <span className="trunk-branch mono">{branch}</span>
      </div>
      <div className="trunk-head" ref={headRef}>
        <span className="trunk-k">head</span>
        <span className="trunk-sha mono" ref={shaRef} />
        {store.greenSha ? (
          <>
            <span className="trunk-k trunk-k-green">green</span>
            <span className="trunk-green mono" title={store.greenSha}>
              {shortSha(store.greenSha)}
            </span>
          </>
        ) : null}
      </div>
    </div>
  );
}

/** Field legend: how many files carry each kind of mark right now (decay included), and the agents on the map. */
export function Legend({ store, hint = true, compact = false }: { store: ColonyStore; hint?: boolean; compact?: boolean }) {
  // The renderer recounts the field as it decays, with or without new events; poll its counts.
  usePolled(() => `${store.fieldCounts.join(",")}|${store.dotCount}|${store.agentsWorking()}`, 400);
  return (
    <div className="legend">
      {KINDS.map((kind, k) => (
        <span className={`legend-item${(store.fieldCounts[k] ?? 0) > 0 ? "" : " is-zero"}`} key={kind} title={`Files with a ${kind} mark right now`}>
          <i className={`legend-swatch legend-${kind}`} style={{ background: FIELD_COLOR[kind] }} />
          <span className="legend-name">{kind}</span>
          <span className="legend-count">{fmtInt(store.fieldCounts[k] ?? 0)}</span>
        </span>
      ))}
      <span className="legend-item" title="Agents on the map (working now)">
        <i className="legend-dot" />
        <span className="legend-name">agents</span>
        <span className="legend-count">
          {fmtInt(store.dotCount)}
          {store.agentsWorking() > 0 && !compact ? <span className="legend-sub"> · {fmtInt(store.agentsWorking())} working</span> : null}
        </span>
      </span>
      {compact ? null : (
        <span className="legend-item">
          <i className="legend-spark" />
          <span className="legend-name">landing</span>
        </span>
      )}
      {hint ? <span className="legend-hint">Hover a file for its field · click for its lineage</span> : null}
    </div>
  );
}
