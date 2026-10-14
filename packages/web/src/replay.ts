import type { AgentKind, ColonyEvent, ColonySnapshot, EventsPage, Id, IntentStatus, Proposal, RecordedEvent, Rule } from "@fire_trident/core";
import { HttpError, type Backend, type EscalationDecision, type ReviewDecision, type WhyEntry } from "./api.ts";
import { finite } from "./format.ts";
import { isColonyEvent, type ColonyStore } from "./store.ts";
import { TAU_MS } from "./theme.ts";

/**
 * Replays of finished runs (/c/:id?replay=1). The colony's record (GET /api/colonies/:id/events) is
 * applied to the same store the live view uses, on a virtual clock, so the map, counters, funnel,
 * trunk rail, sigma and events tab move as they did live. The record keeps no field marks: the
 * replay derives needs, claims and failures from intents, claims and returns (FieldSynth); trails
 * come from landings as they do live.
 */

/** Replay speeds offered. */
export const SPEEDS: readonly number[] = [1, 2, 4, 8, 16];
/** Shown before the first event and after the last one. */
const LEAD_MS = 1_500;
const TAIL_MS = 2_500;
/** A gap with no event longer than this is skipped down to SKIP_KEEP_MS (a colony idle for hours). */
const SKIP_GAP_MS = 60_000;
const SKIP_KEEP_MS = 2_000;
/** A jump forward longer than this applies its events without animation (seeking, not playing). */
const QUIET_JUMP_MS = 3_000;
/** Events read per page, and in all at most. */
const PAGE = 5_000;
const MAX_EVENTS = 250_000;
const FAILURE_TAU = TAU_MS.failure ?? 30 * 60_000;
/** Returns that change direction leave no failure mark (see the worker's isRedirect). */
const REDIRECT = /^(withdrawn|intent revised|superseded)\b/i;

// ---------------------------------------------------------------------------
// The field, derived
// ---------------------------------------------------------------------------

/**
 * The field marks a run implied, from its intents and returns: a need on every file of an open or
 * claimed intent (its priority, summed per file), a claim while an intent is claimed or proposed, and a
 * failure (0.5, decaying) when a change came back. Landed and withdrawn intents leave the field; the
 * store lays trails and spends claims on landed files itself.
 */
export class FieldSynth {
  private readonly intents = new Map<Id, { footprint: string[]; status: IntentStatus }>();
  private readonly need = new Map<string, Map<Id, number>>();
  private readonly claim = new Map<string, Set<Id>>();
  private readonly failure = new Map<string, { v: number; at: number }>();

  /** `priority` gives an intent's need strength (1 when unknown). */
  constructor(private readonly priority: (intentId: Id) => number = () => 1) {}

  /** Forget everything (the replay starts over). */
  reset(): void {
    this.intents.clear();
    this.need.clear();
    this.claim.clear();
    this.failure.clear();
  }

  /** The mark events one event implies, to apply right after it. */
  derive(e: ColonyEvent): ColonyEvent[] {
    if (e.t === "intent") return this.onIntent(e.intentId, e.status, Array.isArray(e.footprint) ? e.footprint : [], e.at);
    if (e.t === "withdrawn") return this.onIntent(e.intentId, "withdrawn", [], e.at);
    if (e.t === "proposal" && (e.status === "returned" || e.status === "rejected") && !REDIRECT.test(e.reason ?? "")) {
      const fp = this.intents.get(e.intentId)?.footprint ?? [];
      return fp.map((path) => {
        const prev = this.failure.get(path);
        const v = (prev ? prev.v * Math.exp(-Math.max(0, e.at - prev.at) / FAILURE_TAU) : 0) + 0.5;
        this.failure.set(path, { v, at: e.at });
        return { t: "mark", at: e.at, region: "", path, kind: "failure", value: round(v) };
      });
    }
    return [];
  }

  private onIntent(id: Id, status: IntentStatus, footprint: string[], at: number): ColonyEvent[] {
    const prev = this.intents.get(id);
    const fp = footprint.length ? footprint : (prev?.footprint ?? []);
    const touched = new Set<string>([...fp, ...(prev?.footprint ?? [])]);
    // A footprint that moved (an amendment) leaves its old files.
    for (const path of prev?.footprint ?? []) {
      if (fp.includes(path)) continue;
      this.need.get(path)?.delete(id);
      this.claim.get(path)?.delete(id);
    }
    const live = status === "open" || status === "claimed" || status === "proposed";
    for (const path of fp) {
      if (live) {
        let n = this.need.get(path);
        if (!n) this.need.set(path, (n = new Map()));
        n.set(id, Math.max(0, this.priority(id)));
      } else {
        this.need.get(path)?.delete(id);
      }
      let c = this.claim.get(path);
      if (status === "claimed" || status === "proposed") {
        if (!c) this.claim.set(path, (c = new Set()));
        c.add(id);
      } else {
        c?.delete(id);
      }
    }
    this.intents.set(id, { footprint: fp, status });
    const out: ColonyEvent[] = [];
    for (const path of touched) {
      let need = 0;
      for (const v of this.need.get(path)?.values() ?? []) need += v;
      out.push({ t: "mark", at, region: "", path, kind: "need", value: round(need) });
      out.push({ t: "mark", at, region: "", path, kind: "claim", value: this.claim.get(path)?.size ?? 0 });
    }
    return out;
  }
}

const round = (v: number): number => Math.round(v * 10_000) / 10_000;

// ---------------------------------------------------------------------------
// The timeline
// ---------------------------------------------------------------------------

/** A run's events in record order, with times made monotone (a batch from a region can carry an earlier time). */
export class Timeline {
  readonly events: RecordedEvent[];
  readonly times: Float64Array;

  constructor(events: readonly RecordedEvent[]) {
    this.events = [...events].filter(isColonyEvent).sort((a, b) => a.seq - b.seq) as RecordedEvent[];
    this.times = new Float64Array(this.events.length);
    let t = Number.NEGATIVE_INFINITY;
    this.events.forEach((e, i) => {
      t = Math.max(t, finite(e.at, t));
      this.times[i] = t;
    });
  }

  get length(): number {
    return this.events.length;
  }

  /** Time of the first event (0 when empty). */
  get first(): number {
    return this.events.length ? (this.times[0] ?? 0) : 0;
  }

  /** Time of the last event (0 when empty). */
  get last(): number {
    return this.events.length ? (this.times[this.events.length - 1] ?? 0) : 0;
  }

  /** How many events happened at or before `t` (the index of the first one after it). */
  upTo(t: number): number {
    let lo = 0;
    let hi = this.times.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((this.times[mid] ?? 0) <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}

/**
 * What the replay starts from: the colony as it was before its first event. The finished colony's
 * snapshot gives the record (name, rules, files); what happened during the run is taken out. Files
 * that the run created (a new project: no source repository) appear as they land; `newFiles` holds
 * them with their final size.
 */
export function startingPoint(snap: ColonySnapshot, timeline: Timeline): { snapshot: ColonySnapshot; newFiles: Map<string, number> } {
  const t0 = timeline.first;
  const landed = new Set<string>();
  for (const e of timeline.events) if (e.t === "landing") for (const p of e.paths ?? []) landed.add(p);
  const fromSpec = !snap.colony.source;
  const newFiles = new Map<string, number>();
  const files: Array<{ path: string; size: number }> = [];
  for (const f of snap.files ?? []) {
    if (fromSpec && landed.has(f.path)) newFiles.set(f.path, f.size);
    else files.push(f);
  }
  const rules: Rule[] = (snap.rules ?? []).map((r) => {
    if (typeof r.retractedAt !== "number" || r.retractedAt < t0) return r;
    const { retractedAt: _at, retractedBy: _by, retractReason: _reason, ...rest } = r;
    return rest;
  });
  // Certification arrives as `certify` events; the finished run's green commit and result are not the start.
  const { greenSha: _green, certification: _cert, ...colony } = snap.colony;
  const snapshot: ColonySnapshot = {
    colony: { ...colony, trunkSha: "" },
    files,
    intents: [],
    rules,
    agents: [],
    recentLandings: [],
    violations: { total: 0, byRule: {} },
    // The record carries settled totals per stage (funnel.* metrics): count proposals, not decisions.
    funnel: { proof: 0, reflex: 0, llm: 0, human: 0 },
    metrics: {},
  };
  return { snapshot, newFiles };
}

// ---------------------------------------------------------------------------
// The engine (no DOM: the backend drives it, tests call it directly)
// ---------------------------------------------------------------------------

/** Applies a timeline to a store on a virtual clock: forward as it plays, from the start again on a seek back. */
export class ReplayEngine {
  /** The virtual time: the colony's clock during the replay. */
  vt: number;
  /** Events applied so far. */
  cursor = 0;
  readonly start: number;
  readonly end: number;
  private pendingFiles: Map<string, number>;

  constructor(
    readonly store: ColonyStore,
    readonly timeline: Timeline,
    private readonly initial: ColonySnapshot,
    private readonly newFiles: Map<string, number>,
    private readonly synth: FieldSynth,
  ) {
    this.start = timeline.first - LEAD_MS;
    this.end = timeline.last + TAIL_MS;
    this.vt = this.start;
    this.pendingFiles = new Map(newFiles);
    store.now = () => this.vt;
  }

  /** Put the colony back where the run started. */
  begin(): void {
    const s = this.store;
    this.vt = this.start;
    this.cursor = 0;
    this.synth.reset();
    this.pendingFiles = new Map(this.newFiles);
    s.reset();
    s.startedAt = this.start;
    s.autoMergeFiles = false;
    s.applySnapshot(this.initial);
  }

  /** Apply every event up to time `t` (animated unless `quiet`). Earlier times are ignored: use seek. */
  advanceTo(t: number, quiet = false): number {
    const target = Math.max(this.vt, Math.min(t, this.end));
    const upto = this.timeline.upTo(target);
    this.vt = target;
    if (upto <= this.cursor) return 0;
    const s = this.store;
    const batch: ColonyEvent[] = [];
    for (let i = this.cursor; i < upto; i++) {
      const e = this.timeline.events[i];
      if (!e) continue;
      if (e.t === "landing" && this.pendingFiles.size) {
        // A new project's files appear as they land, at their final size.
        const add: Array<{ path: string; size: number }> = [];
        for (const p of e.paths ?? []) {
          const size = this.pendingFiles.get(p);
          if (size === undefined) continue;
          this.pendingFiles.delete(p);
          add.push({ path: p, size });
        }
        if (add.length) {
          if (batch.length) this.flush(batch, quiet);
          s.addFiles(add);
        }
      }
      batch.push(e);
      for (const m of this.synth.derive(e)) batch.push(m);
    }
    this.cursor = upto;
    this.flush(batch, quiet);
    return upto;
  }

  /** Go to time `t`: forward by applying what happened in between, back by starting over. */
  seek(t: number): void {
    const target = Math.max(this.start, Math.min(t, this.end));
    if (target < this.vt) {
      this.begin();
      this.advanceTo(target, true);
      return;
    }
    this.advanceTo(target, target - this.vt > QUIET_JUMP_MS);
  }

  /** The time of the next event not applied yet, or null at the end. */
  nextAt(): number | null {
    return this.cursor < this.timeline.length ? (this.timeline.times[this.cursor] ?? null) : null;
  }

  /** Where playback should be after `dt` virtual ms: long idle gaps are skipped down to a moment. */
  stepTarget(dt: number): number {
    let target = this.vt + dt;
    const next = this.nextAt();
    if (next !== null && next - this.vt > SKIP_GAP_MS) target = Math.max(target, next - SKIP_KEEP_MS);
    return Math.min(target, this.end);
  }

  private flush(batch: ColonyEvent[], quiet: boolean): void {
    if (!batch.length) return;
    const s = this.store;
    const was = s.fxMuted;
    s.fxMuted = quiet;
    try {
      s.applyEvents(batch.splice(0, batch.length));
    } finally {
      s.fxMuted = was;
    }
  }
}

// ---------------------------------------------------------------------------
// The backend (fetches the record and plays it)
// ---------------------------------------------------------------------------

/** Playback state for the controls. */
export interface ReplayState {
  ready: boolean;
  playing: boolean;
  ended: boolean;
  speed: number;
  /** Virtual time now, and the run's span. */
  at: number;
  start: number;
  end: number;
  source: "recorded" | "reconstructed";
  events: number;
  /** Events loaded so far while loading. */
  loaded: number;
  total: number;
}

/** Options from the address bar: the record to read, speed, start offset (seconds), and a wait before playing. */
export interface ReplayOptions {
  source?: "auto" | "recorded" | "reconstructed";
  speed?: number;
  offsetS?: number;
  delayS?: number;
}

/**
 * A Backend that plays a finished run: it loads the snapshot (the record's frame: name, rules, files),
 * the agents (names), and every page of the event record, then applies them on a virtual clock.
 */
export class ReplayBackend implements Backend {
  readonly mode = "replay" as const;
  private store: ColonyStore | null = null;
  private engine: ReplayEngine | null = null;
  private stopped = false;
  private raf = 0;
  private timer = 0;
  private lastWall = 0;
  private holdUntil = 0;
  private readonly listeners = new Set<() => void>();
  state: ReplayState;

  constructor(
    readonly colonyId: string,
    private readonly opts: ReplayOptions = {},
  ) {
    const speed = SPEEDS.includes(opts.speed ?? 1) ? (opts.speed ?? 1) : 1;
    this.state = { ready: false, playing: false, ended: false, speed, at: 0, start: 0, end: 0, source: "recorded", events: 0, loaded: 0, total: 0 };
  }

  private url(suffix: string): string {
    return `/api/colonies/${encodeURIComponent(this.colonyId)}${suffix}`;
  }

  private async getJson<T>(suffix: string): Promise<T> {
    const res = await fetch(this.url(suffix), { headers: { accept: "application/json" } });
    if (!res.ok) throw new HttpError(res.status, `${res.status} ${res.statusText}`.trim());
    return (await res.json()) as T;
  }

  /** Watch playback state (the controls); returns the unsubscribe function. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(patch: Partial<ReplayState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  start(store: ColonyStore): void {
    this.store = store;
    this.stopped = false;
    store.setConn("connecting");
    store.loadingText = "Loading the colony's record…";
    void this.load(store).catch((err: unknown) => {
      if (this.stopped) return;
      const msg = err instanceof HttpError && err.status === 404 ? `Colony “${this.colonyId}” was not found (404).` : `Can't load the replay (${err instanceof Error ? err.message : "network error"}).`;
      store.setConn("error", msg);
    });
  }

  private async load(store: ColonyStore): Promise<void> {
    const source = this.opts.source && this.opts.source !== "auto" ? `&source=${this.opts.source}` : "";
    const [snap, agents] = await Promise.all([
      this.getJson<ColonySnapshot>(""),
      this.getJson<{ agents?: Array<{ id: string; name?: string; kind?: AgentKind }> }>("/agents?all=1&journal=0&limit=10000").catch(() => ({ agents: [] })),
    ]);
    if (this.stopped) return;
    if (!snap || !snap.colony) throw new Error("malformed snapshot");
    for (const a of agents.agents ?? []) {
      if (!a || typeof a.id !== "string") continue;
      if (a.name) store.agentNames.set(a.id, a.name);
      if (a.kind) store.agentKinds.set(a.id, a.kind);
    }
    // The record's intent events carry no origin; the finished colony's snapshot names it for the intents it
    // lists (the Intents tab places the rest by the titles the colony writes for its own intents).
    store.learnIntents(snap.intents ?? []);
    const events: RecordedEvent[] = [];
    let after = 0;
    let src: "recorded" | "reconstructed" = "recorded";
    for (;;) {
      const page = await this.getJson<EventsPage>(`/events?after=${after}&limit=${PAGE}${source}`);
      if (this.stopped) return;
      src = page.source;
      events.push(...(page.events ?? []));
      this.emit({ loaded: events.length, total: page.total ?? events.length, source: src });
      store.loadingText = `Loading the ${src === "reconstructed" ? "reconstructed " : ""}replay: ${events.length.toLocaleString("en-US")} of ${(page.total ?? events.length).toLocaleString("en-US")} events…`;
      store.bump();
      if (page.next === null || page.next === undefined || events.length >= MAX_EVENTS || !page.events?.length) break;
      after = page.next;
    }
    if (!events.length) {
      store.setConn("error", "This colony has no events to replay yet.");
      return;
    }
    const timeline = new Timeline(events);
    const { snapshot, newFiles } = startingPoint(snap, timeline);
    const priorities = new Map((snap.intents ?? []).map((i) => [i.id, finite(i.priority, 1)]));
    const engine = new ReplayEngine(store, timeline, snapshot, newFiles, new FieldSynth((id) => priorities.get(id) ?? 1));
    this.engine = engine;
    store.replay = { startedAt: timeline.first, source: src };
    store.loadingText = null;
    engine.begin();
    const offset = Math.max(0, finite(this.opts.offsetS, 0)) * 1000;
    if (offset > 0) engine.seek(engine.start + offset);
    store.setConn("replay", null);
    this.holdUntil = performance.now() + Math.max(0, finite(this.opts.delayS, 0)) * 1000;
    this.emit({ ready: true, playing: true, ended: false, at: engine.vt, start: engine.start, end: engine.end, events: timeline.length, source: src });
    this.loop();
  }

  /** The frame loop: rAF while visible, a slow timer when the tab is hidden. */
  private loop(): void {
    cancelAnimationFrame(this.raf);
    window.clearTimeout(this.timer);
    this.lastWall = performance.now();
    const step = () => {
      if (this.stopped) return;
      this.tick(performance.now());
      if (document.hidden) this.timer = window.setTimeout(step, 250);
      else this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  private tick(wall: number): void {
    const engine = this.engine;
    const dtWall = Math.min(1_000, Math.max(0, wall - this.lastWall));
    this.lastWall = wall;
    if (!engine || !this.state.playing || wall < this.holdUntil) return;
    engine.advanceTo(engine.stepTarget(dtWall * this.state.speed));
    const ended = engine.vt >= engine.end;
    // At most ten control updates a second.
    if (ended || Math.floor(wall / 100) !== Math.floor((wall - dtWall) / 100)) this.emit({ at: engine.vt, ...(ended ? { playing: false, ended: true } : {}) });
  }

  /** Play or pause; playing at the end starts over. */
  toggle(): void {
    this.setPaused(this.state.playing);
  }

  /** Pause or resume (the director's space key). */
  setPaused(paused: boolean): void {
    const engine = this.engine;
    if (!engine) return;
    if (!paused && this.state.ended) {
      engine.begin();
      this.emit({ ended: false, at: engine.vt });
    }
    this.lastWall = performance.now();
    this.holdUntil = 0;
    this.emit({ playing: !paused });
  }

  /** Change the speed (1, 2, 4, 8 or 16). */
  setSpeed(speed: number): void {
    if (SPEEDS.includes(speed)) this.emit({ speed });
  }

  /** Jump to a virtual time. */
  seek(at: number): void {
    const engine = this.engine;
    if (!engine) return;
    engine.seek(at);
    this.emit({ at: engine.vt, ended: engine.vt >= engine.end, ...(engine.vt >= engine.end ? { playing: false } : {}) });
  }

  stop(): void {
    this.stopped = true;
    cancelAnimationFrame(this.raf);
    window.clearTimeout(this.timer);
    if (this.store) this.store.now = () => Date.now();
  }

  /** The real lineage of a file (a replay shows how the colony remembers it now). */
  async why(path: string): Promise<WhyEntry[]> {
    const data = await this.getJson<unknown>(`/why?path=${encodeURIComponent(path)}`);
    return Array.isArray(data) ? (data as WhyEntry[]).filter((e) => e && e.landing && e.note) : [];
  }

  /** A replay has no review queue to act on: what waited for a person is history. */
  async review(): Promise<Proposal[]> {
    return [];
  }

  async decide(_proposalId: string, _decision: ReviewDecision, _reason: string): Promise<void> {
    throw new Error("A replay is read-only: open the live colony to review.");
  }

  async resolveEscalation(_intentId: string, _decision: EscalationDecision, _note: string): Promise<void> {
    throw new Error("A replay is read-only: open the live colony to answer a report.");
  }
}
