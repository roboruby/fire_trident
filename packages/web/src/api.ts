import type { ColonyEvent, ColonySnapshot, FieldReading, Landing, LineageNote, Proposal } from "@fire_trident/core";
import { isColonyEvent, type ColonyStore } from "./store.ts";

/** One entry of GET /api/colonies/:id/why. */
export interface WhyEntry {
  landing: Landing;
  note: LineageNote;
}

export type ReviewDecision = "approve" | "reject" | "return";

/** Where the UI gets its colony from: the Worker API or the built-in simulator. */
export interface Backend {
  readonly mode: "live" | "mock";
  /** Load the snapshot, open the live stream, and keep `store` current until stop(). */
  start(store: ColonyStore): void;
  stop(): void;
  why(path: string): Promise<WhyEntry[]>;
  review(): Promise<Proposal[]>;
  decide(proposalId: string, decision: ReviewDecision, reason: string): Promise<void>;
  /** Freeze the colony's clock (the simulator only; a live colony keeps running). */
  setPaused?(paused: boolean): void;
}

/** An HTTP failure with its status code. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const TOKEN_KEY = "ft.token";

/** Bearer token for mutating routes, if the viewer pasted one (kept in this browser only). */
export function readToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

/** Remember (or forget, with "") the bearer token. */
export function saveToken(token: string): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage blocked: the token lives for this page only.
  }
}

/** Parse one WebSocket message: a single event, an array of events, or { events: [...] }. */
export function parseEvents(data: unknown): ColonyEvent[] {
  if (typeof data !== "string") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return [];
  }
  if (Array.isArray(parsed)) return parsed.filter(isColonyEvent);
  if (isColonyEvent(parsed)) return [parsed];
  const nested = (parsed as { events?: unknown } | null)?.events;
  return Array.isArray(nested) ? nested.filter(isColonyEvent) : [];
}

/**
 * The Worker API: GET snapshot, then a WebSocket of ColonyEvent with reconnect
 * and exponential backoff. Every (re)connect re-reads the snapshot and replays
 * events that arrived while it loaded, so a dropped socket never leaves gaps.
 */
export class HttpBackend implements Backend {
  readonly mode = "live" as const;
  private store: ColonyStore | null = null;
  private ws: WebSocket | null = null;
  private gen = 0;
  private attempt = 0;
  private openedAt = 0;
  private timer = 0;
  private buffer: ColonyEvent[] | null = null;
  private stopped = false;
  private keepalive = 0;
  private lastMessageAt = 0;
  private seriesTimer = 0;

  constructor(readonly colonyId: string) {}

  private url(suffix: string): string {
    return `/api/colonies/${encodeURIComponent(this.colonyId)}${suffix}`;
  }

  start(store: ColonyStore): void {
    this.store = store;
    this.stopped = false;
    store.setConn("connecting");
    void this.cycle();
    // The per-minute history (burn-down sparkline) moves on its own clock: refresh it every 30 s.
    window.clearInterval(this.seriesTimer);
    this.seriesTimer = window.setInterval(() => {
      if (this.stopped || !this.store?.loaded || document.hidden) return;
      this.getJson<{ series?: unknown }>("/metrics")
        .then((m) => this.store?.applySeries(m?.series))
        .catch(() => undefined);
    }, 30_000);
  }

  stop(): void {
    this.stopped = true;
    this.gen++;
    window.clearTimeout(this.timer);
    window.clearInterval(this.seriesTimer);
    this.closeSocket();
  }

  private async cycle(): Promise<void> {
    const store = this.store;
    if (this.stopped || !store) return;
    const gen = ++this.gen;
    this.buffer = [];
    this.openSocket(gen);
    try {
      const snap = await this.getJson<ColonySnapshot>("");
      if (gen !== this.gen) return;
      if (!snap || typeof snap !== "object" || !snap.colony) throw new Error("malformed snapshot");
      store.applySnapshot(snap);
      const buffered = this.buffer ?? [];
      this.buffer = null;
      if (buffered.length) store.applyEvents(buffered);
      store.setConn(this.ws?.readyState === WebSocket.OPEN ? "live" : "connecting", null);
      this.getJson<FieldReading[]>("/field")
        .then((readings) => {
          if (gen === this.gen && Array.isArray(readings)) store.applyField(readings, true);
        })
        .catch(() => undefined);
    } catch (err) {
      if (gen !== this.gen) return;
      this.buffer = null;
      this.closeSocket();
      // After a good load, an outage is a reconnect, not a dead end: keep the map and say so.
      store.setConn(store.loaded ? "reconnecting" : "error", describeError(err, this.colonyId));
      this.retryLater();
    }
  }

  private openSocket(gen: number): void {
    this.closeSocket();
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${proto}//${location.host}${this.url("/live")}`);
    } catch {
      return;
    }
    this.ws = ws;
    this.lastMessageAt = Date.now();
    // Keepalive: the API answers "ping" with "pong". Silence for 70s means the socket is dead.
    this.keepalive = window.setInterval(() => {
      if (gen !== this.gen || this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastMessageAt > 70_000) {
        this.closeSocket();
        this.lostSocket();
        return;
      }
      try {
        ws.send("ping");
      } catch {
        // closing
      }
    }, 25_000);
    ws.onopen = () => {
      if (gen !== this.gen) return;
      this.openedAt = Date.now();
      if (this.buffer === null) this.store?.setConn("live", null);
    };
    ws.onmessage = (msg: MessageEvent) => {
      if (gen !== this.gen) return;
      this.lastMessageAt = Date.now();
      const evs = parseEvents(msg.data);
      if (!evs.length) return;
      if (this.buffer) {
        if (this.buffer.length < 50_000) this.buffer.push(...evs);
      } else {
        this.store?.applyEvents(evs);
      }
    };
    ws.onclose = () => {
      if (gen !== this.gen || this.stopped) return;
      this.ws = null;
      this.lostSocket();
    };
  }

  /** The live socket is gone: say so and schedule a reconnect (which also re-reads the snapshot). */
  private lostSocket(): void {
    window.clearInterval(this.keepalive);
    if (this.openedAt && Date.now() - this.openedAt > 10_000) this.attempt = 0;
    this.openedAt = 0;
    if (this.store?.loaded) this.store.setConn("reconnecting");
    this.retryLater();
  }

  private closeSocket(): void {
    window.clearInterval(this.keepalive);
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    try {
      ws.close();
    } catch {
      // already closed
    }
  }

  private retryLater(): void {
    window.clearTimeout(this.timer);
    const base = Math.min(15_000, 500 * 2 ** this.attempt);
    this.attempt = Math.min(this.attempt + 1, 8);
    const delay = Math.round(base * (0.75 + Math.random() * 0.5));
    if (this.store) this.store.retryAt = Date.now() + delay;
    this.timer = window.setTimeout(() => void this.cycle(), delay);
  }

  private async getJson<T>(suffix: string): Promise<T> {
    const res = await fetch(this.url(suffix), { headers: { accept: "application/json" } });
    if (!res.ok) throw new HttpError(res.status, `${res.status} ${res.statusText}`.trim());
    return (await res.json()) as T;
  }

  async why(path: string): Promise<WhyEntry[]> {
    const data = await this.getJson<unknown>(`/why?path=${encodeURIComponent(path)}`);
    return Array.isArray(data) ? (data as WhyEntry[]).filter((e) => e && e.landing && e.note) : [];
  }

  async review(): Promise<Proposal[]> {
    const data = await this.getJson<unknown>("/review");
    return Array.isArray(data) ? (data as Proposal[]) : [];
  }

  async decide(proposalId: string, decision: ReviewDecision, reason: string): Promise<void> {
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
    const token = readToken();
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(this.url(`/review/${encodeURIComponent(proposalId)}`), {
      method: "POST",
      headers,
      body: JSON.stringify({ decision, reason }),
    });
    if (!res.ok) throw new HttpError(res.status, `${res.status} ${res.statusText}`.trim());
  }
}

function describeError(err: unknown, colonyId: string): string {
  if (err instanceof HttpError) {
    if (err.status === 404) return `Colony “${colonyId}” was not found (404).`;
    if (err.status >= 500) return `The colony API isn’t responding (${err.status}).`;
    return `The colony API answered ${err.message}.`;
  }
  return `Can't reach the colony API (${err instanceof Error ? err.message : "network error"}).`;
}
