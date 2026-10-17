import type { Landing, LandingTests } from "@fire_trident/core";
import { testsLines, testsRow } from "@fire_trident/core";
import type { ApiRequest } from "./api.ts";
import { colonyPath } from "./api.ts";
import type { Colors } from "./format.ts";

/**
 * A landing's test row in `ft why` (GET /api/colonies/:id/landings/:ref/tests; worker certify/landingtests.ts): for the
 * newest landings it prints, the tests at the base against the certified commit, the tests lost, what landed it and its
 * spend, then the lost tests by name, whose tests they are and the closure check, in yellow when no earlier test reaches
 * the change. The colony computes a row when it is first asked for, so only the newest WHY_TEST_ROWS are asked.
 */

/** Landings of `ft why` that get their test row (the first ones it prints). */
export const WHY_TEST_ROWS = 5;

/** The request for one landing's test row. */
export function testsRequest(colony: string, landingId: string): ApiRequest {
  return { method: "GET", path: colonyPath(colony, `/landings/${encodeURIComponent(landingId)}/tests`) };
}

/** A row from the server, or null when the answer is not one (its words written from its fields when it sent none). */
export function testsRowOf(raw: unknown): LandingTests | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Partial<LandingTests>;
  if (typeof r.landingId !== "string" || (r.status !== "certified" && r.status !== "pending" && r.status !== "no-tests")) return null;
  const t = { ...r, proof: r.proof && typeof r.proof.text === "string" ? r.proof : { rungs: [], text: "unknown" } } as LandingTests;
  return { ...t, text: typeof r.text === "string" && r.text !== "" ? r.text : testsRow(t) };
}

/** The landings `ft why` prints first, in its order (for a line, the server's; else newest first), at most `n` ids. */
export function firstLandings(entries: ReadonlyArray<{ landing?: Partial<Landing> }>, line: number | undefined, n = WHY_TEST_ROWS): string[] {
  const at = (l: Partial<Landing> | undefined): number => (typeof l?.at === "number" && Number.isFinite(l.at) ? l.at : 0);
  const found = entries.filter((e) => e && e.landing && typeof e.landing.id === "string");
  const sorted = line !== undefined ? found : [...found].sort((a, b) => at(b.landing) - at(a.landing));
  return sorted.slice(0, n).map((e) => e.landing!.id!);
}

/** Read the rows of these landings at once; a row that fails or is not one is left out. */
export async function readRows(ids: readonly string[], get: (id: string) => Promise<unknown>): Promise<Record<string, LandingTests>> {
  const out: Record<string, LandingTests> = {};
  const rows = await Promise.all(ids.map(async (id) => testsRowOf(await get(id).catch(() => null))));
  ids.forEach((id, i) => {
    const t = rows[i];
    if (t) Object.defineProperty(out, id, { value: t, enumerable: true, writable: true, configurable: true });
  });
  return out;
}

/** Text from the server (test names and paths are the repository's) as one terminal line: no control characters. */
function plain(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
}

/** The row as `ft why` prints it under a landing: its line (labeled `delta`), then the lines under it (yellow when they warn). */
export function testsRows(t: LandingTests, c: Colors): Array<{ k: string; v: string }> {
  const text = plain(t.text);
  const head = t.status === "certified" ? text : c.dim(text);
  return [{ k: "delta", v: head }, ...testsLines(t).map((l) => ({ k: "", v: l.warn ? c.yellow(plain(l.text)) : c.dim(plain(l.text)) }))];
}
