import type { ColonyEvent } from "@fire_trident/core";

/** Minimum gap between two broadcasts (ms). Events in between are batched. */
export const FLUSH_INTERVAL_MS = 100;
/** Soft cap on one WebSocket message (characters); the platform limit is 1 MiB. */
export const MAX_MESSAGE_CHARS = 256_000;
/** Buffer size that triggers an early coalescing pass. */
const COALESCE_AT = 10_000;
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
 */
export class EventHub {
  private buffer: ColonyEvent[] = [];
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
    for (const e of list) this.buffer.push(e);
    if (this.buffer.length > COALESCE_AT) {
      this.buffer = coalesceEvents(this.buffer);
      if (this.buffer.length > MAX_BUFFER) this.buffer = this.buffer.slice(-MAX_BUFFER);
    }
    if (!this.scheduled) {
      this.scheduled = true;
      this.schedule(() => this.flush(), Math.max(0, this.intervalMs - (this.now() - this.lastFlush)));
    }
    return this.knownListeners;
  }

  /** Broadcast everything buffered now (called by the timer). */
  flush(): void {
    this.scheduled = false;
    this.lastFlush = this.now();
    const events = coalesceEvents(this.buffer);
    this.buffer = [];
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
