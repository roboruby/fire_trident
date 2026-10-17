/**
 * Trunk health for the colony page (components/TrunkHealth.tsx): the `trunkHealth` object GET /api/colonies/:id/metrics
 * serves (a public read; worker certify/health.ts), read defensively. The words come from the server, so the page and
 * `ft status` say the same thing: one line ("red 2 times in 400 landings, 3.4 min to green at p50, 0 landings built on
 * red") and the rest in sentences, or why there are no numbers.
 */

/** What the page shows of the colony's trunk health. */
export interface TrunkHealthView {
  /** True when certification judged trunk and the numbers are real; false when the line says why there are none. */
  measured: boolean;
  /** Still red at the end of the window (the line says since when). */
  red: boolean;
  text: string;
  detail: string[];
}

/** The report as far as this page could read it. */
export type TrunkHealthState = { state: "loaded"; health: TrunkHealthView } | { state: "loading" } | { state: "unknown"; why: string };

const STATUSES = new Set(["measured", "no-tests", "off", "none"]);

/** The server's `trunkHealth`, or null when `raw` is not one (an older server sends none). */
export function trunkHealthOf(raw: unknown): TrunkHealthView | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.status !== "string" || !STATUSES.has(r.status) || typeof r.text !== "string" || r.text.trim() === "") return null;
  const measured = r.status === "measured";
  const detail = measured && Array.isArray(r.detail) ? r.detail.filter((d): d is string => typeof d === "string" && d.trim() !== "") : [];
  if (!measured && typeof r.reason === "string" && r.reason.trim() !== "") detail.push(r.reason.trim());
  const red = r.red !== null && typeof r.red === "object" && typeof (r.red as Record<string, unknown>).since === "number";
  return { measured, red: measured && red, text: r.text.trim(), detail };
}

/** Read the colony's trunk health from GET /metrics. Only a live colony: a replay's point in time is not the run's end. */
export async function readTrunkHealth(colonyId: string, mode: "live" | "mock" | "replay", fetcher: typeof fetch = (input, init) => fetch(input, init)): Promise<TrunkHealthState> {
  if (mode !== "live") return { state: "unknown", why: mode === "mock" ? "the simulator runs no tests" : "a replay shows the record, not today's numbers" };
  let res: Response;
  try {
    res = await fetcher(`/api/colonies/${encodeURIComponent(colonyId)}/metrics`, { headers: { accept: "application/json" } });
  } catch {
    return { state: "unknown", why: "the colony API could not be reached" };
  }
  if (!res.ok) return { state: "unknown", why: `the server answered ${res.status}` };
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { state: "unknown", why: "the server's answer was not JSON" };
  }
  const health = trunkHealthOf((body as { trunkHealth?: unknown } | null)?.trunkHealth);
  return health ? { state: "loaded", health } : { state: "unknown", why: "this server does not report trunk health" };
}
