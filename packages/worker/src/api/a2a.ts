import type { Context, Hono, MiddlewareHandler } from "hono";
import { revalidationEnabled } from "@fire_trident/core";
import type { Colony, Id } from "@fire_trident/core";
import { A2A_CANCEL_REASON, A2A_PAGE_DEFAULT, A2A_PAGE_MAX, a2aState, a2aTerminal, type A2ACursor, type A2APage, type A2AState, type A2ATaskFacts } from "../colony/a2a.ts";
import { decodeError } from "../colony/errors.ts";
import { isTwinAnswer } from "../colony/twins.ts";
import type { Env } from "../env.ts";
import type { ApiEnv } from "./app.ts";
import { publicColonies } from "./git-proxy.ts";
import { isUnsupportedRpc, mapLimit, messageOf } from "./logic.ts";
import { IntentBody } from "./schemas.ts";

/**
 * The Agent2Agent door (FT_A2A; registered by createApi): an orchestrator hands a colony work the standard way and
 * follows it to the landing commit, without FireTrident's own API. It follows the Agent2Agent protocol 1.0 (JSON-RPC
 * binding: methods SendMessage, GetTask, ListTasks, CancelTask; enums such as TASK_STATE_COMPLETED; parts {text} and
 * {data}); the 0.3 method names message/send, tasks/get and tasks/cancel answer in 0.3's shapes (kind fields, states
 * such as "completed"). The method name decides the shapes; an A2A-Version header or query parameter other than 0.3
 * or 1.0 is refused.
 *   GET  /colonies/:id/.well-known/agent-card.json   the colony's agent card (public)
 *   POST /colonies/:id/a2a                           JSON-RPC 2.0, one request per call
 * SendMessage declares an intent (the first line of the text is the title, the rest the why; a data part carries
 * footprint, and optionally acceptance, priority and force) and CancelTask withdraws one: both need the admin token,
 * checked as POST /intents checks it. GetTask and ListTasks are public, like every read. A task is an intent: its id is
 * the intent id, its context the colony (colony/a2a.ts maps intent statuses to task states). A colony FT_A2A does not
 * cover answers 404 on both routes.
 */

/** JSON-RPC and A2A error codes this door answers with. `writeRefused` is FireTrident's own: a write without the admin token. */
export const A2A_ERRORS = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  writeRefused: -32000,
  taskNotFound: -32001,
  taskNotCancelable: -32002,
  pushNotSupported: -32003,
  unsupportedOperation: -32004,
  contentTypeNotSupported: -32005,
  extendedCardNotConfigured: -32007,
  versionNotSupported: -32009,
} as const;

/** The protocol version a request's method belongs to: 1.0 names (SendMessage) or 0.3 names (message/send). */
export type A2ADialect = "1.0" | "0.3";

/** How long a blocking SendMessage waits for its task to end or stop for input, and how often it looks. */
export const SEND_WAIT_MS = 20_000;
const SEND_POLL_MS = 1_000;
/** Largest request body read. */
const MAX_BODY_BYTES = 1 << 20;
/** Files of a landing whose why links a task carries at most. */
const WHY_LINKS = 20;
/** Landings whose commits are looked up at the trunk writer at once, when the colony no longer keeps them. */
const COMMIT_LOOKUPS = 8;
/** Longest title or report a task quotes. */
const QUOTE_CHARS = 200;
const REPORT_CHARS = 500;

const METHODS: Readonly<Record<string, { op: "send" | "get" | "list" | "cancel"; dialect: A2ADialect }>> = {
  SendMessage: { op: "send", dialect: "1.0" },
  "message/send": { op: "send", dialect: "0.3" },
  GetTask: { op: "get", dialect: "1.0" },
  "tasks/get": { op: "get", dialect: "0.3" },
  ListTasks: { op: "list", dialect: "1.0" },
  CancelTask: { op: "cancel", dialect: "1.0" },
  "tasks/cancel": { op: "cancel", dialect: "0.3" },
};
const STREAMING: ReadonlySet<string> = new Set(["SendStreamingMessage", "SubscribeToTask", "message/stream", "tasks/resubscribe"]);
const PUSH: ReadonlySet<string> = new Set([
  "CreateTaskPushNotificationConfig",
  "GetTaskPushNotificationConfig",
  "ListTaskPushNotificationConfigs",
  "DeleteTaskPushNotificationConfig",
  "tasks/pushNotificationConfig/set",
  "tasks/pushNotificationConfig/get",
  "tasks/pushNotificationConfig/list",
  "tasks/pushNotificationConfig/delete",
]);
const EXTENDED_CARD: ReadonlySet<string> = new Set(["GetExtendedAgentCard", "agent/getAuthenticatedExtendedCard"]);

const STATE_V1: Readonly<Record<A2AState, string>> = {
  submitted: "TASK_STATE_SUBMITTED",
  working: "TASK_STATE_WORKING",
  "input-required": "TASK_STATE_INPUT_REQUIRED",
  completed: "TASK_STATE_COMPLETED",
  canceled: "TASK_STATE_CANCELED",
  failed: "TASK_STATE_FAILED",
};
/** States the protocol has and no intent maps to: a ListTasks filter on one matches nothing. */
const NEVER: ReadonlySet<string> = new Set(["TASK_STATE_REJECTED", "TASK_STATE_AUTH_REQUIRED", "rejected", "auth-required", "unknown"]);

/** A refusal with its JSON-RPC code (and the HTTP status it travels with). */
export class A2AFault extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly http = 200,
  ) {
    super(message);
  }
}

/** Whether FT_A2A covers the colony: "on", or a comma-separated list that names it; off when absent. */
export function a2aEnabled(setting: string | undefined, colonyId: Id): boolean {
  return revalidationEnabled(setting, colonyId);
}

/** What a task's links are built from: the colony, the origin the caller used, and whether plain git serves the colony. */
export interface TaskContext {
  colonyId: Id;
  origin: string;
  publicGit: boolean;
}

/** The colony's agent card (A2A 1.0): one skill, declaring an intent, behind the admin token; JSON-RPC at /a2a. */
export function agentCard(colony: Pick<Colony, "id" | "name" | "source">, p: { origin: string; version: string }): Record<string, unknown> {
  const url = `${p.origin}/api/colonies/${colony.id}/a2a`;
  const from = colony.source?.url ? ` Its trunk was imported from ${colony.source.url}.` : "";
  const token = [{ schemes: { adminToken: { list: [] } } }];
  return {
    name: `FireTrident colony ${colony.name}`,
    description:
      `The ${colony.name} colony (${colony.id}) on FireTrident: one git repository that many coding agents change at once.${from} ` +
      "Send it a message to declare an intent, what to change and why and the paths it will touch; agents take it from the colony, " +
      "review decides what lands, and the task follows the intent to the trunk commit that lands it.",
    supportedInterfaces: [
      { url, protocolBinding: "JSONRPC", protocolVersion: "1.0" },
      { url, protocolBinding: "JSONRPC", protocolVersion: "0.3" },
    ],
    provider: { organization: "FireTrident", url: p.origin },
    version: p.version,
    capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
    securitySchemes: {
      adminToken: {
        httpAuthSecurityScheme: {
          scheme: "Bearer",
          description: "The deployment's admin token. SendMessage and CancelTask need it; GetTask, ListTasks and this card do not.",
        },
      },
    },
    securityRequirements: token,
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["text/plain", "application/json"],
    skills: [
      {
        id: "declare-intent",
        name: "Declare an intent",
        description:
          "Hand the colony a change to make. The first line of the text is the intent's title and the rest its why. A data part " +
          'carries {"footprint": [paths or globs it will touch]} (required), and optionally "acceptance" (a list of checks), ' +
          '"priority" (a number, 1 by default) and "force" (true declares it even when it matches an intent the colony has). ' +
          "The task's id is the intent's id: it completes with the landing commit and links to why each file changed.",
        tags: ["git", "code-change", "intent", "coding-agents"],
        examples: ["Add rate limiting to /api/links\nAnonymous callers can flood the links endpoints; cap them at 60 requests a minute."],
        inputModes: ["text/plain", "application/json"],
        outputModes: ["text/plain", "application/json"],
        securityRequirements: token,
      },
    ],
  };
}

/** Whether an A2A-Version value is one this door speaks (0.3 or 1.0; a patch number is ignored). Empty means 0.3. */
export function versionSupported(raw: string | null | undefined): boolean {
  const v = (raw ?? "").trim();
  if (v === "") return true;
  const m = /^(\d+)\.(\d+)(?:\.\d+)?$/.exec(v);
  return !!m && ((m[1] === "1" && m[2] === "0") || (m[1] === "0" && m[2] === "3"));
}

/** What a SendMessage asks for, read from its message. */
export interface SendRequest {
  title: string;
  why: string;
  footprint: string[];
  acceptance?: string[];
  priority?: number;
  force?: boolean;
}

/** Keys a data part may carry. */
const DATA_KEYS: ReadonlySet<string> = new Set(["footprint", "acceptance", "priority", "force"]);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function invalid(message: string): A2AFault {
  return new A2AFault(A2A_ERRORS.invalidParams, message);
}

/**
 * Read a SendMessage's message (1.0 or 0.3 parts, either role spelling): the text parts joined make the title (first
 * line) and the why (the rest), the data parts' keys (footprint, acceptance, priority, force) are merged, and the
 * result is checked as POST /intents checks a body. File parts, other keys and a context other than the colony's are
 * refused, each with a sentence that says what to send instead.
 */
export function readSendMessage(message: unknown, colonyId: Id): SendRequest {
  if (!isObject(message)) throw invalid("params.message is required: an object with messageId, role and parts");
  if (typeof message.messageId !== "string" || message.messageId.trim() === "") throw invalid("message.messageId is required: a unique id for this message");
  if (message.role !== "ROLE_USER" && message.role !== "user") throw invalid("message.role must be ROLE_USER (user in 0.3): a message to this agent comes from its user");
  if (message.contextId !== undefined && message.contextId !== null && message.contextId !== "" && message.contextId !== colonyId) {
    throw invalid(`this colony keeps one context, ${colonyId}: send contextId ${JSON.stringify(colonyId)} or none`);
  }
  if (!Array.isArray(message.parts) || message.parts.length === 0) throw invalid("message.parts is required: a text part with the title and why, and a data part with the footprint");
  const texts: string[] = [];
  const fields: Record<string, unknown> = {};
  for (const part of message.parts) {
    if (!isObject(part)) throw invalid("each part is an object holding text or data");
    const kind = part.kind;
    if (kind === "file" || "raw" in part || "url" in part || "file" in part) {
      throw new A2AFault(A2A_ERRORS.contentTypeNotSupported, "this agent reads text and JSON data parts, not files: put the title and why in a text part and the footprint in a data part");
    }
    if (typeof part.text === "string" && (kind === undefined || kind === "text")) {
      texts.push(part.text);
    } else if ("data" in part && (kind === undefined || kind === "data")) {
      if (!isObject(part.data)) throw invalid('a data part holds a JSON object, such as {"footprint": ["src/links/**"]}');
      for (const [key, value] of Object.entries(part.data)) {
        if (!DATA_KEYS.has(key)) throw invalid(`a data part may carry footprint, acceptance, priority and force; ${JSON.stringify(key)} is not one of them`);
        fields[key] = value;
      }
    } else {
      throw invalid("each part holds text or data");
    }
  }
  const text = texts.join("\n").replace(/\r\n?/g, "\n").trim();
  if (text === "") throw invalid("the message needs text: its first line is the intent's title and the rest its why");
  const nl = text.indexOf("\n");
  const title = (nl < 0 ? text : text.slice(0, nl)).trim();
  const why = nl < 0 ? "" : text.slice(nl + 1).trim();
  if (fields.footprint === undefined) {
    throw invalid('an intent needs a footprint, the paths it will touch: add a data part such as {"footprint": ["src/links/**"]} (globs and directories ending in / are fine)');
  }
  const list = (v: unknown): unknown => (typeof v === "string" ? [v] : v);
  const parsed = IntentBody.safeParse({
    title,
    why,
    footprint: list(fields.footprint),
    ...(fields.acceptance !== undefined ? { acceptance: list(fields.acceptance) } : {}),
    ...(fields.priority !== undefined ? { priority: fields.priority } : {}),
    ...(fields.force !== undefined ? { force: fields.force } : {}),
  });
  if (!parsed.success) {
    const name: Record<string, string> = { title: "the first line (the title)", why: "the rest of the text (the why)" };
    const issues = parsed.error.issues.slice(0, 5).map((i) => `${name[String(i.path[0])] ?? (i.path.map(String).join(".") || "message")}: ${i.message}`);
    throw invalid(`the message does not make an intent: ${issues.join("; ")}`);
  }
  const b = parsed.data;
  return {
    title: b.title,
    why: b.why,
    footprint: b.footprint,
    ...(b.acceptance ? { acceptance: b.acceptance } : {}),
    ...(fields.priority !== undefined ? { priority: b.priority } : {}),
    ...(b.force !== undefined ? { force: b.force } : {}),
  };
}

/** A ListTasks or tasks/get page token: where the page ended, opaque to the caller. */
export function encodeCursor(c: A2ACursor): string {
  return btoa(`${c.at}:${c.id}`).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The cursor a page token names, or null when it is not one this door gave. */
export function decodeCursor(token: string): A2ACursor | null {
  try {
    const text = atob(token.replace(/-/g, "+").replace(/_/g, "/"));
    const m = /^(\d{1,16}):([A-Za-z0-9_-]{1,100})$/.exec(text);
    return m ? { at: Number(m[1]), id: m[2] ?? "" } : null;
  } catch {
    return null;
  }
}

/** A ListTasks status filter as task states: every state (absent or unspecified), none (a state no intent maps to), or one. */
export function statusFilter(raw: unknown): A2AState[] | "none" | null {
  if (raw === undefined || raw === null || raw === "" || raw === "TASK_STATE_UNSPECIFIED") return null;
  if (typeof raw !== "string") throw invalid("status must be a task state such as TASK_STATE_WORKING");
  if (NEVER.has(raw)) return "none";
  for (const [state, name] of Object.entries(STATE_V1) as Array<[A2AState, string]>) if (raw === name || raw === state) return [state];
  throw invalid(`status ${JSON.stringify(raw)} is not a task state: use one of ${Object.values(STATE_V1).join(", ")}`);
}

/** One line, at most `max` characters, ending in "…" when cut. */
function clip(text: string, max: number): string {
  const line = String(text ?? "").replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

/** A wait in words: seconds at a second or more, else milliseconds. */
function duration(ms: number): string {
  return ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`;
}

function iso(ms: number | null | undefined): string | undefined {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function whyUrl(ctx: TaskContext, path: string): string {
  return `${ctx.origin}/api/colonies/${ctx.colonyId}/why?path=${encodeURIComponent(path)}`;
}

function textPart(d: A2ADialect, text: string): Record<string, unknown> {
  return d === "1.0" ? { text } : { kind: "text", text };
}

function dataPart(d: A2ADialect, data: Record<string, unknown>): Record<string, unknown> {
  return d === "1.0" ? { data, mediaType: "application/json" } : { kind: "data", data };
}

/** What a task's status says, in plain sentences: what happened, and what to do next. */
export function statusText(f: A2ATaskFacts, ctx: TaskContext): string {
  const i = f.intent;
  const state = a2aState(i, f.waiting === true);
  switch (state) {
    case "submitted":
      return `Intent ${i.id} is open in colony ${ctx.colonyId}: no agent has taken it yet. Follow it with GetTask; CancelTask withdraws it.`;
    case "input-required": {
      const kind = i.escalation ? ` (${i.escalation.kind})` : "";
      return (
        `An agent reported that intent ${i.id} cannot be done as written${kind}, so no agent takes it until a person answers the report ` +
        `in colony ${ctx.colonyId} (ft escalation, or POST /api/colonies/${ctx.colonyId}/intents/${i.id}/escalation). CancelTask withdraws it.`
      );
    }
    case "working":
      if (i.status === "claimed") return `An agent took intent ${i.id} and is working on it. Follow it with GetTask.`;
      if (f.inReview) return `A change for intent ${i.id} waits for a person's review in colony ${ctx.colonyId}. Follow it with GetTask.`;
      return `An agent proposed a change for intent ${i.id}; review and its lane decide whether it lands. Follow it with GetTask.`;
    case "completed": {
      const l = f.landing;
      if (!l) return `Intent ${i.id} landed. Its landing is not on record here: ft why ${ctx.colonyId} <path> shows the landings on its files.`;
      const first = l.paths[0];
      const why = first ? ` Read why each file changed with ft why ${ctx.colonyId} ${first}, or GET ${whyUrl(ctx, first)}.` : "";
      return `Intent ${i.id} landed${l.commit ? ` in trunk commit ${l.commit}` : ""} (landing ${l.id}).${why}`;
    }
    case "canceled": {
      const rest = (i.withdrawnReason ?? "").slice(A2A_CANCEL_REASON.length).replace(/^[:\s]+/, "");
      return `Intent ${i.id} was withdrawn by CancelTask${rest ? ` (${clip(rest, QUOTE_CHARS)})` : ""}: its needs are gone and no agent will take it.`;
    }
    case "failed":
      return i.status === "withdrawn"
        ? `Intent ${i.id} was withdrawn${i.withdrawnReason ? `: ${clip(i.withdrawnReason, QUOTE_CHARS)}` : ""}. It will not land; send a new message to declare the work again.`
        : `Intent ${i.id} is sealed and will never land.`;
  }
}

/** The landing a completed task carries as its artifact: the trunk commit, the files, and where to read why each changed. */
function landingArtifact(f: A2ATaskFacts, d: A2ADialect, ctx: TaskContext): Record<string, unknown> | null {
  const l = f.landing;
  if (!l) return null;
  const files = l.paths.slice(0, WHY_LINKS).map((path) => ({ path, why: whyUrl(ctx, path) }));
  const more = l.paths.length - files.length + l.morePaths;
  const count = l.paths.length + l.morePaths;
  const data: Record<string, unknown> = {
    landing: l.id,
    commit: l.commit,
    proposal: l.proposalId,
    ...(iso(l.at) ? { landedAt: iso(l.at) } : {}),
    files,
    ...(more > 0 ? { moreFiles: more } : {}),
    ...(files[0] ? { whyCommand: `ft why ${ctx.colonyId} ${files[0].path}` } : {}),
    ...(ctx.publicGit ? { git: `${ctx.origin}/git/${ctx.colonyId}.git` } : {}),
  };
  const text =
    `Landed${l.commit ? ` in trunk commit ${l.commit}` : ""} (landing ${l.id}), writing ${count} file${count === 1 ? "" : "s"}` +
    `${files[0] ? `; why each changed: ${files[0].why}${count > 1 ? " and the other files' links in the data part" : ""}` : ""}.`;
  return {
    artifactId: `landing-${l.id}`,
    name: "Landing",
    description: "The trunk commit that landed this intent, the files its change wrote, and where to read why each changed.",
    parts: [textPart(d, text), dataPart(d, data)],
  };
}

/**
 * One intent as a task in a dialect's shapes. `artifacts`: carry the landing of a completed task (ListTasks leaves it
 * out unless asked). `lead`: a sentence that goes before the status's own (a twin, a wait that ran out). `extra`: more
 * FireTrident fields for metadata.firetrident.
 */
export function renderTask(
  f: A2ATaskFacts,
  d: A2ADialect,
  ctx: TaskContext,
  opts: { artifacts?: boolean; lead?: string; extra?: Record<string, unknown> } = {},
): Record<string, unknown> {
  const i = f.intent;
  const state = a2aState(i, f.waiting === true);
  const text = [opts.lead, statusText(f, ctx)].filter((s): s is string => !!s).join(" ");
  const timestamp = iso(f.updatedAt);
  const message = {
    ...(d === "0.3" ? { kind: "message" } : {}),
    messageId: `status-${i.id}-${Number.isFinite(f.updatedAt) ? f.updatedAt : 0}`,
    role: d === "1.0" ? "ROLE_AGENT" : "agent",
    parts: [textPart(d, text)],
    taskId: i.id,
    contextId: ctx.colonyId,
  };
  const artifact = opts.artifacts === false ? null : landingArtifact(f, d, ctx);
  const report = f.waiting && i.escalation ? { kind: i.escalation.kind, report: clip(i.escalation.report, REPORT_CHARS), by: i.escalation.by, ...(iso(i.escalation.at) ? { at: iso(i.escalation.at) } : {}) } : null;
  const firetrident: Record<string, unknown> = {
    colony: ctx.colonyId,
    intent: i.id,
    status: i.status,
    title: i.title,
    source: i.source,
    createdBy: i.createdBy,
    ...(i.revision !== undefined && i.revision > 1 ? { revision: i.revision } : {}),
    url: `${ctx.origin}/api/colonies/${ctx.colonyId}/intents/${i.id}`,
    ...(i.withdrawnReason ? { withdrawnReason: i.withdrawnReason } : {}),
    ...(report ? { report } : {}),
    ...(f.inReview ? { inReview: true } : {}),
    ...(opts.extra ?? {}),
  };
  return {
    ...(d === "0.3" ? { kind: "task" } : {}),
    id: i.id,
    contextId: ctx.colonyId,
    status: { state: d === "1.0" ? STATE_V1[state] : state, message, ...(timestamp ? { timestamp } : {}) },
    ...(artifact ? { artifacts: [artifact] } : {}),
    metadata: { firetrident },
  };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
}

type RpcId = string | number | null;

function rpcResult(id: RpcId, result: unknown): Response {
  return json({ jsonrpc: "2.0", id, result });
}

function rpcError(id: RpcId, code: number, message: string, http = 200, headers: Record<string, string> = {}): Response {
  return json({ jsonrpc: "2.0", id, error: { code, message } }, http, headers);
}

function colonyStub(env: Env, colonyId: Id) {
  return env.COLONY.get(env.COLONY.idFromName(colonyId));
}

/** The colony behind a route where FT_A2A covers it, or the 404 to answer: a colony it does not cover, or that does not exist. */
async function coveredColony(c: Context<ApiEnv>): Promise<Colony | Response> {
  const colonyId = c.req.param("id") ?? "";
  if (!/^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/.test(colonyId)) return json({ error: "colony not found" }, 404);
  if (!a2aEnabled(c.env.FT_A2A, colonyId)) return json({ error: `the Agent2Agent door is off for colony ${colonyId} (FT_A2A)` }, 404);
  const colony = await colonyStub(c.env, colonyId).getColony();
  return colony ?? json({ error: "colony not found" }, 404);
}

/** Options for a2aRoutes: how long a blocking SendMessage waits, and how often it looks (tests shorten both). */
export interface A2AOptions {
  waitMs?: number;
  pollMs?: number;
}

/**
 * Register the Agent2Agent routes. `admin` is the API's write check (requireAdmin): SendMessage and CancelTask pass
 * only where it would let POST /intents through, and get its refusal's status otherwise.
 */
export function a2aRoutes(app: Hono<ApiEnv>, admin: MiddlewareHandler<ApiEnv>, opts: A2AOptions = {}): void {
  const waitMs = Math.max(0, opts.waitMs ?? SEND_WAIT_MS);
  const pollMs = Math.max(10, opts.pollMs ?? SEND_POLL_MS);

  app.get("/colonies/:id/.well-known/agent-card.json", async (c) => {
    const colony = await coveredColony(c);
    if (colony instanceof Response) return colony;
    return json(agentCard(colony, { origin: new URL(c.req.url).origin, version: c.env.FT_BUILD || "0.0.1" }));
  });

  app.post("/colonies/:id/a2a", async (c) => {
    const colony = await coveredColony(c);
    if (colony instanceof Response) return colony;
    const ctx: TaskContext = { colonyId: colony.id, origin: new URL(c.req.url).origin, publicGit: publicColonies(c.env.FT_PUBLIC_GIT).has(colony.id) };
    let id: RpcId = null;
    try {
      const text = await c.req.text();
      if (text.length > MAX_BODY_BYTES) throw new A2AFault(A2A_ERRORS.invalidRequest, "the request is larger than 1 MiB");
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        throw new A2AFault(A2A_ERRORS.parse, "the body is not JSON: send one JSON-RPC 2.0 request");
      }
      if (Array.isArray(raw)) throw new A2AFault(A2A_ERRORS.invalidRequest, "batches are not taken: send one JSON-RPC request at a time");
      if (!isObject(raw)) throw new A2AFault(A2A_ERRORS.invalidRequest, "send a JSON-RPC 2.0 request object");
      if (typeof raw.id === "string" || typeof raw.id === "number") id = raw.id;
      if (raw.jsonrpc !== "2.0") throw new A2AFault(A2A_ERRORS.invalidRequest, 'jsonrpc must be "2.0"');
      if (typeof raw.method !== "string") throw new A2AFault(A2A_ERRORS.invalidRequest, "method must be a string, such as SendMessage");
      if (id === null) throw new A2AFault(A2A_ERRORS.invalidRequest, "every request needs an id (a string or a number): this agent answers each one");
      const version = c.req.header("A2A-Version") ?? c.req.query("A2A-Version");
      if (!versionSupported(version)) throw new A2AFault(A2A_ERRORS.versionNotSupported, `this agent speaks A2A 1.0 and 0.3, not ${JSON.stringify(version)}`);
      const method = raw.method;
      if (STREAMING.has(method)) throw new A2AFault(A2A_ERRORS.unsupportedOperation, `${method} is not offered: this agent does not stream (capabilities.streaming is false); poll GetTask instead`);
      if (PUSH.has(method)) throw new A2AFault(A2A_ERRORS.pushNotSupported, `${method} is not offered: this agent sends no push notifications; poll GetTask instead`);
      if (EXTENDED_CARD.has(method)) throw new A2AFault(A2A_ERRORS.extendedCardNotConfigured, "this agent has no extended card: its public card says everything");
      const route = METHODS[method];
      if (!route) throw new A2AFault(A2A_ERRORS.methodNotFound, `no method ${JSON.stringify(method)}: this agent answers SendMessage, GetTask, ListTasks and CancelTask`);
      if (raw.params !== undefined && !isObject(raw.params)) throw invalid("params must be an object");
      const params = isObject(raw.params) ? raw.params : {};
      if (route.op === "send" || route.op === "cancel") {
        const refusal = await writeRefusal(c, admin, method);
        if (refusal) return rpcError(id, A2A_ERRORS.writeRefused, refusal.message, refusal.status, refusal.status === 401 ? { "WWW-Authenticate": "Bearer" } : {});
      }
      const result =
        route.op === "send"
          ? await send(c.env, ctx, params, route.dialect, waitMs, pollMs)
          : route.op === "get"
            ? await get(c.env, ctx, params, route.dialect)
            : route.op === "list"
              ? await list(c.env, ctx, params)
              : await cancel(c.env, ctx, params, route.dialect);
      return rpcResult(id, result);
    } catch (err) {
      if (err instanceof A2AFault) return rpcError(id, err.code, err.message, err.http);
      // Deploys reach Durable Objects gradually: an object still on the previous class lacks the new method for a while.
      if (isUnsupportedRpc(err)) return rpcError(id, A2A_ERRORS.internal, "this colony is moving to a new version of FireTrident: retry in 30 s", 503, { "Retry-After": "30" });
      const { status, message } = decodeError(err);
      if (status >= 500) {
        console.error(`a2a ${colony.id} failed: ${message}`);
        return rpcError(id, A2A_ERRORS.internal, `FireTrident could not answer (${messageOf(err)}): retry later`, 500);
      }
      return rpcError(id, A2A_ERRORS.invalidParams, message);
    }
  });
}

/** Why a write is refused, as requireAdmin would refuse POST /intents, or null when it may go ahead. */
async function writeRefusal(c: Context<ApiEnv>, admin: MiddlewareHandler<ApiEnv>, method: string): Promise<{ status: number; message: string } | null> {
  let passed = false;
  const res = await admin(c, async () => {
    passed = true;
  });
  if (passed) return null;
  const status = res instanceof Response ? res.status : 401;
  return status === 403
    ? { status, message: `${method} writes to the colony, and this deployment takes no writes: it has no admin token configured (FT_ADMIN_TOKEN). GetTask and ListTasks still answer.` }
    : { status, message: `${method} writes to the colony, and writes need the deployment's admin token: send it as an Authorization: Bearer header. GetTask and ListTasks need none.` };
}

/** The task facts of one intent, or null. */
async function factsOf(env: Env, colonyId: Id, id: Id): Promise<A2ATaskFacts | null> {
  const page = (await colonyStub(env, colonyId).a2aTasks({ id })) as A2APage;
  return page.tasks[0] ?? null;
}

/** Each landed task's commit, from the trunk writer when the colony no longer keeps its landing. Fails soft. */
async function fillCommits(env: Env, colonyId: Id, facts: A2ATaskFacts[]): Promise<void> {
  const missing = facts.filter((f) => f.landing && f.landing.commit === null);
  if (missing.length === 0) return;
  const trunk = env.TRUNK.get(env.TRUNK.idFromName(colonyId));
  await mapLimit(missing, COMMIT_LOOKUPS, async (f) => {
    try {
      const found = (await trunk.landingNote(f.landing!.id)) as { landing?: { trunkSha?: unknown } } | null;
      const sha = found?.landing?.trunkSha;
      if (typeof sha === "string" && sha !== "") f.landing!.commit = sha;
    } catch (err) {
      console.warn(`a2a: commit of landing ${f.landing!.id} in ${colonyId} not found: ${messageOf(err)}`);
    }
  });
}

/** A required task id param. */
function taskIdParam(params: Record<string, unknown>): Id {
  const id = params.id;
  if (typeof id !== "string" || id.trim() === "") throw invalid("params.id is required: the task's id, which is its intent's id");
  return id.trim();
}

function notFound(id: Id, ctx: TaskContext): A2AFault {
  return new A2AFault(A2A_ERRORS.taskNotFound, `no task ${id} in colony ${ctx.colonyId}: a task's id is the id of the intent SendMessage declared`);
}

/** SendMessage: declare an intent through the door POST /intents uses, and answer its task (or the twin's). */
async function send(env: Env, ctx: TaskContext, params: Record<string, unknown>, d: A2ADialect, waitMs: number, pollMs: number): Promise<unknown> {
  const config = isObject(params.configuration) ? params.configuration : {};
  if (config.taskPushNotificationConfig !== undefined || config.pushNotificationConfig !== undefined) {
    throw new A2AFault(A2A_ERRORS.pushNotSupported, "this agent sends no push notifications: leave out the push notification config and poll GetTask");
  }
  const modes = Array.isArray(config.acceptedOutputModes) ? config.acceptedOutputModes.filter((m): m is string => typeof m === "string") : [];
  if (modes.length > 0 && !modes.some((m) => /^(?:\*\/\*|text\/\*|text\/plain|application\/\*|application\/json)$/i.test(m.trim()))) {
    throw new A2AFault(A2A_ERRORS.contentTypeNotSupported, "this agent answers in text/plain and application/json: accept one of them");
  }
  // A message on an existing task is a follow-up, which this door does not take: say so before reading its parts.
  const named = isObject(params.message) ? params.message.taskId : undefined;
  if (typeof named === "string" && named.trim() !== "") {
    const taskId = named.trim();
    const existing = await factsOf(env, ctx.colonyId, taskId);
    if (!existing) throw notFound(taskId, ctx);
    const state = a2aState(existing.intent, existing.waiting === true);
    throw new A2AFault(
      A2A_ERRORS.unsupportedOperation,
      a2aTerminal(state)
        ? `task ${taskId} is ${state} and takes no more messages: send a new message without taskId to declare new work`
        : `this agent takes no follow-up messages on a task: CancelTask ${taskId} and send a new message, or follow it with GetTask`,
    );
  }
  const req = readSendMessage(params.message, ctx.colonyId);
  const colony = colonyStub(env, ctx.colonyId);
  // The same declaration as POST /intents, recorded as an agent's (an orchestrator's why is a claim review checks).
  const answer = await colony.declareIntent(
    {
      colonyId: ctx.colonyId,
      title: req.title,
      why: req.why,
      source: "agent",
      footprint: req.footprint,
      priority: req.priority ?? 1,
      createdBy: "a2a",
      ...(req.acceptance ? { acceptance: req.acceptance } : {}),
    },
    req.force === true ? { force: true } : {},
  );
  const twin = isTwinAnswer(answer) ? answer : null;
  const intent = answer.intent;
  let facts = (await factsOf(env, ctx.colonyId, intent.id)) ?? { intent, updatedAt: intent.createdAt };
  const blocking = d === "1.0" ? config.returnImmediately !== true : config.blocking === true;
  let lead: string | undefined;
  if (blocking && waitMs > 0) {
    const deadline = Date.now() + waitMs;
    const stopped = (f: A2ATaskFacts) => {
      const s = a2aState(f.intent, f.waiting === true);
      return a2aTerminal(s) || s === "input-required";
    };
    while (!stopped(facts) && Date.now() + pollMs <= deadline) {
      await new Promise((r) => setTimeout(r, pollMs));
      facts = (await factsOf(env, ctx.colonyId, intent.id)) ?? facts;
    }
    if (!stopped(facts)) lead = `It is still ${a2aState(facts.intent, facts.waiting === true)} after ${duration(waitMs)}; an intent can take minutes, so follow it with GetTask.`;
  }
  await fillCommits(env, ctx.colonyId, [facts]);
  const twinLead = twin
    ? `Nothing new was declared: this message matches intent ${twin.duplicateOf} ${JSON.stringify(clip(twin.intent.title, QUOTE_CHARS))}, so this task follows that intent. To declare it anyway, send the message again with "force": true in a data part.`
    : undefined;
  const task = renderTask(facts, d, ctx, {
    lead: [twinLead, lead].filter((s): s is string => !!s).join(" ") || undefined,
    ...(twin ? { extra: { duplicateOf: twin.duplicateOf, similar: twin.similar } } : {}),
  });
  return d === "1.0" ? { task } : task;
}

/** GetTask: one intent as a task, with its landing when it landed. */
async function get(env: Env, ctx: TaskContext, params: Record<string, unknown>, d: A2ADialect): Promise<unknown> {
  const id = taskIdParam(params);
  const h = params.historyLength;
  if (h !== undefined && h !== null && !(typeof h === "number" && Number.isInteger(h) && h >= 0)) throw invalid("historyLength must be a whole number of 0 or more");
  const facts = await factsOf(env, ctx.colonyId, id);
  if (!facts) throw notFound(id, ctx);
  await fillCommits(env, ctx.colonyId, [facts]);
  return renderTask(facts, d, ctx);
}

/** ListTasks: the colony's intents as tasks, latest update first, in pages. */
async function list(env: Env, ctx: TaskContext, params: Record<string, unknown>): Promise<unknown> {
  const states = statusFilter(params.status);
  const size = params.pageSize;
  if (size !== undefined && size !== null && !(typeof size === "number" && Number.isInteger(size) && size >= 0)) throw invalid(`pageSize must be a whole number from 1 to ${A2A_PAGE_MAX}`);
  const limit = typeof size === "number" && size > 0 ? Math.min(A2A_PAGE_MAX, size) : A2A_PAGE_DEFAULT;
  const token = params.pageToken;
  if (token !== undefined && token !== null && typeof token !== "string") throw invalid("pageToken must be the nextPageToken of an earlier page");
  const cursor = typeof token === "string" && token !== "" ? decodeCursor(token) : null;
  if (typeof token === "string" && token !== "" && !cursor) throw invalid("pageToken is not one this agent gave: start again without it");
  const since = params.statusTimestampAfter;
  let after: number | undefined;
  if (since !== undefined && since !== null && since !== "") {
    after = typeof since === "string" ? Date.parse(since) : Number.NaN;
    if (!Number.isFinite(after)) throw invalid("statusTimestampAfter must be an ISO 8601 time, such as 2026-10-14T12:00:00Z");
  }
  const includeArtifacts = params.includeArtifacts === true;
  const context = params.contextId;
  if (states === "none" || (typeof context === "string" && context !== "" && context !== ctx.colonyId)) {
    return { tasks: [], nextPageToken: "", pageSize: limit, totalSize: 0 };
  }
  const page = (await colonyStub(env, ctx.colonyId).a2aTasks({
    ...(states ? { states } : {}),
    ...(after !== undefined ? { after } : {}),
    limit,
    ...(cursor ? { cursor } : {}),
  })) as A2APage;
  if (includeArtifacts) await fillCommits(env, ctx.colonyId, page.tasks);
  return {
    tasks: page.tasks.map((f) => renderTask(f, "1.0", ctx, { artifacts: includeArtifacts })),
    nextPageToken: page.next ? encodeCursor(page.next) : "",
    pageSize: limit,
    totalSize: page.total,
  };
}

/** CancelTask: withdraw the intent; a task already canceled answers as it is, a completed or failed one cannot be. */
async function cancel(env: Env, ctx: TaskContext, params: Record<string, unknown>, d: A2ADialect): Promise<unknown> {
  const id = taskIdParam(params);
  const before = await factsOf(env, ctx.colonyId, id);
  if (!before) throw notFound(id, ctx);
  const was = a2aState(before.intent, before.waiting === true);
  if (was === "canceled") return renderTask(before, d, ctx);
  if (was === "completed" || was === "failed") {
    await fillCommits(env, ctx.colonyId, [before]);
    throw new A2AFault(A2A_ERRORS.taskNotCancelable, `task ${id} is ${was}: ${statusText(before, ctx)}`);
  }
  const meta = isObject(params.metadata) ? params.metadata : {};
  const why = typeof meta.reason === "string" ? clip(meta.reason, 300) : "";
  let unconfirmed = false;
  try {
    const res = (await colonyStub(env, ctx.colonyId).withdrawIntent(id, { reason: why ? `${A2A_CANCEL_REASON}: ${why}` : A2A_CANCEL_REASON, by: "a2a" })) as { confirmed?: boolean };
    unconfirmed = res?.confirmed === false;
  } catch (err) {
    if (isUnsupportedRpc(err)) throw err;
    const { status, message } = decodeError(err);
    if (status === 404) throw notFound(id, ctx);
    if (status === 409) throw new A2AFault(A2A_ERRORS.taskNotCancelable, `task ${id} cannot be canceled: ${message}`);
    throw err;
  }
  const after = (await factsOf(env, ctx.colonyId, id)) ?? before;
  if (after.intent.status === "landed") {
    await fillCommits(env, ctx.colonyId, [after]);
    throw new A2AFault(A2A_ERRORS.taskNotCancelable, `task ${id} landed before the cancel reached the trunk writer: ${statusText(after, ctx)} ft revert undoes a landing.`);
  }
  const lead = unconfirmed ? "The trunk writer did not confirm in time: a change already on its way may still land, and GetTask will then say completed." : undefined;
  return renderTask(after, d, ctx, lead ? { lead } : {});
}
