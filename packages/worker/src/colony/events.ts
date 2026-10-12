import type { ColonyEvent } from "@fire_trident/core";

/** Minimum gap between two broadcasts (ms). Events in between are batched. */
export const FLUSH_INTERVAL_MS = 100;
/** Soft cap on one WebSocket message (characters); the platform limit is 1 MiB. */
export const MAX_MESSAGE_CHARS = 256_000;
/** Superseded slots tolerated in the buffer before it is compacted. */
const COMPACT_AT = 10_000;
/** Hard cap on buffered events between two flushes (oldest dropped beyond it). */
const MAX_BUFFER = 50_000;

/**
 * Key under which a newer event supersedes an older one inside one flush window.
 * State-like events (marks, sigma, totals, metrics, agent/intent/proposal status)
 * only need their latest value; landings and decisions are facts and are all kept.
 */
export function eventKey(e: ColonyEvent): string | null {
  switch (e.t) {
    case "mark":
      return `m|${e.region}|${e.kind}|${e.path}`;
    case "sigma":
      return `s|${e.region}`;
    case "violations":
      return "v";
    case "metric":
      return `x|${e.name}`;
    case "agent":
      return `a|${e.agentId}`;
    case "intent":
      return `i|${e.intentId}`;
    case "proposal":
      return `p|${e.proposalId}`;
    case "status":
      return `n|${e.agentId}`;
    default:
      return null;
  }
}

/** Drop superseded state events, keeping each survivor at its latest position. */
export function coalesceEvents(events: ColonyEvent[]): ColonyEvent[] {
  const last = new Map<string, number>();
  events.forEach((e, i) => {
    const k = eventKey(e);
    if (k !== null) last.set(k, i);
  });
  if (last.size === 0) return events;
  return events.filter((e, i) => {
    const k = eventKey(e);
    return k === null || last.get(k) === i;
  });
}

/** Serialize events into JSON-array messages, each at most about `maxChars` long. */
export function chunkEvents(events: ColonyEvent[], maxChars = MAX_MESSAGE_CHARS): string[] {
  const out: string[] = [];
  let parts: string[] = [];
  let size = 2;
  for (const e of events) {
    const s = JSON.stringify(e);
    if (parts.length > 0 && size + s.length + 1 > maxChars) {
      out.push(`[${parts.join(",")}]`);
      parts = [];
      size = 2;
    }
    parts.push(s);
    size += s.length + 1;
  }
  if (parts.length > 0) out.push(`[${parts.join(",")}]`);
  return out;
}

/** Anything that can receive a text frame (a hibernatable WebSocket in production). */
export interface EventSink {
  send(message: string): void;
}

/**
 * Buffers ColonyEvents and broadcasts them as JSON arrays at most every
 * FLUSH_INTERVAL_MS, coalescing superseded state events. With no sockets
 * connected, events are dropped without buffering.
 *
 * Coalescing is incremental: a state event replaces the earlier one with the same key as it
 * arrives (its slot becomes a hole), so a push costs O(events pushed) however large the buffer
 * grows between two flushes. Re-coalescing the whole buffer on every push once it passed a size
 * made each push O(buffer) under load, which is when the colony can least afford it.
 */
export class EventHub {
  /** Buffered events in arrival order; superseded state events leave null holes. */
  private buffer: Array<ColonyEvent | null> = [];
  /** Slot in `buffer` of the latest state event per key (see eventKey). */
  private latest = new Map<string, number>();
  /** Events in `buffer` that are not holes. */
  private live = 0;
  private scheduled = false;
  private lastFlush = 0;
  private knownListeners = 0;

  constructor(
    private readonly sockets: () => EventSink[],
    private readonly intervalMs = FLUSH_INTERVAL_MS,
    private readonly now: () => number = Date.now,
    private readonly schedule: (fn: () => void, ms: number) => unknown = (fn, ms) => setTimeout(fn, ms),
  ) {}

  /** Number of connected listeners. */
  listeners(): number {
    return this.sockets().length;
  }

  /** Queue one or more events; returns the number of connected listeners. */
  push(events: ColonyEvent | ColonyEvent[]): number {
    const list = Array.isArray(events) ? events : [events];
    if (!this.scheduled) {
      this.knownListeners = this.listeners();
      if (this.knownListeners === 0 || list.length === 0) return this.knownListeners;
    }
    for (const e of list) {
      const k = eventKey(e);
      if (k !== null) {
        const at = this.latest.get(k);
        if (at !== undefined && this.buffer[at] !== null) {
          this.buffer[at] = null;
          this.live--;
        }
        this.latest.set(k, this.buffer.length);
      }
      this.buffer.push(e);
      this.live++;
    }
    if (this.buffer.length - this.live > COMPACT_AT) this.compact(0);
    // Over the cap, drop the oldest down to 90% of it, so the cost of dropping stays O(1) per event.
    if (this.live > MAX_BUFFER) this.compact(this.live - Math.floor(MAX_BUFFER * 0.9));
    if (!this.scheduled) {
      this.scheduled = true;
      this.schedule(() => this.flush(), Math.max(0, this.intervalMs - (this.now() - this.lastFlush)));
    }
    return this.knownListeners;
  }

  /** Remove holes (and the `drop` oldest events) and re-index the latest slots. */
  private compact(drop: number): void {
    const kept = this.buffer.filter((e): e is ColonyEvent => e !== null).slice(Math.max(0, drop));
    this.buffer = kept;
    this.live = kept.length;
    this.latest.clear();
    kept.forEach((e, i) => {
      const k = eventKey(e);
      if (k !== null) this.latest.set(k, i);
    });
  }

  /** Broadcast everything buffered now (called by the timer). */
  flush(): void {
    this.scheduled = false;
    this.lastFlush = this.now();
    const events = this.buffer.filter((e): e is ColonyEvent => e !== null);
    this.buffer = [];
    this.latest.clear();
    this.live = 0;
    if (events.length === 0) return;
    const sockets = this.sockets();
    if (sockets.length === 0) return;
    for (const message of chunkEvents(events)) {
      for (const ws of sockets) {
        try {
          ws.send(message);
        } catch {
          // A closing socket; the close handler cleans it up.
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The persisted record (replay)
// ---------------------------------------------------------------------------

/** Events a colony's record keeps at most; the oldest are pruned first. */
export const RECORD_KEEP = 100_000;
/** Buffered record events are written this often. */
export const RECORD_FLUSH_MS = 500;
/** A region's sigma is recorded when it moved at least this much since its last record, or crossed 1. */
export const SIGMA_STEP = 0.05;
/** Events buffered between two writes at most (oldest dropped beyond it). */
const RECORD_BUFFER_MAX = 50_000;
/** Metrics never recorded: per-cycle trunk statistics, lane tuning and load-test probes (high rate, not shown in the UI). */
const UNRECORDED_METRIC = /^(trunk\.|inhibition:|laneDelayMs:|colony\.)/;

/** True for events worth keeping in the record: everything but field marks and internal metrics. */
export function recordable(e: ColonyEvent): boolean {
  if (e.t === "mark") return false;
  if (e.t === "metric") return typeof e.name === "string" && !UNRECORDED_METRIC.test(e.name);
  return true;
}

/** Keep the last value of each metric name in a batch (at its last position); every other event stays. */
export function coalesceMetrics(events: ColonyEvent[]): ColonyEvent[] {
  const last = new Map<string, number>();
  events.forEach((e, i) => {
    if (e.t === "metric") last.set(e.name, i);
  });
  if (last.size === 0) return events;
  return events.filter((e, i) => e.t !== "metric" || last.get(e.name) === i);
}

/**
 * Records what a colony publishes, at the source and independent of live delivery: events are
 * buffered and written in one batch at most every RECORD_FLUSH_MS. Marks are skipped (a replay
 * derives the field from intents, claims and landings), metric values coalesce per name within a
 * batch, and a region's sigma is kept only when it moved by SIGMA_STEP or crossed 1.
 */
export class EventRecorder {
  private buffer: ColonyEvent[] = [];
  private readonly sigma = new Map<string, number>();
  private scheduled = false;

  constructor(
    private readonly write: (events: ColonyEvent[]) => void,
    private readonly intervalMs = RECORD_FLUSH_MS,
    private readonly schedule: (fn: () => void, ms: number) => unknown = (fn, ms) => setTimeout(fn, ms),
    private readonly afterFlush: (written: number) => void = () => undefined,
  ) {}

  /** Events waiting for the next write. */
  get pending(): number {
    return this.buffer.length;
  }

  /** Queue events for the record (the ones worth keeping). */
  add(events: ColonyEvent | ColonyEvent[]): void {
    const list = Array.isArray(events) ? events : [events];
    let added = 0;
    for (const e of list) {
      if (!recordable(e)) continue;
      if (e.t === "sigma") {
        if (typeof e.sigma !== "number" || !Number.isFinite(e.sigma)) continue;
        const prev = this.sigma.get(e.region);
        if (prev !== undefined && Math.abs(e.sigma - prev) < SIGMA_STEP && (prev > 1) === (e.sigma > 1)) continue;
        this.sigma.set(e.region, e.sigma);
      }
      this.buffer.push(e);
      added++;
    }
    if (added === 0) return;
    if (this.buffer.length > RECORD_BUFFER_MAX) this.buffer = this.buffer.slice(-Math.floor(RECORD_BUFFER_MAX * 0.9));
    if (!this.scheduled) {
      this.scheduled = true;
      this.schedule(() => this.flush(), this.intervalMs);
    }
  }

  /** Write everything buffered now (the timer calls it; reads call it so the record is current). */
  flush(): void {
    this.scheduled = false;
    const events = coalesceMetrics(this.buffer);
    this.buffer = [];
    if (events.length === 0) return;
    try {
      this.write(events);
    } catch (err) {
      console.error(`event record write failed (${events.length} events): ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    this.afterFlush(events.length);
  }

  /** Drop everything buffered and forget recorded sigma values (the colony was erased). */
  clear(): void {
    this.buffer = [];
    this.sigma.clear();
  }
}
