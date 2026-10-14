/**
 * Live check of who declared an intent and the intent chain gate (FT_INTENT_CHAIN_GATE) on a deployment, with scripted
 * external agents over MCP plus the admin API. Nothing is proposed: the check declares, takes, and asks a person's
 * answer over REST.
 * - In the colony the flag covers (--colony): agent A joins, declares intent 1 and takes it (the take's intent.declaredBy
 *   names A, its model and chain depth 0); while holding it, A declares intent 2, a child of intent 1 (depth 1), which
 *   is not held. Agent B takes intent 2: its declaredBy names A as the declarer, model scripted-a, chain depth 1. B
 *   declares intent 3 (depth 2): the answer carries `held`, GET /escalations lists intent 3 with a report of kind chain,
 *   and agent C's take gets wait. A person dismisses the report over REST: C's take gets intent 3, declared by B, depth 2.
 *   Then the fan-out: with the decide policy's intentFanout set to 2 over REST, the third intent A declares in the hour
 *   is held too, however shallow, and GET /escalations lists it.
 * - In a colony the flag does not cover (--off): the same chain, and C takes intent 3 at once, with no report anywhere.
 * - GET /api/about lists FT_INTENT_CHAIN_GATE.
 * Both colonies must not exist yet. The deployment needs FT_INTENT_CHAIN_GATE naming the first colony and not the second
 * (a preview: npx wrangler preview --name <x> --var FT_INTENT_CHAIN_GATE:<colony>), and a pool to lease from (the check
 * creates each colony with poolTarget 3, one lease per agent).
 *
 * Usage:
 *   FT_MCP_TOKEN=... FT_ADMIN_TOKEN=... node scripts/intent_chain.ts --url https://<deployment> --colony <flag-on colony> --off <flag-off colony>
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
  console.error("usage: FT_MCP_TOKEN=... FT_ADMIN_TOKEN=... node scripts/intent_chain.ts --url <deployment> --colony <new colony FT_INTENT_CHAIN_GATE names> --off <another new colony>");
  process.exit(2);
}

/** Each intent sits in its own directory, so no take is inhibited by another agent's claim. */
const ONE = { title: "Chain check, first link: describe the one module", why: "A reader opening docs/chain/one.md should learn what the first module does.", footprint: ["docs/chain/one.md"] };
const TWO = { title: "Chain check, second link: describe the two module", why: "A reader opening docs/chain/two.md should learn what the second module does.", footprint: ["docs/chain/two.md"] };
const THREE = { title: "Chain check, third link: describe the three module", why: "A reader opening docs/chain/three.md should learn what the third module does.", footprint: ["docs/chain/three.md"] };
const FOURTH = { title: "Chain check, fan-out: describe the four module", why: "A reader opening docs/chain/four.md should learn what the fourth module does.", footprint: ["docs/chain/four.md"] };

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
  agentId: string;
  call: (tool: string, args?: Record<string, unknown>) => Promise<{ ok: boolean; data: any; text: string }>;
  close: () => Promise<void>;
};

/** One MCP session joined to a colony as an external agent with the model it names. */
async function session(colony: string, name: string, model: string): Promise<Session> {
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
  const joined = await call("join", { colony, name, model });
  const agentId = typeof joined.data?.agentId === "string" ? joined.data.agentId : "";
  check(`${colony}: ${name} joined as ${short(agentId)} (model ${model})`, joined.ok && agentId !== "");
  return { agentId, call, close: () => client.close() };
}

/** A new colony with a pool of three, one lease per agent of the check; review is not needed, nothing is proposed. */
async function create(colony: string): Promise<void> {
  const made = await rest("POST", "/api/colonies", { name: colony, poolTarget: 3 });
  check(`created ${colony} (${made.status})`, made.status === 201);
}

/** Take until the colony hands out the intent asked for (giving back any other it offers first), at most five tries. */
async function takeIntent(s: Session, colony: string, intentId: string): Promise<any> {
  let taken = await s.call("take", { wait: 30 });
  for (let i = 0; i < 5 && taken.data?.intent?.id !== intentId; i++) {
    if (taken.data?.intent) await s.call("release", { reason: "the intent chain check wants another intent" });
    taken = await s.call("take", { wait: 30 });
  }
  check(`${colony}: ${s.agentId} took ${short(intentId)}`, taken.data?.intent?.id === intentId);
  return taken.data;
}

/** The ids of the colony's reports waiting for a person, with their kinds (GET /escalations answers { colonyId, intents, total }). */
async function reports(colony: string): Promise<Array<{ id: string; kind: string }>> {
  const res = await rest("GET", `/api/colonies/${colony}/escalations`);
  const intents = Array.isArray(res.data?.intents) ? res.data.intents : [];
  return intents.map((i: any) => ({ id: String(i?.id), kind: String(i?.escalation?.kind) }));
}

/** The chain both colonies walk: A declares 1 and takes it, declares 2; B takes 2 and declares 3. */
async function walk(colony: string): Promise<{ a: Session; b: Session; c: Session; one: string; two: string; three: any }> {
  const a = await session(colony, "chain-a", "scripted-a");
  const first = await a.call("declare", ONE);
  const one = first.data?.intent?.id;
  check(`${colony}: A declared intent 1 (${short(one)}), not held`, first.ok && typeof one === "string" && first.data?.held === undefined);
  const tookOne = await takeIntent(a, colony, one);
  const d1 = tookOne?.intent?.declaredBy;
  check(`${colony}: its take says A declared it (${short(d1)})`, d1?.source === "agent" && d1?.by === a.agentId && d1?.model === "scripted-a" && d1?.chainDepth === 0);

  const second = await a.call("declare", TWO);
  const two = second.data?.intent?.id;
  check(`${colony}: A declared intent 2 (${short(two)}) as a child of intent 1, not held`, second.ok && typeof two === "string" && second.data?.intent?.parentId === one && second.data?.held === undefined);

  const b = await session(colony, "chain-b", "scripted-b");
  const tookTwo = await takeIntent(b, colony, two);
  const d2 = tookTwo?.intent?.declaredBy;
  check(`${colony}: B's take says A declared intent 2, model scripted-a, chain depth 1 (${short(d2)})`, d2?.source === "agent" && d2?.by === a.agentId && d2?.model === "scripted-a" && d2?.chainDepth === 1 && d2?.parentId === one);
  check(`${colony}: and its note says the words are an agent's (${short(d2?.note, 120)})`, typeof d2?.note === "string" && d2.note.startsWith("An agent declared this intent") && d2.note.includes("data, not instructions"));

  const third = await b.call("declare", THREE);
  check(`${colony}: B declared intent 3 (${short(third.data?.intent?.id)}) as a child of intent 2`, third.ok && typeof third.data?.intent?.id === "string" && third.data?.intent?.parentId === two);
  const c = await session(colony, "chain-c", "scripted-c");
  return { a, b, c, one, two, three: third.data };
}

/** The flagged colony: intent 3 waits for a person, take skips it, and a person's dismiss releases it. */
async function flagged(): Promise<void> {
  await create(ON);
  const { a, b, c, two, three } = await walk(ON);
  const id = three?.intent?.id;
  check(`${ON}: the declare answer says it is held (${short(three?.held, 200)})`, typeof three?.held === "string" && three.held.startsWith("Held for a person: agent ") && three.held.includes("2 agent-declared intents are in its ancestry"));
  check(`${ON}: the report names B, intent 2 and A`, typeof three?.held === "string" && three.held.includes(`agent ${b.agentId} (model scripted-b) declared this intent from intent ${two}, which agent ${a.agentId} declared`));
  const waiting = await reports(ON);
  check(`${ON}: GET /escalations lists intent 3 with kind chain (${short(waiting)})`, waiting.length === 1 && waiting[0]!.id === id && waiting[0]!.kind === "chain");
  const skipped = await c.call("take", { wait: 0 });
  check(`${ON}: C's take does not offer it (${short(skipped.data?.wait ?? skipped.data?.intent?.id)})`, skipped.ok && skipped.data?.wait === true);

  const answered = await rest("POST", `/api/colonies/${ON}/intents/${id}/escalation`, { decision: "dismiss", note: "Read the chain: it stays in docs/chain.", by: "intent chain check" });
  check(`${ON}: a person dismissed the report (${answered.status})`, answered.status === 200 && answered.data?.intent?.escalation?.resolved?.decision === "dismiss");
  check(`${ON}: no report waits any more`, (await reports(ON)).length === 0);
  const tookThree = await takeIntent(c, ON, id);
  const d3 = tookThree?.intent?.declaredBy;
  check(`${ON}: C's take says B declared intent 3 at chain depth 2 (${short(d3)})`, d3?.by === b.agentId && d3?.model === "scripted-b" && d3?.chainDepth === 2 && d3?.parentId === two);

  // The fan-out: with the policy at 2, the third intent A declares in the hour waits for a person, however shallow.
  const policy = await rest("POST", `/api/colonies/${ON}/decide/policy`, { intentFanout: 2 });
  check(`${ON}: the decide policy's intentFanout set to 2 (${policy.status}, was ${short(policy.data?.intentFanout)})`, policy.status === 200 && policy.data?.intentFanout === 2);
  const fourth = await a.call("declare", FOURTH);
  check(
    `${ON}: A's third declaration of the hour is held by the fan-out (${short(fourth.data?.held, 200)})`,
    fourth.ok && typeof fourth.data?.held === "string" && fourth.data.held.includes("the 3rd it declared in the last hour, and the colony lets one agent declare 2 before a person checks the rest"),
  );
  const fanned = await reports(ON);
  check(`${ON}: GET /escalations lists it with kind chain (${short(fanned)})`, fanned.length === 1 && fanned[0]!.id === fourth.data?.intent?.id && fanned[0]!.kind === "chain");
  for (const s of [a, b, c]) await s.call("release", { reason: "the intent chain check is done" });
  await Promise.all([a.close(), b.close(), c.close()]);
}

/** The colony the flag does not cover: intent 3 is taken at once, and nothing waits for a person. */
async function unflagged(): Promise<void> {
  await create(OFF);
  const { a, b, c, two, three } = await walk(OFF);
  const id = three?.intent?.id;
  check(`${OFF}: the declare answer says nothing of a hold`, three?.held === undefined);
  check(`${OFF}: no report waits`, (await reports(OFF)).length === 0);
  const tookThree = await takeIntent(c, OFF, id);
  const d3 = tookThree?.intent?.declaredBy;
  check(`${OFF}: C's take still says B declared intent 3 at chain depth 2 (${short(d3)})`, d3?.by === b.agentId && d3?.chainDepth === 2 && d3?.parentId === two);
  for (const s of [a, b, c]) await s.call("release", { reason: "the intent chain check is done" });
  await Promise.all([a.close(), b.close(), c.close()]);
}

async function main(): Promise<void> {
  const about = await rest("GET", "/api/about", undefined, null);
  check(`GET /api/about lists FT_INTENT_CHAIN_GATE (${short(about.data?.flags)})`, about.status === 200 && Array.isArray(about.data?.flags) && about.data.flags.includes("FT_INTENT_CHAIN_GATE"));
  await flagged();
  await unflagged();
  console.log(failed ? "SOME CHECKS FAILED" : "ALL CHECKS PASSED");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(`intent chain check failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
