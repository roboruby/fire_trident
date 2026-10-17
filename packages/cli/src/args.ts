import { parseArgs } from "node:util";
import type { AgentKind, ColonyEvent } from "@fire_trident/core";
import { CLONE_OPTIONS, cloneVerify, type CloneVerify } from "./clonecheck.ts";
import { parseSpendCap } from "./spendcap.ts";
import { isConnectColony } from "./connect.ts";
import { parseSilentTtl } from "./closure.ts";

/** Event types `ft watch --only` accepts. */
export const EVENT_TYPES: ReadonlyArray<ColonyEvent["t"]> = [
  "agent",
  "mark",
  "intent",
  "proposal",
  "landing",
  "decision",
  "sigma",
  "violations",
  "metric",
  "amended",
  "withdrawn",
  "retracted",
  "reverted",
  "directive",
  "escalation",
  "stuck",
  "status",
  "certify",
  "paused",
  "resumed",
];

/** What a human can do with an escalated proposal. */
export type ReviewDecision = "approve" | "reject" | "return";

/** What a human can answer to an agent's report that an intent cannot be done as written. */
export type EscalationDecision = "amend" | "withdraw" | "dismiss";

/** One parsed `ft` invocation. */
export type Command =
  | { name: "help"; topic?: string }
  | { name: "version" }
  | { name: "import"; url: string; colonyName: string; branch?: string; pool?: number; regionDepth?: number; wait: boolean; timeoutSec: number }
  | { name: "status"; colony: string }
  | { name: "rule-add"; colony: string; pattern: string; flags?: string; include: string[]; exclude: string[]; hint: string; description: string; replacement?: string; by?: string }
  | { name: "rule-import-boundary"; colony: string; from: string[]; module: string; hint: string; description: string; by?: string }
  | { name: "swarm"; colony: string; agents: number; model?: string; kind?: Extract<AgentKind, "internal" | "synthetic"> }
  | { name: "why"; colony: string; path: string; line?: number }
  | { name: "impact"; colony: string; paths: string[]; depth?: number }
  | { name: "verify"; colony: string; limit?: number }
  | CloneVerify
  | { name: "review-list"; colony: string; diff: boolean }
  | { name: "review-decide"; colony: string; proposalId: string; decision: ReviewDecision; reason: string; by?: string }
  // Tests before approval: run the colony's tests on an escalated change again.
  | { name: "review-retest"; colony: string; proposalId: string; by?: string }
  | { name: "watch"; colony: string; only: string[] }
  | { name: "new"; specPath: string; colonyName?: string; by?: string }
  | { name: "colonies"; scan: boolean }
  // Connect your agent: each MCP client's command and configuration for this server, for one colony when named.
  | { name: "connect"; colony?: string }
  | { name: "agents"; colony: string; all: boolean; journal: boolean }
  | { name: "stop"; colony: string; agentId?: string; all: boolean; reason?: string }
  | { name: "delete"; colony: string }
  | { name: "vaccinate"; colony: string; count: number }
  | { name: "immune"; colony: string }
  | { name: "certify"; colony: string; action: "show" | "now" | "on" | "off" }
  | { name: "policy"; colony: string; protect: string[]; unprotect: string[]; commentProof?: boolean; silentTtl?: number | null }
  | { name: "intent-amend"; colony: string; intentId: string; title?: string; why?: string; footprint?: string[]; priority?: number; reason: string; by?: string }
  | { name: "intent-withdraw"; colony: string; intentId: string; reason: string; by?: string }
  | { name: "intent-show"; colony: string; intentId: string }
  | { name: "rule-retract"; colony: string; ruleId: string; reason: string; by?: string }
  | { name: "revert"; colony: string; ref: string; reason: string; by?: string; redo: boolean }
  | { name: "direct"; colony: string; agentId: string; message: string; intentId?: string; by?: string }
  | { name: "escalations"; colony: string }
  | { name: "escalation"; colony: string; intentId: string; decision: EscalationDecision; note: string; title?: string; why?: string; footprint?: string[]; by?: string }
  | { name: "guide"; colony: string }
  | { name: "guide-decide"; colony: string; lessonId: string; action: "approve" | "reject"; reason?: string; by?: string }
  | { name: "megafile"; colony: string; path?: string; release: boolean; by?: string }
  // The pause switch: one colony's agents, or (no colony) every agent on the server.
  | { name: "pause"; colony?: string; reason: string; by?: string }
  | { name: "resume"; colony?: string; by?: string; reason?: string }
  // The spend cap (spendcap.ts): show it (no usd), set it, or remove it (usd null).
  | { name: "spend-cap"; colony: string; usd?: number | null; reviewReserveUsd?: number; by?: string };

/** Options every command accepts. */
export interface GlobalFlags {
  json: boolean;
  dryRun: boolean;
  url?: string;
}

/** Result of parsing argv: a command plus global flags, or a usage error. */
export type Parsed = { ok: true; command: Command; flags: GlobalFlags } | { ok: false; error: string; topic?: string };

type OptionSpec = { type: "string" | "boolean"; short?: string; multiple?: boolean };

const GLOBAL_OPTIONS: Record<string, OptionSpec> = {
  json: { type: "boolean" },
  "dry-run": { type: "boolean" },
  url: { type: "string" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean" },
};

const COMMAND_OPTIONS: Record<string, Record<string, OptionSpec>> = {
  import: { name: { type: "string" }, branch: { type: "string" }, pool: { type: "string" }, "region-depth": { type: "string" }, "no-wait": { type: "boolean" }, timeout: { type: "string" } },
  status: {},
  rule: {
    pattern: { type: "string" },
    flags: { type: "string" },
    include: { type: "string", multiple: true },
    exclude: { type: "string", multiple: true },
    from: { type: "string", multiple: true },
    module: { type: "string" },
    hint: { type: "string" },
    description: { type: "string" },
    replacement: { type: "string" },
    by: { type: "string" },
    reason: { type: "string" },
  },
  intent: {
    title: { type: "string" },
    why: { type: "string" },
    footprint: { type: "string", multiple: true },
    priority: { type: "string" },
    reason: { type: "string" },
    by: { type: "string" },
  },
  direct: { intent: { type: "string" }, by: { type: "string" } },
  escalations: {},
  escalation: { note: { type: "string" }, title: { type: "string" }, why: { type: "string" }, footprint: { type: "string", multiple: true }, by: { type: "string" } },
  guide: { reason: { type: "string" }, by: { type: "string" } },
  megafile: { release: { type: "boolean" }, by: { type: "string" } },
  pause: { deployment: { type: "boolean" }, reason: { type: "string" }, by: { type: "string" } },
  resume: { deployment: { type: "boolean" }, reason: { type: "string" }, by: { type: "string" } },
  "spend-cap": { "review-reserve": { type: "string" }, by: { type: "string" } },
  swarm: { agents: { type: "string" }, model: { type: "string" }, kind: { type: "string" } },
  why: {},
  impact: { depth: { type: "string" } },
  verify: { limit: { type: "string" }, ...CLONE_OPTIONS },
  review: { reason: { type: "string" }, by: { type: "string" }, diff: { type: "boolean" }, retest: { type: "string" } },
  revert: { reason: { type: "string" }, by: { type: "string" }, "no-redo": { type: "boolean" } },
  watch: { only: { type: "string", multiple: true } },
  new: { spec: { type: "string" }, name: { type: "string" }, by: { type: "string" } },
  colonies: { scan: { type: "boolean" } },
  connect: {},
  agents: { all: { type: "boolean" }, "no-journal": { type: "boolean" } },
  stop: { all: { type: "boolean" }, reason: { type: "string" } },
  delete: { yes: { type: "boolean" } },
  vaccinate: { count: { type: "string" } },
  immune: {},
  certify: { now: { type: "boolean" }, on: { type: "boolean" }, off: { type: "boolean" } },
  policy: { protect: { type: "string", multiple: true }, unprotect: { type: "string", multiple: true }, "comment-proof": { type: "string" }, "silent-ttl": { type: "string" } },
  help: {},
};

/** Global options that take a value, so the command scan can skip it. */
const VALUE_GLOBALS = new Set(["--url"]);

class UsageError extends Error {}

function fail(message: string): never {
  throw new UsageError(message);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function list(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function required(v: unknown, flag: string): string {
  const s = str(v)?.trim();
  if (!s) fail(`missing --${flag}`);
  return s;
}

function positiveInt(v: string, what: string, max = 100_000): number {
  if (!/^\d+$/.test(v.trim())) fail(`${what} must be a positive integer, got "${v}"`);
  const n = Number(v);
  if (n < 1 || n > max) fail(`${what} must be between 1 and ${max}, got ${n}`);
  return n;
}

function checkRegex(source: string, flags: string | undefined, flag: string): void {
  if (flags !== undefined && !/^[dgimsuvy]*$/.test(flags)) fail(`--flags may only contain d, g, i, m, s, u, v, y; got "${flags}"`);
  try {
    new RegExp(source, flags);
  } catch (e) {
    fail(`--${flag} is not a valid regular expression: ${(e as Error).message}`);
  }
}

function colonyArg(v: string | undefined, usage: string): string {
  if (!v) fail(`missing <colony>. Usage: ${usage}`);
  return v;
}

function noExtras(positionals: string[], expected: number, usage: string): void {
  if (positionals.length > expected) fail(`unexpected argument "${positionals[expected]}". Usage: ${usage}`);
}

function onlyFlags(values: Record<string, unknown>, allowed: string[], context: string): void {
  for (const key of Object.keys(values)) {
    if (Object.hasOwn(GLOBAL_OPTIONS, key) || allowed.includes(key)) continue;
    fail(`--${key} does not apply to ${context}`);
  }
}

/**
 * Turn a git URL or GitHub shorthand into a public HTTPS remote.
 * Accepts `https://host/org/repo(.git)`, `host/org/repo`, and `org/repo` (GitHub).
 */
export function normalizeGitUrl(input: string): string {
  const s = input.trim();
  if (/^git@|^ssh:\/\//.test(s)) fail("only public HTTPS remotes can be imported; use the https:// URL");
  if (/^https?:\/\//i.test(s)) {
    let u: URL;
    try {
      u = new URL(s);
    } catch {
      fail(`not a valid URL: ${s}`);
    }
    if (u.pathname.replace(/\/+$/, "").split("/").filter(Boolean).length < 1) fail(`URL has no repository path: ${s}`);
    return s.replace(/\/+$/, "");
  }
  if (/^[\w.-]+\/[\w.-]+$/.test(s)) return `https://github.com/${s.replace(/\.git$/, "")}`;
  if (/^[\w-]+(\.[\w-]+)+\/[\w./-]+$/.test(s)) return `https://${s.replace(/\/+$/, "")}`;
  fail(`not a git URL: ${s}`);
}

/** Default colony name for a git URL: the last path segment without `.git`. */
export function nameFromUrl(url: string): string {
  const last = url.replace(/\/+$/, "").split("/").pop() ?? "colony";
  return last.replace(/\.git$/i, "") || "colony";
}

/** Split `path[:line]` into a repository-relative path and an optional 1-based line. */
export function parseLocation(input: string): { path: string; line?: number } {
  const m = /^(.*?):(\d+)$/.exec(input);
  const raw = m ? (m[1] ?? "") : input;
  const path = raw.replace(/^(\.\/)+/, "").replace(/^\/+/, "");
  if (!path) fail(`missing path in "${input}"`);
  if (!m) return { path };
  const line = Number(m[2]);
  if (line < 1) fail(`line must be 1 or more, got ${line}`);
  return { path, line };
}

/** A protected-path glob as the server keeps it: trimmed, without a leading "./" or "/" or a trailing "/". */
function protectedGlob(glob: string): string {
  return glob.trim().replace(/^(?:\.\/|\/)+/, "").replace(/\/+$/, "");
}

/** Locate the command word: the first token that is neither an option nor a global option's value. */
function findCommand(argv: readonly string[]): number {
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i] ?? "";
    if (tok === "--") return -1;
    if (VALUE_GLOBALS.has(tok)) {
      i++;
      continue;
    }
    if (tok.startsWith("-")) continue;
    return i;
  }
  return -1;
}

/** Parse `ft` arguments (without `node` and the script path) into a command. Pure: no I/O. */
export function parseCommand(argv: readonly string[]): Parsed {
  const at = findCommand(argv);
  const word = at >= 0 ? (argv[at] ?? "") : "";
  const rest = at >= 0 ? [...argv.slice(0, at), ...argv.slice(at + 1)] : [...argv];
  const options = Object.hasOwn(COMMAND_OPTIONS, word) ? COMMAND_OPTIONS[word] : at < 0 ? {} : undefined;
  if (!options) return { ok: false, error: `unknown command "${word}". Run ft --help for the list.` };

  let values: Record<string, unknown>;
  let positionals: string[];
  try {
    const parsed = parseArgs({ args: rest, options: { ...GLOBAL_OPTIONS, ...options }, allowPositionals: true, strict: true });
    values = parsed.values as Record<string, unknown>;
    positionals = parsed.positionals;
  } catch (e) {
    return { ok: false, error: (e as Error).message, ...(word ? { topic: word } : {}) };
  }

  const flags: GlobalFlags = { json: values.json === true, dryRun: values["dry-run"] === true };
  const url = str(values.url);
  if (url !== undefined) flags.url = url;

  if (!word) {
    return { ok: true, command: values.version === true && values.help !== true ? { name: "version" } : { name: "help" }, flags };
  }
  if (word === "help") return { ok: true, command: positionals[0] ? { name: "help", topic: positionals[0] } : { name: "help" }, flags };
  if (values.help === true) return { ok: true, command: { name: "help", topic: word }, flags };

  try {
    return { ok: true, command: build(word, values, positionals), flags };
  } catch (e) {
    if (e instanceof UsageError) return { ok: false, error: e.message, topic: word };
    throw e;
  }
}

function build(word: string, v: Record<string, unknown>, p: string[]): Command {
  switch (word) {
    case "import": {
      const usage = "ft import <git-url> [--name <name>] [--branch <b>] [--pool <n>]";
      if (!p[0]) fail(`missing <git-url>. Usage: ${usage}`);
      noExtras(p, 1, usage);
      const url = normalizeGitUrl(p[0]);
      const cmd: Command = {
        name: "import",
        url,
        colonyName: str(v.name)?.trim() || nameFromUrl(url),
        wait: v["no-wait"] !== true,
        timeoutSec: str(v.timeout) !== undefined ? positiveInt(str(v.timeout) ?? "", "--timeout", 86_400) : 600,
      };
      const branch = str(v.branch)?.trim();
      if (branch) cmd.branch = branch;
      if (str(v.pool) !== undefined) cmd.pool = positiveInt(str(v.pool) ?? "", "--pool", 10_000);
      if (str(v["region-depth"]) !== undefined) cmd.regionDepth = positiveInt(str(v["region-depth"]) ?? "", "--region-depth", 6);
      return cmd;
    }
    case "status": {
      const usage = "ft status <colony>";
      noExtras(p, 1, usage);
      return { name: "status", colony: colonyArg(p[0], usage) };
    }
    case "rule":
      return buildRule(v, p);
    case "swarm": {
      const usage = "ft swarm <colony> --agents <n> [--model <id>] [--kind internal|synthetic]";
      noExtras(p, 1, usage);
      const colony = colonyArg(p[0], usage);
      const cmd: Command = { name: "swarm", colony, agents: positiveInt(required(v.agents, "agents"), "--agents") };
      const model = str(v.model)?.trim();
      if (model) cmd.model = model;
      const kind = str(v.kind);
      if (kind !== undefined) {
        if (kind !== "internal" && kind !== "synthetic") fail(`--kind must be internal or synthetic, got "${kind}"`);
        cmd.kind = kind;
      }
      return cmd;
    }
    case "why": {
      const usage = "ft why <colony> <path[:line]>";
      noExtras(p, 2, usage);
      const colony = colonyArg(p[0], usage);
      if (!p[1]) fail(`missing <path[:line]>. Usage: ${usage}`);
      return { name: "why", colony, ...parseLocation(p[1]) };
    }
    case "impact": {
      // What a change to a file reaches through imports, and who works on those files now.
      const usage = "ft impact <colony> <path>... [--depth <1-3>]";
      const colony = colonyArg(p[0], usage);
      const paths = [...new Set(p.slice(1).map((s) => s.trim().replace(/^(\.\/)+/, "").replace(/^\/+/, "")).filter(Boolean))];
      if (paths.length === 0) fail(`missing <path>. Usage: ${usage}`);
      if (paths.length > 20) fail(`at most 20 paths at once, got ${paths.length}`);
      const cmd: Extract<Command, { name: "impact" }> = { name: "impact", colony, paths };
      if (str(v.depth) !== undefined) cmd.depth = positiveInt(str(v.depth) ?? "", "--depth", 3);
      return cmd;
    }
    case "verify": {
      // A git clone instead of the server (--all, --commit, --tamper, --colony, ...; clonecheck.ts).
      const clone = cloneVerify(v, p);
      if (typeof clone === "string") fail(clone);
      if (clone) return clone;
      const usage = "ft verify <colony> [--limit <n>]";
      noExtras(p, 1, usage);
      const cmd: Command = { name: "verify", colony: colonyArg(p[0], usage) };
      if (str(v.limit) !== undefined) cmd.limit = positiveInt(str(v.limit) ?? "", "--limit", 200);
      return cmd;
    }
    case "review": {
      const usage = "ft review <colony> [--diff] | ft review <colony> <proposalId> approve|reject|return --reason <text> | ft review <colony> --retest <proposalId>";
      const colony = colonyArg(p[0], usage);
      // Tests before approval: run the colony's tests on an escalated change again.
      if (v.retest !== undefined) {
        noExtras(p, 1, usage);
        onlyFlags(v, ["retest", "by"], "running a change's tests again");
        const proposalId = str(v.retest)?.trim() ?? "";
        if (!proposalId) fail(`--retest needs the proposal id. Usage: ft review ${colony} --retest <proposalId>`);
        const cmd: Command = { name: "review-retest", colony, proposalId };
        const by = str(v.by)?.trim();
        if (by) cmd.by = by;
        return cmd;
      }
      if (p.length === 1) {
        onlyFlags(v, ["diff"], "listing the review queue");
        return { name: "review-list", colony, diff: v.diff === true };
      }
      if (v.diff === true) fail(`--diff applies to listing the queue: ft review ${colony} --diff`);
      noExtras(p, 3, usage);
      const proposalId = p[1] ?? "";
      const decision = p[2];
      if (decision !== "approve" && decision !== "reject" && decision !== "return") {
        fail(decision ? `decision must be approve, reject, or return; got "${decision}"` : `missing decision. Usage: ${usage}`);
      }
      const reason = str(v.reason)?.trim() ?? "";
      if (!reason && decision !== "approve") fail(`--reason is required to ${decision} (it becomes the agent's feedback and can mint an antibody)`);
      const cmd: Command = { name: "review-decide", colony, proposalId, decision, reason: reason || "approved" };
      const by = str(v.by)?.trim();
      if (by) cmd.by = by;
      return cmd;
    }
    case "revert": {
      // `ref` is a landing id, a trunk commit, or a proposal id (prp_...): then only that proposal of its landing is undone.
      const usage = "ft revert <colony> <landing|commit|proposal> --reason <text> [--by <name>] [--no-redo]";
      noExtras(p, 2, usage);
      const colony = colonyArg(p[0], usage);
      const ref = p[1]?.trim() ?? "";
      if (!ref) fail(`missing <landing|commit|proposal>. Usage: ${usage}`);
      const cmd: Command = { name: "revert", colony, ref, reason: required(v.reason, "reason"), redo: v["no-redo"] !== true };
      const by = str(v.by)?.trim();
      if (by) cmd.by = by;
      return cmd;
    }
    case "watch": {
      const usage = "ft watch <colony> [--only <type,...>]";
      noExtras(p, 1, usage);
      const colony = colonyArg(p[0], usage);
      const only = list(v.only).flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean);
      for (const t of only) {
        if (!(EVENT_TYPES as readonly string[]).includes(t)) fail(`--only: unknown event type "${t}" (expected ${EVENT_TYPES.join(", ")})`);
      }
      return { name: "watch", colony, only: [...new Set(only)] };
    }
    case "new": {
      noExtras(p, 0, "ft new --spec <file> [--name <name>]");
      const cmd: Command = { name: "new", specPath: required(v.spec, "spec") };
      const name = str(v.name)?.trim();
      if (name) cmd.colonyName = name;
      const by = str(v.by)?.trim();
      if (by) cmd.by = by;
      return cmd;
    }
    case "colonies": {
      noExtras(p, 0, "ft colonies [--scan]");
      return { name: "colonies", scan: v.scan === true };
    }
    case "connect": {
      // Nothing is sent: the commands are built here from the server URL (core/connect.ts).
      const usage = "ft connect [<colony>]";
      noExtras(p, 1, usage);
      const colony = p[0]?.trim();
      if (colony === undefined || colony === "") return { name: "connect" };
      if (!isConnectColony(colony)) fail(`"${colony}" is not a colony id (lowercase letters, digits and single hyphens). Usage: ${usage}`);
      return { name: "connect", colony };
    }
    case "agents": {
      const usage = "ft agents <colony> [--all] [--no-journal]";
      noExtras(p, 1, usage);
      return { name: "agents", colony: colonyArg(p[0], usage), all: v.all === true, journal: v["no-journal"] !== true };
    }
    case "stop": {
      const usage = "ft stop <colony> <agentId> | ft stop <colony> --all";
      noExtras(p, 2, usage);
      const colony = colonyArg(p[0], usage);
      const agentId = p[1]?.trim();
      const all = v.all === true;
      if (agentId && all) fail(`give an agent id or --all, not both. Usage: ${usage}`);
      if (!agentId && !all) fail(`say which agent to stop, or --all for every in-platform agent. Usage: ${usage}`);
      const cmd: Command = { name: "stop", colony, all };
      if (agentId) cmd.agentId = agentId;
      const reason = str(v.reason)?.trim();
      if (reason) cmd.reason = reason;
      return cmd;
    }
    case "delete": {
      const usage = "ft delete <colony> --yes";
      noExtras(p, 1, usage);
      const colony = colonyArg(p[0], usage);
      if (v.yes !== true && v["dry-run"] !== true) {
        fail(`deleting ${colony} stops its agents and removes its trunk, workspaces and history for good; add --yes to confirm`);
      }
      return { name: "delete", colony };
    }
    case "vaccinate": {
      const usage = "ft vaccinate <colony> --count <n>";
      noExtras(p, 1, usage);
      const colony = colonyArg(p[0], usage);
      return { name: "vaccinate", colony, count: positiveInt(required(v.count, "count"), "--count", 64) };
    }
    case "immune": {
      // Earned autonomy per region, with the antibodies, detectors and alert budget (immune.ts).
      const usage = "ft immune <colony>";
      noExtras(p, 1, usage);
      return { name: "immune", colony: colonyArg(p[0], usage) };
    }
    case "certify": {
      const usage = "ft certify <colony> [--now | --on | --off]";
      noExtras(p, 1, usage);
      const colony = colonyArg(p[0], usage);
      const picked = (["now", "on", "off"] as const).filter((k) => v[k] === true);
      if (picked.length > 1) fail(`choose one of --now, --on, --off (${usage})`);
      return { name: "certify", colony, action: picked[0] ?? "show" };
    }
    case "policy": {
      const usage = "ft policy <colony> [--protect <glob>]... [--unprotect <glob>]... [--comment-proof on|off] | --silent-ttl <duration|default>";
      noExtras(p, 1, usage);
      const colony = colonyArg(p[0], usage);
      const globs = (flag: string): string[] => {
        const out = list(v[flag]).map(protectedGlob);
        if (out.some((g) => g === "")) fail(`--${flag} needs a glob, such as "src/auth/**"`);
        return [...new Set(out)];
      };
      const protect = globs("protect");
      const unprotect = globs("unprotect");
      const both = protect.find((g) => unprotect.includes(g));
      if (both !== undefined) fail(`"${both}" is given to both --protect and --unprotect`);
      const cmd: Extract<Command, { name: "policy" }> = { name: "policy", colony, protect, unprotect };
      const proof = str(v["comment-proof"]);
      if (proof !== undefined) {
        if (proof !== "on" && proof !== "off") fail(`--comment-proof must be on or off, got "${proof}"`);
        cmd.commentProof = proof === "on";
      }
      // The silent-agent limit (closure.ts) has its own route, so it is set on its own.
      const ttl = str(v["silent-ttl"]);
      if (ttl !== undefined) {
        if (protect.length > 0 || unprotect.length > 0 || cmd.commentProof !== undefined) fail(`--silent-ttl is set on its own: ft policy ${colony} --silent-ttl 90s`);
        const seconds = parseSilentTtl(ttl);
        if (typeof seconds === "string") fail(seconds);
        cmd.silentTtl = seconds;
      }
      return cmd;
    }
    case "intent":
      return buildIntent(v, p);
    case "direct": {
      const usage = 'ft direct <colony> <agentId> "message" [--intent <intentId>]';
      const colony = colonyArg(p[0], usage);
      const agentId = p[1]?.trim();
      if (!agentId) fail(`missing <agentId>. Usage: ${usage}`);
      // The message may come as one quoted argument or as several words.
      const message = p.slice(2).join(" ").trim();
      if (!message) fail(`missing the message. Usage: ${usage}`);
      if (message.length > 2_000) fail(`the message is ${message.length} characters; at most 2000`);
      const cmd: Command = { name: "direct", colony, agentId, message };
      const intent = str(v.intent)?.trim();
      if (intent) cmd.intentId = intent;
      const by = str(v.by)?.trim();
      if (by) cmd.by = by;
      return cmd;
    }
    case "escalations": {
      const usage = "ft escalations <colony>";
      noExtras(p, 1, usage);
      return { name: "escalations", colony: colonyArg(p[0], usage) };
    }
    case "escalation":
      return buildEscalation(v, p);
    case "guide":
      return buildGuide(v, p);
    case "megafile": {
      // The megafile alarm: list the held files, or hold (or --release) one.
      const usage = "ft megafile <colony> [<path> [--release]] [--by <name>]";
      noExtras(p, 2, usage);
      const colony = colonyArg(p[0], usage);
      const path = p[1]?.trim().replace(/^(\.\/)+/, "").replace(/^\/+/, "");
      if (!path && (v.release === true || v.by !== undefined)) fail(`name the file to ${v.release === true ? "release" : "hold"}. Usage: ${usage}`);
      const cmd: Extract<Command, { name: "megafile" }> = { name: "megafile", colony, release: v.release === true };
      if (path) cmd.path = path;
      const by = str(v.by)?.trim();
      if (by) cmd.by = by;
      return cmd;
    }
    case "pause":
    case "resume":
      return buildPause(word, v, p);
    case "spend-cap": {
      // The spend cap (spendcap.ts): show it, set it with an amount, or remove it with off.
      const cmd = parseSpendCap(v, p);
      return typeof cmd === "string" ? fail(cmd) : cmd;
    }
    default:
      return fail(`unknown command "${word}"`);
  }
}

/** `ft pause <colony> --reason <text>`, `ft pause --deployment --reason <text>`, and `ft resume` for either. */
function buildPause(word: "pause" | "resume", v: Record<string, unknown>, p: string[]): Command {
  const usage = word === "pause" ? "ft pause <colony> --reason <text> [--by <name>] | ft pause --deployment --reason <text>" : "ft resume <colony> [--by <name>] | ft resume --deployment";
  const deployment = v.deployment === true;
  noExtras(p, deployment ? 0 : 1, usage);
  const colony = deployment ? undefined : colonyArg(p[0], `${usage} (or --deployment for every colony)`);
  const by = str(v.by)?.trim();
  const reason = str(v.reason)?.trim();
  if (word === "pause") {
    if (!reason) fail(`missing --reason: agents and people see it while they wait. Usage: ${usage}`);
    return { name: "pause", ...(colony ? { colony } : {}), reason, ...(by ? { by } : {}) };
  }
  return { name: "resume", ...(colony ? { colony } : {}), ...(by ? { by } : {}), ...(reason ? { reason } : {}) };
}

/** `ft guide <colony>`, or a person's decision on one lesson: `ft guide <colony> approve|reject <lessonId>`. */
function buildGuide(v: Record<string, unknown>, p: string[]): Command {
  const usage = "ft guide <colony> | ft guide <colony> approve|reject <lessonId> [--reason <text>] [--by <name>]";
  noExtras(p, 3, usage);
  const colony = colonyArg(p[0], usage);
  if (p.length === 1) {
    onlyFlags(v, [], "listing the guide");
    return { name: "guide", colony };
  }
  const action = p[1];
  if (action !== "approve" && action !== "reject") fail(`the action must be approve or reject; got "${action}". Usage: ${usage}`);
  const lessonId = p[2]?.trim();
  if (!lessonId) fail(`missing <lessonId>. Usage: ${usage}`);
  const cmd: Extract<Command, { name: "guide-decide" }> = { name: "guide-decide", colony, lessonId, action };
  const reason = str(v.reason)?.trim();
  if (reason) {
    if (reason.length > 500) fail(`--reason is ${reason.length} characters; at most 500`);
    cmd.reason = reason;
  }
  const by = str(v.by)?.trim();
  if (by) cmd.by = by;
  return cmd;
}

function buildEscalation(v: Record<string, unknown>, p: string[]): Command {
  const usage = "ft escalation <colony> <intentId> amend|withdraw|dismiss --note <text> [--title <t>] [--why <w>] [--footprint <path>]... [--by <name>]";
  noExtras(p, 3, usage);
  const colony = colonyArg(p[0], usage);
  const intentId = p[1]?.trim();
  if (!intentId) fail(`missing <intentId>. Usage: ${usage}`);
  const decision = p[2];
  if (decision !== "amend" && decision !== "withdraw" && decision !== "dismiss") {
    fail(decision ? `decision must be amend, withdraw or dismiss; got "${decision}"` : `missing decision. Usage: ${usage}`);
  }
  const note = str(v.note)?.trim();
  if (!note) fail("missing --note: the answer is kept with the report (for dismiss, the next agent reads it)");
  if (note.length > 2_000) fail(`--note is ${note.length} characters; at most 2000`);
  const cmd: Extract<Command, { name: "escalation" }> = { name: "escalation", colony, intentId, decision, note };
  if (decision === "amend") {
    const title = str(v.title)?.trim();
    if (str(v.title) !== undefined) {
      if (!title) fail("--title cannot be empty");
      cmd.title = title;
    }
    if (str(v.why) !== undefined) cmd.why = str(v.why) ?? "";
    const footprint = list(v.footprint).flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean);
    if (list(v.footprint).length > 0) {
      if (footprint.length === 0) fail("--footprint needs at least one path");
      cmd.footprint = [...new Set(footprint)];
    }
    if (cmd.title === undefined && cmd.why === undefined && cmd.footprint === undefined) fail(`amend says what changes: --title, --why or --footprint. Usage: ${usage}`);
  } else {
    onlyFlags(v, ["note", "by"], `escalation ${decision}`);
  }
  const by = str(v.by)?.trim();
  if (by) cmd.by = by;
  return cmd;
}

function buildIntent(v: Record<string, unknown>, p: string[]): Command {
  const sub = p[0];
  const by = str(v.by)?.trim();
  if (sub === "amend") {
    const usage = "ft intent amend <colony> <intentId> [--title <t>] [--why <w>] [--footprint <path>]... [--priority <n>] --reason <text>";
    noExtras(p, 3, usage);
    onlyFlags(v, ["title", "why", "footprint", "priority", "reason", "by"], "intent amend");
    const colony = colonyArg(p[1], usage);
    const intentId = p[2]?.trim();
    if (!intentId) fail(`missing <intentId>. Usage: ${usage}`);
    const cmd: Command = { name: "intent-amend", colony, intentId, reason: required(v.reason, "reason") };
    const title = str(v.title)?.trim();
    if (str(v.title) !== undefined) {
      if (!title) fail("--title cannot be empty");
      cmd.title = title;
    }
    if (str(v.why) !== undefined) cmd.why = str(v.why) ?? "";
    const footprint = list(v.footprint).flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean);
    if (list(v.footprint).length > 0) {
      if (footprint.length === 0) fail("--footprint needs at least one path");
      cmd.footprint = [...new Set(footprint)];
    }
    const priority = str(v.priority);
    if (priority !== undefined) {
      const n = Number(priority.trim());
      if (priority.trim() === "" || !Number.isFinite(n) || n < 0 || n > 1_000) fail(`--priority must be a number from 0 to 1000, got "${priority}"`);
      cmd.priority = n;
    }
    if (cmd.title === undefined && cmd.why === undefined && cmd.footprint === undefined && cmd.priority === undefined) {
      fail(`say what changes: --title, --why, --footprint or --priority. Usage: ${usage}`);
    }
    if (by) cmd.by = by;
    return cmd;
  }
  if (sub === "withdraw") {
    const usage = "ft intent withdraw <colony> <intentId> --reason <text>";
    noExtras(p, 3, usage);
    onlyFlags(v, ["reason", "by"], "intent withdraw");
    const colony = colonyArg(p[1], usage);
    const intentId = p[2]?.trim();
    if (!intentId) fail(`missing <intentId>. Usage: ${usage}`);
    const cmd: Command = { name: "intent-withdraw", colony, intentId, reason: required(v.reason, "reason") };
    if (by) cmd.by = by;
    return cmd;
  }
  if (sub === "show") {
    const usage = "ft intent show <colony> <intentId>";
    noExtras(p, 3, usage);
    onlyFlags(v, [], "intent show");
    const colony = colonyArg(p[1], usage);
    const intentId = p[2]?.trim();
    if (!intentId) fail(`missing <intentId>. Usage: ${usage}`);
    return { name: "intent-show", colony, intentId };
  }
  return fail(sub ? `unknown intent subcommand "${sub}" (expected amend, withdraw or show)` : "missing intent subcommand: amend, withdraw or show");
}

function buildRule(v: Record<string, unknown>, p: string[]): Command {
  const sub = p[0];
  if (sub === "add") {
    const usage = "ft rule add <colony> --pattern <regex> [--flags <f>] [--include <glob>]... [--exclude <glob>]... --hint <text> --description <text>";
    noExtras(p, 2, usage);
    onlyFlags(v, ["pattern", "flags", "include", "exclude", "hint", "description", "replacement", "by"], "rule add");
    const colony = colonyArg(p[1], usage);
    const pattern = required(v.pattern, "pattern");
    const flags = str(v.flags);
    checkRegex(pattern, flags, "pattern");
    const cmd: Command = {
      name: "rule-add",
      colony,
      pattern,
      include: list(v.include),
      exclude: list(v.exclude),
      hint: required(v.hint, "hint"),
      description: required(v.description, "description"),
    };
    if (flags) cmd.flags = flags;
    const replacement = str(v.replacement);
    if (replacement !== undefined) cmd.replacement = replacement;
    const by = str(v.by)?.trim();
    if (by) cmd.by = by;
    return cmd;
  }
  if (sub === "import-boundary") {
    const usage = "ft rule import-boundary <colony> --from <glob>... --module <regex> --hint <text> --description <text>";
    noExtras(p, 2, usage);
    onlyFlags(v, ["from", "module", "hint", "description", "by"], "rule import-boundary");
    const colony = colonyArg(p[1], usage);
    const from = list(v.from);
    if (from.length === 0) fail("missing --from <glob> (repeat it for several globs)");
    const module = required(v.module, "module");
    checkRegex(module, undefined, "module");
    const cmd: Command = {
      name: "rule-import-boundary",
      colony,
      from,
      module,
      hint: required(v.hint, "hint"),
      description: required(v.description, "description"),
    };
    const by = str(v.by)?.trim();
    if (by) cmd.by = by;
    return cmd;
  }
  if (sub === "retract") {
    const usage = "ft rule retract <colony> <ruleId> --reason <text>";
    noExtras(p, 3, usage);
    onlyFlags(v, ["reason", "by"], "rule retract");
    const colony = colonyArg(p[1], usage);
    const ruleId = p[2]?.trim();
    if (!ruleId) fail(`missing <ruleId>. Usage: ${usage}`);
    const cmd: Command = { name: "rule-retract", colony, ruleId, reason: required(v.reason, "reason") };
    const by = str(v.by)?.trim();
    if (by) cmd.by = by;
    return cmd;
  }
  return fail(sub ? `unknown rule subcommand "${sub}" (expected add, import-boundary or retract)` : "missing rule subcommand: add, import-boundary or retract");
}

/** Usage text for the whole CLI, or for one command when `topic` names it. */
export function helpText(topic?: string): string {
  const t = topic && Object.hasOwn(HELP, topic) ? HELP[topic] : undefined;
  return (t ?? MAIN_HELP).trim();
}

const MAIN_HELP = `
ft: the FireTrident CLI. A colony, not a queue.

Usage
  ft <command> [options]

Commands
  colonies                         List every colony with live counters
  connect [<colony>]               Connect an agent: each MCP client's command and config
  import <git-url>                 Import a public repository as a new colony
  new --spec <file>                Start a colony from a spec: empty trunk, rules, intents
  status <colony>                  Summarize trunk, intents, agents, and violations
  rule add <colony>                Forbid a pattern; every match becomes a need
  rule import-boundary <colony>    Forbid imports across a boundary
  rule retract <colony> <ruleId>   Retract a rule; its unlanded intents are withdrawn
  intent amend <colony> <id>       Change an intent's title, why, footprint or priority
  intent withdraw <colony> <id>    Call an intent off before it lands
  intent show <colony> <id>        An intent with its revisions and directives
  direct <colony> <agent> "text"   Send one agent free-text guidance mid-flight
  escalations <colony>             Agents' reports that an intent cannot be done as written
  escalation <colony> <intent>     Answer a report: amend, withdraw or dismiss
  guide <colony>                   Lessons agents left (the field guide); approve or reject one
  megafile <colony> [path]         Files held for their split; hold or release one
  pause <colony> --reason <text>   Pause every agent of a colony (--deployment: of the server)
  resume <colony>                  Let a paused colony's agents work again (--deployment too)
  spend-cap <colony> <usd>         Cap what the model calls the platform makes for a colony may cost
  swarm <colony> --agents <n>      Spawn in-platform agents
  agents <colony>                  List agents: state, intent, step, what each says it is doing
  stop <colony> <agentId>|--all    Stop one agent, or every in-platform agent
  vaccinate <colony> --count <n>   Inject planted bad changes to test the immune layer
  immune <colony>                  Earned autonomy per region: what earned it, what revoked it
  certify <colony>                 Trunk certification: results, --now, --on/--off
  policy <colony>                  Paths only a person may change; the comment-only proof; silent agents
  why <colony> <path[:line]>       Show the lineage behind a file or line
  impact <colony> <path>...        What a change to a file reaches, and who works on it now
  verify <colony>                  Check the newest lineage notes on git against their commits
  verify --all                     Check every landing of a git clone with stock git, no server
  review <colony> [--diff]         List proposals escalated to a human, code first
  review <colony> <id> <decision>  Approve, reject, or return a proposal
  review <colony> --retest <id>    Run the colony's tests on an escalated change again
  revert <colony> <landing|prp>    Undo a landing or one proposal of it unless work landed on top
  watch <colony>                   Stream live colony events
  delete <colony> --yes            Delete a colony: agents, repos, and history

Global options
  --json         Machine-readable output (one JSON object per line for watch)
  --dry-run      Print the HTTP request(s) instead of sending them
  --url <url>    Server (default: $FT_URL, else https://firetrident.com)
  -h, --help     Help for a command: ft <command> --help
  --version      Print the version

Environment
  FT_URL      Server URL
  FT_TOKEN    Bearer token sent with every request
  FT_USER     Name recorded as rule approver and review decider (default: your login)
  NO_COLOR    Disable colors (FORCE_COLOR=1 forces them)
  When FT_URL or FT_TOKEN is unset, ft reads ~/.config/firetrident/env
  (KEY=value lines). Its token is only sent to the server named in that file.
`;

const HELP: Record<string, string> = {
  import: `
ft import <git-url> [--name <name>] [--branch <b>] [--pool <n>] [--region-depth <d>]
          [--no-wait] [--timeout <s>]

Import a public HTTPS repository into Artifacts as a new colony, then wait until
its trunk is ready (unless --no-wait). GitHub shorthand works: ft import org/repo.

  --name <name>         Colony name (default: the repository name)
  --branch <b>          Branch to import (default: the remote default branch)
  --pool <n>            Warm workspace pool size
  --region-depth <d>    Directory depth of a region on the map (default 1; use 2
                        when all code sits under one folder such as src/)
  --no-wait             Return right after the import starts
  --timeout <s>         Give up waiting after this many seconds (default 600)

Example
  ft import https://github.com/org/repo --pool 200 --region-depth 2
`,
  new: `
ft new --spec <file> [--name <name>] [--by <name>]

Start a colony from a spec. The file is Markdown with one fenced block tagged
\`\`\`json firetrident holding {"firetrident":"spec/v1", name, goal, rules[], intents[]}.
ft creates an empty colony, sets the spec's policy if it has one, adds each
rule, then declares each intent, so no agent has work before the policy holds.

  context[]          ## sections every intent carries as its spec context
                     (default: every section but the machine-readable one)
  policy.protectedPaths
                     paths only a person may change, as globs written as for
                     rules (**, *, ?, {a,b}; one naming a directory covers
                     everything under it; at most 50), such as
                     ["src/auth/**", "db/migrations"]: a change that writes,
                     deletes or renames one goes to a person, even with review off
  policy.commentProof
                     false: changes that only edit comments in existing script
                     files need review like any other (default true: they land
                     on the deterministic proof). ft policy shows or changes both
  intents[].uses     files the intent builds on (other intents create them): it is
                     declared after them, they become its parent, and its agent
                     waits for them to land and reads them before writing
  intents[].model    "default", "bulk" or a model id its files are written with
  intents[].contest  2 to 4: that many agents build the intent at once and the
                     colony lands one change: a mechanical proof first, then fewer
                     files outside the footprint, then no danger signals, then a
                     model comparing two changes at a time (asked in both orders),
                     then the smaller diff, then the earlier one. The others go
                     back superseded and are kept in the winner's lineage note

Example
  ft new --spec demo/new-project-spec.md
`,
  status: `
ft status <colony>

Print a compact summary: source, trunk and green commits, files and regions,
intents by status, agents by state, violations left, the decision funnel,
recent landings, the paths only a person may change (ft policy), how many
regions earned autonomy and how many lost it (ft immune), and stuck work:
intents claimed for 10 minutes with no change, intents whose changes came back
3 or more times, a trunk red for 15 minutes, reports and changes waiting 10
minutes for a person, and agents alive but not moving for 10 minutes, each with
what to do about it. The last row is the build the server runs.
`,
  rule: `
ft rule add <colony> --pattern <regex> [--flags <f>] [--include <glob>]... [--exclude <glob>]...
                     --hint <text> --description <text> [--replacement <text>] [--by <name>]
ft rule import-boundary <colony> --from <glob>... --module <regex>
                     --hint <text> --description <text> [--by <name>]
ft rule retract <colony> <ruleId> --reason <text> [--by <name>]

Declare an architecture rule. FireTrident scans trunk; every violation becomes a
need in the field and an intent the swarm can take. --hint tells agents how to
fix a violation. --replacement is an optional deterministic fix for synthetic
agents: a RegExp replacement string ($1 allowed) applied to each violating line.
--by records who approved the rule (default $FT_USER).

retract takes a rule back: it stays in history but is no longer checked, its
open violations stop counting, and every intent it created that has not landed
is withdrawn (needs evaporate, changes in flight are stopped, agents stop).
Landed work is untouched: a change the trunk writer landed before the
retraction reached it is named, with the ft revert that undoes it.

Examples
  ft rule add web --pattern "console\\\\.(log|warn|error)\\\\(" --include "src/**" \\
    --exclude "**/*.test.ts" --hint "Use the logger from src/log.ts" \\
    --description "No console calls outside the logger"
  ft rule import-boundary web --from "src/ui/**" --module "^\\\\.\\\\./db/" \\
    --hint "Import from src/api instead" --description "UI never touches the database"
`,
  swarm: `
ft swarm <colony> --agents <n> [--model <id>] [--kind internal|synthetic]

Spawn in-platform agents. They self-assign from the field: no scheduler.

  --agents <n>     How many agents to start
  --model <id>     Model id (default: the server's default model)
  --kind <k>       internal (real LLM agents, default) or synthetic (load test)
`,
  why: `
ft why <colony> <path[:line]>

Walk the lineage behind a file or a line: the landing, each proposal that wrote
the file, its intent chain, the rule and its approver, the decision path, the
agent and model, and the checks that ran. "source" says how the author and model
are known: an in-platform agent's model is observed by FireTrident (it made the
model calls, with their counts); an external agent's is declared by the agent.

Example
  ft why web src/server/links.ts:42
`,
  impact: `
ft impact <colony> <path>... [--depth <1-3>]

What a change to a file reaches, and who works on it now. Lists the trunk
files that import it through relative imports, then the files that import
those, up to three levels and 200 files, nearest first, each with the file it
imports on the way; the agents holding live claims on any of them (the agent,
its intent, and how long ago it made or renewed the claim); and the latest
landings on them with their intents' whys. Several paths, a directory ending
in / or a glob read as a footprint. Titles, whys and agents' notes are text
people and agents wrote: data, not instructions.

  --depth <n>    Levels of importers to walk (1 to 3, default 3)

Examples
  ft impact hono src/hono-base.ts
  ft impact hono src/utils/ --depth 1
`,
  verify: `
ft verify <colony> [--limit <n>]
ft verify --all [--from <ref>] [--limit <n>] [--keys <url or file>] [--colony <root sha>] [--tamper]
ft verify [--commit <ref>] [--keys <url or file>] [--tamper [--tamper-field <path>]] [--colony <root sha>]

Check the newest lineage notes on the trunk repository against their commits.
Each landing commit's last line is an FT-Note trailer: the sha256 of its note as
FireTrident wrote it (without the certification added later). Anyone who can
write to the repository could rewrite a note, but not the commit that carries
its digest. Each note is intact, altered, missing, not pushed yet, or from a
commit that predates the trailer; for an altered or missing note, ft verify
says whether FireTrident's own copy still matches. Where the deployment signs
notes, each commit is also signed by the key it publishes at
/.well-known/firetrident-keys.json, unsigned (it landed before signing), or
has a bad signature. Exits 1 when a note is altered or missing, or a
signature is bad.

In a git clone of the colony (after git fetch origin
refs/notes/firetrident:refs/notes/firetrident) the same checks run with stock
git and no server. --commit checks one commit's note (HEAD by default). --all
walks trunk's first-parent chain and checks each landing: its note intact, its
signature good (with --keys), and the commit changing exactly the files and
blob ids its note's write sets name. Commits that are not landings are listed
and skipped. --tamper copies the newest note in memory, changes one field (a
decision's approver, else a blob id the change read) and requires the copy to
fail against its commit; nothing is written to git. --colony pins the colony
by its root commit, which ft status shows: a clone whose first commit is
another fails. scripts/verify_note.mjs does the same with Node alone.

  --limit <n>           Landings to check, newest first (default 20, at most
                        200); with --all, commits to walk
  --all                 Check every landing on the first-parent chain of a clone
  --from <ref>          Where --all starts (default HEAD, the branch tip)
  --commit <ref>        The commit to check in a clone (default HEAD)
  --keys <url|file>     A deployment's /.well-known/firetrident-keys.json:
                        check each commit's signature too
  --tamper              Show that an edited copy of the newest note is caught
  --tamper-field <p>    The field --tamper changes, e.g. proposals[0].decisions[1].by
  --colony <root>       The colony's root commit (40 hex): any other history fails
  --dir <path>          The clone (default the current directory)

Examples
  ft verify web --limit 50
  ft verify --all --keys https://firetrident.com/.well-known/firetrident-keys.json
  ft verify --tamper --colony <root sha from ft status>
`,
  review: `
ft review <colony> [--diff]
ft review <colony> <proposalId> approve|reject|return [--reason <text>] [--by <name>]
ft review <colony> --retest <proposalId> [--by <name>]

List proposals escalated to a human, code first, or decide one. Each proposal
leads with its tests: the colony's tests run on the change at its base while it
waits for you, how many passed, each failing test with the first line of its
error and whether it passes on trunk, or why they did not run. For each
proposal whose change the server kept, "look here first" shows its danger lines
(path:line, what matched, the line itself with secrets masked) and the diff of
each file it changed outside its declared footprint. The reason, the checks and
the size of the change follow. --diff adds every kept file's full diff, with its
danger lines flagged. --retest runs a proposal's tests again.

--reason is required to reject or return; a rejection can mint an antibody.

Examples
  ft review web --diff
  ft review web prp_42 approve
  ft review web --retest prp_42
`,
  intent: `
ft intent amend <colony> <intentId> [--title <t>] [--why <text>] [--footprint <path>]...
                [--priority <n>] --reason <text> [--by <name>]
ft intent withdraw <colony> <intentId> --reason <text> [--by <name>]
ft intent show <colony> <intentId>

Change direction while the colony works. amend raises the intent's revision and
records what changed and why. Needs move with the footprint. When the title, why
or footprint changes, changes built on the older revision are stopped, and the
agent holding the intent is told: it keeps the intent and redoes the work against
the new revision. withdraw calls the intent off: its needs evaporate, changes in
flight are stopped, and its agent stops. Landed work is never touched: a change
the trunk writer landed before the amendment or withdrawal reached it is named,
with the ft revert that undoes it. "unconfirmed" means the trunk writer did not
answer, so a change sent back may still land.

Examples
  ft intent amend web int_42 --why "Return 'bonjour', not 'hello'" --reason "French UI"
  ft intent withdraw web int_42 --reason "Superseded by the new router"
`,
  direct: `
ft direct <colony> <agentId> "message" [--intent <intentId>] [--by <name>]

Send one agent free-text guidance. It is about the intent the agent holds unless
--intent names another. An in-platform agent gets it at once, folds it into its
next prompt and redoes work it has not landed (it recalls a proposal still in
flight); an external agent reads it in its inbox. The agent's status note
(ft agents) shows what it did with it.

Example
  ft direct web agt_7 "Use the logger from src/log.ts, not console"
`,
  escalations: `
ft escalations <colony>

List the reports agents made that an intent cannot be done as written (a test
that is wrong, a contradictory spec, an impossible ask), newest first. No agent
is offered such an intent until a person answers: ft escalation.

Example
  ft escalations web
`,
  escalation: `
ft escalation <colony> <intentId> amend --note <text> [--title <t>] [--why <text>]
              [--footprint <path>]... [--by <name>]
ft escalation <colony> <intentId> withdraw|dismiss --note <text> [--by <name>]

Answer an agent's report on an intent. amend changes the intent (the note is
the amendment's reason) and offers it to agents again; withdraw calls it off
with the note; dismiss offers it again unchanged, and the note becomes guidance
that whoever takes it next reads. The report keeps the answer.

Examples
  ft escalation web int_42 dismiss --note "The test is right: 405 is the spec"
  ft escalation web int_42 amend --why "Return 404 for unknown slugs" --note "spec changed"
`,
  guide: `
ft guide <colony>
ft guide <colony> approve|reject <lessonId> [--reason <text>] [--by <name>]

The colony's field guide (FT_FIELD_GUIDE): lessons agents left with their
changes, each with the agent that wrote it, its model and the landing it came
from. A lesson joins the guide once its change lands and the first
certification of trunk after it is green, or once a person approves it; every
take then carries the newest ones as data. A revert of its landing, a red
certification that names its change, or a person's rejection drops it. With
the operator token the list also shows the candidates waiting and the lessons
dropped or retired lately. approve makes a lesson active; reject drops it.

Examples
  ft guide web
  ft guide web approve les_42
  ft guide web reject les_42 --reason "the router moved to src/routes"
`,
  pause: `
ft pause <colony> --reason <text> [--by <name>]
ft pause --deployment --reason <text> [--by <name>]

Pause every agent of a colony, or with --deployment of every colony on the
server, for a reason people and agents see. Until a person resumes, agents
cannot take work, propose, declare, report or start, and each refused write
says who paused and why. Changes already in a lane wait there and nothing an
agent wrote lands. Reads still work, and so does everything a person does:
review, amend, withdraw, revert, and resume. ft status shows the pause.

Examples
  ft pause web --reason "demo reset at 14:00"
  ft pause --deployment --reason "spend check"
`,
  resume: `
ft resume <colony> [--by <name>] [--reason <text>]
ft resume --deployment [--by <name>]

Let a paused colony's agents work again (or with --deployment, every colony's):
agents take and propose again, and the lanes land what waited in them. A colony
paused on its own stays paused when the deployment resumes, and the other way
round; the answer names any pause still in force.

Examples
  ft resume web
  ft resume --deployment
`,
  "spend-cap": `
ft spend-cap <colony> <usd> [--review-reserve <usd>] [--by <name>]
ft spend-cap <colony> off
ft spend-cap <colony>

Cap what the model calls the platform makes for a colony may cost, in US
dollars at Workers AI list prices: its in-platform agents, review, the contest
judge, the conflict resolver. What external agents spend on their own models
is not counted. Each call is reserved before it starts, so calls running at
once cannot pass the cap. Everything but review stops at the cap minus the
review reserve (a tenth of the cap unless you set one): then the agents are
paused (ft status shows it), and changes already in flight are still proven
or reviewed from the reserve. When the reserve is spent too, review calls no
model and those changes wait for a person (ft review). Raising the cap past
the spend lifts the pause; off removes the cap. With no amount, show where
the colony stands.

Examples
  ft spend-cap web 5
  ft spend-cap web 20 --review-reserve 2
  ft spend-cap web off
`,
  megafile: `
ft megafile <colony>
ft megafile <colony> <path> [--release] [--by <name>]

The megafile alarm (FT_MEGAFILE on the server). A script file that grew fast
while many agents wrote it, or that changes keep colliding on, gets an intent
to split it, and the file is held: no other intent that covers it is offered,
and a change that writes it goes back, until the split lands, is withdrawn or
reported, or an hour passes. With no path, list the held files with their
numbers and the holds lifted lately. With a path, hold that file for its split
(its split intent is declared unless one is open); --release lifts its hold and
leaves the intent.

Examples
  ft megafile web
  ft megafile web src/router.ts
  ft megafile web src/router.ts --release
`,
  watch: `
ft watch <colony> [--only <type,...>]

Stream live colony events, one line each. Types: agent, mark, intent, proposal,
landing, decision, sigma, violations, metric, amended, withdrawn, retracted,
directive, escalation, stuck, status. --json prints raw events. Reconnects automatically; Ctrl-C to stop.

Example
  ft watch web --only landing,proposal,violations
`,
  connect: `
ft connect [<colony>]

Connect an agent to this server: for Claude Code, Claude, Codex CLI, Cursor,
VS Code and plain HTTP, the command and configuration of the read-only server
first (/public/mcp: no token, changes nothing), then of the server that joins
a colony and proposes (/mcp, with the deployment's MCP token in FT_MCP_TOKEN).
No snippet holds a token. With a colony, also what to ask it first and the
colony's SKILL.md. Sends nothing; --json prints the same as JSON. The same
text is on the server's /connect page.

Examples
  ft connect
  ft connect hono
  ft connect hono --url https://<your-worker>.workers.dev
`,
  colonies: `
ft colonies [--scan]

List every colony: trunk commit, agents, open intents, landings, violations,
age, and source. --scan also looks for colonies created before the registry.
`,
  agents: `
ft agents <colony> [--all] [--no-journal]

List a colony's agents: kind, state, the step each in-platform agent is on, the
intent it holds, its model, what it says it is doing now (its relayed status
note), and when it was last seen.

  --all          Include dead and stopped agents
  --no-journal   Skip each agent's own journal (faster for large swarms)
`,
  stop: `
ft stop <colony> <agentId> [--reason <text>]
ft stop <colony> --all [--reason <text>]

Stop one agent, or every in-platform agent in the colony. A stopped agent gives
back the intent it claimed; a proposal already in a lane stands.
`,
  delete: `
ft delete <colony> --yes

Delete a colony for good: stop its agents, delete its trunk, workspace, seed and
session repos, clear its objects' storage, and drop it from the registry.
Safe to repeat; a repeat finishes anything a failed delete left behind.
`,
  revert: `
ft revert <colony> <landing|commit|proposal> --reason <text> [--by <name>] [--no-redo]

Undo one landed change as a new commit on trunk: a whole landing (a landing id
or a trunk commit of 7+ characters), or one proposal of it (its prp_ id). For a
proposal, only the files it wrote go back and only its intent is declared
again; the other proposals of its landing stay as they landed. Every file undone
must still hold what it landed: if later work changed one, nothing happens and
the answer names the file and the latest landing that changed it. The intents
it completed are declared again, their why starting with your reason, unless
--no-redo; a rule's violations count again until they land. The revert is
recorded in the events and in the commit's note.

Examples
  ft revert hono lnd_mv5x0aa1 --reason "breaks the router's 405 handling"
  ft revert hono prp_mv5x0ab7 --reason "only this change broke the router"
`,
  certify: `
ft certify <colony> [--now | --on | --off]

Trunk certification runs the colony's own tests (node:test) after landings, in
a Dynamic Worker, and records the result per trunk commit. A green run moves
the trunk's certified branch to that commit: every test file it could run
passed and no test that passed before was lost. main holds every landing,
tested or not; deploy, release and pin from certified
(git clone -b certified <url>). Without options, show the state, the green
commit and the latest results. --now certifies the current trunk now; --off
and --on change the colony's policy (the deployment's FT_TRUNK_TESTS must be
"on" as well).
`,
  policy: `
ft policy <colony> [--protect <glob>]... [--unprotect <glob>]... [--comment-proof on|off]
ft policy <colony> --silent-ttl <duration|default>

Show or change how the colony reviews changes. Without options, show whether
review runs, the deterministic proofs, and the protected paths.

  --protect <glob>       Add a protected path. Any change that writes, deletes or
                         renames a path it covers goes to a person, whatever its
                         intent, antibodies or proofs say. Globs are written as for
                         rules (**, *, ?, {a,b}); one naming a directory covers
                         everything under it. At most 50
  --unprotect <glob>     Remove a protected path
  --comment-proof on|off A change to existing .ts, .tsx, .js, .jsx, .mjs or .cjs
                         files that only changes comments and whitespace (no
                         directive comment) lands without a model. On by default
  --silent-ttl <d>       How long an agent outside the platform (MCP or API) may
                         be silent before the colony takes its claimed intents
                         back, reopening them with a failure mark: 60s to 24h,
                         such as 90s or 10m; default puts back ten minutes.
                         In-platform agents keep at least ten minutes. Set on
                         its own; the closures it causes are in the metrics

Examples
  ft policy web --protect "src/auth/**" --protect db/migrations
  ft policy web --unprotect db/migrations
  ft policy web --comment-proof off
  ft policy demo --silent-ttl 90s
`,
  immune: `
ft immune <colony>

Where review relaxed and what took it back. A region earns autonomy once 3 of
its changes (the policy's autonomyAfter) land approved by a deterministic proof,
a second model or a person; then the reflex alone may land a change there when
a person or a rule wrote its intent. An escalation to a person or a rejection
there takes it back until as many land approved again. Lists each region, the
latest to move first: earned, revoked or not yet, its approved landings, and
what earned it, what revoked it and what earns it back. Then the antibodies,
the detectors on probation and the alert budget. A public read: no token needed.

Example
  ft immune web
`,
  vaccinate: `
ft vaccinate <colony> --count <n>

Inject n vaccine proposals (1 to 64): planted bad changes of known threat
classes (secret-log, test-weakened, forbidden-import, off-intent,
loosened-guard) that the decide layer must catch. The vaccination meter
reports per class how many a model or check returned and how many went to a
person (whose decision it does not measure).
`,
};
