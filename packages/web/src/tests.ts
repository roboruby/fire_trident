import type { LandingTests } from "@fire_trident/core";
import { testsRow } from "@fire_trident/core";

/**
 * A landing's test row as the web app reads it (GET /api/colonies/:id/landings/:ref/tests; worker certify/landingtests.ts):
 * read defensively, a row whose certified commit is known kept for the page's life (it can no longer change), a pending
 * one asked again next time, and at most three asked at once, so a long lineage does not flood the colony. The server
 * computes a row when it is first asked for, so the Why tab asks for the newest landings' rows as it opens and the rest
 * when a person opens them.
 */

/** Rows asked for when the Why tab opens (the newest landings'); the others wait for a click. */
export const AUTO_ROWS = 3;
/** Rows asked at once, from the whole page. */
const AT_ONCE = 3;

type Json = Record<string, unknown>;
const isObj = (x: unknown): x is Json => typeof x === "object" && x !== null && !Array.isArray(x);

/** A row from the server, or null when the answer is not one: every field the card reads is checked, and the words come from core when the server sent none. */
export function landingTestsOf(raw: unknown): LandingTests | null {
  if (!isObj(raw) || typeof raw.landingId !== "string" || (raw.status !== "certified" && raw.status !== "pending" && raw.status !== "no-tests")) return null;
  const proof = isObj(raw.proof) && typeof raw.proof.text === "string" ? (raw.proof as unknown as LandingTests["proof"]) : { rungs: [], text: "unknown" };
  const t = { ...(raw as unknown as LandingTests), proof };
  return { ...t, text: typeof raw.text === "string" && raw.text !== "" ? raw.text : testsRow(t) };
}

/** A failed read, with the sentence the card shows. */
export class TestsReadError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

let running = 0;
const waiting: Array<() => void> = [];

async function limited<T>(fn: () => Promise<T>): Promise<T> {
  if (running < AT_ONCE) running++;
  else await new Promise<void>((go) => waiting.push(go));
  try {
    return await fn();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else running--;
  }
}

const rows = new Map<string, Promise<LandingTests | null>>();

/** Is a row settled: its certified commit known, or the colony has no test this platform can run (a slow first read is asked again)? */
function settled(t: LandingTests | null): boolean {
  return !!t && (t.status === "certified" || t.status === "no-tests") && !/took longer than/.test(t.detail ?? "");
}

/** One landing's test row; null when the answer holds none; throws a TestsReadError with a sentence when the read fails. */
export function fetchLandingTests(colonyId: string, landingId: string, fetcher: typeof fetch = fetch): Promise<LandingTests | null> {
  const key = `${colonyId}\n${landingId}`;
  const kept = rows.get(key);
  if (kept) return kept;
  const url = `/api/colonies/${encodeURIComponent(colonyId)}/landings/${encodeURIComponent(landingId)}/tests`;
  const asked = limited(async () => {
    let res: Response;
    try {
      res = await fetcher(url, { headers: { accept: "application/json" } });
    } catch (e) {
      throw new TestsReadError(0, `The colony API could not be reached (${e instanceof Error ? e.message : "network error"}).`);
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new TestsReadError(res.status, `The test row could not be read (${res.status}): try again in a moment.`);
    return landingTestsOf(await res.json());
  });
  rows.set(key, asked);
  asked.then(
    (t) => {
      if (!settled(t)) rows.delete(key);
    },
    () => rows.delete(key),
  );
  return asked;
}
