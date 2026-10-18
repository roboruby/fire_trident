#!/usr/bin/env node
/**
 * Evidence for published results: read-only summaries of colonies on a live deployment, and
 * redacted copies of run logs and agent transcripts.
 *
 *   node packages/bench/src/evidence.ts colony hono --why src/index.ts:17 --out results/2026-10-12-prod/colony-hono.json
 *   node packages/bench/src/evidence.ts get /colonies/openspec-w1/vaccinate --out results/2026-10-12-prod/vaccination-openspec-w1.json
 *   node packages/bench/src/evidence.ts redact <run.log> <out.log>
 *   node packages/bench/src/evidence.ts transcript <stream.jsonl> <out.jsonl>
 *
 * The service only ever receives GET requests, and they carry no token (FT_URL comes from the
 * environment or ~/.config/firetrident/env). Everything written passes through redactEvidence.
 */
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { liveConfig } from "./env.ts";

/** The repository root, so local paths inside it are written relative to it. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Options for redactEvidence. */
export interface RedactOptions {
  /** Absolute repository root: paths under it become relative. */
  repoRoot?: string;
}

/**
 * Redact what must not be published: Artifacts tokens, bearer and API tokens (headers, query
 * strings, KEY=value pairs, JSON token fields), the account id in Artifacts hostnames (also when
 * truncated), email addresses, and absolute local paths (repository paths become relative, temp
 * directories and home directories become placeholders). Placeholders such as `<redacted>` and
 * `Bearer <trunkRead>` are kept.
 */
export function redactEvidence(text: string, opts: RedactOptions = {}): string {
  let s = text;
  s = s.replace(/art_v\d+_[A-Za-z0-9._~+/=-]+/g, "<redacted>");
  s = s.replace(/\b(?:sk-|gh[pousr]_)[A-Za-z0-9_-]{16,}/g, "<redacted>");
  s = s.replace(/(Bearer\s+)(?!<)[A-Za-z0-9._~+/=-]+/gi, "$1<redacted>");
  s = s.replace(/([?&](?:token|access_token|api_key|apikey|key)=)(?!<)[^&\s"'<>]+/gi, "$1<redacted>");
  s = s.replace(/\b((?:[A-Z][A-Z0-9_]*_)?(?:TOKEN|API_KEY|SECRET|PASSWORD)\s*[=:]\s*["']?)(?![<"'\s])[^\s"'&]+/g, "$1<redacted>");
  s = s.replace(/("(?:token|trunkRead|workspaceWrite|readToken|writeToken|apiKey|api_key|secret|password|authorization)"\s*:\s*")(?!<)[^"]+"/gi, '$1<redacted>"');
  s = s.replace(/\b[0-9a-f]{32}(?=\.artifacts\.cloudflare\.net)/g, "ACCOUNT_ID");
  s = s.replace(/(https?:\/\/)[0-9a-f]{6,31}(?=…|\.\.\.)/g, "$1ACCOUNT_ID");
  s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, "<email>");
  const root = opts.repoRoot?.replace(/\/+$/, "");
  if (root) {
    s = s.split(`${root}/`).join("");
    s = s.split(root).join(".");
  }
  s = s.replace(/(?:\/private)?\/var\/folders\/[^/\s"'`]+\/[^/\s"'`]+\/T\/+/g, () => "$TMPDIR/");
  s = s.replace(/(?:\/private)?\/tmp\/claude-\d+\/[^/\s"'`]+\/[^/\s"'`]+\/scratchpad\b/g, "<scratch>");
  s = s.replace(/\/private\/tmp\//g, "<tmp>/");
  s = s.replace(/\/Users\/[^/\s"'`]+/g, "~");
  return s;
}

/** redactEvidence applied to every string in a JSON value (keys included). */
export function redactDeep<T>(value: T, opts: RedactOptions = {}): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return redactEvidence(v, opts);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [redactEvidence(k, opts), walk(x)]));
    return v;
  };
  return walk(value) as T;
}

/** One entry of a trimmed agent transcript. */
export type TranscriptEntry =
  | { type: "note"; text: string }
  | { type: "session"; model?: string; version?: string; permissionMode?: string; mcpServers?: Array<{ name: string; status: string }>; mcpTools?: string[] }
  | { type: "tool_use"; at?: string; name: string; input: unknown }
  | { type: "tool_result"; at?: string; name: string; isError: boolean; content: string }
  | { type: "text"; at?: string; text: string }
  | { type: "permission_denied"; tool?: string; reason?: string }
  | { type: "result"; subtype?: string; isError?: boolean; turns?: number; durationMs?: number; costUsd?: number; result?: string };

type Block = { type?: string; id?: string; name?: string; input?: unknown; text?: string; tool_use_id?: string; is_error?: boolean; content?: unknown; tool_name?: string };
type StreamLine = {
  type?: string;
  subtype?: string;
  timestamp?: string;
  message?: { content?: unknown };
  model?: string;
  claude_code_version?: string;
  permissionMode?: string;
  mcp_servers?: Array<{ name?: string; status?: string }>;
  tools?: string[];
  tool_name?: string;
  decision_reason?: string;
  num_turns?: number;
  duration_ms?: number;
  total_cost_usd?: number;
  is_error?: boolean;
  result?: string;
};

/** Flatten a tool result's content (a string, or text and tool-reference blocks) to text. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content === undefined ? "" : JSON.stringify(content);
  return (content as Block[])
    .map((b) => (b.type === "text" ? (b.text ?? "") : b.type === "tool_reference" ? `tool: ${b.tool_name ?? ""}` : JSON.stringify(b)))
    .join("\n");
}

/** Close the JSON strings a capture-time `art_v…\S+` redaction swallowed, so a redacted JSON tool result parses again. */
export function repairRedactedJson(text: string): string {
  return text.replace(/"<redacted>(\s+)"/g, '"<redacted>",\n$1"').replace(/"<redacted>(\s+)\}/g, '"<redacted>"\n$1}');
}

/**
 * Trim a headless agent's stream-json transcript to what shows the work: the session's model and
 * MCP tools, every tool call with its input, every tool result (named after its call), the agent's
 * text, permission denials and the final result. Thinking, rate-limit and token-count events, ids,
 * usage and the client's local configuration are dropped. Unparseable lines are skipped.
 */
export function trimTranscript(lines: string[]): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  const names = new Map<string, string>();
  for (const raw of lines) {
    if (!raw.trim()) continue;
    let o: StreamLine;
    try {
      o = JSON.parse(raw) as StreamLine;
    } catch {
      continue;
    }
    if (o.type === "system" && o.subtype === "init") {
      out.push({
        type: "session",
        ...(o.model ? { model: o.model } : {}),
        ...(o.claude_code_version ? { version: o.claude_code_version } : {}),
        ...(o.permissionMode ? { permissionMode: o.permissionMode } : {}),
        mcpServers: (o.mcp_servers ?? []).map((m) => ({ name: m.name ?? "", status: m.status ?? "" })),
        mcpTools: (o.tools ?? []).filter((t) => t.startsWith("mcp__")),
      });
    } else if (o.type === "system" && o.subtype === "permission_denied") {
      out.push({ type: "permission_denied", ...(o.tool_name ? { tool: o.tool_name } : {}), ...(o.decision_reason ? { reason: o.decision_reason } : {}) });
    } else if (o.type === "assistant" || o.type === "user") {
      const content = o.message?.content;
      const blocks = Array.isArray(content) ? (content as Block[]) : [];
      const at = o.timestamp ? { at: o.timestamp } : {};
      for (const b of blocks) {
        if (b.type === "tool_use") {
          names.set(b.id ?? "", b.name ?? "");
          out.push({ type: "tool_use", ...at, name: b.name ?? "", input: b.input ?? null });
        } else if (b.type === "tool_result") {
          out.push({ type: "tool_result", ...at, name: names.get(b.tool_use_id ?? "") ?? "", isError: b.is_error === true, content: repairRedactedJson(resultText(b.content)) });
        } else if (b.type === "text" && o.type === "assistant") {
          out.push({ type: "text", ...at, text: b.text ?? "" });
        }
      }
    } else if (o.type === "result") {
      out.push({
        type: "result",
        ...(o.subtype ? { subtype: o.subtype } : {}),
        ...(o.is_error !== undefined ? { isError: o.is_error } : {}),
        ...(o.num_turns !== undefined ? { turns: o.num_turns } : {}),
        ...(o.duration_ms !== undefined ? { durationMs: o.duration_ms } : {}),
        ...(o.total_cost_usd !== undefined ? { costUsd: o.total_cost_usd } : {}),
        ...(o.result !== undefined ? { result: o.result } : {}),
      });
    }
  }
  return out;
}

/** What one colony's read-only endpoints returned. */
export interface ColonyReads {
  /** Service base URL. */
  base: string;
  colony: string;
  fetchedAt: string;
  /** The requests made, as "GET /api/...". */
  reads: string[];
  snapshot: unknown;
  metrics: unknown;
  agents: unknown;
  immune: unknown;
  review: unknown;
  vaccination: unknown;
  /** Lineage of one path (or line), when asked for. */
  why?: { target: string; entries: unknown };
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const numOr = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const iso = (v: unknown): string | undefined => (typeof v === "number" && Number.isFinite(v) ? new Date(v).toISOString() : undefined);

/** Count values of one field over a list. */
function tally(list: unknown[], key: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of list) {
    const k = String(obj(x)[key] ?? "unknown");
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

/**
 * Summarize a colony from its read-only endpoints: source and trunk, rules, intents, proposals,
 * landings (the snapshot's most recent ones; the API lists no more), violations, the decide arc
 * (funnel, decisions by layer, antibodies, review queue, vaccination meter), agents by kind,
 * state and model, and optionally the lineage of one line. Pure: no I/O.
 */
export function summarizeColony(r: ColonyReads): Obj {
  const snap = obj(r.snapshot);
  const colony = obj(snap.colony);
  const trunk = obj(colony.trunk);
  const metrics = obj(obj(r.metrics).metrics);
  const counters = Object.keys(metrics).length ? metrics : obj(snap.metrics);
  const n = (k: string) => numOr(counters[k]);
  const intents = arr(snap.intents);
  const landings = arr(snap.recentLandings);
  const immune = obj(r.immune);
  const vac = obj(r.vaccination);
  const agentList = arr(obj(r.agents).agents);
  const rules = arr(snap.rules).map((x) => {
    const rule = obj(x);
    const byRule = obj(obj(snap.violations).byRule);
    return {
      id: rule.id,
      kind: rule.kind,
      description: rule.description,
      approvedBy: rule.approvedBy,
      createdAt: iso(rule.createdAt),
      ...(rule.retractedAt ? { retractedAt: iso(rule.retractedAt) } : {}),
      violationsNow: numOr(byRule[String(rule.id)]) ?? null,
    };
  });
  const vacClass = (v: unknown) => {
    const c = obj(v);
    return { n: c.n, caught: c.caught, escalated: c.escalated, returned: c.returned, missed: c.missed, pending: c.pending, errors: c.errors, recall: c.recall, wilson95: [c.lo, c.hi], byLayer: c.byLayer };
  };
  const vacOverall = obj(vac.overall);
  return {
    kind: "colony-summary",
    note: "Read-only GETs against the live API, summarized by packages/bench/src/evidence.ts; tokens, the account id, emails and local paths redacted.",
    colony: r.colony,
    map: `${r.base}/c/${r.colony}`,
    api: `${r.base}/api/colonies/${r.colony}`,
    fetchedAt: r.fetchedAt,
    reads: r.reads,
    source: colony.source ?? null,
    createdAt: iso(colony.createdAt),
    regionDepth: colony.regionDepth,
    trunk: { repo: [str(trunk.namespace), str(trunk.name)].filter(Boolean).join("/"), remote: trunk.remote, sha: colony.trunkSha, files: arr(snap.files).length },
    counters,
    rules,
    intents: {
      total: n("intents"),
      landed: n("intentsLanded"),
      open: n("intentsOpen"),
      claimed: n("intentsClaimed"),
      proposed: n("intentsProposed"),
      abandoned: n("intentsAbandoned"),
      listed: intents.length,
      ...(intents.length < (n("intents") ?? 0) ? { listedNote: `the snapshot lists ${intents.length} of ${n("intents")} intents` } : {}),
      listedByStatus: tally(intents, "status"),
      listedBySource: tally(intents, "source"),
      notFromRules: intents
        .map(obj)
        .filter((i) => i.source !== "rule")
        .slice(0, 20)
        .map((i) => ({ id: i.id, title: i.title, source: i.source, status: i.status, createdBy: i.createdBy, createdAt: iso(i.createdAt) })),
    },
    proposals: { total: n("proposals"), landed: n("landedProposals"), alreadyOnTrunk: n("alreadyOnTrunk"), returned: n("returned"), rejected: n("rejected"), escalated: n("escalated"), inFlight: n("proposalsInFlight"), reviewQueue: n("reviewQueue") },
    landings: {
      total: n("landings"),
      note: "recent lists the snapshot's most recent landings (the API returns 20); every landing is a trunk commit with FT-* trailers and a note under refs/notes/firetrident",
      recent: landings.map((x) => {
        const l = obj(x);
        return { id: l.id, at: iso(l.at), trunkSha: l.trunkSha, parentSha: l.parentSha, proposals: arr(l.proposalIds).length, intents: arr(l.intentIds).length, paths: l.paths };
      }),
    },
    violations: snap.violations ?? null,
    decide: {
      funnel: obj(r.metrics).funnel ?? snap.funnel ?? null,
      decisions: immune.decisions ?? null,
      counters: Object.fromEntries(Object.entries(counters).filter(([k]) => /^(decide|funnel|alerts|antibodies|autonomy)\./.test(k))),
      policy: immune.policy ?? null,
      antibodies: arr(immune.antibodies).map((x) => {
        const a = obj(x);
        return { id: a.id, origin: a.origin, state: a.state, question: a.question, threshold: a.threshold, hits: a.hits, falsePositives: a.falsePositives, path: a.path, landingId: a.landingId, createdAt: iso(a.createdAt) };
      }),
      detectors: immune.detectors ?? null,
      autonomyEarnedRegions: arr(immune.autonomy).filter((a) => obj(a).earned === true).length,
      reviewQueue: arr(r.review).map((x) => {
        const p = obj(x);
        const gate = arr(obj(p.evidence).checks)
          .map(obj)
          .find((c) => c.name === "gate");
        return { id: p.id, intentId: p.intentId, agentId: p.agentId, status: p.status, writeSet: arr(p.writeSet).map((w) => obj(w).path), gate: gate?.detail ?? null };
      }),
      vaccination: numOr(vacOverall.n)
        ? {
            overall: vacClass(vacOverall),
            classes: Object.fromEntries(Object.entries(obj(vac.classes)).map(([k, v]) => [k, { label: obj(v).label, ...vacClass(v) }])),
          }
        : { n: 0, note: "no vaccination batch on this colony" },
    },
    agents: { total: agentList.length, byKind: tally(agentList, "kind"), byState: tally(agentList, "state"), byModel: tally(agentList, "model") },
    ...(r.why ? { lineage: { target: r.why.target, entries: r.why.entries } } : {}),
  };
}

/** GET one API path (no token) and parse it; throws on a non-2xx answer. */
async function getJson(base: string, path: string): Promise<unknown> {
  const res = await fetch(`${base}/api${path}`, { headers: { accept: "application/json", "user-agent": "ft-bench-evidence/0.0.1" }, signal: AbortSignal.timeout(120_000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`GET /api${path} -> ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text) as unknown;
}

/** Fetch everything summarizeColony needs, with GET requests only. */
export async function readColony(base: string, colony: string, why?: string): Promise<ColonyReads> {
  const c = encodeURIComponent(colony);
  const paths = {
    snapshot: `/colonies/${c}`,
    metrics: `/colonies/${c}/metrics`,
    agents: `/colonies/${c}/agents?all=1&journal=0`,
    immune: `/colonies/${c}/immune`,
    review: `/colonies/${c}/review`,
    vaccination: `/colonies/${c}/vaccinate`,
  };
  const fetchedAt = new Date().toISOString();
  const [snapshot, metrics, agents, immune, review, vaccination] = await Promise.all(Object.values(paths).map((p) => getJson(base, p)));
  const reads = Object.values(paths).map((p) => `GET /api${p}`);
  let lineage: ColonyReads["why"];
  if (why) {
    const m = /^(.+?)(?::(\d+))?$/.exec(why);
    const q = new URLSearchParams({ path: m?.[1] ?? why, ...(m?.[2] ? { line: m[2] } : {}) });
    const p = `/colonies/${c}/why?${q.toString()}`;
    reads.push(`GET /api${p}`);
    lineage = { target: why, entries: await getJson(base, p) };
  }
  return { base, colony, fetchedAt, reads, snapshot, metrics, agents, immune, review, vaccination, ...(lineage ? { why: lineage } : {}) };
}

function write(out: string | undefined, text: string): void {
  if (!out) {
    process.stdout.write(text);
    return;
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, text);
  console.error(`wrote ${out}`);
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({ args: process.argv.slice(2), allowPositionals: true, options: { out: { type: "string" }, why: { type: "string" } }, strict: true });
  const [cmd, a, b] = positionals;
  const opts = { repoRoot: REPO_ROOT };
  if (cmd === "colony" && a) {
    const base = liveConfig().url;
    const summary = summarizeColony(await readColony(base, a, values.why));
    write(values.out, `${JSON.stringify(redactDeep(summary, opts), null, 2)}\n`);
  } else if (cmd === "get" && a?.startsWith("/")) {
    const base = liveConfig().url;
    const fetchedAt = new Date().toISOString();
    const response = await getJson(base, a);
    write(values.out, `${JSON.stringify(redactDeep({ request: `GET /api${a}`, base, fetchedAt, response }, opts), null, 2)}\n`);
  } else if (cmd === "redact" && a) {
    write(b ?? values.out, redactEvidence(readFileSync(a, "utf8"), opts));
  } else if (cmd === "transcript" && a) {
    const note: TranscriptEntry = {
      type: "note",
      text: "Trimmed by packages/bench/src/evidence.ts transcript: the session's model and MCP tools, every tool call and result, the agent's text, permission denials and the final result. Dropped: thinking, rate-limit and token-count events, ids, usage and local client configuration. Tokens, the account id, emails and local paths are redacted.",
    };
    const entries = [note, ...trimTranscript(readFileSync(a, "utf8").split("\n"))].map((e) => JSON.stringify(redactDeep(e, opts)));
    write(b ?? values.out, `${entries.join("\n")}\n`);
  } else {
    throw new Error("usage: evidence.ts colony <id> [--why path[:line]] [--out file] | get </colonies/...> [--out file] | redact <in> [out] | transcript <in.jsonl> [out.jsonl]");
  }
}

function isEntry(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntry()) {
  main().catch((e) => {
    console.error(redactEvidence(e instanceof Error ? e.message : String(e)));
    process.exit(1);
  });
}
