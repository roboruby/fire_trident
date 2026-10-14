/**
 * The colonies with a tour of their own, for the landing page's results cards (a "Take the tour" link beside Replay).
 * This stays light: the tours themselves (tours.ts) load with the tour player, not with the landing page.
 */

/** What each tour tells, in a line, by colony id (the link's title). */
export const TOUR_ABOUT: Readonly<Record<string, string>> = {
  hono: "Two minutes through the Hono run, told from its own record",
  "first-red": "Certification goes red, the search names the landing that broke the test, the repair lands and trunk is green again, told from the colony's record",
  "order-backend": "Three agents with conflicting goals: the first change lands, the other two wait for a person, each naming the landing it would undo, told from the colony's record",
};

/** Whether a colony has a tour of its own. */
export function hasTour(colonyId: string): boolean {
  return Object.hasOwn(TOUR_ABOUT, colonyId);
}
