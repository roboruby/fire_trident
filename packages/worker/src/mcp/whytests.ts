import type { Id, Landing, LandingTests } from "@fire_trident/core";

/**
 * Both MCP `why` tools (the authenticated one and the public one) give the newest landings of an answer their test row
 * (ColonyDO.landingTests, certify/landingtests.ts), as the Why tab and `ft why` show it: the tests at the base against
 * the certified commit, the tests lost, whose tests they are, whether an earlier test reaches the change, what landed it
 * and its spend. The colony computes a row when it is first asked for and keeps it per certified commit, so the wait is
 * bounded: rows not ready by WHY_TESTS_MS are left out, and the entry says how to get them.
 */

/** Entries of a why answer that carry their test row at most (the first ones, in the answer's order). */
export const WHY_TEST_LANDINGS = 5;
/** How long a why answer waits for its test rows, in all. */
export const WHY_TESTS_MS = 4_000;

/** One entry of a why answer, with its test row once read. */
export type WithTests<E> = E & { tests?: LandingTests | { unavailable: string } };

/** Reads one landing's test row (the colony's landingTests). */
export type ReadTests = (landingId: Id) => Promise<LandingTests | null>;

/**
 * The answer's entries with the first WHY_TEST_LANDINGS test rows that the colony reads within WHY_TESTS_MS. An entry
 * whose row is not ready or failed says so in `tests.unavailable`; the others carry none. Never throws.
 */
export async function withTests<E extends { landing: Pick<Landing, "id"> }>(entries: readonly E[], read: ReadTests | undefined, ms = WHY_TESTS_MS): Promise<Array<WithTests<E>>> {
  const out: Array<WithTests<E>> = entries.map((e) => ({ ...e }));
  if (!read || out.length === 0) return out;
  const asked = out.slice(0, WHY_TEST_LANDINGS);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), ms);
  });
  await Promise.all(
    asked.map(async (e) => {
      try {
        const t = await Promise.race([read(e.landing.id), late]);
        if (t === "late") e.tests = { unavailable: `the test row was not ready within ${ms / 1000} s; GET /api/colonies/<colony>/landings/${e.landing.id}/tests has it once the colony has read it` };
        else if (t) e.tests = t;
      } catch (err) {
        e.tests = { unavailable: `the test row could not be read: ${err instanceof Error ? err.message : String(err)}` };
      }
    }),
  );
  if (timer !== undefined) clearTimeout(timer);
  return out;
}
