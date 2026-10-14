/**
 * Live check of the megafile alarm (FT_MEGAFILE) on a deployment, as scripted external agents over MCP plus the admin
 * API. Every change is an inline change (`propose` with `files`).
 * - a 650-line script file is seeded, then agents each append a function to it until it turns hot;
 * - the colony declares one split intent (source system, above normal priority) and holds the file;
 * - a change on its way that writes the file (one waiting for a person) goes back with the hold's reason, and so does
 *   one proposed after the hold began by an agent that took its work before;
 * - a new intent that covers the file is not offered: one new agent gets the split intent, the next one waits;
 * - a scripted agent splits the file (moves its functions to new modules and re-exports them from the same path), the
 *   split lands, the hold lifts, the file's work is offered again, and every name the file exported still is;
 * - a person holds the file and releases it over the API.
 * Each agent's work is assigned through the admin API (POST intents with assignedTo), so the agents never wait on each
 * other's claims. Review is off for the colony; one path is protected so a change can wait for a person.
 * The colony must not exist yet. The deployment needs FT_INLINE on and FT_MEGAFILE on for the colony (or "on").
 *
 * Usage:
 *   FT_MCP_TOKEN=... FT_ADMIN_TOKEN=... node scripts/megafile.ts --url https://<deployment> --colony <new colony id>
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
  console.error("usage: FT_MCP_TOKEN=... FT_ADMIN_TOKEN=... node scripts/megafile.ts --url <deployment> --colony <new colony id>");
  process.exit(2);
}

const BIG = "src/big.ts";
const GUARDED = "src/guarded.ts";
const BY = "megafile-check";
/** Appending agents at most before the check gives up on the file turning hot. */
const MAX_APPENDS = 8;

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

type Call = (name: string, args?: Record<string, unknown>) => Promise<{ ok: boolean; data: any; text: string }>;
type Agent = { name: string; agentId: string; client: Client; call: Call };

/** One scripted agent: its own MCP session, joined to the colony. */
async function agent(name: string): Promise<Agent> {
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
  const joined = await call("join", { colony: COLONY, name, model: "scripted" });
  if (!joined.ok || typeof joined.data?.agentId !== "string") throw new Error(`${name} could not join: ${short(joined.text, 300)}`);
  return { name, agentId: joined.data.agentId, client, call };
}

/** Give an agent work on these files (an intent assigned to it), then take it: the intent id. */
async function assign(a: Agent, title: string, footprint: string[]): Promise<string> {
  const made = await rest("POST", `/colonies/${COLONY}/intents`, { title, why: `${title} (the megafile check's scripted work).`, footprint, priority: 2, assignedTo: a.agentId, createdBy: BY });
  if (made.status !== 201) throw new Error(`could not assign "${title}" to ${a.name}: ${made.status} ${short(made.data)}`);
  const taken = await a.call("take", { wait: 30 });
  if (taken.data?.intent?.id !== made.data.id) throw new Error(`${a.name} took ${short(taken.data?.intent?.id ?? taken.text)}, not ${made.data.id}`);
  return made.data.id;
}

/** A trunk file at the agent's lease base, through MCP read ("" when it is not there). */
async function read(a: Agent, path: string): Promise<string> {
  const r = await a.call("read", { path });
  if (!r.ok) throw new Error(`${a.name} could not read ${path}: ${short(r.text, 300)}`);
  return typeof r.data?.content === "string" ? r.data.content : "";
}

/** Propose files inline: the proposal's id, status and reason as the propose call answered. */
async function propose(a: Agent, files: Array<{ path: string; content: string | null }>, summary: string): Promise<{ id: string; status: string; reason: string | null }> {
  const p = await a.call("propose", { files, summary, notVerified: "Not verified: nothing beyond the files in this change." });
  const id = p.data?.proposal?.id;
  if (!p.ok || typeof id !== "string") throw new Error(`${a.name} could not propose "${summary}": ${short(p.text, 300)}`);
  return { id, status: p.data.proposal.status, reason: p.data.proposal.reason ?? null };
}

/** Poll a proposal until its status is one of `want` (or the time runs out): the proposal. */
async function until(pid: string, want: string[], seconds = 120): Promise<any> {
  const end = Date.now() + seconds * 1000;
  let last: any = null;
  while (Date.now() < end) {
    last = (await rest("GET", `/colonies/${COLONY}/proposals/${pid}`)).data;
    if (want.includes(last?.status)) return last;
    await sleep(1500);
  }
  return last;
}

/** Poll the colony's megafile state until `ok` holds (or the time runs out): the last answer. */
async function megafiles(ok: (m: any) => boolean, seconds = 60): Promise<any> {
  const end = Date.now() + seconds * 1000;
  let last: any = null;
  while (Date.now() < end) {
    last = (await rest("GET", `/colonies/${COLONY}/megafile`)).data;
    if (ok(last)) return last;
    await sleep(1500);
  }
  return last;
}

/** One function of `lines` lines: a doc comment, the signature, its body, the return, the brace and a blank line. */
function block(name: string, lines: number): string {
  const body = Array.from({ length: lines - 5 }, (_, i) => `  const v${i} = x + ${i};`);
  return `${[`/** ${name}: a helper the swarm added. */`, `export function ${name}(x: number): number {`, ...body, `  return v${lines - 6};`, "}", ""].join("\n")}\n`;
}

/** The names a module exports: its own functions and constants, and the names it re-exports. */
function exportedNames(source: string): string[] {
  const names = new Set<string>();
  for (const m of source.matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]!);
  for (const m of source.matchAll(/^export\s*\{([^}]*)\}\s*from\s*["'][^"']+["']/gm)) {
    for (const part of m[1]!.split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) names.add(name);
    }
  }
  return [...names].sort();
}

/**
 * The split: the file's functions go to two new modules beside it, and the file re-exports every one of them, so its
 * importers keep working. Whatever comes before the first function stays in the file.
 */
function split(source: string): Array<{ path: string; content: string }> {
  const lines = source.split("\n");
  const starts = lines.flatMap((l, i) => (l.startsWith("/** ") ? [i] : []));
  if (starts.length < 2) throw new Error(`${BIG} has ${starts.length} functions; nothing to split`);
  const head = lines.slice(0, starts[0]).join("\n");
  const blocks = starts.map((s, k) => lines.slice(s, starts[k + 1] ?? lines.length).join("\n"));
  const half = Math.ceil(blocks.length / 2);
  const parts = [
    { path: "src/big-part-a.ts", blocks: blocks.slice(0, half) },
    { path: "src/big-part-b.ts", blocks: blocks.slice(half) },
  ];
  const reexports = parts.map((p) => `export { ${exportedNames(p.blocks.join("\n")).join(", ")} } from "./${p.path.slice(4)}";`);
  const index = `${head ? `${head.trimEnd()}\n` : ""}// Split by the megafile check: the code lives in big-part-a.ts and big-part-b.ts.\n${reexports.join("\n")}\n`;
  return [{ path: BIG, content: index }, ...parts.map((p) => ({ path: p.path, content: `${p.blocks.join("\n").trimEnd()}\n` }))];
}

async function main(): Promise<void> {
  const agents: Agent[] = [];
  try {
    // Setup: a new colony, review off, one protected path, and the alarm on for it.
    const made = await rest("POST", "/colonies", { name: COLONY, poolTarget: 4 });
    check(`created ${COLONY} (${made.status})`, made.status === 201);
    if (made.status !== 201) return;
    const policy = await rest("POST", `/colonies/${COLONY}/decide/policy`, { enabled: false, protectedPaths: [GUARDED] });
    check(`review off, ${GUARDED} protected (${policy.status})`, policy.status === 200);
    const state = await megafiles(() => true, 1);
    check(`the megafile alarm is on for ${COLONY} (FT_MEGAFILE)`, state?.on === true);
    if (state?.on !== true) return;

    // 1. Seed a 650-line script file.
    const seeder = await agent("megafile-seeder");
    agents.push(seeder);
    await assign(seeder, "Seed the big module", [BIG]);
    const seed = Array.from({ length: 65 }, (_, i) => block(`f${i}`, 10)).join("");
    const seeded = await until((await propose(seeder, [{ path: BIG, content: seed }], "Seed the big module")).id, ["landed", "returned", "rejected"]);
    check(`seeded ${BIG} with ${seed.split("\n").length - 1} lines (${seeded?.status})`, seeded?.status === "landed");
    const exportsBefore = exportedNames(seed);

    // 2. A change that writes the file and waits for a person (it also writes a protected file): on its way when the hold begins.
    const guard = await agent("megafile-guard");
    agents.push(guard);
    const guardIntent = await assign(guard, "Guard the big module", [GUARDED]);
    const guardP = await propose(guard, [{ path: GUARDED, content: "export const guarded = true;\n" }, { path: BIG, content: `${await read(guard, BIG)}// guarded\n` }], "Guard the big module");
    const waiting = await until(guardP.id, ["escalated", "landed", "returned", "rejected"]);
    check(`a change that writes ${BIG} waits for a person (${waiting?.status})`, waiting?.status === "escalated");

    // 3. Agents each append a function until the file turns hot. Before the last append, one more agent takes work on it.
    let late: Agent | null = null;
    let lateIntent = "";
    let held: any = null;
    for (let k = 1; k <= MAX_APPENDS && !held; k++) {
      if (k >= 4 && !late) {
        late = await agent("megafile-late");
        agents.push(late);
        lateIntent = await assign(late, "Add a late helper", [BIG]);
      }
      const writer = await agent(`megafile-writer-${k}`);
      agents.push(writer);
      await assign(writer, `Add helper g${k}`, [BIG]);
      const current = await read(writer, BIG);
      const p = await until((await propose(writer, [{ path: BIG, content: `${current}${block(`g${k}`, 45)}` }], `Add helper g${k}`)).id, ["landed", "returned", "rejected"]);
      console.log(`  writer ${k}: ${p?.status}, ${BIG} now ${current.split("\n").length - 1 + 45} lines`);
      if (p?.status !== "landed") throw new Error(`append ${k} did not land: ${short(p?.reason)}`);
      if (k >= 4) held = (await megafiles((m) => (m?.held ?? []).some((h: any) => h.path === BIG), 20))?.held?.find((h: any) => h.path === BIG) ?? null;
    }
    check(`${BIG} turned hot and is held (${short(held, 240)})`, !!held);
    if (!held) return;

    // 4. One split intent, from the colony, above normal priority, with the numbers in its why.
    const splitId: string = held.intentId;
    const intent = (await rest("GET", `/colonies/${COLONY}/intents/${splitId}`)).data?.intent;
    check(
      `the split intent: "${intent?.title}", source ${intent?.source}, priority ${intent?.priority}, footprint ${short(intent?.footprint)}`,
      intent?.title === `Split ${BIG} into smaller modules` && intent?.source === "system" && intent?.priority > 5 && (intent?.footprint ?? []).includes(BIG),
    );
    check(`its why states the numbers (${short(intent?.why, 220)})`, new RegExp(`${BIG} has ${held.lines} lines, up from ${held.baseline}`).test(String(intent?.why ?? "")));
    check(`its acceptance keeps every export importable from ${BIG} (${short(intent?.acceptance)})`, String(intent?.acceptance ?? "").includes(`still exported from ${BIG}`));
    const snapshot = (await rest("GET", `/colonies/${COLONY}`)).data;
    check(`the colony's status lists the held file (${short(snapshot?.megafiles?.held)})`, (snapshot?.megafiles?.held ?? []).some((h: any) => h.path === BIG && h.intentId === splitId));
    const reason = `${BIG} is being split by intent ${splitId}; take again after it lands`;

    // 5. Changes that write the file go back: the one waiting for a person when the hold began, and one proposed after it.
    const guardBack = await until(guardP.id, ["returned", "rejected", "landed"], 30);
    check(`the change waiting for a person went back with the hold's reason (${guardBack?.status}: ${short(guardBack?.reason)})`, guardBack?.status === "returned" && guardBack?.reason === reason);
    await rest("POST", `/colonies/${COLONY}/intents/${guardIntent}/withdraw`, { reason: "the megafile check is done with it", by: BY });
    const lateP = await propose(late!, [{ path: BIG, content: `${await read(late!, BIG)}${block("late", 12)}` }], "Add a late helper");
    check(`a change proposed after the hold began goes back at once (${lateP.status}: ${short(lateP.reason)})`, lateP.status === "returned" && lateP.reason === reason);

    // 6. A new intent on the file is not offered: the next agent gets the split, the one after it waits.
    const more = await rest("POST", `/colonies/${COLONY}/intents`, { title: "Add one more helper", why: "More work on the big module.", footprint: [BIG], priority: 5, createdBy: BY });
    check(`declared new work on ${BIG} (${more.status})`, more.status === 201);
    const splitter = await agent("megafile-splitter");
    agents.push(splitter);
    const got = await splitter.call("take", { wait: 30 });
    check(`a new agent is offered the split intent, not the new work (${short(got.data?.intent?.id ?? got.data?.reason)})`, got.data?.intent?.id === splitId);
    const waiter = await agent("megafile-waiter");
    agents.push(waiter);
    const none = await waiter.call("take", { wait: 5 });
    check(`the next agent waits: every open intent covers the held file (${short(none.data?.reason)})`, none.data?.wait === true && String(none.data?.reason ?? "").includes(reason));

    // 7. The split: functions move to two new modules; the file re-exports them all.
    const before = await read(splitter, BIG);
    const files = split(before);
    const exportsSplit = exportedNames(files[0]!.content);
    check(`the split keeps every name ${BIG} exports (${exportsSplit.length} of ${exportedNames(before).length})`, JSON.stringify(exportsSplit) === JSON.stringify(exportedNames(before)));
    const splitP = await until((await propose(splitter, files, `Split ${BIG} into smaller modules`)).id, ["landed", "returned", "rejected", "escalated"]);
    check(`the split landed (${splitP?.status}${splitP?.reason ? `: ${short(splitP.reason)}` : ""})`, splitP?.status === "landed");
    const lifted = await megafiles((m) => (m?.held ?? []).every((h: any) => h.path !== BIG) && (m?.lifted ?? []).some((h: any) => h.path === BIG && h.intentId === splitId));
    const lift = (lifted?.lifted ?? []).find((h: any) => h.path === BIG && h.intentId === splitId);
    check(`the hold lifted when the split landed (${short(lift, 240)})`, lift?.lifted === "landed");
    check(`the status records the file's lines before and after (${lift?.lines} → ${lift?.linesAfter})`, typeof lift?.lines === "number" && typeof lift?.linesAfter === "number" && lift.linesAfter < lift.lines);
    // The split's evidence carries the same numbers, and the trunk writer copies evidence into the landing's lineage note.
    const why = (await rest("GET", `/colonies/${COLONY}/why?path=${encodeURIComponent(BIG)}`)).data;
    const noted = (Array.isArray(why) ? why : [])
      .flatMap((e: any) => e?.note?.proposals ?? [])
      .find((p: any) => p?.id === splitP?.id)
      ?.evidence?.checks?.find((k: any) => k?.name === "megafile: split");
    check(`the split landing's lineage note records ${BIG}'s lines before and after (${short(noted?.detail, 200)})`, /lines when it was held .*after this change/.test(String(noted?.detail ?? "")));

    // 8. The file's work is offered again, and its exports are all still there.
    const again = await waiter.call("take", { wait: 30 });
    const againId = again.data?.intent?.id;
    check(`work on ${BIG} is offered again (${short(againId ?? again.data?.reason)})`, againId === more.data?.id || againId === lateIntent);
    if (againId) {
      const after = await read(waiter, BIG);
      check(`every name ${BIG} exported is still exported from it (${exportedNames(after).length} of ${exportsBefore.length} seeded)`, exportsBefore.every((n) => exportedNames(after).includes(n)) && JSON.stringify(exportedNames(after)) === JSON.stringify(exportedNames(before)));
      await waiter.call("release", { reason: "the megafile check only looked" });
    }

    // 9. A person holds the file, then releases it.
    const hold = await rest("POST", `/colonies/${COLONY}/megafile`, { path: BIG, action: "hold", by: BY });
    check(`a person holds ${BIG} (${hold.status}: ${short(hold.data?.hold)})`, hold.status === 201 && hold.data?.hold?.signal === "person" && hold.data?.hold?.by === BY);
    const release = await rest("POST", `/colonies/${COLONY}/megafile`, { path: BIG, action: "release", by: BY });
    check(`and releases it (${release.status}: ${short(release.data?.released?.lifted)})`, release.status === 200 && release.data?.released?.lifted === `released by ${BY}`);
    if (hold.data?.hold?.intentId) await rest("POST", `/colonies/${COLONY}/intents/${hold.data.hold.intentId}/withdraw`, { reason: "the megafile check is done", by: BY });
  } finally {
    for (const a of agents) await a.client.close().catch(() => undefined);
  }
}

main()
  .catch((e) => {
    console.error(`megafile check failed: ${e instanceof Error ? e.message : String(e)}`);
    failed = true;
  })
  .finally(() => {
    console.log(failed ? "SOME CHECKS FAILED" : "ALL CHECKS PASSED");
    process.exit(failed ? 1 : 0);
  });
