import { parseSeries, type Series } from "./series.ts";
import { metricKey } from "./store.ts";

export type { Series } from "./series.ts";

/** Colonies shown when the server cannot list them (GET /api/colonies missing or failing). */
export const FALLBACK_COLONIES: readonly string[] = ["openspec-e2e"];

/** One colony as the landing page and the colony picker show it. */
export interface ColonyCard {
  id: string;
  name: string;
  source?: { url: string; branch?: string };
  trunkSha?: string;
  lastLandingAt: number | null;
  /** Counters by normalized metric key (see metricKey). */
  counters: Map<string, number>;
  violations: number | null;
  series: Series | null;
  error?: string;
}

type Json = Record<string, unknown>;

const isObj = (x: unknown): x is Json => typeof x === "object" && x !== null && !Array.isArray(x);
const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);

async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(url, { headers: { accept: "application/json" }, signal });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

function counters(raw: unknown): Map<string, number> {
  const out = new Map<string, number>();
  if (isObj(raw)) for (const [k, v] of Object.entries(raw)) if (typeof v === "number" && Number.isFinite(v)) out.set(metricKey(k), v);
  return out;
}

function source(raw: unknown): ColonyCard["source"] {
  if (!isObj(raw) || typeof raw.url !== "string") return undefined;
  return { url: raw.url, ...(typeof raw.branch === "string" ? { branch: raw.branch } : {}) };
}

/** A card from one row of GET /api/colonies. */
function fromListing(row: unknown): ColonyCard | null {
  if (typeof row === "string") return { id: row, name: row, lastLandingAt: null, counters: new Map(), violations: null, series: null };
  if (!isObj(row)) return null;
  const id = typeof row.id === "string" ? row.id : typeof row.colonyId === "string" ? row.colonyId : null;
  if (!id) return null;
  const c = counters(row.counters ?? row.metrics);
  return {
    id,
    name: typeof row.name === "string" && row.name ? row.name : id,
    source: source(row.source),
    trunkSha: typeof row.trunkSha === "string" ? row.trunkSha : undefined,
    lastLandingAt: num(row.lastLandingAt),
    counters: c,
    violations: num(isObj(row.violations) ? row.violations.total : row.violations) ?? c.get("violations") ?? null,
    series: parseSeries(row.series),
    ...(typeof row.error === "string" ? { error: row.error } : {}),
  };
}

/** Ids (and rows) from GET /api/colonies, or null when the route is missing or failing. */
export async function listColonies(signal?: AbortSignal): Promise<ColonyCard[] | null> {
  try {
    const data = await getJson("/api/colonies", signal);
    const rows = Array.isArray(data) ? data : isObj(data) && Array.isArray(data.colonies) ? data.colonies : null;
    if (!rows) return null;
    return rows.map(fromListing).filter((c): c is ColonyCard => c !== null);
  } catch {
    return null;
  }
}

/** Fill a card's counters and series from /metrics, or from the full snapshot on an older server. */
async function enrich(card: ColonyCard, signal?: AbortSignal): Promise<ColonyCard> {
  const base = `/api/colonies/${encodeURIComponent(card.id)}`;
  if (card.error) card = { ...card, counters: new Map() };
  try {
    const m = await getJson(`${base}/metrics`, signal);
    if (isObj(m)) {
      const c = counters(m.metrics);
      for (const [k, v] of card.counters) if (!c.has(k)) c.set(k, v);
      const violations = isObj(m.violations) ? num(m.violations.total) : null;
      return { ...card, counters: c, violations: violations ?? card.violations ?? c.get("violations") ?? null, series: parseSeries(m.series) ?? card.series };
    }
  } catch (err) {
    if (signal?.aborted) throw err;
  }
  if (card.counters.size) return card;
  const snap = await getJson(base, signal);
  if (!isObj(snap) || !isObj(snap.colony)) throw new Error("malformed snapshot");
  const col = snap.colony;
  const c = counters(snap.metrics);
  const landings = Array.isArray(snap.recentLandings) ? snap.recentLandings : [];
  const lastAt = landings.reduce<number | null>((acc, l) => {
    const at = isObj(l) ? num(l.at) : null;
    return at !== null && (acc === null || at > acc) ? at : acc;
  }, null);
  return {
    ...card,
    name: typeof col.name === "string" ? col.name : card.name,
    source: source(col.source) ?? card.source,
    trunkSha: typeof col.trunkSha === "string" ? col.trunkSha : card.trunkSha,
    lastLandingAt: card.lastLandingAt ?? lastAt,
    counters: c,
    violations: isObj(snap.violations) ? num(snap.violations.total) : null,
    series: parseSeries(snap.series),
  };
}

/**
 * The colonies to show, with live counters: the server's list when it has one, else the
 * configured fallback ids. Colonies that are gone (404) are dropped; ones that fail keep an error.
 */
export async function loadColonies(opts: { ids?: readonly string[]; max?: number; signal?: AbortSignal } = {}): Promise<ColonyCard[]> {
  const max = opts.max ?? 6;
  const listed = opts.ids ? null : await listColonies(opts.signal);
  const cards = (listed ?? (opts.ids ?? FALLBACK_COLONIES).map((id) => fromListing(id)).filter((c): c is ColonyCard => c !== null)).slice(0, max);
  const out = await Promise.all(
    cards.map(async (card): Promise<ColonyCard | null> => {
      try {
        // A listing row that failed its summary may still answer its own routes.
        const { error: _listError, ...rest } = await enrich(card, opts.signal);
        return rest;
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        const msg = err instanceof Error ? err.message : "unreachable";
        return msg === "404" ? null : { ...card, error: card.error ?? msg };
      }
    }),
  );
  return out.filter((c): c is ColonyCard => c !== null);
}

/** Colony ids for the header picker: the server's list, else the fallback. */
export async function colonyIds(signal?: AbortSignal): Promise<Array<{ id: string; name: string }>> {
  const listed = await listColonies(signal);
  if (listed && listed.length) return listed.map((c) => ({ id: c.id, name: c.name }));
  return FALLBACK_COLONIES.map((id) => ({ id, name: id }));
}
