#!/usr/bin/env node
/** `ft`: the FireTrident command line. Run `ft --help`. */
import { main } from "./run.ts";

process.exitCode = await main(process.argv.slice(2));
// `ft hook check` runs before every edit (hook.ts): once its line is written it exits, rather than wait on a connection the
// server never answered.
if (process.argv[2] === "hook" && process.argv[3] === "check") process.stdout.write("", () => process.exit());
