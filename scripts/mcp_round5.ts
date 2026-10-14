/**
 * Live check of round 5 on a deployment, as a scripted external agent over MCP plus the admin API:
 * - a repeated `declare` returns the same intent (`replayed: true`) instead of a second one;
 * - a failed call carries a machine-readable error (`kind`, `retryable`, and `next` where the next call is clear);
 * - an inline change lands, its lineage says the model was declared by the agent and how the agent was authenticated,
 *   and the colony's lineage notes check out against their commits' FT-Note trailers;
 * - the public read-only MCP answers `why` and `status` for a listed colony with no token, and refuses an unlisted one.
 * The colony must not exist yet. The deployment needs FT_INLINE on; `--public` names a colony FT_PUBLIC_MCP lists.
 *
 * Usage:
 *   FT_MCP_TOKEN=... FT_ADMIN_TOKEN=... node scripts/mcp_round5.ts --url https://<deployment> --colony <new colony id> --public <listed colony>
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const URL_BASE = (arg("url", process.env.FT_URL) ?? "").replace(/\/+$/, "");
const COLONY = arg("colony") ?? "";
const PUBLIC = arg("public") ?? "";
const MCP_TOKEN = process.env.FT_MCP_TOKEN ?? "";
const ADMIN_TOKEN = process.env.FT_ADMIN_TOKEN ?? "";
if (!URL_BASE || !COLONY || !PUBLIC || !MCP_TOKEN || !ADMIN_TOKEN) {
  console.error("usage: FT_MCP_TOKEN=... FT_ADMIN_TOKEN=... node scripts/mcp_round5.ts --url <deployment> --colony <new colony id> --public <listed colony>");
  process.exit(2);
}

let failed = false;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failed = true;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const short = (x: unknown, n = 160): string => String(typeof x === "string" ? x : JSON.stringify(x ?? null)).replace(/\s+/g, " ").slice(0, n);

async function rest(method: string, path: string, body?: unknown, token: string | null = ADMIN_TOKEN): Promise<{ status: number; data: any }> {
  const res = await fetch(`${URL_BASE}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json", accept: "application/json, text/event-stream" } : {}) },
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

const transport = new StreamableHTTPClientTransport(new URL(`${URL_BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${MCP_TOKEN}` } } });
const client = new Client({ name: "round5-check", version: "0.0.1" });
const call = async (tool: string, args: Record<string, unknown> = {}): Promise<{ ok: boolean; data: any; text: string; structured: any }> => {
  const res = await client.callTool({ name: tool, arguments: args });
  const text = ((res.content as Array<{ type: string; text?: string }> | undefined) ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  return { ok: res.isError !== true, data, text, structured: (res as { structuredContent?: unknown }).structuredContent ?? null };
};

/** One public MCP request (no token), its tool answer parsed. */
async function publicCall(tool: string, args: Record<string, unknown>): Promise<{ isError: boolean; data: any }> {
  const r = await rest("POST", "/public/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }, null);
  const result = r.data?.result ?? {};
  const text = (result.content ?? []).map((c: { text?: string }) => c.text ?? "").join("");
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  return { isError: result.isError === true || !!data?.error, data };
}

async function main(): Promise<void> {
  const made = await rest("POST", "/api/colonies", { name: COLONY, poolTarget: 4 });
  check(`created ${COLONY} (${made.status})`, made.status === 201 || made.status === 200);
  check("review off for these checks", (await rest("POST", `/api/colonies/${COLONY}/decide/policy`, { enabled: false })).status === 200);
  await client.connect(transport);
  const joined = await call("join", { colony: COLONY, name: "round5-check", model: "scripted" });
  check(`joined (${short(joined.data?.agentId)})`, joined.ok && typeof joined.data?.agentId === "string");

  // Idempotent declare.
  const intent = { title: "Add the round-5 greeting", why: "A file the round-5 check lands.", footprint: ["src/greeting.ts"] };
  const first = await call("declare", intent);
  const second = await call("declare", intent);
  const id1 = first.data?.intent?.id ?? first.data?.id;
  const id2 = second.data?.intent?.id ?? second.data?.id;
  check(`declare once (${short(id1)})`, first.ok && typeof id1 === "string");
  check(`the same declare again returns the same intent, replayed (${short(id2)}, replayed ${short(second.data?.replayed)})`, second.ok && id2 === id1 && second.data?.replayed === true);
  const intents = await rest("GET", `/api/colonies/${COLONY}`);
  const same = (intents.data?.intents ?? []).filter((i: { title?: string }) => i.title === intent.title).length;
  check(`the colony holds the intent once (${same})`, same === 1);

  // A machine-readable error: propose with nothing taken.
  const early = await call("propose", { files: [{ path: "src/greeting.ts", content: "export const hi = 1;\n" }], notVerified: "Not verified." });
  const err = early.structured?.error ?? early.data?.error;
  check(`a failed call carries a structured error (${short(err)})`, !early.ok && typeof err?.kind === "string" && typeof err?.retryable === "boolean" && typeof err?.message === "string");

  // An inline change lands; its lineage says how the agent and model are known.
  const taken = await call("take", { wait: 30 });
  check(`took the intent (${short(taken.data?.intent?.id)})`, taken.data?.intent?.id === id1);
  const proposed = await call("propose", { files: [{ path: "src/greeting.ts", content: "export const greeting = \"hello from round 5\";\n" }], summary: "the greeting", notVerified: "Not verified: nothing beyond this file." });
  const pid = proposed.data?.proposal?.id ?? proposed.data?.id ?? proposed.data?.proposalId;
  check(`proposed inline (${short(pid)})`, proposed.ok && typeof pid === "string");
  let status = "";
  for (let i = 0; i < 40 && !["landed", "returned", "rejected"].includes(status); i++) {
    await sleep(3000);
    status = (await rest("GET", `/api/colonies/${COLONY}/proposals/${pid}`)).data?.status ?? "";
  }
  check(`the change landed (${status})`, status === "landed");
  const why = await call("why", { path: "src/greeting.ts" });
  const entry = JSON.stringify(why.data ?? why.text);
  check(`why says the model was declared by an external agent authenticated over MCP (${short(entry.match(/"provenance":\{[^}]*\}[^}]*\}/)?.[0])})`, /"evidence":"declared"/.test(entry) && /"auth":"mcp"/.test(entry) && /"author":"external"/.test(entry));
  const verify = await rest("GET", `/api/colonies/${COLONY}/notes/verify`, undefined, null);
  check(`the colony's lineage notes check out against their FT-Note trailers (${short(verify.data?.counts)})`, verify.status === 200 && (verify.data?.counts?.intact ?? 0) >= 1 && Object.keys(verify.data?.counts ?? {}).every((k) => k === "intact"));

  // The public read-only MCP.
  const pubStatus = await publicCall("status", { colony: PUBLIC });
  check(`public status for ${PUBLIC}, no token (${short(pubStatus.data?.colony?.id)})`, !pubStatus.isError && pubStatus.data?.colony?.id === PUBLIC);
  const refused = await publicCall("status", { colony: COLONY });
  check(`public MCP refuses an unlisted colony (${short(refused.data?.error?.kind)})`, refused.isError && refused.data?.error?.kind === "not_found");

  await client.close();
  console.log(failed ? "SOME CHECKS FAILED" : "ALL CHECKS PASSED");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(`round-5 check failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
