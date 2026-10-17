import { describe, expect, it } from "vitest";
import { connectInfo, connectText, publicAddCommand, tokenAddCommand } from "@fire_trident/core";
import { helpText, parseCommand } from "../src/args.ts";
import { main, type Io } from "../src/run.ts";

/** `ft connect [<colony>]`: each MCP client's command and configuration for the server ft talks to, read only first; nothing sent. */

/** An Io that records what it prints and fails any request (connect sends none). */
function io(env: Record<string, string> = { FT_URL: "https://ft.example" }): Io & { out: string[]; err: string[]; asked: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  return {
    env: { FT_USER: "tester", NO_COLOR: "1", ...env },
    stdout: (l) => void out.push(l),
    stderr: (l) => void err.push(l),
    isTTY: false,
    fetch: (async (input: string | URL | Request) => {
      asked.push(String(input));
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
  };
}

describe("ft connect: parsing", () => {
  it("takes an optional colony id, and refuses anything that is not one", () => {
    expect(parseCommand(["connect"])).toMatchObject({ ok: true, command: { name: "connect" } });
    expect(parseCommand(["connect", "hono"])).toMatchObject({ ok: true, command: { name: "connect", colony: "hono" } });
    const bad = parseCommand(["connect", "Not A Colony"]);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toBe('"Not A Colony" is not a colony id (lowercase letters, digits and single hyphens). Usage: ft connect [<colony>]');
    const extra = parseCommand(["connect", "a", "b"]);
    expect(extra.ok).toBe(false);
    expect(helpText("connect")).toMatch(/^ft connect \[<colony>\]/);
    expect(helpText()).toContain("connect [<colony>]");
  });
});

describe("ft connect: output", () => {
  it("prints every client for the server in FT_URL and the colony, read only first, and sends nothing", async () => {
    const t = io();
    expect(await main(["connect", "hono"], t)).toBe(0);
    const text = t.out.join("\n");
    const info = connectInfo("https://ft.example", "hono");
    expect(text).toBe(connectText(info));
    expect(text.indexOf(publicAddCommand(info))).toBeGreaterThan(0);
    expect(text.indexOf(publicAddCommand(info))).toBeLessThan(text.indexOf(tokenAddCommand(info)));
    for (const c of info.clients) expect(text).toContain(c.name);
    expect(text).toContain("https://ft.example/connect?colony=hono");
    expect(text).toContain("https://ft.example/api/colonies/hono/skill");
    expect(t.asked).toEqual([]);
  });

  it("names the server from --url, else the public site, and no colony when none is given", async () => {
    const flag = io({});
    expect(await main(["connect", "--url", "http://127.0.0.1:8787/"], flag)).toBe(0);
    expect(flag.out.join("\n")).toContain("claude mcp add --transport http firetrident-public http://127.0.0.1:8787/public/mcp");
    expect(flag.out.join("\n")).not.toContain("SKILL.md");
    const plain = io({});
    expect(await main(["connect"], plain)).toBe(0);
    expect(plain.out.join("\n").split("\n")[0]).toBe("Connect an agent to https://firetrident.com");
  });

  it("prints the same as JSON with --json, with no token in it", async () => {
    const t = io();
    expect(await main(["connect", "hono", "--json"], t)).toBe(0);
    const json = JSON.parse(t.out.join("\n"));
    expect(json).toEqual(JSON.parse(JSON.stringify(connectInfo("https://ft.example", "hono"))));
    const snippets = (json.clients as Array<{ variants: Array<{ snippets: Array<{ text: string }> }> }>).flatMap((c) => c.variants.flatMap((v) => v.snippets.map((s) => s.text))).join("\n");
    for (const m of snippets.matchAll(/Bearer ([^"\s]+)/g)) expect(m[1]).toMatch(/^(?:\$FT_MCP_TOKEN|\$\{FT_MCP_TOKEN\}|\$\{env:FT_MCP_TOKEN\}|\$\{input:ft-mcp-token\}|<the)$/);
  });

  it("says plainly when the server URL is not one a command can carry", async () => {
    const t = io({ FT_URL: "https://ft.example/sub/path" });
    expect(await main(["connect"], t)).toBe(1);
    expect(t.err).toEqual(["ft: not a deployment URL: https://ft.example/sub/path"]);
  });
});
