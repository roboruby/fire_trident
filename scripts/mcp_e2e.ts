#!/usr/bin/env node
/**
 * End-to-end check of the FireTrident MCP server with a real MCP client and real git.
 *
 * It plays an external agent the way any MCP-capable coding agent would:
 *   setup (REST)  create a small colony from a public repo and add a forbid-pattern rule, so there are intents
 *   join          register as an external agent over MCP (Streamable HTTP at /mcp)
 *   sense         read the field where the work is
 *   take          self-assign an intent and receive a workspace lease
 *   checkout      ask for the lease again (must match take)
 *   git clone     trunk with the read token, at the lease base, into a scratch directory
 *   read          every footprint file through MCP (records the read set; blob ids checked against git)
 *   edit          apply the rule's replacement
 *   git push      commit and force-push to the workspace with the write token
 *   propose       hand over the head commit; the server computes the write set
 *   inbox         long-poll (wait) until the proposal lands (or is returned, rejected or escalated)
 *   why           the lineage of the changed file
 *   git           fetch trunk again and show the FT-* trailers and the lineage note
 *   take+release  take a second intent and give it back (it must reopen)
 *   declare       add a follow-up intent
 *
 * Usage:
 *   node scripts/mcp_e2e.ts --url https://<your deployment> [--colony m1-e2e-<stamp>]
 *     [--repo https://github.com/sindresorhus/is-plain-obj] [--branch main] [--scratch DIR]
 *     [--reuse] [--timeout 300] [--no-extras] [--human] [--json out.json]
 *
 * --human posts one human intent instead of the rule (document isPlainObject in index.js). Its change is not a
 * rule replacement, so no deterministic proof applies and review goes through the reflex and LLM layers.
 *
 * FT_MCP_TOKEN (sent as a Bearer header to /mcp) and FT_ADMIN_TOKEN (REST setup) are read from the
 * environment when the server needs them. Tokens are never printed: anything that looks like one is
 * redacted from every line of output.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXPECTED_TOOLS = ["checkout", "declare", "inbox", "join", "propose", "read", "release", "sense", "take", "why"];
const FINAL = new Set(["landed", "returned", "rejected"]);

/** The demo rule: three intents on is-plain-obj (index.js, test.js, benchmark.js), each a small mechanical fix. */
const DEMO_RULE = {
  kind: "forbid-pattern",
  spec: {
    pattern: "'([^']*)'",
    include: ["*.js"],
    hint: "Write string literals with double quotes: 'x' becomes \"x\". Change nothing else.",
    replacement: '"$1"',
  },
  description: "JavaScript strings use double quotes",
};

/** The --human intent: a change review cannot prove mechanically. */
const HUMAN_INTENT = {
  title: "Document isPlainObject in index.js",
  why: "index.js exports isPlainObject without a doc comment, while index.d.ts has one. Add a short JSDoc block directly above the export that says what counts as a plain object.",
  footprint: ["index.js"],
  acceptance: ["A JSDoc block directly above the export in index.js says a plain object is created by {}, new Object() or Object.create(null)", "No code changes"],
  priority: 5,
  source: "human",
  createdBy: "mcp-e2e",
};
const DOC_BLOCK = "/**\nCheck if a value is a plain object: one created by `{}`, `new Object()` or `Object.create(null)`, in any realm.\n*/\n";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? "true" : v;
}

function stamp(): string {
  return new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

const URL_BASE = (arg("url", process.env.FT_URL) ?? "").replace(/\/+$/, "");
if (!URL_BASE) {
  console.error("Pass --url https://<your deployment> or set FT_URL.");
  process.exit(2);
}
const HUMAN = arg("human") === "true";
const COLONY = arg("colony", `${HUMAN ? "m1-rev" : "m1-e2e"}-${stamp()}`) ?? "";
const REPO = arg("repo", "https://github.com/sindresorhus/is-plain-obj") ?? "";
const BRANCH = arg("branch", "main") ?? "main";
const SCRATCH = arg("scratch", join(tmpdir(), "ft-mcp-e2e")) ?? "";
const REUSE = arg("reuse") === "true";
const TIMEOUT_S = Number(arg("timeout", "300"));
const EXTRAS = arg("no-extras") !== "true";
const JSON_OUT = arg("json");
const MCP_TOKEN = process.env.FT_MCP_TOKEN ?? "";
const ADMIN_TOKEN = process.env.FT_ADMIN_TOKEN ?? "";

/** Secrets seen during the run, redacted from all output. */
const secrets = new Set<string>([MCP_TOKEN, ADMIN_TOKEN].filter((s) => s.length >= 8));

function redact(text: string): string {
  let out = text.replace(/art_v\d+_[A-Za-z0-9._~+/=-]+/g, "<redacted>");
  for (const s of secrets) out = out.split(s).join("<redacted>");
  return out;
}

const T0 = Date.now();
const timings: Array<{ step: string; ms: number }> = [];

function say(line: string): void {
  process.stdout.write(`${redact(`[${((Date.now() - T0) / 1000).toFixed(1).padStart(6)}s] ${line}`)}\n`);
}

async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const t = Date.now();
  try {
    return await fn();
  } finally {
    timings.push({ step: name, ms: Date.now() - t });
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- REST (setup only) ------------------------------------------------------

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (ADMIN_TOKEN) headers.authorization = `Bearer ${ADMIN_TOKEN}`;
  const res = await fetch(`${URL_BASE}/api${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text.slice(0, 300) };
  }
  return { status: res.status, data };
}

async function apiOk(method: string, path: string, body?: unknown): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const r = await api(method, path, body);
    if (r.status >= 200 && r.status < 300) return r.data;
    // A fresh preview answers its first requests with transient 500s/503s while objects start.
    if ((r.status >= 500 || r.status === 429) && attempt < 3) {
      await sleep(2_000 * (attempt + 1));
      continue;
    }
    throw new Error(`${method} ${path} -> ${r.status}: ${redact(JSON.stringify(r.data)).slice(0, 400)}`);
  }
}

// --- git ----------------------------------------------------------------------

function git(cwd: string, args: string[], token?: string): string {
  const full = [...(token ? ["-c", `http.extraHeader=Authorization: Bearer ${token}`] : []), "-c", "protocol.version=2", ...args];
  try {
    return execFileSync("git", full, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    throw new Error(`git ${args[0]} failed: ${redact(String(err.stderr || err.message)).slice(0, 400)}`);
  }
}

// --- MCP ----------------------------------------------------------------------

type ToolOut = { ok: boolean; data: any; text: string; ms: number };

async function main(): Promise<void> {
  say(`FireTrident MCP end-to-end against ${URL_BASE}, colony ${COLONY}`);

  // 1. Setup (REST): colony + rule, so the colony has open intents.
  if (!REUSE) {
    const created = await step("setup: import colony", () => apiOk("POST", "/colonies", { name: COLONY, source: { url: REPO, branch: BRANCH }, poolTarget: 2 }));
    say(`colony ${created.id} imported from ${REPO}: trunk ${String(created.trunkSha).slice(0, 10)}`);
    if (HUMAN) {
      const i = await step("setup: add intent", () => apiOk("POST", `/colonies/${COLONY}/intents`, HUMAN_INTENT));
      say(`intent ${i.id}: "${i.title}" (human, footprint ${i.footprint.join(", ")})`);
    } else {
      const rule = await step("setup: add rule", () => apiOk("POST", `/colonies/${COLONY}/rules`, { ...DEMO_RULE, approvedBy: "mcp-e2e" }));
      say(`rule ${rule.rule?.id}: "${DEMO_RULE.description}" -> ${rule.violations} violations, ${rule.intents} intents`);
    }
  }

  // 2. Connect over Streamable HTTP.
  const transport = new StreamableHTTPClientTransport(new URL(`${URL_BASE}/mcp`), {
    ...(MCP_TOKEN ? { requestInit: { headers: { Authorization: `Bearer ${MCP_TOKEN}` } } } : {}),
  });
  const client = new Client({ name: "firetrident-mcp-e2e", version: "0.0.1" });
  await step("mcp: connect", () => client.connect(transport));
  say(`connected: server ${client.getServerVersion()?.name} ${client.getServerVersion()?.version}, session ${transport.sessionId?.slice(0, 12)}…, instructions ${client.getInstructions()?.length ?? 0} chars`);
  const tools = await step("mcp: list tools", () => client.listTools());
  const names = tools.tools.map((t) => t.name).sort();
  say(`tools: ${names.join(", ")}`);
  const missing = EXPECTED_TOOLS.filter((n) => !names.includes(n));
  if (missing.length > 0) throw new Error(`missing tools: ${missing.join(", ")}`);

  const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolOut> => {
    const t = Date.now();
    const res = await client.callTool({ name, arguments: args });
    const ms = Date.now() - t;
    timings.push({ step: `mcp: ${name}`, ms });
    const content = (res.content as Array<{ type: string; text?: string }> | undefined) ?? [];
    const text = content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
    let data: any = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    return { ok: res.isError !== true, data, text, ms };
  };
  const must = async (name: string, args: Record<string, unknown> = {}): Promise<any> => {
    const r = await call(name, args);
    if (!r.ok) throw new Error(`${name} failed: ${redact(r.text).slice(0, 500)}`);
    return r.data;
  };

  // 3. join
  const joined = await must("join", { colony: COLONY, name: "mcp-e2e", model: HUMAN ? "scripted (doc comment)" : "scripted (rule replacement)" });
  say(`join: agent ${joined.agentId} (resumed ${joined.resumed}), trunk ${String(joined.colony?.trunkSha).slice(0, 10)}, regionDepth ${joined.colony?.regionDepth}`);

  // 4. sense (the root region, before holding anything)
  const field = await must("sense", { regions: ["."] });
  for (const r of field.readings ?? []) {
    say(`sense ${r.region}: ${r.error ? `error ${r.error}` : `need ${r.totals?.need} claim ${r.totals?.claim} trail ${r.totals?.trail}, agents ${(r.agents ?? []).length}, admission ${r.admission?.open ? "open" : "closed"}`}`);
  }

  // 5. take (wait hints are honored)
  let took: any = null;
  const takeDeadline = Date.now() + 120_000;
  while (Date.now() < takeDeadline) {
    const t = await must("take");
    if (!t.wait) {
      took = t;
      break;
    }
    say(`take: wait ${t.retryInMs} ms (${t.reason})`);
    await sleep(Math.min(Math.max(Number(t.retryInMs) || 2_000, 500), 10_000));
  }
  if (!took) throw new Error("take never returned work within 120 s");
  secrets.add(String(took.tokens?.trunkRead ?? ""));
  secrets.add(String(took.tokens?.workspaceWrite ?? ""));
  const intent = took.intent;
  const lease = took.lease;
  say(`take: intent ${intent.id} "${intent.title}" footprint ${intent.footprint.join(", ")}`);
  say(`      base ${lease.baseSha.slice(0, 10)}, workspace ${lease.workspace.namespace}/${lease.workspace.name}, token expires ${lease.tokenExpiresAt}, rule ${took.rule?.id ?? "none"}`);

  // 6. sense again: our own claim is in the field now.
  const mine = await must("sense");
  for (const r of mine.readings ?? []) say(`sense (footprint) ${r.region}: claim ${r.totals?.claim}, need ${r.totals?.need}, agents ${(r.agents ?? []).map((a: any) => a.agentId).join(", ") || "none"}`);

  // 7. checkout must repeat the lease
  const co = await must("checkout");
  if (co.lease?.baseSha !== lease.baseSha || co.intent?.id !== intent.id || co.tokens?.workspaceWrite !== took.tokens?.workspaceWrite) throw new Error("checkout does not match take");
  say(`checkout: same intent and lease (${co.git?.length ?? 0} git instructions)`);

  // 8. clone trunk at the base with real git
  const dir = join(SCRATCH, `${COLONY}-${intent.id.slice(-8)}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(SCRATCH, { recursive: true });
  await step("git: clone trunk", async () => git(SCRATCH, ["clone", "--quiet", lease.trunk.remote, dir], took.tokens.trunkRead));
  git(dir, ["checkout", "--quiet", "-B", "ft-work", lease.baseSha]);
  say(`git clone: ${dir} at ${git(dir, ["rev-parse", "--short", "HEAD"])}`);

  // 9. read every footprint file through MCP; the blob ids must agree with git
  for (const p of intent.footprint as string[]) {
    const r = await must("read", { path: p });
    const local = git(dir, ["rev-parse", `${lease.baseSha}:${p}`]);
    if (r.blob !== local) throw new Error(`read ${p}: blob ${r.blob} but git says ${local}`);
    say(`read ${p}: blob ${String(r.blob).slice(0, 10)} (${r.size} bytes) matches git, recorded ${r.recorded}`);
  }

  // 10. edit: the rule's replacement, or the doc comment the human intent asks for
  const rule = took.rule as { pattern?: string; flags?: string; replacement?: string } | null;
  const edit: (text: string) => string =
    rule?.pattern && rule.replacement !== undefined
      ? (text) => text.replace(new RegExp(rule.pattern ?? "", `${(rule.flags ?? "").replace(/g/g, "")}g`), rule.replacement ?? "")
      : intent.title === HUMAN_INTENT.title
        ? (text) => text.replace(/^export default function isPlainObject/m, `${DOC_BLOCK}export default function isPlainObject`)
        : () => {
            throw new Error(`no scripted edit for intent "${intent.title}"`);
          };
  let changed = 0;
  for (const p of intent.footprint as string[]) {
    const file = join(dir, p);
    const before = readFileSync(file, "utf8");
    const after = edit(before);
    if (after !== before) {
      writeFileSync(file, after);
      changed++;
    }
  }
  if (changed === 0) throw new Error("the replacement changed nothing");
  say(`edit: ${changed} file(s) changed\n${git(dir, ["diff", "--stat"])}`);

  // 11. commit and push to the workspace
  git(dir, ["-c", "user.name=FireTrident MCP e2e", "-c", "user.email=mcp-e2e@agents.firetrident.dev", "commit", "--quiet", "-am", intent.title, "-m", `FT-Intent: ${intent.id}`]);
  const head = git(dir, ["rev-parse", "HEAD"]);
  await step("git: push workspace", async () => git(dir, ["push", "--quiet", "--force", lease.workspace.remote, "HEAD:refs/heads/main"], took.tokens.workspaceWrite));
  say(`git push: ${head.slice(0, 10)} -> ${lease.workspace.name} main`);

  // 12. propose
  const proposeAt = Date.now();
  const prop = await must("propose", {
    headSha: head,
    summary: HUMAN ? "Add a JSDoc block above isPlainObject in index.js" : `Apply the rule's replacement in ${intent.footprint.join(", ")}`,
    notVerified: HUMAN
      ? "Not verified: the package's tests and linters were not run; the change only adds a comment."
      : "Not verified: the package's tests and linters were not run; the change only swaps quote characters.",
  });
  say(`propose: ${prop.proposal.id} ${prop.proposal.status}; write set ${prop.writeSet.map((w: any) => `${w.path}@${String(w.blob).slice(0, 8)}`).join(", ")}; read set ${prop.readSet}; residual ${JSON.stringify(prop.proposal.residual)}`);

  // 13. inbox: the server waits (long poll) until the proposal is decided
  let final: any = null;
  let lastStatus = prop.proposal.status;
  while (Date.now() - proposeAt < TIMEOUT_S * 1000) {
    const box = await must("inbox", { proposalId: prop.proposal.id, wait: 30, limit: 5 });
    const w = box.watching;
    if (w.status !== lastStatus) {
      say(`inbox (waited ${(w.waitedMs / 1000).toFixed(1)} s): ${w.id} ${lastStatus} -> ${w.status}${w.reason ? ` (${w.reason})` : ""}`);
      lastStatus = w.status;
    }
    if (FINAL.has(w.status)) {
      final = w;
      break;
    }
    if (w.status === "escalated") throw new Error(`proposal ${w.id} escalated to a human: ${w.reason}`);
  }
  timings.push({ step: "propose -> final", ms: Date.now() - proposeAt });
  if (!final) throw new Error(`proposal ${prop.proposal.id} still ${lastStatus} after ${TIMEOUT_S} s`);
  if (final.status !== "landed") throw new Error(`proposal ${final.id} ended ${final.status}: ${final.reason}`);
  say(`landed: ${final.landingId} ${((Date.now() - proposeAt) / 1000).toFixed(1)} s after propose`);

  // 14. why: the lineage of the changed file
  const path0 = (prop.writeSet[0]?.path ?? intent.footprint[0]) as string;
  const why = await must("why", { path: path0 });
  const entry = (why.entries ?? []).find((e: any) => e.landing?.id === final.landingId) ?? why.entries?.[0];
  if (!entry) throw new Error(`why ${path0}: no lineage entries`);
  const np = (entry.note?.proposals ?? []).find((x: any) => x.id === prop.proposal.id) ?? entry.note?.proposals?.[0];
  say(`why ${path0}: landing ${entry.landing.id} trunk ${String(entry.landing.trunkSha).slice(0, 10)} (parent ${String(entry.landing.parentSha).slice(0, 10)}), ${entry.landing.proposalIds.length} proposal(s) in the batch`);
  if (np) {
    say(`    intent ${np.intent?.id} "${np.intent?.title}" rule ${np.intent?.ruleId ?? "-"}; agent ${np.agentId} (${np.agentKind}, ${np.model ?? "no model"})`);
    say(`    writeSet ${np.writeSet.map((w: any) => w.path).join(", ")}; readSet ${np.readSet.map((r: any) => r.path).join(", ")}`);
    say(`    decisions ${(np.decisions ?? []).map((d: any) => `${d.layer}:${d.action}`).join(", ") || "none"}; checks ${(np.evidence?.checks ?? []).map((c: any) => `${c.name}=${c.ok ? "ok" : "no"}`).join(", ")}`);
  }
  if (np?.agentId !== joined.agentId || np?.agentKind !== "external") throw new Error("lineage does not name this external agent");

  // 15. the same lineage from plain git: trailers on the landed commit and the note
  const verify = join(SCRATCH, `${COLONY}-verify`);
  rmSync(verify, { recursive: true, force: true });
  await step("git: fetch trunk + notes", async () => {
    git(SCRATCH, ["clone", "--quiet", lease.trunk.remote, verify], took.tokens.trunkRead);
    git(verify, ["fetch", "--quiet", "origin", "refs/notes/firetrident:refs/notes/firetrident"], took.tokens.trunkRead);
  });
  const landedSha = entry.landing.trunkSha as string;
  const trailers = git(verify, ["log", "-1", "--format=%(trailers)", landedSha]).split("\n").filter(Boolean);
  const note = git(verify, ["notes", "--ref", "firetrident", "show", landedSha]);
  let noteJson: any = null;
  try {
    noteJson = JSON.parse(note);
  } catch {
    noteJson = null;
  }
  say(`git: ${landedSha.slice(0, 10)} trailers: ${trailers.join(" | ")}`);
  say(`git: note ${noteJson?.schema} landing ${noteJson?.landingId}, ${noteJson?.proposals?.length ?? 0} proposal(s)`);

  if (EXTRAS) {
    // 16. take a second intent and give it back: it must reopen for others
    const second = await must("take", { wait: 10 });
    if (second.wait) {
      say(`take (second): ${second.reason}`);
    } else {
      secrets.add(String(second.tokens?.trunkRead ?? ""));
      secrets.add(String(second.tokens?.workspaceWrite ?? ""));
      const rel = await must("release", { reason: "mcp e2e: checking that released work reopens" });
      const snap = await apiOk("GET", `/colonies/${COLONY}`);
      const state = (snap.intents ?? []).find((i: any) => i.id === second.intent.id)?.status;
      say(`release: ${rel.released?.intentId} "${rel.released?.title}" -> intent is ${state}`);
      if (state !== "open") throw new Error(`released intent ${second.intent.id} is ${state}, expected open`);
    }

    // 17. declare a follow-up
    const d = await must("declare", {
      title: "Use double quotes in the TypeScript declarations too",
      why: "Follow-up from the MCP end-to-end run: the rule only covers *.js; index.d.ts and index.test-d.ts still use single quotes.",
      footprint: ["index.d.ts", "index.test-d.ts"],
      priority: 0,
    });
    say(`declare: ${d.intent.id} "${d.intent.title}" ${d.intent.status}`);
  }

  await client.close();
  const total = Date.now() - T0;
  say(`DONE in ${(total / 1000).toFixed(1)} s`);
  const summary = {
    url: URL_BASE,
    colony: COLONY,
    agentId: joined.agentId,
    intent: { id: intent.id, title: intent.title, footprint: intent.footprint },
    proposal: prop.proposal.id,
    landingId: final.landingId,
    trunkSha: landedSha,
    trailers,
    timings,
    totalMs: total,
  };
  for (const t of timings) say(`  ${t.step.padEnd(28)} ${String(t.ms).padStart(6)} ms`);
  if (JSON_OUT) writeFileSync(JSON_OUT, `${redact(JSON.stringify(summary, null, 2))}\n`);
}

main().catch((e) => {
  say(`FAILED: ${e instanceof Error ? e.message : String(e)}`);
  for (const t of timings) say(`  ${t.step.padEnd(28)} ${String(t.ms).padStart(6)} ms`);
  process.exit(1);
});
