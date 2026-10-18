import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { MCP_SERVER_NAME, MCP_TOKEN_ENV, PUBLIC_MCP_SERVER_NAME, type ConnectInfo, type ConnectSnippet } from "./connect.ts";
import type { Colors } from "./format.ts";

/**
 * `ft connect --install <client>`: register FireTrident's MCP server with Claude Code or Codex CLI by running that
 * client's own command, after printing it and asking (`--yes` skips the question). The other clients keep `ft connect`'s
 * printed configuration. No token is ever on a command line, where ps and shell history see it: the read-only server
 * (`--read-only`, /public/mcp) needs none, and for the token server the stored configuration names the environment
 * variable FT_MCP_TOKEN, which the client reads when it starts:
 * - Claude Code: `claude mcp add --transport http firetrident <url> --header 'Authorization: Bearer ${FT_MCP_TOKEN}'`,
 *   run without a shell, so the header is stored as written and Claude Code expands ${FT_MCP_TOKEN} itself.
 * - Codex CLI: `codex mcp add firetrident --url <url> --bearer-token-env-var FT_MCP_TOKEN`, which writes
 *   bearer_token_env_var into ~/.codex/config.toml.
 * An existing server of the same name is kept (`claude mcp get` / `codex mcp get` find it) unless `--force` replaces
 * it. A client whose command is missing, or a check that cannot tell, gets a plain sentence and the configuration to
 * write by hand, and nothing runs.
 */

/** The clients ft can install into. */
export const INSTALL_CLIENTS = ["claude", "codex"] as const;
/** One of them. */
export type InstallClient = (typeof INSTALL_CLIENTS)[number];

/** What `--install` asks for. */
export interface InstallSpec {
  client: InstallClient;
  /** The read-only server (/public/mcp, no token) instead of the token server. */
  readOnly: boolean;
  /** Replace a server of the same name. */
  force: boolean;
  /** Run without asking. */
  yes: boolean;
  /** Claude Code's scope: local (its default, this directory) or user (every directory). */
  scope?: "local" | "user";
}

/** What a client command did: its exit code (null when a signal ended it), its output, and `missing` when it could not be started. */
export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  missing?: boolean;
}

/** Runs one program with its arguments, never through a shell: the real one spawns, tests pass a fake. */
export type ProcessRunner = (command: string, args: readonly string[]) => Promise<RunResult>;

/** Longest output kept from one client command, and how long one may run. */
const OUTPUT_CHARS = 64_000;
const RUN_MS = 60_000;

/** The real runner: spawn without a shell (arguments reach the program as they are), output kept to OUTPUT_CHARS, killed after RUN_MS. */
export const nodeRunner: ProcessRunner = (command, args) =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, [...args], { shell: false, stdio: ["ignore", "pipe", "pipe"], timeout: RUN_MS });
    } catch {
      resolve({ code: null, stdout: "", stderr: "", missing: true });
      return;
    }
    child.stdout?.on("data", (d: Buffer) => void (stdout = (stdout + d.toString("utf8")).slice(0, OUTPUT_CHARS)));
    child.stderr?.on("data", (d: Buffer) => void (stderr = (stderr + d.toString("utf8")).slice(0, OUTPUT_CHARS)));
    child.on("error", (e: NodeJS.ErrnoException) => resolve({ code: null, stdout, stderr, ...(e.code === "ENOENT" || e.code === "EACCES" ? { missing: true } : {}) }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });

/** One question on the terminal, answered with a line. */
export async function terminalAsk(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/** The options `--install` brings to `ft connect`. */
export const INSTALL_OPTIONS: Record<string, { type: "string" | "boolean" }> = {
  install: { type: "string" },
  "read-only": { type: "boolean" },
  force: { type: "boolean" },
  yes: { type: "boolean" },
  scope: { type: "string" },
};

/** Each client's name, its command, and the client id its snippets have in core/connect.ts. */
const CLIENT: Record<InstallClient, { name: string; bin: string; snippets: string }> = {
  claude: { name: "Claude Code", bin: "claude", snippets: "claude-code" },
  codex: { name: "Codex CLI", bin: "codex", snippets: "codex" },
};

/**
 * `--install` and its options from `ft connect`'s parsed flags: undefined without --install, a usage error as a string.
 * `claude-code` is accepted for claude.
 */
export function parseInstall(v: Record<string, unknown>): InstallSpec | string | undefined {
  const raw = typeof v.install === "string" ? v.install.trim().toLowerCase() : undefined;
  if (raw === undefined) {
    const stray = ["read-only", "force", "yes", "scope"].find((k) => v[k] !== undefined);
    return stray ? `--${stray} goes with --install: ft connect --install claude|codex [--read-only] [--force] [--yes]` : undefined;
  }
  const client = raw === "claude-code" ? "claude" : raw;
  if (!(INSTALL_CLIENTS as readonly string[]).includes(client)) {
    return `ft connect --install takes claude or codex, got "${raw}": for Cursor, VS Code, Claude (the app) and plain HTTP, ft connect prints the configuration to copy`;
  }
  const spec: InstallSpec = { client: client as InstallClient, readOnly: v["read-only"] === true, force: v.force === true, yes: v.yes === true };
  if (v.scope !== undefined) {
    if (client !== "claude") return "--scope applies to Claude Code only: Codex CLI keeps its servers in ~/.codex/config.toml";
    if (v.scope !== "local" && v.scope !== "user") return `--scope must be local (this directory, Claude Code's default) or user (every directory), got "${String(v.scope)}"`;
    spec.scope = v.scope;
  }
  return spec;
}

/** What an install runs and says. */
export interface InstallPlan {
  client: InstallClient;
  /** The client's name, for sentences. */
  name: string;
  /** Its command. */
  bin: string;
  /** The server name it registers. */
  server: string;
  /** Arguments of the check for a server of that name. */
  check: string[];
  /** Arguments that remove one first, when --force replaces it; null when adding replaces it already. */
  remove: string[] | null;
  /** Arguments that add it. */
  add: string[];
  /** The environment variable the stored configuration names, or null for the read-only server. */
  envVar: string | null;
  /** The configuration to write by hand when nothing can run. */
  manual: ConnectSnippet[];
  /** What to do after it is added, one sentence each. */
  after: string[];
  /** What to ask the agent first. */
  prompt: string;
}

/** The plan for one client and server: the commands, the variable the configuration names, and the manual fallback. */
export function installPlan(info: ConnectInfo, spec: InstallSpec): InstallPlan {
  const c = CLIENT[spec.client];
  const access = spec.readOnly ? "public" : "token";
  const server = spec.readOnly ? PUBLIC_MCP_SERVER_NAME : MCP_SERVER_NAME;
  const variant = info.clients.find((x) => x.id === c.snippets)?.variants.find((x) => x.access === access);
  const manual = (variant?.snippets ?? []).filter((s) => s.kind !== "shell");
  const scope = spec.scope ? ["--scope", spec.scope] : [];
  const tokenAfter = `Set ${MCP_TOKEN_ENV} to the deployment's MCP token in the environment ${c.name} starts from, for example in your shell profile (export ${MCP_TOKEN_ENV}=<token>): the configuration names the variable, never the token.`;
  const readOnlyAfter = `No token is needed: ${info.publicUrl} changes nothing and answers for the colonies the deployment lists for public reads.`;
  if (spec.client === "claude") {
    return {
      client: "claude",
      name: c.name,
      bin: c.bin,
      server,
      check: ["mcp", "get", server],
      remove: ["mcp", "remove", server],
      add: spec.readOnly
        ? ["mcp", "add", "--transport", "http", ...scope, server, info.publicUrl]
        : ["mcp", "add", "--transport", "http", ...scope, server, info.tokenUrl, "--header", `Authorization: Bearer \${${MCP_TOKEN_ENV}}`],
      envVar: spec.readOnly ? null : MCP_TOKEN_ENV,
      manual,
      after: spec.readOnly ? [readOnlyAfter] : [tokenAfter, `Claude Code fills in \${${MCP_TOKEN_ENV}} each time it starts the server.`],
      prompt: info.prompts[access],
    };
  }
  return {
    client: "codex",
    name: c.name,
    bin: c.bin,
    server,
    check: ["mcp", "get", server],
    remove: null,
    add: spec.readOnly ? ["mcp", "add", server, "--url", info.publicUrl] : ["mcp", "add", server, "--url", info.tokenUrl, "--bearer-token-env-var", MCP_TOKEN_ENV],
    envVar: spec.readOnly ? null : MCP_TOKEN_ENV,
    manual,
    after: spec.readOnly
      ? [readOnlyAfter]
      : [tokenAfter, `Codex sends it as Authorization: Bearer. Add default_tools_approval_mode = "approve" and tool_timeout_sec = 120 under [mcp_servers.${server}] in ~/.codex/config.toml by hand: take and inbox wait up to 45 seconds.`],
    prompt: info.prompts[access],
  };
}

/** A command as a person would type it, each argument quoted for a POSIX shell when it needs it ('${VAR}' stays unexpanded). */
export function shellLine(bin: string, args: readonly string[]): string {
  return [bin, ...args].map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(" ");
}

/** What the install talks to: output, the question, the client commands, and the environment (to check no token is passed). */
export interface InstallIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  /** Ask one question and return the answer; absent when there is no terminal to ask. */
  ask?: (question: string) => Promise<string>;
  run?: ProcessRunner;
  env: Record<string, string | undefined>;
  c: Colors;
  dryRun: boolean;
  json: boolean;
}

/** The plan's configuration to write by hand, under a sentence saying why ft ran nothing. */
function manualLines(plan: InstallPlan, why: string): string[] {
  const out = [`${why} Add the server to ${plan.name} by hand:`];
  for (const s of plan.manual) {
    out.push(`  ${s.file ?? s.label}:`);
    for (const line of s.text.split("\n")) out.push(`    ${line}`);
  }
  if (plan.manual.length === 0) out.push(`  ${shellLine(plan.bin, plan.add)}`);
  if (plan.envVar) out.push(`  Then set ${plan.envVar} to the deployment's MCP token where ${plan.name} starts.`);
  return out;
}

/** Some text with the long-enough token values of `env` cut out of it, before it is printed. */
function scrub(text: string, env: Record<string, string | undefined>): string {
  let out = text;
  for (const k of [MCP_TOKEN_ENV, "FT_TOKEN"]) {
    const v = env[k]?.trim();
    if (v && v.length >= 8) out = out.split(v).join("***");
  }
  return out;
}

/** Whether any argument holds the value of a token in the environment (it never should: the check fails closed). */
function holdsToken(args: readonly string[], env: Record<string, string | undefined>): boolean {
  const values = [MCP_TOKEN_ENV, "FT_TOKEN"].map((k) => env[k]?.trim() ?? "").filter((v) => v.length >= 8);
  return args.some((a) => values.some((v) => a.includes(v)));
}

/** The client's own output, indented and dimmed, with any token value cut out (on stderr under --json, which keeps stdout for the answer). */
function echo(io: InstallIo, r: RunResult): void {
  const say = io.json ? io.stderr : io.stdout;
  for (const line of scrub(`${r.stdout}\n${r.stderr}`, io.env).split("\n").map((l) => l.trimEnd()).filter(Boolean).slice(0, 20)) say(io.c.dim(`    ${line}`));
}

/** Whether a check's answer says no server of that name exists (Claude Code and Codex both say "No MCP server named ..."). */
function saysAbsent(r: RunResult): boolean {
  return /no mcp server named/i.test(`${r.stdout}\n${r.stderr}`);
}

/**
 * Install the plan: check for a server of the same name, show the commands, ask (unless --yes), then run them. 0 when
 * the server was added (or --dry-run showed it), 1 when nothing changed: the client's command is missing, a server of
 * that name exists without --force, the check could not tell, there was no terminal to ask, the person said no, or a
 * command failed. Nothing it runs or prints holds a token.
 */
export async function runInstall(plan: InstallPlan, spec: InstallSpec, io: InstallIo): Promise<number> {
  const { c } = io;
  const commands = [plan.check, ...(plan.remove ? [plan.remove] : []), plan.add];
  if (commands.some((a) => holdsToken(a, io.env))) {
    io.stderr(manualLines(plan, "ft found a token value in the command it was about to run, so it ran nothing.").join("\n"));
    return 1;
  }
  if (io.dryRun) {
    const lines = [`ft would check for ${plan.server} in ${plan.name}: ${shellLine(plan.bin, plan.check)}`];
    if (spec.force && plan.remove) lines.push(`and, if it is there, remove it: ${shellLine(plan.bin, plan.remove)}`);
    lines.push(`then add it: ${shellLine(plan.bin, plan.add)}`);
    if (io.json) io.stdout(JSON.stringify({ client: plan.client, server: plan.server, check: [plan.bin, ...plan.check], remove: spec.force && plan.remove ? [plan.bin, ...plan.remove] : null, add: [plan.bin, ...plan.add], envVar: plan.envVar }, null, 2));
    else for (const l of lines) io.stdout(l);
    return 0;
  }
  if (!io.run) {
    io.stderr(manualLines(plan, `ft cannot run ${plan.bin} here, so it changed nothing.`).join("\n"));
    return 1;
  }
  const found = await io.run(plan.bin, plan.check);
  if (found.missing) {
    io.stderr(manualLines(plan, `${plan.name}'s command, ${plan.bin}, could not be started (it is not on your PATH), so ft changed nothing.`).join("\n"));
    return 1;
  }
  const exists = found.code === 0;
  if (!exists && !saysAbsent(found)) {
    io.stderr(manualLines(plan, `ft could not tell whether ${plan.name} already has a server named ${plan.server} (${shellLine(plan.bin, plan.check)} exited ${found.code ?? "on a signal"}), so it changed nothing.`).join("\n"));
    return 1;
  }
  if (exists && !spec.force) {
    io.stderr(`${plan.name} already has an MCP server named ${plan.server}, so ft changed nothing (${shellLine(plan.bin, plan.check)} shows it). To replace it: ft connect --install ${plan.client}${spec.readOnly ? " --read-only" : ""} --force`);
    return 1;
  }
  const steps = [...(exists && plan.remove ? [plan.remove] : []), plan.add];
  // Under --json, stdout keeps only the answer: what ft is about to do goes to stderr.
  const say = io.json ? io.stderr : io.stdout;
  say(`ft will ${exists ? "replace" : "add"} FireTrident's ${spec.readOnly ? "read-only " : ""}MCP server ${c.bold(plan.server)} in ${plan.name} by running:`);
  for (const s of steps) say(`  ${shellLine(plan.bin, s)}`);
  say(
    c.dim(
      plan.envVar
        ? `  The configuration names the environment variable ${plan.envVar}, never the token, and the command line holds no token.`
        : "  The read-only server needs no token.",
    ),
  );
  if (!spec.yes) {
    if (!io.ask) {
      io.stderr(`ft asks before it changes ${plan.name}'s configuration, and there is no terminal to ask: run it in one, or add --yes.`);
      return 1;
    }
    const answer = (await io.ask("Run it? [y/N] ")).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      say("Nothing was changed.");
      return 1;
    }
  }
  for (const s of steps) {
    const r = await io.run(plan.bin, s);
    echo(io, r);
    if (r.missing || r.code !== 0) {
      io.stderr(manualLines(plan, `${shellLine(plan.bin, s)} failed (${r.missing ? "it could not be started" : `exit ${r.code ?? "on a signal"}`}).`).join("\n"));
      return 1;
    }
  }
  if (io.json) {
    io.stdout(JSON.stringify({ client: plan.client, server: plan.server, installed: true, replaced: exists, envVar: plan.envVar }, null, 2));
    return 0;
  }
  io.stdout(`${c.green("✓")} ${exists ? "Replaced" : "Added"} ${c.bold(plan.server)} in ${plan.name}.`);
  for (const a of plan.after) io.stdout(`  ${a}`);
  io.stdout(c.dim(`  Then ask: ${plan.prompt}`));
  return 0;
}
