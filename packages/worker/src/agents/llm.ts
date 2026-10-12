import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import type { Env } from "../env.ts";
import type { ModelClient, ModelReply } from "./loop.ts";
import type { ChatMessage } from "./prompt.ts";
import { extractFinishReason, extractModelText, extractUsage } from "./prompt.ts";

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
 */
export function modelClient(env: Pick<Env, "AI" | "ANTHROPIC_API_KEY">): ModelClient {
  return {
    async complete(p: { model: string; messages: ChatMessage[]; maxTokens: number }): Promise<ModelReply> {
      if (usesAnthropic(env, p.model)) return anthropicComplete(env.ANTHROPIC_API_KEY as string, p);
      if (p.model.startsWith("claude-")) throw new Error(`model ${p.model} needs ANTHROPIC_API_KEY, which is not set`);
      const ai = env.AI as unknown as AiRunner;
      const t0 = Date.now();
      let result: unknown;
      try {
        result = await withTimeout(ai.run(p.model, { messages: p.messages, max_tokens: p.maxTokens, ...modelOptions(p.model) }), CALL_TIMEOUT_MS, `model ${p.model}`);
      } catch (e) {
        throw throttleError(e, p.model);
      }
      const reply: ModelReply = { text: extractModelText(result), ms: Date.now() - t0 };
      const finish = extractFinishReason(result);
      if (finish) reply.finishReason = finish;
      const usage = extractUsage(result);
      if (usage) reply.usage = usage;
      return reply;
    },
  };
}

/**
 * Workers AI refuses work it is not allowed to take right now: the per-account, per-model
 * request rate (3021; models that need Workers Paid get 20 requests a minute) or a lack
 * of capacity (3040). Tag those `[ft:429]` so the loop waits instead of counting a failure.
 */
const THROTTLED = /rate limit|\b3021\b|\b3040\b|out of capacity|too many requests|\b429\b/i;

/** The error to throw for a failed model call: tagged `[ft:429]` when the provider throttled it. */
export function throttleError(e: unknown, model: string): Error {
  const msg = e instanceof Error ? e.message : String(e);
  if (THROTTLED.test(msg) && !/^\[ft:\d{3}\]/.test(msg)) return new Error(`[ft:429] model ${model} is throttled: ${msg.slice(0, 200)}`);
  return e instanceof Error ? e : new Error(msg);
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

async function anthropicComplete(apiKey: string, p: { model: string; messages: ChatMessage[]; maxTokens: number }): Promise<ModelReply> {
  const anthropic = createAnthropic({ apiKey });
  const system = p.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const turns = p.messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
  const r = await generateText({
    model: anthropic(p.model),
    ...(system ? { system } : {}),
    messages: turns,
    maxOutputTokens: Math.min(ANTHROPIC_MAX_OUTPUT, Math.max(16_000, p.maxTokens)),
    maxRetries: 2,
    abortSignal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  const reply: ModelReply = { text: r.text, finishReason: r.finishReason };
  const u = r.usage as { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number } | undefined;
  if (u) reply.usage = { input: u.inputTokens ?? 0, output: u.outputTokens ?? 0, cached: u.cachedInputTokens ?? 0, neurons: 0 };
  return reply;
}
