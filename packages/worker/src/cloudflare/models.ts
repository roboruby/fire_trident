import { CF_API, hasWorkersAi, type ConnectEnv } from "./config.ts";
import { cloudflareGrantFor } from "./grant.ts";
import { ACCOUNT_ID, type HttpFetch } from "./oauth.ts";
import type { AccountId, CloudflareGrant } from "./types.ts";

/**
 * Model routing for colonies. An operator colony (no owner) runs its models on the deployment's Workers AI binding,
 * exactly as before: the binding itself is handed back. An owned colony runs them on its owner's Workers AI over
 * Cloudflare's REST API (POST /accounts/{account}/ai/run/{model}, bearer the owner's access token), with each result
 * unwrapped from the API's envelope so callers get what the binding would have given them. Spend accounting does not
 * change: the colony's wrappers (colony/spend.ts, colony/spendcap.ts) wrap whichever runner this gives.
 */

/** The calls the code makes on the Workers AI binding (decide/reflex.ts AiRunner has the same shape). */
export interface ModelRunner {
  run(model: string, input: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
}

/** Why an owned colony's model calls are off. */
export type ModelsOffReason = "no_workers_ai" | "not_connected";

/** The sentences a person or an agent reads when an owned colony's model calls are off. */
export const MODELS_OFF: Readonly<Record<ModelsOffReason, string>> = {
  no_workers_ai:
    "In-platform agents and model review are off: this colony's Cloudflare connection has no Workers AI access. Connect again and allow Workers AI, or bring your own agents over MCP.",
  not_connected:
    "In-platform agents and model review are off: this colony's owner has no working Cloudflare connection. Connect Cloudflare again on the account page, or bring your own agents over MCP.",
};

/** The typed refusal: an owned colony may not run models here. `message` is the sentence to show; status 409. */
export class ModelsOff extends Error {
  readonly code = "models_off";
  readonly status = 409;
  constructor(readonly reason: ModelsOffReason) {
    super(MODELS_OFF[reason]);
    this.name = "ModelsOff";
  }
}

/** Whether an error is the models-off refusal (also across a Durable Object call, where only the message survives). */
export function isModelsOff(e: unknown): boolean {
  if (e instanceof ModelsOff) return true;
  const msg = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  return Object.values(MODELS_OFF).some((s) => msg.includes(s));
}

/** A Workers AI model name as the REST path takes it ("@cf/<author>/<model>"); nothing that could leave /ai/run/. */
const MODEL_NAME = /^@[a-z0-9][a-z0-9_-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*){1,3}$/;

/** Whether `model` is a name the REST runner sends (no "..", no query, no other path). */
export function restModelName(model: string): boolean {
  return MODEL_NAME.test(model) && !model.split("/").includes("..");
}

/** A failed REST call, read the way the binding's errors are read (agents/throttle.ts, decide/reflex.ts isThrottled). */
export interface RestModelError extends Error {
  statusCode?: number;
  responseHeaders?: Record<string, string>;
}

function restError(status: number, body: unknown, headers: Headers): RestModelError {
  const errors = body && typeof body === "object" ? (body as { errors?: unknown }).errors : undefined;
  const first = Array.isArray(errors) ? (errors[0] as { code?: unknown; message?: unknown } | undefined) : undefined;
  const code = typeof first?.code === "number" || typeof first?.code === "string" ? String(first.code) : "";
  const message = typeof first?.message === "string" ? first.message.replace(/[\r\n]+/g, " ").slice(0, 300) : "";
  const text =
    status === 401 || status === 403
      ? `Cloudflare refused the owner's Workers AI call (HTTP ${status}${code ? `, ${code}` : ""}): the connection may have been revoked or lacks Workers AI. Connect Cloudflare again on the account page.`
      : `Workers AI ${code ? `${code}: ` : ""}${message || "the call failed"} (HTTP ${status})`;
  const e = new Error(text) as RestModelError;
  e.statusCode = status;
  const h: Record<string, string> = {};
  for (const name of ["retry-after", "retry-after-ms"]) {
    const v = headers.get(name);
    if (v !== null) h[name] = v;
  }
  e.responseHeaders = h;
  return e;
}

/**
 * Workers AI over the REST API with the grant `grant()` hands out on each call (so a renewed token is used once the
 * grant object renews it). The answer is the API's `result` (the binding's answer); a body without the envelope is
 * handed back as it is, and one that is not JSON as its bytes. A failure throws with the HTTP status, Cloudflare's
 * error code and message (3040, 3036, ...) and its Retry-After, so throttling reads as it does from the binding.
 */
export function restModelRunner(grant: () => Promise<CloudflareGrant | null>, fetchFn: HttpFetch = (i, init) => fetch(i, init)): ModelRunner {
  return {
    async run(model, input, options) {
      if (!restModelName(model)) throw new Error(`model ${JSON.stringify(model.slice(0, 80))} is not a Workers AI model name`);
      const g = await grant();
      if (!g) throw new ModelsOff("not_connected");
      if (!hasWorkersAi(g.scopes)) throw new ModelsOff("no_workers_ai");
      if (!ACCOUNT_ID.test(g.accountId)) throw new ModelsOff("not_connected");
      const signal = options?.signal instanceof AbortSignal ? options.signal : undefined;
      const res = await fetchFn(`${CF_API}/accounts/${g.accountId}/ai/run/${model}`, {
        method: "POST",
        headers: { authorization: `Bearer ${g.accessToken}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(input),
        ...(signal ? { signal } : {}),
      });
      const isJson = /\bjson\b/i.test(res.headers.get("content-type") ?? "");
      if (!isJson) {
        if (!res.ok) throw restError(res.status, null, res.headers);
        return new Uint8Array(await res.arrayBuffer());
      }
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw restError(res.status, null, res.headers);
      }
      const envelope = body && typeof body === "object" && "success" in (body as object) ? (body as { success?: unknown; result?: unknown }) : null;
      if (!res.ok || (envelope && envelope.success !== true)) throw restError(res.status, body, res.headers);
      return envelope ? envelope.result : body;
    },
  };
}

/** What model routing reads: the Workers AI binding beside the connect settings. */
export type ModelEnv = ConnectEnv & { AI?: unknown };

/** Injected for tests and for the orchestrator's wiring: the grant lookup and fetch. */
export interface ModelDeps {
  grantFor?: (account: AccountId) => Promise<CloudflareGrant | null>;
  fetch?: HttpFetch;
}

/**
 * The model runner of one colony. `owner === null` (an operator colony): `env.AI`, the binding itself, unchanged. An
 * owned colony whose owner's grant has Workers AI (ai.read or ai.write): the REST runner on the owner's account. An
 * owned colony without it: throws ModelsOff, whose message is the sentence to show ("no_workers_ai", or "not_connected"
 * when the owner has no working connection).
 */
export async function modelRunnerFor(env: ModelEnv, colonyId: string, owner: AccountId | null, deps: ModelDeps = {}): Promise<ModelRunner> {
  if (owner === null) return env.AI as ModelRunner;
  const grantFor = deps.grantFor ?? ((account: AccountId) => cloudflareGrantFor(env, account));
  const g = await grantFor(owner);
  if (!g) throw new ModelsOff("not_connected");
  if (!hasWorkersAi(g.scopes)) throw new ModelsOff("no_workers_ai");
  return restModelRunner(() => grantFor(owner), deps.fetch);
}

/** One colony's models, as call sites take them (see colonyModels). */
export interface ColonyModels<E> {
  /** The env to hand to the colony's model call sites in place of the Worker's env. */
  env: E;
  /** The runner (env.AI of that env), or null when model calls are off. */
  runner: ModelRunner | null;
  /** Null, or the sentence that says why in-platform agents and model review are off. */
  off: string | null;
}

/**
 * The one hook model call sites use: the env their model calls read, for one colony. Operator colony: `env` itself (the
 * same object: nothing changes). Owned colony with Workers AI: a copy of `env` whose AI is the owner's REST runner.
 * Owned colony without it: a copy whose AI is absent, which every call site already reads as "no Workers AI" (the decide
 * pipeline's review off, no contest judge, no resolver), with `off` saying why. For every owned colony the copy also
 * drops ANTHROPIC_API_KEY, so no call of an owned colony is billed to the deployment's model key.
 */
export async function colonyModels<E extends ModelEnv>(env: E, colonyId: string, owner: AccountId | null, deps: ModelDeps = {}): Promise<ColonyModels<E>> {
  if (owner === null) return { env, runner: (env.AI as ModelRunner | undefined) ?? null, off: null };
  try {
    const runner = await modelRunnerFor(env, colonyId, owner, deps);
    return { env: { ...env, AI: runner, ANTHROPIC_API_KEY: undefined }, runner, off: null };
  } catch (e) {
    if (!(e instanceof ModelsOff)) throw e;
    return { env: { ...env, AI: undefined, ANTHROPIC_API_KEY: undefined }, runner: null, off: e.message };
  }
}
