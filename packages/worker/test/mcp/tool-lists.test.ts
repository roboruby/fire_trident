import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MCP_TOOLS, PUBLIC_MCP_TOOLS, toolsSentence } from "@fire_trident/core";
import { FireTridentMcp } from "../../src/mcp/FireTridentMcp.ts";
import { PublicTools, publicServer } from "../../src/mcp/public.ts";

/**
 * Every list of MCP tools a reader meets, against the servers themselves: the tools FireTridentMcp (/mcp) and the public
 * server (/public/mcp) register, listed by an MCP client over an in-memory transport, never from a list kept here.
 * The lists: core's MCP_TOOLS and PUBLIC_MCP_TOOLS (which the connect page, the landing page, `ft connect` and the
 * skill print), the sentences of llms.txt and start.md that name each server's tools, and the "Tool" and "Public tool"
 * tables of docs/agents/README.md. A tool the server registers and a list leaves out fails, and so does a tool a list
 * names that the server no longer has.
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
  readFileSync(path: URL, encoding: "utf8"): string;
}
const FS = "node:fs";
const fs = (await import(FS)) as Fs;
const HERE = (import.meta as ImportMeta & { url: string }).url;
const read = (rel: string): string => fs.readFileSync(new URL(rel, HERE), "utf8");

/** The names a connected client lists. */
async function names(connect: (c: Client) => Promise<void>): Promise<Set<string>> {
  const client = new Client({ name: "tool-lists-test", version: "0.0.0" });
  await connect(client);
  try {
    return new Set((await client.listTools()).tools.map((t) => t.name));
  } finally {
    await client.close();
  }
}

/** Every tool /mcp registers on any deployment: the union over the flags that change the tool list or its arguments. */
async function tokenServerTools(): Promise<Set<string>> {
  const all = new Set<string>();
  for (const env of [{}, { FT_INLINE: "on" }, { FT_FIELD_GUIDE: "on" }, { FT_TWINS: "on" }]) {
    const server = new FireTridentMcp({} as never, env as never);
    await server.init();
    const listed = await names(async (client) => {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await server.server.connect(serverSide);
      await client.connect(clientSide);
    });
    for (const n of listed) all.add(n);
  }
  return all;
}

/** Every tool /public/mcp registers; no read is made to list them. */
async function publicServerTools(): Promise<Set<string>> {
  const server = publicServer(new PublicTools({ colonies: new Set(["demo"]), reads: {} as never }), ["demo"]);
  return names(async (client) => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    await client.connect(clientSide);
  });
}

/** "a, b and c" (or "a, b, and c") as its words. */
function words(list: string): string[] {
  return list
    .split(/,\s*(?:and\s+)?|\s+and\s+/)
    .map((w) => w.trim())
    .filter(Boolean);
}

/** The lead each sentence that names a server's tools opens with, up to the list (toolsSentence in core/connect.ts). */
const LEADS = { token: toolsSentence("token").replace(/ join, .*$/, " "), public: toolsSentence("public").replace(/ status, .*$/, " ") } as const;

/** Every list of tools in `text` that follows the server's lead, up to the sentence's period. */
function sentences(text: string, server: keyof typeof LEADS): string[][] {
  const lead = LEADS[server].replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  return [...text.matchAll(new RegExp(`${lead}([a-z_, ]+?)\\.`, "g"))].map((m) => words(m[1] ?? ""));
}

/** The tools of a markdown table whose first header cell is `header`, each row's first cell one backticked name. */
function tableTools(text: string, header: string): string[] {
  const out: string[] = [];
  let inTable = false;
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("|")) {
      inTable = false;
      continue;
    }
    const first = t.replace(/^\|/, "").split("|")[0]?.trim() ?? "";
    if (first === header) {
      inTable = true;
      continue;
    }
    if (!inTable || /^:?-{3,}:?$/.test(first)) continue;
    out.push(/^`([^`]+)`$/.exec(first)?.[1] ?? first);
  }
  return out;
}

/** What a list says that the server does not, both ways. */
function drift(list: readonly string[], server: ReadonlySet<string>): { missing: string[]; unknown: string[] } {
  return { missing: [...server].filter((t) => !list.includes(t)).sort(), unknown: list.filter((t) => !server.has(t)) };
}

const TOKEN = await tokenServerTools();
const PUBLIC = await publicServerTools();
const LLMS = read("../../../web/public/llms.txt");
const START = read("../../../web/public/start.md");
const INDEX = read("../../../../docs/agents/README.md");
const CLEAN = { missing: [], unknown: [] };

describe("the lists of MCP tools", () => {
  it("are read from servers that register tools", () => {
    expect(TOKEN.size).toBeGreaterThan(5);
    expect(PUBLIC.size).toBeGreaterThan(2);
  });

  it("core's lists, which every connect page and the skill print, name each server's tools exactly", () => {
    expect(drift(MCP_TOOLS, TOKEN)).toEqual(CLEAN);
    expect(drift(PUBLIC_MCP_TOOLS, PUBLIC)).toEqual(CLEAN);
  });

  for (const [file, text] of [["llms.txt", LLMS], ["start.md", START]] as const) {
    it(`${file} names every tool of each server, and no tool a server does not have`, () => {
      for (const [server, tools] of [["token", TOKEN], ["public", PUBLIC]] as const) {
        const found = sentences(text, server);
        expect(found.length, `${file}: a sentence that opens "${LEADS[server]}"`).toBeGreaterThan(0);
        for (const list of found) expect(drift(list, tools), `${file}: ${server} tools`).toEqual(CLEAN);
      }
    });
  }

  it("docs/agents/README.md's Tool table lists every tool of /mcp, and its Public tool table every tool of /public/mcp, and nothing else", () => {
    expect(drift(tableTools(INDEX, "Tool"), TOKEN)).toEqual(CLEAN);
    expect(drift(tableTools(INDEX, "Public tool"), PUBLIC)).toEqual(CLEAN);
  });
});

describe("the checks themselves", () => {
  const server = new Set(["join", "take", "why"]);

  it("catch a tool a list leaves out and a tool a list names that the server does not have", () => {
    const text = `${LEADS.token}join and take. Later: ${LEADS.token}join, take, why and merge.`;
    const found = sentences(text, "token");
    expect(found).toEqual([["join", "take"], ["join", "take", "why", "merge"]]);
    expect(drift(found[0] ?? [], server)).toEqual({ missing: ["why"], unknown: [] });
    expect(drift(found[1] ?? [], server)).toEqual({ missing: [], unknown: ["merge"] });
    const table = ["| Tool | Arguments |", "| --- | --- |", "| `join` | `colony` |", "| `land` | none |", "", "| Other | x |", "| `why` | y |"].join("\n");
    expect(drift(tableTools(table, "Tool"), server)).toEqual({ missing: ["take", "why"], unknown: ["land"] });
  });

  it("read the lists the way core writes them", () => {
    expect(sentences(toolsSentence("token"), "token")).toEqual([[...MCP_TOOLS]]);
    expect(sentences(toolsSentence("public"), "public")).toEqual([[...PUBLIC_MCP_TOOLS]]);
    expect(words("a, b, and c")).toEqual(["a", "b", "c"]);
  });
});
