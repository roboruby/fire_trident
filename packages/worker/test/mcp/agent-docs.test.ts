import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PRIVATE_KEY_BEGIN } from "../../src/decide/danger.ts";
import { FireTridentMcp } from "../../src/mcp/FireTridentMcp.ts";
import { PublicTools, publicServer } from "../../src/mcp/public.ts";

/**
 * The guides in docs/agents tell people and agents which MCP tools to call and with which arguments.
 * These tests keep them honest against the server itself: the tools and their argument names come from
 * FireTridentMcp, listed by an MCP client over an in-memory transport (with inline changes off and on),
 * never from a list kept here. In every docs/agents/*.md page, a tool is named by:
 * - a table whose first header cell is "Tool": each row starts with one backticked tool name, and a
 *   column headed "Arguments" holds only backticked arguments of that row's tool;
 * - prose of the form "call `tool`", optionally followed by "with `arg`, `arg` and `arg`";
 * - a JSON-RPC body with "method": "tools/call" (its params.name and the keys of params.arguments);
 * - a client's own spelling of a tool: `mcp__firetrident__<tool>`, `Mcp(firetrident:<tool>)` or
 *   `tools.<tool>.approval_mode` (a `*` names them all).
 * The index lists every tool, each client guide opens with a status line, every relative link resolves,
 * and no page holds anything that looks like a credential.
 */

// The server's base class needs the Workers runtime; registering and listing tools needs only the env it holds.
vi.mock("agents/mcp", () => ({
  McpAgent: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

/** The part of node:fs these tests use (the worker compiles against workers types, not Node's). */
interface Fs {
  existsSync(path: URL): boolean;
  readdirSync(path: URL): string[];
  readFileSync(path: URL, encoding: "utf8"): string;
}
const FS = "node:fs";
const fs = (await import(FS)) as Fs;

// The tests run in Node, where a module knows its own URL (the workers types leave it out).
const DOCS = new URL("../../../../docs/agents/", (import.meta as ImportMeta & { url: string }).url);
/** The index of the guides: its tools table lists every tool. */
const INDEX = "README.md";
/** Pages that are not a client's guide, so they carry no status line. */
const NOT_GUIDES: ReadonlySet<string> = new Set([INDEX, "AGENTS.template.md"]);
/** The line a client guide opens with: not yet run, or which client and version it was verified with, and when. */
const STATUS = /^Status: (?:not yet run against a deployment|verified with .+ against a FireTrident deployment on \d{4}-\d{2}-\d{2})$/;

/** Tool name to the argument names of its input schema. */
type Tools = ReadonlyMap<string, ReadonlySet<string>>;

/** The tools a server started with `env` registers, as an MCP client lists them. */
async function listed(env: Record<string, string>): Promise<Map<string, Set<string>>> {
  const server = new FireTridentMcp({} as never, env as never);
  await server.init();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.server.connect(serverSide);
  const client = new Client({ name: "agent-docs-test", version: "0.0.0" });
  await client.connect(clientSide);
  try {
    const { tools } = await client.listTools();
    return new Map(tools.map((t) => [t.name, new Set(Object.keys(t.inputSchema.properties ?? {}))]));
  } finally {
    await client.close();
  }
}

/** The public read-only server's tools (`/public/mcp`), as an MCP client lists them; no read is made to list them. */
async function publicServerTools(): Promise<Map<string, Set<string>>> {
  const server = publicServer(new PublicTools({ colonies: new Set(["demo"]), reads: {} as never }), ["demo"]);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "agent-docs-test", version: "0.0.0" });
  await client.connect(clientSide);
  try {
    const { tools } = await client.listTools();
    return new Map(tools.map((t) => [t.name, new Set(Object.keys(t.inputSchema.properties ?? {}))]));
  } finally {
    await client.close();
  }
}

/** The rows of every table headed "Public tool" on a page: the tool and its argument names. */
function publicRows(text: string): Array<{ tool: string; args: string[] }> {
  const out: Array<{ tool: string; args: string[] }> = [];
  let inTable = false;
  for (const line of text.split("\n")) {
    const cells = line.trim().startsWith("|") ? line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()) : null;
    if (!cells) {
      inTable = false;
      continue;
    }
    if (cells[0] === "Public tool") {
      inTable = true;
      continue;
    }
    if (!inTable || /^-+$/.test(cells[0] ?? "")) continue;
    const tool = /^`([a-z_]+)`$/.exec(cells[0] ?? "")?.[1] ?? cells[0] ?? "";
    out.push({ tool, args: [...(cells[1] ?? "").matchAll(/`([A-Za-z_]+)`/g)].map((m) => m[1] ?? "") });
  }
  return out;
}

/**
 * Every tool with the union of its arguments across deployments: inline changes add `files` to propose, a field guide
 * `lesson`, twin intents `force` to declare.
 */
async function serverTools(): Promise<Map<string, Set<string>>> {
  const all = new Map<string, Set<string>>();
  const envs: Array<Record<string, string>> = [{}, { FT_INLINE: "on" }, { FT_FIELD_GUIDE: "on" }, { FT_TWINS: "on" }];
  for (const env of envs) {
    for (const [name, args] of await listed(env)) all.set(name, new Set([...(all.get(name) ?? []), ...args]));
  }
  return all;
}

/** A page split into its fenced code blocks and its prose (everything outside them). */
function split(text: string): { code: string; prose: string } {
  const code: string[] = [];
  const prose: string[] = [];
  let fenced = false;
  for (const line of text.split("\n")) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    (fenced ? code : prose).push(line);
  }
  return { code: code.join("\n"), prose: prose.join("\n") };
}

/** The backticked spans of a piece of text. */
function spans(text: string): string[] {
  return [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? "");
}

/** The leading identifier of a backticked argument (`wait: 45` names `wait`). */
function argName(span: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*/.exec(span.trim())?.[0] ?? span;
}

/** What the conventions found in one page, to show they are exercised. */
interface Found {
  tables: number;
  calls: number;
  rpc: number;
  tableTools: string[];
}

/** The Markdown tables of some prose, each as rows of trimmed cells (the separator row dropped). */
function tables(prose: string): string[][][] {
  const out: string[][][] = [];
  let cur: string[][] = [];
  for (const line of [...prose.split("\n"), ""]) {
    if (line.trim().startsWith("|")) {
      const cells = line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      if (!cells.every((c) => /^:?-{3,}:?$/.test(c))) cur.push(cells);
    } else if (cur.length > 0) {
      out.push(cur);
      cur = [];
    }
  }
  return out;
}

/** Each JSON-RPC object in some code, from its opening brace to the matching one (string-aware). */
function rpcBodies(code: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(/\{\s*"jsonrpc"/g)) {
    let depth = 0;
    let inString = false;
    for (let i = m.index; i < code.length; i++) {
      const ch = code[i];
      if (inString) {
        if (ch === "\\") i++;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        out.push(code.slice(m.index, i + 1));
        break;
      }
    }
  }
  return out;
}

/** What one page says about tools that the server does not register, and what the conventions found. */
function toolProblems(page: string, text: string, tools: Tools): { problems: string[]; found: Found } {
  const problems: string[] = [];
  const found: Found = { tables: 0, calls: 0, rpc: 0, tableTools: [] };
  const { code, prose } = split(text);
  const tool = (name: string, where: string): ReadonlySet<string> | null => {
    const args = tools.get(name);
    if (!args) problems.push(`${page}: ${where} names \`${name}\`, which the MCP server does not register`);
    return args ?? null;
  };
  const args = (name: string, names: readonly string[], where: string): void => {
    const known = tools.get(name);
    if (!known) return;
    for (const a of names) if (!known.has(a)) problems.push(`${page}: ${where} gives \`${name}\` the argument \`${a}\`, which its input schema does not have`);
  };

  for (const rows of tables(prose)) {
    const header = rows[0] ?? [];
    if (header[0] !== "Tool") continue;
    found.tables++;
    const argCol = header.indexOf("Arguments");
    for (const row of rows.slice(1)) {
      const m = /^`([^`]+)`$/.exec(row[0] ?? "");
      if (!m?.[1]) {
        problems.push(`${page}: a Tool table row starts with ${JSON.stringify(row[0] ?? "")}, not one backticked tool name`);
        continue;
      }
      found.tableTools.push(m[1]);
      if (tool(m[1], "a Tool table") && argCol > 0) args(m[1], spans(row[argCol] ?? "").map(argName), "its Tool table row");
    }
  }

  const CALL = /\bcall(?:s|ed|ing)?\s+`([^`]+)`(?:\s+again)?(?:\s+with\s+(`[^`]+`(?:(?:,\s*|,?\s+and\s+|,?\s+or\s+)`[^`]+`)*))?/gi;
  for (const m of prose.matchAll(CALL)) {
    found.calls++;
    const name = m[1] ?? "";
    if (tool(name, `"call \`${name}\`"`) && m[2]) args(name, spans(m[2]).map(argName), `"call \`${name}\` with ..."`);
  }

  for (const body of rpcBodies(code)) {
    let msg: { method?: unknown; params?: { name?: unknown; arguments?: unknown } };
    try {
      msg = JSON.parse(body) as typeof msg;
    } catch {
      problems.push(`${page}: a JSON-RPC example is not valid JSON: ${body.slice(0, 80)}`);
      continue;
    }
    if (msg.method !== "tools/call") continue;
    found.rpc++;
    const name = typeof msg.params?.name === "string" ? msg.params.name : "";
    const given = msg.params?.arguments && typeof msg.params.arguments === "object" ? Object.keys(msg.params.arguments) : [];
    if (tool(name, "a tools/call example")) args(name, given, "a tools/call example");
  }

  const spelled = [
    ...[...text.matchAll(/mcp__firetrident__([A-Za-z_*]+)/g)].map((m) => m[1] ?? ""),
    ...[...text.matchAll(/Mcp\(firetrident:([^)]+)\)/g)].map((m) => m[1] ?? ""),
    ...[...text.matchAll(/\btools\.([A-Za-z_*]+)\.approval_mode/g)].map((m) => m[1] ?? ""),
  ];
  for (const name of spelled) if (name !== "*") tool(name, "a client's tool name");
  return { problems, found };
}

/** A token value written as a placeholder: an environment variable, an <angle> placeholder, or a word of prose. */
function placeholder(value: string): boolean {
  return /^\$\{?(?:env:)?[A-Z][A-Z0-9_]*\}?$/.test(value) || /^<[^>]+>$/.test(value) || /^[a-z]{1,12}$/.test(value);
}

/** Everything in one page that looks like a credential: an Artifacts token, a long hex or base64 secret, a bearer token or resume key that is not a placeholder, a private key. */
function credentialProblems(page: string, text: string): string[] {
  const problems: string[] = [];
  const show = (s: string): string => `${s.slice(0, 12)}...`;
  for (const m of text.matchAll(/art_v\d/g)) problems.push(`${page}: an Artifacts token (${show(text.slice(m.index, m.index + 16))})`);
  for (const m of text.matchAll(/(?<![0-9A-Za-z])[0-9a-fA-F]{32,}(?![0-9A-Za-z])/g)) problems.push(`${page}: a long hex string (${show(m[0])})`);
  for (const m of text.matchAll(/[A-Za-z0-9+/_-]{32,}={0,2}/g)) {
    if (/[A-Z]/.test(m[0]) && /[a-z]/.test(m[0]) && /\d/.test(m[0])) problems.push(`${page}: a long base64 string (${show(m[0])})`);
  }
  for (const m of text.matchAll(/\bBearer[ \t]+([^\s"'`,)}\]]+)/g)) {
    if (!placeholder(m[1] ?? "")) problems.push(`${page}: a bearer token that is not a placeholder (${show(m[1] ?? "")})`);
  }
  for (const m of text.matchAll(/"resumeKey"\s*:\s*"([^"]*)"/g)) {
    if (!placeholder(m[1] ?? "")) problems.push(`${page}: a resume key that is not a placeholder (${show(m[1] ?? "")})`);
  }
  if (PRIVATE_KEY_BEGIN.test(text)) problems.push(`${page}: a private key`);
  return problems;
}

/** A heading's anchor as the repository host renders it: lowercase, punctuation dropped, spaces as hyphens. */
function anchor(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s/g, "-");
}

/** The anchors of a page's headings. */
function anchors(text: string): Set<string> {
  return new Set([...split(text).prose.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => anchor(m[1] ?? "")));
}

/** Relative links of one page whose file is missing, or whose #anchor names no heading of a page in this folder. */
function linkProblems(page: string, text: string, pages: ReadonlyMap<string, string>, exists: (rel: string) => boolean): string[] {
  const problems: string[] = [];
  for (const m of split(text).prose.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = m[1] ?? "";
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    const [file = "", hash] = target.split("#");
    if (file !== "" && !exists(file)) problems.push(`${page}: the link to ${target} names no file`);
    const linked = file === "" ? text : pages.get(file);
    if (hash !== undefined && linked !== undefined && !anchors(linked).has(hash)) problems.push(`${page}: the link to ${target} names no heading`);
  }
  return problems;
}

/** The first line after a page's title. */
function lineAfterTitle(text: string): string {
  const lines = text.split("\n").map((l) => l.trim());
  const title = lines.findIndex((l) => l.startsWith("# "));
  return lines.slice(title + 1).find((l) => l !== "") ?? "";
}

const TOOLS = await serverTools();
const PAGES = fs
  .readdirSync(DOCS)
  .filter((n) => n.endsWith(".md"))
  .sort()
  .map((name) => ({ name, text: fs.readFileSync(new URL(name, DOCS), "utf8") }));

describe("docs/agents", () => {
  it("has the index, the AGENTS.md template and client guides, and every relative link resolves", () => {
    expect(PAGES.map((p) => p.name)).toEqual(expect.arrayContaining([...NOT_GUIDES]));
    expect(PAGES.filter((p) => !NOT_GUIDES.has(p.name)).length).toBeGreaterThan(0);
    expect(TOOLS.size).toBeGreaterThan(0);
    const byName = new Map(PAGES.map((p) => [p.name, p.text]));
    const exists = (rel: string): boolean => fs.existsSync(new URL(rel, DOCS));
    expect(PAGES.flatMap((p) => linkProblems(p.name, p.text, byName, exists))).toEqual([]);
  });

  it("names only tools and arguments the MCP server registers", () => {
    const problems = PAGES.flatMap((p) => toolProblems(p.name, p.text, TOOLS).problems);
    expect(problems).toEqual([]);
  });

  it("uses every convention, so a guide that stops following them is noticed", () => {
    const found = PAGES.map((p) => toolProblems(p.name, p.text, TOOLS).found);
    expect(found.reduce((n, f) => n + f.tables, 0)).toBeGreaterThan(0);
    expect(found.reduce((n, f) => n + f.calls, 0)).toBeGreaterThan(0);
    expect(found.reduce((n, f) => n + f.rpc, 0)).toBeGreaterThan(0);
  });

  it("lists every tool the server registers in the index", () => {
    const index = PAGES.find((p) => p.name === INDEX);
    const listedTools = new Set(index ? toolProblems(index.name, index.text, TOOLS).found.tableTools : []);
    expect([...TOOLS.keys()].filter((t) => !listedTools.has(t))).toEqual([]);
  });

  it("opens each client guide with a status line", () => {
    const guides = PAGES.filter((p) => !NOT_GUIDES.has(p.name));
    expect(guides.length).toBeGreaterThan(0);
    for (const g of guides) expect(lineAfterTitle(g.text), g.name).toMatch(STATUS);
  });

  it("names only the public server's tools and arguments in Public tool tables, and lists them all in the index", async () => {
    const tools = await publicServerTools();
    const rows = PAGES.flatMap((p) => publicRows(p.text).map((r) => ({ page: p.name, ...r })));
    const problems = rows.flatMap((r) => (!tools.has(r.tool) ? [`${r.page}: ${r.tool} is not a public tool`] : r.args.filter((a) => !tools.get(r.tool)!.has(a)).map((a) => `${r.page}: ${r.tool} takes no ${a}`)));
    expect(problems).toEqual([]);
    const index = PAGES.find((p) => p.name === INDEX);
    const listed = new Set(index ? publicRows(index.text).map((r) => r.tool) : []);
    expect([...tools.keys()].filter((t) => !listed.has(t))).toEqual([]);
  });

  it("holds nothing that looks like a credential", () => {
    expect(PAGES.flatMap((p) => credentialProblems(p.name, p.text))).toEqual([]);
  });
});

describe("the checks themselves", () => {
  const tools: Tools = new Map([
    ["join", new Set(["colony", "agentId", "resumeKey"])],
    ["take", new Set(["wait"])],
  ]);

  it("catch an unknown tool or argument in each convention", () => {
    const page = [
      "| Tool | Arguments | What it does |",
      "| --- | --- | --- |",
      "| `join` | `colony`, `token` | joins |",
      "| `land` | none | no such tool |",
      "",
      "Then call `take` with `wait` and `timeout`, and call `merge`.",
      "",
      "```sh",
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"take","arguments":{"wait":5,"force":true}}}',
      '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"push","arguments":{}}}',
      "--allowedTools mcp__firetrident__rebase",
      "```",
    ].join("\n");
    const { problems, found } = toolProblems("sample.md", page, tools);
    expect(found).toMatchObject({ tables: 1, calls: 2, rpc: 2 });
    for (const bad of ["`token`", "`land`", "`timeout`", "`merge`", "`force`", "`push`", "`rebase`"]) {
      expect(problems.some((p) => p.includes(bad))).toBe(true);
    }
    expect(problems).toHaveLength(7);
  });

  it("accept the placeholders the guides use", () => {
    const page = [
      'curl -H "Authorization: Bearer $FT_MCP_TOKEN"',
      '{ "headers": { "Authorization": "Bearer ${FT_MCP_TOKEN}" } }',
      '"Authorization": "Bearer ${env:FT_MCP_TOKEN}"',
      "send it as an Authorization: Bearer <token> header",
      '{"name":"join","arguments":{"agentId":"$FT_AGENT","resumeKey":"$FT_RESUME_KEY"}}',
      "packages/bench/results/2026-10-12-prod/byo-run.log and default_tools_approval_mode",
    ].join("\n");
    expect(credentialProblems("sample.md", page)).toEqual([]);
  });

  it("catch what looks like a credential", () => {
    // Built from pieces, so no credential-shaped literal sits in this file.
    const hex = "0123456789abcdef".repeat(3);
    const b64 = `${"Ab3".repeat(12)}x`;
    const samples = [`art_v${1}_${hex}`, `commit ${hex}`, `key ${b64}`, `Authorization: Bearer ${"s3cr".repeat(3)}`, `"resumeKey": "${"k".repeat(43)}"`, `-----BEGIN ${"RSA"} PRIVATE KEY-----`];
    for (const s of samples) expect(credentialProblems("sample.md", s).length, s.slice(0, 12)).toBeGreaterThan(0);
  });

  it("catch a link to a missing file or heading", () => {
    const pages = new Map([["a.md", "# A\n\n## Join, and resume\n"]]);
    const page = "See [x](a.md#join-and-resume), [y](a.md#gone), [z](missing.md), [w](#nowhere) and [web](https://example.com/x).";
    const problems = linkProblems("b.md", page, pages, (rel) => rel === "a.md");
    expect(problems).toEqual(["b.md: the link to a.md#gone names no heading", "b.md: the link to missing.md names no file", "b.md: the link to #nowhere names no heading"]);
  });

  it("read a status line only in its exact form", () => {
    expect(STATUS.test("Status: not yet run against a deployment")).toBe(true);
    expect(STATUS.test("Status: verified with a client 1.2.3 against a FireTrident deployment on 2026-10-14")).toBe(true);
    expect(STATUS.test("Status: works")).toBe(false);
  });
});
