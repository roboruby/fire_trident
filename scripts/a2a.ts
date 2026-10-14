/**
 * Live check of the Agent2Agent door (FT_A2A) on a deployment: an orchestrator hands a colony work the standard way and
 * follows it to the landing commit. The admin API makes the colony, plain fetch reads the card and sends the JSON-RPC
 * methods, and a scripted external agent over MCP takes the work and lands it with an inline change.
 * - GET /api/about lists FT_A2A; the colony's card is public and names the JSON-RPC URL, the declare-intent skill and
 *   the bearer token writes need;
 * - SendMessage without the admin token, and with a wrong one, is refused with HTTP 401 and JSON-RPC error -32000 and
 *   declares nothing; with the token it declares an intent and answers its task, submitted, which GetTask (no token)
 *   reads back;
 * - the scripted agent takes the intent over MCP and proposes its change inline; once it lands, GetTask (no token)
 *   answers completed with the landing commit, the one the colony's own landing record names, and the artifact's why
 *   link answers; ListTasks (no token) lists it, with the landing only when asked; tasks/get answers in 0.3's shapes;
 * - a second SendMessage declares another intent; CancelTask without the token is refused, with it the task is canceled
 *   and the intent withdrawn with a reason that starts with "canceled over A2A"; the completed task cannot be canceled;
 * - an unknown method, bad params and a body that is not JSON answer -32601, -32602 and -32700;
 * - with --twins (FT_TWINS covers the colony): a message matching the landed intent answers that intent's task, says so,
 *   and declares nothing.
 * The colony must not exist yet. The deployment needs FT_A2A and FT_INLINE covering the colony (a preview:
 * npx wrangler preview --name <x> --var FT_A2A:on --var FT_INLINE:on, plus --var FT_TWINS:on for --twins).
 *
 * Usage:
 *   FT_MCP_TOKEN=... FT_ADMIN_TOKEN=... node scripts/a2a.ts --url https://<deployment> --colony <new colony id> [--twins]
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const URL_BASE = (arg("url", process.env.FT_URL) ?? "").replace(/\/+$/, "");
const COLONY = arg("colony") ?? "";
const TWINS = process.argv.includes("--twins");
const MCP_TOKEN = process.env.FT_MCP_TOKEN ?? "";
const ADMIN_TOKEN = process.env.FT_ADMIN_TOKEN ?? "";
if (!URL_BASE || !COLONY || !MCP_TOKEN || !ADMIN_TOKEN) {
  console.error("usage: FT_MCP_TOKEN=... FT_ADMIN_TOKEN=... node scripts/a2a.ts --url <deployment> --colony <new colony id FT_A2A and FT_INLINE cover> [--twins]");
  process.exit(2);
}

const FILE = "docs/a2a-check.md";
const FIRST = { text: `Add ${FILE}\nThe Agent2Agent check writes one file and follows the intent to its landing commit.`, footprint: [FILE] };
const SECOND = { text: "Tidy the README introduction\nThe Agent2Agent check cancels this one before any agent takes it.", footprint: ["README.md"] };

let failed = false;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failed = true;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const short = (x: unknown, n = 160): string => String(typeof x === "string" ? x : JSON.stringify(x ?? null)).replace(/\s+/g, " ").slice(0, n);

async function rest(method: string, path: string, body?: unknown, token: string | null = ADMIN_TOKEN): Promise<{ status: number; data: any; type: string }> {
  const res = await fetch(`${URL_BASE}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text.slice(0, 300) };
  }
  return { status: res.status, data, type: res.headers.get("content-type") ?? "" };
}

/** A public read: no token, as anyone reads it. */
const read = (path: string) => rest("GET", path, undefined, null);

let seq = 0;
/** One JSON-RPC request to the colony's door; `token` null sends none, as a public read. `raw` sends that body instead. */
async function rpc(method: string, params?: unknown, token: string | null = ADMIN_TOKEN, raw?: string): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await fetch(`${URL_BASE}/api/colonies/${COLONY}/a2a`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: raw ?? JSON.stringify({ jsonrpc: "2.0", id: ++seq, method, ...(params !== undefined ? { params } : {}) }),
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 300) };
  }
  return { status: res.status, body, headers: res.headers };
}

/** SendMessage params for a declaration: a text part, a data part with the footprint, and no wait. */
function sendParams(m: { text: string; footprint: string[] }, extra: Record<string, unknown> = {}) {
  return {
    message: { messageId: `m-${Date.now()}-${++seq}`, role: "ROLE_USER", parts: [{ text: m.text }, { data: { footprint: m.footprint, ...extra } }] },
    configuration: { returnImmediately: true },
  };
}

const stateOf = (t: any): string => String(t?.status?.state ?? "");
const textOf = (t: any): string => String(t?.status?.message?.parts?.[0]?.text ?? "");

/** One MCP session: an external agent of its own. */
async function session(name: string): Promise<{ call: (tool: string, args?: Record<string, unknown>) => Promise<{ ok: boolean; data: any; text: string }>; close: () => Promise<void> }> {
  const transport = new StreamableHTTPClientTransport(new URL(`${URL_BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${MCP_TOKEN}` } } });
  const client = new Client({ name, version: "0.0.1" });
  await client.connect(transport);
  const call = async (tool: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name: tool, arguments: args });
    const text = ((res.content as Array<{ type: string; text?: string }> | undefined) ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
    let data: any = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    return { ok: res.isError !== true, data, text };
  };
  return { call, close: () => client.close() };
}

/** Wait for a proposal to settle; its status and landing. */
async function settle(pid: string): Promise<{ status: string; landingId: string | null }> {
  let p: any = {};
  for (let i = 0; i < 40 && !["landed", "returned", "rejected"].includes(p.status ?? ""); i++) {
    await sleep(3000);
    p = (await rest("GET", `/api/colonies/${COLONY}/proposals/${pid}`)).data ?? {};
  }
  return { status: p.status ?? "", landingId: p.landingId ?? null };
}

/** The colony's intents, as GET /api/colonies/:id lists them. */
async function intents(): Promise<any[]> {
  const snap = await read(`/api/colonies/${COLONY}`);
  return Array.isArray(snap.data?.intents) ? snap.data.intents : [];
}

/** Take the intent the check declared, over MCP, giving back any other the colony offers first; then land it inline. */
async function land(intentId: string): Promise<{ status: string; landingId: string | null }> {
  const s = await session(`a2a-${COLONY}`);
  const joined = await s.call("join", { colony: COLONY, name: "a2a-check", model: "scripted-writer" });
  check(`${COLONY}: a scripted agent joined over MCP (${short(joined.data?.agentId)})`, joined.ok && typeof joined.data?.agentId === "string");
  let taken = await s.call("take", { wait: 30 });
  for (let i = 0; i < 5 && taken.data?.intent?.id !== intentId; i++) {
    if (taken.data?.intent) await s.call("release", { reason: "the Agent2Agent check wants its own intent" });
    taken = await s.call("take", { wait: 30 });
  }
  check(`${COLONY}: it took ${intentId}`, taken.data?.intent?.id === intentId);
  const proposed = await s.call("propose", {
    files: [{ path: FILE, content: "# Agent2Agent check\n\nAn orchestrator declared this file over the Agent2Agent protocol and an agent landed it.\n" }],
    summary: `Add ${FILE}`,
    notVerified: "Not verified: the check ran nothing; it reads the landing back over the Agent2Agent door.",
  });
  check(`${COLONY}: it proposed the change inline (${short(proposed.data?.proposal?.id)})`, proposed.ok && typeof proposed.data?.proposal?.id === "string");
  const settled = await settle(proposed.data?.proposal?.id ?? "");
  await s.close();
  check(`${COLONY}: the change landed (${settled.status}, ${short(settled.landingId)})`, settled.status === "landed" && typeof settled.landingId === "string");
  return settled;
}

async function main(): Promise<void> {
  const about = await read("/api/about");
  check(`GET /api/about lists FT_A2A (${short(about.data?.flags)})`, about.status === 200 && Array.isArray(about.data?.flags) && about.data.flags.includes("FT_A2A"));

  // A new colony with a warm pool for the agent's lease, review off so the landing needs no model.
  const made = await rest("POST", "/api/colonies", { name: COLONY, poolTarget: 2 });
  check(`created ${COLONY} (${made.status})`, made.status === 201);
  check(`${COLONY}: review off for this check`, (await rest("POST", `/api/colonies/${COLONY}/decide/policy`, { enabled: false })).status === 200);

  // The card, with no token.
  const door = `${URL_BASE}/api/colonies/${COLONY}/a2a`;
  const card = await read(`/api/colonies/${COLONY}/.well-known/agent-card.json`);
  check(`the card is public and names the colony (${card.status}, ${short(card.data?.name)})`, card.status === 200 && card.type.includes("application/json") && card.data?.name === `FireTrident colony ${COLONY}`);
  check(`it names the JSON-RPC URL ${door} for A2A 1.0 and 0.3`, card.data?.supportedInterfaces?.[0]?.url === door && card.data?.supportedInterfaces?.[0]?.protocolBinding === "JSONRPC" && card.data?.supportedInterfaces?.map((i: any) => i.protocolVersion).join(",") === "1.0,0.3");
  check(`it offers one skill, declare-intent (${short(card.data?.skills?.map((s: any) => s.id))})`, card.data?.skills?.length === 1 && card.data.skills[0]?.id === "declare-intent" && /footprint/.test(card.data.skills[0]?.description ?? ""));
  check(`it says writes need a bearer token (${short(card.data?.securitySchemes)})`, card.data?.securitySchemes?.adminToken?.httpAuthSecurityScheme?.scheme === "Bearer" && card.data?.securityRequirements?.[0]?.schemes?.adminToken !== undefined);
  check(`it offers no streaming and no push notifications`, card.data?.capabilities?.streaming === false && card.data?.capabilities?.pushNotifications === false);

  // SendMessage without the token, and with a wrong one.
  for (const [label, token] of [["no token", null], ["a wrong token", "not-the-token"]] as Array<[string, string | null]>) {
    const refused = await rpc("SendMessage", sendParams(FIRST), token);
    check(
      `SendMessage with ${label} is refused: HTTP ${refused.status}, code ${short(refused.body?.error?.code)} (${short(refused.body?.error?.message, 90)})`,
      refused.status === 401 && refused.body?.error?.code === -32000 && /admin token/.test(refused.body?.error?.message ?? "") && refused.headers.get("www-authenticate") === "Bearer",
    );
  }
  check(`${COLONY}: nothing was declared`, (await intents()).length === 0);

  // With the token: an intent, submitted.
  const sent = await rpc("SendMessage", sendParams(FIRST));
  const first = sent.body?.result?.task;
  const id: string = typeof first?.id === "string" ? first.id : "";
  check(`SendMessage with the token declared ${short(id)}, submitted (${sent.status}, ${short(stateOf(first))})`, sent.status === 200 && /^int_/.test(id) && stateOf(first) === "TASK_STATE_SUBMITTED" && first?.contextId === COLONY);
  check(`its intent is "${FIRST.text.split("\n")[0]}" with footprint ${FILE}`, (await intents()).some((i) => i.id === id && i.title === FIRST.text.split("\n")[0] && i.footprint?.[0] === FILE && i.createdBy === "a2a"));
  const got = await rpc("GetTask", { id }, null);
  check(`GetTask with no token reads it back submitted (${short(textOf(got.body?.result), 100)})`, got.status === 200 && stateOf(got.body?.result) === "TASK_STATE_SUBMITTED" && textOf(got.body?.result).startsWith(`Intent ${id} is open in colony ${COLONY}`));
  if (!id) throw new Error("nothing was declared: the rest of the check needs the intent");

  // An agent takes it and lands it.
  const settled = await land(id);
  if (!settled.landingId) throw new Error("the change did not land");

  // GetTask: completed, with the landing commit.
  const done = await rpc("GetTask", { id }, null);
  const task = done.body?.result;
  const landing = task?.artifacts?.[0]?.parts?.[1]?.data;
  const commit: string = typeof landing?.commit === "string" ? landing.commit : "";
  check(`GetTask reports completed with landing ${short(landing?.landing)} and commit ${short(commit)}`, stateOf(task) === "TASK_STATE_COMPLETED" && landing?.landing === settled.landingId && /^[0-9a-f]{40}$/.test(commit));
  check(`its status says so and names ft why ${COLONY} ${FILE} (${short(textOf(task), 120)})`, textOf(task).includes(`landed in trunk commit ${commit}`) && textOf(task).includes(`ft why ${COLONY} ${FILE}`));
  const snap = await read(`/api/colonies/${COLONY}`);
  const recorded = (Array.isArray(snap.data?.recentLandings) ? snap.data.recentLandings : []).find((l: any) => l?.id === settled.landingId);
  check(`the colony's landing record names the same commit (${short(recorded?.trunkSha)})`, recorded?.trunkSha === commit);
  const whyUrl: string = typeof landing?.files?.[0]?.why === "string" ? landing.files[0].why : "";
  const why = whyUrl ? await fetch(whyUrl) : null;
  check(`the artifact's why link answers (${short(whyUrl)}: ${why?.status})`, landing?.files?.[0]?.path === FILE && why?.status === 200);

  // ListTasks, public; the landing only when asked. tasks/get in 0.3's shapes.
  const listed = await rpc("ListTasks", {}, null);
  const row = listed.body?.result?.tasks?.find((t: any) => t.id === id);
  check(`ListTasks with no token lists it completed (totalSize ${short(listed.body?.result?.totalSize)})`, listed.status === 200 && stateOf(row) === "TASK_STATE_COMPLETED" && row?.artifacts === undefined && listed.body?.result?.totalSize >= 1);
  const filtered = await rpc("ListTasks", { status: "TASK_STATE_COMPLETED", includeArtifacts: true }, null);
  const frow = filtered.body?.result?.tasks?.find((t: any) => t.id === id);
  check(`filtered by TASK_STATE_COMPLETED with includeArtifacts it carries the commit`, frow?.artifacts?.[0]?.parts?.[1]?.data?.commit === commit);
  const old = await rpc("tasks/get", { id }, null);
  check(`tasks/get answers in 0.3's shapes (${short(old.body?.result?.kind)}, ${short(stateOf(old.body?.result))})`, old.body?.result?.kind === "task" && stateOf(old.body?.result) === "completed" && old.body?.result?.artifacts?.[0]?.parts?.[1]?.kind === "data");

  // A second intent, canceled.
  const sent2 = await rpc("SendMessage", sendParams(SECOND));
  const id2: string = typeof sent2.body?.result?.task?.id === "string" ? sent2.body.result.task.id : "";
  check(`a second SendMessage declared ${short(id2)}, submitted`, /^int_/.test(id2) && id2 !== id && stateOf(sent2.body?.result?.task) === "TASK_STATE_SUBMITTED");
  const refusedCancel = await rpc("CancelTask", { id: id2 }, null);
  check(`CancelTask with no token is refused: HTTP ${refusedCancel.status}, code ${short(refusedCancel.body?.error?.code)}`, refusedCancel.status === 401 && refusedCancel.body?.error?.code === -32000);
  const canceled = await rpc("CancelTask", { id: id2, metadata: { reason: "the plan changed" } });
  check(`CancelTask with the token reports it canceled (${short(textOf(canceled.body?.result), 110)})`, canceled.status === 200 && stateOf(canceled.body?.result) === "TASK_STATE_CANCELED" && textOf(canceled.body?.result).includes("withdrawn by CancelTask (the plan changed)"));
  const withdrawn = (await intents()).find((i) => i.id === id2);
  check(`the intent is withdrawn with the reason "${short(withdrawn?.withdrawnReason)}"`, withdrawn?.status === "withdrawn" && String(withdrawn?.withdrawnReason ?? "").startsWith("canceled over A2A"));
  check(`GetTask reads it canceled afterwards`, stateOf((await rpc("GetTask", { id: id2 }, null)).body?.result) === "TASK_STATE_CANCELED");
  const late = await rpc("CancelTask", { id });
  check(`the completed task cannot be canceled (code ${short(late.body?.error?.code)})`, late.body?.error?.code === -32002 && /is completed/.test(late.body?.error?.message ?? ""));

  // Standard errors.
  check(`an unknown method answers -32601`, (await rpc("tasks/reticulate", {})).body?.error?.code === -32601);
  check(`bad params answer -32602`, (await rpc("GetTask", {})).body?.error?.code === -32602);
  check(`a body that is not JSON answers -32700`, (await rpc("", undefined, ADMIN_TOKEN, "{not json")).body?.error?.code === -32700);

  // A twin, where the deployment catches them.
  if (TWINS) {
    const twin = await rpc("SendMessage", sendParams({ text: `Add ${FILE}\nThe same work, declared again.`, footprint: [FILE] }));
    const t = twin.body?.result?.task;
    check(`a matching message answers the landed intent's task ${short(t?.id)} and says so (${short(textOf(t), 90)})`, t?.id === id && t?.metadata?.firetrident?.duplicateOf === id && textOf(t).startsWith("Nothing new was declared"));
    check(`${COLONY}: it declared nothing`, (await intents()).length === 2);
  } else {
    console.log("SKIP  twin answer: run with --twins where FT_TWINS covers the colony");
  }

  console.log(failed ? "SOME CHECKS FAILED" : "ALL CHECKS PASSED");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(`a2a check failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
