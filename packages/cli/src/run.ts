import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { ABOUT_REQUEST, buildRow, type AboutLike } from "./about.ts";
import type { Command, GlobalFlags } from "./args.ts";
import { helpText, parseCommand } from "./args.ts";
import { ApiError, VERSION, accessHeaders, asArray, colonyPath, isProposalRef, liveUrl, pickColony, planRequest, resolveBaseUrl, revertRequest, send } from "./api.ts";
import type { ApiRequest, HttpConfig } from "./api.ts";
import { configPath, parseEnvFile, withConfig } from "./config.ts";
import {
  colorEnabled,
  colors,
  eventsFromMessage,
  formatAgents,
  formatAmend,
  formatColonies,
  formatDelete,
  formatDirect,
  formatEscalationAnswer,
  formatEscalations,
  formatEvent,
  formatIntentShow,
  formatPolicy,
  formatRetract,
  formatRevert,
  formatReview,
  formatStatus,
  formatStop,
  formatVaccinate,
  formatCertify,
  formatVerify,
  formatWhy,
  formatWithdraw,
  num,
  policyRows,
  protectionLines,
  verifyFailed,
} from "./format.ts";
import type {
  AgentRow,
  AmendResult,
  ColonyRow,
  Colors,
  DecidePolicyView,
  DeleteResult,
  DirectResult,
  EscalationResult,
  IntentShowResult,
  RetractResult,
  RevertResult,
  SnapshotLike,
  StopResult,
  WithdrawResult,
} from "./format.ts";
import { formatGuide, formatLessonDecision, type GuideViewLike } from "./guide.ts";
import { extractSpec, planNew } from "./spec.ts";
import { formatMegafile } from "./megafile.ts";
import { formatPause } from "./pause.ts";
import { formatSpendCap } from "./spendcap.ts";
import { formatSilentTtl, type SilentTtlView } from "./closure.ts";
import { formatImpact } from "./impact.ts";
import { autonomyLine, formatImmune } from "./immune.ts";
import { decidesLines, decidesRequest } from "./gateline.ts";
import { signatureFailed } from "./signatures.ts";
import { checkClone, colorLines, keysReader, nodeGit, rootRow, type CloneVerify } from "./clonecheck.ts";
import { firstLandings, readRows, testsRequest } from "./tests.ts";
import type { IntentBody, SpecPolicy } from "./spec.ts";
import type { GuideLesson, Intent, Landing, LandingTests, LineageNote, Proposal, Rule } from "@fire_trident/core";
import { connectInfo, connectText } from "./connect.ts";
import { retestText } from "./reviewtests.ts";
import { lifecycleRequest } from "./strip.ts";
import { readStdin, runHook, type HookCommand } from "./hook.ts";

/** Everything the CLI touches outside itself, injectable for tests. */
export interface Io {
  env: Record<string, string | undefined>;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  /** Write to stderr without a newline (progress); omitted when not a terminal. */
  progress?: (text: string) => void;
  isTTY: boolean;
  fetch: typeof fetch;
  readFile: (path: string) => Promise<string>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  WebSocket: typeof WebSocket;
  /** Register a Ctrl-C handler. */
  onInterrupt: (fn: () => void) => void;
  /** `ft hook check`: the hook's input, which Claude Code writes to stdin (hook.ts); the process's stdin when absent. */
  stdin?: () => Promise<string>;
  /** The working directory `ft hook` resolves paths against; the process's when absent. */
  cwd?: () => string;
}

/** The real process I/O. */
export function nodeIo(): Io {
  const tty = process.stdout.isTTY === true;
  const io: Io = {
    env: process.env,
    stdout: (line) => void process.stdout.write(`${line}\n`),
    stderr: (line) => void process.stderr.write(`${line}\n`),
    isTTY: tty,
    fetch: globalThis.fetch,
    readFile: (p) => readFile(p, "utf8"),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    WebSocket: globalThis.WebSocket,
    onInterrupt: (fn) => void process.once("SIGINT", fn),
  };
  if (process.stderr.isTTY) io.progress = (text) => void process.stderr.write(text);
  return io;
}

interface Ctx {
  io: Io;
  flags: GlobalFlags;
  http: HttpConfig;
  c: Colors;
  by: string;
}

function resolveUser(env: Record<string, string | undefined>): string {
  if (env.FT_USER?.trim()) return env.FT_USER.trim();
  try {
    return userInfo().username || "human";
  } catch {
    return "human";
  }
}

/** Run `ft` with these arguments. Returns the exit code: 0 ok, 1 failure, 2 usage error. */
export async function main(argv: readonly string[], io: Io = nodeIo()): Promise<number> {
  const parsed = parseCommand(argv);
  // The Claude Code hook's check (hook.ts) answers 0 whatever its arguments: it never stands in the way of an edit.
  if (!parsed.ok && argv.includes("hook") && argv[argv.indexOf("hook") + 1] === "check") return 0;
  if (!parsed.ok) {
    io.stderr(`ft: ${parsed.error}`);
    if (parsed.topic) io.stderr(`\n${helpText(parsed.topic)}`);
    return 2;
  }
  const { command, flags } = parsed;
  if (command.name === "help") {
    io.stdout(helpText(command.topic));
    return 0;
  }
  if (command.name === "version") {
    io.stdout(VERSION);
    return 0;
  }
  if (command.name === "hook") return hook(command, flags.url, io);
  try {
    const env = await loadEnv(io, flags.url);
    const token = env.FT_TOKEN?.trim();
    const http: HttpConfig = { baseUrl: resolveBaseUrl(flags.url, env), fetch: io.fetch };
    if (token) http.token = token;
    const access = accessHeaders(env);
    if (access) http.headers = access;
    const ctx: Ctx = { io, flags, http, c: colors(colorEnabled(env, io.isTTY, flags.json)), by: resolveUser(env) };
    return await execute(command, ctx);
  } catch (e) {
    if (e instanceof ApiError) {
      io.stderr(`ft: ${e.message}`);
      return 1;
    }
    io.stderr(`ft: ${(e as Error).message ?? String(e)}`);
    return 1;
  }
}

/** The environment plus ~/.config/firetrident/env when FT_URL or FT_TOKEN is unset (see config.ts). A missing file is fine. */
async function loadEnv(io: Io, flagUrl: string | undefined): Promise<Record<string, string | undefined>> {
  if (io.env.FT_URL?.trim() && io.env.FT_TOKEN?.trim()) return io.env;
  const path = configPath(io.env);
  if (!path) return io.env;
  let text: string;
  try {
    text = await io.readFile(path);
  } catch {
    return io.env;
  }
  return withConfig(io.env, parseEnvFile(text), flagUrl);
}

/**
 * `ft hook` (hook.ts): local settings, and for check one read with the agent's own credentials (FT_MCP_TOKEN or
 * FT_RESUME_KEY), never FT_TOKEN. Check answers 0 whatever happens.
 */
async function hook(cmd: HookCommand, url: string | undefined, io: Io): Promise<number> {
  try {
    const env = await loadEnv(io, url);
    return await runHook(cmd, url, { env, stdout: io.stdout, stderr: io.stderr, fetch: io.fetch, stdin: io.stdin ?? (() => readStdin()), cwd: io.cwd ?? (() => process.cwd()) });
  } catch (e) {
    if (cmd.action === "check") return 0;
    io.stderr(`ft: ${(e as Error).message ?? String(e)}`);
    return 1;
  }
}

function printJson(ctx: Ctx, value: unknown): void {
  ctx.io.stdout(JSON.stringify(value, null, 2));
}

function dryRun(ctx: Ctx, requests: ApiRequest[]): number {
  const auth = ctx.http.token ? "Bearer ***" : undefined;
  const shown = requests.map((r) => ({ method: r.method, url: ctx.http.baseUrl + r.path.replaceAll("%3Ccolony%3E", "<colony>"), ...(auth ? { authorization: auth } : {}), ...(r.body !== undefined ? { body: r.body } : {}) }));
  printJson(ctx, shown.length === 1 ? shown[0] : shown);
  return 0;
}

/**
 * `ft verify` on a git clone (clonecheck.ts): stock git in the clone, no server; only --keys reads a URL or a file.
 * Exits 1 when a check fails, 2 when the clone or the keys cannot be read.
 */
async function verifyClone(cmd: CloneVerify, ctx: Ctx): Promise<number> {
  let report: Awaited<ReturnType<typeof checkClone>>;
  try {
    report = await checkClone(cmd, nodeGit(cmd.dir ?? process.cwd()), keysReader(ctx.io.fetch, ctx.io.readFile));
  } catch (e) {
    ctx.io.stderr(`ft: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  if (ctx.flags.json) printJson(ctx, { lines: report.lines, failed: report.failed });
  else for (const line of colorLines(report, ctx.c)) ctx.io.stdout(line);
  return report.failed ? 1 : 0;
}

async function tryGet<T>(ctx: Ctx, req: ApiRequest): Promise<T | undefined> {
  try {
    return await send<T>(ctx.http, req);
  } catch {
    return undefined;
  }
}

async function execute(cmd: Command, ctx: Ctx): Promise<number> {
  if (cmd.name === "watch") return watch(cmd, ctx);
  if (cmd.name === "new") return newColony(cmd, ctx);
  if (cmd.name === "revert") return revert(cmd, ctx);
  if (cmd.name === "policy") return policy(cmd, ctx);
  if (cmd.name === "verify-clone") return verifyClone(cmd, ctx);
  // Connect your agent (core/connect.ts): built from the server URL, nothing sent.
  if (cmd.name === "connect") return connect(cmd, ctx);
  const req = planRequest(cmd, ctx.by);
  if (!req) throw new Error(`nothing to do for ${cmd.name}`);
  if (ctx.flags.dryRun) return dryRun(ctx, [req]);
  const { io, c } = ctx;

  switch (cmd.name) {
    case "import":
      return importColony(cmd, req, ctx);
    case "status": {
      const snap = await send<SnapshotLike>(ctx.http, req);
      // An unexpected shape is shown raw rather than crashing the summary.
      if (ctx.flags.json || !snap?.colony?.id) printJson(ctx, snap);
      else {
        io.stdout(formatStatus(snap, c, io.now()));
        // The paths only a person may change, read after the summary (a server that predates them shows none).
        const rows = policyRows(await tryGet<DecidePolicyView>(ctx, { method: "GET", path: colonyPath(cmd.colony, "/decide/policy") }), c);
        if (rows.length > 0) io.stdout(rows.join("\n"));
        // Earned autonomy in one line (immune.ts); a server that predates the immune report shows none.
        const autonomy = autonomyLine(await tryGet<unknown>(ctx, { method: "GET", path: colonyPath(cmd.colony, "/immune") }), cmd.colony, c);
        if (autonomy) io.stdout(autonomy);
        // How the colony decides (gateline.ts): its preset and the last 30 days by what confirmed them; none from an older server.
        for (const line of decidesLines(await tryGet<unknown>(ctx, decidesRequest(cmd.colony)), c)) io.stdout(line);
        // The colony's root commit, which pins a clone (clonecheck.ts); a server that predates GET /root shows none.
        const root = rootRow(await tryGet<unknown>(ctx, { method: "GET", path: colonyPath(cmd.colony, "/root") }), c);
        if (root) io.stdout(root);
        // The build the server runs, last (about.ts); a server that predates GET /api/about shows none.
        const build = buildRow(await tryGet<AboutLike>(ctx, ABOUT_REQUEST), ctx.http.baseUrl, c, io.now());
        if (build) io.stdout(build);
      }
      return 0;
    }
    case "rule-add":
    case "rule-import-boundary": {
      const res = await send<{ rule?: Rule; violations?: number; intents?: number }>(ctx.http, req);
      if (ctx.flags.json) printJson(ctx, res);
      else {
        const id = res?.rule?.id ?? "rule";
        const v = typeof res?.violations === "number" ? res.violations : undefined;
        const n = typeof res?.intents === "number" ? res.intents : undefined;
        io.stdout(`${c.green("✓")} ${c.bold(id)} added ${c.dim(`(${cmd.name === "rule-add" ? "forbid-pattern" : "forbid-import"}, approved by ${cmd.by ?? ctx.by})`)}`);
        if (v !== undefined) io.stdout(`  ${v === 0 ? c.green("0 violations") : c.yellow(`${num(v)} violation${v === 1 ? "" : "s"}`)}${n !== undefined ? ` → ${num(n)} intent${n === 1 ? "" : "s"} in the field` : ""}`);
        if (v) io.stdout(c.dim(`  Next: ft swarm ${cmd.colony} --agents 50   then   ft watch ${cmd.colony}`));
      }
      return 0;
    }
    case "swarm": {
      const res = await send<unknown>(ctx.http, req, 60_000);
      if (ctx.flags.json) printJson(ctx, res);
      else {
        const list = asArray<{ id?: string }>(res, ["agents", "spawned"]);
        const count = list.length || (typeof (res as { spawned?: unknown })?.spawned === "number" ? (res as { spawned: number }).spawned : cmd.agents);
        io.stdout(`${c.green("✓")} ${num(count)} ${cmd.kind ?? "internal"} agent${count === 1 ? "" : "s"} joining ${c.bold(cmd.colony)}${cmd.model ? c.dim(` (${cmd.model})`) : ""}`);
        io.stdout(c.dim(`  They self-assign from the field. Watch: ft watch ${cmd.colony}`));
      }
      return 0;
    }
    case "why": {
      const snapReq = planRequest({ name: "status", colony: cmd.colony }, ctx.by) as ApiRequest;
      const [res, snap] = await Promise.all([send<unknown>(ctx.http, req), ctx.flags.json ? undefined : tryGet<SnapshotLike>(ctx, snapReq)]);
      if (ctx.flags.json) {
        printJson(ctx, res);
        return 0;
      }
      const entries = asArray<{ landing: Landing; note: LineageNote }>(res, ["lineage", "entries", "landings"]);
      const target: { path: string; line?: number } = { path: cmd.path };
      if (cmd.line !== undefined) target.line = cmd.line;
      const why: { intents?: Intent[]; rules?: Rule[]; tests?: Record<string, LandingTests>; greenSha?: string; landings?: Landing[] } = {};
      if (snap?.intents) why.intents = snap.intents;
      if (snap?.rules) why.rules = snap.rules;
      // The lifecycle strip places a landing without a test row by the newest green commit among the recent landings (strip.ts).
      if (typeof snap?.colony?.greenSha === "string" && snap.colony.greenSha) why.greenSha = snap.colony.greenSha;
      if (Array.isArray(snap?.recentLandings)) why.landings = snap.recentLandings;
      // The newest landings' test rows (tests.ts): public reads the colony computes once per certified commit.
      const tests = await readRows(firstLandings(entries, cmd.line), (id) => send<unknown>(ctx.http, testsRequest(cmd.colony, id), 15_000));
      if (Object.keys(tests).length > 0) why.tests = tests;
      io.stdout(formatWhy(target, entries, why, c, io.now()));
      return 0;
    }
    case "impact": {
      // The trunk writer may build its import index on the first read: allow for it.
      const res = await send<unknown>(ctx.http, req, 60_000);
      if (ctx.flags.json) printJson(ctx, res);
      else io.stdout(formatImpact(cmd.colony, res, c, io.now()));
      return 0;
    }
    case "verify": {
      // Reads the trunk repository's notes: allow for a slow repository.
      const res = await send<unknown>(ctx.http, req, 60_000);
      if (ctx.flags.json) printJson(ctx, res);
      else io.stdout(formatVerify(cmd.colony, res, c, io.now()));
      // A bad signature (signatures.ts) fails it too.
      return verifyFailed(res) || signatureFailed(res) ? 1 : 0;
    }
    case "review-list": {
      const snapReq = planRequest({ name: "status", colony: cmd.colony }, ctx.by) as ApiRequest;
      const [res, snap] = await Promise.all([send<unknown>(ctx.http, req), ctx.flags.json ? undefined : tryGet<SnapshotLike>(ctx, snapReq)]);
      if (ctx.flags.json) printJson(ctx, res);
      else io.stdout(formatReview(asArray<Proposal>(res, ["proposals", "queue"]), snap?.intents, c, io.now(), { diff: cmd.diff, colony: cmd.colony }));
      return 0;
    }
    case "review-retest": {
      const res = await send<unknown>(ctx.http, req);
      if (ctx.flags.json) printJson(ctx, res);
      else io.stdout(retestText(cmd.proposalId, cmd.colony, res, c));
      return 0;
    }
    case "review-decide": {
      const res = await send<unknown>(ctx.http, req);
      if (ctx.flags.json) printJson(ctx, res ?? { ok: true });
      else {
        const verb = { approve: c.green("Approved"), reject: c.red("Rejected"), return: c.yellow("Returned") }[cmd.decision];
        io.stdout(`${verb} ${c.bold(cmd.proposalId)}${cmd.decision === "approve" ? "" : `: ${cmd.reason}`}`);
        if (cmd.decision === "reject") io.stdout(c.dim("  The rejection is recorded; it can mint an antibody for similar changes."));
        if (cmd.decision === "return") io.stdout(c.dim("  Sent back to its agent with your reason."));
      }
      return 0;
    }
    case "colonies": {
      const res = await send<unknown>(ctx.http, req, 60_000);
      if (ctx.flags.json) printJson(ctx, res);
      else io.stdout(formatColonies(asArray<ColonyRow>(res, ["colonies"]), c, io.now()));
      return 0;
    }
    case "agents": {
      const res = await send<unknown>(ctx.http, req, 60_000);
      if (ctx.flags.json) printJson(ctx, res);
      else io.stdout(formatAgents(cmd.colony, asArray<AgentRow>(res, ["agents"]), c, io.now()));
      return 0;
    }
    case "stop": {
      const res = await send<StopResult>(ctx.http, req, 120_000);
      if (ctx.flags.json) printJson(ctx, res);
      else io.stdout(formatStop(cmd.colony, cmd.agentId, res ?? {}, c));
      return 0;
    }
    case "delete": {
      const res = await send<DeleteResult>(ctx.http, req, 300_000);
      if (ctx.flags.json) printJson(ctx, res);
      else io.stdout(formatDelete(cmd.colony, res ?? {}, c));
      return 0;
    }
    case "vaccinate": {
      const res = await send<unknown>(ctx.http, req, 120_000);
      if (ctx.flags.json) printJson(ctx, res);
      else io.stdout(formatVaccinate(cmd.colony, cmd.count, res, c));
      return 0;
    }
    case "immune": {
      const res = await send<unknown>(ctx.http, req, 60_000);
      if (ctx.flags.json) printJson(ctx, res);
      else io.stdout(formatImmune(cmd.colony, res, c, io.now()));
      return 0;
    }
    case "certify": {
      const res = await send<unknown>(ctx.http, req, 60_000);
      if (ctx.flags.json) printJson(ctx, res);
      else io.stdout(formatCertify(cmd.colony, cmd.action, res, c, io.now()));
      return 0;
    }
    case "intent-amend": {
      const res = await send<AmendResult>(ctx.http, req, 60_000);
      if (ctx.flags.json) printJson(ctx, res);
      else io.stdout(formatAmend(cmd.intentId, res ?? {}, c));
      return 0;
    }
    case "intent-withdraw": {
      const res = await send<WithdrawResult>(ctx.http, req, 60_000);
      if (ctx.flags.json) printJson(ctx, res);
      else io.stdout(formatWithdraw(cmd.intentId, cmd.reason, res ?? {}, c));
      return 0;
    }
    case "intent-show": {
      // Its lifecycle strip beside it (strip.ts): a public read an older server does not have, so a failure leaves it out.
      const [res, lifecycle] = await Promise.all([send<IntentShowResult>(ctx.http, req), tryGet<unknown>(ctx, lifecycleRequest(cmd.colony, cmd.intentId))]);
      if (res && lifecycle !== undefined) res.lifecycle = lifecycle;
      if (ctx.flags.json) printJson(ctx, res);
      else io.stdout(formatIntentShow(res ?? {}, c, io.now()));
      return 0;
    }
    case "rule-retract": {
      const res = await send<RetractResult>(ctx.http, req, 120_000);
      if (ctx.flags.json) printJson(ctx, res);
      else io.stdout(formatRetract(cmd.ruleId, cmd.reason, res ?? {}, c));
      return 0;
    }
    case "direct": {
      const res = await send<DirectResult>(ctx.http, req, 60_000);
      if (ctx.flags.json) printJson(ctx, res);
      else io.stdout(formatDirect(cmd.agentId, res ?? {}, c));
      return res?.delivery === "failed" ? 1 : 0;
    }
    case "escalations": {
      const res = await send<unknown>(ctx.http, req);
      if (ctx.flags.json) printJson(ctx, res);
      else io.stdout(formatEscalations(cmd.colony, asArray<Partial<Intent>>(res, ["intents", "escalations"]), c, io.now()));
      return 0;
    }
    case "escalation": {
      const res = await send<EscalationResult>(ctx.http, req, 60_000);
      if (ctx.flags.json) printJson(ctx, res);
      else io.stdout(formatEscalationAnswer(cmd.intentId, cmd.decision, res ?? {}, c));
      return 0;
    }
    case "guide": {
      const res = await send<GuideViewLike>(ctx.http, req);
      if (ctx.flags.json) printJson(ctx, res);
      else io.stdout(formatGuide(cmd.colony, res ?? {}, c, io.now()));
      return 0;
    }
    case "guide-decide": {
      const res = await send<Partial<GuideLesson>>(ctx.http, req, 60_000);
      if (ctx.flags.json) printJson(ctx, res);
      else io.stdout(formatLessonDecision(cmd.lessonId, cmd.action, res ?? {}, c));
      return 0;
    }
    case "megafile": {
      const res = await send<unknown>(ctx.http, req, 60_000);
      if (ctx.flags.json) printJson(ctx, res);
      else io.stdout(formatMegafile(cmd, res, c, io.now()));
      return 0;
    }
    case "pause":
    case "resume": {
      // Pausing waits for the trunk writer's cycle in flight (up to 15 s); a deployment pause tells every colony.
      const res = await send<unknown>(ctx.http, req, 60_000);
      if (ctx.flags.json) printJson(ctx, res);
      else io.stdout(formatPause(cmd, res, c));
      return 0;
    }
    case "spend-cap": {
      const res = await send<unknown>(ctx.http, req, 60_000);
      if (ctx.flags.json) printJson(ctx, res);
      else io.stdout(formatSpendCap(cmd, res, c));
      return 0;
    }
    default:
      throw new Error(`unhandled command ${cmd.name}`);
  }
}

/** Retryable while an import is still settling. */
const NOT_READY = new Set([404, 409, 423, 425, 429, 500, 502, 503, 504]);

/** How often `ft watch` pings the live socket (the server answers "pong"). */
const KEEPALIVE_MS = 30_000;

async function importColony(cmd: Extract<Command, { name: "import" }>, req: ApiRequest, ctx: Ctx): Promise<number> {
  const { io, c } = ctx;
  const res = await send<unknown>(ctx.http, req, 120_000);
  const colony = pickColony(res);
  if (!colony) {
    if (ctx.flags.json) printJson(ctx, res);
    else io.stdout(`Import started, but the server did not return a colony id:\n${JSON.stringify(res, null, 2)}`);
    return 0;
  }
  if (!ctx.flags.json) io.stdout(`${c.green("✓")} Importing ${cmd.url}${cmd.branch ? c.dim(` (${cmd.branch})`) : ""} as ${c.bold(cmd.colonyName)} ${c.dim(colony.id)}`);
  if (!cmd.wait) {
    if (ctx.flags.json) printJson(ctx, res);
    else io.stdout(c.dim(`  Check progress: ft status ${colony.id}`));
    return 0;
  }

  const statusReq = planRequest({ name: "status", colony: colony.id }, ctx.by) as ApiRequest;
  const started = io.now();
  const deadline = started + cmd.timeoutSec * 1000;
  let snap: SnapshotLike | undefined;
  let lastError = "";
  for (;;) {
    try {
      const s = await send<SnapshotLike>(ctx.http, statusReq);
      if (s?.colony && (s.files?.length ?? 0) > 0) {
        snap = s;
        break;
      }
    } catch (e) {
      if (!(e instanceof ApiError) || (e.status !== 0 && !NOT_READY.has(e.status))) throw e;
      lastError = e.message;
    }
    if (io.now() >= deadline) {
      io.progress?.("\r\u001b[K");
      io.stderr(`ft: colony ${colony.id} was not ready after ${cmd.timeoutSec}s${lastError ? ` (last error: ${lastError})` : ""}. Check later: ft status ${colony.id}`);
      return 1;
    }
    io.progress?.(`\r\u001b[K  ${c.dim(`importing… ${Math.round((io.now() - started) / 1000)}s`)}`);
    await io.sleep(2000);
  }
  io.progress?.("\r\u001b[K");
  if (ctx.flags.json) {
    printJson(ctx, snap);
    return 0;
  }
  io.stdout(formatStatus(snap, c, io.now()));
  io.stdout(c.dim(`\n  Next: ft rule add ${colony.id} --pattern <regex> --hint <text> --description <text>`));
  io.stdout(c.dim(`        ft watch ${colony.id}`));
  return 0;
}

/**
 * `ft revert`: one call for a landing or a trunk commit. For a proposal (prp_...), its landing is read
 * first (GET /proposals/:pid) and only that proposal of it is undone.
 */
async function revert(cmd: Extract<Command, { name: "revert" }>, ctx: Ctx): Promise<number> {
  const { io, c } = ctx;
  const proposal = isProposalRef(cmd.ref);
  const lookup: ApiRequest = { method: "GET", path: colonyPath(cmd.colony, `/proposals/${encodeURIComponent(cmd.ref)}`) };
  if (ctx.flags.dryRun) {
    // The landing is known once the proposal is read; the dry run names it.
    const later = revertRequest(cmd, ctx.by, "<landing>");
    return dryRun(ctx, proposal ? [lookup, { ...later, path: later.path.replace("%3Clanding%3E", "<landing>") }] : [revertRequest(cmd, ctx.by)]);
  }
  let landing = cmd.ref;
  if (proposal) {
    const p = await send<Partial<Proposal> | null>(ctx.http, lookup);
    if (p?.status !== "landed" || !p.landingId) throw new Error(`${cmd.ref} has not landed${p?.status ? ` (it is ${p.status})` : ""}, so there is nothing to revert`);
    landing = p.landingId;
  }
  const res = await send<RevertResult | null>(ctx.http, revertRequest(cmd, ctx.by, landing));
  if (ctx.flags.json) printJson(ctx, res ?? { ok: true });
  else io.stdout(formatRevert(cmd.ref, cmd.reason, res ?? {}, c));
  // A server that predates reverting one proposal ignores it and undoes the whole landing: say so.
  if (proposal && res?.proposal !== cmd.ref) {
    io.stderr(`ft: the server undid all of ${landing}, not only ${cmd.ref}: it predates reverting one proposal. To put ${landing} back: ft revert ${cmd.colony} ${res?.landing?.id ?? "<the revert's landing>"} --reason "<why>"`);
    return 1;
  }
  return 0;
}

/**
 * `ft connect [<colony>]`: each MCP client's command and configuration for the server ft talks to, the read-only
 * server first (core/connect.ts, the same source as the /connect page). Sends nothing.
 */
function connect(cmd: Extract<Command, { name: "connect" }>, ctx: Ctx): number {
  const info = connectInfo(ctx.http.baseUrl, cmd.colony ?? null);
  if (ctx.flags.json) printJson(ctx, info);
  else ctx.io.stdout(connectText(info));
  return 0;
}

/**
 * `ft policy`: show the decide policy, or change it. Adding or removing protected paths reads the
 * colony's list first and writes it back whole (the policy route sets fields, not list entries).
 */
async function policy(cmd: Extract<Command, { name: "policy" }>, ctx: Ctx): Promise<number> {
  const { io, c } = ctx;
  const read: ApiRequest = { method: "GET", path: colonyPath(cmd.colony, "/decide/policy") };
  const proof = cmd.commentProof !== undefined ? { commentProof: cmd.commentProof } : {};
  const single = planRequest(cmd, ctx.by);
  // The silent-agent limit (closure.ts): its own route and its own answer.
  if (cmd.silentTtl !== undefined && single) {
    if (ctx.flags.dryRun) return dryRun(ctx, [single]);
    const res = await send<SilentTtlView | null>(ctx.http, single);
    if (ctx.flags.json) printJson(ctx, res);
    else io.stdout(formatSilentTtl(cmd.colony, res ?? {}, c));
    return typeof res?.ms === "number" ? 0 : 1;
  }
  if (single) {
    if (ctx.flags.dryRun) return dryRun(ctx, [single]);
    const res = await send<DecidePolicyView | null>(ctx.http, single);
    if (ctx.flags.json) printJson(ctx, res);
    else io.stdout(formatPolicy(cmd.colony, res ?? {}, c));
    if (cmd.commentProof !== undefined && res?.commentProof !== cmd.commentProof) {
      io.stderr("ft: the server did not change the comment-only proof: it predates it");
      return 1;
    }
    return 0;
  }
  if (ctx.flags.dryRun) {
    // The list is known once it is read; the dry run says what the second call sends.
    const change = [cmd.protect.length > 0 ? `plus ${cmd.protect.join(", ")}` : "", cmd.unprotect.length > 0 ? `without ${cmd.unprotect.join(", ")}` : ""].filter(Boolean).join(", ");
    return dryRun(ctx, [read, { method: "POST", path: read.path, body: { protectedPaths: `<the current list, ${change}>`, ...proof } }]);
  }
  const current = await send<DecidePolicyView | null>(ctx.http, read);
  const list = Array.isArray(current?.protectedPaths) ? current.protectedPaths : null;
  if (list === null) throw new Error("the server does not keep protected paths: it predates them");
  const protectedPaths = [...list.filter((g) => !cmd.unprotect.includes(g)), ...cmd.protect.filter((g) => !list.includes(g))];
  const res = await send<DecidePolicyView | null>(ctx.http, { method: "POST", path: read.path, body: { protectedPaths, ...proof } });
  if (ctx.flags.json) printJson(ctx, res);
  else {
    io.stdout(formatPolicy(cmd.colony, res ?? {}, c));
    for (const g of cmd.unprotect.filter((x) => !list.includes(x))) io.stdout(c.dim(`  ${g} was not protected`));
    // Newly protected globs reach changes already cleared to land: which were stopped, which had already landed.
    for (const line of protectionLines(cmd.colony, res?.protection, c)) io.stdout(line);
  }
  return 0;
}

/**
 * Set a spec's policy on the colony `ft new` just created and check that the server kept every field.
 * A failed call, or a server that predates a field, stops `ft new` here, before any rule or intent.
 */
async function newColonyPolicy(ctx: Ctx, req: ApiRequest, declared: SpecPolicy, colony: string): Promise<DecidePolicyView | null> {
  let kept: DecidePolicyView | null = null;
  let problem = "";
  try {
    kept = await send<DecidePolicyView | null>(ctx.http, req);
    const paths = Array.isArray(kept?.protectedPaths) ? kept.protectedPaths : null;
    const missing = (declared.protectedPaths ?? []).filter((g) => !paths?.includes(g));
    if (declared.protectedPaths && paths === null) problem = "the server does not keep protected paths: it predates them";
    else if (missing.length > 0) problem = `the server did not keep the protected paths ${missing.join(", ")}`;
    else if (declared.commentProof !== undefined && kept?.commentProof !== declared.commentProof) problem = "the server did not set the comment-only proof: it predates it";
  } catch (e) {
    problem = (e as Error).message;
  }
  if (problem) throw new Error(`${problem}. Colony ${colony} was created; its rules and intents were not declared (ft delete ${colony} --yes removes it)`);
  return kept;
}

async function newColony(cmd: Extract<Command, { name: "new" }>, ctx: Ctx): Promise<number> {
  const { io, c } = ctx;
  const by = cmd.by ?? ctx.by;
  const markdown = await io.readFile(cmd.specPath);
  const spec = extractSpec(markdown);
  const name = cmd.colonyName ?? spec.name;
  const opts = { markdown, source: cmd.specPath };
  if (ctx.flags.dryRun) {
    const plan = planNew(spec, "<colony>", by, name, opts);
    // Parents are only known once created; the dry run names them by position.
    const intents = plan.intents.map(({ parentIndex, ...req }) => (parentIndex === undefined ? req : { ...req, body: { ...(req.body as object), parentId: `<intent ${parentIndex + 1}>` } }));
    return dryRun(ctx, [plan.create, ...(plan.policy ? [plan.policy] : []), ...plan.rules, ...intents]);
  }

  const created = await send<unknown>(ctx.http, planNew(spec, "<colony>", by, name, opts).create, 120_000);
  const colony = pickColony(created);
  if (!colony) throw new Error(`the server did not return a colony id: ${JSON.stringify(created)}`);
  const plan = planNew(spec, colony.id, by, name, opts);
  if (!ctx.flags.json) io.stdout(`${c.green("✓")} Colony ${c.bold(name)} ${c.dim(colony.id)} created from ${cmd.specPath}`);

  // The policy holds before any rule or intent exists, so no agent can change a protected path without a person.
  let policy: DecidePolicyView | null = null;
  if (plan.policy && spec.policy) {
    const declared = spec.policy;
    policy = await newColonyPolicy(ctx, plan.policy, declared, colony.id);
    if (!ctx.flags.json) {
      const parts: string[] = [];
      if (declared.protectedPaths) parts.push(declared.protectedPaths.length > 0 ? `protects ${declared.protectedPaths.join(", ")} ${c.dim("(a person decides every change to them)")}` : "protects no paths");
      if (declared.commentProof !== undefined) parts.push(`comment-only proof ${declared.commentProof ? "on" : c.yellow("off")}`);
      io.stdout(`  ${c.green("✓")} policy ${parts.join(c.dim(" · "))}`);
    }
  }

  const rules: unknown[] = [];
  for (const req of plan.rules) {
    const res = await send<{ rule?: Rule }>(ctx.http, req);
    rules.push(res);
    if (!ctx.flags.json) io.stdout(`  ${c.green("✓")} rule ${res?.rule?.id ?? ""} ${c.dim((req.body as { description: string }).description)}`);
  }
  // Intents go out in dependency order, so each parent exists before the intents that build on it.
  const intents: Array<Partial<Intent>> = [];
  for (const { parentIndex, ...req } of plan.intents) {
    const body = req.body as IntentBody;
    const parent = parentIndex === undefined ? undefined : intents[parentIndex];
    const res = await send<Partial<Intent>>(ctx.http, parent?.id ? { ...req, body: { ...body, parentId: parent.id } } : req);
    intents.push(res ?? {});
    if (!ctx.flags.json) {
      const follows = parent?.title ? c.dim(` ← builds on "${parent.title}"`) : "";
      const contest = body.contest && body.contest > 1 ? c.dim(` · contest of ${body.contest}`) : "";
      io.stdout(`  ${c.green("✓")} intent ${res?.id ?? ""} ${c.dim(`p${body.priority}`)} ${body.title}${contest}${follows}`);
    }
  }
  if (ctx.flags.json) {
    printJson(ctx, plan.policy ? { colony: created, policy, rules, intents } : { colony: created, rules, intents });
    return 0;
  }
  const waves = new Map<number, number>();
  for (const req of plan.intents) {
    const p = (req.body as IntentBody).priority;
    waves.set(p, (waves.get(p) ?? 0) + 1);
  }
  const levels = [...waves.keys()].sort((a, b) => b - a);
  const widest = Math.max(...waves.values());
  const context = Math.max(0, ...plan.intents.map((r) => (r.body as IntentBody).why.length));
  io.stdout(
    `\n${num(plan.rules.length)} rule${plan.rules.length === 1 ? "" : "s"} and ${num(plan.intents.length)} intent${plan.intents.length === 1 ? "" : "s"} painted into the field, in ${num(levels.length)} wave${levels.length === 1 ? "" : "s"}` +
      `${levels.length > 1 ? ` (priority ${levels[0]} to ${levels[levels.length - 1]})` : ""}.`,
  );
  io.stdout(c.dim(`  Each intent carries the spec's contracts (${num(context)} characters at most); an agent waits for the files its intent builds on, then reads them.`));
  io.stdout(c.dim(`  Next: ft swarm ${colony.id} --agents ${Math.max(2, Math.min(50, widest))}   then   ft watch ${colony.id}`));
  return 0;
}

function watch(cmd: Extract<Command, { name: "watch" }>, ctx: Ctx): Promise<number> {
  const { io, c } = ctx;
  const url = liveUrl(ctx.http.baseUrl, cmd.colony);
  if (ctx.flags.dryRun) {
    printJson(ctx, { method: "GET", url, upgrade: "websocket", ...(ctx.http.token ? { authorization: "Bearer ***" } : {}) });
    return Promise.resolve(0);
  }
  const only = new Set(cmd.only);
  const WS = io.WebSocket;
  if (typeof WS !== "function") {
    io.stderr("ft: this Node.js has no global WebSocket; use Node 22 or newer");
    return Promise.resolve(1);
  }

  return new Promise<number>((resolve) => {
    let socket: WebSocket | undefined;
    let stopping = false;
    let everOpened = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The server only pushes; a quiet colony would let idle proxies drop the socket, so ping it.
    let keepalive: ReturnType<typeof setInterval> | undefined;
    const finish = (code: number) => {
      stopping = true;
      if (timer) clearTimeout(timer);
      if (keepalive) clearInterval(keepalive);
      resolve(code);
    };

    const emit = (text: string) => {
      for (const e of eventsFromMessage(text)) {
        if (only.size > 0 && !only.has(e.t)) continue;
        io.stdout(ctx.flags.json ? JSON.stringify(e) : formatEvent(e, c));
      }
    };

    const connect = () => {
      const init: WebSocketInit = {};
      const wsHeaders: Record<string, string> = { ...ctx.http.headers, ...(ctx.http.token ? { authorization: `Bearer ${ctx.http.token}` } : {}) };
      if (Object.keys(wsHeaders).length > 0) init.headers = wsHeaders;
      let ws: WebSocket;
      try {
        ws = new WS(url, init);
      } catch (e) {
        io.stderr(`ft: cannot open ${url}: ${(e as Error).message}`);
        finish(1);
        return;
      }
      socket = ws;
      ws.addEventListener("open", () => {
        everOpened = true;
        failures = 0;
        if (keepalive) clearInterval(keepalive);
        keepalive = setInterval(() => {
          try {
            ws.send("ping");
          } catch {
            // closing; the close handler reconnects
          }
        }, KEEPALIVE_MS);
        keepalive.unref?.();
        if (!ctx.flags.json) io.stderr(c.dim(`watching ${cmd.colony} at ${url}${only.size ? ` (only ${[...only].join(", ")})` : ""}. Ctrl-C to stop.`));
      });
      ws.addEventListener("message", (ev: MessageEvent) => {
        const data: unknown = ev.data;
        if (typeof data === "string") emit(data);
        else if (data instanceof ArrayBuffer) emit(new TextDecoder().decode(data));
        else if (data instanceof Blob) void data.text().then(emit);
      });
      ws.addEventListener("close", (ev: CloseEvent) => {
        if (keepalive) clearInterval(keepalive);
        if (stopping) return finish(0);
        failures++;
        if (!everOpened && failures >= 5) {
          io.stderr(`ft: could not connect to ${url} (close code ${ev.code}${ev.reason ? `: ${ev.reason}` : ""})`);
          return finish(1);
        }
        const delay = Math.min(10_000, 500 * 2 ** Math.min(failures, 5));
        if (!ctx.flags.json) io.stderr(c.dim(`disconnected (${ev.code}); reconnecting in ${(delay / 1000).toFixed(1)}s`));
        timer = setTimeout(connect, delay);
      });
      ws.addEventListener("error", () => {
        // A close event always follows; reconnect logic lives there.
      });
    };

    io.onInterrupt(() => {
      stopping = true;
      if (timer) clearTimeout(timer);
      if (socket && socket.readyState <= 1) {
        socket.close(1000, "client closed");
        setTimeout(() => finish(0), 1000).unref?.();
      } else finish(0);
    });
    connect();
  });
}
