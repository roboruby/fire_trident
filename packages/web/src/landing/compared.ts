import { REPO } from "./questions.ts";

/**
 * The landing page's "with and without" panel: a few mechanisms, each measured with it off and on, chosen from the
 * ledger in docs/mechanisms.md ("What each mechanism buys"), which holds every mechanism with its source. Every number here is
 * copied from that mechanism's row of the ledger (test/compared.test.ts checks), and every row links to the folder of
 * packages/bench/results that holds its run.
 */

/** Where a row was measured, as its results say: the live service, a preview deployment, or the simulator. */
export type Measured = "production" | "preview" | "simulated";

/** How a row reads: it earns what it costs, it trades one number for another, or it costs more than it earns. */
export type Verdict = "earns" | "trade" | "costs";

/** One mechanism, measured with it off and on. */
export interface Comparison {
  /** The anchor on the landing page. */
  id: string;
  /** The mechanism, named as its row of the ledger begins. */
  mechanism: string;
  /** The flag that switches it, or null for a mechanism that is always on. */
  flag: string | null;
  /** The number the mechanism exists to move, and under what load. */
  metric: string;
  /** The value with the mechanism off. */
  off: string;
  /** The value with it on. */
  on: string;
  /** What else the run showed: the cost, or how to read the two values. */
  note: string;
  verdict: Verdict;
  label: Measured;
  /** The folder under packages/bench/results that holds the run. */
  folder: string;
}

/** The ledger in docs/mechanisms.md, every mechanism with its source. */
export const LEDGER_HREF = `${REPO}/blob/main/docs/mechanisms.md#what-each-mechanism-buys`;

/** A results folder on GitHub. */
export function resultsHref(folder: string): string {
  return `${REPO}/tree/main/packages/bench/results/${folder}`;
}

/** What each label means, for the label's tooltip. */
export const MEASURED_TITLE: Readonly<Record<Measured, string>> = {
  production: "Measured on the live service",
  preview: "Measured on a preview deployment of the same code, with its own Durable Objects",
  simulated: "From the simulator, driven by Hono's history",
};

/** The panel's rows, most telling first. */
export const COMPARED: readonly Comparison[] = [
  {
    id: "after-landing",
    mechanism: "Testing after landing",
    flag: "FT_TRUNK_TESTS",
    metric: "Landings a minute, 1,000 agents, 30-second tests",
    off: "1.9",
    on: "164",
    note: "Without it, a modeled merge queue re-runs a change's tests after every rebase: 1.9 a minute at every agent count, and 675.9 s to land at the median against 1.5 s. The cost: 45% of agent work redone.",
    verdict: "trade",
    label: "simulated",
    folder: "2026-10-12",
  },
  {
    id: "group-commit",
    mechanism: "Group commit",
    flag: null,
    metric: "Landings a minute, 200 synthetic agents",
    off: "126",
    on: "690",
    note: "5.5 times the landings, and 2.9 s to land at the median against 54.3 s. The run without it is the serial trunk writer on production.",
    verdict: "earns",
    label: "preview",
    folder: "2026-10-12-g1",
  },
  {
    id: "inline",
    mechanism: "Inline changes",
    flag: "FT_INLINE",
    metric: "Landings a minute, 5,000 synthetic agents",
    off: "1,821",
    on: "3,842",
    note: "The trunk writer stops reading each change from a workspace, so its cycle takes 2.8 s instead of 5.1 s.",
    verdict: "earns",
    label: "preview",
    folder: "2026-10-13-round4",
  },
  {
    id: "revalidate",
    mechanism: "Import-name revalidation",
    flag: "FT_REVALIDATE",
    metric: "Of 30 changes importing a file that then changed, how many went back",
    off: "30 of 30",
    on: "0 of 30",
    note: "All 30 landed on their first proposal. It checks that the imported names still exist and that the files read only grew, not what new code does; off in production.",
    verdict: "earns",
    label: "preview",
    folder: "2026-10-13-round2",
  },
  {
    id: "text-merge",
    mechanism: "Text merge",
    flag: "FT_TEXT_MERGE",
    metric: "Two edits to different lines of one file, from the same trunk",
    off: "second sent back",
    on: "both landed",
    note: "The second lands as a line-by-line merge that holds both edits. Two edits of the same line still end with one sent back.",
    verdict: "earns",
    label: "preview",
    folder: "2026-10-14-round5",
  },
  {
    id: "goal-conflict",
    mechanism: "Goal-conflict check",
    flag: "FT_GOAL_CONFLICT",
    metric: "Three agents each move one backend to a different language",
    off: "the last silently won",
    on: "two waited for a person",
    note: "The first change landed, and each held change names the landing it would undo.",
    verdict: "earns",
    label: "preview",
    folder: "2026-10-14-round6",
  },
  {
    id: "call-budget",
    mechanism: "Call budget",
    flag: "FT_AGENT_CALL_BUDGET",
    metric: "Greedy polling calls that reached the colony in 120 s",
    off: "56,450",
    on: "7,974",
    note: "The 4 honest agents beside them landed 120.5 a minute with it and 123.5 without.",
    verdict: "earns",
    label: "preview",
    folder: "2026-10-14-round6",
  },
  {
    id: "async-publish",
    mechanism: "Asynchronous publishing",
    flag: "FT_ASYNC_PUBLISH",
    metric: "Landings a minute, 5,000 synthetic agents",
    off: "3,842",
    on: "3,776 and 2,759",
    note: "Costs more than it earns at this scale: shorter trunk cycles, no more landings, and the slowest landings waited longer. Off in production.",
    verdict: "costs",
    label: "preview",
    folder: "2026-10-13-round4",
  },
];
