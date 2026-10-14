/**
 * The command line of scripts/bisect.ts, read without side effects so a test can check it. The check runs on two new
 * colonies: --on, one FT_BISECT lists, and --off, one it does not. The demo (--demo) runs on one new colony and has no
 * --off: a deployment with FT_BISECT on for every colony (production) has no colony to leave out. Both take the
 * history to land: --landings, how many landings since green (six when absent), and --break-at, which of them breaks
 * the test (the middle when absent); scripts/bisect_history.ts says what the search makes of it.
 */
import { DEFAULT_LANDINGS, SEARCH_LANDINGS, SEARCH_RUNS, SETTLED_LANDINGS, defaultBreakAt, predictRuns } from "./bisect_history.ts";

/** A colony id as the API makes one from a name: lowercase letters, digits and dashes, at most 48 characters. */
const COLONY_ID = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
/** A whole number as an option value: digits only, no sign and no fraction. */
const WHOLE = /^\d+$/;

/** The history both forms land: the landings since green, and the position (from 1) of the one that breaks the test. */
export interface HistoryArgs {
  landings: number;
  breakAt: number;
}

/** What the command line asks for, or why it cannot run (one sentence that says what to do). */
export type BisectArgs = ({ mode: "check"; url: string; on: string; off: string } & HistoryArgs) | ({ mode: "demo"; url: string; colony: string } & HistoryArgs) | { error: string };

/** How to run the script, printed after any error. */
export const USAGE = [
  "usage: FT_ADMIN_TOKEN=... node scripts/bisect.ts --url <deployment> --on <new colony id FT_BISECT lists> --off <another new colony id> [--landings <n>] [--break-at <k>]",
  "   or: FT_ADMIN_TOKEN=... node scripts/bisect.ts --url <deployment> --demo <new colony id> [--landings <n>] [--break-at <k>]",
  `--landings: landings since green, 1 to ${SEARCH_LANDINGS} (${DEFAULT_LANDINGS} when absent). --break-at: which of them breaks the test, from 1 (the middle when absent).`,
  `The search settles any history of up to ${SETTLED_LANDINGS} landings in its ${SEARCH_RUNS} test runs, and longer ones only at some positions; the script refuses the rest.`,
].join("\n");

/** The value after `--<name>`: undefined when the option is absent, last, or followed by another option. */
function option(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  return v === undefined || v.startsWith("--") ? undefined : v;
}

/**
 * The whole number after `--<name>`, from `min` to `max`, or `fallback` when the option is absent. No value, a sign,
 * a fraction or a number out of range is an error that says what the option takes (`what` says what the number is).
 */
function whole(argv: readonly string[], name: string, fallback: number, min: number, max: number, what: string): number | { error: string } {
  if (!argv.includes(`--${name}`)) return fallback;
  const raw = option(argv, name);
  if (raw === undefined) return { error: `--${name} needs a whole number after it, from ${min} to ${max}: ${what}.` };
  const value = WHOLE.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(value) || value < min || value > max) return { error: `--${name} takes a whole number from ${min} to ${max} (${what}), not "${raw}".` };
  return value;
}

/**
 * The history: --landings, 1 to SEARCH_LANDINGS (DEFAULT_LANDINGS when absent), and --break-at, 1 to the landings (the
 * middle when absent); refused when the search's runs would not settle it, since the check expects the search to find
 * the breaking landing.
 */
function historyArgs(argv: readonly string[]): HistoryArgs | { error: string } {
  const landings = whole(argv, "landings", DEFAULT_LANDINGS, 1, SEARCH_LANDINGS, `how many landings since green the search covers; its landing log holds at most ${SEARCH_LANDINGS}`);
  if (typeof landings !== "number") return landings;
  const breakAt = whole(argv, "break-at", defaultBreakAt(landings), 1, landings, `which of the ${landings} landings since green breaks the test, counted from the first`);
  if (typeof breakAt !== "number") return breakAt;
  const predicted = predictRuns(landings, breakAt);
  if (!predicted.settled) {
    return {
      error: `The search's ${SEARCH_RUNS} test runs do not settle ${landings} landings with the break at position ${breakAt}: it would stop with the first failing commit narrowed to ${predicted.narrowed} landings. Use at most ${SETTLED_LANDINGS} landings (the runs settle every position of those), or a position they settle.`,
    };
  }
  return { landings, breakAt };
}

/**
 * Read the arguments (without the node and script paths) and the environment: the deployment from --url or FT_URL, and
 * FT_ADMIN_TOKEN, which only has to be set (the script reads it itself, so it never travels in the answer). The check
 * needs --on and --off, two different colonies; the demo needs --demo with a colony id and neither of the others. Both
 * take --landings and --break-at, checked last.
 */
export function parseArgs(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): BisectArgs {
  const url = (option(argv, "url") ?? env.FT_URL ?? "").replace(/\/+$/, "");
  if (!url) return { error: "Name the deployment with --url (or FT_URL)." };
  if (!env.FT_ADMIN_TOKEN) return { error: "Set FT_ADMIN_TOKEN: the script creates colonies and lands changes, which needs the admin token." };
  const on = option(argv, "on") ?? "";
  const off = option(argv, "off") ?? "";
  if (argv.includes("--demo")) {
    const colony = option(argv, "demo") ?? "";
    if (argv.includes("--on") || argv.includes("--off")) return { error: "The demo runs on one colony: leave out --on and --off." };
    if (!colony) return { error: "Name the demo's colony after --demo, a colony that does not exist yet." };
    if (!COLONY_ID.test(colony)) return { error: `"${colony}" is not a colony id: use lowercase letters, digits and dashes (at most 48), starting and ending with a letter or digit.` };
    const history = historyArgs(argv);
    if ("error" in history) return history;
    return { mode: "demo", url, colony, ...history };
  }
  if (!on || !off) return { error: "Name two new colonies, --on (one FT_BISECT lists) and --off (one it does not), or run the demo with --demo <colony>." };
  if (on === off) return { error: "--on and --off must name two different colonies." };
  const history = historyArgs(argv);
  if ("error" in history) return history;
  return { mode: "check", url, on, off, ...history };
}
