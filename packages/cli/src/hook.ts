import { mkdir, readFile, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { VERSION, accessHeaders, resolveBaseUrl } from "./api.ts";
import { connectSite, isConnectColony } from "./connect.ts";

/**
 * The Claude Code hook (`ft hook`): a heads-up before an agent edits a file.
 *
 * `ft hook install` writes a PreToolUse hook into `.claude/settings.local.json` of the agent's working directory, merged
 * with what is there: Claude Code's local project settings, never `.claude/settings.json`, which is committed (and
 * `.claude/` is a path FireTrident review holds for a person). Inside a git work tree it also lists the file in
 * `.git/info/exclude`, so `git add -A` in the take's commands never commits it. `ft hook uninstall` removes exactly the
 * entry and the exclude lines it added (and a file or directory left empty).
 *
 * The hook runs `ft hook check` before Edit, Write, MultiEdit and NotebookEdit. Claude Code hands it the tool call as JSON
 * on stdin (`tool_input.file_path`, absolute; `notebook_path` for notebooks; `cwd`). It finds the clone the file is in and
 * the colony and agent: --colony and --agent, else FT_COLONY and FT_AGENT_ID, else the clone's local git config
 * (`firetrident.agent`, which the take's git commands set where FT_HEADS_UP is on). It makes one read,
 * GET /api/colonies/:id/agents/:aid/headsup?path=<the file>, with the MCP token (FT_MCP_TOKEN) or the agent's resume key
 * (FT_RESUME_KEY), and gives up after CHECK_TIMEOUT_MS. When something waits it prints one line of JSON, Claude Code's
 * PreToolUse output with the sentence as `additionalContext` (Claude Code reads a PreToolUse hook's plain stdout into
 * its debug log only; additionalContext reaches the model next to the tool result). It never asks for a decision, so the
 * edit goes through the normal permission flow. Otherwise it prints nothing. It always exits 0: advisory, never in the way.
 */

/** The tools the hook runs before: Claude Code's file edit tools. */
export const HOOK_MATCHER = "Edit|Write|MultiEdit|NotebookEdit";
/** Seconds Claude Code gives the hook before it cancels it (the check itself gives up after CHECK_TIMEOUT_MS). */
export const HOOK_TIMEOUT_S = 5;
/** How long the check waits for the server (ms). */
export const CHECK_TIMEOUT_MS = 1_500;
/** Where the hook goes, under the agent's working directory: local settings, never committed. */
export const SETTINGS_FILE = ".claude/settings.local.json";
/** The local git config key that names the colony and agent of a clone ("<colony>/<agent>"). */
export const AGENT_CONFIG_KEY = "firetrident.agent";
/** The comment line `ft hook install` writes above its exclude entry, so uninstall finds exactly what it added. */
export const EXCLUDE_MARK = "# ft hook install: Claude Code's local settings, never committed";
/** Characters of an intent title the line keeps. */
const TITLE_CHARS = 80;
/** Bytes of stdin the check reads at most. */
const STDIN_BYTES = 1_000_000;
const AGENT_ID = /^[\w-]{1,100}$/;

/** `ft hook install | uninstall | check`. */
export interface HookCommand {
  name: "hook";
  action: "install" | "uninstall" | "check";
  colony?: string;
  agent?: string;
  dir?: string;
  /** check: print the bare sentence instead of Claude Code's JSON. */
  text: boolean;
}

/** What the hook commands use outside themselves; run.ts passes the process's, tests their own. */
export interface HookIo {
  env: Record<string, string | undefined>;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  fetch: typeof fetch;
  /** The hook's input (Claude Code writes the tool call as JSON); "" when there is none. */
  stdin: () => Promise<string>;
  cwd: () => string;
}

type Json = Record<string, unknown>;

function isObject(x: unknown): x is Json {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

/** Whether a hook command is the check `ft hook install` writes. */
export function isCheckCommand(command: unknown): boolean {
  return typeof command === "string" && /^ft hook check(?:\s|$)/.test(command.trim());
}

/** The command the hook runs: `ft hook check` with the colony, agent and server it was installed for. */
export function checkCommand(opts: { colony?: string; agent?: string; url?: string }): string {
  return ["ft hook check", opts.colony ? `--colony ${opts.colony}` : "", opts.agent ? `--agent ${opts.agent}` : "", opts.url ? `--url ${opts.url}` : ""].filter(Boolean).join(" ");
}

/**
 * Local settings text with the hook added (an earlier `ft hook check` entry replaced): Claude Code's hooks format,
 * `hooks.PreToolUse[]` of `{ matcher, hooks: [{ type: "command", command, timeout }] }`. `text` null or blank is a new
 * file. Throws when the file is not a JSON object, or its hooks are not in that shape: nothing is overwritten then.
 */
export function withHook(text: string | null, command: string): string {
  const settings: unknown = text === null || text.trim() === "" ? {} : JSON.parse(text);
  if (!isObject(settings)) throw new Error("it is not a JSON object");
  const hooks = settings.hooks ?? {};
  if (!isObject(hooks)) throw new Error("its hooks are not an object");
  const pre = hooks.PreToolUse ?? [];
  if (!Array.isArray(pre)) throw new Error("its hooks.PreToolUse is not a list");
  const kept = stripChecks(pre).groups;
  kept.push({ matcher: HOOK_MATCHER, hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_S }] });
  settings.hooks = { ...hooks, PreToolUse: kept };
  return `${JSON.stringify(settings, null, 2)}\n`;
}

/** PreToolUse groups without the checks `ft hook install` wrote (a group left with no hook goes), and how many went. */
function stripChecks(groups: unknown[]): { groups: unknown[]; removed: number } {
  let removed = 0;
  const out: unknown[] = [];
  for (const g of groups) {
    if (!isObject(g) || !Array.isArray(g.hooks)) {
      out.push(g);
      continue;
    }
    const hooks = g.hooks.filter((h) => !(isObject(h) && isCheckCommand(h.command)));
    removed += g.hooks.length - hooks.length;
    if (hooks.length === g.hooks.length) out.push(g);
    else if (hooks.length > 0) out.push({ ...g, hooks });
  }
  return { groups: out, removed };
}

/**
 * Local settings text without the hook: the `ft hook check` entries go, and the PreToolUse list, the hooks object and the
 * file itself when that leaves them empty (text null: delete the file). `removed` counts the entries.
 */
export function withoutHook(text: string | null): { text: string | null; removed: number } {
  if (text === null || text.trim() === "") return { text, removed: 0 };
  const settings: unknown = JSON.parse(text);
  if (!isObject(settings) || !isObject(settings.hooks) || !Array.isArray(settings.hooks.PreToolUse)) return { text, removed: 0 };
  const { groups, removed } = stripChecks(settings.hooks.PreToolUse);
  if (removed === 0) return { text, removed: 0 };
  const hooks: Json = { ...settings.hooks, PreToolUse: groups };
  if (groups.length === 0) delete hooks.PreToolUse;
  if (Object.keys(hooks).length === 0) delete settings.hooks;
  else settings.hooks = hooks;
  return { text: Object.keys(settings).length === 0 ? null : `${JSON.stringify(settings, null, 2)}\n`, removed };
}

/** An exclude file's text with the entry (and its mark) added, unless the entry is already there; null when unchanged. */
export function withExclude(text: string | null, entry: string): string | null {
  const lines = (text ?? "").split("\n");
  if (lines.some((l) => l.trim() === entry)) return null;
  const body = (text ?? "").replace(/\n*$/, "");
  return `${body === "" ? "" : `${body}\n`}${EXCLUDE_MARK}\n${entry}\n`;
}

/** An exclude file's text without the mark and the entry right after it; null when they are not there. */
export function withoutExclude(text: string | null, entry: string): string | null {
  if (text === null) return null;
  const lines = text.split("\n");
  const at = lines.findIndex((l, i) => l === EXCLUDE_MARK && lines[i + 1]?.trim() === entry);
  if (at < 0) return null;
  lines.splice(at, 2);
  return lines.join("\n");
}

/** The colony and agent a clone's local git config names (`[firetrident] agent = <colony>/<agent>`), or null. */
export function agentFromGitConfig(text: string): { colony: string; agent: string } | null {
  let section = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const head = /^\[\s*([^\]\s"]+)(?:\s+"[^"]*")?\s*\]$/.exec(line);
    if (head) {
      section = (head[1] ?? "").toLowerCase();
      continue;
    }
    const kv = /^([A-Za-z][\w-]*)\s*=\s*(.*)$/.exec(line);
    if (section !== "firetrident" || !kv || kv[1]?.toLowerCase() !== "agent") continue;
    const m = /^"?([a-z0-9-]+)\/([\w-]+)"?$/.exec((kv[2] ?? "").trim());
    if (m && isConnectColony(m[1]) && AGENT_ID.test(m[2] ?? "")) return { colony: m[1]!, agent: m[2]! };
  }
  return null;
}

/** Text from the server, as one printable line, cut to `max`. */
function plain(text: unknown, max = TITLE_CHARS): string {
  const t = (typeof text === "string" ? text : "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().replace(/'/g, "’");
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** One entry of a heads-up as the line reads it. */
interface Entry {
  id: string;
  title: string;
  paths: string[];
}

function entries(list: unknown, idKey: "landingId" | "proposalId"): Entry[] {
  if (!Array.isArray(list)) return [];
  return list.flatMap((e) => {
    if (!isObject(e) || typeof e[idKey] !== "string") return [];
    const paths = Array.isArray(e.paths) ? e.paths.filter((p): p is string => typeof p === "string" && p !== "") : [];
    return paths.length > 0 ? [{ id: plain(e[idKey], 100), title: plain(e.title), paths: paths.map((p) => plain(p, 300)) }] : [];
  });
}

/**
 * The one line the hook prints for a heads-up (GET .../headsup's `headsUp`), or null when nothing waits. The file about
 * to be edited comes first: trunk moved under it, then a change waiting to land that writes it; else the newest landing
 * on the agent's files, then the oldest waiting change.
 */
export function headsUpLine(headsUp: unknown, path: string | null): string | null {
  if (!isObject(headsUp)) return null;
  const moved = entries(headsUp.moved, "landingId");
  const ahead = entries(headsUp.ahead, "proposalId");
  const total = moved.length + ahead.length + (typeof headsUp.moreMoved === "number" ? headsUp.moreMoved : 0) + (typeof headsUp.moreAhead === "number" ? headsUp.moreAhead : 0);
  const more = total > 1 ? ` and ${total - 1} more` : "";
  const end = "; call inbox before you edit.";
  const here = path ? moved.find((m) => m.paths.includes(path)) : undefined;
  if (here && path) return `FireTrident: trunk moved under ${path} (${here.id}, '${here.title}')${more}${end}`;
  const waiting = path ? ahead.find((a) => a.paths.includes(path)) : undefined;
  if (waiting && path) return `FireTrident: a change waiting to land writes ${path} (${waiting.id}, '${waiting.title}')${more}${end}`;
  const m = moved[0];
  if (m) return `FireTrident: trunk moved under ${m.paths[0]} since your lease (${m.id}, '${m.title}')${more}${end}`;
  const a = ahead[0];
  if (a) return `FireTrident: a change waiting to land writes ${a.paths[0]} (${a.id}, '${a.title}')${more}${end}`;
  return null;
}

/** Claude Code's PreToolUse output carrying the line to the model (no decision: the normal permission flow goes on). */
export function hookOutput(line: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: line } });
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/**
 * The git work tree holding `start`: its root, and the git directory whose config and info/exclude apply (a linked
 * worktree's `.git` file points at its own directory, whose `commondir` holds info/exclude). Null outside one.
 */
export async function findRepo(start: string): Promise<{ root: string; gitDir: string; commonDir: string } | null> {
  let dir = resolve(start);
  for (;;) {
    const dotGit = join(dir, ".git");
    try {
      const s = await stat(dotGit);
      if (s.isDirectory()) return { root: dir, gitDir: dotGit, commonDir: dotGit };
      const pointer = /^gitdir:\s*(.+)$/m.exec(await readFile(dotGit, "utf8"))?.[1]?.trim();
      if (pointer) {
        const gitDir = resolve(dir, pointer);
        const common = (await readText(join(gitDir, "commondir")))?.trim();
        return { root: dir, gitDir, commonDir: common ? resolve(gitDir, common) : gitDir };
      }
    } catch {
      // No .git here: look further up.
    }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** Where `ft hook install` writes, and the exclude entry for it when the directory is in a git work tree. */
async function targets(dir: string): Promise<{ file: string; exclude: { path: string; entry: string } | null }> {
  const file = join(dir, SETTINGS_FILE);
  const repo = await findRepo(dir);
  if (!repo) return { file, exclude: null };
  const rel = relative(repo.root, file).split(sep).join("/");
  return { file, exclude: rel.startsWith("..") ? null : { path: join(repo.commonDir, "info", "exclude"), entry: `/${rel}` } };
}

/** `ft hook install`: merge the hook into the local settings and keep the file out of git. 0, or 1 when the file is not ours to merge. */
export async function installHook(cmd: HookCommand, url: string | undefined, io: HookIo): Promise<number> {
  const dir = resolve(io.cwd(), cmd.dir ?? ".");
  const { file, exclude } = await targets(dir);
  const command = checkCommand({ ...(cmd.colony ? { colony: cmd.colony } : {}), ...(cmd.agent ? { agent: cmd.agent } : {}), ...(url ? { url } : {}) });
  let text: string;
  try {
    text = withHook(await readText(file), command);
  } catch (e) {
    io.stderr(`ft: ${file} was left as it is: ${(e as Error).message}. Fix or move it, then run ft hook install again.`);
    return 1;
  }
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
  if (exclude) {
    const next = withExclude(await readText(exclude.path), exclude.entry);
    if (next !== null) {
      await mkdir(dirname(exclude.path), { recursive: true });
      await writeFile(exclude.path, next);
    }
  }
  io.stdout(`Installed the FireTrident hook in ${file}: before each ${HOOK_MATCHER.split("|").join(", ").replace(/, (?=[^,]*$)/, " and ")} call, Claude Code runs ${command}.`);
  io.stdout(
    exclude
      ? `It is local to this checkout and never committed (.git/info/exclude lists ${exclude.entry}). The hook runs ft, so keep ft on PATH; ft hook uninstall removes it.`
      : "It is local to this directory and never committed. The hook runs ft, so keep ft on PATH; ft hook uninstall removes it.",
  );
  return 0;
}

/** `ft hook uninstall`: remove exactly what install added. Always 0 (nothing to remove is fine), 1 when the file is not JSON. */
export async function uninstallHook(cmd: HookCommand, io: HookIo): Promise<number> {
  const dir = resolve(io.cwd(), cmd.dir ?? ".");
  const { file, exclude } = await targets(dir);
  let result: { text: string | null; removed: number };
  try {
    result = withoutHook(await readText(file));
  } catch (e) {
    io.stderr(`ft: ${file} was left as it is: it is not valid JSON (${(e as Error).message}).`);
    return 1;
  }
  if (result.removed > 0) {
    if (result.text === null) {
      await rm(file, { force: true });
      // The .claude directory goes too when the file was all it held.
      await rmdir(dirname(file)).catch(() => undefined);
    } else {
      await writeFile(file, result.text);
    }
  }
  if (exclude) {
    const next = withoutExclude(await readText(exclude.path), exclude.entry);
    if (next !== null) await writeFile(exclude.path, next);
  }
  io.stdout(result.removed > 0 ? `Removed the FireTrident hook from ${file}.` : `No FireTrident hook in ${file}: nothing to remove.`);
  return 0;
}

/** The repository path of the file a hook input is about, the clone it is in, and that clone's colony and agent. */
async function hookTarget(input: string, io: HookIo): Promise<{ path: string | null; config: { colony: string; agent: string } | null }> {
  let call: unknown = null;
  try {
    call = input.trim() === "" ? null : JSON.parse(input);
  } catch {
    call = null;
  }
  const toolInput = isObject(call) && isObject(call.tool_input) ? call.tool_input : {};
  const raw = typeof toolInput.file_path === "string" ? toolInput.file_path : typeof toolInput.notebook_path === "string" ? toolInput.notebook_path : "";
  const cwd = isObject(call) && typeof call.cwd === "string" && call.cwd !== "" ? call.cwd : io.cwd();
  if (!raw) {
    const repo = await findRepo(cwd);
    return { path: null, config: repo ? agentFromGitConfig((await readText(join(repo.gitDir, "config"))) ?? "") : null };
  }
  const file = isAbsolute(raw) ? raw : resolve(cwd, raw);
  const repo = await findRepo(dirname(file));
  if (!repo) return { path: null, config: null };
  const rel = relative(repo.root, file).split(sep).join("/");
  return { path: rel === "" || rel.startsWith("..") ? null : rel, config: agentFromGitConfig((await readText(join(repo.gitDir, "config"))) ?? "") };
}

/**
 * `ft hook check`: one read of the agent's heads-up, one line when something waits, nothing otherwise. Never throws and
 * always answers 0: no colony or agent known, an unreachable or slow server, a refusal or a bad answer all print nothing.
 */
export async function checkHook(cmd: HookCommand, flagUrl: string | undefined, io: HookIo): Promise<number> {
  try {
    const { path, config } = await hookTarget(await io.stdin(), io);
    const colony = cmd.colony ?? (io.env.FT_COLONY?.trim() || undefined) ?? config?.colony;
    const sameClone = config && (!colony || config.colony === colony);
    const agent = cmd.agent ?? (io.env.FT_AGENT_ID?.trim() || undefined) ?? (sameClone ? config.agent : undefined);
    if (!colony || !agent || !isConnectColony(colony) || !AGENT_ID.test(agent)) return 0;
    const base = resolveBaseUrl(flagUrl, io.env);
    const url = `${base}/api/colonies/${colony}/agents/${agent}/headsup${path ? `?path=${encodeURIComponent(path)}` : ""}`;
    const headers: Record<string, string> = { accept: "application/json", "user-agent": `ft/${VERSION} hook` };
    const token = io.env.FT_MCP_TOKEN?.trim();
    if (token) headers.authorization = `Bearer ${token}`;
    const key = io.env.FT_RESUME_KEY?.trim();
    if (key) headers["x-ft-resume-key"] = key;
    try {
      Object.assign(headers, accessHeaders(io.env) ?? {});
    } catch {
      // Half the Access pair: ask without it.
    }
    const res = await io.fetch(url, { headers, signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
    if (!res.ok) return 0;
    const body = (await res.json()) as unknown;
    const line = headsUpLine(isObject(body) ? body.headsUp : null, path);
    if (line) io.stdout(cmd.text ? line : hookOutput(line));
  } catch {
    // Advisory: whatever failed, the edit goes on.
  }
  return 0;
}

/** Read stdin to its end (at most STDIN_BYTES), or "" when it is a terminal or says nothing within `ms`. */
export function readStdin(ms = 500): Promise<string> {
  const input = process.stdin;
  if (input.isTTY) return Promise.resolve("");
  return new Promise((done) => {
    let text = "";
    const finish = (): void => {
      clearTimeout(timer);
      input.removeAllListeners("data");
      // Nothing more is read: a stdin left open must not keep the process alive.
      input.destroy();
      done(text);
    };
    const timer = setTimeout(finish, ms);
    input.setEncoding("utf8");
    input.on("data", (chunk: string) => {
      text += chunk;
      if (text.length > STDIN_BYTES) finish();
    });
    input.once("end", finish);
    input.once("error", finish);
  });
}

/** Run `ft hook <action>`. `url` is --url as given; install writes it, or FT_URL, into the hook's command. */
export async function runHook(cmd: HookCommand, flagUrl: string | undefined, io: HookIo): Promise<number> {
  if (cmd.action === "check") return checkHook(cmd, flagUrl, io);
  if (cmd.action === "uninstall") return uninstallHook(cmd, io);
  const url = (flagUrl ?? io.env.FT_URL)?.trim() ? connectSite(resolveBaseUrl(flagUrl, io.env)) : undefined;
  if (url === null) {
    io.stderr("ft: the hook names its server by origin only (such as https://firetrident.com): pass --url with no path or query.");
    return 2;
  }
  return installHook(cmd, url, io);
}
