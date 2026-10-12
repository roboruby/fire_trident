#!/usr/bin/env node
/** `ft`: the FireTrident command line. Run `ft --help`. */
import { main } from "./run.ts";

process.exitCode = await main(process.argv.slice(2));
