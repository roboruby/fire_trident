import { useEffect, useRef, type RefObject } from "react";
import { fmtInt, shortSha } from "../format.ts";
import type { ColonyStore } from "../store.ts";
import { FIELD_COLOR, KINDS } from "../theme.ts";
import { useThrottledVersion } from "../useStore.ts";
import { MapRenderer } from "./renderer.ts";

interface Props {
  store: ColonyStore;
  onPick: (path: string | null) => void;
}

/** The hero view: the colony as a living treemap, with the trunk rail across the top. */
export function ColonyMap({ store, onPick }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const base = useRef<HTMLCanvasElement>(null);
  const field = useRef<HTMLCanvasElement>(null);
  const glow = useRef<HTMLCanvasElement>(null);
  const labels = useRef<HTMLCanvasElement>(null);
  const fx = useRef<HTMLCanvasElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const sha = useRef<HTMLSpanElement>(null);
  const pick = useRef(onPick);
  pick.current = onPick;

  useEffect(() => {
    if (!wrap.current || !base.current || !field.current || !glow.current || !labels.current || !fx.current || !tip.current || !head.current || !sha.current) return;
    const renderer = new MapRenderer(
      store,
      { wrap: wrap.current, base: base.current, field: field.current, glow: glow.current, labels: labels.current, fx: fx.current, tip: tip.current, head: head.current, sha: sha.current },
      (path) => pick.current(path),
    );
    renderer.start();
    return () => renderer.stop();
  }, [store]);

  return (
    <section className="map" ref={wrap} aria-label="Colony map">
      <canvas className="map-layer" ref={base} />
      <canvas className="map-layer" ref={field} />
      <canvas className="map-layer map-glow" ref={glow} />
      <canvas className="map-layer map-labels" ref={labels} />
      <div className="map-vignette" />
      <TrunkBar store={store} headRef={head} shaRef={sha} />
      <canvas className="map-layer map-fx" ref={fx} />
      <Legend store={store} />
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

function Legend({ store }: { store: ColonyStore }) {
  useThrottledVersion(store, 500);
  return (
    <div className="legend">
      {KINDS.map((kind, k) => (
        <span className="legend-item" key={kind}>
          <i className={`legend-swatch legend-${kind}`} style={{ background: FIELD_COLOR[kind] }} />
          <span className="legend-name">{kind}</span>
          <span className="legend-count">{fmtInt(store.fieldCounts[k] ?? 0)}</span>
        </span>
      ))}
      <span className="legend-item">
        <i className="legend-dot" />
        <span className="legend-name">agents</span>
        <span className="legend-count">{fmtInt(store.dotCount)}</span>
      </span>
      <span className="legend-item">
        <i className="legend-spark" />
        <span className="legend-name">landing</span>
      </span>
      <span className="legend-hint">Hover a file for its field · click for its lineage</span>
    </div>
  );
}
