/**
 * Live check of the public reads of one landing on a deployment, as scripted external agents over MCP plus the admin API:
 * - in two new colonies, an agent adds notes/diff.md and then changes its second line, so each colony has two landings;
 * - the diff route (GET /api/colonies/:id/landings/:ref/diff?path=) shows the colony listed in FT_PUBLIC_GIT or
 *   FT_PUBLIC_MCP its change to the file: the first landing as an added file, the second as a modified one with the
 *   changed line, by landing id and by the commit's prefix; a file the landing did not change answers 404;
 * - the same route answers 404 for the colony listed in neither;
 * - the note check of one landing (GET /api/colonies/:id/notes/verify?landing=) answers for that landing alone, by id
 *   and by commit, and turns intact once its note is pushed; an unknown landing answers 404;
 * - the landing page answers with ?note=<public colony>; the script prints what to look at in a browser.
 * Both colonies must not exist yet. The deployment needs FT_INLINE on, the public colony in FT_PUBLIC_GIT (or
 * FT_PUBLIC_MCP), and the private one in neither.
 *
 * Usage:
 *   FT_MCP_TOKEN=... FT_ADMIN_TOKEN=... node scripts/landing_diff.ts --url https://<deployment> --public <new colony id> --private <new colony id>
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const URL_BASE = (arg("url", process.env.FT_URL) ?? "").replace(/\/+$/, "");
const PUBLIC = arg("public") ?? "";
const PRIVATE = arg("private") ?? "";
const MCP_TOKEN = process.env.FT_MCP_TOKEN ?? "";
const ADMIN_TOKEN = process.env.FT_ADMIN_TOKEN ?? "";
if (!URL_BASE || !PUBLIC || !PRIVATE || PUBLIC === PRIVATE || !MCP_TOKEN || !ADMIN_TOKEN) {
  console.error("usage: FT_MCP_TOKEN=... FT_ADMIN_TOKEN=... node scripts/landing_diff.ts --url <deployment> --public <new colony id> --private <another new colony id>");
  process.exit(2);
}

const FILE = "notes/diff.md";
const FIRST = "one\ntwo\nthree\n";
const SECOND = "one\n2\nthree\n";

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
async function settle(colony: string, pid: string): Promise<{ status: string; landingId: string | null }> {
  let p: any = {};
  for (let i = 0; i < 40 && !["landed", "returned", "rejected"].includes(p.status ?? ""); i++) {
    await sleep(3000);
    p = (await rest("GET", `/api/colonies/${colony}/proposals/${pid}`)).data ?? {};
  }
  return { status: p.status ?? "", landingId: p.landingId ?? null };
}

/** Declare an intent in a session, take it, propose the file inline, and wait for it to land; the landing id. */
async function land(colony: string, s: Awaited<ReturnType<typeof session>>, title: string, content: string): Promise<string> {
  const declared = await s.call("declare", { title, why: `The landing diff check writes ${FILE}.`, footprint: [FILE] });
  const intentId = declared.data?.intent?.id;
  check(`${colony}: declared "${title}" (${short(intentId)})`, declared.ok && typeof intentId === "string");
  let taken = await s.call("take", { wait: 30 });
  for (let i = 0; i < 5 && taken.data?.intent?.id !== intentId; i++) {
    if (taken.data?.intent) await s.call("release", { reason: "the landing diff check wants its own intent" });
    taken = await s.call("take", { wait: 30 });
  }
  check(`${colony}: took "${title}"`, taken.data?.intent?.id === intentId);
  const proposed = await s.call("propose", { files: [{ path: FILE, content }], summary: title, notVerified: "Not verified: the check ran nothing; it reads the change back." });
  const pid = proposed.data?.proposal?.id ?? "";
  const settled = await settle(colony, pid);
  check(`${colony}: "${title}" landed (${settled.status}, ${short(settled.landingId)})`, settled.status === "landed" && typeof settled.landingId === "string");
  return settled.landingId ?? "";
}

/** A new colony with two landings on FILE: the file added, then its second line changed. Both landings with their commits. */
async function colonyWithTwoLandings(colony: string): Promise<Array<{ id: string; trunkSha: string }>> {
  const made = await rest("POST", "/api/colonies", { name: colony, poolTarget: 4 });
  check(`created ${colony} (${made.status})`, made.status === 201);
  check(`${colony}: review off for these checks`, (await rest("POST", `/api/colonies/${colony}/decide/policy`, { enabled: false })).status === 200);
  const s = await session(`landing-diff-${colony}`);
  const joined = await s.call("join", { colony, name: "landing-diff-check", model: "scripted-writer" });
  check(`${colony}: joined (${short(joined.data?.agentId)})`, joined.ok);
  const first = await land(colony, s, `Add ${FILE}`, FIRST);
  const second = await land(colony, s, `Change the second line of ${FILE}`, SECOND);
  await s.close();
  const why = await read(`/api/colonies/${colony}/why?path=${encodeURIComponent(FILE)}`);
  const commits = new Map<string, string>((Array.isArray(why.data) ? why.data : []).map((e: any) => [e?.landing?.id, e?.landing?.trunkSha]));
  return [first, second].map((id) => ({ id, trunkSha: commits.get(id) ?? "" }));
}

async function main(): Promise<void> {
  const [added, changed] = await colonyWithTwoLandings(PUBLIC);
  const [, hidden] = await colonyWithTwoLandings(PRIVATE);
  if (!added || !changed || !hidden) throw new Error("the colonies did not land their changes");
  const diff = (colony: string, ref: string, path = FILE) => read(`/api/colonies/${colony}/landings/${ref}/diff?path=${encodeURIComponent(path)}`);

  // The diff route, for the public colony.
  const a = await diff(PUBLIC, added.id);
  check(`${PUBLIC}: the first landing's change is an added file (${a.status}, ${short(a.data?.status)}, +${a.data?.added})`, a.status === 200 && a.data?.status === "added" && a.data?.added === 3 && a.data?.before === null);
  const m = await diff(PUBLIC, changed.id);
  check(
    `${PUBLIC}: the second landing's change replaces line 2 (${m.status}, ${short(m.data?.status)}, +${m.data?.added} -${m.data?.removed})`,
    m.status === 200 && m.data?.status === "modified" && m.data?.added === 1 && m.data?.removed === 1 && /\n-two\n\+2(\n|$)/.test(m.data?.hunks ?? ""),
  );
  check(`${PUBLIC}: it diffs against the first landing's blob (${short(m.data?.before, 12)})`, typeof a.data?.after === "string" && m.data?.before === a.data?.after);
  const byCommit = await diff(PUBLIC, changed.trunkSha.slice(0, 7));
  check(`${PUBLIC}: the same change by the commit's prefix ${changed.trunkSha.slice(0, 7)} (${byCommit.status})`, byCommit.status === 200 && byCommit.data?.landingId === changed.id);
  const other = await diff(PUBLIC, changed.id, "notes/other.md");
  check(`${PUBLIC}: a file the landing did not change answers 404 (${other.status}: ${short(other.data?.error, 90)})`, other.status === 404);

  // The same route for the colony that is not public.
  const refused = await diff(PRIVATE, hidden.id);
  check(`${PRIVATE}: the diff route answers 404 (${refused.status}: ${short(refused.data?.error, 120)})`, refused.status === 404 && /does not show file contents here/.test(refused.data?.error ?? ""));

  // The note check of one landing.
  let v = await read(`/api/colonies/${PUBLIC}/notes/verify?landing=${changed.id}`);
  for (let i = 0; i < 20 && v.data?.notes?.[0]?.status !== "intact"; i++) {
    await sleep(3000);
    v = await read(`/api/colonies/${PUBLIC}/notes/verify?landing=${changed.id}`);
  }
  check(`${PUBLIC}: the note check answers for that landing alone and finds it intact (${short(v.data?.notes)})`, v.status === 200 && v.data?.notes?.length === 1 && v.data.notes[0].landingId === changed.id && v.data.notes[0].status === "intact");
  const vc = await read(`/api/colonies/${PUBLIC}/notes/verify?landing=${changed.trunkSha.slice(0, 9)}`);
  check(`${PUBLIC}: and by its commit (${vc.status}, ${short(vc.data?.notes?.[0]?.landingId)})`, vc.status === 200 && vc.data?.notes?.[0]?.landingId === changed.id);
  const unknown = await read(`/api/colonies/${PUBLIC}/notes/verify?landing=lnd_doesnotexist`);
  check(`${PUBLIC}: an unknown landing answers 404 (${unknown.status})`, unknown.status === 404);

  // The landing page.
  const page = await read(`/?note=${PUBLIC}`);
  check(`the landing page answers with ?note=${PUBLIC} (${page.status}, ${page.type})`, page.status === 200 && page.type.includes("text/html"));
  console.log(`      In a browser: ${URL_BASE}/?note=${PUBLIC}#how shows the Remember card with "Note intact", commit ${changed.trunkSha.slice(0, 7)}`);
  console.log(`      and the intent "Change the second line of ${FILE}"; ${URL_BASE}/c/${PUBLIC}?path=${encodeURIComponent(FILE)} shows each landing's badge,`);
  console.log(`      and "Show the change" on the newest shows -two +2 (on ${URL_BASE}/c/${PRIVATE}?path=${encodeURIComponent(FILE)} it says the colony does not show file contents).`);

  console.log(failed ? "SOME CHECKS FAILED" : "ALL CHECKS PASSED");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(`landing diff check failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
