import type {
  AgentKind,
  AgentState,
  Colony,
  ColonyEvent,
  ColonySnapshot,
  DecisionLayer,
  FieldReading,
  Id,
  IntentSource,
  IntentStatus,
  MarkKind,
  ProposalStatus,
  Rule,
} from "@fire_trident/core";
import { KIND_INDEX, KINDS, decayed } from "./theme.ts";

/** Connection state shown in the top bar. */
export type ConnState = "connecting" | "live" | "reconnecting" | "error" | "mock";

/** Field values on one path. Values are stored as of `at` and decayed on read. */
export interface FieldCell {
  readonly path: string;
  /** Value per kind (KINDS order) as of `at[k]`. */
  readonly v: Float64Array;
  readonly at: Float64Array;
  /** Epoch ms when any value last rose (pop-in animation). */
  popAt: number;
  /** Epoch ms of the last live trail deposit (landing glow). */
  trailAt: number;
}

export interface AgentView {
  id: Id;
  kind: AgentKind;
  state: AgentState;
  name: string;
  model?: string;
  intentId?: Id;
  paths: string[];
  seen: number;
}

export interface IntentView {
  id: Id;
  title: string;
  why?: string;
  status: IntentStatus;
  footprint: string[];
  source?: IntentSource;
  priority: number;
  createdAt: number;
  updatedAt: number;
  assignedTo?: Id;
  ruleId?: Id;
}

export interface ProposalView {
  id: Id;
  intentId: Id;
  agentId: Id;
  status: ProposalStatus;
  reason?: string;
  updatedAt: number;
}

export interface LandingView {
  id: Id;
  trunkSha: string;
  proposalIds: Id[];
  paths: string[];
  at: number;
  receivedAt: number;
}

export interface LoggedEvent {
  seq: number;
  ev: ColonyEvent;
  /** For `violations` events: change against the previous total. */
  delta?: number;
}

export interface MarkFx {
  path: string;
  kind: MarkKind;
}

const EVENT_TYPES: ReadonlySet<string> = new Set(["agent", "mark", "intent", "proposal", "landing", "decision", "sigma", "violations", "metric"]);
const IN_FLIGHT: ReadonlySet<ProposalStatus> = new Set<ProposalStatus>(["pending", "checking", "ready", "escalated"]);
const FINAL: ReadonlySet<ProposalStatus> = new Set<ProposalStatus>(["landed", "returned", "rejected"]);
const LOG_CAP = 2000;
const FX_CAP = 3000;
const CLAIM = KIND_INDEX.claim;
const FUNNEL_METRIC: Readonly<Record<string, DecisionLayer>> = { funnelreflex: "reflex", funnelllm: "llm", funnelhuman: "human" };
const TRAIL = KIND_INDEX.trail;

/** True if `x` looks like a ColonyEvent this UI understands. */
export function isColonyEvent(x: unknown): x is ColonyEvent {
  if (typeof x !== "object" || x === null) return false;
  const t = (x as { t?: unknown }).t;
  return typeof t === "string" && EVENT_TYPES.has(t);
}

/** Normalized metric name: lowercase alphanumerics, so agentsActive = agents_active = agents.active. */
export function metricKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * The colony as the UI knows it: a snapshot plus every live event applied since.
 * Mutable on purpose. The map reads it every frame; React reads it through
 * throttled subscriptions (see useThrottledVersion).
 */
export class ColonyStore {
  readonly colonyId: string;
  colony: Colony | null = null;
  files: Array<{ path: string; size: number }> = [];
  filesVersion = 0;
  private known = new Set<string>();
  private unknown = new Set<string>();
  private lastFileMerge = 0;

  conn: ConnState = "connecting";
  error: string | null = null;
  retryAt = 0;
  loaded = false;
  readonly startedAt = Date.now();

  readonly field = new Map<string, FieldCell>();
  readonly active = new Set<FieldCell>();
  fieldDirty = true;
  /** Tiles per kind above the display threshold, written by the map renderer. */
  fieldCounts: number[] = [0, 0, 0, 0, 0];
  /** Agent dots on the map, written by the map renderer. */
  dotCount = 0;

  readonly agents = new Map<Id, AgentView>();
  readonly agentsByState: Record<AgentState, number> = { idle: 0, working: 0, proposing: 0, waiting: 0, dead: 0 };
  readonly intents = new Map<Id, IntentView>();
  readonly intentsByStatus: Record<IntentStatus, number> = { open: 0, claimed: 0, proposed: 0, landed: 0, abandoned: 0 };
  intentsVersion = 0;
  readonly proposals = new Map<Id, ProposalView>();
  readonly rules = new Map<Id, Rule>();
  inFlight = 0;
  escalated = 0;
  reviewVersion = 0;

  landings: LandingView[] = [];
  private landingTimes: number[] = [];
  landingsSeen = 0;
  trunkSha = "";
  greenSha = "";

  violations: { total: number; byRule: Record<Id, number> } = { total: 0, byRule: {} };
  /** Violations fixed since the total was last zero (or since load). */
  fixedRun = 0;
  private fixes: Array<[number, number]> = [];

  funnel: Record<DecisionLayer, number> = { reflex: 0, llm: 0, human: 0 };
  readonly lastDecisionAt: Record<DecisionLayer, number> = { reflex: 0, llm: 0, human: 0 };
  readonly metrics = new Map<string, number>();
  readonly sigma = new Map<string, { sigma: number; at: number }>();

  private ring: Array<LoggedEvent | undefined> = new Array<LoggedEvent | undefined>(LOG_CAP);
  private ringHead = 0;
  private seq = 0;
  readonly typeCounts = new Map<string, number>();

  /** Fx queues drained by the map renderer each frame. */
  readonly agentChanges = new Set<Id>();
  landingFx: LandingView[] = [];
  markFx: MarkFx[] = [];

  selectedPath: string | null = null;
  highlight: string[] = [];

  version = 0;
  private listeners = new Set<() => void>();

  constructor(colonyId: string) {
    this.colonyId = colonyId;
  }

  /** Register a change listener; returns the unsubscribe function. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Mark the store changed and notify listeners (they throttle themselves). */
  bump(): void {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  /** Update the connection state. */
  setConn(conn: ConnState, error: string | null = this.error): void {
    this.conn = conn;
    this.error = error;
    this.bump();
  }

  /** Replace everything with a snapshot from the server or the simulator. */
  applySnapshot(s: ColonySnapshot): void {
    const now = Date.now();
    this.colony = s.colony;
    this.trunkSha = s.colony.trunkSha;
    this.greenSha = s.colony.greenSha ?? "";
    this.setFiles(s.files ?? []);

    this.intents.clear();
    for (const k of Object.keys(this.intentsByStatus) as IntentStatus[]) this.intentsByStatus[k] = 0;
    for (const i of s.intents ?? []) {
      this.intents.set(i.id, {
        id: i.id,
        title: i.title,
        why: i.why,
        status: i.status,
        footprint: i.footprint ?? [],
        source: i.source,
        priority: i.priority ?? 1,
        createdAt: i.createdAt,
        updatedAt: i.createdAt,
        assignedTo: i.assignedTo,
        ruleId: i.ruleId,
      });
      this.intentsByStatus[i.status] = (this.intentsByStatus[i.status] ?? 0) + 1;
    }
    this.intentsVersion++;

    this.rules.clear();
    for (const r of s.rules ?? []) if (r && r.id) this.rules.set(r.id, r);

    for (const id of this.agents.keys()) this.agentChanges.add(id);
    this.agents.clear();
    for (const k of Object.keys(this.agentsByState) as AgentState[]) this.agentsByState[k] = 0;
    for (const a of s.agents ?? []) {
      if (a.state === "dead") continue;
      this.agents.set(a.id, {
        id: a.id,
        kind: a.kind,
        state: a.state,
        name: a.name || a.id,
        model: a.model,
        intentId: a.intentId,
        paths: a.intentId ? (this.intents.get(a.intentId)?.footprint ?? []) : [],
        seen: a.lastSeen ?? now,
      });
      this.agentsByState[a.state]++;
      this.agentChanges.add(a.id);
    }

    const recent = [...(s.recentLandings ?? [])].sort((a, b) => a.at - b.at);
    this.landings = recent.map((l) => ({ id: l.id, trunkSha: l.trunkSha, proposalIds: l.proposalIds, paths: l.paths, at: l.at, receivedAt: l.at }));
    this.landingTimes = recent.filter((l) => now - l.at < 60_000).map((l) => l.at);

    this.violations = { total: s.violations?.total ?? 0, byRule: s.violations?.byRule ?? {} };
    this.fixedRun = 0;
    this.fixes = [];
    this.funnel = { reflex: s.funnel?.reflex ?? 0, llm: s.funnel?.llm ?? 0, human: s.funnel?.human ?? 0 };
    this.metrics.clear();
    for (const [k, v] of Object.entries(s.metrics ?? {})) if (typeof v === "number") this.metrics.set(metricKey(k), v);

    this.loaded = true;
    this.error = null;
    this.fieldDirty = true;
    this.bump();
  }

  /**
   * Seed the field from region readings (values as of each reading's `at`). With `replace`,
   * values older than the readings are dropped first (a resync after a reconnect).
   */
  applyField(readings: FieldReading[], replace = false): void {
    if (replace && readings.length) {
      const asOf = Math.min(...readings.map((r) => (typeof r?.at === "number" ? r.at : 0)));
      for (const cell of this.field.values()) for (let k = 0; k < 5; k++) if ((cell.at[k] ?? 0) <= asOf) cell.v[k] = 0;
    }
    for (const r of readings) {
      if (!r || typeof r.byPath !== "object") continue;
      for (const [path, vals] of Object.entries(r.byPath)) {
        for (const kind of KINDS) {
          const v = vals?.[kind];
          if (typeof v === "number" && v > 0) this.setMark(path, kind, v, r.at, false);
        }
      }
      if (typeof r.sigma === "number") this.sigma.set(r.region, { sigma: r.sigma, at: Date.now() });
    }
    this.bump();
  }

  /** Apply a batch of live events. */
  applyEvents(evs: readonly unknown[]): void {
    const now = Date.now();
    let n = 0;
    for (const ev of evs) {
      if (!isColonyEvent(ev)) continue;
      this.applyOne(ev, now);
      n++;
    }
    if (this.unknown.size && now - this.lastFileMerge > 15_000) this.mergeUnknownFiles(now);
    if (n) this.bump();
  }

  private applyOne(ev: ColonyEvent, now: number): void {
    let delta: number | undefined;
    switch (ev.t) {
      case "agent":
        this.onAgent(ev, now);
        break;
      case "mark":
        this.setMark(ev.path, ev.kind, ev.value, ev.at, true);
        break;
      case "intent":
        this.onIntent(ev, now);
        break;
      case "proposal":
        this.onProposal(ev, now);
        break;
      case "landing":
        this.onLanding(ev, now);
        break;
      case "decision":
        this.funnel[ev.layer] = (this.funnel[ev.layer] ?? 0) + 1;
        this.lastDecisionAt[ev.layer] = now;
        break;
      case "sigma":
        this.sigma.set(ev.region, { sigma: ev.sigma, at: now });
        break;
      case "violations":
        delta = this.onViolations(ev.total, ev.byRule, now);
        break;
      case "metric": {
        const key = metricKey(ev.name);
        this.metrics.set(key, ev.value);
        // Authoritative funnel totals (funnel.reflex, funnel.llm, funnel.human) correct the running count.
        const layer = FUNNEL_METRIC[key];
        if (layer && Number.isFinite(ev.value)) this.funnel[layer] = ev.value;
        break;
      }
    }
    this.ring[this.ringHead] = { seq: ++this.seq, ev, delta };
    this.ringHead = (this.ringHead + 1) % LOG_CAP;
    this.typeCounts.set(ev.t, (this.typeCounts.get(ev.t) ?? 0) + 1);
  }

  private onAgent(ev: Extract<ColonyEvent, { t: "agent" }>, now: number): void {
    let a = this.agents.get(ev.agentId);
    this.agentChanges.add(ev.agentId);
    if (ev.state === "dead") {
      if (a) {
        this.agentsByState[a.state]--;
        this.agents.delete(ev.agentId);
      }
      return;
    }
    if (!a) {
      a = { id: ev.agentId, kind: ev.kind, state: ev.state, name: ev.agentId, paths: [], seen: now };
      this.agents.set(a.id, a);
      this.agentsByState[ev.state]++;
    } else if (a.state !== ev.state) {
      this.agentsByState[a.state]--;
      this.agentsByState[ev.state]++;
      a.state = ev.state;
    }
    a.kind = ev.kind;
    a.seen = now;
    if (ev.state === "idle") {
      a.intentId = undefined;
      a.paths = [];
    }
    if (ev.intentId !== undefined && ev.intentId !== a.intentId) {
      a.intentId = ev.intentId;
      a.paths = this.intents.get(ev.intentId)?.footprint ?? [];
    }
    if (ev.paths && ev.paths.length) a.paths = ev.paths;
  }

  /** Set the field value of one kind on one path (set semantics: `value` is the value at `at`). */
  setMark(path: string, kind: MarkKind, value: number, at: number, live: boolean): void {
    const k = KIND_INDEX[kind];
    if (k === undefined || typeof path !== "string") return;
    const now = Date.now();
    let cell = this.field.get(path);
    if (!cell) {
      if (!(value > 0)) return;
      cell = { path, v: new Float64Array(5), at: new Float64Array(5), popAt: 0, trailAt: 0 };
      this.field.set(path, cell);
    }
    const prev = decayed(cell.v[k] ?? 0, cell.at[k] ?? 0, k, now);
    const next = Number.isFinite(value) ? Math.max(0, value) : 0;
    cell.v[k] = next;
    cell.at[k] = Math.min(Number.isFinite(at) && at > 0 ? at : now, now);
    if (live && next > prev + 0.05) {
      cell.popAt = now;
      if (k === TRAIL) cell.trailAt = now;
      if (this.markFx.length < FX_CAP) this.markFx.push({ path, kind });
    }
    if (next > 0) this.active.add(cell);
    this.fieldDirty = true;
    if (!this.known.has(path)) this.unknown.add(path);
  }

  private onIntent(ev: Extract<ColonyEvent, { t: "intent" }>, now: number): void {
    let it = this.intents.get(ev.intentId);
    if (!it) {
      it = { id: ev.intentId, title: ev.title, status: ev.status, footprint: ev.footprint ?? [], priority: 1, createdAt: ev.at, updatedAt: now };
      this.intents.set(it.id, it);
      this.intentsByStatus[ev.status]++;
    } else {
      if (it.status !== ev.status) {
        this.intentsByStatus[it.status]--;
        this.intentsByStatus[ev.status]++;
        it.status = ev.status;
      }
      if (ev.title) it.title = ev.title;
      if (ev.footprint && ev.footprint.length) it.footprint = ev.footprint;
      it.updatedAt = now;
    }
    if (ev.status === "open") it.assignedTo = undefined;
    this.intentsVersion++;
  }

  private onProposal(ev: Extract<ColonyEvent, { t: "proposal" }>, now: number): void {
    let p = this.proposals.get(ev.proposalId);
    const was = p?.status;
    if (!p) {
      p = { id: ev.proposalId, intentId: ev.intentId, agentId: ev.agentId, status: ev.status, reason: ev.reason, updatedAt: now };
      this.proposals.set(p.id, p);
      if (IN_FLIGHT.has(ev.status)) this.inFlight++;
      if (ev.status === "escalated") this.escalated++;
    } else {
      this.setProposalStatus(p, ev.status);
      if (ev.reason) p.reason = ev.reason;
      p.updatedAt = now;
    }
    const intent = this.intents.get(ev.intentId);
    if (intent && ev.agentId) intent.assignedTo = ev.agentId;
    if (ev.status === "escalated" || was === "escalated") this.reviewVersion++;
    if (this.proposals.size > 6000) this.pruneProposals(now);
  }

  private setProposalStatus(p: ProposalView, s: ProposalStatus): void {
    if (p.status === s) return;
    if (IN_FLIGHT.has(p.status)) this.inFlight--;
    if (p.status === "escalated") this.escalated--;
    if (IN_FLIGHT.has(s)) this.inFlight++;
    if (s === "escalated") this.escalated++;
    p.status = s;
  }

  private pruneProposals(now: number): void {
    for (const [id, p] of this.proposals) {
      if (this.proposals.size <= 4500) break;
      if (FINAL.has(p.status) && now - p.updatedAt > 20_000) this.proposals.delete(id);
    }
  }

  private onLanding(ev: Extract<ColonyEvent, { t: "landing" }>, now: number): void {
    const view: LandingView = {
      id: ev.landingId,
      trunkSha: ev.trunkSha,
      proposalIds: ev.proposalIds ?? [],
      paths: ev.paths ?? [],
      at: ev.at,
      receivedAt: now,
    };
    this.landings.push(view);
    if (this.landings.length > 400) this.landings.splice(0, this.landings.length - 300);
    this.landingTimes.push(now);
    this.landingsSeen++;
    this.trunkSha = ev.trunkSha;
    // Landed paths: claims there are spent, and a trail is laid. Explicit mark events that follow win.
    for (const path of view.paths) {
      const cell = this.field.get(path);
      if (cell) cell.v[CLAIM] = 0;
      const cur = cell ? decayed(cell.v[TRAIL] ?? 0, cell.at[TRAIL] ?? 0, TRAIL, now) : 0;
      this.setMark(path, "trail", Math.max(cur, 1), now, false);
      const c = this.field.get(path);
      if (c) {
        c.trailAt = now;
        c.popAt = now;
      }
    }
    for (const pid of view.proposalIds) {
      const p = this.proposals.get(pid);
      if (!p) continue;
      this.setProposalStatus(p, "landed");
      p.updatedAt = now;
      const it = this.intents.get(p.intentId);
      if (it && it.status !== "landed") {
        this.intentsByStatus[it.status]--;
        this.intentsByStatus.landed++;
        it.status = "landed";
        it.updatedAt = now;
        this.intentsVersion++;
      }
    }
    if (this.landingFx.length < 400) this.landingFx.push(view);
  }

  private onViolations(total: number, byRule: Record<Id, number> | undefined, now: number): number {
    const prev = this.violations.total;
    if (total < prev) {
      this.fixedRun += prev - total;
      this.fixes.push([now, prev - total]);
    } else if (prev === 0 && total > 0) {
      this.fixedRun = 0;
    }
    this.violations = { total, byRule: byRule ?? {} };
    return total - prev;
  }

  private setFiles(list: Array<{ path: string; size: number }>): void {
    this.files = list.filter((f) => f && typeof f.path === "string" && f.path.length > 0);
    this.known = new Set(this.files.map((f) => f.path));
    this.unknown.clear();
    this.filesVersion++;
  }

  /** Paths seen in events but missing from the snapshot join the map (debounced, it re-lays out the treemap). */
  private mergeUnknownFiles(now: number): void {
    this.lastFileMerge = now;
    const sizes = this.files.map((f) => f.size).sort((a, b) => a - b);
    const median = sizes[Math.floor(sizes.length / 2)] ?? 2048;
    let added = 0;
    for (const path of this.unknown) {
      if (this.known.has(path) || path.endsWith("/") || added >= 500) continue;
      this.files.push({ path, size: median });
      this.known.add(path);
      added++;
    }
    this.unknown.clear();
    if (added) this.filesVersion++;
  }

  /** Current field values (decayed to `now`) on a path. */
  fieldValues(path: string, now = Date.now()): Record<MarkKind, number> {
    const out: Record<MarkKind, number> = { need: 0, claim: 0, trail: 0, failure: 0, danger: 0 };
    const cell = this.field.get(path);
    if (!cell) return out;
    KINDS.forEach((kind, k) => {
      out[kind] = decayed(cell.v[k] ?? 0, cell.at[k] ?? 0, k, now);
    });
    return out;
  }

  /** Agents that are registered and alive (server metric wins when present). */
  agentsActive(): number {
    return this.metrics.get("agentsactive") ?? this.agents.size;
  }

  /** Agents currently doing work. */
  agentsWorking(): number {
    return this.metrics.get("agentsworking") ?? this.agentsByState.working + this.agentsByState.proposing;
  }

  /** Landings per minute over a sliding window (server metric wins when present). */
  landingsPerMin(now = Date.now()): number {
    const m = this.metrics.get("landingspermin");
    if (m !== undefined) return m;
    const cutoff = now - 60_000;
    let drop = 0;
    while (drop < this.landingTimes.length && (this.landingTimes[drop] ?? 0) < cutoff) drop++;
    if (drop) this.landingTimes.splice(0, drop);
    const window = Math.min(60_000, Math.max(15_000, now - this.startedAt));
    return (this.landingTimes.length * 60_000) / window;
  }

  /** Proposals pending, checking, in a lane, or waiting for a human. */
  proposalsInFlight(): number {
    return this.metrics.get("proposalsinflight") ?? Math.max(0, this.inFlight);
  }

  /** Violations fixed per minute over a sliding window. */
  fixRate(now = Date.now()): number {
    const cutoff = now - 60_000;
    while (this.fixes.length && (this.fixes[0]?.[0] ?? 0) < cutoff) this.fixes.shift();
    let sum = 0;
    for (const [, n] of this.fixes) sum += n;
    const window = Math.min(60_000, Math.max(15_000, now - this.startedAt));
    return (sum * 60_000) / window;
  }

  /** The hottest region's branching ratio (server metric "sigma" wins when present). */
  sigmaMax(now = Date.now()): { value: number; region: string | null } {
    const m = this.metrics.get("sigma");
    if (m !== undefined) return { value: m, region: null };
    let value = 0;
    let region: string | null = null;
    for (const [r, s] of this.sigma) {
      if (now - s.at > 120_000) continue;
      if (s.sigma > value) {
        value = s.sigma;
        region = r;
      }
    }
    return { value, region };
  }

  /** Newest-first events matching `keep`, at most `limit`. */
  recentEvents(keep: (e: ColonyEvent) => boolean, limit: number): LoggedEvent[] {
    const out: LoggedEvent[] = [];
    for (let i = 1; i <= LOG_CAP && out.length < limit; i++) {
      const e = this.ring[(this.ringHead - i + LOG_CAP) % LOG_CAP];
      if (!e) break;
      if (keep(e.ev)) out.push(e);
    }
    return out;
  }

  /** Display name of an agent. */
  agentName(id: Id): string {
    return this.agents.get(id)?.name ?? id;
  }

  /** Select a path for the Why panel (null clears). */
  select(path: string | null): void {
    if (this.selectedPath === path) return;
    this.selectedPath = path;
    this.bump();
  }

  /** Paths to outline on the map (an intent's footprint under the pointer). */
  setHighlight(paths: string[]): void {
    this.highlight = paths;
    this.bump();
  }
}
