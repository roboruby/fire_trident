import { useCallback, useEffect, useRef, useState } from "react";
import type { Backend } from "../api.ts";
import type { Tab } from "../components/SidePanel.tsx";
import { TridentMark } from "../components/TopBar.tsx";
import { basename, fmtDuration, fmtInt, fmtPct } from "../format.ts";
import type { MapRenderer } from "../map/renderer.ts";
import type { ColonyStore } from "../store.ts";
import { KIND_INDEX, decayed } from "../theme.ts";
import { useThrottledVersion } from "../useStore.ts";
import { beatLimit, beatWaits, moveOnLine, watchBeat } from "./beat.ts";
import raw from "./script.json";

/** One scene of the director script (see script.json for the field reference). */
export interface Scene {
  id: string;
  caption: string;
  kicker?: string;
  sub?: string;
  title?: boolean;
  focus?: string | string[] | null;
  highlight?: string | string[];
  tab?: Tab;
  select?: string | string[];
  duration?: number;
  /** A top-bar widget to bring forward: hero, stats, sigma, vaccine, funnel, or trunk. */
  emphasize?: string;
  /** Set the caption in the code font (a command, a path). */
  code?: boolean;
  /** Data the scene needs (vaccine, landing, review, sigma, direction, mcp); scenes without it are skipped. */
  requires?: string;
  /** The longest this beat waits for what it shows before the director moves on, in ms (beat.ts; BEAT_MAX_MS when absent). */
  maxMs?: number;
}

const TABS: ReadonlySet<string> = new Set(["events", "intents", "review", "why"]);

/** Scenes from the JSON, keeping only well-formed ones. */
export function loadScenes(data: unknown): Scene[] {
  const list = (data as { scenes?: unknown })?.scenes;
  if (!Array.isArray(list)) return [];
  const strs = (x: unknown): string | string[] | undefined => (typeof x === "string" ? x : Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : undefined);
  return list
    .filter((s): s is Record<string, unknown> => !!s && typeof s === "object" && typeof (s as { caption?: unknown }).caption === "string")
    .map((s, i) => ({
      id: typeof s.id === "string" ? s.id : `scene-${i + 1}`,
      caption: String(s.caption),
      ...(typeof s.kicker === "string" ? { kicker: s.kicker } : {}),
      ...(typeof s.sub === "string" ? { sub: s.sub } : {}),
      ...(s.title === true ? { title: true } : {}),
      ...(s.focus === null ? { focus: null } : strs(s.focus) !== undefined ? { focus: strs(s.focus) } : {}),
      ...(strs(s.highlight) !== undefined ? { highlight: strs(s.highlight) } : {}),
      ...(typeof s.tab === "string" && TABS.has(s.tab) ? { tab: s.tab as Tab } : {}),
      ...(strs(s.select) !== undefined ? { select: strs(s.select) } : {}),
      ...(typeof s.duration === "number" && s.duration > 0 ? { duration: s.duration } : {}),
      ...(typeof s.emphasize === "string" ? { emphasize: s.emphasize } : {}),
      ...(s.code === true ? { code: true } : {}),
      ...(typeof s.requires === "string" ? { requires: s.requires } : {}),
      ...(typeof s.maxMs === "number" && Number.isFinite(s.maxMs) && s.maxMs > 0 ? { maxMs: s.maxMs } : {}),
    }));
}

const SCENES = loadScenes(raw);
/** Side panel width in director mode (keep in sync with .side.is-director in styles.css). */
const PANEL_W = 540;
/** Height of the caption block the camera keeps a focused region clear of. */
const CAPTION_H = 250;
const MAX_HIGHLIGHT = 3000;
/** How long the camera takes to frame a scene. */
const FOCUS_MS = 1600;
/** A read the side panel shows that has not answered yet (the Why tab's lineage skeleton). */
const READING = ".side.is-open .skeleton";

const asList = (x: string | string[] | undefined | null): string[] => (x === undefined || x === null ? [] : Array.isArray(x) ? x : [x]);

/** The file with the most activity right now (claims, needs, danger, fresh trails). */
function hottestFile(store: ColonyStore): string | null {
  const now = store.now();
  const wall = Date.now();
  let best: string | null = null;
  let bestW = 0;
  for (const cell of store.active) {
    const v = (k: number) => decayed(cell.v[k] ?? 0, cell.at[k] ?? 0, k, now);
    const recent = cell.trailAt ? Math.exp(-(wall - cell.trailAt) / 20_000) : 0;
    const w = v(KIND_INDEX.claim) * 1.2 + v(KIND_INDEX.need) * 0.6 + v(KIND_INDEX.danger) * 2 + recent;
    if (w > bestW) {
      bestW = w;
      best = cell.path;
    }
  }
  return best;
}

/** The file a scene selects for the Why tab. */
function resolveSelect(spec: string | string[] | undefined, store: ColonyStore): string | null {
  const known = new Set(store.files.map((f) => f.path));
  for (const s of asList(spec)) {
    if (s === "@landing") {
      for (let i = store.landings.length - 1; i >= 0; i--) {
        const p = store.landings[i]?.paths.find((x) => known.has(x));
        if (p) return p;
      }
    } else if (s === "@hot") {
      const p = hottestFile(store);
      if (p) return p;
    } else if (s === "@mcp") {
      // The latest change an outside agent (over MCP) landed.
      for (let i = store.outside.length - 1; i >= 0; i--) {
        const p = store.outside[i]?.paths.find((x) => known.has(x));
        if (p) return p;
      }
    } else if (known.has(s)) {
      return s;
    }
  }
  return null;
}

/** Files to outline: listed files, every file under a listed directory, or a computed set. */
function resolveHighlight(spec: string | string[] | undefined, store: ColonyStore): string[] {
  const out = new Set<string>();
  const now = store.now();
  for (const s of asList(spec)) {
    if (s === "@landing") {
      for (const p of store.landings[store.landings.length - 1]?.paths ?? []) out.add(p);
    } else if (s === "@needs") {
      for (const cell of store.active) {
        if (out.size >= MAX_HIGHLIGHT) break;
        if (decayed(cell.v[KIND_INDEX.need] ?? 0, cell.at[KIND_INDEX.need] ?? 0, KIND_INDEX.need, now) > 0.05) out.add(cell.path);
      }
    } else {
      const prefix = `${s.replace(/\/+$/, "")}/`;
      for (const f of store.files) {
        if (out.size >= MAX_HIGHLIGHT) break;
        if (f.path === s || f.path.startsWith(prefix)) out.add(f.path);
      }
    }
  }
  return [...out];
}

/** "2 intents amended, 1 withdrawn, 3 directives" (only what happened), or "no change of course". */
function directionLine(store: ColonyStore): string {
  const d = store.direction;
  const parts: string[] = [];
  if (d.amended) parts.push(`${fmtInt(d.amended)} ${d.amended === 1 ? "intent" : "intents"} amended`);
  if (d.withdrawn) parts.push(`${fmtInt(d.withdrawn)} withdrawn`);
  if (d.retracted) parts.push(`${fmtInt(d.retracted)} ${d.retracted === 1 ? "rule" : "rules"} retracted`);
  if (d.directives) parts.push(`${fmtInt(d.directives)} ${d.directives === 1 ? "directive" : "directives"} to agents`);
  return parts.length ? parts.join(", ") : "no change of course";
}

/** Live values for caption placeholders such as {violations}. */
function fill(text: string, store: ColonyStore): string {
  const f = store.funnel;
  const decisions = f.proof + f.reflex + f.llm + f.human;
  const v = store.vaccination();
  const converged = store.convergedIn();
  const fixed = store.violationsFixed();
  const outside = store.outside[store.outside.length - 1];
  const values: Record<string, string> = {
    colony: store.colony?.name ?? store.colonyId,
    files: fmtInt(store.files.length),
    violations: fmtInt(store.violations.total),
    fixed: fmtInt(fixed),
    fixedLine: converged ? `${fmtInt(converged.fixed)} fixed in ${fmtDuration(converged.ms)}` : `${fmtInt(fixed)} fixed`,
    fixedIn: converged ? fmtDuration(converged.ms) : "",
    agents: fmtInt(store.agentsActive()),
    working: fmtInt(store.agentsWorking()),
    landings: fmtInt(store.landingsTotal()),
    perMin: fmtInt(store.landingsPerMin()),
    decisions: fmtInt(decisions),
    proof: fmtInt(f.proof),
    proofPct: decisions ? fmtPct(f.proof / decisions, 1) : "0%",
    reflex: decisions ? fmtPct(f.reflex / decisions, 1) : "100%",
    llm: fmtInt(f.llm),
    human: fmtInt(f.human),
    review: fmtInt(store.reviewQueue()),
    sigma: store.sigmaMax().value.toFixed(2),
    recall: v?.recall != null ? fmtPct(v.recall) : "n/a",
    amended: fmtInt(store.direction.amended),
    withdrawn: fmtInt(store.direction.withdrawn),
    directives: fmtInt(store.direction.directives),
    direction: directionLine(store),
    mcpAgent: outside ? store.agentName(outside.agentId) : "an outside agent",
    mcpFile: outside?.paths[0] ? basename(outside.paths[0]) : "a change",
    mcpLanded: fmtInt(store.outside.length),
  };
  return text.replace(/\{(\w+)\}/g, (m, k: string) => values[k] ?? m);
}

/** Whether the colony has what a scene needs to make sense on screen. */
function available(scene: Scene | undefined, store: ColonyStore): boolean {
  if (!scene) return false;
  switch (scene.requires) {
    case "vaccine":
      return store.vaccination() !== null;
    case "landing":
      return store.landings.length > 0;
    case "review":
      return store.reviewQueue() > 0;
    case "sigma":
      return store.sigmaMax().value >= 0.85;
    case "direction": {
      const d = store.direction;
      return d.amended + d.withdrawn + d.retracted + d.directives > 0;
    }
    case "mcp":
      return store.outside.length > 0;
    default:
      return true;
  }
}

/** The top-bar element each emphasis names (it may be absent, e.g. no vaccination yet). The tour uses it too. */
export const EMPHASIS: Readonly<Record<string, string>> = {
  hero: ".top > .hero",
  stats: ".top > .stats",
  sigma: ".top > .gauge",
  vaccine: ".top > .vaccine",
  funnel: ".top > .funnel",
  trunk: ".trunk",
};

/** Scene to start on: ?scene=<number from 1> or ?scene=<id>. */
function initialScene(): number {
  const q = new URLSearchParams(location.search).get("scene");
  if (!q) return 0;
  const n = Number(q);
  if (Number.isInteger(n) && n >= 1 && n <= SCENES.length) return n - 1;
  const i = SCENES.findIndex((s) => s.id === q);
  return i >= 0 ? i : 0;
}

interface Props {
  store: ColonyStore;
  backend: Backend;
  renderer: MapRenderer | null;
  onTab: (t: Tab) => void;
  onPanel: (open: boolean) => void;
  panelOpen: boolean;
}

/** What the current beat still waits for, set when its scene is applied (see beat.ts). */
export interface Awaiting {
  /** The scene's select targets named no file yet. */
  select: boolean;
  /** The focus the camera could not frame yet, with the insets it was asked with. */
  focus: string | string[] | null;
  insets: { top: number; left: number; right: number; bottom: number };
  /** When the scene was applied (performance.now()). */
  appliedAt: number;
}

/**
 * One look at what the current beat waits for (beat.ts): a file to select that has appeared since the scene began (a
 * landing) is selected, a camera target that is on the map now is framed once the first move has settled, and what is
 * still missing comes back as clauses (empty when the beat waits for nothing). `reading`: a read on screen has not answered.
 */
export function probeBeat(scene: Scene, store: ColonyStore, w: Awaiting, renderer: MapRenderer | null, reading: boolean, now: number): string[] {
  if (scene.title) return [];
  if (w.select) {
    const path = resolveSelect(scene.select, store);
    if (path) {
      store.select(path);
      w.select = false;
    }
  }
  if (w.focus !== null && renderer && now - w.appliedAt > FOCUS_MS && renderer.focus(w.focus, { insets: w.insets, duration: FOCUS_MS })) w.focus = null;
  return beatWaits({
    requires: available(scene, store) ? null : (scene.requires ?? null),
    select: w.select ? asList(scene.select) : null,
    focus: w.focus === null ? null : asList(w.focus),
    reading,
  });
}

/**
 * Director mode (?director=1): scene-by-scene captions over the live map for recording at
 * 1920×1080. Each scene can zoom the camera into a region, outline files, open a side-panel
 * tab, and select a file. → next, ← previous, space pause, z zoom, c captions. A scene still
 * waiting for what it shows when its limit runs out (maxMs, beat.ts) moves on by itself.
 */
export function Director({ store, backend, renderer, onTab, onPanel, panelOpen }: Props) {
  useThrottledVersion(store, 500);
  const [index, setIndex] = useState(initialScene);
  const [paused, setPaused] = useState(false);
  const [zoomOn, setZoomOn] = useState(true);
  const [captions, setCaptions] = useState(true);
  const [startedAt, setStartedAt] = useState(() => performance.now());
  const [, setTick] = useState(0);
  const pausedAt = useRef(0);
  const awaiting = useRef<Awaiting>({ select: false, focus: null, insets: { top: 0, left: 0, right: 0, bottom: 0 }, appliedAt: 0 });
  const scene = SCENES[index];
  const total = SCENES.length;
  const loaded = store.loaded;

  const go = useCallback(
    (d: number) => {
      setIndex((i) => {
        // Step over scenes the colony has no data for; stay put if none is left in that direction.
        if (Math.abs(d) >= total) return d < 0 ? 0 : total - 1;
        for (let j = i + Math.sign(d); j >= 0 && j < total; j += Math.sign(d)) if (available(SCENES[j], store)) return j;
        return i;
      });
      setStartedAt(performance.now());
    },
    [total, store],
  );

  // Apply a scene: panel and tab, selection, outlines, then the camera (which keeps clear of the panel and captions).
  useEffect(() => {
    awaiting.current = { select: false, focus: null, insets: { top: 0, left: 0, right: 0, bottom: 0 }, appliedAt: performance.now() };
    if (!scene || !loaded) return;
    const wantPanel = !!scene.tab && !scene.title;
    if (scene.tab) onTab(scene.tab);
    onPanel(wantPanel);
    if (scene.title) return;
    const picked = resolveSelect(scene.select, store);
    store.select(picked);
    store.setHighlight(resolveHighlight(scene.highlight, store));
    const focus = zoomOn && scene.focus !== undefined ? scene.focus : null;
    // A region stays clear of the captions; the whole map runs full-bleed under them (beside the panel when it is open).
    const insets = { top: 0, left: 0, right: wantPanel ? PANEL_W : 0, bottom: focus !== null && captions ? CAPTION_H : 0 };
    const framed = renderer?.focus(focus, { insets, duration: FOCUS_MS }) ?? false;
    // What the beat still waits for: the beat's watch below selects and frames it once it appears, or moves on.
    awaiting.current = { select: asList(scene.select).length > 0 && picked === null, focus: focus !== null && !framed ? focus : null, insets, appliedAt: performance.now() };
    // Scene changes only; live data inside a scene does not move the camera (except to frame what the beat waited for).
  }, [index, renderer, loaded, zoomOn, captions]);

  // A scene can bring one top-bar widget forward; the rest of the bar recedes.
  useEffect(() => {
    const root = document.documentElement;
    const sel = scene?.emphasize ? EMPHASIS[scene.emphasize] : undefined;
    if (scene?.emphasize && !scene.title && sel && document.querySelector(sel)) root.dataset.emphasize = scene.emphasize;
    else delete root.dataset.emphasize;
    return () => {
      delete root.dataset.emphasize;
    };
  }, [scene]);

  // Pausing freezes auto-advance and, in the simulator, the colony's clock.
  useEffect(() => {
    backend.setPaused?.(paused);
    if (paused) pausedAt.current = performance.now();
    else if (pausedAt.current) {
      const held = performance.now() - pausedAt.current;
      pausedAt.current = 0;
      setStartedAt((t) => t + held);
    }
  }, [paused, backend]);

  // The hard timeout per beat (beat.ts): a scene still waiting for what it shows after its limit moves on, live or
  // recorded alike. A held beat (space) has no clock; the colony loading has none either (the overlay says why).
  useEffect(() => {
    const sc = SCENES[index];
    if (!sc || sc.title || !loaded || paused) return;
    const limitMs = beatLimit(sc);
    return watchBeat({
      from: Math.max(startedAt, awaiting.current.appliedAt),
      limitMs,
      now: () => performance.now(),
      probe: () => probeBeat(sc, store, awaiting.current, renderer, document.querySelector(READING) !== null, performance.now()),
      onExpire: (waits) => {
        console.warn(moveOnLine(index, total, sc.id, limitMs, waits));
        go(1);
      },
    });
  }, [index, loaded, paused, startedAt, total, go, renderer, store]);

  // Auto-advance for scenes with a duration; a 250ms tick also refreshes live caption values.
  useEffect(() => {
    const timer = window.setInterval(() => {
      setTick((t) => t + 1);
      const sc = SCENES[index];
      if (!sc?.duration || paused) return;
      if (performance.now() - startedAt >= sc.duration * 1000 && index < total - 1) go(1);
    }, 250);
    return () => window.clearInterval(timer);
  }, [index, paused, startedAt, total, go]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
      if (e.key === "ArrowRight" || e.key === "PageDown") go(1);
      else if (e.key === "ArrowLeft" || e.key === "PageUp") go(-1);
      else if (e.key === "Home") go(-total);
      else if (e.key === " " || e.code === "Space") setPaused((p) => !p);
      else if (e.key === "z" || e.key === "Z") setZoomOn((z) => !z);
      else if (e.key === "c" || e.key === "C") setCaptions((c) => !c);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, total]);

  // The cursor hides after a moment of stillness, so it never sits in a take.
  useEffect(() => {
    const root = document.documentElement;
    let timer = 0;
    const show = () => {
      root.classList.remove("cursor-hidden");
      window.clearTimeout(timer);
      timer = window.setTimeout(() => root.classList.add("cursor-hidden"), 1600);
    };
    show();
    window.addEventListener("pointermove", show);
    return () => {
      window.removeEventListener("pointermove", show);
      window.clearTimeout(timer);
      root.classList.remove("cursor-hidden");
    };
  }, []);

  const progress = scene?.duration ? Math.max(0, Math.min(1, ((paused ? pausedAt.current : performance.now()) - startedAt) / (scene.duration * 1000))) : null;
  const num = String(index + 1).padStart(2, "0");
  const caption = scene ? fill(scene.caption, store) : "";
  const sub = scene?.sub ? fill(scene.sub, store) : null;
  if (!scene) return null;

  return (
    <div className={`director${panelOpen ? " has-panel" : ""}${captions ? "" : " no-captions"}`}>
      <div className={`dir-shade${scene.title || !captions ? " is-off" : ""}`} />
      {scene.title ? null : (
        <div className="dir-caption" key={scene.id}>
          {scene.kicker ? (
            <div className="dir-kicker">
              <span className="dir-rule" />
              {scene.kicker}
            </div>
          ) : null}
          <div className={`dir-text${scene.code ? " is-code" : ""}`}>{caption}</div>
          {sub ? <div className="dir-sub">{sub}</div> : null}
        </div>
      )}
      <div className={`dir-title${scene.title ? " is-on" : ""}`} aria-hidden={!scene.title}>
        {scene.title ? (
          <div className="dir-title-inner" key={scene.id}>
            <TridentMark size={72} />
            {scene.kicker ? <div className="dir-title-kicker">{scene.kicker}</div> : null}
            <div className={`dir-title-text${scene.code ? " is-code" : ""}`}>{caption}</div>
            {sub ? <div className="dir-title-sub">{sub}</div> : null}
          </div>
        ) : null}
      </div>
      <div className="dir-lower">
        <span className="dir-lower-num mono">
          {num}
          <span> / {String(total).padStart(2, "0")}</span>
        </span>
        <span className="dir-lower-dots" aria-hidden="true">
          {SCENES.map((s, i) => (
            <i key={s.id} className={`${i < index ? "is-past" : i === index ? "is-now" : ""}${available(s, store) ? "" : " is-skip"}`} />
          ))}
        </span>
        {paused ? <span className="dir-lower-held">held</span> : null}
        {progress !== null ? (
          <span className="dir-lower-progress">
            <b style={{ transform: `scaleX(${progress})` }} />
          </span>
        ) : null}
      </div>
    </div>
  );
}
