/**
 * Live check of round 4 on a deployment, as a scripted external agent over MCP plus the admin API. Every change is
 * an inline change (`propose` with `files`): no clone, no push, no workspace token.
 * - an inline change lands, and certification runs on it;
 * - a change that only adds a comment lands on the comment-only proof, with no model call;
 * - a change under a protected path waits for a person, with the glob in its reason;
 * - a change that breaks a test lands (review off for that step), certification goes red, and the result names it as
 *   the suspect (FT_CULPRITS), with the repair intent saying so.
 * The colony must not exist yet. The deployment needs FT_INLINE and FT_CULPRITS on, and FT_TRUNK_TESTS.
 *
 * Usage:
 *   FT_MCP_TOKEN=... FT_ADMIN_TOKEN=... node scripts/mcp_round4.ts --url https://<deployment> --colony <new colony id>
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
  console.error("usage: FT_MCP_TOKEN=... FT_ADMIN_TOKEN=... node scripts/mcp_round4.ts --url <deployment> --colony <new colony id>");
  process.exit(2);
}

let failed = false;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failed = true;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const short = (x: unknown, n = 160): string => String(typeof x === "string" ? x : JSON.stringify(x ?? null)).replace(/\s+/g, " ").slice(0, n);

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

const transport = new StreamableHTTPClientTransport(new URL(`${URL_BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${MCP_TOKEN}` } } });
const client = new Client({ name: "round4-check", version: "0.0.1" });
const call = async (tool: string, args: Record<string, unknown> = {}): Promise<{ ok: boolean; data: any; text: string }> => {
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

async function declare(title: string, why: string, footprint: string[]): Promise<string> {
  const r = await rest("POST", `/colonies/${COLONY}/intents`, { title, why, footprint, priority: 5, createdBy: "round4-check" });
  check(`declared "${title}" (${r.status})`, r.status === 201);
  return r.data?.id ?? "";
}

/** Take the intent and propose the files inline; returns the proposal id. */
async function proposeInline(intentId: string, files: Array<{ path: string; content: string | null }>, summary: string): Promise<string | null> {
  const taken = await call("take", { wait: 30 });
  if (taken.data?.intent?.id !== intentId) {
    check(`took ${intentId} (${short(taken.data?.intent?.id ?? taken.text)})`, false);
    return null;
  }
  const p = await call("propose", { files, summary, notVerified: "Not verified: nothing beyond the files in this change." });
  const id = p.data?.proposal?.id ?? p.data?.id ?? p.data?.proposalId ?? null;
  check(`proposed "${summary}" inline (${id ?? short(p.text)})`, p.ok && !!id);
  return id;
}

/** Take an intent that did not land out of the field, so the next take gets the next intent. */
async function retire(intentId: string, why: string): Promise<void> {
  await rest("POST", `/colonies/${COLONY}/intents/${intentId}/withdraw`, { reason: why, by: "round4-check" });
}

/** Wait for a proposal to settle (landed, returned, rejected or escalated). */
async function settle(pid: string, seconds = 240, stopAtEscalated = true): Promise<any> {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    const { data } = await rest("GET", `/colonies/${COLONY}/proposals/${pid}`);
    const p = data?.proposal ?? data;
    if (["landed", "returned", "rejected"].includes(p?.status) || (stopAtEscalated && p?.status === "escalated")) return p;
    await sleep(3000);
  }
  return null;
}

async function approveIfEscalated(p: any, why: string): Promise<any> {
  if (p?.status !== "escalated") return p;
  const r = await rest("POST", `/colonies/${COLONY}/review/${p.id}`, { decision: "approve", reason: why, by: "round4-check" });
  console.log(`  (waited for a person: ${short(p.reason, 120)}; approved by this script: ${r.status})`);
  return settle(p.id, 240, false);
}

/** The latest certification result for the colony's head, once it is not running. */
async function certification(seconds = 180): Promise<any> {
  const end = Date.now() + seconds * 1000;
  let last: any = null;
  while (Date.now() < end) {
    const { data } = await rest("GET", `/colonies/${COLONY}/certifications`);
    last = Array.isArray(data?.results) ? data.results[0] : null;
    if (last && !data?.running && last.status !== "running") return { latest: last, all: data };
    await sleep(4000);
  }
  return { latest: last, all: null };
}

const SUM = "export function sum(a: number, b: number): number {\n  return a + b;\n}\n";
const SUM_DOC = "/** Adds two numbers. */\nexport function sum(a: number, b: number): number {\n  // Plain addition, no rounding.\n  return a + b;\n}\n";
const SUM_BROKEN = "/** Adds two numbers. */\nexport function sum(a: number, b: number): number {\n  // Plain addition, no rounding.\n  return a + b + 1;\n}\n";
const TEST = 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { sum } from "../src/sum.ts";\n\ntest("sum adds two numbers", () => {\n  assert.equal(sum(2, 3), 5);\n});\n';

// Setup: an empty colony with certification on.
const made = await rest("POST", "/colonies", { name: COLONY });
check(`created colony ${COLONY} (${made.status})`, made.status === 201);
if (made.status !== 201) process.exit(1);
const pol = await rest("POST", `/colonies/${COLONY}/certify/policy`, { enabled: true, repair: true });
check(`certification on (${pol.status})`, pol.status === 200);

await client.connect(transport);
const joined = await call("join", { colony: COLONY, name: "round4-check", model: "scripted" });
check(`joined ${COLONY}`, joined.ok);
const tools = await client.listTools();
const propose = tools.tools.find((t) => t.name === "propose");
check("MCP propose accepts files (FT_INLINE on)", JSON.stringify(propose?.inputSchema ?? {}).includes("files"));

// 1. An inline change lands and certifies green.
const i1 = await declare("Add sum and its test", "src/sum.ts exports sum(a, b) = a + b; test/sum.test.ts checks sum(2, 3) is 5.", ["src/sum.ts", "test/sum.test.ts"]);
const p1 = await proposeInline(i1, [{ path: "src/sum.ts", content: SUM }, { path: "test/sum.test.ts", content: TEST }], "Add sum and its test");
let s1 = p1 ? await settle(p1) : null;
s1 = await approveIfEscalated(s1, "round 4 check: the setup change");
check(`the inline change landed (${s1?.status ?? "no answer"}${s1?.reason ? `: ${short(s1.reason, 100)}` : ""})`, s1?.status === "landed");
await rest("POST", `/colonies/${COLONY}/certify`);
const c1 = await certification();
check(`certification of the inline change: ${c1.latest?.status} ${c1.latest?.counts?.pass ?? "?"}/${c1.latest?.counts?.tests ?? "?"}`, c1.latest?.status === "green");

// 2. A comment-only change lands on its proof, with no model.
const i2 = await declare("Document sum", "Add a doc comment to sum and a note in its body. No behavior change.", ["src/sum.ts"]);
const p2 = p1 ? await proposeInline(i2, [{ path: "src/sum.ts", content: SUM_DOC }], "Document sum") : null;
const s2 = p2 ? await settle(p2) : null;
const decided = JSON.stringify(s2?.decision ?? s2?.decisions ?? s2?.evidence ?? {});
check(`the comment-only change landed (${s2?.status ?? "no answer"})`, s2?.status === "landed");
check(`it landed on the comment-only proof, no model (${short(decided, 200)})`, s2?.status === "landed" && /comment/i.test(decided) && !/llm:/i.test(decided));
if (s2?.status !== "landed") await retire(i2, "round 4 check: the comment-only change did not land");

// 3. A protected path waits for a person, naming the glob.
const pp = await rest("POST", `/colonies/${COLONY}/decide/policy`, { protectedPaths: ["src/secret/**"] });
check(`protected src/secret/** (${pp.status})`, pp.status === 200);
const i3 = await declare("Add the signing key loader", "src/secret/key.ts reads the key from the environment.", ["src/secret/key.ts"]);
const p3 = await proposeInline(i3, [{ path: "src/secret/key.ts", content: "export const keyName = \"SIGNING_KEY\";\n" }], "Add the signing key loader");
const s3 = p3 ? await settle(p3) : null;
check(`the protected change waits for a person, naming the glob (${s3?.status}: ${short(s3?.reason, 140)})`, s3?.status === "escalated" && /src\/secret\/\*\*/.test(String(s3?.reason ?? "")));
if (s3?.status === "escalated") await rest("POST", `/colonies/${COLONY}/review/${s3.id}`, { decision: "reject", reason: "round 4 check: protected path test", by: "round4-check" });
await retire(i3, "round 4 check: protected path test done");

// 4. A breaking change lands with review off; certification names it.
const off = await rest("POST", `/colonies/${COLONY}/decide/policy`, { enabled: false });
check(`review off for the breaking change (${off.status})`, off.status === 200);
const i4 = await declare("Count sum from one", "sum should start counting from one.", ["src/sum.ts"]);
const p4 = await proposeInline(i4, [{ path: "src/sum.ts", content: SUM_BROKEN }], "Count sum from one");
const s4 = p4 ? await settle(p4) : null;
check(`the breaking change landed (${s4?.status ?? "no answer"})`, s4?.status === "landed");
await rest("POST", `/colonies/${COLONY}/decide/policy`, { enabled: true });
await rest("POST", `/colonies/${COLONY}/certify`);
const c4 = await certification();
const suspects: any[] = c4.latest?.suspects ?? [];
check(`certification went red (${c4.latest?.status} ${c4.latest?.counts?.pass ?? "?"}/${c4.latest?.counts?.tests ?? "?"})`, c4.latest?.status === "red");
check(`the result names the breaking proposal as a suspect (${short(suspects.map((x) => x.proposalId), 120)})`, suspects.some((x) => x.proposalId === p4));
await sleep(5000);
const snap = await rest("GET", `/colonies/${COLONY}`);
const repair = (snap.data?.intents ?? []).find((i: any) => /failing tests/i.test(String(i.title ?? "")));
const repairIntent = repair ? (await rest("GET", `/colonies/${COLONY}/intents/${repair.id}`)).data?.intent : null;
check(`the repair intent names the suspect (${short(repairIntent?.why, 200)})`, !!repairIntent && String(repairIntent.why ?? "").includes(p4 ?? "--"));

await client.close();
console.log(failed ? "SOME CHECKS FAILED" : "ALL CHECKS PASSED");
process.exit(failed ? 1 : 0);
