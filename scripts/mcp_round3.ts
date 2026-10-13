/**
 * Live check of round 3 on a deployment, as a scripted external agent over MCP plus the admin API:
 * - the MCP token is accepted only as a Bearer header (a `token` query parameter or a wrong token gets 401);
 * - an external agent can be resumed from another MCP session only with the resume key join gave it;
 * - with FT_DELETION_GUARD on for the colony, a change that deletes a file another trunk file imports
 *   goes back naming the importer, and the next take carries why (`lastReturn`);
 * - deleting the file together with the importer's rewrite lands;
 * - MCP `why` trims each note to the proposals that wrote the path.
 * The colony must not exist yet: the script creates it empty and declares its own intents.
 *
 * Usage:
 *   FT_MCP_TOKEN=... FT_ADMIN_TOKEN=... node scripts/mcp_round3.ts --url https://<deployment> --colony <new colony id>
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  console.error("usage: FT_MCP_TOKEN=... FT_ADMIN_TOKEN=... node scripts/mcp_round3.ts --url <deployment> --colony <new colony id>");
  process.exit(2);
}

let failed = false;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failed = true;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

type Call = (name: string, args?: Record<string, unknown>) => Promise<{ ok: boolean; data: any; text: string }>;

async function connect(name: string): Promise<{ client: Client; call: Call }> {
  const transport = new StreamableHTTPClientTransport(new URL(`${URL_BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${MCP_TOKEN}` } } });
  const client = new Client({ name, version: "0.0.1" });
  await client.connect(transport);
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
  return { client, call };
}

/** One JSON-RPC initialize against /mcp with the given URL suffix and headers: the HTTP status. */
async function rawInit(suffix: string, headers: Record<string, string>): Promise<number> {
  const res = await fetch(`${URL_BASE}/mcp${suffix}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "round3-auth", version: "0.0.1" } } }),
  });
  await res.body?.cancel();
  return res.status;
}

/** git with no credential helpers, prompts or user config. */
function git(args: string[], cwd?: string): string {
  const home = mkdtempSync(join(tmpdir(), "ft-home-"));
  try {
    return execFileSync("git", args, {
      ...(cwd ? { cwd } : {}),
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "round3-check", GIT_AUTHOR_EMAIL: "round3@example.invalid", GIT_COMMITTER_NAME: "round3-check", GIT_COMMITTER_EMAIL: "round3@example.invalid" },
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/** Do the held intent's work as the take told us (clone trunk at the base, edit, commit, push to the workspace) and propose it. */
async function work(call: Call, taken: any, edits: Record<string, string | null>, summary: string): Promise<string | null> {
  const dir = mkdtempSync(join(tmpdir(), "ft-work-"));
  try {
    const lease = taken.lease;
    git(["-c", `http.extraHeader=Authorization: Bearer ${taken.tokens.trunkRead}`, "clone", "-q", lease.trunk.remote, "w"], dir);
    const w = join(dir, "w");
    git(["checkout", "-q", "-B", "ft-work", lease.baseSha], w);
    for (const [path, content] of Object.entries(edits)) {
      if (content === null) rmSync(join(w, path), { force: true });
      else {
        mkdirSync(dirname(join(w, path)), { recursive: true });
        writeFileSync(join(w, path), content);
      }
    }
    git(["add", "-A"], w);
    git(["commit", "-q", "-m", summary, "-m", `FT-Intent: ${taken.intent.id}`], w);
    git(["-c", `http.extraHeader=Authorization: Bearer ${taken.tokens.workspaceWrite}`, "push", "-q", "--force", lease.workspace.remote, "HEAD:refs/heads/main"], w);
    const headSha = git(["rev-parse", "HEAD"], w);
    const proposed = await call("propose", { headSha, summary, notVerified: "Not verified: nothing beyond the files in this change." });
    const id = proposed.data?.proposal?.id ?? proposed.data?.id ?? proposed.data?.proposalId ?? null;
    check(`proposed ${summary} (${id ?? proposed.text.slice(0, 160)})`, proposed.ok && !!id);
    return id;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Wait for a proposal to settle: landed, returned or rejected (approving it if it waits for a person). */
async function settle(pid: string, approve: boolean, seconds = 240): Promise<any> {
  const end = Date.now() + seconds * 1000;
  let approved = false;
  while (Date.now() < end) {
    const { data } = await rest("GET", `/colonies/${COLONY}/proposals/${pid}`);
    const p = data?.proposal ?? data;
    if (p?.status === "landed" || p?.status === "returned" || p?.status === "rejected") return p;
    if (p?.status === "escalated" && approve && !approved) {
      const r = await rest("POST", `/colonies/${COLONY}/review/${pid}`, { decision: "approve", reason: "round 3 live check: the setup change", by: "round3-check" });
      console.log(`  (the setup change waited for a person; approved by this script: ${r.status})`);
      approved = true;
    }
    await sleep(3000);
  }
  return null;
}

// 1. The MCP token: header only.
check(`a token in the query is refused (${await rawInit(`?token=${encodeURIComponent(MCP_TOKEN)}`, {})})`, (await rawInit(`?token=${encodeURIComponent(MCP_TOKEN)}`, {})) === 401);
check(`a wrong Bearer token is refused`, (await rawInit("", { authorization: "Bearer not-the-token" })) === 401);

// 2. Set up an empty colony with the guard's scenario.
const made = await rest("POST", "/colonies", { name: COLONY });
check(`created colony ${COLONY} (${made.status})`, made.status === 201);
if (made.status !== 201) process.exit(1);
const i1 = await rest("POST", `/colonies/${COLONY}/intents`, {
  title: "Add src/b.ts and src/a.ts that imports it",
  why: "src/b.ts exports const b = 1; src/a.ts imports b from ./b.ts and exports const a = b + 1.",
  footprint: ["src/b.ts", "src/a.ts"],
  priority: 5,
  createdBy: "round3-check",
});
check(`declared the setup intent (${i1.status})`, i1.status === 201);

// 3. Join, and resuming from other sessions.
const a = await connect("round3-check");
const joined = await a.call("join", { colony: COLONY, name: "round3-check", model: "scripted" });
const agentId: string | undefined = joined.data?.agentId ?? joined.data?.agent?.id;
const resumeKey: string | undefined = joined.data?.resumeKey;
check(`joined as ${agentId}; join gave a resume key`, joined.ok && !!agentId && typeof resumeKey === "string" && resumeKey.length >= 32);
for (const [label, extra, expectOk] of [
  ["without the resume key is refused", {}, false],
  ["with a wrong resume key is refused", { resumeKey: "x".repeat(43) }, false],
  ["with the resume key works", { resumeKey }, true],
] as const) {
  const other = await connect("round3-other");
  const r = await other.call("join", { colony: COLONY, agentId, ...extra });
  check(`resuming ${agentId} from another session ${label} (${r.text.replace(/\s+/g, " ").slice(0, 120)})`, r.ok === expectOk);
  await other.client.close();
}

// 4. Land the setup change.
const t1 = await a.call("take", { wait: 30 });
check(`took the setup intent (${t1.data?.intent?.title ?? t1.text.slice(0, 120)})`, t1.ok && t1.data?.intent?.id === i1.data?.id);
const p1 = await work(a.call, t1.data, { "src/b.ts": "export const b = 1;\n", "src/a.ts": 'import { b } from "./b.ts";\n\nexport const a = b + 1;\n' }, "Add src/b.ts and src/a.ts that imports it");
const s1 = p1 ? await settle(p1, true) : null;
check(`the setup change landed (${s1?.status ?? "no answer"}${s1?.reason ? `: ${String(s1.reason).slice(0, 120)}` : ""})`, s1?.status === "landed");
if (s1?.status !== "landed") {
  await a.client.close();
  process.exit(1);
}

// 5. Delete src/b.ts while src/a.ts imports it: the guard sends it back.
const i2 = await rest("POST", `/colonies/${COLONY}/intents`, {
  title: "Remove src/b.ts and inline its value into src/a.ts",
  why: "src/b.ts holds a single constant; src/a.ts should export const a = 2 on its own.",
  footprint: ["src/b.ts", "src/a.ts"],
  priority: 5,
  createdBy: "round3-check",
});
check(`declared the deletion intent (${i2.status})`, i2.status === 201);
const t2 = await a.call("take", { wait: 30 });
check(`took the deletion intent`, t2.ok && t2.data?.intent?.id === i2.data?.id);
const p2 = await work(a.call, t2.data, { "src/b.ts": null }, "Remove src/b.ts");
const s2 = p2 ? await settle(p2, false) : null;
const guarded = s2?.status === "returned" && /breaks the imports of src\/a\.ts/.test(String(s2?.reason ?? ""));
check(`deleting src/b.ts alone went back naming src/a.ts (${s2?.status ?? "no answer"}: ${String(s2?.reason ?? "").slice(0, 160)})`, guarded);

// 6. The next take says why; deleting with the importer's rewrite lands.
const t3 = await a.call("take", { wait: 30 });
const last = t3.data?.lastReturn;
check(`the next take carries lastReturn (${String(last?.reason ?? "none").slice(0, 120)})`, t3.ok && t3.data?.intent?.id === i2.data?.id && !!last && (!guarded || /breaks the imports/.test(String(last.reason))));
const p3 = await work(a.call, t3.data, { "src/b.ts": null, "src/a.ts": "export const a = 2;\n" }, "Remove src/b.ts and inline its value into src/a.ts");
const s3 = p3 ? await settle(p3, true) : null;
check(`deleting src/b.ts with src/a.ts rewritten landed (${s3?.status ?? "no answer"}${s3?.reason ? `: ${String(s3.reason).slice(0, 120)}` : ""})`, s3?.status === "landed");

// 7. MCP why: each note trimmed to the proposals that wrote the path.
const why = await a.call("why", { path: "src/a.ts" });
const notes: any[] = Array.isArray(why.data) ? why.data : (why.data?.entries ?? why.data?.landings ?? why.data?.notes ?? []);
const writers = notes.flatMap((n) => (n?.note?.proposals ?? n?.proposals ?? []) as any[]);
check(`MCP why on src/a.ts lists only its writers (${writers.length} proposal(s) in ${notes.length} note(s))`, why.ok && writers.length > 0 && writers.every((p) => (p.writeSet ?? []).some((w: any) => w.path === "src/a.ts")));

await a.client.close();
console.log(failed ? "SOME CHECKS FAILED" : "ALL CHECKS PASSED");
process.exit(failed ? 1 : 0);
