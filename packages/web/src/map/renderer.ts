import type { AgentKind, AgentState } from "@fire_trident/core";
import { basename, dirname, escapeHtml, fmtBytes, regionOf, shortSha } from "../format.ts";
import type { AgentView, ColonyStore, LandingView } from "../store.ts";
import { ACCENT, FIELD_COLOR, FIELD_COLOR_BY_INDEX, KIND_INDEX, KINDS, decayed, intensity } from "../theme.ts";
import { layoutTreemap, type TreemapLayout } from "../treemap.ts";

/** Height (CSS px) of the trunk strip at the top of the map. */
export const TRUNK_H = 56;
/** Left edge of the trunk rail (after the TRUNK label). */
const RAIL_X0 = 160;
const PAD = 10;
const LEGEND_H = 34;
const GLOW_SCALE = 0.5;
const MAX_DOTS = 16_000;
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

const easeOut = (u: number): number => 1 - (1 - u) ** 3;
const easeInOut = (u: number): number => (u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2);

interface Dot {
  id: string;
  x: number;
  y: number;
  tx: number;
  ty: number;
  tile: number;
  state: AgentState;
  kind: AgentKind;
  dying: number;
  wanderAt: number;
  px: number;
  py: number;
}

interface Flight {
  sha: string;
  size: number;
  arrived: boolean;
}

interface Spark {
  x0: number;
  y0: number;
  cx: number;
  cy: number;
  x1: number;
  y1: number;
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

function ctx2d(c: HTMLCanvasElement, alpha = true): CanvasRenderingContext2D {
  const ctx = c.getContext("2d", { alpha });
  if (!ctx) throw new Error("canvas 2d unavailable");
  return ctx;
}

/**
 * The colony map: a squarified treemap of files on layered canvases.
 * base (static tiles and labels) < field (marks, redrawn when they change or decay)
 * < glow (half-res copy, CSS-blurred, screen-blended) < fx (agents, sparks, outlines; every frame).
 * Reads the store directly each frame; never goes through React.
 */
export class MapRenderer {
  private readonly bctx: CanvasRenderingContext2D;
  private readonly fctx: CanvasRenderingContext2D;
  private readonly gctx: CanvasRenderingContext2D;
  private readonly lctx: CanvasRenderingContext2D;
  private readonly xctx: CanvasRenderingContext2D;
  private L: TreemapLayout = layoutTreemap([], { x: 0, y: 0, w: 0, h: 0 });
  private W = 1;
  private H = 1;
  private dpr = 1;
  private headX = 600;
  private rect: DOMRect | null = null;
  private filesVersion = -1;
  private raf = 0;
  private lastTs = 0;
  private lastField = 0;
  private fieldAnimating = false;
  private sizeDirty = true;
  private observer: ResizeObserver | null = null;

  private readonly dots = new Map<string, Dot>();
  private readonly dotBuf = [new Float32Array(MAX_DOTS * 3), new Float32Array(MAX_DOTS * 3), new Float32Array(MAX_DOTS * 3)];
  private readonly dotLen = [0, 0, 0];
  private sparks: Spark[] = [];
  private flashes: Flash[] = [];
  private bursts: Array<{ x: number; y: number; t0: number }> = [];
  private beads: Array<{ size: number; t0: number }> = [];
  private beadsSeeded = false;
  private lastBeadAt = -1e9;
  private lastArriveAt = -1e9;
  private displayedSha = "";
  private inFlight = 0;

  private readonly vals = new Float64Array(5);
  private readonly inten = new Float64Array(5);
  private readonly buckets: number[][] = [[], [], [], [], []];
  private readonly stripes: number[][] = [[], [], [], [], []];
  private readonly glows: number[][] = [[], [], [], [], []];

  private mx = -1;
  private my = -1;
  private mouseDirty = false;
  private hover = -1;
  private lastTip = 0;
  private tipHtml = "";
  private tipShown = false;

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

  private onMove = (e: PointerEvent): void => {
    const r = this.rect ?? (this.rect = this.el.wrap.getBoundingClientRect());
    this.mx = e.clientX - r.left;
    this.my = e.clientY - r.top;
    this.mouseDirty = true;
  };

  private onLeave = (): void => {
    this.mx = -1;
    this.my = -1;
    this.mouseDirty = true;
  };

  private onClick = (e: MouseEvent): void => {
    const r = this.rect ?? (this.rect = this.el.wrap.getBoundingClientRect());
    this.mx = e.clientX - r.left;
    this.my = e.clientY - r.top;
    this.hitTest();
    if (this.my < TRUNK_H) return;
    this.onPick(this.hover >= 0 ? (this.L.paths[this.hover] ?? null) : null);
  };

  // -- sizing and layout -----------------------------------------------------

  private resize(): void {
    const rect = this.el.wrap.getBoundingClientRect();
    this.rect = rect;
    const W = Math.max(1, Math.round(rect.width));
    const H = Math.max(1, Math.round(rect.height));
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
    this.headX = Math.max(RAIL_X0 + 80, head.left - rect.left - 18);
    this.relayout();
  }

  private relayout(): void {
    const s = this.store;
    this.filesVersion = s.filesVersion;
    const area = { x: PAD, y: TRUNK_H + 6, w: Math.max(0, this.W - PAD * 2), h: Math.max(0, this.H - TRUNK_H - 6 - LEGEND_H) };
    this.L = layoutTreemap(s.files, area);
    this.hover = -1;
    this.flashes = [];
    this.drawBase();
    s.fieldDirty = true;
    for (const d of this.dots.values()) {
      d.tile = -1;
      const a = s.agents.get(d.id);
      if (a) this.assign(d, a, performance.now());
      else this.scatter(d);
    }
  }

  private drawBase(): void {
    const c = this.bctx;
    const { W, H, L } = this;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.fillStyle = "#05070b";
    c.fillRect(0, 0, W, H);
    for (const d of L.dirs) {
      if (d.depth !== 1) continue;
      c.fillStyle = "#0a0e15";
      c.fillRect(d.x, d.y, d.w, d.h);
    }
    for (let g = 0; g < GROUP_TINT.length; g++) {
      c.fillStyle = GROUP_TINT[g] ?? "#111";
      for (let i = 0; i < L.n; i++) {
        if (L.group[i] !== g) continue;
        const w = L.w[i]!;
        const h = L.h[i]!;
        if (w > 0 && h > 0) c.fillRect(L.x[i]!, L.y[i]!, w, h);
      }
    }
    c.lineWidth = 1;
    for (const d of L.dirs) {
      if (d.w < 2 || d.h < 2) continue;
      c.strokeStyle = d.depth === 1 ? "rgba(150,170,200,0.2)" : "rgba(150,170,200,0.09)";
      c.strokeRect(d.x + 0.5, d.y + 0.5, d.w - 1, d.h - 1);
    }
    this.drawLabels();
  }

  /** Directory and file names on their own layer, above the field, so color never hides them. */
  private drawLabels(): void {
    const c = this.lctx;
    const { W, H, L } = this;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, W, H);
    c.textBaseline = "middle";
    for (const d of L.dirs) {
      if (!d.header) continue;
      const top = d.depth === 1 ? 3 : 2;
      const y = d.y + top + d.header / 2;
      const maxW = d.w - 16;
      if (d.depth === 1) {
        c.font = `600 11px ${SANS}`;
        const name = d.name.toUpperCase();
        const text = fit(c, name, maxW - 30);
        c.fillStyle = "#b3bdcd";
        c.fillText(text, d.x + 8, y);
        const tw = c.measureText(text).width;
        c.font = `500 10px ${MONO}`;
        c.fillStyle = "#56627a";
        if (tw + 40 < maxW) c.fillText(String(d.files), d.x + 14 + tw, y);
      } else {
        c.font = `500 10px ${SANS}`;
        c.fillStyle = "#728097";
        c.fillText(fit(c, d.name, maxW), d.x + 6, y);
      }
    }
    c.font = `10px ${MONO}`;
    c.textBaseline = "top";
    c.shadowColor = "rgba(0,0,0,0.85)";
    c.shadowBlur = 3;
    c.fillStyle = "rgba(214,224,240,0.56)";
    for (let i = 0; i < L.n; i++) {
      const w = L.w[i]!;
      const h = L.h[i]!;
      if (w < 62 || h < 20) continue;
      const max = Math.floor((w - 10) / 6.1);
      const name = basename(L.paths[i] ?? "");
      c.fillText(name.length > max ? `${name.slice(0, Math.max(1, max - 1))}…` : name, L.x[i]! + 5, L.y[i]! + 5);
    }
    c.shadowBlur = 0;
    c.shadowColor = "transparent";
  }

  // -- the frame -------------------------------------------------------------

  private frame = (ts: number): void => {
    this.raf = requestAnimationFrame(this.frame);
    const dt = this.lastTs ? Math.min(0.064, (ts - this.lastTs) / 1000) : 0.016;
    this.lastTs = ts;
    const now = Date.now();
    const s = this.store;
    if (this.sizeDirty) {
      this.sizeDirty = false;
      this.resize();
    } else if (s.filesVersion !== this.filesVersion) {
      this.relayout();
    }
    this.sync(ts);
    if (s.fieldDirty || (this.fieldAnimating && ts - this.lastField > 33) || ts - this.lastField > 500) {
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
  };

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
        if (!d) {
          if (this.dots.size >= MAX_DOTS) continue;
          const x = RAIL_X0 + Math.random() * Math.max(10, this.headX - RAIL_X0);
          d = { id, x, y: TRUNK_H - 6, tx: x, ty: TRUNK_H - 6, tile: -1, state: a.state, kind: a.kind, dying: 0, wanderAt: 0, px: x, py: TRUNK_H - 6 };
          this.dots.set(id, d);
        }
        d.dying = 0;
        d.state = a.state;
        d.kind = a.kind;
        this.assign(d, a, ts);
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
  private assign(d: Dot, a: AgentView, ts: number): void {
    const first = a.paths[0];
    const tile = first !== undefined ? (this.L.index.get(first) ?? -1) : -1;
    if (tile >= 0) {
      if (tile !== d.tile) {
        d.tile = tile;
        this.pickPoint(d);
        d.wanderAt = ts + 900 + Math.random() * 2400;
      }
    } else if (d.tile < 0) {
      this.scatter(d);
    }
  }

  /** Send a dot with no tile to a random file (agents arrive from trunk and spread out). */
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
    const f = this.fctx;
    const g = this.gctx;
    f.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    f.clearRect(0, 0, W, H);
    g.setTransform(GLOW_SCALE, 0, 0, GLOW_SCALE, 0, 0);
    g.clearRect(0, 0, W, H);
    const counts = [0, 0, 0, 0, 0];
    for (let k = 0; k < 5; k++) {
      this.buckets[k]!.length = 0;
      this.stripes[k]!.length = 0;
      this.glows[k]!.length = 0;
    }
    let animating = false;
    const vals = this.vals;
    const I = this.inten;
    const pulse = 0.55 + 0.45 * Math.sin(now / 190);
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
      const i = L.index.get(cell.path);
      if (i === undefined || L.w[i]! <= 0 || L.h[i]! <= 0) continue;
      let dom = -1;
      let domS = 0;
      let sec = -1;
      let secS = 0;
      // A fresh landing owns the tile for a moment (green flash), then the field underneath shows again.
      const recency = cell.trailAt ? Math.exp(-(now - cell.trailAt) / 6000) : 0;
      for (let k = 0; k < 5; k++) {
        const x = intensity(vals[k]!, k);
        I[k] = x;
        if (x > 0.06) counts[k]!++;
        const sc = x * WEIGHT[k]! * (k === TRAIL ? 1 + 5 * recency : 1);
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
      this.buckets[dom]!.push(i, alpha);
      if (sec >= 0 && I[sec]! > 0.28 && L.w[i]! >= 7 && L.h[i]! >= 7) this.stripes[sec]!.push(i);
      // Glow: fresh trails flare and fade; danger pulses; claims and needs glow softly.
      if (recency > 0.02 && I[TRAIL]! > 0.05) {
        animating = true;
        this.glows[TRAIL]!.push(i, Math.min(1, I[TRAIL]! * 1.15 * recency));
      }
      if (dom === DANGER) {
        animating = true;
        this.glows[DANGER]!.push(i, I[DANGER]! * pulse);
      } else if (dom !== TRAIL) {
        const ga = I[dom]! * GLOW[dom]!;
        if (ga > 0.03) this.glows[dom]!.push(i, ga);
      }
    }
    f.lineWidth = 1;
    for (let k = 0; k < 5; k++) {
      const b = this.buckets[k]!;
      if (!b.length) continue;
      const color = FIELD_COLOR_BY_INDEX[k]!;
      const body = BODY[k]!;
      f.fillStyle = color;
      f.strokeStyle = color;
      for (let j = 0; j < b.length; j += 2) {
        const i = b[j]!;
        const a = b[j + 1]!;
        const x = L.x[i]!;
        const y = L.y[i]!;
        const w = L.w[i]!;
        const h = L.h[i]!;
        if (w >= 9 && h >= 9) {
          // Large tiles: a translucent body with a lit edge reads as light, not paint.
          f.globalAlpha = a * body;
          f.fillRect(x, y, w, h);
          f.globalAlpha = Math.min(1, a * 1.35);
          f.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
        } else {
          f.globalAlpha = a;
          f.fillRect(x, y, w, h);
        }
      }
    }
    f.globalAlpha = 0.95;
    for (let k = 0; k < 5; k++) {
      const st = this.stripes[k]!;
      if (!st.length) continue;
      f.fillStyle = FIELD_COLOR_BY_INDEX[k]!;
      for (const i of st) f.fillRect(L.x[i]!, L.y[i]! + L.h[i]! - 2, L.w[i]!, 2);
    }
    f.globalAlpha = 1;
    for (let k = 0; k < 5; k++) {
      const gl = this.glows[k]!;
      if (!gl.length) continue;
      g.fillStyle = FIELD_COLOR_BY_INDEX[k]!;
      for (let j = 0; j < gl.length; j += 2) {
        const i = gl[j]!;
        g.globalAlpha = gl[j + 1]!;
        g.fillRect(L.x[i]! - 2, L.y[i]! - 2, L.w[i]! + 4, L.h[i]! + 4);
      }
    }
    g.globalAlpha = 1;
    this.store.fieldCounts = counts;
    this.fieldAnimating = animating;
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
    const x1 = this.headX;
    const y1 = TRUNK_H / 2;
    tiles.forEach((i, j) => {
      const x0 = L.x[i]! + L.w[i]! / 2;
      const y0 = L.y[i]! + L.h[i]! / 2;
      const dist = Math.hypot(x1 - x0, y1 - y0);
      this.sparks.push({
        x0,
        y0,
        cx: x0 + (x1 - x0) * (0.12 + Math.random() * 0.16),
        cy: y1 + (y0 - y1) * (0.06 + Math.random() * 0.1),
        x1,
        y1,
        t0: ts + j * 38,
        dur: Math.min(1500, 620 + dist * 0.42 + Math.random() * 160),
        flight,
      });
      this.flashes.push({ tile: i, k: TRAIL, t0: ts + j * 38, dur: 900 });
    });
  }

  private arrive(flight: Flight, ts: number): void {
    this.bursts.push({ x: this.headX, y: TRUNK_H / 2, t0: ts });
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
    this.drawRegionAlerts(c, ts);
    this.drawFlashes(c, ts);
    this.drawOutlines(c, ts);
    this.drawDots(c, ts, dt);
    this.drawRail(c, ts);
    this.drawSparks(c, ts);
  }

  private drawRegionAlerts(c: CanvasRenderingContext2D, ts: number): void {
    const L = this.L;
    const now = Date.now();
    for (const [region, s] of this.store.sigma) {
      if (s.sigma <= 1 || now - s.at > 120_000) continue;
      const di = L.dirIndex.get(region);
      const d = di === undefined ? undefined : L.dirs[di];
      if (!d) continue;
      const pulse = 0.5 + 0.5 * Math.sin(ts / 210);
      c.globalAlpha = 0.35 + 0.5 * pulse;
      c.strokeStyle = FIELD_COLOR.danger;
      c.lineWidth = 2;
      c.strokeRect(d.x + 1, d.y + 1, d.w - 2, d.h - 2);
      c.globalAlpha = 0.12 * pulse;
      c.lineWidth = 8;
      c.strokeRect(d.x - 2, d.y - 2, d.w + 4, d.h + 4);
      if (d.header && d.w > 120) {
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
      const grow = 1 + 6 * easeOut(u);
      c.globalAlpha = (1 - u) * 0.9;
      c.strokeStyle = FIELD_COLOR_BY_INDEX[f.k]!;
      c.strokeRect(L.x[f.tile]! - grow, L.y[f.tile]! - grow, L.w[f.tile]! + grow * 2, L.h[f.tile]! + grow * 2);
    }
    c.globalAlpha = 1;
  }

  private drawOutlines(c: CanvasRenderingContext2D, ts: number): void {
    const L = this.L;
    const s = this.store;
    if (s.highlight.length) {
      c.setLineDash([3, 3]);
      c.lineDashOffset = -ts / 60;
      c.strokeStyle = "#ffffff";
      c.globalAlpha = 0.9;
      c.lineWidth = 1.5;
      for (const p of s.highlight) {
        const i = L.index.get(p);
        if (i === undefined) continue;
        c.strokeRect(L.x[i]! - 1.5, L.y[i]! - 1.5, L.w[i]! + 3, L.h[i]! + 3);
      }
      c.setLineDash([]);
    }
    const sel = s.selectedPath ? L.index.get(s.selectedPath) : undefined;
    if (sel !== undefined) {
      const pulse = 0.6 + 0.4 * Math.sin(ts / 240);
      const x = L.x[sel]!;
      const y = L.y[sel]!;
      const w = L.w[sel]!;
      const h = L.h[sel]!;
      c.strokeStyle = ACCENT;
      c.globalAlpha = 0.28 * pulse;
      c.lineWidth = 7;
      c.strokeRect(x - 3.5, y - 3.5, w + 7, h + 7);
      c.globalAlpha = 1;
      c.lineWidth = 2;
      c.strokeRect(x - 1, y - 1, w + 2, h + 2);
    }
    if (this.hover >= 0 && this.hover !== sel) {
      const i = this.hover;
      c.strokeStyle = "#ffffff";
      c.globalAlpha = 0.85;
      c.lineWidth = 1;
      c.strokeRect(L.x[i]! - 0.5, L.y[i]! - 0.5, L.w[i]! + 1, L.h[i]! + 1);
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
    let n = 0;
    c.globalCompositeOperation = "lighter";
    // Agents in transit leave a short streak; every streak goes into one path.
    c.beginPath();
    let streaks = 0;
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
      const vx = d.x - d.px;
      const vy = d.y - d.py;
      if (vx * vx + vy * vy > 0.7 && streaks < 4000) {
        c.moveTo(d.x, d.y);
        c.lineTo(d.x - vx * 4, d.y - vy * 4);
        streaks++;
      }
      if (ts > d.wanderAt) {
        this.pickPoint(d);
        d.wanderAt = ts + (busy ? 1400 : 2600) + Math.random() * 3200;
      }
      const group = !busy || fade < 1 ? 2 : d.kind === "external" ? 1 : 0;
      const b = buf[group]!;
      const o = len[group]!;
      b[o] = d.x;
      b[o + 1] = d.y;
      b[o + 2] = many ? (busy ? 2.2 : 1.6) : d.state === "proposing" ? 4 : busy ? 3 : 2.2;
      len[group] = o + 3;
      n++;
    }
    if (streaks) {
      c.strokeStyle = "rgba(225,238,255,0.34)";
      c.lineWidth = 1.3;
      c.lineCap = "round";
      c.stroke();
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
        const s = b[o + 2]!;
        c.rect(b[o]! - s / 2, b[o + 1]! - s / 2, s, s);
      }
      c.fill();
    };
    draw(2, "#93a7c6", 0.55, 0);
    draw(0, "#f4f8ff", 1, many ? 0 : 0.2);
    draw(1, "#7fe6ff", 1, many ? 0 : 0.2);
    c.globalAlpha = 1;
    c.globalCompositeOperation = "source-over";
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
    const shift = spacing * (1 - easeOut(Math.min(1, (ts - this.lastBeadAt) / 320)));
    for (let j = 0; j < this.beads.length; j++) {
      const b = this.beads[this.beads.length - 1 - j]!;
      const x = x1 - 12 - j * spacing + shift;
      if (x < x0 + 8) break;
      const r = 1.8 + Math.min(3.2, Math.sqrt(b.size) * 0.75);
      c.globalAlpha = Math.max(0.16, 1 - j * 0.03) * Math.min(1, (x - x0) / 60);
      c.fillStyle = j === 0 ? "#ffd8b4" : ACCENT;
      c.beginPath();
      c.arc(x, y, r, 0, Math.PI * 2);
      c.fill();
    }
    const k = Math.exp(-(ts - this.lastArriveAt) / 520);
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
    c.globalCompositeOperation = "lighter";
    c.lineCap = "round";
    for (let j = list.length - 1; j >= 0; j--) {
      const s = list[j]!;
      const u = (ts - s.t0) / s.dur;
      if (u < 0) continue;
      if (u >= 1) {
        const last = list.pop()!;
        if (j < list.length) list[j] = last;
        const done = !list.some((o) => o.flight === s.flight);
        this.arrive(s.flight, ts);
        if (done) this.inFlight = Math.max(0, this.inFlight - 1);
        continue;
      }
      const e = easeInOut(u);
      let px = bez(s.x0, s.cx, s.x1, e);
      let py = bez(s.y0, s.cy, s.y1, e);
      const hx = px;
      const hy = py;
      c.strokeStyle = ACCENT;
      for (let k = 1; k <= 5; k++) {
        const e2 = Math.max(0, e - k * 0.04);
        const qx = bez(s.x0, s.cx, s.x1, e2);
        const qy = bez(s.y0, s.cy, s.y1, e2);
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
    const mx = this.mx;
    const my = this.my;
    let found = -1;
    if (mx >= 0 && my >= TRUNK_H) {
      const prev = this.hover;
      if (prev >= 0 && prev < L.n && inside(L, prev, mx, my)) found = prev;
      else {
        for (let i = 0; i < L.n; i++) {
          if (inside(L, i, mx, my)) {
            found = i;
            break;
          }
        }
      }
    }
    if (found !== this.hover) {
      this.hover = found;
      this.el.wrap.style.cursor = found >= 0 ? "pointer" : "";
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
    if (i < 0) {
      if (this.tipShown) {
        tip.style.opacity = "0";
        this.tipShown = false;
      }
      return;
    }
    const path = this.L.paths[i] ?? "";
    const vals = this.store.fieldValues(path, now);
    let agents = 0;
    for (const d of this.dots.values()) if (d.tile === i && d.state !== "idle" && !d.dying) agents++;
    const rows = KINDS.map((kind) => {
      const v = vals[kind];
      const pct = Math.round(intensity(v, KIND_INDEX[kind]) * 100);
      return `<div class="tip-row${v > 0.005 ? "" : " zero"}"><i style="background:${FIELD_COLOR[kind]}"></i><span class="tip-k">${kind}</span><span class="tip-bar"><b style="width:${pct}%;background:${FIELD_COLOR[kind]}"></b></span><span class="tip-v">${v.toFixed(2)}</span></div>`;
    }).join("");
    const size = this.L.sizes[i] ?? 0;
    const html =
      `<div class="tip-path"><span class="tip-dir">${escapeHtml(dirname(path))}</span>${escapeHtml(basename(path))}</div>` +
      `<div class="tip-meta">${escapeHtml(regionOf(path))} · ${fmtBytes(size)} · ${agents} ${agents === 1 ? "agent" : "agents"} here</div>` +
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

function inside(L: TreemapLayout, i: number, mx: number, my: number): boolean {
  const x = L.x[i]!;
  const y = L.y[i]!;
  return mx >= x - 0.6 && mx < x + L.w[i]! + 0.6 && my >= y - 0.6 && my < y + L.h[i]! + 0.6;
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

