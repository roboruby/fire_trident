import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import type { Env } from "../env.ts";
import { hedged, runAi, type Hedge, type Hedged } from "../colony/hedge.ts";
import type { ModelClient, ModelReply } from "./loop.ts";
import type { ChatMessage } from "./prompt.ts";
import { extractFinishReason, extractModelText, extractUsage } from "./prompt.ts";
import { throttleError } from "./throttle.ts";

export { throttleError } from "./throttle.ts";

/** Wall-clock cap for one model call. */
const CALL_TIMEOUT_MS = 180_000;
/** Output cap for Anthropic models without streaming (keeps requests well inside HTTP timeouts). */
const ANTHROPIC_MAX_OUTPUT = 32_000;

/**
 * Resolve a model name: undefined or "default" -> FT_DEFAULT_MODEL, "bulk" ->
 * FT_BULK_MODEL, anything else as given.
 */
export function resolveModel(env: Pick<Env, "FT_DEFAULT_MODEL" | "FT_BULK_MODEL">, model: string | undefined, fallback: "default" | "bulk" = "default"): string {
  const m = (model ?? "").trim();
  if (m === "" ) return fallback === "bulk" ? env.FT_BULK_MODEL : env.FT_DEFAULT_MODEL;
  if (m === "default") return env.FT_DEFAULT_MODEL;
  if (m === "bulk") return env.FT_BULK_MODEL;
  return m;
}

/** True when the model id should be served by Anthropic (and a key is configured). */
export function usesAnthropic(env: Pick<Env, "ANTHROPIC_API_KEY">, model: string): boolean {
  return model.startsWith("claude-") && typeof env.ANTHROPIC_API_KEY === "string" && env.ANTHROPIC_API_KEY !== "";
}

/**
 * Extra request fields per Workers AI model family. Reasoning models default to their
 * highest effort; agents mostly make small, well-specified edits, where low effort (or
 * no thinking, where a model allows it) is as accurate and several times faster.
 */
const MODEL_OPTIONS: Array<{ match: RegExp; options: Record<string, unknown> }> = [
  { match: /\/glm-5/, options: { reasoning_effort: "low" } },
  { match: /\/qwen3\.8/, options: { reasoning_effort: "low" } },
  { match: /\/(?:glm-4\.7-flash|gemma-4)/, options: { chat_template_kwargs: { enable_thinking: false } } },
];

/** Request fields specific to one Workers AI model (empty for most). */
export function modelOptions(model: string): Record<string, unknown> {
  return Object.assign({}, ...MODEL_OPTIONS.filter((m) => m.match.test(model)).map((m) => m.options));
}

interface AiRunner {
  run(model: string, input: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
}

/**
 * The model client agents use. Workers AI models run through the AI binding with
 * chat messages and `max_tokens`; `claude-*` models run through the AI SDK's
 * Anthropic provider when ANTHROPIC_API_KEY is set. No sampling parameters are
 * sent (current Anthropic models reject them) and no assistant prefill is used.
 * With `hedge` (FT_HEDGE, colony/hedge.ts), a call with no answer after the hedge's
 * wait goes out once more, and the reply says which copy answered; a request's `valid`
 * makes a reply whose text it refuses count as a failed attempt there.
 */
export function modelClient(env: Pick<Env, "AI" | "ANTHROPIC_API_KEY"> & Partial<Pick<Env, "FT_DEFAULT_MODEL" | "FT_BULK_MODEL">>, hedge?: Hedge | null): ModelClient {
  return {
    async complete(req: { model: string; messages: ChatMessage[]; maxTokens: number; valid?: (text: string | null) => boolean }): Promise<ModelReply> {
      // "default" and "bulk" name the server's models (a spec intent may ask for one by class).
      const alias = req.model === "default" ? env.FT_DEFAULT_MODEL : req.model === "bulk" ? env.FT_BULK_MODEL : undefined;
      const { valid, ...rest } = req;
      const p = alias ? { ...rest, model: alias } : rest;
      if (usesAnthropic(env, p.model)) {
        // Anthropic's 429 and 529, with its Retry-After, take the throttle path Workers AI errors take (agents/throttle.ts).
        // Each copy's error is tagged where it fails, so a hedge sends no copy to a model that just refused (colony/hedge.ts).
        const call = (m: string, signal?: AbortSignal): Promise<ModelReply> =>
          anthropicComplete(env.ANTHROPIC_API_KEY as string, { ...p, model: m }, signal).catch((e: unknown) => {
            throw throttleError(e, m);
          });
        let r: Hedged<ModelReply>;
        try {
          r = await hedged(call, p.model, hedge, Date.now, valid ? (v) => valid(v.text) : undefined);
        } catch (e) {
          throw throttleError(e, p.model);
        }
        return withHedge({ ...r.value, model: r.model }, r, (v) => v.usage ?? null);
      }
      if (p.model.startsWith("claude-")) throw new Error(`model ${p.model} needs ANTHROPIC_API_KEY, which is not set`);
      const ai = env.AI as unknown as AiRunner;
      const t0 = Date.now();
      let result: Hedged<unknown>;
      try {
        result = await withTimeout(
          hedged((m, signal) => runAi(ai, m, { messages: p.messages, max_tokens: p.maxTokens, ...modelOptions(m) }, signal), p.model, hedge, Date.now, valid ? (v) => valid(extractModelText(v)) : undefined),
          CALL_TIMEOUT_MS,
          `model ${p.model}`,
        );
      } catch (e) {
        throw throttleError(e, p.model);
      }
      const reply: ModelReply = { text: extractModelText(result.value), ms: Date.now() - t0, model: result.model };
      const finish = extractFinishReason(result.value);
      if (finish) reply.finishReason = finish;
      const usage = extractUsage(result.value);
      if (usage) reply.usage = usage;
      return withHedge(reply, result, extractUsage);
    },
  };
}

/** A reply with its hedge (FT_HEDGE): which copy answered, and the losing copy's tokens once it settles. Unhedged replies pass as they are. */
function withHedge<T>(reply: ModelReply, r: Hedged<T>, usageOf: (value: T) => ModelReply["usage"] | null): ModelReply {
  if (!r.hedged) return reply;
  reply.hedged = r.hedged;
  if (r.late) reply.late = r.late.then((l) => (l ? { model: l.model, usage: usageOf(l.value) ?? null } : null));
  return reply;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not answer within ${Math.round(ms / 1000)} s`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}

async function anthropicComplete(apiKey: string, p: { model: string; messages: ChatMessage[]; maxTokens: number }, signal?: AbortSignal): Promise<ModelReply> {
  const anthropic = createAnthropic({ apiKey });
  const system = p.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const turns = p.messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
  const r = await generateText({
    model: anthropic(p.model),
    ...(system ? { system } : {}),
    messages: turns,
    maxOutputTokens: Math.min(ANTHROPIC_MAX_OUTPUT, Math.max(16_000, p.maxTokens)),
    maxRetries: 2,
    // A hedge copy's signal (FT_HEDGE) aborts it beside the time-out.
    abortSignal: signal ? AbortSignal.any([AbortSignal.timeout(CALL_TIMEOUT_MS), signal]) : AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  const reply: ModelReply = { text: r.text, finishReason: r.finishReason };
  const u = r.usage as { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number } | undefined;
  if (u) reply.usage = { input: u.inputTokens ?? 0, output: u.outputTokens ?? 0, cached: u.cachedInputTokens ?? 0, neurons: 0 };
  return reply;
}
