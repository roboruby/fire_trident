import type { AgentKind, AgentState } from "@fire_trident/core";
import { basename, dirname, escapeHtml, fmtBytes, regionOf, shortSha } from "../format.ts";
import type { AgentView, ColonyStore, LandingView } from "../store.ts";
import { ACCENT, FIELD_COLOR, FIELD_COLOR_BY_INDEX, KIND_INDEX, KINDS, decayed, intensity } from "../theme.ts";
import { layoutTreemap, type Rect, type TreemapLayout } from "../treemap.ts";

/** Height (CSS px) of the trunk strip at the top of the map. */
export const TRUNK_H = 56;
/** Left edge of the trunk rail (after the TRUNK label). */
const RAIL_X0 = 160;
const PAD = 10;
const GLOW_SCALE = 0.5;
const MAX_DOTS = 16_000;
/** Field opacity is quantized into this many levels so each level draws as one path. */
const LEVELS = 12;
const SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const MONO = 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

const TRAIL = KIND_INDEX.trail;
const DANGER = KIND_INDEX.danger;
/** Salience per kind when choosing a tile's color: danger > claim > failure > need > trail. */
const WEIGHT = [1.0, 1.6, 0.7, 1.45, 2.1];
const ALPHA0 = [0.26, 0.32, 0.1, 0.26, 0.36];
const ALPHA1 = [0.7, 0.62, 0.42, 0.5, 0.58];
const GLOW = [0.24, 0.42, 0.1, 0.22, 0.8];
/** Body opacity of large tiles relative to their edge, per kind (need stays warm and solid). */
const BODY = [0.7, 0.5, 0.46, 0.55, 0.62];
/** Base tints for file groups (code, ui, test, data, docs, config, other). */
const GROUP_TINT = ["#111a27", "#14192b", "#101b1f", "#16171f", "#17191e", "#141821", "#12161c"];
/** Minimum display intensity for a file to count toward the legend. */
const COUNT_AT = 0.06;
/** Closest the camera frames a region (more loses the map around it). */
const MAX_ZOOM = 2.8;
/** Highlights larger than this dim everything else (a spotlight) instead of outlining each file. */
const SPOTLIGHT_AT = 40;

const easeOut = (u: number): number => 1 - (1 - u) ** 3;
const easeInOut = (u: number): number => (u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2);
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

interface Dot {
  id: string;
  /** Position and target in world (layout) coordinates. */
  x: number;
  y: number;
  tx: number;
  ty: number;
  px: number;
  py: number;
  tile: number;
  state: AgentState;
  kind: AgentKind;
  dying: number;
  /** rAF time the dot appeared (it fades in where its agent works). */
  born: number;
  wanderAt: number;
  /** True while flying to a new tile (only then does it leave a trail). */
  travel: boolean;
}

interface Flight {
  sha: string;
  size: number;
  arrived: boolean;
}

interface Spark {
  tile: number;
  /** Control-point shape, fixed at launch. */
  a: number;
  b: number;
  t0: number;
  dur: number;
  flight: Flight;
}

interface Flash {
  tile: number;
  k: number;
  t0: number;
  dur: number;
}

/** Camera: screen = world * s + (tx, ty). */
interface Cam {
  s: number;
  tx: number;
  ty: number;
}

/** Screen-space margins the camera keeps a focused region clear of (captions, a side panel). */
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Display options that differ between the console and director mode. */
export interface MapOptions {
  /** Height reserved at the bottom for the legend. */
  legendH: number;
  /** Hover tooltips. */
  tooltips: boolean;
}

/** DOM nodes the renderer draws into or updates directly. */
export interface MapElements {
  wrap: HTMLElement;
  base: HTMLCanvasElement;
  field: HTMLCanvasElement;
  glow: HTMLCanvasElement;
  labels: HTMLCanvasElement;
  fx: HTMLCanvasElement;
  tip: HTMLElement;
  head: HTMLElement;
  sha: HTMLElement;
}

/** Frame-time statistics for the perf readout (?perf=1). */
export interface FrameStats {
  fps: number;
  p95: number;
  worst: number;
  /** Time spent inside the frame callback (ms): the work that decides whether 60 fps is possible. */
  workP95: number;
  workMax: number;
}

function ctx2d(c: HTMLCanvasElement, alpha = true): CanvasRenderingContext2D {
  const ctx = c.getContext("2d", { alpha });
  if (!ctx) throw new Error("canvas 2d unavailable");
  return ctx;
}

/**
 * The colony map: a squarified treemap of files on layered canvases.
 * base (static tiles) < field (marks, redrawn when they change or decay)
 * < glow (half-res copy, CSS-blurred, screen-blended) < labels < fx (agents, sparks, outlines; every frame).
 * A camera (screen = world · s + t) zooms and pans every layer; base and labels redraw
 * only when the layout or the camera changes. Reads the store directly; never goes through React.
 */
export class MapRenderer {
  private readonly bctx: CanvasRenderingContext2D;
  private readonly fctx: CanvasRenderingContext2D;
  private readonly gctx: CanvasRenderingContext2D;
  private readonly lctx: CanvasRenderingContext2D;
  private readonly xctx: CanvasRenderingContext2D;
  private L: TreemapLayout = layoutTreemap([], { x: 0, y: 0, w: 0, h: 0 });
  private A: Rect = { x: 0, y: 0, w: 0, h: 0 };
  private layoutGen = 0;
  private W = 1;
  private H = 1;
  private dpr = 1;
  /** CSS scale of the stage (director mode letterboxes a fixed 1920×1080 stage). */
  private stageScale = 1;
  private headX = 600;
  private filesVersion = -1;
  private raf = 0;
  private lastTs = 0;
  private lastField = 0;
  private fieldAnimating = false;
  private sizeDirty = true;
  private observer: ResizeObserver | null = null;
  private opts: MapOptions = { legendH: 34, tooltips: true };

  // Camera.
  private cam: Cam = { s: 1, tx: 0, ty: 0 };
  private camGen = 0;
  private camFrom: Rect | null = null;
  private camTo: Rect | null = null;
  private camT0 = 0;
  private camDur = 1;
  private focusSpec: string | string[] | null = null;
  private focusInsets: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
  private baseDirty = true;

  // Tiles in screen space for the current camera.
  private sGen = -1;
  private sLayout = -1;
  private SX = new Float32Array(0);
  private SY = new Float32Array(0);
  private SW = new Float32Array(0);
  private SH = new Float32Array(0);
  private VIS = new Uint8Array(0);

  private readonly dots = new Map<string, Dot>();
  private readonly dotBuf = [new Float32Array(MAX_DOTS * 3), new Float32Array(MAX_DOTS * 3), new Float32Array(MAX_DOTS * 3)];
  private readonly dotLen = [0, 0, 0];
  private sparks: Spark[] = [];
  private flashes: Flash[] = [];
  private bursts: Array<{ x: number; y: number; t0: number }> = [];
  private ripples: Array<{ x: number; y: number; t0: number }> = [];
  private beads: Array<{ size: number; t0: number }> = [];
  private beadsSeeded = false;
  private lastBeadAt = -1e9;
  private lastArriveAt = -1e9;
  private displayedSha = "";
  private inFlight = 0;

  private readonly vals = new Float64Array(5);
  private readonly inten = new Float64Array(5);
  /** Per kind and opacity level: tile indices (field), stripes per kind, glow per kind and level. */
  private readonly levels: number[][] = Array.from({ length: 5 * LEVELS }, () => []);
  private readonly stripes: number[][] = [[], [], [], [], []];
  private readonly glows: number[][] = Array.from({ length: 5 * LEVELS }, () => []);

  private mx = -1;
  private my = -1;
  private mouseDirty = false;
  private hover = -1;
  private lastTip = 0;
  private tipHtml = "";
  private tipShown = false;

  private hlRef: readonly string[] | null = null;
  private hlGen = -1;
  private hlMask = new Uint8Array(0);
  private hlCount = 0;
  private hlAt = 0;

  private readonly frameMs: number[] = [];
  private readonly workMs: number[] = [];

  constructor(
    private readonly store: ColonyStore,
    private readonly el: MapElements,
    private readonly onPick: (path: string | null) => void,
  ) {
    this.bctx = ctx2d(el.base, false);
    this.fctx = ctx2d(el.field);
    this.gctx = ctx2d(el.glow);
    this.lctx = ctx2d(el.labels);
    this.xctx = ctx2d(el.fx);
  }

  /** Begin observing size and pointer, and start the frame loop. */
  start(): void {
    this.observer = new ResizeObserver(() => {
      this.sizeDirty = true;
    });
    this.observer.observe(this.el.wrap);
    this.observer.observe(this.el.head);
    this.el.wrap.addEventListener("pointermove", this.onMove);
    this.el.wrap.addEventListener("pointerleave", this.onLeave);
    this.el.wrap.addEventListener("click", this.onClick);
    this.raf = requestAnimationFrame(this.frame);
  }

  /** Stop the loop and detach listeners. */
  stop(): void {
    cancelAnimationFrame(this.raf);
    this.observer?.disconnect();
    this.el.wrap.removeEventListener("pointermove", this.onMove);
    this.el.wrap.removeEventListener("pointerleave", this.onLeave);
    this.el.wrap.removeEventListener("click", this.onClick);
  }

  /** Change display options (director mode hides the legend strip and tooltips). */
  setOptions(o: Partial<MapOptions>): void {
    const legendChanged = o.legendH !== undefined && o.legendH !== this.opts.legendH;
    this.opts = { ...this.opts, ...o };
    if (!this.opts.tooltips) {
      this.hover = -1;
      this.el.tip.style.opacity = "0";
      this.tipShown = false;
    }
    if (legendChanged) this.sizeDirty = true;
  }

  /** Frame statistics over the last ~2 seconds. */
  stats(): FrameStats {
    const list = this.frameMs;
    if (list.length < 2) return { fps: 0, p95: 0, worst: 0, workP95: 0, workMax: 0 };
    const total = list.reduce((a, b) => a + b, 0);
    const sorted = [...list].sort((a, b) => a - b);
    const work = [...this.workMs].sort((a, b) => a - b);
    return {
      fps: total > 0 ? (list.length * 1000) / total : 0,
      p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
      worst: sorted[sorted.length - 1] ?? 0,
      workP95: work[Math.floor(work.length * 0.95)] ?? 0,
      workMax: work[work.length - 1] ?? 0,
    };
  }

  private toStage(e: { clientX: number; clientY: number }): void {
    const r = this.el.wrap.getBoundingClientRect();
    const k = this.stageScale || 1;
    this.mx = (e.clientX - r.left) / k;
    this.my = (e.clientY - r.top) / k;
  }

  private onMove = (e: PointerEvent): void => {
    this.toStage(e);
    this.mouseDirty = true;
  };

  private onLeave = (): void => {
    this.mx = -1;
    this.my = -1;
    this.mouseDirty = true;
  };

  private onClick = (e: MouseEvent): void => {
    this.toStage(e);
    this.hitTest();
    if (this.my < TRUNK_H) return;
    this.onPick(this.hover >= 0 ? (this.L.paths[this.hover] ?? null) : null);
  };

  // -- sizing and layout -----------------------------------------------------

  private resize(): void {
    const wrap = this.el.wrap;
    const rect = wrap.getBoundingClientRect();
    const W = Math.max(1, wrap.clientWidth || Math.round(rect.width));
    const H = Math.max(1, wrap.clientHeight || Math.round(rect.height));
    this.stageScale = rect.width > 0 ? rect.width / W : 1;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.W = W;
    this.H = H;
    this.dpr = dpr;
    for (const c of [this.el.base, this.el.field, this.el.labels, this.el.fx]) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
    }
    this.el.glow.width = Math.max(1, Math.round(W * GLOW_SCALE));
    this.el.glow.height = Math.max(1, Math.round(H * GLOW_SCALE));
    const head = this.el.head.getBoundingClientRect();
    this.headX = Math.max(RAIL_X0 + 80, (head.left - rect.left) / (this.stageScale || 1) - 18);
    this.relayout();
  }

  private relayout(): void {
    const s = this.store;
    this.filesVersion = s.filesVersion;
    const area = { x: PAD, y: TRUNK_H + 6, w: Math.max(0, this.W - PAD * 2), h: Math.max(0, this.H - TRUNK_H - 6 - this.opts.legendH) };
    this.A = area;
    this.L = layoutTreemap(s.files, area);
    this.layoutGen++;
    this.hover = -1;
    this.flashes = [];
    this.sparks = [];
    this.inFlight = 0;
    // Keep the framing: re-derive the camera from what it was focused on, without animating.
    this.camFrom = this.camTo = null;
    this.setCam(this.target(this.focusSpec, this.focusInsets));
    this.baseDirty = true;
    s.fieldDirty = true;
    const now = performance.now();
    for (const d of this.dots.values()) {
      d.tile = -1;
      const a = s.agents.get(d.id);
      if (a) this.assign(d, a, now, true);
      else this.scatter(d);
      d.x = d.px = d.tx;
      d.y = d.py = d.ty;
    }
  }

  // -- camera ----------------------------------------------------------------

  /** The screen rect the treemap camera frames: everything below the trunk strip. */
  private view(): Rect {
    return { x: 0, y: TRUNK_H, w: this.W, h: Math.max(1, this.H - TRUNK_H) };
  }

  private camOf(world: Rect): Cam {
    const V = this.view();
    const s = V.w / Math.max(1e-6, world.w);
    return { s, tx: V.x - world.x * s, ty: V.y - world.y * s };
  }

  private worldOf(c: Cam): Rect {
    const V = this.view();
    return { x: (V.x - c.tx) / c.s, y: (V.y - c.ty) / c.s, w: V.w / c.s, h: V.h / c.s };
  }

  private setCam(c: Cam): void {
    if (c.s === this.cam.s && c.tx === this.cam.tx && c.ty === this.cam.ty) return;
    this.cam = c;
    this.camGen++;
    this.baseDirty = true;
    this.store.fieldDirty = true;
  }

  /**
   * Frame a region: a directory or file path, the first resolvable of several, or a
   * computed target ("@hot", "@landing", "@selected"). Null frames the whole map.
   * `insets` keep the region clear of overlays such as captions or a side panel.
   */
  focus(spec: string | string[] | null, opts: { duration?: number; insets?: Partial<Insets> } = {}): boolean {
    this.focusSpec = spec;
    this.focusInsets = { top: 0, right: 0, bottom: 0, left: 0, ...opts.insets };
    const cam = this.target(spec, this.focusInsets);
    const resolved = spec === null || this.resolve(spec) !== null;
    const duration = opts.duration ?? 1400;
    if (duration <= 0) {
      this.camFrom = this.camTo = null;
      this.setCam(cam);
      return resolved;
    }
    this.camFrom = this.worldOf(this.cam);
    this.camTo = this.worldOf(cam);
    this.camT0 = performance.now();
    this.camDur = duration;
    return resolved;
  }

  /** True while the camera is moving. */
  cameraMoving(): boolean {
    return this.camTo !== null;
  }

  /** The current zoom factor (1 = the whole map). */
  zoom(): number {
    return this.cam.s;
  }

  private stepCamera(now: number): void {
    const a = this.camFrom;
    const b = this.camTo;
    if (!a || !b) return;
    const u = clamp((now - this.camT0) / this.camDur, 0, 1);
    const e = easeInOut(u);
    let r: Rect;
    if (Math.abs(a.w - b.w) < a.w * 1e-4) {
      r = { x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e, w: a.w, h: a.h };
    } else {
      // Scale about the homothety center that maps a onto b, with the width moving in log space:
      // a zoom reads as a dive toward one fixed point instead of a swing.
      const ratio = Math.exp(Math.log(b.w / a.w) * e);
      const fx = (b.x * a.w - a.x * b.w) / (a.w - b.w);
      const fy = (b.y * a.w - a.y * b.w) / (a.w - b.w);
      r = { x: fx + (a.x - fx) * ratio, y: fy + (a.y - fy) * ratio, w: a.w * ratio, h: a.h * ratio };
    }
    if (!Number.isFinite(r.x) || !Number.isFinite(r.y) || !(r.w > 0)) r = b;
    this.setCam(this.camOf(r));
    if (u >= 1) {
      this.setCam(this.camOf(b));
      this.camFrom = this.camTo = null;
    }
  }

  /** The camera that frames `spec` inside the view minus `insets`. */
  private target(spec: string | string[] | null, insets: Insets): Cam {
    const V = this.view();
    const C = { x: V.x + insets.left, y: V.y + insets.top, w: Math.max(40, V.w - insets.left - insets.right), h: Math.max(40, V.h - insets.top - insets.bottom) };
    const region = spec === null ? null : this.resolve(spec);
    const noInsets = insets.left === 0 && insets.right === 0 && insets.top === 0 && insets.bottom === 0;
    if (!region && noInsets) return { s: 1, tx: 0, ty: 0 };
    const r = region ?? this.A;
    if (!(r.w > 0 && r.h > 0)) return { s: 1, tx: 0, ty: 0 };
    const fill = region ? 0.9 : 0.98;
    let s = clamp(Math.min(C.w / r.w, C.h / r.h) * fill, region ? 1 : 0.4, MAX_ZOOM);
    if (region && s < 1.06) s = 1;
    if (s === 1 && noInsets) return { s: 1, tx: 0, ty: 0 };
    let tx = C.x + C.w / 2 - (r.x + r.w / 2) * s;
    let ty = C.y + C.h / 2 - (r.y + r.h / 2) * s;
    if (region && s > 1) {
      // Avoid empty margins past the map's edges when the region still fits after the shift.
      const A = this.A;
      const minTx = V.x + V.w - (A.x + A.w + PAD) * s;
      const maxTx = V.x - (A.x - PAD) * s;
      const minTy = V.y + V.h - (A.y + A.h + PAD) * s;
      const maxTy = V.y - (A.y - 6) * s;
      const cx = minTx <= maxTx ? clamp(tx, minTx, maxTx) : tx;
      const cy = minTy <= maxTy ? clamp(ty, minTy, maxTy) : ty;
      const inside = (x: number, y: number) => r.x * s + x >= C.x - 1 && (r.x + r.w) * s + x <= C.x + C.w + 1 && r.y * s + y >= C.y - 1 && (r.y + r.h) * s + y <= C.y + C.h + 1;
      if (inside(cx, ty)) tx = cx;
      if (inside(tx, cy)) ty = cy;
    }
    return { s, tx, ty };
  }

  /** World rect of a focus spec, or null when nothing in the layout matches. */
  resolve(spec: string | string[]): Rect | null {
    const list = Array.isArray(spec) ? spec : [spec];
    for (const item of list) {
      const r = this.resolveOne(item);
      if (r) return r;
    }
    return null;
  }

  private resolveOne(spec: string): Rect | null {
    const L = this.L;
    if (!L.n) return null;
    if (spec === "@hot") return this.hotDir();
    if (spec === "@sigma") return this.sigmaDir();
    if (spec === "@landing") {
      const last = this.store.landings[this.store.landings.length - 1];
      return last?.paths[0] ? this.regionAround(last.paths[0]) : null;
    }
    if (spec === "@selected") return this.store.selectedPath ? this.regionAround(this.store.selectedPath) : null;
    const path = spec.replace(/^\/+|\/+$/g, "");
    if (!path) return null;
    const tile = L.index.get(path);
    if (tile !== undefined) return this.regionAround(path);
    for (let p = path; p; p = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "") {
      const di = L.dirIndex.get(p);
      const d = di === undefined ? undefined : L.dirs[di];
      if (d) return { x: d.x, y: d.y, w: d.w, h: d.h };
    }
    return null;
  }

  /** The smallest directory box around a file that is big enough to be worth framing. */
  private regionAround(path: string): Rect | null {
    const L = this.L;
    const minArea = this.A.w * this.A.h * 0.045;
    for (let p = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ""; p; p = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "") {
      const di = L.dirIndex.get(p);
      const d = di === undefined ? undefined : L.dirs[di];
      if (d && d.w * d.h >= minArea) return { x: d.x, y: d.y, w: d.w, h: d.h };
    }
    const i = L.index.get(path);
    if (i === undefined) return null;
    const pad = 40;
    return { x: L.x[i]! - pad, y: L.y[i]! - pad, w: L.w[i]! + pad * 2, h: L.h[i]! + pad * 2 };
  }

  /** The region whose branching ratio is highest right now, if any region is near or past critical. */
  private sigmaDir(): Rect | null {
    const now = Date.now();
    let best: string | null = null;
    let bestSigma = 0.85;
    for (const [region, s] of this.store.sigma) {
      if (now - s.at > 120_000 || !(s.sigma > bestSigma)) continue;
      best = region;
      bestSigma = s.sigma;
    }
    if (best === null) return null;
    const di = this.L.dirIndex.get(best);
    const d = di === undefined ? undefined : this.L.dirs[di];
    return d ? { x: d.x, y: d.y, w: d.w, h: d.h } : null;
  }

  /** The directory where the field is most active right now (claims, needs, danger, fresh trails). */
  private hotDir(): Rect | null {
    const L = this.L;
    const now = Date.now();
    const score = new Float64Array(L.dirs.length);
    for (const cell of this.store.active) {
      const i = this.tileOf(cell);
      if (i < 0) continue;
      const v = (k: number) => decayed(cell.v[k] ?? 0, cell.at[k] ?? 0, k, now);
      const recent = cell.trailAt ? Math.exp(-(now - cell.trailAt) / 20_000) : 0;
      const w = v(KIND_INDEX.claim) * 1.2 + Math.min(3, v(KIND_INDEX.need)) * 0.6 + v(DANGER) * 2 + v(KIND_INDEX.failure) * 0.6 + recent * 1.5;
      if (!(w > 0)) continue;
      const path = L.paths[i] ?? "";
      for (let p = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ""; p; p = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "") {
        const di = L.dirIndex.get(p);
        if (di !== undefined) score[di] = (score[di] ?? 0) + w;
      }
    }
    const total = this.A.w * this.A.h;
    let best = -1;
    let bestScore = 0;
    let fallback = -1;
    let fallbackScore = 0;
    L.dirs.forEach((d, i) => {
      const sc = score[i] ?? 0;
      if (!(sc > 0)) return;
      if (d.depth === 1 && sc > fallbackScore) {
        fallback = i;
        fallbackScore = sc;
      }
      const frac = (d.w * d.h) / total;
      if (frac < 0.015 || frac > 0.3) return;
      const v = sc / Math.max(1, d.files) ** 0.35;
      if (v > bestScore) {
        best = i;
        bestScore = v;
      }
    });
    const d = L.dirs[best >= 0 ? best : fallback];
    return d ? { x: d.x, y: d.y, w: d.w, h: d.h } : null;
  }

  /** Recompute screen rects of all tiles for the current camera (cheap; only when it changed). */
  private ensureScreen(): void {
    if (this.sGen === this.camGen && this.sLayout === this.layoutGen) return;
    this.sGen = this.camGen;
    this.sLayout = this.layoutGen;
    const { L, cam } = this;
    const n = L.n;
    if (this.SX.length < n) {
      const cap = Math.max(n, 64);
      this.SX = new Float32Array(cap);
      this.SY = new Float32Array(cap);
      this.SW = new Float32Array(cap);
      this.SH = new Float32Array(cap);
      this.VIS = new Uint8Array(cap);
    }
    const { s, tx, ty } = cam;
    const V = this.view();
    const vx1 = V.x + V.w;
    const vy1 = V.y + V.h;
    for (let i = 0; i < n; i++) {
      const x0 = Math.round(L.x[i]! * s + tx);
      const y0 = Math.round(L.y[i]! * s + ty);
      const x1 = Math.round((L.x[i]! + L.w[i]!) * s + tx);
      const y1 = Math.round((L.y[i]! + L.h[i]!) * s + ty);
      this.SX[i] = x0;
      this.SY[i] = y0;
      this.SW[i] = x1 - x0;
      this.SH[i] = y1 - y0;
      this.VIS[i] = x1 > x0 && y1 > y0 && x1 > V.x && x0 < vx1 && y1 > V.y && y0 < vy1 ? 1 : 0;
    }
  }

  /** A directory box in screen space. */
  private dirRect(d: Rect): Rect {
    const { s, tx, ty } = this.cam;
    const x0 = Math.round(d.x * s + tx);
    const y0 = Math.round(d.y * s + ty);
    return { x: x0, y: y0, w: Math.round((d.x + d.w) * s + tx) - x0, h: Math.round((d.y + d.h) * s + ty) - y0 };
  }

  private visibleRect(r: Rect): boolean {
    const V = this.view();
    return r.w > 0 && r.h > 0 && r.x + r.w > V.x && r.x < V.x + V.w && r.y + r.h > V.y && r.y < V.y + V.h;
  }

  /** The cached tile index of a field cell for the current layout. */
  private tileOf(cell: { path: string; tile: number; tileGen: number }): number {
    if (cell.tileGen !== this.layoutGen) {
      cell.tile = this.L.index.get(cell.path) ?? -1;
      cell.tileGen = this.layoutGen;
    }
    return cell.tile;
  }

  private clipView(c: CanvasRenderingContext2D): void {
    const V = this.view();
    c.save();
    c.beginPath();
    c.rect(V.x, V.y, V.w, V.h);
    c.clip();
  }

  private drawBase(): void {
    const c = this.bctx;
    const { W, H, L } = this;
    this.ensureScreen();
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.fillStyle = "#05070b";
    c.fillRect(0, 0, W, H);
    this.clipView(c);
    c.fillStyle = "#0a0e15";
    for (const d of L.dirs) {
      if (d.depth !== 1) continue;
      const r = this.dirRect(d);
      if (this.visibleRect(r)) c.fillRect(r.x, r.y, r.w, r.h);
    }
    const { SX, SY, SW, SH, VIS } = this;
    for (let g = 0; g < GROUP_TINT.length; g++) {
      c.fillStyle = GROUP_TINT[g] ?? "#111";
      c.beginPath();
      for (let i = 0; i < L.n; i++) {
        if (L.group[i] !== g || !VIS[i]) continue;
        const w = SW[i]!;
        const h = SH[i]!;
        if (w > 0 && h > 0) c.rect(SX[i]!, SY[i]!, w, h);
      }
      c.fill();
    }
    c.lineWidth = 1;
    const zoomed = this.cam.s > 1.4;
    for (const pass of [1, 2, 3]) {
      c.strokeStyle = pass === 1 ? "rgba(150,170,200,0.2)" : pass === 2 ? "rgba(150,170,200,0.09)" : "rgba(150,170,200,0.06)";
      c.beginPath();
      for (const d of L.dirs) {
        if (pass === 3 ? d.depth < 3 || !zoomed : d.depth !== pass) continue;
        const r = this.dirRect(d);
        if (r.w < 2 || r.h < 2 || !this.visibleRect(r)) continue;
        c.rect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
      }
      c.stroke();
    }
    c.restore();
    this.drawLabels();
  }

  /** Directory and file names on their own layer, above the field, so color never hides them. */
  private drawLabels(): void {
    const c = this.lctx;
    const { W, H, L } = this;
    const s = this.cam.s;
    const ls = clamp(1 + (s - 1) * 0.3, 1, 1.6);
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, W, H);
    this.clipView(c);
    c.textBaseline = "middle";
    c.lineJoin = "round";
    for (const d of L.dirs) {
      if (!d.header) continue;
      const r = this.dirRect(d);
      if (!this.visibleRect(r)) continue;
      const top = (d.depth === 1 ? 3 : 2) * s;
      const y = r.y + top + (d.header * s) / 2;
      const maxW = r.w - 16;
      if (d.depth === 1) {
        c.font = `650 ${Math.round(11.5 * ls * 10) / 10}px ${SANS}`;
        const name = d.name.toUpperCase();
        const text = fit(c, name, maxW - 34);
        if (!text) continue;
        c.fillStyle = "#c6cfdc";
        c.fillText(text, r.x + 8, y);
        const tw = c.measureText(text).width;
        c.font = `500 ${Math.round(10.5 * ls * 10) / 10}px ${MONO}`;
        c.fillStyle = "#62708a";
        if (tw + 44 < maxW) c.fillText(String(d.files), r.x + 15 + tw, y);
      } else {
        c.font = `500 ${Math.round(10.5 * ls * 10) / 10}px ${SANS}`;
        c.fillStyle = "#8d9ab0";
        const text = fit(c, d.name, maxW);
        if (text) c.fillText(text, r.x + 6, y);
      }
    }
    const fs = Math.round(10.5 * ls * 10) / 10;
    c.font = `${fs}px ${MONO}`;
    const cw = c.measureText("M").width || fs * 0.6;
    const minW = Math.max(54, cw * 9);
    const minH = fs + 10;
    c.textBaseline = "top";
    c.lineWidth = 3;
    c.strokeStyle = "rgba(4,6,10,0.82)";
    c.fillStyle = "rgba(226,233,243,0.84)";
    this.ensureScreen();
    const { SX, SY, SW, SH, VIS } = this;
    for (let i = 0; i < L.n; i++) {
      if (!VIS[i]) continue;
      const w = SW[i]!;
      const h = SH[i]!;
      if (w < minW || h < minH) continue;
      const max = Math.floor((w - 10) / cw);
      const name = basename(L.paths[i] ?? "");
      const text = name.length > max ? `${name.slice(0, Math.max(1, max - 1))}…` : name;
      const x = SX[i]! + 5;
      const y = SY[i]! + 5;
      c.strokeText(text, x, y);
      c.fillText(text, x, y);
    }
    c.restore();
  }

  // -- the frame -------------------------------------------------------------

  private frame = (ts: number): void => {
    this.raf = requestAnimationFrame(this.frame);
    const t0 = performance.now();
    try {
      this.step(ts);
    } finally {
      this.workMs.push(performance.now() - t0);
      if (this.workMs.length > 120) this.workMs.shift();
    }
  };

  private step(ts: number): void {
    const dtMs = this.lastTs ? ts - this.lastTs : 16.7;
    const dt = clamp(dtMs / 1000, 0, 0.064);
    this.lastTs = ts;
    if (dtMs > 0 && dtMs < 1000) {
      this.frameMs.push(dtMs);
      if (this.frameMs.length > 120) this.frameMs.shift();
    }
    const now = Date.now();
    const s = this.store;
    if (this.sizeDirty) {
      this.sizeDirty = false;
      this.resize();
    } else if (s.filesVersion !== this.filesVersion) {
      this.relayout();
    }
    this.stepCamera(performance.now());
    this.sync(ts);
    if (this.baseDirty) {
      this.baseDirty = false;
      this.drawBase();
    }
    const moving = this.camTo !== null;
    // The field redraws at most ~30 times a second while events stream in, every frame while the camera moves.
    if ((s.fieldDirty && (moving || ts - this.lastField > 33)) || (this.fieldAnimating && ts - this.lastField > 33) || ts - this.lastField > 500) {
      s.fieldDirty = false;
      this.lastField = ts;
      this.drawField(now);
    }
    if (this.mouseDirty) {
      this.mouseDirty = false;
      this.hitTest();
      this.placeTip();
    }
    this.drawFx(ts, dt);
    if (ts - this.lastTip > 160) this.renderTip(now, ts);
  }

  /** Drain the store's fx queues: agent changes, landings, new marks. */
  private sync(ts: number): void {
    const s = this.store;
    if (!this.beadsSeeded && s.loaded) {
      // The rail starts with the recent history from the snapshot.
      this.beadsSeeded = true;
      for (const l of s.landings.slice(-60)) if (l.receivedAt === l.at) this.beads.push({ size: l.paths.length, t0: -1e9 });
    }
    if (s.agentChanges.size) {
      for (const id of s.agentChanges) {
        const a = s.agents.get(id);
        let d = this.dots.get(id);
        if (!a) {
          if (d && !d.dying) d.dying = ts;
          continue;
        }
        let fresh = false;
        if (!d) {
          if (this.dots.size >= MAX_DOTS) continue;
          d = { id, x: 0, y: 0, tx: 0, ty: 0, px: 0, py: 0, tile: -1, state: a.state, kind: a.kind, dying: 0, born: ts, wanderAt: 0, travel: false };
          this.dots.set(id, d);
          fresh = true;
        }
        d.dying = 0;
        d.state = a.state;
        d.kind = a.kind;
        this.assign(d, a, ts, fresh);
        if (fresh) {
          // Agents appear where they work: no flight from the top of the map.
          d.x = d.px = d.tx;
          d.y = d.py = d.ty;
          if (this.ripples.length < 48 && a.bornAt) this.ripples.push({ x: d.x, y: d.y, t0: ts });
        }
      }
      s.agentChanges.clear();
    }
    if (s.landingFx.length) {
      const list = s.landingFx.splice(0, s.landingFx.length);
      for (const l of list.slice(-40)) this.launch(l, ts);
    }
    if (s.markFx.length) {
      const list = s.markFx.splice(0, s.markFx.length);
      let n = 0;
      for (const m of list) {
        if (this.flashes.length > 420 || n++ > 180) break;
        const i = this.L.index.get(m.path);
        if (i !== undefined && this.L.w[i]! > 0) this.flashes.push({ tile: i, k: KIND_INDEX[m.kind], t0: ts, dur: 650 });
      }
    }
    if (!this.inFlight && s.trunkSha && s.trunkSha !== this.displayedSha) this.showSha(s.trunkSha, false);
  }

  /** Point a dot at the tile its agent is working on (or let it wander). */
  private assign(d: Dot, a: AgentView, ts: number, fresh: boolean): void {
    const first = a.paths[0];
    const tile = first !== undefined ? (this.L.index.get(first) ?? -1) : -1;
    if (tile >= 0) {
      if (tile !== d.tile) {
        d.tile = tile;
        this.pickPoint(d);
        d.travel = !fresh;
        d.wanderAt = ts + 900 + Math.random() * 2400;
      }
    } else if (d.tile < 0) {
      this.scatter(d);
    }
  }

  /** Give a dot with no tile a random file to rest on. */
  private scatter(d: Dot): void {
    if (!this.L.n) return;
    d.tile = (Math.random() * this.L.n) | 0;
    this.pickPoint(d);
  }

  private pickPoint(d: Dot): void {
    const L = this.L;
    const i = d.tile;
    if (i < 0 || i >= L.n) return;
    const w = L.w[i]!;
    const h = L.h[i]!;
    d.tx = L.x[i]! + w * (0.18 + 0.64 * Math.random());
    d.ty = L.y[i]! + h * (0.18 + 0.64 * Math.random());
  }

  // -- the field -------------------------------------------------------------

  private drawField(now: number): void {
    const { L, W, H } = this;
    this.ensureScreen();
    const f = this.fctx;
    const g = this.gctx;
    f.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    f.clearRect(0, 0, W, H);
    g.setTransform(GLOW_SCALE, 0, 0, GLOW_SCALE, 0, 0);
    g.clearRect(0, 0, W, H);
    const counts = [0, 0, 0, 0, 0];
    for (const b of this.levels) b.length = 0;
    for (const b of this.glows) b.length = 0;
    for (const b of this.stripes) b.length = 0;
    let animating = false;
    const vals = this.vals;
    const I = this.inten;
    const pulse = 0.55 + 0.45 * Math.sin(now / 190);
    const { SW, SH, VIS } = this;
    for (const cell of this.store.active) {
      let any = false;
      for (let k = 0; k < 5; k++) {
        const v = decayed(cell.v[k]!, cell.at[k]!, k, now);
        vals[k] = v;
        if (v > 0.004) any = true;
      }
      if (!any) {
        this.store.active.delete(cell);
        continue;
      }
      // The legend counts files in the field, whether or not their tile is on screen.
      for (let k = 0; k < 5; k++) {
        const x = intensity(vals[k]!, k);
        I[k] = x;
        if (x > COUNT_AT) counts[k]!++;
      }
      const i = this.tileOf(cell);
      if (i < 0 || !VIS[i]) continue;
      let dom = -1;
      let domS = 0;
      let sec = -1;
      let secS = 0;
      // A fresh landing owns the tile for a moment (green flash), then the field underneath shows again.
      const recency = cell.trailAt ? Math.exp(-(now - cell.trailAt) / 6000) : 0;
      for (let k = 0; k < 5; k++) {
        const sc = I[k]! * WEIGHT[k]! * (k === TRAIL ? 1 + 5 * recency : 1);
        if (sc > domS) {
          sec = dom;
          secS = domS;
          dom = k;
          domS = sc;
        } else if (sc > secS) {
          sec = k;
          secS = sc;
        }
      }
      if (dom < 0 || domS < 0.03) continue;
      let alpha = ALPHA0[dom]! + ALPHA1[dom]! * I[dom]!;
      if (cell.popAt) {
        const u = (now - cell.popAt) / 420;
        if (u < 1 && u >= 0) {
          animating = true;
          alpha *= 0.3 + 0.7 * easeOut(u);
        }
      }
      const lvl = clamp(Math.round(alpha * LEVELS), 1, LEVELS) - 1;
      this.levels[dom * LEVELS + lvl]!.push(i);
      if (sec >= 0 && I[sec]! > 0.28 && SW[i]! >= 7 && SH[i]! >= 7) this.stripes[sec]!.push(i);
      // Glow: fresh trails flare and fade; danger pulses; claims and needs glow softly.
      if (recency > 0.02 && I[TRAIL]! > 0.05) {
        animating = true;
        this.pushGlow(TRAIL, i, Math.min(1, I[TRAIL]! * 1.15 * recency));
      }
      if (dom === DANGER) {
        animating = true;
        this.pushGlow(DANGER, i, I[DANGER]! * pulse);
      } else if (dom !== TRAIL) {
        const ga = I[dom]! * GLOW[dom]!;
        if (ga > 0.03) this.pushGlow(dom, i, ga);
      }
    }
    const { SX, SY } = this;
    f.save();
    const V = this.view();
    f.beginPath();
    f.rect(V.x, V.y, V.w, V.h);
    f.clip();
    f.lineWidth = 1;
    for (let k = 0; k < 5; k++) {
      const color = FIELD_COLOR_BY_INDEX[k]!;
      const body = BODY[k]!;
      f.fillStyle = color;
      f.strokeStyle = color;
      for (let lv = 0; lv < LEVELS; lv++) {
        const b = this.levels[k * LEVELS + lv]!;
        if (!b.length) continue;
        const a = (lv + 1) / LEVELS;
        // Large tiles: a translucent body with a lit edge reads as light, not paint.
        f.globalAlpha = a * body;
        f.beginPath();
        let edges = false;
        for (const i of b) {
          const w = SW[i]!;
          const h = SH[i]!;
          if (w >= 9 && h >= 9) {
            f.rect(SX[i]!, SY[i]!, w, h);
            edges = true;
          }
        }
        f.fill();
        if (edges) {
          f.globalAlpha = Math.min(1, a * 1.35);
          f.beginPath();
          for (const i of b) {
            const w = SW[i]!;
            const h = SH[i]!;
            if (w >= 9 && h >= 9) f.rect(SX[i]! + 0.5, SY[i]! + 0.5, w - 1, h - 1);
          }
          f.stroke();
        }
        f.globalAlpha = a;
        f.beginPath();
        let small = false;
        for (const i of b) {
          const w = SW[i]!;
          const h = SH[i]!;
          if (w < 9 || h < 9) {
            f.rect(SX[i]!, SY[i]!, w, h);
            small = true;
          }
        }
        if (small) f.fill();
      }
    }
    f.globalAlpha = 0.95;
    for (let k = 0; k < 5; k++) {
      const st = this.stripes[k]!;
      if (!st.length) continue;
      f.fillStyle = FIELD_COLOR_BY_INDEX[k]!;
      f.beginPath();
      for (const i of st) f.rect(SX[i]!, SY[i]! + SH[i]! - 2, SW[i]!, 2);
      f.fill();
    }
    f.restore();
    f.globalAlpha = 1;
    for (let k = 0; k < 5; k++) {
      g.fillStyle = FIELD_COLOR_BY_INDEX[k]!;
      for (let lv = 0; lv < LEVELS; lv++) {
        const gl = this.glows[k * LEVELS + lv]!;
        if (!gl.length) continue;
        g.globalAlpha = (lv + 1) / LEVELS;
        g.beginPath();
        for (const i of gl) g.rect(SX[i]! - 2, SY[i]! - 2, SW[i]! + 4, SH[i]! + 4);
        g.fill();
      }
    }
    g.globalAlpha = 1;
    this.store.fieldCounts = counts;
    this.fieldAnimating = animating;
  }

  private pushGlow(k: number, i: number, a: number): void {
    if (!(a > 0)) return;
    const lvl = clamp(Math.round(a * LEVELS), 1, LEVELS) - 1;
    this.glows[k * LEVELS + lvl]!.push(i);
  }

  // -- landings: sparks into the trunk ----------------------------------------

  private launch(l: LandingView, ts: number): void {
    const L = this.L;
    const flight: Flight = { sha: l.trunkSha, size: l.paths.length, arrived: false };
    const tiles: number[] = [];
    for (const p of l.paths) {
      const i = L.index.get(p);
      if (i !== undefined && L.w[i]! > 0) tiles.push(i);
    }
    if (!tiles.length || this.sparks.length > 700) {
      this.arrive(flight, ts);
      return;
    }
    while (tiles.length > 14) tiles.splice((Math.random() * tiles.length) | 0, 1);
    this.inFlight++;
    this.ensureScreen();
    tiles.forEach((i, j) => {
      const x0 = this.SX[i]! + this.SW[i]! / 2;
      const y0 = this.SY[i]! + this.SH[i]! / 2;
      const dist = Math.hypot(this.headX - x0, TRUNK_H / 2 - y0);
      this.sparks.push({ tile: i, a: 0.12 + Math.random() * 0.16, b: 0.06 + Math.random() * 0.1, t0: ts + j * 38, dur: Math.min(1500, 620 + dist * 0.42 + Math.random() * 160), flight });
      this.flashes.push({ tile: i, k: TRAIL, t0: ts + j * 38, dur: 900 });
    });
  }

  private arrive(flight: Flight, ts: number): void {
    this.bursts.push({ x: this.headX, y: TRUNK_H / 2, t0: ts });
    if (this.bursts.length > 24) this.bursts.splice(0, this.bursts.length - 24);
    if (flight.arrived) return;
    flight.arrived = true;
    this.beads.push({ size: flight.size, t0: ts });
    if (this.beads.length > 90) this.beads.splice(0, this.beads.length - 90);
    this.lastBeadAt = ts;
    this.lastArriveAt = ts;
    this.showSha(flight.sha, true);
  }

  private showSha(sha: string, flash: boolean): void {
    this.displayedSha = sha;
    this.el.sha.textContent = shortSha(sha);
    this.el.sha.title = sha;
    if (flash && typeof this.el.sha.animate === "function") {
      this.el.sha.animate(
        [
          { color: "#ffffff", textShadow: "0 0 16px rgba(243,128,32,0.95), 0 0 3px rgba(255,255,255,0.9)" },
          { color: "#f7a560", textShadow: "0 0 0 rgba(243,128,32,0)" },
        ],
        { duration: 950, easing: "cubic-bezier(.2,.7,.2,1)" },
      );
    }
  }

  // -- fx layer --------------------------------------------------------------

  private drawFx(ts: number, dt: number): void {
    const c = this.xctx;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, this.W, this.H);
    this.ensureScreen();
    this.clipView(c);
    this.drawRegionAlerts(c, ts);
    this.drawFlashes(c, ts);
    this.drawOutlines(c, ts);
    this.drawDots(c, ts, dt);
    this.drawRipples(c, ts);
    c.restore();
    this.drawRail(c, ts);
    this.drawSparks(c, ts);
  }

  private drawRegionAlerts(c: CanvasRenderingContext2D, ts: number): void {
    const L = this.L;
    const now = Date.now();
    for (const [region, s] of this.store.sigma) {
      if (!(s.sigma > 1) || now - s.at > 120_000) continue;
      const di = L.dirIndex.get(region);
      const box = di === undefined ? undefined : L.dirs[di];
      if (!box) continue;
      const d = this.dirRect(box);
      if (!this.visibleRect(d)) continue;
      const pulse = 0.5 + 0.5 * Math.sin(ts / 210);
      c.globalAlpha = 0.35 + 0.5 * pulse;
      c.strokeStyle = FIELD_COLOR.danger;
      c.lineWidth = 2;
      c.strokeRect(d.x + 1, d.y + 1, d.w - 2, d.h - 2);
      c.globalAlpha = 0.12 * pulse;
      c.lineWidth = 8;
      c.strokeRect(d.x - 2, d.y - 2, d.w + 4, d.h + 4);
      if (box.header && d.w > 120) {
        const text = `σ ${s.sigma.toFixed(2)}`;
        c.font = `700 10.5px ${SANS}`;
        const tw = c.measureText(text).width;
        const bx = d.x + d.w - tw - 18;
        const by = d.y + 4;
        c.globalAlpha = 0.92;
        c.fillStyle = FIELD_COLOR.danger;
        c.beginPath();
        c.roundRect(bx, by, tw + 12, 15, 4);
        c.fill();
        c.globalAlpha = 1;
        c.fillStyle = "#fff";
        c.textBaseline = "middle";
        c.fillText(text, bx + 6, by + 8);
      }
    }
    c.globalAlpha = 1;
  }

  private drawFlashes(c: CanvasRenderingContext2D, ts: number): void {
    const L = this.L;
    const list = this.flashes;
    const { SX, SY, SW, SH, VIS } = this;
    c.lineWidth = 1.5;
    for (let j = list.length - 1; j >= 0; j--) {
      const f = list[j]!;
      const u = (ts - f.t0) / f.dur;
      if (u < 0) continue;
      if (u >= 1 || f.tile >= L.n) {
        list[j] = list[list.length - 1]!;
        list.pop();
        continue;
      }
      if (!VIS[f.tile]) continue;
      const grow = 1 + 6 * easeOut(u);
      c.globalAlpha = (1 - u) * 0.9;
      c.strokeStyle = FIELD_COLOR_BY_INDEX[f.k]!;
      c.strokeRect(SX[f.tile]! - grow, SY[f.tile]! - grow, SW[f.tile]! + grow * 2, SH[f.tile]! + grow * 2);
    }
    c.globalAlpha = 1;
  }

  /** Index the highlighted paths for the current layout (only when the highlight or layout changed). */
  private ensureHighlight(ts: number): void {
    const h = this.store.highlight;
    if (h === this.hlRef && this.hlGen === this.layoutGen) return;
    if (h !== this.hlRef) this.hlAt = ts;
    this.hlRef = h;
    this.hlGen = this.layoutGen;
    if (this.hlMask.length < this.L.n) this.hlMask = new Uint8Array(Math.max(64, this.L.n));
    else this.hlMask.fill(0);
    let n = 0;
    for (const p of h) {
      const i = this.L.index.get(p);
      if (i !== undefined && !this.hlMask[i]) {
        this.hlMask[i] = 1;
        n++;
      }
    }
    this.hlCount = n;
  }

  private drawOutlines(c: CanvasRenderingContext2D, ts: number): void {
    const L = this.L;
    const s = this.store;
    const { SX, SY, SW, SH, VIS } = this;
    this.ensureHighlight(ts);
    if (this.hlCount > SPOTLIGHT_AT) {
      // A spotlight: everything outside the highlight dims, so a whole kind of mark stands out.
      const k = easeOut(clamp((ts - this.hlAt) / 600, 0, 1));
      const mask = this.hlMask;
      c.globalAlpha = 0.66 * k;
      c.fillStyle = "#04060a";
      c.beginPath();
      for (let i = 0; i < L.n; i++) if (VIS[i] && !mask[i]) c.rect(SX[i]!, SY[i]!, SW[i]!, SH[i]!);
      c.fill();
      c.globalAlpha = 0.5 * k;
      c.strokeStyle = "#ffffff";
      c.lineWidth = 1;
      c.beginPath();
      for (let i = 0; i < L.n; i++) if (VIS[i] && mask[i] && SW[i]! >= 4 && SH[i]! >= 4) c.rect(SX[i]! + 0.5, SY[i]! + 0.5, SW[i]! - 1, SH[i]! - 1);
      c.stroke();
      c.globalAlpha = 1;
    } else if (s.highlight.length) {
      c.setLineDash([3, 3]);
      c.lineDashOffset = -ts / 60;
      c.strokeStyle = "#ffffff";
      c.globalAlpha = 0.9;
      c.lineWidth = 1.5;
      c.beginPath();
      for (const p of s.highlight) {
        const i = L.index.get(p);
        if (i === undefined || !this.VIS[i]) continue;
        c.rect(SX[i]! - 1.5, SY[i]! - 1.5, SW[i]! + 3, SH[i]! + 3);
      }
      c.stroke();
      c.setLineDash([]);
    }
    const sel = s.selectedPath ? L.index.get(s.selectedPath) : undefined;
    if (sel !== undefined) {
      const pulse = 0.6 + 0.4 * Math.sin(ts / 240);
      const x = SX[sel]!;
      const y = SY[sel]!;
      const w = SW[sel]!;
      const h = SH[sel]!;
      c.strokeStyle = ACCENT;
      c.globalAlpha = 0.28 * pulse;
      c.lineWidth = 7;
      c.strokeRect(x - 3.5, y - 3.5, w + 7, h + 7);
      c.globalAlpha = 1;
      c.lineWidth = 2;
      c.strokeRect(x - 1, y - 1, w + 2, h + 2);
    }
    if (this.opts.tooltips && this.hover >= 0 && this.hover !== sel && this.hover < L.n) {
      const i = this.hover;
      c.strokeStyle = "#ffffff";
      c.globalAlpha = 0.85;
      c.lineWidth = 1;
      c.strokeRect(SX[i]! - 0.5, SY[i]! - 0.5, SW[i]! + 1, SH[i]! + 1);
    }
    c.globalAlpha = 1;
  }

  private drawDots(c: CanvasRenderingContext2D, ts: number, dt: number): void {
    const kFast = 1 - Math.exp(-dt * 3.4);
    const kSlow = 1 - Math.exp(-dt * 1.4);
    const buf = this.dotBuf;
    const len = this.dotLen;
    len[0] = len[1] = len[2] = 0;
    const many = this.dots.size > 2500;
    const { s, tx, ty } = this.cam;
    const grow = Math.min(2, Math.sqrt(Math.max(1, s)));
    const V = this.view();
    let n = 0;
    // Travelling agents leave a short trail that fades toward its tail: two strokes, near and far half.
    const near = new Path2D();
    const far = new Path2D();
    let trails = 0;
    for (const d of this.dots.values()) {
      let fade = 1;
      if (d.dying) {
        const u = (ts - d.dying) / 600;
        if (u >= 1) {
          this.dots.delete(d.id);
          continue;
        }
        fade = 1 - u;
      }
      const busy = d.state === "working" || d.state === "proposing";
      const k = busy ? kFast : kSlow;
      d.px = d.x;
      d.py = d.y;
      d.x += (d.tx - d.x) * k;
      d.y += (d.ty - d.y) * k;
      const sx = d.x * s + tx;
      const sy = d.y * s + ty;
      if (d.travel) {
        const vx = (d.x - d.px) * s;
        const vy = (d.y - d.py) * s;
        const speed = Math.hypot(vx, vy);
        if (speed < 0.25) d.travel = false;
        else if (trails < 3000 && sx > V.x - 20 && sx < V.x + V.w + 20 && sy > V.y - 20 && sy < V.y + V.h + 20) {
          const len2 = Math.min(14, speed * 2.4);
          const ux = vx / speed;
          const uy = vy / speed;
          const mx = sx - ux * len2 * 0.45;
          const my = sy - uy * len2 * 0.45;
          near.moveTo(sx, sy);
          near.lineTo(mx, my);
          far.moveTo(mx, my);
          far.lineTo(sx - ux * len2, sy - uy * len2);
          trails++;
        }
      }
      if (ts > d.wanderAt) {
        this.pickPoint(d);
        d.wanderAt = ts + (busy ? 1400 : 2600) + Math.random() * 3200;
      }
      if (sx < V.x - 6 || sx > V.x + V.w + 6 || sy < V.y - 6 || sy > V.y + V.h + 6) {
        n++;
        continue;
      }
      const bornU = (ts - d.born) / 650;
      const group = !busy || fade < 1 || bornU < 1 ? 2 : d.kind === "external" ? 1 : 0;
      const b = buf[group]!;
      const o = len[group]!;
      b[o] = sx;
      b[o + 1] = sy;
      const size = many ? (busy ? 2.2 : 1.6) : d.state === "proposing" ? 4 : busy ? 3 : 2.2;
      b[o + 2] = size * grow * (bornU < 1 ? 0.4 + 0.6 * easeOut(Math.max(0, bornU)) : 1);
      len[group] = o + 3;
      n++;
    }
    c.globalCompositeOperation = "lighter";
    if (trails) {
      c.lineCap = "round";
      c.lineWidth = 1.3;
      c.strokeStyle = "rgba(225,238,255,0.36)";
      c.stroke(near);
      c.strokeStyle = "rgba(225,238,255,0.12)";
      c.stroke(far);
    }
    this.store.dotCount = n;
    const draw = (group: number, color: string, alpha: number, halo: number): void => {
      const b = buf[group]!;
      const end = len[group]!;
      if (!end) return;
      c.fillStyle = color;
      if (halo > 0) {
        c.globalAlpha = halo;
        c.beginPath();
        for (let o = 0; o < end; o += 3) {
          const r = b[o + 2]! + 2.5;
          c.moveTo(b[o]! + r, b[o + 1]!);
          c.arc(b[o]!, b[o + 1]!, r, 0, Math.PI * 2);
        }
        c.fill();
      }
      c.globalAlpha = alpha;
      c.beginPath();
      for (let o = 0; o < end; o += 3) {
        const sz = b[o + 2]!;
        c.rect(b[o]! - sz / 2, b[o + 1]! - sz / 2, sz, sz);
      }
      c.fill();
    };
    draw(2, "#93a7c6", 0.55, 0);
    draw(0, "#f4f8ff", 1, many ? 0 : 0.2);
    draw(1, "#7fe6ff", 1, many ? 0 : 0.2);
    c.globalAlpha = 1;
    c.globalCompositeOperation = "source-over";
  }

  /** A faint ring where an agent appears. */
  private drawRipples(c: CanvasRenderingContext2D, ts: number): void {
    const list = this.ripples;
    if (!list.length) return;
    const { s, tx, ty } = this.cam;
    c.lineWidth = 1;
    c.strokeStyle = "#cfe0ff";
    for (let j = list.length - 1; j >= 0; j--) {
      const r = list[j]!;
      const u = (ts - r.t0) / 700;
      if (u >= 1 || u < -1) {
        list.splice(j, 1);
        continue;
      }
      if (u < 0) continue;
      c.globalAlpha = (1 - u) * 0.45;
      c.beginPath();
      c.arc(r.x * s + tx, r.y * s + ty, 2 + 9 * easeOut(u), 0, Math.PI * 2);
      c.stroke();
    }
    c.globalAlpha = 1;
  }

  private drawRail(c: CanvasRenderingContext2D, ts: number): void {
    const y = TRUNK_H / 2;
    const x0 = RAIL_X0;
    const x1 = this.headX;
    if (x1 <= x0 + 20) return;
    const grad = c.createLinearGradient(x0, 0, x1, 0);
    grad.addColorStop(0, "rgba(243,128,32,0)");
    grad.addColorStop(0.55, "rgba(243,128,32,0.22)");
    grad.addColorStop(1, "rgba(243,128,32,0.55)");
    c.strokeStyle = grad;
    c.lineWidth = 1.5;
    c.beginPath();
    c.moveTo(x0, y);
    c.lineTo(x1, y);
    c.stroke();
    const spacing = 15;
    const shift = spacing * (1 - easeOut(clamp((ts - this.lastBeadAt) / 320, 0, 1)));
    for (let j = 0; j < this.beads.length; j++) {
      const b = this.beads[this.beads.length - 1 - j]!;
      const x = x1 - 12 - j * spacing + shift;
      if (x < x0 + 8) break;
      const r = 1.8 + Math.min(3.2, Math.sqrt(Math.max(0, b.size)) * 0.75);
      c.globalAlpha = Math.max(0.16, 1 - j * 0.03) * Math.min(1, (x - x0) / 60);
      c.fillStyle = j === 0 ? "#ffd8b4" : ACCENT;
      c.beginPath();
      c.arc(x, y, r, 0, Math.PI * 2);
      c.fill();
    }
    const k = Math.exp(-Math.max(0, ts - this.lastArriveAt) / 520);
    if (k > 0.01) {
      const rg = c.createRadialGradient(x1, y, 0, x1, y, 10 + 34 * k);
      rg.addColorStop(0, `rgba(255,236,214,${0.85 * k})`);
      rg.addColorStop(0.35, `rgba(243,128,32,${0.55 * k})`);
      rg.addColorStop(1, "rgba(243,128,32,0)");
      c.globalAlpha = 1;
      c.fillStyle = rg;
      c.fillRect(x1 - 50, y - 50, 100, 100);
    }
    c.globalAlpha = 1;
    c.strokeStyle = ACCENT;
    c.lineWidth = 2;
    c.beginPath();
    c.arc(x1, y, 5, 0, Math.PI * 2);
    c.stroke();
    c.fillStyle = k > 0.05 ? "#fff1e0" : "#3a2412";
    c.beginPath();
    c.arc(x1, y, 3, 0, Math.PI * 2);
    c.fill();
  }

  private drawSparks(c: CanvasRenderingContext2D, ts: number): void {
    const list = this.sparks;
    const { SX, SY, SW, SH } = this;
    const x1 = this.headX;
    const y1 = TRUNK_H / 2;
    c.globalCompositeOperation = "lighter";
    c.lineCap = "round";
    for (let j = list.length - 1; j >= 0; j--) {
      const s = list[j]!;
      const u = (ts - s.t0) / s.dur;
      if (u < 0) continue;
      if (u >= 1 || s.tile >= this.L.n) {
        const last = list.pop()!;
        if (j < list.length) list[j] = last;
        const done = !list.some((o) => o.flight === s.flight);
        this.arrive(s.flight, ts);
        if (done) this.inFlight = Math.max(0, this.inFlight - 1);
        continue;
      }
      // Endpoints follow the camera: the spark leaves its tile wherever the tile is on screen.
      const x0 = SX[s.tile]! + SW[s.tile]! / 2;
      const y0 = clamp(SY[s.tile]! + SH[s.tile]! / 2, TRUNK_H, this.H);
      const cx = x0 + (x1 - x0) * s.a;
      const cy = y1 + (y0 - y1) * s.b;
      const e = easeInOut(u);
      let px = bez(x0, cx, x1, e);
      let py = bez(y0, cy, y1, e);
      const hx = px;
      const hy = py;
      c.strokeStyle = ACCENT;
      for (let k = 1; k <= 5; k++) {
        const e2 = Math.max(0, e - k * 0.04);
        const qx = bez(x0, cx, x1, e2);
        const qy = bez(y0, cy, y1, e2);
        c.globalAlpha = 0.7 * (1 - k / 6);
        c.lineWidth = 2.6 - k * 0.38;
        c.beginPath();
        c.moveTo(px, py);
        c.lineTo(qx, qy);
        c.stroke();
        px = qx;
        py = qy;
      }
      c.globalAlpha = 0.45;
      c.fillStyle = ACCENT;
      c.fillRect(hx - 3.5, hy - 3.5, 7, 7);
      c.globalAlpha = 1;
      c.fillStyle = "#fff6ea";
      c.fillRect(hx - 1.6, hy - 1.6, 3.2, 3.2);
    }
    for (let j = this.bursts.length - 1; j >= 0; j--) {
      const b = this.bursts[j]!;
      const u = (ts - b.t0) / 520;
      if (u >= 1) {
        this.bursts.splice(j, 1);
        continue;
      }
      if (u < 0) continue;
      const r = 6 + 22 * easeOut(u);
      c.globalAlpha = (1 - u) * 0.55;
      c.strokeStyle = "#ffd2a6";
      c.lineWidth = 1.5;
      c.beginPath();
      c.arc(b.x, b.y, r, 0, Math.PI * 2);
      c.stroke();
    }
    c.globalAlpha = 1;
    c.globalCompositeOperation = "source-over";
  }

  // -- hover and tooltip -----------------------------------------------------

  private hitTest(): void {
    const L = this.L;
    let found = -1;
    if (this.mx >= 0 && this.my >= TRUNK_H) {
      // Pointer to world coordinates through the camera.
      const { s, tx, ty } = this.cam;
      const wx = (this.mx - tx) / s;
      const wy = (this.my - ty) / s;
      const prev = this.hover;
      if (prev >= 0 && prev < L.n && inside(L, prev, wx, wy)) found = prev;
      else {
        for (let i = 0; i < L.n; i++) {
          if (inside(L, i, wx, wy)) {
            found = i;
            break;
          }
        }
      }
    }
    if (found !== this.hover) {
      this.hover = found;
      this.el.wrap.style.cursor = found >= 0 && this.opts.tooltips ? "pointer" : "";
      this.lastTip = 0;
    }
  }

  private placeTip(): void {
    if (this.hover < 0) return;
    const TW = 280;
    const TH = 196;
    let x = this.mx + 18;
    let y = this.my + 18;
    if (x + TW > this.W - 8) x = this.mx - TW - 14;
    if (y + TH > this.H - 8) y = Math.max(8, this.my - TH - 14);
    this.el.tip.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
  }

  private renderTip(now: number, ts: number): void {
    this.lastTip = ts;
    const tip = this.el.tip;
    const i = this.hover;
    if (i < 0 || !this.opts.tooltips) {
      if (this.tipShown) {
        tip.style.opacity = "0";
        this.tipShown = false;
      }
      return;
    }
    const path = this.L.paths[i] ?? "";
    const vals = this.store.fieldValues(path, now);
    let agents = 0;
    for (const d of this.dots.values()) if (d.tile === i && d.state !== "idle" && d.state !== "waiting" && !d.dying) agents++;
    const rows = KINDS.map((kind) => {
      const v = vals[kind];
      const pct = Math.round(intensity(v, KIND_INDEX[kind]) * 100);
      return `<div class="tip-row${v > 0.005 ? "" : " zero"}"><i style="background:${FIELD_COLOR[kind]}"></i><span class="tip-k">${kind}</span><span class="tip-bar"><b style="width:${pct}%;background:${FIELD_COLOR[kind]}"></b></span><span class="tip-v">${v.toFixed(2)}</span></div>`;
    }).join("");
    const size = this.L.sizes[i] ?? 0;
    const html =
      `<div class="tip-path"><span class="tip-dir">${escapeHtml(dirname(path))}</span>${escapeHtml(basename(path))}</div>` +
      `<div class="tip-meta">${escapeHtml(regionOf(path, this.store.colony?.regionDepth ?? 1))} · ${fmtBytes(size)} · ${agents} ${agents === 1 ? "agent" : "agents"} working here</div>` +
      `<div class="tip-rows">${rows}</div>` +
      `<div class="tip-hint">Click for lineage</div>`;
    if (html !== this.tipHtml) {
      tip.innerHTML = html;
      this.tipHtml = html;
    }
    if (!this.tipShown) {
      this.placeTip();
      tip.style.opacity = "1";
      this.tipShown = true;
    }
  }
}

function inside(L: TreemapLayout, i: number, x: number, y: number): boolean {
  const x0 = L.x[i]!;
  const y0 = L.y[i]!;
  return x >= x0 - 0.6 && x < x0 + L.w[i]! + 0.6 && y >= y0 - 0.6 && y < y0 + L.h[i]! + 0.6;
}

function bez(a: number, b: number, c: number, t: number): number {
  const u = 1 - t;
  return u * u * a + 2 * u * t * b + t * t * c;
}

function fit(c: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (maxW <= 8) return "";
  if (c.measureText(text).width <= maxW) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (c.measureText(`${text.slice(0, mid)}…`).width <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return lo ? `${text.slice(0, lo)}…` : "";
}
