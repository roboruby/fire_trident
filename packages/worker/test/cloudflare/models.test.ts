import { describe, expect, it } from "vitest";
import { modelClient } from "../../src/agents/llm.ts";
import { extractUsage } from "../../src/agents/prompt.ts";
import { isProviderThrottle, providerRetryAfterMs, throttleError } from "../../src/agents/throttle.ts";
import { colonyModels, isModelsOff, MODELS_OFF, ModelsOff, modelRunnerFor, restModelName, restModelRunner, type ModelRunner } from "../../src/cloudflare/models.ts";
import { isThrottled, modelText } from "../../src/decide/reflex.ts";
import type { CloudflareGrant } from "../../src/cloudflare/types.ts";
import { ACCOUNT_A, FakeCloudflare } from "./fake.ts";

/**
 * Model routing: an operator colony gets the Workers AI binding itself; an owned colony with Workers AI gets the REST
 * runner on its owner's account, whose answers read exactly as the binding's do; one without gets the refusal.
 */

const MODEL = "@cf/vendor/model-1.5-instruct";
const RESULT = { response: "hello", usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } };

function setup(scopes = ["artifacts.read", "artifacts.write", "ai.read", "ai.write"]) {
  const clock = { now: Date.parse("2026-10-19T10:00:00Z") };
  const fake = new FakeCloudflare(clock);
  // A live access token the fake knows.
  const token = "access-test-1";
  fake.tokens.set(token, { kind: "access", scopes, expiresAt: clock.now + 3600_000, revoked: false });
  let asked = 0;
  const grantFor = async (account: string): Promise<CloudflareGrant | null> => {
    asked++;
    return account === "acc_owner" ? { accountId: ACCOUNT_A.id, accessToken: token, scopes } : null;
  };
  const binding: ModelRunner & { seen: unknown[] } = {
    seen: [],
    async run(model, input, options) {
      this.seen.push([model, input, options]);
      return structuredClone(RESULT);
    },
  };
  const env = { FT_ACCOUNTS: "on", FT_PUBLIC_URL: "https://ft.example", AI: binding, ANTHROPIC_API_KEY: "operator-key", FT_DEFAULT_MODEL: MODEL };
  return { fake, token, grantFor, binding, env, asked: () => asked };
}

describe("modelRunnerFor", () => {
  it("hands an operator colony the binding itself, unchanged", async () => {
    const t = setup();
    expect(await modelRunnerFor(t.env, "hono", null, { grantFor: t.grantFor, fetch: t.fake.fetch })).toBe(t.binding);
    expect(t.asked()).toBe(0);
    expect(t.fake.calls).toHaveLength(0);
  });

  it("runs an owned colony's models on its owner's Workers AI over REST, answering as the binding does", async () => {
    const t = setup();
    const runner = await modelRunnerFor(t.env, "mine", "acc_owner", { grantFor: t.grantFor, fetch: t.fake.fetch });
    expect(runner).not.toBe(t.binding);
    const input = { messages: [{ role: "user", content: "hi" }], max_tokens: 50 };
    const viaRest = await runner.run(MODEL, input);
    const viaBinding = await t.binding.run(MODEL, input);
    expect(viaRest).toEqual(viaBinding);
    expect(modelText(viaRest)).toBe(modelText(viaBinding));
    expect(extractUsage(viaRest)).toEqual(extractUsage(viaBinding));
    const call = t.fake.calls.at(-1);
    expect(call?.method).toBe("POST");
    expect(call?.url).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_A.id}/ai/run/${MODEL}`);
    expect(call?.headers.authorization).toBe(`Bearer ${t.token}`);
    expect(JSON.parse(call?.body ?? "{}")).toEqual(input);
  });

  it("gives the agents' model client the same reply through either runner", async () => {
    const t = setup();
    const runner = await modelRunnerFor(t.env, "mine", "acc_owner", { grantFor: t.grantFor, fetch: t.fake.fetch });
    const req = { model: "default", messages: [{ role: "user" as const, content: "hi" }], maxTokens: 50 };
    const a = await modelClient({ AI: t.binding as unknown as Ai, FT_DEFAULT_MODEL: MODEL }).complete(req);
    const b = await modelClient({ AI: runner as unknown as Ai, FT_DEFAULT_MODEL: MODEL }).complete(req);
    const { ms: _a, ...ra } = a;
    const { ms: _b, ...rb } = b;
    expect(rb).toEqual(ra);
    expect(rb).toMatchObject({ text: "hello", model: MODEL, usage: { input: 7, output: 3 } });
  });

  it("asks for the grant on every call, so a renewed token is used", async () => {
    const t = setup();
    const runner = await modelRunnerFor(t.env, "mine", "acc_owner", { grantFor: t.grantFor, fetch: t.fake.fetch });
    const before = t.asked();
    await runner.run(MODEL, {});
    await runner.run(MODEL, {});
    expect(t.asked()).toBe(before + 2);
  });

  it("refuses an owned colony without Workers AI, or whose owner has no working connection, with the sentence", async () => {
    const t = setup(["artifacts.read", "artifacts.write"]);
    const off = modelRunnerFor(t.env, "mine", "acc_owner", { grantFor: t.grantFor, fetch: t.fake.fetch });
    await expect(off).rejects.toBeInstanceOf(ModelsOff);
    await expect(off).rejects.toThrow(
      "In-platform agents and model review are off: this colony's Cloudflare connection has no Workers AI access. Connect again and allow Workers AI, or bring your own agents over MCP.",
    );
    await expect(modelRunnerFor(t.env, "mine", "acc_nobody", { grantFor: t.grantFor })).rejects.toThrow(MODELS_OFF.not_connected);
    expect(isModelsOff(new Error(`rpc: ${MODELS_OFF.no_workers_ai}`))).toBe(true);
    expect(isModelsOff(new Error("something else"))).toBe(false);
    expect(t.fake.calls).toHaveLength(0);
  });

  it("accepts either Workers AI scope (the run endpoint takes Read or Write)", async () => {
    for (const scope of ["ai.read", "ai.write"]) {
      const t = setup(["artifacts.read", "artifacts.write", scope]);
      const runner = await modelRunnerFor(t.env, "mine", "acc_owner", { grantFor: t.grantFor, fetch: t.fake.fetch });
      expect(await runner.run(MODEL, {})).toEqual(RESULT);
    }
  });

  it("is off from the next call once the owner disconnects", async () => {
    const t = setup();
    let connected = true;
    const grantFor = async (a: string) => (connected ? t.grantFor(a) : null);
    const runner = await modelRunnerFor(t.env, "mine", "acc_owner", { grantFor, fetch: t.fake.fetch });
    connected = false;
    await expect(runner.run(MODEL, {})).rejects.toThrow(MODELS_OFF.not_connected);
  });
});

describe("the REST runner", () => {
  const grant = async (): Promise<CloudflareGrant> => ({ accountId: ACCOUNT_A.id, accessToken: "access-test-1", scopes: ["ai.read"] });

  it("sends only Workers AI model names: nothing that leaves /ai/run/", async () => {
    for (const ok of [MODEL, "@cf/moonshotai/kimi-k2.7-code", "@cf/google/gemma-4-26b-a4b-it", "@hf/thebloke/model-awq"]) expect(restModelName(ok), ok).toBe(true);
    for (const bad of ["@cf/../../accounts/x", "@cf/a/..", "@cf/a/b?x=1", "@cf/a/b#x", "https://evil.example/x", "claude-sonnet", "@cf/a/b/../../c", "@cf", "@cf/", "@cf/a/.hidden"]) {
      expect(restModelName(bad), bad).toBe(false);
    }
    const seen: string[] = [];
    const runner = restModelRunner(grant, async (url) => (seen.push(url), new Response("{}")));
    await expect(runner.run("@cf/../../accounts/x", {})).rejects.toThrow(/not a Workers AI model name/);
    expect(seen).toHaveLength(0);
  });

  it("reads a throttled call as the binding's: Cloudflare's code, the status and its Retry-After", async () => {
    const clock = { now: 0 };
    const fake = new FakeCloudflare(clock);
    fake.tokens.set("access-test-1", { kind: "access", scopes: ["ai.read"], expiresAt: 3600_000, revoked: false });
    fake.aiAnswer = { status: 429, body: { success: false, errors: [{ code: 3040, message: "Capacity temporarily exceeded, please try again." }], result: null }, headers: { "retry-after": "7" } };
    const runner = restModelRunner(grant, fake.fetch);
    const err = await runner.run(MODEL, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("Workers AI 3040: Capacity temporarily exceeded, please try again. (HTTP 429)");
    expect(isThrottled(err)).toBe(true);
    expect(isProviderThrottle(err)).toBe(true);
    expect(providerRetryAfterMs(err, 0)).toBe(7000);
    expect(throttleError(err, MODEL, 0).message).toMatch(/^\[ft:429\]/);
  });

  it("says plainly when Cloudflare refuses the owner's token, and passes an abort signal on", async () => {
    const runner = restModelRunner(grant, async () => new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }), { status: 401, headers: { "content-type": "application/json" } }));
    await expect(runner.run(MODEL, {})).rejects.toThrow(/Cloudflare refused the owner's Workers AI call \(HTTP 401, 10000\).*Connect Cloudflare again/);
    let signal: AbortSignal | null | undefined;
    const ctl = new AbortController();
    const seeing = restModelRunner(grant, async (_u, init) => ((signal = init?.signal), new Response(JSON.stringify({ success: true, result: RESULT }), { headers: { "content-type": "application/json" } })));
    expect(await seeing.run(MODEL, {}, { signal: ctl.signal })).toEqual(RESULT);
    expect(signal).toBe(ctl.signal);
  });
});

describe("colonyModels (the call sites' hook)", () => {
  it("gives an operator colony the same env object", async () => {
    const t = setup();
    const m = await colonyModels(t.env, "hono", null, { grantFor: t.grantFor });
    expect(m.env).toBe(t.env);
    expect(m.runner).toBe(t.binding);
    expect(m.off).toBeNull();
  });

  it("gives an owned colony with Workers AI an env whose AI is the owner's runner and which has no deployment model key", async () => {
    const t = setup();
    const m = await colonyModels(t.env, "mine", "acc_owner", { grantFor: t.grantFor, fetch: t.fake.fetch });
    expect(m.env).not.toBe(t.env);
    expect(m.env.AI).toBe(m.runner);
    expect(m.env.AI).not.toBe(t.binding);
    expect(m.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(m.env.FT_DEFAULT_MODEL).toBe(MODEL);
    expect(t.env.AI).toBe(t.binding);
    expect(t.env.ANTHROPIC_API_KEY).toBe("operator-key");
    // A claude-* model would have gone to the deployment's key: for an owned colony it is refused.
    await expect(modelClient(m.env as never).complete({ model: "claude-x", messages: [], maxTokens: 5 })).rejects.toThrow(/needs ANTHROPIC_API_KEY/);
  });

  it("gives an owned colony without Workers AI an env with no AI (review and in-platform agents off) and the sentence", async () => {
    const t = setup(["artifacts.read", "artifacts.write"]);
    const m = await colonyModels(t.env, "mine", "acc_owner", { grantFor: t.grantFor });
    expect(m.env.AI).toBeUndefined();
    expect(Boolean(m.env.AI)).toBe(false);
    expect(m.runner).toBeNull();
    expect(m.off).toBe(MODELS_OFF.no_workers_ai);
  });
});
