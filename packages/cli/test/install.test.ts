import { describe, expect, it } from "vitest";
import { connectInfo } from "@fire_trident/core";
import { helpText, parseCommand } from "../src/args.ts";
import { installPlan, parseInstall, shellLine, type ProcessRunner, type RunResult } from "../src/install.ts";
import { main, type Io } from "../src/run.ts";

/**
 * `ft connect --install claude|codex`: the client's own command adds FireTrident's MCP server, after ft shows it and
 * asks. Every process here is a fake: nothing is spawned, and no request is sent.
 */

const TOKEN = "tok_live_0123456789abcdef";

interface Ran {
  command: string;
  args: string[];
}

/** A runner that answers each command from `answer` and records what it was asked to run. */
function runner(answer: (r: Ran) => RunResult): ProcessRunner & { ran: Ran[] } {
  const ran: Ran[] = [];
  const run = (async (command: string, args: readonly string[]) => {
    const r = { command, args: [...args] };
    ran.push(r);
    return answer(r);
  }) as ProcessRunner & { ran: Ran[] };
  run.ran = ran;
  return run;
}

const ABSENT: RunResult = { code: 1, stdout: 'No MCP server named "firetrident". Run `claude mcp add` to add one.', stderr: "" };
const PRESENT: RunResult = { code: 0, stdout: "firetrident:\n  Headers:\n    Authorization: Bearer tok_live_0123456789abcdef", stderr: "" };
const ADDED: RunResult = { code: 0, stdout: "Added HTTP MCP server firetrident", stderr: "" };

/** An Io with a fake runner and, when `answers` is given, a terminal that answers each question in turn. */
function io(run: ProcessRunner | undefined, answers?: string[], env: Record<string, string> = {}): Io & { out: string[]; err: string[]; asked: string[]; sent: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  const sent: string[] = [];
  const t: Io & { out: string[]; err: string[]; asked: string[]; sent: string[] } = {
    env: { FT_URL: "https://ft.example", FT_USER: "tester", NO_COLOR: "1", FT_MCP_TOKEN: TOKEN, ...env },
    stdout: (l) => void out.push(l),
    stderr: (l) => void err.push(l),
    isTTY: false,
    fetch: (async (input: string | URL | Request) => {
      sent.push(String(input));
      throw new Error("connect sent a request");
    }) as typeof globalThis.fetch,
    readFile: async () => {
      throw new Error("no config file");
    },
    sleep: async () => {},
    now: () => 0,
    WebSocket: globalThis.WebSocket,
    onInterrupt: () => {},
    out,
    err,
    asked,
    sent,
  };
  if (run) t.run = run;
  if (answers) {
    const queue = [...answers];
    t.ask = async (q) => {
      asked.push(q);
      return queue.shift() ?? "";
    };
  }
  return t;
}

describe("ft connect --install: parsing", () => {
  it("takes claude (or claude-code) and codex with their options, and refuses the rest", () => {
    expect(parseCommand(["connect", "--install", "claude"])).toMatchObject({ ok: true, command: { name: "connect", install: { client: "claude", readOnly: false, force: false, yes: false } } });
    expect(parseCommand(["connect", "hono", "--install", "claude-code", "--read-only", "--force", "--yes", "--scope", "user"])).toMatchObject({
      ok: true,
      command: { name: "connect", colony: "hono", install: { client: "claude", readOnly: true, force: true, yes: true, scope: "user" } },
    });
    expect(parseCommand(["connect", "--install", "codex"])).toMatchObject({ ok: true, command: { install: { client: "codex" } } });
    // Without --install, nothing changes for ft connect.
    expect(parseCommand(["connect"])).toEqual({ ok: true, command: { name: "connect" }, flags: { json: false, dryRun: false } });
    const cursor = parseCommand(["connect", "--install", "cursor"]);
    expect(cursor.ok).toBe(false);
    if (!cursor.ok) expect(cursor.error).toContain("for Cursor, VS Code, Claude (the app) and plain HTTP, ft connect prints the configuration to copy");
    expect(parseInstall({ force: true })).toBe("--force goes with --install: ft connect --install claude|codex [--read-only] [--force] [--yes]");
    expect(parseInstall({ install: "codex", scope: "user" })).toContain("--scope applies to Claude Code only");
    expect(parseInstall({ install: "claude", scope: "project" })).toContain("--scope must be local");
    expect(helpText("connect")).toContain("--install claude|codex");
    expect(helpText()).toContain("connect --install claude|codex");
  });
});

describe("ft connect --install: the commands", () => {
  const info = connectInfo("https://ft.example", "hono");

  it("Claude Code: the token server names ${FT_MCP_TOKEN} in its header, unexpanded; the read-only one needs no header", () => {
    const token = installPlan(info, { client: "claude", readOnly: false, force: false, yes: false });
    expect(token.add).toEqual(["mcp", "add", "--transport", "http", "firetrident", "https://ft.example/mcp", "--header", "Authorization: Bearer ${FT_MCP_TOKEN}"]);
    expect(token.check).toEqual(["mcp", "get", "firetrident"]);
    expect(token.remove).toEqual(["mcp", "remove", "firetrident"]);
    expect(token.envVar).toBe("FT_MCP_TOKEN");
    // As a person would type it, the single quotes keep their shell from expanding the variable.
    expect(shellLine(token.bin, token.add)).toBe("claude mcp add --transport http firetrident https://ft.example/mcp --header 'Authorization: Bearer ${FT_MCP_TOKEN}'");
    const pub = installPlan(info, { client: "claude", readOnly: true, force: false, yes: false, scope: "user" });
    expect(pub.add).toEqual(["mcp", "add", "--transport", "http", "--scope", "user", "firetrident-public", "https://ft.example/public/mcp"]);
    expect(pub.envVar).toBeNull();
  });

  it("Codex CLI: the token server names the variable with --bearer-token-env-var, and adding replaces, so nothing is removed", () => {
    const token = installPlan(info, { client: "codex", readOnly: false, force: true, yes: false });
    expect(token.add).toEqual(["mcp", "add", "firetrident", "--url", "https://ft.example/mcp", "--bearer-token-env-var", "FT_MCP_TOKEN"]);
    expect(token.remove).toBeNull();
    expect(token.after.join(" ")).toContain('default_tools_approval_mode = "approve"');
    expect(installPlan(info, { client: "codex", readOnly: true, force: false, yes: false }).add).toEqual(["mcp", "add", "firetrident-public", "--url", "https://ft.example/public/mcp"]);
  });
});

describe("ft connect --install: running", () => {
  it("checks, shows the command, asks, then adds, and no argument ever holds the token", async () => {
    const run = runner((r) => (r.args[1] === "get" ? ABSENT : ADDED));
    const t = io(run, ["y"]);
    expect(await main(["connect", "hono", "--install", "claude"], t)).toBe(0);
    expect(run.ran.map((r) => [r.command, ...r.args].join(" "))).toEqual([
      "claude mcp get firetrident",
      "claude mcp add --transport http firetrident https://ft.example/mcp --header Authorization: Bearer ${FT_MCP_TOKEN}",
    ]);
    expect(run.ran.every((r) => r.args.every((a) => !a.includes(TOKEN)))).toBe(true);
    expect(t.asked).toEqual(["Run it? [y/N] "]);
    const text = t.out.join("\n");
    expect(text).toContain("ft will add FireTrident's MCP server firetrident in Claude Code by running:");
    expect(text).toContain("claude mcp add --transport http firetrident https://ft.example/mcp --header 'Authorization: Bearer ${FT_MCP_TOKEN}'");
    expect(text).toContain("✓ Added firetrident in Claude Code.");
    expect(text).toContain("Set FT_MCP_TOKEN to the deployment's MCP token in the environment Claude Code starts from");
    expect(text).toContain('Join the FireTrident colony "hono"');
    expect(text).not.toContain(TOKEN);
    expect(t.sent).toEqual([]);
  });

  it("keeps a server of the same name unless --force, and never prints what the check showed", async () => {
    const run = runner((r) => (r.args[1] === "get" ? PRESENT : ADDED));
    const t = io(run, ["y"]);
    expect(await main(["connect", "--install", "claude"], t)).toBe(1);
    expect(run.ran.map((r) => r.args[1])).toEqual(["get"]);
    expect(t.err.join("\n")).toBe("Claude Code already has an MCP server named firetrident, so ft changed nothing (claude mcp get firetrident shows it). To replace it: ft connect --install claude --force");
    expect([...t.out, ...t.err].join("\n")).not.toContain(TOKEN);
    expect(t.asked).toEqual([]);
  });

  it("--force removes Claude Code's server first, then adds it; Codex's add replaces it in one step", async () => {
    const claude = runner((r) => (r.args[1] === "get" ? PRESENT : ADDED));
    const a = io(claude, ["yes"]);
    expect(await main(["connect", "--install", "claude", "--force"], a)).toBe(0);
    expect(claude.ran.map((r) => r.args.slice(0, 3).join(" "))).toEqual(["mcp get firetrident", "mcp remove firetrident", "mcp add --transport"]);
    expect(a.out.join("\n")).toContain("✓ Replaced firetrident in Claude Code.");
    const codex = runner((r) => (r.args[1] === "get" ? { code: 0, stdout: "firetrident", stderr: "" } : ADDED));
    const b = io(codex, undefined);
    expect(await main(["connect", "--install", "codex", "--force", "--yes"], b)).toBe(0);
    expect(codex.ran.map((r) => r.args.join(" "))).toEqual(["mcp get firetrident", "mcp add firetrident --url https://ft.example/mcp --bearer-token-env-var FT_MCP_TOKEN"]);
    expect(b.out.join("\n")).toContain("tool_timeout_sec = 120");
  });

  it("a missing client command gets a plain sentence and the configuration to write by hand, and nothing runs after", async () => {
    const run = runner(() => ({ code: null, stdout: "", stderr: "", missing: true }));
    const t = io(run, ["y"]);
    expect(await main(["connect", "--install", "codex"], t)).toBe(1);
    expect(run.ran).toHaveLength(1);
    const text = t.err.join("\n");
    expect(text).toContain("Codex CLI's command, codex, could not be started (it is not on your PATH), so ft changed nothing. Add the server to Codex CLI by hand:");
    expect(text).toContain("~/.codex/config.toml:");
    expect(text).toContain('bearer_token_env_var = "FT_MCP_TOKEN"');
    expect(text).toContain("Then set FT_MCP_TOKEN to the deployment's MCP token where Codex CLI starts.");
  });

  it("a check that cannot tell changes nothing", async () => {
    const run = runner(() => ({ code: 2, stdout: "", stderr: "config file is not valid" }));
    const t = io(run, ["y"]);
    expect(await main(["connect", "--install", "claude"], t)).toBe(1);
    expect(run.ran).toHaveLength(1);
    expect(t.err.join("\n")).toContain("ft could not tell whether Claude Code already has a server named firetrident (claude mcp get firetrident exited 2), so it changed nothing.");
  });

  it("asks before it runs: no terminal and no --yes refuses, no means no, --yes skips the question", async () => {
    const quiet = runner((r) => (r.args[1] === "get" ? ABSENT : ADDED));
    const a = io(quiet);
    expect(await main(["connect", "--install", "claude"], a)).toBe(1);
    expect(a.err.join("\n")).toBe("ft asks before it changes Claude Code's configuration, and there is no terminal to ask: run it in one, or add --yes.");
    expect(quiet.ran.map((r) => r.args[1])).toEqual(["get"]);
    const no = runner((r) => (r.args[1] === "get" ? ABSENT : ADDED));
    const b = io(no, ["n"]);
    expect(await main(["connect", "--install", "claude"], b)).toBe(1);
    expect(b.out.at(-1)).toBe("Nothing was changed.");
    expect(no.ran.map((r) => r.args[1])).toEqual(["get"]);
    const yes = runner((r) => (r.args[1] === "get" ? ABSENT : ADDED));
    const c = io(yes, []);
    expect(await main(["connect", "--install", "claude", "--read-only", "--yes"], c)).toBe(0);
    expect(c.asked).toEqual([]);
    expect(yes.ran.at(-1)!.args).toEqual(["mcp", "add", "--transport", "http", "firetrident-public", "https://ft.example/public/mcp"]);
    expect(c.out.join("\n")).toContain("No token is needed: https://ft.example/public/mcp changes nothing");
  });

  it("--dry-run shows the commands and runs nothing; without a runner it prints the manual configuration", async () => {
    const run = runner(() => ADDED);
    const t = io(run, ["y"]);
    expect(await main(["connect", "--install", "claude", "--force", "--dry-run"], t)).toBe(0);
    expect(run.ran).toEqual([]);
    expect(t.out).toEqual([
      "ft would check for firetrident in Claude Code: claude mcp get firetrident",
      "and, if it is there, remove it: claude mcp remove firetrident",
      "then add it: claude mcp add --transport http firetrident https://ft.example/mcp --header 'Authorization: Bearer ${FT_MCP_TOKEN}'",
    ]);
    const none = io(undefined, ["y"]);
    expect(await main(["connect", "--install", "claude"], none)).toBe(1);
    expect(none.err.join("\n")).toContain("ft cannot run claude here, so it changed nothing. Add the server to Claude Code by hand:");
    expect(none.err.join("\n")).toContain('"Authorization": "Bearer ${FT_MCP_TOKEN}"');
  });

  it("a failed add says so with the manual configuration, and the client's own output never shows a token", async () => {
    const run = runner((r) => (r.args[1] === "get" ? ABSENT : { code: 1, stdout: "", stderr: `could not write config with ${TOKEN}` }));
    const t = io(run, ["y"]);
    expect(await main(["connect", "--install", "claude"], t)).toBe(1);
    expect(t.out.join("\n")).toContain("could not write config with ***");
    expect([...t.out, ...t.err].join("\n")).not.toContain(TOKEN);
    expect(t.err.join("\n")).toContain("failed (exit 1). Add the server to Claude Code by hand:");
  });
});

describe("ft connect --install --json", () => {
  it("keeps stdout for the answer: what ft is about to do and the client's output go to stderr", async () => {
    const run = runner((r) => (r.args[1] === "get" ? ABSENT : ADDED));
    const t = io(run, undefined);
    expect(await main(["connect", "--install", "codex", "--yes", "--json"], t)).toBe(0);
    expect(JSON.parse(t.out.join("\n"))).toEqual({ client: "codex", server: "firetrident", installed: true, replaced: false, envVar: "FT_MCP_TOKEN" });
    expect(t.err.join("\n")).toContain("ft will add FireTrident's MCP server firetrident in Codex CLI by running:");
  });
});
