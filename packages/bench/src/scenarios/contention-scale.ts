#!/usr/bin/env node
/**
 * Contention at scale, measured live: thousands of synthetic agents editing the same files of one repository at once,
 * with every result checked against the final trunk afterwards (contention/run.ts runs it, contention/check.ts checks it).
 *
 *   node packages/bench/src/scenarios/contention-scale.ts --base https://<deployment> --agents 1000 --intents 3000
 *   node packages/bench/src/scenarios/contention-scale.ts --base https://<deployment> --agents 200 --plan
 *
 * It creates its own colony (contention-scale-<agents>, or --colony) with review off, seeds a generated TypeScript
 * repository into it (contention/workload.ts: --hot hot files, --modules modules), runs --agents synthetic agents on
 * --intents tasks of three kinds (--mix), checks the final trunk with stock git, and deletes the colony unless --keep.
 * --plan (or --dry-run) prints what it would do and sends nothing. The deployment needs FT_INLINE on for the colony.
 *
 * The admin token comes from FT_TOKEN (or FT_ADMIN_TOKEN), else from ~/.config/firetrident/env when that file's FT_URL
 * is this deployment; behind Cloudflare Access, set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET. No secret is ever
 * printed or written. Results go to packages/bench/results/<date>-contention-scale/ (--out): README.md labeled MEASURED,
 * contention-scale-n<agents>.json with every number, and run-n<agents>.log, all through the evidence redaction.
 * Exit codes: 0 every check passed, 1 a check failed or the run could not finish, 2 a setting is wrong.
 */
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { errorDetail } from "../live.ts";
import { deploymentConfig, secretsOf } from "../contention/config.ts";
import { esbuildParser } from "../contention/check.ts";
import { REPO_ROOT, resultsDir, writeResults } from "../contention/report.ts";
import { runContention, seedChanges, type RunOptions } from "../contention/run.ts";
import { GitTrunk } from "../contention/trunk.ts";
import { DEFAULT_WORKLOAD, generate, hotPath, parseMix, splitMix, TASK_KINDS, type Workload, type WorkloadOptions } from "../contention/workload.ts";

/** Hosts a run refuses without --allow-production. */
const PRODUCTION_HOSTS = new Set(["firetrident.com", "www.firetrident.com"]);
/** Colony ids are lowercase slugs. */
const COLONY_ID = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;

/** The command line, read. */
export interface CliOptions {
  base: string;
  plan: boolean;
  workload: WorkloadOptions;
  run: RunOptions;
  out: string | null;
  allowProduction: boolean;
  note: string | null;
}

/** Parse the command line; throws a sentence naming the first bad value. */
export function parseCli(argv: string[]): CliOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      base: { type: "string" },
      scenario: { type: "string" },
      agents: { type: "string" },
      intents: { type: "string" },
      hot: { type: "string" },
      modules: { type: "string" },
      counters: { type: "string" },
      registry: { type: "string" },
      mix: { type: "string" },
      seed: { type: "string" },
      timeout: { type: "string" },
      drain: { type: "string" },
      ramp: { type: "string" },
      colony: { type: "string" },
      pool: { type: "string" },
      keep: { type: "boolean" },
      plan: { type: "boolean" },
      "dry-run": { type: "boolean" },
      out: { type: "string" },
      "no-cert-test": { type: "boolean" },
      "no-feed": { type: "boolean" },
      "allow-production": { type: "boolean" },
      note: { type: "string" },
    },
    strict: true,
  });
  if (values.scenario !== undefined && values.scenario !== "contention-scale") throw new Error(`--scenario must be contention-scale (got ${values.scenario})`);
  const int = (name: string, raw: string | undefined, fallback: number, min: number, max: number): number => {
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`--${name} must be a whole number from ${min} to ${max} (got ${raw})`);
    return n;
  };
  const base = (values.base ?? "").trim();
  if (!base) throw new Error("pass --base <url>, for example --base https://staging.firetrident.com");
  const agents = int("agents", values.agents, 1000, 1, 10_000);
  const workload: WorkloadOptions = {
    seed: int("seed", values.seed, DEFAULT_WORKLOAD.seed, 0, 0xffffffff),
    hot: int("hot", values.hot, DEFAULT_WORKLOAD.hot, 1, 99),
    modules: int("modules", values.modules, DEFAULT_WORKLOAD.modules, 1, 9_999),
    counters: int("counters", values.counters, DEFAULT_WORKLOAD.counters, 1, 50),
    registry: int("registry", values.registry, DEFAULT_WORKLOAD.registry, 1, 2_000),
    intents: int("intents", values.intents, agents * 3, 1, 100_000),
    mix: values.mix !== undefined ? parseMix(values.mix) : { ...DEFAULT_WORKLOAD.mix },
    certTest: values["no-cert-test"] !== true,
  };
  const colony = (values.colony ?? `contention-scale-${agents}`).trim();
  if (!COLONY_ID.test(colony)) throw new Error(`--colony must be a lowercase slug of at most 48 characters (got ${colony})`);
  const run: RunOptions = {
    colony,
    agents,
    rampS: values.ramp !== undefined ? int("ramp", values.ramp, 0, 0, 600) : Math.min(10, Math.ceil(agents / 50)),
    timeoutS: int("timeout", values.timeout, 1_800, 10, 86_400),
    drainS: int("drain", values.drain, 60, 0, 3_600),
    pollMs: 1_500,
    feed: values["no-feed"] !== true,
    regionDepth: 2,
    pool: int("pool", values.pool, Math.min(10_000, agents + 8), 1, 10_000),
    keep: values.keep === true,
    callTimeoutMs: 60_000,
  };
  return {
    base,
    plan: values.plan === true || values["dry-run"] === true,
    workload,
    run,
    out: values.out ?? null,
    allowProduction: values["allow-production"] === true,
    note: values.note ?? null,
  };
}

/** Where the admin token comes from, in words (never the token). */
export function tokenSource(env: Record<string, string | undefined>, found: boolean): string {
  if ((env.FT_TOKEN ?? "").trim()) return "from FT_TOKEN";
  if ((env.FT_ADMIN_TOKEN ?? "").trim()) return "from FT_ADMIN_TOKEN";
  return found ? "from the ft config file, whose FT_URL is this deployment" : "MISSING: set FT_TOKEN, or FT_URL and FT_TOKEN in ~/.config/firetrident/env";
}

/** What a run would do, as printed by --plan. Sends nothing. */
export function planText(o: CliOptions, w: Workload, token: string, access: boolean, outDir: string): string {
  const split = splitMix(w.options.intents, w.options.mix);
  const perHot = new Array<number>(w.options.hot).fill(0);
  const perCounter = new Map<string, number>();
  for (const t of w.tasks) {
    perHot[t.hot]!++;
    if (t.kind === "increment") perCounter.set(`${t.hot}:${t.counter}`, (perCounter.get(`${t.hot}:${t.counter}`) ?? 0) + 1);
  }
  const counters = [...perCounter.values()];
  const bytes = w.files.reduce((s, f) => s + Buffer.byteLength(f.text), 0);
  const r = o.run;
  const n = (x: number): string => x.toLocaleString("en-US");
  return [
    "contention-scale plan: nothing is sent",
    `  deployment   ${o.base} (admin token ${token}; Cloudflare Access headers ${access ? "set" : "not set"})`,
    `  colony       ${r.colony}: created with region depth ${r.regionDepth}, a pool of ${n(r.pool)} workspaces and review off; ${r.keep ? "kept at the end with its agents stopped (--keep)" : "deleted at the end"}`,
    `  repository   ${n(w.files.length)} files, ${n(bytes)} bytes: ${w.options.hot} hot files (${hotPath(0)} ...: ${w.options.registry} registry names and ${w.options.counters} counters each), ${n(w.options.modules)} modules${w.options.certTest ? ", test/contention.test.ts for certification" : ""}`,
    `  seed         ${seedChanges(w.files).length} inline changes by one scripted agent`,
    `  tasks        ${n(w.tasks.length)} (seed ${w.options.seed}): ${TASK_KINDS.map((k) => `${n(split[k])} ${k}`).join(", ")}; ${n(Math.min(...perHot))} to ${n(Math.max(...perHot))} per hot file; ${counters.length > 0 ? `${n(Math.min(...counters))} to ${n(Math.max(...counters))} increments per counter` : "no increments"}`,
    `  agents       ${n(r.agents)} synthetic agents started over ${r.rampS} s; no new work after ${r.timeoutS} s, changes in flight waited on ${r.drainS} s more; outcomes from the live feed${r.feed ? "" : " (off: polling)"}`,
    "  steps        GET /api/about (flags; FT_INLINE required) > POST /api/colonies > review off > seed > agents declare (assignedTo), take, read with git, propose inline, redo on return > wait for lineage notes > check the final trunk with stock git > metrics > delete",
    `  results      ${relative(REPO_ROOT, outDir) || "."}/ (README.md, contention-scale-n${r.agents}.json, run-n${r.agents}.log)`,
  ].join("\n");
}

async function main(): Promise<number> {
  let o: CliOptions;
  let w: Workload;
  try {
    o = parseCli(process.argv.slice(2));
    w = generate(o.workload);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 2;
  }
  const started = new Date();
  const outDir = o.out ?? resultsDir(started.toISOString().slice(0, 10));
  let cfg;
  try {
    cfg = deploymentConfig(o.base);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 2;
  }
  const secrets = secretsOf(cfg);
  const scrub = (s: string): string => secrets.reduce((t, x) => t.split(x).join("<redacted>"), s);
  if (o.plan) {
    console.log(planText(o, w, tokenSource(process.env, !!cfg.token), !!cfg.headers, outDir));
    return 0;
  }
  if (!cfg.token) {
    console.error(`no admin token for ${o.base}: ${tokenSource(process.env, false)}`);
    return 2;
  }
  if (PRODUCTION_HOSTS.has(new URL(cfg.url).hostname) && !o.allowProduction) {
    console.error(`${cfg.url} is production: run this on staging, or pass --allow-production`);
    return 2;
  }
  const lines: string[] = [];
  const log = (s: string): void => {
    const line = scrub(`[${new Date().toISOString().slice(11, 19)}] ${s}`);
    lines.push(line);
    console.error(line);
  };
  const command = `node packages/bench/src/scenarios/contention-scale.ts ${process.argv.slice(2).join(" ")}`;
  log(`contention-scale: ${command}`);
  const dir = join(tmpdir(), `ft-contention-${o.run.colony}-${process.pid}`);
  const trunk = new GitTrunk(dir);
  try {
    const report = await runContention(w, o.run, { cfg, trunk, parse: await esbuildParser(), log });
    const r = report.run;
    log(
      `${r.landedTasks} of ${r.tasks} tasks landed in ${r.commits} commits (${r.landingsPerMin?.toFixed(1) ?? "?"} landings and ${r.changesPerMin?.toFixed(1) ?? "?"} changes a minute); ` +
        `propose to landed p50 ${report.timeToLandMs.p50 ?? "?"} ms, p95 ${report.timeToLandP95Ms ?? "?"} ms; ${report.returns.total} came back; peak holders ${report.holders.peak} (${report.holders.peakOneHot} on one hot file)`,
    );
    const passed = report.check?.passed === true;
    log(report.check ? (passed ? "ALL CHECKS PASSED" : "SOME CHECKS FAILED") : `THE CHECK DID NOT RUN: ${report.checkError ?? ""}`);
    const written = writeResults(outDir, { ...report, command, ...(o.note ? { runNote: o.note } : {}) }, `${lines.join("\n")}\n`, secrets);
    console.error(`wrote ${written.map((p) => relative(REPO_ROOT, p)).join(", ")}`);
    return passed ? 0 : 1;
  } catch (e) {
    log(`the run stopped: ${errorDetail(e)}`);
    return 1;
  } finally {
    trunk.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function isEntry(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntry()) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(errorDetail(e));
      process.exit(1);
    },
  );
}
