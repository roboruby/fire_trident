import type { ColonyEvent, ColonySnapshot, FieldReading, Landing, LineageNote, Proposal } from "@fire_trident/core";
import { isColonyEvent, type ColonyStore } from "./store.ts";

/** One entry of GET /api/colonies/:id/why. */
export interface WhyEntry {
  landing: Landing;
  note: LineageNote;
}

export type ReviewDecision = "approve" | "reject" | "return";

/** A person's answer to an agent's report on an intent: amend the intent, withdraw it, or dismiss the report. */
export type EscalationDecision = "amend" | "withdraw" | "dismiss";

/** The intent fields an answer of "amend" changes (only the ones given). */
export interface IntentAmend {
  title?: string;
  why?: string;
  footprint?: string[];
}

/** Where the UI gets its colony from: the Worker API or the built-in simulator. */
export interface Backend {
  readonly mode: "live" | "mock" | "replay";
  /** Load the snapshot, open the live stream, and keep `store` current until stop(). */
  start(store: ColonyStore): void;
  stop(): void;
  why(path: string): Promise<WhyEntry[]>;
  review(): Promise<Proposal[]>;
  decide(proposalId: string, decision: ReviewDecision, reason: string, by?: string): Promise<void>;
  /** Answer an agent's report that an intent cannot be done as written. */
  resolveEscalation(intentId: string, decision: EscalationDecision, note: string, by?: string, amend?: IntentAmend): Promise<void>;
  /** Freeze the colony's clock (the simulator and replays; a live colony keeps running). */
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
/** Where the token and the reviewer name live when the browser blocks storage (this page only). */
const memory = { token: "", reviewer: "" };

/** Bearer token for mutating routes, if the viewer pasted one (kept in this browser only). */
export function readToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? memory.token;
  } catch {
    return memory.token;
  }
}

/** Remember (or forget, with "") the bearer token. */
export function saveToken(token: string): void {
  memory.token = token;
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage blocked: the token lives for this page only.
  }
}

const REVIEWER_KEY = "ft.reviewer";

/** The name a reviewer gave, recorded with each decision they make (kept in this browser only). */
export function readReviewer(): string {
  try {
    return localStorage.getItem(REVIEWER_KEY) ?? memory.reviewer;
  } catch {
    return memory.reviewer;
  }
}

/** Remember (or forget, with "") the reviewer's name. */
export function saveReviewer(name: string): void {
  memory.reviewer = name;
  try {
    if (name) localStorage.setItem(REVIEWER_KEY, name);
    else localStorage.removeItem(REVIEWER_KEY);
  } catch {
    // Storage blocked: the name lives for this page only.
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

/** How long after the first intent placed without an origin the page re-reads the snapshot to learn it. */
const LEARN_DELAY_MS = 2_000;
/** The page re-reads the snapshot for origins at most this often. */
const LEARN_EVERY_MS = 30_000;

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
  private learnTimer = 0;
  private learnedTo = 0;
  private learnedAt = 0;

  constructor(readonly colonyId: string) {}

  private url(suffix: string): string {
    return `/api/colonies/${encodeURIComponent(this.colonyId)}${suffix}`;
  }

  start(store: ColonyStore): void {
    this.store = store;
    this.stopped = false;
    store.setConn("connecting");
    void this.cycle();
    // The per-minute history (burn-down sparkline) moves on its own clock: refresh it every 30 s. So does
    // stuck work: the report replaces the items the stream added, so ones that cleared go away.
    window.clearInterval(this.seriesTimer);
    this.seriesTimer = window.setInterval(() => {
      if (this.stopped || !this.store?.loaded || document.hidden) return;
      this.getJson<{ series?: unknown; stuck?: unknown }>("/metrics")
        .then((m) => {
          this.store?.applySeries(m?.series);
          this.store?.applyStuck(m?.stuck);
        })
        .catch(() => undefined);
    }, 30_000);
  }

  stop(): void {
    this.stopped = true;
    this.gen++;
    window.clearTimeout(this.timer);
    window.clearInterval(this.seriesTimer);
    window.clearTimeout(this.learnTimer);
    this.learnTimer = 0;
    this.closeSocket();
  }

  /**
   * Intents placed from events carry no origin (rule, source, parent): once some arrive, re-read the
   * snapshot, LEARN_DELAY_MS after the first and at most every LEARN_EVERY_MS, and learn their origins
   * and any rule added since the page loaded. The Intents tab places them by their titles meanwhile.
   */
  private maybeLearn(): void {
    const store = this.store;
    if (!store || this.stopped || this.learnTimer || store.unsourcedBorn <= this.learnedTo) return;
    const wait = Math.max(LEARN_DELAY_MS, this.learnedAt + LEARN_EVERY_MS - Date.now());
    this.learnTimer = window.setTimeout(() => void this.learn(), wait);
  }

  private async learn(): Promise<void> {
    this.learnTimer = 0;
    const store = this.store;
    // A reconnect since this was scheduled re-read the snapshot already.
    if (!store || this.stopped || store.unsourcedBorn <= this.learnedTo) return;
    if (document.hidden) {
      this.learnTimer = window.setTimeout(() => void this.learn(), LEARN_EVERY_MS);
      return;
    }
    const upTo = store.unsourcedBorn;
    this.learnedAt = Date.now();
    try {
      const snap = await this.getJson<ColonySnapshot>("");
      if (this.stopped || this.store !== store || !snap || typeof snap !== "object") return;
      store.learnRules(Array.isArray(snap.rules) ? snap.rules : []);
      store.learnIntents(Array.isArray(snap.intents) ? snap.intents : []);
      this.learnedTo = Math.max(this.learnedTo, upTo);
    } catch {
      // A failed read is tried again LEARN_EVERY_MS after this one.
    }
    this.maybeLearn();
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
      // The snapshot names the origin of every intent it lists; only intents placed from events after it need learning.
      this.learnedTo = store.unsourcedBorn;
      const buffered = this.buffer ?? [];
      this.buffer = null;
      if (buffered.length) store.applyEvents(buffered);
      this.maybeLearn();
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
        this.maybeLearn();
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

  async decide(proposalId: string, decision: ReviewDecision, reason: string, by?: string): Promise<void> {
    await this.post(`/review/${encodeURIComponent(proposalId)}`, { decision, reason, ...(by ? { by } : {}) });
  }

  async resolveEscalation(intentId: string, decision: EscalationDecision, note: string, by?: string, amend?: IntentAmend): Promise<void> {
    await this.post(`/intents/${encodeURIComponent(intentId)}/escalation`, { decision, note, ...(by ? { by } : {}), ...(decision === "amend" && amend ? { amend } : {}) });
  }

  /** POST JSON to a mutating route with the bearer token this browser keeps (if any). */
  private async post(suffix: string, body: unknown): Promise<void> {
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
    const token = readToken();
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(this.url(suffix), { method: "POST", headers, body: JSON.stringify(body) });
    if (!res.ok) throw new HttpError(res.status, await failure(res));
  }
}

/** A failed response as a message: the server's own `error` text when it sent one, else the status line. */
async function failure(res: Response): Promise<string> {
  const status = `${res.status} ${res.statusText}`.trim();
  try {
    const body = (await res.json()) as { error?: unknown } | null;
    if (body && typeof body.error === "string" && body.error.trim()) return `${status}: ${body.error.trim().slice(0, 300)}`;
  } catch {
    // Not JSON: the status line says enough.
  }
  return status;
}

function describeError(err: unknown, colonyId: string): string {
  if (err instanceof HttpError) {
    if (err.status === 404) return `Colony “${colonyId}” was not found (404).`;
    if (err.status >= 500) return `The colony API isn’t responding (${err.status}).`;
    return `The colony API answered ${err.message}.`;
  }
  return `Can't reach the colony API (${err instanceof Error ? err.message : "network error"}).`;
}
