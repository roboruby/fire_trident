import type { Colony, Rule } from "@fire_trident/core";
import type { Command } from "./args.ts";

/**
 * HTTP contract the CLI assumes (routes in packages/worker/src/api/routes.ts).
 * Bodies mirror the Durable Object RPC inputs in docs/ARCHITECTURE.md:
 *
 *   POST /api/colonies                  { name, source?: { url, branch? }, pool?, regionDepth? }  -> Colony | { colony: Colony }
 *   GET  /api/colonies/:id              ColonySnapshot (an optional `rules: Rule[]` enriches output)
 *   POST /api/colonies/:id/rules        { colonyId, kind, spec, description, approvedBy }  -> { rule, violations, intents }
 *   POST /api/colonies/:id/intents      { colonyId, title, why, source, footprint, acceptance?, priority, createdBy, contest?, force? }  -> Intent
 *   POST /api/colonies/:id/swarm        { agents, model?, kind? }
 *   GET  /api/colonies/:id/why          ?path=&line=  -> Array<{ landing, note }>
 *   GET  /api/colonies/:id/impact       ?path=&path=&depth=  -> ImpactReport (importers, claims on them, landings)
 *   GET  /api/colonies/:id/review       Proposal[] (escalated)
 *   POST /api/colonies/:id/review/:pid  { decision: "approve" | "reject" | "return", reason, by }
 *   GET  /api/colonies/:id/live         WebSocket of ColonyEvent JSON (one event or an array per message)
 *   GET  /api/colonies                  { colonies: [{ id, name, source?, createdAt, trunkSha, lastLandingAt, counters }] }
 *   GET  /api/colonies/:id/agents       { total, byState, agents: [AgentInfo + intentTitle?, step?, running?, ...] }  (?all=1, ?journal=0)
 *   POST /api/colonies/:id/agents/:aid/stop   { reason? }  -> { ok, stopped, failed, retired }
 *   POST /api/colonies/:id/swarm/stop   { reason? }  -> { ok, considered, stopped, failed, retired }
 *   POST /api/colonies/:id/vaccinate    { count }
 *   GET  /api/colonies/:id/certifications, POST .../certify, POST .../certify/policy { enabled }
 *   GET  /api/colonies/:id/decide/policy, POST .../decide/policy { protectedPaths?, commentProof? } -> the decide policy
 *   DELETE /api/colonies/:id            -> { found, ok, agents, repos, objects, unregistered }
 *   PATCH  /api/colonies/:id/intents/:iid           { title?, why?, footprint?, priority?, reason, by } -> { intent, revision, returned, notified }
 *   POST   /api/colonies/:id/intents/:iid/withdraw  { reason, by } -> { intent, returned, notified }
 *   GET    /api/colonies/:id/intents/:iid           -> { intent, revisions, directives }
 *   DELETE /api/colonies/:id/rules/:rid             { reason, by } -> { rule, withdrawn, returned, notified }
 *   POST   /api/colonies/:id/agents/:aid/directive  { message, intentId?, by } -> Directive + { delivery }
 *   GET    /api/colonies/:id/escalations            -> { colonyId, total, intents: Intent[] } (reports waiting for a person)
 *   POST   /api/colonies/:id/intents/:iid/escalation { decision: amend|withdraw|dismiss, note, by, amend?: { title?, why?, footprint? } } -> { intent }
 *   POST   /api/colonies/:id/landings/:ref/revert   { reason, by, redo, proposal? } -> { landing, reverted, redo, proposal? }
 *   GET    /api/colonies/:id/proposals/:pid         -> Proposal (with landingId once it landed)
 *   GET    /api/colonies/:id/guide                  -> the field guide: { on, gate, active, chars, candidates?, ended? } (the last two with the token)
 *   POST   /api/colonies/:id/guide/:lessonId        { action: approve|reject, by, reason? } -> the lesson
 *
 * Every request carries `Authorization: Bearer $FT_TOKEN` when the token is set.
 */

/** The server used when neither --url nor FT_URL is given. */
export const DEFAULT_URL = "https://firetrident.com";

/** CLI version, printed by `ft --version` and sent as the user agent. */
export const VERSION = "0.0.1";

/** One planned HTTP call. `path` includes any query string. */
export interface ApiRequest {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
}

/** A failed call: `status` 0 means the server could not be reached. */
export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

/** What `send` needs: where the server is, the token, and a fetch implementation. */
export interface HttpConfig {
  baseUrl: string;
  token?: string;
  fetch: typeof fetch;
}

/** Resolve the server base URL from --url, then FT_URL, then the default. Strips trailing slashes. */
export function resolveBaseUrl(flag: string | undefined, env: Record<string, string | undefined>): string {
  const raw = (flag ?? env.FT_URL ?? "").trim() || DEFAULT_URL;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ApiError(0, `not a valid server URL: ${raw} (set FT_URL or --url)`, null);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new ApiError(0, `server URL must be http(s): ${raw}`, null);
  return raw.replace(/\/+$/, "");
}

/** API path for a colony, with an optional suffix such as `/rules`. */
export function colonyPath(colony: string, suffix = ""): string {
  return `/api/colonies/${encodeURIComponent(colony)}${suffix}`;
}

/** WebSocket URL of a colony's live event stream (http becomes ws, https becomes wss). */
export function liveUrl(baseUrl: string, colony: string): string {
  return baseUrl.replace(/^http/i, "ws") + colonyPath(colony, "/live");
}

/** Body for POST /rules, shared by `ft rule` and `ft new`. */
export function ruleBody(colony: string, kind: Rule["kind"], spec: Record<string, unknown>, description: string, approvedBy: string): Omit<Rule, "id" | "createdAt"> {
  return { colonyId: colony, kind, spec, description, approvedBy };
}

/**
 * Map a one-shot command to its HTTP call (pure). `by` is the human recorded as
 * rule approver or review decider. Returns null for commands that are not one call.
 */
export function planRequest(cmd: Command, by: string): ApiRequest | null {
  switch (cmd.name) {
    case "import": {
      const source: { url: string; branch?: string } = { url: cmd.url };
      if (cmd.branch) source.branch = cmd.branch;
      const body: Record<string, unknown> = { name: cmd.colonyName, source };
      if (cmd.pool !== undefined) body.pool = cmd.pool;
      if (cmd.regionDepth !== undefined) body.regionDepth = cmd.regionDepth;
      return { method: "POST", path: "/api/colonies", body };
    }
    case "status":
      return { method: "GET", path: colonyPath(cmd.colony) };
    case "rule-add": {
      const spec: Record<string, unknown> = { pattern: cmd.pattern };
      if (cmd.flags) spec.flags = cmd.flags;
      if (cmd.include.length > 0) spec.include = cmd.include;
      if (cmd.exclude.length > 0) spec.exclude = cmd.exclude;
      spec.hint = cmd.hint;
      if (cmd.replacement !== undefined) spec.replacement = cmd.replacement;
      return { method: "POST", path: colonyPath(cmd.colony, "/rules"), body: ruleBody(cmd.colony, "forbid-pattern", spec, cmd.description, cmd.by ?? by) };
    }
    case "rule-import-boundary": {
      const spec = { from: cmd.from, module: cmd.module, hint: cmd.hint };
      return { method: "POST", path: colonyPath(cmd.colony, "/rules"), body: ruleBody(cmd.colony, "forbid-import", spec, cmd.description, cmd.by ?? by) };
    }
    case "swarm": {
      const body: Record<string, unknown> = { agents: cmd.agents };
      if (cmd.model) body.model = cmd.model;
      if (cmd.kind) body.kind = cmd.kind;
      return { method: "POST", path: colonyPath(cmd.colony, "/swarm"), body };
    }
    case "why": {
      const q = new URLSearchParams({ path: cmd.path });
      if (cmd.line !== undefined) q.set("line", String(cmd.line));
      return { method: "GET", path: `${colonyPath(cmd.colony, "/why")}?${q}` };
    }
    case "impact": {
      const q = new URLSearchParams();
      for (const p of cmd.paths) q.append("path", p);
      if (cmd.depth !== undefined) q.set("depth", String(cmd.depth));
      return { method: "GET", path: `${colonyPath(cmd.colony, "/impact")}?${q}` };
    }
    case "verify":
      return { method: "GET", path: `${colonyPath(cmd.colony, "/notes/verify")}${cmd.limit !== undefined ? `?limit=${cmd.limit}` : ""}` };
    case "review-list":
      return { method: "GET", path: colonyPath(cmd.colony, "/review") };
    case "review-decide":
      return {
        method: "POST",
        path: colonyPath(cmd.colony, `/review/${encodeURIComponent(cmd.proposalId)}`),
        body: { decision: cmd.decision, reason: cmd.reason, by: cmd.by ?? by },
      };
    case "colonies":
      return { method: "GET", path: `/api/colonies${cmd.scan ? "?scan=1" : ""}` };
    case "megafile":
      if (!cmd.path) return { method: "GET", path: colonyPath(cmd.colony, "/megafile") };
      return { method: "POST", path: colonyPath(cmd.colony, "/megafile"), body: { path: cmd.path, action: cmd.release ? "release" : "hold", by: cmd.by ?? by } };
    case "agents": {
      const q = new URLSearchParams();
      if (cmd.all) q.set("all", "1");
      if (!cmd.journal) q.set("journal", "0");
      const query = q.toString();
      return { method: "GET", path: `${colonyPath(cmd.colony, "/agents")}${query ? `?${query}` : ""}` };
    }
    case "stop": {
      const body = cmd.reason ? { reason: cmd.reason } : {};
      if (cmd.agentId) return { method: "POST", path: colonyPath(cmd.colony, `/agents/${encodeURIComponent(cmd.agentId)}/stop`), body };
      return { method: "POST", path: colonyPath(cmd.colony, "/swarm/stop"), body };
    }
    case "delete":
      return { method: "DELETE", path: colonyPath(cmd.colony) };
    case "vaccinate":
      return { method: "POST", path: colonyPath(cmd.colony, "/vaccinate"), body: { count: cmd.count } };
    case "certify":
      if (cmd.action === "now") return { method: "POST", path: colonyPath(cmd.colony, "/certify") };
      if (cmd.action === "on" || cmd.action === "off") return { method: "POST", path: colonyPath(cmd.colony, "/certify/policy"), body: { enabled: cmd.action === "on" } };
      return { method: "GET", path: `${colonyPath(cmd.colony, "/certifications")}?limit=10` };
    case "policy":
      // Adding or removing protected paths reads the list first (see run.ts).
      if (cmd.protect.length > 0 || cmd.unprotect.length > 0) return null;
      if (cmd.commentProof !== undefined) return { method: "POST", path: colonyPath(cmd.colony, "/decide/policy"), body: { commentProof: cmd.commentProof } };
      return { method: "GET", path: colonyPath(cmd.colony, "/decide/policy") };
    case "intent-amend": {
      const body: Record<string, unknown> = {};
      if (cmd.title !== undefined) body.title = cmd.title;
      if (cmd.why !== undefined) body.why = cmd.why;
      if (cmd.footprint !== undefined) body.footprint = cmd.footprint;
      if (cmd.priority !== undefined) body.priority = cmd.priority;
      body.reason = cmd.reason;
      body.by = cmd.by ?? by;
      return { method: "PATCH", path: colonyPath(cmd.colony, `/intents/${encodeURIComponent(cmd.intentId)}`), body };
    }
    case "revert":
      // Reverting one proposal is two calls: its landing is read first (see revertRequest).
      return isProposalRef(cmd.ref) ? null : revertRequest(cmd, by);
    case "intent-withdraw":
      return { method: "POST", path: colonyPath(cmd.colony, `/intents/${encodeURIComponent(cmd.intentId)}/withdraw`), body: { reason: cmd.reason, by: cmd.by ?? by } };
    case "intent-show":
      return { method: "GET", path: colonyPath(cmd.colony, `/intents/${encodeURIComponent(cmd.intentId)}`) };
    case "rule-retract":
      return { method: "DELETE", path: colonyPath(cmd.colony, `/rules/${encodeURIComponent(cmd.ruleId)}`), body: { reason: cmd.reason, by: cmd.by ?? by } };
    case "direct":
      return {
        method: "POST",
        path: colonyPath(cmd.colony, `/agents/${encodeURIComponent(cmd.agentId)}/directive`),
        body: { message: cmd.message, ...(cmd.intentId ? { intentId: cmd.intentId } : {}), by: cmd.by ?? by },
      };
    case "escalations":
      return { method: "GET", path: colonyPath(cmd.colony, "/escalations") };
    case "escalation": {
      const amend: Record<string, unknown> = {};
      if (cmd.title !== undefined) amend.title = cmd.title;
      if (cmd.why !== undefined) amend.why = cmd.why;
      if (cmd.footprint !== undefined) amend.footprint = cmd.footprint;
      return {
        method: "POST",
        path: colonyPath(cmd.colony, `/intents/${encodeURIComponent(cmd.intentId)}/escalation`),
        body: { decision: cmd.decision, note: cmd.note, by: cmd.by ?? by, ...(Object.keys(amend).length > 0 ? { amend } : {}) },
      };
    }
    case "guide":
      return { method: "GET", path: colonyPath(cmd.colony, "/guide") };
    case "guide-decide":
      return {
        method: "POST",
        path: colonyPath(cmd.colony, `/guide/${encodeURIComponent(cmd.lessonId)}`),
        body: { action: cmd.action, by: cmd.by ?? by, ...(cmd.reason ? { reason: cmd.reason } : {}) },
      };
    default:
      return null;
  }
}

/** True when `ft revert` names one proposal (prp_...) rather than a landing or a trunk commit. */
export function isProposalRef(ref: string): boolean {
  return ref.startsWith("prp_");
}

/**
 * The revert call of `ft revert`. For a proposal, `landing` is the landing it landed in (read first
 * with GET /proposals/:pid) and the body names the proposal, so only the files it wrote go back.
 */
export function revertRequest(cmd: Extract<Command, { name: "revert" }>, by: string, landing: string = cmd.ref): ApiRequest {
  const body: Record<string, unknown> = { reason: cmd.reason, by: cmd.by ?? by, redo: cmd.redo };
  if (isProposalRef(cmd.ref)) body.proposal = cmd.ref;
  return { method: "POST", path: colonyPath(cmd.colony, `/landings/${encodeURIComponent(landing)}/revert`), body };
}

function errorDetail(data: unknown): string {
  if (data && typeof data === "object") {
    const o = data as Record<string, unknown>;
    const msg = o.error ?? o.message;
    if (typeof msg === "string" && msg) return `: ${msg}`;
    if (msg && typeof msg === "object" && typeof (msg as Record<string, unknown>).message === "string") return `: ${(msg as Record<string, string>).message}`;
    return "";
  }
  if (typeof data === "string" && data.trim()) return `: ${data.trim().slice(0, 300)}`;
  return "";
}

/** Send one request and return the parsed JSON body. Throws ApiError on network or HTTP failure. */
export async function send<T = unknown>(cfg: HttpConfig, req: ApiRequest, timeoutMs = 30_000): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json", "user-agent": `ft/${VERSION}` };
  if (cfg.token) headers.authorization = `Bearer ${cfg.token}`;
  let body: string | undefined;
  if (req.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(req.body);
  }
  let res: Response;
  try {
    res = await cfg.fetch(cfg.baseUrl + req.path, { method: req.method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const err = e as Error & { cause?: { message?: string; code?: string } };
    const why = err.name === "TimeoutError" ? `timed out after ${Math.round(timeoutMs / 1000)}s` : err.cause?.code ?? err.cause?.message ?? err.message;
    throw new ApiError(0, `cannot reach ${cfg.baseUrl}: ${why}`, null);
  }
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const auth = res.status === 401 || res.status === 403 ? (cfg.token ? " (check FT_TOKEN)" : " (set FT_TOKEN)") : "";
    throw new ApiError(res.status, `${req.method} ${req.path.split("?")[0]} failed: ${res.status} ${res.statusText}${errorDetail(data)}${auth}`, data);
  }
  return data as T;
}

/** Pull a Colony out of POST /api/colonies' response, whether bare or wrapped. */
export function pickColony(res: unknown): (Partial<Colony> & { id: string }) | null {
  if (!res || typeof res !== "object") return null;
  const o = res as Record<string, unknown>;
  const c = (o.colony && typeof o.colony === "object" ? o.colony : o) as Record<string, unknown>;
  if (typeof c.id === "string" && c.id) return c as Partial<Colony> & { id: string };
  if (typeof o.id === "string" && o.id) return { ...(c as Partial<Colony>), id: o.id };
  return null;
}

/** Read an array from a response that is either the array or an object wrapping it under one of `keys`. */
export function asArray<T>(res: unknown, keys: string[]): T[] {
  if (Array.isArray(res)) return res as T[];
  if (res && typeof res === "object") {
    for (const k of keys) {
      const v = (res as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v as T[];
    }
  }
  return [];
}
