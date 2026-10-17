import { decidesOf, presetLabel, splitRows, type DecidesReport } from "@fire_trident/core";
import { fmtInt } from "./format.ts";

/**
 * How a colony decides, for the colony page's card (components/Decides.tsx): the report GET /api/colonies/:id/decides
 * answers (a public read with no token; worker decide/decides.ts), read the way the first screen reads the protected
 * paths. The words (the preset, the split, each landing's confirming rule) come from core/decides.ts, so the page, the
 * landing cards and the CLI say the same thing.
 */

/** The report as far as this page could read it. */
export type DecidesState =
  | { state: "loaded"; report: DecidesReport }
  | { state: "loading" }
  /** Not known: the simulator has no policy, a recording did not keep the report, the server did not answer (`why` says which). */
  | { state: "unknown"; why: string };

/** Read the colony's report. The simulator has no policy; a recording answers only what it kept; an older server has no such route. */
export async function readDecides(colonyId: string, mode: "live" | "mock" | "replay", fetcher: typeof fetch = (input, init) => fetch(input, init)): Promise<DecidesState> {
  if (mode === "mock") return { state: "unknown", why: "the simulator has no decide policy" };
  let res: Response;
  try {
    res = await fetcher(`/api/colonies/${encodeURIComponent(colonyId)}/decides`, { headers: { accept: "application/json" } });
  } catch {
    return { state: "unknown", why: "the colony API could not be reached" };
  }
  if (res.headers.get("x-ft-recording") === "miss") return { state: "unknown", why: "this recording did not keep how the colony decides" };
  if (res.status === 404) return { state: "unknown", why: "this server does not report how its colonies decide" };
  if (!res.ok) return { state: "unknown", why: `the server answered ${res.status}` };
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { state: "unknown", why: "the server's answer was not JSON" };
  }
  const report = decidesOf(body);
  return report ? { state: "loaded", report } : { state: "unknown", why: "the server's answer was not a report" };
}

/** Short names for the split's kinds where a line has little room. */
export const SHORT_KIND: Record<string, string> = { deterministic: "proof", model: "model", autonomy: "autonomy", person: "person", unreviewed: "no review" };

/** The preset's label, or "custom (nearest <label>)". */
export function presetName(r: DecidesReport): string {
  return r.preset === "custom" ? `custom (nearest ${presetLabel(r, r.nearest)})` : presetLabel(r, r.preset);
}

/** The split where a line has little room: "40 landed in 30 days: 60% proof · 25% model · ...". */
export function splitSummary(r: DecidesReport): string {
  const s = r.split;
  if (s.total === 0) return `nothing landed in the last ${s.days} days`;
  const parts = splitRows(s)
    .filter((x) => x.count > 0)
    .map((x) => `${x.percent}% ${SHORT_KIND[x.kind] ?? x.kind}`);
  return `${fmtInt(s.total)} landed in ${s.days} days: ${parts.join(" · ")}`;
}

/** The target panel's one line: "central development · 40 landed in 30 days: 60% proof · 25% model · ...". */
export function decidesSummary(r: DecidesReport): string {
  return `${presetName(r)} · ${splitSummary(r)}`;
}
