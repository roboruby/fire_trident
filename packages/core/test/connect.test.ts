import { describe, expect, it } from "vitest";
import {
  CONNECT_CLIENTS,
  MCP_TOOLS,
  PUBLIC_MCP_TOOLS,
  base64,
  connectInfo,
  connectLlmsItems,
  connectMarkdown,
  connectText,
  cursorLink,
  isConnectColony,
  listWords,
  publicAddCommand,
  pushRefusal,
  tokenAddCommand,
  toolsSentence,
  vscodeLink,
  type ConnectInfo,
  type ConnectSnippet,
} from "../src/connect.ts";

/**
 * Connect your agent: for a deployment and a colony, each client's command and configuration, the read-only public
 * server first and the token server second, with no token anywhere, and one-click links that decode to the same
 * configuration as the files.
 */

const SITE = "https://ft.example";
const info = connectInfo(SITE, "hono");

/** A client's snippet of one access and kind (the first such). */
function snippet(i: ConnectInfo, client: string, access: "public" | "token", kind: ConnectSnippet["kind"]): ConnectSnippet {
  const c = i.clients.find((x) => x.id === client);
  const v = c?.variants.find((x) => x.access === access);
  const s = v?.snippets.find((x) => x.kind === kind);
  if (!s) throw new Error(`no ${kind} for ${client} ${access}`);
  return s;
}

/** The decoded text of standard base64, by hand (the core package compiles without a runtime's atob types). */
function unbase64(s: string): string {
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const bytes: number[] = [];
  const clean = s.replace(/=+$/, "");
  for (let i = 0; i < clean.length; i += 4) {
    const n = [0, 1, 2, 3].reduce((acc, k) => (acc << 6) | Math.max(0, abc.indexOf(clean[i + k] ?? "A")), 0);
    bytes.push((n >> 16) & 255);
    if (i + 2 < clean.length) bytes.push((n >> 8) & 255);
    if (i + 3 < clean.length) bytes.push(n & 255);
  }
  return decodeURIComponent(bytes.map((b) => `%${b.toString(16).padStart(2, "0")}`).join(""));
}

describe("connectInfo", () => {
  it("gives every client, in order, each with the public server first and the token server second", () => {
    expect(info.clients.map((c) => c.id)).toEqual([...CONNECT_CLIENTS]);
    for (const c of info.clients) expect(c.variants.map((v) => v.access), c.id).toEqual(["public", "token"]);
    expect(info).toMatchObject({
      site: SITE,
      colony: "hono",
      publicUrl: `${SITE}/public/mcp`,
      tokenUrl: `${SITE}/mcp`,
      connectUrl: `${SITE}/connect?colony=hono`,
      colonyUrl: `${SITE}/c/hono`,
      skillUrl: `${SITE}/api/colonies/hono/skill`,
    });
  });

  it("gives Claude Code the commands and .mcp.json of docs/agents/claude-code.md", () => {
    expect(snippet(info, "claude-code", "public", "shell").text).toBe(`claude mcp add --transport http firetrident-public ${SITE}/public/mcp`);
    expect(snippet(info, "claude-code", "token", "shell").text).toBe(`claude mcp add --transport http firetrident ${SITE}/mcp --header "Authorization: Bearer $FT_MCP_TOKEN"`);
    expect(JSON.parse(snippet(info, "claude-code", "public", "json").text)).toEqual({ mcpServers: { "firetrident-public": { type: "http", url: `${SITE}/public/mcp` } } });
    const project = snippet(info, "claude-code", "token", "json");
    expect(project.file).toBe(".mcp.json");
    expect(project.text).toBe(
      [
        "{",
        '  "mcpServers": {',
        '    "firetrident": {',
        '      "type": "http",',
        `      "url": "${SITE}/mcp",`,
        '      "headers": { "Authorization": "Bearer ${FT_MCP_TOKEN}" }',
        "    }",
        "  }",
        "}",
      ].join("\n"),
    );
    expect(publicAddCommand(info)).toBe(snippet(info, "claude-code", "public", "shell").text);
    expect(tokenAddCommand(info)).toBe(snippet(info, "claude-code", "token", "shell").text);
  });

  it("gives Claude the custom connector's fields, with no sign-in and the header named, not filled", () => {
    const pub = snippet(info, "claude", "public", "steps").text;
    expect(pub).toContain(`Remote MCP server URL: ${SITE}/public/mcp`);
    expect(pub).toContain("Authentication: No sign-in");
    const tok = snippet(info, "claude", "token", "steps").text;
    expect(tok).toContain(`Remote MCP server URL: ${SITE}/mcp`);
    expect(tok).toContain("Request headers: authorization = Bearer <the value of FT_MCP_TOKEN>");
  });

  it("gives Codex CLI the commands and config.toml of docs/agents/codex.md", () => {
    expect(snippet(info, "codex", "public", "shell").text).toBe(`codex mcp add firetrident-public --url ${SITE}/public/mcp`);
    expect(snippet(info, "codex", "token", "shell").text).toBe(`codex mcp add firetrident --url ${SITE}/mcp --bearer-token-env-var FT_MCP_TOKEN`);
    expect(snippet(info, "codex", "public", "toml").text).toBe(`[mcp_servers.firetrident-public]\nurl = "${SITE}/public/mcp"`);
    expect(snippet(info, "codex", "token", "toml").text).toBe(
      [`[mcp_servers.firetrident]`, `url = "${SITE}/mcp"`, `bearer_token_env_var = "FT_MCP_TOKEN"`, `default_tools_approval_mode = "approve"`, `tool_timeout_sec = 120`].join("\n"),
    );
  });

  it("gives Cursor .cursor/mcp.json in its ${env:} syntax, and links whose config decodes to the file's server", () => {
    for (const [access, name] of [["public", "firetrident-public"], ["token", "firetrident"]] as const) {
      const file = JSON.parse(snippet(info, "cursor", access, "json").text) as { mcpServers: Record<string, unknown> };
      expect(Object.keys(file.mcpServers)).toEqual([name]);
      const [base, query = ""] = snippet(info, "cursor", access, "link").text.split("?");
      expect(base).toBe("cursor://anysphere.cursor-deeplink/mcp/install");
      const params = Object.fromEntries(query.split("&").map((kv) => kv.split("=").map(decodeURIComponent)));
      expect(Object.keys(params)).toEqual(["name", "config"]);
      expect(params.name).toBe(name);
      expect(JSON.parse(unbase64(params.config ?? ""))).toEqual(file.mcpServers[name]);
    }
    expect(JSON.parse(snippet(info, "cursor", "token", "json").text).mcpServers.firetrident).toEqual({ url: `${SITE}/mcp`, headers: { Authorization: "Bearer ${env:FT_MCP_TOKEN}" } });
  });

  it("gives VS Code .vscode/mcp.json with its servers key, a password input for the token, and a link that decodes to the read-only server", () => {
    const pub = JSON.parse(snippet(info, "vscode", "public", "json").text);
    expect(pub).toEqual({ servers: { "firetrident-public": { type: "http", url: `${SITE}/public/mcp` } } });
    const link = snippet(info, "vscode", "public", "link").text;
    expect(link.startsWith("vscode:mcp/install?")).toBe(true);
    expect(JSON.parse(decodeURIComponent(link.slice("vscode:mcp/install?".length)))).toEqual({ name: "firetrident-public", ...pub.servers["firetrident-public"] });
    const tok = JSON.parse(snippet(info, "vscode", "token", "json").text);
    expect(tok.inputs).toEqual([{ type: "promptString", id: "ft-mcp-token", description: "FireTrident MCP token", password: true }]);
    expect(tok.servers.firetrident).toEqual({ type: "http", url: `${SITE}/mcp`, headers: { Authorization: "Bearer ${input:ft-mcp-token}" } });
  });

  it("gives plain HTTP a JSON-RPC initialize on each server, and the colony's status on the public one", () => {
    const pub = info.clients.find((c) => c.id === "http")?.variants[0].snippets ?? [];
    expect(pub.map((s) => s.label)).toEqual(["initialize", "status"]);
    expect(pub[0]?.text).toContain(`curl -sS ${SITE}/public/mcp`);
    expect(pub[0]?.text).toContain('"method":"initialize"');
    expect(pub[1]?.text).toContain('{"name":"status","arguments":{"colony":"hono"}}');
    const tok = snippet(info, "http", "token", "shell").text;
    expect(tok).toContain(`curl -sS -D ft-headers.txt ${SITE}/mcp`);
    expect(tok).toContain('-H "Authorization: Bearer $FT_MCP_TOKEN"');
    for (const s of [...pub, snippet(info, "http", "token", "shell")]) {
      const body = /-d '([^']+)'/.exec(s.text)?.[1] ?? "";
      expect(JSON.parse(body).jsonrpc).toBe("2.0");
    }
  });

  it("names the token only by its variable or an input, never by value", () => {
    const all = info.clients.flatMap((c) => c.variants.flatMap((v) => v.snippets.map((s) => s.text))).join("\n");
    const bearers = [...all.matchAll(/Bearer ([^"\s]+)/g)].map((m) => m[1]);
    expect(bearers.length).toBeGreaterThan(5);
    for (const b of bearers) expect(b).toMatch(/^(?:\$FT_MCP_TOKEN|\$\{FT_MCP_TOKEN\}|\$\{env:FT_MCP_TOKEN\}|\$\{input:ft-mcp-token\}|<the)$/);
    for (const c of info.clients) expect(c.variants[0].snippets.some((s) => /Bearer|token/i.test(s.text)), c.id).toBe(false);
  });

  it("leaves out a colony that is not a colony id, so nothing a link carries reaches a command", () => {
    for (const bad of ["Hono", "a--b", "-a", `x'; rm -rf ~; '`, "a".repeat(49), ""]) {
      expect(isConnectColony(bad), bad).toBe(false);
      const i = connectInfo(SITE, bad);
      expect(i.colony).toBeNull();
      expect(i.colonyUrl).toBeNull();
      expect(i.connectUrl).toBe(`${SITE}/connect`);
      expect(i.prompts.token).toContain('"<colony>"');
    }
    expect(connectInfo(SITE).clients.find((c) => c.id === "http")?.variants[0].snippets).toHaveLength(1);
  });

  it("takes an origin, drops a trailing slash, and refuses anything else", () => {
    expect(connectInfo("https://ft.example/").site).toBe(SITE);
    expect(connectInfo("http://localhost:8787").tokenUrl).toBe("http://localhost:8787/mcp");
    for (const bad of ["ft.example", "https://ft.example/path", 'https://a"b', "javascript:alert(1)"]) expect(() => connectInfo(bad), bad).toThrow(/not a deployment URL/);
  });

  it("says which files go to a person and that the public server answers listed colonies only", () => {
    expect(info.notes.join(" ")).toContain("Committing a client's MCP configuration (.mcp.json, .cursor/ or .vscode/) to a colony's trunk goes to a person");
    expect(info.notes[0]).toContain("it answers only for the colonies the deployment lists for public reads");
  });
});

describe("the renderings", () => {
  it("print every snippet, public first, in markdown and as terminal text, in ASCII", () => {
    for (const text of [connectMarkdown(info), connectText(info)]) {
      expect(text.match(/[^\x09\x0a\x0d\x20-\x7e]/g)).toBeNull();
      for (const c of info.clients) {
        for (const s of c.variants.flatMap((v) => v.snippets)) for (const line of s.text.split("\n")) expect(text, c.id).toContain(line);
      }
      expect(text.indexOf(snippet(info, "claude-code", "public", "shell").text)).toBeLessThan(text.indexOf(snippet(info, "claude-code", "token", "shell").text));
      expect(text).toContain(info.prompts.public);
      expect(text).toContain(info.prompts.token);
    }
    expect(connectText(info)).toContain(`The colony's SKILL.md: ${SITE}/api/colonies/hono/skill`);
  });

  it("name both servers' tools in one sentence each, and llms.txt's items carry both commands and both sentences", () => {
    expect(toolsSentence("token")).toBe("Over /mcp an agent has the tools join, sense, take, checkout, read, propose, inbox, release, escalate, declare, why and impact.");
    expect(toolsSentence("public")).toBe("Over /public/mcp any MCP client has the tools status, why, intent, sense and impact.");
    expect(MCP_TOOLS).toHaveLength(12);
    expect(PUBLIC_MCP_TOOLS).toHaveLength(5);
    const items = connectLlmsItems(connectInfo(SITE));
    expect(items).toHaveLength(2);
    expect(items[0]).toContain(`[Connect your agent](${SITE}/connect)`);
    expect(items[0]).toContain(publicAddCommand(info));
    expect(items[0]).toContain(tokenAddCommand(info));
    expect(items[1]).toContain(toolsSentence("token"));
    expect(items[1]).toContain(toolsSentence("public"));
    expect(listWords(["a"])).toBe("a");
    expect(listWords(["a", "b", "c"])).toBe("a, b and c");
  });
});

describe("pushRefusal", () => {
  it("names the colony's page, how a change reaches trunk, the one command that adds the MCP server, and the connect page", () => {
    const lines = pushRefusal(SITE, "hono");
    expect(lines[0]).toBe("This is a read-only copy of the FireTrident colony hono: git push cannot change it.");
    expect(lines).toContain(`The colony: ${SITE}/c/hono`);
    expect(lines.join("\n")).toMatch(/takes an intent \(or declares one\), and proposes its change/);
    expect(lines).toContain(`  ${tokenAddCommand(info)}`);
    expect(lines[lines.length - 1]).toBe(`Every other client, and a read-only server that needs no token: ${SITE}/connect?colony=hono`);
    for (const l of lines) expect(l).not.toContain("\n");
  });
});

describe("base64 and the links", () => {
  it("encode like the standard alphabet, padding included, for any text", () => {
    for (const s of ["", "f", "fo", "foo", "foob", '{"url":"https://ft.example/mcp"}', "caf\u00e9 \u{1f600}"]) expect(unbase64(base64(s)), s).toBe(s);
    expect(base64("foobar")).toBe("Zm9vYmFy");
    expect(base64("fo")).toBe("Zm8=");
    expect(cursorLink("a b", { url: "x" })).toBe(`cursor://anysphere.cursor-deeplink/mcp/install?name=a%20b&config=${encodeURIComponent(base64('{"url":"x"}'))}`);
    expect(vscodeLink({ name: "n" })).toBe("vscode:mcp/install?%7B%22name%22%3A%22n%22%7D");
  });
});
