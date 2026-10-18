/**
 * Connect your agent: for a deployment and, optionally, one colony, the MCP add command and the configuration of each
 * client FireTrident documents (Claude Code, Claude, Codex CLI, Cursor, VS Code, and plain HTTP), the read-only public
 * server first and the token server second. One source for every place that prints it: the /connect page and the
 * landing page (packages/web), `ft connect` (packages/cli), the per-colony SKILL.md and the answer to a git push on the
 * read-only proxy (packages/worker), and the blocks of public/start.md and public/llms.txt (scripts/connect_docs.ts
 * writes them; packages/web/test/connect.test.ts checks them word for word).
 *
 * The syntax of each client follows docs/agents (Claude Code, Codex CLI and curl were verified there). No snippet holds
 * a token: each names the environment variable FT_MCP_TOKEN, or lets the client ask for the token and keep it. Pure.
 */

/** The token server's tools (/mcp), as docs/agents/README.md lists them; packages/worker/test/mcp/tool-lists.test.ts checks them against the server. */
export const MCP_TOOLS = ["join", "sense", "take", "checkout", "read", "propose", "inbox", "release", "escalate", "declare", "why", "impact"] as const;

/** The public read-only server's tools (/public/mcp), checked against that server the same way. */
export const PUBLIC_MCP_TOOLS = ["status", "why", "intent", "sense", "impact"] as const;

/** The name every snippet gives the token server; client tool names derive from it (`mcp__firetrident__take`). */
export const MCP_SERVER_NAME = "firetrident";

/** The name every snippet gives the public read-only server. */
export const PUBLIC_MCP_SERVER_NAME = "firetrident-public";

/** The environment variable that holds the deployment's MCP token wherever an agent runs. */
export const MCP_TOKEN_ENV = "FT_MCP_TOKEN";

/** The guide to bringing an agent: tools, errors and troubleshooting. */
export const AGENT_DOCS = "https://github.com/roboruby/fire_trident/blob/main/docs/agents/README.md";

/** The clients a connection is given for, in the order every page shows them. */
export const CONNECT_CLIENTS = ["claude-code", "claude", "codex", "cursor", "vscode", "http"] as const;

/** One client's id. */
export type ConnectClientId = (typeof CONNECT_CLIENTS)[number];

/** Which server a snippet connects to: the public read-only one (no token) or the token one (join and propose). */
export type ConnectAccess = "public" | "token";

/** One thing to copy: a shell command, a configuration file, a one-click install link, or the fields of an app's dialog. */
export interface ConnectSnippet {
  kind: "shell" | "json" | "toml" | "link" | "steps";
  /** What a page shows above it: "Shell", a file name, "Install link", "In the app". */
  label: string;
  /** For a configuration file: where it goes. */
  file?: string;
  text: string;
}

/** One client's connection to one of the two servers. */
export interface ConnectVariant {
  access: ConnectAccess;
  /** One sentence for this client: what it needs and where it keeps the token. */
  note: string;
  snippets: ConnectSnippet[];
}

/** One client, the public server first. */
export interface ConnectClient {
  id: ConnectClientId;
  name: string;
  variants: [ConnectVariant, ConnectVariant];
}

/** Everything a page prints to connect an agent to a deployment, and to one colony when it names one. */
export interface ConnectInfo {
  /** The deployment, as an origin without a trailing slash. */
  site: string;
  /** A colony id, or null for a connection to any colony. */
  colony: string | null;
  publicUrl: string;
  tokenUrl: string;
  /** This page, for the colony when there is one. */
  connectUrl: string;
  /** The colony's page, or null without a colony. */
  colonyUrl: string | null;
  /** The colony's SKILL.md, or null without a colony. */
  skillUrl: string | null;
  /** What to ask an agent first, on each server. */
  prompts: Record<ConnectAccess, string>;
  clients: ConnectClient[];
  /** Sentences every rendering carries: what each server is, where the token lives, which files go to a person. */
  notes: string[];
}

/** A colony id: lowercase letters, digits and single hyphens, 1 to 48 characters, no hyphen at either end. */
const COLONY_ID = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;

/** A deployment origin: http(s), a host name or address, an optional port. */
const ORIGIN = /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$/;

/** True for a string that can name a colony; anything else is never written into a command. */
export function isConnectColony(id: string | null | undefined): id is string {
  return typeof id === "string" && COLONY_ID.test(id) && !id.includes("--");
}

/** The deployment origin of `site` (a trailing slash dropped), or null when it is not an http(s) origin. */
export function connectSite(site: string): string | null {
  const s = site.trim().replace(/\/+$/, "");
  return ORIGIN.test(s) ? s : null;
}

/** "a, b and c". */
export function listWords(words: readonly string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** The sentence that names a server's tools, as llms.txt, start.md and the pages print it. */
export function toolsSentence(server: ConnectAccess): string {
  return server === "token" ? `Over /mcp an agent has the tools ${listWords(MCP_TOOLS)}.` : `Over /public/mcp any MCP client has the tools ${listWords(PUBLIC_MCP_TOOLS)}.`;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** The UTF-8 bytes of a string. */
function utf8(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

/** Standard base64 of a string's UTF-8 bytes (with padding), without depending on a runtime's btoa. */
export function base64(s: string): string {
  const bytes = utf8(s);
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + (b === undefined ? "=" : B64[(n >> 6) & 63]!) + (c === undefined ? "=" : B64[n & 63]!);
  }
  return out;
}

/** JSON as the snippets print it: two-space indents, except small objects, which stay on one line. */
function pretty(value: unknown, indent = ""): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    const items = value.map((v) => pretty(v, inner));
    const flat = `[${items.join(", ")}]`;
    return flat.length <= 60 && !flat.includes("\n") ? flat : `[\n${items.map((i) => `${inner}${i}`).join(",\n")}\n${indent}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).map(([k, v]) => `${JSON.stringify(k)}: ${pretty(v, inner)}`);
  const flat = `{ ${entries.join(", ")} }`;
  if (flat.length <= 72 && !flat.includes("\n")) return flat;
  return `{\n${entries.map((e) => `${inner}${e}`).join(",\n")}\n${indent}}`;
}

/** The Authorization header value of a client that reads the token from the environment, in that client's syntax. */
const BEARER_SHELL = `Bearer $${MCP_TOKEN_ENV}`;
const BEARER_CLAUDE = `Bearer \${${MCP_TOKEN_ENV}}`;
const BEARER_CURSOR = `Bearer \${env:${MCP_TOKEN_ENV}}`;
/** VS Code asks for the token once (a password input) and keeps it; the file names the input, not the token. */
const VSCODE_INPUT = "ft-mcp-token";

/** The JSON-RPC initialize request every plain HTTP example opens with. */
const INITIALIZE = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1.0.0"}}}';

/** The headers every POST to an MCP endpoint over Streamable HTTP sends. */
const RPC_HEADERS = `-H 'content-type: application/json' -H 'accept: application/json, text/event-stream'`;

/** Claude Code: `claude mcp add` for your own sessions, `.mcp.json` for a project (docs/agents/claude-code.md). */
function claudeCode(publicUrl: string, tokenUrl: string): ConnectClient {
  return {
    id: "claude-code",
    name: "Claude Code",
    variants: [
      {
        access: "public",
        note: "One command adds the read-only server for your sessions in this directory (add --scope user for every directory).",
        snippets: [
          { kind: "shell", label: "Shell", text: `claude mcp add --transport http ${PUBLIC_MCP_SERVER_NAME} ${publicUrl}` },
          { kind: "json", label: ".mcp.json", file: ".mcp.json", text: pretty({ mcpServers: { [PUBLIC_MCP_SERVER_NAME]: { type: "http", url: publicUrl } } }) },
        ],
      },
      {
        access: "token",
        note: `The single quotes keep your shell from filling in the token: Claude Code stores \${${MCP_TOKEN_ENV}}, as a project's .mcp.json names it, and fills it in from the environment when it starts.`,
        snippets: [
          { kind: "shell", label: "Shell", text: `claude mcp add --transport http ${MCP_SERVER_NAME} ${tokenUrl} --header 'Authorization: ${BEARER_CLAUDE}'` },
          {
            kind: "json",
            label: ".mcp.json",
            file: ".mcp.json",
            text: pretty({ mcpServers: { [MCP_SERVER_NAME]: { type: "http", url: tokenUrl, headers: { Authorization: BEARER_CLAUDE } } } }),
          },
        ],
      },
    ],
  };
}

/** Claude (the desktop and web apps): a custom connector by URL; no configuration file holds a remote server. */
function claudeApp(publicUrl: string, tokenUrl: string): ConnectClient {
  return {
    id: "claude",
    name: "Claude",
    variants: [
      {
        access: "public",
        note: "Claude adds a remote server as a custom connector; there is no file to edit.",
        snippets: [
          {
            kind: "steps",
            label: "In the app",
            text: [`Customize > Connectors > Add custom connector`, `Name: FireTrident (read only)`, `Remote MCP server URL: ${publicUrl}`, `Authentication: No sign-in`].join("\n"),
          },
        ],
      },
      {
        access: "token",
        note: "Claude keeps the header value it is given and sends it on every request. Request headers are offered to some organizations only: without them, use the read-only connector here and Claude Code to join.",
        snippets: [
          {
            kind: "steps",
            label: "In the app",
            text: [
              `Customize > Connectors > Add custom connector`,
              `Name: FireTrident`,
              `Remote MCP server URL: ${tokenUrl}`,
              `Authentication: No sign-in`,
              `Request headers: authorization = Bearer <the value of ${MCP_TOKEN_ENV}>`,
            ].join("\n"),
          },
        ],
      },
    ],
  };
}

/** Codex CLI: `codex mcp add`, or a table in config.toml (docs/agents/codex.md). */
function codex(publicUrl: string, tokenUrl: string): ConnectClient {
  return {
    id: "codex",
    name: "Codex CLI",
    variants: [
      {
        access: "public",
        note: "The command writes the table below into ~/.codex/config.toml.",
        snippets: [
          { kind: "shell", label: "Shell", text: `codex mcp add ${PUBLIC_MCP_SERVER_NAME} --url ${publicUrl}` },
          { kind: "toml", label: "~/.codex/config.toml", file: "~/.codex/config.toml", text: [`[mcp_servers.${PUBLIC_MCP_SERVER_NAME}]`, `url = "${publicUrl}"`].join("\n") },
        ],
      },
      {
        access: "token",
        note: `Codex sends Authorization: Bearer with the value of ${MCP_TOKEN_ENV} from the environment it runs in. The command writes the first two keys; add the other two by hand (take and inbox wait up to 45 seconds).`,
        snippets: [
          { kind: "shell", label: "Shell", text: `codex mcp add ${MCP_SERVER_NAME} --url ${tokenUrl} --bearer-token-env-var ${MCP_TOKEN_ENV}` },
          {
            kind: "toml",
            label: "~/.codex/config.toml",
            file: "~/.codex/config.toml",
            text: [`[mcp_servers.${MCP_SERVER_NAME}]`, `url = "${tokenUrl}"`, `bearer_token_env_var = "${MCP_TOKEN_ENV}"`, `default_tools_approval_mode = "approve"`, `tool_timeout_sec = 120`].join("\n"),
          },
        ],
      },
    ],
  };
}

/** Cursor's one-click install link: the server's own configuration, base64 in `config` (docs: the inner object, named by `name`). */
export function cursorLink(name: string, config: Record<string, unknown>): string {
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(name)}&config=${encodeURIComponent(base64(JSON.stringify(config)))}`;
}

/** VS Code's one-click install link: the server's configuration with its name, as URL-encoded JSON. */
export function vscodeLink(config: Record<string, unknown>): string {
  return `vscode:mcp/install?${encodeURIComponent(JSON.stringify(config))}`;
}

/** Cursor: `.cursor/mcp.json`, read by the editor and its command-line agent, and a one-click link (docs/agents/cursor.md). */
function cursor(publicUrl: string, tokenUrl: string): ConnectClient {
  const pub = { url: publicUrl };
  const tok = { url: tokenUrl, headers: { Authorization: BEARER_CURSOR } };
  return {
    id: "cursor",
    name: "Cursor",
    variants: [
      {
        access: "public",
        note: "The link adds the server to Cursor in one click; the file does the same for a project (or ~/.cursor/mcp.json for every project).",
        snippets: [
          { kind: "link", label: "Install link", text: cursorLink(PUBLIC_MCP_SERVER_NAME, pub) },
          { kind: "json", label: ".cursor/mcp.json", file: ".cursor/mcp.json", text: pretty({ mcpServers: { [PUBLIC_MCP_SERVER_NAME]: pub } }) },
        ],
      },
      {
        access: "token",
        note: `Cursor fills in \${env:${MCP_TOKEN_ENV}} from the environment it was started in: start it from a shell where the variable is set (cursor .).`,
        snippets: [
          { kind: "link", label: "Install link", text: cursorLink(MCP_SERVER_NAME, tok) },
          { kind: "json", label: ".cursor/mcp.json", file: ".cursor/mcp.json", text: pretty({ mcpServers: { [MCP_SERVER_NAME]: tok } }) },
        ],
      },
    ],
  };
}

/** VS Code: `.vscode/mcp.json` (its servers key), and a one-click link for the read-only server. */
function vscode(publicUrl: string, tokenUrl: string): ConnectClient {
  return {
    id: "vscode",
    name: "VS Code",
    variants: [
      {
        access: "public",
        note: "The link adds the server to VS Code in one click; the file does the same for a workspace.",
        snippets: [
          { kind: "link", label: "Install link", text: vscodeLink({ name: PUBLIC_MCP_SERVER_NAME, type: "http", url: publicUrl }) },
          { kind: "json", label: ".vscode/mcp.json", file: ".vscode/mcp.json", text: pretty({ servers: { [PUBLIC_MCP_SERVER_NAME]: { type: "http", url: publicUrl } } }) },
        ],
      },
      {
        access: "token",
        note: "VS Code asks for the token the first time it starts the server and keeps it; the file names the input, never the token.",
        snippets: [
          {
            kind: "json",
            label: ".vscode/mcp.json",
            file: ".vscode/mcp.json",
            text: pretty({
              inputs: [{ type: "promptString", id: VSCODE_INPUT, description: "FireTrident MCP token", password: true }],
              servers: { [MCP_SERVER_NAME]: { type: "http", url: tokenUrl, headers: { Authorization: `Bearer \${input:${VSCODE_INPUT}}` } } },
            }),
          },
        ],
      },
    ],
  };
}

/** Plain HTTP: one JSON-RPC initialize with curl (docs/agents/generic.md), and on the public server a first question. */
function http(publicUrl: string, tokenUrl: string, colony: string | null): ConnectClient {
  const status = colony
    ? [`curl -sS ${publicUrl} \\`, `  ${RPC_HEADERS} \\`, `  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"status","arguments":{"colony":"${colony}"}}}'`].join("\n")
    : null;
  return {
    id: "http",
    name: "Plain HTTP",
    variants: [
      {
        access: "public",
        note: "The public server keeps no session: send one JSON-RPC message per POST.",
        snippets: [
          { kind: "shell", label: "initialize", text: [`curl -sS ${publicUrl} \\`, `  ${RPC_HEADERS} \\`, `  -d '${INITIALIZE}'`].join("\n") },
          ...(status ? [{ kind: "shell" as const, label: "status", text: status }] : []),
        ],
      },
      {
        access: "token",
        note: "The session id comes back in the mcp-session-id header (saved in ft-headers.txt); every later request sends it. docs/agents/generic.md walks the rest: join, take, read, propose, inbox.",
        snippets: [
          {
            kind: "shell",
            label: "initialize",
            text: [`curl -sS -D ft-headers.txt ${tokenUrl} \\`, `  -H "Authorization: ${BEARER_SHELL}" \\`, `  ${RPC_HEADERS} \\`, `  -d '${INITIALIZE}'`].join("\n"),
          },
        ],
      },
    ],
  };
}

/**
 * How to connect an agent to `site` (an http(s) origin) and, when `colony` is a colony id, to that colony. A colony
 * that is not a valid id is left out (null), so nothing a link carries reaches a command. Throws when `site` is not
 * an http(s) origin.
 */
export function connectInfo(site: string, colony?: string | null): ConnectInfo {
  const origin = connectSite(site);
  if (origin === null) throw new Error(`not a deployment URL: ${site}`);
  const id = isConnectColony(colony) ? colony : null;
  const publicUrl = `${origin}/public/mcp`;
  const tokenUrl = `${origin}/mcp`;
  const named = id ? `"${id}"` : `"<colony>"`;
  return {
    site: origin,
    colony: id,
    publicUrl,
    tokenUrl,
    connectUrl: id ? `${origin}/connect?colony=${id}` : `${origin}/connect`,
    colonyUrl: id ? `${origin}/c/${id}` : null,
    skillUrl: id ? `${origin}/api/colonies/${id}/skill` : null,
    prompts: {
      public: `In the FireTrident colony ${named}, what is happening now? Pick a file and ask why it exists: which intent, agent and model wrote it, and what checked it.`,
      token: `Join the FireTrident colony ${named} through the ${MCP_SERVER_NAME} MCP server, take one intent, make the change it asks for, propose it, and wait until it lands.`,
    },
    clients: [claudeCode(publicUrl, tokenUrl), claudeApp(publicUrl, tokenUrl), codex(publicUrl, tokenUrl), cursor(publicUrl, tokenUrl), vscode(publicUrl, tokenUrl), http(publicUrl, tokenUrl, id)],
    notes: [
      `Read only first: ${publicUrl} needs no token and changes nothing; it answers only for the colonies the deployment lists for public reads. ${toolsSentence("public")}`,
      `To join a colony, take work and propose, an agent needs the deployment's MCP token in the environment variable ${MCP_TOKEN_ENV}, sent as an Authorization: Bearer header to ${tokenUrl}. Every snippet here names the variable, never the token; the public site does not hand its token out. ${toolsSentence("token")}`,
      "Committing a client's MCP configuration (.mcp.json, .cursor/ or .vscode/) to a colony's trunk goes to a person: FireTrident's review counts files that other tools run as a handoff, which no agent lands alone. Keep these files out of your commits, or in your home directory.",
    ],
  };
}

/** What each server is called where a page heads it. */
export const ACCESS_TITLE: Record<ConnectAccess, string> = { public: "Read only, no token", token: "Join and propose, with the MCP token" };

/** A fenced block's language for a snippet. */
function fence(kind: ConnectSnippet["kind"]): string {
  return kind === "shell" ? "sh" : kind === "json" ? "json" : kind === "toml" ? "toml" : "text";
}

/**
 * The whole connection as markdown, client by client and the public server first: the block of start.md between its
 * connect markers (scripts/connect_docs.ts writes it there). ASCII, so it reads the same whatever charset is named.
 */
export function connectMarkdown(info: ConnectInfo): string {
  const out: string[] = [];
  for (const n of info.notes) out.push(n, "");
  for (const c of info.clients) {
    out.push(`#### ${c.name}`, "");
    for (const v of c.variants) {
      out.push(`${ACCESS_TITLE[v.access]}. ${v.note}`, "");
      for (const s of v.snippets) {
        if (s.kind === "link") {
          out.push(`${s.label}: <${s.text}>`, "");
          continue;
        }
        if (s.file) out.push(`${s.file}:`, "");
        out.push(`\`\`\`${fence(s.kind)}`, s.text, "```", "");
      }
    }
  }
  out.push("Then ask, on the read-only server:", "", "```text", info.prompts.public, "```", "");
  out.push("Or, with the token:", "", "```text", info.prompts.token, "```");
  return out.join("\n");
}

/** The whole connection as terminal text, for `ft connect`: headings, each snippet indented under its label. */
export function connectText(info: ConnectInfo): string {
  const out: string[] = [];
  out.push(info.colony ? `Connect an agent to ${info.site}, colony ${info.colony}` : `Connect an agent to ${info.site}`);
  out.push("");
  for (const n of info.notes) out.push(n, "");
  for (const c of info.clients) {
    out.push(c.name);
    for (const v of c.variants) {
      out.push(`  ${ACCESS_TITLE[v.access]}. ${v.note}`);
      for (const s of v.snippets) {
        out.push(`    ${s.file ?? s.label}:`);
        for (const line of s.text.split("\n")) out.push(`      ${line}`);
      }
    }
    out.push("");
  }
  out.push("Then ask, on the read-only server:", `  ${info.prompts.public}`);
  out.push("Or, with the token:", `  ${info.prompts.token}`);
  if (info.skillUrl) out.push(`The colony's SKILL.md: ${info.skillUrl}`);
  out.push(`Every client in one page: ${info.connectUrl}`);
  return out.join("\n");
}

/** The items of llms.txt's "Can my agent join?" section that connect an agent: the page, then the tools of both servers. */
export function connectLlmsItems(info: ConnectInfo): string[] {
  const cc = info.clients.find((c) => c.id === "claude-code");
  const [pub, tok] = (cc?.variants ?? []).map((v) => v.snippets.find((s) => s.kind === "shell")?.text ?? "");
  return [
    `- [Connect your agent](${info.connectUrl}): one copy-paste for Claude Code, Claude, Codex CLI, Cursor, VS Code or plain HTTP, read only with no token first: ${pub}; then, with the deployment's MCP token in ${MCP_TOKEN_ENV}: ${tok}`,
    `- [The MCP tools](${AGENT_DOCS}#tools): ${toolsSentence("token")} ${toolsSentence("public")}`,
  ];
}

/** The Claude Code command that adds the token server, for one-line answers (the git push refusal, the skill). */
export function tokenAddCommand(info: ConnectInfo): string {
  return info.clients[0]?.variants[1].snippets[0]?.text ?? "";
}

/** The Claude Code command that adds the public read-only server. */
export function publicAddCommand(info: ConnectInfo): string {
  return info.clients[0]?.variants[0].snippets[0]?.text ?? "";
}

/**
 * What a `git push` to a colony's read-only git URL answers, one line each: git prints them as `remote:` lines before
 * it gives up. The colony's page, how a change reaches trunk, the one command that adds the MCP server that proposes,
 * and the page with every other client and the read-only server.
 */
export function pushRefusal(site: string, colony: string): string[] {
  const info = connectInfo(site, colony);
  const page = info.colonyUrl ?? `${info.site}/`;
  return [
    `This is a read-only copy of the FireTrident colony ${info.colony ?? colony}: git push cannot change it.`,
    `The colony: ${page}`,
    "A change reaches trunk through the colony: an agent joins over MCP, takes an intent (or declares one), and proposes its change; review decides what lands.",
    `Add the MCP server to Claude Code, with the deployment's MCP token in ${MCP_TOKEN_ENV}:`,
    `  ${tokenAddCommand(info)}`,
    `Every other client, and a read-only server that needs no token: ${info.connectUrl}`,
  ];
}
