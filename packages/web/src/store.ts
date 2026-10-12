import type {
  AgentKind,
  AgentState,
  Colony,
  ColonyEvent,
  ColonySnapshot,
  DecisionKind,
  DecisionLayer,
  FieldReading,
  FunnelStage,
  Id,
  IntentSource,
  IntentStatus,
  MarkKind,
  ProposalStatus,
  Rule,
} from "@fire_trident/core";
import { finite } from "./format.ts";
import { parseSeries, type Series } from "./series.ts";
import { KIND_INDEX, KINDS, decayed } from "./theme.ts";

/** Connection state shown in the top bar. */
export type ConnState = "connecting" | "live" | "reconnecting" | "error" | "mock" | "replay";

/** What a replay shows in the top bar: when the run started, and whether its events were recorded or rebuilt. */
export interface ReplayInfo {
  /** Time of the run's first event. */
  startedAt: number;
  source: "recorded" | "reconstructed";
}

/** The violations counter since the latest rule change (a rule added or retracted). */
export interface Baseline {
  /** When the change happened (null: before anything this page knows of). */
  since: number | null;
  /** Violations open right after it. */
  initial: number;
  /** When the count reached zero after it, or null while violations remain. */
  convergedAt: number | null;
}

/** Changes of direction this page knows of (from the snapshot and the stream). */
export interface DirectionCounts {
  amended: number;
  withdrawn: number;
  retracted: number;
  directives: number;
}

/** A change an outside agent (kind "external", joined over MCP) landed. */
export interface OutsideLanding {
  agentId: Id;
  landingId: Id;
  paths: string[];
  at: number;
}

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
  /** Map tile index cached by the renderer, valid while `tileGen` matches its layout. */
  tile: number;
  tileGen: number;
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
  /** Epoch ms the UI first saw this agent (fade-in on the map). */
  bornAt: number;
  /** What the agent says it is doing now (its relayed status note), and when. */
  note?: string;
  noteAt?: number;
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
  /** 1 until the intent is amended. */
  revision: number;
  withdrawnReason?: string;
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
  /** From the snapshot (it landed before this page opened), not the stream. */
  history?: boolean;
  /** Applied without animation (a replay seeking past it). */
  quiet?: boolean;
}

export interface LoggedEvent {
  seq: number;
  ev: ColonyEvent;
  /** For `violations` events: change against the previous total. */
  delta?: number;
  /** From the snapshot (it happened before this page opened), not the live stream. */
  history?: boolean;
}

export interface MarkFx {
  path: string;
  kind: MarkKind;
}

/** The funnel's stages, in order: the deterministic proof, then the decision layers. */
export const STAGES: readonly FunnelStage[] = ["proof", "reflex", "llm", "human"];

/** One decision as the UI remembers it (the decision path of a proposal or intent). */
export interface DecisionView {
  kind: DecisionKind;
  layer: DecisionLayer;
  p: number;
  action: string;
  at: number;
}

/** What the vaccination meter can show; every field is optional because metrics arrive piecemeal. */
export interface Vaccination {
  /** Recall on seeded bad changes in [0, 1]. */
  recall: number | null;
  seeded: number | null;
  caught: number | null;
  /** 95% interval on recall in [0, 1]: from metrics when present, else Wilson's interval from caught/seeded. */
  low: number | null;
  high: number | null;
  antibodies: number | null;
  hits: number | null;
}

const EVENT_TYPES: ReadonlySet<string> = new Set([
  "agent",
  "mark",
  "intent",
  "proposal",
  "landing",
  "decision",
  "sigma",
  "violations",
  "metric",
  "amended",
  "withdrawn",
  "retracted",
  "directive",
  "status",
]);
const AGENT_STATES: ReadonlySet<string> = new Set<AgentState>(["idle", "working", "proposing", "waiting", "dead"]);
const INTENT_STATUSES: ReadonlySet<string> = new Set<IntentStatus>(["open", "claimed", "proposed", "landed", "abandoned", "withdrawn"]);
const LAYERS: ReadonlySet<string> = new Set<DecisionLayer>(["reflex", "llm", "human"]);
const IN_FLIGHT: ReadonlySet<ProposalStatus> = new Set<ProposalStatus>(["pending", "checking", "ready", "escalated"]);
const FINAL: ReadonlySet<ProposalStatus> = new Set<ProposalStatus>(["landed", "returned", "rejected"]);
const LOG_CAP = 2000;
const FX_CAP = 3000;
const DECISION_SUBJECTS = 6000;
const CLAIM = KIND_INDEX.claim;
const FUNNEL_METRIC: Readonly<Record<string, FunnelStage>> = { funnelproof: "proof", funnelreflex: "reflex", funnelllm: "llm", funnelhuman: "human" };
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

/** Add `d` to a known key of a counter record, never below zero (unknown keys are ignored). */
function tally<K extends string>(rec: Record<K, number>, key: string, d: number, known: ReadonlySet<string>): void {
  if (!known.has(key)) return;
  const k = key as K;
  rec[k] = Math.max(0, (rec[k] ?? 0) + d);
}

/** Wilson score interval (95%) for `k` successes in `n` trials. */
export function wilson(k: number, n: number): [number, number] {
  if (!(n > 0)) return [0, 1];
  const z = 1.96;
  const p = Math.max(0, Math.min(1, k / n));
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
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
  /**
   * The colony's clock for data (decay, rates, windows): wall time live, the replay's virtual time in
   * a replay. Animation timestamps (pop-ins, glows, flashes) stay on wall time, so effects keep their
   * on-screen length at any replay speed.
   */
  now: () => number = () => Date.now();
  /** When this view of the colony began (the start of the rate windows). */
  startedAt = Date.now();
  /** Set while replaying a finished run (the top bar shows it instead of "Live"). */
  replay: ReplayInfo | null = null;
  /** What the loading overlay says while a replay loads (null: the default text). */
  loadingText: string | null = null;
  /** Paths seen in events but missing from the file list join the map on their own (a replay adds them as they land). */
  autoMergeFiles = true;
  /** While true, applied events update state without queueing animations (a replay seeking). */
  fxMuted = false;
  /** Bumped when the colony is rebuilt from scratch (a replay seeking back): the map drops effects in flight. */
  fxGen = 0;

  readonly field = new Map<string, FieldCell>();
  readonly active = new Set<FieldCell>();
  fieldDirty = true;
  /** Files per kind above the display threshold, written by the map renderer. */
  fieldCounts: number[] = [0, 0, 0, 0, 0];
  /** Agent dots on the map, written by the map renderer. */
  dotCount = 0;

  readonly agents = new Map<Id, AgentView>();
  /** Names of every agent the snapshot listed, including ones that have since stopped (lineage). */
  readonly agentNames = new Map<Id, string>();
  readonly agentsByState: Record<AgentState, number> = { idle: 0, working: 0, proposing: 0, waiting: 0, dead: 0 };
  readonly intents = new Map<Id, IntentView>();
  readonly intentsByStatus: Record<IntentStatus, number> = { open: 0, claimed: 0, proposed: 0, landed: 0, abandoned: 0, withdrawn: 0 };
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
  /** Violations fixed since the total was last zero (or since load), for servers that send no baseline. */
  fixedRun = 0;
  private fixes: Array<[number, number]> = [];
  /** The counter since the latest rule change (null until the server or the stream says where it starts). */
  baseline: Baseline | null = null;
  /** A retraction arrived: the next violations total starts a new baseline instead of counting as fixes. */
  private retractPending = false;

  /** Proposals settled per stage of the reflex arc (or decisions per layer on servers without the proof stage). */
  funnel: Record<FunnelStage, number> = { proof: 0, reflex: 0, llm: 0, human: 0 };
  /** True when the server reports settled proposals per stage (funnel.* totals); else decision events count. */
  settledFunnel = false;
  /** Wall time each stage last moved (the funnel flashes). */
  readonly lastDecisionAt: Record<FunnelStage, number> = { proof: 0, reflex: 0, llm: 0, human: 0 };
  /** Changes of direction: amendments, withdrawals, retracted rules, directives. */
  readonly direction: DirectionCounts = { amended: 0, withdrawn: 0, retracted: 0, directives: 0 };
  /** Every agent's kind, including agents that have stopped (outside agents' landings are told apart by it). */
  readonly agentKinds = new Map<Id, AgentKind>();
  /** Changes outside agents (over MCP) landed, oldest first. */
  outside: OutsideLanding[] = [];
  /** Decisions per subject (proposal, intent, or region id), oldest first. */
  readonly decisions = new Map<Id, DecisionView[]>();
  /** Antibodies minted while this page was open (decision events of kind "antibody"). */
  antibodiesSeen = 0;
  readonly metrics = new Map<string, number>();
  /** Per-minute history from the server (null for the simulator and older servers). */
  series: Series | null = null;
  readonly sigma = new Map<string, { sigma: number; at: number }>();

  private ring: Array<LoggedEvent | undefined> = new Array<LoggedEvent | undefined>(LOG_CAP);
  private ringHead = 0;
  private seq = 0;
  readonly typeCounts = new Map<string, number>();
  /** Events applied since load (for the events-per-second readout). */
  eventsApplied = 0;

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
    const now = this.now();
    this.colony = s.colony;
    this.trunkSha = s.colony.trunkSha ?? "";
    this.greenSha = s.colony.greenSha ?? "";
    this.setFiles(Array.isArray(s.files) ? s.files : []);

    this.intents.clear();
    for (const k of Object.keys(this.intentsByStatus) as IntentStatus[]) this.intentsByStatus[k] = 0;
    for (const i of s.intents ?? []) {
      if (!i || typeof i.id !== "string") continue;
      this.intents.set(i.id, {
        id: i.id,
        title: i.title ?? i.id,
        why: i.why,
        status: i.status,
        footprint: Array.isArray(i.footprint) ? i.footprint : [],
        source: i.source,
        priority: finite(i.priority, 1),
        createdAt: finite(i.createdAt, now),
        updatedAt: finite(i.createdAt, now),
        assignedTo: i.assignedTo,
        ruleId: i.ruleId,
        revision: Math.max(1, finite(i.revision, 1)),
        withdrawnReason: i.withdrawnReason,
      });
      tally(this.intentsByStatus, i.status, 1, INTENT_STATUSES);
    }
    this.intentsVersion++;

    this.rules.clear();
    for (const r of s.rules ?? []) if (r && r.id) this.rules.set(r.id, r);

    for (const id of this.agents.keys()) this.agentChanges.add(id);
    this.agents.clear();
    for (const k of Object.keys(this.agentsByState) as AgentState[]) this.agentsByState[k] = 0;
    for (const a of s.agents ?? []) {
      if (!a || typeof a.id !== "string") continue;
      this.agentNames.set(a.id, a.name || a.id);
      if (a.kind) this.agentKinds.set(a.id, a.kind);
      if (a.state === "dead" || !AGENT_STATES.has(a.state)) continue;
      this.agents.set(a.id, {
        id: a.id,
        kind: a.kind,
        state: a.state,
        name: a.name || a.id,
        model: a.model,
        intentId: a.intentId,
        paths: a.intentId ? (this.intents.get(a.intentId)?.footprint ?? []) : [],
        seen: finite(a.lastSeen, now),
        bornAt: 0,
        note: a.note,
        noteAt: a.noteAt,
      });
      tally(this.agentsByState, a.state, 1, AGENT_STATES);
      this.agentChanges.add(a.id);
    }

    const recent = (s.recentLandings ?? []).filter((l) => l && typeof l.at === "number").sort((a, b) => a.at - b.at);
    this.landings = recent.map((l) => ({ id: l.id, trunkSha: l.trunkSha, proposalIds: l.proposalIds ?? [], paths: l.paths ?? [], at: l.at, receivedAt: l.at, history: true }));
    this.landingTimes = recent.filter((l) => now - l.at < 60_000).map((l) => l.at);
    if (this.seq === 0) {
      // The log opens with the recent landings, so a quiet colony still shows its history.
      for (const l of recent) {
        const ev: ColonyEvent = { t: "landing", at: l.at, landingId: l.id, trunkSha: l.trunkSha, proposalIds: l.proposalIds ?? [], paths: l.paths ?? [] };
        this.ring[this.ringHead] = { seq: ++this.seq, ev, history: true };
        this.ringHead = (this.ringHead + 1) % LOG_CAP;
      }
    }

    this.violations = { total: Math.max(0, finite(s.violations?.total)), byRule: s.violations?.byRule ?? {} };
    this.fixedRun = 0;
    this.fixes = [];
    this.retractPending = false;
    const c = s.convergence;
    this.baseline =
      c && typeof c === "object"
        ? {
            since: typeof c.since === "number" && Number.isFinite(c.since) ? c.since : null,
            initial: Math.max(0, finite(c.initial, this.violations.total)),
            convergedAt: typeof c.convergedAt === "number" && Number.isFinite(c.convergedAt) ? c.convergedAt : null,
          }
        : null;
    const f = s.funnel as (Partial<Record<FunnelStage, number>> & object) | undefined;
    this.settledFunnel = !!f && typeof f.proof === "number";
    this.funnel = { proof: Math.max(0, finite(f?.proof)), reflex: Math.max(0, finite(f?.reflex)), llm: Math.max(0, finite(f?.llm)), human: Math.max(0, finite(f?.human)) };
    this.direction.amended = 0;
    this.direction.withdrawn = 0;
    this.direction.retracted = 0;
    this.direction.directives = 0;
    for (const it of this.intents.values()) {
      this.direction.amended += Math.max(0, it.revision - 1);
      if (it.status === "withdrawn") this.direction.withdrawn++;
    }
    for (const r of this.rules.values()) if (r.retractedAt) this.direction.retracted++;
    this.metrics.clear();
    for (const [k, v] of Object.entries(s.metrics ?? {})) if (typeof v === "number" && Number.isFinite(v)) this.metrics.set(metricKey(k), v);
    this.series = parseSeries((s as { series?: unknown }).series);

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
      if (!r || typeof r.byPath !== "object" || r.byPath === null) continue;
      for (const [path, vals] of Object.entries(r.byPath)) {
        for (const kind of KINDS) {
          const v = vals?.[kind];
          if (typeof v === "number" && v > 0) this.setMark(path, kind, v, r.at, false);
        }
      }
      if (typeof r.sigma === "number" && Number.isFinite(r.sigma)) this.sigma.set(r.region, { sigma: r.sigma, at: this.now() });
    }
    this.bump();
  }

  /** Replace the per-minute history (a periodic /metrics refresh). */
  applySeries(raw: unknown): void {
    const next = parseSeries(raw);
    if (!next) return;
    this.series = next;
    this.bump();
  }

  /** Apply a batch of live events. */
  applyEvents(evs: readonly unknown[]): void {
    const now = this.now();
    let n = 0;
    for (const ev of evs) {
      if (!isColonyEvent(ev)) continue;
      try {
        this.applyOne(ev, now);
      } catch {
        // One malformed event never stops the stream.
        continue;
      }
      n++;
    }
    this.eventsApplied += n;
    const wall = Date.now();
    if (this.autoMergeFiles && this.unknown.size && wall - this.lastFileMerge > 15_000) this.mergeUnknownFiles(wall);
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
        this.onDecision(ev, now);
        break;
      case "sigma":
        if (typeof ev.sigma === "number" && Number.isFinite(ev.sigma)) this.sigma.set(ev.region, { sigma: ev.sigma, at: now });
        break;
      case "violations":
        delta = this.onViolations(ev.total, ev.byRule, now, finite(ev.at, now));
        break;
      case "metric": {
        if (typeof ev.name !== "string" || typeof ev.value !== "number" || !Number.isFinite(ev.value)) break;
        const key = metricKey(ev.name);
        this.metrics.set(key, ev.value);
        // Authoritative funnel totals (funnel.proof, funnel.reflex, ...) set the stages; a proof total means settled counting.
        const stage = FUNNEL_METRIC[key];
        if (stage) {
          if (stage === "proof") this.settledFunnel = true;
          const value = Math.max(0, ev.value);
          if (value > this.funnel[stage] && !this.fxMuted) this.lastDecisionAt[stage] = Date.now();
          this.funnel[stage] = value;
        }
        break;
      }
      case "amended":
      case "withdrawn":
        if (ev.t === "amended") this.direction.amended++;
        else this.direction.withdrawn++;
        this.onDirection(ev, now);
        break;
      case "retracted": {
        const rule = this.rules.get(ev.ruleId);
        if (rule) this.rules.set(ev.ruleId, { ...rule, retractedAt: finite(ev.at, now), retractedBy: ev.by, retractReason: ev.reason });
        this.direction.retracted++;
        // Its violations stop counting: the totals that follow start a new baseline, they are not fixes.
        this.retractPending = true;
        this.intentsVersion++;
        break;
      }
      case "status": {
        const a = typeof ev.agentId === "string" ? this.agents.get(ev.agentId) : undefined;
        if (a && typeof ev.note === "string") {
          a.note = ev.note;
          a.noteAt = finite(ev.at, now);
        }
        break;
      }
      case "directive":
        this.direction.directives++;
        break; // otherwise shown in the log only
    }
    this.ring[this.ringHead] = { seq: ++this.seq, ev, delta };
    this.ringHead = (this.ringHead + 1) % LOG_CAP;
    this.typeCounts.set(ev.t, (this.typeCounts.get(ev.t) ?? 0) + 1);
  }

  private onDecision(ev: Extract<ColonyEvent, { t: "decision" }>, now: number): void {
    if (LAYERS.has(ev.layer)) {
      // Servers that report settled proposals per stage move the funnel with funnel.* totals: a proposal
      // can take several decisions but counts once. Older servers and the simulator count decisions.
      if (!this.settledFunnel) this.funnel[ev.layer] = (this.funnel[ev.layer] ?? 0) + 1;
      if (!this.fxMuted) this.lastDecisionAt[ev.layer] = Date.now();
    }
    if (ev.kind === "antibody") this.antibodiesSeen++;
    if (typeof ev.subject !== "string" || !ev.subject) return;
    let list = this.decisions.get(ev.subject);
    if (!list) {
      list = [];
      this.decisions.set(ev.subject, list);
      if (this.decisions.size > DECISION_SUBJECTS) {
        // Oldest subjects go first (Map keeps insertion order).
        let drop = this.decisions.size - DECISION_SUBJECTS + 500;
        for (const k of this.decisions.keys()) {
          if (drop-- <= 0) break;
          this.decisions.delete(k);
        }
      }
    }
    if (list.length < 24) list.push({ kind: ev.kind, layer: ev.layer, p: finite(ev.p), action: String(ev.action ?? ""), at: finite(ev.at, now) });
    if (ev.layer === "human" || ev.kind === "antibody") this.reviewVersion++;
  }

  private onAgent(ev: Extract<ColonyEvent, { t: "agent" }>, now: number): void {
    if (typeof ev.agentId !== "string") return;
    let a = this.agents.get(ev.agentId);
    this.agentChanges.add(ev.agentId);
    if (ev.kind) this.agentKinds.set(ev.agentId, ev.kind);
    if (ev.state === "dead" || !AGENT_STATES.has(ev.state)) {
      if (a) {
        tally(this.agentsByState, a.state, -1, AGENT_STATES);
        this.agents.delete(ev.agentId);
      }
      return;
    }
    if (!a) {
      a = { id: ev.agentId, kind: ev.kind, state: ev.state, name: this.agentNames.get(ev.agentId) ?? ev.agentId, paths: [], seen: now, bornAt: this.fxMuted ? 0 : Date.now() };
      this.agents.set(a.id, a);
      tally(this.agentsByState, ev.state, 1, AGENT_STATES);
    } else if (a.state !== ev.state) {
      tally(this.agentsByState, a.state, -1, AGENT_STATES);
      tally(this.agentsByState, ev.state, 1, AGENT_STATES);
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
    if (Array.isArray(ev.paths) && ev.paths.length) a.paths = ev.paths;
  }

  /** Set the field value of one kind on one path (set semantics: `value` is the value at `at`). */
  setMark(path: string, kind: MarkKind, value: number, at: number, live: boolean): void {
    const k = KIND_INDEX[kind];
    if (k === undefined || typeof path !== "string" || !path) return;
    const now = this.now();
    let cell = this.field.get(path);
    if (!cell) {
      if (!(value > 0)) return;
      cell = { path, v: new Float64Array(5), at: new Float64Array(5), popAt: 0, trailAt: 0, tile: -1, tileGen: -1 };
      this.field.set(path, cell);
    }
    const prev = decayed(cell.v[k] ?? 0, cell.at[k] ?? 0, k, now);
    const next = typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
    cell.v[k] = next;
    cell.at[k] = Math.min(typeof at === "number" && Number.isFinite(at) && at > 0 ? at : now, now);
    if (live && !this.fxMuted && next > prev + 0.05) {
      const wall = Date.now();
      cell.popAt = wall;
      if (k === TRAIL) cell.trailAt = wall;
      if (this.markFx.length < FX_CAP) this.markFx.push({ path, kind });
    }
    if (next > 0) this.active.add(cell);
    this.fieldDirty = true;
    if (!this.known.has(path)) this.unknown.add(path);
  }

  private onIntent(ev: Extract<ColonyEvent, { t: "intent" }>, now: number): void {
    if (typeof ev.intentId !== "string") return;
    let it = this.intents.get(ev.intentId);
    if (!it) {
      it = { id: ev.intentId, title: ev.title ?? ev.intentId, status: ev.status, footprint: Array.isArray(ev.footprint) ? ev.footprint : [], priority: 1, createdAt: finite(ev.at, now), updatedAt: now, revision: 1 };
      this.intents.set(it.id, it);
      tally(this.intentsByStatus, ev.status, 1, INTENT_STATUSES);
    } else {
      if (it.status !== ev.status) {
        tally(this.intentsByStatus, it.status, -1, INTENT_STATUSES);
        tally(this.intentsByStatus, ev.status, 1, INTENT_STATUSES);
        it.status = ev.status;
      }
      if (ev.title) it.title = ev.title;
      if (Array.isArray(ev.footprint) && ev.footprint.length) it.footprint = ev.footprint;
      it.updatedAt = now;
    }
    if (ev.status === "open") it.assignedTo = undefined;
    this.intentsVersion++;
  }

  /** An intent was amended (new revision, maybe a new title) or withdrawn (with the reason). */
  private onDirection(ev: Extract<ColonyEvent, { t: "amended" | "withdrawn" }>, now: number): void {
    const it = typeof ev.intentId === "string" ? this.intents.get(ev.intentId) : undefined;
    if (!it) return;
    if (ev.t === "amended") {
      if (typeof ev.revision === "number" && ev.revision > it.revision) it.revision = ev.revision;
      if (ev.title) it.title = ev.title;
    } else {
      if (it.status !== "withdrawn") {
        tally(this.intentsByStatus, it.status, -1, INTENT_STATUSES);
        tally(this.intentsByStatus, "withdrawn", 1, INTENT_STATUSES);
        it.status = "withdrawn";
      }
      it.withdrawnReason = ev.reason;
      it.assignedTo = undefined;
    }
    it.updatedAt = now;
    this.intentsVersion++;
  }

  private onProposal(ev: Extract<ColonyEvent, { t: "proposal" }>, now: number): void {
    if (typeof ev.proposalId !== "string") return;
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
    if (IN_FLIGHT.has(p.status)) this.inFlight = Math.max(0, this.inFlight - 1);
    if (p.status === "escalated") this.escalated = Math.max(0, this.escalated - 1);
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
      trunkSha: ev.trunkSha ?? "",
      proposalIds: Array.isArray(ev.proposalIds) ? ev.proposalIds : [],
      paths: Array.isArray(ev.paths) ? ev.paths : [],
      at: finite(ev.at, now),
      receivedAt: now,
      ...(this.fxMuted ? { quiet: true } : {}),
    };
    this.landings.push(view);
    if (this.landings.length > 400) this.landings.splice(0, this.landings.length - 300);
    this.landingTimes.push(now);
    this.landingsSeen++;
    if (view.trunkSha) this.trunkSha = view.trunkSha;
    const wall = Date.now();
    // Landed paths: claims there are spent, and a trail is laid. Explicit mark events that follow win.
    for (const path of view.paths) {
      const cell = this.field.get(path);
      if (cell) cell.v[CLAIM] = 0;
      const cur = cell ? decayed(cell.v[TRAIL] ?? 0, cell.at[TRAIL] ?? 0, TRAIL, now) : 0;
      this.setMark(path, "trail", Math.max(cur, 1), now, false);
      const c = this.field.get(path);
      if (c && !this.fxMuted) {
        c.trailAt = wall;
        c.popAt = wall;
      }
    }
    let outside: Id | null = null;
    for (const pid of view.proposalIds) {
      const p = this.proposals.get(pid);
      if (!p) continue;
      if (this.agentKinds.get(p.agentId) === "external") outside = p.agentId;
      this.setProposalStatus(p, "landed");
      p.updatedAt = now;
      const it = this.intents.get(p.intentId);
      if (it && it.status !== "landed") {
        tally(this.intentsByStatus, it.status, -1, INTENT_STATUSES);
        this.intentsByStatus.landed++;
        it.status = "landed";
        it.updatedAt = now;
        this.intentsVersion++;
      }
    }
    if (outside !== null) {
      this.outside.push({ agentId: outside, landingId: view.id, paths: view.paths, at: view.at });
      if (this.outside.length > 200) this.outside.splice(0, this.outside.length - 100);
    }
    if (!this.fxMuted && this.landingFx.length < 400) this.landingFx.push(view);
  }

  private onViolations(total: number, byRule: Record<Id, number> | undefined, now: number, at: number): number {
    const next = Math.max(0, finite(total, this.violations.total));
    const prev = this.violations.total;
    if (this.retractPending || next > prev) {
      // A rule change (a retraction, or a new rule's violations): the counter starts again from here.
      this.retractPending = false;
      this.baseline = { since: at, initial: next, convergedAt: null };
      if (prev === 0 && next > 0) this.fixedRun = 0;
    } else if (next < prev) {
      this.fixedRun += prev - next;
      this.fixes.push([now, prev - next]);
      if (this.baseline && next === 0 && this.baseline.initial > 0) this.baseline.convergedAt = at;
    }
    this.violations = { total: next, byRule: byRule && typeof byRule === "object" ? byRule : {} };
    return next - prev;
  }

  private setFiles(list: Array<{ path: string; size: number }>): void {
    this.files = list.filter((f) => f && typeof f.path === "string" && f.path.length > 0).map((f) => ({ path: f.path, size: Math.max(0, finite(f.size)) }));
    this.known = new Set(this.files.map((f) => f.path));
    this.unknown.clear();
    this.filesVersion++;
  }

  /** Add files to the map (a replay adds a new project's files as they land); known paths are skipped. */
  addFiles(list: ReadonlyArray<{ path: string; size: number }>): void {
    let added = 0;
    for (const f of list) {
      if (!f || typeof f.path !== "string" || !f.path || this.known.has(f.path)) continue;
      this.files.push({ path: f.path, size: Math.max(1, finite(f.size, 1)) });
      this.known.add(f.path);
      this.unknown.delete(f.path);
      added++;
    }
    if (added) {
      this.filesVersion++;
      this.fieldDirty = true;
    }
  }

  /**
   * Forget everything that happened (a replay seeking back rebuilds the colony from its start): the
   * field, agents, intents, proposals, landings, decisions, the event log and every counter. The colony
   * record, rules and file list come back with the next applySnapshot.
   */
  reset(): void {
    for (const id of this.agents.keys()) this.agentChanges.add(id);
    this.field.clear();
    this.active.clear();
    this.fieldDirty = true;
    this.agents.clear();
    for (const k of Object.keys(this.agentsByState) as AgentState[]) this.agentsByState[k] = 0;
    this.intents.clear();
    for (const k of Object.keys(this.intentsByStatus) as IntentStatus[]) this.intentsByStatus[k] = 0;
    this.intentsVersion++;
    this.proposals.clear();
    this.inFlight = 0;
    this.escalated = 0;
    this.reviewVersion++;
    this.landings = [];
    this.landingTimes = [];
    this.landingsSeen = 0;
    this.decisions.clear();
    this.antibodiesSeen = 0;
    this.metrics.clear();
    this.sigma.clear();
    this.ring = new Array<LoggedEvent | undefined>(LOG_CAP);
    this.ringHead = 0;
    this.seq = 0;
    this.typeCounts.clear();
    this.landingFx = [];
    this.markFx = [];
    this.outside = [];
    for (const k of STAGES) this.lastDecisionAt[k] = 0;
    this.fxGen++;
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
  fieldValues(path: string, now = this.now()): Record<MarkKind, number> {
    const out: Record<MarkKind, number> = { need: 0, claim: 0, trail: 0, failure: 0, danger: 0 };
    const cell = this.field.get(path);
    if (!cell) return out;
    KINDS.forEach((kind, k) => {
      out[kind] = decayed(cell.v[k] ?? 0, cell.at[k] ?? 0, k, now);
    });
    return out;
  }

  /** A metric by any of its spellings (agentsActive, agents.active, agents_active), if present. */
  metric(...names: string[]): number | undefined {
    for (const n of names) {
      const v = this.metrics.get(metricKey(n));
      if (v !== undefined) return v;
    }
    return undefined;
  }

  /** Agents that are registered and alive (server metric wins when present). */
  agentsActive(): number {
    return Math.max(0, this.metric("agentsActive") ?? this.agents.size);
  }

  /** Agents currently doing work. */
  agentsWorking(): number {
    return Math.max(0, this.metric("agentsWorking") ?? this.agentsByState.working + this.agentsByState.proposing);
  }

  /** Landings per minute over a sliding window (server metric wins when present). */
  landingsPerMin(now = this.now()): number {
    const m = this.metric("landingsPerMin");
    if (m !== undefined) return Math.max(0, m);
    const cutoff = now - 60_000;
    let drop = 0;
    while (drop < this.landingTimes.length && (this.landingTimes[drop] ?? 0) < cutoff) drop++;
    if (drop) this.landingTimes.splice(0, drop);
    const window = Math.min(60_000, Math.max(15_000, now - this.startedAt));
    return (this.landingTimes.length * 60_000) / window;
  }

  /** Every landing the colony has made (server metric), else the ones this page has seen. */
  landingsTotal(): number {
    return Math.max(0, this.metric("landings") ?? this.landingsSeen + this.landings.filter((l) => l.history).length);
  }

  /** Proposals pending, checking, in a lane, or waiting for a human. */
  proposalsInFlight(): number {
    return Math.max(0, this.metric("proposalsInFlight") ?? this.inFlight);
  }

  /** Proposals waiting for a human (server metric wins when present). */
  reviewQueue(): number {
    return Math.max(0, this.metric("reviewQueue") ?? this.escalated);
  }

  /**
   * Violations fixed since the latest rule change: what was open right after it minus what is open
   * now. Without a baseline (the simulator, older servers), the larger of what this page has watched
   * fall and the fall from the peak of the server's per-minute window.
   */
  violationsFixed(): number {
    if (this.baseline) return Math.max(0, this.baseline.initial - this.violations.total);
    const m = this.metric("violationsFixed", "fixed", "violationsFixedTotal");
    if (m !== undefined) return Math.max(0, m);
    const peak = this.series ? Math.max(0, ...this.series.violations) : 0;
    return Math.max(this.fixedRun, peak - this.violations.total, 0);
  }

  /** The convergence stat once every violation since the latest rule change is fixed: how many, and how long it took. */
  convergedIn(): { fixed: number; ms: number } | null {
    const b = this.baseline;
    if (!b || this.violations.total !== 0 || b.initial <= 0 || b.since === null || b.convergedAt === null) return null;
    return { fixed: b.initial, ms: Math.max(0, b.convergedAt - b.since) };
  }

  /** Intents the colony has landed (server metric wins when present). */
  intentsLanded(): number {
    return Math.max(0, this.metric("landedIntents", "intentsLanded") ?? this.intentsByStatus.landed);
  }

  /** Violations fixed per minute over a sliding window. */
  fixRate(now = this.now()): number {
    const cutoff = now - 60_000;
    while (this.fixes.length && (this.fixes[0]?.[0] ?? 0) < cutoff) this.fixes.shift();
    let sum = 0;
    for (const [, n] of this.fixes) sum += n;
    const window = Math.min(60_000, Math.max(15_000, now - this.startedAt));
    return Math.max(0, (sum * 60_000) / window);
  }

  /** The hottest region's branching ratio (server metric "sigma" wins when present). */
  sigmaMax(now = this.now()): { value: number; region: string | null } {
    const m = this.metric("sigma", "sigmaMax");
    if (m !== undefined) return { value: Math.max(0, m), region: null };
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

  /**
   * The vaccination meter's numbers, read generically from metrics whose names mention
   * vaccines or antibodies (vaccine.recall, vaccineSeeded, antibodies.hits, ...).
   * Null when the colony reports none of them.
   */
  vaccination(): Vaccination | null {
    const unit = (v: number): number => Math.max(0, Math.min(1, v > 1 ? v / 100 : v));
    // Overall numbers beat per-class ones (vaccine.all.recall over vaccine.secret-log.recall): the
    // shortest matching name is the most general one.
    const pick = (re: RegExp): number | null => {
      let best: string | null = null;
      for (const k of this.metrics.keys()) {
        if (!k.startsWith("vaccin") || k === "vaccines" || !re.test(k.slice(7))) continue;
        if (best === null || k.length < best.length) best = k;
      }
      return best === null ? null : (this.metrics.get(best) ?? null);
    };
    const seededRaw = pick(/(^|[a-z])(n|seeded|injected|total|count)$/);
    const caughtRaw = pick(/(caught|detected|blocked)$/);
    const recallRaw = pick(/(recall|rate)$/);
    const lowRaw = pick(/(lo|low|lower)$/);
    const highRaw = pick(/(hi|high|upper)$/);
    const seeded = seededRaw === null ? null : Math.max(0, seededRaw);
    const caught = caughtRaw === null ? null : Math.max(0, caughtRaw);
    // Nothing settled yet (n = 0): no recall to report, whatever the interval says.
    const settled = seeded === null || seeded > 0;
    let recall = settled && recallRaw !== null ? unit(recallRaw) : null;
    let low = settled && lowRaw !== null ? unit(lowRaw) : null;
    let high = settled && highRaw !== null ? unit(highRaw) : null;
    if (recall === null && seeded !== null && caught !== null && seeded > 0) recall = Math.min(1, caught / seeded);
    if ((low === null || high === null) && seeded !== null && caught !== null && seeded > 0) {
      const [lo, hi] = wilson(Math.min(caught, seeded), seeded);
      low ??= lo;
      high ??= hi;
    }
    const ab = this.metric("antibodies.active", "antibodiesActive") ?? this.metric("antibodies");
    const antibodies = ab === undefined ? null : Math.max(0, ab);
    const hitsRaw = this.metric("antibodies.hits", "antibodyHits", "antibodies.caught");
    const hits = hitsRaw === undefined ? null : Math.max(0, hitsRaw);
    // Show the meter once there is something to show: vaccine results, or antibodies that exist or have fired.
    if (recall === null && !(seeded && seeded > 0) && !(antibodies && antibodies > 0) && !(hits && hits > 0)) return null;
    return { recall, seeded, caught, low, high, antibodies, hits };
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
    return this.agents.get(id)?.name ?? this.agentNames.get(id) ?? id;
  }

  /** The most recent landing that touched `path` (newest first), if this page knows one. */
  lastLandingOn(path: string): LandingView | undefined {
    for (let i = this.landings.length - 1, n = 0; i >= 0 && n < 120; i--, n++) {
      const l = this.landings[i];
      if (l && l.paths.includes(path)) return l;
    }
    return undefined;
  }

  /** Select a path for the Why panel (null clears). */
  select(path: string | null): void {
    if (this.selectedPath === path) return;
    this.selectedPath = path;
    this.bump();
  }

  /** Paths to outline on the map (an intent's footprint under the pointer). */
  setHighlight(paths: string[]): void {
    if (paths.length === 0 && this.highlight.length === 0) return;
    this.highlight = paths;
    this.bump();
  }
}
