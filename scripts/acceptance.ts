/**
 * Live check of quoted acceptance (FT_QUOTED_ACCEPTANCE) on a deployment, with external agents over MCP and the admin
 * API. Each run works in a directory of its own (a fresh region, so no earned autonomy lets the reflex land a change
 * alone), on a colony FT_QUOTED_ACCEPTANCE names, with review on. Two intents ask for the same two acceptance lines:
 * - A: a change that meets both lands, and its lineage note (read with MCP why) keeps, for each line, the file and a
 *   line of the change the second opinion quoted for it.
 * - B: a change that meets only the first comes back, or goes to a person, naming the second line.
 * - C (unless --keep off): a later intent with its own acceptance list changes A's file and drops the hyphens A's second
 *   line asks for. A's lines are asked again as keep lines; the outcome is printed as INFO (it is the model's call).
 * The second opinion is a real model, so the wording of its answers is free; the platform's rule is checked strictly:
 * a change landed on a second opinion only with every line of its intent met, and every line counted met quotes a line
 * that the change has (whitespace collapsed).
 *
 * The deployment needs FT_QUOTED_ACCEPTANCE and FT_INLINE naming the colony (inline changes over MCP), Workers AI, and
 * the colony's review on (the script turns it on). The colony is created when missing.
 *
 * Usage:
 *   FT_ADMIN_TOKEN=... FT_MCP_TOKEN=... node scripts/acceptance.ts --url https://<deployment> --colony <colony FT_QUOTED_ACCEPTANCE names> [--keep off]
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const URL_BASE = (arg("url", process.env.FT_URL) ?? "").replace(/\/+$/, "");
const COLONY = arg("colony") ?? "";
const KEEP = arg("keep", "on") !== "off";
const ADMIN_TOKEN = process.env.FT_ADMIN_TOKEN ?? "";
const MCP_TOKEN = process.env.FT_MCP_TOKEN ?? "";
if (!URL_BASE || !COLONY || !ADMIN_TOKEN || !MCP_TOKEN) {
  console.error("usage: FT_ADMIN_TOKEN=... FT_MCP_TOKEN=... node scripts/acceptance.ts --url <deployment> --colony <colony FT_QUOTED_ACCEPTANCE names> [--keep off]");
  process.exit(2);
}

let failed = false;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failed = true;
}
function info(label: string): void {
  console.log(`INFO  ${label}`);
}
const short = (x: unknown, n = 200): string => String(typeof x === "string" ? x : JSON.stringify(x ?? null)).replace(/\s+/g, " ").slice(0, n);
/** Whitespace collapsed, as the platform compares quotes. */
const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();
/** A file's text as one line per the platform's comparison: each line collapsed, joined with a space. */
const flat = (text: string): string => text.split("\n").map(collapse).filter(Boolean).join(" ");

async function rest(method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
  const res = await fetch(`${URL_BASE}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
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

/** One external agent: its own MCP session, joined to the colony. */
interface McpAgent {
  id: string;
  call(name: string, args?: Record<string, unknown>): Promise<{ ok: boolean; data: any; text: string }>;
  close(): Promise<void>;
}

async function mcpAgent(name: string): Promise<McpAgent> {
  const transport = new StreamableHTTPClientTransport(new URL(`${URL_BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${MCP_TOKEN}` } } });
  const client = new Client({ name: `firetrident-acceptance-${name}`, version: "0.0.1" });
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
  const joined = await call("join", { colony: COLONY, name, model: "scripted" });
  if (!joined.ok || !joined.data?.agentId) throw new Error(`${name} could not join ${COLONY}: ${short(joined.text)}`);
  return { id: joined.data.agentId as string, call, close: () => client.close() };
}

/** An intent assigned to `agentId` (so its take hands it back), with an acceptance list. */
async function intentFor(agentId: string, p: { title: string; why: string; path: string; acceptance: string[]; source?: "human" | "agent" }): Promise<string> {
  const r = await rest("POST", `/colonies/${COLONY}/intents`, {
    title: p.title,
    why: p.why,
    footprint: [p.path],
    acceptance: p.acceptance,
    source: p.source ?? "human",
    assignedTo: agentId,
    createdBy: "acceptance-check",
    force: true,
  });
  if (!r.data?.id) throw new Error(`intent "${p.title}" was not created (${r.status}): ${short(r.data)}`);
  return r.data.id as string;
}

/** What became of a proposal, and the per-line record the decide stage kept in its evidence. */
interface Outcome {
  id: string;
  status: string;
  reason: string;
  detail: string | null;
  gate: string | null;
}

const SETTLED = new Set(["landed", "returned", "rejected", "escalated"]);
const TRANSIENT = /second opinion unavailable|decide pipeline failed|head commit changed|lane unavailable|landing failed/i;

/** Take the agent's intent, propose `text` for `path` inline, and wait until it lands, comes back or goes to a person. A transient return is tried again. */
async function propose(agent: McpAgent, intentId: string, path: string, text: string, summary: string, read: boolean): Promise<Outcome> {
  for (let round = 0; round < 3; round++) {
    const taken = await agent.call("take", { wait: 30 });
    const got = taken.data?.intent?.id;
    if (got !== intentId) {
      if (got) await agent.call("release", { reason: "acceptance check: not the intent it was assigned" });
      throw new Error(`take gave ${short(got ?? taken.text, 120)} instead of ${intentId}`);
    }
    if (read) await agent.call("read", { path });
    const proposed = await agent.call("propose", { files: [{ path, content: text }], summary, notVerified: "Not verified: a scripted change; no tests were run." });
    const id: string | undefined = proposed.data?.proposal?.id;
    if (!proposed.ok || !id) throw new Error(`propose failed: ${short(proposed.text)}`);
    let status = String(proposed.data?.proposal?.status ?? "");
    let reason = String(proposed.data?.proposal?.reason ?? "");
    for (let i = 0; i < 10 && !SETTLED.has(status); i++) {
      const box = await agent.call("inbox", { proposalId: id, wait: 45 });
      status = String(box.data?.watching?.status ?? status);
      reason = String(box.data?.watching?.reason ?? reason ?? "");
    }
    if (status === "returned" && TRANSIENT.test(reason) && round < 2) {
      info(`${id} came back for a passing reason (${short(reason, 120)}); proposing again`);
      continue;
    }
    const full = await rest("GET", `/colonies/${COLONY}/proposals/${id}`);
    const checks: Array<{ name?: string; detail?: string }> = Array.isArray(full.data?.evidence?.checks) ? full.data.evidence.checks : [];
    return {
      id,
      status: String(full.data?.status ?? status),
      reason: String(full.data?.reason ?? reason ?? ""),
      detail: checks.find((c) => c?.name === "acceptance: quoted")?.detail ?? null,
      gate: checks.find((c) => c?.name === "gate")?.detail ?? null,
    };
  }
  throw new Error(`the proposal for ${intentId} kept coming back for passing reasons`);
}

/** The lines the evidence counts met: place, file and quote (`line 1 met: <path> "<quote>"`). */
function metLines(detail: string | null): Array<{ place: string; path: string; quote: string }> {
  const out: Array<{ place: string; path: string; quote: string }> = [];
  const re = /(?:^|; )((?:keep )?line \d+) met: (\S+) "(.*?)"(?=; (?:keep )?line \d+ |$)/g;
  for (const m of (detail ?? "").matchAll(re)) out.push({ place: m[1]!, path: m[2]!, quote: m[3]! });
  return out;
}

/** The platform's rule on one outcome: every line it counted met quotes a line the change has. */
function quotesHold(o: Outcome, files: Record<string, string>): { ok: boolean; why: string } {
  for (const l of metLines(o.detail)) {
    const text = files[l.path];
    const quote = collapse(l.quote.replace(/…$/, ""));
    if (text === undefined) return { ok: false, why: `${l.place} names ${l.path}, which the change does not write` };
    if (quote.length < 8 || !flat(text).includes(quote)) return { ok: false, why: `${l.place} quotes "${short(l.quote, 80)}", which ${l.path} does not have` };
  }
  return { ok: true, why: `${metLines(o.detail).length} line(s) counted met, each quoting a line of the change` };
}

/** The second opinion's decision in a landing's note, read with MCP why. */
async function noteDecision(agent: McpAgent, path: string, proposalId: string): Promise<any> {
  for (let i = 0; i < 10; i++) {
    const why = await agent.call("why", { path });
    const entries: any[] = Array.isArray(why.data?.entries) ? why.data.entries : [];
    for (const e of entries) {
      const p = (e?.note?.proposals ?? []).find((x: any) => x?.id === proposalId);
      if (p) return (p.decisions ?? []).find((d: any) => d?.layer === "llm") ?? null;
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  return null;
}

const LINE_1 = "slugify lowercases its input";
const LINE_2 = "slugify replaces each run of spaces with one hyphen";

async function main(): Promise<void> {
  const tag = `acc${Date.now().toString(36)}`;
  const dir = tag;
  console.log(`quoted acceptance check ${tag} on ${URL_BASE} (colony ${COLONY}${KEEP ? ", with keep lines" : ""})`);

  const about = await rest("GET", "/about");
  check(`the deployment has FT_QUOTED_ACCEPTANCE on (${short(about.data?.flags, 300)})`, Array.isArray(about.data?.flags) && about.data.flags.includes("FT_QUOTED_ACCEPTANCE"));
  const made = await rest("POST", "/colonies", { name: COLONY, poolTarget: 4 });
  check(`colony ${COLONY} ready (${made.status === 409 ? "exists" : made.status})`, made.status === 201 || made.status === 409);
  check("review is on for the colony", (await rest("POST", `/colonies/${COLONY}/decide/policy`, { enabled: true })).status === 200);

  const a = await mcpAgent(`acceptance-${tag}-a`);
  const b = await mcpAgent(`acceptance-${tag}-b`);
  const agents = [a, b];
  try {
    // A: a change that meets both lines lands, quoting a changed line for each.
    const pathA = `${dir}/slug.ts`;
    const textA = 'export function slugify(text: string): string {\n  const lower = text.toLowerCase();\n  return lower.replace(/ +/g, "-");\n}\n';
    const intentA = await intentFor(a.id, { title: `Add slugify (${tag})`, why: "Links need readable slugs.", path: pathA, acceptance: [LINE_1, LINE_2] });
    const oa = await propose(a, intentA, pathA, textA, "Add slugify: lowercase, spaces to hyphens", false);
    info(`A ${oa.id}: ${oa.status}; ${short(oa.gate, 160)}; acceptance: ${short(oa.detail, 300)}`);
    check(`the colony asks the second opinion line by line (an acceptance record is kept for ${oa.id})`, oa.detail !== null);
    check(`A, which meets both lines, lands (${oa.status}${oa.status === "landed" ? "" : `: ${short(oa.reason, 200)}`})`, oa.status === "landed");
    if (oa.status === "landed") {
      const d = await noteDecision(a, pathA, oa.id);
      const lines: any[] = Array.isArray(d?.acceptance) ? d.acceptance : [];
      const own = lines.filter((l) => l?.kind === "intent");
      check(`A's lineage note (MCP why) keeps both lines with the second opinion's decision (${own.length} kept)`, own.length === 2);
      for (const [i, line] of [LINE_1, LINE_2].entries()) {
        const l = own[i];
        const quote = typeof l?.quote === "string" ? collapse(l.quote) : "";
        check(
          `A line ${i + 1} "${line}" is met, quoting a line of the change: ${short(l?.path, 60)}: "${short(quote, 100)}"`,
          l?.line === line && l?.verdict === "met" && l?.path === pathA && quote.length >= 8 && flat(textA).includes(quote),
        );
      }
    }

    // B: a change that meets only the first line comes back, or goes to a person, naming the second.
    const pathB = `${dir}/lower.ts`;
    const textB = "export function slugify(text: string): string {\n  return text.toLowerCase();\n}\n";
    const intentB = await intentFor(b.id, { title: `Add a lowercasing slugify (${tag})`, why: "Links need readable slugs.", path: pathB, acceptance: [LINE_1, LINE_2] });
    const ob = await propose(b, intentB, pathB, textB, "Add slugify: lowercase", false);
    info(`B ${ob.id}: ${ob.status}; ${short(ob.gate, 160)}; acceptance: ${short(ob.detail, 300)}`);
    const unmet = /(?:^|; )line 2 (?:not met|unclear)/.test(ob.detail ?? "");
    check(
      `B, which meets only line 1, comes back or goes to a person naming line 2 (${ob.status}: ${short(ob.reason, 240)})`,
      (ob.status === "returned" || ob.status === "escalated") && (ob.reason.includes(LINE_2) || (unmet && /hyphen|space/i.test(ob.reason))),
    );

    // The platform's rule, strictly: every line counted met quotes a line of the change, and nothing landed on a second
    // opinion with a line of its intent not met.
    const outcomes: Array<[string, Outcome, Record<string, string>]> = [
      ["A", oa, { [pathA]: textA }],
      ["B", ob, { [pathB]: textB }],
    ];

    // C: keep lines. A later intent changes A's file and drops the hyphens A's second line asks for.
    if (KEEP && oa.status === "landed") {
      const c = await mcpAgent(`acceptance-${tag}-c`);
      agents.push(c);
      const textC = "export function slugify(text: string): string {\n  const lower = text.trim().toLowerCase();\n  return lower;\n}\n";
      const intentC = await intentFor(c.id, { title: `Trim slugify input (${tag})`, why: "Slugs should not start or end with spaces.", path: pathA, acceptance: ["slugify trims spaces at both ends of its input"], source: "agent" });
      const oc = await propose(c, intentC, pathA, textC, "Trim slugify input", true);
      info(`C ${oc.id}: ${oc.status}; ${short(oc.gate, 160)}; acceptance: ${short(oc.detail, 300)}`);
      check(`C was asked A's two lines as keep lines from A's landing (${short(oc.detail, 200)})`, /keep line 1 /.test(oc.detail ?? "") && /keep line 2 /.test(oc.detail ?? ""));
      info(`C ${oc.status === "landed" ? "landed: the second opinion did not answer keep line 2 not met" : `${oc.status}: ${short(oc.reason, 300)}`}`);
      outcomes.push(["C", oc, { [pathA]: textC }]);
    }

    for (const [name, o, files] of outcomes) {
      const held = quotesHold(o, files);
      check(`${name}: ${held.why}`, held.ok);
      if (o.status === "landed" && /L3 innate\+llm/.test(o.gate ?? "")) {
        const lines = (o.detail ?? "").split("; ").filter((s) => /^line \d+ /.test(s));
        check(`${name} landed on the second opinion with every line of its intent met (${short(lines.join("; "), 200)})`, lines.length > 0 && lines.every((s) => /^line \d+ met: /.test(s)));
      }
    }
  } finally {
    for (const x of agents) await x.close().catch(() => undefined);
  }

  console.log(failed ? "SOME CHECKS FAILED" : "ALL CHECKS PASSED");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(`acceptance check failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
