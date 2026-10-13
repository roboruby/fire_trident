import { parseArgs } from "node:util";
import type { AgentKind, ColonyEvent } from "@fire_trident/core";

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
  "status",
  "certify",
];

/** What a human can do with an escalated proposal. */
export type ReviewDecision = "approve" | "reject" | "return";

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
  | { name: "review-list"; colony: string; diff: boolean }
  | { name: "review-decide"; colony: string; proposalId: string; decision: ReviewDecision; reason: string; by?: string }
  | { name: "watch"; colony: string; only: string[] }
  | { name: "new"; specPath: string; colonyName?: string; by?: string }
  | { name: "colonies"; scan: boolean }
  | { name: "agents"; colony: string; all: boolean; journal: boolean }
  | { name: "stop"; colony: string; agentId?: string; all: boolean; reason?: string }
  | { name: "delete"; colony: string }
  | { name: "vaccinate"; colony: string; count: number }
  | { name: "certify"; colony: string; action: "show" | "now" | "on" | "off" }
  | { name: "intent-amend"; colony: string; intentId: string; title?: string; why?: string; footprint?: string[]; priority?: number; reason: string; by?: string }
  | { name: "intent-withdraw"; colony: string; intentId: string; reason: string; by?: string }
  | { name: "intent-show"; colony: string; intentId: string }
  | { name: "rule-retract"; colony: string; ruleId: string; reason: string; by?: string }
  | { name: "revert"; colony: string; ref: string; reason: string; by?: string; redo: boolean }
  | { name: "direct"; colony: string; agentId: string; message: string; intentId?: string; by?: string };

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
  swarm: { agents: { type: "string" }, model: { type: "string" }, kind: { type: "string" } },
  why: {},
  review: { reason: { type: "string" }, by: { type: "string" }, diff: { type: "boolean" } },
  revert: { reason: { type: "string" }, by: { type: "string" }, "no-redo": { type: "boolean" } },
  watch: { only: { type: "string", multiple: true } },
  new: { spec: { type: "string" }, name: { type: "string" }, by: { type: "string" } },
  colonies: { scan: { type: "boolean" } },
  agents: { all: { type: "boolean" }, "no-journal": { type: "boolean" } },
  stop: { all: { type: "boolean" }, reason: { type: "string" } },
  delete: { yes: { type: "boolean" } },
  vaccinate: { count: { type: "string" } },
  certify: { now: { type: "boolean" }, on: { type: "boolean" }, off: { type: "boolean" } },
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
    case "review": {
      const usage = "ft review <colony> [--diff] | ft review <colony> <proposalId> approve|reject|return --reason <text>";
      const colony = colonyArg(p[0], usage);
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
      const usage = "ft revert <colony> <landing|commit> --reason <text> [--by <name>] [--no-redo]";
      noExtras(p, 2, usage);
      const colony = colonyArg(p[0], usage);
      const ref = p[1]?.trim() ?? "";
      if (!ref) fail(`missing <landing|commit>. Usage: ${usage}`);
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
    case "certify": {
      const usage = "ft certify <colony> [--now | --on | --off]";
      noExtras(p, 1, usage);
      const colony = colonyArg(p[0], usage);
      const picked = (["now", "on", "off"] as const).filter((k) => v[k] === true);
      if (picked.length > 1) fail(`choose one of --now, --on, --off (${usage})`);
      return { name: "certify", colony, action: picked[0] ?? "show" };
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
    default:
      return fail(`unknown command "${word}"`);
  }
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
  swarm <colony> --agents <n>      Spawn in-platform agents
  agents <colony>                  List agents: state, intent, step, what each says it is doing
  stop <colony> <agentId>|--all    Stop one agent, or every in-platform agent
  vaccinate <colony> --count <n>   Inject planted bad changes to test the immune layer
  certify <colony>                 Trunk certification: results, --now, --on/--off
  why <colony> <path[:line]>       Show the lineage behind a file or line
  review <colony> [--diff]         List proposals escalated to a human, code first
  review <colony> <id> <decision>  Approve, reject, or return a proposal
  revert <colony> <landing>        Undo a landed change unless work landed on top of it
  watch <colony>                   Stream live colony events
  delete <colony> --yes            Delete a colony: agents, repos, and history

Global options
  --json         Machine-readable output (one JSON object per line for watch)
  --dry-run      Print the HTTP request(s) instead of sending them
  --url <url>    Server (default: $FT_URL, else https://firetrident.mattsolt.workers.dev)
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
ft creates an empty colony, adds each rule, then declares each intent.

  context[]          ## sections every intent carries as its spec context
                     (default: every section but the machine-readable one)
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
intents by status, agents by state, violations left, the decision funnel, and
recent landings.
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
is withdrawn (needs evaporate, changes in flight go back, agents stop). Landed
work is untouched.

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
agent and model, and the checks that ran.

Example
  ft why web src/server/links.ts:42
`,
  review: `
ft review <colony> [--diff]
ft review <colony> <proposalId> approve|reject|return [--reason <text>] [--by <name>]

List proposals escalated to a human, code first, or decide one. For each
proposal whose change the server kept, "look here first" shows its danger lines
(path:line, what matched, the line itself with secrets masked) and the diff of
each file it changed outside its declared footprint. The reason, the checks and
the size of the change follow. --diff adds every kept file's full diff, with its
danger lines flagged.

--reason is required to reject or return; a rejection can mint an antibody.

Examples
  ft review web --diff
  ft review web prp_42 approve
`,
  intent: `
ft intent amend <colony> <intentId> [--title <t>] [--why <text>] [--footprint <path>]...
                [--priority <n>] --reason <text> [--by <name>]
ft intent withdraw <colony> <intentId> --reason <text> [--by <name>]
ft intent show <colony> <intentId>

Change direction while the colony works. amend raises the intent's revision and
records what changed and why. Needs move with the footprint. When the title, why
or footprint changes, changes built on the older revision go back, and the agent
holding the intent is told: it keeps the intent and redoes the work against the
new revision. withdraw calls the intent off: its needs evaporate, changes in
flight go back, and its agent stops. Landed work is never touched.

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
  watch: `
ft watch <colony> [--only <type,...>]

Stream live colony events, one line each. Types: agent, mark, intent, proposal,
landing, decision, sigma, violations, metric, amended, withdrawn, retracted,
directive, status. --json prints raw events. Reconnects automatically; Ctrl-C to stop.

Example
  ft watch web --only landing,proposal,violations
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
ft revert <colony> <landing|commit> --reason <text> [--by <name>] [--no-redo]

Undo one landed change as a new commit on trunk. Every file it wrote must still
hold what it landed: if later work changed one, nothing happens and the answer
names the file and the latest landing that changed it. The landing is a landing id or a
trunk commit (7+ characters). The intents it completed are declared again, their
why starting with your reason, unless --no-redo; a rule's violations count again
until they land. The revert is recorded in the events and in the commit's note.

Example
  ft revert hono lnd_mv5x0aa1 --reason "breaks the router's 405 handling"
`,
  certify: `
ft certify <colony> [--now | --on | --off]

Trunk certification runs the colony's own tests (node:test) after landings, in
a Dynamic Worker, and records the result per trunk commit. Without options,
show the state, the green commit and the latest results. --now certifies the
current trunk now; --off and --on change the colony's policy (the deployment's
FT_TRUNK_TESTS must be "on" as well).
`,
  vaccinate: `
ft vaccinate <colony> --count <n>

Inject n vaccine proposals (1 to 64): planted bad changes of known threat
classes (secret-log, test-weakened, forbidden-import, off-intent) that the
decide layer must catch. The vaccination meter reports recall per class.
`,
};
