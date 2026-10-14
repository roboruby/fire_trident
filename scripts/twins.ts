/**
 * Live check of twin intents caught at declare (FT_TWINS) on a deployment, with scripted external agents over MCP plus
 * the admin API. Nothing is taken or proposed: the check only declares.
 * - In the colony the flag covers (--colony): one MCP session declares "Add rate limiting to /api/links" with footprint
 *   ["src/links/**"]; a second session declares "Rate-limit the links API" with footprint ["src/links/handler.ts"] and
 *   gets the first intent back, with duplicateOf, similar (its score) and a note, and no new intent; the same declare
 *   with force: true creates one. Over REST, a third wording answers 200 with duplicateOf (the first intent, declared
 *   before the forced copy), and with force 201.
 * - In a colony the flag does not cover (--off): both declares create an intent, and so does the REST one (201).
 * - GET /api/about lists FT_TWINS, and the declare tool offers force and says what a twin answers.
 * Both colonies must not exist yet. The deployment needs FT_TWINS naming the first colony and not the second (a preview:
 * npx wrangler preview --name <x> --var FT_TWINS:<colony>).
 *
 * Usage:
 *   FT_MCP_TOKEN=... FT_ADMIN_TOKEN=... node scripts/twins.ts --url https://<deployment> --colony <flag-on colony> --off <flag-off colony>
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const URL_BASE = (arg("url", process.env.FT_URL) ?? "").replace(/\/+$/, "");
const ON = arg("colony") ?? "";
const OFF = arg("off") ?? "";
const MCP_TOKEN = process.env.FT_MCP_TOKEN ?? "";
const ADMIN_TOKEN = process.env.FT_ADMIN_TOKEN ?? "";
if (!URL_BASE || !ON || !OFF || ON === OFF || !MCP_TOKEN || !ADMIN_TOKEN) {
  console.error("usage: FT_MCP_TOKEN=... FT_ADMIN_TOKEN=... node scripts/twins.ts --url <deployment> --colony <new colony FT_TWINS names> --off <another new colony>");
  process.exit(2);
}

const FIRST = { title: "Add rate limiting to /api/links", why: "The links API is open to bursts that slow every other caller.", footprint: ["src/links/**"] };
const TWIN = { title: "Rate-limit the links API", why: "Callers can flood the links endpoints.", footprint: ["src/links/handler.ts"] };
const REST_TWIN = { title: "Add rate-limiting for the links API", why: "Too many link requests from one caller.", footprint: ["src/links/"] };

let failed = false;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failed = true;
}
const short = (x: unknown, n = 160): string => String(typeof x === "string" ? x : JSON.stringify(x ?? null)).replace(/\s+/g, " ").slice(0, n);

async function rest(method: string, path: string, body?: unknown, token: string | null = ADMIN_TOKEN): Promise<{ status: number; data: any }> {
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
  return { status: res.status, data };
}

type Session = {
  call: (tool: string, args?: Record<string, unknown>) => Promise<{ ok: boolean; data: any; text: string }>;
  declareTool: () => Promise<{ description: string; args: string[] }>;
  close: () => Promise<void>;
};

/** One MCP session joined to a colony: an external agent of its own. */
async function session(colony: string, name: string): Promise<Session> {
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
  const declareTool = async () => {
    const tool = (await client.listTools()).tools.find((t) => t.name === "declare");
    return { description: tool?.description ?? "", args: Object.keys(tool?.inputSchema.properties ?? {}) };
  };
  const joined = await call("join", { colony, name, model: "scripted" });
  check(`${colony}: ${name} joined (${short(joined.data?.agentId)})`, joined.ok && typeof joined.data?.agentId === "string");
  return { call, declareTool, close: () => client.close() };
}

/** A new colony, with no warm pool: nothing here takes work. */
async function create(colony: string): Promise<void> {
  const made = await rest("POST", "/api/colonies", { name: colony, poolTarget: 0 });
  check(`created ${colony} (${made.status})`, made.status === 201);
}

/** The colony's intents with this title. */
async function titled(colony: string, title: string): Promise<any[]> {
  const snap = await rest("GET", `/api/colonies/${colony}`);
  return (Array.isArray(snap.data?.intents) ? snap.data.intents : []).filter((i: any) => i?.title === title);
}

/** The flagged colony: the twin comes back with duplicateOf and its score, and force creates it. */
async function flagged(): Promise<void> {
  await create(ON);
  const s1 = await session(ON, "twins-first");
  const first = await s1.call("declare", FIRST);
  const firstId = first.data?.intent?.id;
  check(`${ON}: the first session declared "${FIRST.title}" (${short(firstId)})`, first.ok && typeof firstId === "string" && first.data?.duplicateOf === undefined);

  const s2 = await session(ON, "twins-second");
  const tool = await s2.declareTool();
  check(`${ON}: the declare tool offers force and says what a twin answers`, tool.args.includes("force") && /twin/.test(tool.description));
  const twin = await s2.call("declare", TWIN);
  const top = Array.isArray(twin.data?.similar) ? twin.data.similar[0] : null;
  check(
    `${ON}: the second session's "${TWIN.title}" came back as ${short(twin.data?.duplicateOf)}, score ${short(top?.score)}`,
    twin.ok && twin.data?.duplicateOf === firstId && twin.data?.intent?.id === firstId && top?.id === firstId && typeof top?.score === "number" && top.score >= 0.8,
  );
  check(`${ON}: its note says what to do (${short(twin.data?.note, 200)})`, typeof twin.data?.note === "string" && twin.data.note.startsWith(`This looks like ${firstId} `) && twin.data.note.includes("force: true"));
  check(`${ON}: no intent "${TWIN.title}" was created`, (await titled(ON, TWIN.title)).length === 0);

  const forced = await s2.call("declare", { ...TWIN, force: true });
  const forcedId = forced.data?.intent?.id;
  check(`${ON}: with force: true it created ${short(forcedId)}`, forced.ok && typeof forcedId === "string" && forcedId !== firstId && forced.data?.duplicateOf === undefined);
  check(`${ON}: the colony has it once`, (await titled(ON, TWIN.title)).length === 1);

  const viaRest = await rest("POST", `/api/colonies/${ON}/intents`, REST_TWIN);
  check(`${ON}: over REST a third wording answers 200 with duplicateOf ${short(viaRest.data?.duplicateOf)}`, viaRest.status === 200 && viaRest.data?.duplicateOf === firstId && viaRest.data?.id === firstId);
  const restForced = await rest("POST", `/api/colonies/${ON}/intents`, { ...REST_TWIN, force: true });
  check(`${ON}: and with force: true 201 (${short(restForced.data?.id)})`, restForced.status === 201 && restForced.data?.duplicateOf === undefined);
  await s1.close();
  await s2.close();
}

/** The colony the flag does not cover: every declare creates an intent, as before. */
async function unflagged(): Promise<void> {
  await create(OFF);
  const s1 = await session(OFF, "twins-first");
  const first = await s1.call("declare", FIRST);
  const firstId = first.data?.intent?.id;
  check(`${OFF}: the first session declared "${FIRST.title}" (${short(firstId)})`, first.ok && typeof firstId === "string");
  const s2 = await session(OFF, "twins-second");
  const second = await s2.call("declare", TWIN);
  check(
    `${OFF}: the second session's "${TWIN.title}" created ${short(second.data?.intent?.id)}`,
    second.ok && typeof second.data?.intent?.id === "string" && second.data.intent.id !== firstId && second.data?.duplicateOf === undefined,
  );
  const viaRest = await rest("POST", `/api/colonies/${OFF}/intents`, REST_TWIN);
  check(`${OFF}: over REST the third wording answers 201 (${viaRest.status})`, viaRest.status === 201 && viaRest.data?.duplicateOf === undefined);
  check(`${OFF}: all three intents exist`, (await titled(OFF, FIRST.title)).length === 1 && (await titled(OFF, TWIN.title)).length === 1 && (await titled(OFF, REST_TWIN.title)).length === 1);
  await s1.close();
  await s2.close();
}

async function main(): Promise<void> {
  const about = await rest("GET", "/api/about", undefined, null);
  check(`GET /api/about lists FT_TWINS (${short(about.data?.flags)})`, about.status === 200 && Array.isArray(about.data?.flags) && about.data.flags.includes("FT_TWINS"));
  await flagged();
  await unflagged();
  console.log(failed ? "SOME CHECKS FAILED" : "ALL CHECKS PASSED");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(`twins check failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
