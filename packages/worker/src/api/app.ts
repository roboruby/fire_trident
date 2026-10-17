import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { regionKey, spentOnIntent } from "@fire_trident/core";
import type { FieldReading, Id, RepoRef, Sha } from "@fire_trident/core";
import type { z } from "zod";
import type { Env } from "../env.ts";
import { decodeError, ftError } from "../colony/errors.ts";
import { slug } from "../colony/logic.ts";
import { flag, isUnsupportedRpc, mapLimit, messageOf, withheldFromAuthors } from "./logic.ts";
import { UPGRADING, deleteColony, listAgents, listColonies, registerColony, stopAgents, stopSwarm } from "./ops.ts";
import {
  AgentBody,
  AmendIntentBody,
  CreateColonyBody,
  DecisionBody,
  RevertBody,
  DirectiveBody,
  EscalationBody,
  IntentBody,
  ProposalBody,
  RuleBody,
  StatusBody,
  StopBody,
  SwarmBody,
  SwarmStopBody,
  WhyQuery,
  WithdrawBody,
} from "./schemas.ts";
import { decideApi } from "./vaccinate.ts";
import { inlineEnabled } from "../colony/inline.ts";
import { isTwinAnswer } from "../colony/twins.ts";
import { priorityNote } from "../colony/priority.ts";
import { certifyRoutes } from "./certify.ts";
import { guideRoutes } from "./guide.ts";
import { megafileRoutes } from "./megafile.ts";
import { landingRoutes, verifyLanding } from "./landing.ts";
import { impactRoutes } from "./impact.ts";
import { rootRoutes } from "./root.ts";
import { a2aRoutes } from "./a2a.ts";
import { pauseRoutes } from "./pause.ts";
import { refuseWhilePaused } from "../colony/pause.ts";
import { bearerMatches } from "./token.ts";

/** Hono environment of the API. */
export type ApiEnv = { Bindings: Env };

/** Options for spawning in-platform agents. */
export interface SwarmOptions {
  count: number;
  kind?: "internal" | "synthetic";
  model?: string;
}

/** What the API calls outside the Durable Objects (injected so tests can substitute them). */
export interface ApiDeps {
  provisionTrunk: (env: Env, colonyId: Id, source?: { url: string; branch?: string }) => Promise<{ trunk: RepoRef; trunkSha: Sha }>;
  spawnSwarm: (env: Env, colonyId: Id, opts: SwarmOptions) => Promise<unknown>;
}

/** Default warm-pool size for a new colony. */
export const DEFAULT_POOL_TARGET = 16;
/** Regions read per GET /field (all-regions form). */
const MAX_FIELD_REGIONS = 500;
/** Region readings in flight at once for GET /field. */
const FIELD_CONCURRENCY = 50;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
}

// Bearer checks against the deployment's secrets go through api/token.ts, which drops a configured secret's line break.
export { tokensEqual } from "./token.ts";

/**
 * Mutating routes need `Authorization: Bearer <FT_ADMIN_TOKEN>`. Without that secret they refuse
 * (fail closed), unless FT_OPEN_WRITES is "1", which is for local development only.
 */
export const requireAdmin: MiddlewareHandler<ApiEnv> = async (c, next) => {
  const expected = c.env.FT_ADMIN_TOKEN;
  if (expected) {
    const m = /^Bearer\s+(\S+)\s*$/i.exec(c.req.header("Authorization") ?? "");
    if (!m || !(await bearerMatches(m[1] ?? "", expected))) return json({ error: "unauthorized" }, 401, { "WWW-Authenticate": "Bearer" });
  } else if (c.env.FT_OPEN_WRITES !== "1") {
    return json({ error: "forbidden: writes need FT_ADMIN_TOKEN configured on the server" }, 403);
  }
  await next();
};

/** Whether a request carries the admin bearer token (for reads that show more to the operator). */
export async function isAdminRequest(c: Context<ApiEnv>): Promise<boolean> {
  const expected = c.env.FT_ADMIN_TOKEN;
  if (!expected) return false;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(c.req.header("Authorization") ?? "");
  return !!m && (await bearerMatches(m[1] ?? "", expected));
}

/** An Artifacts remote's host names the account: public readers get `artifacts://<namespace>/<repo>.git` instead. */
const ARTIFACTS_REMOTE = /https:\/\/[0-9a-f]{32}\.artifacts\.cloudflare\.net\/git\//g;

/** Public JSON reads show Artifacts remotes without the account id; callers with the admin token see them as they are. */
export const hideRemotes: MiddlewareHandler<ApiEnv> = async (c, next) => {
  await next();
  if (c.req.method !== "GET" || !(c.res.headers.get("content-type") ?? "").includes("application/json")) return;
  if (await isAdminRequest(c)) return;
  const text = await c.res.text();
  c.res = new Response(text.replace(ARTIFACTS_REMOTE, "artifacts://"), c.res);
};

/** Destructive routes always need the admin token: they refuse outright when FT_ADMIN_TOKEN is not configured. */
export const requireAdminStrict: MiddlewareHandler<ApiEnv> = async (c, next) => {
  if (!c.env.FT_ADMIN_TOKEN) return json({ error: "forbidden: this route needs FT_ADMIN_TOKEN configured on the server" }, 403);
  return requireAdmin(c, next);
};

/** Parse and validate an optional JSON body (empty means `{}`); throws a 400 with the zod issues. */
async function optionalBody<S extends z.ZodType>(c: Context<ApiEnv>, schema: S): Promise<z.output<S>> {
  const text = await c.req.text();
  if (!text.trim()) return validate(schema, {});
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw ftError(400, "body must be JSON");
  }
  return validate(schema, raw);
}

/** Parse and validate a JSON body; throws a 400 with the zod issues. */
async function body<S extends z.ZodType>(c: Context<ApiEnv>, schema: S): Promise<z.output<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw ftError(400, "body must be JSON");
  }
  return validate(schema, raw);
}

function validate<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.slice(0, 10).map((i) => `${i.path.map(String).join(".") || "body"}: ${i.message}`);
  throw ftError(400, `invalid request: ${issues.join("; ")}`);
}

function colonyStub(env: Env, colonyId: Id) {
  return env.COLONY.get(env.COLONY.idFromName(colonyId));
}

function regionStub(env: Env, colonyId: Id, region: string) {
  return env.REGION.get(env.REGION.idFromName(regionKey(colonyId, region)));
}

function trunkStub(env: Env, colonyId: Id) {
  return env.TRUNK.get(env.TRUNK.idFromName(colonyId));
}

function poolStub(env: Env, colonyId: Id) {
  return env.POOL.get(env.POOL.idFromName(colonyId));
}

/** Colony ids are slugs; anything else cannot name a colony. */
function colonyParam(c: Context<ApiEnv>): Id {
  const id = c.req.param("id") ?? "";
  if (!/^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/.test(id)) throw ftError(404, "colony not found");
  return id;
}

async function requireColony(env: Env, colonyId: Id): Promise<void> {
  if (!(await colonyStub(env, colonyId).getColony())) throw ftError(404, "colony not found");
}

/**
 * Build the REST API (mounted at /api). Route table:
 *   GET    /colonies                        every colony with live counters (?scan=1 re-scans trunks)
 *   POST   /colonies                        create/import a colony
 *   GET    /colonies/:id                    ColonySnapshot (+ rules, series)
 *   DELETE /colonies/:id                    stop agents, delete repos and object storage, unregister
 *   GET    /colonies/:id/live               WebSocket of ColonyEvent (JSON arrays)
 *   GET    /colonies/:id/field              FieldReading[] (all regions, or ?region=)
 *   GET    /colonies/:id/metrics            metrics, funnel, violations, per-minute series
 *   GET    /colonies/:id/events             the event record for replays (?after=&limit=, paged; ?source=)
 *   POST   /colonies/:id/intents            declare an intent
 *   GET    /colonies/:id/intents/:iid       one intent with its revision history and directives (and its model spend, FT_INTENT_SPEND)
 *   GET    /colonies/:id/intents/:iid/spend what the intent's model calls cost: agents and review, by model (FT_INTENT_SPEND)
 *   PATCH  /colonies/:id/intents/:iid       amend an intent (revision + 1; stale work goes back)
 *   POST   /colonies/:id/intents/:iid/withdraw  withdraw an intent (needs evaporate, holder stops)
 *   POST   /colonies/:id/intents/:iid/escalation  answer an agent's report: amend | withdraw | dismiss
 *   GET    /colonies/:id/escalations        agents' reports waiting for a person (the intents, newest first)
 *   POST   /colonies/:id/rules              add a morphology rule (creates needs)
 *   DELETE /colonies/:id/rules/:rid         retract a rule (kept in history; its unlanded intents withdrawn)
 *   GET    /colonies/:id/agents             agents with state, intent, model, journal step (?all=1, ?journal=0)
 *   POST   /colonies/:id/agents             register an agent
 *   POST   /colonies/:id/agents/:aid/take   self-assign work + workspace lease
 *   POST   /colonies/:id/agents/:aid/heartbeat
 *   POST   /colonies/:id/agents/:aid/stop   stop one agent (claims released)
 *   POST   /colonies/:id/agents/:aid/directive  free-text guidance (pushed in-platform, inbox otherwise)
 *   POST   /colonies/:id/agents/:aid/status the agent's one-line "what I am doing now"
 *   GET    /colonies/:id/agents/:aid/inbox  the agent's proposals and directives, newest first
 *   POST   /colonies/:id/proposals          propose a change
 *   GET    /colonies/:id/proposals/:pid     one proposal (poll its outcome)
 *   GET    /colonies/:id/why                ?path=&line=
 *   GET    /colonies/:id/notes/verify       the newest landings' git notes against their commits' FT-Note trailers (?limit=; ?landing= checks one, api/landing.ts)
 *   GET    /colonies/:id/landings/:ref/diff the change a landing made to one file (?path=; public colonies only, api/landing.ts)
 *   GET    /colonies/:id/review             review queue
 *   POST   /colonies/:id/review/:pid        approve | reject | return
 *   POST   /colonies/:id/swarm              spawn in-platform agents
 *   POST   /colonies/:id/swarm/stop         stop every running in-platform agent
 *   GET    /colonies/:id/certifications     trunk certification results and state (api/certify.ts; also POST certify, certify/policy)
 *   GET    /colonies/:id/guide              the field guide's active lessons (api/guide.ts; candidates with the admin token; POST guide/:lessonId approves or rejects)
 *   GET    /colonies/:id/megafile           files held for their split (api/megafile.ts; POST holds or releases one)
 *   GET    /colonies/:id/impact             ?path=&depth=: what a change reaches through imports, and who works on it now (api/impact.ts)
 *   GET    /colonies/:id/root               the colony's root commit: the first commit of trunk, which pins a clone (api/root.ts)
 *   GET    /colonies/:id/.well-known/agent-card.json  the colony's Agent2Agent card (FT_A2A; api/a2a.ts)
 *   POST   /colonies/:id/a2a                Agent2Agent JSON-RPC: SendMessage and CancelTask (admin token), GetTask, ListTasks (api/a2a.ts)
 *   POST   /colonies/:id/pause | /resume    a person pauses or resumes the colony's agents; POST /pause and /resume the deployment's (api/pause.ts)
 * POST routes require the admin bearer token when FT_ADMIN_TOKEN is set; DELETE always does.
 */
export function createApi(deps: ApiDeps): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();
  app.use("*", hideRemotes);

  app.onError((err, c) => {
    // Deploys reach Durable Objects gradually: an object still on the previous class lacks new methods for a while.
    if (isUnsupportedRpc(err)) return json({ error: `${UPGRADING} (${messageOf(err)})` }, 503, { "Retry-After": "30" });
    const { status, message } = decodeError(err);
    if (status >= 500) console.error(`${c.req.method} ${c.req.path} failed: ${message}`);
    return json({ error: message }, status);
  });
  app.notFound((c) => json({ error: `no route for ${c.req.method} ${c.req.path}` }, 404));

  app.get("/", () => json({ service: "firetrident", version: "0.0.1" }));

  app.get("/colonies", async (c) => {
    const res = await listColonies(c.env, { scan: flag(c.req.query("scan")) });
    return json({ total: res.colonies.length, scanned: res.scanned, colonies: res.colonies });
  });

  app.post("/colonies", requireAdmin, async (c) => {
    const b = await body(c, CreateColonyBody);
    const colonyId = slug(b.name);
    if (!colonyId) throw ftError(400, "name must contain letters or digits");
    const colony = colonyStub(c.env, colonyId);
    const existing = await colony.getColony();
    if (existing) {
      await registerColony(c.env, { id: existing.id, name: existing.name, ...(existing.source ? { source: existing.source } : {}), createdAt: existing.createdAt });
      return json({ error: `colony ${colonyId} already exists`, colony: existing }, 409);
    }
    const provisioned = await deps.provisionTrunk(c.env, colonyId, b.source);
    const trunk = provisioned.trunk;
    const initialized = await trunkStub(c.env, colonyId).init({ colonyId, trunk });
    await poolStub(c.env, colonyId).init({ colonyId, trunk, target: b.poolTarget ?? b.pool ?? DEFAULT_POOL_TARGET });
    const created = await colony.init({
      colonyId,
      name: b.name,
      trunk,
      trunkSha: initialized?.trunkSha || provisioned.trunkSha,
      ...(b.source ? { source: b.source } : {}),
      ...(b.regionDepth !== undefined ? { regionDepth: b.regionDepth } : {}),
    });
    await registerColony(c.env, { id: created.id, name: created.name, ...(created.source ? { source: created.source } : {}), createdAt: created.createdAt });
    return json(created, 201);
  });

  app.get("/colonies/:id", async (c) => {
    const colony = colonyStub(c.env, colonyParam(c));
    // The colony's model spend beside its snapshot (colony/spend.ts); an object still on older code has none to give.
    const [snap, spend] = await Promise.all([colony.snapshot(), colony.spend().catch(() => null)]);
    return json(spend ? { ...(snap as object), spend } : snap);
  });

  app.delete("/colonies/:id", requireAdminStrict, async (c) => {
    const report = await deleteColony(c.env, colonyParam(c));
    if (report.ok) return json(report);
    const failed = [...report.agents.failed.map((f) => `agent ${f.agentId}: ${f.error}`), ...report.repos.failed.map((f) => `repo ${f.repo}: ${f.error}`)];
    return json({ ...report, error: `delete incomplete (retry to finish): ${failed.slice(0, 5).join("; ")}` }, 502);
  });

  app.get("/colonies/:id/metrics", async (c) => json(await colonyStub(c.env, colonyParam(c)).metricsReport()));

  // The event record for replays, oldest first: ?after=<seq>&limit=<n> (paged), ?source=recorded|reconstructed.
  app.get("/colonies/:id/events", async (c) => {
    const colonyId = colonyParam(c);
    const int = (raw: string | undefined, fallback: number): number => (raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : fallback);
    const raw = c.req.query("source");
    const source = raw === "recorded" || raw === "reconstructed" ? raw : "auto";
    const page = await colonyStub(c.env, colonyId).eventsPage({ after: int(c.req.query("after"), 0), limit: int(c.req.query("limit"), 1_000), source });
    return json(page);
  });

  app.get("/colonies/:id/agents", async (c) => {
    const colonyId = colonyParam(c);
    const limitRaw = c.req.query("limit");
    const limit = limitRaw !== undefined && /^\d+$/.test(limitRaw) ? Math.max(1, Number(limitRaw)) : undefined;
    const journal = c.req.query("journal");
    const agents = await listAgents(c.env, colonyId, {
      includeDead: flag(c.req.query("all")),
      journal: journal === undefined || flag(journal),
      ...(limit !== undefined ? { limit } : {}),
    });
    const byState: Record<string, number> = {};
    const byKind: Record<string, number> = {};
    for (const a of agents) {
      byState[a.state] = (byState[a.state] ?? 0) + 1;
      byKind[a.kind] = (byKind[a.kind] ?? 0) + 1;
    }
    return json({ colonyId, total: agents.length, byState, byKind, agents });
  });

  app.post("/colonies/:id/agents/:aid/stop", requireAdmin, async (c) => {
    const colonyId = colonyParam(c);
    const agentId = c.req.param("aid");
    const b = await optionalBody(c, StopBody);
    const agent = await colonyStub(c.env, colonyId).getAgent(agentId);
    if (!agent) throw ftError(404, `unknown agent ${agentId}`);
    const report = await stopAgents(c.env, colonyId, [{ id: agent.id, kind: agent.kind }], b.reason ?? "stopped by request");
    const failure = report.failed[0];
    if (failure) return json({ ok: false, agentId, ...report, error: `agent ${agentId} did not stop: ${failure.error}` }, 502);
    return json({ ok: true, agentId, kind: agent.kind, ...report });
  });

  app.post("/colonies/:id/swarm/stop", requireAdmin, async (c) => {
    const colonyId = colonyParam(c);
    const b = await optionalBody(c, SwarmStopBody);
    await requireColony(c.env, colonyId);
    const report = await stopSwarm(c.env, colonyId, b.reason ?? "swarm stopped by request", b.all === true);
    if (report.failed.length > 0) {
      return json({ ok: false, colonyId, ...report, error: `${report.failed.length} agent(s) did not stop: ${report.failed.slice(0, 3).map((f) => `${f.agentId}: ${f.error}`).join("; ")}` }, 502);
    }
    return json({ ok: true, colonyId, ...report });
  });

  app.get("/colonies/:id/live", async (c) => {
    const colonyId = colonyParam(c);
    if ((c.req.header("Upgrade") ?? "").toLowerCase() !== "websocket") return json({ error: "expected a WebSocket upgrade" }, 426);
    return colonyStub(c.env, colonyId).fetch(c.req.raw);
  });

  app.get("/colonies/:id/field", async (c) => {
    const colonyId = colonyParam(c);
    const colony = colonyStub(c.env, colonyId);
    await requireColony(c.env, colonyId);
    // Only regions the colony has touched: a query never creates a region object.
    const known = await colony.listRegions();
    const only = c.req.query("region");
    if (only !== undefined && !known.includes(only)) throw ftError(404, `unknown region ${only}`);
    const regions = only !== undefined ? [only] : known.slice(0, MAX_FIELD_REGIONS);
    const results = await mapLimit(regions, FIELD_CONCURRENCY, async (region) => (await regionStub(c.env, colonyId, region).reading()) as FieldReading);
    const readings: FieldReading[] = [];
    results.forEach((r, i) => {
      const region = regions[i] ?? "";
      // The colony's region name (a directory path, "." for root files) labels the reading and its sigma.
      if (r.status === "fulfilled") readings.push({ ...r.value, region });
      else console.warn(`field: region ${region} of ${colonyId} unreadable: ${messageOf(r.reason)}`);
    });
    return json(readings);
  });

  app.post("/colonies/:id/intents", requireAdmin, async (c) => {
    const colonyId = colonyParam(c);
    const b = await body(c, IntentBody);
    // Twin intents (FT_TWINS, colony/twins.ts): a declaration that matches an intent the colony has answers 200 with that
    // intent, duplicateOf, similar and a note instead of creating one; force: true declares it anyway.
    const res = await colonyStub(c.env, colonyId).declareIntent({
      colonyId,
      title: b.title,
      why: b.why,
      source: b.source,
      footprint: b.footprint,
      priority: b.priority,
      createdBy: b.createdBy ?? "api",
      ...(b.acceptance ? { acceptance: b.acceptance } : {}),
      ...(b.parentId ? { parentId: b.parentId } : {}),
      ...(b.ruleId ? { ruleId: b.ruleId } : {}),
      ...(b.assignedTo ? { assignedTo: b.assignedTo } : {}),
      ...(b.contest !== undefined ? { contest: b.contest } : {}),
    }, b.force === true ? { force: true } : {});
    if (isTwinAnswer(res)) return json({ ...res.intent, duplicateOf: res.duplicateOf, similar: res.similar, note: res.note }, 200);
    // An agent's intent takes at most the priority of a parent it holds or declared, else 1: the answer says what it got (colony/priority.ts).
    const priority = priorityNote(res.intent);
    return json(priority ? { ...res.intent, priorityNote: priority } : res.intent, 201);
  });

  app.post("/colonies/:id/rules", requireAdmin, async (c) => {
    const colonyId = colonyParam(c);
    const b = await body(c, RuleBody);
    const res = await colonyStub(c.env, colonyId).addRule({ colonyId, kind: b.kind, spec: b.spec, description: b.description, approvedBy: b.approvedBy ?? "api" });
    return json(res, 201);
  });

  // Changing direction: amend or withdraw an intent, retract a rule, direct an agent, relay status.

  app.get("/colonies/:id/intents/:iid", async (c) => {
    const colony = colonyStub(c.env, colonyParam(c));
    // The intent's model spend beside its history (colony/intentspend.ts); an object still on older code has none to give.
    const [res, spend] = await Promise.all([colony.intentHistory(c.req.param("iid")), colony.intentSpend(c.req.param("iid")).catch(() => null)]);
    if (!res) throw ftError(404, `unknown intent ${c.req.param("iid")}`);
    return json(spend && spentOnIntent(spend) ? { ...(res as object), spend } : res);
  });

  // Spend per intent (colony/intentspend.ts): what one intent's model calls cost, public like the other reads.
  app.get("/colonies/:id/intents/:iid/spend", async (c) => {
    const res = await colonyStub(c.env, colonyParam(c)).intentSpend(c.req.param("iid"));
    if (!res) throw ftError(404, `unknown intent ${c.req.param("iid")}`);
    return json(res);
  });

  app.patch("/colonies/:id/intents/:iid", requireAdmin, async (c) => {
    const b = await body(c, AmendIntentBody);
    const res = await colonyStub(c.env, colonyParam(c)).amendIntent(c.req.param("iid"), {
      ...(b.title !== undefined ? { title: b.title } : {}),
      ...(b.why !== undefined ? { why: b.why } : {}),
      ...(b.footprint !== undefined ? { footprint: b.footprint } : {}),
      ...(b.priority !== undefined ? { priority: b.priority } : {}),
      reason: b.reason,
      by: b.by ?? "api",
    });
    return json(res);
  });

  app.post("/colonies/:id/intents/:iid/withdraw", requireAdmin, async (c) => {
    const b = await body(c, WithdrawBody);
    return json(await colonyStub(c.env, colonyParam(c)).withdrawIntent(c.req.param("iid"), { reason: b.reason, by: b.by ?? "api" }));
  });

  // Reports: an agent said an intent cannot be done as written; a person answers it (amend, withdraw or dismiss).
  app.post("/colonies/:id/intents/:iid/escalation", requireAdmin, async (c) => {
    const b = await body(c, EscalationBody);
    const amend = b.amend
      ? { ...(b.amend.title !== undefined ? { title: b.amend.title } : {}), ...(b.amend.why !== undefined ? { why: b.amend.why } : {}), ...(b.amend.footprint !== undefined ? { footprint: b.amend.footprint } : {}) }
      : undefined;
    const res = await colonyStub(c.env, colonyParam(c)).resolveEscalation(c.req.param("iid"), { decision: b.decision, note: b.note, by: b.by ?? "api", ...(amend ? { amend } : {}) });
    return json(res);
  });

  app.get("/colonies/:id/escalations", async (c) => {
    const colonyId = colonyParam(c);
    const intents = await colonyStub(c.env, colonyId).escalations();
    return json({ colonyId, total: intents.length, intents });
  });

  app.delete("/colonies/:id/rules/:rid", requireAdmin, async (c) => {
    const colonyId = colonyParam(c);
    // The reason comes in a JSON body or as ?reason= (some clients send no body with DELETE).
    const text = await c.req.text();
    let raw: Record<string, unknown> = {};
    if (text.trim()) {
      try {
        raw = JSON.parse(text) as Record<string, unknown>;
      } catch {
        throw ftError(400, "body must be JSON");
      }
    }
    const q = { reason: c.req.query("reason"), by: c.req.query("by") };
    const b = validate(WithdrawBody, { ...(q.reason !== undefined ? { reason: q.reason } : {}), ...(q.by !== undefined ? { by: q.by } : {}), ...raw });
    return json(await colonyStub(c.env, colonyId).retractRule(c.req.param("rid"), { reason: b.reason, by: b.by ?? "api" }));
  });

  app.post("/colonies/:id/agents/:aid/directive", requireAdmin, async (c) => {
    const b = await body(c, DirectiveBody);
    const d = await colonyStub(c.env, colonyParam(c)).direct(c.req.param("aid"), { message: b.message, ...(b.intentId ? { intentId: b.intentId } : {}), by: b.by ?? "api" });
    return json(d, 201);
  });

  app.post("/colonies/:id/agents/:aid/status", requireAdmin, async (c) => {
    const b = await body(c, StatusBody);
    return json(await colonyStub(c.env, colonyParam(c)).relay(c.req.param("aid"), b.note));
  });

  app.get("/colonies/:id/agents/:aid/inbox", requireAdmin, async (c) => {
    const raw = c.req.query("limit");
    const limit = raw !== undefined && /^\d+$/.test(raw) ? Math.max(1, Math.min(200, Number(raw))) : 20;
    return json(await colonyStub(c.env, colonyParam(c)).inbox(c.req.param("aid"), limit));
  });

  app.post("/colonies/:id/agents", requireAdmin, async (c) => {
    const colonyId = colonyParam(c);
    const b = await body(c, AgentBody);
    // An in-platform agent is one FireTrident runs (its notes say the model was observed), so only the platform starts one.
    if (b.kind === "internal") throw ftError(400, "in-platform agents are started by the platform (POST /api/colonies/:id/swarm); register an external or synthetic agent here");
    const agent = await colonyStub(c.env, colonyId).registerAgent({ kind: b.kind, name: b.name, ...(b.model ? { model: b.model } : {}) });
    return json(agent, 201);
  });

  app.post("/colonies/:id/agents/:aid/take", requireAdmin, async (c) => {
    return json(await colonyStub(c.env, colonyParam(c)).take(c.req.param("aid")));
  });

  app.post("/colonies/:id/agents/:aid/heartbeat", requireAdmin, async (c) => {
    await colonyStub(c.env, colonyParam(c)).heartbeat(c.req.param("aid"));
    return json({ ok: true });
  });

  app.post("/colonies/:id/proposals", requireAdmin, async (c) => {
    const colonyId = colonyParam(c);
    const b = await body(c, ProposalBody);
    // An inline change carries its files' text instead of a pushed commit; FT_INLINE says which colonies take one.
    if (b.contents !== undefined && !inlineEnabled(c.env.FT_INLINE, colonyId)) {
      throw ftError(409, "inline changes are off for this colony (FT_INLINE): push a commit to the workspace and propose its id");
    }
    const evidence = b.evidence
      ? {
          ...(b.evidence.checks ? { checks: b.evidence.checks.map((k) => ({ name: k.name, ok: k.ok, ms: k.ms, ...(k.detail !== undefined ? { detail: k.detail } : {}) })) } : {}),
          ...(b.evidence.notVerified !== undefined ? { notVerified: b.evidence.notVerified } : {}),
          ...(b.evidence.previewUrl !== undefined ? { previewUrl: b.evidence.previewUrl } : {}),
        }
      : undefined;
    // An in-platform agent proposes through the platform, never through this route: its notes say what FireTrident observed.
    if ((await colonyStub(c.env, colonyId).getAgent(b.agentId))?.kind === "internal") {
      throw ftError(403, `agent ${b.agentId} is an in-platform agent; it proposes through the platform, not this API`);
    }
    const proposal = await colonyStub(c.env, colonyId).propose({
      colonyId,
      intentId: b.intentId,
      agentId: b.agentId,
      workspace: b.workspace,
      baseSha: b.baseSha,
      headSha: b.headSha,
      writeSet: b.writeSet,
      readSet: b.readSet,
      declared: b.declared,
      ...(b.intentRevision !== undefined ? { intentRevision: b.intentRevision } : {}),
      ...(b.contents !== undefined ? { contents: b.contents } : {}),
      ...(evidence ? { evidence } : {}),
      // Field guide (FT_FIELD_GUIDE): the agent's lesson; the answer says what became of it where the guide is on.
      ...(b.lesson !== undefined ? { lesson: b.lesson } : {}),
    });
    return json(proposal, 201);
  });

  app.get("/colonies/:id/proposals/:pid", async (c) => {
    const proposal = await colonyStub(c.env, colonyParam(c)).getProposal(c.req.param("pid"));
    if (!proposal) throw ftError(404, "proposal not found");
    return json((await isAdminRequest(c)) ? proposal : withheldFromAuthors(proposal));
  });

  app.get("/colonies/:id/why", async (c) => {
    const colonyId = colonyParam(c);
    const q = validate(WhyQuery, { path: c.req.query("path"), line: c.req.query("line") });
    await requireColony(c.env, colonyId);
    return json(await trunkStub(c.env, colonyId).why(q.path, q.line));
  });

  // Tamper evidence: each of the newest landings' notes on the trunk repository against the digest its commit carries.
  app.get("/colonies/:id/notes/verify", async (c) => {
    const colonyId = colonyParam(c);
    // ?landing=<landing id or trunk commit>: that landing's note alone, the badge on each note in the web app (api/landing.ts).
    const landing = c.req.query("landing");
    if (landing !== undefined) return json(await verifyLanding(c.env, colonyId, landing));
    const raw = c.req.query("limit");
    if (raw !== undefined && !/^\d{1,4}$/.test(raw)) throw ftError(400, "limit must be a whole number");
    await requireColony(c.env, colonyId);
    return json(await trunkStub(c.env, colonyId).verifyNotes(raw === undefined ? undefined : Number(raw)));
  });

  app.get("/colonies/:id/review", async (c) => json(await colonyStub(c.env, colonyParam(c)).review()));

  app.post("/colonies/:id/review/:pid", requireAdmin, async (c) => {
    const colonyId = colonyParam(c);
    const b = await body(c, DecisionBody);
    await colonyStub(c.env, colonyId).decide(c.req.param("pid"), b.decision, b.reason, b.by ?? "human");
    return json({ ok: true });
  });

  app.post("/colonies/:id/landings/:ref/revert", requireAdmin, async (c) => {
    const colonyId = colonyParam(c);
    const b = await body(c, RevertBody);
    const p = { reason: b.reason, redo: b.redo, ...(b.by ? { by: b.by } : {}) };
    // One proposal has its own method: a colony object still on the previous class refuses it (503) rather than undo the whole landing.
    const stub = colonyStub(c.env, colonyId);
    return json(await (b.proposal ? stub.revertProposal(c.req.param("ref"), { ...p, proposal: b.proposal }) : stub.revertLanding(c.req.param("ref"), p)));
  });

  app.post("/colonies/:id/swarm", requireAdmin, async (c) => {
    const colonyId = colonyParam(c);
    const b = await body(c, SwarmBody);
    await requireColony(c.env, colonyId);
    // Pause (colony/pause.ts): no in-platform agent starts while the colony's agents are paused.
    await refuseWhilePaused(colonyStub(c.env, colonyId));
    const count = b.count ?? b.agents ?? 1;
    const res = await deps.spawnSwarm(c.env, colonyId, { count, ...(b.kind ? { kind: b.kind } : {}), ...(b.model ? { model: b.model } : {}) });
    return json(res ?? { ok: true }, 202);
  });

  app.route("/", decideApi); // Decide prong: vaccination meter, immune state, decide policy, detector feedback (api/vaccinate.ts)
  certifyRoutes(app, requireAdmin); // Trunk certification: results, certify now, policy (api/certify.ts)
  guideRoutes(app, requireAdmin, isAdminRequest); // Field guide: lessons agents left, and a person's approval or rejection (api/guide.ts)
  megafileRoutes(app, requireAdmin); // Megafile alarm: held files, a person's hold or release (api/megafile.ts)
  landingRoutes(app); // One landing's change to a file, for public colonies (api/landing.ts)
  impactRoutes(app); // Impact: what a change to a file reaches through imports, and who works on those files now (api/impact.ts)
  rootRoutes(app); // The colony's root commit, which pins a clone of its history (api/root.ts)
  a2aRoutes(app, requireAdmin); // Agent2Agent: an orchestrator declares intents and follows them as tasks (FT_A2A; api/a2a.ts)
  pauseRoutes(app, requireAdmin); // Pause: a person stops the agents of a colony or of the deployment, with a reason (api/pause.ts)

  // Unknown API paths answer JSON here instead of falling through to the static UI.
  app.all("*", (c) => json({ error: `no route for ${c.req.method} ${c.req.path}` }, 404));

  return app;
}
