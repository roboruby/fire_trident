/**
 * End-to-end check of escalations over MCP: an external agent joins a colony that has open intents,
 * takes one, and reports that it cannot be done as written (`escalate`); the report waits for a
 * person (`GET /escalations`), no agent can take the intent meanwhile, and a person's answer
 * (`POST /intents/:iid/escalation`, dismiss) reopens it.
 *
 * Usage:
 *   FT_MCP_TOKEN=... FT_ADMIN_TOKEN=... node scripts/mcp_escalate.ts --url https://<deployment> --colony <id with open intents>
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const URL_BASE = (arg("url", process.env.FT_URL) ?? "").replace(/\/+$/, "");
const COLONY = arg("colony") ?? "";
const MCP_TOKEN = process.env.FT_MCP_TOKEN ?? "";
const ADMIN_TOKEN = process.env.FT_ADMIN_TOKEN ?? "";
if (!URL_BASE || !COLONY) {
  console.error("usage: node scripts/mcp_escalate.ts --url <deployment> --colony <colony>");
  process.exit(2);
}

let failed = false;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failed = true;
}

async function rest(method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
  const res = await fetch(`${URL_BASE}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text.slice(0, 300) };
  }
  return { status: res.status, data };
}

const transport = new StreamableHTTPClientTransport(new URL(`${URL_BASE}/mcp`), {
  ...(MCP_TOKEN ? { requestInit: { headers: { Authorization: `Bearer ${MCP_TOKEN}` } } } : {}),
});
const client = new Client({ name: "firetrident-mcp-escalate", version: "0.0.1" });
await client.connect(transport);
const tools = (await client.listTools()).tools.map((t) => t.name);
check(`the server offers escalate (tools: ${tools.join(", ")})`, tools.includes("escalate"));

const call = async (name: string, args: Record<string, unknown> = {}): Promise<{ ok: boolean; data: any; text: string }> => {
  const res = await client.callTool({ name, arguments: args });
  const text = ((res.content as Array<{ type: string; text?: string }> | undefined) ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  return { ok: res.isError !== true, data, text };
};

const joined = await call("join", { colony: COLONY, name: "escalate-check", model: "scripted" });
check(`joined ${COLONY}`, joined.ok);
const taken = await call("take", { wait: 20 });
const intentId: string | undefined = taken.data?.intent?.id;
check(`took an intent (${intentId ?? taken.text.slice(0, 160)})`, taken.ok && !!intentId);
if (!intentId) {
  await client.close();
  process.exit(1);
}
const report = "The rule asks for a change this file cannot make without breaking its public API; a person should decide.";
const esc = await call("escalate", { intentId, kind: "contradictory-spec", report });
check(`escalate answered (${esc.text.slice(0, 160)})`, esc.ok);

const open = await rest("GET", `/colonies/${COLONY}/escalations`);
const listed = (Array.isArray(open.data) ? open.data : (open.data?.escalations ?? open.data?.intents ?? [])) as Array<{ id: string; escalation?: { report?: string } }>;
const mine = listed.find((i) => i.id === intentId);
check(`the report waits for a person (GET /escalations ${open.status}, ${listed.length} open)`, open.status === 200 && mine?.escalation?.report === report);

const again = await call("take", { wait: 3 });
check(`no agent can take the intent meanwhile (${again.data?.intent?.id ?? "nothing taken"})`, again.data?.intent?.id !== intentId);
if (again.data?.intent?.id) await call("release", { reason: "escalate check: giving back the other intent" });

const resolved = await rest("POST", `/colonies/${COLONY}/intents/${intentId}/escalation`, { decision: "dismiss", note: "Checked: it can be done as written.", by: "escalate-check" });
check(`a person dismissed it (${resolved.status})`, resolved.status === 200 && resolved.data?.intent?.escalation?.resolved?.decision === "dismiss");
check(`the intent is open again (${resolved.data?.intent?.status})`, resolved.data?.intent?.status === "open");
const after = await rest("GET", `/colonies/${COLONY}/escalations`);
const still = (Array.isArray(after.data) ? after.data : (after.data?.escalations ?? after.data?.intents ?? [])) as Array<{ id: string }>;
check("it no longer waits", !still.some((i) => i.id === intentId));

await client.close();
console.log(failed ? "SOME CHECKS FAILED" : "ALL CHECKS PASSED");
process.exit(failed ? 1 : 0);
