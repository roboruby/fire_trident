import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { helpText, parseCommand } from "../src/args.ts";
import { EXCLUDE_MARK, HOOK_MATCHER, SETTINGS_FILE, agentFromGitConfig, headsUpLine, hookOutput, withHook, withoutHook } from "../src/hook.ts";
import { main, type Io } from "../src/run.ts";

/**
 * `ft hook`: the Claude Code PreToolUse hook. install merges into the local settings (never the committed ones) and keeps
 * them out of git; uninstall removes exactly what it added; check prints one line or nothing and always exits 0, and a
 * heads-up it could not get prints a line saying so rather than nothing.
 */

const temporary: string[] = [];
afterAll(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ft-hook-"));
  temporary.push(dir);
  return dir;
}

type Asked = { url: string; headers: Record<string, string> };

/** An Io that records what it prints and answers requests with `answer` (or throws it). */
function io(opts: { env?: Record<string, string>; stdin?: string; cwd?: string; answer?: (url: string, init: RequestInit) => Promise<Response> } = {}): Io & { out: string[]; err: string[]; asked: Asked[] } {
  const out: string[] = [];
  const err: string[] = [];
  const asked: Asked[] = [];
  return {
    env: { NO_COLOR: "1", FT_URL: "https://ft.example", ...opts.env },
    stdout: (l) => void out.push(l),
    stderr: (l) => void err.push(l),
    isTTY: false,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      asked.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
      if (!opts.answer) throw new Error("no request expected");
      return opts.answer(String(input), init ?? {});
    }) as typeof globalThis.fetch,
    readFile: async () => {
      throw new Error("no config file");
    },
    sleep: async () => {},
    now: () => 0,
    WebSocket: globalThis.WebSocket,
    onInterrupt: () => {},
    stdin: async () => opts.stdin ?? "",
    cwd: () => opts.cwd ?? process.cwd(),
    out,
    err,
    asked,
  };
}

const HEADS_UP = {
  agentId: "agt_1",
  intentId: "int_1",
  baseSha: "b".repeat(40),
  headsUp: {
    moved: [{ landingId: "lnd_y", at: 1, intentId: "int_y", title: "Cache 'lookups'\nnow", paths: ["src/x.ts"] }],
    ahead: [{ proposalId: "prp_z", intentId: "int_z", title: "Rename the flag", region: "src", paths: ["src/w.ts"] }],
  },
};

const json = (body: unknown, status = 200): Promise<Response> => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

describe("ft hook: parsing", () => {
  it("takes install, uninstall or check with their flags, and refuses anything else", () => {
    expect(parseCommand(["hook", "install", "--colony", "hono"])).toMatchObject({ ok: true, command: { name: "hook", action: "install", colony: "hono", text: false } });
    expect(parseCommand(["hook", "check", "--agent", "agt_1", "--text"])).toMatchObject({ ok: true, command: { name: "hook", action: "check", agent: "agt_1", text: true } });
    expect(parseCommand(["hook", "uninstall", "--dir", "x"])).toMatchObject({ ok: true, command: { name: "hook", action: "uninstall", dir: "x" } });
    expect(parseCommand(["hook"]).ok).toBe(false);
    expect(parseCommand(["hook", "remove"]).ok).toBe(false);
    expect(parseCommand(["hook", "install", "--colony", "Not A Colony"]).ok).toBe(false);
    expect(parseCommand(["hook", "uninstall", "--colony", "hono"]).ok).toBe(false);
    expect(helpText("hook")).toMatch(/^ft hook install/);
    expect(helpText()).toContain("hook install [--colony <id>]");
  });
});

describe("ft hook install and uninstall", () => {
  const existing = {
    permissions: { allow: ["Bash(git:*)"] },
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./audit.sh" }] }], Stop: [{ hooks: [{ type: "command", command: "say done" }] }] },
  };

  it("merges into an existing settings.local.json, keeps everything there, and uninstall restores it", async () => {
    const dir = tempDir();
    const file = join(dir, SETTINGS_FILE);
    mkdirSync(join(dir, ".claude"));
    const original = `${JSON.stringify(existing, null, 2)}\n`;
    writeFileSync(file, original);
    const t = io({ cwd: dir });
    expect(await main(["hook", "install", "--colony", "hono", "--agent", "agt_1"], t)).toBe(0);
    const merged = JSON.parse(readFileSync(file, "utf8"));
    expect(merged.permissions).toEqual(existing.permissions);
    expect(merged.hooks.Stop).toEqual(existing.hooks.Stop);
    expect(merged.hooks.PreToolUse).toEqual([
      existing.hooks.PreToolUse[0],
      { matcher: HOOK_MATCHER, hooks: [{ type: "command", command: "ft hook check --colony hono --agent agt_1 --url https://ft.example", timeout: 5 }] },
    ]);
    // Never the committed settings.
    expect(existsSync(join(dir, ".claude", "settings.json"))).toBe(false);
    // Again: still one entry.
    expect(await main(["hook", "install", "--colony", "hono", "--agent", "agt_1"], io({ cwd: dir }))).toBe(0);
    expect(JSON.parse(readFileSync(file, "utf8")).hooks.PreToolUse).toHaveLength(2);
    expect(await main(["hook", "uninstall"], io({ cwd: dir }))).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(original);
  });

  it("creates the file when there is none, lists it in .git/info/exclude, and uninstall removes both", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, ".git", "info"), { recursive: true });
    const exclude = join(dir, ".git", "info", "exclude");
    writeFileSync(exclude, "# git ls-files --others --exclude-from=.git/info/exclude\n*.log\n");
    const before = readFileSync(exclude, "utf8");
    const t = io({ cwd: dir, env: { FT_URL: "" } });
    expect(await main(["hook", "install"], t)).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, SETTINGS_FILE), "utf8"))).toEqual({ hooks: { PreToolUse: [{ matcher: HOOK_MATCHER, hooks: [{ type: "command", command: "ft hook check", timeout: 5 }] }] } });
    expect(readFileSync(exclude, "utf8")).toBe(`${before}${EXCLUDE_MARK}\n/.claude/settings.local.json\n`);
    expect(t.out.join("\n")).toContain("never committed");
    expect(await main(["hook", "uninstall"], io({ cwd: dir }))).toBe(0);
    expect(existsSync(join(dir, ".claude"))).toBe(false);
    expect(readFileSync(exclude, "utf8")).toBe(before);
  });

  it("leaves a file it cannot read as JSON alone", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, ".claude"));
    writeFileSync(join(dir, SETTINGS_FILE), "{ not json");
    const t = io({ cwd: dir });
    expect(await main(["hook", "install"], t)).toBe(1);
    expect(readFileSync(join(dir, SETTINGS_FILE), "utf8")).toBe("{ not json");
    expect(t.err.join("\n")).toContain("was left as it is");
  });

  it("uninstall removes only its own entry, and says so when there is none", async () => {
    const mixed = withHook(`${JSON.stringify({ hooks: { PreToolUse: [{ matcher: HOOK_MATCHER, hooks: [{ type: "command", command: "./mine.sh" }] }] } })}`, "ft hook check");
    expect(JSON.parse(withoutHook(mixed).text!)).toEqual({ hooks: { PreToolUse: [{ matcher: HOOK_MATCHER, hooks: [{ type: "command", command: "./mine.sh" }] }] } });
    expect(withoutHook(null)).toEqual({ text: null, removed: 0 });
    const dir = tempDir();
    const t = io({ cwd: dir });
    expect(await main(["hook", "uninstall"], t)).toBe(0);
    expect(t.out.join("\n")).toContain("nothing to remove");
  });
});

describe("ft hook check", () => {
  /** A clone whose local git config names its colony and agent, as the take's git commands leave it. */
  function clone(): string {
    const dir = tempDir();
    mkdirSync(join(dir, ".git"));
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, ".git", "config"), "[core]\n\tbare = false\n[firetrident]\n\tagent = hono/agt_1\n");
    return dir;
  }
  const edit = (dir: string, path = "src/x.ts"): string => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Edit", cwd: dir, tool_input: { file_path: join(dir, path), old_string: "a", new_string: "b" } });

  it("asks once for the clone's agent about the file, and prints one line of Claude Code JSON when trunk moved under it", async () => {
    const dir = clone();
    const t = io({ stdin: edit(dir), env: { FT_MCP_TOKEN: "mcp-secret" }, answer: () => json(HEADS_UP) });
    expect(await main(["hook", "check"], t)).toBe(0);
    expect(t.asked).toEqual([{ url: "https://ft.example/api/colonies/hono/agents/agt_1/headsup?path=src%2Fx.ts", headers: expect.objectContaining({ authorization: "Bearer mcp-secret" }) }]);
    expect(t.out).toHaveLength(1);
    const line = "FireTrident: trunk moved under src/x.ts (lnd_y, 'Cache ’lookups’ now') and 1 more; call inbox before you edit.";
    expect(t.out[0]).toBe(hookOutput(line));
    expect(JSON.parse(t.out[0]!)).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: line } });
    const plain = io({ stdin: edit(dir), env: { FT_RESUME_KEY: "rk" }, answer: () => json(HEADS_UP) });
    expect(await main(["hook", "check", "--text"], plain)).toBe(0);
    expect(plain.out).toEqual([line]);
    expect(plain.asked[0]?.headers).toMatchObject({ "x-ft-resume-key": "rk" });
  });

  it("names a change waiting to land on the file, and prints nothing when nothing waits", async () => {
    const dir = clone();
    const waiting = io({ stdin: edit(dir, "src/w.ts"), answer: () => json(HEADS_UP) });
    await main(["hook", "check", "--text"], waiting);
    expect(waiting.out).toEqual(["FireTrident: a change waiting to land writes src/w.ts (prp_z, 'Rename the flag') and 1 more; call inbox before you edit."]);
    const quiet = io({ stdin: edit(dir), answer: () => json({ ...HEADS_UP, headsUp: null }) });
    expect(await main(["hook", "check"], quiet)).toBe(0);
    expect(quiet.out).toEqual([]);
  });

  it("always exits 0, and says the heads-up was unavailable when unreachable, refused, slow or unreadable", async () => {
    const dir = clone();
    const tail = "so nobody checked whether trunk moved under src/x.ts or a change waiting to land writes it; call inbox before you edit.";
    const down = io({ stdin: edit(dir), answer: () => Promise.reject(new TypeError("fetch failed")) });
    expect(await main(["hook", "check", "--text"], down)).toBe(0);
    expect(down.out).toEqual([`FireTrident: the heads-up was unavailable (the server could not be reached), ${tail}`]);
    const refused = io({ stdin: edit(dir), answer: () => json({ error: "unauthorized" }, 401) });
    expect(await main(["hook", "check", "--text"], refused)).toBe(0);
    expect(refused.out).toEqual([`FireTrident: the heads-up was unavailable (the server refused the hook's token or resume key (401)), ${tail}`]);
    const unknown = io({ stdin: edit(dir), answer: () => json({ error: "agent not found" }, 404) });
    await main(["hook", "check", "--text"], unknown);
    expect(unknown.out).toEqual([`FireTrident: the heads-up was unavailable (the server does not know this colony or agent (404)), ${tail}`]);
    const failing = io({ stdin: edit(dir), answer: () => json({ error: "internal" }, 500) });
    await main(["hook", "check", "--text"], failing);
    expect(failing.out).toEqual([`FireTrident: the heads-up was unavailable (the server answered 500), ${tail}`]);
    const garbled = io({ stdin: edit(dir), answer: () => Promise.resolve(new Response("<html>", { status: 200 })) });
    expect(await main(["hook", "check"], garbled)).toBe(0);
    // Claude Code's JSON, as for any line the hook prints.
    expect(garbled.out).toEqual([hookOutput(`FireTrident: the heads-up was unavailable (its answer could not be read), ${tail}`)]);
    const t0 = Date.now();
    const slow = io({
      stdin: edit(dir),
      answer: (_url, init) => new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason))),
    });
    expect(await main(["hook", "check", "--text"], slow)).toBe(0);
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(slow.out).toEqual([`FireTrident: the heads-up was unavailable (no answer within 1.5 s), ${tail}`]);
    for (const t of [down, refused, unknown, failing, garbled, slow]) expect(t.err).toEqual([]);
  });

  it("prints nothing when no colony or agent is known, or for bad arguments", async () => {
    const nobody = io({ stdin: JSON.stringify({ tool_input: { file_path: join(tempDir(), "a.ts") } }) });
    expect(await main(["hook", "check"], nobody)).toBe(0);
    expect(nobody.asked).toEqual([]);
    expect(await main(["hook", "check", "--bogus"], io())).toBe(0);
    expect(await main(["hook", "check"], io({ stdin: "not json" }))).toBe(0);
    expect([nobody.out, nobody.err]).toEqual([[], []]);
  });

  it("says when the colony checked only the oldest of the changes waiting to land", async () => {
    const dir = clone();
    const partial = io({ stdin: edit(dir), answer: () => json({ ...HEADS_UP, headsUp: { moved: [], ahead: [], aheadScanned: { scanned: 200, of: 340 } } }) });
    await main(["hook", "check", "--text"], partial);
    expect(partial.out).toEqual(["FireTrident: only the oldest 200 of 340 changes waiting to land were checked, so one of the others may write src/x.ts; call inbox before you edit."]);
    const found = io({ stdin: edit(dir), answer: () => json({ ...HEADS_UP, headsUp: { ...HEADS_UP.headsUp, aheadScanned: { scanned: 200, of: 340 } } }) });
    await main(["hook", "check", "--text"], found);
    expect(found.out).toEqual(["FireTrident: trunk moved under src/x.ts (lnd_y, 'Cache ’lookups’ now') and 1 more; only the oldest 200 of 340 changes waiting to land were checked; call inbox before you edit."]);
  });

  it("flags and the environment name the colony and agent over the clone's config", async () => {
    const dir = clone();
    const t = io({ stdin: edit(dir), env: { FT_AGENT_ID: "agt_9" }, answer: () => json(HEADS_UP) });
    await main(["hook", "check", "--colony", "hono"], t);
    expect(t.asked[0]?.url).toBe("https://ft.example/api/colonies/hono/agents/agt_9/headsup?path=src%2Fx.ts");
    // Installed for another colony: the clone's agent is not that colony's.
    const other = io({ stdin: edit(dir), answer: () => json(HEADS_UP) });
    await main(["hook", "check", "--colony", "web"], other);
    expect(other.asked).toEqual([]);
  });
});

describe("ft hook: the pieces", () => {
  it("reads the colony and agent from a git config, and nothing else", () => {
    expect(agentFromGitConfig("[firetrident]\n\tagent = hono/agt_1\n")).toEqual({ colony: "hono", agent: "agt_1" });
    expect(agentFromGitConfig('[remote "origin"]\n\tagent = hono/agt_1\n')).toBeNull();
    expect(agentFromGitConfig("[firetrident]\n\tagent = ../etc\n")).toBeNull();
  });

  it("puts the edited file first, then the newest landing or the oldest waiting change", () => {
    expect(headsUpLine(HEADS_UP.headsUp, null)).toBe("FireTrident: trunk moved under src/x.ts since your lease (lnd_y, 'Cache ’lookups’ now') and 1 more; call inbox before you edit.");
    expect(headsUpLine({ moved: [], ahead: HEADS_UP.headsUp.ahead }, "src/other.ts")).toBe("FireTrident: a change waiting to land writes src/w.ts (prp_z, 'Rename the flag'); call inbox before you edit.");
    expect(headsUpLine({ moved: [], ahead: [] }, "src/x.ts")).toBeNull();
    expect(headsUpLine(null, "src/x.ts")).toBeNull();
  });
});
