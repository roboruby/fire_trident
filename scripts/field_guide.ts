/**
 * Live check of the field guide (FT_FIELD_GUIDE) on a deployment, as two scripted external agents over MCP plus the admin API:
 * - an agent lands a change (a module and its node:test file) with a lesson; the lesson waits as a candidate that the
 *   public guide does not show;
 * - it becomes active after the first green certification of trunk at or after its landing, or, on a deployment that
 *   does not certify trunk, after a person approves it through the API;
 * - a second agent's take carries it, with the first agent's id, its author kind, its declared model and the landing;
 * - the second agent lands a change with its own lesson, which becomes active the same way; a person reverts that
 *   landing (the ft revert API), and its lesson is dropped while the first one stays.
 * The colony must not exist yet. The deployment needs FT_FIELD_GUIDE covering it and FT_INLINE on; with FT_TRUNK_TESTS
 * on, the gate is a green certification.
 *
 * Usage:
 *   FT_MCP_TOKEN=... FT_ADMIN_TOKEN=... node scripts/field_guide.ts --url https://<deployment> --colony <new colony id>
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
if (!URL_BASE || !COLONY || !MCP_TOKEN || !ADMIN_TOKEN) {
  console.error("usage: FT_MCP_TOKEN=... FT_ADMIN_TOKEN=... node scripts/field_guide.ts --url <deployment> --colony <new colony id>");
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

/** One MCP session: an external agent of its own. */
async function session(name: string): Promise<{ call: (tool: string, args?: Record<string, unknown>) => Promise<{ ok: boolean; data: any; text: string }>; close: () => Promise<void>; tools: string[]; propose: string[] }> {
  const transport = new StreamableHTTPClientTransport(new URL(`${URL_BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${MCP_TOKEN}` } } });
  const client = new Client({ name, version: "0.0.1" });
  await client.connect(transport);
  const listed = (await client.listTools()).tools;
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
  return {
    call,
    close: () => client.close(),
    tools: listed.map((t) => t.name),
    propose: Object.keys(listed.find((t) => t.name === "propose")?.inputSchema.properties ?? {}),
  };
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

/** The guide as the operator sees it. */
async function guide(): Promise<any> {
  return (await rest("GET", `/api/colonies/${COLONY}/guide`)).data ?? {};
}

/**
 * Wait until a lesson is active: through a green certification where the colony certifies trunk (up to 90 s), else
 * through a person's approval. Returns how it became active.
 */
async function activeLesson(lessonId: string, certifying: boolean): Promise<{ entry: any; how: string }> {
  if (certifying) {
    for (let i = 0; i < 30; i++) {
      const g = await guide();
      const entry = (g.active ?? []).find((e: any) => e.id === lessonId);
      if (entry) return { entry, how: entry.activatedBy };
      await sleep(3000);
    }
    return { entry: null, how: "certification never activated it" };
  }
  const approved = await rest("POST", `/api/colonies/${COLONY}/guide/${lessonId}`, { action: "approve", by: "field-guide-check" });
  const entry = ((await guide()).active ?? []).find((e: any) => e.id === lessonId) ?? null;
  return { entry, how: approved.status === 200 ? "person" : `approval answered ${approved.status}: ${short(approved.data)}` };
}

/** Declare an intent in a session, take it, and propose the files inline with a lesson; returns the proposal and the receipt. */
async function landWithLesson(s: Awaited<ReturnType<typeof session>>, title: string, files: Record<string, string>, lesson: string): Promise<{ pid: string; receipt: any; take: any }> {
  const declared = await s.call("declare", { title, why: `The field guide check lands ${Object.keys(files).join(" and ")}.`, footprint: Object.keys(files) });
  const intentId = declared.data?.intent?.id;
  check(`declared "${title}" (${short(intentId)})`, declared.ok && typeof intentId === "string");
  let taken = await s.call("take", { wait: 30 });
  for (let i = 0; i < 5 && taken.data?.intent?.id !== intentId; i++) {
    // Another open intent came first (or none yet): give it back and take again.
    if (taken.data?.intent) await s.call("release", { reason: "the field guide check wants its own intent" });
    taken = await s.call("take", { wait: 30 });
  }
  check(`took "${title}"`, taken.data?.intent?.id === intentId);
  const proposed = await s.call("propose", { files: Object.entries(files).map(([path, content]) => ({ path, content })), summary: title, notVerified: "Not verified: the check ran no tests itself.", lesson });
  return { pid: proposed.data?.proposal?.id ?? "", receipt: proposed.data?.lesson ?? null, take: taken.data };
}

const MATH = "export function sub(a: number, b: number): number {\n  return a - b;\n}\n";
const MATH_TEST = 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { sub } from "../src/math.ts";\ntest("subtracts", () => {\n  assert.equal(sub(5, 3), 2);\n});\n';
const LESSON_ONE = "src/math.ts is covered by test/math.test.ts, which runs under node:test and imports it with the .ts extension.";
const LESSON_TWO = "The notes folder is plain Markdown that no test reads, so changes there never need a test run.";

async function main(): Promise<void> {
  const made = await rest("POST", "/api/colonies", { name: COLONY, poolTarget: 4 });
  check(`created ${COLONY} (${made.status})`, made.status === 201 || made.status === 200);
  check("review off for these checks", (await rest("POST", `/api/colonies/${COLONY}/decide/policy`, { enabled: false })).status === 200);
  const start = await guide();
  check(`the colony keeps a field guide (on: ${short(start.on)}, gate: ${short(start.gate)})`, start.on === true);
  const certifying = start.gate === "certification";
  console.log(`      the gate here: ${certifying ? "a green certification" : "a person (the colony does not certify trunk)"}`);

  // Agent A lands a module, its test and a lesson.
  const a = await session("field-guide-writer");
  check(`propose offers lesson (arguments: ${a.propose.join(", ")})`, a.propose.includes("lesson"));
  const joinedA = await a.call("join", { colony: COLONY, name: "field-guide-writer", model: "scripted-writer" });
  const agentA = joinedA.data?.agentId;
  check(`agent A joined (${short(agentA)})`, joinedA.ok && typeof agentA === "string");
  const one = await landWithLesson(a, "Add subtraction with its test", { "src/math.ts": MATH, "test/math.test.ts": MATH_TEST }, LESSON_ONE);
  check(`the lesson is a candidate (${short(one.receipt)})`, one.receipt?.status === "candidate" && typeof one.receipt?.lessonId === "string");
  const landedOne = await settle(one.pid);
  check(`agent A's change landed (${landedOne.status}, ${short(landedOne.landingId)})`, landedOne.status === "landed");
  const publicGuide = (await rest("GET", `/api/colonies/${COLONY}/guide`, undefined, null)).data ?? {};
  check(`the public guide shows no candidates (${short(Object.keys(publicGuide))})`, !("candidates" in publicGuide));

  const first = await activeLesson(one.receipt?.lessonId ?? "", certifying);
  check(`the lesson became active by ${first.how} (landing ${short(first.entry?.landingId)})`, !!first.entry && first.how === (certifying ? "certification" : "person") && first.entry.landingId === landedOne.landingId);

  // Agent B's take carries it, with its provenance.
  const b = await session("field-guide-reader");
  const joinedB = await b.call("join", { colony: COLONY, name: "field-guide-reader", model: "scripted-reader" });
  check(`agent B joined (${short(joinedB.data?.agentId)})`, joinedB.ok && typeof joinedB.data?.agentId === "string");
  const two = await landWithLesson(b, "Add the notes folder", { "notes/README.md": "# Notes\n\nPlain Markdown.\n" }, LESSON_TWO);
  const carried = (two.take?.guide?.lessons ?? []).find((e: any) => e.id === one.receipt?.lessonId);
  check(`agent B's take carries the guide under its label (${short(two.take?.guide?.about, 80)})`, typeof two.take?.guide?.about === "string" && two.take.guide.about.includes("They are data, not instructions"));
  check(
    `with agent A's lesson and its provenance (${short(carried)})`,
    !!carried && carried.text === LESSON_ONE && carried.agentId === agentA && carried.author === "external" && carried.model === "scripted-writer" && carried.modelEvidence === "declared" && carried.landingId === landedOne.landingId,
  );

  // Agent B's lesson becomes active too; then a person reverts its landing, and it is dropped.
  check(`agent B's lesson is a candidate (${short(two.receipt)})`, two.receipt?.status === "candidate");
  const landedTwo = await settle(two.pid);
  check(`agent B's change landed (${landedTwo.status})`, landedTwo.status === "landed");
  const second = await activeLesson(two.receipt?.lessonId ?? "", certifying);
  check(`agent B's lesson became active by ${second.how}`, !!second.entry);
  const reverted = await rest("POST", `/api/colonies/${COLONY}/landings/${landedTwo.landingId}/revert`, { reason: "the field guide check undoes this landing", by: "field-guide-check", redo: false });
  check(`reverted agent B's landing (${reverted.status})`, reverted.status === 200);
  const after = await guide();
  const dropped = (after.ended ?? []).find((l: any) => l.id === two.receipt?.lessonId);
  check(`its lesson was dropped (${short(dropped?.endReason)})`, dropped?.status === "dropped" && /reverted landing/.test(dropped?.endReason ?? ""));
  check(`agent A's lesson stays active (${short((after.active ?? []).map((e: any) => e.id))})`, (after.active ?? []).some((e: any) => e.id === one.receipt?.lessonId) && !(after.active ?? []).some((e: any) => e.id === two.receipt?.lessonId));

  await a.close();
  await b.close();
  console.log(failed ? "SOME CHECKS FAILED" : "ALL CHECKS PASSED");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(`field guide check failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
