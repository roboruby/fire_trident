/**
 * Live check of the goal-conflict check (FT_GOAL_CONFLICT) on a deployment, with scripted external agents over MCP plus
 * the admin API. One file, src/backend.ts, declares the backend's language and the lines that depend on it; three
 * intents each move it to a different language with a different why; one agent each, landing in turn.
 * - In the colony the flag covers (--colony): the first change lands; the second and third wait for a person, each
 *   naming the landing it would undo; a person's approval lands the second, its lineage note keeping what it undid and
 *   the decision; returning the third works as before.
 * - In a colony the flag does not cover (--off): all three land, and the last one wins.
 * Both colonies must not exist yet. The deployment needs FT_INLINE on, and FT_GOAL_CONFLICT naming the first colony
 * and not the second (a preview: npx wrangler preview --name <x> --var FT_GOAL_CONFLICT:<colony>). The check runs in
 * the decide stage, so the flagged colony's review is on once the file is seeded, and its first change goes through
 * model review too: this script approves a model's escalation of it as a person would, and proposes again after a return.
 *
 * Usage:
 *   FT_MCP_TOKEN=... FT_ADMIN_TOKEN=... node scripts/goal_conflict.ts --url https://<deployment> --colony <flag-on colony> --off <flag-off colony>
 */
import { createHash } from "node:crypto";
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
  console.error("usage: FT_MCP_TOKEN=... FT_ADMIN_TOKEN=... node scripts/goal_conflict.ts --url <deployment> --colony <flag-on colony> --off <flag-off colony>");
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

const FILE = "src/backend.ts";
type Lang = "python" | "rust" | "go" | "typescript";
const LANGS: Record<Lang, { runtime: string; build: string; start: string }> = {
  python: { runtime: "Python 3.12", build: "pip install -r requirements.txt", start: "python -m orders" },
  rust: { runtime: "Rust 1.80, one static binary", build: "cargo build --release", start: "./target/release/orders" },
  go: { runtime: "Go 1.23", build: "go build ./cmd/orders", start: "./orders" },
  typescript: { runtime: "TypeScript, run with its types stripped", build: "npm ci", start: "node src/server.ts" },
};
/** The three goals: each moves the backend to another language, for a different reason. */
const GOALS: Array<{ lang: Lang; title: string; why: string }> = [
  { lang: "rust", title: "Move the order backend to Rust", why: "Ship the order backend as one static binary with no runtime to install, and keep its latency predictable under load." },
  { lang: "go", title: "Move the order backend to Go", why: "The team that will own the order backend writes Go, and it should build with one command on any machine." },
  { lang: "typescript", title: "Move the order backend to TypeScript", why: "Share the order types with the web client and run the backend on the same runtime as everything else." },
];

/** src/backend.ts for one language: five lines name the language and depend on it; the rest is the same in every version. */
function backend(lang: Lang): string {
  const l = LANGS[lang];
  return [
    "// The order service backend: the language it is written in, and how it is built, started and checked.",
    "",
    `export const backendLanguage = "${lang}";`,
    `export const backendRuntime = "${l.runtime}";`,
    `export const buildCommand = "${l.build}";`,
    `export const startCommand = "${l.start}";`,
    `export const healthReport = "orders backend (${lang}) is up";`,
    "",
    "export interface Route {",
    '  method: "GET" | "POST";',
    "  path: string;",
    "  handler: string;",
    "}",
    "",
    "export const routes: Route[] = [",
    '  { method: "GET", path: "/orders", handler: "listOrders" },',
    '  { method: "POST", path: "/orders", handler: "createOrder" },',
    '  { method: "GET", path: "/orders/:id", handler: "getOrder" },',
    '  { method: "GET", path: "/health", handler: "health" },',
    "];",
    "",
    "/** One line about the backend, for the status page. */",
    "export function describeBackend(): string {",
    "  return `${backendLanguage} backend (${backendRuntime}) with ${routes.length} routes`;",
    "}",
    "",
  ].join("\n");
}

/** The git blob id of a text, as trunk names the file's version. */
function gitBlob(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

type Call = (tool: string, args?: Record<string, unknown>) => Promise<{ ok: boolean; data: any; text: string }>;
type Agent = { name: string; agentId: string; call: Call };
const clients: Client[] = [];

/** A scripted agent: its own MCP session, joined to `colony`. */
async function agent(name: string, colony: string): Promise<Agent> {
  const transport = new StreamableHTTPClientTransport(new URL(`${URL_BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${MCP_TOKEN}` } } });
  const client = new Client({ name, version: "0.0.1" });
  await client.connect(transport);
  clients.push(client);
  const call: Call = async (tool, args = {}) => {
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
  const joined = await call("join", { colony, name, model: "scripted" });
  if (!joined.ok || typeof joined.data?.agentId !== "string") throw new Error(`${name} could not join ${colony}: ${short(joined.text)}`);
  return { name, agentId: joined.data.agentId, call };
}

async function declare(colony: string, title: string, why: string): Promise<string> {
  const r = await rest("POST", `/colonies/${colony}/intents`, { title, why, footprint: [FILE], priority: 5, createdBy: "goal-conflict-check" });
  check(`${colony}: declared "${title}" (${r.status})`, r.status === 201 && typeof r.data?.id === "string");
  return r.data?.id ?? "";
}

/** One turn of an agent: take an intent (waiting for one), read the file, propose the backend its intent asks for. */
async function work(a: Agent, langs: Map<string, Lang>): Promise<{ pid: string; intentId: string; lang: Lang; context: any } | null> {
  for (let i = 0; i < 4; i++) {
    const taken = await a.call("take", { wait: 30 });
    const intent = taken.data?.intent;
    const lang = intent?.id ? langs.get(intent.id) : undefined;
    if (!intent?.id || !lang) {
      console.log(`  (${a.name}: no intent yet: ${short(taken.data?.reason ?? taken.text, 120)})`);
      continue;
    }
    await a.call("read", { path: FILE });
    const proposed = await a.call("propose", { files: [{ path: FILE, content: backend(lang) }], summary: intent.title, notVerified: "Not verified: nothing was run; only src/backend.ts changes." });
    const pid = proposed.data?.proposal?.id;
    if (!proposed.ok || typeof pid !== "string") {
      console.log(`  (${a.name}: propose failed: ${short(proposed.text, 200)})`);
      return null;
    }
    return { pid, intentId: intent.id, lang, context: taken.data?.context ?? null };
  }
  return null;
}

/** Wait for a proposal to settle: landed, returned or rejected, or escalated unless `pastEscalated`. */
async function settle(colony: string, pid: string, pastEscalated = false, seconds = 240): Promise<any> {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    const { data } = await rest("GET", `/colonies/${colony}/proposals/${pid}`);
    if (["landed", "returned", "rejected"].includes(data?.status) || (!pastEscalated && data?.status === "escalated")) return data;
    await sleep(2500);
  }
  return null;
}

/** The newest landing that changed the file, with its lineage note. */
async function newest(colony: string): Promise<{ landing: any; note: any } | null> {
  const r = await rest("GET", `/colonies/${colony}/why?path=${encodeURIComponent(FILE)}`);
  return Array.isArray(r.data) && r.data.length > 0 ? r.data[0] : null;
}

/** The blob of the file a landing's note says it wrote. */
function writtenBlob(entry: { note: any } | null): string | null {
  for (const p of entry?.note?.proposals ?? []) for (const w of p.writeSet ?? []) if (w.path === FILE) return w.blob ?? null;
  return null;
}

/** A colony with src/backend.ts seeded in Python (review off for the seed), the three goals declared, and their languages by intent id. */
async function setup(colony: string): Promise<Map<string, Lang>> {
  const made = await rest("POST", "/colonies", { name: colony, poolTarget: 4 });
  check(`${colony}: created (${made.status})`, made.status === 201);
  if (made.status !== 201) throw new Error(`${colony} could not be created: ${short(made.data)}`);
  check(`${colony}: review off for the seed`, (await rest("POST", `/colonies/${colony}/decide/policy`, { enabled: false })).status === 200);
  const seedIntent = await declare(colony, "Start the order backend", "A small order backend, in Python to begin with.");
  const seeder = await agent("goal-check-seed", colony);
  const seeded = await work(seeder, new Map([[seedIntent, "python" as Lang]]));
  const s = seeded ? await settle(colony, seeded.pid) : null;
  check(`${colony}: ${FILE} seeded in Python (${s?.status ?? "no answer"})`, s?.status === "landed");
  const langs = new Map<string, Lang>();
  for (const g of GOALS) langs.set(await declare(colony, g.title, g.why), g.lang);
  return langs;
}

/** In the colony the flag covers: the first lands, the second and third wait for a person naming it, approval and return as before. */
async function flagOn(): Promise<void> {
  console.log(`\nFlag on: ${ON}`);
  const langs = await setup(ON);
  check(`${ON}: review on, so the decide stage runs the check`, (await rest("POST", `/colonies/${ON}/decide/policy`, { enabled: true })).status === 200);

  // The first change: nothing recent of another intent to undo (the seed's 21 lines, 5 of them rewritten, is under half).
  const first = await agent("goal-check-first", ON);
  let one: { pid: string; intentId: string; lang: Lang } | null = null;
  let landing = "";
  for (let attempt = 1; attempt <= 3 && !landing; attempt++) {
    const w = await work(first, langs);
    if (!w) break;
    let p = await settle(ON, w.pid);
    if (p?.status === "escalated" && !/would undo/.test(String(p.reason ?? ""))) {
      console.log(`  (a model sent the first change to a person: ${short(p.reason, 140)}; approved by this script)`);
      await rest("POST", `/colonies/${ON}/review/${w.pid}`, { decision: "approve", reason: "goal-conflict check: the setup change", by: "goal-conflict-check" });
      p = await settle(ON, w.pid, true);
    }
    const gc = (p?.evidence?.checks ?? []).find((c: { name?: string }) => c.name === "goal conflict");
    if (p?.status === "landed") {
      one = w;
      landing = p.landingId ?? "";
      check(`the first change (${w.lang}) landed, not held for a goal conflict: ${landing}`, landing !== "" && !/would undo/.test(String(p.reason ?? "")));
      check(`the check ran on it and found nothing to undo (${short(gc?.detail, 120)})`, gc?.ok === true);
    } else {
      check(`the first change was not held for a goal conflict (${p?.status}: ${short(p?.reason, 140)})`, !/would undo/.test(String(p?.reason ?? "")));
      console.log(`  (attempt ${attempt}: ${p?.status ?? "no answer"}; proposing again)`);
    }
  }
  if (!one || !landing) {
    check("the first change landed (needed for the rest)", false);
    return;
  }

  // The second and third: each would undo the first's five lines, so each waits for a person, naming that landing.
  const waiting: Array<{ pid: string; lang: Lang; agent: Agent }> = [];
  for (const name of ["goal-check-second", "goal-check-third"]) {
    const a = await agent(name, ON);
    const w = await work(a, langs);
    if (!w) {
      check(`${name} proposed a change`, false);
      continue;
    }
    const sawWhy = (w.context?.landings ?? []).some((l: { landingId?: string }) => l.landingId === landing);
    check(`${name}'s take carried landing ${landing} and its intent's why in its context`, sawWhy);
    const p = await settle(ON, w.pid);
    const reason = String(p?.reason ?? "");
    check(`the ${w.lang} change waits for a person (${p?.status}): ${short(reason, 260)}`, p?.status === "escalated" && reason.includes("would undo") && reason.includes(landing) && reason.includes("a person decides which goal stands"));
    check(`  its record names the landing it would undo (${short(p?.undoes)})`, Array.isArray(p?.undoes) && p.undoes.some((u: { landingId?: string; intentId?: string }) => u.landingId === landing && u.intentId === one!.intentId));
    waiting.push({ pid: w.pid, lang: w.lang, agent: a });
    // Its claim would hold the file for minutes: stop the agent, as a person would once its change waits.
    await rest("POST", `/colonies/${ON}/agents/${a.agentId}/stop`, { reason: "goal-conflict check: the change waits for a person" });
  }
  const queue = await rest("GET", `/colonies/${ON}/review`);
  const queued = new Set((Array.isArray(queue.data) ? queue.data : []).map((x: { id?: string }) => x.id));
  check(`both wait in the review queue (${waiting.filter((w) => queued.has(w.pid)).length} of ${waiting.length})`, waiting.length === 2 && waiting.every((w) => queued.has(w.pid)));
  const before = await newest(ON);
  check(`trunk still holds the first change: ${FILE} is the ${one.lang} version (landing ${before?.landing?.id})`, before?.landing?.id === landing && writtenBlob(before) === gitBlob(backend(one.lang)));

  // A person decides: the second's goal stands. It lands, and its note keeps what it undid and the decision.
  const second = waiting[0];
  if (second) {
    const ok = await rest("POST", `/colonies/${ON}/review/${second.pid}`, { decision: "approve", reason: `the ${second.lang} goal stands`, by: "goal-conflict-check" });
    const p = await settle(ON, second.pid, true);
    check(`approved by a person, the ${second.lang} change lands (${ok.status}, ${p?.status})`, p?.status === "landed");
    const top = await newest(ON);
    const entry = (top?.note?.proposals ?? []).find((x: { id?: string }) => x.id === second.pid);
    const undoes = entry?.undoes ?? [];
    check(`its lineage note records what it undid (${short(undoes)})`, undoes.some((u: { landingId?: string; intentId?: string; path?: string; lines?: number }) => u.landingId === landing && u.intentId === one!.intentId && u.path === FILE && (u.lines ?? 0) >= 3));
    const human = (entry?.decisions ?? []).find((d: { layer?: string }) => d.layer === "human");
    const gc = (entry?.evidence?.checks ?? []).find((c: { name?: string }) => c.name === "goal conflict");
    check(`  and the decision with its reason (${short(human?.answer, 80)}; ${short(gc?.detail, 120)})`, human?.action === "approve" && /would undo/.test(String(gc?.detail ?? "")));
    check(`trunk now holds the ${second.lang} version`, writtenBlob(top) === gitBlob(backend(second.lang)));
  }
  // The third goes back to its agent, as a return always has.
  const third = waiting[1];
  if (third) {
    const r = await rest("POST", `/colonies/${ON}/review/${third.pid}`, { decision: "return", reason: "the other goal stands; escalate with contradictory-spec if this intent still wants its language", by: "goal-conflict-check" });
    const p = await settle(ON, third.pid, true);
    check(`returning the ${third.lang} change works as before (${r.status}, ${p?.status})`, p?.status === "returned");
  }
}

/** In a colony the flag does not cover: all three land, one after another, and the last one wins. */
async function flagOff(): Promise<void> {
  console.log(`\nFlag off: ${OFF}`);
  const langs = await setup(OFF);
  let last: Lang | null = null;
  let landed = 0;
  for (const name of ["goal-check-first", "goal-check-second", "goal-check-third"]) {
    const a = await agent(name, OFF);
    const w = await work(a, langs);
    const p = w ? await settle(OFF, w.pid) : null;
    const gc = (p?.evidence?.checks ?? []).find((c: { name?: string }) => c.name === "goal conflict");
    check(`the ${w?.lang ?? "?"} change lands with no goal-conflict check (${p?.status ?? "no answer"})`, p?.status === "landed" && !gc);
    if (p?.status === "landed" && w) {
      landed++;
      last = w.lang;
    }
  }
  const top = await newest(OFF);
  check(`all three landed, and the last one wins: ${FILE} is the ${last ?? "?"} version`, landed === 3 && last !== null && writtenBlob(top) === gitBlob(backend(last)));
}

try {
  await flagOn();
  await flagOff();
} catch (e) {
  check(`the check ran to the end (${e instanceof Error ? e.message : String(e)})`, false);
} finally {
  for (const c of clients) await c.close().catch(() => undefined);
}
console.log(failed ? "SOME CHECKS FAILED" : "ALL CHECKS PASSED");
process.exit(failed ? 1 : 0);
