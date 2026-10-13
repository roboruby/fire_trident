import { useEffect, useRef, type RefObject } from "react";
import { fmtInt, shortSha } from "../format.ts";
import type { ColonyStore } from "../store.ts";
import { certCounts, certNotRun, certSuspects, certTitle } from "../certs.ts";
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
  /** Opens the first-visit guide again (a "How to read this" button in the legend). */
  onGuide?: () => void;
}

/** The hero view: the colony as a living treemap, with the trunk rail across the top. */
export function ColonyMap({ store, onPick, onRenderer, director = false, compact = false, onGuide }: Props) {
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
      {director ? null : <Legend store={store} hint={!compact} compact={compact} onGuide={onGuide} />}
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
        <CertBadge store={store} />
        {store.greenSha ? (
          <>
            <span className="trunk-k trunk-k-green" title="The certified branch: the newest trunk commit on which every test file that could run passed and no test that passed before was lost">
              certified
            </span>
            <span className="trunk-green mono" title={`certified: ${store.greenSha}`}>
              {shortSha(store.greenSha)}
            </span>
          </>
        ) : null}
      </div>
    </div>
  );
}

/** The head commit's trunk certification: a green check or a red cross with the counts (failing names, and a red result's suspects with their undo commands, on hover). */
function CertBadge({ store }: { store: ColonyStore }) {
  const hc = store.headCert();
  if (!hc || hc.cert.status === "skipped") return null;
  const { cert, onHead } = hc;
  if (cert.status === "running") {
    return (
      <span className="trunk-cert is-running" title={certTitle(cert)}>
        <i className="trunk-cert-spin" />
        testing
      </span>
    );
  }
  if (cert.status === "error") {
    return (
      <span className="trunk-cert is-muted" title={certTitle(cert)}>
        tests did not run
      </span>
    );
  }
  const green = cert.status === "green";
  const k = cert.counts;
  const failing = cert.failing ?? [];
  const notRun = certNotRun(cert);
  const suspects = green ? [] : certSuspects(cert, store.colony?.id ?? store.colonyId);
  return (
    <span className={`trunk-cert ${green ? "is-green" : "is-red"}${onHead ? "" : " is-stale"}`} tabIndex={0} aria-label={certTitle(cert)}>
      <b className="trunk-cert-mark">{green ? "✓" : "✗"}</b>
      {certCounts(cert)}
      {onHead ? null : <span className="trunk-cert-at mono">{shortSha(cert.trunkSha)}</span>}
      <span className="trunk-cert-pop" role="tooltip">
        <span className="trunk-cert-pop-head">
          {green ? (notRun ? `${fmtInt(k?.pass ?? 0)} of ${fmtInt(k?.tests ?? 0)} tests pass (${notRun})` : `All ${fmtInt(k?.pass ?? 0)} tests pass`) : `${fmtInt(k ? k.fail + k.cancelled : failing.length)} of ${fmtInt(k?.tests ?? 0)} tests failing${notRun ? ` (${notRun})` : ""}`} on <span className="mono">{shortSha(cert.trunkSha)}</span>
          {onHead ? "" : " (the newer head is waiting for its run)"}
        </span>
        {failing.slice(0, 8).map((f, i) => (
          <span className="trunk-cert-fail" key={`${f.file}:${f.name}:${i}`}>
            <b>{f.name}</b>
            <span className="mono">{f.file}</span>
            {f.error ? <em>{f.error}</em> : null}
          </span>
        ))}
        {failing.length > 8 ? <span className="trunk-cert-more">and {fmtInt(failing.length - 8)} more</span> : null}
        {suspects.length > 0 ? <span className="trunk-cert-more">Suspects, newest first (the changes under the failing tests):</span> : null}
        {suspects.map((s) => (
          <span className="trunk-cert-fail trunk-cert-suspect" key={s.key}>
            <b>{s.title || s.ref}</b>
            <span className="mono">{[s.title ? s.ref : "", s.paths ? `changed ${s.paths}` : "", s.commit, s.files ? `for ${s.files}` : ""].filter(Boolean).join(" · ")}</span>
            <code className="trunk-cert-undo">{s.undo}</code>
          </span>
        ))}
        <span className="trunk-cert-foot">
          node:test in a Dynamic Worker{typeof cert.durationMs === "number" ? ` · ${(cert.durationMs / 1000).toFixed(1)} s` : ""}
          {cert.reusedFrom ? ` · same tested files as ${shortSha(cert.reusedFrom)}` : ""}
        </span>
      </span>
    </span>
  );
}

/** Field legend: how many files carry each kind of mark right now (decay included), and the agents on the map. */
export function Legend({ store, hint = true, compact = false, onGuide }: { store: ColonyStore; hint?: boolean; compact?: boolean; onGuide?: (() => void) | undefined }) {
  // The renderer recounts the field as it decays, with or without new events; poll its counts.
  usePolled(() => `${store.fieldCounts.join(",")}|${store.dotCount}|${store.agentsWorking()}`, 400);
  return (
    <div className={`legend${onGuide ? " has-guide" : ""}`}>
      {KINDS.map((kind, k) => (
        <span className={`legend-item${(store.fieldCounts[k] ?? 0) > 0 ? "" : " is-zero"}`} key={kind} title={`Files with a ${kind} mark right now`}>
          <i className={`legend-swatch legend-${kind}`} style={{ background: FIELD_COLOR[kind] }} />
          <span className="legend-name">{kind}</span>
          <span className="legend-count">{fmtInt(store.fieldCounts[k] ?? 0)}</span>
        </span>
      ))}
      <span className="legend-item legend-agents" title="Agents on the map (working now)">
        <i className="legend-dot" />
        <span className="legend-name">agents</span>
        <span className="legend-count">
          {fmtInt(store.dotCount)}
          {store.agentsWorking() > 0 && !compact ? <span className="legend-sub"> · {fmtInt(store.agentsWorking())} working</span> : null}
        </span>
      </span>
      {compact ? null : (
        <span className="legend-item legend-landing">
          <i className="legend-spark" />
          <span className="legend-name">landing</span>
        </span>
      )}
      {hint ? <span className="legend-hint">Hover a file or an agent · click a file for its lineage</span> : null}
      {onGuide ? (
        <button type="button" className="legend-guide" onClick={onGuide} title="Open the guide to this screen again">
          How to read this
        </button>
      ) : null}
    </div>
  );
}
