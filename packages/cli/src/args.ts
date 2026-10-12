import { parseArgs } from "node:util";
import type { AgentKind, ColonyEvent } from "@fire_trident/core";

/** Event types `ft watch --only` accepts. */
export const EVENT_TYPES: ReadonlyArray<ColonyEvent["t"]> = ["agent", "mark", "intent", "proposal", "landing", "decision", "sigma", "violations", "metric"];

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
  | { name: "review-list"; colony: string }
  | { name: "review-decide"; colony: string; proposalId: string; decision: ReviewDecision; reason: string; by?: string }
  | { name: "watch"; colony: string; only: string[] }
  | { name: "new"; specPath: string; colonyName?: string; by?: string };

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
  },
  swarm: { agents: { type: "string" }, model: { type: "string" }, kind: { type: "string" } },
  why: {},
  review: { reason: { type: "string" }, by: { type: "string" } },
  watch: { only: { type: "string", multiple: true } },
  new: { spec: { type: "string" }, name: { type: "string" }, by: { type: "string" } },
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
      const usage = "ft review <colony> [<proposalId> approve|reject|return --reason <text>]";
      const colony = colonyArg(p[0], usage);
      if (p.length === 1) {
        onlyFlags(v, [], "listing the review queue");
        return { name: "review-list", colony };
      }
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
    default:
      return fail(`unknown command "${word}"`);
  }
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
  return fail(sub ? `unknown rule subcommand "${sub}" (expected add or import-boundary)` : "missing rule subcommand: add or import-boundary");
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
  import <git-url>                 Import a public repository as a new colony
  new --spec <file>                Start a colony from a spec: empty trunk, rules, intents
  status <colony>                  Summarize trunk, intents, agents, and violations
  rule add <colony>                Forbid a pattern; every match becomes a need
  rule import-boundary <colony>    Forbid imports across a boundary
  swarm <colony> --agents <n>      Spawn in-platform agents
  why <colony> <path[:line]>       Show the lineage behind a file or line
  review <colony>                  List proposals escalated to a human
  review <colony> <id> <decision>  Approve, reject, or return a proposal
  watch <colony>                   Stream live colony events

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

Declare an architecture rule. FireTrident scans trunk; every violation becomes a
need in the field and an intent the swarm can take. --hint tells agents how to
fix a violation. --replacement is an optional deterministic fix for synthetic
agents: a RegExp replacement string ($1 allowed) applied to each violating line.
--by records who approved the rule (default $FT_USER).

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
ft review <colony>
ft review <colony> <proposalId> approve|reject|return [--reason <text>] [--by <name>]

List proposals escalated to a human, or decide one. --reason is required to
reject or return; a rejection can mint an antibody.
`,
  watch: `
ft watch <colony> [--only <type,...>]

Stream live colony events, one line each. Types: agent, mark, intent, proposal,
landing, decision, sigma, violations, metric. --json prints raw events.
Reconnects automatically; Ctrl-C to stop.

Example
  ft watch web --only landing,proposal,violations
`,
};
