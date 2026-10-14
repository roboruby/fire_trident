/**
 * The command line of scripts/bisect.ts, read without side effects so a test can check it. The check runs on two new
 * colonies: --on, one FT_BISECT lists, and --off, one it does not. The demo (--demo) runs on one new colony and has no
 * --off: a deployment with FT_BISECT on for every colony (production) has no colony to leave out.
 */

/** A colony id as the API makes one from a name: lowercase letters, digits and dashes, at most 48 characters. */
const COLONY_ID = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;

/** What the command line asks for, or why it cannot run (one sentence that says what to do). */
export type BisectArgs = { mode: "check"; url: string; on: string; off: string } | { mode: "demo"; url: string; colony: string } | { error: string };

/** How to run the script, printed after any error. */
export const USAGE = [
  "usage: FT_ADMIN_TOKEN=... node scripts/bisect.ts --url <deployment> --on <new colony id FT_BISECT lists> --off <another new colony id>",
  "   or: FT_ADMIN_TOKEN=... node scripts/bisect.ts --url <deployment> --demo <new colony id>",
].join("\n");

/** The value after `--<name>`: undefined when the option is absent, last, or followed by another option. */
function option(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  return v === undefined || v.startsWith("--") ? undefined : v;
}

/**
 * Read the arguments (without the node and script paths) and the environment: the deployment from --url or FT_URL, and
 * FT_ADMIN_TOKEN, which only has to be set (the script reads it itself, so it never travels in the answer). The check
 * needs --on and --off, two different colonies; the demo needs --demo with a colony id and neither of the others.
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
    return { mode: "demo", url, colony };
  }
  if (!on || !off) return { error: "Name two new colonies, --on (one FT_BISECT lists) and --off (one it does not), or run the demo with --demo <colony>." };
  if (on === off) return { error: "--on and --off must name two different colonies." };
  return { mode: "check", url, on, off };
}
