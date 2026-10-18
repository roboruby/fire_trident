import type { EventsPage, RecordedEvent } from "@fire_trident/core";

/**
 * Recorded runs, played with no network (/c/:id?replay=1&recording=<name>). A recording is one JSON file, gzip allowed,
 * that scripts/record_colony.ts writes from a deployment's public reads: the colony's event record, read page by page
 * and kept whole, and the answer to every other read the replay page, the director and the tour make (the snapshot, the
 * agents, the build, each file's lineage, each landing's note check and the change it made to each file, a tour's
 * reads). Played back, a stand-in for `fetch` answers those reads from the file, so the page runs unchanged; any other
 * read under /api answers at once that it is not in this recording, and nothing under /api reaches the network.
 */

/** What every recording says it is. */
export const RECORDING_FORMAT = "firetrident-recording";
/** The newest recording layout this page reads. */
export const RECORDING_VERSION = 1;
/** Where recordings bundled with the page live (packages/web/public/recordings, shipped by `vite build`). */
export const RECORDINGS_PATH = "/recordings/";
/** A bundled recording's name: letters, digits, dot, dash and underscore. */
export const RECORDING_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
/** Events per page at most, as the colony serves them (ColonyDO's EVENTS_PAGE_MAX). */
const PAGE_MAX = 5_000;
/** How long the page waits for a bundled recording before it says it could not read one. */
const LOAD_TIMEOUT_MS = 20_000;

/** The colony's event record as the recorder read it: every page, joined. */
export interface RecordedRun {
  source: "recorded" | "reconstructed";
  total: number;
  first: number | null;
  last: number | null;
  events: RecordedEvent[];
}

/** A read the deployment refused when the run was recorded (a change of a private colony): played back the same way. */
export interface RecordingRefusal {
  status: number;
  error: string;
}

/** One recording (see the module comment). Keys of `reads` and `refused` are readKey()s. */
export interface Recording {
  format: typeof RECORDING_FORMAT;
  version: number;
  colonyId: string;
  /** When it was recorded (ISO time). */
  recordedAt: string;
  /** What it holds and what was taken out, in words. */
  note?: string;
  record: RecordedRun;
  reads: Record<string, unknown>;
  refused: Record<string, RecordingRefusal>;
}

/** The key a read is kept under: its path and its query with the parameters sorted, so ?b=1&a=2 and ?a=2&b=1 are one read. */
export function readKey(pathname: string, search: string | URLSearchParams = ""): string {
  const query = new URLSearchParams(search);
  query.sort();
  const s = query.toString();
  return s ? `${pathname}?${s}` : pathname;
}

/** The key of a read given as a path relative to the origin ("/api/colonies/hono/why?path=src%2Fa.ts"). */
export function keyOf(path: string): string {
  const url = new URL(path, "http://recording.invalid");
  return readKey(url.pathname, url.search);
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

/** A recording from parsed JSON, checked; throws an Error that says, as a sentence, what is wrong with it. */
export function parseRecording(raw: unknown): Recording {
  if (!isObj(raw) || raw.format !== RECORDING_FORMAT) throw new Error("This file is not a FireTrident recording.");
  const version = typeof raw.version === "number" ? raw.version : 0;
  if (version < 1 || version > RECORDING_VERSION) throw new Error(`This recording has layout ${String(raw.version)}, and this page reads up to layout ${RECORDING_VERSION}: open it with a newer FireTrident.`);
  if (typeof raw.colonyId !== "string" || !raw.colonyId) throw new Error("This recording names no colony.");
  const record = raw.record;
  if (!isObj(record) || !Array.isArray(record.events)) throw new Error("This recording holds no event record.");
  const events = record.events.filter((e): e is RecordedEvent => isObj(e) && typeof e.t === "string" && typeof e.seq === "number").sort((a, b) => a.seq - b.seq);
  const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
  const refused: Record<string, RecordingRefusal> = {};
  for (const [key, r] of Object.entries(isObj(raw.refused) ? raw.refused : {})) {
    if (isObj(r) && typeof r.status === "number" && r.status >= 400 && r.status <= 599) refused[key] = { status: r.status, error: typeof r.error === "string" ? r.error : "" };
  }
  return {
    format: RECORDING_FORMAT,
    version,
    colonyId: raw.colonyId,
    recordedAt: typeof raw.recordedAt === "string" ? raw.recordedAt : "",
    ...(typeof raw.note === "string" ? { note: raw.note } : {}),
    record: {
      source: record.source === "reconstructed" ? "reconstructed" : "recorded",
      total: num(record.total) ?? events.length,
      first: num(record.first),
      last: num(record.last),
      events,
    },
    reads: isObj(raw.reads) ? raw.reads : {},
    refused,
  };
}

/** Undo gzip (the recorder writes `.json.gz`). */
async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A recording from a file's bytes, gzip or plain JSON; throws an Error with a sentence when they are not one. */
export async function readRecording(data: ArrayBuffer | Uint8Array): Promise<Recording> {
  let bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    try {
      bytes = await gunzip(bytes);
    } catch {
      throw new Error("This file is compressed but could not be uncompressed.");
    }
  }
  const text = new TextDecoder().decode(bytes).trimStart();
  // A page instead of a file: the server's answer for a path it has nothing at.
  if (text.startsWith("<")) throw new Error("A web page came back instead of a recording.");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("This file is not JSON, so it is not a recording.");
  }
  return parseRecording(raw);
}

/** Where a bundled recording may be: `<name>.json.gz`, then `<name>.json` (a name that ends in either is used as it is). */
export function recordingUrls(name: string): string[] {
  if (/\.json(\.gz)?$/.test(name)) return [`${RECORDINGS_PATH}${name}`];
  return [`${RECORDINGS_PATH}${name}.json.gz`, `${RECORDINGS_PATH}${name}.json`];
}

/** The recording bundled with the page under `name`; throws an Error with a sentence when there is none or it is unreadable. */
export async function loadBundledRecording(name: string, fetcher: typeof fetch = (input, init) => fetch(input, init)): Promise<Recording> {
  if (!RECORDING_NAME.test(name)) throw new Error(`“${name.slice(0, 60)}” is not a recording name: use letters, digits, dots, dashes and underscores.`);
  const tried: string[] = [];
  let unreadable: Error | null = null;
  for (const url of recordingUrls(name)) {
    tried.push(url);
    let res: Response;
    try {
      res = await fetcher(url, { signal: AbortSignal.timeout(LOAD_TIMEOUT_MS) });
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      throw new Error(timedOut ? `${url} did not arrive within ${LOAD_TIMEOUT_MS / 1000} s.` : `${url} could not be read (${e instanceof Error ? e.message : "network error"}).`);
    }
    if (!res.ok) continue;
    try {
      return await readRecording(await res.arrayBuffer());
    } catch (e) {
      // A page that answers every path sends itself for one it has nothing at: try the next name.
      if (e instanceof Error && e.message.startsWith("A web page")) continue;
      unreadable = new Error(`${url}: ${e instanceof Error ? e.message : "it could not be read."}`);
    }
  }
  throw unreadable ?? new Error(`No recording named “${name}” is bundled with this page (looked for ${tried.join(" and ")}).`);
}

/** How a recording answers one read. `hit` is false for a read it does not hold. */
export interface RecordingAnswer {
  status: number;
  statusText: string;
  body: unknown;
  hit: boolean;
}

/** The sentence a read the recording does not hold answers with. */
export function notInRecording(key: string): string {
  return `Not in this recording: GET ${key}. A recording plays offline from what was recorded; the live colony has the rest.`;
}

/** A page of the event record, cut from the whole record as the colony would serve it; null when it asks for a source the recording does not hold. */
export function eventsPage(rec: Recording, query: URLSearchParams): EventsPage | null {
  const want = query.get("source");
  if ((want === "recorded" || want === "reconstructed") && want !== rec.record.source) return null;
  const int = (raw: string | null, fallback: number): number => (raw !== null && /^\d+$/.test(raw) ? Number(raw) : fallback);
  const after = int(query.get("after"), 0);
  const limit = Math.max(1, Math.min(PAGE_MAX, int(query.get("limit"), 1_000)));
  const events = rec.record.events;
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((events[mid]?.seq ?? 0) <= after) lo = mid + 1;
    else hi = mid;
  }
  const page = events.slice(lo, lo + limit);
  const more = lo + limit < events.length;
  const r = rec.record;
  return { colonyId: rec.colonyId, source: r.source, events: page, next: more ? (page[page.length - 1]?.seq ?? null) : null, total: r.total, first: r.first, last: r.last };
}

/**
 * The recording's answer to one read under /api: the recorded answer, the recorded refusal, a page of the event record,
 * or, at once, 404 "Not in this recording" with a sentence. `alias` is another colony id the page may ask under (the
 * colony in the address bar), answered as the recorded colony. Writes answer 405: a recording is read-only.
 */
export function answerRead(rec: Recording, method: string, pathname: string, search: string, alias?: string): RecordingAnswer {
  const miss = (key: string): RecordingAnswer => ({ status: 404, statusText: "Not in this recording", body: { error: notInRecording(key) }, hit: false });
  if (method !== "GET" && method !== "HEAD") {
    return { status: 405, statusText: "Read-only recording", body: { error: "A recording is read-only: nothing can change in it. Open the live colony to act." }, hit: false };
  }
  const own = `/api/colonies/${encodeURIComponent(rec.colonyId)}`;
  let path = pathname;
  if (alias && alias !== rec.colonyId) {
    const other = `/api/colonies/${encodeURIComponent(alias)}`;
    if (path === other || path.startsWith(`${other}/`)) path = own + path.slice(other.length);
  }
  const key = readKey(path, search);
  if (path === `${own}/events`) {
    const page = eventsPage(rec, new URLSearchParams(search));
    return page ? { status: 200, statusText: "OK", body: page, hit: true } : miss(key);
  }
  if (Object.hasOwn(rec.reads, key)) return { status: 200, statusText: "OK", body: rec.reads[key], hit: true };
  const refused = rec.refused[key];
  if (refused) return { status: refused.status, statusText: "Refused when recorded", body: { error: refused.error || `The deployment refused GET ${key} when this was recorded.` }, hit: true };
  return miss(key);
}

/** Options for recordingFetch. */
export interface RecordingFetchOptions {
  /** What a read outside /api goes to (the page's own files). */
  fallback: typeof fetch;
  /** The page's origin, which relative URLs resolve against. */
  origin?: string;
  /** Another colony id answered as the recorded one (see answerRead). */
  alias?: string;
  /** Told the key of each read the recording does not hold. */
  onMiss?: (key: string) => void;
}

/** A `fetch` that answers every read under /api on the page's origin from `rec` (answerRead), and passes anything else to `fallback`. */
export function recordingFetch(rec: Recording, opts: RecordingFetchOptions): typeof fetch {
  const origin = opts.origin ?? "http://recording.invalid";
  const home = new URL(origin).origin;
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    let url: URL;
    try {
      url = new URL(raw, origin);
    } catch {
      return opts.fallback(input, init);
    }
    if (url.origin !== home || !url.pathname.startsWith("/api/")) return opts.fallback(input, init);
    const method = (init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase();
    const a = answerRead(rec, method, url.pathname, url.search, opts.alias);
    if (!a.hit) opts.onMiss?.(readKey(url.pathname, url.search));
    const headers = { "content-type": "application/json", "x-ft-recording": a.hit ? "hit" : "miss" };
    return new Response(method === "HEAD" ? null : JSON.stringify(a.body), { status: a.status, statusText: a.statusText, headers });
  }) as typeof fetch;
}

/**
 * Answer the page's reads from `rec` from now on: `fetch` is replaced by recordingFetch, and each read the recording does
 * not hold is logged once. Returns a function that puts the network back.
 */
export function installRecording(rec: Recording, opts: { alias?: string } = {}): () => void {
  const original = globalThis.fetch;
  const missed = new Set<string>();
  const origin = typeof location !== "undefined" && location.origin && location.origin !== "null" ? location.origin : "http://recording.invalid";
  globalThis.fetch = recordingFetch(rec, {
    fallback: (input, init) => original.call(globalThis, input, init),
    origin,
    ...(opts.alias ? { alias: opts.alias } : {}),
    onMiss: (key) => {
      if (missed.has(key)) return;
      missed.add(key);
      console.info(`Recording: ${notInRecording(key)}`);
    },
  });
  console.info(
    `Recording: playing ${rec.colonyId}${rec.recordedAt ? `, recorded ${rec.recordedAt}` : ""}: ${rec.record.events.length.toLocaleString("en-US")} events and ${Object.keys(rec.reads).length.toLocaleString("en-US")} reads. Reads under /api are answered from it, with no network.`,
  );
  return () => {
    globalThis.fetch = original;
  };
}
