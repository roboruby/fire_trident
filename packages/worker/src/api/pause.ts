import type { Context, Hono, MiddlewareHandler } from "hono";
import type { Id, PauseScope, PauseState } from "@fire_trident/core";
import { z } from "zod";
import type { Env } from "../env.ts";
import { ftError } from "../colony/errors.ts";
import {
  DEPLOYMENT_PAUSE_KEY,
  MAX_PAUSE_BY,
  MAX_PAUSE_REASON,
  cleanBy,
  cleanReason,
  parseRecord,
  stateOf,
  type PauseAnswer,
  type PauseRecord,
  type PauseView,
  type ResumeAnswer,
} from "../colony/pause.ts";
import type { ApiEnv } from "./app.ts";
import { mapLimit, messageOf } from "./logic.ts";
import { registryStub } from "./ops.ts";

/**
 * Pause routes (colony/pause.ts; registered by createApi). Pausing needs no flag: nothing changes until a person pauses.
 *   GET  /pause                    the deployment's pause in force, or null (public)
 *   POST /pause                    { reason, by? }: pause the agents of every colony on the deployment (admin)
 *   POST /resume                   { by?, reason? }: resume them; a colony paused on its own stays paused (admin)
 *   GET  /colonies/:id/pause       the colony's pauses in force and the sentence an agent's write meets (public)
 *   POST /colonies/:id/pause       { reason, by? }: pause the colony's agents (201; 200 when a pause already stands) (admin)
 *   POST /colonies/:id/resume      { by?, reason? }: resume them; a deployment pause in force still holds them (admin)
 * Other code trips the switch with pauseColony or pauseDeployment, naming itself as `by` (a spend cap does).
 */

/** POST /pause and POST /colonies/:id/pause. */
export const PauseBody = z.object({
  reason: z.string().trim().min(1).max(MAX_PAUSE_REASON),
  by: z.string().trim().min(1).max(MAX_PAUSE_BY).optional(),
});

/** POST /resume and POST /colonies/:id/resume. */
export const ResumeBody = z.object({
  by: z.string().trim().min(1).max(MAX_PAUSE_BY).optional(),
  reason: z.string().trim().max(MAX_PAUSE_REASON).optional(),
});

/** Colonies told of a deployment change at once. */
const TELL_CONCURRENCY = 20;

/** Which colonies heard of a change of the deployment's switch (each also reads it again within seconds by itself). */
export interface Told {
  total: number;
  told: number;
  failed: Array<{ colonyId: Id; error: string }>;
}

/** What pausing the deployment answers. */
export interface DeploymentPauseAnswer {
  pause: PauseState;
  already: boolean;
  colonies: Told;
}

/** What resuming the deployment answers: the pause it ended (null when none was in force). */
export interface DeploymentResumeAnswer {
  resumed: (PauseRecord & { scope: PauseScope }) | null;
  already: boolean;
  colonies: Told;
}

type ColonyPauseRpc = {
  pause(p: { reason: string; by?: string }): Promise<PauseAnswer>;
  resume(p: { by?: string; reason?: string }): Promise<ResumeAnswer>;
  pauseState(): Promise<PauseView>;
  deploymentPause(record: unknown): Promise<{ changed: boolean; writer: boolean | null }>;
};

function colonyRpc(env: Pick<Env, "COLONY">, colonyId: Id): ColonyPauseRpc {
  return env.COLONY.get(env.COLONY.idFromName(colonyId)) as unknown as ColonyPauseRpc;
}

/** Pause one colony's agents, as `by` (a person's name, or the code acting for one), for `reason`. */
export async function pauseColony(env: Pick<Env, "COLONY">, colonyId: Id, p: { reason: string; by: string }): Promise<PauseAnswer> {
  return colonyRpc(env, colonyId).pause({ reason: p.reason, by: p.by });
}

/** Resume one colony's agents, as `by`. */
export async function resumeColony(env: Pick<Env, "COLONY">, colonyId: Id, p: { by: string; reason?: string }): Promise<ResumeAnswer> {
  return colonyRpc(env, colonyId).resume({ by: p.by, ...(p.reason ? { reason: p.reason } : {}) });
}

/** The deployment's pause in force, from the registry; null when none is, or when the registry does not answer. */
export async function deploymentPause(env: Pick<Env, "COLONY">): Promise<PauseState | null> {
  try {
    return stateOf(parseRecord(await registryStub(env).registryFlag(DEPLOYMENT_PAUSE_KEY)), "deployment");
  } catch (err) {
    console.warn(`pause: the deployment's switch was not read: ${messageOf(err)}`);
    return null;
  }
}

/**
 * Pause the agents of every colony on the deployment, as `by`, for `reason`: the registry keeps the record, and every
 * registered colony is told at once (one that is not reads it again within seconds by itself). A pause already in
 * force stands as it is (`already`), and every colony is told of it again.
 */
export async function pauseDeployment(env: Pick<Env, "COLONY">, p: { reason: string; by: string }, now = Date.now()): Promise<DeploymentPauseAnswer> {
  const registry = registryStub(env);
  const prev = parseRecord(await registry.registryFlag(DEPLOYMENT_PAUSE_KEY));
  if (prev?.paused) return { pause: stateOf(prev, "deployment")!, already: true, colonies: await tellColonies(env, prev) };
  const reason = cleanReason(p.reason);
  if (!reason) throw ftError(400, "a reason is required: agents and people see it while the deployment is paused");
  const rec: PauseRecord = { paused: true, by: cleanBy(p.by), reason, at: now };
  await registry.registryFlag(DEPLOYMENT_PAUSE_KEY, JSON.stringify(rec));
  return { pause: stateOf(rec, "deployment")!, already: false, colonies: await tellColonies(env, rec) };
}

/**
 * Resume the agents of every colony on the deployment, as `by`. A colony paused on its own stays paused. With no
 * pause in force, every colony is told so again (a marker lost from the registry still ends its colonies' copies).
 */
export async function resumeDeployment(env: Pick<Env, "COLONY">, p: { by: string; reason?: string }, now = Date.now()): Promise<DeploymentResumeAnswer> {
  const registry = registryStub(env);
  const prev = parseRecord(await registry.registryFlag(DEPLOYMENT_PAUSE_KEY));
  if (!prev?.paused) {
    const standing = prev ?? { paused: false, by: cleanBy(p.by), reason: "", at: now };
    if (!prev) await registry.registryFlag(DEPLOYMENT_PAUSE_KEY, JSON.stringify(standing));
    return { resumed: null, already: true, colonies: await tellColonies(env, standing) };
  }
  const rec: PauseRecord = { paused: false, by: cleanBy(p.by), reason: cleanReason(p.reason), at: now, pausedAt: prev.at };
  await registry.registryFlag(DEPLOYMENT_PAUSE_KEY, JSON.stringify(rec));
  return { resumed: { scope: "deployment", ...rec }, already: false, colonies: await tellColonies(env, rec) };
}

/** Push a record of the deployment's switch to every registered colony. Failures are reported, never thrown. */
async function tellColonies(env: Pick<Env, "COLONY">, rec: PauseRecord): Promise<Told> {
  let ids: Id[];
  try {
    ids = (await registryStub(env).listColonies()).map((e) => e.id);
  } catch (err) {
    return { total: 0, told: 0, failed: [{ colonyId: "*", error: `the registry did not list the colonies: ${messageOf(err)}` }] };
  }
  const results = await mapLimit(ids, TELL_CONCURRENCY, (id) => colonyRpc(env, id).deploymentPause(rec));
  const failed: Told["failed"] = [];
  results.forEach((r, i) => {
    if (r.status === "rejected") failed.push({ colonyId: ids[i] ?? "", error: messageOf(r.reason) });
  });
  return { total: ids.length, told: ids.length - failed.length, failed: failed.slice(0, 20) };
}

/** Register the pause routes on the API. `admin` is the API's write check (requireAdmin). */
export function pauseRoutes(app: Hono<ApiEnv>, admin: MiddlewareHandler<ApiEnv>): void {
  app.get("/pause", async (c) => json({ pause: await deploymentPause(c.env) }));

  app.post("/pause", admin, async (c) => {
    const b = await parse(c, PauseBody, '{ "reason": "why the agents stop" }');
    const res = await pauseDeployment(c.env, { reason: b.reason, by: b.by ?? "api" });
    return json(res, res.already ? 200 : 201);
  });

  app.post("/resume", admin, async (c) => {
    const b = await parse(c, ResumeBody, "{} or { \"by\": \"your name\" }");
    return json(await resumeDeployment(c.env, { by: b.by ?? "api", ...(b.reason ? { reason: b.reason } : {}) }));
  });

  app.get("/colonies/:id/pause", async (c) => {
    const id = colonyId(c);
    return json({ colonyId: id, ...(await colonyRpc(c.env, id).pauseState()) });
  });

  app.post("/colonies/:id/pause", admin, async (c) => {
    const id = colonyId(c);
    const b = await parse(c, PauseBody, '{ "reason": "why the agents stop" }');
    const res = await pauseColony(c.env, id, { reason: b.reason, by: b.by ?? "api" });
    return json({ colonyId: id, ...res }, res.already ? 200 : 201);
  });

  app.post("/colonies/:id/resume", admin, async (c) => {
    const id = colonyId(c);
    const b = await parse(c, ResumeBody, "{} or { \"by\": \"your name\" }");
    return json({ colonyId: id, ...(await resumeColony(c.env, id, { by: b.by ?? "api", ...(b.reason ? { reason: b.reason } : {}) })) });
  });
}

/** A JSON body checked against `schema` (an empty body is `{}`); a 400 that shows what to send otherwise. */
async function parse<S extends z.ZodType>(c: Context<ApiEnv>, schema: S, example: string): Promise<z.output<S>> {
  let raw: unknown;
  try {
    const text = await c.req.text();
    raw = text.trim() ? JSON.parse(text) : {};
  } catch {
    throw ftError(400, "body must be JSON");
  }
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.map(String).join(".") || "body"}: ${i.message}`);
  throw ftError(400, `invalid request: ${issues.join("; ")}. Send ${example}`);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

function colonyId(c: Context<ApiEnv>): Id {
  const id = c.req.param("id") ?? "";
  if (!/^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/.test(id)) throw ftError(404, "colony not found");
  return id;
}
