/**
 * Ask a deployment's public MCP endpoint (/public/mcp) through the MCP SDK's own client, as any agent would: initialize,
 * list the tools, and call the tools named with --call. Read only: it sends no token. Used by scripts/judge_path.rb and
 * scripts/warm.rb, which read its answer: one JSON object on the last line of stdout with the server's name and version,
 * the protocol version, each step's time in ms, the tool names, and each call's outcome with a short summary.
 *
 *   node scripts/mcp_ask.ts --url https://staging.firetrident.com [--timeout 30] \
 *     [--call 'status={"colony":"hono"}'] [--call 'why={"colony":"hono","path":"src/index.ts"}']
 *
 * Behind Cloudflare Access, CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET (both, from the environment) go with every
 * request; neither is ever printed. Exits 0 when every step answered, 1 when one did not, 2 on bad arguments.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

interface CallOutcome {
  tool: string;
  ok: boolean;
  ms: number;
  summary: string;
  facts: Record<string, unknown>;
  error?: string;
}

interface Answer {
  ok: boolean;
  url: string;
  server: { name: string; version: string } | null;
  protocolVersion: string | null;
  ms: { initialize: number | null; listTools: number | null };
  tools: string[];
  calls: CallOutcome[];
  error?: string;
}

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const base = (flag("url") ?? "").replace(/\/+$/, "");
const timeoutS = Number(flag("timeout") ?? "30");
const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
argv.forEach((a, i) => {
  if (a !== "--call") return;
  const spec = argv[i + 1] ?? "";
  const eq = spec.indexOf("=");
  const tool = eq < 0 ? spec : spec.slice(0, eq);
  let args: unknown = {};
  try {
    args = eq < 0 ? {} : JSON.parse(spec.slice(eq + 1));
  } catch {
    args = null;
  }
  if (!tool || !args || typeof args !== "object" || Array.isArray(args)) {
    console.error(`--call takes <tool>=<JSON object of arguments>, not ${JSON.stringify(spec)}`);
    process.exit(2);
  }
  calls.push({ tool, args: args as Record<string, unknown> });
});
if (!/^https?:\/\/[^/]+/.test(base) || !Number.isFinite(timeoutS) || timeoutS <= 0) {
  console.error("usage: node scripts/mcp_ask.ts --url <deployment> [--timeout <s>] [--call <tool>=<JSON arguments>]...");
  process.exit(2);
}

const id = process.env.CF_ACCESS_CLIENT_ID?.trim() ?? "";
const secret = process.env.CF_ACCESS_CLIENT_SECRET?.trim() ?? "";
if (!id !== !secret) {
  console.error("set both CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET to reach a deployment behind Cloudflare Access, or neither");
  process.exit(2);
}
const headers: Record<string, string> = id ? { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret } : {};
const secrets = [id, secret].filter((s) => s.length >= 4);

/** `text` with the Access values taken out. */
function redact(text: string): string {
  return secrets.reduce((out, s) => out.split(s).join("<redacted>"), text);
}

function messageOf(e: unknown): string {
  return redact(e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 300);
}

/** A tool answer's text, parsed as JSON when it is JSON. */
function parsed(result: Record<string, unknown>): unknown {
  const text = (Array.isArray(result.content) ? result.content : [])
    .map((c: { type?: string; text?: string }) => (c?.type === "text" ? (c.text ?? "") : ""))
    .join("");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

/** A few words about an answer, and the facts the stage scripts check. */
function describe(tool: string, data: unknown): { summary: string; facts: Record<string, unknown> } {
  if (tool === "status" && isObj(data) && isObj(data.colony)) {
    const trunk = isObj(data.trunk) ? data.trunk : {};
    const head = typeof trunk.head === "string" ? trunk.head : null;
    const landings = Array.isArray(data.landings) ? data.landings.length : 0;
    const intents = isObj(data.intents) && typeof data.intents.total === "number" ? data.intents.total : 0;
    return {
      summary: `colony ${String(data.colony.id)}, head ${head ? head.slice(0, 7) : "none"}, ${intents} intents, ${landings} recent landings`,
      facts: { colony: data.colony.id, head, landings, intents },
    };
  }
  if (tool === "why" && isObj(data) && Array.isArray(data.entries)) {
    const first = data.entries[0];
    const landing = isObj(first) && isObj(first.landing) && typeof first.landing.id === "string" ? first.landing.id : null;
    return {
      summary: `${String(data.path)}: ${data.entries.length} landing${data.entries.length === 1 ? "" : "s"}${landing ? (typeof data.line === "number" ? `, line ${data.line} written by ${landing}` : `, newest ${landing}`) : ""}`,
      facts: { path: data.path, landings: data.entries.length, first: landing },
    };
  }
  const text = typeof data === "string" ? data : JSON.stringify(data);
  return { summary: text.replace(/\s+/g, " ").slice(0, 120), facts: {} };
}

const answer: Answer = { ok: false, url: `${base}/public/mcp`, server: null, protocolVersion: null, ms: { initialize: null, listTools: null }, tools: [], calls: [] };
const print = (): void => {
  process.stdout.write(`${redact(JSON.stringify(answer))}\n`);
};
// A hard stop: whatever has not answered by then is reported as such.
const hard = setTimeout(
  () => {
    answer.error = `no answer within ${timeoutS} s`;
    print();
    process.exit(1);
  },
  (timeoutS + 5) * 1000,
);

async function main(): Promise<void> {
  const transport = new StreamableHTTPClientTransport(new URL(answer.url), { requestInit: { headers } });
  const client = new Client({ name: "firetrident-stage-check", version: "0.0.1" });
  const opts = { timeout: timeoutS * 1000 };
  let t = performance.now();
  try {
    await client.connect(transport, opts);
  } catch (e) {
    answer.error = `initialize failed: ${messageOf(e)}`;
    return;
  }
  answer.ms.initialize = Math.round(performance.now() - t);
  const server = client.getServerVersion();
  answer.server = server ? { name: server.name, version: server.version } : null;
  answer.protocolVersion = transport.protocolVersion ?? null;
  try {
    t = performance.now();
    const listed = await client.listTools(undefined, opts);
    answer.ms.listTools = Math.round(performance.now() - t);
    answer.tools = listed.tools.map((x) => x.name);
  } catch (e) {
    answer.error = `tools/list failed: ${messageOf(e)}`;
    await client.close().catch(() => undefined);
    return;
  }
  let allOk = true;
  for (const c of calls) {
    t = performance.now();
    try {
      const res = await client.callTool({ name: c.tool, arguments: c.args }, undefined, opts);
      const data = parsed(res);
      const failed = res.isError === true;
      const { summary, facts } = describe(c.tool, data);
      const outcome: CallOutcome = { tool: c.tool, ok: !failed, ms: Math.round(performance.now() - t), summary: redact(summary), facts };
      if (failed) outcome.error = redact(typeof data === "string" ? data : JSON.stringify(data)).slice(0, 300);
      answer.calls.push(outcome);
      allOk &&= !failed;
    } catch (e) {
      answer.calls.push({ tool: c.tool, ok: false, ms: Math.round(performance.now() - t), summary: "", facts: {}, error: messageOf(e) });
      allOk = false;
    }
  }
  await client.close().catch(() => undefined);
  answer.ok = allOk;
}

main()
  .catch((e: unknown) => {
    answer.error = messageOf(e);
  })
  .finally(() => {
    clearTimeout(hard);
    print();
    process.exit(answer.ok ? 0 : 1);
  });
